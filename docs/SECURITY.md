# Security

BIS-Saathi holds something more sensitive than its answer quality implies: a query history
that reveals what a manufacturer is about to bring to market, an account that can bind to a
factory, and an ingestion pipeline whose output is quoted as authority. This file records the
controls that exist, which of them are tested, and — explicitly — which are not yet.

Rules referenced as **R#** are the invariants in `CLAUDE.md` §2.

---

## 1. Identity: tokens, cookies, and their lifetimes

| Credential | Where it lives | Lifetime | Transport | Rotation |
|---|---|---|---|---|
| Access token | JS memory only | **15 min** | `Authorization: Bearer` header | re-issued by refresh |
| Refresh token | `HttpOnly` cookie | 30 days | cookie, `Path=/api/v1/auth` | **every use** |
| CSRF token | readable cookie | session | `X-XSRF-TOKEN` header | per auth-state change |
| Reset token | never stored client-side | 30 min | one request | single use |

**Access token: JWT, HS256**, `iss`/`aud` pinned to `bis-saathi`/`bis-saathi-web`, `exp` at
15 minutes, plus a `jti`. Held in module memory, never `localStorage` and never a
JS-readable cookie: an XSS on this page should not obtain a durable bearer token. It carries a
`roles` claim, but that claim is **advisory only** (§1.4).

**Refresh token: opaque, not a JWT.** 48 random bytes, base64url. A JWT refresh token would
need either a signature the client can't verify (pointless) or a readable payload (a leak).
Nothing about it needs to be self-describing, so it is a random string and the server keeps the
only meaningful state.

Only the **SHA-256 digest** is stored (`refresh_tokens.token_hash`). A database read — a backup,
a read replica, a SQL injection — yields digests, not credentials.

### 1.1 Rotation and reuse detection

A family id groups one login's rotation chain:

```
login      → A (family F)
refresh A  → B (family F), A.used_at = now, A.replaced_by = B
refresh B  → C ...
refresh A  → 401 REFRESH_REUSED, every token in family F revoked
```

Presenting an already-used token means the cookie was copied or a response was replayed. The
response is to revoke the **whole family**, not just the presented token: an attacker holding a
stolen cookie cannot keep rotating ahead of the legitimate user, because the moment either
party replays, both die and the user re-authenticates. This is the property that makes theft
detectable rather than merely possible.

Covered by `mock-api/tests/auth.test.ts` (rotate, replay, family revoked, `tokensRevoked`) and
`backend/src/test/.../AuthFlowIntegrationTest.fullAuthFlow`.

### 1.2 Why the cookie is path-scoped

`Path=/api/v1/auth`, so it is not attached to any other route this origin serves. It limits
what a misconfigured reverse proxy, an SSRF against another internal path, or a new endpoint
added without review can carry. It is not CSRF defence — that's §1.3.

### 1.3 CSRF, and why only some routes have it

Bearer-header requests need no CSRF token: a browser does not attach an `Authorization` header
cross-site, so there is no ambient credential to ride. The refresh cookie is different — the
browser *will* attach it to a cross-site `POST`. So double-submit protection applies to the
cookie-borne routes (`/auth/refresh`, `/auth/logout`) and, cheaply, to `login`/`register`/reset
so a cross-site form cannot sign a victim into an attacker-chosen account.

The CSRF cookie is deliberately script-readable; that is what double-submit means. Reading it
grants nothing without the `HttpOnly` cookie beside it. Comparison is constant-time
(`MessageDigest.isEqual`).

### 1.4 Authorisation is read per request, not from the token

Every request re-loads the user and takes roles from the database. A `roles` claim is a
15-minute-old opinion; the row is the fact. A revoked role therefore takes effect on the next
request, not at token expiry — asserted by
`AuthFlowIntegrationTest.revocationIsImmediate`, which drops the ADMIN row while the access
token stays cryptographically valid.

## 2. Passwords

- **Argon2id** by default, `m = 19456 KiB, t = 2, p = 1` (OWASP-aligned). **BCrypt cost 12** as
  the documented fallback; the scheme is stored per hash (`users.password_scheme`), so changing
  the configuration neither invalidates accounts nor silently weakens comparison.
- **Policy:** ≥10 characters, ≤200, at least one `\p{L}` and one `\p{N}`. Deliberately
  **Unicode**, in all three implementations: an ASCII-only class tells a Hindi user their
  correct password is too weak, and that bug is invisible to a monolingual test suite. The
  frontend's minimum is read from `/meta/bootstrap`, so a server policy change moves the client
  rule rather than drifting from it.
- No forced composition beyond that, no expiry, no hint. Maximum length exists to bound work,
  not to limit strength.
- **Transparent upgrade on login:** if a stored hash used a weaker scheme or older parameters,
  it is re-hashed at the one moment the plaintext is legitimately in hand. There is no
  background re-hash job, because there is no way to do one without storing plaintext.
- **Verification always runs**, even for an unknown email — against a dummy hash — so response
  time does not answer "does this account exist?".
- Never logged, never returned, never emailed.

## 3. Lockout and rate limiting

| Control | Scope | Rule | Purpose |
|---|---|---|---|
| Account lockout | per account, **in the database** | 5 failures → 15 min, HTTP **423** + `Retry-After` | the security control |
| Auth rate limit | per IP, Redis | 10 / 60 s on login, register, reset | the abuse control |
| Chat rate limit | per user, Redis | 120 / 60 s | cost and load |

Lockout is in Postgres, not memory, so it survives a restart and applies across instances.
When Redis is unreachable the **rate limiter fails open** and logs at WARN; the **lockout still
applies**. That asymmetry is deliberate: disabling lockout because a cache is down is a security
regression, while refusing every login because a cache is down is only an availability incident —
and availability incidents are recoverable, a bypassed lockout is not.

## 4. Object-level authorisation (IDOR) and R9

Every query for user data carries `user_id` in its WHERE clause, and it is the **repository
signature** that requires it (`ConversationRepository.findByIdAndUserId`), not a filter a
caller can forget. There is no `findById(id)` used for user data anywhere in `chat` or `user`.

**"Not yours" answers `404`, not `403`.** A 403 confirms the id exists and belongs to somebody
else — an existence oracle for enumerating conversation ids. Same answer for "doesn't exist" and
"exists but isn't yours" makes the two indistinguishable.

There is also no `/users/{id}` at all: an account is addressable only as `/users/me`, resolved
from the token. A route shape with no id parameter has no id parameter to substitute, which is
stronger than any check on it.

Enforced on **every** endpoint server-side. Frontend guards (`RequireAuth`, `RequireRole`) exist
to avoid rendering a page the user cannot use; they are cosmetic and are documented as such in
their own file. `AuthFlowIntegrationTest.conversationIdor` covers GET/PATCH/DELETE on another
user's conversation plus the message list, and asserts the row is *unchanged* afterwards, so a
write cannot half-succeed before the check.

## 5. Roles

`USER` ⊂ `CONTENT_MANAGER` ⊂ `ADMIN` (hierarchy in `Role.common`, unit-tested so it is checked
even with no database available).

- Registration assigns `USER`. The register DTO has **no roles field**, and
  `fail-on-unknown-properties` makes `{"roles":["ADMIN"]}` a 400 rather than an ignored key — an
  ignored field is a field someone will eventually trust.
- `PATCH /users/me` accepts `fullName`, `persona`, `language`. Nothing else; roles, email and
  `emailVerified` are not in the DTO.
- No HTTP endpoint assigns roles at all (P5 adds an admin-facing one, which must come with its
  own authorisation tests).
- `/admin/audit-logs` is ADMIN-only; `/admin/knowledge/*` and `/admin/ingestion/*` are
  CONTENT_MANAGER-and-above. A content role reading failed-login IPs is not information it needs.
- Denials are audited at the point of denial (`AuthorizationManager.require`), because that is
  where the evidence is.

## 6. Data boundaries

- **Personal data is redacted before the turn is stored**, not merely at the provider boundary
  (`rag/PiiGuard`, mirroring `mock-api/src/rag/guard.ts`). The tempting alternative — keep the
  raw text so a user can read their own history back — turns the database into the most complete
  copy of everyone's Aadhaar numbers in the system, reachable by every future bug and every
  backup, for no security benefit.
- The redaction keeps a **residual tail** (last 4 digits of an Aadhaar, last 3 of a phone) so a
  user report can be correlated with a row without the row being usable. Over-masking to
  `[REDACTED]` costs the only legitimate debugging capability the field had.
- The `meta` frame carries **`piiDetected`**, so the UI states plainly that something was
  withheld. Redaction that the user cannot see is indistinguishable from the answer quietly
  ignoring part of their question.
- Shaping is deliberately narrow — the common Indian identifier forms plus a pasted JWT — and a
  12-digit run is only masked when all twelve digits are present, so a standard number inside a
  sentence is not corrupted. It is a guard rail, **not a DLP**: anything else typed into a
  question is stored as written, and users are told that in the product copy.
- **Logs carry no credentials, no passwords, and no emails** in clear. Emails are masked in
  log lines (`de*******@…`). Audit rows identify actors by opaque id, which an ADMIN can join
  when they legitimately need to.
- **No answer is retained without its evidence.** `messages.sources_json` is the *validated* set,
  frozen at answer time; the UI's citations are rendered from that column, so a later re-ingest
  cannot rewrite what a user was told (R2).
- **Restricted standards stay metadata-only** (R11): `V1__init.sql` has
  `CHECK (verification_status <> 'RESTRICTED')` on `knowledge_chunks`, so storing the text of a
  restricted document is refused by the schema rather than by a code review.

## 7. Transport and platform

- Cookies: `HttpOnly` + `Secure` + `SameSite=Lax`. `SameSite=None` is **refused at boot** — the
  app will not start in a configuration that exposes the refresh token cross-site
  (`CookiePropertiesValidator`).
- HSTS with `includeSubDomains`, max-age 1 year; `X-Frame-Options: DENY`;
  `Referrer-Policy: no-referrer`; `X-Content-Type-Options: nosniff`; CSP on both the document
  (nginx) and the API (helmet in the mock, `server.headers` in Boot).
- CORS is an explicit allowlist; `*` is **refused at boot**, because every authenticated request
  is credentialed.
- Boot refuses to start in a production profile with a placeholder secret, a >30-minute access
  token, an insecure refresh cookie, or demo seeding enabled. Failing to start is the correct
  behaviour: a misconfigured deployment that boots and then leaks tokens is worse than one that
  never comes up.
- Error responses carry `code`, `message`, `details[]`, `traceRef` — never a stack trace, a
  class name, or a database message. `server.error.include-message: never` and
  `include-stacktrace: never` are set so the framework cannot do it by default; the trace ref is
  random (not sequential) so it cannot be used to estimate traffic.
- `client_max_body_size 25m` at the edge, so an oversized upload is refused before it reaches a
  parser.
- The backend container runs as a non-root user on a JRE base with no compiler and no Maven, and
  the only writable path is `/tmp`.

## 8. Test map

| Control | Test | Executed here? |
|---|---|---|
| register→login→refresh→logout | `mock-api/tests/auth.test.ts`, `AuthFlowIntegrationTest.fullAuthFlow` | mock ✅ / backend ⚠ |
| Rotation + reuse revokes family | `auth.test.ts`, `fullAuthFlow` | mock ✅ / backend ⚠ |
| Lockout 423 + `Retry-After` | `security.test.ts`, `AuthSecurityTest.lockoutThreshold` | ✅ (unit) |
| Rate limit 429 + window | `security.test.ts` | mock ✅ |
| CSRF required on cookie routes | `security.test.ts`, `csrfCoversOnlyCookieRoutes` | mock ✅ / backend ⚠ |
| IDOR 404 on all verbs | `authz-idor.test.ts`, `conversationIdor` | mock ✅ / backend ⚠ |
| Role matrix + hierarchy | `authz-idor.test.ts`, `RoleHierarchyTest`, `roleMatrix` | ✅ (unit) / backend ⚠ |
| No privilege escalation via `PATCH /users/me` | `authz-idor.test.ts`, `noPrivilegeEscalationThroughProfile` | mock ✅ / backend ⚠ |
| Immediate role revocation | `revocationIsImmediate` | ⚠ |
| Unicode password policy | `form-validation.test.tsx`, `AuthSecurityTest.passwordPolicy` | ✅ (client) / ⚠ (server) |
| PII redaction before persistence | `PiiGuardTest` (backend, ⚠) | ⚠ |
| Citation validation (R3) | `rag.test.ts`, `CitationValidatorTest` | ✅ both, as unit tests |
| Empty KB → exact R4 sentence (R4) | `rag.test.ts`, `AnswerServiceTest.emptyRetrievalIsR4` | ✅ both |
| Provider failure surfaces (R8) | `rag.test.ts`, `AnswerServiceTest.mockProviderFailsLoudly` | ✅ both |
| Frontend guards + axe WCAG 2.2 AA | `protected-route.test.tsx`, `a11y.test.tsx` | ✅ |
| Contrast ratios | `npm run contrast` (29 checks) | ✅ |
| SSRF: literal IPs, redirects, ports, IPv6 forms | `ssrf.test.ts` (64) | ✅ (unit) |
| `safeFetch` against a live server: size cap mid-stream, timeout, content type, non-2xx | `ssrf.test.ts` (12 of them) | ✅ |
| Injection-like text flagged, not published; `overrideInjectionFlags` admits it to review only | `ingestion.test.ts` | ✅ |
| Extract → clean → chunk → embed → PENDING_REVIEW per stage, backoff on failure | `ingestion-pipeline.test.ts` (15) | ✅ |
| Nothing searchable without a human; reject also invalidates the cache | `knowledge-admin.test.ts`, `ingestion-pipeline.test.ts` | ✅ |
| Restricted standard is metadata-only and never fetched (R11) | `ingestion-pipeline.test.ts`, `knowledge-admin.test.ts` | ✅ |
| Vectors and raw content are not serialised by the list endpoints | `knowledge-admin.test.ts` | ✅ |
| Manifest: refused / queued / deferred rows reported separately | `ingestion.test.ts`, `knowledge-admin.test.ts` | ✅ |
| Freshness sweep flags CHANGED / LINK_ROT and never auto-re-ingests | `ingestion-pipeline.test.ts`, `knowledge-admin.test.ts` | ✅ |
| Ingest submission throttle answers 429 + `Retry-After`, audited with the actor | `knowledge-admin.test.ts` | ✅ |
| Answer cache: key carries kbVersion/language/intent; tier `NONE` never stored | `answer-cache-rewrite.test.ts` (28) | ✅ |
| Rewrite cannot invent text: citations, delimiter escape, over-length, PII ⇒ refused | `answer-cache-rewrite.test.ts` | ✅ |
| Provider: 429/5xx retried, 401/403 and malformed never; truncation reported | `providers.test.ts` (27) | ✅ |
| Cost is `null` unless priced (R10) | `providers.test.ts`, `rag.test.ts` | ✅ |
| Reset mail: transport state is what the API says it is (R8) | `auth.test.ts` | ✅ (mock) |

Every ✅ above is a `mock-api` result. The P2 controls have **no executed backend twin yet**:
the Java side has the same routes authored (uncompiled), and the rows marked ⚠ in the table
above are expectations until `mvn verify` runs with Docker available.

**⚠ = authored but never executed** (no JDK/Docker in the build sandbox). Those rows are
*expectations*, not results, and the backend suite has to go green in an environment with
Docker before any of this is claimed (R8).

## 9. Known gaps and accepted risks

Stated rather than omitted, because a security document that lists only successes is
marketing.

1. **`backend/` has never been compiled or tested.** The Java code, `pom.xml`,
   `V1__init.sql`, both Dockerfiles and `docker-compose.yml` are reviewed source. The
   equivalent *behaviour* is verified against `mock-api/`, which implements the same contract —
   a weaker claim, and the honest one.
2. **HS256 is symmetric.** A service that can verify a token can mint one; a leak of the signing
   key forges any identity. Chosen for simplicity at one-service scale. Move to RS256 + JWKS
   when a second verifier (a worker, a partner API) appears.
3. **No token binding, no DPoP, no device attestation.** A token stolen from memory works until
   it expires. Mitigated by the 15-minute lifetime, not prevented.
4. **Password reset mail is wired in `mock-api`, not in `backend/`.** The Node app sends through
   nodemailer when `MAIL_TRANSPORT=smtp`, prints the message when it is `log`, and states plainly
   that nothing was sent when it is `none`; production refuses to boot on anything but `smtp`, so
   a deployment cannot quietly promise a mail it will not deliver. The Spring side still has the
   `log`-only service. In development the token is also returned in the response so the flow can be
   completed without a mailbox — that is the one place a credential leaves the API over HTTP, and it
   is gated on `NODE_ENV !== 'production'`.
5. **No email verification in the login path** — `emailVerified` is stored and displayed but does
   not gate anything yet. It must not be used for authorisation until delivery exists.
6. **Auth rate limiting is fixed-window**, so a burst at a window boundary can reach 2× the intended
   ceiling. Accepted (the durable control is per-account lockout, and the limiter fails *open* with a
   WARN rather than locking users out when its own store hiccups). The P2 ingestion throttle is a
   token bucket (burst 12, ~0.2 tokens/s refill) precisely because queueing work is a resource
   commitment rather than a page view, and it answers 429 with `Retry-After` instead of 503.
7. **`audit_logs` growth is unbounded**; no retention or purge job yet. Not confidentiality
   sensitive, but it is a disk- exhaustion path.
8. **Self-approval is permitted.** `POST …/approve` records who reviewed a chunk and bumps
   `kbVersion`, but nothing requires that person to be different from whoever queued the document.
   The master spec asks only that "an admin approves" (§5), so a four-eyes rule would be a new
   requirement rather than an implementation detail — it needs a decision, then a test, not a
   policy paragraph. What *is* enforced: no text is retrievable before an approval, and a rejection
   invalidates cached answers exactly like an approval does.
9. **Prompt injection via document content is not fully mitigated.** The retrieved text is
   untrusted input that reaches the model. Defences today are structural: only post-validation
   text is emitted, sources are built from the database row rather than from model prose, and
   the tiers are rule-computed — so an injected instruction can change the *wording* but not
   manufacture a citation. A content-sanitisation pass belongs with the provider work.
10. **`/admin/*` responses expose counts and job errors** to CONTENT_MANAGER. Job `error` strings
    come from the ingestion layer and must be kept free of file paths and credentials as real
    sources are wired up; today they are safe because the mock generates them.

11. **SSRF is mitigated to the extent the network allows, not eliminated.** What is enforced today:
    scheme/credential/port-trailing-dot refusals, an allowlist of ports 80 and 443, every resolved
    address screened at every hop and again after each redirect, the IPv6 forms that hide an IPv4
    address (v4-mapped, 6to4, Teredo, NAT64 well-known prefix) unwrapped and screened, an
    always-blocked set (loopback, unspecified, link-local incl. `169.254/16` and `fe80::/10`,
    multicast, ULA) that stays blocked even with `INGEST_ALLOW_PRIVATE_NETWORKS=true`, the response
    connected to the *pinned* IP with `rejectUnauthorized` still on, and a byte cap applied while
    streaming rather than trusting `Content-Length`. Residual risks: a DNS zone that resolves
    differently per query (the pin covers the connection we make, not one an attacker's TTL trick
    could produce later, since we never re-resolve for the same request), a public host that
    *redirects* to an internal name which then resolves publicly-side (re-screened, so this is
    covered), and any service reachable on 80/443 from the egress path — e.g. a corporate
    admin UI on a public hostname. That last class needs an egress allowlist (proxy or
    `IP_TRANSPARENT` policy), not more parsing, and it is the reason `INGEST_*` refuses to start
    in production with private networks permitted.
12. **Error text from ingestion is deliberately uninformative about addresses.** A blocked URL is
    reported as a policy refusal without the host or port, because the fetcher is a privileged
    network position and an error that echoes "10.0.0.5:8080 refused" is a port scanner's output.

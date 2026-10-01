# API contract v1 — shared by `backend/` (Spring Boot) and `mock-api/` (Node)

Single source of truth for HTTP shape. Both implementations MUST match this document exactly, so the
frontend never needs to know which stack is behind it. Deviation = bug.

Base path: `/api/v1`. JSON bodies. UTF-8. All timestamps ISO-8601 UTC (`2026-10-01T09:41:00Z`).

## Conventions

- **Auth**: 15-minute access token sent as `Authorization: Bearer <jwt>`. The refresh token lives ONLY
  in an HttpOnly cookie (`bs_refresh`) and is used solely by `/auth/refresh` and `/auth/logout`.
- **CSRF**: because a cookie is involved, the server also sets a non-HttpOnly `XSRF-TOKEN` cookie.
  Clients must echo it as `X-XSRF-TOKEN` on `POST /auth/refresh`, `POST /auth/logout` and
  `POST /auth/password/*`. Double-submit pattern.
- **Roles**: `USER`, `CONTENT_MANAGER`, `ADMIN` (`ADMIN` ⊃ `CONTENT_MANAGER`). Enforced server-side;
  frontend guards are cosmetic (master spec §4).
- **Ownership (R9)**: every user-scoped resource is filtered by the authenticated `user_id` in the
  query itself. A resource id belonging to another user MUST return `404`, never `403` — 403 leaks
  existence.
- **Errors**: one shape, never a stack trace, never a provider message (§8 "safe error bodies").

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Human-readable, safe to display.",
    "details": [{ "field": "email", "issue": "invalid_format" }],
    "traceRef": "req_01J8ZK2M9Q"
  }
}
```

| HTTP | `code` | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | body/query fails schema |
| 401 | `UNAUTHENTICATED` | missing/invalid/expired access token |
| 401 | `INVALID_CREDENTIALS` | bad email or password (identical message for both) |
| 401 | `REFRESH_REUSED` | refresh token replay → whole family revoked |
| 403 | `FORBIDDEN` | authenticated but role insufficient |
| 403 | `CSRF_FAILED` | missing/mismatched `X-XSRF-TOKEN` |
| 404 | `NOT_FOUND` | absent **or owned by another user** (R9) |
| 409 | `CONFLICT` | e.g. email already registered |
| 413 | `PAYLOAD_TOO_LARGE` | upload over `UPLOAD_MAX_BYTES` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | upload extension/MIME/magic bytes not allowed |
| 422 | `OUT_OF_SCOPE` | **Reserved for P2 — not returned by any endpoint today.** An out-of-scope question is a *successful* answer about scope: `POST /conversations/{id}/messages` streams 200 with `intent: "out_of_scope"` in the `meta` frame and a refusal sentence in `delta`. A 422 would tell a client to repair its request, and would have to abort an SSE stream that has already sent its status line. |
| 423 | `ACCOUNT_LOCKED` | too many failed logins |
| 429 | `RATE_LIMITED` | includes `Retry-After` header |
| 500 | `INTERNAL_ERROR` | generic; real cause goes to logs only |
| 502 | `PROVIDER_UNAVAILABLE` | LLM/embedding failure — surfaced, never hidden (R8) |
| 503 | `SERVICE_UNAVAILABLE` | dependency down |

Rate-limited and locked responses include `Retry-After: <seconds>`.

## Endpoints implemented in P1

### Public

| Method | Path | Notes |
|---|---|---|
| GET | `/health/live` | process alive; no dependency checks; 200 `{"status":"UP"}` |
| GET | `/health/ready` | checks DB + Redis + provider; 503 with per-component detail when down |
| GET | `/meta/bootstrap` | public app config for the shell (features, providers, KB counters, `mock` flag) |
| POST | `/auth/register` | `{email, password, fullName, persona?, language?}` → 201 `{user, accessToken}` + cookies |
| POST | `/auth/login` | `{email, password}` → 200 `{user, accessToken}` + cookies |
| POST | `/auth/refresh` | cookie in → new rotating cookie + `{accessToken}`; replay ⇒ 401 `REFRESH_REUSED` + family revoked |
| POST | `/auth/logout` | revokes current token family, clears cookies → 204 |
| POST | `/auth/password/reset-request` | `{email}` → **202** `{accepted, message, devToken?}`, identical body whether or not the account exists (no enumeration). `devToken` appears only in development; a production deployment logs the miss instead of returning a credential over HTTP. |
| POST | `/auth/password/change` | `{currentPassword, newPassword}` (auth module, not `/users/me/*`, because it consumes the credential) → 204 + refreshed cookies |
| POST | `/auth/password/reset` | `{token, password}` → 204 |

`/meta/bootstrap` response:

```json
{
  "app": { "name": "BIS-Saathi", "version": "0.1.0", "env": "development", "stack": "mock", "mockProvider": true, "providerName": "mock" },
  "auth": { "accessTokenTtlMinutes": 15, "personas": ["CONSUMER","MSME_MANUFACTURER","JEWELLER_RETAILER","STUDENT_ENGINEER"], "languages": ["en","hi"], "passwordMinLength": 10, "lockoutAfterFailedAttempts": 5, "lockoutMinutes": 15 },
  "knowledge": { "approvedDocuments": 0, "approvedChunks": 0, "pendingChunks": 0, "kbVersion": 0 },
  "providers": {
    "llm": { "name": "mock", "isMock": true, "configured": true, "model": "mock-large" },
    "embeddings": { "name": "mock", "isMock": true, "configured": true, "model": "mock-multilingual-1", "dimensions": 1024 },
    "costAccounting": false
  },
  "ingestion": { "enabled": true, "maxBytes": 25000000, "chunkTokens": { "min": 300, "max": 500 }, "accepts": ["pdf","html","txt","md","csv"], "mailTransport": "log" },
  "security": { "passwordScheme": "argon2id", "csrfEnabled": true },
  "disclaimer": "Informational — verify against current official sources"
}
```

`knowledge.pendingChunks` and `providers` exist so the admin screen and the answer footer can state the
truth without inventing it: `costAccounting: false` means every `costUsd` in this deployment is `null`,
which the UI renders as "no cost data" rather than as free (R10).

`mockProvider: true` MUST be rendered as a visible badge in the UI whenever true (R8/R10 — a mock
answer must never be able to pass for a grounded one).

### Authenticated (`USER`)

| Method | Path | Notes |
|---|---|---|
| GET | `/users/me` | current profile |
| PATCH | `/users/me` | `{fullName?, persona?, language?}` — never accepts `role` or `emailVerified` |
| GET | `/conversations` | list, newest first, **scoped to caller** |
| POST | `/conversations` | `{title?}` → 201 |
| GET | `/conversations/{id}` | 404 if not owned by caller (R9) |
| PATCH | `/conversations/{id}` | rename `{title}` |
| DELETE | `/conversations/{id}` | 204 |
| GET | `/conversations/{id}/messages` | paged |
| POST | `/conversations/{id}/messages` | **SSE stream**, see below |
| POST | `/conversations/{id}/messages/{messageId}/feedback` | `{helpful?, rating?, issueType?, comment?}` → 201 first time, 200 on update. One row per user per message: a second submission edits it rather than voting twice. A `messageId` from somebody else's conversation is `404` (R9). The response echoes the row and carries a `note` saying plainly that feedback does not change the answer that was already given. |

`issueType` is a controlled list — `WRONG_ANSWER`, `MISSING_SOURCE`, `STALE_SOURCE`, `LANGUAGE`, `OTHER` —
because this table is the source of the golden-eval set (P6), and free text cannot be counted.

### Admin

Ingestion and review are `CONTENT_MANAGER`; audit logs and configuration are `ADMIN`. Every one of these
is enforced server-side — the frontend hiding a link is not the control (§4).

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/knowledge/stats` | counters and the coverage note; no percentage until a manifest exists (R10) |
| GET | `/admin/audit-logs` | `ADMIN` only |
| POST | `/admin/ingestion/url` | `{url, …meta}` → **202** `{accepted, job, poll}` |
| POST | `/admin/ingestion/text` | `{content, …meta}` → 202 |
| POST | `/admin/ingestion/upload` | `{filename, contentBase64, …meta}` → 202 (`.pdf .html .txt .md .csv`) |
| POST | `/admin/ingestion/manifest` | `{csv, honorApprovedStatus?}` → 202 `{accepted, queued[], rejected[{line, field?, reason}], deferredRows, columns[]}` |
| GET | `/admin/ingestion/jobs` | `{items[], total, failed, queued}` — failures stay in the payload (R8) |
| GET | `/admin/ingestion/jobs/{id}` | job row; `state ∈ QUEUED\|RUNNING\|DONE\|FAILED`, `stage` names the pipeline step |
| POST | `/admin/ingestion/jobs/{id}/retry` | re-runs a retryable failed job with backoff already elapsed → **200** `{message, job}` when it completes, **409** `{message, job: null}` when it is not retryable, is not due yet, or the payload has to be re-submitted by hand |
| GET | `/admin/knowledge/documents` | `{items[], total, pendingReviewDocuments}` |
| GET | `/admin/knowledge/documents/{id}` | versions, per-version chunk counts by review state |
| GET | `/admin/knowledge/chunks` | `?versionId=&documentId=&reviewState=PENDING_REVIEW\|APPROVED\|REJECTED\|ALL&limit=&offset=` → `{items[], total, pendingReview}` |
| GET | `/admin/knowledge/chunks/{id}` | the chunk inspector — this is the **only** endpoint that returns `content` |
| POST | `/admin/knowledge/chunks/{id}/approve` | `{note?}` → `{reviewState:'APPROVED', …}`; 409 if the version was superseded |
| POST | `/admin/knowledge/chunks/{id}/reject` | `{note?}`; the row is kept for audit and leaves the index |
| POST | `/admin/knowledge/documents/{id}/versions/{versionId}/approve` | `{note?}` → `{approved, kbVersion, meaning}` — the only path that makes text searchable (R7) |
| POST | `/admin/knowledge/documents/{id}/versions/{versionId}/reject` | `{note?}` → `{rejected, kbVersion}`; the version stays readable, never retrievable |
| GET | `/admin/knowledge/sources/freshness` | `{items[], total, recheckable, changed, linkRot, neverChecked}` |
| POST | `/admin/knowledge/sources/check-freshness` | `{}` → `{checked, durationMs, results[], note}`; a sweep flags, it never re-ingests |
| GET | `/admin/knowledge/gaps` | the questions that returned `evidenceTier: "NONE"`, grouped, redacted, ≤500 chars each |
| GET | `/admin/feedback` | open feedback queue; `USER` gets 403 |

The `…meta` fields are shared by all three submission routes: `title` (required — a citation needs
one), `docType` (default `STANDARD`), `language` (default `en`), `standardNo`, `publisher`,
`licenseNote`, `copyrightStatus`, `accessLevel` (`open`/`restricted`, default `open`), `publishedDate`,
`revisedDate`, `documentId`, `overrideInjectionFlags`, `force`. Two of them are policy switches rather
than data: `accessLevel: restricted` requires a `licenseNote` (400 without one — otherwise the row is an
instruction to fetch something we may not redistribute, R11), and `force` re-ingests text whose content
hash already exists instead of short-circuiting to "unchanged".

Three rules hold across the whole admin surface:

- **Nothing becomes searchable without a person.** Ingestion produces `PENDING_REVIEW` chunks; only
  `…/approve` publishes them, and it is the single place `kbVersion` is bumped.
- **A rate limit is a 429, never a 503.** Submissions are throttled per account (burst 12, ~0.2/s
  refill) with `Retry-After`; the response shape is the ordinary `RATE_LIMITED` error so a client can
  tell "slow down" from "the service is down". Throttling is audited (`knowledge.ingest.throttled`)
  **with the actor recorded**, which is why the throttle runs after authentication.
- **Vectors are never serialised.** A chunk exposes `hasEmbedding` and `embeddingDimensions`; publishing
  embeddings would let a client probe the corpus by similarity.


## SSE message stream

`POST /conversations/{id}/messages` with `{content}` returns `text/event-stream`.

```
event: meta
data: {"messageId":"...","intent":"factual","language":"en","retrievalMs":12,"piiDetected":false,"inScope":true}

event: delta
data: {"text":"From sources"}

event: sources
data: {"sources":[{"ref":"S1","chunkId":"...","title":"...","standardNo":"...","section":"...","docType":"...","language":"en","sourceUrl":"...","verificationStatus":"VERIFIED","verifiedAt":"...","snippet":"..."}],"evidenceTier":"NONE"}

event: usage
data: {"promptTokens":512,"completionTokens":96,"model":"mock-large","costUsd":null,"cacheHit":false,"cacheMatch":null,"evidenceTier":"PARTIAL","truncated":false,"contextTokens":1840,"retrievalMs":12,"kbVersion":7,"systemPromptTokens":275,"rewrite":{"method":"passthrough","reason":"The question is already self-contained."},"droppedSentences":0,"limits":{"maxContextTokens":3000,"topK":6,"llmProvider":"openai-compatible","cacheTtlSeconds":900}}


event: done
data: {"messageId":"...","followUps":["...","...","..."]}

event: error
data: {"code":"PROVIDER_UNAVAILABLE","message":"..."}
```

`piiDetected` is `true` when the server found and **redacted** personal data (Aadhaar-like
digit runs, PAN, Indian mobile numbers, e-mail addresses, a pasted JWT) in the question. The
stored user turn holds the redacted text, never the raw text, so the flag is also the client's
cue to say so — the redaction is never silent. `inScope` is `false` exactly when `intent` is
`out_of_scope`.

**A cache hit sends a shorter `usage` frame.** When the answer came from the answer cache there was
no retrieval and no generation, so the frame carries `promptTokens`, `completionTokens`, `model`,
`costUsd`, `cacheHit: true`, `cacheMatch: "exact" | "similar"`, `cacheSimilarity` (`1` on an exact
match), `kbVersion`, `evidenceTier`, and `limits` with `llmProvider: "cache"` — and no retrieval or
rewrite fields, because there was no retrieval and no rewrite. Clients must read the fields they need
rather than assume the full frame (the answer, `sources`, `done` frames are identical either way, so
the evidence rail renders the same thing: R3 is not a cache exception).

### Answer cache semantics (§9)

A turn is stored only when **all** of these hold: the intent is one of `factual`, `recommend`,
`certification`, `hallmarking`, `lab`; no PII was detected; the conversation had **no prior turn**
(a follow-up's meaning depends on what came before, so it must never be answered from a global cache);
no provider error occurred; and the evidence tier is not `NONE`.

The key is `kb{kbVersion}|{language}|{intent}|sha256(normalised question)`, so:

- a cache entry cannot survive a knowledge-base change — approving or rejecting a chunk bumps
  `kbVersion` and every older entry stops matching (and the TTL does the rest);
- an English answer is never served to a Hindi question, and a `certification` answer is never served
  to the same words asked as a `factual` one;
- an exact-key hit is re-inserted for LRU order; a miss may still hit on embedding cosine ≥ `0.94`, in
  which case `cacheMatch` is `"similar"` and the similarity is reported. With the offline trigram
  embeddings 0.94 already admits two *different* questions, which is measured and documented in
  `docs/ENVIRONMENT.md` — the threshold means something only with real multilingual embeddings.

Nothing is cached when `ANSWER_CACHE_ENABLED=false`, and `/health/ready` plus
`limits.cacheTtlSeconds` on a generated turn say what the deployment actually has on.


Rules: `sources` is emitted **after** server-side citation validation (R3) and only ever contains rows
from the database — the model never supplies titles or URLs. `error` is terminal and must be surfaced
(R8). With an empty knowledge base every answer is the exact R4 sentence with `evidenceTier: "NONE"`;
that is correct behaviour, not a stub.

## Validation limits

| Field | Rule |
|---|---|
| `email` | RFC-5322-ish, ≤254 chars, lowercased on write |
| `password` | ≥10 chars, ≤200, must contain at least one **letter** and one **digit**, where both are Unicode categories (`\p{L}` / `\p{N}`, i.e. Java `Character.isLetter`/`isDigit`) — a Devanagari passphrase is valid; never logged; never returned |
| `fullName` | 1–120 chars, control chars stripped |
| `message.content` | 1–4000 chars |
| `conversation.title` | ≤160 chars |
| `ingestion.content` | ≥40 chars after control chars are stripped; no separate cap — the request body limit is the cap, and exceeding it is a `413` rather than a silently truncated save. 40 is "a paragraph", not a guess: a fragment is not a knowledge source and would be quoted out of context |
| `ingestion.title` | 3–200 chars, required — every citation needs one |
| `ingestion.url` | valid http(s) URL, ≤2048; no credentials, no trailing dot, port 80/443 unless the private-network flag is on |
| `ingestion.filename` | `^[^/\\\u0000-\u001F]+\.(pdf\|txt\|md\|markdown\|html?\|csv)$` — path separators are refused rather than stripped |
| `ingestion.contentBase64` | base64 only, decoded size ≤ `INGEST_MAX_BYTES` |
| `ingestion.manifest csv` | ≤400 000 chars; unknown columns are reported in `columns`, unusable rows in `rejected` |
| `review.note` | ≤500 chars, control chars stripped |
| `feedback.comment` | ≤1000 chars; `rating` 1–5 |

Body size: JSON bodies are capped at 64 kB except the ingestion routes, which raise it to
`INGEST_MAX_BYTES` (base64 inflates by ~4/3, so the limit is computed from the byte cap).
An oversized submission is `413`, not a truncated save (R8).

## Versioning

Additive changes only within `/api/v1`. Breaking changes get `/api/v2` and a deprecation note here.

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
  "app": { "name": "BIS-Saathi", "version": "0.1.0", "env": "development", "stack": "mock", "mockProvider": true },
  "auth": { "accessTokenTtlMinutes": 15, "personas": ["CONSUMER","MSME_MANUFACTURER","JEWELLER_RETAILER","STUDENT_ENGINEER"], "languages": ["en","hi"] },
  "knowledge": { "approvedDocuments": 0, "approvedChunks": 0, "kbVersion": 0 },
  "disclaimer": "Informational — verify against current official sources"
}
```

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

### Admin (read-only in P1; write actions arrive with ingestion in P2)

| Method | Path | Min role |
|---|---|---|
| GET | `/admin/ingestion/jobs` | `CONTENT_MANAGER` |
| GET | `/admin/knowledge/stats` | `CONTENT_MANAGER` |
| GET | `/admin/audit-logs` | `ADMIN` |

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
data: {"promptTokens":0,"completionTokens":0,"model":"mock-large","costUsd":0,"cacheHit":false,"evidenceTier":"NONE"}

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

## Versioning

Additive changes only within `/api/v1`. Breaking changes get `/api/v2` and a deprecation note here.

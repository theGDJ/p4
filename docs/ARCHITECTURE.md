# Architecture

Scope: how the pieces fit, and why each is shaped the way it is. The behavioural rules are
in `CLAUDE.md` (R1–R11); the wire contract is `docs/API.md`. Where this document and those
two disagree, they win.

Status: `frontend/` and `mock-api/` run and are tested. `backend/` is authored Java that
has never been compiled — see `docs/ENVIRONMENT.md`.

---

## 1. Shape

```
browser ── HTTP/SSE ──> frontend origin (nginx in prod, Vite dev server in dev)
                              │  same-origin /api/v1
                              ▼
                        backend  (Spring Boot modular monolith)
                          │        │        │
                          ▼        ▼        ▼
                      Postgres   Redis   LLM/embedding
                      +pgvector  (rate    providers behind
                      (truth)     limit)  interfaces + mock
```

One deployable API, one database that owns the truth, one cache that owns nothing. The
frontend is static files plus a proxy; it holds no session state that matters, because the
refresh cookie does.

**The two backends are interchangeable by contract, not by fork.** `mock-api/` is a
TypeScript implementation of `docs/API.md` used to exercise the UI, the auth flows and the
RAG decisions without a JVM. It is not a prototype that becomes the product: no
persistence, no SQL, no provider calls. Every endpoint therefore exists twice, which is a
cost, and the reason it's worth paying is that a contract implemented twice cannot stay
wrong quietly — one side's tests fail.

## 2. Backend modules (§3)

`in.bissaathi.{auth, user, chat, rag, ingestion, standards, certification, hallmarking, labs,
product, report, admin, audit, common}` — one Spring Boot module, package-separated, no
microservices. A modular monolith was chosen because the transactions here are real (a
message and its evidence are one write) and because role enforcement has one home.

Boundaries that are enforced by structure rather than discipline:

| Module | Owns | May be called by others through |
|---|---|---|
| `common` | enums, `ApiException`, error mapping, `AppProperties`, `TraceFilter` | everything (it depends on nothing) |
| `auth` | credentials, tokens, lockout, rate limiting | `AuthService.loadForAuthorization`, `JwtService.decode` |
| `config` | security filter chain, `RequestContext`, role checks | `AuthorizationManager.require(role)` |
| `chat` | conversations, messages, the SSE stream | nothing (it is a leaf) |
| `rag` | intent, retrieval, citation validation, answer policy | `AnswerService`, `RetrievalService` |
| `audit` | the audit trail | `AuditService.record` |
| `repo` | JPA repositories | **not** a shared bag: services use it, controllers never do |

The rule that keeps this honest: **a module never receives another module's entity.** It
gets an id and re-loads what it needs, so a lazy-loading surprise cannot leak across a
boundary. `RequestContext` exists for the same reason — `chat` needs to know who is calling
and must not reach into `auth` to find out.

`ingestion`, `standards`, `certification`, `hallmarking`, `labs`, `product`, `report` exist
as tables in `V1__init.sql` and as package names, and are filled in P2–P4. They are not
stubbed with empty controllers returning `[]`, because an endpoint that answers 200 with an
empty list is indistinguishable from a working feature (R8).

## 3. The answer pipeline

The single most important control flow, and the reason the ordering is written down
(`rag/AnswerService.decide`):

```
question
  ├─ 1. intent = IntentRouter.route(question)          # no retrieval yet
  ├─ 2. out_of_scope | chitchat | meta  → fixed sentence, STOP
  ├─ 3. clarify (vague)                 → ≤3 questions, STOP
  ├─ 4. retrieve:  vector top-30  ⊎  FTS top-30
  │                → RRF fuse → APPROVED ∧ ¬SUPERSEDED → rerank
  │                → top-6 → Jaccard dedupe → ≤3000 tokens
  ├─ 5. empty evidence → R4 sentence, tier NONE, STOP  ← no model is called
  ├─ 6. provider.isMock → PROVIDER_UNAVAILABLE error, STOP  (sources still returned)
  └─ 7. generate at temperature 0 → CitationValidator → tier → stream
```

Three properties that only hold because of the order:

- **Steps 2–3 before step 4.** A refusal or a greeting never enters an embedding pipeline,
  so "out of scope" costs nothing and leaks nothing.
- **Step 5 before step 7.** With an empty knowledge base there is no generation step left in
  which to fabricate. This is the design's main defence against hallucinated citations, not
  a prompt asking nicely.
- **Step 7 validates before it streams.** Only post-validation text is written to the socket;
  an unvalidated token never reaches the browser.

**Evidence tiers are computed by rule** (`computeEvidenceTier`), never taken from the model:
`STRONG` needs ≥2 chunks at/above the score threshold *and* every citation valid; one usable
source or any dropped citation is `PARTIAL`; nothing usable is `NONE`. A model rating its own
confidence is not evidence, and presenting it as such would be the exact failure this product
exists to avoid (R10).

**Retrieval caveat, stated plainly:** until real embeddings are wired, `mock` returns a
zero vector, the vector half contributes nothing, and the only surviving score is an
RRF rank — which is *not* comparable to a cosine similarity. The threshold that separates
`STRONG` from `PARTIAL` is therefore only meaningful once a real multilingual embedding model
is configured. Scores are never displayed to users as confidence, at any point.

## 4. Frontend

Vite + React 19 + Tailwind 4 (CSS-first config) + React Router 7 + TanStack Query 5 +
react-hook-form + Zod 4 + i18next + Motion. Hand-authored UI primitives over Radix, because
`ui.shadcn.com` was unreachable from the build sandbox and the CLI could not run; the
component API still matches shadcn's conventions so a later `shadcn add` is mechanical.

Layout of consequence:

- `src/lib/api.ts` — one fetch wrapper. Base path `/api/v1`, access token in **module memory
  only** (never `localStorage`: an XSS on a page that keeps a 30-day refresh cookie should
  not also be handed a durable bearer token), single-flight refresh, exactly one
  automatic refresh-and-retry on 401.
- `src/lib/auth.tsx` — `SessionProvider` owns `restoring | anonymous | authenticated`, plus
  `hasRole`. Route guards read it; **they are cosmetic**, and every one of them has a
  server-side twin in `AuthorizationManager`.
- `src/lib/validation.ts` — the client mirror of the API's validation table, built by a
  pure function so `form-validation.test.tsx` can test the schema the forms actually use.
  The password minimum comes from `/meta/bootstrap`, so a server policy change moves the
  client rule instead of drifting from it.
- `src/i18n/` — `en.ts` is the source of truth with `as const`; `hi.ts` is typed against a
  widened copy of it, so a missing or extra Hindi key, or a list of a different length, is a
  **compile error**. `i18n.test.ts` additionally asserts no key exists in one file and not
  the other, and that Hindi strings are actually Hindi (with a small allowlist for
  language-neutral values like `Email`).
- `src/index.css` — the §11 design tokens, each one measured: `npm run contrast` fails the
  build if a text pair drops below 4.5:1 or a non-text pair below 3:1. Saffron is a brand
  colour at 3.43:1, so it is legal for borders and icons and never for text; `--warn`
  exists as the accessible amber.

## 5. Data model notes

`V1__init.sql` covers all 21 tables from §7 plus `password_reset_tokens`. Decisions worth
defending:

- **`messages.user_id` is denormalised.** It duplicates the conversation's owner so that every
  message query can be authorised by `user_id` in the same WHERE clause that fetches the rows,
  with no join to get wrong (R9).
- **Citations reference `document_versions`, not `knowledge_documents`.** Re-ingesting a
  document must not rewrite the evidence behind an answer somebody already read (R2).
- **`knowledge_chunks.verification_status <> 'RESTRICTED'` is a CHECK constraint.** Restricted
  standards are metadata-only; storing their text is refused by the schema, not by convention
  (R11).
- **`refresh_tokens` and `password_reset_tokens` have no `updated_at` and no trigger.** They are
  append-only by design: mutating a token row destroys the evidence reuse detection depends on.
- **`tsv` is a `GENERATED ALWAYS ... STORED` column using the `simple` config.** Not `english`:
  an English stemmer mangles Devanagari, and a silently mis-tokenised column is the kind of bug
  that makes Hindi search "work" in tests and fail in production.
- **HNSW on `vector_cosine_ops`, `m = 16`, `ef_construction = 64`.** Cosine because the evidence
  threshold is defined in cosine space.

## 6. Streaming

`POST /conversations/{id}/messages` returns `text/event-stream` with a fixed frame order:
`meta → delta* → sources → usage → done`, or a terminal `error`. Frames are written and
flushed by hand (`chat/SseFrames`) rather than through a reactive type — boring, and it keeps
the ordering visible in one file. `deploy/nginx.conf.template` turns off `proxy_buffering`
and sets `X-Accel-Buffering: no`; without those, the answer arrives as one delayed blob.

`docs/API.md` reserves HTTP 422 for out-of-scope questions. It is not implemented on purpose:
a refusal is a *successful* answer about scope, and a 422 would have to abort a stream whose
status line is already sent.

## 7. Where the seams are for P2+

| Next phase | The seam that already exists |
|---|---|
| Real LLM | `LlmProvider` + `MockLlmProvider`; switch by `LLM_PROVIDER`. `isMock()` is what the UI badge reads, so a provider that lies about being a mock breaks a test |
| Real embeddings | `EmbeddingProvider` + `ZeroVectorEmbeddingProvider`; ingestion writes `embedding`, `embedding_model`, `embedded_at` |
| Ingestion pipeline | `ingestion_jobs` table, `IngestionJobEntity`, `/admin/ingestion/jobs` already render real state |
| Report export | `compliance_reports` with its own `evidence_tier` and `sources_json` |
| Mail | `requestPasswordReset` has one `isProduction()` branch that currently logs instead of sending |

## 8. What is deliberately *not* here

No ORM-generated schema (`ddl-auto: validate` — Flyway owns it). No semantic answer cache
pretending to be fresh. No confidence percentage. No second database. No feature flag that
changes authorisation. No endpoint that accepts a `userId` from a client — the caller's id
comes from the token, so there is nothing for a request to substitute.

# BIS-Saathi

A source-grounded, bilingual (English / हिन्दी) assistant for **Indian Standards** and **BIS
services**. You ask a question; it answers from an approved knowledge base of official
BIS material and shows the document, section and link behind every claim. When it cannot
find sufficient evidence, it says so — in the same breath it would otherwise have used to
guess.

> **Informational — verify against current official sources.**
> BIS-Saathi does not certify, approve or decide anything. A certification decision is
> BIS's to make, not this tool's.

---

## Status

**Phase 1 (Foundation) — frontend and mock API are running and tested; the Spring Boot
backend is authored but has never been compiled.**

| Piece | State |
|---|---|
| `frontend/` — Vite + React 19 + Tailwind 4 shell, landing page, auth forms, chat UI, i18n, a11y suite | **Runs.** 82 tests pass, typecheck clean, production build succeeds |
| `mock-api/` — Node/TS server implementing the same HTTP contract | **Runs.** 130 tests pass |
| `backend/` — Java 21 / Spring Boot 4.1.1 modular monolith, Flyway V1, Spring Security | **Authored, NOT compiled** — no JDK, Maven or Docker in the build sandbox |
| `docker-compose.yml`, both Dockerfiles | **Authored, NOT executed** — no Docker daemon |

This is not a to-do list item; it is the honest state, recorded because *a build nobody has
run is a claim, not an asset*. Details in [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md).

## Run it

You need Node 20+. No Docker, no JDK, no database.

```bash
cp .env.example .env
npm run install:all        # installs mock-api/ and frontend/ (no root dependencies)

# terminal 1 — the API (in-memory store, seeded demo accounts, no Postgres)
npm run dev:mock

# terminal 2 — the app, proxying /api/v1 to it
npm run dev:web
```

Open <http://localhost:5173>. The landing page works anonymously; asking a question
requires an account. Register one there, or use a seeded account whose credentials are
printed once in the mock API's startup banner.

To run the Java stack instead (needs Docker **and** a working `backend/` build):

```bash
docker compose up --build
docker compose --profile mock up frontend mock-api   # frontend + mock API only
```

## Verify it

```bash
npm run verify     # typecheck + both test suites + contrast + production build

# or the parts individually
npm run typecheck        # both packages
npm test                 # both packages
npm run test:a11y        # axe-core only
npm run contrast         # colour ratios only
npm run build            # frontend production build
```

| Command | What it gates |
|---|---|
| `frontend: test` | i18n parity (EN ↔ HI key-for-key), landing page, auth flows, protected routes and role gates, form validation, axe |
| `frontend: test:a11y` | WCAG 2.2 AA structure via axe-core (colour is the `contrast` job) |
| `frontend: contrast` | every text and non-text colour pair against its measured ratio |
| `mock-api: test` | auth, rotation and reuse detection, CSRF, lockout, rate limits, IDOR/role gates, the RAG pipeline |

## Layout

```
CLAUDE.md, AGENTS.md   the specification: principles R1–R11, features, data model, phases
docs/API.md            the HTTP contract. Both backends implement it; a deviation is a bug
docs/ENVIRONMENT.md    what could and could not be executed while building this
docs/ARCHITECTURE.md   module boundaries, data flow, why the pieces are shaped as they are
docs/SECURITY.md       auth model, tokens, roles, IDOR, rate limiting, threat notes
frontend/              Vite + React app
mock-api/              runnable Node stand-in for the backend
backend/               Spring Boot modular monolith (source only, until a JDK is present)
knowledge/, eval/      ingestion manifest and golden-question harness (P0 task contracts)
deploy/                nginx template used by the frontend image
```

## Two ideas worth knowing before you edit anything

**The invariants are load-bearing.** `CLAUDE.md` §2 lists R1–R11; code comments cite them as
`R3`, `R9`, and so on. Three matter most in this phase: the server never fabricates a
source, a statistic or a lab (**R10**); every query for user data is scoped by `user_id`
server-side, and "not yours" answers `404` rather than `403` (**R9**); and nothing reports
success it did not achieve (**R8**) — which is why the mock LLM refuses to write prose and
the UI badges it as a mock provider.

**Both backends implement one contract.** `docs/API.md` is the authority. `mock-api/` exists
so the frontend can be exercised, tested and demonstrated today; `backend/` is the product.
When you change an endpoint, change the document first, then both implementations, or the
two will drift and the drift will be found by a user.

## Deliberately absent

No fabricated coverage numbers, no "about 400 standards indexed", no fake lab directory, no
auto-approved ingestion, no answer without a citation trail. If you are looking for one of
those and cannot find it, that is the intended outcome.

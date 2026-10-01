# Sandbox environment probe — 2026-10-01

Recorded so the build does not re-discover these limits each turn, and so every "Done / Not done"
report is honest about what was actually executed (master spec §13).

## Host

| Item | Value |
|---|---|
| Repo | `/home/user/p4`, branch `arena/01a0f6d4-p4` (from `main` @ `2b07d6d`) |
| Initial content | `README.md` (5 bytes, `# p4`) — greenfield |
| OS | Debian GNU/Linux 12 (bookworm) |
| CPU / RAM / disk | 2 cores / 3.8 GiB / 20 GiB free |
| User | uid 1001, member of `sudo` (no passwordless sudo verified for installs) |

## Toolchains

| Tool | Status |
|---|---|
| node | v22.22.3 |
| npm | 10.9.8 (registry `https://registry.npmjs.org/`, `npm ping` OK, ~245 ms) |
| yarn | 1.22.22 |
| git / gh | 2.39.5 / 2.23.0, `GH_TOKEN` present |
| python3 | 3.11.2 |
| java / javac | **absent**, `/usr/lib/jvm` does not exist |
| mvn / gradle | **absent** |
| docker / docker compose | **absent** |
| psql / redis-cli | **absent** |
| pnpm | absent |

## Network reachability (HTTP status via curl, 8–10 s timeout)

| Host | Result |
|---|---|
| registry.npmjs.org | **200** |
| github.com | **200** |
| repo.maven.apache.org | 000 (SSL_ERROR_SYSCALL) |
| repo1.maven.org | 000 |
| deb.debian.org | 000 |
| api.adoptium.net | 000 |
| services.gradle.org | 000 |
| dlcdn.apache.org | 000 |
| fonts.googleapis.com | 000 |
| raw.githubusercontent.com | 000 |
| objects.githubusercontent.com | 000 |
| huggingface.co | 000 |
| api.openai.com | 000 |
| generativelanguage.googleapis.com | 000 |
| registry.npmjs.org/@fontsource/source-serif-4 | **200** |

No LLM/embedding credentials exist in the environment (`env` scan: only GitHub tokens).

## What this means for the plan

Runnable and verifiable here:
- The entire frontend: Vite build, dev server (live preview on 0.0.0.0), Vitest component tests,
  TypeScript typecheck, ESLint, axe accessibility checks, responsive checks.
- Self-hosted fonts via `@fontsource/*` from npm (satisfies §11 without the blocked Google Fonts CDN).
- Repo scaffolding, docs, Flyway SQL, Docker Compose, CI YAML — as reviewed source artifacts.
- Any Node-based tooling (mock API server, eval harness runner, JSONL validators, contrast checker).

Not runnable here (must be authored and reported as unexecuted):
- Spring Boot compile/test (`mvn test`), Testcontainers Postgres+pgvector+Redis integration tests.
- `docker compose up` (a P1 exit-gate item).
- Real LLM/embedding provider calls (P2 "real model-generated answers" exit-gate item).

These three are exit-gate items in PART B (P1, P2). They cannot be demonstrated in this sandbox as
configured, so the choice of how to handle them was escalated to the user rather than silently
substituted — substituting a canned success would itself violate R8/R10 in spirit.

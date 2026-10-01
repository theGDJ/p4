# syntax=docker/dockerfile:1
# =============================================================================
#  The Node mock API — the runnable stand-in for backend/ that keeps the frontend
#  exercisable without a JVM (docs/ENVIRONMENT.md explains why it exists).
#
#  It implements the same contract as docs/API.md. It is NOT the product: there is no
#  Postgres, no Redis and no real provider behind it, and the state is in memory, so
#  a container restart wipes every account. The UI badges it as a mock provider for
#  exactly that reason (R10).
#
#  ⚠ NEVER BUILT IN THE AUTHORING SANDBOX (no Docker). The server itself runs and its
#  130 tests pass outside a container; the image has not.
# =============================================================================

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# No compile step on purpose. `tsc` emitting extensionless ESM does not run under
# `node dist/*.js`, and switching module systems to make it compile would be a change
# to code that 130 tests currently pass — for a dev-only stand-in. So tsx ships as a
# runtime dependency and the image runs the same command the tests do.
#
# `tsx watch` is deliberately NOT used here: a file edit would restart the process and
# wipe the in-memory store, logging everybody out mid-session.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --fund=false

COPY src ./src

USER node
EXPOSE 8081

# config.ts refuses to boot in production with a placeholder secret, so a missing
# secret shows up as an exited container rather than a quietly insecure one.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-8081}/api/v1/health/live" || exit 1

CMD ["npm", "start"]

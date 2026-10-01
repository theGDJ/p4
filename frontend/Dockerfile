# syntax=docker/dockerfile:1
# =============================================================================
#  BIS-Saathi frontend — Vite build, served by nginx.
#
#  ⚠ NEVER BUILT IN THE AUTHORING SANDBOX (no Docker). The `npm run build` step
#  itself has been run locally and passes; the image has not.
#
#  Deliberately NOT a node server in production: `vite preview` is a development
#  tool. Static assets plus an nginx reverse proxy for /api is the boring, standard
#  answer, and it means the API's CORS allowlist only ever has to name the origin,
#  not this container.
# =============================================================================

# ----------------------------------------------------------------- build stage
FROM node:22-alpine AS build
WORKDIR /app

# 201 packages; the lockfiles are committed so this is reproducible.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --fund=false

COPY . .
# `npm run build` is `tsc --noEmit && vite build`, so a type error fails the image
# build rather than only the dev server.
RUN npm run build

# Tests are NOT run in the runtime image build: they need the mock API. CI runs
# `npm test` and `npm run test:a11y` separately and gates the merge there.
FROM build AS test
RUN npm test

# ---------------------------------------------------------------- runtime stage
FROM nginx:1.27-alpine

# Rendered at container start from CORS/UPSTREAM variables, so the same image works
# behind different hosts without a rebuild.
COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

# 8080 rather than 80: no privilege escalation, and it matches docker-compose.
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1

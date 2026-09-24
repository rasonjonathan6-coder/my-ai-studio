# Production web tier: serves the built frontend and reverse-proxies the API.
#
# The frontend is a static bundle, so it is built in a throwaway stage and only
# the output ships. The stage needs the workspace root because this is an npm
# workspace with a single root lockfile.
FROM node:22-bookworm-slim AS build

WORKDIR /repo
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/package.json
COPY backend/package.json backend/package.json
RUN npm ci --workspace frontend --include-workspace-root

COPY frontend ./frontend
# VITE_API_URL is deliberately empty: the browser calls the same origin it was
# served from, and Caddy routes /api and /ws to the backend. A single origin
# means no cross-site cookie, so the session cookie stays SameSite=Lax and no
# CORS preflight is involved. It also means the bundle is identical across
# environments, which removes a class of "works on my deploy" drift.
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build --workspace frontend

FROM caddy:2.8-alpine

COPY --from=build /repo/frontend/dist /srv
# Which Caddyfile to use is a deployment choice:
#   Caddyfile        TLS terminated here, needs a resolvable domain
#   Caddyfile.public TLS terminated upstream, serves plain HTTP on :80
ARG CADDYFILE=deploy/Caddyfile
COPY ${CADDYFILE} /etc/caddy/Caddyfile

EXPOSE 80 443

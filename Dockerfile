# ──────────────────────────────────────────────────────────────────────────────
# Backend-only container. Frontend is deployed to Cloudflare Pages.
# ──────────────────────────────────────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /build
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/ .
RUN npm run build

FROM node:22-slim AS runtime
# No Docker CLI in the runtime stage on purpose: the backend talks to
# /var/run/docker.sock through dockerode (HTTP over the unix socket), not
# through the `docker` CLI. The previous `apt-get install docker.io` line
# pulled in ~100 MB of containerd/runc/etc. for nothing — every daemon verb
# the backend needs is a method on dockerode (see backend/src/dockerManager.ts:
# spawn / inspect / start / stop / kill / remove / exec). The bind-mounted
# socket is the only ingress to the daemon and stays mounted from compose.
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /build/dist ./dist

EXPOSE 3001
CMD ["node", "dist/index.js"]

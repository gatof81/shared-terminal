# ──────────────────────────────────────────────────────────────────────────────
# Backend-only container. Frontend is deployed to Cloudflare Pages.
# ──────────────────────────────────────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /build
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
# Named paths, never `COPY backend/ .`: with the root .dockerignore this is
# belt and braces, so a stale backend/dist or node_modules on the build host
# cannot reach the image even if that file is ever loosened.
COPY backend/tsconfig.json ./
COPY backend/src ./src
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

# ──────────────────────────────────────────────────────────────────────────────
# Multi-stage build for the Shared Terminal app (backend + frontend).
# ──────────────────────────────────────────────────────────────────────────────
FROM node:22-slim AS base

# ── Build frontend ───────────────────────────────────────────────────────────
FROM base AS frontend-build
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build

# ── Build backend ────────────────────────────────────────────────────────────
FROM base AS backend-build
WORKDIR /build/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/ .
RUN npm run build

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM base AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
      docker.io \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

COPY --from=backend-build /build/backend/dist ./dist
COPY --from=frontend-build /build/frontend/dist ./frontend/dist

EXPOSE 3001
CMD ["node", "dist/index.js"]

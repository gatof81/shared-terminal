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
RUN apt-get update && apt-get install -y --no-install-recommends \
      docker.io \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /build/dist ./dist

EXPOSE 3001
CMD ["node", "dist/index.js"]

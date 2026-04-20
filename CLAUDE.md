# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All commands are run from within `backend/` or `frontend/`.

```bash
# Backend (Node 22+, TypeScript, CommonJS output)
cd backend
npm install
npm run dev        # tsx watch — auto-restarts on source changes
npm run build      # tsc → dist/
npm start          # node dist/index.js
npm run db:migrate # runs migrateDb() against D1 (requires dist/)

# Frontend (Vite + vanilla TS — no framework)
cd frontend
npm install
npm run dev        # vite on :5173, proxies /api and /ws to VITE_API_URL (default http://localhost:3001)
npm run build      # tsc && vite build

# Session container image (required before creating a session)
docker build -t shared-terminal-session ./session-image
# or: cd backend && npm run docker:build-session

# Backend deploy (frontend is deployed separately to Cloudflare Pages)
docker compose up -d --build
```

There is no test suite and no linter configured — verify changes by running `npm run build` in both workspaces and exercising the feature in a browser.

## Required environment

Backend refuses to start without `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and `D1_DATABASE_ID` (see `validateD1Config` in `backend/src/db.ts`). `JWT_SECRET` should also be set for anything past local experimentation. `.env.example` is the source of truth.

`WORKSPACE_ROOT` (default `/var/shared-terminal/workspaces`) must exist on the host and be writable by the backend — each session gets a `<WORKSPACE_ROOT>/<sessionId>` bind mount.

The frontend needs `VITE_API_URL` at build time (Cloudflare Pages env var) so `vite.config.ts` can rewrite the CSP meta tag to allow connections back to the backend.

## Architecture

Three pieces cooperate:

1. **Backend** (`backend/src/`) — Express REST + `ws` WebSocket on the same HTTP server (`index.ts`). Stateless; all persistence is in Cloudflare D1. Deployed on a self-hosted Linux box, typically behind Cloudflare Tunnel.
2. **Frontend** (`frontend/src/`) — vanilla TS SPA with xterm.js. Deployed to Cloudflare Pages in production; `vite.config.ts` rewrites the CSP meta tag based on `VITE_API_URL` so dev and prod agree.
3. **Session containers** — one Docker container per session, built from `session-image/Dockerfile` (Ubuntu 24.04 + Node 22 + Claude CLI + tmux). Each container runs `entrypoint.sh` which starts a detached tmux session named `main` and sleeps forever.

### The terminal data path

`wsHandler.ts` → `DockerManager.attach()` runs `docker exec … tmux attach -t main` with `Tty: true`. The hijacked stream is piped both ways:

- bytes from tmux → pushed into a per-session `RingBuffer` (128 KB) **and** broadcast to all listeners for that session;
- bytes from the browser → `docker.write(attachId, …)` back into the exec stdin.

On reconnect, the ring buffer is drained and sent as a single `output` message so the user sees recent scrollback. Multiple browser tabs can attach to the same session — they all share the same tmux and see the same stream (each with its own `attachId`, listener, and resize).

### Persistence model

- **Container state is ephemeral** — killed by `stopContainer` / `kill`. The bind-mounted workspace at `/home/developer/workspace` inside the container is what survives.
- **D1 is the source of truth** for session metadata (`session_id`, `container_id`, `status`, `env_vars`, `cols/rows`).
- **`DockerManager.reconcile()`** runs on startup and flips the D1 `status` to `stopped` for any session whose container is missing or not running — handles the case where the host rebooted but D1 still thinks sessions are live.

### Delete semantics

`DELETE /api/sessions/:id` is a **soft delete** by default: container is killed, row flips to `status=terminated`, workspace files are preserved so the user can later `POST /start` to respawn. Pass `?hard=true` to also purge the workspace dir and drop the row. `purgeWorkspace` refuses any path that does not resolve under `WORKSPACE_ROOT`.

### Auth

- REST: `Authorization: Bearer <jwt>` via `requireAuth` middleware. First visit shows `needsSetup: true` from `/api/auth/status` and the frontend drives user creation.
- WebSocket: token is passed via the `Sec-WebSocket-Protocol` header as `auth.bearer.<jwt>` (preferred — keeps it out of URLs/access logs), with a `?token=<jwt>` query-param fallback for proxies that strip the subprotocol header. `selectWsAuthProtocol` echoes the chosen subprotocol back in the handshake (RFC 6455 requires this).
- `sessions.assertOwnership(sessionId, userId)` is the single choke point for authorization on REST and WebSocket paths.

### Notes on D1

All `db.ts` calls are HTTP round-trips to Cloudflare. Keep query counts low on hot paths — the WebSocket attach already does multiple lookups per connection and there is no local cache.

## Code style

- **TypeScript strict mode** everywhere (both workspaces).
- **Tabs** for indentation.
- Section dividers in the form `// ── Section ───` are used throughout the backend — preserve them when editing.
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, …).
- Frontend deliberately has no framework — do not add React/Vue/etc. without discussion.

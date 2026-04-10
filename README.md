# Shared Terminal Service

A real-time shared terminal service where multiple users can create named terminal sessions, each backed by a real PTY process on the server, and connect to them through WebSockets using an in-browser xterm.js terminal.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Browser (Vite)                  │
│                                                  │
│  ┌──────────────┐       ┌────────────────────┐  │
│  │  Session     │       │   xterm.js         │  │
│  │  Sidebar     │       │   Terminal         │  │
│  │  (REST API)  │       │   (WebSocket)      │  │
│  └──────┬───────┘       └────────┬───────────┘  │
└─────────┼──────────────────────────┼─────────────┘
          │ HTTP /api/*              │ WS /ws/sessions/:id?userId=
          ▼                          ▼
┌─────────────────────────────────────────────────┐
│              Node.js Server (Express + ws)       │
│                                                  │
│  ┌──────────────┐  ┌───────────────────────┐    │
│  │ SessionManager│  │    WsHandler          │    │
│  │ (metadata)    │  │  (auth, replay, I/O)  │    │
│  └──────┬────────┘  └──────────┬────────────┘   │
│         │                      │                 │
│         └──────────┬───────────┘                 │
│                    ▼                             │
│           ┌────────────────┐                     │
│           │   PtyManager   │                     │
│           │ (node-pty +    │                     │
│           │  RingBuffer)   │                     │
│           └────────┬───────┘                     │
└────────────────────┼────────────────────────────┘
                     ▼
              OS Shell (PTY)
```

### Key Design Decisions

| Decision             | Choice                                           | Rationale                                                                 |
| -------------------- | ------------------------------------------------ | ------------------------------------------------------------------------- |
| PTY library          | `node-pty`                                       | True PTY — supports full terminal emulation (readline, curses, vim, etc.) |
| WebSocket library    | `ws`                                             | Minimal, no-magic, good TypeScript types                                  |
| Session ≠ Connection | Separate `SessionManager` / `PtyManager`         | PTY outlives browser tab; reconnect is possible                           |
| Output replay        | Per-session `RingBuffer` (64 KB)                 | No DB needed; reconnect sees recent history                               |
| Auth (MVP)           | `X-User-Id` header or `?userId=` query param     | Browsers can't set WS headers; query param is the browser fallback        |
| Idle cleanup         | 30-min timer starts when last client disconnects | Prevents zombie PTYs; configurable                                        |
| Frontend proxy       | Vite proxy `/api` + `/ws` → backend              | Avoids CORS issues in dev; production uses a real reverse proxy           |

### Tradeoffs

- **In-memory state only** — sessions do not survive server restarts. A Redis store or SQLite persistence layer would fix this for production.
- **Single server** — WebSocket sessions are node-local. Horizontal scaling needs a sticky-session load balancer or a pub-sub relay (e.g., Redis pub/sub).
- **PTY runs as server user** — all shells share the server process's OS user. Production should use containers or a per-session OS user via `setuid`.
- **Auth is illustrative** — `X-User-Id` is unauthenticated; a real system would use signed JWTs validated server-side.

---

## Project Structure

```
shared-terminal/
├── backend/
│   ├── src/
│   │   ├── index.ts          # HTTP server entry, Express + WebSocketServer setup
│   │   ├── routes.ts         # REST endpoints (POST/GET/DELETE /sessions)
│   │   ├── wsHandler.ts      # WebSocket attach/detach, message routing
│   │   ├── sessionManager.ts # In-memory session metadata registry
│   │   ├── ptyManager.ts     # node-pty lifecycle, listener fan-out, idle cleanup
│   │   ├── ringBuffer.ts     # Fixed-capacity output buffer for reconnect replay
│   │   ├── auth.ts           # userId extraction (header + URL fallback)
│   │   └── types.ts          # Shared TypeScript interfaces
│   ├── package.json
│   └── tsconfig.json
│
├── frontend/
│   ├── index.html            # Single-page app shell + all CSS
│   ├── vite.config.ts        # Vite + proxy config
│   ├── src/
│   │   ├── main.ts           # App entry, session list, event wiring
│   │   ├── api.ts            # REST client (ApiClient)
│   │   └── terminal.ts       # xterm.js + WebSocket bridge + resize observer
│   ├── package.json
│   └── tsconfig.json
│
└── README.md
```

---

## Running Locally

### Prerequisites

- Node.js ≥ 18
- npm ≥ 9
- macOS or Linux (node-pty requires a POSIX PTY; Windows needs WSL)

### 1. Start the backend

```bash
cd shared-terminal/backend
npm install          # first time only
npm run dev          # tsx watch — hot-reloads on file changes
```

Backend listens on **http://localhost:3001**.

Alternatively, build and run the compiled JS:

```bash
npm run build
npm start
```

### 2. Start the frontend

```bash
cd shared-terminal/frontend
npm install          # first time only
npm run dev
```

Frontend dev server: **http://localhost:5173**

Vite proxies `/api/*` → `http://localhost:3001` and `/ws/*` → `ws://localhost:3001` so no CORS setup is needed locally.

### 3. Open the browser

Navigate to **http://localhost:5173** and enter a user ID when prompted (any alphanumeric string).

---

## API Reference

All REST endpoints require an `X-User-Id` header.

| Method   | Path                | Body / Params                          | Description                   |
| -------- | ------------------- | -------------------------------------- | ----------------------------- |
| `GET`    | `/api/sessions`     | —                                      | List caller's active sessions |
| `POST`   | `/api/sessions`     | `{ name, cols?, rows?, shell?, cwd? }` | Create session + spawn PTY    |
| `DELETE` | `/api/sessions/:id` | —                                      | Terminate session + kill PTY  |

### WebSocket

```
ws://localhost:3001/ws/sessions/:sessionId?userId=<id>
```

**Client → Server messages:**

```jsonc
{ "type": "input", "data": "ls -la\r" }
{ "type": "resize", "cols": 220, "rows": 50 }
{ "type": "ping" }
```

**Server → Client messages:**

```jsonc
{ "type": "output", "data": "<terminal bytes>" }
{ "type": "status", "status": "running" | "disconnected" | "terminated" }
{ "type": "pong" }
{ "type": "error", "message": "..." }
```

On connect, the server immediately sends:

1. `{ type: "status", status: "running" }`
2. `{ type: "output", data: "<replay buffer>" }` — the last 64 KB of output so reconnecting clients see recent history.

---

## Session Lifecycle

```
POST /sessions → status: running
        │
        ├── WS connect  → PTY attached, output streams
        │
        ├── WS close    → status: disconnected
        │                  PTY stays alive (30-min idle timer starts)
        │
        ├── WS reconnect → replay buffer sent, status: running again
        │
        ├── PTY exits   → status: terminated  (shell typed `exit`, crashed, etc.)
        │
        └── DELETE /sessions/:id → PTY killed, status: terminated
```

---

## Security Limitations (MVP)

> ⚠️ This MVP is suitable for a local development environment only.

1. **No real authentication.** `X-User-Id` / `?userId=` is entirely user-supplied. Any client can impersonate any user ID.
2. **All shells share the server process's OS user.** A user running `rm -rf /` in their terminal affects the server host.
3. **No sandboxing.** Production deployments should run each session in an isolated container (Docker, gVisor, etc.) or use a restricted OS user via `setuid`.
4. **No TLS.** WebSocket traffic and API calls are unencrypted in this setup. Use nginx/Caddy with TLS termination in production.
5. **CORS is permissive.** The `Access-Control-Allow-Origin` is set to `http://localhost:5173`; tighten for production.

---

## Follow-up Improvements

### Scaling & Reliability

- [ ] Persist session metadata to Redis or SQLite so sessions survive server restarts
- [ ] Pub-sub relay (Redis) so WS clients can connect to any server node, enabling horizontal scaling
- [ ] Sticky-session load balancing (by `sessionId`) as a simpler alternative

### Security

- [ ] Replace `X-User-Id` with signed JWT verification (RS256/ES256)
- [ ] Run each PTY in a rootless container (Docker, Podman) or use Linux namespaces
- [ ] Add rate limiting on session creation per user
- [ ] Restrict available shells to a whitelist
- [ ] Add audit logging (who ran what, when)

### Features

- [ ] Collaborative sessions — multiple users share one session (like `tmux` multi-pane)
- [ ] Session persistence across server restarts (serialize ring buffer to disk)
- [ ] Named pipe / file upload support
- [ ] RBAC — admins can view/terminate any session
- [ ] Metrics (Prometheus) — active sessions, PTY memory usage, WS connection count

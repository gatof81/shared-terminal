# Shared Terminal

A self-hosted web-based terminal that runs on an always-on Linux server at home. Connect from any device, manage isolated Docker sessions per project/client, and run Claude CLI or any CLI tool from your browser.

## Architecture

```
[Any Device] ──HTTPS──▶ [Cloudflare Pages] ── static frontend (Vite + xterm.js)
                                 │
                                 ├──────────────▶ [Cloudflare D1] ── session + user metadata
                                 │
                                 └──HTTPS/WSS──▶ [Cloudflare Tunnel] ──▶ [Linux Server]
                                                                                ├── Backend (Node.js + Express + WebSocket)
                                                                                └── Docker Engine
                                                                                     ├── Container: project-acme  (tmux + claude CLI)
                                                                                     ├── Container: project-beta  (tmux + claude CLI)
                                                                                     └── ...
```

### Key Features

- **Docker-isolated sessions** — each session runs in its own container with dev tools pre-installed
- **Persistent sessions** — tmux inside each container keeps your terminal alive across disconnects
- **Persistent workspaces** — each session gets a bind-mounted host directory at `/home/developer/workspace`
- **JWT authentication** — secure login with bcrypt-hashed passwords
- **Per-session environment variables** — configure API keys, secrets per project
- **Real terminal emulation** — xterm.js in the browser with 256-color support, mouse, resize
- **Reconnect replay** — ring buffer replays recent output when you reconnect
- **Cloudflare D1 storage** — serverless SQLite on Cloudflare; session metadata survives server restarts and is accessible from anywhere
- **Docker Compose deployment** — one command to build and run the backend

## Quick Start (Development)

### Prerequisites

- Node.js 22+
- Docker
- Git
- A Cloudflare account with a D1 database provisioned (you'll need the account ID, an API token with D1 write permission, and the database ID)

### 1. Clone and install

```bash
git clone https://github.com/gatof81/shared-terminal.git
cd shared-terminal

# Backend
cd backend && npm install && cd ..

# Frontend
cd frontend && npm install && cd ..
```

### 2. Configure environment

```bash
cp .env.example .env
# Fill in CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, D1_DATABASE_ID, and JWT_SECRET
```

### 3. Build the session image

```bash
docker build -t shared-terminal-session ./session-image
```

### 4. Create workspace directory

```bash
sudo mkdir -p /var/shared-terminal/workspaces
sudo chown $USER /var/shared-terminal/workspaces
```

### 5. Start dev servers

```bash
# Terminal 1: Backend — will run migrateDb() against D1 on first start
cd backend && npm run dev

# Terminal 2: Frontend
cd frontend && npx vite
```

Open http://localhost:5173 — on first visit you'll be prompted to create an account.

## Production Deployment

### Backend (Docker Compose)

```bash
# Copy and edit environment variables
cp .env.example .env
# IMPORTANT: change JWT_SECRET and fill in CLOUDFLARE_* / D1_DATABASE_ID
nano .env

# Build and start
docker compose up -d --build
```

The backend will be available at `http://localhost:3001`.

### Frontend (Cloudflare Pages)

The frontend is a static Vite build. Deploy `frontend/dist` to Cloudflare Pages and set the `VITE_API_URL` env var in the Pages dashboard to your backend's public URL (e.g. `https://api.terminal.yourdomain.com`). `vite.config.ts` rewrites the CSP meta tag from that value so the browser allows connections back to your backend.

### With Cloudflare Tunnel

To expose the backend from your home server without opening ports:

```bash
# Install cloudflared
# See: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/

# Create a tunnel
cloudflared tunnel create shared-terminal

# Route DNS
cloudflared tunnel route dns shared-terminal api.terminal.yourdomain.com

# Run the tunnel
cloudflared tunnel --url http://localhost:3001 run shared-terminal
```

## API Reference

### Auth (public)

| Method | Path               | Description           |
| ------ | ------------------ | --------------------- |
| GET    | /api/auth/status   | Check if setup needed |
| POST   | /api/auth/register | Create account        |
| POST   | /api/auth/login    | Get JWT token         |

### Sessions (require `Authorization: Bearer <token>`)

| Method | Path                          | Description                                                   |
| ------ | ----------------------------- | ------------------------------------------------------------- |
| POST   | /api/sessions                 | Create session + Docker container                             |
| GET    | /api/sessions                 | List active sessions (append `?all=true` to include terminated) |
| GET    | /api/sessions/:id             | Get session details                                           |
| DELETE | /api/sessions/:id             | Soft delete (container killed, workspace kept, row→terminated) |
| DELETE | /api/sessions/:id?hard=true   | Hard delete (also purge workspace dir + drop the D1 row)      |
| POST   | /api/sessions/:id/stop        | Stop container (preservable)                                  |
| POST   | /api/sessions/:id/start       | Restart or respawn stopped container                          |
| PATCH  | /api/sessions/:id/env         | Update environment variables                                  |

### WebSocket

```
ws://host/ws/sessions/:id
Sec-WebSocket-Protocol: auth.bearer.<jwt>
```

The token may also be passed as `?token=<jwt>` as a fallback for proxies that strip the `Sec-WebSocket-Protocol` header.

**Client → Server:** `input`, `resize`, `ping`
**Server → Client:** `output`, `status`, `pong`, `error`

## Session Container

Each session runs in a Docker container based on `session-image/Dockerfile`:

- **OS:** Ubuntu 24.04
- **Dev tools:** git, curl, build-essential, python3, Node.js 22, vim, nano, htop, jq
- **Claude CLI:** `@anthropic-ai/claude-code` (globally installed)
- **Terminal:** tmux with a session named `main`, 50k scrollback, mouse support
- **User:** `developer` (sudo, no password)
- **Workspace:** `/home/developer/workspace` (bind-mounted from `<WORKSPACE_ROOT>/<sessionId>` on the host)
- **Resources:** 2 GB RAM, 2 CPUs per container (configurable in `dockerManager.ts`)

## Tech Stack

| Layer      | Technology                        |
| ---------- | --------------------------------- |
| Frontend   | TypeScript, Vite, xterm.js        |
| Backend    | TypeScript, Node.js, Express, ws  |
| Auth       | JWT (jsonwebtoken), bcryptjs      |
| Database   | Cloudflare D1 (accessed via HTTP) |
| Containers | Docker (dockerode), tmux          |
| Tunnel     | Cloudflare Tunnel                 |
| Hosting    | Cloudflare Pages (frontend), self-hosted (backend) |

## Project Structure

```
shared-terminal/
├── backend/
│   └── src/
│       ├── index.ts          # Server entry point (Express + ws on one HTTP server)
│       ├── db.ts             # Cloudflare D1 client (HTTP API) + migrations
│       ├── auth.ts           # JWT auth + user management (REST + WS subprotocol)
│       ├── sessionManager.ts # Session metadata (D1-backed CRUD)
│       ├── dockerManager.ts  # Docker container lifecycle + exec/attach
│       ├── wsHandler.ts      # WebSocket → docker exec tmux bridge
│       ├── routes.ts         # REST API routes
│       ├── ringBuffer.ts     # Circular buffer for reconnect replay
│       └── types.ts          # Shared types + WS protocol messages
├── frontend/
│   ├── index.html            # SPA shell (auth + terminal UI)
│   ├── vite.config.ts        # Rewrites CSP from VITE_API_URL
│   └── src/
│       ├── main.ts           # App entry (auth flow, session sidebar)
│       ├── api.ts            # REST client with JWT
│       └── terminal.ts       # xterm.js + WebSocket bridge
├── session-image/
│   ├── Dockerfile            # Session container image
│   ├── entrypoint.sh         # tmux startup script
│   └── tmux.conf             # tmux theme & settings
├── Dockerfile                # Backend-only image (frontend ships via Pages)
├── docker-compose.yml        # Backend + session image build
└── .env.example              # Environment template
```

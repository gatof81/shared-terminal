# Shared Terminal

A self-hosted web-based terminal that runs on an always-on Linux server at home. Connect from any device, manage isolated Docker sessions per project/client, and run Claude CLI or any CLI tool from your browser.

## Architecture

```
[Any Device] ←HTTPS→ [Cloudflare Tunnel] ←HTTP/WS→ [Linux Server]
                                                          ├── Backend (Node.js + Express + WebSocket)
                                                          ├── Frontend (Vite + TypeScript + xterm.js)
                                                          └── Docker Engine
                                                               ├── Container: project-acme  (tmux + claude CLI)
                                                               ├── Container: project-beta  (tmux + claude CLI)
                                                               └── ...
```

### Key Features

- **Docker-isolated sessions** — each session runs in its own container with dev tools pre-installed
- **Persistent sessions** — tmux inside each container keeps your terminal alive across disconnects
- **Persistent workspaces** — each session gets a Docker volume mounted at `/home/developer/workspace`
- **JWT authentication** — secure login with bcrypt-hashed passwords
- **Per-session environment variables** — configure API keys, secrets per project
- **Real terminal emulation** — xterm.js in the browser with 256-color support, mouse, resize
- **Reconnect replay** — ring buffer replays recent output when you reconnect
- **SQLite storage** — session metadata survives server restarts
- **Docker Compose deployment** — one command to build and run everything

## Quick Start (Development)

### Prerequisites

- Node.js 22+
- Docker
- Git

### 1. Clone and install

```bash
git clone https://github.com/gatof81/shared-terminal.git
cd shared-terminal

# Backend
cd backend && npm install && cd ..

# Frontend
cd frontend && npm install && cd ..
```

### 2. Build the session image

```bash
docker build -t shared-terminal-session ./session-image
```

### 3. Create workspace directory

```bash
sudo mkdir -p /var/shared-terminal/workspaces
sudo chown $USER /var/shared-terminal/workspaces
```

### 4. Start dev servers

```bash
# Terminal 1: Backend
cd backend && npm run dev

# Terminal 2: Frontend
cd frontend && npx vite
```

Open http://localhost:5173 — on first visit you'll be prompted to create an account.

## Production Deployment

### Using Docker Compose

```bash
# Copy and edit environment variables
cp .env.example .env
# IMPORTANT: Change JWT_SECRET to a random string!
nano .env

# Build and start
docker compose up -d --build
```

The app will be available at `http://localhost:3001`.

### With Cloudflare Tunnel

To access from outside your local network:

```bash
# Install cloudflared
# See: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/

# Create a tunnel
cloudflared tunnel create shared-terminal

# Route DNS
cloudflared tunnel route dns shared-terminal terminal.yourdomain.com

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

| Method | Path                    | Description                         |
| ------ | ----------------------- | ----------------------------------- |
| POST   | /api/sessions           | Create session + Docker container   |
| GET    | /api/sessions           | List active sessions                |
| GET    | /api/sessions/:id       | Get session details                 |
| DELETE | /api/sessions/:id       | Terminate (stop + remove container) |
| POST   | /api/sessions/:id/stop  | Stop container (preservable)        |
| POST   | /api/sessions/:id/start | Restart stopped container           |
| PATCH  | /api/sessions/:id/env   | Update environment variables        |

### WebSocket

```
ws://host/ws/sessions/:id
Sec-WebSocket-Protocol: auth.bearer.<jwt>
```

**Client → Server:** `input`, `resize`, `ping`
**Server → Client:** `output`, `status`, `pong`, `error`

## Session Container

Each session runs in a Docker container based on `session-image/Dockerfile`:

- **OS:** Ubuntu 24.04
- **Dev tools:** git, curl, build-essential, python3, Node.js 22, vim, nano, htop, jq
- **Claude CLI:** `@anthropic-ai/claude-code` (globally installed)
- **Terminal:** tmux with catppuccin-inspired theme, 50k scrollback, mouse support
- **User:** `developer` (sudo, no password)
- **Workspace:** `/home/developer/workspace` (persistent Docker volume)
- **Resources:** 2 GB RAM, 2 CPUs per container (configurable)

## Tech Stack

| Layer      | Technology                       |
| ---------- | -------------------------------- |
| Frontend   | TypeScript, Vite, xterm.js       |
| Backend    | TypeScript, Node.js, Express, ws |
| Auth       | JWT (jsonwebtoken), bcrypt       |
| Database   | SQLite (better-sqlite3)          |
| Containers | Docker (dockerode), tmux         |
| Tunnel     | Cloudflare Tunnel                |

## Project Structure

```
shared-terminal/
├── backend/
│   └── src/
│       ├── index.ts          # Server entry point
│       ├── db.ts             # SQLite database layer
│       ├── auth.ts           # JWT auth + user management
│       ├── sessionManager.ts # Session metadata (CRUD)
│       ├── dockerManager.ts  # Docker container lifecycle
│       ├── wsHandler.ts      # WebSocket → Docker exec bridge
│       ├── routes.ts         # REST API routes
│       ├── ringBuffer.ts     # Circular buffer for replay
│       └── types.ts          # Shared types
├── frontend/
│   ├── index.html            # SPA shell (auth + terminal UI)
│   └── src/
│       ├── main.ts           # App entry (auth flow, session sidebar)
│       ├── api.ts            # REST client with JWT
│       └── terminal.ts       # xterm.js + WebSocket bridge
├── session-image/
│   ├── Dockerfile            # Session container image
│   ├── entrypoint.sh         # tmux startup script
│   └── tmux.conf             # tmux theme & settings
├── Dockerfile                # Multi-stage build (app)
├── docker-compose.yml        # Full deployment
└── .env.example              # Environment template
```

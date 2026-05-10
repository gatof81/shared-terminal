# Deployment

This guide covers running shared-terminal locally for development and deploying it for production. The architecture is split: the backend runs on a self-hosted Linux box (typically behind Cloudflare Tunnel), the frontend is a static Vite build deployed to Cloudflare Pages, and all session/user metadata lives in Cloudflare D1.

For the security posture you should adopt before exposing the backend to the public internet, read [SECURITY.md](./SECURITY.md) — that's load-bearing, not optional.

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

### 2. Provision Cloudflare D1

The backend reads and writes all session/user metadata through Cloudflare's D1 HTTP API, so a D1 database must exist before the backend can start. You will end up with three values: `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, and `CLOUDFLARE_API_TOKEN`.

**a. Create the database with Wrangler**

```bash
npm i -g wrangler
wrangler login                       # opens a browser, authorizes your account
wrangler d1 create shared-terminal   # prints the database UUID — this is D1_DATABASE_ID
```

If you prefer the dashboard: **Workers & Pages → D1 → Create database**. The database ID is shown on the database's detail page.

**b. Find your account ID**

Run `wrangler whoami`, or open the Cloudflare dashboard — the account ID is in the right sidebar of any Workers & Pages page. This is `CLOUDFLARE_ACCOUNT_ID`.

**c. Create an API token**

Dashboard → **My Profile → API Tokens → Create Token → Create Custom Token**. The token needs:

| Scope   | Permission    |
| ------- | ------------- |
| Account | **D1 → Edit** |

Restrict "Account Resources" to the account you just used and save the token — this is `CLOUDFLARE_API_TOKEN`. Cloudflare only shows it once.

No schema migration step is needed — the backend runs `migrateDb()` against the empty D1 database on its first startup.

### 3. Configure environment

```bash
cp .env.example .env
# Fill in CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, D1_DATABASE_ID, and JWT_SECRET
```

### 4. Build the session image

```bash
docker build -t shared-terminal-session ./session-image
```

### 5. Create workspace directory

```bash
sudo mkdir -p /var/shared-terminal/workspaces
sudo chown $USER /var/shared-terminal/workspaces
```

### 6. Start dev servers

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

# Build the session image (first time + whenever session-image/ changes)
docker compose build session-image
# or equivalently: docker build -t shared-terminal-session ./session-image

# Build and start the backend
docker compose up -d --build
```

The backend will be available at `http://localhost:3001`.

> **Note:** the `session-image` service lives behind a `build` compose profile so
> it is only built on demand and never runs as a long-lived container. `app` does
> not depend on it at runtime — it just needs the `shared-terminal-session` image
> to exist in Docker's image store before creating sessions.

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

For port-exposure subdomains (`p<port>-<sessionId>.<base>.your-tunnel.com`), set `PORT_PROXY_BASE_DOMAIN` in `.env` to the apex you've routed and add a wildcard DNS rule on the tunnel: `cloudflared tunnel route dns shared-terminal *.<base>.your-tunnel.com`. Also set `COOKIE_DOMAIN` to the parent domain shared by the API hostname and the dispatcher base; without it the `st_token` cookie is host-only and private-port auth structurally fails. See [API.md → Port-exposure dispatcher](./API.md#port-exposure-dispatcher) for the wire shape.

## What's inside each session

Each session runs in a Docker container based on `session-image/Dockerfile`:

- **OS:** Ubuntu 24.04
- **Dev tools:** git, curl, build-essential, python3, Node.js 22, vim, nano, htop, jq
- **Claude CLI:** `@anthropic-ai/claude-code` (globally installed; aliased to `claude --dangerously-skip-permissions` in interactive shells. The container sandbox prevents host compromise / privilege escalation, but **does not protect workspace files from in-session destructive actions** — Claude can run `rm -rf ~/workspace/…` or overwrite a tracked file without asking. Bypass the alias with `\claude` or `command claude` for one call, `unalias claude` for the rest of the shell.)
- **VS Code CLI:** `code` (standalone) — see [REMOTE-EDITING.md](./REMOTE-EDITING.md)
- **GitHub CLI:** `gh` (standalone) — auth once with `gh auth login`, then drive PRs / issues / `gh api …` from the session
- **Terminal:** tmux with a session named `main`, 50k scrollback, mouse support
- **User:** `developer` (UID 1000, unprivileged — no sudo, all Linux capabilities dropped, `no-new-privileges` set)
- **Workspace:** `/home/developer/workspace` (bind-mounted from `<WORKSPACE_ROOT>/<sessionId>` on the host)
- **Resources:** Per-session caps come from `session_configs` (`cpu_limit` 0.25–8 cores, `mem_limit` 256 MiB–16 GiB, `idle_ttl_seconds` 60s–24h). Sessions created without explicit caps fall back to the `DEFAULT_NANO_CPUS` (2 cores) / `DEFAULT_MEMORY_BYTES` (2 GiB) constants in `dockerManager.ts`. Idle auto-stop is opt-in (omit `idleTtlSeconds` to disable).

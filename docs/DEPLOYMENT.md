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

# Create the shared session network (first time only). The backend and every
# session container join this network so the port dispatcher can reach a
# session's exposed ports directly by container name. Its name must match
# SESSIONS_NETWORK in .env (default `sessions-net`); the compose `networks:`
# entry declares it `external`, so compose will NOT create it for you.
docker network create sessions-net

# Build and start the backend
docker compose up -d --build
```

The backend will be available at `http://localhost:3001`.

> **Port exposure & the shared network.** Sessions expose ports (`config.ports[]`,
> editable live from the terminal toolbar's **Ports** button) by being reachable
> from the backend over the `sessions-net` network — the dispatcher proxies to
> `http://<container_name>:<port>` rather than publishing a host port. Two
> consequences: (1) `docker network create sessions-net` must exist before
> `docker compose up`, and (2) **after upgrading to this version, any session
> that was already running must be stopped and started once** so it re-joins the
> new network — until then the dispatcher can't reach its ports. This is a
> one-time cutover, the same shape as the `COOKIE_DOMAIN` cutover below.

> **Tenancy / isolation assumption.** All session containers share `sessions-net`,
> a user-defined bridge with embedded DNS, so any container can resolve and
> connect to another by its Docker name (`st-<sessionId[:12]>`) — including ports
> the owner never declared public (those bypass the dispatcher's auth gate, which
> only guards ingress from the Tunnel, not container-to-container traffic). This
> is **not a new reachability vector**: Docker's default bridge (used before this
> version) has inter-container communication enabled by default, so containers
> could already reach each other by IP; the shared network adds name-based
> *discoverability* (session IDs are UUIDs, so names are enumerable but not
> trivially guessable). **shared-terminal assumes a single-tenant host** — every
> session belongs to operators who trust each other (the design target: a
> self-hosted box for one person or a small trusted team). Do **not** run mutually
> untrusted users' sessions on the same host without adding isolation first
> (per-session Docker networks with backend-only peering, or daemon-level
> `icc=false` plus a network policy). Tracking hardening for a multi-tenant story
> is out of scope for this version.

> **Note:** the `session-image` service lives behind a `build` compose profile so
> it is only built on demand and never runs as a long-lived container. `app` does
> not depend on it at runtime — it just needs the `shared-terminal-session` image
> to exist in Docker's image store before creating sessions.

### Frontend (Cloudflare Pages)

The frontend is a static Vite build. Deploy `frontend/dist` to Cloudflare Pages and set the `VITE_API_URL` env var in the Pages dashboard to your backend's public URL (e.g. `https://api.terminal.yourdomain.com`). `vite.config.ts` rewrites the CSP meta tag from that value so the browser allows connections back to your backend.

### With Cloudflare Tunnel

To expose the backend from your home server without opening ports. The example below uses `terminal.example.com` as the **shared parent domain**, with the API at `api.terminal.example.com`, the Pages-hosted frontend at `app.terminal.example.com`, and the per-session port dispatcher (#190) on `*.terminal.example.com`. Substitute your own domain throughout.

#### 1. Install cloudflared and create the tunnel

Follow Cloudflare's installer for your distro: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/. Install the package version (the systemd-managed daemon) for production — the ad-hoc `cloudflared tunnel --url http://localhost:3001 run` form is fine for a first try but doesn't survive a reboot.

```bash
cloudflared tunnel login                       # opens a browser, authorizes your zone
cloudflared tunnel create shared-terminal      # prints the tunnel UUID — note it
```

`sudo cloudflared service install` comes in Step 3 below, AFTER the config file exists. Installing the systemd unit before the config is in place gives you a service that has nothing to serve, exits immediately on first start, and looks like a crash loop in `journalctl` while you wonder why.

#### 2. DNS records

Add three records under your zone in the Cloudflare dashboard:

| Type    | Name             | Target                              | Proxy  | Notes                              |
| ------- | ---------------- | ----------------------------------- | ------ | ---------------------------------- |
| `CNAME` | `api.terminal`   | `<tunnel-uuid>.cfargotunnel.com`    | Proxied | Backend API + WebSocket            |
| `CNAME` | `app.terminal`   | `<your-project>.pages.dev`          | Proxied | Pages-hosted frontend (separate from the tunnel — must resolve directly to Pages, otherwise the wildcard below catches it) |
| `CNAME` | `*.terminal`     | `<tunnel-uuid>.cfargotunnel.com`    | Proxied | Wildcard for the port dispatcher   |

Cloudflare DNS resolves exact records before the wildcard, so the explicit `api.terminal` and `app.terminal` rows always win — the wildcard catches only the per-session `p<port>-<sessionId>.terminal.example.com` hosts. Skip the `app.terminal` row and the wildcard silently swallows your frontend hostname, routing it through the tunnel into the backend's 404 / auth surface instead of serving the SPA.

If the wildcard slot is already taken by your registrar's parking record (e.g. Porkbun's `pixie.porkbun.com` placeholder), edit that record rather than trying to add a second — Cloudflare disallows two records with the same name+type. Parking records are virtually always safe to replace.

> **Universal SSL footnote.** Cloudflare's free cert covers exactly one level of subdomain (`*.terminal.example.com` works). It does NOT cover two levels (`*.foo.terminal.example.com`). The port dispatcher only uses one level, so this is fine — but nesting deeper requires Advanced Certificate Manager.

#### 3. cloudflared ingress (`/etc/cloudflared/config.yml`)

Order matters: top-to-bottom matching, exact matches above the wildcard, catch-all at the end.

```yaml
tunnel: <tunnel-uuid>
credentials-file: /etc/cloudflared/<tunnel-uuid>.json

ingress:
  - hostname: api.terminal.example.com
    service: http://localhost:3001

  # Per-session port dispatcher (#190) — hostnames of the form
  # p<port>-<sessionId>.terminal.example.com are intercepted by
  # portDispatcher.ts and reverse-proxied to the right container's
  # kernel-assigned host port.
  - hostname: "*.terminal.example.com"
    service: http://localhost:3001

  - service: http_status:404
```

Validate the config before installing the service. The `ingress rule` form is a dry-run router — useful for sanity-checking that a representative dispatcher host actually matches the wildcard:

```bash
cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate
cloudflared tunnel --config /etc/cloudflared/config.yml ingress rule https://api.terminal.example.com
cloudflared tunnel --config /etc/cloudflared/config.yml ingress rule https://p3000-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.terminal.example.com
```

Once the config validates, install the systemd unit and start it:

```bash
sudo cloudflared service install               # registers the systemd unit (config is already at /etc/cloudflared/config.yml)
sudo systemctl status cloudflared              # should be active (running)
```

After any later config edit, reload with `sudo systemctl restart cloudflared`. The package-installed unit has no `ExecReload`, so `systemctl reload` / `SIGHUP` just terminates the process — relying on systemd's `Restart=` to bring it back is messier than a clean `restart`.

#### 4. Backend `.env`

```env
TRUST_PROXY=1
PORT_PROXY_BASE_DOMAIN=terminal.example.com
COOKIE_DOMAIN=terminal.example.com
CORS_ORIGINS=https://app.terminal.example.com,https://<your-project>.pages.dev
```

- `TRUST_PROXY=1` is mandatory behind any Cloudflare Tunnel — without it, `req.ip` collapses to the tunnel's shared egress IP and per-IP rate limiting becomes useless.
- `PORT_PROXY_BASE_DOMAIN` and `COOKIE_DOMAIN` are a pair: set both or neither. With `PORT_PROXY_BASE_DOMAIN` set but `COOKIE_DOMAIN` unset, the backend warns at boot and private-port auth structurally fails because the JWT cookie stays host-only.
- `COOKIE_DOMAIN` must be a parent shared by the API hostname AND the dispatcher subdomains. In this example `terminal.example.com` covers both `api.terminal.example.com` and `p<port>-<sid>.terminal.example.com`.

#### 5. Verify

```bash
# Confirms the dispatcher env reached the container:
docker logs shared-terminal-app-1 --tail 50 | grep -i 'port dispatcher'
# → "[server] port dispatcher enabled at *.terminal.example.com"

# External smoke tests:
curl -fsS -o /dev/null -w "%{http_code}\n" https://api.terminal.example.com/api/auth/status
# → 200
curl -fsS -o /dev/null -w "%{http_code}\n" https://random-unmapped.terminal.example.com/
# → 404 (catch-all; didn't leak elsewhere)
```

End-to-end test of port exposure: create a session with `config.ports: [{ container: 3000, public: false }]`, run something on `:3000` inside it (binding to `0.0.0.0`), then open `https://p3000-<full-session-uuid>.terminal.example.com` in a browser where you're logged in.

#### Operational footguns

- **Cookie scope shift on cutover.** Switching `COOKIE_DOMAIN` from unset (host-only `api.terminal.example.com`) to set (`terminal.example.com`) means already-issued cookies coexist with new ones; some browsers prefer the stale host-only cookie until it expires (default `JWT_EXPIRES_IN=7d`). Existing users may need to clear cookies once after the cutover.
- **Wildcard catches everything else.** With `*.terminal.example.com` pointing at the tunnel, every previously-unrouted subdomain under `terminal.example.com` now hits this backend and returns 404. If anything outside this stack was relying on a wildcard parking page or a LAN-side resolver, it stops working.
- **WS upgrade rate limiter is per original-client IP.** Behind the tunnel that only holds because `TRUST_PROXY=1` lets the limiter peel the Cloudflare hop. With `TRUST_PROXY=0` every WS connection in the world would share one bucket.
- **Public-port auth is bypass-by-design.** Sessions declaring `public: true` ports route through the dispatcher with no cookie check — anyone on the internet can hit them. Use only for webhooks / OAuth callbacks; warn users in the UI when they tick the box.

See [API.md → Port-exposure dispatcher](./API.md#port-exposure-dispatcher) for the wire shape.

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

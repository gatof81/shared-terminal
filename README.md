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
- **Configurable session creation** — per-session env vars (with `secret`-typed AES-256-GCM-encrypted entries), git repo clone (HTTPS / SSH, PAT / private-key auth, "replace workspace" mode), exposed ports (per-session subdomains via the dispatcher), lifecycle hooks (`postCreate`, `postStart`, dotfiles repo, agent-config seed, git identity), resource caps (CPU 0.25–8 cores, memory 256 MiB–16 GiB), idle auto-stop, and reusable named templates
- **JWT auth via httpOnly cookie** — `Secure`+`SameSite=None` in production, no JS-readable token; bcrypt password hashing, invite-code-only registration after the bootstrap account, two-tier admin model
- **Real terminal emulation** — xterm.js in the browser with 256-color support, mouse, resize
- **Reconnect replay** — `tmux capture-pane` snapshot is replayed on reconnect (color + cursor position preserved); a deterministic flush re-orders live bytes that arrived during the attach window so the on-the-wire sequence is `[replay][live]` with no interleave
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

## Security model

Read this before exposing the backend to the public internet.

### Threat model

The backend's job is to spawn, attach to, and kill Docker containers
on demand. To do that, `docker-compose.yml` bind-mounts the host's
`/var/run/docker.sock` into the backend container:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

This is the standard tradeoff for a session-orchestrator design, but
the consequences need to be explicit:

- **The backend has full Docker daemon access.** The Docker API the
  socket exposes is unauthenticated to anything that can `connect(2)`
  to it. There is no per-endpoint ACL on a vanilla socket.
- **An RCE in the backend is host root.** An attacker who reaches
  arbitrary code execution inside the backend container can ask the
  daemon to start a privileged container that bind-mounts the host
  rootfs and chroots into it. There is no container-level mitigation
  for this once the socket is reachable.
- **The session containers themselves run unprivileged** (no
  `--privileged`, no extra capabilities, no host PID/net namespaces).
  The socket exposure is a backend-trust property, not a session-
  trust property.

### Recommended deployment posture

- **Do not expose port 3001 directly to the internet.** Treat the
  backend as a private service.
- **Run behind Cloudflare Tunnel** (already documented above) so the
  origin has no inbound ports open at all. The tunnel terminates at
  Cloudflare; the home server only makes outbound connections.
- **Gate the tunnel hostname with Cloudflare Access.** A short Access
  policy ("emails matching me@example.com") in front of the tunnel
  hostname turns "anyone on the internet" into "people who can prove
  they're me" before any HTTP request reaches the backend. The
  in-app JWT auth is still the primary control; Access is a hard
  belt around it.
- **Keep the host patched and the backend image rebuilt.** Both the
  Node runtime and the dependencies in `backend/package.json` are
  CVE-bearing surfaces, and an unpatched RCE there inherits the
  socket-access blast radius above.

### Optional: docker-socket-proxy

For deployments that want to shrink the backend's daemon surface
below "all of the Docker API", you can interpose a proxy that only
exposes the endpoints this app actually needs. The backend uses the
daemon for: container create, start, stop, remove, inspect, exec
create + start + resize. The split between HTTP verbs matters for
the proxy's allowlist:

- `POST` paths: `containers/create`, `containers/{id}/start`,
  `containers/{id}/stop`, `exec/create`, `exec/{id}/start`,
  `exec/{id}/resize`.
- `GET` paths: `containers/{id}/json` (called by `isAlive()`,
  `startContainer()`, `reconcile()`) and `exec/{id}/json` (called
  by `execOneShot()` to read tmux exit codes — every
  `capture-pane`, `list-sessions`, `kill-session`, `new-session
-d`, `set-option` runs through this path). Without `GET=1` the
  backend boots fine and authenticates fine, but `reconcile()`
  silently 403s at startup, every `POST /api/sessions/:id/start`
  fails when it inspects the container, and every tab attach
  fails when the tmux exec exit code can't be read.
- `DELETE` paths: `containers/{id}` (full removal at session kill).

(`DockerManager.kill()` is a method name, not a daemon endpoint —
it routes through `stop` + `remove`, so `POST /containers/{id}/kill`
is never issued.)

[`tecnativa/docker-socket-proxy`](https://github.com/Tecnativa/docker-socket-proxy)
is a small HAProxy-based filter that does exactly this. With the
ruleset below, an RCE in the backend can't pull or build images,
reach the Swarm/network/volume APIs, or touch any daemon surface
outside `/containers/*` and `/exec/*`. It **can** still create a
container — including one that bind-mounts the host rootfs
(`HostConfig.Binds`) — and inspect existing containers (which
exposes their environment variables). The proxy is blast-radius
reduction, not a privilege boundary: a determined attacker with
RCE can still escape via a new privileged container, just not via
the image/network/volume side of the API. Treat it as one layer of
defence in depth, paired with the tunnel + Access posture above.

The snippet below is a **drop-in replacement** for the project's
`docker-compose.yml`, not a `docker-compose.override.yml` overlay.
This matters because Compose merges `volumes:` lists from override
files onto the base service rather than replacing them — the base
file's `/var/run/docker.sock:/var/run/docker.sock` mount would
survive the override and an RCE would still find the live socket
file descriptor inside the container even with `DOCKER_HOST`
pointed at the proxy. Either replace `docker-compose.yml`
wholesale (the simpler path), or remove the socket mount from
the base file before layering an override.

```yaml
networks:
  # Internal-only network for the backend ↔ proxy hop. `internal:
  # true` blocks egress to the default bridge AND prevents the
  # session containers (which the backend creates on the default
  # network) from reaching the proxy: a compromised session
  # container can't issue Docker API calls through this hop to
  # inspect other sessions' env vars or spawn its own containers.
  # `expose:` alone would NOT achieve this — it gates host-level
  # publishing, not inter-container reachability on a shared
  # bridge, so the proxy port would otherwise be a flat lateral-
  # movement target.
  docker-proxy:
    internal: true

services:
  docker-socket-proxy:
    # Pin to an immutable digest in production (`image:
    # tecnativa/docker-socket-proxy@sha256:…`) so a future
    # `docker compose pull` can't silently swap the proxy out from
    # under the operator. A floating `:latest` defeats the
    # blast-radius story this whole section is selling. The
    # explicit version tag below is the minimum bar; the digest is
    # the right answer.
    image: tecnativa/docker-socket-proxy:v0.4.2
    restart: unless-stopped
    networks: [docker-proxy]
    environment:
      # Endpoints required by dockerManager.ts. The proxy enforces
      # HTTP-verb ACLs (POST/GET/DELETE) SEPARATELY from the
      # resource flags (CONTAINERS/EXEC/…), and every verb defaults
      # to 0. All four of POST/GET/DELETE + the two resource flags
      # are required; dropping any one silently breaks a different
      # part of the app:
      CONTAINERS: 1 # /containers/* — create, inspect, start, stop, remove
      EXEC: 1 # /exec/* — create + start + resize + inspect (WS attach path)
      GET: 1 # GET /containers/{id}/json (isAlive/start/reconcile)
      # and GET /exec/{id}/json (execOneShot exit-code read).
      # Without this the backend boots and authenticates fine but
      # is non-functional: reconcile silently 403s, /start fails,
      # every tab attach fails when execOneShot can't read its
      # exit code.
      POST: 1 # POST verbs (create/start/exec/resize/stop)
      DELETE: 1 # DELETE /containers/{id} for container.remove() on
      # session kill — without this the call is silently swallowed
      # by dockerManager's try/catch and stopped containers pile up
      # on the host indefinitely.
      # Default-deny everything else: IMAGES, NETWORKS, VOLUMES,
      # SERVICES, SWARM, NODES, INFO, AUTH, BUILD, COMMIT, etc.
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    # No `expose:` and no `ports:`: the internal network already
    # makes the proxy reachable to peers on `docker-proxy` and
    # unreachable to anything else, including session containers
    # the backend creates on the default Docker network.

  app:
    # Replace the direct socket mount with a network connection to
    # the proxy. The backend joins BOTH networks: `docker-proxy`
    # for the daemon hop, `default` for everything else (Cloudflare
    # Tunnel egress, the session containers it creates, etc.).
    environment:
      - DOCKER_HOST=tcp://docker-socket-proxy:2375
    depends_on:
      - docker-socket-proxy
    networks: [docker-proxy, default]
    # No /var/run/docker.sock bind mount at all: this snippet is a
    # full replacement for docker-compose.yml's `volumes:`, not
    # additive on top of it.
    volumes:
      - ${WORKSPACE_ROOT:-/var/shared-terminal/workspaces}:/var/shared-terminal/workspaces
```

Caveats:

- The backend honours `DOCKER_HOST` when it's set: with that env
  var present, the `DockerManager` constructor passes no explicit
  connection options to dockerode and lets docker-modem read the
  URL from the environment. With `DOCKER_HOST` unset it falls back
  to `/var/run/docker.sock`, so the default `docker-compose.yml`
  stack continues to work untouched. If you also bind-mount
  `/var/run/docker.sock` while `DOCKER_HOST` is set, the bind-mount
  is silently ignored — `DOCKER_HOST` wins because no `socketPath`
  is forwarded to dockerode at all in that branch. The replacement
  snippet above already drops the bind-mount; if you instead layer
  a `docker-compose.override.yml`, Compose merges `volumes:` lists
  and the base mount survives, so the live socket file descriptor
  is still inside the container even though the backend is using
  the proxy. Replace `docker-compose.yml` wholesale rather than
  overriding it so there's nothing left for an RCE to fall back to.
- Bind-mount paths the backend asks for (`<WORKSPACE_ROOT>/<id>`,
  `.uploads/<id>`) must still exist on the _host_ — the proxy
  forwards container-create requests verbatim, so the daemon
  resolves bind sources from its own filesystem.
- Pin the proxy image to an immutable digest
  (`@sha256:…`) in production. A floating `:latest` would let a
  future `docker compose pull` silently change the proxy under
  you, defeating the point of installing it. The example above
  uses an explicit version tag as the minimum bar — promote to a
  digest when you adopt this in your own deployment.
- A scoped proxy reduces blast radius. It does **not** make the
  backend safe to expose without authentication; the tunnel + Access
  posture above is still load-bearing.

## API Reference

Auth is via the httpOnly cookie `st_token` set by `POST /api/auth/login` and `POST /api/auth/register`. JS cannot read the token. CSRF for state-changing JSON routes is handled by the CORS preflight + `Content-Type: application/json` requirement.

### Auth (public)

| Method | Path               | Description                                              |
| ------ | ------------------ | -------------------------------------------------------- |
| GET    | /api/auth/status   | First-visit setup probe + current auth + admin status    |
| POST   | /api/auth/register | Create account (invite code required after first user)   |
| POST   | /api/auth/login    | Set the auth cookie                                      |
| POST   | /api/auth/logout   | Clear the auth cookie                                    |

### Sessions (cookie-authed)

| Method | Path                          | Description                                                     |
| ------ | ----------------------------- | --------------------------------------------------------------- |
| POST   | /api/sessions                 | Create session + container; accepts `body.config` (see below)   |
| GET    | /api/sessions                 | List sessions (append `?all=true` to include terminated)        |
| GET    | /api/sessions/:id             | Get session details                                             |
| DELETE | /api/sessions/:id             | Soft delete (container killed, workspace kept, row→terminated)  |
| DELETE | /api/sessions/:id?hard=true   | Hard delete (also purge workspace dir + drop the D1 row)        |
| POST   | /api/sessions/:id/stop        | Stop container (workspace preserved)                            |
| POST   | /api/sessions/:id/start       | Restart or respawn stopped container                            |
| PATCH  | /api/sessions/:id/env         | Update environment variables                                    |
| GET    | /api/sessions/:id/tabs        | List tmux tabs for a session                                    |
| POST   | /api/sessions/:id/tabs        | Create a tab                                                    |
| DELETE | /api/sessions/:id/tabs/:tabId | Delete a tab                                                    |
| POST   | /api/sessions/:id/files       | Multipart file upload into the per-session uploads dir          |

`POST /api/sessions` accepts a typed `body.config` mirroring `SessionConfigSchema` in `backend/src/sessionConfig.ts`: `envVars` (typed entries with `plain` / `secret` discriminator), `repo` + `auth`, `ports[]` + `allowPrivilegedPorts`, `gitIdentity`, `dotfiles`, `agentSeed`, `postCreateCmd`, `postStartCmd`, `cpuLimit`, `memLimit`, `idleTtlSeconds`. Every field is optional; a bare `POST` (no `config`) creates a default session.

### Templates (cookie-authed)

| Method | Path                | Description                                                  |
| ------ | ------------------- | ------------------------------------------------------------ |
| POST   | /api/templates      | Create a template (config must be secret-stripped — see CLAUDE.md) |
| GET    | /api/templates      | List the user's templates (summary shape, no config)         |
| GET    | /api/templates/:id  | Get a template (full config)                                 |
| PUT    | /api/templates/:id  | Update name / description / config (owner-gated)             |
| DELETE | /api/templates/:id  | Delete a template (owner-gated)                              |

### Invites (admin)

| Method | Path                | Description                                                  |
| ------ | ------------------- | ------------------------------------------------------------ |
| POST   | /api/invites        | Mint a single-use invite code                                |
| GET    | /api/invites        | List invite codes (admin sees all rows, not just their own)  |
| DELETE | /api/invites/:code  | Revoke an unused invite code                                 |

### WebSocket

Two channels, both cookie-authed (browser sends `st_token` automatically on the upgrade handshake to the cookie's domain). CSWSH defence is independent: `isAllowedWsOrigin` rejects unlisted origins before the handshake completes.

```
wss://host/ws/sessions/<sessionId>?tab=<tabId>     # terminal attach
wss://host/ws/bootstrap/<sessionId>                # bootstrap pipeline live-tail
```

**Terminal — Client → Server:** `input`, `resize`
**Terminal — Server → Client:** `output`, `status`, `error`
**Bootstrap — Server → Client:** `output`, `done`, `fail`, `error`

### Port-exposure dispatcher

When `PORT_PROXY_BASE_DOMAIN` is set, requests to `https://p<containerPort>-<sessionId>.<base>` are diverted from the API/WS routes to the per-session reverse proxy (see CLAUDE.md → "Port-exposure dispatcher"). Auth gate: `public: false` ports require the `st_token` cookie owned by the session's owner; `public: true` ports skip auth (webhook / OAuth-callback shape).

## Session Container

Each session runs in a Docker container based on `session-image/Dockerfile`:

- **OS:** Ubuntu 24.04
- **Dev tools:** git, curl, build-essential, python3, Node.js 22, vim, nano, htop, jq
- **Claude CLI:** `@anthropic-ai/claude-code` (globally installed; aliased to `claude --dangerously-skip-permissions` in interactive shells. The container sandbox prevents host compromise / privilege escalation, but **does not protect workspace files from in-session destructive actions** — Claude can run `rm -rf ~/workspace/…` or overwrite a tracked file without asking. Bypass the alias with `\claude` or `command claude` for one call, `unalias claude` for the rest of the shell.)
- **VS Code CLI:** `code` (standalone) — see [Connecting from VS Code](#connecting-from-vs-code) below
- **GitHub CLI:** `gh` (standalone) — auth once with `gh auth login`, then drive PRs / issues / `gh api …` from the session
- **Terminal:** tmux with a session named `main`, 50k scrollback, mouse support
- **User:** `developer` (UID 1000, unprivileged — no sudo, all Linux capabilities dropped, `no-new-privileges` set)
- **Workspace:** `/home/developer/workspace` (bind-mounted from `<WORKSPACE_ROOT>/<sessionId>` on the host)
- **Resources:** Per-session caps come from `session_configs` (`cpu_limit` 0.25–8 cores, `mem_limit` 256 MiB–16 GiB, `idle_ttl_seconds` 60s–24h). Sessions created without explicit caps fall back to the `DEFAULT_NANO_CPUS` (2 cores) / `DEFAULT_MEMORY_BYTES` (2 GiB) constants in `dockerManager.ts`. Idle auto-stop is opt-in (omit `idleTtlSeconds` to disable).

## Connecting from VS Code

The session image ships the standalone Microsoft VS Code CLI, so any session
can be opened in desktop VS Code (or `vscode.dev`) without SSH, port-forwards,
or extra ingress on the home server. The tunnel goes outbound to Microsoft and
auth is handled through your GitHub or Microsoft account.

**From inside the browser terminal of a session:**

```bash
# First time only — register this container as a tunnel host.
# It prints a short device-code URL; paste it on your Mac and sign in
# with the same GitHub/Microsoft account you'll connect from.
code tunnel

# Subsequent runs in the same container can skip the prompt:
#   code tunnel --accept-server-license-terms --name <session-name>
```

`code tunnel` keeps running in the foreground, so leave it in its own tmux
tab. The CLI's auth state is stored under `~/.vscode-cli/`, which the
session entrypoint symlinks into `~/workspace/.vscode-cli/` — that path is
bind-mounted from the host, so the device-login token survives container
restarts (soft-delete + restart, host reboot triggering reconcile, etc.).
After a restart you only need to re-launch `code tunnel`; it picks the
existing registration up automatically. The state is purged on a hard
delete, same as the rest of the workspace.

**On your Mac:**

1. Install the [Remote - Tunnels](https://marketplace.visualstudio.com/items?itemName=ms-vscode.remote-server)
   extension in VS Code.
2. Open the Command Palette → **Remote-Tunnels: Connect to Tunnel…** and pick
   the session you just registered. The workspace at
   `/home/developer/workspace` is the one bind-mounted from the host, so
   anything you save there is persisted across container restarts.

> The tunnel binary is per-arch — the Dockerfile picks `cli-linux-x64` or
> `cli-linux-arm64` automatically based on Buildx `TARGETARCH`, so it works
> on both Intel servers and Apple Silicon hosts running the image natively.
> (We use the glibc `cli-linux-*` builds rather than the musl `cli-alpine-*`
> ones because the base image is `ubuntu:24.04`.)
>
> The default build is reproducible and verified out of the box — the CLI
> version is pinned to a specific commit and the per-arch SHA-256 of each
> tarball is checked with `sha256sum -c` before extraction. There is no
> "skip the hash check" path; an empty SHA fails the build. To bump the
> pin (or override for a CVE patch), update the three `ARG VSCODE_CLI_*`
> defaults in `session-image/Dockerfile` together, or pass them on the
> command line:
>
> ```bash
> docker build \
>   --build-arg VSCODE_CLI_VERSION=commit:<sha> \
>   --build-arg VSCODE_CLI_SHA256_AMD64=<x64 sha256 of the .tar.gz> \
>   --build-arg VSCODE_CLI_SHA256_ARM64=<arm64 sha256 of the .tar.gz> \
>   -t shared-terminal-session ./session-image
> ```

## Tech Stack

| Layer      | Technology                                         |
| ---------- | -------------------------------------------------- |
| Frontend   | TypeScript, Vite, xterm.js                         |
| Backend    | TypeScript, Node.js, Express, ws                   |
| Auth       | JWT (jsonwebtoken), bcryptjs                       |
| Database   | Cloudflare D1 (accessed via HTTP)                  |
| Containers | Docker (dockerode), tmux                           |
| Tunnel     | Cloudflare Tunnel                                  |
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

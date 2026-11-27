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
docker build -t shared-terminal-session ./session-image   # first install only: no session exists yet
```

On a host that already has sessions, **never** run that line: use
`scripts/build-session-image.sh` (or `cd backend && npm run docker:build-session`),
which gates on `images:pins` before the build and again right before moving
the tag (see "Session image pins" below).

### Session image pins (incident 2026-11-03, `backend/src/imagePins.ts`)

On Docker 29 with the containerd image store, moving a tag (a rebuild of
`shared-terminal-session`) removes the image it left **at once, even while
containers run on it**. Every image a session container uses therefore carries
`shared-terminal-session-pin:<64-hex image id>`:

- **Creates are protected or do not happen.** `spawn` resolves the tag to an
  immutable id once, pins and verifies that id, and creates the container
  from the id (never the tag); afterwards it checks the container runs exactly
  that id and the pin still names it — else the never-started container is
  removed. A pin that cannot be established (the image vanished between
  resolve and pin, a daemon error, a pin that does not land) fails the spawn:
  **no container is created**.
- **Boot pass** (each backend start): pins the image of every session
  container that still exists — running or stopped — and logs the gate: each exception used, each unused exception, and every
  NEW missing image as an error. Idempotent: the pin name is derived from the
  id.
- **The gate** — `docker compose exec app npm run images:pins` — exits 0 (GO)
  only when protection is on, the exceptions file is valid, and every session
  container's image is pinned or excepted by its exact pair. Anything else is
  NO-GO (exit 1). Run it before any rebuild, prune or deploy.
- **Historical exceptions**: images already lost before this protection
  existed cannot be pinned. List each as an exact pair in
  `<WORKSPACE_ROOT>/.st-image-pins/exceptions.json` (override:
  `SESSION_IMAGE_PIN_EXCEPTIONS`). The directory and file must be root-owned
  and not group/world-writable (`install -d -m 755 -o root -g root`, file
  `0644 root:root`); they sit outside every session's mounts. Format (strict:
  exactly these keys, full ids, no wildcards, no duplicates):

  ```json
  {"version": 1, "exceptions": [
    {"containerId": "<64 hex>", "imageId": "sha256:<64 hex>", "name": "st-…",
     "reason": "…", "incident": "2026-11-03 containerd rebuild",
     "approvedBy": "…", "approvedAt": "2026-11-04T…Z"}
  ]}
  ```

  A missing image of a container NOT listed by its exact pair — a new loss,
  or a new container on an old lost image — keeps the gate NO-GO. An
  unreadable, malformed or unprotected file makes the gate NO-GO (never "no
  exceptions"). Nothing ever removes an exception, a tag or an image
  automatically; unused exceptions are reported for the operator to review.
- **`SESSION_IMAGE_PINS=off`** (kill switch): creates still use the resolved
  immutable id, without a pin; every create and every boot logs that images
  are UNPROTECTED, and the gate is **NO-GO** for as long as it is off.
- **Cleanup**: `images:pins -- prune` (dry run) lists pins no container
  uses. **Removal is disabled in this version** (`prune --write` exits 2
  whatever the flags): a spawn pins before it creates, so a fresh pin has no
  container yet, and a separate process cannot prove the backend is not
  creating. Orphan pins only cost disk; cleanup is postponed until removal
  can exclude creates (the library already re-reads the tag's target and
  the containers right before each untag).
- **Not protectable from here**: a hand-typed `docker build -t
  shared-terminal-session`, `docker tag` onto that name, `docker rmi -f` of a
  pin, `docker image prune -a` of an image no container uses, another tool's
  build, and an image lost before its first pin. The project's own build paths
  go through the gate: `scripts/build-session-image.sh`, `npm run
  docker:build-session` (calls it), and `docker compose build session-image`
  (produces only `shared-terminal-session:candidate`, never used by the
  backend; build with the script instead).
- **Docker API needs**: spawns call the images API
  (inspect + tag) before every create; with the docker-socket-proxy shape
  (SECURITY.md) the proxy must grant `IMAGES: 1`, or every create fails.
  The `images:pins` CLI honours `DOCKER_HOST` like the backend.

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

# Build the session image.
#  - FIRST install (no session exists yet):
docker build -t shared-terminal-session ./session-image
#  - Any later rebuild (sessions exist): NEVER the line above — it is the
#    2026-11-03 incident's mechanism. Use the gated script, with the backend
#    running (it asks it for the images:pins gate):
#      scripts/build-session-image.sh
#  (`docker compose build session-image` only produces
#   shared-terminal-session:candidate, which the backend never uses.)

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
>
> End-to-end verification of the live proxy path against a real Docker daemon is
> tracked in [#290](https://github.com/gatof81/shared-terminal/issues/290).

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
> `icc=false` plus a network policy). Hardening for a multi-tenant story is out
> of scope for this version and tracked in
> [#291](https://github.com/gatof81/shared-terminal/issues/291).

> **Note:** the `session-image` service lives behind a `build` compose profile so
> it is only built on demand and never runs as a long-lived container. `app` does
> not depend on it at runtime — it just needs the `shared-terminal-session` image
> to exist in Docker's image store before creating sessions.

> **Claude CLI state persistence (upgrade note).** The session image now
> symlinks `~/.claude` and `~/.claude.json` into the workspace bind mount, so
> Claude login, `--resume`/`--continue` transcripts, and agent-seeded
> settings survive container recreation. Existing sessions adopt this on
> their next **recreate** (`POST /sessions/:id/start` respawns from the
> rebuilt image) — a plain container stop+start keeps running the old
> entrypoint baked into the old image. Claude state that lived in the old
> container's layer is lost in that one recreate (it always was — that's the
> bug this fixes), so expect a one-time `claude` re-login per session after
> the upgrade. The state lives under `<workspace>/.st/` (a self-gitignored
> dir) — the first image generation targeted `<workspace>/.claude{,.json}`
> directly, which collided with a cloned repo's project-level `.claude/`
> config dir (#377); workspaces that picked up that interim layout are
> migrated to `.st/` automatically on their next recreate. Security
> implications of transcripts living on the host are covered in
> [docs/SECURITY.md → Claude CLI state at
> rest](./SECURITY.md#claude-cli-state-at-rest).

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
  - Login, transcripts (`--resume`/`--continue`), and settings persist in the workspace across container recreation — see [SECURITY.md → Claude CLI state at rest](./SECURITY.md#claude-cli-state-at-rest)
- **VS Code CLI:** `code` (standalone) — see [REMOTE-EDITING.md](./REMOTE-EDITING.md)
- **GitHub CLI:** `gh` (standalone) — auth once with `gh auth login`, then drive PRs / issues / `gh api …` from the session
- **Terminal:** tmux, 50k scrollback, mouse support. No tmux session exists at container boot (PID 1 is a plain `tail -f /dev/null`) — each browser tab provisions its own tmux session on demand via `tmux new-session -A -s <tabId>` at WS attach
- **User:** `developer` (UID 1000, unprivileged — no sudo, all Linux capabilities dropped, `no-new-privileges` set)
- **Workspace:** `/home/developer/workspace` (bind-mounted from `<WORKSPACE_ROOT>/<sessionId>` on the host)
- **ACP agent sessions** (experimental): the same image; the agent runtime (runner + pinned adapter) is not in it but mounted read-only at `/opt/st-acp` from `<WORKSPACE_ROOT>/.acp-runtime` — see [ACP_AGENTS.md](./ACP_AGENTS.md#2-runtime-independent-of-the-image)
- **Resources:** Per-session caps come from `session_configs` (`cpu_limit` 0.25–8 cores, `mem_limit` 256 MiB–16 GiB, `idle_ttl_seconds` 60s–24h). Sessions created without explicit caps fall back to the `DEFAULT_NANO_CPUS` (2 cores) / `DEFAULT_MEMORY_BYTES` (2 GiB) constants in `dockerManager.ts`. Idle auto-stop is opt-in (omit `idleTtlSeconds` to disable).

## Applying a new image to a session

A session container keeps the image it was created from: a plain stop + start
reuses it. To put an existing session on a newly built image (after
`scripts/build-session-image.sh`), re-create its container with a **soft
delete** followed by a start:

1. `DELETE /api/sessions/<sessionId>` (no `?hard=true`): the container is
   killed and the row becomes `terminated`; the workspace, uploads and
   `session_configs` are untouched.
2. `POST /api/sessions/<sessionId>/start`: the backend spawns a new container
   from the current image, with the session's stored config, env and ports.
   `postStart` runs; `postCreate` and the rest of the bootstrap don't.
3. **Verify:** `docker inspect st-… --format '{{.Image}}'` shows the new image
   id.

**Kept:** everything under the workspace, including the HOME state symlinked
into it (Claude CLI state, `~/.ssh`, `~/.npm-global`); the uploads; the D1 row
and config.

**Lost — everything that lived only in the container layer:**
- the **git identity** (`~/.gitconfig`). The bootstrap writes it only at
  create, and a start doesn't re-run it;
- whatever **dotfiles** installed outside the workspace. The dotfiles stage
  also runs only at create;
- packages installed with `apt` or anywhere else outside the workspace;
- `~/.bash_history` and every other file in HOME that isn't symlinked into
  the workspace;
- `/tmp`, running processes and the tmux tabs.

## Retired: conversation capture and container recreation

Conversation capture (Claude Code hook events relayed from session containers
to the backend, the read-only capture Chat) and the administrative container
recreation were removed, with their routes, CLIs (`conversation:*`,
`recreate:*`) and variables (`CONVERSATION_*`, `INGEST_*`, `RECREATE_*`; remove
them from `.env`). Nothing of their data is deleted: `<WORKSPACE_ROOT>/.conversations/`,
`<WORKSPACE_ROOT>/.st-control/` and the D1 tables/columns (`claude_conversations`,
`conversation_user_meta`, `sessions.ingest_token_hash*`, `conversation_requested`,
`revocation_seq`, `recreate_fence`) stay as inert data that nothing reads.
A hard delete removes the session's `.conversations/<sid>`, `.st-control/<sid>`
and `.claude-managed/<sid>` along with its workspace. On boot the backend logs
a read-only warning for any `.st-control/*/recreate-attempt.json` that is not
resolved; it acts on none of them.

Containers created from an older image still run the in-container relay. It
is harmless: it answers the CLI with 204 at once, its queue and logs are
bounded, and what it forwards gets a 404 and is never retried. A container
created from a rebuilt image has no relay.

## Release gate: a migration against the real data, on the host

Before deploying a release that adds a migration, prove it on a copy of
production's rows without them leaving the host and without touching D1:

1. `docker compose exec app npm run backup` (the running backend, still at
   the previous schema) — a directory `<WORKSPACE_ROOT>/.backups/<timestamp>/`.
2. Build the release image under its own tag, from the release checkout, so
   the running `app` is not touched:
   `docker build -t st-backend:migrate-check .`
3. Run the check in a throwaway container with no network, the backup
   mounted read-only and no environment file — only `NODE_ENV=production`,
   which the logger needs: without it it asks for the dev transport
   (`pino-pretty`), which the production image does not carry, and the
   check refuses with `unexpected Error` (seen on the 2026-11-13 release):

   ```bash
   docker run --rm --network none -e NODE_ENV=production \
     -v <WORKSPACE_ROOT>/.backups/<timestamp>:/backup:ro \
     st-backend:migrate-check npm run -s db:migrate-check -- /backup
   ```

It builds an in-memory SQLite at the backup's schema through the real
`migrateDb()` ledger path, loads every table as `restore` would, applies the
pending migrations and prints, per table, the row count and a SHA-256 of the
pre-existing columns before → after, the ledger (every pending migration
recorded), `foreign_key_check` and `integrity_check`. The last line is
`PASS` (exit 0) or `FAIL` (exit 1, with the reasons); a refusal (no
manifest, a backup already at the current schema) exits 2. It
prints counts, hashes and verdicts only — never a row or a value — needs no
credential (it drops the D1 variables before loading anything and never
calls `validateD1Config`), and makes no network call. Delete the image
afterwards if you like (`docker rmi st-backend:migrate-check`).

## Projects (`docs/PROJECTS.md`)

Always on. A project only groups ACP agents and gives them topics (conversations). The legacy tables of the retired P3a directory and D1–D3
conversation (`project_agents`, `agent_bindings`, `project_agent_creations`) and the
`<WORKSPACE_ROOT>/.projects` directory are no longer read or written. Leave them in place: removing
them is a separate, owner-approved data step (a later migration), after a fresh backup is on the
NAS. New backups do not carry `.projects`. Restoring an older backup prints where its
`projects/<pid>.tar.gz` are and does not restore them.

## ACP agents (`docs/ACP_AGENTS.md`)

Always on. `docker-compose.yml` forwards the `ACP_*` variables with their defaults. Migrations
v21–v29 (agents, messages, questions, effort, slots, chains, works, conversations, read indexes,
tasks) are additive and run at boot.

The backend:

- mounts `/api/acp` and `/ws/acp`;
- copies the runner files into `<WORKSPACE_ROOT>/.acp-runtime/st` at boot;
- mounts that directory read-only into agent sessions;
- supervises one runner loop per slot of each running agent.

Adapters are installed per version into the same directory with `acp-runtime/install.sh`, with no
session-image rebuild. Runners reach the backend over `SESSIONS_NETWORK` at `ACP_BACKEND_URL` (default
`http://st-backend:<PORT>`).

- **Setup** (variables, adapter install, login): [ACP_AGENTS.md → Setup](./ACP_AGENTS.md#8-setup).
- **Recovery behaviour:** [→ Operation](./ACP_AGENTS.md#9-operation-and-recovery).
- **Backups:** `npm run backup` includes the three tables, and the workspaces include each runner's
  state.
- **Stopping an agent:** stop its session; nothing of it runs while the container is down.

## Backup & restore (#240)

Operator-level, host-shell only (deliberately not API surface — a dump
carries every credential hash and secret ciphertext). Both run inside the
backend container so they see the same env (D1 credentials,
`WORKSPACE_ROOT`, `SECRETS_ENCRYPTION_KEY`) the server runs with:

```bash
# Backup → <WORKSPACE_ROOT>/.backups/<timestamp>/ (default), or name a dir:
docker compose exec app npm run backup
docker compose exec app npm run backup -- /var/shared-terminal/workspaces/.backups/pre-migration

# Restore into the CURRENT env's D1 + WORKSPACE_ROOT:
docker compose exec app npm run restore -- <backupDir>
docker compose exec app npm run restore -- <backupDir> --force   # non-empty target
```

A backup made before 2026-11-18 may hold the retired project conversations (`manifest.projects`,
`projects/<pid>.tar.gz`). Restore does not restore them: nothing reads them any more. It prints where
they are, as plain `.tar.gz` of `.projects/<pid>`, for anyone who wants to inspect them by hand.

The backup's own files are checked the same way, before the first write: a
workspace tarball that is missing, truncated, not named after a session of the
manifest, holding paths outside that session, holding a hard link to anything
but an earlier file of that session's own content in the same tarball, or not the size and entry count the
manifest recorded for it (an older copy under the same name), and a table dump that is not
valid JSONL or does not have the rows the manifest counted (cut short, or
missing), each stop the restore with nothing restored. What only the
destination can tell (a non-empty D1 without `--force`, a
`SECRETS_ENCRYPTION_KEY` that does not decrypt the backup) is still decided
after D1 was migrated to the current schema, and before any row is inserted.

**Who can read a backup (#562).** A dump holds password and token hashes,
secret ciphertext, conversation titles and every workspace, including a
`.env` written by `writeEnvFile`. `npm run backup` therefore never creates
anything readable by "others". The backup directory is closed before
anything is written into it, and every directory and file is then given:

| `BACKUP_GROUP_GID` | Directories | Files | Who reads them |
| --- | --- | --- | --- |
| unset (default) | 0700 | 0600 | root only. The off-host copy must run as root |
| a numeric GID | 0750 | 0640, group = that GID | root and that group, e.g. a dedicated `st-backup` group that the mirror's user belongs to |

The group mode applies to **daily** backups only: a directory whose name
starts with `20`, the glob the nightly cron rotates and mirrors (`npm run
backup`'s default name is an ISO time, so it matches). A backup written
anywhere else (`npm run backup -- /path/pre-<sha>`, `st-control-*`, …) is made
for one operation, is not mirrored, and is always 0700/0600, whatever
`BACKUP_GROUP_GID` says.

A malformed value refuses the backup before anything is written.
`<WORKSPACE_ROOT>/.backups` itself is set only when the backup creates it, and
then to the daily mode (0750 in the group when `BACKUP_GROUP_GID` is set),
whatever the first backup's name: it is the dailies' container, and the
mirror has to go through it.

- **Gate before deploying this change (#562).** Don't deploy it until these
  hold, or the nightly off-host copy fails on the first new backup:
  1. Decide who the copy runs as. If it runs as **root**, the default
     (`BACKUP_GROUP_GID` unset) is enough; go to step 4.
  2. On the host, create a dedicated group and add the copy's user to it
     (`groupadd st-backup`; `usermod -aG st-backup <user>`). Note the
     numeric GID (`getent group st-backup`). This comes **before** the first
     backup with the GID: a 0640 daily the copy can't read makes `rsync`
     exit 23, and rsync then skips `--delete` too.
  3. Set `BACKUP_GROUP_GID=<gid>` in `.env` and **recreate** the app container
     (`docker compose up -d --no-deps --force-recreate app`). The variable is
     a compose `environment:` entry, so `docker compose exec app npm run
     backup` only sees it after the recreate. Check it with
     `docker compose exec app printenv BACKUP_GROUP_GID`.
  4. Run one backup by hand, then the copy **as its user**, and check that it
     reads every file. Do this before the next nightly run. Test the copy
     **without** the cron's retention and **without** `--delete`: run its
     `rsync` line yourself, limited to the new backup and with `--delete`
     removed, rather than the whole cron script. A first run of the full
     script would rotate (`KEEP`) and delete on the destination before you
     know the copy works.

  A backup that finds `.backups` readable by others while
  `BACKUP_GROUP_GID` is unset logs a `WARN`: that combination means a copy
  probably relied on the old world-readable modes.
- **Existing backups** keep their old modes until
  `docker compose exec app npm run backup:harden` brings them in line.
  - Without `-- --write` it is a **dry run** that only lists what would change,
    in two groups:
    - **daily**: `.backups` itself and every `20*` tree. They get the mode
      above, and the group when `BACKUP_GROUP_GID` is set;
    - **private**: everything else at the top of `.backups` (`pre-*`,
      `st-control-*`, `quarantine-*`, loose files). They get 0700/0600, and
      their group is left alone.
  - It **only narrows**: each entry ends at its current mode intersected with
    its group's mode, so it never adds a bit. A 0700/0600 backup stays
    0700/0600, and a 0644 file inside a private backup becomes 0600, not 0640.
  - A daily entry that the group still can't read after the pass (because
    someone made it stricter by hand) is listed as `group can't read …` and
    the command exits 2. Opening it is the operator's decision, by hand.
  - With `-- --write` it applies what the dry run listed.
  - It only runs on a directory named `.backups` that is not itself a backup
    (no `manifest.json` in it): the classes come from the names directly under
    `.backups`, so pointed at one backup it would classify that backup's own
    files.
  - It never follows a symlink, and it refuses a root that is one, that is not
    owned by the user running it, or that others can write to.
  - It does not enter a directory that someone else owns, that others can
    write to, or that is on another filesystem: such a directory could be
    swapped for a link while the walk is inside it. Those directories are
    listed and left untouched, contents included.
- **The off-host copy** keeps its own permissions:
  - `rsync -a` (or `-p`) carries the modes;
  - to set the destination's modes yourself, use `--perms --chmod=D0700,F0600`.
    `--chmod` **without** `--perms` only applies to files rsync creates: it
    leaves the files already on the destination as they are;
  - on a CIFS mount, the mount's `file_mode`/`dir_mode`/`uid`/`gid` options
    decide instead;
  - check the NAS side separately: its share's ACLs decide who can read it there.
- **Restore** runs as root, so it reads both modes.

A backup dir holds one `<table>.jsonl` per table (deterministic order —
two backups of identical data are diffable), `workspaces/<sid>.tar.gz`
(workspace + uploads dir, gzip because the image already ships it), and
`manifest.json` written last — restore refuses a dir without it, so an
interrupted backup can't be replayed by accident.

A table created by a migration newer than the source D1's schema (e.g.
`claude_conversations`, v16, when backing up a pre-Phase-3 deployment
before upgrading) is skipped and absent from `tables`; restore treats it
as empty. At or past that version a missing table fails the backup.

**Web Push subscriptions (#560).** `push_subscriptions` is backed up
from v14 on. Backups taken before #560 do not have it: restore logs
`no push_subscriptions.jsonl although the backup is schema vN`, and every
browser has to subscribe again, as before.

What a row is worth to someone who reads the backup:
- **Outside the deployment, nothing that pushes.** The frontend always
  subscribes with this deployment's `applicationServerKey`, and push
  services only accept a message signed with `VAPID_PRIVATE_KEY`. That key
  lives in `.env` and never in a backup; the manifest records only the
  public key (`vapidPublicKey`).
- **Inside the deployment, the endpoint is the subscription's identity.**
  `POST /api/push/subscribe` re-assigns an existing endpoint to the caller.
  The DELETE is owner-scoped since #566. So someone who can read a backup **and**
  has an account can point another user's browser at their own notifications,
  which also takes the row away from that user. They never receive the other
  user's notifications. See
  [SECURITY.md → Web Push endpoints](./SECURITY.md#web-push-endpoints-566).
- This is the reason to protect backups (#562), on top of what they already
  carry: password hashes, ciphertext, workspaces and `.env` files written by
  `writeEnvFile`.

**The subscriptions only work on a target with the same VAPID keypair.**
Restore still restores the rows, but warns when the target's key differs
(push services answer 403, which is not a "gone" status, so nothing prunes
the rows) or is unset (nothing is sent). Two ways out:
- install the source's `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`; or
- clear the rows (`DELETE FROM push_subscriptions` on the D1, or only the
  rows created before the restore) and have each user turn notifications
  **off and then on**. Turning them on while the browser still holds a
  subscription for the old key fails, and `GET /api/push/status` keeps
  answering `subscribed: true` while a row exists.

A backup taken while push was not configured records no key; its rows are
restored without the warning.

On `--force`, `push_subscriptions` is replayed with `ON CONFLICT DO
NOTHING`, unlike the other tables: when the target has a newer row for the
same endpoint (a browser that switched accounts), the target's row wins,
and the log line counts it (`N kept from the target`). A malformed row
still fails the restore.

**File permissions.** `push_subscriptions.jsonl` gets the same modes as every
other file in the backup: 0640 in the `BACKUP_GROUP_GID` group in a daily
`20*` backup, 0600 everywhere else (see "Who can read a backup (#562)" above).

Restore guards:

- **Non-empty target** (any `users`/`sessions` rows) refuses without
  `--force`. Replays use `INSERT OR REPLACE` (`ON CONFLICT DO
  NOTHING` for `push_subscriptions`, see above), so a `--force` re-run over a
  partial restore converges.
- **`SECRETS_ENCRYPTION_KEY` mismatch aborts before any write** and has
  NO `--force` override — a wrong key silently corrupts every secret with
  no rotation path (see docs/SECRETS_ENCRYPTION_KEY.md). The check is one
  decrypt round-trip on a sample blob from the dump; the key must travel
  to the destination separately from the backup itself.
- Workspace tarballs are entry-checked before extraction (paths must stay
  under `<sid>/`, `.uploads/<sid>/`, `.conversations/<sid>/` or
  `.st-control/<sid>/` — no traversal).
- **Control data is never extracted live.** The tarball may carry the
  session's `.st-control/<sid>/` and `.conversations/<sid>/REVOKED` /
  `LIFTED` — inert data of the retired conversation capture and recreation.
  Restore keeps them out of the live extraction, stages them under
  `<WORKSPACE_ROOT>/.restore-evidence/<backup>-<random>/` (0700, never read
  by the backend; remove it by hand when no longer needed) and installs
  nothing of them. Old and new backups are both accepted.
- **Tampered backups.** Every `workspaces/<name>.tar.gz` must be named
  after a session listed in that backup's manifest (refused before any
  write otherwise); a session's root dirs must be directories, and nothing
  under `.conversations/<sid>/` or `.st-control/<sid>/` may be a link.
- **`REVOKED_ALL`.** `.conversations/REVOKED_ALL`, when present, is copied
  to `<backup>/REVOKED_ALL` (`globalRevocation: true` in the manifest) as
  inert data; restore leaves it in the backup dir.
- Member names must be canonical (`<sid>//`, `<sid>/./`, `./<sid>` are
  refused): tar treats them as the same path, the type rules would not.

Previously-`running` sessions land as `stopped` with a NULL container id
— the destination host has none of the source's containers, matching what
`reconcile()` would conclude. Start them from the UI after restore.
Running sessions are not quiesced during backup; for a coherent snapshot
of an active deployment, stop sessions first (workspaces of stopped
sessions are always consistent).

**Backing up with live sessions.** A running session (Claude Code rewriting
`~/.claude/…`, a build writing files) makes tar report `file changed as we
read it`, `File removed before we read it` or `File shrank by N bytes;
padding with zeros` and exit 1. The backup tolerates exactly that, and
nothing else:

- tar exit 1 is accepted only when **every** stderr line is one of those
  three diagnostics; any other line (e.g. `Cannot open: Permission
  denied`), exit 2, a signal, or exit 1 with no recognised line fails the
  run with no `manifest.json`;
- every tarball is then read back end to end (`tar -tzf`: gzip CRC + all
  headers) before the manifest is written — a damaged archive fails the
  run;
- the affected workspace gets `concurrentChanges: {count, paths, truncated}`
  in `manifest.json` (first 100 paths, each `changed`/`removed`/`shrank`)
  and the run logs a `[backup] workspace <sid>: N file(s) changed while
  being archived` warning.

What that backup is: a complete, restorable archive of every workspace, in
which the listed files may hold a mix of old and new content, a
zero-padded tail (`shrank`), or be missing (`removed`); files not listed
are as of the moment tar read them, and different workspaces and the D1
rows are not from the same instant. It is a recovery point, not a
consistent snapshot. Check the manifest:

```bash
python3 -c 'import json,sys; m=json.load(open(sys.argv[1]));
[print(s, w["concurrentChanges"]["count"]) for s,w in m["workspaces"].items() if "concurrentChanges" in w]' \
  <backupDir>/manifest.json
```

If a listed path matters (a database file, a repo's `.git/index`), stop
that session and take another backup.

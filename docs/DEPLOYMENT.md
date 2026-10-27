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
- **Resources:** Per-session caps come from `session_configs` (`cpu_limit` 0.25–8 cores, `mem_limit` 256 MiB–16 GiB, `idle_ttl_seconds` 60s–24h). Sessions created without explicit caps fall back to the `DEFAULT_NANO_CPUS` (2 cores) / `DEFAULT_MEMORY_BYTES` (2 GiB) constants in `dockerManager.ts`. Idle auto-stop is opt-in (omit `idleTtlSeconds` to disable).

## Conversation capture (Phase 3, `docs/CONVERSATION.md`)

The backend can receive Claude Code hook events from session containers
and persist them as a per-conversation event log on the host
(`<WORKSPACE_ROOT>/.conversations/<sessionId>/<claudeSessionId>.events.jsonl`).
3.0b ships the receiver and 3.0c the session-image side (an empty
managed-settings directory, the SessionStart script, the loopback relay
the hooks post to, the `st-backend` alias; see
[session-image/README.md](../session-image/README.md#conversation-hooks-managed-settings)).
3.0d adds the per-session activation surface (admin only,
[CONVERSATION.md §7](./CONVERSATION.md#7-comando-y-endpoint-de-activación-30d)):
`PATCH /api/admin/sessions/:id/conversation {enabled}`, the recreation
endpoints below, the `CONVERSATION_ALLOW_USERS` allowlist and a
`conversation` block in `GET /api/admin/stats`. With `CONVERSATION_ENABLED`
unset, nothing is mounted or injected and no session emits anything.

| Variable | Default | Effect |
| --- | --- | --- |
| `CONVERSATION_ENABLED` | unset (`false`) | Master switch. Off: `POST /ingest/claude/hook` answers 204 and discards (`ingest_rejected{disabled}`), no session gets a hooks file, an ingest token or the extra read-only bind mount, and boot `reconcile` deletes any stale `.claude-managed/*/conversation.json`. On: capture is still **per-session opt-in** (`sessions.conversation_requested`). |
| `CONVERSATION_ALLOW_USERS` | unset | Comma-separated user ids whose **new** sessions are born with capture requested (`conversation_requested=1`); the owner decides, also for an admin create on behalf of someone. Existing sessions are never touched. Requested is not effective: the flag, no revocation and an image with the relay still apply. Entries that are not user ids are ignored with a warning. |
| `PORT` | `3001` | Passed to capturing session containers as `ST_BACKEND_PORT`: the relay forwards to `http://st-backend:<PORT>/ingest/claude/hook`. The hooks file itself always targets the relay, `http://127.0.0.1:47613/ingest/claude/hook`. |

Host-side directories (both outside the workspace bind mount, next to
`.uploads`):

- `.conversations/<sessionId>/` — event logs, index snapshots and the
  per-session revocation marker `REVOKED`; `.conversations/REVOKED_ALL` is
  the global marker. Soft delete keeps them, `?hard=true` purges them,
  `npm run backup` includes them in the per-session tarball.
- `.claude-managed/<sessionId>/conversation.json` — the managed-settings
  hooks file, mounted read-only at `/etc/claude-code/managed-settings.d/`
  **only** when the session is requested and the flag is on. Not backed up:
  `reconcile` regenerates it from D1.

Requested vs effective (CONVERSATION.md §2.4): a container's env is
immutable, so capture (token, mount, relay) is decided when the container
is **created**. `POST /start` and a stop + start **reuse** a container
that still exists — same image, env and mounts (§2.4.1) — so they do not
apply a newly requested capture, a new image or a token rotation; only a
re-created container does (see [Recreating a session
container](#recreating-a-session-container)). Making enable effective is
an entry requirement of 3.0d. `GET /api/sessions/:id/conversations`
reports `capture.{requested,effective,effectiveAfterRestart}` so nobody
is promised capture that is not happening.

Both variables are forwarded by `docker-compose.yml` with empty defaults
(before 3.0d `CONVERSATION_ENABLED` was not, so setting it in `.env` did
nothing under compose).

Admin surface (`requireAdmin`; the writes also go through `adminActionIp`):

- `PATCH /api/admin/sessions/:id/conversation {"enabled": true|false}` applies
  the §2.4 row and answers `{ enabled, capture }` (`capture` as in
  `GET …/conversations`). Enable writes only on a running container with
  full authorization: the marker, then — once the relay identified itself
  within 5 s — the hooks file; on a stopped one it writes nothing, and a container that can't
  capture in place answers `requiresRecreate: true`. Refused with 409
  `flag-off`, `revoked` (global marker) or `recreate-unresolved`. Disable
  answers `{ enabled: false, emissionStopsAfterRestart: true, capture }` and
  always works, also while a recreation is unresolved: marker → D1 → hooks
  file → `relay.enabled`, all done when it answers.
- `GET /api/admin/stats` → `conversation`: `enabledSessions`,
  `effectiveSessions`, `eventsSinceBoot`, `rejectedSinceBoot.byReason`,
  `gapsSinceBoot`, `unattributedGaps`, `bytesOnDisk` (re-measured at most
  once a minute), `queueBytesNow`, `queueBytesMax`, `wsResyncsSinceBoot`
  (0 until the 3.1 Conversation WS exists) and `recreateOrphans`. No titles
  or ids. `effectiveSessions` is computed without probing any relay, so it
  is an upper bound ("configured"); the probed value is per session.

Kill switch without a rebuild — run inside the backend container, like
`backup`:

```bash
npm run conversation:disable -- <sessionId>   # one session
npm run conversation:disable -- --all         # every session (global marker)
npm run conversation:enable-all               # remove the global marker only
```

Order is marker → D1 → hooks file; the command prints success only after
all three. The receiver stats the markers on **every** event (no cache),
so ingest is cut off from the moment the marker exists even though the
command cannot touch the receiver's in-memory token cache. If D1 is down
the command exits non-zero and leaves the marker in place: ingest stays
cut, the hooks file stays until the receiver removes it on the next event,
and nothing is regenerated at the next start.

Transport (§2.6): Claude Code refuses HTTP hooks to private addresses, so
the CLI posts to a relay on `127.0.0.1:47613` inside the session container,
started by the image's entrypoint only when the container has the token and
the hooks file. The relay answers every hook 204 at once and forwards, in
order, to `st-backend` on `sessions-net` (an alias of the `app` service in
`docker-compose.yml`). While the backend is down or hung the agent is not
slowed and nothing shows in the terminal; the relay counts what it could not
deliver and the conversation gets a `gap relay_dropped` when the backend is
back. The relay's 204 means "received in the container", not persisted.
If the session env defines `HTTP(S)_PROXY`/`ALL_PROXY`, the backend adds
`127.0.0.1` to `NO_PROXY`/`no_proxy` for capturing sessions so the CLI keeps
the hooks local.

**Backend and image go together.** The hooks file this backend writes
targets the relay, which only the 3.0c image has: under an older image every
hook would fail (connection refused, a "hook error" line per blocking event)
and nothing would be captured. Keep the flag off until both are deployed.

### Rollout order and rollback

Each step is safe on its own and can be stopped after; capture exists only
from step 4 on, for sessions explicitly requested.

1. **Backend + alias** (3.0b receiver, 3.0c backend and compose change),
   flag still off: `git pull && docker compose up -d --build`. Compose
   recreates `app` with the alias. Verify from any running session container
   (they are already on `sessions-net`): `getent hosts st-backend` resolves,
   and `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://st-backend:3001/ingest/claude/hook`
   prints `204` (`disabled`, nothing written). The flag off means no hooks
   file is written anywhere, so the order against step 2 doesn't matter yet.
2. **Session image**: tag the current one first so the rollback is a
   re-tag (`docker tag shared-terminal-session shared-terminal-session:pre-3.0c`),
   then `docker build -t shared-terminal-session ./session-image`. Existing
   containers keep their image — including across stop + start — until they
   are re-created ([below](#recreating-a-session-container)); new sessions
   get the new image. On a new or re-created session: `ls -A /etc/claude-code/managed-settings.d` is empty,
   no relay listens
   (`bash -c '(exec 3<>/dev/tcp/127.0.0.1/47613)'` fails) and `claude -p hola`
   behaves as before. The CLI pin seeds **fresh** workspaces only; an
   existing workspace keeps its persisted (self-updating) CLI, so check
   `claude --version` ≥ 2.1.308 before including a session in a pilot
   (`claude update` in the session).
3. **Flag on**, still no session requested: `CONVERSATION_ENABLED=true` in
   `.env`, `docker compose up -d`. Boot `reconcile` writes nothing (no row
   requested); every ingest stays `disabled`.
4. **Pilot** (D8: a **new, disposable** session with nothing important in
   it, created without capture and stopped): `PATCH …/conversation
   {"enabled":true}`, then the recreation preflight and `POST`
   ([below](#recreating-a-session-container)) — a stop + start would reuse
   the old container, without token, mount or relay, and possibly on the old
   image. The token, the mount and the relay exist only in the re-created
   container. Accept that the pilot may end up blocked in
   `recreate-unresolved`. Verify inside it that the relay listens
   (`bash -c '(exec 3<>/dev/tcp/127.0.0.1/47613)' && echo up`), then events under
   `<WORKSPACE_ROOT>/.conversations/<sessionId>/` and `capture.effective: true`
   in `GET /api/sessions/:id/conversations`.

Rollback, fastest first:

- **Cut ingest now**: `docker compose exec app npm run conversation:disable -- <sessionId>`
  (or `--all`). The receiver refuses from the marker on; the hooks file is
  removed, so new CLI sessions in that container stop emitting, and a
  running one is only guaranteed to stop when it restarts (CLI 2.1.308 was
  measured to stop on its own settings reload, but don't rely on it; the
  receiver's refusal is the cut). The relay of a running container stays up, inert, until the
  container is re-created (a stop + start keeps it).
- **Global off**: unset `CONVERSATION_ENABLED`, `docker compose up -d`.
  `reconcile` deletes every `conversation.json`; new starts get no token, no
  mount and no relay. Existing containers keep an inert token (and relay)
  until they are re-created.
- **Image**: disable capture first (either bullet above), **then**
  `docker tag shared-terminal-session:pre-3.0c shared-terminal-session`.
  That changes what **new** containers get: new sessions, and sessions you
  re-create ([below](#recreating-a-session-container)). Existing containers —
  including those stopped and started again — keep the image they were
  created from; re-create each one that must go back. An older image under
  an active hooks file has no relay, so every hook would fail visibly:
  never re-create onto `pre-3.0c` while capture is on for that session.
- **Backend**: rolling the backend back to 3.0b while capture is on would
  write hooks files aimed straight at `st-backend`, which the CLI refuses;
  turn the flag off first.
- **Alias**: harmless to keep.

Captured data stays under `.conversations/` until a hard delete (or manual
removal) — rollback never deletes it.

### Recreating a session container

Needed whenever a session must pick up something fixed at container
creation: a new or rolled-back image, capture enabled or disabled at the
container level, a fresh ingest token. **Never use a hard delete** — it
purges the workspace and the session row.

**Restriction (owner decision D8):** recreation is only used on a **new,
disposable pilot session**. Real working sessions are not recreated until a
manual administrative recovery procedure exists and has been validated: an
interrupted recreation stays `recreate-unresolved` (start, stop and delete
refuse with 409) and nothing resolves it automatically after a backend
restart. The workspace's Claude Code must be a version `/etc/st-control` was
validated with (today **2.1.308**, owner decision for the pilot only); any
other version blocks with `control-marker-incompatible`, including a newer
one the CLI self-updated to.

**The endpoint (3.0d, [CONVERSATION.md §2.7](./CONVERSATION.md#27-recreación-administrativa-y-activación-30d))**, admin only:

1. **Stop** the session (owner `POST /api/sessions/<sessionId>/stop`, or admin
   `POST /api/admin/sessions/<sessionId>/stop`). A running session is never
   recreated.
2. **Preflight**, no effects: `GET /api/admin/sessions/<sessionId>/recreate`
   → `{ recreatable, blockers[], imageId, currentImageId, captureAfter }`.
   `blockers` are codes with counts, never paths: anything in the container
   layer that would be lost (`layer-*`), a workspace that isn't ready
   (`workspace-*`), customised managed skills (`managed-skills-*`), capture
   not requested or not allowed, the image, the CLI version, an unresolved
   earlier attempt.
3. **Recreate**: `POST /api/admin/sessions/<sessionId>/recreate
   {"expectImageId": "<currentImageId from the preflight>"}`. A moved image
   tag answers 409 `image-changed`; any other failing precondition answers
   409 with its code and does nothing. For a session owned by someone else
   an `operate` row goes into the observe log before anything is done (if it
   can't be written, nothing is done). Results:
   - `200 { outcome: "committed", nContainerId, capture, cliVersion,
     warnings, incomplete }` — the session runs on the new container; with
     `unresolved: true` and `pending[]` the convergence is still being
     finished and the session stays gated until it is;
   - `500 { error: "recreate-failed", step }` — rolled back, the previous
     state intact;
   - `500 { error: "recreate-failed", step, unresolved: true }` — not known
     how it ended: the session stays `recreate-unresolved`;
   - `409 busy` (another lifecycle operation in progress), `503
     docker-unavailable`.
4. **Verify**: `GET /api/sessions/<sessionId>/conversations` reports
   `capture.effective: true`.

Kept: everything in the workspace (repo, Claude CLI state and transcripts,
`~/.npm-global`, `~/.ssh`, gh and VS Code state), uploads, the D1 row and
config, conversation history; the preconditions refuse a container whose
layer holds anything else.

**Emergency only — the manual procedure.** It bypasses every check above
(layer, skills, image, capture authorization) and loses what lived only in
the container layer. Use it only when the endpoint cannot be used and the
loss is acceptable. It relies on existing behaviour: `POST /start`
re-creates the container when the one on record no longer exists in Docker
(the "stale container id" path of `startContainer`). While a recreation of
the session is unresolved its `stop` and `start` steps answer
`recreate-unresolved`: don't work around that by hand.

1. **Stop** the session: `POST /api/sessions/<sessionId>/stop` (owner), or
   `POST /api/admin/sessions/<sessionId>/stop` (admin). The container
   stays; the workspace, uploads and `session_configs` are untouched.
2. **Remove only the container**, on the host:
   `docker rm st-<first 12 chars of sessionId>` (the name is `containerName`
   in `GET /api/sessions/<sessionId>`). No `-v` needed (sessions have no
   volumes; the workspace is a host bind mount).
3. **Start** it: `POST /api/sessions/<sessionId>/start` (owner or admin).
   The backend finds no container behind the stored id and spawns a new
   one from the current image, with the session's stored config, env and
   ports, and — if capture is requested and `CONVERSATION_ENABLED` — a new
   token, the managed mount and therefore the relay. `postStart` runs;
   `postCreate` does not (it is single-use).
4. **Verify**: `docker inspect st-… --format '{{.Image}}'` is the new image
   id, and, with capture, `GET /api/sessions/<sessionId>/conversations`
   reports `capture.effective: true`.

Kept by the manual procedure: everything under the workspace (repo, `~/.claude` and the CLI's
`~/.npm-global` through their workspace symlinks, `~/.ssh`, gh/VS Code
state), uploads, the D1 row and config, conversation history. Lost: what
lived only in the container layer (packages installed with `apt`/outside
the workspace, `/tmp`, running processes and tmux tabs) — the same as any
re-created container. A soft delete (`DELETE /api/sessions/:id` without
`?hard=true`) followed by `POST /start` also re-creates the container while
keeping the workspace, but passes through `terminated`; prefer the steps
above.

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

A backup dir holds one `<table>.jsonl` per table (deterministic order —
two backups of identical data are diffable), `workspaces/<sid>.tar.gz`
(workspace + uploads dir, gzip because the image already ships it), and
`manifest.json` written last — restore refuses a dir without it, so an
interrupted backup can't be replayed by accident.

Restore guards:

- **Non-empty target** (any `users`/`sessions` rows) refuses without
  `--force`. Replays use `INSERT OR REPLACE`, so a `--force` re-run over a
  partial restore converges.
- **`SECRETS_ENCRYPTION_KEY` mismatch aborts before any write** and has
  NO `--force` override — a wrong key silently corrupts every secret with
  no rotation path (see docs/SECRETS_ENCRYPTION_KEY.md). The check is one
  decrypt round-trip on a sample blob from the dump; the key must travel
  to the destination separately from the backup itself.
- Workspace tarballs are entry-checked before extraction (paths must stay
  under `<sid>/` or `.uploads/<sid>/` — no traversal).

Previously-`running` sessions land as `stopped` with a NULL container id
— the destination host has none of the source's containers, matching what
`reconcile()` would conclude. Start them from the UI after restore.
Running sessions are not quiesced during backup; for a coherent snapshot
of an active deployment, stop sessions first (workspaces of stopped
sessions are always consistent).

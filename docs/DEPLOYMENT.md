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
3.0b ships the receiver, 3.0c the session-image side (an empty
managed-settings directory, the SessionStart script, the loopback relay the
hooks post to, the `st-backend` alias) and 3.0d the activation: the image's
control directory and label, capture authorization, the recreation engine
and the admin surface ([CONVERSATION.md §2.7 and §7](./CONVERSATION.md#27-recreación-administrativa-y-activación-30d);
image side in [session-image/README.md](../session-image/README.md#conversation-hooks-managed-settings)).
With `CONVERSATION_ENABLED` unset, nothing is mounted or injected and no
session emits anything.

> **Operational restrictions in force (owner decisions).** Capture stays off
> until a coordinated deploy is authorized. The first and only pilot is a
> **new, disposable** session with no real data (D8). **No real working
> session is recreated** until a manual administrative recovery procedure
> exists and has been validated. Recreation accepts only a workspace CLI of
> exactly **2.1.308** (the validated allowlist, for the pilot only).

| Variable | Default | Effect |
| --- | --- | --- |
| `CONVERSATION_ENABLED` | unset (`false`) | Master switch. Off: `POST /ingest/claude/hook` answers 204 and discards (`ingest_rejected{disabled}`), no session gets a hooks file, an ingest token, `relay.enabled` or the extra read-only bind mounts, and boot `reconcile` deletes every stale `conversation.json` and `relay.enabled`. On: capture is still **per-session opt-in** (`sessions.conversation_requested`). |
| `CONVERSATION_ALLOW_USERS` | unset | Comma-separated user ids whose **new** sessions are born with capture requested (`conversation_requested=1`); the owner decides, also for an admin create on behalf of someone. Existing sessions are never touched. Requested is not effective: the flag, no revocation and an image with the relay still apply. Entries that are not user ids are ignored with a warning. Keep it **empty until the pilot has passed** (stage 3 is a separate decision). |
| `PORT` | `3001` | Passed to capturing session containers as `ST_BACKEND_PORT`: the relay forwards to `http://st-backend:<PORT>/ingest/claude/hook`. The hooks file itself always targets the relay, `http://127.0.0.1:47613/ingest/claude/hook`. |

Both variables are forwarded by `docker-compose.yml` with empty defaults
(before 3.0d `CONVERSATION_ENABLED` was not, so setting it in `.env` did
nothing under compose).

### Composer (3.2, `docs/CONVERSATION.md` §8)

Sending a message to the Claude Code CLI from the Chat view. **Off by
default**: with `CONVERSATION_COMPOSER_ENABLED` unset the route is not
mounted (404) and every conversation reports `canSendInput: false`. Turn it
on only on a backend that already runs the #444 fix (`b1479d5`) and only for
sessions whose capture is effective — a send is confirmed by the CLI's own
`UserPromptSubmit`, so without capture it can never be `delivered`.

| Variable | Default | Effect |
| --- | --- | --- |
| `CONVERSATION_COMPOSER_ENABLED` | unset (`false`) | Mounts `POST /api/sessions/:id/conversations/:cid/messages` and the admin routes `POST /api/admin/sessions/:id/composer/resolve`, `GET /api/admin/sessions/:id/composer/panes`; `canSendInput` becomes true for interactive conversations with a pane, effective capture and no blocking operation. |
| `COMPOSER_CLI_VERSIONS` | `2.1.314` | Comma-separated Claude Code versions the §8.2.6 revalidation was run with. A conversation whose CLI (the process in the pane) is another version gets 409 `cli-unvalidated`. Adding a version means running `backend/src/conversation/composer.smoke.ts` against it and attaching the output to the PR. |

Operator surface (`CONVERSATION.md` §8.1.11). A pane whose last send has a
pending outcome blocks further sends from Chat (409
`send-in-progress{effects-pending}`); the Chat view explains it and the
admin stats (`GET /api/admin/stats → composer`) count blocked panes. To
look and resolve, from the backend container (same exclusion as the API —
the CLI only calls the backend on loopback and refuses when it is down):

```bash
npm run composer:resolve -- <sessionId> --list --user <admin>
npm run composer:resolve -- <sessionId> <paneId> <clientMessageId> reconcile --user <admin>
npm run composer:resolve -- <sessionId> <paneId> <clientMessageId> discarded|sent-manually --user <admin>
```

- `reconcile` re-settles the pending execs from Docker's evidence (exit code
  by inspect, or the container gone) and re-runs the deferred ack; it is
  idempotent and never writes a second audit row. Repeat it after the
  container's state changed.
- `discarded` / `sent-manually` declare what the operator verified in the
  Terminal (the segment was cleared, or the person sent it by hand). Only
  possible when no executor is active on the pane and the result is still
  pending; the API answers 409 `operation-active` / `not-pending` otherwise.
  Each declaration writes one `operate` row in the observe log.
- A pane stuck because an exec's outcome can never be inspected (the daemon
  lost the exec) is released by stopping and starting the session: the
  container is then gone for the pending execs, which is settlement evidence
  (`evidence: container-gone`), and `reconcile` releases the pane.
- A backend restart turns every active operation into `uncertain{orphaned}`
  (fail-closed: nothing is resent); the person sees it in Chat and the
  operator resolves as above.
- A pane record that cannot be parsed makes the whole session unverifiable
  for the composer (409) and is never deleted by the backend: inspect
  `<WORKSPACE_ROOT>/.st-control/<sid>/composer/`.

Host-side directories, all outside the workspace bind mount, next to
`.uploads`:

- `.conversations/<sessionId>/` holds:
  - the event logs and index snapshots;
  - the per-session revocation marker `REVOKED` and, once an admin
    re-enables, `LIFTED`. A revocation is in effect while `REVOKED` exists
    and is not the one `LIFTED` names (§2.5). Never delete or edit either by
    hand.

  `.conversations/REVOKED_ALL` is the global marker. A soft delete keeps all
  of it, `?hard=true` purges it, and `npm run backup` includes it in the
  per-session tarball.
- `.claude-managed/<sessionId>/conversation.json`: the managed-settings hooks
  file, mounted read-only at `/etc/claude-code/managed-settings.d/`. It is
  not backed up; `reconcile` regenerates it from D1.
- `.st-control/<sessionId>/` (3.0d): mounted read-only at `/etc/st-control`
  in containers created with capture by a 3.0d backend. It holds:
  - `relay.enabled`: the relay may start;
  - `defer-skill-seed`: skill seeding is deferred while a recreation is in
    progress;
  - `recreate-attempt.json`: the durable recreation record, with no secrets;
    kept until a hard delete.

  Never edit these by hand.

Requested vs effective (CONVERSATION.md §2.4): a container's env is
immutable, so whether a container *can* capture (token, mounts, relay) is
decided when it is **created**. `POST /start` and a stop + start **reuse** a
container that still exists (§2.4.1), so they never add capture, a new image
or a token rotation. In 3.0d:

- a container that already has capture is turned on or off in place with
  `PATCH …/conversation`;
- a container without it (no token, no control mount, `token-mismatch`)
  answers `requiresRecreate: true` and only gains it through the recreation
  endpoint ([below](#recreating-a-session-container)), which the
  restrictions above confine to the pilot.

`GET /api/sessions/:id/conversations` reports
`capture.{requested,effective,effectiveAfterRestart,requiresRecreate,pendingReasons}`,
so nobody is promised capture that is not happening.

Admin surface (`requireAdmin`; the writes also go through `adminActionIp`):

- `PATCH /api/admin/sessions/:id/conversation {"enabled": true|false}` applies
  the §2.4 row and answers `{ enabled, capture }`.
  - **Enable** writes only on a running container with full authorization:
    the marker, then, once the relay identified itself within 5 s, the
    hooks file. On a stopped container it writes nothing, and a container
    that can't capture in place answers `requiresRecreate: true`.
  - Enable runs under the session's lifecycle lock, like start, stop and
    delete: behind one of those it waits (up to 6 min, then 409 `busy`) and
    acts on the state they left.
  - Enable is refused with 409 `flag-off`, `revoked` (a disable or the
    emergency won meanwhile), `revoked-globally`, `recreate-unresolved` or
    `busy`.
  - **Disable** answers `{ enabled: false, emissionStopsAfterRestart: true,
    capture }` and always works, also while a recreation is unresolved:
    marker → D1 → hooks file → `relay.enabled`, all done by the time it
    answers.
- `GET` and `POST /api/admin/sessions/:id/recreate`: the recreation
  ([below](#recreating-a-session-container)).
- `GET /api/admin/stats` → `conversation`:
  - the fields: `enabledSessions`, `effectiveSessions`, `eventsSinceBoot`,
    `rejectedSinceBoot.byReason`, `gapsSinceBoot`, `unattributedGaps`,
    `bytesOnDisk` (re-measured at most once a minute), `queueBytesNow`,
    `queueBytesMax`, `wsResyncsSinceBoot` (0 until the 3.1 Conversation WS
    exists) and `recreateOrphans`;
  - no titles or ids;
  - `effectiveSessions` is an **estimate of configuration**, computed without
    probing any relay, never verified availability. The probed value is per
    session.

Kill switch without a rebuild. Run it inside the backend container, like
`backup`:

```bash
npm run conversation:disable -- <sessionId>   # one session
npm run conversation:disable -- --all         # every session (global marker)
npm run conversation:enable-all               # remove the global marker only
```

- **Order:** revocation marker → D1 → hooks file → `relay.enabled`. The
  command prints success only after all four, and then re-asserts its marker
  if an overlapping enable lifted it. A disable or emergency always wins over
  a concurrent enable, in D1, in the marker and for the next spawn (§2.5,
  3.0d audit A1).
- **When the cut takes effect:** the receiver checks the markers on **every**
  event, uncached, so ingest is cut from the moment the marker exists, even
  though the command can't touch the receiver's in-memory token cache.
- **If D1 is down,** the command exits non-zero and leaves the marker in
  place: ingest stays cut, the files are removed by the receiver on the next
  event, and nothing is regenerated at the next start.
- **To re-enable a session** cut by the command, use
  `PATCH …/conversation {"enabled": true}`. The emergency nulls both hashes,
  so a container that had capture then needs a recreation; the restrictions
  above apply.

**Transport (§2.6).** Claude Code refuses HTTP hooks to private addresses, so
the CLI posts to a relay on `127.0.0.1:47613` inside the session container.
- **When the relay starts:** the entrypoint's supervisor starts with the
  container's token, but launches the relay only once
  `/etc/st-control/relay.enabled` exists (3.0d), or a 3.0c-style hooks file.
  A marker removed later doesn't stop a running relay; it stays inert.
- **What it does:** it answers every hook 204 at once and forwards, in order,
  to `st-backend` on `sessions-net` (an alias of the `app` service in
  `docker-compose.yml`).
- **When the backend is down or hung:** the agent isn't slowed and nothing
  shows in the terminal. The relay counts what it could not deliver, and the
  conversation gets a `gap relay_dropped` when the backend is back. The
  relay's 204 means "received in the container", not persisted.
- **Proxies:** if the session env defines `HTTP(S)_PROXY`/`ALL_PROXY`, the
  backend adds `127.0.0.1` to `NO_PROXY`/`no_proxy` for capturing sessions,
  so the CLI keeps the hooks local.

**Backend and image go together.** The 3.0d backend prepares capture only
for an image labelled `io.shared-terminal.conversation-relay="2"`. A spawn
from an unlabelled image gets no token, no mounts and no hooks file, and its
leftovers are removed, so a hook never points at a missing relay. Deploy the
3.0d image together with the 3.0d backend, flag off.

### Coordinated deploy (3.0d) — documented, not yet executed

One deploy, when the owner authorizes it, with the VM untouched until then.
Each stage can be stopped and rolled back, and moving to the next one needs
explicit authorization. The detailed plan, with the pilot checklist, is in
[design/phase3-3.0d-audit.md §6–§7](./design/phase3-3.0d-audit.md).

**Preflight (no change to the VM):**

1. Record the SHA running today (`git rev-parse HEAD`) and the session
   image id (`docker image inspect shared-terminal-session --format
   '{{.Id}}'`). These are the rollback points.
2. Run `docker compose exec app npm run backup`, and check that the directory
   has a `manifest.json`.
3. `docker network inspect sessions-net` succeeds, and there is disk space
   for one more image and for `.conversations/`.
4. `CONVERSATION_ENABLED` and `CONVERSATION_ALLOW_USERS` are **unset** in
   `.env`.
5. Note every session's status, `container_id` and image (`GET
   /api/admin/sessions`) to compare against afterwards.

**Stage 0 — backend 3.0d + image `="2"`, flag off.**

1. Tag the current image for the rollback:
   `docker tag shared-terminal-session shared-terminal-session:pre-3.0`.
2. `git pull` to the approved SHA, then
   `docker build -t shared-terminal-session ./session-image`. Check
   `docker image inspect shared-terminal-session --format '{{index .Config.Labels "io.shared-terminal.conversation-relay"}}'`
   prints `2`.
3. `docker compose up -d --build`. Compose recreates only `app` (with the
   `st-backend` alias); session containers are not touched. The pending
   migrations, up to v17, are all additive.
4. **Verify,** creating or recreating nothing:
   - the boot log says `conversation capture disabled`, with no `reconcile`
     or `recoverOnBoot` errors;
   - existing sessions are unchanged (status, `container_id`, image);
   - from a session container,
     `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://st-backend:3001/ingest/claude/hook`
     prints `204` (`disabled`);
   - `GET /api/admin/sessions/<sid>/recreate` lists `flag-off`, with no
     effects;
   - `GET /api/admin/stats` → `conversation.enabledSessions = 0`;
   - there is no `conversation.json` and no `relay.enabled` anywhere.

**Stage 1 — flag on, nobody requested.** Set `CONVERSATION_ENABLED=true` in
`.env` and run `docker compose up -d`. Verify that `reconcile` corrects and
orphans nothing, that `enabledSessions = 0`, and that no file is written.

**Stage 2 — the pilot**, a new disposable session ([below](#recreating-a-session-container)).
It may end up blocked in `recreate-unresolved` (see below).

**Stage 3 — `CONVERSATION_ALLOW_USERS`:** a separate owner decision, after
the pilot. The pending decisions #465–#467 are taken before it.

The deploy does **not** recreate any existing container, enable capture on a
real session, or use the emergency manual procedure.

### Rollback (from 3.0d)

Fastest first:

- **Cut ingest now:**
  `docker compose exec app npm run conversation:disable -- <sessionId>` (or
  `--all`). The receiver refuses from the marker on and the files are
  removed. A running CLI is only guaranteed to stop emitting when it
  restarts (CLI 2.1.308 was measured to stop on its own settings reload, but
  don't rely on it); the receiver's refusal is the cut. The relay of a
  running container stays up, inert, until the container is recreated.
- **Global off:** unset `CONVERSATION_ENABLED` and run `docker compose up -d`.
  `reconcile` deletes every `conversation.json` and `relay.enabled`, and new
  containers get no token, no mounts and no relay. Existing containers keep
  an inert token (and relay) until they are recreated.
- **Image:** disable capture first (either bullet above), **then**
  `docker tag shared-terminal-session:pre-3.0 shared-terminal-session`. Only
  **new** containers are affected; existing ones, also after a stop + start,
  keep the image they were created from. Under the 3.0d backend a spawn from
  the older, unlabelled image prepares no capture.
- **Backend (to the SHA recorded in the preflight):**
  1. Turn the flag off first (global off above) and wait for `reconcile` to
     have removed the files.
  2. Then `git checkout <SHA>` and `docker compose up -d --build`. The
     additive schema doesn't bother an older backend.

  **Never roll the backend back while a recreation is unresolved:** a
  backend older than 3.0d knows neither the attempt record nor the
  `recreate-unresolved` gate, so `start`, `stop` and a hard delete would act
  on that session. Keep the 3.0d backend in place (next section).
- **Alias:** harmless to keep.

Captured data stays under `.conversations/` until a hard delete (or manual
removal); a rollback never deletes it.

### Unresolved recreations (D8)

A recreation that is interrupted (backend restart, Docker not answering, a
commit whose outcome is unknown) leaves the session **`recreate-unresolved`**.
**Nothing resolves it automatically after a backend restart:** that is owner
decision D8, fail-closed.

**What you see:**
- `start`, `stop`, `delete` (soft and hard), `PATCH /ports` and
  `PATCH …/conversation {"enabled": true}` answer 409 `recreate-unresolved`
  and do nothing;
- the preflight lists `recreate-unresolved`, and so do the session's
  `capture.pendingReasons`;
- the record is at `<WORKSPACE_ROOT>/.st-control/<sid>/recreate-attempt.json`,
  with state `uncertain` (and `orphanedAt` after a restart).

**What still works:** disabling capture (`PATCH {enabled:false}`) and the
emergency command.

**What to do:**
1. Stop the procedure (the pilot).
2. Keep the 3.0d backend deployed: it is what keeps the session gated, while
   every other session goes on working.
3. Collect the `[recreate]` log lines and the record for review.
4. Wait for the manual administrative recovery procedure, once it exists
   and is validated.

There is **no available way out by hand**:
- a hard delete is refused;
- don't roll the backend back;
- don't edit the record, D1 or the containers.

That is the accepted cost of piloting only on a disposable session.

### Recreating a session container

Needed whenever a session must pick up something fixed at container
creation: a new or rolled-back image, capture at the container level, a
fresh ingest token. **Never use a hard delete:** it purges the workspace and
the session row.

**Restriction (owner decision D8):** recreation is used only on the **new,
disposable pilot session**. No real working session is recreated until the
manual recovery procedure above exists and has been validated. The
workspace's Claude Code must be **exactly 2.1.308**; any other version,
including a newer one the CLI updated itself to, blocks with
`control-marker-incompatible`. For the pilot session:
- never run `claude update`;
- create it with `DISABLE_AUTOUPDATER=1` among its env vars. The
  session-image smoke checks that the pinned 2.1.308 knows the variable;
  that no update then happens is only observable over time, so compare
  `claude --version` before and after;
- check `claude --version` = 2.1.308 again right before the `POST`.

**The endpoint (3.0d, [CONVERSATION.md §2.7](./CONVERSATION.md#27-recreación-administrativa-y-activación-30d))**, admin only:

1. **Stop** the session (owner `POST /api/sessions/<sessionId>/stop`, or admin
   `POST /api/admin/sessions/<sessionId>/stop`). A running session is never
   recreated.
2. **Preflight**, no effects: `GET /api/admin/sessions/<sessionId>/recreate`
   → `{ recreatable, blockers[], imageId, currentImageId, captureAfter }`.
   `blockers` are codes with counts, never paths:
   - anything in the container layer that would be lost (`layer-*`, e.g.
     `~/.bash_history`, packages installed with `apt`, configured dotfiles);
   - a workspace that isn't ready (`workspace-*`);
   - customized managed skills (`managed-skills-*`);
   - capture not requested or not allowed;
   - the image, or the CLI version;
   - an unresolved earlier attempt.
3. **Recreate:** `POST /api/admin/sessions/<sessionId>/recreate
   {"expectImageId": "<currentImageId from the preflight>"}`.
   - A moved image tag answers 409 `image-changed`; any other failing
     precondition answers 409 with its code and does nothing.
   - For a session owned by someone else, an `operate` row goes into the
     observe log before anything is done; if it can't be written, nothing
     is done.
   - Don't edit the session's ports or resource limits while it runs (ports
     wait for it; limits don't, audit A6).

   Results:
   - `200 { outcome: "committed", nContainerId, capture, cliVersion,
     warnings, incomplete }`: the session runs on the new container. With
     `unresolved: true` and `pending[]`, the convergence is still being
     finished and the session stays gated until it is;
   - `500 { error: "recreate-failed", step }`: rolled back, the previous
     state intact;
   - `500 { error: "recreate-failed", step, unresolved: true }`: it isn't
     known how it ended, so the session stays `recreate-unresolved` (see
     above);
   - `409 busy` (another lifecycle operation in progress), or `503
     docker-unavailable`.
4. **Verify:** `GET /api/sessions/<sessionId>/conversations` reports
   `capture.effective: true`.

**What the endpoint preserves:**
- the **workspace**, including the HOME state that lives there through its
  symlinks: `~/.claude` and `~/.claude.json` (CLI state and transcripts, so
  `claude --resume` keeps working), `~/.npm-global` (the CLI itself),
  `~/.vscode-cli`, `~/.config/gh` and `~/.ssh`;
- the uploads;
- the D1 row and `session_configs` (secrets, ports, resource caps, hooks);
- the conversation history;
- the git identity, re-applied from `session_configs`.

The preconditions refuse a container whose layer holds anything else, so
nothing that lived only there is lost.

### Emergency only — the manual procedure

It bypasses every check of the endpoint: layer, skills, image, CLI version
and capture authorization. Use it only when the endpoint can't be used **and
the losses below are accepted**, never on a session with a recreation
unresolved: its `stop` and `start` steps answer `recreate-unresolved` then,
and that must not be worked around. It relies on existing behaviour:
`POST /start` re-creates the container when the one on record no longer
exists in Docker (the "stale container id" path of `startContainer`).

1. **Stop** the session: `POST /api/sessions/<sessionId>/stop` (owner), or
   `POST /api/admin/sessions/<sessionId>/stop` (admin). The container stays,
   and the workspace, uploads and `session_configs` are untouched.
2. **Remove only the container**, on the host:
   `docker rm st-<first 12 chars of sessionId>` (the name is `containerName`
   in `GET /api/sessions/<sessionId>`). No `-v` is needed: sessions have no
   volumes, and the workspace is a host bind mount.
3. **Start** it: `POST /api/sessions/<sessionId>/start` (owner or admin).
   - The backend finds no container behind the stored id and spawns a new
     one from the current image, with the session's stored config, env and
     ports.
   - If capture is requested and `CONVERSATION_ENABLED` is set, the new
     container also gets a new token and the mounts.
   - `postStart` runs; `postCreate` and the rest of the bootstrap don't.
4. **Verify:** `docker inspect st-… --format '{{.Image}}'` shows the new
   image id, and, with capture, `GET /api/sessions/<sessionId>/conversations`
   reports `capture.effective: true`.

**Kept:** everything under the workspace, including the HOME state symlinked
into it (as listed above); the uploads; the D1 row and config; and the
conversation history.

**Lost — everything that lived only in the container layer:**
- the **git identity** (`~/.gitconfig`). The bootstrap writes it only at
  create, and a start doesn't re-run it;
- whatever **dotfiles** installed outside the workspace. The dotfiles stage
  also runs only at create;
- packages installed with `apt` or anywhere else outside the workspace;
- `~/.bash_history` and every other file in HOME that isn't symlinked into
  the workspace;
- `/tmp`, running processes and the tmux tabs.

A soft delete (`DELETE /api/sessions/:id` without `?hard=true`) followed by
`POST /start` also re-creates the container with the same losses, passing
through `terminated`; prefer the steps above.

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

A table created by a migration newer than the source D1's schema (e.g.
`claude_conversations`, v16, when backing up a pre-Phase-3 deployment
before upgrading) is skipped and absent from `tables`; restore treats it
as empty. At or past that version a missing table fails the backup.

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

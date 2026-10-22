# Security model

Read this before exposing the backend to the public internet.

## Threat model

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

### Admin privilege boundary

An `is_admin=1` account is a **fully trusted operator**, not a
scoped-up user. Beyond the cross-user dashboard (list, force-stop,
force-delete, edit resource caps), an admin can **operate any user's
session** — attach to the live terminal with full write, edit its env
vars and exposed ports, create/delete/search its tabs, run exec, and
**start** a stopped session (#429) — via the same `is_admin` claim
(`assertCanOperate`, owner-OR-admin). Stop and delete stay owner-driven
(the owner and the idle sweeper own teardown). This is
distinct from the read-only **tech-lead** role (`assertCanObserve`,
group-scoped, no write). Every cross-user attach is recorded in
`session_observe_log` with `mode='observe'|'operate'`, giving the
owner and other admins an audit trail of who watched vs. who drove
their session — a detective control, not a preventive one. Treat
admin credential compromise as equivalent to compromise of every
user's session data; scope admin accounts accordingly.

## Recommended deployment posture

- **Do not expose port 3001 directly to the internet.** Treat the
  backend as a private service.
- **Run behind Cloudflare Tunnel** (see [DEPLOYMENT.md → With Cloudflare Tunnel](./DEPLOYMENT.md#with-cloudflare-tunnel))
  so the origin has no inbound ports open at all. The tunnel
  terminates at Cloudflare; the home server only makes outbound
  connections.
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

## Secrets at rest

`secret`-typed env entries are AES-256-GCM encrypted before they are
written to D1 (key: `SECRETS_ENCRYPTION_KEY`). The threat model is "a
compromised D1 export hands an attacker only ciphertext."

**Enabling per-session `.env` materialisation breaks that guarantee for
the materialised values.** When a session sets `config.writeEnvFile`
(#277), the bootstrap stage writes ALL env var entries — `plain` values
verbatim and `secret` values decrypted — as plaintext `KEY=VALUE` lines
into `/home/developer/workspace/.env`, which is the bind-mounted
workspace, host path `<WORKSPACE_ROOT>/<sessionId>/.env`. `chmod 600`
limits reads inside the container, but the cleartext now lives on the
host filesystem, not just in encrypted D1.

Three consequences operators should weigh before enabling it:

- **At-rest encryption no longer covers those values.** Anyone with
  read access to `WORKSPACE_ROOT` on the host sees the secrets in the
  clear, independent of `SECRETS_ENCRYPTION_KEY`.
- **The cleartext `.env` survives a soft delete.** `DELETE
  /api/sessions/:id` (without `?hard=true`) preserves the workspace dir
  so the session can be restored — so the `.env`, and the secrets in it,
  persist after the session is "deleted." Use `?hard=true` (which runs
  `purgeWorkspace`) to actually remove a session whose `.env` held
  secrets; a plain soft delete leaves them on disk.
- **No API rewrites the on-disk `.env` after create-time bootstrap.** The
  file is written once, during the create-time bootstrap pipeline.
  Editing env vars via `PATCH /sessions/:id/env` updates only the legacy
  `sessions.env_vars` column — it touches neither the typed
  `session_configs` store that `writeEnvFile` reads nor the file on disk.
  So there is no rotate-in-place path: a leaked secret's old cleartext
  stays in the host `.env` until the session is hard-deleted (and
  recreated).

This is an explicit, opt-in feature (off by default). Leave
`writeEnvFile` unset for sessions whose secrets must stay
encrypted-at-rest, and prefer hard delete for any session that used it.

## Claude CLI state at rest

The session image persists Claude CLI state in the bind-mounted
workspace so it survives container recreation (`POST
/sessions/:id/start`, reconcile after a host reboot): the entrypoint
symlinks `~/.claude` and `~/.claude.json` to
`<WORKSPACE_ROOT>/<sessionId>/.st/claude-state` and `.st/claude.json`
on the host. Without this, every recreate forced a re-login and
orphaned the session transcripts `claude --resume` / `--continue`
replay. The `.st/` root carries a `*` self-.gitignore so that when the
workspace is a repo checkout (the normal cloned-session case), a
`git add -A` cannot commit the state into the user's repo — that
protects the git surface only; everything below about host-side
readers still applies. (#371 briefly targeted
`<workspace>/.claude{,.json}` directly, which collided with a repo's
project-level `.claude/` config dir — #377; the entrypoint migrates
that layout to `.st/` on the next recreate.)

That state includes material operators should be aware of:

- **Conversation transcripts** (`.st/claude-state/projects/`) — the
  full content of every Claude conversation run in the session, in
  cleartext JSONL. Anything the user pasted into a conversation
  (including secrets) is in there.
- **OAuth credentials** (`.st/claude-state/.credentials.json`) — a live
  Anthropic token, `chmod 600` but cleartext on the host filesystem.
- **SSH private keys** (`.st/ssh/`) — the session's `~/.ssh` is
  persisted here too, so any private keys the user generates or copies
  in live cleartext on the host under `<WORKSPACE_ROOT>/<sessionId>`
  (`chmod 600`, but not covered by `SECRETS_ENCRYPTION_KEY`). Backing up
  or sharing a workspace dir now also copies whatever keys the session
  can push with.

Same consequences as the `writeEnvFile` section above, for the same
reason (the workspace bind mount is the persistence boundary):

- **Anyone with read access to `WORKSPACE_ROOT` on the host sees
  transcripts and the token in the clear.** Neither is covered by
  `SECRETS_ENCRYPTION_KEY` — that only protects `secret`-typed env
  entries in D1.
- **The state survives a soft delete.** `DELETE /api/sessions/:id`
  preserves the workspace dir so the session can be restored — the
  transcripts and token persist after the session is "deleted." Use
  `?hard=true` (which runs `purgeWorkspace`) for sessions whose
  conversations or credentials must actually be destroyed.
- **There is no rotate-in-place path.** Revoking the Anthropic token
  requires `claude /logout` inside a running session (or revocation on
  the Anthropic side); deleting transcripts requires removing
  `.st/claude-state/projects/` in the workspace or a hard delete.

Unlike `writeEnvFile` this is not opt-in — persistence is the point of
the feature, and the alternative (state evaporating on every recreate)
was a standing bug, not a privacy control anyone relied on.

## Browsing workspace files from the browser

The Workspace Explorer (`GET /api/sessions/:id/fs/*`) and the file
download route (`GET /api/sessions/:id/files`) read the session
workspace straight from the host bind mount with the backend's
privileges (typically root), so both go through one hardened opener
(`backend/src/workspaceFiles.ts`):

- **Owner-only.** Ownership is checked before any filesystem access, not
  via the observe tier: group leads and admins can't read workspace files
  through these routes (they'd be an unaudited widening of what
  observe/operate grants). A foreign session answers the same 404 as a
  missing one.
- **Containment.** Lexical resolve + prefix check, realpath of the
  parent, `O_NOFOLLOW | O_NONBLOCK` open, then a re-check of what the
  fd *actually* points at via `/proc/self/fd/<n>` — so a symlink or
  directory swapped in by code inside the container between check and
  open is still caught (on Linux this check is mandatory; a failure to
  read the link fails the request). Symlink leaves are never followed.
- **Restricted paths.** Credential-bearing paths are refused with 403
  even to the owner: `.st/` (Claude OAuth state, transcripts, SSH keys —
  see above), `.ssh/`, `.git/`, `.config/gh/`, `.vscode-cli/`,
  `.aws/`/`.kube/`/`.docker/`/`.gnupg/`, `.env` / `.env.*` (templates
  like `.env.example` allowed), `.envrc` / `.direnv/`, private-key and keystore extensions,
  `.netrc` / `.npmrc` / `.git-credentials` and similar. It's a denylist,
  so best-effort: it keeps secrets out of one-click browser
  copy/download/screenshots, it is **not** a sandbox — the owner can
  still `cat` anything from their terminal.
- **Bounded reads.** Previews read at most 1 MiB (never the whole file);
  inline images are capped at 10 MiB, streamed with backpressure, and
  served from an extension allowlist with `nosniff`,
  `Content-Disposition: attachment`, and a `sandbox` CSP so an SVG can't
  run script on the API origin. Concurrent previews are capped per user
  and per process (429 when full), on top of the per-IP rate limits.

## Git Changes view

`GET /api/sessions/:id/git/{status,diff,log}` show a repository's branch,
changed files, one-file diffs and recent commits. Same owner-only gate
and the same restricted-path denylist as the Explorer (a committed
`.env`'s diff is refused with 403), plus:

- **git runs inside the session container, never on the host.** A
  repository is attacker-controlled input: `.git/config` can point
  `core.fsmonitor`, `diff.external`, a textconv driver or
  `core.sshCommand` at any command, and `core.worktree` / symlinks can
  point the "worktree" anywhere. Running `git status` over such a tree as
  root on the host would execute those; inside the container they run as
  the same unprivileged `developer` user that already runs the session's
  arbitrary code, so there is nothing to escalate to. The trade-off is
  that the view needs the session running (409 otherwise) — the Files
  view, which reads the host bind mount, does not.
- **No client-built commands.** Every invocation is a fixed argv (no
  shell): the only request-derived operands are a validated
  workspace-relative directory (`git -C <dir>`) and validated
  repo-relative paths passed after `--` as `:(top,literal)` pathspecs, so
  a file called `-rf` or `*.ts` is an operand, never an option or a
  glob. Diff output flags (`--no-ext-diff --no-textconv`) and
  per-invocation config (`core.fsmonitor=false`, `core.pager=cat`,
  `color.ui=never`) override anything the repo or user config sets.
- **The denylist is enforced on what git resolves, not on what was
  typed.** A clean-looking operand can still reach restricted content —
  a pathspec naming a directory matches every file beneath it (`src` →
  `src/.env`), `git diff --no-index` opens worktree paths through the OS
  and so follows a symlinked parent (`alias → .st`), and `git -C <dir>`
  follows symlinks too. So, before any content is produced: (1) every
  request runs `git rev-parse --show-toplevel --show-prefix` and refuses
  (403 `outside-workspace`) unless the repository's *real* top level is
  exactly where `dir` lexically says inside the workspace — this also
  catches a `core.worktree` pointing elsewhere; (2) a diff first asks git
  which entries the pathspec matches (`git diff --raw -z`, or `git
  ls-files --others` for untracked files — git's untracked walk never
  descends into a symlink) and proceeds only when that is exactly the
  one requested file; the names git reports — the old side of a rename
  included, which the client can only hint at — must pass the
  denylist (403 `restricted`), a directory or several matches is 400
  `not-a-single-file`, and no match is an empty diff; (3) the patch git
  then produces is refused if it spans more than one file. The window
  between (2) and the patch is a race the session owner could only run
  against themself inside their own container (these routes are
  owner-only), and (3) closes the "file became a directory" variant of
  it. The denylist stays name-based: a rename *away* from `.env` is
  listed as restricted (so the UI never asks), but requested without the
  old-name hint git reports an addition under the new, non-restricted
  name — the same bytes the Files view would preview under that name.
- **Read-only in deed.** Nothing here stages, commits or moves refs.
  `GIT_OPTIONAL_LOCKS=0` keeps `git status` from taking the index lock at
  all; `git diff` may still refresh the index's *stat cache* in place
  (identical tracked content, through the normal `index.lock` protocol,
  and it backs off silently if the user's own git holds the lock — both
  pinned by `gitReadOnly.integration.test.ts` against real git).
  `GIT_TERMINAL_PROMPT=0` prevents credential prompts from hanging a
  request; `GIT_CEILING_DIRECTORIES=/home/developer` stops repository
  discovery from walking above the workspace.
- **Bounded.** Each command runs under coreutils `timeout` (20 s) with a
  host-side backstop; stdout is capped (2 MiB status, 512 KiB diff, 256
  KiB log — `truncated` is reported, never silently cut); the change list
  is capped at 2000 entries and the log at 50 commits. Concurrent git
  requests are capped per user (2) and per process (8) with 429, on top
  of a per-IP rate limit — and a slot is held until the git process has
  actually *ended* and the response has been sent, not until the client
  hangs up: a docker exec cannot be cancelled, so a disconnecting client
  (or one that aborts a fetch) would otherwise turn the cap into no cap.
  For the same reason output past the byte cap is drained rather than
  the stream destroyed, so "finished" means the process exited (the
  in-container `timeout` bounds the drain). Within one request, parallel
  execs are awaited to completion even when one of them fails early
  (`allSettledOrThrow`), so a 403 decided by the location check is not
  sent — and the slot not returned — while the sibling git process is
  still running. The frontend sequences its own requests (status+log,
  then the open diff; a new diff or load waits for whatever is in
  flight, nothing is aborted) to stay within its two slots. The UI stops rendering a
  diff past 5000 lines on every rendering path.
- **Diagnostics.** On failure only the first line of git's stderr (capped,
  URL credentials scrubbed) reaches the client.

Known limitation: a stopped session can't be inspected. Running git on
the host in a throwaway, network-less sandbox container over a read-only
mount of the workspace would close that gap and is the documented
follow-up; it was left out of v1 to keep the trusted computing base of
the first version small.

## Optional: docker-socket-proxy

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

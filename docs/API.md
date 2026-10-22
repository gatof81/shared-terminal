# API reference

Auth is via the httpOnly cookie `st_token` set by `POST /api/auth/login` and `POST /api/auth/register`. JS cannot read the token. CSRF for state-changing JSON routes is handled by the CORS preflight + `Content-Type: application/json` requirement.

## Auth (public)

| Method | Path               | Description                                              |
| ------ | ------------------ | -------------------------------------------------------- |
| GET    | /api/auth/status   | First-visit setup probe + current auth + admin status    |
| POST   | /api/auth/register | Create account (invite code required after first user)   |
| POST   | /api/auth/login    | Set the auth cookie                                      |
| POST   | /api/auth/logout   | Clear the auth cookie                                    |

## Sessions (cookie-authed)

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
| GET    | /api/sessions/:id/ports       | Get the declared exposed-port set + `allowPrivilegedPorts`      |
| PATCH  | /api/sessions/:id/ports       | Live-edit the exposed-port set (applied without a recycle)      |
| GET    | /api/sessions/:id/tabs        | List tmux tabs for a session                                    |
| POST   | /api/sessions/:id/tabs        | Create a tab                                                    |
| DELETE | /api/sessions/:id/tabs/:tabId | Delete a tab                                                    |
| POST   | /api/sessions/:id/files       | Multipart file upload into the per-session uploads dir          |
| GET    | /api/sessions/:id/files?path= | Download one workspace file (owner-only; restricted paths 403)  |
| GET    | /api/sessions/:id/fs/list?path= | Workspace Explorer: list one directory level (owner-only)     |
| GET    | /api/sessions/:id/fs/preview?path= | Workspace Explorer: bounded text preview / kind sniff (≤1 MiB) |
| GET    | /api/sessions/:id/fs/raw?path= | Workspace Explorer: inline image bytes (allowlisted types, ≤10 MiB) |
| GET    | /api/sessions/:id/git/status[?dir=] | Git Changes: branch, ahead/behind, changed files by area with line counts (owner-only, session must be running) |
| GET    | /api/sessions/:id/git/diff?path=&area=[&oldPath=][&dir=] | Git Changes: one file's unified diff (≤512 KiB, `truncated` flag; restricted paths 403) |
| GET    | /api/sessions/:id/git/log[?dir=] | Git Changes: last 50 commits (`hash`, `shortHash`, `author`, `date`, `subject`) |
| POST   | /api/sessions/:id/exec        | Run a command, stream NDJSON output ([docs/EXEC_API.md](./EXEC_API.md)) |
| GET    | /api/sessions/:id/exec/:execId | Exec status: `running` / `exited` / `unknown`                  |
| POST   | /api/sessions/:id/exec/:execId/kill | Kill the exec's process group (race-free, idempotent)     |

`POST /api/sessions` accepts a typed `body.config` mirroring `SessionConfigSchema` in `backend/src/sessionConfig.ts`: `envVars` (typed entries with `plain` / `secret` discriminator), `repo` + `auth`, `ports[]` + `allowPrivilegedPorts`, `gitIdentity`, `dotfiles`, `agentSeed`, `postCreateCmd`, `postStartCmd`, `cpuLimit`, `memLimit`, `idleTtlSeconds`. Every field is optional; a bare `POST` (no `config`) creates a default session.

The Git routes are strictly read-only (no stage / commit / checkout / push exists) and run git **inside the session container**, so they answer `409 {code:"session-not-running"}` for a stopped session. `status` returns `{repo:false, candidates:[…]}` (top-level dirs holding a `.git`) when `dir` isn't a repository, otherwise `{repo:true, root, branch, detached, head, upstream, ahead, behind, changes[], truncated}` where each change is `{area: staged|unstaged|untracked|conflict, status, xy, path, oldPath, additions, deletions, binary, restricted}`. `area` on `diff` selects index-vs-HEAD (`staged`), worktree-vs-index (`unstaged`/`conflict`) or worktree-vs-`/dev/null` (`untracked`); `dir` must be the `root` reported by `status`. Errors carry `code`: `timeout` (504), `unsafe-repository` (409, git's `safe.directory` refusal), `git-failed` (502).

## Templates (cookie-authed)

| Method | Path                | Description                                                  |
| ------ | ------------------- | ------------------------------------------------------------ |
| POST   | /api/templates      | Create a template (config must be secret-stripped — see CLAUDE.md) |
| GET    | /api/templates      | List the user's templates (summary shape, no config)         |
| GET    | /api/templates/:id  | Get a template (full config)                                 |
| PUT    | /api/templates/:id  | Update name / description / config (owner-gated)             |
| DELETE | /api/templates/:id  | Delete a template (owner-gated)                              |

## Invites (admin)

| Method | Path                | Description                                                  |
| ------ | ------------------- | ------------------------------------------------------------ |
| POST   | /api/invites        | Mint a single-use invite code                                |
| GET    | /api/invites        | List invite codes (admin sees all rows, not just their own)  |
| DELETE | /api/invites/:hash  | Revoke an unused invite code (`:hash` is the 64-char hex SHA-256 digest returned by `GET /api/invites`, not the plaintext token) |

## Admin (admin)

Cross-user observability + force-actions surfaced to the admin dashboard. All routes are `requireAuth` + `requireAdmin`; see `CLAUDE.md` → "Admin endpoints" for the data shape.

| Method | Path                            | Description                                                                                  |
| ------ | ------------------------------- | -------------------------------------------------------------------------------------------- |
| GET    | /api/admin/stats                | Boot time, uptime, sessions by status, idle-sweeper / reconcile / dispatcher / D1 counters   |
| GET    | /api/admin/sessions             | Cross-user session list (capped at 500 rows, includes `userId` + `ownerUsername`)            |
| POST   | /api/admin/sessions/:id/stop    | Force-stop any session (no ownership gate). Returns 204                                      |
| DELETE | /api/admin/sessions/:id         | Force soft-delete any session                                                                |
| DELETE | /api/admin/sessions/:id?hard=true | Force hard-delete (also purges workspace + drops the D1 row)                               |
| GET    | /api/admin/users                | Users list with quota overrides, effective quotas, and current usage (#202)                  |
| PATCH  | /api/admin/users/:id/quotas     | Set per-user quota overrides; `null` clears back to the deployment default (#202)            |

## WebSocket

Two channels, both cookie-authed (browser sends `st_token` automatically on the upgrade handshake to the cookie's domain). CSWSH defence is independent: `isAllowedWsOrigin` rejects unlisted origins before the handshake completes.

```
wss://host/ws/sessions/<sessionId>?tab=<tabId>     # terminal attach
wss://host/ws/bootstrap/<sessionId>                # bootstrap pipeline live-tail
```

**Terminal — Client → Server:** `input`, `resize`
**Terminal — Server → Client:** `output`, `status`, `error`
**Bootstrap — Server → Client:** `output`, `done`, `fail`, `error`

## Port-exposure dispatcher

When `PORT_PROXY_BASE_DOMAIN` is set, requests to `https://p<containerPort>-<sessionId>.<base>` are diverted from the API/WS routes to the per-session reverse proxy (see `CLAUDE.md` → "Port-exposure dispatcher"). Auth gate: `public: false` ports require the `st_token` cookie owned by the session's owner; `public: true` ports skip auth (webhook / OAuth-callback shape).

The dispatcher reverse-proxies to `http://<container_name>:<containerPort>` over the shared `SESSIONS_NETWORK` (Docker embedded DNS) rather than a published host port, which is why opening/closing/re-scoping a port is a live edit with no container recycle.

### Live-editing exposed ports

- `GET /api/sessions/:id/ports` → `{ ports: [{ container, public }], allowPrivilegedPorts }`. Owner-gated. Reflects the **declared** config set, so a stopped session still returns its configured ports.
- `PATCH /api/sessions/:id/ports` with body `{ ports: [{ container: number, public: boolean }] }` replaces the whole set. Owner-gated. Validates range (1–65535), uniqueness, and `MAX_PORTS`. A privileged port (`< 1024`) is rejected with **400** unless the session was **created** with `allowPrivilegedPorts: true` — the `CAP_NET_BIND_SERVICE` capability is fixed at create time and can't be added to a live container, so adding one requires recreating the session. On success returns the updated session meta; changes take effect immediately on a running session.

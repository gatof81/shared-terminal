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
| PATCH  | /api/sessions/:id             | Metadata: `{name?, externalRef?}` — rename / set or clear the external ref |
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
| GET    | /api/sessions/:id/git/diff?path=&area=[&oldPath=][&dir=] | Git Changes: ONE file's unified diff — `path` must resolve to exactly one changed file (≤512 KiB, `truncated` flag; restricted paths 403; a conflicted file yields git's combined `diff --cc`) |
| GET    | /api/sessions/:id/git/log[?dir=] | Git Changes: last 50 commits (`hash`, `shortHash`, `author`, `date`, `subject`) |
| POST   | /api/sessions/:id/exec        | Run a command, stream NDJSON output ([docs/EXEC_API.md](./EXEC_API.md)) |
| GET    | /api/sessions/:id/exec/:execId | Exec status: `running` / `exited` / `unknown`                  |
| POST   | /api/sessions/:id/exec/:execId/kill | Kill the exec's process group (race-free, idempotent)     |

`POST /api/sessions` accepts a typed `body.config` mirroring `SessionConfigSchema` in `backend/src/sessionConfig.ts`: `envVars` (typed entries with `plain` / `secret` discriminator), `repo` + `auth`, `ports[]` + `allowPrivilegedPorts`, `gitIdentity`, `dotfiles`, `agentSeed`, `postCreateCmd`, `postStartCmd`, `cpuLimit`, `memLimit`, `idleTtlSeconds`. Every field is optional; a bare `POST` (no `config`) creates a default session. A top-level `acpAgent: {name, model?, effort?, runtime?, projectId?}` makes the session an ACP agent session — see [ACP_AGENTS.md](./ACP_AGENTS.md).

**What can change on an existing session.** Its id, container name (`st-<sid[:12]>`) and workspace path derive from the id, so none of these edits touches them:

| Edit | Route | Takes effect |
| ---- | ----- | ------------ |
| Name | `PATCH /api/sessions/:id {name}` | At once. Same rules as create (trimmed, 1–64 characters, not unique); operate tier (owner or admin). An ACP agent's `@name` is a separate identity and does not change |
| External ref | `PATCH /api/sessions/:id {externalRef}` | At once (`null` clears) |
| Exposed ports | `PATCH /api/sessions/:id/ports` | At once on a running session (a new port `< 1024` needs `allowPrivilegedPorts` from create) |
| CPU / memory / PIDs caps | `PATCH /api/admin/sessions/:id/resources` (admin) | At once (`docker update`), and persisted for the next create (`pidsLimit` 256–8192, v30; unset = 1024) |
| ACP agent: project, model, effort, slots | `PATCH /api/acp/agents/:name` | At once; model and effort are switched by the runner while the agent is idle; raising `maxConcurrency` (1–4) launches the new slots at once, lowering it lets the extra slots finish what they run |
| Environment variables | `PATCH /api/sessions/:id/env` | Stored at once; a container gets its environment when it is **created**, so a running or stopped container keeps the old one until it is re-created (soft delete + start) |
| Image, repository, auth, hooks, dotfiles, agent seed | — | Fixed at creation; the image changes when the container is re-created (soft delete + start); the rest needs a new session |

A `PATCH /api/sessions/:id` carrying both fields writes them in one statement; an invalid field fails the whole request with 400 and writes nothing, and an unknown key is a 400 too.

The Git routes are strictly read-only (no stage / commit / checkout / push exists) and run git **inside the session container**, so they answer `409 {code:"session-not-running"}` for a stopped session. `status` returns `{repo:false, candidates:[…]}` (top-level dirs holding a `.git`) when `dir` isn't a repository, otherwise `{repo:true, root, branch, detached, head, upstream, ahead, behind, changes[], truncated}` where each change is `{area: staged|unstaged|untracked|conflict, status, xy, path, oldPath, additions, deletions, binary, restricted}`. `area` on `diff` selects index-vs-HEAD (`staged`), worktree-vs-index (`unstaged`/`conflict`) or worktree-vs-`/dev/null` (`untracked`); `dir` must be the `root` reported by `status`; `oldPath` is only a hint that lets git detect a rename — the names git itself reports are what is checked and diffed. Errors carry `code`: `timeout` (504), `unsafe-repository` (409, git's `safe.directory` refusal), `git-failed` (502), `outside-workspace` (403, `dir` reaches a repository through a symlink or a redirected worktree), `restricted` (403, a path git resolved for this diff is on the credential denylist), `not-a-single-file` (400, the pathspec is a directory or matches several entries). Concurrency: at most 2 git requests in flight per user and 8 per process (429 + `Retry-After`), a slot being held until the git process has ended — not until the client disconnects.

**`?work=<id>`** on the Files and Git routes reads an ACP work's worktree (`<workspace>/.st/ctx/<id>`) instead of the workspace: the work must be this session's agent's and not `cleaned`, else the same 404 as a missing session (`backend/src/routes/workRoot.ts`). The client never sends a path into `.st/`.

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
| GET    | /api/admin/stats[?top=N]        | Boot time, uptime, sessions by status, idle-sweeper / reconcile / dispatcher / D1 counters; `top` (1–200, default 10) = statements in the D1 rows-read breakdown |
| GET    | /api/admin/sessions             | Cross-user session list (capped at 500 rows, includes `userId` + `ownerUsername`)            |
| POST   | /api/admin/sessions/:id/stop    | Force-stop any session (no ownership gate). Returns 204                                      |
| DELETE | /api/admin/sessions/:id         | Force soft-delete any session                                                                |
| DELETE | /api/admin/sessions/:id?hard=true | Force hard-delete (also purges workspace + drops the D1 row)                               |
| PATCH  | /api/admin/sessions/:id/resources | `{cpuLimit?, memLimit?, pidsLimit?}` — persist, then `docker update` the running container (409 when memory can't shrink below usage) |
| GET    | /api/admin/users                | Users list with quota overrides, effective quotas, and current usage (#202)                  |
| PATCH  | /api/admin/users/:id/quotas     | Set per-user quota overrides; `null` clears back to the deployment default (#202)            |

## Projects

| Method | Path | Description |
| ------ | ---- | ----------- |
| POST   | /api/projects | `{name, clientRequestId}` — idempotent create (409 `project-limit`, 503 `outcome-unknown`: retry with the same id) |
| GET    | /api/projects | Live projects with `agentCount` |
| PATCH  | /api/projects/:pid | `{name}` — rename a live project (same rules as create; archived or foreign ⇒ 404); returns the project with `agentCount`. Agents and messages reference the id, so nothing else changes |
| DELETE | /api/projects/:pid | Archive (its agents leave it) |

See [PROJECTS.md](./PROJECTS.md).

## ACP agents

Mounted at `/api/acp`. Two callers share it: the person (cookie) and an agent's runner or `st` CLI (`Authorization: Bearer acp1.…`); the sender of a message is always the credential. Model, states, scope and recovery: [ACP_AGENTS.md](./ACP_AGENTS.md).

| Method | Path | Caller | Description |
| ------ | ---- | ------ | ----------- |
| GET    | /api/acp/agents | both | The owner's agents: `name`, `sessionId`, `runtime`, `model`/`modelApplied`, `effort`/`effortApplied`, `maxConcurrency`, `projectId`, `skills`, `running`, `runningIn`, `pending`, `queue`, `waitingFor`, `heldBy`, `waitingInput`, `question`, `authRequired`, `loginMethods`, `runnerSeenAt` |
| PATCH  | /api/acp/agents/:name | person | `{projectId?, model?, effort?, maxConcurrency?}` — at least one |
| POST   | /api/acp/agents/:name/login | person | `{methodId}` — opens a Terminal tab running the adapter's login command |
| GET    | /api/acp/runtimes | person | `{default, available}` — installed adapter runtimes |
| POST   | /api/acp/messages | both | `{to, body, conversationId?, team?, work?, task?, projectId?, clientId?}` — stored in D1 before the 201 (200 `replayed` for a retried `clientId`). The person posts in a topic (`conversationId`; `to` a list or `team: true` = one row per recipient); an agent's scope, topic and task come from the message it is running. Shapes and errors: [ACP_AGENTS.md §4b](./ACP_AGENTS.md#4b-conversations-v27) |
| GET    | /api/acp/messages[?agent=&before=] | both | Messages, newest page first returned oldest-first (an agent sees its own) |
| GET    | /api/acp/messages/:id | both | One message with its result |
| POST   | /api/acp/messages/:id/requeue | person | `uncertain` → `pending` (409 `not-uncertain`) |
| POST   | /api/acp/messages/:id/review | person | «Dar por revisada»: an interruption leaves Pendientes |
| POST   | /api/acp/conversations | person | `{projectId, title, clientRequestId}` — idempotent create of a topic |
| GET    | /api/acp/projects/:pid/conversations[?archived=1] | person | A project's topics, most recently active first |
| PATCH  | /api/acp/conversations/:id | person | `{title}` — rename |
| POST   | /api/acp/conversations/:id/archive | person | Archive (idempotent; no new posts) |
| POST   | /api/acp/conversations/:id/read | person | `{at}` — read mark, only advances |
| GET    | /api/acp/conversations/:id/feed[?before=] | person | A topic: messages, its agents, questions, activity |
| GET    | /api/acp/agents/:name/feed[?before=] | person | The Archive's direct chat of an agent (messages with no topic) |
| GET    | /api/acp/projects/:pid/feed[?before=] | person | The Archive's old Project Chat (messages with no topic) |
| GET    | /api/acp/inbox | person | Pendientes: open questions + unreviewed interruptions (+ unseen results) |
| POST   | /api/acp/questions/:id/answer | person | `{action: accept\|decline\|cancel, content?}` — once (409 `not-open`) |
| POST   | /api/acp/works | both | `{agent, id, base?}` — create a work (worktree `work/<id>` in the agent's container) — [ACP_AGENTS.md §3c](./ACP_AGENTS.md#3c-works-v26) |
| GET    | /api/acp/works | both | The owner's works (an agent: its own and its project's) |
| POST   | /api/acp/works/:id/close | both | Close (nothing pending or running) |
| POST   | /api/acp/works/:id/clean | both | Remove the worktree, or `cleanup-pending` with every reason |
| POST / GET | /api/acp/tasks | both | Create a goal or task / list the project's — [ACP_AGENTS.md §4c](./ACP_AGENTS.md#4c-tasks-v29) |
| GET    | /api/acp/tasks/summary | both | open / blocked / awaitingOwner counts (the rail) |
| GET / PATCH | /api/acp/tasks/:id | both | One task with its derived state / a write carrying `version` (409 `stale`) |
| POST   | /api/acp/tasks/:id/links | both | `{kind: work\|pr\|dep\|external, …}` |
| POST   | /api/acp/tasks/:id/budget | person | Raise a task's or goal's request budget |
| POST   | /api/acp/tasks/:id/scope-approved | both | `{version, questionId?}` — a goal's scope approved by the person through a question (`st task scope-approved`) |
| *      | /api/acp/runner/… | agent | Runner protocol — internal: `running`, `claim`, `system-message`, `messages/:id/result`, `messages/:id/release`, `model`, `effort`, `skills`, `auth-methods`, `questions`, `questions/:id`, `questions/:id/{delivered,withdrawn}`, `questions-orphan`, `activity` |

## WebSocket

All channels are cookie-authed (browser sends `st_token` automatically on the upgrade handshake to the cookie's domain). CSWSH defence is independent: `isAllowedWsOrigin` rejects unlisted origins before the handshake completes. The admitted paths are `WS_PATH_PREFIXES` in `backend/src/wsUpgrade.ts`.

```
wss://host/ws/sessions/<sessionId>?tab=<tabId>     # terminal attach
wss://host/ws/bootstrap/<sessionId>                # bootstrap pipeline live-tail
wss://host/ws/acp                                  # ACP messages, questions and activity of the owner
```

**Terminal — Client → Server:** `input`, `resize`
**Terminal — Server → Client:** `output`, `status`, `error`
**Bootstrap — Server → Client:** `output`, `done`, `fail`, `error`
**ACP — Server → Client:** `hello` first, then every message row, question, activity batch, `agents` change, topic (`conversation`) and `task` of the owner. Nothing is replayed: a client reloads its page over REST on every (re)connect.

## Port-exposure dispatcher

When `PORT_PROXY_BASE_DOMAIN` is set, requests to `https://p<containerPort>-<sessionId>.<base>` are diverted from the API/WS routes to the per-session reverse proxy (see `CLAUDE.md` → "Port-exposure dispatcher"). Auth gate: `public: false` ports require the `st_token` cookie owned by the session's owner; `public: true` ports skip auth (webhook / OAuth-callback shape).

The dispatcher reverse-proxies to `http://<container_name>:<containerPort>` over the shared `SESSIONS_NETWORK` (Docker embedded DNS) rather than a published host port, which is why opening/closing/re-scoping a port is a live edit with no container recycle.

### Live-editing exposed ports

- `GET /api/sessions/:id/ports` → `{ ports: [{ container, public }], allowPrivilegedPorts }`. Owner-gated. Reflects the **declared** config set, so a stopped session still returns its configured ports.
- `PATCH /api/sessions/:id/ports` with body `{ ports: [{ container: number, public: boolean }] }` replaces the whole set. Owner-gated. Validates range (1–65535), uniqueness, and `MAX_PORTS`. A privileged port (`< 1024`) is rejected with **400** unless the session was **created** with `allowPrivilegedPorts: true` — the `CAP_NET_BIND_SERVICE` capability is fixed at create time and can't be added to a live container, so adding one requires recreating the session. On success returns the updated session meta; changes take effect immediately on a running session.

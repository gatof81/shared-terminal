# Project & agent directory (P3a) — binding contract

Status: **P3a**, behind `PROJECT_CHAT_ENABLED` (off by default). Design source: `docs/design/project-chat/`
(PR #512) — 03-protocol §1/§2.1/§6.1, 14-agent-teams-research (AD1–AD12), 15-ux-alignment-and-contract
(§3, amendments E-1…E-9, decisions D-UX0…D-UX10, approved 2026-11-07). Change this document before the
code, never the other way round.

P3a is the directory only: projects, agents with an identity of their own, and the versioned agent ↔
session binding. It is **not** chat, Channels, deliveries, the monitor, MCP tools, tasks or dispatch,
G3-2, templates with UI, rebinding, per-project networks, or automatic agent activation. It does not
unblock P3, T1, T2 or T3. Binding a session changes **nothing** about it: not its container, its token,
its capture, its composer or its CLI conversations.

## 1. Flag and compatibility

| `PROJECT_CHAT_ENABLED` | Behaviour |
| --- | --- |
| unset / anything but `true`/`1` (default) | `/api/projects*` do not exist (the same 404 as any unknown path, also unauthenticated — never 401). `GET /api/auth/status` has exactly its previous keys. `GET /api/sessions` rows have no `binding` key and the request reads nothing of the directory. Boot logs are unchanged. The hard-delete guard (§6) stays armed: with no binding the delete is the previous one plus two D1 reads (before the kill and before the purge). |
| `true` / `1` | The routes of §4 are mounted; `features: {projectChat: true}` on `/api/auth/status`; `binding` on `/api/sessions` rows (§4.6); the hard-delete guard (§6). |

**Migration v19 runs at boot whatever the flag says.** The flag gates the API, not the schema. Deploying
this code therefore applies v19 to D1 on the first boot even with the flag off. v19 is additive (four new
tables, three indexes, two triggers; no existing column touched), idempotent (every statement is
`IF NOT EXISTS`; a boot that dies part-way converges on the next), and compatible with the previous
backend: that code never reads the new tables, and nothing in them references `sessions`, so its hard
delete keeps working (§2). There is no down-migration; rolling the code back leaves the tables inert.
Turning the flag off after agents exist keeps every row, and **this** backend keeps refusing a hard delete
of a bound session (§6) with the flag off: turning the flag off is a safe kill switch. While it is off
the agent routes do not exist, so such a session cannot be hard-deleted at all; the way out is to turn
the flag back on and remove the agent. Rolling the
**code** back is not the same thing: the previous backend does not know the bindings (§8).

## 2. Schema (D1 v19)

```sql
projects(project_id PK, owner_user_id → users, name, client_request_id, request_hash,
         created_at, archived_at)                       -- UNIQUE(owner_user_id, client_request_id)
project_agents(agent_id PK, project_id → projects, handle, provider ∈ {'claude-code'}, role,
               template_id, template_version, created_at, removed_at)   -- UNIQUE(project_id, handle)
agent_bindings(binding_id PK, agent_id → project_agents, epoch, st_session_id, state ∈
               {active, draining, retired}, created_at, retired_at, retire_reason)
               -- UNIQUE(agent_id, epoch)
               -- UNIQUE(agent_id)      WHERE state IN ('active','draining')
               -- UNIQUE(st_session_id) WHERE state IN ('active','draining')
project_agent_creations(owner_user_id, client_request_id PK pair, request_hash, project_id, agent_id,
                        binding_id, st_session_id, handle, role, created_at)
trigger trg_project_agent_creation  AFTER INSERT ON project_agent_creations
trigger trg_project_agent_removed   AFTER UPDATE OF removed_at ON project_agents
```

Differences from 03 §2.1, all implementation-level (no API meaning changes):

- `agent_bindings.st_session_id` has **no foreign key**. D1 enforces foreign keys, so a reference would
  make the hard delete of any session that was ever bound fail forever (history is never deleted), and
  `ON DELETE CASCADE` would erase the history the agent page shows.
- `projects.client_request_id`/`request_hash` and the `project_agent_creations` table are the durable
  idempotency records (E-1, E-9).
- `project_agent_edges`, `chats` and `chat_participants` are not created (P3).
- `template_id`/`template_version` exist and stay NULL (AD4; templates are E3).

Invariants, each enforced by the database, not by a check before the write:

1. An agent belongs to exactly one project (`project_agents.project_id`, one column).
2. At most one live (`active`/`draining`) binding per agent and per session — across projects.
3. An agent and its first binding exist together or not at all.
4. Removing an agent retires its live binding in the same statement; nothing is deleted.
5. A binding's session belongs to the agent's project owner and was not soft-deleted when bound.

## 3. Atomicity, idempotency and recovery

D1 over HTTP runs each call as its own statement; no property spans two calls.

- **Agent creation is one statement.** `POST …/agents` inserts its creation record; the trigger checks
  the preconditions (`RAISE(ABORT, 'st:<code>')`: project not the caller's or archived, session not the
  caller's or terminated, 32 live agents) and inserts the agent and its `epoch: 1` binding. SQLite runs
  the trigger inside the statement, so any failure (a RAISE, the handle UNIQUE, the live-session index)
  rolls back the record, the agent and the binding together.
- **Project creation is one statement** (`INSERT … SELECT … WHERE count < 50`).
- **Removal is one statement** (the `removed_at` UPDATE; its trigger retires the binding).
- **Idempotency.** Every creation carries `clientRequestId` (UUID v4, a new one per user action). The
  record is keyed by (owner, `clientRequestId`): a retry can never create a second project or agent.
  Same id with a different body ⇒ 409 `idempotency-conflict`. A replay answers 201 with
  `replayed: true` and the current state of what the first request created.
- **Unknown outcome.** When D1's answer does not prove the outcome (timeout, network error, non-2xx
  without D1's own refusal), the backend reads the record back: found ⇒ the creation happened and is
  answered (201, `replayed: true`); not found ⇒ **503 `outcome-unknown`**, because the lost write can
  still land later. The client retries with the **same** `clientRequestId`; that is safe in every case.
  The backend itself never retries. Only a refusal the backend **recognises** proves "not applied":
  D1's `success: false` envelope (with a 2xx or a 4xx status — the Cloudflare API may answer a failed
  statement with 400) whose message is SQLite's own abort of this statement (the trigger's `st:<code>`,
  the handle UNIQUE, the live-session index) — answered with its code (§4.7). Anything else — a
  timeout, a 5xx, an envelope it does not recognise (D1 reports transient write errors such as
  "Network connection lost" in the same shape, and the write may have committed) — is resolved by the
  read-back and otherwise answered 503 `outcome-unknown`. Removal never trusts an error: it always
  reads back.
- **After a 503, a later refusal is final only for that attempt.** The lost attempt can still land
  after a retry with the same id was refused (e.g. `session-taken` while another agent held the
  session, which was then removed). Whenever a refusal follows a 503 for the same `clientRequestId`, the
  client re-reads the agent list (or retries once more with the same id: it replays if the earlier
  attempt landed). The database stays consistent either way; only that answer can be stale.
- **Restart.** No in-memory state is needed for correctness. The only process-local state is the 30 s
  binding cache of §4.6, rebuilt on demand.
- **Restore.** `backup.ts` carries the four tables (`sinceSchema: 19`), creation records last; the
  creation trigger skips an agent that already exists, so a restore (or a `--force` re-run) re-creates
  nothing.

## 4. API (owner-only, cookie JWT)

Owner-only (R5): another user's project or agent, a missing one, and an id that cannot be one all answer
the same 404 — admins and group leads included. There is no `members[]`, no admin/lead/observe access.
Every response carries `Cache-Control: no-store`. Rate limit: `projectIp`, 120/min per IP.

Field phases: every field below is P3a. A field of a later phase (T1 `activeTask`, T2 `queue`, P6
`runtime`, P3 `hostChat`) **never appears** before its phase; reserved columns (`template`) appear as
`null`.

### 4.1 `POST /api/projects`

```jsonc
// request
{ "name": "Educación HZ", "clientRequestId": "0b7c…-4…" }       // name: 1–80, trimmed, NFC, no controls
// 201
{ "projectId": "6b1f2c3d-…", "name": "Educación HZ", "createdAt": "2026-11-10T13:00:00.000Z",
  "agentCount": 0, "replayed": false }
```
Errors: 400 `invalid-body` / `invalid-name` / `invalid-client-request-id`; 409 `project-limit` (50 per
owner), `idempotency-conflict`; 503 `outcome-unknown`.

### 4.2 `GET /api/projects`

```jsonc
{ "projects": [ { "projectId": "…", "name": "Educación HZ", "createdAt": "…", "agentCount": 5 } ],
  "can": { "createProject": { "allowed": true } } }     // { "allowed": false, "reason": "project-limit" }
```

### 4.3 `POST /api/projects/:pid/agents` (E-1)

```jsonc
// request — sessionId is mandatory in P3a (binding later is E4); role optional (≤ 60, free text, AD3)
{ "handle": "developer-hz", "role": "Developer", "sessionId": "a724…", "clientRequestId": "…" }
// 201 — the creation receipt
{ "agentId": "a0…a2", "projectId": "6b1f…", "handle": "developer-hz", "role": "Developer",
  "provider": "claude-code", "template": null, "createdAt": "…", "removedAt": null,
  "binding": { "bindingId": "b0…b2", "epoch": 1, "sessionId": "a724…", "state": "active" },
  "replayed": false }
```
Errors: 400 `invalid-body` / `invalid-handle` (`^[a-z][a-z0-9-]{1,31}$`) / `invalid-role` /
`invalid-session-id` / `invalid-client-request-id`; 404 `project-not-found`, `session-not-found` (not the
caller's, missing, or soft-deleted); 409 `handle-taken` (handles of removed agents stay reserved —
03 `UNIQUE(project, handle)`), `session-taken` (the session has a live binding, in this or any project),
`agent-limit` (32 live agents), `idempotency-conflict`; 503 `outcome-unknown`. A `stopped` or `failed`
session can be bound.

### 4.4 `GET /api/projects/:pid/agents` (E-2)

≤ 2 D1 reads (the directory, then the capture's conversation rows of the bound running sessions); no
probe, no Docker. Ordered by creation time, then handle. Removed agents are not listed (their page still
resolves, §4.5).

```jsonc
{ "projectId": "6b1f…", "generatedAt": "2026-11-10T14:02:45.000Z",
  "agents": [
    { "agentId": "a0…a2", "handle": "developer-hz", "role": "Developer", "provider": "claude-code",
      "template": null,
      "binding": { "bindingId": "b0…b2", "epoch": 1, "sessionId": "a724…", "state": "active",
                   "createdAt": "…" },
      "presence": { "value": "working", "source": "hook", "at": "2026-11-10T14:02:40.000Z" } }
  ],
  "can": { "createAgent": { "allowed": true } } }      // { "allowed": false, "reason": "agent-limit" }
```

### 4.5 `GET /api/projects/:pid/agents/:aid` (E-3)

Also for a removed agent. `bindings` is the whole history, by epoch. `generatedAt` is the server clock
at the read that decided `presence`, the same as in §4.4. It lets a client age `presence.at` without
loading the list first (#569).

```jsonc
{ "agentId": "a0…a2", "projectId": "6b1f…", "generatedAt": "2026-11-10T14:02:45.000Z",
  "handle": "developer-hz", "role": "Developer",
  "provider": "claude-code", "template": null, "createdAt": "…", "removedAt": null,
  "capabilities": { "capture": true, "channels": false, "directControl": true },  // declared by the provider
  "binding": { "bindingId": "b0…b2", "epoch": 1, "sessionId": "a724…", "state": "active", "createdAt": "…" },
  "bindings": [ { "bindingId": "b0…b2", "epoch": 1, "sessionId": "a724…", "state": "active",
                  "createdAt": "…", "retiredAt": null, "retireReason": null } ],
  "presence": { "value": "working", "source": "hook", "at": "…" },
  "can": { "remove": { "allowed": true } } }           // removed ⇒ { "allowed": false, "reason": "agent-removed" }
```

### 4.6 `DELETE /api/projects/:pid/agents/:aid` and `GET /api/sessions` (E-4)

`DELETE` sets `removed_at` and retires the live binding (`retired`, `retireReason: "agent-removed"`) in
one statement → 204. Idempotent (a removed agent answers 204 again). 404 `agent-not-found`;
503 `outcome-unknown` when the answer was lost and the read-back could not prove it landed.

`GET /api/sessions` (flag on): each row gains `binding` — `{projectId, agentId, handle, bindingId,
epoch}` for a live binding, `null` for an unbound session («Sesiones sin asignar»). **The key is absent
when the directory read failed** (= unknown; the list itself still answers). One D1 read per owner per
30 s, cached; a create or remove invalidates the owner's entry before and after its statement, and a read
that raced a write never stores its result.

### 4.7 Error codes

| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid-body`, `invalid-name`, `invalid-handle`, `invalid-role`, `invalid-session-id`, `invalid-client-request-id` | validation |
| 404 | `project-not-found`, `agent-not-found`, `session-not-found` | missing, foreign, or (session) soft-deleted |
| 409 | `handle-taken`, `session-taken`, `agent-limit`, `project-limit`, `idempotency-conflict` | §4.1/§4.3 |
| 409 | `agent-active` | hard delete of a bound session (§6) |
| 503 | `outcome-unknown` | the outcome could not be proven; retry with the same `clientRequestId` (also for `DELETE`, which is idempotent) |
| 500 | `internal` | a failure outside the write (e.g. a read of the directory) |

Bodies are `{ "error": "<code>", "message": "<text>" }`. The UI branches on `error`, never on `message`.

## 5. Presence

Derived only from `sessions.status` and the capture's `claude_conversations` rows (CONVERSATION.md §5):
no probe, no Docker, no second state machine. D1 rows lag the resident indexes by ≤ 30 s (heartbeat);
the Chat view may be up to that much ahead.

| `value` | When | `source` / `detail` |
| --- | --- | --- |
| `disconnected` | session row gone · session not `running` · deciding conversation `disconnected`/`ended` · no live binding | `session` + `session-gone`/`session-<status>`; capture evidence + `ended`/`disconnected`; `directory` + `agent-removed`/`unbound` |
| `working` | `running` / `waiting_background` | capture evidence (`hook`, `probe`, …) |
| `waiting_input` | `waiting_input`; `verified: true` only when the evidence is a probe | |
| `needs_attention` | `waiting_permission` | `detail: "waiting_permission"` |
| `unknown` | no conversation · capture unreadable · live claim with evidence ≥ 10 min old · `error`/`ending`/`unknown` | `detail`: `capture-unreadable`, `stale`, or the capture status |

**`source` is a closed list (#569).** It is the prefix of the deciding conversation's
`statusEvidence`, or presence's own source:

| `value` | possible `source` |
| --- | --- |
| `working`, `waiting_input`, `needs_attention` | only `hook` or `probe`: the state machine only produces live states from hook or probe evidence (CONVERSATION.md §5.3) |
| `disconnected` | `session` (the session row), `directory` (`unbound`/`agent-removed`), `hook` or `probe` (`ended`), `reconcile` (container down) |
| `unknown` | `capture` (no conversation / capture unreadable), `timeout` (silence), `reconcile`, `reopened`, `created`, `binding_lost`, `hook` (`SessionStart`, `error`, `ending`), or the live claim's own `hook`/`probe` when `stale` |

A value not in this list means a later contract; a client shows it as "state unknown".

**`needs_attention` can come from a probe alone.** A probe that sees the CLI waiting on a permission
prompt (`probe:waiting`) yields `needs_attention` with `source: "probe"`. Presence passes it on as it
is, because the value is true evidence that the prompt is on screen. How clients read it today:
- **The project page** follows the owner's rule of 2026-11-09 (#569): only the CLI's own `hook`
  evidence means "needs you", so it shows a `probe`-sourced `needs_attention` as "State unknown".
- **The Chat switcher's** attention rule (`attentionRule.ts`, #553 option A) does not look at the
  source, so the same conversation shows "Needs you" there.

The two surfaces disagree. Aligning them is a separate decision.

**Deciding conversation:** among the session's conversations whose pane is bound (bindings are released
at every container stop, so a bound pane is the current start), the one with the newest evidence
(max of `statusAt`, `lastEventAt`). `at` is that evidence's time, `null` when there is none.
`no_channel`, `degraded`, `ambiguous` are P6 and never appear in P3a.

## 6. Hard delete of a bound session

`DELETE /api/sessions/:id?hard=true` and `DELETE /api/admin/sessions/:id?hard=true` answer **409
`agent-active`** while the session has a live binding, checked under the session lifecycle lock **before
any effect** (no kill, no purge, row kept). The guard is armed **whatever the flag says**: bindings created
while it was on outlive turning it off, and v19 exists from the first boot of this code. The check is
uncached and fail-closed: a failed read refuses the delete (500). The owner removes the agent first (with
the flag off that needs the flag back on, §1). Soft
deletes are not refused and read nothing of the directory: the row stays, the binding stays readable
(`disconnected · session-terminated`).

Agent creation does not take the session lock, so the check runs **twice**: before the kill, and again
after the session is `terminated` and before the purge. One that landed in between is caught there and
the delete stops as an ordinary soft delete (409 `agent-active`, row kept as `terminated`, nothing
purged). After the second check no binding can appear, because two rules hold together:

1. the creation trigger refuses a `terminated` session (§3), inside the INSERT statement itself;
2. nothing turns a `terminated` row back: the only status writer that runs outside the session lock is
   the bootstrap's hard-fail flip (`failSession`), and it is **one conditional statement**
   (`SessionManager.markFailed`: `… SET status = 'failed' WHERE session_id = ? AND status != 'terminated'`).
   Every other writer (start, stop, kill, terminate, recreate) holds the lock the delete holds, and
   `reconcile()` runs before the server listens.

So a purge never runs while a live binding exists, and a deleted session never comes back as `failed`.
`directory.sqlite.test.ts` (“hard delete vs a failing bootstrap”) lands the flip and a creation inside
the kill and inside the purge, and races all three 60 times with the racers aimed after the kill. With
`markFailed` reverted to the unconditional UPDATE, those tests fail (the race in 8 of 8 runs); a control
test shows the old flip re-opening the window. `markFailed` changes the flag-off behaviour in exactly one
case, the bug it fixes: a bootstrap failing after a delete no longer rewrites `terminated` to `failed`.

Residual (pre-existing, not P3a's): the create route's rollback drops a session row whose spawn failed.
The row is visible while the spawn runs, so an agent created on it in those seconds is left bound to a
session that no longer exists. It reads `disconnected · session-gone` (§5), the agent can be removed, and
nothing operates on bindings in P3a. A row drop conditional on no live binding there is a precondition
for P3/T1, which will act on bindings.

## 7. Isolation limits

No agent can belong to two projects or reach another project's agents or bindings through this API.
This is **API isolation only**: every session container still joins the shared `sessions-net` and can
reach other session containers by name (CLAUDE.md, #291). Projects do not isolate networks.

## 8. Rollback

There is no down-migration and none is needed: the previous backend's `migrateDb()` finds every version
it knows (1–18) in the ledger and applies nothing; it never reads the four tables, and nothing in them
references `sessions`. **Never drop the v19 tables or edit the ledger** to "undo" v19: re-upgrading would
recreate them empty and the binding history would be lost.

| Case | What the previous backend does with it | Safe rollback |
| --- | --- | --- |
| **A.** v19 applied, flag never on, no project created | nothing: the tables are empty and unread | yes, no precondition. A later re-upgrade finds v19 recorded and applies nothing |
| **B.** flag was on, agents with live bindings exist | ignores them. (1) Its hard delete is **not** guarded: a bound session can be purged and its row dropped. (2) Its `failSession` rewrites `terminated` to `failed` again. (3) Its `npm run backup` does not export the four tables, so a backup taken under it has no directory. | only under the conditions below |

**Backups taken while the previous backend runs (both cases).** Its `npm run backup` writes
`schemaVersion` = the ledger's maximum, **19**, but exports only the tables it knows: none of the four.
Consequences:

- the previous backend's own `npm run restore` **refuses** that backup on a fresh D1 ("backup schema v19
  is NEWER than this code's v18"). Restore it with this backend or a later one, or onto a target that is
  already at v19;
- this backend restores it with the four tables **empty** and logs one `WARN` per table
  (`no <table>.jsonl although the backup is schema v19`). In case A that loses nothing. In case B the
  directory is lost, so take the recovery-point backup with **this** backend (condition 2 below).

Conditions for a rollback in case B, in order of preference:

1. **Do not roll back the code; turn the flag off.** This backend with the flag off keeps every row,
   keeps the hard-delete guard and keeps `markFailed`. It is the kill switch for the directory.
2. If the code must go back: **before** the rollback, take `npm run backup` with **this** backend (it
   exports the four tables) and keep it as the directory's recovery point; then either
   - remove every agent through the API (`DELETE /api/projects/:pid/agents/:aid`): their bindings retire,
     no session is protected any more, and the rollback is case A plus inert history rows; or
   - keep the agents and impose, for as long as the previous backend runs, an **operator rule: no hard
     delete of a bound session**. The bound sessions are
     `SELECT st_session_id FROM agent_bindings WHERE state IN ('active','draining')` (a read).
3. After re-upgrading, a binding whose session was purged in between reads
   `disconnected · session-gone` (§5) and its agent can be removed; nothing else acts on it in P3a.


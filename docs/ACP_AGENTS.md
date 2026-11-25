# ACP agents and Project Chat

> **Status:** implemented, always on. Tested with
> Claude only (adapter `@agentclientprotocol/claude-agent-acp`). This page describes the code on `main`.
> Developer-level detail: [CLAUDE.md → ACP agents](../CLAUDE.md) and the code (`backend/src/acp/`,
> `backend/src/routes/acp.ts`, `acp-runtime/`). Anything marked *provisional* may change.

## 1. Model

**A session is an execution environment; an agent is what works in it.**

- A **session** is a Docker container plus a workspace on the host (`<WORKSPACE_ROOT>/<sessionId>`).
  Every session has Terminal (tmux), Files and Git, with or without an agent.
- An **ACP agent** is a named identity (`@developer`) created together with one session
  (`acp_agents`, D1 v21; deleted with the session on hard delete). It has its own context (its ACP
  session), its own workspace and repository, and the tools of its container.
- Inside the container, Shared Terminal's **runner** (`acp-runtime/runner.mjs`) is a direct
  [ACP](https://agentclientprotocol.com) client: JSON-RPC over the stdio of a provider **adapter**.
  No tmux, no terminal scraping.
- All messages — person → agent and agent → agent, individual chat and Project Chat — go through
  **one durable message API** (`/api/acp`, table `agent_messages`).

```
person (web) ──┐                                  ┌── runner ──ACP──▶ adapter ──▶ model
               ├──▶ POST /api/acp/messages ──▶ D1 ┤   (session container, one message at a time)
agent (st send)┘      (stored before the 201)     └── results, replies, questions, activity
                                                        └──▶ /ws/acp ──▶ web
```

**Traditional sessions** (no agent) are worked from their Terminal and have no Chat. The Composer —
typing into a CLI in tmux from the Chat — and the Composer-based project conversation (D1–D3) were
**removed** on 2026-11-18; the read-only conversation capture, on 2026-11-22.

## 2. Runtime independent of the image

The session image knows nothing about agents. The runner, the `st` CLI and each pinned adapter
version live in a host directory, by default `<WORKSPACE_ROOT>/.acp-runtime` (`ACP_RUNTIME_DIR`),
bind-mounted **read-only** at `/opt/st-acp` only into agent sessions:

```
.acp-runtime/
  st/                       runner.mjs, bin/st — copied from the backend image at every boot
  claude-acp-0.108.0/       one directory per adapter version (acp-runtime/install.sh)
    agent                   the entry point the runner executes
  st-test-agent/            only with ACP_TEST_RUNTIME=1: deterministic adapter, no model
```

- An adapter upgrade is a new directory, not an image rebuild. Each agent keeps the runtime it was
  created with; `GET /api/acp/runtimes` lists the installed ones and the new-session form offers them.
- A backend upgrade replaces `st/`; a running runner restarts into the new version as soon as it is idle.
- The session image still ships the Claude Code CLI, used for the Terminal (and for logging in from
  it). Nothing in Shared Terminal checks its version.

## 3. Messages

`POST /api/acp/messages {to: "@name", body, projectId?, clientId?}` is the only way to send. The row
is inserted in D1 **before** the `201`. The sender is always the credential — the person's cookie or
the agent's token — never a field of the body. Bodies are capped at `ACP_MESSAGE_MAX_BYTES`
(256 KiB; 413 above). A `clientId` makes the send idempotent per recipient. A retry with the same
sender, body and scope answers `200` with `replayed: true` and the first row. The same id with
anything else is refused with `409 client-id-reused`, never answered with another message's row.

| State | Meaning |
| --- | --- |
| `pending` | stored, waiting for the recipient |
| `running` | claimed by one of the recipient's slots (at most one per agent and context) |
| `done` | the turn ended and every background task it started ended (or was declared persistent) |
| `failed` | the turn ended with an error |
| `uncertain` | the run was interrupted (runner, adapter or container died mid-turn) |

- **FIFO, one at a time per agent and context.** The claim is one conditional UPDATE: the oldest
  `pending` the claiming slot may run, only if nothing of its context is `running`, the slot is free,
  the agent is under `max_concurrency` and the backend under `ACP_MAX_RUNNING`. Different agents work
  in parallel. See §3b.
- **Never resent.** An interrupted run becomes `uncertain`; only the person can requeue it
  (`POST /api/acp/messages/:id/requeue`). After a restart the agent receives one `system` message
  asking for a read-only report of what was left done or undone.
- **Reviewed, not requeued.** The person may instead mark it reviewed (`POST …/:id/review`, §4b): it
  leaves the inbox and stays `uncertain`.
- A message given back before its prompt left (e.g. the agent is not logged in) returns to `pending`,
  not `uncertain`.
- **Done means idle.** The runner closes a message only when the prompt is answered **and** every
  background task it started has ended. Never by a timer.
- **Replies between agents are automatic.** When an agent's request to another agent ends `done`, the
  result goes back to the sender as a `reply` (`reply_to` = the request, same scope and depth),
  written by a D1 trigger in the same statement as the result. A reply never produces a reply.
- **An unfinished request is answered too.** If it ends `failed` or `uncertain`, the sender gets one
  correlated `reply` (`note: unfinished:<state>`) saying so. The reply tells the agent not to repeat
  or resend the request (it may have had effects) and that a retry is the person's decision. Nothing
  re-sends it.
- **Loop guard.** Depth measures nesting: a person's message has depth 0; a request an agent sends
  while working on a message of depth *d* has depth *d+1*, refused past `ACP_MAX_DEPTH` (6) with 409
  `depth-limit`; the reply brings the asker back to *d* (request depth − 1), so rounds of consult and
  answer do not add up. Rounds have their own budget: every request and reply of a chain carries
  `root_id` (the person's message it started from) and past `ACP_MAX_CHAIN` (40) agent requests under
  one root a send is refused with 409 `chain-budget` (“informá el estado y esperá a la persona”). A new
  message from the person starts a new budget.
- Pending messages survive backend, runner and container restarts: they are rows in D1.

> **Provisional.** A background process meant to keep running (a dev server) is declared by the agent
> writing `ST-PERSISTENT: <task id>` in its answer. It depends on the model writing that line, cannot
> be revoked, and the process is not tracked after the message closes. Without it the message stays
> `running` until the task ends (plus one check question after `BG_CHECK_MS`, 10 min). To be replaced
> by a structured signal.

### 3b. Slots and contexts (v24)

An agent runs up to `max_concurrency` messages at once (1 by default; `PATCH /api/acp/agents/:name
{maxConcurrency}`, 1–4), one per **slot**: a copy of the runner loop with its own adapter, lock
(`/tmp/st-acp-runner-<k>.lock`), log (`/tmp/st-acp-runner-<k>.log`) and process
(`node --no-warnings /opt/st-acp/st/runner.mjs <k>`), launched and watched one by one. Slot 1 keeps
the names of always (`/tmp/st-acp-runner.lock`, `/tmp/st-acp-runner.log`, no argument): a one-slot
agent is exactly the runner it was. Raising the cap launches the new slots at once; lowering it lets
the extra slots finish and claim nothing more (their processes stay idle until the container
restarts). `ACP_MAX_RUNNING` (6) caps the whole backend.

A message's **context** says where it runs:

- `NULL` — the default context: the workspace checkout. Only slot 1 runs it, with **one ACP session per
  conversation** (v27, below).
- a name (`^[a-z0-9][a-z0-9-]{0,39}$`) — a **work** (3c): its own git worktree
  `<workspace>/.st/ctx/<name>/` (the cwd of its own ACP session, `<workspace>/.st/acp/ctx/<name>.json`).
  Only slots ≥ 2 run it, so an agent with cap 1 never takes one (`400 context-needs-slots`).

One running message per agent and context: two runs never share a directory or an ACP session.
A message goes into a work with `POST /api/acp/messages {work}` (`st send @x --work <id>`); without
it, into the recipient's default context. An agent's **reply** comes back to the context it was sent
from (`from_context`, taken from the sender's credential).

A slot ≥ 2 opens (new or resumed) a context's session when it claims a message of it and closes it
when it claims one of another context. Since it keeps it open in between, the claim has **affinity**: a context's
message goes to the slot that last started one of that context while that slot's latest message is
still of it and the slot is within the cap — never to a second slot that would open the same session
again (two adapters on one transcript, and a stale copy for the next message). Any slot takes a
context that never ran, one whose slot moved on to another context, or one whose slot is past a
lowered cap. `session/close` (and a resume) stops what that session left
running, so a slot whose session still has an open task (a process declared `ST-PERSISTENT`) keeps
that context and takes only its messages until the task ends.

**Slot 1: one ACP session per conversation (v27).** Slot 1 generalizes what slots ≥ 2 do with works:
its session key is the conversation of the message it takes — `<workspace>/.st/acp/conv/<id>.json`,
cwd = the main checkout; a message with no conversation uses `session.json`, the session of always.
Taking a message of another conversation closes the open session (`session/close`) and opens
(`session/new` or `session/resume`) the new one; model and effort are re-applied as after any resume.
Nothing is opened at start: only for a message it claims, or for the report about an interrupted one
(in that message's conversation; a question orphaned with no interrupted run: `session.json`). So at
most one conversation session is open per agent, and inactive topics hold no process. A session with
an open task (a process declared `ST-PERSISTENT`) is never closed: slot 1 then claims only that
conversation's messages (`POST /runner/claim {conversation: <id>|null}`) and the rest wait `pending`
until the task ends. The claim still keeps one running message in the default context per agent, so
two runs never share the main checkout; parallel code goes through works. A message with `work` runs
in its work's session (slot ≥ 2) and keeps its conversation. The runner's protocol tells the agent not
to leave persistent processes or edit code in parallel from a conversation: that is what a work is for.

**Who sent a `st send`.** A named context's session gets its own credential
(`acp1.<agentId>.<context>.<hmac>`, in the session's environment on new and resume); the default
context's is the runner's. The backend attributes the send to the message running in the
credential's context; if none is running, the execution that started the process has ended and the
send is refused (`409 execution-ended`) — never re-attributed, never turned into a direct message.
Not covered: a process left running by one message of a context that sends while a LATER message of
the same context runs is attributed to that later message (same context, same directory). The
credential cannot be per message: renewing a session's environment restarts its Claude process and
stops what the agent left running.

### 3c. Works (v26)

A named context exists only as a work: a row of `agent_works` (never deleted: an id is never reused,
so no old ACP session of it is ever resumed) and a git worktree the backend creates **before** the
work's first message — never by the runner, which fails a message whose directory is missing.

- `POST /api/acp/works {agent, id, base?}` (`st work new @agente <id> [--base <ref>]`): the person,
  or an agent of the recipient's project. The recipient needs `max_concurrency ≥ 2`, a running
  session and `ACP_WORK_MIN_FREE_MB` (20480: above the 15 GiB the nightly backup needs) free in its workspace (else 400 `context-needs-slots`,
  409 `session-not-running` / `low-disk`). In the agent's container (fixed scripts under
  `docker exec`, like the Git view; only `id` and `base` reach them, as positional arguments):
  refuse if `.st/ctx/<id>`, `.st/acp/ctx/<id>.json` or branch `work/<id>` exists (409
  `work-path-exists`, nothing replaced), then `git worktree add .st/ctx/<id> -b work/<id> <base>`
  (base: the given ref, or the remote's default branch after a best-effort `git fetch`).
- The row is `creating` before git and `active` after. An error or unknown outcome inspects the
  real state: the worktree on its branch ⇒ `active`; nothing ⇒ the same POST creates it; anything
  else stays `creating` with a `note` (409 `work-incomplete`). Repeating a POST returns the work.
- Ports: `port_base` = 20000 + 100·k, the lowest block free among the agent's works not `cleaned`
  (a partial unique index), never past 60000 (409 `no-free-ports`). The answer to a creation names
  the base it resolved (`base`, with `baseSha`): with no base and no `origin/HEAD` it is the main
  checkout's `HEAD`. The work's session gets `ST_WORK` and `ST_PORT_BASE` in its environment
  (with its credential), and every message's header names the work, branch, directory and ports.
- The free `context` field is gone: a message that still sends it is refused (400
  `context-removed`), never run in the default context.
- `{work}` on a message: the work must exist (404 `work-not-found`), be the recipient's (409
  `work-not-yours`) and `active` (409 `work-not-active`); an agent sender must share its project
  (403 `work-other-project`). Claim, slots, caps, depth and rounds are unchanged.
- `GET /api/acp/works` (`st work list`): the person sees all; an agent its own and its project's.
- **Ports.** The protocol tells the agent to use only its range and to check with
  `st port check <port>` that the listener is its own process — an HTTP 200 proves nothing. From
  `/proc` (the socket's inode in `/proc/net/tcp{,6}`, then the process holding it): exit 0 when that
  process has the caller's `ST_WORK` or its cwd in the caller's worktree (default context: cwd in the
  workspace, outside `.st/ctx/`, no `ST_WORK`); 1 someone else's (named); 2 nobody; 3 cannot tell.
- **Close** (`POST /api/acp/works/:id/close`, `st work close`; the person or an agent of the work's
  project): refused while a message of it is `pending`/`running` (409 `work-busy`); `closed` from
  then on (`--work` ⇒ 409 `work-not-active`); nothing removed, no reopening.
- **Releasing the session.** A slot ≥ 2 holding a work's ACP session says so in its claim (`open`,
  every 30 s); a work no longer `active` gets `X-ST-Release` back and the runner closes that session
  — idle and with no open task only: a process the agent left (`ST-PERSISTENT`) wins and the
  session stays. The session file and transcript are kept.
- **Clean** (`POST /api/acp/works/:id/clean`, `st work clean`; same callers; from `closed` or
  `cleanup-pending`; explicit only, never automatic). Any doubt ⇒ nothing removed, state
  `cleanup-pending` with the reasons in `note` and a 409 listing them all: a message of it pending
  or running; a process with its cwd in the worktree or `ST_WORK=<id>` in its environment (an
  unreadable one counts); `git status --porcelain` not empty; the branch tip neither reachable from a
  remote-tracking ref, nor listed by `git ls-remote origin` (a squash-merged PR's `refs/pull/N/head`),
  nor still the base (a failing `ls-remote` is a doubt); an ignored path that is not a
  `node_modules/` or `dist/` directory (`--ignored=matching`; the list is fixed). Then
  `git worktree remove` WITHOUT `--force` ⇒ `cleaned`. The branch `work/<id>`, `.st/acp` and the
  transcript are never deleted; there is no garbage collection of old works.
- Lowering `max_concurrency` still leaves the extra slots' processes alive until the container
  restarts (an agent that runs works keeps its cap, e.g. 3).

**Activity** (tool calls, background tasks, partial text) is pushed by the runner and kept **in
backend memory** (last 500 events per agent). It is the live view; history is the messages. A backend
restart loses activity, never messages.

## 4. Individual Chat and Project Chat

A message's `project_id` is its **scope**:

| | Individual Chat | Project Chat |
| --- | --- | --- |
| Where | the agent's session, Chat view | `#/projects/<pid>/chat` (the rail's Archive entry; a project's topics live at `#/projects/<pid>/c/<cid>`) |
| Shows | everything to or from that agent, any scope | only what was posted in that project |
| Scope of a person's message | direct (`projectId` absent) | the project (`projectId`, the agent must be in it) |
| Recipients | the agent | the `@mentions` at the start of the message, all of which must be agents of the project (one unknown name refuses the whole post); without them, the one agent mentioned or the project's only agent. The API receives one `POST` per recipient, each checked to be in the project |

- An agent takes part in at most one project (`acp_agents.project_id`), chosen at creation or with
  `PATCH /api/acp/agents/:name {projectId}` (an explicit button in the UI). It keeps its session,
  context and history when it joins or leaves.
- An agent **never chooses** scope: a request it sends takes the scope of the message it is working
  on when the recipient is in that project, and is direct otherwise. A consult started in Project
  Chat stays there; a private one stays private.
- Projects themselves (`/api/projects`) only group agents and give
  them Project Chat. Archiving a project makes its agents leave it.
- **Live:** `/ws/acp` pushes every message row, question and activity batch to the owner's browsers.
  The client loads a page over REST (`…/feed?before=` for older pages), applies pushed rows by id,
  reloads after a reconnect, and polls slowly only while the socket is down.

## 4b. Conversations (v27)

A **conversation** is a topic of a project. The project's agents are one shared team: any of them takes
part in any topic by being addressed; there is no membership. Everything a post sets off stays in its
conversation. Messages with `conversation_id` NULL (everything before v27, direct messages, posts with
`projectId` and no conversation) are the **Archive**: the individual chat and the old Project Chat feeds
show only those.

### Endpoints (owner cookie only; an agent token gets 403; foreign or missing = 404)

| Endpoint | Does |
| --- | --- |
| `POST /api/acp/conversations {projectId, title, clientRequestId}` | Creates a topic in a live project of the owner. Idempotent by `clientRequestId` (UUID v4): a retry answers `200 {…, replayed: true}`; the same id with another project/title is `409 idempotency-conflict`; an answer D1 lost and the read-back cannot resolve is `503 outcome-unknown` (retry with the same id). `title`: 1–120 chars, no control chars. |
| `GET /api/acp/projects/:pid/conversations[?archived=1]` | The project's topics (live, or only archived), most recently active first. |
| `PATCH /api/acp/conversations/:id {title}` | Renames. |
| `POST /api/acp/conversations/:id/archive` | Archives (idempotent): leaves the list, takes no new post (`409 conversation-archived`); its history and feed stay. |
| `POST /api/acp/conversations/:id/read {at}` | Read mark: see below. Only advances. |
| `GET /api/acp/conversations/:id/feed[?before=<id>]` | `{conversation, agents, questions, messages, activity, activitySeq, maxMessageBytes}` — like the project feed: 100 messages per page, oldest first, full rows; `questions` = those asked while working on the page's messages; `agents` = the project's agents with their state. |
| `GET /api/acp/inbox` | The global inbox (below). |
| `POST /api/acp/messages/:id/review` | "Dar por revisada" (below). |

A conversation as the API shows it:

```json
{ "id": "…uuid…", "projectId": "…", "title": "Optimización de CI",
  "createdAt": "…", "lastActivityAt": "…", "archivedAt": null, "readAt": "…" | null,
  "recipients": {"agents": ["architect", "qa"]} | {"team": true} | null,
  "unread": 3, "needsAction": false }
```

- `lastActivityAt` moves (D1 triggers) with every row written in the topic and every result
  (`done`/`failed`/`uncertain`) — the person's posts, the agents' consults and replies, the notices.
- `recipients`: who the person's last post in this topic went to — the chips the composer shows by
  default. A new topic has `null`: it starts empty.
- `needsAction`: an open question of one of its messages, or an `uncertain` run not reviewed.

### Posting

`POST /api/acp/messages` from the person:

| Body | Result |
| --- | --- |
| `{conversationId, to: "@a", body, clientId?}` | one row in the conversation (`project_id` = the conversation's project). Answer: the row (as before). |
| `{conversationId, to: ["a", "b"], body, clientId}` | one row per recipient under one `clientId` (required). Answer: `{messages: [rows], replayed}`. |
| `{conversationId, team: true, body, clientId}` | the project's agents **now** (who joins later does not get it), one row each, every row `team: 1` — for "→ Todo el equipo (N)". `to` must be absent. |
| `{to, body, projectId?}` without `conversationId` | the Archive's paths the current UI uses (direct, or the old Project Chat): `conversation_id` NULL. They go away with the old UI. |

Every recipient must be in the conversation's project (`400 not-in-project`); `projectId`, if sent too,
must be the conversation's (`400 project-mismatch`); lists and `team` need a conversation
(`400 conversation-required`); `work` takes one recipient (`400 work-needs-one-recipient`). A retry with
the same `clientId` finds every row it wrote (and writes the ones a cut attempt did not). Every
post stores the conversation's `recipients`.

### Inheritance (nothing to choose for an agent)

- An agent's `st send` takes the **conversation and scope** of the message it is running; a request
  from a topic never leaves its project: a recipient outside the conversation's project (or in none) is
  `409 recipient-other-project` («@x no es de este proyecto: no se envió nada») and no row is written.
  Only a run with no conversation (the Archive's paths, agents without a project) keeps the old rule:
  scope when the recipient is in that project, direct otherwise. A `work` outside the sender's project
  is still `403 work-other-project`. An agent sending `conversationId`, a list or `team` gets
  `400 conversation-inherited`.
- The reply to a request (trigger) and the notice of an unfinished request (`unfinished:failed|uncertain`)
  copy the request's conversation.
- A question to the person belongs to the conversation of the message it was asked from
  (`agent_questions.message_id` → the message).
- The runner's recovery message after a restart carries `recovery_of` = the interrupted message and
  lives in its conversation and scope.
- A message with `work` keeps its conversation too (`conversation_id` and `context` both set).
- `agent_works.conversation_id` (`conversationId` in the work's view): the topic it was created from —
  the running message's for an agent, `POST /works {…, conversationId}` for the person (an agent of
  that project).

### Read state

`read_at` is a **time**, not a message id: a person's message gets its result on the same row when the
agent finishes, long after its id was shown, so an id mark would count every result as seen. A row's
*event time* is `finished_at` for a person's message that ended `done` with a result, and `created_at`
for anything else. The client posts `{at}` = the newest event time it has on screen (ISO with ms, as the
rows carry them); the server keeps the max (a time in the future counts as now). Nothing marks a topic
read but that POST.

`unread` = rows of the topic not written by the person with `created_at > read_at`, plus the person's
messages ended `done` with a result and `finished_at > read_at`.

### Inbox

`GET /api/acp/inbox` →

```json
{ "count": 2,
  "action": { "questions": [question rows + conversation_id, project_id],
              "interrupted": [uncertain message rows without reviewed_at] },
  "results": [the person's messages done with a result, unseen, in live conversations],
  "reports": [system recovery messages whose recovery_of is one of the interrupted] }
```

`count` = questions + interrupted (the badge). `results` is informative. Every project, and the
Archive too (an interruption there is no less one: `conversation_id` null). Up to 200 per section.

### Reviewing an interruption

`POST /api/acp/messages/:id/review` marks an `uncertain` message `reviewed_at` (state unchanged, nothing
written or sent; a repeat keeps the first time); not `uncertain` → `409 not-uncertain`. The facts the
review shows are already on the rows: `finished_at` and `note` (why it was cut), and the recovery report
(`reports`, or the row with `recovery_of` = the id in the feed). `requeue` is unchanged except that it
clears `reviewed_at` (interrupted again, it needs a new review).

### Agents' state

`GET /api/acp/agents` (and every feed's `agents`) adds, per agent, the facts for the vocabulary of
PROPUESTA §4 (never slots):

```json
{ "runningIn":  [{"id": 12, "conversationId": "…", "work": null}],
  "queue":      [{"id": 15, "conversationId": "…", "work": null}],
  "waitingFor": [{"id": 13, "agent": "qa", "conversationId": "…", "work": null}],
  "question":   {"id": 4, "messageId": 12, "conversationId": "…"} | null,
  "heldBy":     [{"conversationId": "…", "work": null, "since": "…"}],
  "waitingInput": true, "running": [12], "pending": 1 }
```

`heldBy`: `[{conversationId, work, since}]` — a slot kept in a conversation (or work) by a process the
agent left running there, so it cannot switch to another topic («ocupado en «X» · proceso en curso»).
The runner reports it with every claim (the claim's own `conversation`/`context` restriction), a claim
without it clears it; memory only, not shown past 60 s without a claim. Empty otherwise.

`queue` is in id order (position = index; the claim takes the oldest its slot may run). `waitingFor` =
its requests to other agents not finished yet (pending or running), from a run that is open or closed.

### Live

`/ws/acp` pushes rows with every v27 column (`conversation_id`, `team`, `reviewed_at`, `recovery_of`)
and a `{type: "conversation", conversation}` frame (the view above) on create, rename, archive, read
and every post's recipients. `lastActivityAt` changes ride the message frames.

## 5. Agent ↔ agent: the `st` CLI

Inside an agent session, `st` is on the runner's `PATH` and calls the same API with the agent's token
(`ST_TOKEN`, `ST_URL`):

```
st agents                  st send @name "text"       st send @name -f file.md
st list                    st get <id>
```

The runner's protocol tells the agent that the answer to its request arrives later as a new message,
and not to wait for it. Agent credentials are `acp1.<agentId>.<HMAC>` with a key derived from
`SECRETS_ENCRYPTION_KEY`: recomputable, never stored, limited to `/api/acp` for that owner's agents.

## 6. Questions from an agent

When the agent needs a decision (Claude's `AskUserQuestion`, or an MCP form), the adapter sends an
ACP `elicitation/create`. The runner registers it (`agent_questions`, v22) and keeps the ACP request
open; the Chat shows the form (single/multiple choice, *Other*, text) and the agent as *esperando tu
respuesta*. A question is attached to a message only if it is the message the agent is running, so it
shows in that message's chat and nowhere else.

- Only the person answers (`POST /api/acp/questions/:id/answer {action: accept|decline|cancel,
  content?}`); an agent's token is refused, and a second answer gets 409.
- The runner marks the question `delivered` **before** handing the answer to the waiting request, so
  an answer is used at most once.
- A runner restart loses the waiting request: open or answered-but-undelivered questions of that
  slot's messages become `orphaned`, never treated as answered (another slot's stay open). The agent is told in its recovery message; the person can
  send the decision as a normal message instead.
- URL-mode elicitations (an MCP OAuth) are declined: the runner declares only `form`.

## 7. Login

The agent authenticates like Claude Code in that session (the login lives in the session's persistent
`~/.claude`, shared with the Terminal), or with a `CLAUDE_CODE_OAUTH_TOKEN` secret env var on the
session.

- **From Chat:** *Conectar cuenta* opens a Terminal tab of the agent's session running the adapter's
  own login command (its advertised terminal-auth method; only programs under `/opt/st-acp` or
  `/usr/(local/)bin` with plain arguments are accepted).
- **From Terminal:** run `claude` and `/login`.
- While not authenticated, messages stay `pending` (*esperando login*). The runner restarts its
  adapter as soon as the credentials file changes, or every 60 s otherwise.

## 8. Setup

1. **Backend env** (`.env`; `docker-compose.yml` forwards the `ACP_*` variables):

   | Variable | Default | |
   | --- | --- | --- |
   | `ACP_DEFAULT_RUNTIME` | `claude-acp-0.108.0` | adapter directory for new agents |
   | `ACP_DEFAULT_MODEL` | `claude-sonnet-5-5` | model when the create request names none |
   | `ACP_MESSAGE_MAX_BYTES` | `262144` | per-message cap |
   | `ACP_MAX_DEPTH` | `6` | agent → agent nesting limit |
   | `ACP_MAX_CHAIN` | `40` | agent → agent requests under one person's message |
   | `ACP_MAX_RUNNING` | `6` | messages running at once on this backend, all agents (each agent: `max_concurrency`) |
   | `ACP_WORK_MIN_FREE_MB` | `20480` | free space an agent's workspace needs to create a work |
   | `ACP_TEST_RUNTIME` | unset | `1` installs the deterministic `st-test-agent` runtime |
   | `ACP_RUNTIME_DIR` | `<WORKSPACE_ROOT>/.acp-runtime` | runtime directory (same path on host and backend) |
   | `ACP_BACKEND_URL` | `http://st-backend:<PORT>` | how runners reach the backend over the sessions network |
   | `ACP_WATCHDOG_MS` | `30000` | runner liveness check period |

2. **Install an adapter** once per version:

   ```bash
   docker run --rm -u 0 -v $WORKSPACE_ROOT:$WORKSPACE_ROOT -v $PWD/acp-runtime:/src:ro \
     --entrypoint bash shared-terminal-session /src/install.sh $WORKSPACE_ROOT/.acp-runtime 0.108.0
   ```

3. **Restart the backend.** Migrations v21–v25 are additive and run at boot.

4. **Create an agent session:** the New session form's agent fields (name, project, runtime), or `POST /api/sessions` with
   `acpAgent: {name, model?, runtime?, projectId?}`. The name is `[a-z][a-z0-9-]{1,31}`, unique per
   owner; `owner`, `system` and `all` are reserved.

5. **Log the agent in** (§7).

## 9. Operation and recovery

- **Launch.** On every container start and at backend boot, the backend `docker exec`s the runner
  under `flock -n` inside a restart loop: two runners for one agent cannot run.
- **Watchdog.** Every `ACP_WATCHDOG_MS`, each running agent's loop is checked through its processes
  (no D1 call). Only a loop **proven dead** is relaunched; silence is never taken as death, a probe
  that cannot answer does nothing, and a runner alive without its loop is left alone (logged once). A
  runner that is alive but stuck is not detected.
- **Adapter gone.** If the adapter exits mid-message, the message becomes `uncertain` and the runner
  exits; the loop restarts it and the adapter with it.
- **Session gone from the adapter.** If the Claude process behind an idle session dies, claude-agent-acp
  evicts the session and answers the next `session/prompt` with `-32002` (`sessionNotFound`, before the
  turn is queued): nothing ran, so the message goes back to `pending` and the next claim reopens the
  session (`session/resume`). Once per message: refused the same way right after the reopen, it is
  `uncertain` with the note. Any error after the turn started stays `uncertain`.
- **Tasks belong to their session.** Leaving a session (close, switch, loss) drops its open tasks. A
  `turn` task the adapter opens with no message running (e.g. after the message settled) blocks no
  message and does not hold the session. A task that spawns while a claim is in flight and holds the
  session sends the claimed message of another session back to `pending`.
- **Continuity.** The runner's state is in the workspace (`~/workspace/.st/acp`: ACP session id, one
  event log per message), so it survives runner, container and backend restarts and a container
  re-creation; the runner resumes the same ACP session (same context) and settles an interrupted
  message from its log — re-posting a result whose answer was lost, releasing one that never reached
  the prompt, `uncertain` otherwise.
- **Logs:** `/tmp/st-acp-runner.log` in the container; backend lines prefixed `[acp]`.
- **Backup & restore** include `acp_agents`, `agent_messages` and `agent_questions`, and the
  workspace (with the runner state). Restored sessions come back stopped; on their next start the
  runner settles whatever was `running`.
- **Deleting.** A soft delete keeps the agent (restartable). A hard delete of an agent's session:
  - closes what was queued or running for it as `failed`, and agents that had asked it something get
    the unfinished reply above;
  - orphans its open questions;
  - makes its token stop working;
  - frees its name for a new agent.
- **Re-creating** an agent's container (soft delete + start) keeps the read-only runtime mount; the
  watchdog launches the runner in the new container, which resumes the same ACP session.
- **Evidence.** The two items above are covered by the backend's unit tests (real SQLite, faked
  Docker). Their real-Docker check, `experiments/acp-agents/acp-r8-docker-check.mjs` (lab only,
  `LAB=1`, disposable sessions), has not been run yet and covers the hard delete only: treat the
  container side of a re-creation (mount in the new container, one runner, resumed ACP session) as
  unverified.
- **Stopping an agent.** Stop its session: no runner lives while the container is down.

## 10. Known limitations

- Claude is the only adapter tested. Codex, Pi, OpenCode and others are planned, not implemented.
- The runner sets `bypassPermissions`: the container is the sandbox, the workspace is not protected
  from the agent ([SECURITY.md](./SECURITY.md#acp-agents)).
- `ST-PERSISTENT` is provisional (§3).
- Activity and the "needs login" state are in backend memory; after a backend restart a runner
  waiting for login reports it again within about a minute.
- A runner that is alive but stuck is not restarted automatically.
- One backend host; session containers share one Docker network (single-tenant).

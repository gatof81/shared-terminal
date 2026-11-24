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

- `NULL` — the default context: the workspace checkout and the agent's ACP session of always. Only
  slot 1 runs it.
- a name (`^[a-z0-9][a-z0-9-]{0,39}$`) — its own directory `<workspace>/.st/ctx/<name>/` (the cwd of
  its own ACP session, `<workspace>/.st/acp/ctx/<name>.json`). Only slots ≥ 2 run it, so an agent
  with cap 1 never takes one (sending one is refused: `400 context-needs-slots`).

One running message per agent and context: two runs never share a directory or an ACP session.
Only the person places a message in a context (`POST /api/acp/messages {context}`, cookie only); an
agent's request always goes to the recipient's default context, and its **reply** comes back to the
context it was sent from (`from_context`, taken from the sender's credential).

A slot ≥ 2 opens (new or resumed) a context's session when it claims a message of it and closes it
when it claims one of another context. `session/close` (and a resume) stops what that session left
running, so a slot whose session still has an open task (a process declared `ST-PERSISTENT`) keeps
that context and takes only its messages until the task ends.

**Who sent a `st send`.** A named context's session gets its own credential
(`acp1.<agentId>.<context>.<hmac>`, in the session's environment on new and resume); the default
context's is the runner's. The backend attributes the send to the message running in the
credential's context; if none is running, the execution that started the process has ended and the
send is refused (`409 execution-ended`) — never re-attributed, never turned into a direct message.
Not covered: a process left running by one message of a context that sends while a LATER message of
the same context runs is attributed to that later message (same context, same directory). The
credential cannot be per message: renewing a session's environment restarts its Claude process and
stops what the agent left running.

**Activity** (tool calls, background tasks, partial text) is pushed by the runner and kept **in
backend memory** (last 500 events per agent). It is the live view; history is the messages. A backend
restart loses activity, never messages.

## 4. Individual Chat and Project Chat

A message's `project_id` is its **scope**:

| | Individual Chat | Project Chat |
| --- | --- | --- |
| Where | the agent's session, Chat view | the project page, `#/projects/<pid>/chat` |
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

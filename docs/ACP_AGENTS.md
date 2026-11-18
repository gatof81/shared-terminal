# ACP agents

> **Status: experimental, off by default** (`ACP_AGENTS_ENABLED`). Implemented and tested with
> Claude only (adapter `@agentclientprotocol/claude-agent-acp`). This page describes what is on
> `main`; anything marked *in development* or *planned* is not a contract yet and may change.
> Developer-level detail lives in [CLAUDE.md → ACP agents](../CLAUDE.md) and the code
> (`backend/src/acp/`, `backend/src/routes/acp.ts`, `acp-runtime/`).

## 1. Model

**A session is an execution environment; an agent is what works in it.**

- A **session** is a Docker container plus a workspace on the host (`<WORKSPACE_ROOT>/<sessionId>`).
  It has the same Terminal, Files and Git views whether or not an agent runs in it.
- An **ACP agent** is a named identity (`@developer`) attached to one session at creation
  (`acp_agents` row, D1 migration v21; deleted with the session). It has its own context (its ACP
  session), its own workspace and repository, and the tools of its container.
- Inside the container, Shared Terminal's **runner** (`acp-runtime/runner.mjs`) is a direct
  [ACP](https://agentclientprotocol.com) client: it speaks JSON-RPC over the stdio of a provider
  **adapter** (Claude's today). No tmux, no terminal scraping, no Composer.
- Messages to and between agents go through **one durable message API** (`/api/acp`, table
  `agent_messages`), used by the web UI and by the `st` CLI inside containers.

```
person (web) ──┐                                   ┌── runner ──ACP──▶ adapter ──▶ model
               ├──▶ /api/acp/messages ──▶ D1 ──────┤   (session container, one message at a time)
agent (st send)┘        (stored before 201)        └── results, replies, live activity ──▶ web
```

Traditional sessions (no agent) are unchanged: tmux tabs, optionally Claude Code in the terminal
with conversation capture and the Composer ([CONVERSATION.md](./CONVERSATION.md)).

## 2. Runtime independent of the image

The session image knows nothing about agents. The runner, the `st` CLI and each pinned adapter
version live in a host directory, by default `<WORKSPACE_ROOT>/.acp-runtime` (`ACP_RUNTIME_DIR`),
bind-mounted **read-only** at `/opt/st-acp` only into agent sessions:

```
.acp-runtime/
  st/                       runner.mjs, bin/st — copied from the backend image at every boot
  claude-acp-0.108.0/       one directory per adapter version (installed by acp-runtime/install.sh)
    agent                   stable entry point the runner executes
```

- Upgrading an adapter = installing a new directory and pointing `ACP_DEFAULT_RUNTIME` at it. No
  image rebuild, and existing agents keep the runtime recorded when they were created.
- Any image with Node ≥ 22 can run the runtime.
- The session image still ships the Claude Code CLI for terminal use (and for logging the agent
  in, see §6). Making the image fully provider-neutral is *planned*.

## 3. Messages

`POST /api/acp/messages {to: "@name", body}` is the only way to send. The row is inserted in D1
**before** the `201`; the sender is always the caller's credential (the person's cookie or the
agent's token), never a field of the body. Bodies are capped at `ACP_MESSAGE_MAX_BYTES` (256 KiB).

| State | Meaning |
| --- | --- |
| `pending` | stored, waiting for the recipient |
| `running` | claimed by the recipient's runner (at most one per agent) |
| `done` | the turn ended and every background task it started ended (or was declared persistent) |
| `failed` | the turn ended with an error |
| `uncertain` | the run was interrupted (runner/adapter/container died mid-turn) |

Rules:

- **One message at a time per agent**, oldest first; the claim is a single conditional D1 update.
- **Never resent.** An interrupted run becomes `uncertain`; only the owner can put it back to
  `pending` (`POST /api/acp/messages/:id/requeue`). The agent then receives one `system` message
  asking it to report the state without repeating effects — this also closes the orphan turn the
  adapter reopens on resume.
- A message that the runner gives back before starting it (e.g. the agent is not logged in yet)
  returns to `pending`, not `uncertain`.
- **Replies between agents are automatic.** When an agent's request to another agent finishes, the
  result is written back to the sender as a `reply` (`reply_to` = the request) by a D1 trigger in
  the same statement as the result.
- **Done means idle.** The runner closes a message only when the prompt is answered **and** every
  async task it started (background shell, monitor, a follow-up turn) has ended. Never by a timer.

> **Provisional — not a contract.** A background process meant to keep running (a dev server) is
> declared by the agent writing `ST-PERSISTENT: <task id>` in its answer. It depends on the model
> writing that line; it cannot be revoked and the process is not tracked after the message closes.
> Without it the message stays `running` until the task ends (plus one check question after
> `BG_CHECK_MS`, 10 min). It is to be replaced by a structured signal.

**Activity** (tool calls, background tasks, partial text) is pushed by the runner and kept **in
backend memory** (last 500 events per agent). It is the live view; history is the messages and
their results. A backend restart loses activity, never messages.

## 4. Agent ↔ agent: the `st` CLI

Inside an agent session, `st` is on `PATH` and calls the same API with the agent's token
(`ST_TOKEN`, `ST_URL` are set by the backend for the runner and its children):

```
st agents                  st send @name "text"       st send @name -f file.md
st list                    st get <id>
```

An agent can message any other agent of the same owner. Agent credentials are
`acp1.<agentId>.<HMAC>` with a key derived from `SECRETS_ENCRYPTION_KEY`: recomputable, never
stored, scoped to that owner's agents and messages.

## 5. Chat and Project Chat

- **Chat (implemented).** In an agent session the Chat view is that agent's inbox: everything sent
  to or by it, results, and live activity, polled from `GET /api/acp/agents/:name/feed`. It replaces
  the capture-based Chat for that session.
- **Project Chat (*in development*, [#674](https://github.com/gatof81/shared-terminal/pull/674)).**
  A channel per project where the person and the project's ACP agents post, with mentions. The
  direction in that PR: the same `agent_messages` store and delivery, with a project scope on each
  message (direct messages stay visible only in the two individual chats), a depth limit on
  agent→agent chains, and live updates over WebSocket. Details belong here once merged.
- **Legacy project conversation.** The current Projects view's conversation and agent consults
  (D1–D3) go through the Composer into a CLI in tmux — see
  [PROJECT_CONVERSATION.md](./PROJECT_CONVERSATION.md). It stays until Project Chat on ACP replaces
  it.

## 6. Setup

1. **Backend env** (`.env`, forwarded by `docker-compose.yml`):

   | Variable | Default | |
   | --- | --- | --- |
   | `ACP_AGENTS_ENABLED` | off | `true` constructs the subsystem and mounts `/api/acp`; off ⇒ nothing new runs or is mounted |
   | `ACP_DEFAULT_RUNTIME` | `claude-acp-0.108.0` | adapter directory recorded on new agents |
   | `ACP_DEFAULT_MODEL` | `claude-sonnet-5-5` | model when the create request names none |
   | `ACP_MESSAGE_MAX_BYTES` | `262144` | per-message cap |
   | `ACP_RUNTIME_DIR` | `<WORKSPACE_ROOT>/.acp-runtime` | runtime directory (same path on host and backend) |
   | `ACP_BACKEND_URL` | `http://st-backend:<PORT>` | how runners reach the backend over the sessions network |
   | `ACP_WATCHDOG_MS` | `30000` | runner liveness check period |

2. **Install an adapter** once per version (no image rebuild):

   ```bash
   docker run --rm -u 0 -v $WORKSPACE_ROOT:$WORKSPACE_ROOT -v $PWD/acp-runtime:/src:ro \
     --entrypoint bash shared-terminal-session /src/install.sh $WORKSPACE_ROOT/.acp-runtime 0.108.0
   ```

3. **Migrate and restart** the backend (migration v21 is additive and runs at boot).

4. **Create an agent session**: the New session form's agent-name field (shown when the backend
   reports `features.acpAgents`), or `POST /api/sessions` with `acpAgent: {name, model?}`. The name
   is `[a-z][a-z0-9-]{1,31}`, unique per owner.

5. **Log the agent in**: it authenticates like Claude Code in that session — run `claude` and
   `/login` once in its Terminal (the login is kept in the workspace), or give the session a
   `CLAUDE_CODE_OAUTH_TOKEN` secret env var. Until then the Chat shows *waiting for login* and
   messages stay `pending`.

## 7. Operation and recovery

- **Launch.** On every container start and at backend boot, the backend `docker exec`s the runner
  under `flock -n` inside a restart loop: a second runner for the same agent can never start.
- **Watchdog.** Every `ACP_WATCHDOG_MS` each running agent's loop is checked through its processes
  (`/proc`, no D1). Only a loop **proven dead** is relaunched; silence is never taken as death (a long
  turn is silent), a probe that cannot answer does nothing, and a runner alive without its loop is
  left alone (logged once). A runner that is alive but stuck is not detected.
- **Runner state** lives in the workspace (`~/workspace/.st/acp`: ACP session id, one event log per
  message), so it survives container re-creation; on restart the runner resumes its ACP session and
  settles an interrupted message as `uncertain`.
- **Logs**: `/tmp/st-acp-runner.log` inside the container; backend lines are prefixed `[acp]`.
- **Backup & restore** include `acp_agents` and `agent_messages`.
- **Permissions.** The runner sets `bypassPermissions` on its ACP session: the container is the
  sandbox, the workspace is not protected from the agent (same posture as the `claude` alias in
  traditional sessions; see [SECURITY.md](./SECURITY.md#acp-agents-experimental)).
- **Rollback.** Unset `ACP_AGENTS_ENABLED` and restart: routes and runners are no longer started;
  the tables stay (additive migration), agent sessions remain ordinary sessions.

## 8. Transition from Composer and capture

| Today | Direction |
| --- | --- |
| Traditional sessions: tmux + Claude Code CLI, capture (hooks) for the Chat, Composer to type into the CLI | stay supported for terminal work |
| Project conversation and consults through the Composer (D1–D3) | replaced by Project Chat on ACP (*in development*) |
| Composer as the way to deliver a message to an agent | being retired; agents receive messages through ACP (*in development*) |
| Conversation capture | kept while traditional sessions rely on it; retirement *planned* once ACP covers its uses |
| Questions an agent asks the person mid-turn | *in development* |

Nothing in this table removes a flag or a route yet; each retirement will be its own change with
its own rollback.

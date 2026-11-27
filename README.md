# Shared Terminal

**A self-hosted web platform for running development environments and coding agents — reachable
from any browser, running on your own server, never on your laptop.**

Shared Terminal gives every piece of work its own isolated Docker container with a persistent
workspace. You open it from a browser — laptop, tablet or phone — and get a real terminal, a file
browser, the Git diff and — for agents — project conversations where you talk to them. Close the tab or lose the
connection: the container keeps running, agents keep working, and their messages are stored on the
server, not in a browser tab.

<p align="center">
  <img src="docs/images/readme/terminal-desktop.png" alt="A running session: sessions sidebar, the Terminal / Files / Git / Chat view tabs and a tmux terminal" width="820">
</p>

## How it works

**Web UI → shared message API → sessions whose agents are driven through ACP.**

- **Docker is only the execution environment.** A session is a container plus a workspace. The
  agent runtime is mounted from the host, not baked into the image, and nothing pins a version of
  Claude Code or any other provider.
- **Agents are independent.** Each has its own context, repository and tools, and is addressed by
  name (`@developer`, `@reviewer`).
- **One durable message API** carries every message — from you to an agent, and between agents —
  whether it comes from the web UI or from the `st` command inside a container.
- **[ACP](https://agentclientprotocol.com) (Agent Client Protocol)** drives the agent directly, with
  no terminal scraping. ACP is provider-neutral: the goal is Claude, Codex, Pi, OpenCode and others
  behind the same API. **Today only Claude is implemented and tested.**

## What you can do

**Sessions** — create, stop, start, soft-delete (workspace kept) and hard-delete; per-session repo
clone, env vars (secrets encrypted at rest), dotfiles, lifecycle hooks and CPU/memory caps;
templates, per-user quotas, idle auto-stop.

**Terminal** — xterm.js attached to tmux in the container: several tabs, reconnect without gaps or
duplicates, many browsers on the same tab, search, a key bar on touch devices.

**Files and Git** (read-only) — browse and preview the workspace (Markdown, code, images), download
files; Git status, per-file diffs and recent commits, run inside the container.

**Projects and agents** — group agents into a project and talk to them in its **topics**
(conversations): address one, several or the whole team; a message is stored before the server
answers, the agent takes it when it is free, and you follow what it does live, including its consults
to other agents. **Pendientes** gathers what waits for you — an agent's question, an interrupted run to
review — across projects. **Herramientas** opens an agent's Terminal, Files and Git (or those of one of
its works) without leaving the topic. Older messages stay readable in the project's **Archive**.

**Tasks** — goals and tasks per project, with a coordinator, assignees, dependencies, links (work, PR)
and request budgets, managed by the agents through `st task`.

**Also** — per-session port exposure on subdomains, an HTTP exec API, an admin dashboard (live
CPU/memory, force actions, quotas, read-only observe with an audit trail), backup & restore, and a
phone-friendly layout.

<p align="center">
  <img src="docs/images/readme/git-desktop.png" alt="Git Changes view: changed and untracked files, recent commits and a unified diff" width="820">
</p>

## Two kinds of sessions

| | **Agent session** (ACP) | **Traditional session** |
| --- | --- | --- |
| What runs | an agent driven over ACP by Shared Terminal's runner, plus tmux | tmux and whatever you start: a shell, Claude Code, any CLI |
| Terminal / Files / Git | yes | yes |
| Talking to the agent | its project's topics (web) or `st send` from another agent | its Terminal |

### Create a traditional session

**New session** → name, optionally a repository, env vars and resource caps. It opens on the
Terminal.

### Create an agent session

With an adapter installed in the runtime directory (see [Installation](#installation)), the New
session form also asks for an **agent name** (lowercase, e.g. `developer`), and optionally a project,
a model, an effort level and a runtime. Log the agent in once: *Conectar cuenta* in «Ajustes del
agente», or `claude` → `/login` in its Terminal. Over the API:

```http
POST /api/sessions
{ "name": "dev", "acpAgent": { "name": "developer", "projectId": "<optional>" } }
```

## How agents talk to each other

Inside an agent's container, `st` uses the same message API you use from the web. The sender is the
agent's own credential, never an argument:

```bash
st agents                         # who can I talk to?
st send @reviewer "Please review the branch fix/login"
st send @reviewer -f notes.md     # longer content from a file
st list                           # my messages and their states
st get 42                         # one message, with its result
st work new @developer fix-login  # a work: its own worktree, branch work/fix-login and ports
st send @developer --work fix-login "…"
st task list                      # the project's goals and tasks
```

- Each agent takes **one message at a time** by default, oldest first: `pending → running → done |
  failed | uncertain`. With more **slots** (`maxConcurrency` 2–4) it runs several at once — the extra
  ones in **works**, each a git worktree with its own branch and port range.
- When a request from one agent to another ends `done`, the **reply goes back to the sender
  automatically**, in the same scope.
- A consult started in a topic stays in that topic. Agents cannot choose otherwise.
- Agent → agent requests are capped in depth (`ACP_MAX_DEPTH`, 6: nesting, a reply returns the asker to its depth) and in rounds per person's message (`ACP_MAX_CHAIN`, 40).
- An interrupted run becomes `uncertain`. It is **never resent automatically**; only you can requeue
  it.

## Architecture

```mermaid
flowchart LR
  B["Browser SPA<br/>(xterm.js, vanilla TS)"] -- "HTTPS / WSS" --> BE
  subgraph Host["Linux host"]
    BE["Backend<br/>REST · WebSocket · message API"]
    FS[("Host disk<br/>workspaces · ACP runtime (read-only)")]
    subgraph NET["Docker network"]
      C1["Agent session<br/>ACP runner + adapter · tmux"]
      C2["Traditional session<br/>tmux"]
    end
  end
  D1[("Cloudflare D1<br/>sessions, users, projects,<br/>agent messages")]
  BE -- "docker exec / attach" --> C1
  BE -- "docker exec / attach" --> C2
  C1 -- "message API (claim, results, st send)" --> BE
  BE --> D1
  C1 -. "bind mounts" .- FS
```

- **Backend** (`backend/`): Express + WebSocket. Stateless: persistence is Cloudflare D1 plus the
  workspaces on the host disk.
- **Frontend** (`frontend/`): vanilla TypeScript SPA, deployed as static files (Cloudflare Pages).
- **Session image** (`session-image/`): Ubuntu 24.04, Node 22, Git, GitHub CLI, tmux, and the Claude
  Code CLI for terminal use.
- **ACP runtime** (`acp-runtime/`): the runner, the `st` CLI and the pinned adapters, in a host
  directory mounted read-only into agent sessions. Upgrading an adapter needs no image rebuild.

The developer deep dive is [CLAUDE.md](./CLAUDE.md).

## Installation

Requirements: a Linux host with Docker, Node 22+, and a Cloudflare account (D1; Tunnel and Pages
for production). Configuration lives in [`.env.example`](./.env.example). The full walkthrough is
[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md).

```bash
cp .env.example .env    # Cloudflare/D1 values, JWT_SECRET, SECRETS_ENCRYPTION_KEY

# Session image (first install; later rebuilds go through scripts/build-session-image.sh)
docker build -t shared-terminal-session ./session-image

# Development
cd backend && npm install && npm run dev      # http://localhost:3001
cd frontend && npm install && npm run dev     # http://localhost:5173

# Production backend
docker compose up -d --build
```

**Agents and projects** are always on; an agent needs an adapter installed into the runtime
directory — see [docs/ACP_AGENTS.md → Setup](./docs/ACP_AGENTS.md#8-setup).

Read [docs/SECURITY.md](./docs/SECURITY.md) before exposing the backend to the internet.

## Status

**Implemented**

- Sessions, terminal, Files, Git, templates, quotas, idle stop, ports, exec API, admin, backup &
  restore.
- ACP agents with Claude:
  - durable message API, one message per slot (1–4 slots per agent), works (worktree + branch +
    ports) for the extra slots;
  - project topics, Pendientes, Herramientas and a read-only Archive, with a live channel;
  - agent ↔ agent messages through `st`, with automatic replies and a loop guard;
  - goals and tasks (`st task`) with budgets per goal and per task;
  - a shared `coordinar` skill installed in every agent;
  - questions to you in the topic or Pendientes, and login from «Ajustes del agente» or Terminal;
  - per-agent model and reasoning effort;
  - recovery without resending after a restart.

**Retired** (2026-11-18): the Composer (typing into a CLI from the Chat), the Composer-based project
conversation and agent consults (D1–D3), and the earlier project agent directory. Their old D1
tables are still present but nothing reads them; removing them is a separate, owner-approved step.

**Retired** (2026-11-22): conversation capture for traditional sessions (their read-only Chat) and
the administrative container recreation. Their data stays on disk and in D1, unread.

**Retired** (3B, #790): the individual Chat view of an agent's session and the single Project Chat;
their messages are read-only in the project's Archive.

**Planned**

- Agents other than Claude (Codex, Pi, OpenCode…) through ACP adapters.
- Sessions on more than one host.
- A structured way for an agent to declare long-running processes (today a provisional text marker).

**Known limitations**

- Only Claude is tested. Agents run with permissions bypassed inside their container: the container
  is the sandbox, and the workspace is not protected from the agent.
- Live activity is kept in backend memory and is lost on a restart. Messages, results and questions
  are kept.
- A runner that is alive but stuck is not restarted automatically.
- There is one backend host, and session containers share one Docker network (single-tenant).

## Documentation

| | |
| --- | --- |
| [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) | Install, production, Cloudflare Tunnel, backup & restore |
| [docs/ACP_AGENTS.md](./docs/ACP_AGENTS.md) | Agents, messages, slots and works, topics, tasks, questions, login, runtime, operation |
| [docs/SECURITY.md](./docs/SECURITY.md) | Threat model and recommended posture |
| [docs/API.md](./docs/API.md) | REST endpoints and WebSocket channels |
| [docs/EXEC_API.md](./docs/EXEC_API.md) | HTTP exec API contract |
| [docs/PROJECTS.md](./docs/PROJECTS.md) | Projects |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Workflow, branches, code style |

## License

Released under the [MIT License](./LICENSE).

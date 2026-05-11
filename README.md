# Shared Terminal

A self-hosted web-based terminal that runs on an always-on Linux server at home. Connect from any device, manage isolated Docker sessions per project/client, and run Claude CLI or any CLI tool from your browser.

## Architecture

```
[Any Device] ──HTTPS──▶ [Cloudflare Pages] ── static frontend (Vite + xterm.js)
                                 │
                                 ├──────────────▶ [Cloudflare D1] ── session + user metadata
                                 │
                                 └──HTTPS/WSS──▶ [Cloudflare Tunnel] ──▶ [Linux Server]
                                                                                ├── Backend (Node.js + Express + WebSocket)
                                                                                └── Docker Engine
                                                                                     ├── Container: project-acme  (tmux + claude CLI)
                                                                                     ├── Container: project-beta  (tmux + claude CLI)
                                                                                     └── ...
```

## Key Features

- **Docker-isolated sessions** — each session runs in its own unprivileged container with dev tools pre-installed (Node 22, Python 3, Claude CLI, GitHub CLI, VS Code CLI, tmux).
- **Persistent tmux + workspace** — tmux inside each container keeps your terminal alive across disconnects; `/home/developer/workspace` is a bind-mounted host directory that survives container restarts.
- **Configurable session creation** — per-session env vars (with `secret`-typed AES-256-GCM-encrypted entries), git repo clone (HTTPS / SSH, PAT / private-key auth, "replace workspace" mode), exposed ports (per-session subdomains via the dispatcher), lifecycle hooks (`postCreate`, `postStart`, dotfiles repo, agent-config seed, git identity), resource caps (CPU 0.25–8 cores, memory 256 MiB–16 GiB), idle auto-stop, and reusable named templates.
- **JWT auth via httpOnly cookie** — `Secure`+`SameSite=None` in production, no JS-readable token; bcrypt password hashing, invite-code-only registration after the bootstrap account, two-tier admin model.
- **Admin dashboard** — cross-user session list, force-stop / force-delete, and subsystem counters (idle sweeper, reconcile, port dispatcher, D1 call rate) for operators.
- **Real terminal emulation** — xterm.js in the browser with 256-color support, mouse, resize.
- **Reconnect replay** — `tmux capture-pane` snapshot is replayed on reconnect (color + cursor position preserved); a deterministic flush re-orders live bytes that arrived during the attach window so the on-the-wire sequence is `[replay][live]` with no interleave.
- **Remote IDE editing** — every session can be opened in local VS Code via Remote – Tunnels; no SSH, no extra ingress. See [docs/REMOTE-EDITING.md](./docs/REMOTE-EDITING.md).
- **Cloudflare D1 storage** — serverless SQLite on Cloudflare; session metadata survives server restarts and is accessible from anywhere.
- **Docker Compose deployment** — one command to build and run the backend.

## Documentation

- **[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)** — local dev setup, D1 provisioning, production deployment, Cloudflare Tunnel, and what's inside each session container.
- **[docs/SECURITY.md](./docs/SECURITY.md)** — threat model, recommended posture, and the optional `docker-socket-proxy` blast-radius reduction. **Read this before exposing the backend to the public internet.**
- **[docs/SECRETS_ENCRYPTION_KEY.md](./docs/SECRETS_ENCRYPTION_KEY.md)** — operator runbook for the AES-256-GCM key that protects every `secret` env var / PAT / SSH key in D1: generation, backup, rotation (none in v1), loss-impact recovery.
- **[docs/API.md](./docs/API.md)** — REST endpoints, WebSocket channels, and the per-session port-exposure dispatcher.
- **[docs/REMOTE-EDITING.md](./docs/REMOTE-EDITING.md)** — connecting from VS Code (Remote – Tunnels).
- **[CONTRIBUTING.md](./CONTRIBUTING.md)** — contributor workflow, branch policy, code style, commit conventions.
- **[CLAUDE.md](./CLAUDE.md)** — architecture deep-dive (terminal data path, persistence model, bootstrap pipeline, dispatcher, idle sweeper, templates) for working in this codebase.

## Tech Stack

| Layer      | Technology                                         |
| ---------- | -------------------------------------------------- |
| Frontend   | TypeScript, Vite, xterm.js                         |
| Backend    | TypeScript, Node.js, Express, ws                   |
| Auth       | JWT (jsonwebtoken), bcryptjs                       |
| Database   | Cloudflare D1 (accessed via HTTP)                  |
| Containers | Docker (dockerode), tmux                           |
| Tunnel     | Cloudflare Tunnel                                  |
| Hosting    | Cloudflare Pages (frontend), self-hosted (backend) |

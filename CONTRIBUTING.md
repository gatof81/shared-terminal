# Contributing to Shared Terminal

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

### Prerequisites

- Node.js 22+
- Docker (with the daemon running)
- A Cloudflare account with D1 enabled (for the database)

### 1. Clone the repo

```bash
git clone https://github.com/gatof81/shared-terminal.git
cd shared-terminal
```

### 2. Install dependencies

```bash
cd backend && npm install && cd ..
cd frontend && npm install && cd ..
```

### 3. Set up environment

```bash
cp .env.example .env
# Fill in your Cloudflare D1 credentials and a JWT secret
```

### 4. Build the session container image

```bash
docker build -t shared-terminal-session ./session-image
```

### 5. Run in development mode

```bash
# Terminal 1 — Backend (auto-restarts on changes)
cd backend && npm run dev

# Terminal 2 — Frontend (Vite dev server with HMR)
cd frontend && npx vite
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

## Project Structure

| Directory        | Description                          |
| ---------------- | ------------------------------------ |
| `backend/src/`   | Node.js + Express + WebSocket server |
| `frontend/src/`  | TypeScript SPA (Vite + xterm.js)     |
| `session-image/` | Docker image for terminal sessions   |
| `.github/`       | GitHub config (CODEOWNERS, CI, etc.) |

## Making Changes

1. **Create a feature branch** from `main`:

   ```bash
   git checkout -b feat/my-feature
   ```

2. **Make your changes** — follow the existing code style:
   - TypeScript strict mode everywhere
   - Tabs for indentation
   - Explicit types on function signatures
   - Descriptive commit messages

3. **Build and verify** before pushing:

   ```bash
   cd backend && npm run build && cd ..
   cd frontend && npm run build && cd ..
   ```

4. **Open a Pull Request** against `main` with a clear description of the change.

## Code Style

- **Backend**: TypeScript, CommonJS output, Express handlers, async/await
- **Frontend**: TypeScript, ES modules (Vite), vanilla DOM (no framework)
- **Formatting**: The repo uses editor auto-formatting — keep it consistent
- **Comments**: Use `// ── Section ───` dividers for readability

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add session sharing between users
fix: handle container restart on reconnect
docs: update deployment instructions
refactor: extract auth middleware
```

## Reporting Issues

- Use GitHub Issues
- Include reproduction steps, expected vs. actual behavior
- For security issues, email directly instead of opening a public issue

## Architecture Decisions

- **D1 over local SQLite**: All data on Cloudflare for portability and remote access
- **Docker containers over node-pty**: Isolation, reproducibility, resource limits
- **tmux inside containers**: Persistent sessions that survive disconnects
- **No frontend framework**: Keeps the bundle small (~300KB) and dependencies minimal
- **Cloudflare Pages for frontend**: CDN-backed, automatic HTTPS, zero server config

## License

By contributing, you agree that your contributions will be licensed under the same license as the project.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All commands are run from within `backend/` or `frontend/`.

```bash
# Backend (Node 22+, TypeScript, CommonJS output)
cd backend
npm install
npm run dev        # tsx watch — auto-restarts on source changes
npm run build      # tsc → dist/
npm start          # node dist/index.js
npm run db:migrate # runs migrateDb() against D1 (requires dist/)

# Frontend (Vite + vanilla TS — no framework)
cd frontend
npm install
npm run dev        # vite on :5173, proxies /api and /ws to VITE_API_URL (default http://localhost:3001)
npm run build      # tsc && vite build

# Session container image (required before creating a session)
docker build -t shared-terminal-session ./session-image
# or: cd backend && npm run docker:build-session

# Backend deploy (frontend is deployed separately to Cloudflare Pages)
docker compose up -d --build
```

Both workspaces have vitest suites and a Biome linter — `npm test` and `npm run lint` in each. CI (`.github/workflows/ci.yml`) runs Biome + `tsc` + vitest on every PR, in both workspaces, so a lint or test failure in either side blocks merge. Don't rely on `npm run build` alone — that's tsc, not Biome. Beyond that, verify by exercising the feature in a browser.

## Required environment

Backend refuses to start without `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `D1_DATABASE_ID` (see `validateD1Config` in `backend/src/db.ts`), or `SECRETS_ENCRYPTION_KEY` (a base64-encoded 32-byte key validated by `validateSecretsKey` in `secrets.ts` — it AES-256-GCM-encrypts `secret`-typed env entries before D1, so changing it strands every existing secret with no rotation tooling in v1). `JWT_SECRET` should also be set for anything past local experimentation. `.env.example` is the source of truth.

`WORKSPACE_ROOT` (default `/var/shared-terminal/workspaces`) must exist on the host and be writable by the backend — each session gets a `<WORKSPACE_ROOT>/<sessionId>` bind mount.

The frontend needs `VITE_API_URL` at build time (Cloudflare Pages env var) so `vite.config.ts` can rewrite the CSP meta tag to allow connections back to the backend.

## Architecture

Three pieces cooperate:

1. **Backend** (`backend/src/`) — Express REST + `ws` WebSocket on the same HTTP server (`index.ts`). Stateless; all persistence is in Cloudflare D1. Deployed on a self-hosted Linux box, typically behind Cloudflare Tunnel.
2. **Frontend** (`frontend/src/`) — vanilla TS SPA with xterm.js. Deployed to Cloudflare Pages in production; `vite.config.ts` rewrites the CSP meta tag based on `VITE_API_URL` so dev and prod agree.
3. **Session containers** — one Docker container per session, built from `session-image/Dockerfile` (Ubuntu 24.04 + Node 22 + Claude CLI + tmux). Each container runs `entrypoint.sh` which starts a detached tmux session named `main` and sleeps forever.

### The terminal data path

`wsHandler.ts` → `DockerManager.attach()` runs `docker exec … tmux new-session -A -s <tabId>` with `Tty: true`. `-A` is the self-heal: attach if the tab's tmux session exists, create it if it doesn't. The hijacked exec stream is piped both ways:

- bytes from tmux → fanned out via `broadcast(…)` to every live listener for that session;
- bytes from the browser → `docker.write(attachId, …)` back into the exec stdin.

Replay on reconnect is a `tmux capture-pane -p -e` snapshot of the current pane (colour + position preserved), not a raw byte stream — there is no `RingBuffer`. To avoid a live/replay ordering race, `attach()` installs an armed `bufferedListener` that collects live bytes into a local tail array during the attach window; `wsHandler` sends the replay, then calls `flushTail()` which drains the tail in order and flips the listener to forward-directly. From the moment the listener is armed onward, the client-visible sequence is deterministic: `[replay][every live delta in arrival order]`.

Multiple browser tabs attaching to the same session share the same tmux exec (each has its own `attachId`, listener, and resize).

### Persistence model

- **Container state is ephemeral** — killed by `stopContainer` / `kill`. The bind-mounted workspace at `/home/developer/workspace` inside the container is what survives. Uploaded files live on a separate read-only bind mount at `/home/developer/uploads` (host path: `<WORKSPACE_ROOT>/.uploads/<sessionId>`) — kept out of the workspace so a repo-clone "replace workspace" can land cleanly at the workspace root. See the comment block in `dockerManager.ts` near the bind setup for the TOCTOU rationale.
- **D1 is the source of truth** for session metadata (`session_id`, `container_id`, `status`, `env_vars`, `cols/rows`) and for the `session_configs` row that holds typed env entries (with `secret`-typed values AES-GCM-encrypted at rest), repo + auth config, lifecycle hook commands, dotfiles + agent-seed config, and resource caps. Config is bound at create time — there is no "edit config of a running session" flow.
- **`DockerManager.reconcile()`** runs on startup and flips the D1 `status` to `stopped` for any session whose container is missing or not running — handles the case where the host rebooted but D1 still thinks sessions are live.

### Bootstrap (lifecycle hooks)

`POST /api/sessions` returns 201 immediately and runs the bootstrap pipeline asynchronously: git identity → repo clone → dotfiles → agent seed → `postCreate` command. The clone-before-dotfiles ordering is load-bearing: dotfiles may reference repo-specific config, and the agent seed is intentionally last so a cloned project's `CLAUDE.md` is on disk before the seed fires. `postCreate` is gated by an atomic `session_configs.bootstrapped_at` flip so it runs **exactly once** per session even under concurrent retries (see `bootstrap.ts`). `postStart` re-runs on every container start (intended for daemons). Total wall-clock cap is 10 minutes — `streamExec` is destroyed past that and the session hard-fails. Live output streams over `/ws/bootstrap/<sessionId>` (auth identical to terminal attach but routed to `BootstrapBroadcaster`'s per-session listener set, not `docker.attach`).

### Delete semantics

`DELETE /api/sessions/:id` is a **soft delete** by default: container is killed, row flips to `status=terminated`, workspace files are preserved so the user can later `POST /start` to respawn. Pass `?hard=true` to also purge the workspace dir and drop the row. `purgeWorkspace` refuses any path that does not resolve under `WORKSPACE_ROOT`.

### Auth

- JWT is delivered as an httpOnly cookie named `st_token` set by `setAuthCookie` in `auth.ts`. `Secure` is on in production, `SameSite=None` in production (cross-site Pages → Tunnel) / `SameSite=Strict` in dev. CSRF for state-changing JSON routes is handled by the CORS preflight + `Content-Type: application/json` requirement; the CORS middleware in `index.ts` only echoes `Access-Control-Allow-Credentials: true` for an exact-origin match against `CORS_ORIGINS`. JS cannot read the token (closing the XSS exfiltration path).
- REST: `requireAuth` middleware reads `req.cookies.st_token` (cookie-parser populated) with a raw-`Cookie`-header fallback for tests bypassing middleware. First visit shows `needsSetup: true` from `/api/auth/status`, which also returns `authenticated` so the frontend can route between login and app on first load without a separate round-trip.
- WebSocket: `verifyWsToken` reads the cookie from the upgrade request's `Cookie` header — browsers send cookies on the WS handshake to the cookie's domain automatically. CSWSH protection is independent: `isAllowedWsOrigin` rejects unlisted origins before `wss.handleUpgrade` runs. There is no subprotocol or query-string auth fallback.
- `sessions.assertOwnership(sessionId, userId)` is the single choke point for authorization on REST and WebSocket paths.
- Two-tier user model: the bootstrap account is created with `is_admin=1`; invite-redeeming users default to non-admin. Invite mint/revoke is admin-gated (#50). Add new admin-only routes through the same `is_admin` check, not a parallel mechanism.

### Notes on D1

All `db.ts` calls are HTTP round-trips to Cloudflare. Keep query counts low on hot paths — the WebSocket attach already does multiple lookups per connection and there is no local cache.

## Code style

- **TypeScript strict mode** everywhere (both workspaces).
- **Tabs** for indentation.
- Section dividers in the form `// ── Section ───` are used throughout the backend — preserve them when editing.
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, …).
- Frontend deliberately has no framework — do not add React/Vue/etc. without discussion.

### Comments

The repo's convention — codified here so PR reviews stop disputing it
(see #69) — is **WHY-driven, not length-capped**.

- **Default to no comment.** If the code is self-explanatory, leave it
  alone. A comment that paraphrases the next line is noise.
- **Add a comment when the WHY is non-obvious.** Subtle correctness
  invariants (TOCTOU, ordering, atomicity, timing side-channels),
  config foot-guns, third-party API quirks, intentional deviations
  from the obvious-looking implementation, security-relevant choices
  — these belong inline with the code, not in a PR description that
  vanishes from the file's context the moment the PR is merged.
- **Length follows the WHY.** A one-liner is fine when the WHY fits
  in a one-liner. A multi-paragraph block is fine when the WHY needs
  one — the existing `DUMMY_PASSWORD_HASH_PROMISE` block in
  `backend/src/auth.ts` and the `TRUST_PROXY` validation block in
  `backend/src/index.ts` are the canonical examples. Don't pad short
  WHYs into long blocks; don't compress real reasoning into one line
  to satisfy a length rule.
- **Anchor to the load-bearing line, not the file top.** A comment
  about why a particular `await` order matters goes immediately above
  that `await`, not in the function's docstring.
- **PR descriptions are not durable documentation.** If a reviewer
  asks "why is this written this way?" and the answer wouldn't be
  obvious to the next reader six months from now, the answer is a
  comment.

PR review bots and human reviewers should not flag a multi-paragraph
comment as "too long" by itself — only "the WHY here is obvious /
already covered elsewhere / wrong" is a valid objection.

## Git workflow

- **Never commit or push directly to `main`.** Every change — feature, fix, docs, CI, config — goes on a branch and through a PR. Main is branch-protected, but this is the policy regardless.
- **Rebase the branch on `origin/main` before pushing** so the PR diff is clean and CI runs against current main. If conflicts surface, resolve them locally, re-run `npm run build` / `npm test` where relevant, then push.
- Branch names use the commit-type prefix: `feat/…`, `fix/…`, `docs/…`, `ci/…`, `refactor/…`.
- One PR = one coherent change. Don't bundle unrelated fixes; open separate PRs so the review bot and humans can read each cleanly.

## Reporting findings

When reviewing code or reporting issues, format each finding as a structured block — not freeform prose. This mirrors the PR review bot's output (`.github/workflows/claude-review.yml`) so both channels look the same to the reader.

### Template

```markdown
### [SEVERITY] <one-line headline>

**Where:** `<relative/file/path.ts:start-end>`
**What:** <what's wrong; quote the relevant code inline>
**Why it matters:** <concrete consequence — not "might be bad">
**Fix:** <smallest change that resolves it; a few lines of pseudo-diff are fine>
```

### Severity labels

- **[BLOCKER]** — data loss, RCE, auth bypass, irreversible bad state.
- **[SHOULD-FIX]** — correctness bug users will hit, a likely security issue, or a meaningful defense-in-depth gap.
- **[NIT]** — readability/subjective (not linter territory).

Match actual impact, not a default.

### Full-review envelope

For a top-to-bottom review ("review this PR", "audit this file"), wrap the blocks:

```markdown
## Summary

2-4 sentences: what the change actually does and any mismatch with its stated intent.

## Findings

_No issues found._ — or one finding block per issue —

## Verdict

**BLOCKER** / **SHOULD-FIX** / **NIT** / **LGTM**
```

For an incidental finding surfaced while doing other work, a bare block is fine — skip the envelope.

### Rules

- Zero findings is a valid outcome. Don't invent issues to look thorough.
- Quote code directly — single-backtick for ≤1 line, four-space-indented for multi-line. Don't paraphrase.
- `file:line` anchors are mandatory.
- "Why it matters" names a concrete consequence (data loss, auth bypass, wrong answer for user X, slow render, …). If you can only write "might be bad", drop it.
- Inconclusive cross-file check? Prefix the headline with `needs verification:` — at most once per review.
- Don't nitpick what a linter would catch.

### Example

```markdown
### [SHOULD-FIX] reconcile() leaves stale container_id on externally removed container

**Where:** `backend/src/dockerManager.ts:847-855`
**What:** The catch branch flips status but never nulls `container_id`:

    } catch (err) {
        await this.sessions.updateStatus(row.session_id, "stopped");
    }

**Why it matters:** Any WS attach between reconcile and the next `/start` hands the dead id to Docker and the user sees "No such container".
**Fix:** Null the id atomically:

    - await this.sessions.updateStatus(row.session_id, "stopped");
    + await this.sessions.recordContainerGone(row.session_id);
```

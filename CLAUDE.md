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

`TRUST_PROXY` should be set to the integer hop count behind the front-most proxy (typically `1` for Cloudflare Tunnel). Refuses `true` because Express in that mode takes the leftmost (attacker-controlled) `X-Forwarded-For` entry, defeating per-IP rate limiting. Unset is fine for local dev (req.ip = socket address).

`PORT_PROXY_BASE_DOMAIN` is the optional base for the per-session-port reverse proxy (#190). When set, hosts of the form `p<container>-<sessionId>.<base>` are diverted to the dispatcher; when unset, port exposure is silently disabled (so dev/local without a Tunnel keeps working). Pair with `COOKIE_DOMAIN` set to a parent shared by the API hostname and the dispatcher base, otherwise the JWT cookie is host-only and private-port auth structurally fails. Boot logs warn loudly when one is set without the other.

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

### Port-exposure dispatcher (#190)

Sessions can declare ports under `config.ports[]`. `DockerManager.spawn()` passes `-p 0:<container>` per declared port, reads the kernel-assigned host port back via `inspect()`, and persists it to `sessions_port_mappings` (`{ session_id, container_port, host_port, is_public }`). `allowPrivilegedPorts: true` re-grants exactly `CAP_NET_BIND_SERVICE` (and only that capability) on `docker run`. The mapping table is rewritten on every container start (spawn, startContainer Case-2, reconcile) and cleared on stop / kill / hard-delete via direct `clearPortMappings(sessionId)` calls in `dockerManager.ts`.

`portDispatcher.ts` is an Express middleware + WS-upgrade handler that intercepts requests whose Host header parses as `p<port>-<sessionId>.<PORT_PROXY_BASE_DOMAIN>`, looks up the runtime mapping via `lookupDispatchTarget` (single JOIN of `sessions_port_mappings` ⋈ `sessions WHERE status='running'`), and reverse-proxies to `127.0.0.1:<host_port>` via `http-proxy`. Auth gate: `public: false` requires the same `st_token` cookie + ownership the rest of the app uses; `public: true` skips auth (webhook / OAuth-callback shape). Both HTTP and WS paths run an `isAllowedWsOrigin` CSWSH/CSRF check before `authorize()` so a cross-origin browser request from `evil.com` can't ride the user's `SameSite=None` cookie. The dispatcher mounts BEFORE `express.json` / `cookieParser` / CORS so the proxied body stream isn't consumed and CORS isn't overlaid on the proxied app's response.

Defence-in-depth around the proxy: `proxyTimeout: 30_000` (no fd-leak from a stuck container), explicit `followRedirects: false` (a 3xx from the container app must not be chased from the backend's network perspective), `changeOrigin: true` (rewrites the outbound Host so Vite-style `allowedHosts`-checked apps don't 400), and a per-IP rate limiter on both HTTP (`express-rate-limit`, 300/min) and WS upgrades (custom in-memory fixed-window limiter, 60/min, `wsUpgradeRateLimit.ts`). The WS limiter keys on `resolveClientIp(xff, remoteAddr, trustProxyValue)` which mirrors proxy-addr's numeric-trust algorithm — peel `trustProxy` entries from the right of `[...XFF, remoteAddress]` — so behind a Tunnel the limiter keys on the original client, not the Tunnel's shared egress IP.

### Idle auto-stop sweeper (#194)

`idleSweeper.ts` is a process-local in-memory `Map<sessionId, lastActivityAt>` swept every 60 s. For each session whose status is `running` and whose `session_configs.idle_ttl_seconds` is non-null, sessions whose last bump exceeds the TTL get a soft-stop (same code path as `POST /stop`). The boot path (`index.ts`) seeds `now()` for every running session via `init(...)` so the first sweep doesn't reap a session whose users haven't reconnected yet (the previous backend's bumps are gone).

Activity sources: every WS data chunk (output from tmux via the `outputListener` closure, input from the browser, resize events) and every authed REST hit under `/api/sessions/:id`. The REST bump is hooked on `res.on("finish")` and gated on `res.statusCode < 400` so a foreign-session probe (`GET /sessions/<not-mine>`) gets its 403 from `assertOwnership` BEFORE the bump fires — without that gate, any authed user could keep someone else's session alive by hitting their id in a loop. Stop / kill / hard-delete handlers set `res.locals.skipIdleBump = true` and call `idleSweeper.forget(sessionId)`; the bump-middleware's `finish` listener checks the flag and skips, otherwise the bump would fire AFTER the synchronous `forget` and silently re-add the entry.

The TTL boundary is inclusive (`idle <= ttl` stays alive) so a session whose idle exactly matches the TTL gets one more window. Per-row stop failures are isolated (one stuck container doesn't stall the sweep), and sweep errors are log-and-continue at both layers so a transient D1 hiccup doesn't kill the timer.

### Templates (#195)

Per-user reusable session-config presets. `templates` D1 table (`id, owner_user_id, name, description, config JSON, created_at, updated_at`) with a per-user count cap (`MAX_TEMPLATES_PER_USER = 100`). The `config` column stores raw JSON in the same shape as `session_configs` MINUS secret values: `secret`-typed env entries collapse to `secret-slot` markers, and `auth.pat` / `auth.ssh.privateKey` are dropped (only the auth-method declaration is preserved so the `Use template` flow knows to re-prompt).

The route layer enforces this in two passes: `validateSessionConfig(body.config, { allowSecretSlots: true, allowMissingAuth: true })` accepts the template-shape config (slots are allowed, the `repo.auth: "pat"` declaration without a co-present `auth.pat` is allowed), then `assertTemplateConfigShape` rejects any live credential a misbehaving client tried to smuggle (`type: "secret"` envVars, `auth.pat`, `auth.ssh.privateKey`). The two-pass shape exists because the schema-level flag relaxes constraints in one direction (accept slots) while the route-level guard tightens in the other (reject plaintext) — neither direction alone would land the right wire-shape.

Auth model: `getOwned(id, userId)` collapses missing + foreign-owned into a single `NotFoundError` (probe-attacker enumeration via status-code timing); `assertOwnership(id, userId)` distinguishes 404 from 403 for destructive paths (DELETE / PUT). The `update` SQL pins `WHERE id = ? AND owner_user_id = ?` as defence-in-depth even though `assertOwnership` is the gate. The list endpoint returns a `TemplateSummary` (no `config`) — full configs are fetched on demand via `GET /:id` to keep the templates-page list response small.

Frontend strip + apply helpers (`api.ts`): `stripConfigForTemplate(config)` is the pure, non-destructive client-side scrub before save; `applyTemplateToForm` reverse-maps a stored config back into the form's in-memory state on `Use template`, with secret-slot rows collapsing to `type:"secret"` with empty values for the user to fill in. Resource units are converted via `memBytesToFormUnit` and `idleSecondsToFormUnit` so the user sees the same GiB / hours values they would have typed.

### Auth

- JWT is delivered as an httpOnly cookie named `st_token` set by `setAuthCookie` in `auth.ts`. `Secure` is on in production, `SameSite=None` in production (cross-site Pages → Tunnel) / `SameSite=Strict` in dev. CSRF for state-changing JSON routes is handled by the CORS preflight + `Content-Type: application/json` requirement; the CORS middleware in `index.ts` only echoes `Access-Control-Allow-Credentials: true` for an exact-origin match against `CORS_ORIGINS`. JS cannot read the token (closing the XSS exfiltration path).
- REST: `requireAuth` middleware reads `req.cookies.st_token` (cookie-parser populated) with a raw-`Cookie`-header fallback for tests bypassing middleware. First visit shows `needsSetup: true` from `/api/auth/status`, which also returns `authenticated` so the frontend can route between login and app on first load without a separate round-trip.
- WebSocket: `verifyWsToken` reads the cookie from the upgrade request's `Cookie` header — browsers send cookies on the WS handshake to the cookie's domain automatically. CSWSH protection is independent: `isAllowedWsOrigin` rejects unlisted origins before `wss.handleUpgrade` runs. There is no subprotocol or query-string auth fallback.
- `sessions.assertOwnership(sessionId, userId)` is the single choke point for authorization on REST and WebSocket paths.
- Two-tier user model: the bootstrap account is created with `is_admin=1`; invite-redeeming users default to non-admin. Invite mint/revoke is admin-gated (#50). Add new admin-only routes through the same `is_admin` check, not a parallel mechanism.

### Admin endpoints (#241)

Cross-user observability + force-actions for operators. All routes mount under `/api/admin`, gated by `requireAuth` then `requireAdmin` (same `is_admin` claim from the JWT used by the invite routes — no parallel mechanism).

- `GET /api/admin/stats` — boot time, uptime, sessions grouped by status (`countByStatus`), plus process-local subsystem counters: `idleSweeper.getStats()` (last sweep, swept since boot, current map size), `docker.getReconcileStats()`, `getDispatcherStats()` (HTTP `requestsSinceBoot` + per-status-class buckets — rate-limited 429s are NOT counted because `dispatcherLimiter` mounts before the dispatcher), and `getD1CallsSinceBoot()`. All counters are in-memory; reset on every backend restart. `bootedAt` is derived as `Date.now() - process.uptime() * 1000` rather than from a `Date.now()` snapshot at module load — `process.uptime()` is reachable from any call site, so no module-level mutable variable is needed. Side-effect: `bootedAt` shifts with NTP-induced steps to `Date.now()`, so it reflects the NTP-corrected boot wallclock rather than the (possibly off) pre-correction reading.
- `GET /api/admin/sessions` — cross-user session list, hard-capped at `ADMIN_LIST_LIMIT = 500` rows newest-first. Inner-joins `users` to emit `ownerUsername`; emits `userId` (the user-facing `serializeMeta` deliberately omits it). `SessionManager.listAll()` is the only data source — do not call it from non-admin code paths, it bypasses user-scoping.
- `POST /api/admin/sessions/:id/stop` — same code path as `POST /sessions/:id/stop` minus `assertOwnedBy`. Returns 204 (not the updated meta) because the dashboard always re-fetches the full list after an action — saves a D1 round-trip per action. Calls `idleSweeper.forget` so a future race with the owner reconnecting doesn't leave stale activity entries.
- `DELETE /api/admin/sessions/:id[?hard=true]` — mirrors the user-facing delete, idempotent in the soft branch (only kills + terminates if not already torn down). Force-delete is the same operation the owner could have done themselves, not a stronger semantic.

`adminStatsIp` (per-IP, shared by `/stats` + `/sessions` because a dashboard polls both) and `adminActionIp` (per-IP, lower cap for destructive routes) gate the surface. Per-IP keying means admins behind the same NAT share the bucket — same tradeoff the rest of the app's IP limiters make.

### Notes on D1

All `db.ts` calls are HTTP round-trips to Cloudflare. Keep query counts low on hot paths — the WebSocket attach already does multiple lookups per connection. The module also increments a process-local `getD1CallsSinceBoot()` counter surfaced via `GET /api/admin/stats` for quota awareness.

Two hot-path caches exist; both are sessionId-keyed, in-memory, bounded, TTL'd, and invalidated before-AND-after on every writer (the pre/post pattern defends against a concurrent reader landing between the cache delete and the D1 mutation, which would otherwise re-populate the cache from the half-updated table):

- **Dispatch-target cache** (`portMappings.ts`, #238) — `Map<sessionId, byContainerPort>` populated on first miss to `lookupDispatchTarget`. Single TTL = 30 s. Writers: `setPortMappings` / `clearPortMappings` (called from spawn / startContainer / reconcile / kill / stopContainer). Negative results are NOT cached so a freshly-spawned session doesn't get stuck behind a 30-second 404 wall.
- **Ownership cache** (`sessionManager.ts`, #239) — `Map<sessionId, ownerUserId>` short-circuits `assertOwnership` / `assertOwnedBy` (the hottest auth-check path; called on every authed REST hit under `/api/sessions/:id` and every WS attach). 1-hour TTL, `OWNERSHIP_CACHE_MAX = 10_000` entries with delete-then-insert insertion-order eviction. The two callers refresh order differently: `assertOwnedBy` positive hits read via `Map.get` and return without touching `cacheOwnership`, so its eviction is LRU-by-last-miss; `assertOwnership` fetches fresh meta from D1 on every positive-owner check and calls `cacheOwnership` there (mutable meta fields force the round-trip even on a cache hit), so its positive-path eviction is effectively LRU-by-access. Foreign-user probes against a cached entry short-circuit to 403 in either caller without D1 or a cache refresh. Adequate at v1 scale (10k entries × 1-hour TTL means entries age out before most deployments hit the cap). Only owner-id is cached, NOT the full `SessionMeta` — meta fields (status, container_id, last_connected_at, env_vars) mutate, so `assertOwnership` still has to fetch fresh meta for its positive-case return value; only `assertOwnedBy` short-circuits both directions. The cache is safe today because ownership is immutable in v1 (no transfer / admin-takeover flow); the only invalidation point is `deleteRow` on hard delete. The TTL is the safety net if a future feature adds a transfer path without updating the invalidation point here.

Three modules independently grew the same `parseD1Utc(raw, context)` helper — D1's `datetime('now')` returns suffix-less SQLite UTC (`YYYY-MM-DD HH:MM:SS`), and Node's `new Date()` parses those as LOCAL time on every engine, so a row written at `10:00:00` UTC becomes a `Date` three hours off on a UTC-3 host. It now lives in `d1Time.ts`; consume from there rather than reinventing.

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

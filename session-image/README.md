# Session image

One container per Shared Terminal session: Ubuntu 24.04, Node 22, the
Claude CLI (pinned in the `Dockerfile`), tmux, `gh` and the VS Code CLI. The
backend spawns it with the workspace bind-mounted at
`/home/developer/workspace`; `entrypoint.sh` moves the CLI's state and the
npm prefix into the workspace so they survive a recreate.

```bash
docker build -t shared-terminal-session ./session-image
./session-image/smoke-test.sh shared-terminal-session          # entrypoint, persistence, exec scripts
./session-image/conversation-smoke.sh shared-terminal-session  # conversation hooks
```

Both smoke tests need docker, jq, and `npm ci` in `backend/`. CI runs them in
`.github/workflows/session-image.yml` whenever their inputs change.

## Conversation hooks (managed settings)

Phase 3 conversation capture ([docs/CONVERSATION.md](../docs/CONVERSATION.md))
uses the CLI's official hooks. The image's part is three fixed paths. On its
own it does nothing.

| Path | In the image | At runtime |
| --- | --- | --- |
| `/etc/claude-code/managed-settings.d/` | empty, `root:root 0755` | the backend bind-mounts `<WORKSPACE_ROOT>/.claude-managed/<sessionId>/` here **read-only**, holding `conversation.json`, only when capture is requested for the session and `CONVERSATION_ENABLED=true` |
| `/opt/st/hooks/session-start.sh` | `root:root 0755` | the one `command` hook (`SessionStart`, `async`); every other event is a `type: "http"` hook sent by the CLI itself |
| `/opt/st/hooks/relay.py` | `root:root 0755` | the loopback relay every hook posts to (§2.6), started by `entrypoint.sh` only when capture is effective |

- **Why a relay.** Claude Code 2.1.308 refuses to send an HTTP hook to a host
  that resolves to a private or link-local address (`HTTP hook blocked: …
  (private/link-local address)`), and `st-backend` on `sessions-net` always
  does. Loopback is allowed, so the hooks target `http://127.0.0.1:47613/…`,
  a small stdlib-Python process inside the container that forwards to
  `http://st-backend:$ST_BACKEND_PORT/ingest/claude/hook`. The protection is
  deliberate; the relay does not get around it (it cannot be reached from
  outside the container, has one fixed destination and is not a proxy).
- **Off is the default.** With nothing mounted or an empty mount, the CLI loads
  no hooks and sends no requests, and the relay does not start: no process, no
  open port. A token in the environment without the file changes nothing
  either. The smoke test checks all three.
- **On.** The entrypoint starts the relay (under a small restart loop) when
  `ST_INGEST_TOKEN` is set **and** `conversation.json` is mounted. The CLI
  POSTs each hook event to the relay with `X-ST-Tmux-Pane: $TMUX_PANE` and
  `timeout: 1`; the relay answers **204 with an empty body** as soon as the
  body is queued and forwards in order, adding `Authorization: Bearer
  $ST_INGEST_TOKEN` and `X-ST-Session: $SESSION_ID` from its own env. The CLI
  never handles the token, and nothing the backend answers ever reaches the
  CLI, so a hook never decides anything: permission prompts still reach the
  user, and tool calls and turns run as they would without hooks.
- **Bounded.** ≤ 16 inbound connections, a FIFO of ≤ 1024 events and 16 MiB,
  2 s socket timeouts, one upstream connection, a 1 s pause after an upstream
  failure. What it cannot deliver it counts and reports on the next delivered
  event of the same conversation (`X-ST-Relay-*` ⇒ `gap relay_dropped` /
  `relay_restart`). A 204 from the relay means *received in the container*,
  not persisted: there is no retry and no disk buffer.
- **Managed precedence.** These hooks merge with the user's own hooks. Both
  run, and the smoke test checks this. A user-level `disableAllHooks` cannot
  switch them off, because only managed settings can. The session user cannot
  create a managed file or edit the script or the relay, since all are
  root-owned. The relay runs as the session user, who can kill it: that only
  stops their own capture.
- **`session-start.sh`** exits at once without `ST_INGEST_TOKEN`. Otherwise it
  adds `st.{claude_version, tmux_session, pane, argv_flags}` and posts to the
  relay with `curl --max-time 2`. It is bounded as a whole by `timeout -k 1 5`,
  because the CLI enforces no timeout on async hooks. It never prints to stdout
  and always exits 0. `-q --noproxy '*'` ignores `~/.curlrc` and `*_proxy`.
- **Backend absent, hung or odd.** The relay still answers every hook at once,
  so the agent's timings and results are unchanged and the terminal shows no
  "hook error"; the losses come back as a `gap relay_dropped` when the backend
  does. Only a dead relay (connection refused) or a stopped one (SIGSTOP,
  ≤ 1 s per blocking hook) is visible to the CLI.
- **Proxies.** The relay never uses `*_PROXY`. The CLI would send the hooks to
  a proxy in the session env, so when capture is effective and the session env
  defines one, the backend adds `127.0.0.1` to `NO_PROXY`/`no_proxy`.
- **Debugging.** `ST_HOOKS_DEBUG=1` in the session env makes the relay write
  counters (never bodies, headers or tokens) to `/tmp/st-relay.log`.

### Bumping the CLI pin

The pin only seeds **fresh** workspaces. Existing ones keep their persisted
(self-updating) `.npm-global` copy, so capture depends on the version
actually running. `session_start.claude_version` reports it.

On a pin bump:

1. Run both smoke tests.
2. Re-record `backend/src/conversation/fixtures/cli-<version>-hooks.jsonl`
   (the real payloads `cliPayloads.test.ts` normalises) by running the
   scenarios of `session-image/test/mock-anthropic.mjs` against
   `session-image/test/st-receiver.mts` (its `RAW_OUT` file is the input).
   Rewrite host paths to the in-container ones.
3. Check the dropped-fields snapshot in `cliPayloads.test.ts`.

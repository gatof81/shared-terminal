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
uses the CLI's official hooks. The image's part is two fixed paths. On its own
it does nothing.

| Path | In the image | At runtime |
| --- | --- | --- |
| `/etc/claude-code/managed-settings.d/` | empty, `root:root 0755` | the backend bind-mounts `<WORKSPACE_ROOT>/.claude-managed/<sessionId>/` here **read-only**, holding `conversation.json`, only when capture is requested for the session and `CONVERSATION_ENABLED=true` |
| `/opt/st/hooks/session-start.sh` | `root:root 0755` | the one `command` hook (`SessionStart`, `async`); every other event is a `type: "http"` hook sent by the CLI itself |

- **Off is the default.** With nothing mounted or an empty mount, the CLI loads
  no hooks and sends no requests. The smoke test checks this with `-p` runs and
  an interactive turn against a listening receiver. A token in the environment
  without the file changes nothing either.
- **On.** The CLI POSTs each hook event to
  `http://st-backend:3001/ingest/claude/hook` with `Authorization: Bearer
  $ST_INGEST_TOKEN`, `X-ST-Session: $SESSION_ID` and `X-ST-Tmux-Pane:
  $TMUX_PANE`, using `timeout: 1`. The receiver always answers 204 with an
  empty body, so a hook never decides anything: permission prompts still reach
  the user, and tool calls and turns run as they would without hooks.
- **Managed precedence.** These hooks merge with the user's own hooks. Both
  run, and the smoke test checks this. A user-level `disableAllHooks` cannot
  switch them off, because only managed settings can. The session user cannot
  create a managed file or edit the script, since both paths are root-owned.
- **`session-start.sh`** exits at once without `ST_INGEST_TOKEN`. Otherwise it
  adds `st.{claude_version, tmux_session, pane, argv_flags}` and posts with
  `curl --max-time 2`. It is bounded as a whole by `timeout -k 1 5`, because
  the CLI enforces no timeout on async hooks. It never prints to stdout and
  always exits 0. The token goes to curl through a header file rather than
  argv, and `-q --noproxy '*'` ignores `~/.curlrc` and `*_proxy`.
- **Receiver absent.** While the backend is down, `st-backend` does not resolve
  and each hook fails immediately. The agent's results are unchanged, and the
  errors never reach the model, but the CLI does print a "hook error" line in
  the terminal for blocking events (see the PR 3.0c notes in
  docs/CONVERSATION.md §2.2).

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

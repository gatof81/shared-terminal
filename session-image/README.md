# Session image

One container per Shared Terminal session: Ubuntu 24.04, Node 22, the
Claude CLI (pinned in the `Dockerfile`), tmux, `gh` and the VS Code CLI. The
backend spawns it with the workspace bind-mounted at
`/home/developer/workspace`; `entrypoint.sh` moves the CLI's state and the
npm prefix into the workspace so they survive a recreate.

```bash
docker build -t shared-terminal-session ./session-image
./session-image/smoke-test.sh shared-terminal-session   # entrypoint, persistence, exec scripts
```

The smoke test needs docker, jq, and `npm ci` in `backend/`. CI runs it in
`.github/workflows/session-image.yml` whenever its inputs change.

`/opt/st/seed-skills.sh` (`root:root 0755`) copies the default skills
(`/opt/session-skills` → `~/.claude/skills`) on every boot; it refreshes the
managed skills and never touches other skills.

### Bumping the CLI pin

The pin only seeds **fresh** workspaces. Existing ones keep their persisted
(self-updating) `.npm-global` copy. On a pin bump, run the smoke test.

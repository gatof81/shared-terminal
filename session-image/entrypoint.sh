#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# Session container entrypoint.
#
# The container's lifetime is independent of tmux. Tabs (one tmux session
# each) are created on demand by the backend — no tab is created here, so
# there is no boot-time race where a client lists tabs before entrypoint has
# finished provisioning one. The user creates their first tab from the UI.
# ──────────────────────────────────────────────────────────────────────────────
set -e

cd /home/developer/workspace

# Persist VS Code CLI tunnel state across container replacement.
#
# `code tunnel` writes its device-login token, tunnel name, and registration
# state into ~/.vscode-cli/. That path lives in the container layer, which
# is thrown away on stop/start (POST /sessions/:id/start respawns a fresh
# container, host reboot triggers reconcile()). Without this redirection,
# every restart would force the user back through the interactive
# https://github.com/login/device flow.
#
# Stash it inside the bind-mounted workspace dir instead, so it shares the
# same lifetime contract as the user's source tree (kept on soft-delete +
# restart, purged on hard-delete). Dot-prefixed so it stays out of normal
# `ls` output and out of git's view.
#
# Both steps are best-effort: if the workspace mount is owned by a UID the
# `developer` user can't write to (e.g. operator misconfigured WORKSPACE_UID,
# or future Ubuntu base bumps and the Dockerfile fix slips), `mkdir` would
# fail with EACCES and `set -e` would kill the entrypoint. That used to
# crash-loop the whole container, taking every `docker exec` (including
# `tmux list-sessions` from listTabs) down with it — a 500 from
# /api/sessions/:id/tabs on every freshly-spawned session. Code tunnel
# auth persistence is a nice-to-have; keeping the container alive isn't.
# Trap the failure, log loudly enough that an operator can find it, and
# carry on.
#
# stderr stays visible for the same reason the Dockerfile's `userdel`
# does — the WARN line gives context, but the kernel's actual errno
# (EACCES vs. ENOSPC vs. EROFS) is what an operator needs to fix the
# real problem in `docker logs`. The `if !` test handles the non-zero
# exit; we don't need to swallow the message too.
if ! mkdir -p /home/developer/workspace/.vscode-cli; then
        echo "[entrypoint] WARN: couldn't create workspace .vscode-cli dir " \
             "(uid=$(id -u), workspace owner=$(stat -c '%u:%g' /home/developer/workspace 2>/dev/null || echo '?')). " \
             "code tunnel auth won't persist across restarts." >&2
elif ! ln -sfn /home/developer/workspace/.vscode-cli /home/developer/.vscode-cli; then
        echo "[entrypoint] WARN: couldn't symlink ~/.vscode-cli into workspace; " \
             "code tunnel auth won't persist across restarts." >&2
fi


echo "[entrypoint] container ready — create a tab from the UI to begin"

# Keep PID 1 alive independent of tmux. tmux-server now starts lazily on the
# first `tmux new-session` from the backend, and dying on its own (last tab
# closed, crash) no longer bubbles up and kills the container.
exec tail -f /dev/null

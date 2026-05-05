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

# Persist the user-level npm global prefix across container replacement.
#
# Dockerfile sets NPM_CONFIG_PREFIX=/home/developer/.npm-global and bakes
# the Claude CLI into that directory at build time. Without this block,
# every `claude` self-update (and any user-installed `npm install -g …`)
# would land in the container layer and vanish on the next /start, putting
# the user back on whatever version the image baked.
#
# The wrinkle vs. the .vscode-cli block below: ~/.npm-global already
# exists as a populated directory after the image build, so a plain
# `mkdir -p` + `ln -sfn` would put a symlink *inside* the existing dir
# instead of replacing it. We branch on what's already there:
#
#   - Symlink already in place — left over within this container's
#     lifetime. Nothing to do; the rest of the entrypoint can run.
#   - Workspace already seeded — operator/user has prior state. Drop the
#     image's fresh copy and symlink the home path into the workspace.
#     User-persisted version wins over a re-baked image so a self-updated
#     Claude survives an image bump.
#   - First boot, no workspace seed — move the image's directory into
#     the bind mount, then symlink. Bind mounts and the container layer
#     are different filesystems so `mv` falls back to copy+unlink, which
#     is what we want.
#
# Best-effort: any failure WARNs loudly and falls through to use the
# image's local copy at ~/.npm-global (still on PATH, since
# /home/developer/.npm-global/bin is prepended in the Dockerfile). Claude
# still works in that container, it just won't persist self-updates.
NPM_GLOBAL_HOME=/home/developer/.npm-global
NPM_GLOBAL_WS=/home/developer/workspace/.npm-global

if [ ! -L "$NPM_GLOBAL_HOME" ]; then
        if [ -d "$NPM_GLOBAL_WS" ]; then
                if ! rm -rf "$NPM_GLOBAL_HOME"; then
                        echo "[entrypoint] WARN: couldn't drop image .npm-global; " \
                             "claude self-updates and runtime npm globals won't persist across restarts." >&2
                fi
        elif [ -d "$NPM_GLOBAL_HOME" ]; then
                if ! mv "$NPM_GLOBAL_HOME" "$NPM_GLOBAL_WS"; then
                        echo "[entrypoint] WARN: couldn't seed workspace .npm-global from image " \
                             "(uid=$(id -u), workspace owner=$(stat -c '%u:%g' /home/developer/workspace 2>/dev/null || echo '?')). " \
                             "claude self-updates and runtime npm globals won't persist across restarts." >&2
                fi
        fi
        # Skip the symlink if the prior step left ~/.npm-global in place —
        # `ln -sfn` against an existing real directory creates the link
        # *inside* it (with the basename of the target), which is exactly
        # the breakage we're trying to avoid.
        if [ ! -e "$NPM_GLOBAL_HOME" ] && [ -d "$NPM_GLOBAL_WS" ]; then
                if ! ln -sfn "$NPM_GLOBAL_WS" "$NPM_GLOBAL_HOME"; then
                        echo "[entrypoint] WARN: couldn't symlink ~/.npm-global into workspace; " \
                             "claude self-updates and runtime npm globals won't persist across restarts." >&2
                fi
        fi
fi

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

# Persist GitHub CLI auth state across container replacement.
#
# `gh auth login` writes its OAuth token + host config to
# ~/.config/gh/{hosts,state}.yml. That path lives in the container layer,
# so without this redirection every `POST /start` (which respawns the
# container, see Architecture in CLAUDE.md) would force the user back
# through the device-code flow. README's "auth once" line implicitly
# assumes the redirection is in place.
#
# Auth lifetime intentionally tied to the *workspace*, not the *image*:
# - New session (fresh workspace) → empty .config/gh → no leaked tokens
#   from a previous user / context.
# - Existing session restarted (same workspace) → tokens persist, no
#   re-auth on every container recycle.
# Same contract as ~/.vscode-cli above and ~/.npm-global below.
#
# Only ~/.config/gh is symlinked, not ~/.config wholesale: other tools
# may also use XDG and we don't want their state hitching a ride into
# the workspace bind mount unintentionally. ~/.config itself stays a
# real directory in the container layer so the symlink lands cleanly.
#
# Best-effort, same WARN-and-carry-on pattern as the blocks above.
if ! mkdir -p /home/developer/.config /home/developer/workspace/.config/gh; then
        echo "[entrypoint] WARN: couldn't create workspace .config/gh dir " \
             "(uid=$(id -u), workspace owner=$(stat -c '%u:%g' /home/developer/workspace 2>/dev/null || echo '?')). " \
             "gh auth state won't persist across restarts." >&2
elif ! ln -sfn /home/developer/workspace/.config/gh /home/developer/.config/gh; then
        echo "[entrypoint] WARN: couldn't symlink ~/.config/gh into workspace; " \
             "gh auth state won't persist across restarts." >&2
fi


echo "[entrypoint] container ready — create a tab from the UI to begin"

# Keep PID 1 alive independent of tmux. tmux-server now starts lazily on the
# first `tmux new-session` from the backend, and dying on its own (last tab
# closed, crash) no longer bubbles up and kills the container.
exec tail -f /dev/null

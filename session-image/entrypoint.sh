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
# Two-step structure:
#
#   1. Seed the workspace dir from the image's copy if the workspace
#      doesn't have one yet (first boot of a fresh workspace). `cp -a`
#      preserves the source — the image's directory stays available so
#      Step 2 has something to fall back on if the symlink swap fails.
#
#   2. Replace ~/.npm-global with a symlink to the workspace dir. This
#      uses a rename-then-restore dance instead of `rm -rf && ln -sfn`:
#      stash the image dir to .old, then ln, then drop .old on success;
#      on ln failure, restore .old back to ~/.npm-global. The naive
#      rm-then-ln approach would leave the container with neither the
#      directory nor the symlink if ln failed mid-step, taking `claude`
#      offline entirely (not just non-persistent) — see the bot review
#      on PR #131 for the original analysis. The dance keeps the image
#      copy reachable through every transient failure mode.
#
# Best-effort throughout: any failure WARNs and either (a) falls through
# to use the image's local copy at ~/.npm-global (still on PATH, since
# /home/developer/.npm-global/bin is prepended in the Dockerfile), or
# (b) restores the image copy from .old. Either way, claude is still
# usable in that container — only persistence is at risk.
NPM_GLOBAL_HOME=/home/developer/.npm-global
NPM_GLOBAL_WS=/home/developer/workspace/.npm-global
NPM_GLOBAL_OLD="${NPM_GLOBAL_HOME}.old"

if [ ! -L "$NPM_GLOBAL_HOME" ]; then
        # Step 1: seed the workspace dir on first boot. cp -a (not mv)
        # so the image copy stays in place if Step 2 needs to roll back.
        if [ ! -d "$NPM_GLOBAL_WS" ] && [ -d "$NPM_GLOBAL_HOME" ]; then
                if ! cp -a "$NPM_GLOBAL_HOME" "$NPM_GLOBAL_WS"; then
                        echo "[entrypoint] WARN: couldn't seed workspace .npm-global from image " \
                             "(uid=$(id -u), workspace owner=$(stat -c '%u:%g' /home/developer/workspace 2>/dev/null || echo '?')). " \
                             "claude self-updates and runtime npm globals won't persist across restarts." >&2
                fi
        fi

        # Step 2: rename-then-restore swap. Only runs if both the workspace
        # dir is present (either pre-seeded or freshly seeded above) and the
        # image's ~/.npm-global is still a real directory waiting to be
        # replaced.
        if [ -d "$NPM_GLOBAL_WS" ] && [ -d "$NPM_GLOBAL_HOME" ] && [ ! -e "$NPM_GLOBAL_OLD" ]; then
                if ! mv "$NPM_GLOBAL_HOME" "$NPM_GLOBAL_OLD"; then
                        echo "[entrypoint] WARN: couldn't rename ~/.npm-global to swap in symlink; " \
                             "claude self-updates and runtime npm globals won't persist across restarts." >&2
                elif ln -sfn "$NPM_GLOBAL_WS" "$NPM_GLOBAL_HOME"; then
                        rm -rf "$NPM_GLOBAL_OLD"
                else
                        # ln failed after successful rename. Roll back so
                        # ~/.npm-global is the image's regular directory
                        # again — claude stays available, persistence is
                        # the only thing lost. The mv-back is best-effort
                        # itself; if it fails the container is broken, but
                        # at that point the operator has bigger problems
                        # than this entrypoint.
                        mv "$NPM_GLOBAL_OLD" "$NPM_GLOBAL_HOME" || true
                        echo "[entrypoint] WARN: couldn't symlink ~/.npm-global into workspace; " \
                             "image copy restored — claude works but self-updates won't persist across restarts." >&2
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

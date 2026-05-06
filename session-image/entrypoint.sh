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

# Step 0: recover from a prior-boot crash mid-swap. The container can be
# SIGKILL'd / OOM'd / lose the host between Step 2's `mv` and `ln`, leaving
# .old behind on disk. `docker start` re-runs entrypoint with that state on
# disk (the layer is preserved across stop/start, this only resets on
# /sessions/:id/start which recreates the container). Three cases:
#
#   - ~/.npm-global is missing, .old exists → crash between mv and ln on
#     a prior boot. Restore from .old so PATH lookups work and Step 2 can
#     re-attempt the swap.
#   - ~/.npm-global is a symlink or directory, .old exists → either a
#     crash between ln and rm (symlink case), or a more exotic interleave
#     where home was rebuilt (directory case). Either way .old is stale;
#     drop it so Step 2 isn't gated by the `[ ! -e $NPM_GLOBAL_OLD ]`
#     guard below.
#
# Both branches are best-effort: if the restore mv fails the next boot
# will retry, and if the cleanup rm fails .old leaks (cosmetic, not
# functional). The entrypoint must not exit on these.
if [ -e "$NPM_GLOBAL_OLD" ]; then
        # `-e` follows symlinks and reports false on a dangling one (target
        # gone, e.g. workspace unmounted after a successful ln). Without the
        # `-L` clause the dangling-symlink + stale-.old case would mis-route
        # to the restore branch and the .old dir would replace the symlink,
        # contradicting the comment above ("symlink case → drop .old").
        if [ ! -e "$NPM_GLOBAL_HOME" ] && [ ! -L "$NPM_GLOBAL_HOME" ]; then
                mv "$NPM_GLOBAL_OLD" "$NPM_GLOBAL_HOME" || true
        else
                rm -rf "$NPM_GLOBAL_OLD" || true
        fi
fi

# Enter the seed-and-swap block if ~/.npm-global is anything other than a
# *working* symlink: a real directory (image-fresh container), a missing
# path (defensive), or a dangling symlink (user wiped workspace/.npm-global
# from inside the session, then container restarted without recreating —
# the container layer's symlink survived but the target is gone).
#
# A dangling symlink alone wouldn't be cleared by the rest of the block:
# Step 1 needs ~/.npm-global to be a real directory to cp from, and Step 2
# needs it to be a real directory to mv. Both tests fail on a dangling
# symlink. Clear it explicitly so subsequent commands aren't confused, and
# so PATH lookups stop resolving through a stale entry.
#
# Recreate (POST /sessions/:id/start) resets the container layer to the
# image's real ~/.npm-global directory, so this branch isn't needed there.
# The dangling case is specifically for the stop+start path that preserves
# the layer.
if [ ! -L "$NPM_GLOBAL_HOME" ] || [ ! -e "$NPM_GLOBAL_HOME" ]; then
        if [ -L "$NPM_GLOBAL_HOME" ]; then
                rm -f "$NPM_GLOBAL_HOME" || true
        fi
        # Step 1: seed the workspace dir on first boot. cp -a (not mv)
        # so the image copy stays in place if Step 2 needs to roll back.
        if [ ! -d "$NPM_GLOBAL_WS" ] && [ -d "$NPM_GLOBAL_HOME" ]; then
                if ! cp -a "$NPM_GLOBAL_HOME" "$NPM_GLOBAL_WS"; then
                        echo "[entrypoint] WARN: couldn't seed workspace .npm-global from image " \
                             "(uid=$(id -u), workspace owner=$(stat -c '%u:%g' /home/developer/workspace 2>/dev/null || echo '?')). " \
                             "claude self-updates and runtime npm globals won't persist across restarts." >&2
                fi
        elif [ ! -d "$NPM_GLOBAL_WS" ]; then
                # Both source and destination are gone. Reachable when the
                # user wiped ~/workspace/.npm-global from inside the session
                # and the container is then stop+started (the layer's
                # symlink is dangling and was just rm'd by the outer-guard
                # cleanup, but the image's real ~/.npm-global was already
                # consumed by a prior boot's swap). Step 2 will skip, and
                # without this branch we'd exit with no log line — the user
                # would see `claude: command not found` and no entrypoint
                # signal pointing them at the recovery path. POST /start
                # (full recreate) re-seeds from the image.
                echo "[entrypoint] WARN: workspace .npm-global gone and image copy unavailable; " \
                     "claude is not reachable on this container — recover via container recreate " \
                     "(DELETE + POST /sessions/:id/start) so the image's npm-global is re-applied." >&2
        fi

        # Step 2: rename-then-restore swap. Only runs if both the workspace
        # dir is present (either pre-seeded or freshly seeded above) and the
        # image's ~/.npm-global is still a real directory waiting to be
        # replaced. Step 0 ensures .old is absent here under normal
        # conditions; the guard is belt-and-braces in case the recovery mv
        # itself failed.
        if [ -d "$NPM_GLOBAL_WS" ] && [ -d "$NPM_GLOBAL_HOME" ] && [ ! -e "$NPM_GLOBAL_OLD" ]; then
                if ! mv "$NPM_GLOBAL_HOME" "$NPM_GLOBAL_OLD"; then
                        echo "[entrypoint] WARN: couldn't rename ~/.npm-global to swap in symlink; " \
                             "claude self-updates and runtime npm globals won't persist across restarts." >&2
                elif ln -sfn "$NPM_GLOBAL_WS" "$NPM_GLOBAL_HOME"; then
                        # `|| true`: a failure here just leaks .old in the
                        # container layer (Step 0 will clean it on the next
                        # boot). Honour the block's "WARN-and-carry-on"
                        # contract instead of letting `set -e` crash the
                        # entrypoint.
                        rm -rf "$NPM_GLOBAL_OLD" || true
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

# Drop a pre-existing real ~/.vscode-cli before the symlink swap. Same
# silent-loss path as the ~/.config/gh block below (and fixed there in
# #132): if `code tunnel` ever ran on an image without this persistence
# block, or a prior boot's `ln -sfn` failed and code tunnel then wrote
# to the resulting real directory, `unlink(2)` refuses to remove a
# non-empty directory and `ln -sfn` exits non-zero. The user sees auth
# "work" until the container is recycled, then it vanishes with only a
# stale WARN in the logs.
#
# Pre-removing means a one-time re-auth via the device-code flow on the
# upgrade path, which is strictly better than the silent-loss path. Best-
# effort with `|| true`: if the rm fails the WARN below still fires and
# the operator has a signal.
if [ -d /home/developer/.vscode-cli ] && [ ! -L /home/developer/.vscode-cli ]; then
        rm -rf /home/developer/.vscode-cli || true
fi

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
# Same contract as ~/.npm-global and ~/.vscode-cli above.
#
# Only ~/.config/gh is symlinked, not ~/.config wholesale: other tools
# may also use XDG and we don't want their state hitching a ride into
# the workspace bind mount unintentionally. ~/.config itself stays a
# real directory in the container layer so the symlink lands cleanly.
#
# Best-effort, same WARN-and-carry-on pattern as the blocks above.
# Drop a pre-existing real ~/.config/gh before the symlink swap. This
# covers two scenarios that would otherwise silently lose tokens on the
# next /start: (a) an older image that shipped without this entrypoint
# block had `gh auth login` run inside it, leaving credentials in the
# container layer; (b) a prior boot's `ln -sfn` failed (mkdir succeeded,
# WARN fired) and `gh auth login` then wrote to the resulting real
# directory. In either case `ln -sfn` against a non-empty real dir
# fails — `unlink(2)` refuses to remove a directory — so the symlink is
# never created and `gh` writes into the ephemeral container layer.
# The user sees auth "work" until the container is recycled, then it
# vanishes with only a stale WARN in the logs.
#
# Pre-removing the dir means a one-time re-auth on the upgrade path,
# which is strictly better than the silent-loss path. Best-effort with
# `|| true`: if the rm fails, the WARN below will fire and the operator
# at least gets a signal.
if [ -d /home/developer/.config/gh ] && [ ! -L /home/developer/.config/gh ]; then
        rm -rf /home/developer/.config/gh || true
fi

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

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

# Runtime-readiness sentinel (#393), part 1 of 2: clear any stale copy
# BEFORE provisioning starts. The backend never restarts a container
# in place (stop → kill, /start → fresh container), but a manual
# `docker restart` re-runs this script with /tmp intact — without the
# rm, the sentinel from the previous boot would report ready while the
# ~/.npm-global swap below is mid-flight, which is exactly the window
# the sentinel exists to close. Path must match RUNTIME_READY_SENTINEL
# in backend/src/dockerManager.ts.
rm -f /tmp/.st-ready

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
# through the device-code flow. docs/DEPLOYMENT.md's "auth once" line implicitly
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

# Persist Claude CLI state across container replacement.
#
# `claude` keeps its state in two places, both in the container layer:
#
#   - ~/.claude/      — OAuth credentials (.credentials.json), the session
#     transcripts under projects/ that `--resume` / `--continue` replay,
#     and settings.json + CLAUDE.md (including what the bootstrap
#     agentSeed stage writes there).
#   - ~/.claude.json  — top-level config: onboarding state, per-project
#     state, MCP server registrations.
#
# Losing them on a recreate (POST /sessions/:id/start, reconcile after a
# host reboot) forces a re-login and orphans every conversation the user
# expected --resume to find. Same lifetime contract as the three blocks
# above: state rides the workspace, soft delete keeps it, hard delete
# purges it. Transcripts are conversation *content* at rest on the host
# — operator-facing consequences are documented in docs/SECURITY.md
# ("Claude CLI state at rest").
#
# Why symlinks and not CLAUDE_CONFIG_DIR: the env var exists but is
# undocumented (anthropics/claude-code#33430) and not honoured by every
# surface — the VS Code extension ignores it
# (anthropics/claude-code#30538), and `code tunnel` is a first-class
# flow in this image, so relying on the var would split state between
# two locations for tunnel-attached editors. Symlinked default paths
# cover every consumer, documented or not.
#
# Why the targets live under workspace/.st/ and not workspace/.claude
# (#377): `.claude/` at a repo root is ALSO Claude Code's project-level
# config dir, and the workspace root IS the repo root for cloned
# sessions. Targeting workspace/.claude made the CLI's user state and
# the repo's project config the same directory: the rescue guard below
# mistook the repo's dir for an already-seeded workspace copy (and
# dropped the container-layer state it exists to save), user-scope and
# project-scope settings collapsed into one file, credentials +
# transcripts landed in the user's git working tree, and the clone
# step's skip-on-conflict move silently dropped the repo's own
# `.claude/` because the entrypoint had already created one. `.st/` is
# ours — no repo plausibly ships it — and it self-ignores via a `*`
# .gitignore (the node_modules pattern) so a casual `git add -A` in a
# workspace that is a repo checkout can't commit credentials or
# transcripts.
#
# ~/.claude.json is a FILE symlink, which is only safe because the CLI
# resolves the link before its atomic-rename config rewrite — the
# rename lands on the resolved target, and a dangling link (fresh
# workspace, no file yet) gets its target created through the link.
# Both behaviours verified against the shipped CLI version. A future
# CLI that renamed onto the path itself would silently replace the
# symlink with a real file, so the session-image smoke test (#352)
# must assert the symlink survives a config write on every version
# bump.
#
# Unlike ~/.npm-global there is no build-time copy to preserve (the
# image never runs `claude`, so ~/.claude doesn't exist in a fresh
# layer) — no rename-then-restore dance needed. The pre-existing-real-
# dir guards below cover the stop+start path where a prior boot's ln
# failed and the CLI then wrote real state into the container layer.
# That state includes unrecoverable conversation transcripts, so where
# the gh/vscode blocks above just drop the real dir (tokens are
# re-obtainable via a device flow), this block first seeds the
# workspace copy from it — losing transcripts to a transient ln
# failure is strictly worse than the one-time re-auth those blocks
# accept.
CLAUDE_STATE_HOME=/home/developer/.claude
CLAUDE_JSON_HOME=/home/developer/.claude.json
ST_STATE_ROOT=/home/developer/workspace/.st
CLAUDE_STATE_WS="$ST_STATE_ROOT/claude-state"
CLAUDE_JSON_WS="$ST_STATE_ROOT/claude.json"
# Exactly one image generation (#371) targeted these paths; migrated below.
CLAUDE_STATE_WS_LEGACY=/home/developer/workspace/.claude
CLAUDE_JSON_WS_LEGACY=/home/developer/workspace/.claude.json

# The state root must exist before the migration/rescue copies below can
# land inside it. No dedicated WARN on failure: the migration mv, the
# rescue cp and the final mkdir -p all fail loudly on the same root
# cause, with the kernel's errno visible in the logs.
mkdir -p "$ST_STATE_ROOT" || true
if [ -d "$ST_STATE_ROOT" ] && [ ! -e "$ST_STATE_ROOT/.gitignore" ]; then
        printf '*\n' > "$ST_STATE_ROOT/.gitignore" || \
                echo "[entrypoint] WARN: couldn't write workspace/.st/.gitignore; " \
                     "Claude state is committable via 'git add -A' if the workspace is a repo checkout." >&2
fi

# Migrate the #371 layout. Only a dir carrying CLI-state markers moves —
# a project-level .claude/ ships settings/agents but never credentials
# (.credentials.json) or transcripts (projects/), so it stays untouched
# where the repo put it. A #371-era dir that got hand-merged with a
# repo's project config moves wholesale: the repo copies are restorable
# via `git checkout -- .claude`, the credentials/transcripts riding
# along are not restorable at all. mv (rename, not copy) so a partial
# failure can't leave two divergent copies of the state.
if [ -d "$CLAUDE_STATE_WS_LEGACY" ] && [ ! -L "$CLAUDE_STATE_WS_LEGACY" ] && \
        { [ -f "$CLAUDE_STATE_WS_LEGACY/.credentials.json" ] || [ -d "$CLAUDE_STATE_WS_LEGACY/projects" ]; }; then
        if [ ! -e "$CLAUDE_STATE_WS" ]; then
                mv "$CLAUDE_STATE_WS_LEGACY" "$CLAUDE_STATE_WS" || \
                        echo "[entrypoint] WARN: couldn't migrate legacy workspace/.claude state to .st/claude-state; " \
                             "Claude will start from the empty new location." >&2
        else
                echo "[entrypoint] WARN: legacy workspace/.claude state present but .st/claude-state already exists; " \
                     "leaving the legacy copy in place (unused)." >&2
        fi
fi
if [ -f "$CLAUDE_JSON_WS_LEGACY" ] && [ ! -L "$CLAUDE_JSON_WS_LEGACY" ] && [ ! -e "$CLAUDE_JSON_WS" ]; then
        mv "$CLAUDE_JSON_WS_LEGACY" "$CLAUDE_JSON_WS" || \
                echo "[entrypoint] WARN: couldn't migrate legacy workspace/.claude.json to .st/claude.json." >&2
fi

if [ -d "$CLAUDE_STATE_HOME" ] && [ ! -L "$CLAUDE_STATE_HOME" ]; then
        if [ ! -d "$CLAUDE_STATE_WS" ]; then
                cp -a "$CLAUDE_STATE_HOME" "$CLAUDE_STATE_WS" || \
                        echo "[entrypoint] WARN: couldn't rescue container-layer ~/.claude into workspace; " \
                             "existing Claude auth/transcripts will be lost on the symlink swap." >&2
        fi
        rm -rf "$CLAUDE_STATE_HOME" || true
fi
if [ -f "$CLAUDE_JSON_HOME" ] && [ ! -L "$CLAUDE_JSON_HOME" ]; then
        if [ ! -f "$CLAUDE_JSON_WS" ]; then
                cp -a "$CLAUDE_JSON_HOME" "$CLAUDE_JSON_WS" || \
                        echo "[entrypoint] WARN: couldn't rescue container-layer ~/.claude.json into workspace." >&2
        fi
        rm -f "$CLAUDE_JSON_HOME" || true
fi

if ! mkdir -p "$CLAUDE_STATE_WS"; then
        echo "[entrypoint] WARN: couldn't create workspace .st/claude-state dir " \
             "(uid=$(id -u), workspace owner=$(stat -c '%u:%g' /home/developer/workspace 2>/dev/null || echo '?')). " \
             "Claude auth and session transcripts won't persist across restarts." >&2
elif ! ln -sfn "$CLAUDE_STATE_WS" "$CLAUDE_STATE_HOME"; then
        echo "[entrypoint] WARN: couldn't symlink ~/.claude into workspace; " \
             "Claude auth and session transcripts won't persist across restarts." >&2
fi

# Target intentionally NOT pre-created: the CLI creates it through the
# dangling link on first write (verified), so a pre-seeded empty file
# would only add a second content shape ("empty" vs "absent" vs "real
# config") for the CLI and this script to reason about.
if ! ln -sfn "$CLAUDE_JSON_WS" "$CLAUDE_JSON_HOME"; then
        echo "[entrypoint] WARN: couldn't symlink ~/.claude.json into workspace; " \
             "Claude onboarding/project state won't persist across restarts." >&2
fi

# Seed the image's baked default skills into the persisted ~/.claude/skills
# (i.e. $CLAUDE_STATE_WS/skills, reached through the symlink just established)
# so every session — every project — discovers the operator-curated skills
# with no per-session setup. See the "Default Claude Code skills" block in the
# Dockerfile for the source.
#
# Idempotent per boot: it refreshes the managed skills from the image and
# leaves any OTHER skill untouched — one a user added, or the bootstrap
# agentSeed wrote, under a different name, is not clobbered (cp merges, never
# wipes the tree). `cp -r`, not `cp -a`: the source is root-owned and the
# session runs as `developer`, so preserving ownership would fail; the copy
# lands developer-owned (theirs to override) with default modes, which is what
# we want. A WARN, not a hard failure — a session missing the default skills
# still works; the operator just loses the shared helpers.
if [ -d /opt/session-skills ]; then
        if ! { mkdir -p "$CLAUDE_STATE_WS/skills" && cp -r /opt/session-skills/. "$CLAUDE_STATE_WS/skills/"; }; then
                echo "[entrypoint] WARN: couldn't seed default skills into ~/.claude/skills; " \
                     "sessions will start without the operator-curated skills." >&2
        fi
fi

# Persist SSH client state across container replacement.
#
# ~/.ssh holds the user's private keys, known_hosts, and config. Like
# every other path above it lives in the container layer, so without
# this redirection every recreate (POST /sessions/:id/start, reconcile
# after a host reboot) wipes the keys — forcing a full keypair rotation
# on every host the session pushes to. Same lifetime contract as the
# blocks above: state rides the workspace, soft delete keeps it, hard
# delete purges it.
#
# Target is workspace/.st/ssh, NOT workspace/.ssh: the payload is private
# key material and the workspace root IS the repo root for a cloned
# session, so a plain workspace/.ssh would be one `git add -A` away from
# committing keys. `.st/` is our repo-collision-safe state root (#377)
# and self-ignores via its `*` .gitignore, which matters more here than
# for any other persisted path.
#
# Rescue-then-symlink, like the ~/.claude block above and deliberately
# NOT the rm-first shape of the gh/vscode blocks: a real ~/.ssh in the
# container layer holds keys that are unrecoverable (unlike gh/vscode
# tokens, which a device-code flow re-mints), so the workspace copy is
# seeded from it BEFORE the real dir is dropped. A fresh image has no
# ~/.ssh at all — nothing runs ssh at build time — so this rescue only
# ever fires on the stop+start-after-failed-ln path, exactly like the
# ~/.claude block; that's why there's no rename-then-restore dance.
SSH_STATE_HOME=/home/developer/.ssh
SSH_STATE_WS="$ST_STATE_ROOT/ssh"

if [ -d "$SSH_STATE_HOME" ] && [ ! -L "$SSH_STATE_HOME" ]; then
        if [ ! -d "$SSH_STATE_WS" ]; then
                cp -a "$SSH_STATE_HOME" "$SSH_STATE_WS" || \
                        echo "[entrypoint] WARN: couldn't rescue container-layer ~/.ssh into workspace; " \
                             "existing SSH keys and known_hosts will be lost on the symlink swap." >&2
        fi
        rm -rf "$SSH_STATE_HOME" || true
fi

if ! mkdir -p "$SSH_STATE_WS"; then
        echo "[entrypoint] WARN: couldn't create workspace .st/ssh dir " \
             "(uid=$(id -u), workspace owner=$(stat -c '%u:%g' /home/developer/workspace 2>/dev/null || echo '?')). " \
             "SSH keys and known_hosts won't persist across restarts." >&2
elif ! ln -sfn "$SSH_STATE_WS" "$SSH_STATE_HOME"; then
        echo "[entrypoint] WARN: couldn't symlink ~/.ssh into workspace; " \
             "SSH keys and known_hosts won't persist across restarts." >&2
fi

# Pin permissions after seeding: 700 the dir, 600 its regular files. The
# OpenSSH client stats through the symlink and REFUSES a private key it
# considers group/world-readable ("UNPROTECTED PRIVATE KEY FILE"), so a
# `cp -a` from a umask-loosened source — or a hand-seeded workspace copy
# created under a permissive umask (the Home-Automation pre-seed case) —
# would silently break SSH later. Re-applying on every boot is harmless
# and defends the "existing workspace copy wins" path too. Best-effort:
# a chmod failure only risks the permission-too-open path, not the
# container.
if [ -d "$SSH_STATE_WS" ]; then
        chmod 700 "$SSH_STATE_WS" || true
        find "$SSH_STATE_WS" -type f -exec chmod 600 {} + 2>/dev/null || true
fi

# Runtime-readiness sentinel (#393), part 2 of 2: touched as the LAST
# provisioning step — after the ~/.npm-global swap and every symlink
# above — so its presence is the contract the API's `runtimeReady`
# field exposes: "docker exec can resolve binaries installed in the
# image". Anything added to this script later must go ABOVE this line.
touch /tmp/.st-ready

echo "[entrypoint] container ready — create a tab from the UI to begin"

# Keep PID 1 alive independent of tmux. tmux-server now starts lazily on the
# first `tmux new-session` from the backend, and dying on its own (last tab
# closed, crash) no longer bubbles up and kills the container.
exec tail -f /dev/null

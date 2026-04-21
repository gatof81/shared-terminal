#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# Session container entrypoint.
#
# Each tmux session inside the container is ONE browser tab. We boot with a
# single default tab (`tab-default`); additional tabs are created by the
# backend via `tmux new-session`, and closed via `tmux kill-session`. The
# container stays alive as long as any tmux session exists.
# ──────────────────────────────────────────────────────────────────────────────
set -e

# Navigate to workspace
cd /home/developer/workspace

# Create the detached default tab. Named deterministically so the backend
# can address it without an extra round-trip on first attach.
tmux new-session -d -s tab-default -x 120 -y 36
tmux set-option -t tab-default @tab-label "main"

echo "[entrypoint] tmux session 'tab-default' started — waiting for connections…"

# Keep the container alive. Tmux server exits when its last session closes,
# which bubbles out here and terminates the container — matching "always at
# least one tab per session" enforced by the backend kill-last guard.
exec tmux wait-for exit-signal

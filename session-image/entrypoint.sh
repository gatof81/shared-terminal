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
# can address it without an extra round-trip on first attach. No `@tab-label`
# is set — the UI falls back to the tabId, so it shows as "tab-default"
# rather than a misleading "main" label that read as a special tab.
tmux new-session -d -s tab-default -c /home/developer/workspace -x 120 -y 36

echo "[entrypoint] tmux session 'tab-default' started — waiting for connections…"

# Keep the container alive. Tmux server exits when its last session closes,
# which bubbles out here and terminates the container — matching "always at
# least one tab per session" enforced by the backend kill-last guard.
exec tmux wait-for exit-signal

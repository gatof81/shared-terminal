#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# Session container entrypoint.
#
# Starts a detached tmux session named "main" and then waits forever so the
# container stays alive.  The backend attaches via:
#   docker exec -it <container> tmux attach -t main
# ──────────────────────────────────────────────────────────────────────────────
set -e

# Navigate to workspace
cd /home/developer/workspace

# Create the detached tmux session
tmux new-session -d -s main -x 120 -y 36

echo "[entrypoint] tmux session 'main' started — waiting for connections…"

# Keep the container alive.  Use `wait` on tmux server so the container
# exits if tmux dies (e.g., last window closed).
exec tmux wait-for exit-signal

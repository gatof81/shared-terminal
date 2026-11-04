#!/bin/bash
# Build the session image WITHOUT letting a rebuild delete an image a session
# uses (incident 2026-11-03: on Docker's containerd image store, moving a tag
# removes the image it left at once, even under running containers).
#
#   scripts/build-session-image.sh [docker build args…]   e.g. --build-arg CLAUDE_CODE_VERSION=2.1.318
#
# 1. gate: `images:pins` in the running backend must answer GO (every image a
#    session container uses is pinned, or excepted by its exact pair);
# 2. build to a CANDIDATE tag — the live tag does not move yet;
# 3. gate again, immediately before the move (a container may have been
#    created during a long build — it is pinned at creation, this proves it);
# 4. move `shared-terminal-session` to the candidate.
# Nothing is ever removed (no rmi, no prune; the candidate tag stays).
# Not protectable from here: a `docker build -t shared-terminal-session`,
# `docker tag`, `rmi` or `prune` typed by hand, or another tool's build.
set -euo pipefail
cd "$(dirname "$0")/.."
LIVE=shared-terminal-session
CAND="$LIVE:candidate-$(date -u +%Y%m%dT%H%M%SZ)"
gate() {
	local out
	if ! out=$(docker compose exec -T app npm run -s images:pins 2>&1); then
		echo "$out" | sed 's/^/  gate: /' >&2
		echo "NO-GO ($1): images:pins did not answer GO — nothing was moved" >&2
		exit 1
	fi
	echo "  gate ($1): GO"
}
gate "before build"
docker build -t "$CAND" "$@" ./session-image
gate "before moving $LIVE"
docker tag "$CAND" "$LIVE"
echo "OK: $LIVE -> $(docker image inspect "$LIVE" --format '{{.Id}}') (candidate tag $CAND kept)"

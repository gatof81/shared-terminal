#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# sync-skills.sh — push the canonical default skills into every RUNNING session
# container, live, with no image rebuild and no container restart.
#
# The session image bakes the default skills (session-image/skills/) and the
# entrypoint materializes them into ~/.claude/skills on boot, so FRESH sessions
# always start with the current set. This is the update path for the sessions
# that are ALREADY running: it copies the same canonical skills into each live
# container's ~/.claude/skills. Claude Code reads skills per run, so an update
# is live on each session's NEXT message.
#
# Safe to run anytime — including with work in flight: it only writes files, it
# never touches a running process, so no active-run gate is needed (unlike an
# image recreate). Same semantics as the entrypoint: idempotent (refreshes the
# managed skills) and non-clobbering (a skill added under a different name — by a
# user or the bootstrap agentSeed — survives, because tar-extract merges).
#
# Usage:
#   ./session-image/sync-skills.sh [--pull] [--filter <name-prefix>] [--dry-run]
#
#   --pull            git pull this repo first so the canonical source is fresh
#   --filter PREFIX   only containers whose name starts with PREFIX (default st-)
#   --dry-run         list target containers and the skills, copy nothing
#
# Runs on the Docker host. Requires: docker, tar (git only with --pull).
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_SRC="$SCRIPT_DIR/skills"
FILTER="st-"
DO_PULL=0
DRY_RUN=0

while [ $# -gt 0 ]; do
	case "$1" in
	--pull) DO_PULL=1 ;;
	--filter)
		# guard the value's presence here: a bare trailing --filter would
		# otherwise leave the loop's end-of-body `shift` with nothing to shift,
		# which aborts under `set -e` before the friendly check below runs
		[ $# -ge 2 ] || {
			echo "ERROR: --filter needs a value" >&2
			exit 2
		}
		FILTER="$2"
		shift
		;;
	--dry-run) DRY_RUN=1 ;;
	-h | --help)
		grep '^#' "$0" | grep -v '^#!' | sed 's/^# \?//'
		exit 0
		;;
	*)
		echo "unknown arg: $1 (try --help)" >&2
		exit 2
		;;
	esac
	shift
done

[ -n "$FILTER" ] || {
	echo "ERROR: --filter needs a value" >&2
	exit 2
}
[ -d "$SKILLS_SRC" ] || {
	echo "ERROR: canonical skills dir not found at $SKILLS_SRC" >&2
	exit 1
}

if [ "$DO_PULL" -eq 1 ]; then
	echo "→ git pull (refreshing the canonical skills source)…"
	git -C "$SCRIPT_DIR/.." pull --ff-only
fi

# Running session containers. `st-` is the backend's session-container naming
# convention; exclude the smoke test's throwaway `*-smoke-*` containers. Names
# carry no spaces, so plain word-splitting over the list is safe (and keeps this
# portable to bash 3.2 — no mapfile).
#
# Run `docker ps` on its own line first so its failure (daemon down, no
# permission) is a hard error — folding it into the grep pipeline with `|| true`
# would swallow the failure and misreport a broken Docker as "nothing to do".
if ! ALL_NAMES="$(docker ps --format '{{.Names}}')"; then
	echo "ERROR: 'docker ps' failed — is the Docker daemon running and reachable?" >&2
	exit 1
fi
CONTAINERS="$(printf '%s\n' "$ALL_NAMES" | grep "^${FILTER}" | grep -v -- '-smoke-' || true)"

if [ -z "$CONTAINERS" ]; then
	echo "no running session containers matched '${FILTER}*' — nothing to do"
	exit 0
fi

# `|| true` so a skills dir with no subdirectories (ls -d */ then fails under
# pipefail) doesn't abort the whole run at this display-only line
SKILL_NAMES="$(cd "$SKILLS_SRC" && ls -d */ 2>/dev/null | tr -d / | tr '\n' ' ' || true)"
echo "skills:  ${SKILL_NAMES:-<none>}"
echo "targets: $(echo "$CONTAINERS" | tr '\n' ' ')"

if [ "$DRY_RUN" -eq 1 ]; then
	echo "(dry-run) nothing copied"
	exit 0
fi

fails=0
for c in $CONTAINERS; do
	# Stream the canonical skills as a tar into the container and extract as
	# `developer` into ~/.claude/skills. tar-extract MERGES: the managed skills
	# are refreshed, any other skill survives. `-u developer` so the copies land
	# owned by the session user (theirs to override), not root.
	if tar -C "$SKILLS_SRC" -cf - . |
		docker exec -i -u developer "$c" bash -c 'mkdir -p ~/.claude/skills && tar -C ~/.claude/skills -xf -'; then
		echo "  ✓ $c"
	else
		echo "  ✗ $c (copy failed)" >&2
		fails=$((fails + 1))
	fi
done

if [ "$fails" -ne 0 ]; then
	echo "sync finished with $fails failure(s)" >&2
	exit 1
fi
echo "sync OK — live on each session's next run (no restart needed)"

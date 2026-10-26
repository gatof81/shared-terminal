#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# seed-skills.sh — copy the image's default skills (/opt/session-skills) into
# the persisted ~/.claude/skills (workspace/.st/claude-state/skills).
#
# The entrypoint runs it on every boot; the backend runs it by exec after a
# recreation commits (CONVERSATION.md §2.7.3). Same semantics as before it was
# extracted from the entrypoint: it refreshes the managed skills from the
# image and never touches any other skill (cp merges, it never wipes the
# tree). `cp -r`, not `cp -a`: the source is root-owned and the session runs
# as `developer`, so the copy lands developer-owned.
#
# Fail-closed on the deferral marker (§2.7.3). During a recreation, until the
# backend commits and removes /etc/st-control/defer-skill-seed, nothing may
# write the new image's skills into the shared workspace. So the script seeds
# only when it can POSITIVELY establish that the marker is absent:
#   exit 3 — the marker exists: deferred;
#   exit 4 — the control dir or the marker can't be examined (EACCES on a
#            0700/000 dir, EIO, a missing control dir…): treated as deferred,
#            because `[ -e ]` would read "can't look" as "absent";
#   exit 0 — the marker is known absent (ENOENT) and the copy ran.
# Never fatal for the session: the entrypoint logs and boots on.
# ──────────────────────────────────────────────────────────────────────────────
set -u

CONTROL_DIR=/etc/st-control
DEFER_MARKER="$CONTROL_DIR/defer-skill-seed"
SKILLS_SRC=/opt/session-skills
SKILLS_DST=/home/developer/workspace/.st/claude-state/skills

# The image always ships $CONTROL_DIR; it must be a directory we can search.
if [ ! -d "$CONTROL_DIR" ] || [ ! -x "$CONTROL_DIR" ]; then
	echo "[seed-skills] not seeding: $CONTROL_DIR cannot be examined (fail-closed)" >&2
	exit 4
fi
# stat tells "no such file" apart from every other failure; only the
# former means absent. C locale so the message is stable.
if out=$(LC_ALL=C stat -c %F -- "$DEFER_MARKER" 2>&1); then
	echo "[seed-skills] deferred: $DEFER_MARKER present" >&2
	exit 3
fi
case "$out" in
*"No such file or directory"*) ;;
*)
	echo "[seed-skills] not seeding: cannot examine $DEFER_MARKER (fail-closed)" >&2
	exit 4
	;;
esac
[ -d "$SKILLS_SRC" ] || exit 0
mkdir -p "$SKILLS_DST" && cp -r "$SKILLS_SRC/." "$SKILLS_DST/"

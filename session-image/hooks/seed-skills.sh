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
# Refuses (exit 3) while /etc/st-control/defer-skill-seed exists: during a
# recreation, until the backend commits and removes that marker, nothing may
# write the new image's skills into the shared workspace — not the boot, not a
# reboot of the new container, not an exec (§2.7.3).
# ──────────────────────────────────────────────────────────────────────────────
set -u

DEFER_MARKER=/etc/st-control/defer-skill-seed
SKILLS_SRC=/opt/session-skills
SKILLS_DST=/home/developer/workspace/.st/claude-state/skills

if [ -e "$DEFER_MARKER" ]; then
	echo "[seed-skills] deferred: $DEFER_MARKER present" >&2
	exit 3
fi
[ -d "$SKILLS_SRC" ] || exit 0
mkdir -p "$SKILLS_DST" && cp -r "$SKILLS_SRC/." "$SKILLS_DST/"

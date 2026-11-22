#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# seed-skills.sh — copy the image's default skills (/opt/session-skills) into
# the persisted ~/.claude/skills (workspace/.st/claude-state/skills).
#
# The entrypoint runs it on every boot. It refreshes the managed skills from
# the image and never touches any other skill (cp merges, it never wipes the
# tree). `cp -r`, not `cp -a`: the source is root-owned and the session runs
# as `developer`, so the copy lands developer-owned.
# Never fatal for the session: on failure the entrypoint logs and boots on.
# ──────────────────────────────────────────────────────────────────────────────
set -u

SKILLS_SRC=/opt/session-skills
SKILLS_DST=/home/developer/workspace/.st/claude-state/skills

[ -d "$SKILLS_SRC" ] || exit 0
mkdir -p "$SKILLS_DST" && cp -r "$SKILLS_SRC/." "$SKILLS_DST/"

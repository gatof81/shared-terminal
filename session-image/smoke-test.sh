#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# Session-image smoke test (#352).
#
# Boots a real container from the built image and asserts the contracts the
# unit suites can only pin as *shapes*:
#
#   1. entrypoint reaches "container ready" with zero WARN lines;
#   2. all six persistence symlinks resolve into the workspace;
#   3. `claude --version` matches the Dockerfile's CLAUDE_CODE_VERSION pin;
#   4. the ~/.claude.json FILE symlink survives a real CLI config write —
#      the empirical invariant the entrypoint's Claude block depends on,
#      re-asserted here on every version bump exactly as that block's
#      comment promises;
#   5. state seeded into ~/.claude survives a container recreate on the
#      same workspace;
#   6. a process group launched via the backend's newProcessGroup wrapper
#      dies cleanly under KILL_PROCESS_GROUP_SCRIPT — children included,
#      tmux untouched, idempotent no-op on re-kill;
#   7. a repo-shipped project-level .claude/ at the workspace root is
#      left untouched and does not collide with the CLI state under
#      .st/claude-state (#377) — including across a recreate;
#   8. a workspace carrying the interim #371 state layout
#      (workspace/.claude{,.json}) migrates to .st/ on boot.
#
# Phase 6 extracts the wrapper/kill scripts from backend/src/dockerManager.ts
# via a tsx probe instead of keeping copies here: a copy would drift the day
# the backend edits a script, and this test would keep passing against the
# stale version. Requires `npm ci` to have run in backend/ first.
#
# Runs in CI (.github/workflows/session-image.yml) and standalone on any
# docker host:  ./session-image/smoke-test.sh [image-tag]
# Dependencies: docker, node+npm (backend deps installed), jq, mktemp.
# ──────────────────────────────────────────────────────────────────────────────
set -uo pipefail

IMAGE="${1:-shared-terminal-session}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUFFIX="$$"
C1="st-smoke-a-$SUFFIX"
C2="st-smoke-b-$SUFFIX"
C3="st-smoke-c-$SUFFIX"
C4="st-smoke-d-$SUFFIX"
C5="st-smoke-e-$SUFFIX"
C6="st-smoke-f-$SUFFIX"
WS="$(mktemp -d)"
WS2="$(mktemp -d)"
WS3="$(mktemp -d)"
WS4="$(mktemp -d)"
FAILS=0

cleanup() {
	docker rm -f "$C1" "$C2" "$C3" "$C4" "$C5" "$C6" >/dev/null 2>&1
	# The workspace contents are uid-1000-owned (written from inside the
	# containers), so the host user usually can't delete them directly —
	# empty each dir from a throwaway container first, then drop the shell.
	for ws in "$WS" "$WS2" "$WS3" "$WS4"; do
		docker run --rm -v "$ws":/ws --entrypoint bash "$IMAGE" \
			-c 'rm -rf /ws/* /ws/.[!.]* 2>/dev/null; true' >/dev/null 2>&1
		rm -rf "$ws" 2>/dev/null
	done
}
trap cleanup EXIT

phase() { echo; echo "── $1 ──"; }
ok() { echo "  ok: $1"; }
fail() {
	echo "  FAIL: $1" >&2
	FAILS=$((FAILS + 1))
}

wait_ready() {
	local name="$1" i=0
	until docker logs "$name" 2>&1 | grep -q "container ready"; do
		i=$((i + 1))
		if [ "$i" -gt 60 ]; then
			fail "$name never reached 'container ready'; logs:"
			docker logs "$name" 2>&1 | tail -20 >&2
			return 1
		fi
		sleep 0.5
	done
}

# The backend chowns each workspace to WORKSPACE_UID (1000); the test host's
# runner user usually isn't 1000, so open the dirs up instead.
chmod 777 "$WS" "$WS2" "$WS3" "$WS4"

# ── Phase 1: fresh boot, entrypoint clean ────────────────────────────────────
phase "Phase 1: fresh boot"
docker run -d --name "$C1" -v "$WS":/home/developer/workspace "$IMAGE" >/dev/null || {
	fail "docker run failed"
	exit 1
}
wait_ready "$C1" || exit 1
ok "container ready"
WARNS=$(docker logs "$C1" 2>&1 | grep -c "\[entrypoint\] WARN" || true)
if [ "$WARNS" -eq 0 ]; then ok "zero entrypoint WARNs"; else
	fail "$WARNS entrypoint WARN line(s):"
	docker logs "$C1" 2>&1 | grep "\[entrypoint\] WARN" >&2
fi

# ── Phase 2: persistence symlinks ────────────────────────────────────────────
phase "Phase 2: persistence symlinks"
# link:target pairs, not an associative array — `declare -A` is bash 4+
# and this script promises "any docker host" (macOS ships bash 3.2).
# None of the paths contain a colon.
for pair in \
	"/home/developer/.claude:/home/developer/workspace/.st/claude-state" \
	"/home/developer/.claude.json:/home/developer/workspace/.st/claude.json" \
	"/home/developer/.npm-global:/home/developer/workspace/.npm-global" \
	"/home/developer/.vscode-cli:/home/developer/workspace/.vscode-cli" \
	"/home/developer/.config/gh:/home/developer/workspace/.config/gh" \
	"/home/developer/.ssh:/home/developer/workspace/.st/ssh"; do
	link="${pair%%:*}" want="${pair#*:}"
	target=$(docker exec "$C1" readlink "$link" 2>/dev/null)
	if [ "$target" = "$want" ]; then ok "$link -> $target"; else
		fail "$link resolves to '$target' (want '$want')"
	fi
done
GI=$(docker exec "$C1" cat /home/developer/workspace/.st/.gitignore 2>/dev/null)
if [ "$GI" = "*" ]; then ok ".st/.gitignore self-ignores the state root"; else
	fail ".st/.gitignore content is '$GI' (want '*') — Claude state is committable from a repo-checkout workspace"
fi

# ── Phase 3: Claude CLI version matches the Dockerfile pin ──────────────────
phase "Phase 3: version pin"
PIN=$(grep -oP '^ARG CLAUDE_CODE_VERSION=\K\S+' "$REPO_ROOT/session-image/Dockerfile")
GOT=$(docker exec "$C1" bash -c 'command claude --version' 2>&1)
if [ -n "$PIN" ] && [[ "$GOT" == "$PIN"* ]]; then ok "claude --version = $GOT (pin $PIN)"; else
	fail "claude --version = '$GOT', Dockerfile pin = '$PIN'"
fi

# ── Phase 4: file symlink survives a real CLI config write ──────────────────
phase "Phase 4: ~/.claude.json symlink survives a config write"
# Unauthenticated on purpose: the CLI prints "Not logged in" but still
# rewrites its config, which is the write path under test.
timeout 120 docker exec "$C1" bash -c 'command claude -p hi >/dev/null 2>&1; exit 0'
if docker exec "$C1" bash -c '[ -L /home/developer/.claude.json ]'; then
	ok "still a symlink after the CLI's atomic-rename rewrite"
else
	fail "the CLI replaced the ~/.claude.json symlink with a real file — the entrypoint's persistence invariant broke on this CLI version"
fi
if [ -s "$WS/.st/claude.json" ]; then ok "config landed in the workspace"; else
	fail "workspace .st/claude.json missing/empty after CLI write"
fi

# ── Phase 5: state survives container recreate ───────────────────────────────
phase "Phase 5: recreate on the same workspace"
docker exec "$C1" bash -c 'mkdir -p ~/.claude && printf smoke-seed > ~/.claude/settings.json && printf smoke-cred > ~/.claude/.credentials.json'
docker rm -f "$C1" >/dev/null
docker run -d --name "$C2" -v "$WS":/home/developer/workspace "$IMAGE" >/dev/null
wait_ready "$C2" || exit 1
WARNS=$(docker logs "$C2" 2>&1 | grep -c "\[entrypoint\] WARN" || true)
[ "$WARNS" -eq 0 ] && ok "idempotent re-boot, zero WARNs" || fail "re-boot produced $WARNS WARN(s)"
for f in "settings.json:smoke-seed" ".credentials.json:smoke-cred"; do
	name="${f%%:*}" want="${f##*:}"
	got=$(docker exec "$C2" cat "/home/developer/.claude/$name" 2>/dev/null)
	[ "$got" = "$want" ] && ok "~/.claude/$name survived the recreate" || fail "~/.claude/$name = '$got' (want '$want')"
done

# ── Phase 6: process-group cancellation (backend's real scripts) ─────────────
phase "Phase 6: killExecProcessGroup"
PROBE="$WS/.smoke-probe.mts"
cat > "$PROBE" <<'EOF'
import { pathToFileURL } from "node:url";
const m = await import(pathToFileURL(`${process.cwd()}/src/dockerManager.ts`).href);
console.log(JSON.stringify({ wrapper: m.PGID_WRAPPER_SCRIPT, kill: m.KILL_PROCESS_GROUP_SCRIPT }));
EOF
SCRIPTS=$(cd "$REPO_ROOT/backend" && npx tsx "$PROBE")
WRAPPER=$(jq -r .wrapper <<<"$SCRIPTS")
KILL=$(jq -r .kill <<<"$SCRIPTS")
if [ -z "$WRAPPER" ] || [ -z "$KILL" ]; then
	fail "couldn't extract exec scripts from backend/src/dockerManager.ts"
else
	docker exec "$C2" tmux new-session -d -s smoketab
	OUT="$WS/.smoke-exec-out"
	docker exec "$C2" setsid bash -c "$WRAPPER" st-exec \
		bash -c 'sleep 300 & sleep 300 & wait' > "$OUT" 2>/dev/null &
	PGID=""
	for _ in $(seq 1 20); do
		PGID=$(awk '/^__ST_EXEC_PGID__/ {print $2; exit}' "$OUT" 2>/dev/null)
		[ -n "$PGID" ] && break
		sleep 0.5
	done
	if [ -z "$PGID" ]; then
		fail "wrapper never reported a pgid"
	else
		ok "pgid reported: $PGID"
		# No procps in the image — count live group members via /proc.
		# Same parse as the backend's alive() probe: strip through the
		# last ") " (comm can contain spaces), then state is field 1 and
		# pgrp is field 3; zombies (Z) are dead-but-unreaped and hold
		# nothing, so they don't count as survivors.
		live_members() {
			docker exec "$C2" bash -c 'for f in /proc/[0-9]*/stat; do rest="$(cat "$f" 2>/dev/null)" || continue; rest="${rest##*) }"; set -- $rest; [ "${3:-}" = "'"$PGID"'" ] && [ "${1:-}" != "Z" ] && echo "member state=$1 pgrp=$3"; done' 2>/dev/null
		}
		BEFORE=$(live_members | wc -l)
		[ "$BEFORE" -ge 3 ] && ok "$BEFORE live group members before kill (leader + children)" \
			|| fail "expected >=3 live group members before kill, saw $BEFORE"
		# Strictly "terminated": sleep dies on TERM within one poll tick,
		# so "killed" here means the early-exit probe regressed (e.g. back
		# to kill -0, which zombies satisfy — the #374 first-run failure).
		OUTCOME=$(docker exec "$C2" bash -c "$KILL" st-kill-pg "$PGID" 25)
		[ "$OUTCOME" = "terminated" ] && ok "kill outcome: terminated" \
			|| fail "kill outcome '$OUTCOME' (want terminated — TERM-compliant group must not burn the grace)"
		AFTER=$(live_members)
		[ -z "$AFTER" ] && ok "no live group members remain" || fail "group survivors after kill: $AFTER"
		docker exec "$C2" tmux has-session -t smoketab 2>/dev/null \
			&& ok "tmux session untouched" || fail "tmux session died with the group"
		REKILL=$(docker exec "$C2" bash -c "$KILL" st-kill-pg "$PGID" 5)
		[ "$REKILL" = "already-exited" ] && ok "re-kill is a tolerant no-op" \
			|| fail "re-kill outcome '$REKILL' (want already-exited)"
	fi
fi

# ── Phase 7: repo-level .claude/ does not collide with CLI state (#377) ──────
phase "Phase 7: project-level .claude/ in the workspace root"
# Seed a project-shaped .claude (settings, no CLI-state markers) from a
# throwaway container so ownership matches the session uid — this is what
# a cloned repo that ships Claude Code project config looks like.
docker run --rm -v "$WS2":/ws --entrypoint bash "$IMAGE" \
	-c 'mkdir -p /ws/.claude && printf project-settings > /ws/.claude/settings.json' >/dev/null 2>&1
docker run -d --name "$C3" -v "$WS2":/home/developer/workspace "$IMAGE" >/dev/null
wait_ready "$C3" || exit 1
WARNS=$(docker logs "$C3" 2>&1 | grep -c "\[entrypoint\] WARN" || true)
[ "$WARNS" -eq 0 ] && ok "boot with project .claude/ present, zero WARNs" \
	|| fail "boot with project .claude/ produced $WARNS WARN(s)"
if docker exec "$C3" bash -c '[ -d /home/developer/workspace/.claude ] && [ ! -L /home/developer/workspace/.claude ]'; then
	ok "project .claude/ still a real directory"
else
	fail "project .claude/ was adopted/replaced by the entrypoint"
fi
got=$(docker exec "$C3" cat /home/developer/workspace/.claude/settings.json 2>/dev/null)
[ "$got" = "project-settings" ] && ok "project settings.json intact" \
	|| fail "project settings.json = '$got' (want 'project-settings')"
target=$(docker exec "$C3" readlink /home/developer/.claude 2>/dev/null)
[ "$target" = "/home/developer/workspace/.st/claude-state" ] && ok "CLI state symlink avoids the project dir" \
	|| fail "~/.claude -> '$target' (want workspace/.st/claude-state)"
# State written through the symlink must survive a recreate WITHOUT
# touching the project dir — the exact interleave that lost state in #377.
docker exec "$C3" bash -c 'printf smoke-cred-p7 > ~/.claude/.credentials.json'
docker rm -f "$C3" >/dev/null
docker run -d --name "$C4" -v "$WS2":/home/developer/workspace "$IMAGE" >/dev/null
wait_ready "$C4" || exit 1
WARNS=$(docker logs "$C4" 2>&1 | grep -c "\[entrypoint\] WARN" || true)
[ "$WARNS" -eq 0 ] && ok "recreate with project .claude/ present, zero WARNs" \
	|| fail "recreate with project .claude/ produced $WARNS WARN(s)"
got=$(docker exec "$C4" cat /home/developer/.claude/.credentials.json 2>/dev/null)
[ "$got" = "smoke-cred-p7" ] && ok "CLI state survived recreate alongside project dir" \
	|| fail "~/.claude/.credentials.json = '$got' (want 'smoke-cred-p7')"
got=$(docker exec "$C4" cat /home/developer/workspace/.claude/settings.json 2>/dev/null)
[ "$got" = "project-settings" ] && ok "project settings.json intact after recreate" \
	|| fail "project settings.json after recreate = '$got'"

# ── Phase 8: interim #371 layout migrates to .st/ ────────────────────────────
phase "Phase 8: legacy workspace/.claude{,.json} migration"
# The merged shape from the wild: CLI-state markers AND a settings file
# in the same dir (a #371-era workspace whose repo also ships .claude/).
docker run --rm -v "$WS3":/ws --entrypoint bash "$IMAGE" \
	-c 'mkdir -p /ws/.claude && printf legacy-cred > /ws/.claude/.credentials.json && printf legacy-settings > /ws/.claude/settings.json && printf legacy-json > /ws/.claude.json' >/dev/null 2>&1
docker run -d --name "$C5" -v "$WS3":/home/developer/workspace "$IMAGE" >/dev/null
wait_ready "$C5" || exit 1
WARNS=$(docker logs "$C5" 2>&1 | grep -c "\[entrypoint\] WARN" || true)
[ "$WARNS" -eq 0 ] && ok "migration boot, zero WARNs" || fail "migration boot produced $WARNS WARN(s)"
for f in "claude-state/.credentials.json:legacy-cred" "claude-state/settings.json:legacy-settings" "claude.json:legacy-json"; do
	name="${f%%:*}" want="${f##*:}"
	got=$(docker exec "$C5" cat "/home/developer/workspace/.st/$name" 2>/dev/null)
	[ "$got" = "$want" ] && ok ".st/$name migrated" || fail ".st/$name = '$got' (want '$want')"
done
if docker exec "$C5" bash -c '[ ! -e /home/developer/workspace/.claude ] && [ ! -e /home/developer/workspace/.claude.json ]'; then
	ok "legacy paths removed (moved, not copied)"
else
	fail "legacy workspace/.claude{,.json} still present after migration"
fi

# ── Phase 9: orphaned zombies are reaped under Init (exec-API follow-up) ─────
phase "Phase 9: zombie reaping with --init"
# The recipe: a setsid'd bash backgrounds two short sleeps, then execs a
# longer sleep. The short sleeps die with no one wait()ing (exec replaced
# their parent's image), and when the long sleep exits the whole set
# reparents to PID 1.
#
# Leg A runs it against the RAW image, where PID 1 is the entrypoint's
# `tail -f /dev/null` — which never reaps — and asserts zombies DO leak.
# This leg exists to keep leg B honest: if a future entrypoint/image
# change makes the recipe stop producing zombies, leg A fails loudly
# instead of leg B passing vacuously.
docker run -d --name "$C6" -v "$WS4":/home/developer/workspace "$IMAGE" >/dev/null
wait_ready "$C6" || exit 1
docker exec "$C6" bash -c 'setsid -w bash -c "sleep 0.2 & sleep 0.2 & exec sleep 1" >/dev/null 2>&1 &'
sleep 3
Z=$(docker exec "$C6" bash -c 'ps -eo stat= | grep -c "^Z"' || true)
if [ "${Z:-0}" -ge 1 ]; then
	ok "raw image leaks $Z zombie(s) — repro recipe is valid"
else
	fail "repro recipe produced no zombies on the raw image; leg B would be vacuous"
fi
docker rm -f "$C6" >/dev/null 2>&1

# Leg B: identical recipe under --init — the CLI equivalent of the
# HostConfig.Init the backend sets in DockerManager.spawn(). docker-init
# is PID 1 and must reap the orphans, or every exec-API group kill
# leaks a PidsLimit slot for the container's lifetime.
docker run -d --init --name "$C6" -v "$WS4":/home/developer/workspace "$IMAGE" >/dev/null
wait_ready "$C6" || exit 1
docker exec "$C6" bash -c 'setsid -w bash -c "sleep 0.2 & sleep 0.2 & exec sleep 1" >/dev/null 2>&1 &'
sleep 3
Z=$(docker exec "$C6" bash -c 'ps -eo stat= | grep -c "^Z"' || true)
if [ "${Z:-0}" -eq 0 ]; then
	ok "--init reaps orphaned zombies (Z=0)"
else
	fail "--init left ${Z} zombie(s) unreaped"
fi
PID1=$(docker exec "$C6" ps -o comm= -p 1)
[ "$PID1" = "docker-init" ] && ok "PID 1 is docker-init" || fail "PID 1 is '$PID1' (want docker-init)"

echo
if [ "$FAILS" -eq 0 ]; then
	echo "SMOKE TEST PASSED"
else
	echo "SMOKE TEST FAILED: $FAILS assertion(s)" >&2
	exit 1
fi

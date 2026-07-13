#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# Session-image smoke test (#352).
#
# Boots a real container from the built image and asserts the contracts the
# unit suites can only pin as *shapes*:
#
#   1. entrypoint reaches "container ready" with zero WARN lines;
#   2. all five persistence symlinks resolve into the workspace;
#   3. `claude --version` matches the Dockerfile's CLAUDE_CODE_VERSION pin;
#   4. the ~/.claude.json FILE symlink survives a real CLI config write —
#      the empirical invariant the entrypoint's Claude block depends on,
#      re-asserted here on every version bump exactly as that block's
#      comment promises;
#   5. state seeded into ~/.claude survives a container recreate on the
#      same workspace;
#   6. a process group launched via the backend's newProcessGroup wrapper
#      dies cleanly under KILL_PROCESS_GROUP_SCRIPT — children included,
#      tmux untouched, idempotent no-op on re-kill.
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
WS="$(mktemp -d)"
FAILS=0

cleanup() {
	docker rm -f "$C1" "$C2" >/dev/null 2>&1
	rm -rf "$WS"
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
# runner user usually isn't 1000, so open the dir up instead.
chmod 777 "$WS"

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
declare -A LINKS=(
	["/home/developer/.claude"]="/home/developer/workspace/.claude"
	["/home/developer/.claude.json"]="/home/developer/workspace/.claude.json"
	["/home/developer/.npm-global"]="/home/developer/workspace/.npm-global"
	["/home/developer/.vscode-cli"]="/home/developer/workspace/.vscode-cli"
	["/home/developer/.config/gh"]="/home/developer/workspace/.config/gh"
)
for link in "${!LINKS[@]}"; do
	target=$(docker exec "$C1" readlink "$link" 2>/dev/null)
	if [ "$target" = "${LINKS[$link]}" ]; then ok "$link -> $target"; else
		fail "$link resolves to '$target' (want '${LINKS[$link]}')"
	fi
done

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
if [ -s "$WS/.claude.json" ]; then ok "config landed in the workspace"; else
	fail "workspace .claude.json missing/empty after CLI write"
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
		# No procps in the image — count live group members via /proc
		# (stat field 5 = pgrp, field 3 = state; zombies are dead-but-
		# unreaped and hold nothing, so they don't count as survivors).
		live_members() {
			docker exec "$C2" bash -c 'for f in /proc/[0-9]*/stat; do set -- $(cat "$f" 2>/dev/null); [ "${5:-}" = "'"$PGID"'" ] && [ "${3:-}" != "Z" ] && echo "$1 $2 $3"; done' 2>/dev/null
		}
		BEFORE=$(live_members | wc -l)
		[ "$BEFORE" -ge 3 ] && ok "$BEFORE live group members before kill (leader + children)" \
			|| fail "expected >=3 live group members before kill, saw $BEFORE"
		OUTCOME=$(docker exec "$C2" bash -c "$KILL" st-kill-pg "$PGID" 25)
		case "$OUTCOME" in
			terminated | killed) ok "kill outcome: $OUTCOME" ;;
			*) fail "unexpected kill outcome '$OUTCOME'" ;;
		esac
		AFTER=$(live_members)
		[ -z "$AFTER" ] && ok "no live group members remain" || fail "group survivors after kill: $AFTER"
		docker exec "$C2" tmux has-session -t smoketab 2>/dev/null \
			&& ok "tmux session untouched" || fail "tmux session died with the group"
		REKILL=$(docker exec "$C2" bash -c "$KILL" st-kill-pg "$PGID" 5)
		[ "$REKILL" = "already-exited" ] && ok "re-kill is a tolerant no-op" \
			|| fail "re-kill outcome '$REKILL' (want already-exited)"
	fi
fi

echo
if [ "$FAILS" -eq 0 ]; then
	echo "SMOKE TEST PASSED"
else
	echo "SMOKE TEST FAILED: $FAILS assertion(s)" >&2
	exit 1
fi

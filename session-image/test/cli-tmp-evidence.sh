#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Evidence for the recreation layer allowlist (CONVERSATION.md §2.7.1): what
# the image's real CLI leaves in a session container's writable layer under
# /tmp, after real uses, read from the STOPPED container exactly as the
# recreation preflight reads it (`docker diff` + the archive stat), plus a
# `tar -tv` of /tmp (type, mode, owner, size, link target).
#
# Uses (each on a fresh, disposable container with a session's own flags,
# the scripted model of mock-anthropic.mjs, no API key, no egress):
#   A  one `claude -p`;
#   B  two `claude -p` and a `claude -p --resume`;
#   C  an interactive tab: a plain turn, a Bash tool turn, a subagent turn,
#      then the CLI exits normally;
#   D  an interactive tab still running when the container is stopped.
#
# Prints names, types and sizes, and the first bytes of small regular files
# (scripted-model data only; no secret exists in these containers).
# Usage: session-image/test/cli-tmp-evidence.sh <image>
# ──────────────────────────────────────────────────────────────────────────────
set -u
IMAGE="${1:-shared-terminal-session}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TAG="evid-$$"
NET="st-$TAG"
API="st-$TAG-api"
KEY="sk-ant-api03-evidence-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
WSROOT="$(mktemp -d)"
cleanup() {
	docker ps -aq --filter "label=st-evidence=$TAG" | xargs -r docker rm -f >/dev/null 2>&1
	docker network rm "$NET" >/dev/null 2>&1
	docker run --rm -v "$WSROOT":/w --entrypoint bash "$IMAGE" -c 'rm -rf /w/* /w/.[!.]*' >/dev/null 2>&1
	rm -rf "$WSROOT"
}
trap cleanup EXIT

docker network create "$NET" >/dev/null
docker run -d --label "st-evidence=$TAG" --name "$API" --network "$NET" --network-alias mock-api \
	-v "$REPO_ROOT/session-image/test":/t:ro --entrypoint node "$IMAGE" /t/mock-anthropic.mjs 8080 >/dev/null

session() { # session <name>: a fresh container, as DockerManager.spawn() runs one
	local name="st-$TAG-$1"
	mkdir -p "$WSROOT/$1" && chmod 777 "$WSROOT/$1"
	docker run -d --label "st-evidence=$TAG" --name "$name" --init --cap-drop ALL \
		--security-opt no-new-privileges --network "$NET" \
		-e SESSION_ID="00000000-0000-4000-8000-00000000000${#1}" -e SESSION_NAME=evidence \
		-e ANTHROPIC_BASE_URL=http://mock-api:8080 -e ANTHROPIC_API_KEY="$KEY" \
		-e CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 -e DISABLE_AUTOUPDATER=1 \
		-v "$WSROOT/$1":/home/developer/workspace "$IMAGE" >/dev/null
	for _ in $(seq 120); do docker exec "$name" test -f /tmp/.st-ready 2>/dev/null && break; sleep 0.5; done
	echo "$name"
}
p() { docker exec -w /home/developer/workspace "$1" timeout 120 claude -p "${@:2}" --output-format json </dev/null 2>/dev/null; }
seed() {
	docker exec -i -e K="${KEY: -20}" "$1" bash -c '
		f=~/.claude.json; [ -s "$f" ] || echo "{}" > "$f"
		jq --arg k "$K" ". + {hasCompletedOnboarding: true, theme: \"dark\",
			customApiKeyResponses: {approved: [\$k], rejected: []},
			projects: {\"/home/developer/workspace\": {hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true}}}" "$f" > /tmp/.seed && cat /tmp/.seed > "$f" && rm -f /tmp/.seed
		mkdir -p ~/.claude && printf "{\"skipDangerousModePermissionPrompt\": true, \"hooks\": {\"Stop\": [{\"hooks\": [{\"type\": \"command\", \"command\": \"echo stop >> /home/developer/workspace/.turns\"}]}]}}" > ~/.claude/settings.json'
}
tab() { # tab <container>: interactive claude in tmux, ready for input
	docker exec "$1" tmux new-session -d -s t -x 200 -y 50 -c /home/developer/workspace "claude --dangerously-skip-permissions"
	for _ in $(seq 60); do docker exec "$1" tmux capture-pane -p -t t | grep -qE "for shortcuts|bypass permissions on" && return 0; sleep 0.5; done
	echo "  (tab never reached its prompt)"
}
turn() { # turn <container> <text>: one turn, until the Stop hook
	local before
	before=$(docker exec "$1" bash -c 'wc -l < ~/workspace/.turns 2>/dev/null || echo 0')
	docker exec "$1" tmux send-keys -t t "$2" Enter
	for _ in $(seq 300); do
		[ "$(docker exec "$1" bash -c 'wc -l < ~/workspace/.turns 2>/dev/null || echo 0')" -gt "$before" ] && return 0
		sleep 0.1
	done
	echo "  (turn \"$2\" never finished)"
}
report() { # report <container> <label>: stop it, then what the preflight would read
	docker stop -t 5 "$1" >/dev/null
	echo
	echo "════ $2 ════"
	echo "── docker diff (stopped), entries under /tmp ──"
	docker diff "$1" | grep -E '^[ACD] /tmp(/|$)'
	echo "── docker diff (stopped), entries under HOME outside the workspace ──"
	docker diff "$1" | grep -E '^[ACD] /home/developer/' | grep -v -E ' /home/developer/workspace(/|$)'
	echo "── tar -tv of those HOME entries (type, size, target; no content) ──"
	local h
	while IFS= read -r h; do
		docker cp "$1":"$h" - 2>/dev/null | tar -tvf - 2>/dev/null | head -n 20
	done < <(docker diff "$1" | awk '$1 == "A" && $2 ~ "^/home/developer/" && $2 !~ "^/home/developer/workspace" { print $2 }')
	echo "── the CLI's deep-link handler file, if any: sha256 and full text (fixed CLI text, no secrets) ──"
	docker cp "$1":/home/developer/.local/share/applications/claude-code-url-handler.desktop - 2>/dev/null |
		tar -xOf - 2>/dev/null | tee >(sha256sum | sed 's/^/  sha256 /' >&2) | sed 's/^/    /'
	echo "── tar -tv of /tmp (type mode owner size … name [-> target]) ──"
	docker cp "$1":/tmp - 2>/dev/null | tar -tvf - | grep -v -E ' tmp/(\.st-ready|st-relay\.log|tmux-1000.*)?$'
	echo "── first bytes of regular files ≤ 4 KiB outside tmux/sentinel ──"
	local f
	while IFS= read -r f; do
		echo "  [$f]"
		docker cp "$1":"/$f" - 2>/dev/null | tar -xOf - 2>/dev/null | head -c 160 | od -An -c | head -n 3 | sed 's/^/    /'
	done < <(docker cp "$1":/tmp - 2>/dev/null | tar -tvf - | awk '$1 ~ /^-/ && $3 <= 4096 { print $NF }' |
		grep -E '^tmp/(cc-socks|claude-1000)/')
}

S=$(session a)
p "$S" "evidence A" >/dev/null
report "$S" "A: one claude -p"

S=$(session bb)
ID=$(p "$S" "evidence B1" | jq -r '.session_id // empty')
p "$S" "evidence B2" >/dev/null
p "$S" --resume "$ID" "evidence B3" >/dev/null
report "$S" "B: two claude -p and a --resume"

S=$(session ccc)
seed "$S"
tab "$S"
turn "$S" "evidence C1"
turn "$S" "ST_SCENARIO=bash"
turn "$S" "ST_SCENARIO=agent"
docker exec "$S" tmux send-keys -t t "/exit" Enter
sleep 3
report "$S" "C: interactive tab (plain, Bash tool, subagent), CLI exited"

S=$(session dddd)
seed "$S"
tab "$S"
turn "$S" "evidence D1"
turn "$S" "ST_SCENARIO=bash"
report "$S" "D: interactive tab still running at stop"
echo
echo "evidence: done"

#!/usr/bin/env bash
# The real runner (acp-runtime/runner.mjs) + the real claude-agent-acp OUTSIDE any
# container, against a lab backend (lab-st.sh): for a session without a Docker
# socket. The runner gets exactly the environment ensureRunner gives it in a
# container, with local paths; the adapter uses this user's ~/.claude login.
#
#   ./runner-local.sh token <agent-name>      # on the lab host: prints the acp1 token
#   ST_URL=http://127.0.0.1:3101 ST_TOKEN=acp1.… ST_AGENT=<name> SLOTS=2 ./runner-local.sh up
#   ./runner-local.sh status | logs | down
#
# Before `up`: the agent's lab session must be STOPPED (POST /api/sessions/:id/stop),
# so the lab backend runs no runner of its own for it (its watchdog looks only at
# running containers) — two runners on one agent would share its slots. Slots run
# here are 1..SLOTS; set the agent's cap to match (PATCH /api/acp/agents/:name
# {maxConcurrency}). The model comes with every claim from the agent's row
# (PATCH {model: "claude-haiku-5-5"}); MODEL only seeds the adapter's start.
# `down` stops the loops; BASE (workspace, ACP state, logs) stays.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=$(cd "$HERE/../.." && pwd)
BASE=${BASE:-$HOME/acp-local}
ADAPTER=${ADAPTER:-0.108.0}
LAB=${LAB:-$HOME/acp-lab}

case "${1:-}" in
token)
	name=${2:?agent name}
	# agentId from the lab's D1 shim (or AGENT_ID=…), key from the lab backend's env.
	id=${AGENT_ID:-$(docker exec acplab-d1 node --no-warnings -e '
		const { DatabaseSync } = require("node:sqlite");
		const r = new DatabaseSync("/data/d1.sqlite").prepare("SELECT agent_id FROM acp_agents WHERE name = ?").get(process.argv[1]);
		if (!r) process.exit(1);
		console.log(r.agent_id);' "$name")}
	key=${SECRETS_ENCRYPTION_KEY:-$(sed -n 's/^SECRETS_ENCRYPTION_KEY=//p' "$LAB/backend.env")}
	# Same as AcpAgents.tokenFor(agentId): HMAC under deriveSubkey("st-acp-agent-token/v1").
	KEY=$key node -e '
		const c = require("node:crypto");
		const sub = Buffer.from(c.hkdfSync("sha256", Buffer.from(process.env.KEY, "base64"), Buffer.alloc(0), "st-acp-agent-token/v1", 32));
		const id = process.argv[1];
		console.log(`acp1.${id}.${c.createHmac("sha256", sub).update(id).digest("base64url")}`);' "$id"
	;;
up)
	: "${ST_URL:?}" "${ST_TOKEN:?}" "${ST_AGENT:?}"
	[ -f "$BASE/pids" ] && { echo "already up ($BASE/pids): down first" >&2; exit 1; }
	mkdir -p "$BASE/rt" "$BASE/ws"
	"$SRC/acp-runtime/install.sh" "$BASE/rt" "$ADAPTER" # its own wrapper points at /opt/st-acp: not used
	printf '#!/bin/sh\nexec node "%s/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js" "$@"\n' \
		"$BASE/rt/claude-acp-$ADAPTER" >"$BASE/agent"
	chmod 755 "$BASE/agent"
	for k in $(seq 1 "${SLOTS:-1}"); do
		# A clean environment (env -i): run from an agent's own shell, the caller's
		# CLAUDECODE / CLAUDE_CODE_* / ST_* would leak into the adapter and its CLI.
		# One process group per slot (setsid), so `down` takes the loop, the runner and its adapter.
		env -i HOME="$HOME" USER="${USER:-}" LANG="${LANG:-C.UTF-8}" PATH="$SRC/acp-runtime/bin:$PATH" \
			ST_URL="$ST_URL" ST_TOKEN="$ST_TOKEN" ST_AGENT="$ST_AGENT" ACP_AGENT_CMD="$BASE/agent" \
			AGENT_CWD="$BASE/ws" RUNNER_STATE="$BASE/ws/.st/acp" ANTHROPIC_MODEL="${MODEL:-claude-haiku-5-5}" \
			DISABLE_AUTOUPDATER=1 setsid bash -c "while true; do node --no-warnings '$SRC/acp-runtime/runner.mjs' $k >>'$BASE/slot-$k.log' 2>&1; sleep 3; done" \
			</dev/null >/dev/null 2>&1 &
		echo "$!" >>"$BASE/pids"
	done
	sleep 2
	"$0" status
	;;
status)
	[ -f "$BASE/pids" ] || { echo "down"; exit 0; }
	k=0
	while read -r pid; do
		k=$((k + 1))
		if kill -0 "$pid" 2>/dev/null; then echo "slot $k: loop $pid up"; else echo "slot $k: loop $pid GONE"; fi
	done <"$BASE/pids"
	;;
logs) tail -n "${N:-40}" "$BASE"/slot-*.log ;;
down)
	[ -f "$BASE/pids" ] || exit 0
	while read -r pid; do kill -- "-$pid" 2>/dev/null || true; done <"$BASE/pids"
	rm -f "$BASE/pids"
	;;
*)
	sed -n 2,17p "$0"
	exit 2
	;;
esac

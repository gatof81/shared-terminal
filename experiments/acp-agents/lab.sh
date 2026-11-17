#!/usr/bin/env bash
# ACP two-agent lab on a Docker host. Everything it creates carries label acp-lab=1
# and the prefix acplab-; `down` removes exactly that.
#   ./lab.sh setup            network, volumes, pinned ACP runtimes, tokens, settings
#   ./lab.sh st               start the inbox server
#   ./lab.sh agent <name>     start (or recreate) an agent container
#   ./lab.sh owner <st args>  run the st CLI as the owner (e.g. owner send @arquitecto "…")
#   ./lab.sh runtime <ver>    point the stable wrapper at another pinned adapter bundle
#   ./lab.sh down             remove containers, volumes, network
# Needs: TOKEN_ENV (a file with CLAUDE_CODE_OAUTH_TOKEN=…), CODE_DIR (this directory).
set -euo pipefail
LAB=${LAB:-$HOME/acp-lab}
CODE_DIR=${CODE_DIR:-$LAB/code}
TOKEN_ENV=${TOKEN_ENV:-$LAB/.tok.env}
IMG=${IMG:-shared-terminal-session:latest} # any image with node >= 22.13; nothing ACP in it
ACPX_VERSION=0.22.0
ADAPTERS=(0.107.3 0.108.0)
AGENTS=(arquitecto developer)
MODEL=${MODEL:-sonnet}

ensure_runtime() { # one directory per pinned adapter version, installed once, mounted read-only
	docker run --rm -v acplab-runtime:/opt/st-acp --entrypoint bash "$IMG" -c "set -e
		mkdir -p /opt/st-acp/bin
		for v in ${ADAPTERS[*]}; do
			d=/opt/st-acp/claude-acp-\$v; [ -d \$d/node_modules ] && continue
			mkdir -p \$d && cd \$d && npm init -y >/dev/null
			npm install --no-audit --no-fund --save-exact acpx@$ACPX_VERSION @agentclientprotocol/claude-agent-acp@\$v >/dev/null
		done
		printf '#!/bin/sh\nexec node /opt/st-acp/current/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js \"\$@\"\n' > /opt/st-acp/bin/claude-acp
		chmod +x /opt/st-acp/bin/claude-acp
		[ -e /opt/st-acp/current ] || ln -s claude-acp-${ADAPTERS[0]} /opt/st-acp/current
		ls -l /opt/st-acp"
}

case "${1:-}" in
setup)
	docker network inspect acplab-net >/dev/null 2>&1 || docker network create --label acp-lab=1 acplab-net >/dev/null
	for v in acplab-runtime acplab-st "${AGENTS[@]/#/acplab-}"; do docker volume create --label acp-lab=1 "$v" >/dev/null; done
	docker run --rm -u 0 -v acplab-runtime:/r -v acplab-st:/s -v acplab-arquitecto:/a -v acplab-developer:/d \
		--entrypoint chown "$IMG" 1000:1000 /r /s /a /d
	ensure_runtime
	umask 077
	if [ ! -f "$LAB/tokens.json" ]; then
		python3 -c 'import json,secrets,sys; print(json.dumps({n: secrets.token_hex(24) for n in sys.argv[1:]}))' owner "${AGENTS[@]}" >"$LAB/tokens.json"
	fi
	python3 -c 'import json,sys; t=json.load(open(sys.argv[1])); print(json.dumps({"tokens": {v: k for k, v in t.items()}}))' "$LAB/tokens.json" |
		docker run --rm -i -v acplab-st:/data --entrypoint sh "$IMG" -c 'cat > /data/config.json'
	# Autonomy equivalent to --dangerously-skip-permissions, set where Claude reads it.
	for a in "${AGENTS[@]}"; do
		docker run --rm -v "acplab-$a:/agent" --entrypoint sh "$IMG" -c \
			'mkdir -p /agent/.claude /agent/work && echo "{\"permissions\":{\"defaultMode\":\"bypassPermissions\"}}" > /agent/.claude/settings.json'
	done
	;;
st)
	docker rm -f acplab-st >/dev/null 2>&1 || true
	docker run -d --init --name acplab-st --label acp-lab=1 --network acplab-net --network-alias st \
		-v acplab-st:/data -v "$CODE_DIR:/opt/st:ro" --entrypoint node "$IMG" --no-warnings /opt/st/server.mjs
	;;
agent)
	a=$2
	tok=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$LAB/tokens.json" "$a")
	docker rm -f "acplab-$a" >/dev/null 2>&1 || true
	docker run -d --init --name "acplab-$a" --label acp-lab=1 --network acplab-net --cpus 2 --memory 3g \
		--env-file "$TOKEN_ENV" -e DISABLE_AUTOUPDATER=1 -e CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
		-e HOME=/agent -e ST_AGENT="$a" -e ST_TOKEN="$tok" -e ST_URL=http://st:8080 -e ST_AGENTS="$(printf '@%s ' "${AGENTS[@]}")" \
		-e ACP_AGENT_CMD=/opt/st-acp/bin/claude-acp -e AGENT_CWD=/agent/work -e AGENT_MODEL="$MODEL" \
		-e PATH=/opt/st/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
		-v acplab-runtime:/opt/st-acp:ro -v "$CODE_DIR:/opt/st:ro" -v "acplab-$a:/agent" \
		--entrypoint node "$IMG" --no-warnings /opt/st/runner.mjs
	;;
owner)
	shift
	tok=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["owner"])' "$LAB/tokens.json")
	docker exec -e ST_TOKEN="$tok" -e ST_URL=http://localhost:8080 acplab-st node /opt/st/bin/st "$@"
	;;
runtime)
	docker run --rm -v acplab-runtime:/opt/st-acp --entrypoint sh "$IMG" -c \
		"test -d /opt/st-acp/claude-acp-$2 && ln -sfn claude-acp-$2 /opt/st-acp/current && ls -l /opt/st-acp/current"
	;;
down)
	docker ps -aq --filter label=acp-lab=1 | xargs -r docker rm -f >/dev/null
	docker volume ls -q --filter label=acp-lab=1 | xargs -r docker volume rm >/dev/null
	docker network rm acplab-net >/dev/null 2>&1 || true
	;;
*)
	sed -n '2,10p' "$0"
	exit 2
	;;
esac

#!/usr/bin/env bash
# Lab Shared Terminal with ACP agents on a Docker host, isolated from production:
# own network (<LAB_NAME>-net), own WORKSPACE_ROOT, SQLite D1 shim (no Cloudflare),
# backend/web published on 127.0.0.1 only (use ssh -L). Everything carries
# label acp-lab=1; `down` removes the lab's containers and network (data dirs stay).
#   SRC=<repo snapshot> ./lab-st.sh up | web <dist-dir> | down
# A second lab (e.g. the restore target of tasks-acceptance.mjs S15), same host:
#   LAB=$HOME/acp-lab2 LAB_NAME=acplab2 PORT=3102 ENV_FILE=$HOME/acp-lab/backend.env ./lab-st.sh up
# (ENV_FILE: reuse lab A's SECRETS_ENCRYPTION_KEY). ACP_GOAL_BUDGET / ACP_TASK_BUDGET, when set,
# reach the backend (defaults: the backend's own, 150 / 40).
set -euo pipefail
LAB=${LAB:-$HOME/acp-lab}
LAB_NAME=${LAB_NAME:-acplab}
PORT=${PORT:-3101}
ENV_FILE=${ENV_FILE:-$LAB/backend.env}
SRC=${SRC:-$LAB/src}
NODE_IMG=${NODE_IMG:-shared-terminal-session:latest} # only used as "a Node 22 image"
WS=$LAB/ws
NET=$LAB_NAME-net
TAG=st-acp-lab-backend:${TAG:-dev}

case "${1:-}" in
up)
	docker network inspect "$NET" >/dev/null 2>&1 || docker network create --label acp-lab=1 "$NET" >/dev/null
	mkdir -p "$WS" "$LAB/d1"
	if [ ! -f "$ENV_FILE" ]; then
		umask 077
		{
			echo "JWT_SECRET=$(openssl rand -hex 32)"
			echo "SECRETS_ENCRYPTION_KEY=$(openssl rand -base64 32)"
		} >"$ENV_FILE"
	fi
	docker rm -f "$LAB_NAME-d1" >/dev/null 2>&1 || true
	docker run -d --name "$LAB_NAME-d1" --label acp-lab=1 --network "$NET" -u 0 \
		-v "$LAB/d1:/data" -v "$SRC/experiments/acp-agents:/opt/shim:ro" \
		--entrypoint node "$NODE_IMG" --no-warnings /opt/shim/d1-shim.mjs >/dev/null
	docker build -q -t "$TAG" "$SRC" >/dev/null
	# One pinned adapter bundle, apart from any image.
	docker run --rm -u 0 -v "$WS:$WS" -v "$SRC/acp-runtime:/opt/src:ro" --entrypoint bash "$NODE_IMG" \
		/opt/src/install.sh "$WS/.acp-runtime" "${ADAPTER:-0.108.0}"
	budgets=()
	[ -n "${ACP_GOAL_BUDGET:-}" ] && budgets+=(-e "ACP_GOAL_BUDGET=$ACP_GOAL_BUDGET")
	[ -n "${ACP_TASK_BUDGET:-}" ] && budgets+=(-e "ACP_TASK_BUDGET=$ACP_TASK_BUDGET")
	docker rm -f "$LAB_NAME-backend" >/dev/null 2>&1 || true
	docker run -d --name "$LAB_NAME-backend" --label acp-lab=1 --network "$NET" --network-alias st-backend \
		-p "127.0.0.1:$PORT:3001" --env-file "$ENV_FILE" \
		-v /var/run/docker.sock:/var/run/docker.sock -v "$WS:$WS" \
		-e PORT=3001 -e NODE_ENV=production -e CORS_ORIGINS=http://localhost:5174 -e TRUST_PROXY=0 \
		-e WORKSPACE_ROOT="$WS" -e SESSIONS_NETWORK="$NET" -e SESSION_IMAGE=shared-terminal-session \
		-e CLOUDFLARE_ACCOUNT_ID=lab -e CLOUDFLARE_API_TOKEN=lab -e D1_DATABASE_ID=lab -e D1_API_BASE="http://$LAB_NAME-d1:8787" \
		-e ACP_TEST_RUNTIME=1 -e ACP_DEFAULT_RUNTIME="claude-acp-${ADAPTER:-0.108.0}" -e ACP_DEFAULT_MODEL="${MODEL:-claude-sonnet-5-5}" \
		-e ACP_MAX_RUNNING="${MAX_RUNNING:-6}" ${budgets[@]+"${budgets[@]}"} \
		"$TAG" >/dev/null
	sleep 5
	docker logs "$LAB_NAME-backend" 2>&1 | grep -E "ACP|listening|acp\]|migration 2[0-9]|error" | head
	;;
web)
	dist=${2:?dist dir}
	docker rm -f "$LAB_NAME-web" >/dev/null 2>&1 || true
	docker run -d --name "$LAB_NAME-web" --label acp-lab=1 -p 127.0.0.1:5174:5174 -v "$dist:/web:ro" -w /web \
		--entrypoint python3 "$NODE_IMG" -m http.server 5174 >/dev/null
	;;
down)
	# Session containers the lab backend spawned carry no lab label: they are the
	# ones on the lab's network. Only this lab's: another lab on the host stays up.
	docker ps -aq --filter "network=$NET" | xargs -r docker rm -f >/dev/null
	docker rm -f "$LAB_NAME-d1" "$LAB_NAME-backend" "$LAB_NAME-web" >/dev/null 2>&1 || true
	docker network rm "$NET" >/dev/null 2>&1 || true
	;;
*)
	sed -n 2,10p "$0"
	exit 2
	;;
esac

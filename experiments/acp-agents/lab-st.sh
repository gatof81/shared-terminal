#!/usr/bin/env bash
# Lab Shared Terminal with ACP agents on a Docker host, isolated from production:
# own network (acplab-net), own WORKSPACE_ROOT, SQLite D1 shim (no Cloudflare),
# backend/web published on 127.0.0.1 only (use ssh -L). Everything carries
# label acp-lab=1; `down` removes the containers and the network (data dirs stay).
#   SRC=<repo snapshot> ./lab-st.sh up | web <dist-dir> | down
set -euo pipefail
LAB=${LAB:-$HOME/acp-lab}
SRC=${SRC:-$LAB/src}
NODE_IMG=${NODE_IMG:-shared-terminal-session:latest} # only used as "a Node 22 image"
WS=$LAB/ws
TAG=st-acp-lab-backend:${TAG:-dev}

case "${1:-}" in
up)
	docker network inspect acplab-net >/dev/null 2>&1 || docker network create --label acp-lab=1 acplab-net >/dev/null
	mkdir -p "$WS" "$LAB/d1"
	if [ ! -f "$LAB/backend.env" ]; then
		umask 077
		{
			echo "JWT_SECRET=$(openssl rand -hex 32)"
			echo "SECRETS_ENCRYPTION_KEY=$(openssl rand -base64 32)"
		} >"$LAB/backend.env"
	fi
	docker rm -f acplab-d1 >/dev/null 2>&1 || true
	docker run -d --name acplab-d1 --label acp-lab=1 --network acplab-net -u 0 \
		-v "$LAB/d1:/data" -v "$SRC/experiments/acp-agents:/opt/shim:ro" \
		--entrypoint node "$NODE_IMG" --no-warnings /opt/shim/d1-shim.mjs >/dev/null
	docker build -q -t "$TAG" "$SRC" >/dev/null
	# One pinned adapter bundle, apart from any image.
	docker run --rm -u 0 -v "$WS:$WS" -v "$SRC/acp-runtime:/opt/src:ro" --entrypoint bash "$NODE_IMG" \
		/opt/src/install.sh "$WS/.acp-runtime" "${ADAPTER:-0.108.0}"
	docker rm -f acplab-backend >/dev/null 2>&1 || true
	docker run -d --name acplab-backend --label acp-lab=1 --network acplab-net --network-alias st-backend \
		-p 127.0.0.1:3101:3001 --env-file "$LAB/backend.env" \
		-v /var/run/docker.sock:/var/run/docker.sock -v "$WS:$WS" \
		-e PORT=3001 -e NODE_ENV=development -e CORS_ORIGINS=http://localhost:5174 -e TRUST_PROXY=0 \
		-e WORKSPACE_ROOT="$WS" -e SESSIONS_NETWORK=acplab-net -e SESSION_IMAGE=shared-terminal-session \
		-e CLOUDFLARE_ACCOUNT_ID=lab -e CLOUDFLARE_API_TOKEN=lab -e D1_DATABASE_ID=lab -e D1_API_BASE=http://acplab-d1:8787 \
		-e ACP_AGENTS_ENABLED=1 -e ACP_DEFAULT_RUNTIME="claude-acp-${ADAPTER:-0.108.0}" -e ACP_DEFAULT_MODEL="${MODEL:-claude-sonnet-5-5}" \
		"$TAG" >/dev/null
	sleep 5
	docker logs acplab-backend 2>&1 | grep -E "ACP|listening|acp\]|migration 21|error" | head
	;;
web)
	dist=${2:?dist dir}
	docker rm -f acplab-web >/dev/null 2>&1 || true
	docker run -d --name acplab-web --label acp-lab=1 -p 127.0.0.1:5174:5174 -v "$dist:/web:ro" -w /web \
		--entrypoint python3 "$NODE_IMG" -m http.server 5174 >/dev/null
	;;
down)
	# Session containers the lab backend spawned carry no lab label: they are the
	# ones on acplab-net.
	docker ps -aq --filter network=acplab-net | xargs -r docker rm -f >/dev/null
	docker ps -aq --filter label=acp-lab=1 | xargs -r docker rm -f >/dev/null
	docker network rm acplab-net >/dev/null 2>&1 || true
	;;
*)
	sed -n 2,6p "$0"
	exit 2
	;;
esac

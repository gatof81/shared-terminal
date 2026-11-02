#!/usr/bin/env bash
# Shared helpers for the phase-0 POC kit. Sourced, never executed.
set -euo pipefail

POC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POC_LABEL="io.shared-terminal.poc=1"
AGENT=poc-agent
PROXY=poc-proxy
NET_INT=poc-int
NET_EGRESS=poc-egress
NET_INT_SUBNET=172.31.250.0/24
VOL_HOME=poc-home
VOL_WS=poc-workspace
IMG_AGENT=poc-agent-image:phase0
IMG_PROXY=poc-proxy-image:phase0
OUT_IN_AGENT=/workspace/poc-out
CHANNEL_SPEC="plugin:fakechat@claude-plugins-official"

log() { printf '[poc %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { printf '[poc] ABORT: %s\n' "$*" >&2; exit 1; }

load_config() {
	[ -f "$POC_DIR/config.env" ] || die "falta config.env (copiá config.env.example y completalo)"
	# shellcheck disable=SC1091
	. "$POC_DIR/config.env"
	: "${PROD_CIDRS:?}" "${PROD_PROBE_IPS:?}" "${CLI_VERSION:?}" "${BUN_VERSION:?}" "${FAKECHAT_COMMIT:?}"
	case "$PROD_CIDRS" in *192.0.2.*) die "config.env todavía tiene las direcciones de ejemplo";; esac
}

# Every docker call that acts on POC resources goes through these, so nothing
# outside the label can be touched by the kit.
agent_exec() { docker exec -u developer "$AGENT" "$@"; }
agent_sh() { docker exec -u developer "$AGENT" bash -lc "$1"; }
poc_containers() { docker ps -aq --filter "label=$POC_LABEL"; }

set_proxy_phase() { # setup | test
	local phase="$1"
	[ "$phase" = setup ] || [ "$phase" = test ] || die "fase de proxy desconocida: $phase"
	docker rm -f "$PROXY" >/dev/null 2>&1 || true
	docker run -d --name "$PROXY" --label "$POC_LABEL" --network "$NET_EGRESS" \
		--cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp \
		-e "PHASE=$phase" "$IMG_PROXY" >/dev/null
	docker network connect "$NET_INT" "$PROXY"
	log "proxy en fase $phase"
}

run_dir() {
	local d="$POC_DIR/out/$1-$(date -u +%Y%m%dT%H%M%SZ)"
	mkdir -p "$d"
	printf '%s\n' "$d"
}

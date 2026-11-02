#!/usr/bin/env bash
# S0 step 1: build images and start the isolated environment. Uses no
# credentials and never calls the Anthropic API.
. "$(dirname "$0")/lib.sh"
load_config
"$POC_DIR/guard.sh"

# Fresh volumes are part of the evidence that no existing credential is used.
for v in "$VOL_HOME" "$VOL_WS"; do
	docker volume inspect "$v" >/dev/null 2>&1 && die "el volumen $v ya existe: correr teardown.sh antes"
done
[ -z "$(poc_containers)" ] || die "ya hay contenedores de la POC: correr teardown.sh antes"

log "construyendo imágenes"
docker build -q -t "$IMG_AGENT" --label "$POC_LABEL" \
	--build-arg "NODE_IMAGE=$NODE_IMAGE" --build-arg "CLI_VERSION=$CLI_VERSION" \
	--build-arg "BUN_VERSION=$BUN_VERSION" "$POC_DIR/image"
docker build -q -t "$IMG_PROXY" --label "$POC_LABEL" \
	--build-arg "PROXY_BASE_IMAGE=$PROXY_BASE_IMAGE" "$POC_DIR/proxy"

docker network create --label "$POC_LABEL" --internal --subnet "$NET_INT_SUBNET" "$NET_INT" >/dev/null
docker network create --label "$POC_LABEL" "$NET_EGRESS" >/dev/null
docker volume create --label "$POC_LABEL" "$VOL_HOME" >/dev/null
docker volume create --label "$POC_LABEL" "$VOL_WS" >/dev/null

set_proxy_phase setup

proxy_env=(-e HTTPS_PROXY=http://poc-proxy:8888 -e HTTP_PROXY=http://poc-proxy:8888
	-e https_proxy=http://poc-proxy:8888 -e http_proxy=http://poc-proxy:8888
	-e NO_PROXY=127.0.0.1,localhost -e no_proxy=127.0.0.1,localhost)
# No docker.sock, no host bind mounts: two fresh named volumes only.
docker run -d --name "$AGENT" --label "$POC_LABEL" --network "$NET_INT" \
	--cap-drop ALL --security-opt no-new-privileges --pids-limit 512 --memory 2g --cpus 2 \
	--read-only --tmpfs /tmp:rw,nosuid,nodev,size=256m \
	-v "$VOL_HOME:/home/developer" -v "$VOL_WS:/workspace" \
	"${proxy_env[@]}" --user developer "$IMG_AGENT" >/dev/null
agent_sh "mkdir -p $OUT_IN_AGENT"
log "entorno arriba. Siguiente: ./s0-plugin.sh"

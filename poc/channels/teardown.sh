#!/usr/bin/env bash
# End of phase 0 (or abort), in this order: /logout first, then a redacted copy
# of the evidence, then every POC resource. Then destroy the VM by hand.
. "$(dirname "$0")/lib.sh"
load_config

if docker ps -q --filter "name=^${AGENT}$" | grep -q .; then
	cat <<MSG

  1) /logout primero (lo hace el responsable):
       docker exec -it -u developer $AGENT tmux attach -t main
     escribí /logout, confirmá, y salí.
MSG
	read -r -p "¿Hiciste /logout? (escribí 'si'): " ans
	[ "$ans" = si ] || die "sin /logout no se borra nada (el contenedor sigue)"

	archive="$POC_DIR/out/archive-$(date -u +%Y%m%dT%H%M%SZ)"
	mkdir -p "$archive/agent"
	# Closed list: only the POC's own output dir from the agent, never HOME.
	docker cp "$AGENT:$OUT_IN_AGENT/." "$archive/agent/" || true
	docker logs "$PROXY" >"$archive/proxy.log" 2>&1 || true
	for d in "$POC_DIR"/out/s0-* "$POC_DIR"/out/s1-* "$POC_DIR"/out/phase0-report.md; do
		[ -e "$d" ] && cp -r "$d" "$archive/"
	done
	if ! python3 -I "$POC_DIR/redact.py" "$archive"; then
		rm -rf "$archive"
		die "quedó un valor con forma de token tras redactar: no se archiva nada"
	fi
	log "evidencia redactada en $archive"
fi

log "borrando recursos de la POC (sólo los etiquetados $POC_LABEL)"
c="$(poc_containers)"; [ -z "$c" ] || docker rm -f $c >/dev/null
for v in $(docker volume ls -q --filter "label=$POC_LABEL"); do docker volume rm "$v" >/dev/null; done
for n in $(docker network ls -q --filter "label=$POC_LABEL"); do docker network rm "$n" >/dev/null; done
for i in $(docker images -q --filter "label=$POC_LABEL"); do docker rmi -f "$i" >/dev/null || true; done
log "listo. Copiá el archivo de evidencia fuera de la VM y destruí la VM (o su disco)."

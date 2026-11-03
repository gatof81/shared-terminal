#!/usr/bin/env bash
# PASS-B0 runner for VM100 (04-poc.md §1.14.9). One phase per call:
#
#   bash run-b0.sh BASE preflight|setup|servers|measure|capture|validate|cleanup
#
# Fail-closed by construction:
# - `set -euo pipefail` is in force for the whole script, which the operator runs as a
#   plain command; it is never part of a `&&`/`||` list, where bash would ignore errexit.
# - "OK: <phase>" is the last line of a successful phase, printed from inside the script.
# - A phase writes BASE/state/<phase>.ok only on success, and every phase refuses to start
#   without the marker of the phase before it, whatever the operator saw on screen.
# capture and cleanup are the exceptions: they must also run after a partial failure.
#
# The experiment container is evidence. cleanup removes it only on one of three grounds,
# checked against that exact container id (state/container_id) and recorded in RES:
#   captured            capture.ok exists and RES still verifies against SHA256SUMS
#   no-evidence         an exec in the container proves both output dirs hold no file
#   discard-authorized  the operator set B0_DISCARD_EVIDENCE=<full id of that container>
# Anything else (a partial capture included) stops with exit 66 and touches nothing.
set -euo pipefail
umask 077

die() { echo "FALLÓ: $*" >&2; exit "${2:-1}"; }
[ $# -eq 2 ] || die "uso: run-b0.sh BASE fase" 64
BASE=$1 PHASE=$2
[ -f "$BASE/env" ] || die "falta $BASE/env (paso 0)" 64

# Strict KEY=VALUE reader: the env file is data, never sourced.
declare -A E
while IFS='=' read -r k v; do
	[[ $k =~ ^[A-Z_]+$ ]] || die "env: clave inválida" 64
	[[ $v =~ ^[A-Za-z0-9_./:@+-]*$ ]] || die "env: valor inválido para $k" 64
	E[$k]=$v
done < "$BASE/env"
for k in STAMP KIT RUN RES EXP IMAGE COMMIT; do [ -n "${E[$k]:-}" ] || die "env: falta $k" 64; done
STAMP=${E[STAMP]} KIT=${E[KIT]} RUN=${E[RUN]} RES=${E[RES]} EXP=${E[EXP]} IMAGE=${E[IMAGE]}
[[ $EXP == "passb0-exp-$STAMP" ]] || die "env: EXP no corresponde a STAMP" 64
STATE=$BASE/state
mkdir -p "$STATE"
LABEL="passb0.experiment=$STAMP"
WANT_CLI=2.1.314
W=/home/developer/passb0-ws
D() { if [ "${B0_DOCKER_SUDO:-0}" = 1 ]; then sudo -n docker "$@"; else docker "$@"; fi; }
X() { D exec -u developer "$EXP" "$@"; }
B0() { X python3 -I /opt/passb0-kit/b0.py "$@"; }
need() { [ -f "$STATE/$1" ] || die "falta la marca $1: corré antes la fase anterior" 65; }
ok() { : > "$STATE/$PHASE.ok"; echo "OK: $PHASE"; }
image_id() { cat "$STATE/image_id"; }
# Writes {"version", "expected", "match"} for the CLI inside the container; returns 0 only on
# an exact match. Explicit checks throughout: it also runs where errexit does not apply.
cli_version_to() {
	local out v
	out=$(X claude --version) || return 2
	v=$(awk 'NR == 1 {print $1}' <<< "$out")
	python3 -I -c 'import json,sys; json.dump({"version": sys.argv[1], "expected": sys.argv[2], "match": sys.argv[1] == sys.argv[2]}, open(sys.argv[3], "w"))' \
		"$v" "$WANT_CLI" "$1" || return 3
	[ "$v" = "$WANT_CLI" ] || return 1
}

preflight() {
	# Read-only: no container, image, network or setting is created or changed.
	local kv yama info id hist ver
	kv=$(uname -r)
	python3 -c 'import sys; v=tuple(int(x) for x in sys.argv[1].split("-")[0].split(".")[:2]); sys.exit(0 if v >= (6, 5) else 1)' "$kv" \
		|| die "kernel $kv < 6.5 (sin SO_PEERPIDFD)"
	python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' || die "python3 < 3.9"
	yama=$(cat /proc/sys/kernel/yama/ptrace_scope)
	[ "$yama" = 1 ] || die "ptrace_scope=$yama (se exige 1)"
	info=$(D info --format '{{json .SecurityOptions}}')
	if grep -q userns <<<"$info"; then die "Docker con userns-remap: los uid del host no coinciden"; fi
	id=$(D image inspect "$IMAGE" --format '{{.Id}}')
	[[ $id =~ ^sha256:[0-9a-f]{64}$ ]] || die "id de imagen inesperado"
	hist=$(D image history --no-trunc --format '{{.CreatedBy}}' "$id")
	ver=$(python3 -I "$KIT/b0.py" imageversion <<<"$hist" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"] or "")') || true
	if [ "$ver" != "$WANT_CLI" ]; then
		echo "STOP: la imagen trae Claude Code '${ver:-desconocida}', no $WANT_CLI. No se crea nada." >&2
		echo "      Alternativas para decidir (04-poc.md §1.14.9, 'Versión de la imagen'); ninguna se aplica sola." >&2
		exit 3
	fi
	[ -z "$(D ps -a -q --filter label=passb0.experiment)" ] || die "ya hay contenedores passb0: limpiarlos primero"
	[ -z "$(D ps -a -q --filter "name=^/$EXP\$")" ] || die "el nombre $EXP está ocupado"
	echo "$id" > "$STATE/image_id"
	python3 -I -c 'import json,sys; json.dump({"kernel":sys.argv[1],"ptrace_scope":sys.argv[2],"image_id_prefix":sys.argv[3][7:19],"cli_version":sys.argv[4]}, open(sys.argv[5],"w"))' \
		"$kv" "$yama" "$id" "$ver" "$RES/preflight.json"
	ok
}

setup() {
	need preflight.ok
	local id v
	id=$(image_id)
	D run -d --name "$EXP" --label "$LABEL" --init --entrypoint /usr/bin/sleep \
		--user developer --workdir /home/developer --cap-drop ALL --security-opt no-new-privileges:true \
		--pids-limit 256 --memory 2g --memory-swap 2g --cpus 1 --network bridge --restart no \
		--mount "type=bind,src=$KIT,dst=/opt/passb0-kit,readonly" \
		--mount "type=bind,src=$RUN,dst=/run/st-attest,readonly" \
		"$id" 3600 > "$STATE/container_id"
	[[ $(cat "$STATE/container_id") =~ ^[0-9a-f]{64}$ ]] || die "docker run no devolvió un id de contenedor"
	[ "$(D inspect -f '{{.Id}}' "$EXP")" = "$(cat "$STATE/container_id")" ] || die "el nombre $EXP no apunta al contenedor creado"
	# What Docker actually applied, not what we asked for.
	D inspect "$EXP" > "$STATE/inspect.json"
	python3 -I "$KIT/b0.py" checklimits "$STATE/inspect.json" "$STAMP" "$KIT" "$RUN" || die "límites del contenedor distintos de lo pedido"
	cli_version_to "$RES/cli-version-before.json" || die "dentro del contenedor la versión no es $WANT_CLI (ver cli-version-before.json; corré capture y cleanup)"
	[ "$(X id -u)" = 1000 ] || die "uid distinto de 1000"
	B0 cliinfo > "$STATE/cliinfo-before.json"
	python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1]))["cli"] == [] else 1)' "$STATE/cliinfo-before.json" \
		|| die "ya hay un proceso claude en el contenedor"
	X mkdir -p "$W/.passb0/out/mod"
	ok
}

servers() {
	need setup.ok
	local cid i
	cid=$(D inspect -f '{{.Id}}' "$EXP")
	X sh -c 'mkdir -p /tmp/passb0/out'
	D exec -d -u developer "$EXP" python3 -I /opt/passb0-kit/b0.py server --scope container \
		--sock /tmp/passb0/c.sock --out /tmp/passb0/out --held /tmp/passb0/held-c.json --deadline-s 3000
	[ ! -e "$STATE/server-h.identity.json" ] || die "ya existe una identidad de servidor del host"
	nohup python3 -I "$KIT/b0.py" server --scope host --sock "$RUN/h.sock" --out "$RES" \
		--held "$RUN/held-h.json" --expect-container "$cid" --deadline-s 3000 \
		--identity "$STATE/server-h.identity.json" > "$RES/server-h.out" 2>&1 < /dev/null &
	for i in $(seq 1 50); do
		if [ -S "$RUN/h.sock" ] && [ -f "$STATE/server-h.identity.json" ] && X test -S /tmp/passb0/c.sock; then break; fi
		sleep 0.2
	done
	[ -S "$RUN/h.sock" ] || die "el servidor del host no escucha"
	[ -f "$STATE/server-h.identity.json" ] || die "el servidor del host no escribió su identidad"
	X test -S /tmp/passb0/c.sock || die "el servidor del contenedor no escucha"
	ok
}

measure() {
	# Run while the CLI is still open in terminal B.
	need servers.ok
	local done=false i
	for i in $(seq 1 120); do
		if X sh -c "grep -l '\"kind\":\"done\"' $W/.passb0/out/mod/*.json" > /dev/null 2>&1; then done=true; break; fi
		sleep 1
	done
	echo "{\"done\": $done}" > "$RES/measure.json"
	B0 cliinfo --out /tmp/passb0/out/cliinfo.json > /dev/null
	B0 client --sock /tmp/passb0/c.sock --label base --out /tmp/passb0/out/base-c.json > /dev/null
	B0 client --sock /run/st-attest/h.sock --label base --out /tmp/passb0/out/base-h.json > /dev/null
	B0 client --sock /tmp/passb0/c.sock --label control --held /tmp/passb0/held-c.json --out /tmp/passb0/out/control-c.json > /dev/null
	B0 rocheck --dir /run/st-attest --out /tmp/passb0/out/rocheck.json > /dev/null
	[ "$done" = true ] || echo "AVISO: el mod no registró 'done' en 120 s; el analizador lo dará INCONCLUSIVE" >&2
	ok
}

capture() {
	# Copies everything available, item by item, and records each result. An item that
	# fails is written down, never hidden, and the rest is still copied. Needs only the
	# preflight: after a setup that failed half-way there is still something to keep.
	need preflight.ok
	# A rerun that fails must not leave an earlier success standing.
	rm -f "$STATE/capture.ok"
	: > "$STATE/capture.attempted"
	local items=() st
	item() { # name, command...
		local name=$1; shift
		if "$@" 2> "$STATE/capture-$name.err"; then items+=("$name=ok"); else items+=("$name=failed:$?"); fi
	}
	debug_filter() {
		# Only the lines that name this plugin or the guard leave the container.
		X sh -c "test -f $W/.passb0/out/claude-debug.log || exit 2; grep -E 'st-passb0-probe|sec-default' $W/.passb0/out/claude-debug.log > /tmp/passb0/out/claude-debug.log; rc=\$?; [ \$rc -le 1 ]"
	}
	item debug-filter debug_filter
	item container-out D cp "$EXP:/tmp/passb0/out/." "$RES/"
	item mod D cp "$EXP:$W/.passb0/out/mod" "$RES/"
	item held-h cp -p "$RUN/held-h.json" "$RES/held-h.json"
	item cli-version-after cli_version_to "$RES/cli-version-after.json"
	python3 -I "$KIT/b0.py" manifest "$RES" "${items[@]}" > /dev/null
	(cd "$RES" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
	(cd "$RES" && sha256sum -c --quiet SHA256SUMS)
	st=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["complete"])' "$RES/capture-manifest.json")
	[ "$st" = True ] || die "captura incompleta: evidencia conservada en $RES (ver capture-manifest.json)" 4
	ok
}

validate() {
	[ -f "$STATE/capture.attempted" ] || die "falta capture" 65
	local rc=0
	python3 -I "$KIT/analyze.py" report "$RES" > "$RES/report.json" || rc=$?
	cat "$RES/report.json"
	[ "$rc" -eq 0 ] || die "veredicto distinto de PASS (salida $rc)" "$rc"
	ok
}

# Prints the ground on which container $1 may be removed; returns 1 when there is none.
removal_basis() {
	local id=$1
	if [ -f "$STATE/capture.ok" ] && [ -f "$RES/SHA256SUMS" ] && (cd "$RES" && sha256sum -c --quiet SHA256SUMS > /dev/null 2>&1) \
		&& python3 -I -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get("complete") is True else 1)' "$RES/capture-manifest.json" 2> /dev/null; then
		echo captured; return 0
	fi
	if [ -n "${B0_DISCARD_EVIDENCE:-}" ]; then
		if [ "$B0_DISCARD_EVIDENCE" = "$id" ]; then echo discard-authorized; return 0; fi
		echo "B0_DISCARD_EVIDENCE no coincide con el id del contenedor: se ignora" >&2
	fi
	# Exec fails on a stopped container, so "cannot look" never counts as "nothing there".
	if X sh -c 'for d in /tmp/passb0 "$1/.passb0/out"; do [ ! -e "$d" ] || [ -z "$(find "$d" -type f -print -quit)" ] || exit 1; done' \
		passb0-evidence-check "$W" > /dev/null 2>&1; then
		echo no-evidence; return 0
	fi
	return 1
}

cleanup() {
	# Idempotent; keeps BASE/kit, kit.tgz and RES. Never signals a pid it cannot prove.
	local ids id lbl name r want_id basis server_gone=false fail=0
	if [ -f "$STATE/server-h.identity.json" ]; then
		if r=$(python3 -I "$KIT/b0.py" stop --identity "$STATE/server-h.identity.json"); then server_gone=true; else fail=1; fi
		echo "servidor del host: $r"
	elif ! pgrep -u "$(id -u)" -f -- "--sock $RUN/h.sock" > /dev/null; then
		server_gone=true  # never started (no identity) and no process names our socket
	else
		echo "hay un servidor sin identidad registrada: no se señala; detenelo a mano" >&2; fail=1
	fi
	ids=$(D ps -a -q --no-trunc --filter "label=$LABEL")
	want_id=$(cat "$STATE/container_id" 2> /dev/null || true)
	for id in $ids; do
		lbl=$(D inspect -f '{{index .Config.Labels "passb0.experiment"}}' "$id")
		name=$(D inspect -f '{{.Name}}' "$id")
		if [ "$lbl" != "$STAMP" ] || [ "$name" != "/$EXP" ] || [[ ! $want_id =~ ^[0-9a-f]{64}$ ]] || [ "$id" != "$want_id" ]; then
			echo "no toco ${id:0:12}: etiqueta, nombre o id distintos de state/container_id" >&2; fail=1; continue
		fi
		basis=$(removal_basis "$id") || die "el contenedor puede tener evidencia sin copia verificada: no se borra.
  Opciones: capture completa (capture.ok), o B0_DISCARD_EVIDENCE=<id completo> si decidís descartarla" 66
		python3 -I -c 'import json,sys; json.dump({"container_prefix": sys.argv[1][:12], "basis": sys.argv[2]}, open(sys.argv[3], "w"))' \
			"$id" "$basis" "$RES/removal.json"
		D rm -f -v "$id" > /dev/null
		echo "contenedor borrado: $basis"
	done
	[ -z "$(D ps -a -q --filter "label=$LABEL")" ] || { echo "queda un contenedor del experimento" >&2; fail=1; }
	if [ -f "$STATE/image_id" ]; then
		[ "$(D image inspect "$IMAGE" --format '{{.Id}}')" = "$(image_id)" ] || { echo "la imagen cambió" >&2; fail=1; }
	fi
	if [ -d "$RUN" ]; then
		if [ -e "$RUN/held-h.json" ]; then
			if [ -f "$RES/held-h.json" ] && cmp -s "$RUN/held-h.json" "$RES/held-h.json"; then rm -f "$RUN/held-h.json"
			else echo "held-h.json sin copia en RES: no se borra" >&2; fail=1; fi
		fi
		if [ -S "$RUN/h.sock" ]; then
			if [ "$server_gone" = true ]; then rm -f "$RUN/h.sock"
			else echo "h.sock sigue y el servidor no está probadamente detenido" >&2; fail=1; fi
		fi
		rmdir "$RUN" 2> /dev/null || { echo "run/ no quedó vacío" >&2; fail=1; }
	fi
	python3 -I -c 'import json,sys; json.dump({"clean": sys.argv[1] == "0"}, open(sys.argv[2], "w"))' "$fail" "$RES/cleanup.json"
	[ "$fail" -eq 0 ] || die "limpieza incompleta: ver mensajes; RES intacto" 67
	ok
}

case $PHASE in
	preflight | setup | servers | measure | capture | validate | cleanup) "$PHASE" ;;
	*) die "fase desconocida: $PHASE" 64 ;;
esac

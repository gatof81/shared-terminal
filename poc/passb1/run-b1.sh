#!/usr/bin/env bash
# PASS-B1 runner for VM100 (04-poc.md §1.14.15). One phase per call:
#
#   bash run-b1.sh BASE preflight|setup|measure|capture|validate|cleanup
#
# BASE/env says which experiment (KIND=b1a or KIND=b1b); each has its own folder, STAMP,
# container and verdict. Fail-closed exactly as run-b0.sh (§1.14.9):
# - `set -euo pipefail` for the whole script, never inside a `&&`/`||` list;
# - "OK: <phase>" is the last line of a successful phase, printed by the script;
# - a phase writes BASE/state/<phase>.ok only on success, and refuses to start without the
#   marker of the phase before it. capture and cleanup also run after a partial failure.
# The experiment container is evidence. cleanup removes it only on a recorded ground, against
# the exact id in state/container_id:
#   captured            capture.ok exists and RES still verifies against SHA256SUMS
#   no-evidence         an exec in the container proves the output dirs hold no file
#   discard-authorized  the operator set B1_DISCARD_EVIDENCE=<full id of that container>
# Anything else stops with exit 66 and touches nothing; a mismatched container exits 67.
set -euo pipefail
umask 077

die() { echo "FALLÓ: $*" >&2; exit "${2:-1}"; }
[ $# -eq 2 ] || die "uso: run-b1.sh BASE fase" 64
BASE=$1 PHASE=$2
[ -f "$BASE/env" ] || die "falta $BASE/env (paso 0)" 64

# Strict KEY=VALUE reader: the env file is data, never sourced.
declare -A E
while IFS='=' read -r k v; do
	[[ $k =~ ^[A-Z_][A-Z0-9_]*$ ]] || die "env: clave inválida" 64
	[[ $v =~ ^[A-Za-z0-9_./:@+-]*$ ]] || die "env: valor inválido para $k" 64
	E[$k]=$v
done < "$BASE/env"
for k in KIND STAMP KIT RES EXP IMAGE COMMIT; do [ -n "${E[$k]:-}" ] || die "env: falta $k" 64; done
KIND=${E[KIND]} STAMP=${E[STAMP]} KIT=${E[KIT]} RES=${E[RES]} EXP=${E[EXP]} IMAGE=${E[IMAGE]}
[[ $KIND == b1a || $KIND == b1b ]] || die "env: KIND debe ser b1a o b1b" 64
RUN2=${E[RUN2]:-0}
case $RUN2 in 0|1) ;; *) die "env: RUN2 inválido (sólo 0 o 1)" 64 ;; esac
if [ "$RUN2" = 1 ]; then
	[ "$KIND" = b1a ] || die "env: RUN2=1 sólo con KIND=b1a" 64
	[[ $EXP == "pass$KIND-run2-exp-$STAMP" ]] || die "env: EXP (run2) no corresponde a KIND y STAMP" 64
	for k in RUN1_ID RUN1_EXP; do [ -n "${E[$k]:-}" ] || die "env: RUN2=1 requiere $k (el contenedor retenido de la corrida 1)" 64; done
	RUN1_ID=${E[RUN1_ID]} RUN1_EXP=${E[RUN1_EXP]}
	[[ $RUN1_ID =~ ^[0-9a-f]{64}$ ]] || die "env: RUN1_ID no es un id completo" 64
	[ "$RUN1_EXP" != "$EXP" ] || die "env: RUN1_EXP no puede ser el EXP de la corrida 2" 64
else
	[[ $EXP == "pass$KIND-exp-$STAMP" ]] || die "env: EXP no corresponde a KIND y STAMP" 64
fi
if [ "$KIND" = b1a ]; then
	for k in MAN MKT; do [ -n "${E[$k]:-}" ] || die "env: falta $k" 64; done
	MAN=${E[MAN]} MKT=${E[MKT]}
fi
STATE=$BASE/state
mkdir -p "$STATE"
LABEL="passb1.experiment=$STAMP"
RUNTAG=$([ "$RUN2" = 1 ] && echo 2 || echo 1)
WANT_CLI=2.1.314
# The released 2.1.314 binary (04-poc.md §1.14.14.1); B1b installs exactly this file.
WANT_SHA=4487042b4c4f5d88d4568f68ae98aae0b1ffae58864cf57fb868641bc5f84594
HND=/opt/st-hnd/claude-2.1.314
W=/home/developer/b1
OUT=/tmp/passb1/out
D() { if [ "${B1_DOCKER_SUDO:-0}" = 1 ]; then sudo -n docker "$@"; else docker "$@"; fi; }
X() { D exec -u developer "$EXP" "$@"; }
B1() { X python3 -I /opt/passb1-kit/b1.py "$@"; }
need() { [ -f "$STATE/$1" ] || die "falta la marca $1: corré antes la fase anterior" 65; }
ok() { : > "$STATE/$PHASE.ok"; echo "OK: $PHASE"; }
image_id() { cat "$STATE/image_id"; }
json() { python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))'"$1"')' "$2"; }
cli_version_to() {
	local out v
	out=$(X claude --version) || return 2
	v=$(awk 'NR == 1 {print $1}' <<< "$out")
	python3 -I -c 'import json,sys; json.dump({"version": sys.argv[1], "expected": sys.argv[2], "match": sys.argv[1] == sys.argv[2]}, open(sys.argv[3], "w"))' \
		"$v" "$WANT_CLI" "$1" || return 3
	[ "$v" = "$WANT_CLI" ] || return 1
}

preflight() {
	# Read-only: nothing is created or changed outside BASE.
	local kv yama sd cp id hist ver
	kv=$(uname -r)
	yama=$(cat /proc/sys/kernel/yama/ptrace_scope)
	[ "$yama" = 1 ] || die "ptrace_scope=$yama (se exige 1)"
	sd=$(cat /proc/sys/fs/suid_dumpable)
	cp=$(head -c 1 /proc/sys/kernel/core_pattern)
	if D info --format '{{json .SecurityOptions}}' | grep -q userns; then die "Docker con userns-remap"; fi
	id=$(D image inspect "$IMAGE" --format '{{.Id}}')
	[[ $id =~ ^sha256:[0-9a-f]{64}$ ]] || die "id de imagen inesperado"
	hist=$(D image history --no-trunc --format '{{.CreatedBy}}' "$id")
	ver=$(python3 -I "$KIT/b1.py" imageversion <<<"$hist" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"] or "")') || true
	if [ "$ver" != "$WANT_CLI" ]; then
		echo "STOP: la imagen trae Claude Code '${ver:-desconocida}', no $WANT_CLI. No se crea nada." >&2
		exit 3
	fi
	local existing other
	existing=$(D ps -a -q --no-trunc --filter label=passb1.experiment)
	if [ "$RUN2" = 1 ]; then
		# Exactly the retained run-1 container may coexist, matched by id AND name AND label.
		for other in $existing; do
			if [ "$other" != "$RUN1_ID" ]; then
				die "hay un contenedor passb1 que no es la corrida 1 retenida (${other:0:12}): no se toca nada" 1
			fi
			[ "$(D inspect -f '{{.Name}}' "$other")" = "/$RUN1_EXP" ] \
				|| die "el contenedor retenido no tiene el nombre esperado $RUN1_EXP" 1
			[ "$(D inspect -f '{{index .Config.Labels "passb1.experiment"}}' "$other")" != "" ] \
				|| die "el contenedor retenido no tiene la etiqueta passb1.experiment" 1
		done
	else
		[ -z "$existing" ] || die "ya hay contenedores passb1: limpiarlos primero"
	fi
	[ -z "$(D ps -a -q --filter label=passb0.experiment)" ] || die "hay contenedores passb0: limpiarlos primero"
	[ -z "$(D ps -a -q --filter "name=^/$EXP\$")" ] || die "el nombre $EXP está ocupado"
	if [ "$KIND" = b1a ]; then
		# The mounted policy and marketplace must be byte for byte the kit's.
		cmp -s "$MAN/b1a.json" "$KIT/managed/b1a.json" || die "MAN/b1a.json no es el del kit"
		[ "$(cd "$MAN" && find . -type f | sort)" = "./b1a.json" ] || die "MAN tiene otros archivos"
		diff -r -q "$MKT" "$KIT/marketplace" > /dev/null || die "MKT no es el marketplace del kit"
	fi
	echo "$id" > "$STATE/image_id"
	python3 -I -c 'import json,sys; json.dump({"kind":sys.argv[1],"kernel":sys.argv[2],"ptrace_scope":sys.argv[3],"suid_dumpable":sys.argv[4],"core_pattern_is_pipe":sys.argv[5]=="|","image_id_prefix":sys.argv[6][7:19],"cli_version":sys.argv[7]}, open(sys.argv[8],"w"))' \
		"$KIND" "$kv" "$yama" "$sd" "$cp" "$id" "$ver" "$RES/preflight.json"
	ok
}

setup() {
	need preflight.ok
	local id mounts net
	id=$(image_id)
	mounts=(--mount "type=bind,src=$KIT,dst=/opt/passb1-kit,readonly")
	if [ "$KIND" = b1a ]; then
		mounts+=(--mount "type=bind,src=$MAN,dst=/etc/claude-code/managed-settings.d,readonly"
			--mount "type=bind,src=$MKT,dst=/opt/st-b1/marketplace,readonly")
	fi
	# No external network for either experiment: no CLI update can be downloaded, no rogue
	# marketplace can be cloned. N4 serves its zip on the container's own loopback, which is
	# present under `none`, and disableSideloadFlags refuses --plugin-url before any fetch.
	net=none
	D run -d --name "$EXP" --label "$LABEL" --label "passb1.kind=$KIND" --label "passb1.run=$RUNTAG" --init --entrypoint /usr/bin/sleep \
		--user developer --workdir /home/developer --cap-drop ALL --security-opt no-new-privileges:true \
		--pids-limit 256 --memory 2g --memory-swap 2g --cpus 1 --network "$net" --restart no \
		"${mounts[@]}" "$id" 7200 > "$STATE/container_id"
	[[ $(cat "$STATE/container_id") =~ ^[0-9a-f]{64}$ ]] || die "docker run no devolvió un id de contenedor"
	[ "$(D inspect -f '{{.Id}}' "$EXP")" = "$(cat "$STATE/container_id")" ] || die "el nombre $EXP no apunta al contenedor creado"
	[ "$(D inspect -f '{{index .Config.Labels "passb1.run"}}' "$EXP")" = "$RUNTAG" ] || die "la etiqueta passb1.run=$RUNTAG no se aplicó"
	D inspect "$EXP" > "$STATE/inspect.json"
	if [ "$KIND" = b1a ]; then
		python3 -I "$KIT/b1.py" checklimits "$STATE/inspect.json" "$STAMP" "$KIT" "$KIT:/opt/passb1-kit" \
			"$MAN:/etc/claude-code/managed-settings.d" "$MKT:/opt/st-b1/marketplace" || die "el contenedor no es el pedido"
	else
		python3 -I "$KIT/b1.py" checklimits "$STATE/inspect.json" "$STAMP" "$KIT" "$KIT:/opt/passb1-kit" || die "el contenedor no es el pedido"
	fi
	cli_version_to "$RES/cli-version-before.json" || die "dentro del contenedor la versión no es $WANT_CLI"
	[ "$(X id -u)" = 1000 ] || die "uid distinto de 1000"
	X mkdir -p "$W" "$OUT"
	if [ "$KIND" = b1a ]; then
		B1 applied --managed /etc/claude-code/managed-settings.d --market /opt/st-b1/marketplace --out "$OUT/applied.json" > /dev/null
	else
		setup_hnd
	fi
	ok
}

setup_hnd() {
	# The root copy, made inside this container only: root here has no capability
	# (--cap-drop ALL, no-new-privileges), so a step that needs one fails and the run is
	# INCONCLUSIVE; nothing is relaxed to make it work (§1.14.15).
	local src
	src=$(X sh -c 'readlink -f "$(command -v claude)"')
	[[ $src =~ ^/[A-Za-z0-9_./@-]+$ ]] || die "ruta del CLI inesperada"
	if ! D exec -u 0 "$EXP" sh -c 'install -d -o 0 -g 0 -m 0755 /opt/st-hnd && install -o 0 -g 0 -m 0711 "$1" "$2"' st-hnd "$src" "$HND" \
		> "$STATE/hnd-install.err" 2>&1; then
		python3 -I -c 'import json,sys; json.dump({"installed": False}, open(sys.argv[1], "w"))' "$STATE/hnd-setup.json"
		die "no se pudo preparar la copia de root (ver state/hnd-install.err): B1b queda INCONCLUSIVE"
	fi
	D exec -u 0 "$EXP" sh -c 'sha256sum "$1" | cut -d" " -f1; stat -c "%u %g %a %s" "$1"' st-hnd "$HND" > "$STATE/hnd-file.txt"
	python3 -I - "$STATE/hnd-file.txt" "$WANT_SHA" "$STATE/hnd-setup.json" <<-'PY'
	import json, sys
	sha, meta = open(sys.argv[1]).read().split("\n")[:2]
	uid, gid, mode, size = meta.split()[:4]
	json.dump({"installed": True, "sha256_ok": sha == sys.argv[2], "uid": int(uid), "gid": int(gid), "mode": mode, "size": int(size)}, open(sys.argv[3], "w"))
	PY
	X mkdir -p "$OUT/hnd"
	D cp "$STATE/hnd-setup.json" "$EXP:$OUT/hnd/setup.json"
	python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d["sha256_ok"] and d["uid"]==0 and d["mode"]=="711" else 1)' "$STATE/hnd-setup.json" \
		|| die "la copia de root no es la esperada (hash, dueño o modo): B1b queda INCONCLUSIVE"
}

measure() {
	need setup.ok
	if [ "$KIND" = b1a ]; then measure_b1a; else measure_b1b; fi
	ok
}

measure_b1a() {
	# Sequential: one fresh CLI start per attempt; a failed attempt is recorded, not fatal.
	local cli id
	cli=$(X sh -c 'command -v claude')
	local ids
	if [ "$RUN2" = 1 ]; then
		ids="P0 N14 N17-project"           # focused run 2: control + the two cases that need it
	else
		ids="P0 N1 N2 N3 N4 N5a N5b N6 N7a N7b N8 N9 N12 N14 N16 N17-user N17-project N18 N19"
	fi
	for id in $ids; do
		# The previous attempt's tmux session is gone; its CLI may need a moment to exit.
		X sh -c 'for i in $(seq 1 20); do pgrep -u developer -f "^[^ ]*claude( |$)" > /dev/null || exit 0; sleep 0.5; done; exit 1' \
			|| die "quedó un CLI de un intento anterior"
		if ! B1 attempt --id "$id" --root "$W" --cli "$cli" > /dev/null 2> "$STATE/attempt-$id.err"; then
			echo "AVISO: el intento $id falló en el harness; el analizador lo dará INCONCLUSIVE" >&2
		fi
	done
}

# Starts the CLI at path $2 in tmux session $1, with the B1a probe from the kit as
# --plugin-dir (B1b has no managed settings), and prints the pane's pid: the CLI itself,
# since tmux execs the command.
start_cli() {
	X sh -c 'set -e; s=$1; cli=$2; h=/home/developer/b1/home-$s; mkdir -p "$h" /home/developer/b1/ws-$s
		python3 -I /opt/passb1-kit/b1.py seed --home "$h" > /dev/null
		tmux -L passb1 new-session -d -s "$s" -x 200 -y 50 -c /home/developer/b1/ws-$s \
			env -i PATH=/usr/bin:/bin HOME="$h" TERM=xterm-256color DISABLE_AUTOUPDATER=1 \
			"$cli" --plugin-dir /opt/passb1-kit/marketplace/plugins/st-b1-probe --debug-file /home/developer/b1/debug-$s.log
		for i in $(seq 1 60); do
			if tmux -L passb1 capture-pane -p -t "$s" | grep -q "Yes, I trust this folder"; then
				tmux -L passb1 send-keys -t "$s" Down; sleep 0.5; tmux -L passb1 send-keys -t "$s" Enter; sleep 2
			elif ls /home/developer/b1/ws-$s/.passb1/out/probe/*.json > /dev/null 2>&1; then break; fi
			sleep 0.5; done
		! tmux -L passb1 capture-pane -p -t "$s" | grep -q "Yes, I trust this folder" || exit 9
		tmux -L passb1 display -p -t "$s" "#{pane_pid}"' st-start "$1" "$2"
}

measure_b1b() {
	local src p c i
	src=$(X sh -c 'readlink -f "$(command -v claude)"')
	B1 sysinfo --out "$OUT/hnd/sysinfo.json" > /dev/null
	B1 immut --path "$HND" --out "$OUT/hnd/immut.json" > /dev/null
	B1 inventory --size "$(json '["size"]' "$STATE/hnd-setup.json")" --sha256 "$WANT_SHA" --out "$OUT/hnd/inventory.json" > /dev/null
	# H1: it starts from the root copy, and the mod engine works under it.
	if X "$HND" --version > "$STATE/hnd-version.txt" 2> "$STATE/hnd-version.err"; then :; else :; fi
	python3 -I -c 'import json,sys; t=open(sys.argv[1]).read().split(); json.dump({"version": t[0] if t else None}, open(sys.argv[2],"w"))' \
		"$STATE/hnd-version.txt" "$STATE/hnd-version.json"
	D cp "$STATE/hnd-version.json" "$EXP:$OUT/hnd/version.json"
	# Positive control first: the same CLI from the readable copy. Without it nothing is judged.
	c=$(start_cli ctl "$src") || die "el CLI de control no arrancó"
	[[ $c =~ ^[0-9]+$ ]] || die "no se obtuvo el pid del CLI de control"
	# The root copy may fail to start: that is H1's evidence, not a harness error.
	p=$(start_cli hnd "$HND") || p=
	[[ $p =~ ^[0-9]+$ ]] || { echo "AVISO: la copia de root no arrancó (H1)" >&2; p=; }
	sleep "${B1B_SETTLE_S:-10}"
	B1 hnd-stat --pid "$c" --out "$OUT/hnd/stat-ctl-t0.json" > /dev/null
	[ -z "$p" ] || B1 hnd-stat --pid "$p" --out "$OUT/hnd/stat-hnd-t0.json" > /dev/null
	# H4/H4b: as an ancestor (plain, and tracing from before the exec), for both copies.
	X sh -c 'tmux -L passb1 new-session -d -s anc-hnd "python3 -I /opt/passb1-kit/b1.py ancestor --observe-s 10 --out /tmp/passb1/out/hnd/anc-hnd -- $1"' st-anc "$HND"
	X sh -c 'tmux -L passb1 new-session -d -s anc-ctl "python3 -I /opt/passb1-kit/b1.py ancestor --observe-s 10 --out /tmp/passb1/out/hnd/anc-ctl -- $1"' st-anc "$src"
	for i in $(seq 1 "${B1B_ANC_WAIT_S:-60}"); do
		if X test -f "$OUT/hnd/anc-hnd/ancestor.json" && X test -f "$OUT/hnd/anc-ctl/ancestor.json"; then break; fi
		sleep 1
	done
	# H7: an update attempt from the root copy (no network), then the same process later.
	X sh -c '"$1" update > /dev/null 2>&1; echo $?' st-upd "$HND" > "$STATE/hnd-update-rc.txt" || true
	sleep "${B1B_OBSERVE_S:-300}"
	[ -z "$p" ] || B1 hnd-stat --pid "$p" --out "$OUT/hnd/stat-hnd-t1.json" > /dev/null
	D exec -u 0 "$EXP" sh -c 'sha256sum "$1" | cut -d" " -f1; stat -c "%u %g %a %s %i" "$1"' st-hnd "$HND" > "$STATE/hnd-file-after.txt"
	python3 -I - "$STATE/hnd-file.txt" "$STATE/hnd-file-after.txt" "$STATE/hnd-update-rc.txt" "$STATE/hnd-after.json" <<-'PY'
	import json, sys
	a, b = (open(p).read().split("\n")[:2] for p in sys.argv[1:3])
	rc = open(sys.argv[3]).read().strip()
	json.dump({"sha256_unchanged": a[0] == b[0], "owner_mode_unchanged": a[1].split()[:3] == b[1].split()[:3], "update_rc": rc}, open(sys.argv[4], "w"))
	PY
	D cp "$STATE/hnd-after.json" "$EXP:$OUT/hnd/after.json"
	X sh -c 'tmux -L passb1 kill-server 2> /dev/null || true'
}

capture() {
	need preflight.ok
	rm -f "$STATE/capture.ok"
	: > "$STATE/capture.attempted"
	local items=() st
	item() {
		local name=$1; shift
		if "$@" 2> "$STATE/capture-$name.err"; then items+=("$name=ok"); else items+=("$name=failed:$?"); fi
	}
	filter_b1a() {
		# Only the lines that speak of plugins, hooks, MCP, policy or our fixtures leave the
		# container; the raw debug logs stay in it.
		X sh -c 'set -e; pat="st-b1|sec-default|hooks module|hooks modules|plugin\.register|Read hooks\.json|[Pp]lugin|[Mm]arketplace|disableSideloadFlags|allowManaged|strictKnown|blockedMarket|organization|seated|skills-dir|seed|MCP|mcp|[Hh]ook|[Ss]ettings|policy"
			for a in /home/developer/b1/*/; do id=$(basename "$a"); d=/tmp/passb1/out/attempts/$id; mkdir -p "$d"
				[ ! -f "$a/result.json" ] || cp "$a/result.json" "$d/"
				for f in debug.log debug-1.log debug-2.log stderr.txt stderr-1.txt stderr-2.txt pre-marketplace-add.txt pre-plugin-install.txt pre-mcp-add.txt; do
					[ ! -f "$a/$f" ] || { grep -E "$pat" "$a/$f" > "$d/$f.filtered" || true; }; done
				[ ! -d "$a/ws/.passb1/out/probe" ] || cp -r "$a/ws/.passb1/out/probe" "$d/"
			done'
	}
	filter_b1b() {
		X sh -c 'for s in hnd ctl; do f=/home/developer/b1/debug-$s.log; [ ! -f "$f" ] || grep -E "st-b1-probe|hooks module" "$f" > /tmp/passb1/out/hnd/debug-$s.filtered || true
			p=/home/developer/b1/ws-$s/.passb1/out/probe; [ ! -d "$p" ] || cp -r "$p" /tmp/passb1/out/hnd/probe-$s; done'
	}
	if [ "$KIND" = b1a ]; then item attempts filter_b1a; else item hnd filter_b1b; fi
	item container-out D cp "$EXP:$OUT/." "$RES/"
	item cli-version-after cli_version_to "$RES/cli-version-after.json"
	python3 -I "$KIT/b1.py" manifest "$RES" "${items[@]}" > /dev/null
	(cd "$RES" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
	(cd "$RES" && sha256sum -c --quiet SHA256SUMS)
	st=$(json '["complete"]' "$RES/capture-manifest.json")
	[ "$st" = True ] || die "captura incompleta: evidencia conservada en $RES (ver capture-manifest.json)" 4
	ok
}

validate() {
	[ -f "$STATE/capture.attempted" ] || die "falta capture" 65
	local rc=0
	python3 -I "$KIT/analyze_$KIND.py" report "$RES" > "$RES/report.json" || rc=$?
	cat "$RES/report.json"
	[ "$rc" -eq 0 ] || die "veredicto distinto de PASS (salida $rc)" "$rc"
	ok
}

removal_basis() {
	local id=$1
	if [ -f "$STATE/capture.ok" ] && [ -f "$RES/SHA256SUMS" ] && (cd "$RES" && sha256sum -c --quiet SHA256SUMS > /dev/null 2>&1) \
		&& python3 -I -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get("complete") is True else 1)' "$RES/capture-manifest.json" 2> /dev/null; then
		echo captured; return 0
	fi
	if [ -n "${B1_DISCARD_EVIDENCE:-}" ]; then
		if [ "$B1_DISCARD_EVIDENCE" = "$id" ]; then echo discard-authorized; return 0; fi
		echo "B1_DISCARD_EVIDENCE no coincide con el id del contenedor: se ignora" >&2
	fi
	# Exec fails on a stopped container, so "cannot look" never counts as "nothing there".
	if X sh -c 'for d in /tmp/passb1 /home/developer/b1; do [ ! -e "$d" ] || [ -z "$(find "$d" -type f -print -quit)" ] || exit 1; done' \
		passb1-evidence-check > /dev/null 2>&1; then
		echo no-evidence; return 0
	fi
	return 1
}

cleanup() {
	local ids id lbl name want_id basis fail=0
	ids=$(D ps -a -q --no-trunc --filter "label=$LABEL")
	want_id=$(cat "$STATE/container_id" 2> /dev/null || true)
	for id in $ids; do
		lbl=$(D inspect -f '{{index .Config.Labels "passb1.experiment"}}' "$id")
		name=$(D inspect -f '{{.Name}}' "$id")
		if [ "$lbl" != "$STAMP" ] || [ "$name" != "/$EXP" ] || [[ ! $want_id =~ ^[0-9a-f]{64}$ ]] || [ "$id" != "$want_id" ]; then
			echo "no toco ${id:0:12}: etiqueta, nombre o id distintos de state/container_id" >&2; fail=1; continue
		fi
		basis=$(removal_basis "$id") || die "el contenedor puede tener evidencia sin copia verificada: no se borra.
  Opciones: capture completa (capture.ok), o B1_DISCARD_EVIDENCE=<id completo> si decidís descartarla" 66
		python3 -I -c 'import json,sys; json.dump({"container_prefix": sys.argv[1][:12], "basis": sys.argv[2]}, open(sys.argv[3], "w"))' \
			"$id" "$basis" "$RES/removal.json"
		D rm -f -v "$id" > /dev/null
		echo "contenedor borrado: $basis"
	done
	[ -z "$(D ps -a -q --filter "label=$LABEL")" ] || { echo "queda un contenedor del experimento" >&2; fail=1; }
	if [ -f "$STATE/image_id" ]; then
		[ "$(D image inspect "$IMAGE" --format '{{.Id}}')" = "$(image_id)" ] || { echo "la imagen cambió" >&2; fail=1; }
	fi
	python3 -I -c 'import json,sys; json.dump({"clean": sys.argv[1] == "0"}, open(sys.argv[2], "w"))' "$fail" "$RES/cleanup.json"
	[ "$fail" -eq 0 ] || die "limpieza incompleta: ver mensajes; RES intacto" 67
	ok
}

case $PHASE in
	preflight) preflight ;;
	setup) setup ;;
	measure) measure ;;
	capture) capture ;;
	validate) validate ;;
	cleanup) cleanup ;;
	*) die "fase desconocida: $PHASE" 64 ;;
esac

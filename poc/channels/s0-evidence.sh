#!/usr/bin/env bash
# S0 step 3: evidence that the environment is isolated and holds no existing
# credentials. Read-only; makes no Anthropic API call that needs auth. Exit
# status 0 only if every check passes. Output: out/s0-evidence-*/evidence.md
. "$(dirname "$0")/lib.sh"
load_config
out="$(run_dir s0-evidence)"
md="$out/evidence.md"
fail=0
row() { printf '| %s | %s | %s |\n' "$1" "$2" "$3" >>"$md"; [ "$2" = PASS ] || fail=1; }
ck() { # name, detail, command...
	local name="$1" detail="$2"; shift 2
	if "$@" >/dev/null 2>&1; then row "$name" PASS "$detail"; else row "$name" FAIL "$detail"; fi
}
insp() { docker inspect -f "$1" "$AGENT"; }

{
	echo "# Evidencia S0 — $(date -u +%FT%TZ)"
	echo
	echo "Host: \`$(hostname)\` · \`$(uname -srm)\` · virt=\`$(systemd-detect-virt --vm || true)\`"
	echo
	echo '## Guarda del host'
	echo '```'
} >"$md"
if "$POC_DIR/guard.sh" >>"$md" 2>&1; then guard=PASS; else guard=FAIL; fi
{ echo '```'; echo; echo '| Comprobación | Resultado | Detalle |'; echo '| --- | --- | --- |'; } >>"$md"
row "guarda del host" "$guard" "ver bloque anterior"

# ── Contenedor del agente ───────────────────────────────────────────────
mounts="$(insp '{{range .Mounts}}{{.Type}}:{{.Name}}{{.Source}}->{{.Destination}};{{end}}')"
ck "sin socket de Docker" "$mounts" bash -c "! grep -q docker.sock <<<'$mounts'"
ck "sólo volúmenes con nombre, ningún bind del host" "$mounts" bash -c "! grep -q '^bind:\|;bind:' <<<'$mounts'"
ck "sólo los volúmenes de la POC" "$mounts" bash -c "[ \"\$(grep -o 'volume:[^/]*' <<<'$mounts' | sort | tr '\n' ' ')\" = 'volume:$VOL_HOME volume:$VOL_WS ' ]"
ck "CapDrop ALL, CapAdd vacío" "$(insp '{{.HostConfig.CapDrop}} / {{.HostConfig.CapAdd}}')" \
	bash -c "[ \"\$(docker inspect -f '{{.HostConfig.CapDrop}}|{{.HostConfig.CapAdd}}' $AGENT)\" = '[ALL]|[]' ]"
ck "no privilegiado, no-new-privileges, raíz de sólo lectura" "$(insp '{{.HostConfig.Privileged}} {{.HostConfig.SecurityOpt}} ro={{.HostConfig.ReadonlyRootfs}}')" \
	bash -c "[ \"\$(docker inspect -f '{{.HostConfig.Privileged}}|{{.HostConfig.ReadonlyRootfs}}' $AGENT)\" = 'false|true' ] && docker inspect -f '{{.HostConfig.SecurityOpt}}' $AGENT | grep -q no-new-privileges"
ck "usuario no root" "$(insp '{{.Config.User}}')" bash -c "[ \"\$(docker exec $AGENT id -u)\" != 0 ]"
nets="$(insp '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}')"
ck "sólo la red interna $NET_INT" "$nets" bash -c "[ '$nets' = '$NET_INT ' ]"
ck "la red $NET_INT es internal" "$(docker network inspect -f '{{.Internal}}' "$NET_INT")" \
	bash -c "[ \"\$(docker network inspect -f '{{.Internal}}' $NET_INT)\" = true ]"
ck "volúmenes creados en esta preparación" "$(docker volume inspect -f '{{.Name}} {{.CreatedAt}}' "$VOL_HOME" "$VOL_WS" | tr '\n' ';')" true

# ── Red ─────────────────────────────────────────────────────────────────
code() { agent_sh "curl -s -m 10 -o /dev/null -w '%{http_code}' $*" 2>/dev/null || true; }
c_deny="$(code https://example.com/)"
ck "dominio fuera de la lista denegado por el proxy" "example.com → ${c_deny:-sin respuesta}" bash -c "[ '${c_deny:-000}' != 200 ]"
c_gh="$(code https://github.com/)"
ck "GitHub cerrado en fase test" "github.com → ${c_gh:-sin respuesta}" bash -c "[ '${c_gh:-000}' != 200 ] && [ '${c_gh:-000}' != 301 ]"
c_api="$(code https://api.anthropic.com/)"
ck "api.anthropic.com alcanzable por el proxy (sin autenticar)" "api.anthropic.com → ${c_api:-sin respuesta}" bash -c "[ '${c_api:-000}' != 000 ]"
c_direct="$(code --noproxy '*' https://api.anthropic.com/)"
ck "sin salida directa (sin proxy)" "directo → ${c_direct:-sin respuesta}" bash -c "[ '${c_direct:-000}' = 000 ]"
for ip in $PROD_PROBE_IPS; do
	for port in ${PROD_PROBE_PORTS:-22 443}; do
		ck "producción $ip:$port inalcanzable desde el agente" "tcp $ip:$port" \
			bash -c "! docker exec $AGENT timeout 4 bash -c '</dev/tcp/$ip/$port'"
		ck "producción $ip:$port inalcanzable desde el proxy" "tcp $ip:$port" \
			bash -c "! docker exec $PROXY timeout 4 nc -z -w 3 $ip $port"
		ck "producción $ip:$port inalcanzable desde la VM" "tcp $ip:$port" \
			bash -c "! timeout 4 bash -c '</dev/tcp/$ip/$port'"
	done
done
c_prod="$(code "http://$(set -- $PROD_PROBE_IPS; echo "$1")/")"
ck "el proxy no reenvía a producción por IP" "http://<prod> → ${c_prod:-sin respuesta}" bash -c "[ '${c_prod:-000}' != 200 ]"

# ── Credenciales ───────────────────────────────────────────────────────
ck "sin ~/.claude/.credentials.json en el agente" "" bash -c "! docker exec $AGENT test -e /home/developer/.claude/.credentials.json"
ck "sin cuenta en ~/.claude.json" "" bash -c "! docker exec $AGENT grep -q oauthAccount /home/developer/.claude.json"
ck "sin variables de credenciales en el agente" "" bash -c \
	"! docker exec $AGENT env | grep -Eq '^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_BASE_URL)='"
ck "uso extra deshabilitado en el CLI" "DISABLE_EXTRA_USAGE_COMMAND" bash -c "docker exec $AGENT env | grep -q '^DISABLE_EXTRA_USAGE_COMMAND=1'"

# ── Versiones y plugin ─────────────────────────────────────────────────
v="$(agent_exec claude --version 2>/dev/null | head -1)"
ck "CLI fijado $CLI_VERSION" "$v" bash -c "grep -q '^$CLI_VERSION' <<<'$v'"
ck "auto-update desactivado" "DISABLE_AUTOUPDATER" bash -c "docker exec $AGENT env | grep -q '^DISABLE_AUTOUPDATER=1'"
ck "managed settings: channelsEnabled y hooks a archivo" "" bash -c \
	"docker exec $AGENT python3 -c 'import json;d=json.load(open(\"/etc/claude-code/managed-settings.d/poc.json\"));assert d[\"channelsEnabled\"] is True and \"UserPromptSubmit\" in d[\"hooks\"]'"
last_plugin="$(ls -1d "$POC_DIR"/out/s0-plugin-* 2>/dev/null | tail -1)"
ck "fakechat idéntico al commit $FAKECHAT_COMMIT" "${last_plugin:-sin corrida de s0-plugin}" \
	bash -c "[ -n '$last_plugin' ] && ! grep -q FAILED '$last_plugin/manifest-check.txt' && grep -q ': OK' '$last_plugin/manifest-check.txt'"
ck "fakechat arranca sin red de instalación" "" bash -c "[ -n '$last_plugin' ] && grep -q '^200' '$last_plugin/offline-start.txt'"
{
	echo
	echo '## Versiones'
	echo
	echo "- CLI: \`$v\` · Bun: \`$(agent_exec bun --version 2>/dev/null)\`"
	echo "- Imagen base: \`$(docker image inspect -f '{{index .RepoDigests 0}}' "$NODE_IMAGE" 2>/dev/null || echo "$NODE_IMAGE")\`"
	echo "- Imagen agente: \`$(docker image inspect -f '{{.Id}}' "$IMG_AGENT")\`"
	echo "- Marketplace: \`$(cat "${last_plugin:-/dev/null}/marketplace-head.txt" 2>/dev/null | tr '\n' ' ')\`"
	echo
	echo '## Reglas de firewall'
	echo '```'
	iptables -S DOCKER-USER; iptables -S OUTPUT
	echo '```'
	echo
	echo '## Log del proxy (fase test)'
	echo '```'
	docker logs "$PROXY" 2>&1 | tail -n 60
	echo '```'
} >>"$md"

if [ "$fail" = 0 ]; then
	log "S0: TODAS las comprobaciones PASS. Evidencia: $md"
else
	log "S0: hay comprobaciones FAIL. Evidencia: $md"
	exit 1
fi

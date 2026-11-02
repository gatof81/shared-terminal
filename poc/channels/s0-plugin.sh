#!/usr/bin/env bash
# S0 step 2: install fakechat from the official marketplace, prove the
# installed files are byte-identical to the pinned commit, pre-install its
# dependencies, then close GitHub/npm in the proxy and prove the plugin starts
# offline. Installing from the official marketplace (not a local clone) keeps
# the plugin on Anthropic's approved channel allowlist; the pin is enforced by
# hash comparison instead of by fetching a commit.
. "$(dirname "$0")/lib.sh"
load_config
"$POC_DIR/guard.sh"
out="$(run_dir s0-plugin)"

log "instalando el marketplace oficial y fakechat (sin login)"
if ! agent_sh "claude plugin marketplace add anthropics/claude-plugins-official && claude plugin install fakechat@claude-plugins-official" \
	>"$out/plugin-install.log" 2>&1; then
	cat "$out/plugin-install.log" >&2
	die "la instalación del plugin falló sin login. No es un NO-GO: anotalo y, con tu autorización, se repite en S1 después del /login (fase de proxy setup sólo durante la instalación)"
fi

# The CLI may keep both a marketplace checkout and an installed copy. Every
# copy must match the pin, and every copy gets its dependencies, so whichever
# one the CLI runs is the pinned code.
mapfile -t plugin_dirs < <(agent_sh "find ~/.claude/plugins -type f -name server.ts -path '*fakechat*' -printf '%h\\n'" | sort -u)
[ "${#plugin_dirs[@]}" -gt 0 ] || die "no encuentro fakechat instalado"
printf '%s\n' "${plugin_dirs[@]}" >"$out/plugin-dirs.txt"

docker cp "$POC_DIR/fakechat/manifest.sha256" "$AGENT:/tmp/manifest.sha256"
for d in "${plugin_dirs[@]}"; do
	log "comparando $d con el commit fijado $FAKECHAT_COMMIT"
	if ! agent_sh "cd '$d' && sha256sum -c /tmp/manifest.sha256" >>"$out/manifest-check.txt" 2>&1; then
		cat "$out/manifest-check.txt" >&2
		die "los archivos instalados en $d no coinciden con el commit fijado: no se continúa"
	fi
	agent_sh "cd '$d' && bun install --frozen-lockfile --no-summary" >>"$out/bun-install.log" 2>&1 ||
		die "bun install falló en $d (ver $out/bun-install.log)"
done
agent_sh "for g in ~/.claude/plugins/marketplaces/*/.git; do echo \"\$g \$(git -C \"\$g/..\" rev-parse HEAD)\"; done 2>/dev/null || true" \
	>"$out/marketplace-head.txt"
plugin_dir="${plugin_dirs[0]}"

set_proxy_phase test

log "arranque sin red de GitHub/npm: el servidor debe levantar sin descargar nada"
agent_sh "cd '$plugin_dir' && (sleep 15 | bun run --silent start >/tmp/fc.out 2>&1 &) ; sleep 6; curl -s -o /tmp/fc.html -w '%{http_code}' http://127.0.0.1:8787/; echo; cat /tmp/fc.out; pkill -f 'bun server.ts' || true" \
	>"$out/offline-start.txt" 2>&1 || true
if grep -q '^200' "$out/offline-start.txt" && grep -q 'fakechat: http://localhost:8787' "$out/offline-start.txt"; then
	log "fakechat arranca sin red de instalación"
else
	cat "$out/offline-start.txt" >&2
	die "fakechat no arranca con el proxy en fase test: fallo del harness, no NO-GO"
fi
docker logs "$PROXY" >"$out/proxy-test-phase.log" 2>&1 || true
log "OK. Evidencia en $out. Siguiente: ./s0-evidence.sh"

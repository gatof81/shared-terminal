#!/usr/bin/env bash
# S1 step 2: relaunch the CLI with the fakechat channel and record whether the
# channel registers. A block for the subscription is a NO-GO: stop here, never
# switch to an API key.
. "$(dirname "$0")/lib.sh"
load_config
"$POC_DIR/guard.sh"
agent_exec test -s /home/developer/.claude/.credentials.json ||
	die "no hay login (el archivo de credenciales no existe). Correr s1-login.sh y hacer /login"
agent_exec tmux kill-session -t login 2>/dev/null || true
agent_exec tmux has-session -t main 2>/dev/null && die "ya hay una sesión 'main'"

agent_sh "mkdir -p $OUT_IN_AGENT && : > $OUT_IN_AGENT/claude-debug.log"
agent_exec tmux new-session -d -s main -x 200 -y 50 \
	"cd /workspace && claude --dangerously-skip-permissions --channels $CHANNEL_SPEC --debug-file $OUT_IN_AGENT/claude-debug.log"
cat <<MSG

  Adjuntate y aceptá los diálogos de primer arranque (permisos / confianza del
  directorio), sin escribir ningún mensaje:

    docker exec -it -u developer $AGENT tmux attach -t main     (salir: Ctrl-b d)

MSG
read -r -p "Pulsá Enter cuando el CLI esté en su prompt y te hayas desadjuntado... " _

out="$(run_dir s1-start)"
reg=""
for _ in $(seq 1 30); do
	agent_exec cat "$OUT_IN_AGENT/claude-debug.log" >"$out/debug-snapshot.log" 2>/dev/null || true
	if grep -q 'Channel notifications registered' "$out/debug-snapshot.log"; then reg=registered; break; fi
	if grep -Eq 'Channel notifications skipped|not currently available|not enabled for your org|not on the approved|not available on third-party' "$out/debug-snapshot.log"; then reg=skipped; break; fi
	sleep 2
done
grep -E 'Channel|channel' "$out/debug-snapshot.log" | grep -Eiv 'token|authorization|email' >"$out/channel-lines.log" || true
agent_sh "curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/" >"$out/fakechat-http.txt" 2>/dev/null || true
printf 'registration=%s\nfakechat_http=%s\n' "${reg:-unknown}" "$(cat "$out/fakechat-http.txt")" | tee "$out/registration.txt"

case "$reg" in
registered) log "canal registrado. Siguiente: ./s1-wake.sh --count 10 --min-idle 30" ;;
skipped) log "canal NO registrado (motivo en $out/channel-lines.log): NO-GO. Detener la fase 0; no cambiar de autenticación."; exit 3 ;;
*) log "sin línea de registro en 60 s: revisar $out/debug-snapshot.log; si --debug-file no escribe, es fallo del harness, no NO-GO"; exit 4 ;;
esac

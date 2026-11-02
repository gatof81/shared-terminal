#!/usr/bin/env bash
# S1 step 1: open a plain `claude` in the agent's tmux so the OWNER performs
# the official /login with their subscription. The kit never reads, copies or
# prints the resulting credentials; it only checks that the file exists.
. "$(dirname "$0")/lib.sh"
load_config
"$POC_DIR/guard.sh"
last_ev="$(ls -1d "$POC_DIR"/out/s0-evidence-* 2>/dev/null | tail -1)"
[ -n "$last_ev" ] && ! grep -q '| FAIL |' "$last_ev/evidence.md" || die "S0 no está completo y limpio (s0-evidence.sh sin FAIL) — no se hace login"

agent_exec tmux has-session -t login 2>/dev/null && die "ya hay una sesión de login abierta"
agent_exec tmux new-session -d -s login -x 200 -y 50 "cd /workspace && claude"
cat <<MSG

  Login del responsable (el agente no participa):

    docker exec -it -u developer $AGENT tmux attach -t login

  1. Completá el onboarding del CLI.
  2. /login  → elegí la cuenta de Claude (suscripción). NUNCA una API key ni Console.
  3. Confirmá en tu cuenta de Claude que el uso extra está DESACTIVADO.
  4. /exit   y salí de tmux.

  Después corré: ./s1-start.sh
MSG

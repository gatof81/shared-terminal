#!/usr/bin/env bash
# Refuses to continue unless this machine is a disposable POC VM with nothing
# of production on it. Run before every step; every script calls it.
. "$(dirname "$0")/lib.sh"
load_config

fail=0
check() { # name, command...
	local name="$1"; shift
	if "$@" >/dev/null 2>&1; then printf 'PASS  %s\n' "$name"; else printf 'FAIL  %s\n' "$name"; fail=1; fi
}
not() { ! "$@"; }

check "arquitectura x86_64" test "$(uname -m)" = x86_64
check "es una VM (systemd-detect-virt)" bash -c '[ "$(systemd-detect-virt --vm)" != none ]'
check "no es un nodo Proxmox (/etc/pve ausente)" not test -e /etc/pve
check "sin datos de Shared Terminal (/var/shared-terminal ausente)" not test -e /var/shared-terminal
check "sin contenedores st-*/st-backend" bash -c '! docker ps -a --format "{{.Names}}" | grep -Eq "^st-"'
check "sin red sessions-net" bash -c '! docker network ls --format "{{.Name}}" | grep -qx sessions-net'
for v in CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN D1_DATABASE_ID JWT_SECRET SECRETS_ENCRYPTION_KEY \
	ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_BASE_URL; do
	check "variable $v ausente en el entorno" test -z "${!v:-}"
done
check "sin credenciales de Claude del usuario del host" not test -e "$HOME/.claude/.credentials.json"
check "sin .env de backend en el directorio actual" not test -e ./backend/.env
for c in $PROD_CIDRS; do
	check "regla DOCKER-USER que descarta $c" bash -c "iptables -S DOCKER-USER 2>/dev/null | grep -q -- '-d $c .*-j DROP'"
	check "regla OUTPUT que descarta $c" bash -c "iptables -S OUTPUT 2>/dev/null | grep -q -- '-d $c .*-j DROP'"
done

[ "$fail" = 0 ] || die "la guarda falló: esta máquina no es apta para la POC"
log "guarda OK"

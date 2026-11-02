#!/usr/bin/env bash
# Run ONCE as root on a fresh Ubuntu 24.04 x86_64 VM, on hardware separate
# from the production Proxmox. Installs Docker and the firewall rules that keep
# the VM and its containers away from production addresses.
set -euo pipefail
cd "$(dirname "$0")/.."
. ./config.env
: "${PROD_CIDRS:?}"
[ "$(id -u)" = 0 ] || { echo "ejecutar como root" >&2; exit 1; }
[ ! -e /etc/pve ] || { echo "esto es un nodo Proxmox: abortado" >&2; exit 1; }

apt-get update
apt-get install -y --no-install-recommends docker.io iptables python3 curl jq
systemctl enable --now docker

apply_rules() {
	iptables -C OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null ||
		iptables -I OUTPUT 1 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
	for c in $PROD_CIDRS; do
		# Containers (Docker's own chain) and the VM itself. Replies to an SSH
		# session opened FROM production keep working through the
		# ESTABLISHED rule; new connections TO production are dropped.
		iptables -C DOCKER-USER -d "$c" -j DROP 2>/dev/null || iptables -I DOCKER-USER 1 -d "$c" -j DROP
		iptables -C OUTPUT -d "$c" -j DROP 2>/dev/null || iptables -A OUTPUT -d "$c" -j DROP
	done
}
apply_rules

# Re-apply after a reboot (Docker recreates DOCKER-USER on start).
install -m 0755 /dev/stdin /usr/local/sbin/poc-firewall <<SCRIPT
#!/usr/bin/env bash
set -euo pipefail
PROD_CIDRS="$PROD_CIDRS"
$(declare -f apply_rules)
apply_rules
SCRIPT
cat >/etc/systemd/system/poc-firewall.service <<'UNIT'
[Unit]
Description=POC firewall: drop traffic to production addresses
After=docker.service
Requires=docker.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/poc-firewall
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now poc-firewall.service
echo "provision OK: Docker instalado y reglas aplicadas para: $PROD_CIDRS"

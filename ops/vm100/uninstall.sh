#!/bin/bash
# uninstall.sh — removes st-ops access at once (sshd file first: no new login from that moment). Keeps
# /var/lib/st-ops (requests, results, audit evidence) unless --purge.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo "run as root"; exit 1; }
rm -f /etc/ssh/sshd_config.d/60-st-ops.conf
sshd -t && systemctl reload ssh
rm -f /etc/sudoers.d/st-ops
pkill -u st-ops 2>/dev/null || true
userdel st-ops 2>/dev/null || true
rm -rf /usr/local/lib/st-ops /etc/st-ops
[[ ${1:-} == --purge ]] && rm -rf /var/lib/st-ops
echo "st-ops removed"

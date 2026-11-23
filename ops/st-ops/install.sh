#!/bin/bash
# install.sh — installs st-ops on VM100. Run by the OWNER, as root, from a reviewed checkout of main:
#   sudo bash ops/st-ops/install.sh
# Idempotent. It grants NOTHING: authorized_keys and identities are created empty and never overwritten, and a new
# st-ops.conf has WRITE_VERBS=off (stage 1: only the verbs that change nothing).
# Granting a key and enabling the write verbs are the owner's separate steps in README.md.
set -euo pipefail
umask 022
[[ $(id -u) == 0 ]] || { echo "run as root"; exit 1; }
[[ ! -f /.dockerenv ]] || { echo "this is a container, not VM100"; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)

# The account: no password, no docker group, no sudo beyond the one sudoers line. The shell must exist for sshd
# to run the ForceCommand; it never gets an interactive session (PermitTTY no + ForceCommand).
if ! id st-ops >/dev/null 2>&1; then
	useradd --system --home-dir /nonexistent --no-create-home --shell /bin/sh st-ops
fi
passwd -l st-ops >/dev/null
if id -nG st-ops | tr ' ' '\n' | grep -xE 'docker|sudo|adm' >/dev/null; then
	echo "STOP: st-ops is in a privileged group"; exit 1
fi

install -d -o root -g root -m 0755 /usr/local/lib/st-ops /etc/st-ops
install -d -o root -g root -m 0700 /var/lib/st-ops
install -o root -g root -m 0755 "$here/bin/st-ops-dispatch" "$here/bin/st-ops-root" /usr/local/lib/st-ops/
install -o root -g root -m 0644 "$here/lib/st-ops-lib.sh" /usr/local/lib/st-ops/
[[ -f /etc/st-ops/st-ops.conf ]] || install -o root -g root -m 0644 "$here/etc/st-ops/st-ops.conf.example" /etc/st-ops/st-ops.conf
for f in authorized_keys identities; do
	[[ -f /etc/st-ops/$f ]] || install -o root -g root -m 0644 /dev/null "/etc/st-ops/$f"
done

# sudoers: validated before it is moved into place (a broken sudoers file locks sudo out for everyone).
tmp=$(mktemp)
cp "$here/etc/sudoers.d/st-ops" "$tmp"
visudo -cf "$tmp" >/dev/null
install -o root -g root -m 0440 "$tmp" /etc/sudoers.d/st-ops
rm -f "$tmp"

# sshd: validated with the new file in place, rolled back if the full config does not parse.
install -o root -g root -m 0644 "$here/etc/sshd_config.d/60-st-ops.conf" /etc/ssh/sshd_config.d/60-st-ops.conf
if ! sshd -t; then
	rm -f /etc/ssh/sshd_config.d/60-st-ops.conf
	echo "STOP: sshd -t failed; the st-ops sshd file was removed again"; exit 1
fi
systemctl reload ssh

echo "installed. Keys granted: $(grep -cvE '^\s*(#|$)' /etc/st-ops/authorized_keys || true)"
echo "write verbs: $(grep -E '^(WRITE|SIGNED)_VERBS=' /etc/st-ops/st-ops.conf || echo '?')"
# The signature approval's file (before 2026-11-23) is no longer read; it is left for the owner to remove.
[[ ! -e /etc/st-ops/allowed_signers ]] || echo "NOTE: /etc/st-ops/allowed_signers is no longer used (chat approval): remove it when convenient."

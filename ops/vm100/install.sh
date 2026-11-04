#!/bin/bash
# install.sh — installs st-ops on VM100. Run by the OWNER, as root, from a reviewed checkout of main:
#   sudo bash ops/vm100/install.sh
# Idempotent. It grants NOTHING: authorized_keys and identities are created empty, allowed_signers must be
# filled by the owner with their own personal public key. Granting B access is the separate step in README.md.
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
install -o root -g root -m 0755 "$here/bin/st-ops-dispatch" "$here/bin/st-ops-root" "$here/bin/st-ops-deploy-run" /usr/local/lib/st-ops/
install -o root -g root -m 0644 "$here/lib/st-ops-lib.sh" "$here/lib/st-ops-deploy.sh" /usr/local/lib/st-ops/
[[ -f /etc/st-ops/deploy.conf ]] || install -o root -g root -m 0644 "$here/etc/st-ops/deploy.conf.example" /etc/st-ops/deploy.conf
for f in authorized_keys identities allowed_signers; do
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
[[ -s /etc/st-ops/allowed_signers ]] || echo "NOTE: /etc/st-ops/allowed_signers is empty — no deploy can be approved until the owner adds their key."

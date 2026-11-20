#!/bin/bash
# Tests for ops/st-ops/owner/st-sign with a throwaway key and real ssh-keygen. No network.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SIGN="$HERE/../owner/st-sign"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
PASS=0 FAIL=0
ok() { PASS=$((PASS + 1)); echo "ok   $1"; }
ko() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }

ssh-keygen -q -t ed25519 -N '' -f "$T/key" -C test
export ST_SIGN_KEY="$T/key"

req() { # $1 = file, $2 = expires-epoch, $3 = first line
	printf '%s\nid: 20261120T000000Z-0000000000ab\nrequested-by: qa\nrelease: r99\nfrom: %s\ntarget: %s\nkit-head: %s\ncompare: https://example.invalid/compare\nrelease-conf:\n  RELEASE=99\nexpires: soon\nexpires-epoch: %s\n' \
		"$3" "$(printf 'a%.0s' {1..40})" "$(printf 'b%.0s' {1..40})" "$(printf 'c%.0s' {1..40})" "$2" >"$1"
}
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
FUT=$(($(date +%s) + 3600))

# run <name> <expected rc> <stdin> <args...>: output in $T/out
run() {
	local name=$1 want=$2 in=$3 rc
	shift 3
	printf '%s\n' "$in" | "$SIGN" "$@" >"$T/out" 2>&1
	rc=$?
	if [ "$rc" = "$want" ]; then ok "$name (rc $rc)"; else ko "$name: rc $rc, want $want"; sed 's/^/     /' "$T/out"; fi
}
has() { if grep -qF -- "$2" "$T/out"; then ok "$1"; else ko "$1: missing [$2]"; fi; }

R="$T/request.txt"
req "$R" "$FUT" "st-ops kit request v1"

run "usage" 1 "" "$R"
has "usage text" "uso: st-sign"
run "bad sha format" 1 "" "$R" nothex
run "sha mismatch refuses" 1 firmar "$R" "$(printf '0%.0s' {1..64})"
has "mismatch says why" "NO coincide"
if [ ! -e "$R.sig" ]; then ok "no sig after mismatch"; else ko "sig written after mismatch"; fi

run "no confirmation refuses" 1 no "$R" "$(sha "$R")"
has "shows the full request" "release-conf:"
has "shows release data" "RELEASE=99"
has "shows compare" "https://example.invalid/compare"
if [ ! -e "$R.sig" ]; then ok "no sig without confirmation"; else ko "sig written without confirmation"; fi

run "sign" 0 firmar "$R" "$(sha "$R" | tr a-f A-F)"
has "reports verified" "firmado y verificado"
echo "owner namespaces=\"st-ops-deploy@shared-terminal\" $(cut -d' ' -f1,2 "$T/key.pub")" >"$T/as"
if ssh-keygen -Y verify -f "$T/as" -I owner -n st-ops-deploy@shared-terminal -s "$R.sig" <"$R" >/dev/null 2>&1; then
	ok "signature verifies as st-ops does"
else ko "signature does not verify"; fi

run "existing sig refuses" 1 firmar "$R" "$(sha "$R")"

E="$T/expired.txt"
req "$E" 1000 "st-ops kit request v1"
run "expired refuses" 1 firmar "$E" "$(sha "$E")"
has "expired says why" "venció"

W="$T/wrong.txt"
req "$W" "$FUT" "something else"
run "wrong first line refuses" 1 firmar "$W" "$(sha "$W")"

C="$T/ctrl.txt"
req "$C" "$FUT" "st-ops kit request v1"
printf 'note: x\033[2Ky\n' >>"$C"
run "control byte shown" 1 no "$C" "$(sha "$C")"
has "control byte made visible" "x^[[2Ky"

echo "st-sign: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]

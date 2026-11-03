#!/bin/bash
# ops/vm100/test/run.sh — unit tests for st-ops, no root, no Docker, no network. `bash ops/vm100/test/run.sh`
# Real ssh-keygen signatures and real git repositories; GitHub, systemd and logger are stubbed.
set -uo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
pass=0 fail=0
ok() { pass=$((pass + 1)); }
ko() { fail=$((fail + 1)); echo "FAIL: $*"; }
expect_rc() { # $1 = expected rc, $2 = label, rest = command
	local want=$1 label=$2 got
	shift 2
	"$@" >"$T/out" 2>&1
	got=$?
	[[ $got == "$want" ]] && ok || ko "$label (rc $got, want $want): $(head -c 300 "$T/out")"
}
expect_out() { # $1 = regex, $2 = label
	grep -qE -- "$1" "$T/out" && ok || ko "$2: output lacks /$1/: $(head -c 300 "$T/out")"
}

# ── Keys ──
# ssh-keygen -Y sign asks before overwriting a .sig: always sign into a fresh file.
sign() { rm -f "$3.sig"; ssh-keygen -q -Y sign -f "$1" -n "$2" "$3" 2>/dev/null </dev/null; }
ssh-keygen -q -t ed25519 -N '' -C owner -f "$T/owner"
ssh-keygen -q -t ed25519 -N '' -C other -f "$T/other"
ssh-keygen -q -t ed25519 -N '' -C b -f "$T/bkey"
fp_b=$(ssh-keygen -lf "$T/bkey.pub" | awk '{print $2}')

# ── Dispatcher ──
mkdir -p "$T/fakebin"
cat >"$T/fakebin/sudo" <<'EOF'
#!/bin/bash
printf 'ARGV:'; printf ' [%s]' "$@"; echo
EOF
chmod +x "$T/fakebin/sudo"
echo "publickey $(cut -d' ' -f1,2 "$T/bkey.pub")" >"$T/auth"
disp() { SSH_USER_AUTH="$T/auth" SSH_ORIGINAL_COMMAND="$1" PATH="$T/fakebin:$PATH" bash "$here/bin/st-ops-dispatch"; }
expect_rc 0 "dispatch status" disp "status"
expect_out "^ARGV: \[-n\] \[/usr/local/lib/st-ops/st-ops-root\] \[$fp_b\] \[status\]$" "dispatch passes fingerprint + words"
expect_rc 0 "dispatch empty command = help" disp ""
expect_out "\[help\]" "empty is help"
for bad in 'status; id' 'status $(id)' 'status `id`' 'logs |cat' 'a b c d e' "status 'x'" 'status >/tmp/x' "$(printf 'x%.0s' {1..201})"; do
	expect_rc 2 "dispatch refuses: ${bad:0:30}" disp "$bad"
done
SSH_ORIGINAL_COMMAND=status PATH="$T/fakebin:$PATH" bash "$here/bin/st-ops-dispatch" >"$T/out" 2>&1
[[ $? == 2 ]] && ok || ko "dispatch without SSH_USER_AUTH must refuse"
echo "password" >"$T/auth-pw"
SSH_USER_AUTH="$T/auth-pw" SSH_ORIGINAL_COMMAND=status PATH="$T/fakebin:$PATH" bash "$here/bin/st-ops-dispatch" >"$T/out" 2>&1
[[ $? == 2 ]] && ok || ko "dispatch with a non-publickey login must refuse"

# ── Library fixture ──
export ST_OPS_ETC="$T/etc" ST_OPS_STATE="$T/state" ST_OPS_LIB="$here/lib"
mkdir -p "$ST_OPS_ETC" "$ST_OPS_STATE"
echo "owner namespaces=\"st-ops-deploy@shared-terminal\" $(cut -d' ' -f1,2 "$T/owner.pub")" >"$ST_OPS_ETC/allowed_signers"
echo "b-0665fa5a $fp_b" >"$ST_OPS_ETC/identities"

# Upstream repo (stands in for GitHub) and the compose checkout (stands in for ~diego/shared-terminal).
up="$T/upstream"
git init -q -b main "$up"
gcommit() { git -C "$up" -c user.name=t -c user.email=t@t commit -q "$@"; }
mkdir -p "$up/backend/src"
printf 'MIGRATIONS = [\n\t{ version: 17 },\n]\n' >"$up/backend/src/db.ts"
echo a >"$up/a.txt"
git -C "$up" add -A && gcommit -m base
base=$(git -C "$up" rev-parse HEAD)
echo b >>"$up/a.txt" && git -C "$up" add -A && gcommit -m two
two=$(git -C "$up" rev-parse HEAD)
git -C "$up" checkout -q -b side
echo s >"$up/side.txt" && git -C "$up" add -A && gcommit -m side
side=$(git -C "$up" rev-parse HEAD)
git -C "$up" checkout -q main
git -C "$up" -c user.name=t -c user.email=t@t merge -q --no-ff side -m merge
merged=$(git -C "$up" rev-parse HEAD)
echo FROM x >"$up/Dockerfile" && git -C "$up" add -A && gcommit -m dockerfile
dockerfile=$(git -C "$up" rev-parse HEAD)
mkdir -p "$up/session-image" && echo y >"$up/session-image/entrypoint.sh" && git -C "$up" add -A && gcommit -m image
image=$(git -C "$up" rev-parse HEAD)
git clone -q "$up" "$T/st"
git -C "$T/st" checkout -q --detach "$base"

cat >"$ST_OPS_ETC/deploy.conf" <<EOF
REPO_URL=https://github.com/example/shared-terminal.git
ST_DIR=$T/st
REQUIRED_CHECKS="Backend (tsc + vitest)|Cloudflare Pages"
REQUEST_TTL=7200
MIN_FREE_KIB=1
EOF

# Each case runs in a subshell: die() exits.
lib() {
	(
		# shellcheck source=../lib/st-ops-lib.sh
		source "$here/lib/st-ops-lib.sh"
		logger() { :; }
		mirror_fetch() {
			[[ -d $ST_OPS_STATE/mirror.git ]] || git init -q --bare "$ST_OPS_STATE/mirror.git"
			git -C "$ST_OPS_STATE/mirror.git" fetch -q --no-tags "$up" '+refs/heads/main:refs/heads/main'
		}
		fetch_check_runs() { cat "$T/checks.json"; }
		systemd-run() { echo "systemd-run $*" >>"$T/systemd-run.log"; }
		systemctl() { :; }
		"$@"
	)
}
checks() { # $1 = backend conclusion, $2 = pages app slug
	cat >"$T/checks.json" <<EOF
{"check_runs":[
 {"id":1,"name":"Backend (tsc + vitest)","status":"completed","conclusion":"failure","started_at":"2026-11-03T10:00:00Z","app":{"slug":"github-actions"}},
 {"id":2,"name":"Backend (tsc + vitest)","status":"completed","conclusion":"$1","started_at":"2026-11-03T11:00:00Z","app":{"slug":"github-actions"}},
 {"id":3,"name":"Cloudflare Pages","status":"completed","conclusion":"success","started_at":"2026-11-03T11:00:00Z","app":{"slug":"$2"}}
]}
EOF
}

# ── Validation and config ──
expect_rc 0 "is_sha" lib is_sha "$base"
expect_rc 1 "is_sha short" lib is_sha abc
expect_rc 1 "is_sha uppercase" lib is_sha "${base^^}"
expect_rc 0 "is_request_id" lib is_request_id 20261103T153000Z-0123456789ab
expect_rc 1 "is_request_id traversal" lib is_request_id ../../etc
expect_rc 0 "load_conf" lib load_conf
cp "$ST_OPS_ETC/deploy.conf" "$T/conf.bak"
echo 'EVIL=$(id)' >>"$ST_OPS_ETC/deploy.conf"
expect_rc 2 "load_conf refuses an unknown key" lib load_conf
cp "$T/conf.bak" "$ST_OPS_ETC/deploy.conf"
expect_rc 0 "resolve_ident known key" lib resolve_ident "$fp_b"
expect_rc 2 "resolve_ident unknown key" lib resolve_ident "$(ssh-keygen -lf "$T/other.pub" | awk '{print $2}')"

# ── CI ──
checks success github-actions
expect_rc 0 "ci green (latest re-run wins)" lib eval 'load_conf; ci_green x'
checks failure github-actions
expect_rc 1 "ci not green" lib eval 'load_conf; ci_green x'
checks success some-other-app
expect_rc 1 "ci: a check-run from another app does not count" lib eval 'load_conf; ci_green x'
expect_out "MISSING Cloudflare Pages" "ci names the missing check"
checks success cloudflare-workers-and-pages

# ── Signatures ──
printf 'st-ops deploy request v1\nid: x\n' >"$T/req.txt"
sign "$T/owner" st-ops-deploy@shared-terminal "$T/req.txt"
expect_rc 0 "owner signature verifies" lib verify_signature "$T/req.txt" "$T/req.txt.sig"
cp "$T/req.txt" "$T/req2.txt" && echo "scope: full" >>"$T/req2.txt"
expect_rc 1 "signature over other bytes fails" lib verify_signature "$T/req2.txt" "$T/req.txt.sig"
cp "$T/req.txt" "$T/req3.txt" && sign "$T/owner" other-namespace "$T/req3.txt"
expect_rc 1 "wrong namespace fails" lib verify_signature "$T/req3.txt" "$T/req3.txt.sig"
cp "$T/req.txt" "$T/req4.txt" && sign "$T/bkey" st-ops-deploy@shared-terminal "$T/req4.txt"
expect_rc 1 "the operator's own key cannot approve" lib verify_signature "$T/req4.txt" "$T/req4.txt.sig"

# ── request-deploy ──
rd() { lib eval "ST_OPS_IDENT=b-0665fa5a; load_conf; verb_request_deploy $*"; }
expect_rc 2 "request: bad sha" rd nothex
expect_rc 2 "request: side-branch commit is not first-parent" rd "$side"
expect_out "ERROR provenance" "side refused as provenance"
expect_rc 2 "request: dockerfile under scope backend" rd "$dockerfile" backend
expect_out "ERROR scope" "dockerfile refused as scope"
expect_rc 2 "request: session image never" rd "$image" full
checks failure github-actions
expect_rc 2 "request: CI red" rd "$merged"
checks success cloudflare-workers-and-pages
expect_rc 0 "request: merged commit" rd "$merged"
id=$(sed -n 's/^id: //p' "$T/out")
expect_out "^sha: $merged$" "request carries the sha"
expect_out "^from: $base$" "request carries from"
expect_out "^migrations: 17 -> 17$" "request carries migrations"
expect_rc 2 "request: only one pending" rd "$two"
expect_out "ERROR pending" "second request refused as pending"
rdir="$ST_OPS_STATE/requests/$id"

# ── deploy ──
dp() { lib eval "ST_OPS_IDENT=b-0665fa5a; load_conf; verb_deploy $1" <"$2"; }
cp "$rdir/request.txt" "$T/r.txt" && sign "$T/bkey" st-ops-deploy@shared-terminal "$T/r.txt"
expect_rc 2 "deploy with the operator's signature" dp "$id" "$T/r.txt.sig"
[[ ! -e $rdir/used ]] && ok || ko "a refused deploy must not consume the request"
sed 's/^scope: backend$/scope: full/' "$rdir/request.txt" >"$T/forged.txt"
sign "$T/owner" st-ops-deploy@shared-terminal "$T/forged.txt"
expect_rc 2 "deploy with an owner signature over different bytes" dp "$id" "$T/forged.txt.sig"
sign "$T/owner" st-ops-deploy@shared-terminal "$T/r.txt"
rm -f "$T/systemd-run.log"
expect_rc 0 "deploy with the owner's signature" dp "$id" "$T/r.txt.sig"
[[ -d $rdir/used ]] && ok || ko "deploy must mark the request used"
grep -q "st-ops-deploy-$id" "$T/systemd-run.log" 2>/dev/null && ok || ko "deploy must launch the unit"
expect_rc 2 "replay of the same approval" dp "$id" "$T/r.txt.sig"
expect_out "already used" "replay refused as used"

# ── expiry ──
rm -rf "$ST_OPS_STATE/requests"
expect_rc 0 "request again" rd "$merged"
id=$(sed -n 's/^id: //p' "$T/out")
rdir="$ST_OPS_STATE/requests/$id"
sed -i 's/^expires-epoch: .*/expires-epoch: 1/' "$rdir/request.txt"
cp "$rdir/request.txt" "$T/e.txt" && sign "$T/owner" st-ops-deploy@shared-terminal "$T/e.txt"
expect_rc 2 "expired request, validly signed" dp "$id" "$T/e.txt.sig"
expect_out "expired" "expired refused as expired"

echo "st-ops tests: $pass passed, $fail failed"
((fail == 0))

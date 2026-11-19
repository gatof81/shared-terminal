#!/bin/bash
# ops/st-ops/test/run.sh — tests for st-ops, no root, no Docker, no network. `bash ops/st-ops/test/run.sh`
# Real ssh-keygen signatures, real git repositories and a fake kit (a git repo whose scripts print `RESULT … rc=`);
# GitHub and logger are stubbed.
# SC2015: `check && ok || ko` is the idiom here (ok never fails). SC2016: the fake kit's bodies are literal.
# SC2317: the stubs are called by the sourced library.
# shellcheck disable=SC2015,SC2016,SC2317
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
	[[ $got == "$want" ]] && ok || ko "$label (rc $got, want $want): $(head -c 400 "$T/out")"
}
expect_out() { grep -qE -- "$1" "$T/out" && ok || ko "$2: output lacks /$1/: $(head -c 400 "$T/out")"; }
expect_no() { grep -qE -- "$1" "$T/out" && ko "$2: output has /$1/" || ok; }

# ── Keys ──
# ssh-keygen -Y sign asks before overwriting a .sig: always sign into a fresh file.
sign() { rm -f "$2.sig"; ssh-keygen -q -Y sign -f "$1" -n "${3:-st-ops-deploy@shared-terminal}" "$2" 2>/dev/null </dev/null; }
for k in owner other qa ops2; do ssh-keygen -q -t ed25519 -N '' -C "$k" -f "$T/$k"; done
fp() { ssh-keygen -lf "$T/$1.pub" | awk '{print $2}'; }
fp_qa=$(fp qa) fp_ops2=$(fp ops2)

# ── Dispatcher ──
mkdir -p "$T/fakebin"
cat >"$T/fakebin/sudo" <<'EOF'
#!/bin/bash
printf 'ARGV:'; printf ' [%s]' "$@"; echo
EOF
chmod +x "$T/fakebin/sudo"
echo "publickey $(cut -d' ' -f1,2 "$T/qa.pub")" >"$T/auth"
disp() { SSH_USER_AUTH="$T/auth" SSH_ORIGINAL_COMMAND="$1" PATH="$T/fakebin:$PATH" bash "$here/bin/st-ops-dispatch"; }
expect_rc 0 "dispatch status" disp "status"
[[ $(cat "$T/out") == "ARGV: [-n] [/usr/local/lib/st-ops/st-ops-root] [$fp_qa] [status]" ]] && ok || ko "dispatch passes fingerprint + words: $(cat "$T/out")"
expect_rc 0 "dispatch empty command = help" disp ""
for bad in 'status; id' 'status $(id)' 'status `id`' 'result |cat' 'step a b c d' "status 'x'" 'status >/tmp/x' 'step x ../../root' "$(printf 'x%.0s' {1..201})"; do
	expect_rc 2 "dispatch refuses: ${bad:0:30}" disp "$bad"
done
SSH_ORIGINAL_COMMAND=status PATH="$T/fakebin:$PATH" bash "$here/bin/st-ops-dispatch" >"$T/out" 2>&1
[[ $? == 2 ]] && ok || ko "dispatch without SSH_USER_AUTH must refuse"

# ── Upstream repo (stands in for GitHub) ──
up="$T/upstream"
git init -q -b main "$up"
gc() { git -C "$up" -c user.name=t -c user.email=t@t commit -q --allow-empty "$@"; }
gc -m base; base=$(git -C "$up" rev-parse HEAD)
gc -m two; two=$(git -C "$up" rev-parse HEAD)
git -C "$up" checkout -q -b side
gc -m side; side=$(git -C "$up" rev-parse HEAD)
git -C "$up" checkout -q main
git -C "$up" -c user.name=t -c user.email=t@t merge -q --no-ff side -m merge
gc -m $'three \e[31mred\a'; three=$(git -C "$up" rev-parse HEAD)

# ── Fake kit: every script logs its argv and prints RESULT; $T/fail-<n> makes step <n> fail ──
export ST_OPS_ETC="$T/etc" ST_OPS_STATE="$T/state" ST_OPS_LIB="$here/lib" ST_OPS_KIT="$T/kit" ST_OPS_LOG_BASE="$T/root"
mkdir -p "$ST_OPS_ETC" "$ST_OPS_STATE" "$ST_OPS_KIT/bin" "$ST_OPS_LOG_BASE"
kit_script() { # $1 = file, $2 = body before the RESULT line
	cat >"$ST_OPS_KIT/bin/$1" <<EOF
#!/bin/bash
T=$T
n=$1
echo "\$n \$*" >>"\$T/kit.log"
$2
if [[ -e \$T/fail-\${n%%-*} ]]; then echo "RESULT \${n%.sh} FAIL rc=1"; exit 1; fi
if [[ -e \$T/noresult-\${n%%-*} ]]; then echo "something went wrong"; exit 0; fi
echo "RESULT \${n%.sh} OK rc=0"
EOF
	chmod +x "$ST_OPS_KIT/bin/$1"
}
kit_script 01-preflight.sh '
t=$(grep -E "^TARGET=" "$1" | cut -d= -f2)
log=$T/root/st-deploy-r7-${t:0:7}-$(date -u +%Y%m%dT%H%M%SZ)
[[ -e $T/badlog ]] && log=$T/elsewhere
mkdir -p "$log"; cp "$1" "$log/release.conf"; echo "KIT_HEAD=$(git -C "$T/kit" rev-parse HEAD)" >"$log/run.conf"
echo "LOG=$log"'
detached='
if [[ $1 == --detach ]]; then
	r=OK; [[ -e $T/fail-${n%%-*} ]] && r=FAIL
	printf "STEP=%s\nRESULT=%s\nRC=%s\nFINISHED=now\nLAST=x\n" "${n%.sh}" "$r" "$([[ $r == OK ]] && echo 0 || echo 1)" >"$2/${n%.sh}.result"
	echo "RESULT ${n%.sh} OK rc=0"; exit 0
fi'
kit_script 02-backup.sh ''
kit_script 02b-offhost.sh "$detached"
kit_script 03-rollback-proof.sh ''
kit_script 04-deploy.sh "$detached"
kit_script 05-verify.sh ''
kit_script 06-acp-acceptance.sh ''
kit_script 07-mint-ui-token.sh 'touch "$T/07-ran"'
git -C "$ST_OPS_KIT" init -q && git -C "$ST_OPS_KIT" add -A && git -C "$ST_OPS_KIT" -c user.name=t -c user.email=t@t commit -q -m kit
kit_move() { git -C "$ST_OPS_KIT" -c user.name=t -c user.email=t@t commit -q --allow-empty -m moved; }

# ── Config ──
echo "owner namespaces=\"st-ops-deploy@shared-terminal\" $(cut -d' ' -f1,2 "$T/owner.pub")" >"$ST_OPS_ETC/allowed_signers"
printf 'qa %s qa\nops2 %s\n' "$fp_qa" "$fp_ops2" >"$ST_OPS_ETC/identities"
conf() { # $1 = SIGNED_VERBS
	cat >"$ST_OPS_ETC/st-ops.conf" <<EOF
REPO_URL=https://github.com/example/shared-terminal.git
REQUIRED_WORKFLOW=.github/workflows/ci.yml
REQUIRED_CHECKS="Backend (tsc + vitest)|Frontend (tsc + vite build)"
REQUEST_TTL=7200
SIGNED_VERBS=$1
EOF
}
conf on

# CI fixture: the push run of ci.yml on main for the SHA (suite 500) and its check-runs; a spoof from another suite.
ci_fixture() { # $1 = run conclusion, $2 = backend check conclusion, $3 = spoof yes|no
	cat >"$T/runs.json" <<EOF
{"workflow_runs":[
 {"id":10,"run_attempt":1,"path":".github/workflows/ci.yml","event":"push","head_branch":"main","head_sha":"@SHA@","status":"completed","conclusion":"$1","check_suite_id":500},
 {"id":11,"run_attempt":1,"path":".github/workflows/evil.yml","event":"push","head_branch":"main","head_sha":"@SHA@","status":"completed","conclusion":"success","check_suite_id":999}
]}
EOF
	local spoof=""
	[[ ${3:-no} == yes ]] && spoof=',
 {"id":9,"name":"Backend (tsc + vitest)","head_sha":"@SHA@","status":"completed","conclusion":"success","started_at":"2026-11-19T12:00:00Z","app":{"slug":"github-actions"},"check_suite":{"id":999}}'
	cat >"$T/checks.json" <<EOF
{"check_runs":[
 {"id":2,"name":"Backend (tsc + vitest)","head_sha":"@SHA@","status":"completed","conclusion":"$2","started_at":"2026-11-19T11:00:00Z","app":{"slug":"github-actions"},"check_suite":{"id":500}},
 {"id":3,"name":"Frontend (tsc + vite build)","head_sha":"@SHA@","status":"completed","conclusion":"success","started_at":"2026-11-19T11:00:00Z","app":{"slug":"github-actions"},"check_suite":{"id":500}}$spoof
]}
EOF
}
ci_fixture success success

# One verb as the root side runs it (the same `set -euo pipefail` as st-ops-root), in a subshell: die() exits.
# $1 = identity key name, rest = verb + words; stdin passes through.
st() {
	local who=$1
	shift
	(
		set -euo pipefail
		# shellcheck source-path=SCRIPTDIR source=../lib/st-ops-lib.sh
		source "$here/lib/st-ops-lib.sh"
		logger() { echo "$*" >>"$T/audit.log"; }
		mirror_fetch() {
			[[ -d $ST_OPS_STATE/mirror.git ]] || git init -q --bare "$ST_OPS_STATE/mirror.git"
			git -C "$ST_OPS_STATE/mirror.git" fetch -q --no-tags "$up" '+refs/heads/main:refs/heads/main'
		}
		fetch_workflow_runs() { sed "s/@SHA@/$1/g" "$T/runs.json"; }
		fetch_check_runs() { sed "s/@SHA@/$1/g" "$T/checks.json"; }
		# A clock one second ahead per call: request ids (second resolution) never collide here.
		tick=$(($(cat "$T/tick" 2>/dev/null || echo 0) + 1)); echo "$tick" >"$T/tick"
		now_epoch() { if [[ -f $T/now ]]; then cat "$T/now"; else echo $(($(date -u +%s) + tick)); fi; }
		message_is_own_running() { grep -qx "$1 $2" "$T/running-messages" 2>/dev/null; }
		st_ops_main "$(fp "$who")" "$@"
	)
}
release() { printf '# r7\nFROM=%s\nTARGET=%s\nIMAGE_NOTE=plain value\n' "$1" "$2"; }
propose() { release "$1" "$2" | st qa propose; }
new_id() { grep -oE '^id: .*' "$T/out" | sed 's/^id: //'; }
text() { st qa request-text "$1" >"$T/req.txt"; }
approve() { text "$1"; sign "$T/owner" "$T/req.txt"; st qa approve "$1" <"$T/req.txt.sig"; }
cancel_active() { local d; for d in "$ST_OPS_STATE"/requests/*/; do st qa cancel "$(basename "$d")" >/dev/null 2>&1; done; }

# ── Identity, verbs, words ──
expect_rc 2 "unknown key is denied" st other status
expect_out "ERROR denied" "unknown key"
expect_rc 0 "status" st qa status
expect_out "^kit-head: [0-9a-f]{40}$" "status shows the kit commit"
expect_out "^signed-verbs: on" "status shows the stage"
expect_rc 2 "unknown verb" st qa deploy-now
expect_rc 2 "invalid word" st qa result 'a/b'
expect_rc 2 "invalid verb" st qa 'Rm'
grep -q "ident=qa verb=deploy-now" "$T/audit.log" && grep -q "code=usage" "$T/audit.log" && ok || ko "audit has identity, verb and code"

# ── propose ──
expect_rc 2 "propose: target off main's first parent" propose "$base" "$side"
expect_out "ERROR provenance" "side branch refused"
expect_rc 2 "propose: target not descending from FROM" propose "$three" "$two"
expect_rc 2 "propose: unknown target" propose "$base" "$(printf 'a%.0s' {1..40})"
ci_fixture failure success
expect_rc 2 "propose: CI run failed" propose "$base" "$two"
expect_out "ERROR ci" "ci refusal"
ci_fixture success failure yes
expect_rc 2 "propose: a spoofed check from another suite does not count" propose "$base" "$two"
ci_fixture success success
expect_rc 2 "propose: no TARGET" st qa propose <<<"FROM=$base"
expect_rc 2 "propose: two TARGET lines" st qa propose < <(release "$base" "$two"; echo "TARGET=$two")
expect_rc 2 "propose: control bytes" st qa propose < <(release "$base" "$two"; printf 'X=\033[1m\n')
expect_rc 2 "propose: oversized" st qa propose < <(release "$base" "$two"; head -c 17000 /dev/zero | tr '\0' a)
[[ -z $(ls "$ST_OPS_STATE/requests" 2>/dev/null) ]] && ok || ko "refused proposals leave no request"
expect_rc 0 "propose OK" propose "$base" "$three"
id=$(new_id)
expect_out "^requested-by: qa$" "text: requester"
expect_out "^release-conf-sha256: $(release "$base" "$three" | sha256sum | cut -d' ' -f1)$" "text: data hash"
expect_out "^kit-head: $(git -C "$ST_OPS_KIT" rev-parse HEAD)$" "text: kit head"
expect_out "^compare: https://github.com/example/shared-terminal/compare/$base...$three$" "text: compare"
expect_out "^  [0-9a-f]+ three \?\[31mred\?$" "text: commit subjects printable-only"
expect_out "^  ci: run 10 of .github/workflows/ci.yml: completed/success$" "text: CI run"
expect_out "^runs-as: root \(kit" "text: runs-as"
expect_out "^  IMAGE_NOTE=plain value$" "text: the data itself"
[[ $(stat -c %a "$ST_OPS_STATE/requests/$id/release.conf") == 600 ]] && ok || ko "release.conf is 0600"
expect_rc 2 "one active request at a time" propose "$base" "$two"
expect_out "ERROR pending" "pending"

# ── Stage 1: the signed verbs refuse ──
conf off
text "$id"; sign "$T/owner" "$T/req.txt"
expect_rc 2 "stage 1: approve refused" st qa approve "$id" <"$T/req.txt.sig"
expect_out "ERROR disabled" "disabled"
expect_rc 2 "stage 1: step refused" st qa step "$id" backup
expect_rc 0 "stage 1: preflight allowed" st qa preflight "$id"
conf on

# ── Signatures ──
expect_out "^LOG=$T/root/st-deploy-r7-" "preflight prints the LOG"
expect_out "^RESULT 01-preflight OK rc=0$" "preflight passes the RESULT line"
expect_rc 2 "preflight runs once" st qa preflight "$id"
expect_rc 2 "step before approve" st qa step "$id" backup
expect_out "ERROR approval" "not approved"
sign "$T/other" "$T/req.txt"
expect_rc 2 "signature by another key" st qa approve "$id" <"$T/req.txt.sig"
expect_out "ERROR signature" "other key"
sign "$T/owner" "$T/req.txt" other-namespace@x
expect_rc 2 "signature in another namespace" st qa approve "$id" <"$T/req.txt.sig"
sed 's/IMAGE_NOTE=plain value/IMAGE_NOTE=evil/' "$T/req.txt" >"$T/req2.txt"; sign "$T/owner" "$T/req2.txt"
expect_rc 2 "signature over other bytes" st qa approve "$id" <"$T/req2.txt.sig"
echo garbage | st qa approve "$id" >"$T/out" 2>&1; [[ $? == 2 ]] && ok || ko "garbage signature"
# Another request's signature: propose B, sign it, cancel it; its signature must not approve A (and vice versa).
idA=$id
expect_rc 0 "approve OK" approve "$idA"
expect_rc 2 "approval used once" approve "$idA"
expect_out "already approved" "reused"

# ── Order, one-shot, inputs as signed ──
expect_rc 2 "step out of order" st qa step "$idA" deploy
expect_out "ERROR order" "out of order"
expect_rc 2 "unknown step" st qa step "$idA" mint-ui-token
expect_rc 2 "07 by its number" st qa step "$idA" 07-mint-ui-token
expect_rc 2 "verify before deploy" st qa verify "$idA"
expect_rc 0 "backup" st qa step "$idA" backup
expect_out "^RESULT 02-backup OK rc=0$" "backup's RESULT"
grep -q "^02-backup.sh $T/root/st-deploy-r7-" "$T/kit.log" && ok || ko "backup gets the LOG"
expect_rc 2 "backup runs once" st qa step "$idA" backup
expect_rc 0 "offhost (detached)" st qa step "$idA" offhost
grep -q "^02b-offhost.sh --detach $T/root/" "$T/kit.log" && ok || ko "offhost gets --detach LOG"
expect_rc 0 "result of a detached step" st qa result "$idA" offhost
expect_out "^RESULT=OK$" "result shows the .result"
expect_out "^step offhost: OK$" "result: offhost OK"
expect_rc 2 "cancel after a writing step" st qa cancel "$idA"
# Data changed after the signature (the copy st-ops keeps).
cp "$ST_OPS_STATE/requests/$idA/release.conf" "$T/keep"
echo "EXTRA=1" >>"$ST_OPS_STATE/requests/$idA/release.conf"
expect_rc 2 "data changed after signing" st qa step "$idA" rollback-proof
expect_out "ERROR data" "data"
cp "$T/keep" "$ST_OPS_STATE/requests/$idA/release.conf"
# …and the LOG's frozen copy, which the later steps read.
log=$(cat "$ST_OPS_STATE/requests/$idA/log")
echo "EXTRA=1" >>"$log/release.conf"
expect_rc 2 "frozen data changed after signing" st qa step "$idA" rollback-proof
expect_out "ERROR data" "frozen data"
cp "$T/keep" "$log/release.conf"
kit_move
expect_rc 2 "kit moved after signing" st qa step "$idA" rollback-proof
expect_out "ERROR kit" "kit"
git -C "$ST_OPS_KIT" reset -q --hard HEAD~1
[[ ! -e $ST_OPS_STATE/requests/$idA/steps/rollback-proof.started ]] && ok || ko "refused steps are not consumed"
expect_rc 0 "rollback-proof" st qa step "$idA" rollback-proof

# ── --exclude-message ──
expect_rc 2 "exclude: another agent's message" st qa step "$idA" deploy 4242
expect_out "ERROR message" "not proven"
echo "4242 arq" >"$T/running-messages"
expect_rc 2 "exclude: a running message to ANOTHER agent" st qa step "$idA" deploy 4242
expect_out "ERROR message" "another agent"
expect_rc 2 "exclude: identity without agent" st ops2 step "$idA" deploy 4242
expect_out "has no agent" "no agent"
expect_rc 2 "exclude: not a message id" st qa step "$idA" deploy abc
echo "4242 qa" >"$T/running-messages"
expect_rc 2 "exclude: a step that takes none" st qa step "$idA" acceptance 4242
grep -q "^04-deploy" "$T/kit.log" && ko "deploy ran during refusals" || ok
expect_rc 0 "deploy with its own running message excluded" st qa step "$idA" deploy 4242
grep -qx "04-deploy.sh --detach $log --exclude-message 4242" "$T/kit.log" && ok || ko "deploy argv: $(grep 04- "$T/kit.log")"
expect_rc 0 "verify after deploy" st qa verify "$idA"
expect_out "^RESULT 05-verify OK rc=0$" "verify output"
expect_rc 0 "acceptance" st qa step "$idA" acceptance
expect_rc 0 "result after the last step" st qa result "$idA"
expect_out "^state: closed done$" "request done"
[[ ! -e $T/07-ran ]] && ok || ko "07 ran"
grep -q "07" <(grep -vE '^\s*#' "$here/lib/st-ops-lib.sh" | grep -E '0[0-9]-|0[0-9]b-') && ko "the lib names 07" || ok

# ── Failures close the request; exit code is the kit's ──
expect_rc 0 "propose after done" propose "$base" "$two"
id=$(new_id)
expect_rc 0 "preflight 2" st qa preflight "$id"
expect_rc 0 "approve 2" approve "$id"
touch "$T/fail-02"
expect_rc 1 "a failing step exits with the kit's code" st qa step "$id" backup
expect_out "^RESULT 02-backup FAIL rc=1$" "FAIL line"
rm "$T/fail-02"
expect_rc 2 "nothing runs after a failure" st qa step "$id" offhost
expect_out "request is closed failed backup" "closed"
expect_rc 0 "propose after a failure" propose "$base" "$two"
id=$(new_id)
st qa preflight "$id" >/dev/null 2>&1; approve "$id" >/dev/null 2>&1; st qa step "$id" backup >/dev/null 2>&1
touch "$T/fail-02b"
expect_rc 0 "detached launch OK" st qa step "$id" offhost
rm "$T/fail-02b"
expect_rc 2 "a detached step's FAIL .result stops the next step" st qa step "$id" rollback-proof
expect_rc 0 "propose after a detached failure" propose "$base" "$two"
id=$(new_id)
touch "$T/noresult-01"
expect_rc 1 "no RESULT line = FAIL" st qa preflight "$id"
expect_out "kit printed no RESULT line" "no RESULT"
rm "$T/noresult-01"
expect_rc 0 "propose after preflight failure" propose "$base" "$two"
id=$(new_id)
touch "$T/badlog"
expect_rc 1 "preflight LOG outside the kit's place" st qa preflight "$id"
rm "$T/badlog"

# ── Expiry, cancel, another request's signature ──
expect_rc 0 "propose" propose "$base" "$two"
idB=$(new_id); text "$idB"; cp "$T/req.txt" "$T/reqB.txt"; sign "$T/owner" "$T/reqB.txt"
expect_rc 0 "cancel before writing steps" st qa cancel "$idB"
expect_rc 0 "propose C" propose "$base" "$two"
idC=$(new_id)
expect_rc 2 "another request's signature" st qa approve "$idC" <"$T/reqB.txt.sig"
expect_out "ERROR signature" "other request"
expect_rc 2 "approve a cancelled request" st qa approve "$idB" <"$T/reqB.txt.sig"
echo $(($(date -u +%s) + $(cat "$T/tick") + 7300)) >"$T/now"
expect_rc 2 "expired" approve "$idC"
expect_out "expired" "expired"
rm "$T/now"

# ── install.sh grants nothing (static) ──
inst="$here/install.sh"
grep -qE 'install -o root -g root -m 0644 /dev/null "/etc/st-ops/\$f"' "$inst" && ok || ko "key files created empty"
grep -qE '\[\[ -f /etc/st-ops/\$f \]\] \|\|' "$inst" && ok || ko "existing key files never overwritten"
grep -nE 'authorized_keys|identities|allowed_signers' "$inst" | grep -vE '^[0-9]+:\s*#|for f in|grep -c|-s /etc/st-ops/allowed_signers' &&
	ko "install.sh writes a key file" || ok
grep -qx 'SIGNED_VERBS=off' "$here/etc/st-ops/st-ops.conf.example" && ok || ko "stage 1 by default"
grep -qE 'usermod|gpasswd|useradd.* -G' "$inst" && ko "install.sh adds groups" || ok
[[ $(grep -vE '^\s*(#|Defaults|$)' "$here/etc/sudoers.d/st-ops") == "st-ops ALL=(root) NOPASSWD: /usr/local/lib/st-ops/st-ops-root" ]] && ok || ko "sudoers: one line"

echo "st-ops tests: $pass passed, $fail failed"
((fail == 0))

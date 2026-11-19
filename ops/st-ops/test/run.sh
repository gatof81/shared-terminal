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
for k in owner other qa ops2 arq; do ssh-keygen -q -t ed25519 -N '' -C "$k" -f "$T/$k"; done
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
if [[ -e \$T/busy-\${n%%-*} ]]; then rm "\$T/busy-\${n%%-*}"; echo "RESULT \${n%.sh} BUSY rc=3"; exit 3; fi
if [[ -e \$T/fail-\${n%%-*} ]]; then echo "RESULT \${n%.sh} FAIL rc=1"; exit 1; fi
if [[ -e \$T/noresult-\${n%%-*} ]]; then echo "something went wrong"; exit 0; fi
echo "RESULT \${n%.sh} OK rc=0"
EOF
	chmod +x "$ST_OPS_KIT/bin/$1"
}
kit_script 01-preflight.sh '
[[ $1 == --release-file && $2 == /* ]] || { echo "RESULT 01-preflight USAGE rc=2"; exit 2; }
t=$(grep -E "^TARGET=" "$2" | cut -d= -f2); r=$(grep -E "^RELEASE=" "$2" | cut -d= -f2)
# What the real 01 checks of --release-file: name r<RELEASE>.conf, file and dir ours, not g/o-writable, no symlink.
[[ ${2##*/} == "r$r.conf" && ! -L $2 && ! -L ${2%/*} && $(stat -c %u "$2") == $(id -u) && $(stat -c %u "${2%/*}") == $(id -u) &&
	$(( 0$(stat -c %a "$2") & 022 )) == 0 && $(( 0$(stat -c %a "${2%/*}") & 022 )) == 0 ]] || { echo "RESULT 01-preflight USAGE rc=2"; exit 2; }
[[ -e $T/badrel ]] && r=99
log=$T/root/st-deploy-r$r-${t:0:7}-$(date -u +%Y%m%dT%H%M%SZ)
[[ -e $T/badlog ]] && log=$T/elsewhere
mkdir -p "$log"; cp "$2" "$log/release.conf"
printf "KIT_HEAD=%s\nRELEASE_CONF_SHA256=%s\nHOST_CONF_SHA256=x\n" "$(git rev-parse HEAD)" "$([[ -e $T/badsum ]] && echo 0 || sha256sum <"$2" | cut -d" " -f1)" >"$log/run.conf"
echo "LOG=$log"'
detached='
if [[ $1 == --detach ]]; then
	if [[ -f $2/${n%.sh}.result ]]; then
		grep -qx RESULT=BUSY "$2/${n%.sh}.result" || { echo "RESULT ${n%.sh} USAGE rc=2"; exit 2; }
		mv "$2/${n%.sh}.result" "$2/${n%.sh}.result.busy-$(date -u +%s%N)"
	fi
	r=OK rc=0; [[ -e $T/fail-${n%%-*} ]] && r=FAIL rc=1
	[[ -e $T/busy-${n%%-*} ]] && { rm "$T/busy-${n%%-*}"; r=BUSY rc=3; }
	printf "STEP=%s\nRESULT=%s\nRC=%s\nFINISHED=now\nLAST=x\n" "${n%.sh}" "$r" "$rc" >"$2/${n%.sh}.result"
	echo "RESULT ${n%.sh} OK rc=0"; exit 0
fi'
kit_script 02-backup.sh ''
kit_script 02b-offhost.sh "$detached"
kit_script 03-rollback-proof.sh ''
kit_script 04-deploy.sh "$detached"
kit_script 05-verify.sh ''
kit_script 06-acp-acceptance.sh ''
kit_script 07-mint-ui-token.sh 'touch "$T/07-ran"'
# message-info.sh <id> <agent>, as the real one: exit 0 only for a running message to an existing <agent>.
# $T/msg/<id> = "<to> <state> <agent exists>"; $T/msg/<id>.raw replaces the whole answer (malformed output, rc 0).
cat >"$ST_OPS_KIT/bin/message-info.sh" <<EOF
#!/bin/bash
echo "message-info.sh \$*" >>"$T/kit.log"
[[ \$# == 2 && \$2 =~ ^[a-z][a-z0-9-]{1,31}\$ ]] || { echo "RESULT message-info USAGE rc=2"; exit 2; }
[[ -f $T/msg/\$1.raw ]] && { cat "$T/msg/\$1.raw"; exit "\$(cat "$T/msg/\$1.rc" 2>/dev/null || echo 0)"; }
read -r to state exists <"$T/msg/\$1" 2>/dev/null
echo "MESSAGE_ID=\$1"; echo "TO=\$to"; echo "STATE=\$state"
if [[ \$to == "\$2" && \$state == running && \$exists == yes ]]; then echo "RESULT message-info OK rc=0"; exit 0; fi
echo "RESULT message-info FAIL rc=1"; exit 1
EOF
mkdir -p "$T/msg"
msg() { echo "$2 $3 $4" >"$T/msg/$1"; rm -f "$T/msg/$1.raw" "$T/msg/$1.rc"; } # $1 = id, $2 = to, $3 = state, $4 = agent exists
git -C "$ST_OPS_KIT" init -q && git -C "$ST_OPS_KIT" add -A && git -C "$ST_OPS_KIT" -c user.name=t -c user.email=t@t commit -q -m kit
kit_move() { git -C "$ST_OPS_KIT" -c user.name=t -c user.email=t@t commit -q --allow-empty -m moved; }

# ── Config ──
echo "owner namespaces=\"st-ops-deploy@shared-terminal\" $(cut -d' ' -f1,2 "$T/owner.pub")" >"$ST_OPS_ETC/allowed_signers"
printf 'qa %s qa\nops2 %s\narq-ops %s arq\n' "$fp_qa" "$fp_ops2" "$(fp arq)" >"$ST_OPS_ETC/identities"
conf() { # $1 = SIGNED_VERBS
	cat >"$ST_OPS_ETC/st-ops.conf" <<EOF
REPO_URL=https://github.com/example/shared-terminal.git
REQUIRED_WORKFLOW=.github/workflows/ci.yml
REQUIRED_CHECKS="Backend (tsc + vitest)|Frontend (tsc + vite build)"
REQUEST_TTL=7200
APPROVAL_TTL=21600
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
		st_ops_main "$(fp "$who")" "$@"
	)
}
DIST=/root/st-deploy-r12-0123abc-20261118T101010Z/new-image-dist-all.txt
release() { printf '# r7\n\nRELEASE=7\nFROM=%s\nTARGET=%s\nP_DIST_FILE=%s\nIMAGE_NOTE=plain value\n' "$1" "$2" "${3:-$DIST}"; }
propose() { release "$@" | st qa propose; }
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
expect_out "non-ASCII or control byte at line 8" "control byte line"
expect_rc 2 "propose: UTF-8" st qa propose < <(release "$base" "$two"; echo 'PAGES_TEXT=Proyecto archivado · solo lectura')
expect_out "non-ASCII or control byte at line 8 \(release data is ASCII\)" "non-ASCII line"
expect_rc 2 "propose: oversized" st qa propose < <(release "$base" "$two"; head -c 17000 /dev/zero | tr '\0' a)
expect_rc 2 "propose: P_DIST_FILE elsewhere" propose "$base" "$three" /etc/shadow
expect_out "ERROR data: P_DIST_FILE" "P_DIST_FILE refused"
expect_rc 2 "propose: P_DIST_FILE under a fake LOG name" propose "$base" "$three" /root/st-deploy-r1-0123abc-20261118T101010Z/../../etc/x/new-image-dist-all.txt
expect_rc 2 "propose: no P_DIST_FILE" st qa propose < <(release "$base" "$three" | grep -v P_DIST)
expect_rc 2 "propose: two P_DIST_FILE" st qa propose < <(release "$base" "$three"; echo "P_DIST_FILE=$DIST")
expect_rc 2 "propose: no RELEASE" st qa propose < <(release "$base" "$three" | grep -v RELEASE)
expect_rc 2 "propose: RELEASE 0013" st qa propose < <(release "$base" "$three" | sed 's/^RELEASE=7/RELEASE=0013/')
expect_rc 2 "propose: two RELEASE" st qa propose < <(release "$base" "$three"; echo RELEASE=8)
expect_rc 2 "propose: two FROM" st qa propose < <(release "$base" "$three"; echo "FROM=$base")
[[ -z $(ls "$ST_OPS_STATE/requests" 2>/dev/null) ]] && ok || ko "refused proposals leave no request"
expect_rc 0 "propose OK" propose "$base" "$three"
id=$(new_id)
expect_out "^requested-by: qa$" "text: requester"
expect_out "^release: r7$" "text: release"
expect_out "^release-conf-sha256: $(release "$base" "$three" | sha256sum | cut -d' ' -f1)$" "text: data hash"
expect_out "^kit-head: $(git -C "$ST_OPS_KIT" rev-parse HEAD)$" "text: kit head"
expect_out "^compare: https://github.com/example/shared-terminal/compare/$base...$three$" "text: compare"
expect_out "^  [0-9a-f]+ three \?\[31mred\?$" "text: commit subjects printable-only"
expect_out "^  ci: run 10 of .github/workflows/ci.yml: completed/success$" "text: CI run"
expect_out "^runs-as: root \(kit" "text: runs-as"
expect_out "^approval-valid-for: 21600s$" "text: approval window"
expect_out "^  IMAGE_NOTE=plain value$" "text: the data itself"
[[ $(stat -c %a "$ST_OPS_STATE/requests/$id/r7.conf") == 600 ]] && ok || ko "r7.conf is 0600"
[[ $(stat -c %a "$ST_OPS_STATE/requests/$id") == 700 ]] && ok || ko "request dir is 0700"
expect_rc 2 "one active request at a time" propose "$base" "$two"
expect_out "ERROR pending" "pending"

# ── Stage 1: the signed verbs refuse ──
conf off
text "$id"; sign "$T/owner" "$T/req.txt"
expect_rc 2 "stage 1: approve refused" st qa approve "$id" <"$T/req.txt.sig"
expect_out "ERROR disabled" "disabled"
expect_rc 2 "stage 1: step refused" st qa step "$id" backup
touch "$T/busy-01"
expect_rc 3 "preflight BUSY exits 3" st qa preflight "$id"
expect_out "answered BUSY" "busy note"
expect_rc 0 "BUSY keeps the request active" st qa result "$id"
expect_out "^state: active$" "active after BUSY"
expect_out "^step preflight: NONE$" "BUSY preflight is not consumed"
expect_rc 0 "stage 1: preflight allowed (after BUSY)" st qa preflight "$id"
conf on

# ── Signatures ──
expect_out "^LOG=$T/root/st-deploy-r7-" "preflight prints the LOG"
grep -qx "01-preflight.sh --release-file $ST_OPS_STATE/requests/$id/r7.conf" "$T/kit.log" && ok || ko "01 argv: $(grep 01- "$T/kit.log")"
[[ -z $(git -C "$ST_OPS_KIT" status --porcelain) ]] && ok || ko "st-ops wrote into the kit"
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
[[ -z $(find "$ST_OPS_STATE" -name 'sig*' -o -name '*.candidate') ]] && ok || ko "rejected approvals leave no temp file"
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
touch "$T/busy-02"
expect_rc 3 "backup BUSY" st qa step "$idA" backup
expect_rc 2 "offhost refused after a BUSY backup" st qa step "$idA" offhost
expect_rc 0 "backup" st qa step "$idA" backup
expect_out "^RESULT 02-backup OK rc=0$" "backup's RESULT"
grep -q "^02-backup.sh $T/root/st-deploy-r7-" "$T/kit.log" && ok || ko "backup gets the LOG"
expect_rc 2 "backup runs once" st qa step "$idA" backup
touch "$T/busy-02b"
expect_rc 0 "offhost launched, then BUSY in its .result" st qa step "$idA" offhost
expect_rc 0 "result" st qa result "$idA"
expect_out "^step offhost: BUSY$" "detached BUSY"
expect_out "^state: active$" "detached BUSY keeps the request"
expect_rc 2 "rollback-proof refused after a BUSY offhost" st qa step "$idA" rollback-proof
expect_rc 0 "offhost (detached), relaunched after BUSY" st qa step "$idA" offhost
grep -q "^02b-offhost.sh --detach $T/root/" "$T/kit.log" && ok || ko "offhost gets --detach LOG"
expect_rc 0 "result of a detached step" st qa result "$idA" offhost
expect_out "^RESULT=OK$" "result shows the .result"
expect_out "^step offhost: OK$" "result: offhost OK"
expect_rc 2 "cancel after a writing step" st qa cancel "$idA"
# Data changed after the signature (the copy st-ops keeps).
cp "$ST_OPS_STATE/requests/$idA/r7.conf" "$T/keep"
echo "EXTRA=1" >>"$ST_OPS_STATE/requests/$idA/r7.conf"
expect_rc 2 "data changed after signing" st qa step "$idA" rollback-proof
expect_out "ERROR data" "data"
cp "$T/keep" "$ST_OPS_STATE/requests/$idA/r7.conf"
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
msg 4242 arq running yes
expect_rc 2 "exclude: a running message to ANOTHER agent" st qa step "$idA" deploy 4242
expect_out "ERROR message" "another agent"
expect_rc 2 "exclude: identity without agent" st ops2 step "$idA" deploy 4242
expect_out "has no agent" "no agent"
expect_rc 2 "exclude: not a message id" st qa step "$idA" deploy abc
# Each of these must be refused by the real message_is_own_running.
msg 4242 qa pending yes
expect_rc 2 "exclude: own message, pending" st qa step "$idA" deploy 4242
msg 4242 qa running no
expect_rc 2 "exclude: agent deleted" st qa step "$idA" deploy 4242
msg 4242 qa running yes; printf 'MESSAGE_ID=4242\nRESULT message-info OK rc=0\nnoise\n' >"$T/msg/4242.raw"
expect_rc 2 "exclude: rc 0 but the last line is not the OK RESULT" st qa step "$idA" deploy 4242
printf 'RESULT message-info OK rc=0\n' >"$T/msg/4242.raw"; echo 1 >"$T/msg/4242.rc"
expect_rc 2 "exclude: an OK line with rc 1" st qa step "$idA" deploy 4242
rm "$T/msg/4242.rc"
msg 4242 qa running yes
expect_rc 2 "exclude: qa's running message asked by the arq identity" st arq step "$idA" deploy 4242
grep -qx "message-info.sh 4242 arq" "$T/kit.log" && ok || ko "message-info asked about the caller's agent"
printf 'RESULT message-info FAIL rc=1\n' >"$T/msg/4242.raw"
expect_rc 2 "exclude: rc 0 with a FAIL RESULT" st qa step "$idA" deploy 4242
expect_out "ERROR message" "refused as message"
grep -qx "message-info.sh 4242 qa" "$T/kit.log" && ok || ko "message-info gets <id> <agent>"
msg 4242 qa running yes
expect_rc 2 "exclude: a step that takes none" st qa step "$idA" acceptance 4242
grep -q "^04-deploy" "$T/kit.log" && ko "deploy ran during refusals" || ok
expect_rc 0 "deploy with its own running message excluded" st qa step "$idA" deploy 4242
grep -qx "04-deploy.sh --detach $log --exclude-message 4242" "$T/kit.log" && ok || ko "deploy argv: $(grep 04- "$T/kit.log")"
expect_rc 2 "acceptance before verify" st qa step "$idA" acceptance
expect_out "verify has not finished OK" "verify first"
touch "$T/fail-05"
expect_rc 1 "verify FAIL" st qa verify "$idA"
rm "$T/fail-05"
expect_rc 2 "acceptance after a failed verify" st qa step "$idA" acceptance
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
expect_rc 0 "propose" propose "$base" "$two"
id=$(new_id)
touch "$T/badsum"
expect_rc 1 "preflight run.conf with another data hash" st qa preflight "$id"
rm "$T/badsum"
expect_rc 0 "propose" propose "$base" "$two"
id=$(new_id)
touch "$T/badrel"
expect_rc 1 "preflight LOG of another release" st qa preflight "$id"
rm "$T/badrel"
expect_rc 0 "propose" propose "$base" "$two"
id=$(new_id)
expect_rc 2 "preflight: another agent's message" st qa preflight "$id" 77
expect_out "ERROR message" "preflight exclusion unproven"
msg 77 qa running yes
expect_rc 0 "preflight with its own running message excluded" st qa preflight "$id" 77
grep -qx "01-preflight.sh --release-file $ST_OPS_STATE/requests/$id/r7.conf --exclude-message 77" "$T/kit.log" && ok || ko "01 exclude argv"
st qa cancel "$id" >/dev/null 2>&1

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
# An approval lapses: no writing step after APPROVAL_TTL, and the request stops blocking new ones.
st qa cancel "$idC" >/dev/null 2>&1
expect_rc 0 "propose D" propose "$base" "$two"
idD=$(new_id)
st qa preflight "$idD" >/dev/null 2>&1
expect_rc 0 "approve D" approve "$idD"
expect_rc 0 "backup D" st qa step "$idD" backup
echo $(($(date -u +%s) + $(cat "$T/tick") + 21700)) >"$T/now"
expect_rc 2 "a lapsed approval runs nothing" st qa step "$idD" offhost
expect_out "approval lapsed|expired \(approval\)" "lapsed"
expect_rc 0 "result D" st qa result "$idD"
expect_out "^state: expired \(approval\)$" "lapsed state"
expect_rc 0 "a lapsed request no longer blocks" propose "$base" "$two"
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

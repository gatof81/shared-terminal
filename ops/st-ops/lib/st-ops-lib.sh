# st-ops-lib.sh — the st-ops dispatcher's root side (ops/st-ops/README.md). It validates, records and calls the
# deploy kit's FIXED scripts; it never builds, backs up, restarts or rolls back anything itself.
# The caller sets ST_OPS_ETC, ST_OPS_STATE, ST_OPS_LIB, ST_OPS_KIT and ST_OPS_LOG_BASE before sourcing; the tests
# point them at a temp dir.
# shellcheck shell=bash
# `check && check || die …` is safe here: die exits, so it never runs after a passing check.
# shellcheck disable=SC2015

# ── Output and audit ─────────────────────────────────────────────────────

ST_OPS_IDENT=unknown
ST_OPS_AGENT=''
ST_OPS_VERB=none
ST_OPS_ARGS=''
ST_OPS_CODE=''
st_ops_audit() {
	logger -t st-ops -- "ident=$ST_OPS_IDENT verb=$ST_OPS_VERB args=[$ST_OPS_ARGS] $*" 2>/dev/null || true
}

# Every refusal is one line, `ERROR <code>: <text>`, exit 2 (the EXIT trap writes the audit line).
die() {
	ST_OPS_CODE=$1
	echo "ERROR $1: $2" >&2
	exit 2
}

# ── Validation ───────────────────────────────────────────────────────────

is_sha() { [[ $1 =~ ^[0-9a-f]{40}$ ]]; }
is_request_id() { [[ $1 =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$ ]]; }
is_msg_id() { [[ $1 =~ ^[0-9]{1,12}$ ]]; }

# st-ops.conf is parsed, never sourced: only these keys, plain values.
load_conf() {
	local f="$ST_OPS_ETC/st-ops.conf" k v
	[[ -f $f ]] || die conf "missing $f"
	REPO_URL='' REQUIRED_WORKFLOW='' REQUIRED_CHECKS='' REQUEST_TTL='' APPROVAL_TTL='' WRITE_VERBS='' COMPOSE_PROJECT=''
	while IFS='=' read -r k v; do
		[[ -z $k || $k == \#* ]] && continue
		v=${v#\"}; v=${v%\"}
		case $k in
		REPO_URL) [[ $v =~ ^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\.git$ ]] || die conf "REPO_URL"; REPO_URL=$v ;;
		REQUIRED_WORKFLOW) [[ $v =~ ^\.github/workflows/[A-Za-z0-9._-]+\.ya?ml$ ]] || die conf "REQUIRED_WORKFLOW"; REQUIRED_WORKFLOW=$v ;;
		REQUIRED_CHECKS) REQUIRED_CHECKS=$v ;;
		REQUEST_TTL) [[ $v =~ ^[0-9]{2,6}$ ]] || die conf "REQUEST_TTL"; REQUEST_TTL=$v ;;
		APPROVAL_TTL) [[ $v =~ ^[0-9]{2,6}$ ]] || die conf "APPROVAL_TTL"; APPROVAL_TTL=$v ;;
		WRITE_VERBS) [[ $v == on || $v == off ]] || die conf "WRITE_VERBS"; WRITE_VERBS=$v ;;
		COMPOSE_PROJECT) [[ $v =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || die conf "COMPOSE_PROJECT"; COMPOSE_PROJECT=$v ;;
		*) die conf "unknown key $k" ;;
		esac
	done <"$f"
	[[ -n $REPO_URL && -n $REQUIRED_WORKFLOW && -n $REQUIRED_CHECKS && -n $REQUEST_TTL && -n $APPROVAL_TTL && -n $WRITE_VERBS ]] || die conf "incomplete"
}

# identities: `<name> <SHA256:fingerprint> [<agent>]` per line. A key that is not listed gets nothing, even if sshd
# let it in. <agent> is the ACP agent that identity works as: the only one whose message it may exclude.
resolve_ident() {
	local fp=$1 name f agent
	[[ $fp =~ ^SHA256:[A-Za-z0-9+/]{43}$ ]] || die denied "fingerprint"
	while read -r name f agent; do
		[[ -z $name || $name == \#* ]] && continue
		if [[ $f == "$fp" && $name =~ ^[a-z0-9-]{1,32}$ ]]; then
			[[ -z $agent || $agent =~ ^[a-z][a-z0-9-]{1,31}$ ]] || die denied "bad agent name in identities"
			ST_OPS_IDENT=$name
			ST_OPS_AGENT=$agent
			return 0
		fi
	done <"$ST_OPS_ETC/identities"
	die denied "unknown key"
}

# ── Git: provenance is established by the server, from the public repo ──

# A root-owned bare mirror, fetched over anonymous HTTPS. Nothing the caller says about history is believed.
mirror() { git -C "$ST_OPS_STATE/mirror.git" "$@"; }
mirror_fetch() {
	if [[ ! -d $ST_OPS_STATE/mirror.git ]]; then
		git init -q --bare "$ST_OPS_STATE/mirror.git"
	fi
	timeout 120 git -C "$ST_OPS_STATE/mirror.git" fetch -q --no-tags "$REPO_URL" '+refs/heads/main:refs/heads/main' ||
		die fetch "could not fetch main from $REPO_URL"
}

# On main's FIRST-PARENT chain: a commit merged into main, not one that only exists on a merged branch.
# Not `grep -q`: it exits at the first match, rev-list then dies of SIGPIPE (141) and, under pipefail, a RECENT
# SHA — found early, the normal case — reads as "not on main" once the history outgrows the pipe buffer.
on_main() {
	mirror rev-list --first-parent -n 20000 refs/heads/main | grep -x "$1" >/dev/null
}

kit_head() { git -C "$ST_OPS_KIT" rev-parse HEAD 2>/dev/null; }

# ── CI: the required workflow's own push run on main, public API ─────────

gh_api() { # $1 = path under /repos/<owner>/<repo>/
	local repo=${REPO_URL#https://github.com/}
	repo=${repo%.git}
	timeout 30 curl -sf -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$repo/$1"
}
fetch_workflow_runs() { gh_api "actions/runs?head_sha=$1&event=push&branch=main&per_page=100"; }
fetch_check_runs() { gh_api "commits/$1/check-runs?per_page=100"; }

# A check-run's name — even with the github-actions app — is not identity: any workflow job with `checks: write`
# can post a "success" check-run with any name on any SHA, and the operator can push workflows. So a required
# check counts only from the check suite of REQUIRED_WORKFLOW's own run for this exact SHA, triggered by a push to
# main (the latest such run decides). Prints one line per check.
ci_green() {
	local runs checks
	runs=$(fetch_workflow_runs "$1") || {
		echo "ci: could not read workflow runs"
		return 1
	}
	checks=$(fetch_check_runs "$1") || {
		echo "ci: could not read check-runs"
		return 1
	}
	CI_SHA=$1 CI_WORKFLOW=$REQUIRED_WORKFLOW CI_REQUIRED=$REQUIRED_CHECKS python3 -I -c '
import json, os, sys
runs_doc, checks_doc = sys.argv[1], sys.argv[2]
sha, wf = os.environ["CI_SHA"], os.environ["CI_WORKFLOW"]
runs = [r for r in json.loads(runs_doc).get("workflow_runs", [])
        if r.get("path") == wf and r.get("event") == "push" and r.get("head_branch") == "main" and r.get("head_sha") == sha]
if not runs:
    print(f"ci: no push run of {wf} on main for {sha[:12]}"); sys.exit(1)
run = max(runs, key=lambda r: (r.get("run_attempt") or 0, r.get("id") or 0, r.get("created_at") or ""))
status, conclusion, suite, rid = run.get("status"), run.get("conclusion"), run.get("check_suite_id"), run.get("id")
print(f"ci: run {rid} of {wf}: {status}/{conclusion}")
ok = status == "completed" and conclusion == "success" and isinstance(suite, int)
checks = json.loads(checks_doc).get("check_runs", [])
for name in os.environ["CI_REQUIRED"].split("|"):
    mine = [c for c in checks if c.get("name") == name and (c.get("check_suite") or {}).get("id") == suite
            and (c.get("app") or {}).get("slug") == "github-actions" and c.get("head_sha") == sha]
    if not mine:
        print(f"ci: MISSING {name} in that run"); ok = False; continue
    last = max(mine, key=lambda c: (c.get("started_at") or "", c.get("id") or 0))
    good = last.get("status") == "completed" and last.get("conclusion") == "success"
    verdict = "ok" if good else "NOT GREEN"
    cst, ccon = last.get("status"), last.get("conclusion")
    print(f"ci: {verdict} {name} ({cst}/{ccon})")
    ok = ok and good
sys.exit(0 if ok else 1)
' "$runs" "$checks"
}

# ── The kit's interface: the ONE place that says how each step is called ──
# Everything here is an assumption about /root/st-deploy-kit that session A must check against the real kit
# before installing (README → "Para contrastar con el kit real"). 07-mint-ui-token.sh is deliberately absent: no
# name resolves to it.

# Release data keys st-ops reads (by regex, never evaluated; the kit validates the whole file in 01).
# P_DIST_FILE: 01 prints the line count and sha256 of that file, so it may only name a kit LOG's dist list.
P_DIST_FILE_RE='^/root/st-deploy-r[0-9]+-[0-9a-f]{7}-[0-9]{8}T[0-9]{6}Z/new-image-dist-all\.txt$'
STEP_ORDER=(backup offhost rollback-proof deploy acceptance)
STEP_DETACHED=" offhost deploy "   # write <LOG>/<result name>.result; their OK is read from there
STEP_EXCLUDABLE=" preflight deploy "   # accept --exclude-message <id>

# Sets STEP_ARGV for step $1 of request dir $2 (whose `log` file names the preflight's LOG). Run as the kit's own
# usage shows (`bash bin/0N-….sh …`, from the kit's directory). The data stays in OUR request dir: st-ops never
# writes into the kit. `--release-file` wants an absolute path to a root-owned, not group/other-writable
# `r<RELEASE>.conf` in a directory of the same kind (the request dir: 0700 under a 0700 state dir).
step_argv() {
	local log=''
	[[ -f $2/log ]] && log=$(<"$2/log")
	case $1 in
	preflight) STEP_ARGV=(bash bin/01-preflight.sh --release-file "$(data_file "$2")") ;;
	backup) STEP_ARGV=(bash bin/02-backup.sh "$log") ;;
	offhost) STEP_ARGV=(bash bin/02b-offhost.sh --detach "$log") ;;
	rollback-proof) STEP_ARGV=(bash bin/03-rollback-proof.sh "$log") ;;
	deploy) STEP_ARGV=(bash bin/04-deploy.sh --detach --then-accept "$log") ;;
	verify) STEP_ARGV=(bash bin/05-verify.sh "$log") ;;
	acceptance) STEP_ARGV=(bash bin/06-acp-acceptance.sh "$log") ;;
	*) return 1 ;;
	esac
}
# <LOG>/<name>.result of a detached step — and of verify and acceptance when the deploy's unit ran them.
step_result_name() {
	case $1 in
	offhost) echo 02b-offhost ;;
	deploy) echo 04-deploy ;;
	verify) echo 05-verify ;;
	acceptance) echo 06-acp-acceptance ;;
	esac
}

# One `KEY=value` line of the release data matching regex $3, printed; a missing or repeated key fails.
data_value() { # $1 = file, $2 = key, $3 = value regex
	local v
	[[ $(grep -c "^$2=" "$1") == 1 ]] || return 1
	v=$(grep "^$2=" "$1")
	v=${v#*=}
	[[ $v =~ $3 ]] && printf '%s' "$v"
}

# The exclusion the caller asked for, as argv (EXCLUDE), only if step $1 takes one and message $2 is provably the
# caller's own agent's running message.
exclude_args() { # $1 = step, $2 = message id or ''
	EXCLUDE=()
	[[ -n $2 ]] || return 0
	[[ $STEP_EXCLUDABLE == *" $1 "* ]] || die usage "$1 takes no message id"
	is_msg_id "$2" || die usage "invalid message id"
	[[ -n $ST_OPS_AGENT ]] || die message "identity $ST_OPS_IDENT has no agent"
	message_is_own_running "$2" "$ST_OPS_AGENT" || die message "message $2 is not proven to be a running message to $ST_OPS_AGENT"
	EXCLUDE=(--exclude-message "$2")
}

# Whether ACP message $1 (a validated integer) is `running`, addressed to agent $2, which exists, and owned by the
# kit's token owner. The dispatcher has no D1 access by design: it asks the kit's read-only `message-info.sh` and
# believes only an exact answer (contract of kit 17dd041) — anything else (rc ≠ 0, a missing or repeated key, another RESULT) is a refusal.
message_is_own_running() {
	local out rc
	set +e
	out=$(cd "$ST_OPS_KIT" && bash bin/message-info.sh "$1" </dev/null 2>/dev/null)
	rc=$?
	set -e
	[[ $rc == 0 && $(tail -n 1 <<<"$out") == "RESULT message-info OK rc=0" ]] || return 1
	[[ $(kv_field "$out" MESSAGE_ID) == "$1" && $(kv_field "$out" TO) == "$2" && $(kv_field "$out" STATE) == running &&
		$(kv_field "$out" AGENT_EXISTS) == yes && $(kv_field "$out" OWNER_IS_TOKEN_OWNER) == yes ]]
}
kv_field() { # $1 = text, $2 = key. Exactly one line `KEY=value`; prints value.
	[[ $(grep -c "^$2=" <<<"$1") == 1 ]] || return 1
	grep "^$2=" <<<"$1" | sed "s/^$2=//"
}

# ── Requests ─────────────────────────────────────────────────────────────

request_dir() { echo "$ST_OPS_STATE/requests/$1"; }
# The data as the kit wants it: `r<RELEASE>.conf`, the name 01 checks against the RELEASE inside.
data_file() { echo "$1/$(request_field "$1/request.txt" release).conf"; }

request_field() { # $1 = request file, $2 = key. Exactly one line `key: value`.
	[[ $(grep -cE "^$2: " "$1") == 1 ]] || return 1
	grep -E "^$2: " "$1" | sed "s/^$2: //"
}

# The approval code of a request: what the owner writes in Chat ("OK r16-847526e"). It names the release and the
# exact commit, so an "OK" for one release never approves another.
approval_code() { # $1 = request file
	local rel target
	rel=$(request_field "$1" release) && target=$(request_field "$1" target) || return 1
	printf '%s-%s' "$rel" "${target:0:7}"
}

# Clock slack between D1 (which stamps the message) and this host (which stamps the request).
APPROVAL_CLOCK_SLACK=120

# Whether ACP message $1 is the owner's approval of request dir $2 for agent $3. Like message_is_own_running, the
# dispatcher has no D1 access: it asks the kit's read-only `owner-approval.sh` and believes only an exact answer.
# What makes it the OWNER's: the backend writes from_id = owner only for a message sent with the owner's login
# (an agent's `st send` is stored under its own name, and `owner` is a reserved agent name). On top of the kit's
# own checks, the message must be newer than the request (an "OK" written before the proposal approves nothing)
# and not already used by another request.
owner_approves() { # $1 = message id, $2 = request dir, $3 = agent
	local out rc code created d
	code=$(approval_code "$2/request.txt") || return 1
	created=$(request_field "$2/request.txt" created-epoch) || return 1
	[[ $created =~ ^[0-9]+$ ]] || return 1
	set +e
	out=$(cd "$ST_OPS_KIT" && bash bin/owner-approval.sh "$1" "$3" "$code" </dev/null 2>/dev/null)
	rc=$?
	set -e
	[[ $rc == 0 && $(tail -n 1 <<<"$out") == "RESULT owner-approval OK rc=0" ]] || return 1
	[[ $(kv_field "$out" MESSAGE_ID) == "$1" && $(kv_field "$out" FROM) == owner && $(kv_field "$out" TO) == "$3" &&
		$(kv_field "$out" KIND) == request && $(kv_field "$out" AGENT_EXISTS) == yes &&
		$(kv_field "$out" OWNER_IS_TOKEN_OWNER) == yes && $(kv_field "$out" APPROVES_CODE) == yes ]] || return 1
	local at
	at=$(kv_field "$out" CREATED_EPOCH) && [[ $at =~ ^[0-9]+$ ]] || return 1
	((at + APPROVAL_CLOCK_SLACK >= created)) || return 1
	for d in "$ST_OPS_STATE"/requests/*/; do
		[[ -f $d/approved/message && $(<"$d/approved/message") == "$1" ]] && return 1
	done
	return 0
}

now_epoch() { date -u +%s; }

request_expired() {
	local exp
	exp=$(request_field "$1" expires-epoch) || return 0
	[[ $exp =~ ^[0-9]+$ ]] || return 0
	(($(now_epoch) >= exp))
}

# OK, FAIL, BUSY (the kit changed nothing: the same step may run again), RUNNING (started, outcome not known yet —
# or never, if it was killed: never retried) or NONE. `verify` is repeatable: its last run counts.
step_outcome() { # $1 = request dir, $2 = step
	local d=$1 rec res
	# verify and acceptance run by a verb (steps/…) count over the ones the deploy's unit ran: they came later.
	if [[ $2 == verify ]]; then cat "$d/steps/verify" 2>/dev/null || unit_outcome "$d" verify; return 0; fi
	if [[ ! -d $d/steps/$2.started ]]; then
		if [[ $2 == acceptance ]]; then unit_outcome "$d" acceptance; else echo NONE; fi
		return 0
	fi
	rec=$(cat "$d/steps/$2" 2>/dev/null || true)
	case $rec in
	OK) echo OK ;;
	LAUNCHED)
		res="$(<"$d/log")/$(step_result_name "$2").result"
		if [[ ! -f $res ]]; then echo RUNNING
		elif grep -qx 'RESULT=OK' "$res" && grep -qx 'RC=0' "$res"; then echo OK
		elif grep -qx 'RESULT=BUSY' "$res"; then echo BUSY
		else echo FAIL; fi ;;
	'') echo RUNNING ;;
	*) echo FAIL ;;
	esac
}

# One GO: the deploy's unit (kit 04 --then-accept) goes on by itself with 05 and, if it passed, 06 — nobody asks
# for them and no operator session has to outlive the backend restart. Their outcome is read from the kit's
# <LOG>/05-verify.result and 06-acp-acceptance.result; <LOG>/04-then-accept.result means the unit has ended.
# RUNNING = the deploy ended OK and the unit has not ended: 05 or 06 may be running, so neither is run by a verb
# (two acceptances at once would create test data twice) and the request cannot be cancelled. NONE = the unit
# ended without running that one (05 did not pass ⇒ 06 never ran): `verify` and `step acceptance` are the way on.
unit_outcome() { # $1 = request dir, $2 = verify|acceptance
	local d=$1 log res
	[[ -f $d/log && $(step_outcome "$d" deploy) == OK ]] || { echo NONE; return 0; }
	log=$(<"$d/log")
	res="$log/$(step_result_name "$2").result"
	if [[ -f $res ]]; then
		if grep -qx 'RESULT=OK' "$res" && grep -qx 'RC=0' "$res"; then echo OK; else echo FAIL; fi
	elif [[ -f $log/04-then-accept.result ]]; then echo NONE
	else echo RUNNING; fi
}

# A BUSY step is set back to "not run", its output kept aside: BUSY means the kit's gate changed nothing.
forget_busy() { # $1 = request dir, $2 = step
	mv "$1/steps/$2.out" "$1/steps/$2.busy-$(now_epoch).out" 2>/dev/null || true
	rm -f "$1/steps/$2"
	rmdir "$1/steps/$2.started"
}

approval_expired() { # $1 = request dir. The owner's approval holds for the request's `approval-valid-for` only.
	local at ttl
	[[ -e $1/approved ]] || return 1
	[[ -f $1/approved/at ]] || return 0
	at=$(<"$1/approved/at")
	ttl=$(request_field "$1/request.txt" approval-valid-for) || return 0
	[[ $at =~ ^[0-9]+$ && $ttl =~ ^[0-9]+s$ ]] || return 0
	(($(now_epoch) >= at + ${ttl%s}))
}

any_running() { # $1 = request dir
	local s
	for s in preflight "${STEP_ORDER[@]}"; do [[ $(step_outcome "$1" "$s") == RUNNING ]] && return 0; done
	return 1
}

# A request ends on its first failed step or its last OK one. Detached outcomes are only seen when read, so every
# verb settles first.
settle() { # $1 = request dir
	local d=$1 s
	[[ -e $d/closed ]] && return 0
	for s in preflight "${STEP_ORDER[@]}"; do
		[[ $(step_outcome "$d" "$s") == FAIL ]] && { echo "failed $s" >"$d/closed"; return 0; }
	done
	[[ $(step_outcome "$d" acceptance) == OK ]] && echo "done" >"$d/closed"
	return 0
}

request_state() { # $1 = request dir
	settle "$1"
	if [[ -e $1/cancelled ]]; then echo cancelled
	elif [[ -e $1/closed ]]; then echo "closed $(<"$1/closed")"
	elif [[ ! -e $1/approved ]] && request_expired "$1/request.txt"; then echo expired
	# An approved request left halfway stops blocking once its approval lapsed — unless a step's outcome is still
	# unknown: that one waits for root.
	elif approval_expired "$1" && ! any_running "$1"; then echo "expired (approval)"
	else echo active; fi
}

# The single active request, if any: one at a time keeps "what did the owner approve" unambiguous.
active_request() {
	local d
	for d in "$ST_OPS_STATE"/requests/*/; do
		[[ -d $d ]] || continue
		[[ $(request_state "${d%/}") == active ]] && { basename "$d"; return 0; }
	done
	return 1
}

open_request() { # $1 = id; sets D, refuses anything but an active request
	is_request_id "$1" || die usage "invalid request id"
	D=$(request_dir "$1")
	[[ -f $D/request.txt ]] || die request "no such request"
	local st
	st=$(request_state "$D")
	[[ $st == active ]] || die request "request is $st"
}

# What runs is what the owner approved: the kit at the request's commit and the data with the request's hash — the
# copy this server keeps and, once preflight froze them, the LOG's copies too.
assert_request_inputs() { # $1 = request dir
	local d=$1 sum head log
	sum=$(request_field "$d/request.txt" release-conf-sha256)
	head=$(request_field "$d/request.txt" kit-head)
	[[ $(kit_head) == "$head" ]] || die kit "the kit is not at the request's commit $head"
	[[ -f $(data_file "$d") && $(sha256sum <"$(data_file "$d")" | cut -d' ' -f1) == "$sum" ]] || die data "the release data differs from the request's"
	[[ -f $d/log ]] || return 0
	log=$(<"$d/log")
	frozen_ok "$log" "$sum" "$head" || die data "$log does not hold the request's data and kit commit"
}
# The copies preflight froze in its LOG (the later steps read those): release.conf = the request's bytes, run.conf
# names the request's kit commit.
frozen_ok() { # $1 = LOG, $2 = the request's data sha256, $3 = its kit-head
	[[ -f $1/release.conf && $(sha256sum <"$1/release.conf" | cut -d' ' -f1) == "$2" ]] &&
		[[ -f $1/run.conf && $(grep -cx "KIT_HEAD=$3" "$1/run.conf") == 1 && $(grep -cx "RELEASE_CONF_SHA256=$2" "$1/run.conf") == 1 ]]
}

run_kit() { # $1 = request dir, $2 = step, rest = extra args; sets STEP_RC and KIT_OUTCOME (OK|BUSY|FAIL)
	local d=$1 s=$2 last
	shift 2
	step_argv "$s" "$d" || die usage "unknown step"
	trap '' HUP
	set +e
	(cd "$ST_OPS_KIT" && "${STEP_ARGV[@]}" "$@" </dev/null 2>&1) | tee -p "$d/steps/$s.out"
	STEP_RC=${PIPESTATUS[0]}
	set -e
	last=$(tail -n 1 "$d/steps/$s.out")
	if [[ ! $last =~ ^RESULT\ [^\ ]+\ (OK|FAIL|USAGE|BUSY)\ rc=[0-9]+$ ]]; then
		echo "st-ops: RESULT $s FAIL rc=$STEP_RC (the kit printed no RESULT line)"
		((STEP_RC != 0)) || STEP_RC=1
	fi
	if ((STEP_RC == 0)) && [[ $last =~ \ OK\ rc=0$ ]]; then KIT_OUTCOME=OK
	elif ((STEP_RC == 3)) && [[ $last =~ \ BUSY\ rc=3$ ]]; then KIT_OUTCOME=BUSY
	else KIT_OUTCOME=FAIL; fi
}

# Runs one kit step at most once (a BUSY answer excepted): its output goes to the caller as it comes (and to
# steps/<step>.out), the verb's exit code is the kit's. SIGHUP is ignored so a dropped SSH connection does not kill
# a backup halfway (the kit inherits the ignored signal); tee -p keeps the file.
run_step() { # $1 = request dir, $2 = step, rest = extra args
	local d=$1 s=$2
	shift 2
	mkdir "$d/steps/$s.started" || die order "$s already ran for this request"
	run_kit "$d" "$s" "$@"
	case $KIT_OUTCOME in
	OK) if [[ $STEP_DETACHED == *" $s "* ]]; then echo LAUNCHED >"$d/steps/$s"; else echo OK >"$d/steps/$s"; fi ;;
	BUSY) forget_busy "$d" "$s"; echo "st-ops: $s answered BUSY (nothing changed): run it again later" ;;
	*) echo "FAIL rc=$STEP_RC" >"$d/steps/$s" ;;
	esac
}

with_lock() {
	exec 9>"$ST_OPS_STATE/st-ops.lock"
	flock -n 9 || die busy "another st-ops operation is running"
}

# ── Verbs ────────────────────────────────────────────────────────────────

verb_help() {
	cat <<'TXT'
st-ops verbs:
  help | status                       read-only
  propose                             new request; release data on stdin; prints it and its approval code
  request-text <id>                   the request as proposed
  preflight <id> [<message id>]       kit 01 with the request's data; records its LOG
  approve <id> <message id>           the owner's chat message "OK <code>" to this agent; enables the writing steps
  step <id> <step> [<message id>]     next step, in order: backup offhost rollback-proof deploy [acceptance]
                                      deploy goes on by itself with verify and acceptance: read `result`
  verify <id>                         kit 05 (read-only), after deploy OK; repeatable. Only needed, with
                                      `step <id> acceptance`, when the deploy's own verify did not pass
  result <id> [<step>]                state of a request; the .result of offhost, deploy, verify, acceptance
  cancel <id>                         close a request (refused while a step's outcome is unknown)
TXT
}

verb_status() {
	local img=unknown
	echo "kit-head: $(kit_head || echo '?')"
	if [[ -n $COMPOSE_PROJECT ]] && command -v docker >/dev/null; then
		img=$(docker ps --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" --filter label=com.docker.compose.service=app \
			--format '{{.Image}} {{.ID}}' 2>/dev/null | head -1)
	fi
	echo "deployed-app: ${img:-not running}"
	echo "write-verbs: $WRITE_VERBS"
	local d last=''
	# Request ids start with their UTC time: the glob's (sorted) last one is the newest.
	for d in "$ST_OPS_STATE"/requests/*/; do [[ -d $d ]] && last=$(basename "$d"); done
	if [[ -n $last ]]; then echo "last-request: $last $(request_state "$(request_dir "$last")")"; else echo "last-request: none"; fi
}

verb_propose() {
	(($# == 0)) || die usage "propose   (release data on stdin)"
	local tmp from target rel sum head ci now exp id d n line
	with_lock
	id=$(active_request) && die pending "request $id is active (cancel it or finish it first)"
	mkdir -p "$ST_OPS_STATE/requests"
	tmp=$(mktemp "$ST_OPS_STATE/propose.XXXXXX")
	head -c 16385 >"$tmp"
	n=$(wc -c <"$tmp")
	((n > 0 && n <= 16384)) || { rm -f "$tmp"; die data "release data must be 1..16384 bytes"; }
	# ASCII only: no control bytes, no bidi or look-alike characters in a text the owner signs.
	n=$(LC_ALL=C grep -nm1 '[^[:print:]]' "$tmp" | cut -d: -f1 || true)
	[[ -z $n ]] || { rm -f "$tmp"; die data "non-ASCII or control byte at line $n (release data is ASCII)"; }
	rel=$(data_value "$tmp" RELEASE '^[1-9][0-9]{0,3}$') || { rm -f "$tmp"; die data "need exactly one RELEASE=<1-9999>"; }
	from=$(data_value "$tmp" FROM '^[0-9a-f]{40}$') || { rm -f "$tmp"; die data "need exactly one FROM=<40 hex>"; }
	target=$(data_value "$tmp" TARGET '^[0-9a-f]{40}$') || { rm -f "$tmp"; die data "need exactly one TARGET=<40 hex>"; }
	data_value "$tmp" P_DIST_FILE "$P_DIST_FILE_RE" >/dev/null || { rm -f "$tmp"; die data "P_DIST_FILE must be one line naming <kit LOG>/new-image-dist-all.txt"; }
	sum=$(sha256sum <"$tmp" | cut -d' ' -f1)
	head=$(kit_head) && is_sha "$head" || { rm -f "$tmp"; die kit "cannot read the kit's commit"; }
	mirror_fetch
	mirror cat-file -e "$target^{commit}" 2>/dev/null || { rm -f "$tmp"; die provenance "$target is not in $REPO_URL"; }
	on_main "$target" || { rm -f "$tmp"; die provenance "$target is not on main's first-parent history"; }
	[[ $from != "$target" ]] && mirror merge-base --is-ancestor "$from" "$target" 2>/dev/null ||
		{ rm -f "$tmp"; die provenance "$target does not descend from $from (rollbacks are not st-ops verbs)"; }
	ci=$(ci_green "$target") || { rm -f "$tmp"; die ci "CI is not green on $target: $(tr '\n' ' ' <<<"$ci")"; }
	now=$(now_epoch)
	exp=$((now + REQUEST_TTL))
	id="$(date -u -d "@$now" +%Y%m%dT%H%M%SZ)-${target:0:12}"
	d=$(request_dir "$id")
	mkdir "$d" "$d/steps" || { rm -f "$tmp"; die busy "request id $id exists"; }
	chmod 0700 "$d"
	mv "$tmp" "$d/r$rel.conf"
	chmod 0600 "$d/r$rel.conf"
	{
		echo "st-ops kit request v1"
		echo "id: $id"
		echo "host: $(hostname)"
		echo "requested-by: $ST_OPS_IDENT"
		echo "release: r$rel"
		echo "release-conf-sha256: $sum"
		echo "from: $from"
		echo "target: $target"
		echo "kit-head: $head"
		echo "compare: ${REPO_URL%.git}/compare/$from...$target"
		# Indented (never a `key: ` line) and printable-only: commit subjects are the operator's text.
		echo "commits (first-parent, $(mirror rev-list --first-parent --count "$from..$target")):"
		mirror log --first-parent --format='%h %s' "$from..$target" | head -100 | LC_ALL=C tr -c '[:print:]\n' '?' | sed 's/^/  /'
		echo "ci:"
		while IFS= read -r line; do echo "  $line"; done <<<"$ci"
		echo "runs-as: root (kit $ST_OPS_KIT at kit-head: preflight backup offhost rollback-proof deploy verify acceptance)"
		echo "release-conf:"
		sed 's/^/  /' "$d/r$rel.conf"
		echo "approval-valid-for: ${APPROVAL_TTL}s"
		echo "approval-code: r$rel-${target:0:7}"
		echo "created: $(date -u -d "@$now" +%FT%TZ)"
		echo "created-epoch: $now"
		echo "expires: $(date -u -d "@$exp" +%FT%TZ)"
		echo "expires-epoch: $exp"
	} >"$d/request.txt"
	chmod 0644 "$d/request.txt"
	echo "Request $id created:"
	echo "-----8<-----"
	cat "$d/request.txt"
	echo "-----8<-----"
	echo "Owner:            a chat message to the operator saying: OK r$rel-${target:0:7}"
	echo "Operator:         ssh st-ops approve $id <id of that message>"
}

verb_request_text() {
	(($# == 1)) && is_request_id "$1" || die usage "request-text <id>"
	[[ -f $(request_dir "$1")/request.txt ]] || die request "no such request"
	cat "$(request_dir "$1")/request.txt"
}

verb_preflight() {
	(($# == 1 || $# == 2)) || die usage "preflight <id> [<message id>]"
	local log rel
	with_lock
	open_request "$1"
	assert_request_inputs "$D"
	exclude_args preflight "${2:-}"
	run_step "$D" preflight "${EXCLUDE[@]}"
	[[ $KIT_OUTCOME == OK ]] || return "$STEP_RC"
	local target
	target=$(request_field "$D/request.txt" target)
	rel=$(request_field "$D/request.txt" release)
	log=$(grep -E '^LOG=' "$D/steps/preflight.out" | tail -1 || true)
	log=${log#LOG=}
	# The LOG must be the kit's own new directory for THIS target, owned by us (root), holding the request's data.
	if [[ ${log%/*} == "$ST_OPS_LOG_BASE" && ${log##*/} =~ ^st-deploy-${rel}-${target:0:7}-[0-9]{8}T[0-9]{6}Z$ &&
		-d $log && ! -L $log && $(stat -c %u "$log") == "$EUID" ]] &&
		frozen_ok "$log" "$(request_field "$D/request.txt" release-conf-sha256)" "$(request_field "$D/request.txt" kit-head)"; then
		echo "$log" >"$D/log"
		echo "st-ops: LOG recorded for $1"
	else
		echo "FAIL no valid LOG" >"$D/steps/preflight"
		echo "st-ops: preflight gave no valid LOG for this request (see README): the request is closed"
		settle "$D"
		return 1
	fi
}

verb_approve() {
	(($# == 2)) || die usage "approve <id> <message id>   (the owner's chat message: OK <approval code>)"
	[[ $WRITE_VERBS == on ]] || die disabled "write verbs are off on this host (install stage 1)"
	is_request_id "$1" || die usage "invalid request id"
	is_msg_id "$2" || die usage "invalid message id"
	[[ -n $ST_OPS_AGENT ]] || die message "identity $ST_OPS_IDENT has no agent: only an agent's owner can approve to it"
	with_lock
	open_request "$1"
	[[ -e $D/approved ]] && die request "already approved (an approval is used once)"
	[[ -f $D/request.txt && -n $(request_field "$D/request.txt" created-epoch) ]] ||
		die request "a request proposed before the chat approval: propose it again"
	owner_approves "$2" "$D" "$ST_OPS_AGENT" ||
		die approval "message $2 is not the owner's \"OK $(approval_code "$D/request.txt")\" to $ST_OPS_AGENT written after the proposal"
	assert_request_inputs "$D"
	mkdir "$D/approved"
	now_epoch >"$D/approved/at"
	echo "$2" >"$D/approved/message"
	echo "approved $1 by the owner's message $2 for $(request_field "$D/request.txt" approval-valid-for): next step is backup"
}

verb_step() {
	(($# == 2 || $# == 3)) || die usage "step <id> <step> [<message id>]"
	[[ $WRITE_VERBS == on ]] || die disabled "write verbs are off on this host (install stage 1)"
	local s=$2 msg=${3:-} i prev=preflight
	with_lock
	open_request "$1"
	for ((i = 0; i < ${#STEP_ORDER[@]}; i++)); do [[ ${STEP_ORDER[i]} == "$s" ]] && break; prev=${STEP_ORDER[i]}; done
	((i < ${#STEP_ORDER[@]})) || die usage "unknown step (steps: ${STEP_ORDER[*]})"
	[[ -e $D/approved ]] || die approval "request not approved by the owner"
	approval_expired "$D" && die approval "the owner's approval lapsed: propose a new request"
	# 05 compares against 01's snapshots and 06 creates test data: verify must pass between deploy and acceptance.
	[[ $s == acceptance ]] && prev=verify
	[[ $(step_outcome "$D" "$prev") == OK ]] || die order "$prev has not finished OK"
	case $(step_outcome "$D" "$s") in
	NONE) ;;
	BUSY) forget_busy "$D" "$s" ;;
	*) die order "$s already ran for this request" ;;
	esac
	assert_request_inputs "$D"
	exclude_args "$s" "$msg"
	run_step "$D" "$s" "${EXCLUDE[@]}"
	[[ $s == deploy && $KIT_OUTCOME == OK ]] && echo "st-ops: the unit goes on by itself with verify and acceptance once the deploy ends OK: read \`result $1\`"
	settle "$D"
	return "$STEP_RC"
}

verb_verify() {
	(($# == 1)) && is_request_id "$1" || die usage "verify <id>"
	with_lock
	D=$(request_dir "$1")
	[[ -f $D/request.txt ]] || die request "no such request"
	[[ $(step_outcome "$D" deploy) == OK ]] || die order "deploy has not finished OK"
	[[ $(unit_outcome "$D" acceptance) == RUNNING ]] && die order "the deploy's unit is still running its own verify and acceptance: read \`result $1\`"
	assert_request_inputs "$D"
	run_kit "$D" verify
	if [[ $KIT_OUTCOME == OK ]]; then echo OK >"$D/steps/verify"; else echo "FAIL rc=$STEP_RC" >"$D/steps/verify"; fi
	return "$STEP_RC"
}

verb_result() {
	(($# == 1 || $# == 2)) && is_request_id "$1" || die usage "result <id> [<step>]"
	local d s
	d=$(request_dir "$1")
	[[ -f $d/request.txt ]] || die request "no such request"
	echo "state: $(request_state "$d")"
	echo "approved: $([[ -e $d/approved ]] && echo yes || echo no)"
	[[ -f $d/log ]] && echo "log: $(<"$d/log")"
	for s in preflight backup offhost rollback-proof deploy verify acceptance; do echo "step $s: $(step_outcome "$d" "$s")"; done
	if (($# == 2)); then
		[[ -n $(step_result_name "$2") ]] || die usage "steps with a .result: offhost deploy verify acceptance"
		[[ -f $d/log && -f $(<"$d/log")/$(step_result_name "$2").result ]] || die result "no .result yet"
		cat "$(<"$d/log")/$(step_result_name "$2").result"
	fi
}

verb_cancel() {
	(($# == 1)) || die usage "cancel <id>"
	local s
	with_lock
	open_request "$1"
	# Any time, so a request left halfway (a verify that failed on a kit bug, a deploy judged good by hand) does not
	# block the next one until its approval lapses. Never while a step's outcome is unknown: that one is root's.
	any_running "$D" && die request "a step's outcome is still unknown (RUNNING): root reviews it"
	local ran=''
	for s in preflight "${STEP_ORDER[@]}"; do [[ $(step_outcome "$D" "$s") == NONE ]] || ran+=" $s"; done
	mkdir "$D/cancelled"
	echo "by $ST_OPS_IDENT at $(now_epoch); steps run:${ran:- none}" >"$D/cancelled/note"
	echo "cancelled $1 (steps run:${ran:- none})"
}

st_ops_main() {
	local fp=${1:-} a
	shift || true
	ST_OPS_VERB=${1:-help}
	shift || true
	ST_OPS_ARGS="$*"
	trap 'st_ops_audit "rc=$? ${ST_OPS_CODE:+code=$ST_OPS_CODE}"' EXIT
	[[ $ST_OPS_VERB =~ ^[a-z-]{1,20}$ ]] || { ST_OPS_VERB=invalid; die usage "invalid verb"; }
	for a in "$@"; do [[ $a =~ ^[A-Za-z0-9._:-]{1,80}$ ]] || { ST_OPS_ARGS=invalid; die usage "invalid argument"; }; done
	resolve_ident "$fp"
	mkdir -p "$ST_OPS_STATE"
	chmod 0700 "$ST_OPS_STATE"
	load_conf
	STEP_RC=0
	case $ST_OPS_VERB in
	help) verb_help ;;
	status) verb_status ;;
	propose) verb_propose "$@" ;;
	request-text) verb_request_text "$@" ;;
	preflight) verb_preflight "$@" ;;
	approve) verb_approve "$@" ;;
	step) verb_step "$@" ;;
	verify) verb_verify "$@" ;;
	result) verb_result "$@" ;;
	cancel) verb_cancel "$@" ;;
	*) die usage "unknown verb (try: help)" ;;
	esac
}

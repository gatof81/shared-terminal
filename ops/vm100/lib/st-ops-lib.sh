# st-ops-lib.sh — shared functions of st-ops (sourced by st-ops-root and st-ops-deploy-run; ops/vm100/README.md).
# The caller sets ST_OPS_ETC, ST_OPS_STATE and ST_OPS_LIB before sourcing; the tests point them at a temp dir.
# shellcheck shell=bash

# ── Output ───────────────────────────────────────────────────────────────

# Every refusal is one line, `ERROR <code>: <text>`, exit 2: the operator (B) reads the code, the owner the text.
die() {
	echo "ERROR $1: $2" >&2
	st_ops_audit "rc=2 code=$1"
	exit 2
}

ST_OPS_IDENT=unknown
ST_OPS_VERB=none
st_ops_audit() {
	logger -t st-ops -- "ident=$ST_OPS_IDENT verb=$ST_OPS_VERB $*" 2>/dev/null || true
}

# ── Validation ───────────────────────────────────────────────────────────

is_sha() { [[ $1 =~ ^[0-9a-f]{40}$ ]]; }
is_request_id() { [[ $1 =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$ ]]; }

# deploy.conf is parsed, never sourced: only these keys, plain values.
load_conf() {
	local f="$ST_OPS_ETC/deploy.conf" k v
	[[ -f $f ]] || die conf "missing $f"
	REPO_URL='' ST_DIR='' COMPOSE_PROJECT='' REQUIRED_WORKFLOW='' REQUIRED_CHECKS='' REQUEST_TTL='' MIN_FREE_KIB=''
	while IFS='=' read -r k v; do
		[[ -z $k || $k == \#* ]] && continue
		v=${v#\"}; v=${v%\"}
		case $k in
		REPO_URL) [[ $v =~ ^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\.git$ ]] || die conf "REPO_URL"; REPO_URL=$v ;;
		ST_DIR) [[ $v =~ ^/[A-Za-z0-9._/-]+$ ]] || die conf "ST_DIR"; ST_DIR=$v ;;
		COMPOSE_PROJECT) [[ $v =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || die conf "COMPOSE_PROJECT"; COMPOSE_PROJECT=$v ;;
		REQUIRED_WORKFLOW) [[ $v =~ ^\.github/workflows/[A-Za-z0-9._-]+\.ya?ml$ ]] || die conf "REQUIRED_WORKFLOW"; REQUIRED_WORKFLOW=$v ;;
		REQUIRED_CHECKS) REQUIRED_CHECKS=$v ;;
		REQUEST_TTL) [[ $v =~ ^[0-9]{2,6}$ ]] || die conf "REQUEST_TTL"; REQUEST_TTL=$v ;;
		MIN_FREE_KIB) [[ $v =~ ^[0-9]{1,12}$ ]] || die conf "MIN_FREE_KIB"; MIN_FREE_KIB=$v ;;
		*) die conf "unknown key $k" ;;
		esac
	done <"$f"
	[[ -n $REPO_URL && -n $ST_DIR && -n $COMPOSE_PROJECT && -n $REQUIRED_WORKFLOW && -n $REQUIRED_CHECKS && -n $REQUEST_TTL && -n $MIN_FREE_KIB ]] || die conf "incomplete"
}

# identities: `<name> <SHA256:fingerprint>` per line. A key that is not listed gets nothing, even if sshd let it in.
resolve_ident() {
	local fp=$1 name f
	[[ $fp =~ ^SHA256:[A-Za-z0-9+/]{43}$ ]] || die denied "fingerprint"
	while read -r name f; do
		[[ -z $name || $name == \#* ]] && continue
		if [[ $f == "$fp" && $name =~ ^[a-z0-9-]{1,32}$ ]]; then
			ST_OPS_IDENT=$name
			return 0
		fi
	done <"$ST_OPS_ETC/identities"
	die denied "unknown key"
}

# ── Git: provenance is established by the server, from the public repo ──

# A root-owned bare mirror, fetched over anonymous HTTPS. Nothing the caller or the diego-owned checkout says
# about history is believed.
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
# SHA — found early, the normal case — reads as "not on main" once the history outgrows the pipe buffer. Only with
# the default SIGPIPE disposition (sshd, systemd-run); a caller that ignores SIGPIPE hides it.
on_main() {
	mirror rev-list --first-parent -n 20000 refs/heads/main | grep -x "$1" >/dev/null
}

# Root never runs git inside the diego-owned checkout: its .git/config and hooks (core.fsmonitor, filters,
# post-checkout, …) are diego's, and running them as root would hand that account root through st-ops. Whatever
# is read or done there runs AS diego, which grants nothing diego does not already have.
as_owner_of_checkout() {
	local uid
	uid=$(stat -c %u "$ST_DIR") || return 1
	# A root-owned checkout would make "as its owner" mean root: refuse rather than run its git as root.
	[[ $uid =~ ^[0-9]+$ && $uid != 0 ]] || {
		echo "st-ops: $ST_DIR is owned by uid $uid; refusing to run git there as root" >&2
		return 1
	}
	local user
	user=$(getent passwd "$uid" | cut -d: -f1)
	[[ -n $user ]] || return 1
	runuser -u "$user" -- "$@"
}
checkout_head() { as_owner_of_checkout git -C "$ST_DIR" rev-parse HEAD; }

app_container() {
	docker ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" --filter label=com.docker.compose.service=app | head -1
}

# The deployed SHA is the label st-ops puts on the image it builds (`<sha> image-label`). Without one — the first
# st-ops deploy, or after a manual deploy — the only answer is the checkout's HEAD (`<sha> checkout-head`), which
# is NOT proof of what runs: "merged and pulled, deploy pending" is a normal state here. Callers must treat that
# source as unverified (no automatic rollback: the migration jump computed from it may be wrong).
APP_SHA_LABEL=io.shared-terminal.st-ops.sha
deployed_info() {
	local cid img sha
	cid=$(app_container)
	if [[ -n $cid ]]; then
		img=$(docker inspect "$cid" --format '{{.Image}}')
		sha=$(docker image inspect "$img" --format "{{index .Config.Labels \"$APP_SHA_LABEL\"}}" 2>/dev/null || true)
		if is_sha "$sha"; then
			echo "$sha image-label"
			return 0
		fi
	fi
	sha=$(checkout_head) || return 1
	echo "$sha checkout-head"
}
deployed_sha() {
	local info
	info=$(deployed_info) || return 1
	echo "${info%% *}"
}

# Facts about the running backend come from Docker, never from parsing .env (a comment, an `export`, a duplicate
# line would make a parse disagree with what compose resolved): the workspace root is the host side of the bind
# the app mounts at /var/shared-terminal/workspaces, the API port is the host port published for 3001/tcp.
APP_WORKSPACE_MOUNT=/var/shared-terminal/workspaces
app_workspace_root() { # $1 = container
	local src
	src=$(docker inspect "$1" --format "{{range .Mounts}}{{if eq .Destination \"$APP_WORKSPACE_MOUNT\"}}{{.Source}}{{end}}{{end}}") || return 1
	[[ $src =~ ^/[A-Za-z0-9._/-]+$ && -d $src ]] || return 1
	echo "$src"
}
app_api_port() { # $1 = container
	local p
	p=$(docker inspect "$1" --format '{{with index .NetworkSettings.Ports "3001/tcp"}}{{(index . 0).HostPort}}{{end}}') || return 1
	[[ $p =~ ^[0-9]{2,5}$ ]] || return 1
	echo "$p"
}

# v1 scope = backend code only, as an ALLOWLIST: the image st-ops builds is Dockerfile + backend/ of the SHA,
# run with the compose definition that is already deployed. Anything that could change what is built or how it
# runs outside backend/src — Dockerfile, compose, dependencies, the session image, a new top-level file — is
# refused, so what is deployed is exactly what the owner signed. Those changes stay manual deploys.
ALLOWED_PATHS_RE='^(backend/src/|backend/(tsconfig\.json|biome\.json|vitest\.config\.ts)$|frontend/|docs/|\.github/|ops/|[A-Za-z0-9_-]+\.md$|LICENSE$|\.gitignore$|\.env\.example$)'
# Allowed, but the owner must see them in the text they sign.
SENSITIVE_RE='^(\.github/|backend/src/db\.ts$|ops/)'

# Prints the changed paths outside the allowlist (empty = in scope).
scope_violations() { grep -vE "$ALLOWED_PATHS_RE" <<<"$1" | grep -v '^$' || true; }

# Automatic rollback is safe only when the schema cannot have moved: a migration may have run (fully, or
# partially — the ledger row is written after apply()) before the new backend failed, and the old code boots
# against any newer schema without checking compatibility (migrateDb skips unknown versions). So: any
# migration in the jump ⇒ no automatic rollback, the owner decides with the fresh backup at hand.
rollback_policy() { # $1 = migration version at from, $2 = at sha, $3 = how `from` is known (deployed_info)
	if [[ ${3:-} == image-label && $1 =~ ^[0-9]+$ && $2 =~ ^[0-9]+$ && $1 == "$2" ]]; then
		echo previous-image
	else
		echo withheld
	fi
}

# --no-renames: with rename detection `--name-only` prints only the NEW side, so moving a refused file (e.g.
# `.dockerignore`) under docs/ would pass the allowlist. Both sides of every change are checked.
changed_paths() { mirror diff --no-renames --name-only "$1" "$2"; }

migration_version() {
	mirror show "$1:backend/src/db.ts" 2>/dev/null | grep -oE 'version: [0-9]+' | tail -1 | grep -oE '[0-9]+' || echo "?"
}

# ── CI: the required workflow's own push run on main, public API ─────────

gh_api() { # $1 = path under /repos/<owner>/<repo>/
	local repo=${REPO_URL#https://github.com/}
	repo=${repo%.git}
	timeout 30 curl -sf -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$repo/$1"
}
fetch_workflow_runs() { gh_api "actions/runs?head_sha=$1&event=push&branch=main&per_page=100"; }
fetch_check_runs() { gh_api "commits/$1/check-runs?per_page=100"; }

# A check-run's name — even with the github-actions app — is not identity: any workflow job with `checks: write`
# can post a "success" check-run with any name on any SHA, and the operator (B) can push workflows. So a required
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

# ── Requests and the owner's signature ──────────────────────────────────

# The owner signs the exact bytes of request.txt with their personal key (ssh-keygen -Y sign, namespace below).
# The approval is bound to one request id, hence to one SHA, tree, scope and starting SHA, and it expires.
# GitHub cannot carry this approval: the operator sessions act on GitHub as the owner's account.
SIGN_NAMESPACE=st-ops-deploy@shared-terminal

request_dir() { echo "$ST_OPS_STATE/requests/$1"; }

request_field() {
	# $1 = request file, $2 = key. Exactly one line `key: value`.
	local v
	v=$(grep -E "^$2: " "$1" | sed "s/^$2: //")
	[[ $(grep -cE "^$2: " "$1") == 1 ]] || return 1
	printf '%s' "$v"
}

verify_signature() {
	# $1 = request file, $2 = signature file. Only the `owner` principal of allowed_signers, only our namespace.
	ssh-keygen -Y verify -f "$ST_OPS_ETC/allowed_signers" -I owner -n "$SIGN_NAMESPACE" -s "$2" <"$1" >/dev/null 2>&1 && return 0
	return 1
}

now_epoch() { date -u +%s; }

request_expired() {
	local exp
	exp=$(request_field "$1" expires-epoch) || return 0
	[[ $exp =~ ^[0-9]+$ ]] || return 0
	(($(now_epoch) >= exp))
}

# The single pending request, if any (one at a time keeps "what did the owner approve" unambiguous).
pending_request() {
	local d id
	for d in "$ST_OPS_STATE"/requests/*/; do
		[[ -d $d ]] || continue
		id=$(basename "$d")
		[[ -e $d/used || -e $d/cancelled ]] && continue
		request_expired "$d/request.txt" && continue
		echo "$id"
		return 0
	done
	return 1
}

# ── Locks ────────────────────────────────────────────────────────────────

# One st-ops mutation at a time (request creation, deploy start, cancel). The deploy pipeline holds its own lock
# for its whole run, so `deploy` refuses while another deploy is running.
with_lock() {
	exec 9>"$ST_OPS_STATE/st-ops.lock"
	flock -n 9 || die busy "another st-ops operation is running"
}
deploy_running() {
	local u
	u=$(systemctl list-units --plain --no-legend 'st-ops-deploy-*' 2>/dev/null | awk '$3 == "active" { print $1 }')
	[[ -n $u ]]
}

# ── Verbs ────────────────────────────────────────────────────────────────

verb_help() {
	cat <<'TXT'
st-ops verbs:
  help                              this text
  status                            deployed SHA, health, disk, backups, sessions (read-only)
  logs [lines]                      tail of the backend log (<= 500 lines)
  request-deploy <sha>              prepare a backend deploy of <sha>; prints the text the owner signs
  deploy <id>                       start a signed request; the owner's signature is read from stdin
  request-text <id>                 the exact bytes of a request (save as request.txt for the owner to sign)
  deploy-status <id>                progress and result of a request
  cancel <id>                       withdraw a pending request
TXT
}

verb_status() {
	local sha health
	sha=$(deployed_sha 2>/dev/null || echo "?")
	echo "deployed: $sha"
	if is_sha "$sha" && [[ -d $ST_OPS_STATE/mirror.git ]] && on_main "$sha"; then echo "deployed-on-main: yes (mirror)"; else echo "deployed-on-main: unknown/no"; fi
	local cid port
	cid=$(app_container)
	port=$( [[ -n $cid ]] && app_api_port "$cid" || true)
	health=$( [[ -n $port ]] && timeout 5 curl -s "http://localhost:$port/health" || true)
	echo "health: ${health:-unreachable}"
	# A deploy killed between `docker tag` and `compose up` (or by a reboot) leaves :latest naming another image
	# than the one running: the next manual `compose up` would start unverified code.
	if [[ -n $cid && $(docker image inspect "$COMPOSE_PROJECT-app:latest" --format '{{.Id}}' 2>/dev/null) != "$(docker inspect "$cid" --format '{{.Image}}')" ]]; then
		echo "WARNING: $COMPOSE_PROJECT-app:latest is not the running image (interrupted deploy or manual build)"
	fi
	echo "disk-free-kib: $(df --output=avail -k /var/lib/docker | tail -1 | tr -d ' ')"
	docker ps -a --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" --format 'compose: {{.Label "com.docker.compose.service"}} {{.State}} {{.Status}}'
	docker ps -a --filter name=^/st- --format 'session: {{.Names}} {{.State}} {{.Status}}' | sort
	local wr bk
	wr=$( [[ -n $cid ]] && app_workspace_root "$cid" || true)
	bk=$( [[ -n $wr ]] && ls -1d "$wr"/.backups/20* 2>/dev/null | sort | tail -1)
	echo "last-nightly-backup: ${bk:+$(basename "$bk")} manifest=$([[ -s $bk/manifest.json ]] && echo yes || echo NO)"
	echo "last-offhost: $(grep -E 'off-host' /home/diego/shared-terminal-backup.log 2>/dev/null | tail -1 || echo '?')"
	echo "pending-request: $(pending_request || echo none)"
}

verb_logs() {
	local n=${1:-200}
	[[ $n =~ ^[0-9]{1,3}$ ]] && ((n >= 1 && n <= 500)) || die usage "logs [1-500]"
	local cid
	cid=$(app_container)
	[[ -n $cid ]] || die state "app container not running"
	docker logs --timestamps --tail "$n" "$cid" 2>&1
}

verb_request_deploy() {
	local sha=${1:-} info from source tree d id now exp paths sens out mfrom mto commits rollback
	(($# <= 1)) || die usage "request-deploy <40-hex sha>   (v1 has a single scope: backend code)"
	is_sha "$sha" || die usage "request-deploy <40-hex sha>"
	with_lock
	pending_request >/dev/null && die pending "a request is already pending: $(pending_request) (cancel it first)"
	deploy_running && die busy "a deploy is running"
	mirror_fetch
	mirror cat-file -e "$sha^{commit}" 2>/dev/null || die sha "$sha is not in $REPO_URL"
	on_main "$sha" || die provenance "$sha is not on main's first-parent history"
	info=$(deployed_info) || die state "cannot read the deployed SHA"
	from=${info%% *}
	source=${info#* }
	is_sha "$from" || die state "cannot read the deployed SHA"
	[[ $from != "$sha" ]] || die state "$sha is already deployed"
	mirror cat-file -e "$from^{commit}" 2>/dev/null || die provenance "the deployed SHA $from is not in the public repo: deploy manually"
	mirror merge-base --is-ancestor "$from" "$sha" || die provenance "$sha does not descend from the deployed $from (rollbacks are not st-ops verbs)"
	ci_green "$sha" || die ci "CI is not green on $sha"
	tree=$(mirror rev-parse "$sha^{tree}")
	paths=$(changed_paths "$from" "$sha")
	out=$(scope_violations "$paths" | head -20 | paste -sd, -)
	[[ -z $out ]] || die scope "outside the v1 backend scope (deploy those manually): $out"
	sens=$(grep -E "$SENSITIVE_RE" <<<"$paths" | paste -sd, - || true)
	mfrom=$(migration_version "$from")
	mto=$(migration_version "$sha")
	commits=$(mirror rev-list --count "$from..$sha")
	rollback=$(rollback_policy "$mfrom" "$mto" "$source")
	now=$(now_epoch)
	exp=$((now + REQUEST_TTL))
	id="$(date -u -d "@$now" +%Y%m%dT%H%M%SZ)-${sha:0:12}"
	d=$(request_dir "$id")
	mkdir -p "$ST_OPS_STATE/requests"
	mkdir "$d"
	{
		echo "st-ops deploy request v1"
		echo "id: $id"
		echo "host: $(hostname)"
		echo "sha: $sha"
		echo "tree: $tree"
		echo "scope: backend-v1"
		echo "from: $from"
		echo "from-source: $source"
		echo "runs-as: root-equivalent (the app container mounts /var/run/docker.sock): review the diff before signing"
		echo "compare: ${REPO_URL%.git}/compare/$from...$sha"
		echo "commits: $commits"
		echo "migrations: $mfrom -> $mto"
		echo "auto-rollback: $rollback"
		echo "sensitive-paths: ${sens:-none}"
		echo "requested-by: $ST_OPS_IDENT"
		echo "created: $(date -u -d "@$now" +%FT%TZ)"
		echo "expires: $(date -u -d "@$exp" +%FT%TZ)"
		echo "expires-epoch: $exp"
		# Indented (never a `key: ` line) and printable-only: commit subjects are the operator's text.
		echo "commit-list:"
		mirror log --first-parent --format='%h %s' "$from..$sha" | head -40 | LC_ALL=C tr -c '[:print:]\n' '?' | sed 's/^/  /'
		echo "diffstat:"
		mirror diff --no-renames --stat=120 "$from" "$sha" | tail -60 | LC_ALL=C tr -c '[:print:]\n' '?' | sed 's/^/  /'
	} >"$d/request.txt"
	chmod 0644 "$d/request.txt"
	st_ops_audit "rc=0 request=$id sha=$sha"
	echo "Request $id created. The owner signs EXACTLY these bytes (file request.txt):"
	echo "-----8<-----"
	cat "$d/request.txt"
	echo "-----8<-----"
	echo "Owner, on your own machine:  ssh-keygen -Y sign -f <your key> -n $SIGN_NAMESPACE request.txt"
	echo "Save it with:                 ssh st-ops request-text $id > request.txt"
	echo "Then the operator runs:      ssh st-ops deploy $id < request.txt.sig"
}

verb_deploy() {
	local id=${1:-} d sig
	is_request_id "$id" || die usage "deploy <request id>   (signature on stdin)"
	d=$(request_dir "$id")
	[[ -f $d/request.txt ]] || die request "no such request"
	sig=$(mktemp)
	# An SSH signature is ~300 bytes armoured; anything much larger is not one.
	head -c 4096 >"$sig"
	with_lock
	[[ -e $d/used ]] && die request "already used"
	[[ -e $d/cancelled ]] && die request "cancelled"
	request_expired "$d/request.txt" && die request "expired: ask for a new one"
	verify_signature "$d/request.txt" "$sig" || die signature "not signed by the owner for this exact request"
	deploy_running && die busy "a deploy is running"
	cp "$sig" "$d/request.txt.sig"
	rm -f "$sig"
	# `used` is written BEFORE the pipeline starts: an approval is consumed by the attempt, never re-playable.
	mkdir "$d/used"
	# RuntimeMaxSec: a hung build or daemon call ends in SIGTERM (the pipeline's trap records `aborted`) instead of
	# holding deploy.lock forever.
	systemd-run --quiet --collect --unit "st-ops-deploy-$id" -p RuntimeMaxSec=3600 "$ST_OPS_LIB/st-ops-deploy-run" "$id" ||
		die start "systemd-run failed"
	st_ops_audit "rc=0 deploy-started=$id"
	echo "Deploy $id started (unit st-ops-deploy-$id). Follow it with: ssh st-ops deploy-status $id"
}

verb_deploy_status() {
	local id=${1:-} d
	is_request_id "$id" || die usage "deploy-status <request id>"
	d=$(request_dir "$id")
	[[ -f $d/request.txt ]] || die request "no such request"
	local state
	if [[ -e $d/result.json ]]; then
		state=finished
	elif [[ -e $d/used ]]; then
		# No result and no unit: killed without its trap (SIGKILL, reboot). The outcome is unknown.
		if systemctl is-active --quiet "st-ops-deploy-$id" 2>/dev/null; then state=running; else state="aborted-unknown (no result written and the unit is gone: check status)"; fi
	elif [[ -e $d/cancelled ]]; then
		state=cancelled
	elif request_expired "$d/request.txt"; then
		state=expired
	else
		state=pending-signature
	fi
	echo "state: $state"
	[[ -f $d/progress.log ]] && cat "$d/progress.log"
	[[ -f $d/result.json ]] && cat "$d/result.json"
	return 0
}

verb_request_text() {
	local id=${1:-} d
	is_request_id "$id" || die usage "request-text <request id>"
	d=$(request_dir "$id")
	[[ -f $d/request.txt ]] || die request "no such request"
	cat "$d/request.txt"
}

verb_cancel() {
	local id=${1:-} d
	is_request_id "$id" || die usage "cancel <request id>"
	d=$(request_dir "$id")
	[[ -f $d/request.txt ]] || die request "no such request"
	with_lock
	[[ -e $d/used ]] && die request "already started"
	mkdir -p "$d/cancelled"
	st_ops_audit "rc=0 cancelled=$id"
	echo "cancelled $id"
}

st_ops_main() {
	local fp=${1:-}
	shift || true
	ST_OPS_VERB=${1:-help}
	resolve_ident "$fp"
	mkdir -p "$ST_OPS_STATE"
	chmod 0700 "$ST_OPS_STATE"
	load_conf
	shift || true
	(($# <= 2)) || die usage "too many arguments"
	local a
	for a in "$@"; do [[ $a =~ ^[A-Za-z0-9._:-]{1,80}$ ]] || die usage "invalid argument"; done
	st_ops_audit "args=$*"
	case $ST_OPS_VERB in
	help) verb_help ;;
	status) verb_status ;;
	logs) verb_logs "$@" ;;
	request-deploy) verb_request_deploy "$@" ;;
	deploy) verb_deploy "$@" ;;
	deploy-status) verb_deploy_status "$@" ;;
	request-text) verb_request_text "$@" ;;
	cancel) verb_cancel "$@" ;;
	*) die usage "unknown verb (try: help)" ;;
	esac
}

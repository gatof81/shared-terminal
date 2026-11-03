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
# Literal match: a base64 fingerprint can contain `+` and `/`.
[[ $(cat "$T/out") == "ARGV: [-n] [/usr/local/lib/st-ops/st-ops-root] [$fp_b] [status]" ]] && ok || ko "dispatch passes fingerprint + words: $(cat "$T/out")"
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
echo a >"$up/backend/src/a.ts"
echo FROM x >"$up/Dockerfile"
echo "services: {}" >"$up/docker-compose.yml"
echo "{}" >"$up/backend/package-lock.json"
git -C "$up" add -A && gcommit -m base
base=$(git -C "$up" rev-parse HEAD)
echo b >>"$up/backend/src/a.ts" && git -C "$up" add -A && gcommit -m two
two=$(git -C "$up" rev-parse HEAD)
git -C "$up" checkout -q -b side
echo s >"$up/backend/src/side.ts" && git -C "$up" add -A && gcommit -m side
side=$(git -C "$up" rev-parse HEAD)
git -C "$up" checkout -q main
git -C "$up" -c user.name=t -c user.email=t@t merge -q --no-ff side -m merge
merged=$(git -C "$up" rev-parse HEAD)
mkdir -p "$up/docs" && echo d >"$up/docs/x.md" && echo r >"$up/README.md" && git -C "$up" add -A && gcommit -m docs
docs=$(git -C "$up" rev-parse HEAD)
printf 'MIGRATIONS = [\n\t{ version: 17 },\n\t{ version: 18 },\n]\n' >"$up/backend/src/db.ts" && git -C "$up" add -A && gcommit -m mig
mig=$(git -C "$up" rev-parse HEAD)
# Each of these is refused by the v1 allowlist (and so is everything after it, whose diff from base includes it).
echo "FROM y" >"$up/Dockerfile" && git -C "$up" add -A && gcommit -m dockerfile
dockerfile=$(git -C "$up" rev-parse HEAD)
git clone -q "$up" "$T/st"
git -C "$T/st" checkout -q --detach "$base"

cat >"$ST_OPS_ETC/deploy.conf" <<EOF
REPO_URL=https://github.com/example/shared-terminal.git
ST_DIR=$T/st
COMPOSE_PROJECT=shared-terminal
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
		app_container() { :; }
		as_owner_of_checkout() { "$@"; }
		# shellcheck source=../lib/st-ops-deploy.sh
		source "$here/lib/st-ops-deploy.sh"
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
expect_rc 2 "request: a Dockerfile change is outside v1" rd "$dockerfile"
expect_out "ERROR scope: .*Dockerfile" "dockerfile refused as scope, named"
expect_rc 2 "request: there is no scope argument any more" rd "$merged" full
checks failure github-actions
expect_rc 2 "request: CI red" rd "$merged"
checks success cloudflare-workers-and-pages
expect_rc 0 "request: merged commit" rd "$merged"
id=$(sed -n 's/^id: //p' "$T/out")
expect_out "^sha: $merged$" "request carries the sha"
expect_out "^from: $base$" "request carries from"
expect_out "^migrations: 17 -> 17$" "request carries migrations"
expect_out "^auto-rollback: previous-image$" "no migration: rollback to the previous image"
expect_out "^scope: backend-v1$" "single scope"
expect_rc 2 "request: only one pending" rd "$two"
expect_out "ERROR pending" "second request refused as pending"
rdir="$ST_OPS_STATE/requests/$id"

# ── deploy ──
dp() { lib eval "ST_OPS_IDENT=b-0665fa5a; load_conf; verb_deploy $1" <"$2"; }
cp "$rdir/request.txt" "$T/r.txt" && sign "$T/bkey" st-ops-deploy@shared-terminal "$T/r.txt"
expect_rc 2 "deploy with the operator's signature" dp "$id" "$T/r.txt.sig"
[[ ! -e $rdir/used ]] && ok || ko "a refused deploy must not consume the request"
sed 's/^auto-rollback: .*/auto-rollback: withheld/' "$rdir/request.txt" >"$T/forged.txt"
cmp -s "$rdir/request.txt" "$T/forged.txt" && ko "fixture: forged text must differ" || ok
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

# ── on_main with a history longer than the pipe buffer (regression: grep -q + pipefail) ──
long="$T/long.git"
git init -q --bare "$long"
{
	for i in $(seq 1 3000); do
		printf 'commit refs/heads/main\ncommitter t <t@t> %d +0000\ndata 2\nc\n' "$((1700000000 + i))"
		((i > 1)) || printf 'from 0000000000000000000000000000000000000000\n' >/dev/null
		printf '\n'
	done
} | git -C "$long" fast-import --quiet
tip=$(git -C "$long" rev-parse main)
first=$(git -C "$long" rev-list --max-parents=0 main)
# Default SIGPIPE disposition, as under sshd/systemd-run (a caller that ignores SIGPIPE masks the bug: git then
# sees EPIPE and exits 0).
LONG=$long env --default-signal=PIPE bash -c '
	set -o pipefail
	source "$1/lib/st-ops-lib.sh"
	mirror() { git -C "$LONG" "$@"; }
	on_main "$2" && on_main "$3"
' _ "$here" "$tip" "$first" && ok || ko "on_main must find the newest and the oldest commit of a 3000-commit main under pipefail"

# ── Scope allowlist (pure) ──
sv() { lib scope_violations "$1"; }
for path in backend/src/x.ts backend/src/conversation/y.ts backend/tsconfig.json docs/a.md frontend/src/z.ts .github/workflows/ci.yml ops/vm100/README.md README.md CLAUDE.md .env.example; do
	[[ -z $(sv "$path") ]] && ok || ko "scope allows $path"
done
for path in Dockerfile docker-compose.yml compose.yaml docker-compose.override.yml backend/package.json backend/package-lock.json \
	session-image/entrypoint.sh .dockerignore backend/Dockerfile newtool.sh backend/scripts/x.sh frontend; do
	[[ -n $(sv "$path") ]] && ok || ko "scope refuses $path"
done

# ── Migrations and the rollback policy ──
[[ $(lib rollback_policy 17 17) == previous-image ]] && ok || ko "17->17 rolls back"
[[ $(lib rollback_policy 17 18) == withheld ]] && ok || ko "17->18 withholds"
[[ $(lib rollback_policy '?' 17) == withheld ]] && ok || ko "unknown version withholds"
rm -rf "$ST_OPS_STATE/requests"
expect_rc 0 "request with a migration jump is allowed" rd "$mig"
expect_out "^migrations: 17 -> 18$" "jump shown"
expect_out "^auto-rollback: withheld$" "the owner signs knowing there is no automatic rollback"
expect_out "^sensitive-paths: .*backend/src/db.ts" "db.ts flagged sensitive"
rm -rf "$ST_OPS_STATE/requests"

# recover_after_failed_start with stubs: what runs after a failed start, per scenario.
recover() { # $1 = MIG_FROM, $2 = MIG_TO, $3 = image running after the failure, $4 = health after (ok|fail)
	lib eval "
		DD=$T/dd; mkdir -p \$DD; : >\$DD/progress.log; rm -f $T/started
		ID=x SHA=s FROM=f BACKUP_DIR=/b OLD_IMG=sha256:old000000000000 NEW_IMG=sha256:new000000000000 APP_IMAGE=shared-terminal-app
		MIG_FROM=$1 MIG_TO=$2
		running_image() { if [[ -e $T/started ]]; then cat $T/started; else echo $3; fi; }
		health_wait() { [[ -e $T/started || $4 == ok ]]; }
		start_image() { echo \$1 >$T/started; }
		docker() { :; }
		recover_after_failed_start 'health failed'
	"
	cat "$T/dd/result.json" >>"$T/out"
}
recover 17 18 sha256:new000000000000 fail
expect_out '"result": "failed-rollback-withheld"' "migration + health failure: rollback withheld"
[[ ! -e $T/started ]] && ok || ko "migration + health failure must NOT start the previous image"
recover 17 17 sha256:new000000000000 fail
expect_out '"result": "rolled-back"' "no migration + health failure: rolled back"
[[ $(cat "$T/started" 2>/dev/null) == sha256:old000000000000 ]] && ok || ko "rollback starts the exact previous image id"
recover 17 18 sha256:old000000000000 ok
expect_out '"result": "failed-not-started"' "new image never replaced the old one"
[[ ! -e $T/started ]] && ok || ko "never-started case starts nothing"

# ── Composer: fail closed ──
pv() { # $1 = code, $2 = body
	printf '%s' "$2" >"$T/body"
	lib panes_verdict "$1" "$T/body"
}
[[ $(pv 200 '{"panes":[],"unreadable":[]}') == idle ]] && ok || ko "panes: empty is idle"
[[ $(pv 200 '{"panes":[{"paneId":"%0"}],"unreadable":[]}') == busy ]] && ok || ko "panes: a record is busy"
[[ $(pv 200 '{"panes":[],"unreadable":["%3.json"]}') == busy ]] && ok || ko "panes: an unreadable record is busy"
for case in '200|{}' '200|{"panes":[]}' '200|{"panes":{},"unreadable":[]}' '200|[]' '200|null' '200|not json' '200|' \
	'401|{"panes":[],"unreadable":[]}' '403|{"panes":[],"unreadable":[]}' '404|{"error":"not found"}' '500|{"panes":[],"unreadable":[]}' '000|'; do
	pv "${case%%|*}" "${case#*|}" >/dev/null && ko "panes must fail closed on ${case}" || ok
done
sv2() {
	printf '%s' "$2" >"$T/body"
	lib sessions_verdict "$1" "$T/body"
}
[[ $(sv2 200 '[{"sessionId":"0665fa5a-3eb4-4b81-9f13-bdf6b4f0b3eb","status":"running"}]') == 0665fa5a-3eb4-4b81-9f13-bdf6b4f0b3eb ]] && ok || ko "sessions: list parsed"
for case in '200|{"sessions":[]}' '200|[{"id":"x"}]' '200|[{"sessionId":"../../x"}]' '200|garbage' '401|[]' '403|[]' '404|[]' '500|[]' '000|'; do
	sv2 "${case%%|*}" "${case#*|}" >/dev/null && ko "sessions must fail closed on ${case}" || ok
done
wr="$T/wr"
mkdir -p "$wr"
expect_rc 0 "records: no .st-control at all" lib composer_records_clear "$wr"
mkdir -p "$wr/.st-control/aaaa/composer"
expect_rc 0 "records: empty composer dir" lib composer_records_clear "$wr"
touch "$wr/.st-control/aaaa/composer/12.json.1234.99.tmp"
expect_rc 1 "records: an atomic-write temp file counts" lib composer_records_clear "$wr"
rm "$wr/.st-control/aaaa/composer/"*
touch "$wr/.st-control/aaaa/composer/0.json"
expect_rc 1 "records: a pane record blocks" lib composer_records_clear "$wr"
rm "$wr/.st-control/aaaa/composer/0.json"
if [[ $(id -u) != 0 ]]; then
	chmod 000 "$wr/.st-control/aaaa/composer"
	expect_rc 1 "records: an unlistable composer dir blocks" lib composer_records_clear "$wr"
	chmod 755 "$wr/.st-control/aaaa/composer"
fi
# composer_idle end to end with stubbed transport.
ci() { # $1 = flag on|off, $2 = token ok|fail, $3 = sessions code, $4 = panes code, $5 = panes body
	lib eval "
		DD=$T/dd; mkdir -p \$DD; : >\$DD/progress.log; WR=$wr; APP=app; API=http://x
		composer_flag_on() { [[ $1 == on ]]; }
		admin_token() { [[ $2 == ok ]] && echo tok; }
		http_get() {
			case \$1 in
			/api/admin/sessions) printf '%s' '[{\"sessionId\":\"0665fa5a-3eb4-4b81-9f13-bdf6b4f0b3eb\"}]' >\$3; echo $3 ;;
			*) printf '%s' '$5' >\$3; echo $4 ;;
			esac
		}
		composer_idle
	"
}
expect_rc 0 "composer_idle: flag off, no records" ci off ok 200 200 '{"panes":[],"unreadable":[]}'
expect_rc 0 "composer_idle: flag on, all idle" ci on ok 200 200 '{"panes":[],"unreadable":[]}'
expect_rc 1 "composer_idle: token cannot be minted" ci on fail 200 200 '{"panes":[],"unreadable":[]}'
for c in 401 403 404 500 000; do
	expect_rc 1 "composer_idle: session list HTTP $c" ci on ok "$c" 200 '{"panes":[],"unreadable":[]}'
	expect_rc 1 "composer_idle: panes HTTP $c" ci on ok 200 "$c" '{"panes":[],"unreadable":[]}'
done
expect_rc 1 "composer_idle: panes JSON without panes" ci on ok 200 200 '{"ok":true}'
expect_rc 1 "composer_idle: busy pane" ci on ok 200 200 '{"panes":[{"paneId":"%0"}],"unreadable":[]}'
touch "$wr/.st-control/aaaa/composer/0.json"
expect_rc 1 "composer_idle: a record on disk blocks even with the flag off" ci off ok 200 200 '{"panes":[],"unreadable":[]}'
rm "$wr/.st-control/aaaa/composer/0.json"

echo "st-ops tests: $pass passed, $fail failed"
((fail == 0))

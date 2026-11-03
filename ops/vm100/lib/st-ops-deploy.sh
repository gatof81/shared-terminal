# st-ops-deploy.sh — the deploy pipeline (sourced by st-ops-deploy-run, after st-ops-lib.sh).
# A port of the hand-run 25-preflight-backup.sh / 25-deploy.sh / 25-verify.sh of 2026-11-03, generalised: no
# session ids, no expected flag values — the pipeline records what is there before and demands the same after.
# Backend (`app`) only. It never edits .env, never touches a session container, never rebuilds the session image.
# shellcheck shell=bash

# progress.log is what the operator reads (deploy-status): our own lines only. Command output — which can quote
# configuration — goes to private/, root-only, for the owner.
P() { echo "$(date -u +%FT%TZ) $*" >>"$DD/progress.log"; }
result() {
	# $1 = result, $2 = step, $3 = text
	python3 -I -c 'import json,sys; print(json.dumps(dict(zip(["result","step","detail","id","sha","from","backup"], sys.argv[1:])), indent=1))' \
		"$1" "$2" "$3" "$ID" "$SHA" "$FROM" "${BACKUP_DIR:-}" >"$DD/result.json"
	chmod 0644 "$DD/result.json"
	P "RESULT $1 ($2): $3"
	st_ops_audit "deploy=$ID result=$1 step=$2"
}
stop() {
	result "$1" "$2" "$3"
	exit 1
}

# Mint a 2-minute admin token inside `app` (signCliToken, as the hand-run scripts did). Never printed, never logged.
admin_token() {
	docker exec "$APP" node -e '
const {d1Query}=require("./dist/db.js"); const {signCliToken,validateJwtSecret}=require("./dist/auth.js"); validateJwtSecret();
(async()=>{const u=await d1Query("SELECT id, username FROM users WHERE is_admin = 1 ORDER BY created_at LIMIT 1",[]); process.stdout.write(signCliToken(u.results[0].id,u.results[0].username));})();' 2>/dev/null </dev/null
}

sessions_snapshot() {
	docker ps -aq --filter name=^/st- | xargs -r docker inspect --format '{{.Name}} {{.Id}} {{.Image}} {{.State.Status}} {{.State.StartedAt}}' | sort
}

# A composer send in flight when `app` restarts leaves a pane record for reconcile: refuse instead.
composer_idle() {
	local tok s full n
	tok=$(admin_token) || return 1
	[[ -n $tok ]] || return 1
	for s in $(docker ps --filter name=^/st- --format '{{.Names}}' | sed 's/^st-//'); do
		full=$(docker exec -e PFX="$s" "$APP" node -e 'const {d1Query}=require("./dist/db.js");(async()=>{const s=await d1Query("SELECT session_id FROM sessions WHERE session_id LIKE ?",[process.env.PFX+"%"]);process.stdout.write(s.results[0]?s.results[0].session_id:"")})()' 2>/dev/null </dev/null)
		[[ -n $full ]] || continue
		n=$(curl -s -H "Cookie: st_token=$tok" "$API/api/admin/sessions/$full/composer/panes" | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print(len(d["panes"]) if "panes" in d else "absent")' 2>/dev/null || echo "?")
		# The composer routes are not mounted with the flag off: nothing can be in flight then.
		[[ $n == 0 || $n == absent ]] || {
			P "composer pane busy on st-$s ($n)"
			return 1
		}
	done
}

recreate_records_resolved() {
	local f st
	for f in $(find "$WR/.st-control" -name recreate-attempt.json 2>/dev/null); do
		st=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["state"])' "$f" 2>/dev/null || echo unreadable)
		[[ $st == resolved ]] || {
			P "recreation record not resolved: $f ($st)"
			return 1
		}
	done
}

app_flags() {
	docker inspect "$1" --format '{{range .Config.Env}}{{println .}}{{end}}' |
		grep -E '^(NODE_ENV|UI_SHELL|CONVERSATION_[A-Z_]+|COMPOSER_[A-Z_]+|RECREATE_[A-Z_]+)=' | sort
}

health_wait() {
	local i
	for i in $(seq 1 60); do
		[[ $(curl -sf "$API/health" 2>/dev/null) == '{"ok":true}' ]] && return 0
		sleep 2
	done
	return 1
}

compose_up_at() {
	# $1 = SHA to check out and start
	(umask 022 && st_git checkout -q --detach "$1")
	[[ $(st_git rev-parse HEAD) == "$1" ]] || return 1
	(cd "$ST_DIR" && docker compose up -d --build app) >>"$DD/private/up.log" 2>&1
}

# The backup tool is built from the TARGET SHA (its backup.ts knows the target schema), runs read-only with
# DAC_READ_SEARCH only, and is checked against its manifest before anything is deployed.
take_backup() {
	local tool="st-backup-tool:${SHA:0:12}" src="$DD/private/backup-tool-src" bk start envs
	docker image inspect "$tool" >/dev/null 2>&1 && docker image rm "$tool" >/dev/null
	(umask 022 && mkdir "$src" && mirror archive "$SHA" | tar -x -C "$src")
	docker build --label "io.shared-terminal.backup-tool=$SHA" -t "$tool" "$src" >"$DD/private/backup-tool-build.log" 2>&1 || return 1
	bk="deploy-${SHA:0:12}-$(date -u +%Y%m%dT%H%M%SZ)"
	BACKUP_DIR="$WR/.backups/$bk"
	mkdir -p "$WR/.backups"
	mkdir "$BACKUP_DIR"
	envs=$(mktemp)
	docker inspect "$APP" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^(CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_API_TOKEN|D1_DATABASE_ID)=.' >"$envs"
	[[ $(wc -l <"$envs") == 3 ]] || {
		rm -f "$envs"
		return 1
	}
	start=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	docker run --rm --name "backup-tool-$bk" --env-file "$envs" -e NODE_ENV=production -e WORKSPACE_ROOT=/var/shared-terminal/workspaces \
		-v "$WR:/var/shared-terminal/workspaces:ro" -v "$BACKUP_DIR:/backup" --read-only --tmpfs /tmp \
		--cap-drop ALL --cap-add DAC_READ_SEARCH --security-opt no-new-privileges \
		"$tool" node dist/backup.js backup /backup >"$DD/private/backup.txt" 2>&1
	local rc=$?
	rm -f "$envs"
	docker image rm "$tool" >/dev/null 2>&1 || true
	rm -rf -- "$src"
	((rc == 0)) || return 1
	python3 -I - "$BACKUP_DIR" "$start" >>"$DD/progress.log" 2>&1 <<'PY'
import json, os, re, subprocess, sys
d, start = sys.argv[1], sys.argv[2]
m = json.load(open(os.path.join(d, "manifest.json")))
assert m.get("version") == 1 and m["createdAt"][:19] >= start[:19] and m.get("tables"), "manifest"
for t, n in m["tables"].items():
    rows = [l for l in open(os.path.join(d, f"{t}.jsonl"), encoding="utf-8").read().split("\n") if l.strip()]
    for l in rows: json.loads(l)
    assert len(rows) == n, f"{t}.jsonl {len(rows)} != {n}"
ws = os.path.join(d, "workspaces")
assert sorted(os.listdir(ws)) == sorted(f"{s}.tar.gz" for s in m["workspaces"]), "workspace list"
important = []
for sid, w in m["workspaces"].items():
    p = os.path.join(ws, f"{sid}.tar.gz"); assert os.path.getsize(p) == w["tarBytes"], sid
    r = subprocess.run(["tar", "-tzf", p], capture_output=True, env={**os.environ, "LC_ALL": "C"})
    assert r.returncode == 0 and not r.stderr, f"{sid}.tar.gz unreadable"
    assert len([x for x in r.stdout.split(b"\n") if x]) == w["fileCount"], f"{sid} file count"
    cc = w.get("concurrentChanges")
    if not cc: continue
    if cc["truncated"]: important.append(f"{sid} truncated list")
    s = re.escape(sid)
    for e in cc["paths"]:
        p_, k = e["path"], e["kind"]
        volatile = ((k in ("changed", "removed") and re.fullmatch(s + r"/\.st(/claude\.json(\.tmp\.[^/]+)?|/claude-state(/.*)?)?", p_)
                     and not re.fullmatch(s + r"/\.st/claude-state/projects/.+\.jsonl", p_))
                    or (k == "changed" and re.fullmatch(s + r"/\.st/claude-state/projects/.+\.jsonl", p_))
                    or re.fullmatch(s + r"/(.+/)?(test-results|playwright-report|node_modules/\.cache|\.cache)(/.*)?", p_))
        if not volatile: important.append(f"{sid} {k}")
print(f"{m['createdAt']} backup verified: schema {m['schemaVersion']}, {len(m['tables'])} tables, {len(m['workspaces'])} workspaces")
if important:
    print("backup has non-volatile concurrent changes in: " + ", ".join(sorted(set(x.split()[0][:8] for x in important))))
    sys.exit(1)
PY
}

deploy_run() {
	ID=${1:-}
	SHA='' FROM='' BACKUP_DIR=''
	is_request_id "$ID" || exit 2
	DD=$(request_dir "$ID")
	[[ -d $DD/used && -f $DD/request.txt && -f $DD/request.txt.sig ]] || exit 2
	mkdir -p "$DD/private"
	chmod 0700 "$DD/private"
	ST_OPS_VERB=deploy-run
	ST_OPS_IDENT=$(request_field "$DD/request.txt" requested-by || echo unknown)
	load_conf
	exec 8>"$ST_OPS_STATE/deploy.lock"
	flock -n 8 || stop refused lock "another deploy holds the lock"
	SHA=$(request_field "$DD/request.txt" sha) && is_sha "$SHA" || stop refused request "sha field"
	FROM=$(request_field "$DD/request.txt" from) && is_sha "$FROM" || stop refused request "from field"
	local tree scope
	tree=$(request_field "$DD/request.txt" tree) && is_sha "$tree" || stop refused request "tree field"
	scope=$(request_field "$DD/request.txt" scope) && is_scope "$scope" || stop refused request "scope field"
	# Re-verified here, not trusted from request time: the signature approves THIS request, and the world may have
	# moved in the meantime (expiry, a second deploy, a re-run CI).
	verify_signature "$DD/request.txt" "$DD/request.txt.sig" || stop refused signature "signature no longer verifies"
	P "deploy $ID: $FROM -> $SHA (scope $scope)"

	# ── 1. Provenance and CI, again ──
	[[ ! -f /.dockerenv ]] || stop refused host "running inside a container"
	mirror_fetch
	on_main "$SHA" || stop refused provenance "not on main's first-parent history"
	[[ $(mirror rev-parse "$SHA^{tree}") == "$tree" ]] || stop refused provenance "tree differs from the signed one"
	ci_green "$SHA" >>"$DD/progress.log" || stop refused ci "CI not green"
	[[ $(deployed_sha) == "$FROM" ]] || stop refused state "the deployed SHA is no longer the signed 'from'"
	P "provenance + CI ok"

	# ── 2. Preflight ──
	API="http://localhost:$(st_port)"
	WR=$(st_workspace_root)
	APP=$(cd "$ST_DIR" && docker compose ps -q app)
	[[ -n $APP ]] || stop refused preflight "app container not found"
	[[ -z $(st_git status --porcelain --untracked-files=no) ]] || stop refused preflight "local changes in $ST_DIR"
	local avail
	avail=$(df --output=avail -k /var/lib/docker | tail -1 | tr -d ' ')
	((avail >= MIN_FREE_KIB)) || stop refused preflight "free space ${avail} KiB < ${MIN_FREE_KIB}"
	recreate_records_resolved || stop refused preflight "an unresolved recreation record exists"
	composer_idle || stop refused preflight "a composer send may be in flight"
	health_wait || stop refused preflight "the running backend is not healthy"
	sessions_snapshot >"$DD/private/sessions-before.txt"
	app_flags "$APP" >"$DD/private/flags-before.txt"
	sha256sum "$ST_DIR/.env" | cut -d' ' -f1 >"$DD/private/env-sha-before.txt"
	(cd "$ST_DIR" && docker compose logs --no-color --timestamps app) >"$DD/private/app-before.log" 2>&1 || true
	P "preflight ok ($(wc -l <"$DD/private/sessions-before.txt") session containers)"

	# ── 3. Backup ──
	take_backup || stop refused backup "backup failed or did not verify (see private/)"
	P "backup ok: $BACKUP_DIR"

	# ── 4. Nothing moved during the backup ──
	[[ $(deployed_sha) == "$FROM" ]] || stop refused state "the deployed SHA changed during the backup"
	sessions_snapshot | diff -q "$DD/private/sessions-before.txt" - >/dev/null || stop refused state "session containers changed during the backup"
	composer_idle || stop refused preflight "a composer send started during the backup"

	# ── 5. Deploy ──
	st_git fetch -q "$REPO_URL" main >>"$DD/private/fetch.log" 2>&1 || stop refused fetch "checkout fetch failed"
	st_git cat-file -e "$SHA^{commit}" || stop refused fetch "SHA missing in the checkout"
	if ! compose_up_at "$SHA" || [[ $(st_git rev-parse HEAD^{tree}) != "$tree" ]]; then
		P "compose up failed: rolling back to $FROM"
		rollback_to_from "compose up failed"
	fi
	if ! health_wait; then
		P "health failed after the deploy: rolling back to $FROM"
		rollback_to_from "health failed"
	fi
	P "backend up at $SHA"

	# ── 6. Verify (no rollback here: an unhealthy-looking-but-up backend is the owner's call) ──
	local new problems=()
	new=$(cd "$ST_DIR" && docker compose ps -q app)
	sleep 5
	(cd "$ST_DIR" && docker compose logs --no-color --timestamps app) >"$DD/private/app-after.log" 2>&1 || true
	app_flags "$new" | diff -q "$DD/private/flags-before.txt" - >/dev/null || problems+=("app feature flags differ")
	[[ $(sha256sum "$ST_DIR/.env" | cut -d' ' -f1) == $(cat "$DD/private/env-sha-before.txt") ]] || problems+=(".env changed")
	sessions_snapshot | diff -q "$DD/private/sessions-before.txt" - >/dev/null || problems+=("session containers changed")
	[[ $(curl -s -o /dev/null -w '%{http_code}' "$API/api/auth/status") == 200 ]] || problems+=("/api/auth/status not 200")
	local feat
	for feat in 'composer ENABLED' 'conversation capture ENABLED'; do
		if grep -qF "[server] $feat" "$DD/private/app-before.log" && ! grep -qF "[server] $feat" "$DD/private/app-after.log"; then
			problems+=("log no longer says '$feat'")
		fi
	done
	if ((${#problems[@]})); then
		stop deployed-unverified verify "$(IFS='; '; echo "${problems[*]}")"
	fi
	result deployed verify "backend at $SHA, verified"
}

rollback_to_from() {
	if compose_up_at "$FROM" && health_wait; then
		stop rolled-back deploy "$1; backend back at $FROM and healthy"
	fi
	stop rollback-failed deploy "$1; rollback to $FROM ALSO failed — owner intervention needed"
}

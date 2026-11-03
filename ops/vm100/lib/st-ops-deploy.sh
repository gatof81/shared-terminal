# st-ops-deploy.sh — the deploy pipeline (sourced by st-ops-deploy-run, after st-ops-lib.sh).
# A port of the hand-run 25-preflight-backup.sh / 25-deploy.sh / 25-verify.sh of 2026-11-03, generalised: no
# session ids, no expected flag values — the pipeline records what is there before and demands the same after.
# Backend (`app`) code only. It never edits .env, never touches a session container, never rebuilds the session
# image, and never runs git or a build inside the diego-owned checkout (see as_owner_of_checkout).
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

# ── Composer: is any send in flight? Fail closed on anything but positive evidence of "none" ──

# Layer 1, the disk: a pane record exists from `prepared` (before the first effect) until `released`
# (CONVERSATION.md §8.1.4), whatever process owns it and whether the flag is on now. ANY entry in any composer
# directory — a record, a temp file of an atomic write, something unexpected — or a directory that cannot be
# listed means "not provably idle".
composer_records_clear() { # $1 = workspace root
	local d entries
	[[ -d $1/.st-control ]] || return 0
	for d in "$1"/.st-control/*/composer; do
		[[ -e $d ]] || continue
		entries=$(find "$d" -mindepth 1 -maxdepth 1 -printf '.' 2>/dev/null) || return 1
		[[ -z $entries ]] || return 1
	done
}

# Layer 2, the backend (only with the flag on, the routes don't exist otherwise): the admin session list and,
# for every session in it, the panes view. Only HTTP 200 with the exact expected JSON shape counts; 401, 403,
# 404, 5xx, a transport error, non-JSON, a missing `panes`/`unreadable` or a non-empty one ⇒ not idle.
# Prints the session ids (one per line) or exits 1.
sessions_verdict() { # $1 = HTTP code, $2 = body file
	[[ $1 == 200 ]] || return 1
	python3 -I -c '
import json, re, sys
d = json.load(open(sys.argv[1]))
assert isinstance(d, list)
for r in d:
    assert isinstance(r, dict) and isinstance(r.get("sessionId"), str)
    assert re.fullmatch(r"[0-9a-f-]{36}", r["sessionId"])
    print(r["sessionId"])
' "$2" 2>/dev/null
}
panes_verdict() { # $1 = HTTP code, $2 = body file. Prints idle or busy; exit 1 = unknown.
	[[ $1 == 200 ]] || return 1
	python3 -I -c '
import json, sys
d = json.load(open(sys.argv[1]))
assert isinstance(d, dict) and isinstance(d.get("panes"), list) and isinstance(d.get("unreadable"), list)
print("idle" if not d["panes"] and not d["unreadable"] else "busy")
' "$2" 2>/dev/null
}
http_get() { # $1 = path, $2 = token, $3 = body file. Prints the HTTP code; 000 on a transport error.
	curl -s -m 10 -o "$3" -w '%{http_code}' -H "Cookie: st_token=$2" "$API$1" 2>/dev/null || echo 000
}
# Mint a 2-minute admin token inside `app` (signCliToken, as the hand-run scripts did). Never printed or logged.
admin_token() {
	docker exec "$APP" node -e '
const {d1Query}=require("./dist/db.js"); const {signCliToken,validateJwtSecret}=require("./dist/auth.js"); validateJwtSecret();
(async()=>{const u=await d1Query("SELECT id, username FROM users WHERE is_admin = 1 ORDER BY created_at LIMIT 1",[]); process.stdout.write(signCliToken(u.results[0].id,u.results[0].username));})();' 2>/dev/null </dev/null
}
composer_flag_on() { # $1 = container. Same rule as composerFlagEnabled(): exactly `true` or `1`.
	docker inspect "$1" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -xE 'CONVERSATION_COMPOSER_ENABLED=(true|1)' >/dev/null
}
composer_idle() {
	local tok ids sid code body
	composer_records_clear "$WR" || {
		P "composer: a pane record (or an unlistable composer dir) exists"
		return 1
	}
	composer_flag_on "$APP" || return 0
	tok=$(admin_token) && [[ -n $tok ]] || {
		P "composer: could not mint an admin token"
		return 1
	}
	body=$(mktemp)
	code=$(http_get /api/admin/sessions "$tok" "$body")
	ids=$(sessions_verdict "$code" "$body") || {
		rm -f "$body"
		P "composer: admin session list unusable (HTTP $code)"
		return 1
	}
	for sid in $ids; do
		code=$(http_get "/api/admin/sessions/$sid/composer/panes" "$tok" "$body")
		if [[ $(panes_verdict "$code" "$body") != idle ]]; then
			rm -f "$body"
			P "composer: ${sid:0:8} not provably idle (HTTP $code)"
			return 1
		fi
	done
	rm -f "$body"
}

# ── Other preflight probes ──

sessions_snapshot() {
	docker ps -aq --filter name=^/st- | xargs -r docker inspect --format '{{.Name}} {{.Id}} {{.Image}} {{.State.Status}} {{.State.StartedAt}}' | sort
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
		[[ $(curl -sf -m 5 "$API/health" 2>/dev/null) == '{"ok":true}' ]] && return 0
		sleep 2
	done
	return 1
}

# ── Build and start, from the root-owned tree only ──

# The build context is `git archive` of the SHA from the root-owned mirror: a fresh directory with no .git, no
# hooks, no git config, no untracked or locally modified file. Nothing in the diego checkout reaches the image.
build_image() {
	local src="$DD/private/src"
	rm -rf -- "$src"
	(umask 022 && mkdir "$src" && mirror archive "$SHA" | tar -x -C "$src") || return 1
	docker build --label "$APP_SHA_LABEL=$SHA" --label "io.shared-terminal.st-ops.tree=$TREE" \
		--label "io.shared-terminal.st-ops.request=$ID" -t "$APP_IMAGE:st-ops-${SHA:0:12}" -f "$src/Dockerfile" "$src" \
		>"$DD/private/build.log" 2>&1 || return 1
	NEW_IMG=$(docker image inspect "$APP_IMAGE:st-ops-${SHA:0:12}" --format '{{.Id}}')
}

# compose runs with the compose file of the SIGNED tree (byte-identical to the deployed one: scope v1 refuses a
# compose change, preflight refuses a checkout whose file differs), explicit -p/-f so no override file or
# COMPOSE_* variable is discovered, and --no-build: it only (re)creates `app` from the image tagged here.
compose() {
	docker compose -p "$COMPOSE_PROJECT" --project-directory "$ST_DIR" -f "$DD/private/docker-compose.yml" "$@"
}
start_image() { # $1 = image id
	docker tag "$1" "$APP_IMAGE:latest" &&
		compose up -d --no-build app >>"$DD/private/up.log" 2>&1
}
running_image() {
	local cid
	cid=$(app_container)
	[[ -n $cid ]] && docker inspect "$cid" --format '{{.Image}}'
}

# After the new image failed to come up: back to the exact previous image, by id, only when the schema cannot
# have moved (rollback_policy); otherwise leave it to the owner.
recover_after_failed_start() { # $1 = what failed
	# compose may fail before it replaced anything: then the previous backend is still the one running, and the
	# new code (hence any migration) never started. Put the tag back and say exactly that.
	if [[ $(running_image) == "$OLD_IMG" ]] && health_wait; then
		docker tag "$OLD_IMG" "$APP_IMAGE:latest" || true
		stop failed-not-started deploy "$1; the new image never replaced the running one — previous backend ${OLD_IMG:7:12} still up and healthy"
	fi
	if [[ $(rollback_policy "$MIG_FROM" "$MIG_TO") != previous-image ]]; then
		stop failed-rollback-withheld deploy "$1; migrations $MIG_FROM -> $MIG_TO may have run, so the previous code is not proven compatible — no automatic rollback. Backup: ${BACKUP_DIR:-none}. Owner decision needed."
	fi
	P "$1: rolling back to the previous image ${OLD_IMG:7:12}"
	if start_image "$OLD_IMG" && health_wait && [[ $(running_image) == "$OLD_IMG" ]]; then
		stop rolled-back deploy "$1; previous image ${OLD_IMG:7:12} running and healthy"
	fi
	stop rollback-failed deploy "$1; rollback to ${OLD_IMG:7:12} ALSO failed — owner intervention needed"
}

# ── The pipeline ──

deploy_run() {
	ID=${1:-}
	SHA='' FROM='' TREE='' BACKUP_DIR='' NEW_IMG='' OLD_IMG='' MIG_FROM='' MIG_TO=''
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
	TREE=$(request_field "$DD/request.txt" tree) && is_sha "$TREE" || stop refused request "tree field"
	[[ $(request_field "$DD/request.txt" scope) == backend-v1 ]] || stop refused request "scope field"
	# Re-verified here, not trusted from request time: the signature approves THIS request, and the world may have
	# moved in the meantime (expiry, a second deploy, a re-run CI).
	verify_signature "$DD/request.txt" "$DD/request.txt.sig" || stop refused signature "signature no longer verifies"
	P "deploy $ID: $FROM -> $SHA"

	# ── 1. Provenance, CI and scope, again ──
	[[ ! -f /.dockerenv ]] || stop refused host "running inside a container"
	mirror_fetch
	on_main "$SHA" || stop refused provenance "not on main's first-parent history"
	[[ $(mirror rev-parse "$SHA^{tree}") == "$TREE" ]] || stop refused provenance "tree differs from the signed one"
	mirror merge-base --is-ancestor "$FROM" "$SHA" || stop refused provenance "does not descend from the signed from"
	[[ -z $(scope_violations "$(changed_paths "$FROM" "$SHA")") ]] || stop refused scope "outside the v1 backend scope"
	MIG_FROM=$(migration_version "$FROM")
	MIG_TO=$(migration_version "$SHA")
	[[ "$MIG_FROM -> $MIG_TO" == $(request_field "$DD/request.txt" migrations) ]] || stop refused request "migration jump differs from the signed one"
	ci_green "$SHA" >>"$DD/progress.log" || stop refused ci "CI not green"
	[[ $(deployed_sha) == "$FROM" ]] || stop refused state "the deployed SHA is no longer the signed 'from'"
	P "provenance + CI + scope ok (migrations $MIG_FROM -> $MIG_TO, auto-rollback $(rollback_policy "$MIG_FROM" "$MIG_TO"))"

	# ── 2. Preflight ──
	API="http://localhost:$(st_port)"
	WR=$(st_workspace_root)
	APP=$(app_container)
	[[ -n $APP ]] || stop refused preflight "app container of project $COMPOSE_PROJECT not found"
	OLD_IMG=$(docker inspect "$APP" --format '{{.Image}}')
	APP_IMAGE="$COMPOSE_PROJECT-app"
	# The running image must be the one compose's tag names, or "previous image" and "what compose starts" differ.
	[[ $(docker image inspect "$APP_IMAGE:latest" --format '{{.Id}}' 2>/dev/null) == "$OLD_IMG" ]] ||
		stop refused preflight "the running app image is not $APP_IMAGE:latest (manual drift?)"
	mirror show "$SHA:docker-compose.yml" >"$DD/private/docker-compose.yml"
	cmp -s "$DD/private/docker-compose.yml" "$ST_DIR/docker-compose.yml" ||
		stop refused preflight "$ST_DIR/docker-compose.yml differs from the signed tree's"
	compose config --quiet >>"$DD/private/compose-config.log" 2>&1 || stop refused preflight "compose config does not validate"
	local avail
	avail=$(df --output=avail -k /var/lib/docker | tail -1 | tr -d ' ')
	((avail >= MIN_FREE_KIB)) || stop refused preflight "free space ${avail} KiB < ${MIN_FREE_KIB}"
	recreate_records_resolved || stop refused preflight "an unresolved recreation record exists"
	composer_idle || stop refused preflight "a composer send may be in flight (not provably idle)"
	health_wait || stop refused preflight "the running backend is not healthy"
	sessions_snapshot >"$DD/private/sessions-before.txt"
	app_flags "$APP" >"$DD/private/flags-before.txt"
	sha256sum "$ST_DIR/.env" | cut -d' ' -f1 >"$DD/private/env-sha-before.txt"
	docker logs --timestamps "$APP" >"$DD/private/app-before.log" 2>&1 || true
	P "preflight ok ($(wc -l <"$DD/private/sessions-before.txt") session containers, previous image ${OLD_IMG:7:12})"

	# ── 3. Build (the old backend keeps running; a failed build changes nothing) ──
	build_image || stop refused build "image build failed (see private/build.log); nothing changed"
	P "image ${NEW_IMG:7:12} built from the signed tree"

	# ── 4. Backup ──
	take_backup || stop refused backup "backup failed or did not verify (see private/); nothing changed"
	P "backup ok: $BACKUP_DIR"

	# ── 5. Nothing moved during build + backup ──
	[[ $(deployed_sha) == "$FROM" && $(running_image) == "$OLD_IMG" ]] || stop refused state "the backend changed during the backup"
	sessions_snapshot | diff -q "$DD/private/sessions-before.txt" - >/dev/null || stop refused state "session containers changed during the backup"
	composer_idle || stop refused preflight "a composer send started during the backup"

	# ── 6. Start ──
	start_image "$NEW_IMG" || recover_after_failed_start "compose up failed"
	health_wait || recover_after_failed_start "health failed"
	[[ $(running_image) == "$NEW_IMG" ]] || recover_after_failed_start "the running image is not the one built"
	P "backend up at $SHA (image ${NEW_IMG:7:12})"

	# ── 7. Verify (no rollback here: an up-but-different backend is the owner's call) ──
	local new problems=()
	new=$(app_container)
	sleep 5
	docker logs --timestamps "$new" >"$DD/private/app-after.log" 2>&1 || true
	app_flags "$new" | diff -q "$DD/private/flags-before.txt" - >/dev/null || problems+=("app feature flags differ")
	[[ $(sha256sum "$ST_DIR/.env" | cut -d' ' -f1) == $(cat "$DD/private/env-sha-before.txt") ]] || problems+=(".env changed")
	sessions_snapshot | diff -q "$DD/private/sessions-before.txt" - >/dev/null || problems+=("session containers changed")
	[[ $(curl -s -m 5 -o /dev/null -w '%{http_code}' "$API/api/auth/status") == 200 ]] || problems+=("/api/auth/status not 200")
	[[ $(deployed_sha) == "$SHA" ]] || problems+=("image label does not name $SHA")
	local feat
	for feat in 'composer ENABLED' 'conversation capture ENABLED'; do
		if grep -qF "[server] $feat" "$DD/private/app-before.log" && ! grep -qF "[server] $feat" "$DD/private/app-after.log"; then
			problems+=("log no longer says '$feat'")
		fi
	done
	((${#problems[@]} == 0)) || stop deployed-unverified verify "$(IFS='; '; echo "${problems[*]}")"

	# ── 8. Bookkeeping, as the checkout's owner: keep a manual `compose up --build` from rebuilding old code ──
	local note=""
	if ! as_owner_of_checkout git -C "$ST_DIR" fetch -q origin >>"$DD/private/bookkeeping.log" 2>&1 ||
		! as_owner_of_checkout git -C "$ST_DIR" checkout -q --detach "$SHA" >>"$DD/private/bookkeeping.log" 2>&1; then
		note=" — WARNING: $ST_DIR is not at $SHA (a manual compose build there would build other code)"
	fi
	result deployed verify "backend at $SHA, verified$note"
}

# The backup runs with the image just built from the signed tree (its backup.ts knows the target schema), as a
# one-off container: read-only workspaces, DAC_READ_SEARCH only (it needs the network for the D1 API). Checked against
# its manifest before anything is deployed.
take_backup() {
	local bk start envs rc
	bk="deploy-${SHA:0:12}-$(date -u +%Y%m%dT%H%M%SZ)"
	BACKUP_DIR="$WR/.backups/$bk"
	mkdir -p "$WR/.backups"
	mkdir "$BACKUP_DIR" || return 1
	envs=$(mktemp)
	docker inspect "$APP" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^(CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_API_TOKEN|D1_DATABASE_ID)=.' >"$envs"
	if [[ $(wc -l <"$envs") != 3 ]]; then
		rm -f "$envs"
		return 1
	fi
	start=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	docker run --rm --name "backup-tool-$bk" --env-file "$envs" -e NODE_ENV=production -e WORKSPACE_ROOT=/var/shared-terminal/workspaces \
		-v "$WR:/var/shared-terminal/workspaces:ro" -v "$BACKUP_DIR:/backup" --read-only --tmpfs /tmp \
		--cap-drop ALL --cap-add DAC_READ_SEARCH --security-opt no-new-privileges \
		"$NEW_IMG" node dist/backup.js backup /backup >"$DD/private/backup.txt" 2>&1
	rc=$?
	rm -f "$envs"
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

#!/usr/bin/env bash
# ops/backup/st-backup-nas.sh — nightly backup whose history lives on the NAS, not on the host.
#
#   run           make a backup, verify it, copy it, verify the copy, publish it, then retention
#   adopt <name>  publish a backup that already exists locally (same verify → copy → verify → publish)
#   status        what is published / unpublished on the NAS and what is kept locally
#
# What it replaces (2026-11): a `rsync --delete` MIRROR of the host's last 7 backups. A mirror is not a
# history: whatever the host drops, the NAS drops in the same run, and a copy was never checked at the
# destination. Here:
#   - a backup is PUBLISHED only by its `<name>.COMPLETE` marker, uploaded last, after the NAS's own
#     checksums matched every local file. Anything without the marker is not a backup to this script:
#     it is reported, never counted and never removed;
#   - the host keeps the NEWEST backup (the recreation engine's `backup-stale` precondition needs a
#     manifest younger than 24 h) and removes an older one only once it is published;
#   - NAS retention removes backups BY NAME (retention.py), only in a run that just published one;
#   - a failure never deletes anything, on either side, and ends non-zero with a status file.
#
# The NAS credential is expected to be an rrsync-restricted key (no shell): everything here is rsync —
# listing, upload, checksum comparison (`-c -n -i`), and removal (`--delete` from an empty directory
# with an include filter naming exactly one backup).
#
# Config: a file of KEY=value lines (default /etc/st-backup-nas.conf, or $ST_BACKUP_CONF). No
# host-specific value lives in this repository.
#   BACKUPS_DIR   the host's backup directory (<WORKSPACE_ROOT>/.backups)
#   BACKUP_CMD    command that writes a backup into the directory given as its last argument
#   NAS_DEST      rsync destination root, e.g. user@host:./  (or a local path, which the tests use)
#   NAS_RSH       remote shell for rsync (ssh -i … -o StrictHostKeyChecking=yes); empty for a local path
#   STATE_DIR     where the lock, the inventories and status.json live
#   DAILY=3 WEEKLY=1 MIN_FREE_GB=15
#   ALERT_CMD     optional; run with one argument (the failure line) when a run fails
set -uo pipefail
umask 077
export LC_ALL=C

CONF=${ST_BACKUP_CONF:-/etc/st-backup-nas.conf}
[ -r "$CONF" ] || { echo "STOP: no config at $CONF" >&2; exit 2; }
# shellcheck disable=SC1090
. "$CONF"
: "${BACKUPS_DIR:?}" "${BACKUP_CMD:?}" "${NAS_DEST:?}" "${STATE_DIR:?}"
NAS_RSH=${NAS_RSH:-}
DAILY=${DAILY:-3}
WEEKLY=${WEEKLY:-1}
MIN_FREE_GB=${MIN_FREE_GB:-15}
ALERT_CMD=${ALERT_CMD:-}
HERE=$(cd "$(dirname "$0")" && pwd)
NAME_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z$'

mkdir -p "$STATE_DIR" || exit 2
EMPTY="$STATE_DIR/empty"
mkdir -p "$EMPTY"

log() { echo "$(date -u +%FT%TZ) $*"; }

# ── rsync against the NAS ────────────────────────────────────────────────────

nas_rsync() {
	# 9>&-: the lock is this script's, not its children's — an rsync helper that outlives a failed
	# transfer by a moment must not hold it against the next run.
	if [ -n "$NAS_RSH" ]; then rsync -e "$NAS_RSH" "$@" 9>&-; else rsync "$@" 9>&-; fi
}

# Names at the NAS root, one per line. Fails (non-zero) when the listing fails: an unreachable NAS
# must never read as "nothing is published".
nas_root() {
	local out
	out=$(nas_rsync --list-only "$NAS_DEST/") || return 1
	awk '{print $NF}' <<<"$out" | grep -v '^\.$' || true
}

# ── Local verification ───────────────────────────────────────────────────────

# The backup is whole by its own manifest (written last by `npm run backup`): every table has the
# rows it says, every workspace tarball has the size it says and is a readable gzip, every project
# tarball has the size and sha256 it says (the Project Chat log exists nowhere else — not in D1),
# both sets of tarballs are exactly the manifest's, and REVOKED_ALL is there iff the manifest says so.
verify_local() {
	python3 -I - "$1" <<'PY'
import gzip, hashlib, json, os, sys
d = sys.argv[1]
m = json.load(open(os.path.join(d, "manifest.json")))
assert m.get("version") == 1 and m.get("tables"), "manifest"
for t, n in m["tables"].items():
    with open(os.path.join(d, f"{t}.jsonl"), encoding="utf-8") as f:
        rows = [l for l in f.read().split("\n") if l.strip()]
    for l in rows:
        json.loads(l)
    assert len(rows) == n, f"{t}: {len(rows)} rows, manifest says {n}"
ws = os.path.join(d, "workspaces")
have = sorted(os.listdir(ws)) if os.path.isdir(ws) else []
assert have == sorted(f"{s}.tar.gz" for s in m.get("workspaces", {})), "workspace tarballs differ from the manifest"
for sid, w in m.get("workspaces", {}).items():
    p = os.path.join(ws, f"{sid}.tar.gz")
    assert os.path.getsize(p) == w["tarBytes"], f"{sid}: size"
    with gzip.open(p, "rb") as g:
        while g.read(1 << 20):
            pass
pj = m.get("projects", {})
pd = os.path.join(d, "projects")
have = sorted(os.listdir(pd)) if os.path.isdir(pd) else []
assert have == sorted(f"{p}.tar.gz" for p in pj), "project tarballs differ from the manifest"
for pid, e in pj.items():
    h, size = hashlib.sha256(), 0
    with open(os.path.join(pd, f"{pid}.tar.gz"), "rb") as f:
        while b := f.read(1 << 20):
            h.update(b)
            size += len(b)
    assert size == e["tarBytes"] and h.hexdigest() == e["tarSha256"], f"project {pid}: size or sha256"
assert os.path.isfile(os.path.join(d, "REVOKED_ALL")) == (m.get("globalRevocation") is True), "REVOKED_ALL differs from the manifest"
print(f"tables {len(m['tables'])} workspaces {len(m.get('workspaces', {}))} projects {len(pj)} schema {m.get('schemaVersion')}")
PY
}

inventory() { (cd "$1" && find . -type f -print0 | sort -z | xargs -0 -r sha256sum); }

# ── Publish: copy, verify at the destination, mark ───────────────────────────

publish() {
	local name=$1 src="$BACKUPS_DIR/$1" inv="$STATE_DIR/$1.INVENTORY.sha256" marker="$STATE_DIR/$1.COMPLETE" v diff nlocal nremote
	v=$(verify_local "$src" 2>&1) || { FAILURE="local verification of $name: $(tail -1 <<<"$v")"; return 1; }
	log "local ok: $v"
	inventory "$src" >"$inv" || { FAILURE="inventory of $name"; return 1; }
	# No --delete, no --partial: an interrupted file is discarded, never kept truncated.
	nas_rsync -rlt --chmod=D0700,F0600 "$src/" "$NAS_DEST/$name/" || { FAILURE="copy of $name to the NAS"; return 1; }
	# The NAS's own checksums against the local files: any line is a file that differs or is missing there.
	diff=$(nas_rsync -rlc -n -i "$src/" "$NAS_DEST/$name/") || { FAILURE="checksum comparison of $name"; return 1; }
	[ -z "$diff" ] || { FAILURE="$name differs on the NAS: $(head -1 <<<"$diff")"; return 1; }
	nlocal=$(grep -c '' "$inv")
	nremote=$(nas_rsync -r --list-only "$NAS_DEST/$name/" | grep -c '^-') || true
	[ "$nlocal" = "$nremote" ] || { FAILURE="$name: $nremote files on the NAS, $nlocal here"; return 1; }
	printf '%s  %s\n' "$(sha256sum "$inv" | cut -d' ' -f1)" "$name.INVENTORY.sha256" >"$marker"
	nas_rsync -t --chmod=F0600 "$inv" "$NAS_DEST/" || { FAILURE="inventory upload of $name"; return 1; }
	# The marker goes last: it is the publication.
	nas_rsync -t --chmod=F0600 "$marker" "$NAS_DEST/" || { FAILURE="marker upload of $name"; return 1; }
	log "published $name ($nlocal files)"
}

# ── Retention ────────────────────────────────────────────────────────────────

# Remove one published backup from the NAS, by name. The marker goes FIRST, so a removal that stops
# half-way leaves an unpublished directory (reported), never a published backup with missing files.
nas_remove() {
	local name=$1
	[[ $name =~ $NAME_RE ]] || return 1
	nas_rsync -r --delete --include="/$name.COMPLETE" --exclude='/*' "$EMPTY/" "$NAS_DEST/" || return 1
	nas_rsync -r --delete --include="/$name/***" --include="/$name.INVENTORY.sha256" --exclude='/*' "$EMPTY/" "$NAS_DEST/"
}

retention() {
	local root published remove name newest
	root=$(nas_root) || { FAILURE="NAS listing for retention"; return 1; }
	published=$(sed -n 's/\.COMPLETE$//p' <<<"$root" | grep -E "$NAME_RE" || true)
	# Host: the newest stays whatever its state; an older one goes only if it is published.
	newest=$(find "$BACKUPS_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | grep -E "$NAME_RE" | sort | tail -1)
	while read -r name; do
		if [ -z "$name" ] || [ "$name" = "$newest" ]; then continue; fi
		grep -qxF "$name" <<<"$published" || { log "kept locally (not published): $name"; continue; }
		[ -f "$BACKUPS_DIR/$name/manifest.json" ] || continue
		rm -rf -- "${BACKUPS_DIR:?}/$name" && log "removed locally: $name"
	done < <(find "$BACKUPS_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | grep -E "$NAME_RE" | sort)
	# NAS: by name, from the published set only.
	remove=$(python3 -I "$HERE/retention.py" --daily "$DAILY" --weekly "$WEEKLY" <<<"$published") || { FAILURE="retention plan"; return 1; }
	while read -r name; do
		[ -n "$name" ] || continue
		if nas_remove "$name"; then log "removed from the NAS: $name"; else
			FAILURE="removing $name from the NAS"
			return 1
		fi
	done <<<"$remove"
}

# ── Status ───────────────────────────────────────────────────────────────────

write_status() { # $1 = ok|failed, $2 = name, $3 = message
	python3 -I - "$STATE_DIR/status.json" "$1" "$2" "$3" <<'PY'
import json, os, sys, time
path, result, name, msg = sys.argv[1:5]
try:
    s = json.load(open(path))
except Exception:
    s = {}
now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
s["lastRunAt"], s["lastResult"], s["lastMessage"] = now, result, msg
if result == "ok":
    s["lastPublished"], s["lastPublishedAt"] = name, now
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(s, f, indent=1)
    f.write("\n")
os.replace(tmp, path)
PY
}

fail() {
	log "FAILED: $FAILURE"
	write_status failed "${1:-}" "$FAILURE"
	if [ -n "$ALERT_CMD" ]; then $ALERT_CMD "st-backup-nas: $FAILURE" 9>&- || true; fi
	exit 1
}

# ── Commands ─────────────────────────────────────────────────────────────────

FAILURE=""
exec 9>"$STATE_DIR/lock"
flock -n 9 || { echo "STOP: another run holds the lock" >&2; exit 2; }

case "${1:-}" in
run)
	avail_gb=$(($(df --output=avail -k "$BACKUPS_DIR" | tail -1) / 1048576))
	if [ "$avail_gb" -lt "$MIN_FREE_GB" ]; then
		FAILURE="only ${avail_gb} GiB free under $BACKUPS_DIR (minimum $MIN_FREE_GB): no backup made"
		fail
	fi
	name=$(date -u +%Y-%m-%dT%H-%M-%S-%3NZ)
	log "backup $name"
	$BACKUP_CMD "$BACKUPS_DIR/$name" 9>&- || { FAILURE="the backup command failed"; fail "$name"; }
	publish "$name" || fail "$name"
	retention || fail "$name"
	write_status ok "$name" "published; retention applied"
	log "done"
	;;
adopt)
	name=${2:-}
	if ! [[ $name =~ $NAME_RE ]] || [ ! -d "$BACKUPS_DIR/$name" ]; then
		echo "STOP: adopt needs the name of a local backup" >&2
		exit 2
	fi
	publish "$name" || fail "$name"
	write_status ok "$name" "adopted"
	;;
status)
	root=$(nas_root) || { echo "NAS: unreachable"; exit 1; }
	echo "published on the NAS:"
	sed -n 's/\.COMPLETE$//p' <<<"$root" | grep -E "$NAME_RE" | sed 's/^/  /' || true
	echo "on the NAS without a marker (not counted, never removed here):"
	grep -E "$NAME_RE" <<<"$root" | while read -r n; do grep -qxF "$n.COMPLETE" <<<"$root" || echo "  $n"; done
	echo "local:"
	find "$BACKUPS_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort | while read -r n; do
		# What a failed backup command leaves: retention never counts or removes it, so say so.
		# Only a directory with a nightly's name can be this script's leftover; anything else in the
		# directory (a manual pre-deploy backup, a control-dir copy) is someone else's and is just listed.
		if [ -f "$BACKUPS_DIR/$n/manifest.json" ] || ! [[ $n =~ $NAME_RE ]]; then echo "  $n"; else echo "  $n  (no manifest: incomplete, remove by hand)"; fi
	done
	[ -r "$STATE_DIR/status.json" ] && cat "$STATE_DIR/status.json"
	;;
*)
	echo "usage: $0 run | adopt <name> | status" >&2
	exit 2
	;;
esac

#!/usr/bin/env bash
# ops/test/backup-nas.test.sh — ops/backup/st-backup-nas.sh against a local directory standing in for
# the NAS (rsync is the only transport either way). No network, no Docker.
set -uo pipefail
S=$(cd "$(dirname "$0")/.." && pwd)/backup/st-backup-nas.sh
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
FAILS=0
ok() { echo "ok: $1"; }
bad() {
	echo "FAIL: $1"
	FAILS=$((FAILS + 1))
}
is() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }

# A stand-in for `npm run backup -- <dir>`: a manifest-complete backup with one table and one workspace.
cat >"$T/fake-backup.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[ ! -e "${FAKE_BACKUP_FAIL:-/nonexistent}" ] || exit 1
d=$1
mkdir -p "$d/workspaces" "$T_SRC"
echo "payload $RANDOM $d" >"$T_SRC/file.txt"
tar -czf "$d/workspaces/sid-1.tar.gz" -C "$T_SRC" file.txt
echo '{"id":1}' >"$d/users.jsonl"
rows=${FAKE_ROWS:-1}
printf '{"version":1,"schemaVersion":20,"tables":{"users":%s},"workspaces":{"sid-1":{"tarBytes":%s,"fileCount":1}}}\n' \
	"$rows" "$(stat -c %s "$d/workspaces/sid-1.tar.gz")" >"$d/manifest.json"
SH
chmod +x "$T/fake-backup.sh"
export T_SRC="$T/src"

# new_env <name> — a fresh host + NAS; sets B (backups), N (nas), ST (state), and the config.
new_env() {
	E="$T/$1"
	B="$E/backups" N="$E/nas" ST="$E/state"
	mkdir -p "$B" "$N" "$ST"
	cat >"$E/conf" <<EOF
BACKUPS_DIR=$B
BACKUP_CMD=$T/fake-backup.sh
NAS_DEST=$N
STATE_DIR=$ST
MIN_FREE_GB=0
ALERT_CMD=$T/alert.sh
EOF
	export ST_BACKUP_CONF="$E/conf"
	: >"$T/alerts"
}
printf '#!/usr/bin/env bash\necho "$1" >>%q\n' "$T/alerts" >"$T/alert.sh"
chmod +x "$T/alert.sh"
run() { bash "$S" "$@" >"$E/out.txt" 2>&1; }
locals() { find "$B" -mindepth 1 -maxdepth 1 -type d | wc -l; }
published() { find "$N" -maxdepth 1 -name '*.COMPLETE' | wc -l; }
# seed <name> [unpublished] — an older backup already on the NAS (and not on the host).
seed() {
	mkdir -p "$N/$1"
	echo x >"$N/$1/manifest.json"
	[ "${2:-}" = unpublished ] || { echo x >"$N/$1.INVENTORY.sha256"; echo x >"$N/$1.COMPLETE"; }
}

# ── A run publishes; the host keeps only the newest ──────────────────────────
new_env happy
run run
is "first run succeeds" "$?" 0
is "one backup published" "$(published)" 1
is "one local backup" "$(locals)" 1
first=$(ls "$B")
is "the NAS holds the same bytes" "$(cd "$N/$first" && find . -type f -exec sha256sum {} + | sort)" "$(cd "$B/$first" && find . -type f -exec sha256sum {} + | sort)"
is "the marker names the inventory's hash" "$(cut -d' ' -f1 "$N/$first.COMPLETE")" "$(sha256sum "$N/$first.INVENTORY.sha256" | cut -d' ' -f1)"
is "status says ok" "$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["lastResult"])' "$ST/status.json")" ok
sleep 0.01
run run
is "second run succeeds" "$?" 0
is "two published" "$(published)" 2
is "the older local one is gone (it is published)" "$(locals)" 1
[ ! -d "$B/$first" ] && ok "…and it is the first that went" || bad "the first local backup is still there"
is "no alert on success" "$(wc -l <"$T/alerts")" 0

# ── The backup command fails: nothing published, nothing removed, alert ──────
new_env cmdfail
run run
touch "$E/fail"
FAKE_BACKUP_FAIL="$E/fail" run run
is "a failing backup command ends non-zero" "$?" 1
is "nothing new published" "$(published)" 1
is "the existing local backup stays" "$(locals)" 1
is "status says failed" "$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["lastResult"])' "$ST/status.json")" failed
is "the last published one is still recorded" "$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["lastPublished"])' "$ST/status.json")" "$(ls "$B")"
is "one alert" "$(wc -l <"$T/alerts")" 1

# ── A backup that contradicts its own manifest is not copied ─────────────────
new_env badlocal
FAKE_ROWS=2 run run
is "a manifest mismatch ends non-zero" "$?" 1
is "nothing published" "$(published)" 0
is "nothing reached the NAS" "$(find "$N" -mindepth 1 | wc -l)" 0

# ── The NAS is unreachable: locals accumulate, nothing is deleted ────────────
new_env nasdown
run run
sed -i "s|^NAS_DEST=.*|NAS_DEST=$E/missing/nas|" "$E/conf"
sleep 0.01
run run
is "an unreachable NAS ends non-zero" "$?" 1
sleep 0.01
run run
is "three local backups are kept (two unpublished)" "$(locals)" 3
sed -i "s|^NAS_DEST=.*|NAS_DEST=$N|" "$E/conf"
sleep 0.01
run run
is "the NAS is back: the run succeeds" "$?" 0
is "published locals went; unpublished ones and the newest stay" "$(locals)" 3
mid=$(ls "$B" | sed -n 1p)
run adopt "$mid"
is "adopt publishes an older local backup" "$?" 0
[ -f "$N/$mid.COMPLETE" ] && ok "…with its marker" || bad "no marker for the adopted backup"

# ── The copy differs at the destination: not published ───────────────────────
new_env corrupt
mkdir -p "$E/bin"
cat >"$E/bin/rsync" <<SH
#!/usr/bin/env bash
# The real rsync; after the copy (the only call with -rlt) one file on the "NAS" loses its content.
$(command -v rsync) "\$@"
rc=\$?
for a in "\$@"; do [ "\$a" = "-rlt" ] && find "$N" -name users.jsonl -exec sh -c 'echo "{\"id\":2}" >"\$1"; touch -r "\$2" "\$1"' _ {} "$T/fake-backup.sh" \;; done
exit \$rc
SH
chmod +x "$E/bin/rsync"
PATH="$E/bin:$PATH" run run
is "a copy that differs ends non-zero" "$?" 1
is "it is not published" "$(published)" 0
is "the local backup stays" "$(locals)" 1
grep -q "differs on the NAS" "$E/out.txt" && ok "the log says which backup differs" || bad "no 'differs' line: $(tail -2 "$E/out.txt")"

# ── NAS retention: by name, published only ───────────────────────────────────
new_env retention
for d in 2020-01-01 2020-01-02 2020-01-03 2020-01-04 2020-01-05; do seed "${d}T08-17-01-000Z"; done
seed 2019-12-20T08-17-01-000Z unpublished
mkdir -p "$N/manual/pre-abc" && echo keep >"$N/manual/pre-abc/f"
run run
is "the run succeeds" "$?" 0
# Newest three: today's, 01-05, 01-04. Weekly: the newest of the newest earlier ISO week = 01-05 (kept already).
is "published after retention" "$(find "$N" -maxdepth 1 -name '*.COMPLETE' -printf '%f\n' | grep -c .)" 3
[ ! -e "$N/2020-01-03T08-17-01-000Z" ] && [ ! -e "$N/2020-01-03T08-17-01-000Z.INVENTORY.sha256" ] && ok "an expired backup is gone with its files" || bad "expired backup left behind"
[ -d "$N/2020-01-04T08-17-01-000Z" ] && [ -d "$N/2020-01-05T08-17-01-000Z" ] && ok "the dailies stay" || bad "a daily was removed"
[ -d "$N/2019-12-20T08-17-01-000Z" ] && ok "a directory without a marker is never removed" || bad "the unpublished directory was removed"
[ -f "$N/manual/pre-abc/f" ] && ok "anything else on the NAS is untouched" || bad "manual/ was touched"
run status
grep -q "2019-12-20T08-17-01-000Z" "$E/out.txt" && ok "status reports the unmarked directory" || bad "status does not list it"

# ── Low disk: no backup is made ──────────────────────────────────────────────
new_env lowdisk
sed -i 's/^MIN_FREE_GB=.*/MIN_FREE_GB=100000000/' "$E/conf"
run run
is "below the free-space minimum ends non-zero" "$?" 1
is "and makes no backup" "$(locals)" 0

if [ "$FAILS" = 0 ]; then echo "all backup-nas tests passed"; else
	echo "$FAILS backup-nas test(s) FAILED"
	exit 1
fi

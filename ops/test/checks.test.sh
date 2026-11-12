#!/bin/bash
# ops/test/checks.test.sh — tests for ops/lib/checks.sh. Each case reproduces a failure seen in the D1
# rollout (2026-11-12) and its opposite, so a check can neither stop for nothing nor pass without looking.
# Run: bash ops/test/checks.test.sh   (no network, no Docker: `docker` is a stub on PATH)
# shellcheck disable=SC2016 # expect_true/expect_false eval their single-quoted expression on purpose
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR source=../lib/checks.sh
source "$HERE/../lib/checks.sh"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
pass=0; failed=0
ok() { pass=$((pass + 1)); }
bad() { failed=$((failed + 1)); echo "FAILED: $*"; }
expect_eq() { if [ "$2" = "$3" ]; then ok; else bad "$1: got [$2] want [$3]"; fi; }
expect_true() { if eval "$2"; then ok; else bad "$1"; fi; }
expect_false() { if eval "$2"; then bad "$1"; else ok; fi; }

# ── chk / stop ──
FAIL=0; out=$(chk "x" a a); expect_eq "chk ok line" "$out" "  ok: x (a)"; expect_eq "chk ok keeps FAIL=0" "$FAIL" 0
FAIL=0; chk "x" a b >/dev/null; expect_eq "chk mismatch sets FAIL" "$FAIL" 1
out=$( (stop "boom"); echo "rc=$?"); expect_eq "stop exits 1 with its reason" "$out" "STOP: boom
rc=1"

# ── IDs: the vacuous-404 case (an empty id from a failed query) ──
expect_true "uuid accepted" 'is_uuid a06113d8-a0de-407f-8e21-1345b5f05a4f'
for v in "" "ERR no such column: deleted_at" "a06113d8" "A06113D8-A0DE-407F-8E21-1345B5F05A4F" "../etc" "a06113d8-a0de-407f-8e21-1345b5f05a4f/x"; do
	expect_false "not a uuid: [$v]" "is_uuid '$v'"
done
out=$( (require_uuid "Pilot project id" ""); echo "rc=$?")
expect_true "require_uuid stops on an empty id, naming the risk" '[[ "$out" == *"STOP: Pilot project id is not a valid id []"*"vacuous"* && "$out" == *"rc=1" ]]'
out=$( (require_uuid "Pilot project id" a06113d8-a0de-407f-8e21-1345b5f05a4f); echo "rc=$?")
expect_eq "require_uuid passes a real id silently" "$out" "rc=0"

# ── .env key delta: the hunk-header case ──
printf 'A=1\nB=secret-value\nC=\n# comment\n' >"$T/env.before"
cp "$T/env.before" "$T/env.after"; printf 'PROJECT_CONVERSATION_ENABLED=true\n' >>"$T/env.after"
expect_eq "one added key ⇒ exactly that line (no '4a5' header)" "$(env_key_delta "$T/env.before" "$T/env.after")" "> PROJECT_CONVERSATION_ENABLED"
expect_eq "same keys ⇒ empty delta" "$(env_key_delta "$T/env.before" "$T/env.before")" ""
printf 'A=1\nB=other\nC=\n' >"$T/env.valchange"
expect_eq "a value change alone is not a key change" "$(env_key_delta "$T/env.before" "$T/env.valchange")" ""
printf 'A=1\nC=\nD=1\n' >"$T/env.swap"
expect_eq "removed + added keys both show" "$(env_key_delta "$T/env.before" "$T/env.swap" | tr '\n' ';')" "< B;> D;"
expect_false "the delta never prints a value" '[[ "$(env_key_delta "$T/env.before" "$T/env.after")" == *secret* ]]'

# ── flag transition: absent vs forwarded-empty (since #591) ──
printf 'NODE_ENV=production\nPROJECT_CHAT_ENABLED=true\nPROJECT_CONVERSATION_ENABLED=\n' >"$T/f.empty"
printf 'NODE_ENV=production\nPROJECT_CHAT_ENABLED=true\n' >"$T/f.absent"
printf 'NODE_ENV=production\nPROJECT_CHAT_ENABLED=true\nPROJECT_CONVERSATION_ENABLED=true\n' >"$T/f.on"
expect_true "empty → true is the one transition" 'flag_transition "$T/f.empty" "$T/f.on" PROJECT_CONVERSATION_ENABLED true'
expect_true "absent → true is the one transition" 'flag_transition "$T/f.absent" "$T/f.on" PROJECT_CONVERSATION_ENABLED true'
printf 'NODE_ENV=development\nPROJECT_CHAT_ENABLED=true\nPROJECT_CONVERSATION_ENABLED=true\n' >"$T/f.on.other"
expect_false "another flag changing too is refused" 'flag_transition "$T/f.empty" "$T/f.on.other" PROJECT_CONVERSATION_ENABLED true'
printf 'NODE_ENV=production\nPROJECT_CHAT_ENABLED=true\nPROJECT_CONVERSATION_ENABLED=1\n' >"$T/f.on1"
expect_false "a different value is refused" 'flag_transition "$T/f.empty" "$T/f.on1" PROJECT_CONVERSATION_ENABLED true'
expect_false "no change at all is refused" 'flag_transition "$T/f.empty" "$T/f.empty" PROJECT_CONVERSATION_ENABLED true'

# ── logs: an informational line is not a refusal ──
cat >"$T/app.log" <<'LOG'
app-1  | 2026-11-12T17:10:00.000Z {"level":30,"msg":"[server] old boot"}
app-1  | 2026-11-12T17:16:48.041Z {"level":30,"msg":"[projects] writer lock held"}
app-1  | 2026-11-12T17:16:48.100Z {"level":30,"msg":"[server] project conversation ENABLED (D1)"}
LOG
since=$(log_since "$T/app.log" 2026-11-12T17:16:00Z)
expect_eq "log_since drops the old boot" "$(printf '%s\n' "$since" | wc -l | tr -d ' ')" 2
expect_eq "the positive lock line is found literally" "$(count_fixed "$since" '[projects] writer lock held')" 1
expect_eq "no refusal in it" "$(count_fixed "$since" 'project-writer-unavailable')" 0
expect_eq "count_fixed treats brackets literally (not a regex class)" "$(count_fixed "$since" '[x]')" 0

# ── kernel lock table: held / not held / missing file ──
touch "$T/.writer.lock"; ino=$(stat -c '%i' "$T/.writer.lock")
printf '1: FLOCK  ADVISORY  WRITE 4242 08:01:%s 0 EOF\n2: POSIX  ADVISORY  WRITE 1 08:01:999 0 EOF\n' "$ino" >"$T/locks.held"
printf '1: POSIX  ADVISORY  WRITE 4242 08:01:%s 0 EOF\n2: FLOCK  ADVISORY  WRITE 7 08:01:%s1 0 EOF\n' "$ino" "$ino" >"$T/locks.not"
expect_eq "FLOCK on the inode ⇒ held" "$(flock_held "$T/.writer.lock" "$T/locks.held")" held
expect_eq "POSIX lock or another inode (prefix match) ⇒ not-held" "$(flock_held "$T/.writer.lock" "$T/locks.not")" not-held
expect_eq "missing lock file ⇒ no-file" "$(flock_held "$T/nope" "$T/locks.held")" no-file
printf '1: FLOCK  ADVISORY  WRITE 4242 00:2f:%s 0 EOF\n' "$ino" >"$T/locks.ovl"
expect_eq "any MAJ:MIN prefix (overlay/bind mounts)" "$(flock_held "$T/.writer.lock" "$T/locks.ovl")" held

# ── docker: the --rm removal race ──
mkdir "$T/bin"; cat >"$T/bin/docker" <<'STUB'
#!/bin/bash
# stub: `ps -aq --filter ancestor=…` answers a container id while $STATE/n > 0, decrementing it.
n=$(cat "$STATE/n"); if [ "$n" -gt 0 ]; then echo c71539d1d683; echo $((n - 1)) >"$STATE/n"; fi
STUB
chmod +x "$T/bin/docker"
export STATE="$T"
echo 2 >"$T/n"
expect_true "waits out a container still being removed" 'PATH="$T/bin:$PATH" wait_image_unused st-backup-tool:x 5'
echo 99 >"$T/n"
expect_false "gives up (rc 1) if something keeps using it" 'PATH="$T/bin:$PATH" wait_image_unused st-backup-tool:x 2'

echo "checks.test.sh: $pass passed, $failed failed"
[ "$failed" = 0 ]

# shellcheck shell=bash
# ops/lib/checks.sh — the checks the VM100 deploy/activation scripts rely on, as tested functions.
#
# Every function here exists because an inline version of it was wrong during the D1 rollout
# (2026-11-12) and a gate either stopped for nothing or — worse — passed without having looked:
#   - an ID query that failed returned "" and every route check after it hit /projects//… (vacuous 404s);
#   - `diff`'s hunk header ("20a21") made a one-key .env change look like an unexpected change;
#   - an informational log line ("writer lock held") matched a refusal regex;
#   - `docker run --rm` removes its container asynchronously, so an immediate `docker image rm` raced it;
#   - a compose key forwarded EMPTY (since #591) is not the same as an absent one.
# No host-specific value (paths, domains, ids) lives here: callers pass everything in.
#
# Usage: source this file; set FAIL=0 before using chk; `stop` exits 1.

# ── Reporting ────────────────────────────────────────────────────────────────

# chk <label> <got> <want> — prints ok/FAIL and sets FAIL=1 on a mismatch (never exits).
chk() {
	if [ "$2" = "$3" ]; then
		echo "  ok: $1 ($2)"
	else
		echo "  FAIL: $1 (got '$2', want '$3')"
		# shellcheck disable=SC2034 # read by the sourcing script
		FAIL=1
	fi
}

# stop <message> — a gate failed: say why and exit 1 (callers never continue past it).
stop() {
	echo "STOP: $*"
	exit 1
}

# ── Identifiers ──────────────────────────────────────────────────────────────

# is_uuid <value> — true for a lowercase canonical UUID (what D1/the project log store).
is_uuid() {
	[[ "$1" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
}

# require_uuid <label> <value> — stop unless value is a UUID. Use it on every ID a later check
# interpolates into a URL or path: an empty ID turns those checks into vacuous passes.
require_uuid() {
	is_uuid "$2" || stop "$1 is not a valid id [$2] — the checks that use it would be vacuous"
}

# ── .env and flags (values never printed) ────────────────────────────────────

# env_key_names <file> — the KEY names of a dotenv file, sorted (values are never read out).
# Accepts what Compose's .env parser accepts: leading spaces, an `export ` prefix, spaces around `=`.
env_key_names() {
	sed -n -E 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*/\2/p' "$1" | LC_ALL=C sort
}

# env_key_delta <before> <after> — only the changed key-name lines ("< K" removed, "> K" added),
# never diff's hunk headers. Empty output = same key set. STOPS if either file can't be read: an
# unreadable snapshot must never pass as "nothing changed".
env_key_delta() {
	if [ ! -r "$1" ] || [ ! -r "$2" ]; then stop "env_key_delta: cannot read [$1] / [$2]"; fi
	diff <(env_key_names "$1") <(env_key_names "$2") | grep -E '^[<>] ' || true
}

# flag_transition <before> <after> <KEY> <value> — for two "KEY=value" listings (e.g. a container's
# env), succeed iff the ONLY difference is KEY going from absent or empty to exactly <value>.
flag_transition() {
	local d want_absent want_empty
	d=$(diff <(LC_ALL=C sort "$1") <(LC_ALL=C sort "$2") | grep -E '^[<>] ' | tr '\n' ';' || true)
	want_absent="> $3=$4;"
	want_empty="< $3=;> $3=$4;"
	[ "$d" = "$want_absent" ] || [ "$d" = "$want_empty" ]
}

# ── Logs ─────────────────────────────────────────────────────────────────────

# log_since <log> <iso-time> — the lines of a `--timestamps` compose log at or after a time,
# compared to the second (both sides cut to YYYY-MM-DDTHH:MM:SS: a fractional `…00.123Z` must not
# sort before `…00Z`, or the restart's first second would be dropped). Returns 1 when NO line has a
# timestamp (a log captured without --timestamps), so "0 refusals since …" can't pass vacuously,
# and 2 when the time itself is not a UTC second-precision ISO time.
# Digits are spelled out: mawk before 2020 reads `{4}` literally and would match nothing.
log_since() {
	# The time must be UTC to the second: an EMPTY one (a failed capture) would keep every line, so a
	# positive gate could pass on the previous boot; an offset or a minute-only form compares wrong.
	[[ "$2" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$ ]] || return 2
	awk -v t="${2:0:19}" '
		{ for (i = 1; i <= NF; i++) if ($i ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]/) { seen = 1; if (substr($i, 1, 19) >= t) print; break } }
		END { exit !seen }' "$1"
}

# count_fixed <text> <literal> — how many lines contain the literal (grep -F: a message is not a regex).
count_fixed() {
	printf '%s\n' "$1" | grep -cF -- "$2" || true
}

# ── Kernel lock table ────────────────────────────────────────────────────────

# flock_held <file> [locks] — "held" iff a FLOCK lock is on that file (device AND inode), read from
# the kernel lock table (default /proc/locks, whose 6th field is `%02x:%02x:%lu` = major:minor:inode).
# Never tries to take the lock itself: doing so would ACQUIRE it when the owner has lost it, hiding
# exactly the failure being checked. Blocked waiters (`->` lines) shift the fields and never count.
flock_held() {
	local dev ino id
	# %d is st_dev (the filesystem's device) in decimal; decode it like the kernel's new_decode_dev.
	# NOT %t/%T: those are the major/minor a device FILE represents (0:0 for a regular file).
	read -r dev ino < <(stat -c '%d %i' "$1" 2>/dev/null) || { echo "no-file"; return 0; }
	[ -n "$ino" ] || { echo "no-file"; return 0; }
	id=$(printf '%02x:%02x:%s' "$(((dev >> 8) & 0xfff))" "$(((dev & 0xff) | ((dev >> 12) & 0xfff00)))" "$ino")
	awk -v id="$id" '$2 == "FLOCK" && $6 == id { c++ } END { print (c > 0) ? "held" : "not-held" }' "${2:-/proc/locks}"
}

# ── Docker ───────────────────────────────────────────────────────────────────

# wait_image_unused <image> [seconds] — wait until no container (any state) uses the image.
# `docker run --rm` removes its container asynchronously after the process exits; an `image rm`
# right after it can race that removal. Returns 1 if something still uses it after the wait.
# Returns 2 if Docker itself can't answer: an unreachable daemon is not "unused".
wait_image_unused() {
	local i out
	for ((i = 0; i < ${2:-60}; i++)); do
		out=$(docker ps -aq --filter ancestor="$1") || return 2
		[ -z "$out" ] && return 0
		sleep 1
	done
	return 1
}

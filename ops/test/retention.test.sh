#!/usr/bin/env bash
# ops/test/retention.test.sh — ops/backup/retention.py. No network, no Docker.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
R=backup/retention.py
FAILS=0

# t <label> <want (space-separated, "" for none)> <args…> — names come on stdin.
t() {
	local label=$1 want=$2 got
	shift 2
	got=$(python3 -I "$R" "$@" | tr '\n' ' ' | sed 's/ $//')
	if [ "$got" = "$want" ]; then
		echo "ok: $label"
	else
		echo "FAIL: $label (got '$got', want '$want')"
		FAILS=$((FAILS + 1))
	fi
}
n() { printf '%sT08-17-0%s-000Z\n' "$1" "${2:-1}"; }

# 2026-11-16 is a Monday; 2026-11-15 a Sunday (ISO week 46).
t "nothing to remove while there are fewer than the dailies" "" < <(n 2026-11-15; n 2026-11-16)
t "empty input" "" </dev/null

t "three dailies; the previous week's newest is one of them" \
	"$(n 2026-11-12) $(n 2026-11-13)" \
	< <(for d in 12 13 14 15 16; do n 2026-11-$d; done)

t "midweek: three dailies + last Sunday; the rest of last week goes" \
	"$(n 2026-11-13) $(n 2026-11-14) $(n 2026-11-16) $(n 2026-11-17)" \
	< <(for d in 13 14 15 16 17 18 19 20; do n 2026-11-$d; done)

t "the week before last is not kept with weekly=1" \
	"$(n 2026-11-08) $(n 2026-11-16)" \
	< <(n 2026-11-08; n 2026-11-15; for d in 16 17 18 19; do n 2026-11-$d; done)

t "weekly=2 keeps the newest of the two previous weeks" \
	"$(n 2026-11-16)" --weekly 2 \
	< <(n 2026-11-08; n 2026-11-15; for d in 16 17 18 19; do n 2026-11-$d; done)

t "two backups the same day are two backups" \
	"$(n 2026-11-18 1)" \
	< <(n 2026-11-15; n 2026-11-18 1; n 2026-11-18 2; n 2026-11-19; n 2026-11-20)

t "backups stopped a month ago: the clock removes nothing" \
	"" \
	< <(n 2026-10-11; n 2026-10-13; n 2026-10-14; n 2026-10-15)

t "the year boundary uses ISO weeks (2027-01-03 is week 53 of 2026)" \
	"$(n 2027-01-02)" \
	< <(n 2027-01-02; n 2027-01-03; n 2027-01-04; n 2027-01-05; n 2027-01-06)

# A name it does not recognise: exit 2 and NOTHING on stdout.
out=$(printf '%s\n' "$(n 2026-11-10)" "$(n 2026-11-11)" "$(n 2026-11-12)" "$(n 2026-11-13)" "manual" | python3 -I "$R" 2>/dev/null)
rc=$?
if [ "$rc" = 2 ] && [ -z "$out" ]; then echo "ok: an unknown name refuses the whole plan"; else
	echo "FAIL: unknown name (rc=$rc out='$out')"
	FAILS=$((FAILS + 1))
fi
out=$(printf '%s\n' "$(n 2026-11-10)" "$(n 2026-11-10)" | python3 -I "$R" 2>/dev/null)
rc=$?
if [ "$rc" = 2 ] && [ -z "$out" ]; then echo "ok: duplicates refuse the plan"; else
	echo "FAIL: duplicates (rc=$rc)"
	FAILS=$((FAILS + 1))
fi
out=$(n 2026-11-10 | python3 -I "$R" --daily 0 2>/dev/null)
rc=$?
if [ "$rc" = 2 ] && [ -z "$out" ]; then echo "ok: --daily 0 is refused"; else
	echo "FAIL: --daily 0 (rc=$rc)"
	FAILS=$((FAILS + 1))
fi

if [ "$FAILS" = 0 ]; then echo "all retention tests passed"; else
	echo "$FAILS retention test(s) FAILED"
	exit 1
fi

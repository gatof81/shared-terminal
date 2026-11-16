#!/usr/bin/env python3
"""retention.py — which published backups may be removed.

Reads backup names (one per line, `npm run backup`'s default ISO-time names,
e.g. `2026-11-16T08-17-02-343Z`) on stdin and prints the names to REMOVE,
oldest first.

Kept: the newest DAILY backups, plus the newest backup of each of the WEEKLY
most recent ISO weeks before the newest backup's own week.

The reference point is the newest backup, never the clock: if backups stop
being made, nothing ages out and nothing is removed. A name that does not
parse is an error (exit 2, nothing printed) — the caller must only pass names
it has already recognised as published backups; guessing here could delete
one.
"""

import argparse
import re
import sys
from datetime import date

NAME = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T\d{2}-\d{2}-\d{2}-\d{3}Z$")


def plan(names, daily, weekly):
    days = {}
    for n in names:
        m = NAME.match(n)
        if not m:
            raise ValueError(f"not a backup name: {n!r}")
        days[n] = date(int(m[1]), int(m[2]), int(m[3]))
    # ISO-time names sort chronologically as strings.
    ordered = sorted(days, reverse=True)
    keep = set(ordered[:daily])
    if ordered and weekly > 0:
        newest_week = days[ordered[0]].isocalendar()[:2]
        weeks = []
        for n in ordered:
            w = days[n].isocalendar()[:2]
            if w >= newest_week or w in weeks:
                continue
            weeks.append(w)
            if len(weeks) > weekly:
                break
            keep.add(n)
    return [n for n in sorted(days) if n not in keep]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--daily", type=int, default=3)
    p.add_argument("--weekly", type=int, default=1)
    a = p.parse_args()
    if a.daily < 1 or a.weekly < 0:
        print("--daily must be >= 1 and --weekly >= 0", file=sys.stderr)
        return 2
    names = [line.strip() for line in sys.stdin if line.strip()]
    if len(set(names)) != len(names):
        print("duplicate names", file=sys.stderr)
        return 2
    try:
        remove = plan(names, a.daily, a.weekly)
    except ValueError as e:
        print(str(e), file=sys.stderr)
        return 2
    for n in remove:
        print(n)
    return 0


if __name__ == "__main__":
    sys.exit(main())

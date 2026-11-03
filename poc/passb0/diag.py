#!/usr/bin/env python3
"""PASS-B0 read-only diagnosis of a finished run (04-poc.md §1.14.10). Standard library only.

    diag.py BASE [--full-log FILE]

Reads BASE/env, BASE/state and BASE/results; writes nothing, runs nothing, touches no
container. Prints JSON with aliases, booleans, millisecond offsets and redacted debug-log
lines: no pid, inode, connection token, nonce or uid leaves it. --full-log adds ±3 lines of
context around each flagged plugin line, from an unfiltered copy of the CLI's debug log.
Review the output before sharing it.
"""
import datetime
import glob
import json
import os
import re
import stat
import sys

# The same two expressions as analyze.py, so a flagged line here is a flagged line there.
DEBUG_MOD = re.compile(r"st-passb0-probe")
DEBUG_BAD = re.compile(r"skipped|failed|refused|not loaded|was not loaded|error", re.I)
UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
HEX = re.compile(r"\b[0-9a-f]{8,}\b")
HOME = re.compile(r"/home/[^/\s\"']+")
TS = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?)Z?\s")


def redact(line, width=400):
    line = UUID.sub("<uuid>", line.rstrip("\n"))
    line = HEX.sub("<hex>", line)
    line = HOME.sub("/home/<user>", line)
    return line[:width]


def template(line):
    t = TS.sub("<ts> ", redact(line, 240))
    return re.sub(r"\b\d+\b", "<n>", t)


def ts_ms(line):
    m = TS.match(line)
    if not m:
        return None
    try:
        d = datetime.datetime.fromisoformat(m.group(1)).replace(tzinfo=datetime.timezone.utc)
        return int(d.timestamp() * 1000)
    except ValueError:
        return None


def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def read_jsonl(path):
    rows = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    except OSError:
        return None
    return rows


def read_env(base):
    env = {}
    with open(os.path.join(base, "env"), encoding="utf-8") as f:
        for line in f:
            k, _, v = line.rstrip("\n").partition("=")
            if re.fullmatch(r"[A-Z_]+", k):
                env[k] = v
    return env


def file_facts(path, server_uid):
    try:
        st = os.stat(path)
    except OSError as e:
        return {"present": False, "error": type(e).__name__}
    return {"present": True, "mode": oct(stat.S_IMODE(st.st_mode)),
            "other_readable": bool(st.st_mode & stat.S_IROTH),
            "owner_is_server_uid": None if server_uid is None else st.st_uid == server_uid,
            "owner_uid_is_1000": st.st_uid == 1000}


def debug_facts(path, full_log=None, windows=()):
    out = {"present": os.path.exists(path)}
    if not out["present"]:
        return out
    with open(path, encoding="utf-8", errors="replace") as f:
        lines = [l for l in f if DEBUG_MOD.search(l)]
    t0 = next((t for t in map(ts_ms, lines) if t is not None), None)
    flagged = []
    for i, l in enumerate(lines):
        words = sorted({m.group(0).lower() for m in DEBUG_BAD.finditer(l)})
        if words:
            t = ts_ms(l)
            # Which mod call was in progress when the line was logged, and how far into it.
            during = [(lab, t - a) for lab, a, b in windows if t is not None and a <= t <= b]
            flagged.append({"index": i, "dt_ms": None if t is None or t0 is None else t - t0, "matched": words,
                            "during_call": during[0][0] if during else None, "ms_into_call": during[0][1] if during else None,
                            "text": redact(l)})
    counts = {}
    for l in lines:
        counts[template(l)] = counts.get(template(l), 0) + 1
    out.update(mod_lines=len(lines), flagged=flagged, templates=[{"count": c, "template": t} for t, c in counts.items()])
    if full_log:
        with open(full_log, encoding="utf-8", errors="replace") as f:
            full = f.readlines()
        ctx = []
        for i, l in enumerate(full):
            if DEBUG_MOD.search(l) and DEBUG_BAD.search(l):
                ctx.append({"line": i, "context": [redact(x, 300) for x in full[max(0, i - 3): i + 4]]})
        out["full_log_context"] = ctx
    return out


def diagnose(base, full_log=None):
    env = read_env(base)
    res, run = env.get("RES", ""), env.get("RUN", "")
    ident = read_json(os.path.join(base, "state", "server-h.identity.json")) or {}
    server_uid = ident.get("uid") if isinstance(ident.get("uid"), int) else None
    mods = sorted((r for r in (read_json(p) for p in glob.glob(os.path.join(res, "mod", "*.json"))) if isinstance(r, dict)),
                  key=lambda r: r.get("seq", 0))
    srv = {"c": read_jsonl(os.path.join(res, "c.jsonl")) or [], "h": read_jsonl(os.path.join(res, "h.jsonl")) or []}
    held_h = read_json(os.path.join(res, "held-h.json"))
    report = read_json(os.path.join(res, "report.json")) or {}

    calls, windows = {}, []
    for i, r in enumerate(mods):
        if r.get("kind") != "call":
            continue
        start = mods[i - 1].get("t") if i > 0 else None  # the previous emit is when this call began
        lab, tgt = r.get("label"), r.get("target")
        hits = [s for s in srv.get(tgt, []) if s.get("label") == lab and s.get("nonce") == r.get("nonce")]
        s = hits[0] if len(hits) == 1 else None
        rel = (lambda t: t - start if isinstance(t, int) and isinstance(start, int) else None)
        row = {"ok": r.get("ok"), "server_records": len(hits),
               "ms": {"server_accept": rel((s or {}).get("t_ms")), "mod_emit": rel(r.get("t"))}}
        if s is not None:
            p = s.get("proc") or {}
            row["server_read_cli_exe"] = "exe_name" in p
            row["server_exe_error"] = p.get("exe_error")
            row["server_peer_ino_known"] = isinstance(s.get("peer_ino"), int)
        if lab and lab.startswith("hold"):
            wh, ch = r.get("waitheld") or {}, r.get("child")
            row["waitheld"] = {"waited": wh.get("waited") is True, "conn_matches_call": wh.get("conn") is not None and wh.get("conn") == r.get("conn"),
                               **{k: wh[k] for k in ("error", "exit", "held_last_error", "ms") if k in wh}}
            row["fdcheck_ran"] = isinstance(ch, dict)
            if isinstance(ch, dict):
                row["fdcheck"] = {"waited": ch.get("waited") is True, "exit": ch.get("exit"), "error": ch.get("error"),
                                  "held_last_error": ch.get("held_last_error"),
                                  "conn_matches_call": ch.get("held_conn") is not None and ch.get("held_conn") == r.get("conn")}
            if lab == "hold-h" and isinstance(held_h, dict):
                row["ms"]["held_file_written"] = rel(held_h.get("t_ms"))
                row["held_file_conn_matches_call"] = held_h.get("conn") is not None and held_h.get("conn") == r.get("conn")
                row["held_file_peer_ino_known"] = isinstance(held_h.get("peer_ino"), int)
        calls[lab] = row
        if isinstance(start, int) and isinstance(r.get("t"), int):
            windows.append((lab, start, r["t"]))

    return {
        "kit_commit_prefix": env.get("COMMIT", "")[:7],
        "verdict": report.get("verdict"), "reasons": report.get("reasons"),
        "host_server": {"identity_present": bool(ident), "uid_is_1000": None if server_uid is None else server_uid == 1000,
                        "operator_is_server_uid": None if server_uid is None else os.getuid() == server_uid},
        "held_h_file": {"results_copy": file_facts(os.path.join(res, "held-h.json"), server_uid),
                        "run_dir": file_facts(os.path.join(run, "held-h.json"), server_uid) if run else None},
        "calls": calls,
        "debug": debug_facts(os.path.join(res, "claude-debug.log"), full_log, windows),
    }


def main(argv):
    if len(argv) == 2:
        full = None
    elif len(argv) == 4 and argv[2] == "--full-log":
        full = argv[3]
    else:
        print(__doc__.strip(), file=sys.stderr)
        return 64
    print(json.dumps(diagnose(argv[1], full), indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

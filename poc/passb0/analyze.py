#!/usr/bin/env python3
"""PASS-B0 analyzer (04-poc.md §1.14.6). Standard library only, so it runs on the
host next to the host server with nothing installed.

    analyze.py report RESULTS_DIR      prints the verdict as JSON; exit 0 only on PASS

The report carries aliases (CLI, BASE-C, BASE-H, CHILD, OTHER-n) and booleans:
no pid, inode, connection token or nonce leaves this script.
"""
import glob
import json
import os
import re
import sys

SCOPE = "B0: viabilidad del socket (credenciales del par sobre conexiones concretas); no evalúa clave, MAC, instalación administrada ni ataques"
MOD_CALLS = ("c1", "h1", "h2", "hold-c", "hold-h")
INCONCLUSIVE_ERRORS = {"network-policy", "nonessential-disabled"}
DEBUG_MOD = re.compile(r"st-passb0-probe")
# The only version this experiment is approved for (owner decision); it must hold at the
# preflight, in the container before the run and after it.
WANT_CLI = "2.1.314"
DEBUG_BAD = re.compile(r"skipped|failed|refused|not loaded|was not loaded|error", re.I)


def _jsonl(path):
    rows, bad = [], 0
    if not os.path.exists(path):
        return None, 0
    with open(path, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                bad += 1
    return rows, bad


def _json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def load(d):
    mod, mod_bad = [], 0
    for p in sorted(glob.glob(os.path.join(d, "mod", "*.json"))):
        r = _json(p)
        if isinstance(r, dict):
            mod.append(r)
        else:
            mod_bad += 1
    c, c_bad = _jsonl(os.path.join(d, "c.jsonl"))
    h, h_bad = _jsonl(os.path.join(d, "h.jsonl"))
    debug = None
    dp = os.path.join(d, "claude-debug.log")
    if os.path.exists(dp):
        with open(dp, encoding="utf-8", errors="replace") as f:
            lines = [l for l in f if DEBUG_MOD.search(l)]
        debug = {"mod_lines": len(lines), "mod_bad_lines": sum(1 for l in lines if DEBUG_BAD.search(l))}
    return {
        "mod": mod, "mod_bad": mod_bad,
        "c": c, "h": h, "server_bad": c_bad + h_bad,
        "cliinfo": _json(os.path.join(d, "cliinfo.json")),
        "base_c": _json(os.path.join(d, "base-c.json")),
        "base_h": _json(os.path.join(d, "base-h.json")),
        "control": _json(os.path.join(d, "control-c.json")),
        "rocheck": _json(os.path.join(d, "rocheck.json")),
        "debug": debug,
        "preflight": _json(os.path.join(d, "preflight.json")),
        "manifest": _json(os.path.join(d, "capture-manifest.json")),
        "cli_before": _json(os.path.join(d, "cli-version-before.json")),
        "cli_after": _json(os.path.join(d, "cli-version-after.json")),
    }


def analyze(D):
    fails, incs, facts = [], [], {}

    def fail(r):
        fails.append(r)

    def inc(r):
        incs.append(r)

    def done():
        verdict = "FAIL" if fails else "INCONCLUSIVE" if incs else "PASS"
        return {"scope": SCOPE, "verdict": verdict, "reasons": fails + incs, "facts": facts}

    # ── the capture brought everything back (an incomplete one never passes) ──
    man = D.get("manifest")
    if not isinstance(man, dict):
        inc("capture-manifest-missing")
    elif man.get("complete") is not True:
        inc("capture-incomplete")
        facts["capture_failed_items"] = sorted(k for k, v in (man.get("items") or {}).items() if v != "ok")
        facts["capture_missing_files"] = sorted(k for k, v in (man.get("files") or {}).items() if not v)

    # ── the measured CLI is the approved version at every point it was checked ──
    # Not a statement about the hypothesis, so a deviation is INCONCLUSIVE, never PASS.
    seen = {"preflight": (D.get("preflight") or {}).get("cli_version"),
            "before": (D.get("cli_before") or {}).get("version"),
            "after": (D.get("cli_after") or {}).get("version")}
    facts["cli_version_ok"] = {k: v == WANT_CLI for k, v in seen.items()}
    for k, v in seen.items():
        if not isinstance(v, str) or not v:
            inc(f"cli-version-unverified:{k}")
        elif v != WANT_CLI:
            inc(f"cli-version-mismatch:{k}")

    # ── the mod ran, once, completely ──
    mod = D["mod"]
    starts = [r for r in mod if r.get("kind") == "session.start"]
    facts["mod_records"] = len(mod)
    if D["debug"] is not None:
        facts["debug_mod_lines"] = D["debug"]["mod_lines"]
        facts["debug_mod_bad_lines"] = D["debug"]["mod_bad_lines"]
    if not starts:
        inc("mod-not-loaded")
        return done()
    insts = {r.get("inst") for r in mod}
    seqs = sorted(r.get("seq") for r in mod if isinstance(r.get("seq"), int))
    facts["mod_instances"] = len(insts)
    if len(insts) != 1 or seqs != list(range(1, len(mod) + 1)) or D["mod_bad"]:
        inc("mod-records-incomplete")
    if not any(r.get("kind") == "done" for r in mod):
        inc("mod-not-done")
    if D["debug"] and D["debug"]["mod_bad_lines"]:
        inc("debug-log-mod-problem")

    calls = {}
    for r in mod:
        if r.get("kind") == "call":
            if r.get("label") in calls:
                inc(f"duplicate-call:{r.get('label')}")
            calls[r.get("label")] = r
    missing = [l for l in MOD_CALLS if l not in calls]
    if missing:
        inc("mod-calls-missing")

    # ── the one CLI process the server records are compared against ──
    ci = D["cliinfo"]
    clis = (ci or {}).get("cli") or []
    facts["cli_processes"] = len(clis)
    facts["mods_flag_cached"] = (ci or {}).get("mods_flag_cached")
    if len(clis) != 1:
        inc("cli-process-ambiguous")
        return done()
    cli = clis[0]
    P = cli.get("pid")

    errs = {l: calls[l].get("error") for l in calls if calls[l].get("ok") is not True}
    facts["call_errors"] = {l: e for l, e in errs.items() if e}
    for l, e in errs.items():
        if e in INCONCLUSIVE_ERRORS:
            inc(f"plugin-network-policy:{l}")
        elif e in ("no-unix-transport", "socketpath-refused"):
            fail(f"socketpath-refused:{l}")
        else:
            fail(f"call-not-delivered:{l}")

    if D["c"] is None or D["h"] is None:
        inc("server-log-missing")
        return done()
    if D["server_bad"]:
        inc("server-log-unreadable")
    by_scope = {"c": D["c"], "h": D["h"]}

    def server_rec(scope, conn, nonce):
        hits = [r for r in by_scope[scope] if conn is not None and r.get("conn") == conn]
        if len(hits) != 1 or hits[0].get("nonce") != nonce:
            return None
        return hits[0]

    alias = {P: "CLI"}

    def name(pid):
        if pid not in alias:
            alias[pid] = f"OTHER-{sum(1 for v in alias.values() if v.startswith('OTHER')) + 1}"
        return alias[pid]

    pidfd_unsupported = False
    peer_inos = {}
    per_call = {}
    for l in MOD_CALLS:
        r = calls.get(l)
        if not r or r.get("ok") is not True:
            continue
        if r.get("status") != 200:
            fail(f"status:{l}")
        s = server_rec(r.get("target"), r.get("conn"), r.get("nonce"))
        if s is None:
            fail(f"connection-not-matched:{l}")
            continue
        pr = s.get("proc") or {}
        cred = s.get("cred") or {}
        pf = s.get("pidfd") or {}
        if not pf.get("ok"):
            pidfd_unsupported = True
        if s.get("peer_ino") is not None:
            peer_inos[l] = s["peer_ino"]
        if r["target"] == "c":
            seen = cred.get("pid")
            row = {
                "peer": name(seen),
                "uid_1000": cred.get("uid") == 1000,
                "tgid_is_pid": pr.get("tgid") == seen,
                "starttime_is_cli": pr.get("starttime") == cli.get("starttime"),
                "exe_is_cli": pr.get("exe_sha256") is not None and pr.get("exe_sha256") == cli.get("exe_sha256"),
                "pidfd_same": pf.get("ok") is True and pf.get("pid") == seen,
                "stable": pr.get("stable") is True,
            }
            ok = seen == P and all(v for k, v in row.items() if k not in ("peer", "pidfd_same")) and (row["pidfd_same"] or not pf.get("ok"))
        else:
            ns = pr.get("nspid") or []
            seen = ns[-1] if len(ns) >= 2 else None
            row = {
                "peer": name(seen) if seen is not None else "unmapped",
                "nspid_levels": len(ns),
                "cgroup_is_container": pr.get("cgroup_match") is True,
                "tgid_is_pid": pr.get("tgid") == cred.get("pid"),
                "pidfd_same": pf.get("ok") is True and pf.get("pid") == cred.get("pid"),
                "pidfd_nspid_same": pf.get("ok") is True and (pf.get("nspid") or [None])[-1] == seen,
                "stable": pr.get("stable") is True,
                "uid_1000": cred.get("uid") == 1000,
            }
            ok = seen == P and row["cgroup_is_container"] and row["tgid_is_pid"] and row["stable"] and row["uid_1000"] \
                and ((row["pidfd_same"] and row["pidfd_nspid_same"]) or not pf.get("ok"))
        per_call[l] = row
        if not ok:
            fail(f"peer-not-cli:{l}")
    facts["calls"] = per_call
    if pidfd_unsupported:
        inc("pidfd-unavailable")
    if "h1" in peer_inos and "h2" in peer_inos:
        facts["h2_reused_h1_connection"] = peer_inos["h1"] == peer_inos["h2"]  # informative only

    # ── baseline: the server tells another process apart ──
    for key, scope in (("base_c", "c"), ("base_h", "h")):
        b = D[key]
        if not b or b.get("status") != 200:
            inc(f"baseline-missing:{scope}")
            continue
        s = server_rec(scope, b.get("conn"), b.get("nonce"))
        if s is None:
            fail(f"baseline-not-matched:{scope}")
            continue
        alias.setdefault(b.get("self_pid"), f"BASE-{scope.upper()}")
        seen = (s.get("cred") or {}).get("pid") if scope == "c" else ((s.get("proc") or {}).get("nspid") or [None])[-1]
        good = seen == b.get("self_pid") and seen != P
        facts[f"baseline_{scope}_seen_as_itself"] = good
        if not good:
            fail(f"baseline-misattributed:{scope}")

    # ── positive control: fdcheck detects an inherited socket ──
    ctl = (D["control"] or {}).get("child") or {}
    control_ok = ctl.get("waited") is True and ctl.get("peer_known") is True and ctl.get("peer_in_self") is True
    facts["control_detects_inheritance"] = control_ok
    if not control_ok:
        inc("control-failed")

    # ── the held connections: descriptor state and what a forked+exec'd child holds ──
    for l in ("hold-c", "hold-h"):
        r = calls.get(l)
        if not r or r.get("ok") is not True:
            continue
        ch = r.get("child") or {}
        row = {}
        if not (r.get("waitheld") or {}).get("waited") or ch.get("waited") is not True or ch.get("held_conn") != r.get("conn"):
            inc(f"checker-not-synchronized:{l}")
            facts[f"{l}_fd"] = row
            continue
        if ch.get("peer_known") is not True:
            inc(f"peer-inode-unknown:{l}")
            facts[f"{l}_fd"] = row
            continue
        holders = ch.get("holders") or []
        row["child_ppid_is_cli"] = ch.get("self_ppid") == P  # informative: spawn path
        row["holders"] = sorted({name(h.get("pid")) for h in holders})
        row["fd_cloexec"] = [h.get("cloexec") for h in holders]
        row["inherited_by_child"] = ch.get("peer_in_self")
        row["scan_denied"] = ch.get("scan_denied")
        facts[f"{l}_fd"] = row
        if any(h.get("pid") != P for h in holders):
            fail(f"connection-held-by-other:{l}")
        if not holders:
            inc(f"holder-not-found:{l}")
        elif len(holders) != 1:
            fail(f"connection-in-several-fds:{l}")
        elif holders[0].get("cloexec") is not True:
            fail(f"fd-not-cloexec:{l}")
        if ch.get("peer_in_self") is True:
            fail(f"inherited-by-child:{l}")
        elif ch.get("peer_in_self") is not False:
            inc(f"inheritance-unknown:{l}")
        if ch.get("scan_denied"):
            inc(f"holder-scan-denied:{l}")

    # ── the socket directory cannot be changed from the container ──
    ro = D["rocheck"]
    if not isinstance(ro, dict) or set(ro) != {"create", "mkdir", "rename", "unlink"}:
        inc("rocheck-missing")
    else:
        facts["rocheck"] = {k: ro[k] for k in ("create", "mkdir", "rename", "unlink")}
        if any(v == "succeeded" for v in ro.values()):
            fail("socket-dir-writable")
        elif any(v != "EROFS" for v in ro.values()):
            inc("rocheck-unexpected-errno")

    if D["preflight"]:
        facts["preflight"] = {k: D["preflight"].get(k) for k in ("cli_version", "kernel", "ptrace_scope", "image_id_prefix")}
    return done()


def main(argv):
    if len(argv) != 3 or argv[1] != "report":
        print(__doc__.strip(), file=sys.stderr)
        return 64
    res = analyze(load(argv[2]))
    print(json.dumps(res, indent=2, ensure_ascii=False))
    return 0 if res["verdict"] == "PASS" else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))

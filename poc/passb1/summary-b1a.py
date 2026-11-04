#!/usr/bin/env python3
"""PASS-B1a combined summary across run 1 (kit e00ef29) and run 2 (focused kit). Read-only.

    summary-b1a.py --run1 RES1 --run1-sha SHA1 [--run2 RES2 --run2-sha SHA2]

Each contributing run must be VALID — its SHA256SUMS verifies and A.analyze reports no GLOBAL
failure (manifest, CLI version, applied config, baseline, guard). A run is never allowed to
contribute while invalid, and a reduced-scope PASS is never declared from an invalid run. Run 2 is
authoritative for the cases it re-ran (N14, N17-project); run 1 for the rest. Run 1 recorded the
MCP attempt under the legacy id "N17"; a limited adapter extracts ONLY its N17-user evidence.
"""
import argparse
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze_b1a as A  # noqa: E402

RUN2_OWNS = {"N14", "N17-project"}
RUN1_OWNS = tuple(x for x in A.EXIT + A.START if x not in RUN2_OWNS)  # incl. N17-user (via legacy)


def verify_sums(res):
    """SHA256SUMS present and every listed file matches (fail-closed like cleanup)."""
    sp = os.path.join(res, "SHA256SUMS")
    if not os.path.isfile(sp):
        return False
    try:
        with open(sp, encoding="utf-8") as fh:
            sums = fh.read().splitlines()
        for line in sums:
            if not line:
                continue
            want, _, rel = line.partition("  ")
            h = hashlib.sha256()
            with open(os.path.join(res, rel), "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
            if h.hexdigest() != want:
                return False
    except OSError:
        return False
    return True


def global_reasons(result):
    """Reasons that are NOT per-attempt (manifest/cli/applied/baseline/guard/settings/...)."""
    return [x for x in result["reasons"] if not x.startswith(("not-shown-blocked:", "loaded:"))]


def legacy_n17_user(res):
    """Run 1 saved the MCP attempt as 'N17' (not split). Extract ONLY its N17-user evidence: the
    `claude mcp add` refusal. Returns a row dict or None if the legacy attempt is absent."""
    d = os.path.join(res, "attempts", "N17")
    if not os.path.isdir(d):
        return None
    try:
        res_json = json.load(open(os.path.join(d, "result.json"), encoding="utf-8"))
    except (OSError, ValueError):
        return {"outcome": "inconclusive", "why": "legacy-n17-unreadable"}
    add_out = ""
    f = os.path.join(d, "pre-mcp-add.txt.filtered")
    if os.path.isfile(f):
        with open(f, encoding="utf-8", errors="replace") as fh:
            add_out = fh.read()
    rc = {e.get("alias"): e.get("rc") for e in (res_json.get("pre") or []) if isinstance(e, dict)}
    add_rc = rc.get("mcp-add")
    if "mcp-user" in (res_json.get("markers") or []):
        return {"outcome": "loaded", "why": "mcp-user-started"}
    if A.MCP_USER_REFUSED.search(add_out) and add_rc not in (0, None):
        return {"outcome": "blocked", "why": "mcp-user-refused"}
    if add_rc not in (0, None):
        return {"outcome": "inconclusive", "why": "mcp-add-error"}
    return {"outcome": "inconclusive", "why": "mcp-add-outcome-unknown"}


def validate_run(res, scope):
    if not res or not os.path.isdir(res):
        return None, "missing", {}
    sums_ok = verify_sums(res)
    result = A.analyze(A.load(res), scope=scope)
    gr = global_reasons(result)
    status = "valid" if (sums_ok and not gr) else "invalid"
    return result, status, {"sha256sums": sums_ok, "global_reasons": gr}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--run1", required=True)
    ap.add_argument("--run1-sha", required=True)
    ap.add_argument("--run2")
    ap.add_argument("--run2-sha")
    a = ap.parse_args(argv)

    r1, s1, v1 = validate_run(a.run1, scope=None)
    r2, s2, v2 = validate_run(a.run2, scope=RUN2_OWNS) if a.run2 else (None, "absent", {})
    att1 = r1["facts"]["attempts"] if r1 else {}
    att2 = r2["facts"]["attempts"] if r2 else {}

    rows, counts = [], {"blocked": 0, "loaded": 0, "inconclusive": 0}
    for aid in A.EXIT + A.START:
        owner2 = aid in RUN2_OWNS
        if owner2:
            row = att2.get(aid)
            prov = f"run2:{a.run2_sha}"
            if r2 is None:
                row = {"outcome": "inconclusive", "why": "run2-absent"}
            elif s2 == "invalid":
                row = {"outcome": "inconclusive", "why": "run2-invalid"}
            elif row is None:
                row = {"outcome": "inconclusive", "why": "not-present"}
        elif aid == "N17-user":
            row = (legacy_n17_user(a.run1) or att1.get(aid) or {"outcome": "inconclusive", "why": "n17-user-absent"})
            prov = f"run1:{a.run1_sha}(legacy-N17)"
        else:
            row = att1.get(aid) or {"outcome": "inconclusive", "why": "not-present"}
            prov = f"run1:{a.run1_sha}"
        if s1 == "invalid" and not owner2 and aid != "N17-user":
            row = {"outcome": "inconclusive", "why": "run1-invalid"}
        counts[row["outcome"]] = counts.get(row["outcome"], 0) + 1
        rows.append({"attempt": aid, **row, "provenance": prov})

    excluded = {aid: {"status": "excluded-from-scope", "reason": A.EXCLUDED[aid]} for aid in A.EXCLUDED}
    runs_valid = s1 == "valid" and s2 == "valid"
    if counts["loaded"]:
        verdict = "FAIL"
    elif not runs_valid or counts["inconclusive"]:
        verdict = "INCONCLUSIVE"
    else:
        verdict = "PASS (reduced scope)"
    out = {
        "verdict": verdict,
        "runs": {"run1": {"sha": a.run1_sha, "status": s1, **v1},
                 "run2": {"sha": a.run2_sha, "status": s2, **v2}},
        "counts": counts,
        "attempts": rows,
        "excluded": excluded,
        "caveat": ("Alcance reducido: N10/N11/N13 excluidos (no son caminos de carga para un marketplace de "
                   "directorio). Un PASS de alcance reducido NO es la seguridad general de Channels: no cubre lo "
                   "pendiente (N15, @synced, eventos con login), el lanzamiento (09-launch-trust.md), H-ND (B1b) "
                   "ni los ataques al gateway (B2). Ninguna corrida modifica la evidencia de la otra."),
    }
    print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0 if verdict.startswith("PASS") else 2


if __name__ == "__main__":
    sys.exit(main())

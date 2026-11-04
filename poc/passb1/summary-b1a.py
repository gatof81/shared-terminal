#!/usr/bin/env python3
"""PASS-B1a combined summary across run 1 (kit e00ef29) and run 2 (focused kit). Read-only:
reads the two results dirs, re-classifies each with analyze_b1a, and prints one row per logical
attempt citing its PROVENANCE (which run and kit SHA the finding comes from). N10/N11/N13 are
EXCLUDED from scope, never blocked. A reduced-scope PASS is not Channels general security.

    summary-b1a.py --run1 RES1 --run1-sha SHA1 [--run2 RES2 --run2-sha SHA2]

Run 2 is authoritative for the cases it re-ran (N14, N17-project); run 1 for the rest.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze_b1a as A  # noqa: E402

RUN2_OWNS = {"N14", "N17-project"}   # the focused re-run; run 1 owns everything else


def classify_dir(res):
    if not res or not os.path.isdir(res):
        return {}, None
    r = A.analyze(A.load(res))
    return r["facts"].get("attempts", {}), r


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--run1", required=True)
    ap.add_argument("--run1-sha", required=True)
    ap.add_argument("--run2")
    ap.add_argument("--run2-sha")
    a = ap.parse_args(argv)
    r1, full1 = classify_dir(a.run1)
    r2, full2 = classify_dir(a.run2)

    rows, counts = [], {"blocked": 0, "loaded": 0, "inconclusive": 0}
    for aid in A.EXIT + A.START:
        owner2 = aid in RUN2_OWNS and a.run2
        src, sha = (r2, a.run2_sha) if owner2 else (r1, a.run1_sha)
        row = src.get(aid)
        if row is None:
            rows.append({"attempt": aid, "outcome": "inconclusive", "why": "not-present",
                         "provenance": f"run2:{a.run2_sha}" if owner2 else f"run1:{a.run1_sha}"})
            counts["inconclusive"] += 1
            continue
        counts[row["outcome"]] = counts.get(row["outcome"], 0) + 1
        rows.append({"attempt": aid, "outcome": row["outcome"], "why": row["why"],
                     "provenance": f"{'run2' if owner2 else 'run1'}:{sha}"})
    excluded = {aid: {"status": "excluded-from-scope", "reason": A.EXCLUDED[aid], "provenance": f"run1:{a.run1_sha}"}
                for aid in A.EXCLUDED}
    verdict = "FAIL" if counts["loaded"] else "INCONCLUSIVE" if counts["inconclusive"] else "PASS (reduced scope)"
    out = {
        "verdict": verdict,
        "counts": counts,
        "attempts": rows,
        "excluded": excluded,
        "provenance": {"run1": a.run1_sha, "run2": a.run2_sha},
        "caveat": ("Alcance reducido: N10/N11/N13 excluidos (no son caminos de carga para un marketplace de "
                   "directorio). Un PASS de alcance reducido NO es la seguridad general de Channels: no cubre lo "
                   "pendiente (N15, @synced, eventos con login), el lanzamiento (09-launch-trust.md), H-ND (B1b) "
                   "ni los ataques al gateway (B2)."),
    }
    print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0 if verdict.startswith("PASS") else 2


if __name__ == "__main__":
    sys.exit(main())

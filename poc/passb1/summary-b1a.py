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
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze_b1a as A  # noqa: E402

RUN2_OWNS = {"N14", "N17-project"}
RUN1_OWNS = tuple(x for x in A.EXIT + A.START if x not in RUN2_OWNS)  # incl. N17-user (via legacy)

# The capture files whose presence AND coverage a valid run must have. report.json / removal.json /
# cleanup.json are written AFTER capture computes SHA256SUMS, so they are the ONLY files allowed on
# disk without a sums entry; every other present file must be covered (owner C1).
MANDATORY_CAPTURE = ("capture-manifest.json", "cli-version-before.json", "cli-version-after.json",
                     "applied.json", os.path.join("attempts", "P0", "result.json"))
SUMS_POST_CAPTURE = {"report.json", "removal.json", "cleanup.json"}


def verify_sums(res):
    """Fail-closed integrity + COVERAGE of SHA256SUMS (owner C1). Rejects: no file; an empty or
    all-blank list; a malformed line, a bad hex digest, a duplicate entry or a path that escapes
    the capture (absolute or containing '..'); any listed file whose hash does not match; a file
    physically present but not covered (except the post-capture artifacts); and a missing mandatory
    capture file. An incomplete or partial list can therefore never validate."""
    sp = os.path.join(res, "SHA256SUMS")
    if not os.path.isfile(sp):
        return False
    try:
        with open(sp, encoding="utf-8") as fh:
            raw = fh.read().splitlines()
    except OSError:
        return False
    listed = {}
    for line in raw:
        if not line.strip():
            continue
        want, sep, rel = line.partition("  ")
        if sep != "  " or not rel or not re.fullmatch(r"[0-9a-f]{64}", want):
            return False
        if rel.startswith("./"):
            rel = rel[2:]
        parts = rel.split("/")
        if not rel or rel.startswith("/") or "" in parts or ".." in parts or rel == "SHA256SUMS":
            return False
        if rel in listed:                       # a duplicated entry
            return False
        listed[rel] = want
    if not listed:                              # empty / blank-only list
        return False
    # A lexical path check is not enough: a symlink INSIDE the capture (as the file itself, or as a
    # parent component) could redirect a read OUTSIDE it. Refuse a symlinked entry and require every
    # resolved path to stay within the capture dir (owner D5).
    base = os.path.realpath(res)
    try:
        for rel, want in listed.items():
            full = os.path.join(res, rel)
            real = os.path.realpath(full)
            if os.path.islink(full) or not (real == base or real.startswith(base + os.sep)):
                return False
            h = hashlib.sha256()
            with open(full, "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
            if h.hexdigest() != want:
                return False
    except OSError:                             # a listed file that is absent / unreadable
        return False
    on_disk = set()
    for p, _, fs in os.walk(res):
        for f in fs:
            rel = os.path.relpath(os.path.join(p, f), res)
            if rel != "SHA256SUMS" and rel not in SUMS_POST_CAPTURE:
                on_disk.add(rel)
    if on_disk - set(listed):                   # a present file the sums do not cover
        return False
    if any(m not in listed for m in MANDATORY_CAPTURE):   # a mandatory capture file omitted
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


def attempt_markers(res, aid):
    """The attacker-code markers an attempt's own result.json recorded, or [] if none / unreadable.
    A non-empty list is proof the attack EXECUTED, independent of whether the id is in PASS scope."""
    if not res:
        return []
    try:
        with open(os.path.join(res, "attempts", aid, "result.json"), encoding="utf-8") as fh:
            return json.load(fh).get("markers") or []
    except (OSError, ValueError):
        return []


def legacy_n17_started(res):
    """run 1 stored the MCP attempt as 'N17' (not split). A STARTED server there — user or project
    side — is a breach that run 2 cannot erase (owner C2). Returns the started marker, or None."""
    if not os.path.isdir(os.path.join(res, "attempts", "N17")):
        return None
    markers = attempt_markers(res, "N17")
    return next((m for m in ("mcp-user", "mcp-project") if m in markers), None)


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
    # A demonstrated `loaded` in a VALID run is a breach (owner C2). It is read from BOTH runs,
    # including run 1's legacy "N17" dir, and attributing it to its own run: a later run that shows
    # the same attempt blocked can never erase it. It is gated on the run being valid so a tampered
    # or incomplete run cannot FABRICATE an attack claim (invalid runs stay INCONCLUSIVE).
    legacy_started = legacy_n17_started(a.run1) if s1 == "valid" else None

    def loaded_in(att, status, aid):
        return status == "valid" and (att.get(aid) or {}).get("outcome") == "loaded"

    rows, counts = [], {"blocked": 0, "loaded": 0, "inconclusive": 0}
    for aid in A.EXIT + A.START:
        owner2 = aid in RUN2_OWNS
        l1 = loaded_in(att1, s1, aid) or (aid in ("N17-user", "N17-project") and legacy_started is not None)
        l2 = loaded_in(att2, s2, aid)
        if l1:
            why = (att1.get(aid) or {}).get("why") or f"started:{legacy_started}"
            row = {"outcome": "loaded", "why": why, "note": "loaded-in-run1-not-erasable-by-run2"}
            prov = f"run1:{a.run1_sha}" + ("(legacy-N17)" if aid in ("N17-user", "N17-project") and aid not in att1 else "")
        elif l2:
            row = {**att2[aid], "note": "loaded-in-run2"}
            prov = f"run2:{a.run2_sha}"
        elif owner2:
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
            if s1 == "invalid":
                row = {"outcome": "inconclusive", "why": "run1-invalid"}
        else:
            row = att1.get(aid) or {"outcome": "inconclusive", "why": "not-present"}
            prov = f"run1:{a.run1_sha}"
            if s1 == "invalid":
                row = {"outcome": "inconclusive", "why": "run1-invalid"}
        counts[row["outcome"]] = counts.get(row["outcome"], 0) + 1
        rows.append({"attempt": aid, **row, "provenance": prov})

    # Retired attacks (N10/N11/N13) are out of the PASS CRITERIA, but a demonstrated EXECUTION of
    # one in the original evidence of a VALID run is still a breach: report FAIL with provenance,
    # and never re-count it as blocked (owner D2).
    excluded, excluded_executed = {}, []
    for aid in A.EXCLUDED:
        ex = {"status": "excluded-from-scope", "reason": A.EXCLUDED[aid]}
        m = (attempt_markers(a.run1, aid) if s1 == "valid" else []) or (attempt_markers(a.run2, aid) if s2 == "valid" else [])
        if m:
            prov = f"run1:{a.run1_sha}" if (s1 == "valid" and attempt_markers(a.run1, aid)) else f"run2:{a.run2_sha}"
            ex["observed_execution"] = {"markers": sorted(m), "provenance": prov}
            excluded_executed.append(aid)
        excluded[aid] = ex

    runs_valid = s1 == "valid" and s2 == "valid"
    if counts["loaded"] or excluded_executed:
        verdict = "FAIL"
    elif not runs_valid or counts["inconclusive"]:
        verdict = "INCONCLUSIVE"
    else:
        verdict = "PASS (reduced scope)"
    out = {
        "verdict": verdict,
        # The per-run SHA is an operator-DECLARED label, not a cryptographic identity of the kit.
        # What IS verified per run: SHA256SUMS (evidence integrity) and that applied.*_sha256 equals
        # the local kit's managed/marketplace trees (analyze_b1a); the bind to the kit COMMIT is the
        # tarball-by-hashes check done outside this summary.
        "runs": {"run1": {"sha": a.run1_sha, "sha_source": "operator-declared", "status": s1, **v1},
                 "run2": {"sha": a.run2_sha, "sha_source": "operator-declared", "status": s2, **v2}},
        "counts": counts,
        "attempts": rows,
        "excluded": excluded,
        "provenance_note": ("Los SHA de cada corrida son ETIQUETAS declaradas por el operador, no una identidad "
                            "criptográfica del kit. Por corrida se verifica SHA256SUMS (integridad de la evidencia) y "
                            "que applied.{managed,market}_sha256 == el árbol managed/marketplace del kit local; el "
                            "vínculo con el commit del kit es la verificación del tarball por hashes, fuera de este resumen."),
        "caveat": ("Alcance reducido: N10/N11/N13 excluidos (no son caminos de carga para un marketplace de "
                   "directorio). Un PASS de alcance reducido NO es la seguridad general de Channels: no cubre lo "
                   "pendiente (N15, @synced, eventos con login), el lanzamiento (09-launch-trust.md), H-ND (B1b) "
                   "ni los ataques al gateway (B2). Ninguna corrida modifica la evidencia de la otra."),
    }
    print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0 if verdict.startswith("PASS") else 2


if __name__ == "__main__":
    sys.exit(main())

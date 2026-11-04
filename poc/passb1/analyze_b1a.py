#!/usr/bin/env python3
"""PASS-B1a analyzer (04-poc.md §1.14.15). Standard library only.

    analyze_b1a.py report RESULTS_DIR      verdict as JSON; exit 0 only on PASS

An attempt counts as BLOCKED only with all three, in that same CLI start:
  1. no marker of the attacker's code (a marker is a FAIL, whatever else is there);
  2. the control: the managed probe ran in the organization tier (start attempts), or the
     CLI refused to start with the sideload message (exit attempts);
  3. decisive evidence that the CLI met the attack: it read, looked up or refused the
     attacker's plugin, marketplace, hook or server, as the debug log or the command's
     own output says (the patterns below are the 2.1.314 texts, §1.14.14).
Anything less is INCONCLUSIVE for that attempt. An attempt that did not run, or a path the
kit cannot exercise without login, is listed as pending and never counts as blocked.
"""
import hashlib
import json
import os
import re
import sys

KIT = os.path.dirname(os.path.abspath(__file__))

SCOPE = ("B1a: integridad de la instalación administrada de 2.1.314 frente a los caminos de carga N1–N19 "
         "ejercidos sin login; no evalúa el lanzamiento (09-launch-trust.md), H-ND (B1b) ni ataques al gateway (B2)")
WANT_CLI = "2.1.314"
PROBE = "st-b1-probe"
MARKET_PATH = "/opt/st-b1/marketplace/"
ORG_TIERS = {"prepend", "append"}       # managed seats (§1.14.14.2); "user" is a FAIL
KNOWN_TIERS = ORG_TIERS | {"user", "builtin", "core"}
EXIT = ("N1", "N2", "N3", "N4", "N5a", "N5b")
START = ("N6", "N7a", "N7b", "N8", "N9", "N10", "N11", "N12", "N13", "N14", "N16", "N17", "N19")
PENDING = {"N15": "dev mods: los entrega una skill y se preguntan al terminar un turno (requiere modelo y login)",
           "@synced": "plugins sincronizados desde claude.ai (requiere login)",
           "classic.UserPromptSubmit/PreToolUse": "eventos de prompt y herramientas (requieren login)"}

SIDELOAD = re.compile(r"disabled by your organization's managed settings \(disableSideloadFlags\)")
LOADED = re.compile(r"hooks module (\S+?)@(\S+) loaded \((\w+), environment \d+, tier (\w+)\)")
REGISTER = re.compile(r"plugin\.register: (\S+) \((\w+), (\S+)\), judged by")
READ_HOOKS = re.compile(r"Read hooks\.json for plugin (\S+) \(enabled=\w+\): (\S+)")
NOT_ORG = re.compile(r"(\S+) is enabled by managed settings, but .* not treated as the organization's")
GUARD_SEATED = re.compile(r"(?:cc-plugin-sec-default@builtin )?seated (?:outermost: this machine has managed settings|by managed prependPlugins)")
GUARD_NOT_SEATED = re.compile(r"cc-plugin-sec-default@builtin not seated")
GUARD_LOADED = re.compile(r"hooks module cc-plugin-sec-default@builtin loaded \(")
SETTINGS_INVALID = re.compile(r"(?i)was present but invalid|settings validation (?:error|failed)|Invalid .* in policy settings|could not be parsed")
# Decisive evidence that the CLI met each attack (one of the patterns, in debug or command output).
MET = {
    "N6": [r"st-b1-rogue-(?:n6|mk6)\b"], "N7a": [r"st-b1-rogue-(?:n7a|mk7a)\b"], "N7b": [r"st-b1-rogue-(?:n7b|mk7b)\b"],
    "N8": [r"st-b1-rogue-(?:n8|mk8)\b"], "N9": [r"st-b1-rogue-(?:n9|mk9)\b"], "N12": [r"st-b1-rogue-(?:n12|mk12)\b", r"from seed dir"],
    "N14": [r"st-b1-rogue-n14\b", r"skills-dir"],
    # No 2.1.314 line says a hook was skipped by policy. What proves the attack was met: the
    # CLI loaded the three settings files that carry the hooks, and the folder was trusted
    # (hooks never run before trust). A hook that ran logs "Hooks: SessionStart:…" and marks.
    "N16": [(r"Watching for changes in setting files \S*/home/\.claude/settings\.json, \S*/ws/\.claude/settings\.json, \S*/ws/\.claude/settings\.local\.json",
             r"post-trust")],
    # The running CLI names each MCP server it considers; `claude mcp add` output only says the
    # entry was written, so it does not count.
    "N17": [r'MCP server "st-b1-rogue-n17[pu]"'], "N19": [r"st-b1-rogue-(?:n19|mk19)\b", r"hook-n19\b"],
}
DEBUG_ONLY = {"N16", "N17"}
IMPOSTOR = ("N10", "N11", "N13")


def _json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _text(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def load(d):
    att = {}
    adir = os.path.join(d, "attempts")
    for aid in os.listdir(adir) if os.path.isdir(adir) else []:
        a = os.path.join(adir, aid)
        att[aid] = {
            "result": _json(os.path.join(a, "result.json")),
            "debug": _text(os.path.join(a, "debug.log.filtered")),
            "stderr": _text(os.path.join(a, "stderr.txt.filtered")),
            "pre": "".join(_text(os.path.join(a, f)) for f in sorted(os.listdir(a)) if f.startswith("pre-")),
            "has_debug": os.path.exists(os.path.join(a, "debug.log.filtered")),
        }
    return {"attempts": att, "applied": _json(os.path.join(d, "applied.json")), "manifest": _json(os.path.join(d, "capture-manifest.json")),
            "preflight": _json(os.path.join(d, "preflight.json")), "cli_before": _json(os.path.join(d, "cli-version-before.json")),
            "cli_after": _json(os.path.join(d, "cli-version-after.json"))}


def tree_sha256(root):
    """Same digest as b1.py tree_sha256: what the container saw must be the kit's own files."""
    h = hashlib.sha256()
    rels = sorted(os.path.relpath(os.path.join(p, f), root) for p, _, fs in os.walk(root) for f in fs)
    for rel in rels:
        with open(os.path.join(root, rel), "rb") as f:
            h.update(rel.encode() + b"\0" + hashlib.sha256(f.read()).hexdigest().encode() + b"\n")
    return h.hexdigest()


def probe_state(a):
    """What the managed probe did in this start: loaded where, in which tier, seen events."""
    r = a["result"] or {}
    loads = [m.groups() for m in LOADED.finditer(a["debug"]) if m.group(1) == PROBE]
    regs = [m.groups() for m in REGISTER.finditer(a["debug"]) if m.group(1) == PROBE]
    reads = [m.group(2) for m in READ_HOOKS.finditer(a["debug"]) if m.group(1) == PROBE]
    kinds = sorted({p.get("kind") for p in r.get("probe") or [] if isinstance(p, dict)} - {None})
    tiers = sorted({t for _, _, _, t in loads} | {t for _, t, _ in regs})
    return {"loaded": bool(loads), "tiers": tiers, "kinds": kinds, "reads_in_place_only": bool(reads) and all(p.startswith(MARKET_PATH) for p in reads),
            "read_elsewhere": any(not p.startswith(MARKET_PATH) for p in reads),
            "not_org_warning": any(m.group(1).startswith(PROBE) for m in NOT_ORG.finditer(a["debug"]))}


def org_ok(ps):
    return ps["loaded"] and ps["tiers"] and set(ps["tiers"]) <= ORG_TIERS and not ps["not_org_warning"] and "session.start" in ps["kinds"]


def classify(aid, a):
    """blocked | loaded | inconclusive, with the reason."""
    r = a["result"]
    if r is None:
        return "inconclusive", "no-result"
    if r.get("markers"):
        return "loaded", "marker:" + ",".join(sorted(r["markers"]))
    ps = probe_state(a)
    if aid in EXIT:
        if r.get("timed_out") or r.get("rc") in (None, 0):
            return "inconclusive", "did-not-refuse-to-start"
        if "session.start" in ps["kinds"]:
            return "inconclusive", "started-anyway"
        if not (SIDELOAD.search(a["stderr"]) or SIDELOAD.search(a["debug"])):
            return "inconclusive", "no-sideload-refusal-text"
        return "blocked", "sideload-refused"
    if not org_ok(ps):
        return "inconclusive", "no-control:probe-not-in-org-tier"
    if aid in IMPOSTOR:
        if ps["read_elsewhere"]:
            return "blocked", "impostor-read-not-run"
        if ps["reads_in_place_only"]:
            return "blocked", "in-place-only"
        return "inconclusive", "no-read-evidence"
    text = a["debug"] if aid in DEBUG_ONLY else a["debug"] + a["stderr"] + a["pre"]
    # Each entry is a pattern, or a tuple of patterns that must all match.
    if not any(all(re.search(q, text) for q in (p if isinstance(p, tuple) else (p,))) for p in MET.get(aid, [])):
        return "inconclusive", "attack-not-met"
    if aid == "N16" and re.search(r"Hooks: SessionStart:", text):
        return "loaded", "hook-ran"
    return "blocked", "met-not-run"


def analyze(D):
    fails, incs, facts = [], [], {}

    def done():
        verdict = "FAIL" if fails else "INCONCLUSIVE" if incs else "PASS"
        return {"scope": SCOPE, "verdict": verdict, "reasons": fails + incs, "facts": facts, "pending": PENDING,
                "note": "PASS no cubre lo pendiente ni el lanzamiento: la integridad final depende de la raíz de confianza (09-launch-trust.md)"}

    man = D.get("manifest")
    if not isinstance(man, dict):
        incs.append("capture-manifest-missing")
    elif man.get("complete") is not True:
        incs.append("capture-incomplete")

    seen = {"preflight": (D.get("preflight") or {}).get("cli_version"), "before": (D.get("cli_before") or {}).get("version"),
            "after": (D.get("cli_after") or {}).get("version")}
    facts["cli_version_ok"] = {k: v == WANT_CLI for k, v in seen.items()}
    for k, v in seen.items():
        if v != WANT_CLI:
            incs.append(f"cli-version-{'unverified' if not v else 'mismatch'}:{k}")

    ap = D.get("applied")
    if not isinstance(ap, dict):
        incs.append("applied-config-missing")
    else:
        denied = {k: ap.get(k) for k in ("managed_create", "managed_rename", "managed_unlink", "market_create", "market_rename", "market_unlink")}
        facts["applied"] = {"managed_files": ap.get("managed_files"), "writes_denied": {k: v not in (None, "ok") for k, v in denied.items()}}
        if any(v == "ok" for v in denied.values()):
            fails.append("policy-or-marketplace-writable")
        elif any(v is None for v in denied.values()):
            incs.append("applied-config-incomplete")
        if ap.get("managed_files") != ["b1a.json"]:
            incs.append("managed-files-unexpected")
        same = {"managed": ap.get("managed_sha256") == tree_sha256(os.path.join(KIT, "managed")),
                "market": ap.get("market_sha256") == tree_sha256(os.path.join(KIT, "marketplace"))}
        facts["applied"]["same_as_kit"] = same
        if not all(same.values()):
            incs.append("applied-config-not-kit")

    att = D["attempts"]
    p0 = att.get("P0")
    if p0 is None or p0["result"] is None:
        incs.append("baseline-missing")
        facts["attempts"] = {}
        return done()
    if SETTINGS_INVALID.search(p0["debug"]):
        incs.append("settings-invalid")
    ps = probe_state(p0)
    facts["probe"] = {k: ps[k] for k in ("loaded", "tiers", "kinds", "reads_in_place_only", "not_org_warning")}
    if ps["loaded"] and "user" in ps["tiers"]:
        fails.append("probe-user-tier")
    elif ps["tiers"] and not set(ps["tiers"]) <= KNOWN_TIERS:
        incs.append("tier-label-unknown")
    elif not org_ok(ps):
        incs.append("probe-not-org")
    if not ("classic.SessionStart" in ps["kinds"]):
        incs.append("classic-events-missing")
    guard = {"seated": bool(GUARD_SEATED.search(p0["debug"])), "not_seated": bool(GUARD_NOT_SEATED.search(p0["debug"])),
             "loaded": bool(GUARD_LOADED.search(p0["debug"]))}
    facts["guard"] = guard
    if guard["not_seated"]:
        fails.append("guard-not-seated")
    elif not (guard["seated"] and guard["loaded"]):
        incs.append("guard-unverified")

    rows = {}
    for aid in EXIT + START:
        a = att.get(aid)
        if a is None:
            rows[aid] = {"outcome": "inconclusive", "why": "not-run"}
        else:
            o, why = classify(aid, a)
            rows[aid] = {"outcome": o, "why": why}
    facts["attempts"] = rows
    for aid, row in rows.items():
        if row["outcome"] == "loaded":
            fails.append(f"loaded:{aid}")
        elif row["outcome"] == "inconclusive":
            incs.append(f"not-shown-blocked:{aid}")

    n18 = att.get("N18")
    facts["N18_disableAllHooks_in_user_settings"] = None if n18 is None or n18["result"] is None else {
        "probe_still_ran": "session.start" in probe_state(n18)["kinds"], "markers": (n18["result"] or {}).get("markers")}
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

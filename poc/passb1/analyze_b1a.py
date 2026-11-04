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

SCOPE = ("B1a: integridad de la instalacion administrada de 2.1.314 frente a los caminos de carga ejercitables sin login "
         "(N1-N9, N12, N14, N16, N17-user/project, N19); N10/N11/N13 excluidos (ver note). No evalua el lanzamiento "
         "(09-launch-trust.md), H-ND (B1b) ni ataques al gateway (B2). classic.SessionEnd es un hecho, no se exige para PASS")
WANT_CLI = "2.1.314"
PROBE = "st-b1-probe"
MARKET_PATH = "/opt/st-b1/marketplace/"
ORG_TIERS = {"prepend", "append"}       # managed seats (§1.14.14.2); "user" is a FAIL
KNOWN_TIERS = ORG_TIERS | {"user", "builtin", "core"}
EXIT = ("N1", "N2", "N3", "N4", "N5a", "N5b")
START = ("N6", "N7a", "N7b", "N8", "N9", "N12", "N14", "N16", "N17-user", "N17-project", "N19")
# N10/N11/N13 are retired, not blocked: for a directory marketplace 2.1.314 reads the plugin in
# place and never consults the cache/seed, so a same-name copy there is not a load path (shown
# locally, §1.14.18.1). Cache poisoning is meaningful only for remote sources, whose control is
# pluginDigests — a separate future test, not B1a.
EXCLUDED = {"N10": "cache-not-a-load-path-for-directory-marketplace",
            "N11": "cache-not-a-load-path-for-directory-marketplace",
            "N13": "cache-not-a-load-path-for-directory-marketplace"}
PENDING = {"N15": "dev mods: los entrega una skill y se preguntan al terminar un turno (requiere modelo y login)",
           "@synced": "plugins sincronizados desde claude.ai (requiere login)",
           "classic.UserPromptSubmit/PreToolUse": "eventos de prompt y herramientas (requieren login)"}

SIDELOAD = re.compile(r"disabled by your organization's managed settings \(disableSideloadFlags\)")
LOADED = re.compile(r"hooks module (\S+?)@(\S+) loaded \((\w+), environment \d+, tier (\w+)\)")
REGISTER = re.compile(r"plugin\.register: (\S+) \((\w+), (\S+)\), judged by")
ROGUE_LOADED = re.compile(r"hooks module (st-b1-rogue-\S+?)@\S+ loaded \(|plugin\.register: (st-b1-rogue-\S+) \(")
READ_HOOKS = re.compile(r"Read hooks\.json for plugin (\S+) \(enabled=\w+\): (\S+)")
SKIP_ALREADY_LOADED = re.compile(r"Skipping duplicate hooks file for plugin \S+: (\S+) \(resolves to already-loaded")
# A marketplace-add refusal by enterprise policy (none of these contains the word "policy" except
# the first). N9 keys on the ADD command's own output.
MARKET_REFUSED = re.compile(r"is blocked by enterprise policy|is not in the allowed marketplace list|strictKnownMarketplaces\) does not include|marketplace was not added\. Remove it from extraKnownMarketplaces|blocked by your organization's policy|marketplace-blocked-by-policy")
# The real VM100 install failure that correlates plugin <-> rejected marketplace.
INSTALL_NOT_IN_MK = re.compile(r'not found in marketplace "st-b1-rogue-mk9"|st-b1-rogue-n9@st-b1-rogue-mk9 .*not found|not found in any marketplace')
# The managed-settings MCP refusal texts (user path).
MCP_USER_REFUSED = re.compile(r"allow only MCP servers that plugins provide|Cannot add MCP server: your organization|not allowed by your organization")
MCP_SERVER_DENIED = re.compile(r'MCP server "(st-b1-rogue-n17[pu])"[^\n]*(not allowed by your organization|denied|blocked by)')
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
    "N19": [r"st-b1-rogue-(?:n19|mk19)\b", r"hook-n19\b"],
}
DEBUG_ONLY = {"N16"}


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
        res = _json(os.path.join(a, "result.json")) or {}
        starts = res.get("starts") or []
        n = len(starts)
        # The attack is in effect in the LAST start. Use that start's own debug, stderr and probe
        # events — STRICTLY, with no fallback to an earlier start or to a concatenation, so start
        # 1's control can never stand in for start 2 (owner finding #2). If the last start left no
        # file, its evidence is simply absent and the attempt is INCONCLUSIVE.
        if n:
            last_debug = _text(os.path.join(a, f"debug-{n}.log.filtered"))
            last_stderr = _text(os.path.join(a, f"stderr-{n}.txt.filtered"))
            last_kinds = starts[-1].get("probe_kinds") if isinstance(starts[-1], dict) else None
        else:  # a result without per-start info (e.g. a hand-made fixture): the combined files
            last_debug = _text(os.path.join(a, "debug.log.filtered"))
            last_stderr = _text(os.path.join(a, "stderr.txt.filtered"))
            last_kinds = None
        # Per-command pre output, kept apart so one command's text is not read as another's.
        pre_text = {f[len("pre-"):-len(".txt.filtered")]: _text(os.path.join(a, f))
                    for f in sorted(os.listdir(a)) if f.startswith("pre-") and f.endswith(".txt.filtered")}
        att[aid] = {
            "result": res or None,
            "debug": last_debug,
            "probe_kinds": last_kinds,
            "stderr": last_stderr,
            "pre": "".join(pre_text.values()),
            "pre_text": pre_text,
            "starts": n,
            "has_debug": bool(last_debug),
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
    skipped = {m.group(1) for m in SKIP_ALREADY_LOADED.finditer(a["debug"])}
    if a.get("probe_kinds") is not None:
        kinds = sorted(set(a["probe_kinds"]))
    else:
        kinds = sorted({p.get("kind") for p in r.get("probe") or [] if isinstance(p, dict)} - {None})
    tiers = sorted({t for _, _, _, t in loads} | {t for _, t, _ in regs})
    return {"loaded": bool(loads), "tiers": tiers, "kinds": kinds, "read_paths": reads, "skipped_paths": sorted(skipped),
            "in_place_read": any(p.startswith(MARKET_PATH) for p in reads),
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
    # N9 is judged on the INSTALL outcome, not on whether the plugin ran. `plugin marketplace
    # add` / `plugin install` must be REFUSED by policy; a successful install is a breach even
    # if the plugin never executed this session.
    if aid == "N9":
        # Judge the TWO commands by their own output and rc, correlating plugin<->marketplace.
        # Blocked only when `marketplace add` is refused by policy AND `plugin install` fails
        # because the plugin is not in THAT rejected marketplace (the real VM100 message). An add
        # refusal plus an UNRELATED install failure is not blocked; a successful install is FAIL.
        rc = {e.get("alias"): e.get("rc") for e in (r.get("pre") or []) if isinstance(e, dict)}
        pt = a.get("pre_text") or {}
        add_out, install_out = pt.get("marketplace-add", ""), pt.get("plugin-install", "")
        add_rc, install_rc = rc.get("marketplace-add"), rc.get("plugin-install")
        if install_rc == 0 and not MARKET_REFUSED.search(install_out):
            return "loaded", "installed:N9"
        if not org_ok(ps):
            return "inconclusive", "no-control:probe-not-in-org-tier"
        add_refused = bool(MARKET_REFUSED.search(add_out)) and add_rc not in (0, None)
        install_related = bool(INSTALL_NOT_IN_MK.search(install_out)) and install_rc not in (0, None)
        if add_refused and install_related:
            return "blocked", "marketplace-add-refused"
        if add_refused and install_rc not in (0, None):
            # add refused, but the install failed for a reason that does not name this marketplace.
            return "inconclusive", "install-failure-unrelated"
        if install_rc not in (0, None):
            return "inconclusive", "install-error"
        return "inconclusive", "install-outcome-unknown"
    if aid == "N17-user":
        # The user path (`claude mcp add`). Blocked only on the managed-settings refusal text.
        rc = {e.get("alias"): e.get("rc") for e in (r.get("pre") or []) if isinstance(e, dict)}
        add_out, add_rc = (a.get("pre_text") or {}).get("mcp-add", ""), rc.get("mcp-add")
        if MCP_USER_REFUSED.search(add_out) and add_rc not in (0, None):
            return "blocked", "mcp-user-refused"
        if add_rc not in (0, None):
            return "inconclusive", "mcp-add-error"
        return "inconclusive", "mcp-add-outcome-unknown"
    if aid == "N17-project":
        # The project path (.mcp.json). Needs the sanitized approval capture: the server was
        # identified and approved, then did NOT start and a refusal line names it. A generic
        # message is never proof; no attributable refusal => INCONCLUSIVE.
        ap = (r.get("mcp_approval") or {})
        if not (ap.get("identified") and ap.get("approved")):
            return "inconclusive", "mcp-project-not-approved-or-unidentified"
        if MCP_SERVER_DENIED.search(a["debug"]):
            return "blocked", "mcp-project-denied-after-approval"
        return "inconclusive", "mcp-project-no-attributable-refusal"
    if aid == "N14":
        # Measurement first: to judge the @skills-dir attack we require the managed probe to have
        # established in THIS start (session.start + org tier). Workspace-trust / probe failures
        # are measurement INCONCLUSIVE (harness-startup-failed), never blocked.
        if (r.get("startup") or "") == "trust-unconfirmed" or not org_ok(ps):
            return "inconclusive", "harness-startup-failed"
        if any(m.group(1) or m.group(2) for m in ROGUE_LOADED.finditer(a["debug"])):
            return "loaded", "skills-dir-rogue-loaded"
        if re.search(r"skills-dir[^\n]*blocked|blocked[^\n]*skills-dir|are blocked by your organization's managed settings", a["debug"]):
            return "blocked", "skills-dir-scan-blocked"
        return "inconclusive", "skills-dir-block-not-logged"
    if not org_ok(ps):
        return "inconclusive", "no-control:probe-not-in-org-tier"
    # A rogue hooks module that LOADED is a FAIL whether or not its marker landed: the write
    # could fail for an unrelated reason, so "no marker" is never enough on its own.
    if any(m.group(1) or m.group(2) for m in ROGUE_LOADED.finditer(a["debug"])):
        return "loaded", "rogue-loaded-no-marker"
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
                "note": "N10/N11/N13 estan EXCLUIDOS del alcance (no son caminos de carga para un marketplace de directorio), no blocked. "
                        "Un PASS de alcance reducido no es la seguridad general de Channels: no cubre lo pendiente, el lanzamiento (09-launch-trust.md), "
                        "H-ND (B1b) ni los ataques al gateway (B2)."}

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
    bad_settings = sorted(aid for aid, a in att.items() if a and SETTINGS_INVALID.search(a["debug"]))
    if bad_settings:
        incs.append("settings-invalid")
        facts["settings_invalid_in"] = bad_settings
    ps = probe_state(p0)
    facts["probe"] = {k: ps[k] for k in ("loaded", "tiers", "kinds", "in_place_read", "not_org_warning")}
    if ps["loaded"] and "user" in ps["tiers"]:
        fails.append("probe-user-tier")
    elif ps["tiers"] and not set(ps["tiers"]) <= KNOWN_TIERS:
        incs.append("tier-label-unknown")
    elif not org_ok(ps):
        incs.append("probe-not-org")
    facts["classic_session_end_seen"] = "classic.SessionEnd" in ps["kinds"]
    if "classic.SessionStart" not in ps["kinds"]:
        incs.append("classic-sessionstart-missing")
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
    facts["excluded"] = {aid: EXCLUDED[aid] for aid in EXCLUDED}   # retired, not blocked; not counted
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

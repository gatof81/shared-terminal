#!/usr/bin/env python3
"""SEPARATE verdict layer for the unified observer (owner req 1). Consumes an Observer snapshot and
applies the per-control criteria. It is deliberately NOT part of the observer.

Hard rules:
- Insufficient capture (coverage != "full" where a pane signal is required) => INCONCLUSIVE, NEVER
  PASS/blocked (req 9).
- A pane-derived "blocked" is LOW confidence (attacker-writable); it is credited only when the same
  start shows NO attacker load (if the rogue had run it would be FAIL; not having run, it could not
  have forged the block text) and it is attributable to .claude/skills (req 4/6).
- Trust confirmed is necessary, NOT sufficient for P0 (req 3).
- `selected-no-signal` is NEVER upgraded to blocked (req 5).
- Everything is judged within ONE (attempt, start, instance) snapshot, so a signal from another
  start can never validate a block (req 2).
"""


def _sig(events, concern, pred=None):
    return [e for e in events if e["concern"] == concern and (pred is None or pred(e["signal"]))]


def verdict_p0(snap):
    ev = snap["events"]
    controls = {e["signal"] for e in ev if e["concern"] == "control"}
    trust_ok = any(e["concern"] == "trust" and e["signal"] == "confirmed" for e in ev)
    need = {"session.start", "probe-org-tier", "guard-seated-loaded"}
    if not trust_ok:
        return "inconclusive", "trust-not-confirmed"
    if not need <= controls:
        return "baseline-invalid", "missing-controls:" + ",".join(sorted(need - controls))
    return "baseline-ok", "trust+session.start+probe-org+guard(same-start)"


def verdict_n14(snap):
    ev = snap["events"]
    if _sig(ev, "skills-dir", lambda s: s == "loaded"):
        return "FAIL", "skills-dir-loaded(high)"          # attacker executed; decisive, any coverage
    if snap["coverage"] != "full":
        return "inconclusive", "insufficient-capture"     # never PASS/blocked on bad capture
    if verdict_p0(snap)[0] != "baseline-ok":
        return "inconclusive", "baseline-not-ok"
    blocked = _sig(ev, "skills-dir", lambda s: s == "blocked")
    if blocked:
        detail = blocked[0].get("detail") or {}
        if detail.get("path_kind") != "claude-skills":
            return "inconclusive", "block-not-attributable-to-skills-dir"
        return "blocked-low", "skills-dir-blocked(pane,low;corroborated:no-load,same-start)"
    return "inconclusive", "no-load-and-no-observable-rejection"   # req 4: absence != blocked


def verdict_n17_project(snap):
    ev = snap["events"]
    if _sig(ev, "mcp-project", lambda s: s == "started"):
        return "FAIL", "mcp-project-started(high)"
    selection = next((e["signal"] for e in _sig(ev, "mcp-project", lambda s: s.startswith("selection="))), None)
    dismissed = next((e["signal"] for e in _sig(ev, "mcp-project", lambda s: s.startswith("dismissed="))), None)
    accept = bool(_sig(ev, "mcp-project", lambda s: s == "accept-signal"))
    # Option A: approve selected + dialog closed while running + NO independent accept signal
    # => selected-no-signal => INCONCLUSIVE. NEVER blocked (req 5). 2.1.314 emits no accept signal.
    if selection == "selection=approve" and dismissed == "dismissed=running" and not accept:
        return "inconclusive", "selected-no-signal(option-A)"
    return "inconclusive", "no-confirmed-approval"


def verdict(snap):
    """Dispatch by attempt. Unknown/other attempts => inconclusive (never PASS)."""
    a = snap.get("attempt")
    fn = {"P0": verdict_p0, "N14": verdict_n14, "N17-project": verdict_n17_project}.get(a)
    if fn is None:
        return "inconclusive", f"no-verdict-for:{a}"
    return fn(snap)

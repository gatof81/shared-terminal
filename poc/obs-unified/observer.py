#!/usr/bin/env python3
"""Unified observability prototype (pane -> enum) for PASS-B1a's security decisions: trust, N14
(skills-dir) and N17-project. DISPOSABLE; NOT part of the audited kit (`poc/passb1`, 8eafe1a); it
does not import or modify it, and is never run on VM100.

Architecture (owner req 1): CAPTURE -> CLASSIFY -> (separate) VERDICT. This module is the OBSERVER:
it emits STRUCTURED FACTS only. It does NOT decide PASS/FAIL (that lives in verdict.py, deliberately
separate). Privacy (req 7): it never stores raw pane/terminal text — only sanitized enums, a path
KIND (not the path), timings, observer state and capture coverage.

Correlation (req 2): every event carries (attempt, start, instance). A fact from one start can
never be used to validate another start — the verdict matches on (attempt, start, instance).

Confidence: facts from the `--debug-file` or the trust/mcp gate are HIGH (the CLI's own structured
output, or our own driver). Facts read from the PANE are LOW — the pane is attacker-writable, so a
pane-derived "blocked" is only corroborating, never decisive on its own (see verdict.py).
"""
import re

SCHEMA = "obs/1"

# ── HIGH-confidence signals: the CLI's own [DEBUG] lines (2.1.314 phrasings) ──
SESSION_START = re.compile(r"\bst-b1-probe\b.*session\.start|probe.*session\.start")
PROBE_LOADED_ORG = re.compile(
    r"hooks module st-b1-probe@\S+ loaded \(\w+, environment \d+, tier (prepend|append)\)")
GUARD_SEATED = re.compile(r"cc-plugin-sec-default@builtin .*seated|seated outermost: this machine has managed settings")
GUARD_LOADED = re.compile(r"hooks module cc-plugin-sec-default@builtin loaded \(")
ROGUE_N14_LOADED = re.compile(r"hooks module st-b1-rogue-n14@\S+ loaded \(|plugin\.register: st-b1-rogue-n14 \(")

# ── LOW-confidence signals: the transient PANE (attacker-writable) ──
# The real 2.1.314 skills-dir block builder `yvn`, specific via its hardcoded skills-dir advice.
SKILLS_DIR_BLOCK = re.compile(
    r"Plugins from (\S+) are blocked by your organization's managed settings "
    r"\(strictKnownMarketplaces or blockedMarketplaces\)\. "
    r"Ask your administrator to add \{\"source\":\"skills-dir\"\}")
# The n17p project-server policy refusal (pane).
MCP_N17P_REFUSAL = re.compile(
    r'MCP server "st-b1-rogue-n17p"[^\n]*(not allowed by your organization|denied|blocked by)')


def _path_kind(path):
    """A path reduced to a KIND — never the raw path (privacy)."""
    if "/.claude/skills/" in path or path.rstrip("/").endswith("/.claude/skills"):
        return "claude-skills"
    return "other"


def classify_debug(text):
    """HIGH-confidence facts from the debug file. Returns [(concern, signal, confidence, detail)]."""
    t = text or ""
    out = []
    if PROBE_LOADED_ORG.search(t):
        out.append(("control", "probe-org-tier", "high", None))
    if SESSION_START.search(t):
        out.append(("control", "session.start", "high", None))
    if GUARD_SEATED.search(t) and GUARD_LOADED.search(t):
        out.append(("control", "guard-seated-loaded", "high", None))
    if ROGUE_N14_LOADED.search(t):
        out.append(("skills-dir", "loaded", "high", None))   # FAIL signal (attacker executed)
    return out


def classify_pane(text):
    """LOW-confidence facts from the transient pane. Returns [(concern, signal, confidence, detail)]."""
    t = text or ""
    out = []
    m = SKILLS_DIR_BLOCK.search(t)
    if m:
        out.append(("skills-dir", "blocked", "low", {"path_kind": _path_kind(m.group(1))}))
    if MCP_N17P_REFUSAL.search(t):
        out.append(("mcp-project", "refusal", "low", None))
    return out


class Observer:
    """Collects facts for ONE (attempt, start, instance). `clock()` is an injected monotonic source.
    It tracks capture coverage: every pane read that fails / returns empty degrades coverage, so the
    verdict can refuse a PASS when capture was insufficient (req 9)."""

    def __init__(self, attempt, start, instance, clock):
        self.ctx = {"attempt": attempt, "start": start, "instance": instance}
        self.clock = clock
        self.t0 = clock()
        self.events = []
        self.pane_reads = 0
        self.pane_fails = 0

    def _emit(self, concern, signal, source, confidence, detail=None):
        self.events.append({
            "schema": SCHEMA, **self.ctx, "concern": concern, "signal": signal,
            "source": source, "confidence": confidence, "detail": detail,
            "t": round(self.clock() - self.t0, 3), "coverage": self.coverage()})

    def coverage(self):
        # none  = no reads, or every read failed (nothing usable captured)
        # partial = some reads failed; full = all reads succeeded
        if self.pane_reads == 0 or self.pane_fails == self.pane_reads:
            return "none"
        return "full" if self.pane_fails == 0 else "partial"

    def fact(self, concern, signal, source="gate", confidence="high", detail=None):
        """Record a fact from our own driver (trust/mcp gate): selection, dismissed, confirmed, …"""
        self._emit(concern, signal, source, confidence, detail)

    def from_debug(self, text):
        for c, s, conf, d in classify_debug(text):
            self._emit(c, s, "debug", conf, d)

    def from_pane(self, text, *, ok=True):
        self.pane_reads += 1
        if not ok or not (text or "").strip():
            self.pane_fails += 1
            return
        for c, s, conf, d in classify_pane(text):
            self._emit(c, s, "pane", conf, d)

    def snapshot(self):
        return {"schema": SCHEMA, **self.ctx, "coverage": self.coverage(),
                "pane_reads": self.pane_reads, "pane_fails": self.pane_fails,
                "events": list(self.events)}

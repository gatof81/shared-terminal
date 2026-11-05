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
import json
import re

SCHEMA = "obs/1"

# ── HIGH-confidence signals: the CLI's own [DEBUG] lines (2.1.314 phrasings) ──
PROBE_LOADED_ORG = re.compile(
    r"hooks module st-b1-probe@\S+ loaded \(\w+, environment \d+, tier (prepend|append)\)")
# Positive guard seating ONLY (the kit's exact phrasings). The negative "not seated" must never be
# read as valid (B1), so it is matched separately and takes precedence in classify_debug.
GUARD_SEATED_POS = re.compile(
    r"cc-plugin-sec-default@builtin seated (?:outermost: this machine has managed settings|by managed prependPlugins)"
    r"|(?<!not )seated outermost: this machine has managed settings")
GUARD_NOT_SEATED = re.compile(r"cc-plugin-sec-default@builtin not seated")
GUARD_LOADED = re.compile(r"hooks module cc-plugin-sec-default@builtin loaded \(")
ROGUE_N14_LOADED = re.compile(r"hooks module st-b1-rogue-n14@\S+ loaded \(|plugin\.register: st-b1-rogue-n14 \(")
# session.start is proven ONLY by the probe's EXECUTION records (from_probe_records), NOT by the
# "events: session.start" DECLARATION on the load line (B2).

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
    """HIGH-confidence facts from the debug file. Returns [(concern, signal, confidence, detail)].
    Does NOT emit session.start — that needs an execution record (B2)."""
    t = text or ""
    out = []
    if PROBE_LOADED_ORG.search(t):
        out.append(("control", "probe-org-tier", "high", None))
    # C3: emit ATOMIC guard sub-facts so seated/loaded can arrive in SEPARATE debug fragments and
    # still accumulate; verdict_p0 combines them and still lets a later `not-seated` win (B1).
    if GUARD_NOT_SEATED.search(t):
        out.append(("control", "guard-not-seated", "high", None))
    if GUARD_SEATED_POS.search(t):
        out.append(("control", "guard-seated", "high", None))
    if GUARD_LOADED.search(t):
        out.append(("control", "guard-loaded", "high", None))
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
        self._emitted = set()     # B6: identity dedup — a signal is emitted once, original t kept
        self._debug_cursor = 0    # B6: only classify the newly-appended debug tail
        self._dbg_prefix = ""     # B5: the exact debug text already consumed (for continuity check)
        self._dbg_disc = False    # B5: debug truncation/replacement/rotation detected
        self.reads = []           # (t, ok) per pane read — the critical window is DERIVED from these
        self.win = {"max_gap": 1.0}                   # max tolerated gap between consecutive reads

    def _emit(self, concern, signal, source, confidence, detail=None):
        # Identity = (concern, signal, source, detail). Re-reads never re-emit; the FIRST event
        # keeps its original t/coverage (provenance preserved) — B6.
        key = (concern, signal, source, json.dumps(detail, sort_keys=True))
        if key in self._emitted:
            return
        self._emitted.add(key)
        self.events.append({
            "schema": SCHEMA, **self.ctx, "concern": concern, "signal": signal,
            "source": source, "confidence": confidence, "detail": detail,
            "t": round(self.clock() - self.t0, 3), "coverage": self.coverage()})

    def set_window(self, *, max_gap=None):
        if max_gap is not None:
            self.win["max_gap"] = max_gap
        return self

    def coverage(self):
        """Temporal coverage (F2): the critical window is DERIVED from the reads we actually made —
        [first successful read, last successful read] — NEVER from separate driver timestamps.

        The old `window_open`/`window_close` recorded a fresh `clock()` sample that raced the reads:
        `from_pane` stamped the read FIRST, then `window_open` sampled a strictly later instant, and
        `window_close` was sampled AFTER the last read. With a real advancing clock the last read
        then sat before `window_close` (=> partial), and only favourable sub-millisecond rounding
        made the brackets coincide (=> an accidental `full`) — without ever demonstrating that we had
        observed the system BEFORE the decision was taken.

        So coverage is now defined by evidence, not by timestamps we move: `full` requires debug
        continuity intact; no failed read; at least one read; no gap > max_gap between consecutive
        reads; and every pane DECISION STRICTLY bracketed by reads — a successful read at t < d AND a
        successful read at t > d. The strict bracket is the real guarantee the owner asked for: a
        read before the decision proves we were already watching when it was taken (we did not attach
        mid-stream and catch only its tail), and a read after proves we watched it settle. A decision
        at/before the first read (initialisation we started watching too late to witness) or at/after
        the last read is NOT bracketed => partial. Late/incomplete capture never credits a block."""
        if self._dbg_disc:
            return "partial"                     # B5: debug continuity lost — degrade
        oks = sorted(t for t, ok in self.reads if ok)
        if not oks:
            return "none"
        if len(self.reads) != len(oks):
            return "partial"                     # any failed read
        if any(b - a > self.win["max_gap"] for a, b in zip(oks, oks[1:])):
            return "partial"                     # a gap larger than tolerated
        first, last = oks[0], oks[-1]
        decisions = [e["t"] for e in self.events if e["source"] == "pane"]
        if any(not (first < d < last) for d in decisions):
            return "partial"                     # a decision not STRICTLY bracketed by reads
        return "full"

    def fact(self, concern, signal, source="gate", confidence="high", detail=None):
        """Record a fact from our own driver (trust/mcp gate): selection, dismissed, confirmed, …"""
        self._emit(concern, signal, source, confidence, detail)

    def fixture_identity(self, digest, *, name="st-b1-rogue-n14"):
        """Record THIS run's N14 fixture identity (a content digest), from the harness that planted
        it (control source). The N14 attribution's differential must reference the SAME digest, so a
        bare driver assertion cannot stand in for a validated positive control (C2)."""
        self._emit("skills-dir", "fixture", "control", "high", detail={"name": name, "digest": digest})

    def from_debug(self, text):
        # B6: classify ONLY complete lines past the cursor, so existing events are never re-scanned.
        # B5: detect truncation / replacement / rotation — if the file shrank below the cursor or the
        # already-consumed prefix changed, continuity is LOST; mark it (degrades coverage) and do NOT
        # trust the old cursor (reclassify from 0; identity dedup prevents duplicate emits).
        text = text or ""
        if len(text) < self._debug_cursor or text[:self._debug_cursor] != self._dbg_prefix:
            self._dbg_disc = True
            self._debug_cursor = 0
            self._dbg_prefix = ""
        end = text.rfind("\n") + 1          # only complete lines
        chunk = text[self._debug_cursor:end]
        if not chunk:
            return
        self._debug_cursor = end
        self._dbg_prefix = text[:end]
        for c, s, conf, d in classify_debug(chunk):
            self._emit(c, s, "debug", conf, d)

    def from_probe_records(self, records, *, expect_probe="st-b1-probe", start_inst=None):
        """session.start / classic.SessionStart from the probe's EXECUTION records — the fact that
        the hook RAN (B2), and ONLY for the EXPECTED probe whose `inst` is THIS start's (B3).
        Arbitrary records, the wrong probe, or a missing/other `inst` are ignored; `start_inst` is
        required (we never attribute execution to the current start without it)."""
        if start_inst is None:
            return
        for r in records or []:
            if not isinstance(r, dict) or r.get("probe") != expect_probe or r.get("inst") != start_inst:
                continue
            if r.get("kind") in ("session.start", "classic.SessionStart"):
                self._emit("control", r["kind"], "probe", "high", detail={"inst": start_inst})

    def from_pane(self, text, *, ok=True):
        good = bool(ok and (text or "").strip())
        self.reads.append((round(self.clock() - self.t0, 3), good))   # B4: timestamped window
        self.pane_reads += 1
        if not good:
            self.pane_fails += 1
            return
        for c, s, conf, d in classify_pane(text):
            self._emit(c, s, "pane", conf, d)

    def snapshot(self):
        oks = sorted(t for t, ok in self.reads if ok)
        window = {"open": oks[0] if oks else None, "close": oks[-1] if oks else None}  # DERIVED (F2)
        return {"schema": SCHEMA, **self.ctx, "coverage": self.coverage(),
                "debug_continuity": not self._dbg_disc, "window": window,
                "pane_reads": self.pane_reads, "pane_fails": self.pane_fails,
                "events": list(self.events)}

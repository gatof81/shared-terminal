#!/usr/bin/env python3
"""Investigation #1 — DISPOSABLE local instrumentation of the workspace-trust dialog.

NOT part of the audited PASS-B1a kit (`poc/passb1`, SHA 8eafe1a); it does not import it, modify it,
or change its criteria. It is a throwaway prototype to decide whether a hardened trust confirmation
is worth adding later. **Never run against VM100 or the retained containers.**

What it fixes vs. the audited kit's `one_start` trust drive (which blindly sent `("Down","Enter")`):
  1. reads the HIGHLIGHTED option as a known enum BEFORE pressing Enter;
  2. confirms ONLY when that option is `yes`; otherwise it STOPS and never sends Enter (so a lost
     `Down` can never land Enter on `No, exit`);
  3. a readiness gate: the trust screen's pointer line must be STABLE across N consecutive polls
     before any key is sent (closes the cold-start race, the H1 root-cause candidate);
  4. records the post-Enter result, process state and MONOTONIC timings.

Privacy: it emits only ENUMS and STRUCTURED STATES — never raw pane text / snapshots.
"""
import re

TRUST_PRESENT = re.compile(r"Yes, I trust this folder")
# The menu cursor line; tmux `capture-pane -p` keeps the glyph without colour.
POINTER = re.compile(r"^[ \t]*(?:❯|>)[ \t]+(.+\S)[ \t]*$", re.M)


def pointer_option(text):
    """The highlighted option as an enum: 'yes' | 'no' | 'other' | None (no pointer / not present)."""
    if not TRUST_PRESENT.search(text or ""):
        return None
    m = POINTER.search(text)
    if not m:
        return None
    label = m.group(1)
    if "Yes, I trust this folder" in label:
        return "yes"
    if "No, exit" in label:
        return "no"
    return "other"


def _pointer_line(text):
    m = POINTER.search(text or "")
    return m.group(0).strip() if m else None


class IO:
    """Injectable boundary so the driver is unit-testable and can also wrap real tmux.

    pane() -> current pane text (transient; the driver never stores it);
    send(key); exited() -> bool (the CLI process has ended); now() -> monotonic seconds; sleep(s).
    """

    def pane(self): raise NotImplementedError
    def send(self, key): raise NotImplementedError
    def exited(self): raise NotImplementedError
    def now(self): raise NotImplementedError
    def sleep(self, s): raise NotImplementedError


def drive_trust(io, *, poll=0.2, stable_polls=2, ready_timeout=30.0, max_nav=5, settle=2.0):
    """Confirm workspace trust SAFELY. Returns a structured, enum-only result; never sends Enter
    unless the pointer is verified on `yes`."""
    t_start = io.now()
    r = {"state": None, "selection_before_enter": None, "enter_sent": False,
         "dismissed": None, "ready": False, "ready_polls": 0, "nav_sends": 0,
         "t": {"first_seen": None, "ready": None, "enter": None, "settled": None}}

    def dt(t):
        return None if t is None else round(t - t_start, 3)

    # ── Phase A: wait until the trust screen's pointer line is STABLE across `stable_polls` polls ──
    last_line, stable = None, 0
    first_seen = None
    while io.now() - t_start < ready_timeout:
        if io.exited():
            r["state"] = "exited-before-ready"
            r["t"]["first_seen"] = dt(first_seen)
            return r
        text = io.pane()
        if TRUST_PRESENT.search(text or ""):
            if first_seen is None:
                first_seen = io.now()
            line = _pointer_line(text)
            if line is not None and line == last_line:
                stable += 1
            else:
                stable = 1
                last_line = line
            if line is not None and stable >= stable_polls:
                r["ready"] = True
                r["ready_polls"] = stable
                r["t"]["first_seen"] = dt(first_seen)
                r["t"]["ready"] = dt(io.now())
                break
        else:
            stable, last_line = 0, None
        io.sleep(poll)
    if not r["ready"]:
        r["state"] = "screen-not-ready"
        r["t"]["first_seen"] = dt(first_seen)
        return r

    # ── Phase B: navigate to `yes` (bounded); re-read until the pointer line is stable again ──
    def stable_option():
        prev = None
        for _ in range(stable_polls):
            if io.exited():
                return "exited"
            txt = io.pane()
            opt, line = pointer_option(txt), _pointer_line(txt)
            if prev is not None and line != prev:
                return None  # moved while reading; not stable yet
            prev = line
            io.sleep(poll)
        return opt

    opt = stable_option()
    nav = 0
    while opt not in ("yes", "exited") and nav < max_nav:
        io.send("Down")
        r["nav_sends"] = nav + 1
        io.sleep(poll * 2)
        opt = stable_option()
        nav += 1

    if opt == "exited":
        r["state"] = "exited-before-confirm"
        return r

    r["selection_before_enter"] = opt

    # ── Phase C: confirm ONLY on a verified `yes`; otherwise STOP without sending Enter ──
    if opt != "yes":
        r["state"] = "not-yes-aborted"   # a lost Down can never confirm "No, exit"
        return r

    # ── Phase D: send Enter, then classify the outcome by process + screen state ──
    io.send("Enter")
    r["enter_sent"] = True
    r["t"]["enter"] = dt(io.now())
    io.sleep(settle)
    r["t"]["settled"] = dt(io.now())
    gone = not TRUST_PRESENT.search(io.pane() or "")
    exited = io.exited()
    if gone and not exited:
        r["dismissed"], r["state"] = "running", "confirmed"
    elif gone and exited:
        r["dismissed"], r["state"] = "exit", "confirmed-then-exited"  # Enter sent but process ended
    else:
        r["dismissed"], r["state"] = "persistent", "enter-ineffective"
    return r

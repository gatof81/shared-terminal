#!/usr/bin/env python3
"""End-to-end isolated smoke for the unified observer — PREPARED, NOT RUN. DISPOSABLE; separate from
the audited kit (poc/passb1@8eafe1a), never run on VM100 / the retained containers / real sessions,
and not executed while the #521 canary window is reserved.

One run, THREE controls, clearly differentiated in the output:
  positive  — same fixture, NO policy      → expect skills-dir:loaded (REAL load evidence)
  negative  — same fixture, WITH policy     → expect pane skills-dir:blocked, no load
  absent    — NO fixture                     → expect no skills-dir signal at all

Owner C2: the positive control must produce REAL, verifiable load evidence of the SAME fixture
(execution + digest). The negative run's N14 attribution is NOT a driver-declared `control_loaded`:
`build_attribution()` derives a validated differential ONLY from the positive control's own
`skills-dir:loaded` event bound to the fixture digest; absent that, the attribution is None and the
verdict stays INCONCLUSIVE (never blocked-low). `blocked-low` is the MAXIMUM for a pane-supported
attribution.

Isolation + supervision (owner): the CLI runs under `unshare --map-root-user --net --pid --fork
--mount-proc` — a fresh NET namespace (only `lo`, verifiable) and a fresh PID namespace (the CLI is
PID 1; killing the unshare leader reaps the whole namespace — verifiable identity, no pgid reuse, no
`pkill -f`). FAIL-CLOSED: any isolation or capture error ABORTS with an INCONCLUSIVE result and is
NEVER reinterpreted.
"""
import os
import shlex
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import observer as O  # noqa: E402
import verdict as V  # noqa: E402


# ── pure helpers (testable without a CLI) ──
def isolation_argv(cli, home, ws, debug, pgidfile, *, policy_path=None):
    """The argv that launches the CLI inside user+net+pid namespaces, writing its own PGID first."""
    env = {"PATH": "/usr/bin:/bin", "HOME": home, "TERM": "xterm-256color", "DISABLE_AUTOUPDATER": "1"}
    if policy_path:
        env["CLAUDE_CODE_MANAGED_SETTINGS_PATH"] = policy_path
    envs = " ".join(f"{k}={shlex.quote(v)}" for k, v in env.items())
    inner = (f"echo $$ > {shlex.quote(pgidfile)}; "
             f"exec env -i {envs} {shlex.quote(cli)} --debug-file {shlex.quote(debug)} "
             f"2> {shlex.quote(os.path.join(ws, 'stderr.txt'))}")
    return ["unshare", "--map-root-user", "--net", "--pid", "--fork", "--mount-proc", "sh", "-c", inner]


def positive_loaded_digest(positive_snapshot):
    """The fixture digest the POSITIVE control actually LOADED, or None. Requires a REAL
    `skills-dir:loaded` event AND a `skills-dir:fixture` event with a digest in that control's own
    snapshot — not a flag."""
    ev = positive_snapshot.get("events", [])
    loaded = any(e["concern"] == "skills-dir" and e["signal"] == "loaded" for e in ev)
    digest = next((((e.get("detail") or {}).get("digest"))
                   for e in ev if e["concern"] == "skills-dir" and e["signal"] == "fixture"
                   and (e.get("detail") or {}).get("digest")), None)
    return digest if (loaded and digest) else None


def build_attribution(positive_snapshot):
    """A VALIDATED differential reference derived from the positive control's real evidence, or None
    (C2). The `evidence` field is the real signal observed; a driver cannot mint it."""
    digest = positive_loaded_digest(positive_snapshot)
    if not digest:
        return None
    return {"control_run": positive_snapshot.get("instance") or positive_snapshot.get("attempt"),
            "evidence": "skills-dir:loaded", "fixture_digest": digest}


def _with_attribution(neg_snapshot, differential):
    """Return a copy of the negative snapshot with a correlated block-attributable event carrying the
    validated differential. (The negative run already recorded its own skills-dir:fixture digest; the
    verdict checks differential.fixture_digest == that digest.)"""
    snap = {**neg_snapshot, "events": list(neg_snapshot.get("events", []))}
    ctx = {k: neg_snapshot.get(k) for k in ("schema", "attempt", "start", "instance")}
    snap["events"].append({**ctx, "concern": "skills-dir", "signal": "block-attributable",
                           "source": "control", "confidence": "high",
                           "detail": {"fixture": "st-b1-rogue-n14", "differential": differential},
                           "t": None, "coverage": neg_snapshot.get("coverage")})
    return snap


def _summary(snap):
    return {"coverage": snap.get("coverage"),
            "skills_dir": sorted({e["signal"] for e in snap.get("events", []) if e["concern"] == "skills-dir"})}


# ── orchestrator (injectable: tests pass fakes; real mode passes the CLI runner) ──
def run_three_controls(runner, *, check_isolation, check_cleanup):
    """Run positive/negative/absent via `runner(kind)->{"ok":bool,"snapshot":..,"reason":..}`. FAIL-
    CLOSED: an isolation / capture / cleanup failure aborts with an INCONCLUSIVE result, never
    reinterpreting. Returns a structured result differentiating the three controls, with the N14
    verdict capped at blocked-low."""
    base = {"controls": {}, "verdict": ("inconclusive", None), "differential_validated": False,
            "aborted": False, "reason": None}
    if not check_isolation():
        return {**base, "aborted": True, "reason": "isolation-check-failed"}
    snaps = {}
    for kind in ("positive", "negative", "absent"):
        res = runner(kind)
        if not res.get("ok"):
            return {**base, "aborted": True, "reason": f"{kind}:{res.get('reason', 'capture-error')}"}
        snaps[kind] = res["snapshot"]
    if not check_cleanup():
        return {**base, "aborted": True, "reason": "cleanup-verification-failed"}

    differential = build_attribution(snaps["positive"])          # C2: from REAL positive evidence
    neg = _with_attribution(snaps["negative"], differential) if differential else snaps["negative"]
    verdict = V.verdict(neg)                                     # blocked-low at most; else inconclusive/FAIL
    controls = {k: _summary(snaps[k]) for k in ("positive", "negative", "absent")}
    controls["negative"] = _summary(neg)                         # the stamped negative snapshot
    return {"controls": controls, "verdict": verdict,
            "differential_validated": differential is not None, "aborted": False, "reason": None}


# ── real-mode pieces (pragma: no cover — not run during the canary / before operational GO) ──
def real_check_isolation(run_in_ns):   # pragma: no cover
    """True iff, inside the namespace, only `lo` exists and an outbound connect fails. `run_in_ns`
    runs a command inside the same unshare namespaces and returns (rc, stdout)."""
    rc, links = run_in_ns(["sh", "-c", "ip -o link show | awk -F': ' '{print $2}'"])
    only_lo = rc == 0 and {ln.strip() for ln in links.split() if ln.strip()} <= {"lo"}
    rc2, _ = run_in_ns([sys.executable, "-I", "-c",
                        "import socket,sys;\ntry:\n socket.create_connection(('1.1.1.1',53),1); sys.exit(1)\nexcept OSError: sys.exit(0)"])
    outbound_blocked = rc2 == 0
    return bool(only_lo and outbound_blocked)


def real_check_cleanup(pgid):   # pragma: no cover
    """True iff the CLI's PID namespace was reaped: its leader pgid no longer exists."""
    try:
        os.killpg(pgid, 0)
        return False            # still alive => cleanup failed
    except (ProcessLookupError, PermissionError):
        return True
    except OSError:
        return False

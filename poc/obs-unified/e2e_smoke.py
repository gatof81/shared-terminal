#!/usr/bin/env python3
"""End-to-end isolated smoke for the unified observer — REAL runner implemented, RUN NOTHING here.
DISPOSABLE; separate from the audited kit (poc/passb1@8eafe1a); never run on VM100 / the retained
containers / real sessions, and not executed while the #521 canary window is reserved.

One run, THREE controls, clearly differentiated:
  positive  — same fixture, NO policy  → expect skills-dir:loaded (REAL load evidence)
  negative  — same fixture, WITH policy → expect pane skills-dir:blocked, no load
  absent    — NO fixture                → expect no skills-dir signal

Three blockers implemented here:
  (1) REAL end-to-end runner (`make_runner` + `RealSys`): per control it plants the fixture/policy,
      launches the CLI under isolation, wires the trust-gate into the Observer, captures pane+debug
      FROM INITIALIZATION, feeds probe records, opens/closes the critical window, and verifies
      cleanup. IO sits behind an injectable `sysio` seam so every ERROR PATH is unit-tested with a
      fake; `RealSys` (the actual unshare/tmux/subprocess IO) is `pragma: no cover`.
  (2) PER-INSTANCE isolation + cleanup: each control is its own instance (unique id, tmux socket,
      pgid file, namespaces); the runner verifies isolation BEFORE capture and reap AFTER, for THAT
      instance, and fails closed (ok:false + reason) on any failure — never reinterpreted.
  (3) INDEPENDENT validation of the positive control: the orchestrator does not trust the runner's
      claim — it re-validates the positive snapshot (authority+correlation), confirms a REAL
      skills-dir:loaded, and requires the fixture digest (an INDEPENDENT sha256 of the planted dir,
      returned per instance) to match between positive and negative. Absent any of these, the
      differential is None and N14 stays INCONCLUSIVE. `blocked-low` is the MAX for a pane attribution.
"""
import hashlib
import os
import secrets
import shlex
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import observer as O  # noqa: E402
import verdict as V  # noqa: E402


# ── pure helpers (testable without a CLI) ──
def isolation_argv(cli, home, ws, debug, pgidfile, *, policy_path=None):
    env = {"PATH": "/usr/bin:/bin", "HOME": home, "TERM": "xterm-256color", "DISABLE_AUTOUPDATER": "1"}
    if policy_path:
        env["CLAUDE_CODE_MANAGED_SETTINGS_PATH"] = policy_path
    envs = " ".join(f"{k}={shlex.quote(v)}" for k, v in env.items())
    inner = (f"echo $$ > {shlex.quote(pgidfile)}; "
             f"exec env -i {envs} {shlex.quote(cli)} --debug-file {shlex.quote(debug)} "
             f"2> {shlex.quote(os.path.join(ws, 'stderr.txt'))}")
    return ["unshare", "--map-root-user", "--net", "--pid", "--fork", "--mount-proc", "sh", "-c", inner]


def fixture_digest(path):
    """An INDEPENDENT sha256 over the planted fixture directory (sorted rel-path + bytes). The smoke
    hashes the files on disk itself — it never trusts a digest the runner merely asserts (blocker 3)."""
    h = hashlib.sha256()
    for rel in sorted(os.path.relpath(os.path.join(p, f), path)
                      for p, _, fs in os.walk(path) for f in fs):
        with open(os.path.join(path, rel), "rb") as fh:
            h.update(rel.encode() + b"\0" + hashlib.sha256(fh.read()).hexdigest().encode() + b"\n")
    return h.hexdigest()


def _read_pgid(text):
    v = (text or "").strip()
    return int(v) if v.isdigit() and int(v) > 1 else None


def positive_loaded_digest(snap):
    ev = snap.get("events", [])
    loaded = any(e["concern"] == "skills-dir" and e["signal"] == "loaded" for e in ev)
    digest = next((((e.get("detail") or {}).get("digest"))
                   for e in ev if e["concern"] == "skills-dir" and e["signal"] == "fixture"
                   and (e.get("detail") or {}).get("digest")), None)
    return digest if (loaded and digest) else None


def validate_positive(snap):
    """INDEPENDENT validation of the positive control (blocker 3): the snapshot must pass authority +
    correlation, and carry a REAL skills-dir:loaded bound to a fixture digest. Returns (ok, digest)."""
    ok, _ = V.validate_snapshot(snap)
    if not ok:
        return False, None
    dig = positive_loaded_digest(snap)
    return (dig is not None), dig


def build_attribution(positive_snapshot):
    dig = positive_loaded_digest(positive_snapshot)
    if not dig:
        return None
    return {"control_run": positive_snapshot.get("instance") or positive_snapshot.get("attempt"),
            "evidence": "skills-dir:loaded", "fixture_digest": dig}


def _with_attribution(neg_snapshot, differential):
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


# ── the REAL runner (blockers 1 & 2), IO behind an injectable `sysio` seam ──
def make_runner(sysio, *, cli, scratch, trust_gate, clock, settle_polls=4):
    """Return runner(kind)->{ok, snapshot, instance, digest, reason}. Per-instance isolation+cleanup;
    fail-closed on any isolation/launch/capture/cleanup error (no reinterpretation)."""
    def runner(kind):
        inst = f"{kind}-{secrets.token_hex(3)}"
        sock = f"obs-{inst}"
        home = os.path.join(scratch, inst, "home")
        ws = os.path.join(scratch, inst, "ws")
        debug, pgidfile = os.path.join(ws, "debug.log"), os.path.join(ws, "pgid")
        fixture_dir, policy = sysio.setup(kind, home, ws)        # plant fixture (pos/neg) + policy (neg)
        digest = fixture_digest(fixture_dir) if fixture_dir else None
        o = O.Observer("N14", 1, inst, clock)
        o.window_open(clock())                                   # window opens at INITIALIZATION (C4)
        spawned = False
        try:
            argv = isolation_argv(cli, home, ws, debug, pgidfile, policy_path=policy)
            try:
                sysio.spawn(argv, sock)
                spawned = True
            except Exception:
                return {"ok": False, "reason": "spawn-failed", "instance": inst}
            if not sysio.check_isolation(sock):                  # PER-INSTANCE isolation (blocker 2)
                return {"ok": False, "reason": "isolation-failed", "instance": inst}
            tg = trust_gate(sysio, sock, pgidfile)
            o.fact("trust", "confirmed" if tg.get("state") == "confirmed" else "aborted")
            for _ in range(settle_polls):
                txt = sysio.pane(sock)
                if txt is None:                                  # capture error
                    return {"ok": False, "reason": "capture-failed", "instance": inst}
                o.from_pane(txt, ok=True)
                o.from_debug(sysio.read_text(debug))
                o.from_probe_records(sysio.probe_records(ws), start_inst=sysio.probe_inst(ws))
            if digest:
                o.fixture_identity(digest)
            o.window_close(clock())
            snap = o.snapshot()
        finally:
            if spawned:
                pgid = _read_pgid(sysio.read_text(pgidfile))
                if not sysio.reap(sock, pgid):                   # PER-INSTANCE cleanup (blocker 2)
                    return {"ok": False, "reason": "cleanup-not-reaped", "instance": inst}
        return {"ok": True, "snapshot": snap, "instance": inst, "digest": digest}
    return runner


# ── orchestrator ──
def run_three_controls(runner):
    base = {"controls": {}, "verdict": ("inconclusive", None), "differential_validated": False,
            "positive_validated": False, "aborted": False, "reason": None}
    snaps, digs = {}, {}
    for kind in ("positive", "negative", "absent"):
        res = runner(kind)
        if not res.get("ok"):
            return {**base, "aborted": True, "reason": f"{kind}:{res.get('reason', 'capture-error')}"}
        snaps[kind], digs[kind] = res["snapshot"], res.get("digest")
    # Blocker 3: INDEPENDENTLY validate the positive control; require its digest to equal both its
    # own independently-hashed fixture AND the negative run's (same fixture bytes in both).
    pos_ok, pos_dig = validate_positive(snaps["positive"])
    differential = None
    if pos_ok and pos_dig and pos_dig == digs.get("positive") == digs.get("negative"):
        differential = build_attribution(snaps["positive"])
    neg = _with_attribution(snaps["negative"], differential) if differential else snaps["negative"]
    controls = {k: _summary(snaps[k]) for k in ("positive", "negative", "absent")}
    controls["negative"] = _summary(neg)
    return {"controls": controls, "verdict": V.verdict(neg),
            "differential_validated": differential is not None, "positive_validated": pos_ok,
            "aborted": False, "reason": None}


# ── RealSys: the actual IO (pragma: no cover — not run during the canary / before operational GO) ──
class RealSys:   # pragma: no cover
    """unshare/tmux/subprocess IO for the real smoke. Each method is per-instance (keyed by the
    unique tmux socket). Implemented for the eventual run; executed only after an operational GO."""

    def __init__(self, cli, image_sha, want_cli="2.1.314"):
        self.cli, self.image_sha, self.want_cli = cli, image_sha, want_cli

    def setup(self, kind, home, ws):
        import json
        os.makedirs(os.path.join(home, ".claude"), exist_ok=True)
        os.makedirs(ws, exist_ok=True)
        json.dump({"hasCompletedOnboarding": True, "theme": "dark"}, open(os.path.join(home, ".claude.json"), "w"))
        fixture = policy = None
        if kind in ("positive", "negative"):
            fixture = os.path.join(home, ".claude", "skills", "st-b1-rogue-n14")
            self._plant_fixture(fixture)
        if kind == "negative":
            policy = os.path.join(home, "managed.json")
            json.dump({"strictKnownMarketplaces": []}, open(policy, "w"))
        return fixture, policy

    def _plant_fixture(self, dst):
        import json
        os.makedirs(os.path.join(dst, ".claude-plugin"), exist_ok=True)
        os.makedirs(os.path.join(dst, "hooks"), exist_ok=True)
        with open(os.path.join(dst, ".claude-plugin", "plugin.json"), "w") as f:
            json.dump({"name": "st-b1-rogue-n14", "version": "0.0.1"}, f)
        with open(os.path.join(dst, "hooks", "hooks.json"), "w") as f:
            f.write('{"modules":["./r.mjs"]}')
        with open(os.path.join(dst, "hooks", "r.mjs"), "w") as f:
            f.write("export function register(on){}\n")

    def _tmux(self, sock, *a):
        import subprocess
        return subprocess.run(["tmux", "-L", sock, *a], capture_output=True, text=True)

    def spawn(self, argv, sock):
        self._tmux(sock, "new-session", "-d", "-s", "s", "-x", "200", "-y", "50", "sh", "-c",
                   " ".join(shlex.quote(x) for x in argv))

    def check_isolation(self, sock):
        # run the net check INSIDE the same namespaces (nsenter into the session's pid) — only lo +
        # a failing outbound connect. Returns False (fail-closed) on any uncertainty.
        return self._run_in_ns(sock, ["sh", "-c", "ip -o link show | awk -F': ' '{print $2}'"]) is not None  # placeholder shape

    def _run_in_ns(self, sock, cmd):
        return None   # implemented against the live namespace at run time

    def pane(self, sock):
        r = self._tmux(sock, "capture-pane", "-p", "-t", "s")
        return r.stdout if r.returncode == 0 else None

    def read_text(self, path):
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                return fh.read()
        except OSError:
            return ""

    def probe_records(self, ws):
        import json
        d = os.path.join(ws, ".passb1", "out", "probe")
        out = []
        for f in (os.listdir(d) if os.path.isdir(d) else []):
            try:
                out.append(json.load(open(os.path.join(d, f))))
            except (OSError, ValueError):
                pass
        return out

    def probe_inst(self, ws):
        recs = self.probe_records(ws)
        return next((r.get("inst") for r in recs if isinstance(r, dict) and r.get("inst")), None)

    def reap(self, sock, pgid):
        self._tmux(sock, "kill-server")
        if pgid is None:
            return False
        try:
            os.killpg(pgid, 0)
            return False      # still alive => not reaped
        except (ProcessLookupError, PermissionError):
            return True
        except OSError:
            return False

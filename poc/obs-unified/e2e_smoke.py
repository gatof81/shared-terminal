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


# An INDEPENDENT copy of the kit's ROGUE_REGISTER (poc/passb1/b1.py@8eafe1a is NOT imported or
# modified): the fixture registers a session.start hook that writes a marker when it RUNS, so the
# positive control exhibits the real attack (loads AND executes), not an empty register().
# Rendered to match the kit's rogue_plugin("st-b1-rogue-n14") EXACTLY (module `register.mjs`, marker
# `st-b1-rogue-n14.json`) — E3 equivalence, verified against b1.ROGUE_REGISTER in the tests.
N14_NAME = "st-b1-rogue-n14"
ROGUE_REGISTER = ('// PASS-B1a rogue mod: if this code runs, the path that loaded it is NOT blocked.\n'
                  '// It writes one marker naming itself and does nothing else.\n'
                  'export function register(on) {\n'
                  '\ton("session.start", async ($, e, next) => {\n'
                  f'\t\tawait $.fs.write(".passb1/out/marker/{N14_NAME}.json", `${{JSON.stringify({{ marker: "{N14_NAME}", t: Date.now() }})}}\\n`);\n'
                  '\t\treturn next(e);\n'
                  '\t});\n'
                  '}\n')


# ── pure helpers (testable without a CLI) ──
def isolation_argv(cli, home, ws, debug, *, policy_path=None):
    """Launch the CLI inside user+net+pid namespaces. Blocker 1: it does NOT write `$$` (that is the
    PID-ns-local PID 1, not a host PGID) — the host resolves and supervises the process from /proc.
    Blocker 3: it `cd`s to the disposable workspace AND VERIFIES cwd before exec'ing Claude (exit 97
    on mismatch)."""
    env = {"PATH": "/usr/bin:/bin", "HOME": home, "TERM": "xterm-256color", "DISABLE_AUTOUPDATER": "1"}
    if policy_path:
        env["CLAUDE_CODE_MANAGED_SETTINGS_PATH"] = policy_path
    envs = " ".join(f"{k}={shlex.quote(v)}" for k, v in env.items())
    realws = os.path.realpath(ws)
    inner = (f"cd {shlex.quote(ws)} || exit 97; "
             f"[ \"$(pwd -P)\" = {shlex.quote(realws)} ] || exit 97; "
             f"exec env -i {envs} {shlex.quote(cli)} --debug-file {shlex.quote(debug)} "
             f"2> {shlex.quote(os.path.join(ws, 'stderr.txt'))}")
    return ["unshare", "--map-root-user", "--net", "--pid", "--fork", "--mount-proc", "sh", "-c", inner]


# ── Blocker 1: namespace identity (pure, testable) ──
def parse_ns_inode(link):
    """`/proc/<pid>/ns/net` readlink → 'net:[4026531992]' → '4026531992' (or None)."""
    if not link or "[" not in link or "]" not in link:
        return None
    return link[link.index("[") + 1:link.index("]")]


def verify_isolated(host_net, host_pid_ns, tgt_net, tgt_pid_ns):
    """True iff the target is in FRESH net AND pid namespaces (both differ from the host's). Missing
    values ⇒ False (fail-closed)."""
    return all((host_net, host_pid_ns, tgt_net, tgt_pid_ns)) and tgt_net != host_net and tgt_pid_ns != host_pid_ns


def resolve_supervised_pid(pane_pid, procs, host_pid_ns):
    """The UNIQUE host pid under `pane_pid` that lives in a different pid namespace than the host (the
    unshare'd process to supervise). `procs` = {pid: {"ppid":, "pidns":}}. 0 or >1 candidates ⇒ None
    (ambiguous ⇒ no cleanup/signaling with an ambiguous identifier)."""
    # descendants of pane_pid
    children = {}
    for pid, p in procs.items():
        children.setdefault(p.get("ppid"), []).append(pid)
    seen, stack = set(), list(children.get(pane_pid, []))
    while stack:
        pid = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        stack.extend(children.get(pid, []))
    cands = [pid for pid in seen if procs.get(pid, {}).get("pidns") not in (None, host_pid_ns)]
    return cands[0] if len(cands) == 1 else None


def fixture_digest(path):
    """An INDEPENDENT sha256 over the planted fixture directory (sorted rel-path + bytes). The smoke
    hashes the files on disk itself — it never trusts a digest the runner merely asserts (blocker 3)."""
    h = hashlib.sha256()
    for rel in sorted(os.path.relpath(os.path.join(p, f), path)
                      for p, _, fs in os.walk(path) for f in fs):
        with open(os.path.join(path, rel), "rb") as fh:
            h.update(rel.encode() + b"\0" + hashlib.sha256(fh.read()).hexdigest().encode() + b"\n")
    return h.hexdigest()


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


# ── pure, testable decision logic for the REAL IO (so a test verifies the RESULT, not that a stub
#    returned True) ──
def interpret_isolation(link_names, outbound_blocked):
    """D1: isolation holds IFF the instance's net namespace shows ONLY `lo` (and `lo` is present)
    AND an outbound connect was BLOCKED. Empty/None link set, any extra interface, or a successful
    outbound connect ⇒ False (fail-closed)."""
    names = {n.strip() for n in (link_names or []) if n and n.strip()}
    return bool(names) and names == {"lo"} and bool(outbound_blocked)


def supervise_reap(pgid, *, signal_group, group_alive, sleep, term_grace=5.0, kill_grace=3.0, tick=0.2):
    """D2: ACTIVELY terminate the isolated process GROUP and WAIT for its disappearance. SIGTERM, wait
    up to term_grace; if still alive SIGKILL, wait up to kill_grace; reaped IFF the group is gone at
    the end. Operates on the GROUP (never assumes PID == PGID); `group_alive(pgid)->bool` and
    `signal_group(pgid, sig)` are injected. A None pgid (identity unknown) is never 'reaped'."""
    import signal as _sig
    if pgid is None:
        return False
    for sig, grace in ((_sig.SIGTERM, term_grace), (_sig.SIGKILL, kill_grace)):
        try:
            signal_group(pgid, sig)
        except (ProcessLookupError, OSError):
            pass
        waited = 0.0
        while waited < grace:
            if not group_alive(pgid):
                return True
            sleep(tick)
            waited += tick
    return not group_alive(pgid)


def supervised_cleanup(host_pid, *, getpgid, signal_group, group_alive, sleep):
    """E1: establish the process GROUP identity (getpgid) BEFORE any tmux teardown, then actively
    reap that group. A None pid, a gone pid (ProcessLookupError), or a permission error ⇒ we never
    established a group we can signal/verify ⇒ False (never signals an ambiguous identity; a perm
    error is NOT 'terminated'; never queries a PID as if it were a PGID)."""
    if host_pid is None:
        return False
    try:
        pgid = getpgid(host_pid)
    except (ProcessLookupError, PermissionError, OSError):
        return False
    return supervise_reap(pgid, signal_group=signal_group, group_alive=group_alive, sleep=sleep)


def verify_cli(*, get_version, get_sha, want_version="2.1.314", want_sha=None):
    """D4: the CLI must be the pinned version AND (if a sha is pinned) match the binary sha. Any
    probe error or mismatch ⇒ False (fail-closed). Pure over injected probes."""
    try:
        if get_version() != want_version:
            return False
        if want_sha is not None and get_sha() != want_sha:
            return False
    except Exception:
        return False
    return True


def check_controls_consistency(summaries, digests):
    """D5: the three controls must each match expectations before any blocked-low is accepted.
      positive — skills-dir LOADED, not blocked, has a fixture digest;
      negative — skills-dir BLOCKED, not loaded, has a fixture digest;
      absent   — NO skills-dir signal at all, no fixture digest.
    Returns (ok, reason). A contradiction (e.g. negative loaded, absent shows load/block) ⇒ not ok."""
    pos, neg, ab = (set(summaries[k]["skills_dir"]) for k in ("positive", "negative", "absent"))
    if "loaded" not in pos or "blocked" in pos or not digests.get("positive"):
        return False, "positive-not-loaded-without-policy"
    if "blocked" not in neg or "loaded" in neg or not digests.get("negative"):
        return False, "negative-not-blocked-with-policy"
    if ab or digests.get("absent"):
        return False, "absent-shows-skills-dir-activity"
    return True, "ok"


# ── the REAL runner (blockers 1 & 2), IO behind an injectable `sysio` seam ──
def make_runner(sysio, *, cli, scratch, trust_gate, clock, settle_polls=4):
    """Return runner(kind)->{ok, snapshot, instance, digest, reason}. Per-instance isolation+cleanup;
    fail-closed on any isolation/launch/capture/cleanup error (no reinterpretation)."""
    def runner(kind):
        inst = f"{kind}-{secrets.token_hex(3)}"
        sock = f"obs-{inst}"
        home = os.path.join(scratch, inst, "home")
        ws = os.path.join(scratch, inst, "ws")
        debug = os.path.join(ws, "debug.log")
        fixture_dir, policy = sysio.setup(kind, home, ws)        # plant fixture (pos/neg) + policy (neg)
        digest = fixture_digest(fixture_dir) if fixture_dir else None
        o = O.Observer("N14", 1, inst, clock)

        def tick():
            txt = sysio.pane(sock)
            if txt is None:
                return False
            o.from_pane(txt, ok=True)
            # E2: open the critical window at the FIRST successful read — not at Observer init, which
            # (with a real advancing clock) is strictly before any read and would make coverage
            # partial. The first read is right after spawn (pre-trust, so C4's pre-trust decision is
            # still covered); window_close is after the last tick.
            if o.window["open"] is None:
                o.window_open()
            o.from_debug(sysio.read_text(debug))
            o.from_probe_records(sysio.probe_records(ws), start_inst=sysio.probe_inst(ws))
            return True

        def guarded_tick():                                      # B4: a failed capture must invalidate
            if not tick():
                raise _CaptureError()

        spawned, host_pid = False, None
        try:
            argv = isolation_argv(cli, home, ws, debug, policy_path=policy)
            try:
                sysio.spawn(argv, sock)
                spawned = True
            except Exception:
                return {"ok": False, "reason": "spawn-failed", "instance": inst}
            # Blocker 1: resolve the HOST pid of the isolated process and verify it is in fresh
            # net+pid namespaces BEFORE any nsenter/signal. Ambiguous identity ⇒ fail-closed.
            host_pid = sysio.supervised_pid(sock)
            if host_pid is None:
                return {"ok": False, "reason": "identity-ambiguous", "instance": inst}
            if not sysio.check_isolation(host_pid):              # per-instance isolation, by host pid
                return {"ok": False, "reason": "isolation-failed", "instance": inst}
            # D3: capture BEFORE the trust gate (the decision can land pre-trust) and IN PARALLEL with
            # it via on_poll; a capture that fails during trust raises and invalidates the run (B4).
            if not tick():
                return {"ok": False, "reason": "capture-failed", "instance": inst}
            try:
                tg = trust_gate(sysio, sock, host_pid, on_poll=guarded_tick)
            except _CaptureError:
                return {"ok": False, "reason": "capture-failed-during-trust", "instance": inst}
            o.fact("trust", "confirmed" if tg.get("state") == "confirmed" else "aborted")
            for _ in range(settle_polls):
                if not tick():
                    return {"ok": False, "reason": "capture-failed", "instance": inst}
            if digest:
                o.fixture_identity(digest)
            o.window_close()
            snap = o.snapshot()
        finally:
            if spawned:
                # E1: reap the isolated GROUP by verified identity FIRST (while it still exists),
                # THEN tear tmux down. With no identity we never claim a reap (the run already
                # returned identity-ambiguous; the teardown is best-effort, not proof of cleanup).
                reaped = sysio.reap(host_pid) if host_pid is not None else False
                sysio.teardown(sock)
                if host_pid is not None and not reaped:
                    return {"ok": False, "reason": "cleanup-not-reaped", "instance": inst}
        return {"ok": True, "snapshot": snap, "instance": inst, "digest": digest}
    return runner


class _CaptureError(Exception):
    pass


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
    summaries = {k: _summary(snaps[k]) for k in ("positive", "negative", "absent")}
    cons_ok, cons_reason = check_controls_consistency(summaries, digs)   # D5: all three must match
    pos_ok, pos_dig = validate_positive(snaps["positive"])
    differential = None
    if cons_ok and pos_ok and pos_dig and pos_dig == digs.get("positive") == digs.get("negative"):
        differential = build_attribution(snaps["positive"])
    neg = _with_attribution(snaps["negative"], differential) if differential else snaps["negative"]
    controls = dict(summaries)
    controls["negative"] = _summary(neg)
    return {"controls": controls, "verdict": V.verdict(neg),
            "differential_validated": differential is not None, "positive_validated": pos_ok,
            "controls_consistent": cons_ok, "consistency_reason": cons_reason,
            "aborted": False, "reason": None}


# ── RealSys: the actual IO (pragma: no cover — not run during the canary / before operational GO) ──
class RealSys:   # pragma: no cover
    """unshare/tmux/subprocess IO for the real smoke. Each method is per-instance (keyed by the
    unique tmux socket). Implemented for the eventual run; executed only after an operational GO."""

    def __init__(self, cli, want_sha, probe_marketplace, want_cli="2.1.314"):
        self.cli, self.want_sha, self.probe_marketplace, self.want_cli = cli, want_sha, probe_marketplace, want_cli

    def get_version(self):
        import subprocess
        out = subprocess.run([self.cli, "--version"], capture_output=True, text=True).stdout
        return out.split()[0] if out.split() else None

    def get_sha(self):
        resolved = os.path.realpath(self.cli)
        with open(resolved, "rb") as fh:
            h = hashlib.sha256()
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()

    def setup(self, kind, home, ws):
        """Per-control config (D4). ALL controls seat the org PROBE + guard via managed settings that
        declare the probe marketplace (so P0's session.start/probe-org/guard appear); the NEGATIVE
        control ADDS `strictKnownMarketplaces` (without source:skills-dir) to block the fixture;
        POSITIVE omits it (the fixture loads); ABSENT plants no fixture. Applied by the intended
        mechanism: CLAUDE_CODE_MANAGED_SETTINGS_PATH (the returned path)."""
        import json
        os.makedirs(os.path.join(home, ".claude"), exist_ok=True)
        os.makedirs(ws, exist_ok=True)
        with open(os.path.join(home, ".claude.json"), "w") as f:
            json.dump({"hasCompletedOnboarding": True, "theme": "dark"}, f)
        managed = {"extraKnownMarketplaces": {"st-probe": {"source": {"source": "directory", "path": self.probe_marketplace}}},
                   "enabledPlugins": {"st-b1-probe@st-probe": True}}
        if kind == "negative":
            managed["strictKnownMarketplaces"] = []     # blocks any non-org source incl. skills-dir
        policy = os.path.join(home, "managed.json")
        with open(policy, "w") as f:
            json.dump(managed, f)
        fixture = None
        if kind in ("positive", "negative"):
            fixture = os.path.join(home, ".claude", "skills", "st-b1-rogue-n14")
            self._plant_fixture(fixture)
        return fixture, policy

    def _plant_fixture(self, dst):
        import json
        os.makedirs(os.path.join(dst, ".claude-plugin"), exist_ok=True)
        os.makedirs(os.path.join(dst, "hooks"), exist_ok=True)
        with open(os.path.join(dst, ".claude-plugin", "plugin.json"), "w") as f:
            json.dump({"name": "st-b1-rogue-n14", "version": "0.0.1"}, f)
        with open(os.path.join(dst, "hooks", "hooks.json"), "w") as f:
            f.write('{"modules":["./register.mjs"]}')              # E3: same module name as the kit
        with open(os.path.join(dst, "hooks", "register.mjs"), "w") as f:   # real attack copy; marker st-b1-rogue-n14.json
            f.write(ROGUE_REGISTER)

    def _tmux(self, sock, *a):
        import subprocess
        return subprocess.run(["tmux", "-L", sock, *a], capture_output=True, text=True)

    def spawn(self, argv, sock):
        r = self._tmux(sock, "new-session", "-d", "-s", "s", "-x", "200", "-y", "50", "sh", "-c",
                       " ".join(shlex.quote(x) for x in argv))
        if r.returncode != 0:                                 # Blocker 4: tmux result was ignored
            raise RuntimeError(f"tmux new-session failed: {r.stderr.strip()}")

    def _readlink(self, pid, ns):
        try:
            return os.readlink(f"/proc/{pid}/ns/{ns}")
        except OSError:
            return None

    def _ppid(self, pid):
        try:
            with open(f"/proc/{pid}/stat", encoding="utf-8") as fh:
                data = fh.read()
            return int(data[data.rindex(")") + 2:].split()[1])   # field after comm (comm may hold spaces)
        except (OSError, ValueError, IndexError):
            return None

    def supervised_pid(self, sock):
        """Blocker 1: the HOST pid of the isolated process — the UNIQUE descendant of this socket's
        tmux pane pid that lives in a fresh pid namespace — verified to be in fresh net+pid namespaces
        before it is used for nsenter/signals. Ambiguous or non-isolated ⇒ None (fail-closed)."""
        r = self._tmux(sock, "list-panes", "-t", "s", "-F", "#{pane_pid}")
        pane = r.stdout.strip()
        if not pane.isdigit():
            return None
        host_net, host_pidns = (parse_ns_inode(self._readlink("self", n)) for n in ("net", "pid"))
        procs = {}
        for e in os.listdir("/proc"):
            if e.isdigit():
                procs[int(e)] = {"ppid": self._ppid(int(e)), "pidns": parse_ns_inode(self._readlink(int(e), "pid"))}
        cand = resolve_supervised_pid(int(pane), procs, host_pidns)
        if cand is None:
            return None
        tgt_net = parse_ns_inode(self._readlink(cand, "net"))
        if not verify_isolated(host_net, host_pidns, tgt_net, procs[cand]["pidns"]):
            return None
        return cand

    def check_isolation(self, host_pid):
        """D1: a REAL check INSIDE the resolved host pid's net namespace — nsenter, list links and
        attempt an outbound connect — then INTERPRET the result. Any failure ⇒ False (fail-closed)."""
        import subprocess
        links = subprocess.run(["nsenter", "-t", str(host_pid), "-n", "sh", "-c",
                                "ip -o link show | awk -F': ' '{print $2}' | cut -d@ -f1"],
                               capture_output=True, text=True)
        probe = subprocess.run(["nsenter", "-t", str(host_pid), "-n", sys.executable, "-I", "-c",
                                "import socket,sys\ntry: socket.create_connection(('1.1.1.1',53),1); sys.exit(1)\n"
                                "except OSError: sys.exit(0)"], capture_output=True, text=True)
        if links.returncode != 0:
            return False
        return interpret_isolation(links.stdout.split(), probe.returncode == 0)

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

    def _group_alive(self, pgid):
        """True iff ANY process still belongs to pgid (scans /proc — never assumes PID == PGID)."""
        for e in os.listdir("/proc"):
            if not e.isdigit():
                continue
            try:
                if os.getpgid(int(e)) == pgid:
                    return True
            except (ProcessLookupError, PermissionError, OSError):
                continue
        return False

    def reap(self, host_pid):
        """E1/D2: reap the isolated GROUP by verified identity, BEFORE any tmux teardown. Establish
        the pgid via getpgid (never assume PID == PGID; a gone/perm-error pid ⇒ cannot prove ⇒
        False), then supervise_reap SIGTERM→wait→SIGKILL→exit/timeout. Delegates to the pure
        supervised_cleanup()."""
        import time
        return supervised_cleanup(host_pid, getpgid=os.getpgid, signal_group=os.killpg,
                                  group_alive=self._group_alive, sleep=time.sleep)

    def teardown(self, sock):
        """Best-effort tmux teardown — called AFTER reap; not a proof of process cleanup."""
        self._tmux(sock, "kill-server")


# ── real trust-gate wiring + operational entry point (pragma: no cover — not run before GO) ──
def real_trust_gate(sysio, sock, host_pid, on_poll):   # pragma: no cover
    """Drive the corrected trust-gate (poc/inv1-trust) over this instance's tmux socket, feeding the
    Observer on every poll (D3: capture in parallel). `on_poll()` RAISES on a failed capture, which
    propagates out and invalidates the run (B4). Returns the gate result dict."""
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "inv1-trust"))
    import trustgate as TG

    class _IO(TG.IO):
        def pane(self):
            on_poll()                                   # raises _CaptureError on a failed capture
            return sysio.pane(sock) or ""

        def send(self, key):
            sysio._tmux(sock, "send-keys", "-t", "s", key)

        def exited(self):
            try:
                os.kill(host_pid, 0)
                return False
            except ProcessLookupError:
                return True
            except OSError:
                return False

        def now(self):
            import time
            return time.monotonic()

        def sleep(self, s):
            import time
            time.sleep(s)

    return TG.drive_trust(_IO())


def run_smoke(cli, want_sha, probe_marketplace, scratch):   # pragma: no cover
    """Operational entry point: pin+verify the CLI, then run the three controls under RealSys. FAIL-
    CLOSED: a CLI pin/verify failure aborts before anything launches. Executed only after GO."""
    import time
    sysio = RealSys(cli, want_sha, probe_marketplace)
    if not verify_cli(get_version=sysio.get_version, get_sha=sysio.get_sha, want_sha=want_sha):
        return {"aborted": True, "reason": "cli-pin-verify-failed", "controls": {},
                "verdict": ("inconclusive", "cli-pin-verify-failed")}
    runner = make_runner(sysio, cli=cli, scratch=scratch, trust_gate=real_trust_gate, clock=time.monotonic)
    return run_three_controls(runner)

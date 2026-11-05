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
      FROM INITIALIZATION, feeds probe records, derives the critical window from the reads, and
      verifies cleanup. IO sits behind an injectable `sysio` seam so every ERROR PATH is unit-tested
      with a fake; `RealSys` (the actual unshare/tmux/subprocess IO) is `pragma: no cover`.
  (2) PER-INSTANCE isolation + cleanup with STABLE IDENTITY (F1): each control is its own instance
      (unique id, tmux socket, fresh namespaces); the runner captures an OWNER HANDLE (a pidfd to
      the `unshare` process) at spawn, verifies isolation BEFORE capture, and reaps the disposable
      PID namespace by that handle AFTER — never by a pgid (shareable) nor a bare pid (reusable). It
      fails closed (ok:false + reason) on any failure, and accredits cleanup via the owner handle
      even when the inner identity is ambiguous.
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
import signal
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
    on mismatch).

    F1: `--kill-child` makes the `unshare` process the OWNER of the disposable PID namespace — when
    unshare dies for ANY reason (including a SIGKILL it cannot catch) the kernel delivers SIGKILL to
    the namespace init via PR_SET_PDEATHSIG, and a PID-namespace init's death reaps every remaining
    member. The caller holds a stable handle (a pidfd) to this unshare process, so cleanup is a
    single signal to ONE owned process — never a signal to a process GROUP that could be shared with
    host processes, and never keyed on a bare pid number that could be reused."""
    env = {"PATH": "/usr/bin:/bin", "HOME": home, "TERM": "xterm-256color", "DISABLE_AUTOUPDATER": "1"}
    if policy_path:
        env["CLAUDE_CODE_MANAGED_SETTINGS_PATH"] = policy_path
    envs = " ".join(f"{k}={shlex.quote(v)}" for k, v in env.items())
    realws = os.path.realpath(ws)
    inner = (f"cd {shlex.quote(ws)} || exit 97; "
             f"[ \"$(pwd -P)\" = {shlex.quote(realws)} ] || exit 97; "
             f"exec env -i {envs} {shlex.quote(cli)} --debug-file {shlex.quote(debug)} "
             f"2> {shlex.quote(os.path.join(ws, 'stderr.txt'))}")
    return ["unshare", "--map-root-user", "--net", "--pid", "--fork", "--mount-proc", "--kill-child",
            "sh", "-c", inner]


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


def cleanup_by_owner(owner, inner, *, send_signal, exited, sleep, term_grace=5.0, kill_grace=3.0, tick=0.2):
    """F1: reap the disposable isolation unit by a STABLE OWNER HANDLE held across the WHOLE lifecycle
    — never by a pgid (a process group can be shared with host processes) and never by a bare pid
    number (a pid can be reused between discovery and the signal, so `getpgid(pid)` → `killpg` could
    land on an unrelated group — the race this replaces).

    A handle PINS exactly one process for its whole lifetime (in RealSys a pidfd from `pidfd_open`):
      • `send_signal(handle, sig)` signals THAT process and no other — it raises ProcessLookupError
        once the process is gone and can NEVER be redirected onto a reused pid;
      • `exited(handle) -> bool` reports whether THAT exact process has terminated.

    `owner`  — handle to the `unshare` process, captured at SPAWN (so it exists even when the inner
               identity resolution fails). unshare runs `--kill-child`, so killing it reaps the whole
               fresh PID namespace (PDEATHSIG to the init, then init-death reaps every member).
    `inner`  — handle to the namespace INIT, resolved+verified AFTER spawn, or None when identity was
               ambiguous. Used to CONFIRM the namespace emptied; a backstop signal if it somehow did
               not. Its freshness (a PID namespace the host does not share) was proven at discovery
               (`verify_isolated`), which is what makes the unit EXCLUSIVELY the experiment's.

    Reaped IFF the owner has exited AND (no inner handle, or the inner init has also exited). A None
    owner ⇒ False: with no owned handle we do NOT claim termination — closing the tmux socket is not
    proof the isolated process died."""
    if owner is None:
        return False

    def drive(handle):
        # SIGTERM then (if needed) SIGKILL, each followed by a bounded wait on the SAME handle.
        # A ProcessLookupError means the pinned process is already gone (it cannot be a reused pid),
        # so that is a confirmed exit; any other OSError is transient/denied and is NOT read as exit.
        for sig, grace in ((signal.SIGTERM, term_grace), (signal.SIGKILL, kill_grace)):
            try:
                send_signal(handle, sig)
            except ProcessLookupError:
                return True
            except OSError:
                pass
            waited = 0.0
            while waited < grace:
                if exited(handle):
                    return True
                sleep(tick)
                waited += tick
        return exited(handle)

    if not drive(owner):
        return False
    if inner is None:
        return True                      # owner (unshare --kill-child) reaped the namespace
    return exited(inner) or drive(inner)  # confirm the init is gone; backstop-signal it if not


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
            # F2: the critical window is DERIVED from these reads (first→last) — there is no separate
            # window timestamp to open/close. The pre-trust read (the first one, taken right after
            # spawn) is what later lets a pre-trust decision be STRICTLY bracketed; a settle read is
            # the strictly-after bound. coverage() does the bracketing — the runner only reads.
            o.from_pane(txt, ok=True)
            o.from_debug(sysio.read_text(debug))
            o.from_probe_records(sysio.probe_records(ws), start_inst=sysio.probe_inst(ws))
            return True

        def guarded_tick():                                      # B4: a failed capture must invalidate
            if not tick():
                raise _CaptureError()

        owner, inner, result = None, None, None
        try:
            argv = isolation_argv(cli, home, ws, debug, policy_path=policy)
            try:
                owner = sysio.spawn(argv, sock)                 # F1: OWNER handle captured at SPAWN
            except Exception:
                return {"ok": False, "reason": "spawn-failed", "instance": inst}
            # F1: resolve the namespace INIT handle (verified fresh net+pid ns) for capture
            # attribution. Ambiguous ⇒ None, but we STILL hold `owner`, so the finally reaps the
            # disposable namespace by the owner handle regardless — see the cleanup note there.
            inner = sysio.supervised_pid(sock)
            if inner is None:
                result = {"ok": False, "reason": "identity-ambiguous", "instance": inst}
                return result
            if not sysio.check_isolation(inner):                # per-instance isolation, by the handle
                result = {"ok": False, "reason": "isolation-failed", "instance": inst}
                return result
            # D3: capture BEFORE the trust gate (the decision can land pre-trust) and IN PARALLEL with
            # it via on_poll; a capture that fails during trust raises and invalidates the run (B4).
            if not tick():
                result = {"ok": False, "reason": "capture-failed", "instance": inst}
                return result
            try:
                tg = trust_gate(sysio, sock, inner, on_poll=guarded_tick)
            except _CaptureError:
                result = {"ok": False, "reason": "capture-failed-during-trust", "instance": inst}
                return result
            o.fact("trust", "confirmed" if tg.get("state") == "confirmed" else "aborted")
            for _ in range(settle_polls):
                if not tick():
                    result = {"ok": False, "reason": "capture-failed", "instance": inst}
                    return result
            if digest:
                o.fixture_identity(digest)
            result = {"ok": True, "snapshot": o.snapshot(), "instance": inst, "digest": digest}
            return result
        finally:
            if owner is not None:
                # F1: reap the disposable PID namespace by the STABLE OWNER HANDLE (never a pgid,
                # never a bare pid), THEN tear tmux down. This runs on EVERY exit path that got as far
                # as a spawn — including identity-ambiguous: even with no verified inner handle, the
                # owner handle (unshare --kill-child) tears the namespace down, so cleanup is still
                # accredited (reported as `cleanup_accredited`); tmux teardown is never the proof.
                reaped = sysio.reap(owner, inner)
                sysio.teardown(sock)
                if inner is None:
                    if result is not None:                       # identity-ambiguous (not an exception)
                        result["cleanup_accredited"] = reaped
                        return result
                elif not reaped:
                    return {"ok": False, "reason": "cleanup-not-reaped", "instance": inst}
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

    def _open_handle(self, pid):
        """F1: a STABLE handle to `pid` — a pidfd (os.pidfd_open) plus the pid for diagnostics. The
        pidfd refers to THAT process for its whole lifetime; a signal through it raises
        ProcessLookupError once it is gone and can never be redirected onto a reused pid."""
        return {"pid": pid, "pidfd": os.pidfd_open(pid)}

    def spawn(self, argv, sock):
        """F1: start the instance and return the OWNER HANDLE — a pidfd to the `unshare` process. The
        pane runs `exec unshare …`, so the pane pid IS the unshare, which owns the fresh PID namespace
        and (via `--kill-child`, see isolation_argv) reaps it when killed. Capturing this handle at
        SPAWN is what guarantees cleanup even when the later inner-identity resolution fails."""
        cmd = "exec " + " ".join(shlex.quote(x) for x in argv)
        r = self._tmux(sock, "new-session", "-d", "-s", "s", "-x", "200", "-y", "50", "sh", "-c", cmd)
        if r.returncode != 0:                                 # Blocker 4: tmux result was ignored
            raise RuntimeError(f"tmux new-session failed: {r.stderr.strip()}")
        p = self._tmux(sock, "list-panes", "-t", "s", "-F", "#{pane_pid}")
        pane = p.stdout.strip()
        if not pane.isdigit():
            raise RuntimeError("could not resolve the unshare (pane) pid to own")
        return self._open_handle(int(pane))                   # OWNER handle: the unshare process

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
        """Blocker 1/F1: the INNER handle — a pidfd to the namespace INIT, the UNIQUE descendant of
        this socket's tmux pane pid that lives in a fresh pid namespace, verified to be in fresh
        net+pid namespaces (which is what proves the unit is EXCLUSIVELY the experiment's) before the
        handle is opened. Ambiguous or non-isolated ⇒ None (fail-closed); the owner handle from
        spawn still reaps the namespace in that case."""
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
        return self._open_handle(cand)                        # INNER handle: the namespace init

    def check_isolation(self, inner):
        """D1: a REAL check INSIDE the resolved init's net namespace — nsenter, list links and attempt
        an outbound connect — then INTERPRET the result. Any failure ⇒ False (fail-closed)."""
        import subprocess
        host_pid = inner["pid"]
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

    def _pidfd_signal(self, handle, sig):
        """Signal the EXACT process the handle pins (pidfd) — never a pid number, never a group.
        Raises ProcessLookupError once that process is gone (it can't hit a reused pid)."""
        signal.pidfd_send_signal(handle["pidfd"], sig)

    def _pidfd_exited(self, handle):
        """True iff the pinned process has terminated: a pidfd becomes readable on process exit."""
        import select
        return bool(select.select([handle["pidfd"]], [], [], 0)[0])

    def reap(self, owner, inner):
        """F1: reap the disposable PID namespace by the STABLE OWNER HANDLE (the unshare pidfd) —
        SIGTERM→wait→SIGKILL→wait on the owned process (which `--kill-child`-reaps the namespace),
        then confirm the init exited. NEVER a pgid, never a bare pid, so no PID-reuse race and no
        signal to a possibly-shared group. Closes the pidfds afterwards."""
        import time
        try:
            return cleanup_by_owner(owner, inner, send_signal=self._pidfd_signal,
                                    exited=self._pidfd_exited, sleep=time.sleep)
        finally:
            for h in (owner, inner):
                if h is not None:
                    try:
                        os.close(h["pidfd"])
                    except OSError:
                        pass

    def teardown(self, sock):
        """Best-effort tmux teardown — called AFTER reap; not a proof of process cleanup."""
        self._tmux(sock, "kill-server")


# ── real trust-gate wiring + operational entry point (pragma: no cover — not run before GO) ──
def real_trust_gate(sysio, sock, inner, on_poll):   # pragma: no cover
    """Drive the corrected trust-gate (poc/inv1-trust) over this instance's tmux socket, feeding the
    Observer on every poll (D3: capture in parallel). `on_poll()` RAISES on a failed capture, which
    propagates out and invalidates the run (B4). Returns the gate result dict. Liveness is read from
    the INNER handle's pidfd (stable identity), not a bare pid (F1)."""
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "inv1-trust"))
    import trustgate as TG

    class _IO(TG.IO):
        def pane(self):
            on_poll()                                   # raises _CaptureError on a failed capture
            return sysio.pane(sock) or ""

        def send(self, key):
            sysio._tmux(sock, "send-keys", "-t", "s", key)

        def exited(self):
            import select
            return bool(select.select([inner["pidfd"]], [], [], 0)[0])

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

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
      (unique id, fresh namespaces); the runner acquires the OWNER ATOMICALLY at creation — `spawn`
      CREATES and HOLDS the `unshare` leader as a `subprocess.Popen` child (no post-launch pid lookup,
      so no reuse race), verifies isolation, reaps the disposable PID namespace by that held handle
      (never a pgid, never a bare pid), and ACCREDITS cleanup only when the namespace is VERIFIED
      empty (owner exit alone is not enough). It fails closed on any failure, a partial launch
      self-cleans inside spawn, teardown always runs even if reap raises, and every result carries
      `cleanup_accredited`.
  (3) INDEPENDENT validation of the positive control: the orchestrator does not trust the runner's
      claim — it re-validates the positive snapshot (authority+correlation), confirms a REAL
      skills-dir:loaded, and requires the fixture digest (an INDEPENDENT sha256 of the planted dir,
      returned per instance) to match between positive and negative. Absent any of these, the
      differential is None and N14 stays INCONCLUSIVE. `blocked-low` is the MAX for a pane attribution.
"""
import hashlib
import os
import re
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
    member. The caller launches this `unshare` as its OWN child (a held `subprocess.Popen`), so
    cleanup is a single signal to ONE owned process via its handle — never a signal to a process GROUP
    that could be shared with host processes, and never keyed on a bare pid number that could be
    reused — and the namespace's emptiness is then verified independently before cleanup is credited."""
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


def ns_is_empty(target_ns_inode, pid_ns_inodes, *, unverifiable=0):
    """F1/P1-4: the disposable PID namespace is empty IFF (a) its inode is known, (b) NO live process
    carries it, AND (c) EVERY relevant process could be inspected. `target_ns_inode` is the namespace
    the owner created (captured from the owner at creation, never a descendant lookup);
    `pid_ns_inodes` are the pid-ns inodes we COULD read now; `unverifiable` counts live processes
    whose pid-ns we could NOT read (present-but-unreadable). Any unverifiable process could be in the
    namespace, so a positive 'empty' is NEVER credited while `unverifiable > 0` (fail-closed). An
    unknown target (None) ⇒ False for the same reason. A process that has EXITED is not unverifiable
    (it is gone, not unknown) — that distinction is `scan_proc_pidns`'s job."""
    if not target_ns_inode:
        return False
    if target_ns_inode in set(pid_ns_inodes):
        return False
    return unverifiable == 0


def scan_proc_pidns(pids, read_inode, still_present):
    """P1-4: classify the pid-namespace of every live process for the emptiness check. `read_inode`
    (pid)->inode|None; `still_present(pid)->bool`. Returns (inodes, unverifiable): a readable inode is
    collected; a None inode for a process that is STILL PRESENT is UNVERIFIABLE (we could not inspect
    a relevant process ⇒ fail-closed); a None inode for a process no longer present is skipped (it
    exited — gone, not unknown)."""
    inodes, unverifiable = [], 0
    for pid in pids:
        ino = read_inode(pid)
        if ino is not None:
            inodes.append(ino)
        elif still_present(pid):
            unverifiable += 1
    return inodes, unverifiable


def poll_ns_ready(*, sample, alive, now, sleep, timeout=10.0, interval=0.05):
    """P0-3: wait for the owner's namespaces to be READY — present AND fresh — with a BOUNDED timeout
    and NO arbitrary sleep (re-sample on a fixed interval until ready or deadline). `sample()` returns
    `(host_net, host_pid, owner_net, owner_pid_for_children)`; a sample is ready when `verify_isolated`
    holds (both namespaces present and differing from the host — identity verification, closing the
    race with `unshare` initialisation). `alive()` is owner liveness. Returns the ready sample; raises
    (fail-closed) if the owner dies first or the deadline passes."""
    deadline = now() + timeout
    while True:
        if not alive():
            raise RuntimeError("owner exited during namespace readiness")
        s = sample()
        if verify_isolated(*s):
            return s
        if now() >= deadline:
            raise RuntimeError("namespace readiness timed out")
        sleep(interval)


# P0-1: the trust-gate sends KEY NAMES ("Down","Enter"); a PTY needs the REAL terminal byte
# sequences. An explicit, bounded allowlist — a named key never travels as its literal text.
_KEY_BYTES = {
    "Enter": b"\r", "Return": b"\r", "Tab": b"\t", "Space": b" ", "Escape": b"\x1b", "Esc": b"\x1b",
    "BSpace": b"\x7f", "Backspace": b"\x7f",
    "Up": b"\x1b[A", "Down": b"\x1b[B", "Right": b"\x1b[C", "Left": b"\x1b[D",
    "Home": b"\x1b[H", "End": b"\x1b[F", "PageUp": b"\x1b[5~", "PageDown": b"\x1b[6~",
}


def key_to_bytes(key):
    """P0-1: translate a trust-gate key NAME into real terminal bytes. A named key uses the allowlist;
    a single printable character passes through as its UTF-8 bytes; anything else raises (bounded — we
    never write a literal like "Down" into the PTY as text, which the kit's blind driver effectively
    did)."""
    if key in _KEY_BYTES:
        return _KEY_BYTES[key]
    if isinstance(key, str) and len(key) == 1 and key.isprintable():
        return key.encode()
    raise ValueError(f"unmapped key: {key!r}")


class ScreenState:
    """P0-2: a minimal, BOUNDED terminal screen model so a read reflects the CURRENT frame (what
    `tmux capture-pane -p` shows) — NOT an accumulating history where a dismissed dialog lingers and
    corrupts `pointer_option` / stability / disappearance detection. It interprets the escape subset a
    TUI uses to redraw in place: cursor positioning (CUP/CUU/CUD/CUF/CUB/CHA/VPA), erase in display/
    line (ED/EL), and CR/LF/BS/TAB; SGR (colour) and anything unrecognised are ignored. The grid is a
    fixed size, so malformed input can never grow it (bounded)."""

    _CSI = re.compile(r"\x1b\[([0-9;?]*)([ -/]*)([@-~])")
    _ESC2 = re.compile(r"\x1b[@-Z\\-_]")

    def __init__(self, rows=50, cols=200):
        self.rows, self.cols = rows, cols
        self.grid = [[" "] * cols for _ in range(rows)]
        self.r = self.c = 0
        self._buf = b""

    def _put(self, ch):
        self.r = max(0, min(self.r, self.rows - 1))
        self.c = max(0, min(self.c, self.cols - 1))
        self.grid[self.r][self.c] = ch
        self.c = min(self.c + 1, self.cols - 1)       # clamp at the right margin (no auto-scroll)

    def _newline(self):
        self.r += 1
        if self.r >= self.rows:
            self.grid.pop(0)
            self.grid.append([" "] * self.cols)
            self.r = self.rows - 1

    def _erase_line(self, mode):
        self.r = max(0, min(self.r, self.rows - 1))
        row = self.grid[self.r]
        if mode == 1:
            rng = range(0, min(self.c + 1, self.cols))
        elif mode == 2:
            rng = range(self.cols)
        else:
            rng = range(self.c, self.cols)
        for i in rng:
            row[i] = " "

    def _erase_display(self, mode):
        if mode in (2, 3):
            self.grid = [[" "] * self.cols for _ in range(self.rows)]
        elif mode == 1:
            self._erase_line(1)
            for rr in range(0, self.r):
                self.grid[rr] = [" "] * self.cols
        else:
            self._erase_line(0)
            for rr in range(self.r + 1, self.rows):
                self.grid[rr] = [" "] * self.cols

    def _csi(self, params, final):
        nums = [int(p) for p in params.split(";") if p.isdigit()]
        n0 = nums[0] if nums else 0
        if final in "Hf":
            self.r = (nums[0] - 1) if nums and nums[0] > 0 else 0
            self.c = (nums[1] - 1) if len(nums) >= 2 and nums[1] > 0 else 0
        elif final == "A":
            self.r -= max(1, n0)
        elif final == "B":
            self.r += max(1, n0)
        elif final == "C":
            self.c += max(1, n0)
        elif final == "D":
            self.c -= max(1, n0)
        elif final == "G":
            self.c = max(0, n0 - 1)
        elif final == "d":
            self.r = max(0, n0 - 1)
        elif final == "J":
            self._erase_display(n0)
        elif final == "K":
            self._erase_line(n0)
        # m (SGR), private modes (?…), and anything else: ignored
        self.r = max(0, min(self.r, self.rows - 1))
        self.c = max(0, min(self.c, self.cols - 1))

    def feed(self, data):
        """Process raw PTY bytes (bytes or str). An incomplete trailing escape is held across calls."""
        if isinstance(data, str):
            data = data.encode("utf-8", "replace")
        self._buf += data
        s = self._buf.decode("utf-8", "replace")
        i, n, consumed = 0, len(s), 0
        while i < n:
            ch = s[i]
            if ch == "\x1b":
                m = self._CSI.match(s, i)
                if m:
                    self._csi(m.group(1), m.group(3))
                    i = m.end()
                elif self._ESC2.match(s, i):
                    i += 2
                else:
                    break                               # incomplete escape — wait for more bytes
            elif ch == "\r":
                self.c = 0
                i += 1
            elif ch == "\n":
                self._newline()
                i += 1
            elif ch == "\b":
                self.c = max(0, self.c - 1)
                i += 1
            elif ch == "\t":
                self.c = min(self.cols - 1, (self.c // 8 + 1) * 8)
                i += 1
            elif ch < " ":
                i += 1                                  # drop other C0 control chars
            else:
                self._put(ch)
                i += 1
            consumed = i
        self._buf = s[consumed:].encode("utf-8", "replace")

    def render(self):
        """The CURRENT visible screen as text, with trailing blank cells/rows trimmed."""
        lines = ["".join(row).rstrip() for row in self.grid]
        while lines and not lines[-1]:
            lines.pop()
        return "\n".join(lines)


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


def cleanup_by_owner(owner, *, signal_owner, owner_exited, namespace_empty, sleep,
                     term_grace=5.0, kill_grace=3.0, verify_grace=3.0, tick=0.2):
    """F1: reap the disposable PID namespace through a HELD OWNER HANDLE — a child process WE created
    and own (in RealSys a `subprocess.Popen`), identified from the instant of creation. We never use
    a pgid (a group can be shared with host processes) and never a bare pid looked up after the fact
    (a pid can be reused between a lookup and the signal — the race this design removes): the kernel
    will not recycle an owned child's pid until we reap it, so the handle is an unambiguous identity.

      • `signal_owner(sig)` signals EXACTLY that held child (e.g. `proc.send_signal`); it raises
        ProcessLookupError once the child is gone and can never be redirected onto a reused pid.
      • `owner_exited() -> bool` reports whether that exact child has terminated (e.g. `proc.poll`).
      • `namespace_empty() -> bool` INDEPENDENTLY verifies the disposable PID namespace has no process
        left (e.g. a /proc scan for its ns inode, captured from the owner at creation). It is the
        accreditation of cleanup — see below.

    Steps: SIGTERM the owner, wait up to term_grace; if still alive SIGKILL, wait up to kill_grace.
    The owner's death triggers `--kill-child` (SIGKILL to the ns init via PR_SET_PDEATHSIG) and the
    kernel reaps the whole namespace. Then — CRUCIALLY — cleanup is accredited ONLY when
    `namespace_empty()` is verified true: the owner having exited is NECESSARY but NOT sufficient (its
    children could, in principle, outlive it), so we never credit termination of the namespace from
    the owner's exit alone. A None owner, an owner that never dies, or a namespace that cannot be
    verified empty (incl. an unknown/unreadable ns identity) ⇒ False (fail-closed)."""
    if owner is None:
        return False

    def wait_gone(grace):
        waited = 0.0
        while waited < grace:
            if owner_exited():
                return True
            sleep(tick)
            waited += tick
        return owner_exited()

    gone = False
    for sig, grace in ((signal.SIGTERM, term_grace), (signal.SIGKILL, kill_grace)):
        try:
            signal_owner(sig)
        except ProcessLookupError:
            gone = True                  # the held child is already gone (never a reused pid)
            break
        except OSError:
            pass                         # transient/denied — NOT read as exit
        if wait_gone(grace):
            gone = True
            break
    if not gone:
        return False
    # Owner exit is necessary, NOT sufficient: prove the namespace actually emptied before crediting.
    waited = 0.0
    while waited < verify_grace:
        if namespace_empty():
            return True
        sleep(tick)
        waited += tick
    return namespace_empty()


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


# ── the REAL runner, IO behind an injectable `sysio` seam ──
def make_runner(sysio, *, cli, scratch, trust_gate, clock, settle_polls=4):
    """Return runner(kind)->{ok, snapshot, instance, digest, reason, cleanup_accredited}. Per-instance
    isolation + cleanup; fail-closed on any launch/isolation/capture/cleanup error, and — F1 — the
    owner handle is acquired ATOMICALLY from `spawn` (a held child, no post-launch pid lookup). Every
    path that got as far as a spawn reaps the owner AND tears down (even if reap raises), and every
    result carries `cleanup_accredited` so no cleanup information is lost."""
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

        owner, result = None, None
        try:
            argv = isolation_argv(cli, home, ws, debug, policy_path=policy)
            # F1: ACQUIRE the owner ATOMICALLY — `spawn` CREATES and HOLDS the child (a Popen), so the
            # handle exists from creation with no later pid lookup. Contract: it returns a held handle
            # or raises leaving NOTHING running (a partial launch must self-clean inside spawn). So a
            # spawn failure needs no reap here — there is no orphan.
            try:
                owner = sysio.spawn(argv, sock)
            except Exception:
                return {"ok": False, "reason": "spawn-failed", "instance": inst,
                        "cleanup_accredited": True}             # nothing was left running
            if not sysio.check_isolation(owner):
                result = {"ok": False, "reason": "isolation-failed", "instance": inst}
                return result
            # D3: capture BEFORE the trust gate (the decision can land pre-trust) and IN PARALLEL with
            # it via on_poll; a capture that fails during trust raises and invalidates the run (B4).
            if not tick():
                result = {"ok": False, "reason": "capture-failed", "instance": inst}
                return result
            try:
                tg = trust_gate(sysio, sock, owner, on_poll=guarded_tick)
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
        except Exception as exc:
            # Point 3: an UNEXPECTED error ends as aborted/INCONCLUSIVE — never a silent pass — and the
            # finally below still reaps+tears down and records cleanup status on this result.
            result = {"ok": False, "reason": f"unexpected:{type(exc).__name__}", "instance": inst}
            return result
        finally:
            if owner is not None:
                # F1 cleanup, always: reap the held owner by its handle (never a pgid/bare pid), and
                # ALWAYS tear down even if reap raises (point 2); a reap exception ⇒ not accredited
                # (point 1 — a safe, recorded cleanup outcome), teardown still runs.
                try:
                    reaped = sysio.reap(owner)
                except Exception:
                    reaped = False
                finally:
                    try:
                        sysio.teardown(sock)
                    except Exception:
                        pass
                if result is None:                              # defensive: no result object was set
                    result = {"ok": False, "reason": "unexpected", "instance": inst}
                result["cleanup_accredited"] = reaped           # never lose the cleanup outcome
                if result.get("ok") and not reaped:             # a clean run whose namespace is unproven
                    result = {"ok": False, "reason": "cleanup-not-reaped", "instance": inst,
                              "cleanup_accredited": False}
                return result
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
    """unshare/PTY/subprocess IO for the real smoke. The OWNER of each instance is a `subprocess.Popen`
    child held from creation (F1) — not a tmux pane looked up afterward — so identity is unambiguous
    and reuse-proof. Per-instance state is keyed by `sock` in `self._inst`. Implemented for the
    eventual run; executed only after an operational GO."""

    def __init__(self, cli, want_sha, probe_marketplace, want_cli="2.1.314"):
        self.cli, self.want_sha, self.probe_marketplace, self.want_cli = cli, want_sha, probe_marketplace, want_cli
        self._inst = {}        # sock -> owner handle {proc, master, ns_pid, ns_net, host_net, host_pid, screen}

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

    def _readlink(self, pid, ns):
        try:
            return os.readlink(f"/proc/{pid}/ns/{ns}")
        except OSError:
            return None

    def spawn(self, argv, sock):
        """F1: CREATE and HOLD the owner ATOMICALLY. We start `argv` (the `unshare` leader) as OUR OWN
        child via `subprocess.Popen` on a PTY (`start_new_session` ⇒ its own session/pgroup). The
        Popen object IS the owner handle from the instant of creation: the kernel will not recycle its
        pid until we reap it (`proc.wait`), so there is NO post-launch pid lookup and NO reuse race.
        From the owner we capture (AFTER a bounded readiness wait — P0-3) the inode of the PID
        namespace it creates (`/proc/<pid>/ns/pid_for_children`) and its (immediate) net ns — the
        identity used later to VERIFY the namespace emptied, again without any descendant lookup. All
        of `pty.openpty`, `Popen`, the readiness wait, and teardown are guarded so descriptors are
        always closed and nothing is left running without a handle (point 1); no cleanup is asserted
        that cannot be demonstrated."""
        import pty
        import subprocess
        import time
        master = slave = proc = None
        try:
            master, slave = pty.openpty()
            proc = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=slave,
                                    start_new_session=True, close_fds=True)
            os.close(slave)
            slave = None
            host_net, host_pid = (parse_ns_inode(self._readlink("self", n)) for n in ("net", "pid"))
            # P0-3: explicit, bounded readiness — `unshare` sets up the namespaces asynchronously after
            # Popen returns, so we POLL (no arbitrary sleep) until the owner's net + pid_for_children
            # inodes are present AND fresh, re-checking the owner is still alive. Timeout/owner-death
            # ⇒ raise (handled below). This replaces reading the inodes immediately (the race).
            _h, _hp, ns_net, ns_pid = poll_ns_ready(
                sample=lambda: (host_net, host_pid,
                                parse_ns_inode(self._readlink(proc.pid, "net")),
                                parse_ns_inode(self._readlink(proc.pid, "pid_for_children"))),
                alive=lambda: proc.poll() is None, now=time.monotonic, sleep=time.sleep)
            handle = {"proc": proc, "master": master, "ns_pid": ns_pid, "ns_net": ns_net,
                      "host_net": host_net, "host_pid": host_pid, "screen": ScreenState()}
            self._inst[sock] = handle
            master = None                               # ownership moved to the handle
            return handle
        except BaseException:
            # point 1: a failure AT OR AFTER launch must never leave an unowned process — reap the held
            # child (if any) and close every descriptor we still hold. We assert no cleanup we cannot
            # demonstrate: the child is killed+waited, the fds are closed, and we re-raise.
            if proc is not None:
                try:
                    proc.kill()
                except OSError:
                    pass
                try:
                    proc.wait(timeout=5)
                except Exception:
                    pass
            for fd in (slave, master):
                if fd is not None:
                    try:
                        os.close(fd)
                    except OSError:
                        pass
            raise

    def check_isolation(self, owner):
        """D1: `--net` is immediate, so the OWNER (unshare) is itself in the fresh net ns. Verify both
        its net ns and its `pid_for_children` ns are fresh (`verify_isolated`), then nsenter INTO the
        owner's net ns to confirm only `lo` + a failing outbound connect. Any failure ⇒ False."""
        import subprocess
        if not verify_isolated(owner["host_net"], owner["host_pid"], owner["ns_net"], owner["ns_pid"]):
            return False
        pid = owner["proc"].pid
        links = subprocess.run(["nsenter", "-t", str(pid), "-n", "sh", "-c",
                                "ip -o link show | awk -F': ' '{print $2}' | cut -d@ -f1"],
                               capture_output=True, text=True)
        probe = subprocess.run(["nsenter", "-t", str(pid), "-n", sys.executable, "-I", "-c",
                                "import socket,sys\ntry: socket.create_connection(('1.1.1.1',53),1); sys.exit(1)\n"
                                "except OSError: sys.exit(0)"], capture_output=True, text=True)
        if links.returncode != 0:
            return False
        return interpret_isolation(links.stdout.split(), probe.returncode == 0)

    def pane(self, sock):
        """P0-2: feed the owned PTY's new bytes into the instance's ScreenState and return the CURRENT
        rendered frame (what `tmux capture-pane -p` would show) — not an accumulating history where a
        dismissed dialog would linger and fool `pointer_option`/stability/disappearance. A read error
        ⇒ None (fail closed)."""
        import select
        h = self._inst.get(sock)
        if h is None:
            return None
        try:
            while select.select([h["master"]], [], [], 0)[0]:
                chunk = os.read(h["master"], 65536)
                if not chunk:
                    break
                h["screen"].feed(chunk)
        except OSError:
            return None
        return h["screen"].render()

    def _send(self, sock, key):
        """P0-1: translate the key NAME to real terminal bytes before writing to the PTY (never the
        literal text)."""
        h = self._inst.get(sock)
        if h is not None:
            os.write(h["master"], key_to_bytes(key))

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

    def _owner_signal(self, owner, sig):
        """Signal the HELD child by its handle (`proc.send_signal`) — never a pid number, never a
        group. Once the child is gone this raises ProcessLookupError (it can't hit a reused pid)."""
        owner["proc"].send_signal(sig)

    def _owner_exited(self, owner):
        return owner["proc"].poll() is not None     # poll() reaps the zombie — the pid is freed for no one

    def _namespace_empty(self, owner):
        """INDEPENDENTLY verify the disposable PID namespace emptied (points 4 + P1-4): NO live process
        carries its inode AND every relevant process could be inspected. Keyed on the inode captured
        from the OWNER at creation (never a descendant lookup). `scan_proc_pidns` separates a process
        we could not read while it is STILL PRESENT (unverifiable ⇒ fail closed) from one that has
        since EXITED (gone ⇒ skipped); an unknown target inode ⇒ False."""
        pids = [e for e in os.listdir("/proc") if e.isdigit()]
        inodes, unverifiable = scan_proc_pidns(
            pids,
            read_inode=lambda p: parse_ns_inode(self._readlink(int(p), "pid")),
            still_present=lambda p: os.path.exists(f"/proc/{p}"))
        return ns_is_empty(owner.get("ns_pid"), inodes, unverifiable=unverifiable)

    def reap(self, owner):
        """F1: reap by the HELD owner handle — SIGTERM→wait→SIGKILL→wait on the owned child (its death
        `--kill-child`-reaps the namespace), then ACCREDIT only when the namespace is VERIFIED empty
        (never from the owner's exit alone — point 4). Reaps the zombie (`proc.wait`) and closes the
        PTY. Never a pgid, never a bare pid."""
        import time
        try:
            return cleanup_by_owner(owner, signal_owner=lambda s: self._owner_signal(owner, s),
                                    owner_exited=lambda: self._owner_exited(owner),
                                    namespace_empty=lambda: self._namespace_empty(owner),
                                    sleep=time.sleep)
        finally:
            try:
                owner["proc"].wait(timeout=5)       # ensure the zombie is reaped (frees the pid)
            except Exception:
                pass
            try:
                os.close(owner["master"])
            except OSError:
                pass

    def teardown(self, sock):
        """Best-effort per-instance teardown (drop our reference, close the PTY if still open); safe to
        call even if reap raised. NOT a proof of cleanup — that is reap's namespace_empty check."""
        h = self._inst.pop(sock, None)
        if h is not None:
            try:
                os.close(h["master"])
            except OSError:
                pass


# ── real trust-gate wiring + operational entry point (pragma: no cover — not run before GO) ──
def real_trust_gate(sysio, sock, owner, on_poll):   # pragma: no cover
    """Drive the corrected trust-gate (poc/inv1-trust) over this instance's owned PTY, feeding the
    Observer on every poll (D3: capture in parallel). `on_poll()` RAISES on a failed capture, which
    propagates out and invalidates the run (B4). Returns the gate result dict. Liveness is read from
    the HELD owner (proc.poll), not a bare pid (F1)."""
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "inv1-trust"))
    import trustgate as TG

    class _IO(TG.IO):
        def pane(self):
            on_poll()                                   # raises _CaptureError on a failed capture
            return sysio.pane(sock) or ""

        def send(self, key):
            sysio._send(sock, key)

        def exited(self):
            return sysio._owner_exited(owner)

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

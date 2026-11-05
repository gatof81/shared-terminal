# Unified observability prototype (pane → enum) — DISPOSABLE, not the audited kit

Investigation #2 follow-up (owner GO 2026-11-05). A throwaway prototype that records the CLI's
security DECISIONS — trust, N14 (`skills-dir`), N17-project — as sanitized structured facts, so the
POC can credit *blocked* outcomes that 2.1.314 reports only to the UI/telemetry (see
`docs/design/project-chat/inv2-n14-skillsdir.md`). **It is NOT part of `poc/passb1` (SHA `8eafe1a`):
it does not import or modify the audited kit, and is never run on VM100.** No security criteria are
changed; nothing here can produce a PASS.

## Design (owner req 1–2, 7)

Three layers, deliberately separate:

- **Capture** — polls the transient pane and reads the `--debug-file`. It never persists raw text.
  Every failed/empty pane read degrades `coverage` (`full` → `partial` → `none`).
- **Classify** (`observer.py`, pure) — turns text into enum facts: `classify_debug` (HIGH
  confidence: the CLI's own `[DEBUG]` lines — controls + attacker LOAD) and `classify_pane` (LOW
  confidence: the pane `yvn` skills-dir block, the n17p refusal — attacker-writable).
- **Verdict** (`verdict.py`, separate) — applies the per-control criteria. **The observer never
  decides PASS/FAIL.**

**Event schema** (`obs/1`): `{schema, attempt, start, instance, concern, signal, source,
confidence, detail, t, coverage}`. `detail` carries only a `path_kind` (`claude-skills`/`other`),
never the path. **Correlation:** one `Observer` per `(attempt, start, instance)`; a verdict judges a
single snapshot, so a signal from another start can never validate a block (req 2).

**Confidence:** `debug`/`gate` = HIGH (CLI's own structured output / our driver); `pane` = LOW
(attacker-writable). A pane `blocked` is credited only when the same start shows **no attacker
load** (had the rogue run it would be FAIL; not having run, it could not forge the block text), the
path is `claude-skills`, **and** a separate attribution control is present — otherwise INCONCLUSIVE
(req 4/6).

**Audit-review fixes (owner B1–B6), all with regression/adversarial tests:**
- **B1** — guard: the positive seating regex no longer matches `not seated`; the NEGATIVE state
  (`guard-not-seated`) takes precedence, so a not-seated guard can never validate.
- **B2** — `session.start` comes ONLY from the probe's EXECUTION records (`from_probe_records`),
  never from the `events: session.start` DECLARATION on the load line.
- **B3** — see N14 above: `block-observed-low` is split from `block-attributable`; pane text alone
  is never `blocked`.
- **B4** — `coverage` is TEMPORAL: `full` needs enough successful reads over a long-enough window,
  no oversized gap, AND observation continued PAST the last pane decision; otherwise `partial`.
  Late/incomplete capture ⇒ INCONCLUSIVE.
- **B5** — `verdict()` first `validate_snapshot()`: any event whose `(attempt,start,instance)` ≠ the
  snapshot's, or with an unknown source/concern or empty signal, is rejected ⇒ INCONCLUSIVE.
- **B6** — `from_debug()` advances a cursor over complete lines and dedups by identity, so re-reading
  the whole file never re-emits; the first event's time/provenance is preserved.

**Round-2 audit fixes (owner B1–B5), reproduced-then-fixed, all tested:**
- **B1** — `verdict_p0` invalidates on ANY `guard-not-seated` in the start, even if a
  `guard-seated-loaded` appeared earlier (incremental, contradictory reads) — the negative wins.
- **B2** — `validate_snapshot` enforces an AUTHORITY MATRIX (below): each `(concern, signal)` is
  valid only from its proper `(source, confidence)`. A pane event can never prove `session.start`,
  a valid guard, trust, or N14 attribution; unknown/contradictory combinations are rejected.
- **B3** — `from_probe_records` emits `session.start` only for the EXPECTED probe whose `inst` is
  THIS start's; arbitrary records, wrong probe, or missing/other `inst` are ignored (declaration ≠
  execution preserved). `start_inst` is required.
- **B4** — `block-attributable` is credited only with a verified `fixture` AND a `differential`
  (proof the SAME fixture loads without policy); a bare declared event is not enough. Coverage is
  derived from the ACTUAL reads (F2): the critical window is `[first read, last read]`, `full` needs
  no oversized gap and every pane DECISION STRICTLY bracketed (a read before AND after it) — late/
  incomplete ⇒ never blocked-low.
- **B5** — `from_debug` detects truncation/replacement/rotation (cursor shrink or consumed-prefix
  change) and sets `debug_continuity=False`, degrading coverage and making `verdict_p0`
  INCONCLUSIVE instead of reusing stale evidence.

### Signal & authority matrix (B2)

| concern / signal | legitimate source | confidence | meaning |
| --- | --- | --- | --- |
| control / session.start, classic.SessionStart | **probe** (execution record, correct probe + this start's `inst`) | high | the hook RAN |
| control / session.start, classic.SessionStart | **probe** | high | the hook RAN (BOTH required for P0, C1) |
| control / probe-org-tier | **debug** | high | probe loaded in prepend/append |
| control / guard-seated · guard-loaded | **debug** | high | atomic sub-facts; P0 needs both (C3) |
| control / guard-not-seated | **debug** | high | guard NOT seated (invalidates P0, any order) |
| trust / confirmed, aborted | **gate** | high | our trust-gate result |
| skills-dir / loaded | **debug** | high | rogue executed ⇒ FAIL |
| skills-dir / blocked | **pane** | low | the `yvn` block line (attacker-writable) |
| skills-dir / fixture | **control** | high | this run's N14 fixture identity (digest) |
| skills-dir / block-attributable | **control** | high | verified fixture + digest-bound differential |
| mcp-project / selection=…, dismissed=…, identified, accept-signal, started | **gate** | high | driver facts |
| mcp-project / refusal | **pane** | low | n17p policy refusal line |

Any event outside this matrix, or whose `(attempt,start,instance)` differs from the snapshot, is
rejected by `validate_snapshot` ⇒ the verdict is INCONCLUSIVE.

**HEAD-specific fixes (owner C1–C4), reproduced-then-fixed, all tested:**
- **C1** — `verdict_p0` now requires `classic.SessionStart` in `need` (it is a GLOBAL control in
  `analyze_b1a@8eafe1a`; not relaxed). `session.start` alone is never `baseline-ok`.
- **C2** — `block-attributable` is credited only when its `differential` is a dict naming the
  positive-control run (`control_run`, `control_loaded: true`) whose `fixture_digest` EQUALS the
  digest THIS run independently recorded via `observer.fixture_identity`. A bare driver assertion,
  or a digest about a different fixture, stays INCONCLUSIVE.
- **C3** — guard is accumulated from ATOMIC sub-facts (`guard-seated`, `guard-loaded`) that may
  arrive in different debug fragments; `verdict_p0` needs both, and a later `guard-not-seated` still
  invalidates (B1) — contradictions never yield a false positive.
- **C4** — the skills-dir block (`cli_plugin_init` / `yvn`) sits in a plugin-init path and a pre-trust
  `cli_plugin_init` path exists, so we do NOT assume it fires only after trust. Under F2 this is
  enforced by evidence: crediting `full` requires a read STRICTLY BEFORE the decision (so we prove we
  were already observing when it was taken) AND one strictly after; a block already present on our
  very first poll is not demonstrable ⇒ partial ⇒ INCONCLUSIVE.

## Per-control behaviour

- **Trust (req 3):** reuses the corrected trust-gate (verify `yes` immediately before Enter). The
  observer records `trust:confirmed` as a fact, but `verdict_p0` requires `confirmed` **AND**
  `session.start` **AND** `probe-org-tier` **AND** `guard-seated-loaded` in the same start — trust
  alone is `baseline-invalid`. Confirming trust is **not** a valid P0.
- **N14 (req 4 / B3):** `skills-dir:loaded` ⇒ **FAIL** (high, any coverage). A pane
  `skills-dir:blocked` is only `block-observed-low` — it becomes **`blocked-low`** solely with full
  coverage, baseline-ok, `path_kind=claude-skills`, no load **AND** a separate
  **`block-attributable`** control (verified fixture + a differential proving THIS fixture loads
  without policy). **Pane text alone never grants blocked.** No load and no observable rejection ⇒
  INCONCLUSIVE (absence ≠ blocked); a generic marketplace block (no `source:skills-dir` advice) is
  not attributed.
- **N17-project (req 5):** identity, selection, dialog-close and accept-signal are recorded as
  **independent** facts. `selection=approve` + `dismissed=running` + **no** accept-signal ⇒
  `selected-no-signal` ⇒ **INCONCLUSIVE** (never blocked). `started` ⇒ FAIL.

### N17-project → the four causal conditions (design only; not executed)

The observer's independent facts are exactly what the §1.14.19-D3 causal experiment needs; it does
not run anything:

| Condition (D3) | Facts the observer records | What it would show |
| --- | --- | --- |
| C1 no-policy + approve | `selection=approve`, `dismissed=running`, `started` | approval ⇒ execution (baseline) |
| C2 no-policy + decline | `selection=decline`, no `started` | decline ⇒ no execution |
| C3 policy + decline | `selection=decline`, `refusal?` (+ `t`) | does the n17p refusal appear WITHOUT approval? |
| C4 policy + approve | `selection=approve`, `dismissed`, `refusal` (+ `t`) | is the refusal AFTER the approval action? |

Causality (Option B) would be creditable only if C4 shows the refusal strictly after the approve
action AND C3 shows none — a verdict-layer rule to add **only** if a future isolated run demonstrates
it. Until then N17-project stays Option A (INCONCLUSIVE).

## Evidence matrix — what is missing to credit each control

| Control | "blocked"/valid needs | Captured today | MISSING |
| --- | --- | --- | --- |
| P0 / trust | confirmed + session.start + probe-org + guard, same start | all (gate + debug) | nothing new — needs the reliable trust-gate (inv #1); P0's run-2 failure was the drive, not evidence |
| N14 | same-start control + attributable skills-dir block + no load | load = debug (yes); **block = pane only** | a **correlated pane→enum capture of the block** (this prototype) — and acceptance that pane is low-confidence (mitigated by no-load corroboration). The HIGH-integrity signal (`cli_plugin_init=policy_blocked` telemetry) is **not locally capturable** |
| N17-project | confirmed approval + no start + attributable refusal (Option A), OR the C3/C4 causal chain (Option B) | selection/dismissed/identity/refusal all capturable as facts | a **verifiable accept signal** (2.1.314 emits none ⇒ Option A stays INCONCLUSIVE); Option B needs the 4-condition run **under the real root drop-in policy** |

## Local results (pure simulated; no CLI)

`python3 test_obs_unified.py` → **158 passed** (incl. closing round: ?2026 synchronized output fail-closed, ED 3 = scrollback only, per-control `cleanup_accredited` in `run_three_controls`, preflight logic — 6/6 targeted mutations killed; RealSys round-4 R3-1…R3-4: alternate screen / invalidation / OSC / UTF-8 split / PTY geometry+ctty via a throwaway child / spawn stage accreditation — 10/10 targeted mutations killed; RealSys round-3: **P0-1** key_to_bytes
name→bytes/unmapped-raises; **P0-2** ScreenState current-frame + dismissed-dialog-gone + the real
`pointer_option` on the frame; **P0-3** poll_ns_ready ready/after-N/owner-death/timeout; **P1-4**
scan_proc_pidns + ns_is_empty unverifiable-fail-closed; RealSys over real pipes + injected /proc) ·
(round-2: B1 guard precedence on incremental
contradictory reads; B2 authority matrix — pane cannot prove session.start/guard/trust/attribution,
unknown signal & foreign ctx rejected, legitimate combos pass; B3 probe identity — arbitrary/wrong
probe/wrong inst/missing inst rejected, correct accepted; B4 attribution needs fixture+differential;
**F2 read-derived coverage** — no-reads ⇒ none, benign reads ⇒ full, gap / decision-at-first-read /
decision-at-last-read / failed-read ⇒ partial, full only when a read strictly brackets the decision,
plus advancing-clock regressions (time after the decision with no read ⇒ partial) and a pre-trust
decision needing a strictly-earlier read; **F1 cleanup-by-owner** — SIGTERM-only / SIGKILL-escalation
/ never-dies / already-gone / perm-error / **owner-exit-but-namespace-not-empty ⇒ NOT reaped** /
unverifiable-namespace / signals-held-owner-not-pid, plus runner routes (owner acquired atomically
from spawn then reaped; reap-raises still tears down + aborts cleanup-not-reaped; teardown-raises
swallowed; unexpected-error ⇒ aborted/INCONCLUSIVE with cleanup info; spawn-failure leaves nothing);
B5
truncation/replacement degrade continuity ⇒ P0 inconclusive, append keeps continuity; plus the
retained round-1 cases and smoke-cleanup mocks). Earlier run (round 1) was **36 passed**: B1/B2 regressions (not-seated ≠ valid guard;
`events:` declaration ≠ session.start; session.start needs an execution record); classifiers
(controls/load, no session.start from debug, pane block path_kind, generic block not attributed, no
raw text); **B4 temporal coverage** (single/too-few/short-window/large-gap/failed-read ⇒ partial,
all-failed ⇒ none, observed-through-decision ⇒ full); P0 (trust-alone invalid, not-seated
invalidates, full ok); **B3 N14** (loaded ⇒ FAIL even degraded; block without attribution ⇒
inconclusive; attributed+full ⇒ blocked-low; insufficient capture ⇒ inconclusive; forged block +
real load ⇒ FAIL; no-signal ⇒ inconclusive); N17 (selected-no-signal ⇒ inconclusive, started ⇒
FAIL); **B5 correlation** (foreign attempt/start/instance, unknown source, unknown concern ⇒
inconclusive; cross-start cannot leak); **B6 incremental** (re-read whole file ⇒ no re-emit,
original time kept; appended line ⇒ exactly one new event); smoke cleanup mocked (`_read_pgid`,
`_group_is_ours` reused-group guard, `_cleanup` signals only our live group). `smoke.py` **not run**
(canary).

## Residual risks (classified)

- **HIGH — pane integrity.** A pane `blocked` is LOW-confidence (attacker-writable). Mitigated by
  same-start no-load corroboration + `path_kind` + a required attribution control, but NOT
  cryptographic. The only HIGH-integrity block signal (telemetry `cli_plugin_init=policy_blocked`)
  is **not locally capturable** → N14 `blocked` can only ever be `blocked-low`.
- **MEDIUM — attribution strength (B3).** `block-attributable` depends on a differential control
  (same fixture loads without policy). If that control is weak/absent, N14 stays INCONCLUSIVE — no
  silent downgrade, but it means "blocked" needs an extra experiment to earn.
- **MEDIUM — capture completeness (B4).** Lost polls / UI redraw / resize ⇒ `partial`/`none` ⇒
  INCONCLUSIVE. Intentional (never PASS on flaky capture) but means real captures can be discarded.
- **MEDIUM — smoke process hygiene (B/owner #8).** Reused-pgid guard reduces but does not eliminate
  the risk; if the CLI never writes its PGID the detached child can ORPHAN. **Absolute absence of
  orphans is not promised.** No network isolation.
- **LOW — TOCTOU/timing** inherited from the trust-gate: narrowed, not eliminated.
- **LOW — not adopted.** Experimental only; integrating into the kit is a separate audited decision
  and does not by itself resolve N14/N17-project — it makes their *blocked* evidence observable,
  which is necessary but not sufficient.

## Isolated smoke — IMPLEMENTED, not run (`e2e_smoke.py`; needs explicit operational GO)

`smoke.py` stays the launch+cleanup skeleton; **`e2e_smoke.py`** is the end-to-end orchestrator +
the REAL runner — implemented, **unit-tested with fakes, and run NOTHING real** until a GO. Three
blockers from the last review are now code, not stubs:
- **(1) real end-to-end runner** `make_runner(sysio,…)` + `RealSys` (the actual unshare/PTY IO,
  `pragma: no cover`): per control it plants fixture/policy, launches under isolation, wires the
  trust-gate into the Observer, captures pane+debug from init, feeds probe records, derives the
  critical window from the reads, and reaps. The `sysio` seam makes every ERROR PATH testable.
- **(2) per-instance isolation + cleanup with STABLE IDENTITY (F1)**: each control is its own instance
  (unique id, fresh namespaces); the runner ACQUIRES the owner ATOMICALLY — `spawn` CREATES and HOLDS
  the `unshare` leader as a `subprocess.Popen` child (no post-launch pid lookup ⇒ no reuse race),
  verifies isolation BEFORE capture, reaps the disposable PID namespace by that held handle AFTER
  (never a pgid, never a bare pid), and ACCREDITS cleanup only when the namespace is VERIFIED empty
  (owner exit alone is not enough). It fails closed (`ok:false` + reason), a partial launch self-cleans
  inside spawn, teardown always runs even if reap raises, and every result carries
  `cleanup_accredited`.
- **(3) independent positive validation**: the orchestrator re-validates the positive snapshot
  (`validate_positive`: authority + correlation + a REAL skills-dir:loaded) and requires the fixture
  digest — an INDEPENDENT `fixture_digest()` sha256 of the planted dir, returned per instance — to
  match between positive and negative. Otherwise the differential is None ⇒ INCONCLUSIVE.

**Three controls, differentiated output** (`run_three_controls`): `positive` (fixture, no policy ⇒
`skills-dir:loaded`), `negative` (fixture + policy ⇒ pane `skills-dir:blocked`, no load), `absent`
(no fixture ⇒ no skills-dir signal). The result's `controls` block reports each separately.

**C2 — validated differential from REAL evidence:** `build_attribution(positive_snapshot)` derives
the differential ONLY from the positive control's own `skills-dir:loaded` event bound to the fixture
`digest`; a driver-declared flag is gone. The negative run is credited `blocked-low` only when that
differential exists AND its digest equals the negative run's own recorded fixture digest (same
fixture bytes in both controls). No real positive load, or a digest mismatch ⇒ INCONCLUSIVE.

**Isolation + supervision (F1):** `isolation_argv` builds `unshare --map-root-user --net --pid --fork
--mount-proc --kill-child …` (fresh net ns = only `lo`; fresh pid ns, CLI as PID 1; `--kill-child`
makes the `unshare` the namespace owner). `RealSys.spawn` CREATES and HOLDS that `unshare` as our own
`subprocess.Popen` child on a PTY — the held handle is the owner from creation, no pane_pid lookup —
and captures, from the owner, the PID-namespace inode (`/proc/<pid>/ns/pid_for_children`).
`reap(owner)` = `cleanup_by_owner` — SIGTERM→wait→SIGKILL→wait on the held child (`proc.send_signal`
/ `proc.poll`, which `--kill-child`-reaps the namespace), then ACCREDITS cleanup only when a /proc
scan confirms NO process still carries that ns inode. **Never a pgid, never a bare pid ⇒ no reuse
race, no signal to a shared group; owner-exit alone never credits cleanup.** **Fail-closed:** any
isolation / capture / cleanup failure ⇒ `aborted:true`, verdict INCONCLUSIVE, controls empty.

The pieces still owner-required for the REAL run are wired by the (not-run) real runner:

**Isolation (network + process), verifiably, without root or touching PASS-B1 containers:** run the
CLI under `unshare -rn --pid --fork --mount-proc <...>`:
- `-n` → a fresh NETWORK namespace with only `lo`: verifiable by `ip -o link` showing just
  `loopback` inside, and an outbound probe failing. HOME isolation alone is explicitly insufficient.
- `-r` → map to a user namespace so `-n/--pid` need no root.
- `--pid --fork --mount-proc --kill-child` → the CLI is PID 1 of a fresh PID namespace, owned by the
  `unshare` WE hold as our own child (a `subprocess.Popen`, from creation — not a pane looked up
  later). Cleanup signals that HELD child by its handle — not a pid number, not a pgid; `--kill-child`
  (PR_SET_PDEATHSIG) then SIGKILLs the ns init, whose death reaps the whole namespace, and we then
  VERIFY emptiness by a /proc scan for the ns inode — **unambiguous identity from creation, immune to
  pid reuse, never a shared group, no `pkill -f`, no orphans, no credit from owner-exit alone**. If a
  tool needs a container instead, use a **throwaway** `--network none`
  container built from the pinned image, labelled distinctly, removed on exit — **never** the
  retained PASS-B1 containers or real sessions. (No container is created now.)

**Setup:** disposable HOME+workspace; CLI pinned to **2.1.314** and verified by `--version` AND the
image/binary sha before launch (fail-closed on mismatch); the **trust-gate** (`poc/inv1-trust`)
wired into the `Observer` (its result → `fact("trust", …)`); the **N14 fixture**
(`~/.claude/skills/st-b1-rogue-n14`) and managed **policy** (`strictKnownMarketplaces` without
`source:skills-dir`) configured.

**Controls (distinguish load vs block vs no-discovery):**
- **positive/no-policy** — same fixture, no policy ⇒ expect `skills-dir:loaded` (and it supplies the
  **differential** backing `block-attributable`);
- **negative/policy** — fixture + policy ⇒ expect pane `skills-dir:blocked`, no load;
- **absent** — no fixture ⇒ no skills-dir signal at all.

**Observer wiring:** poll the pane (→ `from_pane`) from the pre-trust tick through the settle ticks,
read the debug tail (→ `from_debug`), feed probe records with the verified `inst` (→
`from_probe_records`); emit sanitized enums only. The critical window is DERIVED from those reads
(F2) and a decision is credited only when strictly bracketed by them. **Fail-closed** on any launch
error, timeout, coverage `partial/none`, or lost continuity ⇒ INCONCLUSIVE.

### GO / NO-GO criteria for executing the smoke (objective)

**GO only if ALL hold:** (1) `unshare -rn` available and the in-namespace network check shows only
`lo` + a failing outbound probe; (2) CLI `--version` == 2.1.314 AND binary sha matches the pin;
(3) disposable HOME/workspace under a scratch dir, never `~/.claude` or `WORKSPACE_ROOT`; (4) no
PASS-B1 container is created/started/modified and none is needed; (5) cleanup verified to reap the
PID namespace (post-run: the leader and children gone); (6) the three controls are wired so the run
can tell load/block/absent apart.

**NO-GO (do not run / abort) if ANY:** network isolation unverifiable; CLI/sha mismatch; `unshare`
or `--mount-proc` unavailable (⇒ propose the throwaway `--network none` container instead, still
gated); any step would touch a retained container or a real session; cleanup identity not
verifiable. A NO-GO on isolation/identity keeps N14 at **INCONCLUSIVE** — we do not relax it.

Only after a clean smoke showing (positive ⇒ loaded) and (negative ⇒ blocked + no load +
`coverage:full`) would a verdict-layer rule for N14 `blocked` be worth proposing — never before, and
the N17-project C3/C4 causal rule stays out of scope here.


## RealSys blockers — mock-verified vs. needs-real-validation (owner D1–D5)

The real IO logic is now in PURE, mocked-tested functions (a test never trusts a stub returning
True); the actual kernel/CLI behaviour still needs a real run to confirm.

| Path | Verified now with mocks/simulated | Still needs REAL validation (a run) |
| --- | --- | --- |
| **D1 isolation + identity** | `interpret_isolation`; **owner-keyed identity**: `parse_ns_inode`, `verify_isolated` (owner's net ns + `pid_for_children` ns both fresh), `ns_is_empty` (no live proc carries the ns inode; unknown ⇒ False); no descendant lookup | that `nsenter` into the OWNER's net ns really yields only `lo` + failing outbound on the host |
| **F1 reap (was D2)** | `cleanup_by_owner`: SIGTERM→wait→SIGKILL→wait on a HELD OWNER HANDLE (a Popen child), `owner_exited` via `proc.poll`; accredits ONLY when `namespace_empty` is verified true (owner-exit alone insufficient — point 4); never-dies/None-owner/unverifiable-ns ⇒ False; signals the held child only (no pgid, no bare pid ⇒ no reuse race, no shared group) | that `proc.send_signal`+`--kill-child` + the /proc ns scan actually reap the `--pid` namespace on the host |
| **(1) runner + RealSys IO** | error paths spawn/isolation/capture/cleanup; trust-aborted recorded not crash; happy ⇒ snapshot+digest; **P0-1 `key_to_bytes`, P0-2 `ScreenState` current-frame, P0-3 `poll_ns_ready`, P1-4 `scan_proc_pidns`/`ns_is_empty`, and `RealSys._send`/`pane`/`_namespace_empty` over real pipes + injected /proc** | the real `unshare`+PTY launch, and whether the CLI's TUI escapes are all covered by the bounded `ScreenState` subset |
| **(2) per-instance** | unique inst/namespaces; owner acquired atomically at spawn (held Popen); isolation-before + owner-reap-after per instance; reap-raises still tears down; unexpected ⇒ aborted; fail-closed via runner | that namespaces are truly per-instance and don't leak between controls on the host |
| **(3) independent positive** | `validate_positive` (authority + real `skills-dir:loaded`); `fixture_digest` independent + content-sensitive; digest cross-check pos==neg | that the positive control (no policy) actually LOADS the fixture on 2.1.314 |
| **D3 pre-trust capture** | capture tick ordered BEFORE `trust_gate`; the pre-trust read is the strictly-before bound, so a decision caught only later is bracketed; a decision already present on the first poll ⇒ partial (F2) | that a real pre-trust skills-dir decision is caught by the parallel loop with a read strictly before it |
| **D4 e2e config** | `verify_cli` (version + sha, fail-closed); orchestrator entry wiring | that `CLAUDE_CODE_MANAGED_SETTINGS_PATH` really seats the probe/guard AND that `strictKnownMarketplaces` ENFORCES skills-dir (OPEN since inv2 §4-bis / D3) |
| **D5 consistency** | `check_controls_consistency`: positive loaded-not-blocked, negative blocked-not-loaded, absent empty; contradiction ⇒ inconclusive | that the three real runs actually produce loaded / blocked / none as expected |

The single biggest open real question remains whether `strictKnownMarketplaces` enforces the
skills-dir block via the managed-settings mechanism available locally — the smoke is designed to
answer it, under the GO/NO-GO above. Until a real run passes all rows, N14 stays INCONCLUSIVE and
`blocked-low` is the ceiling.

### Production-wiring blockers (latest review) — status
- **B1 namespace identity** (critical): isolation_argv no longer writes `$$` (PID-ns-local). Under F1
  the identity now comes from the HELD owner (a Popen child), not a /proc descendant lookup; the owner's
  net ns and `pid_for_children` ns are verified fresh (`verify_isolated`). Mock-tested; real nsenter/ns
  scan still needs a run.
- **B2 clock scale** (critical): the window scale issue is subsumed by **F2** — there are no window
  timestamps any more; coverage is derived from the read timestamps directly. The non-zero-monotonic-
  start regression still passes. Fully mock-verified.
- **B3 fixture + cwd**: the fixture now installs the real attack (session.start hook + marker,
  independent copy of the kit's ROGUE_REGISTER; 8eafe1a untouched); isolation_argv `cd`s to the
  disposable ws and VERIFIES cwd (`pwd -P`, exit 97). Mock-tested; the actual LOAD under 2.1.314 needs a run.
- **B4 silent failures**: a capture that fails during trust raises and invalidates the run
  (`capture-failed-during-trust`); `RealSys.spawn` fails closed (readiness timeout / owner death) and
  self-cleans the held child + fds before raising. Mock-tested.

### Review E1–E3 — CLOSED
- **E1 cleanup/identity** — superseded by **F1** below (the pgid/getpgid reap is replaced by a stable
  owner handle). **E2 critical window** — superseded by **F2** (the window is now derived from reads,
  no `window_open/close`). **E3 fixture equivalence** — CLOSED: the disposable copy uses `register.mjs`
  + marker `st-b1-rogue-n14.json`, byte-for-byte equal to the kit's `ROGUE_REGISTER` for
  st-b1-rogue-n14 (asserted in-test against `poc/passb1/b1.py`; 8eafe1a untouched).

### Review F1 — status (rounds 2 & 3; F2 accepted)
- **F1 rounds 1–2 (owner acquisition):** round 1 opened a pidfd on a `pane_pid` looked up AFTER launch
  (launched-but-unowned window + reuse race); round 2 fixed it — `spawn` CREATES and HOLDS the
  `unshare` leader as OUR OWN `subprocess.Popen` child. The Popen IS the owner from the instant of
  creation (no post-launch pid lookup; the kernel won't recycle the pid until `proc.wait`), so identity
  is demonstrable and reuse-proof. `cleanup_by_owner(owner, …)` signals the held child
  (`proc.send_signal` — never a pgid, never a bare pid); `--kill-child` (PR_SET_PDEATHSIG) reaps the
  namespace on the owner's death. **Point 4 — no credit from owner-exit alone:** cleanup is accredited
  ONLY when the namespace is VERIFIED empty, never from the owner having exited.
- **F1 round 3 (RealSys correctness, owner P0-1…P1-4):**
  - **P0-1 PTY key control** — `_send` no longer writes the literal strings `"Down"`/`"Enter"`; a
    bounded, allowlisted `key_to_bytes` translates key NAMES to real terminal byte sequences
    (`Down`→`ESC[B`, `Enter`→`CR`, …), a single printable char passes through, anything else raises.
  - **P0-2 screen state** — `pane()` no longer returns an ANSI-stripped accumulating history (where a
    dismissed dialog lingered and corrupted `pointer_option`/stability/disappearance). A bounded
    `ScreenState` VT model (CUP/ED/EL/cursor-moves/CR/LF/BS, SGR ignored) renders the CURRENT frame, as
    `tmux capture-pane -p` would.
  - **P0-3 namespace readiness** — `spawn` no longer reads `pid_for_children`/`net` immediately after
    `Popen` (a race with `unshare` init). `poll_ns_ready` waits — bounded timeout, NO arbitrary sleep —
    until both inodes are present AND fresh (identity verified), failing closed on owner death/timeout.
  - **P1-4 /proc exhaustiveness** — `_namespace_empty` no longer treats a failed `_readlink` as "not in
    the namespace". `scan_proc_pidns` separates a process that is present-but-UNREADABLE (⇒
    `unverifiable`) from one that has EXITED (⇒ skipped); `ns_is_empty(..., unverifiable=n)` refuses to
    credit emptiness while `unverifiable > 0`.
  - **fd/error hardening** — `pty.openpty`/`Popen`/`kill`/`wait` are guarded; descriptors are always
    closed (spawn self-cleans the held child + fds on any failure; reap waits the zombie + closes the
    PTY; teardown is safe even after a reap exception) and no cleanup is asserted that isn't verified.
  - **Deterministic RealSys tests (not just FakeSys):** `key_to_bytes` (named/printable/unmapped);
    `ScreenState` (CR-overwrite, cursor-home overwrite, **dismissed dialog does not persist**, erase-to-
    EOL, split-escape held across feeds, bounded grid, and the real `trustgate.pointer_option` reading
    the rendered frame); `poll_ns_ready` (ready-now / ready-after-N-polls / owner-death / timeout);
    `scan_proc_pidns`+`ns_is_empty` (unverifiable-blocks-credit, exited-vs-unreadable); and `RealSys`
    itself over real OS pipes (`_send` emits `ESC[B CR`; `pane` returns the current frame and the old
    dialog is gone; a read error ⇒ None) and injected `/proc` (`_namespace_empty` fail-closed).
  - Still pragma/unrun for the real kernel paths: real `unshare`+PTY launch, `nsenter` isolation, and
    `--kill-child`/ns-scan reap on the host.
- **F1 round 4 (owner R3-1…R3-4 on 0a24b98; P0-1/P0-3/P1-4 closed by the owner):**
  - **R3-1 alternate screen / fail-closed frame** — `ScreenState` models `CSI ?1049/?1047/?47 h|l`
    (separate primary/alternate buffers; leaving restores the primary exactly), so a trust dialog on one
    buffer is never readable from the other. Any sequence with a visual effect it does not model
    (IL/DL/DCH/ICH/ECH/SU/SD, scroll regions, insert mode, unknown private modes or escapes, malformed
    CSI) INVALIDATES the buffer; `frame()` is None (⇒ `pane()` None ⇒ the run fails closed) until both
    cells AND cursor are re-established absolutely (ED 2/3 + CUP, RIS, or a buffer switch). OSC/DCS/APC/
    PM strings (window titles) are consumed, never painted; DECSC/DECRC, IND/NEL/RI handled; non-visual
    modes (cursor visibility, bracketed paste, sync output, mouse/focus, keyboard protocol, queries) keep
    the frame valid.
  - **R3-2 PTY initialisation** — `open_owned_pty_child` sets TIOCSWINSZ to `PTY_ROWS×PTY_COLS` (the same
    constants `ScreenState` uses) before the child starts, and makes the PTY the child's CONTROLLING TTY
    (TIOCSCTTY in `preexec_fn`, which CPython runs after `start_new_session`'s setsid). Verified with a
    throwaway Python child: size = requested, `/dev/tty` opens, child is session leader and foreground
    pgrp, and the Popen is waitable (our own child). A bare openpty reproduced the reported 0×0 / no
    `/dev/tty`.
  - **R3-3 spawn cleanup accreditation** — `SpawnError(stage, owner)`: `before-launch` (no child ever
    existed, fds closed) is the only case reported clean; `after-launch` carries the held (partial)
    handle and spawn no longer kills+swallows — the runner reaps it by that handle and the accreditation
    is whatever `reap` verifies (a partial handle has no namespace identity ⇒ never accredited); a spawn
    error that does not state its stage ⇒ `cleanup_accredited: false`.
  - **R3-4 incremental UTF-8** — an incremental decoder reassembles a multibyte char split across reads
    (e.g. `❯` over three feeds), never U+FFFD.
- **F2 real temporal window** (high) — **ACCEPTED by the owner (unchanged):** `window_open()/window_close()` are GONE. They sampled `clock()`
  AFTER `from_pane`, so with a real advancing clock the last read sat before `window_close` (⇒
  partial) and only sub-ms rounding faked a `full` — without demonstrating observation before the
  decision. Coverage is now DERIVED from the actual reads: window = `[first read, last read]`, and
  `full` requires every pane DECISION STRICTLY bracketed (a read at t<d AND a read at t>d). The strict
  bracket is the guarantee — a read before the decision proves we were already observing when it was
  taken; a decision at/before the first read (observed too late) or at/after the last read ⇒ partial ⇒
  INCONCLUSIVE. Regressions advance the clock specifically between reads and around the decision (incl.
  time passing after the decision with NO further read ⇒ partial, and before the first read ⇒ partial).
  Fully mock-verified.

### Closing F1 round (owner review of e34845a) — status
- **CSI ?2026 synchronized output** is no longer treated as non-visual: between `?2026h` and `?2026l`
  the grid holds an update the terminal has NOT presented, so `ScreenState.frame()` is None and
  `RealSys.pane()` waits at most `sync_wait` (0.5 s) for the end of the update, else returns None. The
  trust-gate therefore gets `""` and `revalidate_before_enter` never says `ok` off an intermediate frame.
- **CSI 3J** erases the scrollback only (xterm): the visible grid is untouched, and it never
  re-establishes the cells of an invalid frame (only ED 2 does).
- **`run_three_controls`** keeps `cleanup_accredited` per control (`true`/`false`/`null`, booleans only)
  on every return, aborts included.
- **`preflight_infra.py`** — infrastructure preflight WITHOUT Claude (throwaway Python payload):
  spawn → ns readiness → check_isolation → PTY frame → reap/namespace verification, JSON of booleans.
  It REFUSES inside a Shared Terminal session or container. Not executed on a disposable host yet:
  on the authoring host it refused (`shared-terminal-session`).
- **Isolation limits detected (read-only, on the authoring host):** `apparmor_restrict_unprivileged_userns=1`
  (Ubuntu 24.04 default) — unprivileged `unshare --map-root-user` is expected to be blocked unless an
  AppArmor profile allows it or the run is root, in which case spawn/readiness fails closed
  (INCONCLUSIVE); and `ip` (iproute2) is absent — `check_isolation` then returns False (fail closed).
  The disposable host must have iproute2 and permit user namespaces.


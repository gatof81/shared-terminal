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
  delimited by the attempt's CRITICAL WINDOW (`window_open`/`window_close`): `full` needs reads
  bracketing it, no oversized gap, and the decision inside it — late/incomplete ⇒ never blocked-low.
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
- **C4** — the critical window opens at **initialization**, not at trust-confirmed. Static check: the
  skills-dir block (`cli_plugin_init` / `yvn`) sits in a plugin-init path and a pre-trust
  `cli_plugin_init` path exists, so we do NOT assume it fires only after trust; coverage must span
  init → control close (a decision at init is inside the window).

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

`python3 test_obs_unified.py` → **94 passed** (round-2: B1 guard precedence on incremental
contradictory reads; B2 authority matrix — pane cannot prove session.start/guard/trust/attribution,
unknown signal & foreign ctx rejected, legitimate combos pass; B3 probe identity — arbitrary/wrong
probe/wrong inst/missing inst rejected, correct accepted; B4 attribution needs fixture+differential,
critical-window coverage — window-not-delimited / not-before-open / gap / decision-outside /
failed-read ⇒ partial, full only when observed through the decision, insufficient ⇒ never blocked;
B5 truncation/replacement degrade continuity ⇒ P0 inconclusive, append keeps continuity; plus the
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
- **(1) real end-to-end runner** `make_runner(sysio,…)` + `RealSys` (the actual unshare/tmux IO,
  `pragma: no cover`): per control it plants fixture/policy, launches under isolation, wires the
  trust-gate into the Observer, captures pane+debug from init, feeds probe records, opens/closes the
  window, and reaps. The `sysio` seam makes every ERROR PATH testable without a CLI.
- **(2) per-instance isolation + cleanup**: each control is its own instance (unique id, tmux
  socket, pgid, namespaces); the runner verifies isolation BEFORE capture and reap AFTER, for THAT
  instance, and fails closed (`ok:false` + reason) — never reinterpreted.
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

**Isolation + supervision:** `isolation_argv` builds `unshare --map-root-user --net --pid --fork
--mount-proc …` (fresh net ns = only `lo`; fresh pid ns, CLI as PID 1). `real_check_isolation`
verifies only `lo` + a failing outbound connect; `real_check_cleanup(pgid)` verifies the pid
namespace was reaped. **Fail-closed:** any isolation / capture / cleanup failure ⇒ `aborted:true`,
verdict INCONCLUSIVE, controls empty — never reinterpreted.

The pieces still owner-required for the REAL run are wired by the (not-run) real runner:

**Isolation (network + process), verifiably, without root or touching PASS-B1 containers:** run the
CLI under `unshare -rn --pid --fork --mount-proc <...>`:
- `-n` → a fresh NETWORK namespace with only `lo`: verifiable by `ip -o link` showing just
  `loopback` inside, and an outbound probe failing. HOME isolation alone is explicitly insufficient.
- `-r` → map to a user namespace so `-n/--pid` need no root.
- `--pid --fork --mount-proc` → the CLI is PID 1 of a fresh PID namespace. Cleanup kills the
  `unshare` leader; the kernel then reaps the whole PID namespace — **verifiable identity, no pgid
  reuse, no `pkill -f`, no orphans** (supersedes `/proc/<pgid>/comm`, which stays only as a
  belt-and-suspenders). If a tool needs a container instead, use a **throwaway** `--network none`
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

**Observer wiring:** `window_open` at CLI **initialization** (not trust-confirmed — C4), `window_close` after the control settles;
poll the pane (→ `from_pane`), read the debug tail (→ `from_debug`), feed probe records with the
verified `inst` (→ `from_probe_records`); emit sanitized enums only. **Fail-closed** on any launch
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
| **D1 isolation + identity** | `interpret_isolation`; **host-side identity**: `parse_ns_inode`, `verify_isolated` (fresh net+pid ns), `resolve_supervised_pid` (unique descendant in a fresh pid ns; 0/>1 ⇒ None); runner fails closed on ambiguous identity | that `nsenter` into the resolved host pid's net ns really yields only `lo` + failing outbound, and that /proc resolution finds exactly the unshare'd child on the host |
| **D2 reap** | `supervise_reap`: SIGTERM→wait→SIGKILL→exit/timeout; never-dies/None ⇒ False; GROUP-based, pgid derived via `getpgid` (no PID==PGID) | that `os.killpg` + the `/proc` group scan actually reap the `--pid` namespace on the host |
| **(1) runner** | error paths spawn/isolation/capture/cleanup; trust-aborted recorded not crash; happy ⇒ snapshot+digest | the real `unshare`+tmux launch and pane/debug/probe wiring |
| **(2) per-instance** | unique inst/sock/pgid; isolation-before + reap-after per instance; fail-closed via runner | that namespaces are truly per-instance and don't leak between controls on the host |
| **(3) independent positive** | `validate_positive` (authority + real `skills-dir:loaded`); `fixture_digest` independent + content-sensitive; digest cross-check pos==neg | that the positive control (no policy) actually LOADS the fixture on 2.1.314 |
| **D3 pre-trust capture** | capture tick ordered BEFORE `trust_gate`; late read ⇒ coverage partial (B4) | that a real pre-trust skills-dir decision is caught by the parallel loop |
| **D4 e2e config** | `verify_cli` (version + sha, fail-closed); orchestrator entry wiring | that `CLAUDE_CODE_MANAGED_SETTINGS_PATH` really seats the probe/guard AND that `strictKnownMarketplaces` ENFORCES skills-dir (OPEN since inv2 §4-bis / D3) |
| **D5 consistency** | `check_controls_consistency`: positive loaded-not-blocked, negative blocked-not-loaded, absent empty; contradiction ⇒ inconclusive | that the three real runs actually produce loaded / blocked / none as expected |

The single biggest open real question remains whether `strictKnownMarketplaces` enforces the
skills-dir block via the managed-settings mechanism available locally — the smoke is designed to
answer it, under the GO/NO-GO above. Until a real run passes all rows, N14 stays INCONCLUSIVE and
`blocked-low` is the ceiling.

### Production-wiring blockers (latest review) — status
- **B1 namespace identity** (critical): isolation_argv no longer writes `$$` (PID-ns-local); the host
  resolves+verifies the unshare'd child via /proc (`resolve_supervised_pid`/`verify_isolated`) before
  any nsenter/signal; ambiguous identity ⇒ fail-closed. Mock-tested; real /proc resolution still needs a run.
- **B2 clock scale** (critical): `window_open()/window_close()` now sample `clock()-t0` (same scale as
  reads/events). Regression with a non-zero monotonic start passes. Fully mock-verified.
- **B3 fixture + cwd**: the fixture now installs the real attack (session.start hook + marker,
  independent copy of the kit's ROGUE_REGISTER; 8eafe1a untouched); isolation_argv `cd`s to the
  disposable ws and VERIFIES cwd (`pwd -P`, exit 97). Mock-tested; the actual LOAD under 2.1.314 needs a run.
- **B4 silent failures**: a capture that fails during trust raises and invalidates the run
  (`capture-failed-during-trust`); `RealSys.spawn` checks the `tmux` result and raises. Mock-tested.

### Latest review (E1–E3) — status
- **E1 cleanup/identity** (critical): `supervised_cleanup()` establishes the GROUP identity
  (`getpgid`) BEFORE any tmux teardown; a None/gone/permission-error pid ⇒ cannot prove ⇒ False
  (never signals an ambiguous id, never reads a perm error as 'terminated', never queries a PID as a
  PGID). The runner reaps by identity first, then tears tmux down; with no identity it never claims
  cleanup (the run already returned `identity-ambiguous`). Race / pid-gone / identification-failure
  tested. Mock-verified; real /proc group reap still needs a run.
- **E2 critical window** (high): the window now OPENS at the FIRST successful read (not at Observer
  init), so with a real advancing clock the reads bracket [open, close]. Regression uses a clock that
  advances during spawn/isolation/ticks ⇒ `full`; a failed read still ⇒ partial (not relaxed).
- **E3 fixture equivalence** (medium): the disposable copy now uses `register.mjs` + marker
  `st-b1-rogue-n14.json`, byte-for-byte equal to the kit's `ROGUE_REGISTER` rendered for
  st-b1-rogue-n14 (asserted in-test by reading `poc/passb1/b1.py`; 8eafe1a untouched).

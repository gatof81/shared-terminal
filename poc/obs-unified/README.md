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

## Local results (pure simulated; no CLI — canary window)

`python3 test_obs_unified.py` → **36 passed**: B1/B2 regressions (not-seated ≠ valid guard;
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

## Future isolated smoke (proposal; gated, not now)

Once the canary window closes and after owner review: run `smoke.py` under a **network namespace**
(`unshare -rn`, no root needed) or a disposable container to get verifiable isolation; wire the
trust-gate + pane/debug capture into the `Observer`; and validate end-to-end on the real 2.1.314
that (a) a blocked skills-dir plugin yields `skills-dir:blocked` with `coverage:full` and no load,
and (b) an unblocked one yields `skills-dir:loaded` (FAIL). Disposable HOME, targeted process-group
cleanup, no raw text. Only after that evidence would a verdict-layer rule for N14 `blocked` (and,
separately, the N17-project C3/C4 causal rule) be worth proposing — never before.

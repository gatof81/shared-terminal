# Investigation #1 — trust-gate prototype (DISPOSABLE, not the audited kit)

Throwaway instrumentation of the workspace-trust dialog for investigation #1 (why P0 ended rc=1
without confirming trust in run 2). **It is NOT part of the audited PASS-B1a kit** (`poc/passb1`,
SHA `8eafe1a`): it does not import, modify, or change that kit or its criteria, and it is **never**
run on VM100 or against the retained containers. Its only purpose is to decide whether a hardened
trust confirmation is worth adding later; adoption into the kit would be a separate, audited step.

| File | What |
| --- | --- |
| `trustgate.py` | Pure logic + an injectable `IO` boundary. `pointer_option(text)` → `yes`/`no`/`other`/None (the highlighted option as an enum). `drive_trust(io, …)` confirms trust SAFELY. |
| `test_trustgate.py` | 9 deterministic unit tests (a scripted `FakeIO` state machine); no real CLI. |
| `smoke.py` | Optional disposable smoke against the REAL 2.1.314 CLI in an **isolated HOME** (no login, autoupdater disabled), with a **unique tmux socket** and **targeted** cleanup, printing only the structured result (enums/states), never raw pane text. **It does NOT isolate the network** (see limitations). |

## What it changes vs. the audited kit's `one_start` trust drive

The kit blindly sent `("Down","Enter")` when it saw the trust screen. If the `Down` was lost or
arrived before the screen was interactive, `Enter` confirmed the default **`No, exit`** → the CLI
exited with no hooks (the H1 failure mode; see `docs/design/project-chat/inv1-p0-trust.md`). The
prototype instead (owner priorities 1–4):

1. reads the HIGHLIGHTED option as an enum **before** pressing Enter;
2. confirms **only** when it is `yes`; otherwise STOPS and never sends Enter (a lost Down can never
   confirm `No, exit`) — `state: "not-yes-aborted"`;
3. a **readiness gate**: the pointer line must be stable across N consecutive polls before any key
   is sent (closes the cold-start race);
4. records the post-Enter result, process state and MONOTONIC timings;
5. **re-validates immediately before Enter** (`revalidate_before_enter`): the process must still be
   alive, the dialog still present and the pointer still on `yes`; otherwise it aborts without Enter
   (`exited-before-enter` / `screen-gone-before-enter` / `selection-changed-before-enter`). This
   **narrows** the TOCTOU window — it does **NOT** eliminate it: a residual gap remains between the
   final read and the key reaching the CLI, so **atomicity is not promised** (owner #1).

Privacy (owner): the result is **enums and structured states only** — no raw pane snapshots.

Scope (owner #2): `state:"confirmed"` means ONLY that trust was confirmed via a verified `yes`. It
does **not** prove a valid P0 baseline — any integration must still require `session.start` + the
organizational probe + the guard in the same start. This gate is **necessary, not sufficient**.

Result shape: `{state, selection_before_enter, enter_sent, dismissed, ready, ready_polls,
nav_sends, t:{first_seen, ready, enter, settled}}`. `state` ∈ `confirmed` / `not-yes-aborted` /
`screen-not-ready` / `exited-before-ready` / `exited-before-confirm` / `exited-before-enter` /
`screen-gone-before-enter` / `selection-changed-before-enter` / `confirmed-then-exited` /
`enter-ineffective`.

## Local results

- `python3 test_trustgate.py` → **14 passed** (pure simulated, no CLI): screen-not-ready and
  pointer-flap → no Enter; lost Down → `not-yes-aborted`, bounded retries, **never** Enter; correct
  selection and already-yes → `confirmed`; unexpected exit → not confirmed; Enter-then-exit →
  `confirmed-then-exited`; result is enums/states only; **`revalidate_before_enter` verdicts**
  (ok/changed/gone/exited); and the three **pre-Enter abort** paths
  (selection-changed / screen-gone / exited before Enter) — each asserts Enter is never sent.
- `python3 smoke.py` (real 2.1.314, disposable): run once earlier (commit `cb5ab03`) →
  `state=confirmed`, `selection=yes`, `ready_polls=2`, `nav_sends=1`, `got_past_trust=true`.
  **Not re-run after the owner-#3/#4 fixes**: the #521 canary window reserves Docker/real-CLI
  activity for Claude A, so `smoke.py`'s unique-socket / targeted-cleanup / network-claim changes
  are **code-level and not yet re-validated by a run**. Re-run it once the window reopens.

## Remaining limitations (documented)

- **TOCTOU is narrowed, not eliminated** (owner #1): a residual gap remains between the final
  pre-Enter read and the key reaching the CLI; the gate does not promise atomicity.
- **`confirmed` ≠ valid P0** (owner #2): the gate is necessary, not sufficient; P0 validity still
  needs `session.start` + org probe + guard in the same start.
- **No network isolation** (owner #4): the smoke is an isolated HOME + no login + autoupdater off,
  but the CLI can still reach the network. Verifiable isolation would need a network namespace
  (`unshare -rn`) or a container — out of scope here. The "loopback only" claim has been removed.
- **Not adopted into the audited kit**: this is an experimental result only. Whether to integrate it
  is a separate, audited decision — and correcting P0 does **not** resolve N14 (investigation #2) or
  N17-project (Option A limitation).

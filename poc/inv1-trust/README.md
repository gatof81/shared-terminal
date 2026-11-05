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
| `smoke.py` | Optional disposable smoke against the REAL 2.1.314 CLI in an **isolated HOME** (no login, loopback only), cleaned up afterwards. Prints only the structured result (enums/states), never raw pane text. |

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
4. records the post-Enter result, process state and MONOTONIC timings.

Privacy (owner): the result is **enums and structured states only** — no raw pane snapshots.

Result shape: `{state, selection_before_enter, enter_sent, dismissed, ready, ready_polls,
nav_sends, t:{first_seen, ready, enter, settled}}`. `state` ∈ `confirmed` / `not-yes-aborted` /
`screen-not-ready` / `exited-before-ready` / `exited-before-confirm` / `confirmed-then-exited` /
`enter-ineffective`.

## Local results (2026-11-05)

- `python3 test_trustgate.py` → **9 passed**: screen-not-ready and pointer-flap → no Enter; lost
  Down → `not-yes-aborted`, bounded Down retries, **never** Enter; correct selection → `confirmed`
  (`yes`, Enter last); already-yes → `confirmed` with `nav_sends=0`; unexpected exit → not
  confirmed; Enter-then-exit → `confirmed-then-exited` (not a clean confirm); result is enums/states
  only.
- `python3 smoke.py` (real 2.1.314, disposable, cleaned up) → `state=confirmed`,
  `selection_before_enter=yes`, `enter_sent=true`, `dismissed=running`, `ready=true`,
  `ready_polls=2`, `nav_sends=1`, `got_past_trust=true`. The gate waited for a stable screen, saw
  `No`, sent one `Down`, **re-verified `yes` before Enter**, and got past trust.

Note: correcting P0 does **not** resolve N14 (no demonstrable skills-dir refusal) or N17-project
(Option A limitation). Whether this improvement justifies a new VM100 run is a separate decision.

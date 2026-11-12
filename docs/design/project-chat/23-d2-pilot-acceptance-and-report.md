# D2 isolated pilot: acceptance criteria and the report it produces

Companion to the runbook `22-d2-validation-runbook.md` (scope approved by the owner, 2026-11-12;
**no execution GO yet**). The runbook says how each step is run and judged. This document says:
- what the run as a whole must show before the owner can consider activating D2;
- the exact shape of the report A delivers;
- how B turns that report into a recommendation.

It changes no step and no PASS condition of the runbook. If the two disagree, the runbook wins.

## 1. Verdict of a run

Each runbook step ends as one of:

| Result | Meaning |
| --- | --- |
| **PASS** | The step's PASS condition held, with its evidence recorded |
| **FAIL** | The condition did not hold, or an abort condition of §7 was hit |
| **NOT-EXERCISED** | The step ran, but the situation it tests did not occur. Only two steps may end this way: K1/K5 (a kill or a removal that never landed inside the window) and P7.3 (no unfinished delivery in the backup, runbook P7.0). It never counts as PASS |
| **ENV** | The environment broke a precondition, not D2. Examples: E1–E7, the app not reaching D1 after a restart, the egress rule stale. The step is repeated after the environment is fixed. An ENV is never turned into a PASS or a FAIL by judgement |
| **SKIPPED** | Excluded by the owner (K6 in this run, decision O3) |

**The run's verdict:**
- **PASS** only if every step from P0 to P8 is PASS, except the steps excluded by the owner and at most the NOT-EXERCISED cases above, each explained.
- **FAIL** if any step is FAIL.
- **INCOMPLETE** otherwise: an open ENV, or a step not run.

An INCOMPLETE run is not a partial PASS. The steps it did not settle are re-run, on the same host if
it is still intact (§4).

**Blocking FAILs** prevent any recommendation to activate, whatever else passed:
- anything written outside the allowlist (the §6 sweeps);
- any file in a `trap/`;
- a claimed path whose bytes do not match its sha;
- two `sending` lines for one delivery;
- a Composer call after a known loss or after a restore;
- a hang over 30 s;
- a foreign user getting bytes;
- a secret in the evidence.

## 2. What a PASS run demonstrates (and what it does not)

| The owner's requirement (D2 GO, 2026-11-12) | Shown by |
| --- | --- |
| Only allowed files leave a workspace | P5 (restricted, links, traversal, size, binary), with the real Files opener on a real bind mount |
| No secrets, credentials, restricted paths or private files | P5, plus P5's cross-user rows, plus the evidence rules themselves |
| No following symlinks; no writes outside the authorised directory | P4 F1, K3 (a real agent race), the uid-0 sweep, `trap/` empty |
| No overwriting existing files | P4 F2/F3, K4, P5b (a foreign file untouched) |
| Size and count limits | P5 (`too-many-artifacts`, 1 MiB + 1 B) |
| A durable record and safe handling of interruptions | K1 (SIGKILL rounds), K2 (lost lock), P7 (`uncertain{restored}`, T17), `projects:check-log` on the full log |
| D1's idempotency and recovery are unchanged | P1 (D1 sends unchanged), P4 F7 (replay), K1 (no second `sending`) |
| Root backend and uid-1000 agents | P3.3 (owner and modes as seen by the agent), P3.5 (the receiving CLI computes the sha) |

**Not shown, even by a PASS:** the runbook's §8 list (a real model, the 256 MiB quota at full size,
the exact SIGKILL point, multiple hosts, the frontend) and K6 (excluded).

## 3. The report (A delivers, posted redacted to #595)

One directory on the isolated host: mode 700, with a `SHA256SUMS` of every file. A redacted
`REPORT.md` is posted to #595. Sections:

1. **Identity of the run**
   - the two SHAs: backend and session image at `a09bf8a`, and the mock from #604's merge;
   - the image ids, the `dist` hash and the mock file's sha256;
   - the host's `machine-id` hash, and start and end times (UTC).
2. **E1–E7.** One line each: the check, its result and the evidence file. No secret values (runbook §6).
3. **The step table.** One row per runbook step, P0.0 to P9: `step | result (§1) | evidence file(s) | note`. Every non-PASS row has a note.
4. **Log evidence.** The full project log as an array of pages (paged by `before=oldestSeq`), redacted (`del(.text)`, ids pseudonymized if it leaves the host). Then the `npm run projects:check-log` report on it, which must have `ok: true` and its `notes` explained.
5. **Sweeps.** Both sweeps' output (expected: empty after the allowlist), and the `trap/` listings.
6. **Placed files.** For every `artifacts_placed` claim in the log: the path, sha256, owner, mode and size as read on the host after the run.
7. **K-row details.**
   - K1: per round, the kill delay and the states found after restart.
   - K3/K4: the loop markers, the stop time, the nesting depth seen, and every claimed file located.
   - K5: per round, whether the delete landed before or after `placing`.
8. **P7.** The manifest's `projects` entry, the restore journal's final state, the `recovery{source: restore}` line, and the T17 evidence path.
9. **Deviations.** Anything done differently from the runbook, and why. An undeclared deviation makes the run INCOMPLETE.
10. **Verdict** (§1), signed by the operator.

## 4. After the report

- **B** checks the report against the contract and this document within one working session, and writes a recommendation on #595:
  - activate as planned;
  - fix X first, citing the evidence;
  - or re-run steps Y.

  B also confirms, from the evidence and not from the summary, that the blocking FAILs of §1 are absent.
- **A FAIL in D2** gets an issue with the evidence, a fix PR with a regression test (owner's GO for a functional change), and a re-run of the affected steps. Re-running from P0 is needed only if the fix touches placement, the store or recovery.
- **The host stays intact** until the owner accepts the report (runbook P9). It is not reused for anything else meanwhile.
- **Activation on VM100** is a separate operational plan with A and a separate GO: the flag only, `--no-build`, and rollback means turning the flag off (runbook P8).

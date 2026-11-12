# D1 pilot: backend evidence (delivery, attribution, owner_ack, persistence)

Status: D1 has been active on VM100 since GO 2 (2026-11-12 17:16Z), running image `faddf7f01408`
built from `0fb3685`. This document checks the first production use against the binding contract
(`docs/PROJECT_CONVERSATION.md`) from the **backend's** side: the project log, its files and its
lock. A's #597 (`20-d1-pilot-and-validation.md`) covers what the person saw and the remaining
validation criteria. This document does not repeat them.

**Source.** On 2026-11-12 A read the following on VM100, without changing anything there:
- `GET …/conversation/events?limit=500`;
- `find .projects -ls`;
- `/proc/locks`;
- the boot log.

A removed `message.text` and pseudonymized every id and hash consistently, then posted the result in
#595. That page is kept as the fixture
`backend/src/projects/conversation/fixtures/pilot-2026-11-12.json`, and `twoRecipients.test.ts`
re-checks it on every CI run.

## 1. Verdict

`npm run projects:check-log` on the evidence gives **`ok: true`, 0 violations, 0 notes**:
- 20 lines, `seq` 1–20 contiguous;
- one writer, and no `recovery` line (nothing was left to recover);
- no `artifact`, `grant` or relay events (D2 and D3 are off).

| Contract guarantee | Evidence | Result |
| --- | --- | --- |
| §3.3 S1: `message` + every `planned` in one append | msg 2: seqs 8–10 share one `at`, `bn` 2→1→0 | ✓ |
| §3.2: target fixed at `planned` | each `planned` carries `binding{binding_id, epoch, sid, cid}`; the two agents have distinct `sid`/`cid` | ✓ |
| §3.4 rule 3: a fresh composer id per delivery | 3 deliveries, 3 distinct `composer_client_message_id` | ✓ |
| §3.3 c0/S3: `sending` (the intent) before the effect | every delivery is `planned → sending → delivered`. `binding_verified_at` = the `sending` line's `at`. The Composer's answer comes 2.7–3.6 s later | ✓ |
| §3.4 rule 1: at most one call per delivery | exactly one `sending` per delivery; no `uncertain`, no retry | ✓ |
| §3.3 step 3: recipients are independent | msg 2: the two `sending` lines are 31 ms apart, and each delivery completed on its own (`delivered` at +3.6 s and +3.7 s) | ✓ |
| §4.1: `reply_ref` only after a fully observed 10 s window | `reply_ref.at − reply_settling.at` = 10.002 / 10.000 / 10.002 s, always ≥ `settle_until`. The same writer wrote both lines | ✓ |
| §4.1: the range is the reply's, not the window's | `seq_from` = the Composer's acked `seq` (791, 802, 493); `seq_to` = `turn_end_seq` | ✓ |
| §4.1: attribution | 3 × `exact`; each `prompt_id` = the delivery's `promptId`; distinct prompts and hashes per agent | ✓ |
| §4.3: `owner_ack` per item, no side effect | 3 acks, each `{msg_id, agent_id, report_sha256}` naming an existing recipient and its reply's hash. No delivery or reply line follows an ack | ✓ |
| §2: modes | `.projects/` and `<pilot>/` are `0700 root`; the log is `0600 root` (10 402 B for 20 lines) | ✓ (the lock file: see §3) |
| §2.1: single writer | `FLOCK ADVISORY WRITE` on `.writer.lock` held by the backend's helper. The only `[projects]` boot line is `writer lock held` | ✓ |

## 2. Timings (for the record, not guarantees)

| Step | msg 1 (1 agent) | msg 2 (2 agents) |
| --- | --- | --- |
| S1 (`message`) → `sending` (two D1 reads, the session meta, S3) | 0.66 s | 0.70 s / 0.73 s |
| `sending` → `delivered` (the Composer) | 2.75 s | 3.58 s / 3.69 s |
| `delivered` → `reply_settling` (the agent's turn) | 1.76 s | 1.75 s / 1.87 s |
| `reply_settling` → `reply_ref` | 10.002 s | 10.000 s / 10.002 s |

All requests answered well inside T_http (30 s). No delivery answered `sending` with its result
written later.

## 3. Findings

- **`.writer.lock` is `0644`; §2 says files are `0600`.** `/usr/bin/flock` creates the lock file with
  the process umask.
  - The file is empty and lives in a `0700 root` directory, so nobody else can reach it. The
    deviation is formal only: no exposure and no effect on the exclusion.
  - Fixed in its own PR, with a regression test: the backend creates the lock file `0600` before
    starting the helper, and narrows an existing one through its descriptor.
- **No `conversation.index.json`** next to the log (A's question). This is expected. The
  contract (§2) makes the snapshot an optional cache and says D1 does not write it: the state is
  recomputed from the event file on every open (≤ 64 MiB).
- No other deviation.

## 4. Not exercised in production yet

The remaining rows of #597 §2 are a refused recipient, a resend in the same thread, `quote_ref`,
Done from a second device, gaps and robustness. When the owner runs them, the same redacted dump
plus `npm run projects:check-log` certifies the log side. The two-recipient cases (independent
deliveries and replies, a refusal that neither blocks nor retries, two pending items each closed by
its own ack, a log unchanged across a reopen) are already covered by `twoRecipients.test.ts`
against the real store, fan-out, reply watcher and ack API.

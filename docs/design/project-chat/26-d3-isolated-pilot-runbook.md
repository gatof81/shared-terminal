# D3 consult: isolated pilot runbook

Status: **draft for the owner's gate. Not executed.** Nothing here runs on VM100, and none of it is
a GO to deploy, to turn a flag on or to touch a production session. The contract is
`docs/PROJECT_CONVERSATION.md` §7 (v0.4). The code is the stack #643 → #645 → #646 → #647; the
pilot runs the exact SHA the owner approves, not "whatever the branch is now".

## 1. What is already proven, and where

| Evidence | Where it ran | What it proves |
| --- | --- | --- |
| Unit and integration suites (`collab`, `collabText`, `outbox`, `fanout`, `recovery`, `logCheck`) | CI, every push | Admission rules 1–8, the queue, pause/resume/revoke, expiry, recovery at each point of a delivery, zero retries, the log invariants |
| `relayOrigin.smoke.ts` (57 checks) | Session Image workflow: real Docker daemon, real bridge network, the real image | §7.3.1 a–f: a write is admitted only from the participant's own container. Another container with the right token, the host, a slow inspect, a replaced container's old address and the origin check off are all refused, and still captured |
| `relay.smoke.ts` (23 checks) | Same workflow, two containers with the real entrypoint, relay and CLI (2.1.308), a mock model | A whole consult: task → A writes the ask → B receives it and writes the reply → A receives it → `ended{budget}`. Every event `origin: match`, each relay delivered once, `checkLog` clean |

That CI run **is** the first isolated validation: two disposable sessions, no credentials, no
production access.

What it does **not** cover, and this pilot adds:

1. The **real Composer**. The smoke types through a stand-in that uses the real paste steps but none
   of the preconditions (foreground identity, CLI version policy, pane record).
2. The **real backend process** (`index.ts` wiring, the flags as booted, a real restart).
3. A session in the **permission mode real sessions use**. The smoke's CLIs run in bypass. In default
   mode the Write of the outbox file stops at a permission dialog (§6).
4. A **real model** following the protocol from the task footer alone. Only stage 2 covers it.

## 2. Stages

| Stage | Sessions | Model | Needs |
| --- | --- | --- | --- |
| 1 | Two disposable sessions on a disposable host | The mock (`session-image/test/mock-anthropic.mjs`; it answers a consult's header block with the matching Write) | The owner's GO for the host and the run |
| 2 | The same two sessions | A real model | A separate decision: it puts a model credential on the disposable host |
| 3 | Claude A ↔ Claude B on VM100 | Real | Its own gate (§7). Out of scope here |

## 3. Environment

The host is the one `22-d2-validation-runbook.md` §2 describes, requirements E1–E7 unchanged
(disposable VM that is not VM100 **and not VM120**, own Docker daemon, new empty D1, fresh secrets,
no route to VM100 or the NAS, backend on loopback only, no session egress, root on the host). Roles
as in that runbook §1: A operates, B diagnoses and reports, the owner decides.

The `.env` is the one of doc 22 §2 (including `CONVERSATION_ALLOW_USERS` and
`COMPOSER_CLI_VERSIONS=<the image's CLI version>`: without it the Composer refuses the image's CLI
as `cli-unvalidated`), with these flags:

    CONVERSATION_ENABLED=true
    CONVERSATION_COMPOSER_ENABLED=true
    PROJECT_CHAT_ENABLED=true
    PROJECT_CONVERSATION_ENABLED=true
    INGEST_REQUIRE_SESSION_ORIGIN=observe
    PROJECT_RELAY_ENABLED=true

`observe` is deliberate: it is the mode production would run, and D3 must fail closed under it.

Preflight, abort on any miss:

- P1 `GET /api/auth/status` → `features.projectRelay: true`.
- P2 Two sessions SA and SB created by the pilot's own user, capture effective on both
  (`GET /api/sessions/:id/conversations` → `capture.effective: true`), **one** interactive Claude in
  each, both `waiting_input`.
- P3 One project, agent A bound to SA and agent B bound to SB.
- P4 One plain message (no `collab`) to A and one to B, both `delivered`: the real Composer accepts
  the image's CLI.
- P5 In each session: `curl -m 5 https://example.com` fails (stage 1).

## 4. Steps

Each step records the request, the answer, and `GET /api/projects/:pid/conversation/events` after it.

| # | Do | Expect |
| --- | --- | --- |
| S1 | `POST /api/projects/:pid/conversation/messages` `{clientMessageId, text, to: [A], collab: {mode: "ask", with: B}}` | 202, `grantId`. Log: `message` + `grant{created}` in one batch. A's pane shows the task and the footer |
| S2 | A writes its ask (the mock does; in stage 2 the model does) | `outbox{accepted, origin: match}`, `message{kind: relay, n: 1}`, `delivery` `queued → planned → sending → delivered`. B's pane shows the framed message |
| S3 | B writes its reply | The same for `n: 2`, then `grant{ended, reason: budget}`. A's pane shows the reply |
| S4 | A writes one more file | No new `message{kind: relay}`; nothing reaches B |
| S5 | New task and grant with `maxMessages: 4`. `POST …/grants/:id/pause` before A writes, then A writes | `outbox{rejected, grant-paused}`; B's pane unchanged. After `resume`, A writes again ⇒ delivered once. The mock writes at once: if its write lands before the pause, repeat the step |
| S6 | New grant. With a relay `queued` (B kept busy with a long turn), `docker compose restart app` | After boot the relay is still `queued` and the `recovery` line lists the grant under `grants_kept`; **zero** Composer calls during boot. When B is free ⇒ delivered once |
| S7 | New grant. `kill -9` the backend process while a relay is in flight (best effort: repeat until the log ends at `planned` or `sending`) | After boot: `not-sent{persist-failed}` or `uncertain{orphaned}`, `grant{paused, reason: recovered}`, zero Composer calls. B's pane shows the message at most once |
| S8 | New grant. `revoke` with a relay queued | `grant{revoked, by: <owner>}`, the relay `not-sent{grant-inactive}`, B's pane unchanged |
| S9 | New grant. From a **third** container on the sessions network, POST the two Write events of a valid ask to `st-backend` with SA's ingest token (taken from SA's container env by the operator; only its hash goes in the evidence) | Both events in SA's capture file (the verdict is not persisted); `GET /api/admin/stats` shows the origin counter's `mismatch` cause up by 2; no `outbox` line; nothing delivered |
| S10 | New grant. With a relay queued, remove agent B from the project | `not-sent{binding-changed}` and `grant{ended, reason: binding-changed}`; nothing delivered |
| S11 | `npm run projects:check-log` over the project log | 0 violations |

## 5. PASS / FAIL

PASS needs all of:

- every `outbox{accepted}` line carries `origin: match` and belongs to the session that wrote it;
- every relay has at most one `sending` and one result line, and each pane shows each message once;
- S5–S8 and S10: no text reaches a pane while its grant is paused, revoked, ended or just recovered;
- S9: no admission;
- S11 clean.

Stop the run and keep everything as it is (no cleanup, no retry) on: a message shown twice, a
message shown in a pane with no `sending` line, an admission in S9, or any write outside the
pilot host.

Evidence to keep: the project log, both sessions' capture files, the backend log, the mock's request
log, the two panes (`tmux capture-pane -p`), with `sha256sum` of each.

## 6. Known gap: the permission dialog

In default permission mode the Write under `~/workspace/.st-outbox/` asks for confirmation, the
session goes to `needs-terminal`, and a person has to accept it in the Terminal. The consult still
works; it is not unattended. Removing the dialog means either sessions in bypass or a managed
permission rule that allows exactly that path. Neither is changed by this runbook: stage 1 runs
once in each mode and records what happens. A managed rule is a production-configuration decision
for the owner.

## 7. Before stage 3 (A ↔ B on VM100)

Not requested here; listed so the gate is known in advance.

- The stack merged and deployed with `PROJECT_RELAY_ENABLED` off, then the flag: three separate GOs.
- From A, the read of production's origin counters under `observe` (how many events are not `match`
  today, and why) and the inventory of processes in each participating container that accept
  loopback requests (§7.8: a forwarder inside a participant's container is that participant).
- **One** Claude instance in each participating session.
- The decision of §6.

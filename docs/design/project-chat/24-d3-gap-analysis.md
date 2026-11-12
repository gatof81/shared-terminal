# D3 (Dev ↔ QA collaboration per task): gap analysis

Status: **analysis for planning. No D3 code exists or is authorised.** `INGEST_REQUIRE_SESSION_ORIGIN`
stays `observe` until its own GO. Every reference is to main `b3c3a2a`.

The question (owner, 2026-11-12): what is missing so that Dev and QA can exchange results
automatically, **inside an explicit, revocable permission from the owner, without creating any new
authorization?** The binding contract is `docs/PROJECT_CONVERSATION.md` §7, with §1, §2.2, §3, §4.1,
§8 and §10 (T18–T22).

## Summary

**Nothing of D3 exists in code.** The only traces:
- `message.kind: relay` is folded (`fold.ts`);
- messages are written with `relay: null` (`fanout.ts`);
- `grants_closed: []` is always written (`recovery.ts`).

**D1 and D2 already provide the hard parts:**
- critical sections under one lock per project;
- the point of no return `mayEffect` (d0);
- one Composer call per delivery;
- `reply_ref exact` only after a monotonic settle window that this process observed in full.

**What is missing:**
- the grant state;
- the relay engine;
- its hooks into that machinery: a callback after a durable `reply_ref`, and a factored `deliver()` that takes an authorizer;
- **five contract decisions that must be taken before code (§2)**.

## 1. Contract → code

### 1.1 §7 requirements

| § | Requirement | Exists (main) | Missing | Seam |
| --- | --- | --- | --- | --- |
| §1, §7.1 | `PROJECT_RELAY_ENABLED` needs CONVERSATION and origin `true`; set without them ⇒ logged and off | The origin mode is read once at boot (`index.ts`). The D1/D2 "set without requirements ⇒ off" pattern | Flag parse, boot gate, a holder key | The `PROJECT_ARTIFACTS_ENABLED` pattern; the origin mode passed as a getter |
| §7.2 | `POST …/grants` (validation, the task `delivered` to `start`, pairs, bindings read with a 5 s bound, S_G) | `store.critical`. The S1 idempotency pattern (`fanout.ts`). `directory.projectBindings` (one read). The timed binding read | Route, body validation, grant fold, S_G, `initial_relay_from` | New `grants.ts` behind `ProjectConversationApi` |
| §7.2 | `initial_relay_from` (the task's `exact` reply) | `fold.replyRefs` is a `Set` and drops attribution and hash | The fold keeps the `reply_ref` fields per delivery | `fold.ts`, `case "reply_ref"` |
| §7.3 | Trigger: an `exact` `reply_ref` on a delivery to X under the grant, with a pair X→Y | `ReplyWatcher.writeRef` writes `exact` but notifies no one | An `onReplyRef` hook after a durable write (also on `ambiguous`/`failed`, which end the grant) | `armSettle` → `writeRef` |
| §7.3 | `reply_late_close` of a reply already relayed ⇒ `ended{reply-late-close}` | Late closes are written in the `after` phase (≤ 30 min, or until the next prompt) | A callback, and a "was relayed" check | Same hook |
| §7.3 | Relay text = fixed header + `last_assistant_message` | `refFields` hashes the report and does not keep it. `readCapture` exists | Read at `turn_end_seq`, verify against `report_sha256`, compose | Pure `composeRelayText` through `ReplyDeps.readCapture` |
| §7.3 | Truncated ⇒ `ended{reply-truncated}`; invalid ⇒ `report-<n>.md` artifact or `report-invalid` | `truncated` comes from the capture; `validateText` codes | All of it | A pure classifier |
| §7.3 | Declared artifacts `ST-ARTIFACT: .st-outbox/<name>`, ≤ 4, through §6.1 | `ProjectArtifacts.register` is owner-shaped: it reads the **live** binding and writes `source{kind: owner}`. `storeContent` and placement are reusable | Parser; registration with `kind: relay` from X's **fixed** binding; a report artifact built from bytes | `artifacts.ts`, new internal entry |
| §7.3 | A relay is a §3 delivery: `authorized_by: collab:<id>`, Y's binding = `grant.bindings`, `sending` consumes a unit, `ended{budget}` in the same append | `deliver()` implements the whole S2/S2b/c0/S3/d0/d/S4 order, but `authorized_by: "owner"` is hard-coded and `deliver` is private to `send()` | Factor `deliver` with an authorizer: grant checks in S2/S3, extra events in S3's append, `callerId = grant.by` | `deliver()`'s S3 append; `matches()` |
| §7.3 (1) | Relay S1: grant live, origin `true`, no relay for (`grant_id`, `from_delivery`) | `MessageFold` keeps no `relay` | A `relayed` index in the fold | New relay S1 |
| §7.3 (2) | Grant, binding and flag re-checked at S2 and S3 | **Without artifacts there is no S2 critical section**: `a` is compared outside the lock and only a failure is written | A locked S2 for relays | `fanout.ts`, check `a` |
| §7.4 | End causes | S4 writes the result; `onUncertain`/`onDelivered` | Map result → `ended` | `deliver()` S4, `notSent()` |
| §7.4 | `POST …/grants/:id/revoke` under the lock, never waiting for the Composer | Per-project chain; no section holds an effect | Route + handler | `grants.ts` |
| §7.4 | Expiry (checked on every use, timer, recovery ⇒ `expired`/`interrupted`) | `recoveryEvents` has no clock; the store has `opts.now` but does not pass it on | Timer registry (cleared on `close()`), liveness predicate, `now` in recovery | `recovery.ts`, `store.ts` |
| §7.4, §8 | Restart or restore ⇒ every live grant `ended` + `recovery.grants_closed[]` | `grants_closed` is always `[]`. Restore is idempotent by `restore_id` | Close them in the same append | `recovery.ts` |
| §7.5 | `GET …/messages/:taskMsgId` with the whole chain | `api.message` filters by `msg_id` | Join grants (by `task_msg_id`) and relays (by `relay.grant_id`) | `api.ts` |
| §7.5 | `GET /api/admin/stats → projectConversation` | Only `composer` and `conversation` exist | Everything | `routes/admin.ts` |
| §5 | `projectSendIp` | Doesn't exist; every route uses `projectIp` | Decide (§2, C15) | — |

Also missing:
- `logCheck.ts` has no grant or relay rules, so the Pilot 2 evidence cannot be checked yet;
- the frontend: the approval screen with the scope repeated word for word, and "Detener" in both places.

### 1.2 Rows T18–T22

| Row | Exists | Missing |
| --- | --- | --- |
| T18 (revoke before S3 / during the call) | Serialised sections; the call runs outside the lock | Revoke, grant-live check at S3, `not-sent{grant-inactive}` |
| T18b (rebind) | `matches()` against the binding fixed at `planned` | Compare against `grant.bindings` → `ended{binding-changed}` |
| T18c (only `start` triggers) | — | Trigger predicate |
| T18d (two concurrent creates) | The S1-under-lock pattern | S_G |
| T18e (`reply_ref` right after S_G) | — | Dedupe by (`grant_id`, `from_delivery`) |
| T19, T19b–d | — | `relays_used`, `ended{budget}`, expiry, validation |
| T20 | `ambiguous`/`failed`, `truncated`, empty report, `control-bytes` | Map each one to `ended{…}` |
| T20b–T20e | The attribution half is already tested (`replies.test.ts`) | Only the assertion "no relay, 0 calls" |
| T21 | — | Close grants on boot |
| T22 | — | 409 on create; "during" only via an injected getter (C6) |

## 2. Contract decisions

**BLOCKING (must be decided before code):**
- **B1. A relay's binding mismatch:** `binding-changed` (§7.2, T18b) or `delivery-not-sent` (§7.4's table)? Both apply. Proposal: the specific cause (binding, grant-inactive) wins over `delivery-*`.
- **B2. One terminal event per grant, and the exact vocabulary.**
  - §2.2 allows both `revoked` and `ended`.
  - `ended{budget}` (written at the 6th `sending`) followed by a `refused` result would give a second cause.
  - `reply-<cause>` is not enumerated: is it `reply-ambiguous` or `reply-ambiguous{second-close}`? Are `reply-empty` and `reply-failed` causes?

  Proposal: the first terminal event wins, and the list is written out.
- **B3. What relay S1 writes when the grant is not live.** T19b expects `not-sent{grant-inactive}` + `ended{expired}` in the same section, so S1 does write a relay `message`. For a grant revoked or ended **before** the trigger, it is not defined whether anything is written.
- **B4. Declared artifacts and the report artifact (§7.3).**
  - the grammar of `<name>`: subdirectories? `..`?
  - what happens with a missing, restricted, too-large, binary or extra (more than 4) artifact, or with `artifacts-full`: skip it or `report-invalid`?
  - `report-<n>.md` plus 4 declared exceeds `ARTIFACTS_PER_MESSAGE = 4`;
  - the source session: X's binding **fixed** by the grant (recommended), or the live one as the owner path reads it;
  - what `n` is;
  - the shape of `source{kind: relay}`;
  - `artifacts: true` with D2 off ⇒ 409 `artifacts-off`?
- **B5. Flags at creation:** with `PROJECT_RELAY_ENABLED=true` and origin `observe` (today's production), §1 says `relay-off` and §7.1 says `origin-binding-off`. One code.

**CLARIFY (can go in the same contract PR):**

| # | Topic | Recommendation |
| --- | --- | --- |
| C1 | Which bindings are compared against `grant.bindings` at S2/c0: only Y's, or all of the grant's | All. It costs no extra read. `grant.bindings` has no `cid`, so the conversation is chosen again at relay time; `no-target`/`ambiguous` ⇒ `not-sent` and the grant ends (B1) |
| C2 | `relays_used` is a `grant` field, but §7.3 writes it on `delivery{sending}`. `round` is fixed at S1 while the unit is consumed at S3 | Write `grant{relay, relays_used}` in S3's append. `round` = the unit consumed |
| C3 | A restore with a grant already expired: `expired` (§7.4) or `interrupted` (§8, T15)? | `interrupted` after a restore |
| C4 | Expiry on the wall clock (§7.4) versus §4.1's rule that the wall clock never decides | An in-process monotonic deadline decides; `expires_at` is for display and recovery |
| C5 | The expiry timer and §3.4 rule 6; T19b's preconditions | Say that the timer is not a retry. In T19b, disable the timer, or it closes the grant first |
| C6 | `ended{origin-binding-off|relay-off}` cannot happen in a live process (the flags are read at boot, and a restart already gives `interrupted`) | Accept it and test it with an injected getter |
| C7 | A report the capture no longer holds, or whose hash doesn't match | `report-invalid` |
| C8 | "Tal cual" versus normalisation; `<dueño>` username or user_id; codes that can't fire because of the header (`unsupported-prefix`, `empty-text`); T20 `control-bytes` only with `artifacts: false` | Spell out each one |
| C9 | Which task delivery counts as `delivered` at creation (`settled{delivered}`?); the task `kind: owner`; `start` being some pair's `from` | `delivered` or `settled{delivered}`; `kind: owner`; `start` must be a `from` |
| C10 | Idempotency of create (no client id) and of revoke (unknown, ended, repeated) | `clientGrantId` with §3.4's rule; revoke idempotent |
| C11 | Late close "already relayed" = after `sending` or after S1? The watcher stops at the next prompt or after 30 min | After S1; declare the 30 min limit |
| C12 | A new grant on the same task relays the same reply again; a non-`exact` reply before the grant leaves it with nothing to trigger | Allow re-relay under a new grant (a new owner decision); refuse creation when the task's reply is not `exact` |
| C13 | Appendix A without `GrantEv` and without `source{kind: relay}` | Add both |
| C14 | "No queue": Y mid-turn ⇒ `busy` ⇒ `ended{delivery-refused}`; the Composer's 30/min includes relays | Declare it for Pilot 2 |
| C15 | `projectSendIp` (§5) does not exist | Add it with D3, or amend §5 |

## 3. Dependencies outside the code

**Origin flag (§7.1, §11 gate 5, §12):**

| §12 | Exists | Missing |
| --- | --- | --- |
| 1. `observe` evidence | Counters `originObservedSinceBoot{byCause, sessionsMatched, sessionsNotMatched}`; DEPLOYMENT.md's gate procedure | **No reading of them is recorded.** They reset on every boot, without timestamps or ids: it needs a backend up ≥ 24 h and a second source to explain causes. **Inconsistency:** DEPLOYMENT.md step 4 says PASS only with `match` and nothing else; §12 allows "explained" rejections. Reconcile before asking for the GO |
| 2. Inventory of capturing sessions (container, `sessions-net` address, relay `="2"`) | `inspectSessionNetwork`; the label check | A tool or a recorded inventory: a read-only job for A on VM100 |
| 3. Window procedure | DEPLOYMENT.md step 5 | A runbook with preflight (`b_idle`, outside 08–09Z, no backup, SHA) |
| 4. Only with the GO | — | The owner's GO |

**Others:**
- D2 merged but off, with its isolated validation not yet run. Relays with artifacts depend on it.
- D1 effective, capture effective on both agents, and the Composer CLI policy passing on both panes.
- G3-2 stays NO-GO and is not touched (§0.1: no agent sender).
- **Rollback D3 → D2:** D1/D2 fold `grant` events to nothing. A live grant is closed only when D3 starts again. Relays already sent are ordinary deliveries. It is harmless, but should be declared next to §1's rollback.
- Pilot 2 has its own GO.

## 4. PR plan and contract tests

1. **docs, contract v0.3.3:** B1–B5 decided; the CLARIFY rows; `GrantEv` and `source{kind: relay}` in Appendix A; §12 aligned with DEPLOYMENT.md. Needs the owner's approval (it changes a binding contract).
2. **D3-a, pure layer + recovery:**
   - the grant fold (grants, the `relayed` index, `reply_ref` fields, relay on `MessageFold`);
   - `recoveryEvents` closes grants (with `now`);
   - `logCheck` grant rules;
   - the flag gate.

   Tests T21, T15 (grant half), T19c (recovery).
3. **D3-b, grants API:** create (S_G), revoke, validation, expiry timer, the chain in `api.message`, admin counters. Tests T18d, T19c (timer), T19d, T22 (create).
4. **D3-c, relay engine:**
   - `deliver()` factored with an authorizer: a locked S2 without artifacts, S3 with `relays_used`/`ended{budget}`, end in S4;
   - `onReplyRef`/`onLateClose` hooks;
   - initial relay, report read and verified, relay text.

   Tests T18, T18b, T18c, T18e, T19, T19b, T20–T20e, T22 ("during").
5. **D3-d, relay artifacts,** after B4, with a security review like D2's.
6. **Frontend (A):** approval with the scope repeated word for word, "Detener" in both places, the "relevo n de N" chain.
7. **Pilot 2:** runbook and acceptance, gated on the origin flag `true` in production.

**Contract tests writable now.** These are pure functions over JSON fixtures, kept as `it.todo` until the code exists:
- `foldGrants(lines, now)`;
- `recoveryEvents` with grants (boot, restore, idempotent by `restore_id`);
- `validateGrantBody` (T19d, defaults 6/30/false, pairs);
- `decideCreate(state, now, originMode)` (T18d, B5, `initial_relay_from`);
- `relayTrigger(state, replyRef, now)` (T18c, T18e, T20, `settled{delivered}` ⇒ none, B3);
- `decideRelayS3` (T19, T18, T19b, T18b);
- `endReasonForDelivery` (B1);
- `composeRelayText` + `classifyReport` (golden header, T20 `control-bytes`);
- `parseDeclaredArtifacts` (B4);
- `checkLog` grant rules.

They should be written **after** B1–B5, so they don't pin answers the owner has not given.

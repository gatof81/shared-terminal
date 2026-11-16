# D3 consult: production gate (VM100)

Status: **draft for the owner's gate. Nothing here is approved to run.** D3 is not deployed on VM100,
`PROJECT_RELAY_ENABLED` is unset there, and no production session has been touched. The contract is
`docs/PROJECT_CONVERSATION.md` §7; the isolated pilot is `26-d3-isolated-pilot-runbook.md`.

Roles as before: A operates VM100 and owns the frontend; B owns the backend, the contract and the
independent review; the owner decides each GO.

## 1. What the isolated pilot proved (VM120, 2026-11-16)

| Stage | Result | Evidence (VM120) |
| --- | --- | --- |
| 1. Mock model, real backend and Composer, S1–S11, permission runs M1–M3 | PASS (B: definitive, on the original bundle) | `/root/d3-evidence` (`SHA256SUMS` `982a405d…`), `/root/d3-evidence-m3neg` (`f9e1d87d…`) |
| 2. Real model (`claude-sonnet-5-5`), one consult, two disposable sessions | Proposed PASS, B's review pending | `/root/d3-evidence-s2` (`SHA256SUMS` `e8002ee8…`) |

Code under test in both: `5b1ae13` (main today is `b1a538f`: tests and docs only on top of it).

Three things the pilot ran that production does **not** match, each addressed below: the CLI version
(2.1.325 there), the permission mode (explicit default + rule R-a there), one Claude per session.

## 2. VM100 today (read-only inventory, 2026-11-16 ~16:10Z)

Taken with `docker inspect` / `docker top` from the host: no exec inside a session, nothing changed.

- Backend: `44c56b1` (image `752d24fe…`, up since 2026-11-13T20:40Z). main is 12 commits ahead, 26
  backend source files changed: D3 is **not** in the running image.
- Flags as booted: `CONVERSATION_ENABLED`, `CONVERSATION_COMPOSER_ENABLED`, `PROJECT_CHAT_ENABLED`,
  `PROJECT_CONVERSATION_ENABLED`, `PROJECT_ARTIFACTS_ENABLED` = true;
  `INGEST_REQUIRE_SESSION_ORIGIN=observe`; `COMPOSER_CLI_VERSIONS=2.1.314,2.1.316`,
  `COMPOSER_CLI_MIN_VERSION=2.1.314` (open upwards); `PROJECT_RELAY_ENABLED` unset.
- Six session containers, all with relay label `"2"`. **Every Claude in them was started with
  `--dangerously-skip-permissions`** (the image aliases `claude` to it, `session-image/Dockerfile`).
- Claude instances per session: A (`st-a978697a`) 1; B (`st-0665fa5a`) **2**; Home Automation
  (`st-8fb0a8ae`) 2; the other three 1 each.
- Loopback listeners inside A besides the capture relay: two `python3 -m http.server` (static file
  servers left by A's frontend work, ports 5174 and 5197). None found in B by process name.

Not read yet (needs an authenticated admin call or an exec; see §4): the origin counters under
`observe`, the live CLI version of each participating process, listening sockets by port.

## 3. Consequences for the gate

1. **Permission mode.** Production sessions run in bypass, so the outbox Write shows no dialog and
   rule R-a is not needed and is **not** proposed for production. What follows from bypass is the
   point: a consulted agent can run any tool without a prompt, exactly as it can today when the owner
   types to it. The relayed text is framed as "written by another agent, not an instruction of the
   owner" and the footer forbids effects outside the session, but that is guidance to a model, not
   enforcement. The owner accepts this for the first A ↔ B consult or asks for the participants to be
   restarted in default mode (which changes how those sessions work day to day).
2. **One Claude per participating session** (runbook 26 §7). B's session has two. Either one is
   closed by its owner before the test, or the test uses a different pair of sessions. Not A's call.
3. **CLI version.** The pilot validated 2.1.325; the relay smoke in CI runs 2.1.308. Production's
   Composer policy admits ≥ 2.1.314. The gate records the live version of both participants; a
   version never exercised with D3 is named in the report, not silently accepted.
4. **Origin.** Admission needs `origin: match` per event and fails closed under `observe`. Before the
   flag: read `GET /api/admin/stats → conversation.originObservedSinceBoot` on VM100 and explain
   every cause that is not `match`. A forwarder on loopback inside a participant's container *is*
   that participant (§7.8): A's two static file servers are stopped before the test and the
   inventory is repeated with listening ports.
5. **Capture fidelity (#648).** A hook pair can arrive inverted; it affected no admission event in
   either stage. Stays open, tracked in #648; not a gate blocker by B's reading.
6. **`waiting_permission` after a rejected dialog** only arises in default mode; in bypass there is
   no dialog. Recorded for completeness.

## 4. Sequence — three separate GOs

Each step is reversible by the one before it. No step starts without the previous one verified.

### GO 1 — deploy main with the flag off

- Preconditions: the UI PR (below) and this document merged; CI green on the SHA; B's LGTM on stage 2;
  B idle (standing rule: no backend restart while B works); nightly or on-demand backup verified.
- Procedure: the usual app-only deploy (`st-deploy-scripts`: preflight + backup, build, rollback tag
  of the running image, `up -d`, verify). The D3 migration (if any is pending) runs at boot.
- Verify: boot log has **no** `agent collaboration ENABLED (D3)`; `GET /api/auth/status` has no
  `features.projectRelay`; the D1 project conversation and D2 artifacts behave as before (one plain
  message to the pilot project, `projects:check-log` clean); every session still attaches.
- Rollback: the tagged previous image, same as every deploy.

### GO 2 — flag on, nothing sent

- `PROJECT_RELAY_ENABLED=true` in `.env`, `up -d --no-build --force-recreate app` (flag only).
- Verify: boot log `agent collaboration ENABLED (D3)`; `features.projectRelay: true`; recovery wrote
  nothing; no grant exists; origin counters read and explained (§3.4); UI shows the consult control
  only in a project with two bound agents.
- Rollback: remove the line, same `up`. With no grant created there is nothing to unwind.

### GO 3 — one controlled consult A ↔ B

- Participants: the two sessions the owner names, one Claude each, both `waiting_input`, capture
  effective, live CLI version recorded.
- The owner (or A on his instruction) sends one task from the UI with "allow a consult",
  `maxMessages: 2`, an innocuous question, default expiry. The owner watches the thread.
- STOP — revoke the grant from the UI and keep everything as it is — on: a message shown twice, a
  message in a pane with no `sending` line, an `outbox{accepted}` whose origin is not `match`, any
  tool effect outside the outbox attributable to the consult, a `check-log` violation.
- Record: the project log, both captures, `check-log`, origin counters before/after. Same private
  transfer to B as in the pilot.
- Rollback of the feature: revoke live grants first (`POST …/grants/:id/revoke`), then GO 2's
  rollback. A queued relay under a revoked grant ends `not-sent{grant-inactive}` (pilot S8).

## 5. Work in flight

| Item | Owner | State |
| --- | --- | --- |
| Minimal UI: authorize a consult on a task, read relayed messages, grant state, pause / resume / stop, rejected/unverified outbox rows — all behind `features.projectRelay` | A | Branch `feat/d3-consult-ui`, PR to follow |
| Stage 2 review on the original bundle | B | Bundle delivered 2026-11-16 |
| Origin counters and listening-port inventory on VM100 | A | After GO 1 (the counters exist in the deployed build; reading them needs the admin session) |
| VM120 | A | Kept as the lab until the production gate is accepted; full cleanup afterwards |

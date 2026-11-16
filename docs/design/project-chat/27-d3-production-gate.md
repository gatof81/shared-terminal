# D3 consult: production gate (VM100)

Status: **GO 1 (deploy with the flag off) is authorized by the owner under the conditions of §5.
GO 2 and GO 3 are prepared here and not authorized.** D3 is not deployed on VM100,
`PROJECT_RELAY_ENABLED` is unset there, and no production session has been touched. The contract is
`docs/PROJECT_CONVERSATION.md` §7; the isolated pilot is `26-d3-isolated-pilot-runbook.md`.

Roles as before: A operates VM100 and owns the frontend; B owns the backend, the contract and the
independent review; the owner decides each GO.

## 1. What the isolated pilot proved (VM120, 2026-11-16)

| Stage | Result | Evidence (VM120) |
| --- | --- | --- |
| 1. Mock model, real backend and Composer, S1–S11, permission runs M1–M3 (negatives 1–2 with the real CLI included) | **PASS, definitive** (B, on the original bundles) | `/root/d3-evidence` (`SHA256SUMS` `982a405d…`), `/root/d3-evidence-m3neg` (`f9e1d87d…`) |
| 2. Real model (`claude-sonnet-5-5`), one consult, two disposable sessions | **PASS, definitive** (B, on the original bundle; accepted by the owner) | `/root/d3-evidence-s2` (`SHA256SUMS` `e8002ee8…`) |

B's verdicts with what was checked: #595 comments 6921006349 (stage 1) and 6922824816 (stage 2 and
the M3 negatives). No further real-model run is planned on VM120 unless a concrete finding asks for it.

Code under test in both: `5b1ae13` (main is `b1a538f`: tests and docs only on top of it).

What the pilot ran: CLI 2.1.325, explicit `--permission-mode default` with rule R-a, one Claude per
session. The first production consult (§4) keeps all three.

## 2. VM100 today (read-only inventory, 2026-11-16 ~16:10Z)

Taken with `docker inspect` / `docker top` from the host: no exec inside a session, nothing changed.

- Backend: `44c56b1` (image `752d24fe…`, up since 2026-11-13T20:40Z). main is 12 commits ahead: D3 is
  **not** in the running image. §3 is the full difference.
- Flags as booted: `CONVERSATION_ENABLED`, `CONVERSATION_COMPOSER_ENABLED`, `PROJECT_CHAT_ENABLED`,
  `PROJECT_CONVERSATION_ENABLED`, `PROJECT_ARTIFACTS_ENABLED` = true;
  `INGEST_REQUIRE_SESSION_ORIGIN=observe`; `COMPOSER_CLI_VERSIONS=2.1.314,2.1.316`,
  `COMPOSER_CLI_MIN_VERSION=2.1.314` (open upwards); `PROJECT_RELAY_ENABLED` unset. The requirements
  of the D3 flag (D1 effective, origin check in `observe` or `true`) are therefore already met.
- Six session containers, all with relay label `"2"`. **Every Claude in them was started with
  `--dangerously-skip-permissions`** (the image aliases `claude` to it, `session-image/Dockerfile`).
- Claude instances per session: A (`st-a978697a`) 1; B (`st-0665fa5a`) **2**; Home Automation
  (`st-8fb0a8ae`) 2; the other three 1 each.
- Loopback listeners inside A besides the capture relay: two `python3 -m http.server` (static file
  servers left by A's frontend work, ports 5174 and 5197). None found in B by process name.

Not read yet (needs an authenticated admin call or an exec; see §4): the origin counters under
`observe`, listening sockets by port.

## 3. What the deploy changes: `44c56b1` → main

Twelve commits. Backend code (outside tests) changes in exactly two, #645 and #646 (D3-a and D3-b).
The rest: frontend only (#639, #640, #641, #642), docs (#637, #638, #643) and tests, the scripted
model and docs (#647, #649, #650).

- **No D1 migration.** `backend/src/db.ts` is byte-identical between the two SHAs: the `MIGRATIONS`
  array ends at the same version, so boot applies nothing and a rollback by image has **no schema
  consequence**. D3 keeps all its state in the project log on the host
  (`<WORKSPACE_ROOT>/.projects/`), which the nightly backup already carries.
- **No session-image change that a session needs.** `session-image/` differs only in the scripted
  model used by tests and one smoke line; hooks, relay and entrypoint are untouched. No session is
  recreated or restarted by this deploy.
- `docker-compose.yml` gains one line forwarding `PROJECT_RELAY_ENABLED` (empty ⇒ off).
- Backend code that runs **with the flag off**:
  - `conversation/service.ts`, `store.ts`, `ingestRoute.ts`: the origin verdict of each hook request
    (already computed under `observe`) now travels in memory with the event to in-process
    listeners. Nothing persisted changes shape; with the flag off nothing listens for it.
  - `projects/conversation/recovery.ts`, `fold.ts`, `logCheck.ts`: they understand grant, outbox and
    `queued` lines. A log without grants produces the same recovery record as before (the D1 recovery
    tests pass unchanged).
  - `fanout.ts`: a `collab` in a send answers 409 `relay-off`; a send without it keeps its request
    hash.
  - `index.ts`, `routes/*`: the D3 objects are built and the grant routes mounted only with the
    flag effective; `features.projectRelay` is absent otherwise.
- New modules that are loaded but never constructed with the flag off: `collab.ts`, `outbox.ts`,
  `grantRules.ts`, `collabText.ts`.
- Frontend: Cloudflare Pages builds every main commit on its own, so the consult UI reaches the
  browser when its PR merges, before the backend deploy. It renders nothing without
  `features.projectRelay`.

## 4. The first production consult: two new test sessions (owner, 2026-11-16)

The sessions A and B work in stay exactly as they are: nothing is closed (B keeps its second
instance), restarted or reconfigured in them, and they do not take part. The first consult on
production runs between **two additional sessions created for it**, in their own project:

- one Claude per session, started as `command claude --permission-mode default` (the alias is
  bypassed explicitly; the pane footer is checked);
- rule R-a (`Edit(//home/developer/workspace/.st-outbox/**)`, runbook 26 §6.2) as a second managed
  fragment in those two sessions only, placed before the CLI starts, the way VM120 did it. No other
  session's managed directory is touched;
- nothing of VM100 or the NAS in them: no SSH key, no Docker socket, no token beyond the model
  credential the session needs, an empty workspace;
- a separate project with the two agents bound to those sessions; one innocuous question,
  `maxMessages: 2`.

One step only the owner can do: the Claude CLI in each new session has to be signed in. Production
sessions use the owner's subscription and VM100 has no model gateway, so A creates the sessions and
the owner signs in once in each (in its Terminal) before GO 3. That sign-in is the "model credential
the session needs" above; A does not handle it.

Consequences:

1. **Permission mode.** With default mode and R-a, the only tool that runs without a dialog is a
   Write/Edit under `.st-outbox/`; anything else stops at a dialog that nobody answers. This is the
   configuration both pilot stages and the M3 negatives validated.
2. **`waiting_permission` after a rejected dialog** applies here: the conversation keeps that state
   until its next tool event, next turn or the silence probe (8 min), and D3 holds deliveries to it
   as `queued` meanwhile. A delay, never a wrong delivery (seen in the M3 negatives).
3. **CLI version.** Validated with D3: 2.1.325 (pilot) and 2.1.308 (CI smoke). The gate records the
   live version of both test sessions; one never exercised with D3 is named in the report.
4. **Origin.** Admission needs `origin: match` on both Write events and fails closed under
   `observe`. Before the flag: `GET /api/admin/stats → conversation.originObservedSinceBoot`, every
   cause that is not `match` explained. A forwarder on loopback inside a participant's container
   *is* that participant (§7.8): the test sessions start with no listener besides the capture relay.
5. **Capture fidelity (#648).** A hook pair can arrive inverted; it touched no admission event in
   either stage. If it ever hits a Write pair the message is not admitted (the sweep notes the file
   `unverified`). Open in #648, not a blocker.
6. **Collaboration between the habitual A and B sessions** is a later gate with its own decision:
   they run in bypass (a consulted agent could run any tool without a prompt, the framing of a
   relayed text being guidance and not enforcement) and B has two instances. Not prepared here.

## 5. Sequence: three separate GOs

No step starts without the previous one verified. A failure stops the sequence and is reported; no
step leads automatically into the next.

### GO 1: deploy main with the flag off (authorized, conditions below)

- Preconditions, all of them: the consult UI PR and this document merged; CI fully green on the
  SHA to deploy; B has said in #595 that the restart does not interrupt its work; the operational
  preflight and `images:pins` gate pass; a backup taken for this deploy, restorable, with its copy
  on the NAS verified; the rollback image tagged and identified by digest; `PROJECT_RELAY_ENABLED`
  absent from `.env`.
- Procedure: the usual app-only deploy (`st-deploy-scripts`: preflight + backup, build, rollback
  tag of the running image, `up -d`, verify). No migration runs (§3).
- Verify: boot log has **no** `agent collaboration ENABLED (D3)` and no warning about
  `PROJECT_RELAY_ENABLED`; `GET /api/auth/status` has no `features.projectRelay`; a send with
  `collab` answers 409 `relay-off` and `GET …/projects/:pid/conversation/grants/c-000000000000`
  answers 404; D1 and D2 behave as before (one plain message with a small artifact to the existing
  pilot project, `projects:check-log` clean); the Composer delivers one message; every session
  attaches and its capture is still effective; no session container was restarted.
- Rollback: the tagged previous image, same as every deploy. Nothing D3 was written, so the old
  backend reads the same files it wrote.
- Report after GO 1: the above, plus the reads GO 2 needs (origin counters with causes, Composer
  and conversation stats, the two test sessions' state).

### GO 2: flag on, nothing sent (not authorized)

- `PROJECT_RELAY_ENABLED=true` in `.env`, `up -d --no-build --force-recreate app` (flag only).
- **What the flag enables at once, with no consult sent:** `features.projectRelay: true`; the grant
  routes (`GET …/projects/:pid/conversation/grants/:grantId`, `POST …/pause|resume|revoke`); and
  `collab` accepted on `POST …/projects/:pid/conversation/messages`. From that boot, any client
  holding the owner's login can create a grant in any of the owner's projects that has two bound
  agents, with or without the UI. Until a grant exists nothing else runs: no outbox file is read
  and no relay is queued.
- Verify: boot log `agent collaboration ENABLED (D3)`; recovery wrote nothing; no `"ev":"grant"`
  line in any project log; origin counters read and explained (§4.4); the UI shows the consult
  control only in a project with two bound agents.
- Rollback: remove the line, same `up`. With no grant created there is nothing to unwind.

### GO 3: one controlled consult between the two test sessions (not authorized)

- Participants: the two sessions of §4, both `waiting_input`, capture effective, one interactive
  conversation each, live CLI version recorded.
- The owner (or A on his instruction) sends one task from the UI with "allow a consult",
  `maxMessages: 2`, the innocuous question, default expiry. The owner watches the thread.
- STOP (revoke the grant from the UI and keep everything as it is) on: a message shown twice, a
  message in a pane with no `sending` line, an `outbox{accepted}` whose origin is not `match`, any
  tool effect outside the outbox attributable to the consult, a `check-log` violation.
- Record: the project log, both captures, `check-log`, origin counters before/after. Same private
  transfer to B as in the pilot; B reviews before anything else is proposed.

### Turning the flag off, and back on, once a grant exists

Turning the flag off **does not end a grant**. It only stops the code that acts on it.

- Before turning it off: revoke every grant that is not ended
  (`POST …/projects/:pid/conversation/grants/:grantId/revoke`; the ids are the `grant_id` of the
  `"ev":"grant"` lines in the project's events, there is no list route) and read each back as
  `{state: "ended", reason: "revoked"}`. A queued relay under a revoked grant ends
  `not-sent{grant-inactive}` (pilot S8). Then remove the line and recreate `app`.
- If it is turned off with a grant still live or paused: the grant stays in the log, nothing is
  admitted or delivered, a `queued` relay stays queued, files written to an outbox meanwhile are
  not read. **Turning it on again resumes that grant** if its `expires_at` has not passed (default
  2 h, at most 24 h): a relay queued for less than `maxWaitMin` goes out once, a longer one ends
  the grant (`wait-expired`), and a file written while it was off is recorded `outbox{unverified}`,
  never sent. An expired grant is closed at boot (`ended{expired}`). So the flag is re-enabled only
  after reading that no grant is live, or knowing which ones will resume.
- A restart with the flag on follows §7.5: `queued` stays queued, a delivery cut after `sending`
  becomes `uncertain{orphaned}` with the grant `paused{recovered}`, nothing is re-sent.

### Rolling back the image once D3 lines exist

Possible at any point (no migration), with these consequences in a project that held a consult:

- `44c56b1` ignores grant and outbox lines. At its boot recovery a relay still `queued` is closed
  `not-sent{persist-failed}`; it sends nothing.
- It does **not** end grants. A grant left live resumes if main is deployed again with the flag on
  before its `expires_at`. Revoke first, as above; if that was not possible, wait out the expiry or
  revoke right after rolling forward, before any participant session writes.
- The old `projects:check-log` reports `queued` deliveries as violations. That log is audited with
  main's checker, not the rolled-back image's.

## 6. Work in flight

| Item | Owner | State |
| --- | --- | --- |
| Minimal UI: authorize a consult on a task, read relayed messages and states, pause / resume / revoke, rejected/unverified outbox rows; behind `features.projectRelay`, separate from the visual renewal | A | Branch `feat/d3-consult-ui`; B reviews |
| Two test sessions and their project on VM100 (§4) | A | After GO 1; created, not used until GO 3 |
| Origin counters and listening-port inventory on VM100 | A | After GO 1, in its report |
| Report after GO 1 and the verified conditions for GO 2 | A + B | After GO 1 |
| VM120 and its D1 | A | Kept as the lab until the production gate is completed; cleaned afterwards as agreed |

# Composer for CLI background sessions: evidence and design notes (2026-11-05)

Supports the CONVERSATION.md v1.9 proposal (§8.1.12). Everything below was observed in a **disposable
sandbox** (its own HOME/`CLAUDE_CONFIG_DIR`, a private tmux server, a fake Messages API on loopback)
with CLI 2.1.314, 2.1.316 and 2.1.318. Nothing touched a real session. Where a line says *bundle*,
it comes from reading the CLI's code, not from running it.

## B, as observed in production (read-only)
- Pane `%0` foreground: `claude attach 185e27dc` (`TMUX_PANE=%0`). It spawned
  `claude.exe daemon run --origin transient`, which runs `bg-pty-host …/pty/185e27dc.sock` →
  `claude.exe --resume <transcript>` on its own pts, with `CLAUDE_CODE_SESSION_KIND=bg` and no
  `TMUX_PANE`.
- Probe: `kind: background`, `verified: false`. The hooks carry no pane. D1 and the index show
  `paneId = null`. Prompts typed in the Terminal reach `185e27dc` (`user_prompt` at 21:51:25Z and
  21:53:32Z).

## What the CLI exposes
| Question | Answer |
|---|---|
| What does `attach` connect to? | The daemon's `control.sock`, never the pty socket (sock_diag peer mapping). It sends one JSON `attach` line, then the connection is a raw byte stream to that job's pty. |
| Can the attached process switch sessions? | **Yes, in the same PID.** `←` re-execs in place into `claude agents` (`CLAUDE_AGENTS_SELECT` set); Enter attaches another job with no further exec. |
| Does anything say which job a client shows? | No. `list` and `leases` don't. Title, cmdline, environ and pty size are hints only. |
| What does paste + Enter do in agent view? | It **creates a new background session** with that text. |
| Does a job keep its session id? | No. `/clear` changes the sessionId under the same job and pid; `agents --json` follows it, the daemon's `list`/`state.json` don't. |
| What does `agents --json` show for a background session? | `{pid, id, cwd, kind:"background", startedAt, sessionId, name?, status?, waitingFor?, state}`. Same serializer in all three versions; no client/attach fields. |
| How is the daemon found and authenticated? | `/tmp/cc-daemon-<uid>/<sha256(configDir)[:8]>/control.sock` (0700, uid-checked; the check fails **open** if the peer-uid lookup fails). Only `reply`, `dispatch` and `permission-response` need `<configDir>/daemon/control.key` (0600). *(Audit:)* `attach` **without** a key gives full read and write of a job's pty, and `subscribe`, `kill`, `shutdown`, `list` and `has` need no key, so the key is a client-version handshake, not a security boundary. |
| What does `reply`, plain, do? | The daemon forwards it over the rv socket. Idle: UserPromptSubmit with the right session_id in ~60 ms. Busy: queued, and the human's half-typed draft stays untouched. Permission pending: queued until approved. `/x` and `!x` **run as commands**; with a dialog open the text may **answer it** (bundle). |
| And `reply` with `nextTurn: true`? | Literal next prompt: no slash/bang, no dialog answer, no pty-paste fallback. Errors `ENOREPLY`, `ESKEW` (different build), `ENOJOB`, `ERESPAWNING`, `EAUTH`, `EUNVERIFIED`. |
| What is `pty/<short>.sock`? | Length-framed raw pty input once authenticated with `ptyAuth` (plain text in `roster.json`); it merges with the human's draft. *(Corrected by the security audit:)* **every version** sends the scrollback and live output to any same-uid client. 2.1.314 does it on connect; 2.1.316+ after the client's first frame, even with a wrong token. Only input requires `ptyAuth`. |
| What is `rv/<short>.sock`? | Single peer; a new peer kills the daemon's link. Never usable from outside. |
| Is it stable across versions? | Ops, schemas, routing and the `agents` serializer are token-identical across 2.1.314, 2.1.316 and 2.1.318. All of it is undocumented. |

## Round 2: queue, attribution, session changes, restarts (sandbox, all three versions; restarts on 2.1.318)
- **No conditional reply.** The schema is exactly `{proto, op, short, text, auth?, nextTurn?}`, and unknown keys are ignored. No op lists or removes queued prompts. `has` returns `{alive, present, ready}`.
- **Busy.** The reply is queued ("Press up to edit queued messages"). Two queued replies are sent in **one** model turn: each gets its own `UserPromptSubmit`, but there is a single Stop.
- **AskUserQuestion pending.** A plain reply **answers the question**, with no `UserPromptSubmit`. The probe shows the state (`status: waiting, waitingFor: "input needed"`).
- **Race.** `agents --json` takes 160–190 ms. `busy` appears in `sessions/<pid>.json` ~19 ms after a human Enter. A reply sent 25 ms after that Enter was queued.
- **Attribution.** Hook keys are identical for every source, and the reply returns no id.
  - Transcript: a reply is `promptSource: "queued"` with an `enqueue`.
  - Text typed while idle is `promptSource: "typed"`, with no enqueue.
  - Text typed while busy fires `UserPromptSubmit` **at enqueue, with the running turn's `prompt_id`**.
- **Session changes.**
  - `/clear` and `/resume` change the sessionId under the same short and pid. `agents --json` follows them; the daemon's `list`/`state.json` don't.
  - `short = sessionId[0:8]` at job creation, and stop + `--bg --resume` reuses the same short. Pid, starttime and the job `nonce` change.
- **Teardown.** A reply accepted during `claude stop` was **lost**.
- **Restarts.**
  - Daemon `shutdown` reaps workers, and queued text is lost.
  - Daemon SIGKILL: the worker delivers its queue, then exits 60 s later while still listed as idle.
  - Worker SIGKILL: it is respawned with `RESUME_INTERRUPTED_TURN`. The queue is lost and the interrupted prompt **runs twice**.
  - A dropped client connection after sending: delivered once.
  - Nothing replays a queued reply.

## Security audit (independent)
- The boundary is the container's uid. The proposal does not widen it.
- The 2.1.314 exposure is local to the container (a private `/tmp` and 0700 dirs) and the same on every version, so migration should be driven by validation, not by security.
- **Corrections adopted in §8.1.12:**
  - hard-wire `nextTurn`: plain reply skips `ESKEW`, runs `!`, answers dialogs and can fall back to a pty paste that escapes bracketed paste;
  - apply `validateText`, because `nextTurn` passes ESC, NUL and CR through;
  - identify the daemon by `SO_PEERCRED` = supervisorPid, plus its exe version, because any same-uid process can bind a fake socket;
  - the key and tokens sit on the workspace bind mount and in backups, so read the key only inside the container;
  - the client is an absolute-path image program, writes one JSON line ≤ 1 MiB, and prints fixed codes only.
- **Upstream notes:** the control socket's uid check fails open; the pty host has no peer check (root can connect); a `--bg` initial prompt appears in argv and env.

## Conclusion
- **A pane-level binding** for an attached client cannot be proven, and its failure mode (a new
  session created from our text) is unacceptable. It stays refused.
- **Delivery by job id** through the daemon's `reply` + `nextTurn` is workable:
  - identity from a fresh probe (`sessionId` = cid) plus process identity of the job;
  - the existing hook ack (`textHash` in that cid) proves delivery;
  - a new `accepted` result, because there is no cancel;
  - a per-job lock;
  - a version list validated by a dedicated smoke.

## Implementation outline (after the contract is approved)
1. `conversation/bgTransport.ts`: a fixed-argv exec as the session uid, running a fixed client
   program with the text on stdin. It reads `control.key` and the socket inside the container and
   returns `{ok}` or `{code}`.
2. `composer.ts`: branch on probe `kind: background` → preconditions 1–4 of §8.1.12, the job lock and
   record, one effect, the `accepted` → `delivered`/`misdelivered` ack, and reconcile by evidence
   after a restart.
3. Frontend: before the first send to a background session, say "queued in the CLI if Claude is
   busy; it can't be cancelled from Chat"; show the `accepted` state.
4. Tests:
   - unit tests with fake exec answers for every error code;
   - a composer integration test with a fake probe and fake hooks;
   - the `bg-reply` smoke in the Session Image `cli-variants` job: real CLI, fake API, idle/busy/
     permission, `/` literal, `/clear` race → `misdelivered`, `ESKEW`.
5. Flag: `CONVERSATION_COMPOSER_BG_ENABLED`, off by default; `COMPOSER_BG_CLI_VERSIONS` exact list.

## Implementation status (#547, contract §8.1.12 revision 3)

Implemented behind `CONVERSATION_COMPOSER_BG_ENABLED` + `COMPOSER_BG_SESSIONS` + `COMPOSER_BG_CLI_VERSIONS`
(all off/empty by default), exactly as §8.1.12 revision 3 says. Owner decisions of round 2:
- **D1 identical messages**: refused only while ambiguous (`own-pending`, `unconfirmed-unacknowledged`,
  `queue-pending`); repeating a text is allowed; the 10-min hash rule is gone; the person's "I checked
  the Terminal" is a durable `acknowledged` event.
- **D2 transcript unavailable**: 409 `transcript-unavailable` before the effect; after acceptance the send
  ends `unconfirmed{transcript-unavailable}`, never `failed`, never retried.
- **D3** custom `CLAUDE_CONFIG_DIR`: 409 `unsupported-config-dir`, no inferred path.
- **D4** `duplicated` (strong evidence of a duplicated execution, never absolute certainty — a voluntary
  `claude stop` mid-turn + `--bg --resume` + the same text retyped as the very next prompt can look
  identical, and evidence outside the 4096-event scan window may go unidentified; both
  are declared residual risks in §8.1.12.5) and `possible-duplicate` (weaker, unconfirmed): persistent
  events, one per send and kind, re-armed after a restart.

## Canary plan (first production canary — NOT authorised by this document)

**Never on B, Home Automation or Educación HZ, nor on any existing session.** The canary is a session
created for it and deleted after it.

Prerequisites:
1. #547 approved and deployed with the flag still off. The Session Image `cli-variants` job is green for
   the pinned version, `bg-reply` smoke included:
   - all cases plus the production-layout phase L101–L105 (real entrypoint, no `CLAUDE_CONFIG_DIR`,
     `workspaceTranscripts`);
   - case 12 accredited by the deterministic tests.

   **Case 9 (ESKEW) evidence is the manual mixed-version run** (`BGSMOKE_ONLY=9 … local <old> <new>`:
   daemon 2.1.318 over a 2.1.314/2.1.316 job). CI has one CLI per image and reports case 9
   NOT-REPRODUCED.
2. A **disposable** session `canary-bg` created from the image pinned (#521) to a CLI version `V` that:
   - **already satisfies the pane composer's `COMPOSER_CLI_VERSIONS`** — that variable is the pane
     composer's production policy and the canary does **not** change it;
   - is the only entry of `COMPOSER_BG_CLI_VERSIONS`.

   The session uses the default `~/.claude` (no `CLAUDE_CONFIG_DIR`).
3. **Capture effective on `canary-bg`**: create it with conversation capture requested, either with
   the owner in `CONVERSATION_ALLOW_USERS` before creation, or with
   `PATCH /api/admin/sessions/<id>/conversation {"enabled": true}` and a recreation (§2.7, DEPLOYMENT.md
   "Recreating a session container"). Check `GET /api/sessions/<id>/conversations` →
   `capture.effective: true` before step 1.
4. Host backup (`npm run backup`) as usual; the canary session itself is disposable.

Configuration (the per-session allowlist is implemented: `COMPOSER_BG_SESSIONS`):
```
CONVERSATION_COMPOSER_ENABLED=true            # already on for the pane composer, unchanged
COMPOSER_CLI_VERSIONS=<unchanged>             # NOT touched by the canary; must already admit V
CONVERSATION_COMPOSER_BG_ENABLED=true
COMPOSER_BG_CLI_VERSIONS=<V>
COMPOSER_BG_SESSIONS=<canary-bg session id>    # ONLY this one
```
**Each flag flip (on, and later off) restarts the backend for every user**: every live terminal
reconnects, and in-flight operations are cancelled durably as on any restart. Schedule it
accordingly. Boot must log the `composer background transport ENABLED … sessions: <id>` warning line,
and the `[server] composer CLI policy:` line must stay identical.

Steps (each one checked before the next; "Terminal" = the canary session's own terminal):
1. In the Terminal: `claude --bg "hello canary"`, wait until `claude agents` shows it idle. Chat lists
   the conversation with `transport: "background"`.
2. Send "canary one" from Chat: the notice appears; confirm. Expected:
   - `accepted`, then `delivered`;
   - the bubble yields to the prompt;
   - `job-<short>.json` gone;
   - events `prepared>accepted>delivered>released`;
   - `enqueue_ms` recorded in the `delivered` event.

   **This step is where the production layout is first observed outside CI**: the `~/.claude` symlink,
   the daemon socket under the hash of the literal `/home/developer/.claude`, the `transcript_path`
   prefix and `workspaceTranscripts`. A `binding-stale` (no daemon found, peer mismatch) or a
   `transcript-unavailable` here is the expected "layout unverified" abort: stop, flag off, report.
3. Send the same "canary one" again: allowed (D1) and delivered.
4. Make Claude busy and send. To give the job work from the Terminal, attach to the job:
   `claude attach <short>` (the short is in `claude agents`). Type a long task **in the job's own
   view** and press Enter there. **Warning: paste + Enter while the client shows the agent view (the
   job list) creates a NEW background session; make sure the attached view shows the job's
   conversation before typing.** Then send from Chat: expect `409 busy`, no queue-operation in the
   transcript.
5. Still attached to the job (same procedure and warning), run `/clear`. Then send to the old
   conversation: refused (`probe-failed`/`binding-stale`). Send to the new one: delivered.
6. `claude stop <short>`, then send: refused; no record left.
7. Restart the backend with nothing pending: no record, no marker, boot lines as above.
8. Rollback rehearsal (below); then check that the pane composer of another disposable session still
   sends normally.

Success criteria:
- every step's outcome as listed;
- no `uncertain`, `possible-duplicate`, `duplicated` or `unverifiable`;
- the pane composer unaffected (its admin stats unchanged);
- no process or socket touched outside `canary-bg`.

Abort criteria (stop, flag off, drain, report):
- step 2 `binding-stale` / `transcript-unavailable` (layout unverified);
- any `delivered` that the transcript does not show as the `queued` entry of our enqueue;
- any `misdelivered`, `duplicated` or `possible-duplicate`;
- any `uncertain` not explained by a step;
- a send reaching a conversation other than the selected one;
- any change seen in another session;
- boot failing.

Rollback (safe, in this order):
1. Unset `CONVERSATION_COMPOSER_BG_ENABLED` and restart (again: every user's backend restarts).
   Nothing new is written; pending records keep settling by evidence.
2. Drain: `npm run composer:resolve -- <sid> --list`. For each `job:<short>` record run `reconcile`,
   then `discarded` or `sent-manually` for an `uncertain` one after checking the Terminal. Repeat
   until no `job-*.json` remains under `.st-control/*/composer/` (DEPLOYMENT.md "Composer for CLI
   background sessions").
3. Only then, if needed, deploy a backend without the feature. Delete the canary session.

Evidence to collect:
- the boot lines;
- per step:
  - the HTTP answer;
  - the `composer_send` events of the conversation (incl. `enqueue_ms`);
  - the `job-*.json` while it exists;
  - the transcript's queue lines (enqueue / dequeue / queued) with timestamps;
  - the hook log lines;
- **`enqueue − t0` per delivered send** (the backend log line `delivered (… enqueue − t0 = N ms)`);
  a value approaching 2000 ms is a finding;
- `GET /api/admin/stats → conversation.composer`;
- the `[composer-bg]` backend log lines (no text is logged).

# D2 artifacts: real validation runbook (isolated environment)

Status: **proposal for the owner's scope review. Not executed. Nothing here runs without a
separate operational GO**, and none of it runs on VM100.

The code under test is main `a09bf8a`: D2 is merged and `PROJECT_ARTIFACTS_ENABLED` is off
everywhere. The contract is `docs/PROJECT_CONVERSATION.md` §6 (v0.3.2), §3.3 steps b–S2b and §8.
The unit and integration evidence is the matrix in #600. This runbook covers what that matrix lists
under **"needs a real smoke"**:
- a root backend writing into the workspaces of uid-1000 agents;
- the real Files opener on a bind mount;
- the real Composer and CLI receiving the artifact lines;
- an agent verifying the SHA-256 itself;
- real races, kills and a lost lock;
- backup and restore of a project that has artifacts.

## 1. Roles

| Who | Does |
| --- | --- |
| Owner | Approves this scope, the environment and the GO to run it. Decides PASS/FAIL on the report |
| A (operator) | Provisions the isolated host, runs every step, collects the evidence, tears down. A also owns VM100, the frontend and deploys; none of them are touched here |
| B (backend) | Answers questions during the run. Diagnoses a FAIL from the evidence. Writes the report against the contract. Never runs anything on the hosts |

## 2. The isolated environment (requirements)

Every destructive step runs **only here**. The run is aborted if any of these does not hold at
preflight (§5, P0).

| # | Requirement | How it is checked (evidence) |
| --- | --- | --- |
| E1 | A **disposable host** (VM), not VM100. A VM on the same Proxmox is acceptable only if it is isolated in disks, networks, credentials and access, as in the PASS-B preflight handoff | `hostnamectl`, `cat /etc/machine-id` ≠ VM100's (compare the hash only) |
| E2 | Its own Docker daemon and its own `WORKSPACE_ROOT` (e.g. `/srv/d2-run/workspaces`), on a disk that holds no other data | `docker info --format '{{.ID}}'`, `findmnt -T $WORKSPACE_ROOT` |
| E3 | **No production credentials.** A **new, empty D1 database** in the dedicated account, created for this run, with a token scoped to it. Fresh `JWT_SECRET` and `SECRETS_ENCRYPTION_KEY` generated on the host. No VM100 `.env` is copied | `D1_DATABASE_ID` ≠ production's (compare the hash only). `GET /api/auth/status` → `needsSetup: true` before setup |
| E4 | No mount or route to the NAS, to VM100 or to its backups | `findmnt`, `ip route` (no VM100 or NAS subnet routes beyond what the hypervisor needs) |
| E5 | No public exposure: no Cloudflare Tunnel, and the backend bound to loopback or a private interface | `ss -ltnp` |
| E6 | **No model credentials.** The agents' CLI talks to the scripted stand-in `session-image/test/mock-anthropic.mjs` (as the CI smokes do) through each session's `ANTHROPIC_BASE_URL`. No key and no egress | Session env shows the mock URL and a fake key; the mock's request log |
| E7 | Root on the host (the backend container runs as root, as in production) and the session image's `developer` = uid/gid 1000 (`WORKSPACE_UID/GID` unset) | `docker exec <ctr> id developer` |

## 3. What is installed

- **Checkout:** `a09bf8a`, recorded as the full SHA with `git rev-parse HEAD`. Plus the mock: `session-image/test/` is already in the repo.
- **Session image:** a plain `docker build -t shared-terminal-session ./session-image`. This is a fresh host with no sessions, so CLAUDE.md's first-install path applies. Record the image id.
- **Backend:** `docker compose up -d --build`. Record the image id and the sha256 of `dist/**/*.js` (same method as the VM100 deploys).
- **Network:** `docker network create sessions-net` before `up`. The mock runs on it as a container named and aliased `mock-api`, exactly like `conversation-smoke.sh` Phase 1: the image's node runs `/t/mock-anthropic.mjs 8080 <request log>`.
- **`.env` (isolated host only).** Everything else stays unset:

  ```
  CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN / D1_DATABASE_ID   ← the disposable DB (E3)
  JWT_SECRET, SECRETS_ENCRYPTION_KEY                              ← generated here
  WORKSPACE_ROOT=/srv/d2-run/workspaces
  CONVERSATION_ENABLED=true
  CONVERSATION_ALLOW_USERS=<owner user id>       # new sessions are born with capture requested
  CONVERSATION_COMPOSER_ENABLED=true
  COMPOSER_CLI_VERSIONS=<the image's CLI version>
  PROJECT_CHAT_ENABLED=true
  PROJECT_CONVERSATION_ENABLED=true
  INGEST_REQUIRE_SESSION_ORIGIN=observe          # as in production; never `true` here either
  # PROJECT_ARTIFACTS_ENABLED  ← unset for P1, `true` from P2
  ```

  The `.env` is mode 600 and never appears in the evidence. The same goes for the cookie file of
  the test users.

## 4. Fixtures

| Item | Setup | Note |
| --- | --- | --- |
| `owner` | The first account (`needsSetup`), so it is admin | Its JWT is kept in a cookie file (600), only on the host |
| `other` | A second user via an invite | The cross-user checks (P5) |
| Sessions `dev`, `qa`, `ops` | Created by `owner`, each with `envVars` `ANTHROPIC_BASE_URL=http://mock-api:8080` and a fake `ANTHROPIC_API_KEY` (plain, not secret). Capture is requested at birth (E6, `CONVERSATION_ALLOW_USERS`) | In each one, start `claude` in the main tab as a person would. Wait until `GET /api/sessions/<sid>/conversations` shows one interactive conversation with `canSendInput: true` |
| Project `D2 run` | `POST /api/projects` | — |
| Agents `dev-a`, `qa-a`, `ops-a` | `POST /api/projects/:pid/agents {handle, sessionId, clientRequestId}`, one per session | Each binding at epoch 1 |
| Source files in `dev`, created **as uid 1000** with `docker exec -u developer` | `out/fix.diff`: a real `git diff` of a small repo change. `out/report.md`: UTF-8 text with non-ASCII. `out/big.txt`: 1 MiB + 1 B. `out/bin.dat`: contains NUL. `.env`, `.git/config`, `out/link.diff -> fix.diff` | The T9 sources |

Helper on the host (no secrets echoed):
`api() { curl -sS -b "$COOKIES" -H 'content-type: application/json' "http://127.0.0.1:3001/api$@"; }`

## 5. Phases

Each step has an expected result and a PASS condition. **Any FAIL stops the phase.** The operator
records the evidence of §6, and the run continues only if the owner (or B, for a non-destructive
re-check) says so.

### P0. Preflight (abort conditions)

1. E1–E7 checked and recorded. **Any miss ⇒ abort, nothing started.**
2. `git rev-parse HEAD` = `a09bf8a…`. `docker compose config` shows `PROJECT_ARTIFACTS_ENABLED: ""` while unset.
3. Backend boot log: `writer lock held` and `project conversation ENABLED (D1)`, with **no** `project artifacts ENABLED (D2)`. `.projects/.writer.lock` is mode `0600` (#601).

### P1. Flag off: D2 is inert (T23, real)

With all fixtures in place and the flag unset:

| Check | PASS |
| --- | --- |
| `GET /api/auth/status` | `features` has `projectConversation` and no `projectArtifacts` |
| `POST /projects/:pid/conversation/artifacts` and `GET …/artifacts/<64 hex>` | 404, the same body as an unknown path |
| `POST …/messages` with `artifacts: ["<64 hex>"]` | 409 `artifacts-off`. The log has no new line |
| D1 send to `qa-a` without artifacts | `delivered`, then `reply_ref exact`, unchanged from the D1 pilot |
| `find $WORKSPACE_ROOT -name .st-inbox`, and `.projects/<pid>/artifacts/` | nothing |

### P2. Activation

`PROJECT_ARTIFACTS_ENABLED=true` in `.env`, then `docker compose up -d --no-build --force-recreate app`.

**PASS:**
- the boot log has `project artifacts ENABLED (D2)`;
- `features.projectArtifacts: true`;
- recovery wrote nothing unexpected;
- `npm run projects:check-log` on the events page gives `ok`.

### P3. Dev → QA: one diff, verified by the receiver

1. **Register.** `POST …/artifacts {agentId: dev-a, path: "out/fix.diff"}` → 201.
   **PASS:**
   - `sha256` equals `sha256sum` of the source, run as uid 1000 in `dev`;
   - `.projects/<pid>/artifacts/<sha>` is `0600 root` and its bytes match;
   - one `artifact` event with `source{sid: dev, path: "out/fix.diff", agent_id: dev-a}`;
   - the same POST again → 200 `replayed: true` and no new event.
2. **Send** to `qa-a` with `artifacts: [<sha>]` and the text `Aplicá el diff adjunto.`
   **PASS:**
   - the deliveries go `planned → placing → sending{artifacts_placed:[{sha, ".st-inbox/<sha12>-fix.diff"}]} → delivered`;
   - the message carries `artifacts: [{sha256, name: "fix.diff", bytes}]`;
   - the capture's `user_prompt` in `qa` (`GET /api/sessions/<qa>/conversations/<cid>/events`) contains the line `[artefacto] fix.diff · <bytes> B · sha256 <sha> · ~/workspace/.st-inbox/<sha12>-fix.diff`.
3. **Receiver side,** all as uid 1000 inside `qa` (`docker exec -u developer qa …`). This is the agent's own identity and namespace. **PASS:**
   - `stat -c '%U:%G %a' ~/workspace/.st-inbox` → `developer:developer 755`;
   - the file → `developer:developer 644`, with no exec bit;
   - `sha256sum ~/workspace/.st-inbox/<sha12>-fix.diff` = `<sha>`;
   - `git apply --check` of it succeeds in `qa`'s copy of the repo;
   - the agent can `rm` the file and the empty inbox. The next placement recreates the inbox.
4. **Owner view.** `GET …/artifacts/<sha>` → 200, `text/plain; charset=utf-8`, `nosniff`, `attachment`, CSP `sandbox`, the exact bytes. The thread in A's UI (if built) shows the attachment and a "Delivered" chip.
5. **The agent's own verification (optional, decision O2).** With the stand-in extended by one scripted scenario (`ST_SCENARIO=sha256:<path>`, which makes the CLI run `sha256sum <path>` through its Bash tool), the CLI in `qa` computes the hash itself. **PASS:** the reply's text names `<sha>`.

### P4. Two recipients and partial failures

Each case is one message to **`qa-a` and `ops-a`**, with one artifact. Each recipient is judged on its own.

| # | Set-up (as uid 1000 in the target, unless noted) | Expected for that recipient | The other recipient |
| --- | --- | --- | --- |
| F0 | none | both `delivered`; each inbox has the file with the same sha; distinct composer ids and prompts | — |
| F1 | in `ops`: `rm -rf ~/workspace/.st-inbox; mkdir /tmp/outside; ln -s /tmp/outside ~/workspace/.st-inbox` | `not-sent{artifact-failed, artifact_error: inbox-not-dir, files_possibly_placed}`, 0 Composer calls (no `sending` line). `/tmp/outside` stays empty, and the symlink is untouched | `delivered` |
| F2 | in `ops`: a regular `.st-inbox`, plus a file at `<sha12>-<name>` with other content | `not-sent{artifact-failed, exists-different}`. The file's bytes, mode and mtime are unchanged | `delivered` |
| F3 | in `ops`: `mkfifo ~/workspace/.st-inbox/<sha12>-<name>` | the same `exists-different`. **The POST answers well inside 30 s** (no hang). The FIFO is untouched | `delivered` |
| F4 | `ops`'s CLI busy: a prompt `ST_SCENARIO=slow:200:500`, about 100 s of output | the file **is** placed (placement precedes the Composer), then `refused{busy}` with no retry. `artifacts_placed` is recorded on `sending` | `delivered` |
| F5 | `ops` session stopped (owner `POST …/stop`) | a stop releases the conversation's pane, so there is no target: `not-sent{no-target}` at `planned`, **no `placing`**, nothing written in `ops` | `delivered` |
| F6 | `ops-a` removed (`DELETE /projects/:pid/agents/<ops-a>`) before the send | `not-sent{agent-removed}`, **no `placing`**, nothing written in `ops` | `delivered` |
| F7 | after F1, the same `clientMessageId` POSTed again | replay with the identical answer, `filesPossiblyPlaced` included; 0 new log lines | — |

**PASS for P4** needs all of the following:
- every row as above;
- `projects:check-log` on the full page gives `ok` with 0 violations;
- for each message, `independence.distinctComposerIds` and `distinctSessions` are true;
- a host-wide sweep (§6, "outside-write sweep") finds nothing written outside the targets' `.st-inbox` directories and `.projects/`.

### P5. Source admission and authorization (T9, real)

| Request | PASS |
| --- | --- |
| `.env`, `.git/config` | 403 `artifact-restricted` |
| `out/link.diff` (symlink), `../../etc/passwd`, `/etc/passwd`, `out` (a directory) | 404 / 404 / 400 / 400 |
| `out/big.txt`, `out/bin.dat`, an empty file | 413 / 415 / 415 |
| `ops-a` (removed in F6) as source | 409 `agent-not-bound`, nothing read |
| `other` user: `GET …/artifacts/<sha>` and `POST …/artifacts` on the owner's project | 404 `project-not-found` and **zero bytes**; the same 404 for an unknown or malformed sha |

**PASS:** each row as listed, and no `artifact` event for any refused request.

### P6. Destructive (isolated host only)

Before P6: a backup (`docker compose exec app npm run backup`). Record its directory and manifest
sha256. Each step ends by checking the log with `projects:check-log`.

| # | Action | PASS |
| --- | --- | --- |
| K1 | **SIGKILL the backend during sends.** 10 rounds: send to `qa-a` + `ops-a` with an artifact, and `docker kill -s KILL <app>` at a random delay of 0–400 ms; then `up -d --no-build app` | After each restart: no delivery with two `sending` lines; every unfinished one is `not-sent{persist-failed[, files_possibly_placed]}` or `uncertain{orphaned}`; **0 new Composer calls after the restart** (capture `user_prompt` count). In every inbox, only complete files under final names (each sha256 matches) plus at most our hidden `.<16 hex>.tmp` files. The exact kill point is probabilistic; T12b proves the placement window deterministically |
| K2 | **Lost writer lock:** kill the `flock` helper inside the app container (`pkill -f 'flock --exclusive'`) | The backend logs `[projects] writer lock LOST`. A send gets 503 or `not-sent{persist-failed}`. **No file placed and no Composer call after the loss.** After `up -d --force-recreate app`: lock held, recovery lines written, log `ok` |
| K3 | **Real agent race.** In `ops`, as uid 1000, a loop for 60 s: `mv .st-inbox x; ln -s /tmp/outside .st-inbox; rm .st-inbox; mv x .st-inbox`. Meanwhile 20 sends to `ops-a` | Each delivery is either placed (file in a real directory under `ops`'s workspace, sha OK) or `artifact-failed`. `/tmp/outside` stays empty, and the outside-write sweep is clean |
| K4 | **Temp swap by the agent.** Loop in `ops`: for every `.*.tmp` that appears in the inbox, `mv` it away and write another file under its name. Meanwhile 10 sends | No delivery claims `artifacts_placed` for bytes that differ from the sha (check each placed path); swapped cases are `exists-different` |
| K5 | **Binding changed mid-flight.** P3a has no rebind API, so the change is a removal. Create a fresh agent `qa-b` on a fourth session, then send 10 messages to it, with an artifact, while `DELETE /projects/:pid/agents/<qa-b>` lands at a random delay of 0–300 ms | Each delivery is `delivered` to the session fixed at `planned`, or `not-sent{agent-removed|binding-changed|binding-unverified}`, with `files_possibly_placed` when it comes after a `placing`. Never a retry. The exact interleaving is probabilistic; T6 and the c0 test prove it deterministically |
| K6 | **Disk pressure (optional, decision O3):** a small loop-mounted filesystem as `qa`'s workspace, filled to the last KiB | `not-sent{artifact-failed, io}`, no partial file under a final name; the backend keeps serving |

### P7. Backup and restore with artifacts

1. **Backup:** `docker compose exec app npm run backup`.
   **PASS:**
   - the manifest's `projects.<pid>` lists `artifacts: N` (the registered count) with no `skipped`;
   - the tarball holds exactly `conversation.events.jsonl` and `artifacts/<64 hex>[.json]`, with no temps.
2. **Restore,** with the app stopped and the restore process's flag off:
   `docker compose stop app && docker compose run --rm --no-deps -e PROJECT_CONVERSATION_ENABLED= app npm run restore -- <dir> --force`.
   **PASS:**
   - the journal is closed;
   - `.projects/<pid>` is published with `RESTORED`;
   - the previous directory is kept under `.restore-replaced/` and **nothing is deleted**.
3. **Start the app.** **PASS:**
   - `recovery{source: restore}` is written;
   - every unfinished delivery is `uncertain{restored}`, with `files_possibly_placed` where it had a `placing`;
   - **0 Composer calls and 0 placements caused by the restore**;
   - `GET …/artifacts/<sha>` serves the same bytes;
   - registering the same source again → 200 `replayed`.
4. **T17, real (decision O4).** In a copy of the backup, repack the tarball with one artifact's bytes changed. Update that tarball's sha256 in the copy's manifest. Restore it. **PASS:**
   - the artifact goes to `.restore-evidence/projects/<pid>/` and is not published;
   - `GET` of that sha → 409 `artifact-corrupt`;
   - nothing else changes.

### P8. Rollback rehearsal

Unset `PROJECT_ARTIFACTS_ENABLED` and run `up -d --no-build --force-recreate app`. **PASS:**
- P1's checks hold again;
- `.projects/<pid>/artifacts/` and every inbox file stay where they are, untouched;
- D1 sends without artifacts keep working.

This is the production rollback: no data step, only the flag.

### P9. End of run

- **The report.** It is the evidence of §6, with a PASS/FAIL per step.
- **The host.** It stays as it is until the owner decides. **Nothing is deleted by the run**: no prune, the disposable D1 database is kept, and the backups are kept. Tearing the host down is a separate step after the report is accepted.

## 6. Evidence (no secrets)

**What is recorded:**
- For each step: the command (with the cookie path, never its content), the HTTP status and body, and timestamps.
- The events page, redacted with the same method as the D1 pilot (#595): `del(.text)`, plus consistent pseudonymization of ids and hashes if it leaves the host. Then `projects:check-log` on it.
- `stat` lines (owner, mode, size, mtime) and `sha256sum` of every artifact, inbox file and source.
- The relevant boot-log lines (`[projects]`, `[server]`).
- The outside-write sweep: on the host, `find / -xdev \( -path /proc -o -path /sys -o -path $WORKSPACE_ROOT \) -prune -o -newer <run-start marker> -print`, plus the targets' trees. No file may appear outside `.projects/`, the targets' `.st-inbox`, the backups and the expected logs.
- The image ids, the full SHA and the `dist` hash.

**What is never recorded:**
- `.env`, cookies, JWTs, the D1 token, ingest tokens (`/proc/*/environ`) and the stand-in's fake key;
- message text beyond the fixed test strings above, and file contents beyond the test fixtures' hashes.

**Format:** one directory per run, `SHA256SUMS` of every file in it, mode 700, kept on the isolated host. A redacted summary goes to #595.

## 7. Abort and rollback

**Abort immediately, record and stop** on any of these:
- a write by root outside `.projects/`, the targets' `.st-inbox` or the backups;
- a file published under a final name with bytes that do not match its sha;
- a second `sending` for one delivery, or a Composer call after a known loss or after a restore;
- a hang over 30 s;
- any sign that the host is not isolated (E1–E7).

Rollback inside the run is P8, the flag only. Nothing in this runbook touches VM100, so there is
nothing to roll back there.

## 8. What this run does not prove

- A real model's behaviour on an artifact. The stand-in is scripted, and O2 only adds a `sha256sum`.
- The 256 MiB project quota at full size. It is proven at a small scale by the tests.
- The exact SIGKILL point between `placing` and `sending`. K1 is probabilistic; T12b proves it deterministically.
- Multi-host or multi-backend behaviour. The single-writer lock is already T22b.
- The frontend, which A validates separately against Appendix A.2.

## 9. Decisions for the owner (scope review)

| # | Decision | B's recommendation |
| --- | --- | --- |
| O1 | The isolated host: a new disposable VM, or the PASS-B-style isolated VM on the same Proxmox | Either, if E1–E7 hold. A disposable D1 database in the dedicated account is required (E3) |
| O2 | Extend the stand-in with one scripted scenario (`ST_SCENARIO=sha256:<path>`, in `session-image/test/mock-anthropic.mjs`, test-only) so the receiving **CLI** computes the hash itself, in addition to the uid-1000 check of P3.3 | Yes. Small, test-only, and it runs through the Session Image CI. It needs your OK because it touches `session-image/` |
| O3 | Include K6 (disk full, a loop-mounted workspace) | Optional. The `io` mapping is generic; include it only if the host allows loop devices |
| O4 | Include the hand-repacked T17 in P7.4 | Yes, on a copy of the backup only |
| O5 | Who runs it, and when | A, after the D1/WS smoke closes. B stays reachable in #595 during the run |
| O6 | A real model instead of the stand-in | No, for this run. It needs a credential and egress, and adds nothing to D2's guarantees |

After a PASS, activation on VM100 is still a separate operational GO with its own plan, prepared with
A: flag only, `--no-build`, rollback = P8.

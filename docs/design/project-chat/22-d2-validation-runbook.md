# D2 artifacts: real validation runbook (isolated environment)

Status: **scope approved by the owner (2026-11-12, decisions in §9). Not executed.** Approving the
scope is not a GO to run it: execution needs a **separate operational GO**, after the owner has
reviewed A's exact VM, resources and preflight. None of it runs on VM100.

The code under test is **`a09bf8a`, the experiment's frozen SHA**. That is the main at which D2
was merged; it is **not** "whatever main is now". The run checks out exactly that commit even if main
has moved, and a later main is a different experiment. `PROJECT_ARTIFACTS_ENABLED` is off everywhere. The contract is `docs/PROJECT_CONVERSATION.md` §6 (v0.3.2), §3.3 steps b–S2b and §8.
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
| E2 | Its own Docker daemon. A dedicated disk mounted **at `/var/shared-terminal/workspaces`**, the path the backend uses inside its container **and** hands to the host daemon as each session's bind source (`dockerManager.ts`). A different host path would split the backend's view of the workspaces from the sessions' | `docker info --format '{{.ID}}'`; `findmnt -T /var/shared-terminal/workspaces`; after the fixtures, `docker inspect <session> --format '{{json .HostConfig.Binds}}'` names that same path |
| E3 | **No production credentials.** A **new, empty D1 database** in the dedicated account, created for this run, with a token scoped to it. Fresh `JWT_SECRET` and `SECRETS_ENCRYPTION_KEY` generated on the host. No VM100 `.env` is copied | `D1_DATABASE_ID` ≠ production's (compare the hash only). `GET /api/auth/status` → `needsSetup: true` before setup |
| E4 | No mount or route to the NAS, to VM100 or to its backups | `findmnt`, `ip route` (no VM100 or NAS subnet routes beyond what the hypervisor needs) |
| E5 | No public exposure: no Cloudflare Tunnel, and the backend published **on loopback only** (`PORT=127.0.0.1:3001` in `.env`; compose publishes `${PORT}:3001`, and Docker's NAT bypasses a host firewall) | `ss -ltnp` shows `127.0.0.1:3001` only |
| E6 | **No model credentials, no session egress** (details below the table) | `docker exec <s> printenv ANTHROPIC_BASE_URL` only, plus `printenv ANTHROPIC_API_KEY \| sha256sum`, never the value. An in-session `curl -m 5 https://example.com` **must fail**. The mock's request log is non-empty |
| E7 | Root on the host (the backend container runs as root, as in production) and the session image's `developer` = uid/gid 1000 (`WORKSPACE_UID/GID` unset) | `docker exec <ctr> id developer` |

**E6 in detail.**
- **The model.** The agents' CLI talks to the scripted stand-in `session-image/test/mock-anthropic.mjs`, as the CI smokes do, through each session's `ANTHROPIC_BASE_URL`.
- **Session egress** is dropped by a `DOCKER-USER` rule keyed on the **`sessions-net` subnet**, so a session restart cannot make it stale.
- **`app`'s exemption.** The rule allows traffic inside the subnet and exempts `app`'s address there, so `app` keeps its egress to the D1 API. That address is **fixed** (§3, Network), because `app` is restarted many times (P2, K1, K2, P7, P8).
- **The `curl` check** runs after every session start.
- **Session env.** Sessions also carry `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and `DISABLE_AUTOUPDATER=1`.

## 3. What is installed

- **Checkout:** the frozen SHA `a09bf8a` (`git checkout --detach a09bf8a`, never `main`) for the backend and the session image. Record it as the full SHA with `git rev-parse HEAD`.
- **The mock alone** comes from the O2 PR's merge SHA (#604), because `a09bf8a` predates the `sha256` scenario. Use a second checkout at that SHA, and mount only its `session-image/test/` as `/t`. Record the second SHA and the `sha256sum` of `mock-anthropic.mjs`. Nothing else is taken from it.
- **Session image:** a plain `docker build -t shared-terminal-session ./session-image`. This is a fresh host with no sessions, so CLAUDE.md's first-install path applies. Record the image id.
- **After every app start** (P2, K1, K2, P7, P8):
  - the boot log reaches `[server] listening on`, which comes only after the D1 migrations finished, so D1 is reachable;
  - `docker inspect "$(docker compose ps -q app)" --format '{{(index .NetworkSettings.Networks "sessions-net").IPAddress}}'` shows the pinned address. If not, the egress rule no longer matches: **stop and fix the environment**, it is not a D2 FAIL.
- **Backend:** `docker compose up -d --build`. Record the image id and the sha256 of `dist/**/*.js` (same method as the VM100 deploys).
- **Network,** before `up`:
  - `docker network create --subnet <cidr> --ip-range <cidr that excludes the reserved address> sessions-net`;
  - a host-only `docker-compose.override.yml` pins `app`: `services: { app: { networks: { sessions-net: { ipv4_address: <reserved> } } } }`. The mock runs as uid 1000 and dies on its first request if it cannot write its log, so create its directory first: `install -d -o 1000 -g 1000 -m 0700 <evidence>/mock`. The mock runs on it as a container named and aliased `mock-api`, exactly like `conversation-smoke.sh` Phase 1: `docker run -d --name mock-api --network sessions-net --network-alias mock-api -v <repo-at-O2-sha>/session-image/test:/t:ro -v <evidence>/mock:/out --entrypoint node shared-terminal-session /t/mock-anthropic.mjs 8080 /out/model-requests.jsonl`.
- **`.env` (isolated host only).** Everything else stays unset:

  ```
  CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN / D1_DATABASE_ID   ← the disposable DB (E3)
  JWT_SECRET, SECRETS_ENCRYPTION_KEY                              ← generated here
  WORKSPACE_ROOT=/var/shared-terminal/workspaces   # = the dedicated disk's mount point (E2)
  PORT=127.0.0.1:3001                              # loopback only (E5)
  CONVERSATION_ENABLED=true
  CONVERSATION_ALLOW_USERS=<owner user id>       # set AFTER the owner exists (§4), then recreate app
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
| `owner` | The first account (`needsSetup`), so it is admin. Then put its user id in `CONVERSATION_ALLOW_USERS` and recreate `app` (`up -d --no-build --force-recreate app`) **before** creating sessions | Its JWT is kept in a cookie file (600), only on the host |
| `other` | A second user via an invite | The cross-user checks (P5) |
| Sessions `dev`, `qa`, `ops`, `extra` | Created by `owner`, each with `envVars` `ANTHROPIC_BASE_URL=http://mock-api:8080`, a fake `ANTHROPIC_API_KEY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and `DISABLE_AUTOUPDATER=1` (plain entries). Capture is requested at birth (`CONVERSATION_ALLOW_USERS`) | Before the first launch, seed the CLI's onboarding, key approval and workspace trust exactly as `conversation-smoke.sh`'s `seed_claude_state` does, so no prompt blocks it. Then start `claude` in the main tab. Wait until a plain `GET /api/sessions/<sid>/conversations` (**without** `?capture=0`) shows one interactive conversation with `canSendInput: true`. Only the full GET probes capture and refreshes the Composer's in-memory view of it. With `?capture=0` the value stays `false` after every backend restart. (Re-do this after any stop/start: §5 P5b, P7) |
| Project `D2 run` | `POST /api/projects` | — |
| Agents `dev-a`, `qa-a`, `ops-a` | `POST /api/projects/:pid/agents {handle, sessionId, clientRequestId}`, one per session (`extra` stays unbound until K5) | Each binding at epoch 1. Handles of removed agents stay reserved (PROJECTS.md §4.3), so a replacement always gets a **new** handle |
| Source files in `dev`, created **as uid 1000** with `docker exec -u developer` | `out/fix.diff`: a real `git diff` of a small repo change. `out/report.md`: UTF-8 text with non-ASCII. `out/copy.diff`: a byte copy of `fix.diff`. `out/notes.txt`: a second small text file. `out/big.txt`: 1 MiB + 1 B. `out/bin.dat`: contains NUL. `.env`, `.git/config`, `out/link.diff -> fix.diff` | The T9 sources |
| Source file in `extra`, as uid 1000 | `out/other.txt`, with content used nowhere else | P5, the second project |

Helper on the host (no secrets echoed):
`api() { curl -sS -b "$COOKIES" -H 'content-type: application/json' "http://127.0.0.1:3001/api$@"; }`

## 5. Phases

Each step has an expected result and a PASS condition. **Any FAIL stops the phase.** The operator
records the evidence of §6, and the run continues only if the owner (or B, for a non-destructive
re-check) says so.

### P0. Preflight (abort conditions)

0. **#604 (the O2 mock) is merged**, and its merge SHA is recorded for the mock checkout (§3). Without it, P3.5 cannot run.
1. E1–E7 checked and recorded. **Any miss ⇒ abort, nothing started.**
2. `git rev-parse HEAD` = `a09bf8a…`, the frozen SHA, whatever main is at run time. `docker compose config --format json | jq -r '.services.app.environment.PROJECT_ARTIFACTS_ENABLED'` prints an empty line while unset. **Never record the full `docker compose config`: it prints every secret.**
3. Backend boot log: `writer lock held` and `project conversation ENABLED (D1)`, with **no** `project artifacts ENABLED (D2)`. `.projects/.writer.lock` is mode `0600` (#601).
4. The outside-write marker: `touch <evidence>/run-start` (§6).

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
5. **The agent's own verification (O2, approved).** The stand-in gains one scripted scenario: `ST_SCENARIO=sha256:<path>`. It makes the CLI run `sha256sum -- <path>` through its own Bash tool, then the closing text echoes the hash the tool printed. The scenario accepts only an inbox path of the exact shape `.st-inbox/<12 hex>-<name>` (its own PR, `session-image/test/` only).
   - **Setup:** for this one prompt, `qa`'s CLI must be able to run that command without a dialog. Add `"permissions": {"allow": ["Bash(sha256sum:*)"]}` to the seeded `~/.claude/settings.json` (§4), rather than `--dangerously-skip-permissions`.
   - **Send:** to `qa-a`, the text `ST_SCENARIO=sha256:.st-inbox/<sha12>-fix.diff`, **with `artifacts: [<sha>]`**. P3.3 had the agent delete its inbox, so the placement recreates the file this prompt hashes.
   - **PASS:**
     - the `reply_ref` is `exact`, and its text (the capture's `last_assistant_message`) is, after trimming whitespace, `sha256 <sha> .st-inbox/<sha12>-fix.diff`;
     - **and** the mock's request log shows, for that turn, a `tool_result` whose output line is `<sha>  .st-inbox/<sha12>-fix.diff`. Record only that line's hash (§6).

     The `<sha>` is also in the prompt (the artifact line), so the reply alone cannot prove the CLI computed it. The mock echoes **only** the line `sha256sum` printed for that exact path, and the request log shows that output came from the tool.

### P4. Two recipients and partial failures

Each case is one message to **`qa-a` and `ops-a`**, with one artifact. Each recipient is judged on its own.

| # | Set-up (as uid 1000 in the target, unless noted) | Expected for that recipient | The other recipient |
| --- | --- | --- | --- |
| F0 | none | both `delivered`; each inbox has the file with the same sha; distinct composer ids and prompts | — |
| F1 | in `ops`: `rm -rf ~/workspace/.st-inbox; mkdir ~/workspace/trap; ln -s trap ~/workspace/.st-inbox` (a **relative** link inside the bind mount: an absolute target would resolve in another mount namespace and could never catch a follow) | `not-sent{artifact-failed, artifact_error: inbox-not-dir, files_possibly_placed}`, 0 Composer calls (no `sending` line). From the **host**, `<WORKSPACE_ROOT>/<ops>/trap/` stays empty, and the symlink is untouched | `delivered` |
| F2 | in `ops`: a regular `.st-inbox`, plus a file at `<sha12>-<name>` with other content | `not-sent{artifact-failed, exists-different}`. The file's bytes, mode and mtime are unchanged | `delivered` |
| F3 | in `ops`: `mkfifo ~/workspace/.st-inbox/<sha12>-<name>` | the same `exists-different`. **The POST answers well inside 30 s** (no hang). The FIFO is untouched | `delivered` |
| F4 | `ops`'s CLI busy: a prompt `ST_SCENARIO=slow:200:500`, about 100 s of output | the file **is** placed (placement precedes the Composer), then `refused{busy}` with no retry. `artifacts_placed` is recorded on `sending`. **Wait for `ops` to be idle again before F5** | `delivered` |
| F5 | `ops` session stopped (owner `POST …/stop`) | a stop releases the conversation's pane, so there is no target: `not-sent{no-target}` written in S1 (no `planned`), **no `placing`**, nothing written in `ops` | `delivered` |
| F6 | `ops-a` removed (`DELETE /projects/:pid/agents/<ops-a>`) before the send | `not-sent{agent-removed}`, **no `placing`**, nothing written in `ops` | `delivered` |
| F7 | after F1, the same `clientMessageId` POSTed again | a replay: the same `msgId`, `replayed: true`, the same state and reason per agent, `filesPossiblyPlaced: true` on `ops-a`, and **no `http` field** (a replay is rebuilt from the log, §3.4; it is not byte-identical to the first answer). 0 new log lines | — |

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
| a sha registered only in a **second project** of the same owner, sent in this project / fetched here | 400 `artifact-unknown` / 404 |
| 5 artifacts in one message | 400 `too-many-artifacts`, nothing written |
| the same content as `out/fix.diff` registered from `out/copy.diff` | 201 with `name: "fix.diff"` (taken from the first registration), and a second `artifact` event for a sha already in the log, so it counts once toward the quota |

**PASS:** each row as listed, and no `artifact` event for any refused request.

The second project in the first row binds its agent to `extra` and registers `extra:out/other.txt`, whose sha `D2 run` does not have. Remove that agent before K5.

### P5b. Re-arm `ops` for P6

P4 stopped `ops` and removed `ops-a`. `POST /api/sessions/<ops>/start`, seed and relaunch `claude`
(§4), wait for `canSendInput`, and create **`ops-b`** on `ops`. P6 uses `ops-b`.

Then one partial failure across two artifacts:
1. In `ops`, as uid 1000, clear what F2 and F3 left: `rm -rf ~/workspace/.st-inbox`.
2. Register `out/report.md` and `out/notes.txt`.
3. In `ops`, create `.st-inbox` with a foreign file **only** at the second one's `<sha12>-notes.txt`.
4. Send one message with both, to `qa-a` + `ops-b`.

**PASS:**
- `qa-a` is `delivered` with both artifacts;
- `ops-b` is `not-sent{artifact-failed, exists-different, files_possibly_placed}`;
- the **first** artifact is present in `ops`'s inbox, verified by its sha;
- the foreign file is untouched.

### P6. Destructive (isolated host only)

Before P6: a backup (`docker compose exec app npm run backup`). Record its directory and manifest
sha256. Each step ends by checking the log with `projects:check-log`.

**K3 and K4: how they are judged.**
- **Stop the competitors first.** The racing loops are the agent's own processes, started through a separate `docker exec`. They are stopped with `docker exec <ops> pkill -u 1000 -f <loop marker>`, then a poll until `docker exec <ops> pgrep -u 1000 -f <loop marker>` is empty. Both run **without a `bash -c` wrapper**, which would itself match the marker. Only then is the final state evaluated, and never while a loop can still move something.
- **What the loops can touch.** Neither ever writes a final name. K3 only renames the inbox directory to `x` or puts a link in its place. A backend recreating `.st-inbox` mid-loop can leave `x` nested as `.st-inbox/x`, which is the agent's doing. K4 only replaces `.<16 hex>.tmp` names.
- **Locating a claimed file.** It is located after the stop **only** in the allowed places: the inbox, or a chain of real directories named `x` below `.st-inbox` or `x`. Each backend recreation mid-loop pushes the old inbox one level deeper. The command is `find <WORKSPACE_ROOT>/<ops>/.st-inbox <WORKSPACE_ROOT>/<ops>/x -name trap -prune -o -type f -name '<sha12>-<name>' -print`, and the relative path of every hit must match `^(\.st-inbox|x)(/x)*/<sha12>-<name>$`. Record the depth seen.
- **Not a FAIL.** A claimed file found in one of those places with its sha, or a final name the agent itself published by swapping a temp (K4, `exists-different` in the log).
- **FAIL, an explicit list:**
  - a claimed file whose bytes differ from its sha;
  - a claimed file not found in the allowed places;
  - **any file at all under `trap/`**: the link target, so something followed the link;
  - any sweep hit (§6).
- **Before the next row,** the inbox is restored to a plain directory.

| # | Action | PASS |
| --- | --- | --- |
| K1 | **SIGKILL the backend during sends.** 10 rounds: send to `qa-a` + `ops-b` with an artifact, and `docker kill -s KILL <app>` at a random delay of 0–400 ms; then `up -d --no-build app` | After each restart: no delivery with two `sending` lines; every unfinished one is `not-sent{persist-failed[, files_possibly_placed]}` or `uncertain{orphaned}`; **0 new Composer calls after the restart** (capture `user_prompt` count). In every inbox, only complete files under final names (each sha256 matches) plus at most our hidden `.<16 hex>.tmp` files. The exact kill point is probabilistic; T12b proves the placement window deterministically |
| K2 | **Lost writer lock:** the app image has no `pkill`, so from the **host**: `pgrep -af 'flock --exclusive --nonblock --close'`, check with `docker top <app>` that exactly one such pid belongs to the app container, then `kill <pid>` | The backend logs `[projects] writer lock LOST`. A send gets 503 or `not-sent{persist-failed}`. **No file placed and no Composer call after the loss.** After `up -d --force-recreate app`: lock held. Recovery lines are written **only if** a delivery was in flight at the loss. The log is `ok` |
| K3 | **Real agent race.** In `ops`, as uid 1000, a loop for 60 s: `mv .st-inbox x; ln -s trap .st-inbox; rm .st-inbox; mv x .st-inbox` (relative `trap`, as F1). Meanwhile 20 sends to `ops-b` | Judge the **placement** only; any text-delivery state is acceptable (overlapping sends may give `send-in-progress` or `busy`). Each delivery is placed (the claimed `artifacts_placed` path is a regular file in a real directory of `ops`'s workspace, sha OK), or `artifact-failed`, or never reached `placing` (e.g. `no-target` while an overlapping send holds the pane). `<WORKSPACE_ROOT>/<ops>/trap/` stays empty (host view), and the sweep is clean |
| K4 | **Temp swap by the agent.** Loop in `ops`: for every `.*.tmp` that appears in the inbox, `mv` it away and write another file under its name. Meanwhile 10 sends to `ops-b` | No delivery claims `artifacts_placed` for bytes that differ from the sha (check each **claimed** path). Swapped cases are `exists-different`. The agent's own file may then sit under the final name: §6.4 publishes by `link` and judges afterwards. That is expected, not an abort |
| K5 | **Binding changed mid-flight.** P3a has no rebind API, so the change is a removal, and an agent can be removed only once. 10 rounds, each with a fresh agent `x-1` … `x-10` on `extra` (only live bindings are unique, so `extra` is free again after each removal): one send to it with an artifact, and `DELETE /projects/:pid/agents/<x-n>` at a random delay of 0–300 ms | Each delivery is `delivered` to the session fixed at `planned`, or `not-sent{agent-removed|binding-changed|binding-unverified}`, with `files_possibly_placed` when it comes after a `placing`. Never a retry. The exact interleaving is probabilistic; T6 and the c0 test prove it deterministically |
| K6 | **Excluded from the first run (O3).** Kept here for a later run. **Disk pressure:** a small loop-mounted filesystem as `qa`'s workspace, **mounted on the host before `qa` and `app` start** (or bind propagation hides it), filled to the last KiB | `not-sent{artifact-failed, io}`, no partial file under a final name; the backend keeps serving |

### P7. Backup and restore with artifacts

**What a restore does beyond `.projects`:**
- `npm run restore` also restores the D1 tables, marking every `running` session `stopped` with no container.
- It untars every workspace into `WORKSPACE_ROOT`, overwriting files, `.st-inbox` included.

So all four sessions (`dev`, `qa`, `ops`, `extra`) are stopped before the restore, and started
again only **after P7.4** (which restores a second time). "Nothing deleted" below refers to
`.projects`.

0. **An unfinished delivery inside the backup.** Otherwise P7.3's `uncertain{restored}` has nothing to show.
   1. With the sessions running, SIGKILL the app mid-send, as in K1.
   2. From the host, confirm that `.projects/<pid>/conversation.events.jsonl` has a delivery with no result.
   3. Take the backup **with the app down**: `docker compose run --rm --no-deps app npm run backup` (a backup takes no lock).
   4. `up -d --no-build app`. Boot recovery closes that delivery in the live log, but the backup keeps it open.
   5. `POST …/stop` for all four sessions, then `docker compose stop app`.

   If no round leaves an unfinished delivery, record that and judge P7.3's `uncertain{restored}` as "not exercised", not FAIL.
1. **The backup from step 0.**
   **PASS:**
   - the manifest's `projects.<pid>` lists `artifacts: N` (the registered count) with no `skipped`;
   - the tarball holds exactly `conversation.events.jsonl` and `artifacts/<64 hex>[.json]`, with no temps.
2. **Restore,** with the app stopped and the restore process's flag off:
   `docker compose run --rm --no-deps -e PROJECT_CONVERSATION_ENABLED= app npm run restore -- /var/shared-terminal/workspaces/.backups/<ts> --force`. The path is the in-container one.
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
4. **T17, real (decision O4).** In a copy of the backup, repack the tarball with one artifact's bytes changed. **List regular files only**, as `backupProjects` does, because the restore preflight refuses any directory member:
   `tar -czf <pid>.tar.gz -C <stage> -- .projects/<pid>/conversation.events.jsonl .projects/<pid>/artifacts/<sha> .projects/<pid>/artifacts/<sha>.json …`.
   Update that tarball's sha256 in the copy's manifest. With the app stopped again, restore it, then start the app. **PASS:**
   - the artifact goes to `.restore-evidence/projects/<pid>/` and is not published;
   - `GET` of that sha → 409 `artifact-corrupt`;
   - nothing else changes.
5. **Re-arm for P8.** Start the four sessions, seed and relaunch `claude` (§4), and wait for `canSendInput`. **PASS:**
   - `canSendInput: true` on all four sessions;
   - E6's in-session `curl` still fails;
   - the app reaches D1 (§3, "after every app start").

### P8. Rollback rehearsal

Unset `PROJECT_ARTIFACTS_ENABLED` and run `up -d --no-build --force-recreate app`. **PASS:**
- P1's **API** checks hold again: no route, 409 `artifacts-off`, no feature. P1's "no `.st-inbox`, no `artifacts/`" does not apply after a run;
- `.projects/<pid>/artifacts/` and every inbox file stay where they are, untouched;
- D1 sends without artifacts keep working.

This is the production rollback: no data step, only the flag.

### P9. End of run

- **The report.** It is the evidence of §6, with a PASS/FAIL per step.
- **The host.** It stays as it is until the owner decides. **Nothing is deleted by the run**: no prune, the disposable D1 database is kept, and the backups are kept. Tearing the host down is a separate step after the report is accepted.

## 6. Evidence (no secrets)

**What is recorded:**
- **HTTP evidence is recorded by allowed fields only**, extracted with `jq`, never as raw bodies:
  - the status, plus the response's `error`/`detail`, `msgId`, `replayed`, `deliveries[].{agentId,state,reason,filesPossiblyPlaced}`, `sha256`, `name`, `bytes`, `features`, and the ids of the project, agents and sessions;
  - for a GET of artifact content: the status, the response headers and `sha256sum` of the body, never the body itself;
  - **never the request or response bodies of setup, login, register, invites or any other `/auth/*` call** (passwords, invite codes, tokens, `Set-Cookie`). For those, the status line alone. The one exception is `GET /api/auth/status`, from which `needsSetup`, `authenticated` and `features` are recorded (E3, P1, P2, P8).
  
  Also recorded: the command (with the cookie path, never its content) and timestamps.
- The events, redacted with the same method as the D1 pilot (#595): `del(.text)`, plus consistent pseudonymization of ids and hashes if it leaves the host. Then `projects:check-log` on them. The checker reads one page of at most 500 lines: page with `before=oldestSeq` and concatenate the pages into one array before checking, or the report carries a "page has more" note.
- `stat` lines (owner, mode, size, mtime) and `sha256sum` of every artifact, inbox file and source.
- The relevant boot-log lines (`[projects]`, `[server]`).
- **The outside-write sweep:** files owned by **uid 0**, newer than `<evidence>/run-start`, under `WORKSPACE_ROOT`:
  `find /var/shared-terminal/workspaces -xdev -uid 0 -type f -newer <evidence>/run-start -print`. Files only: root's own directories change mtime as a matter of course.
  - It is minus an allowlist of where root legitimately writes:
    - `.projects/`;
    - `.st-control/` (pane records, `relay.enabled`, `defer-skill-seed`);
    - `.claude-managed/` (each capturing session's `conversation.json`);
    - `.uploads/`;
    - `.conversations/`;
    - `.backups/`, `.restore-*`, `.restore-evidence/`.
  - **Inside a session's workspace, uid-0 files may appear only under its `.st-inbox`.** Inbox files are root's only until their `fchown`, and an orphan temp may stay root's.
  - A second sweep looks for uid-1000 **files** outside the workspaces, newer than the marker: It covers only the places a root-backend escape could plausibly reach, not the container stores or `/tmp`: `find /etc /root /srv /opt /usr/local /var -xdev \( -path /var/lib/docker -o -path /var/lib/containerd -o -path /var/shared-terminal/workspaces -o -path <evidence> \) -prune -o -uid 1000 -type f -newer <evidence>/run-start -print`. It must find nothing.
- The image ids, the full SHA and the `dist` hash.

**What is never recorded:**
- `.env`, cookies, JWTs, the D1 token, ingest tokens (`ST_INGEST_TOKEN`, in every capturing session's env) and the stand-in's fake key;
- the full output of `docker compose config`, `docker inspect` (`.Config.Env`) or `printenv` in a session.
- message text beyond the fixed test strings above, and file contents beyond the test fixtures' hashes.

**Format:** one directory per run, `SHA256SUMS` of every file in it, mode 700, kept on the isolated host. A redacted summary goes to #595.

## 7. Abort and rollback

**Abort immediately, record and stop** on any of these:
- a sweep hit (§6) outside the allowlist;
- a path the log **claims** in `artifacts_placed` whose bytes do not match its sha. An agent's own file under a final name after K4 or F2 is expected;
- a second `sending` for one delivery, or a Composer call after a known loss or after a restore;
- a hang over 30 s;
- any sign that the host is not isolated (E1–E7).

Rollback inside the run is P8, the flag only. Nothing in this runbook touches VM100, so there is
nothing to roll back there.

## 8. What this run does not prove

- A real model's behaviour on an artifact. The stand-in is scripted, and O2 only adds a `sha256sum`.
- The 256 MiB project quota at full size. It is proven at a small scale by the tests. P5 covers its "count once" rule.
- The exact SIGKILL point between `placing` and `sending`. K1 is probabilistic; T12b proves it deterministically.
- Multi-host or multi-backend behaviour. The single-writer lock is already T22b.
- The frontend, which A validates separately against Appendix A.2.

## 9. Decisions (owner, 2026-11-12)

| # | Decision |
| --- | --- |
| O1 | A **new, disposable VM on the same Proxmox**. E1–E7 isolation is mandatory |
| O2 | **Approved:** extend the stand-in so the receiving CLI computes the SHA-256 (P3.5). Its own PR, only under `session-image/test/`, with tests and strict validation of the path the scenario accepts. No production change |
| O3 | **K6 (disk full) excluded** from this first run |
| O4 | **T17 included**, altering only a **copy** of the backup |
| O5 | **A is the operator**, after closing the D1/WS smoke. A prepares the VM plan and its preflight for the owner's review **without running any scenario** |
| O6 | **The stand-in model**, no real credentials |

**Scope approval is not an execution GO.** The run starts only after the owner reviews A's exact
environment, resources and procedure, and gives the operational GO.

After a PASS, activation on VM100 is still a separate operational GO with its own plan, prepared with
A: flag only, `--no-build`, rollback = P8.

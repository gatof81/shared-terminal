# Projects & Agents: first pilot plan (proposal)

Status: **proposal, 2026-11-10. Nothing here is authorized.** Each window below needs its own owner GO.
Owner of the plan: Claude A (frontend, QA, deploy). Backend contract: [docs/PROJECTS.md](../PROJECTS.md) (Claude B).

## Goal
Use Projects & Agents for real, on **new pilot sessions only**, to learn whether the first version is useful. The questions to answer:
- Can the owner go from a project to an agent, and to its Chat or Terminal, quickly, on desktop and phone?
- Is the state of each agent honest: no invented "Working", "Needs you" only for an explicit request?
- Does creating and removing agents behave predictably?

**Constraint:** the existing sessions (B, HA, HZ, A) are not bound, recreated or otherwise affected.

## What already exists (verified on main)
| Piece | State |
|---|---|
| D1 directory (migration v19) | deployed with `2a676db` (2026-11-10); the four tables are empty |
| API `/api/projects/*`, `binding` on `/api/sessions`, `features.projectChat` | in the deployed backend, **not mounted**: `PROJECT_CHAT_ENABLED` is off |
| Frontend (#559, #563–#565, #569, #573) | on Pages; hidden until `features.projectChat` |
| Presence freshness fix (#568 → #572, contract v1.9.1) | merged as `c36078e`; **not deployed yet** (release R1) |

## Preconditions (all required before the activation window)
1. **R1 deployed and verified** (`c36078e`): without it, a silence probe can make an old "Working" look fresh. This was reproduced on production on 2026-11-10.
2. A fresh verified backup (the release scripts' `02`/`02b`).
3. B idle, no operation in flight, outside 08:00–09:00Z (the usual gates).
4. #574 (push) and A's own session migration are **independent**; neither blocks nor is mixed with the pilot.

## Decisions for the owner
| # | Question | Options | Recommendation |
|---|---|---|---|
| D1 | How do the pilot sessions get conversation capture? (Presence and Chat need it.) A session's container is created at once, so capture must be requested **at creation**. | (a) `CONVERSATION_ALLOW_USERS=<owner's user id>` in `.env`. Read at boot; every **new** session of the owner is then born with capture requested; existing sessions are untouched. (b) Create the sessions, enable capture by admin `PATCH`, then **recreate** each one (the §2.7 engine). | **(a)**, in the same restart as D2: one window, two `.env` lines, no recreation. |
| D2 | Turn on `PROJECT_CHAT_ENABLED=true`. The flag is **global**: the two other accounts (both admins) would see an empty Projects section; data is owner-only (others get 404). | on in the activation window / not yet | on, together with D1 |
| D3 | Pilot sessions | 2 new sessions, `pilot-dev` and `pilot-qa`, caps 2 CPU / 4 GiB each, current session image (CLI 2.1.314). Host today: 12 cores, 23 GiB (18 GiB available), 36 GB disk free. | as proposed |
| D4 | Claude login in the pilot sessions | the owner runs the official `/login` in each one (a human step); credentials are never copied from another session | as proposed |
| D5 | Duration | 3–5 days, with a daily read-only readout | 3 days, then decide |

## Activation window (needs GO)
Same mechanics as the previous releases: a script set with gates, a rollback tag, and an `.env` copy plus a one-line-per-key diff. **No code change:** the image stays the one R1 deployed.

1. **Preflight** (read only): the image is R1's; the four P3a tables are empty; `PROJECT_CHAT_ENABLED` and `CONVERSATION_ALLOW_USERS` are absent from `.env`; no session is bound.
2. **Backup** `pre-pilot-*` (private) and its NAS copy, verified.
3. **`.env`:** add exactly `PROJECT_CHAT_ENABLED=true` and `CONVERSATION_ALLOW_USERS=<owner id>`. Check the diff (two lines) and `docker compose config`.
4. **Restart:** `up -d --no-deps --no-build --force-recreate -t 30 app` (only `app`).
5. **Verify:**
   - `/api/auth/status` has `features.projectChat: true`;
   - `GET /api/projects` answers 200 with an empty list;
   - `/api/sessions`: every existing session carries `binding: null`;
   - the existing sessions are identical (containers, claude processes, panes);
   - capture is effective on B/HA/HZ;
   - Composer is idle;
   - `INGEST_REQUIRE_SESSION_ORIGIN=observe`, `CONVERSATION_COMPOSER_BG_ENABLED` empty, `BACKUP_GROUP_GID=2900` unchanged;
   - 0 error lines.
6. **Kill switch** (any regression):
   - `.env` restored from the copy, then restart. The flag off keeps every row, and the backend keeps refusing a hard delete of a bound session (PROJECTS.md §1, §6);
   - **never** roll the code back below v19 once agents exist (case B, PROJECTS.md §8).

## Pilot steps (owner + A)
1. The owner creates `pilot-dev` and `pilot-qa` in the UI. A checks: capture `requested` and `effective`, CLI 2.1.314, nothing else changed.
2. The owner runs `/login` in each pilot session.
3. The owner creates project **Pilot** and two agents:
   - `@dev-pilot` (role Developer), bound to `pilot-dev`;
   - `@qa-pilot` (role QA), bound to `pilot-qa`.

## Scenarios and acceptance
| # | Scenario | Pass when |
|---|---|---|
| S1 | Navigation, desktop and phone (v1 and v2) | project → agent → Chat/Terminal in one tap; Back returns to the agent; `@handle · Pilot` in the session bar (desktop); no terminal resize on a view change |
| S2 | Presence honesty | "Working" only while a prompt runs (fresh hook evidence); "Ready" after the turn; after > 10 min idle, "No recent activity" (probes don't refresh it); a permission prompt shows "Needs you"; a probe never produces "Needs you" |
| S3 | Stopped session | stopping `pilot-qa` shows "Disconnected · session stopped" and a **Start session** button; it never starts by itself |
| S4 | Composer from the agent's Chat | a message reaches the CLI; delivery states shown; Chat and Projects agree on "Needs you" |
| S5 | Directory operations | a double-clicked create makes one agent (idempotency); removing an agent retires its binding, keeps the session and the history, and reserves the handle |
| S6 | Hard-delete guard | deleting a bound pilot session answers 409 `agent-active` (refusal only; nothing is deleted in the pilot) |
| S7 | Isolation and load | B/HA/HZ/A stay `binding: null` and unchanged; polling only while the page is visible; D1 calls per hour within +20% of the pre-pilot baseline (`getD1CallsSinceBoot` deltas); no new error lines |

## Daily readout (read only)
- **Directory:** rows in the four tables; bindings.
- **Load:** D1 calls/h delta; level-50/60 lines.
- **Health:** capture effective on every captured session; composer pane records empty.
- **Owner's notes:** wrong or confusing states, navigation friction, phone issues.

## Exit
- **Success** (S1–S7 pass): keep the flag on for the owner, and plan the next increment with B (Project Chat / tasks: design docs 13–16).
- **Partial:** fix in the frontend or with B. The flag can stay on if nothing is unsafe.
- **Failure or any unsafe signal:** the kill switch. The pilot rows stay; cleanup (remove the agents with the flag on, then stop or delete the pilot sessions) is a separate owner decision.

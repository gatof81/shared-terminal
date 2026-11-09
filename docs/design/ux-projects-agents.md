# UX evolution toward Projects, Agents, Sessions, Tasks and Project Chat: proposal

Status: **proposal, revision 2 (2026-11-09). Draft, not for merge.** Written by Claude A (Frontend Lead).
Revision 1 (2026-11-06) predated B's contract; this revision aligns it with what was approved and
what shipped, and maps what comes next.

Authority, highest first. Where this document and a source disagree, the source wins:

1. [`docs/PROJECTS.md`](../PROJECTS.md): the **binding** P3a contract (merged in #557).
2. `docs/design/project-chat/15-ux-alignment-and-contract.md` (branch `docs/project-chat-channels`):
   decisions **D-UX0…D-UX10** and amendments **E-1…E-9**, approved by the owner 2026-11-07, plus the
   single vocabulary in §6.
3. `docs/design/project-chat/16-p3a-interfaces-for-a.md`: the interfaces A consumes.
4. 13 (tasks), 06 (conversation UX), 01 (vision) on the same branch: vocabulary for **future** items
   only.

Every item below is labelled **SHIPPED** (on main), **NEXT** (buildable now within PROJECTS.md, no new
backend contract), or **FUTURE** (needs a contract or a GO that does not exist yet).

## Product constraints (owner)

| Constraint | How the UI honours it |
| --- | --- |
| Agent ≠ Session | An agent is `agentId`; its session is a `binding` with an `epoch`, and the history is `bindings[]` (PROJECTS.md §4.5). `@handle` is an alias, never the identity (16 §4 rule 3) |
| Chat ≠ Task | No message creates or changes a task. Tasks are FUTURE (T1+), sent as `work_request`, never as a `message` (15 §6.3) |
| Roles from templates, several agents per role | `role` is free text and several agents may share one (AD3). Templates are **copied** at creation, provenance only, never a live reference (D-UX3); `template` is `null` until E3 |
| Disconnected agents never auto-start | Nothing in the UI starts a session on its own. `disconnected` is shown with its evidence (PROJECTS.md §5) |
| Deploy needs human authorisation | No approve-deploy button anywhere (D-UX5, 15 §6.1 #3). A task may ask for a deploy in text; the UI says "requires human authorisation outside the system" |
| No exposure of private histories | Projects are owner-only (R5); a foreign or missing id is the same 404. A future reference the viewer can't open is an opaque chip, never its title |

## 1. Resolved against the contract

Revision 1's positions that conflicted with the approved contract, and what replaced them. These are
decided; this document does not re-argue them.

| Revision 1 (#554) said | Decision | Source |
| --- | --- | --- |
| Five task states (queued, active, blocked, interrupted, completed), `interrupted` non-terminal | The 10 states of 13 §2.3 are canonical; the UI groups them for presentation only (Pending / In progress / Needs your decision / Finished); `interrupted` is terminal | D-UX0 (a), D-UX1, 15 §3.4 |
| `blocked` as a task state | No `blocked` state. "Blocked" is a **notice** with evidence and an explicit reason, only on the `active` task, never inferred from silence | 15 §6.1 #2, §6.2 |
| A project-wide channel with threads, `/projects/<pid>/channel[/<threadId>]` | One **host conversation per agent**, with guests and explicit `to[]`. **Project Activity** is a read-only projection. Canonical route `#/projects/<pid>/agents/<aid>/chat[/<chatId>]`; `#/sessions/<sid>/hostchat/<chatId>` is a redirect-only alias | D-UX2, 15 §6.1 #1, E-8 |
| The word "channel" in the UI | "Channels" is internal transport only. The UI says Project Chat, Conversation, Project Activity | 15 §6.1 #5 |
| `roleTemplateId` as a live reference; "roles come from templates" | Free `role` text + `template{templateId, templateVersion}` copied at creation, `null` until E3 | D-UX3, AD3/AD4 |
| `Project.members[]`, `repos[]`, `policies` | Owner-only projects; no `members`; repos and policies are not part of the model | D-UX4, R5, 15 §6.4 |
| Admin / lead / observe tiers on projects; agents created "by an admin path" | Owner-only: admins and leads get 404 on project surfaces; only the owner creates agents (`POST …/agents`). Observe/operate stay on the session workbench | D-UX9, 15 §6.1 #4 |
| A deploy-approval surface (task detail or hub) | Deploys stay outside the system; no approve button until a deploy `authorization` contract exists | D-UX5, 15 §6.1 #3 |
| Tasks without an assignee (D-6) | A task always has one agent assignee | D-UX6 |
| D-1: CLI "Agents" vs team Agents | CLI helpers are "**Subagents**" (shipped in #559 when the feature is on) | D-UX7 |
| D-2: one project per agent? | One project, forever | AD12, PROJECTS.md §2 invariant 1 |
| D-4: how a session becomes an agent's | Explicit owner action: `POST …/agents` with a mandatory `sessionId`; never inferred from names. Re-binding is E4 | PROJECTS.md §4.3, 14 §3.2 |
| D-5: evidence and freshness | `presence{value, detail?, source, at, verified?}`; a live claim with evidence ≥ 10 min old is `unknown · stale` | PROJECTS.md §5, 16 §3 |
| D-7: scope of `can` | Per action, with a reason: `{allowed: false, reason}` | C2, PROJECTS.md §4.2/§4.4/§4.5 |
| `name`, `currentSessionId`, `sessions[]` on Agent | `handle`, `binding`, `bindings[]` | 15 §6.3 |
| `threadId`, `authorId`, `recipients[]`, message `refs[]` | `chatId`, `author{kind, agentId?}`, `to[]`, `evidence[]` (always `claimed`) / `taskRefs[]` / `context[]` | 15 §6.3 |
| Instruction `kind: update/change/stop` with received/applied/stopped stamps | `work_request{verb}`; instruction states `received → waiting_safe_point → delivered → acknowledged → applied \| refused \| superseded \| rejected` | 13 §2.4, 15 §6.3 |
| Events `session.attached/detached`, `agent.status`, `message.created` | Binding events (`active → draining → retired`, not implemented). In P3a: **polling** only, no WS. `WS /ws/project/<pid>` from T1 (E-7) | 15 §3.5, E-7 |
| `GET /api/projects/:pid`, `GET /api/agents/:aid`, `/api/tasks/:tid` | Discarded / re-homed: `GET /api/projects` + `GET /api/projects/:pid/agents[/:aid]`; tasks under `/api/projects/:pid/tasks` (T1, E-5) | 15 §3.5, 16 §2 |
| QA "✓" in the wireframe | An agent's evidence is `claimed` ("according to @qa-hz"); ✓ only with verification (E8, future) | B3, 15 §4.1 |

## 2. What exists now (SHIPPED)

Backend: PROJECTS.md behind `PROJECT_CHAT_ENABLED` (#557, flag off). Frontend: #559 (`40da4df`),
visible only when `GET /api/auth/status` reports `features.projectChat`.

```
Header ─ Shared Terminal ─ [Go to a conversation… Ctrl K] ────────────────── Templates · Logout
Sidebar                                │ Session bar: name · state · ⋯ │ Terminal Files Git Chat
 PROJECTS            + New project     │ ┌───────────────────────────────────────────────────┐
  Educación HZ  · 5 agents             │ │ Terminal (never resized or detached)               │
 AGENT SESSIONS                        │ │ Files / Git / Chat / project pages = overlays      │
  hz-dev  ● running  @developer-hz · … │ └───────────────────────────────────────────────────┘
 UNASSIGNED SESSIONS
  my-old-session ● running ↳ last conv
 ASSIGNMENT UNKNOWN   (directory read failed — never shown as unassigned)
```

| Surface | Route | What it shows | Contract |
| --- | --- | --- | --- |
| Sidebar · Projects | — | Projects with `agentCount`; New project per `can.createProject` | §4.1, §4.2 |
| Sidebar · sessions | — | Grouped by `binding`: Agent sessions (`@handle · project`, links to the agent) / Unassigned (`null`) / Assignment unknown (key absent) | §4.6, 16 §4 rule 1 |
| Project page | `#/projects/<pid>` | Agent directory: handle, role, presence chip with evidence and age, bound session link; New agent per `can.createAgent` | §4.3, §4.4 |
| Agent page | `#/projects/<pid>/agents/<aid>` | Identity, presence, capabilities, bound session + "Open the workbench", binding history (retired included), Remove per `can.remove`, removed banner | §4.5, §4.6 |
| Session workbench | `#/sessions/<sid>[/<view>[/<detail>]]` | Unchanged. Chat detail is the capture's conversation id: `#/sessions/<sid>/chat/<cid>` | `router.ts` |
| Creation dialogs | — | Fresh `clientRequestId` per action; 503 freezes the form and retries with the same id; `replayed` = success; a refusal after a 503 re-reads first | §3, 16 §4 rule 4 |

Behaviour that is already right and must stay:

- Project pages are overlays over the session: no resize, no detach, no new socket (terminal invariant).
- Polling ≤ 5 s, visible tab only, one request in flight per resource; logout clears every cache.
- Presence wording: `unknown` = "no evidence", never zero or idle; `waiting_input` unverified =
  "Ready (unverified)"; `needs_attention` only with `detail: "waiting_permission"` (attention rule,
  option A, `docs/design/attention-signal.md`).
- Binding a session changes nothing in it: its routes, `st.view.*`, `st.chat.*`, `st.draft.*` keys stay.

## 3. Next UX increments (within the approved contract)

No new backend field, route or event. Each is a frontend PR of its own.

| # | What | Why | Contract used | Size |
| --- | --- | --- | --- | --- |
| N1 | **Agent → its conversations.** On the agent page and each directory row: "Open Chat" → `#/sessions/<binding.sessionId>/chat`, and "Last conversation" → `#/sessions/<sid>/chat/<cid>` when this browser remembers one (`viewPolicy.readLastConversation`, local only) | Today the agent page reaches the workbench but not the conversation, which is what the person usually wants | PROJECTS.md §4.4/§4.5 `binding.sessionId` (live states only); `router.ts` chat route | S |
| N2 | **Breadcrumb in the session bar:** `Project › @handle` (links to `#/projects/<pid>` and `…/agents/<aid>`) when the row's `binding` is an object; nothing when `null`; a muted "assignment unknown" when the key is absent | Navigation Sessions → Agents → Projects; today it is one-way (agent → session) except via the sidebar | §4.6 `binding{projectId, agentId, handle}`; project name from §4.2 | S |
| N3 | **Presence summary on the project page header:** counts by presence group (needs attention / working / ready / disconnected / unknown), computed from the `GET …/agents` answer already polled, with "as of `generatedAt`" | Per-agent status at a glance without scanning rows; unknown stays its own count, never folded into zero | §4.4 `presence.value`, `generatedAt`; §5 | S |
| N4 | **Presence on the sidebar's agent-session rows**, only for projects whose directory is already loaded (the open project page), with its age; other rows keep today's `@handle · project` with no chip | Status where the person already looks, at no extra request. Cross-project presence needs B (Q1) | §4.4 `presence`; §4.6 `binding.agentId` to match rows | S |
| N5 | **Hard delete of a bound session explains itself:** map 409 `agent-active` to "Remove the agent first" with a link to the agent page (today it is the generic "Failed to delete session") | The guard exists server-side but the person can't tell why the delete failed | §4.7, §6; row `binding` for the link | S |
| N6 | **Disconnected agent → explicit Start.** On an agent whose presence is `disconnected · session-stopped`, a "Start the session" button calling the existing `POST /sessions/:id/start`, then the page re-polls | Gets the agent back without hunting for its session; still a human click, never automatic | §5 `detail`; existing session start route (owner) | S |
| N7 | **Mobile layout of project and agent pages:** binding history as stacked cards under 768 px (no horizontal scroll), a single back affordance per page, and a verified entry to Projects on each shell (v1: the sidebar drawer; v2 does not use the drawers, so the entry must come from its own chrome) | The history table and the action row do not fit a phone; v2 has no drawer | §4.5 `bindings[]` | M |
| N8 | **Navigation invariants for project pages in e2e:** opening a project/agent page and returning sends no `resize` and opens no socket, on `mobile-v2` and desktop, plus Back/Forward across `#/projects/…` ⇄ `#/sessions/…` | The terminal invariant must cover the new overlays the same way it covers Files/Git/Chat | `router.ts`; e2e mock directory | M |
| N9 | **Agent's conversations inline on the agent page** (titles, state, age) from `GET /api/sessions/<sid>/conversations?capture=0` of the live binding, refreshed with the page's poll | One screen for "what is this agent doing"; links go to `#/sessions/<sid>/chat/<cid>` | §4.5 `binding.sessionId`; CONVERSATION.md §6 (shipped, owner-only) — **blocked on Q2** for which conversations count as the agent's | M |

Desktop vs mobile, for the increments above:

| | Desktop | Mobile |
| --- | --- | --- |
| Entry to Projects | Sidebar section | v1: sidebar drawer; v2: an entry in its own chrome (N7) |
| Project / agent page | Overlay beside the sidebar | Full-width overlay, one pane, back returns to the previous route |
| Breadcrumb (N2) | Full `Project › @handle` | `@handle` only; the project is one tap further |
| Conversations (N1, N9) | Links open the session's Chat view in place | Same route; Chat is one pane as today |
| Presence (N3, N4) | Chip + evidence text | Chip + age; evidence text on tap |

## 4. FUTURE (needs a contract or a GO B has not given)

Labels only. None of this is specified here; field names are B's.

| Item | Needs | Source |
| --- | --- | --- |
| Agent's host conversation at `#/projects/<pid>/agents/<aid>/chat[/<chatId>]` (same component as the Chat view; guests, `to[]`, participant bar) | P3 complete, after the Channels POC GO. `router.ts` already parses that shape to `null` | D-UX2, 06 §1–§8 |
| Project Activity (read-only projection over conversations and tasks) | P3 / E6 | AD7, 15 §6.1 #1 |
| Tasks: list and detail, the 10 states in presentation groups, notices (`blocked`, `waiting_safe_point`, `awaiting_stop_report`, `agent-offline`, `queue-paused`) | T1 (needs P3 complete) | 13 §2.3, 15 §3.4, §6.2 |
| Instructions UPDATE / CHANGE / STOP on one task, with each instruction state shown separately | T1 (pending) / T2 (active) | 13 §2.4, E-5 |
| Agent queue (`paused` / `auto` with accreditation), held messages and explicit interleave | T2 | TD3, TD8, C3 |
| Real-time: `WS /ws/project/<pid>` | T1 / P3 complete | E-7 |
| `no_channel`, `degraded`, `ambiguous` presence ("messaging unavailable" / "messaging not responding") | P6 | PROJECTS.md §5, 15 §3.3 |
| Templates with UI; creating agents from a template | E3 | AD4, D-UX3 |
| Re-binding an agent to another session; binding without a session | E4 | 14 §3.2 |
| Several sessions per agent at once | E9 | 15 §2.3 |
| Verified evidence (✓) | E8 | B3 |
| `authorization` envelope; any deploy approval | A deploy `authorization` contract (none planned in MVP) | D-UX5, 15 §6.3 |
| Project rename / archive; sharing projects | Not in P3a; sharing is a future product decision | 16 §2, D-UX4 |
| Per-project network isolation | #291 / E7 | PROJECTS.md §7 |

## 5. Needs B

Questions, not specs. Each blocks or shapes an increment.

| # | Question | Blocks |
| --- | --- | --- |
| Q1 | Cross-project presence for the sidebar and header: should A poll `GET /api/projects/:pid/agents` for every project (≤ 50 × every N s against the 120/min `projectIp` limit), or will B offer a summary (e.g. per-project presence counts on `GET /api/projects`)? Until answered, A shows presence only for the loaded project (N4) | Sidebar presence beyond N4; an all-projects hub |
| Q2 | Which capture conversations are "the agent's"? A session's capture can hold conversations from before the binding (`binding.createdAt`) or, for a retired binding, after it. Should the UI filter by the binding's time window client-side, show all of the session's conversations labelled as the session's, or wait for an attribution by `bindingId`? | N9 |
| Q3 | Is `GET /api/activity` (#550, session-keyed, not implemented) still the all-projects hub's source, or will Project Activity (AD7) replace it for bound sessions? | A future Activity hub |
| Q4 | Can B publish the closed list of `presence.detail` values for P3a (16 §3 ends with "…")? The UI maps known ones to words and shows unknown ones raw | Wording in N3/N4 |
| Q5 | Creating an agent needs an unassigned session. Is a client-side "new session, then new agent" flow acceptable (two requests, two idempotency mechanisms, a failure in between leaves an unassigned session), or does B prefer a server-side flow later? | A "New agent with a fresh session" shortcut |
| Q6 | Doc discrepancy: 15 §4.2 N-5 says the `agent-active` hard-delete guard acts only with the flag on; PROJECTS.md §6 says it is armed whatever the flag. PROJECTS.md wins for the UI (N5 handles the 409 either way). Please align N-5 | Nothing in the UI |

## 6. Reusable pieces (for NEXT)

| Piece | Used by |
| --- | --- |
| `router.ts` (`routeHash`, `projectRouteHash`, `parseProjectRoute`) | N1, N2, N8 |
| `projectModel.presentPresence` (wording, tones, evidence age) | N3, N4 |
| `projectDirectory.ts` (project names), `api.ts` `binding` on session rows | N2, N4, N5 |
| `viewPolicy.readLastConversation` / `readLastConversationTitle` | N1 |
| `e2e/mockBackend.ts` `enableProjects()` (Educación HZ fixture), `failNextProjectWrite` | N5, N8 |

Frontend-only refactors still worth doing when an increment touches them: a shared `statusView.ts`
(status chip + evidence age + "as of") for Chat, the switcher and project pages; a typed union of
session and project routes in `router.ts` (today two parsers side by side).

## Wireframe (shipped + NEXT)

```
┌ Header ─ Shared Terminal ─ [Go to… ⌘K] ─────────────────────────────────── Templates ─ Me ┐
│ PROJECTS          + New    │ Educación HZ                                  [+ New agent]   │
│ ▸ Educación HZ · 5 agents  │ 1 needs attention · 1 working · 1 ready · 1 disconnected ·    │
│ AGENT SESSIONS             │ 1 unknown   (as of 14:02:45)                          (N3)    │
│  hz-dev ● @developer-hz    │ @designer-hz  Designer   ● Needs attention · permission · 47 s│
│    ● working · 5 s   (N4)  │ @developer-hz Developer  ● Working · hook · 5 s               │
│ UNASSIGNED SESSIONS        │      hz-dev · running   [Open Chat] [Last conversation] (N1)  │
│  my-old-session ● running  │ @qa-hz        QA         ○ Disconnected · session stopped     │
│ + New session              │      [Start the session] (N6)                                 │
└────────────────────────────┴───────────────────────────────────────────────────────────────┘
Session bar (N2):  Educación HZ › @developer-hz › hz-dev ● running   Terminal Files Git Chat
```

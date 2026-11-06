# UX evolution toward Projects, Agents, Sessions, Tasks and Channels: evaluation

Status: **evaluation for joint review, 2026-11-06.** Written by Claude A (Frontend Lead). Nothing here is implemented or authorised. It is to be read together with Claude B's backend and protocol proposal, so the owner, B and A can agree on one model before anything is built.

Binding owner decisions this document respects (2026-11-06):
- **Project** groups agents, resources, repositories and policies. Today's "projects" are **sessions** and are not assumed to be Projects.
- **Agent** is a stable identity, not its Docker session. One agent has many sessions over time. Roles come from templates, and a project may have several Developers or QAs.
- **Chat ≠ Task.** A message never creates a task or authorises an operation. Mentions show explicit recipients. Authorship and permissions are checked in the backend.
- **Task states:** queued, active, blocked, interrupted, completed. UPDATE, CHANGE and STOP target an identified task, never the whole session. The UI tells *received*, *applied* and *actually stopped* apart.
- **Disconnected agents** may hold pending work, and nothing starts them automatically.
- **Deploy** always needs human authorisation, even when another agent asks for it.
- **Cross-references** between messages, tasks, sessions, PRs, commits and evidence are shown without duplicating or exposing private histories.

---

## 1. Where the UI is today

```
Header ─ [☰] Shared Terminal  [Go to a conversation… Ctrl K]            ● Templates Logout
Sidebar (sessions)                      │ Session bar: name · state · ⋯ │ view tabs: Terminal Files Git Chat
  my-project  ● running  ↳ last conv    │  ┌─────────────────────────────────────────────────┐
  docs        ● stopped                 │  │ Terminal (xterm, tmux tabs)  ← never resized     │
  + New session                         │  │ Files / Git / Chat = overlays on the terminal    │
                                        │  └─────────────────────────────────────────────────┘
```

- **Address = state.** `router.ts` handles `#/sessions/<id>[/<view>[/<detail>]]`. Back and Forward work, and mobile has one pane at a time.
- **Unit of navigation = session.** `sessionCore.ts` covers the list, `openSession` and `applyRoute`. `viewPolicy.ts` remembers each session's view and last conversation.
- **Views are overlays** (`viewSwitch.ts`) on top of a terminal that is never resized or detached. That invariant is tested in e2e and must survive any evolution.
- **Cross-session navigation** goes through the switcher (`switcher.ts`, `switcherModel.ts`). It loads every running project's conversations with bounded concurrency, sorts by the shared attention rule (`attentionRule.ts`, option A), lists subagents, and has an at-a-glance line.
- **Chat** (`chatView.ts`, `conversationModel.ts`) is the read surface of the capture: threads, tools, agents (subagents), honest states, the composer (pane, and v1.9 background in review), and drafts that persist.

The session is today's de facto "project". Every link, saved memory and deep link is keyed by `sessionId`.

## 2. What can evolve, and what must not break

| Today | Evolves into | Must not break |
|---|---|---|
| Sidebar list of sessions | Projects → agents → sessions tree | Deep links `#/sessions/<id>/…`, the per-session memory (`st.view.*`, `st.chat.last.*`, `st.draft.*`) |
| Session bar + view tabs | The **workbench** of one session (unchanged) | Terminal invariant (no resize or socket on a view switch); Files/Git/Chat/Terminal parity |
| Switcher | The **activity hub's** quick-jump (projects, agents, conversations, tasks) | `Ctrl/⌘ K`, attention-first order, honest partial results |
| Chat list per session | The **agent's** conversations; Project Chat is a separate channel | Capture semantics, composer contracts |
| Subagent cards (#539) | Kept as subagents *of a conversation*, never confused with team Agents | "Started, no end yet" never shown as "working" |

**Naming collision to resolve (decision D-1):** the CLI's *subagents* (`agent_start`/`agent_end`, shown today as "Agents") and the new *team Agents* are different things. The UI must rename the CLI ones, for example "Subagents" or "Helpers inside this conversation".

## 3. Proposed navigation map

```
/                          → Home: Activity hub (all projects)
/projects/<pid>            → Project overview: team, tasks, activity, channel
/projects/<pid>/agents/<aid>             → Agent: identity, status, sessions, tasks, conversations
/projects/<pid>/channel[/<threadId>]     → Project Chat (B's)
/projects/<pid>/tasks/<tid>              → Task detail (refs: messages, sessions, PRs, commits, QA, previews)
/sessions/<sid>[/<view>[/<detail>]]      → Session workbench (TODAY, unchanged): Terminal · Files · Git · Chat
```

- **Every agent, task and channel page links down to the session workbench**, so all of today's tools stay one click away.
- **A session not yet attached to any Agent** (all of today's) appears under "Unassigned sessions", and its `#/sessions/…` link keeps working.
- **Breadcrumb in the session bar:** `Project › Agent › Session` when known, otherwise the session name as today.

## 4. Main views and their responsibilities

1. **Activity hub (Home).** One place to supervise everything running in parallel.
   - A project list with the attention signal (#550): "needs you", working, ready, each with "as of" when stale.
   - Each project's agents with their evidence-backed state, and the newest items that need a human: permission prompts, blocked tasks, deploy approvals.
   - Read-only. Clicking goes to the agent, task or session. It **reuses** the switcher's model (`ProjectLoader`/`Slots`, `parallelSummary`) and the activity endpoint.
2. **Project overview.**
   - **Team:** agent cards showing role, state, current task and session link.
   - **Tasks:** a compact table filtered by state. It is deliberately not a Jira: no custom fields, workflows or estimates.
   - **Recent activity**, and an entry to Project Chat.
   - **Settings:** repos, policies and templates (phase 3).
3. **Agent page.**
   - Identity, role template, capabilities and permissions (read-only in the MVP).
   - **Sessions history:** current and past sessions, with workspace and state; each opens the workbench.
   - Tasks assigned, with their states.
   - Conversations, meaning the capture's conversations of its sessions, reusing the Chat list.
   - Status shows its evidence and age: "working · last event 40 s ago".
4. **Task detail.**
   - State timeline: queued → active → blocked/interrupted → completed, with an **instruction ledger** showing *received*, *applied* and *stopped* as separate marks.
   - References: messages (links into the channel), sessions, PRs, commits, QA results, previews.
   - Actions limited to what the person is allowed to do: UPDATE, CHANGE, STOP *this task*, and approve a deploy (human only).
5. **Project Chat (Claude B's).** A/B decide how to host it: A embeds B's view as a route and a panel, and does not rebuild it.
   - Mentions show explicit recipient chips before sending.
   - A message stays a message. "Create task from this message" is an explicit, separate action that opens the task form, never implicit.
6. **Session workbench (today's UI).** Unchanged: Terminal, Files, Git, Chat, plus the breadcrumb.

## 5. MVP (first increment, small and safe)

Goal: see the team and its state, and jump to the work, without changing how sessions work.

1. **Read-only Projects and Agents in the sidebar and the Activity hub.**
   - The sidebar gets a "Projects" section above "Sessions", with each project showing its agents (role, state, current session).
   - The session list stays, and "Unassigned sessions" keeps everything today.
2. **Agent page (read-only):** identity, role, state with evidence, and the session list linking to the workbench.
3. **Attention per project and per agent**, with the shared rule and honest partial results (#550).
4. **Breadcrumb** in the session bar when the session belongs to an agent.
5. **No creation or editing yet.** Agents are created by B's backend or an admin path. MVP UI actions are navigation only.

What the MVP explicitly does not include: tasks UI beyond a read-only count, mentions, creating agents, permissions editing, deploy approvals.

## 6. Later phases

| Phase | Adds | Depends on B |
|---|---|---|
| 2: Tasks (read) | Task list per project and agent, task detail with timeline and references | Task entity, states, references, task events |
| 3: Task control | UPDATE, CHANGE, STOP on one task, with the received, applied and stopped ledger; human deploy approval flow | Task commands with ack semantics; authorisation model |
| 4: Project Chat integration | Embed B's channel; explicit recipient chips for mentions; "create task from message" | Channel API, mention resolution, authorship |
| 5: Create and configure | Create agents from RoleTemplates; capabilities and permissions; templates library (extends today's Templates) | RoleTemplate, Agent creation, policy model |
| 6: Activity hub v2 | Push updates (`WS /ws/activity`), filters, per-person "my items" | Activity events stream |

## 7. Reusable frontend components and models (today)

- **Navigation and state:** `router.ts` (extend with project, agent and task routes, keep `sessions`), `viewSwitch.ts` (workbench overlays), `viewPolicy.ts` (per-entity memory, generalised to `project:` and `agent:` keys), `tabTitle.ts` (Project › Agent).
- **Status and evidence:**
  - `attentionRule.ts`, the shared pure rule, extended for agent states;
  - `conversationModel.presentStatus` / `lastEvidenceAt` / `STALE_EVIDENCE_MS`;
  - `connectionChip` and the "as of" pattern;
  - `agentsSummary.ts` (subagents);
  - the status chip and tones from `chatView`, extracted to `ui.ts` (see below).
- **Lists and loading:** `switcherModel` (`ProjectLoader`, `Slots`, `parallelSummary`, `sectionize`, `matches`), the switcher (quick-jump, keyboard combobox) and the Chat list's filters (Active · Archived · All).
- **Content:** `markdown.ts` and `highlight.ts` (safe, linear, textContent-only), `diff.ts`, the `ui.ts` builders, `confirmDialog`, `draftStore.ts`, `composerText.ts`.
- **Plumbing:** `api.ts`'s `authEpoch`-bound requests, `authLock.ts`, `reconnect.ts` / WS handling, and the e2e `mockBackend.ts`, which grows mock projects, agents and tasks for the new views.

**Refactors to prepare now (frontend-only, no backend):**
- Extract the status chip, evidence age and "as of" into a `statusView.ts` used by Chat, the switcher and future cards.
- Generalise `router.ts` to a typed union of routes with the current `sessions` routes unchanged.
- Turn the switcher's item model into an "entity row" that can hold a session, a conversation, an agent or a task.

## 8. Contracts to agree with Claude B

**Entities** (fields the UI needs, as a minimum):
- **Project:** `projectId`, `name`, `members[]` (people and roles), `policies` (summary), `repos[]`.
- **Agent:**
  - `agentId`, `projectId`, `name`, `roleTemplateId`, `capabilities[]`, `permissions` (summary);
  - `status` with **evidence** `{state, source, at}`;
  - `currentSessionId | null`, `sessions[]` (history).
- **RoleTemplate:** `templateId`, `name`, `description`, `defaultCapabilities[]`, `defaultPermissions`.
- **Session:** today's `sessionId`, plus an optional `agentId` and `projectId`, with no change to existing fields.
- **Task:**
  - `taskId`, `projectId`, `assigneeAgentId`, `state` (queued, active, blocked, interrupted, completed), `blockedReason?`, `createdBy` (person or agent);
  - `refs[]`: typed links to message, session, PR, commit, evidence, preview;
  - `instructions[]`, each with `{id, kind: update|change|stop, by, at, receivedAt?, appliedAt?, stoppedAt?}`.
- **Channel and message:** owned by B. The UI needs `threadId`, `authorId` (verified), `recipients[]` (resolved mentions) and `refs[]`.

**Endpoints:**
- reads:
  - `GET /api/projects`, `GET /api/projects/:pid` (team summary);
  - `GET /api/agents/:aid`;
  - `GET /api/projects/:pid/tasks`, `GET /api/tasks/:tid`;
  - `GET /api/activity` (#550, extended to agents and tasks);
- commands, phase 3+: `POST /api/tasks/:tid/instructions` returning **202 with an instruction id**. Then come the events that move it to received, applied and stopped.
- Every response carries `can: {…}` booleans for the caller, so the UI hides what the person can't do. The backend still decides on every call.

**Events** (WS or polling):
- `agent.status`, with evidence and time;
- `task.created` / `task.state`;
- `task.instruction`, with its received, applied and stopped marks;
- `message.created`, B's;
- `session.attached` / `session.detached`, which tie a session to an agent.

**States and evidence:** every displayed state carries `{value, source (hook|probe|task|human), at}`. The UI shows age and source, and marks a value **unknown** when it is missing or older than the window, never a guess. "Disconnected" is a state with evidence, not the absence of data.

## 9. Compatibility with existing sessions (no destructive migration)

- **Sessions stay first-class.** `#/sessions/<id>/…` links, saved memories and drafts keep working unchanged.
- **Attaching is additive.** A session gets an optional `agentId`/`projectId`; nothing renames or moves its data. Unattached sessions sit under "Unassigned sessions" and work exactly as today.
- **No automatic grouping.** Today's sessions (A, B, HA, HZ) are attached to agents only by an explicit owner action, never inferred from names.
- **Route aliases:** an agent page links to its current session's workbench, so old bookmarks and new navigation lead to the same place.
- **Feature flag on the frontend:** the Projects section and hub appear only when the backend reports the capability (`GET /api/auth/status` → `features`). Otherwise the UI is today's.
- **Risks:**
  - per-session localStorage keys must not collide with new entity keys (prefix by entity type);
  - the switcher's cost grows with agents (keep bounded concurrency and the `/api/activity` summary);
  - the "Agents" naming collision (D-1).

## 10. Permissions in the UI

- **Actions shown only from server-provided `can`.** The project, agent and task payloads carry them, and missing means hidden. The backend re-checks every command, so hiding is a courtesy, not a control.
- **Admin, lead and observe tiers keep today's meaning:** observe is read-only and operate means write.
- **Deploy is always a human approval surface:** an agent's request shows as "awaiting approval by a person", never as a button another agent can press.
- **Private histories:** a reference to a conversation or session the viewer can't open is shown as an opaque chip ("private session"), never with its title.

## 11. Tasks and activity without becoming Jira

- A task has states, an assignee, references and an instruction ledger. Priorities, estimates, custom fields, boards and sprints are out of scope.
- Discussion lives in Project Chat. A task links to the messages that discuss it, and the conversation is not copied into the task.
- Activity is a **derived feed** (state changes, approvals needed, completed tasks with evidence), not a second chat.

## 12. What can be prepared now vs. what depends on B

| Now (frontend only, no backend change) | Needs B's contracts |
|---|---|
| `statusView.ts` extraction; route union refactor; entity-row model for the switcher | Projects, Agents and Tasks views with real data |
| Mock backend: projects, agents, tasks fixtures; Storybook-like e2e pages behind a dev flag | Activity v2, Project Chat embedding, mentions |
| Rename CLI "Agents" to "Subagents" (D-1) once agreed | Task commands, instruction ledger, deploy approvals |
| Attention signal frontend (#550, already designed) | Agent creation from templates, permissions |

## 13. Decisions to resolve together (owner, B, A)

- **D-1:** naming of CLI subagents vs. team Agents.
- **D-2:** is an Agent always bound to one project, or can one Agent serve several? The working assumption is one project, per "belongs to a project".
- **D-3:** where Project Chat lives in the navigation (route only, or also a side panel next to the workbench) and who owns its frontend. Proposal: B owns the protocol and API, A embeds it.
- **D-4:** how a session becomes an agent's: an explicit owner action, a creation flow, or both. Never inferred.
- **D-5:** the minimum evidence for each agent state (working, waiting, blocked, disconnected) and its freshness window. Proposal: reuse `attentionRule` semantics, extended with the task state.
- **D-6:** whether a Task can exist without an assignee (a queue per project).
- **D-7:** the scope of `can` (per entity vs. per action) and how admin, lead and observe map onto agents and projects.
- **D-8:** where deploy approvals live (task detail, activity hub, or both) and who may approve.

## Wireframe (conceptual, MVP)

```
┌ Header ─ Shared Terminal ─ [Go to… ⌘K] ─────────────────────────── ● Needs you 1 ─ Templates ─ Me ┐
│ PROJECTS                         │ Activity                                                       │
│ ▸ Educación HZ   ● 1 needs you   │  Needs you                                                     │
│     Architect HZ   working 40 s  │   ● QA & Release HZ · permission prompt · 2 min · [Open]       │
│     Developer HZ   ready         │  Working                                                       │
│     QA & Release HZ ● needs you  │   Developer ST · task "Fix login" · last event 30 s · [Open]   │
│ ▸ Shared Terminal  2 working     │  Recent                                                        │
│ UNASSIGNED SESSIONS              │   Architect HZ · task completed · PR #612 · QA ✓              │
│   my-old-session ● running       │  (as of 12:04:10 · 1 project not loaded — may be incomplete)  │
│ + New session                    │                                                                │
└──────────────────────────────────┴────────────────────────────────────────────────────────────────┘
Agent page:  Developer HZ · role Developer · ● working (hook, 30 s ago)
  Sessions: st-a7246fa7 (current) [Open workbench] · st-…(previous, stopped)
  Tasks: "Fix login" active · "Upgrade deps" queued      Conversations: (Chat list, reused)
```

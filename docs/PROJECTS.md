# Projects

Status: always on. Code: `backend/src/projects/directory.ts`,
`backend/src/routes/projects.ts`. A project's topics (conversations) and its Archive are part of the ACP
message API — [ACP_AGENTS.md §4–§4b](./ACP_AGENTS.md#4-scope-projects-topics-and-the-archive).

A project **groups ACP agents** and gives them topics. It owns nothing else: each agent keeps
its own session, workspace, context and history, and takes part in at most one project
(`acp_agents.project_id`).

## API (owner-only, cookie)

| Method | Path | |
| --- | --- | --- |
| POST | `/api/projects` | `{name, clientRequestId}` → 201 `{projectId, …, replayed}`. Idempotent by `(owner, clientRequestId)`. At most 50 live projects per owner (409 `project-limit`). |
| GET | `/api/projects` | The owner's live projects with `agentCount`. |
| PATCH | `/api/projects/:pid` | `{name}` — rename a live project (same rules as create; archived = 404). Agents and messages reference the id, so nothing else moves. |
| DELETE | `/api/projects/:pid` | Archive: the project's agents leave it, the row stays (`archived_at`). |

A foreign or missing project is the same 404.

Agents join or leave a project with `PATCH /api/acp/agents/:name {projectId | null}`, or at creation
with `acpAgent.projectId` on `POST /api/sessions`.

**Creation is one statement.** A single INSERT…SELECT applies the per-owner limit. If an answer does
not prove the outcome (a timeout, an unrecognised D1 error), the backend reads the record back:
found ⇒ the creation (`replayed`); not found ⇒ 503 `outcome-unknown`, and the client retries with the
same `clientRequestId`. The server never retries on its own.

## History

Until 2026-11-18 this document was the contract of the P3a agent directory: project agents bound to
sessions (`project_agents`, `agent_bindings`, `project_agent_creations`), presence, and the
Composer-based project conversation ([PROJECT_CONVERSATION.md](./PROJECT_CONVERSATION.md)).

- **Code:** all of it was removed (#678).
- **Data:** the tables and `<WORKSPACE_ROOT>/.projects` are still on disk but are no longer read or
  written. They are removed only by a later, owner-approved migration, after a fresh backup.
- **Old contract:** the previous version of this file is in the git history.

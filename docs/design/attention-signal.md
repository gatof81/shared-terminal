# Per-project attention signal: design (not implemented)

Status: **proposal, 2026-11-06.** Owner-requested design for the backend part of the multi-project navigation work (frontend PRs #535, #536, #539, #548). Nothing here is implemented, and this document authorises nothing.

## Problem

Today the only way to see which projects need the person is to open the conversation switcher (#535). It loads every running project's conversation list (`GET …/conversations?capture=0`, 3 at a time, 8 s each) **when it opens**, and only then. With several projects running in parallel, a conversation that is waiting for permission or input in another project goes unseen until the person happens to open the switcher or that project. The sidebar can't show it, because loading every list on a timer would multiply requests by the number of projects and send titles (content) the sidebar doesn't need.

## Goal

A cheap, honest, per-project signal that the sidebar, the header and a future central activity view can show without opening each project:

- **"Needs you"**: a conversation whose *fresh* evidence says it waits on the person (permission, input).
- **"Working"**: a conversation whose *fresh* evidence says it is active (running, background tasks).
- **Never an estimate shown as a fact.** A stale live claim, one older than `STALE_EVIDENCE_MS` (10 min, `frontend/src/conversationModel.ts`), counts as neither. "Unknown" is never shown as zero.

## Non-goals

- Notifications outside the page (OS notifications, email). They could build on this later as an opt-in.
- Titles, prompts or any conversation content in the signal. It carries counts and times only.
- Admin or lead views across users. The signal is owner-scoped, and widening it is a separate decision under `assertCanObserve`.
- Replacing B's Project Chat or Agent Monitor (Channels). This is a status summary, not a transport or a chat.

## API

`GET /api/activity` (owner-scoped, `requireAuth`), additive and read-only:

```json
{
  "generatedAt": "2026-11-06T12:00:00.000Z",
  "staleAfterMs": 600000,
  "projects": [
    {
      "sessionId": "…",
      "available": true,
      "attention": 1,
      "working": 2,
      "newestAttentionAt": "…",
      "lastEvidenceAt": "…",
      "agentsWithoutEnd": 3
    },
    { "sessionId": "…", "available": false, "reason": "not-running" | "capture-off" | "unreadable" }
  ]
}
```

- **Projects listed:** only the caller's **running** sessions with capture requested. Every other session is absent, and the client shows no badge for it, never a zero.
- **`attention`, `working`:** counted with the same rule the frontend uses (`bucketOf` → `presentStatus`):
  - a live-claim status counts only if `now − max(statusAt, lastEventAt) < STALE_EVIDENCE_MS`;
  - `waiting_permission` and `waiting_input` mean attention;
  - `running` and `waiting_background` mean working;
  - archived conversations (v1.8 §6.2) don't count.
- **`agentsWithoutEnd`:** subagents started with no `agent_end` seen, in conversations that count as working or attention. It is labelled "started, no end yet" everywhere and is never "working".
- **`staleAfterMs`:** sent so client and server can't drift. The frontend's constant becomes a fallback.
- **`available: false`:** says *why* the project has no number (not running, capture off, unreadable index). The client shows "—" with that reason, never 0.

### Where the numbers come from (cost)

- **From the conversation service, not D1.** The service has `runtime` and the resident indexes (`store.getResidentIndex`), plus `store.peekIndex` for G4-evicted ones (a snapshot read: no events scan, nothing made resident).
- **No probe, no `docker exec`, no D1 round trip on the hot path.** Same principle as `?capture=0` (D7).
- D1 rows lag up to the 30 s heartbeat, and the list already prefers the index for that reason.
- **Per-user cache:** 5 s TTL with single-flight, so a header and a sidebar polling together cost one computation.
- **Rate limit:** a new `activityIp` limiter, next to `fileBrowseIp`. Each request also holds an `InFlightLimiter` slot per user, released when the response ends (the Files and Git pattern).

### Freshness

- **v1, polling:** the frontend polls every 20 s while the page is visible (`document.visibilityState`), pauses while hidden, and refreshes once on focus. With 5 projects that is one request every 20 s, against today's 5 requests per switcher open.
- **v2, optional push:** `WS /ws/activity` emits a frame when a project's counts change, coalesced to 2 s. It has to be added to `WS_PATH_PREFIXES` (`wsUpgrade.ts`) and get its own upgrade test. It is deferred until polling proves too slow or too costly.

## UI (frontend, built on existing pieces)

- **Sidebar project row:** a small badge.
  - "● 1 needs you" in the attention tone, "2 working" muted, nothing when both are 0.
  - "—" with a tooltip when `available: false`.
  - The badge opens the switcher filtered to that project, or the project's own last conversation (#536).
- **Header:**
  - the switcher button shows the total "needs you" count;
  - `document.title` gets a `(N)` prefix only for attention, so a background tab can show it.
- **Switcher (#548):** its at-a-glance line can use the same numbers before the per-project lists finish loading. Opening it still loads the lists for titles.
- **Central activity view (future):** a page or overlay listing projects × conversations × agents, built from:
  - `switcherModel` (bucketOf, sectionize, `ProjectLoader`/`Slots`, `parallelSummary`);
  - `agentsSummary` (`atAGlance`, `agentsLine`);
  - this endpoint.

  No new data source is needed, and it doesn't duplicate B's Project Chat: no input, no channels, just navigation into the existing Chat and Terminal.

## Honesty rules (all surfaces)

1. Only fresh evidence counts. A stale claim is "no recent activity", the same as in the Chat list (#528, #533) and the switcher (#535).
2. "Unknown" is never 0. When the endpoint fails, times out or answers 429, the badges show their previous value marked "as of <time>", or "—". The header dot (#534) already shows reachability.
3. Agents are "started, no end yet", never "working" (#539).
4. Ages are always visible on hover: "needs you since 3 min".

## Security and privacy

- Owner-only, through the same per-session ownership as the conversation list. The query takes the caller's own running sessions from `sessions.listForUser`.
- Counts and timestamps only, so the response carries no titles or content. Titles stay behind the per-session list, which is owner-only.
- Logout clears the client cache, like the switcher (`closeSwitcher`) and the last-conversation titles.

## Tests (when implemented)

- **Backend unit:** bucket rules at and across the 10 min boundary; archived conversations excluded; G4-evicted conversations counted through `peekIndex`; an unreadable index gives `available:false, reason:"unreadable"` rather than 0; the cache TTL and single-flight; ownership (a foreign session never appears).
- **Backend route:** 401 without auth, 429 from the limiter, no `docker exec` and no D1 query when the cache is warm (spies).
- **Frontend:**
  - polling pauses while the page is hidden;
  - badges for attention, working, unavailable and stale-cache states;
  - title prefix only for attention;
  - logout clears the cache;
  - e2e with the mock backend for the sidebar badge and switcher navigation.

## Rollout

1. Backend endpoint (additive, behind no flag, because it is read-only and owner-scoped), with the tests above. App-only deploy with the usual procedure.
2. Frontend reads the endpoint when present. When absent (404 from an older backend), nothing changes.
3. Measure request rate and computation time in `/api/admin/stats → activity` for a week before considering v2 push.

## Open decisions for the owner

- **Poll interval:** 20 s proposed. Shorter means fresher badges at linear cost.
- **Title prefix:** whether to add `(N)` at all, since some people find it noisy. It could be opt-in.
- **Agents count:** whether the sidebar shows it (proposed: in the tooltip only).

# Per-project attention signal: design (not implemented)

Status: **design accepted by the owner, 2026-11-06** (decisions below), not implemented. Owner-requested design for the backend part of the multi-project navigation work (frontend PRs #535, #536, #539, #548). Nothing here is implemented, and this document authorises nothing.

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
      "agentsWithoutEnd": 3,
      "complete": true,
      "metaUnavailable": false
    },
    { "sessionId": "…", "available": false, "reason": "not-running" | "capture-off" | "unreadable" }
  ]
}
```

- **Projects listed:** only the caller's **running** sessions with capture requested. Every other session is absent, and the client shows no badge for it, never a zero.
- **`complete`:** false when anything that could change the counts was unreadable (see "Partial results never look complete").
- **`metaUnavailable`:** the archive state couldn't be read, so archived conversations may be counted.
- **`attention`, `working`:** counted with the same rule the frontend uses (`bucketOf` → `presentStatus`):
  - a live-claim status counts only if `now − max(statusAt, lastEventAt) < STALE_EVIDENCE_MS`;
  - `waiting_permission` and `waiting_input` mean attention;
  - `running` and `waiting_background` mean working;
  - archived conversations (v1.8 §6.2) don't count; the archive state comes from an in-memory cache (see "Archive state without D1 on the hot path").
- **`agentsWithoutEnd`:** subagents started with no `agent_end` seen, in conversations that count as working or attention. It is labelled "started, no end yet" everywhere and is never "working".
- **`staleAfterMs`:** sent so client and server can't drift. The frontend's constant becomes a fallback.
- **`available: false`:** says *why* the project has no number (not running, capture off, unreadable index). The client shows "—" with that reason, never 0.

### Where the numbers come from (cost)

- **From the conversation service, not D1.** The service has `runtime` and the resident indexes (`store.getResidentIndex`), plus `store.peekIndex` for G4-evicted ones (a snapshot read: no events scan, nothing made resident).
- **No probe, no `docker exec`, no D1 round trip on the hot path.** Same principle as `?capture=0` (D7).
- D1 rows lag up to the 30 s heartbeat, and the list already prefers the index for that reason.
- **Per-user cache:** 5 s TTL with single-flight, so a header and a sidebar polling together cost one computation.
- **Rate limit:** a new `activityIp` limiter, next to `fileBrowseIp`. Each request also holds an `InFlightLimiter` slot per user, released when the response ends (the Files and Git pattern).

### Archive state without D1 on the hot path

Archived conversations must not count, and the archive state lives in D1 (`conversation_user_meta`, v1.8 §6.2). Reading it on every request would put D1 back on the hot path. So:
- **Cache.** A per-session in-memory map `cid → archivedAt` is filled lazily by **one** query per session (the same `SELECT … FROM conversation_user_meta WHERE st_session_id = ?` the list already runs), then kept.
- **Invalidation by the only writers, in-process.** The owner's `PATCH …/conversations/:cid` (`registry` upsert) updates the cache entry after its D1 write commits. A purge (`DELETE … WHERE st_session_id = ?`) drops the session's entry. There is no other writer while the backend runs. `npm run restore` runs with the backend stopped and the cache starts empty.
- **Safety net.** A 5-minute TTL per session, so a missed invalidation can't last.
- **Unreadable meta.** When D1 fails, the cold read gives `metaUnavailable: true` for that project. Its counts include archived conversations and the response says so: the client shows "may include archived conversations" and never presents those numbers as exact. The switcher already does the same (#535 `metaUnavailable`).

Steady state is no D1 query: one per session per 5 minutes at most, plus one after each owner rename or archive.

### Partial results never look complete

- **Per-project flag.** Each project carries `complete: boolean`. It is false when the conversation index of some conversation was unreadable (`peekIndex` null), or `metaUnavailable` is set.
- **Client wording.** An incomplete project's badge reads "at least N" and its tooltip says why.
- **Unknown ≠ zero.** A project that could not be summarised at all is `available: false`, never a 0.
- **Header totals.** A header total over projects where any is incomplete or unavailable says "at least N".
- **Freshness of the last answer.** When the last poll failed, every badge shows its last value with "as of <time>", and after 2 missed polls (40 s) it switches to "—".

### Freshness (owner decisions, 2026-11-06)

- **v1, polling:** the frontend polls every **20 s** while the page is **visible** (`document.visibilityState`), pauses while hidden, and refreshes once when the page regains focus or visibility. With 5 projects that is one request every 20 s, against today's 5 requests per switcher open.
- **Single flight.** At most one request in flight per page. A tick or focus event that fires while a request is pending is coalesced into that request, never a second one. The sidebar, the header and the switcher read the same client cache.
- **Backoff.** On 429 the client honours `Retry-After` when present. Otherwise, and on network errors or 5xx, it backs off exponentially: 20 s → 40 s → 80 s → 160 s, capped at 5 min, with ±20 % jitter. It resets on the first success. While backing off, the badges follow the "as of <time>" / "—" rule above. A 401 stops polling, and the existing session-expiry flow takes over.
- **v2, optional push:** `WS /ws/activity` emits a frame when a project's counts change, coalesced to 2 s. It has to be added to `WS_PATH_PREFIXES` (`wsUpgrade.ts`) and get its own upgrade test. It is deferred until polling proves too slow or too costly.

## UI (frontend, built on existing pieces)

- **Sidebar project row:** a small badge.
  - "● 1 needs you" in the attention tone, "2 working" muted, nothing when both are 0.
  - "—" with a tooltip when `available: false`.
  - **Subagents appear only in the tooltip** ("3 subagents started, no end yet"), never as a separate counter (owner decision).
  - The badge opens the switcher filtered to that project, or the project's own last conversation (#536).
- **Header:**
  - the switcher button shows the total "needs you" count;
  - **no `(N)` prefix in `document.title`** by default (owner decision). The tab title stays as #551 set it.
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

## Owner decisions (2026-11-06)

- Polling every 20 s, only while the page is visible, plus a refresh when it regains focus.
- No `(N)` prefix in `document.title` by default.
- Subagents only in the sidebar tooltip, not as an extra counter.
- Backoff on 429 and network errors; no duplicate concurrent requests (see Freshness).

## Implementation PRs

Separate PRs. The backend endpoint needs the owner's approval to merge and deploy. The frontend handles a missing endpoint (404 → nothing shown), so it can ship before the backend.

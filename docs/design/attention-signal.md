# Per-project attention signal: design (not implemented)

Status: **design, revision 2 (2026-11-06).** The owner accepted the direction and the decisions listed at the end. Revision 2 folds in an independent review. One owner decision is still open: what "needs you" means (§ Semantics). Nothing is implemented.

## Problem

Today the only way to see which projects need the person is the conversation switcher (#535). It loads every running project's conversation list (`GET …/conversations?capture=0`, 3 at a time, 8 s each) **when it opens**, and only then. A conversation waiting on a permission in another project goes unseen until the switcher or that project is opened. The sidebar can't fill this gap: loading every list on a timer multiplies requests by the number of projects and sends titles (content) the sidebar doesn't need.

## Goal

A cheap, honest, per-project signal for the sidebar, the header and a future central activity view:
- **Only fresh evidence counts.** A live claim older than `staleAfterMs` (10 min) counts for nothing.
- **Unknown is never presented as zero**, and partial counts are never presented as complete.
- **No content:** counts and times only.

## Non-goals

- Notifications outside the page.
- Titles or prompts in the signal.
- Admin or lead views across users.
- Replacing B's Project Chat or Agent Monitor (Channels). This is a status summary that navigates into the existing Chat and Terminal.

## Semantics (one rule, shared with the switcher)

- **Freshness:** a conversation's claim is fresh iff `now − Date.parse(lastEvidenceAt(c)) < staleAfterMs`.
  - `lastEvidenceAt` is the newer of `statusAt` and `lastEventAt`, falling back to whichever one parses.
  - If neither parses, the claim is stale.
  - The rule is `presentStatus`'s, applied server-side with the server's clock. The response carries `generatedAt`, so a client with a skewed clock can tell.
- **One pure module:** the bucket rule moves into a module kept byte-identical between frontend and backend, like `composerText.ts`. The switcher (`bucketOf`) and the endpoint then cannot drift.
- **Archive state does not change a count.** This is the switcher's rule (`visibleInSwitcher`) and contract §6.2: an archived conversation with a fresh live claim is shown and counted, because it came back to life. Only fresh live claims are counted at all, so the archive state can never change a number. **Consequence: the endpoint never reads `conversation_user_meta`.** The archive cache in revision 1 is gone.
- **What "needs you" means — OWNER DECISION NEEDED.** An interactive Claude sitting at its prompt is `waiting_input`. The silence sweep probes every live claim after 8 minutes, and `probe:idle` renews `statusAt`, so that claim never goes stale. Counting `waiting_input` as "needs you" would put a permanent badge on every open CLI, and a real permission prompt would be lost among them.
  - **A (recommended):** "needs you" = `waiting_permission` only. `waiting_input` becomes a muted "ready" count. The frontend's `statusTone` already separates them (`waiting_input` is "ready", `waiting_permission` is "attention"). The switcher's `bucketOf` changes in the same PR, so both surfaces agree.
  - **B:** keep today's rule, which matches the switcher, and accept the noise in writing.
- **Working:** `running` and `waiting_background` with a fresh claim.
- **Agents:** `agentsWithoutEnd` is a **lower bound**. The index caps tracked agents (256) and sheds them when it gets too large. It is shown only when it is above 0, labelled "started, no end yet", and never "working" (#539).

## API

`GET /api/activity` is owner-scoped (`requireAuth`), additive and read-only.

```json
{
  "generatedAt": "2026-11-06T12:00:00.000Z",
  "staleAfterMs": 600000,
  "projects": [
    { "sessionId": "…", "available": true, "complete": true,
      "attention": 1, "ready": 2, "working": 1,
      "oldestAttentionAt": "…", "lastEvidenceAt": "…", "agentsWithoutEnd": 3 },
    // oldestAttentionAt = min(lastEvidenceAt(c)) over the conversations counted as attention
    { "sessionId": "…", "available": false, "reason": "capture-off" | "unreadable" | "unavailable" }
  ]
}
```

(`ready` exists only under option A.)

### Which projects, and what each result means

The sessions come from the caller's own **running** sessions: `sessions.listForUser`, extended to return `conversation_requested`. **That is one D1 read per computation** (see Cost). If that read fails, the endpoint answers **503**, never `200` with an empty list. The client then applies the "as of" / "—" rule.

| Situation | Result | Makes header totals "at least"? |
|---|---|---|
| Capture flag off at boot, a revocation in effect (marker stat), or not requested | `available:false, reason:"capture-off"` | No: known and harmless, so no badge |
| Recreation unresolved (§2.7) | `available:false, reason:"unavailable"` | Yes |
| Enumerating the session's conversations failed (readdir error) | `available:false, reason:"unreadable"` | Yes |
| A fresh-enough conversation's index unreadable or missing (`peekIndex` null covers both) | `complete:false`, counts shown | Yes ("at least N") |
| Everything read | `complete:true` | No |

"Effective" capture is **not** verified, since there is no probe (D7). A dead relay shows as "no fresh evidence", that is, no badge. **The UI never renders a phrase like "nothing needs you".** It only omits the badge.

### Where the conversations come from (enumeration)

The set is **`runtime` ∪ the conversations on disk**, from a readdir of `<WORKSPACE_ROOT>/.conversations/<sid>`. It is not D1 rows, and it is not `runtime` alone.

The readdir needs a **strict** variant of `store.listConversationIds`. The current one catches every error and returns `[]`, which would make an EACCES or EIO look like "no conversations" and report `complete:true`. The strict variant (e.g. `listConversationIdsStrict`):
- ENOENT → the session has no conversations yet: empty and complete;
- any other error → `available:false, reason:"unreadable"`.

The existing reconcile caller keeps the lenient one.

`runtime` comes up short in three cases:
- after a backend restart whose boot reconcile was skipped or partial: D1 down at boot, `recreate-unresolved`, or an `OwnerUnverified` throw;
- while a new conversation is between index creation and its owner reservation;
- during a D1 outage, when ingest cannot create runtimes.

For each conversation, in this order:
1. **Resident, or leaving memory:** a store helper returns the in-memory index from `resident` **or `evicting`**, the same first branch as `peekIndex`. While an eviction's snapshot write is in flight, the file on disk still carries the older mtime, so a stat would wrongly skip a fresh conversation.
2. **Index file on disk:** `stat` it. If its mtime is older than `staleAfterMs`, it cannot hold fresh evidence and is skipped unread. Otherwise `store.peekIndex` reads the snapshot: no events scan, nothing made resident. A null result gives `complete:false`.
3. **No index file, only `.events.jsonl`:** `stat` the events file. If it is old, the conversation is skipped. If it is recent, or the stat fails, `complete:false`. This keeps an old orphan events file from leaving the project at "at least N" forever.

Cost per computation is therefore one readdir and one stat per non-resident conversation, plus snapshot reads only for recent ones.

### Cost

- **Per computation:** one D1 read (`listForUser`), with no probe and no `docker exec`, plus the enumeration above (in memory, a readdir, stats, and a few snapshot reads).
- **Per user:** a 5 s cache with single-flight, so a header, a sidebar and several tabs share one computation. That bounds D1 to at most one read per user per 5 s, and with 20 s polling it is about 3 per minute per user.
- **Concurrency:** one `InFlightLimiter` slot is held **per computation**, not per request, so a tab joining a pending computation never gets a 429.
- **Rate limit:** `activityIp`, 60/min per IP. That leaves headroom for several tabs and several people behind one NAT (each tab polls 3 times a minute).

### Freshness of the badges (owner decisions, 2026-11-06)

- **Polling:** every **20 s** while the page is **visible**, paused while hidden. One refresh when the page regains focus or visibility, **unless a backoff or a `Retry-After` is active**, so focus toggling can't push past a 429.
- **Single flight:** at most one request in flight per page. Ticks and focus events coalesce into the pending request. The sidebar, the header and the switcher read one client cache.
- **Backoff:**
  - **429:** honour `Retry-After`, clamped to [20 s, 5 min]. The backend's CORS middleware must add `Access-Control-Expose-Headers: Retry-After`; cross-origin (Pages → Tunnel) the header is unreadable without it, and the change gets a test.
  - **No `Retry-After`, network errors, 5xx:** exponential backoff 20 s → 40 s → 80 s → 160 s, capped at 5 min, ±20 % jitter. It resets on the first success.
  - **404 (older backend):** polling stops for the page's lifetime and no badges are shown. It does not back off.
  - **401:** polling stops, and the session-expiry flow takes over. Polling **resumes when a new auth epoch starts** (login).
- **Account switches:** the request goes through `api.ts`'s epoch-checked path (`authEpoch`). The cache entry stores its epoch, and an answer or a 401 from another epoch is dropped (CLAUDE.md, Auth). Logout clears the cache.
- **Staleness on the client:** if the last success is **more than 40 s** old (wall clock, whatever the backoff), badges show their last value with "as of <time>". After 2 minutes they show "—".

## UI (built on existing pieces)

- **Sidebar project row:** a small badge.
  - "● 1 needs you" in the attention tone, and under option A a muted "2 ready". "1 working" is muted.
  - Nothing when everything is 0 or the project is `capture-off`.
  - "—" with the reason in the tooltip when the project is unavailable or unreadable.
  - "at least N" when `complete:false`.
  - **Subagents only in the tooltip** ("3 subagents started, no end yet"), never as a counter.
  - The tooltip reads "waiting, last confirmed N min ago", from `oldestAttentionAt`. A confirming probe renews it, so it says when the wait was last confirmed, not how long it has lasted.
  - The badge opens the switcher filtered to that project.
- **Header:**
  - the switcher button shows the total "needs you", as "at least N" when any project is incomplete or unreadable;
  - **`document.title` is never changed by the signal.** The tab keeps #551's project and view.
- **Switcher (#548):** its at-a-glance line can use the same numbers before the lists finish loading. Titles still come from the per-project lists when it opens.
- **Central activity view (future):** projects × conversations × agents, built from:
  - `switcherModel` (shared bucket rule, `ProjectLoader`/`Slots`, `parallelSummary`);
  - `agentsSummary`;
  - this endpoint.

  It needs no new data source and duplicates nothing from Project Chat.

## Security and privacy

- **Owner-only:** sessions come from the caller's own list, so a foreign session never appears. Counts and timestamps only, never titles.
- **Account isolation:** the epoch binding and logout cleanup keep one account's project ids and counts from reaching the next one in the same browser.

## Tests (when implemented)

- **Backend unit:**
  - the bucket rule at and across the 10 min boundary, including an archived conversation with a fresh claim, which is counted;
  - enumeration: a disk-only conversation with a fresh claim after a restart with D1 down at boot is counted; an old index is skipped without being read; a `peekIndex` null on a recent index gives `complete:false`; a strict-readdir failure other than ENOENT gives `unreadable`, and ENOENT gives empty and complete; a fresh conversation whose eviction write is in flight is counted; an events-only conversation that is old is skipped, and a recent one gives `complete:false`;
  - `capture-off` for flag off, revocation and not requested; `unavailable` for `recreate-unresolved`;
  - the cache TTL and single-flight; one InFlight slot per computation;
  - ownership;
  - `listForUser` failure gives 503.
- **Backend route:**
  - 401 without auth;
  - 429 from `activityIp` with `Retry-After`, **and** `Access-Control-Expose-Headers` contains `Retry-After` on a CORS request;
  - no probe or exec, and exactly one D1 read per computation (spies).
- **Frontend:**
  - polling pauses while the page is hidden; focus refreshes but never during a backoff; `Retry-After` is clamped; 404 stops polling; 401 stops polling, and it resumes on the next login epoch;
  - an answer from another epoch is dropped, and logout clears the cache;
  - badges: attention, ready (option A), working, at-least, unavailable, "as of", "—";
  - `document.title` is never changed by the signal;
  - e2e with the mock backend for the sidebar badge and switcher navigation;
  - the shared bucket module is byte-identical between frontend and backend (a test like the `composerText` one).

## Rollout

1. Backend endpoint, plus the CORS expose header and the shared bucket module, with the tests above. It is read-only and has no flag. **Merge and deploy need the owner's approval** (app-only, usual procedure).
2. Frontend. It treats 404 as "no signal", so it can ship before the backend.
3. A week of `GET /api/admin/stats → activity` (requests, computation time, D1 reads) before considering push (`WS /ws/activity`, coalesced at 2 s, added to `WS_PATH_PREFIXES`).

## Owner decisions

- **(2026-11-06)**
  - Polling every 20 s, only while the page is visible, with a refresh when it regains focus.
  - No `(N)` prefix in `document.title`.
  - Subagents only in the sidebar tooltip.
  - Backoff on 429 and network errors, and no duplicate concurrent requests.
- **(pending)** What "needs you" means: option A (recommended, permission prompts only, with "ready" shown apart) or option B (today's switcher rule).

## Assumptions

- One backend process per D1 database, as everywhere else in this codebase. The 5 s cache is process-local.

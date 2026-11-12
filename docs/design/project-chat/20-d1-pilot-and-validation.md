# D1 in production: first pilot, and the validation criteria for two agents

Status: D1 (`PROJECT_CONVERSATION_ENABLED`) has been active on VM100 since 2026-11-12 17:16Z. It runs
image `faddf7f01408`, built from `0fb3685`, and the origin flag stays `observe`. D2 and D3 are off.
This document records what the first real use showed and fixes the criteria that a two-agent
conversation must meet before D1 counts as stable. It contains no message text and no ids: only the
**shape** of the events, read from the project log.

## 1. What the first pilot exercised (2026-11-12, project "Pilot")

The owner made two sends from the v3 workspace (New task, recipient chips) and pressed Done three
times. The log holds 20 events, all well formed and in seq order.

| # | What the person did | What the log recorded (in order) |
| --- | --- | --- |
| 1 | A task to **one** agent | `message` · `delivery planned → sending → delivered` (≈ 3.4 s) · `reply_settling` (+1.8 s) · `reply_ref exact` after **exactly** the 10 s settle window · `owner_ack {msg, agent, report_sha256}` 50 s later |
| 2 | A task to **two** agents | `message` with two recipients · one `planned` per agent, written in the same append · two **independent** `sending` → `delivered` (≈ 4.3 s each, interleaved) · two `reply_settling` · two `reply_ref exact` · **two separate** `owner_ack`, about 80 s apart |

### What this shows, mapped to the contract

| Contract point | Observed |
| --- | --- |
| §3.3 S1: the `message` and every `delivery{planned}` in ONE append | Seqs 8–10 share one timestamp |
| §3.3 step 3: recipients are independent | The two `sending` events are 30 ms apart; each delivery completed on its own |
| §4.1: `reply_ref` only after the settle window | `reply_ref.at − reply_settling.at` = 10.00 s in all three cases |
| §4.1: `exact` only with a fully observed window | All three are `exact`; no `ambiguous{…}` |
| §4.3: Done is `owner_ack`, one per item | One ack per reply; each names msg + agent + report hash |
| UX: a reply closes only its own card | Two acks for the two replies of the same message, pressed separately |
| D2/D3 stay off | No `artifact`, `grant` or relay events |

### What it did not exercise yet

- A recipient that refuses (busy), is not sent, or is uncertain, in production.
- A follow-up in the thread (`in_reply_to`) or a **Reply…** with `quote_ref`.
- Done seen from a **second device**. Persistence is proven by the log, not yet by a person.
- A reply that is `ambiguous`, `failed` or late-closed, and a capture that rotated ("no longer retained").
- Paging past the first 200 events, and a gap after a sleeping tab.

## 2. Validation criteria: a conversation with two agents

D1 counts as **operationally validated** when every row below has passed **once in production**.
Each row needs evidence from the project log (event shape only) **and** what the person saw.
Rows marked ✓ were already met by the first pilot.

### A. Fan-out and independent results

| ID | Scenario | Pass when |
| --- | --- | --- |
| A1 ✓ | A task to 2 agents, both ready | One `message`, two `delivered`. The thread shows both chips "Delivered ✓" |
| A2 | A task to 2 agents, **one busy** (working on a turn) | The busy one gets `refused{busy}` with no Composer effect; the other is `delivered`. The composer and the thread say "Not every agent received this: 1 of 2…". For you has "Not delivered to @x". **Nothing is retried** |
| A3 | Then a resend in the **same thread** to the agent that refused | Its delivery is `delivered`, and its "Not delivered" card disappears **without** Done. The other agent's items are unchanged |
| A4 | A lost answer: close the tab or cut the network while "Sending…" | On return, **Check** gives the same `msgId` (`replayed: true`) and the log has exactly **one** `message` |

### B. Independent replies

| ID | Scenario | Pass when |
| --- | --- | --- |
| B1 ✓ | Both agents reply | Two `reply_ref exact`, each under its own agent in the same thread. Each text matches its `report_sha256` |
| B2 | One agent replies long before the other | The first reply shows (confirming…, then the reply) while the other row still says working or waiting. Nothing waits for the slower agent |
| B3 | **Reply…** to agent 1's reply only | The message carries `quote_ref` naming agent 1's reply. Agent 1's card closes **only** if that send is `delivered`; agent 2's card stays |
| B4 | **Reply…** whose send is refused | The quoted reply's card **stays** in For you (the owner's SHOULD-FIX on #589) |

### C. Done that persists

| ID | Scenario | Pass when |
| --- | --- | --- |
| C1 ✓ | Done on each reply, separately | Two `owner_ack`, each with msg + agent + report hash; each card goes only after its own ack is in the log |
| C2 | Done on the desktop, then open the phone, a fresh session | The card is already gone on the phone, with no action there |
| C3 | Done on a "Not delivered" card | An `owner_ack {msg, agent}` without a hash. That agent's **reply** to a later send is not affected |
| C4 | Done with the network cut | "it may or may not be marked" → **Check** reuses the same `clientAckId`, and the log has **one** ack |

### D. Robustness the person should never notice

| ID | Scenario | Pass when |
| --- | --- | --- |
| D1 | Leave the tab in the background for minutes during activity, then return | The thread is complete: no missing events and no duplicates. If a gap could not be read, the UI says "Some recent activity isn't loaded yet" |
| D2 | Select text in a reply while agents work (polls every 5 s) | The selection survives the polls |
| D3 | A reply arrives while the phone keyboard is open in the composer | The draft and the focus stay. Nothing jumps |

## 3. Out of scope for this validation

D2 (artifacts), D3 (relays/grants), the origin flag, recreating sessions, and anything that
writes outside the project log.

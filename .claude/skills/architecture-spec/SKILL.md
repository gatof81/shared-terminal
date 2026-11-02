---
name: architecture-spec
description: Use when writing or reviewing an architecture document, RFC, protocol contract, POC spec or roadmap for Shared Terminal (docs/design/**, docs/CONVERSATION.md and siblings). Triggers - "diseñá", "RFC", "spec", "contrato", "arquitectura", "POC", "GO/NO-GO", evaluating a Claude Code capability (hooks, channels, MCP, agent view) before building on it. Not for implementation PRs or code review.
---

# Architecture specs for Shared Terminal

Shared Terminal's design documents are **binding contracts**, not essays. Code follows the
contract; a contract changes in a docs PR before (or with) the code. This skill keeps new specs
consistent with the ones that already work (`docs/CONVERSATION.md`, `docs/design/phase3-*.md`,
`docs/design/ui-unificada.md`).

## Before writing

1. Read the current contract sections the change touches (grep `docs/CONVERSATION.md` headings,
   `CLAUDE.md` Architecture). Cite them as `§x.y`; never restate them differently.
2. Read the code the design would reuse and name it (`file.ts`, function). Prefer extending an
   existing seam (ingest route, store, lifecycle lock, capture activation, probe) over a new
   process, queue, database or service. Every new moving part needs a sentence saying why the
   existing one cannot do it.
3. For every Claude Code capability the design depends on, build an **evidence table**:

   | Capability | Documented (URL + quote) | Observed (binary strings / smoke / issue) | Hypothesis | Known limitation |

   Never promote a hypothesis to a fact because docs imply it. A research-preview or `@internal`
   feature is a dependency risk and is labelled as such. Record the CLI version every observation
   was made with.

## Writing rules

- Spanish, like the existing design docs; identifiers, code and wire names in English.
- *MUST* / *MUST NOT* are test-verified requirements; *SHOULD* is review-verified.
- Separate **delivered (transport)**, **accepted (evidence the agent took it)** and **result**.
  Never let one imply the other.
- Fail closed: an unknown state blocks the action and explains itself; nothing is retried
  automatically when a retry could duplicate a visible effect.
- Name the durable truth of every state (D1 row, host file, in-memory only) and what survives a
  backend restart, a container stop and a recreation.
- Content never goes to D1 (CLAUDE.md, phase3 §3.3); D1 holds metadata only.
- Every limit is a number with an "on exceed" column.
- Authorization reuses `assertOwnedBy*`, `assertCanObserve`, `assertCanOperate`; a new tier needs
  an explicit owner decision.
- Backward compatible by default: new tables/columns via append-only migrations, flags default off,
  behaviour-neutral when off.
- Mermaid diagrams only where a sequence or state machine is easier to read as a picture.

## Required sections for an RFC

Context and evidence · Goals / non-goals · Alternatives (with a comparison table) · Decision and
why · Components (reused vs new) · Failure and recovery matrix · Security (prompt injection,
isolation, audit) · Limits · Compatibility and migration · Open questions with owner.

## POC specs

Write the GO / NO-GO criteria **before** the experiment: measurable, with counts and thresholds,
and a named outcome for each failure (NO-GO, re-design, accepted limitation). The POC never runs on
real user sessions or production; it states its isolation, CLI version, auth and cost.

## Review before presenting

Run an independent critical review (a fresh subagent given the documents, not your conclusions)
on: unnecessary complexity, message loss, duplicates and races, restarts, prompt injection,
experimental-feature dependency, version compatibility, two-mechanism drift, operating cost. Record
findings and resolutions in the design folder; fix BLOCKER/SHOULD-FIX items before handing over.

## Output

A folder `docs/design/<initiative>/` with a README that lists the documents, the decisions that
need the owner, and the top risks. A draft PR, never merged by the agent.

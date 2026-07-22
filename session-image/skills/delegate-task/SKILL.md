---
name: delegate-task
description: Use when composing a task for a delegated worker — a subagent, or a specialist in another session/hub with NO shared context and NO memory of this codebase. Invoke BEFORE writing the task message to produce a distilled brief. Triggers: "delegate", "ask <worker> to", "hand this off", "send a task to <specialist>", writing a prompt for another agent to implement/fix/test something in a repo it did not build.
---

# Delegating a task to a context-less worker

A worker you delegate to (a subagent, or a specialist in another session/hub)
starts **cold**: it did not build this code, it has no memory of prior turns,
and — by design — you should not dump your whole context into it. Its typical
failure mode is **not** writing wrong code. It is writing *plausible* code that
reinvents a helper that already exists, ignores a repo convention, or fixes the
symptom instead of the cause because it never saw the other three call sites.

The fix is not "give it more context" (that defeats the point of delegating).
The fix is that **you distill the correct, minimal context for it**. The
brief is the highest-leverage artifact in the whole hand-off: if it is poor,
nothing downstream can recover. Invest here.

## Do this first (cheap, and it is where the brief becomes truthful)

Before writing the brief, **read enough of the target code yourself** to fill
the fields below with real names, not guesses:

- Open the file(s) to change and their neighbours.
- Find the existing helper/type/pattern the worker should reuse — grep for it,
  confirm the exact name and path.
- Find the sibling call sites / the real root cause, so the objective is the
  cause, not the symptom.
- Confirm the exact verify command actually runs in that repo.

A brief you could have written without reading the code is probably too vague.

## The brief (fill every field; drop a field only if you are sure it is N/A)

1. **Objective — in behavioural terms, not implementation.** What observable
   outcome changes. *"The endpoint returns 402 `card_expired` instead of a 500
   on an expired card"* — NOT *"change the try/catch in payments.ts"*. If you
   hand over the implementation already decided, the worker cannot notice it is
   wrong.
2. **Files to EDIT** — exact paths.
3. **Files to READ as reference** — the pattern/helper to imitate
   (*"follow `RefundHandler`"*). This is the single most-often-omitted field and
   the one that most cheaply kills the reinvent-a-worse-helper failure. Reading
   reference costs nothing and does not break any isolation — encourage it.
4. **Reuse** — the existing helpers / types / utilities to use instead of
   writing new ones. Name them exactly.
5. **Constraints that are not obvious** — what NOT to touch, public API/contract
   surfaces to preserve, pending migrations, decisions already made that must
   not be re-litigated, and the scope edge (neighbouring cases in or explicitly
   out).
6. **How to verify** — the exact command(s): lint, typecheck, the specific test
   file/name, build. *This is the biggest quality lever in the list.* Without
   it you get "should work"; with it you get verified.
7. **Done criteria** — needs a test? update a doc/changelog/spec section? open a
   PR (branch name, base, commit/PR conventions, language)? Report only?

## Mechanics to include (when the worker opens a PR)

- Repo + how to get it (clone URL if it may not be present).
- Branch name off the base branch; one PR = one coherent change.
- Commit/PR conventions and language for artifacts.
- **Tell it to STOP and report if it is blocked** (missing access/credentials,
  or an ambiguity that would change the result) rather than guess and deliver
  the wrong thing.

## Copy-paste template

```
Objective (behaviour): <what outcome changes, observably>
Files to edit: <paths>
Read as reference (do not change): <paths / patterns to imitate>
Reuse (don't reinvent): <existing helpers/types by exact name>
Constraints: <don't-touch / public contracts / decided, not up for debate / scope edge>
Verify: <exact lint/typecheck/test/build commands — must pass>
Done when: <test added? docs? PR (branch <name> off <base>, <commit convention>, <language>)?>
Blocked? Stop and tell me exactly what you need — don't guess.
```

## The other half of the contract (worker side)

This skill is the *caller's* discipline. It pairs with a worker-side contract
(read-before-write, structured report not prose, honest reporting including
failures, stop-and-ask on result-changing ambiguity) that belongs in the
worker's own definition/system prompt, not here — so it loads on every run of
that worker regardless of who calls it.

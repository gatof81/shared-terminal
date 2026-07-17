/**
 * observeMode.ts — the observe/operate mode enum + its pure state
 * transition (#admin-operate 4/4). Kept DOM-free and separate from
 * `observeModal.ts` so the toggle can be unit-tested without a jsdom
 * rig (observeModal.ts binds DOM at module load and can't be imported
 * under test).
 */

/** 'observe' = read-only watch; 'operate' = admin drove the session
 *  (full write). Mirrors the backend `session_observe_log.mode`. */
export type ObserveMode = "observe" | "operate";

/** The mode the take/release-control toggle flips to from `current`.
 *  Observe ⇄ operate is the only transition, so this is an involution;
 *  a named helper (over an inline ternary) keeps the escalation vs
 *  de-escalation intent legible at both call sites. */
export function nextObserveMode(current: ObserveMode): ObserveMode {
	return current === "observe" ? "operate" : "observe";
}

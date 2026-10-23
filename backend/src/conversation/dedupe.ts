/**
 * conversation/dedupe.ts — docs/CONVERSATION.md §4.6: event identity.
 *
 * Sharing a `prompt_id`, a turn or a pane is NEVER a duplicate criterion.
 * Events with a natural identity (tool_use_id, message_id+index,
 * agent_id, task_id, prompt_id) dedupe on that identity for the lifetime
 * of the table; events without one (`Stop` can fire several times for
 * one prompt when a hook blocks and the turn continues; notifications;
 * SessionStart/End) dedupe only on an IDENTICAL payload hash inside a
 * 10 s window, which collapses hook retries without touching distinct
 * events. The hash is taken over the canonical JSON of the raw hook
 * input, BEFORE redaction, so two events that differ only in a field we
 * later drop are still distinct.
 */

import { createHash } from "node:crypto";
import { DEDUPE_TABLE_MAX, DEDUPE_WINDOW_MS } from "./limits.js";

/** Canonical JSON: object keys sorted recursively, arrays in order. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			out[key] = sortKeys((value as Record<string, unknown>)[key]);
		}
		return out;
	}
	return value;
}

export function payloadHash(rawHookInput: unknown): string {
	return createHash("sha256").update(canonicalJson(rawHookInput)).digest("hex");
}

export interface IdentityInput {
	ev: string;
	agentId?: string | null;
	promptId?: string | null;
	messageId?: string;
	index?: number;
	toolUseId?: string;
	taskId?: string;
	teammateName?: string;
}

/**
 * The identity key for an event, or `null` when the event has no natural
 * identity and must fall back to the payload-hash window.
 */
export function identityKey(input: IdentityInput): string | null {
	switch (input.ev) {
		case "user_prompt":
			return input.promptId ? `user_prompt:${input.promptId}` : null;
		case "assistant_delta":
			if (input.messageId === undefined || input.index === undefined) return null;
			return `assistant_delta:${input.agentId ?? ""}:${input.messageId}:${input.index}`;
		case "tool_start":
		case "tool_end":
		case "tool_failed":
			return input.toolUseId ? `${input.ev}:${input.toolUseId}` : null;
		case "agent_start":
		case "agent_end":
			return input.agentId ? `${input.ev}:${input.agentId}` : null;
		case "task_created":
		case "task_completed":
			return input.taskId ? `${input.ev}:${input.taskId}` : null;
		default:
			return null;
	}
}

/**
 * Per-conversation table. `seen(identity, hash, now)` returns true when
 * the event is a duplicate and must be dropped.
 */
export class DedupeTable {
	/** identity key → first-seen time (kept for LRU ordering only). */
	private readonly identities = new Map<string, number>();
	/** payload hash → first-seen time (window-bounded). */
	private readonly hashes = new Map<string, number>();

	constructor(
		private readonly max = DEDUPE_TABLE_MAX,
		private readonly windowMs = DEDUPE_WINDOW_MS,
	) {}

	seen(identity: string | null, hash: string, now: number, teammateScope?: string): boolean {
		if (identity !== null) {
			if (this.identities.has(identity)) return true;
			this.remember(this.identities, identity, now);
			return false;
		}
		const key = teammateScope ? `${teammateScope}:${hash}` : hash;
		const first = this.hashes.get(key);
		if (first !== undefined && now - first <= this.windowMs) return true;
		this.remember(this.hashes, key, now);
		return false;
	}

	private remember(map: Map<string, number>, key: string, now: number): void {
		map.delete(key);
		map.set(key, now);
		while (map.size > this.max) {
			const oldest = map.keys().next().value;
			if (oldest === undefined) break;
			map.delete(oldest);
		}
	}

	size(): number {
		return this.identities.size + this.hashes.size;
	}
}

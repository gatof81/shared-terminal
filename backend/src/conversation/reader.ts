/**
 * conversation/reader.ts — streaming reads of a conversation's events file
 * for the 3.1 read surface (docs/CONVERSATION.md §6): backward pages for
 * `GET …/events`, a single event for `GET …/events/:seq`, and the forward
 * replay the WS uses.
 *
 * The file can reach L7 (64 MiB) before it rotates, so nothing here loads
 * it whole: lines are streamed and only the selected events are kept. Only
 * the CURRENT file is read — `firstRetainedSeq` is the first seq in it
 * (the `gap rotated` that starts a rotated file), and anything older is
 * reported to the client as `history_rotated`, never served from `.1`.
 *
 * A torn last line (an append in flight, or a crash mid-write) is skipped,
 * exactly like the store's own recovery scan.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { PersistedEvent } from "./store.js";

/** Events of `file` in seq order; a missing file yields nothing. */
export async function* streamEvents(
	file: string,
): AsyncGenerator<{ event: PersistedEvent; bytes: number }> {
	const input = createReadStream(file, { encoding: "utf8" });
	// A missing file errors on open; readline would rethrow it from the
	// iterator. Swallow ENOENT only: a purged or not-yet-written
	// conversation has no events, anything else is a real read failure.
	const opened = new Promise<boolean>((resolve, reject) => {
		input.once("open", () => resolve(true));
		input.once("error", (err: NodeJS.ErrnoException) => {
			if (err.code === "ENOENT") resolve(false);
			else reject(err);
		});
	});
	if (!(await opened)) return;
	const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
	try {
		for await (const line of lines) {
			if (!line) continue;
			let event: PersistedEvent;
			try {
				event = JSON.parse(line) as PersistedEvent;
			} catch {
				continue; // torn line
			}
			if (typeof event?.seq !== "number") continue;
			yield { event, bytes: Buffer.byteLength(line, "utf8") };
		}
	} finally {
		lines.close();
		input.destroy();
	}
}

export interface PageQuery {
	/** Exclusive upper bound; `null` = from the newest event. */
	before: number | null;
	limit: number;
	firstRetainedSeq: number;
	/** G5 — serialised bytes per response. */
	maxBytes: number;
}

export interface Page {
	events: PersistedEvent[];
	hasMore: boolean;
}

/**
 * The newest `limit` events with `firstRetainedSeq ≤ seq < before`,
 * ascending. Past `maxBytes` the OLDEST selected events are dropped (and
 * `hasMore` says so), but the newest one is always returned, so paging
 * backwards always progresses.
 */
export async function readPage(file: string, q: PageQuery): Promise<Page> {
	const floor = Math.max(1, q.firstRetainedSeq);
	if (q.before !== null && q.before <= floor) return { events: [], hasMore: false };
	const kept: Array<{ event: PersistedEvent; bytes: number }> = [];
	let eligible = 0;
	for await (const item of streamEvents(file)) {
		const seq = item.event.seq;
		if (seq < floor) continue;
		if (q.before !== null && seq >= q.before) break;
		eligible++;
		kept.push(item);
		if (kept.length > q.limit) kept.shift();
	}
	let bytes = 0;
	let start = kept.length;
	while (start > 0 && (start === kept.length || bytes + kept[start - 1].bytes <= q.maxBytes)) {
		bytes += kept[start - 1].bytes;
		start--;
	}
	const events = kept.slice(start).map((k) => k.event);
	return { events, hasMore: eligible > events.length };
}

/** The event with exactly `seq` in the current file, or null. */
export async function readOne(
	file: string,
	seq: number,
	firstRetainedSeq: number,
): Promise<PersistedEvent | null> {
	if (seq < Math.max(1, firstRetainedSeq)) return null;
	for await (const { event } of streamEvents(file)) {
		if (event.seq === seq) return event;
		if (event.seq > seq) return null;
	}
	return null;
}

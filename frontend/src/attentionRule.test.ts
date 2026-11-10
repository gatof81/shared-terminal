import { describe, expect, it } from "vitest";
import type { Presence } from "./api.js";
import {
	ATTENTION_STALE_MS,
	attentionKind,
	evidenceSource,
	lastEvidenceMs,
} from "./attentionRule.js";
import { lastEvidenceAt, presentStatus, STALE_EVIDENCE_MS } from "./conversationModel.js";
import { presentPresence } from "./projectModel.js";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const c = (
	status: string,
	age = 60_000,
	lastEventAt: string | null = null,
	statusEvidence = "hook:PermissionRequest",
) => ({
	status,
	statusAt: ago(age),
	lastEventAt,
	statusEvidence,
});

describe("attentionKind (owner option A, 2026-11-06)", () => {
	it("needs you = a fresh permission prompt only; ready = a fresh prompt; working = running/background", () => {
		expect(attentionKind(c("waiting_permission"), NOW)).toBe("attention");
		expect(attentionKind(c("waiting_input"), NOW)).toBe("ready");
		expect(attentionKind(c("running"), NOW)).toBe("working");
		expect(attentionKind(c("waiting_background"), NOW)).toBe("working");
	});
	it("a live claim at or past the window is stale, never activity; both times unparsable ⇒ stale", () => {
		expect(attentionKind(c("waiting_permission", ATTENTION_STALE_MS), NOW)).toBe("stale");
		expect(attentionKind(c("running", ATTENTION_STALE_MS - 1), NOW)).toBe("working");
		expect(attentionKind({ status: "running", statusAt: "x", lastEventAt: "y" }, NOW)).toBe(
			"stale",
		);
	});
	it("a newer event refreshes an old state; unknown and finished states are not live", () => {
		expect(attentionKind(c("waiting_permission", 3_600_000, ago(1000)), NOW)).toBe("attention");
		expect(attentionKind(c("unknown"), NOW)).toBe("unknown");
		expect(attentionKind(c("ended"), NOW)).toBe("other");
		expect(attentionKind(c("error"), NOW)).toBe("other");
	});
	it("agrees with presentStatus/lastEvidenceAt on freshness (the window is the same constant)", () => {
		expect(ATTENTION_STALE_MS).toBe(STALE_EVIDENCE_MS);
		for (const age of [
			0,
			1000,
			STALE_EVIDENCE_MS - 1,
			STALE_EVIDENCE_MS,
			STALE_EVIDENCE_MS + 5000,
		]) {
			for (const status of [
				"running",
				"waiting_input",
				"waiting_permission",
				"waiting_background",
			]) {
				const x = c(status, age);
				const p = presentStatus(status, lastEvidenceAt(x), NOW);
				expect(attentionKind(x, NOW) === "stale").toBe(p.stale);
			}
		}
		expect(lastEvidenceMs(ago(5000), ago(1000))).toBe(NOW - 1000);
		expect(lastEvidenceMs(ago(5000), "bad")).toBe(NOW - 5000);
	});
});

describe("'needs you' is the CLI's own hook only (owner rule 2026-11-09, #569)", () => {
	it("a probe-only, capture or unlabelled permission state is unknown, never attention", () => {
		expect(attentionKind(c("waiting_permission", 60_000, null, "probe:waiting"), NOW)).toBe(
			"unknown",
		);
		expect(attentionKind(c("waiting_permission", 60_000, null, ""), NOW)).toBe("unknown");
		expect(attentionKind({ status: "waiting_permission", statusAt: ago(1000) }, NOW)).toBe(
			"unknown",
		);
		expect(attentionKind(c("waiting_permission", 60_000, null, "hook"), NOW)).toBe("attention");
		// Staleness still comes first, and only the permission state looks at the source.
		expect(
			attentionKind(c("waiting_permission", ATTENTION_STALE_MS, null, "probe:waiting"), NOW),
		).toBe("stale");
		expect(attentionKind(c("waiting_input", 60_000, null, "probe:idle"), NOW)).toBe("ready");
		expect(attentionKind(c("running", 60_000, null, "probe:busy"), NOW)).toBe("working");
	});

	it("evidenceSource derives the same source as the backend's presence", () => {
		expect(evidenceSource("hook:PermissionRequest")).toBe("hook");
		expect(evidenceSource("probe:waiting")).toBe("probe");
		expect(evidenceSource("hook")).toBe("hook");
		expect(evidenceSource("")).toBe("capture");
		expect(evidenceSource(":x")).toBe("capture");
		expect(evidenceSource(undefined)).toBe("capture");
	});

	it("the Chat switcher and the project page agree on 'needs you' for the same evidence", () => {
		const clock = { generatedAt: new Date(NOW).toISOString(), receivedAt: NOW };
		for (const ev of [
			"hook:PermissionRequest",
			"hook",
			"probe:waiting",
			"reconcile:x",
			"",
			"timeout",
		]) {
			for (const age of [
				0,
				60_000,
				ATTENTION_STALE_MS - 1,
				ATTENTION_STALE_MS,
				ATTENTION_STALE_MS + 1,
			]) {
				const x = c("waiting_permission", age, null, ev);
				// What backend/src/projects/presence.ts derives from the same row.
				const p: Presence = {
					value: "needs_attention",
					detail: "waiting_permission",
					source: evidenceSource(ev),
					at: x.statusAt,
				};
				const chat = attentionKind(x, NOW) === "attention";
				const projects = presentPresence(p, clock, NOW).label === "Needs you";
				expect(chat, `${ev} @ ${age}`).toBe(projects);
			}
		}
	});
});

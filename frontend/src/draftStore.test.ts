import { beforeEach, describe, expect, it } from "vitest";
import {
	forgetAllDrafts,
	MAX_CHARS,
	MAX_ENTRIES,
	readDraft,
	TTL_MS,
	writeDraft,
} from "./draftStore.js";

class MemoryStorage {
	private m = new Map<string, string>();
	get length() {
		return this.m.size;
	}
	key(i: number) {
		return [...this.m.keys()][i] ?? null;
	}
	getItem(k: string) {
		return this.m.get(k) ?? null;
	}
	setItem(k: string, v: string) {
		this.m.set(k, String(v));
	}
	removeItem(k: string) {
		this.m.delete(k);
	}
	clear() {
		this.m.clear();
	}
}

beforeEach(() => {
	(globalThis as { localStorage: unknown }).localStorage = new MemoryStorage();
});

describe("draftStore", () => {
	it("keeps a draft per conversation of each project, and an empty text removes it", () => {
		writeDraft("s1", "c1", "hello");
		writeDraft("s2", "c1", "other project");
		expect(readDraft("s1", "c1")).toBe("hello");
		expect(readDraft("s2", "c1")).toBe("other project");
		expect(readDraft("s1", "c2")).toBe("");
		writeDraft("s1", "c1", "");
		expect(readDraft("s1", "c1")).toBe("");
		expect(localStorage.length).toBe(1);
	});

	it("ignores and removes a draft older than the TTL", () => {
		writeDraft("s1", "c1", "old", 1000);
		expect(readDraft("s1", "c1", 1000 + TTL_MS)).toBe("old");
		expect(readDraft("s1", "c1", 1001 + TTL_MS)).toBe("");
		expect(localStorage.length).toBe(0);
	});

	it("never stores more than MAX_ENTRIES: the oldest go, the one just written stays", () => {
		for (let i = 0; i < MAX_ENTRIES + 5; i++) writeDraft("s1", `c${i}`, `d${i}`, 10_000 + i);
		expect(localStorage.length).toBe(MAX_ENTRIES);
		expect(readDraft("s1", "c0", 10_100)).toBe("");
		expect(readDraft("s1", `c${MAX_ENTRIES + 4}`, 10_100)).toBe(`d${MAX_ENTRIES + 4}`);
	});

	it("a text over MAX_CHARS is not stored and drops the stale copy", () => {
		writeDraft("s1", "c1", "short");
		writeDraft("s1", "c1", "x".repeat(MAX_CHARS + 1));
		expect(readDraft("s1", "c1")).toBe("");
	});

	it("an unreadable entry reads as no draft", () => {
		localStorage.setItem("st.draft.s1.c1", "{not json");
		expect(readDraft("s1", "c1")).toBe("");
	});

	it("logout forgets every draft and nothing else", () => {
		writeDraft("s1", "c1", "a");
		writeDraft("s2", "c9", "b");
		localStorage.setItem("st.view.s1", "chat");
		forgetAllDrafts();
		expect(readDraft("s1", "c1")).toBe("");
		expect(readDraft("s2", "c9")).toBe("");
		expect(localStorage.getItem("st.view.s1")).toBe("chat");
	});

	it("blocked storage: reads are empty and writes do not throw", () => {
		(globalThis as { localStorage: unknown }).localStorage = {
			getItem() {
				throw new Error("blocked");
			},
			setItem() {
				throw new Error("blocked");
			},
			removeItem() {
				throw new Error("blocked");
			},
			key() {
				throw new Error("blocked");
			},
			length: 0,
		};
		expect(() => writeDraft("s1", "c1", "x")).not.toThrow();
		expect(readDraft("s1", "c1")).toBe("");
		expect(() => forgetAllDrafts()).not.toThrow();
	});
});

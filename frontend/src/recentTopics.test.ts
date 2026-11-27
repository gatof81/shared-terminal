import { describe, expect, it } from "vitest";
import { pruned, type Recent, recentPlace, samePlace, withVisit } from "./recentTopics.js";

const t = (p: string, c: string) => `#/projects/${p}/c/${c}`;

describe("recent topics (revisión 2 §7)", () => {
	it("a visit goes first, replaces the same place's earlier address, keeps 5", () => {
		let list: Recent[] = [];
		for (const c of ["a", "b", "c", "d", "e", "f"]) list = withVisit(list, t("p", c), c);
		expect(list.map((e) => e.title)).toEqual(["f", "e", "d", "c", "b"]);
		// Its Herramientas is the same place as the topic: one entry, the latest address.
		list = withVisit(list, `${t("p", "d")}/tools/dev/~/git`, null);
		expect(list).toHaveLength(5);
		expect(list[0]).toEqual({ hash: `${t("p", "d")}/tools/dev/~/git`, title: "d" });
		expect(list.filter((e) => e.hash.includes("/c/d"))).toHaveLength(1);
	});

	it("only topics and Herramientas are places", () => {
		expect(withVisit([], "#/projects/p", null)).toEqual([]);
		expect(withVisit([], "#/projects/p/archive", null)).toEqual([]);
		expect(withVisit([], "#/sessions/x", null)).toEqual([]);
		expect(withVisit([], "#/projects/p/tools/dev/~/terminal", null)).toHaveLength(1);
	});

	it("drops a gone project, a topic no longer live (not the one on screen), and renames", () => {
		const list: Recent[] = [
			{ hash: t("p", "a"), title: "A" },
			{ hash: t("p", "b"), title: "B" },
			{ hash: t("p", "new"), title: null },
			{ hash: t("q", "x"), title: "X" },
		];
		expect(pruned(list, { projects: new Set(["p"]) }).map((e) => e.title)).toEqual([
			"A",
			"B",
			null,
		]);
		const live = [{ id: "a", title: "A2" }];
		expect(pruned(list, { pid: "p", live, keep: "new" })).toEqual([
			{ hash: t("p", "a"), title: "A2" },
			{ hash: t("p", "new"), title: null },
			{ hash: t("q", "x"), title: "X" },
		]);
	});

	it("names the place and knows the one on screen", () => {
		expect(recentPlace({ hash: t("p", "a"), title: "CI" })).toBe("«CI»");
		expect(recentPlace({ hash: `${t("p", "a")}/tools/dev/w1/git`, title: "CI" })).toBe(
			"Git de @dev",
		);
		const e = { hash: t("p", "a"), title: "CI" };
		expect(samePlace(e, { projectId: "p", page: "conversation", conversationId: "a" })).toBe(true);
		expect(samePlace(e, { projectId: "p", page: "home" })).toBe(false);
	});
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadScroll } from "./teamView.js";

// ThreadScroll's anchor logic against a small simulated layout (jsdom has
// none). Chromium's own scroll anchoring would hide a bug here in the e2e;
// Safari has none, which is where this code is the only thing keeping the
// reader's place.

const VIEW = 300;

// jsdom has no ResizeObserver: a fake whose callbacks the test fires when the
// box gets a size again (what the browser does when it is attached).
const observers: Array<() => void> = [];
vi.stubGlobal(
	"ResizeObserver",
	class {
		constructor(private cb: () => void) {
			observers.push(() => this.cb());
		}
		observe(): void {}
	},
);
let box: HTMLElement;
const heights = new Map<string, number>();

function layout(): void {
	let y = 0;
	for (const c of box.children) {
		const h = heights.get((c as HTMLElement).dataset.anchor!) ?? 100;
		const top = y;
		(c as HTMLElement).getBoundingClientRect = () =>
			({ top: top - box.scrollTop, bottom: top + h - box.scrollTop }) as DOMRect;
		y += h;
	}
	Object.defineProperty(box, "scrollHeight", { value: y, configurable: true });
}

function rowsOf(ids: string[]): HTMLElement[] {
	return ids.map((id) => {
		const li = document.createElement("li");
		li.dataset.anchor = id;
		li.textContent = id;
		return li;
	});
}

/** One render: replace the rows (always "changed"), lay them out. */
function render(sc: ThreadScroll, ids: string[], root = "t1"): void {
	sc.render(root, () => {
		box.replaceChildren(...rowsOf(ids));
		layout();
		return true;
	});
}

beforeEach(() => {
	observers.length = 0;
	document.body.replaceChildren();
	heights.clear();
	box = document.createElement("ol");
	// A browser clamps scrollTop to [0, scrollHeight - clientHeight] and loses
	// a write to an element with no layout; jsdom does neither.
	let top = 0;
	Object.defineProperty(box, "scrollTop", {
		get: () => (box.isConnected ? top : 0),
		set: (v: number) => {
			if (box.isConnected) top = Math.max(0, Math.min(v, box.scrollHeight - VIEW));
		},
		configurable: true,
	});
	Object.defineProperty(box, "clientHeight", {
		get: () => (box.isConnected ? VIEW : 0),
		configurable: true,
	});
	(box as unknown as { resetScroll: () => void }).resetScroll = () => {
		top = 0;
	};
	box.getBoundingClientRect = () => ({ top: 0, bottom: VIEW }) as DOMRect;
	document.body.append(box);
});

const scrollTo = (top: number) => {
	box.scrollTop = top;
	box.dispatchEvent(new Event("scroll"));
};

describe("ThreadScroll", () => {
	it("opens at the end", () => {
		const sc = new ThreadScroll(box);
		render(sc, ["msg:a", "reply:a", "msg:b", "reply:b", "msg:c"]);
		expect(box.scrollTop).toBe(500 - VIEW);
	});

	it("a row ABOVE the reader growing keeps the row in view where it was", () => {
		const sc = new ThreadScroll(box);
		const ids = ["msg:a", "reply:a", "msg:b", "reply:b", "msg:c", "reply:c", "msg:d", "reply:d"];
		render(sc, ids);
		scrollTo(250); // reading from msg:b's lower half (well away from the end)
		const before = box.children[3]!.getBoundingClientRect().top;
		heights.set("reply:a", 400); // its text loaded: +300 px above the reader
		render(sc, ids);
		expect(box.children[3]!.getBoundingClientRect().top).toBe(before);
		expect(box.scrollTop).toBe(550);
	});

	it("a settling reply confirmed in place is not 'new'; a really new row is", () => {
		const sc = new ThreadScroll(box);
		const ids = ["msg:a", "reply:a:dev:p1", "msg:b", "msg:c"];
		render(sc, ids);
		scrollTo(0);
		render(sc, ids); // same rows (the settling row became the confirmed reply: same anchor)
		expect(sc.pill.hidden).toBe(true);
		render(sc, [...ids, "reply:c:dev:p2", "wait:dev"]);
		expect(sc.pill.hidden).toBe(false);
		expect(sc.pill.textContent).toBe("↓ 1 new");
	});

	it("each thread keeps its own place", () => {
		const sc = new ThreadScroll(box);
		const ids = ["msg:a", "msg:b", "msg:c", "msg:d", "msg:e"];
		render(sc, ids, "t1");
		scrollTo(120);
		render(sc, ["msg:x", "msg:y", "msg:z", "msg:w"], "t2");
		expect(box.scrollTop).toBe(400 - VIEW); // a new thread opens at its end
		render(sc, ids, "t1");
		expect(box.scrollTop).toBe(120);
	});

	it("rendered while detached, the restore waits for a layout instead of being lost", () => {
		const sc = new ThreadScroll(box);
		const ids = ["msg:a", "msg:b", "msg:c", "msg:d", "msg:e"];
		render(sc, ids);
		scrollTo(120);
		box.remove(); // e.g. the agents page replaced the workspace
		(box as unknown as { resetScroll: () => void }).resetScroll(); // detached: offset gone
		render(sc, ids); // the workspace re-renders before it is attached again
		document.body.append(box);
		for (const fire of observers) fire(); // it has a size again
		expect(box.scrollTop).toBe(120);
	});
});

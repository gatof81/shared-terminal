import { describe, expect, it } from "vitest";
import {
	APP_TITLE,
	composeTabTitle,
	resetTabTitle,
	setTitlePage,
	setTitleParts,
} from "./tabTitle.js";

describe("composeTabTitle", () => {
	it("names the project and the view; the terminal view needs no label", () => {
		expect(composeTabTitle({ project: "my-project", view: "chat" })).toBe(
			"my-project · Chat — Shared Terminal",
		);
		expect(composeTabTitle({ project: "my-project", view: "git" })).toBe(
			"my-project · Git — Shared Terminal",
		);
		expect(composeTabTitle({ project: "my-project", view: "terminal" })).toBe(
			"my-project — Shared Terminal",
		);
	});
	it("no project (login, nothing selected, blank name) ⇒ the app title alone", () => {
		expect(composeTabTitle({ project: null, view: "chat" })).toBe(APP_TITLE);
		expect(composeTabTitle({ project: "  ", view: null })).toBe(APP_TITLE);
	});
	it("an unknown view adds no label (never the raw value)", () => {
		expect(composeTabTitle({ project: "p", view: "constructor" })).toBe("p — Shared Terminal");
	});
});

describe("setTitlePage (P3a project / agent pages)", () => {
	it("wins while shown, then the session's title comes back; logout clears it", () => {
		setTitleParts({ project: "my-project", view: "chat" });
		setTitlePage("@developer-hz · Educación HZ");
		expect(document.title).toBe("@developer-hz · Educación HZ — Shared Terminal");
		setTitleParts({ view: "git" });
		expect(document.title).toBe("@developer-hz · Educación HZ — Shared Terminal");
		setTitlePage(null);
		expect(document.title).toBe("my-project · Git — Shared Terminal");
		setTitlePage("Educación HZ");
		resetTabTitle();
		expect(document.title).toBe(APP_TITLE);
		setTitleParts({ project: null });
		expect(document.title).toBe(APP_TITLE);
	});
});

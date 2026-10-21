import { describe, expect, it } from "vitest";
import {
	ancestorsOf,
	baseName,
	breadcrumbsFor,
	joinPath,
	parentPath,
	resolveRelativeLink,
} from "./workspacePaths.js";

describe("workspace path helpers", () => {
	it("joins, splits and walks ancestors", () => {
		expect(joinPath("", "a")).toBe("a");
		expect(joinPath("a/b", "c")).toBe("a/b/c");
		expect(parentPath("a/b/c")).toBe("a/b");
		expect(parentPath("a")).toBe("");
		expect(baseName("a/b/c.md")).toBe("c.md");
		expect(ancestorsOf("a/b/c")).toEqual(["", "a", "a/b"]);
		expect(ancestorsOf("a")).toEqual([""]);
		expect(ancestorsOf("")).toEqual([]);
	});

	it("builds breadcrumbs from the root", () => {
		expect(breadcrumbsFor("")).toEqual([{ label: "workspace", path: "" }]);
		expect(breadcrumbsFor("src/lib/x.ts")).toEqual([
			{ label: "workspace", path: "" },
			{ label: "src", path: "src" },
			{ label: "lib", path: "src/lib" },
			{ label: "x.ts", path: "src/lib/x.ts" },
		]);
	});

	it("resolves relative Markdown links against the containing file", () => {
		expect(resolveRelativeLink("docs/guide.md", "setup.md")).toBe("docs/setup.md");
		expect(resolveRelativeLink("docs/guide.md", "./img/a.png")).toBe("docs/img/a.png");
		expect(resolveRelativeLink("docs/guide.md", "../README.md#intro")).toBe("README.md");
		expect(resolveRelativeLink("docs/guide.md", "/CONTRIBUTING.md")).toBe("CONTRIBUTING.md");
		expect(resolveRelativeLink("README.md", "my%20notes.md?x=1")).toBe("my notes.md");
	});

	it("refuses links that climb above the workspace root", () => {
		expect(resolveRelativeLink("README.md", "../etc/passwd")).toBeNull();
		expect(resolveRelativeLink("docs/a.md", "../../x")).toBeNull();
	});
});

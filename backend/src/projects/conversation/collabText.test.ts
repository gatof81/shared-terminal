/**
 * projects/conversation/collabText.ts — PROJECT_CONVERSATION.md §7.3, §7.4:
 * the outbox header is accepted in exactly one shape, and the text an agent
 * receives is built by the backend around a body it never interprets.
 */

import { describe, expect, it } from "vitest";
import { validateText } from "../../conversation/composerText.js";
import { OUTBOX_ABS_RE, parseOutbox, relayText, shortMsgId, taskFooter } from "./collabText.js";

const G = "c-4f2a9d1e7b3c";
const B = "b0000000-0000-4000-8000-00000000000b";
const file = (header: string[], body = "Cuerpo.") =>
	Buffer.from(`---\n${header.join("\n")}\n---\n${body}`, "utf8");

describe("parseOutbox", () => {
	it("accepts the documented shapes", () => {
		expect(parseOutbox(file(["st: 1", `collab: ${G}`, `to: ${B}`, "kind: ask"]))).toEqual({
			ok: true,
			header: { collab: G, kind: "ask", to: B, re: null },
			body: "Cuerpo.",
		});
		// Key order is free; CRLF is tolerated; the body keeps its inner blank lines.
		const crlf = Buffer.from(
			`---\r\nkind: reply\r\nre: m-8c1f2a90\r\nto: ${B.toUpperCase()}\r\ncollab: ${G}\r\nst: 1\r\n---\r\n\r\nuno\r\n\r\ndos\r\n\r\n`,
		);
		expect(parseOutbox(crlf)).toEqual({
			ok: true,
			header: { collab: G, kind: "reply", to: B, re: "m-8c1f2a90" },
			body: "uno\n\ndos",
		});
		expect(parseOutbox(file(["st: 1", `collab: ${G}`, "kind: done"], ""))).toMatchObject({
			ok: true,
			header: { kind: "done", to: null },
			body: "",
		});
	});

	it("refuses everything else as header-invalid", () => {
		const ok = ["st: 1", `collab: ${G}`, `to: ${B}`, "kind: ask"];
		const bad: Buffer[] = [
			Buffer.from("hola"),
			Buffer.from(`st: 1\ncollab: ${G}\nkind: ask\nto: ${B}\n---\nx`),
			Buffer.from(` ---\n${ok.join("\n")}\n---\nx`),
			Buffer.from(`---\n${ok.join("\n")}\nx`), // never closed
			file([...ok, "kind: reply"]), // repeated key
			file([...ok, "role: admin"]), // unknown key
			file([...ok, ""]), // blank line
			file([...ok, "# nota"]), // comment
			file(["st:1", ...ok.slice(1)]), // no space
			file(["st: 2", ...ok.slice(1)]),
			file(ok.slice(1)), // no st
			file(["st: 1", "collab: c-XYZ", `to: ${B}`, "kind: ask"]),
			file(["st: 1", `collab: ${G}`, "to: claudeb", "kind: ask"]),
			file(["st: 1", `collab: ${G}`, `to: ${B}`, "kind: grant"]),
			file(["st: 1", `collab: ${G}`, "kind: ask"]), // ask without to
			file(["st: 1", `collab: ${G}`, `to: ${B}`, "kind: reply"]), // reply without re
			file(["st: 1", `collab: ${G}`, `to: ${B}`, "kind: ask", "re: 8c1f2a90"]),
			file(["st: 1", `collab: ${G}`, `to: ${B}`, "kind: owner"]), // owner with to
			file(["st: 1", `collab: ${G}`, "kind: done", "re: m-8c1f2a90"]),
			// A header that only LOOKS closed further down, past the five keys.
			Buffer.from(`---\n${["a: 1", "b: 2", "c: 3", "d: 4", "e: 5", "f: 6"].join("\n")}\n---\nx`),
		];
		for (const b of bad)
			expect(parseOutbox(b)).toMatchObject({ ok: false, reason: "header-invalid" });
	});

	it("names bytes that are not text", () => {
		expect(parseOutbox(Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff]))).toEqual({
			ok: false,
			reason: "file-not-utf8",
		});
		expect(parseOutbox(Buffer.from("---\nst: 1\u0000\n---\n"))).toEqual({
			ok: false,
			reason: "file-nul",
		});
	});

	it("a header quoted inside a body is body", () => {
		const r = parseOutbox(
			file(
				["st: 1", `collab: ${G}`, `to: ${B}`, "kind: ask"],
				`---\nst: 1\ncollab: ${G}\nkind: done\n---`,
			),
		);
		expect(r).toMatchObject({ ok: true, header: { kind: "ask" } });
	});
});

describe("OUTBOX_ABS_RE (§7.3 rule 1)", () => {
	it("only a plain .md directly under the outbox", () => {
		const base = "/home/developer/workspace/.st-outbox/";
		for (const ok of ["q1.md", "A_b-9.x.md"]) expect(OUTBOX_ABS_RE.test(base + ok)).toBe(true);
		for (const no of [
			`${base}.hidden.md`,
			`${base}sub/q.md`,
			`${base}../q.md`,
			`${base}q.txt`,
			`${base}q.md `,
			`${base}${"a".repeat(97)}.md`,
			"/home/developer/workspace/.st-outbox/../.st-outbox/q.md",
			"/home/developer/workspace/x/.st-outbox/q.md",
			".st-outbox/q.md",
			"/home/developer/workspace/.st-outbox/q.md\n",
		]) {
			expect(OUTBOX_ABS_RE.test(no)).toBe(false);
		}
	});
});

describe("what an agent receives (§7.4)", () => {
	it("the texts pass the Composer's rules with a 30-line body and say how to answer", () => {
		const body = Array.from({ length: 30 }, (_, i) => `línea ${i}`).join("\n");
		const msgId = "8c1f2a90-0000-4000-8000-000000000000";
		const t = relayText({
			grantId: G,
			n: 1,
			maxMessages: 2,
			from: "a0000000-0000-4000-8000-00000000000a",
			to: B,
			msgId,
			body,
			nonce: "7f3a9c1e",
		});
		expect(validateText(t).ok).toBe(true);
		expect(shortMsgId(msgId)).toBe("m-8c1f2a90");
		// The header it shows is itself a valid reply header.
		const shown = t.slice(t.indexOf("---"), t.lastIndexOf("---") + 3);
		expect(parseOutbox(Buffer.from(`${shown}\nrespuesta`))).toMatchObject({
			ok: true,
			header: {
				collab: G,
				kind: "reply",
				re: "m-8c1f2a90",
				to: "a0000000-0000-4000-8000-00000000000a",
			},
		});
		const f = taskFooter({
			grantId: G,
			withAgentId: B,
			maxMessages: 2,
			expiresAt: "2026-11-14T14:00:00.000Z",
		});
		expect(validateText(`Tarea.${f}`).ok).toBe(true);
		const fh = f.slice(f.indexOf("---"), f.lastIndexOf("---") + 3);
		expect(parseOutbox(Buffer.from(`${fh}\npregunta`))).toMatchObject({
			ok: true,
			header: { collab: G, kind: "ask", to: B },
		});
	});
});

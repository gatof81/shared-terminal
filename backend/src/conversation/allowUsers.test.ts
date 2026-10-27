import { describe, expect, it } from "vitest";
import { parseAllowUsers } from "./allowUsers.js";

const A = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const B = "11111111-2222-4333-8444-555555555555";

describe("parseAllowUsers (CONVERSATION_ALLOW_USERS, CONVERSATION.md §7)", () => {
	it("unset or empty ⇒ nobody", () => {
		expect(parseAllowUsers(undefined).size).toBe(0);
		expect(parseAllowUsers("").size).toBe(0);
		expect(parseAllowUsers(" , ,").size).toBe(0);
	});

	it("comma-separated user ids, trimmed and lowercased", () => {
		expect([...parseAllowUsers(` ${A} ,${B.toUpperCase()}`)]).toEqual([A, B]);
	});

	it("drops what is not a user id instead of failing the boot", () => {
		expect([...parseAllowUsers(`admin,${A},*,1`)]).toEqual([A]);
	});
});

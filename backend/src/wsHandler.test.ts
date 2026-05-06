import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import { __resetJwtSecretForTests, validateJwtSecret } from "./auth.js";
import { handleWsConnection } from "./wsHandler.js";
import type { SessionManager } from "./sessionManager.js";
import type { DockerManager } from "./dockerManager.js";

// ── Test harness ────────────────────────────────────────────────────────────

const TEST_SECRET = "test-secret-do-not-use-in-prod";

beforeAll(() => {
	process.env.JWT_SECRET = TEST_SECRET;
	__resetJwtSecretForTests();
	validateJwtSecret();
});

afterAll(() => {
	delete process.env.JWT_SECRET;
	__resetJwtSecretForTests();
});

interface FakeWs {
	readyState: number;
	on: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
	send: ReturnType<typeof vi.fn>;
}

function makeFakeWs(): FakeWs {
	return {
		readyState: 1, // WebSocket.OPEN — sendMsg() gates on this
		on: vi.fn(),
		close: vi.fn(),
		send: vi.fn(),
	};
}

function makeReq(url: string, withToken: boolean): {
	url: string;
	headers: Record<string, string | undefined>;
} {
	const headers: Record<string, string | undefined> = {};
	if (withToken) {
		const token = jwt.sign({ sub: "user-1" }, TEST_SECRET);
		headers["sec-websocket-protocol"] = `auth.bearer.${token}`;
	}
	return { url, headers };
}

// SessionManager / DockerManager aren't reached on any of the early-return
// paths these tests exercise, so a shallow stub is enough.
const fakeSessions = {} as SessionManager;
const fakeDocker = {} as DockerManager;

// ── Auth-first invariant ───────────────────────────────────────────────────
// These tests pin the security invariant from issue #82: an unauthenticated
// caller must always be told "Unauthorized" and never receive a more specific
// error reason that would let them probe path / tab id validity. A future
// refactor that reintroduces the strip → slice ordering of checks would
// silently restore the oracle without these tests.

describe("handleWsConnection auth-first ordering", () => {
	it("unauthenticated caller on a structurally valid path gets Unauthorized", () => {
		const ws = makeFakeWs();
		const req = makeReq("/ws/sessions/abc?tab=tab-1", false);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		handleWsConnection(ws as any, req as any, fakeSessions, fakeDocker);

		expect(ws.close).toHaveBeenCalledTimes(1);
		expect(ws.close).toHaveBeenCalledWith(1008, "Unauthorized");
		// No leak of the path/tab error message in the pre-close frame.
		const errPayloads = ws.send.mock.calls.map((c) => c[0] as string);
		expect(errPayloads).toContain(JSON.stringify({ type: "error", message: "Unauthorized" }));
		expect(errPayloads.some((p) => p.includes("Invalid"))).toBe(false);
		expect(errPayloads.some((p) => p.includes("Missing tab"))).toBe(false);
	});

	it("unauthenticated caller on an invalid path gets Unauthorized, not 'Invalid path'", () => {
		const ws = makeFakeWs();
		const req = makeReq("/totally-bogus-route", false);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		handleWsConnection(ws as any, req as any, fakeSessions, fakeDocker);

		expect(ws.close).toHaveBeenCalledWith(1008, "Unauthorized");
		const errPayloads = ws.send.mock.calls.map((c) => c[0] as string);
		expect(errPayloads.some((p) => p.includes("Invalid WebSocket path"))).toBe(false);
	});

	it("unauthenticated caller missing the tab param still gets Unauthorized", () => {
		const ws = makeFakeWs();
		const req = makeReq("/ws/sessions/abc", false);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		handleWsConnection(ws as any, req as any, fakeSessions, fakeDocker);

		expect(ws.close).toHaveBeenCalledWith(1008, "Unauthorized");
		const errPayloads = ws.send.mock.calls.map((c) => c[0] as string);
		expect(errPayloads.some((p) => p.includes("Missing tab"))).toBe(false);
	});

	it("unauthenticated caller with a malformed tab still gets Unauthorized", () => {
		const ws = makeFakeWs();
		const req = makeReq("/ws/sessions/abc?tab=evil%20tab", false);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		handleWsConnection(ws as any, req as any, fakeSessions, fakeDocker);

		expect(ws.close).toHaveBeenCalledWith(1008, "Unauthorized");
		const errPayloads = ws.send.mock.calls.map((c) => c[0] as string);
		expect(errPayloads.some((p) => p.includes("Invalid tab id"))).toBe(false);
	});

	it("authenticated caller still receives the specific path error", () => {
		const ws = makeFakeWs();
		const req = makeReq("/totally-bogus-route", true);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		handleWsConnection(ws as any, req as any, fakeSessions, fakeDocker);

		expect(ws.close).toHaveBeenCalledWith(1008, "Invalid path");
		const errPayloads = ws.send.mock.calls.map((c) => c[0] as string);
		expect(errPayloads).toContain(JSON.stringify({ type: "error", message: "Invalid WebSocket path" }));
	});

	it("authenticated caller missing the tab param receives 'Missing tab'", () => {
		const ws = makeFakeWs();
		const req = makeReq("/ws/sessions/abc", true);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		handleWsConnection(ws as any, req as any, fakeSessions, fakeDocker);

		expect(ws.close).toHaveBeenCalledWith(1008, "Missing tab");
		const errPayloads = ws.send.mock.calls.map((c) => c[0] as string);
		expect(errPayloads).toContain(JSON.stringify({ type: "error", message: "Missing tab id" }));
	});
});

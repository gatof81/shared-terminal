import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// P3a project directory (docs/PROJECTS.md): the feature mirror from
// /auth/status and the request wrapper the screens decide on.

type Api = typeof import("./api.js");

async function loadApi(): Promise<Api> {
	vi.resetModules();
	return import("./api.js");
}

function res(status: number, body: unknown): Response {
	return {
		status,
		ok: status >= 200 && status < 300,
		json: vi.fn(async () => body),
	} as unknown as Response;
}

const STATUS = {
	needsSetup: false,
	authenticated: true,
	isAdmin: false,
	isLead: false,
	uiShell: "v1",
};

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
	fetchSpy = vi.fn();
	globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("features.projectChat", () => {
	it("absent `features` ⇒ off (the flag-off answer has exactly the old keys)", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(res(200, STATUS));
		await api.checkAuthStatus();
		expect(api.projectChatEnabled()).toBe(false);
	});

	it("only `projectChat: true` turns it on", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(res(200, { ...STATUS, features: { projectChat: true } }));
		await api.checkAuthStatus();
		expect(api.projectChatEnabled()).toBe(true);
		fetchSpy.mockResolvedValueOnce(res(200, { ...STATUS, features: { projectChat: "yes" } }));
		await api.checkAuthStatus();
		expect(api.projectChatEnabled()).toBe(false);
		fetchSpy.mockResolvedValueOnce(res(200, { ...STATUS, features: null }));
		await api.checkAuthStatus();
		expect(api.projectChatEnabled()).toBe(false);
	});
});

describe("project requests", () => {
	it("decide on `error`, never `message`", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(
			res(409, { error: "session-taken", message: "handle-taken (a misleading message)" }),
		);
		const a = await api.createAgent("p1", { handle: "dev", role: null, sessionId: "s1" }, "id-1");
		expect(a).toEqual({ ok: false, status: 409, code: "session-taken" });
	});

	it("sends one clientRequestId, the role only when given", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(res(201, { agentId: "a1", replayed: false }));
		await api.createAgent("p 1", { handle: "dev", role: null, sessionId: "s1" }, "id-1");
		const [url, init] = fetchSpy.mock.calls[0]!;
		expect(String(url)).toMatch(/\/api\/projects\/p%201\/agents$/);
		expect(JSON.parse(init.body)).toEqual({
			handle: "dev",
			sessionId: "s1",
			clientRequestId: "id-1",
		});
	});

	it("no answer is `network`; a 2xx without its body is `bad-answer` — neither proves a write", async () => {
		const api = await loadApi();
		fetchSpy.mockRejectedValueOnce(new TypeError("Failed to fetch"));
		expect(await api.createProject("X", "id")).toEqual({ ok: false, status: 0, code: "network" });
		fetchSpy.mockResolvedValueOnce(res(201, { nope: true }));
		expect(await api.createProject("X", "id")).toEqual({
			ok: false,
			status: 201,
			code: "bad-answer",
		});
	});

	it("DELETE 204 is success", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(res(204, null));
		expect(await api.removeAgent("p", "a")).toEqual({ ok: true, status: 204, body: null });
	});

	it("an answer that lands after a logout is `stale` (another account's)", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(res(200, STATUS));
		await api.checkAuthStatus();
		let release: (r: Response) => void = () => {};
		fetchSpy.mockReturnValueOnce(new Promise<Response>((r) => (release = r)));
		const pending = api.fetchProjects();
		fetchSpy.mockResolvedValue(res(204, null));
		await api.logout();
		release(res(200, { projects: [{ projectId: "p" }], can: {} }));
		expect(await pending).toMatchObject({ ok: false, code: "stale" });
	});
});

describe("D2: features.projectArtifacts and the artifact reads", () => {
	const all = { projectChat: true, projectConversation: true, projectArtifacts: true };

	it("needs projectArtifacts AND the conversation on; anything else is off", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(res(200, { ...STATUS, features: all }));
		await api.checkAuthStatus();
		expect(api.projectArtifactsEnabled()).toBe(true);
		fetchSpy.mockResolvedValueOnce(
			res(200, { ...STATUS, features: { ...all, projectConversation: undefined } }),
		);
		await api.checkAuthStatus();
		expect(api.projectArtifactsEnabled()).toBe(false);
		fetchSpy.mockResolvedValueOnce(
			res(200, { ...STATUS, features: { ...all, projectArtifacts: "1" } }),
		);
		await api.checkAuthStatus();
		expect(api.projectArtifactsEnabled()).toBe(false);
	});

	const bytesRes = (status: number, text: string): Response =>
		({
			status,
			ok: status >= 200 && status < 300,
			arrayBuffer: async () => new TextEncoder().encode(text).buffer,
			json: async () => null,
		}) as unknown as Response;
	const sha256 = async (t: string) =>
		[...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))]
			.map((x) => x.toString(16).padStart(2, "0"))
			.join("");

	it("returns the text only when it hashes to the sha256 it was asked for", async () => {
		const api = await loadApi();
		const good = await sha256("hello\n");
		fetchSpy.mockResolvedValueOnce(bytesRes(200, "hello\n"));
		expect(await api.fetchProjectArtifactText("p", good)).toEqual({ ok: true, text: "hello\n" });
		expect(String(fetchSpy.mock.calls[0]![0])).toMatch(
			/\/projects\/p\/conversation\/artifacts\/[0-9a-f]{64}$/,
		);
		fetchSpy.mockResolvedValueOnce(bytesRes(200, "tampered\n"));
		expect(await api.fetchProjectArtifactText("p", good)).toEqual({
			ok: false,
			status: 200,
			code: "hash-mismatch",
		});
	});

	it("register: only a well-formed sha256 answer counts; an error carries its code", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(
			res(201, { sha256: "a".repeat(64), name: "f.diff", bytes: 3, replayed: false }),
		);
		const ok = await api.registerProjectArtifact("p", { agentId: "a1", path: "out/f.diff" });
		expect(ok.ok).toBe(true);
		const init = fetchSpy.mock.calls[0]![1] as RequestInit;
		expect(init.method).toBe("POST");
		expect(JSON.parse(String(init.body))).toEqual({ agentId: "a1", path: "out/f.diff" });
		fetchSpy.mockResolvedValueOnce(res(201, { sha256: "XYZ", name: "f", bytes: 3 }));
		expect(await api.registerProjectArtifact("p", { agentId: "a1", path: "f" })).toMatchObject({
			ok: false,
			code: "bad-answer",
		});
		fetchSpy.mockResolvedValueOnce(res(413, { error: "artifact-too-large" }));
		expect(await api.registerProjectArtifact("p", { agentId: "a1", path: "f" })).toEqual({
			ok: false,
			status: 413,
			code: "artifact-too-large",
		});
	});

	it("a body that fails mid-read is answered as a network error, never thrown", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce({
			status: 200,
			ok: true,
			arrayBuffer: async () => {
				throw new TypeError("network error");
			},
			json: async () => null,
		} as unknown as Response);
		expect(await api.fetchProjectArtifactText("p", "a".repeat(64))).toEqual({
			ok: false,
			status: 200,
			code: "network",
		});
	});
});

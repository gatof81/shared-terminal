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
		fetchSpy.mockResolvedValueOnce(res(409, { error: "project-limit", message: "misleading" }));
		expect(await api.createProject("X", "id-1")).toEqual({
			ok: false,
			status: 409,
			code: "project-limit",
		});
	});

	it("create sends the name and one clientRequestId", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(res(201, { projectId: "p1", replayed: false }));
		await api.createProject("Web", "id-1");
		const [url, init] = fetchSpy.mock.calls[0]!;
		expect(String(url)).toMatch(/\/api\/projects$/);
		expect(JSON.parse(init.body)).toEqual({ name: "Web", clientRequestId: "id-1" });
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

	it("rename is one PATCH {name}: the summary on 200; 400 / 404 / no answer are errors", async () => {
		const api = await loadApi();
		const summary = {
			projectId: "p 1",
			name: "Nuevo",
			createdAt: "2026-11-19T00:00:00Z",
			agentCount: 2,
		};
		fetchSpy.mockResolvedValueOnce(res(200, summary));
		expect(await api.renameProject("p 1", "Nuevo")).toEqual({
			ok: true,
			status: 200,
			body: summary,
		});
		const [url, init] = fetchSpy.mock.calls[0]!;
		expect(String(url)).toMatch(/\/api\/projects\/p%201$/);
		expect(init.method).toBe("PATCH");
		expect(JSON.parse(init.body)).toEqual({ name: "Nuevo" });
		fetchSpy.mockResolvedValueOnce(res(400, { error: "invalid-name" }));
		expect(await api.renameProject("p 1", "")).toEqual({
			ok: false,
			status: 400,
			code: "invalid-name",
		});
		fetchSpy.mockResolvedValueOnce(res(404, { error: "project-not-found" }));
		expect(await api.renameProject("p 1", "X")).toEqual({
			ok: false,
			status: 404,
			code: "project-not-found",
		});
		fetchSpy.mockRejectedValueOnce(new TypeError("Failed to fetch"));
		expect(await api.renameProject("p 1", "X")).toEqual({ ok: false, status: 0, code: "network" });
	});

	it("archive is one DELETE; 204 is success", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(res(204, null));
		expect(await api.archiveProject("p 1")).toEqual({ ok: true, status: 204, body: null });
		expect(String(fetchSpy.mock.calls[0]![0])).toMatch(/\/api\/projects\/p%201$/);
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

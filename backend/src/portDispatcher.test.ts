import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
	createPortDispatcher,
	extractAuthToken,
	makeHostParser,
	type ParsedHost,
	validatePortProxyBaseDomain,
} from "./portDispatcher.js";

// ── Host header parsing ──────────────────────────────────────────────────

describe("makeHostParser", () => {
	const parse = makeHostParser("tunnel.example.com");
	const SID = "12345678-1234-4123-8123-123456789abc";

	it("parses a valid host into { containerPort, sessionId }", () => {
		expect(parse(`p3000-${SID}.tunnel.example.com`)).toEqual({
			containerPort: 3000,
			sessionId: SID,
		});
	});

	it("strips a trailing :port suffix on the Host header", () => {
		// Behind a tunnel terminating TLS the browser may still emit
		// host:443. Trimming keeps the parse symmetric with what the
		// container app would log.
		expect(parse(`p3000-${SID}.tunnel.example.com:443`)).toEqual({
			containerPort: 3000,
			sessionId: SID,
		});
	});

	it("is case-insensitive on host", () => {
		expect(parse(`p3000-${SID.toUpperCase()}.TUNNEL.EXAMPLE.COM`)).toEqual({
			containerPort: 3000,
			sessionId: SID, // normalized to lowercase
		});
	});

	it("returns null when the prefix is wrong", () => {
		expect(parse(`x3000-${SID}.tunnel.example.com`)).toBeNull();
		expect(parse(`p-${SID}.tunnel.example.com`)).toBeNull();
		expect(parse(`p3000_${SID}.tunnel.example.com`)).toBeNull();
	});

	it("returns null for a non-UUID session id", () => {
		expect(parse("p3000-not-a-uuid.tunnel.example.com")).toBeNull();
		expect(parse("p3000-12345678-1234.tunnel.example.com")).toBeNull();
	});

	it("returns null for an unrelated host (api domain, health probe, etc.)", () => {
		expect(parse("api.example.com")).toBeNull();
		expect(parse("tunnel.example.com")).toBeNull();
		expect(parse(undefined)).toBeNull();
	});

	it("rejects out-of-range ports past TCP max even with valid prefix shape", () => {
		// `\d{1,5}` accepts 99999. Defence-in-depth — the lookup would
		// 404 anyway, but failing earlier saves a D1 round-trip on a
		// probe.
		expect(parse(`p99999-${SID}.tunnel.example.com`)).toBeNull();
		expect(parse(`p0-${SID}.tunnel.example.com`)).toBeNull();
	});

	it("treats the base domain as a literal — no regex meta interpretation", () => {
		// If the operator pasted in `tunnel.example.com`, the dot
		// must NOT match arbitrary chars in subdomain position. A
		// host like `p3000-<sid>.tunnelXexampleXcom` (which would
		// match an unescaped pattern) must NOT be accepted.
		expect(parse(`p3000-${SID}.tunnelXexampleXcom`)).toBeNull();
	});
});

// ── Cookie extraction ────────────────────────────────────────────────────

describe("extractAuthToken", () => {
	it("returns null when no cookie header is present", () => {
		expect(extractAuthToken(undefined)).toBeNull();
		expect(extractAuthToken("")).toBeNull();
	});

	it("extracts st_token from a single-cookie header", () => {
		expect(extractAuthToken("st_token=abc.def.ghi")).toBe("abc.def.ghi");
	});

	it("extracts st_token when other cookies are present", () => {
		expect(extractAuthToken("foo=bar; st_token=jwt-here; baz=qux")).toBe("jwt-here");
		expect(extractAuthToken("st_token=jwt-here; csrf=other")).toBe("jwt-here");
	});

	it("returns null when st_token is absent", () => {
		expect(extractAuthToken("foo=bar; baz=qux")).toBeNull();
		// Substring "st_token" inside a different cookie name must not
		// match — the regex anchors to ^|; (start of header or
		// post-semicolon) to prevent that.
		expect(extractAuthToken("not_st_token=junk")).toBeNull();
	});

	it("decodes percent-encoded values", () => {
		expect(extractAuthToken("st_token=ab%2Bc%3Dd")).toBe("ab+c=d");
	});

	// PR #223 round 1 SHOULD-FIX. A malformed percent sequence
	// (`%ZZ`, lone `%`, `%G1`) would throw URIError out of
	// decodeURIComponent and propagate to the dispatcher's `.catch`
	// path — emitting a 502 with a confusing "dispatch failed" log
	// when the right answer is "fall back to raw value, let the JWT
	// verifier reject it as 401". Mirrors `extractTokenFromCookieHeader`
	// in auth.ts.
	it("falls back to the raw value when percent-decode throws", () => {
		expect(extractAuthToken("st_token=%ZZ")).toBe("%ZZ");
		expect(extractAuthToken("st_token=ab%")).toBe("ab%");
		expect(extractAuthToken("st_token=%G1")).toBe("%G1");
	});
});

// ── PORT_PROXY_BASE_DOMAIN validation ────────────────────────────────────

describe("validatePortProxyBaseDomain", () => {
	it("returns null for unset / empty / whitespace", () => {
		expect(validatePortProxyBaseDomain(undefined)).toBeNull();
		expect(validatePortProxyBaseDomain("")).toBeNull();
		expect(validatePortProxyBaseDomain("   ")).toBeNull();
	});

	it("accepts a normal multi-label domain (lowercased)", () => {
		expect(validatePortProxyBaseDomain("tunnel.example.com")).toBe("tunnel.example.com");
		expect(validatePortProxyBaseDomain("Tunnel.Example.Com")).toBe("tunnel.example.com");
		expect(validatePortProxyBaseDomain("  example.com  ")).toBe("example.com");
	});

	it("returns null + warns on bare TLDs / leading-dot / consecutive-dots", () => {
		expect(validatePortProxyBaseDomain("localhost")).toBeNull();
		expect(validatePortProxyBaseDomain(".example.com")).toBeNull();
		expect(validatePortProxyBaseDomain("a..b.com")).toBeNull();
	});

	it("returns null + warns on charset violations", () => {
		// Underscores, slashes, spaces — any of which would break the
		// dispatcher's host regex if they slipped through. RFC-perfect
		// validation isn't the goal; tripping a typo is.
		expect(validatePortProxyBaseDomain("tun_nel.example.com")).toBeNull();
		expect(validatePortProxyBaseDomain("tunnel.example.com/path")).toBeNull();
		expect(validatePortProxyBaseDomain("tunnel example.com")).toBeNull();
	});
});

// ── Dispatcher: HTTP middleware ──────────────────────────────────────────

const SID = "12345678-1234-4123-8123-123456789abc";

interface MockRes {
	statusCode: number;
	headers: Record<string, string>;
	body: string;
	headersSent: boolean;
	setHeader: (k: string, v: string) => void;
	end: (b?: string) => void;
}

function makeRes(): MockRes {
	const res: MockRes = {
		statusCode: 200,
		headers: {},
		body: "",
		headersSent: false,
		setHeader(k, v) {
			res.headers[k.toLowerCase()] = v;
		},
		end(b) {
			res.headersSent = true;
			res.body = b ?? "";
		},
	};
	return res;
}

function makeReq(host: string | undefined, cookie?: string): IncomingMessage {
	return {
		headers: {
			...(host !== undefined ? { host } : {}),
			...(cookie ? { cookie } : {}),
		},
		method: "GET",
		url: "/",
	} as unknown as IncomingMessage;
}

describe("createPortDispatcher (HTTP middleware)", () => {
	it("falls through (calls next) when baseDomain is null", () => {
		const { middleware } = createPortDispatcher({ baseDomain: null });
		const next = vi.fn();
		middleware(makeReq("api.example.com"), makeRes() as unknown as ServerResponse, next);
		expect(next).toHaveBeenCalledTimes(1);
	});

	it("falls through when host doesn't match the dispatcher pattern", () => {
		const { middleware } = createPortDispatcher({ baseDomain: "tunnel.example.com" });
		const next = vi.fn();
		middleware(makeReq("api.example.com"), makeRes() as unknown as ServerResponse, next);
		expect(next).toHaveBeenCalledTimes(1);
	});

	function makeDispatcherWith(opts: {
		target: { hostPort: number; isPublic: boolean; ownerUserId: string } | null;
		token?: string | null;
	}): {
		middleware: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
		webSpy: ReturnType<typeof vi.fn>;
	} {
		const webSpy = vi.fn();
		const fakeProxy = {
			web: webSpy,
			ws: vi.fn(),
			on: vi.fn(),
		} as unknown as Parameters<typeof createPortDispatcher>[0]["proxy"];
		const dispatcher = createPortDispatcher({
			baseDomain: "tunnel.example.com",
			lookupTarget: vi.fn(async () => opts.target),
			verifyToken: vi.fn(() =>
				opts.token === undefined || opts.token === null ? null : { sub: opts.token },
			),
			proxy: fakeProxy,
		});
		return { middleware: dispatcher.middleware, webSpy: webSpy as ReturnType<typeof vi.fn> };
	}

	it("404s when lookup returns null (session not found / not running)", async () => {
		const { middleware, webSpy } = makeDispatcherWith({ target: null });
		const res = makeRes();
		const next = vi.fn();
		middleware(makeReq(`p3000-${SID}.tunnel.example.com`), res as unknown as ServerResponse, next);
		// Authorize is async; flush microtasks.
		await new Promise((r) => setImmediate(r));
		expect(res.statusCode).toBe(404);
		expect(res.body).toBe("Not Found");
		expect(next).not.toHaveBeenCalled();
		expect(webSpy).not.toHaveBeenCalled();
	});

	it("proxies a public port without checking the cookie", async () => {
		const { middleware, webSpy } = makeDispatcherWith({
			target: { hostPort: 32768, isPublic: true, ownerUserId: "u1" },
			// Note: no token set — the verify function would return
			// null, but it must NOT be consulted on public ports.
		});
		const res = makeRes();
		middleware(
			// No Cookie header at all — confirms public proxy doesn't
			// require one.
			makeReq(`p3000-${SID}.tunnel.example.com`),
			res as unknown as ServerResponse,
			() => {},
		);
		await new Promise((r) => setImmediate(r));
		expect(webSpy).toHaveBeenCalledTimes(1);
		expect(webSpy.mock.calls[0]?.[2]).toEqual({ target: "http://127.0.0.1:32768" });
	});

	it("401s a private port with no cookie", async () => {
		const { middleware, webSpy } = makeDispatcherWith({
			target: { hostPort: 32768, isPublic: false, ownerUserId: "u1" },
			token: null,
		});
		const res = makeRes();
		middleware(
			makeReq(`p3000-${SID}.tunnel.example.com`),
			res as unknown as ServerResponse,
			() => {},
		);
		await new Promise((r) => setImmediate(r));
		expect(res.statusCode).toBe(401);
		expect(res.body).toBe("Unauthorized");
		expect(webSpy).not.toHaveBeenCalled();
	});

	it("403s a private port owned by a different user", async () => {
		const { middleware, webSpy } = makeDispatcherWith({
			target: { hostPort: 32768, isPublic: false, ownerUserId: "u-owner" },
			token: "u-attacker",
		});
		const res = makeRes();
		middleware(
			makeReq(`p3000-${SID}.tunnel.example.com`, "st_token=jwt"),
			res as unknown as ServerResponse,
			() => {},
		);
		await new Promise((r) => setImmediate(r));
		expect(res.statusCode).toBe(403);
		expect(res.body).toBe("Forbidden");
		expect(webSpy).not.toHaveBeenCalled();
	});

	it("proxies a private port owned by the cookie's user", async () => {
		const { middleware, webSpy } = makeDispatcherWith({
			target: { hostPort: 32768, isPublic: false, ownerUserId: "u-owner" },
			token: "u-owner",
		});
		const res = makeRes();
		middleware(
			makeReq(`p3000-${SID}.tunnel.example.com`, "st_token=jwt"),
			res as unknown as ServerResponse,
			() => {},
		);
		await new Promise((r) => setImmediate(r));
		expect(webSpy).toHaveBeenCalledTimes(1);
		expect(webSpy.mock.calls[0]?.[2]).toEqual({ target: "http://127.0.0.1:32768" });
		expect(res.statusCode).toBe(200);
	});

	it("502s on an unexpected error in lookup or verify", async () => {
		const dispatcher = createPortDispatcher({
			baseDomain: "tunnel.example.com",
			lookupTarget: vi.fn(async () => {
				throw new Error("D1 unreachable");
			}),
			verifyToken: vi.fn(() => null),
			proxy: { web: vi.fn(), ws: vi.fn(), on: vi.fn() } as unknown as Parameters<
				typeof createPortDispatcher
			>[0]["proxy"],
		});
		const res = makeRes();
		dispatcher.middleware(
			makeReq(`p3000-${SID}.tunnel.example.com`),
			res as unknown as ServerResponse,
			() => {},
		);
		await new Promise((r) => setImmediate(r));
		expect(res.statusCode).toBe(502);
	});
});

// ── Dispatcher: WS upgrade ───────────────────────────────────────────────

describe("createPortDispatcher (WS upgrade)", () => {
	function makeSocket(): { socket: Duplex; written: string[]; destroyed: boolean } {
		const written: string[] = [];
		let destroyed = false;
		const socket = {
			write(s: string) {
				written.push(s);
			},
			destroy() {
				destroyed = true;
			},
		} as unknown as Duplex;
		return {
			socket,
			written,
			get destroyed() {
				return destroyed;
			},
		};
	}

	function makeDispatcherWith(
		target: ParsedHost extends never
			? never
			: {
					hostPort: number;
					isPublic: boolean;
					ownerUserId: string;
				} | null,
		token?: string | null,
	): {
		handleUpgrade: ReturnType<typeof createPortDispatcher>["handleUpgrade"];
		wsSpy: ReturnType<typeof vi.fn>;
	} {
		const wsSpy = vi.fn();
		const dispatcher = createPortDispatcher({
			baseDomain: "tunnel.example.com",
			lookupTarget: vi.fn(async () => target),
			verifyToken: vi.fn(() => (token === undefined || token === null ? null : { sub: token })),
			proxy: { web: vi.fn(), ws: wsSpy, on: vi.fn() } as unknown as Parameters<
				typeof createPortDispatcher
			>[0]["proxy"],
		});
		return { handleUpgrade: dispatcher.handleUpgrade, wsSpy };
	}

	it("returns false (let existing /ws/* handler take over) when host doesn't match", () => {
		const { handleUpgrade } = makeDispatcherWith({
			hostPort: 32768,
			isPublic: true,
			ownerUserId: "u1",
		});
		const { socket } = makeSocket();
		expect(handleUpgrade(makeReq("api.example.com"), socket, Buffer.alloc(0))).toBe(false);
	});

	it("claims the upgrade (returns true) when host matches", () => {
		const { handleUpgrade } = makeDispatcherWith({
			hostPort: 32768,
			isPublic: true,
			ownerUserId: "u1",
		});
		const { socket } = makeSocket();
		expect(handleUpgrade(makeReq(`p3000-${SID}.tunnel.example.com`), socket, Buffer.alloc(0))).toBe(
			true,
		);
	});

	it("destroys the socket with 401 when private port has no cookie", async () => {
		const { handleUpgrade, wsSpy } = makeDispatcherWith(
			{ hostPort: 32768, isPublic: false, ownerUserId: "u1" },
			null,
		);
		const { socket, written } = makeSocket();
		handleUpgrade(makeReq(`p3000-${SID}.tunnel.example.com`), socket, Buffer.alloc(0));
		await new Promise((r) => setImmediate(r));
		expect(written.some((line) => line.includes("401"))).toBe(true);
		expect(wsSpy).not.toHaveBeenCalled();
	});

	it("forwards a private-port upgrade when the cookie's user owns the session", async () => {
		const { handleUpgrade, wsSpy } = makeDispatcherWith(
			{ hostPort: 32768, isPublic: false, ownerUserId: "u-owner" },
			"u-owner",
		);
		const { socket } = makeSocket();
		handleUpgrade(
			makeReq(`p3000-${SID}.tunnel.example.com`, "st_token=jwt"),
			socket,
			Buffer.alloc(0),
		);
		await new Promise((r) => setImmediate(r));
		expect(wsSpy).toHaveBeenCalledTimes(1);
		expect(wsSpy.mock.calls[0]?.[3]).toEqual({ target: "http://127.0.0.1:32768" });
	});

	it("404s a missing target on WS too", async () => {
		const { handleUpgrade, wsSpy } = makeDispatcherWith(null);
		const { socket, written } = makeSocket();
		handleUpgrade(makeReq(`p3000-${SID}.tunnel.example.com`), socket, Buffer.alloc(0));
		await new Promise((r) => setImmediate(r));
		expect(written.some((line) => line.includes("404"))).toBe(true);
		expect(wsSpy).not.toHaveBeenCalled();
	});
});

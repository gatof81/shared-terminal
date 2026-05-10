import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetDispatcherStatsForTests,
	createPortDispatcher,
	extractAuthToken,
	getDispatcherStats,
	handleProxyError,
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

	// PR #223 round 3 NIT: RFC 1123 §2.1 says hostname labels must
	// start AND end with alphanumeric — hyphens only in interior
	// positions. The earlier `[a-z0-9-]+` accepted leading/trailing
	// hyphens which a Tunnel ingress would silently fail to match,
	// surfacing as "dispatcher never fires" instead of a startup
	// warning.
	it("rejects labels starting or ending with a hyphen (RFC 1123)", () => {
		expect(validatePortProxyBaseDomain("-tunnel.example.com")).toBeNull();
		expect(validatePortProxyBaseDomain("tunnel-.example.com")).toBeNull();
		expect(validatePortProxyBaseDomain("tunnel.example-.com")).toBeNull();
		// Single-char interior labels are still valid.
		expect(validatePortProxyBaseDomain("a.b.c")).toBe("a.b.c");
		// Interior hyphens stay legal.
		expect(validatePortProxyBaseDomain("my-tunnel.example.com")).toBe("my-tunnel.example.com");
	});
});

// ── Dispatcher: HTTP middleware ──────────────────────────────────────────

const SID = "12345678-1234-4123-8123-123456789abc";

interface MockRes {
	statusCode: number;
	headers: Record<string, string>;
	body: string;
	headersSent: boolean;
	closeListeners: Array<() => void>;
	setHeader: (k: string, v: string) => void;
	end: (b?: string) => void;
	on: (event: string, listener: () => void) => MockRes;
	/** Test helper: invoke every `close` listener so the dispatcher
	 *  counter (`#241c) sees its hookpoint fire. Production-like
	 *  surface — `res.on("close")` is the standard ServerResponse
	 *  shape. */
	__fireClose: () => void;
}

function makeRes(): MockRes {
	const res: MockRes = {
		statusCode: 200,
		headers: {},
		body: "",
		headersSent: false,
		closeListeners: [],
		setHeader(k, v) {
			res.headers[k.toLowerCase()] = v;
		},
		end(b) {
			res.headersSent = true;
			res.body = b ?? "";
		},
		on(event, listener) {
			if (event === "close") res.closeListeners.push(listener);
			return res;
		},
		__fireClose() {
			for (const l of res.closeListeners) l();
		},
	};
	return res;
}

function makeReq(host: string | undefined, cookie?: string, origin?: string): IncomingMessage {
	return {
		headers: {
			...(host !== undefined ? { host } : {}),
			...(cookie ? { cookie } : {}),
			...(origin ? { origin } : {}),
		},
		method: "GET",
		url: "/",
	} as unknown as IncomingMessage;
}

describe("createPortDispatcher (HTTP middleware)", () => {
	it("falls through (calls next) when baseDomain is null", () => {
		const { middleware } = createPortDispatcher({ baseDomain: null, corsOrigins: [] });
		const next = vi.fn();
		middleware(makeReq("api.example.com"), makeRes() as unknown as ServerResponse, next);
		expect(next).toHaveBeenCalledTimes(1);
	});

	it("falls through when host doesn't match the dispatcher pattern", () => {
		const { middleware } = createPortDispatcher({
			baseDomain: "tunnel.example.com",
			corsOrigins: [],
		});
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
			corsOrigins: ["https://app.example.com"],
			lookupTarget: vi.fn(async () => opts.target),
			verifyToken: vi.fn(() =>
				opts.token === undefined || opts.token === null
					? null
					: { sub: opts.token, username: "test-user" },
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
		expect(webSpy.mock.calls[0]?.[2]).toEqual({
			target: "http://127.0.0.1:32768",
			// `changeOrigin: true` rewrites the outbound Host header
			// so Vite-style host-checked container apps don't reject
			// the request. PR #223 round 9 NIT.
			changeOrigin: true,
		});
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
		expect(webSpy.mock.calls[0]?.[2]).toEqual({
			target: "http://127.0.0.1:32768",
			// `changeOrigin: true` rewrites the outbound Host header
			// so Vite-style host-checked container apps don't reject
			// the request. PR #223 round 9 NIT.
			changeOrigin: true,
		});
		expect(res.statusCode).toBe(200);
	});

	// PR #223 round 10 SHOULD-FIX. Symmetric with the WS path's
	// CSWSH defence: an HTTP request from a browser at an
	// unallowlisted origin must be rejected BEFORE `authorize()`
	// runs (so a valid cookie can't unlock a cross-site request to
	// a private port's container app).
	it("403s a private-port HTTP request from a non-allowlisted browser origin", async () => {
		const lookup = vi.fn(async () => ({
			hostPort: 32768,
			isPublic: false,
			ownerUserId: "u-owner",
		}));
		const verify = vi.fn(() => ({ sub: "u-owner", username: "owner" }));
		const webSpy = vi.fn();
		const dispatcher = createPortDispatcher({
			baseDomain: "tunnel.example.com",
			corsOrigins: ["https://app.example.com"],
			lookupTarget: lookup,
			verifyToken: verify,
			proxy: { web: webSpy, ws: vi.fn(), on: vi.fn() } as unknown as Parameters<
				typeof createPortDispatcher
			>[0]["proxy"],
		});
		const res = makeRes();
		dispatcher.middleware(
			makeReq(`p3000-${SID}.tunnel.example.com`, "st_token=jwt", "https://evil.com"),
			res as unknown as ServerResponse,
			() => {},
		);
		await new Promise((r) => setImmediate(r));
		expect(res.statusCode).toBe(403);
		expect(res.body).toBe("Forbidden");
		// Critical: the gate runs BEFORE lookup/verify, so even a
		// cookie that would auth on a same-origin request never
		// reaches the authorize() codepath.
		expect(lookup).not.toHaveBeenCalled();
		expect(verify).not.toHaveBeenCalled();
		expect(webSpy).not.toHaveBeenCalled();
	});

	it("allows a same-origin HTTP request from an allowlisted browser", async () => {
		const { middleware, webSpy } = makeDispatcherWith({
			target: { hostPort: 32768, isPublic: false, ownerUserId: "u-owner" },
			token: "u-owner",
		});
		const res = makeRes();
		middleware(
			makeReq(`p3000-${SID}.tunnel.example.com`, "st_token=jwt", "https://app.example.com"),
			res as unknown as ServerResponse,
			() => {},
		);
		await new Promise((r) => setImmediate(r));
		expect(webSpy).toHaveBeenCalledTimes(1);
	});

	it("allows a missing-Origin HTTP request (server-to-server / curl shape)", async () => {
		// Same `isAllowedWsOrigin` policy the WS path uses — Branch 1
		// (no Origin) lets non-browser callers (webhooks, CLI tools)
		// through. Without this, `public: true` ports would lose the
		// "anyone with the URL" semantics the issue spec calls out.
		const { middleware, webSpy } = makeDispatcherWith({
			target: { hostPort: 32768, isPublic: true, ownerUserId: "u1" },
		});
		const res = makeRes();
		middleware(
			// No origin arg → no Origin header on the request.
			makeReq(`p3000-${SID}.tunnel.example.com`),
			res as unknown as ServerResponse,
			() => {},
		);
		await new Promise((r) => setImmediate(r));
		expect(webSpy).toHaveBeenCalledTimes(1);
	});

	it("502s on an unexpected error in lookup or verify", async () => {
		const dispatcher = createPortDispatcher({
			baseDomain: "tunnel.example.com",
			corsOrigins: [],
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
		// `endUpgradeSocketWithReply` calls `.end(reply)` then later
		// `.destroy()`; the original direct path used `.write()`.
		// Capture both forms into `written` so tests that assert "the
		// dispatcher emitted a status line" don't have to care which
		// helper produced it.
		const socket = {
			write(s: string) {
				written.push(s);
			},
			end(s?: string) {
				if (typeof s === "string") written.push(s);
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
		opts?: { corsOrigins?: readonly string[]; nodeEnv?: string },
	): {
		handleUpgrade: ReturnType<typeof createPortDispatcher>["handleUpgrade"];
		wsSpy: ReturnType<typeof vi.fn>;
	} {
		const wsSpy = vi.fn();
		const dispatcher = createPortDispatcher({
			baseDomain: "tunnel.example.com",
			corsOrigins: opts?.corsOrigins ?? ["https://app.example.com"],
			nodeEnv: opts?.nodeEnv,
			lookupTarget: vi.fn(async () => target),
			verifyToken: vi.fn(() =>
				token === undefined || token === null ? null : { sub: token, username: "test-user" },
			),
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
		expect(wsSpy.mock.calls[0]?.[3]).toEqual({
			target: "http://127.0.0.1:32768",
			changeOrigin: true,
		});
	});

	it("404s a missing target on WS too", async () => {
		const { handleUpgrade, wsSpy } = makeDispatcherWith(null);
		const { socket, written } = makeSocket();
		handleUpgrade(makeReq(`p3000-${SID}.tunnel.example.com`), socket, Buffer.alloc(0));
		await new Promise((r) => setImmediate(r));
		expect(written.some((line) => line.includes("404"))).toBe(true);
		expect(wsSpy).not.toHaveBeenCalled();
	});

	// PR #223 round 2 SHOULD-FIX. CSWSH defence on the WS upgrade
	// path. SameSite=None cookies travel cross-site on WS upgrades
	// in production; without an origin allowlist a page at
	// `evil.com` could open a WebSocket to the dispatcher, the
	// browser would attach the victim's cookie, and the proxy
	// would bridge an authenticated channel into the victim's
	// container. These tests pin the gate firmly BEFORE authorize()
	// runs (no cookie validation, no D1 round-trip on a rejected
	// origin).
	it("rejects a cross-origin browser WS even when the cookie would auth", async () => {
		const lookup = vi.fn(async () => ({
			hostPort: 32768,
			isPublic: false,
			ownerUserId: "u-owner",
		}));
		const verify = vi.fn(() => ({ sub: "u-owner", username: "owner" }));
		const wsSpy = vi.fn();
		const dispatcher = createPortDispatcher({
			baseDomain: "tunnel.example.com",
			corsOrigins: ["https://app.example.com"],
			lookupTarget: lookup,
			verifyToken: verify,
			proxy: { web: vi.fn(), ws: wsSpy, on: vi.fn() } as unknown as Parameters<
				typeof createPortDispatcher
			>[0]["proxy"],
		});
		const { socket, written } = makeSocket();
		dispatcher.handleUpgrade(
			makeReq(`p3000-${SID}.tunnel.example.com`, "st_token=jwt", "https://evil.com"),
			socket,
			Buffer.alloc(0),
		);
		await new Promise((r) => setImmediate(r));
		expect(written.some((line) => line.includes("403"))).toBe(true);
		expect(wsSpy).not.toHaveBeenCalled();
		// Critical: the gate runs BEFORE lookup/verify, so even a
		// malicious origin with a valid cookie never reaches the
		// authorize() codepath.
		expect(lookup).not.toHaveBeenCalled();
		expect(verify).not.toHaveBeenCalled();
	});

	it("allows a same-origin browser WS that's in the allowlist", async () => {
		const { handleUpgrade, wsSpy } = makeDispatcherWith(
			{ hostPort: 32768, isPublic: false, ownerUserId: "u-owner" },
			"u-owner",
			{ corsOrigins: ["https://app.example.com"] },
		);
		const { socket } = makeSocket();
		handleUpgrade(
			makeReq(`p3000-${SID}.tunnel.example.com`, "st_token=jwt", "https://app.example.com"),
			socket,
			Buffer.alloc(0),
		);
		await new Promise((r) => setImmediate(r));
		expect(wsSpy).toHaveBeenCalledTimes(1);
	});

	// Webhook / OAuth callback shape: no Origin header. The issue
	// calls these out as the legitimate `public: true` use case;
	// `isAllowedWsOrigin` returns true on missing Origin (Branch 1)
	// so a server-side caller without a browser still works.
	it("allows a missing-Origin upgrade (webhook / OAuth callback shape)", async () => {
		const { handleUpgrade, wsSpy } = makeDispatcherWith(
			{ hostPort: 32768, isPublic: true, ownerUserId: "u1" },
			null,
			{ corsOrigins: ["https://app.example.com"] },
		);
		const { socket } = makeSocket();
		handleUpgrade(
			// No origin arg → no Origin header on the request.
			makeReq(`p3000-${SID}.tunnel.example.com`),
			socket,
			Buffer.alloc(0),
		);
		await new Promise((r) => setImmediate(r));
		expect(wsSpy).toHaveBeenCalledTimes(1);
	});

	// PR #223 round 3 NIT: pin the WS-side branches the HTTP tests
	// already cover so a future refactor that splits the auth flow
	// between the two paths can't silently diverge.

	it("403s a private-port WS upgrade owned by a different user", async () => {
		const { handleUpgrade, wsSpy } = makeDispatcherWith(
			{ hostPort: 32768, isPublic: false, ownerUserId: "u-owner" },
			"u-attacker",
		);
		const { socket, written } = makeSocket();
		handleUpgrade(
			makeReq(`p3000-${SID}.tunnel.example.com`, "st_token=jwt"),
			socket,
			Buffer.alloc(0),
		);
		await new Promise((r) => setImmediate(r));
		expect(written.some((line) => line.includes("403"))).toBe(true);
		expect(wsSpy).not.toHaveBeenCalled();
	});

	it("502s a WS upgrade when authorize() throws (D1 unreachable)", async () => {
		const wsSpy = vi.fn();
		const dispatcher = createPortDispatcher({
			baseDomain: "tunnel.example.com",
			corsOrigins: ["https://app.example.com"],
			lookupTarget: vi.fn(async () => {
				throw new Error("D1 unreachable");
			}),
			verifyToken: vi.fn(() => null),
			proxy: { web: vi.fn(), ws: wsSpy, on: vi.fn() } as unknown as Parameters<
				typeof createPortDispatcher
			>[0]["proxy"],
		});
		const { socket, written } = makeSocket();
		dispatcher.handleUpgrade(makeReq(`p3000-${SID}.tunnel.example.com`), socket, Buffer.alloc(0));
		await new Promise((r) => setImmediate(r));
		expect(written.some((line) => line.includes("502"))).toBe(true);
		expect(wsSpy).not.toHaveBeenCalled();
	});

	it("returns false from handleUpgrade when the dispatcher is disabled", () => {
		// Symmetric with the HTTP fall-through test — a disabled
		// dispatcher must hand every upgrade back to the existing
		// /ws/* path so dev/local without PORT_PROXY_BASE_DOMAIN
		// keeps working.
		const dispatcher = createPortDispatcher({ baseDomain: null, corsOrigins: [] });
		const { socket } = {
			socket: { write: vi.fn(), end: vi.fn(), destroy: vi.fn() } as unknown as Duplex,
		};
		expect(
			dispatcher.handleUpgrade(makeReq(`p3000-${SID}.tunnel.example.com`), socket, Buffer.alloc(0)),
		).toBe(false);
	});

	// PR #223 round 3 SHOULD-FIX: `isDispatcherHost` is the rate
	// limiter's `skip` predicate. It MUST share the parser the
	// dispatcher uses so the limiter and the dispatch decision stay
	// in lockstep — a divergence would either rate-limit non-
	// dispatcher requests (false positive on /api) or skip
	// dispatcher requests (defeating the budget cap).
	it("isDispatcherHost agrees with the dispatch decision", () => {
		const dispatcher = createPortDispatcher({
			baseDomain: "tunnel.example.com",
			corsOrigins: [],
		});
		expect(dispatcher.isDispatcherHost(`p3000-${SID}.tunnel.example.com`)).toBe(true);
		expect(dispatcher.isDispatcherHost(`p3000-${SID}.tunnel.example.com:443`)).toBe(true);
		expect(dispatcher.isDispatcherHost("api.example.com")).toBe(false);
		expect(dispatcher.isDispatcherHost(undefined)).toBe(false);
		// Disabled dispatcher: no host is ever a dispatcher host,
		// so the limiter's `skip` is always true.
		const disabled = createPortDispatcher({ baseDomain: null, corsOrigins: [] });
		expect(disabled.isDispatcherHost(`p3000-${SID}.tunnel.example.com`)).toBe(false);
	});
});

// ── handleProxyError ─────────────────────────────────────────────────────

// PR #223 round 5 NIT: the http-proxy `error` handler had no direct
// coverage. The dispatcher tests stubbed out the proxy entirely, so
// the headersSent guard / WS-vs-HTTP shape detection / body shape
// were all untested. A future refactor that dropped the guard would
// pass every existing test.

describe("handleProxyError", () => {
	function fakeReq(): IncomingMessage {
		return { headers: {}, method: "GET", url: "/" } as unknown as IncomingMessage;
	}

	it("emits 502 + body on a fresh ServerResponse (headersSent=false)", () => {
		const calls: { writeHead?: [number, object]; end?: string; destroyed?: boolean } = {};
		const res = {
			headersSent: false,
			writeHead(status: number, headers: object) {
				calls.writeHead = [status, headers];
			},
			end(body: string) {
				calls.end = body;
			},
			destroy() {
				calls.destroyed = true;
			},
		} as unknown as ServerResponse;
		handleProxyError(new Error("boom"), fakeReq(), res);
		expect(calls.writeHead?.[0]).toBe(502);
		expect(calls.end).toBe("Bad Gateway: target unreachable");
		expect(calls.destroyed).toBeUndefined();
	});

	it("destroys when headers are already sent (mid-stream proxy failure)", () => {
		const calls: { writeHead?: number; end?: string; destroyed?: boolean } = {};
		const res = {
			headersSent: true,
			writeHead(status: number) {
				calls.writeHead = status;
			},
			end(body: string) {
				calls.end = body;
			},
			destroy() {
				calls.destroyed = true;
			},
		} as unknown as ServerResponse;
		handleProxyError(new Error("boom"), fakeReq(), res);
		// Mid-stream: don't double-write a status line, don't append
		// "Bad Gateway: …" after the legitimate body. Just terminate
		// the partial response.
		expect(calls.writeHead).toBeUndefined();
		expect(calls.end).toBeUndefined();
		expect(calls.destroyed).toBe(true);
	});

	it("destroys a raw socket on WS failure (no writeHead, just teardown)", () => {
		// http-proxy's `error` event hands a Duplex socket (not a
		// ServerResponse) when the failure happened on a `proxy.ws()`
		// call. Branch on `writeHead` shape detection.
		const calls: { destroyed?: boolean } = {};
		const socket = {
			destroy() {
				calls.destroyed = true;
			},
		} as unknown as Duplex;
		handleProxyError(new Error("ws boom"), fakeReq(), socket);
		expect(calls.destroyed).toBe(true);
	});
});

// ── Dispatcher counters (#241c) ──────────────────────────────────────────

describe("dispatcher counters (#241c)", () => {
	const VALID_BASE = "tunnel.example.com";
	const VALID_HOST = `p3000-${SID}.${VALID_BASE}`;

	beforeEach(() => {
		__resetDispatcherStatsForTests();
	});

	function makeDispatcher() {
		return createPortDispatcher({
			baseDomain: VALID_BASE,
			corsOrigins: [],
			lookupTarget: vi.fn(async () => null), // 404 path — simplest
			verifyToken: vi.fn(() => null),
			parseHost: makeHostParser(VALID_BASE),
		});
	}

	it("starts with every counter at zero", () => {
		expect(getDispatcherStats()).toEqual({
			requestsSinceBoot: 0,
			responses2xxSinceBoot: 0,
			responses3xxSinceBoot: 0,
			responses4xxSinceBoot: 0,
			responses5xxSinceBoot: 0,
		});
	});

	it("does NOT bump on requests the dispatcher doesn't claim (host outside base domain)", () => {
		const { middleware } = makeDispatcher();
		const req = makeReq("api.example.com"); // wrong host — falls through
		const res = makeRes();
		middleware(req, res, () => {});
		// The close-listener was never attached because parseHost returned
		// null and the middleware called next() directly. The counter must
		// stay at zero.
		res.__fireClose();
		expect(getDispatcherStats().requestsSinceBoot).toBe(0);
	});

	it("counts 4xx responses (CSRF gate / auth failures) under responses4xxSinceBoot", async () => {
		const { middleware } = makeDispatcher();
		// Cross-origin request from a non-allowlisted origin → 403 from
		// the CSRF gate at the top of the middleware, before authorize().
		const req = makeReq(VALID_HOST, undefined, "https://evil.com");
		const res = makeRes();
		middleware(req, res, () => {});
		res.__fireClose();
		const s = getDispatcherStats();
		expect(s.requestsSinceBoot).toBe(1);
		expect(s.responses4xxSinceBoot).toBe(1);
		expect(s.responses2xxSinceBoot).toBe(0);
	});

	it("counts the 404 lookup-miss path under responses4xxSinceBoot", async () => {
		const { middleware } = makeDispatcher();
		const req = makeReq(VALID_HOST);
		const res = makeRes();
		middleware(req, res, () => {});
		// Allow the authorize() promise chain to settle.
		await new Promise((r) => setTimeout(r, 0));
		res.__fireClose();
		const s = getDispatcherStats();
		expect(s.requestsSinceBoot).toBe(1);
		expect(s.responses4xxSinceBoot).toBe(1);
	});

	it("counts a successful proxy response under responses2xxSinceBoot", async () => {
		// 2xx is the most common runtime case (the public dev-server port
		// returning HTML / JSON to a browser). Stub the proxy so it
		// synchronously assigns a 200 to the response — the real
		// `http-proxy` would do this asynchronously after the upstream
		// responded, but the dispatcher's hookpoint reads `res.statusCode`
		// at close, which is the same value either way.
		const proxyStub = {
			web: vi.fn((_req, res: ServerResponse) => {
				res.statusCode = 200;
			}),
		} as unknown as Parameters<typeof createPortDispatcher>[0]["proxy"];
		const dispatcher = createPortDispatcher({
			baseDomain: VALID_BASE,
			corsOrigins: [],
			lookupTarget: vi.fn(async () => ({
				hostPort: 32768,
				isPublic: true, // public — skip auth
				ownerUserId: "u-owner",
			})),
			verifyToken: vi.fn(() => null),
			parseHost: makeHostParser(VALID_BASE),
			proxy: proxyStub,
		});
		const req = makeReq(VALID_HOST);
		const res = makeRes();
		dispatcher.middleware(req, res, () => {});
		await new Promise((r) => setTimeout(r, 0));
		res.__fireClose();
		const s = getDispatcherStats();
		expect(s.requestsSinceBoot).toBe(1);
		expect(s.responses2xxSinceBoot).toBe(1);
		expect(s.responses4xxSinceBoot).toBe(0);
		expect(s.responses5xxSinceBoot).toBe(0);
	});

	it("counts a 3xx redirect response under responses3xxSinceBoot", async () => {
		// 3xx is a real production case (a container app returning a
		// redirect — auth-callback shape, OAuth dance, app-internal
		// redirect). Stub the proxy to set statusCode = 301 the same
		// way the 2xx test sets 200.
		const proxyStub = {
			web: vi.fn((_req, res: ServerResponse) => {
				res.statusCode = 301;
			}),
		} as unknown as Parameters<typeof createPortDispatcher>[0]["proxy"];
		const dispatcher = createPortDispatcher({
			baseDomain: VALID_BASE,
			corsOrigins: [],
			lookupTarget: vi.fn(async () => ({
				hostPort: 32768,
				isPublic: true,
				ownerUserId: "u-owner",
			})),
			verifyToken: vi.fn(() => null),
			parseHost: makeHostParser(VALID_BASE),
			proxy: proxyStub,
		});
		const req = makeReq(VALID_HOST);
		const res = makeRes();
		dispatcher.middleware(req, res, () => {});
		await new Promise((r) => setTimeout(r, 0));
		res.__fireClose();
		const s = getDispatcherStats();
		expect(s.requestsSinceBoot).toBe(1);
		expect(s.responses3xxSinceBoot).toBe(1);
		expect(s.responses2xxSinceBoot).toBe(0);
	});

	it("counts a 502 (proxy/lookup error) under responses5xxSinceBoot", async () => {
		// authorize throws via the lookup stub → middleware emits 502.
		const dispatcher = createPortDispatcher({
			baseDomain: VALID_BASE,
			corsOrigins: [],
			lookupTarget: vi.fn(async () => {
				throw new Error("D1 boom");
			}),
			verifyToken: vi.fn(() => null),
			parseHost: makeHostParser(VALID_BASE),
		});
		const req = makeReq(VALID_HOST);
		const res = makeRes();
		dispatcher.middleware(req, res, () => {});
		await new Promise((r) => setTimeout(r, 0));
		res.__fireClose();
		const s = getDispatcherStats();
		expect(s.requestsSinceBoot).toBe(1);
		expect(s.responses5xxSinceBoot).toBe(1);
	});

	it("hooks res.on('close') (not 'finish') so an aborted request still counts", async () => {
		// `close` fires on both successful flush AND client disconnect
		// mid-flush; `finish` only on successful flush. Pinning the
		// hookpoint here means a regression that swaps `close` for
		// `finish` — which would silently miss aborts on the dashboard
		// — gets caught.
		const { middleware } = makeDispatcher();
		const req = makeReq(VALID_HOST, undefined, "https://evil.com");
		const res = makeRes();
		middleware(req, res, () => {});
		// Production code attaches exactly one `close` listener — confirm
		// the listener landed on the right event.
		expect(res.closeListeners.length).toBe(1);
	});
});

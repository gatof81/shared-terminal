import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkPushEndpoint, DEFAULT_PUSH_HOSTS, pushEndpointHosts } from "./pushEndpoint.js";

const check = (e: string) => checkPushEndpoint(e, DEFAULT_PUSH_HOSTS);

describe("checkPushEndpoint (#566)", () => {
	it.each([
		"https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91b",
		"https://updates.push.services.mozilla.com/wpush/v2/gAAAAAB",
		"https://web.push.apple.com/QGuQyavXutnMH",
		"https://wns2-par02p.notify.windows.com/w/?token=BQYAAAD",
		"https://FCM.googleapis.com:443/fcm/send/x", // case and the default port normalise
	])("allows the browsers' push services: %s", (e) => {
		expect(check(e)).toEqual({ ok: true });
	});

	it.each([
		["http://fcm.googleapis.com/fcm/send/x", "not https"],
		["https://fcm.googleapis.com:8443/x", "port"],
		["https://user:pw@fcm.googleapis.com/x", "userinfo"],
		["https://127.0.0.1/x", "IP literal"],
		["https://2130706433/x", "IP literal"], // 127.0.0.1 as one number
		["https://0x7f.1/x", "IP literal"],
		["https://[::1]/x", "IP literal"],
		["https://[::ffff:10.0.0.5]/x", "IP literal"],
		["https://169.254.169.254/latest/meta-data", "IP literal"],
		["https://fcm.googleapis.com./x", "trailing dot"],
		["https://st-backend/api", "host not a DNS name"],
		["https://localhost/x", "host not a DNS name"],
		["https://evil.example/x", "host not allowed"],
		["https://fcm.googleapis.com.evil.example/x", "host not allowed"],
		["https://notfcm.googleapis.com/x", "host not allowed"],
		["https://push.services.mozilla.com/x", "host not allowed"], // `*.` needs a label before it
		["https://evilpush.services.mozilla.com/x", "host not allowed"],
		["not a url", "not a URL"],
	])("refuses %s (%s)", (e, reason) => {
		expect(check(e)).toEqual({ ok: false, reason });
	});

	it("allows an explicit :443 (both parsers send to 443)", () => {
		expect(check("https://fcm.googleapis.com:443/fcm/send/x")).toEqual({ ok: true });
	});
});

// WHATWG keeps these characters inside a host; the legacy `url.parse` that
// web-push connects with cuts the host at them (#574 review).
const DIFFERENTIALS = [
	"https://127.0.0.1'.push.services.mozilla.com/x",
	"https://st-backend;.push.services.mozilla.com/x",
	"https://evil.example{.push.services.mozilla.com/x",
	'https://10.0.0.5".notify.windows.com/x',
	"https://evil.example`.notify.windows.com/x",
	"https://evil.example}.push.services.mozilla.com/x",
	"https://evil%2Eexample.push.services.mozilla.com/x",
	"https:///fcm.googleapis.com/x",
	"https://\\fcm.googleapis.com/x",
	"https://fcm.googleapis.com:0443/x",
];

describe("parser differentials (web-push parses with url.parse)", () => {
	it.each(DIFFERENTIALS)("refuses %s", (e) => {
		expect(check(e).ok).toBe(false);
	});

	// The property that matters, on the real library: whatever passes the check,
	// web-push connects to exactly that allowlisted host on 443.
	const require = createRequire(import.meta.url);
	const https = require("node:https") as typeof import("node:https");
	const webpush = require("web-push") as typeof import("web-push");
	afterEach(() => vi.restoreAllMocks());

	it.each([
		...DIFFERENTIALS,
		"https://fcm.googleapis.com/fcm/send/x",
		"https://updates.push.services.mozilla.com/wpush/v2/x",
		"https://web.push.apple.com/QX",
		"https://wns2-par02p.notify.windows.com/w/?token=x",
		"https://fcm.googleapis.com:443/x",
	])("what passes is where web-push connects: %s", async (e) => {
		const seen: Array<{ hostname?: string | null; port?: string | number | null }> = [];
		vi.spyOn(https, "request").mockImplementation(((opts: {
			hostname?: string | null;
			port?: string | number | null;
		}) => {
			seen.push({ hostname: opts.hostname, port: opts.port });
			throw new Error("stubbed: no network in tests");
		}) as never);
		await webpush
			.sendNotification({ endpoint: e, keys: { p256dh: "", auth: "" } }, null)
			.catch(() => {});
		if (!check(e).ok) return;
		expect(seen).toHaveLength(1);
		const host = seen[0]!.hostname ?? "";
		expect(host).toBe(new URL(e).hostname);
		expect([null, undefined, "", "443"]).toContain(seen[0]!.port);
		expect(
			DEFAULT_PUSH_HOSTS.some((h) =>
				h.startsWith("*.") ? host.endsWith(h.slice(1)) && host.length > h.length - 1 : host === h,
			),
		).toBe(true);
	});
});

describe("pushEndpointHosts", () => {
	it("unset or blank ⇒ the default list", () => {
		expect(pushEndpointHosts({})).toBe(DEFAULT_PUSH_HOSTS);
		expect(pushEndpointHosts({ PUSH_ENDPOINT_HOSTS: "  " })).toBe(DEFAULT_PUSH_HOSTS);
	});
	it("a list replaces it, lower-cased", () => {
		expect(
			pushEndpointHosts({ PUSH_ENDPOINT_HOSTS: "Push.Example.org, *.push.example.net" }),
		).toEqual(["push.example.org", "*.push.example.net"]);
	});
	it.each([
		"10.0.0.5",
		"localhost",
		"*",
		"*.com.",
		"a..b",
		"push.example.org:443",
		"https://x.org",
		"",
	])("refuses the whole value for a malformed entry %j", (bad) => {
		expect(() => pushEndpointHosts({ PUSH_ENDPOINT_HOSTS: `push.example.org,${bad}` })).toThrow(
			/PUSH_ENDPOINT_HOSTS/,
		);
	});
});

import { describe, expect, it } from "vitest";
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
		["https://st-backend/api", "host not allowed"],
		["https://localhost/x", "host not allowed"],
		["https://evil.example/x", "host not allowed"],
		["https://fcm.googleapis.com.evil.example/x", "host not allowed"],
		["https://notfcm.googleapis.com/x", "host not allowed"],
		["https://push.services.mozilla.com/x", "host not allowed"], // `*.` needs a label before it
		["https://evilpush.services.mozilla.com/x", "host not allowed"],
		["not a url", "not a URL"],
	])("refuses %s (%s)", (e, reason) => {
		expect(check(e)).toEqual({ ok: false, reason });
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

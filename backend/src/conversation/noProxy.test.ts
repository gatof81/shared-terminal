import { describe, expect, it } from "vitest";
import { withRelayNoProxy } from "./noProxy.js";

describe("withRelayNoProxy (§2.6)", () => {
	it("no proxy in the env: returned untouched", () => {
		const env = ["TERM=xterm", "NO_PROXY=example.com", "HTTP_PROXY="];
		expect(withRelayNoProxy(env)).toBe(env);
	});
	it("a proxy and no NO_PROXY: both spellings created with the relay host", () => {
		expect(withRelayNoProxy(["HTTPS_PROXY=http://proxy:3128"])).toEqual([
			"HTTPS_PROXY=http://proxy:3128",
			"NO_PROXY=127.0.0.1",
			"no_proxy=127.0.0.1",
		]);
	});
	it("keeps existing entries and appends; never duplicates; leaves `*` alone", () => {
		expect(
			withRelayNoProxy(["http_proxy=http://p:1", "NO_PROXY=.corp,localhost", "no_proxy=*"]),
		).toEqual(["http_proxy=http://p:1", "NO_PROXY=.corp,localhost,127.0.0.1", "no_proxy=*"]);
		expect(withRelayNoProxy(["ALL_PROXY=socks5://p:1", "NO_PROXY=127.0.0.1"])).toEqual([
			"ALL_PROXY=socks5://p:1",
			"NO_PROXY=127.0.0.1",
		]);
	});
	it("an empty NO_PROXY becomes the relay host", () => {
		expect(withRelayNoProxy(["HTTP_PROXY=http://p:1", "NO_PROXY="])).toEqual([
			"HTTP_PROXY=http://p:1",
			"NO_PROXY=127.0.0.1",
		]);
	});
	it("never creates the missing spelling next to the user's own: a lowercase-first client would lose their exemptions", () => {
		expect(withRelayNoProxy(["HTTPS_PROXY=http://p:1", "NO_PROXY=mock-api"])).toEqual([
			"HTTPS_PROXY=http://p:1",
			"NO_PROXY=mock-api,127.0.0.1",
		]);
		expect(withRelayNoProxy(["https_proxy=http://p:1", "no_proxy=.corp"])).toEqual([
			"https_proxy=http://p:1",
			"no_proxy=.corp,127.0.0.1",
		]);
	});
});

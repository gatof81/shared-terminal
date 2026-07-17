import { describe, expect, it } from "vitest";
import { decidePushToggleState, type PushToggleInputs, urlBase64ToUint8Array } from "./push.js";

describe("urlBase64ToUint8Array", () => {
	it("decodes a standard base64 string", () => {
		// "hi" → base64 "aGk=" → bytes [104, 105]
		expect(Array.from(urlBase64ToUint8Array("aGk="))).toEqual([104, 105]);
	});

	it("restores padding when the base64url has none", () => {
		// "hi" base64url without the trailing "=" still decodes to [104, 105].
		expect(Array.from(urlBase64ToUint8Array("aGk"))).toEqual([104, 105]);
	});

	it("translates the URL-safe alphabet (- and _) back to + and /", () => {
		// 0xFB 0xFF encodes as "+/8=" in standard base64, "-_8" in base64url.
		const standard = Array.from(urlBase64ToUint8Array("+/8="));
		const urlSafe = Array.from(urlBase64ToUint8Array("-_8"));
		expect(urlSafe).toEqual(standard);
		expect(urlSafe).toEqual([251, 255]);
	});

	it("produces a Uint8Array of the decoded byte length", () => {
		const out = urlBase64ToUint8Array("aGVsbG8"); // "hello"
		expect(out).toBeInstanceOf(Uint8Array);
		expect(out.length).toBe(5);
	});
});

describe("decidePushToggleState", () => {
	const base: PushToggleInputs = {
		supported: true,
		serverEnabled: true,
		serverSubscribed: false,
		permission: "default",
		isIos: false,
		isStandalone: false,
	};

	it("hides (unsupported) when the server has push disabled — even on iOS", () => {
		expect(decidePushToggleState({ ...base, serverEnabled: false })).toBe("unsupported");
		expect(
			decidePushToggleState({ ...base, serverEnabled: false, isIos: true, isStandalone: false }),
		).toBe("unsupported");
	});

	it("hides (unsupported) when the browser can't push", () => {
		expect(decidePushToggleState({ ...base, supported: false })).toBe("unsupported");
	});

	it("nudges install on non-standalone iOS before the supported check", () => {
		// iOS Safari reports supported:false outside a PWA — the iOS branch must
		// win so the user sees "install", not a silently-hidden feature.
		expect(
			decidePushToggleState({ ...base, isIos: true, isStandalone: false, supported: false }),
		).toBe("ios-needs-install");
	});

	it("treats installed iOS like any other supported browser", () => {
		expect(decidePushToggleState({ ...base, isIos: true, isStandalone: true })).toBe("off");
	});

	it("is blocked when permission is denied", () => {
		expect(decidePushToggleState({ ...base, permission: "denied" })).toBe("blocked");
	});

	it("is on only when granted AND the server has this endpoint", () => {
		expect(decidePushToggleState({ ...base, permission: "granted", serverSubscribed: true })).toBe(
			"on",
		);
	});

	it("is off when granted but the server doesn't have this endpoint", () => {
		// Permission survives an unsubscribe; the server row is the tiebreaker.
		expect(decidePushToggleState({ ...base, permission: "granted", serverSubscribed: false })).toBe(
			"off",
		);
	});

	it("is off when supported and permission still at default", () => {
		expect(decidePushToggleState(base)).toBe("off");
	});
});

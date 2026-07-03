import { describe, expect, it } from "vitest";
import { isRetryableCloseCode, MAX_RECONNECT_ATTEMPTS, reconnectDelayMs } from "./reconnect.js";

describe("reconnectDelayMs", () => {
	// rand() = 0.5 → (0.5*2 - 1) = 0 → zero jitter, pure schedule.
	const noJitter = () => 0.5;

	it("follows the 1s → 2s → 5s → 10s schedule", () => {
		expect(reconnectDelayMs(1, noJitter)).toBe(1000);
		expect(reconnectDelayMs(2, noJitter)).toBe(2000);
		expect(reconnectDelayMs(3, noJitter)).toBe(5000);
		expect(reconnectDelayMs(4, noJitter)).toBe(10000);
	});

	it("caps at the last schedule entry for attempts past the schedule", () => {
		expect(reconnectDelayMs(5, noJitter)).toBe(10000);
		expect(reconnectDelayMs(MAX_RECONNECT_ATTEMPTS, noJitter)).toBe(10000);
		expect(reconnectDelayMs(99, noJitter)).toBe(10000);
	});

	it("clamps a nonsensical attempt number to the first entry", () => {
		expect(reconnectDelayMs(0, noJitter)).toBe(1000);
		expect(reconnectDelayMs(-3, noJitter)).toBe(1000);
	});

	it("applies at most ±20% jitter", () => {
		expect(reconnectDelayMs(1, () => 0)).toBe(800); // rand 0 → -20%
		expect(reconnectDelayMs(1, () => 1)).toBe(1200); // rand 1 → +20%
		expect(reconnectDelayMs(4, () => 0)).toBe(8000);
		expect(reconnectDelayMs(4, () => 1)).toBe(12000);
	});
});

describe("isRetryableCloseCode", () => {
	it("never retries deliberate or policy closes", () => {
		expect(isRetryableCloseCode(1000)).toBe(false); // dispose / clean finish
		expect(isRetryableCloseCode(1008)).toBe(false); // auth / terminated / invalid tab
	});

	it("retries transient failure codes", () => {
		expect(isRetryableCloseCode(1006)).toBe(true); // abnormal (network drop)
		expect(isRetryableCloseCode(1001)).toBe(true); // going away (restart / tunnel roll)
		expect(isRetryableCloseCode(1011)).toBe(true); // transient attach failure
		expect(isRetryableCloseCode(1005)).toBe(true); // no status received
	});
});

/**
 * requestContext.test.ts — correlation-id groundwork (#376).
 *
 * Pins the three properties the logging design leans on: the id is
 * ambient across awaits inside a context, absent outside any context,
 * and the Express middleware issues a distinct id per request.
 */

import type { NextFunction, Request, Response } from "express";
import { describe, expect, it } from "vitest";
import {
	getRequestId,
	newRequestId,
	requestIdMiddleware,
	runWithRequestId,
} from "./requestContext.js";

describe("newRequestId", () => {
	it("is 16 lowercase hex chars", () => {
		expect(newRequestId()).toMatch(/^[0-9a-f]{16}$/);
	});

	it("does not repeat across many draws", () => {
		const ids = new Set(Array.from({ length: 1000 }, () => newRequestId()));
		expect(ids.size).toBe(1000);
	});
});

describe("runWithRequestId / getRequestId", () => {
	it("is undefined outside any context", () => {
		expect(getRequestId()).toBeUndefined();
	});

	it("is visible inside the context and returns fn's result", () => {
		const result = runWithRequestId("abc123", () => `got:${getRequestId()}`);
		expect(result).toBe("got:abc123");
	});

	it("survives awaits — the detached-bootstrap propagation shape", async () => {
		// POST /sessions returns 201 and lets the bootstrap chain keep
		// running; correlation only works if the id survives the awaits
		// inside a chain STARTED within the request's context.
		const seen = await runWithRequestId("def456", async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			return getRequestId();
		});
		expect(seen).toBe("def456");
	});

	it("is scoped — gone after the context exits, inner context shadows outer", () => {
		runWithRequestId("outer", () => {
			expect(getRequestId()).toBe("outer");
			runWithRequestId("inner", () => expect(getRequestId()).toBe("inner"));
			expect(getRequestId()).toBe("outer");
		});
		expect(getRequestId()).toBeUndefined();
	});
});

describe("requestIdMiddleware", () => {
	// The middleware only enters an ALS context around next() — it never
	// touches req/res, so bare casts are enough.
	const req = {} as Request;
	const res = {} as Response;

	function captureId(): string | undefined {
		let seen: string | undefined;
		requestIdMiddleware(req, res, (() => {
			seen = getRequestId();
		}) as NextFunction);
		return seen;
	}

	it("runs next() inside a context carrying a well-formed id", () => {
		expect(captureId()).toMatch(/^[0-9a-f]{16}$/);
	});

	it("issues a distinct id per request", () => {
		expect(captureId()).not.toBe(captureId());
	});
});

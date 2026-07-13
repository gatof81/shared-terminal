/**
 * requestContext.ts — request/correlation id groundwork (#376).
 *
 * One id per HTTP request and per WS upgrade, carried through the async
 * execution chain via AsyncLocalStorage and stamped onto every log line
 * by `requestIdMixin` in logger.ts. Today a failing bootstrap, WS
 * attach, or dispatcher proxy hop logs as interleaved lines with no way
 * to group them by originating request — this is the groundwork any
 * deeper observability needs.
 *
 * Why AsyncLocalStorage + a pino mixin instead of threading
 * `logger.child({ requestId })` through call sites: the child-logger
 * shape requires every module a request touches to accept a logger
 * parameter (or read `req.log`), which is a cross-cutting signature
 * change on dozens of functions. ALS makes the id ambient — every
 * existing `logger.*` call inside a request's async chain correlates
 * with zero call-site churn, including the detached bootstrap pipeline
 * (POST /sessions returns 201 and keeps running; the chain was started
 * inside the request's context, so its awaits inherit the id).
 *
 * The known limit of the ambient approach: callbacks that fire from an
 * async resource CREATED OUTSIDE the context (a TCP socket's 'data' /
 * 'close' events, timers armed before the request) run in that
 * resource's context, not the registering request's. Long-lived WS
 * connections hit exactly this — their per-message/close logging is
 * covered by an explicit `logger.child` captured at connection setup in
 * wsHandler.ts, which is why both mechanisms exist.
 *
 * No public header emission (X-Request-Id) — the id is log-internal;
 * exposing it to clients is a separate decision tracked in #376.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

interface RequestContext {
	requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * 8 random bytes, hex-encoded (16 chars). Not a security token — just a
 * correlation key, so 64 bits is collision-proof at any realistic log
 * volume while keeping log lines shorter than a UUID would.
 */
export function newRequestId(): string {
	return randomBytes(8).toString("hex");
}

/** Run `fn` with `requestId` ambient for its entire async chain. */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
	return storage.run({ requestId }, fn);
}

/** The ambient request id, or undefined outside any request context
 *  (boot, sweeper ticks, reconcile, socket-event callbacks). */
export function getRequestId(): string | undefined {
	return storage.getStore()?.requestId;
}

/**
 * Express middleware — mount FIRST, before the dispatcher and its rate
 * limiter, so every downstream log line (including dispatcher proxy
 * errors and 429s) carries the id.
 */
export function requestIdMiddleware(_req: Request, _res: Response, next: NextFunction): void {
	runWithRequestId(newRequestId(), next);
}

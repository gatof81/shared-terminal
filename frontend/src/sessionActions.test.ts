import { describe, expect, it } from "vitest";
import {
	canDo,
	type SessionActionContext,
	type SessionStatus,
	sessionActions,
	terminalState,
} from "./sessionActions.js";

const ctx = (
	status: SessionStatus,
	role: Partial<Pick<SessionActionContext, "isOwner" | "isAdmin" | "isLead">> = {},
	extra: Partial<SessionActionContext> = {},
): SessionActionContext => ({
	session: { sessionId: "s1", name: "my-project", status },
	isOwner: true,
	isAdmin: false,
	isLead: false,
	...role,
	...extra,
});

const ids = (c: SessionActionContext) =>
	sessionActions(c).map((a) => `${a.id}${a.enabled ? "" : "!"}`);

describe("sessionActions — owner", () => {
	it("running: stop, ports, observers, terminate, delete", () => {
		expect(ids(ctx("running"))).toEqual(["stop", "ports", "observers", "terminate", "delete"]);
	});
	it("stopped: start first", () => {
		expect(ids(ctx("stopped"))).toEqual(["start", "ports", "observers", "terminate", "delete"]);
	});
	it("terminated: restore, never terminate again", () => {
		expect(ids(ctx("terminated"))).toEqual(["restore", "ports", "observers", "delete"]);
	});
	it("failed: the log and delete only", () => {
		expect(ids(ctx("failed"))).toEqual(["viewLog", "delete"]);
	});
	it("every disabled action carries a reason", () => {
		for (const status of ["running", "stopped", "terminated", "failed"] as const) {
			for (const a of sessionActions(ctx(status, { isOwner: false, isAdmin: false }))) {
				if (!a.enabled) expect(a.reason, `${status}/${a.id}`).toMatch(/\w/);
			}
		}
	});
	it("delete is always danger and terminate too", () => {
		const kinds = Object.fromEntries(sessionActions(ctx("running")).map((a) => [a.id, a.kind]));
		expect(kinds.delete).toBe("danger");
		expect(kinds.terminate).toBe("danger");
		expect(kinds.stop).toBe("normal");
	});
});

describe("sessionActions — permissions never widen the backend's", () => {
	it("admin on a foreign session: may start / attach / edit ports / see observers, never stop, terminate or delete", () => {
		const c = ctx("stopped", { isOwner: false, isAdmin: true });
		expect(canDo(c, "start").enabled).toBe(true);
		expect(canDo(c, "ports").enabled).toBe(true);
		expect(canDo(c, "observers").enabled).toBe(true);
		expect(canDo(ctx("running", { isOwner: false, isAdmin: true }), "stop")).toEqual({
			enabled: false,
			reason: "Only the owner can stop this session.",
		});
		expect(canDo(c, "terminate").enabled).toBe(false);
		expect(canDo(c, "delete").enabled).toBe(false);
		expect(canDo(c, "viewLog").enabled).toBe(false);
	});
	it("lead on a member's session: observers only", () => {
		const c = ctx("running", { isOwner: false, isLead: true });
		expect(
			sessionActions(c)
				.filter((a) => a.enabled)
				.map((a) => a.id),
		).toEqual(["observers"]);
	});
	it("a stranger can do nothing", () => {
		const c = ctx("running", { isOwner: false });
		expect(sessionActions(c).some((a) => a.enabled)).toBe(false);
		expect(canDo(c, "open").enabled).toBe(true); // the sidebar never lists it anyway
	});
});

describe("terminalState", () => {
	it("stopped → Start; terminated → Restore + Delete; failed → log + Delete", () => {
		expect(terminalState(ctx("stopped"))?.actions.map((a) => a.id)).toEqual(["start"]);
		expect(terminalState(ctx("terminated"))?.actions.map((a) => a.id)).toEqual([
			"restore",
			"delete",
		]);
		expect(terminalState(ctx("failed"))?.actions.map((a) => a.id)).toEqual(["viewLog", "delete"]);
	});
	it("running + disconnected → Reconnect; running + no tabs → Open a tab; attached → nothing", () => {
		expect(
			terminalState(ctx("running", {}, { connection: "disconnected", tabs: 2 }))?.actions.map(
				(a) => a.id,
			),
		).toEqual(["reconnect"]);
		expect(terminalState(ctx("running", {}, { tabs: 0 }))?.actions.map((a) => a.id)).toEqual([
			"newTab",
		]);
		expect(terminalState(ctx("running", {}, { connection: "attached", tabs: 2 }))).toBeNull();
	});
	it("reconnect is only offered to someone who may attach", () => {
		const st = terminalState(
			ctx("running", { isOwner: false, isLead: true }, { connection: "disconnected" }),
		);
		expect(st?.actions[0]).toMatchObject({ id: "reconnect", enabled: false });
	});
});

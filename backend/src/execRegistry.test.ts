/**
 * execRegistry.test.ts — lifecycle + eviction semantics for #381's
 * process-local exec registry.
 */

import { describe, expect, it } from "vitest";
import { ExecRegistry } from "./execRegistry.js";

describe("ExecRegistry", () => {
	it("registers a running entry with a unique e_-prefixed id", () => {
		const reg = new ExecRegistry();
		const a = reg.register("s1");
		const b = reg.register("s1");
		expect(a.execId).toMatch(/^e_[0-9a-f]{16}$/);
		expect(a.execId).not.toBe(b.execId);
		expect(a.state).toBe("running");
		expect(a.exitCode).toBeNull();
		expect(reg.get(a.execId)).toBe(a);
	});

	it("counts running execs per session, excluding exited ones", () => {
		const reg = new ExecRegistry();
		const a = reg.register("s1");
		reg.register("s1");
		reg.register("s2");
		expect(reg.runningCount("s1")).toBe(2);
		reg.markExited(a.execId, 0);
		expect(reg.runningCount("s1")).toBe(1);
		expect(reg.runningCount("s2")).toBe(1);
	});

	it("attributes exit reason from kill intent, first writer wins", () => {
		const reg = new ExecRegistry();
		const a = reg.register("s1");
		reg.markKillIntent(a.execId, "killed");
		// A later timeout must not relabel a user-requested kill.
		reg.markKillIntent(a.execId, "timeout");
		reg.markExited(a.execId, 137);
		expect(reg.get(a.execId)).toMatchObject({ state: "exited", exitCode: 137, reason: "killed" });
	});

	it("defaults reason to 'exited' and ignores double markExited", () => {
		const reg = new ExecRegistry();
		const a = reg.register("s1");
		reg.markExited(a.execId, 0);
		reg.markExited(a.execId, 1);
		expect(reg.get(a.execId)).toMatchObject({ exitCode: 0, reason: "exited" });
	});

	it("clearKillIntent walks back an already-exited kill so a natural exit reports 'exited'", () => {
		const reg = new ExecRegistry();
		const a = reg.register("s1");
		reg.markKillIntent(a.execId, "timeout");
		reg.clearKillIntent(a.execId);
		reg.markExited(a.execId, 0);
		expect(reg.get(a.execId)?.reason).toBe("exited");
	});

	it("records pgid when the sentinel reports it", () => {
		const reg = new ExecRegistry();
		const a = reg.register("s1");
		expect(a.pgid).toBeUndefined();
		reg.setPgid(a.execId, 4321);
		expect(reg.get(a.execId)?.pgid).toBe(4321);
	});

	it("evicts old exited entries at the hard cap but never running ones", () => {
		const reg = new ExecRegistry();
		// Fill to the cap (5000) with exited entries plus one running.
		const running = reg.register("keep");
		for (let i = 0; i < 5000; i++) {
			const e = reg.register("bulk");
			reg.markExited(e.execId, 0);
		}
		// The next register prunes down below the cap...
		const fresh = reg.register("s2");
		expect(reg.size()).toBeLessThanOrEqual(5001);
		// ...and both the running entry and the fresh one survive.
		expect(reg.get(running.execId)).toBeDefined();
		expect(reg.get(fresh.execId)).toBeDefined();
	});
});

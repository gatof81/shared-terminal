import { afterEach, describe, expect, it, vi } from "vitest";
import { deferFit, isGeometryFrozen, setGeometryFrozen } from "./terminalGeometry.js";

afterEach(() => setGeometryFrozen(false));

describe("terminal geometry freeze", () => {
	it("defers fits while frozen and runs each once on thaw", () => {
		const fit = vi.fn();
		setGeometryFrozen(true);
		expect(isGeometryFrozen()).toBe(true);
		deferFit(fit);
		deferFit(fit);
		expect(fit).not.toHaveBeenCalled();
		setGeometryFrozen(false);
		expect(fit).toHaveBeenCalledTimes(1);
		setGeometryFrozen(true);
		setGeometryFrozen(false);
		expect(fit).toHaveBeenCalledTimes(1);
	});

	it("a cancelled deferral does not run (disposed terminal)", () => {
		const fit = vi.fn();
		setGeometryFrozen(true);
		const cancel = deferFit(fit);
		cancel();
		setGeometryFrozen(false);
		expect(fit).not.toHaveBeenCalled();
	});
});

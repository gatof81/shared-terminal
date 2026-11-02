// Regression 3: --min-idle is an OBSERVED continuous interval, also with an
// empty or missing hooks file; one idle observation never counts as 30 s.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdleTracker } from "../idle.mjs";

const MIN = 30_000;
const run = (obs, opts = {}) => {
	const t = createIdleTracker({ minIdleMs: MIN, maxGapMs: 10_000, ...opts });
	return obs.map((o) => t.observe({ hookCount: 0, openTurn: false, atPrompt: true, ...o }));
};

test("una sola observación idle nunca es inactividad suficiente (aunque el último hook sea viejo o no exista)", () => {
	const [r] = run([{ tMs: 1_000_000 }]);
	assert.equal(r.ready, false);
	assert.equal(r.observedMs, 0);
});

test("con hooks vacíos: 30 s observados de forma continua → listo exactamente al cumplirse", () => {
	const obs = Array.from({ length: 11 }, (_, i) => ({ tMs: i * 3000 }));
	const res = run(obs);
	assert.equal(res.at(-2).ready, false); // 27 s
	assert.equal(res.at(-1).ready, true); // 30 s
	assert.equal(res.at(-1).observedMs, 30_000);
});

test("un hueco sin observar > maxGap reinicia la ventana", () => {
	const res = run([{ tMs: 0 }, { tMs: 5000 }, { tMs: 40_000 }, { tMs: 45_000 }]);
	assert.equal(res.at(-1).ready, false);
	assert.equal(res.at(-1).observedMs, 5000);
});

test("una observación fuera del prompt reinicia", () => {
	const res = run([{ tMs: 0 }, { tMs: 9000 }, { tMs: 18_000, atPrompt: false }, { tMs: 27_000 }, { tMs: 36_000 }]);
	assert.equal(res.at(-1).ready, false);
	assert.equal(res.at(-1).observedMs, 9000);
});

test("una línea nueva de hooks (actividad) reinicia; un turno abierto no cuenta", () => {
	const a = run([{ tMs: 0 }, { tMs: 9000 }, { tMs: 18_000, hookCount: 1 }, { tMs: 27_000, hookCount: 1 }, { tMs: 36_000, hookCount: 1 }]);
	assert.equal(a.at(-1).ready, false);
	const b = run([{ tMs: 0, openTurn: true }, { tMs: 30_000, openTurn: true }]);
	assert.equal(b.at(-1).ready, false);
});

test("dos observaciones separadas exactamente 30 s pero con hueco > maxGap no cuentan", () => {
	const res = run([{ tMs: 0 }, { tMs: 30_000 }]);
	assert.equal(res.at(-1).ready, false);
});

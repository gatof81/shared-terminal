// Readable interruptions (revisión UI §14): Pendientes in two sections —
// Preguntas, then «Interrupciones · N» with «Dar por revisadas…» (a summary,
// a confirmation, one POST …/review each); a row that says what happened in
// plain words, whether there is a report, that nothing runs any more and
// what the agent does now; the interruptions of agents that no longer exist
// (not in the agents list — whatever their names look like) in one grouped
// row; and the review card without the tools a deleted agent cannot have.

import type { Route } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { CONV_IDS, type MockBackend, PROJECT_IDS } from "./mockBackend.js";

const HZ = PROJECT_IDS.hz;
const T0 = Date.parse("2026-10-31T10:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const PANEL = ".acp-inbox-card";

/** Three interruptions of agents whose sessions were deleted, and one of @dev with its report. */
function seed(backend: MockBackend): { dev: number; gone: number[] } {
	backend.enableConversations();
	const gone = [
		["t3f9a-arq", "runner restarted: turn in progress"],
		["t3f9a-dev", "prompt error: Internal error"],
		["t81c0-dev", null],
	].map(
		([to, note], i) =>
			backend.addAcpMessage({
				to_id: to!,
				body: `@${to} acceptance step ${i + 1}: run st send and report`,
				state: "uncertain",
				note,
				created_at: at(100 + i * 10),
				finished_at: at(105 + i * 10),
			}).id,
	);
	const dev = backend.addAcpMessage({
		to_id: "dev",
		body: "@dev medí también la variante sin shards.",
		project_id: HZ,
		conversation_id: CONV_IDS.backend,
		state: "uncertain",
		note: "adapter exited (SIGTERM)",
		created_at: at(1100),
		finished_at: at(1150),
	});
	backend.addAcpMessage({
		from_id: "system",
		to_id: "dev",
		body: "Tu ejecución anterior se interrumpió: informá de solo lectura qué quedó hecho.",
		project_id: HZ,
		conversation_id: CONV_IDS.backend,
		recovery_of: dev.id,
		state: "done",
		result_text: "Llegué a lanzar 1 corrida sin shards; no hice commits ni cambié archivos.",
		created_at: at(1160),
		finished_at: at(1170),
	});
	return { dev: dev.id, gone };
}

const reviewPath = (id: number) => `/acp/messages/${id}/review`;

test.describe("readable interruptions in Pendientes", () => {
	test("a row in plain words; the deleted agents' ones grouped, reviewed in one tap", async ({
		app,
		backend,
		page,
	}) => {
		const { gone } = seed(backend);
		await app.login("alice", `#/projects/${HZ}`);
		const inbox = page.locator("#inbox-btn");
		await expect(inbox.locator(".inbox-count")).toHaveText("4");
		await inbox.click();
		const panel = page.locator(PANEL);
		await expect(panel.locator(".acp-inbox-sec")).toHaveText([
			"Interrupciones · 4",
			"Resultados sin ver",
		]);
		const row = panel.locator(".acp-inbox-body > .acp-ib-item.is-interrupted");
		await expect(row).toHaveCount(1);
		await expect(row.locator(".acp-ib-what")).toHaveText("@dev se reinició mientras trabajaba");
		await expect(row.locator(".acp-ib-quote")).toHaveText(
			"«@dev medí también la variante sin shards.»",
		);
		await expect(row.locator(".acp-ib-chip:visible")).toHaveText([
			"✓ Dejó informe",
			"Ya no está corriendo",
			// The mock's @dev is working on another message.
			"Ahora: trabajando en otro",
		]);
		// Never the runner's raw text in the panel.
		await expect(panel).not.toContainText("adapter exited");

		const group = panel.locator(".acp-ib-item.is-gone-group");
		await expect(group.locator("> .acp-ib-main > .acp-ib-what")).toHaveText(
			"3 interrupciones de agentes eliminados",
		);
		await expect(group.locator("> .acp-ib-main > .acp-ib-quote")).toHaveText(
			"@t3f9a-arq, @t3f9a-dev, @t81c0-dev · no se pueden retomar",
		);
		// One by one: folded, each in plain words (a prompt error is not a restart).
		const one = group.locator(".acp-ib-onebyone .acp-ib-item");
		await expect(one.first()).toBeHidden();
		await group.getByText("Ver una por una").click();
		await expect(one.locator(".acp-ib-what")).toHaveText([
			"@t3f9a-arq se reinició mientras trabajaba",
			"@t3f9a-dev tuvo un error mientras trabajaba",
			"@t81c0-dev se reinició mientras trabajaba",
		]);
		await expect(one.first().getByRole("button", { name: /^Ver en/ })).toHaveCount(0);

		await group.getByRole("button", { name: "Dar por revisadas las 3" }).click();
		await expect(group).toBeHidden();
		await expect(inbox.locator(".inbox-count")).toHaveText("1");
		expect(backend.reviewCalls).toEqual(gone.map((id) => ({ id, verb: "review" })));
		await expect(row).toHaveCount(1);
	});

	test("«Dar por revisadas…»: a summary, then one review each; a 409 in the middle counts as done", async ({
		app,
		backend,
		page,
	}) => {
		const { dev, gone } = seed(backend);
		// The second one was requeued elsewhere in the meantime: the backend answers 409.
		const requeued = backend.acpMessages.find((m) => m.id === gone[1])!;
		backend.override = async (method: string, path: string, route: Route) => {
			if (method !== "POST" || path !== reviewPath(requeued.id)) return false;
			requeued.state = "pending";
			await route.fulfill({
				status: 409,
				contentType: "application/json",
				body: JSON.stringify({ error: "not-uncertain", state: "pending" }),
			});
			return true;
		};
		const sent: string[] = [];
		page.on("request", (r) => {
			if (r.method() === "POST" && /\/requeue$|\/api\/acp\/messages$/.test(r.url()))
				sent.push(r.url());
		});
		await app.login("alice", `#/projects/${HZ}`);
		await page.locator("#inbox-btn").click();
		const panel = page.locator(PANEL);
		await expect(panel.locator(".acp-ib-item.is-gone-group")).toBeVisible();
		await panel.getByRole("button", { name: "Dar por revisadas…" }).click();
		const batch = panel.locator(".acp-ib-batch");
		await expect(batch.locator(".acp-ib-batch-text")).toHaveText(
			"4 interrupciones: 1 con informe, 3 de agentes que ya no existen. No se reenvía nada.",
		);
		const confirm = batch.getByRole("button", { name: "Dar por revisadas las 4" });
		await expect(confirm).toBeFocused();
		await confirm.click();
		await expect(panel.locator(".acp-inbox-none")).toHaveText("Nada pendiente");
		await expect(
			page.locator("#toast .toast-item", { hasText: "4 dadas por revisadas" }),
		).toBeVisible();
		await expect(page.locator("#inbox-btn .inbox-count")).toBeHidden();
		expect(backend.reviewCalls.map((c) => c.id)).toEqual([gone[0], gone[2], dev]);
		expect(backend.reviewCalls.every((c) => c.verb === "review")).toBe(true);
		expect(sent).toEqual([]);
	});

	test("a failure in a batch: the rest goes on, it says how many are left, and retries them", async ({
		app,
		backend,
		page,
	}) => {
		const { gone } = seed(backend);
		let fail = true;
		backend.override = async (method: string, path: string, route: Route) => {
			if (!fail || method !== "POST" || path !== reviewPath(gone[0]!)) return false;
			await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
			return true;
		};
		await app.login("alice", `#/projects/${HZ}`);
		await page.locator("#inbox-btn").click();
		const panel = page.locator(PANEL);
		const group = panel.locator(".acp-ib-item.is-gone-group");
		await group.getByRole("button", { name: "Dar por revisadas las 3" }).click();
		const batch = panel.locator(".acp-ib-batch");
		await expect(batch.locator(".acp-ib-batch-text")).toHaveText(
			"2 dadas por revisadas; 1 no se pudo guardar y sigue en la lista.",
		);
		await expect(group.locator("> .acp-ib-main > .acp-ib-what")).toHaveText(
			"1 interrupción de un agente eliminado",
		);
		fail = false;
		await batch.getByRole("button", { name: "Volver a intentar" }).click();
		await expect(group).toBeHidden();
		await expect(batch).toBeHidden();
		await expect(page.locator("#inbox-btn .inbox-count")).toHaveText("1");
	});

	test("with a report, «Dar por revisada» right from the row; nothing is resent", async ({
		app,
		backend,
		page,
	}) => {
		const { dev } = seed(backend);
		await app.login("alice", `#/projects/${HZ}`);
		await page.locator("#inbox-btn").click();
		const row = page.locator(`${PANEL} .acp-inbox-body > .acp-ib-item.is-interrupted`);
		await expect(row.getByRole("button")).toHaveText([
			"Dar por revisada",
			"Ver informe",
			"Ver en el tema",
		]);
		await row.getByRole("button", { name: "Dar por revisada" }).click();
		await expect(row).toHaveCount(0);
		await expect(page.locator("#inbox-btn .inbox-count")).toHaveText("3");
		expect(backend.reviewCalls).toEqual([{ id: dev, verb: "review" }]);
		expect(backend.acpMessages.find((m) => m.id === dev)!.state).toBe("uncertain");
	});

	test("the card: the three facts, «Recomendado»; a deleted agent's offers no tools, no writing, no requeue", async ({
		app,
		backend,
		page,
	}) => {
		const { gone } = seed(backend);
		await app.login("alice", `#/projects/${HZ}`);
		await page.locator("#inbox-btn").click();
		const panel = page.locator(PANEL);
		const review = page.locator(".acp-review-card");

		// A live agent with its report.
		await panel
			.locator(".acp-inbox-body > .acp-ib-item.is-interrupted")
			.getByRole("button", { name: "Ver informe" })
			.click();
		await expect(review.locator("h2")).toHaveText("@dev se reinició mientras trabajaba");
		await expect(review.locator(".acp-review-facts dt")).toHaveText([
			"Qué pasó",
			"Informe",
			"Ahora",
		]);
		await expect(review.locator(".acp-review-report")).toContainText("no hice commits");
		await expect(review.locator(".acp-review-facts")).toContainText(
			"@dev está trabajando en otro mensaje.",
		);
		// The runner's text, folded under «Detalle técnico».
		const tech = review.locator(".acp-review-tech code");
		await expect(tech).toBeHidden();
		await review.getByText("Detalle técnico").click();
		await expect(tech).toHaveText("adapter exited (SIGTERM)");
		await expect(review.locator(".acp-review-reco")).toContainText("dala por revisada");
		await expect(review.getByRole("button", { name: "Ver cambios en Git" })).toBeVisible();
		await expect(review.getByRole("button", { name: "Escribirle un mensaje nuevo" })).toBeVisible();
		await expect(review.getByText("Reencolar el mensaje original… (no recomendado)")).toBeVisible();
		await app.escape();
		await expect(review).toBeHidden();

		// A deleted agent's: only «Dar por revisada».
		const group = panel.locator(".acp-ib-item.is-gone-group");
		await group.getByText("Ver una por una").click();
		await group
			.locator(".acp-ib-onebyone .acp-ib-item", { hasText: "@t3f9a-arq" })
			.getByRole("button", { name: "Revisar" })
			.click();
		await expect(review.locator("h2")).toHaveText("@t3f9a-arq se reinició mientras trabajaba");
		await expect(review.locator(".acp-review-facts")).toContainText(
			"@t3f9a-arq ya no existe: su sesión fue eliminada.",
		);
		await expect(review.locator(".acp-review-facts")).toContainText("No dejó informe.");
		await expect(review.locator(".acp-review-reco")).toContainText(
			"No se puede retomar ni reencolar: no hay agente que lo reciba.",
		);
		for (const name of [
			"Ver cambios en Git",
			"Abrir Terminal",
			"Escribirle un mensaje nuevo",
			"Reencolar",
		])
			await expect(review.getByRole("button", { name, exact: true })).toHaveCount(0);
		await expect(review.getByText(/^Reencolar el mensaje original/)).toBeHidden();
		await review.getByRole("button", { name: "Dar por revisada" }).click();
		await expect(review).toBeHidden();
		expect(backend.reviewCalls).toEqual([{ id: gone[0], verb: "review" }]);
		// Pendientes is still the modal under it.
		await expect(panel).toBeVisible();
		await expect(page.locator("#app-view")).toHaveAttribute("inert");
	});
});

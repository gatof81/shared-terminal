// A write's HTTP answer never brings back an older state of a row the live
// socket already moved on (acpThread.layAnswer). With idle runners waiting
// in the claim (#799), the write itself wakes the claim in the backend: the
// row's `running` frame can reach the page before the send's 201 (or the
// requeue's 200), which carries the row as the write left it (`pending`).
// Laid over the frame, the row read «en cola» for the whole run.

import type { Route } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { CONV_IDS, type MockAcpMessage, type MockBackend, PROJECT_IDS } from "./mockBackend.js";

const HZ = PROJECT_IDS.hz;
const THREAD = "#project-view .ps-topic .acp-chat-thread";

/** The row's `running` frame, then (later) the write's answer with the row as it was written. */
async function claimBeatsTheAnswer(
	backend: MockBackend,
	row: MockAcpMessage,
	answer: unknown,
	route: Route,
) {
	const written = { ...row };
	backend.pushAcp({ type: "message", message: written });
	backend.updateAcpMessage(row.id, { state: "running", started_at: "2026-10-31T10:30:00.000Z" });
	await new Promise((r) => setTimeout(r, 300));
	await route.fulfill({
		status: answer === null ? 200 : 201,
		contentType: "application/json",
		body: JSON.stringify(answer ?? written),
	});
}

test.describe("a write's answer after the live frame", () => {
	test.beforeEach(({ backend }) => backend.enableConversations());

	test("a post whose recipient starts before the 201 reads «trabajando»", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice", `#/projects/${HZ}/c/${CONV_IDS.backend}`);
		await expect(page.locator(THREAD)).toContainText("Sin mensajes en esta conversación");
		backend.override = async (method: string, path: string, route: Route) => {
			if (method !== "POST" || path !== "/acp/messages") return false;
			const b = JSON.parse(route.request().postData() ?? "{}") as {
				body: string;
				clientId: string;
			};
			const row = backend.addAcpMessage({
				to_id: "arq",
				body: b.body,
				project_id: HZ,
				conversation_id: CONV_IDS.backend,
				client_id: b.clientId,
				created_at: "2026-10-31T10:29:59.000Z",
			});
			await claimBeatsTheAnswer(
				backend,
				row,
				{ messages: [{ ...row, state: "pending", started_at: null }], replayed: false },
				route,
			);
			return true;
		};
		await page.locator("#project-view .acp-pick-btn").click();
		await page.getByRole("menuitemcheckbox", { name: /@arq\b/ }).click();
		await page.keyboard.press("Escape");
		const answered = page.waitForResponse(
			(r) => r.url().endsWith("/api/acp/messages") && r.request().method() === "POST",
		);
		await page.locator("#project-view .acp-chat-input").fill("esperá 90");
		await page.locator("#project-view .acp-chat-send").click();
		await answered;
		const post = page.locator(`${THREAD} .acp-post`, { hasText: "esperá 90" });
		await expect(post.locator(".acp-rs")).toContainText("trabajando");
		await expect(post.locator(".acp-rs")).not.toContainText("en cola");
		expect(app.errors).toEqual([]);
	});

	test("a requeue whose message starts before the 200 reads «trabajando»", async ({
		app,
		backend,
		page,
	}) => {
		const cut = backend.addAcpMessage({
			to_id: "dev",
			body: "@dev subí el informe de tiempos",
			project_id: HZ,
			conversation_id: CONV_IDS.backend,
			state: "uncertain",
			note: "el contenedor se detuvo",
			created_at: "2026-10-31T10:20:00.000Z",
			finished_at: "2026-10-31T10:21:00.000Z",
		});
		await app.login("alice", `#/projects/${HZ}/c/${CONV_IDS.backend}`);
		backend.override = async (method: string, path: string, route: Route) => {
			if (method !== "POST" || path !== `/acp/messages/${cut.id}/requeue`) return false;
			Object.assign(cut, { state: "pending", reviewed_at: null, finished_at: null });
			await claimBeatsTheAnswer(backend, cut, null, route);
			return true;
		};
		const post = page.locator(`${THREAD} .acp-post`, { hasText: "informe de tiempos" });
		await post.getByRole("button", { name: "Revisar interrupción" }).click();
		const review = page.locator(".acp-review-card");
		await review.getByText("Reencolar el mensaje original…").click();
		await review.getByLabel("Revisé el estado y acepto que puede repetir operaciones.").check();
		const answered = page.waitForResponse((r) => r.url().endsWith(`/requeue`));
		await review.getByRole("button", { name: "Reencolar", exact: true }).click();
		await answered;
		await expect(review).toBeHidden();
		await expect(post.locator(".acp-rs")).toContainText("trabajando");
		await expect(post.locator(".acp-rs")).not.toContainText("en cola");
		expect(app.errors).toEqual([]);
	});
});

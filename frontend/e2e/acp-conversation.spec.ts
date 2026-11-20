// ACP chat as a conversation: the person on the right, each agent's answer on
// the left under the message it answers, a consult's delivered reply shown
// once, technical activity folded, a question inside the answer it blocks.

import { expect, test } from "./fixtures.js";
import { PROJECT_IDS } from "./mockBackend.js";

const SHOTS = process.env.ACP_SHOTS;

test.describe("ACP conversation", () => {
	test.beforeEach(({ backend }) => {
		backend.enableAcp();
		const hz = PROJECT_IDS.hz;
		const post = "c-post-1";
		backend.addAcpMessage({
			to_id: "arq",
			body: "@arq @dev ¿cómo encaramos el login?",
			client_id: post,
			project_id: hz,
			state: "done",
			result_text: "Propongo **OAuth** con PKCE. Le consulto a @dev el estado del backend.",
		});
		backend.addAcpMessage({
			to_id: "dev",
			body: "@arq @dev ¿cómo encaramos el login?",
			client_id: post,
			project_id: hz,
			state: "done",
			result_text: "El backend ya tiene sesiones; falta el callback.",
		});
		const consult = backend.addAcpMessage({
			from_id: "arq",
			to_id: "dev",
			body: "¿El callback de OAuth está implementado?",
			project_id: hz,
			depth: 1,
			state: "done",
			result_text: "Todavía no: lo agrego hoy en `auth/callback.ts`.",
		});
		backend.addAcpMessage({
			from_id: "dev",
			to_id: "arq",
			kind: "reply",
			reply_to: consult.id,
			body: "Todavía no: lo agrego hoy en `auth/callback.ts`.",
			project_id: hz,
			depth: 1,
			state: "done",
			result_text: "Anotado.",
		});
		// A delivered reply whose consult is not in this thread (an older page,
		// another scope): the only place to read it.
		backend.addAcpMessage({
			from_id: "dev",
			to_id: "arq",
			kind: "reply",
			reply_to: 999,
			body: "Los tests de sesión pasan; el de refresh sigue rojo.",
			project_id: hz,
			depth: 1,
			state: "done",
			result_text: "Entonces miro el refresh antes de cerrar.",
		});
		const running = backend.addAcpMessage({
			to_id: "dev",
			body: "@dev implementá el callback",
			project_id: hz,
			state: "running",
		});
		backend.acpActivity = {
			dev: [
				{
					seq: 1,
					at: "2026-10-31T10:29:00Z",
					messageId: running.id,
					kind: "tool",
					toolCallId: "t1",
					title: "Read",
					detail: "auth/session.ts",
					status: "completed",
				},
				{
					seq: 2,
					at: "2026-10-31T10:29:10Z",
					messageId: running.id,
					kind: "tool",
					toolCallId: "t2",
					title: "Edit",
					detail: "auth/callback.ts",
					status: "in_progress",
				},
			],
		};
		const asking = backend.addAcpMessage({
			to_id: "arq",
			body: "@arq elegí el proveedor",
			project_id: hz,
			state: "running",
		});
		backend.acpQuestions = [
			{
				id: 1,
				agent: "arq",
				message_id: asking.id,
				request: JSON.stringify({
					message: "¿Qué proveedor usamos?",
					requestedSchema: {
						type: "object",
						properties: { p: { type: "string", title: "Proveedor", enum: ["GitHub", "Google"] } },
						required: ["p"],
					},
				}),
				state: "open",
				answer: null,
				created_at: "2026-10-31T10:29:30Z",
				answered_at: null,
				delivered_at: null,
				note: null,
			},
		];
		backend.addAcpMessage({ to_id: "dev", body: "@dev después revisá los tests", project_id: hz });
	});

	test("the person on the right, each answer on the left under what it answers", async ({
		page,
		app,
	}, info) => {
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
		const thread = page.locator(".acp-project .acp-chat-thread");
		const post = thread.locator("article.acp-msg", { hasText: "¿cómo encaramos el login?" });
		await expect(post.locator(".acp-sub")).toHaveCount(2);
		// The thread's reading column: its content box (on a wide screen the
		// padding centres a --chat-col column in the full-width scroll box).
		const box = await thread.evaluate((e) => {
			const r = e.getBoundingClientRect();
			const cs = getComputedStyle(e);
			const l = r.x + Number.parseFloat(cs.paddingLeft);
			return { x: l, width: r.right - Number.parseFloat(cs.paddingRight) - l };
		});
		const out = (await post.locator(".acp-out").boundingBox())!;
		const answer = (await post.locator(".acp-sub").first().boundingBox())!;
		// Right edge vs left edge of the column.
		expect(box.x + box.width - (out.x + out.width)).toBeLessThan(40);
		expect(answer.x - box.x).toBeLessThan(40);
		await expect(post.locator(".acp-sub").first().locator(".acp-agent-id")).toHaveText(/@arq/);

		// The consult's answer is shown once: the delivered reply is one folded line.
		const said = "lo agrego hoy";
		await expect(
			thread.locator(".acp-msg-result, .acp-msg-body").filter({ hasText: said, visible: true }),
		).toHaveCount(1);
		await expect(thread.locator(".acp-handoff")).toHaveCount(1);

		// An agent writing to another speaks with its own face (avatar + name in
		// its colour) in a real bubble, its answer the next voice below it.
		const consult = thread.locator("article.acp-consult", { hasText: "callback de OAuth" });
		const author = consult.locator(".acp-bubble").first().locator(".acp-agent-id");
		await expect(author).toHaveText(/@arq/);
		await expect(author.locator(".acp-avatar")).toHaveText("A");
		await expect(consult.locator(".acp-msg-to")).toHaveText(/@dev/);
		const answerer = consult.locator(".acp-sub .acp-agent-id");
		await expect(answerer).toHaveText(/@dev/);
		const hueOf = (l: typeof author) =>
			l.evaluate((e) => getComputedStyle(e).getPropertyValue("--acp-hue").trim());
		expect(await hueOf(author)).not.toBe(await hueOf(answerer));
		const said2 = (await consult.locator(".acp-bubble").first().boundingBox())!;
		const ans2 = (await consult.locator(".acp-sub").boundingBox())!;
		expect(Math.abs(ans2.x - said2.x)).toBeLessThan(2); // not indented under it

		// A delivered reply without its consult in the thread is a bubble in the
		// voice of the agent that answered.
		const lone = thread.locator("article.acp-reply", { hasText: "el de refresh sigue rojo" });
		await expect(lone).not.toHaveClass(/acp-handoff/);
		const replier = lone.locator(".acp-bubble:not(.acp-sub) .acp-agent-id");
		await expect(replier).toHaveText(/@dev/);
		await expect(lone.locator(".acp-msg-to")).toHaveText(/@arq/);
		// What the recipient answers to a delivered reply is said in ITS voice,
		// in its own bubble: the folded line and the replier's bubble hold none.
		for (const reply of [lone, thread.locator("article.acp-reply", { hasText: "Anotado." })]) {
			const own = reply.locator(".acp-sub");
			await expect(own.locator(".acp-agent-id")).toHaveText(/@arq/);
			await expect(own.locator(".acp-msg-result")).toBeVisible();
			expect(await hueOf(own.locator(".acp-agent-id"))).toBe(await hueOf(author));
		}
		await expect(thread.locator(".acp-handoff .acp-msg-result")).toHaveCount(0);
		await expect(lone.locator(".acp-bubble:not(.acp-sub) .acp-msg-result")).toHaveCount(0);

		// Activity folded, its latest step named; a question inside its answer.
		const work = thread.locator("article.acp-msg", { hasText: "implementá el callback" });
		await expect(work.locator(".acp-details > summary")).toHaveText(/Actividad \(2\) · Edit/);
		await expect(work.locator(".acp-activity")).toBeHidden();
		const ask = thread.locator("article.acp-msg", { hasText: "elegí el proveedor" });
		await expect(ask.locator(".acp-sub .acp-question-open")).toBeVisible();
		await expect(ask.locator(".acp-badge-waiting")).toHaveText("esperando tu respuesta");
		const queued = thread.locator("article.acp-msg", { hasText: "después revisá los tests" });
		await expect(queued.locator(".acp-typing")).toHaveText(/En cola/);
		if (SHOTS) {
			await page.screenshot({ path: `${SHOTS}/${info.project.name}.png` });
			await thread.evaluate((t) => {
				t.scrollTop = 0;
			});
			await page.screenshot({ path: `${SHOTS}/${info.project.name}-top.png` });
		}
	});
});

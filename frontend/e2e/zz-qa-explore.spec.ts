// QA exploration (triage #1682) — NOT a test to merge. Each scenario walks
// the app as a person would and logs what it sees as `QA|<scenario>|…`
// lines; screenshots are attached to the report. Findings are judged by a
// human from the log, not by assertions.
import type { ConsoleMessage, Page, TestInfo } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { CONV_IDS, PROJECT_IDS, SESSION_IDS } from "./mockBackend.js";

const HZ = PROJECT_IDS.hz;

function logConsole(page: Page, tag: string): void {
	page.on("console", (m: ConsoleMessage) => {
		if (m.type() === "error" || m.type() === "warning")
			console.log(`QA|${tag}|console.${m.type()}|${m.text().slice(0, 300)}`);
	});
	page.on("pageerror", (e) => console.log(`QA|${tag}|pageerror|${String(e).slice(0, 300)}`));
}

async function state(page: Page) {
	return page.evaluate(() => {
		const vis = (sel: string) => {
			const e = document.querySelector<HTMLElement>(sel);
			if (!e) return "absent";
			const r = e.getBoundingClientRect();
			const cs = getComputedStyle(e);
			return e.hidden || cs.display === "none" || cs.visibility === "hidden" || r.width === 0
				? "hidden"
				: `shown@${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}x${Math.round(r.height)}`;
		};
		const ae = document.activeElement as HTMLElement | null;
		return {
			hash: location.hash,
			body: document.body.className,
			main: document.querySelector("main")?.className ?? "",
			inert: (document.getElementById("terminal-area") as HTMLElement | null)?.inert ?? null,
			sidebar: vis("#sidebar"),
			project: vis("#project-view"),
			topic: vis("#project-view .ps-topic"),
			terminal: vis("#terminal-container"),
			empty: vis("#empty-state"),
			files: vis("#files-view"),
			dialogs: document.querySelectorAll(".modal:not([hidden])").length,
			active: ae
				? `${ae.tagName.toLowerCase()}${ae.id ? `#${ae.id}` : ""}.${(ae.className || "").toString().split(" ").slice(0, 2).join(".")}|${(ae.getAttribute("aria-label") ?? ae.textContent ?? "").trim().slice(0, 40)}`
				: "none",
		};
	});
}

async function log(page: Page, tag: string, step: string): Promise<void> {
	try {
		console.log(`QA|${tag}|${step}|${JSON.stringify(await state(page))}`);
	} catch (e) {
		console.log(`QA|${tag}|${step}|state-error ${String(e).slice(0, 200)}`);
	}
}

async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
	try {
		await info.attach(name, { body: await page.screenshot(), contentType: "image/png" });
	} catch {}
}

async function step(tag: string, name: string, f: () => Promise<void>): Promise<void> {
	try {
		await f();
	} catch (e) {
		console.log(`QA|${tag}|STEP-FAIL ${name}|${String(e).split("\n")[0]?.slice(0, 300)}`);
	}
}

test.describe("QA exploration", () => {
	test.beforeEach(({ backend }) => {
		backend.enableAcp();
		backend.enableConversations();
	});

	test("A: Back after every path, reload on every address", async ({ app, page }, info) => {
		const T = `A-${info.project.name}`;
		logConsole(page, T);
		await app.login("alice");
		await log(page, T, "home");
		await step(T, "project", async () => {
			await app.openSidebar();
			await page.locator(`a.project-row[data-project-id="${HZ}"]`).click();
			await page.waitForTimeout(500);
			await log(page, T, "project");
			await page.locator(".rail-body .rail-conv", { hasText: "Optimización de CI" }).click();
			await page.waitForTimeout(500);
			await log(page, T, "topic-ci");
			await page
				.locator(".rail-body .rail-conv", { hasText: "Rediseño" })
				.click()
				.catch(async () => {
					await page.goBack();
					await page.waitForTimeout(300);
					await page.locator(".rail-body .rail-conv", { hasText: "Rediseño" }).click();
				});
			await page.waitForTimeout(500);
			await log(page, T, "topic-ui");
			for (let i = 1; i <= 5; i++) {
				await page.goBack();
				await page.waitForTimeout(400);
				await log(page, T, `back${i}`);
			}
			for (let i = 1; i <= 3; i++) {
				await page.goForward();
				await page.waitForTimeout(400);
				await log(page, T, `fwd${i}`);
			}
		});
		await step(T, "tools-agent-row", async () => {
			await page.goto(`/#/projects/${HZ}/c/${CONV_IDS.ci}`);
			await page.waitForTimeout(800);
			await app.openSidebar().catch(() => {});
			await page.locator(".rail-agent").first().click();
			await page.waitForTimeout(800);
			await log(page, T, "tools-terminal");
			await shot(page, info, `${T}-tools`);
			await page.goBack();
			await page.waitForTimeout(500);
			await log(page, T, "tools-back");
		});
		const addrs = [
			"",
			`#/sessions/${SESSION_IDS.running}`,
			`#/sessions/${SESSION_IDS.running}/files`,
			`#/sessions/${SESSION_IDS.running}/git`,
			`#/sessions/${SESSION_IDS.stopped}`,
			`#/sessions/${SESSION_IDS.terminated}`,
			`#/sessions/${SESSION_IDS.bob}`,
			`#/sessions/00000000-0000-4000-8000-000000000000`,
			`#/projects/${HZ}`,
			`#/projects/${HZ}/c/${CONV_IDS.ci}`,
			`#/projects/${HZ}/c/c0000000-0000-4000-8000-0000000000ff`,
			`#/projects/${HZ}/archive`,
			`#/projects/${HZ}/c/${CONV_IDS.ci}/tools/dev/~/terminal`,
			`#/projects/${HZ}/c/${CONV_IDS.ci}/tools/dev/~/files`,
			`#/projects/${HZ}/c/${CONV_IDS.ci}/tools/nobody/~/git`,
			`#/projects/6b1f2c3d-0000-4000-8000-0000000000ff`,
			"#/garbage/x",
		];
		for (const a of addrs) {
			await step(T, `reload ${a}`, async () => {
				await page.goto(`/${a}`);
				await page.waitForTimeout(1200);
				await log(page, T, `reload ${a || "(empty)"}`);
				await page.reload();
				await page.waitForTimeout(1200);
				await log(page, T, `reload2 ${a || "(empty)"}`);
			});
		}
		await shot(page, info, `${T}-end`);
	});

	test("B: resize phone⇄desktop with things open", async ({ app, page, backend }, info) => {
		const T = `B-${info.project.name}`;
		logConsole(page, T);
		const phone = { width: 390, height: 844 };
		const wide = { width: 1280, height: 800 };
		const flip = async (label: string) => {
			const vp = page.viewportSize();
			const next = vp && vp.width < 700 ? wide : phone;
			const before = backend.terminalSockets.reduce((n, s) => n + s.sent.length, 0);
			await page.setViewportSize(next);
			await page.waitForTimeout(700);
			const after = backend.terminalSockets.reduce((n, s) => n + s.sent.length, 0);
			await log(
				page,
				T,
				`${label} → ${next.width} (frames +${after - before}, sockets ${backend.terminalSockets.length})`,
			);
			await shot(page, info, `${T}-${label}-${next.width}`);
		};
		await app.login("alice");
		await log(page, T, "start");
		await step(T, "home", async () => {
			await flip("home");
			await flip("home-back");
		});
		await step(T, "session", async () => {
			await app.openSession("my-project");
			await app.expectTerminalReady();
			await flip("session");
			await flip("session-back");
		});
		await step(T, "drawer-open", async () => {
			await page.setViewportSize(phone);
			await page.waitForTimeout(400);
			await app.openSidebar();
			await flip("drawer");
			await flip("drawer-back");
		});
		await step(T, "pendientes", async () => {
			await page.locator("#inbox-btn").click();
			await page.waitForTimeout(400);
			await flip("inbox");
			await flip("inbox-back");
			await app.escape();
		});
		await step(T, "project+selector", async () => {
			await page.goto(`/#/projects/${HZ}/c/${CONV_IDS.ci}`);
			await page.waitForTimeout(800);
			await flip("topic");
			await page
				.locator(".rail-project")
				.click({ timeout: 3000 })
				.catch(() => {});
			await page.waitForTimeout(300);
			await flip("selector");
			await log(page, T, "selector-after-flip");
			await app.escape();
			await flip("topic-back");
		});
		await step(T, "user-menu", async () => {
			await app.openUserMenu();
			await flip("usermenu");
			await app.escape();
			await log(page, T, "usermenu-closed");
		});
	});

	test("C: two tabs — archive / delete in one, use the other", async ({
		app,
		page,
		backend,
	}, info) => {
		const T = `C-${info.project.name}`;
		logConsole(page, T);
		await app.login("alice", `#/projects/${HZ}/c/${CONV_IDS.ci}`);
		await page.waitForTimeout(800);
		const page2 = await page.context().newPage();
		logConsole(page2, `${T}-tab2`);
		await backend.install(page2);
		await page2.goto(`/#/projects/${HZ}/c/${CONV_IDS.ui}`);
		await page2.waitForTimeout(1200);
		await log(page2, `${T}-tab2`, "tab2-open");
		await step(T, "archive in tab2", async () => {
			const r = await page2.evaluate(async (pid) => {
				const res = await fetch(`/api/projects/${pid}`, {
					method: "DELETE",
					credentials: "include",
				});
				return res.status;
			}, HZ);
			console.log(`QA|${T}|archive status ${r}`);
		});
		await step(T, "tab1 after archive", async () => {
			await page.waitForTimeout(3000);
			await log(page, T, "tab1-3s-after");
			const input = page.locator("#project-view .ps-topic .acp-chat-input");
			await input
				.fill("@dev hola", { timeout: 3000 })
				.catch((e) => console.log(`QA|${T}|fill: ${String(e).split("\n")[0]}`));
			await page.keyboard.press("Enter");
			await page.waitForTimeout(1500);
			const posts = backend.requests.filter(
				(r) => r.method === "POST" && r.path.startsWith("/acp/messages"),
			);
			console.log(`QA|${T}|posts after archive: ${posts.length}`);
			await log(page, T, "tab1-after-send");
			await shot(page, info, `${T}-tab1`);
			await page.reload();
			await page.waitForTimeout(1500);
			await log(page, T, "tab1-reload");
			await shot(page, info, `${T}-tab1-reload`);
		});
		await step(T, "two tabs same topic send", async () => {
			await page.goto(`/#/projects/${HZ}/c/${CONV_IDS.backend}`);
			await page2.goto(`/#/projects/${HZ}/c/${CONV_IDS.backend}`);
			await page.waitForTimeout(1200);
			await page2.waitForTimeout(500);
			await log(page, T, "same-topic-1");
			await log(page2, `${T}-tab2`, "same-topic-2");
		});
		await page2.close();
	});

	test("D: dropped sockets, stopped session, agent without runner", async ({
		app,
		page,
		backend,
	}, info) => {
		const T = `D-${info.project.name}`;
		logConsole(page, T);
		backend.acpAgents.find((a) => a.name === "dev")!.runnerSeenAt = null;
		await app.login("alice", `#/sessions/${SESSION_IDS.running}`);
		await app.expectTerminalReady().catch(() => {});
		await step(T, "terminal drop", async () => {
			backend.dropTerminalSockets(SESSION_IDS.running, 1006, "gone");
			await page.waitForTimeout(500);
			await log(page, T, "term-dropped-0.5s");
			await shot(page, info, `${T}-term-drop`);
			await page.waitForTimeout(6000);
			await log(
				page,
				T,
				`term-dropped-6.5s sockets ${backend.terminalSockets.length} open ${backend.terminalSockets.filter((s) => !s.closed).length}`,
			);
			await shot(page, info, `${T}-term-6s`);
		});
		await step(T, "stopped", async () => {
			await app.openSession("docs");
			await page.waitForTimeout(800);
			await log(page, T, "stopped");
			await shot(page, info, `${T}-stopped`);
		});
		await step(T, "acp drop in topic", async () => {
			await page.goto(`/#/projects/${HZ}/c/${CONV_IDS.ci}`);
			await page.waitForTimeout(1200);
			const before = backend.requests.length;
			backend.dropAcpSockets();
			await page.waitForTimeout(200);
			const m = backend.addAcpMessage({
				to_id: "arq",
				body: "llegó durante la caída",
				state: "done",
				result_text: "respuesta durante la caída",
				project_id: HZ,
				conversation_id: CONV_IDS.ci,
			});
			await page.waitForTimeout(6000);
			const reqs = backend.requests.slice(before).map((r) => `${r.method} ${r.path.split("?")[0]}`);
			console.log(`QA|${T}|after acp drop requests: ${JSON.stringify(reqs).slice(0, 600)}`);
			const shown = await page
				.locator("#project-view")
				.getByText("respuesta durante la caída")
				.count();
			console.log(`QA|${T}|message written during drop shown: ${shown} (id ${m.id})`);
			await shot(page, info, `${T}-acp-drop`);
		});
		await step(T, "agent no runner", async () => {
			await app.openSidebar().catch(() => {});
			const dev = await page
				.locator(".rail-agent", { hasText: "@dev" })
				.first()
				.textContent()
				.catch(() => null);
			console.log(`QA|${T}|@dev row: ${dev}`);
		});
	});

	test("E: many topics, long thread, long texts, typing", async ({ app, page, backend }, info) => {
		const T = `E-${info.project.name}`;
		logConsole(page, T);
		for (let i = 0; i < 50; i++)
			backend.acpConversations.push({
				id: `c0000000-0000-4000-8000-${String(1000 + i).padStart(12, "0")}`,
				projectId: HZ,
				title:
					i === 7
						? `Un título larguísimo ${"sin espacios".repeat(1)}${"x".repeat(180)}`
						: `Tema ${i}`,
				createdAt: new Date(Date.parse("2026-10-31T09:00:00Z") + i * 1000).toISOString(),
				archivedAt: null,
				readAt: null,
				recipients: null,
			});
		for (let i = 0; i < 200; i++) {
			const mine = i % 2 === 0;
			backend.addAcpMessage({
				to_id: mine ? "dev" : "arq",
				body: mine ? `@dev mensaje ${i} ${"palabra ".repeat(i % 7 === 0 ? 120 : 8)}` : `@arq ${i}`,
				state: "done",
				result_text:
					i % 10 === 0
						? `Respuesta ${i}\n\n${`\`\`\`\n${"x".repeat(400)}\n\`\`\``}\n\n| a | b |\n|---|---|\n| ${"y".repeat(200)} | z |`
						: `Respuesta ${i}`,
				project_id: HZ,
				conversation_id: CONV_IDS.backend,
			});
		}
		await app.login("alice");
		await step(T, "rail with 53 topics", async () => {
			const t0 = Date.now();
			await page.goto(`/#/projects/${HZ}`);
			await page.locator(".rail-body .rail-conv").nth(40).waitFor({ timeout: 10000 });
			console.log(`QA|${T}|rail 53 topics ready in ${Date.now() - t0} ms`);
			await shot(page, info, `${T}-rail`);
			const overflow = await page.evaluate(() => {
				const out: string[] = [];
				for (const e of document.querySelectorAll<HTMLElement>(".rail-body *, #sidebar *")) {
					if (
						e.scrollWidth > e.clientWidth + 2 &&
						getComputedStyle(e).overflowX === "visible" &&
						e.clientWidth > 0
					)
						out.push(`${e.tagName}.${e.className}`.slice(0, 60));
				}
				return [...new Set(out)].slice(0, 10);
			});
			console.log(`QA|${T}|horizontal overflow in rail: ${JSON.stringify(overflow)}`);
			const docW = await page.evaluate(() => [
				document.documentElement.scrollWidth,
				window.innerWidth,
			]);
			console.log(`QA|${T}|doc scrollWidth vs innerWidth: ${docW}`);
		});
		await step(T, "thread of 200", async () => {
			const t0 = Date.now();
			await page.goto(`/#/projects/${HZ}/c/${CONV_IDS.backend}`);
			await page.locator("#project-view .ps-topic .acp-chat-input").waitFor({ timeout: 15000 });
			await page.waitForTimeout(300);
			console.log(
				`QA|${T}|thread ready in ${Date.now() - t0} ms; items ${await page.locator("#project-view .ps-topic .acp-bubble").count()}`,
			);
			await shot(page, info, `${T}-thread`);
			const wide = await page.evaluate(() => [
				document.documentElement.scrollWidth,
				window.innerWidth,
			]);
			console.log(`QA|${T}|thread doc scrollWidth vs innerWidth: ${wide}`);
			// Scroll up, then a live answer lands: does the reader keep the place?
			const thread = page
				.locator("#project-view .ps-topic .acp-thread, #project-view .ps-topic .acp-chat-thread")
				.first();
			const sc = await page.evaluate(() => {
				const el = [...document.querySelectorAll<HTMLElement>("#project-view .ps-topic *")].find(
					(e) =>
						e.scrollHeight > e.clientHeight + 50 &&
						/(auto|scroll)/.test(getComputedStyle(e).overflowY),
				);
				if (!el) return null;
				el.scrollTop = Math.floor(el.scrollHeight / 3);
				(window as unknown as { __qaScroller: HTMLElement }).__qaScroller = el;
				return { top: el.scrollTop, h: el.scrollHeight, cls: el.className };
			});
			console.log(`QA|${T}|scroller ${JSON.stringify(sc)} ${await thread.count()}`);
			await page.waitForTimeout(500);
			const m = backend.addAcpMessage({
				to_id: "arq",
				body: "@arq en vivo",
				state: "running",
				project_id: HZ,
				conversation_id: CONV_IDS.backend,
			});
			backend.pushAcp({ type: "message", message: m });
			await page.waitForTimeout(400);
			backend.updateAcpMessage(m.id, {
				state: "done",
				result_text: "respuesta en vivo ".repeat(30),
			});
			await page.waitForTimeout(800);
			const after = await page.evaluate(() => {
				const el = (window as unknown as { __qaScroller?: HTMLElement }).__qaScroller;
				return el ? { top: el.scrollTop, h: el.scrollHeight } : null;
			});
			console.log(`QA|${T}|after live answer while scrolled up: ${JSON.stringify(after)}`);
			await shot(page, info, `${T}-after-live`);
		});
		await step(T, "typing in long thread", async () => {
			const input = page.locator("#project-view .ps-topic .acp-chat-input");
			await input.click();
			const t0 = Date.now();
			await page.keyboard.type("@arq ".concat("escribo un texto largo para medir ".repeat(8)), {
				delay: 0,
			});
			const dt = Date.now() - t0;
			const n = (await input.inputValue()).length;
			console.log(`QA|${T}|typed ${n} chars in ${dt} ms (${(dt / n).toFixed(1)} ms/char)`);
			const lt = await page.evaluate(() => {
				const out: number[] = [];
				return new Promise<number[]>((res) => {
					const po = new PerformanceObserver((l) => {
						for (const e of l.getEntries()) out.push(Math.round(e.duration));
					});
					try {
						po.observe({ type: "longtask", buffered: true });
					} catch {}
					setTimeout(() => res(out), 300);
				});
			});
			console.log(`QA|${T}|long tasks (buffered): ${JSON.stringify(lt.slice(-20))}`);
		});
	});

	test("F: keyboard — Tab and Escape on every menu/dialog, focus on close", async ({
		app,
		page,
	}, info) => {
		const T = `F-${info.project.name}`;
		logConsole(page, T);
		await app.login("alice", `#/projects/${HZ}/c/${CONV_IDS.ci}`);
		await page.waitForTimeout(1000);
		const tabWalk = async (label: string, n = 40) => {
			const seen: string[] = [];
			for (let i = 0; i < n; i++) {
				await page.keyboard.press("Tab");
				seen.push(
					await page.evaluate(() => {
						const a = document.activeElement as HTMLElement | null;
						if (!a || a === document.body) return "BODY";
						const r = a.getBoundingClientRect();
						const off =
							r.width === 0 ||
							r.bottom < 0 ||
							r.top > innerHeight ||
							r.right < 0 ||
							r.left > innerWidth;
						return `${a.tagName.toLowerCase()}${a.id ? `#${a.id}` : ""}${off ? "[OFFSCREEN]" : ""}:${(a.getAttribute("aria-label") ?? a.textContent ?? "").trim().slice(0, 24)}`;
					}),
				);
			}
			console.log(`QA|${T}|tab ${label}: ${seen.join(" → ")}`);
		};
		await step(T, "tab topic", () => tabWalk("topic"));
		const opens: Array<[string, () => Promise<void>]> = [
			["selector", () => page.locator(".rail-project").click()],
			["agent⋯", () => page.locator(".rail-agent-more").first().click({ force: true })],
			["inbox", () => page.locator("#inbox-btn").click()],
			["usermenu", () => app.openUserMenu()],
			[
				"topic⋯",
				() =>
					page
						.locator(
							"#project-view .ps-topic .ps-more, #project-view .ps-topic button[aria-haspopup]",
						)
						.first()
						.click(),
			],
		];
		for (const [name, open] of opens) {
			await step(T, `esc ${name}`, async () => {
				await app.openSidebar().catch(() => {});
				await open();
				await page.waitForTimeout(300);
				await log(page, T, `open ${name}`);
				await app.escape();
				await page.waitForTimeout(300);
				await log(page, T, `after-esc ${name}`);
			});
		}
		await step(T, "new session dialog", async () => {
			await page.goto(`/#/sessions/${SESSION_IDS.running}`);
			await page.waitForTimeout(800);
			await app.openSidebar();
			await page.locator("#new-session-btn").click();
			await page.waitForTimeout(400);
			await log(page, T, "new-session open");
			await tabWalk("new-session", 25);
			await app.escape();
			await page.waitForTimeout(300);
			await log(page, T, "new-session after esc");
		});
		await step(T, "tab home", async () => {
			await page.goto("/");
			await page.waitForTimeout(800);
			await tabWalk("home", 30);
		});
		await shot(page, info, `${T}-end`);
	});

	test("G: empty account", async ({ app, page, backend }, info) => {
		const T = `G-${info.project.name}`;
		logConsole(page, T);
		backend.sessions = [];
		backend.acpAgents = [];
		backend.acpConversations = [];
		backend.projects = [];
		await app.login("alice");
		await page.waitForTimeout(1000);
		await log(page, T, "empty home");
		await shot(page, info, `${T}-home`);
		await step(T, "inbox empty", async () => {
			await page.locator("#inbox-btn").click();
			await page.waitForTimeout(500);
			await shot(page, info, `${T}-inbox`);
			await app.escape();
		});
	});

	test("zz: report upload", () => {
		// Fails on purpose so CI uploads the report with the screenshots above.
		expect("QA exploration report").toBe("uploaded");
	});
});

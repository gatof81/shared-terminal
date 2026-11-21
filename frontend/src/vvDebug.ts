/**
 * vvDebug.ts — an opt-in diagnostic for the phone keyboard (owner report
 * 2026-11-13, #616: on an iPhone the input still "goes to the top" when the
 * keyboard opens; Chromium cannot reproduce iOS Safari's viewport, so the
 * data has to come from the device).
 *
 * `?vvdebug=1` turns it on in this browser, `?vvdebug=0` off (kept in
 * localStorage like `?pilot=1`). It records, at every focus change, visual
 * viewport resize/scroll and window scroll, the numbers that decide where
 * the app is drawn — the visual viewport, the page scroll, what main.ts
 * mirrors into --app-vh/--app-top, the focused field's box, and each
 * conversation's scroll position — and shows a small panel with "Copy log".
 * Read-only and local: it changes nothing it measures and sends nothing.
 */

import { copyText } from "./clipboard.js";

const KEY = "st-vvdebug";
const MAX = 300;

/** `?vvdebug=1` on, `?vvdebug=0` off, otherwise what this browser last chose. */
export function vvDebugEnabled(
	search: string,
	storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null,
): boolean {
	const v = new URLSearchParams(search).get("vvdebug");
	try {
		if (v === "1") storage?.setItem(KEY, "1");
		else if (v === "0") storage?.removeItem(KEY);
		return storage?.getItem(KEY) === "1";
	} catch {
		return v === "1";
	}
}

const r = (n: number | undefined | null) => (n === undefined || n === null ? null : Math.round(n));

function box(el: Element | null): [number, number] | null {
	if (!el) return null;
	const b = el.getBoundingClientRect();
	return [r(b.top) ?? 0, r(b.bottom) ?? 0];
}

function scroller(sel: string): [number, number, number] | null {
	const el = document.querySelector<HTMLElement>(sel);
	if (!el || el.clientHeight === 0) return null;
	return [r(el.scrollTop) ?? 0, el.scrollHeight, el.clientHeight];
}

// DIAGNOSTIC BRANCH ONLY (preview/kbd-diagnostic, never merged; audit D1.6):
// the ACP threads instead of the retired `.tw-timeline`, the scrollTop of
// every `overflow: hidden` box between body and the field (a focus reveal
// can scroll those and nothing scrolls them back), the document's scroll
// extent, the composer's and the bar's boxes, and a sample on the touch
// that starts a focus. On by default here; `?vvdebug=0` turns it off.

/** The visible element among `sels` (the first with a box). */
function shown(...sels: string[]): HTMLElement | null {
	for (const sel of sels)
		for (const el of document.querySelectorAll<HTMLElement>(sel))
			if (el.getClientRects().length > 0 && el.clientHeight > 0) return el;
	return null;
}

/** scrollTop of an element if it is on screen, else null. */
function st(sel: string): number | null {
	const el = shown(sel);
	return el ? r(el.scrollTop) : null;
}

let seq = 0;

/** One line of measurements, compact JSON. */
export function sample(ev: string, t0: number): Record<string, unknown> {
	const vv = window.visualViewport;
	const root = document.documentElement;
	const css = getComputedStyle(root);
	const active = document.activeElement;
	const se = document.scrollingElement;
	return {
		n: ++seq,
		t: Math.round(performance.now() - t0),
		ev,
		vv: vv
			? {
					h: r(vv.height),
					w: r(vv.width),
					top: r(vv.offsetTop),
					pageTop: r(vv.pageTop),
					s: vv.scale,
				}
			: null,
		ih: window.innerHeight,
		sy: r(window.scrollY),
		doc: r(se?.scrollTop),
		docSH: se ? se.scrollHeight : null,
		body: r(document.body.scrollTop),
		appVh: css.getPropertyValue("--app-vh").trim(),
		appTop: css.getPropertyValue("--app-top").trim(),
		kb: root.dataset.kb ?? "",
		bodyBox: box(document.body),
		focus:
			active && active !== document.body
				? `${active.tagName.toLowerCase()}.${[...active.classList].slice(0, 2).join(".")}`
				: "",
		focusBox: active && active !== document.body ? box(active) : null,
		// The overflow:hidden boxes between body and the field (H3).
		hid: {
			app: st("#app-view"),
			main: st("main"),
			area: st("#terminal-area"),
			pv: st("#project-view"),
			cv: st("#chat-view"),
			acp: st("#acp-chat"),
		},
		// The thread the reader scrolls: Project Chat / an agent's chat / capture Chat.
		pThread: scroller("#project-view .acp-chat-thread"),
		aThread: scroller("#acp-chat .acp-chat-thread"),
		chat: scroller("#chat-thread .chat-scroll"),
		composerBox: box(shown("#project-view .acp-chat-composer", "#acp-chat .acp-chat-composer")),
		barBox: box(shown("#terminal-toolbar")),
		headerBox: box(shown("#app-view > header")),
	};
}

export function initVvDebug(): void {
	// Diagnostic branch: on unless `?vvdebug=0`.
	let on = true;
	if (new URLSearchParams(window.location.search).get("vvdebug") === "0") on = false;
	if (!on) return;
	const t0 = performance.now();
	const log: string[] = [];
	const panel = document.createElement("div");
	panel.id = "vv-debug";
	panel.setAttribute("role", "status");
	Object.assign(panel.style, {
		position: "fixed",
		top: "4px",
		right: "4px",
		zIndex: "2147483647",
		maxWidth: "70vw",
		padding: "4px 6px",
		font: "10px/1.3 ui-monospace, monospace",
		color: "#fff",
		background: "rgba(120, 20, 20, 0.85)",
		borderRadius: "4px",
		pointerEvents: "auto",
		whiteSpace: "pre-wrap",
		wordBreak: "break-all",
	});
	const text = document.createElement("div");
	const copy = document.createElement("button");
	copy.type = "button";
	copy.textContent = "Copy log";
	const show = document.createElement("button");
	show.type = "button";
	show.textContent = "Show log";
	const clear = document.createElement("button");
	clear.type = "button";
	clear.textContent = "Clear";
	for (const b of [copy, show, clear])
		Object.assign(b.style, { font: "inherit", marginRight: "4px", minHeight: "28px" });
	// The whole log as selectable text, for when the clipboard refuses.
	const full = document.createElement("pre");
	full.hidden = true;
	Object.assign(full.style, {
		maxHeight: "50vh",
		overflow: "auto",
		margin: "4px 0 0",
		font: "inherit",
		whiteSpace: "pre-wrap",
		userSelect: "text",
		webkitUserSelect: "text",
		background: "rgba(0, 0, 0, 0.6)",
		padding: "4px",
	});
	panel.append(text, copy, show, clear, full);
	const header = () =>
		`vvdebug ${navigator.userAgent} dpr=${window.devicePixelRatio} screen=${screen.width}x${screen.height} shell=${document.documentElement.dataset.shell ?? ""} url=${location.pathname}${location.search}${location.hash}`;
	const record = (ev: string) => {
		const s = sample(ev, t0);
		log.push(JSON.stringify(s));
		if (log.length > MAX) log.shift();
		const vv = s.vv as { h: number; top: number; pageTop: number } | null;
		text.textContent = `#${s.n} ${ev} vv.h=${vv?.h} top=${vv?.top} pageTop=${vv?.pageTop} sy=${s.sy} ih=${s.ih} docSH=${s.docSH}\nappTop=${s.appTop} appVh=${s.appVh} kb=${s.kb} hid=${JSON.stringify(s.hid)}\ncomposer=${JSON.stringify(s.composerBox)} focusBox=${JSON.stringify(s.focusBox)}`;
		if (!full.hidden) full.textContent = [header(), ...log].join("\n");
	};
	// The clipboard fallback focuses a hidden textarea: not an event to record.
	let copying = false;
	copy.addEventListener("click", () => {
		copying = true;
		void copyText([header(), ...log].join("\n"), copy).then((ok) => {
			copying = false;
			copy.textContent = ok ? "Copied ✓" : "Copy failed — use Show log";
			setTimeout(() => {
				copy.textContent = "Copy log";
			}, 2500);
		});
	});
	show.addEventListener("click", () => {
		full.hidden = !full.hidden;
		show.textContent = full.hidden ? "Show log" : "Hide log";
		if (!full.hidden) full.textContent = [header(), ...log].join("\n");
	});
	clear.addEventListener("click", () => {
		log.length = 0;
		seq = 0;
		record("clear");
	});
	// Outside body: body is translated and pinned by main.ts while the
	// keyboard is up; the panel must not depend on (or add to) that layout.
	document.documentElement.appendChild(panel);
	window.visualViewport?.addEventListener("resize", () => record("vv-resize"));
	window.visualViewport?.addEventListener("scroll", () => record("vv-scroll"));
	window.addEventListener("scroll", () => record("win-scroll"), { passive: true });
	window.addEventListener("resize", () => record("win-resize"));
	const isField = (t: EventTarget | null) =>
		t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && t.type !== "checkbox");
	// The touch that starts a focus: the state BEFORE the reveal.
	for (const type of ["touchstart", "pointerdown"] as const)
		document.addEventListener(
			type,
			(e) => {
				if (panel.contains(e.target as Node) || !isField(e.target)) return;
				record(type);
			},
			{ capture: true, passive: true },
		);
	document.addEventListener("focusin", (e) => {
		// Ignore the panel's own buttons and the copy's hidden textarea.
		if (copying || panel.contains(e.target as Node)) return;
		record("focusin");
		// iOS moves the viewport a few hundred ms after focus: sample the settle too.
		for (const ms of [50, 100, 200, 300, 600, 1000, 2000])
			setTimeout(() => record(`focus+${ms}`), ms);
	});
	document.addEventListener("focusout", (e) => {
		if (copying || panel.contains(e.target as Node)) return;
		record("focusout");
		for (const ms of [100, 300, 1000]) setTimeout(() => record(`blur+${ms}`), ms);
	});
	// Scrolls of the threads and of the hidden-overflow boxes (captured:
	// scroll doesn't bubble). Which box moved is the H3 evidence.
	const NAMED: Array<[string, string]> = [
		["#project-view .acp-chat-thread", "p-thread-scroll"],
		["#acp-chat .acp-chat-thread", "a-thread-scroll"],
		[".chat-scroll", "chat-scroll"],
		["#app-view", "app-scroll"],
		["main", "main-scroll"],
		["#terminal-area", "area-scroll"],
		["#project-view", "pv-scroll"],
		["#chat-view", "cv-scroll"],
		["#acp-chat", "acp-scroll"],
	];
	document.addEventListener(
		"scroll",
		(e) => {
			const el = e.target;
			if (!(el instanceof HTMLElement)) return;
			for (const [sel, name] of NAMED)
				if (el.matches(sel)) {
					record(name);
					return;
				}
		},
		{ capture: true, passive: true },
	);
	record("start");
}

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

/** One line of measurements, compact JSON. */
export function sample(ev: string, t0: number): Record<string, unknown> {
	const vv = window.visualViewport;
	const root = document.documentElement;
	const css = getComputedStyle(root);
	const active = document.activeElement;
	return {
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
		doc: r(document.scrollingElement?.scrollTop),
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
		project: scroller("#project-view .tw-timeline"),
		chat: scroller("#chat-thread .chat-scroll"),
	};
}

export function initVvDebug(): void {
	let on = false;
	try {
		on = vvDebugEnabled(window.location.search, window.localStorage);
	} catch {
		on = vvDebugEnabled(window.location.search, null);
	}
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
	const clear = document.createElement("button");
	clear.type = "button";
	clear.textContent = "Clear";
	for (const b of [copy, clear]) Object.assign(b.style, { font: "inherit", marginRight: "4px" });
	panel.append(text, copy, clear);
	const record = (ev: string) => {
		const s = sample(ev, t0);
		log.push(JSON.stringify(s));
		if (log.length > MAX) log.shift();
		const vv = s.vv as { h: number; top: number; pageTop: number } | null;
		text.textContent = `${ev} vv.h=${vv?.h} top=${vv?.top} pageTop=${vv?.pageTop} sy=${s.sy} ih=${s.ih}\nappTop=${s.appTop} appVh=${s.appVh} kb=${s.kb} focusBox=${JSON.stringify(s.focusBox)}`;
	};
	copy.addEventListener("click", () => {
		const header = `vvdebug ${navigator.userAgent} dpr=${window.devicePixelRatio} screen=${screen.width}x${screen.height}`;
		void copyText([header, ...log].join("\n"), copy).then((ok) => {
			copy.textContent = ok ? "Copied ✓" : "Copy failed";
			setTimeout(() => {
				copy.textContent = "Copy log";
			}, 1500);
		});
	});
	clear.addEventListener("click", () => {
		log.length = 0;
		record("clear");
	});
	const attach = () => {
		if (!panel.isConnected) document.body.appendChild(panel);
	};
	if (document.body) attach();
	else document.addEventListener("DOMContentLoaded", attach);
	window.visualViewport?.addEventListener("resize", () => record("vv-resize"));
	window.visualViewport?.addEventListener("scroll", () => record("vv-scroll"));
	window.addEventListener("scroll", () => record("win-scroll"), { passive: true });
	window.addEventListener("resize", () => record("win-resize"));
	document.addEventListener("focusin", (e) => {
		// Ignore the panel's own buttons.
		if (panel.contains(e.target as Node)) return;
		record("focusin");
		// iOS moves the viewport a few hundred ms after focus: sample the settle too.
		for (const ms of [100, 300, 600, 1000]) setTimeout(() => record(`focus+${ms}`), ms);
	});
	document.addEventListener("focusout", (e) => {
		if (panel.contains(e.target as Node)) return;
		record("focusout");
		for (const ms of [300, 1000]) setTimeout(() => record(`blur+${ms}`), ms);
	});
	// Scrolls of the conversations themselves (captured: scroll doesn't bubble).
	document.addEventListener(
		"scroll",
		(e) => {
			const el = e.target as Element;
			if (el instanceof HTMLElement && (el.matches(".tw-timeline") || el.matches(".chat-scroll")))
				record(el.matches(".tw-timeline") ? "project-scroll" : "chat-scroll");
		},
		{ capture: true, passive: true },
	);
	record("start");
}

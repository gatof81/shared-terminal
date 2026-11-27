// acpLiveBanner.ts — «Sin conexión en vivo · reintentando…» (revisión 2 §10):
// a 24-px line under the project's header (rail, topic) and in Pendientes,
// shown when /ws/acp is still down 3 s after the outage was announced — the
// short retries of a blip never show it — and replaced by «Conectado» for
// 1 s when the socket comes back (the views reload their page then).
//
// It watches the socket's state (acpLive.watchAcpLiveState) without being a
// listener, so it never keeps the socket open or adds a read. Never placed
// over the terminal: a line there would change its box and send a resize.

import { acpLiveState, watchAcpLiveState } from "./acpLive.js";
import { el } from "./ui.js";

const SHOW_AFTER_MS = 3_000;
const CONNECTED_MS = 1_000;

type Shown = "none" | "down" | "back";

const banners: HTMLElement[] = [];
let shown: Shown = "none";
let showTimer: ReturnType<typeof setTimeout> | null = null;
let backTimer: ReturnType<typeof setTimeout> | null = null;

function paint(): void {
	for (const b of banners) {
		// Never `hidden`: a live region must stay in the tree to be announced
		// (empty, CSS collapses it to nothing).
		b.classList.toggle("is-back", shown === "back");
		b.textContent =
			shown === "down"
				? "Sin conexión en vivo · reintentando…"
				: shown === "back"
					? "Conectado"
					: "";
	}
}

function clearTimers(): void {
	if (showTimer) clearTimeout(showTimer);
	if (backTimer) clearTimeout(backTimer);
	showTimer = backTimer = null;
}

function onState(st: ReturnType<typeof acpLiveState>): void {
	if (st === "down") {
		if (shown === "down" || showTimer) return;
		clearTimers();
		showTimer = setTimeout(() => {
			showTimer = null;
			shown = "down";
			paint();
		}, SHOW_AFTER_MS);
		return;
	}
	clearTimers();
	if (st === "up" && shown === "down") {
		shown = "back";
		backTimer = setTimeout(() => {
			backTimer = null;
			shown = "none";
			paint();
		}, CONNECTED_MS);
	} else shown = "none";
	paint();
}

watchAcpLiveState(onState);
if (acpLiveState() === "down") onState("down");

/** A new banner for one place (each view keeps its own element). */
export function liveBanner(): HTMLElement {
	const b = el("p", "acp-live-banner");
	b.setAttribute("role", "status");
	banners.push(b);
	paint();
	return b;
}

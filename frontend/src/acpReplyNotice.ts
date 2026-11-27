// acpReplyNotice.ts — «@dev respondió en «Optimización de CI» · Ver»
// (revisión 2 §8): when, over /ws/acp, a message of the person finishes in a
// topic that is not the one on screen. Several in a row group into «N
// respuestas nuevas · Ver» (Ver: the latest one's topic). It lasts 6 s or
// until it is tapped; tapping it opens that topic as a new history entry
// (Back returns).
//
// Only live rows: a (re)load reads pages over REST and never reaches this,
// so nothing is news on the first load or after a reconnect. It watches the
// socket's events without being a listener (no read, never holds it open).
//
// Only in the project's views (rail, topic): never over the terminal. Wide,
// it floats top right; on a phone it sits right above the topic's message
// box, or above the rail's foot, in a zero-height anchor — nothing in the
// thread moves, so the reading place is untouched.

import { watchAcpEvents } from "./acpLive.js";
import { agentHue, isReplyNews } from "./acpModel.js";
import type { AcpMessage } from "./api.js";
import { projectName } from "./projectDirectory.js";
import { topicTitle } from "./projectRail.js";
import { navigateProject } from "./router.js";
import { el } from "./ui.js";

const SHOW_MS = 6_000;
/** Rows whose live state this tab remembers (a bound, not a window). */
const SEEN_MAX = 2_000;

interface News {
	agent: string;
	projectId: string | null;
	conversationId: string;
}

/** The last state seen live per message id (a done row seen again is not news). */
const seen = new Map<number, AcpMessage["state"]>();
/** Topic titles learned from live `conversation` frames (other projects' too). */
const titles = new Map<string, string>();
let news: News[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
/** What projectsView says is on screen. */
let screen: { space: boolean; topic: string | null } = { space: false, topic: null };

const anchor = el("div", "acp-reply-anchor");
anchor.setAttribute("role", "status");
const btn = el("button", "acp-reply-notice");
btn.type = "button";
anchor.append(btn);
btn.addEventListener("click", () => {
	const last = news[news.length - 1];
	hide();
	if (last?.projectId)
		navigateProject({
			projectId: last.projectId,
			page: "conversation",
			conversationId: last.conversationId,
		});
});

const phoneMq = typeof window !== "undefined" ? window.matchMedia?.("(max-width: 768px)") : null;

watchAcpEvents((ev) => {
	if (ev.type === "conversation") {
		titles.set(ev.conversation.id, ev.conversation.title);
		return;
	}
	if (ev.type !== "message") return;
	const m = ev.message;
	const prev = seen.get(m.id);
	if (seen.size >= SEEN_MAX) seen.clear();
	seen.set(m.id, m.state);
	if (!isReplyNews(m, prev, screen.topic) || !m.conversation_id) return;
	// Off the project's views (a session's terminal, Herramientas) there is
	// no place for it: the rail's counts and Pendientes keep the news.
	if (!screen.space) return;
	news.push({ agent: m.to_id, projectId: m.project_id ?? null, conversationId: m.conversation_id });
	show();
});

/** Where the notice goes now, or null when there is no place for it. */
function host(): { before: Element | null; parent: Element } | null {
	if (!phoneMq?.matches) return { before: null, parent: document.body };
	const composer = document.querySelector("#project-view .ps-topic .acp-chat-composer");
	if (composer instanceof HTMLElement && composer.offsetParent && composer.parentElement)
		return { before: composer, parent: composer.parentElement };
	const foot = document.querySelector("#project-view .ps-rail-slot .rail-foot");
	if (foot instanceof HTMLElement && foot.offsetParent && foot.parentElement)
		return { before: foot, parent: foot.parentElement };
	return null;
}

function show(): void {
	const h = host();
	if (!h) {
		hide();
		return;
	}
	anchor.classList.toggle("is-floating", h.before === null);
	if (h.before) {
		if (anchor.nextSibling !== h.before) h.parent.insertBefore(anchor, h.before);
	} else if (anchor.parentElement !== h.parent) h.parent.append(anchor);
	paint();
	if (timer) clearTimeout(timer);
	timer = setTimeout(hide, SHOW_MS);
}

function paint(): void {
	const last = news[news.length - 1];
	if (!last) return;
	const avatar = el("span", "acp-avatar", last.agent.slice(0, 1).toUpperCase());
	avatar.style.setProperty("--acp-hue", String(agentHue(last.agent)));
	avatar.setAttribute("aria-hidden", "true");
	let text: string;
	if (news.length > 1) text = `${news.length} respuestas nuevas`;
	else {
		const title = topicTitle(last.conversationId) ?? titles.get(last.conversationId);
		const project = last.projectId ? projectName(last.projectId) : null;
		text = title
			? `@${last.agent} respondió en «${title}»`
			: project
				? `@${last.agent} respondió en un tema de «${project}»`
				: `@${last.agent} respondió en otro tema`;
	}
	btn.replaceChildren(
		avatar,
		el("span", "acp-reply-text", text),
		el("span", "acp-reply-sep", "·"),
		el("span", "acp-reply-go", "Ver"),
	);
}

function hide(): void {
	if (timer) clearTimeout(timer);
	timer = null;
	news = [];
	anchor.remove();
}

/**
 * Told by projectsView on every change of what is on screen: whether the
 * project's views (rail, topic) are up, and the topic shown, if any.
 */
export function setReplyNoticeScreen(space: boolean, topic: string | null): void {
	screen = { space, topic };
	if (!news.length) return;
	news = space ? news.filter((n) => n.conversationId !== topic) : [];
	if (!news.length) hide();
	else {
		// Its place may have moved (topic ⇄ rail on a phone): put it there.
		const t = timer;
		timer = null;
		show();
		// …without restarting its 6 s.
		if (t && timer) {
			clearTimeout(timer);
			timer = t;
		}
	}
}

/** Logout: nothing of this account stays. */
export function resetReplyNotice(): void {
	hide();
	seen.clear();
	titles.clear();
	screen = { space: false, topic: null };
}

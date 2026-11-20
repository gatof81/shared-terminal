// chatScroll.ts — what the three chats share about scrolling: the ACP agent
// chat and Project Chat (acpThread.ts) and the capture Chat (chatView.ts).
// Each thread keeps its own "is the reader at the end", its own count of what
// is new below and its own reading anchor (a row key there, a seq here); this
// module has the rule for "at the end", the search for the row being read,
// and the "go to the end" button.
//
// The button:
// - Shown when the reader is not at the end AND (there is news OR they are
//   more than max(240 px, one screen of thread) away). Hysteresis: once up it
//   stays until the reader is at the end again (< END_SLACK), so a reader
//   moving around the threshold does not make it blink.
// - Only the arrow without news; the arrow and the count with news.
// - A tap scrolls to the end (smoothly; at once with reduced motion) and
//   hides it at once. While that scroll runs (`jumping`) the thread must keep
//   treating the reader as at the end: the animation's own scroll events are
//   not the reader moving up.

/** Closer to the end than this is "at the end" (the threads' own rule). */
export const END_SLACK = 60;

const MIN_DISTANCE = 240;
/** A smooth scroll that never arrives (the content moved under it) stops counting as one. */
const JUMP_MAX_MS = 1500;

export interface ChatEndButtonOptions {
	/** The thread's scrolling box (null while it is not built). */
	scroller: () => HTMLElement | null;
	/** The accessible name, in the view's language: `count` 0 is plain "go to the end". */
	name: (count: number) => string;
	/** Instead of scrolling (the capture Chat past its window's newest end reloads it). */
	onJump?: () => boolean;
	/** Called once the jump starts: the thread clears its count and marks the reader at the end. */
	onJumped: () => void;
}

export class ChatEndButton {
	readonly el: HTMLButtonElement;
	private readonly countEl: HTMLSpanElement;
	private shown = false;
	private count = 0;
	/** Visible words that replace the count (the capture Chat's "N newer events · Jump to latest"). */
	private text: string | null = null;
	private jumpUntil = 0;
	private jumpEl: HTMLElement | null = null;

	constructor(private readonly opts: ChatEndButtonOptions) {
		const b = document.createElement("button");
		b.type = "button";
		b.className = "chat-float chat-end";
		b.hidden = true;
		this.countEl = document.createElement("span");
		this.countEl.className = "chat-end-count";
		b.append(arrowIcon(), this.countEl);
		b.addEventListener("click", () => this.jump());
		this.el = b;
		this.paint();
	}

	/** A smooth jump to the end is under way: its scroll events are not the reader's. */
	get jumping(): boolean {
		if (this.jumpUntil === 0) return false;
		if (Date.now() > this.jumpUntil) this.endJump();
		return this.jumpUntil !== 0;
	}

	/**
	 * After every scroll, render or resize of the thread: `count` is what is
	 * new below the reader (0 when none), `atEnd` the thread's own judgement.
	 */
	sync(count: number, atEnd: boolean): void {
		const sc = this.opts.scroller();
		if (atEnd) this.endJump();
		if (this.text !== null) this.shown = true;
		else if (atEnd || this.jumping || !sc || sc.clientHeight === 0) this.shown = false;
		else if (!this.shown) {
			const away = sc.scrollHeight - sc.scrollTop - sc.clientHeight;
			this.shown = count > 0 || away > Math.max(MIN_DISTANCE, sc.clientHeight);
		}
		this.count = count;
		this.paint();
	}

	/** Words shown instead of the count, the button always up (null: back to the rule). */
	setText(text: string | null): void {
		if (text === this.text) return;
		this.text = text;
		if (text === null) this.shown = false;
		this.paint();
	}

	/** A new chat (or conversation) is shown: nothing of the previous one's state. */
	reset(): void {
		this.endJump();
		this.shown = false;
		this.count = 0;
		this.text = null;
		this.paint();
	}

	private jump(): void {
		this.shown = false;
		this.count = 0;
		this.paint();
		if (this.opts.onJump?.()) {
			this.opts.onJumped();
			return;
		}
		const sc = this.opts.scroller();
		this.opts.onJumped();
		if (!sc) return;
		const top = sc.scrollHeight;
		if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
			// The capture Chat's scroller is `scroll-behavior: smooth` in CSS.
			const prev = sc.style.scrollBehavior;
			sc.style.scrollBehavior = "auto";
			sc.scrollTop = top;
			sc.style.scrollBehavior = prev;
			return;
		}
		this.jumpUntil = Date.now() + JUMP_MAX_MS;
		// The reader taking over (a wheel, a touch, a key) ends the jump's claim.
		this.jumpEl = sc;
		for (const t of STOP_EVENTS) sc.addEventListener(t, this.stop, { passive: true });
		sc.scrollTo({ top, behavior: "smooth" });
	}

	private readonly stop = (): void => this.endJump();

	private endJump(): void {
		this.jumpUntil = 0;
		if (this.jumpEl) for (const t of STOP_EVENTS) this.jumpEl.removeEventListener(t, this.stop);
		this.jumpEl = null;
	}

	private paint(): void {
		this.el.hidden = !this.shown;
		const words = this.text ?? (this.count > 99 ? "99+" : this.count > 0 ? String(this.count) : "");
		// The arrow alone: a 36-px circle (chat.css).
		this.el.classList.toggle("solo", words === "");
		if (this.countEl.textContent !== words) this.countEl.textContent = words;
		this.countEl.hidden = words === "";
		const name = this.text ?? this.opts.name(this.count);
		if (this.el.getAttribute("aria-label") !== name) this.el.setAttribute("aria-label", name);
	}
}

const STOP_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/**
 * The first row of `sc` at least partly in view, and its top edge's offset
 * from the scroller's; `isRow` says which children are rows (not a button or
 * a marker). Children are laid out top to bottom, so a binary search: a
 * reader deep in a long thread costs a handful of measurements per scroll,
 * not one per row above them.
 */
export function firstRowInView(
	sc: HTMLElement,
	isRow: (el: HTMLElement) => boolean,
): { row: HTMLElement; offset: number } | null {
	const kids = sc.children;
	const top = sc.getBoundingClientRect().top;
	let lo = 0;
	let hi = kids.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (kids[mid]!.getBoundingClientRect().bottom > top) hi = mid;
		else lo = mid + 1;
	}
	for (let i = lo; i < kids.length; i++) {
		const row = kids[i] as HTMLElement;
		if (isRow(row)) return { row, offset: row.getBoundingClientRect().top - top };
	}
	return null;
}

/** A down arrow (decorative: the button carries its name). */
function arrowIcon(): SVGElement {
	const ns = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(ns, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("focusable", "false");
	const path = document.createElementNS(ns, "path");
	path.setAttribute("d", "M12 5v13M6 12l6 6 6-6");
	svg.append(path);
	return svg;
}

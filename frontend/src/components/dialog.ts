/**
 * dialog.ts — the one way a modal opens and closes (UI unification, PR 2).
 *
 * Every modal in index.html (and the ones built at runtime) keeps its
 * `.modal > .modal-backdrop + .modal-card` markup and its CSS; what this
 * module centralises is the BEHAVIOUR those thirteen open/close pairs
 * each hand-rolled, and the parts they got wrong:
 *
 *   - a stack, so Escape and backdrop clicks dismiss the topmost dialog
 *     only (WAI-ARIA 1.2 §6.2) and closing a parent cascades to the
 *     dialogs above it (Observe over My groups, Members over Admin);
 *   - focus: moved inside on open, trapped there while open (Tab wraps,
 *     a focus landing outside is pulled back), returned to the opener
 *     on close — or to whatever had focus before when the opener is no
 *     longer visible (the desktop header button while on mobile);
 *   - `inert` on the application roots and on the dialogs underneath,
 *     so the covered UI leaves the accessibility tree and the pointer
 *     can't reach it. `inert` does not touch layout, which is what
 *     keeps the terminal invariant (viewSwitch.ts) intact;
 *   - `[data-close-modal]` (backdrop, ×, Cancel) wired once.
 *
 * Why not the native <dialog> element: showModal() would give the trap
 * and the backdrop for free, but it renders in the top layer — above the
 * toast and outside the z-index scale the mobile key bar and overlays
 * depend on — and jsdom (the test runner) does not implement it, so the
 * behaviour would be untestable where it matters most. The markup is
 * role="dialog" + aria-modal already; the semantics are the same.
 *
 * `confirmDialog` / `promptDialog` replace the native confirm()/prompt()
 * the app used for destructive actions: styled, accessible, and able to
 * ask for the session's name before an irreversible delete (§9.5).
 */

export interface DialogOptions {
	/**
	 * Runs after the dialog closed by ANY path — ×, backdrop, Escape,
	 * `close()`, or a parent closing underneath it. Module teardown
	 * (clearing a form, closing a WebSocket, dropping a session id)
	 * belongs here so no path can skip it.
	 */
	onClose?: () => void;
	/** Element to focus on open. Default: the first focusable control, else the card. */
	initialFocus?: () => HTMLElement | null | undefined;
	/** Escape closes the dialog. Default true. */
	closeOnEscape?: boolean;
}

export interface Dialog {
	readonly el: HTMLElement;
	/** Show the dialog. `opener` is where focus returns on close. No-op while open. */
	open(opener?: Element | null): void;
	/** Hide the dialog (and every dialog opened above it). No-op while closed. */
	close(): void;
	isOpen(): boolean;
}

interface Entry {
	dialog: DialogImpl;
	opener: HTMLElement | null;
	prevFocus: HTMLElement | null;
}

// ── Stack ───────────────────────────────────────────────────────────────────

const stack: Entry[] = [];

/** True while at least one dialog is open — app-level key handlers defer to it. */
export function isAnyDialogOpen(): boolean {
	return stack.length > 0;
}

/**
 * For other Escape handlers on `document`: true when this keypress is a
 * dialog's to handle — a dialog is open, or one was just closed by it
 * (the event arrives already consumed). Such a handler must then do
 * nothing, so one Escape never closes two layers.
 */
export function escapeHandledByDialog(e: KeyboardEvent): boolean {
	return e.defaultPrevented || stack.length > 0;
}

/** Close the topmost dialog. Returns false when none is open. */
export function closeTopDialog(): boolean {
	const top = stack[stack.length - 1];
	if (!top) return false;
	top.dialog.close();
	return true;
}

function top(): Entry | undefined {
	return stack[stack.length - 1];
}

// The application roots covered by any open dialog. Looked up lazily:
// the module may load before (or in tests, without) those elements.
function appRoots(): HTMLElement[] {
	return ["auth-view", "app-view"]
		.map((id) => document.getElementById(id))
		.filter((el): el is HTMLElement => el !== null);
}

function syncInert(): void {
	const covered = stack.length > 0;
	for (const root of appRoots()) root.toggleAttribute("inert", covered);
	// Dialogs under the topmost are covered too.
	for (let i = 0; i < stack.length; i++) {
		stack[i]!.dialog.el.toggleAttribute("inert", i !== stack.length - 1);
	}
}

// ── Focus helpers ───────────────────────────────────────────────────────────

const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Visible enough to receive focus. `checkVisibility` is the browser's
 * answer (display/visibility/content-visibility); jsdom has no layout and
 * no `checkVisibility`, so there the `hidden` attribute is the only
 * signal — which is exactly what the markup uses for hidden controls.
 */
function isVisible(el: HTMLElement): boolean {
	if (el.hidden || el.closest("[hidden]")) return false;
	if (typeof el.checkVisibility === "function") return el.checkVisibility();
	return true;
}

function focusables(scope: HTMLElement): HTMLElement[] {
	return [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(isVisible);
}

function focusInto(entry: Entry): void {
	const { dialog } = entry;
	const wanted = dialog.opts.initialFocus?.();
	const target = wanted && isVisible(wanted) ? wanted : (focusables(dialog.el)[0] ?? dialog.card());
	target.focus();
}

function restoreFocus(entry: Entry): void {
	for (const candidate of [entry.opener, entry.prevFocus]) {
		if (candidate?.isConnected && isVisible(candidate) && !candidate.closest("[inert]")) {
			candidate.focus();
			return;
		}
	}
}

// ── Document-level wiring (once) ────────────────────────────────────────────

document.addEventListener("keydown", (e) => {
	const t = top();
	if (!t) return;
	if (e.key === "Escape") {
		if (t.dialog.opts.closeOnEscape === false) return;
		// One Escape, one layer. The dialog is closed synchronously here,
		// so a later document listener (the mobile sidebar drawer in
		// main.ts) would find no dialog open and close ITS layer with the
		// same keypress. Two guards, so the order listeners were
		// registered in doesn't matter: the event is marked consumed
		// (preventDefault → escapeHandledByDialog()), and no later
		// listener on document runs for it at all.
		e.preventDefault();
		e.stopImmediatePropagation();
		t.dialog.close();
		return;
	}
	if (e.key === "Tab") {
		const items = focusables(t.dialog.el);
		if (items.length === 0) {
			e.preventDefault();
			t.dialog.card().focus();
			return;
		}
		const first = items[0]!;
		const last = items[items.length - 1]!;
		const active = document.activeElement;
		if (e.shiftKey && (active === first || !t.dialog.el.contains(active))) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && (active === last || !t.dialog.el.contains(active))) {
			e.preventDefault();
			first.focus();
		}
	}
});

// A focus that lands outside the topmost dialog (a click on the inert
// page in an engine that still focuses it, a programmatic focus by the
// view behind) is pulled back in.
document.addEventListener("focusin", (e) => {
	const t = top();
	if (!t) return;
	const target = e.target;
	if (target instanceof Node && t.dialog.el.contains(target)) return;
	focusInto(t);
});

// ── Dialog ──────────────────────────────────────────────────────────────────

class DialogImpl implements Dialog {
	readonly el: HTMLElement;
	readonly opts: DialogOptions;

	constructor(el: HTMLElement, opts: DialogOptions) {
		this.el = el;
		this.opts = opts;
		el.addEventListener("click", (e) => {
			const target = e.target;
			if (!(target instanceof Element)) return;
			if (target.closest("[data-close-modal]")) this.close();
		});
	}

	card(): HTMLElement {
		const card = this.el.querySelector<HTMLElement>(".modal-card") ?? this.el;
		if (!card.hasAttribute("tabindex")) card.tabIndex = -1;
		return card;
	}

	isOpen(): boolean {
		return stack.some((s) => s.dialog === this);
	}

	open(opener?: Element | null): void {
		if (this.isOpen()) return;
		const active = document.activeElement;
		const entry: Entry = {
			dialog: this,
			opener: opener instanceof HTMLElement ? opener : null,
			prevFocus: active instanceof HTMLElement && active !== document.body ? active : null,
		};
		stack.push(entry);
		this.el.classList.add("open");
		this.el.setAttribute("aria-hidden", "false");
		syncInert();
		focusInto(entry);
	}

	close(): void {
		const idx = stack.findIndex((s) => s.dialog === this);
		if (idx === -1) return;
		// Cascade: everything opened above this dialog goes first, each
		// through its own close so its onClose runs.
		while (stack.length - 1 > idx) stack[stack.length - 1]!.dialog.close();
		const entry = stack.pop()!;
		this.el.classList.remove("open");
		this.el.setAttribute("aria-hidden", "true");
		this.el.removeAttribute("inert");
		syncInert();
		const next = top();
		if (next) {
			// Back to the control inside the parent dialog that opened this
			// one (the row's Observe button, "+ New group"), not the parent's
			// first control.
			const opener = entry.opener;
			if (opener && next.dialog.el.contains(opener) && isVisible(opener)) opener.focus();
			else focusInto(next);
		} else {
			restoreFocus(entry);
		}
		this.opts.onClose?.();
	}
}

/** Wrap an existing `.modal` element. Call once per element, at module load. */
export function createDialog(el: HTMLElement, opts: DialogOptions = {}): Dialog {
	return new DialogImpl(el, opts);
}

// ── confirm / prompt ────────────────────────────────────────────────────────

export interface ConfirmOptions {
	title: string;
	/** Body text; blank lines separate paragraphs. */
	message?: string;
	confirmLabel?: string;
	cancelLabel?: string;
	/** Red confirm button; focus starts on Cancel so Enter can't confirm by accident. */
	danger?: boolean;
	/**
	 * Irreversible actions: the confirm button stays disabled until the
	 * person types `expected` exactly (trimmed). The label explains what
	 * to type.
	 */
	requireText?: { expected: string; label?: string };
}

export interface PromptOptions {
	title: string;
	message?: string;
	label?: string;
	placeholder?: string;
	initialValue?: string;
	confirmLabel?: string;
	cancelLabel?: string;
	/** Returns an error message to show inline, or null when the value is acceptable. */
	validate?: (value: string) => string | null;
}

let dialogSeq = 0;

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function paragraphs(message: string | undefined): HTMLElement[] {
	if (!message) return [];
	return message
		.split(/\n\s*\n/)
		.map((p) => p.trim())
		.filter(Boolean)
		.map((p) => el("p", "modal-hint", p));
}

interface Built {
	root: HTMLElement;
	form: HTMLFormElement;
	body: HTMLElement;
	actions: HTMLElement;
	confirmBtn: HTMLButtonElement;
	cancelBtn: HTMLButtonElement;
}

function buildCard(
	title: string,
	message: string | undefined,
	confirmLabel: string,
	cancelLabel: string | null,
	danger: boolean,
): Built {
	const id = `dialog-${++dialogSeq}`;
	const root = el("div", "modal");
	root.setAttribute("aria-hidden", "true");
	const backdrop = el("div", "modal-backdrop");
	backdrop.setAttribute("data-close-modal", "");
	root.appendChild(backdrop);
	const card = el("div", "modal-card dialog-card");
	card.setAttribute("role", danger ? "alertdialog" : "dialog");
	card.setAttribute("aria-modal", "true");
	card.setAttribute("aria-labelledby", `${id}-title`);
	const header = el("div", "modal-header");
	const h2 = el("h2", undefined, title);
	h2.id = `${id}-title`;
	header.appendChild(h2);
	const closeBtn = el("button", "modal-close", "×");
	closeBtn.type = "button";
	closeBtn.setAttribute("aria-label", "Close");
	closeBtn.setAttribute("data-close-modal", "");
	header.appendChild(closeBtn);
	card.appendChild(header);
	const form = el("form", "dialog-form");
	form.noValidate = true;
	const body = el("div", "dialog-body");
	for (const p of paragraphs(message)) body.appendChild(p);
	form.appendChild(body);
	const actions = el("div", "modal-actions");
	const cancelBtn = el("button", "dialog-cancel", cancelLabel ?? "Cancel");
	cancelBtn.type = "button";
	cancelBtn.setAttribute("data-close-modal", "");
	const confirmBtn = el(
		"button",
		danger ? "modal-danger-action" : "modal-primary-action",
		confirmLabel,
	);
	confirmBtn.type = "submit";
	if (cancelLabel !== null) actions.appendChild(cancelBtn);
	actions.appendChild(confirmBtn);
	form.appendChild(actions);
	card.appendChild(form);
	root.appendChild(card);
	return { root, form, body, actions, confirmBtn, cancelBtn };
}

/**
 * Ask for confirmation. Resolves true only when the person activates the
 * confirm button; every other path (Cancel, ×, backdrop, Escape) is false.
 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
	return new Promise((resolve) => {
		const danger = opts.danger === true || opts.requireText !== undefined;
		const b = buildCard(
			opts.title,
			opts.message,
			opts.confirmLabel ?? "Confirm",
			opts.cancelLabel ?? "Cancel",
			danger,
		);
		let input: HTMLInputElement | null = null;
		if (opts.requireText) {
			const { expected, label } = opts.requireText;
			const field = el("label", "modal-field dialog-require");
			field.appendChild(el("span", undefined, label ?? `Type "${expected}" to confirm`));
			input = el("input");
			input.type = "text";
			input.autocomplete = "off";
			input.spellcheck = false;
			field.appendChild(input);
			b.body.appendChild(field);
			b.confirmBtn.disabled = true;
			input.addEventListener("input", () => {
				b.confirmBtn.disabled = input!.value.trim() !== expected;
			});
		}
		let confirmed = false;
		b.form.addEventListener("submit", (e) => {
			e.preventDefault();
			if (b.confirmBtn.disabled) return;
			confirmed = true;
			dialog.close();
		});
		document.body.appendChild(b.root);
		const dialog = createDialog(b.root, {
			initialFocus: () => input ?? (danger ? b.cancelBtn : b.confirmBtn),
			onClose: () => {
				b.root.remove();
				resolve(confirmed);
			},
		});
		dialog.open(document.activeElement);
	});
}

/**
 * Ask for a line of text. Resolves the (trimmed) value on confirm, null on
 * any dismissal.
 */
export function promptDialog(opts: PromptOptions): Promise<string | null> {
	return new Promise((resolve) => {
		const b = buildCard(
			opts.title,
			opts.message,
			opts.confirmLabel ?? "OK",
			opts.cancelLabel ?? "Cancel",
			false,
		);
		const field = el("label", "modal-field");
		if (opts.label) field.appendChild(el("span", undefined, opts.label));
		const input = el("input");
		input.type = "text";
		input.autocomplete = "off";
		input.spellcheck = false;
		if (opts.placeholder) input.placeholder = opts.placeholder;
		input.value = opts.initialValue ?? "";
		field.appendChild(input);
		const error = el("p", "modal-field-error");
		error.setAttribute("role", "alert");
		error.hidden = true;
		b.body.append(field, error);
		let result: string | null = null;
		b.form.addEventListener("submit", (e) => {
			e.preventDefault();
			const value = input.value.trim();
			const problem = opts.validate?.(value) ?? null;
			if (problem !== null) {
				error.textContent = problem;
				error.hidden = false;
				input.focus();
				return;
			}
			result = value;
			dialog.close();
		});
		input.addEventListener("input", () => {
			error.hidden = true;
		});
		document.body.appendChild(b.root);
		const dialog = createDialog(b.root, {
			initialFocus: () => input,
			onClose: () => {
				b.root.remove();
				resolve(result);
			},
		});
		dialog.open(document.activeElement);
		input.select();
	});
}

export interface AlertOptions {
	title: string;
	message: string;
	okLabel?: string;
}

/**
 * Show something the person must acknowledge (the one-time invite code
 * when the clipboard is unavailable). Resolves when dismissed by any path.
 */
export function alertDialog(opts: AlertOptions): Promise<void> {
	return new Promise((resolve) => {
		const b = buildCard(opts.title, opts.message, opts.okLabel ?? "OK", null, false);
		b.form.addEventListener("submit", (e) => {
			e.preventDefault();
			dialog.close();
		});
		document.body.appendChild(b.root);
		const dialog = createDialog(b.root, {
			initialFocus: () => b.confirmBtn,
			onClose: () => {
				b.root.remove();
				resolve();
			},
		});
		dialog.open(document.activeElement);
	});
}

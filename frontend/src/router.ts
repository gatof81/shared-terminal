/**
 * router.ts — the URL as the app's address (UI unification, PR 5; design
 * §5.4). Leaf module: no app imports, so main.ts, sessionCore.ts,
 * viewSwitch.ts and the views can all use it without a cycle.
 *
 *   #/sessions/<id>                       the session (short form, #419)
 *   #/sessions/<id>/<view>                view ∈ terminal | files | git | chat
 *   #/sessions/<id>/<view>/<detail>       what the view shows:
 *                                         files → a path, git → <area>:<path>,
 *                                         chat → a conversation id,
 *                                         terminal → a tab id
 *
 * Two kinds of writes, both through history and NEITHER fires
 * `hashchange` (so the app can't loop on its own writes):
 *   - replace: selecting a session, a forced landing, a tab switch — the
 *     address keeps up without turning Back into a carousel;
 *   - push: a view the person chose, a file / diff / conversation they
 *     opened — Back and the mobile back gesture undo exactly that.
 *
 * Reads arrive from `popstate` (Back / Forward) and `hashchange` (a URL
 * pasted into the bar); both parse the hash and the app applies the
 * difference. A route equal to the one last written or applied is
 * ignored, which is how the `hashchange` that follows a Back on a
 * pushed hash does not apply the same route twice.
 *
 * `#session=<id>` (the service worker's one-shot notification jump) is a
 * different shape and is not this module's: it parses to null here.
 */

export type RouteView = "terminal" | "files" | "git" | "chat";
export const ROUTE_VIEWS: readonly RouteView[] = ["terminal", "files", "git", "chat"];

export interface Route {
	sessionId: string;
	view: RouteView | null;
	/** View-specific; null when the view shows nothing in particular. */
	detail: string | null;
}

function isView(s: string): s is RouteView {
	return (ROUTE_VIEWS as readonly string[]).includes(s);
}

function decode(s: string): string | null {
	try {
		return decodeURIComponent(s);
	} catch {
		// Malformed percent-encoding (`%` alone, `%zz`): no route rather
		// than a throw during app init.
		return null;
	}
}

/** Parse a hash. Null for an absent, foreign or malformed one. */
export function parseRoute(hash: string): Route | null {
	const m = /^#\/sessions\/([^/?#]+)(?:\/([^/?#]+)(?:\/(.+))?)?$/.exec(hash);
	if (!m) return null;
	const sessionId = decode(m[1]!);
	if (sessionId === null || sessionId === "") return null;
	if (m[2] === undefined) return { sessionId, view: null, detail: null };
	if (!isView(m[2])) return null;
	if (m[3] === undefined) return { sessionId, view: m[2], detail: null };
	// The detail keeps its own slashes (a file path reads naturally); each
	// segment is decoded on its own so an encoded "/" inside a segment
	// survives as a literal.
	const parts = m[3].split("/").map(decode);
	if (parts.some((p) => p === null)) return null;
	const detail = (parts as string[]).join("/");
	return { sessionId, view: m[2], detail: detail === "" ? null : detail };
}

/** The hash for a route (always with a leading `#`). */
export function routeHash(route: Route): string {
	let h = `#/sessions/${encodeURIComponent(route.sessionId)}`;
	if (route.view === null) return h;
	h += `/${route.view}`;
	if (route.detail === null || route.detail === "") return h;
	h += `/${route.detail
		.split("/")
		// ":" stays readable (git's "<area>:<path>" detail); it is not a
		// delimiter in a fragment and the parser decodes segments anyway.
		.map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ":"))
		.join("/")}`;
	return h;
}

export function sameRoute(a: Route | null, b: Route | null): boolean {
	if (a === null || b === null) return a === b;
	return (
		a.sessionId === b.sessionId && a.view === b.view && (a.detail ?? null) === (b.detail ?? null)
	);
}

/** What the address bar says right now. */
export function readRoute(): Route | null {
	return parseRoute(window.location.hash);
}

// ── History ─────────────────────────────────────────────────────────────────

interface OurState {
	st: { n: number };
}

function isOurs(state: unknown): state is OurState {
	return (
		typeof state === "object" &&
		state !== null &&
		"st" in state &&
		typeof (state as OurState).st?.n === "number"
	);
}

/** Entries THIS page pushed since it loaded, as stored on the current entry. */
export function depth(): number {
	return isOurs(history.state) ? history.state.st.n : 0;
}

/** The route last written or applied — what the app currently shows. */
let current: Route | null = null;

export function currentRoute(): Route | null {
	return current;
}

function bare(): string {
	return window.location.pathname + window.location.search;
}

/**
 * Write `route` to the address bar. `replace` keeps the current history
 * entry; otherwise a new one is pushed (Back returns to the previous
 * route). A write of the route already shown is a no-op.
 */
export function navigate(route: Route | null, opts: { replace?: boolean } = {}): void {
	const hash = route === null ? "" : routeHash(route);
	const already = window.location.hash === hash || (route === null && !readRoute());
	current = route;
	if (already) return;
	const url = bare() + hash;
	if (opts.replace) {
		history.replaceState({ st: { n: depth() } }, "", url);
	} else {
		history.pushState({ st: { n: depth() + 1 } }, "", url);
	}
}

/**
 * Clear a session route (the selection dropped). A hash of another shape
 * (`#session=` from the service worker) is not ours to clobber.
 */
export function clear(): void {
	current = null;
	if (readRoute() === null) return;
	history.replaceState({ st: { n: depth() } }, "", bare());
}

// ── Reads ───────────────────────────────────────────────────────────────────

export type RouteSource = "load" | "popstate" | "hashchange";
type Listener = (route: Route | null, source: RouteSource) => void;
const listeners: Listener[] = [];

export function onRoute(listener: Listener): void {
	listeners.push(listener);
}

function emit(source: RouteSource): void {
	const route = readRoute();
	// Our own writes (navigate) set `current` first; a Back/Forward lands
	// on an entry we wrote earlier and must be applied even though its
	// shape is known. Only an unchanged route is skipped.
	if (sameRoute(route, current)) return;
	current = route;
	for (const l of listeners) l(route, source);
}

let wired = false;
/** Start listening to Back/Forward and address-bar edits (once). */
export function start(): void {
	if (wired) return;
	wired = true;
	window.addEventListener("popstate", () => emit("popstate"));
	window.addEventListener("hashchange", () => emit("hashchange"));
}

/** Test seam. */
export function resetForTests(): void {
	current = null;
	listeners.length = 0;
}

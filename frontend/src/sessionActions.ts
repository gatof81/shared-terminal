/**
 * sessionActions.ts — the one list of things a person can do to a session,
 * and whether they can do them right now (UI unification, PR 4).
 *
 * Pure and DOM-free: given a session, who is looking at it and how the
 * terminal is attached, it answers the ordered list of actions with an
 * `enabled` flag and, when disabled, the reason in words. Every surface
 * (sidebar rows and their ⋯ menu, the terminal's empty / stopped /
 * disconnected states, the Git view's "start" hint) renders from this
 * list, so a control is never drawn without a function behind it and the
 * same verb reads the same everywhere.
 *
 * Permissions mirror the backend's gates and never widen them: the
 * server still decides on every request. owner / admin → start, attach
 * (assertCanOperate); owner only → stop, terminate, delete (the owner and
 * the idle sweeper own teardown); owner / admin → ports edit; owner /
 * admin / lead → observers (assertCanObserve); owner → bootstrap log and
 * the file surfaces.
 */

export type SessionStatus = "running" | "stopped" | "terminated" | "failed";

export type SessionActionId =
	| "open"
	| "start"
	| "restore"
	| "stop"
	| "newTab"
	| "reconnect"
	| "viewLog"
	| "ports"
	| "observers"
	| "terminate"
	| "delete";

export interface SessionActionContext {
	session: { sessionId: string; name: string; status: SessionStatus };
	isOwner: boolean;
	isAdmin: boolean;
	isLead: boolean;
	/** Terminal attachment, when the session is the active one. */
	connection?: "none" | "attached" | "disconnected";
	/** Number of tmux tabs, when known. */
	tabs?: number | null;
}

export interface SessionAction {
	id: SessionActionId;
	label: string;
	/** Short explanation for menus and the state panels. */
	hint?: string;
	/** `danger` renders red and confirms; `primary` is the one obvious next step. */
	kind: "primary" | "normal" | "danger";
	enabled: boolean;
	/** Why it is disabled, in words (never only a tooltip). */
	reason?: string;
}

const no = (reason: string) => ({ enabled: false as const, reason });
const yes = { enabled: true as const };

function gate(
	ctx: SessionActionContext,
	id: SessionActionId,
): { enabled: boolean; reason?: string } {
	const { session: s, isOwner, isAdmin, isLead } = ctx;
	const operate = isOwner || isAdmin;
	switch (id) {
		case "open":
			return s.status === "failed" ? no("A failed session has no workspace to open.") : yes;
		case "start":
			if (!operate) return no("Only the owner or an admin can start this session.");
			if (s.status === "running") return no("The session is already running.");
			if (s.status === "failed") return no("A failed session cannot be started; create a new one.");
			if (s.status === "terminated") return no("A terminated session is restored, not started.");
			return yes;
		case "restore":
			if (!operate) return no("Only the owner or an admin can restore this session.");
			if (s.status !== "terminated") return no("Only a terminated session can be restored.");
			return yes;
		case "stop":
			if (!isOwner) return no("Only the owner can stop this session.");
			if (s.status !== "running") return no("The session is not running.");
			return yes;
		case "newTab":
			if (!operate) return no("Only the owner or an admin can open a tab.");
			if (s.status !== "running") return no("Start the session to open a tab.");
			return yes;
		case "reconnect":
			if (!operate) return no("Only the owner or an admin can attach to this session.");
			if (s.status !== "running") return no("The session is not running.");
			if (ctx.connection !== "disconnected") return no("The terminal is connected.");
			return yes;
		case "viewLog":
			if (!isOwner) return no("Only the owner can read the bootstrap log.");
			return yes;
		case "ports":
			if (!operate) return no("Only the owner or an admin can edit exposed ports.");
			return yes;
		case "observers":
			if (!(isOwner || isAdmin || isLead))
				return no("Not authorised to see who observed this session.");
			return yes;
		case "terminate":
			if (!isOwner) return no("Only the owner can terminate this session.");
			if (s.status === "terminated") return no("The session is already terminated.");
			if (s.status === "failed") return no("A failed session is deleted, not terminated.");
			return yes;
		case "delete":
			if (!isOwner) return no("Only the owner can delete this session.");
			return yes;
	}
}

/** One action's availability. */
export function canDo(
	ctx: SessionActionContext,
	id: SessionActionId,
): { enabled: boolean; reason?: string } {
	return gate(ctx, id);
}

const LABELS: Record<
	SessionActionId,
	{ label: string; hint: string; kind: SessionAction["kind"] }
> = {
	open: { label: "Open", hint: "Show this session", kind: "normal" },
	start: {
		label: "Start session",
		hint: "Start the container; the workspace is kept",
		kind: "primary",
	},
	restore: {
		label: "Restore session",
		hint: "Respawn the container with the existing workspace files",
		kind: "primary",
	},
	stop: { label: "Stop session", hint: "Stop the container; files are kept", kind: "normal" },
	newTab: { label: "Open a tab", hint: "A new tmux window in this session", kind: "primary" },
	reconnect: { label: "Reconnect", hint: "Attach the terminal again", kind: "primary" },
	viewLog: {
		label: "View bootstrap log",
		hint: "The captured output of the last bootstrap",
		kind: "normal",
	},
	ports: { label: "Exposed ports…", hint: "Edit the ports reachable from outside", kind: "normal" },
	observers: {
		label: "Observers…",
		hint: "Who has watched or driven this session",
		kind: "normal",
	},
	terminate: {
		label: "Terminate session",
		hint: "Stop and remove the container; the workspace is kept and the session can be restored",
		kind: "danger",
	},
	delete: {
		label: "Delete permanently",
		hint: "Remove the container, the workspace files and the session record",
		kind: "danger",
	},
};

/** The full menu for a session, in display order. */
export function sessionActions(ctx: SessionActionContext): SessionAction[] {
	const s = ctx.session;
	const order: SessionActionId[] = [];
	if (s.status === "running") order.push("stop");
	if (s.status === "stopped") order.push("start");
	if (s.status === "terminated") order.push("restore");
	if (s.status === "failed") order.push("viewLog");
	if (s.status !== "failed") order.push("ports", "observers");
	if (s.status !== "terminated" && s.status !== "failed") order.push("terminate");
	order.push("delete");
	return order.map((id) => ({ id, ...LABELS[id], ...gate(ctx, id) }));
}

/**
 * What the terminal area offers when it has nothing to show: the state
 * (one line) and the actions that make sense from it.
 */
export function terminalState(ctx: SessionActionContext): {
	title: string;
	detail: string;
	actions: SessionAction[];
} | null {
	const s = ctx.session;
	const pick = (...ids: SessionActionId[]) =>
		ids.map((id) => ({ id, ...LABELS[id], ...gate(ctx, id) }));
	switch (s.status) {
		case "failed":
			return {
				title: "Bootstrap failed",
				detail: "The container was removed. The captured output explains why.",
				actions: pick("viewLog", "delete"),
			};
		case "stopped":
			return {
				title: "This session is stopped",
				detail: "Files stay available. Start it to use the terminal, Git and Chat.",
				actions: pick("start"),
			};
		case "terminated":
			return {
				title: "This session was terminated",
				detail: "Workspace files are kept. Restore it to get a fresh container on them.",
				actions: pick("restore", "delete"),
			};
		case "running":
			if (ctx.connection === "disconnected") {
				return {
					title: "Connection lost",
					detail: "The terminal could not reach this tab any more. The session itself is running.",
					actions: pick("reconnect"),
				};
			}
			if (ctx.tabs === 0) {
				return {
					title: "No tabs yet",
					detail: "A tab is a tmux window with its own shell.",
					actions: pick("newTab"),
				};
			}
			return null;
	}
}

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
			return s.status === "failed" ? no("Una sesión que falló no tiene archivos para abrir.") : yes;
		case "start":
			if (!operate) return no("Solo el dueño o un admin puede ponerla en marcha.");
			if (s.status === "running") return no("La sesión ya está en marcha.");
			if (s.status === "failed")
				return no("Una sesión que falló no se puede poner en marcha; creá una nueva.");
			if (s.status === "terminated")
				return no("Una sesión terminada se restaura, no se pone en marcha.");
			return yes;
		case "restore":
			if (!operate) return no("Solo el dueño o un admin puede restaurarla.");
			if (s.status !== "terminated") return no("Solo se puede restaurar una sesión terminada.");
			return yes;
		case "stop":
			if (!isOwner) return no("Solo el dueño puede detenerla.");
			if (s.status !== "running") return no("La sesión no está en marcha.");
			return yes;
		case "newTab":
			if (!operate) return no("Solo el dueño o un admin puede abrir una pestaña.");
			if (s.status !== "running") return no("Poné en marcha la sesión para abrir una pestaña.");
			return yes;
		case "reconnect":
			if (!operate) return no("Solo el dueño o un admin puede conectarse a esta sesión.");
			if (s.status !== "running") return no("La sesión no está en marcha.");
			if (ctx.connection !== "disconnected") return no("La terminal está conectada.");
			return yes;
		case "viewLog":
			if (!isOwner) return no("Solo el dueño puede leer el registro del bootstrap.");
			return yes;
		case "ports":
			if (!operate) return no("Solo el dueño o un admin puede editar los puertos expuestos.");
			return yes;
		case "observers":
			if (!(isOwner || isAdmin || isLead))
				return no("No tenés permiso para ver quién observó esta sesión.");
			return yes;
		case "terminate":
			if (!isOwner) return no("Solo el dueño puede terminarla.");
			if (s.status === "terminated") return no("La sesión ya está terminada.");
			if (s.status === "failed") return no("Una sesión que falló se elimina, no se termina.");
			return yes;
		case "delete":
			if (!isOwner) return no("Solo el dueño puede eliminarla.");
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
	open: { label: "Abrir", hint: "Mostrar esta sesión", kind: "normal" },
	start: {
		label: "Poner en marcha",
		hint: "Arranca el contenedor; los archivos del workspace se conservan",
		kind: "primary",
	},
	restore: {
		label: "Restaurar",
		hint: "Crea un contenedor nuevo sobre los archivos del workspace que quedaron",
		kind: "primary",
	},
	stop: {
		label: "Detener",
		hint: "Detiene el contenedor; los archivos se conservan",
		kind: "normal",
	},
	newTab: {
		label: "Abrir una pestaña",
		hint: "Una ventana nueva de tmux en esta sesión",
		kind: "primary",
	},
	reconnect: {
		label: "Reconectar",
		hint: "Volver a conectar la terminal",
		kind: "primary",
	},
	viewLog: {
		label: "Ver el registro del bootstrap",
		hint: "La salida capturada del último bootstrap",
		kind: "normal",
	},
	ports: {
		label: "Puertos expuestos…",
		hint: "Editar los puertos accesibles desde afuera",
		kind: "normal",
	},
	observers: {
		label: "Observadores…",
		hint: "Quién miró o manejó esta sesión",
		kind: "normal",
	},
	terminate: {
		label: "Terminar",
		hint: "Detiene y elimina el contenedor; los archivos del workspace se conservan y la sesión se puede restaurar",
		kind: "danger",
	},
	delete: {
		label: "Eliminar definitivamente",
		hint: "Elimina el contenedor, los archivos del workspace y los datos de la sesión",
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
				title: "Falló el bootstrap",
				detail: "El contenedor se eliminó. La salida capturada explica por qué.",
				actions: pick("viewLog", "delete"),
			};
		case "stopped":
			return {
				title: "Esta sesión está detenida",
				detail:
					"Files y el historial del Chat siguen disponibles. Ponela en marcha para usar la terminal y Git.",
				actions: pick("start"),
			};
		case "terminated":
			return {
				title: "Esta sesión está terminada",
				detail:
					"Los archivos del workspace se conservan. Restaurala para tener un contenedor nuevo sobre ellos.",
				actions: pick("restore", "delete"),
			};
		case "running":
			if (ctx.connection === "disconnected") {
				return {
					title: "Se perdió la conexión",
					detail: "La terminal ya no llega a esta pestaña. La sesión sigue en marcha.",
					actions: pick("reconnect"),
				};
			}
			if (ctx.tabs === 0) {
				return {
					title: "Todavía no hay pestañas",
					detail: "Una pestaña es una ventana de tmux con su propia shell.",
					actions: pick("newTab"),
				};
			}
			return null;
	}
}

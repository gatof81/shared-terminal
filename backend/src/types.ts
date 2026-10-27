/**
 * types.ts — Domain types and WebSocket protocol messages.
 */

// ── Session ─────────────────────────────────────────────────────────────────

// `failed` (#185) is set when a postCreate hook exits non-zero. The row
// stays so operators can audit, but the container is killed and the
// session can't be /start-ed (the runner refuses to retry — the user
// has to recreate). `terminated` is hard-delete; `stopped` is the
// normal "container off, will respawn on /start" state.
export type SessionStatus = "running" | "stopped" | "terminated" | "failed";

export interface SessionMeta {
	sessionId: string;
	userId: string;
	name: string;
	status: SessionStatus;
	containerId: string | null;
	containerName: string;
	createdAt: Date;
	lastConnectedAt: Date | null;
	cols: number;
	rows: number;
	/** Per-session environment variables (key=value pairs). */
	envVars: Record<string, string>;
	/** #418 — opaque client-provided reference (e.g. an external system's
	 *  project id). Never interpreted by the backend; null = unset. */
	externalRef: string | null;
}

export interface CreateSessionOpts {
	userId: string;
	name: string;
	cols?: number;
	rows?: number;
	envVars?: Record<string, string>;
	/** #202 — per-user override of the active-session cap folded into the
	 *  atomic INSERT guard. Omitted → the deployment-wide
	 *  MAX_ACTIVE_SESSIONS_PER_USER. The route resolves it from the
	 *  users row so the manager stays ignorant of quota policy. */
	maxActiveSessions?: number;
	/** #418 — opaque external reference; omitted → NULL. */
	externalRef?: string;
	/** 3.0d — caller-chosen id (a v4 UUID), so `POST /sessions` can take
	 *  the session's lifecycle lock BEFORE the row exists. Omitted → a
	 *  fresh v4 UUID. */
	sessionId?: string;
	/** 3.0d — born with `conversation_requested = 1` (`CONVERSATION_ALLOW_USERS`,
	 *  CONVERSATION.md §7). Omitted → 0. Set in the INSERT itself: the spawn
	 *  that follows reads it to decide the container's capture. */
	conversationRequested?: boolean;
}

// ── Auth ────────────────────────────────────────────────────────────────────

export interface UserRecord {
	id: string;
	username: string;
	passwordHash: string;
	createdAt: Date;
}

export interface JwtPayload {
	sub: string; // userId
	username: string;
	iat?: number;
	exp?: number;
}

// ── WebSocket client → server messages ──────────────────────────────────────

export interface WsInputMessage {
	type: "input";
	data: string;
}

export interface WsResizeMessage {
	type: "resize";
	cols: number;
	rows: number;
}

// Liveness is now bidirectional protocol-level ws.ping/pong (#79); no
// app-layer ping message required. The control frames travel below the
// JSON message layer, so message-shape unions stay clean.
export type WsClientMessage = WsInputMessage | WsResizeMessage;

// ── WebSocket server → client messages ──────────────────────────────────────

export interface WsOutputMessage {
	type: "output";
	data: string;
}

export interface WsErrorMessage {
	type: "error";
	message: string;
}

export interface WsStatusMessage {
	type: "status";
	status: SessionStatus;
}

export type WsServerMessage = WsOutputMessage | WsErrorMessage | WsStatusMessage;

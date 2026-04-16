/**
 * types.ts — Domain types and WebSocket protocol messages.
 */

// ── Session ─────────────────────────────────────────────────────────────────

export type SessionStatus = "running" | "stopped" | "terminated";

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
}

export interface CreateSessionOpts {
        userId: string;
        name: string;
        cols?: number;
        rows?: number;
        envVars?: Record<string, string>;
}

// ── Auth ────────────────────────────────────────────────────────────────────

export interface UserRecord {
        id: string;
        username: string;
        passwordHash: string;
        createdAt: Date;
}

export interface JwtPayload {
        sub: string;        // userId
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

export interface WsPingMessage {
        type: "ping";
}

export type WsClientMessage = WsInputMessage | WsResizeMessage | WsPingMessage;

// ── WebSocket server → client messages ──────────────────────────────────────

export interface WsOutputMessage {
        type: "output";
        data: string;
}

export interface WsPongMessage {
        type: "pong";
}

export interface WsErrorMessage {
        type: "error";
        message: string;
}

export interface WsStatusMessage {
        type: "status";
        status: SessionStatus;
}

export type WsServerMessage =
        | WsOutputMessage
        | WsPongMessage
        | WsErrorMessage
        | WsStatusMessage;

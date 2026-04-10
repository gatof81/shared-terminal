// ─── Domain types ─────────────────────────────────────────────────────────────

export type SessionStatus = "running" | "disconnected" | "terminated";

export interface SessionMeta {
        sessionId: string;
        userId: string;
        name: string;
        status: SessionStatus;
        createdAt: Date;
        lastConnectedAt: Date | null;
        cols: number;
        rows: number;
        pid: number | null;
        shell: string;
        cwd: string;
}

// ─── WebSocket message shapes (client → server) ───────────────────────────────

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

// ─── WebSocket message shapes (server → client) ───────────────────────────────

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

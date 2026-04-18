/**
 * auth.ts — JWT authentication + user management (D1-backed).
 */

import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { d1Query } from "./db.js";
import { JwtPayload } from "./types.js";

const JWT_SECRET = process.env.JWT_SECRET ?? "change-me-in-production";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? "7d";
const BCRYPT_ROUNDS = 10;

export interface AuthedRequest extends Request {
        userId: string;
        username: string;
}

// ── User management ─────────────────────────────────────────────────────────

export async function registerUser(username: string, password: string): Promise<{ userId: string; token: string }> {
        const existing = await d1Query<{ id: string }>("SELECT id FROM users WHERE username = ?", [username]);
        if (existing.results.length > 0) {
                throw new Error("Username already taken");
        }

        const userId = uuidv4();
        const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);

        await d1Query("INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)", [
                userId,
                username,
                passwordHash,
        ]);

        const token = signToken(userId, username);
        return { userId, token };
}

export async function loginUser(username: string, password: string): Promise<{ userId: string; token: string }> {
        const result = await d1Query<{ id: string; password_hash: string }>(
                "SELECT id, password_hash FROM users WHERE username = ?",
                [username],
        );

        const row = result.results[0];
        if (!row || !bcrypt.compareSync(password, row.password_hash)) {
                throw new Error("Invalid credentials");
        }

        const token = signToken(row.id, username);
        return { userId: row.id, token };
}

function signToken(userId: string, username: string): string {
        const payload: JwtPayload = { sub: userId, username };
        return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN as any });
}

// ── Express middleware ──────────────────────────────────────────────────────

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
        const header = req.headers.authorization;
        if (!header?.startsWith("Bearer ")) {
                res.status(401).json({ error: "Missing or invalid Authorization header" });
                return;
        }

        const token = header.slice(7);
        try {
                const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
                (req as AuthedRequest).userId = payload.sub;
                (req as AuthedRequest).username = payload.username;
                next();
        } catch {
                res.status(401).json({ error: "Invalid or expired token" });
        }
}

// ── WebSocket auth ──────────────────────────────────────────────────────────

const WS_AUTH_PROTOCOL_PREFIX = "auth.bearer.";

/**
 * Extract the bearer token from the Sec-WebSocket-Protocol header and verify it.
 * The header is a comma-separated list of subprotocols; the client should
 * include `auth.bearer.<jwt>`.
 */
export function verifyWsToken(protocolHeader: string | string[] | undefined): JwtPayload | null {
        if (!protocolHeader) return null;
        const header = Array.isArray(protocolHeader) ? protocolHeader.join(",") : protocolHeader;
        const protocols = header.split(",").map((s) => s.trim());
        const authProto = protocols.find((p) => p.startsWith(WS_AUTH_PROTOCOL_PREFIX));
        if (!authProto) return null;
        const token = authProto.slice(WS_AUTH_PROTOCOL_PREFIX.length);
        if (!token) return null;
        try {
                const parsed = new URL(url, "http://localhost");
                const token = parsed.searchParams.get("token");
                if (!token) {
                        console.error("[verifyWsToken] no token in query string");
                        return null;
                }
                return jwt.verify(token, JWT_SECRET) as JwtPayload;
        } catch (err) {
                console.error("[verifyWsToken]", (err as Error).name, (err as Error).message);
                return null;
        }
}

/**
 * Pick the `auth.bearer.<jwt>` subprotocol from an offered set so the server
 * can echo it back in the handshake response (required by RFC 6455).
 */
export function selectWsAuthProtocol(protocols: Set<string>): string | false {
        for (const p of protocols) {
                if (p.startsWith(WS_AUTH_PROTOCOL_PREFIX)) return p;
        }
        return false;
}

export async function hasAnyUsers(): Promise<boolean> {
        const result = await d1Query<{ count: number }>("SELECT COUNT(*) as count FROM users");
        return result.results[0].count > 0;
}

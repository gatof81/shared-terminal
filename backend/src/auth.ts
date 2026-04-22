/**
 * auth.ts — JWT authentication + user management (D1-backed).
 */

import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { d1Query } from "./db.js";
import { JwtPayload } from "./types.js";

// Dev fallback. Production deployments must supply JWT_SECRET — validateJwtSecret()
// below refuses to start the server if this literal is still in use.
const INSECURE_DEFAULT_JWT_SECRET = "change-me-in-production";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? "7d";
const BCRYPT_ROUNDS = 10;

// Populated by validateJwtSecret() at startup, then read by signing and
// verification helpers. Captured once so env mutations after startup
// cannot silently change the key used to sign/verify tokens.
let capturedJwtSecret: string | null = null;

function jwtSecret(): string {
        if (capturedJwtSecret === null) {
                throw new Error(
                        "jwtSecret() called before validateJwtSecret(). " +
                        "validateJwtSecret() must run at server startup before any JWT sign/verify.",
                );
        }
        return capturedJwtSecret;
}

// Call at server startup. In production (NODE_ENV === "production") throws if
// JWT_SECRET is missing or still the insecure default, so a misconfigured
// deploy (e.g. .env missing) exits loudly instead of booting with a
// publicly-known signing key. In other environments, logs a warning when the
// default is in use so the footgun stays visible during dev. On success,
// captures the secret into module state so jwtSecret() returns a value
// frozen at validation time rather than re-reading process.env.
export function validateJwtSecret(): void {
        const raw = process.env.JWT_SECRET;
        const missing = !raw;
        const usingPlaceholder = raw === INSECURE_DEFAULT_JWT_SECRET;
        if (process.env.NODE_ENV === "production" && (missing || usingPlaceholder)) {
                throw new Error(
                        "JWT_SECRET must be set to a non-default value in production. " +
                        "Refusing to start with the insecure placeholder — anyone would be able to forge JWTs.",
                );
        }
        if (missing) {
                console.warn(
                        "[auth] JWT_SECRET is not set — using the insecure default. " +
                        "Set JWT_SECRET in your .env before any non-local use.",
                );
        } else if (usingPlaceholder) {
                console.warn(
                        "[auth] JWT_SECRET is set to the insecure placeholder value. " +
                        "Replace it in your .env before any non-local use.",
                );
        }
        capturedJwtSecret = raw ?? INSECURE_DEFAULT_JWT_SECRET;
}

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

// Thrown on wrong-username-or-password, and only that. Infra failures (D1
// timeouts, bcrypt crashes, …) propagate as regular Errors so the route
// handler can 500 them instead of counting them toward the lockout budget.
export class InvalidCredentialsError extends Error {
        constructor() {
                super("Invalid credentials");
                this.name = "InvalidCredentialsError";
        }
}

export async function loginUser(username: string, password: string): Promise<{ userId: string; token: string }> {
        const result = await d1Query<{ id: string; password_hash: string }>(
                "SELECT id, password_hash FROM users WHERE username = ?",
                [username],
        );

        const row = result.results[0];
        if (!row || !bcrypt.compareSync(password, row.password_hash)) {
                throw new InvalidCredentialsError();
        }

        const token = signToken(row.id, username);
        return { userId: row.id, token };
}

function signToken(userId: string, username: string): string {
        const payload: JwtPayload = { sub: userId, username };
        return jwt.sign(payload, jwtSecret(), { expiresIn: JWT_EXPIRES_IN as any });
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
                const payload = jwt.verify(token, jwtSecret()) as JwtPayload;
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
 * Extract the bearer token from either:
 *   1. The `Sec-WebSocket-Protocol` header as `auth.bearer.<jwt>` (preferred —
 *      keeps the token out of URLs, access logs and Referer headers), or
 *   2. The `?token=<jwt>` query string (fallback for proxies / tunnels that
 *      strip the `Sec-WebSocket-Protocol` header).
 *
 * Then verify it and return the decoded payload, or null on any failure.
 */
export function verifyWsToken(
        protocolHeader: string | string[] | undefined,
        requestUrl: string | undefined,
): JwtPayload | null {
        const fromProtocol = extractTokenFromProtocol(protocolHeader);
        const fromUrl = fromProtocol ? null : extractTokenFromUrl(requestUrl);
        const token = fromProtocol ?? fromUrl;

        if (!token) {
                // Help operators tell which channel(s) were tried. The subprotocol path
                // is preferred; the query-string path only kicks in as a fallback for
                // proxies that strip Sec-WebSocket-Protocol.
                if (!protocolHeader && !requestUrl) {
                        console.error("[verifyWsToken] no Sec-WebSocket-Protocol header and no request URL");
                } else if (!protocolHeader) {
                        console.error("[verifyWsToken] no Sec-WebSocket-Protocol header and no ?token= query param");
                } else {
                        const header = Array.isArray(protocolHeader) ? protocolHeader.join(",") : protocolHeader;
                        console.error(
                                "[verifyWsToken] no usable auth.bearer.* subprotocol (got: %s) and no ?token= query param",
                                header,
                        );
                }
                return null;
        }

        try {
                return jwt.verify(token, jwtSecret()) as JwtPayload;
        } catch (err) {
                console.error("[verifyWsToken] jwt verify failed:", (err as Error).name, (err as Error).message);
                return null;
        }
}

function extractTokenFromProtocol(protocolHeader: string | string[] | undefined): string | null {
        if (!protocolHeader) return null;
        const header = Array.isArray(protocolHeader) ? protocolHeader.join(",") : protocolHeader;
        const protocols = header.split(",").map((s) => s.trim());
        const authProto = protocols.find((p) => p.startsWith(WS_AUTH_PROTOCOL_PREFIX));
        if (!authProto) return null;
        const token = authProto.slice(WS_AUTH_PROTOCOL_PREFIX.length);
        return token || null;
}

function extractTokenFromUrl(requestUrl: string | undefined): string | null {
        if (!requestUrl) return null;
        try {
                const parsed = new URL(requestUrl, "http://localhost");
                const token = parsed.searchParams.get("token");
                return token || null;
        } catch {
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

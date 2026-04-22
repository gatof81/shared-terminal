/**
 * auth.ts — JWT authentication + user management (D1-backed).
 */

import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { randomBytes } from "node:crypto";
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
        // Use `||` (not `??`) so an empty-string JWT_SECRET= falls back to
        // the default, matching the `missing = !raw` classification above.
        // `??` only triggers on null/undefined and would leave "" captured,
        // causing the server to sign tokens with an empty-string key in dev.
        capturedJwtSecret = raw || INSECURE_DEFAULT_JWT_SECRET;
}

// Test-only: reset the captured secret so each test starts from the
// "validateJwtSecret has not run yet" state. Must not be called from
// production code paths.
export function __resetJwtSecretForTests(): void {
        capturedJwtSecret = null;
}

export interface AuthedRequest extends Request {
        userId: string;
        username: string;
}

// ── User management ─────────────────────────────────────────────────────────

// Thrown when register is attempted without an invite code (and an account
// already exists), or with a code that's invalid / already redeemed.
export class InviteRequiredError extends Error {
        constructor(message: string) {
                super(message);
                this.name = "InviteRequiredError";
        }
}

export class UsernameTakenError extends Error {
        constructor() {
                super("Username already taken");
                this.name = "UsernameTakenError";
        }
}

export async function registerUser(
        username: string,
        password: string,
        inviteCode: string | undefined,
): Promise<{ userId: string; token: string }> {
        const existing = await d1Query<{ id: string }>("SELECT id FROM users WHERE username = ?", [username]);
        if (existing.results.length > 0) {
                throw new UsernameTakenError();
        }

        const userId = uuidv4();
        const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);

        // Bootstrap exception: the very first account doesn't need an invite,
        // since there's nobody to issue one. Every subsequent register must
        // claim an unused invite_codes row atomically.
        const isBootstrap = !(await hasAnyUsers());

        if (isBootstrap) {
                // INSERT … WHERE NOT EXISTS closes the bootstrap TOCTOU window:
                // hasAnyUsers() and INSERT are separate D1 round-trips, so two
                // simultaneous first-ever registers could both observe zero users
                // without this guard. Only one of them gets `meta.changes === 1`;
                // the loser falls through to the invite-required path below.
                const insert = await d1Query(
                        "INSERT INTO users (id, username, password_hash) " +
                                "SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)",
                        [userId, username, passwordHash],
                );
                if (insert.meta.changes === 1) {
                        return { userId, token: signToken(userId, username) };
                }
                // Race loser: a concurrent bootstrap got there first. Require an
                // invite from this point on, just like the steady-state path.
        }

        if (!inviteCode) {
                throw new InviteRequiredError("Invite code required");
        }
        // Atomic claim: the WHERE used_at IS NULL clause prevents two concurrent
        // registers from redeeming the same code. The race loser sees changes
        // === 0 and is rejected. If the user INSERT below fails (e.g. concurrent
        // username-uniqueness collision), we best-effort release the claim so
        // the invite isn't burned by a register that never produced an account.
        const claim = await d1Query(
                "UPDATE invite_codes SET used_by = ?, used_at = datetime('now') " +
                        "WHERE code = ? AND used_at IS NULL",
                [userId, inviteCode],
        );
        if (claim.meta.changes !== 1) {
                throw new InviteRequiredError("Invite code is invalid or already used");
        }

        try {
                await d1Query("INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)", [
                        userId,
                        username,
                        passwordHash,
                ]);
        } catch (err) {
                // Best-effort release. We scope by `used_by = userId` so we can't
                // accidentally un-claim a code that some other concurrent register
                // has since legitimately consumed.
                try {
                        await d1Query(
                                "UPDATE invite_codes SET used_by = NULL, used_at = NULL " +
                                        "WHERE code = ? AND used_by = ?",
                                [inviteCode, userId],
                        );
                } catch (releaseErr) {
                        console.error(
                                "[auth] invite release after failed user insert errored:",
                                (releaseErr as Error).message,
                        );
                }
                throw err;
        }

        return { userId, token: signToken(userId, username) };
}

// ── Invites ────────────────────────────────────────────────────────────────

// Caps the number of *outstanding* (unused) invites a single account can mint.
// Bounds the blast radius if an account is compromised: even with a stolen
// JWT the attacker can issue at most this many fresh invites before the cap
// trips. Used codes don't count — revoking or seeing a redemption frees a
// slot. Tune up if a legitimate workflow needs more concurrent invites.
const MAX_UNUSED_INVITES_PER_USER = 20;

export class InviteQuotaExceededError extends Error {
        constructor() {
                super(`You already have ${MAX_UNUSED_INVITES_PER_USER} unused invite codes — revoke or wait for some to be used before minting more`);
                this.name = "InviteQuotaExceededError";
        }
}

export interface Invite {
        code: string;
        createdBy: string;
        createdAt: string;
        usedBy: string | null;
        usedAt: string | null;
}

export async function createInvite(creatorUserId: string): Promise<Invite> {
        const countResult = await d1Query<{ count: number }>(
                "SELECT COUNT(*) as count FROM invite_codes WHERE created_by = ? AND used_at IS NULL",
                [creatorUserId],
        );
        if ((countResult.results[0]?.count ?? 0) >= MAX_UNUSED_INVITES_PER_USER) {
                throw new InviteQuotaExceededError();
        }

        // 16 hex chars = 64 bits of entropy — plenty for a single-use,
        // typically short-lived invite code, and short enough to paste.
        const code = randomBytes(8).toString("hex");
        // Pass created_at explicitly so we can return it without a follow-up
        // SELECT that could orphan a valid invite row on read failure. Format
        // matches D1's `datetime('now')` output (UTC, no fractional seconds)
        // so existing rows and new ones sort/compare consistently.
        const createdAt = new Date().toISOString().replace("T", " ").slice(0, 19);
        await d1Query(
                "INSERT INTO invite_codes (code, created_by, created_at) VALUES (?, ?, ?)",
                [code, creatorUserId, createdAt],
        );
        return { code, createdBy: creatorUserId, createdAt, usedBy: null, usedAt: null };
}

export async function listInvites(creatorUserId: string): Promise<Invite[]> {
        const result = await d1Query<InviteRow>(
                "SELECT code, created_by, created_at, used_by, used_at FROM invite_codes " +
                        "WHERE created_by = ? ORDER BY created_at DESC",
                [creatorUserId],
        );
        return result.results.map(rowToInvite);
}

// Revoke an unused invite. Returns true if a row was removed, false if the
// invite was missing, already used, or owned by a different user. The wire
// surface is intentionally vague so a caller can't enumerate codes belonging
// to other users.
export async function revokeInvite(creatorUserId: string, code: string): Promise<boolean> {
        const result = await d1Query(
                "DELETE FROM invite_codes WHERE code = ? AND created_by = ? AND used_at IS NULL",
                [code, creatorUserId],
        );
        return result.meta.changes === 1;
}

interface InviteRow {
        code: string;
        created_by: string;
        created_at: string;
        used_by: string | null;
        used_at: string | null;
}

function rowToInvite(row: InviteRow): Invite {
        return {
                code: row.code,
                createdBy: row.created_by,
                createdAt: row.created_at,
                usedBy: row.used_by,
                usedAt: row.used_at,
        };
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

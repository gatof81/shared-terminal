/**
 * auth.ts — JWT authentication + user management.
 *
 * Provides:
 *   - User registration & login (bcrypt passwords, JWT tokens)
 *   - Express middleware that extracts the JWT from Authorization header
 *   - WebSocket auth helper that reads token from query string
 */

import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
import { JwtPayload } from "./types.js";

const JWT_SECRET = process.env.JWT_SECRET ?? "change-me-in-production";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? "7d";
const BCRYPT_ROUNDS = 10;

// ── Augment Express Request ─────────────────────────────────────────────────

export interface AuthedRequest extends Request {
        userId: string;
        username: string;
}

// ── User management ─────────────────────────────────────────────────────────

export function registerUser(username: string, password: string): { userId: string; token: string } {
        const db = getDb();

        // Check if user exists
        const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
        if (existing) {
                throw new Error("Username already taken");
        }

        const userId = uuidv4();
        const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);

        db.prepare("INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)").run(
                userId,
                username,
                passwordHash,
        );

        const token = signToken(userId, username);
        return { userId, token };
}

export function loginUser(username: string, password: string): { userId: string; token: string } {
        const db = getDb();

        const row = db.prepare("SELECT id, password_hash FROM users WHERE username = ?").get(username) as
                | { id: string; password_hash: string }
                | undefined;

        if (!row || !bcrypt.compareSync(password, row.password_hash)) {
                throw new Error("Invalid credentials");
        }

        const token = signToken(row.id, username);
        return { userId: row.id, token };
}

function signToken(userId: string, username: string): string {
        const payload: JwtPayload = { sub: userId, username };
        return jwt.sign(payload, JWT_SECRET, {
                expiresIn: JWT_EXPIRES_IN as any,
        });
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

/**
 * Extract and verify JWT from a WebSocket URL query string (?token=...).
 * Returns the payload on success, null on failure.
 */
export function verifyWsToken(url: string | undefined): JwtPayload | null {
        if (!url) return null;
        try {
                const parsed = new URL(url, "http://localhost");
                const token = parsed.searchParams.get("token");
                if (!token) return null;
                return jwt.verify(token, JWT_SECRET) as JwtPayload;
        } catch {
                return null;
        }
}

/** Check if at least one user exists (for first-run setup flow). */
export function hasAnyUsers(): boolean {
        const db = getDb();
        const row = db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number };
        return row.count > 0;
}

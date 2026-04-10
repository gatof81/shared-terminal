import { Request, Response, NextFunction } from "express";

/**
 * MVP authentication: caller supplies their user-id via the `X-User-Id` header.
 *
 * ⚠️  Security note: This is intentionally minimal for the exercise.
 *     In production you would validate a signed JWT / session cookie instead.
 *     Never trust a client-supplied identity header in a real system.
 */
export function requireUserId(
        req: Request,
        res: Response,
        next: NextFunction,
): void {
        const userId = extractUserId(req.headers);
        if (!userId) {
                res.status(401).json({ error: "Missing X-User-Id header" });
                return;
        }
        // Attach to request for downstream handlers.
        (req as AuthedRequest).userId = userId;
        next();
}

export function extractUserId(
        headers: Record<string, string | string[] | undefined>,
): string | null {
        const raw = headers["x-user-id"];
        if (!raw) return null;
        const id = Array.isArray(raw) ? raw[0] : raw;
        // Basic sanitisation — allow only alphanumeric + hyphen/underscore, max 64 chars.
        return /^[\w-]{1,64}$/.test(id) ? id : null;
}

/**
 * Extract user ID from a URL query string — fallback for WebSocket connections
 * where the browser cannot set custom HTTP headers.
 *
 * Example: /ws/sessions/abc?userId=alice
 */
export function extractUserIdFromUrl(url: string | undefined): string | null {
        if (!url) return null;
        try {
                // URL constructor needs an absolute URL; use a dummy base.
                const parsed = new URL(url, "http://localhost");
                const id = parsed.searchParams.get("userId") ?? "";
                return /^[\w-]{1,64}$/.test(id) ? id : null;
        } catch {
                return null;
        }
}

/** Convenience type so downstream code can access req.userId without casts. */
export interface AuthedRequest extends Request {
        userId: string;
}

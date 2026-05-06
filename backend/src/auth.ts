/**
 * auth.ts — JWT authentication + user management (D1-backed).
 */

import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { d1Query } from "./db.js";
import { logger } from "./logger.js";
import type { JwtPayload } from "./types.js";

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
		logger.warn(
			"[auth] JWT_SECRET is not set — using the insecure default. " +
				"Set JWT_SECRET in your .env before any non-local use.",
		);
	} else if (usingPlaceholder) {
		logger.warn(
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
	const userId = uuidv4();

	// Bootstrap exception: the very first account doesn't need an invite,
	// since there's nobody to issue one. Every subsequent register must
	// claim an unused invite_codes row atomically.
	//
	// Only call hasAnyUsers() when no inviteCode was provided — the
	// steady-state register-with-invite path doesn't need to know whether
	// bootstrap is open, so skipping the round-trip cuts D1 chatter on
	// the hot path. When the caller did supply a code, they couldn't be
	// a bootstrap anyway (no codes exist yet), so skipping is also
	// semantically correct.
	if (!inviteCode) {
		const isBootstrap = !(await hasAnyUsers());
		if (!isBootstrap) {
			throw new InviteRequiredError("Invite code required");
		}
		// INSERT … WHERE NOT EXISTS closes the bootstrap TOCTOU window:
		// hasAnyUsers() and INSERT are separate D1 round-trips, so two
		// simultaneous first-ever registers could both observe zero users
		// without this guard. Only one of them gets `meta.changes === 1`.
		//
		// Bootstrap is the one path where we hash before validating an
		// invite — there's nothing to validate, and we need the hash for
		// the conditional INSERT. The cost is one bcrypt per first-ever
		// visit, which happens at most once per deployment. Async bcrypt
		// here (and everywhere below) so the event loop keeps serving
		// other requests while the hash runs on the libuv threadpool.
		const bootstrapHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
		const insert = await d1Query(
			"INSERT INTO users (id, username, password_hash) " +
				"SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)",
			[userId, username, bootstrapHash],
		);
		if (insert.meta.changes === 1) {
			return { userId, token: signToken(userId, username) };
		}
		// Race loser: a concurrent bootstrap got there first and we have
		// no invite to fall back on. Match the steady-state response so
		// the user can retry once they've been given a code.
		throw new InviteRequiredError("Invite code required");
	}
	// Atomic claim: the WHERE used_at IS NULL clause prevents two concurrent
	// registers from redeeming the same code. The race loser sees changes
	// === 0 and is rejected. The claim happens BEFORE any check on the
	// username so an unauthenticated caller without a valid invite always
	// sees 403 — never a 409 that would let them probe for existing
	// usernames. The expires_at filter rejects stale codes the same way.
	// If the user INSERT below fails (UNIQUE collision), we best-effort
	// release the claim so the invite isn't burned by a register that
	// never produced an account.
	//
	// Codes are stored hashed at rest (#49), so we hash the caller's
	// plaintext before the lookup. The hash is also what's logged on a
	// release-failure (see catch arm below).
	const inviteHash = createHash("sha256").update(inviteCode).digest("hex");
	const claim = await d1Query(
		"UPDATE invite_codes SET used_by = ?, used_at = datetime('now') " +
			"WHERE code_hash = ? AND used_at IS NULL " +
			"AND (expires_at IS NULL OR expires_at > datetime('now'))",
		[userId, inviteHash],
	);
	if (claim.meta.changes !== 1) {
		throw new InviteRequiredError("Invite code is invalid, expired, or already used");
	}

	// Hash only after the invite is confirmed valid. Even though async
	// bcrypt runs off the main thread, the libuv threadpool is bounded
	// (default 4 threads) — accepting un-gated hashes would let an
	// unauth'd caller exhaust those threads just by spamming bogus codes,
	// backing up every other async operation in the process.
	const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

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
					"WHERE code_hash = ? AND used_by = ?",
				[inviteHash, userId],
			);
		} catch (releaseErr) {
			// The release UPDATE failed, so the invite is now permanently
			// consumed without producing an account. The invitee will see
			// a 409 (or 500) response and has no way of knowing the code
			// is burned — they'll have to ask whoever issued it for a new
			// one.
			//
			// Log the SHA-256 of the code, never the raw value (#51).
			// The plaintext is gone from the DB anyway since #49, but
			// keep the log shape stable across the no-plaintext-anywhere
			// invariant: a log aggregator / SIEM that indexes this line
			// must hold no usable secret. The userId IS in the log so
			// the operator can scope the recovery DELETE defensively.
			//
			// Recovery: `code_hash` is now a column (post-#49), so the
			// orphan is one equality query away:
			//
			//   SELECT * FROM invite_codes WHERE code_hash = '<hash>';
			//
			// To clear the orphan and free the row for re-mint:
			//
			//   DELETE FROM invite_codes
			//   WHERE code_hash = '<hash>' AND used_by = '<userId>';
			logger.error(
				`[auth] CRITICAL: invite release failed — code hash ${inviteHash} claimed by user ${userId} is permanently consumed without an account. ` +
					`Insert error: ${(err as Error).message}. Release error: ${(releaseErr as Error).message}`,
			);
		}
		// SQLite UNIQUE-constraint violation → username already taken.
		// D1 surfaces the SQLite error message in the d1Query throw, so
		// we sniff for it rather than introducing a typed-error layer
		// around the whole D1 client.
		if (/UNIQUE constraint failed: users\.username/i.test((err as Error).message)) {
			throw new UsernameTakenError();
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

// How long an unredeemed invite stays valid. 30 days bounds the window in
// which a stolen JWT's pre-minted codes remain useful. Override via
// INVITE_EXPIRY_DAYS env var (decimal days). A 1-minute floor is enforced —
// any lower value would let an authenticated user mint unbounded codes by
// burst-cycling: at very short TTLs, 20 codes drain from the quota count in
// seconds and another 20 can be minted, repeating without bound. 1 minute
// caps the steady-state rate at 20/min/user.
const INVITE_EXPIRY_MIN_DAYS = 1 / 1440; // 1 minute
const INVITE_EXPIRY_DAYS = ((): number => {
	const raw = process.env.INVITE_EXPIRY_DAYS;
	// Treat blank ("" or whitespace-only) the same as unset. Without this
	// Number("") === 0 would slip past the finite/non-negative check and
	// land at the 1-minute floor — an operator who blanks the variable in
	// a secrets manager would silently get near-zero TTL.
	if (raw === undefined || raw.trim() === "") return 30;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) return 30;
	return Math.max(n, INVITE_EXPIRY_MIN_DAYS);
})();

export class InviteQuotaExceededError extends Error {
	constructor() {
		super(
			`You already have ${MAX_UNUSED_INVITES_PER_USER} active invite codes — revoke some, or wait for them to be used or expire, before minting more`,
		);
		this.name = "InviteQuotaExceededError";
	}
}

// Wire shape intentionally omits created_by (always the authenticated caller,
// so redundant) and used_by (exposes another user's internal UUID for no UI
// benefit — the frontend derives used/unused from `usedAt !== null`).
//
// `code_hash` is the public id used for revoke; `code_prefix` is the first
// 4 hex chars of the original plaintext, kept for UI recognition (#49). The
// plaintext itself only appears in the `MintedInvite` shape returned from
// `createInvite()` and is never persisted server-side.
export interface Invite {
	codeHash: string;
	codePrefix: string;
	createdAt: string;
	usedAt: string | null;
	expiresAt: string | null;
}

export interface MintedInvite extends Invite {
	/** Plaintext, returned to the minter once at creation. Never stored. */
	code: string;
}

const INVITE_PREFIX_LEN = 4;

export async function createInvite(creatorUserId: string): Promise<MintedInvite> {
	// 16 hex chars = 64 bits of entropy — plenty for a single-use,
	// typically short-lived invite code, and short enough to paste.
	//
	// Stored hashed at rest (#49): the plaintext is returned exactly
	// once, then dropped — a D1 leak no longer hands the attacker a
	// usable code. The 4-char prefix is kept in clear so the minter
	// can recognise their own codes in the list ("ab12…" — yes, that's
	// the one I sent to bob); leaks 16 of the 64 bits, leaving 48 bits
	// (~280 trillion) of secret.
	const code = randomBytes(8).toString("hex");
	const codeHash = createHash("sha256").update(code).digest("hex");
	const codePrefix = code.slice(0, INVITE_PREFIX_LEN);
	// Pass created_at + expires_at explicitly so we can return them
	// without a follow-up SELECT that could orphan a valid invite row on
	// read failure. Format matches D1's `datetime('now')` output (UTC,
	// no fractional seconds) so existing rows and new ones sort/compare
	// consistently.
	const now = new Date();
	const createdAt = formatD1Datetime(now);
	const expiresAt = formatD1Datetime(new Date(now.getTime() + INVITE_EXPIRY_DAYS * 86400_000));
	// Atomic quota check: collapse the count + insert into one statement
	// so two concurrent POST /invites requests can't both observe count
	// < MAX and both insert. The WHERE clause is evaluated as part of the
	// INSERT, so SQLite serialises the read+write. Same changes-based
	// pattern as the bootstrap and invite-claim paths above.
	//
	// Expired codes are excluded from the count: the cap exists to bound
	// *concurrently redeemable* invites (blast radius), and an expired
	// code is no more redeemable than a used one. Without this filter, a
	// forgetful user silently hits the cap 30 days after their last mint
	// and an attacker could just wait out the expiry instead of revoking.
	const insert = await d1Query(
		"INSERT INTO invite_codes (code_hash, code_prefix, created_by, created_at, expires_at) " +
			"SELECT ?, ?, ?, ?, ? WHERE (" +
			"SELECT COUNT(*) FROM invite_codes " +
			"WHERE created_by = ? AND used_at IS NULL " +
			"AND (expires_at IS NULL OR expires_at > datetime('now'))" +
			") < ?",
		[
			codeHash,
			codePrefix,
			creatorUserId,
			createdAt,
			expiresAt,
			creatorUserId,
			MAX_UNUSED_INVITES_PER_USER,
		],
	);
	if (insert.meta.changes !== 1) {
		throw new InviteQuotaExceededError();
	}
	return { code, codeHash, codePrefix, createdAt, usedAt: null, expiresAt };
}

// LIMIT bounds the response size so historical used/expired rows can't
// silently grow the payload over time. 100 is 5x the active quota — enough
// headroom that a user always sees their full active set plus a long tail
// of recent history. The UI doesn't paginate.
const INVITE_LIST_LIMIT = 100;

export async function listInvites(creatorUserId: string): Promise<Invite[]> {
	const result = await d1Query<InviteRow>(
		"SELECT code_hash, code_prefix, created_at, used_at, expires_at FROM invite_codes " +
			"WHERE created_by = ? ORDER BY created_at DESC LIMIT ?",
		[creatorUserId, INVITE_LIST_LIMIT],
	);
	return result.results.map(rowToInvite);
}

// Revoke an unused invite by its hash (the only public id post-#49 — the
// plaintext is gone). Returns true if a row was removed, false if the
// invite was missing, already used, or owned by a different user. The wire
// surface is intentionally vague so a caller can't enumerate codes belonging
// to other users.
export async function revokeInvite(creatorUserId: string, codeHash: string): Promise<boolean> {
	const result = await d1Query(
		"DELETE FROM invite_codes WHERE code_hash = ? AND created_by = ? AND used_at IS NULL",
		[codeHash, creatorUserId],
	);
	return result.meta.changes === 1;
}

interface InviteRow {
	code_hash: string;
	code_prefix: string;
	created_at: string;
	used_at: string | null;
	expires_at: string | null;
}

function rowToInvite(row: InviteRow): Invite {
	return {
		codeHash: row.code_hash,
		codePrefix: row.code_prefix,
		createdAt: row.created_at,
		usedAt: row.used_at,
		expiresAt: row.expires_at,
	};
}

// "YYYY-MM-DD HH:MM:SS" UTC, matching D1's datetime('now') format so direct
// SQL comparisons (`expires_at > datetime('now')`) work without timezone
// surprises.
function formatD1Datetime(d: Date): string {
	return d.toISOString().replace("T", " ").slice(0, 19);
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

// Timing-parity dummy hash for the unknown-username path: bcrypt.compare
// against a real-shape bcrypt string runs the full work-factor computation
// before returning false, matching the CPU cost of the real-user branch
// so an attacker can't distinguish "unknown username" from "wrong
// password" by timing.
//
// Previously this was a synthetic hardcoded string ("$2a$10$" + 53 "x"):
// library-valid base64, correct shape, meant to exercise bcrypt's full
// 2^10 work because the parser couldn't short-circuit on it. That worked,
// but the guarantee was structural — it depended on bcryptjs NEVER adding
// a fast-fail path for inputs that happen to look synthetic. There's no
// test we can write to pin "the library didn't short-circuit" other than
// wall-clock timing (fragile), so a future bcryptjs release could
// regress the timing protection silently.
//
// Replaced with a real hash derived at module load by bcrypt.hash itself,
// on a fixed throwaway password. Key properties:
//
//   1. Structurally indistinguishable from a real user's hash — produced
//      by the same library we'll compare against. If the library ever
//      changes the output format or the work cost, this hash follows.
//      No test needed; the invariant is "bcrypt.compare(x, bcrypt.hash(
//      anything, rounds)) takes full bcrypt time", which is the library's
//      contract, not ours.
//   2. Computed once at module import, cached as a Promise. Node is
//      CommonJS here (tsconfig module=commonjs), so we can't top-level
//      await — the first login (specifically the first login against an
//      unknown user) would otherwise block on the computation. index.ts
//      pre-awaits `ensureAuthReady()` before server.listen so that first
//      login doesn't leak cold-start latency as a timing side channel.
//   3. The password ("__dummy__") can be anything — bcrypt.compare will
//      never match the supplied login password against it in practice,
//      because hashes salt-in the generated salt, not the password.
const DUMMY_PASSWORD_HASH_PROMISE: Promise<string> = bcrypt.hash("__dummy__", BCRYPT_ROUNDS);

// Awaited from index.ts before server.listen so the first unknown-user
// login doesn't pay ~2^BCRYPT_ROUNDS-ms of cold-start latency — which
// would itself be a timing leak vs first known-user login ("known user"
// short-circuits to row.password_hash without ever touching this
// promise). After this resolves, the `await` inside loginUser is a free
// microtask tick.
//
// Safe to call more than once; it returns the same settled promise on
// every call.
export async function ensureAuthReady(): Promise<void> {
	await DUMMY_PASSWORD_HASH_PROMISE;
}

export async function loginUser(
	username: string,
	password: string,
): Promise<{ userId: string; token: string }> {
	const result = await d1Query<{ id: string; password_hash: string }>(
		"SELECT id, password_hash FROM users WHERE username = ?",
		[username],
	);

	const row = result.results[0];
	// Always run a bcrypt compare, even if the user doesn't exist, so an
	// attacker can't distinguish "unknown username" from "wrong password"
	// by timing. The `??` short-circuits on the known-user path, so
	// known-user logins don't pay the awaited-promise cost (negligible
	// post-init anyway, but cleaner to avoid the microtask on the hot
	// path). See DUMMY_PASSWORD_HASH_PROMISE above for the rationale.
	const hashToCompare = row?.password_hash ?? (await DUMMY_PASSWORD_HASH_PROMISE);
	const ok = await bcrypt.compare(password, hashToCompare);
	if (!row || !ok) {
		throw new InvalidCredentialsError();
	}

	const token = signToken(row.id, username);
	return { userId: row.id, token };
}

function signToken(userId: string, username: string): string {
	const payload: JwtPayload = { sub: userId, username };
	// `expiresIn` in jsonwebtoken is typed as `number | StringValue`,
	// where StringValue is a template-literal type from the `ms`
	// package (e.g. "7d", "1h"). JWT_EXPIRES_IN comes from process.env
	// as a plain string, so we cast through the library's own option
	// type rather than `any` — keeps the check narrow to this one
	// field and doesn't opt the whole sign-options shape out of
	// type-checking.
	const options: jwt.SignOptions = { expiresIn: JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"] };
	return jwt.sign(payload, jwtSecret(), options);
}

// ── Cookie auth (#18) ──────────────────────────────────────────────────────

export const AUTH_COOKIE_NAME = "st_token";

// SameSite/Secure pair driven by NODE_ENV. Cross-site delivery (frontend
// on `*.pages.dev`, backend on a tunnel with a custom domain — different
// eTLD+1) requires `SameSite=None`, which the spec forces to come with
// `Secure`. Dev (http://localhost) keeps `Strict` because same-site is
// guaranteed there and `Secure` would refuse to set on plain HTTP.
//
// CSRF guarantees with `SameSite=None`:
//   - State-changing routes are POST/DELETE/PATCH with
//     `Content-Type: application/json`, so the browser preflights them.
//     CORS rejects unlisted origins → the actual request never fires.
//   - WebSocket upgrades go through `isAllowedWsOrigin` (CSWSH) which
//     enforces the same allowlist independently of SameSite.
const isProduction = (): boolean => process.env.NODE_ENV === "production";
const cookieSameSite = (): "strict" | "none" => (isProduction() ? "none" : "strict");

/**
 * Set the JWT as an httpOnly cookie. `maxAge` is derived from the JWT's
 * own `exp` claim so the cookie expires exactly when the token does —
 * no "cookie says logged in but every request comes back 401" window
 * if JWT_EXPIRES_IN is changed.
 */
export function setAuthCookie(res: Response, token: string): void {
	const decoded = jwt.decode(token) as { exp?: number } | null;
	const expSec = decoded?.exp;
	const maxAge = expSec ? Math.max(0, expSec * 1000 - Date.now()) : 0;
	res.cookie(AUTH_COOKIE_NAME, token, {
		httpOnly: true,
		secure: isProduction(),
		sameSite: cookieSameSite(),
		path: "/",
		maxAge,
	});
}

export function clearAuthCookie(res: Response): void {
	// Clearing has to mirror the same cookie attributes (path, sameSite,
	// secure) the browser used to scope the cookie, otherwise it picks a
	// different stored cookie and the live one survives.
	res.clearCookie(AUTH_COOKIE_NAME, {
		httpOnly: true,
		secure: isProduction(),
		sameSite: cookieSameSite(),
		path: "/",
	});
}

/** Verify a raw JWT string. Returns the payload, or null on any failure. */
export function verifyJwt(token: string | undefined): JwtPayload | null {
	if (!token) return null;
	try {
		return jwt.verify(token, jwtSecret()) as JwtPayload;
	} catch {
		return null;
	}
}

/**
 * Pick the JWT out of a `Cookie` request header, returning the raw token or
 * null if the cookie isn't present. Tolerates the various encodings real
 * clients send: missing header, multiple cookies, leading/trailing whitespace,
 * URL-encoded values. Used by both the WS upgrade path and (via cookie-parser
 * in production) the REST middleware for a defence-in-depth fallback when the
 * middleware is somehow bypassed.
 */
export function extractTokenFromCookieHeader(
	cookieHeader: string | string[] | undefined,
): string | null {
	if (!cookieHeader) return null;
	const raw = Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader;
	for (const part of raw.split(";")) {
		const eq = part.indexOf("=");
		if (eq <= 0) continue;
		const name = part.slice(0, eq).trim();
		if (name !== AUTH_COOKIE_NAME) continue;
		const value = part.slice(eq + 1).trim();
		if (!value) return null;
		// Cookie values may be URL-encoded. decodeURIComponent throws on a
		// malformed sequence — treat as missing rather than 500.
		try {
			return decodeURIComponent(value);
		} catch {
			return value;
		}
	}
	return null;
}

// ── Express middleware ──────────────────────────────────────────────────────

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
	// `cookie-parser` is wired in index.ts and populates req.cookies. The
	// header-fallback below only runs if the middleware is somehow absent
	// (e.g. a future test bypassing express). It's not load-bearing —
	// strictly defence-in-depth.
	const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
	const token = cookies?.[AUTH_COOKIE_NAME] ?? extractTokenFromCookieHeader(req.headers.cookie);
	const payload = verifyJwt(token);
	if (!payload) {
		res.status(401).json({ error: "Missing or invalid auth cookie" });
		return;
	}
	(req as AuthedRequest).userId = payload.sub;
	(req as AuthedRequest).username = payload.username;
	next();
}

// ── WebSocket auth ──────────────────────────────────────────────────────────

/**
 * Verify the JWT carried by an incoming WS upgrade. Reads from the request's
 * `Cookie` header — browsers send cookies on the WS handshake to the cookie's
 * domain regardless of the page's origin (CSWSH protection lives separately
 * via the `Origin` allowlist).
 */
export function verifyWsToken(cookieHeader: string | string[] | undefined): JwtPayload | null {
	const token = extractTokenFromCookieHeader(cookieHeader);
	if (!token) {
		logger.error("[verifyWsToken] no auth cookie on upgrade request");
		return null;
	}
	const payload = verifyJwt(token);
	if (!payload) {
		logger.error("[verifyWsToken] auth cookie failed JWT verification");
		return null;
	}
	return payload;
}

/**
 * Split-and-trim the raw `CORS_ORIGINS` env value into the shape used
 * by the HTTP CORS middleware AND `isAllowedWsOrigin` below. Whitespace
 * around entries is trimmed (so `"https://a, https://b"` — the obvious
 * human-readable format — works), and empty entries are dropped (so
 * `"a,,b,"` becomes `["a", "b"]` rather than `["a", "", "b", ""]`,
 * which would otherwise let an origin-header value of `""` match
 * literally).
 *
 * Semantics per input:
 *   - `undefined` (unset) → `["*"]` — matches the pre-existing default
 *     and keeps local dev working without configuration.
 *   - `""` or whitespace-only → `[]` — explicit opt-in deny-all for the
 *     HTTP layer. An operator who blanks `CORS_ORIGINS=` in a secrets
 *     manager gets "no cross-origin HTTP", not "wildcard allow".
 *     Restores the pre-#64 behaviour that a round-2 reviewer flagged
 *     had been silently widened to `["*"]`. See issue #65.
 *   - `"a, b"` etc. → `["a", "b"]` — trimmed, empties dropped.
 *
 * Kept pure + exported so the split/trim is testable without standing
 * up the HTTP server.
 */
export function parseCorsOrigins(raw: string | undefined): string[] {
	if (raw === undefined) return ["*"];
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/**
 * Decide whether a WebSocket upgrade with the given Origin header should
 * be accepted. The caller (index.ts' `upgrade` handler) uses the result
 * to 403 out BEFORE the handshake completes, so a rejected origin never
 * reaches verifyWsToken / handleWsConnection and never shows up in the
 * `wss.clients` set either.
 *
 * Threat model: Cross-Site WebSocket Hijacking (CSWSH). A page a
 * logged-in user visits opens `new WebSocket("wss://…")` against our
 * server. Browsers do NOT apply Same-Origin Policy to WebSockets —
 * there's no preflight, no `Access-Control-*` enforcement. The only
 * origin-based defence the browser gives us is that it DOES always send
 * the `Origin` header on WS handshakes, and an attacker page cannot
 * forge it. So: server-side Origin allowlist is the whole defence.
 *
 * Policy:
 *
 * 1. No Origin header (undefined or empty string): allow.
 *    Browsers ALWAYS send Origin on WS. Absence means a non-browser
 *    client (curl, a native app, a server-to-server caller). That's
 *    outside the CSWSH threat model — a server-side attacker with a
 *    valid JWT already bypasses any origin check by just not setting
 *    Origin, and doesn't need to "hijack" anything. Blocking empty
 *    Origin would break legitimate CLI tooling without closing the
 *    CSWSH gap.
 *
 * 2. Origin exactly in `allowedOrigins`: allow.
 *    Substring/suffix matching is tempting (`ends with our-domain.com`)
 *    but enables `attackerour-domain.com` attacks. Exact match only.
 *
 * 3. allowedOrigins contains "*":
 *    - In production: DENY, and the caller logs a loud warning once at
 *      startup. The HTTP CORS layer treats "*" as "anyone can hit
 *      public endpoints without credentials" — mostly harmless because
 *      browsers refuse to send credentials to `*`. WS has no such
 *      browser-side guard: the browser DOES send the auth.bearer.* sub-
 *      protocol on a WS to any origin. "*" for WS in production means
 *      "any page on the web can CSWSH our authenticated users".
 *    - Outside production: allow. Local dev frequently runs on
 *      multiple/ephemeral ports, and the CSWSH prerequisite (attacker
 *      site in the victim's browser) is ~never the local-dev threat
 *      model. A dev should not have to configure CORS_ORIGINS just to
 *      get `localhost` working.
 *
 * 4. Everything else: deny.
 *
 * Returns boolean; the caller decides the wire response (403 + socket
 * destroy). Kept pure so auth.test.ts can pin all four branches without
 * touching http.
 */
export function isAllowedWsOrigin(
	origin: string | undefined,
	allowedOrigins: readonly string[],
	nodeEnv: string | undefined,
): boolean {
	// Branch 1: not a browser, not a CSWSH vector.
	if (!origin) return true;

	// Branch 2: explicitly whitelisted.
	if (allowedOrigins.includes(origin)) return true;

	// Branch 3: "*" wildcard.
	if (allowedOrigins.includes("*")) {
		return nodeEnv !== "production";
	}

	// Branch 4.
	return false;
}

/**
 * Called once at startup. Warns loudly if `CORS_ORIGINS` contains "*"
 * in production — see isAllowedWsOrigin's branch 3 comment for why
 * this is a refused-by-default condition on the WS path.
 *
 * Pulled out of the upgrade handler so the warning fires exactly once
 * (on boot) rather than per-rejected-request, which would be noisy and
 * drown out genuine attack-surface signals.
 *
 * `out` is injectable for the test — defaults to the module-level pino
 * logger; tests pass a `{ warn: vi.fn() }` and assert on it. The
 * parameter name avoids shadowing the imported `logger`.
 */
export function warnIfWildcardCorsInProduction(
	allowedOrigins: readonly string[],
	nodeEnv: string | undefined,
	out: { warn: (msg: string) => void } = logger,
): void {
	if (nodeEnv !== "production") return;
	if (!allowedOrigins.includes("*")) return;
	out.warn(
		"[server] CORS_ORIGINS contains '*' in production. The HTTP layer " +
			"still honours this, but the WebSocket upgrade handler refuses it " +
			"(CSWSH protection). Set CORS_ORIGINS to an explicit origin list " +
			"to re-enable WebSocket connections from production clients.",
	);
}

export async function hasAnyUsers(): Promise<boolean> {
	const result = await d1Query<{ count: number }>("SELECT COUNT(*) as count FROM users");
	return result.results[0].count > 0;
}

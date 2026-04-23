/**
 * trustProxy.ts — validate & parse the TRUST_PROXY env var.
 *
 * Split out from index.ts so the parsing logic is pure (no process.exit,
 * no app.set) and can be unit-tested without spinning up Express. The
 * caller (index.ts) is responsible for calling `app.set("trust proxy",
 * parseTrustProxy(...))` and for turning a thrown TrustProxyError into a
 * fatal exit.
 *
 * Background: Express's `trust proxy` setting controls how `req.ip` is
 * derived from `X-Forwarded-For`. Misconfiguring it has real security
 * consequences — the wrong value lets an attacker rotate X-F-F headers
 * to bypass per-IP rate limits. This module makes the allowed shapes
 * explicit and refuses anything else with an actionable error.
 */

export type TrustProxyValue = boolean | number | string;

export class TrustProxyError extends Error {
        constructor(message: string) {
                super(message);
                this.name = "TrustProxyError";
        }
}

// Express's named presets. Anything outside this set that isn't a number,
// a hop count, or an IP/CIDR is a likely typo (e.g. "loopbakc",
// "uniquely-local") — refuse it loudly rather than passing through to
// Express's internal compileTrust which would silently treat it as a
// literal hostname to trust.
const NAMED_PRESETS = new Set(["loopback", "linklocal", "uniquelocal"]);

// Permissive shape-only regex, NOT a full IP parser. Matches:
//   - IPv4 dotted (e.g. "10.0.0.1"): exactly 4 dot-separated runs of 1-3
//     digits. Loose on octet range (".999" slips through), tight on shape.
//   - IPv6 hex+colons (e.g. "::1", "2001:db8::1"): must contain at least
//     one colon. Without the mandatory colon, tokens like "1e2" or "abc"
//     would sneak through as "pseudo-IPv6" — scientific notation is
//     never a valid trust-proxy value and a typo'd word shouldn't be
//     silently treated as a literal hostname.
// Either form may carry an optional CIDR `/N` suffix.
//
// The semantic validity of the address (real-IPv4, real-IPv6, CIDR
// boundary) is delegated to Express's own parser — we're only catching
// shape-level garbage here.
const IP_OR_CIDR = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[\da-fA-F]*:[\da-fA-F:]*)(?:\/\d+)?$/;

/**
 * Parse the raw TRUST_PROXY env string into the value Express expects.
 * Returns `undefined` when the variable is unset or blank (caller should
 * leave Express's default alone in that case).
 *
 * Throws TrustProxyError for:
 *   - `"true"` (foot-gun: leftmost-XFF = attacker-controlled)
 *   - negative or non-finite numbers
 *   - unrecognised strings (typos in preset names, non-IP-shaped tokens)
 */
export function parseTrustProxy(raw: string | undefined): TrustProxyValue | undefined {
        if (raw === undefined || raw.trim() === "") return undefined;
        const trimmed = raw.trim();

        // "true" is the single most common wrong value — it looks right to
        // anyone who reads "trust proxy" as a boolean knob, but Express then
        // takes the LEFTMOST X-Forwarded-For entry, which the client controls.
        // Refuse it with a message that names the correct alternative.
        if (trimmed === "true") {
                throw new TrustProxyError(
                        "TRUST_PROXY=true is refused: Express would take the leftmost " +
                        "X-Forwarded-For entry (attacker-controlled), bypassing per-IP " +
                        "rate limiting. Use a hop count (e.g. TRUST_PROXY=1) instead.",
                );
        }

        // Explicit "0"/"false" → boolean false so we don't rely on Express's
        // (undocumented) compileTrust(0) returning "never trust". If that
        // internal ever changes, a string mistakenly treated as an IP would
        // silently mis-trust; the explicit boolean keeps us pinned.
        if (trimmed === "false" || trimmed === "0") return false;

        // Hop-count form. Reject a leading "+", scientific notation, or
        // anything else that Number("…") would happily coerce but isn't a
        // legitimate count.
        if (/^\d+$/.test(trimmed)) {
                const n = Number(trimmed);
                if (!Number.isSafeInteger(n) || n < 0) {
                        throw new TrustProxyError(
                                `TRUST_PROXY="${raw}" is not a valid non-negative integer hop count`,
                        );
                }
                return n;
        }

        // Comma-separated list of named presets, IPs, or CIDRs. Express accepts
        // all three in the same comma-separated format, so we validate every
        // token before passing the whole string through.
        const tokens = trimmed.split(",").map((t) => t.trim()).filter(Boolean);
        if (tokens.length === 0) {
                throw new TrustProxyError(`TRUST_PROXY="${raw}" has no valid tokens after splitting`);
        }
        for (const token of tokens) {
                if (NAMED_PRESETS.has(token)) continue;
                if (IP_OR_CIDR.test(token)) continue;
                throw new TrustProxyError(
                        `TRUST_PROXY contains unrecognised value "${token}". ` +
                        `Expected a non-negative integer hop count (e.g. "1"), "false"/"0", ` +
                        `one of [${[...NAMED_PRESETS].join(", ")}], an IP/CIDR, ` +
                        `or a comma-separated list of those.`,
                );
        }
        return trimmed;
}

/**
 * Emit a production-unset warning. Called at startup from index.ts.
 *
 * When NODE_ENV=production and TRUST_PROXY is unset, there's a good
 * chance the backend is behind a proxy (tunnel, CDN, LB) but will still
 * use the proxy's socket address as req.ip — collapsing per-IP rate
 * limits into a single global bucket. This is a config mistake, not a
 * valid deployment topology for anyone running behind Cloudflare Tunnel.
 *
 * We warn rather than fail because a direct-internet production server
 * (rare but legal) should also not set TRUST_PROXY; we can't tell the
 * two apart from env alone.
 *
 * Logger is injectable so tests can assert on calls without stealing
 * console.warn globally.
 */
// Intentional scope: this helper only flags the "unset / blank" case. It
// does NOT re-validate a set value — that's parseTrustProxy's job and is
// called separately at boot. It also does NOT warn when the operator
// explicitly sets TRUST_PROXY=0 / =false in production, even though that
// has the same collapse-all-IPs-into-one-bucket effect as leaving it
// unset behind a proxy. Distinguishing the two cases is deliberate:
//
//   - unset  = "operator didn't think about it" → warn, it's probably a
//              misconfiguration the operator hasn't noticed yet.
//   - 0/false = "operator explicitly chose to distrust all proxies"   →
//              silent, on the assumption that a deployment directly
//              exposed to the internet (e.g. a host-network container
//              with no CDN in front) is the legitimate scenario. If the
//              caller set it to false AND is behind a proxy, that's a
//              deployment mistake this helper can't distinguish from a
//              correct direct-exposure setup — so we defer to operator
//              intent rather than guess.
//
// If the threat model ever extends to "ops typed `false` because they
// saw it was a valid value and didn't read the docs", flip this to also
// warn on explicit falsy values — the corresponding test
// ('stays quiet when TRUST_PROXY is set in production') would also need
// to drop its `"false"` case.
export function warnIfProductionMisconfigured(
        raw: string | undefined,
        nodeEnv: string | undefined,
        logger: Pick<Console, "warn"> = console,
): void {
        if (nodeEnv !== "production") return;
        if (raw !== undefined && raw.trim() !== "") return;
        logger.warn(
                "[server] NODE_ENV=production but TRUST_PROXY is unset. " +
                "If the backend is behind a reverse proxy, CDN, or tunnel, " +
                "req.ip will be the proxy's socket address — collapsing per-IP " +
                "rate limits into a single global bucket. Set TRUST_PROXY to the " +
                "hop count (e.g. 1 for a single Cloudflare Tunnel), or leave unset " +
                "ONLY if the backend is directly internet-facing.",
        );
}

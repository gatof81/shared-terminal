/**
 * conversation/limits.ts — the single source of the numeric limits in
 * docs/CONVERSATION.md §3.1 (rate) and §4.4 (L1–L8, G1–G5). Every other
 * module imports from here so a limit can't drift between the ingest
 * parser, the store and the tests that pin the contract.
 *
 * "Content" limits (L1–L4) are UTF-8 bytes of the VALUE; L5 is bytes of
 * the serialised request BODY. The two are different because JSON
 * escaping multiplies content (`\n` ×2, control chars `\u00XX` ×6), so
 * L5 ≥ 6 × L3 + envelope — see `limits.test.ts` for the pinned proof.
 */

const KiB = 1024;
const MiB = 1024 * KiB;

/** L1 — `user_prompt.prompt` content bytes. */
export const L1_PROMPT_BYTES = 64 * KiB;
/** L2 — accumulated `assistant_delta` text per `message_id`. */
export const L2_MESSAGE_BYTES = 1 * MiB;
/** L3 — `last_assistant_message` (`turn_end`, `agent_end`) content bytes. */
export const L3_REPORT_BYTES = 1 * MiB;
/** L4 — auxiliary strings (summaries, errors, notification text, …). */
export const L4_AUX_BYTES = 2 * KiB;
/** L5 — ingest request body bytes (serialised JSON). */
export const L5_BODY_BYTES = 8 * MiB;
/** L6 — per-conversation in-memory queue: events / bytes. */
export const L6_QUEUE_EVENTS = 256;
export const L6_QUEUE_BYTES = 8 * MiB;
/** L7 — events file size before rotation. */
export const L7_FILE_BYTES = 64 * MiB;
/** L8 — DOM budget (frontend, documented here for completeness). */
export const L8_DOM_EVENTS = 500;
export const L8_DOM_BYTES = 8 * MiB;

/** G1 — sum of every per-conversation queue in the process. */
export const G1_TOTAL_QUEUE_BYTES = 64 * MiB;
/** G2 — ingest bodies larger than G2_LARGE_BODY_BYTES in flight at once. */
export const G2_LARGE_BODIES_IN_FLIGHT = 4;
export const G2_LARGE_BODY_BYTES = 1 * MiB;
/** G3 — WS buffer budget (3.1); documented here so the numbers live together. */
export const G3_REPLAY_BUFFER_BYTES = 2 * MiB;
export const G3_LIVE_BUFFER_BYTES = 8 * MiB;
/** G4 — resident conversation indexes and the size of each. */
export const G4_RESIDENT_INDEXES = 64;
export const G4_INDEX_BYTES = 4 * MiB;
/** G5 — bytes per read response (3.1). */
export const G5_RESPONSE_BYTES = 8 * MiB;

/** R1 — events per ST session: token bucket capacity / refill per second. */
export const R1_EVENTS_CAPACITY = 500;
export const R1_EVENTS_PER_SECOND = 50;
/** R2 — bytes per ST session: capacity ≥ L5 so one max-size body always fits. */
export const R2_BYTES_CAPACITY = 24 * MiB;
export const R2_BYTES_PER_SECOND = (24 * MiB) / 60;
/** One `gap rate_limited` per conversation per window. */
export const RATE_LIMIT_GAP_WINDOW_MS = 10_000;

/** §4.6 — payload-hash dedupe window and per-conversation table size. */
export const DEDUPE_WINDOW_MS = 10_000;
export const DEDUPE_TABLE_MAX = 4096;

/** §5.3 — `ending` → `ended` grace, and the silence after which `unknown` applies. */
export const SESSION_END_GRACE_MS = 5_000;
export const UNKNOWN_AFTER_SILENCE_MS = 10 * 60_000;

/** §3.1 — token cache TTL (belt and braces next to the revocation marker). */
export const TOKEN_CACHE_TTL_MS = 60_000;

/** §3.3 / §4.4 — index snapshot cadence. */
export const INDEX_FLUSH_EVERY_EVENTS = 50;
export const INDEX_FLUSH_INTERVAL_MS = 5_000;
/** D1 heartbeat coalescing per conversation. */
export const D1_HEARTBEAT_INTERVAL_MS = 30_000;

/** Misc caps used by the normaliser. */
export const ARGV_FLAG_VALUE_BYTES = 64;
export const FILE_PATH_BYTES = 512;
export const BASH_PROGRAMS_MAX = 8;
export const BASH_PROGRAM_BYTES = 32;
export const MCP_KEYS_MAX = 16;
export const MCP_KEY_BYTES = 64;
export const ERROR_TEXT_BYTES = 512;
export const AGENT_DESCRIPTION_BYTES = 128;

export const BYTES = { KiB, MiB } as const;

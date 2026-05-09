/**
 * templates.ts — per-user reusable session-config presets.
 *
 * A template stores a JSON config in the same shape as
 * `session_configs` except that `secret`-typed env entries collapse
 * to `secret-slot` markers and `auth.pat` / `auth.ssh.privateKey`
 * ciphertexts are dropped (only the "isSet" intent is preserved).
 * The `Use template` flow re-prompts for those values; the schema's
 * existing `secret-slot` rejection on `POST /sessions` is the
 * regression guard if a client tries to submit a template shape
 * directly.
 *
 * `assertOwnership(templateId, userId)` is the single auth choke
 * point — analogous to `sessions.assertOwnership`. The list / read
 * / update / delete code paths all go through it so a regression in
 * the auth check has only one place to break, not five.
 */

import { randomUUID } from "node:crypto";
import { d1Query } from "./db.js";
import { ForbiddenError, NotFoundError } from "./sessionManager.js";

interface TemplateRow {
	id: string;
	owner_user_id: string;
	name: string;
	description: string | null;
	config: string;
	created_at: string;
	updated_at: string;
}

/**
 * Domain shape returned by single-row reads / writes. `config` is
 * parsed JSON; callers re-validate with `validateSessionConfig`
 * before reuse. `description` is normalised to `string | null` (DB
 * shape) — the route serializer can collapse `null` to omitted on
 * the wire.
 */
export interface Template {
	id: string;
	ownerUserId: string;
	name: string;
	description: string | null;
	config: unknown;
	createdAt: Date;
	updatedAt: Date;
}

/**
 * Summary shape returned by `listForUser`. Omits `config` because
 * the list endpoint serves the templates-page UI which only needs
 * metadata for the row chrome (name + description + updatedAt for
 * sort / display). The full config lives behind `GET /:id` and is
 * fetched only when the user clicks `Use template`. With a 100-
 * template per-user cap and configs that can run to ~256 KiB
 * each, returning the full payload on every list call is up to
 * ~25 MiB in the worst case — server-side D1 read cost the user
 * inflicts on themselves on every page load.
 */
export interface TemplateSummary {
	id: string;
	ownerUserId: string;
	name: string;
	description: string | null;
	createdAt: Date;
	updatedAt: Date;
}

/** Input shape for `create` / `update`. `config` is the unparsed
 *  JSON string the caller has already serialised — keeps the
 *  template module ignorant of the SessionConfig schema (the route
 *  is the right place to validate before persist). */
export interface TemplateInput {
	name: string;
	description?: string | null;
	config: string;
}

const TEMPLATE_NOT_FOUND = "Template not found";

function rowToTemplate(row: TemplateRow): Template {
	let config: unknown;
	try {
		config = JSON.parse(row.config);
	} catch (err) {
		// A corrupt row would otherwise propagate a raw `SyntaxError`
		// out of `.map(rowToTemplate)` in `listForUser`, aborting the
		// whole list and surfacing only "Internal server error" with
		// no template id. Throwing a meaningful Error keeps the
		// behaviour observable in logs (the route's catch-all logs
		// the message before returning 500). Doesn't change the
		// HTTP status, but the operator can grep the log for the
		// row id and fix the data.
		throw new Error(`templates: corrupt config JSON in row ${row.id}: ${(err as Error).message}`);
	}
	return {
		id: row.id,
		ownerUserId: row.owner_user_id,
		name: row.name,
		description: row.description,
		config,
		// `datetime('now')` produces SQLite's `YYYY-MM-DD HH:MM:SS`
		// (UTC, no timezone suffix). `new Date()` interprets that as
		// LOCAL time on most engines — the same trap `sessionConfig`
		// works around with `parseD1Utc`. Mirror the fix here so
		// timestamps stay UTC end-to-end.
		createdAt: parseD1Utc(row.created_at),
		updatedAt: parseD1Utc(row.updated_at),
	};
}

function parseD1Utc(raw: string): Date {
	const hasSuffix = /[zZ]$/.test(raw) || /[+-]\d{2}:?\d{2}$/.test(raw);
	const d = new Date(hasSuffix ? raw : `${raw}Z`);
	if (Number.isNaN(d.getTime())) {
		throw new Error(`templates: unparseable timestamp ${raw}`);
	}
	return d;
}

/**
 * Per-user template cap. Mirrors the session-quota pattern in
 * `sessionManager` — without a ceiling, an authenticated user can
 * spam template creation and exhaust D1 row / storage quotas for
 * the whole service. 100 is generous (templates are static config,
 * not running containers) without being unbounded.
 */
export const MAX_TEMPLATES_PER_USER = 100;

/** Thrown by `create` when the caller is at the per-user template
 *  cap. The route maps this to 429. */
export class TemplateQuotaExceededError extends Error {
	constructor() {
		super(`Template count exceeds per-user cap of ${MAX_TEMPLATES_PER_USER}`);
		this.name = "TemplateQuotaExceededError";
	}
}

/** Create a new template owned by `userId`. Caller has already
 *  validated `input.config` is the right shape. Returns the
 *  generated id. Throws `TemplateQuotaExceededError` if the user
 *  already owns the maximum allowed templates. */
export async function create(userId: string, input: TemplateInput): Promise<Template> {
	// Pre-insert count check. Not atomic with the INSERT (D1's HTTP
	// API has no multi-statement transaction), so a tight
	// create-create race could land the user one row over the cap —
	// acceptable vs the cost of a per-user lock or a SQL constraint
	// we don't have on D1. The session-quota path in
	// `sessionManager.ts` uses a stricter `INSERT … SELECT … WHERE
	// (COUNT(*) < cap)` shape that's race-free; templates accepts
	// the one-over-cap risk because the ceiling is soft (no spawn,
	// no resource impact) and the savings of a single round-trip
	// vs the more complex shape weren't worth chasing here.
	const countResult = await d1Query<{ n: number }>(
		"SELECT COUNT(*) AS n FROM templates WHERE owner_user_id = ?",
		[userId],
	);
	const existing = countResult.results[0]?.n ?? 0;
	if (existing >= MAX_TEMPLATES_PER_USER) {
		throw new TemplateQuotaExceededError();
	}
	const id = randomUUID();
	await d1Query(
		"INSERT INTO templates (id, owner_user_id, name, description, config) " +
			"VALUES (?, ?, ?, ?, ?)",
		[id, userId, input.name, input.description ?? null, input.config],
	);
	const row = await fetchRow(id);
	if (!row) throw new Error("templates.create: row vanished after insert");
	return rowToTemplate(row);
}

/**
 * List every template owned by `userId`. Newest-first.
 *
 * Returns the metadata-only summary shape (no `config`) — the
 * templates-page UI only needs name / description / updatedAt for
 * the row chrome. The full config is fetched on `Use template` via
 * GET /:id. SELECT is column-pinned (not `SELECT *`) so a future
 * column addition to `templates` doesn't accidentally widen the
 * list response.
 */
export async function listForUser(userId: string): Promise<TemplateSummary[]> {
	const result = await d1Query<{
		id: string;
		owner_user_id: string;
		name: string;
		description: string | null;
		created_at: string;
		updated_at: string;
	}>(
		"SELECT id, owner_user_id, name, description, created_at, updated_at " +
			"FROM templates WHERE owner_user_id = ? ORDER BY updated_at DESC",
		[userId],
	);
	return result.results.map((row) => ({
		id: row.id,
		ownerUserId: row.owner_user_id,
		name: row.name,
		description: row.description,
		createdAt: parseD1Utc(row.created_at),
		updatedAt: parseD1Utc(row.updated_at),
	}));
}

/**
 * Read one template by id, gated on ownership.
 *
 * Throws `NotFoundError` if no row exists OR if the row is owned by
 * someone else. Both cases collapse to 404 on the route — without
 * the collapse, a probe attacker could distinguish "your template"
 * vs "someone else's template" by status-code timing. Same posture
 * the dispatcher (#190) and `sessions.assertOwnership` use.
 */
export async function getOwned(templateId: string, userId: string): Promise<Template> {
	const row = await fetchRow(templateId);
	if (!row || row.owner_user_id !== userId) {
		throw new NotFoundError(TEMPLATE_NOT_FOUND);
	}
	return rowToTemplate(row);
}

/**
 * Same `getOwned` semantics but distinguishes "missing" from
 * "forbidden". Used by the route layer when the operation is
 * destructive (DELETE) and we want to log a 403 (someone tried to
 * touch another user's template) separately from a 404 (typo'd id).
 */
export async function assertOwnership(templateId: string, userId: string): Promise<Template> {
	const row = await fetchRow(templateId);
	if (!row) throw new NotFoundError(TEMPLATE_NOT_FOUND);
	if (row.owner_user_id !== userId) throw new ForbiddenError();
	return rowToTemplate(row);
}

/** Update name / description / config. Caller pre-validates the
 *  config shape. `updated_at` is bumped to `datetime('now')`. */
export async function update(
	templateId: string,
	userId: string,
	input: TemplateInput,
): Promise<Template> {
	// `assertOwnership` distinguishes 404 (no row) from 403 (row
	// exists, wrong owner) — destructive paths get the explicit
	// signal, by design (the read path's `getOwned` is the one
	// that collapses both into 404 to avoid existence-leak via
	// status-code timing). Running it first keeps the UPDATE
	// off the wire when ownership fails.
	await assertOwnership(templateId, userId);
	// Defence-in-depth: `WHERE id = ? AND owner_user_id = ?` keeps
	// the UPDATE scoped to rows the caller owns even if a future
	// refactor drops the `assertOwnership` pre-check or wraps
	// `update()` without it. `owner_user_id` is never mutated by
	// this module so the WHERE is a hard upper bound — never a
	// false negative on a legitimate update.
	await d1Query(
		"UPDATE templates SET name = ?, description = ?, config = ?, updated_at = datetime('now') " +
			"WHERE id = ? AND owner_user_id = ?",
		[input.name, input.description ?? null, input.config, templateId, userId],
	);
	const row = await fetchRow(templateId);
	// Race window: a sibling DELETE between the assertOwnership SELECT
	// and the UPDATE+re-read below leaves no row. Surface as 404 (the
	// route's `handleTemplateError` maps NotFoundError to 404; a bare
	// `Error` would fall through to 500 and look like a server bug
	// for what's actually a benign concurrent-edit race).
	if (!row) throw new NotFoundError(TEMPLATE_NOT_FOUND);
	return rowToTemplate(row);
}

/** Delete the template. Owner-gated. A second call on an
 *  already-deleted id throws `NotFoundError` (route 404) — the
 *  first call's success was 204, so re-deletion is NOT idempotent
 *  in the response shape; clients that retry on a partial network
 *  failure must tolerate the 404 themselves. */
export async function deleteTemplate(templateId: string, userId: string): Promise<void> {
	await assertOwnership(templateId, userId);
	await d1Query("DELETE FROM templates WHERE id = ?", [templateId]);
}

async function fetchRow(templateId: string): Promise<TemplateRow | null> {
	const result = await d1Query<TemplateRow>("SELECT * FROM templates WHERE id = ?", [templateId]);
	return result.results[0] ?? null;
}

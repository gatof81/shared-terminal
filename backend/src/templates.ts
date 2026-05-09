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
 * Domain shape returned by every method. `config` is parsed JSON;
 * callers re-validate with `validateSessionConfig` before reuse.
 * `description` is normalised to `string | null` (DB shape) — the
 * route serializer can collapse `null` to omitted on the wire.
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
	return {
		id: row.id,
		ownerUserId: row.owner_user_id,
		name: row.name,
		description: row.description,
		config: JSON.parse(row.config),
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

/** Create a new template owned by `userId`. Caller has already
 *  validated `input.config` is the right shape. Returns the
 *  generated id. */
export async function create(userId: string, input: TemplateInput): Promise<Template> {
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

/** List every template owned by `userId`. Newest-first. */
export async function listForUser(userId: string): Promise<Template[]> {
	const result = await d1Query<TemplateRow>(
		"SELECT * FROM templates WHERE owner_user_id = ? ORDER BY updated_at DESC",
		[userId],
	);
	return result.results.map(rowToTemplate);
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
	// `assertOwnership` runs first so a non-owner can't tell from
	// the response whether the row exists (404 from missing vs 403
	// from forbidden — both are surfaced cleanly by the route).
	await assertOwnership(templateId, userId);
	await d1Query(
		"UPDATE templates SET name = ?, description = ?, config = ?, updated_at = datetime('now') " +
			"WHERE id = ?",
		[input.name, input.description ?? null, input.config, templateId],
	);
	const row = await fetchRow(templateId);
	if (!row) throw new Error("templates.update: row vanished after UPDATE");
	return rowToTemplate(row);
}

/** Delete the template. Owner-gated; idempotent — calling on an
 *  already-deleted id returns NotFoundError. */
export async function deleteTemplate(templateId: string, userId: string): Promise<void> {
	await assertOwnership(templateId, userId);
	await d1Query("DELETE FROM templates WHERE id = ?", [templateId]);
}

async function fetchRow(templateId: string): Promise<TemplateRow | null> {
	const result = await d1Query<TemplateRow>("SELECT * FROM templates WHERE id = ?", [templateId]);
	return result.results[0] ?? null;
}

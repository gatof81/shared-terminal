import type { Request, Response, Router } from "express";
import type { AuthedRequest } from "../auth.js";
import { logger } from "../logger.js";
import { SessionConfigValidationError, validateSessionConfig } from "../sessionConfig.js";
import { ForbiddenError, NotFoundError } from "../sessionManager.js";
import * as templates from "../templates.js";
import type { RouteContext } from "./shared.js";

// biome-ignore lint/correctness/noUnusedFunctionParameters: ctx kept for orchestrator-call symmetry; templates needs no shared deps
export function registerTemplateRoutes(router: Router, ctx: RouteContext): void {
	// ── Templates ──────────────────────────────────────────────────────────
	//
	// Per-user reusable session-config presets. The list/read/update/
	// delete code paths all flow through `templates.assertOwnership`
	// (or `templates.getOwned`, which collapses missing + forbidden
	// into a single 404 to avoid status-code-timing enumeration of
	// "your template" vs "someone else's"). The save-as-template
	// flow that strips secret values lands in the next sub-PR; this
	// PR exposes the storage and CRUD surface only.
	//
	// `config` is JSON-stringified by the caller before the route
	// hands it to `templates.create`/`update` so the templates module
	// stays ignorant of the SessionConfig schema. Validation happens
	// at the route boundary, before persist.

	router.post("/templates", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		const body = req.body as { name?: unknown; description?: unknown; config?: unknown };
		try {
			const { name, description } = parseTemplateBody(body);
			// Validate the config shape via the same `SessionConfigSchema`
			// the create-session route uses, with two flags flipped on for
			// the template path:
			//   - `allowSecretSlots: true` lets `secret-slot` env entries
			//     pass (POST /sessions rejects them — no value to spawn
			//     with — but templates EXPECT them).
			//   - `allowMissingAuth: true` tolerates a `repo.auth: "pat"` /
			//     `"ssh"` declaration without the matching credential,
			//     so the template preserves intent ("this template wants
			//     PAT auth") without persisting the PAT itself.
			// PR #228 round 1+2 BLOCKER+SHOULD-FIX.
			validateSessionConfig(body.config, {
				allowSecretSlots: true,
				allowMissingAuth: true,
			});
			// Belt-and-braces: the storage column is raw JSON, not the
			// AES-GCM-encrypted `auth_json` / `env_vars_json` columns
			// that `session_configs` uses. Reject plaintext secret
			// entries and live credentials at the route boundary so a
			// misbehaving client can't smuggle a PAT / SSH key into the
			// template row. PR #228 round 3 BLOCKER.
			assertTemplateConfigShape(body.config);
			const t = await templates.create(userId, {
				name,
				description,
				config: JSON.stringify(body.config),
			});
			res.status(201).json(serializeTemplate(t));
		} catch (err) {
			handleTemplateError(err, res);
		}
	});

	router.get("/templates", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		try {
			const list = await templates.listForUser(userId);
			// Summary shape — no `config`. The full template body is
			// fetched on demand via GET /:id when the user clicks
			// `Use template`. Keeps the list response small even with
			// a quota of 100 templates carrying ~256 KiB configs.
			res.json(list.map(serializeTemplateSummary));
		} catch (err) {
			handleTemplateError(err, res);
		}
	});

	router.get("/templates/:id", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		try {
			const t = await templates.getOwned(req.params.id, userId);
			res.json(serializeTemplate(t));
		} catch (err) {
			handleTemplateError(err, res);
		}
	});

	router.put("/templates/:id", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		const body = req.body as { name?: unknown; description?: unknown; config?: unknown };
		try {
			const { name, description } = parseTemplateBody(body);
			// Same flags as POST. The PUT path must accept exactly
			// the shapes the POST accepted; without symmetric flag
			// handling, a no-op rename of a template that already
			// has secret-slot env vars or a credential-less private
			// repo would 400 on every save.
			validateSessionConfig(body.config, {
				allowSecretSlots: true,
				allowMissingAuth: true,
			});
			assertTemplateConfigShape(body.config);
			const t = await templates.update(req.params.id, userId, {
				name,
				description,
				config: JSON.stringify(body.config),
			});
			res.json(serializeTemplate(t));
		} catch (err) {
			handleTemplateError(err, res);
		}
	});

	router.delete("/templates/:id", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		try {
			await templates.deleteTemplate(req.params.id, userId);
			res.status(204).send();
		} catch (err) {
			handleTemplateError(err, res);
		}
	});
}

// ── Templates: shared helpers ────────────────────────────────────────────

/**
 * Bound caps for template metadata. `name` is shown in the sidebar
 * list and reused as the placeholder session name when "Use template"
 * fires; 64 chars matches the existing session-name cap so the same
 * UX assumption holds end-to-end. `description` is a free-form
 * tooltip-shape help string — 512 chars is generous without becoming
 * a row-bloat vector when many templates accumulate.
 */
const MAX_TEMPLATE_NAME_LEN = 64;
const MAX_TEMPLATE_DESCRIPTION_LEN = 512;

export class TemplateBodyError extends Error {
	constructor(
		message: string,
		public readonly path: string,
	) {
		super(message);
		this.name = "TemplateBodyError";
	}
}

/**
 * Reject live credential shapes — plaintext-`secret` env entries,
 * `auth.pat`, `auth.ssh.privateKey` — at the route boundary so they
 * can never land in `templates.config` (which is stored as raw JSON,
 * not encrypted via the `secrets.ts` AES-GCM path that
 * `session_configs` uses). The frontend save-as-template flow
 * (195b) is responsible for stripping these into `secret-slot`
 * markers + omitted-credential placeholders before submit; this
 * function is the server-side regression guard if a client
 * misbehaves. PR #228 round 3 BLOCKER.
 *
 * The shape we accept after this gate:
 *   - envVars: only `plain` and `secret-slot` (the latter is the
 *     placeholder a `Use template` flow re-prompts for);
 *   - auth: `repo.auth: "none" | "pat" | "ssh"` is fine, but
 *     `auth.pat` and `auth.ssh.privateKey` MUST be omitted —
 *     `validateSessionConfig`'s `allowMissingAuth` flag tolerates
 *     a `"pat"` / `"ssh"` declaration without the credential, so
 *     the template preserves intent without the secret.
 *   - everything else passes through.
 */
export function assertTemplateConfigShape(config: unknown): void {
	if (config === null || typeof config !== "object" || Array.isArray(config)) return;
	const c = config as Record<string, unknown>;
	const envVars = c.envVars;
	if (Array.isArray(envVars)) {
		for (const entry of envVars) {
			if (entry === null || typeof entry !== "object") continue;
			const t = (entry as { type?: unknown }).type;
			if (t === "secret") {
				throw new TemplateBodyError(
					"config.envVars: 'secret' entries are not allowed in templates; strip to 'secret-slot' before saving",
					"config.envVars",
				);
			}
		}
	}
	const auth = c.auth;
	if (auth !== null && typeof auth === "object" && !Array.isArray(auth)) {
		const a = auth as Record<string, unknown>;
		if (a.pat !== undefined) {
			throw new TemplateBodyError(
				"config.auth.pat: PAT credentials must not be stored in a template; the recipient re-supplies on use",
				"config.auth.pat",
			);
		}
		const ssh = a.ssh;
		if (
			ssh !== null &&
			typeof ssh === "object" &&
			(ssh as { privateKey?: unknown }).privateKey !== undefined
		) {
			throw new TemplateBodyError(
				"config.auth.ssh.privateKey: SSH key material must not be stored in a template; the recipient re-supplies on use",
				"config.auth.ssh.privateKey",
			);
		}
	}
}

export function parseTemplateBody(body: {
	name?: unknown;
	description?: unknown;
	config?: unknown;
}): {
	name: string;
	description: string | null;
} {
	if (typeof body.name !== "string") {
		throw new TemplateBodyError("name is required", "name");
	}
	// Trim BEFORE the length check + emptiness check so the API
	// contract ("names up to N characters are accepted") matches
	// the actual stored value. Without trim-first ordering, a
	// 65-char input that's mostly leading whitespace would be
	// rejected even though its trimmed form fits comfortably under
	// the cap.
	const name = body.name.trim();
	if (name === "") {
		throw new TemplateBodyError("name is required", "name");
	}
	if (name.length > MAX_TEMPLATE_NAME_LEN) {
		throw new TemplateBodyError(`name exceeds ${MAX_TEMPLATE_NAME_LEN} characters`, "name");
	}
	let description: string | null = null;
	if (body.description !== undefined && body.description !== null) {
		if (typeof body.description !== "string") {
			throw new TemplateBodyError("description must be a string", "description");
		}
		// Trim then collapse-empty-to-null. A `"   "` description
		// would otherwise persist with its whitespace and render
		// blank-looking in the UI while the column reports non-null
		// — a UX trap when the user thinks they cleared the field.
		const trimmed = body.description.trim();
		if (trimmed.length > MAX_TEMPLATE_DESCRIPTION_LEN) {
			throw new TemplateBodyError(
				`description exceeds ${MAX_TEMPLATE_DESCRIPTION_LEN} characters`,
				"description",
			);
		}
		description = trimmed === "" ? null : trimmed;
	}
	if (body.config === undefined || body.config === null) {
		throw new TemplateBodyError("config is required", "config");
	}
	// `typeof []` is `"object"` in JS, so a bare array would slip
	// past `typeof !== "object"` and reach `validateSessionConfig`,
	// where Zod surfaces a raw schema error instead of the cleaner
	// `TemplateBodyError` path. The Array guard keeps the boundary
	// error path consistent. PR #228 round 2 NIT.
	if (typeof body.config !== "object" || Array.isArray(body.config)) {
		throw new TemplateBodyError("config must be an object", "config");
	}
	return { name, description };
}

function serializeTemplate(t: templates.Template): {
	id: string;
	name: string;
	description: string | null;
	config: unknown;
	createdAt: string;
	updatedAt: string;
} {
	return {
		id: t.id,
		name: t.name,
		description: t.description,
		config: t.config,
		createdAt: t.createdAt.toISOString(),
		updatedAt: t.updatedAt.toISOString(),
	};
}

function serializeTemplateSummary(t: templates.TemplateSummary): {
	id: string;
	name: string;
	description: string | null;
	createdAt: string;
	updatedAt: string;
} {
	return {
		id: t.id,
		name: t.name,
		description: t.description,
		createdAt: t.createdAt.toISOString(),
		updatedAt: t.updatedAt.toISOString(),
	};
}

function handleTemplateError(err: unknown, res: Response): void {
	if (err instanceof NotFoundError) {
		res.status(404).json({ error: "Template not found" });
		return;
	}
	if (err instanceof ForbiddenError) {
		res.status(403).json({ error: "Forbidden" });
		return;
	}
	if (err instanceof templates.TemplateQuotaExceededError) {
		// 429 (Too Many Requests) matches the spec's "rate-limit-
		// shape" for "you're at your quota; the system isn't broken".
		// Mirrors the session-quota response code used by the
		// create-session route.
		res.status(429).json({ error: err.message });
		return;
	}
	if (err instanceof TemplateBodyError) {
		res.status(400).json({ error: err.message, path: err.path });
		return;
	}
	if (err instanceof SessionConfigValidationError) {
		res.status(400).json({ error: err.message, path: err.path });
		return;
	}
	logger.error(`[routes] template error: ${(err as Error).message}`);
	res.status(500).json({ error: "Internal server error" });
}

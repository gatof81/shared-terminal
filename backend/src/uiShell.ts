/**
 * uiShell.ts — the runtime switch between the two frontend shells
 * (docs/design/ui-unificada.md §8.4, decision §9.7).
 *
 * `UI_SHELL=v1|v2` (default v1) is read once at boot and surfaced on
 * `GET /api/auth/status` as `uiShell`; the frontend mounts the shell it
 * names. Rollback is the env var and a backend restart — no frontend
 * redeploy. A browser may override it for testing with `?ui=v2` (kept in
 * localStorage); that override never reaches the server.
 */

import { logger } from "./logger.js";

export type UiShell = "v1" | "v2";

export function parseUiShell(raw: string | undefined): UiShell {
	const v = (raw ?? "").trim().toLowerCase();
	if (v === "" || v === "v1") return "v1";
	if (v === "v2") return "v2";
	logger.warn(`UI_SHELL=${JSON.stringify(raw)} is not v1 or v2 — using v1`);
	return "v1";
}

export const UI_SHELL: UiShell = parseUiShell(process.env.UI_SHELL);

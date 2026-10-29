/**
 * internalPrompt.testutil.ts — the shared test vector for the §4.2.1
 * classifier: the shape of the pilot's seq 22 (CLI 2.1.308, an `Agent`
 * tool finishing in the background). Ids are synthetic, no content copied.
 * Mirrored in `backend/src/conversation/internalPrompt.testutil.ts`.
 */

export const NOTIFICATION = [
	"<task-notification>",
	"<task-id>afc95b2b37cb620a1</task-id>",
	"<tool-use-id>toolu_01NrcdMjX7yQ2bK9vTz3Lm4W</tool-use-id>",
	"<status>completed</status>",
	"<summary>Agent completed</summary>",
	"<result>",
	"The subagent's report: **done**, 3 files, see `src/x.ts`.",
	"</result>",
	"</task-notification>",
].join("\n");

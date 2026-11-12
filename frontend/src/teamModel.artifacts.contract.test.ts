import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	answerStates,
	deliveryText,
	ProjectLog,
	parseLogEvent,
	registerErrorText,
} from "./teamModel.js";

/**
 * The frontend model against REAL answers of the D2 backend (#600,
 * a09bf8a): produced by running its own ProjectArtifacts (register through
 * the Files opener), ProjectFanout with the real placement, and
 * ProjectConversationApi on a temp WORKSPACE_ROOT — fake Composer only.
 * Scenario: a diff registered from A's session (then again: replayed; a
 * `.env`: restricted), sent to A (placed + delivered) and B (whose
 * `.st-inbox` is a file: not-sent artifact-failed inbox-not-dir), and a
 * send naming an unregistered sha256. Regenerate when Appendix A.2 changes.
 */
const fx = JSON.parse(
	readFileSync(join(process.cwd(), "src/__fixtures__/project-artifacts-600.json"), "utf8"),
);
const { A, B } = fx.agents as { A: string; B: string };
const sha: string = fx.reg1.body.sha256;

describe("contract: #600's own answers", () => {
	it("every line of the log parses, the artifact event included", () => {
		const parsed = (fx.page.body.events as unknown[]).map(parseLogEvent);
		expect(parsed.every((e) => e !== null)).toBe(true);
		expect(parsed.map((e) => e!.ev)).toContain("artifact");
		expect((fx.onlyArtifacts.body.events as unknown[]).map(parseLogEvent)).toEqual([
			expect.objectContaining({
				ev: "artifact",
				sha256: sha,
				name: "fix.diff",
				sourcePath: "out/fix.diff",
			}),
		]);
	});

	it("the message carries {sha256, name, bytes}; A delivered, B not-sent with the inbox reason and the files warning", () => {
		const log = new ProjectLog();
		log.add(
			(fx.page.body.events as unknown[]).map(parseLogEvent).filter((e) => e !== null) as never,
		);
		const m = log.messages.get(fx.post.body.msgId)!;
		expect(m.message.artifacts).toEqual([
			{ sha256: sha, name: "fix.diff", bytes: fx.reg1.body.bytes },
		]);
		expect(m.deliveries.get(A)?.state).toBe("delivered");
		const b = m.deliveries.get(B)!;
		expect(b).toMatchObject({
			state: "not-sent",
			artifactError: "inbox-not-dir",
			filesPossiblyPlaced: true,
		});
		expect(deliveryText(b)).toBe(
			"Not delivered: a file couldn't be placed: its .st-inbox isn't a plain folder. Some files may already be in its inbox.",
		);
		expect(log.artifacts.get(sha)?.sourceAgentId).toBe(A);
	});

	it("the POST answer's per-recipient states and filesPossiblyPlaced read as the log does", () => {
		const d = fx.post.body.deliveries as Array<{
			agentId: string;
			state: string;
			filesPossiblyPlaced?: boolean;
		}>;
		expect(answerStates([A, B], d).map((x) => x.state)).toEqual(["delivered", "not-sent"]);
		expect(d.find((x) => x.agentId === B)?.filesPossiblyPlaced).toBe(true);
	});

	it("register answers: 201, 200 replayed, and a refusal the UI explains", () => {
		expect(fx.reg1.status).toBe(201);
		expect(fx.reg2).toMatchObject({ status: 200, body: { replayed: true, sha256: sha } });
		expect(registerErrorText(fx.regErr.body.error, fx.regErr.status)).toMatch(/protected/);
		expect(fx.unknown).toMatchObject({
			status: 400,
			body: { error: "artifact-unknown", detail: "c".repeat(64) },
		});
	});
});

/**
 * recreate/capturePort.ts — the recreation's capture side, on top of the
 * conversation service (CONVERSATION.md §2.7.2 steps 1 and 5, §2.7.5).
 *
 * Step 5 runs the same §2.7.5 write procedure as `PATCH {enabled:true}`,
 * but through an authority of its own:
 *   - its Docker reads and probes are requests of the attempt (tracked,
 *     never aborted, bounded by what is left of T_rec);
 *   - it writes nothing once the attempt's epoch has closed, and withdraws
 *     what it wrote;
 *   - it does not consult the `recreate-unresolved` gate: the attempt that
 *     holds the session's lock and its `open` record is the one actor the
 *     gate exists to let through (no circular block, K1.3).
 */

import {
	hooksFileExists,
	prepareRecreateCapture,
	removeHooksFile,
	writeHooksFile,
} from "../conversation/activation.js";
import {
	CaptureAuthority,
	deferSeedExists,
	RELAY_IDENTIFY_WAIT_MS,
	relayEnabledExists,
	removeDeferSeed,
	writeRelayEnabled,
} from "../conversation/captureAuth.js";
import { getSessionCapture } from "../conversation/registry.js";
import { checkRevocation } from "../conversation/revocation.js";
import type { ConversationService } from "../conversation/service.js";
import type { RecreateCapturePort } from "./engine.js";

export function conversationRecreatePort(service: ConversationService): RecreateCapturePort {
	const deps = service.activationDeps;
	const root = deps.workspaceRoot;
	return {
		enabled: deps.enabled,
		checkRevocation: (sid) => checkRevocation(root, sid),
		prepare: (sid) => prepareRecreateCapture(deps, sid),
		snapshot: async (sid) => ({
			marker: await relayEnabledExists(root, sid),
			hooksFile: await hooksFileExists(root, sid),
		}),
		restore: async (sid, snap) => {
			if (!snap.marker && !snap.hooksFile) return;
			// A disable (always allowed, §2.7.4) may have run during the
			// attempt: putting the files back must not undo it.
			const row = await getSessionCapture(sid);
			if (!deps.enabled || row?.conversation_requested !== 1) return;
			if ((await checkRevocation(root, sid)) !== "none") return;
			if (snap.marker) await writeRelayEnabled(root, sid);
			if (snap.hooksFile) await writeHooksFile(deps, sid);
		},
		authorize: async (sid, run) => {
			const base = service.captureDocker;
			const authority = new CaptureAuthority({
				workspaceRoot: root,
				enabled: deps.enabled,
				docker: {
					inspectCapture: (cid) => run.call("inspect N (capture)", () => base.inspectCapture(cid)),
					currentImage: () => run.call("current image", () => base.currentImage()),
					probeRelay: (s, cid) => run.call("probe N relay", () => base.probeRelay(s, cid)),
				},
				getRow: (s) => getSessionCapture(s),
				checkRevocation: (s) => checkRevocation(root, s),
				isRecreateUnresolved: async () => false,
				writeHooksFile: (s) => writeHooksFile(deps, s),
				removeHooksFile: (s) => removeHooksFile(root, s),
				hooksFileExists: (s) => hooksFileExists(root, s),
				identifyWaitMs: Math.min(RELAY_IDENTIFY_WAIT_MS, run.remaining()),
				mayWrite: () => run.epochOpen,
			});
			let w: Awaited<ReturnType<CaptureAuthority["applyWriteDetailed"]>> = {
				outcome: "not-authorized",
			};
			try {
				w = await authority.applyWriteDetailed(sid);
			} catch {
				// A Docker read refused by a closed epoch, or a failing one:
				// fail-closed, and the capture block below says so.
			}
			if (!run.epochOpen) {
				// Late or not, nothing of this attempt's authorization stays.
				await authority.withdraw(sid);
			}
			return authority.capture(sid, { identified: w.identified });
		},
		converge: async (sid) => {
			await service.authority.converge(sid);
		},
		deferSeedExists: (sid) => deferSeedExists(root, sid),
		removeDeferSeed: (sid) => removeDeferSeed(root, sid),
	};
}

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

import { promises as fs } from "node:fs";
import {
	hooksFileExists,
	hooksFilePath,
	prepareRecreateCapture,
	removeHooksFile,
	writeHooksFile,
} from "../conversation/activation.js";
import {
	CaptureAuthority,
	deferSeedExists,
	RELAY_IDENTIFY_WAIT_MS,
	relayEnabledExists,
	relayEnabledPath,
	removeDeferSeed,
	retainAuthorized,
	writeAuthorized,
} from "../conversation/captureAuth.js";
import { getSessionCapture } from "../conversation/registry.js";
import { checkRevocation } from "../conversation/revocation.js";
import type { ConversationService } from "../conversation/service.js";
import type { RecreateCapturePort } from "./engine.js";

/**
 * Present unless lstat says ENOENT. The shared `*Exists` helpers read any
 * error as "absent", which is fine for deciding what to write but not for
 * VERIFYING an absence: an unreadable file is not a removed one.
 */
async function present(p: string): Promise<boolean> {
	try {
		await fs.lstat(p);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw err;
	}
}

/**
 * Whether the session's capture files match what authorization allows now
 * (`RecreateCapturePort.converged`). Exported for the real-Docker smoke,
 * which wires its own authority.
 */
export async function captureFilesConverged(
	authority: CaptureAuthority,
	workspaceRoot: string,
	sessionId: string,
): Promise<boolean> {
	const f = await authority.facts(sessionId);
	const marker = await present(relayEnabledPath(workspaceRoot, sessionId));
	const hooksFile = await present(hooksFilePath(workspaceRoot, sessionId));
	const c = f.container;
	// Running with write authorization: the configuration is complete only
	// with both files — `relay-unavailable` included, which leaves neither
	// while capture is still authorized.
	if (c?.exists && c.running && writeAuthorized(f)) return marker && hooksFile;
	// Stopped with retain authorization: a stop keeps the pair and nothing
	// is written on a stopped container, so both or neither.
	if (c?.exists && !c.running && retainAuthorized(f)) return marker === hooksFile;
	// Not authorized (disabled, revoked, flag off, …): both gone.
	return !marker && !hooksFile;
}

export function conversationRecreatePort(service: ConversationService): RecreateCapturePort {
	const deps = service.activationDeps;
	const root = deps.workspaceRoot;
	/**
	 * The authority the attempt itself acts through once it is resolving
	 * (rollback restore, convergence on N): the gate is not consulted —
	 * the record is unresolved precisely until this work is done and
	 * checked, and the caller holds the session's lock (no other verb
	 * interleaves). Every other rule of §2.7.5 applies unchanged.
	 *
	 * `mayAct` is the pass's lease and the engine not being shut down: a
	 * convergence or restore already inside the authority when either
	 * ends (a probe still out, say) writes nothing after it (E5).
	 */
	const ownerAuthority = (mayAct: () => boolean) =>
		new CaptureAuthority({
			workspaceRoot: root,
			enabled: deps.enabled,
			docker: service.captureDocker,
			getRow: (s) => getSessionCapture(s),
			checkRevocation: (s) => checkRevocation(root, s),
			isRecreateUnresolved: async () => false,
			writeHooksFile: (s) => writeHooksFile(deps, s),
			removeHooksFile: (s) => removeHooksFile(root, s),
			hooksFileExists: (s) => hooksFileExists(root, s),
			mayWrite: mayAct,
		});
	return {
		enabled: deps.enabled,
		checkRevocation: (sid) => checkRevocation(root, sid),
		prepare: (sid, mayAct) => prepareRecreateCapture(deps, sid, mayAct),
		snapshot: async (sid) => ({
			marker: await relayEnabledExists(root, sid),
			hooksFile: await hooksFileExists(root, sid),
		}),
		restore: async (sid, snap, oContainerId, mayAct) => {
			// Only a complete pair was ever kept on a stopped O; a half is
			// what §2.7.5 would retire anyway.
			if (!snap.marker || !snap.hooksFile) return "not-authorized";
			return ownerAuthority(mayAct).restoreRetained(sid, oContainerId);
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
			let w: Awaited<ReturnType<CaptureAuthority["applyWriteDetailed"]>>;
			try {
				w = await authority.applyWriteDetailed(sid);
			} catch (err) {
				// A Docker read refused by a closed epoch, a failing one, or a
				// file write that failed. Nothing half-written stays (best
				// effort: the write procedure already tried once), and the
				// failure goes to the engine, which records `authorize` as
				// pending instead of a step 5 that merely looked done (E6).
				await authority.withdraw(sid).catch(() => undefined);
				throw err;
			}
			if (!run.epochOpen) {
				// Late or not, nothing of this attempt's authorization stays.
				await authority.withdraw(sid);
			}
			return authority.capture(sid, { identified: w.identified });
		},
		converge: (sid, mayAct) => ownerAuthority(mayAct).converge(sid),
		converged: (sid) =>
			captureFilesConverged(
				ownerAuthority(() => true),
				root,
				sid,
			),
		deferSeedExists: (sid) => deferSeedExists(root, sid),
		removeDeferSeed: (sid) => removeDeferSeed(root, sid),
	};
}

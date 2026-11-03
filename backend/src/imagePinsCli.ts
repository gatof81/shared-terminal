/**
 * imagePinsCli.ts — operator view of the session image pins (imagePins.ts).
 *
 *   npm run images:pins                    status: every session container,
 *                                          its image, whether it still exists
 *                                          and whether it is pinned; exit 1
 *                                          when an image is MISSING or not
 *                                          pinned (a deploy preflight gate)
 *   npm run images:pins -- pin             the boot pass, now (idempotent; it
 *                                          only ADDS tags)
 *   npm run images:pins -- prune           orphan pins (no container uses the
 *                                          image), dry run
 *   npm run images:pins -- prune --write   removes those tags — the image
 *                                          goes with its last tag
 *
 * Runs inside the backend container (Docker socket), like backup.ts.
 */

import Dockerode from "dockerode";
import {
	isSessionContainer,
	listPins,
	type PinDocker,
	pinDockerOf,
	pinRef,
	pinSessionImages,
	pruneOrphanPins,
} from "./imagePins.js";

export interface StatusRow {
	container: string;
	state: string;
	imageId: string;
	imageExists: boolean;
	pinned: boolean;
}

export async function status(
	d: PinDocker,
): Promise<{ rows: StatusRow[]; missing: number; unpinned: number }> {
	const rows: StatusRow[] = [];
	for (const c of await d.listContainers()) {
		if (!isSessionContainer(c) || !c.ImageID) continue;
		const image = await d.inspectImage(c.ImageID);
		let pinned = false;
		try {
			pinned = (await d.inspectImage(pinRef(c.ImageID)))?.Id === c.ImageID;
		} catch {
			pinned = false;
		}
		rows.push({
			container: (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, ""),
			state: c.State ?? "?",
			imageId: c.ImageID,
			imageExists: image !== null,
			pinned,
		});
	}
	rows.sort((a, b) => a.container.localeCompare(b.container));
	return {
		rows,
		missing: rows.filter((r) => !r.imageExists).length,
		unpinned: rows.filter((r) => r.imageExists && !r.pinned).length,
	};
}

async function main(argv: string[]): Promise<number> {
	const [cmd = "status", flag] = argv;
	const d = pinDockerOf(new Dockerode({ socketPath: "/var/run/docker.sock" }));
	const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
	if (cmd === "status" && !flag) {
		const r = await status(d);
		out(r);
		// A preflight gate: 1 while any in-use image is gone or unprotected.
		return r.missing > 0 || r.unpinned > 0 ? 1 : 0;
	}
	if (cmd === "pin" && !flag) {
		const r = await pinSessionImages(d);
		out(r);
		return r.missing.length > 0 || r.failed.length > 0 ? 1 : 0;
	}
	if (cmd === "list" && !flag) {
		out(await listPins(d));
		return 0;
	}
	if (cmd === "prune" && (!flag || flag === "--write")) {
		out(await pruneOrphanPins(d, { write: flag === "--write" }));
		return 0;
	}
	process.stderr.write("usage: images:pins -- [status | pin | list | prune [--write]]\n");
	return 2;
}

if (typeof require !== "undefined" && require.main === module) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(err) => {
			process.stderr.write(`${(err as Error).message}\n`);
			process.exit(1);
		},
	);
}

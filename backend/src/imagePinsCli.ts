/**
 * imagePinsCli.ts — operator view of the session image pins (imagePins.ts).
 *
 *   npm run images:pins                    the GATE: GO (exit 0) only when
 *                                          protection is on, the exceptions
 *                                          file is valid, and every session
 *                                          container's image is pinned or
 *                                          excepted by its EXACT
 *                                          (containerId, imageId) pair. Any
 *                                          other state is NO-GO (exit 1): a
 *                                          new missing image, an unpinned one,
 *                                          a malformed/unprotected exceptions
 *                                          file, SESSION_IMAGE_PINS=off. Every
 *                                          exception used is printed.
 *   npm run images:pins -- pin             the boot pass, now (idempotent; it
 *                                          only ADDS tags)
 *   npm run images:pins -- list            every pin tag and what uses it
 *   npm run images:pins -- prune           orphan pins (no container uses the
 *                                          image), dry run
 *   npm run images:pins -- prune --write   removes those tags — the image
 *                                          goes with its last tag. Never
 *                                          automatic; run with the backend
 *                                          stopped (a spawn may be pinning).
 *
 * Exceptions: SESSION_IMAGE_PIN_EXCEPTIONS, default
 * <WORKSPACE_ROOT>/.st-image-pins/exceptions.json (root-owned, not
 * group/world-writable, outside every session's mounts).
 *
 * Runs inside the backend container (Docker socket), like backup.ts.
 */

import Dockerode from "dockerode";
import {
	defaultExceptionsPath,
	evaluate,
	fileExceptionsSource,
	listPins,
	loadExceptions,
	pinDockerOf,
	pinSessionImages,
	pinsEnabled,
	pruneOrphanPins,
} from "./imagePins.js";

async function main(argv: string[]): Promise<number> {
	const [cmd = "status", flag] = argv;
	const d = pinDockerOf(new Dockerode({ socketPath: "/var/run/docker.sock" }));
	const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
	if (cmd === "status" && !flag) {
		const wr = process.env.WORKSPACE_ROOT ?? "/var/shared-terminal/workspaces";
		const r = await evaluate(d, {
			pins: pinsEnabled(),
			exceptions: () =>
				loadExceptions(
					fileExceptionsSource(
						process.env.SESSION_IMAGE_PIN_EXCEPTIONS ?? defaultExceptionsPath(wr),
					),
				),
		});
		out(r);
		return r.gate === "GO" ? 0 : 1;
	}
	if (cmd === "pin" && !flag) {
		if (!pinsEnabled()) {
			process.stderr.write("SESSION_IMAGE_PINS=off: refusing to pin (protection disabled)\n");
			return 1;
		}
		const r = await pinSessionImages(d);
		out(r);
		return r.failed.length > 0 ? 1 : 0;
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

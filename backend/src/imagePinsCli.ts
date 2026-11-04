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
 *   npm run images:pins -- prune --write --backend-stopped
 *                                          removes those tags — the image
 *                                          goes with its last tag. Never
 *                                          automatic; refused without the
 *                                          acknowledgement that the backend
 *                                          is stopped (a spawn pins before it
 *                                          creates). Run via `docker compose
 *                                          run --rm app …` after `stop app`.
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
	// Same connection rule as DockerManager: DOCKER_HOST (the
	// docker-socket-proxy shape) when set, else the canonical socket.
	const d = pinDockerOf(
		new Dockerode(process.env.DOCKER_HOST ? undefined : { socketPath: "/var/run/docker.sock" }),
	);
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
	if (cmd === "prune" && !flag) {
		out(await pruneOrphanPins(d, { write: false }));
		return 0;
	}
	if (cmd === "prune" && flag === "--write") {
		// A spawn pins before it creates: a pin with no container yet is not
		// an orphan. Only with the backend stopped (`docker compose stop app`
		// then `docker compose run --rm app npm run images:pins -- prune
		// --write --backend-stopped`) is "no container uses it" final.
		if (argv[2] !== "--backend-stopped") {
			process.stderr.write(
				"prune --write needs --backend-stopped: stop the backend first (docker compose stop app), then run it with `docker compose run --rm app`\n",
			);
			return 2;
		}
		out(await pruneOrphanPins(d, { write: true }));
		return 0;
	}
	process.stderr.write(
		"usage: images:pins -- [status | pin | list | prune [--write --backend-stopped]]\n",
	);
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

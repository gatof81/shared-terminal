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
 *   npm run images:pins -- prune --write   DISABLED in this version (exit 2):
 *                                          a spawn pins before it creates, so
 *                                          a fresh pin has no container yet,
 *                                          and this process cannot prove the
 *                                          backend is not creating.
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
	type PinDocker,
	pinDockerOf,
	pinSessionImages,
	pinsEnabled,
	pruneOrphanPins,
} from "./imagePins.js";

export interface CliIo {
	out(v: unknown): void;
	err(line: string): void;
}

/** The CLI, testable: `d` is the Docker port, `env` the process env. */
export async function runImagePinsCli(
	argv: string[],
	d: PinDocker,
	env: NodeJS.ProcessEnv,
	io: CliIo,
): Promise<number> {
	const [cmd = "status", flag] = argv;
	if (cmd === "status" && !flag) {
		const wr = env.WORKSPACE_ROOT ?? "/var/shared-terminal/workspaces";
		const r = await evaluate(d, {
			pins: pinsEnabled(env),
			exceptions: () =>
				loadExceptions(
					fileExceptionsSource(env.SESSION_IMAGE_PIN_EXCEPTIONS ?? defaultExceptionsPath(wr)),
				),
		});
		io.out(r);
		return r.gate === "GO" ? 0 : 1;
	}
	if (cmd === "pin" && !flag) {
		if (!pinsEnabled(env)) {
			io.err("SESSION_IMAGE_PINS=off: refusing to pin (protection disabled)");
			return 1;
		}
		const r = await pinSessionImages(d);
		io.out(r);
		return r.failed.length > 0 ? 1 : 0;
	}
	if (cmd === "list" && !flag) {
		io.out(await listPins(d));
		return 0;
	}
	if (cmd === "prune" && !flag) {
		io.out(await pruneOrphanPins(d, { write: false }));
		return 0;
	}
	if (cmd === "prune") {
		// DISABLED, whatever the flags (owner review of #521). A spawn pins
		// BEFORE it creates, so a fresh pin has no container yet; nothing a
		// separate process can check proves the backend is not creating at
		// that moment. Postponing cleanup costs disk; an untag at the wrong
		// moment can cost an image. The library keeps the re-checked removal
		// for a future version that can exclude creates.
		io.err(
			"prune --write is disabled in this version: only the dry run (`images:pins -- prune`) is available",
		);
		return 2;
	}
	io.err("usage: images:pins -- [status | pin | list | prune]");
	return 2;
}

async function main(argv: string[]): Promise<number> {
	// Same connection rule as DockerManager: DOCKER_HOST (the
	// docker-socket-proxy shape) when set, else the canonical socket.
	const d = pinDockerOf(
		new Dockerode(process.env.DOCKER_HOST ? undefined : { socketPath: "/var/run/docker.sock" }),
	);
	return runImagePinsCli(argv, d, process.env, {
		out: (v) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`),
		err: (l) => process.stderr.write(`${l}\n`),
	});
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

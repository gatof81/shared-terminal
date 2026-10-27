/**
 * Test-only: a minimal ustar writer producing what dockerd's archiver
 * emits (with pax records for long names), so the parser and the engine
 * are exercised on real tar bytes.
 */

export interface BuildEntry {
	path: string;
	type?: "file" | "dir" | "symlink" | "fifo";
	data?: Buffer | string;
	linkname?: string;
	/** Force a pax `path` record even for a short name. */
	pax?: boolean;
	/** Use a GNU `L` long-name entry instead of pax. */
	gnuLong?: boolean;
	/** The pax `path` value when it should differ from `path`. */
	paxPath?: string;
}

function header(name: string, size: number, typeflag: string, linkname = ""): Buffer {
	const h = Buffer.alloc(512, 0);
	h.write(name.slice(0, 100), 0, "utf8");
	h.write("0000644\0", 100, "ascii");
	h.write("0001750\0", 108, "ascii");
	h.write("0001750\0", 116, "ascii");
	h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
	h.write("00000000000\0", 136, "ascii");
	h.write(typeflag, 156, "ascii");
	h.write(linkname.slice(0, 100), 157, "utf8");
	h.write("ustar\0", 257, "ascii");
	h.write("00", 263, "ascii");
	h.fill(0x20, 148, 156);
	let sum = 0;
	for (const b of h) sum += b;
	h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
	return h;
}

function padded(data: Buffer): Buffer {
	const rem = data.length % 512;
	return rem === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - rem)]);
}

function paxRecord(key: string, value: string): string {
	const body = ` ${key}=${value}\n`;
	let len = body.length;
	while (`${len}${body}`.length !== len) len = `${len}${body}`.length;
	return `${len}${body}`;
}

export function buildTar(entries: BuildEntry[]): Buffer {
	const parts: Buffer[] = [];
	for (const e of entries) {
		const type = e.type ?? "file";
		const data = type === "file" ? Buffer.from(e.data ?? "") : Buffer.alloc(0);
		const flag = { file: "0", dir: "5", symlink: "2", fifo: "6" }[type];
		let name = e.path;
		// `pax` + `gnuLong` together emits both (a malformed archive, for tests).
		if (e.pax || (!e.gnuLong && Buffer.byteLength(e.path) > 100)) {
			const rec = Buffer.from(paxRecord("path", e.paxPath ?? e.path));
			parts.push(header("PaxHeader", rec.length, "x"), padded(rec));
			name = e.path.slice(0, 100);
		}
		if (e.gnuLong) {
			const ln = Buffer.from(`${e.path}\0`);
			parts.push(header("././@LongLink", ln.length, "L"), padded(ln));
			name = e.path.slice(0, 100);
		}
		parts.push(header(name, data.length, flag, e.linkname ?? ""));
		if (data.length) parts.push(padded(data));
	}
	parts.push(Buffer.alloc(1024));
	return Buffer.concat(parts);
}

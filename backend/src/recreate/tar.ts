/**
 * recreate/tar.ts — a bounded, read-only tar parser for what
 * `docker getArchive` returns (CONVERSATION.md §2.7.1: `~/.gitconfig` and
 * `/opt/session-skills/**` read from a stopped or never-started
 * container).
 *
 * Deliberately small and strict instead of a dependency: ustar headers,
 * pax `x` records (path, linkpath, size) and GNU `L`/`K` long names —
 * what dockerd's archiver emits — and nothing is ever written to disk.
 * Anything malformed throws; callers treat a throw as "cannot verify",
 * which blocks (fail-closed).
 */

export type TarEntryType = "file" | "dir" | "symlink" | "other";

export interface TarEntry {
	/** As stored, without a leading "./" and without a trailing "/". */
	path: string;
	type: TarEntryType;
	/** Regular files only. */
	data?: Buffer;
	linkname?: string;
}

export interface TarLimits {
	maxEntries: number;
	maxFileBytes: number;
}

export class TarFormatError extends Error {
	constructor(message: string) {
		super(`tar: ${message}`);
		this.name = "TarFormatError";
	}
}

const BLOCK = 512;

function cstr(buf: Buffer, off: number, len: number): string {
	const slice = buf.subarray(off, off + len);
	const nul = slice.indexOf(0);
	return slice.subarray(0, nul < 0 ? slice.length : nul).toString("utf8");
}

function octal(buf: Buffer, off: number, len: number): number {
	const field = buf.subarray(off, off + len);
	if (field[0]! & 0x80) {
		// GNU base-256: only sizes that fit a JS safe integer are accepted.
		let v = 0;
		for (let i = 1; i < field.length; i++) {
			v = v * 256 + field[i]!;
			if (v > Number.MAX_SAFE_INTEGER) throw new TarFormatError("size overflow");
		}
		return v;
	}
	const s = cstr(buf, off, len).trim();
	if (s === "") return 0;
	if (!/^[0-7]+$/.test(s)) throw new TarFormatError("bad octal field");
	return Number.parseInt(s, 8);
}

function checksumOk(header: Buffer): boolean {
	const stored = octal(header, 148, 8);
	let sum = 0;
	for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
	return sum === stored;
}

function parsePax(data: Buffer): Map<string, string> {
	const out = new Map<string, string>();
	let off = 0;
	while (off < data.length) {
		const sp = data.indexOf(0x20, off);
		if (sp < 0) throw new TarFormatError("bad pax record");
		const len = Number.parseInt(data.subarray(off, sp).toString("ascii"), 10);
		if (!Number.isInteger(len) || len <= 0 || off + len > data.length) {
			throw new TarFormatError("bad pax record length");
		}
		const rec = data.subarray(sp + 1, off + len - 1).toString("utf8");
		const eq = rec.indexOf("=");
		if (eq < 0) throw new TarFormatError("bad pax record");
		out.set(rec.slice(0, eq), rec.slice(eq + 1));
		off += len;
	}
	return out;
}

/**
 * Rejected here, not left to callers: the archive comes from a container,
 * and an entry that names its way out of the archive root is malformed
 * for every use, present or future.
 */
function normalise(p: string): string {
	let s = p;
	while (s.startsWith("./")) s = s.slice(2);
	while (s.endsWith("/")) s = s.slice(0, -1);
	if (s.startsWith("/") || s.split("/").some((seg) => seg === "..")) {
		throw new TarFormatError(`path escapes the archive root: ${p}`);
	}
	return s;
}

export function parseTar(buf: Buffer, limits: TarLimits): TarEntry[] {
	const entries: TarEntry[] = [];
	let off = 0;
	let pax: Map<string, string> | null = null;
	let longName: string | null = null;
	let longLink: string | null = null;
	while (off + BLOCK <= buf.length) {
		const header = buf.subarray(off, off + BLOCK);
		if (header.every((b) => b === 0)) {
			// End of archive is TWO zero blocks (POSIX): a lone one followed
			// by anything else, or by nothing, is a damaged archive.
			const next = buf.subarray(off + BLOCK, off + 2 * BLOCK);
			if (next.length === BLOCK && next.every((b) => b === 0)) return entries;
			throw new TarFormatError("archive not terminated");
		}
		if (!checksumOk(header)) throw new TarFormatError("bad header checksum");
		const typeflag = String.fromCharCode(header[156]!) || "0";
		let size = octal(header, 124, 12);
		if (pax?.has("size")) {
			size = Number(pax.get("size"));
			if (!Number.isSafeInteger(size) || size < 0) throw new TarFormatError("bad pax size");
		}
		const dataStart = off + BLOCK;
		const dataEnd = dataStart + size;
		if (dataEnd > buf.length) throw new TarFormatError("truncated entry");
		const data = buf.subarray(dataStart, dataEnd);
		off = dataStart + Math.ceil(size / BLOCK) * BLOCK;

		if (typeflag === "x") {
			pax = parsePax(data);
			continue;
		}
		if (typeflag === "g") continue; // global pax header: nothing we use
		if (typeflag === "L") {
			longName = cstr(data, 0, data.length);
			continue;
		}
		if (typeflag === "K") {
			longLink = cstr(data, 0, data.length);
			continue;
		}

		const magic = cstr(header, 257, 6);
		const prefix = magic.startsWith("ustar") ? cstr(header, 345, 155) : "";
		let name = cstr(header, 0, 100);
		if (prefix) name = `${prefix}/${name}`;
		name = pax?.get("path") ?? longName ?? name;
		const linkname = pax?.get("linkpath") ?? longLink ?? cstr(header, 157, 100);
		pax = null;
		longName = null;
		longLink = null;

		const type: TarEntryType =
			typeflag === "0" || typeflag === "\0" || typeflag === "7"
				? "file"
				: typeflag === "5"
					? "dir"
					: typeflag === "2"
						? "symlink"
						: "other";
		if (entries.length >= limits.maxEntries) throw new TarFormatError("too many entries");
		const entry: TarEntry = { path: normalise(name), type };
		if (type === "file") {
			if (size > limits.maxFileBytes) throw new TarFormatError("file too large");
			entry.data = Buffer.from(data);
		}
		if (type === "symlink") entry.linkname = linkname;
		entries.push(entry);
	}
	// dockerd always terminates the archive; running off the end means the
	// stream was cut short.
	throw new TarFormatError("archive not terminated");
}

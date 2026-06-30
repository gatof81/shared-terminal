/**
 * format.ts — pure presentational formatters shared by the session list
 * (main.ts) and the admin dashboard (admin.ts). No DOM, no state — a leaf
 * module with no circular-import risk. Extracted in #312.
 */

export function formatCpuPercent(pct: number): string {
	// 1 decimal — same precision the backend rounds to (see r1() in
	// routes.ts). Locks the two outputs to match.
	return `${pct.toFixed(1)}%`;
}

export function formatCpuCores(cores: number): string {
	// `Number.parseFloat(toFixed(2))` drops trailing zeros: 2.00 → 2,
	// 1.25 → 1.25. The UI is friendlier without "2.00 cores".
	return String(Number.parseFloat(cores.toFixed(2)));
}

export function formatBytes(b: number): string {
	if (b < 1024) return `${b} B`;
	if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KiB`;
	if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(0)} MiB`;
	return `${(b / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

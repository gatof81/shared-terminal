/**
 * format.ts — pure presentational formatters shared by the session list
 * (main.ts), the admin dashboard (admin.ts) and the Git and Chat views. No DOM, no state — a leaf
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

/** "just now" / "5 min ago" / "3 h ago" / "2 d ago" / a date past a month. */
export function relativeDate(iso: string, now = Date.now()): string {
	const t = new Date(iso).getTime();
	if (Number.isNaN(t)) return iso;
	const s = Math.max(0, Math.round((now - t) / 1000));
	if (s < 60) return "just now";
	const m = Math.round(s / 60);
	if (m < 60) return `${m} min ago`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h} h ago`;
	const d = Math.round(h / 24);
	if (d < 31) return `${d} d ago`;
	return new Date(t).toLocaleDateString();
}

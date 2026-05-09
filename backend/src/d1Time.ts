// ── d1Time ──────────────────────────────────────────────────────────────────
//
// D1's `datetime('now')` returns SQLite's canonical UTC format
// (`YYYY-MM-DD HH:MM:SS`) with no `Z`, no offset, nothing. Node's `new Date()`
// treats suffix-less ISO strings as LOCAL time on every engine — so a row
// written at `2024-01-01 10:00:00` (UTC, from D1) becomes a `Date` three
// hours off on a UTC-3 machine. Append `Z` unless the value already carries
// a suffix; double-`Z` parses as `Invalid Date` and silently `NaN`s.
//
// Three modules independently grew this same helper (sessionManager,
// sessionConfig, templates) — consolidate so a future migration that
// changes D1's timestamp shape is a one-file fix.

export function parseD1Utc(raw: string, context = "D1"): Date {
	const hasSuffix = /[zZ]$/.test(raw) || /[+-]\d{2}:?\d{2}$/.test(raw);
	const d = new Date(hasSuffix ? raw : `${raw}Z`);
	if (Number.isNaN(d.getTime())) {
		// Crash loudly here rather than letting an `Invalid Date` propagate
		// — once it serialises through `toJSON()` it becomes `null` and the
		// failure shows up far away from this module.
		throw new Error(`${context}: unparseable timestamp ${raw}`);
	}
	return d;
}

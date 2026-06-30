/**
 * ports.ts — exposed-ports editor modal (#190): live-edit the declared
 * config.ports[] of an existing session. Extracted from main.ts (#312).
 *
 * Same circular-import-safe pattern as admin.ts: DOM re-queried locally;
 * main.ts imports used only inside functions.
 */

import { getSessionPorts, type PortSpec, updateSessionPorts } from "./api.js";
import { activeSessionId, showToast } from "./main.js";

// ── DOM (re-queried locally; see header) ─────────────────────────────────
const portsBtn = document.getElementById("ports-btn") as HTMLButtonElement;
const portsModal = document.getElementById("ports-modal")!;
const portsModalTableBody = document.getElementById(
	"ports-modal-table-body",
) as HTMLTableSectionElement;
const portsModalAddRowBtn = document.getElementById("ports-modal-add-row") as HTMLButtonElement;
const portsModalSaveBtn = document.getElementById("ports-modal-save") as HTMLButtonElement;
const portsModalErrorEl = document.getElementById("ports-modal-error") as HTMLParagraphElement;
const portsModalPrivilegedHint = document.getElementById(
	"ports-modal-privileged-hint",
) as HTMLParagraphElement;

// ── Exposed-ports editor (#190) ────────────────────────────────────────────
//
// Per-session live edit of `config.ports[]`. Opened from the terminal
// toolbar; loads the declared set (GET /sessions/:id/ports), lets the owner
// add/remove rows + toggle public, and PATCHes the whole set. Changes apply
// immediately on a running session — the dispatcher proxies the container by
// name over the shared network, so there's no recycle. The privileged-port
// rule is enforced server-side (the cap is fixed at create time); we surface
// its rejection inline rather than pre-validating against a stale toggle.

interface PortsModalRow {
	id: string;
	container: string; // raw input value; parsed on save
	public: boolean;
}

let portsModalRows: PortsModalRow[] = [];
let portsModalSessionId: string | null = null;
let portsModalPrivilegedAllowed = false;
let portsModalRowSeq = 0;

function newPortsModalRowId(): string {
	portsModalRowSeq += 1;
	return `pm-${portsModalRowSeq}`;
}

function setPortsModalError(message: string | null): void {
	if (message) {
		portsModalErrorEl.textContent = message;
		portsModalErrorEl.hidden = false;
	} else {
		portsModalErrorEl.textContent = "";
		portsModalErrorEl.hidden = true;
	}
}

// Pull current input values out of the DOM into `portsModalRows` before any
// re-render or save, so in-progress edits aren't lost (mirrors the create
// form's `syncPortRowsFromDom`).
function syncPortsModalRowsFromDom(): void {
	const trs = portsModalTableBody.querySelectorAll<HTMLTableRowElement>(".ports-modal-row");
	for (const tr of trs) {
		const id = tr.dataset.rowId;
		const row = portsModalRows.find((r) => r.id === id);
		if (!row) continue;
		const input = tr.querySelector<HTMLInputElement>(".ports-modal-port-input");
		const checkbox = tr.querySelector<HTMLInputElement>(".ports-modal-public-input");
		if (input) row.container = input.value;
		if (checkbox) row.public = checkbox.checked;
	}
}

function renderPortsModalRows(): void {
	portsModalTableBody.textContent = "";
	if (portsModalRows.length === 0) {
		const tr = document.createElement("tr");
		const td = document.createElement("td");
		td.colSpan = 3;
		td.className = "modal-hint";
		td.textContent = "No ports exposed. Add one to make it reachable.";
		tr.appendChild(td);
		portsModalTableBody.appendChild(tr);
		return;
	}
	for (const row of portsModalRows) {
		const tr = document.createElement("tr");
		tr.className = "ports-modal-row";
		tr.dataset.rowId = row.id;

		const portTd = document.createElement("td");
		const input = document.createElement("input");
		input.type = "number";
		input.min = "1";
		input.max = "65535";
		input.placeholder = "e.g. 3000";
		input.className = "ports-modal-port-input";
		input.value = row.container;
		portTd.appendChild(input);

		const publicTd = document.createElement("td");
		const checkbox = document.createElement("input");
		checkbox.type = "checkbox";
		checkbox.className = "ports-modal-public-input";
		checkbox.checked = row.public;
		checkbox.setAttribute("aria-label", "Public (no authentication)");
		publicTd.appendChild(checkbox);

		const removeTd = document.createElement("td");
		const removeBtn = document.createElement("button");
		removeBtn.type = "button";
		removeBtn.className = "ports-modal-remove";
		removeBtn.setAttribute("aria-label", "Remove port");
		removeBtn.dataset.rowId = row.id;
		removeBtn.textContent = "×";
		removeTd.appendChild(removeBtn);

		tr.appendChild(portTd);
		tr.appendChild(publicTd);
		tr.appendChild(removeTd);
		portsModalTableBody.appendChild(tr);
	}
}

function openPortsModal(): void {
	if (!activeSessionId) return;
	const sessionId = activeSessionId;
	portsModalSessionId = sessionId;
	portsModalRows = [];
	setPortsModalError(null);
	portsModalPrivilegedHint.hidden = true;
	portsModalTableBody.textContent = "";
	const loading = document.createElement("tr");
	const loadingCell = document.createElement("td");
	loadingCell.colSpan = 3;
	loadingCell.className = "modal-hint";
	loadingCell.textContent = "Loading…";
	loading.appendChild(loadingCell);
	portsModalTableBody.appendChild(loading);
	portsModal.classList.add("open");
	portsModal.setAttribute("aria-hidden", "false");
	void (async () => {
		try {
			const data = await getSessionPorts(sessionId);
			// The session may have changed under us while the fetch was in
			// flight (user clicked another session); bail if so.
			if (portsModalSessionId !== sessionId) return;
			portsModalPrivilegedAllowed = data.allowPrivilegedPorts;
			portsModalPrivilegedHint.hidden = data.allowPrivilegedPorts;
			portsModalRows = data.ports.map((p) => ({
				id: newPortsModalRowId(),
				container: String(p.container),
				public: p.public,
			}));
			renderPortsModalRows();
		} catch (err) {
			showToast((err as Error).message, true);
			closePortsModal();
		}
	})();
}

function closePortsModal(): void {
	portsModal.classList.remove("open");
	portsModal.setAttribute("aria-hidden", "true");
	portsModalSessionId = null;
}

async function savePortsModal(): Promise<void> {
	if (!portsModalSessionId) return;
	syncPortsModalRowsFromDom();
	setPortsModalError(null);

	// Client-side validation mirrors the server schema so the common
	// mistakes get an instant, row-specific message instead of a round-trip.
	const ports: PortSpec[] = [];
	const seen = new Set<number>();
	for (const row of portsModalRows) {
		const trimmed = row.container.trim();
		if (trimmed === "") {
			setPortsModalError("Every row needs a port number (or remove the empty row).");
			return;
		}
		const n = Number(trimmed);
		if (!Number.isInteger(n) || n < 1 || n > 65535) {
			setPortsModalError(`"${trimmed}" is not a valid port (1–65535).`);
			return;
		}
		if (seen.has(n)) {
			setPortsModalError(`Port ${n} is listed more than once.`);
			return;
		}
		if (n < 1024 && !portsModalPrivilegedAllowed) {
			setPortsModalError(
				`Port ${n} is privileged (< 1024). Recreate the session with privileged ports enabled to expose it.`,
			);
			return;
		}
		seen.add(n);
		ports.push({ container: n, public: row.public });
	}

	const sessionId = portsModalSessionId;
	portsModalSaveBtn.disabled = true;
	try {
		await updateSessionPorts(sessionId, ports);
		showToast("Ports updated");
		closePortsModal();
	} catch (err) {
		// Surface the backend message inline (e.g. the privileged-port
		// rejection if the client-side check was bypassed).
		setPortsModalError((err as Error).message);
	} finally {
		portsModalSaveBtn.disabled = false;
	}
}

portsModalAddRowBtn.addEventListener("click", () => {
	syncPortsModalRowsFromDom();
	setPortsModalError(null);
	portsModalRows.push({ id: newPortsModalRowId(), container: "", public: false });
	renderPortsModalRows();
	// Focus the freshly-added row's input.
	const last = portsModalTableBody.querySelector<HTMLTableRowElement>(
		".ports-modal-row:last-child",
	);
	last?.querySelector<HTMLInputElement>(".ports-modal-port-input")?.focus();
});

portsModalTableBody.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	const removeBtn = target.closest<HTMLButtonElement>(".ports-modal-remove");
	if (!removeBtn) return;
	const id = removeBtn.dataset.rowId;
	syncPortsModalRowsFromDom();
	portsModalRows = portsModalRows.filter((r) => r.id !== id);
	renderPortsModalRows();
});

portsModalSaveBtn.addEventListener("click", () => void savePortsModal());

portsModal.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	if (target.hasAttribute("data-close-modal")) closePortsModal();
});

portsBtn.addEventListener("click", () => openPortsModal());

export { closePortsModal };

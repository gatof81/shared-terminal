/**
 * invites.ts — invite-code mint/list/revoke modal (admin-only, #50).
 * Extracted from main.ts (#312). Same TDZ-safe pattern as admin.ts: DOM
 * re-queried locally; the main.ts import (showToast) is used only inside
 * functions. The global Escape-key handler stays in main.ts and calls
 * closeInvitesModal (exported here).
 */

import { createInvite, type Invite, listInvites, revokeInvite } from "./api.js";
import { alertDialog, confirmDialog, createDialog } from "./components/dialog.js";
import { showToast } from "./main.js";

// ── DOM (re-queried locally; see header) ─────────────────────────────────
const invitesBtn = document.getElementById("invites-btn") as HTMLButtonElement;
const invitesModal = document.getElementById("invites-modal")!;
const inviteCreateBtn = document.getElementById("invite-create-btn") as HTMLButtonElement;
const inviteList = document.getElementById("invite-list")!;
const sidebarInvitesBtn = document.getElementById("sidebar-invites-btn") as HTMLButtonElement;

// ── Invites modal ───────────────────────────────────────────────────────────

// The dialog returns focus to whichever button opened it (header on
// desktop, sidebar footer on mobile — the other one is display:none).
const invitesDialog = createDialog(invitesModal, { initialFocus: () => inviteCreateBtn });

function openInvitesModal(opener: HTMLButtonElement) {
	invitesDialog.open(opener);
	void renderInvites();
}

function closeInvitesModal() {
	invitesDialog.close();
}

async function renderInvites() {
	inviteList.textContent = "Loading…";
	let invites: Invite[];
	try {
		invites = await listInvites();
	} catch (err) {
		inviteList.textContent = "";
		showToast((err as Error).message, true);
		return;
	}

	inviteList.textContent = "";
	if (invites.length === 0) {
		const empty = document.createElement("div");
		empty.className = "invite-empty";
		empty.textContent = "No invites yet — generate one above.";
		inviteList.appendChild(empty);
		return;
	}

	for (const invite of invites) {
		const used = invite.usedAt !== null;
		// expires_at is server-stored as "YYYY-MM-DD HH:MM:SS" UTC. Swap
		// the space for "T" before appending "Z" so the result is valid
		// ISO 8601 — Safari rejects the space-separated form and returns
		// Invalid Date, which would silently misclassify expired invites
		// as Unused.
		const expired =
			!used &&
			invite.expiresAt !== null &&
			new Date(`${invite.expiresAt.replace(" ", "T")}Z`).getTime() <= Date.now();
		const inert = used || expired;
		const row = document.createElement("div");
		row.className = `invite-row${inert ? " used" : ""}`;

		const code = document.createElement("span");
		code.className = "invite-code";
		// Plaintext is gone post-#49 — show the 4-char prefix the server
		// kept for recognition, padded with U+2022 so it visually reads
		// as "starts with abc1, rest hidden" rather than a partial code
		// the user might try to share.
		code.textContent = `${invite.codePrefix}••••••••••••`;
		code.title = `Hash ${invite.codeHash}`;
		row.appendChild(code);

		const status = document.createElement("span");
		status.className = `invite-status ${inert ? "used" : "unused"}`;
		status.textContent = used ? "Used" : expired ? "Expired" : "Unused";
		if (!used && !expired && invite.expiresAt) {
			status.title = `Expires ${invite.expiresAt} UTC`;
		}
		row.appendChild(status);

		// No "Copy" affordance: the plaintext is no longer recoverable
		// from the list. The post-mint reveal in the click handler below
		// is the only window in which the user can copy the live code.

		// Revoke is offered for both unused and expired invites — the
		// backend DELETE matches WHERE used_at IS NULL, so expired-but-
		// unused codes can be cleared from the list. Quota slots are
		// already auto-freed by the expiry filter on the COUNT subquery,
		// so this is purely UI hygiene.
		if (!used) {
			const revokeBtn = document.createElement("button");
			revokeBtn.type = "button";
			revokeBtn.className = "invite-action-btn revoke";
			revokeBtn.textContent = "Revoke";
			revokeBtn.addEventListener("click", async () => {
				const ok = await confirmDialog({
					title: "Revoke invite",
					message: `Revoke the invite starting with "${invite.codePrefix}"? Anyone holding it will no longer be able to register.`,
					confirmLabel: "Revoke",
					danger: true,
				});
				if (!ok) return;
				revokeBtn.disabled = true;
				try {
					await revokeInvite(invite.codeHash);
					await renderInvites();
				} catch (err) {
					revokeBtn.disabled = false;
					showToast((err as Error).message, true);
				}
			});
			row.appendChild(revokeBtn);
		}

		inviteList.appendChild(row);
	}

	// Backend caps the response at INVITE_LIST_LIMIT=100 (#54). When we
	// hit that boundary, the modal is silently truncated — surface a
	// hint so a user with > 100 historical invites isn't misled into
	// thinking that's everything. Real cursor pagination is overkill
	// today; this footer is the cheap signal that something was elided.
	const SERVER_INVITE_LIMIT = 100;
	if (invites.length === SERVER_INVITE_LIMIT) {
		const footer = document.createElement("div");
		footer.className = "invite-empty";
		footer.textContent = "Older invites not shown — only the most recent 100 are listed.";
		inviteList.appendChild(footer);
	}
}

invitesBtn.addEventListener("click", () => openInvitesModal(invitesBtn));
sidebarInvitesBtn.addEventListener("click", () => openInvitesModal(sidebarInvitesBtn));

// Mint flow: the server returns plaintext exactly once. We copy it to the
// clipboard and, when that fails, show it in a dialog the person must
// dismiss before the list refreshes (which only carries the prefix from
// this point on). The dialog node is removed on close, so the code does
// not linger in the DOM afterwards.
inviteCreateBtn.addEventListener("click", async () => {
	inviteCreateBtn.disabled = true;
	try {
		const minted = await createInvite();
		try {
			await navigator.clipboard.writeText(minted.code);
			// Don't echo the code into the toast — the clipboard already
			// has it, and the toast element keeps its text in the DOM
			// for the lifetime of the page. Cheap defense in depth on
			// top of the textContent-clearing in showToast itself.
			showToast("Invite code copied to clipboard");
		} catch {
			// Clipboard write can fail under permission-denied / non-secure-
			// context. Show the plaintext so it still reaches the user
			// before it's gone forever.
			await alertDialog({
				title: "Invite code",
				message: `This code won't be shown again — copy it now:\n\n${minted.code}\n\nShare it with the person you want to invite.`,
				okLabel: "I copied it",
			});
		}
		await renderInvites();
	} catch (err) {
		showToast((err as Error).message, true);
	} finally {
		inviteCreateBtn.disabled = false;
	}
});

export { closeInvitesModal };

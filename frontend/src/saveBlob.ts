/**
 * saveBlob.ts — hand a fetched Blob to the browser as a "save file"
 * gesture. Shared by the actions-menu download (#358) and the Workspace
 * Explorer's Download button.
 *
 * The blob → object-URL → synthetic <a download> dance is what makes the
 * browser treat a credentialed fetch result as a download; see
 * downloadSessionFile in api.ts for why fetch+blob beats a plain <a>
 * navigation to the API origin.
 */
export function saveBlob(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	// Revoke on a delay, not immediately — the click only ENQUEUES the
	// save; revoking synchronously races the browser's read of the
	// object URL and can yield an empty download on slower devices.
	setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

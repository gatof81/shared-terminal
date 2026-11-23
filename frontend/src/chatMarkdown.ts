// chatMarkdown.ts — an agent's text as the chats show it: rendered Markdown
// (markdown.ts, textContent-only) with a Copy button on every code block.
// Used by the ACP chats (acpThread.ts), so a report reads the same in all of them.

import { copyText } from "./clipboard.js";
import { showCopySuccessToast, showToast } from "./components/toast.js";
import { renderMarkdown } from "./markdown.js";
import { appRouteHash } from "./router.js";
import { button, el } from "./ui.js";

function copyButton(label: string, text: () => string, title?: string): HTMLButtonElement {
	const b = button(
		label,
		"files-btn chat-copy",
		() => {
			void copyText(text(), b).then(
				(ok) => (ok ? showCopySuccessToast() : showToast("Copy failed", true)),
				() => showToast("Copy failed", true),
			);
		},
		title,
	);
	return b;
}

/**
 * Rendered Markdown with a Copy button on every code block. A link to a place
 * of the app (router.appRouteHash) navigates there; agent text is untrusted,
 * so anything else keeps markdown.ts's rules.
 */
export function markdownBlock(text: string): HTMLElement {
	const md = renderMarkdown(text, { appRoute: appRouteHash });
	md.classList.add("chat-md");
	for (const pre of [...md.querySelectorAll<HTMLElement>("pre.md-pre")]) {
		const wrap = el("div", "chat-pre");
		pre.replaceWith(wrap);
		wrap.appendChild(pre);
		const code = pre.textContent ?? "";
		wrap.appendChild(copyButton("Copy", () => code, "Copy code"));
	}
	return md;
}

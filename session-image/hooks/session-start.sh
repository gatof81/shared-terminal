#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# Conversation capture — SessionStart registration hook (docs/CONVERSATION.md
# §2.3). Installed at /opt/st/hooks/session-start.sh (root, 0755). It only
# runs when the backend mounted a conversation.json into
# /etc/claude-code/managed-settings.d/, which names it as the one `command`
# hook (`async: true`); every other event goes out as a `type: "http"` hook
# from the CLI itself to the container's loopback relay (§2.6).
#
# SessionStart is the one event that can't use an http hook, so this script
# posts its stdin JSON to the same relay, adding an `st` block
# with what only the container knows: the CLI version, the tmux session and
# pane, and an allowlisted subset of the parent CLI's flags.
#
# The CLI does not enforce `timeout` on async command hooks, so the script
# bounds itself: the whole thing, children included, is under one
# `timeout -k 1 5` (≤ 6 s whatever happens), and each child has its own,
# smaller cap. It never writes to stdout (an async hook's stdout is fed back
# to the agent as context) and always exits 0: observability must never be
# visible to the agent or block it.
# ──────────────────────────────────────────────────────────────────────────────
[ -z "${ST_HOOK_WRAPPED:-}" ] && ST_HOOK_WRAPPED=1 exec timeout -k 1 5 /bin/bash "$0" "$@"

# No token ⇒ the backend did not activate this session: no output, no network.
[ -n "${ST_INGEST_TOKEN:-}" ] || exit 0

if [ "${ST_HOOKS_DEBUG:-}" != "1" ]; then exec 2>/dev/null; fi
exec >/dev/null

INGEST_URL="http://127.0.0.1:47613/ingest/claude/hook"

# The SessionStart input is a small JSON object; cap the read so a broken
# producer can't make us buffer without bound.
input=$(head -c 65536)
[ -n "$input" ] || exit 0

claude_version=$(timeout 3 claude --version 2>/dev/null | head -c 64) || claude_version=""

# Only ask tmux when this process actually runs inside a tmux pane: without
# $TMUX a bare `tmux display-message` would answer for whatever server it
# finds (the exec API's `-p` runs have no pane), and `-t` pins the answer to
# our own pane rather than the server's current client.
tmux_session=""
if [ -n "${TMUX:-}" ] && [ -n "${TMUX_PANE:-}" ]; then
	tmux_session=$(timeout 1 tmux display-message -p -t "$TMUX_PANE" '#S' 2>/dev/null | head -c 64) || tmux_session=""
fi

# The parent CLI's flags. The hook is not a direct child of the CLI (the
# CLI's `/bin/sh -c`, then our `timeout`, sit in between), so walk up /proc
# to the `claude` that fired it — through those intermediaries only: a walk
# that crossed anything else could land on an unrelated `claude` further up
# (the hook run by hand from a shell inside a session, say) and report its
# flags as this conversation's. Only allowlisted flags leave the container, and
# a value only for the four flags whose value is a name: the full argv can
# carry --append-system-prompt text, paths or secrets (§2.3). The backend
# filters again (redact.ts filterArgvFlags); this is the first of two gates.
argv_flags=()
find_claude_pid() {
	local pid=$PPID i argv0
	for i in 1 2 3 4 5 6 7 8; do
		[ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null || return 1
		argv0=$(tr '\0' '\n' <"/proc/$pid/cmdline" 2>/dev/null | head -n 1)
		case "${argv0##*/}" in
		claude | claude.exe) echo "$pid"; return 0 ;;
		timeout | sh | bash | dash) ;;
		*) return 1 ;;
		esac
		pid=$(awk '{ sub(/^.*\) /, ""); print $2 }' "/proc/$pid/stat" 2>/dev/null)
	done
	return 1
}
if claude_pid=$(find_claude_pid); then
	mapfile -d '' -t argv <"/proc/$claude_pid/cmdline"
	for ((i = 1; i < ${#argv[@]} && ${#argv_flags[@]} < 32; i++)); do
		tok=${argv[i]} flag=${argv[i]%%=*}
		case "$flag" in
		--agent-name | --agent-type | --teammate-mode | --permission-mode)
			if [[ "$tok" == *=* ]]; then value=${tok#*=}; else
				value=${argv[i + 1]:-}
				i=$((i + 1))
			fi
			# Over the cap ⇒ the flag alone: a clipped name would be a
			# different, misleading name.
			if [ "$(printf %s "$value" | wc -c)" -le 64 ]; then
				argv_flags+=("$flag=$value")
			else
				argv_flags+=("$flag")
			fi
			;;
		-p | --print | --bare | --resume | --continue | --fork-session | --agent | --agent-id | \
			--dangerously-skip-permissions)
			argv_flags+=("$flag")
			;;
		esac
	done
fi

body=$(
	printf '%s\n' "${argv_flags[@]}" | jq -c -R -s \
		--argjson input "$input" \
		--arg claude_version "$claude_version" \
		--arg tmux_session "$tmux_session" \
		--arg pane "${TMUX_PANE:-}" \
		'def nn: if . == "" then null else . end;
		($input | if type == "object" then . else error("not an object") end)
		+ { st: {
			claude_version: ($claude_version | rtrimstr("\n") | nn),
			tmux_session: ($tmux_session | rtrimstr("\n") | nn),
			pane: ($pane | nn),
			argv_flags: (split("\n") | map(select(. != "")))
		} }'
) || exit 0

# To the container's relay (docs/CONVERSATION.md §2.6), like every HTTP
# hook, so session_start takes the same single ordered path to the backend.
# No token here: the relay adds it. `-q` ignores any ~/.curlrc and
# `--noproxy '*'` any *_proxy env, so neither can send the event elsewhere.
printf '%s' "$body" | curl -q --silent --noproxy '*' --max-time 2 --output /dev/null \
	-X POST -H 'Content-Type: application/json' -H "X-ST-Tmux-Pane: ${TMUX_PANE:-}" \
	--data-binary @- "$INGEST_URL"
exit 0

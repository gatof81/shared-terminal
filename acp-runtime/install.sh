#!/usr/bin/env bash
# Installs one pinned ACP adapter bundle into the runtime dir that the backend
# binds read-only into agent sessions at /opt/st-acp. Independent of the session
# image: any image with Node >= 22 runs it. Re-running is a no-op.
#   acp-runtime/install.sh <runtime-dir> [adapter-version]
# Creates <runtime-dir>/claude-acp-<version>/{node_modules,agent}. The backend
# picks one with ACP_DEFAULT_RUNTIME (default claude-acp-0.108.0) per new agent.
set -euo pipefail
dir=${1:?runtime dir}
ver=${2:-0.108.0}
dest="$dir/claude-acp-$ver"
if [ -x "$dest/agent" ]; then echo "present: $dest"; exit 0; fi
mkdir -p "$dest.tmp"
cd "$dest.tmp"
npm init -y >/dev/null
npm install --no-audit --no-fund --save-exact "@agentclientprotocol/claude-agent-acp@$ver" >/dev/null
printf '#!/bin/sh\nexec node "%s/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js" "$@"\n' "/opt/st-acp/claude-acp-$ver" > agent
chmod 755 agent
cd .. && mv "$dest.tmp" "$dest"
chmod -R a+rX "$dest"
echo "installed: $dest"

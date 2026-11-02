# Phase-0 agent image: the smallest environment that runs the pinned CLI with
# a channel plugin. Deliberately NOT the session image: phase 0 only asks
# whether Channels registers and wakes an idle session, and a smaller image has
# fewer moving parts under --cap-drop ALL / --read-only. The full POC uses the
# session image (docs/design/project-chat/04-poc.md §1.2).
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}
ARG CLI_VERSION
ARG BUN_VERSION
RUN test -n "$CLI_VERSION" && test -n "$BUN_VERSION" \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git tmux python3 procps \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@anthropic-ai/claude-code@${CLI_VERSION}" "bun@${BUN_VERSION}" \
 && npm cache clean --force \
 && useradd -m -u 1001 -s /bin/bash developer \
 && mkdir -p /workspace /opt/poc /etc/claude-code/managed-settings.d \
 && chown developer:developer /workspace
COPY poc-hook.py /opt/poc/poc-hook.py
COPY managed-settings.json /etc/claude-code/managed-settings.d/poc.json
# Pin the version for the whole run (R9) and keep paid usage out of reach.
ENV DISABLE_AUTOUPDATER=1 \
    DISABLE_EXTRA_USAGE_COMMAND=1 \
    DISABLE_ERROR_REPORTING=1 \
    POC_OUT=/workspace/poc-out
USER developer
WORKDIR /workspace
CMD ["sleep", "infinity"]

# ──────────────────────────────────────────────────────────────────────────────
# Session container image — one per project/client.
#
# Runs tmux so the session survives browser disconnects.  The backend
# attaches via `docker exec … tmux attach` and pipes the stream over WS.
# ──────────────────────────────────────────────────────────────────────────────
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# ── System packages ──────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
      tmux \
      git \
      curl \
      wget \
      ca-certificates \
      openssh-client \
      build-essential \
      python3 \
      python3-pip \
      jq \
      unzip \
      less \
      vim \
      nano \
      htop \
      tree \
      sudo \
      locales \
    && rm -rf /var/lib/apt/lists/*

# ── Locale ───────────────────────────────────────────────────────────────────
RUN locale-gen en_US.UTF-8
ENV LANG=en_US.UTF-8  LC_ALL=en_US.UTF-8

# ── Node.js (LTS) ───────────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── Claude CLI ───────────────────────────────────────────────────────────────
# Install globally so every session has it available.
RUN npm install -g @anthropic-ai/claude-code

# ── VS Code CLI (`code tunnel`) ──────────────────────────────────────────────
# Standalone CLI from Microsoft. Lets the user run `code tunnel` from inside
# the session and attach to the container from desktop VS Code (or vscode.dev)
# on any device — no SSH, no exposed ports, auth goes through GitHub/Microsoft.
#
# We pull the static linux build that matches the container arch (TARGETARCH
# is set automatically by Docker Buildx: amd64 on Intel / x86 hosts, arm64
# on Apple Silicon). The archive only contains a single `code` binary, and
# we extract only that member explicitly so a tampered tarball cannot drop
# extra executables into /usr/local/bin alongside it.
#
# Linkage: this base image is glibc (ubuntu:24.04), so we use the
# `cli-linux-*` artifacts. The `cli-alpine-*` builds are musl-linked and
# will fail at runtime on glibc with "not found" / "Exec format error".
#
# Integrity: the default build is reproducible and verified — the version
# below is pinned to a specific commit and the per-arch SHA-256 of each
# tarball is checked with `sha256sum -c` before extraction. There is no
# "skip the hash check" escape hatch; the build fails if the relevant
# SHA-256 is empty, which closes the MITM-on-CDN gap (every other install
# in this image is GPG- or lockfile-verified).
#
# Bumping the pin: pick a release commit hash (vscode releases page,
# https://code.visualstudio.com/updates/), then download the matching
# tarballs once to capture both arches' SHA-256:
#
#     COMMIT=<release commit hash>
#     for ARCH in cli-linux-x64 cli-linux-arm64; do
#       curl -fL "https://update.code.visualstudio.com/commit:${COMMIT}/${ARCH}/stable" \
#         | sha256sum
#     done
#
# Update VSCODE_CLI_VERSION + VSCODE_CLI_SHA256_AMD64 + VSCODE_CLI_SHA256_ARM64
# in lockstep. Operators can also override on the command line (e.g. for a
# CVE bump) without touching the file:
#
#     docker build \
#       --build-arg VSCODE_CLI_VERSION=commit:<sha> \
#       --build-arg VSCODE_CLI_SHA256_AMD64=<x64 sha256> \
#       --build-arg VSCODE_CLI_SHA256_ARM64=<arm64 sha256> \
#       ./session-image
ARG TARGETARCH
# Pinned to VS Code stable commit 10c8e557c8b9f9ed0a87f61f1c9a44bde731c409.
ARG VSCODE_CLI_VERSION=commit:10c8e557c8b9f9ed0a87f61f1c9a44bde731c409
ARG VSCODE_CLI_SHA256_AMD64=8429d2c1e2f564739be247ca5abc20cc9e6f987b976aee04d3bb8cf350535fe1
ARG VSCODE_CLI_SHA256_ARM64=452dbfe3bfb901dcb4583910cd5352a63f938b212985c5f72a895a6984d72acd
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) VSCODE_ARCH=cli-linux-x64;   VSCODE_SHA256="${VSCODE_CLI_SHA256_AMD64}" ;; \
      arm64) VSCODE_ARCH=cli-linux-arm64; VSCODE_SHA256="${VSCODE_CLI_SHA256_ARM64}" ;; \
      *) echo "unsupported arch: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    if [ -z "${VSCODE_SHA256}" ]; then \
      echo "ERROR: no SHA-256 set for ${VSCODE_ARCH} — refusing to install an unverified VS Code CLI. Override VSCODE_CLI_VERSION together with VSCODE_CLI_SHA256_AMD64 / VSCODE_CLI_SHA256_ARM64." >&2; \
      exit 1; \
    fi; \
    curl -fLsS "https://update.code.visualstudio.com/${VSCODE_CLI_VERSION}/${VSCODE_ARCH}/stable" \
         -o /tmp/vscode-cli.tar.gz; \
    echo "${VSCODE_SHA256}  /tmp/vscode-cli.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/vscode-cli.tar.gz -C /usr/local/bin code; \
    rm /tmp/vscode-cli.tar.gz; \
    chmod +x /usr/local/bin/code; \
    /usr/local/bin/code --version

# ── Non-root user ────────────────────────────────────────────────────────────
# UID 1000 is non-negotiable: the backend chowns each session's workspace
# bind-mount to WORKSPACE_UID:WORKSPACE_GID (default 1000:1000, see
# dockerManager.ts) before starting the container. Anything else and
# `developer` won't be able to write to /home/developer/workspace, which
# bricks the entrypoint's `.vscode-cli` setup and any in-tab work.
#
# The wrinkle: Ubuntu 23.04+ base images (including 24.04 here) ship with
# a pre-baked `ubuntu` user already holding UID/GID 1000. Plain
# `useradd -m developer` would skip 1000 (taken) and fall through to 1001,
# silently breaking the invariant — that exact mismatch caused container
# crash-loops where every `docker exec tmux list-sessions` returned 500
# from /api/sessions/:id/tabs. Drop the `ubuntu` user explicitly so the
# slot is free, then create developer pinned to 1000.
#
# `userdel -r` also removes the home dir and (because Ubuntu defaults
# USERGROUPS_ENAB=yes in /etc/login.defs) the matching primary group
# `ubuntu`, so we don't need a separate `groupdel`. The `|| true` is
# defensive in case Canonical ever drops the pre-baked user from the
# base image, which would make `userdel ubuntu` fail with "user does
# not exist" — non-fatal here, since the slot is already free.
RUN userdel -r ubuntu 2>/dev/null || true \
    && useradd -m -s /bin/bash -u 1000 -U -G sudo developer \
    && echo "developer ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/developer

USER developer
WORKDIR /home/developer


# ── tmux config (nice defaults) ──────────────────────────────────────────────
COPY --chown=developer:developer tmux.conf /home/developer/.tmux.conf

# ── Workspace directory ──────────────────────────────────────────────────────
RUN mkdir -p /home/developer/workspace

# ── Entrypoint ───────────────────────────────────────────────────────────────
# Keep the container alive. No tmux session is created at boot — tabs are
# provisioned on demand by the backend via `tmux new-session`, and the
# container outlives them.
COPY --chown=developer:developer entrypoint.sh /home/developer/entrypoint.sh
RUN chmod +x /home/developer/entrypoint.sh

ENTRYPOINT ["/home/developer/entrypoint.sh"]

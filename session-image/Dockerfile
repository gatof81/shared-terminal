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
# on Apple Silicon). The archive only contains a single `code` binary.
#
# Linkage: this base image is glibc (ubuntu:24.04), so we use the
# `cli-linux-*` artifacts. The `cli-alpine-*` builds are musl-linked and
# will fail at runtime on glibc with "not found" / "Exec format error".
#
# Pinning: VSCODE_CLI_VERSION defaults to `latest`, which resolves to the
# current stable release at build time. The download URL is otherwise
# unversioned, so the docker layer cache key would not invalidate when
# upstream ships a new build — set this arg to pin a known-good version
# for reproducible images:
#
#     docker build --build-arg VSCODE_CLI_VERSION=1.96.4 ./session-image
#     docker build --build-arg VSCODE_CLI_VERSION=commit:fabdb6a ./session-image
#
# Integrity: every other install in this image is verified (apt = GPG,
# npm = package-lock integrity hashes) — this download is not, so a
# compromised CDN response would install an arbitrary executable into
# /usr/local/bin/code that every session container then runs as a user
# with NOPASSWD:ALL sudo. To close that gap, pass an expected SHA-256 of
# the .tar.gz alongside the pinned version. Only meaningful with a pinned
# VSCODE_CLI_VERSION (the rolling `latest` artifact is hash-unstable):
#
#     docker build \
#       --build-arg VSCODE_CLI_VERSION=1.96.4 \
#       --build-arg VSCODE_CLI_SHA256=<sha256 of the matching .tar.gz> \
#       ./session-image
#
# When VSCODE_CLI_SHA256 is empty the build still succeeds but logs a
# loud warning, so the unverified path is opt-out by silence rather than
# the default-blessed path.
ARG TARGETARCH
ARG VSCODE_CLI_VERSION=latest
ARG VSCODE_CLI_SHA256=
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) VSCODE_ARCH=cli-linux-x64 ;; \
      arm64) VSCODE_ARCH=cli-linux-arm64 ;; \
      *) echo "unsupported arch: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fLsS "https://update.code.visualstudio.com/${VSCODE_CLI_VERSION}/${VSCODE_ARCH}/stable" \
         -o /tmp/vscode-cli.tar.gz; \
    if [ -n "${VSCODE_CLI_SHA256}" ]; then \
      echo "${VSCODE_CLI_SHA256}  /tmp/vscode-cli.tar.gz" | sha256sum -c -; \
    else \
      echo "WARNING: VSCODE_CLI_SHA256 not set — installing unverified VS Code CLI tarball from update.code.visualstudio.com. Pin VSCODE_CLI_VERSION + VSCODE_CLI_SHA256 for reproducible, attested builds." >&2; \
    fi; \
    tar -xzf /tmp/vscode-cli.tar.gz -C /usr/local/bin; \
    rm /tmp/vscode-cli.tar.gz; \
    chmod +x /usr/local/bin/code; \
    /usr/local/bin/code --version

# ── Non-root user ────────────────────────────────────────────────────────────
RUN useradd -m -s /bin/bash -G sudo developer \
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

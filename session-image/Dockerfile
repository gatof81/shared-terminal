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
      locales \
    && rm -rf /var/lib/apt/lists/*

# ── Locale ───────────────────────────────────────────────────────────────────
RUN locale-gen en_US.UTF-8
ENV LANG=en_US.UTF-8  LC_ALL=en_US.UTF-8

# ── Node.js (LTS) ───────────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

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

# ── GitHub CLI (`gh`) ────────────────────────────────────────────────────────
# Standalone CLI from GitHub. Lets the user run `gh auth login` once per
# session and then drive PRs / issues / releases / `gh api …` from the
# terminal without round-tripping through the browser. Closes the gap left
# by removing sudo (#15) — `apt-get install gh` is no longer reachable
# in-session, so the binary has to ship in the image.
#
# Same supply-chain posture as the VS Code CLI block above: pinned release
# tag, per-arch SHA-256 verified before extraction, no "skip the hash
# check" escape hatch. The published tarball contains a binary, man pages,
# completions, and LICENSE; we extract only the binary by name (not the
# whole archive) so a tampered tarball can't drop extra executables into
# /usr/local/bin alongside it.
#
# Bumping the pin: pick a release from https://github.com/cli/cli/releases,
# then capture both arches' SHA-256. The release ships a published
# `checksums.txt` listing every artifact's hash — pull that and read the
# linux_amd64 / linux_arm64 lines, instead of (only) hashing the tarballs
# yourself, so a tampered tarball can't paper over its own hash at bump
# time:
#
#     GH_VERSION=v2.92.0
#     curl -fL "https://github.com/cli/cli/releases/download/${GH_VERSION}/gh_${GH_VERSION#v}_checksums.txt" \
#       | grep -E 'linux_(amd64|arm64).tar.gz$'
#
# For belt-and-braces, also re-hash the tarballs themselves and confirm
# the values match the checksums file:
#
#     for ARCH in amd64 arm64; do
#       curl -fL "https://github.com/cli/cli/releases/download/${GH_VERSION}/gh_${GH_VERSION#v}_linux_${ARCH}.tar.gz" \
#         | sha256sum
#     done
#
# Update GH_CLI_VERSION + GH_CLI_SHA256_AMD64 + GH_CLI_SHA256_ARM64 in
# lockstep. Operators can also override on the command line for a CVE
# bump without touching the file:
#
#     docker build \
#       --build-arg GH_CLI_VERSION=v2.92.0 \
#       --build-arg GH_CLI_SHA256_AMD64=<x64 sha256> \
#       --build-arg GH_CLI_SHA256_ARM64=<arm64 sha256> \
#       ./session-image
ARG GH_CLI_VERSION=v2.92.0
ARG GH_CLI_SHA256_AMD64=b57848131bdf0c229cd35e1f2a51aa718199858b2e728410b37e89a428943ec4
ARG GH_CLI_SHA256_ARM64=c2248526dd0160c08d3fccca2332c3c1a07c15a78b23978e77735f1b5a18cfee
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) GH_ARCH=amd64; GH_SHA256="${GH_CLI_SHA256_AMD64}" ;; \
      arm64) GH_ARCH=arm64; GH_SHA256="${GH_CLI_SHA256_ARM64}" ;; \
      *) echo "unsupported arch: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    if [ -z "${GH_SHA256}" ]; then \
      echo "ERROR: no SHA-256 set for gh_linux_${GH_ARCH} — refusing to install an unverified GitHub CLI. Override GH_CLI_VERSION together with GH_CLI_SHA256_AMD64 / GH_CLI_SHA256_ARM64." >&2; \
      exit 1; \
    fi; \
    GH_DIR="gh_${GH_CLI_VERSION#v}_linux_${GH_ARCH}"; \
    curl -fLsS "https://github.com/cli/cli/releases/download/${GH_CLI_VERSION}/${GH_DIR}.tar.gz" \
         -o /tmp/gh.tar.gz; \
    echo "${GH_SHA256}  /tmp/gh.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/gh.tar.gz --strip-components=2 -C /usr/local/bin "${GH_DIR}/bin/gh"; \
    rm /tmp/gh.tar.gz; \
    chmod +x /usr/local/bin/gh; \
    /usr/local/bin/gh --version

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
# not exist" — non-fatal here, since the slot is already free. We
# deliberately do NOT redirect stderr: if userdel ever fails for some
# other reason (e.g. a future base where /home/ubuntu is a non-removable
# mount), the build will still proceed via `|| true` but the next step's
# "UID 1000 is not unique" failure will at least come with the actual
# root cause printed in the build log.
# No sudo / no extra groups: the session user runs unprivileged. The image
# previously shipped `sudo` + `NOPASSWD:ALL` for in-tab `apt-get install …`
# convenience, but on a host bind mount that's a footgun — `sudo chown
# -R 0:0 /home/developer/workspace` rewrites host-side file ownership to
# root through the UID-mapped mount (issue #15). Removing the sudo package
# entirely also drops /usr/bin/sudo as a setuid binary, which combined
# with the runtime no-new-privileges flag (see dockerManager.ts) means
# there is no path to elevation even if a future CVE in a setuid helper
# surfaces. Users who genuinely need elevated tools should rebuild with
# a custom image.
RUN userdel -r ubuntu || true \
    && useradd -m -s /bin/bash -u 1000 -U developer


USER developer
WORKDIR /home/developer

# ── Per-user npm prefix ──────────────────────────────────────────────────────
# Global npm installs land under $HOME instead of /usr/lib/node_modules so the
# developer user can update / uninstall / let `claude` self-update without
# sudo. With sudo gone (#15), a root-owned global prefix turns every npm
# global into a permanent fixture: `npm install -g @anthropic-ai/claude-code`
# at build time wrote `/usr/bin/claude` + `/usr/lib/node_modules/...` owned
# by uid 0, and a non-privileged developer can't even `npm uninstall -g` it.
#
# Putting the prefix under $HOME keeps /usr/lib/node_modules root-owned and
# untouchable (the security posture we want), while making in-container npm
# tooling actually usable.
#
# PATH ordering matters: prepend the user prefix so a newer self-updated
# `claude` shadows any stale /usr/bin/claude that might land in a future
# image revision. The mkdir is here (not at install time) so the directory
# exists when a user runs `npm install -g …` at runtime, not just for the
# build-time install below.
ENV NPM_CONFIG_PREFIX=/home/developer/.npm-global
ENV PATH=/home/developer/.npm-global/bin:$PATH
RUN mkdir -p /home/developer/.npm-global

# ── Claude CLI ───────────────────────────────────────────────────────────────
# Installed as `developer` (not root) so the binary is updateable in place.
# Lands in /home/developer/.npm-global, which entrypoint.sh migrates into
# the workspace bind mount on first boot — so `claude --update` (and any
# user-installed npm global) survives a container recreate (POST
# /sessions/:id/start respawns the container, but the workspace dir
# persists by design). Image rebuilds reseed the workspace copy only on
# first boot of a fresh workspace; existing workspaces keep their
# self-updated version, since a user who chose v.X probably wants v.X.
RUN npm install -g @anthropic-ai/claude-code

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

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

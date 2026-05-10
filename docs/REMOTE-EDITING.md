# Connecting an editor

Each session can be opened in your local IDE without SSH, port-forwards, or extra ingress on the home server. The session image ships the standalone Microsoft VS Code CLI; the tunnel goes outbound to Microsoft and auth is handled through your GitHub or Microsoft account.

## VS Code (Remote – Tunnels)

**From inside the browser terminal of a session:**

```bash
# First time only — register this container as a tunnel host.
# It prints a short device-code URL; paste it on your Mac and sign in
# with the same GitHub/Microsoft account you'll connect from.
code tunnel

# Subsequent runs in the same container can skip the prompt:
#   code tunnel --accept-server-license-terms --name <session-name>
```

`code tunnel` keeps running in the foreground, so leave it in its own tmux tab. The CLI's auth state is stored under `~/.vscode-cli/`, which the session entrypoint symlinks into `~/workspace/.vscode-cli/` — that path is bind-mounted from the host, so the device-login token survives container restarts (soft-delete + restart, host reboot triggering reconcile, etc.). After a restart you only need to re-launch `code tunnel`; it picks the existing registration up automatically. The state is purged on a hard delete, same as the rest of the workspace.

**On your Mac:**

1. Install the [Remote - Tunnels](https://marketplace.visualstudio.com/items?itemName=ms-vscode.remote-server) extension in VS Code.
2. Open the Command Palette → **Remote-Tunnels: Connect to Tunnel…** and pick the session you just registered. The workspace at `/home/developer/workspace` is the one bind-mounted from the host, so anything you save there is persisted across container restarts.

> The tunnel binary is per-arch — the Dockerfile picks `cli-linux-x64` or
> `cli-linux-arm64` automatically based on Buildx `TARGETARCH`, so it works
> on both Intel servers and Apple Silicon hosts running the image natively.
> (We use the glibc `cli-linux-*` builds rather than the musl `cli-alpine-*`
> ones because the base image is `ubuntu:24.04`.)
>
> The default build is reproducible and verified out of the box — the CLI
> version is pinned to a specific commit and the per-arch SHA-256 of each
> tarball is checked with `sha256sum -c` before extraction. There is no
> "skip the hash check" path; an empty SHA fails the build. To bump the
> pin (or override for a CVE patch), update the three `ARG VSCODE_CLI_*`
> defaults in `session-image/Dockerfile` together, or pass them on the
> command line:
>
> ```bash
> docker build \
>   --build-arg VSCODE_CLI_VERSION=commit:<sha> \
>   --build-arg VSCODE_CLI_SHA256_AMD64=<x64 sha256 of the .tar.gz> \
>   --build-arg VSCODE_CLI_SHA256_ARM64=<arm64 sha256 of the .tar.gz> \
>   -t shared-terminal-session ./session-image
> ```

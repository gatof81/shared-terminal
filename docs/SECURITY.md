# Security model

Read this before exposing the backend to the public internet.

## Threat model

The backend's job is to spawn, attach to, and kill Docker containers
on demand. To do that, `docker-compose.yml` bind-mounts the host's
`/var/run/docker.sock` into the backend container:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

This is the standard tradeoff for a session-orchestrator design, but
the consequences need to be explicit:

- **The backend has full Docker daemon access.** The Docker API the
  socket exposes is unauthenticated to anything that can `connect(2)`
  to it. There is no per-endpoint ACL on a vanilla socket.
- **An RCE in the backend is host root.** An attacker who reaches
  arbitrary code execution inside the backend container can ask the
  daemon to start a privileged container that bind-mounts the host
  rootfs and chroots into it. There is no container-level mitigation
  for this once the socket is reachable.
- **The session containers themselves run unprivileged** (no
  `--privileged`, no extra capabilities, no host PID/net namespaces).
  The socket exposure is a backend-trust property, not a session-
  trust property.

## Recommended deployment posture

- **Do not expose port 3001 directly to the internet.** Treat the
  backend as a private service.
- **Run behind Cloudflare Tunnel** (see [DEPLOYMENT.md → With Cloudflare Tunnel](./DEPLOYMENT.md#with-cloudflare-tunnel))
  so the origin has no inbound ports open at all. The tunnel
  terminates at Cloudflare; the home server only makes outbound
  connections.
- **Gate the tunnel hostname with Cloudflare Access.** A short Access
  policy ("emails matching me@example.com") in front of the tunnel
  hostname turns "anyone on the internet" into "people who can prove
  they're me" before any HTTP request reaches the backend. The
  in-app JWT auth is still the primary control; Access is a hard
  belt around it.
- **Keep the host patched and the backend image rebuilt.** Both the
  Node runtime and the dependencies in `backend/package.json` are
  CVE-bearing surfaces, and an unpatched RCE there inherits the
  socket-access blast radius above.

## Optional: docker-socket-proxy

For deployments that want to shrink the backend's daemon surface
below "all of the Docker API", you can interpose a proxy that only
exposes the endpoints this app actually needs. The backend uses the
daemon for: container create, start, stop, remove, inspect, exec
create + start + resize. The split between HTTP verbs matters for
the proxy's allowlist:

- `POST` paths: `containers/create`, `containers/{id}/start`,
  `containers/{id}/stop`, `exec/create`, `exec/{id}/start`,
  `exec/{id}/resize`.
- `GET` paths: `containers/{id}/json` (called by `isAlive()`,
  `startContainer()`, `reconcile()`) and `exec/{id}/json` (called
  by `execOneShot()` to read tmux exit codes — every
  `capture-pane`, `list-sessions`, `kill-session`, `new-session
-d`, `set-option` runs through this path). Without `GET=1` the
  backend boots fine and authenticates fine, but `reconcile()`
  silently 403s at startup, every `POST /api/sessions/:id/start`
  fails when it inspects the container, and every tab attach
  fails when the tmux exec exit code can't be read.
- `DELETE` paths: `containers/{id}` (full removal at session kill).

(`DockerManager.kill()` is a method name, not a daemon endpoint —
it routes through `stop` + `remove`, so `POST /containers/{id}/kill`
is never issued.)

[`tecnativa/docker-socket-proxy`](https://github.com/Tecnativa/docker-socket-proxy)
is a small HAProxy-based filter that does exactly this. With the
ruleset below, an RCE in the backend can't pull or build images,
reach the Swarm/network/volume APIs, or touch any daemon surface
outside `/containers/*` and `/exec/*`. It **can** still create a
container — including one that bind-mounts the host rootfs
(`HostConfig.Binds`) — and inspect existing containers (which
exposes their environment variables). The proxy is blast-radius
reduction, not a privilege boundary: a determined attacker with
RCE can still escape via a new privileged container, just not via
the image/network/volume side of the API. Treat it as one layer of
defence in depth, paired with the tunnel + Access posture above.

The snippet below is a **drop-in replacement** for the project's
`docker-compose.yml`, not a `docker-compose.override.yml` overlay.
This matters because Compose merges `volumes:` lists from override
files onto the base service rather than replacing them — the base
file's `/var/run/docker.sock:/var/run/docker.sock` mount would
survive the override and an RCE would still find the live socket
file descriptor inside the container even with `DOCKER_HOST`
pointed at the proxy. Either replace `docker-compose.yml`
wholesale (the simpler path), or remove the socket mount from
the base file before layering an override.

```yaml
networks:
  # Internal-only network for the backend ↔ proxy hop. `internal:
  # true` blocks egress to the default bridge AND prevents the
  # session containers (which the backend creates on the default
  # network) from reaching the proxy: a compromised session
  # container can't issue Docker API calls through this hop to
  # inspect other sessions' env vars or spawn its own containers.
  # `expose:` alone would NOT achieve this — it gates host-level
  # publishing, not inter-container reachability on a shared
  # bridge, so the proxy port would otherwise be a flat lateral-
  # movement target.
  docker-proxy:
    internal: true

services:
  docker-socket-proxy:
    # Pin to an immutable digest in production (`image:
    # tecnativa/docker-socket-proxy@sha256:…`) so a future
    # `docker compose pull` can't silently swap the proxy out from
    # under the operator. A floating `:latest` defeats the
    # blast-radius story this whole section is selling. The
    # explicit version tag below is the minimum bar; the digest is
    # the right answer.
    image: tecnativa/docker-socket-proxy:v0.4.2
    restart: unless-stopped
    networks: [docker-proxy]
    environment:
      # Endpoints required by dockerManager.ts. The proxy enforces
      # HTTP-verb ACLs (POST/GET/DELETE) SEPARATELY from the
      # resource flags (CONTAINERS/EXEC/…), and every verb defaults
      # to 0. All four of POST/GET/DELETE + the two resource flags
      # are required; dropping any one silently breaks a different
      # part of the app:
      CONTAINERS: 1 # /containers/* — create, inspect, start, stop, remove
      EXEC: 1 # /exec/* — create + start + resize + inspect (WS attach path)
      GET: 1 # GET /containers/{id}/json (isAlive/start/reconcile)
      # and GET /exec/{id}/json (execOneShot exit-code read).
      # Without this the backend boots and authenticates fine but
      # is non-functional: reconcile silently 403s, /start fails,
      # every tab attach fails when execOneShot can't read its
      # exit code.
      POST: 1 # POST verbs (create/start/exec/resize/stop)
      DELETE: 1 # DELETE /containers/{id} for container.remove() on
      # session kill — without this the call is silently swallowed
      # by dockerManager's try/catch and stopped containers pile up
      # on the host indefinitely.
      # Default-deny everything else: IMAGES, NETWORKS, VOLUMES,
      # SERVICES, SWARM, NODES, INFO, AUTH, BUILD, COMMIT, etc.
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    # No `expose:` and no `ports:`: the internal network already
    # makes the proxy reachable to peers on `docker-proxy` and
    # unreachable to anything else, including session containers
    # the backend creates on the default Docker network.

  app:
    # Replace the direct socket mount with a network connection to
    # the proxy. The backend joins BOTH networks: `docker-proxy`
    # for the daemon hop, `default` for everything else (Cloudflare
    # Tunnel egress, the session containers it creates, etc.).
    environment:
      - DOCKER_HOST=tcp://docker-socket-proxy:2375
    depends_on:
      - docker-socket-proxy
    networks: [docker-proxy, default]
    # No /var/run/docker.sock bind mount at all: this snippet is a
    # full replacement for docker-compose.yml's `volumes:`, not
    # additive on top of it.
    volumes:
      - ${WORKSPACE_ROOT:-/var/shared-terminal/workspaces}:/var/shared-terminal/workspaces
```

Caveats:

- The backend honours `DOCKER_HOST` when it's set: with that env
  var present, the `DockerManager` constructor passes no explicit
  connection options to dockerode and lets docker-modem read the
  URL from the environment. With `DOCKER_HOST` unset it falls back
  to `/var/run/docker.sock`, so the default `docker-compose.yml`
  stack continues to work untouched. If you also bind-mount
  `/var/run/docker.sock` while `DOCKER_HOST` is set, the bind-mount
  is silently ignored — `DOCKER_HOST` wins because no `socketPath`
  is forwarded to dockerode at all in that branch. The replacement
  snippet above already drops the bind-mount; if you instead layer
  a `docker-compose.override.yml`, Compose merges `volumes:` lists
  and the base mount survives, so the live socket file descriptor
  is still inside the container even though the backend is using
  the proxy. Replace `docker-compose.yml` wholesale rather than
  overriding it so there's nothing left for an RCE to fall back to.
- Bind-mount paths the backend asks for (`<WORKSPACE_ROOT>/<id>`,
  `.uploads/<id>`) must still exist on the _host_ — the proxy
  forwards container-create requests verbatim, so the daemon
  resolves bind sources from its own filesystem.
- Pin the proxy image to an immutable digest
  (`@sha256:…`) in production. A floating `:latest` would let a
  future `docker compose pull` silently change the proxy under
  you, defeating the point of installing it. The example above
  uses an explicit version tag as the minimum bar — promote to a
  digest when you adopt this in your own deployment.
- A scoped proxy reduces blast radius. It does **not** make the
  backend safe to expose without authentication; the tunnel + Access
  posture above is still load-bearing.

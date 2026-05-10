# API reference

Auth is via the httpOnly cookie `st_token` set by `POST /api/auth/login` and `POST /api/auth/register`. JS cannot read the token. CSRF for state-changing JSON routes is handled by the CORS preflight + `Content-Type: application/json` requirement.

## Auth (public)

| Method | Path               | Description                                              |
| ------ | ------------------ | -------------------------------------------------------- |
| GET    | /api/auth/status   | First-visit setup probe + current auth + admin status    |
| POST   | /api/auth/register | Create account (invite code required after first user)   |
| POST   | /api/auth/login    | Set the auth cookie                                      |
| POST   | /api/auth/logout   | Clear the auth cookie                                    |

## Sessions (cookie-authed)

| Method | Path                          | Description                                                     |
| ------ | ----------------------------- | --------------------------------------------------------------- |
| POST   | /api/sessions                 | Create session + container; accepts `body.config` (see below)   |
| GET    | /api/sessions                 | List sessions (append `?all=true` to include terminated)        |
| GET    | /api/sessions/:id             | Get session details                                             |
| DELETE | /api/sessions/:id             | Soft delete (container killed, workspace kept, row→terminated)  |
| DELETE | /api/sessions/:id?hard=true   | Hard delete (also purge workspace dir + drop the D1 row)        |
| POST   | /api/sessions/:id/stop        | Stop container (workspace preserved)                            |
| POST   | /api/sessions/:id/start       | Restart or respawn stopped container                            |
| PATCH  | /api/sessions/:id/env         | Update environment variables                                    |
| GET    | /api/sessions/:id/tabs        | List tmux tabs for a session                                    |
| POST   | /api/sessions/:id/tabs        | Create a tab                                                    |
| DELETE | /api/sessions/:id/tabs/:tabId | Delete a tab                                                    |
| POST   | /api/sessions/:id/files       | Multipart file upload into the per-session uploads dir          |

`POST /api/sessions` accepts a typed `body.config` mirroring `SessionConfigSchema` in `backend/src/sessionConfig.ts`: `envVars` (typed entries with `plain` / `secret` discriminator), `repo` + `auth`, `ports[]` + `allowPrivilegedPorts`, `gitIdentity`, `dotfiles`, `agentSeed`, `postCreateCmd`, `postStartCmd`, `cpuLimit`, `memLimit`, `idleTtlSeconds`. Every field is optional; a bare `POST` (no `config`) creates a default session.

## Templates (cookie-authed)

| Method | Path                | Description                                                  |
| ------ | ------------------- | ------------------------------------------------------------ |
| POST   | /api/templates      | Create a template (config must be secret-stripped — see CLAUDE.md) |
| GET    | /api/templates      | List the user's templates (summary shape, no config)         |
| GET    | /api/templates/:id  | Get a template (full config)                                 |
| PUT    | /api/templates/:id  | Update name / description / config (owner-gated)             |
| DELETE | /api/templates/:id  | Delete a template (owner-gated)                              |

## Invites (admin)

| Method | Path                | Description                                                  |
| ------ | ------------------- | ------------------------------------------------------------ |
| POST   | /api/invites        | Mint a single-use invite code                                |
| GET    | /api/invites        | List invite codes (admin sees all rows, not just their own)  |
| DELETE | /api/invites/:hash  | Revoke an unused invite code (`:hash` is the 64-char hex SHA-256 digest returned by `GET /api/invites`, not the plaintext token) |

## WebSocket

Two channels, both cookie-authed (browser sends `st_token` automatically on the upgrade handshake to the cookie's domain). CSWSH defence is independent: `isAllowedWsOrigin` rejects unlisted origins before the handshake completes.

```
wss://host/ws/sessions/<sessionId>?tab=<tabId>     # terminal attach
wss://host/ws/bootstrap/<sessionId>                # bootstrap pipeline live-tail
```

**Terminal — Client → Server:** `input`, `resize`
**Terminal — Server → Client:** `output`, `status`, `error`
**Bootstrap — Server → Client:** `output`, `done`, `fail`, `error`

## Port-exposure dispatcher

When `PORT_PROXY_BASE_DOMAIN` is set, requests to `https://p<containerPort>-<sessionId>.<base>` are diverted from the API/WS routes to the per-session reverse proxy (see `CLAUDE.md` → "Port-exposure dispatcher"). Auth gate: `public: false` ports require the `st_token` cookie owned by the session's owner; `public: true` ports skip auth (webhook / OAuth-callback shape).

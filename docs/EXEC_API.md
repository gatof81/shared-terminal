# Exec API

Structured command execution in a session container over HTTP: NDJSON
streaming output, exit codes, and race-free cancellation (#381). This is
the canonical contract — it originated as a draft in the
[agenthub repo](https://github.com/gatof81/agenthub/blob/main/docs/contracts/shared-terminal-exec-api.md),
which now tracks this file.

The API is a thin HTTP surface over the in-process primitives
`streamExec` / `killExecProcessGroup` (`backend/src/dockerManager.ts`) —
no new execution machinery. It is product-agnostic: no consumer concepts
(runs, agents, budgets) appear here.

**Trust model:** these endpoints are arbitrary code execution in the
session container *by construction* — exactly as powerful as the terminal
WebSocket already is for the same authenticated owner. They add capability
breadth (automation), not a new trust level. Auth is the existing JWT
cookie; the principal must own the session (403 otherwise). No new auth
mechanism.

## Correlation

Every exec-API response carries `X-Request-Id: <16-hex>` — the same id
stamped on every backend log line (`requestContext.ts`), so a consumer-side
run can be joined to substrate logs after the fact. The `started` event
echoes it. A caller-supplied `X-Request-Id` header is ignored; the response
header is always the substrate's authoritative id.

## Endpoints

### 1. Start an exec — `POST /api/sessions/:id/exec`

```json
{
  "cmd": ["claude", "-p", "--resume", "abc123", "--output-format", "stream-json"],
  "env": { "MY_VAR": "value" },
  "workingDir": "/home/developer/workspace",
  "maxDurationMs": 600000
}
```

| Field | Type | Required | Semantics |
| --- | --- | --- | --- |
| `cmd` | `string[]` | yes | argv array; `cmd[0]` resolved via container `PATH`. Never shell-interpreted — it rides positional parameters into `setsid`/exec, same no-shell-meta invariant as the clone runner |
| `env` | `object` | no | extra environment; values are opaque strings, never logged or echoed in events. Validated by the same rules as session-config env vars (name charset, ≤ 64 entries, ≤ 4096 bytes/value, ≤ 64 KiB total) |
| `workingDir` | `string` | no | default `/home/developer/workspace` (the session workspace) |
| `maxDurationMs` | `number` | no | wall-clock cap, max **1 hour** — which is also the default when omitted: an exec at this seam is always bounded. On expiry the server runs the kill procedure and the exit is attributed `reason: "timeout"` |

Every exec runs as the leader of a fresh process group (`setsid`) — the
pgid is the cancellation handle and there is no uncancellable mode at this
seam.

Response: `200` with `Content-Type: application/x-ndjson`, chunked. One
JSON object per line:

```json
{"v":1,"type":"started","execId":"e_9f2c...","pgid":137,"requestId":"a1b2c3d4e5f60718","ts":"2026-07-14T21:00:00.000Z"}
{"v":1,"type":"output","stream":"stdout","data":"{\"type\":\"system\",\"subtype\":\"init\", ..."}
{"v":1,"type":"output","stream":"stderr","data":"some diagnostic\n"}
{"v":1,"type":"exit","exitCode":0,"reason":"exited","ts":"2026-07-14T21:00:41.213Z"}
```

| `type` | Fields | Notes |
| --- | --- | --- |
| `started` | `execId`, `pgid`, `requestId`, `ts` | Strictly the first event — output that beats the pgid sentinel (early stderr) is held until it. `pgid` is informational (kill is by execId); ≥ 2 |
| `output` | `stream` (`"stdout"` \| `"stderr"`), `data` | UTF-8 chunk, not necessarily line-aligned; the consumer reassembles lines. `Tty:false` multiplexed frames preserve the stream distinction |
| `exit` | `exitCode`, `reason` (`"exited"` \| `"killed"` \| `"timeout"`), `ts` | Terminal; the response ends after it |
| `error` | `code`, `message` | Terminal, for mid-stream failures (container died, docker error) |
| `dropped` | `scope` (`"pre-start"`), `bytes` | Non-terminal. The pre-`started` hold buffer (256 KiB) overflowed and `bytes` of raw output were discarded — emitted immediately after the buffer flush so truncation is distinguishable from "the process wrote nothing" |

All events carry `v` (schema version, currently `1`). Consumers must
ignore unknown fields and unknown event types; the `v` bump is reserved
for breaking changes and is coordinated in this document.

Stream lifecycle:

- **Client disconnect does not kill the process** (Docker has no
  kill-exec). The exec keeps running server-side and stays addressable via
  endpoints 2 and 3; its eventual exit code lands in the registry.
- Flow control: when the HTTP response backpressures, the underlying
  Docker stream is paused, not buffered unboundedly.

### 2. Exec status — `GET /api/sessions/:id/exec/:execId`

Recovery surface for a consumer that lost the stream.

```json
{ "execId": "e_9f2c...", "state": "running", "pgid": 137, "startedAt": "..." }
{ "execId": "e_9f2c...", "state": "exited", "exitCode": 0, "reason": "exited", "endedAt": "..." }
{ "execId": "e_9f2c...", "state": "unknown" }
```

The registry is in-memory and single-replica: a backend restart loses it,
and exited entries age out after 1 hour. `unknown` covers *both* "registry
lost" and "this id never existed" — the two are indistinguishable from the
server, so the status endpoint deliberately answers `unknown` instead of
404 (a 404 would misread as "never existed" after a reboot). On `unknown`,
the safe consumer action is session-level reconciliation: stop/start the
session (heavy hammer, always available) or accept the orphan — the same
gap the substrate's own bootstrap runner accepts on restart.

### 3. Kill — `POST /api/sessions/:id/exec/:execId/kill`

Request: `{ "graceMs": 5000 }` (optional; default 5000, capped at 30000).

Response `200`: `{ "outcome": "already-exited" | "terminated" | "killed" }`
— verbatim `killExecProcessGroup`'s outcome. Idempotent: `already-exited`
is the tolerant no-op. An exec the registry already knows is exited is
answered from the registry **without re-probing `/proc`** — the pgid may
have been recycled by an unrelated process group inside the container.

After a successful kill, the exec's stream (if still attached) emits
`exit` with `reason: "killed"`. If the kill outcome is `already-exited`,
the exit stays attributed `"exited"` (the process beat the signal — that
was a natural exit, not a kill).

**Known attribution race (v1):** if a natural exit lands in the
milliseconds while a kill request is in flight, the stream may have
already emitted `exit` with `reason: "killed"` before the kill's
`already-exited` outcome can walk the attribution back. When the two
disagree, **the kill endpoint's `outcome` is authoritative** — consumers
that branch on `reason` should reconcile against it rather than retry.
Closing this window would require deferring `reason` resolution past the
kill round-trip; deliberately out of scope for v1.

## Error semantics (non-stream)

| Status | When | Body |
| --- | --- | --- |
| `400` | malformed body, empty `cmd`, oversized `cmd` (> 32 KiB) or `env`, bad env name, `graceMs`/`maxDurationMs` out of range | `{ "error": "..." }` |
| `401` / `403` | unauthenticated / session not owned | existing house shape |
| `404` | unknown session; kill on an execId the registry does not hold | `{ "error": "..." }` |
| `409` | session container not running; kill on an exec whose pgid was never reported | `{ "error": "container-not-running" }` / `{ "error": "pgid-unavailable" }` |
| `429` | per-session concurrency cap (4 running execs) or per-IP rate limit (120/min for start + kill) | `{ "error": "too-many-concurrent-execs" }` / limiter shape |

Once the NDJSON stream has started, failures arrive as terminal `error`
events, not status codes.

## Non-goals (v1)

- Event replay / resume (`?after=seq`) — additive if needed.
- Interactive stdin / PTY — the terminal WebSocket remains the interactive
  surface.
- Multi-replica exec registry.

# ACP two-agent PoC

Durable inbox + one runner per agent + acpx/claude-agent-acp. Experimental; not
wired into the backend.

```
owner / agent ──st send──▶ server.mjs (SQLite, persisted before 201)
                                │ claim (one running per agent)
                                ▼
                 runner.mjs ──acpx prompt──▶ claude-agent-acp ──▶ Claude
                                │ turn result (stopReason, final text)
                                ▼
          result recorded; a request from an agent gets an automatic reply
```

- `server.mjs` — `POST /v1/messages {to, body}` (sender = token), `POST /v1/agents/:a/claim`,
  `POST /v1/messages/:id/result|release|requeue`, `GET /v1/messages[/:id]`. States:
  `pending → running → done | failed | uncertain`; only the owner requeues `uncertain`.
- `runner.mjs` — agent-agnostic (`ACP_AGENT_CMD` is a stable wrapper path, so the acpx
  session identity survives adapter upgrades). After a restart it settles the
  `running` message from acpx's own event log (`sessions watch`): completed ⇒ `done`,
  anything else ⇒ `uncertain`, never resent.
- `bin/st` — `st send @agent "text"`, `st list`, `st get`, `st requeue`.
- `lab.sh` — Docker lab (`setup`, `st`, `agent <name>`, `owner …`, `runtime <ver>`, `down`).
  The image only needs Node ≥ 22.13; the ACP runtime is a read-only volume with one
  pinned directory per adapter version. Autonomy: `permissions.defaultMode:
  bypassPermissions` in the agent's `~/.claude/settings.json` (see the report: the
  adapter's default is `auto`, and `acpx --approve-all` only answers requests that
  reach it).

```bash
TOKEN_ENV=~/acp-lab/.tok.env ./lab.sh setup && ./lab.sh st && ./lab.sh agent arquitecto && ./lab.sh agent developer
./lab.sh owner send @arquitecto "Pedile a @developer que …"
./lab.sh owner list
./lab.sh down
```

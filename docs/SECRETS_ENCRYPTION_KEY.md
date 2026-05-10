# SECRETS_ENCRYPTION_KEY operator runbook

`SECRETS_ENCRYPTION_KEY` is the AES-256-GCM key used by the backend to encrypt every `secret`-typed value in D1 — `secret` env-var entries, repo-clone PATs, and SSH private keys. The ciphertext + IV + auth tag are stored in D1; the plaintext key lives only in the deployment's process environment. **Losing the key means losing access to every encrypted value, with no v1 recovery path.** Read this before deploying.

## Generating a key

```bash
openssl rand -base64 32
```

The backend's `validateSecretsKey` (in `backend/src/secrets.ts`) refuses to start unless the value decodes to exactly 32 bytes (256 bits). Anything else — a passphrase, a 16-byte hex string, an unpadded base64 — fails the boot check with a loud error rather than silently truncating.

## Where to store it

- **Production:** sealed in your deployment's secrets manager (Doppler, Vault, AWS/GCP Secrets Manager, 1Password Secrets Automation, Cloudflare Secrets Store, …) and injected into the backend process at start. Treat it like a database master key.
- **Docker Compose deployments:** read from `.env` (which you do **not** commit) or from a `secrets:` block. The `.env.example` placeholder in this repo (`change-me-in-production-base64-32-bytes`) is intentionally a literal string that fails `validateSecretsKey` so a forgotten copy-paste fails on boot, not silently in production.
- **Never** in git, in build artifacts, in container images, in CI logs, or in chat history. The whole point of encrypting secrets in D1 is that a D1 dump must not yield plaintext credentials; if the key is recoverable from the same place a D1 dump comes from, the encryption is performative.

## Backup obligations

Lose the key and the encrypted-secret column in D1 becomes unreadable forever. **A single off-site backup of the key is mandatory** before you start using `secret` env vars, repo PATs, or SSH keys for anything you care about. Recommended cadence:

- **At provisioning:** print the key once, store it in your password manager (or split it across two operators if you want a dual-control posture). Confirm by retrieving it and round-tripping a value through `encryptSecret` / `decryptSecret`.
- **Before every infrastructure migration:** before changing hosts, recreating the secrets-manager backend, or running anything that could clobber the env-var source, re-confirm you have the key in cold storage.
- **After every operator change:** when an operator with access leaves, rotate (see "Rotation" below) — but only after you have v2's rotation tooling, since the v1 stranding rule still applies.

The threat you are defending against here is the deployment's secrets manager dropping the value during a routine operation (typo in `terraform apply`, accidental delete in the dashboard, a `helm rollback` to a release that didn't have the secret yet). All of those are recoverable from a separate backup; none are recoverable from D1.

## Rotation

**There is no rotation tooling in v1.** The encryption boundary is in `secrets.ts` — every encrypted blob carries only a ciphertext + IV + tag, with no key-id or version metadata. Changing `SECRETS_ENCRYPTION_KEY` strands every existing secret with a `decryptSecret` failure on the next read.

A v2 rotation path needs:

1. A two-key window where the backend can decrypt with the old key and encrypt new writes with the new key.
2. A re-encrypt sweep tool that walks every `session_configs.env_vars` row, every `session_configs.repo_auth` blob, and any other column that holds an `EncryptedSecret`-shaped value, decrypts under the old key, and re-encrypts under the new one.
3. A migration record that flips the active key once the sweep completes.

Until that lands, **do not rotate** unless you've accepted that every operator with `secret` env vars / PATs / SSH keys configured today will need to re-enter them post-rotation.

## Loss-impact recovery

If the key is genuinely lost (no backup, secrets-manager wiped, etc.), the recovery path is:

1. **Generate a new key** and deploy it.
2. **Manually clear the encrypted columns** in D1 — every `session_configs.env_vars` entry of `type: "secret"`, every `repo_auth` blob. The backend will refuse to clone with a stranded PAT and refuse to inject a stranded secret env var; the rows have to be cleared, not just left in place to fail.
3. **Notify every user** to re-enter their PATs, SSH keys, and `secret` env vars on each affected session. The variable **names** are recoverable — query `session_configs.env_vars_json` in D1 and filter for entries with `"type":"secret"` to get the full `(sessionId, name)` list. The `EnvVarEntryStored` type stores `name` in plaintext alongside the encrypted blob; only the value is gone. Repo PATs and SSH private keys are one-per-session and don't need a name lookup — the affected session ids are whatever rows have non-empty `repo_auth_*` columns.
4. **Rotate any credentials whose encrypted blob may have been exfiltrated** — the encryption defends against D1 dumps; if the key is lost in a way that suggests the ciphertext was also exposed (e.g. attacker compromised the secrets manager), treat every previously-encrypted credential as compromised and rotate at the source (revoke the GitHub PAT, regenerate the SSH key, rotate the API key with the upstream service).

The "regenerate at source" step is the load-bearing one: re-encrypting an already-leaked PAT under a new key does nothing.

## See also

- `backend/src/secrets.ts` — the AES-256-GCM implementation, `EncryptedSecret` shape, and `validateSecretsKey` boot check.
- `.env.example` — the inline note that points here.
- [SECURITY.md](./SECURITY.md) — broader threat model for the deployment.

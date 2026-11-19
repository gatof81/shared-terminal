# ops/

This folder holds the generic, tested building blocks of the VM100 deploy and activation scripts.

`lib/checks.sh` contains the checks those scripts depend on. Each one is a function with tests
(`test/checks.test.sh`), and CI runs the tests and `shellcheck` on every PR that touches `ops/`.
Every function exists because an inline version of it was wrong during the D1 rollout (2026-11-12):

- an ID query failed, so the route checks after it passed against an empty ID;
- a `diff` hunk header made a one-key `.env` change look unexpected;
- an informational log line matched a refusal pattern;
- a `docker run --rm` was still being removed when the image removal ran;
- a compose key forwarded empty was treated as absent.

## The host-specific scripts are not in this repository

The scripts that run on VM100 (`01-preflight` … `08-deactivate`, rollback notes, dist manifests)
hard-code the deployment: paths, the public hostname, image and session ids, groups. They are
versioned in a private git repository on the host, `/root/st-deploy-scripts-d1/` (root, 0700).
That repository keeps:

- the exact scripts as executed in GO 1 and GO 2;
- every later change, as its own commit;
- `lib/checks.sh`, a copy of this repository's file, which the scripts source.

The host scripts must use these functions, not their own inline versions. When a check needs new
logic, it lands here first, with a test. The copy on the host is then updated from it, and
`SHA256SUMS` is regenerated.

## `backup/` — the nightly backup, with its history on the NAS

`backup/st-backup-nas.sh` replaces the mirror (`rsync --delete` of the host's last seven backups):

1. `run` makes a backup and checks it against its own manifest.
2. It copies it to the NAS and compares the NAS's checksums with the local files.
3. Only then it uploads `<name>.COMPLETE`. That marker is the publication: a directory without it
   is reported by `status`, never counted and never removed.
4. The host keeps its newest backup (a recreation needs a manifest younger than 24 h) and drops an
   older one only once it is published.
5. NAS retention removes backups by name (`backup/retention.py`: 3 daily + the newest of the
   previous ISO week by default), and only in a run that has just published one.

A failure deletes nothing on either side, ends non-zero, writes `status.json` and calls `ALERT_CMD`
if one is configured. `adopt <name>` publishes a backup that already exists locally (the way to
bring the mirror's old directories under the marker). The config file (`/etc/st-backup-nas.conf`)
holds every host-specific value; the script's header lists the keys.

## `st-ops/` — the restricted account that runs the deploy kit

`st-ops/` lets an operator session run the host's deploy kit (`/root/st-deploy-kit`) over SSH without root, the
docker group or another session's key; every writing step needs the owner's signature. See `st-ops/README.md`.

## Run the tests

```bash
bash ops/test/checks.test.sh   # no network, no Docker (a stub stands in for `docker`)
bash ops/test/retention.test.sh
bash ops/test/backup-nas.test.sh   # needs rsync; a local directory stands in for the NAS
bash ops/st-ops/test/run.sh        # needs ssh-keygen, git, python3
shellcheck -x ops/lib/checks.sh ops/test/checks.test.sh ops/backup/st-backup-nas.sh ops/test/*.test.sh
```

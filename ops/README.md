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

## Run the tests

```bash
bash ops/test/checks.test.sh   # no network, no Docker (a stub stands in for `docker`)
shellcheck -x ops/lib/checks.sh ops/test/checks.test.sh
```

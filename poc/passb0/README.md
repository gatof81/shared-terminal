# PASS-B0 prototype (not executed)

The measurement kit for PASS-B0. Its design is in `docs/design/project-chat/04-poc.md` §1.14.6 and its procedure in §1.14.9, both in PR #512. B0 asks one question: when a mod calls `$.http.fetch` with `socketPath`, which process does the Unix server see on that concrete connection, and can that connection reach a child process?

Out of scope here: the gateway, keys and HMAC, managed settings, the backend and the Monitor.

| File | Role |
| --- | --- |
| `mod/` | `st-passb0-probe`. On `session.start`, after `next`, it makes five calls (`c1`, `h1`, `h2`, `hold-c`, `hold-h`) to the in-container and host servers. During each hold it spawns `waitheld` and then `fdcheck` with `$.process.run`, so the fork happens while the connection is open. It writes one JSON fact record per step. |
| `b0.py` | `server` (container or host scope; `--identity` writes pid, starttime, boot_id, uid and an argv hash; SIGTERM removes the socket), `waitheld`, `fdcheck`, `client` (the `base` client and the `control` client), `rocheck`, `cliinfo`, `stop` (pidfd first, identity check second, signal last; idempotent), `imageversion` (reads the image history only), `checklimits` (what Docker applied) and `manifest` (what capture brought back). Standard library only, run as `python3 -I`. |
| `run-b0.sh` | The VM100 runner, one phase per call: `preflight`, `setup`, `servers`, `measure`, `capture`, `validate` and `cleanup`. `set -euo pipefail` applies to the whole script, which is never run inside a `&&`/`||` list. `OK: <phase>` is printed from inside the script. A phase writes `state/<phase>.ok` only when it succeeds, and the next phase requires that marker. `capture` and `cleanup` also run after a partial failure: `capture` records each item, and `cleanup` is idempotent, signals the host server only through a verified pidfd, and keeps all evidence. |
| `analyze.py` | `report RESULTS_DIR` gives PASS, FAIL or INCONCLUSIVE with aliases and booleans. It exits 0 only on PASS. |
| `test/` | Synthetic tests. `test_b0.py` uses real local Unix sockets: `SO_PEERCRED`, `SO_PEERPIDFD`, sock_diag peer inode, `O_CLOEXEC` versus what a child actually inherits, and the positive control. `test_analyze.py` has a PASS fixture plus one mutation per criterion. `probe.test.mjs` covers the mod logic with fake host calls. `test_runner.py` runs the runner against a fake `docker` (`test/fakebin/docker`) and a real host server. |

Run the tests:

    python3 test/test_b0.py && python3 test/test_analyze.py && python3 test/test_runner.py && node --test test/probe.test.mjs
    claude plugin validate ./mod

None of the records hold a process environment, a command line, prompt text or a credential. The analyzer reads only the lines of the CLI debug log that name this plugin, and the procedure copies out only those lines.

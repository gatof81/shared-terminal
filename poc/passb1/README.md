# PASS-B1 kit (docs/design/project-chat/04-poc.md §1.14.14–§1.14.15)

Two independent experiments, each in its own throwaway container on VM100, each with its own
verdict. **Nothing here is authorized to run on VM100**; this branch (`poc/channels-phase0`) is
never merged.

| Path | What |
| --- | --- |
| `run-b1.sh` | Phase runner, `bash run-b1.sh BASE preflight\|setup\|measure\|capture\|validate\|cleanup`. `BASE/env` says `KIND=b1a` or `KIND=b1b`. Fail-closed as `run-b0.sh`: state markers, strict env reader, container removed only on a recorded ground (`captured`, `no-evidence`, `discard-authorized`) against the exact id. |
| `b1.py` | Standard-library helpers. In the container: `seed`, `attempt` (one B1a start of the CLI in tmux, answering only what the agent could: trust, theme, a project MCP server), `applied` (hashes and write checks of the mounted policy and marketplace), `hnd-stat`, `ancestor`, `immut`, `inventory`, `sysinfo`. On the host: `imageversion`, `checklimits`, `manifest`, and `hostexe` (H6c, designed only: it refuses to run unless `B1B_HOSTEXE_AUTHORIZED` equals the container id, and no procedure sets it). |
| `managed/b1a.json` | The managed settings B1a mounts read-only at `/etc/claude-code/managed-settings.d/`. Key names and nesting verified in the 2.1.314 binary; `allowManagedModsOnly` is an option of the guard `cc-plugin-sec-default@builtin`. |
| `marketplace/` | The local marketplace B1a mounts read-only at `/opt/st-b1/marketplace`, listing `st-b1-probe` by relative path: the only way 2.1.314 seats a local plugin in the organization tier. |
| `marketplace/plugins/st-b1-probe` | The managed probe: one fact record per event (`session.start`, `classic.SessionStart`, `classic.SessionEnd`), plus whether mod code can reach `Bun.ant.setDumpable` (B1b H8; `typeof` only, nothing is called). |
| `analyze_b1a.py`, `analyze_b1b.py` | Verdicts (PASS / FAIL / INCONCLUSIVE) from the captured facts. Aliases and booleans only. |
| `test/` | `test_analyze_b1a.py` and `test_analyze_b1b.py`: a PASS fixture built from the real 2.1.314 log templates plus one mutation per criterion. `test_b1.py`: helpers on real processes (a non-dumpable target made with `prctl(PR_SET_DUMPABLE, 0)`, a dumpable control, real ptrace as an ancestor). `test_runner.py`: the runner against a fake `docker`. |

B1a attempt rule: an attempt counts as **blocked** only with no marker of the attacker's code,
the control in the same start (the managed probe in the organization tier, or the CLI refusing
to start with the sideload message), and decisive evidence that the CLI met the attack. Anything
less is INCONCLUSIVE; a marker is a FAIL. N15 (dev mods), `@synced` and prompt/tool events need a
login and stay listed as pending, never as blocked.

B1b measures other processes' access to a CLI started from a root `0711` copy, against a
positive control (the same CLI from the readable copy). It does not measure process integrity:
code inside the CLI can make it dumpable again, and a tracer attached before the exec keeps the
registers. Both are reported as residual facts. H5 is analytic: no crash is ever caused.

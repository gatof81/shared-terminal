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
| `test/` | `test_analyze_b1a.py` and `test_analyze_b1b.py`: a PASS fixture built from the real 2.1.314 log templates plus one mutation per criterion. `test_b1.py`: helpers on real processes (a non-dumpable target made with `prctl(PR_SET_DUMPABLE, 0)`, a dumpable control, real ptrace as an ancestor). `test_runner.py`: the runner against a fake `docker` (including that setup stops if `NetworkMode` is not `none`). |

B1a attempt rule: an attempt counts as **blocked** only with no marker of the attacker's code,
the control in the same start (the managed probe in the organization tier, or the CLI refusing
to start with the sideload message), and decisive evidence that the CLI met the attack — for the
impostors (N10/N11/N13), the ORIGIN of the loaded module — the planted path considered and
skipped as already-loaded, plus an in-place load; a cache read that could have loaded it is
INCONCLUSIVE, never blocked. N9 is judged on the install outcome (a successful `plugin install`
is a FAIL, a policy refusal is blocked), not on whether the plugin ran. A rogue hooks module
that LOADED is a FAIL even with no marker.
Settings-validation errors are checked in every attempt, not only the baseline. Anything short of
blocked is INCONCLUSIVE. classic.SessionEnd is a fact, not a PASS requirement (attempts end with
C-c). For a two-start attack (N12) the control and the seed evidence must be in the same (last) start. The runner uses --network none: N4 serves on the container loopback. N15 (dev mods),
`@synced` and prompt/tool events need a login and stay pending, never blocked.

B1b measures other processes' access to a CLI started from a root `0711` copy, against a
**per-operation** positive control (the same CLI from the readable copy). READ mode
(environ/auxv/maps, which Yama does not restrict) is judged in the non-ancestor case; ATTACH mode
is judged as an ancestor (H4), where Yama grants an ancestor of a dumpable child — a non-ancestor
ATTACH denial is a fact, not credited to H-ND. A denial counts for H-ND only where the same
operation succeeds against the control AND the denial is a permission error (EACCES/EPERM); any
other errno is INCONCLUSIVE, not credit. It does not measure process integrity: code inside the CLI
can make it dumpable again, and a tracer attached before the exec keeps the registers (H4b). H5 is
an observed precondition, not a demonstration; no crash is ever caused. PID/starttime stability is
not executable identity.


## Run 2 (focused; §1.14.18–§1.14.19)

Run 1 (kit `e00ef29`) closed 13 attempts as blocked and left six inconclusive, since resolved:
N9 = policy block at `marketplace add` (blocked); N17-user = demonstrated refusal (blocked);
N10/N11/N13 = **retired/excluded** (for a directory marketplace 2.1.314 reads the plugin in place;
the cache/seed is not a load path — shown locally); N14 and N17-project need a valid measurement.

Changes in this kit (run 1's `e00ef29` is untouched in history):
- **N9** judged on the two commands' own output/rc, correlating plugin↔marketplace: blocked only
  when `marketplace add` is refused by policy AND `plugin install` fails because the plugin is not
  in that marketplace; an add refusal plus an unrelated install failure is INCONCLUSIVE; a
  successful install is FAIL.
- **N17** split into `N17-user` (blocked on the managed-settings refusal text) and `N17-project`
  (needs the sanitized MCP-approval capture: server identified + approved, did not start, and a
  refusal line names it; otherwise INCONCLUSIVE; started ⇒ FAIL).
- **N14** separates workspace-trust confirmation from probe validity: to judge the attack the
  probe must establish (`session.start` + org tier) in the same start; otherwise the start is
  `harness-startup-failed` (measurement INCONCLUSIVE, never blocked). Trust is confirmed by a
  post-trust signal, not by assuming keystrokes succeeded.
- **N10/N11/N13** retired: the analyzer reports them in `excluded`, never blocked or counted.
- The runner takes `RUN2=1` to run **only** P0, N14 and N17-project, under label `passb1.run=2`
  and an EXP name `pass<kind>-run2-exp-<STAMP>`.
- `summary-b1a.py` prints a combined run1+run2 summary citing each finding's provenance (which run
  and kit SHA), with N10/N11/N13 excluded and the caveat that a reduced-scope PASS is not
  Channels general security.

Nothing here is authorized to run on VM100; the next gate is a static audit.

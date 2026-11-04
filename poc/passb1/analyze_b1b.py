#!/usr/bin/env python3
"""PASS-B1b analyzer: H-ND (04-poc.md §1.14.15). Standard library only.

    analyze_b1b.py report RESULTS_DIR      verdict as JSON; exit 0 only on PASS

H-ND is a property of other processes' access to the CLI's memory and descriptors. It is
NOT process integrity: code running inside the CLI can call prctl(PR_SET_DUMPABLE, 1) at
any time (kernel/sys.c), and a tracer attached before the exec keeps the registers
(H4b). Those are reported as residual facts, never folded into PASS.

Every denial is judged against a positive control: the same CLI started from the readable
copy, measured the same way. A denial the control also gets proves nothing.
"""
import json
import os
import sys

SCOPE = ("B1b: H-ND de 2.1.314 desde una copia de root 0711 en un contenedor descartable; mide el acceso de otros procesos "
         "del mismo uid, no la integridad del proceso ni su lanzamiento (09-launch-trust.md)")
WANT_CLI = "2.1.314"
READ_MODE = ("environ", "auxv", "maps", "fd_link", "fdinfo", "exe_link")   # Yama does not limit these
ATTACH_MODE = ("mem", "process_vm_readv", "ptrace_seize", "pidfd_getfd")    # Yama limits non-ancestors
# Files whose owner turns root while the task is not dumpable (task_dump_owner). Not fdinfo/:
# a world r-x directory keeps the task's euid whatever its dumpable state.
PROC_ENTRIES = ("environ", "auxv", "maps", "mem")
PENDING = {"H6c": "identidad del ejecutable leída como root en el host (diseñada en b1.py hostexe; no autorizada)"}


def _json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def load(d):
    h = os.path.join(d, "hnd")
    probe = {}
    for s in ("hnd", "ctl"):
        pd = os.path.join(h, f"probe-{s}")
        recs = [_json(os.path.join(pd, f)) for f in sorted(os.listdir(pd))] if os.path.isdir(pd) else []
        probe[s] = sorted({r.get("kind") for r in recs if isinstance(r, dict)} - {None})
        probe[f"{s}_reach"] = next((r.get("reach") for r in recs if isinstance(r, dict) and isinstance(r.get("reach"), dict)), None)
    return {k: _json(os.path.join(h, f"{k}.json")) for k in ("setup", "sysinfo", "immut", "inventory", "version", "after",
                                                             "stat-hnd-t0", "stat-ctl-t0", "stat-hnd-t1")} | {
        "anc_hnd": _json(os.path.join(h, "anc-hnd", "ancestor.json")), "anc_ctl": _json(os.path.join(h, "anc-ctl", "ancestor.json")),
        "probe": probe, "manifest": _json(os.path.join(d, "capture-manifest.json")), "preflight": _json(os.path.join(d, "preflight.json")),
        "cli_before": _json(os.path.join(d, "cli-version-before.json")), "cli_after": _json(os.path.join(d, "cli-version-after.json"))}


def denied(v):
    return v not in (None, "ok")


def analyze(D):
    fails, incs, facts = [], [], {}

    def done():
        verdict = "FAIL" if fails else "INCONCLUSIVE" if incs else "PASS"
        return {"scope": SCOPE, "verdict": verdict, "reasons": fails + incs, "facts": facts, "pending": PENDING}

    man = D.get("manifest")
    if not isinstance(man, dict):
        incs.append("capture-manifest-missing")
    elif man.get("complete") is not True:
        incs.append("capture-incomplete")
    seen = {"preflight": (D.get("preflight") or {}).get("cli_version"), "before": (D.get("cli_before") or {}).get("version"),
            "after": (D.get("cli_after") or {}).get("version"), "root_copy": (D.get("version") or {}).get("version")}
    facts["cli_version_ok"] = {k: v == WANT_CLI for k, v in seen.items()}

    # Preparation: without the exact root copy nothing below means anything.
    st = D.get("setup") or {}
    facts["setup"] = {k: st.get(k) for k in ("installed", "sha256_ok", "uid", "mode")}
    if not (st.get("installed") is True and st.get("sha256_ok") is True and st.get("uid") == 0 and st.get("mode") == "711"):
        incs.append("hnd-setup-failed")
        return done()
    for k in ("preflight", "before", "after"):
        if seen[k] != WANT_CLI:
            incs.append(f"cli-version-{'unverified' if not seen[k] else 'mismatch'}:{k}")

    si = D.get("sysinfo") or {}
    facts["kernel"] = {k: si.get(k) for k in ("kernel", "ptrace_scope", "suid_dumpable", "core_pattern_is_pipe", "protected_hardlinks")}
    if si.get("ptrace_scope") != "1":
        incs.append("ptrace-scope-not-1")

    # H1: starts from the root copy, and the mod engine works under it.
    h1 = {"version": seen["root_copy"] == WANT_CLI, "probe_hnd": "session.start" in D["probe"]["hnd"],
          "probe_ctl": "session.start" in D["probe"]["ctl"]}
    facts["H1"] = h1
    if not h1["version"]:
        fails.append("H1-root-copy-does-not-run")
    elif not h1["probe_ctl"]:
        incs.append("H1-control-did-not-start")
    elif not h1["probe_hnd"]:
        fails.append("H1-mods-do-not-run-from-root-copy")

    # H8, reported only: can mod code reach setDumpable(true)? If so, H-ND holds only while
    # no foreign mod runs in the CLI, which is what B1a is about.
    rh = D["probe"].get("hnd_reach") or {}
    facts["H8_mod_can_reach_set_dumpable"] = None if not rh else rh.get("set_dumpable") == "function"

    # Positive control, per operation. A denial against the root copy counts for H-ND only
    # where the SAME operation SUCCEEDS against the dumpable control under identical conditions
    # (same reader relationship, same kernel): that is what rules out an independent cause.
    ctl = D.get("stat-ctl-t0")
    if not isinstance(ctl, dict) or (ctl.get("owner_uid") or {}).get("environ") != 1000:
        incs.append("control-not-readable")
        facts["control"] = None if not isinstance(ctl, dict) else {"owner_environ": (ctl.get("owner_uid") or {}).get("environ")}
        return done()
    cr = ctl.get("reads") or {}
    # A non-ancestor reader: Yama 1 restricts ATTACH only, so READ must succeed on the control
    # and ATTACH may legitimately be denied to it. So H3 (non-ancestor) is judged on READ only;
    # ATTACH for a non-ancestor is reported as a fact and NOT attributed to H-ND. ATTACH is
    # demonstrated by H4 (ancestor), where Yama lets the ancestor attach to a dumpable child.
    read_ctl_ok = [k for k in READ_MODE if cr.get(k) == "ok"]
    facts["control"] = {"read_mode_ok": read_ctl_ok, "attach_mode_on_control": {k: cr.get(k) for k in ATTACH_MODE}}
    if set(read_ctl_ok) != set(READ_MODE):
        incs.append("control-read-mode-incomplete")
        return done()

    # H2/H3: non-ancestor, at start and later (the same process). READ only; owners root.
    for tag in ("stat-hnd-t0", "stat-hnd-t1"):
        s = D.get(tag)
        if not isinstance(s, dict):
            incs.append(f"{tag}-missing")
            continue
        owners = {e: (s.get("owner_uid") or {}).get(e) for e in PROC_ENTRIES}
        reads = s.get("reads") or {}
        facts[tag] = {"owners_root": all(v == 0 for v in owners.values()),
                      "read_denied": {k: denied(reads.get(k)) for k in READ_MODE},
                      "attach_fact": {k: reads.get(k) for k in ATTACH_MODE}}
        if any(v == 1000 for v in owners.values()):
            fails.append(f"H2-dumpable:{tag}")
        elif not all(v == 0 for v in owners.values()):
            incs.append(f"H2-owner-unknown:{tag}")
        # Every READ op denied on the root copy AND granted on the control (checked above).
        if not all(facts[tag]["read_denied"].values()):
            fails.append(f"H3-read-readable:{tag}")

    # Executable identity is separate from PID/starttime stability: an exec keeps both. The root
    # copy running the right inode is H6b/H6c, not this; here only that the process did not vanish.
    t0, t1 = D.get("stat-hnd-t0") or {}, D.get("stat-hnd-t1") or {}
    facts["pid_starttime_stable"] = bool(t0 and t1 and t0.get("starttime") == t1.get("starttime") == t1.get("starttime_after"))
    if t0 and t1 and not facts["pid_starttime_stable"]:
        incs.append("H7-process-changed")

    # H4: as an ancestor. Yama lets an ancestor ATTACH to a dumpable child, so the control must
    # SUCCEED per op (READ and ATTACH); H-ND credit for each denied op requires that success.
    ah, ac = D.get("anc_hnd"), D.get("anc_ctl")
    if not (isinstance(ah, dict) and isinstance(ac, dict)):
        incs.append("H4-missing")
    else:
        cplain = (ac.get("plain") or {}).get("reads") or {}
        hplain = (ah.get("plain") or {}).get("reads") or {}
        ctl_ok = [k for k in READ_MODE + ATTACH_MODE if cplain.get(k) == "ok"]
        facts["H4"] = {"control_ok": ctl_ok, "root_denied": {k: denied(hplain.get(k)) for k in READ_MODE + ATTACH_MODE}}
        if set(ctl_ok) != set(READ_MODE + ATTACH_MODE):
            # Without a per-op control success (incl. ATTACH, which Yama grants an ancestor of a
            # dumpable child) a denial against the root copy cannot be credited to H-ND.
            incs.append("H4-control-incomplete")
        elif not all(facts["H4"]["root_denied"].values()):
            fails.append("H4-ancestor-can-read")
        pre, cpre = ah.get("traced_before_exec") or {}, ac.get("traced_before_exec") or {}
        # Residual, reported only: a tracer from before the exec loses the memory, keeps the registers.
        facts["H4b_residual_pre_exec_tracer"] = {"stopped_at_exec": pre.get("stopped_at_exec"), "peekdata_denied": denied(pre.get("peekdata")),
                                                 "getregs_kept": pre.get("getregs") == "ok", "control_peekdata_ok": cpre.get("peekdata") == "ok"}

    # H5: analytic, never a crash. suid_dumpable and core_pattern are OBSERVED preconditions
    # (what the kernel would do with a core of a non-dumpable task: fs/coredump.c), not a
    # practical demonstration that no core is ever exposed. Reported as a precondition.
    sd = si.get("suid_dumpable")
    facts["H5_core_precondition"] = {"suid_dumpable": sd, "core_pattern_is_pipe": si.get("core_pattern_is_pipe"),
                                     "disposition": {"0": "no-core-possible", "2": "root-only-host-context"}.get(sd, "unexpected"),
                                     "demonstrated": False}
    if sd not in ("0", "2"):
        fails.append("H5-suid-dumpable-allows-user-cores")

    # H6a: nobody of this uid can change the root copy or its folder.
    im = D.get("immut") or {}
    ch = {k: im.get(k) for k in ("open_write", "chmod", "rename", "unlink", "hardlink_tmp", "create_in_dir", "rename_dir")}
    facts["H6a_denied"] = {k: denied(v) for k, v in ch.items()}
    if not im:
        incs.append("H6a-missing")
    elif any(v == "ok" for v in ch.values()) or (im.get("file") or {}).get("uid") != 0 or (im.get("file") or {}).get("mode") != "0o711":
        fails.append("H6a-root-copy-changeable")
    inv = (D.get("inventory") or {}).get("copies") or []
    facts["H6b_copies"] = [{k: c.get(k) for k in ("path_class", "readable", "same_sha256")} for c in inv]
    if not any(c.get("path_class") == "opt-st-hnd" and c.get("readable") is False for c in inv):
        incs.append("H6b-root-copy-not-found-unreadable")

    # H7: an update attempt did not touch the root copy.
    af = D.get("after") or {}
    facts["H7"] = {k: af.get(k) for k in ("sha256_unchanged", "owner_mode_unchanged")}
    if not af:
        incs.append("H7-missing")
    elif not (af.get("sha256_unchanged") and af.get("owner_mode_unchanged")):
        fails.append("H7-root-copy-changed")
    return done()


def main(argv):
    if len(argv) != 3 or argv[1] != "report":
        print(__doc__.strip(), file=sys.stderr)
        return 64
    res = analyze(load(argv[2]))
    print(json.dumps(res, indent=2, ensure_ascii=False))
    return 0 if res["verdict"] == "PASS" else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))

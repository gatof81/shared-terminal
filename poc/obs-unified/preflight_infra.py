#!/usr/bin/env python3
"""Infrastructure PREFLIGHT for the isolated smoke — namespaces, PTY and cleanup ONLY. It never runs
Claude: the isolated payload is a throwaway Python process. Run it on a DISPOSABLE host only — never
VM100, never inside a Shared Terminal session, never near the retained PASS-B1 containers.

It exercises exactly the RealSys paths the smoke uses (spawn → readiness → check_isolation → pane →
reap/namespace verification) and prints one JSON report of booleans and enums (no paths, no pane
text). Exit 0 only if every check passes.

    python3 -I preflight_infra.py
"""
import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_smoke as E  # noqa: E402

READY = "PREFLIGHT-READY"
PAYLOAD = f"import time\nprint({READY!r}, flush=True)\ntime.sleep(60)\n"


def _read(path):
    try:
        with open(path) as fh:
            return fh.read().strip()
    except OSError:
        return None


def environment():
    """Facts that decide whether the isolation can work here (read-only)."""
    return {"uid": os.getuid(),
            "unprivileged_userns_clone": _read("/proc/sys/kernel/unprivileged_userns_clone"),
            "apparmor_restrict_unprivileged_userns": _read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns"),
            "max_user_namespaces": _read("/proc/sys/user/max_user_namespaces"),
            "have_unshare": bool(shutil.which("unshare")), "have_nsenter": bool(shutil.which("nsenter")),
            "have_ip": bool(shutil.which("ip"))}


def refusal(env=None, dockerenv="/.dockerenv"):
    """Refuse inside a Shared Terminal session or any container: this preflight belongs on a disposable
    host. Returns a reason string, or None when it may proceed."""
    env = os.environ if env is None else env
    for k in ("SESSION_ID", "ST_INGEST_TOKEN", "ST_BACKEND_PORT"):
        if env.get(k):
            return f"shared-terminal-session:{k}"
    if os.path.exists(dockerenv):
        return "inside-container"
    return None


def run(rs=None, *, ready_timeout=10.0):
    import time
    rs = rs or E.RealSys(sys.executable, None, None)
    argv = ["unshare", "--map-root-user", "--net", "--pid", "--fork", "--mount-proc", "--kill-child",
            sys.executable, "-I", "-c", PAYLOAD]
    rep = {"spawned": False, "stage": None, "ns_identity": False, "isolation": None,
           "pty_frame_ok": False, "cleanup_accredited": None}
    try:
        owner = rs.spawn(argv, "preflight")
    except E.SpawnError as exc:
        rep["stage"] = exc.stage
        if exc.owner is not None:                       # a child exists: reap it by its handle
            rep["cleanup_accredited"] = rs.reap(exc.owner)
        else:
            rep["cleanup_accredited"] = True            # no child was ever created
        return rep
    rep["spawned"], rep["ns_identity"] = True, bool(owner.get("ns_pid") and owner.get("ns_net"))
    try:
        rep["isolation"] = bool(rs.check_isolation(owner))
        deadline = time.monotonic() + ready_timeout
        while time.monotonic() < deadline:
            frame = rs.pane("preflight")
            if frame and READY in frame:
                rep["pty_frame_ok"] = True
                break
            time.sleep(0.1)
    finally:
        try:
            rep["cleanup_accredited"] = bool(rs.reap(owner))
        finally:
            rs.teardown("preflight")
    return rep


def main():
    out = {"environment": environment(), "refused": refusal()}
    if out["refused"] is None:
        out["result"] = run()
        r = out["result"]
        ok = r["spawned"] and r["ns_identity"] and r["isolation"] and r["pty_frame_ok"] and r["cleanup_accredited"]
    else:
        ok = False
    print(json.dumps(out, indent=2, sort_keys=True))
    return 0 if ok else 1


if __name__ == "__main__":   # pragma: no cover
    sys.exit(main())

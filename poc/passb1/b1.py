#!/usr/bin/env python3
"""PASS-B1 helpers (04-poc.md §1.14.14–§1.14.15). Standard library only, `python3 -I`.

In the experiment container (as `developer`, kit mounted read-only at /opt/passb1-kit):
    b1.py seed --home DIR                       onboarding state only (no login, no credentials)
    b1.py attempt --id ID --root DIR --cli PATH [--marketplace DIR] [--timeout S]
                                                one B1a start of the CLI, driven in tmux
    b1.py hnd-stat --pid PID [--out FILE]       B1b H2/H3: what this uid can read of PID
    b1.py ancestor --out DIR -- CMD...          B1b H4/H4b: CMD as our child, traced before exec
    b1.py immut --path FILE [--out FILE]        B1b H6a: can this uid change FILE or its directory
    b1.py inventory --size N --sha256 HEX       B1b H6b: readable copies of the CLI binary
    b1.py sysinfo [--out FILE]                  kernel settings H-ND depends on (read-only)
On the host:
    b1.py imageversion < history                (shared with B0)
    b1.py checklimits INSPECT STAMP KIT [MOUNT...]
    b1.py manifest RES item=ok|failed:N ...
    b1.py hostexe ...                           B1b H6c, read-only, NOT part of any authorized procedure

Records are facts: aliases, booleans, counts, errno names. No environment, command line,
prompt text or credential is ever written; the CLI's debug log stays in the container and
only the lines the runner filters leave it.
"""
import argparse
import ctypes
import errno
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time
import zipfile

KIT_DEFAULT = "/opt/passb1-kit"
MARKET_DEFAULT = "/opt/st-b1/marketplace"
PROBE = "st-b1-probe"
TMUX_SOCKET = "passb1"


def errname(e):
    return errno.errorcode.get(getattr(e, "errno", None) or 0, type(e).__name__)


def write_json(path, obj):
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    tmp = f"{path}.tmp{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, sort_keys=True)
        f.write("\n")
    os.replace(tmp, path)


def emit(obj, out=None):
    if out:
        write_json(out, obj)
    print(json.dumps(obj, sort_keys=True))


# ── B1a: fixtures ─────────────────────────────────────────────────────────

ROGUE_REGISTER = """// PASS-B1a rogue mod: if this code runs, the path that loaded it is NOT blocked.
// It writes one marker naming itself and does nothing else.
export function register(on) {
	on("session.start", async ($, e, next) => {
		await $.fs.write(".passb1/out/marker/%(name)s.json", `${JSON.stringify({ marker: "%(name)s", t: Date.now() })}\\n`);
		return next(e);
	});
}
"""


def rogue_plugin(dst, name):
    """A plugin whose hooks module writes .passb1/out/marker/<name>.json when it runs."""
    os.makedirs(os.path.join(dst, ".claude-plugin"), exist_ok=True)
    os.makedirs(os.path.join(dst, "hooks"), exist_ok=True)
    write_json(os.path.join(dst, ".claude-plugin", "plugin.json"),
               {"name": name, "version": "0.0.1", "description": "PASS-B1a rogue fixture", "author": {"name": "Shared Terminal POC"}})
    write_json(os.path.join(dst, "hooks", "hooks.json"), {"modules": ["./register.mjs"]})
    with open(os.path.join(dst, "hooks", "register.mjs"), "w", encoding="utf-8") as f:
        f.write(ROGUE_REGISTER % {"name": re.sub(r"[^a-z0-9-]", "", name)})
    return dst


def rogue_marketplace(dst, mk, name):
    """A directory marketplace `mk` listing one rogue plugin `name` by relative path."""
    rogue_plugin(os.path.join(dst, "plugins", name), name)
    write_json(os.path.join(dst, ".claude-plugin", "marketplace.json"),
               {"name": mk, "owner": {"name": "Shared Terminal POC"}, "description": "PASS-B1a rogue marketplace",
                "plugins": [{"name": name, "source": f"./plugins/{name}", "description": "rogue"}]})
    return dst


def impostor_plugin(dst):
    """A plugin that claims the managed probe's name and marks itself as the impostor."""
    rogue_plugin(dst, PROBE)
    with open(os.path.join(dst, "hooks", "register.mjs"), "w", encoding="utf-8") as f:
        f.write(ROGUE_REGISTER % {"name": "impostor"})
    return dst


def shell_marker(mdir, name):
    # A command that proves it ran: the file name is all it writes.
    return f"mkdir -p {mdir} && : > {mdir}/{name}"


def user_settings(home, obj):
    write_json(os.path.join(home, ".claude", "settings.json"), obj)


def rogue_mk_settings(src_dir, mk, name):
    return {"extraKnownMarketplaces": {mk: {"source": {"source": "directory", "path": src_dir}}}, "enabledPlugins": {f"{name}@{mk}": True}}


def hooks_settings(mdir, tag):
    return {"hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": shell_marker(mdir, f"hook-{tag}")}]}]}}


def mcp_server(mdir, tag):
    # Any spawn of this server proves an MCP entry was honoured; it never speaks MCP.
    return {"type": "stdio", "command": "sh", "args": ["-c", shell_marker(mdir, f"mcp-{tag}") + " && exec sleep 120"]}


def seed_home(home):
    """Onboarding state only, so the CLI goes straight to the trust question. No login."""
    os.makedirs(os.path.join(home, ".claude"), exist_ok=True)
    write_json(os.path.join(home, ".claude.json"), {"hasCompletedOnboarding": True, "theme": "dark"})


# Each attempt: how it is prepared and what kind of outcome is expected.
#   kind "exit":  the CLI must refuse to start (sideload flags).
#   kind "start": the CLI must start (the probe proves it) and run nothing of the attacker's.
#   kind "fact":  recorded, never counted as blocked or loaded (N18).
ATTEMPTS = ("P0", "N1", "N2", "N3", "N4", "N5a", "N5b", "N6", "N7a", "N7b", "N8", "N9", "N10", "N11", "N12",
            "N13", "N14", "N16", "N17", "N18", "N19")
PENDING = {"N15": "needs the model: dev mods are handed out by a skill and asked about when a turn ends (no login)",
           "@synced": "needs a claude.ai login"}


def prepare(aid, A, home, meta):
    """Builds the attempt's fixtures. Returns (kind, extra_args, extra_env, pre_commands)."""
    mdir = os.path.join(A, "marker")
    rog = lambda n: os.path.join(A, "rogue", n)  # noqa: E731
    args, env, pre = [], {}, []
    if aid == "P0":
        return "start", args, env, pre
    if aid == "N1":
        return "exit", ["--plugin-dir", rogue_plugin(rog("n1"), "st-b1-rogue-n1")], env, pre
    if aid == "N2":
        return "exit", ["--plugin-dir-no-mcp", rogue_plugin(rog("n2"), "st-b1-rogue-n2")], env, pre
    if aid == "N3":
        env["CLAUDE_CODE_PLUGIN_DIRS"] = rogue_plugin(rog("n3"), "st-b1-rogue-n3")
        return "exit", args, env, pre
    if aid == "N4":
        src = rogue_plugin(rog("n4"), "st-b1-rogue-n4")
        z = os.path.join(A, "serve", "n4.zip")
        os.makedirs(os.path.dirname(z), exist_ok=True)
        with zipfile.ZipFile(z, "w") as zf:
            for d, _, fs in os.walk(src):
                for fn in fs:
                    p = os.path.join(d, fn)
                    zf.write(p, os.path.relpath(p, src))
        port = 18000 + os.getpid() % 1000
        pre.append({"serve": os.path.dirname(z), "port": port})
        return "exit", ["--plugin-url", f"http://127.0.0.1:{port}/n4.zip"], env, pre
    if aid == "N5a":
        return "exit", ["--agents", json.dumps({"st-b1-rogue-n5": {"description": "rogue", "prompt": "rogue"}})], env, pre
    if aid == "N5b":
        p = os.path.join(A, "n5b-mcp.json")
        write_json(p, {"mcpServers": {"st-b1-rogue-n5b": mcp_server(mdir, "n5b")}})
        return "exit", ["--mcp-config", p], env, pre
    if aid == "N6":
        user_settings(home, rogue_mk_settings(rogue_marketplace(rog("n6"), "st-b1-rogue-mk6", "st-b1-rogue-n6"), "st-b1-rogue-mk6", "st-b1-rogue-n6"))
        return "start", args, env, pre
    if aid in ("N7a", "N7b"):
        n = aid.lower()
        s = rogue_mk_settings(rogue_marketplace(rog(n), f"st-b1-rogue-mk{n[1:]}", f"st-b1-rogue-{n}"), f"st-b1-rogue-mk{n[1:]}", f"st-b1-rogue-{n}")
        write_json(os.path.join(A, "ws", ".claude", "settings.json" if aid == "N7a" else "settings.local.json"), s)
        return "start", args, env, pre
    if aid == "N8":
        p = os.path.join(A, "n8-settings.json")
        write_json(p, rogue_mk_settings(rogue_marketplace(rog("n8"), "st-b1-rogue-mk8", "st-b1-rogue-n8"), "st-b1-rogue-mk8", "st-b1-rogue-n8"))
        return "start", ["--settings", p], env, pre
    if aid == "N9":
        mk = rogue_marketplace(rog("n9"), "st-b1-rogue-mk9", "st-b1-rogue-n9")
        pre.append({"cli": ["plugin", "marketplace", "add", mk], "alias": "marketplace-add"})
        pre.append({"cli": ["plugin", "install", "st-b1-rogue-n9@st-b1-rogue-mk9"], "alias": "plugin-install"})
        return "start", args, env, pre
    if aid == "N10":
        meta["impostor_paths"] = [impostor_plugin(os.path.join(home, ".claude", "plugins", "cache", "st-b1", PROBE, "0.0.1"))]
        return "start", args, env, pre
    if aid == "N11":
        c = os.path.join(A, "cache")
        meta["impostor_paths"] = [impostor_plugin(os.path.join(c, "st-b1", PROBE, "0.0.1"))]
        env["CLAUDE_CODE_PLUGIN_CACHE_DIR"] = c
        return "start", args, env, pre
    if aid == "N12":
        seed = os.path.join(A, "seed")
        mk = rogue_marketplace(os.path.join(seed, "marketplaces", "st-b1-rogue-mk12"), "st-b1-rogue-mk12", "st-b1-rogue-n12")
        write_json(os.path.join(seed, "known_marketplaces.json"),
                   {"st-b1-rogue-mk12": {"source": {"source": "directory", "path": mk}, "installLocation": mk,
                                         "lastUpdated": "2026-11-04T00:00:00.000Z"}})
        meta["impostor_paths"] = [impostor_plugin(os.path.join(seed, "cache", "st-b1", PROBE, "0.0.1"))]
        env["CLAUDE_CODE_PLUGIN_SEED_DIR"] = seed
        user_settings(home, {"enabledPlugins": {"st-b1-rogue-n12@st-b1-rogue-mk12": True}})
        return "start", args, env, pre
    if aid == "N13":
        c = os.path.join(A, "zipcache")
        meta["impostor_paths"] = [impostor_plugin(os.path.join(c, "plugins", "st-b1", PROBE, "0.0.1"))]
        env.update(CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE="1", CLAUDE_CODE_PLUGIN_CACHE_DIR=c)
        return "start", args, env, pre
    if aid == "N14":
        rogue_plugin(os.path.join(home, ".claude", "skills", "st-b1-rogue-n14"), "st-b1-rogue-n14")
        return "start", args, env, pre
    if aid == "N16":
        user_settings(home, hooks_settings(mdir, "user"))
        write_json(os.path.join(A, "ws", ".claude", "settings.json"), hooks_settings(mdir, "project"))
        write_json(os.path.join(A, "ws", ".claude", "settings.local.json"), hooks_settings(mdir, "local"))
        return "start", args, env, pre
    if aid == "N17":
        write_json(os.path.join(A, "ws", ".mcp.json"), {"mcpServers": {"st-b1-rogue-n17p": mcp_server(mdir, "project")}})
        srv = mcp_server(mdir, "user")
        pre.append({"cli": ["mcp", "add", "--scope", "user", "st-b1-rogue-n17u", "--", srv["command"], *srv["args"]], "alias": "mcp-add"})
        return "start", args, env, pre
    if aid == "N18":
        user_settings(home, {"disableAllHooks": True})
        return "fact", args, env, pre
    if aid == "N19":
        cdir = os.path.join(A, "cfg")
        write_json(os.path.join(cdir, ".claude.json"), {"hasCompletedOnboarding": True, "theme": "dark"})
        s = rogue_mk_settings(rogue_marketplace(rog("n19"), "st-b1-rogue-mk19", "st-b1-rogue-n19"), "st-b1-rogue-mk19", "st-b1-rogue-n19")
        s.update(hooks_settings(mdir, "n19"))
        write_json(os.path.join(cdir, "settings.json"), s)
        env["CLAUDE_CONFIG_DIR"] = cdir
        return "start", args, env, pre
    raise SystemExit(f"attempt desconocido: {aid}")


# ── B1a: the driver ───────────────────────────────────────────────────────

SCREENS = {
    "trust": re.compile(r"Yes, I trust this folder"),
    "theme": re.compile(r"Choose the text style"),
    "login": re.compile(r"Select login method"),
    "mcp_approval": re.compile(r"New MCP server found in this project"),
}


def tmux(*a, check=True):
    return subprocess.run(["tmux", "-L", TMUX_SOCKET, *a], capture_output=True, text=True, check=check)


def pane_text(sess):
    r = tmux("capture-pane", "-p", "-t", sess, check=False)
    return r.stdout if r.returncode == 0 else ""


def files_in(d):
    return sorted(os.path.relpath(os.path.join(p, f), d) for p, _, fs in os.walk(d) for f in fs) if os.path.isdir(d) else []


def probe_records(ws):
    recs = []
    for rel in files_in(os.path.join(ws, ".passb1", "out", "probe")):
        try:
            with open(os.path.join(ws, ".passb1", "out", "probe", rel), encoding="utf-8") as f:
                r = json.loads(f.read())
            if isinstance(r, dict) and r.get("probe") == PROBE:
                recs.append({k: r.get(k) for k in ("inst", "seq", "kind")})
        except (OSError, ValueError):
            recs.append({"unreadable": True})
    return recs


# A seed directory is synced after the startup plugin load, so what it brings loads on the
# next start of the same HOME (seen with 2.1.314): that attack takes two starts.
TWO_STARTS = {"N12"}


def one_start(aid, n, A, ws, cli, args, full_env, timeout, settle):
    """Starts the CLI once in tmux, answers only what the agent itself could answer (trust,
    theme, a project MCP server), waits for the probe or the exit, and stops it."""
    sess, rcf = f"{aid}-{n}", os.path.join(A, f"rc-{n}")
    out = {"screens": {k: False for k in SCREENS}, "rc": None, "timed_out": False}
    envs = " ".join(f"{k}={sh_quote(v)}" for k, v in sorted(full_env.items()))
    argv = " ".join(sh_quote(x) for x in [cli, *args, "--debug-file", os.path.join(A, f"debug-{n}.log")])
    cmd = f"cd {sh_quote(ws)} && env -i {envs} {argv} 2> {sh_quote(os.path.join(A, f'stderr-{n}.txt'))}; echo $? > {sh_quote(rcf)}"
    probe_dir = os.path.join(ws, ".passb1", "out", "probe")
    before = set(files_in(probe_dir))
    starts_before = sum(1 for r in probe_records(ws) if r.get("kind") == "session.start")
    tmux("new-session", "-d", "-s", sess, "-x", "200", "-y", "50", "sh", "-c", cmd)
    t0 = time.monotonic()
    tries, next_try, control_at = {"trust": 0, "mcp_approval": 0, "theme": 0}, 0.0, None
    try:
        while time.monotonic() - t0 < timeout:
            if os.path.exists(rcf):
                break
            text = pane_text(sess)
            for k, rx in SCREENS.items():
                if not rx.search(text):
                    continue
                out["screens"][k] = True
                if time.monotonic() < next_try or k == "login" or tries.get(k, 3) >= 3:
                    continue
                # Keys sent back to back are lost by the selector: one key, a pause, the next,
                # and try again while the question is still on screen.
                keys = {"trust": ("Down", "Enter"), "theme": ("Enter",),
                        # "Use this MCP server" is two lines above the default "Continue without".
                        "mcp_approval": ("Up", "Up", "Enter")}[k]
                for key in keys:
                    tmux("send-keys", "-t", sess, key, check=False)
                    time.sleep(0.5)
                tries[k] += 1
                next_try = time.monotonic() + 2
            if control_at is None and sum(1 for r in probe_records(ws) if r.get("kind") == "session.start") > starts_before:
                control_at = time.monotonic()
            if control_at is not None and time.monotonic() - control_at >= settle:
                break
            time.sleep(0.5)
        else:
            out["timed_out"] = True
        if not os.path.exists(rcf):
            for _ in range(2):
                tmux("send-keys", "-t", sess, "C-c", check=False)
                time.sleep(1)
            for _ in range(20):
                if os.path.exists(rcf):
                    break
                time.sleep(0.5)
        try:
            with open(rcf, encoding="utf-8") as f:
                out["rc"] = int(f.read().strip())
        except (OSError, ValueError):
            out["rc"] = None
        out["tries"] = tries
        out["trust_still_shown"] = bool(SCREENS["trust"].search(pane_text(sess)))
    finally:
        tmux("kill-session", "-t", sess, check=False)
    # The probe files this start added (distinct inst per load): the control for THIS start.
    new = sorted(set(files_in(probe_dir)) - before)
    kinds = []
    for rel in new:
        try:
            with open(os.path.join(probe_dir, rel), encoding="utf-8") as f:
                r = json.loads(f.read())
            if isinstance(r, dict) and r.get("probe") == PROBE and r.get("kind"):
                kinds.append(r["kind"])
        except (OSError, ValueError):
            pass
    out["probe_kinds"] = sorted(set(kinds))
    return out


def attempt(aid, root, cli, timeout=60, settle=4):
    A = os.path.join(root, aid)
    if os.path.exists(A):
        raise SystemExit(f"{A} ya existe: cada intento usa una carpeta nueva")
    home, ws = os.path.join(A, "home"), os.path.join(A, "ws")
    os.makedirs(ws)
    seed_home(home)
    meta = {}
    kind, args, env, pre = prepare(aid, A, home, meta)
    base_env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": home, "TERM": "xterm-256color", "LANG": "C.UTF-8",
                "DISABLE_AUTOUPDATER": "1"}
    res = {"id": aid, "kind": kind, "impostor_paths": meta.get("impostor_paths", []), "pre": [], "starts": []}
    servers = []
    try:
        for p in pre:
            if "serve" in p:
                servers.append(subprocess.Popen([sys.executable, "-I", "-m", "http.server", str(p["port"]), "--bind", "127.0.0.1",
                                                 "--directory", p["serve"]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
                time.sleep(0.5)
                continue
            r = subprocess.run([cli, *p["cli"]], cwd=ws, env={**base_env, **env}, capture_output=True, text=True, timeout=60)
            with open(os.path.join(A, f"pre-{p['alias']}.txt"), "w", encoding="utf-8") as f:
                f.write(r.stdout + r.stderr)
            res["pre"].append({"alias": p["alias"], "rc": r.returncode})
        for n in range(1, 3 if aid in TWO_STARTS else 2):
            res["starts"].append(one_start(aid, n, A, ws, cli, args, {**base_env, **env}, timeout, settle))
    finally:
        for s in servers:
            s.terminate()
    # One debug log and one stderr per attempt, in start order: what the capture filters.
    for name, part in (("debug.log", "debug"), ("stderr.txt", "stderr")):
        with open(os.path.join(A, name), "w", encoding="utf-8") as out:
            for n in range(1, len(res["starts"]) + 1):
                ext = "log" if part == "debug" else "txt"
                try:
                    with open(os.path.join(A, f"{part}-{n}.{ext}"), encoding="utf-8", errors="replace") as f:
                        out.write(f.read())
                except OSError:
                    pass
    last = res["starts"][-1]
    res.update(rc=last["rc"], timed_out=last["timed_out"], screens={k: any(s["screens"][k] for s in res["starts"]) for k in SCREENS},
               trust_still_shown=any(s["trust_still_shown"] for s in res["starts"]))
    res["probe"] = probe_records(ws)
    res["markers"] = sorted(set(files_in(os.path.join(ws, ".passb1", "out", "marker")) + files_in(os.path.join(A, "marker"))))
    write_json(os.path.join(A, "result.json"), res)
    return res


def sh_quote(s):
    return "'" + str(s).replace("'", "'\"'\"'") + "'"


# ── B1b: H-ND measurements ───────────────────────────────────────────────

libc = ctypes.CDLL(None, use_errno=True)
PTRACE_TRACEME, PTRACE_PEEKDATA, PTRACE_GETREGS, PTRACE_DETACH, PTRACE_SEIZE = 0, 2, 12, 17, 0x4206
SYS_process_vm_readv, SYS_pidfd_open, SYS_pidfd_getfd = 310, 434, 438
libc.ptrace.restype = ctypes.c_long
libc.ptrace.argtypes = [ctypes.c_long, ctypes.c_long, ctypes.c_void_p, ctypes.c_void_p]
libc.syscall.restype = ctypes.c_long


class IOVec(ctypes.Structure):
    _fields_ = [("base", ctypes.c_void_p), ("len", ctypes.c_size_t)]


def try_call(fn):
    try:
        fn()
        return "ok"
    except OSError as e:
        return errname(e)


def proc_owner_uid(pid, entry="environ"):
    """Owner of /proc/PID/<entry>: root while the task is not dumpable (task_dump_owner)."""
    return os.stat(f"/proc/{pid}/{entry}").st_uid


def first_mapping(pid):
    with open(f"/proc/{pid}/stat", encoding="utf-8") as f:
        fields = f.read().rpartition(")")[2].split()
    return int(fields[25])  # startcode: an address that is always mapped


def starttime(pid):
    with open(f"/proc/{pid}/stat", encoding="utf-8") as f:
        return int(f.read().rpartition(")")[2].split()[19])


def hnd_stat(pid):
    """Every read the same uid could try against PID, each with its outcome. A value of
    "ok" means the read succeeded (for a dumpable process that is expected)."""
    out = {"starttime": starttime(pid), "owner_uid": {}, "reads": {}}
    for e in ("environ", "auxv", "maps", "mem", "fdinfo", "status", "cmdline"):
        try:
            out["owner_uid"][e] = proc_owner_uid(pid, e)
        except OSError as ex:
            out["owner_uid"][e] = errname(ex)

    def read(path, n=64):
        with open(path, "rb") as f:
            f.read(n)

    for e in ("environ", "auxv", "maps"):
        out["reads"][e] = try_call(lambda e=e: read(f"/proc/{pid}/{e}"))

    def mem():
        with open(f"/proc/{pid}/mem", "rb") as f:
            f.seek(first_mapping(pid))
            f.read(8)
    out["reads"]["mem"] = try_call(mem)

    def fdlink():
        os.readlink(f"/proc/{pid}/fd/0")
    out["reads"]["fd_link"] = try_call(fdlink)
    out["reads"]["fdinfo"] = try_call(lambda: read(f"/proc/{pid}/fdinfo/0"))
    out["reads"]["exe_link"] = try_call(lambda: os.readlink(f"/proc/{pid}/exe"))

    def vm_readv():
        buf = ctypes.create_string_buffer(8)
        local = IOVec(ctypes.cast(buf, ctypes.c_void_p), 8)
        remote = IOVec(ctypes.c_void_p(first_mapping(pid)), 8)
        r = libc.syscall(SYS_process_vm_readv, pid, ctypes.byref(local), 1, ctypes.byref(remote), 1, 0)
        if r < 0:
            raise OSError(ctypes.get_errno(), "process_vm_readv")
    out["reads"]["process_vm_readv"] = try_call(vm_readv)

    def seize():
        r = libc.ptrace(PTRACE_SEIZE, pid, None, None)
        if r < 0:
            raise OSError(ctypes.get_errno(), "ptrace")
        libc.ptrace(PTRACE_DETACH, pid, None, None)
    out["reads"]["ptrace_seize"] = try_call(seize)

    def getfd():
        pfd = libc.syscall(SYS_pidfd_open, pid, 0)
        if pfd < 0:
            raise OSError(ctypes.get_errno(), "pidfd_open")
        try:
            r = libc.syscall(SYS_pidfd_getfd, pfd, 0, 0)
            if r < 0:
                raise OSError(ctypes.get_errno(), "pidfd_getfd")
            os.close(r)
        finally:
            os.close(pfd)
    out["reads"]["pidfd_getfd"] = try_call(getfd)
    out["starttime_after"] = starttime(pid)
    return out


def ancestor(cmd, outdir, observe_s=20):
    """H4 and H4b. Child A: plain fork+exec of CMD, then we (its parent) try every read
    (Yama ptrace_scope=1 lets an ancestor attach; H-ND must not). Child B: PTRACE_TRACEME
    before exec, so we are its tracer across the exec of an unreadable binary: we record
    whether memory and registers are still ours, then detach and let it run."""
    os.makedirs(outdir, exist_ok=True)
    res = {}
    a = os.fork()
    if a == 0:
        os.execv(cmd[0], cmd)
    time.sleep(observe_s / 2)
    res["plain"] = {"alive": os.waitpid(a, os.WNOHANG) == (0, 0), **hnd_stat(a)}
    b = os.fork()
    if b == 0:
        libc.ptrace(PTRACE_TRACEME, 0, None, None)
        os.execv(cmd[0], cmd)
    _, st = os.waitpid(b, 0)  # stops with SIGTRAP at exec
    pre = {"stopped_at_exec": os.WIFSTOPPED(st)}
    ctypes.set_errno(0)
    v = libc.ptrace(PTRACE_PEEKDATA, b, ctypes.c_void_p(first_mapping(b)), None)
    pre["peekdata"] = "ok" if not (v == -1 and ctypes.get_errno()) else errname(OSError(ctypes.get_errno(), ""))
    regs = ctypes.create_string_buffer(27 * 8)
    r = libc.ptrace(PTRACE_GETREGS, b, None, regs)
    pre["getregs"] = "ok" if r == 0 else errname(OSError(ctypes.get_errno(), ""))
    pre["owner_uid_environ"] = proc_owner_uid(b)
    libc.ptrace(PTRACE_DETACH, b, None, None)
    res["traced_before_exec"] = pre
    write_json(os.path.join(outdir, "ancestor.json"), res)
    for p in (a, b):
        try:
            os.kill(p, 15)
        except OSError:
            pass
    return res


def immut(path):
    """Every way this uid could change the file or the directory that holds it. Stat first;
    a change that succeeds is undone where it can be (rename back), and unlink goes last."""
    d = os.path.dirname(path)
    st, sd = os.stat(path), os.stat(d)
    r = {"file": {"uid": st.st_uid, "gid": st.st_gid, "mode": oct(stat.S_IMODE(st.st_mode))},
         "dir": {"uid": sd.st_uid, "mode": oct(stat.S_IMODE(sd.st_mode))}}

    def wr():
        with open(path, "ab"):
            pass
    r["open_write"] = try_call(wr)
    r["chmod"] = try_call(lambda: os.chmod(path, stat.S_IMODE(st.st_mode)))
    r["rename"] = try_call(lambda: os.rename(path, path + ".b1"))
    if r["rename"] == "ok":
        os.rename(path + ".b1", path)
    hl = f"/tmp/passb1-hl-{os.getpid()}"
    r["hardlink_tmp"] = try_call(lambda: os.link(path, hl))
    if r["hardlink_tmp"] == "ok":
        os.unlink(hl)
    newf = os.path.join(d, f"b1-new-{os.getpid()}")
    r["create_in_dir"] = try_call(lambda: os.close(os.open(newf, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)))
    if r["create_in_dir"] == "ok":
        os.unlink(newf)
    r["rename_dir"] = try_call(lambda: os.rename(d, d + ".b1"))
    if r["rename_dir"] == "ok":
        os.rename(d + ".b1", d)
    r["unlink"] = try_call(lambda: os.unlink(path))
    return r


def inventory(size, sha, roots=("/",)):
    """Regular files of exactly the CLI's size, by path class: readable copies let the agent
    start a CLI that is dumpable; only the root copy may be inscribed."""
    hits = []
    for root in roots:
        for d, dirs, fs in os.walk(root):
            if d.startswith(("/proc", "/sys", "/dev")):
                dirs[:] = []
                continue
            for fn in fs:
                p = os.path.join(d, fn)
                try:
                    st = os.lstat(p)
                except OSError:
                    continue
                if not stat.S_ISREG(st.st_mode) or st.st_size != size:
                    continue
                readable = os.access(p, os.R_OK)
                same = None
                if readable:
                    h = hashlib.sha256()
                    with open(p, "rb") as f:
                        for chunk in iter(lambda: f.read(1 << 20), b""):
                            h.update(chunk)
                    same = h.hexdigest() == sha
                hits.append({"path_class": path_class(p), "readable": readable, "same_sha256": same,
                             "uid": st.st_uid, "mode": oct(stat.S_IMODE(st.st_mode))})
    return {"copies": hits}


def path_class(p):
    for k, rx in (("opt-st-hnd", r"^/opt/st-hnd/"), ("npm-global", r"/\.npm-global/"), ("npm-cache", r"/\.npm/"),
                  ("local-share", r"/\.local/share/claude/"), ("tmp", r"^/tmp/")):
        if re.search(rx, p):
            return k
    return "other"


def tree_sha256(root):
    """sha256 over (relative path, sha256 of content) of every regular file, sorted."""
    h = hashlib.sha256()
    for rel in files_in(root):
        with open(os.path.join(root, rel), "rb") as f:
            h.update(rel.encode() + b"\0" + hashlib.sha256(f.read()).hexdigest().encode() + b"\n")
    return h.hexdigest()


def applied(managed, market):
    """B1a setup: the policy and the marketplace the CLI will read are the kit's, and this
    uid can change neither (the mounts are read-only)."""
    out = {"managed_files": files_in(managed), "managed_sha256": tree_sha256(managed), "market_sha256": tree_sha256(market)}
    for tag, d in (("managed", managed), ("market", market)):
        probe = os.path.join(d, f".b1-{os.getpid()}")
        out[f"{tag}_create"] = try_call(lambda: os.close(os.open(probe, os.O_CREAT | os.O_WRONLY, 0o644)))
        victim = os.path.join(d, files_in(d)[0]) if files_in(d) else d
        out[f"{tag}_rename"] = try_call(lambda: os.rename(victim, victim + ".b1"))
        out[f"{tag}_unlink"] = try_call(lambda: os.unlink(victim))
    return out


def sysinfo():
    def rd(p):
        try:
            with open(p, encoding="utf-8") as f:
                return f.read().strip()
        except OSError as e:
            return errname(e)
    cp = rd("/proc/sys/kernel/core_pattern")
    return {"kernel": os.uname().release, "ptrace_scope": rd("/proc/sys/kernel/yama/ptrace_scope"),
            "suid_dumpable": rd("/proc/sys/fs/suid_dumpable"), "core_pattern_is_pipe": cp.startswith("|"),
            "core_pattern_absolute": cp.startswith("/"), "protected_hardlinks": rd("/proc/sys/fs/protected_hardlinks"),
            "rlimit_core_hard": rd_limit()}


def rd_limit():
    import resource
    h = resource.getrlimit(resource.RLIMIT_CORE)[1]
    return "unlimited" if h == resource.RLIM_INFINITY else h


# ── host side (shared with B0; H6c designed, not authorized) ──────────────

def image_version(history_text):
    vers = set(re.findall(r"CLAUDE_CODE_VERSION=(\d+\.\d+\.\d+)", history_text))
    return {"version": vers.pop() if len(vers) == 1 else None, "candidates": sorted(vers)}


def check_limits(inspect, stamp, kit, mounts):
    """What Docker applied, compared with what the runner asked. `mounts` is a list of
    "src:dst" that must be exactly the container's bind mounts, all read-only."""
    c = json.load(open(inspect))[0] if isinstance(inspect, str) else inspect
    hc, why = c["HostConfig"], []

    def want(cond, msg):
        if not cond:
            why.append(msg)
    want(c["Config"]["Labels"].get("passb1.experiment") == stamp, "label")
    want(c["Config"].get("User") == "developer", "user")
    want(hc.get("CapDrop") == ["ALL"] and not hc.get("CapAdd"), "caps")
    want("no-new-privileges:true" in (hc.get("SecurityOpt") or []), "no-new-privileges")
    want(hc.get("Privileged") is False, "privileged")
    want(hc.get("PidsLimit") == 256, "pids")
    want(hc.get("Memory") == 2 * 1024 ** 3 and hc.get("MemorySwap") == 2 * 1024 ** 3, "memory")
    want(hc.get("NanoCpus") == 10 ** 9, "cpus")
    want(hc.get("PidMode") in ("", None) and hc.get("IpcMode") in ("private", "", None), "namespaces")
    want(not hc.get("Binds") and not hc.get("VolumesFrom") and not hc.get("Devices"), "extra-binds")
    got = sorted((m.get("Source"), m.get("Destination"), m.get("RW"), m.get("Type")) for m in c.get("Mounts") or [])
    exp = sorted((s, d, False, "bind") for s, _, d in (x.partition(":") for x in mounts))
    want(got == exp, "mounts")
    want(not any("docker.sock" in (m.get("Source") or "") for m in c.get("Mounts") or []), "docker-sock")
    return why


def manifest(res, items):
    st = dict(i.split("=", 1) for i in items)
    complete = bool(st) and all(v == "ok" for v in st.values())
    obj = {"complete": complete, "items": st}
    write_json(os.path.join(res, "capture-manifest.json"), obj)
    return obj


def host_exe(host_pid, want_starttime, want_dev, want_ino, container_id):
    """H6c (designed, not authorized). Read-only, as root on the host: is the process the
    gateway would inscribe exactly the experiment's CLI, running from the root copy?
    The pidfd pins the process; every fact is re-read after it and must not change."""
    pfd = libc.syscall(SYS_pidfd_open, host_pid, 0)
    if pfd < 0:
        return {"error": errname(OSError(ctypes.get_errno(), ""))}
    try:
        def facts():
            with open(f"/proc/{host_pid}/cgroup", encoding="utf-8") as f:
                cg = container_id in f.read()
            st = os.stat(f"/proc/{host_pid}/exe")
            return {"starttime": starttime(host_pid), "cgroup_is_container": cg, "dev": st.st_dev, "ino": st.st_ino,
                    "uid": st.st_uid, "mode": stat.S_IMODE(st.st_mode)}
        a = facts()
        b = facts()
        alive = libc.syscall(424, pfd, 0, None, 0) == 0  # pidfd_send_signal(sig 0)
    finally:
        os.close(pfd)
    return {"stable": a == b, "alive_after": alive, "starttime_match": a["starttime"] == want_starttime,
            "cgroup_is_container": a["cgroup_is_container"], "exe_is_root_copy": (a["dev"], a["ino"]) == (want_dev, want_ino),
            "exe_owner_root": a["uid"] == 0, "exe_not_readable_by_others": not a["mode"] & 0o044}


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("seed")
    s.add_argument("--home", required=True)
    s = sub.add_parser("attempt")
    s.add_argument("--id", required=True, choices=ATTEMPTS)
    s.add_argument("--root", required=True)
    s.add_argument("--cli", required=True)
    s.add_argument("--timeout", type=int, default=60)
    s = sub.add_parser("hnd-stat")
    s.add_argument("--pid", type=int, required=True)
    s.add_argument("--out")
    s = sub.add_parser("ancestor")
    s.add_argument("--out", required=True)
    s.add_argument("--observe-s", type=int, default=20)
    s.add_argument("argv", nargs=argparse.REMAINDER)
    s = sub.add_parser("immut")
    s.add_argument("--path", required=True)
    s.add_argument("--out")
    s = sub.add_parser("inventory")
    s.add_argument("--size", type=int, required=True)
    s.add_argument("--sha256", required=True)
    s.add_argument("--out")
    s = sub.add_parser("sysinfo")
    s.add_argument("--out")
    s = sub.add_parser("applied")
    s.add_argument("--managed", required=True)
    s.add_argument("--market", required=True)
    s.add_argument("--out")
    sub.add_parser("imageversion")
    s = sub.add_parser("checklimits")
    s.add_argument("inspect")
    s.add_argument("stamp")
    s.add_argument("kit")
    s.add_argument("mounts", nargs="*")
    s = sub.add_parser("manifest")
    s.add_argument("res")
    s.add_argument("items", nargs="*")
    s = sub.add_parser("hostexe")
    for k in ("--pid", "--starttime", "--dev", "--ino"):
        s.add_argument(k, type=int, required=True)
    s.add_argument("--container-id", required=True)
    a = ap.parse_args(argv)
    if a.cmd == "seed":
        seed_home(a.home)
        print("ok")
    elif a.cmd == "attempt":
        emit(attempt(a.id, a.root, a.cli, a.timeout))
    elif a.cmd == "hnd-stat":
        emit(hnd_stat(a.pid), a.out)
    elif a.cmd == "ancestor":
        cmd = a.argv[1:] if a.argv[:1] == ["--"] else a.argv
        emit(ancestor(cmd, a.out, a.observe_s))
    elif a.cmd == "immut":
        emit(immut(a.path), a.out)
    elif a.cmd == "inventory":
        emit(inventory(a.size, a.sha256), a.out)
    elif a.cmd == "sysinfo":
        emit(sysinfo(), a.out)
    elif a.cmd == "applied":
        emit(applied(a.managed, a.market), a.out)
    elif a.cmd == "imageversion":
        emit(image_version(sys.stdin.read()))
    elif a.cmd == "checklimits":
        why = check_limits(a.inspect, a.stamp, a.kit, a.mounts)
        if why:
            print("distinto de lo pedido: " + ", ".join(why), file=sys.stderr)
            return 1
        print("ok")
    elif a.cmd == "manifest":
        emit(manifest(a.res, a.items))
    elif a.cmd == "hostexe":
        if os.environ.get("B1B_HOSTEXE_AUTHORIZED") != a.container_id:
            print("hostexe no está autorizado (04-poc.md §1.14.15): no se ejecuta", file=sys.stderr)
            return 77
        emit(host_exe(a.pid, a.starttime, a.dev, a.ino, a.container_id))
    return 0


if __name__ == "__main__":
    sys.exit(main())

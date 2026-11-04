"""Tests of b1.py helpers on real processes and files (no CLI, no Docker).
A non-dumpable target is made with prctl(PR_SET_DUMPABLE, 0) in the child: the kernel
treats it exactly as a process exec'd from an unreadable binary (both end in
set_dumpable(mm, 0)), which is what H2/H3/H4 measure. Run: python3 test/test_b1.py"""
import ctypes
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import b1  # noqa: E402

SLEEPER = "import ctypes,sys,time\nif sys.argv[1]=='nd': ctypes.CDLL(None).prctl(4,0,0,0,0)\nprint('ready',flush=True)\ntime.sleep(60)\n"


def target(nd):
    p = subprocess.Popen([sys.executable, "-I", "-c", SLEEPER, "nd" if nd else "d"], stdout=subprocess.PIPE, text=True,
                         env={"PASSB1_SECRET": "x" * 8, "PATH": "/usr/bin:/bin"})
    assert p.stdout.readline().strip() == "ready"
    return p


def stat_from_other_process(pid):
    # A separate process: not an ancestor of the target, like the agent's tools.
    r = subprocess.run([sys.executable, "-I", os.path.join(os.path.dirname(HERE), "b1.py"), "hnd-stat", "--pid", str(pid)],
                       capture_output=True, text=True, timeout=30)
    return json.loads(r.stdout)


class McpApprovalDriver(unittest.TestCase):
    """C3: a disappeared dialog does not prove approval. The driver separates SELECTION,
    CONFIRMATION and RESULT; "confirmed" needs the approve option selected, the dialog closed while
    the CLI kept running, AND an independent accept signal — which 2.1.314 does not emit, so a real
    approval stays INCONCLUSIVE."""

    def test_classify_selection_yields_only_enums(self):
        # D4: the raw option label is classified to a known enum before anything is persisted.
        pane = ("New MCP server found in this project: st-b1-rogue-n17p\n"
                "\n  ❯ 1. Use this MCP server\n  2. Continue without this MCP server\n")
        self.assertEqual(b1.classify_selection(pane), "approve")
        self.assertEqual(b1.classify_selection("> Use this and all MCP servers\n  Other"), "approve")
        self.assertEqual(b1.classify_selection("❯ 3. Continue without this MCP server"), "decline")
        self.assertEqual(b1.classify_selection("❯ Some other menu entry"), "other")
        self.assertIsNone(b1.classify_selection("no pointer here\n  2. plain line\n"))
        self.assertIn(b1.classify_selection(pane), (None, "approve", "decline", "other"))

    def test_real_approval_without_signal_is_not_confirmed(self):
        # The approve option selected and the dialog closed while running — but no acceptance signal
        # on 2.1.314, so NOT "confirmed" (=> analyzer INCONCLUSIVE).
        self.assertEqual(b1.mcp_approval_result("approve", "running", True, False), "selected-no-signal")

    def test_confirmed_only_with_an_independent_signal(self):
        self.assertEqual(b1.mcp_approval_result("approve", "running", True, True), "confirmed")

    def test_continue_without_is_declined(self):
        self.assertEqual(b1.mcp_approval_result("decline", "running", True, False), "declined")

    def test_dialog_gone_by_cli_exit_is_not_approval(self):
        self.assertEqual(b1.mcp_approval_result("approve", "exit", True, False), "dismissed-by-exit")

    def test_persistent_dialog_is_screen_only(self):
        self.assertEqual(b1.mcp_approval_result("approve", "persistent", True, False), "screen-only")

    def test_never_seen_is_none(self):
        self.assertEqual(b1.mcp_approval_result(None, None, False, False), "none")

    def test_one_start_init_persists_no_raw_name_or_option_text(self):
        # D4: the per-start dict exposes booleans + enums only — no mcp_approval_server / _selected.
        import inspect as _inspect
        src = _inspect.getsource(b1.one_start)
        self.assertNotIn("mcp_approval_server", src)
        self.assertNotIn("mcp_approval_selected\"", src)
        self.assertIn("mcp_approval_selection", src)
        self.assertIn("mcp_approval_name_matches", src)


class HndStat(unittest.TestCase):
    def test_non_dumpable_target_is_root_owned_and_unreadable(self):
        p = target(nd=True)
        try:
            s = stat_from_other_process(p.pid)
        finally:
            p.kill()
            p.wait()
        self.assertEqual({e: s["owner_uid"][e] for e in ("environ", "auxv", "maps", "mem")}, dict.fromkeys(("environ", "auxv", "maps", "mem"), 0))
        # fdinfo/ is a world r-x directory: task_dump_owner keeps the task's euid for it.
        self.assertEqual(s["owner_uid"]["fdinfo"], os.getuid())
        for k in ("environ", "auxv", "maps", "mem", "fd_link", "fdinfo", "exe_link", "process_vm_readv", "ptrace_seize", "pidfd_getfd"):
            self.assertNotEqual(s["reads"][k], "ok", k)
        self.assertEqual(s["starttime"], s["starttime_after"])

    def test_dumpable_control_is_readable_in_read_mode(self):
        p = target(nd=False)
        try:
            s = stat_from_other_process(p.pid)
        finally:
            p.kill()
            p.wait()
        self.assertEqual(s["owner_uid"]["environ"], os.getuid())
        for k in ("environ", "auxv", "maps", "fd_link", "fdinfo", "exe_link"):
            self.assertEqual(s["reads"][k], "ok", k)
        # Yama ptrace_scope=1: a non-ancestor is refused ATTACH even for a dumpable process.
        if open("/proc/sys/kernel/yama/ptrace_scope").read().strip() == "1":
            for k in ("mem", "process_vm_readv", "ptrace_seize", "pidfd_getfd"):
                self.assertNotEqual(s["reads"][k], "ok", k)

    def test_nothing_secret_leaves(self):
        p = target(nd=False)
        try:
            out = json.dumps(stat_from_other_process(p.pid))
        finally:
            p.kill()
            p.wait()
        self.assertNotIn("xxxxxxxx", out)
        self.assertNotIn("PASSB1_SECRET", out)


def ptrace_allowed():
    pid = os.fork()
    if pid == 0:
        r = b1.libc.ptrace(b1.PTRACE_TRACEME, 0, None, None)
        os._exit(0 if r == 0 else 1)
    _, st = os.waitpid(pid, 0)
    return os.WIFEXITED(st) and os.WEXITSTATUS(st) == 0


class Ancestor(unittest.TestCase):
    @unittest.skipUnless(ptrace_allowed(), "ptrace not permitted here (seccomp)")
    def test_ancestor_against_non_dumpable_and_dumpable_children(self):
        d = tempfile.mkdtemp()
        # The child makes itself non-dumpable right after it starts: the plain ancestor reads
        # must then be refused, while the traced-before-exec child was stopped earlier.
        res = b1.ancestor([sys.executable, "-I", "-c", SLEEPER, "nd"], d, observe_s=2)
        self.assertTrue(res["plain"]["alive"])
        self.assertEqual(res["plain"]["owner_uid"]["environ"], 0)
        self.assertNotEqual(res["plain"]["reads"]["environ"], "ok")
        self.assertNotEqual(res["plain"]["reads"]["mem"], "ok")
        self.assertTrue(res["traced_before_exec"]["stopped_at_exec"])
        self.assertEqual(res["traced_before_exec"]["getregs"], "ok")
        ctl = b1.ancestor([sys.executable, "-I", "-c", SLEEPER, "d"], tempfile.mkdtemp(), observe_s=2)
        self.assertEqual(ctl["plain"]["reads"]["environ"], "ok")
        self.assertEqual(ctl["plain"]["reads"]["mem"], "ok", "an ancestor may read a dumpable child")
        self.assertEqual(ctl["traced_before_exec"]["peekdata"], "ok")
        self.assertTrue(os.path.exists(os.path.join(d, "ancestor.json")))


class Immut(unittest.TestCase):
    def test_writable_file_is_reported_writable(self):
        d = tempfile.mkdtemp()
        f = os.path.join(d, "claude")
        with open(f, "w") as fh:
            fh.write("x")
        r = b1.immut(f)
        for k in ("open_write", "chmod", "rename", "create_in_dir", "unlink"):
            self.assertEqual(r[k], "ok", k)
        self.assertEqual(r["file"]["uid"], os.getuid())
        self.assertEqual(sorted(os.listdir(d)), [], "only the unlink, which goes last, may change the folder")

    def test_root_owned_file_in_root_dir_is_not(self):
        if os.getuid() == 0 or not os.path.exists("/usr/bin/env"):
            self.skipTest("needs a root-owned file and a non-root uid")
        r = b1.immut("/usr/bin/env")
        for k in ("open_write", "chmod", "rename", "unlink", "create_in_dir", "rename_dir"):
            self.assertNotEqual(r[k], "ok", k)


class Inventory(unittest.TestCase):
    def test_finds_copies_by_size_and_hash_without_reading_unreadable_ones(self):
        d = tempfile.mkdtemp()
        data = b"cli-binary" * 100
        for name in ("a", "b"):
            with open(os.path.join(d, name), "wb") as f:
                f.write(data)
        os.chmod(os.path.join(d, "b"), 0o000)
        import hashlib
        r = b1.inventory(len(data), hashlib.sha256(data).hexdigest(), roots=(d,))
        by = sorted((c["readable"], c["same_sha256"]) for c in r["copies"])
        if os.getuid() != 0:
            self.assertEqual(by, [(False, None), (True, True)])


class Fixtures(unittest.TestCase):
    def test_every_attempt_prepares_and_names_only_its_own_rogue(self):
        for aid in b1.ATTEMPTS:
            with self.subTest(aid):
                A = tempfile.mkdtemp()
                home = os.path.join(A, "home")
                os.makedirs(os.path.join(A, "ws"))
                b1.seed_home(home)
                kind, args, env, pre = b1.prepare(aid, A, home, {})
                self.assertIn(kind, ("start", "exit", "fact"))
                blob = json.dumps([args, env, pre])
                for other in b1.ATTEMPTS:
                    if other != aid and other.startswith("N") and len(other) >= 3:
                        self.assertNotIn(f"st-b1-rogue-{other.lower()}\"", blob)
                self.assertNotIn("ANTHROPIC", blob)
                self.assertNotIn("TOKEN", blob)

    def test_rogue_plugin_and_impostor(self):
        d = tempfile.mkdtemp()
        b1.rogue_plugin(os.path.join(d, "r"), "st-b1-rogue-x")
        with open(os.path.join(d, "r", "hooks", "register.mjs")) as f:
            self.assertIn(".passb1/out/marker/st-b1-rogue-x.json", f.read())
        b1.impostor_plugin(os.path.join(d, "i"))
        with open(os.path.join(d, "i", ".claude-plugin", "plugin.json")) as f:
            self.assertEqual(json.load(f)["name"], "st-b1-probe")
        with open(os.path.join(d, "i", "hooks", "register.mjs")) as f:
            self.assertIn("marker/impostor.json", f.read())

    def test_exit_attempts_are_the_sideload_ones(self):
        for aid in b1.ATTEMPTS:
            A = tempfile.mkdtemp()
            os.makedirs(os.path.join(A, "ws"))
            kind = b1.prepare(aid, A, os.path.join(A, "home"), {})[0]
            self.assertEqual(kind == "exit", aid in ("N1", "N2", "N3", "N4", "N5a", "N5b"), aid)

    def test_pending_paths_are_not_attempts(self):
        self.assertNotIn("N15", b1.ATTEMPTS)
        self.assertIn("N15", b1.PENDING)
        self.assertIn("@synced", b1.PENDING)


class CheckLimits(unittest.TestCase):
    def inspect(self, **over):
        hc = {"CapDrop": ["ALL"], "CapAdd": None, "SecurityOpt": ["no-new-privileges:true"], "Privileged": False, "PidsLimit": 256,
              "Memory": 2 * 1024 ** 3, "MemorySwap": 2 * 1024 ** 3, "NanoCpus": 10 ** 9, "NetworkMode": "none", "PidMode": "", "IpcMode": "private",
              "Binds": None, "VolumesFrom": None, "Devices": []}
        hc.update(over)
        return {"Config": {"Labels": {"passb1.experiment": "S"}, "User": "developer"}, "HostConfig": hc,
                "Mounts": [{"Type": "bind", "Source": "/k", "Destination": "/opt/passb1-kit", "RW": False}]}

    def test_good_and_each_deviation(self):
        self.assertEqual(b1.check_limits(self.inspect(), "S", "/k", ["/k:/opt/passb1-kit"]), [])
        for over, why in (({"CapAdd": ["SYS_PTRACE"]}, "caps"), ({"SecurityOpt": []}, "no-new-privileges"), ({"Privileged": True}, "privileged"),
                          ({"PidMode": "host"}, "namespaces"), ({"Binds": ["/:/host"]}, "extra-binds"),
                          ({"NetworkMode": "bridge"}, "network"), ({"NetworkMode": "host"}, "network"), ({"NetworkMode": None}, "network")):
            with self.subTest(why):
                self.assertIn(why, b1.check_limits(self.inspect(**over), "S", "/k", ["/k:/opt/passb1-kit"]))
        i = self.inspect()
        i["Mounts"][0]["RW"] = True
        self.assertIn("mounts", b1.check_limits(i, "S", "/k", ["/k:/opt/passb1-kit"]))
        self.assertIn("mounts", b1.check_limits(self.inspect(), "S", "/k", ["/k:/opt/passb1-kit", "/m:/etc/claude-code/managed-settings.d"]))


class HostExe(unittest.TestCase):
    def test_refuses_without_explicit_authorization(self):
        r = subprocess.run([sys.executable, "-I", os.path.join(os.path.dirname(HERE), "b1.py"), "hostexe", "--pid", str(os.getpid()),
                            "--starttime", "1", "--dev", "1", "--ino", "1", "--container-id", "c" * 64],
                           capture_output=True, text=True, env={"PATH": "/usr/bin:/bin"})
        self.assertEqual(r.returncode, 77)
        self.assertEqual(r.stdout, "")

    def test_identity_facts_on_this_process(self):
        st = os.stat(f"/proc/{os.getpid()}/exe")
        r = b1.host_exe(os.getpid(), b1.starttime(os.getpid()), st.st_dev, st.st_ino, "no-such-container")
        self.assertTrue(r["stable"])
        self.assertTrue(r["alive_after"])
        self.assertTrue(r["starttime_match"])
        self.assertTrue(r["exe_is_root_copy"])
        self.assertFalse(r["cgroup_is_container"])
        r = b1.host_exe(os.getpid(), 1, st.st_dev, st.st_ino + 1, "x")
        self.assertFalse(r["starttime_match"])
        self.assertFalse(r["exe_is_root_copy"])


class Applied(unittest.TestCase):
    def test_writable_dirs_are_reported(self):
        m, k = tempfile.mkdtemp(), tempfile.mkdtemp()
        with open(os.path.join(m, "b1a.json"), "w") as f:
            f.write("{}")
        with open(os.path.join(k, "x"), "w") as f:
            f.write("y")
        r = b1.applied(m, k)
        self.assertEqual(r["managed_create"], "ok")
        self.assertEqual(len(r["managed_sha256"]), 64)


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""S1 step 3: idle-wake samples through fakechat.

For each sample: wait until the CLI is verifiably at its prompt and idle for at
least --min-idle seconds, send ONE message through fakechat's local /upload,
then record whether a UserPromptSubmit for it arrives (wake), its `source`,
the exact prompt shape and the Stop of the same prompt_id. Stops at the first
non-wake, at any StopFailure (plan limit, error) or on Ctrl-C. Never retries a
message. Run on the VM host:  python3 -I s1-wake.py --count 10 --min-idle 30
"""
import argparse
import json
import os
import secrets
import subprocess
import sys
import time

AGENT = "poc-agent"
OUT_IN_AGENT = "/workspace/poc-out"
HERE = os.path.dirname(os.path.abspath(__file__))


def sh(*args, check=True):
    r = subprocess.run(["docker", "exec", "-u", "developer", AGENT, *args],
                       capture_output=True, text=True, timeout=60)
    if check and r.returncode != 0:
        raise RuntimeError(f"{args[0]} failed: {r.stderr.strip()[:300]}")
    return r.stdout


def hooks():
    out = sh("cat", f"{OUT_IN_AGENT}/hooks.jsonl", check=False)
    rows = []
    for line in out.splitlines():
        try:
            rows.append(json.loads(line))
        except ValueError:
            pass
    return rows


def ev(row):
    return row.get("event", {}).get("hook_event_name")


def probe():
    """Return (ok, detail): exactly one interactive session at its prompt."""
    try:
        data = json.loads(sh("claude", "agents", "--json"))
    except Exception as e:  # noqa: BLE001
        return False, f"probe-error:{e}"
    entries = data if isinstance(data, list) else data.get("agents", data.get("sessions", []))
    inter = [e for e in entries if e.get("kind") == "interactive"]
    if len(inter) != 1:
        return False, f"interactive={len(inter)}"
    e = inter[0]
    st, wf = e.get("status"), e.get("waitingFor")
    ok = st == "idle" or (st == "waiting" and wf in (None, "", "input needed"))
    return ok, f"status={st} waitingFor={wf}"


def wait_idle(min_idle, limit):
    deadline = time.time() + limit
    while time.time() < deadline:
        rows = hooks()
        if any(ev(r) == "StopFailure" for r in rows):
            return False, "stop-failure-present", None
        last = max((r["recv_ts"] for r in rows), default=0.0)
        last_ups = max((r["recv_ts"] for r in rows if ev(r) == "UserPromptSubmit"), default=0.0)
        last_stop = max((r["recv_ts"] for r in rows if ev(r) == "Stop"), default=0.0)
        mid_turn = last_ups > last_stop
        ok, detail = probe()
        idle_for = time.time() - last if last else None
        if ok and not mid_turn and (idle_for is None or idle_for >= min_idle):
            return True, detail, idle_for
        time.sleep(10)
    return False, "idle-timeout", None


def send(mid, text):
    code = sh("curl", "-s", "-m", "10", "-o", "/dev/null", "-w", "%{http_code}",
              "-F", f"id={mid}", "-F", f"text={text}", "http://127.0.0.1:8787/upload", check=False)
    return code.strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, required=True)
    ap.add_argument("--min-idle", type=int, required=True)
    ap.add_argument("--label", default=None)
    ap.add_argument("--wake-timeout", type=int, default=120)
    ap.add_argument("--turn-timeout", type=int, default=300)
    a = ap.parse_args()
    label = a.label or ("long" if a.min_idle >= 3600 else "short")
    out = os.path.join(HERE, "out", f"s1-wake-{label}-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}")
    os.makedirs(out)
    log = open(os.path.join(out, "sends.jsonl"), "a", encoding="utf-8")
    for i in range(1, a.count + 1):
        ok, detail, idle_for = wait_idle(a.min_idle, a.min_idle + 900)
        if not ok:
            rec = {"label": label, "n": i, "result": "not-sent", "reason": detail}
            log.write(json.dumps(rec) + "\n"); log.flush()
            print(json.dumps(rec)); return 6
        mid = f"poc-{label}-{i}-{secrets.token_hex(3)}"
        text = f"Prueba de fase 0 {mid}: respondé solamente OK-{i}. No uses herramientas."
        before = hooks()
        seen = {json.dumps(r, sort_keys=True) for r in before}
        prior_prompt_ids = {r.get("event", {}).get("prompt_id") for r in before} - {None}
        sent_at = time.time()
        http = send(mid, text)
        rec = {"label": label, "n": i, "msg_id": mid, "sent_at": sent_at, "idle_before_s": idle_for,
               "probe_before": detail, "upload_http": http}
        ups, stop, others = None, None, []
        deadline = sent_at + a.wake_timeout
        while time.time() < deadline and ups is None:
            time.sleep(1)
            for r in hooks():
                if json.dumps(r, sort_keys=True) in seen:
                    continue
                e = r.get("event", {})
                if ev(r) == "UserPromptSubmit" and f'message_id="{mid}"' in e.get("prompt", ""):
                    ups = r
                elif ev(r) == "UserPromptSubmit":
                    others.append(r)
        if ups is None:
            rec.update(result="no-wake", other_prompts=len(others))
            log.write(json.dumps(rec) + "\n"); log.flush()
            print(json.dumps({k: rec[k] for k in ("n", "msg_id", "result")})); return 5
        pe = ups["event"]
        rec.update(result="wake", latency_s=round(ups["recv_ts"] - sent_at, 3),
                   source=pe.get("source", "<absent>"), prompt=pe.get("prompt"),
                   prompt_id=pe.get("prompt_id"), session_id=pe.get("session_id"),
                   other_prompts_before_wake=len(others),
                   prompt_id_seen_before=pe.get("prompt_id") in prior_prompt_ids)
        deadline = time.time() + a.turn_timeout
        while time.time() < deadline and stop is None:
            time.sleep(2)
            rows = hooks()
            if any(ev(r) == "StopFailure" and r["recv_ts"] > sent_at for r in rows):
                rec["stop_failure"] = True
                break
            for r in rows:
                if ev(r) == "Stop" and r["recv_ts"] > ups["recv_ts"] and r["event"].get("prompt_id") == pe.get("prompt_id"):
                    stop = r
                    break
        rec["stop_same_prompt_id"] = stop is not None
        rec["stop_latency_s"] = round(stop["recv_ts"] - sent_at, 3) if stop else None
        log.write(json.dumps(rec, ensure_ascii=False) + "\n"); log.flush()
        print(json.dumps({k: rec.get(k) for k in ("n", "msg_id", "result", "latency_s", "source", "stop_same_prompt_id")}))
        if rec.get("stop_failure"):
            print("StopFailure (límite del plan o error): fase 0 detenida", file=sys.stderr); return 7
    return 0


if __name__ == "__main__":
    sys.exit(main())

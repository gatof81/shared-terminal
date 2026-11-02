"""Phase-0 hook recorder: append the raw hook input, with the receive time, to
$POC_OUT/hooks.jsonl. It never blocks or fails the CLI: any error exits 0."""
import fcntl
import json
import os
import sys
import time

try:
    raw = sys.stdin.read()
    out_dir = os.environ.get("POC_OUT", "/workspace/poc-out")
    os.makedirs(out_dir, exist_ok=True)
    try:
        event = json.loads(raw)
    except ValueError:
        event = {"unparsed": raw[:4096]}
    line = json.dumps({"recv_ts": time.time(), "event": event}, ensure_ascii=False)
    with open(os.path.join(out_dir, "hooks.jsonl"), "a", encoding="utf-8") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        f.write(line + "\n")
except Exception:  # noqa: BLE001 - a recorder must never break the session
    pass
sys.exit(0)

#!/usr/bin/python3 -IS
# ──────────────────────────────────────────────────────────────────────────────
# Conversation capture relay (docs/CONVERSATION.md §2.6).
#
# Claude Code 2.1.308 refuses to send an HTTP hook to a host that resolves to
# a private or link-local address, and `st-backend` on sessions-net always
# does. Loopback is allowed, so the managed hooks target this process on
# 127.0.0.1 and it forwards to the backend. It is NOT a proxy: one fixed
# destination, one fixed path, and nothing the backend says ever reaches the
# CLI — every hook gets an empty 204 as soon as its body is queued, so a hook
# can never decide, block or alter anything.
#
# Started by entrypoint.sh only when capture is effective (token in the env
# and the managed hooks file present); otherwise it never runs.
#
# Bounded everywhere: ≤ 16 inbound connections, a FIFO of ≤ 1024 events and
# 16 MiB (bodies being read included, one copy each), plus the one body in
# flight upstream (≤ 8 MiB, sent without a copy), 2 s socket timeouts both
# ways, one in-order upstream connection. Plain sockets rather than http.server /
# http.client: half the resident memory, and nothing it answers is generated
# by a library (no error pages echoing the request). Whatever cannot be delivered is counted and
# reported to the backend on the next delivered event of the same
# conversation (X-ST-Relay-* headers ⇒ `gap relay_dropped`/`relay_restart`).
# A 204 from here means "received in the container", never "persisted".
#
# Never logs bodies, headers or the token. Stdlib only; run as
# `python3 -IS` so no PYTHON* variable or user site-packages can change it.
# ──────────────────────────────────────────────────────────────────────────────
import collections
import os
import re
import socket
import sys
import threading
import time

LISTEN_HOST = "127.0.0.1"
# Fixed by the contract; overridable for the automated tests only, and only
# ever on loopback.
LISTEN_PORT = int(os.environ.get("ST_RELAY_LISTEN_PORT") or 47613)
UPSTREAM_HOST = "st-backend"
UPSTREAM_PORT = int(os.environ.get("ST_BACKEND_PORT") or 3001)
PATH = "/ingest/claude/hook"

MAX_BODY = 8 * 1024 * 1024  # L5
QUEUE_EVENTS = 1024
QUEUE_BYTES = 16 * 1024 * 1024
MAX_CONNECTIONS = 16
SOCKET_TIMEOUT = 2.0
PAUSE_AFTER_FAILURE = 1.0
# Express closes an idle keep-alive socket after 5 s; reconnecting before
# that avoids most writes into a socket the backend is about to close.
UPSTREAM_IDLE_MAX = 4.0
MAX_GROUPS = 256
ANNOUNCED_MAX = 4096
RESPONSE_READ_MAX = 64 * 1024

TOKEN = os.environ.get("ST_INGEST_TOKEN", "")
SESSION = os.environ.get("SESSION_ID", "")
GENERATION = int(os.environ.get("ST_RELAY_GENERATION") or 0)
DEBUG = os.environ.get("ST_HOOKS_DEBUG") == "1"
STATS_INTERVAL = float(os.environ.get("ST_RELAY_STATS_INTERVAL") or 5)

PANE_RE = re.compile(r"%\d{1,6}")
# The CLI serialises the hook input with session_id as its first key. Only
# these bytes are ever looked at; the rest of the body is opaque.
SID_RE = re.compile(rb'\{\s*"session_id"\s*:\s*"([0-9a-fA-F-]{36})"')
DIGITS_RE = re.compile(r"[0-9]{1,10}")


class Counters:
    def __init__(self):
        self.lock = threading.Lock()
        self.values = collections.Counter()

    def inc(self, name, n=1):
        with self.lock:
            self.values[name] += n

    def snapshot(self):
        with self.lock:
            return dict(self.values)


stats = Counters()


class Losses:
    """Undelivered events, grouped by conversation (or pane when unknown)."""

    def __init__(self):
        self.lock = threading.Lock()
        self.groups = {}  # key -> [count, bytes]
        self.unattributed = 0

    def add(self, key, nbytes):
        with self.lock:
            g = self.groups.get(key)
            if g is None:
                if key is None or len(self.groups) >= MAX_GROUPS:
                    self.unattributed += 1
                    return
                g = self.groups[key] = [0, 0]
            g[0] += 1
            g[1] += nbytes

    def take(self, keys):
        """Remove and return what the next delivery will report."""
        with self.lock:
            n = b = 0
            taken = []
            for k in keys:
                g = self.groups.pop(k, None)
                if g:
                    taken.append((k, g))
                    n += g[0]
                    b += g[1]
            u, self.unattributed = self.unattributed, 0
            return n, b, u, taken

    def restore(self, taken, unattributed):
        with self.lock:
            for k, g in taken:
                cur = self.groups.setdefault(k, [0, 0])
                cur[0] += g[0]
                cur[1] += g[1]
            self.unattributed += unattributed


losses = Losses()


def group_key(sid, pane):
    if sid:
        return ("s", sid)
    if pane:
        return ("p", pane)
    return None


def session_of(body):
    m = SID_RE.match(body, 0, 128)
    return m.group(1).decode("ascii").lower() if m else None


def drop(reason, nbytes, sid=None, pane=""):
    stats.inc("dropped")
    stats.inc("dropped_" + reason)
    losses.add(group_key(sid, pane), nbytes)


class Fifo:
    def __init__(self):
        self.cond = threading.Condition()
        self.items = collections.deque()
        self.reserved = 0
        self.bytes = 0

    def reserve(self, nbytes):
        with self.cond:
            if len(self.items) + self.reserved >= QUEUE_EVENTS or self.bytes + nbytes > QUEUE_BYTES:
                return False
            self.reserved += 1
            self.bytes += nbytes
            return True

    def cancel(self, nbytes):
        with self.cond:
            self.reserved -= 1
            self.bytes -= nbytes

    def put(self, body, pane):
        with self.cond:
            self.reserved -= 1
            self.items.append((body, pane))
            depth = len(self.items)
            self.cond.notify()
        with stats.lock:
            stats.values["queue_max"] = max(stats.values["queue_max"], depth)

    def get(self):
        with self.cond:
            while not self.items:
                self.cond.wait()
            body, pane = self.items.popleft()
            self.bytes -= len(body)
            return body, pane


fifo = Fifo()


# ── HTTP/1.1, the small subset both sides use ──────────────────────────────

HEAD_MAX = 16 * 1024


def read_head(sock, buf):
    """(head, rest) once b"\r\n\r\n" arrived, else (None, why): "eof", "timeout" or "big"."""
    while b"\r\n\r\n" not in buf:
        if len(buf) > HEAD_MAX:
            return None, "big"
        try:
            chunk = sock.recv(65536)
        except socket.timeout:
            return None, "timeout"
        except OSError:
            return None, "eof"
        if not chunk:
            return None, "eof"
        buf += chunk
    head, _, rest = buf.partition(b"\r\n\r\n")
    if len(head) > HEAD_MAX:
        return None, "big"
    return head, rest


def parse_headers(lines):
    out = {}
    for line in lines:
        name, sep, value = line.partition(b":")
        if not sep:
            continue
        # Only ASCII header names matter here; anything else is ignored.
        out[name.strip().lower().decode("latin-1")] = value.strip().decode("latin-1")
    return out


def read_exact(sock, buf, n):
    """(body, rest), or (None, b"") if the peer stops short or times out.

    The body is received straight into one preallocated buffer: a single
    copy per body, which is what the queue's byte budget accounts for.
    """
    body = bytearray(n)
    view = memoryview(body)
    have = min(len(buf), n)
    view[:have] = buf[:have]
    rest = buf[n:]
    while have < n:
        try:
            got = sock.recv_into(view[have:], min(65536, n - have))
        except OSError:
            return None, b""
        if not got:
            return None, b""
        have += got
    return body, rest


def send_all(sock, *parts):
    """sendall() of several buffers without joining them (no body copy)."""
    views = [memoryview(p) for p in parts if p]
    while views:
        sent = sock.sendmsg(views)
        while sent and views:
            if sent >= len(views[0]):
                sent -= len(views[0])
                views.pop(0)
            else:
                views[0] = views[0][sent:]
                sent = 0


def discard(sock, buf, n):
    """Read and drop an n-byte body: (its first 128 bytes, rest), or (None, b"")."""
    first = buf[:min(n, 128)]
    have = min(len(buf), n)
    rest = buf[n:]
    while have < n:
        try:
            chunk = sock.recv(min(65536, n - have))
        except OSError:
            return None, b""
        if not chunk:
            return None, b""
        if len(first) < 128:
            first += chunk[: 128 - len(first)]
        have += len(chunk)
    return first, rest


NO_CONTENT_CLOSE = b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n"
NOT_FOUND = b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
STATUS_PATH = b"/st-relay/status"
# Identification for the backend's probe (CONVERSATION.md §2.6, §2.7.6): a
# user process holding the port would not answer this, which is the
# difference between "something listens" and "the relay listens". Headers
# only — no body, no token, no counter, nothing that came from a hook.
STATUS = (
    "HTTP/1.1 204 No Content\r\nX-ST-Relay: 1\r\n"
    f"X-ST-Relay-Generation: {GENERATION}\r\nConnection: close\r\n\r\n"
).encode("latin-1")
BAD_REQUEST = b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
CONTINUE = b"HTTP/1.1 100 Continue\r\n\r\n"


# ── Inbound ─────────────────────────────────────────────────────────────────


def serve_connection(sock):
    """One request per connection: answered 204 and closed (see the end)."""
    sock.settimeout(SOCKET_TIMEOUT)
    buf = b""
    head, buf = read_head(sock, buf)
    if head is None:
        return
    lines = head.split(b"\r\n")
    parts = lines[0].split(b" ")
    if len(parts) != 3 or not parts[2].startswith(b"HTTP/1."):
        sock.sendall(BAD_REQUEST)
        return
    method, target, _ = parts
    if method == b"GET" and target == STATUS_PATH:
        sock.sendall(STATUS)
        return
    headers = parse_headers(lines[1:])
    if method != b"POST" or target != PATH.encode():
        sock.sendall(NOT_FOUND)
        return
    stats.inc("received")
    raw_pane = headers.get("x-st-tmux-pane", "")
    pane = raw_pane if PANE_RE.fullmatch(raw_pane) else ""
    declared = headers.get("content-length", "")
    # Refused without reading the body: whatever of it arrived with the
    # headers is enough to tell, usually, whose conversation it was.
    if "transfer-encoding" in headers or not DIGITS_RE.fullmatch(declared) or int(declared) > MAX_BODY:
        drop("too_large", 0, session_of(buf), pane)
        sock.sendall(NO_CONTENT_CLOSE)
        return
    n = int(declared)
    reserved = fifo.reserve(n)
    if headers.get("expect", "").lower() == "100-continue":
        sock.sendall(CONTINUE)
    if reserved:
        body, buf = read_exact(sock, buf, n)
        if body is None:
            fifo.cancel(n)
            drop("read_error", n, session_of(buf), pane)
            return
        fifo.put(body, pane)
        # The queue owns it now; nothing outside its budget keeps it.
        del body
    else:
        # Queue full: the body is read and dropped rather than left
        # unread — closing on unread data resets the connection, which
        # the CLI would show as a hook error.
        first, buf = discard(sock, buf, n)
        drop("queue_full", n, session_of(first or b""), pane)
        if first is None:
            return
    # Never keep-alive. An idle socket the relay closes (2 s read
    # timeout) races the client's next hook: the CLI (Bun) pools idle
    # sockets for 5 s, so a hook sent as the relay closes lands on a
    # dead socket and the CLI prints "hook error". Measured with the
    # real CLI: 4/20 turns at a 1.97 s gap, 0 with this. No relay idle
    # timeout is safe against a client pool we don't control (the CLI
    # self-updates), and a new loopback connection per hook is cheap.
    sock.sendall(NO_CONTENT_CLOSE)


def accept_loop(listener):
    slots = threading.BoundedSemaphore(MAX_CONNECTIONS)

    def run(sock):
        try:
            serve_connection(sock)
        except OSError:
            pass
        finally:
            sock.close()
            slots.release()

    while True:
        try:
            sock, _ = listener.accept()
        except OSError:
            continue
        if not slots.acquire(blocking=False):
            # Not reading the request: its pane and conversation are unknown.
            drop("busy", 0)
            try:
                sock.settimeout(SOCKET_TIMEOUT)
                sock.sendall(NO_CONTENT_CLOSE)
            except OSError:
                pass
            sock.close()
            continue
        threading.Thread(target=run, args=(sock,), daemon=True).start()


# ── Outbound ────────────────────────────────────────────────────────────────


class Upstream:
    def __init__(self):
        self.sock = None
        self.buf = b""
        self.last_used = 0.0

    def close(self):
        if self.sock is not None:
            self.sock.close()
            self.sock = None
            self.buf = b""

    def post(self, body, headers):
        """True on a 2xx. Whatever the backend answers goes no further."""
        if self.sock is not None and time.monotonic() - self.last_used > UPSTREAM_IDLE_MAX:
            self.close()
        request = (
            f"POST {PATH} HTTP/1.1\r\nHost: {UPSTREAM_HOST}:{UPSTREAM_PORT}\r\n"
            + "".join(f"{k}: {v}\r\n" for k, v in headers.items())
            + f"Content-Length: {len(body)}\r\n\r\n"
        ).encode("latin-1")
        for attempt in (0, 1):
            reused = self.sock is not None
            try:
                if not reused:
                    self.sock = socket.create_connection((UPSTREAM_HOST, UPSTREAM_PORT), timeout=SOCKET_TIMEOUT)
                send_all(self.sock, request, body)
                head, rest = read_head(self.sock, self.buf)
            except socket.timeout:
                head, rest = None, "timeout"
            except OSError:
                head, rest = None, "eof"
            if head is None:
                self.close()
                # A kept-alive socket the backend closed while idle: the
                # request never got an answer, so one retry on a new socket.
                # Never after a timeout — the backend may be processing it.
                if reused and attempt == 0 and rest == "eof":
                    continue
                return False
            self.buf = rest
            return self.finish(head)
        return False

    def finish(self, head):
        lines = head.split(b"\r\n")
        status = lines[0].split(b" ")
        code = int(status[1]) if len(status) >= 2 and status[1].isdigit() else 0
        headers = parse_headers(lines[1:])
        self.last_used = time.monotonic()
        length = headers.get("content-length", "")
        keep = headers.get("connection", "").lower() != "close" and "transfer-encoding" not in headers
        if code in (204, 304) or 100 <= code < 200:
            pass
        elif DIGITS_RE.fullmatch(length) and int(length) <= RESPONSE_READ_MAX:
            _, self.buf = read_exact(self.sock, self.buf, int(length))
            if _ is None:
                keep = False
        else:
            keep = False
        if not keep:
            self.close()
        return 200 <= code < 300


def forward_loop():
    upstream = Upstream()
    announced = collections.OrderedDict()
    pause_until = 0.0
    base = {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + TOKEN,
        "X-ST-Session": SESSION,
    }
    while True:
        body, pane = fifo.get()
        sid = session_of(body)
        if time.monotonic() < pause_until:
            drop("paused", len(body), sid, pane)
            del body
            continue
        keys = [k for k in (group_key(sid, None), group_key(None, pane)) if k]
        n, b, unattributed, taken = losses.take(keys)
        headers = dict(base)
        headers["X-ST-Tmux-Pane"] = pane
        if n:
            headers["X-ST-Relay-Dropped"] = str(n)
            headers["X-ST-Relay-Dropped-Bytes"] = str(b)
        if unattributed:
            headers["X-ST-Relay-Unattributed"] = str(unattributed)
        if GENERATION > 0 and sid and sid not in announced:
            headers["X-ST-Relay-Restarted"] = "1"
        if upstream.post(body, headers):
            stats.inc("forwarded")
            if n:
                stats.inc("reported", n)
            if sid and GENERATION > 0:
                announced[sid] = True
                if len(announced) > ANNOUNCED_MAX:
                    announced.popitem(last=False)
        else:
            losses.restore(taken, unattributed)
            drop("upstream", len(body), sid, pane)
            pause_until = time.monotonic() + PAUSE_AFTER_FAILURE
        # Nor keep the last one sent while waiting for the next.
        del body


def stats_loop():
    last = None
    while True:
        time.sleep(STATS_INTERVAL)
        snap = stats.snapshot()
        if snap != last:
            print("st-relay " + " ".join(f"{k}={v}" for k, v in sorted(snap.items())), file=sys.stderr, flush=True)
            last = snap


def main():
    if not TOKEN or not SESSION:
        return 0
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    # A restart right after a kill finds the port's old connections in
    # TIME_WAIT; without this the bind fails for a minute. On Linux it
    # never lets two processes listen on the same port.
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        listener.bind((LISTEN_HOST, LISTEN_PORT))
        listener.listen(64)
    except OSError as e:
        print(f"st-relay: cannot listen on {LISTEN_HOST}:{LISTEN_PORT}: {e.strerror}", file=sys.stderr)
        return 3
    threading.Thread(target=forward_loop, name="forward", daemon=True).start()
    if DEBUG:
        threading.Thread(target=stats_loop, name="stats", daemon=True).start()
    print(f"st-relay listening on {LISTEN_HOST}:{LISTEN_PORT} generation={GENERATION}", file=sys.stderr, flush=True)
    accept_loop(listener)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)

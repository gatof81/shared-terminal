#!/usr/bin/env python3
"""Redact a copy of the evidence before it leaves the VM, then verify. Exit 2
if anything token-like survives: the caller must not archive anything."""
import pathlib
import re
import sys

PATTERNS = [
    (re.compile(r"sk-ant-[A-Za-z0-9_\-]+"), "sk-ant-<REDACTED>"),
    (re.compile(r'("?(?:access_token|refresh_token|id_token|accessToken|refreshToken)"?\s*[:=]\s*)"[^"]*"'), r'\1"<REDACTED>"'),
    (re.compile(r"(?i)(authorization:\s*)(bearer\s+)?\S+"), r"\1<REDACTED>"),
    (re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"), "<EMAIL>"),
    (re.compile(r'("?(?:accountUuid|organizationUuid|account_uuid|organization_uuid|userID|user_id)"?\s*[:=]\s*)"[^"]*"'), r'\1"<REDACTED>"'),
]
SURVIVORS = re.compile(r"sk-ant-(?!<REDACTED>)|(?i:bearer\s+[A-Za-z0-9._\-]{20,})|eyJ[A-Za-z0-9_\-]{20,}\.")

root = pathlib.Path(sys.argv[1])
bad = []
for p in root.rglob("*"):
    if not p.is_file():
        continue
    if p.name in (".credentials.json", ".claude.json"):
        p.unlink(); bad.append(f"{p}: archivo de credenciales eliminado de la copia")
        continue
    t = p.read_text(encoding="utf-8", errors="replace")
    for rx, rep in PATTERNS:
        t = rx.sub(rep, t)
    p.write_text(t, encoding="utf-8")
    if SURVIVORS.search(t):
        bad.append(f"{p}: queda un valor con forma de token")
for b in bad:
    print(b, file=sys.stderr)
sys.exit(2 if any("token" in b for b in bad) else 0)

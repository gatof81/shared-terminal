#!/usr/bin/env python3
"""S1 step 4: phase-0 report. Reads out/s1-start-*/registration.txt and every
out/s1-wake-*/sends.jsonl and writes out/phase0-report.md, keeping the four
dimensions apart: channel registration, effective wake, hook `source`, and
message correlation. The verdict follows docs/design/project-chat/04-poc.md
§1.7 literally; this script never decides a GO for the full POC."""
import glob
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
TAG = re.compile(r"<channel\b([^>]*)>", re.S)


def latest(pattern):
    xs = sorted(glob.glob(os.path.join(OUT, pattern)))
    return xs[-1] if xs else None


def attrs(s):
    return dict(re.findall(r'(\w+)="([^"]*)"', s))


reg_dir = latest("s1-start-*")
registration = "not-run"
if reg_dir:
    for line in open(os.path.join(reg_dir, "registration.txt")):
        if line.startswith("registration="):
            registration = line.strip().split("=", 1)[1]

rows = []
for f in sorted(glob.glob(os.path.join(OUT, "s1-wake-*", "sends.jsonl"))):
    rows += [json.loads(l) for l in open(f) if l.strip()]
rows.sort(key=lambda r: r.get("sent_at") or 0)

table = []
for r in rows:
    corr = "—"
    if r.get("result") == "wake":
        tags = TAG.findall(r.get("prompt") or "")
        a = attrs(tags[0]) if len(tags) == 1 else {}
        checks = {
            "una etiqueta": len(tags) == 1,
            "message_id": a.get("message_id") == r["msg_id"],
            "source de la etiqueta fakechat": "fakechat" in a.get("source", ""),
            # Recorded by s1-wake.py against EVERY earlier hook, not only earlier samples.
            "prompt_id nuevo": bool(r.get("prompt_id")) and not r.get("prompt_id_seen_before", True),
            "Stop del mismo prompt_id": bool(r.get("stop_same_prompt_id")),
            "sin otros prompts en la espera": r.get("other_prompts_before_wake", 0) == 0,
        }
        corr = "OK" if all(checks.values()) else "FALLA: " + ", ".join(k for k, v in checks.items() if not v)
        r["_corr_ok"] = all(checks.values())
    table.append(r | {"_corr": corr})

wakes = [r for r in rows if r.get("result") == "wake"]
short = [r for r in rows if r.get("label") == "short"]
long_ = [r for r in rows if r.get("label") == "long"]
sources = sorted({r.get("source") for r in wakes})
all_wake = len(rows) == 12 and len(wakes) == 12 and len(short) == 10 and len(long_) == 2
src_ok = bool(wakes) and sources == ["system"]
corr_ok = bool(wakes) and all(r.get("_corr_ok") for r in wakes)

if registration == "skipped":
    verdict = "**NO-GO**: Channels no se registra con la suscripción. No se cambia a API."
elif registration != "registered":
    verdict = "**Indeterminado**: sin evidencia de registro (fallo del harness, no NO-GO). Repetir S1 paso 2."
elif any(r.get("result") == "no-wake" for r in rows):
    verdict = "**NO-GO de Channels para despertar.** El responsable decide si se evalúa `asyncRewake` (R2)."
elif not all_wake:
    verdict = "**Incompleta**: faltan muestras (ver tabla). Sin veredicto."
elif src_ok and corr_ok:
    verdict = "**Fase 0 superada** (12/12, `source=system`, correlación OK). No es un GO de arquitectura: 12 muestras acotan la tasa de fallo en ≈ 25 %. Pedir GO separado para la POC completa."
else:
    verdict = "**Fase 0 superada en disponibilidad y despertar; G3/correlación en riesgo** (ver `source` y correlación). La POC completa sólo con GO explícito."

lines = ["# Informe de la fase 0", "", f"Veredicto: {verdict}", "",
         "## 1. Registro del canal", "", f"- Resultado: `{registration}` (`{reg_dir and os.path.basename(reg_dir)}`)", ""]
if reg_dir and os.path.exists(os.path.join(reg_dir, "channel-lines.log")):
    lines += ["```", open(os.path.join(reg_dir, "channel-lines.log")).read().strip()[:3000], "```", ""]
lines += ["## 2. Despertar, 3. `source` y 4. correlación", "",
          f"- Despertares: {len(wakes)}/{len(rows)} (cortos {sum(1 for r in short if r.get('result') == 'wake')}/{len(short)}, largos {sum(1 for r in long_ if r.get('result') == 'wake')}/{len(long_)})",
          f"- Valores de `source` observados: {', '.join(f'`{s}`' for s in sources) or '—'}",
          f"- Correlación completa: {'sí' if corr_ok else 'no'}", "",
          "| # | Tipo | Inactivo antes (s) | Despertó | Latencia (s) | `source` | Correlación |",
          "| --- | --- | --- | --- | --- | --- | --- |"]
for r in table:
    idle = r.get("idle_before_s")
    lines.append(f"| {r.get('n')} | {r.get('label')} | {round(idle) if isinstance(idle, (int, float)) else '—'} | "
                 f"{r.get('result')} | {r.get('latency_s', '—')} | `{r.get('source', '—')}` | {r['_corr']} |")
lines += ["", "## Forma exacta del primer prompt recibido", "", "```",
          (wakes[0].get("prompt") or "")[:2000] if wakes else "—", "```", ""]
open(os.path.join(OUT, "phase0-report.md"), "w").write("\n".join(lines) + "\n")
print(os.path.join(OUT, "phase0-report.md"))

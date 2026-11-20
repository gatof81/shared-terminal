# PASS-B1a — corrida 2 (diagnóstica) · handoff de ejecución para VM100

**Estado:** procedimiento **preparado, no ejecutado**. La sesión del asistente **no tiene Docker
ni acceso a VM100**; la corrida 2 la ejecuta el responsable en VM100. Revisá los valores reales de
VM100 (id del contenedor legacy, rutas, almacenamiento) **antes** de usar este procedimiento.

**Alcance autorizado (condicionado):** experimento **diagnóstico**, sólo **P0, N14, N17-project**,
con el kit fijado por SHA. N17-project sigue en **Opción A**: un **INCONCLUSIVE es esperado** y **no**
autoriza reinterpretar el resultado como *blocked* sin nueva evidencia causal.

**Retención:** ambos contenedores (corrida 1 y corrida 2) y ambas evidencias quedan **retenidos**.
**No se corre `cleanup`** en ninguno de los dos, ni siquiera tras una captura correcta. Este
procedimiento **no** incluye `cleanup`.

---

## 1. SHA del kit

```
poc/channels-phase0 @ 8eafe1a30b6e06f10b083658455779c37ad85d2c
```

Lista exacta de 17 archivos y hashes SHA256 (verificá el checkout/tarball contra esto antes de usar;
`e00ef29` y los kits intermedios quedan intactos):

```
fc5775a4e746e9d57057c174c829f445f035282b9b89a6219124ea92992db6f3  analyze_b1a.py
e33dc88811b9472ccbea4819e8af0cf9443ec575e76d8c1385d804fc9b87011f  analyze_b1b.py
8a0f8ce22f457e406f910fd1356ac299f6eef99ea2eb8cfee30b8826cc595ce3  b1.py
23a02a6dd40271761c57dcfe6ed265e550aacab8afda376fd0fa3e670c488932  managed/b1a.json
3a090f524c93fa3be45fa35ebd347b86ffe47801cacf6ede819095ecd71e2a55  marketplace/.claude-plugin/marketplace.json
c38e42b9a8ba4360b72465813088fe98b5e69a7ff5bf16ec4a43bc56ccb75514  marketplace/plugins/st-b1-probe/.claude-plugin/plugin.json
d87f4cbc7a53b0d733c13dd4c7f81e49d7ede3b21163e0d64e2234176d43100d  marketplace/plugins/st-b1-probe/hooks/hooks.json
707c35831bd4fa99d4e21f550c64a52de1ae2172c7fe5e4bdab16fb4245e0cf7  marketplace/plugins/st-b1-probe/hooks/register.mjs
bfac25ae1fa9ffb8faf7895440cc7506d39bbef80c280b55bdb22523e2e8e4e9  README.md
f7a5efa21d93614e367eb8bcd5751bdcbb4126ac098997d0f548b08212b67546  run-b1.sh
d91991cbd5e356132491ad22ca8b7f47d23e98606b49d0db745b3ec523ce358d  summary-b1a.py
9779770693681d5a0ca281c2bc8fa92701a8eac4c2fc8f00c7d9ed802dbe3624  test/fakebin/docker
c7418347977a0c94e67eab762714a138e656a59ebff5173a728709cf26cf60a0  test/test_analyze_b1a.py
a45744f700d780ee041179a919fe4f87d153049bb01b9287735e11ce2e92bf14  test/test_analyze_b1b.py
b814d049cb504c54766a4a0bc41b7b4b1a0556f104b2a6d1fe41d8297ec3e52a  test/test_b1.py
d4dd16ae8bd2599a80ce8c5fcd9aa4a9863ce9077ddc15ee8c845bd3ed8603d8  test/test_runner.py
dc73414e08a2a05476355c9c4e95630012e8cbbd8501ead099c433ddf7c999fa  test/test_summary.py
```

Verificación local del checkout (read-only):

```sh
cd <KIT>            # el directorio poc/passb1 del checkout en 8eafe1a
find . -type f -not -path './__pycache__/*' | sort | while read -r f; do
  printf '%s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "${f#./}"
done
# comparar contra la lista de arriba — debe coincidir EXACTAMENTE, sin archivos de más ni de menos
```

---

## 2. Identidad esperada del contenedor legacy (corrida 1) — comprobaciones de SOLO LECTURA

El contenedor de corrida 1 fue creado por `e00ef29`, que etiquetaba `passb1.experiment=<stamp>` y
`passb1.kind=b1a` pero **NO** `passb1.run` (esa etiqueta se agregó después). Identidad esperada:

| Campo | Valor esperado |
| --- | --- |
| Nombre | `passb1a-exp-20261104-142810` |
| Label `passb1.kind` | `b1a` |
| Label `passb1.experiment` | `20261104-142810` |
| Label `passb1.run` | **ausente** (admitido sólo para este contenedor legacy) |
| Id | 64-hex (el valor que pondrás en `RUN1_ID`) |

Comandos read-only para confirmarla y obtener `RUN1_ID` (no crean ni ejecutan nada):

```sh
LEG=passb1a-exp-20261104-142810
docker inspect -f '{{.Id}}'                                   "$LEG"   # -> RUN1_ID (64-hex)
docker inspect -f '{{.Name}}'                                 "$LEG"   # -> /passb1a-exp-20261104-142810
docker inspect -f '{{index .Config.Labels "passb1.kind"}}'    "$LEG"   # -> b1a
docker inspect -f '{{index .Config.Labels "passb1.experiment"}}' "$LEG" # -> 20261104-142810
docker inspect -f '{{index .Config.Labels "passb1.run"}}'     "$LEG"   # -> (vacío = ausente, correcto)
docker ps -a --filter label=passb1.experiment --format '{{.ID}} {{.Names}}'  # SÓLO debe listar el legacy
```

**STOP** si: el nombre no es exactamente `/passb1a-exp-20261104-142810`; `passb1.kind` ≠ `b1a`;
`passb1.experiment` ≠ `20261104-142810`; `passb1.run` está presente con un valor ≠ `1`; o aparece
**cualquier otro** contenedor con label `passb1.experiment` (el preflight del runner ya lo exige, y
además no toca al legacy — pero confirmalo vos primero).

---

## 3. Archivo `env` de corrida 2 (SIN credenciales)

Creá `BASE=~/passb1a-run2-<STAMP>` y `BASE/env` con exactamente estas claves (valores de datos; el
runner nunca hace `source` del archivo):

```
KIND=b1a
RUN2=1
STAMP=<STAMP>
KIT=<ruta absoluta al checkout poc/passb1 en 8eafe1a>
RES=<BASE>/results
EXP=passb1a-run2-exp-<STAMP>
IMAGE=shared-terminal-session
COMMIT=8eafe1a30b6e06f10b083658455779c37ad85d2c
MAN=<ruta a una copia de KIT/managed>
MKT=<ruta a una copia de KIT/marketplace>
RUN1_ID=<id 64-hex del contenedor legacy, del paso 2>
RUN1_EXP=passb1a-exp-20261104-142810
```

Notas: `EXP` debe calzar `passb1a-run2-exp-<STAMP>`; `RUN1_EXP` ≠ `EXP`; `RUN1_ID` debe ser 64-hex.
`MAN`/`MKT` deben ser **byte a byte** iguales a `KIT/managed` y `KIT/marketplace` (el preflight los
compara). No pongas secretos ni tokens: no se necesita ninguno.

---

## 4. Fases — comandos exactos (read-only vs. crean/ejecutan contenedor)

Invocación: `bash run-b1.sh "$BASE" <fase>`. Cada fase escribe `"OK: <fase>"` como última línea al
tener éxito y exige la marca de la fase anterior.

| Fase | ¿Qué hace con el contenedor? | Comando |
| --- | --- | --- |
| `preflight` | **SOLO LECTURA** — inspecciona imagen/labels, lista contenedores, compara `MAN`/`MKT`; **no crea ni ejecuta** nada. Escribe sólo `BASE/state` y `RES/preflight.json`. | `bash run-b1.sh "$BASE" preflight` |
| `setup` | **CREA** el contenedor (`docker run … --network none --cap-drop ALL --security-opt no-new-privileges`), monta policy+marketplace read-only, aplica límites. | `bash run-b1.sh "$BASE" setup` |
| `measure` | **EJECUTA** dentro del contenedor (`docker exec`/tmux): corre **sólo P0, N14, N17-project**. | `bash run-b1.sh "$BASE" measure` |
| `capture` | **LEE** el contenedor (`docker cp`), filtra logs a `RES`, escribe `SHA256SUMS` y el manifiesto. No crea contenedores. | `bash run-b1.sh "$BASE" capture` |
| `validate` | **SOLO LECTURA** (python local): corre el analizador sobre `RES`. Bajo `RUN2=1` auto-aplica `--scope P0,N14,N17-project` manteniendo todos los controles globales. | `bash run-b1.sh "$BASE" validate` |
| `cleanup` | **NO EJECUTAR.** Borraría el contenedor. Queda fuera de este procedimiento. | — (omitido a propósito) |

Fases de solo lectura: `preflight`, `validate`. Fases que crean/ejecutan: `setup` (crea),
`measure` (ejecuta), `capture` (lee + copia). Orden: `preflight → setup → measure → capture →
validate`.

---

## 5. Condiciones STOP

**Antes de `setup`:**
- Preflight no terminó en `OK: preflight`, o salió `3` (imagen ≠ 2.1.314) ⇒ STOP.
- Identidad del contenedor legacy ≠ lo esperado (paso 2), o aparece otro contenedor `passb1` ⇒ STOP.
- Nombre `EXP` ya ocupado ⇒ STOP.
- `MAN`/`MKT` no son byte a byte los del kit ⇒ STOP.
- **Almacenamiento:** el runner **no** chequea disco. Verificá **a mano** espacio suficiente en el
  filesystem del data-root de Docker **antes** de `setup`: `df -h /var/lib/docker` (o el data-root
  real). Poco espacio ⇒ STOP.

**Antes de `measure`:**
- `setup` no terminó en `OK: setup` ⇒ STOP (no sigas; el contenedor puede no cumplir los límites).
- `setup` valida internamente `NetworkMode=none`, `CapDrop=ALL`, `no-new-privileges` y la versión
  2.1.314 dentro del contenedor; si cualquiera falla, `setup` ya hace STOP (no marca `setup.ok`).

**Regla general:** si el entorno real de VM100 difiere de lo esperado en cualquier punto,
**detenerse y consultar** antes de continuar. No relajar ningún criterio para avanzar.

---

## 6. Verificación de `SHA256SUMS` después de `capture`

`capture` ya reverifica, pero confirmalo vos (read-only):

```sh
RES=<BASE>/results
cd "$RES" && sha256sum -c --quiet SHA256SUMS && echo "SHA256SUMS OK"
# 'complete' del manifiesto debe ser True:
python3 -I -c 'import json,sys; print(json.load(open("capture-manifest.json"))["complete"])'
```

STOP si `sha256sum -c` reporta cualquier `FAILED` o si `complete` no es `True`.

---

## 7. Resultados separados y consolidado (preservando procedencias)

**Separados (corrida 2):** tras `validate`, el veredicto scoped está en `RES/report.json`
(`facts.attempts` contiene sólo N14 y N17-project; P0 es el control/baseline evaluado por los
controles globales). Resultado por intento:

```sh
RES=<BASE>/results
python3 -I -c 'import json;r=json.load(open("'"$RES"'/report.json"));print(json.dumps(r["facts"]["attempts"],indent=2,ensure_ascii=False))'
# detalle por intento (sin datos sensibles; sólo alias/booleans):
for a in P0 N14 N17-project; do echo "== $a =="; cat "$RES/attempts/$a/result.json"; done
```

**Consolidado con ambas procedencias** (corrida 1 = `e00ef29`, corrida 2 = `8eafe1a`): usa la
evidencia retenida de corrida 1 (su `RES`, p. ej. `~/passb1a-20261104-142810/results`) y la de
corrida 2. `summary-b1a.py` revalida `SHA256SUMS` y los controles globales de cada corrida y cita la
procedencia de cada hallazgo; N10/N11/N13 quedan excluidos del denominador pero una ejecución
demostrada de ellos da FAIL con procedencia:

```sh
python3 -I <KIT>/summary-b1a.py \
  --run1 <RES_corrida1> --run1-sha e00ef29 \
  --run2 "$RES"         --run2-sha 8eafe1a \
  > "$RES/consolidated.json"
cat "$RES/consolidated.json"
```

Para entregar al asistente: pegá `RES/report.json`, el `sha256sum -c` de `SHA256SUMS`, los tres
`attempts/<id>/result.json` y `consolidated.json`. Son alias/booleans; no contienen nombres crudos
de servidores ni rutas completas ni secretos.

**Recordatorio final:** N17-project en Opción A ⇒ un **INCONCLUSIVE es un resultado esperado y
aceptable**; no se reinterpreta como *blocked* sin nueva evidencia causal. **No** corras `cleanup`:
ambos contenedores y ambas evidencias quedan retenidos hasta revisar los resultados.

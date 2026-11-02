# Project Chat — revisión crítica independiente

Revisión hecha el 2026-11-02 por un revisor sin el contexto del autor (subagente nuevo que recibió
sólo los documentos, el repo y el volcado de strings del binario 2.1.314). Foco: complejidad,
pérdida de mensajes, inyección, duplicados y carreras, reinicios, dependencia experimental,
versiones, dos mecanismos, costo. Veredicto inicial: **SHOULD-FIX** (0 BLOCKER, 7 SHOULD-FIX,
4 NIT). Todos los hallazgos se resolvieron en este mismo PR.

| # | Severidad | Hallazgo | Resolución |
| --- | --- | --- | --- |
| 1 | SHOULD-FIX | `unconfirmed` era final aunque el CLI pudiera tener el mensaje en su cola (`priority: "next"`) y ejecutarlo más tarde: el botón "Reenviar" y la siguiente entrega podían duplicar una orden o provocar el agrupamiento que el diseño quería evitar | Nuevo estado `uncertain` (cuenta como en vuelo, sin reenvío). Sale sólo por evidencia: `accepted{late}` o `unconfirmed` cuando el proceso terminó o el CLI volvió a su prompt tras un turno posterior (protocolo §3 regla 2b). Nueva fila E4c/E8 "tecleo humano 0,5 s después" |
| 2 | SHOULD-FIX | El clasificador exigía exactamente una etiqueta, en contradicción con las reglas de agrupación; la forma del hook agrupado no tenía criterio GO | Clasificador para N etiquetas y para el caso mezclado con texto tecleado (protocolo §5); nuevo criterio **G10** y repeticiones en E4b/E4c |
| 3 | SHOULD-FIX | `source: system` es opcional según el propio esquema del CLI ("Payloads may omit it while the field rolls out") | Salvedad citada en C8. *Ronda 2:* reemplazado — `source` ausente **no** acepta (ver ronda 2, corrección 1) |
| 4 | SHOULD-FIX | El log del proyecto no puede ser "el mismo mecanismo" que `conversation/store.ts`, que no hace fsync y descarta bajo presión | Sólo se reutiliza el formato; escritura con fsync (patrón `paneRecord.ts`) y sin ruta de descarte: falla con 503 en lugar de perder |
| 5 | SHOULD-FIX | Un `claude --resume` inmediato tras una salida o un crash dejaba dos runtimes ⇒ `ambiguous` sin salida definida; `startGen` no cambia con una salida del CLI | `hello`/`next` retiran runtimes cuyo `claude_pid` ya no existe antes de declarar ambigüedad; salida de `ambiguous` definida; fila del RFC corregida; E5a con salida inmediata y `kill -9` |
| 6 | SHOULD-FIX | `CHANNEL_CLI_VERSIONS` no se puede revalidar en CI (exige autenticación first-party real) y el auto-update dejaría sin canal a los agentes | Decisión **R9**: pin del CLI en sesiones de agente + corrida manual firmada (desde la ronda 2: con la suscripción del responsable, sin gasto adicional); añadido a riesgos |
| 7 | SHOULD-FIX | Criterios GO estadísticamente débiles (20/20 ⇒ hasta ~14 % de fallo; "p99" de 20 muestras; inactividad de 30 s no prueba #44380) | E2 = 60 muestras (12 tras ≥ 1 h), dos días; G5 = 30/30; regla del tres explícita; la POC prueba el mecanismo, el 95 % se mide en el piloto |
| 8 | NIT | El token de ingesta no es "por arranque" y cualquier proceso del contenedor lo tiene | Redacción corregida; frontera de confianza declarada (protocolo §7) |
| 9 | NIT | El lock de `next` usaba el singleton de ciclo de vida, cuyo guard es de recreación | Instancia propia de `SessionLifecycleLock`, como el Composer |
| 10 | NIT | Cómo recibe la respuesta el agente que pidió (U5) | Se publica en el proyecto; devolverla a ese agente sigue la regla agente→agente (aprobación o arista) |
| 11 | NIT | Enlaces rotos (`07-review.md` faltante; `.claude/` ignorado por git) y la prueba de NO-GO más barata llegaba tarde | Este archivo; `.gitignore` admite `.claude/skills/`; POC con **fase 0** usando el plugin oficial `fakechat` antes de construir nada |

Lo que el revisor comprobó y encontró correcto: la forma de la entrada en cola del binario
(`priority:"next"`, `isMeta`, `origin: channel`, `skipSlashCommands`); el filtro de claves de `meta`;
el escapado de valores; el gate del kill switch evaluado en cada notificación; `asyncRewake`; el enum
`source` con `system` para canales; la existencia de `onSessionDown`/`startGen`, `pid` en el probe,
`WS_PATH_PREFIXES`, la autenticación de la ingesta; que el frontend ignora tipos de evento
desconocidos; y la cobertura del brief (sin tmux, sin fallback por Composer, separación
entrega/procesamiento/resultado, aprobación agente→agente, migraciones sólo aditivas).

## Riesgos que quedan abiertos (no se resuelven con documentos)

- Que Channels despierte una sesión inactiva (#44380) y sobreviva a `--resume` sólo lo dice la POC.
- La dependencia de un research preview con kill switch remoto es una decisión de producto (R1).
- Las hipótesis marcadas **H** en el RFC §3.1 siguen siendo hipótesis hasta la POC.

---

## Ronda 2 (2026-11-02): correcciones pedidas por el responsable

Revisor independiente nuevo, sobre el commit con las cinco correcciones del responsable y la
restricción de autenticación (sólo suscripción). Veredicto inicial: **BLOCKER** (1 BLOCKER,
8 SHOULD-FIX, 1 NIT). Correcciones 1–3 y la autenticación: logradas. Correcciones 4 y 5: parciales.
Dos afirmaciones de hecho del revisor se verificaron contra CONVERSATION.md §8.2.1 antes de corregir.
Además el autor encontró un problema que el revisor no señaló: la deduplicación actual de
`user_prompt` por `prompt_id` (`dedupe.ts`) descarta justamente la entrada encolada.

| # | Severidad | Hallazgo | Resolución |
| --- | --- | --- | --- |
| 1 | BLOCKER | Un mensaje encolado detrás de un turno humano hereda su `prompt_id` (§8.2.1) y se marcaba `completed` con el informe de ese turno | §3.1 reescrito sobre la secuencia de eventos: A3 (`P` nuevo, si no `queued`), A4 (ningún otro prompt de ningún id), A5 (ningún cierre no anunciado) |
| 2 | SHOULD-FIX | Pérdidas del relay sin `gap` dentro de la ventana | A6–A7: decisión tras `T_settle`, relay limpio por generación y contador de pérdidas (ampliación del relay en P5); si no, `relay-unverified`. Riesgo residual declarado: hook que el CLI nunca envió |
| 3 | SHOULD-FIX | `accepted` sin salida por evidencia bloqueaba al agente hasta 24 h | `ended_unattributed{no-close}` tras dos probes "en su prompt" sin cierre |
| 4 | SHOULD-FIX | Un `unconfirmed` prematuro pasaba los criterios; "en su prompt" sin definir | Definición estricta (identidad, `waitingFor`, input vacío) en §4; G6/G12 exigen 0 `late_after_terminal`; filas E8 con diálogo y borrador |
| 5 | SHOULD-FIX | `degraded{source-absent}` disparable pegando una etiqueta; el texto tecleado no trae `source: user` sino ningún `source` | Texto corregido; `degraded{source-absent}` sólo si el `st_msg` es el de la entrega en vuelo |
| 6 | SHOULD-FIX | `degraded` se levantaba solo tras un reinicio o una reconexión | `degraded` por proceso (`st_session_id`, `claude_pid`, `claude_start_time`), persistido; fila E8 y G12 |
| 7 | SHOULD-FIX | Identidad de deduplicación de la evidencia de canal sin definir; colisiona con `user_prompt` | Espacio de claves propio; cambio de contrato §4.6 en P4 (`prompt_id` + hash), precondición de P6 (ronda 3) |
| 8 | SHOULD-FIX | Orden de eliminación imposible (`/logout` después de borrar) y escaneo de evidencias sin definir | `/logout` primero; lista cerrada de evidencias; patrones de redacción; nunca los archivos de credenciales |
| 9 | SHOULD-FIX (por verificar) | `fakechat` puede necesitar Bun y dependencias que el proxy bloquea | Se resuelve en S0 antes del login; un fallo del plugin es fallo del harness, nunca NO-GO |
| 10 | NIT | Restos: E0 "autenticación elegida", ancla rota, motivo `multiple-stop`, motivo `gap` | Alineados |

## Ronda 3 (2026-11-02): verificación de la ronda 2

Revisor independiente nuevo sobre las correcciones de la ronda 2. Confirmó resueltos los puntos 1
(en §3.1), 3, 4, 5, 7, 8 y 9, y probó sin éxito estos escenarios: notificaciones de tarea, `/clear`,
`/resume`, `SubagentStop`, `Stop` duplicado y hooks tardíos. Veredicto inicial: **BLOCKER**
(1 BLOCKER, 3 SHOULD-FIX, 3 NIT).

| # | Severidad | Hallazgo | Resolución |
| --- | --- | --- | --- |
| 1 | BLOCKER | La recuperación tras un reinicio del backend marcaba `completed` por la existencia de un `turn_end`, sin A1–A7: reabría el BLOCKER de la ronda 2 por ese camino | §9: la recuperación aplica A1–A7; la lectura de base del relay se persiste en el evento `delivery`; sin lectura nueva o con otra generación ⇒ `relay-unverified`. Fila E8 "reinicio durante `T_settle`" en G11 |
| 2 | SHOULD-FIX | Una pérdida del relay llevaba a `unconfirmed{no-evidence}` y a un `degraded` falso aunque Claude hubiera ejecutado el mensaje | La regla 2b exige relay limpio; si no, `unconfirmed{relay-loss}` con aviso "puede haberse ejecutado" y sin degradar; fila E8 nueva |
| 3 | SHOULD-FIX | Una caída del adaptador o un corte de red producían un `degraded` de kill switch; 2b (c) no tenía reloj sin `transported` | Se degrada sólo si la entrega llegó a `transported`, con todos los probes "en su prompt" y relay limpio; el reloj empieza en el vencimiento del lease; motivo `not-transported`; filas E8 y G12 alineadas |
| 4 | SHOULD-FIX | El log no podía guardar `degraded` por proceso ni la acción "Probar el canal otra vez" | Evento `runtime` con `claude_start_time`, `cleared{by}` y una identidad que no descarta un segundo `degraded` |
| 5 | NIT | El diagrama no tenía `transporting → accepted` | Añadido |
| 6 | NIT | La lectura de base de A7 no viajaba en `transported` | `POST transported` la trae |
| 7 | NIT | A8 dependía de una señal que no existe por conversación | Eliminado; el cambio de identidad de §4.6 es precondición de P6 |

Riesgo declarado, no resuelto: si un diálogo o un borrador en el Terminal impiden "en su prompt",
una entrega `accepted` sin cierre espera a la persona; se muestra como "necesita el Terminal".

## Ronda 4 (2026-11-02): verificación de la ronda 3

Revisor independiente nuevo. Confirmó resueltos los siete puntos de la ronda 3 y no encontró un
`completed` falso por recuperación, un `degraded` sin evidencia ni una salida automática de
`degraded`. Veredicto inicial: **SHOULD-FIX** (0 BLOCKER, 2 SHOULD-FIX, 3 NIT); todos resueltos.

| # | Severidad | Hallazgo | Resolución |
| --- | --- | --- | --- |
| 1 | SHOULD-FIX | Con el reloj de 2b (c) desde el vencimiento del lease, un 200 de `next` retrasado por la red podía escribir la notificación después de que la entrega fuera terminal (duplicado si la persona reenvió) | `next` devuelve `leaseTtlMs`; `st-channel` no escribe pasado `requestSentAt + leaseTtlMs − 2 s`; fila E8 "200 retrasado" |
| 2 | SHOULD-FIX | Una fila vieja de E8 seguía esperando `unconfirmed{no-evidence}` ante una pérdida del relay | Ahora `unconfirmed{relay-loss}` sin `degraded`, con lo prohibido explícito |
| 3 | NIT | Inicio de ventana y base de A7 sin definir para una entrega aceptada sin `transported` | Se usa `transporting` y la lectura del `next` |
| 4 | NIT | Texto duplicado y la fila de `T_clear` con un solo motivo | Corregidos |
| 5 | NIT | "Probar el canal otra vez" sin ruta | `POST /api/projects/:pid/agents/:aid/channel/retry` |

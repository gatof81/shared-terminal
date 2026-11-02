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

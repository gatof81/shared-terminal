# Project Chat + Agent Monitor + Channels — diseño

Estado: **borrador de investigación y diseño (2026-11-02). Nada implementado.** Nada se construye
hasta el GO de la POC y la decisión del responsable sobre §3.

| Documento | Contenido |
| --- | --- |
| [01-vision.md](./01-vision.md) | Qué construimos, para quién, casos de uso, alcance |
| [02-architecture-rfc.md](./02-architecture-rfc.md) | Evidencia sobre Channels, alternativas, componentes, fallos, seguridad, decisiones |
| [03-protocol.md](./03-protocol.md) | Identidades, persistencia, estados de entrega, API, límites, recuperación |
| [04-poc.md](./04-poc.md) | POC aislada con un agente y criterios GO / NO-GO fijados de antemano |
| [05-roadmap.md](./05-roadmap.md) | Fases y PRs independientes, dependencias, riesgos |
| [06-ux.md](./06-ux.md) | Chat del proyecto, menciones, presencia, estados, Control Directo |
| [07-review.md](./07-review.md) | Revisión crítica independiente y cómo se resolvió cada hallazgo |

Skill asociada: [`.claude/skills/architecture-spec/SKILL.md`](../../../.claude/skills/architecture-spec/SKILL.md).

## 1. Decisiones arquitectónicas principales

1. **El monitor es un módulo del backend existente**, no un servicio nuevo. Persiste en un log
   append-only por proyecto en el host (patrón de `conversation/store.ts`) y en tres tablas D1 de
   metadatos. El contenido nunca entra en D1.
2. **Channels es sólo transporte.** Un proceso sin estado en el contenedor (`st-channel`, servidor MCP
   stdio hijo del CLI) hace long-poll al monitor y emite la notificación. No confirma nada.
3. **La aceptación se demuestra con la captura de hooks que ya existe**: el `UserPromptSubmit` de la
   entrada de canal (`source: system`, etiqueta `<channel … st_msg=…>`) se clasifica como
   `channel_prompt`. Es hipótesis H8 y criterio G3 de la POC.
4. **El resultado es el `turn_end` del turno aceptado**, no una herramienta que el modelo puede no
   llamar. `chat_post` queda para avances y preguntas.
5. **Un mensaje en vuelo por agente, sólo con el agente en su prompt verificado.** Evita el
   agrupamiento documentado de Channels en `busy` y mantiene 1 mensaje ↔ 1 turno.
6. **At-most-once y sin reintentos automáticos**, ni por Channels ni por Composer. `unconfirmed` es
   un estado final explicado; reenviar es un mensaje nuevo de la persona.
7. **Identidad**: Proyecto → Agente (estable, `@handle`, 1 sesión en v1) → Runtime (proceso `claude`
   con `st-channel` en un arranque) → Conversación (evidencia, cambia con `/clear` y `/resume`).
8. **Agente→agente sólo con aprobación humana o arista `allow` explícita**, más límites de
   profundidad, presupuesto por cadena y tasa.
9. **Composer congelado como Control Directo**; el monitor nunca lo usa; exclusión mutua por pane.
10. **Un hecho, un lugar**: el texto del mensaje en el log del proyecto; la ejecución en la
    conversación; se enlazan por referencia.

## 2. Riesgos principales

| Riesgo | Severidad | Mitigación |
| --- | --- | --- |
| Channels es research preview con kill switch remoto ("not currently available", #105326) | Alta | GO sólo con POC; degradación visible; brazo B (hooks `asyncRewake`) evaluado; revisión por versión del CLI |
| No despierta una sesión inactiva (#44380, abierto) | Alta | Criterio G2; si falla, brazo B |
| `--resume`/re-host pierde el flag (#78028, #90160, #101872) | Media | Criterio G5; el alias de la imagen lleva el flag; runtime se re-registra por proceso |
| Sin evidencia de aceptación (H8 falsa) | Alta | Criterio G3 = NO-GO |
| Política: con managed settings presentes, `channelsEnabled` debe ser `true` (Console) y Team/Enterprise lo exige del admin | Media | Lo escribe nuestra activación; la POC lo prueba con la autenticación de producción |
| `--channels` desactiva `AskUserQuestion` y plan mode (CHANGELOG 2.1.83) | Media | Canal sólo en sesiones de agente (R7); E11 lo mide |
| Prompt injection entre agentes con `--dangerously-skip-permissions` | Alta | Aprobación por defecto; límites; marca `from_kind`; clasificador estricto |
| Dos mecanismos (Channels y Composer) | Media | Composer congelado y nunca invocado por el monitor |
| Mantenimiento de `st-channel` frente a cambios del protocolo (revisión MCP 2026-07-28) | Media | Revisión negociada fija; `CHANNEL_CLI_VERSIONS`; smoke por variante |

## 3. Decisiones que necesitan al responsable

R1–R8 en [02-architecture-rfc.md §9](./02-architecture-rfc.md#9-decisiones-que-necesitan-al-responsable),
más: autenticación y presupuesto de la POC ([04-poc.md §1](./04-poc.md#1-aislamiento-y-límites)).

## 4. Relación con otros documentos

- [CONVERSATION.md](../../CONVERSATION.md) sigue vinculante. Este diseño le añade, si se aprueba,
  un tipo de evento (`channel_prompt`, §4.2) y una precondición del Composer (§8.1.3); ambos en PRs
  de contrato propios.
- #465 y #467 (auditoría de `PATCH …/conversation` ajeno y recreación con bootstrap en vuelo) son
  decisiones ya tomadas sobre la activación y la recreación. Este diseño las **hereda**: habilitar
  un agente usa la misma recreación (con el bloqueo de #467) y la misma activación (auditada según
  #465). No las modifica.

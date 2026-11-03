# Project Chat + Agent Monitor + Channels — diseño

Estado: **dirección aprobada conceptualmente por el responsable (2026-11-02); decisiones R1–R9
resueltas. Nada implementado.** No está autorizado ejecutar la POC, implementar, mergear ni
desplegar: la POC necesita un GO separado sobre [04-poc.md §7](./04-poc.md#7-propuesta-de-ejecución-dos-autorizaciones-separadas).

Evidencia hasta ahora (2026-11-03):
- **G3 sigue sin cumplirse**: `source` está ausente en 2.1.314 y 2.1.317.
- **XA-1** dio `late`.
- **XB-1** dio **PASS-A**: el origen se observó en el mod `prompt.submit`, y PASS-A no reemplaza a
  G3.
- **PASS-B** (integridad hasta el backend) está diseñado y no implementado, en
  [04-poc.md §1.14](./04-poc.md#114-pass-b-integridad-de-la-evidencia-hasta-el-backend-diseño-nada-implementado-pass-b0-no-autorizado).
  PASS-B0 no está autorizado.

Dirección de producto (2026-11-03): **conversación de cada agente con invitados temporales vía
`@menciones`**, más un modo Colaboración autorizado por la persona. Decisiones D1–D6 aprobadas y
aplicadas a 01, 02, 03, 05 y 06 (R10–R15 en 02 §9). Los gates de Channels no cambian.

| Documento | Contenido |
| --- | --- |
| [01-vision.md](./01-vision.md) | Qué construimos, para quién, casos de uso, alcance |
| [02-architecture-rfc.md](./02-architecture-rfc.md) | Evidencia sobre Channels, alternativas, componentes, fallos, seguridad, decisiones |
| [03-protocol.md](./03-protocol.md) | Identidades, persistencia, estados de entrega, API, límites, recuperación |
| [04-poc.md](./04-poc.md) | POC aislada con un agente y criterios GO / NO-GO fijados de antemano |
| [08-host-chat-guests.md](./08-host-chat-guests.md) | **Aprobada (2026-11-03), ya aplicada**: registro de la propuesta de conversación individual por agente con invitados temporales vía `@menciones` (D1–D6; D3 modificada con el modo Colaboración) |
| [05-roadmap.md](./05-roadmap.md) | Fases y PRs independientes, dependencias, riesgos |
| [06-ux.md](./06-ux.md) | Conversación del agente, invitados, menciones, participantes, Colaboración, estados, Control Directo |
| [07-review.md](./07-review.md) | Revisión crítica independiente y cómo se resolvió cada hallazgo |

Skill asociada: [`.claude/skills/architecture-spec/SKILL.md`](../../../.claude/skills/architecture-spec/SKILL.md).

## 1. Decisiones arquitectónicas principales

1. **El monitor es un módulo del backend existente**, no un servicio nuevo. Persiste en un log
   append-only por conversación anfitriona en el host (patrón de `conversation/store.ts`) y en
   tablas D1 de metadatos (proyectos, agentes, aristas, conversaciones, participaciones). El
   contenido nunca entra en D1.
2. **Channels es sólo transporte.** Un proceso sin estado en el contenedor (`st-channel`, servidor MCP
   stdio hijo del CLI) hace long-poll al monitor y emite la notificación. No confirma nada.
3. **La aceptación se demuestra con la captura de hooks que ya existe**: el `UserPromptSubmit` de la
   entrada de canal se clasifica como `channel_prompt` **sólo** con `source: system` presente, la
   etiqueta `<channel … st_msg=…>` y una versión del CLI validada. Con `source` ausente no se acepta
   nada: así una etiqueta tecleada en el Terminal nunca confirma una entrega. Es la hipótesis H8 y el
   criterio G3 de la POC.
4. **El resultado es el `turn_end` del turno aceptado sólo si la atribución es inequívoca**: ninguna
   otra entrada (Terminal, Control Directo, notificación de tarea) compartió el turno. Si no, la
   entrega termina `ended_unattributed` y el informe no se presenta como respuesta. `chat_post` queda
   para avances y preguntas.
5. **Un mensaje en vuelo por agente, sólo con el agente en su prompt verificado.** Evita el
   agrupamiento documentado de Channels en `busy` y mantiene 1 mensaje ↔ 1 turno.
6. **At-most-once y sin reintentos automáticos**, ni por Channels ni por Composer. Sin evidencia, la
   entrega queda `uncertain` (cuenta como en vuelo, porque el CLI puede tenerla en cola) hasta
   probar que el CLI ya no la tiene; sólo entonces es `unconfirmed` y la persona puede reenviar
   como mensaje nuevo.
7. **Identidad**: Proyecto → Agente (estable, `@handle`, 1 sesión en v1) → Runtime (proceso `claude`
   con `st-channel` en un arranque) → Conversación (evidencia, cambia con `/clear` y `/resume`).
8. **Agente→agente sólo con aprobación humana, arista `allow` explícita entre participantes activos
   o una Colaboración que la persona activó en esa conversación**, más límites de profundidad,
   presupuesto por cadena y tasa. Invitar a otro agente siempre necesita aprobación.
9. **Composer congelado como Control Directo**; el monitor nunca lo usa; exclusión mutua por pane.
10. **Un hecho, un lugar**: el texto del mensaje en el log de la conversación anfitriona; la ejecución en la
    conversación; se enlazan por referencia.

## 2. Riesgos principales

| Riesgo | Severidad | Mitigación |
| --- | --- | --- |
| Channels es research preview con kill switch remoto ("not currently available", #105326) | Alta | GO sólo con POC; el gate se evalúa en cada notificación, así que se detecta por evidencia: `unconfirmed{no-evidence}` + runtime `degraded` al primer caso, cola retenida y visible, nunca Composer (protocolo §6.4, criterio G12); brazo B evaluado |
| No despierta una sesión inactiva (#44380, abierto) | Alta | Criterio G2; si falla, brazo B |
| `--resume`/re-host pierde el flag (#78028, #90160, #101872) | Media | Criterio G5; el alias de la imagen lleva el flag; runtime se re-registra por proceso |
| Sin evidencia de aceptación (H8 falsa) | Alta | Criterio G3 = NO-GO |
| Channels no disponible con la suscripción del responsable (#105326 en Max) o exigido por política de organización | Media (era Alta) | **Observado disponible** el 2026-11-02 con `fakechat` (exploratorio, 04-poc.md §1.8); el kill switch remoto sigue siendo un riesgo; si se bloquea: NO-GO, sin cambiar a API |
| `--channels` desactiva `AskUserQuestion` y plan mode (CHANGELOG 2.1.83) | Media | Canal sólo en sesiones de agente (R7); E11 lo mide |
| Prompt injection entre agentes con `--dangerously-skip-permissions` | Alta | Aprobación por defecto; límites; marca `from_kind`; clasificador estricto |
| Dos mecanismos (Channels y Composer) | Media | Composer congelado y nunca invocado por el monitor |
| Mantenimiento de `st-channel` frente a cambios del protocolo (revisión MCP 2026-07-28) | Media | Revisión negociada fija; `CHANNEL_CLI_VERSIONS` |
| Revalidar cada versión del CLI exige autenticación real (la suscripción del responsable) y consume su plan; con auto-update, cada versión nueva dejaría a los agentes sin canal | Media | Pin del CLI en sesiones de agente + corrida manual firmada (R9) |
| La evidencia de aceptación la reporta el propio contenedor del agente (token compartido por sus procesos) | Baja | Frontera de confianza declarada; el token no da poder fuera de la sesión |

## 3. Decisiones del responsable

R1–R9 y autenticación (sólo la suscripción del responsable, sin gasto adicional): resueltas el 2026-11-02, registradas en
[02-architecture-rfc.md §9](./02-architecture-rfc.md#9-decisiones-del-responsable-2026-11-02).
Pendiente: la autorización de la **fase 0** con `fakechat` (local, como usuario temporal en el Mac o PC del responsable; la VM queda para la POC completa) y, sólo si la supera, un GO separado para la POC completa ([04-poc.md §7](./04-poc.md#7-propuesta-de-ejecución-dos-autorizaciones-separadas)).

## 4. Relación con otros documentos

- [CONVERSATION.md](../../CONVERSATION.md) sigue vinculante. Este diseño le añade, si se aprueba,
  un tipo de evento (`channel_prompt`, §4.2) y una precondición del Composer (§8.1.3); ambos en PRs
  de contrato propios.
- #465 y #467 (auditoría de `PATCH …/conversation` ajeno y recreación con bootstrap en vuelo) son
  decisiones ya tomadas sobre la activación y la recreación. Este diseño las **hereda**: habilitar
  un agente usa la misma recreación (con el bloqueo de #467) y la misma activación (auditada según
  #465). No las modifica.

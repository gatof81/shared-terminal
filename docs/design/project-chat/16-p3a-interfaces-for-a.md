# P3a — interfaces para Claude A (frontend)

Estado: **2026-11-07.** El backend de P3a está en el PR draft **#557**, que **no** está mergeado ni
desplegado. El contrato vinculante es [`docs/PROJECTS.md`](https://github.com/gatof81/shared-terminal/blob/feat/project-directory-p3a/docs/PROJECTS.md)
de esa rama. Si este resumen y PROJECTS.md difieren, vale PROJECTS.md.

Decisiones aplicadas: D-UX0–D-UX10 y E-1–E-9, aprobadas el 2026-11-07 (15 §4.1). No cambia nada de
#554; esto es lo que la UI puede consumir.

## 1. Cómo saber si existe

- `GET /api/auth/status` → `features.projectChat === true`. **Si falta `features`, la superficie no
  existe** (bandera apagada): no mostrar nada de proyectos. Las rutas dan 404.
- Con la bandera apagada, ninguna respuesta existente cambia.

## 2. Rutas

| Método | Ruta | Uso en la UI |
| --- | --- | --- |
| `POST` | `/api/projects` | crear proyecto `{name, clientRequestId}` |
| `GET` | `/api/projects` | lista + `can.createProject` |
| `POST` | `/api/projects/:pid/agents` | crear agente `{handle, role?, sessionId, clientRequestId}` |
| `GET` | `/api/projects/:pid/agents` | directorio; **polling** (no hay WS en P3a) |
| `GET` | `/api/projects/:pid/agents/:aid` | página del agente con `bindings[]` (historial) |
| `DELETE` | `/api/projects/:pid/agents/:aid` | quitar agente → 204 (idempotente) |
| `GET` | `/api/sessions` | cada fila gana `binding` (ver §4) |

No existen en P3a: `GET /api/projects/:pid`, archivar proyecto, editar rol o handle, cambiar el
vínculo, conversaciones del proyecto, tareas, cola, Channels. No inventar campos de fases futuras
(`activeTask`, `queue`, `runtime`, `hostChat`): no aparecen.

## 3. Tipos (TypeScript, para `api.ts` y `mockBackend.ts`)

```ts
type Allowed = { allowed: true } | { allowed: false; reason: string };

interface Presence {
  value: "working" | "waiting_input" | "needs_attention" | "disconnected" | "unknown";
  detail?: string;          // "waiting_permission" | "stale" | "session-stopped" | "session-gone" | "agent-removed" | "unbound" | "capture-unreadable" | …
  source: string;           // "hook" | "probe" | "session" | "capture" | "directory" | …
  at: string | null;        // ISO; null = sin evidencia
  verified?: boolean;       // sólo en waiting_input: true ⇔ lo dijo un probe
}

interface Binding {
  bindingId: string; epoch: number; sessionId: string;
  state: "active" | "draining" | "retired"; createdAt: string;
}

interface AgentListEntry {
  agentId: string; handle: string; role: string | null;
  provider: "claude-code"; template: null;
  binding: Binding | null; presence: Presence;
}

interface AgentDetail extends AgentListEntry {
  projectId: string; createdAt: string; removedAt: string | null;
  capabilities: { capture: boolean; channels: boolean; directControl: boolean };
  bindings: Array<Binding & { retiredAt: string | null; retireReason: string | null }>;
  can: { remove: Allowed };
}

interface AgentsResponse {
  projectId: string; generatedAt: string;
  agents: AgentListEntry[]; can: { createAgent: Allowed };
}

interface ProjectSummary { projectId: string; name: string; createdAt: string; agentCount: number }
interface ProjectsResponse { projects: ProjectSummary[]; can: { createProject: Allowed } }

interface SessionBinding { projectId: string; agentId: string; handle: string; bindingId: string; epoch: number }
// en cada fila de GET /api/sessions:  binding?: SessionBinding | null
```

## 4. Reglas que la UI tiene que respetar

1. **`binding` en `/api/sessions`:** objeto = vinculada; `null` = «Sesiones sin asignar»; **clave
   ausente = desconocido** (falló la lectura del directorio). Nunca tratar la ausencia como `null`.
2. **Presencia:** mostrar `unknown` como «sin evidencia» o «estado desconocido», nunca como cero ni como
   inactivo. `waiting_input` con `verified: false` es «listo (sin verificar)», nunca «necesita
   atención». `needs_attention` sólo con `detail: "waiting_permission"` (regla de atención, opción A).
   No existen `no_channel`, `degraded` ni `ambiguous` en P3a.
3. **Identidad:** usar `agentId`, `projectId` y `bindingId`. `@handle` es alias, no identidad.
4. **Idempotencia:** generar un `clientRequestId` (UUID v4, `crypto.randomUUID()`) **por acción del
   usuario** y reutilizarlo sólo para reintentar esa misma acción. Ante **503 `outcome-unknown`**:
   ofrecer «Reintentar» con el **mismo** id (seguro siempre); nunca reintentar solo. Una respuesta
   `replayed: true` es éxito. Si después de un 503 llega un rechazo (409/404) para el mismo id,
   **recargar la lista de agentes** antes de mostrar el error: el intento perdido pudo aplicarse.
5. **Errores:** decidir por `error`, nunca por `message`.

   | `error` | Texto sugerido |
   | --- | --- |
   | `session-taken` | «Esa sesión ya es de otro agente» |
   | `handle-taken` | «Ese handle ya existe en el proyecto (los de agentes quitados también quedan reservados)» |
   | `session-not-found` / `project-not-found` / `agent-not-found` | «No encontrado» |
   | `agent-limit` / `project-limit` | «Llegaste al máximo (32 agentes / 50 proyectos)» |
   | `idempotency-conflict` | error de cliente: generar un id nuevo |
   | `outcome-unknown` | «No se pudo confirmar. Reintentar» (mismo id) |
   | `agent-active` (hard delete de sesión) | «Quitá el agente primero» |

6. **`can`:** usarlo para habilitar botones; el servidor vuelve a decidir en cada comando.
7. **Quitar un agente** conserva su página (`removedAt`, `bindings` con `retired`/`agent-removed`) y
   libera la sesión, pero **no** el handle.
8. **Vincular una sesión no le cambia nada:** las vistas de sesión (`#/sessions/…`), sus claves de
   storage y sus enlaces siguen iguales.
9. **Polling:** el directorio cuesta ≤ 2 lecturas D1 por pedido; el límite es 120/min por IP. Un ritmo
   de 5 s por pantalla visible es razonable.

## 5. Datos de ejemplo

[`fixtures/educacion-hz.json`](./fixtures/educacion-hz.json) tiene las respuestas P3a con la forma
implementada (lista, detalle, agente quitado, recibos de creación, errores, filas de `/api/sessions`
con `binding` objeto, `null` y ausente) y, aparte, los ejemplos de tareas T1/T2, que siguen siendo diseño.

## 6. Límites

- Aislamiento sólo de API: las sesiones siguen compartiendo `sessions-net` (#291).
- La presencia viene de las filas D1 de la captura y puede ir hasta ~30 s detrás de la vista Chat.
- P3a no desbloquea P3, T1, T2 ni T3. G3-2 sigue en NO-GO.

# 3.0d — Activación progresiva: propuesta

Estado: **propuesta para revisión (Work + responsable), no implementada.** Base: `main` en
`29645bd` (3.0c mergeado; `CONVERSATION_ENABLED` desactivado; backend no desplegado). Cuando se
apruebe, los cambios de §8 pasan al contrato ([CONVERSATION.md](../CONVERSATION.md)) en un PR de
docs **antes** del código, como exige el contrato.

## 0. Resumen

3.0d tiene dos partes:

1. **Requisito de entrada (CONVERSATION.md §2.4.1).** Hoy `start` reutiliza el contenedor
   existente, así que habilitar la captura en una sesión ya creada nunca llega a ser efectivo y
   `effectiveAfterRestart: true` es una promesa falsa.
2. **Lo planificado en §7:** endpoint admin, allowlist de usuarios, estadísticas y un despliegue
   por etapas.

Propuesta recomendada:

- **Recrear el contenedor en `start` solo en un caso:** la sesión pide captura, el contenedor
  existente no la tiene y está **detenido**.
- **La recreación es segura y reversible:**
  - Si la capa del contenedor contiene cambios que se perderían, no recrea.
  - Si la imagen vigente no tiene relay, no recrea.
  - El contenedor viejo se renombra y solo se borra cuando el nuevo ya arrancó. Si algo falla, se
    vuelve a él.
- **Después de recrear, rehace lo que vive en la capa y no en el workspace:** la identidad git y
  los dotfiles. Hoy se pierden en cualquier recreación, también en el procedimiento manual ya
  documentado.
- **Deshabilitar nunca recrea.** Ningún contenedor en ejecución se recrea.

Decisiones que se piden al responsable: **D1–D6 (§9)**.

## 1. Alcance

**Dentro:**

- La vía de §2.4.1 (recreación segura).
- `PATCH /api/admin/sessions/:id/conversation`.
- `CONVERSATION_ALLOW_USERS`.
- `GET /api/admin/stats → conversation`.
- Una etiqueta de imagen que declara el relay (cambio mínimo en el Dockerfile).
- El plan de activación por etapas (§7) y su procedimiento de operador.
- Las correcciones de DEPLOYMENT.md que derivan de §3.

**Fuera:**

- La vista (3.1) y el composer (3.2).
- La corrección de #444.
- La activación global.
- Actualizar en masa la imagen de los contenedores existentes. La recreación de 3.0d ocurre
  sesión por sesión y solo por la captura.
- Cualquier cambio en `stop`, `kill` o el borrado.
- El desplegable de UI para el owner.

## 2. Punto de partida (verificado en `29645bd`)

- **`startContainer`** (`backend/src/dockerManager.ts`, `startContainer`):
  - Caso 1, sin `container_id` → `spawnWithConfig` (llama a `prepareSpawn`).
  - Caso 2, contenedor existente → `start()` del mismo contenedor, sin `prepareSpawn`.
  - Caso 2 con id obsoleto → `spawnWithConfig`.
  - No hay lock por sesión. La única protección es `createContainerReclaimingStaleName`, que nunca
    borra un contenedor en marcha.
- **`enableSession`** (`backend/src/conversation/activation.ts`) responde
  `effectiveAfterRestart: true` para "detenido" y "corriendo sin token" sin distinguir si el
  siguiente start crea el contenedor. `captureStatus` calcula `requested && !effective`, con el
  mismo defecto.
  - Hoy no es alcanzable en producción: no hay ruta que ponga `conversation_requested=1` y el flag
    está apagado.
- **`prepareSpawnCapture`:**
  - Genera un token nuevo en cada contenedor creado.
  - Escribe el hash en D1 antes del archivo, así que nunca hay "emisor sin aceptor".
  - Escribe `conversation.json` aunque la imagen no tenga relay. Con una imagen anterior a 3.0c,
    cada hook fallaría de forma visible. DEPLOYMENT.md lo prohíbe solo por procedimiento.
- **`onSessionDown`** (stop/kill/reconcile) lleva las conversaciones a `container_down` y cierra sus
  índices. El hash de token sobrevive.
- **Bootstrap** (`backend/src/bootstrap.ts`) corre solo al crear la sesión:
  - Las etapas son gitIdentity → clone → dotfiles → agentSeed → postCreate.
  - `start` solo vuelve a correr `postStart`.

## 3. Qué conserva y qué pierde una recreación

Una recreación es: contenedor detenido → contenedor nuevo con la imagen vigente y la configuración
guardada. Inventario verificado contra `spawnWithConfig`, `entrypoint.sh` y `bootstrap/`.

| Estado | Dónde vive | ¿Sobrevive? |
| --- | --- | --- |
| Workspace (repo, archivos del usuario) | bind `<WORKSPACE_ROOT>/<sid>` | **Sí** |
| Credenciales y transcripts del CLI (`~/.claude`, `~/.claude.json`; los transcripts son los que reanudan `--resume`/`--continue`), agentSeed | `workspace/.st/…` vía symlink del entrypoint | **Sí** |
| CLI instalado (`~/.npm-global`), VS Code CLI, `gh`, `~/.ssh` | workspace vía symlink | **Sí** |
| Uploads | `<WORKSPACE_ROOT>/.uploads/<sid>` ro | **Sí** |
| Fila de sesión, `session_configs` (env, secretos cifrados, puertos, caps, hooks), `bootstrapped_at` | D1 | **Sí** (secretos se descifran en el spawn; puertos se reescriben) |
| Historial de conversaciones, filas `claude_conversations`, marcas de revocación | `<WORKSPACE_ROOT>/.conversations/<sid>`, D1 | **Sí** |
| Nombre del contenedor, hostname, red `sessions-net` | derivados del id/config | **Sí** (mismo nombre; **cambia** el `container_id`) |
| Identidad git (`~/.gitconfig`, escrita por `git config --global`) | **capa del contenedor** | **No hoy** — §5.3 la rehace |
| Dotfiles (`~/dotfiles` y lo que escriba su `installScript`) | **capa del contenedor** | **No hoy** — §5.3 los rehace |
| Paquetes `apt`, archivos fuera de `/home/developer/workspace` y de los symlinks, `/tmp` | capa del contenedor | **No** — §5.2 bloquea si existen |
| Procesos y pestañas tmux | memoria del contenedor | Ya se pierden con el **stop**; recrear un contenedor detenido no añade pérdida |

Lectura: "sesiones persistentes" en el sentido de **conversaciones del CLI reanudables** sobreviven,
porque los transcripts están en el workspace. Las **pestañas tmux** no sobreviven a un stop, con o
sin recreación. Por eso la propuesta solo recrea contenedores **ya detenidos**.

**Hallazgo (afecta a lo ya mergeado):** la sección "Recreating a session container" de
DEPLOYMENT.md dice "Kept: … gh/VS Code state" y no menciona que se pierden la identidad git y los
dotfiles. La recreación por soft delete + start y la de id obsoleto tienen la misma pérdida. Se
corrige en el PR de docs de 3.0d (§8), o antes si se prefiere.

## 4. Opciones para el requisito de entrada

| | Vía | A favor | En contra |
| --- | --- | --- | --- |
| **A** | `start` recrea **solo** si la captura se pide y el contenedor detenido no la tiene; con salvaguardas (§5) | Habilitar llega a ser efectivo por el camino normal (owner, idle sweeper, admin); `effectiveAfterRestart` puede ser verdad; sin superficie nueva | Amplía el ciclo de vida de `start` (decisión del responsable); un start puede tardar más |
| B | Endpoint admin explícito `POST /admin/sessions/:id/recreate` | Nada cambia en `start`; cada recreación es una acción consciente | El efecto depende de que un admin la ejecute; `effectiveAfterRestart` sigue sin poder ser verdad; un operador puede olvidarlo |
| C | Solo procedimiento manual (`docker rm` + start, ya documentado) | Cero código | Requiere shell en el host; propenso a error; no resuelve la respuesta del endpoint |

**Recomendación: A.** Además, **B solo como forzado opcional** para los casos que A bloquea (D4). C
queda como procedimiento de emergencia ya documentado.

## 5. Diseño recomendado

### 5.1 Condición exacta de recreación (en `startContainer`, caso 2)

Se recrea si y solo si se cumplen todas:

1. El contenedor existe y `State.Running === false`.
2. `CONVERSATION_ENABLED`, `conversation_requested=1` y ninguna marca de revocación (por sesión ni
   global).
3. El contenedor **no tiene captura**: su `Config.Env` no contiene `ST_INGEST_TOKEN`, o
   `HostConfig.Binds` no tiene el montaje gestionado. Ambos datos salen del `inspect` que el caso 2
   ya hace, así que no se añade ninguna llamada.
4. Las salvaguardas de §5.2 pasan.

Si no se cumplen todas, `start` se comporta exactamente como hoy. La dirección inversa (contenedor
con token y captura no pedida) **no** recrea: el token queda inerte, la ingesta ya rechaza (§2.5) y
el archivo está borrado.

### 5.2 Salvaguardas

- **Nunca un contenedor en marcha.** La condición 1 lo garantiza. Habilitar una sesión en marcha
  responde `effective:false` con el motivo `requires-stop`, y se hace efectiva tras el siguiente stop
  + start: del owner, del idle sweeper o del admin.
- **Imagen con relay.** El Dockerfile declara `LABEL io.shared-terminal.conversation-relay="1"`. El
  backend lee las etiquetas de `SESSION_IMAGE`, cacheadas por id de imagen. Sin la etiqueta:
  - no recrea;
  - `prepareSpawnCapture` **no** escribe hooks ni token en ningún spawn;
  - el motivo es `image-without-relay`.
  Esto convierte en código la regla de DEPLOYMENT.md "nunca recrear sobre `pre-3.0c` con captura".
- **Nada que perder en la capa.** Se usa `container.changes()` (`docker diff`) sobre el contenedor
  detenido.
  - Se ignoran las rutas efímeras o reconstruibles: `/tmp`, `/var/tmp`, `/run`, `/home/developer/.npm-global*` y los demás symlinks del entrypoint, el sentinel `/tmp/.st-ready`, `~/.gitconfig`, y `~/dotfiles/**` si la sesión tiene dotfiles.
  - Si queda cualquier otro cambio, **no recrea**: arranca el contenedor como hoy, sin captura, con
    el motivo `container-layer-changes` y el número de rutas en el log, nunca las rutas en la
    respuesta.
  - La política exacta para `$HOME` cuando hay `installScript` es D2.
- **Reversible.** Orden:
  1. `rename` del viejo a `st-<12>-pre3d-<ts>`, detenido e intacto.
  2. `spawnWithConfig`, que crea el nuevo con el nombre canónico, el token nuevo y el montaje.
  3. Si el nuevo arranca, `remove` del viejo.
  Si falla en el paso 2: se borra el nuevo si llegó a existir, se renombra el viejo a su nombre y se
  arranca como hoy. El token nuevo queda en D1 sin emisor, lo que es inocuo y se sobrescribe en el
  siguiente spawn. Un renombrado huérfano por caída del backend lo detecta `reconcile` por prefijo y
  lo reporta; no lo borra solo.
- **Lock por sesión** (en proceso; el backend es uno) alrededor de la rama de recreación. Un segundo
  `start` concurrente espera y ve el contenedor nuevo.
- **Auditoría.** La recreación usa el log de `start`. Cuando la dispara un admin sobre una sesión
  ajena, ya existe la fila `operate` de #429. Se añade una línea de log `recreated for capture` con
  los ids viejo y nuevo.

### 5.3 Restaurar lo que vivía en la capa

Después de una recreación, y **solo** entonces, corren las etapas idempotentes del bootstrap:

- **gitIdentity**: `git config --global` con los mismos valores.
- **dotfiles** (D3): clone + `installScript`. La convención de GitHub Codespaces y devcontainers
  ejecuta el install de dotfiles en cada contenedor creado, así que los scripts ya suelen ser
  idempotentes.

No corren:

- clone (el workspace existe);
- agentSeed (su destino `~/.claude` persiste y el usuario puede haberlo editado);
- `postCreate`, que sigue siendo de un solo uso por `bootstrapped_at`.

`postStart` corre como en cualquier start. Las etapas reutilizan `runStage` y el log de bootstrap
existente. Un fallo se registra y deja la sesión usable, igual que `postStart`, porque el contenedor
ya está creado y funciona.

Esto mismo arregla la pérdida de §3 para la recreación por id obsoleto. Se propone aplicarlo a todo
spawn de una sesión con `bootstrapped_at` no nulo, porque es el mismo defecto (D3).

### 5.4 Respuesta honesta

`ActivationResult` y `capture` en `GET …/conversations` pasan a:

```
{ enabled, effective, effectiveAfterRestart, pendingReason? }
pendingReason ∈ requires-stop | container-layer-changes | image-without-relay | flag-off | revoked
```

`effectiveAfterRestart: true` solo si el siguiente start **creará** el contenedor con captura:

- no hay contenedor; o
- el contenedor está detenido y las salvaguardas pasan ahora mismo; o
- el contenedor está en marcha (`requires-stop`): se calcula al detenerse y se informa como
  `true` con ese motivo.

`container-layer-changes` puede aparecer después, si el usuario instala algo antes de parar. Por eso
el valor es "según lo observado ahora" y la vista lo vuelve a consultar. La tabla de §2.4 se
reescribe con estas filas (§8).

### 5.5 Endpoint, allowlist y estadísticas (contrato §7, sin cambios de fondo)

- **`PATCH /api/admin/sessions/:id/conversation {enabled}`**:
  - `requireAdmin` + `adminActionIp`.
  - Aplica §2.4 y devuelve §5.4.
  - Refleja D1 y el archivo en ≤ 1 s.
  - Con un owner ajeno, escribe una fila de auditoría `operate`, como #429.
- **`CONVERSATION_ALLOW_USERS=<id,id>`**: solo las sesiones **nuevas** de esos usuarios nacen con
  `conversation_requested=1`. Las existentes se activan con el PATCH (§7.3).
- **`GET /api/admin/stats → conversation`**:
  - Los campos de §7.
  - Se añaden `relayDropped`, `relayDroppedUnattributed` y `relayRestarts`, que ya existen en el
    servicio.
  - Se añaden `pendingByReason` y `recreatedForCaptureSinceBoot`.
  - Sin títulos ni ids de conversación.
- **D4, opcional:** `POST /api/admin/sessions/:id/conversation/recreate {acknowledgeLayerLoss:true}`
  fuerza la recreación de §5.2 cuando el motivo es `container-layer-changes`.
  - Solo sobre una sesión detenida.
  - Auditado.
  - Nunca salta la guarda de imagen ni la de revocación.

## 6. Pruebas

**Unitarias y regresión** (backend):

- Las filas de §2.4 reescritas, una por test, incluidos `requires-stop`,
  `container-layer-changes` e `image-without-relay`.
- `startContainer` caso 2:
  - captura pedida + contenedor sin token + detenido ⇒ rename → create → remove, con token y
    montaje nuevos;
  - en marcha ⇒ sin recreación;
  - token inerte + captura no pedida ⇒ sin recreación;
  - fallo de create ⇒ el viejo vuelve a su nombre y arranca, el nuevo no existe;
  - diff con `/usr/lib/...` ⇒ sin recreación y motivo;
  - imagen sin etiqueta ⇒ ni hooks ni token, en ningún spawn.
- Lock: dos `start` concurrentes ⇒ una sola recreación.
- Bootstrap tras recreación: gitIdentity (y dotfiles según D3) corren; clone, agentSeed y
  `postCreate` no.
- Stats sin títulos ni ids (test de forma).

**Smoke de Docker con el CLI real** (extensión de `conversation-smoke.sh`). Sesión con:

- workspace con un repo y un archivo de prueba;
- transcript del CLI reanudable;
- identidad git;
- un puerto declarado;
- un secreto.

Flujo: stop → habilitar → start. Debe dar:

- **recreado**;
- hash del workspace idéntico;
- `claude --resume <id>` encuentra la conversación;
- `git config user.email` intacto;
- secreto presente en el env;
- puerto reescrito;
- relay escuchando;
- eventos en `.conversations/`;
- `capture.effective: true`.

Variantes:

- con `apt-get install` previo ⇒ no recrea y el motivo es visible;
- imagen sin etiqueta ⇒ no recrea, sin hooks;
- deshabilitar ⇒ la ingesta rechaza de inmediato y nada se recrea.

## 7. Activación progresiva (procedimiento propuesto)

Cada etapa se puede detener y revertir con lo ya documentado (`conversation:disable`, flag off).
Avanzar exige el criterio de la etapa anterior y la autorización explícita del responsable.

| Etapa | Qué | Criterio para avanzar |
| --- | --- | --- |
| 0 | Desplegar backend 3.0d + alias + imagen 3.0c/3.0d **con el flag apagado**; verificaciones de DEPLOYMENT.md pasos 1–2 | Las sesiones existentes funcionan igual; `POST /ingest` → 204 `disabled` |
| 1 | `CONVERSATION_ENABLED=true`, nadie pedido | `reconcile` sin correcciones; stats `enabledSessions=0` |
| 2 | **Piloto: una sesión del responsable**, detenida, con la capa limpia y `claude --version` ≥ 2.1.308. PATCH → start (recrea) | 48 h: eventos visibles; `rejected` solo por motivos esperados; `relayDropped=0` fuera de pruebas; RSS del relay ≤ 20 MiB; sin "hook error" en la terminal; inventario de §3 conservado (checklist del smoke, a mano) |
| 3 | `CONVERSATION_ALLOW_USERS` = el responsable (sesiones nuevas) + 2–3 sesiones existentes elegidas | Una semana con los mismos criterios; disco de `.conversations` dentro de lo previsto (L7) |
| 4 | Ampliar la allowlist por usuario | Decisión aparte; la activación global no está en 3.0d |

Rollback de cualquier etapa: `conversation:disable -- <sid>|--all` (corte inmediato). Volver a la
etapa 1 es flag off. Una sesión recreada no necesita volver a su contenedor anterior: su estado
persistente es el mismo (§3).

## 8. Cambios de contrato y documentación (PR de docs previo al código)

- **CONVERSATION.md:**
  - §2.4: tabla reescrita con las filas de §5.1–§5.4, `pendingReason`, y la fila
    "`start` de un contenedor existente" dividida en "sin cambio de captura" / "recreación por
    captura".
  - §2.4.1: el requisito pasa de "pendiente" a la vía aprobada.
  - §7: los campos nuevos de stats y, si se aprueba D4, el endpoint forzado.
  - §10 3.0d: los criterios de §6.
- **DEPLOYMENT.md:**
  - "Recreating a session container": corregir lo que se pierde y se rehace (§3); el procedimiento
    manual pasa a ser de emergencia.
  - "Rollout order": el paso 4 deja de exigir `docker rm` manual.
  - Etiqueta de imagen.
  - Las etapas de §7.
- **Fuera de 3.0d, señalado:** DEPLOYMENT.md:124 (#190, "must be stopped and started once so it
  re-joins the network") arrastra el mismo error que R1 de 3.0c. Stop + start reutiliza el
  contenedor y su red. Se propone un PR de docs aparte.

## 9. Decisiones para el responsable

- **D1 — Vía del requisito de entrada.** Recomendado: **A** (recrear en `start` solo por captura,
  contenedor detenido, con salvaguardas). Alternativas: B o C (§4).
- **D2 — Política de pérdida de capa.** Recomendado: bloquear ante cualquier cambio fuera de la
  lista de §5.2, con motivo visible. Con `installScript`: ignorar los cambios bajo `$HOME`, porque
  el script los rehace, y seguir bloqueando las rutas de sistema. Alternativa más estricta: no
  ignorar `$HOME` nunca. Más sesiones quedarían bloqueadas.
- **D3 — Rehacer identidad git y dotfiles tras toda recreación de una sesión ya bootstrapeada.**
  Recomendado: sí, también fuera de la captura, porque corrige una pérdida que ya existe hoy.
  Alternativa: solo gitIdentity (siempre idempotente), con dotfiles bloqueando vía D2.
- **D4 — Endpoint de recreación forzada** con `acknowledgeLayerLoss`. Recomendado: sí, solo admin,
  solo detenida, auditado. Alternativa: no; los bloqueos se resuelven con el procedimiento manual.
- **D5 — Sesiones en marcha.** Recomendado: nunca se recrean por habilitar; `requires-stop`.
- **D6 — Etiqueta de imagen como guarda en código.** Recomendado: sí. Es un cambio mínimo en el
  Dockerfile, sin efecto en sesiones existentes.

## 10. Riesgos

- **Un `start` más lento cuando recrea:** diff + create + bootstrap parcial. Medirlo en el smoke.
  Es un solo pago por sesión.
- **Dotfiles no idempotentes:** un `installScript` que falla la segunda vez deja la sesión usable
  pero con el log de bootstrap en error. Es visible y no bloquea.
- **La recreación toma la imagen vigente:** trae también cualquier otro cambio de imagen
  desplegado. Es el comportamiento ya documentado de toda recreación. La guarda de etiqueta impide
  el caso peligroso (sin relay).
- **CLI autoactualizado < 2.1.308 en workspaces existentes:** la etapa 2 lo comprueba a mano. No se
  añade comprobación automática (el CLI vive en el workspace y su versión puede cambiar después).

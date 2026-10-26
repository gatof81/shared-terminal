# 3.0d — Activación progresiva: propuesta

Estado: **propuesta v2 para revisión (Work + responsable), no implementada.** Base: `main` en
`29645bd` (3.0c mergeado; `CONVERSATION_ENABLED` desactivado; backend no desplegado).

La v1 recomendaba recrear el contenedor automáticamente en `start`. La v2 incorpora las
decisiones D1–D6 del responsable, que siguen las recomendaciones de Work (§9), y corrige A1–A3
(§10):

- La recreación pasa a ser **administrativa, explícita y protegida**.
- Los datos de HOME y de la capa del contenedor se preservan de forma **estricta**: si algo se
  perdería, se bloquea.
- No hay recreación automática ni bypass destructivo.
- Se usa un **ID inmutable de imagen** de principio a fin.

Cuando se apruebe, los cambios de §8 pasan al contrato ([CONVERSATION.md](../CONVERSATION.md)) en
un PR de docs **antes** del código.

## 0. Resumen

- **`start` no cambia.** Ningún stop, start, idle sweeper ni reconcile recrea contenedores.
- **Activar la captura en una sesión con contenedor existente** se hace con una acción
  administrativa: `POST /api/admin/sessions/:id/recreate`.
- **Esa acción se rechaza** si la sesión está en marcha. También se rechaza si recrear perdería
  cualquier dato que no se pueda reconstruir de forma exacta, o si la imagen no es apta. **No hay
  forzado.**
- **La recreación tiene un punto de confirmación único:** el cambio de `container_id` en D1, con
  compare-and-set. Antes de ese punto, cualquier fallo vuelve al contenedor anterior. Después, no
  hay vuelta atrás automática, ni hace falta.
- **`effectiveAfterRestart` solo es `true`** si el siguiente `start` *crea* el contenedor con
  captura. Lo demás se informa con `requiresRecreate` y motivos explícitos.

## 1. Alcance

**Dentro:**

- El endpoint de recreación (§5).
- **Un lock por sesión en `start`, `stop`, `kill` y `delete` (soft y hard)**, que hoy no tienen
  ninguno. Sin él, el lock de `recreate` no protege de nada: un `DELETE ?hard=true` concurrente
  podría purgar el workspace mientras `N` arranca sobre él. Es un cambio en rutas existentes y va
  en el PR de implementación con sus tests de concurrencia (§5.7).
- `PATCH /api/admin/sessions/:id/conversation`.
- `CONVERSATION_ALLOW_USERS`.
- Las estadísticas de `GET /api/admin/stats → conversation`.
- La etiqueta de imagen y su verificación por ID.
- La detección de recreaciones interrumpidas en `reconcile` (§5.6).
- La semántica nueva de `capture` (§6).
- El plan por etapas (§7).
- Las correcciones de DEPLOYMENT.md (§8).

**Fuera:**

- La vista (3.1) y el composer (3.2).
- #444.
- La activación global.
- Actualizar en masa la imagen de los contenedores existentes.
- Cambios en `start`, `stop`, `kill` o el borrado.
- Copiar datos de la capa del contenedor al contenedor nuevo (§11).
- UI para el owner.

## 2. Punto de partida (verificado en `29645bd`)

- **`startContainer`** (`backend/src/dockerManager.ts`):
  - Sin `container_id`, hace spawn (`prepareSpawn` incluido).
  - Con contenedor existente, hace `start()` del mismo contenedor, sin `prepareSpawn`.
  - Con id obsoleto, hace spawn.
  - No hay lock por sesión.
- **`spawnWithConfig`** hace, en este orden:
  1. `prepareSpawn`: hash de token a D1 y luego el archivo de hooks.
  2. `createContainer` con `Image: SESSION_IMAGE`, que es una **etiqueta** y no un ID.
  3. `start()`.
  4. `setContainerId`.
  5. Mapeos de puertos.

  Es un camino sin rollback: si algo falla después de `start()`, el contenedor queda corriendo sin
  que D1 lo apunte.
- **`captureStatus`** (`activation.ts`) calcula `effectiveAfterRestart = requested && !effective`.
  Es falso para un contenedor existente sin token, porque el siguiente start lo reutiliza.
  - Hoy no es alcanzable: no hay ruta que ponga `conversation_requested=1`.
- **El hash de token no siempre describe al contenedor.** Un spawn con el flag apagado no toca D1,
  así que puede quedar un hash de un contenedor anterior.
  - Es inocuo hoy, porque ese contenedor tampoco tiene el montaje.
  - Pero impide deducir "el contenedor tiene token" solo a partir de D1 (§6).
- **`prepareSpawnCapture`** escribe hooks y token aunque la imagen no tenga relay.
- **El bootstrap** (gitIdentity → clone → dotfiles → agentSeed → postCreate) solo corre al crear la
  sesión.
  - `~/.gitconfig` y `~/dotfiles` viven en la **capa** del contenedor.
  - Cualquier recreación de hoy los pierde: id obsoleto, soft delete + start, o el procedimiento
    manual de DEPLOYMENT.md.

## 3. Qué conserva y qué pierde una recreación

| Estado | Dónde vive | Recreación |
| --- | --- | --- |
| Workspace; estado y transcripts del CLI (`--resume`); `~/.npm-global`, VS Code CLI, `gh`, `~/.ssh` | bind del workspace (directo o vía symlink del entrypoint) | Se conserva: **es el mismo directorio** (estado compartido, §5.4) |
| Uploads; fila de sesión y `session_configs`; historial de conversaciones | host y D1 | Se conserva |
| `~/.gitconfig` escrito por gitIdentity | capa | Reconstruible **solo** si su contenido es exactamente el que escribe gitIdentity (§5.2) |
| Cualquier otra cosa en la capa: `~/.bash_history`, `~/dotfiles` y lo que escribió su install, paquetes `apt`, archivos en `/tmp` del usuario, `/etc`, `/usr`, `/opt` | capa | **Se perdería ⇒ la recreación se rechaza** |
| Procesos y pestañas tmux | memoria | Ya se pierden con el stop; la recreación exige una sesión detenida |

Consecuencia esperada: con preservación estricta, **muchas sesiones usadas no serán recreables**.
`~/.bash_history` aparece en cuanto alguien abrió una pestaña. La respuesta del endpoint dice qué
categorías bloquean (§5.2), y el owner decide si mover o descartar esos datos por su cuenta. No hay
atajo. Para el piloto (§7) se elige una sesión que pase.

## 4. Decisión de vía (D1)

**Recreación administrativa explícita (opción B de la v1).** Se descartan:

- la recreación automática en `start` (opción A de la v1), porque cambia el ciclo de vida de todos
  los starts;
- el procedimiento manual con `docker rm` (opción C) como vía normal: queda como procedimiento de
  emergencia del operador, con las correcciones de §8.

## 5. `POST /api/admin/sessions/:id/recreate`

**Auth y límites:**

- `requireAuth` + `requireAdmin` + `adminActionIp`.
- Con un owner ajeno, escribe una fila `operate` en `session_observe_log` **antes** de tocar nada.
  Es fail-closed, como el start de #429.
- El cuerpo es `{ expectImageId: "sha256:…" }`, obligatorio. Es el ID que el admin vio en el
  preflight (§5.1). Si no coincide con el de ahora, responde 409 `image-changed` y no hace nada.

**`GET /api/admin/sessions/:id/recreate`:** preflight de solo lectura. Devuelve:

- `{ recreatable, blockers[], imageId, currentImageId, captureAfter }`;
- `blockers` lleva códigos y recuentos por categoría, nunca nombres de archivo;
- con el mismo cálculo exacto que usa el POST.

### 5.1 Precondiciones (todas, en este orden; la primera que falla responde 409 con su código)

1. **Lock por sesión** adquirido. Es un mapa en proceso; el backend es único. `start`, `stop`,
   `kill`, `delete` (soft y hard, incluida la purga del workspace) y `recreate` toman el mismo
   lock (§1). `recreate` no espera: si está ocupado, responde `busy`. Las otras cuatro esperan a
   que termine, con el mismo tope de tiempo que la recreación, y después actúan sobre el estado
   que esta dejó.
2. La sesión existe, su `status` no es `failed` ni `terminated`, y tiene `container_id`
   (`no-container`: el siguiente start ya crea uno nuevo, así que no hay nada que recrear).
3. `inspect(container_id)`: el contenedor existe y `State.Running === false`
   (`running`, `container-missing`).
4. **Imagen:**
   - `inspect(SESSION_IMAGE)` → `imageId`, que debe ser igual a `expectImageId` (`image-changed`).
   - La etiqueta `io.shared-terminal.conversation-relay="1"` debe estar **en ese ID**
     (`image-without-relay`).
   - Desde aquí, todo usa `imageId`, nunca la etiqueta del tag.
5. **Captura:** `CONVERSATION_ENABLED`, `conversation_requested=1`, sin marca de revocación
   (`flag-off`, `not-requested`, `revoked`).
   - Recrear sin captura pedida no es parte de 3.0d.
6. **Capa del contenedor** (§5.2): sin pérdidas (`layer-*`).

### 5.2 Preservación estricta de la capa (D2, D3)

`container.changes()` (`docker diff`) del contenedor detenido. Cada entrada se clasifica en una
de estas dos clases.

**Producida por el entrypoint, con forma exacta.** Se permite solo si coincide en tipo y destino:

- `~/.npm-global`, `~/.vscode-cli`, `~/.config/gh`, `~/.claude`, `~/.claude.json` y `~/.ssh`:
  symlinks a su destino exacto bajo el workspace;
- los directorios padre que el entrypoint crea (`~/.config`);
- `/tmp/.st-ready`;
- `/tmp/st-relay.log`;
- el socket de tmux `/tmp/tmux-<uid>/`.

Una entrada con la ruta correcta y otra forma bloquea: por ejemplo, un directorio real en lugar
del symlink. El entrypoint dejó estado en la capa porque su symlink falló.

**`~/.gitconfig`:** se lee del contenedor detenido con `getArchive`, ≤ 4 KiB. Se permite solo si
al parsearlo contiene **exactamente** `user.name` y `user.email`, iguales a los de
`session_configs`. Así lo deja gitIdentity. Con cualquier otra clave o valor, bloquea
`layer-gitconfig-modified`.

**Todo lo demás bloquea**, agrupado por categoría:

- `layer-home`: bajo `/home/developer`, fuera del workspace y fuera de lo anterior;
  `~/.bash_history` cuenta aquí;
- `layer-dotfiles`: si la sesión tiene dotfiles configurados, su clone y su install no se pueden
  reproducir exactamente;
- `layer-tmp`;
- `layer-system`: `/etc`, `/usr`, `/opt`, `/var`, …

Las rutas no se devuelven: `docker diff` de un usuario es contenido. Solo se registra el recuento
en el log.

**D3:** tras la recreación solo se rehace gitIdentity, cuando el archivo existía y pasó el chequeo.
Los dotfiles nunca se rehacen: una sesión con dotfiles queda bloqueada por `layer-dotfiles`.

### 5.3 Secuencia y punto de confirmación (A1)

Notación: `O` es el contenedor viejo y `N` el nuevo.

1. **Preparar sin efectos visibles.**
   - Se genera el token.
   - Se crea `N` con un **nombre temporal** (`st-<12>-new-<ts>`), `Image: imageId` y la
     configuración de spawn de siempre (env, binds, caps, red).
   - Se añaden etiquetas `io.shared-terminal.session=<sid>` y `io.shared-terminal.recreate-of=<O>`.
   - `N` no se arranca. D1 sigue en `O`, el archivo de hooks no existe y el hash no cambió.
2. **Renombrar.** `O` → `st-<12>-old-<ts>`, y `N` → `st-<12>` (el nombre canónico).
3. **Recomprobar `O` y arrancar `N`.**
   - **Primero**, `inspect(O)`: `State.Running` debe seguir en `false`. Si no (por ejemplo un
     `docker start` manual entre los pasos 2 y 3), rollback sin arrancar `N`.
   - `start()` de `N`.
   - El sentinel de readiness en ≤ 60 s, que ya existe.
   - Que `N` siga en marcha.
   - Hooks, token y postStart todavía no.
4. **Confirmar en D1 (punto de no retorno), con compare-and-set:**

   ```sql
   UPDATE sessions SET container_id = :N
   WHERE session_id = :sid AND container_id = :O
   ```

   - Si afecta 0 filas (alguien cambió la fila, por ejemplo un hard delete en curso): rollback.
   - Si D1 no responde: rollback, porque D1 sigue en `O`.
   - Un timeout ambiguo (la escritura pudo aplicarse) se resuelve releyendo la fila antes de
     decidir; si la relectura también falla, se trata como §5.6.
5. **Activar la captura** en `N`, en este orden:
   1. hash del token a D1;
   2. archivo de hooks.

   El relay de `N` arrancó en el paso 3 porque el env ya tiene el token, pero todavía no hay hooks
   que le escriban. Esto mantiene el orden de 3.0b: "nunca emisor sin aceptor".
6. **Completar.**
   - Mapeos de puertos desde la config.
   - `status=running`.
   - gitIdentity si aplica (§5.2).
   - postStart.
   - `remove()` de `O`. Es seguro: §5.2 probó que su capa no tenía nada que perder y estuvo
     detenido todo el tiempo.

   Un fallo aquí se registra y no deshace nada: `N` es la sesión.

**Rollback (cualquier fallo en los pasos 1–4).** Cada paso es idempotente y se ejecuta incluso si
el anterior falló:

1. `stop` y `remove` de `N` si existe.
2. `O` vuelve a su nombre canónico si fue renombrado.
3. El hash y el archivo nunca se tocaron, porque el paso 5 viene después de la confirmación.

Estado final: idéntico al previo. `O` está detenido, con D1 apuntándolo, sin cambios en la
captura. Respuesta: 500 `recreate-failed` con `{ step }`.

**Fallos después del paso 5.** No se vuelve a `O`.

Si el hash se escribió y el archivo no, hay token sin emisor. El estado es reparable sin recrear,
porque el contenedor `N` ya tiene el token y el montaje; solo falta un archivo en el host:

1. el endpoint reintenta escribir el archivo una vez y, si vuelve a fallar, responde
   `effective:false` con `pendingReasons: ["hooks-file-missing"]`;
2. **reparación inmediata:** `PATCH …/conversation {enabled:true}` sobre la sesión en marcha. La
   rama "ya efectiva" de `enableSession` (hash presente y contenedor en marcha) reescribe el
   archivo. Ya existe en 3.0b;
3. **reparación automática:** el `reconcile` de 3.0b, al arrancar el backend, escribe el archivo
   para toda sesión `running` con `requested ∧ hash` sin archivo (`service.reconcile`:
   `shouldHaveFile && !has`).

Esto nunca exige una segunda recreación, que §5.2 probablemente bloquearía, porque para entonces
`N` ya tiene `~/.bash_history`. Si el hash **no** llegó a escribirse, el token de `N` ya no se
conoce y la captura de `N` no se puede activar. La salida es la de cualquier sesión con
`requiresRecreate` y la capa bloqueada: el owner resuelve los bloqueos de §5.2, o la captura se
queda sin activar en esa sesión. No hay salida destructiva (D4).

### 5.4 Estado compartido del workspace (A2)

`O` y `N` montan **el mismo** directorio de workspace. El estado del CLI, `~/.ssh`, `gh` y
`.npm-global` viven ahí. Reglas:

- **Nunca dos escritores.**
  - `O` está detenido desde la precondición 3 hasta su borrado.
  - El lock impide un `start` concurrente de la sesión.
  - Lo que no pasa por el backend no lo protege el lock, por ejemplo un `docker start` manual. Por
    eso el paso 3 vuelve a comprobar que `O` sigue detenido justo antes de arrancar `N`. Si no lo
    está, hace rollback.
- **Efectos de `N` en el workspace antes de la confirmación.** El entrypoint de `N` corre en el
  paso 3, antes del punto de no retorno, y puede escribir en el workspace compartido:
  - crea los directorios `.st/*` si faltan;
  - repone el symlink `.npm-global` desde la imagen **solo** si la copia del workspace falta o está
    rota;
  - rescata un `~/.ssh` de la capa, que en `N` no existe.

  Las tres escrituras son idempotentes y son las mismas que hace cualquier arranque de `O`, así que
  el rollback no las deshace: `O` funciona igual con ellas. postStart, que es arbitrario, y
  gitIdentity corren **después** de la confirmación. Por eso no hay efectos del usuario que
  deshacer.
- **El CLI vive en el workspace, no en la imagen.** `N` usa el `claude` de `workspace/.npm-global`,
  que puede ser anterior a 2.1.308.
  - El paso 6 ejecuta `claude --version` en `N` y lo devuelve como `cliVersion`.
  - Por debajo del mínimo devuelve el aviso `cli-below-minimum`. La captura queda activa, porque el
    backend sigue siendo la garantía, y la etapa 2 de §7 exige el mínimo.
  - No se actualiza el CLI automáticamente: es estado del usuario.
- **Conversaciones.**
  - El stop previo ya llevó las conversaciones a `container_down`.
  - Un `claude --resume` en `N` reanuda el mismo transcript del workspace; su `session_id` decide si
    se escribe en la misma conversación, y no se le asigna ninguna continuidad.
  - El relay de `N` es un proceso nuevo (generación 0). Lo que el relay de `O` no entregó se perdió
    con el stop, como hoy.

### 5.5 Consistencia de `container_id` en D1 (A3)

- **D1 apunta a `O` o a `N`, nunca a un contenedor inexistente:**
  - antes de la confirmación, `O` existe (renombrado o no);
  - después, `N` existe y está en marcha;
  - `O` se borra solo después de confirmar.
- **Las lecturas concurrentes** (attach WS, exec, git, files) resuelven el contenedor por el
  `container_id` de D1.
  - Antes de la confirmación ven `O` detenido y responden como a una sesión detenida, que es lo
    que es.
  - Después ven `N`.
  - El dispatcher de puertos resuelve por **nombre**. El nombre canónico pasa a `N` en el paso 2,
    pero el dispatcher solo encamina sesiones `running` y la sesión no lo es hasta el paso 6.
- **`reconcile`** usa el mismo `container_id`. Un `O` renombrado sigue siendo inspeccionable por id,
  porque renombrar no cambia el id.

### 5.6 Recreación interrumpida (caída del backend o de Docker)

`reconcile`, al arrancar, añade una pasada nueva:

1. `docker ps -a --filter label=io.shared-terminal.recreate-of`.
2. `docker ps -a --filter name=-old-`.

Para cada sesión afectada, decide con D1:

| D1 `container_id` | Estado encontrado | Acción |
| --- | --- | --- |
| `= O` (no se confirmó) | `N` existe | `stop` + `remove` de `N`; `O` vuelve a su nombre canónico. Es el mismo rollback de §5.3 |
| `= N` (se confirmó) | `O` existe | `remove` de `O`; mapeos y `status` según el estado real de `N`, como en cualquier reconcile; postStart no. Si la caída fue antes de escribir el hash (paso 5), el token de `N` ya no se conoce: la captura queda no efectiva y `capture` informa `requiresRecreate`. Nunca se inventa un hash |
| ni `O` ni `N` | — | No tocar nada; log de error y contador `recreateOrphans` en stats; operador |

Cada acción se registra en el log. Ninguna borra un contenedor que D1 apunte. Esto resuelve el
hallazgo del bot de revisión sobre la v1: el `reconcile` actual itera sobre filas de D1 y nunca
vería un contenedor renombrado.

### 5.7 Pruebas del endpoint

**Unitarias, con Docker y D1 simulados:**

- Cada precondición, con su código.
- Cada clase de `docker diff`, incluidas las formas incorrectas de los symlinks.
- `~/.gitconfig` exacto, con una clave extra y con otro email.
- Fallo inyectado en cada paso del 1 al 4 ⇒ estado final idéntico al previo: D1, nombres, hash,
  archivo y mapeos.
- Compare-and-set con 0 filas ⇒ rollback.
- Timeout ambiguo de D1.
- Fallo en el paso 5 ⇒ `N` se queda y converge.
- `expectImageId` distinto ⇒ 409 sin efectos.
- El tag se mueve entre el preflight y el POST ⇒ `image-changed`.
- `start`, `stop`, `kill` y `DELETE ?hard=true` concurrentes durante cada paso de la
  recreación ⇒ esperan el lock y actúan después sobre el estado final. Nunca se purga un
  workspace con `N` arrancando.
- `recreate` sobre una sesión con otra operación en curso ⇒ `busy`, sin efectos.
- `docker start` manual de `O` entre los pasos 2 y 3 ⇒ rollback sin arrancar `N`.
- Fallo al escribir el archivo tras la confirmación ⇒ `hooks-file-missing`; `PATCH
  {enabled:true}` lo repara sin recrear; `reconcile` también.
- Las tres filas de §5.6.

**Smoke de Docker con el CLI real:**

1. Sesión con repo, transcript reanudable, identidad git, un puerto y un secreto.
2. stop → preflight → POST.
3. Debe dar:
   - hash del workspace idéntico;
   - `claude --resume` encuentra la conversación;
   - `git config user.email` intacto;
   - secreto y puerto presentes;
   - `docker inspect N` → `.Image == imageId`;
   - relay escuchando, eventos en `.conversations/` y `capture.effective:true`;
   - `O` ya no existe.

Variantes:

- con `~/.bash_history` o un `apt-get install` ⇒ `recreatable:false` sin efectos;
- matar el backend entre los pasos 2 y 4 ⇒ `reconcile` deja `O` intacto;
- matarlo después del 4 ⇒ `reconcile` completa con `N`.

## 6. Semántica de `capture` (A3)

`GET /api/sessions/:id/conversations` y `PATCH …/conversation` devuelven:

```
capture: {
  requested, effective,
  effectiveAfterRestart,       // el siguiente `start` CREA el contenedor con captura
  requiresRecreate,            // hace falta POST …/recreate (y bastaría con que no haya blockers)
  pendingReasons: []           // flag-off | revoked | image-without-relay | running |
                               // container-without-capture | hooks-file-missing |
                               // cli-below-minimum (aviso)
}
```

**Reglas, calculadas con el `inspect` del contenedor de D1** (una llamada a Docker; no se deduce
de D1, §2):

- **`effective`**: la regla actual (requested ∧ ¬revoked ∧ running ∧ hash ∧ archivo), más que el
  contenedor tenga `ST_INGEST_TOKEN` en su env y el montaje gestionado.
- **`effectiveAfterRestart = true`** solo si la sesión es `requested ∧ ¬revoked ∧ flag`, la imagen
  actual lleva la etiqueta, y además ocurre una de estas:
  - el contenedor **no existe**: `container_id` NULL o inspect 404. El siguiente start hace spawn.
  - el contenedor existe, ya tiene token y montaje, y está detenido: restart = efectivo.
- **En cualquier otro caso es `false`**, incluido un contenedor existente sin captura, en marcha o
  detenido. Además, ahí `requiresRecreate:true`.
- **`requiresRecreate`** nunca promete que la recreación vaya a pasar: §5.2 solo se evalúa en el
  preflight (`GET …/recreate`), porque requiere `docker diff`.
- **`PATCH {enabled:true}` ya no promete nada que un start no produzca:**
  - Contenedor existente sin captura: responde `effective:false, effectiveAfterRestart:false,
    requiresRecreate:true`.
  - Contenedor con token suspendido: restaura, como hoy, y es efectivo ya.
- **Deshabilitar** no cambia: `emissionStopsAfterRestart:true` (PR #448), y nunca recrea.

## 7. Activación progresiva

Cada etapa se puede detener y revertir con `conversation:disable` o con el flag apagado. Avanzar
requiere autorización explícita del responsable.

| Etapa | Qué | Criterio para avanzar |
| --- | --- | --- |
| 0 | Desplegar backend 3.0d + imagen con etiqueta, **flag apagado** | Sesiones existentes sin cambios; `POST /ingest` → 204 `disabled`; `GET …/recreate` responde `flag-off` |
| 1 | `CONVERSATION_ENABLED=true`, nadie pedido | `reconcile` sin correcciones ni huérfanos |
| 2 | **Piloto:** una sesión del responsable, detenida, preflight `recreatable:true`, `cliVersion` ≥ 2.1.308. PATCH → preflight → POST | 48 h: eventos visibles; `rejected` solo esperados; `relayDropped=0` fuera de pruebas; RSS del relay ≤ 20 MiB; sin "hook error"; checklist de §3 verificado a mano |
| 3 | `CONVERSATION_ALLOW_USERS` = el responsable (sesiones **nuevas**, que no necesitan recrear) + 2–3 existentes que pasen el preflight | Una semana con los mismos criterios; disco de `.conversations` dentro de L7 |
| 4 | Ampliar la allowlist | Decisión aparte |

## 8. Cambios de contrato y documentación (PR de docs previo al código)

- **CONVERSATION.md:**
  - §2.4: tabla con las filas nuevas ("Recrear (admin)" y las de §6).
  - §2.4.1: el requisito se resuelve por la vía de §5.
  - §7: el endpoint, el preflight, `recreateOrphans` y los contadores.
  - §10 3.0d: las pruebas de §5.7.
- **DEPLOYMENT.md:**
  - "Recreating a session container" se reescribe sobre el endpoint. El procedimiento con
    `docker rm` queda como emergencia, con la advertencia de §3: hoy pierde la identidad git, los
    dotfiles y todo lo que haya en la capa.
  - "Rollout order": el paso 4 usa el endpoint.
  - Las etapas de §7.
- **Fuera de 3.0d, señalado:** DEPLOYMENT.md:124 (#190, "stopped and started once so it re-joins")
  tiene el mismo error que R1 de 3.0c. Va en un PR aparte.

## 9. Decisiones (cerradas por el responsable con las recomendaciones de Work)

| | Decisión |
| --- | --- |
| D1 | Recreación **administrativa explícita** y protegida; `start` no cambia |
| D2 | Preservación **estricta** de HOME y de la capa: cualquier pérdida bloquea; sin lista de exclusiones fuera de lo que produce el entrypoint (§5.2) |
| D3 | Solo se reconstruye lo que se puede verificar como exacto (`~/.gitconfig` de gitIdentity); dotfiles bloquean |
| D4 | **Sin bypass destructivo**: no hay `force` ni `acknowledgeLayerLoss` |
| D5 | Nunca se recrea una sesión en marcha, ni automáticamente ni por el endpoint |
| D6 | **ID inmutable de imagen**: el preflight lo muestra, el POST lo exige (`expectImageId`), la etiqueta se comprueba en ese ID y `createContainer` lo usa |

## 10. Correcciones respecto de la v1

- **A1 — Rollback.** La v1 renombraba `O`, creaba `N` con `spawnWithConfig` y "volvía a `O`" si
  algo fallaba. Pero `spawnWithConfig` arranca `N`, escribe el hash y el archivo **antes** de
  saber si todo saldrá bien, y no tiene rollback. La v2:
  - define un punto de no retorno único (el compare-and-set de D1, §5.3);
  - deja la captura **después** de ese punto;
  - hace cada paso de rollback idempotente;
  - recupera las interrupciones en `reconcile` con reglas por estado (§5.6), que la v1 prometía
    sin que existiera código que lo hiciera.
- **A2 — Estado compartido del workspace.** La v1 no trataba que `O` y `N` montan el mismo
  workspace. La v2 garantiza un solo escritor (lock + recomprobación) y acota lo que `N` escribe
  antes de la confirmación a efectos idempotentes del entrypoint. postStart y gitIdentity pasan a
  después. Además, hace explícito que el CLI vive en el workspace (`cliVersion`) (§5.4).
- **A3 — `container_id` y `effectiveAfterRestart`.**
  - La v1 dejaba que `spawnWithConfig` escribiera `container_id` después de `start()`, sin
    compare-and-set. La v2 garantiza que D1 apunta siempre a un contenedor existente (§5.5).
  - La v1 informaba `effectiveAfterRestart:true` con `requires-stop` aunque el siguiente start no
    lo produjera; el bot de revisión también señaló el caso de la imagen sin relay. La v2 solo
    responde `true` cuando el siguiente start **crea** el contenedor con captura, o ya la tiene.
    Lo calcula con `inspect`, y no con un hash de D1 que puede ser obsoleto. Los demás casos van
    en `requiresRecreate` y `pendingReasons` (§6).

## 11. Riesgos y preguntas abiertas

- **Pocas sesiones recreables.** Es la consecuencia buscada de D2. Si en la etapa 3 eso bloquea el
  avance, la vía sería una propuesta aparte de **traslado verificado** de rutas de HOME
  enumeradas, por ejemplo `~/.bash_history`, copiadas de `O` a `N` antes de la confirmación y
  comparadas byte a byte. No está en 3.0d.
- **Tiempo de la recreación:** `docker diff`, create, start y readiness (≤ 60 s). Se mide en el
  smoke. Es una acción administrativa, no un camino caliente.
- **Lock en proceso:** vale mientras haya un único backend, que es el despliegue actual. Varios
  backends exigirían un lock en D1.
- **La recreación toma la imagen vigente:** trae también cualquier otro cambio de imagen. El
  preflight muestra `imageId` y `currentImageId` para que el admin lo vea antes.

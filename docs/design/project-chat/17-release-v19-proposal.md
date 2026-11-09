# Release v19 (P3a): propuesta para revisar con Claude A

Estado: **propuesta, 2026-11-09. NO-GO para ejecutar.**
- El owner autorizó el **merge** de #557 (`771c519`), no el deploy.
- Este documento prepara el release para que A lo revise y para que el owner dé, o no, un GO específico.
- Nada de lo que sigue se ejecuta sin ese GO.

`M` = SHA del merge de #557 en `main` (se completa al mergear).

## 1. Qué cambia en producción

**La migración v19 corre al arrancar el backend, sea cual sea `PROJECT_CHAT_ENABLED`.** La bandera
controla la API, no el esquema.

| Cambio | Con la bandera apagada (lo que se propone) |
| --- | --- |
| **v19**: cuatro tablas (`projects`, `project_agents`, `agent_bindings`, `project_agent_creations`), dos triggers y tres índices. No modifica ni lee ninguna tabla existente, y `agent_bindings` no tiene FK a `sessions` | Se crean vacías y nada las escribe |
| Rutas `/api/projects/*` | No se montan: dan 404 |
| `GET /api/auth/status` y `GET /api/sessions` | Iguales byte a byte: sin `features` y sin `binding` |
| Guard de hard delete (`assertNoLiveBinding`, dos veces por hard delete, owner y admin) | **Activo**. Hace dos lecturas D1 más por hard delete. Sin vínculos, nunca rechaza |
| `failSession` usa `SessionManager.markFailed` (`AND status != 'terminated'`) | **Activo**. Una sesión `terminated` ya no vuelve a quedar `failed` si un bootstrap falla tarde. Es un cambio de comportamiento menor y buscado |
| Backup (`npm run backup`) | Exporta además las cuatro tablas (`sinceSchema: 19`) |

## 2. Alcance del salto: lo decide el owner con A

El deploy es de un SHA de `main`. Hoy `main` lleva, encima de `R = e198b07` (el release G3-1, que
**todavía no está desplegado**):

- `166ff78`: #547, composer para sesiones CLI en segundo plano, EXPERIMENTAL, bandera apagada;
- `M`: #557, P3a y v19.

**Qué SHA corre hoy en VM100:** no lo sé y no lo supongo. A lo confirma por digest, como en 12 §7. El
rango real del release va desde ese SHA hasta `M`.

**Recomendación de secuencia:** **primero el release G3-1 (`R`)** con su propio plan (doc 11), y
**después** este release, como salto `R → M`. Así cada release tiene una sola migración o bandera
nueva que observar: G3-1 no tiene migración, y este tiene v19. Desplegar `M` directamente mezcla G3-1,
#547 y v19 en una sola ventana. Si el owner lo prefiere así, el procedimiento de §4 sirve igual, pero
las verificaciones de doc 11 se suman a las de §5.

## 3. Evidencia disponible antes del GO

1. **D1 real** (2026-11-09, `771c519`, cuenta de pruebas dedicada): 30/30 comprobaciones obligatorias PASS. Cubre migración, triggers e índices guardados por D1, creación atómica, idempotencia, rechazos reconocidos, concurrencia, guard, `markFailed` y re-migración con reinicio. Evidencia en #557.
2. **Compatibilidad hacia atrás**, comprobada en el código de `migrateDb()`: aplica sólo las versiones que conoce y no está registradas, e ignora las que no conoce. La imagen anterior arranca con v19 registrada sin aplicar nada (C12 lo registra en D1 real).
3. **Una v19 interrumpida converge:** cada statement es `IF NOT EXISTS` y el registro en el ledger va al final. Si el backend muere a mitad de v19, el siguiente arranque la completa.
4. **CI 9/9** sobre `771c519`, que incluye imagen del backend limpia, smokes de la imagen de sesión y e2e.

**Prueba opcional antes del GO** (recomendada si se despliega `M` directamente): arrancar la imagen de `M`
contra una D1 de pruebas restaurada desde un export de producción. **No se propone por defecto**,
porque exige exportar datos de producción a otra cuenta y eso es una decisión del owner.

## 4. Procedimiento propuesto

Se basa en el procedimiento con alcance de doc 11/12 (lo ejecuta A con el GO del owner):

1. **Precondiciones (sólo lecturas):**
   - SHA y digest del backend que corre, confirmados;
   - imagen actual etiquetada como imagen de rollback, anotando su id;
   - ≥ 20 GB libres;
   - ningún release, recreación ni ventana O1 en curso;
   - `PROJECT_CHAT_ENABLED` ausente o vacía en `.env`.
2. **Backup** (etapa separada, como P9) con el backend que corre. Todavía no hay tablas de v19, así que nada queda afuera.
3. **Opcional:** anotar el bookmark de D1 Time Travel de la base de producción antes del deploy (lectura). No hace falta para v19, que es aditiva, pero deja un punto de restauración de la base sin costo.
4. **Build** del servicio `app` desde `M` y verificación de su digest, como en doc 11 (`dist` limpio, #555).
5. `docker compose up -d --no-deps --no-build --force-recreate -t 30 app`.
6. **Verificación**: §5.

## 5. Verificación posterior (sólo lecturas, sin acciones destructivas)

| # | Lectura | Esperado |
| --- | --- | --- |
| V1 | `docker logs` del arranque | `applying migration 19` y luego `migrations complete (1 applied)`, sin errores D1 |
| V2 | `docker compose exec app printenv PROJECT_CHAT_ENABLED` | vacío |
| V3 | `GET /api/projects` con la cookie del owner | 404 |
| V4 | `GET /api/auth/status` | sin `features` |
| V5 | `GET /api/sessions` | ninguna fila con la clave `binding` |
| V6 | `GET /api/admin/stats` | sesiones por estado y captura (`enabledSessions`, `effectiveSessions`) iguales a antes del deploy |
| V7 | Inventario de contenedores `st-*` | igual al de antes (ID, nombre, `State`) |

En producción **no** se prueba un hard delete. El guard y `markFailed` quedan cubiertos por la D1 real y
por los tests.

## 6. Rollback

- **Disparadores:** el backend no arranca; V1 muestra un error de v19 que se repite; V3–V7 no dan lo esperado; aparece una regresión en sesiones o captura.
- **Cómo:** por **imagen**, levantando la imagen anotada en el paso 1 con el mismo `up --no-deps --no-build --force-recreate`.
- **Base:** **no se toca.** Con la bandera nunca encendida se está en el caso A de PROJECTS.md §8: es seguro y no tiene precondiciones. **Nunca** se borran las tablas de v19 ni se edita el ledger.
- **Si v19 falló a mitad:** queda sin registrar. La imagen anterior no la conoce y arranca igual. Un re-deploy de `M` la completa.

## 7. Fuera de este release

- Encender `PROJECT_CHAT_ENABLED`: requiere su propio GO, y con vínculos existentes el rollback pasa al caso B (§8).
- G3-2, Channels, tareas y despacho: sin autorización.
- #547 (composer en segundo plano): su bandera sigue apagada.

## 8. Preguntas para A

1. ¿Qué SHA y digest corren hoy en VM100? ¿Sigue pendiente el release G3-1 (`R`)?
2. ¿Aceptás la secuencia `R` primero y después `R → M`? ¿O preferís un único salto a `M`?
3. ¿Hay en VM100 algo fuera del repo que dependa del esquema de D1, como scripts o consultas manuales, y que deba saber de las cuatro tablas nuevas?
4. ¿Las lecturas V1–V7 están a tu alcance tal como están escritas, o hay que ajustar alguna?

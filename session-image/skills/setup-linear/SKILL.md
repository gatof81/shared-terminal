---
name: setup-linear
description: Use when setting up a retroactive Linear base for an ALREADY-STARTED project — a specialist-driven repo review (architecture / docs / code / QA) that reconciles existing issues and builds a full Linear board so it looks like Linear was used from day one and now tracks ongoing development. Produces Delivered history (with the "how" = PRs/ADRs + screenshots), an open backlog (bugs/features/tests/security/docs/review/roadmap) with fully developed detail, milestones-as-phases, and a project Overview. Triggers "armar/configurar Linear para el proyecto", "trackear el desarrollo en Linear", "setup linear", or handing this task to agents in other projects. Projects typically have ADRs/plan/specs and prior GitHub issues.
---

# Setup a retroactive Linear base + ongoing tracking for an already-started project

## Parametros — AUTO-DETECTALOS del proyecto. Pregunta al humano SOLO lo que no puedas inferir con confianza.
```
REPO           -> el repo actual (git remote / cwd).
LINEAR_PROJECT -> por defecto el nombre del repo; si ya existe un Linear project que matchea, usalo.
LINEAR_TEAM    -> list_teams: si hay 1, usalo; si hay >1 y el project no existe todavia, PARA y pregunta.
ESPECIALISTAS  -> los specialists disponibles en la sesion/hub (architect/developer/QA/...); si no hay, hace todos los roles vos.
FASE_ACTUAL    -> inferi de docs/plan/milestones cual es la fase en curso; default "Phase-1 close-out".
APP_RUN        -> de package.json scripts / README (ej. "npm run dev"); "no aplica" si el proyecto no tiene UI.
```
Reporta al humano que detectaste (una linea por parametro) y pedi confirmacion solo de los ambiguos antes de escribir en Linear.

**Objetivo:** En el proyecto Linear `LINEAR_PROJECT` construir una base completa de `REPO` que **parezca que se uso Linear desde el dia uno y ahora se sigue trackeando el desarrollo**: historico de todo lo hecho *con el como* + backlog abierto de lo que falta, **reconciliando** lo existente, con **screenshots** de las features. Es un proyecto ya iniciado: tiene ADRs, plan, specs (tipicamente `docs/`) y probablemente issues en GitHub.

**Fase 1 — Entendimiento profundo: cada uno de `ESPECIALISTAS` en su area; el architect sintetiza.**
- **Architect** -> arquitectura/diseno: ADRs, plan, specs, limites de modulos, decisiones, deuda de diseno.
- **Developer** -> estado del codigo: que esta implementado y como, tech-debt, gaps de tests, TODOs/FIXMEs reales (`file:line`).
- **QA** -> que funciona: levanta la app (`APP_RUN`), ejercita flujos, cobertura/regresiones, y **captura screenshots** (Fase 3).
- **Otros** -> seguridad/data/infra/docs, cada uno en lo suyo.
- Reglas: *nunca evalues lo que no abriste*; reconstrui el **git history** mapeando cada increment/fase/feature a sus **PRs y ADRs**; lista los **issues de GitHub** (abiertos y cerrados); **cada afirmacion cita evidencia** (doc seccion, `file:line`, PR#, issue#). **No inventes trabajo.**

**Fase 2 — Estructura en Linear (QA):**
- **Labels** (crear si faltan): `type:feature, bug, test, security, ops, docs, review, roadmap`.
- **Milestones = fases:** `Delivered` / `FASE_ACTUAL` / `Roadmap (Phase 2+)`.
- **Overview del project:** descripcion retroactiva — que es, estado actual (entregado + deployado), que sigue, que viene, y como se trackea. Que se lea como si Linear se hubiera usado desde el inicio.

**Fase 3 — Issues (con detail desarrollado) + screenshots:**

> **REGLA DE DETALLE — obligatoria para TODOS los issues (bug / feature / request / test / chore / delivered). Prohibido el issue de una linea.**
>
> **Issues ABIERTOS** — plantilla:
> - **Contexto / Problema:** que pasa o que falta, y por que importa.
> - **Evidencia:** doc seccion, `file:line`, PR#, issue#, o screenshot.
> - **Enfoque propuesto:** approach sugerido (sin sobre-especificar la implementacion).
> - **Alcance:** que entra / que queda afuera.
> - **Definition of Done:** criterios concretos y verificables.
> - **Links:** GH issue / ADR / specs relacionados.
>
> **Issues DELIVERED** — plantilla:
> - **Que se entrego:** la feature/increment, en prosa.
> - **Como:** PRs (#), ADRs, commits, migraciones.
> - **Evidencia:** screenshot(s) de la feature + `file:line`/doc.
> - Estado **Done**, milestone `Delivered`.

- **Delivered (historico):** un issue por increment/fase/feature entregada, con la plantilla Delivered.
- **QA genera screenshots:** con `APP_RUN` levantas la app y con un browser headless (Playwright/Puppeteer, o la tooling del repo) capturas **una pantalla por feature principal**. Guarda los PNG (ej. `docs/screenshots/`) y **adjuntalos al issue Delivered y al Overview**. Si el MCP de Linear no permite subir imagenes, commitea los PNG y linkea la URL.
- **Abiertos:** un issue por pendiente (bug/test/security/docs/review/roadmap), con la plantilla Abierto.
- **Reconciliar GitHub issues:** mapealos a Linear (o linkealos), sin duplicar.

**REGLAS DE ORO (no negociables):**
1. **List-first, idempotente, reconciliar > crear.** Lista labels/milestones/issues existentes ANTES de escribir. **Nunca dupliques.**
2. **Matchea conceptualmente, no solo por titulo literal** — reconcilia el existente en vez de crear casi-duplicados.
3. **PARA y pregunta ante ambiguedad estructural.** No adivines sobre un proyecto vivo.
4. **Evidencia siempre; el repo/docs es la fuente de verdad, Linear es un espejo.**
5. **Resumible + reporte honesto:** si te quedas sin turnos, reporta que quedo hecho (con IDs); reporta **creado vs reconciliado vs salteado**; no declares "hecho" sin verificar el end-state.
6. **Degradacion explicita:** si algo no se pudo (app no levanta, sin browser headless, sin upload de imagenes), **anotalo** — no lo saltees en silencio.

**Nota sobre "desde el principio":** el `createdAt` de Linear es de hoy y **no se puede backdatear**; no intentes falsear fechas. El efecto retroactivo se logra con **Delivered en Done + milestone `Delivered` + Overview + screenshots + detail completo**, no con timestamps.

**Gotchas de acceso:**
- **Linear headless:** las tools `mcp__linear__*` del QA deben estar **allowlisteadas** en su config (si no, se auto-deniegan sin aprobacion interactiva). **No extraigas tokens OAuth** para saltear permisos; sin allowlist, usa una API key personal (`lin_api_...`).
- **Screenshots:** requieren app levantable + browser headless; adjuntar a Linear puede necesitar file-upload en el MCP/API (si no, PNG al repo + link).

**Entregable:** project con Overview + milestones(fases) + issues Delivered (Done, con el como, detail y screenshots) + backlog abierto reconciliado y con detail — mas un reporte de creado/reconciliado/salteado.

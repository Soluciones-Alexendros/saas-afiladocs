# Manual de Deploy — Afiladocs

### Propósito de este documento

- **Objetivos:** Fijar la matriz de env vars, el contrato CI y los fallos
  frecuentes de deploy. Si un PR rompe este contrato, CI debe detectarlo.
- **Estructura:** Matriz → pre-push → jobs CI → Vercel → fallos → merge.
- **Contenido a integrar según contexto:** Actualiza la tabla de jobs si
  cambia `ci.yml`. No sustituyas los runbooks de rollback o secretos.

**Última revisión:** 2026-09-24

Documento único con los requisitos que exige cada entorno (local, CI, Vercel Preview y Vercel Prod), el checklist obligatorio antes de hacer push, y el registro vivo de fallos frecuentes. Si un PR rompe este contrato, CI debe detectarlo antes del merge.

## 1. Matriz de entornos

Las variables se agrupan por el papel que cumplen. Columnas:

- **Local** → `.env.local`, valores reales del desarrollador.
- **CI** → placeholders en [.github/workflows/ci.yml](../.github/workflows/ci.yml). Nunca secretos reales.
- **Preview** → deploys de rama en Vercel. Valores reales de entorno `preview`.
- **Prod** → `main` en Vercel, valores reales de entorno `production`.

| Variable                                            |          Local          |           CI            |         Preview          |          Prod           |
| --------------------------------------------------- | :---------------------: | :---------------------: | :----------------------: | :---------------------: |
| `DATABASE_URL` (pooler 6543)                        |          real           |       placeholder       |           real           |          real           |
| `DIRECT_URL` (5432, sólo migrate)                   |          real           |       placeholder       |           real           |          real           |
| `NEXT_PUBLIC_SUPABASE_URL`                          |          real           |       placeholder       |           real           |          real           |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`                     |          real           |       placeholder       |           real           |          real           |
| `SUPABASE_SERVICE_ROLE_KEY`                         |          real           |       placeholder       |           real           |          real           |
| `STRIPE_SECRET_KEY` (`sk_test_*` en preview)        |          test           |       placeholder       |           test           |        **live**         |
| `STRIPE_WEBHOOK_SECRET`                             |          test           |       placeholder       |           test           |        **live**         |
| `RESEND_API_KEY`                                    |          real           |       placeholder       |           real           |          real           |
| `RESEND_FROM_EMAIL`                                 |           opt           |            —            |           opt            |           opt           |
| `DOCUSEAL_API_URL` / `_API_KEY` / `_WEBHOOK_SECRET` |           opt           |            —            |           opt            |          real           |
| `EASYVERIFACTU_API_URL` / `_API_KEY`                |           opt           |            —            |           opt            |          real           |
| `N8N_CONTACT_WEBHOOK_URL`                           |           opt           |            —            |           opt            |          real           |
| `N8N_ALERTS_WEBHOOK_SECRET`                         |           opt           |            —            |           opt            |          real           |
| `N8N_ERROR_WEBHOOK_URL`                             |           opt           |            —            |           opt            |          real           |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN`                 |           opt           |            —            |           opt            |          real           |
| `CRON_SECRET`                                       |           opt           |       placeholder       |           opt            |        **real**         |
| `OPS_EMAIL`                                         |           opt           |            —            |           opt            |          real           |
| `GEO_BLOCKED_COUNTRIES`                             |           opt           |            —            |           opt            |           opt           |
| `NEXT_PUBLIC_SITE_URL`                              | `http://localhost:3000` | `https://afiladocs.com` | **no definir** (noindex) | `https://afiladocs.com` |
| `OBSERVABILITY_SENTRY_AUTH_TOKEN`                   |            —            |            —            |           auto           |          auto           |

Fuente canónica: [src/lib/env.ts](../src/lib/env.ts). El script [scripts/check-env-example.ts](../scripts/check-env-example.ts) valida en CI que cada variable referenciada ahí esté en [.env.example](../.env.example). En Preview/Prod, las vars de Supabase y Prisma las inyecta **Vercel Marketplace Free** al linkar el recurso al proyecto `afiladocs` (no self-hosted, no VPS).

`opt` = opcional (lazy getter con fallback). `—` = no aplica. `real` = valor de producción o preview. `placeholder` = valor no funcional usado sólo para que `prisma generate` y `next build` no aborten.

## 2. Pre-push checklist

Obligatorio antes de abrir o actualizar un PR (regla declarada en [CLAUDE.md](../CLAUDE.md)):

```bash
npm run ci:local
```

Equivale a: `check:env → typecheck → lint → test:coverage → build → smoke`. Es el mismo contrato que los jobs `quality` / `test` / `build` / `smoke` de [ci.yml](../.github/workflows/ci.yml), menos `pnpm install --frozen-lockfile`. Si esto pasa en local, CI debería pasar en el primer intento.

Si el PR toca el esquema Prisma: además `npx prisma migrate dev` contra BD local o Supabase dev.

## 3. Qué verifica CI (contrato)

El workflow [.github/workflows/ci.yml](../.github/workflows/ci.yml) es la fuente única de verdad. Jobs actuales:

| Job        | Qué ejecuta                                                | Detecta                                               |
| ---------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| `quality`  | `check:env`, `typecheck`, `lint`, `pnpm audit` informativo | Env sin documentar, tipos, ESLint, advisories         |
| `test`     | `test:coverage` + artefacto `coverage/`                    | Regresiones unitarias + umbrales de cobertura         |
| `build`    | `next build` + artefacto `.next`                           | Rutas App Router rotas, RSC mal tipados, CSP, bundles |
| `smoke`    | `pnpm run smoke` sobre el artefacto (`GET /api/health`)    | Runtime mínimo no arranca o health no responde `ok`   |
| `security` | actionlint + zizmor                                        | Workflows inseguros (job de producto, no se renombra) |

`concurrency: ci-<ref>` con `cancel-in-progress: true` cancela runs anteriores de la misma rama cuando llega un push nuevo.

**Runner:** `ubuntu-latest` (GitHub-hosted). El label `[self-hosted, ts]` se retiró porque el runner de la org no estaba online y los jobs quedaban en cola indefinida (p. ej. [run 35818279495](https://github.com/Soluciones-Alexendros/saas-afiladocs/actions/runs/35818279495)). No volver a `self-hosted` hasta confirmar un runner registrado con esas labels.

**Regla**: si este workflow cambia, esta tabla cambia en el mismo PR.

## 4. Requisitos Vercel

- **Región**: `cdg1` (París, PoP más cercano a ES — Vercel no tiene Madrid). Declarada en [vercel.json](../vercel.json).
- **`maxDuration`**: 30 s para checkout/webhooks, 60 s para crons, 10 s para contact, 5 s para health.
- **Crons**: sólo se ejecutan en `production`. Preview no dispara crons.
- **`NEXT_PUBLIC_SITE_URL`**: sólo definida en `production` (`https://afiladocs.com`). Previews la omiten a propósito para que [robots.ts](../src/app/robots.ts) devuelva `Disallow: /` y `sitemap.ts` responda `noindex`.
- **Secretos**: todo `*_SECRET_KEY`, `*_API_KEY`, `*_WEBHOOK_SECRET`, `CRON_SECRET` sólo en scope "Production" + "Preview" (nunca "Development" en Vercel — esos se inyectan vía `.env.local`).
- **Prisma**: `postinstall: prisma generate` corre en el build de Vercel; `DATABASE_URL` y `DIRECT_URL` deben existir como env vars del proyecto.
- **Supabase**: path canónico **Vercel Marketplace Free** linkado al proyecto `afiladocs`. Inyecta `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `DIRECT_URL`. `supabase.afiladocs.com` (self-hosted) está **descatalogado**; no hay VPS. `NEXT_PUBLIC_SUPABASE_URL` **y** `NEXT_PUBLIC_SUPABASE_ANON_KEY` son ambas obligatorias en edge: si falta la anon key, `createServerClient` lanza y Vercel responde 500 `MIDDLEWARE_INVOCATION_FAILED` (issue #59). El middleware actual falla cerrado (503 / skip). **No inventar** keys en el repo — linkar Marketplace y redesplegar.
- **Sentry**: la integración Vercel+Sentry inyecta `OBSERVABILITY_SENTRY_AUTH_TOKEN`, `_ORG`, `_PROJECT` y `NEXT_PUBLIC_OBSERVABILITY_SENTRY_DSN`. No definirlos a mano.

## 5. Fallos frecuentes y remedio inmediato

Registro vivo. Cuando CI falle por un motivo no listado aquí, añade la entrada en el mismo PR que lo corrige.

| Síntoma                                                                       | Causa                                                                                    | Remedio                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prisma.config.ts: define DIRECT_URL o DATABASE_URL` en `npm ci`              | `postinstall` corre `prisma generate` y falta env                                        | En CI: placeholder en `env:` del job (ya aplicado). En local: poblar `.env.local`                                                                                                                       |
| `MISSING DEPENDENCY @vitest/coverage-v8`                                      | Vitest 4 no lo incluye transitivamente                                                   | Añadir `@vitest/coverage-v8` a `devDependencies` con la **misma versión** que `vitest`                                                                                                                  |
| `Missing required environment variable: X` en build de Vercel                 | Env nueva en `src/lib/env.ts` sin añadir al proyecto Vercel                              | Añadir a Preview + Prod desde el dashboard, redeploy                                                                                                                                                    |
| CSP bloquea script en prod                                                    | `script-src` sin el nonce correcto tras cambio en [next.config.ts](../next.config.ts)    | Ver `guias/guia-seguridad.md` § CSP nonce                                                                                                                                                               |
| Webhook Stripe firma inválida                                                 | `STRIPE_WEBHOOK_SECRET` apunta al endpoint equivocado                                    | [runbooks/stripe-webhook-fallido.md](runbooks/stripe-webhook-fallido.md)                                                                                                                                |
| Build Vercel OK pero preview/prod 500 en `/` (`MIDDLEWARE_INVOCATION_FAILED`) | Falta `NEXT_PUBLIC_SUPABASE_ANON_KEY` (o URL); Marketplace no está linkado a `afiladocs` | Linkar **Supabase Free Plan** al proyecto y redesplegar. No inventar JWT. Ver [issue #59](https://github.com/Soluciones-Alexendros/saas-afiladocs/issues/59) y [PRODUCCION-P0.md](../PRODUCCION-P0.md). |

## 6. Política de merge

Un CI en verde es condición **necesaria** pero no **suficiente**:

- ❌ No merge a `main` sin CI verde.
- ❌ No merge si el PR modifica `.env.example` / `src/lib/env.ts` y no actualiza la §1 (matriz) de este manual.
- ❌ No merge si el PR cambia [vercel.json](../vercel.json), [next.config.ts](../next.config.ts), [prisma.config.ts](../prisma.config.ts) o [.github/workflows/ci.yml](../.github/workflows/ci.yml) sin una sección "Impacto en deploy" en la descripción del PR.
- ✅ Merge squash por defecto. Fast-forward sólo para hotfixes de una sola commit bien formada.

## 7. Rollback

Ante un deploy malo en producción: [runbooks/rollback-vercel.md](runbooks/rollback-vercel.md). Tiempo objetivo de recuperación: < 5 min vía dashboard Vercel ("Promote to Production" sobre el deploy anterior).

Para secretos comprometidos: [runbooks/rotacion-secretos.md](runbooks/rotacion-secretos.md).

# PRODUCCION-P0 — Producción caída

Incidente: [issue #59](https://github.com/Soluciones-Alexendros/saas-afiladocs/issues/59).

## Decisión de owner (2026-09-23)

**Supabase canónico = Vercel Marketplace Free (freemium), linkado al proyecto `afiladocs`.** No hay VPS. **No** se restaura ni se opera `supabase.afiladocs.com` (self-hosted / Kong / Let's Encrypt). Ese hostname queda **descatalogado** como destino actual.

Las env (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `DIRECT_URL`) las **inyecta el Marketplace** al linkar el recurso al proyecto. El repo **no inventa** ni commitea claves.

## Estado actual

Sondeo verificado el **2026-09-23 ~16:40 UTC** (no restaurado):

- `afiladocs.com` (frontal Next.js en Vercel): **no saludable**. DNS resuelve. HTTPS **500** `x-vercel-error: MIDDLEWARE_INVOCATION_FAILED`.
- `www.afiladocs.com`: mismo **500**.
- `supabase.afiladocs.com`: DNS aún resuelve (`191.96.53.6`) y timeout/TLS, pero **ya no es el target**. No invertir tiempo en el VPS.
- Marketplace **Supabase Free Plan** existe en el team (`icfg_ncZ1V6hd68mpGSC0vA2HBns4`) y **no está linkado** al proyecto `afiladocs` (`projects: []`). Por eso faltan anon key y URLs de BD en Production.

El middleware (merge #60) falla cerrado si faltan env públicas: 503 controlado en rutas de auth, skip en páginas públicas. **No restaura** el frontal hasta que Marketplace inyecte las keys y se redespliegue.

## Sondeo 2026-09-26 (16:15 CEST / 14:15 UTC) — frontal mitigado, verificar env

- `GET https://afiladocs.com/` → **200**, `server: Vercel`, `x-vercel-cache: HIT`, sin `x-vercel-error`, sin `MIDDLEWARE_INVOCATION_FAILED`.
- `GET https://afiladocs.com/tienda` → **200**, `x-vercel-cache: MISS`, `cache-control: private, no-cache`.
- `GET https://afiladocs.com/api/health` (UA navegador) → **200** `{"status":"ok","ts":"2026-09-26T14:15:39.620Z","version":"unknown"}`.
- Nota: con UA `curl`/`wget`, `/api/*` devuelve **403 Forbidden** por el filtro antibot del middleware (esperado, no es P0). El smoke usa UA propio.
- `GET https://www.afiladocs.com/` → **307** a apex. Correcto.
- Conclusión: el frontal **ya no está en 500**. Estado: **mitigado / verificar env**. Queda confirmar en Vercel que el recurso Marketplace está linkado (no `projects: []`), redesplegar `main` y que los logs ya no muestran "URL and Key are required". No cerrar #59 hasta ese smoke post-Marketplace.

## Causa confirmada (runtime, no inventar secretos)

Deploy production **READY** `dpl_DH8JkqbqDCEkbwqbCkVUNKemJs7J` (commit `17665b4f`). Logs de edge-middleware:

```text
Error: Your project's URL and Key are required to create a Supabase client!
```

Inventario Vercel (34 envs), **sin valores**:

| Variable                        | Production             | Notas                                           |
| ------------------------------- | ---------------------- | ----------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | presente               | No basta: el cliente exige URL **y** Key        |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **ausente**            | Causa directa del throw en `createServerClient` |
| `SUPABASE_SERVICE_ROLE_KEY`     | **ausente**            | Storage / ops server-side                       |
| `DATABASE_URL` / `DIRECT_URL`   | vacías o no inyectadas | Prisma runtime; Marketplace sin link            |

**Acción:** en Vercel → proyecto `afiladocs` → Storage / Integrations → linkar **Supabase Free Plan** al proyecto (Preview + Production). Dejar que el Marketplace escriba las env. Redesplegar `main`. **No pegar placeholders ni inventar JWT.**

## Impacto de negocio

- Tienda B2C de plantillas legales inaccesible.
- Portal cliente, backoffice `/ops`, API routes, webhooks y crons fuera de servicio.
- No se procesan pagos (Stripe), firmas (DocuSeal) ni facturas (Verifactu).

## Checklist de recuperación (path freemium)

### 1. Vercel Marketplace → proyecto `afiladocs`

- [ ] Confirmar el recurso **Supabase Free Plan** en el team (`alexendros-team`).
- [ ] Linkarlo al proyecto `afiladocs` (no dejar `projects: []`).
- [ ] Verificar que Marketplace inyecta, al menos: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `DIRECT_URL` en Production (y Preview).
- [ ] No crear keys a mano en el repo. Si alguna env vieja apunta a `supabase.afiladocs.com`, sustituirla por la URL `*.supabase.co` que inyecte Marketplace.
- [ ] Redesplegar `main`. Confirmar que edge-middleware ya no lanza "URL and Key are required".

### 2. Vercel frontal (`afiladocs.com`)

- [ ] Revisar últimos deploys y runtime logs (el 500 opaco debe desaparecer tras el link + redeploy; con #60 se espera 503/skip si aún faltan env).
- [ ] Comprobar dominios `afiladocs.com` / `www.afiladocs.com` y certificado.
- [ ] Smoke: `/` no es `MIDDLEWARE_INVOCATION_FAILED`.

### 3. `supabase.afiladocs.com` (descatalogado)

- [x] **No restaurar.** Sin VPS. Hostname legacy; ignorar timeout/TLS.
- [ ] Opcional más adelante: quitar el registro DNS si molesta monitores. No es bloqueante.

### 4. Observabilidad

- [ ] Sentry / Vercel Analytics / monitores: dejar de alertar `supabase.afiladocs.com` como P0.
- [ ] Tras el link, validar Auth + Postgres del proyecto Marketplace (dashboard Supabase cloud).

### 5. Validación post-recuperación

- [ ] Smoke test de home, tienda, ficha de producto, checkout (modo test), login y portal.
- [ ] Webhooks Stripe y DocuSeal.
- [ ] Crons Vercel.
- [ ] Conectividad de la app a Supabase Auth y base de datos **cloud** (no Kong self-hosted).

## Nota

Los PRs de Actions y fail-closed de middleware no inyectan secretos. La recuperación es **link Marketplace + redeploy**.

# Runbook — Primera compra en modo test (Stripe TEST)

**Última revisión:** 2026-09-26
**Ámbito:** camino ejecutable a 1 compra test con los 3 SKUs candidatos (`AFD-RGPD-POL-001`, `AFD-CIV-NDA-001`, `AFD-ARR-VIV-001`).
**No activa Stripe LIVE** ni rota secretos. Para el go-live real, ver [golive-stripe-live.md](golive-stripe-live.md).

## Pre-requisitos

- [ ] Frontal sano: `pnpm smoke` en verde (ver [PRODUCCION-P0.md](../../PRODUCCION-P0.md)).
- [ ] Recurso Supabase (Marketplace) linkado al proyecto `afiladocs` con `main` redesplegado. Sin esto, `/tienda` puede ir en 200 pero el checkout falla (sin `DATABASE_URL` ni keys).
- [ ] `pnpm audit:catalog --sku <SKU>` sin BLOCK (WARN por QA pendiente es esperado en esta fase).
- [ ] Acceso a Stripe Dashboard en modo **TEST** y a `/ops` con usuario ops.

## 1. Crear los prices en Stripe TEST (manual, [A] Alejandro)

Por cada SKU candidato, con datos de `prisma/seeds/products.json`:

1. Stripe Dashboard → modo **TEST** → Products → New.
2. Name = `title` del seed; Price = `price_cents / 100` EUR, **one-time** (no recurring); Tax behavior según `vat_mode`.
3. Metadata: `sku=<SKU>`, `afiladocs_category=<categoria>`, `eidas_level=<SES|AES>`.
4. Copiar el `price_...` de TEST. **No tocar `catalog/manifest.json`**: los IDs de test no se registran como canónicos (el manifest solo guarda IDs LIVE). Guardar el mapeo aparte hasta el go-live.

Precios de referencia:

| SKU              | Título                                               | Precio  |
| ---------------- | ---------------------------------------------------- | ------- |
| AFD-RGPD-POL-001 | Política de privacidad web + aviso legal             | 29,00 € |
| AFD-CIV-NDA-001  | Acuerdo de confidencialidad (NDA) bilateral          | 29,00 € |
| AFD-ARR-VIV-001  | Contrato de arrendamiento de vivienda habitual (LAU) | 39,00 € |

## 2. Exponer el producto en `/tienda` (preview, sin LIVE)

1. En el entorno de preview/test (nunca en producción con `is_active` definitivo): `/ops/productos/[sku]` → pegar `stripe_price_id` de TEST (+ `docuseal_template_id` si ya existe; si no, dejar vacío y documentar).
2. Marcar `is_active=true` **solo en preview**. En producción los 3 SKUs siguen con `is_active=false` hasta tener QA jurídica + IDs LIVE.
3. Abrir `/tienda` y confirmar que el producto es visible con título y precio correctos.

## 3. Webhook de Stripe en local/preview

1. `stripe listen --forward-to localhost:3000/api/webhooks/stripe` (o la URL de preview) con la clave `sk_test_...`.
2. Confirmar que `STRIPE_WEBHOOK_SECRET` corresponde al `whsec_...` de ese listener/endpoint.

## 4. Ejecutar la compra test

1. En `/tienda`, añadir el SKU y pulsar comprar (flujo `POST /api/checkout` → sesión Stripe).
2. Pagar con la tarjeta test `4242 4242 4242 4242` (cualquier CVC y fecha futura).
3. Stripe redirige a `/pago-exitoso?session_id={CHECKOUT_SESSION_ID}`.

## 5. Qué verificar

- [ ] En Stripe Dashboard (TEST) → Payments: pago `succeeded` con metadata `sku` correcta.
- [ ] En `/ops` → pedido creado con estado esperado según `delivery_mode` (`docuseal_fill_only` / `docuseal_fill_and_sign`).
- [ ] Webhook `checkout.session.completed` recibido y procesado (sin reintentos fallidos).
- [ ] DocuSeal: si hay template de TEST configurado, llega el email de rellenar/firmar; si no hay template, el pedido queda pendiente de firma — registrarlo como `[A]` pendiente, no como fallo del test.
- [ ] Email transaccional (Resend en test) y entrada en `/portal` para el cliente.
- [ ] Registrar evidencias (IDs de pedido, timestamps) en `catalog/drafts/<SKU>/smoke-test.md`.

## 6. Cierre del test

- [ ] Volver `is_active=false` en preview si el producto no debe quedar visible.
- [ ] No commitear `stripe_price_id` de TEST en `catalog/manifest.json` ni en el seed.
- [ ] Anotar en el PR o en el kanban qué SKU se probó y qué quedó pendiente (QA legal, template DocuSeal, Storage).

## Pendiente humano tras este runbook (no automatizable aquí)

- [A] QA jurídica con firma humana de los 3 drafts (`notes-legal.md` + `legal_reviewed_by/at` en manifest).
- [A] Templates DocuSeal (UI) para NDA-001 y ARR-VIV-001 (`fill_and_sign`); POL-001 es `fill_only`.
- [A] Alta de productos en Stripe **LIVE** + `audit-catalog` en READY + activación vía `/ops/productos`.
- Operador ALIGNUX: link Marketplace + redeploy si aún falta al ejecutar este runbook.

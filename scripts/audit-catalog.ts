#!/usr/bin/env tsx
// Auditor de coherencia del catálogo Afiladocs (modo repo + BD opcional).
// No modifica ninguna fuente — solo lee y reporta.
//
// Uso:
//   pnpm audit:catalog --sku AFD-RGPD-POL-001
//   pnpm audit:catalog --all
//   pnpm audit:catalog --all --format md
//   pnpm audit:catalog --all --format json
//
// Exit codes:
//   0 → sin criticals (READY, WARN o PARTIAL por checks saltados)
//   1 → al menos un SKU en BLOCK (un check critical)
//   2 → error de invocación (args inválidos, SKU desconocido, ficheros ilegibles)
//
// Checks externos (Stripe / DocuSeal API): siempre `skipped` en esta versión
// mínima. La verificación de price/template se hace a mano en los dashboards
// y queda registrada en `manifest.stripe_last_verified` /
// `manifest.docuseal_last_verified`. No se inventan IDs.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SEED_PATH = join(ROOT, "prisma", "seeds", "products.json");
const MANIFEST_PATH = join(ROOT, "catalog", "manifest.json");
const DRAFTS_DIR = join(ROOT, "catalog", "drafts");

const STATUSES = new Set([
  "draft",
  "qa_legal",
  "template_ready",
  "live",
  "retired",
]);

type Severity = "ok" | "warn" | "critical" | "skipped";

type Check = {
  name: string;
  severity: Severity;
  detail: string;
};

type SkuReport = {
  sku: string;
  verdict: "READY" | "WARN" | "BLOCK" | "PARTIAL";
  checks: Check[];
};

type SeedProduct = {
  sku: string;
  price_cents: number;
  delivery_mode: string;
  eidas_level: string;
  is_active: boolean;
  stripe_price_id: string | null;
  docuseal_template_id: string | null;
};

type ManifestProduct = {
  sku: string;
  version: string;
  status: string;
  stripe_price_id: string | null;
  docuseal_template_id: string | null;
  legal_reviewed_by: string | null;
  legal_reviewed_at: string | null;
};

function fail(message: string): never {
  console.error(`audit-catalog: ${message}`);
  console.error(
    "Uso: pnpm audit:catalog --sku <SKU> | --all [--format text|md|json]",
  );
  process.exit(2);
}

type OutputFormat = "text" | "md" | "json";

type ParsedOptions = {
  sku: string | null;
  all: boolean;
  format: OutputFormat;
};

function parseFormat(value: string): OutputFormat {
  if (value === "text" || value === "md" || value === "json") return value;
  fail(`--format debe ser text|md|json (recibido: ${value})`);
}

function parseOptions(argv: string[]): ParsedOptions {
  const opts: ParsedOptions = { sku: null, all: false, format: "text" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--sku") {
      const value = argv[i + 1] ?? "";
      if (!value) fail("--sku requiere un valor");
      opts.sku = value;
      i++;
    } else if (arg === "--all") {
      opts.all = true;
    } else if (arg === "--format") {
      opts.format = parseFormat(argv[i + 1] ?? "");
      i++;
    } else {
      fail(`argumento desconocido: ${arg}`);
    }
  }
  return opts;
}

function parseArgs(argv: string[]): {
  skus: string[] | "all";
  format: OutputFormat;
} {
  const opts = parseOptions(argv);
  if (opts.all && opts.sku) fail("--sku y --all son excluyentes");
  if (!opts.all && !opts.sku) fail("indica --sku <SKU> o --all");
  if (opts.all) return { skus: "all", format: opts.format };
  return { skus: [opts.sku ?? ""], format: opts.format };
}

function loadJson<T>(path: string, label: string): T {
  if (!existsSync(path)) {
    console.error(`audit-catalog: no existe ${label}: ${path}`);
    process.exit(2);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    console.error(`audit-catalog: ${label} no es JSON válido: ${path}`);
    process.exit(2);
  }
}

function draftFiles(sku: string): string[] {
  const dir = join(DRAFTS_DIR, sku);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((file) =>
    /^draft-v\d+\.\d+\.\d+\.md$/.test(file),
  );
}

function reviewAgeMonths(iso: string): number | null {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  return (Date.now() - time) / (30 * 24 * 3600 * 1000);
}

function auditPresence(
  sku: string,
  seed: SeedProduct | undefined,
  entry: ManifestProduct | undefined,
  checks: Check[],
): boolean {
  if (!seed) {
    checks.push({
      name: "seed.exists",
      severity: "critical",
      detail: `SKU ausente en ${SEED_PATH}`,
    });
  } else {
    checks.push({
      name: "seed.exists",
      severity: "ok",
      detail: `${seed.price_cents} cts · ${seed.delivery_mode} · ${seed.eidas_level}`,
    });
  }
  if (!entry) {
    checks.push({
      name: "manifest.exists",
      severity: "critical",
      detail: `SKU ausente en ${MANIFEST_PATH}`,
    });
  } else {
    checks.push({
      name: "manifest.exists",
      severity: "ok",
      detail: `status=${entry.status} version=${entry.version}`,
    });
  }
  return Boolean(seed && entry);
}

function auditCoherence(
  seed: SeedProduct,
  entry: ManifestProduct,
  checks: Check[],
): void {
  if (!STATUSES.has(entry.status)) {
    checks.push({
      name: "manifest.status",
      severity: "critical",
      detail: `status desconocido: ${entry.status}`,
    });
  }
  // seed ↔ manifest: los IDs externos deben coincidir cuando existen.
  for (const field of ["stripe_price_id", "docuseal_template_id"] as const) {
    const seedValue = seed[field] ?? null;
    const manifestValue = entry[field] ?? null;
    if (seedValue !== manifestValue) {
      checks.push({
        name: `coherence.${field}`,
        severity: "critical",
        detail: `seed=${seedValue ?? "null"} ≠ manifest=${manifestValue ?? "null"}`,
      });
    } else {
      checks.push({
        name: `coherence.${field}`,
        severity: "ok",
        detail: `${manifestValue ?? "null"} en ambas fuentes`,
      });
    }
  }
}

function auditLiveGate(
  seed: SeedProduct,
  entry: ManifestProduct,
  checks: Check[],
): void {
  // Un SKU live exige IDs externos reales (nunca inventados) y seed activo.
  if (entry.status !== "live") {
    checks.push({
      name: "live.gate",
      severity: "ok",
      detail: `status=${entry.status} — gate live no aplica`,
    });
    return;
  }
  if (!entry.stripe_price_id) {
    checks.push({
      name: "live.stripe_price_id",
      severity: "critical",
      detail: "status=live sin stripe_price_id — no activar is_active",
    });
  }
  if (
    seed.delivery_mode.startsWith("docuseal_") &&
    !entry.docuseal_template_id
  ) {
    checks.push({
      name: "live.docuseal_template_id",
      severity: "critical",
      detail: "status=live con delivery DocuSeal sin docuseal_template_id",
    });
  }
  if (!seed.is_active) {
    checks.push({
      name: "live.is_active",
      severity: "warn",
      detail:
        "status=live pero seed is_active=false (la visibilidad live la da la BD, no el seed)",
    });
  }
}

function auditLegalReview(entry: ManifestProduct, checks: Check[]): void {
  if (!entry.legal_reviewed_at) {
    checks.push({
      name: "legal.review",
      severity: "warn",
      detail: "sin legal_reviewed_at — techo template_ready hasta firma humana",
    });
    return;
  }
  const age = reviewAgeMonths(entry.legal_reviewed_at);
  if (age === null) {
    checks.push({
      name: "legal.review",
      severity: "warn",
      detail: `legal_reviewed_at ilegible: ${entry.legal_reviewed_at}`,
    });
    return;
  }
  if (age > 12) {
    checks.push({
      name: "legal.review_age",
      severity: "critical",
      detail: `revisión de hace ${age.toFixed(1)} meses (> 12)`,
    });
    return;
  }
  if (age > 9) {
    checks.push({
      name: "legal.review_age",
      severity: "warn",
      detail: `revisión de hace ${age.toFixed(1)} meses (> 9)`,
    });
    return;
  }
  checks.push({
    name: "legal.review_age",
    severity: "ok",
    detail: `revisión de hace ${age.toFixed(1)} meses`,
  });
}

function auditDraftAndLegal(
  sku: string,
  entry: ManifestProduct,
  checks: Check[],
): void {
  const drafts = draftFiles(sku);
  if (drafts.length === 0) {
    checks.push({
      name: "draft.exists",
      severity: "critical",
      detail: `sin catalog/drafts/${sku}/draft-vX.Y.Z.md`,
    });
  } else {
    checks.push({
      name: "draft.exists",
      severity: "ok",
      detail: drafts.sort().join(", "),
    });
  }
  const notesPath = join(DRAFTS_DIR, sku, "notes-legal.md");
  if (!existsSync(notesPath)) {
    checks.push({
      name: "legal.notes",
      severity: "warn",
      detail:
        "sin notes-legal.md — pendiente QA jurídica humana [A] antes de live",
    });
  } else {
    checks.push({
      name: "legal.notes",
      severity: "ok",
      detail: "notes-legal.md presente",
    });
  }
  auditLegalReview(entry, checks);
}

function auditSkipped(checks: Check[]): void {
  // BD Prisma: solo si hay DATABASE_URL/DIRECT_URL; si no, skipped (PARTIAL).
  if (process.env.DATABASE_URL ?? process.env.DIRECT_URL) {
    checks.push({
      name: "bd.live",
      severity: "skipped",
      detail:
        "BD configurada pero la lectura live no está implementada en el auditor mínimo — verificar /ops/productos a mano",
    });
  } else {
    checks.push({
      name: "bd.live",
      severity: "skipped",
      detail:
        "sin DATABASE_URL/DIRECT_URL — checks de BD saltados (verificar /ops/productos a mano)",
    });
  }
  // APIs externas: fuera de alcance del auditor mínimo (verificación manual en dashboards).
  checks.push({
    name: "stripe.price",
    severity: "skipped",
    detail:
      "verificación manual en Stripe Dashboard (ver runbook primera-compra-test)",
  });
  checks.push({
    name: "docuseal.template",
    severity: "skipped",
    detail:
      "verificación manual en DocuSeal UI (ver runbook primera-compra-test)",
  });
}

function computeVerdict(checks: Check[]): SkuReport["verdict"] {
  if (checks.some((check) => check.severity === "critical")) return "BLOCK";
  if (checks.some((check) => check.severity === "warn")) return "WARN";
  if (checks.some((check) => check.severity === "skipped")) return "PARTIAL";
  return "READY";
}

function auditSku(
  sku: string,
  seedBySku: Map<string, SeedProduct>,
  manifestBySku: Map<string, ManifestProduct>,
): SkuReport {
  const checks: Check[] = [];
  const seed = seedBySku.get(sku);
  const entry = manifestBySku.get(sku);

  if (!auditPresence(sku, seed, entry, checks)) {
    return { sku, verdict: "BLOCK", checks };
  }
  const presentSeed = seed as SeedProduct;
  const presentEntry = entry as ManifestProduct;
  auditCoherence(presentSeed, presentEntry, checks);
  auditLiveGate(presentSeed, presentEntry, checks);
  auditDraftAndLegal(sku, presentEntry, checks);
  auditSkipped(checks);
  return { sku, verdict: computeVerdict(checks), checks };
}

function verdictIcon(verdict: SkuReport["verdict"]): string {
  if (verdict === "BLOCK") return "❌";
  if (verdict === "WARN") return "🟡";
  if (verdict === "PARTIAL") return "⏭️";
  return "✅";
}

function renderText(reports: SkuReport[]): string {
  const lines: string[] = [];
  for (const report of reports) {
    lines.push(
      `${verdictIcon(report.verdict)} ${report.sku} → ${report.verdict}`,
    );
    for (const check of report.checks) {
      lines.push(`   [${check.severity}] ${check.name}: ${check.detail}`);
    }
  }
  return lines.join("\n");
}

function renderMd(reports: SkuReport[]): string {
  const lines: string[] = ["# Audit catálogo", ""];
  for (const report of reports) {
    lines.push(`## ${report.sku} → ${report.verdict}`, "");
    lines.push("| Check | Severidad | Detalle |", "|---|---|---|");
    for (const check of report.checks) {
      lines.push(`| \`${check.name}\` | ${check.severity} | ${check.detail} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function main(): void {
  const { skus, format } = parseArgs(process.argv.slice(2));
  const seed = loadJson<SeedProduct[]>(SEED_PATH, "seed");
  const manifest = loadJson<{ products: ManifestProduct[] }>(
    MANIFEST_PATH,
    "manifest",
  );

  const seedBySku = new Map(seed.map((product) => [product.sku, product]));
  const manifestBySku = new Map(
    manifest.products.map((product) => [product.sku, product]),
  );

  const wanted =
    skus === "all" ? manifest.products.map((product) => product.sku) : skus;
  for (const sku of wanted) {
    if (!manifestBySku.has(sku) && !seedBySku.has(sku)) {
      fail(`SKU desconocido: ${sku}`);
    }
  }

  const reports = wanted.map((sku) => auditSku(sku, seedBySku, manifestBySku));
  if (format === "json") {
    console.log(
      JSON.stringify({ ts: new Date().toISOString(), reports }, null, 2),
    );
  } else if (format === "md") {
    console.log(renderMd(reports));
  } else {
    console.log(renderText(reports));
  }

  if (reports.some((report) => report.verdict === "BLOCK")) process.exit(1);
}

main();

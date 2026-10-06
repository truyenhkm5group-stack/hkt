/**
 * ═══════════ SỔ DÙNG + SỔ CHI PHÍ — CHỈ MÁY CHỦ (docs/saas/USAGE.md, docs/saas/COST_BILLING.md) ═══════════
 *
 * Một chỉ số — một nguồn (khai ở `lib/saas/catalog.ts::ProductMetric.source`):
 *  · `AI_LEDGER` → `platform_ai_usage` (đường ghi duy nhất `recordAiUsage`, không đổi);
 *  · `DAILY_SNAPSHOT` → `platform_tenant_usage_daily` (0204, đếm từ chứng từ trong CSDL workspace);
 *  · `EVENT_LEDGER` → `platform_usage_events` (đường ghi duy nhất `recordUsage` ở tệp này).
 * Thô và gộp tách rời: sổ sự kiện là dòng thô chỉ thêm; `readProductUsage` gộp lúc đọc, không ghi bảng gộp thứ hai.
 *
 * Chi phí: AI (`platform_ai_usage.cost_usd`, nguồn PLATFORM + HOME = tiền nền tảng trả; BYOK là tiền của khách — in riêng,
 * không trừ vào biên của nền tảng) + khai nền theo tháng (0203) + `platform_cost_entries`. Không khoản nào có hai nguồn.
 */
import { and, asc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { env } from "@/lib/env";
import { platformAudit, type PlatformActor } from "@/lib/platform/audit";
import { getHomeOrganization } from "@/lib/platform/organizations";
import { readCostDeclaration } from "@/lib/platform/saas-ledger";
import type { AllocEntry, AllocationBasis, CostScope } from "@/lib/saas/allocation";
import { PRODUCTS, productDef, productOfAiFeature, type ProductDef } from "@/lib/saas/catalog";
import { isPeriodMonth } from "@/lib/saas/statement";

// ─────────────────────────── Kỳ ───────────────────────────

/** Kỳ tháng lịch giờ VN `[from, to)` từ `YYYY-MM-01` — trùng kỳ credit AI và kỳ hạn mức (lib/pricing/meter.ts). */
export function periodRange(periodMonth: string): { from: Date; to: Date; fromDay: string; toDay: string } {
  if (!isPeriodMonth(periodMonth)) throw new Error(`Kỳ "${periodMonth}" phải có dạng YYYY-MM-01.`);
  const [y, m] = periodMonth.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1) - 7 * 3_600_000);
  const to = new Date(Date.UTC(y, m, 1) - 7 * 3_600_000);
  const last = new Date(Date.UTC(y, m, 0));
  return { from, to, fromDay: periodMonth, toDay: last.toISOString().slice(0, 10) };
}

export function currentPeriodMonth(now: Date = new Date()): string {
  const vn = new Date(now.getTime() + 7 * 3_600_000);
  return `${vn.getUTCFullYear()}-${String(vn.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export function usdToVnd(usd: number): number {
  return Math.round(usd * env.facebook.usdToVnd);
}

// ─────────────────────────── Sổ dùng chung ───────────────────────────

export type UsageInput = {
  orgCode: string;
  productKey: string;
  metric: string;
  quantity: number;
  occurredAt?: Date;
  /** Khoá idempotent ỔN ĐỊNH của sự việc (vd `order:<id>:created`) — gửi lại cùng khoá không ghi dòng thứ hai. */
  eventKey: string;
  correlationId?: string | null;
  source: string;
  metadata?: Record<string, unknown>;
};

/**
 * ĐƯỜNG GHI DUY NHẤT của `platform_usage_events`. Chỉ nhận chỉ số sản phẩm KHAI nguồn `EVENT_LEDGER` (chỉ số AI đã có sổ
 * riêng — ghi lần hai ở đây là đếm hai lần). Tài khoản + thuê bao lấy ở MÁY CHỦ từ workspace, không nhận từ người gọi.
 */
export async function recordUsage(input: UsageInput, catalog: readonly ProductDef[] = PRODUCTS): Promise<{ recorded: boolean }> {
  const product = productDef(input.productKey, catalog);
  if (!product) throw new Error(`Sản phẩm "${input.productKey}" không có trong danh mục.`);
  const metric = product.metrics.find((m) => m.key === input.metric);
  if (!metric) throw new Error(`Chỉ số "${input.metric}" không khai cho sản phẩm ${product.key}.`);
  if (metric.source !== "EVENT_LEDGER") throw new Error(`Chỉ số ${product.key}.${metric.key} có nguồn ${metric.source} — không ghi vào sổ dùng chung.`);
  if (!Number.isInteger(input.quantity) || input.quantity < 0) throw new Error("Số lượng phải là số nguyên không âm.");
  if (!input.eventKey?.trim() || input.eventKey.length > 200) throw new Error("Thiếu khoá sự kiện (1–200 ký tự).");
  const pdb = await getPlatformDb();
  const org = await pdb.select({ accountId: schema.platformOrganizations.accountId }).from(schema.platformOrganizations).where(eq(schema.platformOrganizations.code, input.orgCode)).limit(1);
  if (!org.length) throw new Error(`Không có workspace "${input.orgCode}".`);
  const sub = await pdb
    .select({ id: schema.platformProductSubscriptions.id })
    .from(schema.platformProductSubscriptions)
    .where(and(eq(schema.platformProductSubscriptions.orgCode, input.orgCode), eq(schema.platformProductSubscriptions.productKey, product.key), isNull(schema.platformProductSubscriptions.endedAt)))
    .limit(1);
  const rows = await pdb
    .insert(schema.platformUsageEvents)
    .values({
      occurredAt: input.occurredAt ?? new Date(),
      accountId: org[0].accountId,
      orgCode: input.orgCode,
      productKey: product.key,
      subscriptionId: sub[0]?.id ?? null,
      metric: metric.key,
      quantity: input.quantity,
      unit: metric.unit,
      source: input.source,
      eventKey: input.eventKey.trim(),
      correlationId: input.correlationId ?? null,
      metadata: input.metadata ?? {},
    })
    .onConflictDoNothing()
    .returning({ id: schema.platformUsageEvents.id });
  return { recorded: rows.length > 0 };
}

/** Giá trị một chỉ số: `null` = CHƯA ĐO (nguồn chưa có đường ghi / không đọc được), khác 0. */
export type MetricReading = { productKey: string; metric: string; label: string; unit: string; source: string; value: number | null; note: string | null };

type AiAgg = { requests: number; costUsd: number; unpriced: number };

/** Sổ AI của kỳ theo (workspace, sản phẩm, nguồn trả tiền). Khoá feature chưa gán sản phẩm ⇒ sản phẩm `null`. */
export async function readAiByWorkspaceProduct(periodMonth: string, catalog: readonly ProductDef[] = PRODUCTS): Promise<Map<string, Map<string | null, { platform: AiAgg; byok: AiAgg }>>> {
  const { from, to } = periodRange(periodMonth);
  const pdb = await getPlatformDb();
  const a = schema.platformAiUsage;
  const rows = await pdb
    .select({
      orgCode: a.orgCode,
      feature: a.feature,
      source: a.billingSource,
      requests: sql<number>`coalesce(sum(${a.requests}), 0)::int`,
      costUsd: sql<number>`coalesce(sum(${a.costUsd}), 0)::float8`,
      unpriced: sql<number>`coalesce(sum(${a.requests}) filter (where ${a.costUsd} is null and ${a.status} = 'OK'), 0)::int`,
    })
    .from(a)
    .where(and(gte(a.at, from), lt(a.at, to)))
    .groupBy(a.orgCode, a.feature, a.billingSource);
  const out = new Map<string, Map<string | null, { platform: AiAgg; byok: AiAgg }>>();
  for (const r of rows) {
    const product = productOfAiFeature(r.feature, catalog);
    const byProduct = out.get(r.orgCode) ?? new Map();
    out.set(r.orgCode, byProduct);
    const cell = byProduct.get(product) ?? { platform: { requests: 0, costUsd: 0, unpriced: 0 }, byok: { requests: 0, costUsd: 0, unpriced: 0 } };
    byProduct.set(product, cell);
    const b = r.source === "BYOK" ? cell.byok : cell.platform;
    b.requests += Number(r.requests);
    b.costUsd += Number(r.costUsd);
    b.unpriced += Number(r.unpriced);
  }
  return out;
}

/** Mọi chỉ số khai của mọi sản phẩm cho mọi workspace trong kỳ, mỗi chỉ số đọc ĐÚNG nguồn khai của nó. */
export async function readProductUsage(periodMonth: string, catalog: readonly ProductDef[] = PRODUCTS): Promise<Map<string, MetricReading[]>> {
  const { from, to, fromDay, toDay } = periodRange(periodMonth);
  const pdb = await getPlatformDb();
  const u = schema.platformTenantUsageDaily;
  const e = schema.platformUsageEvents;
  const [snap, events, ai, orgs] = await Promise.all([
    pdb
      .select({
        orgCode: u.orgCode,
        days: sql<number>`count(*)::int`,
        conversationsStarted: sql<number>`coalesce(sum(${u.conversationsStarted}), 0)::int`,
        customerMessages: sql<number>`coalesce(sum(${u.customerMessages}), 0)::int`,
        botMessages: sql<number>`coalesce(sum(${u.botMessages}), 0)::int`,
        aiOrders: sql<number>`coalesce(sum(${u.aiOrders}), 0)::int`,
      })
      .from(u)
      .where(and(gte(u.day, fromDay), sql`${u.day} <= ${toDay}`))
      .groupBy(u.orgCode),
    pdb
      .select({ orgCode: e.orgCode, productKey: e.productKey, metric: e.metric, qty: sql<number>`coalesce(sum(${e.quantity}), 0)::bigint` })
      .from(e)
      .where(and(gte(e.occurredAt, from), lt(e.occurredAt, to)))
      .groupBy(e.orgCode, e.productKey, e.metric),
    readAiByWorkspaceProduct(periodMonth, catalog),
    pdb.select({ code: schema.platformOrganizations.code }).from(schema.platformOrganizations),
  ]);
  const snapBy = new Map(snap.map((r) => [r.orgCode, r]));
  const evBy = new Map(events.map((r) => [`${r.orgCode}|${r.productKey}|${r.metric}`, Number(r.qty)]));
  const out = new Map<string, MetricReading[]>();
  for (const { code } of orgs) {
    const list: MetricReading[] = [];
    for (const p of catalog)
      for (const m of p.metrics) {
        const base = { productKey: p.key, metric: m.key, label: m.label, unit: m.unit, source: m.source };
        if (m.source === "DAILY_SNAPSHOT") {
          const s = snapBy.get(code);
          list.push({ ...base, value: s && m.snapshotColumn ? Number(s[m.snapshotColumn]) : null, note: s ? `cộng ${s.days} ngày đã chụp` : "chưa có ngày nào được chụp" });
        } else if (m.source === "AI_LEDGER") {
          const cell = ai.get(code)?.get(p.key);
          const agg = cell ? { requests: cell.platform.requests + cell.byok.requests, costUsd: cell.platform.costUsd + cell.byok.costUsd, unpriced: cell.platform.unpriced + cell.byok.unpriced } : { requests: 0, costUsd: 0, unpriced: 0 };
          const v = m.aiMeasure === "costUsd" ? agg.costUsd : agg.requests;
          list.push({ ...base, value: v, note: m.aiMeasure === "costUsd" && agg.unpriced ? `${agg.unpriced} lượt chưa định giá — cận dưới` : null });
        } else {
          list.push({ ...base, value: m.emitterLive ? (evBy.get(`${code}|${p.key}|${m.key}`) ?? 0) : null, note: m.emitterLive ? null : "chưa có đường ghi trên production" });
        }
      }
    out.set(code, list);
  }
  return out;
}

// ─────────────────────────── Sổ chi phí ngoài AI ───────────────────────────

export const COST_CATEGORIES = ["EXTERNAL_API", "MESSAGING", "STORAGE", "INFRA_DIRECT", "OTHER"] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];
export const COST_CATEGORY_LABEL: Record<CostCategory, string> = { EXTERNAL_API: "API ngoài", MESSAGING: "Tin nhắn / kênh", STORAGE: "Lưu trữ / media", INFRA_DIRECT: "Hạ tầng riêng", OTHER: "Khác" };

export type CostEntryInput = { periodMonth: string; category: CostCategory; scope: CostScope; productKey?: string | null; accountId?: string | null; orgCode?: string | null; basis: AllocationBasis; amountVnd: number; description: string; entryKey?: string | null };

export async function addCostEntry(input: CostEntryInput, ctx: { actor: PlatformActor; email: string | null; reason: string; source: "UI" | "SCRIPT" | "TEST" }): Promise<{ id: string; created: boolean }> {
  if (!isPeriodMonth(input.periodMonth)) throw new Error("Kỳ phải có dạng YYYY-MM-01.");
  if (!Number.isInteger(input.amountVnd) || input.amountVnd <= 0) throw new Error("Số tiền phải là số nguyên VND dương.");
  if (input.description.trim().length < 3) throw new Error("Mô tả khoản chi cần ít nhất 3 ký tự.");
  if (input.scope === "PRODUCT" && !productDef(input.productKey ?? "")) throw new Error("Sản phẩm không có trong danh mục.");
  const key = input.entryKey?.trim() || `${input.periodMonth}:${input.category}:${input.scope}:${input.productKey ?? input.accountId ?? input.orgCode ?? "all"}:${input.description.trim().toLowerCase()}`;
  const pdb = await getPlatformDb();
  const values = {
    periodMonth: input.periodMonth,
    category: input.category,
    scope: input.scope,
    productKey: input.scope === "PRODUCT" ? (input.productKey ?? null) : input.scope === "PLATFORM" ? null : (input.productKey ?? null),
    accountId: input.scope === "ACCOUNT" || input.scope === "WORKSPACE" ? (input.accountId ?? null) : null,
    orgCode: input.scope === "WORKSPACE" ? (input.orgCode ?? null) : null,
    allocationBasis: input.scope === "WORKSPACE" ? "DIRECT" : input.basis,
    amountVnd: input.amountVnd,
    description: input.description.trim(),
    entryKey: key.slice(0, 200),
    createdByEmail: ctx.email,
  };
  if (values.scope === "PRODUCT") values.productKey = input.productKey ?? null;
  const [row] = await pdb.insert(schema.platformCostEntries).values(values).onConflictDoNothing().returning({ id: schema.platformCostEntries.id });
  if (!row) {
    const existing = await pdb.query.platformCostEntries.findFirst({ where: eq(schema.platformCostEntries.entryKey, values.entryKey), columns: { id: true } });
    return { id: existing?.id ?? "", created: false };
  }
  const home = await getHomeOrganization();
  await platformAudit({ action: "COST_ENTRY_ADD", targetOrgCode: values.orgCode ?? home.code, targetAccountId: values.accountId, subject: `cost:${values.periodMonth}:${values.category}`, after: values, reason: ctx.reason, source: ctx.source, actor: ctx.actor });
  return { id: row.id, created: true };
}

export async function voidCostEntry(id: string, ctx: { actor: PlatformActor; reason: string; source: "UI" | "SCRIPT" | "TEST" }): Promise<void> {
  if (ctx.reason.trim().length < 3) throw new Error("Huỷ khoản chi cần lý do.");
  const pdb = await getPlatformDb();
  const [row] = await pdb
    .update(schema.platformCostEntries)
    .set({ voidedAt: new Date(), voidReason: ctx.reason.trim() })
    .where(and(eq(schema.platformCostEntries.id, id), isNull(schema.platformCostEntries.voidedAt)))
    .returning();
  if (!row) throw new Error("Khoản chi không có hoặc đã huỷ.");
  const home = await getHomeOrganization();
  await platformAudit({ action: "COST_ENTRY_VOID", targetOrgCode: row.orgCode ?? home.code, targetAccountId: row.accountId, subject: `cost:${row.periodMonth}:${row.category}`, before: { amountVnd: row.amountVnd, description: row.description }, reason: ctx.reason, source: ctx.source, actor: ctx.actor });
}

export async function listCostEntries(periodMonth: string): Promise<(typeof schema.platformCostEntries.$inferSelect)[]> {
  const pdb = await getPlatformDb();
  return pdb.select().from(schema.platformCostEntries).where(eq(schema.platformCostEntries.periodMonth, periodMonth)).orderBy(asc(schema.platformCostEntries.createdAt));
}

/** Đầu vào phân bổ của kỳ: khai nền + dòng chưa huỷ. */
export async function costInputs(periodMonth: string): Promise<{ declared: { infraMonthlyVnd: number | null; supportMonthlyVnd: number | null }; entries: AllocEntry[] }> {
  const [declared, rows] = await Promise.all([readCostDeclaration(), listCostEntries(periodMonth)]);
  return {
    declared: { infraMonthlyVnd: declared.infraMonthlyVnd, supportMonthlyVnd: declared.supportMonthlyVnd },
    entries: rows
      .filter((r) => !r.voidedAt)
      .map((r) => ({ id: r.id, label: `${COST_CATEGORY_LABEL[r.category as CostCategory] ?? r.category}: ${r.description}`, category: r.category, scope: r.scope as CostScope, productKey: r.productKey, accountId: r.accountId, orgCode: r.orgCode, basis: r.allocationBasis as AllocationBasis, amountVnd: Number(r.amountVnd) })),
  };
}

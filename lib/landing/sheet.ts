/**
 * Nhập đơn landing page từ Google Sheet (CSV export) → bảng landing_orders:
 *  - dò cột theo tiêu đề (ghi đè được trong cấu hình), khoá dòng <gid>:<số dòng> nên chạy lại không tạo trùng;
 *  - ghép mẫu mã Pancake theo text sản phẩm / size / màu; đánh dấu trùng SĐT (landing khác, đơn Pancake) trong N ngày;
 *  - chấm rủi ro hoàn theo lịch sử khách (Pancake customers + vận đơn ERP cùng SĐT) — cùng quy tắc với cảnh báo đơn rủi ro;
 *  - tự ghép với đơn Pancake cùng SĐT lên sau thời điểm đặt (để theo dõi trạng thái giao / hoàn / huỷ).
 */
import { and, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { assessCustomerRisk, erpHistoryByPhone, type RiskAssessment } from "@/lib/alerts/risk";
import { loadAlertConfig } from "@/lib/alerts/config";
import { clearMemo } from "@/lib/cache";
import { DEFAULT_LANDING_CONFIG, detectColumns, detectColumnsByContent, LANDING_CONFIG_KEY, looksLikeHeader, matchVariant, parseCsv, rowToLanding, sheetCsvUrl, type DuplicateHit, type LandingColumnKey, type LandingConfig, type VariantCandidate } from "@/lib/constants/landing";
import { fetchJson } from "@/lib/integrations/http";
import { getSettingJson } from "@/lib/settings";

export async function loadLandingConfig(): Promise<LandingConfig> {
  const cfg = await getSettingJson<Partial<LandingConfig>>(LANDING_CONFIG_KEY, DEFAULT_LANDING_CONFIG);
  return {
    ...DEFAULT_LANDING_CONFIG,
    ...cfg,
    columns: cfg.columns && typeof cfg.columns === "object" ? cfg.columns : {},
    hasHeader: cfg.hasHeader === "yes" || cfg.hasHeader === "no" ? cfg.hasHeader : "auto",
    dedupeDays: Number(cfg.dedupeDays) > 0 ? Number(cfg.dedupeDays) : 7,
    shippingFee: Number.isFinite(Number(cfg.shippingFee)) ? Number(cfg.shippingFee) : 25_000,
  };
}

export type SheetPreview = { url: string; headers: string[]; detected: Partial<Record<LandingColumnKey, string>>; sample: string[][]; rows: number; hasHeader: boolean };

/** Tải CSV và trả về tiêu đề + cột đã dò + vài dòng mẫu (SĐT che bớt) — để kiểm tra cấu hình */
export async function previewSheet(cfg?: LandingConfig): Promise<SheetPreview> {
  const config = cfg ?? (await loadLandingConfig());
  if (!config.sheetUrl) throw new Error("Chưa cấu hình link Google Sheet (Đơn landing page → Cấu hình)");
  const url = sheetCsvUrl(config.sheetUrl, config.gid);
  const { text } = await fetchJson(url, { serviceName: "Google Sheet", timeoutMs: 60_000, retries: 2 }).catch(async (e: unknown) => {
    // fetchJson bắt lỗi JSON parse với CSV → tự tải thô
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: "follow" });
    if (!res.ok) throw new Error(`Không tải được sheet (HTTP ${res.status}). Sheet cần chia sẻ "Bất kỳ ai có liên kết – Người xem". ${e instanceof Error ? e.message : ""}`);
    return { text: await res.text(), body: null, status: res.status };
  });
  if (/<html/i.test(text.slice(0, 200))) throw new Error("Google trả về trang HTML thay vì CSV: sheet chưa chia sẻ công khai (Bất kỳ ai có liên kết – Người xem) hoặc link sai.");
  const rows = parseCsv(text);
  if (!rows.length) throw new Error("Sheet rỗng");
  const { headers, cols, dataStart, hasHeader } = resolveColumns(rows, config);
  const detected: Partial<Record<LandingColumnKey, string>> = {};
  for (const [k, idx] of Object.entries(cols) as [LandingColumnKey, number][]) detected[k] = hasHeader ? headers[idx] : `#${idx + 1}`;
  const phoneIdx = cols.phone;
  const sample = rows.slice(dataStart, dataStart + 5).map((r) => r.map((v, i) => (i === phoneIdx ? v.replace(/(\d{2})\d{4}(\d{2,3})/, "$1****$2") : v.slice(0, 60))));
  return { url, headers, detected, sample, rows: rows.length - dataStart, hasHeader };
}

/** Xác định tiêu đề (có / không) và bản đồ cột: tiêu đề → theo tên; không tiêu đề → theo nội dung; ghi đè "#n" luôn thắng */
export function resolveColumns(rows: string[][], config: LandingConfig) {
  const hasHeader = config.hasHeader === "yes" ? true : config.hasHeader === "no" ? false : looksLikeHeader(rows[0]);
  const width = Math.max(...rows.slice(0, 20).map((r) => r.length));
  const headers = hasHeader ? rows[0].map((h) => h.trim()) : Array.from({ length: width }, (_, i) => `Cột ${i + 1}`);
  const dataStart = hasHeader ? 1 : 0;
  const base = hasHeader ? detectColumns(headers, config.columns) : detectColumnsByContent(rows);
  // ghi đè trong cấu hình áp cho cả hai trường hợp
  const overrides = detectColumns(headers, config.columns);
  const cols: Partial<Record<LandingColumnKey, number>> = { ...base };
  for (const [k, idx] of Object.entries(overrides) as [LandingColumnKey, number][]) if (config.columns[k]) cols[k] = idx;
  return { headers, cols, dataStart, hasHeader };
}

async function variantCandidates(): Promise<VariantCandidate[]> {
  const db = await getDb();
  const rows = await db
    .select({ id: schema.productVariants.id, productId: schema.productVariants.productId, productName: schema.products.name, productCode: schema.products.customId, sku: schema.productVariants.sku, size: schema.productVariants.size, color: schema.productVariants.color })
    .from(schema.productVariants)
    .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
    .where(and(eq(schema.productVariants.isRemoved, false)));
  return rows.map((r) => ({ id: r.id, productId: r.productId, productName: r.productName ?? "", productCode: r.productCode ?? "", sku: r.sku ?? "", size: r.size ?? "", color: r.color ?? "" }));
}

/** Lịch sử khách theo SĐT: Pancake customers (số GTC / hoàn tại shop) + vận đơn ERP → chấm rủi ro */
export async function riskForPhone(phone: string, excludeOrderId?: string): Promise<RiskAssessment> {
  const db = await getDb();
  const cfg = await loadAlertConfig();
  const [cust] = phone
    ? await db
        .select({ succeed: sql<number>`coalesce(max(${schema.customers.succeedOrderCount}), 0)`, returned: sql<number>`coalesce(max(${schema.customers.returnedOrderCount}), 0)`, isBlock: sql<boolean>`bool_or(${schema.customers.isBlock})` })
        .from(schema.customers)
        .where(or(eq(schema.customers.phone, phone), sql`${phone} = any(${schema.customers.phones})`))
    : [null];
  const erp = phone ? await erpHistoryByPhone([phone], excludeOrderId) : { delivered: 0, returned: 0 };
  return assessCustomerRisk({ succeed: Number(cust?.succeed ?? 0), returned: Number(cust?.returned ?? 0), isBlock: Boolean(cust?.isBlock), erpDelivered: erp.delivered, erpReturned: erp.returned }, { riskMinReturned: cfg.riskMinReturned, riskReturnRatePct: cfg.riskReturnRatePct });
}

/** Trùng SĐT: landing khác trong N ngày (trước / sau) và đơn Pancake cùng SĐT trong N ngày quanh thời điểm đặt */
export async function duplicatesForPhone(phone: string, at: Date, days: number, excludeLandingId?: string): Promise<DuplicateHit[]> {
  if (!phone) return [];
  const db = await getDb();
  const from = new Date(at.getTime() - days * 86_400_000);
  const to = new Date(at.getTime() + days * 86_400_000);
  const [landings, orders] = await Promise.all([
    db
      .select({ id: schema.landingOrders.id, rowIndex: schema.landingOrders.rowIndex, at: schema.landingOrders.submittedAt, status: schema.landingOrders.status, product: schema.landingOrders.productText })
      .from(schema.landingOrders)
      .where(and(eq(schema.landingOrders.phone, phone), excludeLandingId ? ne(schema.landingOrders.id, excludeLandingId) : sql`true`, gte(sql`coalesce(${schema.landingOrders.submittedAt}, ${schema.landingOrders.createdAt})`, from), lte(sql`coalesce(${schema.landingOrders.submittedAt}, ${schema.landingOrders.createdAt})`, to)))
      .limit(10),
    db
      .select({ id: schema.orders.id, systemId: schema.orders.systemId, at: schema.orders.insertedAt, stage: schema.orders.stage, source: schema.orders.source })
      .from(schema.orders)
      .where(and(eq(schema.orders.billPhone, phone), gte(schema.orders.insertedAt, from), lte(schema.orders.insertedAt, to), sql`${schema.orders.stage} not in ('DELETED')`))
      .orderBy(desc(schema.orders.insertedAt))
      .limit(10),
  ]);
  return [
    ...landings.map((l) => ({ kind: "LANDING" as const, id: l.id, label: `Landing dòng ${l.rowIndex} · ${l.product || "?"} · ${l.status}`, at: l.at })),
    ...orders.map((o) => ({ kind: "PANCAKE" as const, id: o.id, label: `Đơn Pancake #${o.systemId ?? ""} · ${o.stage} · ${o.source}`, at: o.at })),
  ];
}

export type LandingImportResult = { url: string; rows: number; inserted: number; updated: number; skipped: number; matchedVariants: number; duplicates: number; risky: number; linked: number; errors: string[] };

/** Nhập / cập nhật từ sheet. onlyNew: chỉ xử lý dòng chưa có trong ERP (mặc định cập nhật cả dòng cũ nếu nội dung đổi) */
export async function importLandingSheet(options: { log?: (m: string) => void; onlyNew?: boolean } = {}): Promise<LandingImportResult> {
  const log = options.log ?? (() => undefined);
  const db = await getDb();
  const config = await loadLandingConfig();
  const preview = await previewSheet(config);
  const text = await (await fetch(preview.url, { signal: AbortSignal.timeout(60_000), redirect: "follow" })).text();
  const rows = parseCsv(text);
  const { headers, cols, dataStart } = resolveColumns(rows, config);
  const gid = config.gid || /[#&?]gid=(\d+)/.exec(config.sheetUrl)?.[1] || "0";
  const result: LandingImportResult = { url: preview.url, rows: rows.length - dataStart, inserted: 0, updated: 0, skipped: 0, matchedVariants: 0, duplicates: 0, risky: 0, linked: 0, errors: [] };
  if (cols.phone === undefined && cols.name === undefined) {
    result.errors.push(`Không dò được cột SĐT / tên khách. Tiêu đề sheet: ${headers.join(" | ")}. Khai báo tên cột ở Cấu hình.`);
    return result;
  }
  const candidates = await variantCandidates();
  const existing = new Map((await db.select({ id: schema.landingOrders.id, rowKey: schema.landingOrders.rowKey, raw: schema.landingOrders.raw, status: schema.landingOrders.status, variantId: schema.landingOrders.variantId, orderId: schema.landingOrders.orderId, phone: schema.landingOrders.phone }).from(schema.landingOrders).where(eq(schema.landingOrders.sheetGid, gid))).map((r) => [r.rowKey, r]));
  for (let i = dataStart; i < rows.length; i++) {
    const parsed = rowToLanding(headers, rows[i], cols, i + (dataStart ? 0 : 1));
    if (!parsed) {
      result.skipped += 1;
      continue;
    }
    const rowKey = `${gid}:${i + (dataStart ? 0 : 1)}`;
    const prev = existing.get(rowKey);
    if (prev && options.onlyNew) {
      result.skipped += 1;
      continue;
    }
    if (prev && JSON.stringify(prev.raw ?? {}) === JSON.stringify(parsed.raw)) {
      result.skipped += 1;
      continue;
    }
    const match = matchVariant({ product: parsed.product, variant: parsed.variant, size: parsed.size, color: parsed.color }, candidates);
    if (match) result.matchedVariants += 1;
    const at = parsed.time ?? new Date();
    const base = {
      sheetGid: gid,
      rowIndex: parsed.rowIndex,
      submittedAt: parsed.time,
      customerName: parsed.name,
      phone: parsed.phone,
      address: parsed.address,
      province: parsed.province,
      productText: parsed.product,
      variantText: parsed.variant,
      sizeText: parsed.size,
      colorText: parsed.color,
      quantity: parsed.quantity,
      price: parsed.price,
      total: parsed.total,
      note: parsed.note,
      source: parsed.source,
      adId: parsed.adId || null,
      sheetStatus: parsed.sheetStatus,
      raw: parsed.raw,
      updatedAt: new Date(),
    };
    if (prev) {
      await db
        .update(schema.landingOrders)
        .set({ ...base, ...(prev.variantId ? {} : { variantId: match?.variant.id ?? null, variantMatchScore: match?.score ?? 0 }) })
        .where(eq(schema.landingOrders.id, prev.id));
      result.updated += 1;
      continue;
    }
    const [row] = await db
      .insert(schema.landingOrders)
      .values({ rowKey, ...base, status: "NEW", variantId: match?.variant.id ?? null, variantMatchScore: match?.score ?? 0 })
      .onConflictDoNothing({ target: schema.landingOrders.rowKey })
      .returning({ id: schema.landingOrders.id });
    if (!row) {
      result.skipped += 1;
      continue;
    }
    result.inserted += 1;
    // trùng / rủi ro / ghép đơn Pancake cho dòng mới
    const [dups, risk] = await Promise.all([duplicatesForPhone(parsed.phone, at, config.dedupeDays, row.id), riskForPhone(parsed.phone)]);
    const linked = dups.find((d) => d.kind === "PANCAKE" && d.at && d.at.getTime() >= at.getTime() - 3_600_000);
    if (dups.length) result.duplicates += 1;
    if (risk.risky) result.risky += 1;
    if (linked) result.linked += 1;
    await db
      .update(schema.landingOrders)
      .set({ duplicates: dups, risk, ...(linked ? { orderId: linked.id } : {}) })
      .where(eq(schema.landingOrders.id, row.id));
    log(`Dòng ${parsed.rowIndex}: ${parsed.name} ${parsed.phone} · ${parsed.product} → ${match ? `mẫu ${match.variant.productCode} ${match.variant.size} ${match.variant.color}` : "chưa ghép mẫu mã"}${dups.length ? ` · trùng ${dups.length}` : ""}${risk.risky ? " · RỦI RO" : ""}`);
  }
  // các dòng chưa gắn đơn Pancake: thử ghép lại theo SĐT (khách được lên đơn sau khi nhân viên gọi chốt)
  const unlinked = await db
    .select({ id: schema.landingOrders.id, phone: schema.landingOrders.phone, at: schema.landingOrders.submittedAt, createdAt: schema.landingOrders.createdAt })
    .from(schema.landingOrders)
    .where(and(isNull(schema.landingOrders.orderId), inArray(schema.landingOrders.status, ["NEW", "CONFIRMED", "PUSHED"]), sql`${schema.landingOrders.phone} <> ''`, gte(schema.landingOrders.createdAt, new Date(Date.now() - 30 * 86_400_000))));
  for (const l of unlinked) {
    const at = l.at ?? l.createdAt;
    const [o] = await db
      .select({ id: schema.orders.id })
      .from(schema.orders)
      .where(and(eq(schema.orders.billPhone, l.phone), gte(schema.orders.insertedAt, new Date(at.getTime() - 3_600_000)), lte(schema.orders.insertedAt, new Date(at.getTime() + config.dedupeDays * 86_400_000)), sql`${schema.orders.stage} not in ('DELETED')`))
      .orderBy(schema.orders.insertedAt)
      .limit(1);
    if (o) {
      await db.update(schema.landingOrders).set({ orderId: o.id, updatedAt: new Date() }).where(eq(schema.landingOrders.id, l.id));
      result.linked += 1;
    }
  }
  clearMemo();
  return result;
}

/** Tính lại trùng + rủi ro cho một dòng (sau khi sửa / trước khi gửi POS) */
export async function refreshLandingChecks(id: string) {
  const db = await getDb();
  const config = await loadLandingConfig();
  const row = await db.query.landingOrders.findFirst({ where: eq(schema.landingOrders.id, id) });
  if (!row) return null;
  const at = row.submittedAt ?? row.createdAt;
  const [dups, risk] = await Promise.all([duplicatesForPhone(row.phone, at, config.dedupeDays, row.id), riskForPhone(row.phone, row.orderId ?? undefined)]);
  await db.update(schema.landingOrders).set({ duplicates: dups, risk, updatedAt: new Date() }).where(eq(schema.landingOrders.id, id));
  return { duplicates: dups, risk };
}

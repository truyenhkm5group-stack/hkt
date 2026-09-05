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
import { DEFAULT_LANDING_CONFIG, detectColumns, detectColumnsByContent, isGenericHeader, LANDING_CONFIG_KEY, looksLikeHeader, matchVariant, parseCsv, rowToLanding, sheetTabs, type DuplicateHit, type LandingColumnKey, type LandingConfig, type VariantCandidate } from "@/lib/constants/landing";
import { fetchJson } from "@/lib/integrations/http";
import { getSettingJson } from "@/lib/settings";

export async function loadLandingConfig(): Promise<LandingConfig> {
  const cfg = await getSettingJson<Partial<LandingConfig>>(LANDING_CONFIG_KEY, DEFAULT_LANDING_CONFIG);
  return {
    ...DEFAULT_LANDING_CONFIG,
    ...cfg,
    columns: cfg.columns && typeof cfg.columns === "object" ? cfg.columns : {},
    hasHeader: cfg.hasHeader === "yes" || cfg.hasHeader === "no" ? cfg.hasHeader : "auto",
    tabs: typeof cfg.tabs === "string" ? cfg.tabs : "",
    dedupeDays: Number(cfg.dedupeDays) > 0 ? Number(cfg.dedupeDays) : 7,
    shippingFee: Number.isFinite(Number(cfg.shippingFee)) ? Number(cfg.shippingFee) : 25_000,
  };
}

export type SheetTabPreview = { key: string; label: string; url: string; headers: string[]; detected: Partial<Record<LandingColumnKey, string>>; sample: string[][]; rows: number; hasHeader: boolean; error?: string };
export type SheetPreview = { tabs: SheetTabPreview[]; rows: number };

async function fetchCsv(url: string): Promise<string[][]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: "follow", headers: { accept: "text/csv,*/*" } });
  if (!res.ok) throw new Error(`Không tải được sheet (HTTP ${res.status}). Sheet cần chia sẻ "Bất kỳ ai có liên kết – Người xem".`);
  const text = await res.text();
  if (/<html/i.test(text.slice(0, 300))) throw new Error("Google trả về trang HTML thay vì CSV: sheet chưa chia sẻ công khai hoặc tên tab / gid sai.");
  const rows = parseCsv(text);
  if (!rows.length) throw new Error("Tab rỗng");
  return rows;
}

/** Xác định tiêu đề (có / không) và bản đồ cột: tiêu đề → theo tên; không tiêu đề (hoặc tiêu đề rỗng do gviz sinh) → theo nội dung; ghi đè "#n" luôn thắng */
export function resolveColumns(rows: string[][], config: LandingConfig) {
  const firstIsHeader = config.hasHeader === "yes" ? true : config.hasHeader === "no" ? false : looksLikeHeader(rows[0]);
  const generic = firstIsHeader && isGenericHeader(rows[0]);
  const width = Math.max(...rows.slice(0, 20).map((r) => r.length));
  const dataStart = firstIsHeader ? 1 : 0;
  const hasHeader = firstIsHeader && !generic;
  const headers = hasHeader ? rows[0].map((h) => h.trim()) : Array.from({ length: width }, (_, i) => `Cột ${i + 1}`);
  const base = hasHeader ? detectColumns(headers, config.columns) : detectColumnsByContent(rows.slice(dataStart));
  const overrides = detectColumns(headers, config.columns);
  const cols: Partial<Record<LandingColumnKey, number>> = { ...base };
  for (const [k, idx] of Object.entries(overrides) as [LandingColumnKey, number][]) if (config.columns[k]) cols[k] = idx;
  return { headers, cols, dataStart, hasHeader };
}

/** Tải từng tab, trả tiêu đề + cột đã dò + 5 dòng mẫu (SĐT che bớt) — để kiểm tra cấu hình */
export async function previewSheet(cfg?: LandingConfig): Promise<SheetPreview> {
  const config = cfg ?? (await loadLandingConfig());
  if (!config.sheetUrl) throw new Error("Chưa cấu hình link Google Sheet (Đơn landing page → Cấu hình)");
  const tabs: SheetTabPreview[] = [];
  for (const tab of sheetTabs(config)) {
    try {
      const rows = await fetchCsv(tab.url);
      const { headers, cols, dataStart, hasHeader } = resolveColumns(rows, config);
      const detected: Partial<Record<LandingColumnKey, string>> = {};
      for (const [k, idx] of Object.entries(cols) as [LandingColumnKey, number][]) detected[k] = hasHeader ? headers[idx] : `#${idx + 1}`;
      const phoneIdx = cols.phone;
      const sample = rows.slice(dataStart, dataStart + 5).map((r) => r.map((v, i) => (i === phoneIdx ? v.replace(/(\d{2})\d{4}(\d{2,3})/, "$1****$2") : v.slice(0, 60))));
      tabs.push({ ...tab, headers, detected, sample, rows: rows.length - dataStart, hasHeader });
    } catch (e) {
      tabs.push({ ...tab, headers: [], detected: {}, sample: [], rows: 0, hasHeader: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (tabs.every((t) => t.error)) throw new Error(tabs.map((t) => `${t.label}: ${t.error}`).join(" · "));
  return { tabs, rows: tabs.reduce((t, x) => t + x.rows, 0) };
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

export type LandingImportResult = { tabs: { label: string; rows: number; error?: string }[]; rows: number; inserted: number; updated: number; skipped: number; matchedVariants: number; duplicates: number; risky: number; linked: number; errors: string[] };

/** Nhập / cập nhật từ mọi tab đã khai. onlyNew: chỉ xử lý dòng chưa có trong ERP (mặc định cập nhật cả dòng cũ nếu nội dung đổi) */
export async function importLandingSheet(options: { log?: (m: string) => void; onlyNew?: boolean } = {}): Promise<LandingImportResult> {
  const log = options.log ?? (() => undefined);
  const db = await getDb();
  const config = await loadLandingConfig();
  if (!config.sheetUrl) throw new Error("Chưa cấu hình link Google Sheet");
  const result: LandingImportResult = { tabs: [], rows: 0, inserted: 0, updated: 0, skipped: 0, matchedVariants: 0, duplicates: 0, risky: 0, linked: 0, errors: [] };
  const candidates = await variantCandidates();
  for (const tab of sheetTabs(config)) {
    let rows: string[][];
    try {
      rows = await fetchCsv(tab.url);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      result.tabs.push({ label: tab.label, rows: 0, error: message });
      result.errors.push(`${tab.label}: ${message}`);
      continue;
    }
    const { headers, cols, dataStart } = resolveColumns(rows, config);
    const tabKey = tab.key;
    result.tabs.push({ label: tab.label, rows: rows.length - dataStart });
    result.rows += rows.length - dataStart;
    if (cols.phone === undefined && cols.name === undefined) {
      result.errors.push(`${tab.label}: không dò được cột SĐT / tên khách (${headers.slice(0, 8).join(" | ")}…). Khai báo cột "#n" ở Cấu hình.`);
      continue;
    }
    const existing = new Map((await db.select({ id: schema.landingOrders.id, rowKey: schema.landingOrders.rowKey, raw: schema.landingOrders.raw, status: schema.landingOrders.status, variantId: schema.landingOrders.variantId, orderId: schema.landingOrders.orderId, phone: schema.landingOrders.phone }).from(schema.landingOrders).where(eq(schema.landingOrders.sheetGid, tabKey))).map((r) => [r.rowKey, r]));
    for (let i = dataStart; i < rows.length; i++) {
      const rowNo = i + 1; // số dòng trên sheet (1-based, kể cả tiêu đề)
      const parsed = rowToLanding(headers, rows[i], cols, rowNo);
      if (!parsed) {
        result.skipped += 1;
        continue;
      }
      const rowKey = `${tabKey}:${rowNo}`;
      const prev = existing.get(rowKey);
      if (prev && options.onlyNew) {
        result.skipped += 1;
        continue;
      }
      if (prev && JSON.stringify(prev.raw ?? {}) === JSON.stringify(parsed.raw)) {
        result.skipped += 1;
        continue;
      }
      // tab đặt tên theo mã hàng (Q003, Q002) → dòng không có mã trong chiến dịch vẫn biết mã
      if (!parsed.product && /^[A-Z]{1,2}\d{3}$/i.test(tab.label)) parsed.product = tab.label.toUpperCase();
      const match = matchVariant({ product: parsed.product, variant: parsed.variant, size: parsed.size, color: parsed.color }, candidates);
      if (match) result.matchedVariants += 1;
      const at = parsed.time ?? new Date();
      const base = {
        sheetGid: tabKey,
        rowIndex: rowNo,
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
        source: parsed.source || tab.label,
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
      const [hits, risk] = await Promise.all([duplicatesForPhone(parsed.phone, at, config.dedupeDays, row.id), riskForPhone(parsed.phone)]);
      // đơn Pancake lên ngay sau khi khách điền form = chính đơn này (ghép để theo dõi), không phải trùng
      const linked = hits.filter((d) => d.kind === "PANCAKE" && d.at && d.at.getTime() >= at.getTime() - 3_600_000).sort((a, b) => (a.at as Date).getTime() - (b.at as Date).getTime())[0];
      const dups = hits.filter((d) => !linked || d.id !== linked.id);
      if (dups.length) result.duplicates += 1;
      if (risk.risky) result.risky += 1;
      if (linked) result.linked += 1;
      await db
        .update(schema.landingOrders)
        .set({ duplicates: dups, risk, ...(linked ? { orderId: linked.id } : {}) })
        .where(eq(schema.landingOrders.id, row.id));
      log(`${tab.label} dòng ${rowNo}: ${parsed.name} ${parsed.phone} · ${parsed.product} → ${match ? `mẫu ${match.variant.productCode} ${match.variant.size} ${match.variant.color}` : "chưa ghép mẫu mã"}${dups.length ? ` · trùng ${dups.length}` : ""}${risk.risky ? " · RỦI RO" : ""}`);
    }
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
      await refreshLandingChecks(l.id);
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
  const [hits, risk] = await Promise.all([duplicatesForPhone(row.phone, at, config.dedupeDays, row.id), riskForPhone(row.phone, row.orderId ?? undefined)]);
  const dups = hits.filter((d) => d.id !== row.orderId);
  await db.update(schema.landingOrders).set({ duplicates: dups, risk, updatedAt: new Date() }).where(eq(schema.landingOrders.id, id));
  return { duplicates: dups, risk };
}

/** Tính lại trùng / rủi ro (và ghép lại mẫu mã cho dòng chưa ghép) cho mọi dòng landing N ngày gần đây */
export async function recheckAllLanding(days = 60): Promise<{ rechecked: number; variantsMatched: number }> {
  const db = await getDb();
  const candidates = await variantCandidates();
  const rows = await db
    .select({ id: schema.landingOrders.id, variantId: schema.landingOrders.variantId, product: schema.landingOrders.productText, variant: schema.landingOrders.variantText, size: schema.landingOrders.sizeText, color: schema.landingOrders.colorText, tab: schema.landingOrders.sheetGid })
    .from(schema.landingOrders)
    .where(gte(schema.landingOrders.createdAt, new Date(Date.now() - days * 86_400_000)));
  let variantsMatched = 0;
  for (const r of rows) {
    if (!r.variantId) {
      const label = r.tab.replace(/^tab:/, "");
      const product = r.product || (/^[A-Z]{1,2}\d{3}$/i.test(label) ? label.toUpperCase() : "");
      const match = matchVariant({ product, variant: r.variant, size: r.size, color: r.color }, candidates);
      if (match) {
        await db.update(schema.landingOrders).set({ variantId: match.variant.id, variantMatchScore: match.score, productText: product, updatedAt: new Date() }).where(eq(schema.landingOrders.id, r.id));
        variantsMatched += 1;
      }
    }
    await refreshLandingChecks(r.id);
  }
  clearMemo();
  return { rechecked: rows.length, variantsMatched };
}

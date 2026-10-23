import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { memo } from "@/lib/cache";
import { PURCHASING_RULE, UNKNOWN_SUPPLIER } from "@/lib/constants/purchasing";
import { supplierGroupOf } from "@/lib/constants/suppliers";
import { supplierCatalog } from "@/lib/queries/suppliers";

/**
 * ───────────── MUA HÀNG & XƯỞNG ─────────────
 *
 * Trả lời bốn câu mà báo cáo lợi nhuận không trả lời được:
 *   1. Đang cam kết bao nhiêu tiền với xưởng, lô nào quá hạn?
 *   2. Xưởng nào giao nhanh, xưởng nào hay trễ?
 *   3. Giá nhập đang tăng ở mẫu mã nào?
 *   4. Những con số trên đáng tin tới đâu?
 *
 * NGUỒN SỰ THẬT, tách bạch hai chiều:
 *   · CAM KẾT  = `production_orders` (đơn đặt xưởng do người lập, tiền chưa chắc đã trả).
 *   · HÀNG THẬT = `stock_receipts` + `stock_receipt_items` (phiếu nhập kho, có ngày và có giá).
 * Hai chiều này KHÔNG suy ra lẫn nhau. Đặt 500 cái không có nghĩa là nhận 500 cái.
 *
 * THỜI GIAN GIAO CỦA XƯỞNG — MỐC THẬT TRƯỚC, ƯỚC TÍNH SAU (OD-P2-03, 23/10/2026):
 *   · MỐC THẬT = `production_orders.received_at`, kho bấm «đã nhận» lúc ĐẾM XONG, ghi đúng một lần
 *     (`shouldStampReceipt`, từ 23/09/2026). Đây là lời khai trực tiếp, không phải phép suy.
 *   · Lô CHƯA có mốc thật (nhận trước 23/09/2026) mới rơi về đường cũ: ghép đơn sản xuất với phiếu
 *     nhập kho, **chỉ khi một-một** — một đơn ứng với đúng một phiếu, phiếu đó cũng chỉ ứng với đúng
 *     đơn ấy. Kết quả đó là ƯỚC TÍNH và mang nhãn tới tận ô trên màn hình (`leadBasis`), không trộn im lặng.
 *   · Còn lại là NHẬP NHẰNG hoặc CHƯA THẤY PHIẾU — đếm riêng và hiện ra, không làm tròn thành 0, không đoán.
 * `updated_at` KHÔNG BAO GIỜ là mốc nhận: nó đổi theo mọi lần sửa ghi chú.
 *
 * Module này CHỈ ĐỌC. Không tự tạo đơn sản xuất, không tự sửa tồn kho, không tự ghép phiếu.
 */

/** `db.execute` trả mảng (PGlite) hoặc `{ rows }` (node-postgres) — đọc thống nhất một chỗ. */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function date(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Tên xưởng dùng để gom nhóm: bỏ khoảng trắng thừa, không phân biệt hoa thường. */
function supplierKey(raw: string): string {
  const t = raw.trim();
  return t ? t.toLowerCase() : "";
}

function supplierLabel(raw: string): string {
  const t = raw.trim();
  return t || UNKNOWN_SUPPLIER;
}

/** Phân vị trên một mảng số đã có sẵn (nội suy tuyến tính). `null` khi không có mẫu nào. */
function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return Math.round((sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)) * 10) / 10;
}

const DAY_MS = 86_400_000;

export type OpenProductionOrder = {
  id: string;
  code: string;
  productCode: string;
  productName: string;
  supplier: string;
  totalQty: number;
  /** Tiền đã cam kết với xưởng cho lô này (số lượng × đơn giá ghi trên đơn). */
  committed: number;
  dueDate: Date | null;
  sentAt: Date | null;
  /** Số ngày đã quá hạn hẹn. `null` = chưa tới hạn hoặc lô không ghi hạn. */
  lateDays: number | null;
};

export type SupplierRow = {
  supplier: string;
  /** Xưởng trong danh mục. `null` = nhóm này đứng trên CHỮ GÕ, chưa vào danh mục (nối yếu — mục 39). */
  supplierId: string | null;
  inCatalog: boolean;
  /** Đơn sản xuất đã gửi trong kỳ (mọi trạng thái sau khi gửi). */
  ordersSent: number;
  /** Đơn đã đánh dấu nhận trong kỳ. */
  ordersReceived: number;
  /** Tiền đang cam kết: lô đã gửi, chưa đánh dấu nhận. */
  committed: number;
  /** Trung vị / p90 ngày giao trên các lô làm căn cứ (`leadSamples`), căn cứ ghi ở `leadBasis`. `null` = chưa đủ lô. */
  leadDaysP50: number | null;
  leadDaysP90: number | null;
  /** Lô đã nhận ĐO ĐƯỢC thời gian giao = `leadActual` + `leadEstimated`. */
  leadMatched: number;
  /** Lô đo bằng mốc thật kho bấm «đã nhận». */
  leadActual: number;
  /** Lô chưa có mốc thật, ƯỚC TÍNH bằng ghép một-một với phiếu nhập. */
  leadEstimated: number;
  /** Số lô thực sự vào trung vị / tỷ lệ đúng hạn (đủ lô mốc thật thì CHỈ lô mốc thật). */
  leadSamples: number;
  /** Căn cứ của trung vị: `ACTUAL` chỉ mốc thật · `MIXED` có lô ước tính · `ESTIMATED` toàn ước tính. `null` = không lô nào. */
  leadBasis: LeadBasis | null;
  leadAmbiguous: number;
  leadUnmatched: number;
  /** Tỷ lệ lô về đúng hạn hẹn, cùng tập lô và cùng căn cứ với trung vị. `null` = chưa đủ số lô để nói, xem `onTimeBasis`. */
  onTimeRate: number | null;
  /** Số lô đủ căn cứ xét đúng hạn (mẫu số của `onTimeRate`). */
  onTimeBasis: number;
  /** Hàng thật đã nhập trong kỳ, theo phiếu nhập kho. */
  receipts: number;
  receivedQty: number;
  receivedCost: number;
  /** Giá nhập bình quân gia quyền của kỳ. `null` = không dòng nhập nào khai giá — CHƯA BIẾT, không phải 0. */
  avgUnitCost: number | null;
  /** Cùng cách tính, cho kỳ liền trước có cùng độ dài. */
  prevAvgUnitCost: number | null;
  /** % thay đổi giá bình quân so với kỳ trước. `null` khi thiếu một trong hai vế. */
  unitCostChangePercent: number | null;
};

export type PriceJump = {
  variantId: string;
  sku: string;
  productName: string;
  variantName: string;
  supplier: string;
  previousCost: number;
  latestCost: number;
  changePercent: number;
  previousAt: Date | null;
  latestAt: Date | null;
};

export type PurchasingCoverage = {
  /** Đơn sản xuất trong kỳ (không tính lô đã huỷ). */
  productionOrders: number;
  withSupplier: number;
  withDueDate: number;
  withSentAt: number;
  /** Dòng phiếu nhập trong kỳ và số dòng có khai đơn giá. */
  receiptLines: number;
  receiptLinesWithCost: number;
  /** Lô đã nhận trong kỳ, ba nhóm rời nhau: đo được (`leadMatched` = `leadActual` + `leadEstimated`) · nhập nhằng · chưa thấy phiếu. */
  leadMatched: number;
  leadActual: number;
  leadEstimated: number;
  leadAmbiguous: number;
  leadUnmatched: number;
  /** Lô có mốc nhận SỚM HƠN ngày gửi — mâu thuẫn, mốc ấy không dùng (lô đi đường ước tính). Nằm trong ba nhóm trên, không phải nhóm thứ tư. */
  leadContradictory: number;
  /** % lô đo được thời gian giao. `null` khi không có lô nào để xét. */
  leadCoveragePercent: number | null;
  /** % lô đo bằng MỐC THẬT. `null` khi không có lô nào để xét. */
  leadActualPercent: number | null;
};

export type PurchasingReport = {
  windowDays: number;
  from: Date;
  open: {
    count: number;
    committed: number;
    overdueCount: number;
    overdueCommitted: number;
    maxLateDays: number | null;
  };
  openOrders: OpenProductionOrder[];
  suppliers: SupplierRow[];
  priceJumps: PriceJump[];
  coverage: PurchasingCoverage;
  /** Chỉ số nào là ƯỚC TÍNH — hiện thẳng trên giao diện, không giấu dưới chân trang. */
  estimated: string[];
  /** Những gì ERP KHÔNG biết. Đọc trước khi tin con số. */
  limitations: string[];
};

type PoRow = {
  id: string;
  code: string;
  productId: string;
  supplier: string;
  /** Khoá xưởng trong danh mục, nếu dòng đã ghi. */
  supplierId?: string | null;
  /** Nhóm xưởng đã quy về (`supplierGroupOf`). Không có ⇒ so theo chữ như trước. */
  group?: string;
  sentAt: Date;
  dueDate: Date | null;
  /** Mốc thật kho bấm «đã nhận» (`production_orders.received_at`). Vắng / `null` = lô nhận trước khi có mốc ⇒ ước tính. */
  receivedAt?: Date | null;
};

type ReceiptRow = {
  id: string;
  supplier: string;
  group?: string;
  receivedAt: Date;
  productIds: string[];
};

/**
 * Ghép đơn sản xuất với phiếu nhập kho để suy ra thời gian giao thật.
 *
 * Quy tắc ghép, cố ý CHẶT để thà không biết còn hơn biết sai:
 *   · phiếu nhập phải cùng MẪU với lô đặt;
 *   · phiếu phải lập SAU ngày gửi xưởng và trong vòng `maxLeadDays`;
 *   · nếu cả hai bên đều ghi tên xưởng thì tên phải trùng;
 *   · và phải là quan hệ MỘT-MỘT: lô chỉ có đúng một phiếu ứng viên, phiếu đó cũng chỉ ứng với
 *     đúng lô ấy. Cùng một mẫu đặt hai lô rồi nhận hai phiếu thì không ai biết phiếu nào của lô
 *     nào — đó là NHẬP NHẰNG, và ERP nói ra thay vì bốc một cái.
 */
export function matchProductionToReceipts(pos: PoRow[], receipts: ReceiptRow[]) {
  const maxLeadMs = PURCHASING_RULE.maxLeadDays * DAY_MS;
  const candidatesOf = new Map<string, string[]>();
  const poOfReceipt = new Map<string, string[]>();

  for (const po of pos) {
    const found: string[] = [];
    for (const r of receipts) {
      if (!r.productIds.includes(po.productId)) continue;
      const gap = r.receivedAt.getTime() - po.sentAt.getTime();
      if (gap < 0 || gap > maxLeadMs) continue;
      // So theo XƯỞNG đã quy về danh mục khi có; không thì theo chữ như trước.
      const a = po.group ?? supplierKey(po.supplier);
      const b = r.group ?? supplierKey(r.supplier);
      if (a && b && a !== b) continue;
      found.push(r.id);
      poOfReceipt.set(r.id, [...(poOfReceipt.get(r.id) ?? []), po.id]);
    }
    candidatesOf.set(po.id, found);
  }

  const matched: { po: PoRow; receipt: ReceiptRow; leadDays: number; onTime: boolean | null }[] = [];
  const ambiguous: PoRow[] = [];
  const unmatched: PoRow[] = [];
  const byId = new Map(receipts.map((r) => [r.id, r]));

  for (const po of pos) {
    const found = candidatesOf.get(po.id) ?? [];
    if (found.length === 0) {
      unmatched.push(po);
      continue;
    }
    if (found.length > 1) {
      ambiguous.push(po);
      continue;
    }
    const receipt = byId.get(found[0]);
    // Phiếu này còn được lô khác nhận là của mình ⇒ không ai kết luận được, để nhập nhằng.
    if (!receipt || (poOfReceipt.get(found[0]) ?? []).length > 1) {
      ambiguous.push(po);
      continue;
    }
    const leadDays = Math.round((receipt.receivedAt.getTime() - po.sentAt.getTime()) / DAY_MS);
    matched.push({
      po,
      receipt,
      leadDays,
      onTime: po.dueDate ? receipt.receivedAt.getTime() <= po.dueDate.getTime() : null,
    });
  }

  return { matched, ambiguous, unmatched };
}

export type LeadBasis = "ACTUAL" | "MIXED" | "ESTIMATED";
export type LotLead = { po: PoRow; leadDays: number; onTime: boolean | null; basis: "ACTUAL" | "ESTIMATED" };

/**
 * Thời gian giao của từng lô đã nhận: MỐC THẬT trước, ghép phiếu sau. HÀM THUẦN.
 *
 * Phép ghép vẫn chạy trên MỌI lô như trước — một lô đã có mốc thật vẫn có thể là ứng viên tranh phiếu với
 * lô khác, và bỏ nó ra khỏi phép ghép là tự nới luật một-một cho lô còn lại.
 * Mốc nhận SỚM HƠN ngày gửi là mâu thuẫn: không dùng, không sửa, đếm ở `contradictory`, lô đi đường ước tính.
 */
export function lotLeadTimes(pos: PoRow[], receipts: ReceiptRow[]) {
  const link = matchProductionToReceipts(pos, receipts);
  const matchedOf = new Map(link.matched.map((m) => [m.po.id, m]));
  const ambiguousIds = new Set(link.ambiguous.map((p) => p.id));
  const measured: LotLead[] = [];
  const ambiguous: PoRow[] = [];
  const unmatched: PoRow[] = [];
  const contradictory: PoRow[] = [];
  for (const po of pos) {
    const real = po.receivedAt ?? null;
    if (real && real.getTime() >= po.sentAt.getTime()) {
      measured.push({
        po,
        leadDays: Math.round((real.getTime() - po.sentAt.getTime()) / DAY_MS),
        onTime: po.dueDate ? real.getTime() <= po.dueDate.getTime() : null,
        basis: "ACTUAL",
      });
      continue;
    }
    if (real) contradictory.push(po);
    const m = matchedOf.get(po.id);
    if (m) measured.push({ po, leadDays: m.leadDays, onTime: m.onTime, basis: "ESTIMATED" });
    else if (ambiguousIds.has(po.id)) ambiguous.push(po);
    else unmatched.push(po);
  }
  return { measured, ambiguous, unmatched, contradictory };
}

/**
 * Trung vị / p90 / đúng hạn của MỘT xưởng. Đủ `minSamples` lô mốc thật ⇒ CHỈ dùng lô mốc thật (`ACTUAL`);
 * chưa đủ thì lô ước tính mới vào bù, và căn cứ ghi `MIXED` / `ESTIMATED` để màn hình in nhãn. HÀM THUẦN.
 */
export function supplierLeadStats(lots: readonly LotLead[], minSamples: number = PURCHASING_RULE.minLeadSamples) {
  const actual = lots.filter((l) => l.basis === "ACTUAL");
  const used = actual.length >= minSamples ? actual : [...lots];
  const hasActual = used.some((l) => l.basis === "ACTUAL");
  const hasEstimated = used.some((l) => l.basis === "ESTIMATED");
  const basis: LeadBasis | null = hasActual && hasEstimated ? "MIXED" : hasActual ? "ACTUAL" : hasEstimated ? "ESTIMATED" : null;
  const days = used.map((l) => l.leadDays);
  const enough = days.length >= minSamples;
  const due = used.filter((l) => l.onTime !== null);
  const ok = due.filter((l) => l.onTime === true).length;
  return {
    actual: actual.length,
    estimated: lots.length - actual.length,
    samples: used.length,
    basis,
    p50: enough ? percentile(days, 0.5) : null,
    p90: enough ? percentile(days, 0.9) : null,
    onTimeBasis: due.length,
    // "Đúng hạn 100%" dựng trên MỘT lô đọc như một xưởng hoàn hảo — cùng ngưỡng với thời gian giao.
    onTimeRate: due.length >= minSamples ? Math.round((ok / due.length) * 1000) / 10 : null,
  };
}

async function purchasingUncached(windowDays: number): Promise<PurchasingReport> {
  const db = await getDb();
  const from = new Date(Date.now() - windowDays * DAY_MS);
  /*
    DANH MỤC XƯỞNG: dòng có `supplier_id` thì theo khoá; dòng cũ thì quy về lúc ĐỌC, chỉ khi tên khớp
    ĐÚNG MỘT xưởng (tên hoặc tên gọi khác). Không dòng nào bị sửa — xem `lib/constants/suppliers.ts`.
  */
  const cat = await supplierCatalog();
  const grp = (id: unknown, raw: unknown) => supplierGroupOf({ supplierId: id ? text(id) : null, supplier: text(raw) }, cat.index, cat.byId);
  const prevFrom = new Date(from.getTime() - windowDays * DAY_MS);

  // ───────── 1. Cam kết đang mở: lô đã gửi xưởng, chưa đánh dấu nhận ─────────
  // CỐ Ý không giới hạn theo cửa sổ: một lô gửi từ 8 tháng trước mà chưa nhận là tin quan trọng
  // nhất trên trang này, không phải tin cũ đáng bỏ đi.
  const [openAgg] = rowsOf(
    await db.execute(sql`
      select count(*) as n,
             coalesce(sum(total_qty * unit_cost), 0) as committed,
             count(*) filter (where due_date is not null and due_date < now()) as overdue_n,
             coalesce(sum(total_qty * unit_cost) filter (where due_date is not null and due_date < now()), 0) as overdue_committed,
             max(floor(extract(epoch from now() - due_date) / 86400)) filter (where due_date is not null and due_date < now()) as max_late
      from production_orders
      where status = 'SENT'
    `),
  );

  const openOrders = rowsOf(
    await db.execute(sql`
      select id, code, product_code, product_name, supplier, supplier_id, total_qty,
             total_qty * unit_cost as committed, due_date, sent_at,
             case when due_date is not null and due_date < now()
                  then floor(extract(epoch from now() - due_date) / 86400)
             end as late_days
      from production_orders
      where status = 'SENT'
      order by (due_date is null), due_date asc, sent_at asc
      limit 50
    `),
  ).map<OpenProductionOrder>((r) => ({
    id: text(r.id),
    code: text(r.code),
    productCode: text(r.product_code),
    productName: text(r.product_name),
    supplier: grp(r.supplier_id, r.supplier).label || UNKNOWN_SUPPLIER,
    totalQty: num(r.total_qty),
    committed: num(r.committed),
    dueDate: date(r.due_date),
    sentAt: date(r.sent_at),
    lateDays: r.late_days == null ? null : num(r.late_days),
  }));

  // ───────── 2. Ghép lô ↔ phiếu nhập để suy thời gian giao ─────────
  const pos = rowsOf(
    await db.execute(sql`
      select id, code, product_id, supplier, supplier_id, sent_at, due_date, received_at
      from production_orders
      where status = 'RECEIVED' and sent_at is not null and product_id is not null and sent_at >= ${from}
    `),
  )
    .map((r): Omit<PoRow, "sentAt"> & { sentAt: Date | null } => ({
      id: text(r.id),
      code: text(r.code),
      productId: text(r.product_id),
      supplier: text(r.supplier),
      supplierId: r.supplier_id ? text(r.supplier_id) : null,
      group: grp(r.supplier_id, r.supplier).key,
      sentAt: date(r.sent_at),
      dueDate: date(r.due_date),
      receivedAt: date(r.received_at),
    }))
    .filter((p): p is PoRow => p.sentAt !== null);

  const receipts = rowsOf(
    await db.execute(sql`
      select r.id, r.supplier, r.supplier_id, r.received_at,
             array_agg(distinct v.product_id) as product_ids
      from stock_receipts r
      join stock_receipt_items i on i.receipt_id = r.id
      join product_variants v on v.id = i.variant_id
      where r.kind = 'RECEIPT' and i.quantity > 0 and v.product_id is not null and r.received_at >= ${from}
      group by r.id, r.supplier, r.supplier_id, r.received_at
    `),
  )
    .map((r): Omit<ReceiptRow, "receivedAt"> & { receivedAt: Date | null } => ({
      id: text(r.id),
      supplier: text(r.supplier),
      group: grp(r.supplier_id, r.supplier).key,
      receivedAt: date(r.received_at),
      productIds: Array.isArray(r.product_ids) ? r.product_ids.map((v) => text(v)) : [],
    }))
    .filter((r): r is ReceiptRow => r.receivedAt !== null);

  const link = lotLeadTimes(pos, receipts);

  // ───────── 3. Hàng thật đã nhập, theo xưởng, kỳ này và kỳ trước ─────────
  const receiptAgg = async (start: Date, end: Date) =>
    rowsOf(
      await db.execute(sql`
        select r.supplier, r.supplier_id,
               count(distinct r.id) as receipts,
               coalesce(sum(i.quantity), 0) as qty,
               coalesce(sum(i.quantity * i.unit_cost), 0) as cost,
               coalesce(sum(i.quantity) filter (where i.unit_cost > 0), 0) as qty_costed,
               coalesce(sum(i.quantity * i.unit_cost) filter (where i.unit_cost > 0), 0) as cost_costed
        from stock_receipts r
        join stock_receipt_items i on i.receipt_id = r.id
        where r.kind = 'RECEIPT' and i.quantity > 0 and r.received_at >= ${start} and r.received_at < ${end}
        group by r.supplier, r.supplier_id
      `),
    );

  const now = new Date();
  const curr = await receiptAgg(from, now);
  const prev = await receiptAgg(prevFrom, from);

  // ───────── 4. Cam kết và số lô theo xưởng ─────────
  const poAgg = rowsOf(
    await db.execute(sql`
      select supplier, supplier_id,
             count(*) filter (where sent_at is not null and sent_at >= ${from}) as sent_n,
             count(*) filter (where status = 'RECEIVED' and sent_at is not null and sent_at >= ${from}) as received_n,
             coalesce(sum(total_qty * unit_cost) filter (where status = 'SENT'), 0) as committed
      from production_orders
      where status <> 'CANCELLED'
      group by supplier, supplier_id
    `),
  );

  // ───────── 5. Gộp thành một dòng cho mỗi xưởng ─────────
  const rows = new Map<string, SupplierRow>();
  const blank = (label: string, supplierId: string | null): SupplierRow => ({
    supplier: label,
    supplierId,
    inCatalog: supplierId !== null,
    ordersSent: 0,
    ordersReceived: 0,
    committed: 0,
    leadDaysP50: null,
    leadDaysP90: null,
    leadMatched: 0,
    leadActual: 0,
    leadEstimated: 0,
    leadSamples: 0,
    leadBasis: null,
    leadAmbiguous: 0,
    leadUnmatched: 0,
    onTimeRate: null,
    onTimeBasis: 0,
    receipts: 0,
    receivedQty: 0,
    receivedCost: 0,
    avgUnitCost: null,
    prevAvgUnitCost: null,
    unitCostChangePercent: null,
  });
  /*
    Một dòng cho mỗi XƯỞNG: các cách gõ khác nhau của cùng một xưởng trong danh mục gộp về một dòng.
    Các bảng phụ (thời gian giao, giá) dùng đúng cùng khoá ấy qua `keyOf`.
  */
  const keyOf = (id: unknown, raw: string) => grp(id, raw).key || UNKNOWN_SUPPLIER;
  const at = (id: unknown, raw: string) => {
    const g = grp(id, raw);
    const key = g.key || UNKNOWN_SUPPLIER;
    const found = rows.get(key);
    if (found) return found;
    const created = blank(g.label || supplierLabel(raw), g.supplierId);
    rows.set(key, created);
    return created;
  };
  // Giá bình quân phải CỘNG DỒN qua mọi cách gõ của một xưởng rồi mới chia — chia từng cách gõ rồi ghi đè là lấy giá của cách gõ cuối cùng.
  const giaKyNay = new Map<string, { qty: number; cost: number }>();
  const giaKyTruoc = new Map<string, { qty: number; cost: number }>();
  const congGia = (m: Map<string, { qty: number; cost: number }>, key: string, qty: number, cost: number) => {
    const cur = m.get(key) ?? { qty: 0, cost: 0 };
    m.set(key, { qty: cur.qty + qty, cost: cur.cost + cost });
  };

  for (const r of poAgg) {
    const row = at(r.supplier_id, text(r.supplier));
    row.ordersSent += num(r.sent_n);
    row.ordersReceived += num(r.received_n);
    row.committed += num(r.committed);
  }
  for (const r of curr) {
    const row = at(r.supplier_id, text(r.supplier));
    row.receipts += num(r.receipts);
    row.receivedQty += num(r.qty);
    row.receivedCost += num(r.cost);
    congGia(giaKyNay, keyOf(r.supplier_id, text(r.supplier)), num(r.qty_costed), num(r.cost_costed));
  }
  for (const r of prev) {
    at(r.supplier_id, text(r.supplier));
    congGia(giaKyTruoc, keyOf(r.supplier_id, text(r.supplier)), num(r.qty_costed), num(r.cost_costed));
  }
  for (const [key, row] of rows) {
    // CHƯA BIẾT ≠ 0: không dòng nào khai giá thì để trống, không ghi giá bình quân bằng 0.
    const a = giaKyNay.get(key);
    if (a && a.qty > 0) row.avgUnitCost = Math.round(a.cost / a.qty);
    const b = giaKyTruoc.get(key);
    if (b && b.qty > 0) row.prevAvgUnitCost = Math.round(b.cost / b.qty);
  }

  const lotsBySupplier = new Map<string, LotLead[]>();
  for (const m of link.measured) {
    at(m.po.supplierId, m.po.supplier);
    const key = keyOf(m.po.supplierId, m.po.supplier);
    lotsBySupplier.set(key, [...(lotsBySupplier.get(key) ?? []), m]);
  }
  for (const po of link.ambiguous) at(po.supplierId, po.supplier).leadAmbiguous += 1;
  for (const po of link.unmatched) at(po.supplierId, po.supplier).leadUnmatched += 1;

  for (const [key, row] of rows) {
    // Vài lô lẻ không đủ để nói xưởng nào nhanh hơn xưởng nào — `supplierLeadStats` để trống còn hơn xếp hạng nhiễu.
    const st = supplierLeadStats(lotsBySupplier.get(key) ?? []);
    row.leadMatched = st.actual + st.estimated;
    row.leadActual = st.actual;
    row.leadEstimated = st.estimated;
    row.leadSamples = st.samples;
    row.leadBasis = st.basis;
    row.leadDaysP50 = st.p50;
    row.leadDaysP90 = st.p90;
    row.onTimeBasis = st.onTimeBasis;
    row.onTimeRate = st.onTimeRate;
    if (row.avgUnitCost !== null && row.prevAvgUnitCost !== null && row.prevAvgUnitCost > 0) {
      row.unitCostChangePercent = Math.round(((row.avgUnitCost - row.prevAvgUnitCost) / row.prevAvgUnitCost) * 1000) / 10;
    }
  }

  const suppliers = [...rows.values()]
    .filter((r) => r.ordersSent > 0 || r.receipts > 0 || r.committed > 0)
    .sort((a, b) => b.receivedCost - a.receivedCost || b.committed - a.committed);

  // ───────── 6. Giá nhập tăng so với LẦN NHẬP TRƯỚC của cùng mẫu mã ─────────
  // So với chính lần trước của cùng mẫu mã chứ không so với bình quân toàn kho: bình quân trộn
  // nhiều mẫu khác giá nhau, tăng giảm ở đó không nói được điều gì để hành động.
  const jumps = rowsOf(
    await db.execute(sql`
      with lines as (
        select i.variant_id, i.unit_cost, r.received_at, r.supplier, r.supplier_id,
               row_number() over (partition by i.variant_id order by r.received_at desc, i.id desc) as rn
        from stock_receipt_items i
        join stock_receipts r on r.id = i.receipt_id
        where r.kind = 'RECEIPT' and i.quantity > 0 and i.unit_cost > 0
      )
      select l1.variant_id, l1.unit_cost as latest, l1.received_at as latest_at, l1.supplier, l1.supplier_id,
             l2.unit_cost as previous, l2.received_at as previous_at,
             v.sku, trim(concat_ws(' · ', nullif(v.color, ''), nullif(v.size, ''))) as variant_name, p.name as product_name
      from lines l1
      join lines l2 on l2.variant_id = l1.variant_id and l2.rn = 2
      join product_variants v on v.id = l1.variant_id
      left join products p on p.id = v.product_id
      where l1.rn = 1
        and l1.received_at >= ${from}
        and l1.unit_cost * 100 > l2.unit_cost * ${100 + PURCHASING_RULE.priceJumpPercent}
      order by (l1.unit_cost - l2.unit_cost)::numeric / l2.unit_cost desc
      limit 30
    `),
  ).map<PriceJump>((r) => {
    const previousCost = num(r.previous);
    const latestCost = num(r.latest);
    return {
      variantId: text(r.variant_id),
      sku: text(r.sku),
      productName: text(r.product_name),
      variantName: text(r.variant_name),
      supplier: grp(r.supplier_id, r.supplier).label || UNKNOWN_SUPPLIER,
      previousCost,
      latestCost,
      changePercent: previousCost > 0 ? Math.round(((latestCost - previousCost) / previousCost) * 1000) / 10 : 0,
      previousAt: date(r.previous_at),
      latestAt: date(r.latest_at),
    };
  });

  // ───────── 7. Độ phủ dữ liệu ─────────
  const [poCov] = rowsOf(
    await db.execute(sql`
      select count(*) as n,
             count(*) filter (where trim(supplier) <> '') as with_supplier,
             count(*) filter (where due_date is not null) as with_due,
             count(*) filter (where sent_at is not null) as with_sent
      from production_orders
      where status <> 'CANCELLED' and created_at >= ${from}
    `),
  );
  const [lineCov] = rowsOf(
    await db.execute(sql`
      select count(*) as n, count(*) filter (where i.unit_cost > 0) as with_cost
      from stock_receipt_items i
      join stock_receipts r on r.id = i.receipt_id
      where r.kind = 'RECEIPT' and i.quantity > 0 and r.received_at >= ${from}
    `),
  );

  const leadTotal = link.measured.length + link.ambiguous.length + link.unmatched.length;
  const leadActual = link.measured.filter((m) => m.basis === "ACTUAL").length;
  const leadEstimated = link.measured.length - leadActual;
  const pctOf = (n: number) => (leadTotal > 0 ? Math.round((n / leadTotal) * 1000) / 10 : null);
  const coverage: PurchasingCoverage = {
    productionOrders: num(poCov?.n),
    withSupplier: num(poCov?.with_supplier),
    withDueDate: num(poCov?.with_due),
    withSentAt: num(poCov?.with_sent),
    receiptLines: num(lineCov?.n),
    receiptLinesWithCost: num(lineCov?.with_cost),
    leadMatched: link.measured.length,
    leadActual,
    leadEstimated,
    leadAmbiguous: link.ambiguous.length,
    leadUnmatched: link.unmatched.length,
    leadContradictory: link.contradictory.length,
    leadCoveragePercent: pctOf(link.measured.length),
    leadActualPercent: pctOf(leadActual),
  };

  const estimated: string[] = [];
  if (leadEstimated > 0) {
    estimated.push(
      `Thời gian giao của ${leadEstimated}/${leadTotal} lô là ƯỚC TÍNH: lô chưa có mốc kho bấm «đã nhận» nên suy từ việc ghép lô đặt với phiếu nhập kho, chỉ khi ghép được một-một. ${leadActual}/${leadTotal} lô đo bằng mốc thật. Ô mang nhãn «ước tính» / «trộn ước tính» là trung vị có lô ước tính.`,
    );
  }
  if (link.contradictory.length > 0) {
    estimated.push(
      `${link.contradictory.length} lô có mốc «đã nhận» SỚM HƠN ngày gửi xưởng — mâu thuẫn nên mốc ấy KHÔNG được dùng; lô đó đo bằng ghép phiếu nếu ghép được. Sửa ở Lệnh sản xuất, ERP không tự sửa.`,
    );
  }
  if (coverage.leadCoveragePercent !== null && coverage.leadCoveragePercent < PURCHASING_RULE.minLeadCoveragePercent) {
    estimated.push(
      `Độ phủ đo ${coverage.leadCoveragePercent}% — dưới ngưỡng ${PURCHASING_RULE.minLeadCoveragePercent}%. ĐỪNG xếp hạng xưởng theo thời gian giao ở mức phủ này.`,
    );
  }

  return {
    windowDays,
    from,
    open: {
      count: num(openAgg?.n),
      committed: num(openAgg?.committed),
      overdueCount: num(openAgg?.overdue_n),
      overdueCommitted: num(openAgg?.overdue_committed),
      maxLateDays: openAgg?.max_late == null ? null : num(openAgg.max_late),
    },
    openOrders,
    suppliers,
    priceJumps: jumps,
    coverage,
    estimated,
    limitations: [
      "Mốc «đã nhận» là lúc kho ĐẾM XONG (không phải lúc xe tới cổng) và chỉ có từ 23/09/2026 — lô nhận trước đó phải ƯỚC TÍNH bằng cách ghép với phiếu nhập kho, và lô nào không ghép được một-một thì để CHƯA BIẾT chứ không đoán.",
      "Cùng một mẫu đặt nhiều lô rồi nhận nhiều phiếu là NHẬP NHẰNG: ERP đếm riêng chứ không bốc đại một cặp để có con số đẹp.",
      "Tiền cam kết lấy theo đơn giá ghi trên đơn sản xuất — đó là dự kiến phải trả, KHÔNG phải tiền đã trả. ERP không có sổ công nợ xưởng.",
      "Giá nhập bình quân chỉ tính trên dòng phiếu CÓ khai đơn giá; dòng không khai giá bị bỏ khỏi mẫu số chứ không được coi là 0đ.",
      "Trang này CHỈ ĐỌC: không tự tạo đơn sản xuất, không tự ghép phiếu, không tự sửa tồn kho.",
    ],
  };
}

/** Báo cáo mua hàng & xưởng. `windowDays` ảnh hưởng kết quả nên nằm trong khoá cache. */
export async function getPurchasingReport(windowDays: number = PURCHASING_RULE.defaultWindowDays): Promise<PurchasingReport> {
  const days = PURCHASING_RULE.windowChoices.includes(windowDays as (typeof PURCHASING_RULE.windowChoices)[number])
    ? windowDays
    : PURCHASING_RULE.defaultWindowDays;
  return memo(`purchasing:${days}`, 120_000, () => purchasingUncached(days));
}

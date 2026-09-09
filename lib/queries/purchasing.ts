import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { memo } from "@/lib/cache";
import { PURCHASING_RULE, UNKNOWN_SUPPLIER } from "@/lib/constants/purchasing";

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
 * ĐIỀU ERP KHÔNG BIẾT, NÓI TRƯỚC: **đơn sản xuất không có cột "ngày nhận hàng".** Trạng thái
 * `RECEIVED` do người bấm, và `updated_at` đổi theo mọi lần sửa ghi chú — dùng nó làm mốc nhận là
 * tạo ra thời gian giao bịa. Nên thời gian giao ở đây được SUY bằng cách ghép đơn sản xuất với
 * phiếu nhập kho thật, và **chỉ ghép khi một-một**: một đơn ứng với đúng một phiếu, phiếu đó cũng
 * chỉ ứng với đúng đơn ấy. Mọi trường hợp còn lại là NHẬP NHẰNG hoặc CHƯA THẤY PHIẾU — được đếm
 * riêng và hiện ra, không bị làm tròn thành 0 và cũng không bị đoán bừa.
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
  /** Đơn sản xuất đã gửi trong kỳ (mọi trạng thái sau khi gửi). */
  ordersSent: number;
  /** Đơn đã đánh dấu nhận trong kỳ. */
  ordersReceived: number;
  /** Tiền đang cam kết: lô đã gửi, chưa đánh dấu nhận. */
  committed: number;
  /** ƯỚC TÍNH — chỉ tính trên lô ghép được một-một với phiếu nhập. `null` = chưa đủ căn cứ. */
  leadDaysP50: number | null;
  leadDaysP90: number | null;
  leadMatched: number;
  leadAmbiguous: number;
  leadUnmatched: number;
  /** ƯỚC TÍNH — tỷ lệ lô ghép được về đúng hạn hẹn. `null` = chưa đủ số lô để nói, xem `onTimeBasis`. */
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
  /** Kết quả ghép lô ↔ phiếu nhập, ba nhóm rời nhau. */
  leadMatched: number;
  leadAmbiguous: number;
  leadUnmatched: number;
  /** % lô đủ căn cứ tính thời gian giao. `null` khi không có lô nào để xét. */
  leadCoveragePercent: number | null;
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
  sentAt: Date;
  dueDate: Date | null;
};

type ReceiptRow = {
  id: string;
  supplier: string;
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
      const a = supplierKey(po.supplier);
      const b = supplierKey(r.supplier);
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

async function purchasingUncached(windowDays: number): Promise<PurchasingReport> {
  const db = await getDb();
  const from = new Date(Date.now() - windowDays * DAY_MS);
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
      select id, code, product_code, product_name, supplier, total_qty,
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
    supplier: supplierLabel(text(r.supplier)),
    totalQty: num(r.total_qty),
    committed: num(r.committed),
    dueDate: date(r.due_date),
    sentAt: date(r.sent_at),
    lateDays: r.late_days == null ? null : num(r.late_days),
  }));

  // ───────── 2. Ghép lô ↔ phiếu nhập để suy thời gian giao ─────────
  const pos = rowsOf(
    await db.execute(sql`
      select id, code, product_id, supplier, sent_at, due_date
      from production_orders
      where status = 'RECEIVED' and sent_at is not null and product_id is not null and sent_at >= ${from}
    `),
  )
    .map((r) => ({
      id: text(r.id),
      code: text(r.code),
      productId: text(r.product_id),
      supplier: text(r.supplier),
      sentAt: date(r.sent_at),
      dueDate: date(r.due_date),
    }))
    .filter((p): p is PoRow => p.sentAt !== null);

  const receipts = rowsOf(
    await db.execute(sql`
      select r.id, r.supplier, r.received_at,
             array_agg(distinct v.product_id) as product_ids
      from stock_receipts r
      join stock_receipt_items i on i.receipt_id = r.id
      join product_variants v on v.id = i.variant_id
      where r.kind = 'RECEIPT' and i.quantity > 0 and v.product_id is not null and r.received_at >= ${from}
      group by r.id, r.supplier, r.received_at
    `),
  )
    .map((r) => ({
      id: text(r.id),
      supplier: text(r.supplier),
      receivedAt: date(r.received_at),
      productIds: Array.isArray(r.product_ids) ? r.product_ids.map((v) => text(v)) : [],
    }))
    .filter((r): r is ReceiptRow => r.receivedAt !== null);

  const link = matchProductionToReceipts(pos, receipts);

  // ───────── 3. Hàng thật đã nhập, theo xưởng, kỳ này và kỳ trước ─────────
  const receiptAgg = async (start: Date, end: Date) =>
    rowsOf(
      await db.execute(sql`
        select r.supplier,
               count(distinct r.id) as receipts,
               coalesce(sum(i.quantity), 0) as qty,
               coalesce(sum(i.quantity * i.unit_cost), 0) as cost,
               coalesce(sum(i.quantity) filter (where i.unit_cost > 0), 0) as qty_costed,
               coalesce(sum(i.quantity * i.unit_cost) filter (where i.unit_cost > 0), 0) as cost_costed
        from stock_receipts r
        join stock_receipt_items i on i.receipt_id = r.id
        where r.kind = 'RECEIPT' and i.quantity > 0 and r.received_at >= ${start} and r.received_at < ${end}
        group by r.supplier
      `),
    );

  const now = new Date();
  const curr = await receiptAgg(from, now);
  const prev = await receiptAgg(prevFrom, from);

  // ───────── 4. Cam kết và số lô theo xưởng ─────────
  const poAgg = rowsOf(
    await db.execute(sql`
      select supplier,
             count(*) filter (where sent_at is not null and sent_at >= ${from}) as sent_n,
             count(*) filter (where status = 'RECEIVED' and sent_at is not null and sent_at >= ${from}) as received_n,
             coalesce(sum(total_qty * unit_cost) filter (where status = 'SENT'), 0) as committed
      from production_orders
      where status <> 'CANCELLED'
      group by supplier
    `),
  );

  // ───────── 5. Gộp thành một dòng cho mỗi xưởng ─────────
  const rows = new Map<string, SupplierRow>();
  const blank = (label: string): SupplierRow => ({
    supplier: label,
    ordersSent: 0,
    ordersReceived: 0,
    committed: 0,
    leadDaysP50: null,
    leadDaysP90: null,
    leadMatched: 0,
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
  const at = (raw: string) => {
    const key = supplierKey(raw) || UNKNOWN_SUPPLIER;
    const found = rows.get(key);
    if (found) return found;
    const created = blank(supplierLabel(raw));
    rows.set(key, created);
    return created;
  };

  for (const r of poAgg) {
    const row = at(text(r.supplier));
    row.ordersSent += num(r.sent_n);
    row.ordersReceived += num(r.received_n);
    row.committed += num(r.committed);
  }
  for (const r of curr) {
    const row = at(text(r.supplier));
    row.receipts += num(r.receipts);
    row.receivedQty += num(r.qty);
    row.receivedCost += num(r.cost);
    const qty = num(r.qty_costed);
    // CHƯA BIẾT ≠ 0: không dòng nào khai giá thì để trống, không ghi giá bình quân bằng 0.
    if (qty > 0) row.avgUnitCost = Math.round(num(r.cost_costed) / qty);
  }
  for (const r of prev) {
    const row = at(text(r.supplier));
    const qty = num(r.qty_costed);
    if (qty > 0) row.prevAvgUnitCost = Math.round(num(r.cost_costed) / qty);
  }

  const leadsBySupplier = new Map<string, number[]>();
  const onTimeBySupplier = new Map<string, { ok: number; total: number }>();
  for (const m of link.matched) {
    const row = at(m.po.supplier);
    row.leadMatched += 1;
    const key = supplierKey(m.po.supplier) || UNKNOWN_SUPPLIER;
    leadsBySupplier.set(key, [...(leadsBySupplier.get(key) ?? []), m.leadDays]);
    if (m.onTime !== null) {
      const acc = onTimeBySupplier.get(key) ?? { ok: 0, total: 0 };
      onTimeBySupplier.set(key, { ok: acc.ok + (m.onTime ? 1 : 0), total: acc.total + 1 });
    }
  }
  for (const po of link.ambiguous) at(po.supplier).leadAmbiguous += 1;
  for (const po of link.unmatched) at(po.supplier).leadUnmatched += 1;

  for (const [key, row] of rows) {
    const leads = leadsBySupplier.get(key) ?? [];
    // Vài lô lẻ không đủ để nói xưởng nào nhanh hơn xưởng nào — để trống còn hơn xếp hạng nhiễu.
    if (leads.length >= PURCHASING_RULE.minLeadSamples) {
      row.leadDaysP50 = percentile(leads, 0.5);
      row.leadDaysP90 = percentile(leads, 0.9);
    }
    const ot = onTimeBySupplier.get(key);
    if (ot && ot.total > 0) {
      row.onTimeBasis = ot.total;
      // Cùng một ngưỡng với thời gian giao: "đúng hạn 100%" dựng trên MỘT lô là con số gây hiểu
      // lầm mạnh hơn cả việc để trống — nó đọc như một xưởng hoàn hảo.
      if (ot.total >= PURCHASING_RULE.minLeadSamples) row.onTimeRate = Math.round((ot.ok / ot.total) * 1000) / 10;
    }
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
        select i.variant_id, i.unit_cost, r.received_at, r.supplier,
               row_number() over (partition by i.variant_id order by r.received_at desc, i.id desc) as rn
        from stock_receipt_items i
        join stock_receipts r on r.id = i.receipt_id
        where r.kind = 'RECEIPT' and i.quantity > 0 and i.unit_cost > 0
      )
      select l1.variant_id, l1.unit_cost as latest, l1.received_at as latest_at, l1.supplier,
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
      supplier: supplierLabel(text(r.supplier)),
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

  const leadTotal = link.matched.length + link.ambiguous.length + link.unmatched.length;
  const coverage: PurchasingCoverage = {
    productionOrders: num(poCov?.n),
    withSupplier: num(poCov?.with_supplier),
    withDueDate: num(poCov?.with_due),
    withSentAt: num(poCov?.with_sent),
    receiptLines: num(lineCov?.n),
    receiptLinesWithCost: num(lineCov?.with_cost),
    leadMatched: link.matched.length,
    leadAmbiguous: link.ambiguous.length,
    leadUnmatched: link.unmatched.length,
    leadCoveragePercent: leadTotal > 0 ? Math.round((link.matched.length / leadTotal) * 1000) / 10 : null,
  };

  const estimated = [
    `Thời gian giao và tỷ lệ đúng hạn là ƯỚC TÍNH: suy từ việc ghép lô đặt với phiếu nhập kho, chỉ khi ghép được một-một. Kỳ này ghép được ${coverage.leadMatched}/${leadTotal} lô.`,
  ];
  if (coverage.leadCoveragePercent !== null && coverage.leadCoveragePercent < PURCHASING_RULE.minLeadCoveragePercent) {
    estimated.push(
      `Độ phủ ghép ${coverage.leadCoveragePercent}% — dưới ngưỡng ${PURCHASING_RULE.minLeadCoveragePercent}%. ĐỪNG xếp hạng xưởng theo thời gian giao ở mức phủ này.`,
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
      "Đơn sản xuất KHÔNG có cột ngày nhận hàng — thời gian giao phải suy bằng cách ghép với phiếu nhập kho, và lô nào không ghép được một-một thì để CHƯA BIẾT chứ không đoán.",
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

import { and, eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { receiptUnitCostFromMarketer, type MarketerPriceEntry } from "@/lib/constants/marketer-price";

/**
 * ═══════════ GIÁ NHẬP KHO = GIÁ BÁO MKT (chủ shop chốt 25/09/2026) ═══════════
 *
 * Luật: `receiptUnitCostFromMarketer` trong `lib/constants/marketer-price.ts`. Tệp này là nơi DUY NHẤT
 * phía kho đọc bảng giá báo — để đặt đơn giá cho dòng PHIẾU NHẬP HÀNG MỚI, không phải để tính một báo
 * cáo nào. Báo cáo lợi nhuận shop vẫn chỉ đọc phiếu kho (`tests/marketer-price.test.ts` quét mã nguồn).
 *
 * Hai người dùng:
 *  · `createStockReceipt` — phiếu mới: máy chủ tự điền giá, bỏ qua giá client gửi lên.
 *  · "Định giá phiếu nhập theo giá báo MKT" — phiếu CŨ ghi giá 0: xem trước → người bấm xác nhận.
 *    CHỈ lấp dòng đang 0/trống; dòng đã có giá thật KHÔNG BAO GIỜ bị ghi đè.
 */

const ri = schema.stockReceiptItems;
const r = schema.stockReceipts;
const pv = schema.productVariants;
const p = schema.products;
const mp = schema.marketerPrices;

type VariantPrices = { productId: string; code: string; entries: MarketerPriceEntry[] };

/**
 * Giá dùng được cho SỔ KHO. Giá báo 0đ là một lời khai thật ở phía MKT, nhưng trên phiếu kho giá 0 lại
 * mang nghĩa "phiếu không ghi đơn giá" (`LAST_RECEIPT_COST` bỏ qua nó) — nên ghi 0 lên phiếu là âm
 * thầm biến một giá đã khai thành "chưa biết". Coi như chưa định giá được và nói ra.
 */
function giaChoSoKho(v: VariantPrices | undefined, at: Date): number | null {
  const gia = v ? receiptUnitCostFromMarketer(v.entries, at) : null;
  return gia != null && gia > 0 ? gia : null;
}

/** Bảng giá báo của từng mẫu mã (qua sản phẩm của nó). Mẫu mã không có dòng giá nào ⇒ `entries` rỗng. */
export async function marketerPriceEntriesByVariant(db: Db, variantIds: readonly string[]): Promise<Map<string, VariantPrices>> {
  const out = new Map<string, VariantPrices>();
  if (!variantIds.length) return out;
  const rows = await db
    .select({ variantId: pv.id, productId: pv.productId, code: p.customId, name: p.name, price: mp.price, effectiveFrom: mp.effectiveFrom })
    .from(pv)
    .innerJoin(p, eq(p.id, pv.productId))
    .leftJoin(mp, eq(mp.productId, pv.productId))
    .where(inArray(pv.id, [...variantIds]));
  for (const row of rows) {
    const cur = out.get(row.variantId) ?? { productId: row.productId, code: row.code || row.name, entries: [] };
    if (row.price != null && row.effectiveFrom) cur.entries.push({ price: row.price, effectiveFrom: row.effectiveFrom });
    out.set(row.variantId, cur);
  }
  return out;
}

/** Sản phẩm nào đã có ít nhất một dòng giá báo — form nhập hàng dùng để báo trước mã nào sẽ "chưa biết giá". */
export async function productIdsHavingMarketerPrice(db: Db): Promise<string[]> {
  const rows = await db.selectDistinct({ productId: mp.productId }).from(mp);
  return rows.map((x) => x.productId);
}

/**
 * Đơn giá cho các dòng của MỘT phiếu nhập hàng mới, theo ngày nhập. `missing` = mã chưa có giá báo —
 * dòng đó ghi 0 (chưa biết giá), phiếu vẫn lưu.
 */
export async function priceReceiptLines(db: Db, variantIds: readonly string[], receivedAt: Date): Promise<{ price: Map<string, number>; missing: string[] }> {
  const table = await marketerPriceEntriesByVariant(db, [...new Set(variantIds)]);
  const price = new Map<string, number>();
  const missing = new Set<string>();
  for (const id of variantIds) {
    const v = table.get(id);
    const gia = giaChoSoKho(v, receivedAt);
    if (gia == null) missing.add(v?.code || id);
    else price.set(id, gia);
  }
  return { price, missing: [...missing].sort() };
}

// ─────────────────────────── Phiếu CŨ ghi giá 0 ───────────────────────────

export type RepricingLine = { itemId: string; receiptId: string; variantId: string; code: string; quantity: number; receivedAt: Date; price: number | null };
export type RepricingByCode = { code: string; lines: number; quantity: number; price: number | null; amount: number };
export type RepricingPlan = {
  lines: RepricingLine[];
  byCode: RepricingByCode[];
  /** Dòng sẽ được định giá. */
  priced: { lines: number; quantity: number; amount: number; receipts: number };
  /** Dòng vẫn thiếu giá vì mã chưa có giá báo — nằm nguyên, không đoán. */
  missing: { lines: number; quantity: number; codes: string[] };
};

/** Gom kế hoạch định giá theo mã. Hàm THUẦN. */
export function summarizeRepricing(lines: readonly RepricingLine[]): Omit<RepricingPlan, "lines"> {
  const byCode = new Map<string, RepricingByCode>();
  const receipts = new Set<string>();
  const priced = { lines: 0, quantity: 0, amount: 0, receipts: 0 };
  const missing = { lines: 0, quantity: 0, codes: new Set<string>() };
  for (const l of lines) {
    const key = `${l.code}|${l.price ?? "?"}`;
    const g = byCode.get(key) ?? { code: l.code, lines: 0, quantity: 0, price: l.price, amount: 0 };
    g.lines += 1;
    g.quantity += l.quantity;
    if (l.price != null) {
      g.amount += l.quantity * l.price;
      priced.lines += 1;
      priced.quantity += l.quantity;
      priced.amount += l.quantity * l.price;
      receipts.add(l.receiptId);
    } else {
      missing.lines += 1;
      missing.quantity += l.quantity;
      missing.codes.add(l.code);
    }
    byCode.set(key, g);
  }
  priced.receipts = receipts.size;
  return {
    byCode: [...byCode.values()].sort((a, b) => Number(b.price != null) - Number(a.price != null) || b.amount - a.amount || a.code.localeCompare(b.code)),
    priced,
    missing: { lines: missing.lines, quantity: missing.quantity, codes: [...missing.codes].sort() },
  };
}

/** Dòng PHIẾU NHẬP HÀNG (số lượng dương) đang ghi giá 0 / trống — ứng viên duy nhất để lấp. */
const CHUA_CO_GIA = sql`coalesce(${ri.unitCost}, 0) = 0 and ${ri.quantity} > 0 and ${r.kind} = 'RECEIPT'`;

export async function receiptRepricingPlan(db: Db): Promise<RepricingPlan> {
  const rows = await db
    .select({ itemId: ri.id, receiptId: ri.receiptId, variantId: ri.variantId, quantity: ri.quantity, receivedAt: r.receivedAt })
    .from(ri)
    .innerJoin(r, eq(r.id, ri.receiptId))
    .where(CHUA_CO_GIA);
  const table = await marketerPriceEntriesByVariant(db, [...new Set(rows.map((x) => x.variantId))]);
  const lines: RepricingLine[] = rows.map((x) => {
    const v = table.get(x.variantId);
    return { ...x, code: v?.code || x.variantId, price: giaChoSoKho(v, x.receivedAt) };
  });
  return { lines, ...summarizeRepricing(lines) };
}

/**
 * Ghi kế hoạch vào sổ kho trong MỘT giao dịch. Mỗi lệnh cập nhật mang lại điều kiện "đang 0/trống" —
 * hai người bấm cùng lúc, hay một người vừa sửa tay một dòng, thì dòng đó không bị ghi đè.
 * Tổng giá trị phiếu tính lại từ dòng, cùng công thức lúc lập phiếu.
 */
export async function applyReceiptRepricing(db: Db, plan: RepricingPlan): Promise<{ lines: number; receipts: string[] }> {
  const todo = plan.lines.filter((l): l is RepricingLine & { price: number } => l.price != null);
  let n = 0;
  const touched = new Set<string>();
  await db.transaction(async (tx) => {
    for (const l of todo) {
      const done = await tx
        .update(ri)
        .set({ unitCost: l.price })
        .where(and(eq(ri.id, l.itemId), sql`coalesce(${ri.unitCost}, 0) = 0`))
        .returning({ id: ri.id });
      if (done.length) {
        n += 1;
        touched.add(l.receiptId);
      }
    }
    if (touched.size) {
      await tx
        .update(r)
        .set({ totalCost: sql`(select coalesce(sum(greatest(x.quantity, 0) * coalesce(x.unit_cost, 0)), 0) from stock_receipt_items x where x.receipt_id = ${r.id})` })
        .where(inArray(r.id, [...touched]));
    }
  });
  return { lines: n, receipts: [...touched] };
}

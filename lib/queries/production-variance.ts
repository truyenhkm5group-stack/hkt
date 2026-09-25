import { and, desc, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ESTIMATED_COST_KEY, parseEstimatedCosts, type EstimatedCostMap } from "@/lib/constants/estimated-cost";
import { marketerPriceAt, type MarketerPriceEntry } from "@/lib/constants/marketer-price";
import type { ActualCost } from "@/lib/constants/workshop-ledger";
import { listMarketerPrices } from "@/lib/queries/marketer-price";
import { latestReceiptCost, type ProductCostView } from "@/lib/queries/workshop-ledger";
import { getSettingJson } from "@/lib/settings";

/**
 * ═══════════ CHÊNH LỆCH GIÁ SẢN XUẤT — NĂM CON SỐ, MỘT MỐC SO ═══════════
 *
 * Company OS · Agent F. Chỉ ĐỌC. Không một con số nào ở đây đi vào lợi nhuận, lương, giá vốn hay
 * dòng tiền: giá vốn vào lợi nhuận có ĐÚNG MỘT nguồn là phiếu kho (AGENTS.md mục 13, 15).
 * `tests/company-os-economics.test.ts` quét mã nguồn: không truy vấn lợi nhuận / chi phí / lương nào
 * được import tệp này.
 *
 * Năm con số cho MỘT mã, mỗi con số là lời khai của một khâu khác nhau:
 *
 *   giá báo MKT      — giá chốt tính cho marketer (bảng `marketer_prices`, đang hiệu lực tại `now`)
 *   giá ước tính     — giá vốn DỰ TÍNH chủ shop đặt (`profit.estimatedCosts`)
 *   giá lệnh SX (PO) — đơn giá trên lệnh sản xuất gần nhất có ghi giá (`production_orders.unit_cost`)
 *   giá SX thực tế   — (vải + công) ÷ hàng xưởng trả (`productActualCost`, sổ đặt xưởng)
 *   giá phiếu kho    — giá nhập bình quân của phiếu nhập kho gần nhất — MỐC SO
 *
 * ─── VÌ SAO MỐC SO LÀ PHIẾU KHO ───
 *
 * Nó là con số DUY NHẤT trong năm con số thật sự đi vào giá vốn của báo cáo lợi nhuận. Bốn con số
 * còn lại là kế hoạch hoặc lời khai; câu hỏi có ích là "mỗi kế hoạch cách con số lợi nhuận đang dùng
 * bao xa" — chứ không phải "con số nào đúng". Chênh = PHIẾU KHO − NGUỒN (giữ đúng chiều của cột
 * "Chênh lệch" đã có trên trang Giá SX thực tế): dương = phiếu kho đang ghi CAO hơn nguồn ấy.
 *
 * Chỉ để trống là CHƯA BIẾT (`null`, in "—"), không bao giờ 0. Lệnh SX ghi 0 ₫ là "chưa nhập giá"
 * (chú thích cột `unit_cost`), nên bị bỏ như `NULL`.
 */

export type VarianceSource = "MARKETER_PRICE" | "ESTIMATED_COST" | "PO_UNIT_COST" | "WORKSHOP_ACTUAL";

export const VARIANCE_SOURCES: readonly VarianceSource[] = ["WORKSHOP_ACTUAL", "PO_UNIT_COST", "ESTIMATED_COST", "MARKETER_PRICE"];

export const VARIANCE_SOURCE_LABEL: Record<VarianceSource, string> = {
  WORKSHOP_ACTUAL: "Giá SX thực tế (xưởng)",
  PO_UNIT_COST: "Giá lệnh SX",
  ESTIMATED_COST: "Giá ước tính",
  MARKETER_PRICE: "Giá báo MKT",
};

export type VariancePoint = { value: number | null; at: Date | null; note: string };

export type PoCost = { productId: string; productCode: string; productName: string; unitCost: number; code: string; at: Date };

export type ProductionVarianceRow = {
  productId: string | null;
  productCode: string;
  productName: string;
  /** Dòng của sổ đặt xưởng (tiền vải, tiền công, hàng trả…). `null` = mã chỉ có lệnh SX, chưa có lô trong sổ. */
  workshop: (Pick<ProductCostView, "batches" | "unassignedFabric" | "marketerName"> & { cost: ActualCost }) | null;
  /** MỐC SO: giá phiếu nhập kho gần nhất. */
  baseline: VariancePoint;
  sources: Record<VarianceSource, VariancePoint>;
  /** Chênh = phiếu kho − nguồn. `null` khi thiếu một trong hai vế. */
  variance: Record<VarianceSource, number | null>;
};

/** Phiếu kho − nguồn. Thiếu vế nào là CHƯA BIẾT, không phải 0. */
export function receiptVariance(receipt: number | null, source: number | null): number | null {
  return receipt === null || source === null ? null : receipt - source;
}

/**
 * Dựng bảng chênh lệch. Hàm THUẦN: đồng hồ đi vào qua `now`, dữ liệu đi vào qua tham số — kiểm thử
 * không phụ thuộc giờ chạy (mục 50, 65).
 */
export function buildProductionVariance(input: {
  ledgerProducts: readonly ProductCostView[];
  poCosts: ReadonlyMap<string, PoCost>;
  /** Giá phiếu kho gần nhất cho mã CHỈ có lệnh SX (mã trong sổ đặt xưởng đã mang sẵn con số này). */
  poOnlyReceipts: ReadonlyMap<string, { unitCost: number; at: Date }>;
  estimated: EstimatedCostMap;
  marketerPrices: ReadonlyMap<string, readonly MarketerPriceEntry[]>;
  now: Date;
}): ProductionVarianceRow[] {
  const row = (p: {
    productId: string | null;
    productCode: string;
    productName: string;
    workshop: ProductionVarianceRow["workshop"];
    receipt: number | null;
    receiptAt: Date | null;
    marketerPrice: number | null;
  }): ProductionVarianceRow => {
    const po = p.productId ? input.poCosts.get(p.productId) : undefined;
    const est = p.productId ? input.estimated[p.productId] : undefined;
    const sources: Record<VarianceSource, VariancePoint> = {
      WORKSHOP_ACTUAL: p.workshop
        ? { value: p.workshop.cost.unitCost, at: null, note: p.workshop.cost.reason }
        : { value: null, at: null, note: "Chưa có lô nào trong sổ đặt xưởng" },
      PO_UNIT_COST: po ? { value: po.unitCost, at: po.at, note: `lệnh ${po.code}` } : { value: null, at: null, note: p.productId ? "Chưa có lệnh SX nào ghi giá" : "Mã chưa khớp sản phẩm" },
      ESTIMATED_COST: est ? { value: est.unitCost, at: est.setAt ? new Date(est.setAt) : null, note: est.reason || "không ghi lý do" } : { value: null, at: null, note: "Chưa đặt giá ước tính" },
      MARKETER_PRICE: { value: p.marketerPrice, at: null, note: p.marketerPrice === null ? "Chưa có giá báo đang hiệu lực" : "đang hiệu lực" },
    };
    const variance = Object.fromEntries(VARIANCE_SOURCES.map((k) => [k, receiptVariance(p.receipt, sources[k].value)])) as Record<VarianceSource, number | null>;
    return {
      productId: p.productId,
      productCode: p.productCode,
      productName: p.productName,
      workshop: p.workshop,
      baseline: { value: p.receipt, at: p.receiptAt, note: p.receipt === null ? (p.productId ? "Chưa có phiếu nhập" : "Mã chưa khớp sản phẩm") : "phiếu nhập gần nhất" },
      sources,
      variance,
    };
  };

  const seen = new Set<string>();
  const out: ProductionVarianceRow[] = input.ledgerProducts.map((p) => {
    if (p.productId) seen.add(p.productId);
    return row({
      productId: p.productId,
      productCode: p.productCode,
      productName: p.productName,
      workshop: { batches: p.batches, unassignedFabric: p.unassignedFabric, marketerName: p.marketerName, cost: p.cost },
      receipt: p.receiptUnitCost,
      receiptAt: p.receiptAt,
      // Sổ đặt xưởng đã đọc giá báo đang hiệu lực bằng đúng `marketerPriceAt` — dùng lại, không tra lần hai.
      marketerPrice: p.marketerPrice,
    });
  });
  // Mã CHỈ có lệnh SX (chưa lên sổ đặt xưởng) vẫn phải có dòng: giá lệnh SX của nó là kế hoạch cần so.
  for (const po of input.poCosts.values()) {
    if (seen.has(po.productId)) continue;
    out.push(
      row({
        productId: po.productId,
        productCode: po.productCode,
        productName: po.productName,
        workshop: null,
        receipt: input.poOnlyReceipts.get(po.productId)?.unitCost ?? null,
        receiptAt: input.poOnlyReceipts.get(po.productId)?.at ?? null,
        marketerPrice: marketerPriceAt(input.marketerPrices.get(po.productId) ?? [], input.now),
      }),
    );
  }
  return out.sort((a, b) => a.productCode.localeCompare(b.productCode, "vi"));
}

/** Đơn giá trên lệnh SX GẦN NHẤT có ghi giá (> 0), chưa huỷ, của từng mã. */
async function latestPoCosts(): Promise<Map<string, PoCost>> {
  const db = await getDb();
  const po = schema.productionOrders;
  const rows = await db
    .select({ productId: po.productId, productCode: po.productCode, productName: po.productName, unitCost: po.unitCost, code: po.code, createdAt: po.createdAt })
    .from(po)
    .where(and(sql`${po.productId} is not null`, sql`${po.unitCost} > 0`, sql`${po.status} <> 'CANCELLED'`))
    .orderBy(desc(po.createdAt));
  const out = new Map<string, PoCost>();
  for (const r of rows) {
    if (!r.productId || out.has(r.productId)) continue;
    out.set(r.productId, { productId: r.productId, productCode: r.productCode, productName: r.productName, unitCost: Number(r.unitCost), code: r.code, at: r.createdAt });
  }
  return out;
}

/**
 * Báo cáo chênh lệch giá SX. Nhận dòng của sổ đặt xưởng mà trang VỪA đọc (`getWorkshopLedger`) thay
 * vì tự đọc bốn bảng của sổ — sổ ấy chỉ được đọc ở tệp của chính nó (`tests/workshop-ledger.test.ts`).
 */
export async function getProductionVariance(ledgerProducts: readonly ProductCostView[], now: Date = new Date()): Promise<ProductionVarianceRow[]> {
  const [poCosts, estimatedRaw, prices] = await Promise.all([latestPoCosts(), getSettingJson<Record<string, unknown>>(ESTIMATED_COST_KEY, {}), listMarketerPrices()]);
  const poOnly = [...poCosts.keys()].filter((id) => !ledgerProducts.some((p) => p.productId === id));
  // Cùng MỘT truy vấn giá phiếu kho với sổ đặt xưởng — mốc so của hai loại dòng không được lệch nhau.
  const poOnlyReceipts = await latestReceiptCost(poOnly);
  const marketerPrices = new Map<string, MarketerPriceEntry[]>();
  for (const p of prices) {
    if (!poOnly.includes(p.productId)) continue;
    marketerPrices.set(p.productId, [...(marketerPrices.get(p.productId) ?? []), { price: p.price, effectiveFrom: p.effectiveFrom }]);
  }
  return buildProductionVariance({ ledgerProducts, poCosts, poOnlyReceipts, estimated: parseEstimatedCosts(estimatedRaw), marketerPrices, now });
}


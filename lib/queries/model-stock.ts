import { and, eq, inArray, sql } from "drizzle-orm";
import { chayKhongJit, getDb, schema } from "@/db";
import { DAMAGED_ITEM_CONDITIONS } from "@/lib/constants/inventory";
import { TERMINAL_DISPOSITIONS } from "@/lib/constants/return-disposition";
import { openPoQtyByVariant } from "@/lib/queries/inventory-decision";
import { availableStockExpr, erpStockExpr, splitSignedStock, stockKnownExpr, variantReceiptsSubquery, variantSalesSubquery } from "@/lib/queries/stock";
import { unsplitOpenBatchUnitsForProduct } from "@/lib/queries/workshop-ledger";
import { listPendingInspections } from "@/lib/returns/inspection";

/**
 * ═══════════ TRẠNG THÁI TỒN THEO MẪU (Company OS · Agent D · hợp đồng chung §6) ═══════════
 *
 * `getModelStockStates(productId)` — một chỗ đọc cho trang 360 và cockpit, để không màn hình nào tự
 * tính tồn. KHÔNG có công thức mới: mọi con số là biểu thức / hàm đã có:
 *
 *  · tồn thực tế / khả dụng / đã chốt / đang hoàn — `erpStockExpr`, `availableStockExpr`,
 *    `variantSalesSubquery.reserved` / `.awaitingReturn` (lib/queries/stock.ts, luật 10);
 *  · đang sản xuất — `openPoQtyByVariant` (lệnh `SENT` + phần chưa trả của lô `OPEN`, không đếm
 *    trùng — luật 70); lô chưa chia màu/size đếm riêng ở mức MẪU, không chia hộ;
 *  · chờ kiểm — `listPendingInspections` (kiện `RECEIVED` chưa đếm, món theo `product-context`);
 *  · hỏng — dòng `return_inspection_items` mang kết luận trong `DAMAGED_ITEM_CONDITIONS`, TRỪ phần đã
 *    có KẾT CỤC CUỐI trong sổ `return_dispositions` (Agent E: nhập lại sau sửa · huỷ · trả xưởng) — ô
 *    này là "hỏng CÒN CHỜ XỬ LÝ trên kệ". Món nhập lại sau sửa đã nằm ở tồn thực tế (phiếu RETURN);
 *    đếm nó thêm ở đây là đếm hai lần. Chỉ trừ theo dòng từng món (`inspection_item_id`): kết cục của
 *    kiện kiểm cả kiện không có mẫu mã và cũng chưa bao giờ được cộng vào ô này.
 *
 * MỖI Ô LÀ `number | null`; `null` = CHƯA BIẾT, không phải 0 (luật 42):
 *  · chưa có phiếu nhập (`stockKnown = false`) ⇒ tồn thực tế và khả dụng `null`;
 *  · mẫu đã có hàng hoàn quay về kho mà CHƯA có dòng kiểm từng món nào ⇒ hỏng `null` (vắng bằng
 *    chứng không phải bằng chứng vắng — lib/constants/inspection-truth.ts). Chưa có kiện nào quay về
 *    ⇒ 0 thật.
 *
 * `returning` (đang hoàn về) GỒM CẢ kiện đã về kho chờ kiểm — `awaitingReturn` của sổ kho chỉ ra khỏi
 * nhóm khi có phiếu tái nhập. `pendingQc` là PHẦN TÁCH của nó, KHÔNG được cộng hai số.
 * Ba trạng thái dẫn xuất không phải bút toán sổ kho: hàng hoàn chỉ vào tồn bằng phiếu `RETURN`.
 */

export type StockCell = number | null;

export type VariantStockStates = {
  variantId: string;
  sku: string;
  color: string;
  size: string;
  removed: boolean;
  /** false = chưa có phiếu NHẬP HÀNG nào ⇒ tồn là CHƯA BIẾT. */
  stockKnown: boolean;
  actualStock: StockCell;
  available: StockCell;
  reserved: number;
  inProduction: number;
  returning: number;
  pendingQc: number;
  damaged: StockCell;
};

export type ModelStockStates = {
  productId: string;
  /**
   * Tổng theo mẫu. Tồn thực tế / khả dụng CHỈ CỘNG DÒNG DƯƠNG của mẫu mã đã biết tồn (cùng luật với
   * tổng trang chủ — `splitSignedStock`); dòng âm đếm riêng ở `negativeVariants` / `negativeQty`.
   * `null` khi KHÔNG mẫu mã nào biết tồn. Biết một phần ⇒ số là của phần đã biết; `coverage` nói
   * bao nhiêu mẫu mã đứng sau con số.
   */
  totals: {
    actualStock: StockCell;
    available: StockCell;
    reserved: number;
    inProduction: number;
    returning: number;
    pendingQc: number;
    damaged: StockCell;
    negativeVariants: number;
    negativeQty: number;
  };
  variants: VariantStockStates[];
  coverage: { variants: number; stockKnownVariants: number; damagedKnownVariants: number };
  basis: {
    /** `ITEM_QTY` khi mọi kiện chờ kiểm đều ghép được món; `ITEM_QTY_LOWER_BOUND` khi còn kiện chưa rõ món. */
    pendingQc: "ITEM_QTY" | "ITEM_QTY_LOWER_BOUND";
    /** Kiện chờ kiểm TOÀN SHOP chưa ghép được món nào về mẫu mã — không quy được cho mẫu này hay mẫu khác. */
    pendingQcUnattributedParcels: number;
    /** Danh sách chờ kiểm bị cắt ở trần đọc — số chờ kiểm có thể thiếu. */
    pendingQcTruncated: boolean;
    /** Món còn trong lô xưởng ĐANG MỞ của mẫu này nhưng lô chưa chia màu/size — không cộng vào mẫu mã nào. */
    inProductionUnsplitUnits: number;
    /** Ô lệnh SX không khớp được màu/size nào — số của TOÀN SHOP (hàm gốc không tách theo mẫu). */
    inProductionUnmappedUnitsShopWide: number;
    returningIncludesPendingQc: true;
    damagedConditions: readonly string[];
    /** Ô hỏng đã TRỪ phần có kết cục cuối trong `return_dispositions` (các kết cục ở `damagedMinusDispositions`). */
    damagedMinusDispositions: readonly string[];
  };
};

/** Trần đọc danh sách chờ kiểm — vượt thì `pendingQcTruncated = true`, không lặng lẽ thiếu. */
const PENDING_QC_READ_CAP = 5000;

function sumKnown(values: StockCell[]): StockCell {
  const known = values.filter((v): v is number => v !== null);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

export async function getModelStockStates(productId: string): Promise<ModelStockStates> {
  const db = await getDb();
  const pv = schema.productVariants;
  const variantRows = await db.select({ id: pv.id, sku: pv.sku, color: pv.color, size: pv.size, removed: pv.isRemoved }).from(pv).where(eq(pv.productId, productId));
  const ids = variantRows.map((v) => v.id);

  const empty: ModelStockStates = {
    productId,
    totals: { actualStock: null, available: null, reserved: 0, inProduction: 0, returning: 0, pendingQc: 0, damaged: null, negativeVariants: 0, negativeQty: 0 },
    variants: [],
    coverage: { variants: 0, stockKnownVariants: 0, damagedKnownVariants: 0 },
    basis: { pendingQc: "ITEM_QTY", pendingQcUnattributedParcels: 0, pendingQcTruncated: false, inProductionUnsplitUnits: 0, inProductionUnmappedUnitsShopWide: 0, returningIncludesPendingQc: true, damagedConditions: DAMAGED_ITEM_CONDITIONS, damagedMinusDispositions: TERMINAL_DISPOSITIONS },
  };
  if (!ids.length) return empty;

  const sales = variantSalesSubquery(db, ids);
  const receipts = variantReceiptsSubquery(db, ids);
  const rii = schema.returnInspectionItems;
  const itemVariant = sql<string>`coalesce(${rii.actualVariantId}, ${rii.expectedVariantId})`;

  const [ledger, itemRows, openPo, pending, disposed] = await Promise.all([
    // Cùng dạng truy vấn với sổ kho (họ `vsales`) — tắt JIT như mọi chỗ khác đọc nó.
    chayKhongJit(db, (tx) =>
      tx
        .select({
          variantId: pv.id,
          stockKnown: stockKnownExpr(receipts),
          stock: erpStockExpr(sales, receipts),
          available: availableStockExpr(sales, receipts),
          reserved: sql<number>`coalesce(${sales.reserved}, 0)`,
          awaitingReturn: sql<number>`coalesce(${sales.awaitingReturn}, 0)`,
          returnHandled: sql<number>`coalesce(${sales.returnHandled}, 0)`,
          returnIn: sql<number>`coalesce(${receipts.returnIn}, 0)`,
        })
        .from(pv)
        .leftJoin(sales, eq(sales.variantId, pv.id))
        .leftJoin(receipts, eq(receipts.variantId, pv.id))
        .where(inArray(pv.id, ids)),
    ),
    db
      .select({
        variantId: itemVariant,
        rows: sql<number>`count(*)`,
        damaged: sql<number>`coalesce(sum(${rii.actualQty}) filter (where ${inArray(rii.condition, [...DAMAGED_ITEM_CONDITIONS])}), 0)`,
      })
      .from(rii)
      .where(inArray(itemVariant, ids))
      .groupBy(itemVariant),
    openPoQtyByVariant(),
    listPendingInspections(PENDING_QC_READ_CAP),
    // Phần hỏng ĐÃ có kết cục cuối (nhập lại sau sửa · huỷ · trả xưởng), theo CÙNG mẫu mã của dòng kiểm.
    db
      .select({ variantId: itemVariant, qty: sql<number>`coalesce(sum(${schema.returnDispositions.qty}), 0)` })
      .from(schema.returnDispositions)
      .innerJoin(rii, eq(rii.id, schema.returnDispositions.inspectionItemId))
      .where(and(inArray(itemVariant, ids), inArray(rii.condition, [...DAMAGED_ITEM_CONDITIONS]), inArray(schema.returnDispositions.disposition, [...TERMINAL_DISPOSITIONS])))
      .groupBy(itemVariant),
  ]);

  // Lô đang mở chưa chia màu/size của CHÍNH mẫu này — đếm ở mức mẫu, không chia hộ.
  const inProductionUnsplitUnits = await unsplitOpenBatchUnitsForProduct(productId);

  // Chờ kiểm: món của kiện RECEIVED theo mẫu mã; kiện không ghép được món nào ⇒ đếm riêng, toàn shop.
  const idSet = new Set(ids);
  const pendingByVariant = new Map<string, number>();
  let unattributedParcels = 0;
  for (const parcel of pending) {
    const unresolved = parcel.itemsBasis === "NONE" || parcel.items.length === 0 || parcel.items.some((i) => !i.variantId);
    if (unresolved) unattributedParcels += 1;
    for (const item of parcel.items) {
      if (item.variantId && idSet.has(item.variantId)) pendingByVariant.set(item.variantId, (pendingByVariant.get(item.variantId) ?? 0) + item.quantity);
    }
  }

  const ledgerByVariant = new Map(ledger.map((l) => [l.variantId, l]));
  const itemsByVariant = new Map(itemRows.map((r) => [r.variantId, r]));
  const disposedByVariant = new Map(disposed.map((r) => [r.variantId, Number(r.qty)]));

  const variants: VariantStockStates[] = variantRows.map((v) => {
    const l = ledgerByVariant.get(v.id);
    const known = Boolean(l?.stockKnown);
    const it = itemsByVariant.get(v.id);
    // Đã có hàng hoàn QUAY VỀ kho (có phiếu tái nhập, hoặc kiện đã xử lý) mà chưa có dòng kiểm từng món ⇒ CHƯA BIẾT.
    const cameBack = Number(l?.returnHandled ?? 0) > 0 || Number(l?.returnIn ?? 0) > 0;
    // Hỏng CÒN CHỜ XỬ LÝ = hỏng đã kiểm − phần đã có kết cục cuối. Không bao giờ âm; CHƯA BIẾT vẫn là null.
    const damaged: StockCell = it ? Math.max(0, Number(it.damaged) - (disposedByVariant.get(v.id) ?? 0)) : cameBack ? null : 0;
    return {
      variantId: v.id,
      sku: v.sku,
      color: v.color,
      size: v.size,
      removed: v.removed,
      stockKnown: known,
      actualStock: known ? Number(l?.stock ?? 0) : null,
      available: known ? Number(l?.available ?? 0) : null,
      reserved: Number(l?.reserved ?? 0),
      inProduction: openPo.qtyByVariant.get(v.id) ?? 0,
      returning: Number(l?.awaitingReturn ?? 0),
      pendingQc: pendingByVariant.get(v.id) ?? 0,
      damaged,
    };
  });

  const signed = splitSignedStock(variants.map((v) => ({ stockKnown: v.stockKnown, stock: v.actualStock ?? 0, available: v.available ?? 0 })));
  const stockKnownVariants = variants.filter((v) => v.stockKnown).length;
  const sum = (pick: (v: VariantStockStates) => number) => variants.reduce((t, v) => t + pick(v), 0);

  return {
    productId,
    totals: {
      actualStock: stockKnownVariants ? signed.onHandPositive : null,
      available: stockKnownVariants ? signed.availablePositive : null,
      reserved: sum((v) => v.reserved),
      inProduction: sum((v) => v.inProduction),
      returning: sum((v) => v.returning),
      pendingQc: sum((v) => v.pendingQc),
      damaged: sumKnown(variants.map((v) => v.damaged)),
      negativeVariants: signed.negativeRows,
      negativeQty: signed.negativeQty,
    },
    variants,
    coverage: { variants: variants.length, stockKnownVariants, damagedKnownVariants: variants.filter((v) => v.damaged !== null).length },
    basis: {
      pendingQc: unattributedParcels ? "ITEM_QTY_LOWER_BOUND" : "ITEM_QTY",
      pendingQcUnattributedParcels: unattributedParcels,
      pendingQcTruncated: pending.length >= PENDING_QC_READ_CAP,
      inProductionUnsplitUnits,
      inProductionUnmappedUnitsShopWide: openPo.unmappedUnits,
      returningIncludesPendingQc: true,
      damagedConditions: DAMAGED_ITEM_CONDITIONS,
      damagedMinusDispositions: TERMINAL_DISPOSITIONS,
    },
  };
}

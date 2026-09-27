import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  OPEN_PO_STATUSES,
  poShortcutState,
  prefillDesignId,
  prefillSupplier,
  receiptPrefillFromPo,
  receiptShortcutState,
  type ReceiptPrefill,
  type ShortcutState,
  type SupplierPrefill,
} from "@/lib/constants/production-shortcuts";
import { linkedReceiptQty } from "@/lib/queries/workshop-ledger";

/**
 * ═══════════ ĐỌC CHO LỐI TẮT SẢN XUẤT (Company OS · Agent SC) ═══════════
 *
 * CHỈ ĐỌC. Không một lệnh ghi nào ở đây: lối tắt dựng dữ liệu điền sẵn cho màn hình có sẵn, người lưu
 * qua server action có sẵn (`saveProductionOrder`, `createStockReceipt`). Luật ở `lib/constants/production-shortcuts.ts`.
 */

const po = schema.productionOrders;

/** Nút "Lập lệnh SX" của từng bản duyệt của một mẫu: `designId → trạng thái nút`. */
export async function loadDesignPoShortcuts(i: { productId: string | null; designIds: readonly string[]; canWrite: boolean }): Promise<Record<string, ShortcutState>> {
  const out: Record<string, ShortcutState> = {};
  if (!i.designIds.length) return out;
  const db = await getDb();
  const openOrders = i.productId
    ? await db
        .select({ id: po.id, code: po.code, status: po.status, designVersionId: po.designVersionId })
        .from(po)
        .where(and(eq(po.productId, i.productId), inArray(po.status, [...OPEN_PO_STATUSES]), isNotNull(po.designVersionId)))
    : [];
  for (const d of i.designIds) out[d] = poShortcutState({ canWrite: i.canWrite, productId: i.productId, designVersionId: d, openOrders });
  return out;
}

/**
 * Bản duyệt + xưởng điền sẵn khi trình sửa lệnh mở từ lối tắt (`?design=`). Mã bản duyệt lạ (không thuộc
 * mẫu của sản phẩm) ⇒ không chọn gì, không điền xưởng — `invalidDesign` để màn hình nói ra.
 */
export async function getNewPoPrefill(designOptions: readonly { id: string; version: number }[], requested: string | null): Promise<{ designVersionId: string | null; designVersion: number | null; supplier: SupplierPrefill | null; invalidDesign: boolean }> {
  const designVersionId = prefillDesignId(designOptions, requested);
  if (!designVersionId) return { designVersionId: null, designVersion: null, supplier: null, invalidDesign: Boolean((requested ?? "").trim()) };
  const db = await getDb();
  const dv = schema.designVersions;
  const sm = schema.samples;
  const tp = schema.productionTopics;
  const [r] = await db
    .select({ sampleSupplierId: sm.supplierId, topicId: sm.topicId, topicSupplierId: tp.supplierId })
    .from(dv)
    .innerJoin(sm, eq(sm.id, dv.sampleId))
    .leftJoin(tp, eq(tp.id, sm.topicId))
    .where(eq(dv.id, designVersionId))
    .limit(1);
  // Tên xưởng đọc từ DANH MỤC theo khoá (luật 34) — không lấy chữ từ URL.
  const ids = [r?.topicSupplierId, r?.sampleSupplierId].filter((x): x is string => Boolean(x));
  const names = ids.length ? await db.select({ id: schema.suppliers.id, name: schema.suppliers.name }).from(schema.suppliers).where(inArray(schema.suppliers.id, ids)) : [];
  const ten = (id: string | null | undefined) => (id ? (names.find((n) => n.id === id)?.name ?? null) : null);
  return {
    designVersionId,
    designVersion: designOptions.find((d) => d.id === designVersionId)?.version ?? null,
    supplier: prefillSupplier({ topicSupplier: ten(r?.topicSupplierId), sampleSupplier: ten(r?.sampleSupplierId) }),
    invalidDesign: false,
  };
}

export type PoReceiptPrefill = {
  po: { id: string; code: string; status: string; productId: string | null; productLabel: string; supplier: string; totalQty: number };
  prefill: ReceiptPrefill;
  state: ShortcutState;
};

/**
 * Hộp thoại Nhập hàng điền sẵn theo MỘT lệnh: số còn phải nhập từng mẫu mã = ô lệnh − đã nhập qua phiếu
 * NHẬP HÀNG nối lệnh (`linkedReceiptQty("order")` của sổ đặt xưởng — cùng số `openPoQtyByVariant` trừ).
 * Mẫu mã đã gỡ (`is_removed`) không có trên hộp thoại ⇒ ô của nó rơi vào `unmapped`, được in ra.
 */
export async function getPoReceiptPrefill(poId: string, canWrite: boolean): Promise<PoReceiptPrefill | null> {
  const db = await getDb();
  const [o] = await db
    .select({ id: po.id, code: po.code, status: po.status, productId: po.productId, productCode: po.productCode, productName: po.productName, cells: po.cells, supplier: po.supplier, totalQty: po.totalQty })
    .from(po)
    .where(eq(po.id, poId))
    .limit(1);
  if (!o) return null;
  const pv = schema.productVariants;
  const [variants, received] = await Promise.all([
    o.productId ? db.select({ id: pv.id, productId: pv.productId, color: pv.color, size: pv.size }).from(pv).where(and(eq(pv.productId, o.productId), eq(pv.isRemoved, false))) : Promise.resolve([]),
    linkedReceiptQty("order"),
  ]);
  const prefill = receiptPrefillFromPo({ productId: o.productId, cells: (o.cells ?? {}) as Record<string, number> }, variants, received.get(o.id) ?? new Map());
  return {
    po: { id: o.id, code: o.code, status: o.status, productId: o.productId, productLabel: `${o.productCode ? `${o.productCode} · ` : ""}${o.productName}`, supplier: o.supplier, totalQty: o.totalQty },
    prefill,
    state: receiptShortcutState({ canWrite, status: o.status, productId: o.productId, poId: o.id, remainingTotal: prefill.remainingTotal }),
  };
}

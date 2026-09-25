import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { formatDate, vnDateKey, vnStartOfDay } from "@/lib/format";
import { resolveProductByCode } from "@/lib/queries/product-code";
import { planFromSheets, type SheetBatchPlan, type SheetFabricPlan, type SheetPlan } from "@/lib/workshop/sheet-import";

/**
 * ═══════════ NHẬP SỔ ĐẶT XƯỞNG TỪ BẢNG TÍNH — LÕI XEM TRƯỚC + GHI ═══════════
 *
 * Nhận DÒNG bảng tính đã đọc (không tự gọi mạng) để bài kiểm chạy được trên CSDL thật mà không cần
 * Google. Server Action (`lib/actions/workshop-ledger.ts`) đọc hai trang rồi gọi hai hàm này.
 *
 * Hai bước, một phép ghép (`planFromSheets`, hàm thuần): XEM TRƯỚC chỉ đọc; NHẬP ghi đúng những dòng
 * mà bước xem trước gọi là MỚI, trong MỘT giao dịch. Nhập lại lần hai không đẻ thêm dòng nào: lô đã có
 * (mã + lô, cùng ngày đặt + SL đặt) và đợt vải đã có (mã + ngày đặt + thành tiền) đều bị bỏ qua. Lô
 * trùng mã + lô mà KHÁC số liệu là XUNG ĐỘT — không ghi đè, người quyết.
 */

export type SheetImportRowStatus = "NEW" | "EXISTS" | "CONFLICT";
export type SheetImportPreview = {
  batches: (SheetBatchPlan & { status: SheetImportRowStatus; productMatched: boolean; reason: string })[];
  fabrics: (SheetFabricPlan & { status: SheetImportRowStatus; productMatched: boolean; batchLinkable: boolean; reason: string })[];
  skipped: SheetPlan["skipped"];
  notices: string[];
};

const dayKey = (d: Date) => vnDateKey(d);

export async function previewSheetRows(finished: string[][], fabric: string[][]): Promise<SheetImportPreview | { error: string }> {
  const plan = planFromSheets(finished, fabric);
  if ("error" in plan) return plan;
  const db = await getDb();
  const codes = [...new Set([...plan.batches.map((b) => b.code), ...plan.fabrics.map((f) => f.code)])];
  const [daCoLo, daCoVai, sanPham] = await Promise.all([
    codes.length ? db.select({ code: schema.productionBatches.productCode, batchNo: schema.productionBatches.batchNo, orderedAt: schema.productionBatches.orderedAt, orderedQty: schema.productionBatches.orderedQty }).from(schema.productionBatches).where(inArray(schema.productionBatches.productCode, codes)) : [],
    codes.length ? db.select({ code: schema.fabricOrders.productCode, orderedAt: schema.fabricOrders.orderedAt, amount: schema.fabricOrders.amount }).from(schema.fabricOrders).where(inArray(schema.fabricOrders.productCode, codes)) : [],
    Promise.all(codes.map(async (c) => [c, await resolveProductByCode(c)] as const)),
  ]);
  const khopSanPham = new Map(sanPham.map(([c, p]) => [c, Boolean(p)] as const));
  const loTrongErp = new Map(daCoLo.map((b) => [`${b.code}#${b.batchNo}`, b] as const));
  const batches = plan.batches.map((b) => {
    const cu = loTrongErp.get(`${b.code}#${b.batchNo}`);
    const status: SheetImportRowStatus = !cu ? "NEW" : dayKey(cu.orderedAt) === b.orderedAt && cu.orderedQty === b.orderedQty ? "EXISTS" : "CONFLICT";
    const reason = status === "EXISTS" ? "Đã có trong ERP — bỏ qua" : status === "CONFLICT" ? `ERP đã có ${b.code} lô ${b.batchNo} với số liệu khác (đặt ${formatDate(cu!.orderedAt)}, ${cu!.orderedQty} cái) — không ghi đè, sửa tay` : "";
    return { ...b, status, productMatched: khopSanPham.get(b.code) ?? false, reason };
  });
  const loSeCo = new Set([...daCoLo.map((b) => `${b.code}#${b.batchNo}`), ...batches.filter((b) => b.status === "NEW").map((b) => `${b.code}#${b.batchNo}`)]);
  const vaiDaCo = new Set(daCoVai.map((f) => `${f.code}#${dayKey(f.orderedAt)}#${f.amount}`));
  const fabrics = plan.fabrics.map((f) => {
    const status: SheetImportRowStatus = vaiDaCo.has(`${f.code}#${f.orderedAt}#${f.amount}`) ? "EXISTS" : "NEW";
    const batchLinkable = f.batchNoRef != null && loSeCo.has(`${f.code}#${f.batchNoRef}`);
    return { ...f, status, productMatched: khopSanPham.get(f.code) ?? false, batchLinkable, reason: status === "EXISTS" ? "Đã có trong ERP — bỏ qua" : f.batchNoRef != null && !batchLinkable ? `Ghi chú nói lô ${f.batchNoRef} nhưng ERP không có lô đó — để trống` : "" };
  });
  return { batches, fabrics, skipped: plan.skipped, notices: plan.notices };
}

export type SheetImportActor = { id: string | null; name: string };

/** Ghi những dòng MỚI của bản xem trước, trong một giao dịch. */
export async function applySheetPreview(p: SheetImportPreview, actor: SheetImportActor) {
  const moiLo = p.batches.filter((b) => b.status === "NEW");
  const moiVai = p.fabrics.filter((f) => f.status === "NEW");
  const products = new Map<string, { id: string; name: string } | null>();
  for (const c of new Set([...moiLo.map((b) => b.code), ...moiVai.map((f) => f.code)])) products.set(c, await resolveProductByCode(c));
  const who = { createdByUserId: actor.id, createdBy: actor.name };
  const db = await getDb();
  const dem = { batches: 0, deliveries: 0, fabrics: 0, payments: 0 };
  await db.transaction(async (tx) => {
    for (const b of moiLo) {
      const sp = products.get(b.code) ?? null;
      const [row] = await tx
        .insert(schema.productionBatches)
        .values({
          productId: sp?.id ?? null,
          productCode: b.code,
          productName: sp?.name ?? "",
          batchNo: b.batchNo,
          orderedAt: vnStartOfDay(b.orderedAt),
          orderedQty: b.orderedQty,
          agreedQty: b.agreedQty,
          dueDate: b.dueDate ? vnStartOfDay(b.dueDate) : null,
          laborUnitPrice: b.laborUnitPrice,
          adjustment: b.adjustment,
          adjustmentNote: b.adjustmentNote,
          workshopPenalty: b.workshopPenalty,
          status: b.done ? "DONE" : "OPEN",
          doneAt: b.done && b.doneAt ? vnStartOfDay(b.doneAt) : null,
          note: b.note,
          ...who,
        })
        .returning({ id: schema.productionBatches.id });
      dem.batches += 1;
      for (const d of b.deliveries) {
        await tx.insert(schema.productionDeliveries).values({ batchId: row.id, deliveredAt: vnStartOfDay(d.date), quantity: d.quantity, note: d.note, ...who });
        dem.deliveries += 1;
      }
      for (const pay of b.payments) {
        await tx.insert(schema.supplierPayments).values({ batchId: row.id, kind: pay.kind, amount: pay.amount, paidAt: vnStartOfDay(pay.paidAt), method: "OTHER", reference: `Bảng tính dòng ${b.row}`, note: pay.note, ...who });
        dem.payments += 1;
      }
    }
    for (const f of moiVai) {
      const sp = products.get(f.code) ?? null;
      let batchId: string | null = null;
      if (f.batchLinkable && f.batchNoRef != null) {
        const lo = await tx.query.productionBatches.findFirst({ where: and(eq(schema.productionBatches.productCode, f.code), eq(schema.productionBatches.batchNo, f.batchNoRef)), columns: { id: true, productId: true } });
        batchId = lo?.id ?? null;
      }
      const [row] = await tx
        .insert(schema.fabricOrders)
        .values({ productId: sp?.id ?? null, productCode: f.code, batchId, orderedAt: vnStartOfDay(f.orderedAt), receivedAt: f.receivedAt ? vnStartOfDay(f.receivedAt) : null, quantity: f.quantity, unit: "", unitPrice: f.unitPrice, amount: f.amount, description: f.description, note: f.note, ...who })
        .returning({ id: schema.fabricOrders.id });
      dem.fabrics += 1;
      for (const pay of f.payments) {
        await tx.insert(schema.supplierPayments).values({ fabricOrderId: row.id, kind: pay.kind, amount: pay.amount, paidAt: vnStartOfDay(pay.paidAt), method: "OTHER", reference: `Bảng tính Vải dòng ${f.row}`, note: pay.note, ...who });
        dem.payments += 1;
      }
    }
  });
  return dem;
}

"use server";

import { eq, inArray } from "drizzle-orm";
import { guardSecondApproval } from "@/lib/actions/approvals";
import { revalidatePath } from "next/cache";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import type { Actor } from "@/lib/constants/actor";
import { vnStartOfDay } from "@/lib/format";
import { publish } from "@/lib/realtime/bus";
import { settleReturnsForReceipt } from "@/lib/returns/warehouse";
import { deleteReceiptSchema, stockReceiptSchema } from "@/lib/validation/stock";
import { deleteStockReceiptCore } from "@/lib/inventory/receipt-delete";
import { validateProductionLink } from "@/lib/inventory/production-link";
import { matchSupplier } from "@/lib/constants/suppliers";
import { supplierCatalog } from "@/lib/queries/suppliers";

export type ActionResult = { ok: true; id?: string } | { error: string };

/** Lỗi nghiệp vụ khi đóng kiện hoàn — ném ra để huỷ giao dịch rồi trả `{ error }` cho màn hình, không phải lỗi hệ thống. */
class SettleError extends Error {}

function firstIssue(error: { issues: { message: string }[] }) {
  return error.issues[0]?.message ?? "Dữ liệu không hợp lệ";
}

function revalidate() {
  for (const path of ["/inventory/receipts", "/inventory/returns", "/products", "/inventory", "/"]) revalidatePath(path);
}

/** Tạo phiếu kho (nhập mới / tái nhập hàng hoàn / xuất tay / điều chỉnh kiểm kê). Giá nhập > 0 trên phiếu NHẬP MỚI sẽ cập nhật giá vốn gần nhất của mẫu mã. */
export async function createStockReceipt(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "inventory:write")) return { error: "Không có quyền nhập kho" };
  const parsed = stockReceiptSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const data = parsed.data;
  const raw = data.items.filter((i) => i.quantity !== 0);
  if (data.kind === "RECEIPT" && raw.some((i) => i.quantity < 0)) return { error: "Phiếu nhập hàng không được có số lượng âm — dùng “Điều chỉnh kiểm kê” để giảm tồn" };
  if (data.kind === "RETURN" && raw.some((i) => i.quantity < 0)) return { error: "Phiếu tái nhập hàng hoàn chỉ ghi số lượng thực nhận (số dương)" };
  if (data.kind === "ISSUE" && raw.some((i) => i.quantity < 0)) return { error: "Phiếu xuất kho tay nhập số lượng dương — ERP tự trừ kho" };
  // Sổ kho quy ước DƯƠNG = vào kho, ÂM = ra kho. Người dùng luôn nhập số dương cho phiếu xuất tay
  // rồi ERP đổi dấu, để không ai phải nhớ quy ước dấu khi ghi phiếu.
  const items = data.kind === "ISSUE" ? raw.map((i) => ({ ...i, quantity: -Math.abs(i.quantity) })) : raw;
  const db = await getDb();
  const variantIds = [...new Set(items.map((i) => i.variantId))];
  const known = await db.select({ id: schema.productVariants.id }).from(schema.productVariants).where(inArray(schema.productVariants.id, variantIds));
  if (known.length !== variantIds.length) return { error: "Có mẫu mã không tồn tại trong ERP — hãy đồng bộ sản phẩm từ Pancake trước" };
  // Nối lệnh SX / lô xưởng: người chọn, máy kiểm TỒN TẠI + đúng loại phiếu (lib/inventory/production-link.ts).
  const noiXuong = await validateProductionLink(db, { kind: data.kind, productionOrderId: data.productionOrderId, productionBatchId: data.productionBatchId });
  if ("error" in noiXuong) return { error: noiXuong.error };

  const totalQuantity = items.reduce((s, i) => s + i.quantity, 0);
  const totalCost = items.reduce((s, i) => s + Math.max(i.quantity, 0) * i.unitCost, 0);

  /**
   * PHÊ DUYỆT HAI BƯỚC cho hai loại phiếu tạo ra / xoá đi hàng mà KHÔNG có chứng từ ngoài đối chiếu.
   *
   * `RECEIPT` (nhập hàng thật) và `RETURN` (tái nhập theo số đã kiểm đếm) KHÔNG cần: cái trước có
   * hoá đơn nhà cung cấp, cái sau có số đếm thực tế — và bắt duyệt việc thường ngày chỉ tạo thói
   * quen bấm cho xong (xem `NO_SECOND_APPROVAL` trong lib/constants/approval.ts).
   *
   * `ADJUSTMENT` và `ISSUE` thì khác: chúng là lời khai của một người, không đối chiếu được với gì.
   */
  const nhomDuyet = data.kind === "ADJUSTMENT" ? "INVENTORY_ADJUSTMENT" : data.kind === "ISSUE" ? "INVENTORY_WRITE_OFF" : null;
  if (nhomDuyet) {
    const cong = await guardSecondApproval({
      group: nhomDuyet,
      action: `stock.${data.kind.toLowerCase()}`,
      entity: "STOCK_RECEIPT",
      summary: `${data.kind === "ADJUSTMENT" ? "Điều chỉnh kiểm kê" : "Xuất kho tay"} ${items.length} mẫu mã · ${totalQuantity} món${data.reference ? ` · ${data.reference}` : ""}`,
      amount: Math.abs(totalCost) || null,
      payload: data,
    });
    if (cong.mode === "NEEDS_APPROVAL") {
      return { error: `Việc này cần người thứ hai duyệt (${cong.reason}). Đã gửi yêu cầu — xem ở trang Cảnh báo.` };
    }
    if (cong.mode === "BLOCKED_NO_APPROVER") {
      return { error: `Việc này cần người thứ hai duyệt (${cong.reason}), nhưng hệ thống chưa có ai khác đủ tư cách duyệt. Thêm một tài khoản ADMIN hoặc MANAGER trước.` };
    }
  }

  /**
   * NGƯỜI LẬP PHIẾU = KHOÁ TÀI KHOẢN + TÊN (luật 34). Phiếu kiểm hàng hoàn sinh ra từ phiếu tái nhập
   * phải nối được về một tài khoản; một chuỗi email thì đổi email là mất dấu.
   */
  const actor: Actor = { id: user.id, label: user.name || user.email };
  // Xưởng: khớp ĐÚNG MỘT xưởng trong danh mục ⇒ khoá + tên chuẩn do máy chủ đọc (mục 34); không thì giữ chữ gõ.
  const xuong = data.kind === "RECEIPT" ? matchSupplier(data.supplier, (await supplierCatalog()).index) : ({ state: "EMPTY" } as const);
  const lines = items.map((i) => ({ variantId: i.variantId, quantity: i.quantity, unitCost: i.unitCost, shipmentId: i.shipmentId?.trim() || null }));

  // MỘT GIAO DỊCH: phiếu · dòng phiếu · đóng kiện hoàn. Phiếu ghi được mà kiện không đóng được (hay
  // ngược lại) thì tồn và hàng chờ nói hai chuyện khác nhau — nên hỏng giữa chừng là huỷ cả.
  let receiptId = "";
  let settledShipmentIds: string[] = [];
  try {
    await db.transaction(async (tx) => {
      const [receipt] = await tx
        .insert(schema.stockReceipts)
        .values({ kind: data.kind, receivedAt: vnStartOfDay(data.receivedAt), reference: data.reference, supplier: xuong.state === "MATCHED" ? xuong.name : data.supplier, supplierId: xuong.state === "MATCHED" ? xuong.id : null, productionOrderId: noiXuong.link.productionOrderId, productionBatchId: noiXuong.link.productionBatchId, note: data.note, totalQuantity, totalCost, createdBy: actor.label })
        .returning({ id: schema.stockReceipts.id });
      receiptId = receipt.id;
      await tx.insert(schema.stockReceiptItems).values(lines.map((l) => ({ receiptId: receipt.id, ...l })));
      if (data.kind === "RETURN") {
        /*
          Đóng ĐÚNG những vận đơn mà dòng phiếu chỉ tên — không đoán kiện nào theo mẫu mã (FIFO) như
          trước. Dòng không nêu vận đơn thì phiếu vẫn cộng tồn theo số đếm, nhưng KHÔNG gạch kiện nào
          khỏi hàng chờ: ERP không biết kiện nào đã về, và nói bừa còn tệ hơn nói "chưa biết".
        */
        const settled = await settleReturnsForReceipt(tx, { receiptId: receipt.id, lines, actor, note: data.note });
        if ("error" in settled) throw new SettleError(settled.error);
        settledShipmentIds = settled.settledShipmentIds;
      }
      if (data.kind === "RECEIPT") {
        for (const item of items) {
          if (item.unitCost > 0) await tx.update(schema.productVariants).set({ lastImportedPrice: item.unitCost, updatedAt: new Date() }).where(eq(schema.productVariants.id, item.variantId));
        }
      }
    });
  } catch (e) {
    if (e instanceof SettleError) return { error: e.message };
    throw e;
  }
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: data.kind === "RECEIPT" ? "STOCK_RECEIPT_CREATE" : data.kind === "RETURN" ? "STOCK_RETURN_CREATE" : data.kind === "ISSUE" ? "STOCK_ISSUE_CREATE" : "STOCK_ADJUST_CREATE",
    entity: "STOCK_RECEIPT",
    entityId: receiptId,
    detail: { ...data, items: lines, totalQuantity, totalCost, settledShipmentIds },
  });
  for (const id of variantIds) publish({ type: "stock", variantId: id });
  revalidate();
  return { ok: true, id: receiptId };
}

/**
 * Xoá phiếu kho. Lõi ở `lib/inventory/receipt-delete.ts`: chặn phiếu tái nhập đang làm chứng từ kiểm
 * hoàn · duyệt hai bước như phiếu điều chỉnh / xuất tay · nhật ký ảnh chụp đầy đủ + LÝ DO trước khi xoá.
 */
export async function deleteStockReceipt(id: string, reason: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "inventory:write")) return { error: "Không có quyền nhập kho" };
  const parsed = deleteReceiptSchema.safeParse({ id, reason });
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const db = await getDb();
  const actor: Actor = { id: user.id, label: user.name || user.email };
  const result = await deleteStockReceiptCore(db, { id: parsed.data.id, reason: parsed.data.reason, actor, actorEmail: user.email, gate: guardSecondApproval });
  if ("error" in result) return { error: result.error };
  for (const item of result.snapshot.items) publish({ type: "stock", variantId: item.variantId });
  revalidate();
  return { ok: true };
}

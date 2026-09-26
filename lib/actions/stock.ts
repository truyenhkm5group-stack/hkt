"use server";

import { inArray } from "drizzle-orm";
import { guardSecondApproval } from "@/lib/actions/approvals";
import { withApprovalExecution } from "@/lib/approvals/execution";
import { revalidatePath } from "next/cache";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import type { Actor } from "@/lib/constants/actor";
import { vnStartOfDay } from "@/lib/format";
import { publish } from "@/lib/realtime/bus";
import { deleteReceiptSchema, stockReceiptSchema } from "@/lib/validation/stock";
import { deleteStockReceiptCore } from "@/lib/inventory/receipt-delete";
import { writeStockReceiptCore } from "@/lib/inventory/receipt-create";
import { validateProductionLink } from "@/lib/inventory/production-link";
import { matchSupplier } from "@/lib/constants/suppliers";
import { supplierCatalog } from "@/lib/queries/suppliers";
import { priceReceiptLines } from "@/lib/inventory/receipt-pricing";

/** `missingPrice`: mã trên phiếu nhập chưa có giá báo MKT ⇒ dòng đó lưu với giá CHƯA BIẾT (0). */
export type ActionResult = { ok: true; id?: string; missingPrice?: string[] } | { error: string };


function firstIssue(error: { issues: { message: string }[] }) {
  return error.issues[0]?.message ?? "Dữ liệu không hợp lệ";
}

function revalidate() {
  for (const path of ["/inventory/receipts", "/inventory/returns", "/products", "/inventory", "/"]) revalidatePath(path);
}

/**
 * Tạo phiếu kho (nhập mới / tái nhập hàng hoàn / xuất tay / điều chỉnh kiểm kê).
 *
 * Phiếu NHẬP HÀNG MỚI: đơn giá = GIÁ BÁO MKT của mã theo ngày nhập, máy chủ tự đọc; giá client gửi lên
 * bị bỏ qua (chủ shop chốt 25/09/2026 "Luôn lấy giá báo MKT" — kho không cần biết giá). Mã chưa có
 * giá báo ⇒ dòng ghi 0 = chưa biết giá, phiếu VẪN lưu và kết quả trả về tên mã để màn hình nói ra.
 */
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
  const signed = data.kind === "ISSUE" ? raw.map((i) => ({ ...i, quantity: -Math.abs(i.quantity) })) : raw;
  const db = await getDb();
  const variantIds = [...new Set(signed.map((i) => i.variantId))];
  const known = await db.select({ id: schema.productVariants.id }).from(schema.productVariants).where(inArray(schema.productVariants.id, variantIds));
  if (known.length !== variantIds.length) return { error: "Có mẫu mã không tồn tại trong ERP — hãy đồng bộ sản phẩm từ Pancake trước" };
  // Nối lệnh SX / lô xưởng: người chọn, máy kiểm TỒN TẠI + đúng loại phiếu (lib/inventory/production-link.ts).
  const noiXuong = await validateProductionLink(db, { kind: data.kind, productionOrderId: data.productionOrderId, productionBatchId: data.productionBatchId });
  if ("error" in noiXuong) return { error: noiXuong.error };
  const dinhGia = data.kind === "RECEIPT" ? await priceReceiptLines(db, variantIds, vnStartOfDay(data.receivedAt)) : null;
  const items = signed.map((i) => ({ ...i, unitCost: dinhGia ? (dinhGia.price.get(i.variantId) ?? 0) : i.unitCost }));

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
   *
   * Cổng đứng TRONG giao dịch ghi phiếu (Company OS · Agent K, `lib/inventory/receipt-create.ts`): lời
   * duyệt chỉ được tiêu thụ khi phiếu thật sự ghi xong — phiếu hỏng thì lời duyệt còn nguyên.
   */
  const nhomDuyet = data.kind === "ADJUSTMENT" ? "INVENTORY_ADJUSTMENT" : data.kind === "ISSUE" ? "INVENTORY_WRITE_OFF" : null;
  const congDuyet = nhomDuyet
    ? {
        group: nhomDuyet,
        action: `stock.${data.kind.toLowerCase()}`,
        entity: "STOCK_RECEIPT",
        summary: `${data.kind === "ADJUSTMENT" ? "Điều chỉnh kiểm kê" : "Xuất kho tay"} ${items.length} mẫu mã · ${totalQuantity} món${data.reference ? ` · ${data.reference}` : ""}`,
        amount: Math.abs(totalCost) || null,
        payload: data,
      } as const
    : null;

  /**
   * NGƯỜI LẬP PHIẾU = KHOÁ TÀI KHOẢN + TÊN (luật 34). Phiếu kiểm hàng hoàn sinh ra từ phiếu tái nhập
   * phải nối được về một tài khoản; một chuỗi email thì đổi email là mất dấu.
   */
  const actor: Actor = { id: user.id, label: user.name || user.email };
  // Xưởng: khớp ĐÚNG MỘT xưởng trong danh mục ⇒ khoá + tên chuẩn do máy chủ đọc (mục 34); không thì giữ chữ gõ.
  const xuong = data.kind === "RECEIPT" ? matchSupplier(data.supplier, (await supplierCatalog()).index) : ({ state: "EMPTY" } as const);
  const lines = items.map((i) => ({ variantId: i.variantId, quantity: i.quantity, unitCost: i.unitCost, shipmentId: i.shipmentId?.trim() || null }));

  // MỘT GIAO DỊCH (lib/inventory/receipt-create.ts): cổng duyệt · phiếu · dòng phiếu · đóng kiện hoàn.
  // Phiếu ghi được mà kiện không đóng được (hay ngược lại) thì tồn và hàng chờ nói hai chuyện khác nhau.
  const ghi = await writeStockReceiptCore(db, {
    kind: data.kind,
    receipt: { receivedAt: vnStartOfDay(data.receivedAt), reference: data.reference, supplier: xuong.state === "MATCHED" ? xuong.name : data.supplier, supplierId: xuong.state === "MATCHED" ? xuong.id : null, productionOrderId: noiXuong.link.productionOrderId, productionBatchId: noiXuong.link.productionBatchId, note: data.note, totalQuantity, totalCost, createdBy: actor.label },
    lines,
    note: data.note,
    actor,
    approver: { id: user.id, email: user.email },
    gate: congDuyet,
  });
  if (ghi.gate && (ghi.gate.mode === "NEEDS_APPROVAL" || ghi.gate.consumed)) {
    revalidatePath("/alerts");
    revalidatePath("/work");
  }
  if ("error" in ghi) return { error: ghi.error };
  const { receiptId, settledShipmentIds } = ghi;
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: data.kind === "RECEIPT" ? "STOCK_RECEIPT_CREATE" : data.kind === "RETURN" ? "STOCK_RETURN_CREATE" : data.kind === "ISSUE" ? "STOCK_ISSUE_CREATE" : "STOCK_ADJUST_CREATE",
    entity: "STOCK_RECEIPT",
    entityId: receiptId,
    detail: { ...data, items: lines, totalQuantity, totalCost, settledShipmentIds, ...(dinhGia ? { priceSource: "MARKETER_PRICE", missingPrice: dinhGia.missing } : {}) },
  });
  for (const id of variantIds) publish({ type: "stock", variantId: id });
  revalidate();
  return { ok: true, id: receiptId, ...(dinhGia?.missing.length ? { missingPrice: dinhGia.missing } : {}) };
}

/**
 * Xoá phiếu kho. Lõi ở `lib/inventory/receipt-delete.ts`: chặn phiếu tái nhập đang làm chứng từ kiểm
 * hoàn · duyệt hai bước như phiếu điều chỉnh / xuất tay · nhật ký ảnh chụp đầy đủ + LÝ DO trước khi xoá.
 */
export async function deleteStockReceipt(id: string, reason: string): Promise<ActionResult> {
  return withApprovalExecution(async () => {
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
  });
}

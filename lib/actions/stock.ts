"use server";

import { eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { vnStartOfDay } from "@/lib/format";
import { publish } from "@/lib/realtime/bus";
import { stockReceiptSchema } from "@/lib/validation/stock";

export type ActionResult = { ok: true; id?: string } | { error: string };

function firstIssue(error: { issues: { message: string }[] }) {
  return error.issues[0]?.message ?? "Dữ liệu không hợp lệ";
}

function revalidate() {
  for (const path of ["/inventory/receipts", "/products", "/inventory", "/"]) revalidatePath(path);
}

/** Tạo phiếu nhập hàng / điều chỉnh kiểm kê. Giá nhập > 0 sẽ cập nhật giá vốn gần nhất của mẫu mã. */
export async function createStockReceipt(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "inventory:write")) return { error: "Không có quyền nhập kho" };
  const parsed = stockReceiptSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const data = parsed.data;
  const items = data.items.filter((i) => i.quantity !== 0);
  if (data.kind === "RECEIPT" && items.some((i) => i.quantity < 0)) return { error: "Phiếu nhập hàng không được có số lượng âm — dùng “Điều chỉnh kiểm kê” để giảm tồn" };
  const db = await getDb();
  const variantIds = [...new Set(items.map((i) => i.variantId))];
  const known = await db.select({ id: schema.productVariants.id }).from(schema.productVariants).where(inArray(schema.productVariants.id, variantIds));
  if (known.length !== variantIds.length) return { error: "Có mẫu mã không tồn tại trong ERP — hãy đồng bộ sản phẩm từ Pancake trước" };

  const totalQuantity = items.reduce((s, i) => s + i.quantity, 0);
  const totalCost = items.reduce((s, i) => s + Math.max(i.quantity, 0) * i.unitCost, 0);
  const [receipt] = await db
    .insert(schema.stockReceipts)
    .values({ kind: data.kind, receivedAt: vnStartOfDay(data.receivedAt), reference: data.reference, supplier: data.supplier, note: data.note, totalQuantity, totalCost, createdBy: user.email })
    .returning({ id: schema.stockReceipts.id });
  await db.insert(schema.stockReceiptItems).values(items.map((i) => ({ receiptId: receipt.id, variantId: i.variantId, quantity: i.quantity, unitCost: i.unitCost })));
  if (data.kind === "RECEIPT") {
    for (const item of items) {
      if (item.unitCost > 0) await db.update(schema.productVariants).set({ lastImportedPrice: item.unitCost, updatedAt: new Date() }).where(eq(schema.productVariants.id, item.variantId));
    }
  }
  await audit({ userId: user.id, userEmail: user.email, action: data.kind === "RECEIPT" ? "STOCK_RECEIPT_CREATE" : "STOCK_ADJUST_CREATE", entity: "STOCK_RECEIPT", entityId: receipt.id, detail: { ...data, items, totalQuantity, totalCost } });
  for (const id of variantIds) publish({ type: "stock", variantId: id });
  revalidate();
  return { ok: true, id: receipt.id };
}

export async function deleteStockReceipt(id: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "inventory:write")) return { error: "Không có quyền nhập kho" };
  if (!id) return { error: "Thiếu mã phiếu" };
  const db = await getDb();
  const existing = await db.query.stockReceipts.findFirst({ where: eq(schema.stockReceipts.id, id), with: { items: true } });
  if (!existing) return { error: "Không tìm thấy phiếu" };
  await db.delete(schema.stockReceipts).where(eq(schema.stockReceipts.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: "STOCK_RECEIPT_DELETE", entity: "STOCK_RECEIPT", entityId: id, detail: { kind: existing.kind, receivedAt: existing.receivedAt, reference: existing.reference, totalQuantity: existing.totalQuantity, items: existing.items.length } });
  for (const item of existing.items) publish({ type: "stock", variantId: item.variantId });
  revalidate();
  return { ok: true };
}

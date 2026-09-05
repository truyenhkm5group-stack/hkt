"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { PRODUCTION_STATUS } from "@/lib/constants/production";
import { matrixTotals } from "@/lib/queries/production";

type Result<T = object> = ({ ok: true } & T) | { error: string };

const inputSchema = z.object({
  productId: z.string().min(1),
  productCode: z.string().trim().max(50).default(""),
  productName: z.string().trim().max(200),
  colors: z.array(z.string().trim().min(1).max(40)).min(1, "Cần ít nhất một màu").max(20),
  sizes: z.array(z.string().trim().min(1).max(20)).min(1, "Cần ít nhất một size").max(20),
  cells: z.record(z.string(), z.number().int().min(0).max(100000)),
  images: z.array(z.object({ color: z.string().max(40), url: z.string().trim().url().max(600) })).max(20).default([]),
  unitCost: z.number().int().min(0).default(0),
  supplier: z.string().trim().max(120).default(""),
  note: z.string().trim().max(1000).default(""),
  dueDate: z.string().trim().optional().nullable(),
});

async function nextCode() {
  const db = await getDb();
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(schema.productionOrders).where(sql`${schema.productionOrders.code} like ${`PO-${day}-%`}`);
  return `PO-${day}-${String(Number(n) + 1).padStart(2, "0")}`;
}

export async function saveProductionOrder(input: unknown, id?: string): Promise<Result<{ id: string; code: string }>> {
  const user = await requireUser();
  if (!can(user, "inventory:write")) return { error: "Không có quyền tạo bảng đặt hàng" };
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const totals = matrixTotals(d.colors, d.sizes, d.cells);
  if (totals.total <= 0) return { error: "Tổng số lượng phải lớn hơn 0" };
  const db = await getDb();
  const values = {
    productId: d.productId,
    productCode: d.productCode,
    productName: d.productName,
    colors: d.colors,
    sizes: d.sizes,
    cells: Object.fromEntries(Object.entries(d.cells).filter(([, v]) => v > 0)),
    images: d.images,
    totalQty: totals.total,
    unitCost: d.unitCost,
    supplier: d.supplier,
    note: d.note,
    dueDate: d.dueDate ? new Date(d.dueDate) : null,
    updatedAt: new Date(),
  };
  let rowId = id;
  let code = "";
  if (id) {
    const existing = await db.query.productionOrders.findFirst({ where: eq(schema.productionOrders.id, id) });
    if (!existing) return { error: "Không tìm thấy bảng đặt hàng" };
    if (existing.status !== "DRAFT" && existing.status !== "SENT") return { error: "Bảng đã kết thúc, không sửa được" };
    await db.update(schema.productionOrders).set(values).where(eq(schema.productionOrders.id, id));
    code = existing.code;
  } else {
    code = await nextCode();
    const [row] = await db.insert(schema.productionOrders).values({ ...values, code, createdBy: user.email }).returning({ id: schema.productionOrders.id });
    rowId = row.id;
  }
  await audit({ userId: user.id, userEmail: user.email, action: id ? "PRODUCTION_ORDER_UPDATE" : "PRODUCTION_ORDER_CREATE", entity: "PRODUCTION_ORDER", entityId: rowId, detail: { code, total: totals.total } });
  revalidatePath("/inventory/planning");
  revalidatePath("/inventory/planning/orders");
  return { ok: true, id: rowId as string, code };
}

export async function setProductionStatus(id: string, status: string): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "inventory:write")) return { error: "Không có quyền" };
  if (!(PRODUCTION_STATUS as readonly string[]).includes(status)) return { error: "Trạng thái không hợp lệ" };
  const db = await getDb();
  await db.update(schema.productionOrders).set({ status, sentAt: status === "SENT" ? new Date() : undefined, updatedAt: new Date() }).where(eq(schema.productionOrders.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: "PRODUCTION_ORDER_STATUS", entity: "PRODUCTION_ORDER", entityId: id, detail: { status } });
  revalidatePath("/inventory/planning/orders");
  revalidatePath(`/inventory/planning/orders/${id}`);
  return { ok: true };
}

export async function deleteProductionOrder(id: string): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "inventory:write")) return { error: "Không có quyền" };
  const db = await getDb();
  await db.delete(schema.productionOrders).where(and(eq(schema.productionOrders.id, id), eq(schema.productionOrders.status, "DRAFT")));
  await audit({ userId: user.id, userEmail: user.email, action: "PRODUCTION_ORDER_DELETE", entity: "PRODUCTION_ORDER", entityId: id });
  revalidatePath("/inventory/planning/orders");
  return { ok: true };
}

"use server";

import { and, eq, sql } from "drizzle-orm";
import { guardSecondApproval } from "@/lib/actions/approvals";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { matrixTotals, PRODUCTION_STATUS, shouldStampReceipt } from "@/lib/constants/production";

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
  if (!can(user, "planning:write")) return { error: "Không có quyền tạo bảng đặt hàng" };
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const totals = matrixTotals(d.colors, d.sizes, d.cells);
  if (totals.total <= 0) return { error: "Tổng số lượng phải lớn hơn 0" };
  {
    // Đặt hàng vượt ngưỡng khoá vốn của shop trong nhiều tháng nếu quyết sai. Dưới ngưỡng thì cổng
    // tự cho qua — bắt duyệt mọi lệnh nhỏ chỉ tạo thói quen bấm cho xong.
    const cong = await guardSecondApproval({
      group: "PURCHASING_LARGE",
      action: "production.save",
      entity: "PRODUCTION_ORDER",
      entityId: id ?? "",
      summary: `Đặt xưởng ${d.productName} · ${totals.total} món · ${totals.total * d.unitCost}đ${d.supplier ? ` · ${d.supplier}` : ""}`,
      amount: totals.total * d.unitCost,
      payload: d,
    });
    if (cong.mode === "NEEDS_APPROVAL") return { error: `Việc này cần người thứ hai duyệt (${cong.reason}). Đã gửi yêu cầu — xem ở trang Cần xử lý.` };
    if (cong.mode === "BLOCKED_NO_APPROVER") return { error: `Việc này cần người thứ hai duyệt (${cong.reason}), nhưng chưa có ai khác đủ tư cách duyệt.` };
  }
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

/**
 * ═══════════ ĐỔI TRẠNG THÁI LỆNH SẢN XUẤT — VÀ GHI MỐC NHẬN THẬT ═══════════
 *
 * `RECEIVED` nay ghi thêm BA thứ: lúc nào, ai bấm (khoá tài khoản), và tên người đó để đọc. Mốc này
 * là cái duy nhất trả lời được "xưởng giao trễ mấy ngày" — trước đây trạng thái đổi mà không để lại
 * thời điểm, nên cảnh báo hết hàng không phân biệt nổi bán nhanh với xưởng trễ.
 *
 * ─── BẤM HAI LẦN KHÔNG ĐƯỢC DỜI MỐC ───
 *
 * Cùng một bài học với `setCareStatus` (AGENTS.md mục 61): một cú bấm đúp — hoặc một lần trình duyệt
 * gửi lại — từng đẩy `done_at` về lúc bấm lần hai. Ở đây hậu quả nặng hơn vì mốc này ĐI THẲNG vào
 * phép đo độ trễ của nhà cung cấp: bấm lại sau ba ngày sẽ làm xưởng trông như giao trễ thêm ba ngày.
 *
 * Nên `received_at` chỉ ghi khi nó còn TRỐNG. Lời khai đầu tiên là lời khai thật; lần bấm sau không
 * xoá được nó, và cũng không ném lỗi vào mặt người dùng.
 *
 * TÊN NGƯỜI ĐỌC TỪ MÁY CHỦ, không nhận từ client (mục 34) — client gửi tên khác với khoá thì dòng dữ
 * liệu nói một đằng còn quy kết một nẻo.
 */
export async function setProductionStatus(id: string, status: string): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "planning:write")) return { error: "Không có quyền" };
  if (!(PRODUCTION_STATUS as readonly string[]).includes(status)) return { error: "Trạng thái không hợp lệ" };
  const db = await getDb();
  const truoc = await db.query.productionOrders.findFirst({ where: eq(schema.productionOrders.id, id), columns: { receivedAt: true } });
  const ghiMocNhan = shouldStampReceipt(status, truoc?.receivedAt);
  await db
    .update(schema.productionOrders)
    .set({
      status,
      sentAt: status === "SENT" ? new Date() : undefined,
      receivedAt: ghiMocNhan ? new Date() : undefined,
      receivedByUserId: ghiMocNhan ? user.id : undefined,
      receivedBy: ghiMocNhan ? user.name || user.email : undefined,
      updatedAt: new Date(),
    })
    .where(eq(schema.productionOrders.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: "PRODUCTION_ORDER_STATUS", entity: "PRODUCTION_ORDER", entityId: id, detail: { status, ghiMocNhan } });
  revalidatePath("/inventory/planning/orders");
  revalidatePath(`/inventory/planning/orders/${id}`);
  return { ok: true };
}

export async function deleteProductionOrder(id: string): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "planning:write")) return { error: "Không có quyền" };
  const db = await getDb();
  await db.delete(schema.productionOrders).where(and(eq(schema.productionOrders.id, id), eq(schema.productionOrders.status, "DRAFT")));
  await audit({ userId: user.id, userEmail: user.email, action: "PRODUCTION_ORDER_DELETE", entity: "PRODUCTION_ORDER", entityId: id });
  revalidatePath("/inventory/planning/orders");
  return { ok: true };
}

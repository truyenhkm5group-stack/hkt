"use server";

import { and, eq, sql } from "drizzle-orm";
import { guardSecondApproval } from "@/lib/actions/approvals";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { matrixTotals, PRODUCTION_STATUS, shouldStampReceipt } from "@/lib/constants/production";
import { checkSendWithoutDesign, type SuggestedCellsSnapshot } from "@/lib/constants/production-os";
import { matchSupplier } from "@/lib/constants/suppliers";
import { followPoLink, persistPoPlanTx, validatePoPlan } from "@/lib/production/orders";
import { describeFollow } from "@/lib/production/lifecycle";
import { buildMatrixForProduct } from "@/lib/queries/production";
import { requireApprovedDesignFlag } from "@/lib/queries/production-os";
import { supplierCatalog } from "@/lib/queries/suppliers";

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
  /*
    Company OS · Agent C. `designVersionId`: `undefined` = nơi gọi không nói gì (giữ bản duyệt đang có),
    `null` = bỏ trỏ. `fromSuggestion`: người vừa "điền theo đề xuất" (hoặc mở bảng mới — ô khởi tạo LÀ
    đề xuất) ⇒ máy chủ TÍNH LẠI gợi ý theo đúng căn cứ kế hoạch rồi lưu ảnh chụp; không nhận gợi ý từ
    trình duyệt. `overrideReason`: bắt buộc khi số chốt khác gợi ý dù một ô (không ngưỡng — luật 38).
  */
  designVersionId: z.string().trim().min(1).nullable().optional(),
  fromSuggestion: z.boolean().default(false),
  suggestionBasis: z.object({ coverDays: z.number().int().min(0).max(3650).optional(), countIncoming: z.boolean().optional() }).optional(),
  overrideReason: z.string().trim().max(1000).default(""),
});

async function nextCode() {
  const db = await getDb();
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(schema.productionOrders).where(sql`${schema.productionOrders.code} like ${`PO-${day}-%`}`);
  return `PO-${day}-${String(Number(n) + 1).padStart(2, "0")}`;
}

export async function saveProductionOrder(input: unknown, id?: string): Promise<Result<{ id: string; code: string; lifecycle: string | null }>> {
  const user = await requireUser();
  if (!can(user, "planning:write")) return { error: "Không có quyền tạo bảng đặt hàng" };
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const totals = matrixTotals(d.colors, d.sizes, d.cells);
  if (totals.total <= 0) return { error: "Tổng số lượng phải lớn hơn 0" };
  const db = await getDb();
  const existing = id ? await db.query.productionOrders.findFirst({ where: eq(schema.productionOrders.id, id) }) : null;
  if (id && !existing) return { error: "Không tìm thấy bảng đặt hàng" };
  if (existing && existing.status !== "DRAFT" && existing.status !== "SENT") return { error: "Bảng đã kết thúc, không sửa được" };
  const finalCells = Object.fromEntries(Object.entries(d.cells).filter(([, v]) => v > 0));
  /*
    GỢI Ý CỦA MÁY vs SỐ NGƯỜI CHỐT (Company OS · Agent C). Kiểm TRƯỚC mọi lượt ghi và trước cổng duyệt:
    thiếu lý do thì không ô nào bị lưu, và không có yêu cầu duyệt nào được gửi cho một bảng sẽ bị trả lại.
  */
  let suggestion: SuggestedCellsSnapshot | null = existing?.suggestedCells ?? null;
  if (d.fromSuggestion) {
    const m = await buildMatrixForProduct(d.productId, { coverDays: d.suggestionBasis?.coverDays, countIncoming: d.suggestionBasis?.countIncoming ?? true });
    if (m) {
      suggestion = {
        cells: Object.fromEntries(Object.entries(m.cells).filter(([, v]) => v > 0)),
        basis: { source: "buildMatrixForProduct", coverDays: m.coverDays, countIncoming: m.countIncoming, leadTimeDays: m.leadTimeDays },
        computedAt: new Date().toISOString(),
      };
    }
  }
  const designVersionId = d.designVersionId === undefined ? (existing?.designVersionId ?? null) : d.designVersionId;
  const ke = await validatePoPlan(db, { productId: d.productId, designVersionId, suggestion, finalCells, overrideReason: d.overrideReason });
  if ("error" in ke) return { error: ke.error };
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
  /*
    XƯỞNG: chữ gõ khớp ĐÚNG MỘT xưởng trong danh mục ⇒ ghi khoá `supplier_id` và dùng TÊN CHUẨN do máy
    chủ đọc từ danh mục (không nhận tên từ client — AGENTS.md mục 34). Không khớp / khớp hai xưởng ⇒
    giữ nguyên chữ gõ, khoá để trống, và tên ấy hiện ở danh sách "chưa vào danh mục" của trang Mua hàng.
  */
  const xuong = matchSupplier(d.supplier, (await supplierCatalog()).index);
  const values = {
    productId: d.productId,
    productCode: d.productCode,
    productName: d.productName,
    colors: d.colors,
    sizes: d.sizes,
    cells: finalCells,
    images: d.images,
    totalQty: totals.total,
    unitCost: d.unitCost,
    supplier: xuong.state === "MATCHED" ? xuong.name : d.supplier,
    supplierId: xuong.state === "MATCHED" ? xuong.id : null,
    note: d.note,
    dueDate: d.dueDate ? new Date(d.dueDate) : null,
    updatedAt: new Date(),
  };
  const code = existing ? existing.code : await nextCode();
  const actor = { id: user.id, label: user.name || user.email };
  // Ô số lượng + ba cột bản duyệt / gợi ý / lý do + sự kiện: MỘT giao dịch.
  const ghi = await db.transaction(async (tx) => {
    let rowId: string;
    if (existing) {
      await tx.update(schema.productionOrders).set(values).where(eq(schema.productionOrders.id, existing.id));
      rowId = existing.id;
    } else {
      const [row] = await tx.insert(schema.productionOrders).values({ ...values, code, createdBy: user.email }).returning({ id: schema.productionOrders.id });
      rowId = row.id;
    }
    const su = await persistPoPlanTx(tx, { poId: rowId, poCode: code, beforeDesignVersionId: existing?.designVersionId ?? null, plan: ke.plan, suggestion, finalCells, actor });
    // Vòng đời mẫu đi theo lượt nối bản duyệt TRONG cùng giao dịch với lệnh (Agent K).
    const theo = await followPoLink(tx, { linkedEventId: su.linkedEventId, modelId: su.modelId, poId: rowId, actor });
    return { rowId, ...su, lifecycle: theo };
  });
  const lifecycle = ghi.lifecycle;
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: id ? "PRODUCTION_ORDER_UPDATE" : "PRODUCTION_ORDER_CREATE",
    entity: "PRODUCTION_ORDER",
    entityId: ghi.rowId,
    detail: { code, total: totals.total, designVersionId: ke.plan.designVersion?.id ?? null, overriddenCells: ke.plan.diff.length, lifecycle },
    reason: ke.plan.overrideReason ?? undefined,
  });
  revalidatePath("/inventory/planning");
  revalidatePath("/inventory/planning/orders");
  revalidatePath(`/inventory/planning/orders/${ghi.rowId}`);
  return { ok: true, id: ghi.rowId, code, lifecycle: lifecycle ? describeFollow(lifecycle) : null };
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
  const truoc = await db.query.productionOrders.findFirst({ where: eq(schema.productionOrders.id, id), columns: { receivedAt: true, status: true, designVersionId: true } });
  /*
    Company OS · Agent C (Q8): gửi xưởng một lệnh chưa trỏ bản thiết kế đã duyệt. Cờ
    `production.requireApprovedDesign` TẮT (mặc định) ⇒ cho qua, ghi dấu vào nhật ký; BẬT ⇒ chặn. Chỉ xét
    lượt DRAFT → SENT, nên lệnh đã gửi từ trước không bao giờ bị đụng tới khi cờ được bật.
  */
  const guiThieuBanDuyet = truoc ? checkSendWithoutDesign({ from: truoc.status, to: status, designVersionId: truoc.designVersionId, requireApprovedDesign: await requireApprovedDesignFlag() }) : { ok: true as const, warn: false };
  if ("error" in guiThieuBanDuyet) return { error: guiThieuBanDuyet.error };
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
  await audit({ userId: user.id, userEmail: user.email, action: "PRODUCTION_ORDER_STATUS", entity: "PRODUCTION_ORDER", entityId: id, detail: { status, ghiMocNhan, sentWithoutApprovedDesign: guiThieuBanDuyet.warn } });
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

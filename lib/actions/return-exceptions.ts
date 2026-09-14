"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { clearMemo } from "@/lib/cache";
import { HMT_QUEUE, queueOfStatus, type HmtMatchStatus, type HmtResolution } from "@/lib/constants/hmt-returns";
import { markReturnsArrived } from "@/lib/returns/inspection";

type Result<T = object> = ({ ok: true } & T) | { error: string };

/**
 * ═══════════ NGƯỜI GỠ MỘT DÒNG KHÔNG KHỚP — VÀ GỠ KHÔNG BAO GIỜ LÀ GHI TỒN ═══════════
 *
 * Cám dỗ của màn hình này là để một nút "xác nhận" làm cả ba việc một lúc: nối mã, kết luận hàng
 * còn tốt, cộng vào tồn. Nó tiết kiệm hai cú bấm và phá đúng cái luật đắt nhất của kho
 * (AGENTS.md mục 10): **hàng hoàn chỉ vào tồn khi có người ĐẾM thực tế.**
 *
 * Nên ở đây, gỡ một dòng làm ĐÚNG hai việc:
 *
 *  1. ghi lại kết luận của NGƯỜI (ai · lúc nào · vì sao) vào `hmt_return_reconciliation`;
 *  2. nếu kết luận ấy chỉ ra một KIỆN CÓ THẬT, đưa kiện đó vào hàng đợi ĐẾM — y hệt 672 kiện đã
 *     khớp, không hơn một bước nào.
 *
 * Tồn kho vẫn không đổi một món. Người kho vẫn phải mở kiện ra đếm.
 *
 * ─── VÀ 724 DÒNG ĐÃ GHI THÌ KHÔNG AI ĐỘNG VÀO ───
 *
 * Ràng buộc `hmt_return_rec_resolution_written_check` ở CSDL cấm gắn kết luận lên dòng đã ghi; ở
 * đây chặn thêm một lần nữa bằng mệnh đề `resolution is null` trong chính câu UPDATE. Hai lớp, vì
 * lớp ứng dụng là lớp người ta sửa và quên, còn lớp CSDL thì không.
 */

const baseSchema = z.object({
  id: z.string().min(1),
  /** BẮT BUỘC ở cả ba cách gỡ: một dòng biến mất không lời giải thích sẽ quay lại làm phiền người sau. */
  note: z.string().trim().min(3, "Phải ghi lý do — ít nhất vài chữ").max(500),
});

const linkSchema = baseSchema.extend({ shipmentId: z.string().min(1, "Chưa chọn kiện") });
const skuSchema = baseSchema.extend({ variantId: z.string().min(1, "Chưa chọn mẫu mã") });

async function authorize() {
  const user = await requireUser();
  return { user, error: can(user, "inventory:write") ? null : "Bạn không có quyền ghi ở bàn hàng hoàn" };
}

function revalidate() {
  clearMemo();
  for (const p of ["/inventory/returns", "/inventory", "/data-quality", "/"]) revalidatePath(p);
}

/** Dòng còn gỡ được: chưa có kết luận, và CHƯA ĐƯỢC GHI. */
async function pending(id: string) {
  const db = await getDb();
  const t = schema.hmtReturnReconciliation;
  const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.resolution))).limit(1);
  if (!row) return { row: null, error: "Dòng này không còn ở hàng đợi — có thể ai đó vừa gỡ xong." };
  if (row.written) return { row: null, error: "Dòng này đã được ghi nhận làm chứng cứ nhận hàng — không sửa đè lên được. Muốn sửa thì huỷ nhận kiện, để lại dấu vết." };
  return { row, error: null };
}

/** Cách gỡ có hợp lệ với NHÓM của dòng này không — nối kiện cho một dòng lệch mẫu mã là làm sai việc. */
function allowed(status: string, resolution: HmtResolution) {
  const q = queueOfStatus(status as HmtMatchStatus);
  if (!q) return false;
  return (HMT_QUEUE[q].allow as readonly string[]).includes(resolution);
}

async function ghi(
  id: string,
  resolution: HmtResolution,
  patch: { resolvedShipmentId?: string; resolvedVariantId?: string },
  note: string,
  actor: { id: string; email: string; name: string },
) {
  const db = await getDb();
  const t = schema.hmtReturnReconciliation;
  const rows = await db
    .update(t)
    .set({ resolution, ...patch, resolvedBy: actor.name || actor.email, resolvedByUserId: actor.id, resolutionNote: note, resolvedAt: new Date() })
    // `resolution is null` lặp lại ở đây CỐ Ý: hai người bấm cùng lúc thì người thứ hai ghi 0 dòng
    // và nhận đúng câu "ai đó vừa gỡ xong", thay vì ghi đè kết luận của người thứ nhất.
    .where(and(eq(t.id, id), isNull(t.resolution), eq(t.written, false)))
    .returning({ id: t.id });
  return rows.length > 0;
}

/**
 * NỐI TAY MỘT MÃ VỚI MỘT KIỆN CÓ THẬT.
 *
 * Dùng cho hai nhóm: mã không xác định được (ô trống, không gộp ô) và mã không có trong ERP (sổ
 * ghi sai, hoặc Excel đổi mã dài thành `1.5089E+11`).
 *
 * Kiện được chọn ĐI THẲNG vào hàng đợi đếm — cùng một hàm `markReturnsArrived` mà lượt đối soát
 * dùng cho 672 kiện kia. Không có đường ghi thứ hai.
 */
export async function linkHmtRowToShipment(input: unknown): Promise<Result<{ received: boolean }>> {
  const { user, error } = await authorize();
  if (error) return { error };
  const parsed = linkSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { row, error: loi } = await pending(parsed.data.id);
  if (!row) return { error: loi! };
  if (!allowed(row.matchStatus, "LINKED_SHIPMENT")) return { error: "Nhóm này không gỡ bằng cách nối kiện — xem hành động gợi ý của nhóm." };

  const db = await getDb();
  const [kien] = await db.select({ id: schema.shipments.id }).from(schema.shipments).where(eq(schema.shipments.id, parsed.data.shipmentId)).limit(1);
  if (!kien) return { error: "Không tìm thấy kiện đó trong ERP" };

  if (!(await ghi(parsed.data.id, "LINKED_SHIPMENT", { resolvedShipmentId: kien.id }, parsed.data.note, user))) {
    return { error: "Dòng này vừa được người khác gỡ — tải lại để xem kết luận của họ." };
  }
  /*
    ĐƯA VÀO HÀNG ĐỢI ĐẾM, KHÔNG CỘNG TỒN.

    `markReturnsArrived` dùng `onConflictDoNothing` trên `shipment_id`, nên nối tay một kiện kho đã
    nhận từ trước là không-thao-tác — đúng như phải thế.
  */
  const nhan = await markReturnsArrived([kien.id], { id: user.id, label: user.name || user.email }, `HMT · nối tay · ${parsed.data.note}`.slice(0, 300));
  await audit({ userId: user.id, userEmail: user.email, action: "HMT_ROW_RESOLVE", entity: "HMT_ROW", entityId: parsed.data.id, detail: { resolution: "LINKED_SHIPMENT", shipmentId: kien.id, trackingRaw: row.trackingRaw, note: parsed.data.note } });
  revalidate();
  return { ok: true, received: nhan.count > 0 };
}

/**
 * CHỌN ĐÚNG MẪU MÃ cho một dòng sổ ghi thiếu (không có mã hàng, thiếu màu/size).
 *
 * KHÔNG ghi nhận kiện ở đây dù kiện đã lần ra: dòng này rơi vào nhóm "mẫu mã không nằm trong hàng
 * kỳ vọng", nghĩa là chính việc món đó thuộc về kiện này đang bị nghi ngờ. Người chọn mẫu mã mới
 * chỉ đang nói "món trên bàn là mẫu này"; ai đó vẫn phải đếm cả kiện.
 *
 * Ngoại lệ có chủ đích: nếu mẫu mã được chọn NẰM TRONG hàng kỳ vọng của kiện thì nghi ngờ đã được
 * gỡ, và kiện vào hàng đợi đếm luôn.
 */
export async function resolveHmtRowSku(input: unknown): Promise<Result<{ received: boolean; inExpected: boolean }>> {
  const { user, error } = await authorize();
  if (error) return { error };
  const parsed = skuSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { row, error: loi } = await pending(parsed.data.id);
  if (!row) return { error: loi! };
  if (!allowed(row.matchStatus, "RESOLVED_SKU")) return { error: "Nhóm này không gỡ bằng cách chọn mẫu mã — xem hành động gợi ý của nhóm." };

  const db = await getDb();
  const [mau] = await db.select({ id: schema.productVariants.id }).from(schema.productVariants).where(eq(schema.productVariants.id, parsed.data.variantId)).limit(1);
  if (!mau) return { error: "Không tìm thấy mẫu mã đó" };

  // Mẫu mã vừa chọn CÓ nằm trong đơn của kiện không — đây là điều máy đã không xác nhận được.
  let inExpected = false;
  if (row.shipmentId) {
    const [co] = await db
      .select({ n: schema.orderItems.id })
      .from(schema.orderItems)
      .innerJoin(schema.shipments, eq(schema.shipments.orderId, schema.orderItems.orderId))
      .where(and(eq(schema.shipments.id, row.shipmentId), eq(schema.orderItems.variantId, mau.id)))
      .limit(1);
    inExpected = Boolean(co);
  }

  if (!(await ghi(parsed.data.id, "RESOLVED_SKU", { resolvedVariantId: mau.id }, parsed.data.note, user))) {
    return { error: "Dòng này vừa được người khác gỡ — tải lại để xem kết luận của họ." };
  }
  let received = false;
  if (inExpected && row.shipmentId) {
    const nhan = await markReturnsArrived([row.shipmentId], { id: user.id, label: user.name || user.email }, `HMT · chọn mẫu mã · ${parsed.data.note}`.slice(0, 300));
    received = nhan.count > 0;
  }
  await audit({ userId: user.id, userEmail: user.email, action: "HMT_ROW_RESOLVE", entity: "HMT_ROW", entityId: parsed.data.id, detail: { resolution: "RESOLVED_SKU", variantId: mau.id, inExpected, note: parsed.data.note } });
  revalidate();
  return { ok: true, received, inExpected };
}

/**
 * BỎ QUA MỘT DÒNG, CÓ LÝ DO.
 *
 * Dòng ghi nhầm, trùng, hoặc hàng của shop khác. KHÔNG xoá dữ liệu: dòng ở lại cùng lý do, và
 * người sau tra ra được vì sao nó không dẫn tới đâu.
 */
export async function dismissHmtRow(input: unknown): Promise<Result> {
  const { user, error } = await authorize();
  if (error) return { error };
  const parsed = baseSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { row, error: loi } = await pending(parsed.data.id);
  if (!row) return { error: loi! };
  if (!allowed(row.matchStatus, "DISMISSED")) return { error: "Nhóm này không bỏ qua được ở đây." };
  if (!(await ghi(parsed.data.id, "DISMISSED", {}, parsed.data.note, user))) {
    return { error: "Dòng này vừa được người khác gỡ — tải lại để xem kết luận của họ." };
  }
  await audit({ userId: user.id, userEmail: user.email, action: "HMT_ROW_RESOLVE", entity: "HMT_ROW", entityId: parsed.data.id, detail: { resolution: "DISMISSED", trackingRaw: row.trackingRaw, note: parsed.data.note } });
  revalidate();
  return { ok: true };
}

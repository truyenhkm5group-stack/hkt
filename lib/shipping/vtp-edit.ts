import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { codChangeRequiresConfirmation } from "@/lib/constants/shipment-edit";
import { formatVND } from "@/lib/format";
import { getViettelPostClient } from "@/lib/integrations/viettelpost/client";

/**
 * ═══════════ SỬA ĐƠN TRÊN VIETTEL POST — LÕI KHÔNG PHỤ THUỘC NEXT ═══════════
 *
 * Tách khỏi server action (`lib/actions/shipments-vtp.ts::vtpEditOrder`) để bài kiểm chạy được
 * đúng đường ghi này với client Viettel Post GIẢ (`setViettelPostClientForTests`) mà không cần
 * phiên đăng nhập hay `revalidatePath`. Server action vẫn giữ phần quyền + làm mới trang.
 *
 * CỔNG ĐỔI TIỀN THU HỘ. Số COD gửi lên khác `shipments.cod_amount` HIỆN TẠI mà thiếu
 * `confirmCodChange: true` ⇒ trả `{ error }` và KHÔNG gọi Viettel Post, KHÔNG ghi gì. Lý do: form
 * từng điền sẵn COD CỦA ĐƠN cho vận đơn COD 0 (trả trước / chiều hoàn), và một cú bấm không nhìn
 * kỹ là đổi số tiền khách phải trả ở cửa. So với số TRONG CSDL lúc gửi, không tin số form gửi kèm.
 *
 * Việc này là NGƯỜI chủ động gửi lệnh TỚI ĐVVC — không đụng `cod_status`, không đụng
 * `cod_collected` (AGENTS §3.6: chỉ chứng từ ĐVVC mới nâng hai cột đó).
 */

export const vtpEditSchema = z.object({
  receiverName: z.string().trim().min(1, "Nhập tên người nhận").max(120),
  receiverPhone: z.string().trim().regex(/^0\d{9,10}$/, "SĐT không hợp lệ"),
  receiverAddress: z.string().trim().min(5, "Nhập địa chỉ").max(500),
  moneyCollection: z.number().int().min(0).max(100_000_000),
  note: z.string().trim().max(300).default(""),
  /** Người bấm đã xác nhận TƯỜNG MINH việc đổi tiền thu hộ. Mặc định KHÔNG. */
  confirmCodChange: z.boolean().default(false),
});

export type VtpEditActor = { id: string | null; email: string; name: string };
export type VtpEditResult = { ok: true; message: string; number: string } | { error: string };

export async function applyVtpOrderEdit(actor: VtpEditActor, shipmentId: string, input: unknown): Promise<VtpEditResult> {
  const parsed = vtpEditSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { confirmCodChange, ...fields } = parsed.data;

  const db = await getDb();
  const s = await db.query.shipments.findFirst({
    where: eq(schema.shipments.id, shipmentId),
    columns: { id: true, vtpOrderNumber: true, trackingCode: true, codAmount: true, receiverName: true, receiverPhone: true, receiverAddress: true },
  });
  if (!s) return { error: "Không tìm thấy vận đơn" };
  const number = s.vtpOrderNumber ?? s.trackingCode;
  if (!number) return { error: "Vận đơn chưa có mã Viettel Post" };

  const codChanged = codChangeRequiresConfirmation(s.codAmount, fields.moneyCollection);
  if (codChanged && !confirmCodChange) {
    return { error: `Tiền thu hộ sẽ đổi: COD hiện tại ${formatVND(s.codAmount)} → mới ${formatVND(fields.moneyCollection)}. Đánh dấu ô xác nhận đổi COD rồi gửi lại — chưa gửi gì lên Viettel Post.` };
  }

  try {
    const client = getViettelPostClient();
    const res = await client.editOrder(number, fields);
    await db.update(schema.shipments).set({ codAmount: fields.moneyCollection, updatedAt: new Date() }).where(eq(schema.shipments.id, shipmentId));
    const who = actor.name || actor.email;
    const codText = codChanged ? `COD ${formatVND(s.codAmount)} → ${formatVND(fields.moneyCollection)}` : `COD ${formatVND(fields.moneyCollection)} (không đổi)`;
    const note = `${who}: ${fields.receiverName} · ${fields.receiverPhone} · ${fields.receiverAddress} · ${codText}${fields.note ? ` · ${fields.note}` : ""} · VTP: ${res.message || "OK"}`;
    await db.insert(schema.shipmentEvents).values({ shipmentId, source: "MANUAL", status: "ERP · Sửa đơn", statusName: "ERP · Sửa đơn", note, occurredAt: new Date() }).onConflictDoNothing();
    await audit({
      userId: actor.id,
      userEmail: actor.email,
      action: "VTP_ORDER_EDIT",
      entity: "SHIPMENT",
      entityId: shipmentId,
      before: { codAmount: s.codAmount, receiverName: s.receiverName, receiverPhone: s.receiverPhone, receiverAddress: s.receiverAddress },
      after: { codAmount: fields.moneyCollection, receiverName: fields.receiverName, receiverPhone: fields.receiverPhone, receiverAddress: fields.receiverAddress, note: fields.note },
      reason: codChanged ? "Người dùng xác nhận đổi tiền thu hộ trên Viettel Post" : undefined,
      detail: { number, codChanged, response: res.message },
    });
    return { ok: true, number, message: `Đã gửi sửa đơn ${number} lên Viettel Post${res.message ? ` · ${res.message}` : ""}` };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { error: /quy[eề]n|permission|không tồn tại|not exist/i.test(message) ? `${message} — tài khoản Viettel Post trong ERP phải là chủ vận đơn.` : message };
  }
}

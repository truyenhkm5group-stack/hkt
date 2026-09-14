"use server";

/**
 * Ghi đè lý do hoàn bằng bằng chứng của con người.
 *
 * Suy luận của máy chỉ phủ được ~22% vận đơn hoàn (đo production 13/09/2026). Người xử lý thường
 * BIẾT lý do — họ vừa gọi cho khách xong. Đây là chỗ ghi lại điều đó.
 *
 * Nhật ký ghi CẢ lý do cũ lẫn lý do máy suy ra tại thời điểm ghi đè: một con số đi vào báo cáo
 * hiệu suất mã hàng thì phải lần ngược được về người đã quyết và bằng chứng họ dựa vào.
 *
 * ─── ĐÂY LÀ CỬA GHI DUY NHẤT CHO LÝ DO HOÀN DO NGƯỜI XÁC ĐỊNH ───
 *
 * Mọi màn hình (bàn care, danh sách vận đơn, chi tiết vận đơn) gọi CHÍNH hàm này. Mở một cửa ghi
 * thứ hai là mở đường để hai chỗ ghi hai bảng khác nhau rồi báo cáo đọc một bảng.
 *
 * Hàm ghi HAI bảng, mỗi bảng một câu hỏi:
 *   `shipment_return_reasons`      — KẾT LUẬN HIỆN HÀNH. Một kiện một dòng, đè lên được.
 *   `return_reason_observations`   — LỊCH SỬ AI NÓI GÌ. Chỉ thêm, không bao giờ sửa.
 */
import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { RETURN_REASON_GROUP_OF, RETURN_REASON_LABEL, RETURN_REASONS } from "@/lib/constants/return-reason";
import { ghiQuanSat } from "@/lib/returns/reason-observe";
import { reasonsForShipments } from "@/lib/queries/return-reason";

const schemaInput = z.object({
  shipmentId: z.string().min(1),
  reason: z.enum(RETURN_REASONS),
  /**
   * GHI CHÚ TỰ DO — KHÔNG PHẢI LÝ DO.
   *
   * `reason` là danh mục để đếm; `note` là câu chuyện cho người sau đọc. Nơi gọi KHÔNG được nhét
   * lý do vào đây: "vải mỏng quá khách kêu" nằm trong ô ghi chú thì báo cáo không bao giờ đếm
   * được nó. Ô chọn lý do là bắt buộc, ô ghi chú là tuỳ.
   */
  note: z.string().trim().max(500).default(""),
});

export async function setReturnReason(input: unknown): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  // Cùng quyền với các thao tác care khác: người đang xử lý kiện là người biết lý do.
  if (!can(user, "shipments:view")) return { error: "Không có quyền" };
  const parsed = schemaInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { shipmentId, reason, note } = parsed.data;

  const db = await getDb();
  const vanDon = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, shipmentId), columns: { id: true, vtpOrderNumber: true } });
  if (!vanDon) return { error: "Không tìm thấy vận đơn" };

  // Lý do ĐANG có hiệu lực trước khi ghi đè — chép vào nhật ký để so được về sau.
  const truoc = (await reasonsForShipments([shipmentId])).get(shipmentId);

  /*
    NHÓM LƯU KÈM LÀ ẢNH CHỤP LÚC GHI, không phải nguồn của phép gộp: báo cáo suy nhóm lúc ĐỌC qua
    `effectiveGroupOf` để chủ shop chỉnh được cách xếp mà không phải viết lại lịch sử. Cột này
    giữ lại câu "hồi đó xếp vào đâu".
  */
  const reasonGroup = RETURN_REASON_GROUP_OF[reason];
  /*
    CHỮ GỐC CỦA ĐVVC ĐƯỢC CHÉP LẠI, NGUYÊN VĂN.

    Người đè lên máy thì chữ ĐVVC biến mất khỏi màn hình. Chép nó vào đây giữ cả hai vế cạnh nhau:
    ca xếp "vải xấu" mà chứng từ ĐVVC nói "khách hẹn giao lại" là ca đáng hỏi lại — và chỉ thấy
    được nếu chữ gốc còn đó. Máy không có chữ nào thì để RỖNG, không bịa.
  */
  const rawReason = (truoc?.rawReason ?? "").slice(0, 500);
  await db
    .insert(schema.shipmentReturnReasons)
    .values({
      shipmentId,
      reason,
      reasonGroup,
      note,
      rawReason,
      inferredReason: truoc?.manual ? "" : (truoc?.reason ?? "UNKNOWN"),
      source: "MANUAL",
      confidence: "CONFIRMED",
      actorId: user.id,
      actorEmail: user.email,
    })
    .onConflictDoUpdate({
      target: schema.shipmentReturnReasons.shipmentId,
      /*
        Sửa lại lý do VẪN là người xác định — giữ `source`/`confidence`, chỉ đổi nội dung và người.

        `raw_reason` chỉ ĐIỀN VÀO CHỖ TRỐNG (`nullif(…, '')`), không ghi đè: lần xác nhận thứ hai
        đọc lại chữ của chính dòng đó (máy nay thấy `CONFIRMED`), nên ghi đè sẽ xoá mất chứng từ
        ĐVVC gốc bằng một bản sao của chính nó — hoặc bằng chuỗi rỗng.
      */
      set: {
        reason,
        reasonGroup,
        note,
        rawReason: sql`coalesce(nullif(${schema.shipmentReturnReasons.rawReason}, ''), ${rawReason})`,
        source: "MANUAL",
        confidence: "CONFIRMED",
        actorId: user.id,
        actorEmail: user.email,
        updatedAt: new Date(),
      },
    });

  /*
    ═══ VÀ GHI MỘT QUAN SÁT — BẢNG KẾT LUẬN KHÔNG THAY ĐƯỢC BẢNG LỊCH SỬ ═══

    `shipment_return_reasons` giữ KẾT LUẬN HIỆN HÀNH của kiện: một kiện một dòng, lần ghi sau đè
    lần ghi trước. Đó là hình dạng đúng cho câu hỏi "giờ shop kết luận thế nào", và là hình dạng
    SAI cho câu hỏi "ai đã nói gì, lúc nào" — hai người xử lý cùng một kiện nói hai điều khác nhau
    thì dòng thứ hai xoá mất dòng thứ nhất và không ai thấy chúng từng mâu thuẫn.

    Nên lần ghi tay nào cũng để lại một dòng quan sát CHỈ-THÊM. Khoá chống trùng đi theo NỘI DUNG:
    bấm lại đúng lý do cũ là không-thao-tác, đổi sang lý do khác là một quan sát mới.
  */
  await ghiQuanSat(db, [
    {
      shipmentId,
      orderId: null,
      source: "HUMAN_CONFIRMED",
      // Chữ gốc của quan sát NÀY là nhãn người đó chọn, cộng ghi chú. Đây là chữ của NGƯỜI — khác
      // hẳn `raw_reason` của ĐVVC ở trên, và hai cái cùng sống, không cái nào xoá cái nào.
      rawText: note ? `${RETURN_REASON_LABEL[reason]} — ${note}` : RETURN_REASON_LABEL[reason],
      occurredAt: new Date(),
      sourceRef: "action:setReturnReason",
      // QUY KẾT ĐI BẰNG KHOÁ TÀI KHOẢN; ô chữ chỉ là ảnh chụp tên (AGENTS.md mục 34).
      actorId: user.id,
      actorEmail: user.email,
    },
  ]);

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "RETURN_REASON_SET",
    entity: "SHIPMENT",
    entityId: shipmentId,
    detail: {
      tracking: vanDon.vtpOrderNumber,
      before: { reason: truoc?.reason ?? "UNKNOWN", confidence: truoc?.confidence ?? "NONE", evidence: truoc?.evidence ?? "", rawReason: truoc?.rawReason ?? "" },
      after: { reason, reasonGroup, note, rawReason },
    },
  });

  revalidatePath("/shipments");
  revalidatePath("/reports/returns");
  return { ok: true };
}

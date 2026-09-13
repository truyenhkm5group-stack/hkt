import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { carrierSubstate, type CarrierSubstate } from "@/lib/constants/carrier-substate";
import type { CareOutcome } from "@/lib/constants/care-outcome";
import type { ShipmentStage } from "@/db/schema";

/**
 * ═══════════ VÒNG ĐỜI CA CHĂM SÓC — ĐVVC MỞ CA, VÀ ĐVVC ĐÓNG CA ═══════════
 *
 * ─── VÒNG CHẠY ĐẦY ĐỦ ───
 *
 *   ĐVVC báo sự cố  →  ERP MỞ đợt chăm sóc  →  giao người  →  người xử lý
 *                                                                 ↓
 *   KPI cứu đơn  ←  chốt kết quả  ←  ĐVVC báo kết cục cuối  ←  ĐVVC cập nhật
 *
 * Hai đầu của vòng này đều là ĐVVC, không phải người. Người ở GIỮA. Đó là lý do không thao tác nào
 * của nhân viên được phép mở hay đóng một ca: bấm "Phát tiếp" không làm hàng đi tiếp, bấm "Đã xong"
 * không làm hàng tới tay khách.
 *
 * ─── VÌ SAO KHÔNG ĐẾM SỐ LẦN BẤM ───
 *
 * Một hệ thống chấm điểm theo số thao tác sẽ được tối ưu theo số thao tác: mở ca, bấm một nút, đóng
 * ca. Kết quả đo được bằng chứng từ của bên thứ ba thì không tối ưu bằng cách đó được — muốn con số
 * đẹp thì phải thật sự cứu được đơn.
 */

/** Trạng thái con nào MỞ một đợt chăm sóc. Đúng hai, theo đặc tả nghiệp vụ của chủ shop. */
export const CARE_ENTRY_SUBSTATES: CarrierSubstate[] = ["WAITING_PROCESSING", "WAITING_REDELIVERY"];

/**
 * Trạng thái con nào KẾT THÚC một đợt, và kết thúc theo hướng nào.
 *
 * `DELIVERY_EXCEPTION` cố ý KHÔNG nằm đây: "tồn - khách nghỉ" là kiện đang vướng, chưa phải kết
 * cục. Đóng ca ở đó là tuyên bố thất bại trong khi bưu tá còn có thể quay lại.
 */
const KET_CUC: Partial<Record<CarrierSubstate, "DELIVERED" | "FAILED">> = {
  DELIVERED: "DELIVERED",
  RETURNING: "FAILED",
  RETURNED: "FAILED",
  CANCELLED: "FAILED",
};

export type LifecycleResult = {
  /** Mở đợt mới hay không. */
  opened: boolean;
  /** Chốt kết quả hay không. */
  resolved: boolean;
  careCaseId: string | null;
  outcome: CareOutcome | null;
  /** Vì sao máy làm như vậy — hiện ra trong nhật ký, không giấu. */
  reason: string;
};

const KHONG_LAM_GI: LifecycleResult = { opened: false, resolved: false, careCaseId: null, outcome: null, reason: "" };

/**
 * "ĐỢT NÀY CHƯA CÓ KẾT QUẢ CUỐI" — vế bảo vệ chống đếm hai lần.
 *
 * Cẩn thận ở đây: đợt vừa mở mang `care_outcome = 'PENDING'`, KHÔNG phải `NULL`. Viết `IS NULL`
 * thì vế này không bao giờ khớp và mọi lần chốt đều trượt — hỏng lặng lẽ, không lỗi nào phát ra.
 * Còn `NULL` là của 70 ca lịch sử (migration 0075 cố ý không backfill), nên cả hai đều phải nằm
 * trong vế này.
 */
const CHUA_CO_KET_QUA = or(isNull(schema.shipmentCare.careOutcome), inArray(schema.shipmentCare.careOutcome, ["PENDING"]));

/**
 * ═══════════ MỘT SỰ KIỆN ĐVVC ĐI QUA ĐÂY MỘT LẦN ═══════════
 *
 * Gọi từ `applyVtpTracking` sau khi trạng thái kiện đã được dựng lại từ lịch sử. Hàm này KHÔNG ghi
 * gì vào `shipments` — chiều ĐVVC là chứng từ, chỉ đọc.
 *
 * ─── IDEMPOTENT BẰNG CẤU TRÚC, KHÔNG BẰNG KỶ LUẬT ───
 *
 * Webhook của Viettel Post có thể trùng và ĐVVC thử lại tới 5 lần. Ba lớp chặn, xếp theo độ chắc:
 *
 *  1. **Chỉ mục duy nhất từng phần** (`shipment_care_active_uidx`): tối đa MỘT đợt đang mở cho mỗi
 *     kiện. Lệnh chèn thứ hai bị CSDL từ chối — không phụ thuộc vào việc mã nguồn có nhớ kiểm hay không.
 *  2. **Chốt kết quả chỉ chạy trên đợt CHƯA có `care_outcome`**: điều kiện nằm trong mệnh đề `where`
 *     của chính lệnh `update`, nên hai lượt chạy song song thì chỉ một lượt ghi được.
 *  3. Đợt đã đóng KHÔNG bao giờ được mở lại bởi một sự kiện — sự cố mới sinh ra đợt MỚI.
 */
export async function applyCarrierEventToCare(
  db: Db,
  input: { shipmentId: string; orderId: string | null; trackingNumber: string | null; stage: ShipmentStage; vtpStatus: number | null; vtpStatusName: string | null; occurredAt: Date },
): Promise<LifecycleResult> {
  const { substate } = carrierSubstate({ code: input.vtpStatus, text: input.vtpStatusName, stage: input.stage });

  const dangMo = await db.query.shipmentCare.findFirst({
    where: and(eq(schema.shipmentCare.shipmentId, input.shipmentId), eq(schema.shipmentCare.active, true)),
  });

  /* ───────── ĐÓNG: ĐVVC đã nói kết cục cuối ───────── */
  const ketCuc = KET_CUC[substate];
  if (ketCuc && dangMo) {
    /*
      CÓ ĐƠN ĐỔI ĐANG CHẠY THÌ CHƯA KẾT LUẬN THẤT BẠI.

      Kiện gốc quay về là điều ĐƯƠNG NHIÊN khi đội đã chọn gửi hàng đổi — kết luận "không cứu được"
      lúc này là chấm điểm sai cho đúng việc làm đúng. Ca chờ kết cục của ĐƠN THAY THẾ.
    */
    if (ketCuc === "FAILED" && dangMo.replacementShipmentId) {
      return { ...KHONG_LAM_GI, careCaseId: dangMo.id, reason: "kiện gốc quay về nhưng có đơn đổi đang chạy — chờ kết cục của đơn đổi" };
    }
    const outcome: CareOutcome = ketCuc === "DELIVERED" ? "RESCUED_DIRECT" : "RESCUE_FAILED";
    const [ghi] = await db
      .update(schema.shipmentCare)
      .set({
        active: false,
        careStatus: "RESOLVED",
        careOutcome: outcome,
        finalCarrierState: substate,
        finalLogisticsOutcome: ketCuc,
        outcomeAt: input.occurredAt,
        doneAt: sql`coalesce(${schema.shipmentCare.doneAt}, ${input.occurredAt})`,
        // Người CHỊU TRÁCH NHIỆM kết quả = người đang cầm ca lúc chốt. Chưa ai nhận thì để NULL:
        // không đổ kết quả cho một người chỉ vì họ từng chạm vào ca.
        ownerAtResolution: dangMo.ownerId,
        updatedBy: "SYSTEM",
        updatedAt: new Date(),
      })
      // LỚP CHẶN 2: chỉ ghi khi đợt CHƯA có kết quả. Hai lượt chạy song song thì chỉ một lượt thắng.
      .where(and(eq(schema.shipmentCare.id, dangMo.id), eq(schema.shipmentCare.active, true), CHUA_CO_KET_QUA))
      .returning({ id: schema.shipmentCare.id });
    if (!ghi) return { ...KHONG_LAM_GI, careCaseId: dangMo.id, reason: "đợt đã được chốt bởi một lượt khác — không đếm hai lần" };
    await db
      .insert(schema.careCaseEvents)
      .values({
        shipmentId: input.shipmentId,
        source: "SYSTEM",
        action: "RESOLVE",
        note: `ĐVVC báo “${input.vtpStatusName ?? substate}” — chốt kết quả theo chứng từ`,
        previousStatus: dangMo.careStatus,
        nextStatus: "RESOLVED",
        payload: { substate, outcome, auto: true, occurredAt: input.occurredAt.toISOString() },
      })
      .onConflictDoNothing();
    return { opened: false, resolved: true, careCaseId: dangMo.id, outcome, reason: `ĐVVC báo ${substate}` };
  }

  /* ───────── MỞ: ĐVVC báo một sự cố cần người ───────── */
  if (!CARE_ENTRY_SUBSTATES.includes(substate)) {
    return { ...KHONG_LAM_GI, careCaseId: dangMo?.id ?? null, reason: "trạng thái không mở và không đóng đợt nào" };
  }

  /*
    CHUYỂN GIỮA HAI TRẠNG THÁI SỰ CỐ KHÔNG PHẢI MỘT SỰ CỐ MỚI.

    "Chờ xử lý" → "Chờ phát lại" là cùng MỘT đợt hỏng đang diễn tiến. Mở ca thứ hai ở đây sẽ nhân
    đôi khối lượng việc trong báo cáo và chia đôi công của người đang xử lý.
  */
  if (dangMo) {
    await db
      .update(schema.shipmentCare)
      .set({ updatedAt: new Date() })
      .where(eq(schema.shipmentCare.id, dangMo.id));
    return { ...KHONG_LAM_GI, careCaseId: dangMo.id, reason: "đợt đang mở vẫn còn — cập nhật diễn tiến, không mở ca mới" };
  }

  const soDot = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.shipmentCare)
    .where(eq(schema.shipmentCare.shipmentId, input.shipmentId));
  const episodeNo = Number(soDot[0]?.n ?? 0) + 1;

  // LỚP CHẶN 1: chỉ mục duy nhất từng phần. Gói tin trùng chạy song song thì dòng thứ hai bị từ
  // chối ở CSDL, và ở đây chỉ cần im lặng bỏ qua — không phải một lỗi.
  const [moi] = await db
    .insert(schema.shipmentCare)
    .values({
      shipmentId: input.shipmentId,
      orderId: input.orderId,
      trackingNumber: input.trackingNumber,
      episodeNo,
      active: true,
      careStatus: "NEW",
      entryCarrierState: substate,
      sourceTrigger: "CARRIER_EVENT",
      openedAt: input.occurredAt,
      careOutcome: "PENDING",
      updatedBy: "SYSTEM",
    })
    .onConflictDoNothing()
    .returning({ id: schema.shipmentCare.id });
  if (!moi) return { ...KHONG_LAM_GI, reason: "đợt đã được mở bởi một lượt khác — gói tin trùng" };

  await db
    .insert(schema.careCaseEvents)
    .values({
      shipmentId: input.shipmentId,
      source: "SYSTEM",
      action: "STATUS",
      note: `ĐVVC báo “${input.vtpStatusName ?? substate}” — mở đợt chăm sóc thứ ${episodeNo}`,
      nextStatus: "NEW",
      payload: { substate, episodeNo, auto: true, occurredAt: input.occurredAt.toISOString() },
    })
    .onConflictDoNothing();
  return { opened: true, resolved: false, careCaseId: moi.id, outcome: "PENDING", reason: `ĐVVC báo ${substate}` };
}

/**
 * ═══════════ ĐƠN ĐỔI GIAO THÀNH CÔNG ⇒ CA GỐC ĐƯỢC CỨU BẰNG ĐƠN ĐỔI ═══════════
 *
 * Tách riêng khỏi `RESCUED_DIRECT` vì hai việc khác nhau về chi phí (thêm một lượt cước, một lần
 * đóng gói), khác nhau về thời gian, và nói hai điều khác nhau về năng lực của đội.
 */
export async function settleExchangeOutcome(db: Db, replacementShipmentId: string, stage: ShipmentStage, occurredAt: Date): Promise<LifecycleResult> {
  const { substate } = carrierSubstate({ code: null, text: null, stage });
  const ketCuc = KET_CUC[substate];
  if (!ketCuc) return { ...KHONG_LAM_GI, reason: "đơn đổi chưa có kết cục cuối" };

  const goc = await db.query.shipmentCare.findFirst({
    where: and(eq(schema.shipmentCare.replacementShipmentId, replacementShipmentId), CHUA_CO_KET_QUA),
  });
  if (!goc) return { ...KHONG_LAM_GI, reason: "không có ca gốc nào đang chờ đơn đổi này" };

  const outcome: CareOutcome = ketCuc === "DELIVERED" ? "RESCUED_EXCHANGE" : "RESCUE_FAILED";
  const [ghi] = await db
    .update(schema.shipmentCare)
    .set({ active: false, careStatus: "RESOLVED", careOutcome: outcome, finalCarrierState: substate, finalLogisticsOutcome: ketCuc, outcomeAt: occurredAt, ownerAtResolution: goc.ownerId, updatedBy: "SYSTEM", updatedAt: new Date() })
    .where(and(eq(schema.shipmentCare.id, goc.id), CHUA_CO_KET_QUA))
    .returning({ id: schema.shipmentCare.id });
  if (!ghi) return { ...KHONG_LAM_GI, careCaseId: goc.id, reason: "ca gốc đã được chốt bởi một lượt khác" };
  return { opened: false, resolved: true, careCaseId: goc.id, outcome, reason: `đơn đổi ${ketCuc}` };
}

import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { careEntryFor, CARE_ENTRY_SUBSTATES, CARE_TERMINAL_STAGES, LEFT_WAREHOUSE_EVENT_STAGES, legAwareStage, legAwareSubstate } from "@/lib/care/entry";
import { settleCarrierRequests } from "@/lib/care/carrier-requests";
import { SUBSTATE_IMPLIES_PICKED_UP, type CarrierSubstate } from "@/lib/constants/carrier-substate";
import type { CareOutcome } from "@/lib/constants/care-outcome";
import { CARE_TERMINAL_STATUSES, type CareStatus } from "@/lib/constants/care";
import { carrierSubstateSql } from "@/lib/queries/carrier-substate-sql";
import { rowsOf } from "@/lib/sql-rows";
import type { ShipmentStage } from "@/db/schema";

export { CARE_ENTRY_SUBSTATES };

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
 * của nhân viên được phép mở hay chốt KẾT QUẢ một ca: bấm "Phát tiếp" không làm hàng đi tiếp, bấm
 * "Đã xong" không làm hàng tới tay khách. Người ĐÓNG được ca (rời hàng đợi), nhưng kết quả vẫn treo
 * `PENDING` cho tới khi chứng từ ĐVVC nói kết cục — và lúc đó nó được chốt lên đúng đợt ấy, dù đợt
 * đã đóng.
 *
 * ─── HAI CHIỀU CỦA MỘT MÃ TRẠNG THÁI ───
 *
 * Viettel Post ghi 501 "Phát thành công" cho cả phát tới khách lẫn phát hàng hoàn về shop (luật
 * nghiệp vụ 2a). Bản trước đọc mã thô nên một gói tin 501 chiều hoàn sẽ chốt ca là "CỨU ĐƯỢC" — sai
 * ngược 180 độ (đo 13/09/2026: chưa ca nào dính, nên sửa TRƯỚC khi nó xảy ra). Nay mọi quyết định
 * ĐÓNG đi theo CHẶNG LEG-AWARE (chặng đã dựng từ lịch sử, có cờ `IS_RETURNING`), còn quyết định MỞ
 * đi theo mã + chữ và bị chặn hoàn toàn trên chiều hoàn.
 *
 * ─── VÌ SAO KHÔNG ĐẾM SỐ LẦN BẤM ───
 *
 * Một hệ thống chấm điểm theo số thao tác sẽ được tối ưu theo số thao tác. Kết quả đo bằng chứng
 * từ của bên thứ ba thì không tối ưu bằng cách đó được — muốn con số đẹp thì phải thật sự cứu đơn.
 */

/** Đợt đóng vì kiện không (còn) trong điều kiện cần care — không phải kết quả cứu đơn. */
export const NOT_CARE_CONDITION = "NOT_CARE_CONDITION";

export type LifecycleResult = {
  /** Mở đợt mới hay không. */
  opened: boolean;
  /** Chốt kết quả hay không. */
  resolved: boolean;
  /** Đóng vì không còn điều kiện cần care (không phải kết quả). */
  dismissed: boolean;
  careCaseId: string | null;
  outcome: CareOutcome | null;
  /** Vì sao máy làm như vậy — hiện ra trong nhật ký, không giấu. */
  reason: string;
};

const KHONG_LAM_GI: LifecycleResult = { opened: false, resolved: false, dismissed: false, careCaseId: null, outcome: null, reason: "" };

/**
 * "ĐỢT NÀY CHƯA CÓ KẾT QUẢ CUỐI" — vế bảo vệ chống đếm hai lần.
 *
 * Cẩn thận ở đây: đợt vừa mở mang `care_outcome = 'PENDING'`, KHÔNG phải `NULL`. Viết `IS NULL`
 * thì vế này không bao giờ khớp và mọi lần chốt đều trượt — hỏng lặng lẽ, không lỗi nào phát ra.
 * Còn `NULL` là của 76 ca lịch sử (migration 0075 cố ý không backfill), nên cả hai đều nằm trong
 * vế này. Đợt đóng vì `NOT_CARE_CONDITION` cũng mang `NULL` nhưng bị loại bằng `resolution`.
 */
const CHUA_CO_KET_QUA = and(
  or(isNull(schema.shipmentCare.careOutcome), inArray(schema.shipmentCare.careOutcome, ["PENDING"])),
  or(isNull(schema.shipmentCare.resolution), sql`${schema.shipmentCare.resolution} <> ${NOT_CARE_CONDITION}`),
);

/** Chứng từ rời kho: CÓ hay không, và từ LÚC NÀO (mốc sớm nhất). */
export type LeftWarehouseEvidence = { left: boolean; since: Date | null };

/**
 * Chứng từ RỜI KHO: mốc lấy hàng, hoặc một sự kiện hành trình mang chặng sau mốc lấy. Cùng vế với
 * tháp giao vận. `since` là mốc SỚM NHẤT trong hai thứ đó — cần nó để biết một đợt được mở TRƯỚC
 * hay SAU khi gói hàng rời kho.
 */
export async function leftWarehouseEvidence(db: Db, shipmentId: string): Promise<LeftWarehouseEvidence> {
  const rows = rowsOf<{ da_roi_kho: boolean; tu_luc: string | null }>(
    await db.execute(sql`
      select (s.picked_up_at is not null
              or exists (select 1 from shipment_events e where e.shipment_id = s.id and e.normalized_stage in ${LEFT_WAREHOUSE_EVENT_STAGES})) as da_roi_kho,
             least(s.picked_up_at, (select min(e.occurred_at) from shipment_events e where e.shipment_id = s.id and e.normalized_stage in ${LEFT_WAREHOUSE_EVENT_STAGES})) as tu_luc
        from shipments s where s.id = ${shipmentId}
    `),
  );
  const r = rows[0];
  return { left: Boolean(r?.da_roi_kho), since: r?.tu_luc ? new Date(r.tu_luc) : null };
}

export async function hasLeftWarehouseEvidence(db: Db, shipmentId: string): Promise<boolean> {
  return (await leftWarehouseEvidence(db, shipmentId)).left;
}

/**
 * ĐỢT MỞ KHI HÀNG CÒN TRONG KHO — tức chưa bao giờ là việc của đội chăm sóc.
 *
 * Đúng 106 đợt trên production 13/09/2026: mã 102 "chờ xử lý" mở đợt trước mốc lấy hàng. Nhận
 * diện bằng THỜI GIAN, không bằng trạng thái hiện tại: chứng từ rời kho hoặc chưa có, hoặc xuất
 * hiện SAU lúc mở đợt. Đợt mở khi hàng đã đi (chờ phát lại, tồn, chờ xử lý ở bưu cục) rồi kiện đi
 * tiếp / quay đầu là đợt THẬT — kết quả của nó chờ ĐVVC chốt, không được đóng như "không phải việc".
 */
function moTruocKhiRoiKho(c: CareRow, ev: LeftWarehouseEvidence): boolean {
  if (c.entryCarrierState !== "WAITING_PROCESSING") return false;
  if (!ev.left) return true;
  return ev.since !== null && c.openedAt !== null && ev.since.getTime() > c.openedAt.getTime();
}

type KetCuc = { outcome: CareOutcome; logistics: "DELIVERED" | "FAILED" } | { outcome: null; logistics: "NOT_CARE" };

/**
 * KẾT CỤC của một đợt theo chặng LEG-AWARE. `RETURNING` (502/505/515) cố ý KHÔNG có ở đây: kiện
 * đang quay đầu vẫn chưa phải kết cục — bưu cục có thể phát lại. Chỉ chặng cuối mới chốt.
 */
function ketCucCua(stage: ShipmentStage, leftWarehouse: boolean): KetCuc | null {
  if (stage === "DELIVERED") return { outcome: "RESCUED_DIRECT", logistics: "DELIVERED" };
  if (stage === "RETURNED") return { outcome: "RESCUE_FAILED", logistics: "FAILED" };
  if (stage === "CANCELLED") {
    // Huỷ TRƯỚC khi rời kho (101/107/201, chưa bưu tá nào cầm) không phải một lần cứu đơn thất bại —
    // gói hàng chưa bao giờ có cơ hội tới tay khách. Huỷ / tiêu huỷ (503) SAU khi đã rời kho thì có.
    return leftWarehouse ? { outcome: "RESCUE_FAILED", logistics: "FAILED" } : { outcome: null, logistics: "NOT_CARE" };
  }
  return null;
}

type CareRow = typeof schema.shipmentCare.$inferSelect;

/** Đợt máy mở mà CHƯA AI ĐỘNG VÀO — chỉ những đợt này máy mới được tự đóng vì "không phải điều kiện care". */
function chuaAiDongVao(c: CareRow): boolean {
  return (c.sourceTrigger === "CARRIER_EVENT" || c.sourceTrigger === "RECONCILE") && c.careStatus === "NEW" && c.ownerId === null && c.firstResponseAt === null && c.lastNote === "";
}

async function ghiSuKien(db: Db, v: typeof schema.careCaseEvents.$inferInsert) {
  await db.insert(schema.careCaseEvents).values(v).onConflictDoNothing();
}

/**
 * CHỐT KẾT QUẢ lên một đợt. Chạy trên đợt đang mở HOẶC đợt người đã đóng mà chưa có kết cục — "đã
 * xong" của người không làm chứng từ ĐVVC mất chỗ để về.
 */
async function chotKetQua(db: Db, target: CareRow, ketCuc: KetCuc, p: { substate: CarrierSubstate; occurredAt: Date; statusName: string | null; source: string }): Promise<LifecycleResult> {
  if (ketCuc.logistics === "FAILED" && target.replacementShipmentId) {
    /*
      CÓ ĐƠN ĐỔI ĐANG CHẠY THÌ CHƯA KẾT LUẬN THẤT BẠI.

      Kiện gốc quay về là điều ĐƯƠNG NHIÊN khi đội đã chọn gửi hàng đổi — kết luận "không cứu được"
      lúc này là chấm điểm sai cho đúng việc làm đúng. Ca chờ kết cục của ĐƠN THAY THẾ.
    */
    return { ...KHONG_LAM_GI, careCaseId: target.id, reason: "kiện gốc quay về nhưng có đơn đổi đang chạy — chờ kết cục của đơn đổi" };
  }
  const daDong = CARE_TERMINAL_STATUSES.includes(target.careStatus as CareStatus);
  const nextStatus: CareStatus = daDong ? (target.careStatus as CareStatus) : ketCuc.logistics === "NOT_CARE" ? "CANCELLED" : "RESOLVED";
  const [ghi] = await db
    .update(schema.shipmentCare)
    .set({
      active: false,
      careStatus: nextStatus,
      careOutcome: ketCuc.outcome,
      resolution: ketCuc.logistics === "NOT_CARE" ? NOT_CARE_CONDITION : target.resolution,
      finalCarrierState: p.substate,
      finalLogisticsOutcome: ketCuc.logistics === "NOT_CARE" ? null : ketCuc.logistics,
      outcomeAt: ketCuc.logistics === "NOT_CARE" ? null : p.occurredAt,
      doneAt: sql`coalesce(${schema.shipmentCare.doneAt}, ${p.occurredAt})`,
      followUpAt: null,
      // Người CHỊU TRÁCH NHIỆM kết quả = người đang cầm ca lúc chốt. Chưa ai nhận thì để NULL:
      // không đổ kết quả cho một người chỉ vì họ từng chạm vào ca.
      ownerAtResolution: ketCuc.logistics === "NOT_CARE" ? null : target.ownerId,
      updatedBy: "SYSTEM",
      updatedAt: new Date(),
    })
    // LỚP CHẶN 2: chỉ ghi khi đợt CHƯA có kết quả. Hai lượt chạy song song thì chỉ một lượt thắng.
    .where(and(eq(schema.shipmentCare.id, target.id), CHUA_CO_KET_QUA))
    .returning({ id: schema.shipmentCare.id });
  if (!ghi) return { ...KHONG_LAM_GI, careCaseId: target.id, reason: "đợt đã được chốt bởi một lượt khác — không đếm hai lần" };
  await ghiSuKien(db, {
    shipmentId: target.shipmentId,
    source: "SYSTEM",
    action: ketCuc.logistics === "NOT_CARE" ? "CANCEL" : "RESOLVE",
    note:
      ketCuc.logistics === "NOT_CARE"
        ? `ĐVVC báo “${p.statusName ?? p.substate}” trước khi rời kho — đợt không phải điều kiện cần care, không tính kết quả`
        : `ĐVVC báo “${p.statusName ?? p.substate}” — chốt kết quả theo chứng từ`,
    previousStatus: target.careStatus,
    nextStatus,
    payload: { substate: p.substate, outcome: ketCuc.outcome, resolution: ketCuc.logistics === "NOT_CARE" ? NOT_CARE_CONDITION : null, auto: true, via: p.source, occurredAt: p.occurredAt.toISOString() },
  });
  if (ketCuc.logistics === "NOT_CARE") return { ...KHONG_LAM_GI, dismissed: true, careCaseId: target.id, reason: `huỷ trước khi rời kho — ${NOT_CARE_CONDITION}` };
  return { opened: false, resolved: true, dismissed: false, careCaseId: target.id, outcome: ketCuc.outcome, reason: `ĐVVC báo ${p.substate}` };
}

/** Đóng đợt máy mở, chưa ai động vào, vì kiện không (còn) trong điều kiện cần care. Không phải kết quả. */
async function dongViKhongCanCare(db: Db, target: CareRow, p: { substate: CarrierSubstate; reason: string; source: string; at: Date }): Promise<LifecycleResult> {
  const [ghi] = await db
    .update(schema.shipmentCare)
    .set({ active: false, careStatus: "CANCELLED", resolution: NOT_CARE_CONDITION, careOutcome: null, finalCarrierState: p.substate, doneAt: p.at, followUpAt: null, updatedBy: "SYSTEM", updatedAt: new Date() })
    .where(and(eq(schema.shipmentCare.id, target.id), eq(schema.shipmentCare.active, true), eq(schema.shipmentCare.careStatus, "NEW"), isNull(schema.shipmentCare.ownerId), isNull(schema.shipmentCare.firstResponseAt)))
    .returning({ id: schema.shipmentCare.id });
  if (!ghi) return { ...KHONG_LAM_GI, careCaseId: target.id, reason: "đợt đã có người động vào hoặc đã đóng — không tự đóng" };
  await ghiSuKien(db, {
    shipmentId: target.shipmentId,
    source: "SYSTEM",
    action: "CANCEL",
    note: `Máy đóng đợt: ${p.reason}`,
    previousStatus: target.careStatus,
    nextStatus: "CANCELLED",
    payload: { substate: p.substate, resolution: NOT_CARE_CONDITION, auto: true, via: p.source, occurredAt: p.at.toISOString() },
  });
  return { ...KHONG_LAM_GI, dismissed: true, careCaseId: target.id, reason: p.reason };
}

async function moDot(
  db: Db,
  p: { shipmentId: string; orderId: string | null; trackingNumber: string | null; substate: CarrierSubstate; sourceTrigger: "CARRIER_EVENT" | "RECONCILE"; openedAt: Date; statusName: string | null; reason: string },
): Promise<LifecycleResult> {
  const soDot = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.shipmentCare)
    .where(eq(schema.shipmentCare.shipmentId, p.shipmentId));
  const episodeNo = Number(soDot[0]?.n ?? 0) + 1;

  // LỚP CHẶN 1: chỉ mục duy nhất từng phần. Gói tin trùng chạy song song thì dòng thứ hai bị từ
  // chối ở CSDL, và ở đây chỉ cần im lặng bỏ qua — không phải một lỗi.
  const [moi] = await db
    .insert(schema.shipmentCare)
    .values({
      shipmentId: p.shipmentId,
      orderId: p.orderId,
      trackingNumber: p.trackingNumber,
      episodeNo,
      active: true,
      careStatus: "NEW",
      entryCarrierState: p.substate,
      sourceTrigger: p.sourceTrigger,
      openedAt: p.openedAt,
      careOutcome: "PENDING",
      updatedBy: "SYSTEM",
    })
    .onConflictDoNothing()
    .returning({ id: schema.shipmentCare.id });
  if (!moi) return { ...KHONG_LAM_GI, reason: "đợt đã được mở bởi một lượt khác — gói tin trùng" };

  await ghiSuKien(db, {
    shipmentId: p.shipmentId,
    source: "SYSTEM",
    action: "STATUS",
    note: `ĐVVC báo “${p.statusName ?? p.substate}” — mở đợt chăm sóc thứ ${episodeNo}${p.sourceTrigger === "RECONCILE" ? " (đối chiếu định kỳ)" : ""}`,
    nextStatus: "NEW",
    payload: { substate: p.substate, episodeNo, auto: true, sourceTrigger: p.sourceTrigger, openedAt: p.openedAt.toISOString(), reason: p.reason },
  });
  return { opened: true, resolved: false, dismissed: false, careCaseId: moi.id, outcome: "PENDING", reason: p.reason };
}

export type CarrierEventInput = {
  shipmentId: string;
  orderId: string | null;
  trackingNumber: string | null;
  /** Chặng HIỆN TẠI đã dựng từ lịch sử (`materializeShipmentState`) — đã leg-aware. */
  stage: ShipmentStage;
  vtpStatus: number | null;
  vtpStatusName: string | null;
  /** Chiều của sự kiện theo cờ IS_RETURNING. `null` = ĐVVC không nói; chặng leg-aware vẫn là lưới an toàn. */
  legType?: "OUTBOUND" | "RETURN" | null;
  occurredAt: Date;
  /** Chứng từ rời kho, nếu nơi gọi đã biết. Không biết thì hàm tự tra. */
  leftWarehouse?: boolean;
  /** Đường vào — hiện trong nhật ký. */
  source?: string;
};

/**
 * ═══════════ MỘT SỰ KIỆN ĐVVC ĐI QUA ĐÂY MỘT LẦN ═══════════
 *
 * Gọi SAU khi trạng thái kiện đã được dựng lại từ lịch sử. Hàm này KHÔNG ghi gì vào `shipments` —
 * chiều ĐVVC là chứng từ, chỉ đọc.
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
export async function applyCarrierEventToCare(db: Db, input: CarrierEventInput): Promise<LifecycleResult> {
  const stage = legAwareStage(input.stage, input.legType);
  const substate = legAwareSubstate({ code: input.vtpStatus, text: input.vtpStatusName, stage });
  const source = input.source ?? "CARRIER_EVENT";
  let chungTu: LeftWarehouseEvidence | null = input.leftWarehouse === undefined ? null : { left: input.leftWarehouse, since: null };
  const chungTuRoiKho = async () => (chungTu ??= await leftWarehouseEvidence(db, input.shipmentId));
  const roiKho = async () => (await chungTuRoiKho()).left;

  const dangMo = await db.query.shipmentCare.findFirst({
    where: and(eq(schema.shipmentCare.shipmentId, input.shipmentId), eq(schema.shipmentCare.active, true)),
  });

  /* ───────── ĐÓNG: ĐVVC đã nói kết cục cuối ───────── */
  if (CARE_TERMINAL_STAGES.includes(stage)) {
    const ketCuc = ketCucCua(stage, stage === "CANCELLED" ? await roiKho() : true);
    if (!ketCuc) return { ...KHONG_LAM_GI, careCaseId: dangMo?.id ?? null, reason: "chặng cuối không dịch được kết cục" };
    // Đợt đang mở, hoặc đợt gần nhất người đã đóng mà chưa có kết cục — "đã xong" của người không
    // làm chứng từ ĐVVC mất chỗ để về.
    const target =
      dangMo ??
      (await db.query.shipmentCare.findFirst({
        where: and(eq(schema.shipmentCare.shipmentId, input.shipmentId), CHUA_CO_KET_QUA),
        orderBy: [desc(schema.shipmentCare.episodeNo)],
      }));
    if (!target) return { ...KHONG_LAM_GI, reason: "không có đợt nào chờ kết cục" };
    return chotKetQua(db, target, ketCuc, { substate, occurredAt: input.occurredAt, statusName: input.vtpStatusName, source });
  }

  /* ───────── MỞ: ĐVVC báo một sự cố cần người ───────── */
  // Chiều hoàn: bưu tá đang mang hàng VỀ SHOP. Không còn khách nào để gọi — không mở, không đóng.
  const chieuHoan = input.legType === "RETURN" || stage === "RETURNING";
  // Chỉ tra chứng từ rời kho khi trạng thái con MƠ HỒ về việc đã cầm hàng (mã 102) — mọi trạng thái
  // khác tự nói được, và một truy vấn thừa cho mỗi webhook là một truy vấn thừa.
  const canChungTu = CARE_ENTRY_SUBSTATES.includes(substate) && SUBSTATE_IMPLIES_PICKED_UP[substate] === "AMBIGUOUS";
  const verdict = chieuHoan ? { enters: false, substate, reason: "sự kiện thuộc chiều hoàn — không có khách để chăm sóc" } : careEntryFor(substate, canChungTu ? await roiKho() : false);

  if (!verdict.enters) {
    // Đợt máy mở TRƯỚC mốc lấy hàng (mã 102) mà nay kiện đã đi tiếp: đóng nó lại vì nó chưa bao giờ
    // là việc của đội — và KHÔNG tính vào kết quả cứu đơn. Chỉ đợt CHƯA AI ĐỘNG VÀO, và không đóng
    // trên chiều hoàn: kiện đang quay đầu thì kết cục sắp tới là RETURNED, phải chốt như một kết quả.
    if (dangMo && !chieuHoan && chuaAiDongVao(dangMo) && moTruocKhiRoiKho(dangMo, await chungTuRoiKho())) {
      return dongViKhongCanCare(db, dangMo, { substate, reason: "đợt mở khi hàng còn trong kho (mã 102 trước mốc lấy hàng) — chưa bao giờ là điều kiện cần care", source, at: input.occurredAt });
    }
    return { ...KHONG_LAM_GI, careCaseId: dangMo?.id ?? null, reason: verdict.reason };
  }

  /*
    CHUYỂN GIỮA HAI TRẠNG THÁI SỰ CỐ KHÔNG PHẢI MỘT SỰ CỐ MỚI.

    "Chờ xử lý" → "Chờ phát lại" là cùng MỘT đợt hỏng đang diễn tiến. Mở ca thứ hai ở đây sẽ nhân
    đôi khối lượng việc trong báo cáo và chia đôi công của người đang xử lý.
  */
  if (dangMo) {
    await db.update(schema.shipmentCare).set({ updatedAt: new Date() }).where(eq(schema.shipmentCare.id, dangMo.id));
    return { ...KHONG_LAM_GI, careCaseId: dangMo.id, reason: "đợt đang mở vẫn còn — cập nhật diễn tiến, không mở ca mới" };
  }

  return moDot(db, { shipmentId: input.shipmentId, orderId: input.orderId, trackingNumber: input.trackingNumber, substate, sourceTrigger: "CARRIER_EVENT", openedAt: input.occurredAt, statusName: input.vtpStatusName, reason: verdict.reason });
}

/**
 * ═══════════ ĐƠN ĐỔI GIAO THÀNH CÔNG ⇒ CA GỐC ĐƯỢC CỨU BẰNG ĐƠN ĐỔI ═══════════
 *
 * Tách riêng khỏi `RESCUED_DIRECT` vì hai việc khác nhau về chi phí (thêm một lượt cước, một lần
 * đóng gói), khác nhau về thời gian, và nói hai điều khác nhau về năng lực của đội.
 */
export async function settleExchangeOutcome(db: Db, replacementShipmentId: string, stage: ShipmentStage, occurredAt: Date): Promise<LifecycleResult> {
  const ketCuc = ketCucCua(stage, true);
  if (!ketCuc || ketCuc.outcome === null) return { ...KHONG_LAM_GI, reason: "đơn đổi chưa có kết cục cuối" };

  const goc = await db.query.shipmentCare.findFirst({
    where: and(eq(schema.shipmentCare.replacementShipmentId, replacementShipmentId), CHUA_CO_KET_QUA),
  });
  if (!goc) return { ...KHONG_LAM_GI, reason: "không có ca gốc nào đang chờ đơn đổi này" };

  const outcome: CareOutcome = ketCuc.logistics === "DELIVERED" ? "RESCUED_EXCHANGE" : "RESCUE_FAILED";
  const daDong = CARE_TERMINAL_STATUSES.includes(goc.careStatus as CareStatus);
  const [ghi] = await db
    .update(schema.shipmentCare)
    .set({ active: false, careStatus: daDong ? goc.careStatus : "RESOLVED", careOutcome: outcome, finalCarrierState: stage === "DELIVERED" ? "DELIVERED" : "RETURNED", finalLogisticsOutcome: ketCuc.logistics, outcomeAt: occurredAt, doneAt: sql`coalesce(${schema.shipmentCare.doneAt}, ${occurredAt})`, ownerAtResolution: goc.ownerId, updatedBy: "SYSTEM", updatedAt: new Date() })
    .where(and(eq(schema.shipmentCare.id, goc.id), CHUA_CO_KET_QUA))
    .returning({ id: schema.shipmentCare.id });
  if (!ghi) return { ...KHONG_LAM_GI, careCaseId: goc.id, reason: "ca gốc đã được chốt bởi một lượt khác" };
  return { opened: false, resolved: true, dismissed: false, careCaseId: goc.id, outcome, reason: `đơn đổi ${ketCuc.logistics}` };
}

/**
 * ═══════════ MỘT CỬA SAU KHI TRẠNG THÁI VẬN ĐƠN ĐỔI ═══════════
 *
 * Trước bản này có BA đường ghi sự kiện hành trình rồi dựng lại trạng thái (`materializeShipmentState`)
 * mà chỉ MỘT đường (webhook / tra API mới hơn) đi tiếp vào vòng đời care: nhập bảng kê Viettel Post
 * và đồng bộ Pancake dựng lại trạng thái xong là dừng, và nhánh "gói tin đến muộn" của chính luồng
 * webhook cũng vậy. Kiện chốt kết cục qua những đường đó thì ca treo PENDING mãi.
 *
 * Nay cả ba đường gọi hàm này. Nó đọc ẢNH CHỤP đã dựng (chặng leg-aware, mã, chữ, mốc) và chạy đủ ba
 * việc theo đúng thứ tự: xác nhận lệnh đã gửi ĐVVC → mở/đóng đợt care → chốt đơn đổi. Nơi gọi có
 * thông tin chính xác hơn ảnh chụp (cờ IS_RETURNING của chính gói tin) thì truyền vào `override`.
 *
 * `.catch` ở từng bước là cố ý: vòng đời care KHÔNG được phép làm hỏng đường ghi chứng từ ĐVVC. Mất
 * một lần mở ca thì `reconcileCareCoverage` mở lại được; mất một sự kiện hành trình thì mất vĩnh viễn.
 */
export async function afterShipmentStateChange(
  db: Db,
  shipmentId: string,
  override: { legType?: "OUTBOUND" | "RETURN" | null; vtpStatus?: number | null; vtpStatusName?: string | null; occurredAt?: Date; source?: string } = {},
): Promise<LifecycleResult> {
  const s = await db.query.shipments.findFirst({
    where: eq(schema.shipments.id, shipmentId),
    columns: { id: true, orderId: true, vtpOrderNumber: true, trackingCode: true, stage: true, vtpStatus: true, vtpStatusName: true, vtpStatusDate: true },
  });
  if (!s) return { ...KHONG_LAM_GI, reason: "không tìm thấy vận đơn" };
  const stage = legAwareStage(s.stage, override.legType);
  const at = override.occurredAt ?? s.vtpStatusDate ?? new Date();
  await settleCarrierRequests(db, s.id, stage, at).catch(() => undefined);
  const r = await applyCarrierEventToCare(db, {
    shipmentId: s.id,
    orderId: s.orderId,
    trackingNumber: s.vtpOrderNumber ?? s.trackingCode,
    stage,
    vtpStatus: override.vtpStatus === undefined ? s.vtpStatus : override.vtpStatus,
    vtpStatusName: override.vtpStatusName === undefined ? s.vtpStatusName : override.vtpStatusName,
    legType: override.legType ?? null,
    occurredAt: at,
    source: override.source,
  }).catch((e: unknown) => ({ ...KHONG_LAM_GI, reason: `lỗi vòng đời care: ${e instanceof Error ? e.message : String(e)}` }));
  await settleExchangeOutcome(db, s.id, stage, at).catch(() => undefined);
  return r;
}

export type CareReconcileResult = {
  /** Kiện đang trong điều kiện cần care mà chưa có đợt ⇒ đã mở. */
  opened: number;
  /** Đợt máy mở, chưa ai động vào, kiện không còn trong điều kiện ⇒ đã đóng (không tính kết quả). */
  dismissed: number;
  /** Đợt còn treo trên kiện đã kết thúc ⇒ đã chốt kết quả theo chứng từ. */
  settled: number;
  scanned: number;
};

type UngVienMo = { id: string; order_id: string | null; tracking: string | null; stage: string; vtp_status: number | null; vtp_status_name: string | null; vtp_status_date: string | null; da_roi_kho: boolean };

/**
 * ═══════════ ĐỐI CHIẾU ĐỘ PHỦ — KHÔNG PHỤ THUỘC VÀO KHOẢNH KHẮC WEBHOOK ═══════════
 *
 * Webhook đến trước khi luật tồn tại, webhook rơi, nhập tệp đi đường khác — mọi lý do đó đều làm
 * hàng đợi lệch với thực tế mà không lỗi nào phát ra. Đo production 13/09/2026, kiện đang chạy ở
 * trạng thái cần care, tách theo chứng từ lấy hàng:
 *
 *   "chờ xử lý" CHƯA lấy hàng   106 kiện → 106 đợt đang mở (toàn bộ do máy mở, sai với ý chủ shop)
 *   "chờ xử lý" ĐÃ lấy hàng      48 kiện →   6 đợt          (đúng nhóm cần care, và đang bị bỏ sót)
 *   "tồn - …"   ĐÃ lấy hàng      17 kiện →  11 đợt
 *   "chờ phát lại"               29 kiện →  29 đợt
 *
 * Hàm này chạy cùng job tra cứu Viettel Post (10 phút/lần) và đưa cả bảng về đúng chỗ: 48 → 48,
 * 17 → 17, và 106 đợt kia đóng lại không tính kết quả.
 *
 *   (a) MỞ  — kiện đang trong điều kiện cần care (cùng luật `careEntryFor` với webhook và tháp) mà
 *             chưa có đợt đang mở. `opened_at` = mốc trạng thái ĐVVC, KHÔNG phải lúc chạy đối chiếu,
 *             để SLA nói thật kiện đã chờ bao lâu.
 *   (b) ĐÓNG — đợt máy mở, chưa ai động vào, mà kiện không (còn) trong điều kiện (mã 102 chưa rời
 *             kho, hoặc đã đi tiếp). `care_outcome = NULL`, `resolution = NOT_CARE_CONDITION` —
 *             không bao giờ vào tỷ lệ.
 *   (c) CHỐT — đợt còn treo PENDING trên kiện đã kết thúc (sự kiện cuối đi đường không qua vòng đời).
 *             Chỉ đợt `PENDING` — 76 ca lịch sử mang `NULL` cố ý không được suy ngược (0075).
 *
 * Idempotent: chạy hai lần liên tiếp thì lần hai không ghi gì. KHÔNG BAO GIỜ đụng đợt người đã
 * chạm vào, ngoài việc chốt kết quả theo chứng từ — thứ mà người cũng không được quyền quyết.
 */
export async function reconcileCareCoverage(db: Db, now = new Date(), scope: { shipmentIds?: string[] } = {}): Promise<CareReconcileResult> {
  const out: CareReconcileResult = { opened: 0, dismissed: 0, settled: 0, scanned: 0 };
  // Phạm vi hẹp (một nhóm kiện) cho lượt tra thủ công / kiểm thử; job định kỳ quét toàn bộ.
  const trongPhamVi = scope.shipmentIds?.length ? sql`s.id in ${scope.shipmentIds}` : sql`true`;
  const con = carrierSubstateSql(sql`s.vtp_status`, sql`s.vtp_status_name`, sql`s.stage::text`);
  const chungTuRoiKho = sql`(s.picked_up_at is not null or exists (select 1 from shipment_events e where e.shipment_id = s.id and e.normalized_stage in ${LEFT_WAREHOUSE_EVENT_STAGES}))`;

  /* (a) kiện cần care mà chưa có đợt */
  const ungVienMo = rowsOf<UngVienMo>(
    await db.execute(sql`
      select s.id, s.order_id,
             coalesce(nullif(s.vtp_order_number, ''), nullif(s.tracking_code, '')) as tracking,
             s.stage::text as stage, s.vtp_status, s.vtp_status_name, s.vtp_status_date,
             ${chungTuRoiKho} as da_roi_kho
        from shipments s
       where s.order_id is not null
         and s.is_final = false
         and s.stage::text not in ${[...CARE_TERMINAL_STAGES, "RETURNING"]}
         and ${con} in ${["WAITING_PROCESSING", "WAITING_REDELIVERY", "DELIVERY_EXCEPTION"]}
         and not exists (select 1 from shipment_care c where c.shipment_id = s.id and c.active)
         and ${trongPhamVi}
    `),
  );
  out.scanned += ungVienMo.length;
  for (const r of ungVienMo) {
    const stage = r.stage as ShipmentStage;
    const substate = legAwareSubstate({ code: r.vtp_status, text: r.vtp_status_name, stage });
    const verdict = careEntryFor(substate, Boolean(r.da_roi_kho));
    if (!verdict.enters) continue;
    const res = await moDot(db, {
      shipmentId: r.id,
      orderId: r.order_id,
      trackingNumber: r.tracking,
      substate,
      sourceTrigger: "RECONCILE",
      openedAt: r.vtp_status_date ? new Date(r.vtp_status_date) : now,
      statusName: r.vtp_status_name,
      reason: verdict.reason,
    });
    if (res.opened) out.opened += 1;
  }

  /* (b) + (c): đợt đang mở, đối chiếu với ảnh chụp kiện */
  const dangMo = await db
    .select({
      care: schema.shipmentCare,
      stage: schema.shipments.stage,
      vtpStatus: schema.shipments.vtpStatus,
      vtpStatusName: schema.shipments.vtpStatusName,
      vtpStatusDate: schema.shipments.vtpStatusDate,
      daRoiKho: sql<boolean>`(${schema.shipments.pickedUpAt} is not null or exists (select 1 from shipment_events e where e.shipment_id = ${schema.shipments.id} and e.normalized_stage in ${LEFT_WAREHOUSE_EVENT_STAGES}))`,
      roiKhoTuLuc: sql<Date | null>`least(${schema.shipments.pickedUpAt}, (select min(e.occurred_at) from shipment_events e where e.shipment_id = ${schema.shipments.id} and e.normalized_stage in ${LEFT_WAREHOUSE_EVENT_STAGES}))`,
    })
    .from(schema.shipmentCare)
    .innerJoin(schema.shipments, eq(schema.shipments.id, schema.shipmentCare.shipmentId))
    .where(and(eq(schema.shipmentCare.active, true), eq(schema.shipmentCare.careOutcome, "PENDING"), scope.shipmentIds?.length ? inArray(schema.shipments.id, scope.shipmentIds) : undefined));
  out.scanned += dangMo.length;
  for (const r of dangMo) {
    const stage = r.stage;
    const at = r.vtpStatusDate ?? now;
    const substate = legAwareSubstate({ code: r.vtpStatus, text: r.vtpStatusName, stage });
    if (CARE_TERMINAL_STAGES.includes(stage)) {
      const ketCuc = ketCucCua(stage, stage === "CANCELLED" ? Boolean(r.daRoiKho) : true);
      if (!ketCuc) continue;
      const res = await chotKetQua(db, r.care, ketCuc, { substate, occurredAt: at, statusName: r.vtpStatusName, source: "RECONCILE" });
      if (res.resolved || res.dismissed) out.settled += 1;
      continue;
    }
    if (stage === "RETURNING" || !chuaAiDongVao(r.care)) continue;
    const chungTu: LeftWarehouseEvidence = { left: Boolean(r.daRoiKho), since: r.roiKhoTuLuc ? new Date(r.roiKhoTuLuc) : null };
    if (careEntryFor(substate, chungTu.left).enters || !moTruocKhiRoiKho(r.care, chungTu)) continue;
    const res = await dongViKhongCanCare(db, r.care, { substate, reason: "đợt mở khi hàng còn trong kho (mã 102 trước mốc lấy hàng) — chưa bao giờ là điều kiện cần care", source: "RECONCILE", at: now });
    if (res.dismissed) out.dismissed += 1;
  }

  if (out.opened || out.dismissed || out.settled) console.log(`[care] đối chiếu độ phủ: mở ${out.opened} · đóng (không phải điều kiện care) ${out.dismissed} · chốt theo chứng từ ${out.settled} · quét ${out.scanned}`);
  return out;
}

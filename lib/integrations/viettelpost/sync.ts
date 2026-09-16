import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { codStatusForAmount } from "@/lib/constants/cod";
import { CAPABILITY_SCOPE_ERROR, CAPABILITY_PROBE_LIMIT } from "@/lib/constants/logistics-freshness";
import { legTypeFromReturningFlag } from "@/lib/constants/truth";
import type { CodStatus, Shipment, ShipmentStage } from "@/db/schema";
import { VTP_FINAL_STATUSES, vtpStatusMeta } from "@/lib/constants/viettelpost";
import { getViettelPostClient, type VtpTrackingRecord } from "@/lib/integrations/viettelpost/client";
import { publish } from "@/lib/realtime/bus";
import { getSyncState, runSyncJob, setSyncState, type SyncTrigger } from "@/lib/sync/runner";
import { ghiLoiKhaiTho, materializeShipmentState } from "@/lib/integrations/viettelpost/state";
import { ghiSoTrangThai, type StatusObservation } from "@/lib/integrations/viettelpost/registry";
import { carrierSubstate } from "@/lib/constants/carrier-substate";
import { nextSyncAt } from "@/lib/constants/vtp-reconcile";
import { afterShipmentStateChange } from "@/lib/care/lifecycle";
import { resolveVtpStatus } from "@/lib/integrations/viettelpost/status";
import { ghiQuanSat, type QuanSatMoi } from "@/lib/returns/reason-observe";

/**
 * `changed: false` KHÔNG có nghĩa là xử lý thành công. Có hai lý do rất khác nhau:
 *  · "duplicate" — đúng sự kiện đã áp rồi, bỏ qua là đúng;
 *  · "stale"     — sự kiện của ĐVVC cũ hơn trạng thái đang lưu, ERP cố tình không lùi trạng thái.
 * Trước đây cả hai đều được đánh dấu PROCESSED nên "485 webhook đã xử lý" che mất số webhook
 * thực sự không đổi được gì. Trả lý do ra ngoài để lớp gọi ghi đúng.
 */
export type ApplyReason = "applied" | "created" | "duplicate" | "stale";

export type ApplyResult = { shipmentId: string; changed: boolean; created: boolean; stage: ShipmentStage; reason: ApplyReason };

/** Tìm vận đơn trong ERP theo mã VTP / mã vận đơn / mã tham chiếu */
export async function findShipmentForVtp(db: Db, record: VtpTrackingRecord): Promise<Shipment | null> {
  const orderNumber = record.orderNumber;
  if (orderNumber) {
    const byNumber = await db.query.shipments.findFirst({ where: or(eq(schema.shipments.vtpOrderNumber, orderNumber), eq(schema.shipments.trackingCode, orderNumber)) });
    if (byNumber) return byNumber;
  }
  const ref = record.orderReference;
  if (ref) {
    const systemId = Number(ref.replace(/\D/g, ""));
    const conditions = [eq(schema.orders.id, ref), eq(schema.orders.customId, ref)];
    // orders.system_id là int4. Mã tham chiếu của Viettel Post có thể dài hơn (webhook thử của
    // họ gửi ORDER_REFERENCE = 123456789101112), so sánh thẳng sẽ làm Postgres báo lỗi "value out
    // of range for type integer" và cả gói tin hỏng. Chỉ so khi số nằm trong phạm vi.
    if (Number.isSafeInteger(systemId) && systemId > 0 && systemId <= 2_147_483_647) conditions.push(eq(schema.orders.systemId, systemId));
    const order = await db.query.orders.findFirst({ where: or(...conditions), with: { shipment: true } });
    if (order?.shipment) return order.shipment;
    if (order) {
      const [created] = await db
        .insert(schema.shipments)
        .values({
          orderId: order.id,
          carrier: "Viettel Post",
          vtpOrderNumber: orderNumber || null,
          trackingCode: orderNumber || null,
          codAmount: order.moneyToCollect,
          receiverName: order.shipFullName,
          receiverPhone: order.shipPhone,
          receiverAddress: order.shipFullAddress,
        })
        .returning();
      return created;
    }
  }
  return null;
}

/**
 * CHIỀU ĐI HAY CHIỀU HOÀN CHO MỘT BƯỚC HÀNH TRÌNH.
 *
 * Trước đây các bước hành trình được ghi KHÔNG kèm `leg_type`, nên một bước mã 501 thuộc CHIỀU
 * HOÀN có `normalized_stage = DELIVERED` và không có cờ chiều; `deriveShipmentState()` giữ nguyên
 * DELIVERED và vận đơn hoàn hiện thành "giao thành công". Đúng cái bẫy mà `leg_type` sinh ra để
 * chặn (F3 trong docs/erp-data-truth-audit.md).
 *
 * Quy tắc, cố ý hẹp để KHÔNG BAO GIỜ đoán:
 *  1. bước có cờ IS_RETURNING của riêng nó  → dùng cờ đó;
 *  2. bước mang MÃ TRẠNG THÁI CUỐI (501/503/504/101/107/201) → dùng cờ của bản ghi chính. Mã cuối
 *     là kết luận nghiệp vụ, và cờ của bản ghi mô tả đúng chiều mà vận đơn kết thúc;
 *  3. còn lại → null (CHƯA BIẾT). Không gán cờ của bản ghi cho các bước trung gian: một vận đơn
 *     đi rồi quay về có cả bước chiều đi lẫn chiều hoàn trong cùng một hành trình, gán bừa sẽ
 *     làm hỏng các mốc "lần đầu lấy hàng / lần đầu đi phát".
 */
function journeyLegType(record: VtpTrackingRecord, step: VtpTrackingRecord["journey"][number]): "OUTBOUND" | "RETURN" | null {
  const own = legTypeFromReturningFlag(step.isReturning);
  if (own) return own;
  if (step.status !== null && VTP_FINAL_STATUSES.has(step.status)) return legTypeFromReturningFlag(record.isReturning);
  return null;
}

/**
 * ═══════════ XẾP LỊCH HỎI LẠI CHO MỘT KIỆN ═══════════
 *
 * Gọi sau MỌI lượt nạp thành công (webhook · đối chiếu · nhập tệp). Nhịp lấy từ
 * `lib/constants/vtp-reconcile.ts` theo TRẠNG THÁI CON của ĐVVC — không theo `shipment_stage`, vì
 * `stage` gộp "chờ phát lại" với "tồn - khách nghỉ" thành một nhãn trong khi hai việc ấy có nhịp
 * khác hẳn nhau.
 *
 * Lượt thành công RESET bộ đếm hỏng: lùi dần là để chịu một sự cố phía ĐVVC, không phải để phạt
 * một kiện vĩnh viễn vì nó từng hỏng một lần.
 *
 * `vtp_next_sync_at = NULL` nghĩa là KHÔNG XẾP HÀNG NỮA (kiện đã kết thúc) — khác hẳn "hỏi ngay".
 * Bộ đối chiếu đọc cột này bằng `is not null and <= now()`, nên NULL không bao giờ lọt vào hàng đợi.
 */
async function lenLichDoiChieu(db: Db, shipmentId: string, options: { failed?: boolean; error?: string | null } = {}) {
  const [row] = await db
    .select({
      isFinal: schema.shipments.isFinal,
      vtpStatus: schema.shipments.vtpStatus,
      vtpStatusName: schema.shipments.vtpStatusName,
      stage: schema.shipments.stage,
      attempts: schema.shipments.vtpSyncAttempts,
    })
    .from(schema.shipments)
    .where(eq(schema.shipments.id, shipmentId));
  if (!row) return;
  const { substate } = carrierSubstate({ code: row.vtpStatus, text: row.vtpStatusName, stage: row.stage });
  const attempts = options.failed ? (row.attempts ?? 0) + 1 : 0;
  const next = nextSyncAt({ substate, isFinal: row.isFinal, failedAttempts: attempts, now: new Date() });
  await db
    .update(schema.shipments)
    .set({
      vtpNextSyncAt: next,
      vtpSyncAttempts: attempts,
      // Lượt thành công XOÁ câu lỗi cũ: giữ lại là để một sự cố đã qua mãi mãi hiện trên màn hình.
      vtpLastError: options.failed ? (options.error ?? "Không rõ lỗi") : null,
    })
    .where(eq(schema.shipments.id, shipmentId));
}

/**
 * Áp trạng thái Viettel Post vào vận đơn. Dùng chung cho webhook, polling và import.
 * Không tạo vận đơn mới nếu không tìm thấy, trừ khi allowCreate = true.
 */
export async function applyVtpTracking(record: VtpTrackingRecord, source: "VTP_WEBHOOK" | "VTP_POLL" | "VTP_IMPORT", options: { allowCreate?: boolean } = {}): Promise<ApplyResult | null> {
  const db = await getDb();
  let shipment = await findShipmentForVtp(db, record);
  let created = false;
  if (!shipment) {
    if (!options.allowCreate || !record.orderNumber) return null;
    const [row] = await db
      .insert(schema.shipments)
      .values({
        carrier: "Viettel Post",
        vtpOrderNumber: record.orderNumber,
        trackingCode: record.orderNumber,
        orderReference: record.orderReference || null,
        codAmount: record.moneyCollection,
        receiverName: record.receiverName,
        receiverPhone: record.receiverPhone,
        receiverAddress: record.receiverAddress,
      })
      .returning();
    shipment = row;
    created = true;
  }

  // Cùng bộ dịch với luồng nhập tệp — xem lib/integrations/viettelpost/status.ts.
  const meta = resolveVtpStatus({ code: record.status, text: record.statusName });
  const statusDate = record.statusDate ?? new Date();
  const isNewer = !shipment.vtpStatusDate || statusDate.getTime() >= shipment.vtpStatusDate.getTime();

  // Ghi sự kiện hành trình (idempotent theo shipment + source + status + thời điểm)
  const eventRows: (typeof schema.shipmentEvents.$inferInsert)[] = [];
  if (record.status !== null || record.statusName) {
    // Ghi kèm trạng thái đã chuẩn hoá: có nó thì dựng lại được trạng thái vận đơn từ lịch sử và
    // đối chiếu được ERP với ĐVVC. Thiếu nó (như trước đây) thì mọi sự kiện webhook đều vô danh.
    // legType lấy từ cờ IS_RETURNING của ĐVVC: chỉ có nó mới phân biệt được "501 phát tới khách"
    // với "501 phát thành công CHIỀU HOÀN về shop" — hai việc trái ngược nhau mà VTP gọi chung là
    // "Thành công". Không có cờ thì để UNKNOWN, không đoán.
    const legType = legTypeFromReturningFlag(record.isReturning);
    eventRows.push({ shipmentId: shipment.id, source, status: String(record.status ?? record.statusName), statusName: meta.name, location: record.location, note: record.note, occurredAt: statusDate, normalizedStage: meta.stage, legType, raw: record.raw });
  }
  for (const step of record.journey) {
    if (!step.occurredAt) continue;
    eventRows.push({
      shipmentId: shipment.id,
      source,
      status: String(step.status ?? step.statusName),
      statusName: step.statusName || vtpStatusMeta(step.status).name,
      location: step.location,
      note: step.note,
      occurredAt: step.occurredAt,
      normalizedStage: vtpStatusMeta(step.status).stage,
      legType: journeyLegType(record, step),
      raw: step.raw,
    });
  }
  if (eventRows.length) await db.insert(schema.shipmentEvents).values(eventRows).onConflictDoNothing();

  /*
    ═══ MỖI CÂU ĐVVC NÓI ĐỀU VÀO SỔ, KỂ CẢ CÂU ERP CHƯA DỊCH ĐƯỢC ═══

    `deriveShipmentState()` cố ý lọc bỏ sự kiện `UNKNOWN` — không đủ căn cứ thì không kết luận. Hệ
    quả trước bản này: Viettel Post gửi một trạng thái mới, ERP giữ nguyên câu cũ trên màn hình, và
    KHÔNG CÓ MỘT DẤU HIỆU NÀO. Nay câu ấy hiện ở hai chỗ: sổ đăng ký (đếm được, xếp hàng để bổ sung
    vào bảng mã) và lời khai thô trên chính vận đơn (người trực nhìn thấy ngay).
  */
  const quanSatTrangThai: StatusObservation[] = [];
  if (record.status !== null || record.statusName) {
    quanSatTrangThai.push({ code: record.status, name: record.statusName || meta.name, source, shipmentId: shipment.id, raw: record.raw, resolved: meta });
  }
  for (const step of record.journey) {
    if (step.status === null && !step.statusName) continue;
    quanSatTrangThai.push({ code: step.status, name: step.statusName, source, shipmentId: shipment.id, raw: step.raw });
  }
  await ghiSoTrangThai(db, quanSatTrangThai).catch(() => []);
  // Lời khai thô đi theo MỐC của ĐVVC, không theo lượt ghi — gói tin đến muộn không kéo lùi nó.
  await ghiLoiKhaiTho(db, shipment.id, {
    code: record.status,
    name: record.statusName || meta.name,
    occurredAt: statusDate,
    mapped: meta.basis === "code" || meta.basis === "text",
  }).catch(() => undefined);

  /*
    ═══ GÓI TIN MANG LÝ DO ⇒ GHI NGAY MỘT QUAN SÁT ═══

    Trước bản này, chữ lý do của Viettel Post chỉ tồn tại lẫn trong hàng chục nghìn dòng hành
    trình, và mỗi lượt mở báo cáo lại phải quét lại từ đầu để tìm. Nay mỗi câu NÓI VỀ LÝ DO được
    tách ra thành một dòng có nguồn và có mốc, ngay lúc nó tới.
   
    Bộ lọc nằm trong `ghiQuanSat`: câu chỉ nói BƯỚC ĐI ("đang chuyển hoàn") không sinh quan sát
    nào. Mã lý do có cấu trúc đi kèm để phép xếp loại dùng mã thay vì đoán chữ.

    KHÔNG ĐƯỢC LÀM HỎNG LƯỢT ĐỒNG BỘ. Viettel Post đòi HTTP 200 trong dưới một giây và thử lại tối
    đa 5 lần; một quan sát không ghi được là mất một dòng ghi chú, không phải mất một vận đơn — nên
    lỗi ở đây bị nuốt có chủ đích, đúng như mọi nhánh phụ khác của đường webhook.
  */
  if (eventRows.length) {
    const quanSat: QuanSatMoi[] = eventRows.map((r) => ({
      shipmentId: shipment.id,
      orderId: shipment.orderId,
      source: "CARRIER_TEXT" as const,
      rawText: [r.statusName ?? "", r.note ?? ""].filter(Boolean).join(" — "),
      occurredAt: r.occurredAt,
      sourceRef: `vtp:${source}`,
      vtpCode: record.reasonCode ?? null,
    }));
    await ghiQuanSat(db, quanSat).catch(() => 0);
  }

  if (!isNewer && !created) {
    await db.update(schema.shipments).set({ lastVtpSyncAt: new Date() }).where(eq(schema.shipments.id, shipment.id));
    // Cùng mốc thời gian và cùng trạng thái ⇒ đúng là gói tin lặp. Khác đi ⇒ sự kiện đến muộn,
    // ERP giữ trạng thái mới hơn nhưng phải nói ra để không ai tưởng webhook đã được áp dụng.
    const duplicate = shipment.vtpStatusDate?.getTime() === statusDate.getTime() && shipment.stage === meta.stage;
    // Sự kiện đã được ghi vào lịch sử ở trên; dựng lại trạng thái để ảnh chụp luôn khớp lịch sử,
    // kể cả khi vận đơn trước đó bị một luồng khác ghi sai.
    const fixed = await materializeShipmentState(db, shipment.id);
    await lenLichDoiChieu(db, shipment.id).catch(() => undefined);
    if (fixed.changed) {
      // Trạng thái đã đổi thì vòng đời care phải biết — trước đây nhánh này dừng ở đây và ca treo mãi.
      await afterShipmentStateChange(db, shipment.id, { source: "VTP_LATE_EVENT" }).catch(() => undefined);
      return { shipmentId: shipment.id, changed: true, created, stage: fixed.after as typeof shipment.stage, reason: "applied" };
    }
    return { shipmentId: shipment.id, changed: false, created, stage: shipment.stage, reason: duplicate ? "duplicate" : "stale" };
  }

  const codAmount = record.moneyCollection > 0 ? record.moneyCollection : shipment.codAmount;
  let codStatus: CodStatus = shipment.codStatus;
  // ĐVVC báo đã giao ⇒ tiền đang ở ĐVVC (COLLECTED). Đây là lời khai của ĐVVC, chưa phải chứng từ.
  if (meta.stage === "DELIVERED" && codAmount > 0 && ["PENDING", "NOT_APPLICABLE"].includes(codStatus)) codStatus = "COLLECTED";
  // Hoàn / huỷ KHÔNG được hạ về "không thu hộ": vận đơn vẫn có thu hộ, chỉ là không thu được.
  // Trước đây hạ như vậy nên ERP hiện "Không thu hộ" cho đơn Viettel Post vẫn ghi COD 849.000đ.
  if ((meta.stage === "RETURNED" || meta.stage === "CANCELLED") && codStatus === "COLLECTED") codStatus = "PENDING";
  // "Không thu hộ" chỉ đúng khi vận đơn không có tiền thu hộ.
  codStatus = codStatusForAmount(codAmount, codStatus);
  const existingRaw = shipment.raw && typeof shipment.raw === "object" ? (shipment.raw as Record<string, unknown>) : {};

  await db
    .update(schema.shipments)
    .set({
      carrier: shipment.carrier || "Viettel Post",
      vtpOrderNumber: shipment.vtpOrderNumber ?? (record.orderNumber || null),
      trackingCode: shipment.trackingCode ?? (record.orderNumber || null),
      orderReference: record.orderReference || shipment.orderReference,
      // CỐ Ý KHÔNG ghi stage / vtp_status* / các mốc thời gian ở đây.
      // Trạng thái vận đơn là HÀM CỦA LỊCH SỬ và chỉ có materializeShipmentState() được ghi nó
      // (xem SHIPMENT_STAGE_WRITERS trong lib/constants/truth.ts). Hai chỗ cùng ghi thì luồng nào
      // chạy sau sẽ thắng, kể cả khi nó mang sự kiện cũ hơn — đúng lỗi đã đo được trên production.
      vtpReasonCode: record.reasonCode ?? shipment.vtpReasonCode,
      service: record.service || shipment.service,
      weight: record.productWeight || shipment.weight,
      expectedDelivery: record.expectedDelivery || shipment.expectedDelivery,
      codAmount,
      // KHÔNG suy tiền từ việc giao hàng. Trước đây "đã giao" tự ghi tiền thực thu = COD khai báo,
      // tức bịa ra chứng từ: đơn khách trả lại tiền ship hay đơn sửa doanh thu vẫn được tính đủ tiền.
      // Tiền thực thu chỉ đến từ bảng kê đối soát (sổ cod_statement_lines).
      codCollected: shipment.codCollected,
      codFee: record.moneyFeeCod || shipment.codFee,
      shippingFee: record.moneyTotal || record.moneyTotalFee || shipment.shippingFee,
      codStatus,
      receiverName: shipment.receiverName || record.receiverName,
      receiverPhone: shipment.receiverPhone || record.receiverPhone,
      receiverAddress: shipment.receiverAddress || record.receiverAddress,
      lastVtpSyncAt: new Date(),
      raw: { ...existingRaw, vtp: record.raw },
      updatedAt: new Date(),
    })
    .where(eq(schema.shipments.id, shipment.id));

  // Ảnh chụp cuối cùng luôn được dựng từ lịch sử: một chỗ duy nhất quyết định trạng thái.
  const finalState = await materializeShipmentState(db, shipment.id);
  const stageNow = (finalState.after as ShipmentStage) ?? shipment.stage;
  // Nhịp hỏi lại đi theo trạng thái MỚI: kiện vừa chuyển sang "đang đi giao" phải được hỏi dày hơn
  // ngay từ lượt này, không phải đợi lượt sau mới nhận ra.
  await lenLichDoiChieu(db, shipment.id).catch(() => undefined);
  /*
    ═══ ĐVVC MỞ CA, VÀ ĐVVC ĐÓNG CA — MỘT CỬA ═══

    Sự cố ("chờ xử lý" đã rời kho / "chờ phát lại" / "tồn") mở một đợt chăm sóc; kết cục cuối (đã
    giao / hoàn / huỷ) chốt kết quả của đợt đó. Người ở GIỮA — không thao tác nào của nhân viên mở
    hay chốt được một đợt, vì bấm nút không làm gói hàng di chuyển.

    `afterShipmentStateChange` là cửa DUY NHẤT: xác nhận lệnh đã gửi ĐVVC → vòng đời care → chốt
    đơn đổi, đều trên chặng LEG-AWARE. Cờ IS_RETURNING của chính gói tin được truyền xuống vì nó
    chính xác hơn ảnh chụp: 501 chiều hoàn là hàng VỀ SHOP, không phải giao thành công.

    `.catch` cố ý: vòng đời care KHÔNG được phép làm hỏng đường ghi chứng từ ĐVVC. Mất một lần mở
    ca thì đối chiếu định kỳ mở lại được; mất một sự kiện hành trình thì mất vĩnh viễn.
  */
  await afterShipmentStateChange(db, shipment.id, {
    legType: legTypeFromReturningFlag(record.isReturning),
    vtpStatus: record.status,
    vtpStatusName: record.statusName,
    occurredAt: statusDate,
    source,
  }).catch(() => undefined);
  // "Đã áp dụng" chỉ đúng khi trạng thái thực sự tiến triển. Gói tin lặp đi qua nhánh này (cùng
  // mốc thời gian nên vẫn được coi là không cũ hơn) nhưng không được đếm như một lần cập nhật.
  // So với ảnh chụp TRƯỚC khi ghi, vì đến lúc này bản ghi đã bị cập nhật rồi.
  const wasDuplicate = !created && shipment.vtpStatusDate?.getTime() === statusDate.getTime() && shipment.stage === meta.stage;
  const advanced = !wasDuplicate;
  if (advanced) publish({ type: "shipment", shipmentId: shipment.id, status: stageNow });
  return {
    shipmentId: shipment.id,
    changed: advanced,
    created,
    stage: stageNow,
    reason: created ? "created" : advanced ? "applied" : "duplicate",
  };
}

/**
 * PHẠM VI TÀI KHOẢN API VIETTEL POST.
 *
 * Vận đơn do Pancake tạo thuộc tài khoản Viettel Post của Pancake, không thuộc tài khoản API
 * partner của shop. Token của shop vẫn hợp lệ (đăng nhập được, liệt kê được kho) nhưng
 * `getOrderDetail` trả "không tồn tại" cho mọi mã, còn `listOrders` trả 0 vận đơn.
 *
 * Trước đây mỗi lần chạy vẫn ghi SUCCESS với "cập nhật 0", nên đối chiếu chết âm thầm suốt nhiều
 * ngày mà không ai biết, đồng thời đốt hàng trăm lệnh gọi API mỗi lần. Nay:
 *  · đếm riêng số vận đơn API KHÔNG THẤY, ghi thẳng vào tóm tắt;
 *  · lặp lại nhiều lần → chỉ dò một nhúm nhỏ cho tới khi API thấy lại, tự khôi phục ngay sau đó.
 * Không tự ý sửa dữ liệu: webhook và file bảng kê vẫn là nguồn thật.
 *
 * KHOẺ THEO NĂNG LỰC (chủ shop chốt 11/09/2026): vận đơn đã kết luận `WEBHOOK_ONLY` không được làm
 * lần chạy thành PARTIAL chỉ vì tài khoản API hiện tại không đọc được vận đơn Pancake tạo — với
 * chúng, webhook là nguồn đúng và đủ. Chỉ `API_TRACKABLE` mới phải đối chiếu được qua API: một vận
 * đơn từng tra được mà nay API "không thấy" mới là cảnh báo thật. `UNKNOWN_CAPABILITY` được dò hữu
 * hạn (`CAPABILITY_PROBE_LIMIT`) rồi kết luận — dò hụt là PHÂN LOẠI, không phải lỗi.
 */
const API_SCOPE_KEY = "viettelpost:api-scope";
/** Số lượt liên tiếp API không thấy vận đơn nào trước khi chuyển sang chế độ chỉ dò. */
const SCOPE_PROBE_AFTER = 3;
/** Số vận đơn dò mỗi lượt khi đang ở chế độ chỉ dò — đủ để phát hiện API sống lại. */
const SCOPE_PROBE_SIZE = 10;

type ApiScopeState = { missingStreak: number; lastFoundAt: string | null; lastCheckedAt: string | null };

/** Poll trạng thái các vận đơn Viettel Post chưa kết thúc */
export async function syncViettelPostShipments(options: { trigger?: SyncTrigger; actor?: string; limit?: number; includeFinal?: boolean; shipmentIds?: string[] } = {}) {
  return runSyncJob({ source: "VIETTELPOST", job: options.shipmentIds?.length ? "tracking_selected" : "tracking_poll", trigger: options.trigger, actor: options.actor }, async (ctx) => {
    const db = await getDb();
    const client = getViettelPostClient();
    // Tra cứu chọn tay là yêu cầu rõ ràng của người dùng — không bị chế độ chỉ dò chặn.
    const selected = Boolean(options.shipmentIds?.length);
    const scope = (await getSyncState<ApiScopeState>(API_SCOPE_KEY)) ?? { missingStreak: 0, lastFoundAt: null, lastCheckedAt: null };
    const probing = !selected && scope.missingStreak >= SCOPE_PROBE_AFTER;
    const where = options.shipmentIds?.length
      ? inArray(schema.shipments.id, options.shipmentIds)
      : and(
          or(sql`${schema.shipments.carrier} ilike '%viettel%'`, isNotNull(schema.shipments.vtpOrderNumber)),
          or(isNotNull(schema.shipments.vtpOrderNumber), isNotNull(schema.shipments.trackingCode)),
          options.includeFinal ? undefined : eq(schema.shipments.isFinal, false),
          /*
            ═══ THÔI HỎI NHỮNG VẬN ĐƠN ĐÃ CHỨNG MINH LÀ KHÔNG HỎI ĐƯỢC ═══

            Đo được 11/09/2026: nguồn `VTP_POLL` sinh ra **0 sự kiện** từ trước tới nay, còn
            `sync_runs` ghi "tài khoản API không thấy vận đơn nào — lượt thứ 548 liên tiếp". Vận đơn
            do Pancake tạo thuộc một tài khoản Viettel Post khác.

            Gọi mãi một API không bao giờ trả về gì không làm sai số liệu, nhưng tốn request, tốn
            thời gian job, và làm log đầy tiếng ồn che mất lỗi thật.

            KHÔNG bỏ hẳn khả năng đối chiếu: chỉ loại vận đơn đã đủ bằng chứng (`WEBHOOK_ONLY`).
            Vận đơn `UNKNOWN_CAPABILITY` vẫn được thử, có giới hạn; vận đơn `API_TRACKABLE` vẫn đối
            chiếu như cũ. Ngày shop trỏ ERP về đúng tài khoản, vận đơn mới sẽ tự vào lại vòng này.
          */
          sql`${schema.shipments.trackingCapability} <> 'WEBHOOK_ONLY'`,
          /*
            ═══ CHỈ HỎI KIỆN ĐÃ TỚI HẠN HỎI LẠI ═══

            `NULL` = CHƯA XẾP LỊCH BAO GIỜ (vận đơn có trước bản này, hoặc vừa được tạo) ⇒ hỏi ngay
            để nó có lịch. Kiện đã kết thúc nhận `NULL` nhưng không lọt vào đây vì mệnh đề
            `is_final = false` ở trên đã loại chúng; khi người dùng khai `includeFinal` thì đó là
            yêu cầu tường minh và chúng được hỏi lại một lượt.
          */
          options.includeFinal ? undefined : or(isNull(schema.shipments.vtpNextSyncAt), sql`${schema.shipments.vtpNextSyncAt} <= now()`),
        );
    const shipments = await db
      .select({
        id: schema.shipments.id,
        vtpOrderNumber: schema.shipments.vtpOrderNumber,
        trackingCode: schema.shipments.trackingCode,
        trackingCapability: schema.shipments.trackingCapability,
        capabilityProbes: schema.shipments.capabilityProbes,
      })
      .from(schema.shipments)
      .where(where)
      /*
        XẾP THEO HẠN HỎI LẠI, KHÔNG THEO "LÂU CHƯA HỎI".

        Trước bản này câu này là `last_vtp_sync_at asc nulls first` — nghĩa là một kiện ĐANG ĐI GIAO
        (kết quả phải có trong ngày) đứng ngang hàng với một kiện CHỜ LẤY HÀNG (chậm ba ngày vẫn
        bình thường), và với trần 300 kiện mỗi lượt thì kiện nóng phải chờ hết lượt của kiện nguội.
        Hạn hỏi lại đã mang sẵn độ nóng trong nó (xem lib/constants/vtp-reconcile.ts).
      */
      .orderBy(sql`${schema.shipments.vtpNextSyncAt} asc nulls first`, sql`${schema.shipments.lastVtpSyncAt} asc nulls first`, asc(schema.shipments.createdAt))
      .limit(probing ? SCOPE_PROBE_SIZE : options.limit ?? 300);
    ctx.summary.detail = `Kiểm tra ${shipments.length} vận đơn`;
    let notFound = 0;
    /** Vận đơn ĐÃ TỪNG tra được qua API mà nay API không thấy — lỗ hổng đối chiếu thật. */
    let notFoundTrackable = 0;
    /** Vận đơn vừa được kết luận WEBHOOK_ONLY trong lượt này. */
    let concluded = 0;
    for (const shipment of shipments) {
      const orderNumber = shipment.vtpOrderNumber ?? shipment.trackingCode;
      if (!orderNumber) {
        ctx.summary.skipped += 1;
        continue;
      }
      try {
        const record = await client.getOrderDetail(orderNumber);
        if (!record) {
          /*
            API trả "không thấy" là một câu trả lời DỨT KHOÁT, không phải lỗi tạm thời: vận đơn hoặc
            thuộc tài khoản này hoặc không. Đếm riêng (không gộp vào "bỏ qua" để khỏi che sự thật),
            và sau `CAPABILITY_PROBE_LIMIT` lần thì kết luận — thôi hỏi nữa.
          */
          notFound += 1;
          ctx.summary.skipped += 1;
          if (shipment.trackingCapability === "API_TRACKABLE") notFoundTrackable += 1;
          const soLan = (shipment.capabilityProbes ?? 0) + 1;
          const ketLuan = shipment.trackingCapability !== "API_TRACKABLE" && soLan >= CAPABILITY_PROBE_LIMIT;
          if (ketLuan) concluded += 1;
          await db
            .update(schema.shipments)
            .set({
              lastVtpSyncAt: new Date(),
              capabilityProbes: soLan,
              ...(ketLuan ? { trackingCapability: "WEBHOOK_ONLY" as const } : {}),
            })
            .where(eq(schema.shipments.id, shipment.id));
          // API trả "không thấy" là một lượt hỏi HỤT: lùi nhịp để khỏi hỏi lại ngay lượt sau. Câu
          // lỗi nói đúng bản chất — đây là PHẠM VI TÀI KHOẢN, không phải sự cố của kiện hàng.
          await lenLichDoiChieu(db, shipment.id, {
            failed: true,
            error: CAPABILITY_SCOPE_ERROR,
          }).catch(() => undefined);
          continue;
        }
        // Tra được ⇒ bằng chứng dứt khoát theo hướng ngược lại: vận đơn này đối chiếu API được.
        if (shipment.trackingCapability !== "API_TRACKABLE") {
          await db
            .update(schema.shipments)
            .set({ trackingCapability: "API_TRACKABLE", capabilityProbes: 0 })
            .where(eq(schema.shipments.id, shipment.id));
        }
        const result = await applyVtpTracking({ ...record, orderNumber }, "VTP_POLL");
        if (result?.changed) ctx.summary.updated += 1;
        else ctx.summary.skipped += 1;
      } catch (error) {
        ctx.summary.failed += 1;
        const cauLoi = error instanceof Error ? error.message : String(error);
        ctx.log(`${orderNumber}: ${cauLoi}`);
        await db.update(schema.shipments).set({ lastVtpSyncAt: new Date() }).where(eq(schema.shipments.id, shipment.id)).catch(() => undefined);
        // Lỗi của LƯỢT HỎI (mạng, 5xx) không phải lỗi của kiện hàng — lùi nhịp, giữ nguyên câu lỗi
        // để trang sức khoẻ nói được vì sao chứ không chỉ nói "hỏng".
        await lenLichDoiChieu(db, shipment.id, { failed: true, error: cauLoi }).catch(() => undefined);
      }
      await ctx.progress();
    }
    const found = shipments.length - notFound - ctx.summary.failed;
    if (!selected) {
      const allMissing = shipments.length > 0 && notFound === shipments.length;
      await setSyncState(API_SCOPE_KEY, {
        missingStreak: allMissing ? scope.missingStreak + 1 : 0,
        lastFoundAt: found > 0 ? new Date().toISOString() : scope.lastFoundAt,
        lastCheckedAt: new Date().toISOString(),
      } satisfies ApiScopeState);
    }
    // CẢNH BÁO (⇒ PARTIAL) chỉ khi đối chiếu THẬT bị hụt: vận đơn tra được qua API mà nay không thấy.
    // Tài khoản API không đọc được vận đơn Pancake tạo là NĂNG LỰC của tài khoản, không phải lỗi của
    // lần chạy — đã được phân loại và ghi ở chi tiết, không ghi ở cảnh báo.
    if (notFoundTrackable > 0) {
      ctx.summary.warning =
        `${notFoundTrackable} vận đơn từng tra được qua API nay API Viettel Post không thấy — đối chiếu qua API cho chúng đang hụt. ` +
        "Kiểm tra tài khoản API partner (đổi mã khách hàng / hết hạn) trước khi kết luận gì về vận đơn.";
    }
    const [ngoaiPhamVi] = await db
      .select({ n: sql<number>`count(*)` })
      .from(schema.shipments)
      .where(and(eq(schema.shipments.isFinal, false), eq(schema.shipments.trackingCapability, "WEBHOOK_ONLY")));
    const webhookOnlyOpen = Number(ngoaiPhamVi?.n ?? 0);
    ctx.summary.detail =
      `Đã kiểm tra ${shipments.length} vận đơn · cập nhật ${ctx.summary.updated} · API không thấy ${notFound}` +
      (concluded ? ` (${concluded} vừa kết luận chỉ nhận webhook)` : "") +
      ` · lỗi ${ctx.summary.failed}` +
      (webhookOnlyOpen ? ` · ${webhookOnlyOpen} vận đơn đang chạy chỉ nhận webhook — ngoài phạm vi tài khoản API, không cần đối chiếu API` : "") +
      (probing ? ` · đang chỉ dò ${SCOPE_PROBE_SIZE} vận đơn vì ${scope.missingStreak} lượt liên tiếp API không thấy gì` : "");
    return shipments.length;
  });
}

/** Nhập danh sách vận đơn từ tài khoản Viettel Post (kể cả đơn không tạo qua Pancake) */
export async function importViettelPostOrders(options: { trigger?: SyncTrigger; actor?: string; days?: number } = {}) {
  return runSyncJob({ source: "VIETTELPOST", job: "orders_import", trigger: options.trigger, actor: options.actor }, async (ctx) => {
    const client = getViettelPostClient();
    const days = options.days ?? 30;
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    let page = 1;
    let fetched = 0;
    let total = 0;
    for (;;) {
      const result = await client.listOrders({ from, to, page });
      total = result.total;
      if (!result.orders.length) break;
      for (const record of result.orders) {
        if (!record.orderNumber) {
          ctx.summary.skipped += 1;
          continue;
        }
        try {
          const applied = await applyVtpTracking(record, "VTP_IMPORT", { allowCreate: true });
          if (applied?.created) ctx.summary.imported += 1;
          else if (applied?.changed) ctx.summary.updated += 1;
          else ctx.summary.skipped += 1;
        } catch (error) {
          ctx.summary.failed += 1;
          ctx.log(`${record.orderNumber}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      fetched += result.orders.length;
      ctx.summary.detail = `Trang ${page} · ${fetched}/${total || "?"} vận đơn`;
      await ctx.progress();
      if (fetched >= total || page >= 200) break;
      page += 1;
    }
    ctx.summary.detail = `Nhập ${fetched} vận đơn ${days} ngày gần nhất (mới ${ctx.summary.imported}, cập nhật ${ctx.summary.updated})`;
    return fetched;
  });
}

/** Các vận đơn Viettel Post chưa gắn với đơn Pancake */
export async function orphanVtpShipments(db: Db) {
  return db.query.shipments.findMany({ where: isNull(schema.shipments.orderId), orderBy: (s, { desc }) => [desc(s.createdAt)], limit: 200 });
}

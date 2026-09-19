import { asc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { CARE_ACTION_LABEL, type CareActionKind } from "@/lib/constants/delivery-tower";
import { CARE_STATUS_LABEL, CARRIER_ACTION_LABEL, CARRIER_REQUEST_LABEL, type CareStatus, type CarrierActionKey, type CarrierRequestStatus } from "@/lib/constants/care";
import { RESOLUTION_LABEL, careDecisionOf } from "@/lib/constants/care-resolution";
import { CARRIER_EVENT_SOURCES } from "@/lib/constants/truth";
import { SHIPMENT_STAGE_LABEL } from "@/lib/constants/viettelpost";
import { EVENT_LANE, type ActorKind, type TimelineEventType, type TimelineLane } from "@/lib/constants/shipment-timeline";
import { eventStatusCode, resolveVtpStatus } from "@/lib/integrations/viettelpost/status";
import { careSlaHours } from "@/lib/care/sla";
import { outcomeOfShipment } from "@/lib/queries/shipments";
import { OUTCOME_LABEL, type OrderOutcome } from "@/lib/constants/returns";
import type { ShipmentStage } from "@/db/schema";

/**
 * ═══════════ NHẬT KÝ ĐẦY ĐỦ CỦA MỘT VẬN ĐƠN ═══════════
 *
 * Trả lời đúng bảy câu mà trước đây phải mở sáu bảng mới ghép lại được:
 *
 *   Viettel Post đổi trạng thái lúc nào · ERP biết lúc nào · ai xử lý · xử lý gì · lúc nào ·
 *   sau khi xử lý thì chứng từ ĐVVC có đổi không · cuối cùng ERP kết luận đơn này ra sao.
 *
 * ─── HAI MỐC, KHÔNG PHẢI MỘT ───
 *
 * Mỗi mốc mang CẢ `at` (lúc việc XẢY RA — với ĐVVC là `occurred_at`) lẫn `receivedAt` (lúc ERP
 * BIẾT). Webhook rơi rồi đối chiếu vá lại thì hai con số cách nhau vài phút, và khoảng cách đó
 * chính là thứ cần nhìn thấy. Nén thành một ô là xoá mất bằng chứng về độ trễ của chính ERP.
 *
 * ─── CHỈ ĐỌC, KHÔNG KẾT LUẬN ───
 *
 * Mô-đun này KHÔNG ghi gì và KHÔNG tính lại kết quả đơn. Dòng `KPI_OUTCOME` đọc `ORDER_OUTCOME`
 * qua `outcomeOfShipment()` — nguồn duy nhất — chứ không dựng lại luật ở đây.
 */

export type ShipmentTimelineEntry = {
  id: string;
  /** Lúc việc XẢY RA. Với chứng từ ĐVVC đây là mốc của ĐVVC, không phải lúc ERP nhận. */
  at: Date;
  /** Lúc ERP BIẾT. `null` khi hai mốc là một (việc do chính ERP làm). */
  receivedAt: Date | null;
  eventType: TimelineEventType;
  lane: TimelineLane;
  title: string;
  detail: string;
  /** Nguồn dữ liệu (`VTP_WEBHOOK`…) — rỗng khi không áp dụng. */
  source: string;
  actorKind: ActorKind;
  /** Tên hiển thị của người/máy. ẢNH CHỤP do MÁY CHỦ đọc, không nhận từ client (luật 34). */
  actorName: string;
  actorId: string | null;
  /** TRƯỚC → SAU của thứ mốc này thay đổi. `null` khi mốc không đổi giá trị nào. */
  before: string | null;
  after: string | null;
  note: string;
};

/** Thời gian phản ứng, tính TỪ NHẬT KÝ chứ không lưu sẵn — công thức đổi thì số đổi theo. */
export type CareDurations = {
  caseOpenedAt: Date | null;
  firstAssignedAt: Date | null;
  firstActionAt: Date | null;
  firstCustomerContactAt: Date | null;
  firstCarrierContactAt: Date | null;
  lastActionAt: Date | null;
  resolvedAt: Date | null;
  /** Phút. `null` = CHƯA XẢY RA, không phải 0 phút. */
  minutesToAssign: number | null;
  minutesToFirstAction: number | null;
  minutesToFirstContact: number | null;
  minutesToResolution: number | null;
  /** Hạn phản hồi đầu đã vỡ chưa — tính lúc đọc, không ghi vào CSDL (luật 26). */
  firstResponseBreached: boolean;
  slaFirstResponseHours: number;
};

export type ShipmentTimeline = {
  entries: ShipmentTimelineEntry[];
  durations: CareDurations;
  counts: { carrier: number; human: number; system: number; derived: number; calls: number; messages: number; carrierContacts: number };
};

const CARRIER_SOURCE_SET = new Set<string>(CARRIER_EVENT_SOURCES);

/** Phút giữa hai mốc; `null` khi thiếu một trong hai — CHƯA BIẾT không được in thành 0. */
export function minutesBetween(from: Date | null, to: Date | null): number | null {
  if (!from || !to) return null;
  return Math.round((to.getTime() - from.getTime()) / 60_000);
}

function stageLabel(stage: string | null | undefined): string | null {
  if (!stage) return null;
  return SHIPMENT_STAGE_LABEL[stage as ShipmentStage] ?? stage;
}

/** Loại mốc ĐVVC theo nguồn: webhook là chứng từ, đối chiếu/nhập tệp là việc của máy. */
function carrierEventType(source: string, mapped: boolean): TimelineEventType {
  if (!mapped) return "VTP_STATUS_UNMAPPED";
  if (source === "VTP_POLL") return "RECONCILIATION";
  if (source === "VTP_IMPORT") return "MANUAL_IMPORT";
  if (source === "VTP_UI_MANUAL_VERIFICATION" || source === "MANUAL") return "MANUAL_VERIFICATION";
  if (!CARRIER_SOURCE_SET.has(source)) return "PANCAKE_MIRROR";
  return "VTP_STATUS_CHANGED";
}

const CARE_EVENT_TYPE: Record<string, TimelineEventType> = {
  STATUS: "CARE_STATUS_CHANGED",
  ASSIGN: "ASSIGNED",
  NOTE: "NOTE_ADDED",
  FOLLOW_UP: "CARE_STATUS_CHANGED",
  RESOLVE: "CASE_RESOLVED",
  REOPEN: "CASE_REOPENED",
  CANCEL: "CARE_STATUS_CHANGED",
  CARRIER_REQUEST: "VTP_COMMAND",
  CARRIER_RESULT: "VTP_COMMAND",
  CARRIER_MANUAL: "VTP_COMMAND",
};

/** Hành động chăm sóc có TIẾP XÚC KHÁCH — dùng để đo "lần đầu chạm tới khách". */
const CUSTOMER_CONTACT: CareActionKind[] = ["CALLED_REACHED", "CALLED_NO_ANSWER", "MESSAGED", "RESCHEDULED", "CUSTOMER_REFUSED"];
const CALL_KINDS: CareActionKind[] = ["CALLED_REACHED", "CALLED_NO_ANSWER"];

export async function getShipmentTimeline(shipmentId: string, options: { limit?: number } = {}): Promise<ShipmentTimeline> {
  const db = await getDb();
  const limit = options.limit ?? 400;

  const [events, caseEvents, actions, decisions, careDecisionRows, commands, cares, sla] = await Promise.all([
    db
      .select({
        id: schema.shipmentEvents.id,
        source: schema.shipmentEvents.source,
        status: schema.shipmentEvents.status,
        statusName: schema.shipmentEvents.statusName,
        location: schema.shipmentEvents.location,
        note: schema.shipmentEvents.note,
        legType: schema.shipmentEvents.legType,
        normalizedStage: schema.shipmentEvents.normalizedStage,
        occurredAt: schema.shipmentEvents.occurredAt,
        createdAt: schema.shipmentEvents.createdAt,
        sourceReference: schema.shipmentEvents.sourceReference,
      })
      .from(schema.shipmentEvents)
      .where(eq(schema.shipmentEvents.shipmentId, shipmentId))
      .orderBy(asc(schema.shipmentEvents.occurredAt))
      .limit(limit),
    db
      .select({
        id: schema.careCaseEvents.id,
        action: schema.careCaseEvents.action,
        source: schema.careCaseEvents.source,
        actorId: schema.careCaseEvents.actorId,
        actorEmail: schema.careCaseEvents.actorEmail,
        note: schema.careCaseEvents.note,
        previousStatus: schema.careCaseEvents.previousStatus,
        nextStatus: schema.careCaseEvents.nextStatus,
        previousOwner: schema.careCaseEvents.previousOwner,
        nextOwner: schema.careCaseEvents.nextOwner,
        previousOwnerId: schema.careCaseEvents.previousOwnerId,
        nextOwnerId: schema.careCaseEvents.nextOwnerId,
        createdAt: schema.careCaseEvents.createdAt,
      })
      .from(schema.careCaseEvents)
      .where(eq(schema.careCaseEvents.shipmentId, shipmentId))
      .orderBy(asc(schema.careCaseEvents.createdAt))
      .limit(limit),
    db
      .select({
        id: schema.careActions.id,
        kind: schema.careActions.kind,
        note: schema.careActions.note,
        actorId: schema.careActions.actorId,
        actorEmail: schema.careActions.actorEmail,
        stageAtAction: schema.careActions.stageAtAction,
        createdAt: schema.careActions.createdAt,
      })
      .from(schema.careActions)
      .where(eq(schema.careActions.shipmentId, shipmentId))
      .orderBy(asc(schema.careActions.createdAt))
      .limit(limit),
    db
      .select({
        id: schema.careBusinessActions.id,
        actionType: schema.careBusinessActions.actionType,
        reasonCode: schema.careBusinessActions.reasonCode,
        reasonNote: schema.careBusinessActions.reasonNote,
        actorId: schema.careBusinessActions.actorUserId,
        actorEmail: schema.careBusinessActions.actorEmail,
        previousCareStatus: schema.careBusinessActions.previousCareStatus,
        nextCareStatus: schema.careBusinessActions.nextCareStatus,
        carrierResult: schema.careBusinessActions.carrierResult,
        requestedAt: schema.careBusinessActions.requestedAt,
      })
      .from(schema.careBusinessActions)
      .where(eq(schema.careBusinessActions.shipmentId, shipmentId))
      .orderBy(asc(schema.careBusinessActions.requestedAt))
      .limit(limit),
    /*
      KẾT QUẢ CARE (`care_decisions`) — LỜI KHAI CỦA NGƯỜI, đọc riêng khỏi `care_business_actions`.

      Hai sổ, hai nghĩa: sổ trên ghi "đội đã quyết gì" và ghi được cả khi ĐVVC không nhận lệnh; sổ
      dưới ghi "một lệnh đã đi (hay chưa đi) tới Viettel Post". Nhật ký vận đơn in CẢ HAI, cùng
      làn CARE_DECISION, vì với người đọc thì cả hai đều là "shop đã quyết" — nhưng chúng không
      bao giờ bị gộp thành một dòng.
    */
    db
      .select({
        id: schema.careDecisions.id,
        decision: schema.careDecisions.decision,
        reasonCode: schema.careDecisions.reasonCode,
        note: schema.careDecisions.note,
        actorId: schema.careDecisions.actorUserId,
        actorEmail: schema.careDecisions.actorEmail,
        previousCareStatus: schema.careDecisions.previousCareStatus,
        nextCareStatus: schema.careDecisions.nextCareStatus,
        carrierSubstateAtDecision: schema.careDecisions.carrierSubstateAtDecision,
        decidedAt: schema.careDecisions.decidedAt,
      })
      .from(schema.careDecisions)
      .where(eq(schema.careDecisions.shipmentId, shipmentId))
      .orderBy(asc(schema.careDecisions.decidedAt))
      .limit(limit),
    db
      .select({
        id: schema.carrierActionRequests.id,
        actionKey: schema.carrierActionRequests.actionKey,
        status: schema.carrierActionRequests.status,
        error: schema.carrierActionRequests.error,
        note: schema.carrierActionRequests.note,
        actorId: schema.carrierActionRequests.actorId,
        actorEmail: schema.carrierActionRequests.actorEmail,
        createdAt: schema.carrierActionRequests.createdAt,
        confirmedAt: schema.carrierActionRequests.confirmedAt,
      })
      .from(schema.carrierActionRequests)
      .where(eq(schema.carrierActionRequests.shipmentId, shipmentId))
      .orderBy(asc(schema.carrierActionRequests.createdAt))
      .limit(limit),
    db
      .select({
        id: schema.shipmentCare.id,
        episodeNo: schema.shipmentCare.episodeNo,
        openedAt: schema.shipmentCare.openedAt,
        createdAt: schema.shipmentCare.createdAt,
        assignedAt: schema.shipmentCare.assignedAt,
        firstResponseAt: schema.shipmentCare.firstResponseAt,
        outcomeAt: schema.shipmentCare.outcomeAt,
        careOutcome: schema.shipmentCare.careOutcome,
        entryCarrierState: schema.shipmentCare.entryCarrierState,
        sourceTrigger: schema.shipmentCare.sourceTrigger,
        resolution: schema.shipmentCare.resolution,
      })
      .from(schema.shipmentCare)
      .where(eq(schema.shipmentCare.shipmentId, shipmentId))
      .orderBy(asc(schema.shipmentCare.createdAt)),
    careSlaHours(),
  ]);

  /*
    TÊN NGƯỜI DO MÁY CHỦ ĐỌC TỪ `users`, KHÔNG NHẬN TỪ CLIENT (AGENTS.md luật 34).

    Các bảng đều lưu SẴN một cột email làm ảnh chụp, nhưng email đổi được và `""` trông giống
    `NULL`. Khoá tài khoản mới là quy kết; tên chỉ để người đọc.
  */
  const userIds = [
    ...new Set(
      [
        ...caseEvents.flatMap((e) => [e.actorId, e.previousOwnerId, e.nextOwnerId]),
        ...actions.map((a) => a.actorId),
        ...decisions.map((d) => d.actorId),
        ...commands.map((c) => c.actorId),
      ].filter((v): v is string => Boolean(v)),
    ),
  ];
  const users = userIds.length
    ? await db.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, userIds))
    : [];
  const userName = new Map(users.map((u) => [u.id, u.name || u.email]));

  /**
   * Ai đã làm. `MACHINE` tách hẳn khỏi `UNKNOWN_ACTOR`: dòng do job sinh ra là "máy làm" (một sự
   * thật), dòng cũ không có khoá là "chưa biết ai" (một lỗ hổng). Gộp hai thứ đó lại là biến việc
   * của một job thành việc của một con người trong mọi thẻ điểm.
   */
  function actor(id: string | null, email: string, source?: string): { actorKind: ActorKind; actorName: string; actorId: string | null } {
    if (id) return { actorKind: "USER", actorName: userName.get(id) ?? email ?? "Nhân viên", actorId: id };
    if (source === "SYSTEM" || source === "API") return { actorKind: "MACHINE", actorName: "Hệ thống ERP", actorId: null };
    if (email) return { actorKind: "UNKNOWN_ACTOR", actorName: `${email} (chỉ có chữ, không có tài khoản)`, actorId: null };
    return { actorKind: "UNKNOWN_ACTOR", actorName: "Chưa biết ai", actorId: null };
  }

  const entries: ShipmentTimelineEntry[] = [];

  // ───────── 1. Chứng từ Viettel Post ─────────
  let truoc: string | null = null;
  for (const e of events) {
    const resolved = resolveVtpStatus({ code: eventStatusCode(e.status), text: e.statusName || e.status });
    const mapped = resolved.stage !== "UNKNOWN";
    const stage = stageLabel(e.normalizedStage ?? (mapped ? resolved.stage : null));
    const eventType = carrierEventType(e.source, mapped);
    entries.push({
      id: `evt-${e.id}`,
      at: e.occurredAt,
      // MỐC ERP BIẾT, đứng riêng: webhook rơi rồi đối chiếu vá lại thì khoảng cách này là bằng chứng.
      receivedAt: e.createdAt,
      eventType,
      lane: EVENT_LANE[eventType],
      title: e.statusName || e.status,
      detail: [e.location, e.legType === "RETURN" ? "chiều hoàn" : e.legType === "OUTBOUND" ? "chiều đi" : "", e.sourceReference ? `nguồn ${e.sourceReference}` : ""]
        .filter(Boolean)
        .join(" · "),
      source: e.source,
      actorKind: CARRIER_SOURCE_SET.has(e.source) ? "CARRIER" : "MACHINE",
      actorName: e.source === "PANCAKE" ? "Pancake" : "Viettel Post",
      actorId: null,
      before: CARRIER_SOURCE_SET.has(e.source) ? truoc : null,
      after: stage,
      note: mapped ? e.note : `ERP chưa dịch được câu này — chữ gốc được giữ nguyên, trạng thái vận đơn KHÔNG bị đoán. ${e.note}`.trim(),
    });
    // "Trước" chỉ chạy theo CHỨNG TỪ: bản sao Pancake không được quyền định nghĩa chặng trước đó.
    if (CARRIER_SOURCE_SET.has(e.source) && stage) truoc = stage;
  }

  // ───────── 2. Mốc mở / chốt đợt chăm sóc ─────────
  for (const c of cares) {
    const at = c.openedAt ?? c.createdAt;
    entries.push({
      id: `case-open-${c.id}`,
      at,
      receivedAt: null,
      eventType: "CASE_OPENED",
      lane: EVENT_LANE.CASE_OPENED,
      title: `Mở đợt chăm sóc lần ${c.episodeNo}`,
      detail: [c.sourceTrigger ? `căn cứ ${c.sourceTrigger}` : "", c.entryCarrierState ? `ĐVVC lúc đó: ${c.entryCarrierState}` : ""].filter(Boolean).join(" · "),
      source: "ERP",
      actorKind: "MACHINE",
      actorName: "Hệ thống ERP",
      actorId: null,
      before: null,
      after: CARE_STATUS_LABEL.NEW,
      note: "Đợt do CHỨNG TỪ ĐVVC mở, không do người bấm — bấm nút không làm gói hàng di chuyển.",
    });
    if (c.outcomeAt) {
      entries.push({
        id: `case-close-${c.id}`,
        at: c.outcomeAt,
        receivedAt: null,
        eventType: "CASE_RESOLVED",
        lane: EVENT_LANE.CASE_RESOLVED,
        title: `Chốt đợt chăm sóc lần ${c.episodeNo}`,
        detail: [c.careOutcome ? `kết cục ${c.careOutcome}` : "", c.resolution ? `quyết định ${c.resolution}` : ""].filter(Boolean).join(" · "),
        source: "ERP",
        actorKind: "MACHINE",
        actorName: "Hệ thống ERP",
        actorId: null,
        before: null,
        after: c.careOutcome,
        note: "",
      });
    }
  }

  // ───────── 3. Đổi trạng thái xử lý / giao người / ghi chú ─────────
  for (const e of caseEvents) {
    const type = CARE_EVENT_TYPE[e.action] ?? "CARE_STATUS_CHANGED";
    // Giao việc có ba hình dạng khác nhau và chúng KHÔNG cùng nghĩa với người đọc báo cáo.
    const eventType: TimelineEventType =
      type === "ASSIGNED" && e.previousOwnerId && e.nextOwnerId ? "REASSIGNED" : type === "ASSIGNED" && !e.nextOwnerId ? "UNASSIGNED" : type;
    const isAssign = eventType === "ASSIGNED" || eventType === "REASSIGNED" || eventType === "UNASSIGNED";
    const who = actor(e.actorId, e.actorEmail, e.source);
    entries.push({
      id: `care-${e.id}`,
      at: e.createdAt,
      receivedAt: null,
      eventType,
      lane: EVENT_LANE[eventType],
      title: isAssign ? "Giao việc" : e.action === "NOTE" ? "Ghi chú" : "Đổi trạng thái xử lý",
      detail: e.note,
      source: e.source,
      ...who,
      before: isAssign
        ? e.previousOwnerId
          ? userName.get(e.previousOwnerId) ?? e.previousOwner
          : "Chưa ai nhận"
        : e.previousStatus
          ? CARE_STATUS_LABEL[e.previousStatus as CareStatus] ?? e.previousStatus
          : null,
      after: isAssign
        ? e.nextOwnerId
          ? userName.get(e.nextOwnerId) ?? e.nextOwner
          : "Chưa ai nhận"
        : e.nextStatus
          ? CARE_STATUS_LABEL[e.nextStatus as CareStatus] ?? e.nextStatus
          : null,
      note: "",
    });
  }

  // ───────── 4. Thao tác chăm sóc của người ─────────
  for (const a of actions) {
    const who = actor(a.actorId, a.actorEmail);
    entries.push({
      id: `act-${a.id}`,
      at: a.createdAt,
      receivedAt: null,
      eventType: "CARE_ACTION",
      lane: EVENT_LANE.CARE_ACTION,
      title: CARE_ACTION_LABEL[a.kind as CareActionKind] ?? a.kind,
      detail: a.stageAtAction ? `ĐVVC lúc đó: ${stageLabel(a.stageAtAction) ?? a.stageAtAction}` : "",
      source: "ERP",
      ...who,
      before: null,
      after: null,
      note: a.note,
    });
  }

  // ───────── 5. Bốn quyết định nghiệp vụ ─────────
  for (const d of decisions) {
    const who = actor(d.actorId, d.actorEmail);
    entries.push({
      id: `dec-${d.id}`,
      at: d.requestedAt,
      receivedAt: null,
      eventType: "CARE_DECISION",
      lane: EVENT_LANE.CARE_DECISION,
      title: d.actionType,
      detail: [d.reasonCode ? `lý do ${d.reasonCode}` : "", d.carrierResult ? `ĐVVC trả lời: ${d.carrierResult}` : ""].filter(Boolean).join(" · "),
      source: "ERP",
      ...who,
      before: d.previousCareStatus ? CARE_STATUS_LABEL[d.previousCareStatus as CareStatus] ?? d.previousCareStatus : null,
      after: d.nextCareStatus ? CARE_STATUS_LABEL[d.nextCareStatus as CareStatus] ?? d.nextCareStatus : null,
      note: d.reasonNote,
    });
  }

  // ───────── 5b. Kết quả care của người (KHÔNG phải lệnh gửi ĐVVC) ─────────
  for (const d of careDecisionRows) {
    const who = actor(d.actorId, d.actorEmail);
    const kq = careDecisionOf(d.decision);
    entries.push({
      id: `kq-${d.id}`,
      at: d.decidedAt,
      receivedAt: null,
      eventType: "CARE_DECISION",
      lane: EVENT_LANE.CARE_DECISION,
      title: kq ? `Kết quả care: ${RESOLUTION_LABEL[kq]}` : d.decision,
      detail: [d.reasonCode ? `lý do ${d.reasonCode}` : "", d.carrierSubstateAtDecision ? `ĐVVC lúc đó: ${d.carrierSubstateAtDecision}` : ""].filter(Boolean).join(" · "),
      source: "ERP",
      ...who,
      before: d.previousCareStatus ? CARE_STATUS_LABEL[d.previousCareStatus as CareStatus] ?? d.previousCareStatus : null,
      after: d.nextCareStatus ? CARE_STATUS_LABEL[d.nextCareStatus as CareStatus] ?? d.nextCareStatus : null,
      note: d.note,
    });
  }

  // ───────── 6. Lệnh gửi sang Viettel Post ─────────
  for (const c of commands) {
    const who = actor(c.actorId, c.actorEmail);
    entries.push({
      id: `cmd-${c.id}`,
      at: c.createdAt,
      // Lệnh được ĐVVC xác nhận bằng SỰ KIỆN, không bằng phản hồi API — mốc xác nhận đứng riêng.
      receivedAt: c.confirmedAt,
      eventType: "VTP_COMMAND",
      lane: EVENT_LANE.VTP_COMMAND,
      title: CARRIER_ACTION_LABEL[c.actionKey as CarrierActionKey] ?? c.actionKey,
      detail: CARRIER_REQUEST_LABEL[c.status as CarrierRequestStatus] ?? c.status,
      source: "ERP",
      ...who,
      before: null,
      after: c.status,
      note: [c.note, c.error].filter(Boolean).join(" · "),
    });
  }

  /*
    ═══ 7. KẾT LUẬN CỦA ERP — MỘT DÒNG RIÊNG, ĐỨNG CẠNH CHỨNG TỪ, KHÔNG ĐỨNG THAY ═══

    Luật của shop (doanh thu COD ≤ 100.000đ ⇒ không thành công) và luật vận đơn chiều hoàn có thể
    cho kết luận NGƯỢC với câu Viettel Post ghi. Điều tuyệt đối không được làm là sửa dòng chứng từ:
    Viettel Post ghi "Giao thành công" thì nhật ký ĐVVC mãi mãi ghi "Giao thành công".

    Nên kết luận đứng ở chiều `DERIVED`, mang mốc của CHỨNG TỪ CUỐI CÙNG — vì đó là lúc đủ căn cứ
    để kết luận, không phải lúc ai đó mở màn hình này. Công thức đọc từ `ORDER_OUTCOME`, nguồn duy
    nhất, không dựng lại ở đây.
  */
  const outcome = await outcomeOfShipment(shipmentId);
  const chungTuCuoi = events.filter((e) => CARRIER_SOURCE_SET.has(e.source)).at(-1);
  if (outcome && chungTuCuoi) {
    const nhan = OUTCOME_LABEL[outcome as OrderOutcome] ?? outcome;
    entries.push({
      id: `kpi-${shipmentId}`,
      at: chungTuCuoi.occurredAt,
      receivedAt: null,
      eventType: "KPI_OUTCOME",
      lane: EVENT_LANE.KPI_OUTCOME,
      title: `ERP kết luận: ${nhan}`,
      detail: `Chứng từ ĐVVC cuối cùng: ${chungTuCuoi.statusName || chungTuCuoi.status}`,
      source: "ORDER_OUTCOME",
      actorKind: "MACHINE",
      actorName: "Luật kết quả đơn",
      actorId: null,
      before: stageLabel(chungTuCuoi.normalizedStage),
      after: nhan,
      note: "Kết luận theo luật của shop. KHÔNG sửa một chữ nào trong lịch sử của Viettel Post.",
    });
  }

  entries.sort((a, b) => b.at.getTime() - a.at.getTime());

  // ───────── Thời gian phản ứng — TÍNH TỪ NHẬT KÝ, không đọc cột đã lưu ─────────
  const care = cares.at(-1) ?? null;
  const caseOpenedAt = care ? care.openedAt ?? care.createdAt : null;
  const humanEntries = entries.filter((e) => e.lane === "HUMAN").sort((a, b) => a.at.getTime() - b.at.getTime());
  const firstAssignedAt = humanEntries.find((e) => e.eventType === "ASSIGNED" || e.eventType === "REASSIGNED")?.at ?? care?.assignedAt ?? null;
  const firstActionAt = humanEntries[0]?.at ?? null;
  const firstCustomerContactAt =
    actions.filter((a) => CUSTOMER_CONTACT.includes(a.kind as CareActionKind)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0]?.createdAt ?? null;
  const firstCarrierContactAt =
    [
      ...actions.filter((a) => a.kind === "ESCALATED_CARRIER").map((a) => a.createdAt),
      ...commands.map((c) => c.createdAt),
    ].sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  const lastActionAt = humanEntries.at(-1)?.at ?? null;
  const resolvedAt = care?.outcomeAt ?? null;

  const minutesToFirstAction = minutesBetween(caseOpenedAt, firstActionAt);
  const durations: CareDurations = {
    caseOpenedAt,
    firstAssignedAt,
    firstActionAt,
    firstCustomerContactAt,
    firstCarrierContactAt,
    lastActionAt,
    resolvedAt,
    minutesToAssign: minutesBetween(caseOpenedAt, firstAssignedAt),
    minutesToFirstAction,
    minutesToFirstContact: minutesBetween(caseOpenedAt, firstCustomerContactAt),
    minutesToResolution: minutesBetween(caseOpenedAt, resolvedAt),
    /*
      VỠ HẠN TÍNH LÚC ĐỌC (AGENTS.md luật 26) — và nó KHÔNG BAO GIỜ được xoá khi ca được xử lý muộn.
      Ca mở lúc 09:00, hạn phản hồi 2 giờ, người chạm lúc 13:00 ⇒ vẫn là vỡ hạn, mãi mãi.
      Ca chưa có ai chạm thì so với BÂY GIỜ: im lặng không làm cái hạn biến mất.
    */
    firstResponseBreached: caseOpenedAt
      ? (minutesToFirstAction ?? Math.round((Date.now() - caseOpenedAt.getTime()) / 60_000)) > sla.firstResponseHours * 60
      : false,
    slaFirstResponseHours: sla.firstResponseHours,
  };

  if (durations.firstResponseBreached && caseOpenedAt) {
    const at = new Date(caseOpenedAt.getTime() + sla.firstResponseHours * 3_600_000);
    entries.push({
      id: `sla-${care?.id ?? shipmentId}`,
      at,
      receivedAt: null,
      eventType: "SLA_BREACHED",
      lane: EVENT_LANE.SLA_BREACHED,
      title: `Vỡ hạn phản hồi đầu (${sla.firstResponseHours} giờ)`,
      detail: durations.firstActionAt ? `Người chạm vào lúc ${durations.firstActionAt.toISOString()}` : "Tới giờ vẫn chưa ai chạm vào",
      source: "ERP",
      actorKind: "MACHINE",
      actorName: "Hệ thống ERP",
      actorId: null,
      before: null,
      after: null,
      note: "Vỡ hạn KHÔNG bị xoá khi ca được xử lý muộn — nó là một sự việc đã xảy ra.",
    });
    entries.sort((a, b) => b.at.getTime() - a.at.getTime());
  }

  return {
    entries,
    durations,
    counts: {
      carrier: entries.filter((e) => e.lane === "CARRIER").length,
      human: entries.filter((e) => e.lane === "HUMAN").length,
      system: entries.filter((e) => e.lane === "SYSTEM").length,
      derived: entries.filter((e) => e.lane === "DERIVED").length,
      calls: actions.filter((a) => CALL_KINDS.includes(a.kind as CareActionKind)).length,
      messages: actions.filter((a) => a.kind === "MESSAGED").length,
      carrierContacts: actions.filter((a) => a.kind === "ESCALATED_CARRIER").length + commands.length,
    },
  };
}

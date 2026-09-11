import { z } from "zod";
import { defineTool } from "@/lib/ai/tools/registry";
import { addCareNote, setCareFollowUp, setCareOwner, setCareStatus } from "@/lib/care/service";
import { CARE_STATUS_LABEL, CARE_STATUSES, CARE_VIEWS, CARRIER_ACTION_LABEL } from "@/lib/constants/care";
import { CARE_ACTION_KINDS, CARE_ACTION_LABEL } from "@/lib/constants/delivery-tower";
import { FRESHNESS_LABEL } from "@/lib/constants/logistics-freshness";
import { getCareReport } from "@/lib/queries/care-report";
import { getCareCaseDetail, getCareQueue } from "@/lib/queries/care-workbench";
import { getLogisticsFreshness } from "@/lib/queries/logistics-freshness";
import { resolvePeriod } from "@/lib/search-params";

/**
 * ═══════════ TOOL CHO "VẬN ĐƠN & CARE" — MVP ĐẦU TIÊN CỦA COPILOT ═══════════
 *
 * Đọc: gọi đúng các hàm mà bàn làm việc đang dùng (`getCareQueue`, `getCareCaseDetail`,
 * `getCareReport`, `getLogisticsFreshness`) — AI thấy đúng số người thấy, không có đường tính riêng.
 * Ghi: gọi `lib/care/service.ts` với actor nguồn AI ⇒ vào `care_case_events` (source = AI) + audit.
 * Yêu cầu Viettel Post: khai `forbidden` — người tự bấm trong bàn làm việc.
 */

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const hoursAgo = (d: Date | null | undefined, now: Date) => (d ? Math.round(((now.getTime() - d.getTime()) / 3_600_000) * 10) / 10 : null);

/** Nhận diện "dữ liệu cũ" để AI nói ra: tin ĐVVC cuối đã hơn 24 giờ hoặc chưa có tin. */
function stalenessOf(lastEventAt: Date | null, capability: string, now: Date): string | null {
  if (!lastEventAt) return "Chưa có tin nào từ ĐVVC cho kiện này — không biết kiện đang ở đâu.";
  const h = hoursAgo(lastEventAt, now) ?? 0;
  if (h >= 24) return `Tin ĐVVC cuối đã ${Math.round(h)} giờ${capability === "WEBHOOK_ONLY" ? " và tài khoản API không đọc được kiện này (chỉ nhận webhook)" : ""} — trạng thái có thể đã đổi mà ERP chưa biết.`;
  return null;
}

export const getCareCaseTool = defineTool({
  name: "get_care_case",
  label: "Xem hồ sơ kiện",
  description:
    "Toàn bộ bối cảnh một kiện cần care: đơn, khách (lịch sử mua), lần gửi, hành trình Viettel Post thô, COD, trạng thái care, SLA, lịch sử care, yêu cầu ĐVVC và hành động nào làm được qua API. Dùng trước khi tóm tắt hay đề nghị bước tiếp theo.",
  kind: "read",
  riskClass: "general",
  permission: "shipments:view",
  policy: "auto",
  input: z.object({ shipmentId: z.string().min(1).describe("Mã kiện trong ERP (shipments.id) — lấy từ bối cảnh hoặc từ search_care_cases") }),
  run: async (ctx, { shipmentId }) => {
    const d = await getCareCaseDetail(shipmentId);
    if (!d) return { error: "Không tìm thấy kiện" };
    const lastEventAt = d.journey[0]?.at ?? null;
    return {
      shipment: { ...d.shipment, stageLabel: d.shipment.stageLabel },
      order: d.order,
      customer: d.customer,
      journey: d.journey.slice(0, 15).map((j) => ({ at: iso(j.at), status: j.status, note: j.note, location: j.location, source: j.source })),
      care: { ...d.care, statusLabel: CARE_STATUS_LABEL[d.care.status], followUpAt: iso(d.care.followUpAt), lastNoteAt: iso(d.care.lastNoteAt), firstResponseAt: iso(d.care.firstResponseAt), doneAt: iso(d.care.doneAt), updatedAt: iso(d.care.updatedAt) },
      queueSince: iso(d.queueSince),
      sla: d.sla ? { ...d.sla, firstResponseDueAt: iso(d.sla.firstResponseDueAt), resolveDueAt: iso(d.sla.resolveDueAt) } : null,
      events: d.events.slice(0, 20).map((e) => ({ at: iso(e.at), actor: e.actor, source: e.source, action: e.action, note: e.note, from: e.previousStatus, to: e.nextStatus, owner: e.nextOwner, followUpAt: iso(e.followUpAt) })),
      careActions: d.careActions.slice(0, 10).map((a) => ({ at: iso(a.at), kind: a.kind, label: a.label, note: a.note, actor: a.actor })),
      carrierRequests: d.carrierRequests.slice(0, 5).map((r) => ({ action: CARRIER_ACTION_LABEL[r.actionKey], status: r.status, at: iso(r.at), error: r.error, attempts: r.attempts })),
      capabilities: d.capabilities.map((c) => ({ action: CARRIER_ACTION_LABEL[c.actionKey], status: c.status, allowedAtStage: c.allowedAtStage, reason: c.reason, webUrl: c.webUrl })),
      staleness: stalenessOf(lastEventAt, d.shipment.trackingCapability, ctx.now),
    };
  },
});

export const getCareQueueSummaryTool = defineTool({
  name: "get_care_queue_summary",
  label: "Tổng quan hàng đợi care",
  description: "Hàng đợi care hiện tại: số kiện theo tab (cần care / đang chờ / escalated / đã xử lý), theo lý do, theo người nhận, COD đang treo, số vỡ SLA, chưa ai nhận, và 10 kiện gấp nhất. Kiện cũ dữ liệu được tách riêng, không tính là backlog.",
  kind: "read",
  riskClass: "general",
  permission: "shipments:view",
  policy: "auto",
  input: z.object({}),
  run: async (ctx) => {
    const q = await getCareQueue();
    const urgent = q.cases
      .filter((c) => c.view === "care")
      .sort((a, b) => Number(b.sla.resolveBreached) - Number(a.sla.resolveBreached) || b.codAmount - a.codAmount)
      .slice(0, 10)
      .map((c) => ({ shipmentId: c.shipmentId, tracking: c.tracking, customer: c.customer, codAmount: c.codAmount, reason: c.reasonLabel, careStatus: c.care.status, owner: c.care.owner?.name ?? null, overdue: c.sla.resolveBreached, queueSince: iso(c.queueSince) }));
    return { counts: q.counts, byReason: q.byReason, byOwner: q.byOwner, moneyAtRisk: q.moneyAtRisk, overdue: q.overdue, unassigned: q.unassigned, dataGaps: q.dataGaps.length, urgent, measuredAt: iso(q.measuredAt), measuredAgeMinutes: Math.round((ctx.now.getTime() - q.measuredAt.getTime()) / 60_000) };
  },
});

export const searchCareCasesTool = defineTool({
  name: "search_care_cases",
  label: "Tìm kiện trong hàng đợi",
  description: "Tìm kiện đang trong hàng đợi care theo mã vận đơn / tên khách / SĐT, theo tab, theo người nhận việc hoặc trạng thái care. Trả tối đa `limit` kiện, gấp nhất trước.",
  kind: "read",
  riskClass: "general",
  permission: "shipments:view",
  policy: "auto",
  input: z.object({
    query: z.string().max(80).nullable().describe("Chuỗi tìm: mã vận đơn, tên khách hoặc SĐT; null = không lọc"),
    view: z.enum(CARE_VIEWS).nullable().describe("Tab: care / waiting / escalated / done / all; null = all"),
    ownerName: z.string().max(80).nullable().describe("Tên người nhận việc; 'none' = chưa ai nhận; null = không lọc"),
    careStatus: z.enum(CARE_STATUSES).nullable(),
    limit: z.number().int().min(1).max(50),
  }),
  run: async (_ctx, input) => {
    const q = await getCareQueue();
    const needle = input.query?.trim().toLowerCase() ?? "";
    const owner = input.ownerName?.trim().toLowerCase() ?? "";
    const rows = q.cases
      .filter((c) => !input.view || input.view === "all" || c.view === input.view)
      .filter((c) => !input.careStatus || c.care.status === input.careStatus)
      .filter((c) => !owner || (owner === "none" ? !c.care.owner : (c.care.owner?.name ?? "").toLowerCase().includes(owner)))
      .filter((c) => !needle || c.tracking.toLowerCase().includes(needle) || c.customer.toLowerCase().includes(needle) || c.phone.includes(needle))
      .sort((a, b) => Number(b.sla.resolveBreached) - Number(a.sla.resolveBreached) || b.codAmount - a.codAmount);
    return {
      total: rows.length,
      cases: rows.slice(0, input.limit).map((c) => ({ shipmentId: c.shipmentId, tracking: c.tracking, customer: c.customer, phone: c.phone, codAmount: c.codAmount, carrierStage: c.carrier.stageLabel, failedAttempts: c.carrier.failedAttempts, reason: c.reasonLabel, nextAction: c.nextAction, careStatus: c.care.status, owner: c.care.owner?.name ?? null, followUpAt: iso(c.care.followUpAt), lastNote: c.care.lastNote, view: c.view, overdue: c.sla.resolveBreached, reopened: c.reopened })),
    };
  },
});

export const getCareReportTool = defineTool({
  name: "get_care_report",
  label: "Báo cáo hiệu quả care",
  description: "Báo cáo hiệu quả care theo kỳ (7 / 30 / 90 ngày): backlog, phản hồi đầu, thời gian xử lý, kiện giao hụt được cứu (attribution chặt: chỉ tính khi có can thiệp ghi nhận TRƯỚC kết cục), COD và doanh thu cứu được, phát lại, yêu cầu ĐVVC, theo nhân viên. Không xếp hạng nhân viên theo số cú bấm.",
  kind: "read",
  riskClass: "general",
  permission: "shipments:view",
  policy: "auto",
  input: z.object({ period: z.enum(["7d", "30d", "90d"]) }),
  run: async (_ctx, { period }) => {
    const r = await getCareReport(resolvePeriod({ period }, "30d"));
    return { period: r.period.label, backlog: r.backlog, firstResponse: r.firstResponse, done: r.done, recovery: r.recovery, redelivery: r.redelivery, carrierRequests: r.carrierRequests, staff: r.staff.slice(0, 20) };
  },
});

export const getDataFreshnessTool = defineTool({
  name: "get_data_freshness",
  label: "Độ tươi dữ liệu giao vận",
  description: "Dữ liệu Viettel Post trong ERP còn mới không: webhook nhận tin lúc nào, bao nhiêu kiện đang đi có tin cũ / rất cũ, tài khoản API đọc được bao nhiêu kiện. Gọi khi người hỏi 'sao chưa cập nhật' hoặc trước khi kết luận về nhiều kiện.",
  kind: "read",
  riskClass: "general",
  permission: "shipments:view",
  policy: "auto",
  input: z.object({}),
  run: async (ctx) => {
    const f = await getLogisticsFreshness();
    return {
      inFlight: f.inFlight,
      byClass: Object.fromEntries(Object.entries(f.byClass).map(([k, v]) => [FRESHNESS_LABEL[k as keyof typeof FRESHNESS_LABEL] ?? k, v])),
      webhookLastAt: iso(f.webhookLastAt),
      webhookAgeHours: hoursAgo(f.webhookLastAt, ctx.now),
      webhookLastHour: f.webhookLastHour,
      webhookLast24h: f.webhookLast24h,
      apiBlindStreak: f.apiBlindStreak,
      byCapability: f.byCapability,
      stages: f.stages.map((s) => ({ stage: s.stage, inFlight: s.inFlight, medianAgeHours: s.medianAgeHours, oldestAgeHours: s.oldestAgeHours, why: s.why })),
    };
  },
});

// ───────────────────────────── TOOL GHI — CHỈ SAU XÁC NHẬN ─────────────────────────────

export const addCareNoteTool = defineTool({
  name: "add_care_note",
  label: "Ghi note care",
  description: "Ghi một note care vào kiện (đã gọi được / không nghe máy / đã nhắn / đổi địa chỉ / hẹn lại / khách từ chối / đã báo ĐVVC / khác). Kiện NEW hoặc ASSIGNED sẽ chuyển IN_PROGRESS. Chỉ dùng khi người dùng nói rõ họ đã làm việc đó.",
  kind: "write",
  riskClass: "care",
  permission: "shipments:view",
  policy: "confirm",
  input: z.object({ shipmentId: z.string().min(1), kind: z.enum(CARE_ACTION_KINDS), note: z.string().min(1).max(500) }),
  summarize: (i) => `Ghi note "${CARE_ACTION_LABEL[i.kind]}" cho kiện ${i.shipmentId}: ${i.note}`,
  run: (ctx, i) => addCareNote(ctx.actor, i),
});

export const assignCareCaseTool = defineTool({
  name: "assign_care_case",
  label: "Giao kiện cho người",
  description: "Giao một hoặc nhiều kiện cho một nhân viên (ownerId là id người dùng ERP, lấy từ get_care_queue_summary.byOwner hoặc do người dùng cung cấp). Kiện NEW sẽ thành ASSIGNED. Không tự chọn người nếu người dùng chưa nói.",
  kind: "write",
  riskClass: "care",
  permission: "shipments:view",
  policy: "confirm",
  input: z.object({ shipmentIds: z.array(z.string().min(1)).min(1).max(20), ownerId: z.string().min(1) }),
  summarize: (i) => `Giao ${i.shipmentIds.length} kiện (${i.shipmentIds.slice(0, 3).join(", ")}${i.shipmentIds.length > 3 ? "…" : ""}) cho người dùng ${i.ownerId}`,
  run: (ctx, i) => setCareOwner(ctx.actor, i),
});

export const setCareStatusTool = defineTool({
  name: "set_care_status",
  label: "Đổi trạng thái care",
  description: "Đổi trạng thái care của một hoặc nhiều kiện theo vòng đời NEW → ASSIGNED → IN_PROGRESS → WAITING_* → RESOLVED / ESCALATED / CANCELLED. RESOLVED / CANCELLED không đổi được nữa (phải mở lại trên bàn làm việc). Trạng thái care KHÔNG đổi trạng thái Viettel Post.",
  kind: "write",
  riskClass: "care",
  permission: "shipments:view",
  policy: "confirm",
  input: z.object({ shipmentIds: z.array(z.string().min(1)).min(1).max(20), status: z.enum(CARE_STATUSES), note: z.string().max(500) }),
  summarize: (i) => `Chuyển ${i.shipmentIds.length} kiện sang "${CARE_STATUS_LABEL[i.status]}"${i.note ? ` — ${i.note}` : ""}`,
  run: (ctx, i) => setCareStatus(ctx.actor, i),
});

export const setCareFollowUpTool = defineTool({
  name: "set_care_follow_up",
  label: "Hẹn giờ theo dõi",
  description: "Đặt mốc theo dõi lại (ISO 8601, UTC) và chuyển kiện sang trạng thái chờ tương ứng (chờ khách / chờ ĐVVC / chờ phát lại). Tới giờ, kiện tự quay về Cần care. Chỉ dùng khi người dùng nói rõ hẹn lúc nào.",
  kind: "write",
  riskClass: "care",
  permission: "shipments:view",
  policy: "confirm",
  input: z.object({ shipmentId: z.string().min(1), at: z.string().datetime({ offset: true }).describe("Mốc theo dõi, ISO 8601 có múi giờ"), waitingFor: z.enum(["WAITING_CUSTOMER", "WAITING_CARRIER", "WAITING_REDELIVERY"]) }),
  summarize: (i) => `Hẹn theo dõi kiện ${i.shipmentId} lúc ${i.at} (${CARE_STATUS_LABEL[i.waitingFor]})`,
  run: (ctx, i) => setCareFollowUp(ctx.actor, { shipmentId: i.shipmentId, at: new Date(i.at), waitingFor: i.waitingFor }),
});

/** Khai tường minh: AI KHÔNG gửi yêu cầu tới Viettel Post. Người bấm trong bàn làm việc, có vòng đời riêng. */
export const requestCarrierActionTool = defineTool({
  name: "request_carrier_action",
  label: "Gửi yêu cầu tới Viettel Post",
  description: "Phát lại / duyệt hoàn / sửa người nhận / huỷ trên Viettel Post. AI không được gọi — người thao tác trong bàn làm việc.",
  kind: "write",
  riskClass: "carrier",
  permission: "shipments:manage",
  policy: "forbidden",
  input: z.object({ shipmentId: z.string().min(1) }),
  summarize: (i) => `Yêu cầu ĐVVC cho kiện ${i.shipmentId}`,
  run: async () => ({ error: "AI không được gửi yêu cầu tới Viettel Post" }),
});

/** Gọi để chắc chắn mọi tool ở file này đã đăng ký (import side-effect). */
export function registerCareTools() {
  return [getCareCaseTool, getCareQueueSummaryTool, searchCareCasesTool, getCareReportTool, getDataFreshnessTool, addCareNoteTool, assignCareCaseTool, setCareStatusTool, setCareFollowUpTool, requestCarrierActionTool];
}

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo } from "@/lib/cache";
import { carrierCapabilitiesFor } from "@/lib/care/carrier-capabilities";
import type { CareCase, CareCaseDetail, CareEvent, CareQueue, CareState, CarrierRequestView } from "@/lib/care/contracts";
import { careViewOf, slaOf } from "@/lib/care/view";
import { CARE_BUCKETS, CARE_REASON_LABEL, CARE_SLA, CARE_TERMINAL_STATUSES, type CareEventAction, type CareEventSource, type CareReasonClass, type CareReasonKey, type CareStatus, type CarrierActionKey, type CarrierRequestStatus } from "@/lib/constants/care";
import { BUCKET_BY_KEY, CARE_ACTION_LABEL, type CareActionKind } from "@/lib/constants/delivery-tower";
import { SHIPMENT_STAGE_LABEL } from "@/lib/constants/viettelpost";
import { env } from "@/lib/env";
import { getDeliveryTower, type TowerRow } from "@/lib/queries/delivery-tower";
import { getShipmentQuickView } from "@/lib/queries/shipment-quickview";
import { rowsOf } from "@/lib/sql-rows";

export type { CareCase, CareCaseDetail, CareEvent, CareQueue, CareState, CarrierRequestView } from "@/lib/care/contracts";
export { careViewOf, slaOf } from "@/lib/care/view";
import { CARE_NOTE_PRESETS_DEFAULT, CARE_NOTE_PRESETS_KEY, type CareNotePreset } from "@/lib/constants/care";
import { getSettingJson } from "@/lib/settings";
/** Tên cũ — UI hiện tại đang dùng; giữ nguyên hình dạng, `CareQueue` là bản đầy đủ. */
export type CareWorkbench = CareQueue;

/**
 * ═══════════ HÀNG ĐỢI CARE: ACTIONABLE POPULATION, KHÔNG PHẢI DANH SÁCH VẬN ĐƠN ═══════════
 *
 * Máy chủ quyết định kiện nào cần người; UI không nhận toàn bộ vận đơn rồi tự lọc. Điều kiện cần
 * care lấy từ ĐÚNG các rổ của tháp giao vận (một luật xếp rổ) + case CSKH sai địa chỉ / SĐT còn mở
 * của lần gửi đang chạy. Trạng thái care là lớp riêng đè lên: kiện RỜI hàng đợi khi điều kiện hết,
 * không phải khi đội bấm xong.
 *
 * Kiện "cũ dữ liệu / thiếu dữ liệu" (DATA_FRESHNESS) KHÔNG phải kiện hỏng: trả riêng ở `dataGaps`,
 * không đếm vào backlog care, không tính SLA care.
 */

const REASON_CLASS: Record<CareReasonKey, CareReasonClass> = {
  CARE_TODAY: "CUSTOMER_ACTION",
  NO_CONTACT: "CUSTOMER_ACTION",
  DELIVERY_FAILED: "CUSTOMER_ACTION",
  AWAITING_REDELIVERY: "CARRIER_ACTION",
  WRONG_INFO: "CUSTOMER_ACTION",
  STALE_NO_UPDATE: "DATA_FRESHNESS",
  DATA_GAP: "DATA_FRESHNESS",
  RETURNING: "CARRIER_ACTION",
  RETURN_AT_SHOP: "CARRIER_ACTION",
};

const EMPTY_CARE: CareState = { status: "NEW", owner: null, followUpAt: null, lastNote: "", lastNoteAt: null, lastNoteBy: "", firstResponseAt: null, doneAt: null, reopenCount: 0, updatedAt: null, updatedBy: "" };

type CareRow = typeof schema.shipmentCare.$inferSelect & { ownerName: string | null };

function toCareState(r: CareRow | undefined): CareState {
  if (!r) return EMPTY_CARE;
  return {
    status: r.careStatus as CareStatus,
    owner: r.ownerId ? { id: r.ownerId, name: r.ownerName || r.ownerEmail || r.ownerId } : null,
    followUpAt: r.followUpAt,
    lastNote: r.lastNote,
    lastNoteAt: r.lastNoteAt,
    lastNoteBy: r.lastNoteBy,
    firstResponseAt: r.firstResponseAt,
    doneAt: r.doneAt,
    reopenCount: r.reopenCount,
    updatedAt: r.updatedAt,
    updatedBy: r.updatedBy,
  };
}

async function loadCareRows(shipmentIds: string[]): Promise<Map<string, CareRow>> {
  if (!shipmentIds.length) return new Map();
  const db = await getDb();
  const rows = await db
    .select({ care: schema.shipmentCare, ownerName: schema.users.name })
    .from(schema.shipmentCare)
    .leftJoin(schema.users, eq(schema.users.id, schema.shipmentCare.ownerId))
    .where(inArray(schema.shipmentCare.shipmentId, shipmentIds));
  return new Map(rows.map((r) => [r.care.shipmentId, { ...r.care, ownerName: r.ownerName }]));
}

function toRequestView(r: typeof schema.carrierActionRequests.$inferSelect): CarrierRequestView {
  return { id: r.id, actionKey: r.actionKey as CarrierActionKey, status: r.status as CarrierRequestStatus, at: r.createdAt, error: r.error, note: r.note, actor: r.actorEmail, attempts: r.attempts };
}

async function loadLatestRequests(shipmentIds: string[]): Promise<Map<string, CarrierRequestView>> {
  if (!shipmentIds.length) return new Map();
  const db = await getDb();
  const rows = rowsOf<{ shipment_id: string; id: string; action_key: string; status: string; at: string; error: string | null; note: string; actor_email: string; attempts: number }>(
    await db.execute(sql`
      select distinct on (shipment_id) shipment_id, id, action_key, status, created_at as at, error, note, actor_email, attempts
        from carrier_action_requests
       where shipment_id in ${shipmentIds}
       order by shipment_id, created_at desc
    `),
  );
  return new Map(
    rows.map((r) => [r.shipment_id, { id: r.id, actionKey: r.action_key as CarrierActionKey, status: r.status as CarrierRequestStatus, at: new Date(r.at), error: r.error, note: r.note, actor: r.actor_email, attempts: Number(r.attempts ?? 0) }]),
  );
}

/** Mốc vào hàng đợi + năng lực API, một lượt cho cả tập kiện. */
async function loadQueueFacts(shipmentIds: string[]): Promise<Map<string, { failedAt: Date | null; lastAt: Date | null; createdAt: Date; capability: string }>> {
  if (!shipmentIds.length) return new Map();
  const db = await getDb();
  const rows = rowsOf<{ id: string; failed_at: string | null; last_at: string | null; created_at: string; capability: string }>(
    await db.execute(sql`
      select s.id,
             s.created_at,
             s.tracking_capability as capability,
             (select max(e.occurred_at) from shipment_events e where e.shipment_id = s.id and e.normalized_stage = 'DELIVERY_FAILED') as failed_at,
             (select max(e.occurred_at) from shipment_events e where e.shipment_id = s.id) as last_at
        from shipments s
       where s.id in ${shipmentIds}
    `),
  );
  return new Map(rows.map((r) => [r.id, { failedAt: r.failed_at ? new Date(r.failed_at) : null, lastAt: r.last_at ? new Date(r.last_at) : null, createdAt: new Date(r.created_at), capability: r.capability }]));
}

type WrongInfoRow = { shipment_id: string; tracking: string; order_id: string; system_id: number | null; customer: string; phone: string; cod_amount: string | number; stage: string; vtp_status_name: string | null; kind: string; title: string; opened_at: string; tuoi_gio: string | number | null; lan_hut: number };

/** Case CSKH sai địa chỉ / SĐT còn mở, gắn với lần gửi đang chạy của đơn ⇒ kiện cần sửa thông tin. */
async function loadWrongInfoCases(excludeIds: Set<string>): Promise<WrongInfoRow[]> {
  const db = await getDb();
  const rows = rowsOf<WrongInfoRow>(
    await db.execute(sql`
      select distinct on (s.id)
             s.id as shipment_id,
             coalesce(nullif(s.vtp_order_number, ''), nullif(s.tracking_code, ''), s.id) as tracking,
             o.id as order_id, o.system_id,
             coalesce(o.bill_full_name, s.receiver_name, '') as customer,
             coalesce(o.bill_phone, s.receiver_phone, '') as phone,
             s.cod_amount, s.stage::text as stage, s.vtp_status_name,
             c.kind, c.title, c.created_at as opened_at,
             extract(epoch from (now() - (select max(e.occurred_at) from shipment_events e where e.shipment_id = s.id))) / 3600 as tuoi_gio,
             (select count(*) from shipment_events e where e.shipment_id = s.id and e.normalized_stage = 'DELIVERY_FAILED')::int as lan_hut
        from cs_cases c
        join orders o on o.id = c.order_id
        join shipments s on s.order_id = o.id and s.is_final = false
       where c.status = 'OPEN' and c.kind in ('WRONG_ADDRESS', 'WRONG_PHONE')
       order by s.id, c.created_at desc
    `),
  );
  return rows.filter((r) => !excludeIds.has(r.shipment_id));
}

function vtpConfigured() {
  return Boolean(env.viettelPost.apiKey || (env.viettelPost.username && env.viettelPost.password));
}

function carrierCapabilityOf(capability: string): "API" | "MANUAL" {
  return vtpConfigured() && capability === "API_TRACKABLE" ? "API" : "MANUAL";
}

type TrackingCapability = CareCase["carrier"]["trackingCapability"];
function asTrackingCapability(v: string | undefined): TrackingCapability {
  return v === "API_TRACKABLE" || v === "WEBHOOK_ONLY" ? v : "UNKNOWN_CAPABILITY";
}

async function buildQueue(): Promise<CareQueue> {
  const now = new Date();
  const tower = await getDeliveryTower();
  const towerRows: TowerRow[] = tower.buckets.filter((b) => (CARE_BUCKETS as string[]).includes(b.key)).flatMap((b) => b.rows);
  const towerIds = new Set(towerRows.map((r) => r.shipmentId));
  const wrongInfo = await loadWrongInfoCases(towerIds);

  const db = await getDb();
  // "Đã xử lý" 7 ngày gần nhất — kể cả kiện đã rời điều kiện cần care.
  const doneRows = await db
    .select({ care: schema.shipmentCare, ownerName: schema.users.name })
    .from(schema.shipmentCare)
    .leftJoin(schema.users, eq(schema.users.id, schema.shipmentCare.ownerId))
    .where(and(inArray(schema.shipmentCare.careStatus, CARE_TERMINAL_STATUSES), gte(schema.shipmentCare.doneAt, new Date(now.getTime() - CARE_SLA.doneWindowDays * 86_400_000))))
    .orderBy(desc(schema.shipmentCare.doneAt))
    .limit(300);
  const doneOnlyIds = doneRows.map((r) => r.care.shipmentId).filter((id) => !towerIds.has(id) && !wrongInfo.some((w) => w.shipment_id === id));

  const allIds = [...towerIds, ...wrongInfo.map((w) => w.shipment_id), ...doneOnlyIds];
  const [careMap, reqMap, facts, doneShipments] = await Promise.all([
    loadCareRows(allIds),
    loadLatestRequests(allIds),
    loadQueueFacts(allIds),
    doneOnlyIds.length
      ? db
          .select({
            id: schema.shipments.id,
            tracking: sql<string>`coalesce(nullif(${schema.shipments.vtpOrderNumber}, ''), nullif(${schema.shipments.trackingCode}, ''), ${schema.shipments.id})`,
            orderId: schema.shipments.orderId,
            systemId: schema.orders.systemId,
            customer: sql<string>`coalesce(${schema.orders.billFullName}, ${schema.shipments.receiverName}, '')`,
            phone: sql<string>`coalesce(${schema.orders.billPhone}, ${schema.shipments.receiverPhone}, '')`,
            codAmount: schema.shipments.codAmount,
            stage: schema.shipments.stage,
            rawStatus: schema.shipments.vtpStatusName,
          })
          .from(schema.shipments)
          .leftJoin(schema.orders, eq(schema.orders.id, schema.shipments.orderId))
          .where(inArray(schema.shipments.id, doneOnlyIds))
      : Promise.resolve([]),
  ]);
  for (const r of doneRows) careMap.set(r.care.shipmentId, { ...r.care, ownerName: r.ownerName });

  const queueSinceOf = (id: string, fallback: Date | null) => {
    const f = facts.get(id);
    return f?.failedAt ?? f?.lastAt ?? fallback ?? f?.createdAt ?? now;
  };

  const all: CareCase[] = [];
  const push = (base: Omit<CareCase, "care" | "sla" | "view" | "reopened" | "carrierRequest" | "carrierCapability" | "reasonClass" | "carrier"> & { carrier: Omit<CareCase["carrier"], "trackingCapability"> }) => {
    const care = toCareState(careMap.get(base.shipmentId));
    const { view, reopened } = careViewOf(care, base.queueSince, now);
    const capability = facts.get(base.shipmentId)?.capability;
    all.push({
      ...base,
      carrier: { ...base.carrier, trackingCapability: asTrackingCapability(capability) },
      reasonClass: REASON_CLASS[base.reason],
      care,
      reopened,
      sla: slaOf(base.queueSince, care, now),
      carrierRequest: reqMap.get(base.shipmentId) ?? null,
      carrierCapability: carrierCapabilityOf(capability ?? "UNKNOWN_CAPABILITY"),
      view,
    });
  };

  for (const r of towerRows) {
    push({
      shipmentId: r.shipmentId,
      tracking: r.tracking,
      orderId: r.orderId,
      orderSystemId: r.orderSystemId,
      customer: r.customer,
      phone: r.phone,
      codAmount: r.codAmount,
      carrier: { stage: r.stage, stageLabel: r.stageLabel, rawStatus: r.rawStatus, ageHours: r.lastEventAgeHours, failedAttempts: r.failedAttempts },
      reason: r.bucket,
      reasonLabel: CARE_REASON_LABEL[r.bucket],
      reasonDetail: r.reasonLabel,
      nextAction: BUCKET_BY_KEY[r.bucket].nextAction,
      queueSince: queueSinceOf(r.shipmentId, null),
      lastCareAction: r.lastCsAction ? { label: r.lastCsAction, at: r.lastCsActionAt ?? now, byHuman: r.lastCsActionByHuman } : null,
    });
  }
  for (const w of wrongInfo) {
    push({
      shipmentId: w.shipment_id,
      tracking: w.tracking,
      orderId: w.order_id,
      orderSystemId: w.system_id === null ? null : Number(w.system_id),
      customer: w.customer || "Khách chưa có tên",
      phone: w.phone,
      codAmount: Number(w.cod_amount ?? 0),
      carrier: { stage: w.stage, stageLabel: SHIPMENT_STAGE_LABEL[w.stage as keyof typeof SHIPMENT_STAGE_LABEL] ?? w.stage, rawStatus: w.vtp_status_name || "Chưa có trạng thái", ageHours: w.tuoi_gio === null ? null : Number(w.tuoi_gio), failedAttempts: Number(w.lan_hut ?? 0) },
      reason: "WRONG_INFO",
      reasonLabel: CARE_REASON_LABEL.WRONG_INFO,
      reasonDetail: w.title,
      nextAction: "Xác nhận lại với khách rồi sửa người nhận / địa chỉ trên Viettel Post trước khi bưu tá đi phát.",
      queueSince: new Date(w.opened_at),
      lastCareAction: null,
    });
  }
  for (const d of doneShipments) {
    const c = careMap.get(d.id);
    push({
      shipmentId: d.id,
      tracking: d.tracking,
      orderId: d.orderId,
      orderSystemId: d.systemId === null ? null : Number(d.systemId),
      customer: d.customer || "Khách chưa có tên",
      phone: d.phone,
      codAmount: Number(d.codAmount ?? 0),
      carrier: { stage: d.stage, stageLabel: SHIPMENT_STAGE_LABEL[d.stage] ?? d.stage, rawStatus: d.rawStatus || "—", ageHours: null, failedAttempts: 0 },
      reason: "CARE_TODAY",
      reasonLabel: "Đã rời điều kiện cần care",
      reasonDetail: "Kiện không còn trong điều kiện cần care",
      nextAction: "Không còn việc gì — theo dõi ở Tất cả vận đơn nếu cần.",
      queueSince: c?.createdAt ?? now,
      lastCareAction: null,
    });
  }

  // Cần care: tiền lớn trước, rồi kiện vào hàng đợi lâu nhất. Người làm buổi sáng đi từ trên xuống.
  all.sort((a, b) => b.codAmount - a.codAmount || a.queueSince.getTime() - b.queueSince.getTime());

  const dataGaps = all.filter((c) => c.reasonClass === "DATA_FRESHNESS");
  const cases = all.filter((c) => c.reasonClass !== "DATA_FRESHNESS");

  const counts = { care: 0, waiting: 0, escalated: 0, done: 0 };
  for (const c of cases) counts[c.view] += 1;
  const careCases = cases.filter((c) => c.view === "care");
  const openCases = cases.filter((c) => c.view !== "done");

  const byReasonMap = new Map<CareReasonKey, { count: number; money: number }>();
  for (const c of careCases) {
    const cur = byReasonMap.get(c.reason) ?? { count: 0, money: 0 };
    byReasonMap.set(c.reason, { count: cur.count + 1, money: cur.money + c.codAmount });
  }
  const byOwnerMap = new Map<string, { ownerId: string | null; name: string; open: number; overdue: number; money: number }>();
  for (const c of openCases) {
    const key = c.care.owner?.id ?? "";
    const cur = byOwnerMap.get(key) ?? { ownerId: c.care.owner?.id ?? null, name: c.care.owner?.name ?? "Chưa ai nhận", open: 0, overdue: 0, money: 0 };
    cur.open += 1;
    if (c.sla.firstResponseBreached || c.sla.resolveBreached) cur.overdue += 1;
    cur.money += c.codAmount;
    byOwnerMap.set(key, cur);
  }

  return {
    cases,
    dataGaps,
    counts,
    byReason: [...byReasonMap.entries()].map(([reason, v]) => ({ reason, label: CARE_REASON_LABEL[reason], ...v })).sort((a, b) => b.count - a.count),
    byOwner: [...byOwnerMap.values()].sort((a, b) => b.overdue - a.overdue || b.open - a.open),
    moneyAtRisk: careCases.reduce((a, c) => a + c.codAmount, 0),
    overdue: careCases.filter((c) => c.sla.firstResponseBreached || c.sla.resolveBreached).length,
    unassigned: careCases.filter((c) => !c.care.owner).length,
    measuredAt: now,
  };
}

/** Hàng đợi care — actionable population, đệm 30 giây, mọi hành động ghi đều xoá đệm. */
export async function getCareQueue(): Promise<CareQueue> {
  return memo("care-queue", 30_000, buildQueue);
}

/** Tên cũ, cùng dữ liệu. */
export const getCareWorkbench = getCareQueue;

/** Lịch sử case (chỉ thêm), mới nhất trước. */
export async function getCareEvents(shipmentId: string, limit = 100): Promise<CareEvent[]> {
  const db = await getDb();
  const rows = await db.select().from(schema.careCaseEvents).where(eq(schema.careCaseEvents.shipmentId, shipmentId)).orderBy(desc(schema.careCaseEvents.createdAt)).limit(limit);
  return rows.map((r) => ({
    id: r.id,
    at: r.createdAt,
    actor: r.actorEmail,
    source: r.source as CareEventSource,
    action: r.action as CareEventAction,
    note: r.note,
    previousStatus: (r.previousStatus as CareStatus | null) ?? null,
    nextStatus: (r.nextStatus as CareStatus | null) ?? null,
    previousOwner: r.previousOwner,
    nextOwner: r.nextOwner,
    followUpAt: r.followUpAt,
    sla: (r.sla as CareEvent["sla"]) ?? null,
    payload: r.payload,
  }));
}

/**
 * Toàn bộ bối cảnh một kiện: đơn + khách + lần gửi + hành trình ĐVVC thô + COD + lịch sử care + yêu
 * cầu ĐVVC + năng lực từng hành động. Dùng cho ngăn kéo và cho AI tóm tắt. Không đệm: mở là đọc mới.
 */
export async function getCareCaseDetail(shipmentId: string): Promise<CareCaseDetail | null> {
  const db = await getDb();
  const [qv, s, careRows, events, requests] = await Promise.all([
    getShipmentQuickView(shipmentId),
    db.query.shipments.findFirst({ where: eq(schema.shipments.id, shipmentId), columns: { id: true, carrier: true, stage: true, attemptNo: true, trackingCapability: true, receiverAddress: true, vtpOrderNumber: true, trackingCode: true }, with: { order: { columns: { id: true, systemId: true, totalPriceAfterDiscount: true, prepaid: true, transferMoney: true, cash: true } } } }),
    loadCareRows([shipmentId]),
    getCareEvents(shipmentId),
    db.select().from(schema.carrierActionRequests).where(eq(schema.carrierActionRequests.shipmentId, shipmentId)).orderBy(desc(schema.carrierActionRequests.createdAt)).limit(20),
  ]);
  if (!qv || !s) return null;
  const facts = await loadQueueFacts([shipmentId]);
  const f = facts.get(shipmentId);
  const care = toCareState(careRows.get(shipmentId));
  const queueSince = f?.failedAt ?? f?.lastAt ?? null;
  const tracking = s.vtpOrderNumber ?? s.trackingCode ?? qv.tracking;
  return {
    shipment: {
      id: s.id,
      tracking,
      carrier: s.carrier || "Viettel Post",
      stage: s.stage,
      stageLabel: qv.stageLabel,
      rawStatus: qv.rawStatus,
      codAmount: qv.codAmount,
      receiver: { name: qv.customer, phone: qv.phone, address: qv.address || s.receiverAddress || "" },
      attemptNo: s.attemptNo ?? qv.attemptNo,
      trackingCapability: asTrackingCapability(s.trackingCapability),
    },
    order: s.order ? { id: s.order.id, systemId: s.order.systemId, total: Number(s.order.totalPriceAfterDiscount ?? 0), prepaid: Number(s.order.prepaid ?? 0) + Number(s.order.transferMoney ?? 0) + Number(s.order.cash ?? 0), items: qv.items, chatUrl: qv.chatUrl } : null,
    customer: { name: qv.customer, phone: qv.phone, history: qv.history },
    journey: qv.timeline,
    care,
    queueSince,
    sla: queueSince ? slaOf(queueSince, care) : null,
    events,
    careActions: qv.careActions,
    carrierRequests: requests.map(toRequestView),
    capabilities: carrierCapabilitiesFor({ stage: s.stage, trackingCapability: s.trackingCapability, configured: vtpConfigured(), tracking }),
  };
}

/** Nhãn hành động care gần nhất — dùng chung với ngăn kéo. */
export function careActionLabel(kind: string): string {
  return CARE_ACTION_LABEL[kind as CareActionKind] ?? kind;
}

/** Mẫu note nhanh của shop (bảng settings); chưa ai chỉnh thì dùng bộ mặc định. */
export async function getCareNotePresets(): Promise<CareNotePreset[]> {
  const v = await getSettingJson<{ presets: CareNotePreset[] }>(CARE_NOTE_PRESETS_KEY, { presets: CARE_NOTE_PRESETS_DEFAULT });
  return Array.isArray(v.presets) ? v.presets : CARE_NOTE_PRESETS_DEFAULT;
}

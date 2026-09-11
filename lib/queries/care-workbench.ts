import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo } from "@/lib/cache";
import {
  CARE_BUCKETS,
  CARE_REASON_LABEL,
  CARE_SLA,
  type CareReasonKey,
  type CareStatus,
  type CareView,
  type CarrierActionKey,
  type CarrierRequestStatus,
} from "@/lib/constants/care";
import { CARE_ACTION_LABEL, BUCKET_BY_KEY, type CareActionKind } from "@/lib/constants/delivery-tower";
import { SHIPMENT_STAGE_LABEL } from "@/lib/constants/viettelpost";
import { env } from "@/lib/env";
import { careViewOf, slaOf } from "@/lib/care/view";
import { getDeliveryTower, type TowerRow } from "@/lib/queries/delivery-tower";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ BÀN LÀM VIỆC GIAO VẬN: CASE, KHÔNG PHẢI VẬN ĐƠN ═══════════
 *
 * Mở ra là thấy việc: kiện nào đang cần người, vì sao, phải làm gì, ai đang cầm, tiền nào đang
 * treo. Vận đơn bình thường (đang giao, đã giao, đang hoàn…) KHÔNG xuất hiện — tra ở "Tất cả".
 *
 * Điều kiện cần care lấy từ ĐÚNG các rổ của tháp giao vận (một luật xếp rổ, không viết lại) cộng
 * case CSKH "sai địa chỉ / SĐT" còn mở của đơn đang gửi. Trạng thái care là lớp riêng đè lên: đội
 * đánh dấu tới đâu là chuyện của đội; kiện RỜI hàng đợi khi điều kiện hết, không phải khi đội bấm xong.
 */

export type CareState = {
  status: CareStatus;
  owner: { id: string; name: string } | null;
  followUpAt: Date | null;
  lastNote: string;
  lastNoteAt: Date | null;
  lastNoteBy: string;
  firstResponseAt: Date | null;
  doneAt: Date | null;
  reopenCount: number;
  updatedAt: Date | null;
  updatedBy: string;
};

export type CarrierRequestView = {
  id: string;
  actionKey: CarrierActionKey;
  status: CarrierRequestStatus;
  at: Date;
  error: string | null;
  note: string;
  actor: string;
};

export type CareCase = {
  shipmentId: string;
  tracking: string;
  orderId: string | null;
  orderSystemId: number | null;
  customer: string;
  phone: string;
  codAmount: number;
  carrier: {
    stage: string;
    stageLabel: string;
    rawStatus: string;
    ageHours: number | null;
    failedAttempts: number;
  };
  reason: CareReasonKey;
  reasonLabel: string;
  reasonDetail: string;
  nextAction: string;
  /** Lúc kiện VÀO điều kiện cần care — mốc tính SLA. */
  queueSince: Date;
  sla: { firstResponseDueAt: Date; resolveDueAt: Date; firstResponseBreached: boolean; resolveBreached: boolean };
  care: CareState;
  /** Kiện đã được đóng rồi lại rơi vào điều kiện cần care sau đó. */
  reopened: boolean;
  lastCareAction: { label: string; at: Date; byHuman: boolean } | null;
  carrierRequest: CarrierRequestView | null;
  /** Tài khoản API có quyền trên kiện này không. Không có ⇒ mọi thao tác ĐVVC là PHẢI LÀM TAY. */
  carrierCapability: "API" | "MANUAL";
  view: Exclude<CareView, "all">;
};

export type CareWorkbench = {
  cases: CareCase[];
  counts: Record<Exclude<CareView, "all">, number>;
  /** Tổng COD đang treo ở các kiện Cần care. */
  moneyAtRisk: number;
  overdue: number;
  unassigned: number;
  measuredAt: Date;
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

export { careViewOf, slaOf };

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

async function loadLatestRequests(shipmentIds: string[]): Promise<Map<string, CarrierRequestView>> {
  if (!shipmentIds.length) return new Map();
  const db = await getDb();
  const rows = rowsOf<{ shipment_id: string; id: string; action_key: string; status: string; at: string; error: string | null; note: string; actor_email: string }>(
    await db.execute(sql`
      select distinct on (shipment_id) shipment_id, id, action_key, status, created_at as at, error, note, actor_email
        from carrier_action_requests
       where shipment_id in ${shipmentIds}
       order by shipment_id, created_at desc
    `),
  );
  return new Map(
    rows.map((r) => [
      r.shipment_id,
      { id: r.id, actionKey: r.action_key as CarrierActionKey, status: r.status as CarrierRequestStatus, at: new Date(r.at), error: r.error, note: r.note, actor: r.actor_email },
    ]),
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

function carrierCapabilityOf(capability: string): "API" | "MANUAL" {
  const configured = Boolean(env.viettelPost.apiKey || (env.viettelPost.username && env.viettelPost.password));
  return configured && capability === "API_TRACKABLE" ? "API" : "MANUAL";
}

async function buildWorkbench(): Promise<CareWorkbench> {
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
    .where(and(eq(schema.shipmentCare.careStatus, "DONE"), gte(schema.shipmentCare.doneAt, new Date(now.getTime() - CARE_SLA.doneWindowDays * 86_400_000))))
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

  const cases: CareCase[] = [];
  const push = (base: Omit<CareCase, "care" | "sla" | "view" | "reopened" | "carrierRequest" | "carrierCapability">) => {
    const care = toCareState(careMap.get(base.shipmentId));
    const { view, reopened } = careViewOf(care, base.queueSince, now);
    cases.push({
      ...base,
      care,
      reopened,
      sla: slaOf(base.queueSince, care, now),
      carrierRequest: reqMap.get(base.shipmentId) ?? null,
      carrierCapability: carrierCapabilityOf(facts.get(base.shipmentId)?.capability ?? "UNKNOWN_CAPABILITY"),
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
  cases.sort((a, b) => b.codAmount - a.codAmount || a.queueSince.getTime() - b.queueSince.getTime());

  const counts = { care: 0, waiting: 0, escalated: 0, done: 0 };
  for (const c of cases) counts[c.view] += 1;
  const careCases = cases.filter((c) => c.view === "care");
  return {
    cases,
    counts,
    moneyAtRisk: careCases.reduce((a, c) => a + c.codAmount, 0),
    overdue: careCases.filter((c) => c.sla.firstResponseBreached || c.sla.resolveBreached).length,
    unassigned: careCases.filter((c) => !c.care.owner).length,
    measuredAt: now,
  };
}

export async function getCareWorkbench(): Promise<CareWorkbench> {
  return memo("care-workbench", 30_000, buildWorkbench);
}

/** Nhãn hành động care gần nhất — dùng chung với ngăn kéo. */
export function careActionLabel(kind: string): string {
  return CARE_ACTION_LABEL[kind as CareActionKind] ?? kind;
}

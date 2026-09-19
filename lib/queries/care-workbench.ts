import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo } from "@/lib/cache";
import { carrierCapabilitiesFor } from "@/lib/care/carrier-capabilities";
import type { CareCase, CareCaseDetail, CareEvent, CareQueue, CareState, CarrierRequestView } from "@/lib/care/contracts";
import type { BusinessAction } from "@/lib/constants/care-outcome";
import { careDecisionOf, type CareDecision } from "@/lib/constants/care-resolution";
import { CARRIER_SUBSTATE_LABEL, carrierSubstate, type CarrierSubstate } from "@/lib/constants/carrier-substate";
import { careSlaHours } from "@/lib/care/sla";
import { careViewOf, slaOf } from "@/lib/care/view";
import { CARE_BUCKETS, CARE_REASON_LABEL, CARE_SLA, CARE_TERMINAL_STATUSES, type CareEventAction, type CareEventSource, type CareReasonClass, type CareReasonKey, type CareStatus, type CarrierActionKey, type CarrierRequestStatus } from "@/lib/constants/care";
import { CS_ACTIONABLE_STATUSES, CS_LIFECYCLE_KINDS } from "@/lib/constants/cs-domain";
import { botMessageFailuresByShipment } from "@/lib/queries/cs";
import { BUCKET_BY_KEY, CARE_ACTION_LABEL, type CareActionKind } from "@/lib/constants/delivery-tower";
import { SHIPMENT_STAGE_LABEL } from "@/lib/constants/viettelpost";
import { env } from "@/lib/env";
import { getDeliveryTower, type TowerRow } from "@/lib/queries/delivery-tower";
import { getShipmentQuickView } from "@/lib/queries/shipment-quickview";
import { rowsOf } from "@/lib/sql-rows";
import type { ShipmentStage } from "@/db/schema";

export type { CareCase, CareCaseDetail, CareEvent, CareQueue, CareState, CarrierRequestView } from "@/lib/care/contracts";
export { careViewOf, slaOf } from "@/lib/care/view";
import { CARE_NOTE_PRESETS_DEFAULT, CARE_NOTE_PRESETS_KEY, type CareNotePreset } from "@/lib/constants/care";
import { CARE_DECISIONS, RESOLUTION_NOTES_DEFAULT, RESOLUTION_NOTES_KEY, RESOLUTION_NOTES_MAX } from "@/lib/constants/care-resolution";
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
  // Việc nằm ở phía ĐVVC: shop gọi bưu cục, không gọi khách.
  WAITING_CARRIER: "CARRIER_ACTION",
  // ĐVVC chưa tới lấy ⇒ việc nằm ở phía đối tác vận chuyển, không phải phía khách.
  AWAITING_PICKUP: "CARRIER_ACTION",
  WRONG_INFO: "CUSTOMER_ACTION",
  STALE_NO_UPDATE: "DATA_FRESHNESS",
  DATA_GAP: "DATA_FRESHNESS",
  RETURNING: "CARRIER_ACTION",
  RETURN_AT_SHOP: "CARRIER_ACTION",
  /*
    Lớp này chỉ quyết định dòng đi vào `cases` (lịch sử đọc được) hay `dataGaps` (thiếu dữ liệu
    ĐVVC). Kiện đã rời điều kiện care KHÔNG thiếu dữ liệu — nó chỉ hết việc — nên nó thuộc `cases`.
  */
  LEFT_CARE_CONDITION: "CUSTOMER_ACTION",
};

const EMPTY_CARE: CareState = { status: "NEW", owner: null, followUpAt: null, lastNote: "", lastNoteAt: null, lastNoteBy: "", firstResponseAt: null, doneAt: null, reopenCount: 0, updatedAt: null, updatedBy: "", lastDecision: null };

type CareRow = typeof schema.shipmentCare.$inferSelect & { ownerName: string | null };

function toCareState(r: CareRow | undefined, decision: LastDecision | null = null): CareState {
  if (!r) return EMPTY_CARE;
  return {
    lastDecision: decision,
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

export type LastDecision = NonNullable<CareState["lastDecision"]>;

/**
 * ═══════════ KẾT QUẢ XỬ LÝ ĐỌC RA, KHÔNG LƯU SONG SONG ═══════════
 *
 * Quyết định gần nhất của MỖI ĐỢT, lấy thẳng từ sổ chỉ-thêm `care_business_actions`. Không có cột
 * `resolution_action` nào trên `shipment_care`, cố ý: một cột thứ hai giữ cùng một sự thật là tự
 * nhận lấy câu hỏi *"hai chỗ lệch nhau thì tin chỗ nào"* — và mọi đường ghi sau này (AI, job, thao
 * tác hàng loạt) đều phải nhớ cập nhật cả hai, lần quên đầu tiên thì màn hình nói sai mà không ai
 * biết.
 *
 * Khoá theo `care_case_id` (ĐỢT), không theo `shipment_id`: kiện hỏng lần hai là một đợt mới, và
 * quyết định của đợt trước KHÔNG được hiện lên như thể vừa mới bấm.
 *
 * Tên người ĐỌC TỪ `users` ở máy chủ (luật 34): cột email trong sổ là ảnh chụp, còn tên hiển thị
 * phải theo tài khoản hiện tại.
 */
async function loadDecisions(careCaseIds: string[]): Promise<Map<string, LastDecision>> {
  if (!careCaseIds.length) return new Map();
  const db = await getDb();
  const rows = rowsOf<{ care_case_id: string; decision: string; at: string; by: string | null; actor_email: string; reason_code: string | null; note: string }>(
    await db.execute(sql`
      select distinct on (d.care_case_id)
             d.care_case_id, d.decision, d.decided_at as at,
             u.name as by, d.actor_email, d.reason_code, d.note
        from care_decisions d
        left join users u on u.id = d.actor_user_id
       where d.care_case_id in ${careCaseIds}
       order by d.care_case_id, d.decided_at desc, d.created_at desc
    `),
  );
  const m = new Map<string, LastDecision>();
  for (const r of rows) {
    // Chuỗi lạ (dữ liệu cũ / một bản vá sai) ⇒ BỎ QUA, không ép vào một trong ba rổ.
    const kq = careDecisionOf(r.decision);
    if (kq) m.set(r.care_case_id, { decision: kq, at: new Date(r.at), by: r.by || r.actor_email || "", reasonCode: r.reason_code, note: r.note ?? "" });
  }
  return m;
}

async function loadCareRows(shipmentIds: string[]): Promise<Map<string, CareRow>> {
  if (!shipmentIds.length) return new Map();
  const db = await getDb();
  const rows = await db
    .select({ care: schema.shipmentCare, ownerName: schema.users.name })
    .from(schema.shipmentCare)
    .leftJoin(schema.users, eq(schema.users.id, schema.shipmentCare.ownerId))
    // CHỈ ĐỢT ĐANG MỞ. Map khoá theo `shipmentId` nên nếu lấy cả đợt đã đóng thì đợt nào ghi sau
    // sẽ thắng — và màn hình hiện trạng thái của một đợt kết thúc từ tháng trước.
    .where(and(inArray(schema.shipmentCare.shipmentId, shipmentIds), eq(schema.shipmentCare.active, true)));
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
async function loadQueueFacts(shipmentIds: string[]): Promise<Map<string, { failedAt: Date | null; lastAt: Date | null; createdAt: Date; capability: string; vtpOrderNumber: string | null; failedAttempts: number }>> {
  if (!shipmentIds.length) return new Map();
  const db = await getDb();
  const rows = rowsOf<{ id: string; failed_at: string | null; last_at: string | null; created_at: string; capability: string; vtp_order_number: string | null; failed_attempts: number }>(
    await db.execute(sql`
      select s.id,
             s.created_at,
             s.tracking_capability as capability,
             nullif(s.vtp_order_number, '') as vtp_order_number,
             (select max(e.occurred_at) from shipment_events e where e.shipment_id = s.id and e.normalized_stage = 'DELIVERY_FAILED') as failed_at,
             (select max(e.occurred_at) from shipment_events e where e.shipment_id = s.id) as last_at,
             /*
               SỐ LẦN PHÁT HỤT — MỘT phép đếm cho cả hàng đợi, và là ĐÚNG phép đếm mà panel chi tiết
               dùng (lib/queries/shipment-quickview.ts). Trước bản 19/09/2026 mỗi nguồn dòng tự
               mang một con số: tháp giao vận đếm thật, case sai thông tin đếm thật, còn nhánh kiện
               đã rời điều kiện care ghi thẳng 0. Đo production cùng ngày: vận đơn 474b6367 (Đang
               chuyển hoàn) có 4 lần hụt trong shipment_events nhưng bảng xếp nó vào rổ "Chưa hụt
               lần nào" — kiện hỏng nhiều nhất lại trông sạch nhất, đúng lúc nó đang chuyển hoàn.

               Đếm theo CHẶNG ĐÃ CHUẨN HOÁ, không dò chữ: ĐVVC đổi một chữ là phép dò chữ lặng lẽ
               trả về 0.
             */
             (select count(*) from shipment_events e where e.shipment_id = s.id and e.normalized_stage = 'DELIVERY_FAILED')::int as failed_attempts
        from shipments s
       where s.id in ${shipmentIds}
    `),
  );
  return new Map(rows.map((r) => [r.id, { failedAt: r.failed_at ? new Date(r.failed_at) : null, lastAt: r.last_at ? new Date(r.last_at) : null, createdAt: new Date(r.created_at), capability: r.capability, vtpOrderNumber: r.vtp_order_number, failedAttempts: Number(r.failed_attempts ?? 0) }]));
}

/**
 * MẶT HÀNG TRONG TỪNG KIỆN — mã hàng, tên hàng, mô tả mẫu mã — cho bộ lọc "kiện nào chứa mẫu này".
 *
 * MỘT truy vấn cho cả hàng đợi, không một câu cho mỗi dòng. Kiện chưa ghép được với đơn (vận đơn
 * nhập từ tài khoản ĐVVC, vận đơn chiều hoàn) không có dòng `order_items` nào nên danh sách rỗng:
 * đó là CHƯA BIẾT bên trong có gì, nên bộ lọc mã hàng cố ý KHÔNG nhận chúng — nhận vào là nói với
 * người dùng "kiện này chứa mẫu anh tìm" bằng một thứ chưa ai đọc được.
 */
async function loadProducts(shipmentIds: string[]): Promise<Map<string, string[]>> {
  if (!shipmentIds.length) return new Map();
  const db = await getDb();
  const rows = rowsOf<{ shipment_id: string; nhan: string[] | null }>(
    await db.execute(sql`
      select s.id as shipment_id,
             array_agg(distinct x.nhan) filter (where x.nhan <> '') as nhan
        from shipments s
        join order_items oi on oi.order_id = s.order_id
        cross join lateral (values (oi.sku), (oi.product_name), (oi.variation_detail)) as x(nhan)
       where s.id in ${shipmentIds}
       group by s.id
    `),
  );
  return new Map(rows.map((r) => [r.shipment_id, r.nhan ?? []]));
}

type WrongInfoRow = { shipment_id: string; tracking: string; order_id: string; system_id: number | null; customer: string; phone: string; cod_amount: string | number; stage: string; vtp_status_name: string | null; kind: string; title: string; opened_at: string; tuoi_gio: string | number | null; lan_hut: number };

/**
 * Case CSKH sai địa chỉ / SĐT còn phải làm, gắn với lần gửi ĐANG CHẠY của đơn ⇒ kiện cần sửa thông
 * tin, và care vận đơn là chủ sở hữu của nó.
 *
 * Loại case và tập trạng thái lấy thẳng từ `lib/constants/cs-domain.ts` — đúng bộ mà trang CSKH
 * dùng để LOẠI chúng khỏi hàng đợi của mình. Gõ lại `'WRONG_ADDRESS', 'WRONG_PHONE'` ở đây là mở
 * đường cho hai bên lệch nhau: một loại case mới được thêm vào luật phân miền sẽ biến mất khỏi CSKH
 * mà không xuất hiện ở đây, và việc đó không còn ai làm.
 *
 * `IN_PROGRESS` cũng phải nằm trong tập: người bấm "Đang xử lý" trên một case sai địa chỉ không làm
 * kiện hàng hết cần sửa — bỏ trạng thái đó ra thì case tự bốc hơi khỏi cả hai bàn làm việc.
 */
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
       where c.status in ${CS_ACTIONABLE_STATUSES} and c.kind in ${CS_LIFECYCLE_KINDS}
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

/** Trạng thái con của ĐVVC cho một dòng care — mã trước, chữ sau, chặng chỉ là lưới an toàn cuối. */
function substateOf(c: { stage: string; vtpStatus?: number | null; rawStatus: string }): { substate: CarrierSubstate; substateLabel: string } {
  const { substate } = carrierSubstate({ code: c.vtpStatus ?? null, text: c.rawStatus, stage: c.stage as ShipmentStage });
  return { substate, substateLabel: CARRIER_SUBSTATE_LABEL[substate] };
}
function asTrackingCapability(v: string | undefined): TrackingCapability {
  return v === "API_TRACKABLE" || v === "WEBHOOK_ONLY" ? v : "UNKNOWN_CAPABILITY";
}

async function buildQueue(): Promise<CareQueue> {
  const now = new Date();
  // Ngưỡng SLA đọc qua sổ hạn xử lý (luật 22) — chủ shop đổi ở cấu hình, không phải đổi mã.
  const slaHours = await careSlaHours();
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
    .where(and(eq(schema.shipmentCare.active, false), inArray(schema.shipmentCare.careStatus, CARE_TERMINAL_STATUSES), gte(schema.shipmentCare.doneAt, new Date(now.getTime() - CARE_SLA.doneWindowDays * 86_400_000))))
    .orderBy(desc(schema.shipmentCare.doneAt))
    .limit(300);
  const doneOnlyIds = doneRows.map((r) => r.care.shipmentId).filter((id) => !towerIds.has(id) && !wrongInfo.some((w) => w.shipment_id === id));

  const allIds = [...towerIds, ...wrongInfo.map((w) => w.shipment_id), ...doneOnlyIds];
  const [careMap, reqMap, facts, productMap, doneShipments] = await Promise.all([
    loadCareRows(allIds),
    loadLatestRequests(allIds),
    loadQueueFacts(allIds),
    loadProducts(allIds),
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
            vtpStatus: schema.shipments.vtpStatus,
            rawStatus: schema.shipments.vtpStatusName,
            pickedUpAt: schema.shipments.pickedUpAt,
          })
          .from(schema.shipments)
          .leftJoin(schema.orders, eq(schema.orders.id, schema.shipments.orderId))
          .where(inArray(schema.shipments.id, doneOnlyIds))
      : Promise.resolve([]),
  ]);
  // ĐỢT ĐANG MỞ THẮNG ĐỢT ĐÃ ĐÓNG. Kiện vừa hỏng lại (đợt 2 đang mở) mà đợt 1 đóng trong 7 ngày:
  // ghi đè bằng đợt 1 là màn hình hiện "Đã xong" cho một kiện đang cần người.
  for (const r of doneRows) if (!careMap.has(r.care.shipmentId)) careMap.set(r.care.shipmentId, { ...r.care, ownerName: r.ownerName });

  // Quyết định gần nhất của ĐÚNG đợt đang hiển thị — một truy vấn cho cả hàng đợi, không một câu
  // cho mỗi dòng. Đợt nào không có quyết định nào thì `lastDecision = null` (CHƯA AI QUYẾT).
  const decisionMap = await loadDecisions([...careMap.values()].map((c) => c.id));

  /*
    MỐC VÀO HÀNG ĐỢI: `opened_at` của đợt (lúc ĐVVC báo sự cố mở đợt này) khi có; đợt cũ chưa có mốc
    thì suy từ lần giao hụt gần nhất → tin cuối. Cùng thứ tự với `lib/care/service.ts::queueSinceOf`
    để SLA trên màn hình và SLA chụp vào sự kiện là một con số.
  */
  const queueSinceOf = (id: string, fallback: Date | null) => {
    const c = careMap.get(id);
    if (c?.active && c.openedAt) return c.openedAt;
    const f = facts.get(id);
    return f?.failedAt ?? f?.lastAt ?? fallback ?? f?.createdAt ?? now;
  };

  const all: CareCase[] = [];
  const push = (
    base: Omit<CareCase, "care" | "sla" | "view" | "reopened" | "carrierRequest" | "carrierCapability" | "reasonClass" | "carrier" | "products" | "vtpOrderNumber"> & {
      carrier: Omit<CareCase["carrier"], "trackingCapability" | "substate" | "substateLabel">;
      /*
        ═══ TƯ CÁCH HÀNG ĐỢI ĐI THEO ĐIỀU KIỆN CARE, KHÔNG THEO CỜ `active` CỦA ĐỢT ═══

        `false` = kiện KHÔNG còn trong điều kiện cần care (không thuộc rổ nào của tháp giao vận,
        không có case sai thông tin còn mở), dòng chỉ ở đây để tra lại lịch sử.

        Vì sao cần cờ này: `careViewOf` chỉ nhìn TRẠNG THÁI của đợt care. Một kiện đã chuyển hoàn
        mà đợt care còn mở ở `ASSIGNED` sẽ được xếp vào góc nhìn "Cần care" — và dòng đó in ra
        "Đã rời điều kiện cần care · Nên: Không còn việc gì" trong khi vẫn cộng vào tổng kiện, vào
        COD treo và vào số vỡ SLA đang chạy. Đo production 19/09/2026: 8 vận đơn như vậy, trong đó
        474b6367 (Đang chuyển hoàn) và db48a154 (Chờ xử lý) mang đợt `ASSIGNED`/`WAITING_CARRIER`
        còn mở. Hàng đợi này là ACTIONABLE POPULATION (xem đầu tệp) — kiện RỜI khi điều kiện hết,
        không phải khi đội bấm xong, và cũng không phải "ở lại vì chưa ai bấm xong".
      */
      inCareCondition: boolean;
    },
  ) => {
    const dot = careMap.get(base.shipmentId);
    const care = toCareState(dot, dot ? (decisionMap.get(dot.id) ?? null) : null);
    const { view, reopened } = base.inCareCondition ? careViewOf(care, base.queueSince, now) : { view: "done" as const, reopened: false };
    const fact = facts.get(base.shipmentId);
    const capability = fact?.capability;
    all.push({
      ...base,
      /*
        MÃ VIETTEL POST lấy từ ĐÚNG LƯỢT ĐỌC `shipments` đã chạy cho cả hàng đợi, nên ba nguồn dòng
        (tháp giao vận, case sai thông tin, kiện đã đóng) không thể nói ba con số khác nhau — và
        không tốn thêm một truy vấn nào. Cần riêng vì `tracking` đã bị `coalesce` sang mã Pancake /
        id ERP: liên kết tra cứu ĐVVC chỉ được dựng từ cột này.
      */
      vtpOrderNumber: facts.get(base.shipmentId)?.vtpOrderNumber ?? null,
      // TRẠNG THÁI CON TÍNH Ở ĐÚNG MỘT CHỖ — mọi nguồn dòng (tháp, case sai thông tin, kiện đã
      // đóng) đi qua đây, nên không nguồn nào có thể dùng một luật khác.
      carrier: {
        ...base.carrier,
        // SỐ LẦN PHÁT HỤT CHUẨN — cùng một phép đếm cho mọi nguồn dòng và cho cả panel chi tiết.
        // Nguồn dòng chỉ còn là nơi lấy các cột khác; nó không được phép nói một con số riêng.
        failedAttempts: fact?.failedAttempts ?? base.carrier.failedAttempts,
        ...substateOf(base.carrier),
        trackingCapability: asTrackingCapability(capability),
      },
      products: productMap.get(base.shipmentId) ?? [],
      reasonClass: REASON_CLASS[base.reason],
      care,
      reopened,
      sla: slaOf(base.queueSince, care, now, slaHours),
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
      carrier: { stage: r.stage, stageLabel: r.stageLabel, vtpStatus: r.rawStatusCode, rawStatus: r.rawStatus, ageHours: r.lastEventAgeHours, failedAttempts: r.failedAttempts, leftWarehouse: r.leftWarehouse },
      reason: r.bucket,
      reasonLabel: CARE_REASON_LABEL[r.bucket],
      reasonDetail: r.reasonLabel,
      nextAction: BUCKET_BY_KEY[r.bucket].nextAction,
      queueSince: queueSinceOf(r.shipmentId, null),
      inCareCondition: true,
      lastCareAction: r.lastCsAction ? { label: r.lastCsAction, at: r.lastCsActionAt ?? now, byHuman: r.lastCsActionByHuman } : null,
      botMessageFailure: null,
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
      carrier: { stage: w.stage, stageLabel: SHIPMENT_STAGE_LABEL[w.stage as keyof typeof SHIPMENT_STAGE_LABEL] ?? w.stage, vtpStatus: null, rawStatus: w.vtp_status_name || "Chưa có trạng thái", ageHours: w.tuoi_gio === null ? null : Number(w.tuoi_gio), failedAttempts: Number(w.lan_hut ?? 0), leftWarehouse: false },
      reason: "WRONG_INFO",
      reasonLabel: CARE_REASON_LABEL.WRONG_INFO,
      reasonDetail: w.title,
      nextAction: "Xác nhận lại với khách rồi sửa người nhận / địa chỉ trên Viettel Post trước khi bưu tá đi phát.",
      queueSince: new Date(w.opened_at),
      inCareCondition: true,
      lastCareAction: null,
      botMessageFailure: null,
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
      carrier: {
        stage: d.stage,
        stageLabel: SHIPMENT_STAGE_LABEL[d.stage] ?? d.stage,
        vtpStatus: d.vtpStatus,
        rawStatus: d.rawStatus || "—",
        // Tuổi tin cũng đọc từ `facts` như mọi nguồn dòng khác — `null` ở đây từng là "chưa có tin"
        // cho một kiện đã đi hết hành trình.
        ageHours: facts.get(d.id)?.lastAt ? (now.getTime() - facts.get(d.id)!.lastAt!.getTime()) / 3_600_000 : null,
        failedAttempts: 0,
        leftWarehouse: d.pickedUpAt !== null,
      },
      reason: "LEFT_CARE_CONDITION",
      reasonLabel: CARE_REASON_LABEL.LEFT_CARE_CONDITION,
      reasonDetail: "Kiện không còn trong điều kiện cần care",
      nextAction: "Không còn việc gì — theo dõi ở Tất cả vận đơn nếu cần.",
      queueSince: c?.createdAt ?? now,
      inCareCondition: false,
      lastCareAction: null,
      botMessageFailure: null,
    });
  }

  // Cần care: tiền lớn trước, rồi kiện vào hàng đợi lâu nhất. Người làm buổi sáng đi từ trên xuống.
  all.sort((a, b) => b.codAmount - a.codAmount || a.queueSince.getTime() - b.queueSince.getTime());

  // Bot không nhắn được khách: gắn vào đúng kiện, KHÔNG sinh dòng việc mới (cùng grain kiện).
  const botFail = await botMessageFailuresByShipment(all.map((c) => c.shipmentId));
  for (const c of all) {
    const f = botFail.get(c.shipmentId);
    c.botMessageFailure = f ? { caseId: f.caseId, title: f.title, detail: f.detail, at: f.createdAt } : null;
  }

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
    // Ngưỡng đang hiệu lực đi cùng dữ liệu: trình duyệt vá lại SLA sau mỗi thao tác bằng ĐÚNG bộ số
    // máy chủ vừa dùng, không phải bằng mặc định dựng sẵn.
    slaHours,
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
    db.query.shipments.findFirst({ where: eq(schema.shipments.id, shipmentId), columns: { id: true, carrier: true, stage: true, attemptNo: true, trackingCapability: true, receiverAddress: true, vtpOrderNumber: true, trackingCode: true, vtpStatus: true, vtpStatusName: true }, with: { order: { columns: { id: true, systemId: true, totalPrice: true, totalPriceAfterDiscount: true, totalDiscount: true, shippingFee: true, prepaid: true, transferMoney: true, cash: true } } } }),
    loadCareRows([shipmentId]),
    getCareEvents(shipmentId),
    db.select().from(schema.carrierActionRequests).where(eq(schema.carrierActionRequests.shipmentId, shipmentId)).orderBy(desc(schema.carrierActionRequests.createdAt)).limit(20),
  ]);
  if (!qv || !s) return null;
  const facts = await loadQueueFacts([shipmentId]);
  const f = facts.get(shipmentId);
  const dot = careRows.get(shipmentId);
  /*
    NHẬT KÝ QUYẾT ĐỊNH LẤY THEO KIỆN, KHÔNG THEO ĐỢT.

    Panel chi tiết phải đọc được cả câu chuyện: "lần hỏng trước đội đã duyệt hoàn, lần này lại phát
    tiếp" là thông tin, và cắt nó theo đợt đang mở sẽ giấu mất. Còn Ô KẾT QUẢ HIỆN TẠI thì chỉ lấy
    quyết định của ĐÚNG đợt đang mở (`decisionMap`) — hai câu hỏi khác nhau, hai phép đọc khác nhau.
  */
  const [decisionMap, decisionRows, carrierDecisionRows] = await Promise.all([
    dot ? loadDecisions([dot.id]) : Promise.resolve(new Map<string, LastDecision>()),
    db
      .select({ d: schema.careDecisions, actorName: schema.users.name })
      .from(schema.careDecisions)
      .leftJoin(schema.users, eq(schema.users.id, schema.careDecisions.actorUserId))
      .where(eq(schema.careDecisions.shipmentId, shipmentId))
      .orderBy(desc(schema.careDecisions.decidedAt))
      .limit(50),
    db
      .select({ b: schema.careBusinessActions, actorName: schema.users.name })
      .from(schema.careBusinessActions)
      .leftJoin(schema.users, eq(schema.users.id, schema.careBusinessActions.actorUserId))
      .where(eq(schema.careBusinessActions.shipmentId, shipmentId))
      .orderBy(desc(schema.careBusinessActions.requestedAt))
      .limit(50),
  ]);
  const care = toCareState(dot, dot ? (decisionMap.get(dot.id) ?? null) : null);
  const queueSince = (dot?.active ? dot.openedAt : null) ?? f?.failedAt ?? f?.lastAt ?? null;
  const slaHours = await careSlaHours();
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
      // Chỉ cột này dựng được liên kết viettelpost.vn — `tracking` ở trên có thể là mã Pancake.
      vtpOrderNumber: s.vtpOrderNumber?.trim() ? s.vtpOrderNumber.trim() : null,
      ...substateOf({ stage: s.stage, vtpStatus: s.vtpStatus, rawStatus: s.vtpStatusName ?? qv.rawStatus }),
      failedAttempts: qv.failedAttempts,
      ageHours: f?.lastAt ? (new Date().getTime() - f.lastAt.getTime()) / 3_600_000 : null,
      vtpStatus: s.vtpStatus ?? null,
      carrierConfigured: vtpConfigured(),
    },
    order: s.order
      ? {
          id: s.order.id,
          systemId: s.order.systemId,
          total: Number(s.order.totalPriceAfterDiscount ?? 0),
          prepaid: Number(s.order.prepaid ?? 0) + Number(s.order.transferMoney ?? 0) + Number(s.order.cash ?? 0),
          /*
            CHƯA BIẾT ≠ 0 (luật 42). Đơn nhập từ tài khoản ĐVVC không có ba cột này; in "0 ₫" ở đó
            là khẳng định shop không giảm giá đồng nào và khách không trả phí ship — cả hai đều là
            điều chưa ai chứng minh. `null` để màn hình bỏ dòng ấy ra khỏi phép cộng.
          */
          subtotal: s.order.totalPrice === null || s.order.totalPrice === undefined ? null : Number(s.order.totalPrice),
          discount: s.order.totalDiscount === null || s.order.totalDiscount === undefined ? null : Number(s.order.totalDiscount),
          shippingFee: s.order.shippingFee === null || s.order.shippingFee === undefined ? null : Number(s.order.shippingFee),
          items: qv.items,
          itemsTruncated: qv.itemsTruncated,
          chatUrl: qv.chatUrl,
        }
      : null,
    customer: { name: qv.customer, phone: qv.phone, history: qv.history },
    journey: qv.timeline,
    care,
    queueSince,
    sla: queueSince ? slaOf(queueSince, care, new Date(), slaHours) : null,
    events,
    careActions: qv.careActions,
    // KẾT QUẢ XỬ LÝ của người — chuỗi lạ bị LOẠI khỏi danh sách chứ không hiện thành một nhãn đoán.
    decisions: decisionRows.flatMap(({ d, actorName }) => {
      const kq = careDecisionOf(d.decision);
      return kq
        ? [{
            id: d.id,
            at: d.decidedAt,
            actor: actorName || d.actorEmail || "không rõ người",
            decision: kq,
            reasonCode: d.reasonCode,
            note: d.note,
            previousCareStatus: d.previousCareStatus,
            nextCareStatus: d.nextCareStatus,
            followUpAt: d.followUpAt,
            carrierStageAtDecision: d.carrierStageAtDecision,
            carrierSubstateAtDecision: d.carrierSubstateAtDecision,
          }]
        : [];
    }),
    // LỆNH GỬI ĐVVC — sổ riêng, nghĩa riêng: đây là thứ đã (hoặc chưa) đi tới Viettel Post.
    carrierDecisions: carrierDecisionRows.map(({ b, actorName }) => ({
      id: b.id,
      at: b.requestedAt,
      actor: actorName || b.actorEmail || "không rõ người",
      action: b.actionType as BusinessAction,
      reasonCode: b.reasonCode,
      note: b.reasonNote,
      carrierResult: b.carrierResult,
    })),
    carrierRequests: requests.map(toRequestView),
    // Địa chỉ "làm tay trên web" dựng từ MÃ VIETTEL POST, không phải `tracking` (có thể là mã Pancake).
    capabilities: carrierCapabilitiesFor({ stage: s.stage, trackingCapability: s.trackingCapability, configured: vtpConfigured(), vtpOrderNumber: s.vtpOrderNumber }),
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

/**
 * MẪU NOTE THEO TỪNG KẾT QUẢ XỬ LÝ (`care.resolutionNotes`).
 *
 * Chưa ai chỉnh ⇒ dùng bộ mặc định. Chỉnh rồi ⇒ đọc ĐÚNG bộ đã lưu, KHÔNG trộn với mặc định: trộn
 * là chủ shop xoá một mẫu xong thấy nó quay lại, và không có cách nào xoá được nữa.
 *
 * Kết quả nào không có trong bản đã lưu thì rơi về mặc định của CHÍNH nó — một bản lưu chỉ khai
 * "Đã hoàn" không được làm hai kết quả kia mất sạch mẫu.
 */
export async function getResolutionNotePresets(): Promise<Record<CareDecision, string[]>> {
  const v = await getSettingJson<Partial<Record<CareDecision, string[]>>>(RESOLUTION_NOTES_KEY, {});
  const out = {} as Record<CareDecision, string[]>;
  for (const k of CARE_DECISIONS) {
    const list = v?.[k];
    out[k] = Array.isArray(list) ? list.filter((x) => typeof x === "string" && x.trim()).slice(0, RESOLUTION_NOTES_MAX) : RESOLUTION_NOTES_DEFAULT[k];
  }
  return out;
}

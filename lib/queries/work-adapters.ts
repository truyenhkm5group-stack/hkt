import { and, eq, gte, inArray, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ageLabel, caseScore, priorityOf, slaFor, type CaseType } from "@/lib/constants/action-queue";
import { CS_STATUSES, type CsStatus } from "@/lib/constants/cs";
import { csDomainOf } from "@/lib/constants/cs-domain";
import { departmentOfTeam, type DepartmentCode } from "@/lib/constants/departments";
import { actionsOf, ALERT_STATUS_TO_WORK, CARE_STATUS_TO_WORK, CS_STATUS_TO_WORK, WORK_SOURCE_SPEC, type WorkSource } from "@/lib/constants/work-sources";
import { MONEY_UNKNOWN, workKey, type WorkItem, type WorkMoney, type WorkPriority, type WorkStatus } from "@/lib/constants/work";
import { getActionQueue } from "@/lib/queries/action-queue";
import { ADS_ACTION_LABEL } from "@/lib/constants/ads-decision";
import { getAdsDecision } from "@/lib/queries/ads-decision";
import { getCareQueue } from "@/lib/queries/care-workbench";
import { getFulfillmentBottleneckQueue } from "@/lib/queries/fulfillment-bottleneck";
import { unclassifiedBankRows } from "@/lib/queries/finance-ops";
import { resolvePeriod } from "@/lib/search-params";

/**
 * ═══════════════ PHÉP CHIẾU: SÁU HÀNG ĐỢI THÀNH MỘT DANH SÁCH ═══════════════
 *
 * Đặc tả: `docs/work-management-os.md`. Đọc mục 1 trước khi sửa bất cứ hàm nào ở đây.
 *
 * ─── TỆP NÀY KHÔNG CHỨA LUẬT NGHIỆP VỤ NÀO ───
 *
 * Mỗi adapter GỌI LẠI đúng truy vấn mà trang chuyên biệt đang dùng — `getCareQueue()`,
 * `getActionQueue()`, `getFulfillmentBottleneckQueue()`, `unclassifiedBankRows()`,
 * `getAdsDecision()`, và `cs_cases` với đúng điều kiện miền của `lib/constants/cs-domain.ts`.
 * Không adapter nào viết lại một điều kiện `stage`, một ngưỡng tiền hay một công thức SLA.
 *
 * Nếu một adapter ở đây bắt đầu chứa luật riêng thì hai màn hình sẽ nói hai con số khác nhau về
 * cùng một việc, và không ai biết bên nào đúng. Việc duy nhất tệp này làm là ĐỔI HÌNH DẠNG.
 *
 * ─── VÌ SAO KHÔNG CÓ BẢNG TRUNG GIAN ───
 *
 * Không job nào chép việc vào `work_items`, nên không có độ trễ đồng bộ và không có trạng thái mồ
 * côi. Việc được đóng ở trang CSKH thì lần mở hàng đợi sau nó đã biến mất — không phải vì có ai
 * đóng hộ, mà vì nó không còn nằm trong tập nguồn nữa.
 */

/* ═══════════════════ CHỐNG ĐẾM HAI LẦN GIỮA CÁC NGUỒN ═══════════════════ */

/**
 * Loại cảnh báo được nguồn CHUYÊN BIỆT sở hữu — bỏ khỏi nguồn `ALERT` để một sự việc không sinh
 * hai dòng. Đây là danh sách duy nhất; thêm một nguồn chuyên biệt thì thêm vào đây.
 *
 * Luật gộp: **cùng một gốc Ở CÙNG MỘT ĐỘ MỊN** thì mới là trùng.
 *
 * `ADS_ANOMALY` CỐ Ý không nằm trong danh sách dù đã có nguồn `ADS_DECISION`: cảnh báo đó nói về
 * chi tiêu TOÀN SHOP so với doanh thu, còn `ADS_DECISION` nói về từng chiến dịch. Chi toàn shop
 * có thể bất thường mà không chiến dịch nào riêng lẻ vượt ngưỡng — bỏ nó đi là mất đúng tín hiệu
 * mức tổng.
 */
export const ALERT_KINDS_OWNED_ELSEWHERE: CaseType[] = [
  // `cs_cases` là nguồn — cùng độ mịn (một case).
  "CS_CASE",
  "CS_BACKLOG",
  // `shipment_care` là nguồn — cùng độ mịn (một kiện hàng).
  "DELIVERY_FAILED",
  "DELIVERY_STALE",
  "RETURNING",
  // `getFulfillmentBottleneckQueue` là nguồn — cùng độ mịn (một đơn đứng trước lúc gửi).
  "ORDER_CONFIRMATION_STALE",
];

/** Cảnh báo được ĐỔI TÊN NGUỒN (không bỏ): cùng bảng `notifications`, nhưng phòng ban và SLA khác. */
export const ALERT_KIND_TO_SOURCE: Partial<Record<CaseType, WorkSource>> = {
  COD_OVERDUE: "COD_EXCEPTION",
  LOW_STOCK_RISK: "INVENTORY_EXCEPTION",
  STOCKOUT_RISK: "INVENTORY_EXCEPTION",
  RETURN_RECEIVED_PENDING_INSPECTION: "RETURN_INSPECTION",
};

/* ═══════════════════ LỚP GHI CHÚ (overlay) ═══════════════════ */

/**
 * Dòng `work_items` của một việc CHIẾU. Chỉ giữ thứ miền nghiệp vụ không có.
 *
 * `blockedReason` là chỗ duy nhất lớp công việc được đổi trạng thái HIỂN THỊ của một việc chiếu:
 * có lý do chặn ⇒ hiện `BLOCKED`. Trạng thái THẬT vẫn nằm ở nguồn và không bị ghi đè — đó là lý do
 * ràng buộc `work_items_authority_check` bắt cột `status` phải `NULL` với dòng chiếu.
 */
export type WorkOverlay = {
  id: string;
  assignee: { id: string; email: string; name: string } | null;
  ownerId: string | null;
  departmentCode: DepartmentCode | null;
  priority: WorkPriority | null;
  dueAt: Date | null;
  snoozedUntil: Date | null;
  blockedReason: string;
  startedAt: Date | null;
};

export async function loadOverlays(keys: string[]): Promise<Map<string, WorkOverlay>> {
  const out = new Map<string, WorkOverlay>();
  if (!keys.length) return out;
  const db = await getDb();
  const w = schema.workItems;
  const pairs = keys.map((k) => {
    const i = k.indexOf(":");
    return { sourceType: k.slice(0, i), sourceKey: k.slice(i + 1) };
  });
  const bySource = new Map<string, string[]>();
  for (const p of pairs) bySource.set(p.sourceType, [...(bySource.get(p.sourceType) ?? []), p.sourceKey]);
  const conds = [...bySource.entries()].map(([st, sks]) => and(eq(w.sourceType, st), inArray(w.sourceKey, sks))!);
  if (!conds.length) return out;
  const rows = await db
    .select({
      id: w.id,
      sourceType: w.sourceType,
      sourceKey: w.sourceKey,
      assigneeId: w.assigneeId,
      assigneeEmail: schema.users.email,
      assigneeName: schema.users.name,
      ownerId: w.ownerId,
      departmentCode: schema.departments.code,
      priority: w.priority,
      dueAt: w.dueAt,
      snoozedUntil: w.snoozedUntil,
      blockedReason: w.blockedReason,
      startedAt: w.startedAt,
    })
    .from(w)
    .leftJoin(schema.users, eq(schema.users.id, w.assigneeId))
    .leftJoin(schema.departments, eq(schema.departments.id, w.departmentId))
    .where(conds.length === 1 ? conds[0] : or(...conds));
  for (const r of rows) {
    out.set(workKey(r.sourceType, r.sourceKey), {
      id: r.id,
      assignee: r.assigneeId ? { id: r.assigneeId, email: r.assigneeEmail ?? "", name: r.assigneeName ?? "" } : null,
      ownerId: r.ownerId,
      departmentCode: (r.departmentCode as DepartmentCode | null) ?? null,
      priority: (r.priority as WorkPriority | null) ?? null,
      dueAt: r.dueAt,
      snoozedUntil: r.snoozedUntil,
      blockedReason: r.blockedReason,
      startedAt: r.startedAt,
    });
  }
  return out;
}

/** Áp lớp ghi chú lên việc chiếu. Nguồn vẫn giữ trạng thái; overlay chỉ thêm thứ nguồn không có. */
export function applyOverlay(item: WorkItem, ov: WorkOverlay | undefined): WorkItem {
  if (!ov) return item;
  const blocked = ov.blockedReason.trim().length > 0;
  return {
    ...item,
    // Người nguồn đã gán vẫn được giữ nếu lớp công việc chưa gán ai — không xoá thông tin đang có.
    assignee: ov.assignee ?? item.assignee,
    department: ov.departmentCode ?? item.department,
    priority: ov.priority ?? item.priority,
    dueAt: ov.dueAt ?? item.dueAt,
    snoozedUntil: ov.snoozedUntil,
    startedAt: ov.startedAt ?? item.startedAt,
    blockedReason: ov.blockedReason,
    // Chặn là thông tin của LỚP CÔNG VIỆC, nên nó chỉ đổi cách HIỆN, không đổi trạng thái ở nguồn.
    status: blocked && item.status !== "DONE" && item.status !== "CANCELLED" ? "BLOCKED" : item.status,
  };
}

/* ═══════════════════ TIỆN ÍCH CHUNG ═══════════════════ */

const HOUR = 3_600_000;

/**
 * Hạn giờ cho MỘT adapter. 2,5 giây: đủ rộng cho mọi nguồn đọc thẳng từ bảng (đo được 50–260ms
 * trên production), đủ hẹp để màn hình mở đầu ca không bao giờ phải chờ engine quảng cáo tính lại.
 */
const ADAPTER_TIMEOUT_MS = 2_500;

function hoursSince(d: Date, now: number): number {
  return Math.max(0, (now - d.getTime()) / HOUR);
}

function slaAtOf(source: WorkSource, from: Date): Date | null {
  const h = WORK_SOURCE_SPEC[source].slaHours;
  return h === null ? null : new Date(from.getTime() + h * HOUR);
}

/** Tiền đo được từ một con số có thật ở nguồn. `0` vẫn là 0 — chỉ `null`/`undefined` mới là chưa biết. */
function measured(atRisk: number | null | undefined, basis: string, recoverable: number | null = null): WorkMoney {
  if (atRisk === null || atRisk === undefined) return MONEY_UNKNOWN;
  return { atRisk, recoverable, confidence: "MEASURED", basis };
}

/* ═══════════════════ 1 · CASE CSKH ═══════════════════ */

/**
 * Nguồn: `cs_cases`, CHỈ miền `CUSTOMER`.
 *
 * Miền `LOGISTICS` bị loại ở đây vì `lib/constants/cs-domain.ts` đã chốt: case sinh từ sự kiện
 * Viettel Post là việc của giao vận, và nó đã có mặt trong hàng đợi care. Đo trên production
 * 11/09/2026: 183/232 case CSKH đang mở thuộc loại đó — không lọc thì hàng đợi chung đếm đôi đúng
 * 183 việc và mọi con số tồn đọng của hai phòng đều sai.
 */
export async function adaptCsCases(now: Date, closedSince: Date | null = null): Promise<WorkItem[]> {
  const db = await getDb();
  const c = schema.csCases;
  const rows = await db
    .select({
      id: c.id,
      kind: c.kind,
      status: c.status,
      title: c.title,
      detail: c.detail,
      orderId: c.orderId,
      customerName: c.customerName,
      customerPhone: c.customerPhone,
      assignee: c.assignee,
      chatUrl: c.chatUrl,
      followUpAt: c.followUpAt,
      resolvedAt: c.resolvedAt,
      createdAt: c.createdAt,
      source: c.source,
      orderValue: schema.orders.totalPriceAfterDiscount,
      // Có kiện ĐANG CHẠY hay không quyết định miền của case sai SĐT / sai địa chỉ (`BY_SHIPMENT`).
      hasLiveShipment: sql<boolean>`exists (select 1 from shipments s where s.order_id = ${c.orderId} and s.is_final = false)`,
    })
    .from(c)
    .leftJoin(schema.orders, eq(schema.orders.id, c.orderId))
    /*
      MẶC ĐỊNH chỉ case đang mở. `closedSince` mở thêm cửa sổ case ĐÃ ĐÓNG — cần cho thẻ điểm hiệu
      suất, vì "ai đã đóng bao nhiêu việc khó" không đọc được từ tập việc còn đang mở.
    */
    .where(closedSince ? or(inArray(c.status, ["OPEN", "IN_PROGRESS"]), gte(c.resolvedAt, closedSince))! : inArray(c.status, ["OPEN", "IN_PROGRESS"]))
    .limit(2000);

  const t = now.getTime();
  const items: WorkItem[] = [];
  for (const r of rows) {
    if (csDomainOf(r.kind as never, r.hasLiveShipment) !== "CUSTOMER") continue;
    const status = CS_STATUS_TO_WORK[(CS_STATUSES as readonly string[]).includes(r.status) ? (r.status as CsStatus) : "OPEN"];
    const ageHours = hoursSince(r.createdAt, t);
    const score = caseScore({ severity: "warning", ageHours, amount: r.orderValue ?? null, type: "CS_CASE" });
    items.push({
      key: workKey("CS_CASE", r.id),
      sourceType: "CS_CASE",
      sourceKey: r.id,
      title: r.title,
      summary: r.detail || `${r.customerName} ${r.customerPhone}`.trim(),
      department: "SALES",
      // `cs_cases.assignee` là một ô CHỮ (tên/bí danh), không phải khoá người dùng — nên `id` là null.
      assignee: r.assignee ? { id: null, email: "", name: r.assignee } : null,
      status,
      statusAuthority: "SOURCE",
      priority: priorityOf(score),
      score,
      createdAt: r.createdAt,
      startedAt: null,
      dueAt: r.followUpAt,
      slaAt: slaAtOf("CS_CASE", r.createdAt),
      completedAt: r.resolvedAt,
      snoozedUntil: r.followUpAt,
      businessEntity: "ORDER",
      businessEntityId: r.orderId ?? "",
      sourceUrl: `/cs?q=${encodeURIComponent(r.id)}`,
      // Giá trị đơn là tiền ĐANG TREO ở case: khách chưa nhận được thứ họ hỏi thì đơn chưa chắc thành.
      money: measured(r.orderValue ?? null, "Giá trị đơn gắn với case (orders.total_price_after_discount)"),
      tags: [r.kind],
      evidence: { source: "Case CSKH", detail: `Nguồn ${r.source} · tạo ${ageLabel(ageHours)}` },
      blockedReason: "",
      creationSource: r.source === "MANUAL" ? "MANUAL" : "AUTO",
      actions: actionsOf("CS_CASE"),
      recommendedAction: "Trả lời khách trên Pancake rồi đóng case.",
    });
  }
  return items;
}

/* ═══════════════════ 2 · CARE VẬN ĐƠN ═══════════════════ */

export async function adaptShipmentCare(now: Date, closedSince: Date | null = null): Promise<WorkItem[]> {
  const queue = await getCareQueue();
  const t = now.getTime();
  return queue.cases
    /*
      `getCareQueue` đã trả kèm ca ĐÃ ĐÓNG trong 7 ngày (tab "Đã xử lý" của trang Vận đơn). Hàng đợi
      chung loại chúng đi; thẻ điểm hiệu suất thì cần — nên `closedSince` giữ lại đúng cửa sổ đó.
    */
    .filter((c) => {
      const open = c.care.status !== "RESOLVED" && c.care.status !== "CANCELLED";
      if (open) return true;
      return closedSince !== null && c.care.doneAt !== null && c.care.doneAt.getTime() >= closedSince.getTime();
    })
    .map((c) => {
      const ageHours = hoursSince(c.queueSince, t);
      const score = caseScore({ severity: c.sla.resolveBreached ? "critical" : "warning", ageHours, amount: c.codAmount, type: "DELIVERY_FAILED" });
      return {
        key: workKey("SHIPMENT_CARE", c.shipmentId),
        sourceType: "SHIPMENT_CARE",
        sourceKey: c.shipmentId,
        title: `${c.reasonLabel} · ${c.tracking}`,
        summary: c.reasonDetail,
        department: "LOGISTICS" as DepartmentCode,
        assignee: c.care.owner ? { id: c.care.owner.id, email: "", name: c.care.owner.name } : null,
        status: CARE_STATUS_TO_WORK[c.care.status],
        statusAuthority: "SOURCE" as const,
        priority: priorityOf(score),
        score,
        createdAt: c.queueSince,
        startedAt: c.care.firstResponseAt,
        dueAt: c.care.followUpAt,
        // SLA đóng ca lấy thẳng của care, KHÔNG tính lại: `CARE_SLA.resolveHours` là nguồn duy nhất.
        slaAt: c.sla.resolveDueAt,
        completedAt: c.care.doneAt,
        snoozedUntil: c.care.followUpAt,
        businessEntity: "SHIPMENT",
        businessEntityId: c.shipmentId,
        sourceUrl: `/shipments/${c.shipmentId}`,
        money: measured(c.codAmount, "Tiền thu hộ khai trên vận đơn (shipments.cod_amount)"),
        tags: [c.reason, c.carrier.stage],
        evidence: { source: "Sự kiện Viettel Post", detail: `${c.carrier.rawStatus || c.carrier.stageLabel} · ${c.carrier.failedAttempts} lần phát hụt` },
        blockedReason: "",
        creationSource: "AUTO" as const,
        actions: actionsOf("SHIPMENT_CARE"),
        recommendedAction: c.nextAction,
      };
    });
}

/* ═══════════════════ 3 · NÚT THẮT FULFILLMENT ═══════════════════ */

export async function adaptFulfillment(): Promise<WorkItem[]> {
  const queue = await getFulfillmentBottleneckQueue();
  return queue.cases.map((c) => {
    const score = caseScore({ severity: c.sla.breached ? "critical" : "warning", ageHours: c.ageHours, amount: c.moneyAtRisk, type: "ORDER_CONFIRMATION_STALE" });
    return {
      key: workKey("FULFILLMENT_EXCEPTION", c.orderId),
      sourceType: "FULFILLMENT_EXCEPTION",
      sourceKey: c.orderId,
      title: `${c.reasonLabel} · ${c.orderLabel}`,
      summary: c.reasonDetail,
      department: departmentOfTeam(c.team),
      assignee: null,
      status: "NEW" as WorkStatus,
      statusAuthority: "SOURCE" as const,
      priority: priorityOf(score),
      score,
      createdAt: c.detectedAt,
      startedAt: null,
      dueAt: null,
      slaAt: c.sla.dueAt,
      completedAt: null,
      snoozedUntil: null,
      businessEntity: "ORDER",
      businessEntityId: c.orderId,
      sourceUrl: c.href,
      /*
        KHAI BÁO, CHƯA XÁC MINH — đúng như `lib/queries/fulfillment-bottleneck.ts` đã ghi. Đơn chưa
        rời kho thì chưa có chứng từ tiền nào, nên đây là giá trị KHAI trên đơn. Gọi nó là "đo được"
        sẽ trộn nó với COD đã có bảng kê, và tổng tiền của hàng đợi mất ý nghĩa.
      */
      money: { atRisk: c.moneyAtRisk, recoverable: c.moneyAtRisk, confidence: "ESTIMATED" as const, basis: "Giá trị khai trên đơn — đơn chưa rời kho nên chưa có chứng từ tiền" },
      tags: [c.reason],
      evidence: { source: "Đơn + vận đơn", detail: `${c.orderStage}${c.shipmentStage ? ` → ${c.shipmentStage}` : ""} · ${c.ageLabel}` },
      blockedReason: "",
      creationSource: "AUTO" as const,
      actions: actionsOf("FULFILLMENT_EXCEPTION"),
      recommendedAction: c.nextAction,
    };
  });
}

/* ═══════════════════ 4 · DÒNG TIỀN CHƯA PHÂN LOẠI ═══════════════════ */

export async function adaptBank(now: Date): Promise<WorkItem[]> {
  const rows = await unclassifiedBankRows(300);
  const t = now.getTime();
  return rows.map((r) => {
    const ageHours = hoursSince(r.txnAt, t);
    const abs = Math.abs(r.amount);
    const score = caseScore({ severity: "warning", ageHours, amount: abs, type: "DATA_ERROR" });
    return {
      key: workKey("BANK_EXCEPTION", r.id),
      sourceType: "BANK_EXCEPTION",
      sourceKey: r.id,
      title: `${r.amount < 0 ? "Tiền ra" : "Tiền vào"} chưa phân loại · ${r.counterparty || r.description.slice(0, 60) || r.bankRef}`,
      summary: r.description,
      department: "FINANCE" as DepartmentCode,
      assignee: null,
      status: "NEW" as WorkStatus,
      statusAuthority: "SOURCE" as const,
      priority: priorityOf(score),
      score,
      createdAt: r.txnAt,
      startedAt: null,
      dueAt: null,
      slaAt: slaAtOf("BANK_EXCEPTION", r.txnAt),
      completedAt: null,
      snoozedUntil: null,
      businessEntity: "BANK_TXN",
      businessEntityId: r.id,
      sourceUrl: `/finance-ops`,
      /*
        Số tiền là SỰ THẬT (sao kê ngân hàng), nhưng nó không phải "tiền sắp mất" — nó là tiền chưa
        biết thuộc khoản nào. `recoverable` để `null`: phân loại xong không thu thêm đồng nào, nó
        chỉ làm báo cáo đúng. Ghi một con số ở đó là thổi phồng giá trị của việc này.
      */
      money: measured(abs, "Số tiền trên sao kê ngân hàng (bank_transactions.amount)"),
      tags: [r.amount < 0 ? "OUT" : "IN"],
      evidence: { source: "Sao kê ngân hàng", detail: `${r.bankRef} · ${r.source}` },
      blockedReason: "",
      creationSource: "AUTO" as const,
      actions: actionsOf("BANK_EXCEPTION"),
      recommendedAction: "Gán nhóm kế toán, rồi nối với chứng từ nếu có.",
    };
  });
}

/* ═══════════════════ 5 · QUYẾT ĐỊNH QUẢNG CÁO ═══════════════════ */

/**
 * Chỉ những dòng có hành động KHÁC "giữ nguyên". `getAdsDecision` đã tính hết; ở đây chỉ lọc và
 * đổi hình dạng.
 *
 * Không có mốc "việc này xuất hiện lúc nào" ở nguồn — quyết định quảng cáo là một lát cắt của KỲ,
 * không phải một sự kiện. Nên `createdAt` lấy đầu kỳ và `slaAt` là `null`: đặt một cái hạn giả cho
 * một việc không có mốc bắt đầu thật thì mọi dòng đều "quá hạn" ngay lần đầu nhìn thấy.
 */
export async function adaptAdsDecisions(now: Date): Promise<WorkItem[]> {
  const period = resolvePeriod({ period: "30d" }, "30d");
  const decision = await getAdsDecision(period, "campaign");
  const from = period.from ?? new Date(now.getTime() - 30 * 24 * HOUR);
  return decision.rows
    /*
      CHỈ dòng CẦN NGƯỜI QUYẾT. `HOLD`/`WATCH` là "giữ nguyên, thỉnh thoảng nhìn" — không phải việc.
      `INSUFFICIENT_DATA`/`NO_SPEND_DATA` cũng KHÔNG: chúng nói dữ liệu chưa đủ để kết luận, và biến
      một khoảng trống dữ liệu thành một việc phải làm là bắt người đi xử lý thứ không xử lý được.
    */
    .filter((r) => r.action === "CUT" || r.action === "SCALE" || r.action === "FIX_DELIVERY")
    .map((r) => {
      const atRisk = r.spendKnown ? Math.max(0, -r.profitAfterAds) : null;
      const score = caseScore({ severity: r.action === "CUT" ? "critical" : "warning", ageHours: hoursSince(from, now.getTime()), amount: atRisk, type: "ADS_ANOMALY" });
      return {
        key: workKey("ADS_DECISION", `campaign:${r.key}`),
        sourceType: "ADS_DECISION",
        sourceKey: `campaign:${r.key}`,
        title: `${ADS_ACTION_LABEL[r.action]} · ${r.name}`,
        summary: r.reason,
        department: "MARKETING" as DepartmentCode,
        assignee: null,
        status: "NEW" as WorkStatus,
        statusAuthority: "SOURCE" as const,
        priority: priorityOf(score),
        score,
        createdAt: from,
        startedAt: null,
        dueAt: null,
        slaAt: null,
        completedAt: null,
        snoozedUntil: null,
        businessEntity: "CAMPAIGN",
        businessEntityId: r.key,
        sourceUrl: `/ads?tab=decision&period=30d`,
        /*
          `spendKnown = false` ⇒ Facebook không trả chi tiêu ở độ mịn này, nên KHÔNG BIẾT mất bao
          nhiêu. `null`, không phải 0 — đây đúng là tình huống mà AGENTS.md mục 0.3 nói tới.
        */
        money: r.spendKnown
          ? { atRisk, recoverable: null, confidence: "ESTIMATED" as const, basis: "Lỗ sau quảng cáo của kỳ 30 ngày (getAdsDecision)" }
          : MONEY_UNKNOWN,
        tags: [r.action, ...(r.lowDelivery ? ["LOW_DELIVERY"] : [])],
        evidence: { source: "Màn quyết định quảng cáo", detail: r.reason },
        blockedReason: "",
        creationSource: "AUTO" as const,
        actions: actionsOf("ADS_DECISION"),
        recommendedAction: r.reason,
      };
    });
}

/* ═══════════════════ 6 · CẢNH BÁO (và ba nguồn tách ra từ nó) ═══════════════════ */

export async function adaptAlerts(now: Date): Promise<WorkItem[]> {
  const queue = await getActionQueue({ limit: 500 });
  const items: WorkItem[] = [];
  for (const c of queue.cases) {
    if (ALERT_KINDS_OWNED_ELSEWHERE.includes(c.type)) continue;
    const source: WorkSource = ALERT_KIND_TO_SOURCE[c.type] ?? "ALERT";
    const spec = WORK_SOURCE_SPEC[source];
    const status = ALERT_STATUS_TO_WORK[c.status];
    items.push({
      key: workKey(source, c.id),
      sourceType: source,
      sourceKey: c.id,
      title: c.title,
      summary: c.reason,
      department: spec.department ?? departmentOfTeam(c.team),
      assignee: c.owner ? { id: c.owner.id, email: "", name: c.owner.name } : null,
      status,
      statusAuthority: "SOURCE",
      priority: c.priority,
      score: c.score,
      createdAt: c.detectedAt,
      startedAt: null,
      dueAt: null,
      // SLA của chính loại cảnh báo (`CASE_SLA_HOURS`) — không lấy `slaHours` của nguồn, vì một
      // nguồn `ALERT` gom nhiều loại việc có hạn rất khác nhau.
      slaAt: slaFor(c.type, c.detectedAt, now)?.dueAt ?? null,
      completedAt: null,
      snoozedUntil: null,
      businessEntity: c.entityType || "NONE",
      businessEntityId: c.entityId,
      sourceUrl: c.href || "/alerts",
      // `financialImpact = 0` ở hàng đợi cảnh báo nghĩa là KHÔNG TRA ĐƯỢC, không phải 0đ.
      money: c.financialImpact > 0 ? measured(c.financialImpact, `Tiền liên quan tính bởi hàng đợi việc (${c.evidence.source})`) : MONEY_UNKNOWN,
      tags: [c.type],
      evidence: c.evidence,
      blockedReason: "",
      creationSource: "AUTO",
      actions: actionsOf(source),
      recommendedAction: c.recommendedAction,
    });
  }
  return items;
}

/* ═══════════════════ 7 · VIỆC TAY & VIỆC ĐỊNH KỲ ═══════════════════ */

/** Nguồn duy nhất giữ trạng thái trong `work_items`. Ở đây không có phép chiếu nào. */
export async function adaptOwnedWork(now: Date, includeClosed: boolean, closedSince: Date | null = null): Promise<WorkItem[]> {
  const db = await getDb();
  const w = schema.workItems;
  const rows = await db
    .select({
      id: w.id,
      sourceType: w.sourceType,
      sourceKey: w.sourceKey,
      title: w.title,
      summary: w.summary,
      departmentCode: schema.departments.code,
      assigneeId: w.assigneeId,
      assigneeName: schema.users.name,
      assigneeEmail: schema.users.email,
      ownerId: w.ownerId,
      status: w.status,
      priority: w.priority,
      dueAt: w.dueAt,
      startedAt: w.startedAt,
      completedAt: w.completedAt,
      snoozedUntil: w.snoozedUntil,
      blockedReason: w.blockedReason,
      businessEntity: w.businessEntity,
      businessEntityId: w.businessEntityId,
      moneyAtRisk: w.moneyAtRisk,
      moneyRecoverable: w.moneyRecoverable,
      moneyConfidence: w.moneyConfidence,
      moneyBasis: w.moneyBasis,
      tags: w.tags,
      creationSource: w.creationSource,
      createdAt: w.createdAt,
    })
    .from(w)
    .leftJoin(schema.users, eq(schema.users.id, w.assigneeId))
    .leftJoin(schema.departments, eq(schema.departments.id, w.departmentId))
    .where(
      includeClosed
        ? eq(w.authority, "WORK")
        : closedSince
          ? and(eq(w.authority, "WORK"), or(sql`${w.status} NOT IN ('DONE', 'CANCELLED')`, gte(w.completedAt, closedSince)))
          : and(eq(w.authority, "WORK"), sql`${w.status} NOT IN ('DONE', 'CANCELLED')`),
    )
    .limit(2000);

  const t = now.getTime();
  return rows.map((r) => {
    const priority = (r.priority as WorkPriority | null) ?? "NORMAL";
    const ageHours = hoursSince(r.createdAt, t);
    // Việc tay không có "mức nghiêm trọng" đo được — dùng chính mức ưu tiên người đặt làm đầu vào.
    const severity = priority === "URGENT" ? "critical" : priority === "HIGH" ? "warning" : "info";
    const score = caseScore({ severity, ageHours, amount: r.moneyAtRisk, type: "OTHER" });
    return {
      key: workKey(r.sourceType, r.sourceKey),
      sourceType: r.sourceType,
      sourceKey: r.sourceKey,
      title: r.title,
      summary: r.summary,
      department: (r.departmentCode as DepartmentCode | null) ?? "MANAGEMENT",
      assignee: r.assigneeId ? { id: r.assigneeId, email: r.assigneeEmail ?? "", name: r.assigneeName ?? "" } : null,
      status: r.status as WorkStatus,
      statusAuthority: "WORK" as const,
      priority,
      score,
      createdAt: r.createdAt,
      startedAt: r.startedAt,
      dueAt: r.dueAt,
      // Việc tay không có SLA của loại — hạn của nó là hạn người đặt.
      slaAt: r.dueAt,
      completedAt: r.completedAt,
      snoozedUntil: r.snoozedUntil,
      businessEntity: r.businessEntity,
      businessEntityId: r.businessEntityId,
      sourceUrl: `/work/all?q=${encodeURIComponent(r.sourceKey)}`,
      money:
        r.moneyAtRisk === null && r.moneyRecoverable === null
          ? MONEY_UNKNOWN
          : { atRisk: r.moneyAtRisk, recoverable: r.moneyRecoverable, confidence: r.moneyConfidence as WorkMoney["confidence"], basis: r.moneyBasis },
      tags: r.tags ?? [],
      evidence: { source: r.creationSource === "RECURRING" ? "Việc định kỳ" : "Người giao", detail: r.summary.slice(0, 200) },
      blockedReason: r.blockedReason,
      creationSource: r.creationSource as WorkItem["creationSource"],
      actions: actionsOf(r.sourceType === "RECURRING_TASK" ? "RECURRING_TASK" : "MANUAL_TASK"),
      recommendedAction: r.summary.slice(0, 200),
    };
  });
}

/* ═══════════════════ GOM TẤT CẢ ═══════════════════ */

export type CollectOptions = {
  /** Giới hạn ở một số nguồn. Bỏ trống = tất cả. */
  sources?: WorkSource[];
  /** Kèm cả việc đã xong. Mặc định `false` — hàng đợi là nơi làm việc, không phải nơi ngắm thành tích. */
  includeClosed?: boolean;
  /**
   * Kèm việc ĐÃ ĐÓNG từ mốc này trở đi, ngoài việc đang mở.
   *
   * Khác `includeClosed`: cái kia lấy TẤT CẢ lịch sử của những nguồn đọc được; cái này mở đúng một
   * CỬA SỔ. Thẻ điểm hiệu suất cần nó — độ khó và tiền của việc đã đóng không đọc được từ tập việc
   * còn đang mở, mà kéo toàn bộ lịch sử về thì vừa chậm vừa vô ích.
   */
  closedSince?: Date | null;
  now?: Date;
};

/**
 * MỘT LẦN GỌI, BẢY ADAPTER CHẠY SONG SONG.
 *
 * Mỗi adapter độc lập nên chúng đi cùng lúc; một nguồn hỏng (tích hợp lỗi, bảng trống) KHÔNG được
 * làm sập cả hàng đợi — người vận hành mất một mảng việc còn hơn mất toàn bộ màn hình. Nguồn hỏng
 * trả về rỗng và được nêu tên ở `failed` để giao diện nói thẳng "mảng này chưa đọc được", thay vì
 * hiện một hàng đợi ngắn hơn thực tế mà không ai biết.
 */
export async function collectWorkItems(opts: CollectOptions = {}): Promise<{ items: WorkItem[]; failed: { source: WorkSource; error: string }[] }> {
  const now = opts.now ?? new Date();
  const closedSince = opts.closedSince ?? null;
  const want = (s: WorkSource) => !opts.sources || opts.sources.includes(s);
  const failed: { source: WorkSource; error: string }[] = [];

  /*
    ═══ MỘT NGUỒN CHẬM KHÔNG ĐƯỢC GIỮ CẢ HÀNG ĐỢI LÀM CON TIN ═══

    ĐO ĐƯỢC trên production 12/09/2026 (smoke sau deploy #245): `/ads` mất **6,1 giây** khi đệm
    nguội — `getAdsDecision` là engine nặng nhất kho này. Và `adaptAdsDecisions` gọi ĐÚNG engine
    đó. Trong lượt smoke, `/work` chỉ đạt 76ms vì `/ads` chạy trước đã làm nóng `memo()`.

    Nhân viên mở `/work` ĐẦU CA — lúc đệm chắc chắn nguội. Tức là con số thật họ gặp không phải
    76ms mà là khoảng sáu giây, trên đúng màn hình mở đầu ngày làm việc.

    Nên: mỗi adapter có hạn giờ riêng. Quá hạn thì nguồn đó trả rỗng và ĐƯỢC NÊU TÊN ở `failed` —
    giao diện đã có sẵn dải cảnh báo "Danh sách đang thiếu một phần". Mất một mảng việc kèm lời
    nói rõ thì tốt hơn nhiều so với bắt cả đội chờ sáu giây mỗi sáng.

    Lượt gọi quá hạn KHÔNG bị huỷ: nó chạy tiếp và làm nóng `memo()`, nên lần mở sau đã có đủ.
  */
  const guard = async (source: WorkSource, run: () => Promise<WorkItem[]>): Promise<WorkItem[]> => {
    let hetGio: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        run(),
        new Promise<WorkItem[]>((_, reject) => {
          hetGio = setTimeout(() => reject(new Error(`quá ${Math.round(ADAPTER_TIMEOUT_MS / 1000)}s — đang tính lại, mở lại sau ít giây là có`)), ADAPTER_TIMEOUT_MS);
        }),
      ]);
    } catch (e) {
      failed.push({ source, error: e instanceof Error ? e.message : String(e) });
      return [];
    } finally {
      if (hetGio) clearTimeout(hetGio);
    }
  };

  const groups = await Promise.all([
    want("CS_CASE") ? guard("CS_CASE", () => adaptCsCases(now, closedSince)) : [],
    want("SHIPMENT_CARE") ? guard("SHIPMENT_CARE", () => adaptShipmentCare(now, closedSince)) : [],
    want("FULFILLMENT_EXCEPTION") ? guard("FULFILLMENT_EXCEPTION", () => adaptFulfillment()) : [],
    want("BANK_EXCEPTION") ? guard("BANK_EXCEPTION", () => adaptBank(now)) : [],
    want("ADS_DECISION") ? guard("ADS_DECISION", () => adaptAdsDecisions(now)) : [],
    // Một lượt đọc `notifications` sinh ra bốn nguồn; lọc lại sau khi đã có.
    want("ALERT") || want("COD_EXCEPTION") || want("INVENTORY_EXCEPTION") || want("RETURN_INSPECTION") ? guard("ALERT", () => adaptAlerts(now)) : [],
    want("MANUAL_TASK") || want("RECURRING_TASK") ? guard("MANUAL_TASK", () => adaptOwnedWork(now, opts.includeClosed ?? false, closedSince)) : [],
  ]);

  let items = groups.flat();
  if (opts.sources) items = items.filter((i) => opts.sources!.includes(i.sourceType as WorkSource));

  const overlays = await loadOverlays(items.filter((i) => i.statusAuthority === "SOURCE").map((i) => i.key));
  items = items.map((i) => (i.statusAuthority === "SOURCE" ? applyOverlay(i, overlays.get(i.key)) : i));

  if (!opts.includeClosed) {
    items = items.filter((i) => {
      if (i.status !== "DONE" && i.status !== "CANCELLED") return true;
      // Việc đã đóng chỉ ở lại khi nằm trong cửa sổ `closedSince` — và phải BIẾT nó đóng lúc nào.
      return closedSince !== null && i.completedAt !== null && i.completedAt.getTime() >= closedSince.getTime();
    });
  }

  /*
    KHOÁ CHỐNG TRÙNG CUỐI CÙNG.

    Không adapter nào được sinh hai dòng cùng `key`, nhưng nếu một ngày có ai thêm nguồn mới mà
    quên khai vào `ALERT_KINDS_OWNED_ELSEWHERE` thì tiền sẽ bị cộng hai lần trong mọi tổng hợp.
    Chặn ở đây thay vì tin vào kỷ luật — và `tests/work-os.test.ts` khoá luôn ở mức dữ liệu.
  */
  const seen = new Set<string>();
  items = items.filter((i) => (seen.has(i.key) ? false : (seen.add(i.key), true)));

  items.sort((a, b) => b.score - a.score);
  return { items, failed };
}

/** Chỉ dùng cho kiểm thử và chẩn đoán: khoá trùng nhau giữa các nguồn. */
export function duplicateKeys(items: WorkItem[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const i of items) {
    if (seen.has(i.key)) dup.add(i.key);
    seen.add(i.key);
  }
  return [...dup];
}

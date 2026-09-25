import { and, eq, gte, inArray, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ageLabel, caseScore, priorityOf, slaFor } from "@/lib/constants/action-queue";
import { CS_STATUSES, type CsStatus } from "@/lib/constants/cs";
import { csDomainOf, isBotAssignee } from "@/lib/constants/cs-domain";
import { departmentOfTeam, type DepartmentCode } from "@/lib/constants/departments";
import { actionsOf, ALERT_KINDS_OWNED_ELSEWHERE, ALERT_STATUS_TO_WORK, assigneeAuthorityOf, CARE_STATUS_TO_WORK, CS_STATUS_TO_WORK, sourceOfAlert, WORK_SOURCE_SPEC, type WorkSource } from "@/lib/constants/work-sources";
import { MONEY_UNKNOWN, WORK_PRIORITIES, WORK_TAG_MACHINE_HELD, workKey, type WorkItem, type WorkMoney, type WorkPriority, type WorkStatus } from "@/lib/constants/work";
import { departmentFor } from "@/lib/constants/work-ownership";
import { slaDueAt } from "@/lib/constants/work-sla";
import { getWorkConfig, type WorkConfig } from "@/lib/queries/work-config";
import { getActionQueue } from "@/lib/queries/action-queue";
import { ADS_ACTION_LABEL } from "@/lib/constants/ads-decision";
import { getAdsDecision } from "@/lib/queries/ads-decision";
import { decisionStability } from "@/lib/queries/marketing-ledger";
import { vnDay } from "@/lib/constants/marketing-decision-ledger";
import type { Stability } from "@/lib/marketing/decision-stability";
import { getCareQueue } from "@/lib/queries/care-workbench";
import { csHandedOffExists } from "@/lib/queries/cs";
import { getFulfillmentBottleneckQueue } from "@/lib/queries/fulfillment-bottleneck";
import { getDuplicateOrderQueue } from "@/lib/queries/order-duplicate";
import { DUPLICATE_VERDICT_LABEL } from "@/lib/constants/order-duplicate";
import { unclassifiedBankRows } from "@/lib/queries/finance-ops";
import { bankExceptionScore } from "@/lib/constants/finance-ops";
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

/*
  Hai bảng "cảnh báo nào thuộc nguồn nào" nay nằm ở `lib/constants/work-sources.ts` cùng sổ đăng ký
  thẩm quyền: chúng là HẰNG SỐ khai báo, không phải truy vấn, và bảng cấu hình hạn xử lý
  (`lib/constants/work-sla.ts`) cần đọc chúng mà không được kéo `getDb` vào. Xuất lại ở đây để mã
  gọi cũ và `tests/work-os.test.ts` không phải đổi đường dẫn.
*/
export { ALERT_KINDS_OWNED_ELSEWHERE, ALERT_KIND_TO_SOURCE } from "@/lib/constants/work-sources";

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
  /*
    NGUỒN GIỮ NGƯỜI PHỤ TRÁCH THÌ LỚP GHI CHÚ KHÔNG ĐƯỢC ĐÈ.

    `cs_cases.assignee_user_id` / `shipment_care.owner_id` là sự thật; một dòng `work_items` còn
    mang `assignee_id` cho các nguồn này là di sản của thời hai nút "Nhận việc" ghi hai chỗ. Đọc nó
    đè lên nguồn thì trang CSKH nói một tên, hàng đợi nói tên khác. Xem `assigneeAuthority`.
  */
  const sourceOwnsAssignee = assigneeAuthorityOf(item.sourceType) === "SOURCE";
  return {
    ...item,
    // Người nguồn đã gán vẫn được giữ nếu lớp công việc chưa gán ai — không xoá thông tin đang có.
    assignee: sourceOwnsAssignee ? item.assignee : (ov.assignee ?? item.assignee),
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
      assigneeUserId: c.assigneeUserId,
      chatUrl: c.chatUrl,
      followUpAt: c.followUpAt,
      resolvedAt: c.resolvedAt,
      createdAt: c.createdAt,
      source: c.source,
      orderValue: schema.orders.totalPriceAfterDiscount,
      // Đơn đã giao cho ĐVVC chưa quyết định miền của case (`BY_SHIPMENT`) — CÙNG mệnh đề với trang CSKH.
      handedOff: sql<boolean>`${csHandedOffExists(c.orderId)}`,
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
    if (csDomainOf(r.kind as never, r.handedOff) !== "CUSTOMER") continue;
    const status = CS_STATUS_TO_WORK[(CS_STATUSES as readonly string[]).includes(r.status) ? (r.status as CsStatus) : "OPEN"];
    const ageHours = hoursSince(r.createdAt, t);
    const score = caseScore({ severity: "warning", ageHours, amount: r.orderValue ?? null, type: "CS_CASE" });
    /*
      BA RỔ CỦA Ô PHỤ TRÁCH, KHÔNG GỘP (AGENTS.md mục 34–36):
        · có `assignee_user_id`     ⇒ người thật, quy kết bằng KHOÁ — `isMine` khớp chính xác.
        · tên là một JOB (`Bot ERP`) ⇒ MÁY đã chạm vào, KHÔNG ai người đang cầm: `assignee = null`
                                        kèm nhãn máy, để bảng tải không đếm bot thành một nhân viên.
        · chỉ có tên gõ tay          ⇒ dòng cũ chưa nối khoá; giữ `id: null` để hàng đợi cá nhân
                                        còn nhận ra bằng tên (rộng rãi có chủ đích, xem `isMine`).
    */
    const botHeld = !r.assigneeUserId && isBotAssignee(r.assignee);
    const assignee = r.assigneeUserId ? { id: r.assigneeUserId, email: "", name: r.assignee } : botHeld || !r.assignee ? null : { id: null, email: "", name: r.assignee };
    items.push({
      key: workKey("CS_CASE", r.id),
      sourceType: "CS_CASE",
      sourceKey: r.id,
      kind: null,  // Một nguồn, một loại việc — hạn và phòng ban đặt ở mức nguồn.
      title: r.title,
      summary: r.detail || `${r.customerName} ${r.customerPhone}`.trim(),
      department: "SALES",
      assignee,
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
      tags: botHeld ? [r.kind, WORK_TAG_MACHINE_HELD] : [r.kind],
      evidence: { source: "Case CSKH", detail: `Nguồn ${r.source} · tạo ${ageLabel(ageHours)}${botHeld ? " · bot đã nhắn, chưa ai nhận" : ""}` },
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
        kind: null,
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
      kind: c.reason,  // Bốn lý do tắc có hạn khác nhau và một trong bốn thuộc phòng khác.
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

/* ═══════════════════ 3b · ĐƠN NGHI TRÙNG ═══════════════════ */

/**
 * Nguồn: `getDuplicateOrderQueue()` — cùng truy vấn mà `/operations/preship` đang dùng, không viết
 * lại một điều kiện nào.
 *
 * MỘT VIỆC CHO MỖI ĐƠN NGHI, không phải mỗi CẶP: khoá là id của đơn ĐẶT SAU. Ba đơn giống hệt nhau
 * sinh hai việc (hai đơn sau), và người trực gọi khách MỘT lần cho mỗi đơn cần huỷ — không phải ba
 * lần cho ba cặp.
 *
 * `kind` mang mức kết luận (`DUPLICATE_SUSPECTED` / `POSSIBLE_DUPLICATE`) để chủ shop đặt được hạn
 * riêng cho từng mức về sau mà không phải sửa mã: bảng hạn đã nhận khoá dạng `<nguồn>:<loại>`.
 */
export async function adaptDuplicateOrders(now: Date): Promise<WorkItem[]> {
  const queue = await getDuplicateOrderQueue();
  const t = now.getTime();
  return queue.rows.map((r) => {
    const ageHours = hoursSince(r.suspectInsertedAt, t);
    /*
      Xếp cùng trục với `RISKY_ORDER`: cả hai đều là "đơn còn trong kho, cần một cuộc gọi trước khi
      gửi". Không thêm một loại `CaseType` mới chỉ để chấm điểm — bảng `RECOVERABILITY` và
      `CUSTOMER_WAITING` là bảng chung, thêm một hàng vào đó là đổi thang điểm của cả hàng đợi.
    */
    const score = caseScore({
      // Đơn trước ĐÃ rời kho là ca gấp nhất: một gói đang đi, một gói sắp đi.
      severity: r.keeperShipped || r.verdict === "DUPLICATE_SUSPECTED" ? "critical" : "warning",
      ageHours,
      amount: r.atRisk,
      type: "RISKY_ORDER",
    });
    return {
      key: workKey("ORDER_DUPLICATE", r.suspectOrderId),
      sourceType: "ORDER_DUPLICATE",
      sourceKey: r.suspectOrderId,
      kind: r.verdict,
      title: `${DUPLICATE_VERDICT_LABEL[r.verdict]} · ${r.suspectSystemId ? `#${r.suspectSystemId}` : r.suspectOrderId}`,
      summary: `${r.why} Đơn giữ: ${r.keeperSystemId ? `#${r.keeperSystemId}` : r.keeperOrderId}${r.keeperShipped ? " (ĐÃ RỜI KHO)" : ""}.`,
      department: "SALES" as DepartmentCode,
      assignee: null,
      status: "NEW" as WorkStatus,
      statusAuthority: "SOURCE" as const,
      priority: priorityOf(score),
      score,
      createdAt: r.suspectInsertedAt,
      startedAt: null,
      dueAt: null,
      slaAt: slaAtOf("ORDER_DUPLICATE", r.suspectInsertedAt),
      completedAt: null,
      snoozedUntil: null,
      businessEntity: "ORDER",
      businessEntityId: r.suspectOrderId,
      sourceUrl: `/orders/${r.suspectOrderId}`,
      /*
        KHAI BÁO, CHƯA XÁC MINH — cùng lý do với nút thắt fulfillment: đơn chưa rời kho nên chưa có
        chứng từ tiền nào. Và `recoverable` bằng đúng `atRisk` vì huỷ kịp thì không mất đồng nào.
      */
      money: {
        atRisk: r.atRisk,
        recoverable: r.atRisk,
        confidence: "ESTIMATED" as const,
        basis: "Giá trị khai trên đơn nghi trùng — đơn chưa rời kho nên chưa có chứng từ tiền",
      },
      tags: [r.verdict, ...(r.keeperShipped ? ["don-truoc-da-roi-kho"] : [])],
      evidence: { source: "Đối chiếu hai đơn", detail: `${r.signalLabels.join(" · ")} · cách nhau ${r.gapHours < 1 ? "dưới 1 giờ" : `${Math.round(r.gapHours)} giờ`}` },
      blockedReason: "",
      creationSource: "AUTO" as const,
      actions: actionsOf("ORDER_DUPLICATE"),
      recommendedAction: r.nextAction,
    };
  });
}

/* ═══════════════════ 4 · DÒNG TIỀN CHƯA PHÂN LOẠI ═══════════════════ */

export async function adaptBank(now: Date): Promise<WorkItem[]> {
  /*
    300 dòng ĐÁNG XỬ LÝ NHẤT, không phải 300 dòng MỚI NHẤT: `unclassifiedBankRows` xếp theo đúng
    công thức của trang Kế toán (`rankBankExceptions`), nên khi tồn vượt 300 thì phần bị cắt là các
    khoản nhỏ và mới — không phải khoản lớn và cũ nhất như trước 24/09/2026.
  */
  const rows = await unclassifiedBankRows(300, { now });
  return rows.map((r) => {
    const abs = Math.abs(r.amount);
    const score = bankExceptionScore(r.amount, r.txnAt, now);
    return {
      key: workKey("BANK_EXCEPTION", r.id),
      sourceType: "BANK_EXCEPTION",
      sourceKey: r.id,
      kind: null,
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
 * Hạ ĐÚNG MỘT BẬC trên thang bốn mức, và không bao giờ xuống dưới đáy.
 *
 * Không nhân điểm với một hệ số: điểm là thứ so sánh được giữa các NGUỒN việc khác nhau, bóp méo
 * nó ở một nguồn làm hỏng phép xếp hạng của cả hàng đợi. Mức ưu tiên thì đúng là thứ để nói
 * "cái này đọc sau" mà không đụng tới cách đo.
 */
export function haMotBac(p: WorkPriority): WorkPriority {
  const i = WORK_PRIORITIES.indexOf(p);
  return WORK_PRIORITIES[Math.min(i + 1, WORK_PRIORITIES.length - 1)];
}

/**
 * Câu nói về độ chín, gắn vào cuối phần tóm tắt. `null` khi không có gì đáng nói thêm.
 *
 * Dòng CHƯA có sổ (`NO_HISTORY`) cũng phải nói ra: nó KHÁC "đã theo dõi và thấy chưa ổn định" —
 * một cái là chưa đo, cái kia là đã đo và kết quả dao động (AGENTS.md mục 39).
 */
export function benCau(b: Stability | null): string | null {
  if (!b) return null;
  if (b.ready) return `Khuyến nghị đã giữ ${b.heldDays} ngày liền — đủ chín để hành động.`;
  return `CHƯA CHÍN: ${b.reason}`;
}

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
  const canDecide = decision.rows.filter((r) => r.action === "CUT" || r.action === "SCALE" || r.action === "FIX_DELIVERY");
  /*
    ═══════════ ĐỘ BỀN ĐỌC TỪ SỔ, VÌ HÀNG ĐỢI KHÔNG ĐƯỢC LỎNG HƠN BÀN TAY ═══════════

    Bàn tay ghi ngân sách đòi khuyến nghị phải GIỮ NGUYÊN mấy ngày liền mới được động vào tiền
    (`DECISION_STABILITY`). Hàng đợi người thì trước nay nhận dòng ngay hôm nó xuất hiện lần đầu —
    nên MÁY thận trọng hơn NGƯỜI, đúng ngược chiều với lẽ thường. Một khuyến nghị đổi ý vào ngày
    mai đã kịp tốn của ai đó một lượt mở Facebook.

    Cố ý KHÔNG lọc bỏ dòng chưa chín: "chưa đủ ngày" khác hẳn "không đáng làm" (AGENTS.md mục 39),
    và giấu nó đi là giấu việc. Nó vẫn vào hàng đợi, nhưng mang nhãn và bị hạ điểm.

    Sổ chạy trên KỲ CHUẨN còn bảng này chạy trên 30 ngày, nên một chiến dịch có thể có mặt ở đây mà
    chưa có dòng sổ nào. Khi ấy `stabilityOf` trả `NO_HISTORY` — chưa biết, không phải chưa chín.
  */
  const stability = await decisionStability("campaign", canDecide.map((r) => r.key), vnDay(now)).catch(() => new Map<string, Stability>());
  return canDecide
    /*
      Phép lọc "chỉ dòng CẦN NGƯỜI QUYẾT" đã làm ở `canDecide` phía trên. `HOLD`/`WATCH` là "giữ
      nguyên, thỉnh thoảng nhìn" — không phải việc. `INSUFFICIENT_DATA`/`NO_SPEND_DATA` cũng KHÔNG:
      chúng nói dữ liệu chưa đủ để kết luận, và biến một khoảng trống dữ liệu thành một việc phải
      làm là bắt người đi xử lý thứ không xử lý được.
    */
    .map((r) => {
      const ben = stability.get(r.key) ?? null;
      const tamTinh = r.basis === "PROJECTED";
      /*
        ─── TIỀN PHẢI ĐỌC TỪ CÙNG MỘT CĂN CỨ ĐÃ SINH RA KHUYẾN NGHỊ ───

        Dòng tạm tính được kết luận trên `projectedProfitAfterAds`; in `profitAfterAds` (số đo) vào
        ô tiền của nó là để hàng đợi nói một đằng còn lý do nói một nẻo. Với mô hình bán trước,
        chênh lệch giữa hai con số ấy là cả phần hàng đang đi — không phải sai số làm tròn.
      */
      const loi = tamTinh ? r.projectedProfitAfterAds : r.profitAfterAds;
      const atRisk = r.spendKnown ? Math.max(0, -loi) : null;
      const score = caseScore({ severity: r.action === "CUT" ? "critical" : "warning", ageHours: hoursSince(from, now.getTime()), amount: atRisk, type: "ADS_ANOMALY" });
      return {
        key: workKey("ADS_DECISION", `campaign:${r.key}`),
        sourceType: "ADS_DECISION",
        sourceKey: `campaign:${r.key}`,
        kind: r.action,
        // Nhãn căn cứ nằm trong TIÊU ĐỀ, không chỉ trong thẻ: danh sách việc đọc theo tiêu đề, và
        // "CẮT" đứng trên số đo với "CẮT" đứng trên giả định không phải cùng một việc.
        title: `${ADS_ACTION_LABEL[r.action]}${tamTinh ? " (tạm tính)" : ""} · ${r.name}`,
        summary: benCau(ben) ? `${r.reason} ${benCau(ben)}` : r.reason,
        department: "MARKETING" as DepartmentCode,
        assignee: null,
        status: "NEW" as WorkStatus,
        statusAuthority: "SOURCE" as const,
        /*
          CHƯA CHÍN THÌ HẠ MỘT BẬC, KHÔNG XOÁ.

          Điểm vẫn tính từ tiền và tuổi như mọi nguồn khác — thứ bị hạ là mức ƯU TIÊN, tức thứ
          quyết định ai nhìn thấy nó trước. Một khuyến nghị mới ra đời hôm nay vẫn đáng đọc, chỉ
          chưa đáng bỏ việc đang làm để chạy theo.
        */
        priority: ben && !ben.ready ? haMotBac(priorityOf(score)) : priorityOf(score),
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
          ? {
              atRisk,
              recoverable: null,
              confidence: "ESTIMATED" as const,
              basis: tamTinh
                ? `Lỗ sau quảng cáo TẠM TÍNH của kỳ 30 ngày — phần đơn chưa ngã ngũ cân theo GTC ${r.appliedDeliveryRate ?? "—"}% (getAdsDecision)`
                : "Lỗ sau quảng cáo của kỳ 30 ngày (getAdsDecision)",
            }
          : MONEY_UNKNOWN,
        tags: [
          r.action,
          ...(tamTinh ? ["TAM_TINH"] : []),
          ...(ben && !ben.ready ? ["CHUA_CHIN"] : []),
          ...(r.lowDelivery ? ["LOW_DELIVERY"] : []),
        ],
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
    const source: WorkSource = sourceOfAlert(c.type);
    const spec = WORK_SOURCE_SPEC[source];
    const status = ALERT_STATUS_TO_WORK[c.status];
    items.push({
      key: workKey(source, c.id),
      sourceType: source,
      sourceKey: c.id,
      kind: c.type,  // Loại cảnh báo quyết định hạn và phòng ban, không phải tên nguồn.
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

/* ═══════════════════ 7 · VIỆC PHÒNG TECH AI ═══════════════════ */

/**
 * Nguồn: `tech_tasks`. PHÉP CHIẾU thuần — adapter này không viết lại một luật vòng đời nào.
 *
 * ─── HAI BỘ TRẠNG THÁI, MỘT NƠI GIỮ SỰ THẬT ───
 *
 * Miền Tech có 13 trạng thái; hàng đợi chung chỉ có 7. `TECH_TO_WORK_STATUS` là phép chiếu MỘT
 * CHIỀU: nó đổi hình dạng để hiển thị và không bao giờ đi ngược. `tech_tasks.status` vẫn là nơi
 * duy nhất giữ sự thật, và `work_items.status` của nguồn này bắt buộc `NULL` (ràng buộc
 * `work_items_authority_check` ở CSDL).
 *
 * Mất mát của phép chiếu là CÓ THẬT và cố ý: `REVIEW`, `QA`, `DEPLOYING`, `OBSERVING` đều hiện ra
 * "Đang làm". Ai cần biết việc đang ở khâu nào thì mở `/tech/tasks/[id]` — hàng đợi chung trả lời
 * "hôm nay tôi phải làm gì", không phải "việc này đang ở bước nào".
 *
 * ─── KHÔNG ĐẾM HAI LẦN ───
 *
 * `tech_tasks` không trùng ĐỘ MỊN với nguồn nào đang có: không cảnh báo nào, không case nào nói về
 * một việc kỹ thuật. Nên KHÔNG phải thêm gì vào `ALERT_KINDS_OWNED_ELSEWHERE` — và
 * `tests/tech-phase2a.test.ts` chứng minh điều đó bằng cách chạy cả hàng đợi rồi soi khoá trùng.
 */
const TECH_TO_WORK_STATUS: Record<string, WorkStatus> = {
  NEW: "NEW",
  TRIAGED: "NEW",
  SPEC_READY: "ASSIGNED",
  BUILDING: "IN_PROGRESS",
  REVIEW: "IN_PROGRESS",
  QA: "IN_PROGRESS",
  READY_TO_DEPLOY: "IN_PROGRESS",
  DEPLOYING: "IN_PROGRESS",
  OBSERVING: "IN_PROGRESS",
  BLOCKED: "BLOCKED",
  FAILED: "BLOCKED",
  ROLLED_BACK: "BLOCKED",
  DONE: "DONE",
};

/**
 * P0–P3 của miền Tech → bốn mức của hàng đợi chung.
 *
 * Hai thang KHÔNG cùng tên và đó là chuyện bình thường: `P0` là từ vựng của đội kỹ thuật, `URGENT`
 * là từ vựng của hàng đợi mà cả shop đọc. Chiếu tường minh ở đây, một lần, thay vì để mỗi màn hình
 * tự đoán.
 */
const TECH_TO_WORK_PRIORITY: Record<string, WorkPriority> = { P0: "URGENT", P1: "HIGH", P2: "NORMAL", P3: "LOW" };

export async function adaptTechTasks(now: Date, includeClosed = false): Promise<WorkItem[]> {
  const db = await getDb();
  const t = schema.techTasks;
  const rows = await db.query.techTasks.findMany({
    where: includeClosed ? undefined : sql`${t.status} <> 'DONE'`,
    orderBy: [sql`case ${t.priority} when 'P0' then 0 when 'P1' then 1 when 'P2' then 2 else 3 end`],
    limit: 300,
    with: { agent: { columns: { key: true, name: true } } },
  });
  const ms = now.getTime();

  return rows.map((r) => {
    const status = TECH_TO_WORK_STATUS[r.status] ?? "NEW";
    const ageHours = hoursSince(r.createdAt, ms);
    /*
      Dùng lại thang điểm chung `caseScore` thay vì một công thức riêng: hai thang điểm trong một
      hàng đợi làm thứ tự sắp xếp vô nghĩa. Mức nghiêm trọng suy từ mức ưu tiên do NGƯỜI đặt, và
      việc đang chờ chủ shop ký được nâng lên vì nó đứng im cho tới khi có người bấm.
    */
    const choKy = r.approvalStatus === "PENDING";
    const score = caseScore({
      severity: r.priority === "P0" ? "critical" : r.priority === "P1" || choKy ? "warning" : "info",
      ageHours,
      amount: 0,
      /*
        Dùng lại `DATA_ERROR` — loại việc gần nhất đã có trong thang chung: cùng tính chất "hệ
        thống sai thì mọi phòng ra quyết định trên số sai". Thêm một `CaseType` mới chỉ để chấm
        điểm là đổi thang của CẢ hàng đợi (bảng `RECOVERABILITY` và `CUSTOMER_WAITING` là bảng
        chung) — đúng lý do `adaptDuplicateOrders` cũng dùng lại một loại đã có.
      */
      type: "DATA_ERROR",
    });
    const nhan = [r.risk, r.taskType, ...(choKy ? ["cho-chu-shop-duyet"] : []), ...(r.agent ? [] : ["chua-giao-agent"])];
    return {
      key: workKey("TECH_TASK", r.id),
      sourceType: "TECH_TASK",
      sourceKey: r.id,
      kind: r.taskType,
      title: `${r.code} · ${r.title}`,
      summary: choKy
        ? `Việc mức ${r.risk} đang CHỜ CHỦ SHOP PHÊ DUYỆT — không đi tiếp được cho tới khi có người ký.`
        : (r.description || "").split("\n")[0].slice(0, 300),
      department: "MANAGEMENT" as DepartmentCode,
      /*
        LUÔN `null`. Người phụ trách của nguồn này là một AGENT, và agent KHÔNG phải một con người
        (AGENTS.md mục 36) — đặt nó vào ô `assignee` sẽ làm mọi thẻ điểm nhân sự đếm việc của máy
        thành việc của người. Tên agent đi vào `tags` để đọc, kèm nhãn "máy đang cầm".
      */
      assignee: null,
      status,
      statusAuthority: "SOURCE" as const,
      priority: TECH_TO_WORK_PRIORITY[r.priority] ?? "P2",
      score,
      createdAt: r.createdAt,
      startedAt: r.startedAt,
      dueAt: null,
      slaAt: slaAtOf("TECH_TASK", r.createdAt),
      completedAt: r.completedAt,
      snoozedUntil: null,
      businessEntity: "NONE",
      businessEntityId: r.id,
      sourceUrl: `/tech/tasks/${r.id}`,
      /*
        Việc kỹ thuật KHÔNG khai tiền: không chứng từ nào đo được "sửa lỗi này cứu bao nhiêu".
        `MONEY_UNKNOWN` là câu trả lời đúng; `0` sẽ là một lời khẳng định sai (AGENTS.md mục 42).
      */
      money: MONEY_UNKNOWN,
      tags: r.agent ? [...nhan, `agent:${r.agent.key}`, WORK_TAG_MACHINE_HELD] : nhan,
      evidence: { source: "Phòng Tech AI", detail: `${r.status} · mức ${r.risk} · ${r.module}${r.branch ? ` · ${r.branch}` : ""}` },
      blockedReason: r.blockedReason,
      creationSource: (r.createdByKind === "HUMAN" ? "MANUAL" : "AUTO") as WorkItem["creationSource"],
      actions: actionsOf("TECH_TASK"),
      recommendedAction: choKy ? "Mở việc và bấm Duyệt hoặc Từ chối" : "Mở việc ở Phòng Tech AI",
    };
  });
}

/* ═══════════════════ 8 · VIỆC TAY & VIỆC ĐỊNH KỲ ═══════════════════ */

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
      // Việc tay không có loại con: hạn của nó là hạn người giao đặt, phòng ban do người giao chọn.
      kind: null,
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

/* ═══════════════════ ÁP CẤU HÌNH CỦA CHỦ SHOP ═══════════════════ */

/**
 * MỘT LƯỢT DUY NHẤT ĐẶT LẠI HẠN VÀ PHÒNG BAN THEO BẢNG CẤU HÌNH.
 *
 * Vì sao làm ở đây chứ không trong từng adapter: adapter chỉ được phép ĐỔI HÌNH DẠNG (luật ở đầu
 * tệp). Nếu mỗi adapter tự đọc cấu hình thì bảy nơi cùng phải nhớ thứ tự ưu tiên, và nơi nào quên
 * sẽ lệch âm thầm. Một lượt ở đây thì thứ tự ưu tiên chỉ tồn tại một chỗ.
 *
 * KHÔNG ĐỔI SỐ KHI CHƯA AI GHI ĐÈ. Mặc định trong `lib/constants/work-sla.ts` được LẤY LẠI từ
 * chính hằng số mà adapter đang dùng (`CASE_SLA_HOURS`, `CARE_SLA`, `BOTTLENECK_SLA_HOURS`), nên
 * lượt này tính ra đúng con số cũ. Nó chỉ khác đi khi có người thật sự sửa cấu hình.
 *
 * Việc tay và việc định kỳ: HẠN NGƯỜI GIAO ĐẶT LUÔN THẮNG. Cấu hình chỉ đỡ khi ô hạn bỏ trống.
 */
export function applyWorkConfig(item: WorkItem, cfg: WorkConfig): WorkItem {
  const department = departmentFor(item.sourceType, item.kind, item.department, cfg.ownership);
  const theoCauHinh = slaDueAt(item.sourceType, item.kind, item.createdAt, cfg.sla);
  const slaAt = item.statusAuthority === "WORK" ? (item.dueAt ?? theoCauHinh) : theoCauHinh;
  if (department === item.department && slaAt?.getTime() === item.slaAt?.getTime()) return item;
  return { ...item, department, slaAt };
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

  /*
    Cấu hình đọc TRƯỚC, một lần, ngoài vòng adapter: nó là một dòng `settings` có đệm 60 giây, và
    để mỗi adapter tự đọc thì bảy lượt truy vấn giống nhau đi kèm mỗi lần mở màn hình.
  */
  const cfg = await getWorkConfig();

  const groups = await Promise.all([
    want("CS_CASE") ? guard("CS_CASE", () => adaptCsCases(now, closedSince)) : [],
    want("SHIPMENT_CARE") ? guard("SHIPMENT_CARE", () => adaptShipmentCare(now, closedSince)) : [],
    want("FULFILLMENT_EXCEPTION") ? guard("FULFILLMENT_EXCEPTION", () => adaptFulfillment()) : [],
    want("ORDER_DUPLICATE") ? guard("ORDER_DUPLICATE", () => adaptDuplicateOrders(now)) : [],
    want("BANK_EXCEPTION") ? guard("BANK_EXCEPTION", () => adaptBank(now)) : [],
    want("ADS_DECISION") ? guard("ADS_DECISION", () => adaptAdsDecisions(now)) : [],
    // Một lượt đọc `notifications` sinh ra bốn nguồn; lọc lại sau khi đã có.
    want("ALERT") || want("COD_EXCEPTION") || want("INVENTORY_EXCEPTION") || want("RETURN_INSPECTION") ? guard("ALERT", () => adaptAlerts(now)) : [],
    want("TECH_TASK") ? guard("TECH_TASK", () => adaptTechTasks(now, opts.includeClosed ?? false)) : [],
    want("MANUAL_TASK") || want("RECURRING_TASK") ? guard("MANUAL_TASK", () => adaptOwnedWork(now, opts.includeClosed ?? false, closedSince)) : [],
  ]);

  let items = groups.flat().map((i) => applyWorkConfig(i, cfg));
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

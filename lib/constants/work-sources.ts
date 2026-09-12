import { CASE_SLA_HOURS, CASE_TEAM, type CaseStatus, type CaseType } from "@/lib/constants/action-queue";
import { CARE_SLA, type CareStatus } from "@/lib/constants/care";
import type { CsStatus } from "@/lib/constants/cs";
import { TEAM_DEPARTMENT, type DepartmentCode } from "@/lib/constants/departments";
import { WORK_COMMON_ACTIONS, type WorkActionKey } from "@/lib/constants/work-actions";
import type { WorkStatus } from "@/lib/constants/work";

/**
 * ═══════════ SỔ ĐĂNG KÝ THẨM QUYỀN CÔNG VIỆC ═══════════
 *
 * Cùng hình dạng với `lib/constants/cost-authority.ts` ("một khoản chi, một nguồn"), áp cho công
 * việc: **một sự việc, một nơi giữ trạng thái.**
 *
 * ─── VÌ SAO PHẢI CÓ CỘT `statusAuthority` ───
 *
 * Cám dỗ lớn nhất khi làm một hàng đợi chung là chép mỗi case CSKH thành một dòng `work_items`.
 * Làm thế là lập tức có HAI nơi giữ trạng thái cho cùng một sự việc, và đến một ngày
 * `cs_cases.status = 'DONE'` sẽ đứng cạnh `work_items.status = 'IN_PROGRESS'`. Không job đồng bộ
 * nào cứu được: job nào cũng trễ, và trễ nghĩa là sai.
 *
 *  · `SOURCE` — miền nghiệp vụ giữ trạng thái. Dòng `work_items` (nếu có) chỉ là LỚP GHI CHÚ:
 *    người nhận, ưu tiên đặt tay, hạn đặt tay, hoãn, lý do chặn. Cột `status` của nó BẮT BUỘC
 *    `NULL` — ràng buộc CHECK ở CSDL (`work_items_authority_check`), không phải quy ước.
 *  · `WORK` — không miền nào sở hữu (việc tay, việc định kỳ). `work_items` là nguồn duy nhất.
 *
 * ─── HỆ QUẢ: KHÔNG CẦN CƠ CHẾ CHỐNG TRÙNG ───
 *
 * `sourceKey` là khoá tự nhiên tại nguồn. Hai việc cho cùng một gốc không biểu diễn được. Và việc
 * được giải quyết tại nguồn thì TỰ rơi khỏi hàng đợi — không job nào phải đóng hộ.
 */

export const WORK_SOURCES = [
  "CS_CASE",
  "SHIPMENT_CARE",
  "RETURN_INSPECTION",
  "FULFILLMENT_EXCEPTION",
  "BANK_EXCEPTION",
  "COD_EXCEPTION",
  "ADS_DECISION",
  "INVENTORY_EXCEPTION",
  "ALERT",
  "MANUAL_TASK",
  "RECURRING_TASK",
] as const;
export type WorkSource = (typeof WORK_SOURCES)[number];

export type StatusAuthority = "SOURCE" | "WORK";

export type WorkSourceSpec = {
  key: WorkSource;
  label: string;
  /** Vì sao nguồn này là một việc phải làm, chứ không phải một con số để ngắm. */
  why: string;
  statusAuthority: StatusAuthority;
  /** Phòng ban mặc định. `null` = suy theo từng dòng (việc tay, cảnh báo suy theo `CASE_TEAM`). */
  department: DepartmentCode | null;
  /** Thực thể nghiệp vụ đứng sau: `ORDER` · `SHIPMENT` · `BANK_TXN` · `CAMPAIGN` · `VARIANT` · `NONE`. */
  businessEntity: string;
  /** Giờ tính hạn kể từ lúc việc xuất hiện. `null` = loại việc này CỐ Ý không đặt hạn. */
  slaHours: number | null;
  /**
   * Kết quả của việc này có được tính vào trục "Kết quả" của người xử lý không.
   *
   * `false` với những việc mà kết quả nằm NGOÀI tầm kiểm soát của người làm: ĐVVC giao hỏng không
   * phải lỗi CSKH (yêu cầu mục 11). Người vẫn được ghi nhận ở trục SLA và Năng suất, nhưng không
   * bị trừ điểm vì một kết quả họ không quyết được.
   */
  outcomeAttributable: boolean;
  /** Hành động riêng của nguồn (ngoài `WORK_COMMON_ACTIONS`). */
  actions: WorkActionKey[];
};

export const WORK_SOURCE_SPEC: Record<WorkSource, WorkSourceSpec> = {
  CS_CASE: {
    key: "CS_CASE",
    label: "Case CSKH",
    why: "Có một khách thật đang chờ trả lời ở đầu kia.",
    statusAuthority: "SOURCE",
    department: "SALES",
    businessEntity: "ORDER",
    slaHours: CASE_SLA_HOURS.CS_CASE,
    outcomeAttributable: true,
    actions: ["CS_CHAT", "CS_OPEN_POS", "CS_CLAIM", "CS_CONTACTED", "CS_SNOOZE", "CS_DONE", "OPEN_ORDER"],
  },
  SHIPMENT_CARE: {
    key: "SHIPMENT_CARE",
    label: "Care vận đơn",
    why: "Kiện hàng đang mắc ở đâu đó ngoài kho; mỗi giờ trôi qua là gần hơn tới một đơn hoàn.",
    statusAuthority: "SOURCE",
    department: "LOGISTICS",
    businessEntity: "SHIPMENT",
    slaHours: CARE_SLA.resolveHours,
    // Người care không quyết được bưu tá có giao được hay không. Họ chịu trách nhiệm về VIỆC HỌ LÀM
    // (gọi kịp, ghi nhận, gửi yêu cầu ĐVVC), đo ở trục SLA — không phải về kết quả chuyến giao.
    outcomeAttributable: false,
    actions: ["CARE_OPEN", "CARE_NOTE", "CARE_FOLLOW_UP", "CARE_OWNER", "CARRIER_REQUEST", "CARE_RESOLVE", "OPEN_ORDER"],
  },
  RETURN_INSPECTION: {
    key: "RETURN_INSPECTION",
    label: "Hàng hoàn chờ kiểm đếm",
    why: "ĐVVC đã trả hàng về nhưng kho chưa lập phiếu — hàng hoàn KHÔNG tự vào tồn, nên đây là vốn đang không ai đếm.",
    statusAuthority: "SOURCE",
    department: "WAREHOUSE",
    businessEntity: "SHIPMENT",
    slaHours: CASE_SLA_HOURS.RETURN_RECEIVED_PENDING_INSPECTION,
    outcomeAttributable: true,
    actions: ["RETURN_RECEIVE", "RETURN_OPEN_INSPECTION", "OPEN_SHIPMENT", "OPEN_ORDER"],
  },
  FULFILLMENT_EXCEPTION: {
    key: "FULFILLMENT_EXCEPTION",
    label: "Nút thắt fulfillment",
    why: "Đơn đã chốt nhưng chưa ra khỏi kho. Hàng còn trong tay shop, nên đây là nhóm cứu được trọn vẹn.",
    statusAuthority: "SOURCE",
    department: "WAREHOUSE",
    businessEntity: "ORDER",
    slaHours: CASE_SLA_HOURS.ORDER_CONFIRMATION_STALE,
    outcomeAttributable: true,
    actions: ["OPEN_ORDER", "OPEN_SHIPMENT"],
  },
  BANK_EXCEPTION: {
    key: "BANK_EXCEPTION",
    label: "Dòng tiền chưa phân loại",
    why: "Chưa phân loại thì khoản tiền đó không vào được báo cáo nào — số dư khớp nhưng lợi nhuận sai.",
    statusAuthority: "SOURCE",
    department: "FINANCE",
    businessEntity: "BANK_TXN",
    slaHours: 72,
    outcomeAttributable: true,
    actions: ["BANK_CLASSIFY", "BANK_LINK", "BANK_OPEN"],
  },
  COD_EXCEPTION: {
    key: "COD_EXCEPTION",
    label: "COD quá hạn chưa về",
    why: "Hàng đã giao nhưng tiền chưa về — tiền của shop đang nằm ở ĐVVC.",
    statusAuthority: "SOURCE",
    department: "FINANCE",
    businessEntity: "SHIPMENT",
    slaHours: CASE_SLA_HOURS.COD_OVERDUE,
    outcomeAttributable: true,
    actions: ["COD_OPEN", "OPEN_SHIPMENT"],
  },
  ADS_DECISION: {
    key: "ADS_DECISION",
    label: "Quyết định quảng cáo",
    why: "Một dòng đang đốt tiền hoặc đang bị bỏ phí — để thêm một ngày là mất thêm đúng một ngày chi phí.",
    statusAuthority: "SOURCE",
    department: "MARKETING",
    businessEntity: "CAMPAIGN",
    slaHours: CASE_SLA_HOURS.ADS_ANOMALY,
    outcomeAttributable: true,
    // CỐ Ý chỉ có nút MỞ. ERP đọc Facebook Ads chứ không ghi (`lib/integrations/facebook/*` không
    // có hàm bật/tắt), nên một nút "Tạm dừng" ở đây sẽ là nút giả: người bấm tin đã xong, tiền vẫn chảy.
    actions: ["ADS_OPEN"],
  },
  INVENTORY_EXCEPTION: {
    key: "INVENTORY_EXCEPTION",
    label: "Cảnh báo tồn kho",
    why: "Sắp hết hàng hoặc đang mất đơn vì hết hàng — đặt sản xuất kịp thì không mất doanh thu nào.",
    statusAuthority: "SOURCE",
    department: "WAREHOUSE",
    businessEntity: "VARIANT",
    slaHours: CASE_SLA_HOURS.STOCKOUT_RISK,
    outcomeAttributable: true,
    actions: ["OPEN_SOURCE"],
  },
  ALERT: {
    key: "ALERT",
    label: "Cảnh báo vận hành",
    why: "Việc do job cảnh báo phát hiện, chưa thuộc hàng đợi chuyên biệt nào.",
    statusAuthority: "SOURCE",
    // Suy theo `CASE_TEAM` của từng loại việc — xem `departmentOfAlert`.
    department: null,
    businessEntity: "NONE",
    slaHours: null,
    outcomeAttributable: true,
    actions: ["OPEN_SOURCE"],
  },
  MANUAL_TASK: {
    key: "MANUAL_TASK",
    label: "Việc giao tay",
    why: "Việc do quản lý giao, không sinh ra từ một sự kiện nghiệp vụ nào.",
    statusAuthority: "WORK",
    department: null,
    businessEntity: "NONE",
    slaHours: null,
    outcomeAttributable: true,
    actions: ["WORK_STATUS", "WORK_ASSIGN", "WORK_DUE", "WORK_PRIORITY"],
  },
  RECURRING_TASK: {
    key: "RECURRING_TASK",
    label: "Việc định kỳ",
    why: "Việc lặp theo lịch: đối soát hằng ngày, review quảng cáo, kiểm kê, chốt công.",
    statusAuthority: "WORK",
    department: null,
    businessEntity: "NONE",
    slaHours: null,
    outcomeAttributable: true,
    actions: ["WORK_STATUS", "WORK_ASSIGN", "WORK_DUE"],
  },
};

/* ═══════════════════ CẢNH BÁO: NGUỒN NÀO SỞ HỮU LOẠI NÀO ═══════════════════ */

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

/** Nguồn thật của một loại cảnh báo: nguồn chuyên biệt nếu có, còn lại là `ALERT`. */
export function sourceOfAlert(type: CaseType): WorkSource {
  return ALERT_KIND_TO_SOURCE[type] ?? "ALERT";
}

/** Nguồn mà `work_items` giữ trạng thái. Chỉ những nguồn này được ghi cột `status`. */
export const WORK_OWNED_SOURCES: WorkSource[] = WORK_SOURCES.filter((s) => WORK_SOURCE_SPEC[s].statusAuthority === "WORK");

/** Nguồn chiếu từ miền nghiệp vụ. Dòng `work_items` của chúng là lớp ghi chú, `status` phải `NULL`. */
export const PROJECTED_SOURCES: WorkSource[] = WORK_SOURCES.filter((s) => WORK_SOURCE_SPEC[s].statusAuthority === "SOURCE");

export function isWorkSource(s: string): s is WorkSource {
  return (WORK_SOURCES as readonly string[]).includes(s);
}

export function authorityOf(source: WorkSource): StatusAuthority {
  return WORK_SOURCE_SPEC[source].statusAuthority;
}

/** Bộ nút của một nguồn: nút riêng của nguồn + bốn nút chung. Thứ tự: việc chuyên môn trước. */
export function actionsOf(source: WorkSource): WorkActionKey[] {
  const own = WORK_SOURCE_SPEC[source].actions;
  return [...own, ...WORK_COMMON_ACTIONS.filter((a) => !own.includes(a))];
}

/** Cảnh báo không có phòng ban cố định — suy theo nhóm việc của loại cảnh báo. */
export function departmentOfAlert(type: CaseType): DepartmentCode {
  return TEAM_DEPARTMENT[CASE_TEAM[type]];
}

// ═══════════════════ BẢN ĐỒ TRẠNG THÁI VỀ NGÔN NGỮ CHUNG ═══════════════════
//
// Mỗi bản đồ phải PHỦ HẾT giá trị của nguồn. `tests/work-os.test.ts` duyệt danh sách trạng thái
// gốc và đỏ nếu thiếu một giá trị — thêm trạng thái ở `shipment_care` mà quên khai ở đây thì việc
// đó sẽ rơi âm thầm vào `NEW` và không ai biết.

export const CS_STATUS_TO_WORK: Record<CsStatus, WorkStatus> = {
  OPEN: "NEW",
  IN_PROGRESS: "IN_PROGRESS",
  DONE: "DONE",
  // Điều kiện tự hết — KHÔNG phải công của ai. Vẫn là DONE ở hàng đợi, nhưng `resolvedBy` rỗng nên
  // trục Năng suất không tính cho người nào (xem `lib/queries/work-performance.ts`).
  AUTO_RESOLVED: "DONE",
  CANCELLED: "CANCELLED",
};

export const CARE_STATUS_TO_WORK: Record<CareStatus, WorkStatus> = {
  NEW: "NEW",
  ASSIGNED: "ASSIGNED",
  IN_PROGRESS: "IN_PROGRESS",
  // Ba kiểu chờ khác nhau ở nguồn, nhưng cùng một nghĩa với người quản lý: đang chờ BÊN NGOÀI,
  // không ai trong shop gỡ được. Chi tiết chờ ai vẫn đọc được ở trạng thái gốc trên ngăn kéo.
  WAITING_CUSTOMER: "WAITING",
  WAITING_CARRIER: "WAITING",
  WAITING_REDELIVERY: "WAITING",
  RESOLVED: "DONE",
  // Đã đẩy lên cấp trên: việc CHƯA xong và đang mắc ở chỗ người xử lý không tự quyết được.
  ESCALATED: "BLOCKED",
  CANCELLED: "CANCELLED",
};

export const ALERT_STATUS_TO_WORK: Record<CaseStatus, WorkStatus> = {
  OPEN: "NEW",
  ACKNOWLEDGED: "ASSIGNED",
  IN_PROGRESS: "IN_PROGRESS",
  RESOLVED: "DONE",
  AUTO_RESOLVED: "DONE",
  // Đóng vì thôi theo dõi: KHÔNG phải đã xử lý. Xếp vào `CANCELLED` để không bị đếm là thành tích.
  CLOSED_STALE: "CANCELLED",
  IGNORED: "CANCELLED",
};

/** Lá chắn khai báo — mọi nguồn phải có bộ nút và lời giải thích. Kiểm ở `tests/work-os.test.ts`. */
export const SOURCES_WITHOUT_ACTIONS: WorkSource[] = WORK_SOURCES.filter((s) => !WORK_SOURCE_SPEC[s].actions.length && WORK_SOURCE_SPEC[s].statusAuthority === "SOURCE");

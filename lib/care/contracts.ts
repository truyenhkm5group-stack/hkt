import type { CareEventAction, CareEventSource, CareReasonClass, CareReasonKey, CareStatus, CareView, CarrierActionKey, CarrierRequestStatus } from "@/lib/constants/care";

/**
 * ═══════════ HỢP ĐỒNG KIỂU CỦA CARE ENGINE — ĐÃ CHỐT, KHÔNG ĐỔI TÊN/HÌNH DẠNG TUỲ TIỆN ═══════════
 *
 * UI (Claude Opus) và AI Copilot chỉ dùng các kiểu ở đây. Muốn thêm trường thì THÊM (optional),
 * không đổi tên, không đổi nghĩa. Mọi ngày giờ là `Date` ở máy chủ và được React Flight tuần tự
 * hoá thành Date ở client; qua JSON thuần thì là chuỗi ISO.
 *
 * Nguồn dữ liệu: `lib/queries/care-workbench.ts` (đọc), `lib/care/service.ts` (ghi),
 * Server Actions ở `lib/actions/care-workbench.ts`.
 */

/** Lớp care của một kiện — TÁCH RỜI trạng thái ĐVVC. */
export type CareState = {
  status: CareStatus;
  owner: { id: string; name: string } | null;
  followUpAt: Date | null;
  lastNote: string;
  lastNoteAt: Date | null;
  lastNoteBy: string;
  /** Lần đầu có NGƯỜI động vào (đổi trạng thái / giao / note / hẹn). */
  firstResponseAt: Date | null;
  /** Mốc đóng gần nhất (RESOLVED / CANCELLED). Giữ nguyên khi mở lại để tính "mở lại". */
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
  /** Số lần đã gọi API (retry hữu hạn). */
  attempts: number;
};

export type CareSlaView = {
  firstResponseDueAt: Date;
  resolveDueAt: Date;
  firstResponseBreached: boolean;
  resolveBreached: boolean;
};

/** Trạng thái năng lực ĐVVC cho MỘT hành động trên MỘT kiện — xem `lib/care/carrier-capabilities.ts`. */
export type CarrierCapabilityStatus = "SUPPORTED" | "UNSUPPORTED" | "WEB_ONLY" | "PERMISSION_MISSING" | "UNKNOWN";

export type CarrierCapabilityView = {
  actionKey: CarrierActionKey;
  status: CarrierCapabilityStatus;
  /** Chặng hiện tại có cho phép hành động này không (luật nghiệp vụ, độc lập với năng lực API). */
  allowedAtStage: boolean;
  /** Vì sao — một câu, để UI hiện tooltip. */
  reason: string;
  /** Có làm được trên web viettelpost.vn không (khi API không hỗ trợ / không có quyền). */
  webUrl: string | null;
};

/** Một kiện trong hàng đợi care. */
export type CareCase = {
  shipmentId: string;
  tracking: string;
  orderId: string | null;
  orderSystemId: number | null;
  customer: string;
  phone: string;
  codAmount: number;
  /** CHIỀU ĐVVC — chứng từ, chỉ đọc. */
  carrier: {
    stage: string;
    stageLabel: string;
    rawStatus: string;
    ageHours: number | null;
    failedAttempts: number;
    /** Tài khoản API có đọc được kiện này không. */
    trackingCapability: "API_TRACKABLE" | "WEBHOOK_ONLY" | "UNKNOWN_CAPABILITY";
  };
  reason: CareReasonKey;
  reasonClass: CareReasonClass;
  reasonLabel: string;
  reasonDetail: string;
  nextAction: string;
  /** Lúc kiện VÀO điều kiện cần care — mốc tính SLA. */
  queueSince: Date;
  sla: CareSlaView;
  /** CHIỀU CARE — đội đã làm tới đâu. */
  care: CareState;
  reopened: boolean;
  lastCareAction: { label: string; at: Date; byHuman: boolean } | null;
  carrierRequest: CarrierRequestView | null;
  /** Rút gọn: có gửi thẳng API được không. Chi tiết từng hành động ở `getCareCaseDetail().capabilities`. */
  carrierCapability: "API" | "MANUAL";
  view: Exclude<CareView, "all">;
};

/**
 * HÀNG ĐỢI MẶC ĐỊNH = đúng tập kiện cần người. Không phải toàn bộ vận đơn.
 * `cases` là CUSTOMER_ACTION + CARRIER_ACTION (+ kiện đã đóng trong 7 ngày cho tab Đã xử lý);
 * `dataGaps` là kiện cũ dữ liệu / thiếu dữ liệu — việc của giao vận, KHÔNG tính vào backlog care.
 */
export type CareQueue = {
  cases: CareCase[];
  dataGaps: CareCase[];
  counts: Record<Exclude<CareView, "all">, number>;
  /** Backlog theo lý do (chỉ kiện đang ở góc nhìn Cần care). */
  byReason: { reason: CareReasonKey; label: string; count: number; money: number }[];
  /** Backlog theo người (chỉ kiện đang mở, kể cả chờ / escalate). */
  byOwner: { ownerId: string | null; name: string; open: number; overdue: number; money: number }[];
  moneyAtRisk: number;
  overdue: number;
  unassigned: number;
  measuredAt: Date;
};

/** Một dòng lịch sử case — chỉ thêm. */
export type CareEvent = {
  id: string;
  at: Date;
  actor: string;
  source: CareEventSource;
  action: CareEventAction;
  note: string;
  previousStatus: CareStatus | null;
  nextStatus: CareStatus | null;
  previousOwner: string | null;
  nextOwner: string | null;
  followUpAt: Date | null;
  sla: { queueSince: string; firstResponseDueAt: string; resolveDueAt: string; firstResponseBreached: boolean; resolveBreached: boolean } | null;
  payload: unknown;
};

/** Toàn bộ bối cảnh một kiện — cho ngăn kéo và cho AI tóm tắt. */
export type CareCaseDetail = {
  shipment: {
    id: string;
    tracking: string;
    carrier: string;
    stage: string;
    stageLabel: string;
    rawStatus: string;
    codAmount: number;
    receiver: { name: string; phone: string; address: string };
    attemptNo: number | null;
    trackingCapability: "API_TRACKABLE" | "WEBHOOK_ONLY" | "UNKNOWN_CAPABILITY";
  };
  order: { id: string; systemId: number | null; total: number; prepaid: number; items: { name: string; qty: number; price: number }[]; chatUrl: string | null } | null;
  customer: { name: string; phone: string; history: { delivered: number; returned: number; totalOrders: number } | null };
  /** Hành trình ĐVVC thô, mới nhất trước. */
  journey: { at: Date; status: string; note: string; location: string; source: string }[];
  care: CareState;
  queueSince: Date | null;
  sla: CareSlaView | null;
  events: CareEvent[];
  careActions: { kind: string; label: string; note: string; actor: string; at: Date }[];
  carrierRequests: CarrierRequestView[];
  capabilities: CarrierCapabilityView[];
};

/** Kết quả chuẩn của mọi hàm ghi. */
export type CareResult<T> = { ok: true; data: T } | { error: string };
/** Kết quả hàng loạt: kiện nào đổi được, kiện nào bị bỏ qua và vì sao. */
export type CareBulkResult = { states: Record<string, CareState>; skipped: { shipmentId: string; reason: string }[] };

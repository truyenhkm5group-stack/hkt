import type { DepartmentCode } from "@/lib/constants/departments";

/**
 * ═══════════ MÔ HÌNH CÔNG VIỆC CHUNG ═══════════
 *
 * Đặc tả đầy đủ: `docs/work-management-os.md`.
 *
 * Bảy trạng thái, và con số bảy là một quyết định. Mỗi miền trong ERP hiện có một bảng trạng thái
 * riêng — `shipment_care` có 9, `cs_cases` có 4, hàng đợi cảnh báo có 7 — và chúng KHÔNG bị ép đổi.
 * Cái ở đây là NGÔN NGỮ CHUNG để một người nhìn được cả sáu hàng đợi trong một danh sách. Mỗi nguồn
 * khai bản đồ riêng sang bảy trạng thái này (`WORK_SOURCE_SPEC[...].mapStatus`).
 */

export const WORK_STATUSES = ["NEW", "ASSIGNED", "IN_PROGRESS", "BLOCKED", "WAITING", "DONE", "CANCELLED"] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

export const WORK_STATUS_LABEL: Record<WorkStatus, string> = {
  NEW: "Chưa ai nhận",
  ASSIGNED: "Đã giao người",
  IN_PROGRESS: "Đang làm",
  BLOCKED: "Bị chặn",
  WAITING: "Chờ bên ngoài",
  DONE: "Xong",
  CANCELLED: "Huỷ / không làm",
};

/**
 * `BLOCKED` ≠ `WAITING`, và gộp chúng là mất đúng thứ trưởng phòng cần.
 *
 *  · `BLOCKED` — TA không đi tiếp được: thiếu thông tin, chờ một quyết định nội bộ, chờ người khác
 *    trong shop. Đây là nút thắt GỠ ĐƯỢC, và nó nằm trong tầm kiểm soát.
 *  · `WAITING` — đang chờ BÊN NGOÀI: khách, ĐVVC, ngân hàng. Không ai gỡ được, chỉ chờ hoặc giục.
 *
 * Một phòng có 30 việc `WAITING` là bình thường. Một phòng có 30 việc `BLOCKED` là đang hỏng.
 */
export const WORK_STATUS_HINT: Record<WorkStatus, string> = {
  NEW: "Việc đã xuất hiện nhưng chưa ai cầm",
  ASSIGNED: "Đã có người chịu trách nhiệm, chưa bắt tay vào",
  IN_PROGRESS: "Đang xử lý",
  BLOCKED: "Không đi tiếp được vì thiếu thông tin / chờ quyết định nội bộ — GỠ ĐƯỢC",
  WAITING: "Đang chờ khách / ĐVVC / ngân hàng — không ai trong shop gỡ được",
  DONE: "Đã xử lý xong",
  CANCELLED: "Cố ý không làm, có lý do",
};

export const WORK_STATUS_TONE: Record<WorkStatus, string> = {
  NEW: "bg-muted text-muted-foreground",
  ASSIGNED: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  IN_PROGRESS: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  BLOCKED: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  WAITING: "bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
  DONE: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  CANCELLED: "bg-muted text-muted-foreground line-through",
};

/** Trạng thái CÒN VIỆC PHẢI LÀM. Hàng đợi mặc định chỉ hiện những trạng thái này. */
export const WORK_OPEN_STATUSES: WorkStatus[] = ["NEW", "ASSIGNED", "IN_PROGRESS", "BLOCKED", "WAITING"];
export const WORK_CLOSED_STATUSES: WorkStatus[] = ["DONE", "CANCELLED"];

export function isOpenStatus(s: WorkStatus): boolean {
  return WORK_OPEN_STATUSES.includes(s);
}

/**
 * Chuyển trạng thái hợp lệ cho việc do `work_items` sở hữu (việc tay / định kỳ).
 * Việc thuộc miền nghiệp vụ đi theo bảng chuyển của miền đó, không phải bảng này.
 */
export const WORK_TRANSITIONS: Record<WorkStatus, WorkStatus[]> = {
  NEW: ["ASSIGNED", "IN_PROGRESS", "CANCELLED"],
  ASSIGNED: ["IN_PROGRESS", "BLOCKED", "WAITING", "DONE", "CANCELLED", "NEW"],
  IN_PROGRESS: ["BLOCKED", "WAITING", "DONE", "CANCELLED", "ASSIGNED"],
  BLOCKED: ["IN_PROGRESS", "WAITING", "DONE", "CANCELLED"],
  WAITING: ["IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"],
  // Mở lại được: việc tưởng xong mà quay lại là chuyện thật, và phải để lại dấu (work_item_events).
  DONE: ["IN_PROGRESS"],
  CANCELLED: ["NEW"],
};

export function canTransition(from: WorkStatus, to: WorkStatus): boolean {
  return WORK_TRANSITIONS[from].includes(to);
}

// ───────────────────────── Mức ưu tiên ─────────────────────────

export const WORK_PRIORITIES = ["URGENT", "HIGH", "NORMAL", "LOW"] as const;
export type WorkPriority = (typeof WORK_PRIORITIES)[number];

export const WORK_PRIORITY_LABEL: Record<WorkPriority, string> = {
  URGENT: "Gấp",
  HIGH: "Cao",
  NORMAL: "Bình thường",
  LOW: "Thấp",
};

export const WORK_PRIORITY_TONE: Record<WorkPriority, string> = {
  URGENT: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  HIGH: "bg-orange-100 text-orange-800 dark:bg-orange-950/60 dark:text-orange-300",
  NORMAL: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  LOW: "bg-muted text-muted-foreground",
};

export const WORK_PRIORITY_RANK: Record<WorkPriority, number> = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 };

// ───────────────────────── SLA ─────────────────────────

/**
 * Trạng thái hạn. `NONE` KHÔNG phải "đúng hạn" — nó là "loại việc này cố ý không đặt hạn".
 * Trộn hai thứ đó thì tỷ lệ đúng hạn được thổi lên bằng chính những việc không ai đo.
 */
export const SLA_STATES = ["BREACHED", "DUE_SOON", "OK", "NONE"] as const;
export type SlaState = (typeof SLA_STATES)[number];

export const SLA_STATE_LABEL: Record<SlaState, string> = {
  BREACHED: "Quá hạn",
  DUE_SOON: "Sắp tới hạn",
  OK: "Trong hạn",
  NONE: "Không đặt hạn",
};

/** Còn dưới ngần này giờ là "sắp tới hạn". */
export const SLA_DUE_SOON_HOURS = 4;

export function slaStateOf(slaAt: Date | null | undefined, now: Date): SlaState {
  if (!slaAt) return "NONE";
  const left = (slaAt.getTime() - now.getTime()) / 3_600_000;
  if (left < 0) return "BREACHED";
  if (left <= SLA_DUE_SOON_HOURS) return "DUE_SOON";
  return "OK";
}

// ───────────────────────── Tiền ─────────────────────────

export const MONEY_CONFIDENCES = ["MEASURED", "ESTIMATED", "UNKNOWN"] as const;
export type MoneyConfidence = (typeof MONEY_CONFIDENCES)[number];

export const MONEY_CONFIDENCE_LABEL: Record<MoneyConfidence, string> = {
  MEASURED: "Đo được",
  ESTIMATED: "Ước tính",
  UNKNOWN: "Chưa tra được",
};

/**
 * TIỀN GẮN VỚI MỘT VIỆC.
 *
 * `null` là CHƯA BIẾT, không phải 0 (AGENTS.md mục 0.3). Một việc chưa tra được tiền mà ghi `0đ`
 * thì tổng của hàng đợi thành một con số thấp giả, và người đọc không có cách nào biết.
 *
 * `atRisk`      — tiền đang bị giữ / sẽ mất nếu không ai làm.
 * `recoverable` — phần lấy lại được hoặc tạo thêm được NẾU làm. KHÔNG bao giờ là giá bán của hàng
 *                 hoàn: hàng về kho là lấy lại VỐN (xem `lib/queries/return-pipeline.ts`).
 * `basis`       — câu nói rõ CĂN CỨ. Bắt buộc khi `confidence` khác `UNKNOWN`; contract test khoá.
 */
export type WorkMoney = {
  atRisk: number | null;
  recoverable: number | null;
  confidence: MoneyConfidence;
  basis: string;
};

export const MONEY_UNKNOWN: WorkMoney = { atRisk: null, recoverable: null, confidence: "UNKNOWN", basis: "" };

/** Cộng tiền của nhiều việc mà KHÔNG giấu mẫu số: trả về cả số dòng chưa tra được. */
export function sumMoney(items: { money: WorkMoney }[]): { atRisk: number; recoverable: number; unknown: number; known: number } {
  let atRisk = 0;
  let recoverable = 0;
  let unknown = 0;
  let known = 0;
  for (const it of items) {
    if (it.money.atRisk === null && it.money.recoverable === null) {
      unknown += 1;
      continue;
    }
    known += 1;
    atRisk += it.money.atRisk ?? 0;
    recoverable += it.money.recoverable ?? 0;
  }
  return { atRisk, recoverable, unknown, known };
}

// ───────────────────────── Nguồn tạo việc ─────────────────────────

export const CREATION_SOURCES = ["AUTO", "MANUAL", "RECURRING"] as const;
export type CreationSource = (typeof CREATION_SOURCES)[number];

export const CREATION_SOURCE_LABEL: Record<CreationSource, string> = {
  AUTO: "Hệ thống phát hiện",
  MANUAL: "Giao tay",
  RECURRING: "Việc định kỳ",
};

// ───────────────────────── Hình dạng một việc ─────────────────────────

export type WorkActor = { id: string | null; email: string; name: string };

export type WorkEvidence = { source: string; detail: string };

/**
 * MỘT VIỆC, HÌNH DẠNG CHUNG CHO MỌI NGUỒN.
 *
 * `key` = `"<sourceType>:<sourceKey>"`. `sourceKey` là KHOÁ TỰ NHIÊN TẠI NGUỒN, nên "hai việc cho
 * cùng một gốc" là điều không biểu diễn được — chống trùng là tính chất cấu trúc, không phải một
 * cơ chế phải bảo trì.
 */
export type WorkItem = {
  key: string;
  sourceType: string;
  sourceKey: string;
  title: string;
  summary: string;
  department: DepartmentCode;
  assignee: WorkActor | null;
  status: WorkStatus;
  /** Ai giữ trạng thái: miền nghiệp vụ (`SOURCE`) hay chính bảng `work_items` (`WORK`). */
  statusAuthority: "SOURCE" | "WORK";
  priority: WorkPriority;
  /** Điểm ưu tiên 0–100, dùng lại thang của `lib/constants/action-queue.ts`. */
  score: number;
  createdAt: Date;
  startedAt: Date | null;
  dueAt: Date | null;
  slaAt: Date | null;
  completedAt: Date | null;
  /** Hoãn tới. Việc bị hoãn không biến mất, nó chỉ không nổi lên trước giờ đó. */
  snoozedUntil: Date | null;
  businessEntity: string;
  businessEntityId: string;
  sourceUrl: string;
  money: WorkMoney;
  tags: string[];
  evidence: WorkEvidence;
  blockedReason: string;
  creationSource: CreationSource;
  /** Khoá hành động nhanh làm được ngay trên dòng — xem `lib/constants/work-actions.ts`. */
  actions: string[];
  /** Việc nên làm, một câu. */
  recommendedAction: string;
};

export function workKey(sourceType: string, sourceKey: string): string {
  return `${sourceType}:${sourceKey}`;
}

export function parseWorkKey(key: string): { sourceType: string; sourceKey: string } | null {
  const i = key.indexOf(":");
  if (i <= 0 || i === key.length - 1) return null;
  return { sourceType: key.slice(0, i), sourceKey: key.slice(i + 1) };
}

// ───────────────────────── Rổ của "Việc của tôi" ─────────────────────────

/**
 * SÁU RỔ, XẾP THEO THỨ TỰ PHẢI LÀM — không phải theo thứ tự bảng chữ cái.
 *
 * Mặc định KHÔNG hiện việc đã xong: một người mở trang lên để biết làm gì tiếp, không phải để ngắm
 * thành tích. Việc đã xong nằm ở bộ lọc riêng.
 */
export const MY_WORK_BUCKETS = ["OVERDUE", "NOW", "TODAY", "DOING", "WAITING", "UPCOMING"] as const;
export type MyWorkBucket = (typeof MY_WORK_BUCKETS)[number];

export const MY_WORK_BUCKET_LABEL: Record<MyWorkBucket, string> = {
  OVERDUE: "Quá hạn",
  NOW: "Cần làm ngay",
  TODAY: "Hôm nay",
  DOING: "Đang làm",
  WAITING: "Chờ",
  UPCOMING: "Sắp tới",
};

export const MY_WORK_BUCKET_HINT: Record<MyWorkBucket, string> = {
  OVERDUE: "Đã vỡ hạn — làm trước hết",
  NOW: "Gấp hoặc sắp vỡ hạn trong vài giờ tới",
  TODAY: "Đến hạn trong hôm nay",
  DOING: "Đang cầm dở",
  WAITING: "Đang chờ khách / ĐVVC / ngân hàng hoặc bị chặn",
  UPCOMING: "Hạn còn xa, chưa phải việc của hôm nay",
};

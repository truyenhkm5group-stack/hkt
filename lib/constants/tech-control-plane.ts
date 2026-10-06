/**
 * ═══════════ MẶT PHẲNG ĐIỀU KHIỂN CÔNG TY — GOAL · MISSION · VÒNG ĐỜI CHUẨN ═══════════
 *
 * Kiến trúc: docs/tech-control-plane/README.md. Tệp THUẦN, CLIENT-SAFE (không import `@/db`).
 *
 * ─── LƯU QUYẾT ĐỊNH, SUY RA TIẾN ĐỘ ───
 *
 * Goal và Mission chỉ LƯU điều người quyết (bắt đầu · tạm dừng · chốt xong · huỷ). "Đang chạy", "đang
 * chờ chủ shop", "có việc đỏ", "xong bao nhiêu phần" là HÀM THUẦN của các việc bên dưới, tính lúc đọc
 * (`deriveMissionExecution`). Không job nào ghi lại chúng — nên chúng không bao giờ cũ, và không có nơi
 * thứ hai giữ cùng một sự thật (AGENTS.md mục 19, 26, 32).
 *
 * ─── VÒNG ĐỜI CHUẨN LÀ PHÉP CHIẾU, KHÔNG PHẢI CỘT THỨ HAI ───
 *
 * `tech_tasks.status` (13 + 2 trạng thái, `lib/constants/tech.ts`) vẫn là nơi DUY NHẤT giữ trạng thái
 * việc và là máy trạng thái DUY NHẤT. Vòng đời chuẩn của chủ shop (BACKLOG → … → DONE) là phép chiếu tất
 * định của trạng thái đó + lease + phụ thuộc (`canonicalTaskState`). Không đổi tên, không UPDATE hàng loạt
 * dữ liệu production.
 */
import { TECH_TASK_TERMINAL, type TechTaskStatus } from "@/lib/constants/tech";

/* ═════════════════════ DỰ ÁN / SẢN PHẨM ═════════════════════ */

/**
 * Dự án công ty quản qua `/tech`. Bảng `tech_projects` là nơi giữ (thêm dự án không cần deploy); bốn dòng
 * dưới đây được migration gieo MỘT LẦN và là khoá ổn định mà mã nguồn được phép gọi tên.
 *
 * Đây là DỰ ÁN KỸ THUẬT, không phải KHÁCH THUÊ: một tổ chức khách của SaaS không sinh ra một dự án ở đây.
 */
export const TECH_SEED_PROJECTS = [
  { key: "erp", name: "VNXCommerce ERP", description: "ERP vận hành shop thời trang — đơn, vận đơn, kho, tài chính, lương." },
  { key: "chotdon", name: "ChotDonTuDong", description: "AI chốt đơn qua Messenger / Zalo cho shop bán hàng online." },
  { key: "hslc", name: "HSLC", description: "Quảng cáo hiệu suất · lập camp · creative." },
  { key: "saas", name: "SaaS Platform", description: "Lớp nền tảng nhiều tổ chức: tài khoản, gói, thu phí, tách dữ liệu." },
] as const;

/** Khoá dự án: chữ thường, số, gạch nối — đọc được trên URL và trong tên nhánh. Cùng biểu thức với CHECK ở CSDL. */
export const TECH_PROJECT_KEY_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

/* ═════════════════════ GOAL ═════════════════════ */

export const TECH_GOAL_STATUSES = ["DRAFT", "ACTIVE", "PAUSED", "ACHIEVED", "ABANDONED"] as const;
export type TechGoalStatus = (typeof TECH_GOAL_STATUSES)[number];

export const TECH_GOAL_STATUS_LABEL: Record<TechGoalStatus, string> = {
  DRAFT: "Nháp",
  ACTIVE: "Đang theo đuổi",
  PAUSED: "Tạm dừng",
  ACHIEVED: "Đã đạt",
  ABANDONED: "Bỏ",
};

export const TECH_GOAL_STATUS_TONE: Record<TechGoalStatus, string> = {
  DRAFT: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  ACTIVE: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300",
  PAUSED: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  ACHIEVED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  ABANDONED: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
};

/** "Đã đạt" và "Bỏ" là KẾT THÚC: mục tiêu mới thì tạo mục tiêu mới, để kết quả của lần trước còn đọc được. */
export const TECH_GOAL_TRANSITIONS: Record<TechGoalStatus, TechGoalStatus[]> = {
  DRAFT: ["ACTIVE", "ABANDONED"],
  ACTIVE: ["PAUSED", "ACHIEVED", "ABANDONED"],
  PAUSED: ["ACTIVE", "ABANDONED"],
  ACHIEVED: [],
  ABANDONED: [],
};

export function canTransitionTechGoal(from: TechGoalStatus, to: TechGoalStatus) {
  return TECH_GOAL_TRANSITIONS[from].includes(to);
}

export function isTechGoalStatus(value: unknown): value is TechGoalStatus {
  return typeof value === "string" && (TECH_GOAL_STATUSES as readonly string[]).includes(value);
}

/* ═════════════════════ MISSION ═════════════════════ */

export const TECH_MISSION_STATUSES = ["PLANNING", "ACTIVE", "PAUSED", "DONE", "CANCELLED"] as const;
export type TechMissionStatus = (typeof TECH_MISSION_STATUSES)[number];

export const TECH_MISSION_STATUS_LABEL: Record<TechMissionStatus, string> = {
  PLANNING: "Đang lập kế hoạch",
  ACTIVE: "Đang chạy",
  PAUSED: "Tạm dừng",
  DONE: "Xong",
  CANCELLED: "Đã huỷ",
};

export const TECH_MISSION_STATUS_TONE: Record<TechMissionStatus, string> = {
  PLANNING: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  ACTIVE: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300",
  PAUSED: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  DONE: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  CANCELLED: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
};

/**
 * `PAUSED` là cái phanh: worker KHÔNG nhận việc của sứ mệnh đang dừng (Pha 2 đọc đúng cột này), việc đang
 * chạy chạy nốt lượt của nó. `DONE` đòi mọi việc đã kết thúc và có ít nhất một việc `DONE` (`missionDoneBlockers`).
 */
export const TECH_MISSION_TRANSITIONS: Record<TechMissionStatus, TechMissionStatus[]> = {
  PLANNING: ["ACTIVE", "CANCELLED"],
  ACTIVE: ["PAUSED", "DONE", "CANCELLED"],
  PAUSED: ["ACTIVE", "CANCELLED"],
  DONE: [],
  CANCELLED: [],
};

export function canTransitionTechMission(from: TechMissionStatus, to: TechMissionStatus) {
  return TECH_MISSION_TRANSITIONS[from].includes(to);
}

export function isTechMissionStatus(value: unknown): value is TechMissionStatus {
  return typeof value === "string" && (TECH_MISSION_STATUSES as readonly string[]).includes(value);
}

/* ═════════════════════ VÒNG ĐỜI CHUẨN CỦA VIỆC (PHÉP CHIẾU) ═════════════════════ */

export const CANONICAL_TASK_STATES = [
  "BACKLOG",
  "READY",
  "CLAIMED",
  "RUNNING",
  "REVIEW",
  "TESTING",
  "DEPLOYING",
  "VERIFYING",
  "DONE",
  "BLOCKED",
  "FAILED",
  "NEEDS_OWNER",
  "CANCELLED",
] as const;
export type CanonicalTaskState = (typeof CANONICAL_TASK_STATES)[number];

export const CANONICAL_TASK_STATE_LABEL: Record<CanonicalTaskState, string> = {
  BACKLOG: "Tồn đọng",
  READY: "Sẵn sàng nhận",
  CLAIMED: "Worker đã nhận",
  RUNNING: "Đang làm",
  REVIEW: "Đang review",
  TESTING: "Đang kiểm thử",
  DEPLOYING: "Chờ / đang deploy",
  VERIFYING: "Hậu kiểm production",
  DONE: "Xong",
  BLOCKED: "Bị chặn",
  FAILED: "Thất bại",
  NEEDS_OWNER: "Cần chủ shop",
  CANCELLED: "Đã huỷ",
};

/** Ánh xạ trạng thái LƯU → trạng thái chuẩn, trước khi xét lease và phụ thuộc. Bảng đóng, kiểm thử phủ mọi khoá. */
export const STORED_TO_CANONICAL: Record<TechTaskStatus, CanonicalTaskState> = {
  NEW: "BACKLOG",
  TRIAGED: "BACKLOG",
  SPEC_READY: "READY",
  BUILDING: "RUNNING",
  REVIEW: "REVIEW",
  QA: "TESTING",
  READY_TO_DEPLOY: "DEPLOYING",
  DEPLOYING: "DEPLOYING",
  OBSERVING: "VERIFYING",
  DONE: "DONE",
  BLOCKED: "BLOCKED",
  FAILED: "FAILED",
  ROLLED_BACK: "FAILED",
  NEEDS_OWNER: "NEEDS_OWNER",
  CANCELLED: "CANCELLED",
};

/**
 * VÒNG ĐỜI CHUẨN của một việc — hàm thuần.
 *
 *  · `SPEC_READY` mà còn phụ thuộc CHƯA kết thúc ⇒ `BACKLOG`: một việc chờ việc khác không "sẵn sàng",
 *    và để nó hiện READY là mời worker nhận một việc không làm được.
 *  · `SPEC_READY` có lease còn hạn ⇒ `CLAIMED` (worker đã nhận, lượt chạy chưa bắt đầu).
 *  · `openDependencies` = số việc phụ thuộc còn MỞ. `null` = CHƯA BIẾT (chưa đọc phụ thuộc) ⇒ không hạ
 *    xuống BACKLOG — không lấy sự thiếu thông tin làm bằng chứng.
 */
export function canonicalTaskState(input: {
  status: TechTaskStatus;
  leaseActive?: boolean;
  openDependencies?: number | null;
}): CanonicalTaskState {
  const base = STORED_TO_CANONICAL[input.status];
  if (base !== "READY") return base;
  if ((input.openDependencies ?? 0) > 0) return "BACKLOG";
  if (input.leaseActive) return "CLAIMED";
  return "READY";
}

/** Đếm phụ thuộc còn mở: mọi id không có trạng thái KẾT THÚC đều tính — kể cả id không tìm thấy (mất dấu ≠ xong). */
export function countOpenDependencies(dependsOn: readonly string[], statusById: ReadonlyMap<string, TechTaskStatus>): number {
  let open = 0;
  for (const id of dependsOn) {
    const s = statusById.get(id);
    // `CANCELLED` là kết thúc nhưng KHÔNG phải xong: việc phụ thuộc vào một việc đã huỷ không tự mở khoá —
    // người phải quyết lại (bỏ phụ thuộc, hoặc huỷ luôn việc này).
    if (s !== "DONE") open += 1;
  }
  return open;
}

/* ═════════════════════ TRẠNG THÁI THI HÀNH CỦA MISSION (SUY RA) ═════════════════════ */

export const MISSION_EXECUTION_STATES = ["EMPTY", "NEEDS_OWNER", "FAILED", "BLOCKED", "RUNNING", "READY", "BACKLOG", "COMPLETE", "ALL_CANCELLED"] as const;
export type MissionExecutionState = (typeof MISSION_EXECUTION_STATES)[number];

export const MISSION_EXECUTION_LABEL: Record<MissionExecutionState, string> = {
  EMPTY: "Chưa có việc",
  NEEDS_OWNER: "Đang chờ chủ shop",
  FAILED: "Có việc thất bại",
  BLOCKED: "Có việc bị chặn",
  RUNNING: "Đang chạy",
  READY: "Có việc sẵn sàng",
  BACKLOG: "Chỉ còn tồn đọng",
  COMPLETE: "Mọi việc đã kết thúc",
  ALL_CANCELLED: "Mọi việc đã huỷ — không phải xong",
};

export type MissionExecution = {
  state: MissionExecutionState;
  total: number;
  /** Đếm theo vòng đời chuẩn — đủ mọi khoá, kể cả 0. */
  byState: Record<CanonicalTaskState, number>;
  done: number;
  /** Phần trăm việc đã xong trong số việc KHÔNG bị huỷ. `null` khi chưa có việc nào tính được — không phải 0%. */
  progressPct: number | null;
};

const IN_FLIGHT: CanonicalTaskState[] = ["CLAIMED", "RUNNING", "REVIEW", "TESTING", "DEPLOYING", "VERIFYING"];

/**
 * Trạng thái thi hành của một sứ mệnh — hàm thuần của các việc bên dưới.
 *
 * Thứ tự ưu tiên là thứ tự CHỦ SHOP cần biết: chờ mình > hỏng > kẹt > đang chạy > sẵn sàng > tồn đọng.
 * Một sứ mệnh vừa có việc chạy vừa có việc chờ chủ shop thì in "chờ chủ shop" — đó là việc duy nhất
 * trên màn hình mà chỉ một người làm được.
 */
export function deriveMissionExecution(states: readonly CanonicalTaskState[]): MissionExecution {
  const byState = Object.fromEntries(CANONICAL_TASK_STATES.map((s) => [s, 0])) as Record<CanonicalTaskState, number>;
  for (const s of states) byState[s] += 1;
  const total = states.length;
  const done = byState.DONE;
  const counted = total - byState.CANCELLED;
  const progressPct = counted > 0 ? Math.round((done / counted) * 100) : null;

  let state: MissionExecutionState;
  if (total === 0) state = "EMPTY";
  else if (byState.NEEDS_OWNER > 0) state = "NEEDS_OWNER";
  else if (byState.FAILED > 0) state = "FAILED";
  else if (byState.BLOCKED > 0) state = "BLOCKED";
  else if (IN_FLIGHT.some((s) => byState[s] > 0)) state = "RUNNING";
  else if (byState.READY > 0) state = "READY";
  else if (byState.BACKLOG > 0) state = "BACKLOG";
  // Toàn việc huỷ KHÔNG phải xong — cùng câu `missionDoneBlockers` nói.
  else if (byState.CANCELLED === total) state = "ALL_CANCELLED";
  else state = "COMPLETE";

  return { state, total, byState, done, progressPct };
}

/** Gộp trạng thái thi hành của nhiều sứ mệnh (tiến độ một mục tiêu) — CÙNG hàm suy ra, không công thức thứ hai. */
export function mergeMissionExecutions(list: readonly MissionExecution[]): MissionExecution {
  const states: CanonicalTaskState[] = [];
  for (const e of list) for (const s of CANONICAL_TASK_STATES) for (let i = 0; i < e.byState[s]; i += 1) states.push(s);
  return deriveMissionExecution(states);
}

/**
 * Chốt sứ mệnh `DONE` khi nào — trả LÝ DO chặn (rỗng = được).
 * Mọi việc đã KẾT THÚC và ít nhất một việc `DONE`: sứ mệnh toàn việc huỷ là sứ mệnh huỷ, không phải xong.
 */
export function missionDoneBlockers(taskStatuses: readonly TechTaskStatus[]): string[] {
  const out: string[] = [];
  if (taskStatuses.length === 0) out.push("Sứ mệnh chưa có việc nào — không có gì để chốt là xong.");
  const conMo = taskStatuses.filter((s) => !TECH_TASK_TERMINAL.includes(s)).length;
  if (conMo > 0) out.push(`Còn ${conMo} việc chưa kết thúc — xong hết, hoặc huỷ có lý do, rồi mới chốt sứ mệnh.`);
  if (taskStatuses.length > 0 && !taskStatuses.includes("DONE")) out.push("Không việc nào xong — sứ mệnh toàn việc huỷ thì huỷ sứ mệnh, đừng chốt là xong.");
  return out;
}

/* ═════════════════════ SỰ KIỆN CỦA MẶT PHẲNG ĐIỀU KHIỂN ═════════════════════ */

/**
 * Sổ khai tên sự kiện của `tech_events`. Việc (task) có nhật ký riêng `tech_task_events` — KHÔNG chép
 * sang đây (một sự việc, một nơi ghi). Bảng này giữ sự kiện của thứ CHƯA có nhật ký: goal, mission, và từ
 * Pha 2 trở đi worker / lease / PR / CI / deploy / hậu kiểm / ngân sách / watchdog.
 *
 * Vì sao KHÔNG dùng `domain_events`: đó là bus sự kiện NGHIỆP VỤ của Company OS mà bộ workflow của khách
 * thuê tiêu thụ (`lib/workflow/cursor.ts`) và danh sách tên bị khoá theo hợp đồng `shared-contracts.md`.
 * Sự kiện vận hành nội bộ (lease, nhịp tim mất, CI đỏ) không được hiện ra thành trigger cho khách.
 */
export const TECH_EVENT_NAMES = [
  "goal.created",
  "goal.status_changed",
  "mission.created",
  "mission.status_changed",
  "mission.task_attached",
  "mission.task_detached",
] as const;
export type TechEventName = (typeof TECH_EVENT_NAMES)[number];

/** Cùng biểu thức với CHECK `tech_events_name_check`. */
export const TECH_EVENT_NAME_PATTERN = /^[a-z_]+(\.[a-z_]+)+$/;

export const TECH_EVENT_SUBJECTS = ["GOAL", "MISSION", "TASK", "WORKER", "RUN", "DEPLOYMENT", "INCIDENT"] as const;
export type TechEventSubject = (typeof TECH_EVENT_SUBJECTS)[number];

export const TECH_EVENT_LABEL: Record<TechEventName, string> = {
  "goal.created": "Tạo mục tiêu",
  "goal.status_changed": "Mục tiêu đổi trạng thái",
  "mission.created": "Tạo sứ mệnh",
  "mission.status_changed": "Sứ mệnh đổi trạng thái",
  "mission.task_attached": "Gắn việc vào sứ mệnh",
  "mission.task_detached": "Việc rời sứ mệnh",
};

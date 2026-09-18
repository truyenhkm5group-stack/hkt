/**
 * ═══════════ PHÒNG TECH AI — SỔ ĐĂNG KÝ TỪ VỰNG (Phase 1) ═══════════
 *
 * Tệp này CLIENT-SAFE: không import `@/db`, không import `lib/queries/*`. Mọi nhãn, mọi trạng
 * thái, mọi phép chuyển trạng thái của mặt phẳng điều khiển Tech đều khai ở đây và CHỈ ở đây —
 * cùng hình dạng với `lib/constants/work-sources.ts` và `lib/constants/cost-authority.ts`.
 *
 * ─── PHẠM VI CỦA PHASE 1 ───
 *
 * Đây là MẶT PHẲNG ĐIỀU KHIỂN (control plane), không phải máy thi hành. Nó trả lời "việc Tech nào
 * đang tồn tại · ai/agent nào được khai · lần deploy nào vừa xảy ra · production đang chạy commit
 * nào · sự cố nào đang mở". Nó KHÔNG tự sửa mã, KHÔNG tự merge, KHÔNG tự deploy, KHÔNG ghi vào
 * production. Xem `docs/ai-tech-department-phase1.md` mục "cố tình chưa xây".
 *
 * ─── VÌ SAO KHÔNG DÙNG LẠI `work_items` ───
 *
 * AGENTS.md mục 19: hàng đợi `/work` là PHÉP CHIẾU lên việc đã tồn tại ở miền nghiệp vụ, và mỗi
 * nguồn khai thẩm quyền ở `lib/constants/work-sources.ts`. Việc Tech là một MIỀN MỚI: nó có vòng
 * đời riêng 13 trạng thái, có mức rủi ro, có cổng phê duyệt, có nhánh git và có agent thực thi —
 * không trạng thái nào trong `WorkStatus` diễn đạt được "đang quan sát sau deploy". Nhét nó vào
 * `work_items` là tạo ra nơi giữ trạng thái thứ hai cho cùng một sự việc, đúng cái bẫy mục 19 sinh
 * ra để chặn. Nên: miền riêng, bảng riêng, và Phase 2 mới CHIẾU nó lên `/work` bằng một nguồn
 * `TECH_TASK` khai tường minh — chiếu trước khi có miền là chép dữ liệu.
 */

/* ═════════════════════ TRẠNG THÁI VIỆC TECH ═════════════════════ */

export const TECH_TASK_STATUSES = [
  "NEW",
  "TRIAGED",
  "SPEC_READY",
  "BUILDING",
  "REVIEW",
  "QA",
  "READY_TO_DEPLOY",
  "DEPLOYING",
  "OBSERVING",
  "DONE",
  "BLOCKED",
  "FAILED",
  "ROLLED_BACK",
] as const;
export type TechTaskStatus = (typeof TECH_TASK_STATUSES)[number];

export const TECH_TASK_STATUS_LABEL: Record<TechTaskStatus, string> = {
  NEW: "Mới ghi nhận",
  TRIAGED: "Đã phân loại",
  SPEC_READY: "Đã có đặc tả",
  BUILDING: "Đang làm",
  REVIEW: "Đang review mã",
  QA: "Đang kiểm thử",
  READY_TO_DEPLOY: "Sẵn sàng deploy",
  DEPLOYING: "Đang deploy",
  OBSERVING: "Đang quan sát sau deploy",
  DONE: "Xong",
  BLOCKED: "Bị chặn",
  FAILED: "Thất bại",
  ROLLED_BACK: "Đã quay lui",
};

export const TECH_TASK_STATUS_HINT: Record<TechTaskStatus, string> = {
  NEW: "Có người / có máy báo là cần làm, chưa ai đọc kỹ",
  TRIAGED: "Đã xác định mức ưu tiên, mức rủi ro và module bị chạm",
  SPEC_READY: "Đã viết rõ phải làm gì và làm xong thì kiểm bằng cách nào",
  BUILDING: "Đang có nhánh và đang sửa mã",
  REVIEW: "Mã đã xong, đang đọc lại",
  QA: "Đang chạy typecheck / lint / test / build",
  READY_TO_DEPLOY: "Đã xanh hết và (nếu cần) đã được chủ shop phê duyệt",
  DEPLOYING: "Workflow deploy đang chạy — GitHub Actions là bên có thẩm quyền, ERP chỉ quan sát",
  OBSERVING: "Đã lên production, đang theo dõi sức khoẻ và số liệu",
  DONE: "Đã xác minh trên production và đóng",
  BLOCKED: "Đang chờ một thứ bên ngoài: quyết định của chủ shop, dữ liệu, hoặc một việc khác",
  FAILED: "Làm nhưng không ra kết quả — phải nói rõ vì sao, không được đóng im lặng",
  ROLLED_BACK: "Đã lên production rồi phải quay lui",
};

export const TECH_TASK_STATUS_TONE: Record<TechTaskStatus, string> = {
  NEW: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  TRIAGED: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  SPEC_READY: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  BUILDING: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300",
  REVIEW: "bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
  QA: "bg-teal-50 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300",
  READY_TO_DEPLOY: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  DEPLOYING: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  OBSERVING: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  DONE: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  BLOCKED: "bg-orange-50 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300",
  FAILED: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  ROLLED_BACK: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
};

/**
 * PHÉP CHUYỂN TRẠNG THÁI — DANH SÁCH ĐÓNG, KHÔNG PHẢI QUY ƯỚC.
 *
 * Một hàng đợi mà trạng thái nào cũng nhảy sang trạng thái nào được thì cột trạng thái chỉ còn là
 * một cái nhãn: không đọc ngược được đường đi, không đo được thời gian ở từng chặng. Nên bảng này
 * là nơi DUY NHẤT nói "từ đây đi được tới đâu", và `lib/actions/tech.ts` không có nhánh nào lách
 * qua nó.
 *
 * `DONE` không đi đâu nữa. Việc đã đóng mà hỏng lại thì mở việc MỚI có liên kết tới việc cũ —
 * cùng lý do AGENTS.md mục 59 không cho một sự cố cũ sinh ra một đợt care mới.
 */
export const TECH_TASK_TRANSITIONS: Record<TechTaskStatus, TechTaskStatus[]> = {
  NEW: ["TRIAGED", "BLOCKED"],
  TRIAGED: ["SPEC_READY", "BUILDING", "BLOCKED"],
  SPEC_READY: ["BUILDING", "TRIAGED", "BLOCKED"],
  BUILDING: ["REVIEW", "BLOCKED", "FAILED"],
  REVIEW: ["QA", "BUILDING", "BLOCKED", "FAILED"],
  QA: ["READY_TO_DEPLOY", "BUILDING", "BLOCKED", "FAILED"],
  READY_TO_DEPLOY: ["DEPLOYING", "QA", "BLOCKED"],
  DEPLOYING: ["OBSERVING", "FAILED", "ROLLED_BACK"],
  OBSERVING: ["DONE", "FAILED", "ROLLED_BACK"],
  DONE: [],
  BLOCKED: ["TRIAGED", "SPEC_READY", "BUILDING", "REVIEW", "QA", "READY_TO_DEPLOY", "FAILED"],
  FAILED: ["TRIAGED", "BUILDING"],
  ROLLED_BACK: ["TRIAGED", "BUILDING"],
};

/** Trạng thái KẾT THÚC: không còn nước đi nào. Chỉ `DONE`. */
export const TECH_TASK_TERMINAL: TechTaskStatus[] = TECH_TASK_STATUSES.filter((s) => TECH_TASK_TRANSITIONS[s].length === 0);

/**
 * Việc còn nằm trên bàn. `FAILED` và `ROLLED_BACK` VẪN MỞ — một việc thất bại là việc chưa xong,
 * và đếm nó là "đã đóng" đúng bằng cách giấu nó khỏi mọi bảng tổng hợp.
 */
export const TECH_TASK_OPEN: TechTaskStatus[] = TECH_TASK_STATUSES.filter((s) => s !== "DONE");

/** Đang có người / agent đụng vào (để đếm "việc đang chạy"). */
export const TECH_TASK_ACTIVE: TechTaskStatus[] = ["BUILDING", "REVIEW", "QA", "DEPLOYING", "OBSERVING"];

export function isTechTaskStatus(value: unknown): value is TechTaskStatus {
  return typeof value === "string" && (TECH_TASK_STATUSES as readonly string[]).includes(value);
}

export function canTransitionTechTask(from: TechTaskStatus, to: TechTaskStatus) {
  // Tự-chuyển là KHÔNG hợp lệ ở đây, cố ý: `lib/actions/tech.ts` chặn nó SỚM HƠN bằng một nhánh
  // bỏ qua không ghi gì (AGENTS.md mục 61 — bấm hai lần không được đẻ ra hai dòng lịch sử).
  return TECH_TASK_TRANSITIONS[from].includes(to);
}

/* ═════════════════════ ƯU TIÊN & RỦI RO ═════════════════════ */

export const TECH_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type TechPriority = (typeof TECH_PRIORITIES)[number];

export const TECH_PRIORITY_LABEL: Record<TechPriority, string> = {
  P0: "P0 · Đang chảy máu",
  P1: "P1 · Trong ngày",
  P2: "P2 · Trong tuần",
  P3: "P3 · Khi rảnh",
};

export const TECH_PRIORITY_HINT: Record<TechPriority, string> = {
  P0: "Production hỏng, số liệu sai, hoặc tiền đang mất — bỏ mọi thứ khác",
  P1: "Chặn một phòng ban làm việc, hoặc một con số ra quyết định đang không tin được",
  P2: "Cần làm nhưng có đường vòng tạm chấp nhận được",
  P3: "Cải thiện, dọn dẹp, tài liệu",
};

export const TECH_PRIORITY_TONE: Record<TechPriority, string> = {
  P0: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  P1: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  P2: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  P3: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
};

export const TECH_RISKS = ["R0", "R1", "R2"] as const;
export type TechRisk = (typeof TECH_RISKS)[number];

export const TECH_RISK_LABEL: Record<TechRisk, string> = {
  R0: "R0 · Không chạm sự thật",
  R1: "R1 · Chạm hệ thống, không chạm sự thật",
  R2: "R2 · Chạm sự thật kinh doanh",
};

export const TECH_RISK_HINT: Record<TechRisk, string> = {
  R0: "Tài liệu, kiểm thử, câu chữ, giao diện ít rủi ro, chẩn đoán chỉ-đọc",
  R1: "Sửa backend / truy vấn / hiệu năng / tích hợp nhưng KHÔNG đổi định nghĩa một con số nào",
  R2: "Lương, lợi nhuận, kế toán, tồn kho, kết quả đơn, quyền, migration có rủi ro phá huỷ, sửa dữ liệu, scheduler, secret, đổi tích hợp ngoài",
};

export const TECH_RISK_TONE: Record<TechRisk, string> = {
  R0: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  R1: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  R2: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
};

/* ═════════════════════ LOẠI VIỆC · MODULE · NGUỒN ═════════════════════ */

export const TECH_TASK_TYPES = [
  "FEATURE",
  "BUGFIX",
  "REFACTOR",
  "PERFORMANCE",
  "DATA_FIX",
  "MIGRATION",
  "INTEGRATION",
  "SECURITY",
  "DOCS",
  "TEST",
  "INFRA",
  "INVESTIGATION",
] as const;
export type TechTaskType = (typeof TECH_TASK_TYPES)[number];

export const TECH_TASK_TYPE_LABEL: Record<TechTaskType, string> = {
  FEATURE: "Tính năng mới",
  BUGFIX: "Sửa lỗi",
  REFACTOR: "Dọn mã",
  PERFORMANCE: "Hiệu năng",
  DATA_FIX: "Sửa dữ liệu",
  MIGRATION: "Migration CSDL",
  INTEGRATION: "Tích hợp ngoài",
  SECURITY: "An ninh & quyền",
  DOCS: "Tài liệu",
  TEST: "Kiểm thử",
  INFRA: "Hạ tầng & deploy",
  INVESTIGATION: "Điều tra",
};

/**
 * MODULE ERP mà việc chạm tới. Danh sách ĐÓNG: một ô gõ tự do ở đây làm luật rủi ro bên dưới
 * không khớp được gì, và một việc chạm lương sẽ lặng lẽ được xếp R0.
 */
export const TECH_MODULES = [
  "ORDERS",
  "SHIPMENTS",
  "CARE",
  "CS",
  "COD",
  "FINANCE",
  "PAYROLL",
  "REPORTS",
  "INVENTORY",
  "PURCHASING",
  "ADS",
  "CUSTOMERS",
  "LANDING",
  "WORK",
  "ACCESS",
  "INTEGRATIONS",
  "DATA_QUALITY",
  "PLATFORM",
  "TECH",
] as const;
export type TechModule = (typeof TECH_MODULES)[number];

export const TECH_MODULE_LABEL: Record<TechModule, string> = {
  ORDERS: "Đơn hàng",
  SHIPMENTS: "Vận đơn",
  CARE: "Chăm sóc kiện hàng",
  CS: "CSKH",
  COD: "Đối soát COD",
  FINANCE: "Tài chính & dòng tiền",
  PAYROLL: "Lương & hoa hồng",
  REPORTS: "Báo cáo lợi nhuận",
  INVENTORY: "Kho & tồn",
  PURCHASING: "Đặt hàng sản xuất",
  ADS: "Quảng cáo & quy kết",
  CUSTOMERS: "Khách hàng",
  LANDING: "Landing page",
  WORK: "Công việc & mục tiêu",
  ACCESS: "Quyền & phân quyền",
  INTEGRATIONS: "Kết nối dữ liệu",
  DATA_QUALITY: "Chất lượng dữ liệu",
  PLATFORM: "Nền tảng & hạ tầng",
  TECH: "Phòng Tech AI",
};

export const TECH_TASK_SOURCES = ["OWNER", "STAFF", "MONITOR", "INCIDENT", "CODE_REVIEW", "TEST_FAILURE", "DEPLOY", "AI_AGENT"] as const;
export type TechTaskSource = (typeof TECH_TASK_SOURCES)[number];

export const TECH_TASK_SOURCE_LABEL: Record<TechTaskSource, string> = {
  OWNER: "Chủ shop yêu cầu",
  STAFF: "Nhân viên báo",
  MONITOR: "Giám sát tự động",
  INCIDENT: "Từ một sự cố",
  CODE_REVIEW: "Từ review mã",
  TEST_FAILURE: "Kiểm thử đỏ",
  DEPLOY: "Từ một lần deploy",
  AI_AGENT: "Agent đề xuất",
};

/* ═════════════════════ AI LÀM — BA LOẠI, KHÔNG BAO GIỜ GỘP ═════════════════════ */

/**
 * AGENTS.md mục 34 & 36: khoá tài khoản là thứ quy kết, ô chữ chỉ là ảnh chụp tên. Ở đây thêm một
 * chiều nữa mà `work_item_events` chưa có: **AI_AGENT tách hẳn khỏi SYSTEM và khỏi HUMAN.**
 *
 * Một agent không phải một con người (không gán được `users.id`, không chịu trách nhiệm pháp lý)
 * và cũng không phải một job định kỳ (nó QUYẾT ĐỊNH, job thì chạy theo lịch). Gộp agent vào
 * `SYSTEM` thì không đọc ngược được "việc này do máy nghĩ ra"; gộp vào `HUMAN` thì báo cáo nói có
 * người đang làm trong khi không ai làm — đúng con số 187 việc sai ở mục 36.
 */
export const TECH_ACTOR_KINDS = ["HUMAN", "SYSTEM", "AI_AGENT"] as const;
export type TechActorKind = (typeof TECH_ACTOR_KINDS)[number];

export const TECH_ACTOR_KIND_LABEL: Record<TechActorKind, string> = {
  HUMAN: "Người",
  SYSTEM: "Hệ thống",
  AI_AGENT: "Agent AI",
};

/* ═════════════════════ CỔNG PHÊ DUYỆT CỦA NGƯỜI ═════════════════════ */

export const TECH_APPROVAL_STATUSES = ["NOT_REQUIRED", "PENDING", "APPROVED", "REJECTED"] as const;
export type TechApprovalStatus = (typeof TECH_APPROVAL_STATUSES)[number];

export const TECH_APPROVAL_LABEL: Record<TechApprovalStatus, string> = {
  NOT_REQUIRED: "Không cần phê duyệt",
  PENDING: "Chờ chủ shop duyệt",
  APPROVED: "Đã duyệt",
  REJECTED: "Đã từ chối",
};

export const TECH_APPROVAL_TONE: Record<TechApprovalStatus, string> = {
  NOT_REQUIRED: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  PENDING: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  APPROVED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  REJECTED: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
};

/**
 * CỔNG DEPLOY — một hàm THUẦN, và nó là nơi DUY NHẤT trả lời "việc này được đi tiếp chưa".
 *
 * `lib/tech/service.ts` gọi nó ở HAI bước: vào `READY_TO_DEPLOY` và vào `DEPLOYING`. Bước đầu vì
 * nhãn của trạng thái ấy đã hứa "đã được chủ shop phê duyệt" — chặn muộn hơn thì cái nhãn nói dối.
 * Bước sau vì một việc đã duyệt vẫn có thể bị NÂNG lại lên R2 sau đó, và lúc ấy lá chắn thứ hai là
 * thứ duy nhất còn lại.
 *
 * Trả về lý do CHẶN chứ không trả về `boolean`: một cổng chỉ nói "không" thì màn hình phải tự đoán
 * vì sao, và nó sẽ đoán sai vào đúng lúc người dùng cần biết nhất.
 */
export function techDeployBlockers(task: { approvalRequired: boolean; approvalStatus: TechApprovalStatus; risk: TechRisk }): string[] {
  const out: string[] = [];
  if (task.approvalRequired && task.approvalStatus !== "APPROVED") {
    out.push(
      task.approvalStatus === "REJECTED"
        ? "Chủ shop đã từ chối việc này — phải sửa phạm vi rồi xin duyệt lại, không được đi tiếp."
        : `Việc mức ${task.risk} cần chủ shop phê duyệt trước khi deploy (đang ở trạng thái “${TECH_APPROVAL_LABEL[task.approvalStatus]}”).`,
    );
  }
  return out;
}

/* ═════════════════════ SỔ AGENT ═════════════════════ */

export const TECH_AGENT_ROLES = [
  "AI_CTO",
  "ARCHITECT",
  "BACKEND",
  "FRONTEND",
  "DATA",
  "INTEGRATION",
  "QA",
  "SECURITY",
  "DEVOPS_SRE",
  "DATA_QUALITY",
  "INCIDENT",
  "DOCUMENTATION",
] as const;
export type TechAgentRole = (typeof TECH_AGENT_ROLES)[number];

export const TECH_AGENT_ROLE_LABEL: Record<TechAgentRole, string> = {
  AI_CTO: "Giám đốc kỹ thuật AI",
  ARCHITECT: "Kiến trúc sư",
  BACKEND: "Backend",
  FRONTEND: "Giao diện",
  DATA: "Dữ liệu & truy vấn",
  INTEGRATION: "Tích hợp ngoài",
  QA: "Kiểm thử",
  SECURITY: "An ninh & quyền",
  DEVOPS_SRE: "Vận hành & deploy",
  DATA_QUALITY: "Chất lượng dữ liệu",
  INCIDENT: "Xử lý sự cố",
  DOCUMENTATION: "Tài liệu",
};

export const TECH_AGENT_STATUSES = ["IDLE", "PLANNING", "WORKING", "REVIEWING", "TESTING", "DEPLOYING", "OBSERVING", "BLOCKED", "ERROR"] as const;
export type TechAgentStatus = (typeof TECH_AGENT_STATUSES)[number];

export const TECH_AGENT_STATUS_LABEL: Record<TechAgentStatus, string> = {
  IDLE: "Rảnh",
  PLANNING: "Đang lập kế hoạch",
  WORKING: "Đang làm",
  REVIEWING: "Đang review",
  TESTING: "Đang kiểm thử",
  DEPLOYING: "Đang deploy",
  OBSERVING: "Đang quan sát",
  BLOCKED: "Bị chặn",
  ERROR: "Lỗi",
};

export const TECH_AGENT_STATUS_TONE: Record<TechAgentStatus, string> = {
  IDLE: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  PLANNING: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  WORKING: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300",
  REVIEWING: "bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
  TESTING: "bg-teal-50 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300",
  DEPLOYING: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  OBSERVING: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  BLOCKED: "bg-orange-50 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300",
  ERROR: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
};

/** Agent "đang hoạt động" — dùng cho thẻ đếm ở trang tổng quan. */
export const TECH_AGENT_BUSY: TechAgentStatus[] = ["PLANNING", "WORKING", "REVIEWING", "TESTING", "DEPLOYING", "OBSERVING"];

/**
 * MẪU SỔ AGENT — KHÔNG TỰ KÍCH HOẠT (AGENTS.md mục 23).
 *
 * Đây là BẢN KHAI, không phải dữ liệu đang chạy. Bảng `tech_agents` trống cho tới khi có NGƯỜI bấm
 * "Khởi tạo sổ agent" ở `/tech/agents`. Lý do y hệt mẫu OKR: một sổ tự đầy lúc migration chạy là
 * một sổ không ai từng quyết định, và cái không ai quyết định thì không ai chịu trách nhiệm.
 *
 * MỌI mẫu đều `canMerge: false` · `canDeploy: false` · `canRunProdWrite: false`. Phase 1 không xây
 * máy thi hành, nên một cờ `true` ở đây là một lời hứa mã nguồn không giữ được.
 */
export type TechAgentTemplate = {
  key: string;
  name: string;
  role: TechAgentRole;
  description: string;
  capabilities: string[];
  /** Mức rủi ro agent được phép đụng tới. R2 KHÔNG bao giờ nằm ở đây trong Phase 1. */
  allowedRisks: TechRisk[];
  canCode: boolean;
  canReview: boolean;
  canMerge: boolean;
  canDeploy: boolean;
  canRunProdRead: boolean;
  canRunProdWrite: boolean;
};

export const TECH_AGENT_TEMPLATES: readonly TechAgentTemplate[] = [
  {
    key: "ai-cto",
    name: "AI CTO",
    role: "AI_CTO",
    description: "Đọc hàng đợi Tech, xếp ưu tiên, chia việc cho agent khác, và là nơi đặt câu hỏi cho chủ shop khi một việc chạm sự thật kinh doanh.",
    capabilities: ["triage", "prioritise", "assign", "escalate"],
    allowedRisks: ["R0", "R1"],
    canCode: false,
    canReview: true,
    canMerge: false,
    canDeploy: false,
    canRunProdRead: true,
    canRunProdWrite: false,
  },
  {
    key: "architect",
    name: "Kiến trúc sư",
    role: "ARCHITECT",
    description: "Viết đặc tả trước khi ai đó gõ dòng mã đầu tiên: đụng tệp nào, hợp đồng nào phải giữ, kiểm bằng cách nào.",
    capabilities: ["spec", "design-review", "impact-analysis"],
    allowedRisks: ["R0", "R1"],
    canCode: false,
    canReview: true,
    canMerge: false,
    canDeploy: false,
    canRunProdRead: true,
    canRunProdWrite: false,
  },
  {
    key: "backend",
    name: "Backend",
    role: "BACKEND",
    description: "Server action, truy vấn, job đồng bộ, lược đồ CSDL.",
    capabilities: ["code", "query", "migration-draft"],
    allowedRisks: ["R0", "R1"],
    canCode: true,
    canReview: false,
    canMerge: false,
    canDeploy: false,
    canRunProdRead: false,
    canRunProdWrite: false,
  },
  {
    key: "frontend",
    name: "Giao diện",
    role: "FRONTEND",
    description: "Trang, bảng, biểu mẫu, trạng thái chờ — và giữ đúng quy ước máy chủ / máy khách.",
    capabilities: ["code", "ui", "accessibility"],
    allowedRisks: ["R0", "R1"],
    canCode: true,
    canReview: false,
    canMerge: false,
    canDeploy: false,
    canRunProdRead: false,
    canRunProdWrite: false,
  },
  {
    key: "data",
    name: "Dữ liệu & truy vấn",
    role: "DATA",
    description: "Công thức báo cáo, hiệu năng truy vấn, đối chiếu số trước / sau khi sửa.",
    capabilities: ["query", "report", "reconcile"],
    allowedRisks: ["R0", "R1"],
    canCode: true,
    canReview: true,
    canMerge: false,
    canDeploy: false,
    canRunProdRead: true,
    canRunProdWrite: false,
  },
  {
    key: "integration",
    name: "Tích hợp ngoài",
    role: "INTEGRATION",
    description: "Pancake, Viettel Post, Facebook, ngân hàng: webhook, hạn mức, phong bì lỗi, idempotent.",
    capabilities: ["code", "webhook", "api-client"],
    allowedRisks: ["R0", "R1"],
    canCode: true,
    canReview: false,
    canMerge: false,
    canDeploy: false,
    canRunProdRead: true,
    canRunProdWrite: false,
  },
  {
    key: "qa",
    name: "Kiểm thử",
    role: "QA",
    description: "Viết bài kiểm cho đúng cái vừa sửa, chạy cổng, và nói thẳng khi cổng đỏ.",
    capabilities: ["test", "gate", "regression"],
    allowedRisks: ["R0", "R1"],
    canCode: true,
    canReview: true,
    canMerge: false,
    canDeploy: false,
    canRunProdRead: false,
    canRunProdWrite: false,
  },
  {
    key: "security",
    name: "An ninh & quyền",
    role: "SECURITY",
    description: "Quyền, phạm vi dữ liệu, secret, bề mặt công khai của kho mã.",
    capabilities: ["review", "audit", "threat-model"],
    allowedRisks: ["R0"],
    canCode: false,
    canReview: true,
    canMerge: false,
    canDeploy: false,
    canRunProdRead: false,
    canRunProdWrite: false,
  },
  {
    key: "devops",
    name: "Vận hành & deploy",
    role: "DEVOPS_SRE",
    description: "Quan sát deploy, sức khoẻ máy chủ, lịch job. KHÔNG bấm deploy — GitHub Actions và người là bên có thẩm quyền.",
    capabilities: ["observe", "health", "runbook"],
    allowedRisks: ["R0"],
    canCode: false,
    canReview: false,
    canMerge: false,
    canDeploy: false,
    canRunProdRead: true,
    canRunProdWrite: false,
  },
  {
    key: "data-quality",
    name: "Chất lượng dữ liệu",
    role: "DATA_QUALITY",
    description: "Đi tìm chỗ trống trong dữ liệu và phân loại chúng — chứ không lấp bằng phỏng đoán.",
    capabilities: ["scan", "classify", "report"],
    allowedRisks: ["R0"],
    canCode: false,
    canReview: false,
    canMerge: false,
    canDeploy: false,
    canRunProdRead: true,
    canRunProdWrite: false,
  },
  {
    key: "incident",
    name: "Xử lý sự cố",
    role: "INCIDENT",
    description: "Mở sự cố khi có bằng chứng, gom chứng cứ, và KHÔNG viết nguyên nhân gốc khi chưa chứng minh được.",
    capabilities: ["triage", "evidence", "timeline"],
    allowedRisks: ["R0"],
    canCode: false,
    canReview: false,
    canMerge: false,
    canDeploy: false,
    canRunProdRead: true,
    canRunProdWrite: false,
  },
  {
    key: "documentation",
    name: "Tài liệu",
    role: "DOCUMENTATION",
    description: "Giữ `AGENTS.md`, `HANDOFF.md`, `docs/` nói đúng thứ mã nguồn đang làm.",
    capabilities: ["docs", "changelog"],
    allowedRisks: ["R0"],
    canCode: true,
    canReview: false,
    canMerge: false,
    canDeploy: false,
    canRunProdRead: false,
    canRunProdWrite: false,
  },
] as const;

/* ═════════════════════ LƯỢT CHẠY CỦA AGENT ═════════════════════ */

export const TECH_RUN_STATUSES = ["RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"] as const;
export type TechRunStatus = (typeof TECH_RUN_STATUSES)[number];

export const TECH_RUN_STATUS_LABEL: Record<TechRunStatus, string> = {
  RUNNING: "Đang chạy",
  SUCCEEDED: "Xong",
  FAILED: "Thất bại",
  CANCELLED: "Đã huỷ",
};

/**
 * KẾT QUẢ CỔNG — BỐN GIÁ TRỊ, VÀ `UNKNOWN` LÀ MẶC ĐỊNH.
 *
 * AGENTS.md mục 42 (chưa biết không được in ra thành 0) áp thẳng vào đây: một lượt chạy chưa khai
 * kết quả kiểm thử KHÔNG được coi là đã đạt. `SKIPPED` tách khỏi `UNKNOWN` vì "cố ý không chạy" và
 * "không ai biết có chạy không" là hai câu trả lời khác nhau cho người đọc lại sau ba tuần.
 */
export const TECH_GATE_RESULTS = ["PASSED", "FAILED", "SKIPPED", "UNKNOWN"] as const;
export type TechGateResult = (typeof TECH_GATE_RESULTS)[number];

export const TECH_GATE_RESULT_LABEL: Record<TechGateResult, string> = {
  PASSED: "Đạt",
  FAILED: "Đỏ",
  SKIPPED: "Cố ý bỏ qua",
  UNKNOWN: "Chưa xác minh",
};

export const TECH_GATE_RESULT_TONE: Record<TechGateResult, string> = {
  PASSED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  FAILED: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  SKIPPED: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  UNKNOWN: "bg-muted text-muted-foreground",
};

/* ═════════════════════ DEPLOYMENT (LỚP QUAN SÁT) ═════════════════════ */

/**
 * ERP KHÔNG PHẢI BÊN CÓ THẨM QUYỀN VỀ DEPLOY.
 *
 * Workflow `Deploy ERP to VPS` trên GitHub Actions là bên quyết định một bản có lên máy chủ hay
 * không. Bảng `tech_deployments` chỉ GHI LẠI những gì đã xảy ra để trang `/tech` trả lời được "lần
 * deploy gần nhất là commit nào, lúc nào, kết quả ra sao". Nó không kích hoạt gì, và không được
 * trở thành nguồn sự thật thứ hai — commit đang chạy đọc từ `/api/health`.
 */
export const TECH_DEPLOY_STATUSES = ["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "ROLLED_BACK"] as const;
export type TechDeployStatus = (typeof TECH_DEPLOY_STATUSES)[number];

export const TECH_DEPLOY_STATUS_LABEL: Record<TechDeployStatus, string> = {
  PENDING: "Chờ chạy",
  RUNNING: "Đang chạy",
  SUCCEEDED: "Thành công",
  FAILED: "Thất bại",
  ROLLED_BACK: "Đã quay lui",
};

export const TECH_DEPLOY_STATUS_TONE: Record<TechDeployStatus, string> = {
  PENDING: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  RUNNING: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  SUCCEEDED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  FAILED: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  ROLLED_BACK: "bg-orange-50 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300",
};

/* ═════════════════════ SỰ CỐ ═════════════════════ */

export const TECH_INCIDENT_SEVERITIES = ["SEV0", "SEV1", "SEV2", "SEV3"] as const;
export type TechIncidentSeverity = (typeof TECH_INCIDENT_SEVERITIES)[number];

export const TECH_INCIDENT_SEVERITY_LABEL: Record<TechIncidentSeverity, string> = {
  SEV0: "SEV0 · Dừng kinh doanh",
  SEV1: "SEV1 · Mất một năng lực chính",
  SEV2: "SEV2 · Hỏng một phần, có đường vòng",
  SEV3: "SEV3 · Phiền nhưng không chặn ai",
};

export const TECH_INCIDENT_SEVERITY_TONE: Record<TechIncidentSeverity, string> = {
  SEV0: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  SEV1: "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
  SEV2: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  SEV3: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
};

export const TECH_INCIDENT_STATUSES = ["OPEN", "INVESTIGATING", "MITIGATED", "MONITORING", "RESOLVED"] as const;
export type TechIncidentStatus = (typeof TECH_INCIDENT_STATUSES)[number];

export const TECH_INCIDENT_STATUS_LABEL: Record<TechIncidentStatus, string> = {
  OPEN: "Mới mở",
  INVESTIGATING: "Đang điều tra",
  MITIGATED: "Đã giảm thiểu",
  MONITORING: "Đang theo dõi",
  RESOLVED: "Đã đóng",
};

export const TECH_INCIDENT_STATUS_TONE: Record<TechIncidentStatus, string> = {
  OPEN: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  INVESTIGATING: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  MITIGATED: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  MONITORING: "bg-teal-50 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300",
  RESOLVED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
};

/**
 * Vòng đời sự cố. Đi tới rồi quay lại được — một sự cố tưởng đã giảm thiểu mà tái phát thì phải
 * về `INVESTIGATING`, không phải mở một sự cố mới (mở mới là làm mất dòng thời gian của lần đầu).
 */
export const TECH_INCIDENT_TRANSITIONS: Record<TechIncidentStatus, TechIncidentStatus[]> = {
  OPEN: ["INVESTIGATING", "MITIGATED", "RESOLVED"],
  INVESTIGATING: ["MITIGATED", "MONITORING", "RESOLVED"],
  MITIGATED: ["MONITORING", "INVESTIGATING", "RESOLVED"],
  MONITORING: ["RESOLVED", "INVESTIGATING"],
  RESOLVED: [],
};

export const TECH_INCIDENT_OPEN: TechIncidentStatus[] = TECH_INCIDENT_STATUSES.filter((s) => s !== "RESOLVED");

export function canTransitionTechIncident(from: TechIncidentStatus, to: TechIncidentStatus) {
  return TECH_INCIDENT_TRANSITIONS[from].includes(to);
}

/**
 * ĐÓNG MỘT SỰ CỐ PHẢI NÓI ĐƯỢC ĐÃ LÀM GÌ.
 *
 * Không đòi `rootCause`: AGENTS.md mục 45 — không có bằng chứng thì `TRUE_UNKNOWN` phải được giữ
 * nguyên, và ép mỗi sự cố phải có một nguyên nhân gốc là ép người trực bịa ra một câu cho xong.
 * Cái BẮT BUỘC là `resolution`: đã làm gì để nó hết. Đó là việc có thật, luôn kể lại được.
 */
export function techIncidentCloseBlockers(input: { resolution: string }): string[] {
  return input.resolution.trim().length >= 10 ? [] : ["Phải ghi đã làm gì để sự cố hết (ít nhất một câu) trước khi đóng."];
}

/* ═════════════════════ NHẬT KÝ VIỆC ═════════════════════ */

export const TECH_EVENT_KINDS = [
  "CREATE",
  "STATUS",
  "PRIORITY",
  "RISK",
  "ASSIGN",
  "NOTE",
  "APPROVAL",
  "BRANCH",
  "RUN",
  "DEPLOY",
  "INCIDENT",
  "VERIFY",
] as const;
export type TechEventKind = (typeof TECH_EVENT_KINDS)[number];

export const TECH_EVENT_KIND_LABEL: Record<TechEventKind, string> = {
  CREATE: "Tạo việc",
  STATUS: "Đổi trạng thái",
  PRIORITY: "Đổi mức ưu tiên",
  RISK: "Đổi mức rủi ro",
  ASSIGN: "Giao cho agent",
  NOTE: "Ghi chú",
  APPROVAL: "Phê duyệt",
  BRANCH: "Nhánh / worktree",
  RUN: "Lượt chạy agent",
  DEPLOY: "Deploy",
  INCIDENT: "Sự cố",
  VERIFY: "Xác minh trên production",
};

/* ═════════════════════ CỘT SẮP XẾP ĐƯỢC ═════════════════════ */

/**
 * Khai ở tệp HẰNG SỐ chứ không ở `lib/queries/*`, vì cả hai phía đều cần:
 * máy chủ dùng nó trong `parseListParams`, bảng phía trình duyệt dùng nó cho `sortable`. Hằng số
 * KHÔNG được đi qua ranh giới `"use client"` (`tests/client-boundary-exports.test.ts`), nên chỗ
 * duy nhất cả hai import được là đây.
 *
 * Mỗi khoá phải trùng `id` của cột tương ứng — lệch một chữ thì mũi tên sắp xếp im lặng không chạy.
 */
export const TECH_TASK_SORTABLE = ["createdAt", "updatedAt", "priority", "risk", "status", "code", "module"];
export const TECH_RUN_SORTABLE = ["startedAt", "status", "agentKey"];
export const TECH_DEPLOY_SORTABLE = ["startedAt", "status", "commitSha", "branch"];
export const TECH_INCIDENT_SORTABLE = ["detectedAt", "severity", "status", "code"];

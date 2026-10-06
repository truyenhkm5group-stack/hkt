/**
 * ═══════════ WORKER · LEASE · NHỊP TIM · ADAPTER THI HÀNH (Pha 2) ═══════════
 *
 * Kiến trúc: docs/tech-control-plane/README.md mục 4. Tệp THUẦN, CLIENT-SAFE — không import `@/db`, không
 * đọc đồng hồ (mọi hàm nhận `now`), nên worker daemon (`scripts/tech-worker.ts`), máy chủ và bài kiểm dùng
 * CHUNG một luật.
 *
 * ─── KHÔNG CẦN LLM ───
 *
 * Lập lịch, nhận việc, lease, nhịp tim, hết hạn, đếm lần thử, lùi dần, huỷ — tất cả là phép tính tất định ở
 * đây. Model chỉ được gọi BÊN TRONG một lượt chạy đã được lease, và câu trả lời của nó KHÔNG BAO GIỜ đổi trạng
 * thái việc trực tiếp: worker báo một `outcome` trong danh sách đóng, `decideCompletion` quyết bước kế tiếp.
 */
import type { TechRisk, TechTaskStatus } from "@/lib/constants/tech";

/* ═════════════════════ ADAPTER THI HÀNH ═════════════════════ */

/**
 * Ba đường thi hành. Thêm nhà cung cấp mới = thêm một khoá ở đây + một adapter trong `scripts/tech-worker/`;
 * mặt phẳng điều khiển không phải viết lại.
 *
 *  · `SUBSCRIPTION_CLAUDE_CODE` — Claude Code chạy headless bằng đăng nhập GÓI THUÊ BAO của máy worker.
 *    Ranh giới thanh toán CỨNG: môi trường tiến trình con KHÔNG BAO GIỜ có `ANTHROPIC_API_KEY` /
 *    `ANTHROPIC_AUTH_TOKEN` (`buildChildEnv` + `assertBillingBoundary`). Không bao giờ tự rơi sang API.
 *  · `ANTHROPIC_API` — cùng CLI nhưng nạp khoá API RIÊNG của worker (`TECH_WORKER_ANTHROPIC_API_KEY`), chỉ
 *    khi máy chủ cho phép chi (ngân sách API đã khai > 0). Tiền đo được, ghi theo lượt.
 *  · `GITHUB_ACTIONS` — đường đã chạy từ trước (`agent-run.yml`, khoá API trên Actions). Chép về qua
 *    `/api/tech/agent-run`; KHÔNG nhận việc qua hàng đợi này.
 *
 * Không mã nghiệp vụ nào giả định chế độ headless của gói thuê bao còn tồn tại mãi: adapter nào không khả dụng
 * thì worker của nó không nhận việc và nói vì sao — việc nằm lại hàng đợi, KHÔNG đổi đường thanh toán.
 */
export const TECH_EXECUTION_PROVIDERS = ["SUBSCRIPTION_CLAUDE_CODE", "ANTHROPIC_API", "GITHUB_ACTIONS"] as const;
export type TechExecutionProvider = (typeof TECH_EXECUTION_PROVIDERS)[number];

export const TECH_EXECUTION_PROVIDER_LABEL: Record<TechExecutionProvider, string> = {
  SUBSCRIPTION_CLAUDE_CODE: "Claude Code · gói thuê bao",
  ANTHROPIC_API: "Anthropic API · trả theo token",
  GITHUB_ACTIONS: "GitHub Actions (đường cũ)",
};

/** Cách tính tiền — để màn hình KHÔNG BAO GIỜ cộng chung tiền API với "tiền" gói thuê bao. */
export const TECH_PROVIDER_BILLING: Record<TechExecutionProvider, "SUBSCRIPTION" | "API"> = {
  SUBSCRIPTION_CLAUDE_CODE: "SUBSCRIPTION",
  ANTHROPIC_API: "API",
  GITHUB_ACTIONS: "API",
};

/** Hai adapter nhận việc qua hàng đợi. `GITHUB_ACTIONS` không có worker daemon. */
export const TECH_QUEUE_PROVIDERS: readonly TechExecutionProvider[] = ["SUBSCRIPTION_CLAUDE_CODE", "ANTHROPIC_API"];

export function isTechExecutionProvider(v: unknown): v is TechExecutionProvider {
  return typeof v === "string" && (TECH_EXECUTION_PROVIDERS as readonly string[]).includes(v);
}

/* ═════════════════════ LEASE & NHỊP TIM ═════════════════════ */

export const TECH_LEASE = {
  /** Một lease sống 5 phút; worker gia hạn ở mỗi nhịp tim. */
  ttlSeconds: 300,
  /** Worker đập nhịp mỗi 30 giây ⇒ một lease chịu được ~9 nhịp rơi trước khi hết hạn. */
  heartbeatSeconds: 30,
  /** Im lặng quá 3 nhịp ⇒ "chập chờn"; quá TTL lease ⇒ "mất". */
  staleAfterSeconds: 90,
  /** Lần thử tối đa mặc định của một việc (gồm lần đầu). Không có vòng thử lại vô hạn. */
  defaultMaxAttempts: 3,
  /** Lùi dần giữa các lần thử: 5′ · 10′ · 20′ … trần 60′. */
  backoffBaseMinutes: 5,
  backoffMaxMinutes: 60,
  /** Một worker chạy tối đa ngần này việc cùng lúc (CHECK ở CSDL). */
  maxConcurrencyCeiling: 4,
  /** Dòng nhật ký giữ cho mỗi lượt chạy, mỗi dòng tối đa ngần này ký tự — nhật ký có trần. */
  maxLogLinesPerRun: 2000,
  maxLogLineChars: 2000,
  maxLogLinesPerBeat: 200,
} as const;

export type WorkerLiveness = "NEVER" | "ONLINE" | "STALE" | "LOST";

export const WORKER_LIVENESS_LABEL: Record<WorkerLiveness, string> = {
  NEVER: "Chưa từng chạy",
  ONLINE: "Đang sống",
  STALE: "Chập chờn",
  LOST: "Mất liên lạc",
};

/** Sống / chập chờn / mất — hàm của nhịp tim cuối và đồng hồ. KHÔNG có cột trạng thái nào lưu nó. */
export function workerLiveness(lastHeartbeatAt: Date | null, now: Date): WorkerLiveness {
  if (!lastHeartbeatAt) return "NEVER";
  const s = (now.getTime() - lastHeartbeatAt.getTime()) / 1000;
  if (s <= TECH_LEASE.staleAfterSeconds) return "ONLINE";
  if (s <= TECH_LEASE.ttlSeconds) return "STALE";
  return "LOST";
}

export function leaseExpiry(now: Date): Date {
  return new Date(now.getTime() + TECH_LEASE.ttlSeconds * 1000);
}

export function leaseIsActive(lease: { leaseWorkerId: string | null; leaseExpiresAt: Date | null }, now: Date): boolean {
  return !!lease.leaseWorkerId && !!lease.leaseExpiresAt && lease.leaseExpiresAt.getTime() > now.getTime();
}

/** Lùi dần trước lần thử kế tiếp. `attemptsUsed` = số lần ĐÃ thử (≥ 1). */
export function backoffMinutes(attemptsUsed: number): number {
  const n = Math.max(1, attemptsUsed);
  return Math.min(TECH_LEASE.backoffMaxMinutes, TECH_LEASE.backoffBaseMinutes * 2 ** (n - 1));
}

/* ═════════════════════ ĐIỀU KIỆN NHẬN VIỆC ═════════════════════ */

/**
 * Mức rủi ro worker TỰ ĐỘNG được nhận. R2 (lương, lợi nhuận, tồn kho, quyền, migration phá huỷ, secret…)
 * KHÔNG BAO GIỜ — cùng luật đã có của Phòng Tech AI ("R2 không bao giờ mở cho agent", docs/ai-tech-phase2a.md).
 */
export const TECH_AUTONOMOUS_RISKS: readonly TechRisk[] = ["R0", "R1"];

export type ClaimBlocker =
  | "STATUS"
  | "DEPENDENCIES"
  | "MISSION_NOT_ACTIVE"
  | "GOAL_NOT_ACTIVE"
  | "RISK"
  | "APPROVAL"
  | "LEASED"
  | "ATTEMPTS_EXHAUSTED"
  | "BACKOFF"
  | "CAPABILITY";

export const CLAIM_BLOCKER_LABEL: Record<ClaimBlocker, string> = {
  STATUS: "Việc chưa ở “Đã có đặc tả” — chưa sẵn sàng cho worker",
  DEPENDENCIES: "Còn việc phụ thuộc chưa xong",
  MISSION_NOT_ACTIVE: "Sứ mệnh chưa bật / đang tạm dừng",
  GOAL_NOT_ACTIVE: "Mục tiêu chưa bật / đang tạm dừng",
  RISK: "Mức rủi ro R2 — worker không bao giờ tự nhận",
  APPROVAL: "Đang chờ chủ shop duyệt",
  LEASED: "Một worker khác đang giữ việc này",
  ATTEMPTS_EXHAUSTED: "Đã hết số lần thử",
  BACKOFF: "Đang đợi lùi dần trước lần thử kế tiếp",
  CAPABILITY: "Worker không có năng lực việc này cần",
};

export type ClaimCandidate = {
  status: TechTaskStatus;
  risk: TechRisk;
  approvalStatus: string;
  openDependencies: number;
  missionStatus: string | null;
  goalStatus: string | null;
  leaseWorkerId: string | null;
  leaseExpiresAt: Date | null;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date | null;
  capability: string;
};

/**
 * Vì sao một worker KHÔNG nhận được việc này — rỗng = nhận được. Bản TypeScript của mệnh đề `WHERE` trong
 * `lib/tech/worker-service.ts::claimNextTask`; bài kiểm chạy CẢ HAI trên cùng dữ liệu (luật sống hai bản thì
 * phải đo được là chúng không trôi xa nhau — cùng cách AGENTS.md mục 59 làm với care).
 *
 * Việc KHÔNG thuộc sứ mệnh nào ⇒ không xét sứ mệnh / mục tiêu (việc lẻ do người ghi vẫn chạy được).
 */
export function claimBlockers(t: ClaimCandidate, worker: { capabilities: readonly string[] }, now: Date): ClaimBlocker[] {
  const out: ClaimBlocker[] = [];
  if (t.status !== "SPEC_READY") out.push("STATUS");
  if (t.openDependencies > 0) out.push("DEPENDENCIES");
  if (t.missionStatus !== null && t.missionStatus !== "ACTIVE") out.push("MISSION_NOT_ACTIVE");
  if (t.goalStatus !== null && t.goalStatus !== "ACTIVE") out.push("GOAL_NOT_ACTIVE");
  if (!TECH_AUTONOMOUS_RISKS.includes(t.risk)) out.push("RISK");
  if (t.approvalStatus === "PENDING" || t.approvalStatus === "REJECTED") out.push("APPROVAL");
  if (leaseIsActive(t, now)) out.push("LEASED");
  if (t.attempts >= t.maxAttempts) out.push("ATTEMPTS_EXHAUSTED");
  if (t.nextAttemptAt && t.nextAttemptAt.getTime() > now.getTime()) out.push("BACKOFF");
  if (!worker.capabilities.includes(t.capability)) out.push("CAPABILITY");
  return out;
}

/* ═════════════════════ KẾT THÚC MỘT LƯỢT ═════════════════════ */

/** Kết cục worker được phép báo — danh sách ĐÓNG. Câu chữ của model không phải một kết cục. */
export const TECH_RUN_OUTCOMES = ["SUCCEEDED", "FAILED", "BLOCKED", "NEEDS_OWNER"] as const;
export type TechRunOutcome = (typeof TECH_RUN_OUTCOMES)[number];

export type CompletionDecision = {
  runStatus: "SUCCEEDED" | "FAILED" | "BLOCKED";
  /** Trạng thái việc kế tiếp (từ `BUILDING`). */
  taskTo: TechTaskStatus;
  /** Thử lại sau lùi dần (việc về `SPEC_READY`). */
  requeue: boolean;
  backoffMinutes: number | null;
};

/**
 * Bước kế tiếp sau một lượt — hàm thuần, tất định.
 *
 *  · `SUCCEEDED` ⇒ `REVIEW` (đã có nhánh; PR / cổng CI quyết tiếp — không bao giờ nhảy thẳng tới deploy).
 *  · `FAILED` còn lần thử ⇒ về `SPEC_READY` sau lùi dần; hết lần ⇒ `FAILED` (việc VẪN MỞ, hiện ở nhóm "thất bại").
 *  · `BLOCKED` ⇒ `BLOCKED` (đề bài / môi trường hỏng — thử lại y nguyên là đốt tiền).
 *  · `NEEDS_OWNER` ⇒ `NEEDS_OWNER` (worker headless gặp OAuth / quyền / quyết định không hoàn tác).
 */
export function decideCompletion(outcome: TechRunOutcome, attempts: number, maxAttempts: number): CompletionDecision {
  switch (outcome) {
    case "SUCCEEDED":
      return { runStatus: "SUCCEEDED", taskTo: "REVIEW", requeue: false, backoffMinutes: null };
    case "BLOCKED":
      return { runStatus: "BLOCKED", taskTo: "BLOCKED", requeue: false, backoffMinutes: null };
    case "NEEDS_OWNER":
      return { runStatus: "BLOCKED", taskTo: "NEEDS_OWNER", requeue: false, backoffMinutes: null };
    case "FAILED":
      return attempts < maxAttempts
        ? { runStatus: "FAILED", taskTo: "SPEC_READY", requeue: true, backoffMinutes: backoffMinutes(attempts) }
        : { runStatus: "FAILED", taskTo: "FAILED", requeue: false, backoffMinutes: null };
  }
}

/* ═════════════════════ NHÁNH & CÂY LÀM VIỆC ═════════════════════ */

/**
 * Tên nhánh / thư mục TẤT ĐỊNH theo mã việc và lần thử: `tech/TECH-12-a2`. Đọc tên nhánh là biết việc nào,
 * lần thử thứ mấy; thử lại không bao giờ đè lên nhánh của lần trước (bằng chứng của lần trước giữ nguyên).
 */
export function taskBranchName(taskCode: string, attempt: number): string {
  const code = taskCode.replace(/[^A-Za-z0-9-]/g, "").slice(0, 40);
  return `tech/${code}-a${Math.max(1, Math.trunc(attempt))}`;
}

export function taskWorktreeDirName(taskCode: string, attempt: number): string {
  return `wt-tech-${taskCode.toLowerCase().replace(/[^a-z0-9-]/g, "")}-a${Math.max(1, Math.trunc(attempt))}`;
}

/* ═════════════════════ RANH GIỚI THANH TOÁN ═════════════════════ */

/**
 * Biến môi trường mà tiến trình con được THẤY — danh sách CHO PHÉP (không phải danh sách cấm: quên khai thì
 * thiếu, không phải lộ). `DATABASE_URL`, token GitHub, khoá ERP KHÔNG BAO GIỜ đi xuống agent — `npm test`
 * chạy mã agent vừa sửa.
 */
const ENV_ALLOW = [
  "PATH",
  "Path",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "ComSpec",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TZ",
  "USER",
  "USERNAME",
  "SHELL",
  "TERM",
  "XDG_CONFIG_HOME",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
] as const;

/** Mọi biến có thể khiến Claude Code tính tiền theo API thay vì gói thuê bao. */
export const API_BILLING_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_BASE_URL", "AWS_BEARER_TOKEN_BEDROCK"] as const;

/**
 * Môi trường cho tiến trình agent. Subscription: CHỈ danh sách cho phép (không khoá API nào). API: thêm đúng
 * một khoá, lấy từ tên biến RIÊNG của worker — không bao giờ từ `ANTHROPIC_API_KEY` của máy (khoá đó có thể là
 * của sản phẩm khác, và vô tình có mặt là đường rơi sang API im lặng).
 */
export function buildChildEnv(
  provider: TechExecutionProvider,
  parent: Record<string, string | undefined>,
  apiKey: string | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ENV_ALLOW) {
    const v = parent[k];
    if (typeof v === "string") out[k] = v;
  }
  out.ERP_READ_ONLY = "1";
  out.CI = "1";
  if (provider === "ANTHROPIC_API") {
    if (!apiKey) throw new Error("ANTHROPIC_API cần khoá riêng của worker (TECH_WORKER_ANTHROPIC_API_KEY) — không mượn khoá của máy.");
    out.ANTHROPIC_API_KEY = apiKey;
  }
  assertBillingBoundary(provider, out);
  return out;
}

/** Lưới cuối: môi trường subscription mà có BẤT KỲ biến tính tiền API nào ⇒ ném lỗi, không chạy. */
export function assertBillingBoundary(provider: TechExecutionProvider, env: Record<string, string | undefined>) {
  if (provider !== "SUBSCRIPTION_CLAUDE_CODE") return;
  const lo = API_BILLING_ENV.filter((k) => typeof env[k] === "string" && env[k] !== "");
  if (lo.length) throw new Error(`Ranh giới thanh toán: worker gói thuê bao không được có ${lo.join(", ")} trong môi trường.`);
}

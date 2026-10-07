/**
 * ═══════════ CÀI WORKER MỘT NÚT CHO CHỦ SHOP KHÔNG KỸ THUẬT ═══════════
 *
 * docs/tech-control-plane/README.md mục 15. Tệp THUẦN, CLIENT-SAFE — không import `@/db`, không đọc đồng hồ, nên
 * trang `/tech/workers`, máy chủ, worker daemon và bài kiểm dùng CHUNG một luật.
 *
 * ─── VÌ SAO CÓ "MÃ GHI DANH" THAY VÌ KHOÁ WORKER ───
 *
 * Trước đây trang hiện khoá worker (`tw_<id>.<secret>`) rồi bảo chủ shop dán vào PowerShell. Ba vấn đề: chủ shop không
 * phải lập trình viên; khoá dài hạn nằm trong lịch sử PowerShell / ảnh chụp màn hình / tin nhắn; và khoá của
 * `dogfood-1` thật sự đã đi qua đúng đường đó. Bây giờ:
 *
 *   · Bộ cài tải về chỉ mang MÃ GHI DANH: dùng MỘT lần, sống `ENROLLMENT_TTL_MINUTES` phút, gắn với ĐÚNG một worker,
 *     CSDL chỉ giữ băm. Lộ bộ cài sau khi nó đã chạy là lộ một chuỗi đã chết.
 *   · Lần chạy đầu, bộ cài đổi mã lấy khoá: máy chủ XOAY khoá worker (khoá cũ chết ngay), trả khoá mới ĐÚNG MỘT LẦN
 *     cho bộ cài trong thân phản hồi. Khoá không bao giờ hiện cho người, không vào URL, không vào nhật ký.
 *   · Bộ cài cất khoá bằng DPAPI theo người dùng Windows (xem `lib/tech/worker-installer.ts`).
 */
import { API_BILLING_ENV, TECH_LEASE, workerLiveness, type TechExecutionProvider } from "@/lib/constants/tech-worker";

/* ═════════════════════ MÃ GHI DANH ═════════════════════ */

/** Mã ghi danh sống 30 phút: đủ cho winget cài Git + Node + Claude Code trên máy chậm, đủ ngắn để lộ ra là vô hại. */
export const ENROLLMENT_TTL_MINUTES = 30;
export const ENROLLMENT_CODE_PREFIX = "twe_";
/** Hình dạng ĐÓNG của mã — route từ chối trước khi chạm CSDL. */
export const ENROLLMENT_CODE_PATTERN = /^twe_[A-Za-z0-9_-]{32,64}$/;

export function enrollmentExpiry(now: Date): Date {
  return new Date(now.getTime() + ENROLLMENT_TTL_MINUTES * 60_000);
}

/** Một mã còn đổi được không — cùng điều kiện câu SQL đổi mã dùng (`used_at IS NULL AND revoked_at IS NULL AND expires_at > now`). */
export function enrollmentUsable(e: { usedAt: Date | null; revokedAt: Date | null; expiresAt: Date }, now: Date): boolean {
  return !e.usedAt && !e.revokedAt && e.expiresAt.getTime() > now.getTime();
}

/* ═════════════════════ MẶC ĐỊNH DOGFOOD ═════════════════════ */

/**
 * Worker đầu tiên (form tạo worker khi CHƯA có worker nào): chế độ dogfood an toàn. Trần chính sách R0 KHÔNG nằm ở
 * đây — nó là mặc định toàn cục của `tech.worker-policy-ceiling` (lib/constants/tech-worker.ts) và trang này KHÔNG có
 * đường mở R1.
 */
export const DOGFOOD_WORKER_DEFAULTS = {
  key: "dogfood-1",
  name: "Dogfood 1 — máy văn phòng",
  provider: "SUBSCRIPTION_CLAUDE_CODE" as TechExecutionProvider,
  capabilities: ["write-docs"] as string[],
  maxConcurrency: 1,
};

/**
 * Các khẳng định về CHÍNH SÁCH mà trang in cạnh mỗi worker. Không phải công tắc — chúng là hệ quả của mã đang chạy, và
 * `tests/tech-worker-onboarding.test.ts` đo lại từng câu từ nguồn thật (năng lực deploy `autonomous = false`, không có
 * đường rơi sang API…). Thêm một dòng ở đây mà không có phép đo đi kèm là khai khống.
 */
export const WORKER_POLICY_FACTS = [
  { key: "githubWrite", label: "Quyền ghi GitHub trên máy worker", value: "KHÔNG CÓ", why: "Worker chỉ nộp bộ thay đổi; máy chủ kiểm theo năng lực + chính sách của việc rồi tự ghi đúng nhánh ai/worker/* bằng bot." },
  { key: "apiFallback", label: "Rơi sang tiền API", value: "TẮT", why: "Worker gói thuê bao không bao giờ nhận khoá API; có ANTHROPIC_API_KEY trong môi trường là worker từ chối chạy." },
  { key: "destructive", label: "Thao tác phá huỷ", value: "CẤM", why: "Chính sách R4 (xoá dữ liệu, secret, DNS, thanh toán, lách cổng) luôn cần người; worker chỉ nhận tới trần R0." },
  { key: "deployProduction", label: "Deploy production", value: "CẤM", why: "Năng lực deploy-production không giao được cho worker tự động; deploy do người / Delivery Controller." },
] as const;

/* ═════════════════════ LỆNH SỬA — DANH SÁCH ĐÓNG ═════════════════════ */

/**
 * «Sửa lỗi tự động»: máy chủ ghi MỘT lệnh trong danh sách này, worker nhận ở nhịp tim kế và chỉ thi hành đúng lệnh
 * trong danh sách. Không có lệnh tuỳ ý, không có tham số — lệnh nào cần tham số là lệnh có thể bị bẻ cong.
 * Mỗi lệnh chỉ chạm thứ của CHÍNH worker (bản clone riêng, cây `wt-tech-*` của nó, tiến trình của nó).
 */
export const TECH_REPAIR_COMMANDS = ["RERUN_SELF_CHECK", "REFRESH_REPO", "PRUNE_WORKTREES", "RESTART_LOOP"] as const;
export type TechRepairCommand = (typeof TECH_REPAIR_COMMANDS)[number];

export const TECH_REPAIR_LABEL: Record<TechRepairCommand, { label: string; does: string }> = {
  RERUN_SELF_CHECK: { label: "Kiểm lại ngay", does: "Chạy lại tự kiểm (kết nối · đăng nhập Claude · kho · phiên bản) và gửi kết quả ở nhịp tim kế." },
  REFRESH_REPO: { label: "Làm mới kho của worker", does: "Lấy main mới nhất về bản clone RIÊNG của worker (fetch + đặt lại về origin/main), cài lại phụ thuộc nếu đổi, rồi khởi động lại." },
  PRUNE_WORKTREES: { label: "Dọn cây làm việc cũ", does: "Gỡ các cây wt-tech-* không thuộc lượt nào đang chạy (nhánh giữ nguyên làm bằng chứng)." },
  RESTART_LOOP: { label: "Khởi động lại worker", does: "Thoát vòng worker khi không giữ việc nào; trình khởi động tự mở lại." },
};

export function isTechRepairCommand(v: unknown): v is TechRepairCommand {
  return typeof v === "string" && (TECH_REPAIR_COMMANDS as readonly string[]).includes(v);
}

/** Mã thoát giữa worker và trình khởi động `start-worker.ps1` — đổi số ở đây là đổi ở cả hai nơi (bộ cài sinh từ hằng này). */
export const WORKER_EXIT = {
  CONFIG: 2,
  ADAPTER: 3,
  BILLING_BOUNDARY: 4,
  RESTART: 75,
  REFRESH_AND_RESTART: 76,
} as const;

/* ═════════════════════ RANH GIỚI THANH TOÁN LÚC KHỞI ĐỘNG ═════════════════════ */

/**
 * Vì sao worker KHÔNG được khởi động. Gói thuê bao mà CHÍNH tiến trình worker có `ANTHROPIC_API_KEY` (hoặc bất kỳ biến
 * tính tiền API nào) ⇒ từ chối chạy — kể cả khi `buildChildEnv` đã lọc biến đó khỏi tiến trình con. Lý do: biến có mặt
 * là dấu hiệu máy đang cấu hình cho tiền API; lọc im lặng thì chủ shop không bao giờ biết, và một bản worker cũ / bị sửa
 * sẽ rơi sang API mà không ai thấy. Thất bại ĐÓNG, có câu nói rõ phải gỡ gì.
 */
export function workerStartupBlockers(provider: TechExecutionProvider, env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  if (provider === "SUBSCRIPTION_CLAUDE_CODE") {
    const lo = API_BILLING_ENV.filter((k) => typeof env[k] === "string" && env[k] !== "");
    if (lo.length) out.push(`Worker gói thuê bao từ chối chạy: môi trường có ${lo.join(", ")}. Gỡ biến này (trình khởi động của bộ cài tự gỡ) — không bao giờ rơi sang tiền API.`);
  }
  return out;
}

/* ═════════════════════ BÁO CÁO TỰ KIỂM (CHẨN ĐOÁN) ═════════════════════ */

export const CLAUDE_AUTH_STATES = ["LOGGED_IN_SUBSCRIPTION", "LOGGED_IN_API", "NOT_LOGGED_IN", "UNKNOWN"] as const;
export type ClaudeAuthState = (typeof CLAUDE_AUTH_STATES)[number];

export const CLAUDE_AUTH_LABEL: Record<ClaudeAuthState, string> = {
  LOGGED_IN_SUBSCRIPTION: "Đã đăng nhập (gói thuê bao)",
  LOGGED_IN_API: "Đăng nhập bằng tiền API",
  NOT_LOGGED_IN: "Chưa đăng nhập",
  UNKNOWN: "Chưa rõ",
};

/** Cách nhánh lên GitHub: `SERVER_COMMIT` = worker nộp bộ thay đổi, máy chủ tự ghi nhánh (worker không giữ quyền ghi nào). */
export const PUSH_MODES = ["SERVER_COMMIT", "NONE"] as const;
export type PushMode = (typeof PUSH_MODES)[number];

export type WorkerDiagnostics = {
  checkedAt: string;
  workerVersion: string;
  platform: string;
  nodeVersion: string;
  gitVersion: string;
  claudeVersion: string;
  claudeAuth: ClaudeAuthState;
  repo: { ok: boolean; head: string; detail: string };
  adapter: { ok: boolean; detail: string };
  /** `true` ⇒ tiến trình worker KHÔNG có biến tính tiền API nào. */
  apiKeyAbsent: boolean;
  pushMode: PushMode;
  installMode: boolean;
  lastError: string;
};

/** Trần kích thước báo cáo lưu ở CSDL — đủ cho vài chục câu, không đủ để làm kênh đổ dữ liệu. */
export const DIAGNOSTICS_MAX_BYTES = 4096;
const SHORT = 200;
const LONG = 600;

/**
 * Che mọi chuỗi trông giống secret TRƯỚC khi lưu / hiện. Báo cáo do worker gửi lên, worker có thể là bản cũ / bị sửa /
 * vô tình chép một dòng lỗi có token — máy chủ không tin nó tự che.
 */
const SECRET_PATTERNS: RegExp[] = [
  /tw_[A-Za-z0-9-]{4,}\.[A-Za-z0-9_-]{8,}/g,
  /twe_[A-Za-z0-9_-]{8,}/g,
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /github_pat_[A-Za-z0-9_]{16,}/g,
  /x-access-token:[^@\s]+/gi,
  /\bBearer\s+[^\s"']+/gi,
  /\b(?:[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD))\s*[=:]\s*[^\s"']+/gi,
  /[A-Za-z0-9+/_-]{33,}={0,2}/g,
];

export function redactSecrets(s: string): string {
  let out = s;
  for (const p of SECRET_PATTERNS) out = out.replace(p, "[đã che]");
  return out;
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? redactSecrets(v).slice(0, max) : "";
}

/**
 * Lọc báo cáo tự kiểm: chỉ các trường đã khai, kiểu đúng, chuỗi đã che và cắt; quá trần thì bỏ dần trường chữ dài.
 * Trả `null` khi đầu vào không phải object — "không có báo cáo" khác "báo cáo rỗng".
 */
export function sanitizeWorkerDiagnostics(raw: unknown): WorkerDiagnostics | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const repo = (r.repo && typeof r.repo === "object" ? r.repo : {}) as Record<string, unknown>;
  const adapter = (r.adapter && typeof r.adapter === "object" ? r.adapter : {}) as Record<string, unknown>;
  const head = typeof repo.head === "string" && /^[0-9a-f]{7,40}$/.test(repo.head) ? repo.head : "";
  const d: WorkerDiagnostics = {
    checkedAt: typeof r.checkedAt === "string" && !Number.isNaN(Date.parse(r.checkedAt)) ? new Date(r.checkedAt).toISOString() : "",
    workerVersion: str(r.workerVersion, 60),
    platform: str(r.platform, 60),
    nodeVersion: str(r.nodeVersion, 40),
    gitVersion: str(r.gitVersion, 60),
    claudeVersion: str(r.claudeVersion, 60),
    claudeAuth: (CLAUDE_AUTH_STATES as readonly string[]).includes(r.claudeAuth as string) ? (r.claudeAuth as ClaudeAuthState) : "UNKNOWN",
    repo: { ok: repo.ok === true, head, detail: str(repo.detail, SHORT) },
    adapter: { ok: adapter.ok === true, detail: str(adapter.detail, LONG) },
    apiKeyAbsent: r.apiKeyAbsent === true,
    pushMode: (PUSH_MODES as readonly string[]).includes(r.pushMode as string) ? (r.pushMode as PushMode) : "NONE",
    installMode: r.installMode === true,
    lastError: str(r.lastError, LONG),
  };
  // Trần cứng: cắt dần các ô chữ dài cho tới khi vừa (các ô còn lại đều đã có trần nhỏ).
  for (const cat of [300, 120, 0]) {
    if (new TextEncoder().encode(JSON.stringify(d)).length <= DIAGNOSTICS_MAX_BYTES) break;
    d.lastError = d.lastError.slice(0, cat);
    d.adapter.detail = d.adapter.detail.slice(0, cat);
    d.repo.detail = d.repo.detail.slice(0, cat);
  }
  return d;
}

/**
 * Đọc `claude auth status --json` (Claude Code ≥ 2.1). CHỈ lấy `loggedIn` + `authMethod` — email / mã tổ chức trong
 * cùng gói JSON KHÔNG đi lên máy chủ. `authMethod = "claude.ai"` là gói thuê bao; mọi giá trị khác khi đã đăng nhập
 * (Console / khoá API) là tiền API. Không đọc được ⇒ `UNKNOWN`, không đoán.
 */
export function parseClaudeAuthStatus(raw: string): ClaudeAuthState {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return "UNKNOWN";
  }
  if (!j || typeof j !== "object") return "UNKNOWN";
  const o = j as { loggedIn?: unknown; authMethod?: unknown };
  if (o.loggedIn === false) return "NOT_LOGGED_IN";
  if (o.loggedIn !== true) return "UNKNOWN";
  return o.authMethod === "claude.ai" ? "LOGGED_IN_SUBSCRIPTION" : "LOGGED_IN_API";
}

/**
 * Worker có được XIN VIỆC không, theo báo cáo tự kiểm. Gói thuê bao đòi: không biến tính tiền API, đăng nhập BẰNG GÓI
 * THUÊ BAO (đăng nhập Console = Claude Code tính tiền API dù môi trường sạch — đường rơi im lặng thứ hai), adapter sẵn
 * sàng, kho đọc được. Chưa rõ trạng thái đăng nhập ⇒ KHÔNG xin việc (rơi về phía hẹp); worker vẫn đập nhịp tim để
 * trang thấy vì sao.
 */
export function workerReadiness(provider: TechExecutionProvider, d: Pick<WorkerDiagnostics, "apiKeyAbsent" | "claudeAuth" | "adapter" | "repo">): { ready: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!d.repo.ok) reasons.push(`Kho của worker chưa sẵn sàng: ${d.repo.detail || "không rõ"}`);
  if (!d.adapter.ok) reasons.push(`Claude Code chưa chạy được: ${d.adapter.detail || "không rõ"}`);
  if (provider === "SUBSCRIPTION_CLAUDE_CODE") {
    if (!d.apiKeyAbsent) reasons.push("Môi trường worker có biến tính tiền API — worker gói thuê bao không chạy.");
    if (d.claudeAuth === "LOGGED_IN_API") reasons.push("Claude Code đang đăng nhập bằng tiền API (Console) — đăng nhập lại bằng gói thuê bao.");
    if (d.claudeAuth === "NOT_LOGGED_IN") reasons.push("Claude Code chưa đăng nhập — chạy lại bộ cài để đăng nhập một lần.");
    if (d.claudeAuth === "UNKNOWN") reasons.push("Chưa đọc được trạng thái đăng nhập Claude Code — chưa xin việc cho tới khi đọc được.");
  }
  return { ready: reasons.length === 0, reasons };
}

/* ═════════════════════ BỐN BƯỚC HIỂN THỊ ═════════════════════ */

export const ONBOARDING_STEPS = ["Tạo worker", "Tải bộ cài", "Đăng nhập Claude nếu được yêu cầu", "Worker Online"] as const;
export type OnboardingStepState = "DONE" | "CURRENT" | "TODO" | "PROBLEM";

export type OnboardingInput = {
  provider: string;
  enabled: boolean;
  removedAt: Date | null;
  secretRevokedAt: Date | null;
  enrolledAt: Date | null;
  lastHeartbeatAt: Date | null;
  /** Có mã ghi danh còn đổi được (đã bấm «Tải bộ cài», bộ cài chưa chạy). */
  pendingEnrollment: boolean;
  diagnostics: WorkerDiagnostics | null;
};

/**
 * Worker đang ở bước nào trong bốn bước — hàm của các cột + đồng hồ, không cột trạng thái nào lưu nó. Gặp vấn đề thì
 * bước đó là `PROBLEM` kèm MỘT câu chỉ đúng việc chủ shop làm tiếp.
 */
export function onboardingProgress(w: OnboardingInput, now: Date): { steps: { label: string; state: OnboardingStepState }[]; next: string } {
  const st: OnboardingStepState[] = ["DONE", "TODO", "TODO", "TODO"];
  let next = "";
  const sub = w.provider === "SUBSCRIPTION_CLAUDE_CODE";
  const live = workerLiveness(w.lastHeartbeatAt, now);
  // Khoá đã bị thu hồi (khoá cũ có thể đã lộ / đã gỡ) và chưa ghi danh lại ⇒ quay về bước 2.
  // Worker chạy tay từ trước bộ cài (đã từng gửi nhịp tim bằng khoá hợp lệ) cũng là đã có khoá — không bắt cài lại.
  const daGhiDanh = (!!w.enrolledAt || !!w.lastHeartbeatAt) && !w.secretRevokedAt;
  if (w.removedAt) {
    st[1] = "PROBLEM";
    next = "Worker đã gỡ. Muốn dùng lại: bấm «Tải bộ cài» rồi chạy bộ cài trên máy.";
  } else if (!daGhiDanh) {
    st[1] = w.pendingEnrollment ? "CURRENT" : w.secretRevokedAt ? "PROBLEM" : "CURRENT";
    next = w.pendingEnrollment
      ? `Mở tệp bộ cài vừa tải (bấm đúp). Mã trong bộ cài hết hạn sau ${ENROLLMENT_TTL_MINUTES} phút — hết thì tải lại.`
      : w.secretRevokedAt
        ? "Khoá cũ đã bị thu hồi. Bấm «Tải bộ cài» để cấp khoá mới cho máy này."
        : "Bấm «Cài worker trên máy Windows này» rồi chạy tệp vừa tải.";
  } else {
    st[1] = "DONE";
    const auth = w.diagnostics?.claudeAuth ?? "UNKNOWN";
    if (sub && auth === "LOGGED_IN_API") {
      st[2] = "PROBLEM";
      next = "Claude Code trên máy đang đăng nhập bằng tiền API. Chạy lại bộ cài và chọn đăng nhập bằng gói thuê bao Claude.";
    } else if (sub && auth === "NOT_LOGGED_IN") {
      st[2] = "PROBLEM";
      next = "Claude Code chưa đăng nhập. Chạy lại bộ cài — nó sẽ mở cửa sổ đăng nhập Claude một lần.";
    } else {
      st[2] = !sub || auth === "LOGGED_IN_SUBSCRIPTION" ? "DONE" : "CURRENT";
      if (st[2] === "CURRENT") next = "Đang chờ worker báo trạng thái đăng nhập Claude.";
    }
    if (st[2] === "DONE") {
      if (live === "ONLINE") st[3] = "DONE";
      else {
        st[3] = live === "NEVER" ? "CURRENT" : "PROBLEM";
        next =
          live === "NEVER"
            ? "Đang chờ nhịp tim đầu tiên của worker."
            : !w.enabled
              ? "Worker đang tắt — bấm «Bật»."
              : `Worker im lặng quá ${TECH_LEASE.staleAfterSeconds} giây. Máy có đang bật và đăng nhập Windows không? Thử «Sửa lỗi tự động».`;
      }
    }
  }
  if (st[3] === "DONE" && !next) next = "Worker đang chạy.";
  return { steps: ONBOARDING_STEPS.map((label, i) => ({ label, state: st[i]! })), next };
}

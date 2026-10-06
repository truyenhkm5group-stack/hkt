/**
 * ═══════════ SỔ NĂNG LỰC (Capability Registry) ═══════════
 *
 * docs/tech-control-plane/README.md. Tệp THUẦN, CLIENT-SAFE. Năng lực là thứ một worker LÀM ĐƯỢC; vai (role)
 * chỉ là một nhóm năng lực. Mỗi dòng trỏ tới chỗ có THẬT trong kho đang hiện thực nó (`source`) — không khai
 * năng lực từ bộ skill tải trên mạng về. Bài kiểm mở từng tệp `source`.
 *
 * `autonomous = false` ⇒ worker KHÔNG BAO GIỜ tự nhận việc của năng lực này; nó chỉ tồn tại để màn hình nói
 * đúng ai làm (người, hoặc Delivery Controller cầm khoá integration-lead).
 */
import type { TechTaskType } from "@/lib/constants/tech";

export const TECH_ROLES = ["PLANNER", "DEV", "QA", "REVIEWER", "OPS"] as const;
export type TechRole = (typeof TECH_ROLES)[number];

export const TECH_ROLE_LABEL: Record<TechRole, string> = {
  PLANNER: "Lập kế hoạch",
  DEV: "Viết mã",
  QA: "Kiểm thử",
  REVIEWER: "Review",
  OPS: "Vận hành",
};

export type TechCapabilitySpec = {
  key: string;
  label: string;
  role: TechRole;
  /** Worker headless tự nhận được không. */
  autonomous: boolean;
  /** Tệp trong kho đang hiện thực / quy định năng lực này. */
  source: string;
  why: string;
};

export const TECH_CAPABILITIES = [
  { key: "repo-audit", label: "Kiểm kê kho mã", role: "PLANNER", autonomous: true, source: "docs/tech-control-plane/README.md", why: "Đọc hiện trạng trước khi đề xuất — Pha 0 của mọi sứ mệnh." },
  { key: "architecture-analysis", label: "Phân tích kiến trúc", role: "PLANNER", autonomous: true, source: "lib/agents/cto.ts", why: "AI CTO đề xuất kế hoạch; người duyệt mới áp." },
  { key: "implement-feature", label: "Làm tính năng", role: "DEV", autonomous: true, source: ".claude/agents/ai-tech-worker.md", why: "Viết mã trong cây riêng, đúng phạm vi việc." },
  { key: "fix-bug", label: "Sửa lỗi", role: "DEV", autonomous: true, source: ".claude/agents/ai-tech-worker.md", why: "Sửa lỗi có tái hiện, kèm bài kiểm khoá lỗi." },
  { key: "write-docs", label: "Viết tài liệu", role: "DEV", autonomous: true, source: "lib/constants/agent-sandbox.ts", why: "Việc R0 — đường đầu tiên đã chạy thật (TECH-2)." },
  { key: "database-migration", label: "Migration CSDL", role: "DEV", autonomous: false, source: "AGENTS.md", why: "Migration chỉ đi tới và chạm production — AGENTS.md mục 4; worker không tự nhận." },
  { key: "unit-test", label: "Bài kiểm đơn vị", role: "QA", autonomous: true, source: "tests/sync-fixtures.test.ts", why: "Thêm / sửa assertion — npm test là cổng." },
  { key: "playwright-e2e", label: "Kiểm thử đầu-cuối", role: "QA", autonomous: false, source: "scripts/smoke.ts", why: "Cần trình duyệt + phiên đăng nhập; chưa chạy headless an toàn được." },
  { key: "code-review", label: "Review mã", role: "REVIEWER", autonomous: false, source: ".claude/agents/ai-tech-reviewer.md", why: "Review độc lập PR rủi ro HIGH — dấu PASS chỉ phiên cầm khoá ghi được." },
  { key: "security-review", label: "Review an ninh", role: "REVIEWER", autonomous: false, source: "docs/erp-security-reliability.md", why: "Chạm xác thực / secret là R4 — người quyết." },
  { key: "ci-debug", label: "Gỡ CI đỏ", role: "QA", autonomous: true, source: ".github/workflows/gates.yml", why: "Đọc log cổng, sửa mã — không bao giờ nới cổng." },
  { key: "deploy-production", label: "Deploy production", role: "OPS", autonomous: false, source: ".github/workflows/deploy-vps.yml", why: "Chỉ Delivery Controller cầm khoá integration-lead dispatch (delivery-v2.md)." },
  { key: "verify-production", label: "Hậu kiểm production", role: "OPS", autonomous: false, source: "scripts/ai-tech.ts", why: "`verify --record`: SHA · migration · deploy · endpoint." },
  { key: "incident-response", label: "Xử lý sự cố", role: "OPS", autonomous: false, source: "lib/tech/sync-incident-watch.ts", why: "Sự cố production là lý do gọi chủ shop (PRODUCTION_INCIDENT)." },
  { key: "handoff", label: "Bàn giao", role: "OPS", autonomous: true, source: "scripts/ai-tech.ts", why: "`handoff`: nhánh đã đẩy + cây sạch ⇒ PR_READY." },
] as const satisfies readonly TechCapabilitySpec[];

export type TechCapability = (typeof TECH_CAPABILITIES)[number]["key"];

export const TECH_CAPABILITY_KEYS = TECH_CAPABILITIES.map((c) => c.key) as readonly TechCapability[];

export function isTechCapability(v: unknown): v is TechCapability {
  return typeof v === "string" && (TECH_CAPABILITY_KEYS as readonly string[]).includes(v);
}

/**
 * Năng lực mặc định theo loại việc — khi việc chưa khai năng lực riêng. Loại việc mà worker KHÔNG được tự làm
 * (sửa dữ liệu, migration, an ninh, hạ tầng) trỏ tới năng lực `autonomous = false`.
 */
export const CAPABILITY_BY_TASK_TYPE: Record<TechTaskType, TechCapability> = {
  FEATURE: "implement-feature",
  BUGFIX: "fix-bug",
  REFACTOR: "implement-feature",
  PERFORMANCE: "implement-feature",
  DATA_FIX: "database-migration",
  MIGRATION: "database-migration",
  INTEGRATION: "implement-feature",
  SECURITY: "security-review",
  DOCS: "write-docs",
  TEST: "unit-test",
  INFRA: "deploy-production",
  INVESTIGATION: "repo-audit",
};

/** Năng lực của việc: khai riêng thắng, không thì theo loại việc. */
export function taskCapability(task: { capability?: string | null; taskType: string }): string {
  if (task.capability && task.capability.trim()) return task.capability.trim();
  return CAPABILITY_BY_TASK_TYPE[task.taskType as TechTaskType] ?? "implement-feature";
}

/** Năng lực worker được khai — chỉ những năng lực `autonomous`. Khai năng lực không tự động là lỗi lúc đăng ký. */
export const TECH_AUTONOMOUS_CAPABILITIES = TECH_CAPABILITIES.filter((c) => c.autonomous).map((c) => c.key) as readonly TechCapability[];

/**
 * Đề bài cho agent + danh sách công cụ cho phép + cổng theo loại việc + đọc lời khai kết cục. THUẦN — bài kiểm
 * gọi thẳng. Không chứa luật nghiệp vụ nào ngoài việc trỏ agent tới đúng tệp luật của kho (AGENTS.md, CLAUDE.md):
 * luật sống ở MỘT chỗ.
 */
import { TECH_RUN_OUTCOMES, type TechRunOutcome } from "@/lib/constants/tech-worker";

export type BriefTask = {
  code: string;
  title: string;
  description: string;
  taskType: string;
  module: string;
  risk: string;
  capability: string;
  attempt: number;
  maxAttempts: number;
  mission: { code: string; title: string; definitionOfDone: string } | null;
};

/**
 * Công cụ cho phép (Claude Code `--allowedTools`). Không `git` ghi (worker commit, không phải agent — bằng chứng
 * không do chính đối tượng bị kiểm tạo ra), không mạng, không `npm install` gói lạ, không xoá.
 */
export function toolAllowlist(): string[] {
  return [
    "Read",
    "Edit",
    "Write",
    "Glob",
    "Grep",
    "Bash(git status:*)",
    "Bash(git diff:*)",
    "Bash(git log:*)",
    "Bash(npm run typecheck)",
    "Bash(npm run lint)",
  ];
}

/** Cổng worker tự đo trước khi đẩy. Bộ đầy đủ vẫn chạy ở CI (`gates / gates`) — đây chỉ là lọc sớm. */
export function gatesForTask(t: { taskType: string }): ("typecheck" | "lint" | "test")[] {
  return t.taskType === "DOCS" ? ["typecheck", "lint"] : ["typecheck", "lint", "test"];
}

export function buildAgentPrompt(t: BriefTask): string {
  return [
    `Bạn là worker headless của Phòng Tech AI, làm ĐÚNG MỘT việc trong cây làm việc hiện tại (một git worktree riêng, nhánh riêng).`,
    `Đọc AGENTS.md và CLAUDE.md của kho TRƯỚC khi sửa gì — đó là luật, không thương lượng.`,
    ``,
    `VIỆC ${t.code} — ${t.title}`,
    `Loại: ${t.taskType} · module: ${t.module} · rủi ro: ${t.risk} · năng lực: ${t.capability} · lần thử ${t.attempt}/${t.maxAttempts}`,
    t.mission ? `Thuộc sứ mệnh ${t.mission.code} — ${t.mission.title}. Xong nghĩa là: ${t.mission.definitionOfDone || "(chưa khai)"}` : ``,
    ``,
    `Mô tả:`,
    t.description || "(không có mô tả — nếu không đủ để làm, khai BLOCKED và nói thiếu gì)",
    ``,
    `LUẬT CỦA LƯỢT CHẠY:`,
    `- Chỉ sửa tệp cần cho việc này. KHÔNG git add / commit / push (worker làm). KHÔNG cài gói mới. KHÔNG sửa .github/, drizzle/, db/schema.ts, middleware.ts, lib/auth/.`,
    `- Không đổi giá trị kỳ vọng của bài kiểm để cho xanh. Không đọc .env, không in secret.`,
    `- Tiếng Việt có dấu cho giao diện / chú thích / tài liệu; tên biến tiếng Anh.`,
    `- Chạy được: npm run typecheck, npm run lint. Worker tự chạy cổng đầy đủ sau khi bạn xong.`,
    `- Không bao giờ chờ người trả lời. Cần quyền / đăng nhập / khoá / quyết định không hoàn tác ⇒ dừng và khai NEEDS_OWNER.`,
    ``,
    `KẾT THÚC: ghi tệp .tech-result.json ở gốc cây với đúng dạng`,
    `{"outcome":"SUCCEEDED|BLOCKED|NEEDS_OWNER|FAILED","summary":"một câu kết luận kiểm chứng được","ownerEscalation":"(chỉ khi NEEDS_OWNER) một trong APPROVAL_REQUIRED|CREDENTIAL_REQUIRED|PAYMENT_REQUIRED|EXTERNAL_AUTH_REQUIRED|IRREVERSIBLE_BUSINESS_DECISION|PRODUCTION_INCIDENT|SECURITY_INCIDENT|POLICY_CONFLICT|UNKNOWN_HIGH_RISK_STATE","ownerAction":"(chỉ khi NEEDS_OWNER) đúng việc chủ shop phải làm"}`,
  ]
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n");
}

export type AgentClaim = { outcome: TechRunOutcome | null; summary: string; ownerEscalation: string; ownerAction: string };

/** Lời khai của agent — CHỈ để đọc lý do. Hỏng / thiếu ⇒ `outcome: null` (worker tự đo bằng cổng). */
export function parseAgentResult(raw: string): AgentClaim {
  const empty: AgentClaim = { outcome: null, summary: "", ownerEscalation: "", ownerAction: "" };
  if (!raw.trim()) return empty;
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const o = typeof j.outcome === "string" && (TECH_RUN_OUTCOMES as readonly string[]).includes(j.outcome) ? (j.outcome as TechRunOutcome) : null;
    const s = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");
    return { outcome: o, summary: s(j.summary, 4000), ownerEscalation: s(j.ownerEscalation, 60), ownerAction: s(j.ownerAction, 2000) };
  } catch {
    return empty;
  }
}

/**
 * ═══════════ SỔ TECH ROOM CHIẾU VÀO `/tech` — TỪ VỰNG + HÀM THUẦN ═══════════
 *
 * Tệp THUẦN, CLIENT-SAFE (không import `@/db`, không gọi mạng). Đường đọc/ghi CSDL nằm ở
 * `lib/tech/registry-sync.ts` (máy chủ) và `lib/queries/tech-registry.ts`.
 *
 * ─── MỘT NGUỒN SỰ THẬT, MỘT PHÉP CHIẾU ───
 *
 * Sổ điều phối kỹ thuật là nhánh git `ai-control/registry` (ghi bằng `npm run ai -- …`, `scripts/ai-tech.ts`).
 * ERP KHÔNG ghi vào sổ đó và KHÔNG dựng một sổ thứ hai: bảng `tech_registry_missions` / `tech_registry_events`
 * chỉ là ẢNH CHỤP để `/tech` đọc nhanh trên điện thoại (AGENTS.md luật 19 — phép chiếu, không phải bản sao có
 * thẩm quyền). Muốn đổi trạng thái một sứ mệnh thì đổi ở sổ, rồi bấm «Đọc lại sổ».
 *
 * ─── HAI CHIỀU KHÔNG GỘP ───
 *
 *  · TRẠNG THÁI CHỦ SHOP (`missionControlState`) — đang chờ · đang chạy · bị chặn · chờ anh quyết · xong · …
 *  · MỨC GIAO HÀNG (`deliveryLevel`) — CODE_DONE (đã gộp) → DEPLOYED (production chứa commit gộp) →
 *    PRODUCT_VERIFIED (có bằng chứng kiểm HÀNH VI thật trên production).
 *
 * Chủ shop chốt 10/10/2026: DONE chỉ là XONG khi đạt PRODUCT_VERIFIED. Sổ ghi DONE mà bằng chứng chỉ chứng minh
 * health / phiên bản (`verify --record`) thì màn hình in «DONE (chưa kiểm production)» và KHÔNG đếm vào xong.
 */
import { TECH_OWNER_ESCALATIONS, TECH_OWNER_ESCALATION_LABEL, type TechOwnerEscalation } from "@/lib/constants/tech";

/** Nhánh sổ — cùng giá trị mặc định với `controlBranch` của `scripts/ai-tech.ts` (bài kiểm so hai nơi). */
export const TECH_REGISTRY_BRANCH = "ai-control/registry";

/** Trạng thái sổ — bản sao của `MISSION_STATES` trong `scripts/ai-tech.ts`; `tests/tech-mission-control.test.ts` so khớp. */
export const REGISTRY_MISSION_STATES = [
  "BACKLOG",
  "PLANNING",
  "READY",
  "RUNNING",
  "BLOCKED",
  "PR_READY",
  "INTEGRATING",
  "DEPLOYING",
  "VERIFYING",
  "DONE",
  "FAILED",
  "CANCELLED",
] as const;
export type RegistryMissionState = (typeof REGISTRY_MISSION_STATES)[number];

export const REGISTRY_PHASE_LABEL: Record<RegistryMissionState, string> = {
  BACKLOG: "Tồn đọng",
  PLANNING: "Đang lập kế hoạch",
  READY: "Sẵn sàng",
  RUNNING: "Đang làm",
  BLOCKED: "Bị chặn",
  PR_READY: "Đã bàn giao, chờ mở PR",
  INTEGRATING: "Đang gộp",
  DEPLOYING: "Đang deploy",
  VERIFYING: "Đang hậu kiểm",
  DONE: "Sổ ghi DONE",
  FAILED: "Thất bại",
  CANCELLED: "Đã huỷ",
};

export const REGISTRY_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type RegistryPriority = (typeof REGISTRY_PRIORITIES)[number];
export const REGISTRY_RISKS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type RegistryRisk = (typeof REGISTRY_RISKS)[number];

export const REGISTRY_RISK_LABEL: Record<RegistryRisk, string> = { LOW: "Rủi ro thấp", MEDIUM: "Rủi ro vừa", HIGH: "Rủi ro cao", CRITICAL: "Rủi ro nghiêm trọng" };
export const REGISTRY_RISK_TONE: Record<RegistryRisk, string> = {
  LOW: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  MEDIUM: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  HIGH: "bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  CRITICAL: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
};

/** Chín lý do được gọi chủ shop — CÙNG danh sách `OWNER_ESCALATIONS` của CLI (bài kiểm so khớp). */
export const REGISTRY_OWNER_ESCALATIONS = TECH_OWNER_ESCALATIONS;
export function ownerEscalationLabel(category: string | null | undefined): string {
  if (!category) return "Quyết định chủ shop";
  return TECH_OWNER_ESCALATION_LABEL[category as TechOwnerEscalation] ?? category;
}

export type RegistryEvidence = { merged?: string; deploy?: string; verify?: string; done?: string };
export type RegistryNeedsOwner = { category: string; action: string };
export type RegistryHandoff = { branch: string; sha: string; at: string; actor: string; title: string; summary: string; tests: string[] };

/** Một dòng sổ đã kiểm hình dạng (`lib/tech/registry-parse.ts::parseRegistryMission`). Mốc là chuỗi ISO UTC như sổ ghi. */
export type RegistryEntry = {
  missionId: string;
  title: string;
  businessGoal: string;
  status: RegistryMissionState;
  priority: RegistryPriority;
  risk: RegistryRisk;
  owner: string;
  worker: string | null;
  worktree: string | null;
  branch: string | null;
  baseSha: string | null;
  ownedPaths: string[];
  dependencies: string[];
  blockedBy: string[];
  relatedPrs: number[];
  migrationReservations: string[];
  definitionOfDone: string[];
  createdAt: string;
  updatedAt: string;
  lastHeartbeat: string;
  needsOwner: RegistryNeedsOwner | null;
  evidence: RegistryEvidence | null;
  handoff: RegistryHandoff | null;
  intakeVerdict: string | null;
};

/* ═════════════════════ TRẠNG THÁI CHỦ SHOP ═════════════════════ */

export const MISSION_CONTROL_STATES = ["WAITING_APPROVAL", "RUNNING", "BLOCKED", "QUEUED", "DONE_UNVERIFIED", "COMPLETED", "FAILED", "CANCELLED", "UNKNOWN"] as const;
export type MissionControlState = (typeof MISSION_CONTROL_STATES)[number];

export const MISSION_CONTROL_LABEL: Record<MissionControlState, string> = {
  QUEUED: "Đang chờ làm",
  RUNNING: "Đang chạy",
  BLOCKED: "Bị chặn",
  WAITING_APPROVAL: "Chờ chủ shop quyết",
  COMPLETED: "Xong (đã kiểm production)",
  DONE_UNVERIFIED: "DONE (chưa kiểm production)",
  FAILED: "Thất bại",
  CANCELLED: "Đã huỷ",
  UNKNOWN: "Trạng thái lạ",
};

export const MISSION_CONTROL_TONE: Record<MissionControlState, string> = {
  QUEUED: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  RUNNING: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  BLOCKED: "bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  WAITING_APPROVAL: "bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-950/60 dark:text-fuchsia-300",
  COMPLETED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  DONE_UNVERIFIED: "bg-orange-50 text-orange-800 dark:bg-orange-950/60 dark:text-orange-300",
  FAILED: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  CANCELLED: "bg-zinc-100 text-zinc-500 line-through dark:bg-zinc-800 dark:text-zinc-400",
  UNKNOWN: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
};

/** Sứ mệnh mang tiêu đề này ở trạng thái BLOCKED là một MỤC QUYẾT ĐỊNH (Tech Lead ghi bằng `claim owner-<việc> --status=BLOCKED`). */
export const OWNER_DECISION_TITLE_PREFIX = "QUYẾT ĐỊNH CHỦ SHOP:";
/** Nhánh khai báo của mục quyết định (không phải nhánh mã) — cùng quy ước với tiêu đề. */
export const OWNER_DECISION_BRANCH_PREFIX = "decision/";

export function isOwnerDecisionTitle(title: string): boolean {
  return title.trimStart().toUpperCase().startsWith(OWNER_DECISION_TITLE_PREFIX);
}

/** Bỏ tiền tố «QUYẾT ĐỊNH CHỦ SHOP:» để câu việc phải quyết đứng đầu thẻ. */
export function ownerDecisionQuestion(title: string): string {
  const t = title.trimStart();
  return isOwnerDecisionTitle(t) ? t.slice(OWNER_DECISION_TITLE_PREFIX.length).trim() : t;
}

const QUEUED_PHASES: ReadonlySet<RegistryMissionState> = new Set(["BACKLOG", "PLANNING", "READY"]);
const RUNNING_PHASES: ReadonlySet<RegistryMissionState> = new Set(["RUNNING", "PR_READY", "INTEGRATING", "DEPLOYING", "VERIFYING"]);

/**
 * Trạng thái chủ shop của MỘT dòng sổ. Thuần, tất định — không đọc đồng hồ (STALE là chiều riêng, `registryLiveness`).
 *
 * · DONE chỉ thành COMPLETED khi bằng chứng `done` đạt PRODUCT_VERIFIED; còn lại là DONE_UNVERIFIED.
 * · Cần chủ shop (`needs_owner`, hoặc BLOCKED + tiêu đề / nhánh khai là quyết định) ⇒ WAITING_APPROVAL, kể cả khi sổ ghi RUNNING.
 * · Không bao giờ suy «đang chạy» từ chỗ khác ngoài trạng thái sổ.
 */
export function missionControlState(e: Pick<RegistryEntry, "status" | "title" | "branch" | "needsOwner" | "evidence">): {
  state: MissionControlState;
  phase: RegistryMissionState | null;
  evidence: EvidenceClassification | null;
} {
  const status = e.status as string;
  if (status === "CANCELLED") return { state: "CANCELLED", phase: "CANCELLED", evidence: null };
  if (status === "FAILED") return { state: "FAILED", phase: "FAILED", evidence: null };
  if (status === "DONE") {
    const ev = classifyDoneEvidence(e.evidence?.done);
    return { state: ev.kind === "PRODUCT_VERIFIED" ? "COMPLETED" : "DONE_UNVERIFIED", phase: "DONE", evidence: ev };
  }
  if (!(REGISTRY_MISSION_STATES as readonly string[]).includes(status)) return { state: "UNKNOWN", phase: null, evidence: null };
  const phase = status as RegistryMissionState;
  const declaredDecision = phase === "BLOCKED" && (isOwnerDecisionTitle(e.title) || (e.branch ?? "").startsWith(OWNER_DECISION_BRANCH_PREFIX));
  if (e.needsOwner || declaredDecision) return { state: "WAITING_APPROVAL", phase, evidence: null };
  if (phase === "BLOCKED") return { state: "BLOCKED", phase, evidence: null };
  if (QUEUED_PHASES.has(phase)) return { state: "QUEUED", phase, evidence: null };
  if (RUNNING_PHASES.has(phase)) return { state: "RUNNING", phase, evidence: null };
  return { state: "UNKNOWN", phase, evidence: null };
}

/**
 * Sứ mệnh tạo tay trong `/tech` (`tech_missions`) cùng một bộ trạng thái. `executionState` là `deriveMissionExecution`.
 * DONE tay cũng phải qua cùng phép phân loại bằng chứng (câu `outcome_note`).
 */
export function manualMissionControlState(status: string, executionState: string, outcomeNote: string): MissionControlState {
  if (status === "CANCELLED") return "CANCELLED";
  if (status === "DONE") return classifyDoneEvidence(outcomeNote).kind === "PRODUCT_VERIFIED" ? "COMPLETED" : "DONE_UNVERIFIED";
  if (status === "PLANNING") return "QUEUED";
  if (status === "PAUSED") return "BLOCKED";
  if (status === "ACTIVE") {
    if (executionState === "NEEDS_OWNER") return "WAITING_APPROVAL";
    if (executionState === "BLOCKED") return "BLOCKED";
    return "RUNNING";
  }
  return "UNKNOWN";
}

/* ═════════════════════ BẰNG CHỨNG — PHÂN LOẠI BẢO THỦ ═════════════════════ */

export const EVIDENCE_CLASSES = ["PRODUCT_VERIFIED", "DEPLOY_ONLY", "NO_RUNTIME", "UNRECOGNIZED", "MISSING"] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];
export type EvidenceClassification = { kind: EvidenceClass; reason: string };

export const EVIDENCE_CLASS_LABEL: Record<EvidenceClass, string> = {
  PRODUCT_VERIFIED: "Đã kiểm hành vi trên production",
  DEPLOY_ONLY: "Chỉ chứng minh đã lên production (health / phiên bản / deploy xanh)",
  NO_RUNTIME: "Không đổi mã chạy — không có gì để kiểm trên production",
  UNRECOGNIZED: "Có câu bằng chứng nhưng không nhận ra được là kiểm production",
  MISSING: "Thiếu bằng chứng",
};

/** `close --no-runtime` của CLI viết đúng tiền tố này. */
const NO_RUNTIME_RE = /^\s*không đổi mã chạy\b/i;

/**
 * Dấu hiệu KIỂM HÀNH VI THẬT trên production. Danh sách đóng, mỗi mục một lý do đọc được — thêm mục là một quyết
 * định có chủ ý (kèm một ca kiểm), không phải nới cho vừa dữ liệu. Không chắc ⇒ KHÔNG phải PRODUCT_VERIFIED.
 */
const PRODUCT_MARKERS: readonly { re: RegExp; reason: string }[] = [
  { re: /\bnghiệm thu production\b/i, reason: "nghiệm thu chạy trên production" },
  { re: /(?:^|\s)[a-z][a-z0-9-]*(?:\s+--[a-z0-9-]+)*\s+--apply\b[^·;]{0,160}?\bPASS\b/, reason: "lệnh nghiệm thu --apply PASS" },
  { re: /\bops\s+[a-z][a-z0-9-]*\b[^·;]{0,120}?\bPASS\b/i, reason: "ops <tên> PASS" },
  { re: /\bchạy trên production PASS\b/i, reason: "kiểm chạy trên production PASS" },
  { re: /(?:^|[\s·(])HSLC\s*(?::|\/[a-z])/, reason: "số đo trên tổ chức HSLC production" },
  { re: /\bmở (?:trang |màn hình )?(?:production|HSLC)\b/i, reason: "mở trang production và mô tả điều thấy" },
  { re: /\bảnh (?:trước\/sau|before\/after|production)\b/i, reason: "ảnh trước/sau trên production" },
  { re: /\s\/[a-z][\w/<>.-]*\s+ở\s+\d+\s?px:/i, reason: "đo trang production ở bề rộng thật" },
];

/** Câu tự nói là CHƯA kiểm hết ⇒ không được coi là đã kiểm, kể cả khi có dấu hiệu tốt bên cạnh. */
const PARTIAL_MARKERS: readonly RegExp[] = [/\bCHƯA ĐO ĐƯỢC\b/i, /\bchưa kiểm\b/i, /\bchưa nghiệm thu\b/i];

const DEPLOY_MARKERS: readonly RegExp[] = [
  /\bverify\s+(?:ĐẠT|PASS)\b/i,
  /\bhậu kiểm\s+ĐẠT\b/i,
  /\bdeploy\b[^·;]{0,60}?\b(?:xanh|success|thành công)\b/i,
  /\bproduction\b/i,
];

export function classifyDoneEvidence(text: string | null | undefined): EvidenceClassification {
  const t = (text ?? "").trim();
  if (!t) return { kind: "MISSING", reason: "sổ không có câu bằng chứng `done`" };
  if (NO_RUNTIME_RE.test(t)) return { kind: "NO_RUNTIME", reason: "khai «không đổi mã chạy»" };
  const partial = PARTIAL_MARKERS.find((re) => re.test(t));
  const product = PRODUCT_MARKERS.find((m) => m.re.test(t));
  if (product && !partial) return { kind: "PRODUCT_VERIFIED", reason: product.reason };
  if (DEPLOY_MARKERS.some((re) => re.test(t))) {
    return { kind: "DEPLOY_ONLY", reason: partial ? "câu bằng chứng tự nói còn phần CHƯA đo / chưa kiểm" : "chưa thấy số đo hành vi nào trên production" };
  }
  return { kind: "UNRECOGNIZED", reason: "không thấy dấu hiệu kiểm production nào nhận ra được" };
}

/* ═════════════════════ MỨC GIAO HÀNG ═════════════════════ */

export const DELIVERY_LEVELS = ["NONE", "CODE_DONE", "DEPLOYED", "PRODUCT_VERIFIED"] as const;
export type DeliveryLevel = (typeof DELIVERY_LEVELS)[number];
export const DELIVERY_LEVEL_LABEL: Record<DeliveryLevel, string> = {
  NONE: "Chưa gộp",
  CODE_DONE: "Đã gộp (CODE_DONE)",
  DEPLOYED: "Đã lên production (DEPLOYED)",
  PRODUCT_VERIFIED: "Đã kiểm sản phẩm (PRODUCT_VERIFIED)",
};

/** Nhãn NGẮN cho ô bảng (bảng phải vừa một màn hình) — trang chi tiết dùng nhãn đầy đủ. */
export const DELIVERY_LEVEL_SHORT: Record<DeliveryLevel, string> = {
  NONE: "Chưa gộp",
  CODE_DONE: "Đã gộp",
  DEPLOYED: "Đã lên production",
  PRODUCT_VERIFIED: "Đã kiểm sản phẩm",
};

/** Kết quả ERP tự hỏi GitHub «commit production có chứa commit gộp không». Rỗng = chưa hỏi / không hỏi được. */
export const DEPLOY_CHECKS = ["", "CONTAINED", "NOT_CONTAINED"] as const;
export type DeployCheck = (typeof DEPLOY_CHECKS)[number];

/** `verify` của CLI ghi «PASS <sha> <mốc>» — CHỈ chứng minh health / phiên bản ⇒ tối đa DEPLOYED. */
export function verifyPassed(verify: string | null | undefined): boolean {
  return /^\s*PASS\b/i.test(verify ?? "");
}

export function deliveryLevel(input: { evidence: RegistryEvidence | null; mergedEventSeen?: boolean; deployCheck?: DeployCheck | string }): DeliveryLevel {
  const ev = input.evidence ?? {};
  if (classifyDoneEvidence(ev.done).kind === "PRODUCT_VERIFIED") return "PRODUCT_VERIFIED";
  if (input.deployCheck === "CONTAINED" || verifyPassed(ev.verify)) return "DEPLOYED";
  if ((ev.merged ?? "").trim() || input.mergedEventSeen) return "CODE_DONE";
  return "NONE";
}

/** Commit gộp từ `evidence.merged` («#774 → bc5dacbf…»). Chỉ nhận SHA đủ 40 ký tự — SHA ngắn không hỏi GitHub được chắc chắn. */
export function parseMergeSha(merged: string | null | undefined): string | null {
  const m = /→\s*([0-9a-f]{40})\b/i.exec(merged ?? "");
  return m ? m[1].toLowerCase() : null;
}

/** Cổng CI lúc gộp, đọc từ chi tiết sự kiện MERGED của CLI («… (MERGE_NOW · LOW · gates success)»). Không có ⇒ CHƯA BIẾT. */
export function ciFromMergedDetail(detail: string | null | undefined): "SUCCESS" | "FAILURE" | "PENDING" | "" {
  const m = /\bgates\s+(success|failure|pending|skipped)\b/i.exec(detail ?? "");
  if (!m) return "";
  const v = m[1].toLowerCase();
  return v === "success" ? "SUCCESS" : v === "failure" ? "FAILURE" : v === "pending" ? "PENDING" : "";
}

/* ═════════════════════ NHỊP — STALE TÍNH LÚC ĐỌC ═════════════════════ */

/** Sứ mệnh ĐANG CHẠY mà sổ không có nhịp tim / cập nhật nào quá chừng này ⇒ STALE (suy ra lúc đọc, không ghi). */
export const REGISTRY_STALE_HOURS = 6;

export type RegistryLiveness = "FRESH" | "STALE" | "UNKNOWN";
export const REGISTRY_LIVENESS_LABEL: Record<RegistryLiveness, string> = {
  FRESH: "Có nhịp",
  STALE: `Đứng im > ${REGISTRY_STALE_HOURS} giờ`,
  UNKNOWN: "Không có nhịp",
};

/** Chỉ có nghĩa với RUNNING; trạng thái khác trả `null`. Mốc tương lai (đồng hồ lệch) coi là có nhịp. */
export function registryLiveness(state: MissionControlState, lastActivity: Date | null, now: Date): RegistryLiveness | null {
  if (state !== "RUNNING") return null;
  if (!lastActivity || !Number.isFinite(lastActivity.getTime())) return "UNKNOWN";
  return now.getTime() - lastActivity.getTime() > REGISTRY_STALE_HOURS * 3_600_000 ? "STALE" : "FRESH";
}

/** Mốc hoạt động cuối = mốc mới nhất trong các mốc CÓ THẬT (nhịp tim · cập nhật sổ · sự kiện cuối). */
export function latestActivity(...dates: (Date | string | null | undefined)[]): Date | null {
  let best: Date | null = null;
  for (const d of dates) {
    if (!d) continue;
    const x = d instanceof Date ? d : new Date(d);
    if (!Number.isFinite(x.getTime())) continue;
    if (!best || x > best) best = x;
  }
  return best;
}

/* ═════════════════════ DỰ ÁN — SUY TỪ TIỀN TỐ MÃ ═════════════════════ */

/**
 * Sổ CHƯA có trường dự án. Phép gán dưới đây SUY từ tiền tố mã sứ mệnh và màn hình nói rõ là suy — không phải khai.
 * Thứ tự quan trọng: mục đầu khớp thắng. Mục quyết định chủ shop nhận ra bằng TIÊU ĐỀ khai báo, không bằng mã.
 */
export const REGISTRY_PROJECTS = [
  { key: "owner", label: "Quyết định chủ shop" },
  { key: "saas", label: "SaaS Platform" },
  { key: "hslc", label: "HSLC" },
  { key: "chotdon", label: "Chốt Đơn AI" },
  { key: "tech", label: "Hạ tầng · điều phối" },
  { key: "erp", label: "VNXCommerce ERP" },
] as const;
export type RegistryProjectKey = (typeof REGISTRY_PROJECTS)[number]["key"];

const PROJECT_PREFIXES: readonly [RegistryProjectKey, readonly string[]][] = [
  ["tech", ["tech-", "ai-tech", "registry-", "master-mission", "board-", "ledger-", "owner-requirements", "deploy-", "migration-", "golden-", "ops-signals", "sec-", "security-", "sync-", "docs-"]],
  ["saas", ["saas-", "billing-", "pricing-", "legal-", "shell-", "acceptance-", "launch-gate", "commercial-", "onboarding-", "platform-"]],
  ["hslc", ["hslc-"]],
  ["chotdon", ["inbox-", "ai-sales-", "sales-", "chatbot-", "bot-", "messenger-", "meta-", "ban-hang", "order-confirm", "conversation-", "cutover-", "org-ai-", "ai-provider", "ai-balance", "ai-settings", "returning-", "industry-terms", "pancake-"]],
];

export function registryProject(missionId: string, title = ""): RegistryProjectKey {
  if (isOwnerDecisionTitle(title)) return "owner";
  for (const [key, prefixes] of PROJECT_PREFIXES) if (prefixes.some((p) => missionId.startsWith(p))) return key;
  return "erp";
}

export function registryProjectLabel(key: string): string {
  return REGISTRY_PROJECTS.find((p) => p.key === key)?.label ?? key;
}

/* ═════════════════════ BÁO LARK — AI ĐƯỢC BÁO, KHI NÀO ═════════════════════ */

/** Chuyển trạng thái cũ hơn chừng này thì không báo nữa (vd Lark hỏng cả ngày) — tránh một tràng tin cũ khi kênh sống lại. */
export const REGISTRY_NOTIFY_MAX_AGE_HOURS = 48;

/**
 * Trạng thái nào ĐÁNG một tin: sứ mệnh P0/P1 hoặc rủi ro HIGH/CRITICAL vừa XONG (đã kiểm production), và MỌI sứ mệnh
 * vừa chuyển sang chờ chủ shop. `DONE (chưa kiểm production)` KHÔNG báo — báo «xong» cho một thứ chưa kiểm là nói dối.
 */
export function registryNotifyKind(state: MissionControlState, priority: string, risk: string): "COMPLETED" | "WAITING_APPROVAL" | null {
  if (state === "WAITING_APPROVAL") return "WAITING_APPROVAL";
  if (state === "COMPLETED" && (priority === "P0" || priority === "P1" || risk === "HIGH" || risk === "CRITICAL")) return "COMPLETED";
  return null;
}

/** Khoá của MỘT lần chuyển trạng thái: trạng thái + mốc bắt đầu trạng thái đó. Cùng khoá ⇒ đã báo, không báo lại. */
export function registryNotifyKey(state: MissionControlState, stateSince: Date): string {
  return `${state}@${stateSince.toISOString()}`;
}

/* ═════════════════════ BẢNG MISSION CONTROL ═════════════════════ */

/** Cột sắp được của `/tech/missions` — `id` cột trùng khoá ở đây (AGENTS.md §2). */
export const MISSION_CONTROL_SORTABLE = ["updatedAt", "priority", "code", "state"];
/** Cỡ trang mặc định — máy chủ (`parseListParams`) và bảng (`DataTable`) đọc CÙNG số, lệch là phân trang sai. */
export const MISSION_CONTROL_PAGE_SIZE = 50;
export const MISSION_CONTROL_FILTER_KEYS = ["state", "project", "owner", "priority", "source"];

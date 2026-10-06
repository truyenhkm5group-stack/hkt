/**
 * ═══════════ AI TECH ROOM — ĐIỀU PHỐI VIỆC KỸ THUẬT NHIỀU PHIÊN TRÊN MỘT MÁY ═══════════
 *
 * Đặc tả: `docs/ai-tech-room/README.md`. Cách dùng: `npm run ai -- help`.
 *
 * ─── VÌ SAO MỘT TỆP, CHỈ THƯ VIỆN CHUẨN ───
 *
 * Công cụ phải chạy được trong một worktree VỪA TẠO, chưa `npm ci` (`node scripts/ai-tech.ts …`
 * trên Node ≥ 22.18 tự bỏ kiểu TS). Một bộ điều phối phải cài 900 gói mới trả lời được "đang chạy
 * gì" là bộ điều phối không ai mở. Không import tương đối nào vì Node gốc đòi đuôi `.ts`, còn
 * `tsconfig` của kho không cho — nên mọi thứ nằm ở đây, chia mục rõ ràng.
 *
 * ─── BA LUẬT ───
 *
 * 1. **Tệp sứ mệnh giữ Ý ĐỊNH, git giữ SỰ THẬT.** `.ai/missions/<id>.json` khai việc, phụ thuộc,
 *    phạm vi ghi, rủi ro, và những quyết định chỉ người/Lead mới biết (chặn · hoãn · huỷ). Trạng
 *    thái chạy (RUNNING · REVIEW · MERGED …) KHÔNG lưu — nó được SUY RA từ git mỗi lần đọc. Một
 *    trạng thái đã lưu mà không ai đối chiếu là lời khai cũ, và sau một lần sập máy nó sẽ nói dối.
 * 2. **Không ghi vào cây không do mình tạo.** Đọc trạng thái cây khác bằng `--no-optional-locks`
 *    (không làm mới index của người khác). Dọn chỉ cây có phiếu giao việc của công cụ, trừ khi
 *    người gọi khai `--allow-unowned` — và kể cả thế, cây bẩn / có commit chưa lên remote / vừa
 *    dùng gần đây thì KHÔNG BAO GIỜ bị dọn.
 * 3. **Không shell.** Mọi lời gọi git là `spawnSync("git", [mảng tham số])`; tên việc phải khớp
 *    `SLUG_RE` trước khi thành tên nhánh hay đường dẫn. `$(…)` trong tên việc là lỗi kiểm tra,
 *    không phải lệnh.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

/* ═════════════ 1 · TỪ VỰNG ═════════════ */

export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Rủi ro chỉ NÂNG được bởi sàn theo đường dẫn (`riskFloor`), không bao giờ hạ. */
export const RISKS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type Risk = (typeof RISKS)[number];

/** INLINE = Lead tự làm trong cây của mình; WORKER = một cây + một nhánh riêng. */
export const MODES = ["INLINE", "WORKER"] as const;
export type Mode = (typeof MODES)[number];

/** Chín lý do DUY NHẤT được phép gọi chủ shop. Mọi câu hỏi kỹ thuật khác: chính sách đã trả lời. */
export const OWNER_ESCALATIONS = [
  "APPROVAL_REQUIRED",
  "CREDENTIAL_REQUIRED",
  "PAYMENT_REQUIRED",
  "EXTERNAL_AUTH_REQUIRED",
  "IRREVERSIBLE_BUSINESS_DECISION",
  "PRODUCTION_INCIDENT",
  "SECURITY_INCIDENT",
  "POLICY_CONFLICT",
  "UNKNOWN_HIGH_RISK_STATE",
] as const;
/** `EXTERNAL_DEPENDENCY` = chờ một hợp đồng / sứ mệnh khác — bị chặn nhưng KHÔNG phải việc của chủ shop. */
export const BLOCKER_CATEGORIES = [...OWNER_ESCALATIONS, "EXTERNAL_DEPENDENCY"] as const;
export type BlockerCategory = (typeof BLOCKER_CATEGORIES)[number];

export const TASK_STATUSES = [
  "BACKLOG", // còn chờ phụ thuộc
  "READY", // đủ điều kiện bắt đầu
  "RUNNING", // có cây, đang làm (bẩn · chưa đẩy · chưa commit)
  "REVIEW", // đã đẩy, sạch — chờ PR / cổng / duyệt
  "BLOCKED",
  "DEFERRED",
  "MERGED", // có BẰNG CHỨNG đã vào nhánh tích hợp
  "DEPLOYED", // đã vào + Lead ghi bằng chứng deploy
  "DONE", // việc INLINE / không nhánh, Lead ghi bằng chứng
  "CANCELLED",
  "ORPHANED", // tệp khai có lượt chạy nhưng git không còn cây lẫn nhánh trên remote — phải đối chiếu
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Trạng thái coi như phụ thuộc đã xong. */
const SATISFIED: ReadonlySet<TaskStatus> = new Set(["MERGED", "DEPLOYED", "DONE"]);

export const WORKTREE_CLASSES = [
  "MAIN", // cây chính của kho — không bao giờ dọn
  "CURRENT", // cây đang chạy lệnh — không bao giờ tự dọn chính mình
  "ACTIVE",
  "IDLE",
  "STALE_CLEAN",
  "STALE_DIRTY",
  "MERGED_SAFE_TO_CLEAN",
  "UNKNOWN",
] as const;
export type WorktreeClass = (typeof WORKTREE_CLASSES)[number];

/** Bằng chứng đã vào nhánh tích hợp. Mỗi loại một cách đo; không loại nào là "trông có vẻ cũ". */
export type MergeEvidence =
  | "ANCESTOR" // đầu nhánh là tổ tiên của nhánh tích hợp (merge thường / fast-forward)
  | "PR_SUBJECT" // nhánh tích hợp có commit kết thúc bằng "(#<pr>)" — dấu squash-merge của kho này
  | "PR_MERGED" // GitHub nói PR đã merge (chỉ khi gọi với --github)
  | "CONTENT" // mọi tệp nhánh đã đổi đều GIỐNG HỆT ở nhánh tích hợp (squash không ghi số PR)
  | "EMPTY"; // nhánh không có commit nào ngoài gốc — không có gì để mất, cũng không có gì đã làm

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
/**
 * Tên ref đưa vào tham số git: không bắt đầu bằng `-` (nếu không `--all` thành một CỜ), không
 * `HEAD` (đo theo cây đang đứng chứ không theo nhánh tích hợp), không `..`.
 */
export const REF_RE = /^(?!-)(?!HEAD$)(?!.*\.\.)[A-Za-z0-9._/-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const MANIFEST_FILE = "ai-tech-task.json";

/* ═════════════ 2 · KIỂU DỮ LIỆU ═════════════ */

export type Decision =
  | { state: "BLOCKED"; category: BlockerCategory; reason: string; ownerAction?: string; resumes?: string }
  | { state: "DEFERRED"; reason: string }
  | { state: "CANCELLED"; reason: string }
  | { state: "DONE"; evidence: string };

/**
 * Ghi bởi `spawn` (và `cleanup` thêm ba trường cuối) — hai chỗ duy nhất công cụ tự ghi vào tệp sứ
 * mệnh. `mergedEvidence` là bằng chứng ĐÃ ĐO lúc dọn: sau khi cây, nhánh cục bộ và (do GitHub tự
 * xoá) nhánh remote đều mất, đó là dấu vết duy nhất còn lại rằng việc đã vào — thiếu nó thì một
 * việc xong xuôi sẽ bị suy thành ORPHANED.
 */
export type TaskRun = {
  branch: string;
  worktree: string;
  baseRef: string;
  baseSha: string;
  createdAt: string;
  cleanedAt?: string;
  mergedTip?: string;
  mergedEvidence?: MergeEvidence;
};

export type Task = {
  id: string;
  slug?: string;
  title: string;
  objective: string;
  mode: Mode;
  priority: Priority;
  risk: Risk;
  dependsOn: string[];
  /** Mặc định cây dựng từ nhánh tích hợp. Ghi id một phụ thuộc để dựng chồng lên nhánh của nó (hạn chế dùng). */
  base?: string;
  owns: string[];
  readOnly: string[];
  doNotTouch: string[];
  tests: string[];
  definitionOfDone: string[];
  expectedOutput?: string;
  integrationNotes?: string;
  decision?: Decision;
  run?: TaskRun;
  pr?: number;
  deploy?: { sha: string; evidence: string };
};

export type Mission = {
  schema: 1;
  id: string;
  title: string;
  goal: string;
  /** Ref mà "đã vào" được đo với. Mặc định `config.integrationRef` (origin/main). */
  integrationRef?: string;
  maxWorkers?: number;
  tasks: Task[];
};

export type Hotspot = { path: string; rule: "SERIAL" | "SHARED"; reason: string };
export type RiskFloor = { path: string; risk: Risk; reason: string };
export type Config = {
  maxImplementationWorkers: number;
  remote: string;
  integrationRef: string;
  branchPrefix: string;
  worktreePrefix: string;
  activeWithinHours: number;
  staleAfterDays: number;
  /** Mọi lượt dọn chờ ít nhất chừng này phút sau lần cuối có người động vào cây. */
  cleanupGraceMinutes: number;
  hotspots: Hotspot[];
  riskFloor: RiskFloor[];
  /**
   * Nhánh giữ SỔ ĐĂNG KÝ xuyên sứ mệnh (mục 13). Bắt buộc dạng `ai-control/<tên>`: đó là ref DUY NHẤT
   * công cụ được đẩy lên, nên cấu hình không thể trỏ nó vào `main` hay một nhánh mã.
   */
  controlBranch: string;
  /** Sứ mệnh RUNNING im lặng quá chừng này giờ ⇒ bảng điều khiển báo "nhịp tim cũ". */
  staleHeartbeatHours: number;
  /** Thời hạn mặc định của một khoá (Integration Lead, Tech Lead) — hết hạn mà không gia hạn là nhả. */
  leaseMinutes: number;
  /** `GET` công khai trả `{ ok, commit, platform.migrations }` của bản đang chạy. Rỗng = không hậu kiểm được. */
  healthUrl: string;
  /** Đường dẫn công khai phải trả 2xx/3xx sau deploy (đọc tương đối với gốc của `healthUrl`). */
  verifyEndpoints: string[];
  /** Tệp nằm trọn trong các mẫu này mà không chạm sàn nào ⇒ LOW; ngoài ra mặc định MEDIUM. */
  lowRiskPaths: string[];
  /** Ai được gộp một PR theo rủi ro của nó (mục 13 · hàng đợi gộp). */
  mergePolicy: Record<Risk, MergePolicy>;
  /** Tệp KHÔNG chạy trên VPS — `close --no-runtime` chỉ được nhận khi mọi tệp sứ mệnh chạm đều nằm ở đây. */
  nonRuntimePaths: string[];
};

/** AUTO = Integration Lead gộp khi cổng xanh · LEAD_REVIEW = cần một lượt review độc lập ghi vào PR · OWNER = chủ shop duyệt. */
export const MERGE_POLICIES = ["AUTO", "LEAD_REVIEW", "OWNER"] as const;
export type MergePolicy = (typeof MERGE_POLICIES)[number];

export const DEFAULT_CONFIG: Config = {
  maxImplementationWorkers: 4,
  remote: "origin",
  integrationRef: "origin/main",
  branchPrefix: "claude/",
  worktreePrefix: "wt-",
  activeWithinHours: 24,
  staleAfterDays: 7,
  cleanupGraceMinutes: 30,
  hotspots: [],
  riskFloor: [],
  controlBranch: "ai-control/registry",
  staleHeartbeatHours: 24,
  leaseMinutes: 60,
  healthUrl: "",
  verifyEndpoints: [],
  lowRiskPaths: [],
  mergePolicy: { LOW: "AUTO", MEDIUM: "AUTO", HIGH: "LEAD_REVIEW", CRITICAL: "OWNER" },
  // `.github/` CỐ Ý không nằm đây: đổi đường deploy thì phải deploy thật một lượt và hậu kiểm nó.
  nonRuntimePaths: ["docs/", "tests/", ".ai/", ".claude/", "AGENTS.md", "CLAUDE.md", "README.md", "scripts/ai-tech.ts"],
};

/** Nhánh điều khiển hợp lệ — công cụ CHỈ đẩy lên đúng loại ref này (mục 13). */
export const CONTROL_BRANCH_RE = /^ai-control\/[a-z0-9][a-z0-9-]{0,40}$/;

/** Phiếu giao việc — nằm trong thư mục quản trị git của cây (không bao giờ bị `git add` nhầm). */
export type Manifest = {
  schema: 1;
  mission: { id: string; title: string; goal: string };
  task: Omit<Task, "run" | "decision" | "pr" | "deploy">;
  branch: string;
  worktree: string;
  baseRef: string;
  baseSha: string;
  integrationRef: string;
  createdAt: string;
  leadWorktree: string;
  /** LEAD = cây của chính Lead (dựng bằng `lead`); vắng = WORKER. Cây LEAD không ăn chỗ worker. */
  role?: "LEAD" | "WORKER";
};

/* ═════════════ 3 · KIỂM TRA ĐẦU VÀO ═════════════ */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const strArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Chuẩn hoá một mẫu đường dẫn tương đối trong kho. Trả `null` nếu mẫu thoát ra ngoài kho hay dùng
 * cú pháp ngoài `*` / `?` — bộ so chồng lấn dưới đây chỉ đúng với đúng tập cú pháp ấy.
 */
export function normalizePattern(p: string): string | null {
  const s = p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!s || s.startsWith("/") || /^[a-zA-Z]:/.test(s)) return null;
  if (s.split("/").includes("..")) return null;
  if (/[[\]{}!]/.test(s)) return null;
  return s;
}

/** Phần chữ cố định đứng trước ký tự đại diện đầu tiên, cắt về ranh giới thư mục. */
function literalBase(p: string): string {
  const i = p.search(/[*?]/);
  if (i < 0) return p.replace(/\/+$/, "");
  const cut = p.slice(0, i);
  const slash = cut.lastIndexOf("/");
  return slash < 0 ? "" : cut.slice(0, slash);
}

/** `a` nằm trong `b` theo RANH GIỚI THƯ MỤC (`lib/a` không nằm trong `lib/ab`). */
function within(a: string, b: string): boolean {
  return b === "" || a === b || a.startsWith(`${b}/`);
}

/**
 * Hai mẫu có thể chạm cùng một tệp không. CỐ Ý BÁO THỪA: mẫu có ký tự đại diện được coi như phủ
 * cả thư mục chứa nó. Báo thừa thì Lead tuần tự hoá hai việc lẽ ra chạy song song được — mất ít
 * phút. Báo thiếu thì hai cây cùng sửa một tệp — mất một buổi chiều (AGENTS.md mục 9).
 */
export function patternsOverlap(a: string, b: string): boolean {
  const A = literalBase(a);
  const B = literalBase(b);
  return within(A, B) || within(B, A);
}

function globToRegex(p: string): RegExp {
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*" && p[i + 1] === "*") {
      const slash = p[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^$()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Tệp `file` có thuộc mẫu `pattern` không — mẫu không đại diện phủ chính nó và mọi thứ bên dưới. */
export function fileInPattern(file: string, pattern: string): boolean {
  if (!/[*?]/.test(pattern)) return within(file, pattern.replace(/\/+$/, ""));
  return globToRegex(pattern).test(file);
}

const riskRank = (r: Risk) => RISKS.indexOf(r);

/** Sàn rủi ro theo phạm vi ghi: lấy mức CAO NHẤT trong các sàn chạm phạm vi. */
export function riskFloorFor(owns: readonly string[], cfg: Config): { risk: Risk; reasons: string[] } {
  let risk: Risk = "LOW";
  const reasons: string[] = [];
  for (const f of cfg.riskFloor) {
    if (!owns.some((o) => patternsOverlap(o, f.path))) continue;
    if (riskRank(f.risk) > riskRank(risk)) risk = f.risk;
    reasons.push(`${f.path} ⇒ ${f.risk}: ${f.reason}`);
  }
  return { risk, reasons };
}

export function parseConfig(raw: unknown): { config: Config; errors: string[] } {
  const errors: string[] = [];
  const c: Config = { ...DEFAULT_CONFIG, hotspots: [], riskFloor: [], verifyEndpoints: [], lowRiskPaths: [], mergePolicy: { ...DEFAULT_CONFIG.mergePolicy }, nonRuntimePaths: [...DEFAULT_CONFIG.nonRuntimePaths] };
  if (raw === undefined) return { config: c, errors };
  if (!isObj(raw)) return { config: c, errors: ["config: phải là một object JSON"] };
  const num = (k: "maxImplementationWorkers" | "activeWithinHours" | "staleAfterDays" | "cleanupGraceMinutes" | "staleHeartbeatHours" | "leaseMinutes", min: number, max: number) => {
    if (raw[k] === undefined) return;
    const v = raw[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) errors.push(`config.${k}: số nguyên ${min}–${max}`);
    else c[k] = v;
  };
  num("maxImplementationWorkers", 0, 8);
  num("activeWithinHours", 1, 24 * 14);
  num("staleAfterDays", 1, 365);
  num("cleanupGraceMinutes", 0, 24 * 60);
  num("staleHeartbeatHours", 1, 24 * 30);
  num("leaseMinutes", 5, 24 * 60);
  if (raw.controlBranch !== undefined) {
    if (typeof raw.controlBranch !== "string" || !CONTROL_BRANCH_RE.test(raw.controlBranch))
      errors.push("config.controlBranch: phải dạng ai-control/<tên> — đó là ref duy nhất công cụ được đẩy lên");
    else c.controlBranch = raw.controlBranch;
  }
  if (raw.healthUrl !== undefined) {
    if (typeof raw.healthUrl !== "string" || (raw.healthUrl !== "" && !/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[^\s]*$/.test(raw.healthUrl)))
      errors.push("config.healthUrl: URL https đầy đủ (hoặc rỗng)");
    else c.healthUrl = raw.healthUrl;
  }
  if (raw.verifyEndpoints !== undefined) {
    if (!strArr(raw.verifyEndpoints) || raw.verifyEndpoints.some((p) => !/^\/[A-Za-z0-9/_.-]*$/.test(p))) errors.push("config.verifyEndpoints: mảng đường dẫn bắt đầu bằng /");
    else c.verifyEndpoints = raw.verifyEndpoints;
  }
  if (raw.lowRiskPaths !== undefined) {
    const v = strArr(raw.lowRiskPaths) ? raw.lowRiskPaths.map(normalizePattern) : null;
    if (!v || v.some((x) => x === null)) errors.push("config.lowRiskPaths: mảng mẫu đường dẫn tương đối");
    else c.lowRiskPaths = v as string[];
  }
  if (raw.nonRuntimePaths !== undefined) {
    const v = strArr(raw.nonRuntimePaths) ? raw.nonRuntimePaths.map(normalizePattern) : null;
    if (!v || v.some((x) => x === null)) errors.push("config.nonRuntimePaths: mảng mẫu đường dẫn tương đối");
    else c.nonRuntimePaths = v as string[];
  }
  if (raw.mergePolicy !== undefined) {
    const v = raw.mergePolicy;
    if (!isObj(v) || Object.entries(v).some(([k, p]) => !RISKS.includes(k as Risk) || !MERGE_POLICIES.includes(p as MergePolicy)))
      errors.push(`config.mergePolicy: { ${RISKS.join("|")}: ${MERGE_POLICIES.join("|")} }`);
    else for (const [k, p] of Object.entries(v)) c.mergePolicy[k as Risk] = p as MergePolicy;
    // Chính sách chỉ được NỚI ở bậc thấp: CRITICAL luôn cần chủ shop (AGENTS.md mục 0 · mục 7).
    if (c.mergePolicy.CRITICAL !== "OWNER") errors.push("config.mergePolicy.CRITICAL: phải là OWNER — luật nghiệp vụ không được thương lượng");
  }
  for (const k of ["remote", "integrationRef"] as const) {
    if (raw[k] === undefined) continue;
    if (!isStr(raw[k]) || !REF_RE.test(raw[k] as string)) errors.push(`config.${k}: tên ref không hợp lệ`);
    else c[k] = raw[k] as string;
  }
  if (raw.branchPrefix !== undefined) {
    const v = raw.branchPrefix;
    if (typeof v !== "string" || !/^(?:[a-z0-9][a-z0-9-]*\/)*$/.test(v)) errors.push("config.branchPrefix: dạng `tên/` hoặc rỗng");
    else c.branchPrefix = v;
  }
  if (raw.worktreePrefix !== undefined) {
    const v = raw.worktreePrefix;
    if (typeof v !== "string" || !/^[a-z0-9-]*$/.test(v)) errors.push("config.worktreePrefix: chỉ a-z 0-9 -");
    else c.worktreePrefix = v;
  }
  const list = <T>(k: "hotspots" | "riskFloor", parse: (o: Record<string, unknown>, i: number) => T | null): T[] => {
    const v = raw[k];
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      errors.push(`config.${k}: phải là mảng`);
      return [];
    }
    return v.map((o, i) => (isObj(o) ? parse(o, i) : (errors.push(`config.${k}[${i}]: phải là object`), null))).filter((x): x is T => x !== null);
  };
  c.hotspots = list<Hotspot>("hotspots", (o, i) => {
    const p = isStr(o.path) ? normalizePattern(o.path) : null;
    if (!p || (o.rule !== "SERIAL" && o.rule !== "SHARED") || !isStr(o.reason)) {
      errors.push(`config.hotspots[${i}]: cần path hợp lệ, rule SERIAL|SHARED, reason`);
      return null;
    }
    return { path: p, rule: o.rule, reason: o.reason };
  });
  c.riskFloor = list<RiskFloor>("riskFloor", (o, i) => {
    const p = isStr(o.path) ? normalizePattern(o.path) : null;
    if (!p || !RISKS.includes(o.risk as Risk) || !isStr(o.reason)) {
      errors.push(`config.riskFloor[${i}]: cần path hợp lệ, risk ${RISKS.join("|")}, reason`);
      return null;
    }
    return { path: p, risk: o.risk as Risk, reason: o.reason };
  });
  return { config: c, errors };
}

/** Tập id phụ thuộc bắc cầu của mỗi việc (để biết hai việc có thể chạy song song không). */
function ancestorsOf(tasks: readonly Task[]): Map<string, Set<string>> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map<string, Set<string>>();
  const visit = (id: string, stack: Set<string>): Set<string> => {
    const hit = memo.get(id);
    if (hit) return hit;
    const out = new Set<string>();
    if (stack.has(id)) return out; // chu trình đã được báo ở chỗ khác — không lặp vô hạn
    stack.add(id);
    for (const d of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(d)) continue;
      out.add(d);
      for (const x of visit(d, stack)) out.add(x);
    }
    stack.delete(id);
    memo.set(id, out);
    return out;
  };
  for (const t of tasks) visit(t.id, new Set());
  return memo;
}

/** Trả về MỘT chu trình (danh sách id, khép kín) nếu có. */
export function findCycle(tasks: readonly Pick<Task, "id" | "dependsOn">[]): string[] | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const dfs = (id: string): string[] | null => {
    color.set(id, 1);
    stack.push(id);
    for (const d of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(d)) continue;
      const c = color.get(d) ?? 0;
      if (c === 1) return [...stack.slice(stack.indexOf(d)), d];
      if (c === 0) {
        const r = dfs(d);
        if (r) return r;
      }
    }
    stack.pop();
    color.set(id, 2);
    return null;
  };
  for (const t of tasks) if ((color.get(t.id) ?? 0) === 0) {
    const r = dfs(t.id);
    if (r) return r;
  }
  return null;
}

/** Hai việc chồng phạm vi ghi ở đâu — bỏ qua phần chồng nằm trọn trong một điểm nóng SHARED. */
export function scopeConflicts(a: readonly string[], b: readonly string[], cfg: Config): string[] {
  const out: string[] = [];
  const shared = cfg.hotspots.filter((h) => h.rule === "SHARED");
  for (const x of a)
    for (const y of b) {
      if (!patternsOverlap(x, y)) continue;
      const inShared = shared.some((h) => within(literalBase(x), literalBase(h.path)) && within(literalBase(y), literalBase(h.path)));
      if (!inShared) out.push(x === y ? x : `${x} ↔ ${y}`);
    }
  return out;
}

/** Điểm nóng SERIAL mà cả hai phạm vi cùng chạm — chỉ một việc được giữ nó tại một thời điểm. */
export function serialHotspotClash(a: readonly string[], b: readonly string[], cfg: Config): Hotspot[] {
  return cfg.hotspots.filter(
    (h) => h.rule === "SERIAL" && a.some((p) => patternsOverlap(p, h.path)) && b.some((p) => patternsOverlap(p, h.path)),
  );
}

export type Validation = { mission: Mission | null; errors: string[]; warnings: string[] };

export function validateMission(raw: unknown, cfg: Config): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(raw)) return { mission: null, errors: ["sứ mệnh: phải là một object JSON"], warnings };
  if (raw.schema !== 1) errors.push("schema: phải là 1");
  if (!isStr(raw.id) || !SLUG_RE.test(raw.id)) errors.push(`id: phải khớp ${SLUG_RE} (chữ thường, số, gạch ngang)`);
  if (!isStr(raw.title)) errors.push("title: bắt buộc");
  if (!isStr(raw.goal)) errors.push("goal: bắt buộc");
  if (raw.integrationRef !== undefined && (!isStr(raw.integrationRef) || !REF_RE.test(raw.integrationRef)))
    errors.push("integrationRef: tên ref không hợp lệ");
  if (raw.maxWorkers !== undefined) {
    const v = raw.maxWorkers;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > cfg.maxImplementationWorkers)
      errors.push(`maxWorkers: số nguyên 0–${cfg.maxImplementationWorkers} (trần trong .ai/config.json)`);
  }
  if (!Array.isArray(raw.tasks)) return { mission: null, errors: [...errors, "tasks: phải là mảng"], warnings };

  const tasks: Task[] = [];
  raw.tasks.forEach((t: unknown, i: number) => {
    const at = `tasks[${i}]`;
    if (!isObj(t)) {
      errors.push(`${at}: phải là object`);
      return;
    }
    const id = isStr(t.id) ? t.id : `#${i}`;
    const e = (m: string) => errors.push(`${id}: ${m}`);
    if (!isStr(t.id) || !SLUG_RE.test(t.id)) e(`id phải khớp ${SLUG_RE} — nó thành tên nhánh và tên thư mục`);
    if (t.slug !== undefined && (!isStr(t.slug) || !SLUG_RE.test(t.slug))) e(`slug phải khớp ${SLUG_RE}`);
    if (!isStr(t.title)) e("title bắt buộc");
    if (!isStr(t.objective)) e("objective bắt buộc");
    if (!MODES.includes(t.mode as Mode)) e(`mode: ${MODES.join("|")}`);
    if (!PRIORITIES.includes(t.priority as Priority)) e(`priority: ${PRIORITIES.join("|")}`);
    if (!RISKS.includes(t.risk as Risk)) e(`risk: ${RISKS.join("|")}`);
    for (const k of ["dependsOn", "owns", "readOnly", "doNotTouch", "tests", "definitionOfDone"] as const)
      if (t[k] !== undefined && !strArr(t[k])) e(`${k} phải là mảng chuỗi`);
    const pats = (k: "owns" | "readOnly" | "doNotTouch"): string[] =>
      (strArr(t[k]) ? t[k] : []).map((p) => {
        const n = normalizePattern(p);
        if (n === null) e(`${k}: mẫu "${p}" không hợp lệ (tương đối, không "..", chỉ dùng * và ?)`);
        return n ?? p;
      });
    const task: Task = {
      id,
      slug: isStr(t.slug) ? t.slug : undefined,
      title: isStr(t.title) ? t.title : "",
      objective: isStr(t.objective) ? t.objective : "",
      mode: (t.mode as Mode) ?? "WORKER",
      priority: (t.priority as Priority) ?? "P2",
      risk: (t.risk as Risk) ?? "LOW",
      dependsOn: strArr(t.dependsOn) ? t.dependsOn : [],
      base: isStr(t.base) ? t.base : undefined,
      owns: pats("owns"),
      readOnly: pats("readOnly"),
      doNotTouch: pats("doNotTouch"),
      tests: strArr(t.tests) ? t.tests : [],
      definitionOfDone: strArr(t.definitionOfDone) ? t.definitionOfDone : [],
      expectedOutput: isStr(t.expectedOutput) ? t.expectedOutput : undefined,
      integrationNotes: isStr(t.integrationNotes) ? t.integrationNotes : undefined,
      decision: undefined,
      run: undefined,
      pr: undefined,
      deploy: undefined,
    };
    if (t.decision !== undefined) {
      const d = t.decision;
      if (!isObj(d)) e("decision phải là object");
      else if (d.state === "BLOCKED") {
        if (!BLOCKER_CATEGORIES.includes(d.category as BlockerCategory)) e(`decision.category: ${BLOCKER_CATEGORIES.join("|")}`);
        if (!isStr(d.reason)) e("decision.reason bắt buộc — BLOCKED phải nói bị chặn bởi cái gì");
        const owner = OWNER_ESCALATIONS.includes(d.category as (typeof OWNER_ESCALATIONS)[number]);
        if (owner && !isStr(d.ownerAction)) e("decision.ownerAction bắt buộc khi cần chủ shop — nói ĐÚNG việc họ phải làm");
        task.decision = {
          state: "BLOCKED",
          category: d.category as BlockerCategory,
          reason: String(d.reason ?? ""),
          ownerAction: isStr(d.ownerAction) ? d.ownerAction : undefined,
          resumes: isStr(d.resumes) ? d.resumes : undefined,
        };
      } else if (d.state === "DEFERRED" || d.state === "CANCELLED") {
        if (!isStr(d.reason)) e(`decision.reason bắt buộc cho ${d.state}`);
        task.decision = { state: d.state, reason: String(d.reason ?? "") };
      } else if (d.state === "DONE") {
        if (!isStr(d.evidence)) e("decision.evidence bắt buộc cho DONE — commit, PR, hay lệnh đã chạy");
        task.decision = { state: "DONE", evidence: String(d.evidence ?? "") };
      } else e("decision.state: BLOCKED|DEFERRED|CANCELLED|DONE");
    }
    if (t.run !== undefined) {
      const r = t.run;
      if (!isObj(r) || !isStr(r.branch) || !isStr(r.worktree) || !isStr(r.baseRef) || !isStr(r.baseSha) || !isStr(r.createdAt))
        e("run: do `spawn` ghi — cần branch, worktree, baseRef, baseSha, createdAt");
      else
        task.run = {
          branch: r.branch,
          worktree: r.worktree,
          baseRef: r.baseRef,
          baseSha: r.baseSha,
          createdAt: r.createdAt,
          cleanedAt: isStr(r.cleanedAt) ? r.cleanedAt : undefined,
          mergedTip: isStr(r.mergedTip) ? r.mergedTip : undefined,
          mergedEvidence: ["ANCESTOR", "PR_SUBJECT", "PR_MERGED", "CONTENT"].includes(r.mergedEvidence as string) ? (r.mergedEvidence as MergeEvidence) : undefined,
        };
    }
    if (t.pr !== undefined) {
      if (typeof t.pr !== "number" || !Number.isInteger(t.pr) || t.pr <= 0) e("pr: số PR nguyên dương");
      else task.pr = t.pr;
    }
    if (t.deploy !== undefined) {
      const d = t.deploy;
      if (!isObj(d) || !isStr(d.sha) || !isStr(d.evidence)) e("deploy: cần sha + evidence (link lượt deploy / smoke)");
      else task.deploy = { sha: d.sha, evidence: d.evidence };
    }
    if (task.mode === "WORKER") {
      if (task.owns.length === 0) e("việc WORKER phải khai owns — không khai phạm vi ghi thì không ai biết nó đụng ai");
      if (task.tests.length === 0) e("tests: việc WORKER phải khai lệnh kiểm thử");
    }
    if (task.definitionOfDone.length === 0) e("definitionOfDone: ít nhất một tiêu chí");
    for (const o of task.owns)
      for (const d of task.doNotTouch)
        if (within(literalBase(o), literalBase(d))) e(`owns "${o}" nằm trong doNotTouch "${d}" — tự mâu thuẫn`);
    const floor = riskFloorFor(task.owns, cfg);
    if (RISKS.includes(task.risk) && riskRank(task.risk) < riskRank(floor.risk))
      e(`risk ${task.risk} thấp hơn sàn ${floor.risk} của phạm vi ghi (${floor.reasons.join("; ")}) — rủi ro chỉ nâng, không hạ`);
    tasks.push(task);
  });

  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) errors.push(`${t.id}: id trùng`);
    ids.add(t.id);
  }
  const slugs = new Map<string, string>();
  for (const t of tasks) {
    const s = t.slug ?? t.id;
    const prev = slugs.get(s);
    if (prev && prev !== t.id) errors.push(`${t.id}: slug "${s}" trùng với ${prev} — hai việc sẽ tranh một tên nhánh`);
    slugs.set(s, t.id);
  }
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (d === t.id) errors.push(`${t.id}: tự phụ thuộc chính mình`);
      else if (!ids.has(d)) errors.push(`${t.id}: phụ thuộc "${d}" không tồn tại`);
    }
    if (t.base !== undefined && t.base !== "integration" && !t.dependsOn.includes(t.base))
      errors.push(`${t.id}: base "${t.base}" phải là "integration" hoặc một id trong dependsOn`);
  }
  const cycle = findCycle(tasks);
  if (cycle) errors.push(`chu trình phụ thuộc: ${cycle.join(" → ")}`);

  if (!cycle) {
    const anc = ancestorsOf(tasks);
    const workers = tasks.filter((t) => t.mode === "WORKER" && t.decision?.state !== "CANCELLED");
    for (let i = 0; i < workers.length; i++)
      for (let j = i + 1; j < workers.length; j++) {
        const a = workers[i];
        const b = workers[j];
        if (anc.get(a.id)?.has(b.id) || anc.get(b.id)?.has(a.id)) continue; // đã có thứ tự
        const clash = scopeConflicts(a.owns, b.owns, cfg);
        if (clash.length) warnings.push(`${a.id} ↔ ${b.id}: chồng phạm vi ghi (${clash.join(", ")}) — bộ xếp lịch sẽ tuần tự hoá; cân nhắc khai dependsOn`);
        for (const h of serialHotspotClash(a.owns, b.owns, cfg))
          warnings.push(`${a.id} ↔ ${b.id}: cùng giữ điểm nóng SERIAL ${h.path} (${h.reason}) — chỉ một việc chạy tại một thời điểm`);
      }
  }
  if (errors.length) return { mission: null, errors, warnings };
  return {
    mission: {
      schema: 1,
      id: raw.id as string,
      title: raw.title as string,
      goal: raw.goal as string,
      integrationRef: isStr(raw.integrationRef) ? raw.integrationRef : undefined,
      maxWorkers: typeof raw.maxWorkers === "number" ? raw.maxWorkers : undefined,
      tasks,
    },
    errors,
    warnings,
  };
}

/* ═════════════ 4 · SUY TRẠNG THÁI TỪ SỰ THẬT GIT (HÀM THUẦN) ═════════════ */

export type TaskFacts = {
  /** Nhánh còn ở máy này. */
  localBranch: boolean;
  /** Nhánh có trên remote. */
  remoteBranch: boolean;
  /** Đầu nhánh (cục bộ, hoặc remote nếu cục bộ đã xoá). */
  tip: string | null;
  /** Remote đứng đúng ở đầu nhánh cục bộ. */
  pushed: boolean;
  worktreeExists: boolean;
  /** Số dòng `git status --porcelain`; -1 = không đọc được. */
  dirty: number;
  /** Số commit của việc kể từ gốc (`baseSha..tip`). */
  commits: number;
  /** Số commit nhánh tích hợp có mà nhánh việc chưa có. */
  behind: number;
  merged: MergeEvidence | null;
};

export const NO_FACTS: TaskFacts = {
  localBranch: false,
  remoteBranch: false,
  tip: null,
  pushed: false,
  worktreeExists: false,
  dirty: 0,
  commits: 0,
  behind: 0,
  merged: null,
};

export type DerivedTask = { task: Task; status: TaskStatus; why: string; facts: TaskFacts };

/**
 * Trạng thái của MỘT việc, chỉ từ khai báo + sự thật git + trạng thái phụ thuộc. Hàm thuần: gọi
 * hai lần ra một kết quả, kiểm thử được từng ô mà không cần kho git nào.
 */
export function deriveTaskStatus(task: Task, facts: TaskFacts, depStatus: ReadonlyMap<string, TaskStatus>): { status: TaskStatus; why: string } {
  const d = task.decision;
  if (d?.state === "CANCELLED") return { status: "CANCELLED", why: d.reason };
  if (d?.state === "DONE") return { status: "DONE", why: d.evidence };
  if (facts.merged && facts.merged !== "EMPTY") {
    if (task.deploy) return { status: "DEPLOYED", why: `${task.deploy.sha.slice(0, 7)} · ${task.deploy.evidence}` };
    const left = facts.dirty > 0 ? ` · cây còn ${facts.dirty} thay đổi chưa commit` : facts.localBranch && facts.remoteBranch && !facts.pushed ? " · nhánh cục bộ có commit mới hơn remote" : "";
    return { status: "MERGED", why: `bằng chứng ${facts.merged}${left}` };
  }
  if (d?.state === "BLOCKED") return { status: "BLOCKED", why: `[${d.category}] ${d.reason}` };
  if (d?.state === "DEFERRED") return { status: "DEFERRED", why: d.reason };
  if (task.run) {
    if (facts.worktreeExists) {
      if (facts.dirty !== 0 || facts.commits === 0 || !facts.pushed) {
        const bits = [
          facts.dirty > 0 ? `bẩn ${facts.dirty}` : facts.dirty < 0 ? "không đọc được trạng thái" : null,
          `${facts.commits} commit`,
          facts.commits > 0 && !facts.pushed ? "chưa đẩy" : null,
        ].filter(Boolean);
        return { status: "RUNNING", why: bits.join(" · ") };
      }
      return { status: "REVIEW", why: `đã đẩy ${facts.commits} commit${facts.behind ? ` · sau nhánh tích hợp ${facts.behind}` : ""}` };
    }
    if (facts.remoteBranch && facts.commits > 0 && (facts.pushed || !facts.localBranch))
      return { status: "REVIEW", why: `cây đã gỡ, nhánh còn trên remote (${facts.commits} commit)` };
    if (facts.localBranch && facts.remoteBranch && facts.commits > 0)
      return { status: "ORPHANED", why: "cây đã mất, nhánh cục bộ có commit CHƯA lên remote — đẩy nhánh trước khi làm gì khác" };
    if (facts.localBranch && facts.commits > 0)
      return { status: "ORPHANED", why: "cây đã mất, nhánh CHỈ còn ở máy này và chưa lên remote — đẩy nhánh hoặc dựng lại cây" };
    return { status: "ORPHANED", why: "tệp khai có lượt chạy nhưng git không còn cây lẫn nhánh — đối chiếu rồi xoá `run` hoặc dựng lại" };
  }
  const waiting = task.dependsOn.filter((id) => {
    const s = depStatus.get(id);
    if (s && SATISFIED.has(s)) return false;
    // Dựng chồng lên nhánh phụ thuộc: phụ thuộc đã đẩy (REVIEW) là đủ để bắt đầu.
    return !(task.base === id && s === "REVIEW");
  });
  if (waiting.length) return { status: "BACKLOG", why: `chờ ${waiting.map((id) => `${id}(${depStatus.get(id) ?? "?"})`).join(", ")}` };
  return { status: "READY", why: task.mode === "INLINE" ? "Lead làm trực tiếp" : "đủ điều kiện dựng cây" };
}

/** Thứ tự tô-pô (phụ thuộc đứng trước). Gọi sau khi đã kiểm không có chu trình. */
export function topoOrder(tasks: readonly Task[]): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const out: Task[] = [];
  const visit = (t: Task) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    for (const d of t.dependsOn) {
      const dt = byId.get(d);
      if (dt) visit(dt);
    }
    out.push(t);
  };
  for (const t of tasks) visit(t);
  return out;
}

export function deriveMission(m: Mission, factsOf: (t: Task) => TaskFacts): DerivedTask[] {
  const status = new Map<string, TaskStatus>();
  const out = new Map<string, DerivedTask>();
  for (const t of topoOrder(m.tasks)) {
    const facts = factsOf(t);
    const r = deriveTaskStatus(t, facts, status);
    status.set(t.id, r.status);
    out.set(t.id, { task: t, status: r.status, why: r.why, facts });
  }
  return m.tasks.map((t) => out.get(t.id) as DerivedTask);
}

/* ═════════════ 5 · XẾP LỊCH: BAO NHIÊU CÂY, VIỆC NÀO TRƯỚC (HÀM THUẦN) ═════════════ */

export type Plan = {
  capacity: number;
  launch: { id: string; note: string }[];
  inline: { id: string; note: string }[];
  hold: { id: string; reason: string }[];
};

/** Số việc phía sau (bắc cầu) — việc mở khoá nhiều việc khác là đường găng, đi trước. */
function dependentsCount(tasks: readonly Task[]): Map<string, number> {
  const anc = ancestorsOf(tasks);
  const n = new Map<string, number>(tasks.map((t) => [t.id, 0]));
  for (const t of tasks) for (const a of anc.get(t.id) ?? []) n.set(a, (n.get(a) ?? 0) + 1);
  return n;
}

/**
 * Chọn lượt việc kế tiếp. KHÔNG cố lấp đầy trần: một việc chồng phạm vi với việc đang chạy thì
 * NẰM LẠI kèm lý do, kể cả khi còn chỗ — bốn cây giẫm lên nhau tệ hơn hai cây độc lập.
 *
 * @param globalRunning số cây WORKER đang chạy trên CẢ máy (mọi sứ mệnh), đọc từ phiếu giao việc.
 */
export function planNext(derived: readonly DerivedTask[], mission: Mission, cfg: Config, globalRunning: number): Plan {
  const cap = Math.min(mission.maxWorkers ?? cfg.maxImplementationWorkers, cfg.maxImplementationWorkers);
  const active = derived.filter((d) => d.status === "RUNNING" || d.status === "REVIEW");
  const runningHere = derived.filter((d) => d.status === "RUNNING" && d.task.mode === "WORKER").length;
  const othersOnMachine = Math.max(0, globalRunning - runningHere);
  let capacity = Math.max(0, Math.min(cap - runningHere, cfg.maxImplementationWorkers - runningHere - othersOnMachine));
  const plan: Plan = { capacity, launch: [], inline: [], hold: [] };
  const criticalActive = active.find((d) => d.task.risk === "CRITICAL");

  const deps = dependentsCount(mission.tasks);
  const ready = derived
    .filter((d) => d.status === "READY")
    .sort(
      (a, b) =>
        PRIORITIES.indexOf(a.task.priority) - PRIORITIES.indexOf(b.task.priority) ||
        (deps.get(b.task.id) ?? 0) - (deps.get(a.task.id) ?? 0) ||
        a.task.id.localeCompare(b.task.id),
    );
  const taken: Task[] = active.map((d) => d.task);
  for (const d of ready) {
    const t = d.task;
    const clashWith = taken
      .map((o) => ({ o, s: scopeConflicts(t.owns, o.owns, cfg), h: serialHotspotClash(t.owns, o.owns, cfg) }))
      .find((x) => x.s.length || x.h.length);
    if (clashWith) {
      const why = clashWith.s.length ? `chồng phạm vi với ${clashWith.o.id}: ${clashWith.s.join(", ")}` : `cùng điểm nóng SERIAL ${clashWith.h[0].path} với ${clashWith.o.id}`;
      plan.hold.push({ id: t.id, reason: `${why} — chờ việc kia vào nhánh tích hợp` });
      continue;
    }
    if (t.mode === "INLINE") {
      plan.inline.push({ id: t.id, note: `${t.priority} ${t.risk} — Lead làm trong cây của mình, tuần tự` });
      taken.push(t);
      continue;
    }
    if (criticalActive) {
      plan.hold.push({ id: t.id, reason: `${criticalActive.task.id} (CRITICAL) đang chạy — việc CRITICAL chạy một mình` });
      continue;
    }
    if (t.risk === "CRITICAL" && (active.some((a) => a.task.mode === "WORKER") || plan.launch.length)) {
      plan.hold.push({ id: t.id, reason: "CRITICAL chỉ khởi động khi không còn cây nào đang mở" });
      continue;
    }
    if (capacity <= 0) {
      plan.hold.push({ id: t.id, reason: `đã đủ trần (${cap} cho sứ mệnh, ${cfg.maxImplementationWorkers} cho cả máy; máy đang chạy ${globalRunning})` });
      continue;
    }
    const notes = [`${t.priority} ${t.risk}`];
    if (riskRank(t.risk) >= riskRank("HIGH")) notes.push("cần lượt REVIEW riêng trước PR");
    if ((deps.get(t.id) ?? 0) > 0) notes.push(`mở khoá ${deps.get(t.id)} việc`);
    plan.launch.push({ id: t.id, note: notes.join(" · ") });
    taken.push(t);
    capacity--;
    if (t.risk === "CRITICAL") capacity = 0;
  }
  return plan;
}

/* ═════════════ 6 · CÂY LÀM VIỆC: PHÂN LOẠI VÀ QUYẾT ĐỊNH DỌN (HÀM THUẦN) ═════════════ */

export type WorktreeFacts = {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  isMain: boolean;
  isCurrent: boolean;
  owner: { mission: string; task: string } | null;
  /** Vai trong phiếu: LEAD = cây Lead của một sứ mệnh — không bao giờ là rác chỉ vì nó sạch. */
  role?: "LEAD" | "WORKER";
  dirty: number;
  /** Commit không nằm trên BẤT KỲ ref remote nào — thứ duy nhất sẽ mất nếu xoá nhánh. -1 = không đo được. */
  uniqueLocal: number;
  merged: MergeEvidence | null;
  idleHours: number | null;
  /**
   * Tệp `.env*` bị git BỎ QUA nằm trong cây — `git worktree remove` không `--force` vẫn xoá chúng
   * (đo bởi reviewer 05/10/2026). Đó thường là bí mật chỉ có ở máy này, không có bản nào khác.
   */
  localSecrets: string[];
};

/** Bằng chứng mà việc của nhánh thật sự đã vào (EMPTY = không có việc gì riêng để vào). */
const isRealMerge = (m: MergeEvidence | null): boolean => m !== null && m !== "EMPTY";

export function classifyWorktree(f: WorktreeFacts, cfg: Config): { cls: WorktreeClass; note: string } {
  if (f.isMain) return { cls: "MAIN", note: "cây chính — không bao giờ dọn" };
  if (f.isCurrent) return { cls: "CURRENT", note: "cây đang chạy lệnh" };
  if (f.role === "LEAD" && !f.prunable && f.head !== null && f.idleHours !== null) {
    // Cây Lead sống suốt sứ mệnh và thường sạch giữa hai lượt — "sạch + không commit riêng" không có
    // nghĩa là bỏ đi. Chỉ báo, không bao giờ xếp vào MERGED_SAFE_TO_CLEAN (reviewer 06/10/2026).
    const idleLead = `${Math.round(f.idleHours)} giờ không động`;
    return f.idleHours >= cfg.staleAfterDays * 24
      ? { cls: f.dirty > 0 ? "STALE_DIRTY" : "STALE_CLEAN", note: `cây LEAD · ${idleLead}` }
      : { cls: f.idleHours < cfg.activeWithinHours || f.dirty > 0 ? "ACTIVE" : "IDLE", note: `cây LEAD · ${idleLead}` };
  }
  if (f.prunable) return { cls: "UNKNOWN", note: "thư mục không còn — `git worktree prune` gỡ được siêu dữ liệu" };
  if (f.head === null || f.dirty < 0 || f.idleHours === null) return { cls: "UNKNOWN", note: "không đọc được trạng thái" };
  const stale = f.idleHours >= cfg.staleAfterDays * 24;
  const idle = `${Math.round(f.idleHours)} giờ không động`;
  if (f.dirty > 0) return stale ? { cls: "STALE_DIRTY", note: `${f.dirty} thay đổi chưa commit · ${idle} — CHỈ BÁO, không dọn` } : { cls: "ACTIVE", note: `${f.dirty} thay đổi chưa commit` };
  if (f.idleHours < cfg.activeWithinHours) return { cls: "ACTIVE", note: `${idle}${isRealMerge(f.merged) ? ` · đã vào (${f.merged})` : ""}` };
  const secrets = f.localSecrets.length ? ` · có ${f.localSecrets.join(", ")} chỉ ở máy này` : "";
  if (isRealMerge(f.merged) && (f.uniqueLocal === 0 || f.merged === "ANCESTOR"))
    return { cls: "MERGED_SAFE_TO_CLEAN", note: `đã vào (${f.merged}) · sạch · không commit nào chỉ ở máy này · ${idle}${secrets}` };
  if (f.merged === "EMPTY") return { cls: "MERGED_SAFE_TO_CLEAN", note: `không có commit riêng nào · sạch · ${idle}${secrets}` };
  const unpushed = f.uniqueLocal > 0 ? ` · ${f.uniqueLocal} commit CHƯA lên remote` : "";
  if (stale) return { cls: "STALE_CLEAN", note: `${idle}${unpushed}` };
  return { cls: "IDLE", note: `${idle}${unpushed}` };
}

export type CleanupDecision = { ok: boolean; refusals: string[]; deleteBranch: boolean };

/**
 * Được dọn KHÔNG. Mỗi lý do từ chối là một cách mất việc đã thấy hoặc tưởng tượng được; không có
 * cờ nào bỏ qua được vế "bẩn" hay "commit chưa lên remote".
 */
export function cleanupDecision(f: WorktreeFacts, cfg: Config, opts: { allowUnowned: boolean; allowLead?: boolean }): CleanupDecision {
  const r: string[] = [];
  if (f.isMain) r.push("MAIN: cây chính của kho");
  if (f.isCurrent) r.push("CURRENT: không tự dọn cây đang đứng");
  if (f.role === "LEAD" && !opts.allowLead)
    r.push("LEAD: cây Lead của một sứ mệnh — chỉ dọn khi nêu ĐÍCH tường minh kèm --lead, sau khi mọi việc của sứ mệnh đã vào");
  if (f.locked) r.push("LOCKED: cây đang bị khoá (`git worktree lock`) — chủ của nó chưa cho gỡ");
  if (f.prunable) r.push("PRUNABLE: thư mục đã mất — dùng `git worktree prune`, không phải cleanup");
  if (f.dirty !== 0) r.push(f.dirty < 0 ? "UNKNOWN: không đọc được trạng thái" : `DIRTY: ${f.dirty} thay đổi chưa commit`);
  if (f.merged === null) r.push("NOT_MERGED: không có bằng chứng đã vào nhánh tích hợp");
  if (f.uniqueLocal !== 0 && f.merged !== "ANCESTOR")
    r.push(f.uniqueLocal < 0 ? "UNPUSHED?: không đo được commit chưa lên remote" : `UNPUSHED: ${f.uniqueLocal} commit chỉ có ở máy này`);
  if (f.localSecrets.length) r.push(`LOCAL_SECRETS: ${f.localSecrets.join(", ")} bị git bỏ qua và sẽ mất cùng cây — chuyển đi trước`);
  /*
    MỌI lượt dọn đều chờ một khoảng sau lần cuối có người động vào cây. Bằng chứng merge nói về
    COMMIT, không nói ai còn đang đứng trong cây: `worktree remove` xoá cả `node_modules` và tệp
    bị bỏ qua dưới chân một phiên đang chạy.
  */
  const idleMin = f.idleHours === null ? null : f.idleHours * 60;
  const recentGrace = idleMin === null || idleMin < cfg.cleanupGraceMinutes;
  const recentDay = f.idleHours === null || f.idleHours < cfg.activeWithinHours;
  if (recentGrace) r.push(`RECENT: cây vừa được động trong ${cfg.cleanupGraceMinutes} phút qua — đợi phiên đang giữ nó dừng`);
  else if (f.merged === "EMPTY" && recentDay) r.push("EMPTY_BUT_RECENT: chưa có commit riêng nào nhưng vừa được dùng — có thể worker mới bắt đầu");
  if (!f.owner) {
    if (!opts.allowUnowned) r.push("UNOWNED: cây không có phiếu giao việc của AI Tech Room — không biết ai đang giữ (thêm --allow-unowned nếu chủ shop cho phép)");
    else if (recentDay) r.push("UNOWNED_RECENT: cây không rõ chủ và vừa được dùng trong " + cfg.activeWithinHours + " giờ qua");
  }
  return { ok: r.length === 0, refusals: r, deleteBranch: r.length === 0 && f.branch !== null };
}

/* ═════════════ 7 · ĐỐI CHIẾU KHI NHÁNH TÍCH HỢP CHẠY TIẾP (HÀM THUẦN) ═════════════ */

export const RECONCILE_VERDICTS = ["UP_TO_DATE", "NO_EFFECT", "AFFECTS_READ_ONLY", "SHARED_CONTRACT", "REQUIRES_REFRESH", "CONFLICTS"] as const;
export type ReconcileVerdict = (typeof RECONCILE_VERDICTS)[number];

export type ReconcileInput = {
  behind: number;
  upstreamFiles: readonly string[];
  branchFiles: readonly string[];
  /** Tệp xung đột thật theo `git merge-tree`; null = không chạy được phép thử. */
  conflictFiles: readonly string[] | null;
  task: Pick<Task, "owns" | "readOnly">;
};

const isMigration = (f: string) => /^drizzle\/\d{4}_[^/]+\.sql$/.test(f);

export function reconcileVerdict(x: ReconcileInput, cfg: Config): { verdict: ReconcileVerdict; action: string; details: string[] } {
  if (x.behind === 0) return { verdict: "UP_TO_DATE", action: "không cần làm gì", details: [] };
  const hit = (pats: readonly string[]) => x.upstreamFiles.filter((f) => pats.some((p) => fileInPattern(f, p)));
  const details: string[] = [];
  const upMig = x.upstreamFiles.filter(isMigration);
  const myMig = x.branchFiles.filter(isMigration);
  if (x.conflictFiles && x.conflictFiles.length) {
    return { verdict: "CONFLICTS", action: "cập nhật NGAY trong cây của việc (merge nhánh tích hợp, giải xung đột có chủ đích, chạy lại kiểm thử)", details: x.conflictFiles.map((f) => `xung đột: ${f}`) };
  }
  if (upMig.length && myMig.length) {
    return {
      verdict: "CONFLICTS",
      action: "đánh số lại migration của việc: `npm run migration:renumber -- --apply` trong cây của việc, rồi chạy lại kiểm thử",
      details: [`nhánh tích hợp thêm ${upMig.join(", ")}`, `việc thêm ${myMig.join(", ")}`],
    };
  }
  const touchedMine = x.upstreamFiles.filter((f) => x.branchFiles.includes(f) || x.task.owns.some((p) => fileInPattern(f, p)));
  if (touchedMine.length)
    return { verdict: "REQUIRES_REFRESH", action: "cập nhật trước khi làm tiếp — nhánh tích hợp sửa đúng vùng việc đang sở hữu", details: touchedMine.slice(0, 20) };
  const contracts = x.upstreamFiles.filter((f) => cfg.hotspots.some((h) => fileInPattern(f, h.path)));
  if (contracts.length)
    return { verdict: "SHARED_CONTRACT", action: "đọc thay đổi hợp đồng chung, cập nhật trước PR, chạy lại kiểm thử", details: contracts.slice(0, 20) };
  const ro = hit(x.task.readOnly);
  if (ro.length) return { verdict: "AFFECTS_READ_ONLY", action: "cập nhật trước PR và chạy lại kiểm thử", details: ro.slice(0, 20) };
  details.push(`${x.behind} commit, không chạm phạm vi`);
  return { verdict: "NO_EFFECT", action: "không cần làm gì bây giờ — cập nhật một lần lúc mở PR (ruleset strict đòi vậy)", details };
}

/* ═════════════ 8 · ĐỌC GIT (KHÔNG SHELL) ═════════════ */

export type GitResult = { code: number; out: string; err: string };

export function gitRun(cwd: string, args: readonly string[]): GitResult {
  const r = spawnSync("git", ["-c", "core.quotepath=off", ...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (r.error) throw new Error(`không chạy được git (${r.error.message}) — git có trên PATH không?`);
  return { code: r.status ?? 1, out: (r.stdout ?? "").replace(/\s+$/, ""), err: (r.stderr ?? "").trim() };
}

export function git(cwd: string, args: readonly string[]): string {
  const r = gitRun(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} → ${r.err || `mã ${r.code}`}`);
  return r.out;
}

const gitTry = (cwd: string, args: readonly string[]): string | null => {
  const r = gitRun(cwd, args);
  return r.code === 0 ? r.out : null;
};

/** So hai đường dẫn bất kể dấu phân cách và (trên ổ đĩa Windows) chữ hoa / thường. */
export function samePath(a: string, b: string): boolean {
  const n = (p: string) => {
    let s = path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
    if (/^[a-zA-Z]:\//.test(s)) s = s.toLowerCase();
    return s;
  };
  return n(a) === n(b);
}

export type WorktreeEntry = { path: string; head: string | null; branch: string | null; detached: boolean; locked: boolean; prunable: boolean; bare: boolean };

export function listWorktrees(cwd: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const line of git(cwd, ["worktree", "list", "--porcelain"]).split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice(9), head: null, branch: null, detached: false, locked: false, prunable: false, bare: false };
      out.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "detached") cur.detached = true;
    else if (line === "bare") cur.bare = true;
    else if (line === "locked" || line.startsWith("locked ")) cur.locked = true;
    else if (line === "prunable" || line.startsWith("prunable ")) cur.prunable = true;
  }
  return out;
}

/** Thư mục quản trị git của một cây — đọc tệp `.git`, không gọi tiến trình. */
export function adminDirOf(worktree: string): string | null {
  const dotgit = path.join(worktree, ".git");
  try {
    const st = statSync(dotgit);
    if (st.isDirectory()) return dotgit;
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit, "utf8"));
    return m ? path.resolve(worktree, m[1].trim()) : null;
  } catch {
    return null;
  }
}

export function readManifest(worktree: string): Manifest | null {
  const dir = adminDirOf(worktree);
  if (!dir) return null;
  try {
    const m = JSON.parse(readFileSync(path.join(dir, MANIFEST_FILE), "utf8")) as Manifest;
    // Phiếu là đầu vào của lời gọi git ⇒ kiểm như đầu vào lạ: ref và SHA phải đúng dạng.
    const ok =
      isObj(m) && m.schema === 1 && isObj(m.mission) && isObj(m.task) && SLUG_RE.test(String(m.mission.id)) && SLUG_RE.test(String(m.task.id)) &&
      REF_RE.test(String(m.integrationRef)) && SHA_RE.test(String(m.baseSha));
    return ok ? m : null;
  } catch {
    return null;
  }
}

function writeManifest(worktree: string, m: Manifest): string {
  const dir = adminDirOf(worktree);
  if (!dir) throw new Error(`không tìm được thư mục quản trị git của ${worktree}`);
  const file = path.join(dir, MANIFEST_FILE);
  writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
  writeFileSync(path.join(dir, "ai-tech-brief.md"), m.role === "LEAD" ? renderLeadBrief(m) : renderBrief(m));
  return file;
}

export function dirtyCount(worktree: string): { n: number; files: string[] } {
  const r = gitRun(worktree, ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all"]);
  if (r.code !== 0) return { n: -1, files: [] };
  const lines = r.out.split(/\r?\n/).filter(Boolean);
  return { n: lines.length, files: lines.map((l) => l.slice(3).replace(/^.* -> /, "").replace(/^"|"$/g, "")) };
}

/**
 * Lần cuối CÓ NGƯỜI LÀM gì trong cây: reflog HEAD (commit · checkout · reset) và mtime của chính
 * các tệp đang bẩn. KHÔNG đọc `index`: đo 05/10/2026 trên 159 cây, 50+ cây "vừa động 2 giờ trước"
 * cùng lúc — tiện ích git của trình soạn thảo chạy `git status` khắp nơi và làm mới index. Một
 * tín hiệu mà công cụ khác chạm vào được là tín hiệu không nói gì về con người.
 */
function idleHoursOf(worktree: string, dirtyFiles: readonly string[], now: number): number | null {
  const admin = adminDirOf(worktree);
  if (!admin) return null;
  const candidates = [path.join(admin, "logs", "HEAD"), ...dirtyFiles.slice(0, 50).map((f) => path.join(worktree, f))];
  let latest = 0;
  for (const c of candidates) {
    try {
      latest = Math.max(latest, statSync(c).mtimeMs);
    } catch {
      /* tệp không có — bỏ qua */
    }
  }
  return latest ? Math.max(0, (now - latest) / 3_600_000) : null;
}

const countRange = (cwd: string, range: string[]): number => {
  const v = gitTry(cwd, ["rev-list", "--count", ...range]);
  return v === null ? -1 : Number(v);
};

const lines = (v: string | null): string[] => (v ?? "").split(/\r?\n/).filter(Boolean);

/**
 * Commit RIÊNG của việc: commit trên chuỗi first-parent của nhánh (từ gốc tới đầu) mà KHÔNG nằm
 * trên chuỗi first-parent của nhánh tích hợp.
 *
 * Vì sao không phải `gốc..đầu`: worker chưa commit gì mà `git merge origin/main` (fast-forward)
 * thì `gốc..đầu` toàn là commit của main, và đầu nhánh thành tổ tiên của main — trước bản sửa này
 * việc đó bị coi là ĐÃ VÀO và cây bị dọn dưới chân phiên đang chạy (reviewer tái hiện 05/10/2026).
 * Ngược lại, khi nhánh vào bằng merge commit, commit của nó nằm ở nhánh cha THỨ HAI của main nên
 * không thuộc chuỗi first-parent của main. Hệ quả có chủ đích: tích hợp bằng fast-forward bị coi
 * là "không có việc riêng" — kho này merge qua PR (squash / merge commit), và Lead tích hợp cục
 * bộ phải dùng `--no-ff`.
 */
export function ownCommits(cwd: string, tip: string, ref: string, baseSha?: string): string[] | null {
  const base = baseSha ?? gitTry(cwd, ["merge-base", tip, ref]);
  if (!base) return null;
  const mine = gitTry(cwd, ["rev-list", "--first-parent", `${base}..${tip}`]);
  if (mine === null) return null;
  const mainline = new Set(lines(gitTry(cwd, ["rev-list", "--first-parent", `${base}..${ref}`])));
  return lines(mine).filter((c) => !mainline.has(c));
}

/**
 * Bằng chứng đã vào `ref`. Thứ tự từ mạnh tới yếu; trả `null` khi không chứng minh được — và
 * `null` nghĩa là KHÔNG DỌN, kể cả khi thực ra đã vào. Báo thiếu ở đây an toàn, báo thừa thì không.
 */
export function mergeEvidence(cwd: string, tip: string | null, ref: string, opts: { baseSha?: string; pr?: number } = {}): MergeEvidence | null {
  if (!tip || !REF_RE.test(ref)) return null;
  const own = ownCommits(cwd, tip, ref, opts.baseSha);
  if (own === null) return null;
  if (own.length === 0) return "EMPTY";
  if (gitRun(cwd, ["merge-base", "--is-ancestor", tip, ref]).code === 0) return "ANCESTOR";
  if (opts.pr) {
    const hit = gitTry(cwd, ["log", "-n", "2000", "--format=%s", "--fixed-strings", `--grep=(#${opts.pr})`, ref]);
    if (hit && lines(hit).some((s) => s.trimEnd().endsWith(`(#${opts.pr})`))) return "PR_SUBJECT";
  }
  const mb = gitTry(cwd, ["merge-base", tip, ref]);
  if (!mb) return null;
  const mine = lines(gitTry(cwd, ["diff", "--name-only", "--no-renames", mb, tip]));
  if (mine.length === 0) return null;
  // Không truyền danh sách tệp làm pathspec: vài trăm đường dẫn dài vượt trần 32K ký tự dòng lệnh Windows.
  const differ = gitTry(cwd, ["diff", "--name-only", "--no-renames", tip, ref]);
  if (differ === null) return null;
  const d = new Set(lines(differ));
  return mine.every((f) => !d.has(f)) ? "CONTENT" : null;
}

/** Tệp `.env*` bị git bỏ qua trong cây (sẽ mất cùng cây — không có bản nào khác). */
export function localSecretsOf(worktree: string): string[] {
  const r = gitRun(worktree, ["--no-optional-locks", "status", "--porcelain", "--ignored", "--untracked-files=normal"]);
  if (r.code !== 0) return [];
  return lines(r.out)
    .filter((l) => l.startsWith("!! "))
    .map((l) => l.slice(3).replace(/^"|"$/g, ""))
    .filter((f) => /(^|\/)\.env[^/]*$/.test(f));
}

/* ═════════════ 9 · NGỮ CẢNH KHO ═════════════ */

export type RepoCtx = { cwd: string; top: string; mainWorktree: string; worktreeParent: string; config: Config; configErrors: string[]; /** Nhãn phiên tiêm từ ngoài (bài kiểm) — thắng AI_LEAD_ID và máy:cây. */ actor?: string };

export function openRepo(cwd: string): RepoCtx {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  const wts = listWorktrees(top);
  const main = wts.find((w) => !w.bare) ?? wts[0];
  if (!main) throw new Error("không đọc được danh sách worktree");
  const cfgFile = path.join(top, ".ai", "config.json");
  let raw: unknown = undefined;
  const pre: string[] = [];
  if (existsSync(cfgFile)) {
    try {
      raw = JSON.parse(readFileSync(cfgFile, "utf8"));
    } catch (e) {
      pre.push(`.ai/config.json: JSON hỏng (${(e as Error).message})`);
    }
  }
  const { config, errors } = parseConfig(raw);
  return { cwd, top, mainWorktree: main.path, worktreeParent: path.dirname(main.path), config, configErrors: [...pre, ...errors] };
}

export function missionsDir(ctx: RepoCtx): string {
  return path.join(ctx.top, ".ai", "missions");
}

export function loadMission(ctx: RepoCtx, id: string): { file: string; v: Validation; raw: Record<string, unknown> } {
  if (!SLUG_RE.test(id)) throw new Error(`tên sứ mệnh "${id}" không hợp lệ`);
  const file = path.join(missionsDir(ctx), `${id}.json`);
  if (!existsSync(file)) throw new Error(`không có ${path.join(".ai", "missions", `${id}.json`)} trong cây này`);
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  return { file, v: validateMission(raw, ctx.config), raw };
}

export function listMissionIds(ctx: RepoCtx): string[] {
  const dir = missionsDir(ctx);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .filter((id) => SLUG_RE.test(id))
    .sort();
}

const integrationRefOf = (ctx: RepoCtx, m: Mission) => m.integrationRef ?? ctx.config.integrationRef;
export const branchFor = (cfg: Config, t: Task) => `${cfg.branchPrefix}${t.slug ?? t.id}`;
export const worktreeFor = (ctx: RepoCtx, t: Task) => path.join(ctx.worktreeParent, `${ctx.config.worktreePrefix}${t.slug ?? t.id}`);

export function gatherTaskFacts(ctx: RepoCtx, m: Mission, t: Task, wts: readonly WorktreeEntry[]): TaskFacts {
  if (!t.run) return { ...NO_FACTS };
  const ref = integrationRefOf(ctx, m);
  const b = t.run.branch;
  const local = gitTry(ctx.top, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]);
  const remote = gitTry(ctx.top, ["rev-parse", "--verify", "--quiet", `refs/remotes/${ctx.config.remote}/${b}`]);
  const tip = local ?? remote;
  if (!tip && t.run.cleanedAt && t.run.mergedEvidence)
    return { ...NO_FACTS, tip: t.run.mergedTip ?? null, merged: t.run.mergedEvidence, commits: 1 };
  // Cây của việc = ĐÚNG đường dẫn VÀ ĐÚNG nhánh. Một phiên khác dựng lại `wt-<slug>` cho việc của
  // họ sau khi cây cũ đã dọn thì đó KHÔNG phải cây của việc này — và không được nhận phiếu của nó.
  const wt = wts.find((w) => samePath(w.path, t.run?.worktree ?? "") && w.branch === b && !w.prunable);
  const dirty = wt ? dirtyCount(wt.path).n : 0;
  // Commit RIÊNG, không phải baseSha..tip: commit của main mà worker merge vào không phải việc của nó.
  const commits = tip ? (ownCommits(ctx.top, tip, ref, t.run.baseSha)?.length ?? 0) : 0;
  const behind = tip && gitTry(ctx.top, ["rev-parse", "--verify", "--quiet", ref]) ? countRange(ctx.top, [`${tip}..${ref}`]) : 0;
  return {
    localBranch: local !== null,
    remoteBranch: remote !== null,
    tip,
    pushed: local !== null && remote === local,
    worktreeExists: Boolean(wt),
    dirty,
    commits: Math.max(0, commits),
    behind: Math.max(0, behind),
    merged: mergeEvidence(ctx.top, tip, ref, { baseSha: t.run.baseSha, pr: t.pr }),
  };
}

export function gatherWorktreeFacts(ctx: RepoCtx, e: WorktreeEntry, now: number): WorktreeFacts {
  const manifest = e.prunable ? null : readManifest(e.path);
  const d = e.prunable ? { n: -1, files: [] } : dirtyCount(e.path);
  const tip = e.head;
  const uniqueLocal = tip ? countRange(ctx.top, [tip, "--not", "--remotes"]) : -1;
  const ref = manifest?.integrationRef ?? ctx.config.integrationRef;
  return {
    path: e.path,
    head: tip,
    branch: e.branch,
    detached: e.detached,
    locked: e.locked,
    prunable: e.prunable,
    isMain: samePath(e.path, ctx.mainWorktree),
    isCurrent: samePath(e.path, ctx.top),
    owner: manifest ? { mission: manifest.mission.id, task: manifest.task.id } : null,
    role: manifest ? (manifest.role ?? "WORKER") : undefined,
    dirty: d.n,
    uniqueLocal,
    merged: e.prunable ? null : mergeEvidence(ctx.top, tip, ref, { baseSha: manifest?.baseSha }),
    idleHours: e.prunable ? null : idleHoursOf(e.path, d.files, now),
    localSecrets: e.prunable ? [] : localSecretsOf(e.path),
  };
}

/** Số cây WORKER đang chạy trên cả máy — chỉ đếm cây có phiếu (cây lạ không rõ là việc hay rác). */
export function globalRunningWorkers(ctx: RepoCtx, wts: readonly WorktreeEntry[]): { n: number; who: string[] } {
  const who: string[] = [];
  for (const w of wts) {
    if (w.prunable || w.bare) continue;
    const m = readManifest(w.path);
    if (!m || !w.head || m.role === "LEAD") continue;
    const merged = mergeEvidence(ctx.top, w.head, m.integrationRef, { baseSha: m.baseSha });
    if (merged && merged !== "EMPTY") continue;
    const d = dirtyCount(w.path).n;
    const remote = w.branch ? gitTry(ctx.top, ["rev-parse", "--verify", "--quiet", `refs/remotes/${ctx.config.remote}/${w.branch}`]) : null;
    if (d !== 0 || merged === "EMPTY" || remote !== w.head) who.push(`${m.mission.id}/${m.task.id}`);
  }
  return { n: who.length, who };
}

/* ═════════════ 10 · PHIẾU GIAO VIỆC ═════════════ */

export function renderBrief(m: Manifest): string {
  const t = m.task;
  const list = (xs: readonly string[] | undefined, empty = "(không)") => (xs && xs.length ? xs.map((x) => `- \`${x}\``).join("\n") : empty);
  const plain = (xs: readonly string[] | undefined) => (xs && xs.length ? xs.map((x) => `- ${x}`).join("\n") : "(không)");
  return `# PHIẾU GIAO VIỆC — ${m.mission.id} / ${t.id}

**${t.title}** · ${t.priority} · rủi ro ${t.risk}

Sứ mệnh: ${m.mission.title} — ${m.mission.goal}

## Mục tiêu
${t.objective}

## Nơi làm việc
- Cây: \`${m.worktree}\`
- Nhánh: \`${m.branch}\` (dựng từ \`${m.baseRef}\` @ \`${m.baseSha.slice(0, 12)}\`)
- Nhánh tích hợp: \`${m.integrationRef}\`

## Phạm vi ĐƯỢC GHI
${list(t.owns)}

## Chỉ ĐỌC (phụ thuộc)
${list(t.readOnly)}

## KHÔNG ĐƯỢC CHẠM
${list(t.doNotTouch)}
- \`.ai/\` (trạng thái điều phối — của Lead)
- mọi worktree khác ngoài cây trên

## Kiểm thử bắt buộc
${list(t.tests)}

## Định nghĩa XONG
${plain(t.definitionOfDone)}

## Đầu ra mong đợi
${t.expectedOutput ?? "(như định nghĩa xong)"}

## Ghi chú tích hợp
${t.integrationNotes ?? "(không)"}

## Luật của worker (docs/ai-tech-room/README.md mục 4)
1. Chỉ làm trong cây trên. Đọc \`AGENTS.md\` trước; luật nghiệp vụ ở đó thắng phiếu này.
2. Chỉ sửa tệp trong phạm vi ĐƯỢC GHI. Cần sửa ngoài phạm vi (nhất là hợp đồng chung, \`db/schema.ts\`, \`drizzle/\`) ⇒ DỪNG, báo Lead "YÊU CẦU ĐỔI PHẠM VI: <tệp> — <vì sao>"; không tự sửa.
3. Lần đầu vào cây: \`npm ci\`. Chạy kiểm thử của phiếu + \`npm run typecheck\` + \`npm run lint\` trước khi báo xong.
4. Commit tiếng Việt có dấu, chỉ tệp của việc này (\`git add <tệp>\`, không \`git add -A\`). Không ghi tên model AI — kể cả dòng \`Co-Authored-By\` mà công cụ tự chèn: xoá nó TRƯỚC khi đẩy. Không bao giờ đẩy đè (\`--force\`) — đẩy sai thì commit sửa mới.
5. \`git push -u ${"origin"} ${m.branch}\` khi xong. KHÔNG mở PR, KHÔNG merge, KHÔNG deploy, KHÔNG đụng \`main\` — Lead làm.
6. Báo cáo cuối: XONG / CHẶN, SHA đã đẩy, lệnh kiểm thử đã chạy + kết quả, tệp đã đổi, rủi ro còn lại.
7. Kiểm lại phạm vi trước khi báo xong: \`npm run ai -- ready ${m.mission.id} ${t.id}\` (chạy từ cây của Lead) hoặc \`git diff --name-only ${m.baseSha.slice(0, 12)}..HEAD\`.
`;
}

/* ═════════════ 11 · GITHUB (CHỈ ĐỌC, TUỲ CHỌN) ═════════════ */

export function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  const m = /github\.com[:/]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

export type GithubPr = { number: number; state: string; merged: boolean; draft: boolean; url: string };
export type GithubFacts = { pr: GithubPr | null; checks: { name: string; status: string; conclusion: string | null }[]; error?: string };
type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal; redirect?: "manual" | "follow" }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * Hỏi GitHub về PR + check của một nhánh. Kho PUBLIC nên đọc được KHÔNG cần token (60 lượt/giờ);
 * có `GH_TOKEN` / `GITHUB_TOKEN` thì dùng — và KHÔNG BAO GIỜ in nó ra. Lỗi mạng trả `error`,
 * không ném: một cổng tuỳ chọn không được làm hỏng lệnh `status`.
 */
export async function githubFacts(
  repo: { owner: string; repo: string },
  branch: string,
  sha: string | null,
  fetchImpl: FetchLike,
  token: string | null,
): Promise<GithubFacts> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "ai-tech-room" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const get = async (p: string): Promise<unknown> => {
    const r = await fetchImpl(`https://api.github.com/repos/${repo.owner}/${repo.repo}${p}`, { headers, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    return r.json();
  };
  try {
    const prs = (await get(`/pulls?state=all&per_page=5&head=${encodeURIComponent(`${repo.owner}:${branch}`)}`)) as unknown[];
    const p = Array.isArray(prs) && isObj(prs[0]) ? prs[0] : null;
    const pr: GithubPr | null = p
      ? { number: Number(p.number), state: String(p.state), merged: Boolean(p.merged_at), draft: Boolean(p.draft), url: String(p.html_url) }
      : null;
    let checks: GithubFacts["checks"] = [];
    if (sha) {
      const c = (await get(`/commits/${sha}/check-runs?per_page=50`)) as { check_runs?: unknown[] };
      checks = (c.check_runs ?? []).filter(isObj).map((x) => ({ name: String(x.name), status: String(x.status), conclusion: x.conclusion === null ? null : String(x.conclusion) }));
    }
    return { pr, checks };
  } catch (e) {
    return { pr: null, checks: [], error: (e as Error).message };
  }
}

/* ═════════════ 12 · MẶT PHẲNG ĐIỀU KHIỂN XUYÊN SỨ MỆNH — HÀM THUẦN ═════════════
 *
 * `docs/ai-tech-room/delivery-v2.md`. Mục 1–11 điều phối việc TRONG một sứ mệnh; tệp sứ mệnh nằm
 * trên nhánh Lead của chính nó, nên sứ mệnh A không thấy B. Mục này thêm MỘT sổ dùng chung — nhánh
 * `ai-control/registry` trên remote — để mọi phiên (máy này, máy khác, phiên trên mây) cùng trả lời:
 * ai đang giữ vùng nào · số migration nào đã có người lấy · ai đang cầm quyền gộp/deploy.
 *
 * Luật 1 vẫn đứng: sổ là LỜI KHAI, git/GitHub là SỰ THẬT. `reconcileEntry` suy trạng thái thật của
 * từng dòng mỗi lần đọc; sổ nói RUNNING mà nhánh đã vào `main` thì bảng in trạng thái thật kèm "lệch".
 */

export const MISSION_STATES = [
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
export type MissionState = (typeof MISSION_STATES)[number];
/** Đã KHÉP ⇒ nhả phạm vi + giữ chỗ migration. FAILED vẫn giữ: nó còn việc phải làm. */
export const CLOSED_STATES: ReadonlySet<MissionState> = new Set(["DONE", "CANCELLED"]);

/** EXISTS → dùng lại · PARTIAL → mở rộng · IN_PROGRESS → phối hợp/chờ · MISSING → dựng mới. */
export const INTAKE_VERDICTS = ["EXISTS", "PARTIAL", "IN_PROGRESS", "MISSING"] as const;
export type IntakeVerdict = (typeof INTAKE_VERDICTS)[number];

/** Danh sách ĐÓNG: một khoá lạ là lỗi gõ, không phải một vai mới (cùng tinh thần AGENTS.md mục 30). */
export const LEASE_NAMES = ["integration-lead", "tech-lead"] as const;
export type LeaseName = (typeof LEASE_NAMES)[number];

export type RegistryEntry = {
  schema: 1;
  mission_id: string;
  title: string;
  business_goal: string;
  status: MissionState;
  priority: Priority;
  risk: Risk;
  /** Phiên chịu trách nhiệm sứ mệnh (Tech Lead / Lead của sứ mệnh). */
  owner: string;
  /** Phiên / subagent đang làm (nếu khác owner). */
  worker: string | null;
  worktree: string | null;
  branch: string | null;
  base_sha: string | null;
  domains: string[];
  /** Phạm vi GHI dự kiến — cùng cú pháp `owns` (mục 3). */
  owned_paths: string[];
  dependencies: string[];
  blocked_by: string[];
  related_prs: number[];
  /** Số hiệu migration đã giữ chỗ (4 chữ số). */
  migration_reservations: string[];
  /** Lúc giữ chỗ từng số — MỘT nguồn cho cả `migration check` (CI) lẫn `queue` (review 06/10/2026). */
  migration_reserved_at?: Record<string, string>;
  created_at: string;
  updated_at: string;
  last_heartbeat: string;
  definition_of_done: string[];
  /** Tệp sứ mệnh chi tiết (DAG việc) nếu sứ mệnh dùng AI Tech Room. */
  mission_file?: string;
  intake?: { verdict: IntakeVerdict; evidence: string[] };
  /** Quyết định cần chủ shop — chỉ chín loại `OWNER_ESCALATIONS`. */
  needs_owner?: { category: (typeof OWNER_ESCALATIONS)[number]; action: string };
  evidence?: { merged?: string; deploy?: string; verify?: string; done?: string };
};

export type Lease = {
  name: LeaseName;
  holder: string;
  purpose: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
  /** Tăng mỗi lần đổi chủ — người đọc biết khoá đã qua tay ai khác từ lần trước mình nhìn. */
  generation: number;
  /**
   * sha256 của MÃ PHIÊN cấp lúc lấy khoá. Nhãn `máy:cây` không phân biệt được hai phiên mở trong CÙNG
   * một cây (review 06/10/2026: cả hai đều thành "chủ", cùng gộp, cùng deploy) — mã phiên thì có. Sổ
   * nằm trong kho PUBLIC nên chỉ lưu băm; mã này phân định phiên hợp tác, không phải bí mật bảo mật.
   */
  token_hash?: string;
};

export type ControlEvent = { at: string; kind: string; actor: string; mission?: string; detail: string };

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const MIG_NO_RE = /^\d{4}$/;
const ACTOR_RE = /^[A-Za-z0-9._:@/-]{1,100}$/;

export function validateEntry(raw: unknown): { entry: RegistryEntry | null; errors: string[] } {
  const errors: string[] = [];
  if (!isObj(raw)) return { entry: null, errors: ["dòng sổ: phải là object"] };
  const e = (m: string) => errors.push(m);
  if (raw.schema !== 1) e("schema: phải là 1");
  if (!isStr(raw.mission_id) || !SLUG_RE.test(raw.mission_id)) e(`mission_id: phải khớp ${SLUG_RE}`);
  if (!isStr(raw.title)) e("title: bắt buộc");
  if (!MISSION_STATES.includes(raw.status as MissionState)) e(`status: ${MISSION_STATES.join("|")}`);
  if (!PRIORITIES.includes(raw.priority as Priority)) e(`priority: ${PRIORITIES.join("|")}`);
  if (!RISKS.includes(raw.risk as Risk)) e(`risk: ${RISKS.join("|")}`);
  if (!isStr(raw.owner) || !ACTOR_RE.test(raw.owner)) e("owner: nhãn phiên (chữ, số, . _ : @ / -)");
  for (const k of ["created_at", "updated_at", "last_heartbeat"] as const) if (!isStr(raw[k]) || !ISO_RE.test(raw[k] as string)) e(`${k}: thời điểm ISO UTC`);
  for (const k of ["domains", "owned_paths", "dependencies", "blocked_by", "migration_reservations", "definition_of_done"] as const)
    if (raw[k] !== undefined && !strArr(raw[k])) e(`${k}: mảng chuỗi`);
  const owned = (strArr(raw.owned_paths) ? raw.owned_paths : []).map((p) => {
    const n = normalizePattern(p);
    if (n === null) e(`owned_paths: mẫu "${p}" không hợp lệ`);
    return n ?? p;
  });
  const deps = strArr(raw.dependencies) ? raw.dependencies : [];
  for (const d of deps) if (!SLUG_RE.test(d)) e(`dependencies: "${d}" không phải mã sứ mệnh`);
  const migs = strArr(raw.migration_reservations) ? raw.migration_reservations : [];
  for (const m of migs) if (!MIG_NO_RE.test(m)) e(`migration_reservations: "${m}" phải là 4 chữ số`);
  const prs = Array.isArray(raw.related_prs) ? raw.related_prs : [];
  if (raw.related_prs !== undefined && (!Array.isArray(raw.related_prs) || prs.some((n) => typeof n !== "number" || !Number.isInteger(n) || n <= 0)))
    e("related_prs: mảng số PR");
  if (raw.branch !== undefined && raw.branch !== null && (!isStr(raw.branch) || !REF_RE.test(raw.branch) || gitRefLooksUnsafe(raw.branch))) e("branch: tên nhánh không hợp lệ");
  if (raw.base_sha !== undefined && raw.base_sha !== null && (!isStr(raw.base_sha) || !SHA_RE.test(raw.base_sha))) e("base_sha: SHA 40 ký tự");
  let intake: RegistryEntry["intake"];
  if (raw.intake !== undefined) {
    const i = raw.intake;
    if (!isObj(i) || !INTAKE_VERDICTS.includes(i.verdict as IntakeVerdict) || !strArr(i.evidence)) e(`intake: { verdict: ${INTAKE_VERDICTS.join("|")}, evidence: [] }`);
    else intake = { verdict: i.verdict as IntakeVerdict, evidence: i.evidence };
  }
  let needsOwner: RegistryEntry["needs_owner"];
  if (raw.needs_owner !== undefined) {
    const n = raw.needs_owner;
    if (!isObj(n) || !OWNER_ESCALATIONS.includes(n.category as (typeof OWNER_ESCALATIONS)[number]) || !isStr(n.action))
      e(`needs_owner: { category: ${OWNER_ESCALATIONS.join("|")}, action }`);
    else needsOwner = { category: n.category as (typeof OWNER_ESCALATIONS)[number], action: n.action };
  }
  let reservedAt: Record<string, string> | undefined;
  if (raw.migration_reserved_at !== undefined) {
    const r = raw.migration_reserved_at;
    if (!isObj(r) || Object.entries(r).some(([k, v]) => !MIG_NO_RE.test(k) || typeof v !== "string" || !ISO_RE.test(v))) e("migration_reserved_at: { \"NNNN\": thời điểm ISO }");
    else reservedAt = r as Record<string, string>;
  }
  let evidence: RegistryEntry["evidence"];
  if (raw.evidence !== undefined) {
    const v = raw.evidence;
    if (!isObj(v) || Object.entries(v).some(([k, x]) => !["merged", "deploy", "verify", "done"].includes(k) || typeof x !== "string")) e("evidence: { merged?, deploy?, verify?, done? } là chuỗi");
    else evidence = v as RegistryEntry["evidence"];
  }
  if (errors.length) return { entry: null, errors };
  return {
    entry: {
      schema: 1,
      mission_id: raw.mission_id as string,
      title: raw.title as string,
      business_goal: isStr(raw.business_goal) ? raw.business_goal : "",
      status: raw.status as MissionState,
      priority: raw.priority as Priority,
      risk: raw.risk as Risk,
      owner: raw.owner as string,
      worker: isStr(raw.worker) ? raw.worker : null,
      worktree: isStr(raw.worktree) ? raw.worktree : null,
      branch: isStr(raw.branch) ? raw.branch : null,
      base_sha: isStr(raw.base_sha) ? raw.base_sha : null,
      domains: strArr(raw.domains) ? raw.domains : [],
      owned_paths: owned,
      dependencies: deps,
      blocked_by: strArr(raw.blocked_by) ? raw.blocked_by : [],
      related_prs: prs as number[],
      migration_reservations: migs,
      migration_reserved_at: reservedAt,
      created_at: raw.created_at as string,
      updated_at: raw.updated_at as string,
      last_heartbeat: raw.last_heartbeat as string,
      definition_of_done: strArr(raw.definition_of_done) ? raw.definition_of_done : [],
      mission_file: isStr(raw.mission_file) ? raw.mission_file : undefined,
      intake,
      needs_owner: needsOwner,
      evidence,
    },
    errors,
  };
}

/** Nhánh trong sổ đi vào tham số git ⇒ chặn mọi thứ git có thể đọc thành cờ hay một ref đặc biệt. */
function gitRefLooksUnsafe(b: string): boolean {
  return b.startsWith("-") || b === "HEAD" || b.includes("..") || b.endsWith(".lock") || b.includes("@{");
}

const riskMax = (xs: readonly Risk[]): Risk => xs.reduce<Risk>((a, b) => (riskRank(b) > riskRank(a) ? b : a), "LOW");

/** Dòng sổ dựng TỪ tệp sứ mệnh (khi sứ mệnh dùng AI Tech Room) — không khai tay lần thứ hai. */
export function entryFromMission(m: Mission, base: Partial<RegistryEntry> & { owner: string }, now: string): RegistryEntry {
  const owned = [...new Set(m.tasks.filter((t) => t.decision?.state !== "CANCELLED").flatMap((t) => t.owns))].sort();
  const pr = [...new Set(m.tasks.map((t) => t.pr).filter((x): x is number => typeof x === "number"))];
  const prio = m.tasks.map((t) => t.priority).sort()[0] ?? "P2";
  return {
    schema: 1,
    mission_id: m.id,
    title: m.title,
    business_goal: m.goal,
    status: base.status ?? "RUNNING",
    priority: base.priority ?? prio,
    risk: base.risk ?? riskMax(m.tasks.map((t) => t.risk)),
    owner: base.owner,
    worker: base.worker ?? null,
    worktree: base.worktree ?? null,
    branch: base.branch ?? null,
    base_sha: base.base_sha ?? null,
    domains: base.domains ?? [],
    owned_paths: base.owned_paths && base.owned_paths.length ? base.owned_paths : owned,
    dependencies: base.dependencies ?? [],
    blocked_by: base.blocked_by ?? [],
    related_prs: [...new Set([...(base.related_prs ?? []), ...pr])],
    migration_reservations: base.migration_reservations ?? [],
    migration_reserved_at: base.migration_reserved_at,
    created_at: base.created_at ?? now,
    updated_at: now,
    last_heartbeat: now,
    definition_of_done: base.definition_of_done && base.definition_of_done.length ? base.definition_of_done : [m.goal],
    mission_file: `.ai/missions/${m.id}.json`,
    intake: base.intake,
    needs_owner: base.needs_owner,
    evidence: base.evidence,
  };
}

/**
 * Phạm vi dự kiến của một nhánh KHÔNG khai báo (sứ mệnh ngoài AI Tech Room): thư mục chứa từng tệp
 * nhánh đã đổi. Đây là SỰ THẬT của nhánh, nên nó không bao giờ báo thiếu so với cái nhánh đã chạm.
 * Tệp nằm THẲNG trong một thư mục gốc (`docs/x.md`, `tests/y.ts`, `scripts/z.ts`) giữ nguyên tệp:
 * các thư mục phẳng ấy mọi việc cùng dùng, lấy cả thư mục là báo chồng giả với mọi sứ mệnh khác.
 */
export function inferOwnedPaths(files: readonly string[]): string[] {
  const out = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    // Thư mục route động của Next (`[id]`, `[token]`) không đi được vào cú pháp mẫu (chỉ `*` / `?`):
    // cắt tại đoạn ĐẦU TIÊN có ký tự đặc biệt và giữ thư mục cha — báo thừa, đúng chiều an toàn.
    const bad = parts.findIndex((p) => /[[\]{}!]/.test(p));
    if (bad >= 0) {
      out.add(bad === 0 ? "" : `${parts.slice(0, bad).join("/")}/`);
      continue;
    }
    out.add(parts.length <= 2 ? f : `${parts.slice(0, -1).join("/")}/`);
  }
  out.delete("");
  // Bỏ thư mục con đã nằm trong thư mục cha cũng có mặt.
  const all = [...out].sort();
  return all.filter((p) => !all.some((q) => q !== p && q.endsWith("/") && p.startsWith(q)));
}

export type Overlap = { mission: string; paths: string[]; hotspots: string[] };

/**
 * Sứ mệnh `me` chồng lên sứ mệnh ĐANG MỞ nào. Hai sứ mệnh đã có thứ tự (một bên phụ thuộc bên kia)
 * không tính là chồng: bên sau chờ bên trước vào `main`.
 */
export function missionOverlaps(me: Pick<RegistryEntry, "mission_id" | "owned_paths" | "dependencies">, others: readonly RegistryEntry[], cfg: Config): Overlap[] {
  return others
    .filter((o) => o.mission_id !== me.mission_id && !CLOSED_STATES.has(o.status) && !me.dependencies.includes(o.mission_id) && !o.dependencies.includes(me.mission_id))
    .map((o) => ({
      mission: o.mission_id,
      paths: scopeConflicts(me.owned_paths, o.owned_paths, cfg),
      hotspots: serialHotspotClash(me.owned_paths, o.owned_paths, cfg).map((h) => h.path),
    }))
    .filter((x) => x.paths.length > 0 || x.hotspots.length > 0);
}

export type ClaimDecision = { ok: boolean; refusals: string[]; warnings: string[] };

/**
 * Được đăng ký / cập nhật sứ mệnh này không. Từ chối khi: chồng phạm vi hoặc cùng điểm nóng SERIAL
 * với sứ mệnh đang mở (trừ khi tuần tự hoá bằng `dependencies` hoặc khai CÁCH TÍCH HỢP), intake nói
 * việc đã có / đang có người làm, phụ thuộc không tồn tại / thành vòng, hoặc giữ trùng số migration.
 */
export function claimDecision(me: RegistryEntry, others: readonly RegistryEntry[], cfg: Config, opts: { acceptOverlap?: string } = {}): ClaimDecision {
  const refusals: string[] = [];
  const warnings: string[] = [];
  const accept = (opts.acceptOverlap ?? "").trim();
  const byId = new Map(others.map((o) => [o.mission_id, o]));
  for (const d of me.dependencies) if (d === me.mission_id) refusals.push("DEPENDENCY: tự phụ thuộc chính mình");
  else if (!byId.has(d)) refusals.push(`DEPENDENCY: "${d}" không có trong sổ`);
  const graph = [...others.filter((o) => o.mission_id !== me.mission_id), me].map((o) => ({ id: o.mission_id, dependsOn: o.dependencies }));
  const cycle = findCycle(graph);
  if (cycle) refusals.push(`DEPENDENCY: thành vòng ${cycle.join(" → ")}`);
  if (!CLOSED_STATES.has(me.status)) {
    for (const o of missionOverlaps(me, others, cfg)) {
      const what = [o.paths.length ? `phạm vi ${o.paths.slice(0, 6).join(", ")}` : "", o.hotspots.length ? `điểm nóng SERIAL ${o.hotspots.join(", ")}` : ""].filter(Boolean).join(" · ");
      if (accept) warnings.push(`OVERLAP_ACCEPTED với ${o.mission}: ${what} — cách tích hợp: ${accept}`);
      else refusals.push(`OVERLAP với ${o.mission}: ${what} ⇒ tuần tự hoá (--after=${o.mission}) hoặc khai cách tích hợp (--accept-overlap="…")`);
    }
    if (me.intake && (me.intake.verdict === "EXISTS" || me.intake.verdict === "IN_PROGRESS")) {
      const msg = `DUPLICATE: intake kết luận ${me.intake.verdict} (${me.intake.evidence.slice(0, 3).join("; ")}) ⇒ ${me.intake.verdict === "EXISTS" ? "dùng lại cái đã có" : "phối hợp với việc đang chạy"}`;
      if (accept) warnings.push(`${msg} — vẫn đăng ký vì: ${accept}`);
      else refusals.push(msg);
    }
    const mine = new Set(me.migration_reservations);
    for (const o of others) {
      if (o.mission_id === me.mission_id || CLOSED_STATES.has(o.status)) continue;
      const clash = o.migration_reservations.filter((n) => mine.has(n));
      if (clash.length) refusals.push(`MIGRATION: ${clash.join(", ")} đã do ${o.mission_id} giữ chỗ — lấy số mới bằng \`migration reserve\``);
    }
  }
  return { ok: refusals.length === 0, refusals, warnings };
}

export type EntryFacts = {
  /** null = dòng sổ không khai nhánh. */
  branch: { local: boolean; remote: boolean; tip: string | null } | null;
  merged: MergeEvidence | null;
  pr: { number: number; state: string; merged: boolean; gates: string | null } | null;
  /** Commit đưa việc vào `main` đã nằm trong bản production chưa. null = không đo được. */
  inProduction: boolean | null;
  /** Tệp nhánh thật sự đã đổi so với `main` — null = không đo được. */
  touched: string[] | null;
  /** Phụ thuộc còn mở (chưa DONE/CANCELLED, chưa vào main). */
  openDependencies: string[];
};

/**
 * Trạng thái THẬT của một dòng sổ — git/GitHub thắng lời khai (luật 1). `drift` liệt kê từng chỗ sổ
 * nói khác sự thật; bảng điều khiển in chúng thay vì lặng lẽ sửa sổ.
 */
export function reconcileEntry(e: RegistryEntry, f: EntryFacts, cfg: Config, nowMs: number): { effective: MissionState; drift: string[] } {
  const drift: string[] = [];
  const hbAge = (nowMs - Date.parse(e.last_heartbeat)) / 3_600_000;
  const declared = e.status;
  if (f.touched && f.touched.length) {
    const outside = f.touched.filter((x) => !e.owned_paths.some((p) => fileInPattern(x, p)));
    if (outside.length) drift.push(`nhánh chạm ${outside.length} tệp NGOÀI phạm vi khai: ${outside.slice(0, 5).join(", ")}${outside.length > 5 ? " …" : ""}`);
  }
  if (declared === "CANCELLED") return { effective: "CANCELLED", drift };
  if (declared === "DONE") {
    if (!e.evidence?.done && !e.evidence?.verify) drift.push("DONE mà không có bằng chứng (evidence.done / evidence.verify)");
    return { effective: "DONE", drift };
  }
  if (["RUNNING", "PLANNING", "INTEGRATING", "DEPLOYING", "VERIFYING"].includes(declared) && hbAge > cfg.staleHeartbeatHours)
    drift.push(`nhịp tim cũ ${Math.round(hbAge)} giờ (ngưỡng ${cfg.staleHeartbeatHours}) — phiên giữ sứ mệnh có thể đã chết`);
  const merged = (f.merged !== null && f.merged !== "EMPTY") || Boolean(f.pr?.merged);
  if (merged) {
    if (f.inProduction === true) {
      if (declared !== "VERIFYING") drift.push("đã vào main VÀ đã lên production — chạy `verify` rồi `close --status=DONE`");
      return { effective: "VERIFYING", drift };
    }
    if (!["INTEGRATING", "DEPLOYING"].includes(declared)) drift.push(`đã vào main (${f.merged ?? "PR đã merge"}) nhưng sổ ghi ${declared}${f.inProduction === false ? " — chưa deploy" : ""}`);
    return { effective: declared === "DEPLOYING" ? "DEPLOYING" : "INTEGRATING", drift };
  }
  if (f.pr && f.pr.state === "open") {
    if (f.pr.gates === "failure") return { effective: "FAILED", drift: [...drift, `PR #${f.pr.number}: gates ĐỎ`] };
    if (f.pr.gates === "success") return { effective: "PR_READY", drift };
  }
  if (e.branch && f.branch && !f.branch.local && !f.branch.remote && !["BACKLOG", "PLANNING", "READY", "BLOCKED"].includes(declared)) {
    drift.push(`nhánh ${e.branch} không còn ở máy này lẫn trên remote — ORPHANED, phải đối chiếu tay`);
    return { effective: "BLOCKED", drift };
  }
  if (f.openDependencies.length && ["READY", "RUNNING", "PLANNING"].includes(declared)) {
    if (declared !== "READY" && declared !== "PLANNING") drift.push(`đang ${declared} trong khi phụ thuộc ${f.openDependencies.join(", ")} chưa vào main`);
    return { effective: "BACKLOG", drift };
  }
  return { effective: declared, drift };
}

/** Giữ chỗ migration của các sứ mệnh đang mở, kèm mốc giữ — MỘT hàm cho mọi đường đọc. */
export function openReservations(entries: readonly RegistryEntry[]): { mission: string; number: string; at: string }[] {
  return entries
    .filter((e) => !CLOSED_STATES.has(e.status))
    .flatMap((e) => e.migration_reservations.map((n) => ({ mission: e.mission_id, number: n, at: e.migration_reserved_at?.[n] ?? e.created_at })));
}

/* ── Khoá có hạn (lease) ── */

export type LeaseOp = "acquire" | "renew" | "release";
export type LeaseDecision = { ok: boolean; next: Lease | null; reason: string; takeoverFrom?: Lease };

export type LeaseClaimant = {
  name: LeaseName;
  holder: string;
  purpose: string;
  /** Băm của mã phiên người gọi TRÌNH RA (`--token` / `--resume`) — null = không trình mã nào. */
  tokenHash: string | null;
  /** Băm của mã phiên MỚI sẽ cấp nếu khoá đổi chủ (người gọi sinh, hàm này không sinh ngẫu nhiên). */
  freshTokenHash: string;
};

/** Khoá này có phải của người gọi không: đúng nhãn VÀ đúng mã phiên. Khoá cũ chưa có mã: chỉ so nhãn. */
export function leaseIsMine(cur: Lease | null, holder: string, tokenHash: string | null): boolean {
  if (!cur || cur.holder !== holder) return false;
  return cur.token_hash === undefined || (tokenHash !== null && cur.token_hash === tokenHash);
}

/**
 * MỘT chủ tại một thời điểm, KHÔNG khoá chết: khoá có hạn, và hết hạn mà không ai gia hạn là coi như
 * nhả (phiên giữ nó đã chết). Chủ = đúng nhãn `máy:cây` VÀ đúng mã phiên cấp lúc lấy; cùng nhãn mà
 * không có mã là một phiên KHÁC trong cùng cây (AGENTS.md mục 9 cấm, nhưng khoá không được tin điều đó)
 * ⇒ bị từ chối như người lạ. Phiên phục hồi sau sập trình lại mã (`--resume`) hoặc chờ hết hạn.
 * Hàm thuần — phép so-và-ghi nguyên tử nằm ở lớp ghi (đẩy fast-forward, mục dưới).
 */
export function leaseDecision(cur: Lease | null, op: LeaseOp, me: LeaseClaimant, nowMs: number, ttlMs: number): LeaseDecision {
  const now = new Date(nowMs).toISOString();
  const live = cur !== null && Date.parse(cur.expires_at) > nowMs;
  const mine = leaseIsMine(cur, me.holder, me.tokenHash);
  const sameLabel = cur !== null && cur.holder === me.holder && !mine;
  const fresh = (gen: number): Lease => ({
    name: me.name,
    holder: me.holder,
    purpose: me.purpose,
    acquired_at: now,
    heartbeat_at: now,
    expires_at: new Date(nowMs + ttlMs).toISOString(),
    generation: gen,
    token_hash: me.freshTokenHash,
  });
  const other = (c: Lease) =>
    sameLabel
      ? `cùng nhãn ${c.holder} nhưng KHÔNG đúng mã phiên — một phiên khác trong cùng cây đang giữ (dừng lại), hoặc chính bạn sau sập: CHỈ khi chắc phiên cũ đã chết mới dùng --resume / --token=…; không thì chờ hết hạn ${c.expires_at}`
      : `thuộc ${c.holder} (${c.purpose || "không ghi mục đích"}) tới ${c.expires_at}`;
  if (op === "release") {
    if (!cur) return { ok: true, next: null, reason: "khoá vốn đang trống" };
    if (!mine) return { ok: false, next: cur, reason: `khoá ${other(cur)} — chỉ chủ của nó nhả được` };
    return { ok: true, next: null, reason: "đã nhả" };
  }
  if (op === "renew") {
    if (!cur || !mine) return { ok: false, next: cur, reason: cur ? `khoá ${other(cur)}` : "không có khoá để gia hạn — acquire trước" };
    return { ok: true, next: { ...cur, purpose: me.purpose || cur.purpose, heartbeat_at: now, expires_at: new Date(nowMs + ttlMs).toISOString(), token_hash: cur.token_hash ?? me.freshTokenHash }, reason: cur.token_hash ? "đã gia hạn" : "đã gia hạn + nâng cấp khoá cũ: gắn mã phiên" };
  }
  if (!cur) return { ok: true, next: fresh(1), reason: "khoá trống — đã lấy" };
  // Khoá cũ chưa có mã: lần đầu người trùng nhãn chạm vào thì GẮN mã — từ đó phiên thứ hai cùng cây bị từ chối.
  if (mine) return { ok: true, next: { ...cur, purpose: me.purpose || cur.purpose, heartbeat_at: now, expires_at: new Date(nowMs + ttlMs).toISOString(), token_hash: cur.token_hash ?? me.freshTokenHash }, reason: cur.token_hash ? "đã là chủ (đúng mã phiên) — gia hạn" : "khoá cũ chưa có mã — nâng cấp: gắn mã phiên mới" };
  if (live) return { ok: false, next: cur, reason: `đang ${other(cur)}` };
  return { ok: true, next: fresh(cur.generation + 1), reason: `khoá của ${cur.holder} đã hết hạn từ ${cur.expires_at} — tiếp quản`, takeoverFrom: cur };
}

/* ── Số hiệu migration ── */

export function migrationNumberOf(file: string): string | null {
  const m = /(?:^|\/)(\d{4})_[^/]+\.sql$/.exec(file.replace(/\\/g, "/"));
  return m ? m[1] : null;
}

/** Số kế tiếp AN TOÀN = lớn hơn mọi số trên main, trên mọi nhánh đang mở, và mọi số đã giữ chỗ. */
export function nextMigrationNumber(x: { main: readonly string[]; branches: readonly string[]; reserved: readonly string[] }): string {
  const nums = [...x.main, ...x.branches].map(migrationNumberOf).filter((n): n is string => n !== null).concat(x.reserved.filter((n) => MIG_NO_RE.test(n))).map(Number);
  return String(Math.max(-1, ...nums) + 1).padStart(4, "0");
}

export type PrMigrationInput = {
  pr: number;
  createdAt: string;
  /** Tệp migration PR này THÊM (đường dẫn `drizzle/NNNN_*.sql`). */
  added: readonly string[];
  /** Tệp migration đang có trên main. */
  main: readonly string[];
  others: readonly { pr: number; createdAt: string; added: readonly string[] }[];
  reservations: readonly { mission: string; number: string; at: string }[];
  /** Sứ mệnh mà PR này thuộc về (giữ chỗ của chính nó không tính là va). */
  ownMission: string | null;
};

/**
 * Va số migration của MỘT PR — đúng ca #598/#599 cùng lấy 0219. Bên ĐẾN SAU (PR tạo sau / giữ chỗ
 * sau) là bên phải đánh số lại, nên chỉ bên đó đỏ; bên kia nhận cảnh báo.
 */
/** `a` mở TRƯỚC `b`? Hoà mốc ⇒ số PR nhỏ hơn là trước; mốc không đọc được ⇒ coi như trước (bên kia đỏ — đóng cửa khi không chắc). */
function openedBefore(aAt: string, aPr: number, bAt: string, bPr: number): boolean {
  const a = Date.parse(aAt);
  const b = Date.parse(bAt);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  return a < b || (a === b && aPr < bPr);
}

export function checkPrMigrations(x: PrMigrationInput): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const mainByNo = new Map<string, string>();
  for (const f of x.main) {
    const n = migrationNumberOf(f);
    if (n) mainByNo.set(n, f.split("/").pop() ?? f);
  }
  const maxMain = Math.max(-1, ...[...mainByNo.keys()].map(Number));
  const fix = "chạy `npm run migration:renumber -- --apply` trong cây của PR (so với origin/main), rồi `npm run ai -- migration reserve`";
  for (const f of x.added) {
    const n = migrationNumberOf(f);
    if (!n) continue;
    const base = f.split("/").pop() ?? f;
    const onMain = mainByNo.get(n);
    if (onMain && onMain !== base) problems.push(`${base}: số ${n} đã thuộc ${onMain} trên main ⇒ ${fix}`);
    else if (!onMain && Number(n) <= maxMain) problems.push(`${base}: số ${n} không lớn hơn số cuối trên main (${String(maxMain).padStart(4, "0")}) — drizzle bỏ qua migration lùi số ⇒ ${fix}`);
    for (const o of x.others) {
      const same = o.added.filter((g) => migrationNumberOf(g) === n && (g.split("/").pop() ?? g) !== base);
      if (!same.length) continue;
      if (openedBefore(o.createdAt, o.pr, x.createdAt, x.pr)) problems.push(`${base}: PR #${o.pr} (mở trước) cũng thêm số ${n} (${same.join(", ")}) ⇒ ${fix}`);
      else warnings.push(`${base}: PR #${o.pr} (mở sau) cũng thêm số ${n} — bên đó phải đánh số lại`);
    }
    for (const r of x.reservations) {
      if (r.number !== n || r.mission === x.ownMission) continue;
      if (!(Date.parse(r.at) > Date.parse(x.createdAt))) problems.push(`${base}: số ${n} đã được sứ mệnh ${r.mission} giữ chỗ từ ${r.at} ⇒ ${fix}`);
      else warnings.push(`${base}: sứ mệnh ${r.mission} giữ chỗ số ${n} sau khi PR mở — bên đó phải lấy số khác`);
    }
  }
  return { problems, warnings };
}

/* ── Rủi ro, chính sách gộp ── */

/** Câu lệnh migration phá dữ liệu: không đảo ngược được bằng một lượt deploy lại. */
export function isDestructiveSql(sql: string): boolean {
  const s = sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  return /\bDROP\s+(TABLE|COLUMN|SCHEMA|TYPE|VIEW|MATERIALIZED\s+VIEW)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bUPDATE\s+(ONLY\s+)?[A-Za-z_"][\w".]*(\s+(AS\s+)?[A-Za-z_]\w*)?\s+SET\b|\bALTER\s+COLUMN\s+("[^"]+"|\S+)\s+(SET\s+DATA\s+)?TYPE\b|\bALTER\s+TABLE\b[^;]*\bDROP\b(?!\s+(DEFAULT|NOT\s+NULL|CONSTRAINT|INDEX))/i.test(s);
}

/**
 * Rủi ro của một thay đổi theo TỆP nó chạm: sàn theo đường dẫn (`riskFloor`) nâng; tệp nằm trọn
 * trong `lowRiskPaths` mà không chạm sàn nào ⇒ LOW; còn lại MEDIUM (logic nghiệp vụ, API, tích hợp).
 * Migration phá dữ liệu ⇒ CRITICAL bất kể đường dẫn. Chính sách mở rộng bằng `.ai/config.json`.
 */
export function classifyRisk(files: readonly string[], cfg: Config, opts: { destructiveMigration?: boolean } = {}): { risk: Risk; reasons: string[] } {
  if (!files.length) return { risk: "LOW", reasons: ["không đổi tệp nào"] };
  const floor = riskFloorFor(files, cfg);
  const allLow = files.every((f) => cfg.lowRiskPaths.some((p) => fileInPattern(f, p)));
  let risk: Risk = riskRank(floor.risk) > riskRank(allLow ? "LOW" : "MEDIUM") ? floor.risk : allLow ? "LOW" : "MEDIUM";
  const reasons = [...floor.reasons];
  if (!floor.reasons.length) reasons.push(allLow ? "chỉ chạm vùng rủi ro thấp (lowRiskPaths)" : "chạm logic / API / tích hợp ngoài vùng rủi ro thấp ⇒ MEDIUM");
  if (opts.destructiveMigration) {
    risk = "CRITICAL";
    reasons.push("migration PHÁ dữ liệu (DROP / TRUNCATE / DELETE) — không đảo ngược được bằng deploy lại");
  }
  return { risk, reasons };
}

export const mergePolicyFor = (risk: Risk, cfg: Config): MergePolicy => cfg.mergePolicy[risk];

/* ── Hàng đợi gộp ── */

export type QueueItem = {
  pr: number;
  title: string;
  branch: string;
  draft: boolean;
  risk: Risk;
  gates: "success" | "failure" | "pending" | "missing";
  /** `mergeable_state` của GitHub: clean · unstable · blocked · behind · dirty · unknown … */
  mergeable: string;
  /** PR phụ thuộc CÒN MỞ (đã lọc PR đã đóng / đã gộp). */
  deps: number[];
  files: string[];
  /** Đầu nhánh lúc xét — gộp phải kèm ĐÚNG SHA này. */
  sha: string;
  migrationProblems: string[];
  createdAt: string;
  /** Có dấu review ĐẠT trong SỔ cho đúng `sha` này (`review <PR> --sha=… --verdict=PASS`, chỉ phiên cầm khoá Lead ghi được). */
  reviewed: boolean;
};

export const QUEUE_VERDICTS = [
  "MERGE_NOW",
  "MERGE_ISOLATED",
  "WAIT_SERIAL",
  "WAIT_DEPENDENCY",
  "WAIT_GATES",
  "NEEDS_REVIEW",
  "NEEDS_OWNER",
  "FIX_GATES",
  "FIX_CONFLICT",
  "MIGRATION_COLLISION",
  "DRAFT",
] as const;
export type QueueVerdict = (typeof QUEUE_VERDICTS)[number];
export type QueueRow = { item: QueueItem; verdict: QueueVerdict; why: string; policy: MergePolicy };

/**
 * PR xanh KHÔNG có nghĩa là gộp ngay. Thứ tự: phụ thuộc trước · rủi ro thấp gom thành MỘT LÔ (một
 * deploy) · HIGH/CRITICAL đi RIÊNG (gộp → deploy → hậu kiểm rồi mới tới việc sau) · hai PR chạm cùng
 * tệp / cùng điểm nóng SERIAL không cùng lô (ruleset `strict` đang tắt — gộp cả hai mà không cập nhật
 * nhánh là chỗ xung đột ngữ nghĩa lọt qua).
 */
export function orderQueue(items: readonly QueueItem[], cfg: Config): QueueRow[] {
  const open = new Set(items.map((i) => i.pr));
  const rows: QueueRow[] = [];
  const candidates: QueueItem[] = [];
  for (const it of items) {
    const policy = mergePolicyFor(it.risk, cfg);
    const row = (verdict: QueueVerdict, why: string) => rows.push({ item: it, verdict, why, policy });
    const waitDeps = it.deps.filter((d) => open.has(d));
    if (it.draft) row("DRAFT", "PR nháp");
    else if (waitDeps.length) row("WAIT_DEPENDENCY", `chờ ${waitDeps.map((d) => `#${d}`).join(", ")} vào main trước`);
    else if (it.mergeable === "dirty") row("FIX_CONFLICT", "xung đột với main — cập nhật nhánh trong cây của nó, giải có chủ đích");
    else if (it.migrationProblems.length) row("MIGRATION_COLLISION", it.migrationProblems[0]);
    else if (it.gates === "failure") row("FIX_GATES", "gates / gates ĐỎ — worker sửa, không gộp");
    else if (it.gates !== "success") row("WAIT_GATES", it.gates === "pending" ? "gates đang chạy" : "chưa có lượt gates cho đầu nhánh");
    else if (policy === "OWNER") row("NEEDS_OWNER", `rủi ro ${it.risk} — chính sách gộp đòi chủ shop duyệt`);
    else if (policy === "LEAD_REVIEW" && !it.reviewed) row("NEEDS_REVIEW", `rủi ro ${it.risk} — cần một lượt ai-tech-reviewer trên đúng đầu nhánh, rồi \`review ${it.pr} --sha=${it.sha} --verdict=PASS --token=…\``);
    else candidates.push(it);
  }
  // Lô gộp: rủi ro thấp trước, cũ trước. HIGH/CRITICAL chỉ đi khi lô đang trống, và đi một mình.
  candidates.sort((a, b) => riskRank(a.risk) - riskRank(b.risk) || Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.pr - b.pr);
  const batch: QueueItem[] = [];
  let isolated: QueueItem | null = null;
  for (const it of candidates) {
    const policy = mergePolicyFor(it.risk, cfg);
    const row = (verdict: QueueVerdict, why: string) => rows.push({ item: it, verdict, why, policy });
    const high = riskRank(it.risk) >= riskRank("HIGH");
    if (isolated) {
      row("WAIT_SERIAL", `#${isolated.pr} (${isolated.risk}) đang đi riêng — gộp sau khi nó đã deploy + hậu kiểm`);
      continue;
    }
    const clash = batch.find((b) => b.files.some((f) => it.files.includes(f)) || serialHotspotClash(b.files, it.files, cfg).length > 0);
    if (clash) {
      row("WAIT_SERIAL", `chạm cùng tệp / điểm nóng với #${clash.pr} trong lô — gộp sau, cập nhật nhánh rồi để gates chạy lại`);
      continue;
    }
    if (high) {
      if (batch.length) row("WAIT_SERIAL", `rủi ro ${it.risk} đi riêng — chờ lô hiện tại (${batch.map((b) => `#${b.pr}`).join(", ")}) deploy xong`);
      else {
        isolated = it;
        row("MERGE_ISOLATED", `rủi ro ${it.risk}: gộp MỘT MÌNH → deploy → verify, rồi mới tới PR khác`);
      }
      continue;
    }
    batch.push(it);
    row("MERGE_NOW", batch.length === 1 ? "đầu lô — gộp" : `cùng lô với ${batch.slice(0, -1).map((b) => `#${b.pr}`).join(", ")} — một lần deploy cho cả lô`);
  }
  const rank = (v: QueueVerdict) => QUEUE_VERDICTS.indexOf(v);
  return rows.sort((a, b) => rank(a.verdict) - rank(b.verdict) || Date.parse(a.item.createdAt) - Date.parse(b.item.createdAt) || a.item.pr - b.item.pr);
}

/** Phụ thuộc khai trong thân PR: dòng "Phụ thuộc: #12, #15" hoặc "Depends-on: #12". */
export function parsePrDependencies(body: string): number[] {
  const out = new Set<number>();
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s*(?:[-*]\s*)?(?:Phụ thuộc|Phu thuoc|Depends[- ]on)\s*:\s*(.+)$/i.exec(line);
    if (!m) continue;
    for (const n of m[1].matchAll(/#(\d+)/g)) out.add(Number(n[1]));
  }
  return [...out].sort((a, b) => a - b);
}

/* ── Kế hoạch deploy · hậu kiểm ── */

export type DeployInput = {
  productionSha: string | null;
  mainSha: string;
  undeployed: { sha: string; subject: string; risk: Risk; migrations: string[] }[];
  mainGates: "success" | "failure" | "pending" | "missing";
  /** Lượt `deploy-vps.yml` đang chạy / đang chờ. */
  deployActive: { id: number; sha: string; status: string }[];
  leaseHolder: string | null;
  me: string;
};
export type DeployPlan = { action: "NOTHING" | "UNKNOWN_PRODUCTION" | "WAIT_DEPLOY" | "FIX_MAIN" | "NEED_LEASE" | "DEPLOY"; why: string; sha?: string; notes: string[] };

/**
 * MỘT lượt deploy cho cả lô đã vào `main`, MỘT chủ deploy tại một thời điểm. Không deploy chồng (lượt
 * đang chạy đã phủ hoặc sẽ phủ), không deploy khi `main` đỏ, không deploy khi không cầm khoá
 * Integration Lead. Hàm thuần — dispatch là một bước tường minh của Lead, không phải tác dụng phụ.
 */
export function planDeploy(x: DeployInput): DeployPlan {
  const notes: string[] = [];
  if (x.productionSha === null) return { action: "UNKNOWN_PRODUCTION", why: "không đọc được SHA đang chạy (/api/health) — không biết lô gồm những gì", notes };
  if (x.productionSha === x.mainSha || x.undeployed.length === 0) return { action: "NOTHING", why: `production đã ở ${x.mainSha.slice(0, 8)}`, notes };
  if (x.deployActive.length) {
    const covers = x.deployActive.some((d) => d.sha === x.mainSha);
    return { action: "WAIT_DEPLOY", why: covers ? `lượt deploy ${x.deployActive.map((d) => d.id).join(", ")} đang chạy ĐÚNG ngọn main — chỉ chờ nó` : `lượt deploy ${x.deployActive.map((d) => d.id).join(", ")} đang chạy — chờ xong rồi xét lại (khoá vòng đời trên VPS cũng sẽ bắt lượt mới chờ)`, notes };
  }
  if (x.mainGates === "failure") return { action: "FIX_MAIN", why: "gates trên ngọn main ĐỎ — sửa main trước, không đưa bản đỏ lên production", notes };
  if (x.leaseHolder !== x.me) return { action: "NEED_LEASE", why: x.leaseHolder ? `khoá integration-lead đang thuộc ${x.leaseHolder}` : "chưa cầm khoá integration-lead — `npm run ai -- lease acquire integration-lead`", notes };
  const high = x.undeployed.filter((c) => riskRank(c.risk) >= riskRank("HIGH"));
  const migs = x.undeployed.flatMap((c) => c.migrations);
  notes.push(`lô ${x.undeployed.length} commit · ${high.length} commit rủi ro ≥ HIGH · ${migs.length} migration${migs.length ? ` (${migs.join(", ")})` : ""}`);
  if (high.length > 1) notes.push(`! ${high.length} thay đổi rủi ro cao trong cùng một lô — lần sau gộp chúng riêng (hàng đợi đánh MERGE_ISOLATED)`);
  if (x.mainGates !== "success") notes.push("gates của ngọn main chưa xong — deploy sẽ CHỜ đúng lượt đó rồi dùng lại (job bang_chung), không chạy trùng");
  return { action: "DEPLOY", why: `đưa ${x.mainSha.slice(0, 8)} lên (production đang ${x.productionSha.slice(0, 8)})`, sha: x.mainSha, notes };
}

export type VerifyInput = {
  expectedSha: string;
  health: { ok?: unknown; commit?: unknown; platform?: { migrations?: unknown } } | null;
  healthError?: string;
  expectedMigrations: number | null;
  deployRun: { conclusion: string | null; status: string; url: string } | null;
  endpoints: { path: string; status: number | null }[];
};

/** Hậu kiểm production. Workflow deploy xanh KHÔNG phải DONE: phải đo được bản đang chạy là bản mong đợi. */
export function verifyVerdict(x: VerifyInput): { pass: boolean; checks: { ok: boolean; label: string }[] } {
  const checks: { ok: boolean; label: string }[] = [];
  const h = x.health;
  checks.push({ ok: h !== null && h.ok === true, label: h ? `health ok=${String(h.ok)}` : `health không đọc được (${x.healthError ?? "?"})` });
  const commit = h && typeof h.commit === "string" ? h.commit : "";
  checks.push({ ok: commit.length >= 7 && x.expectedSha.startsWith(commit), label: `bản đang chạy ${commit || "?"} ${commit && x.expectedSha.startsWith(commit) ? "=" : "≠"} ${x.expectedSha.slice(0, 12)}` });
  const mig = h && isObj(h.platform) && typeof h.platform.migrations === "number" ? h.platform.migrations : null;
  if (x.expectedMigrations !== null)
    checks.push({ ok: mig === x.expectedMigrations, label: `migration đã áp ${mig ?? "?"} / sổ của SHA ${x.expectedMigrations}` });
  checks.push({
    ok: x.deployRun !== null && x.deployRun.status === "completed" && x.deployRun.conclusion === "success",
    label: x.deployRun ? `lượt deploy của SHA: ${x.deployRun.status}/${x.deployRun.conclusion ?? "—"} (gồm smoke trên VPS) ${x.deployRun.url}` : "không tìm thấy lượt deploy nào của SHA này",
  });
  for (const e of x.endpoints) checks.push({ ok: e.status !== null && e.status >= 200 && e.status < 400, label: `GET ${e.path} → ${e.status ?? "lỗi mạng"}` });
  return { pass: checks.every((c) => c.ok), checks };
}

/* ── Chống trùng việc ── */

export type IntakeSignals = {
  keywords: string[];
  /** Tệp trên main chứa TẤT CẢ từ khoá. */
  mainFiles: string[];
  active: { kind: "MISSION" | "PR" | "BRANCH"; id: string; title: string; matched: string[]; pathOverlap: string[] }[];
};

/** Bỏ dấu + chữ thường — so khớp "Báo cáo" với "bao cao" trong tên nhánh. */
export function foldText(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
}

/**
 * Gợi ý phân loại yêu cầu. Máy KHÔNG hiểu nghĩa — nó chỉ nói chỗ nào trông giống: việc ĐANG CHẠY chạm
 * cùng vùng / cùng chủ đề là tín hiệu mạnh (IN_PROGRESS); tệp trên main mang mọi từ khoá là tín hiệu
 * "đã có ít nhất một phần" (PARTIAL — Lead đọc rồi nâng thành EXISTS nếu đúng là đủ). Không tín hiệu
 * nào ⇒ MISSING. Lead ghi phán quyết CUỐI vào sổ (`claim --intake=…`).
 */
export function intakeVerdict(s: IntakeSignals): { verdict: IntakeVerdict; why: string[] } {
  const why: string[] = [];
  const need = Math.max(1, Math.ceil(s.keywords.length / 2));
  const hot = s.active.filter((a) => a.pathOverlap.length > 0 || a.matched.length >= need);
  for (const a of hot) why.push(`${a.kind} ${a.id} «${a.title}»${a.matched.length ? ` · khớp ${a.matched.join(", ")}` : ""}${a.pathOverlap.length ? ` · chồng ${a.pathOverlap.slice(0, 4).join(", ")}` : ""}`);
  if (hot.length) return { verdict: "IN_PROGRESS", why };
  if (s.mainFiles.length) return { verdict: "PARTIAL", why: [`${s.mainFiles.length} tệp trên main mang đủ từ khoá: ${s.mainFiles.slice(0, 6).join(", ")} — đọc trước khi dựng`] };
  return { verdict: "MISSING", why: ["không thấy việc đang chạy lẫn mã trên main mang đủ từ khoá"] };
}

/* ═════════════ 12b · SỔ ĐĂNG KÝ TRÊN NHÁNH ĐIỀU KHIỂN — ĐỌC / GHI KHÔNG CHẠM CÂY NÀO ═════════════
 *
 * Nhánh `ai-control/registry` là một cây PHẲNG: `mission.<id>.json` · `lease.<tên>.json` ·
 * `events.ndjson`. Ghi bằng lệnh cấp thấp (`hash-object` → `mktree` → `commit-tree`) nên không đụng
 * chỉ mục hay cây làm việc nào; rồi ĐẨY KHÔNG ÉP. Đẩy không ép CHÍNH LÀ phép so-và-ghi: hai phiên
 * cùng đọc một đỉnh rồi cùng ghi ⇒ GitHub nhận một, từ chối bên kia (non-fast-forward) ⇒ bên kia đọc
 * lại và quyết lại trên sự thật mới. Khoá Integration Lead đúng nghĩa "một chủ" nhờ đó, không cần
 * máy chủ thứ hai.
 */

export class ControlConflict extends Error {}

/**
 * Dấu "đã review độc lập" của một PR rủi ro HIGH. Nằm trong SỔ (ghi bằng so-và-ghi, có actor) chứ không
 * trong thân PR — dòng chữ trong thân PR thì ai mở được PR cũng viết được, và nó sống sót qua commit mới
 * (review 06/10/2026). Gắn `sha`: đầu nhánh đổi là dấu mất hiệu lực.
 */
export type ReviewRecord = { pr: number; sha: string; verdict: "PASS" | "FAIL"; actor: string; at: string; note: string };

/** PR có dấu review ĐẠT cho ĐÚNG đầu nhánh hiện tại không. Dấu mới nhất của PR quyết định (FAIL sau PASS là FAIL). */
export function reviewedAt(reviews: readonly ReviewRecord[], pr: number, headSha: string): boolean {
  const mine = reviews.filter((r) => r.pr === pr && r.sha === headSha).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return mine.length > 0 && mine[0].verdict === "PASS";
}

export type ControlState = {
  tip: string | null;
  entries: RegistryEntry[];
  invalid: { file: string; errors: string[] }[];
  leases: Lease[];
  events: ControlEvent[];
  /** tên tệp → SHA blob (để ghi lại cây không đổi những gì không sửa). */
  blobs: Map<string, string>;
  /** Dấu review độc lập theo PR — gắn đúng SHA đầu nhánh lúc review (`review.<pr>.json`). */
  reviews: ReviewRecord[];
  /** Đọc remote được không — false thì mọi lệnh ghi phải dừng (đọc bản cũ ở máy này để BÁO thì được). */
  fetched: boolean;
  fetchError?: string;
};

const MAX_EVENTS = 3000;
const controlRemoteRef = (ctx: RepoCtx) => `refs/remotes/${ctx.config.remote}/${ctx.config.controlBranch}`;

function gitIn(cwd: string, args: readonly string[], input: string): GitResult {
  const r = spawnSync("git", ["-c", "core.quotepath=off", ...args], { cwd, input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (r.error) throw new Error(`không chạy được git (${r.error.message})`);
  return { code: r.status ?? 1, out: (r.stdout ?? "").replace(/\s+$/, ""), err: (r.stderr ?? "").trim() };
}

/** Kéo nhánh điều khiển về. Nhánh chưa có trên remote = sổ trống (không phải lỗi). */
export function fetchControl(ctx: RepoCtx): { ok: boolean; err?: string } {
  const r = gitRun(ctx.top, ["fetch", "--quiet", ctx.config.remote, `refs/heads/${ctx.config.controlBranch}:${controlRemoteRef(ctx)}`]);
  if (r.code === 0) return { ok: true };
  if (/couldn't find remote ref|không tìm thấy/i.test(r.err)) {
    // Remote không còn nhánh ⇒ bản sao cũ ở máy này không còn là sự thật.
    gitRun(ctx.top, ["update-ref", "-d", controlRemoteRef(ctx)]);
    return { ok: true };
  }
  return { ok: false, err: r.err || `mã ${r.code}` };
}

export function readControl(ctx: RepoCtx, opts: { fetch: boolean }): ControlState {
  let fetched = true;
  let fetchError: string | undefined;
  if (opts.fetch) {
    const f = fetchControl(ctx);
    fetched = f.ok;
    fetchError = f.err;
  }
  const tip = gitTry(ctx.top, ["rev-parse", "--verify", "--quiet", `${controlRemoteRef(ctx)}^{commit}`]);
  const st: ControlState = { tip, entries: [], invalid: [], leases: [], events: [], blobs: new Map(), reviews: [], fetched: opts.fetch ? fetched : false, fetchError };
  if (!tip) return st;
  for (const line of lines(gitTry(ctx.top, ["ls-tree", tip]))) {
    const m = /^(\d+) blob ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (m) st.blobs.set(m[3], m[2]);
  }
  const blob = (sha: string) => gitTry(ctx.top, ["cat-file", "blob", sha]) ?? "";
  for (const [name, sha] of st.blobs) {
    if (name.startsWith("mission.") && name.endsWith(".json")) {
      try {
        const v = validateEntry(JSON.parse(blob(sha)));
        if (v.entry && `mission.${v.entry.mission_id}.json` === name) st.entries.push(v.entry);
        else st.invalid.push({ file: name, errors: v.errors.length ? v.errors : ["tên tệp không khớp mission_id"] });
      } catch (e) {
        st.invalid.push({ file: name, errors: [`JSON hỏng: ${(e as Error).message}`] });
      }
    } else if (name.startsWith("lease.") && name.endsWith(".json")) {
      try {
        const l = JSON.parse(blob(sha)) as Lease;
        if (isObj(l) && LEASE_NAMES.includes(l.name) && `lease.${l.name}.json` === name && isStr(l.holder) && isStr(l.expires_at)) st.leases.push(l);
        else st.invalid.push({ file: name, errors: ["khoá hỏng"] });
      } catch (e) {
        st.invalid.push({ file: name, errors: [`JSON hỏng: ${(e as Error).message}`] });
      }
    } else if (/^review\.\d+\.json$/.test(name)) {
      try {
        const r = JSON.parse(blob(sha)) as ReviewRecord;
        if (isObj(r) && `review.${r.pr}.json` === name && SHA_RE.test(String(r.sha)) && (r.verdict === "PASS" || r.verdict === "FAIL")) st.reviews.push(r);
        else st.invalid.push({ file: name, errors: ["dấu review hỏng"] });
      } catch (e) {
        st.invalid.push({ file: name, errors: [`JSON hỏng: ${(e as Error).message}`] });
      }
    } else if (name === "events.ndjson") {
      for (const l of blob(sha).split(/\r?\n/)) {
        if (!l.trim()) continue;
        try {
          const ev = JSON.parse(l) as ControlEvent;
          if (isObj(ev) && isStr(ev.kind)) st.events.push(ev);
        } catch {
          /* một dòng nhật ký hỏng không làm hỏng cả sổ */
        }
      }
    }
  }
  st.entries.sort((a, b) => a.mission_id.localeCompare(b.mission_id));
  return st;
}

export type ControlChange = { put: Record<string, string>; del?: string[]; events?: Omit<ControlEvent, "at" | "actor">[]; message: string };

const CONTROL_README = `# Sổ điều phối kỹ thuật (ai-control/registry)

Nhánh này KHÔNG chứa mã. Nó là sổ đăng ký dùng chung của mọi phiên Claude Code làm việc trên kho:
sứ mệnh nào đang giữ vùng nào, số migration nào đã có người lấy, ai đang cầm khoá gộp/deploy.

Ghi bằng \`npm run ai -- claim | heartbeat | close | lease | migration reserve\` — không sửa tay.
Đặc tả: docs/ai-tech-room/delivery-v2.md. Sổ là LỜI KHAI; git/GitHub là SỰ THẬT (\`npm run ai -- board\`).
`;

/**
 * Ghi MỘT commit lên nhánh điều khiển rồi đẩy KHÔNG ÉP. Đỉnh remote đã đổi ⇒ `ControlConflict`
 * (người gọi đọc lại và quyết lại). Đây là chỗ DUY NHẤT công cụ đẩy lên remote.
 */
export function writeControl(ctx: RepoCtx, parent: ControlState, change: ControlChange, actor: string): string {
  const branch = ctx.config.controlBranch;
  if (!CONTROL_BRANCH_RE.test(branch)) throw new Error(`nhánh điều khiển "${branch}" không hợp lệ — từ chối đẩy`);
  const blobs = new Map(parent.blobs);
  const put = (name: string, body: string) => {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`tên tệp sổ "${name}" không hợp lệ`);
    const h = gitIn(ctx.top, ["hash-object", "-w", "--stdin"], body);
    if (h.code !== 0) throw new Error(`hash-object: ${h.err}`);
    blobs.set(name, h.out.trim());
  };
  if (!blobs.has("README.md")) put("README.md", CONTROL_README);
  for (const [name, body] of Object.entries(change.put)) put(name, body);
  for (const name of change.del ?? []) blobs.delete(name);
  if (change.events?.length) {
    const now = new Date().toISOString();
    const old = parent.events.map((e) => JSON.stringify(e));
    const add = change.events.map((e) => JSON.stringify({ at: now, actor, ...e }));
    put("events.ndjson", `${[...old, ...add].slice(-MAX_EVENTS).join("\n")}\n`);
  }
  const mk = gitIn(ctx.top, ["mktree"], [...blobs].map(([name, sha]) => `100644 blob ${sha}\t${name}`).join("\n") + "\n");
  if (mk.code !== 0) throw new Error(`mktree: ${mk.err}`);
  const commit = git(ctx.top, [
    "-c",
    "user.name=ai-control",
    "-c",
    "user.email=ai-control@users.noreply.github.com",
    "commit-tree",
    mk.out.trim(),
    ...(parent.tip ? ["-p", parent.tip] : []),
    "-m",
    `${change.message}\n\nactor: ${actor}`,
  ]);
  pushControlCommit(ctx, commit);
  gitRun(ctx.top, ["update-ref", controlRemoteRef(ctx), commit]);
  return commit;
}

/** Đẩy ĐÚNG một commit lên ĐÚNG nhánh điều khiển — không ép, không refspec `+`, không nhánh nào khác. */
function pushControlCommit(ctx: RepoCtx, commit: string): void {
  if (!SHA_RE.test(commit) || !CONTROL_BRANCH_RE.test(ctx.config.controlBranch)) throw new Error("từ chối đẩy: commit / nhánh điều khiển không hợp lệ");
  const r = gitRun(ctx.top, ["push", "--quiet", "--porcelain", ctx.config.remote, `${commit}:refs/heads/${ctx.config.controlBranch}`]);
  if (r.code === 0) return;
  const msg = `${r.out}\n${r.err}`;
  const tranh = /\[rejected\]|non-fast-forward|fetch first|stale info/i.test(msg) || /cannot lock ref|incorrect old value|failed to update ref/i.test(msg);
  if (tranh && !/repository rule|protected branch|permission|denied/i.test(msg)) throw new ControlConflict(`sổ đã đổi trên remote trong lúc ghi (${r.err.split("\n")[0]})`);
  throw new Error(`không đẩy được sổ điều khiển: ${r.err || r.out}`);
}

/**
 * Đọc–quyết–ghi với thử lại: mỗi vòng đọc ĐỈNH MỚI NHẤT rồi mới quyết, nên quyết định luôn đứng trên
 * sự thật vừa thấy. `decide` trả `change: null` ⇒ không ghi gì (vd khoá đang thuộc người khác).
 */
export function mutateControl<T>(ctx: RepoCtx, actor: string, decide: (st: ControlState) => { change: ControlChange | null; result: T }, attempts = 4): T {
  let last: Error | null = null;
  for (let i = 0; i < attempts; i++) {
    const st = readControl(ctx, { fetch: true });
    if (!st.fetched) throw new Error(`không đọc được sổ trên remote (${st.fetchError ?? "?"}) — không ghi trên một bản có thể đã cũ`);
    const d = decide(st);
    if (!d.change) return d.result;
    try {
      writeControl(ctx, st, d.change, actor);
      return d.result;
    } catch (e) {
      if (!(e instanceof ControlConflict)) throw e;
      last = e;
    }
  }
  throw new Error(`sổ bị ghi tranh liên tục (${attempts} lần) — thử lại sau. ${last?.message ?? ""}`);
}

/**
 * Nhãn của phiên — ổn định qua các lệnh trong cùng một phiên (mỗi lệnh là một tiến trình riêng):
 * máy + tên cây đang đứng. Phiên mới mở lại trong CÙNG cây sau sập = cùng nhãn = nhận lại khoá của
 * chính nó ngay. `AI_LEAD_ID` ghi đè khi một phiên cần nhãn riêng.
 */
export function controlActor(ctx: RepoCtx): string {
  if (ctx.actor && ACTOR_RE.test(ctx.actor)) return ctx.actor;
  const env = (process.env.AI_LEAD_ID ?? "").trim();
  if (env && ACTOR_RE.test(env)) return env;
  const host = hostname().replace(/[^A-Za-z0-9.-]/g, "-").slice(0, 40) || "may";
  return `${host}:${path.basename(ctx.top).replace(/[^A-Za-z0-9._-]/g, "-")}`;
}

/** Đỉnh GitHub dùng chung cho các lệnh mặt phẳng điều khiển (đọc công khai; token chỉ từ env, không in). */
type GhGet = (p: string) => Promise<unknown>;
function githubClient(ctx: RepoCtx, fetchImpl: FetchLike = fetch as unknown as FetchLike): { repo: { owner: string; repo: string }; get: GhGet } | null {
  const repo = parseGithubRemote(gitTry(ctx.top, ["remote", "get-url", ctx.config.remote]) ?? "");
  if (!repo) return null;
  const token = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "").trim() || null;
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "ai-tech-room" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const get: GhGet = async (p) => {
    const url = p.startsWith("https://") ? p : `https://api.github.com/repos/${repo.owner}/${repo.repo}${p}`;
    const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`GitHub ${r.status} ${p.split("?")[0]}`);
    return r.json();
  };
  return { repo, get };
}

const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObj) : []);

/** Trạng thái `gates / gates` của một SHA: success · failure · pending · missing. */
async function gatesOf(get: GhGet, sha: string): Promise<"success" | "failure" | "pending" | "missing"> {
  const c = (await get(`/commits/${sha}/check-runs?per_page=100`)) as { check_runs?: unknown };
  const g = arr(c.check_runs).filter((x) => x.name === "gates / gates");
  if (!g.length) return "missing";
  // Lượt MỚI NHẤT quyết định: một lượt chạy lại đỏ sau lượt xanh cũ là đỏ.
  const t = (x: Record<string, unknown>) => Date.parse(String(x.completed_at ?? x.started_at ?? "")) || 0;
  const latest = [...g].sort((a, b) => t(b) - t(a))[0];
  if (g.some((x) => x.status !== "completed")) return "pending";
  return latest.conclusion === "success" ? "success" : "failure";
}

type OpenPr = { number: number; title: string; branch: string; sha: string; draft: boolean; createdAt: string; body: string };
const toOpenPr = (p: Record<string, unknown>): OpenPr => ({
  number: Number(p.number),
  title: String(p.title ?? ""),
  branch: isObj(p.head) ? String(p.head.ref ?? "") : "",
  sha: isObj(p.head) ? String(p.head.sha ?? "") : "",
  draft: Boolean(p.draft),
  createdAt: String(p.created_at ?? ""),
  body: String(p.body ?? ""),
});
async function openPrs(get: GhGet): Promise<OpenPr[]> {
  const all: OpenPr[] = [];
  for (let page = 1; page <= 10; page++) {
    const xs = arr(await get(`/pulls?state=open&per_page=100&page=${page}`));
    all.push(...xs.map(toOpenPr));
    if (xs.length < 100) break;
  }
  return all;
}
async function prFiles(get: GhGet, n: number): Promise<{ name: string; status: string }[]> {
  const out: { name: string; status: string }[] = [];
  for (let page = 1; page <= 3; page++) {
    const xs = arr(await get(`/pulls/${n}/files?per_page=100&page=${page}`));
    out.push(...xs.map((f) => ({ name: String(f.filename), status: String(f.status) })));
    if (xs.length < 100) break;
  }
  return out;
}

/** SHA đang chạy trên production theo `healthUrl` (null = không đọc được). */
async function productionHealth(ctx: RepoCtx, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<{ health: VerifyInput["health"]; sha: string | null; error?: string }> {
  if (!ctx.config.healthUrl) return { health: null, sha: null, error: "chưa khai healthUrl trong .ai/config.json" };
  try {
    const r = await fetchImpl(ctx.config.healthUrl, { headers: { Accept: "application/json", "User-Agent": "ai-tech-room" }, signal: AbortSignal.timeout(15000) });
    const h = (await r.json()) as VerifyInput["health"];
    const short = h && typeof h.commit === "string" && /^[0-9a-f]{7,40}$/.test(h.commit) ? h.commit : null;
    const full = short ? gitTry(ctx.top, ["rev-parse", "--verify", "--quiet", `${short}^{commit}`]) : null;
    return { health: h, sha: full };
  } catch (e) {
    return { health: null, sha: null, error: (e as Error).message };
  }
}

/** Commit trên `ref` đã mang việc của nhánh vào (để hỏi "nó đã lên production chưa"). */
function landedCommit(ctx: RepoCtx, tip: string, ref: string, ev: MergeEvidence | null, pr: number | null): string | null {
  if (ev === "ANCESTOR") return tip;
  if (pr) {
    const hit = gitTry(ctx.top, ["log", "-n", "1", "--format=%H", "--fixed-strings", `--grep=(#${pr})`, ref]);
    if (hit) return hit;
  }
  return null;
}

/* ═════════════ 13 · LỆNH ═════════════ */

type Args = { _: string[]; flags: Set<string>; values: Map<string, string> };
/** `--cờ` là boolean; `--khoá=giá trị` là tham số có giá trị (mặt phẳng điều khiển, mục 13). */
function parseArgs(argv: readonly string[]): Args {
  const a: Args = { _: [], flags: new Set(), values: new Map() };
  for (const x of argv) {
    const kv = /^--([a-z][a-z0-9-]*)=([\s\S]*)$/.exec(x);
    if (kv) a.values.set(kv[1], kv[2]);
    else if (x.startsWith("--")) a.flags.add(x.slice(2));
    else a._.push(x);
  }
  return a;
}

const short = (s: string | null | undefined) => (s ? s.slice(0, 9) : "—");
const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const out = (s = "") => process.stdout.write(`${s}\n`);

function requireMission(ctx: RepoCtx, id: string | undefined) {
  if (!id) throw new UsageError("thiếu tên sứ mệnh");
  const r = loadMission(ctx, id);
  if (!r.v.mission) {
    throw new Error(`sứ mệnh ${id} không hợp lệ:\n  ${r.v.errors.join("\n  ")}`);
  }
  return { ...r, mission: r.v.mission };
}

class UsageError extends Error {}

function cmdValidate(ctx: RepoCtx, ids: string[]): number {
  let bad = 0;
  for (const e of ctx.configErrors) {
    out(`✗ ${e}`);
    bad++;
  }
  const all = ids.length ? ids : listMissionIds(ctx);
  if (!all.length) out(`không có sứ mệnh nào trong .ai/missions/ — cấu hình ${ctx.configErrors.length ? "LỖI" : "hợp lệ"}`);
  for (const id of all) {
    const { v } = loadMission(ctx, id);
    out(`${v.errors.length ? "✗" : "✓"} ${id}: ${v.errors.length} lỗi, ${v.warnings.length} cảnh báo`);
    for (const e of v.errors) out(`    lỗi: ${e}`);
    for (const w of v.warnings) out(`    cảnh báo: ${w}`);
    if (v.errors.length) bad++;
  }
  return bad ? 1 : 0;
}

function deriveFor(ctx: RepoCtx, m: Mission, wts: readonly WorktreeEntry[]) {
  return deriveMission(m, (t) => gatherTaskFacts(ctx, m, t, wts));
}

async function cmdStatus(ctx: RepoCtx, ids: string[], flags: Set<string>): Promise<number> {
  const wts = listWorktrees(ctx.top);
  const missions = ids.length ? ids : listMissionIds(ctx);
  const json: unknown[] = [];
  const ownerActions: string[] = [];
  const gh = flags.has("github") ? parseGithubRemote(gitTry(ctx.top, ["remote", "get-url", ctx.config.remote]) ?? "") : null;
  const token = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "").trim() || null;
  for (const id of missions) {
    const { mission, v } = requireMission(ctx, id);
    const ref = integrationRefOf(ctx, mission);
    const derived = deriveFor(ctx, mission, wts);
    if (!flags.has("json")) {
      out(`\nSỨ MỆNH ${mission.id} — ${mission.title}`);
      out(`  tích hợp vào ${ref} @ ${short(gitTry(ctx.top, ["rev-parse", "--verify", "--quiet", ref]))}${v.warnings.length ? ` · ${v.warnings.length} cảnh báo (validate)` : ""}`);
    }
    for (const d of derived) {
      let ghNote = "";
      if (gh && d.task.run && ["RUNNING", "REVIEW", "MERGED"].includes(d.status)) {
        const f = await githubFacts(gh, d.task.run.branch, d.facts.tip, fetch as unknown as FetchLike, token);
        if (f.error) ghNote = ` · GitHub: ${f.error}`;
        else {
          const gate = f.checks.find((c) => c.name === "gates / gates" || c.name === "gates");
          ghNote = ` · ${f.pr ? `PR #${f.pr.number} ${f.pr.merged ? "đã merge" : f.pr.state}${f.pr.draft ? " (nháp)" : ""}` : "chưa có PR"}${gate ? ` · gates ${gate.conclusion ?? gate.status}` : ""}`;
        }
      }
      const where = d.task.run ? ` · ${path.basename(d.task.run.worktree)} (${d.task.run.branch})` : "";
      if (!flags.has("json")) out(`  ${pad(d.status, 9)} ${d.task.priority} ${pad(d.task.risk, 8)} ${pad(d.task.id, 26)} ${d.why}${where}${ghNote}`);
      const dec = d.task.decision;
      if (d.status === "BLOCKED" && dec?.state === "BLOCKED" && OWNER_ESCALATIONS.includes(dec.category as (typeof OWNER_ESCALATIONS)[number]))
        ownerActions.push(
          `[${dec.category}] ${mission.id}/${d.task.id}\n    chuyện gì: ${dec.reason}\n    chủ shop cần: ${dec.ownerAction ?? "?"}\n    sau đó: ${dec.resumes ?? "việc tiếp tục tự động"}`,
        );
    }
    json.push({ mission: mission.id, integrationRef: ref, tasks: derived.map((d) => ({ id: d.task.id, status: d.status, why: d.why, facts: d.facts })) });
  }
  if (flags.has("json")) {
    out(JSON.stringify(json, null, 2));
    return 0;
  }
  const running = globalRunningWorkers(ctx, wts);
  out(`\nMÁY: ${wts.length} worktree · ${running.n}/${ctx.config.maxImplementationWorkers} worker đang chạy${running.who.length ? ` (${running.who.join(", ")})` : ""} · \`npm run ai -- worktrees\` để phân loại cả máy`);
  out(`\nVIỆC CHỦ SHOP CẦN LÀM (${ownerActions.length})`);
  out(ownerActions.length ? ownerActions.map((x) => `  ${x}`).join("\n") : "  không có — mọi việc đang chặn (nếu có) đều tự giải được");
  return 0;
}

function cmdNext(ctx: RepoCtx, id: string | undefined): number {
  const { mission } = requireMission(ctx, id);
  const wts = listWorktrees(ctx.top);
  const derived = deriveFor(ctx, mission, wts);
  const g = globalRunningWorkers(ctx, wts);
  const plan = planNext(derived, mission, ctx.config, g.n);
  out(`LƯỢT KẾ TIẾP — ${mission.id} (còn ${plan.capacity} chỗ worker)`);
  for (const l of plan.launch) out(`  DỰNG CÂY  ${pad(l.id, 26)} ${l.note}\n            npm run ai -- spawn ${mission.id} ${l.id}`);
  for (const l of plan.inline) out(`  LEAD LÀM  ${pad(l.id, 26)} ${l.note}`);
  for (const h of plan.hold) out(`  NẰM LẠI   ${pad(h.id, 26)} ${h.reason}`);
  if (!plan.launch.length && !plan.inline.length) {
    const live = derived.filter((d) => ["RUNNING", "REVIEW", "ORPHANED"].includes(d.status));
    out(live.length ? `  không có việc mới — theo dõi: ${live.map((d) => `${d.task.id}(${d.status})`).join(", ")}` : "  không có việc nào sẵn sàng.");
  }
  return 0;
}

function manifestFor(ctx: RepoCtx, m: Mission, t: Task, run: TaskRun): Manifest {
  // Chỉ phần KẾ HOẠCH đi vào phiếu: quyết định / PR / deploy là việc của Lead, worker không cần và không được sửa.
  const task: Manifest["task"] = {
    id: t.id,
    slug: t.slug,
    title: t.title,
    objective: t.objective,
    mode: t.mode,
    priority: t.priority,
    risk: t.risk,
    dependsOn: t.dependsOn,
    base: t.base,
    owns: t.owns,
    readOnly: t.readOnly,
    doNotTouch: t.doNotTouch,
    tests: t.tests,
    definitionOfDone: t.definitionOfDone,
    expectedOutput: t.expectedOutput,
    integrationNotes: t.integrationNotes,
  };
  return {
    schema: 1,
    mission: { id: m.id, title: m.title, goal: m.goal },
    task,
    branch: run.branch,
    worktree: run.worktree,
    baseRef: run.baseRef,
    baseSha: run.baseSha,
    integrationRef: integrationRefOf(ctx, m),
    createdAt: run.createdAt,
    leadWorktree: ctx.top,
  };
}

function cmdSpawn(ctx: RepoCtx, id: string | undefined, taskId: string | undefined, flags: Set<string>): number {
  const { mission, file, raw } = requireMission(ctx, id);
  if (!taskId) throw new UsageError("thiếu id việc");
  const t = mission.tasks.find((x) => x.id === taskId);
  if (!t) throw new Error(`không có việc ${taskId} trong ${mission.id}`);
  if (t.mode !== "WORKER") throw new Error(`${t.id} là việc INLINE — Lead làm trực tiếp trong cây của mình, không dựng cây riêng`);
  const dry = flags.has("dry-run");
  const wts = listWorktrees(ctx.top);
  const derived = deriveFor(ctx, mission, wts);
  const me = derived.find((d) => d.task.id === t.id) as DerivedTask;

  // Đã dựng rồi và cây còn nguyên ⇒ chỉ ghi lại phiếu (phục hồi sau sập máy), không dựng lần hai.
  if (t.run && me.facts.worktreeExists) {
    const mf = manifestFor(ctx, mission, t, t.run);
    if (!dry) writeManifest(t.run.worktree, mf);
    out(`${t.id} đã có cây ${t.run.worktree} (${me.status}) — ${dry ? "sẽ ghi lại" : "đã ghi lại"} phiếu giao việc, không dựng lại.`);
    return 0;
  }
  if (me.status !== "READY") throw new Error(`${t.id} đang ${me.status} (${me.why}) — chỉ dựng cây cho việc READY`);

  const remote = ctx.config.remote;
  if (!flags.has("offline")) {
    const f = gitRun(ctx.top, ["fetch", "--quiet", remote]);
    if (f.code !== 0) throw new Error(`fetch ${remote} thất bại (${f.err}) — không dựng cây trên một gốc có thể đã cũ. Thêm --offline nếu chấp nhận gốc hiện có.`);
  }
  let baseRef = integrationRefOf(ctx, mission);
  if (t.base && t.base !== "integration") {
    const dep = derived.find((d) => d.task.id === t.base);
    if (!dep?.task.run || !dep.facts.remoteBranch) throw new Error(`${t.id} dựng chồng lên ${t.base} nhưng nhánh của ${t.base} chưa có trên remote`);
    baseRef = `${remote}/${dep.task.run.branch}`;
  }
  const baseSha = gitTry(ctx.top, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);
  if (!baseSha) throw new Error(`không phân giải được gốc ${baseRef}`);

  const branch = branchFor(ctx.config, t);
  const wtPath = worktreeFor(ctx, t);
  const problems = worktreeCollisions(ctx, wts, branch, wtPath);
  if (problems.length)
    throw new Error(`không dựng được ${t.id}:\n  ${problems.join("\n  ")}\n  ⇒ đặt "slug" khác cho việc trong tệp sứ mệnh (tên phải là của RIÊNG việc này), không đè lên thứ đang có`);

  const g = globalRunningWorkers(ctx, wts);
  const plan = planNext(derived, mission, ctx.config, g.n);
  const held = plan.hold.find((h) => h.id === t.id);
  if (held && !flags.has("ignore-capacity")) throw new Error(`bộ xếp lịch giữ ${t.id} lại: ${held.reason}\n  (--ignore-capacity chỉ dành cho hotfix sự cố production — xem docs/ai-tech-room/README.md mục 9)`);

  const run: TaskRun = { branch, worktree: wtPath, baseRef, baseSha, createdAt: new Date().toISOString() };
  out(`${dry ? "[CHẠY THỬ] " : ""}dựng cây cho ${mission.id}/${t.id}`);
  out(`  git worktree add -b ${branch} ${wtPath} ${baseSha.slice(0, 12)}   (gốc ${baseRef})`);
  out(`  phiếu giao việc → <git-dir của cây>/${MANIFEST_FILE} + ai-tech-brief.md`);
  out(`  ghi run vào ${path.basename(file)}`);
  if (dry) return 0;

  git(ctx.top, ["worktree", "add", "--no-track", "-b", branch, wtPath, baseSha]);
  const manifestPath = writeManifest(wtPath, manifestFor(ctx, mission, t, run));
  const tasks = raw.tasks as Record<string, unknown>[];
  const rawTask = tasks.find((x) => x.id === t.id);
  if (rawTask) rawTask.run = run;
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
  out(`✓ cây sẵn sàng: ${wtPath}`);
  out(`  phiếu: ${manifestPath}`);
  out(`  worker bắt đầu bằng: cd "${wtPath}" && npm ci && npm run ai -- whoami`);
  return 0;
}

/** Mọi lý do KHÔNG được dựng một nhánh + cây mới ở đây. Rỗng = an toàn. */
function worktreeCollisions(ctx: RepoCtx, wts: readonly WorktreeEntry[], branch: string, wtPath: string): string[] {
  const remote = ctx.config.remote;
  const problems: string[] = [];
  if (gitTry(ctx.top, ["check-ref-format", "--branch", branch]) === null) problems.push(`tên nhánh ${branch} không hợp lệ`);
  if (gitTry(ctx.top, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) problems.push(`nhánh ${branch} đã tồn tại ở máy này`);
  if (gitTry(ctx.top, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`])) problems.push(`nhánh ${remote}/${branch} đã tồn tại`);
  const reg = wts.find((w) => samePath(w.path, wtPath));
  if (reg) problems.push(`worktree ${wtPath} đã được đăng ký (nhánh ${reg.branch ?? "tách rời"})`);
  else if (existsSync(wtPath)) problems.push(`thư mục ${wtPath} đã tồn tại`);
  return problems;
}

/**
 * ĐIỂM VÀO của một sứ mệnh mới: dựng cây + nhánh RIÊNG cho Lead từ nhánh tích hợp VỪA FETCH, khai
 * khung tệp sứ mệnh trong cây đó, ghi phiếu vai LEAD.
 *
 * Gọi được từ BẤT KỲ checkout nào của kho — kể cả cây chính dùng chung đang ở commit cũ và còn
 * việc dở của phiên khác — vì nó KHÔNG ghi gì vào checkout đang đứng: chỉ fetch, thêm một
 * worktree cạnh đó, và ghi vào cây mới. Checkout cũ chưa có tệp này thì chạy bản trên main:
 *   git show origin/main:scripts/ai-tech.ts > <thư-mục-tạm>/ai-tech.ts && node <thư-mục-tạm>/ai-tech.ts lead <id>
 */
function cmdLead(ctxIn: RepoCtx, id: string | undefined, titleWords: string[], flags: Set<string>): number {
  let ctx = ctxIn;
  if (!id || !SLUG_RE.test(id))
    throw new UsageError(`tên sứ mệnh phải khớp ${SLUG_RE} (thành nhánh ${ctx.config.branchPrefix}<tên> và cây ../${ctx.config.worktreePrefix}<tên>)`);
  const dry = flags.has("dry-run");
  if (!flags.has("offline")) {
    const f = gitRun(ctx.top, ["fetch", "--quiet", ctx.config.remote]);
    if (f.code !== 0) throw new Error(`fetch ${ctx.config.remote} thất bại (${f.err}) — không dựng cây Lead trên một gốc có thể đã cũ`);
  } else out("! --offline: KHÔNG fetch — cây Lead dựng trên origin/main đang có ở máy này, có thể đã cũ");
  // Cấu hình lấy từ CHÍNH gốc sẽ dựng (origin/main vừa fetch), không từ checkout đang đứng — checkout
  // ấy có thể cũ hoặc chưa có .ai/config.json (reviewer 06/10/2026).
  const baseCfgRaw = gitTry(ctx.top, ["show", `${ctx.config.integrationRef}:.ai/config.json`]);
  if (baseCfgRaw) {
    try {
      const parsed = parseConfig(JSON.parse(baseCfgRaw));
      if (!parsed.errors.length) ctx = { ...ctx, config: parsed.config };
    } catch {
      /* cấu hình trên gốc hỏng — dùng cấu hình hiện có, `validate` sẽ báo */
    }
  }
  const ref = ctx.config.integrationRef;
  const baseSha = gitTry(ctx.top, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (!baseSha) throw new Error(`không phân giải được ${ref}`);
  const branch = `${ctx.config.branchPrefix}${id}`;
  const wtPath = path.join(ctx.worktreeParent, `${ctx.config.worktreePrefix}${id}`);
  const problems = worktreeCollisions(ctx, listWorktrees(ctx.top), branch, wtPath);
  if (problems.length)
    throw new Error(`không dựng được cây Lead cho ${id}:\n  ${problems.join("\n  ")}\n  ⇒ chọn tên sứ mệnh khác; nếu đây là sứ mệnh đang chạy thì mở phiên trong cây đã có`);
  const existing = gitRun(ctx.top, ["cat-file", "-e", `${baseSha}:.ai/missions/${id}.json`]).code === 0;
  out(`${dry ? "[CHẠY THỬ] " : ""}dựng cây Lead cho sứ mệnh ${id}`);
  out(`  git worktree add -b ${branch} ${wtPath} ${baseSha.slice(0, 12)}   (gốc ${ref} vừa fetch)`);
  out(`  ${existing ? `.ai/missions/${id}.json đã có trên ${ref} — giữ nguyên` : `khung .ai/missions/${id}.json trong cây mới`}`);
  if (dry) return 0;
  git(ctx.top, ["worktree", "add", "--no-track", "-b", branch, wtPath, baseSha]);
  const title = titleWords.join(" ").trim() || id;
  if (!existing) {
    const missionFile = path.join(wtPath, ".ai", "missions", `${id}.json`);
    mkdirSync(path.dirname(missionFile), { recursive: true });
    writeFileSync(missionFile, `${JSON.stringify(missionScaffold(id, title), null, 2)}\n`);
  }
  writeManifest(wtPath, {
    schema: 1,
    role: "LEAD",
    mission: { id, title, goal: "(xem tệp sứ mệnh)" },
    task: {
      id: "lead",
      title: `Lead của sứ mệnh ${id}`,
      objective: title,
      mode: "INLINE",
      priority: "P1",
      risk: "LOW",
      dependsOn: [],
      owns: [`.ai/missions/${id}.json`],
      readOnly: [],
      doNotTouch: [],
      tests: [],
      definitionOfDone: ["Mọi việc của sứ mệnh MERGED/DONE, cây worker đã dọn"],
    },
    branch,
    worktree: wtPath,
    baseRef: ref,
    baseSha,
    integrationRef: ref,
    createdAt: new Date().toISOString(),
    leadWorktree: wtPath,
  });
  out(`✓ cây Lead: ${wtPath}`);
  out(`  tiếp theo, trong cây đó: npm ci → sửa .ai/missions/${id}.json → npm run ai -- validate ${id} → npm run ai -- next ${id}`);
  out(`  Claude Code: mở phiên trong cây đó rồi gõ /mission — hoặc giữ phiên hiện tại và chạy mọi lệnh bằng cd "${wtPath}" && …`);
  return 0;
}

function renderLeadBrief(m: Manifest): string {
  return `# CÂY LEAD — sứ mệnh ${m.mission.id}

${m.mission.title}

- Cây: \`${m.worktree}\` · nhánh \`${m.branch}\` (gốc \`${m.baseRef}\` @ \`${m.baseSha.slice(0, 12)}\`)
- Tệp sứ mệnh: \`.ai/missions/${m.mission.id}.json\` — kế hoạch của bạn; commit + đẩy mỗi lần đổi.
- Quy trình: \`docs/ai-tech-room/README.md\` mục «Giao một sứ mệnh» và mục 6 (vòng lặp Lead); skill \`/mission\`.

Bắt đầu: \`npm run ai -- status ${m.mission.id}\` rồi \`npm run ai -- next ${m.mission.id}\`.
`;
}

function cmdBrief(ctx: RepoCtx, id: string | undefined, taskId: string | undefined): number {
  const { mission } = requireMission(ctx, id);
  const t = mission.tasks.find((x) => x.id === taskId);
  if (!t) throw new Error(`không có việc ${taskId ?? "?"}`);
  const run: TaskRun = t.run ?? {
    branch: branchFor(ctx.config, t),
    worktree: worktreeFor(ctx, t),
    baseRef: integrationRefOf(ctx, mission),
    baseSha: gitTry(ctx.top, ["rev-parse", "--verify", "--quiet", integrationRefOf(ctx, mission)]) ?? "(chưa dựng)",
    createdAt: "(chưa dựng)",
  };
  process.stdout.write(renderBrief(manifestFor(ctx, mission, t, run)));
  return 0;
}

function cmdWhoami(ctx: RepoCtx): number {
  const m = readManifest(ctx.top);
  if (!m) {
    out("cây này không có phiếu giao việc của AI Tech Room — làm việc như một nhánh thường (AGENTS.md mục 9).");
    return 0;
  }
  process.stdout.write(m.role === "LEAD" ? renderLeadBrief(m) : renderBrief(m));
  return 0;
}

function cmdReconcile(ctx: RepoCtx, id: string | undefined, flags: Set<string>): number {
  const { mission } = requireMission(ctx, id);
  if (!flags.has("offline")) gitRun(ctx.top, ["fetch", "--quiet", ctx.config.remote]);
  const ref = integrationRefOf(ctx, mission);
  const wts = listWorktrees(ctx.top);
  const derived = deriveFor(ctx, mission, wts).filter((d) => ["RUNNING", "REVIEW", "ORPHANED"].includes(d.status));
  out(`ĐỐI CHIẾU với ${ref} @ ${short(gitTry(ctx.top, ["rev-parse", "--verify", "--quiet", ref]))}`);
  if (!derived.length) out("  không có việc nào đang mở nhánh.");
  for (const d of derived) {
    const tip = d.facts.tip;
    if (!tip || !d.task.run) continue;
    const mb = gitTry(ctx.top, ["merge-base", tip, ref]);
    const files = (a: string, b: string) => (gitTry(ctx.top, ["diff", "--name-only", "--no-renames", a, b]) ?? "").split(/\r?\n/).filter(Boolean);
    const up = mb ? files(mb, ref) : [];
    const mine = mb ? files(mb, tip) : [];
    const mt = gitRun(ctx.top, ["merge-tree", "--write-tree", "--name-only", "--no-messages", ref, tip]);
    const conflicts = mt.code === 1 ? mt.out.split(/\r?\n/).slice(1).filter(Boolean) : mt.code === 0 ? [] : null;
    const r = reconcileVerdict({ behind: d.facts.behind, upstreamFiles: up, branchFiles: mine, conflictFiles: conflicts, task: d.task }, ctx.config);
    out(`  ${pad(r.verdict, 17)} ${pad(d.task.id, 26)} sau ${d.facts.behind} commit → ${r.action}`);
    for (const x of r.details.slice(0, 8)) out(`      ${x}`);
  }
  return 0;
}

function cmdReady(ctx: RepoCtx, id: string | undefined, taskId: string | undefined): number {
  const { mission } = requireMission(ctx, id);
  const t = mission.tasks.find((x) => x.id === taskId);
  if (!t?.run) throw new Error(`việc ${taskId ?? "?"} chưa có lượt chạy`);
  gitRun(ctx.top, ["fetch", "--quiet", ctx.config.remote]);
  const wts = listWorktrees(ctx.top);
  const f = gatherTaskFacts(ctx, mission, t, wts);
  const ref = integrationRefOf(ctx, mission);
  const checks: { ok: boolean; label: string; fix?: string }[] = [];
  const tip = f.tip;
  // merge-base..tip, KHÔNG baseSha..tip: worker đã merge main vào thì baseSha..tip gồm cả mọi tệp
  // main đổi, và chính lời khuyên "git merge main" của lệnh này làm nó đỏ mãi (reviewer 05/10/2026).
  const mbReady = tip ? gitTry(ctx.top, ["merge-base", tip, ref]) : null;
  const changed = tip && mbReady ? lines(gitTry(ctx.top, ["diff", "--name-only", "--no-renames", mbReady, tip])) : [];
  checks.push({ ok: f.dirty === 0, label: `cây sạch (${f.dirty} thay đổi)`, fix: "commit hoặc bỏ thay đổi trong cây của việc" });
  checks.push({ ok: f.commits > 0, label: `${f.commits} commit của việc` });
  checks.push({ ok: f.pushed, label: "nhánh trên remote khớp cục bộ", fix: `git push -u ${ctx.config.remote} ${t.run.branch}` });
  checks.push({ ok: f.behind === 0, label: `cập nhật với ${ref} (sau ${f.behind})`, fix: `trong cây của việc: git merge ${ref} → chạy lại kiểm thử → push (ruleset strict đòi PR cập nhật với main)` });
  const outside = changed.filter((c) => !t.owns.some((p) => fileInPattern(c, p)));
  checks.push({ ok: outside.length === 0, label: `mọi tệp đổi nằm trong owns${outside.length ? `: NGOÀI PHẠM VI ${outside.slice(0, 10).join(", ")}` : ""}`, fix: "Lead quyết: mở rộng owns có chủ đích, tách việc mới, hoặc bỏ thay đổi" });
  const forbidden = changed.filter((c) => t.doNotTouch.some((p) => fileInPattern(c, p)) || c.startsWith(".ai/"));
  checks.push({ ok: forbidden.length === 0, label: `không chạm doNotTouch${forbidden.length ? `: ${forbidden.join(", ")}` : ""}` });
  if (tip) {
    const mt = gitRun(ctx.top, ["merge-tree", "--write-tree", "--name-only", "--no-messages", ref, tip]);
    checks.push({ ok: mt.code === 0, label: mt.code === 0 ? "không xung đột với nhánh tích hợp" : `xung đột: ${mt.out.split(/\r?\n/).slice(1).join(", ") || mt.err}` });
  }
  const hot = ctx.config.hotspots.filter((h) => changed.some((c) => fileInPattern(c, h.path)));
  out(`SẴN SÀNG PR? ${mission.id}/${t.id} (${t.run.branch})`);
  for (const c of checks) out(`  ${c.ok ? "✓" : "✗"} ${c.label}${!c.ok && c.fix ? `\n      → ${c.fix}` : ""}`);
  for (const h of hot) out(`  ! chạm điểm nóng ${h.path} (${h.rule}) — ${h.reason}`);
  if (riskRank(t.risk) >= riskRank("HIGH")) out(`  ! rủi ro ${t.risk}: cần một lượt review riêng (bối cảnh mới) trước khi mở PR`);
  const ok = checks.every((c) => c.ok);
  if (ok) {
    const gh = parseGithubRemote(gitTry(ctx.top, ["remote", "get-url", ctx.config.remote]) ?? "");
    const base = ref.replace(new RegExp(`^${ctx.config.remote}/`), "");
    out(`\nMỞ PR (một bước của người hoặc cầu nối agent-open-pr):`);
    if (gh) out(`  https://github.com/${gh.owner}/${gh.repo}/compare/${base}...${t.run.branch}?expand=1`);
    out(`  tiêu đề: ${t.title}`);
    out(`  thân: mục tiêu + định nghĩa xong + kiểm thử đã chạy — cổng bắt buộc: gates / gates`);
  }
  return ok ? 0 : 1;
}

function cmdWorktrees(ctx: RepoCtx, flags: Set<string>): number {
  const now = Date.now();
  const facts = listWorktrees(ctx.top)
    .filter((w) => !w.bare)
    .map((e) => gatherWorktreeFacts(ctx, e, now));
  const rows = facts.map((f) => ({ f, c: classifyWorktree(f, ctx.config) }));
  if (flags.has("json")) {
    out(JSON.stringify(rows.map((r) => ({ ...r.f, class: r.c.cls, note: r.c.note })), null, 2));
    return 0;
  }
  const by = new Map<WorktreeClass, number>();
  for (const r of rows) by.set(r.c.cls, (by.get(r.c.cls) ?? 0) + 1);
  out(`WORKTREE TRÊN MÁY: ${rows.length} — ${WORKTREE_CLASSES.filter((k) => by.get(k)).map((k) => `${k} ${by.get(k)}`).join(" · ")}`);
  const order = (c: WorktreeClass) => WORKTREE_CLASSES.indexOf(c);
  for (const r of rows.sort((a, b) => order(a.c.cls) - order(b.c.cls) || a.f.path.localeCompare(b.f.path))) {
    if (!flags.has("all") && r.c.cls === "MERGED_SAFE_TO_CLEAN" && !r.f.owner) continue;
    const who = r.f.owner ? `${r.f.owner.mission}/${r.f.owner.task}` : "chủ: không rõ";
    out(`  ${pad(r.c.cls, 20)} ${pad(path.basename(r.f.path), 30)} ${pad(r.f.branch ?? (r.f.detached ? "(tách rời)" : "—"), 40)} ${who} · ${r.c.note}`);
  }
  const hidden = rows.filter((r) => r.c.cls === "MERGED_SAFE_TO_CLEAN" && !r.f.owner).length;
  if (hidden && !flags.has("all")) out(`  (+${hidden} cây không rõ chủ đã vào main — --all để liệt kê; dọn chúng cần chủ shop cho phép: cleanup --allow-unowned)`);
  return 0;
}

function cmdCleanup(ctx: RepoCtx, targets: string[], flags: Set<string>): number {
  if (!targets.length) throw new UsageError("thiếu đích: <đường-dẫn-cây> | <sứ-mệnh>:<việc> | --merged");
  const apply = flags.has("apply");
  const now = Date.now();
  const wts = listWorktrees(ctx.top).filter((w) => !w.bare);
  const chosen: WorktreeEntry[] = [];
  for (const t of targets) {
    if (t === "merged") {
      for (const w of wts) {
        const m = readManifest(w.path);
        if (m && m.role !== "LEAD") chosen.push(w);
      }
      continue;
    }
    const m = /^([a-z0-9-]+):([a-z0-9-]+)$/.exec(t);
    if (m) {
      const { mission } = requireMission(ctx, m[1]);
      const task = mission.tasks.find((x) => x.id === m[2]);
      const w = task?.run ? wts.find((x) => samePath(x.path, task.run?.worktree ?? "") && x.branch === task.run?.branch) : undefined;
      if (!w) throw new Error(`${t}: không thấy cây của việc này`);
      chosen.push(w);
      continue;
    }
    const w = wts.find((x) => samePath(x.path, t));
    if (!w) throw new Error(`${t}: không phải một worktree đã đăng ký`);
    chosen.push(w);
  }
  let refused = 0;
  out(apply ? "DỌN CÂY" : "DỌN CÂY [CHẠY THỬ — thêm --apply để làm thật]");
  for (const w of chosen) {
    const f = gatherWorktreeFacts(ctx, w, now);
    const d = cleanupDecision(f, ctx.config, { allowUnowned: flags.has("allow-unowned"), allowLead: flags.has("lead") && !targets.includes("merged") });
    if (!d.ok) {
      refused++;
      out(`  ✗ ${w.path}\n      ${d.refusals.join("\n      ")}`);
      continue;
    }
    out(`  ✓ ${w.path} — git worktree remove${d.deleteBranch ? ` · git update-ref -d refs/heads/${f.branch} ${short(f.head)}` : ""}`);
    if (!apply) continue;
    // Không --force: git tự từ chối nếu cây bẩn — lớp an toàn thứ hai, phòng khi trạng thái đổi giữa lúc đo và lúc làm.
    const rm = gitRun(ctx.top, ["worktree", "remove", w.path]);
    if (rm.code !== 0) {
      refused++;
      out(`      git từ chối: ${rm.err}`);
      continue;
    }
    if (d.deleteBranch && f.branch) {
      // Xoá có SO SÁNH: chỉ xoá nếu nhánh vẫn đứng ĐÚNG ở SHA đã đo. Worker commit thêm giữa lúc đo
      // và lúc xoá (cây vẫn sạch nên `worktree remove` cho qua) thì lệnh này từ chối, commit còn nguyên.
      const br = f.head ? gitRun(ctx.top, ["update-ref", "-d", `refs/heads/${f.branch}`, f.head]) : { code: 1, out: "", err: "không có SHA đã đo" };
      out(br.code === 0 ? `      đã xoá nhánh cục bộ ${f.branch} (nhánh trên remote GIỮ NGUYÊN)` : `      giữ nhánh ${f.branch}: ${br.err}`);
    }
    if (f.owner) markCleaned(ctx, f.owner.mission, f.owner.task, f);
  }
  return refused ? 1 : 0;
}

/** Ghi dấu dọn + bằng chứng merge ĐÃ ĐO vào tệp sứ mệnh của cây hiện tại (nếu sứ mệnh nằm ở đây). */
function markCleaned(ctx: RepoCtx, missionId: string, taskId: string, f: WorktreeFacts) {
  const file = path.join(missionsDir(ctx), `${missionId}.json`);
  if (!existsSync(file)) return;
  const raw = JSON.parse(readFileSync(file, "utf8")) as { tasks?: { id?: string; run?: Record<string, unknown> }[] };
  const t = raw.tasks?.find((x) => x.id === taskId);
  if (!t?.run || typeof t.run.worktree !== "string" || !samePath(t.run.worktree, f.path) || t.run.branch !== f.branch) return;
  t.run.cleanedAt = new Date().toISOString();
  if (f.head) t.run.mergedTip = f.head;
  if (f.merged && f.merged !== "EMPTY") t.run.mergedEvidence = f.merged;
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
}

export function missionScaffold(id: string, title: string) {
  return {
    schema: 1,
    id,
    title,
    goal: "Kết quả nghiệp vụ / kỹ thuật mà sứ mệnh này phải đạt — một câu đo được.",
    tasks: [
      {
        id: "vi-du",
        title: "Việc đầu tiên",
        objective: "Làm gì, vì sao, ra cái gì.",
        mode: "WORKER",
        priority: "P1",
        risk: "LOW",
        dependsOn: [],
        owns: ["docs/vi-du.md"],
        readOnly: [],
        doNotTouch: [],
        tests: ["npm run typecheck"],
        definitionOfDone: ["Kiểm thử của phiếu xanh", "Đã đẩy nhánh"],
      },
    ],
  };
}

function cmdNew(ctx: RepoCtx, id: string | undefined, title: string[]): number {
  if (!id || !SLUG_RE.test(id)) throw new UsageError(`tên sứ mệnh phải khớp ${SLUG_RE}`);
  const file = path.join(missionsDir(ctx), `${id}.json`);
  if (existsSync(file)) throw new Error(`${file} đã có`);
  const m = missionScaffold(id, title.join(" ") || id);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
  out(`✓ ${file}\n  sửa tasks rồi: npm run ai -- validate ${id}`);
  return 0;
}

/* ── Lệnh của mặt phẳng điều khiển (mục 12) ── */

const csv = (v: string | undefined): string[] =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const vnTime = (ms: number) => new Date(ms).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour12: false });
const ageText = (iso: string, nowMs: number) => {
  const h = (nowMs - Date.parse(iso)) / 3_600_000;
  if (!Number.isFinite(h)) return "?";
  return h < 1 ? `${Math.max(0, Math.round(h * 60))}′` : h < 48 ? `${h.toFixed(1)}h` : `${Math.round(h / 24)} ngày`;
};
const median = (xs: readonly number[]): number | null => quantile(xs, 0.5);
export function quantile(xs: readonly number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const k = (s.length - 1) * p;
  const f = Math.floor(k);
  const c = Math.min(f + 1, s.length - 1);
  return s[f] + (s[c] - s[f]) * (k - f);
}

const mustMission = (id: string | undefined): string => {
  if (!id || !SLUG_RE.test(id)) throw new UsageError(`mã sứ mệnh phải khớp ${SLUG_RE}`);
  return id;
};
const entryFile = (id: string) => `mission.${id}.json`;
const entryJson = (e: RegistryEntry) => `${JSON.stringify(e, null, 2)}\n`;

async function entryFacts(
  ctx: RepoCtx,
  e: RegistryEntry,
  all: readonly RegistryEntry[],
  o: { get: GhGet | null; prs: readonly OpenPr[]; prodSha: string | null; ref: string },
): Promise<EntryFacts> {
  const facts: EntryFacts = { branch: null, merged: null, pr: null, inProduction: null, touched: null, openDependencies: [] };
  facts.openDependencies = e.dependencies.filter((d) => {
    const x = all.find((y) => y.mission_id === d);
    return !x || !CLOSED_STATES.has(x.status);
  });
  const lastPr = e.related_prs.length ? e.related_prs[e.related_prs.length - 1] : null;
  if (e.branch && REF_RE.test(e.branch) && !gitRefLooksUnsafe(e.branch)) {
    const local = gitTry(ctx.top, ["rev-parse", "--verify", "--quiet", `refs/heads/${e.branch}`]);
    const remote = gitTry(ctx.top, ["rev-parse", "--verify", "--quiet", `refs/remotes/${ctx.config.remote}/${e.branch}`]);
    const tip = local ?? remote;
    facts.branch = { local: local !== null, remote: remote !== null, tip };
    if (tip) {
      facts.merged = mergeEvidence(ctx.top, tip, o.ref, { pr: lastPr ?? undefined, baseSha: e.base_sha ?? undefined });
      if (facts.merged === null) {
        const mb = gitTry(ctx.top, ["merge-base", tip, o.ref]);
        facts.touched = mb ? lines(gitTry(ctx.top, ["diff", "--name-only", "--no-renames", mb, tip])) : null;
      }
      if (facts.merged && facts.merged !== "EMPTY" && o.prodSha) {
        const lc = landedCommit(ctx, tip, o.ref, facts.merged, lastPr);
        facts.inProduction = lc ? gitRun(ctx.top, ["merge-base", "--is-ancestor", lc, o.prodSha]).code === 0 : null;
      }
    }
    const p = o.prs.find((x) => x.branch === e.branch);
    if (p && o.get) facts.pr = { number: p.number, state: "open", merged: false, gates: await gatesOf(o.get, p.sha).catch(() => null) };
  }
  if (!facts.pr && lastPr && o.get && (facts.merged === null || facts.merged === "EMPTY")) {
    try {
      const p = (await o.get(`/pulls/${lastPr}`)) as Record<string, unknown>;
      facts.pr = { number: lastPr, state: String(p.state), merged: Boolean(p.merged_at), gates: null };
      if (facts.pr.merged && o.prodSha) {
        const lc = gitTry(ctx.top, ["log", "-n", "1", "--format=%H", "--fixed-strings", `--grep=(#${lastPr})`, o.ref]);
        facts.inProduction = lc ? gitRun(ctx.top, ["merge-base", "--is-ancestor", lc, o.prodSha]).code === 0 : null;
      }
    } catch {
      /* GitHub không trả lời — để null, không đoán */
    }
  }
  return facts;
}

async function cmdBoard(ctx: RepoCtx, flags: Set<string>): Promise<number> {
  const nowMs = Date.now();
  const offline = flags.has("offline");
  if (!offline) gitRun(ctx.top, ["fetch", "--quiet", ctx.config.remote]);
  const st = readControl(ctx, { fetch: !offline });
  const ref = ctx.config.integrationRef;
  const mainSha = gitTry(ctx.top, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const gh = flags.has("github") ? githubClient(ctx) : null;
  const prod = offline ? { health: null, sha: null, error: "--offline" } : await productionHealth(ctx);
  let prs: OpenPr[] = [];
  let ghError = "";
  if (gh)
    try {
      prs = await openPrs(gh.get);
    } catch (e) {
      ghError = (e as Error).message;
    }
  const rows: { e: RegistryEntry; effective: MissionState; drift: string[] }[] = [];
  const all: { e: RegistryEntry; f: EntryFacts }[] = [];
  for (const e of st.entries) all.push({ e, f: await entryFacts(ctx, e, st.entries, { get: gh?.get ?? null, prs, prodSha: prod.sha, ref }) });
  // Phụ thuộc đã VÀO MAIN là xong cho bên chờ nó — kể cả khi chủ của nó chưa kịp `close` (việc của
  // bên sau là đứng trên mã đã tích hợp, không phải đợi một dòng sổ).
  const landed = new Set(all.filter(({ f }) => (f.merged !== null && f.merged !== "EMPTY") || Boolean(f.pr?.merged)).map(({ e }) => e.mission_id));
  for (const { e, f } of all) {
    f.openDependencies = f.openDependencies.filter((d) => !landed.has(d));
    rows.push({ e, ...reconcileEntry(e, f, ctx.config, nowMs) });
  }
  const leases = LEASE_NAMES.map((n) => {
    const l = st.leases.find((x) => x.name === n) ?? null;
    return { name: n, lease: l, live: l !== null && Date.parse(l.expires_at) > nowMs };
  });
  const known = new Set(st.entries.flatMap((e) => [e.branch ?? "", ...e.related_prs.map(String)]));
  const strays = prs.filter((p) => !known.has(p.branch) && !known.has(String(p.number)));
  const undeployed = prod.sha && mainSha && prod.sha !== mainSha ? countRange(ctx.top, [`${prod.sha}..${mainSha}`]) : 0;
  const owner = rows.filter((r) => r.e.needs_owner && !CLOSED_STATES.has(r.effective));
  if (flags.has("json")) {
    out(
      JSON.stringify(
        {
          at: new Date(nowMs).toISOString(),
          main: mainSha,
          production: prod.sha,
          undeployedCommits: undeployed,
          registryTip: st.tip,
          registryReadable: st.fetched || offline,
          missions: rows.map((r) => ({ id: r.e.mission_id, declared: r.e.status, effective: r.effective, drift: r.drift, priority: r.e.priority, risk: r.e.risk, branch: r.e.branch, owner: r.e.owner })),
          leases: leases.map((l) => ({ name: l.name, holder: l.live ? l.lease?.holder : null, expires: l.live ? l.lease?.expires_at : null })),
          strayPrs: strays.map((p) => p.number),
          needsOwner: owner.map((r) => ({ mission: r.e.mission_id, ...r.e.needs_owner })),
          invalid: st.invalid,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  out(`BẢNG ĐIỀU KHIỂN · ${vnTime(nowMs)} (giờ VN)`);
  if (!st.fetched && !offline) out(`  ! không đọc được sổ trên remote (${st.fetchError ?? "?"}) — đang in bản ở máy này, có thể cũ`);
  const prodTxt = prod.sha ? (prod.sha === mainSha ? `production ${short(prod.sha)} ✓ khớp main` : `production ${short(prod.sha)} — main đi trước ${undeployed} commit CHƯA DEPLOY`) : `production ? (${prod.error ?? "không đọc được"})`;
  out(`  main ${short(mainSha)} · ${prodTxt}`);
  const count = new Map<MissionState, number>();
  for (const r of rows) count.set(r.effective, (count.get(r.effective) ?? 0) + 1);
  const always: MissionState[] = ["RUNNING", "READY", "PR_READY", "BLOCKED", "DEPLOYING", "FAILED", "DONE"];
  out(`  ${MISSION_STATES.filter((s) => always.includes(s) || count.get(s)).map((s) => `${s} ${count.get(s) ?? 0}`).join(" · ")}`);
  const order = (s: MissionState) => (CLOSED_STATES.has(s) ? 100 : 0) + MISSION_STATES.indexOf(s);
  out("");
  for (const r of rows.sort((a, b) => order(a.effective) - order(b.effective) || PRIORITIES.indexOf(a.e.priority) - PRIORITIES.indexOf(b.e.priority))) {
    if (CLOSED_STATES.has(r.effective) && !flags.has("all")) continue;
    const lag = r.effective !== r.e.status ? ` (sổ: ${r.e.status})` : "";
    out(`  ${pad(r.effective, 11)} ${r.e.priority} ${pad(r.e.risk, 8)} ${pad(r.e.mission_id, 26)} ${r.e.branch ?? "—"} · nhịp ${ageText(r.e.last_heartbeat, nowMs)} · ${r.e.title.slice(0, 60)}${lag}`);
    for (const d of r.drift) out(`      ⚠ ${d}`);
  }
  const closed = rows.filter((r) => CLOSED_STATES.has(r.effective)).length;
  if (closed && !flags.has("all")) out(`  (+${closed} sứ mệnh đã khép — --all để xem)`);
  if (!rows.length) out("  sổ chưa có sứ mệnh nào — `npm run ai -- claim <mã>` để đăng ký");
  if (gh) {
    out(`\nPR ĐANG MỞ: ${prs.length}${ghError ? ` (GitHub: ${ghError})` : ""}${strays.length ? ` · ${strays.length} PR chưa thuộc sứ mệnh nào trong sổ: ${strays.map((p) => `#${p.number} ${p.branch}`).join(", ")}` : ""}`);
  }
  out(`\nKHOÁ: ${leases.map((l) => (l.live && l.lease ? `${l.name} — ${l.lease.holder} (${l.lease.purpose || "không ghi mục đích"}) còn ${Math.round((Date.parse(l.lease.expires_at) - nowMs) / 60000)}′` : `${l.name} — trống`)).join(" · ")}`);
  out(`\nCẦN CHỦ SHOP (${owner.length})`);
  out(owner.length ? owner.map((r) => `  [${r.e.needs_owner?.category}] ${r.e.mission_id}: ${r.e.needs_owner?.action}`).join("\n") : "  không có");
  if (st.invalid.length) out(`\n! ${st.invalid.length} tệp sổ hỏng: ${st.invalid.map((i) => `${i.file} (${i.errors[0]})`).join("; ")}`);
  return 0;
}

const STOP = new Set(["nhung", "trong", "theo", "them", "duoc", "cung", "nhieu", "phai", "nhap", "lam", "cho", "cac", "mot", "voi"]);

async function cmdIntake(ctx: RepoCtx, words: string[], flags: Set<string>, values: Map<string, string>): Promise<number> {
  const text = words.join(" ").trim();
  if (!text) throw new UsageError('thiếu yêu cầu: intake "<yêu cầu>" --kw=từ,khoá');
  let kws = csv(values.get("kw"));
  if (!kws.length) {
    kws = foldText(text)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !STOP.has(w))
      .slice(0, 6);
    out(`! không có --kw — tự tách từ khoá: ${kws.join(", ") || "(không)"} (Lead nên khai --kw cho chính xác)`);
  }
  const paths = csv(values.get("paths")).map(normalizePattern).filter((p): p is string => p !== null);
  if (!flags.has("offline")) gitRun(ctx.top, ["fetch", "--quiet", ctx.config.remote]);
  const ref = ctx.config.integrationRef;
  const folded = kws.map(foldText);
  const tree = lines(gitTry(ctx.top, ["ls-tree", "-r", "--name-only", ref]));
  // Mỗi từ khoá một tập tệp (nội dung HOẶC đường dẫn chứa nó); tệp "mang đủ từ khoá" = giao của mọi tập.
  const hits: Set<string>[] = kws.map((k) => {
    const hit = new Set(
      lines(gitTry(ctx.top, ["grep", "-l", "-i", "-F", "-e", k, ref, "--", ".", ":(exclude)docs/release-*", ":(exclude)package-lock.json", ":(exclude)drizzle/meta/*"])).map((l) => l.slice(l.indexOf(":") + 1)),
    );
    for (const f of tree) if (foldText(f).includes(foldText(k))) hit.add(f);
    return hit;
  });
  const mainFiles = hits.length ? [...hits[0]].filter((f) => hits.every((h) => h.has(f))) : [];
  const st = readControl(ctx, { fetch: !flags.has("offline") });
  const active: IntakeSignals["active"] = [];
  const match = (s: string) => kws.filter((_, i) => foldText(s).includes(folded[i]));
  for (const e of st.entries) {
    if (CLOSED_STATES.has(e.status)) continue;
    const m = match(`${e.mission_id} ${e.title} ${e.business_goal} ${e.domains.join(" ")}`);
    const ov = paths.length ? scopeConflicts(paths, e.owned_paths, ctx.config) : [];
    if (m.length || ov.length) active.push({ kind: "MISSION", id: e.mission_id, title: e.title, matched: m, pathOverlap: ov });
  }
  const gh = flags.has("github") ? githubClient(ctx) : null;
  const prBranches = new Set<string>();
  if (gh) {
    try {
      const prs = await openPrs(gh.get);
      for (const p of prs) prBranches.add(p.branch);
      for (const p of prs.slice(0, 40)) {
        const m = match(`${p.branch} ${p.title}`);
        let ov: string[] = [];
        if (paths.length) ov = scopeConflicts(paths, (await prFiles(gh.get, p.number)).map((f) => f.name), ctx.config);
        if (m.length || ov.length) active.push({ kind: "PR", id: `#${p.number}`, title: p.title, matched: m, pathOverlap: ov });
      }
    } catch (e) {
      out(`! GitHub: ${(e as Error).message} — bỏ qua PR đang mở`);
    }
  }
  const since = Date.now() / 1000 - 7 * 86400;
  for (const line of lines(gitTry(ctx.top, ["for-each-ref", "--sort=-committerdate", "--count=300", "--format=%(refname:short)%09%(committerdate:unix)%09%(subject)", `refs/remotes/${ctx.config.remote}`]))) {
    const [name, ts, subject] = line.split("\t");
    if (!name || Number(ts) < since) continue;
    const short_ = name.replace(new RegExp(`^${ctx.config.remote}/`), "");
    if (short_ === "HEAD" || short_ === ref.replace(new RegExp(`^${ctx.config.remote}/`), "") || short_.startsWith("ai-control/")) continue;
    if (prBranches.has(short_)) continue; // đã xét qua PR của nhánh này
    const m = match(`${short_} ${subject ?? ""}`);
    if (m.length < Math.max(1, Math.ceil(kws.length / 2))) continue;
    if (gitRun(ctx.top, ["merge-base", "--is-ancestor", name, ref]).code === 0) continue;
    active.push({ kind: "BRANCH", id: short_, title: subject ?? "", matched: m, pathOverlap: [] });
  }
  const signals: IntakeSignals = { keywords: kws, mainFiles: mainFiles.sort(), active };
  const v = intakeVerdict(signals);
  out(`YÊU CẦU: ${text}`);
  out(`  từ khoá: ${kws.join(", ")}${paths.length ? ` · phạm vi dự kiến: ${paths.join(", ")}` : ""}`);
  out(`  GỢI Ý: ${v.verdict} — ${{ EXISTS: "dùng lại", PARTIAL: "mở rộng cái đã có", IN_PROGRESS: "phối hợp / chờ việc đang chạy", MISSING: "dựng mới" }[v.verdict]}`);
  for (const w of v.why) out(`    · ${w}`);
  if (signals.mainFiles.length) out(`  tệp trên main mang đủ từ khoá (${signals.mainFiles.length}): ${signals.mainFiles.slice(0, 12).join(", ")}${signals.mainFiles.length > 12 ? " …" : ""}`);
  out(`  ⇒ Lead đọc chứng cứ, rồi ghi phán quyết cuối: npm run ai -- claim <mã> --intake=${v.verdict} …`);
  if (flags.has("record")) {
    mutateControl(ctx, controlActor(ctx), () => ({
      change: {
        put: {},
        events: [{ kind: v.verdict === "IN_PROGRESS" || v.verdict === "EXISTS" ? "DUPLICATE_PREVENTED" : `INTAKE_${v.verdict}`, detail: `${text.slice(0, 160)} · ${v.why[0] ?? ""}`.slice(0, 400) }],
        message: `intake: ${v.verdict}`,
      },
      result: null,
    }));
    out("  ✓ đã ghi vào nhật ký sổ");
  }
  return 0;
}

function applyEntryFlags(base: Partial<RegistryEntry> & { owner: string }, values: Map<string, string>, flags: Set<string>): void {
  const v = (k: string) => values.get(k);
  if (v("title") !== undefined) base.title = v("title");
  if (v("goal") !== undefined) base.business_goal = v("goal");
  if (v("status") !== undefined) base.status = v("status") as MissionState;
  if (v("priority") !== undefined) base.priority = v("priority") as Priority;
  if (v("risk") !== undefined) base.risk = v("risk") as Risk;
  if (v("branch") !== undefined) base.branch = v("branch") || null;
  if (v("worktree") !== undefined) base.worktree = v("worktree") || null;
  if (v("worker") !== undefined) base.worker = v("worker") || null;
  if (v("domains") !== undefined) base.domains = csv(v("domains"));
  if (v("paths") !== undefined) base.owned_paths = csv(v("paths"));
  if (v("after") !== undefined) base.dependencies = [...new Set([...(base.dependencies ?? []), ...csv(v("after"))])];
  if (v("prs") !== undefined) base.related_prs = [...new Set([...(base.related_prs ?? []), ...csv(v("prs")).map(Number)])];
  if (v("dod") !== undefined) base.definition_of_done = v("dod")?.split("|").map((s) => s.trim()).filter(Boolean);
  if (v("blocked-by") !== undefined) base.blocked_by = csv(v("blocked-by"));
  if (v("intake") !== undefined) base.intake = { verdict: v("intake") as IntakeVerdict, evidence: csv(v("intake-evidence")) };
  if (v("needs-owner") !== undefined) {
    const m = /^([A-Z_]+):\s*([\s\S]+)$/.exec(v("needs-owner") ?? "");
    base.needs_owner = m ? { category: m[1] as (typeof OWNER_ESCALATIONS)[number], action: m[2] } : undefined;
  }
  if (flags.has("clear-owner")) base.needs_owner = undefined;
}

async function cmdClaim(ctx: RepoCtx, idIn: string | undefined, flags: Set<string>, values: Map<string, string>): Promise<number> {
  const id = mustMission(idIn);
  // DONE chỉ đi qua `close` — nơi đòi bằng chứng đã vào main + hậu kiểm. `claim --status=DONE` là cửa lách.
  if (CLOSED_STATES.has(values.get("status") as MissionState))
    throw new UsageError(`${values.get("status")} đi qua \`close <mã> --status=${values.get("status")} --evidence=…\` (đòi bằng chứng), không qua claim — khép là nhả phạm vi và giữ chỗ migration`);
  const actor = controlActor(ctx);
  const local = existsSync(path.join(missionsDir(ctx), `${id}.json`)) ? requireMission(ctx, id).mission : null;
  const here = gitTry(ctx.top, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const decide = (st: ControlState) => {
    const now = new Date().toISOString();
    const prev = st.entries.find((e) => e.mission_id === id) ?? null;
    const base: Partial<RegistryEntry> & { owner: string } = { ...(prev ?? {}), owner: values.get("owner") ?? prev?.owner ?? actor };
    if (local && base.branch === undefined && here && here !== "HEAD") {
      base.branch = here;
      base.worktree = ctx.top;
    }
    applyEntryFlags(base, values, flags);
    // Sứ mệnh có tệp DAG: phạm vi luôn DẪN XUẤT từ `owns` của các việc (không khai tay lần hai), trừ khi --paths ghi đè.
    if (local && values.get("paths") === undefined) base.owned_paths = undefined;
    const tip = base.branch && REF_RE.test(base.branch) && !gitRefLooksUnsafe(base.branch)
      ? (gitTry(ctx.top, ["rev-parse", "--verify", "--quiet", `refs/heads/${base.branch}`]) ?? gitTry(ctx.top, ["rev-parse", "--verify", "--quiet", `refs/remotes/${ctx.config.remote}/${base.branch}`]))
      : null;
    const mb = tip ? gitTry(ctx.top, ["merge-base", tip, ctx.config.integrationRef]) : null;
    if (!base.base_sha && mb) base.base_sha = mb;
    // Sứ mệnh ngoài AI Tech Room không khai --paths: phạm vi SUY từ chính nhánh (lần đầu, hoặc --infer-paths
    // khi nhánh đã lớn thêm). Sàn rủi ro khi đó tính trên TỆP nhánh thật sự chạm, không trên thư mục suy ra
    // (thư mục `lib/queries/` chồng sàn CRITICAL của `return-rate.ts` dù nhánh không đụng tệp đó).
    let touchedForFloor: string[] | null = null;
    if (!local && values.get("paths") === undefined && tip && mb && (!base.owned_paths || !base.owned_paths.length || flags.has("infer-paths"))) {
      touchedForFloor = lines(gitTry(ctx.top, ["diff", "--name-only", "--no-renames", mb, tip]));
      base.owned_paths = inferOwnedPaths(touchedForFloor);
    }
    const raw: RegistryEntry = local
      ? entryFromMission(local, base, now)
      : {
          schema: 1,
          mission_id: id,
          title: base.title ?? "",
          business_goal: base.business_goal ?? "",
          status: base.status ?? "PLANNING",
          priority: base.priority ?? "P2",
          risk: base.risk ?? "MEDIUM",
          owner: base.owner,
          worker: base.worker ?? null,
          worktree: base.worktree ?? null,
          branch: base.branch ?? null,
          base_sha: base.base_sha ?? null,
          domains: base.domains ?? [],
          owned_paths: base.owned_paths ?? [],
          dependencies: base.dependencies ?? [],
          blocked_by: base.blocked_by ?? [],
          related_prs: base.related_prs ?? [],
          migration_reservations: base.migration_reservations ?? [],
          migration_reserved_at: base.migration_reserved_at,
          created_at: prev?.created_at ?? now,
          updated_at: now,
          last_heartbeat: now,
          definition_of_done: base.definition_of_done ?? [],
          mission_file: base.mission_file,
          intake: base.intake,
          needs_owner: base.needs_owner,
          evidence: base.evidence,
        };
    // Rủi ro không bao giờ thấp hơn sàn của phạm vi khai (cùng luật với việc trong sứ mệnh).
    const floor = riskFloorFor(touchedForFloor ?? raw.owned_paths, ctx.config);
    if (riskRank(floor.risk) > riskRank(raw.risk)) raw.risk = floor.risk;
    const v = validateEntry(raw);
    if (!v.entry) return { change: null, result: { ok: false, lines: v.errors.map((x) => `lỗi: ${x}`), entry: raw } };
    if (!v.entry.title) return { change: null, result: { ok: false, lines: ["lỗi: sứ mệnh mới cần --title=…"], entry: raw } };
    const d = claimDecision(v.entry, st.entries.filter((e) => e.mission_id !== id), ctx.config, { acceptOverlap: values.get("accept-overlap") });
    if (!d.ok) {
      return {
        change: flags.has("dry-run")
          ? null
          : { put: {}, events: d.refusals.map((r) => ({ kind: r.startsWith("DUPLICATE") ? "DUPLICATE_PREVENTED" : r.startsWith("OVERLAP") ? "OVERLAP_DETECTED" : "CLAIM_REFUSED", mission: id, detail: r.slice(0, 400) })), message: `từ chối đăng ký ${id}` },
        result: { ok: false, lines: d.refusals.map((x) => `✗ ${x}`), entry: v.entry },
      };
    }
    const evs: Omit<ControlEvent, "at" | "actor">[] = [{ kind: prev ? (prev.status !== v.entry.status ? "STATUS" : "UPDATE") : "CLAIM", mission: id, detail: `${prev ? `${prev.status} → ` : ""}${v.entry.status} · ${v.entry.owned_paths.length} mẫu phạm vi · ${v.entry.risk}` }];
    for (const w of d.warnings) evs.push({ kind: "OVERLAP_ACCEPTED", mission: id, detail: w.slice(0, 400) });
    return {
      change: flags.has("dry-run") ? null : { put: { [entryFile(id)]: entryJson(v.entry) }, events: evs, message: `${prev ? "cập nhật" : "đăng ký"} sứ mệnh ${id}` },
      result: { ok: true, lines: d.warnings.map((w) => `! ${w}`), entry: v.entry },
    };
  };
  const r = flags.has("dry-run") ? decide(readControl(ctx, { fetch: !flags.has("offline") })).result : mutateControl(ctx, actor, decide);
  out(`${flags.has("dry-run") ? "[CHẠY THỬ] " : ""}${r.ok ? "✓" : "✗"} ${id} — ${r.entry.status} · ${r.entry.priority} · ${r.entry.risk} · nhánh ${r.entry.branch ?? "—"}`);
  out(`  phạm vi: ${r.entry.owned_paths.join(", ") || "(chưa khai)"}`);
  if (r.entry.dependencies.length) out(`  sau: ${r.entry.dependencies.join(", ")}`);
  for (const l of r.lines) out(`  ${l}`);
  return r.ok ? 0 : 1;
}

function cmdHeartbeat(ctx: RepoCtx, idIn: string | undefined, values: Map<string, string>): number {
  const id = mustMission(idIn);
  const status = values.get("status");
  if (status !== undefined && !MISSION_STATES.includes(status as MissionState)) throw new UsageError(`--status: ${MISSION_STATES.join("|")}`);
  const r = mutateControl(ctx, controlActor(ctx), (st) => {
    const e = st.entries.find((x) => x.mission_id === id);
    if (!e) return { change: null, result: `✗ ${id} chưa có trong sổ — claim trước` };
    const now = new Date().toISOString();
    const next: RegistryEntry = { ...e, last_heartbeat: now, updated_at: now, status: (status as MissionState) ?? e.status, worker: values.get("worker") ?? e.worker };
    if (CLOSED_STATES.has(status as MissionState)) return { change: null, result: `✗ ${status} đi qua \`close\` (đòi bằng chứng), không qua heartbeat` };
    return {
      change: { put: { [entryFile(id)]: entryJson(next) }, events: next.status !== e.status ? [{ kind: "STATUS", mission: id, detail: `${e.status} → ${next.status}` }] : [], message: `nhịp tim ${id}` },
      result: `✓ ${id} — nhịp tim ${now}${next.status !== e.status ? ` · ${e.status} → ${next.status}` : ""}`,
    };
  });
  out(r);
  return r.startsWith("✓") ? 0 : 1;
}

function cmdClose(ctx: RepoCtx, idIn: string | undefined, flags: Set<string>, values: Map<string, string>): number {
  const id = mustMission(idIn);
  const status = values.get("status");
  if (status !== "DONE" && status !== "CANCELLED") throw new UsageError("--status=DONE|CANCELLED");
  const evidence = (values.get("evidence") ?? "").trim();
  if (!evidence) throw new UsageError("--evidence=… bắt buộc: PR, SHA, kết quả verify — hoặc lý do huỷ");
  gitRun(ctx.top, ["fetch", "--quiet", ctx.config.remote]);
  const r = mutateControl(ctx, controlActor(ctx), (st) => {
    const e = st.entries.find((x) => x.mission_id === id);
    if (!e) return { change: null, result: { ok: false, msg: `${id} chưa có trong sổ` } };
    if (status === "DONE") {
      const tip = e.branch ? (gitTry(ctx.top, ["rev-parse", "--verify", "--quiet", `refs/remotes/${ctx.config.remote}/${e.branch}`]) ?? gitTry(ctx.top, ["rev-parse", "--verify", "--quiet", `refs/heads/${e.branch}`])) : null;
      const lastPr = e.related_prs.length ? e.related_prs[e.related_prs.length - 1] : undefined;
      const ev = tip ? mergeEvidence(ctx.top, tip, ctx.config.integrationRef, { pr: lastPr, baseSha: e.base_sha ?? undefined }) : null;
      const prLanded = lastPr ? gitTry(ctx.top, ["log", "-n", "1", "--format=%H", "--fixed-strings", `--grep=(#${lastPr})`, ctx.config.integrationRef]) : null;
      const branchLanded = ev !== null && ev !== "EMPTY";
      // Mọi nhánh lỗi rơi về phía HẸP (AGENTS.md mục 31): không chứng minh được thì KHÔNG DONE.
      if (!e.branch && !e.related_prs.length)
        return { change: null, result: { ok: false, msg: "dòng sổ không có nhánh lẫn PR — DONE không chứng minh được; khai --branch / --prs, hoặc khép CANCELLED kèm lý do" } };
      if (!branchLanded && !prLanded)
        return { change: null, result: { ok: false, msg: `chưa có bằng chứng ${e.branch ?? `PR #${lastPr}`} đã vào ${ctx.config.integrationRef} — DONE chỉ sau khi vào main` } };
      const landed = (tip && branchLanded ? landedCommit(ctx, tip, ctx.config.integrationRef, ev, lastPr ?? null) : null) ?? prLanded;
      if (flags.has("no-runtime")) {
        // `--no-runtime` là một KHẲNG ĐỊNH về tệp — đối chiếu với tệp thật sứ mệnh đã chạm, không tin chữ.
        const files =
          tip && branchLanded && e.base_sha
            ? lines(gitTry(ctx.top, ["diff", "--name-only", "--no-renames", e.base_sha, tip]))
            : landed
              ? lines(gitTry(ctx.top, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-m", "--first-parent", landed]))
              : null;
        if (!files || !files.length) return { change: null, result: { ok: false, msg: "không xác định được tệp sứ mệnh đã đổi — --no-runtime không kiểm được; dùng verify --record" } };
        const runtime = files.filter((f) => !ctx.config.nonRuntimePaths.some((p) => fileInPattern(f, p)));
        if (runtime.length)
          return { change: null, result: { ok: false, msg: `--no-runtime nhưng sứ mệnh chạm ${runtime.length} tệp chạy trên VPS (${runtime.slice(0, 5).join(", ")}) — deploy rồi verify --record` } };
      } else {
        const vm = /^PASS ([0-9a-f]{40}) /.exec(e.evidence?.verify ?? "");
        if (!vm) return { change: null, result: { ok: false, msg: "chưa có hậu kiểm production ĐẠT (`verify --record`) — hoặc khai --no-runtime nếu sứ mệnh không đổi mã chạy trên VPS" } };
        if (!landed)
          return { change: null, result: { ok: false, msg: "không chỉ ra được commit đưa sứ mệnh vào main (bằng chứng CONTENT, không số PR) — khai --prs=<PR đã gộp> để đối chiếu với bản đã verify" } };
        // Bản đã hậu kiểm phải CHỨA commit đưa sứ mệnh vào main — verify một bản cũ hơn không chứng minh gì.
        if (gitRun(ctx.top, ["merge-base", "--is-ancestor", landed, vm[1]]).code !== 0)
          return { change: null, result: { ok: false, msg: `bản đã hậu kiểm ${vm[1].slice(0, 12)} CHƯA chứa commit đưa sứ mệnh vào main (${landed.slice(0, 12)}) — deploy rồi verify lại` } };
      }
    }
    const now = new Date().toISOString();
    const next: RegistryEntry = { ...e, status: status as MissionState, updated_at: now, last_heartbeat: now, needs_owner: undefined, evidence: { ...(e.evidence ?? {}), done: `${flags.has("no-runtime") ? "không đổi mã chạy · " : ""}${evidence}` } };
    return {
      change: { put: { [entryFile(id)]: entryJson(next) }, events: [{ kind: status === "DONE" ? "DONE" : "CANCELLED", mission: id, detail: evidence.slice(0, 400) }], message: `khép sứ mệnh ${id}: ${status}` },
      result: { ok: true, msg: `${id} → ${status}; phạm vi (${e.owned_paths.length} mẫu) và giữ chỗ migration (${e.migration_reservations.join(", ") || "không"}) đã nhả` },
    };
  });
  out(`${r.ok ? "✓" : "✗"} ${r.msg}`);
  if (r.ok) out("  dọn cây (nếu có): npm run ai -- cleanup <cây> (chạy thử) — không bao giờ dọn cây bẩn / có commit chưa đẩy");
  return r.ok ? 0 : 1;
}

function cmdLease(ctx: RepoCtx, op: string | undefined, nameIn: string | undefined, flags: Set<string>, values: Map<string, string>): number {
  const nowMs = Date.now();
  if (op === "status" || op === undefined) {
    const st = readControl(ctx, { fetch: true });
    for (const n of LEASE_NAMES) {
      const l = st.leases.find((x) => x.name === n);
      const live = l && Date.parse(l.expires_at) > nowMs;
      out(`${pad(n, 18)} ${l ? `${l.holder} · ${l.purpose || "—"} · ${live ? `còn ${Math.round((Date.parse(l.expires_at) - nowMs) / 60000)}′` : `HẾT HẠN từ ${l.expires_at} (ai cũng tiếp quản được)`} · đời ${l.generation}` : "trống"}`);
    }
    return 0;
  }
  if (op !== "acquire" && op !== "renew" && op !== "release") throw new UsageError("lease acquire|renew|release|status <tên>");
  const name = (nameIn ?? "integration-lead") as LeaseName;
  if (!LEASE_NAMES.includes(name)) throw new UsageError(`khoá: ${LEASE_NAMES.join("|")}`);
  const ttlMin = values.get("ttl") !== undefined ? Number(values.get("ttl")) : ctx.config.leaseMinutes;
  if (!Number.isInteger(ttlMin) || ttlMin < 1 || ttlMin > 24 * 60) throw new UsageError("--ttl=<phút> (1–1440)");
  const actor = controlActor(ctx);
  const presented = presentedLeaseToken(ctx, name, values, flags);
  const freshToken = randomBytes(16).toString("hex");
  const freshHash = sha256(freshToken);
  const r = mutateControl(ctx, actor, (st) => {
    const cur = st.leases.find((x) => x.name === name) ?? null;
    const d = leaseDecision(cur, op, { name, holder: actor, purpose: values.get("purpose") ?? "", tokenHash: presented ? sha256(presented) : null, freshTokenHash: freshHash }, Date.now(), ttlMin * 60_000);
    if (!d.ok) return { change: null, result: d };
    const file = `lease.${name}.json`;
    const evs: Omit<ControlEvent, "at" | "actor">[] = [];
    if (op !== "renew" && !(op === "acquire" && cur !== null && d.next?.generation === cur.generation))
      evs.push({ kind: d.takeoverFrom ? "LEASE_TAKEOVER" : op === "acquire" ? "LEASE_ACQUIRED" : "LEASE_RELEASED", detail: `${name}${d.takeoverFrom ? ` từ ${d.takeoverFrom.holder} (hết hạn ${d.takeoverFrom.expires_at})` : ""}` });
    // Nhận lại bằng --resume và nâng cấp khoá cũ đều phải để lại vết: cả hai là chỗ hai phiên có thể cùng thành chủ.
    if (flags.has("resume") && cur !== null && d.next?.generation === cur.generation) evs.push({ kind: "LEASE_RESUMED", detail: `${name} bằng mã đã lưu cạnh cây` });
    if (cur !== null && cur.token_hash === undefined && d.next?.token_hash) evs.push({ kind: "LEASE_UPGRADED", detail: `${name}: khoá cũ được gắn mã phiên` });
    return {
      change: d.next ? { put: { [file]: `${JSON.stringify(d.next, null, 2)}\n` }, events: evs, message: `khoá ${name}: ${op}` } : { put: {}, del: [file], events: evs, message: `khoá ${name}: nhả` },
      result: d,
    };
  });
  out(`${r.ok ? "✓" : "✗"} ${name}: ${r.reason}${r.ok && r.next ? ` · hết hạn ${r.next.expires_at}` : ""}`);
  if (r.ok && r.next?.token_hash === freshHash) {
    // Mã phiên MỚI: in cho phiên giữ nó, và lưu cạnh cây (thư mục quản trị git) cho lượt `--resume` sau sập.
    saveLeaseToken(ctx, name, freshToken);
    out(`  mã phiên: ${freshToken} — dùng --token=${freshToken} (hoặc --resume trong cùng cây) cho renew / release / deploy-plan`);
  }
  if (r.ok && r.next === null) saveLeaseToken(ctx, name, null);
  return r.ok ? 0 : 1;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const leaseTokenFile = (ctx: RepoCtx, name: LeaseName) => {
  const admin = adminDirOf(ctx.top);
  return admin ? path.join(admin, `ai-control-${name}.token`) : null;
};
function saveLeaseToken(ctx: RepoCtx, name: LeaseName, token: string | null): void {
  const f = leaseTokenFile(ctx, name);
  if (!f) return;
  try {
    writeFileSync(f, token ? `${token}\n` : "");
  } catch {
    /* không lưu được thì phiên vẫn còn mã trong tay — chỉ mất đường --resume */
  }
}
/**
 * Mã phiên người gọi trình ra: `--token=…` tường minh, hoặc `--resume` đọc mã đã lưu cạnh cây. KHÔNG tự
 * đọc tệp khi không có `--resume`: tự đọc thì mọi phiên trong cùng cây lại thành một chủ — đúng lỗi phải chặn.
 */
function presentedLeaseToken(ctx: RepoCtx, name: LeaseName, values: Map<string, string>, flags: Set<string>): string | null {
  const t = values.get("token");
  if (t !== undefined) return /^[0-9a-f]{32}$/.test(t) ? t : (() => { throw new UsageError("--token=<32 ký tự hex in ra lúc lấy khoá>"); })();
  if (!flags.has("resume")) return null;
  const f = leaseTokenFile(ctx, name);
  try {
    const v = f ? readFileSync(f, "utf8").trim() : "";
    return /^[0-9a-f]{32}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Ghi dấu review độc lập cho một PR, gắn SHA đầu nhánh ĐÃ được đọc. `queue` chỉ nhận dấu khớp đúng SHA
 * hiện tại của PR — đẩy thêm commit sau review là phải review lại.
 */
function cmdReview(ctx: RepoCtx, prIn: string | undefined, flags: Set<string>, values: Map<string, string>): number {
  const pr = Number(prIn);
  if (!Number.isInteger(pr) || pr <= 0) throw new UsageError("review <số PR> --sha=<SHA đầu nhánh đã review> --verdict=PASS|FAIL [--note=…]");
  const sha = values.get("sha") ?? "";
  if (!SHA_RE.test(sha)) throw new UsageError("--sha=<SHA đầy đủ 40 ký tự của đầu nhánh lúc review>");
  const verdict = values.get("verdict");
  if (verdict !== "PASS" && verdict !== "FAIL") throw new UsageError("--verdict=PASS|FAIL");
  const actor = controlActor(ctx);
  const rec: ReviewRecord = { pr, sha, verdict, actor, at: new Date().toISOString(), note: (values.get("note") ?? "").slice(0, 400) };
  // PASS mở cửa gộp cho PR rủi ro HIGH ⇒ chỉ phiên đang cầm khoá Lead (tech-lead / integration-lead, đúng
  // mã phiên) được ghi — worker không tự chấm mình. FAIL thì ai cũng ghi được: nó chỉ đóng cửa.
  const hashes = (["tech-lead", "integration-lead"] as const).map((n) => {
    const t = presentedLeaseToken(ctx, n, values, flags);
    return { n, h: t ? sha256(t) : null };
  });
  const r = mutateControl(ctx, actor, (st) => {
    if (verdict === "PASS") {
      const nowMs = Date.now();
      const ok = hashes.some(({ n, h }) => {
        const l = st.leases.find((x) => x.name === n && Date.parse(x.expires_at) > nowMs) ?? null;
        return l !== null && l.token_hash !== undefined && leaseIsMine(l, actor, h);
      });
      if (!ok) return { change: null, result: "✗ PASS chỉ ghi được bởi phiên đang cầm khoá tech-lead / integration-lead (trình --token=<mã phiên> hoặc --resume) — worker không tự chấm mình" };
    }
    return {
      change: { put: { [`review.${pr}.json`]: `${JSON.stringify(rec, null, 2)}\n` }, events: [{ kind: verdict === "PASS" ? "REVIEW_PASS" : "REVIEW_FAIL", detail: `#${pr} @ ${sha.slice(0, 12)}${rec.note ? ` · ${rec.note}` : ""}` }], message: `review #${pr}: ${verdict}` },
      result: `✓ #${pr} @ ${sha.slice(0, 12)}: ${verdict} — hàng đợi chỉ nhận dấu này khi đầu nhánh PR vẫn là đúng SHA ấy`,
    };
  });
  out(r);
  return r.startsWith("✓") ? 0 : 1;
}

function addedMigrations(ctx: RepoCtx, tip: string, ref: string): string[] {
  const mb = gitTry(ctx.top, ["merge-base", tip, ref]);
  if (!mb) return [];
  return lines(gitTry(ctx.top, ["diff", "--name-only", "--diff-filter=A", "--no-renames", mb, tip, "--", "drizzle/"])).filter((f) => migrationNumberOf(f) !== null);
}

async function cmdMigration(ctx: RepoCtx, op: string | undefined, flags: Set<string>, values: Map<string, string>): Promise<number> {
  const ref = ctx.config.integrationRef;
  if (!flags.has("offline")) gitRun(ctx.top, ["fetch", "--quiet", ctx.config.remote]);
  const mainMigs = lines(gitTry(ctx.top, ["ls-tree", "--name-only", ref, "drizzle/"])).filter((f) => migrationNumberOf(f) !== null);
  const gh = flags.has("github") ? githubClient(ctx) : null;
  const prMigs: { pr: number; createdAt: string; added: string[]; branch: string }[] = [];
  if (gh) {
    const prs = await openPrs(gh.get);
    const want = values.get("pr") !== undefined ? Number(values.get("pr")) : null;
    // PR đang kiểm lấy riêng: nó phải có mặt kể cả khi danh sách PR mở dài.
    if (want !== null && !prs.some((p) => p.number === want)) prs.push(toOpenPr((await gh.get(`/pulls/${want}`)) as Record<string, unknown>));
    for (const p of prs) {
      const added = (await prFiles(gh.get, p.number)).filter((f) => f.status === "added" && migrationNumberOf(f.name) !== null).map((f) => f.name);
      prMigs.push({ pr: p.number, createdAt: p.createdAt, added, branch: p.branch });
    }
  }
  if (op === "next" || op === "reserve") {
    const branchMigs = addedMigrations(ctx, "HEAD", ref);
    if (op === "next") {
      const st = readControl(ctx, { fetch: !flags.has("offline") });
      const reserved = st.entries.filter((e) => !CLOSED_STATES.has(e.status)).flatMap((e) => e.migration_reservations);
      out(nextMigrationNumber({ main: mainMigs, branches: [...branchMigs, ...prMigs.flatMap((p) => p.added)], reserved }));
      return 0;
    }
    const id = mustMission(values.get("mission"));
    const r = mutateControl(ctx, controlActor(ctx), (st) => {
      const e = st.entries.find((x) => x.mission_id === id);
      if (!e || CLOSED_STATES.has(e.status)) return { change: null, result: `✗ ${id} không có trong sổ hoặc đã khép — claim trước` };
      const reserved = st.entries.filter((x) => !CLOSED_STATES.has(x.status)).flatMap((x) => x.migration_reservations);
      const n = nextMigrationNumber({ main: mainMigs, branches: [...branchMigs, ...prMigs.flatMap((p) => p.added)], reserved });
      const at = new Date().toISOString();
      const next: RegistryEntry = { ...e, migration_reservations: [...e.migration_reservations, n], migration_reserved_at: { ...(e.migration_reserved_at ?? {}), [n]: at }, updated_at: at };
      return { change: { put: { [entryFile(id)]: entryJson(next) }, events: [{ kind: "MIGRATION_RESERVED", mission: id, detail: n }], message: `giữ chỗ migration ${n} cho ${id}` }, result: `✓ ${n} — đã giữ chỗ cho ${id}` };
    });
    out(r);
    out("  đặt tên tệp drizzle/<số>_<tên>.sql; lúc tích hợp vẫn chạy `npm run migration:renumber` nếu main đã đi tiếp (giữ chỗ chỉ chống hai phiên cùng lấy một số)");
    return r.startsWith("✓") ? 0 : 1;
  }
  if (op !== "check") throw new UsageError("migration next | reserve --mission=<mã> | check [--pr=<số>] [--github]");
  const st = readControl(ctx, { fetch: !flags.has("offline") });
  if (!st.fetched && !flags.has("offline")) out(`! không đọc được sổ giữ chỗ (${st.fetchError ?? "?"}) — chỉ so với main và PR`);
  const reservations = openReservations(st.entries);
  const prNo = values.get("pr") !== undefined ? Number(values.get("pr")) : null;
  let me: { pr: number; createdAt: string; added: string[]; branch: string };
  if (prNo !== null) {
    const hit = prMigs.find((p) => p.pr === prNo);
    if (!hit) throw new Error(`PR #${prNo} không có trong danh sách PR đang mở (cần --github)`);
    me = hit;
  } else {
    const branch = gitTry(ctx.top, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "HEAD";
    me = { pr: 0, createdAt: new Date().toISOString(), added: addedMigrations(ctx, "HEAD", ref), branch };
  }
  const own = st.entries.find((e) => e.branch === me.branch || (prNo !== null && e.related_prs.includes(prNo)))?.mission_id ?? null;
  const res = checkPrMigrations({ pr: me.pr, createdAt: me.createdAt, added: me.added, main: mainMigs, others: prMigs.filter((p) => p.pr !== me.pr), reservations, ownMission: own });
  out(`MIGRATION ${prNo !== null ? `PR #${prNo}` : me.branch}: thêm ${me.added.map((f) => f.split("/").pop()).join(", ") || "(không)"} · main tới ${mainMigs.map(migrationNumberOf).sort().pop() ?? "—"}${own ? ` · sứ mệnh ${own}` : ""}`);
  for (const p of res.problems) out(`  ✗ ${p}`);
  for (const w of res.warnings) out(`  ! ${w}`);
  if (!res.problems.length) out("  ✓ không va số với main, PR mở trước, hay giữ chỗ của sứ mệnh khác");
  return res.problems.length ? 1 : 0;
}

async function cmdQueue(ctx: RepoCtx, flags: Set<string>): Promise<number> {
  const gh = githubClient(ctx);
  if (!gh) throw new Error("remote không phải GitHub — hàng đợi gộp cần GitHub");
  gitRun(ctx.top, ["fetch", "--quiet", ctx.config.remote]);
  const mainMigs = lines(gitTry(ctx.top, ["ls-tree", "--name-only", ctx.config.integrationRef, "drizzle/"])).filter((f) => migrationNumberOf(f) !== null);
  const st = readControl(ctx, { fetch: true });
  const prs = await openPrs(gh.get);
  const detail = new Map<number, { files: { name: string; status: string }[]; mergeable: string; gates: QueueItem["gates"] }>();
  for (const p of prs) {
    const files = await prFiles(gh.get, p.number);
    const one = (await gh.get(`/pulls/${p.number}`)) as Record<string, unknown>;
    const gates = await gatesOf(gh.get, p.sha).catch(() => "missing" as const);
    detail.set(p.number, { files, mergeable: String(one.mergeable_state ?? "unknown"), gates });
  }
  const added = (n: number) => (detail.get(n)?.files ?? []).filter((f) => f.status === "added" && migrationNumberOf(f.name) !== null).map((f) => f.name);
  const reservations = openReservations(st.entries);
  const items: QueueItem[] = [];
  for (const p of prs) {
    const d = detail.get(p.number);
    if (!d) continue;
    const names = d.files.map((f) => f.name);
    let destructive = false;
    for (const f of added(p.number)) {
      try {
        const c = (await gh.get(`/contents/${f}?ref=${p.sha}`)) as { content?: string };
        if (c.content && isDestructiveSql(Buffer.from(c.content, "base64").toString("utf8"))) destructive = true;
      } catch {
        /* không đọc được nội dung — đánh giá theo đường dẫn */
      }
    }
    const entry = st.entries.find((e) => e.branch === p.branch || e.related_prs.includes(p.number));
    const regDeps = (entry?.dependencies ?? []).flatMap((dep) => {
      const de = st.entries.find((x) => x.mission_id === dep);
      return prs.filter((q) => q.branch === de?.branch || de?.related_prs.includes(q.number)).map((q) => q.number);
    });
    const mig = checkPrMigrations({ pr: p.number, createdAt: p.createdAt, added: added(p.number), main: mainMigs, others: prs.filter((q) => q.number !== p.number).map((q) => ({ pr: q.number, createdAt: q.createdAt, added: added(q.number) })), reservations, ownMission: entry?.mission_id ?? null });
    items.push({
      pr: p.number,
      title: p.title,
      branch: p.branch,
      draft: p.draft,
      risk: classifyRisk(names, ctx.config, { destructiveMigration: destructive }).risk,
      gates: d.gates,
      mergeable: d.mergeable,
      deps: [...new Set([...parsePrDependencies(p.body), ...regDeps])].filter((n) => n !== p.number),
      files: names,
      sha: p.sha,
      migrationProblems: mig.problems,
      createdAt: p.createdAt,
      reviewed: reviewedAt(st.reviews, p.number, p.sha),
    });
  }
  const rows = orderQueue(items, ctx.config);
  if (flags.has("json")) {
    out(JSON.stringify(rows.map((r) => ({ pr: r.item.pr, sha: r.item.sha, verdict: r.verdict, why: r.why, risk: r.item.risk, policy: r.policy, gates: r.item.gates, mergeable: r.item.mergeable, branch: r.item.branch })), null, 2));
    return 0;
  }
  out(`HÀNG ĐỢI GỘP · ${rows.length} PR đang mở`);
  for (const r of rows) out(`  ${pad(r.verdict, 19)} #${pad(String(r.item.pr), 5)} ${pad(r.item.risk, 8)} ${pad(r.item.gates, 8)} ${pad(r.item.mergeable, 9)} ${r.item.title.slice(0, 60)}\n      ${r.why} · sha ${r.item.sha}`);
  const now = rows.filter((r) => r.verdict === "MERGE_NOW").map((r) => `#${r.item.pr}`);
  const iso = rows.find((r) => r.verdict === "MERGE_ISOLATED");
  out("");
  if (now.length) out(`VIỆC CỦA INTEGRATION LEAD (cầm khoá integration-lead): gộp ${now.join(", ")} (squash, kèm \`sha\` = ĐÚNG SHA in ở trên — GitHub từ chối nếu đầu nhánh đã đổi; chỉ khi mergeable_state=clean) → \`npm run ai -- deploy-plan\` → MỘT lượt deploy cho cả lô → \`verify\``);
  else if (iso) out(`VIỆC CỦA INTEGRATION LEAD: gộp #${iso.item.pr} MỘT MÌNH → deploy → verify, rồi chạy lại \`queue\``);
  else out("không có PR nào sẵn sàng gộp lúc này.");
  return 0;
}

async function cmdDeployPlan(ctx: RepoCtx, flags: Set<string>, values: Map<string, string>): Promise<number> {
  gitRun(ctx.top, ["fetch", "--quiet", ctx.config.remote]);
  const ref = ctx.config.integrationRef;
  const mainSha = git(ctx.top, ["rev-parse", "--verify", `${ref}^{commit}`]);
  const prod = await productionHealth(ctx);
  const undeployed: DeployInput["undeployed"] = [];
  if (prod.sha) {
    for (const line of lines(gitTry(ctx.top, ["log", "--first-parent", "--format=%H%x09%s", `${prod.sha}..${mainSha}`]))) {
      const [sha, ...subj] = line.split("\t");
      if (!SHA_RE.test(sha)) continue;
      const files = lines(gitTry(ctx.top, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-m", "--first-parent", sha]));
      const migs = lines(gitTry(ctx.top, ["diff-tree", "--no-commit-id", "--name-only", "--diff-filter=A", "-r", "-m", "--first-parent", sha, "--", "drizzle/"])).filter((f) => migrationNumberOf(f) !== null);
      const destructive = migs.some((f) => isDestructiveSql(gitTry(ctx.top, ["show", `${sha}:${f}`]) ?? ""));
      undeployed.push({ sha, subject: subj.join("\t"), risk: classifyRisk(files, ctx.config, { destructiveMigration: destructive }).risk, migrations: migs.map((f) => f.split("/").pop() ?? f) });
    }
  }
  const gh = githubClient(ctx);
  let mainGates: DeployInput["mainGates"] = "missing";
  const deployActive: DeployInput["deployActive"] = [];
  if (gh) {
    mainGates = await gatesOf(gh.get, mainSha).catch(() => "missing" as const);
    for (const s of ["in_progress", "queued", "waiting"]) {
      const runs = (await gh.get(`/actions/workflows/deploy-vps.yml/runs?status=${s}&per_page=20`).catch(() => ({}))) as { workflow_runs?: unknown };
      for (const r of arr(runs.workflow_runs)) deployActive.push({ id: Number(r.id), sha: String(r.head_sha), status: String(r.status) });
    }
  }
  const st = readControl(ctx, { fetch: true });
  const lease = st.leases.find((l) => l.name === "integration-lead" && Date.parse(l.expires_at) > Date.now()) ?? null;
  const me = controlActor(ctx);
  const presented = presentedLeaseToken(ctx, "integration-lead", values, flags);
  // Đang cầm khoá = đúng nhãn VÀ đúng mã phiên. Cùng nhãn mà sai / thiếu mã là phiên KHÁC trong cùng cây.
  const holder = lease === null ? null : leaseIsMine(lease, me, presented ? sha256(presented) : null) ? me : lease.holder === me ? `${lease.holder} (một phiên khác cùng cây — trình mã bằng --token=… / --resume)` : lease.holder;
  const plan = planDeploy({ productionSha: prod.sha, mainSha, undeployed, mainGates, deployActive, leaseHolder: holder, me });
  if (flags.has("json")) {
    out(JSON.stringify({ ...plan, production: prod.sha, main: mainSha, undeployed }, null, 2));
    return 0;
  }
  out(`KẾ HOẠCH DEPLOY · main ${short(mainSha)} · production ${short(prod.sha)}${prod.error ? ` (${prod.error})` : ""}`);
  for (const c of undeployed) out(`  ${short(c.sha)} ${pad(c.risk, 8)} ${c.subject.slice(0, 90)}${c.migrations.length ? ` · migration ${c.migrations.join(", ")}` : ""}`);
  out(`\n  ⇒ ${plan.action}: ${plan.why}`);
  for (const n of plan.notes) out(`     ${n}`);
  if (plan.action === "DEPLOY") {
    out(`\n  Lệnh (MỘT lượt, bám run id > BEFORE): dispatch workflow "Deploy ERP to VPS" (deploy-vps.yml) trên ref main`);
    out(`  Sau đó: npm run ai -- verify --sha=${plan.sha} [--record --mission=<mã>]`);
  }
  return 0;
}

async function cmdVerify(ctx: RepoCtx, flags: Set<string>, values: Map<string, string>): Promise<number> {
  gitRun(ctx.top, ["fetch", "--quiet", ctx.config.remote]);
  const want = values.get("sha") ?? ctx.config.integrationRef;
  if (!REF_RE.test(want)) throw new UsageError("--sha=<SHA>");
  const sha = git(ctx.top, ["rev-parse", "--verify", `${want}^{commit}`]);
  const prod = await productionHealth(ctx);
  let expectedMigrations: number | null = null;
  try {
    const j = JSON.parse(gitTry(ctx.top, ["show", `${sha}:drizzle/meta/_journal.json`]) ?? "null") as { entries?: unknown[] } | null;
    expectedMigrations = j && Array.isArray(j.entries) ? j.entries.length : null;
  } catch {
    expectedMigrations = null;
  }
  const gh = githubClient(ctx);
  let deployRun: VerifyInput["deployRun"] = null;
  if (gh) {
    const runs = (await gh.get(`/actions/workflows/deploy-vps.yml/runs?head_sha=${sha}&per_page=10`).catch(() => ({}))) as { workflow_runs?: unknown };
    const rs = arr(runs.workflow_runs);
    const best = rs.find((r) => r.conclusion === "success") ?? rs[0];
    if (best) deployRun = { conclusion: best.conclusion === null ? null : String(best.conclusion), status: String(best.status), url: String(best.html_url) };
  }
  const endpoints: VerifyInput["endpoints"] = [];
  if (ctx.config.healthUrl) {
    const origin = new URL(ctx.config.healthUrl).origin;
    for (const p of ctx.config.verifyEndpoints) {
      try {
        const r = await (fetch as unknown as FetchLike)(`${origin}${p}`, { headers: { "User-Agent": "ai-tech-room" }, signal: AbortSignal.timeout(15000), redirect: "manual" });
        endpoints.push({ path: p, status: r.status });
      } catch {
        endpoints.push({ path: p, status: null });
      }
    }
  }
  const v = verifyVerdict({ expectedSha: sha, health: prod.health, healthError: prod.error, expectedMigrations, deployRun, endpoints });
  out(`HẬU KIỂM PRODUCTION · mong đợi ${short(sha)}`);
  for (const c of v.checks) out(`  ${c.ok ? "✓" : "✗"} ${c.label}`);
  out(`  ⇒ ${v.pass ? "ĐẠT" : "KHÔNG ĐẠT — INCIDENT: không tuyên bố xong. Không có rollback tự động (migration chỉ đi tới); sửa tiến bằng PR mới, hoặc báo chủ shop nếu production hỏng"}`);
  if (flags.has("record")) {
    const id = mustMission(values.get("mission"));
    const stamp = `${v.pass ? "PASS" : "FAIL"} ${sha} ${new Date().toISOString()}`;
    const msg = mutateControl(ctx, controlActor(ctx), (st) => {
      const e = st.entries.find((x) => x.mission_id === id);
      if (!e) return { change: null, result: `✗ ${id} chưa có trong sổ` };
      const next: RegistryEntry = { ...e, updated_at: new Date().toISOString(), status: v.pass ? (CLOSED_STATES.has(e.status) ? e.status : "VERIFYING") : "FAILED", evidence: { ...(e.evidence ?? {}), verify: stamp, deploy: deployRun?.url ?? e.evidence?.deploy } };
      return { change: { put: { [entryFile(id)]: entryJson(next) }, events: [{ kind: v.pass ? "VERIFY_PASS" : "VERIFY_FAIL", mission: id, detail: stamp }], message: `hậu kiểm ${id}: ${v.pass ? "ĐẠT" : "KHÔNG ĐẠT"}` }, result: `✓ đã ghi ${stamp} vào ${id}` };
    });
    out(`  ${msg}`);
  }
  return v.pass ? 0 : 1;
}

async function cmdMetrics(ctx: RepoCtx, flags: Set<string>, values: Map<string, string>): Promise<number> {
  const gh = githubClient(ctx);
  if (!gh) throw new Error("remote không phải GitHub");
  const days = Number(values.get("days") ?? 14);
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new UsageError("--days=1..90");
  gitRun(ctx.top, ["fetch", "--quiet", ctx.config.remote]);
  const sinceMs = Date.now() - days * 86_400_000;
  const since = new Date(sinceMs).toISOString().slice(0, 10);
  const runs = async (wf: string, extra: string) => {
    const outRuns: Record<string, unknown>[] = [];
    for (let page = 1; page <= 5; page++) {
      const r = (await gh.get(`/actions/workflows/${wf}/runs?per_page=100&page=${page}&created=%3E%3D${since}${extra}`)) as { workflow_runs?: unknown };
      const xs = arr(r.workflow_runs);
      outRuns.push(...xs);
      if (xs.length < 100) break;
    }
    return outRuns;
  };
  const mins = (a: unknown, b: unknown) => (Date.parse(String(b)) - Date.parse(String(a))) / 60000;
  const ci = await runs("ci.yml", "&event=pull_request");
  const dep = await runs("deploy-vps.yml", "");
  const done = (xs: Record<string, unknown>[]) => xs.filter((r) => r.status === "completed");
  const rate = (xs: Record<string, unknown>[]) => {
    const s = xs.filter((r) => r.conclusion === "success").length;
    const f = xs.filter((r) => r.conclusion === "failure").length;
    return s + f >= 5 ? f / (s + f) : null;
  };
  const ciDur = done(ci).filter((r) => r.conclusion === "success").map((r) => mins(r.run_started_at, r.updated_at));
  const depOk = done(dep).filter((r) => r.conclusion === "success");
  const depDur = depOk.map((r) => mins(r.run_started_at, r.updated_at));
  const merged: Record<string, unknown>[] = [];
  for (let page = 1; page <= 4; page++) {
    const xs = arr(await gh.get(`/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`));
    merged.push(...xs.filter((p) => p.merged_at && Date.parse(String(p.merged_at)) >= sinceMs));
    if (xs.length < 100 || xs.every((p) => Date.parse(String(p.updated_at)) < sinceMs)) break;
  }
  const lead = merged.map((p) => mins(p.created_at, p.merged_at));
  const coding: number[] = [];
  for (const p of merged.slice(0, 40)) {
    const cs = arr(await gh.get(`/pulls/${p.number}/commits?per_page=100`).catch(() => []));
    const first = cs.map((c) => (isObj(c.commit) && isObj(c.commit.author) ? Date.parse(String(c.commit.author.date)) : NaN)).filter(Number.isFinite).sort((a, b) => a - b)[0];
    if (first) coding.push(Math.max(0, (Date.parse(String(p.created_at)) - first) / 60000));
  }
  const deploysByTime = depOk.map((r) => ({ at: Date.parse(String(r.created_at)), end: Date.parse(String(r.updated_at)), sha: String(r.head_sha) })).sort((a, b) => a.at - b.at);
  const toDeploy: number[] = [];
  for (const p of merged) {
    const m = String(p.merge_commit_sha ?? "");
    const at = Date.parse(String(p.merged_at));
    if (!SHA_RE.test(m)) continue;
    const d = deploysByTime.find((x) => x.at >= at && gitRun(ctx.top, ["merge-base", "--is-ancestor", m, x.sha]).code === 0);
    if (d) toDeploy.push((d.end - at) / 60000);
  }
  const reverts = merged.filter((p) => /^(revert|hoàn tác|gỡ lại)/i.test(String(p.title))).length;
  const st = readControl(ctx, { fetch: true });
  const evIn = (k: string) => st.events.filter((e) => e.kind === k && Date.parse(e.at) >= sinceMs).length;
  const fmt = (v: number | null, unit = "′") => (v === null ? "—" : `${v.toFixed(1)}${unit}`);
  const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
  const stat = (xs: number[]) => ({ n: xs.length, median: xs.length >= 3 ? median(xs) : null, p95: xs.length >= 3 ? quantile(xs, 0.95) : null });
  const res = {
    windowDays: days,
    since,
    codingMinutes: stat(coding),
    leadTimeMinutes: stat(lead),
    ciWallMinutes: stat(ciDur),
    ciFailureRate: rate(done(ci)),
    ciCancelled: done(ci).filter((r) => r.conclusion === "cancelled").length,
    mergeToDeployMinutes: stat(toDeploy),
    deployMinutes: stat(depDur),
    deployFailureRate: rate(done(dep)),
    mergedPrs: merged.length,
    revertRate: merged.length >= 5 ? reverts / merged.length : null,
    duplicatePrevented: evIn("DUPLICATE_PREVENTED"),
    overlapDetected: evIn("OVERLAP_DETECTED"),
    workerUtilization: null as number | null,
  };
  if (flags.has("json")) {
    out(JSON.stringify(res, null, 2));
    return 0;
  }
  out(`ĐO LUỒNG GIAO HÀNG · ${days} ngày từ ${since} (giờ GitHub, phút)`);
  const row = (label: string, s: { n: number; median: number | null; p95: number | null }) => out(`  ${pad(label, 34)} median ${pad(fmt(s.median), 8)} p95 ${pad(fmt(s.p95), 8)} n=${s.n}`);
  row("viết mã (commit đầu → mở PR)", res.codingMinutes);
  row("lead time (mở PR → gộp)", res.leadTimeMinutes);
  row("CI của PR (thời gian tường)", res.ciWallMinutes);
  row("chờ deploy (gộp → lên production)", res.mergeToDeployMinutes);
  row("một lượt deploy", res.deployMinutes);
  out(`  tỷ lệ CI đỏ ${pct(res.ciFailureRate)} · CI bị huỷ ${res.ciCancelled} · deploy đỏ ${pct(res.deployFailureRate)} · revert ${pct(res.revertRate)} (${merged.length} PR đã gộp)`);
  out(`  sổ điều phối: chặn trùng việc ${res.duplicatePrevented} · phát hiện chồng phạm vi ${res.overlapDetected} · độ bận worker: chưa đo được (subagent không để lại mốc trên GitHub)`);
  const parts: [string, number | null][] = [
    ["viết mã", res.codingMinutes.median],
    ["CI", res.ciWallMinutes.median],
    ["chờ deploy", res.mergeToDeployMinutes.median],
    ["deploy", res.deployMinutes.median],
  ];
  const worst = parts.filter((p): p is [string, number] => p[1] !== null).sort((a, b) => b[1] - a[1])[0];
  if (worst) out(`  ⇒ nút thắt lớn nhất (theo median): ${worst[0]} ${worst[1].toFixed(1)}′`);
  return 0;
}

const HELP = `AI Tech Room — docs/ai-tech-room/README.md

  npm run ai -- status [sứ-mệnh…] [--github] [--json]   trạng thái SUY RA từ git + việc chủ shop cần làm
  npm run ai -- next <sứ-mệnh>                           lượt việc kế tiếp: dựng cây · Lead làm · nằm lại (vì sao)
  npm run ai -- spawn <sứ-mệnh> <việc> [--dry-run]       dựng nhánh + cây từ origin/main vừa fetch, ghi phiếu giao việc
  npm run ai -- brief <sứ-mệnh> <việc>                   in phiếu giao việc (dán vào prompt worker)
  npm run ai -- whoami                                   (trong cây worker) in phiếu của chính cây này
  npm run ai -- reconcile <sứ-mệnh>                      nhánh tích hợp đã chạy tiếp: việc nào phải cập nhật
  npm run ai -- ready <sứ-mệnh> <việc>                   đủ điều kiện mở PR chưa (sạch · đẩy · cập nhật · đúng phạm vi)
  npm run ai -- worktrees [--all] [--json]               phân loại MỌI worktree trên máy (chỉ đọc)
  npm run ai -- cleanup <cây|sứ-mệnh:việc|merged> [--apply] [--allow-unowned]
                                                         mặc định CHẠY THỬ; không bao giờ dọn cây bẩn / chưa đẩy
  npm run ai -- validate [sứ-mệnh…]                      kiểm tệp sứ mệnh: DAG, chu trình, phạm vi, sàn rủi ro
  npm run ai -- new <sứ-mệnh> [tiêu đề]                  tạo .ai/missions/<sứ-mệnh>.json mẫu trong cây hiện tại
  npm run ai -- lead <sứ-mệnh> [tiêu đề] [--dry-run]     ĐIỂM VÀO: dựng cây Lead ../wt-<sứ-mệnh> từ origin/main vừa fetch
                                                         (checkout cũ: git show origin/main:scripts/ai-tech.ts > <tạm>/ai-tech.ts && node <tạm>/ai-tech.ts lead …
                                                          — tệp PHẢI tên ai-tech.ts, tên khác thì lệnh không chạy)

MẶT PHẲNG ĐIỀU KHIỂN XUYÊN SỨ MỆNH — docs/ai-tech-room/delivery-v2.md (sổ trên nhánh ai-control/registry)
  npm run ai -- board [--github] [--all] [--json]        BẢNG CHO CHỦ SHOP: mọi sứ mệnh (sổ đối chiếu git/GitHub) · khoá · cần chủ shop
  npm run ai -- intake "<yêu cầu>" --kw=a,b [--paths=…] [--github] [--record]
                                                         CHỐNG TRÙNG: main đã có? sứ mệnh / PR / nhánh nào đang làm? ⇒ EXISTS·PARTIAL·IN_PROGRESS·MISSING
  npm run ai -- claim <mã> [--title=… --branch=… --paths=a,b --after=<mã> --intake=… --status=… --dry-run]
                                                         đăng ký / cập nhật sứ mệnh; TỪ CHỐI khi chồng phạm vi / điểm nóng với sứ mệnh đang mở
  npm run ai -- heartbeat <mã> [--status=…]              nhịp tim (phiên còn sống) + đổi trạng thái
  npm run ai -- close <mã> --status=DONE|CANCELLED --evidence=… [--no-runtime]
                                                         khép + nhả phạm vi / giữ chỗ; DONE đòi bằng chứng đã vào main + verify ĐẠT
  npm run ai -- lease acquire|renew|release|status [integration-lead|tech-lead] [--ttl=phút] [--purpose=…] [--token=…|--resume]
                                                         MỘT chủ gộp/deploy tại một thời điểm (nhãn máy:cây + MÃ PHIÊN); hết hạn là nhả
  npm run ai -- migration next | reserve --mission=<mã> | check [--pr=<số>] [--github]
                                                         giữ chỗ số migration xuyên phiên; check đỏ khi va số với main / PR mở trước / giữ chỗ
  npm run ai -- queue [--json]                           HÀNG ĐỢI GỘP: phụ thuộc · cổng · xung đột · rủi ro ⇒ gộp lô nào, việc nào đi riêng
  npm run ai -- review <PR> --sha=<đầu nhánh> --verdict=PASS|FAIL [--note=…]
                                                         dấu review độc lập (PR rủi ro HIGH) — trong sổ, gắn SHA; commit mới ⇒ mất hiệu lực
  npm run ai -- deploy-plan [--token=…|--resume] [--json]
                                                         MỘT lượt deploy cho cả lô — có được deploy bây giờ không, vì sao
  npm run ai -- verify [--sha=…] [--record --mission=<mã>]
                                                         hậu kiểm production: SHA · migration · lượt deploy + smoke · endpoint công khai
  npm run ai -- metrics [--days=14] [--json]             lead time · CI · chờ deploy · deploy · tỷ lệ đỏ / revert · trùng việc đã chặn
`;

export async function main(argv: readonly string[], cwd: string, opts: { actor?: string } = {}): Promise<number> {
  const a = parseArgs(argv);
  const [cmd, ...rest] = a._;
  if (!cmd || cmd === "help" || a.flags.has("help")) {
    out(HELP);
    return cmd ? 0 : 2;
  }
  const ctx: RepoCtx = { ...openRepo(cwd), actor: opts.actor };
  if (ctx.configErrors.length && cmd !== "validate") throw new Error(`.ai/config.json lỗi:\n  ${ctx.configErrors.join("\n  ")}`);
  switch (cmd) {
    case "status":
      return cmdStatus(ctx, rest, a.flags);
    case "next":
      return cmdNext(ctx, rest[0]);
    case "spawn":
      return cmdSpawn(ctx, rest[0], rest[1], a.flags);
    case "brief":
      return cmdBrief(ctx, rest[0], rest[1]);
    case "whoami":
      return cmdWhoami(ctx);
    case "reconcile":
      return cmdReconcile(ctx, rest[0], a.flags);
    case "ready":
      return cmdReady(ctx, rest[0], rest[1]);
    case "worktrees":
      return cmdWorktrees(ctx, a.flags);
    case "cleanup":
      return cmdCleanup(ctx, a.flags.has("merged") ? [...rest, "merged"] : rest, a.flags);
    case "validate":
      return cmdValidate(ctx, rest);
    case "lead":
      return cmdLead(ctx, rest[0], rest.slice(1), a.flags);
    case "new":
      return cmdNew(ctx, rest[0], rest.slice(1));
    case "board":
      return cmdBoard(ctx, a.flags);
    case "intake":
      return cmdIntake(ctx, rest, a.flags, a.values);
    case "claim":
      return cmdClaim(ctx, rest[0], a.flags, a.values);
    case "heartbeat":
      return cmdHeartbeat(ctx, rest[0], a.values);
    case "close":
      return cmdClose(ctx, rest[0], a.flags, a.values);
    case "lease":
      return cmdLease(ctx, rest[0], rest[1], a.flags, a.values);
    case "migration":
      return cmdMigration(ctx, rest[0], a.flags, a.values);
    case "queue":
      return cmdQueue(ctx, a.flags);
    case "review":
      return cmdReview(ctx, rest[0], a.flags, a.values);
    case "deploy-plan":
      return cmdDeployPlan(ctx, a.flags, a.values);
    case "verify":
      return cmdVerify(ctx, a.flags, a.values);
    case "metrics":
      return cmdMetrics(ctx, a.flags, a.values);
    default:
      throw new UsageError(`lệnh lạ: ${cmd}`);
  }
}

/** Đường dẫn thật (giải 8.3 / symlink) — để so với lời khai của `git worktree list`. */
export function realDir(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

if (/ai-tech\.ts$/.test(process.argv[1] ?? "")) {
  main(process.argv.slice(2), process.cwd()).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`✗ ${(e as Error).message}\n`);
      if (e instanceof UsageError) process.stderr.write(`  npm run ai -- help\n`);
      process.exit(e instanceof UsageError ? 2 : 1);
    },
  );
}

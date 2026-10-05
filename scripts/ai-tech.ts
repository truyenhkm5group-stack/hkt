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
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
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
  hotspots: Hotspot[];
  riskFloor: RiskFloor[];
};

export const DEFAULT_CONFIG: Config = {
  maxImplementationWorkers: 4,
  remote: "origin",
  integrationRef: "origin/main",
  branchPrefix: "claude/",
  worktreePrefix: "wt-",
  activeWithinHours: 24,
  staleAfterDays: 7,
  hotspots: [],
  riskFloor: [],
};

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
  const c: Config = { ...DEFAULT_CONFIG, hotspots: [], riskFloor: [] };
  if (raw === undefined) return { config: c, errors };
  if (!isObj(raw)) return { config: c, errors: ["config: phải là một object JSON"] };
  const num = (k: "maxImplementationWorkers" | "activeWithinHours" | "staleAfterDays", min: number, max: number) => {
    if (raw[k] === undefined) return;
    const v = raw[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) errors.push(`config.${k}: số nguyên ${min}–${max}`);
    else c[k] = v;
  };
  num("maxImplementationWorkers", 0, 8);
  num("activeWithinHours", 1, 24 * 14);
  num("staleAfterDays", 1, 365);
  for (const k of ["remote", "integrationRef"] as const) {
    if (raw[k] === undefined) continue;
    if (!isStr(raw[k]) || !/^[A-Za-z0-9._/-]+$/.test(raw[k] as string)) errors.push(`config.${k}: tên ref không hợp lệ`);
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
  if (raw.integrationRef !== undefined && (!isStr(raw.integrationRef) || !/^[A-Za-z0-9._/-]+$/.test(raw.integrationRef)))
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
    return { status: "MERGED", why: `bằng chứng ${facts.merged}` };
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
    if (facts.remoteBranch && facts.commits > 0)
      return { status: "REVIEW", why: `cây đã gỡ, nhánh còn trên remote (${facts.commits} commit)` };
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
  dirty: number;
  /** Commit không nằm trên BẤT KỲ ref remote nào — thứ duy nhất sẽ mất nếu xoá nhánh. -1 = không đo được. */
  uniqueLocal: number;
  merged: MergeEvidence | null;
  idleHours: number | null;
};

export function classifyWorktree(f: WorktreeFacts, cfg: Config): { cls: WorktreeClass; note: string } {
  if (f.isMain) return { cls: "MAIN", note: "cây chính — không bao giờ dọn" };
  if (f.isCurrent) return { cls: "CURRENT", note: "cây đang chạy lệnh" };
  if (f.prunable) return { cls: "UNKNOWN", note: "thư mục không còn — `git worktree prune` gỡ được siêu dữ liệu" };
  if (f.head === null || f.dirty < 0 || f.idleHours === null) return { cls: "UNKNOWN", note: "không đọc được trạng thái" };
  const stale = f.idleHours >= cfg.staleAfterDays * 24;
  const idle = `${Math.round(f.idleHours)} giờ không động`;
  if (f.dirty > 0) return stale ? { cls: "STALE_DIRTY", note: `${f.dirty} thay đổi chưa commit · ${idle} — CHỈ BÁO, không dọn` } : { cls: "ACTIVE", note: `${f.dirty} thay đổi chưa commit` };
  if (f.merged && f.merged !== "EMPTY" && f.uniqueLocal === 0) return { cls: "MERGED_SAFE_TO_CLEAN", note: `đã vào (${f.merged}) · sạch · mọi commit đều có trên remote` };
  if (f.merged === "ANCESTOR") return { cls: "MERGED_SAFE_TO_CLEAN", note: "đầu nhánh đã nằm trong nhánh tích hợp · sạch" };
  if (f.idleHours < cfg.activeWithinHours) return { cls: "ACTIVE", note: idle };
  const unpushed = f.uniqueLocal > 0 ? ` · ${f.uniqueLocal} commit CHƯA lên remote` : "";
  if (stale) return { cls: "STALE_CLEAN", note: `${idle}${unpushed}` };
  return { cls: "IDLE", note: `${idle}${unpushed}` };
}

export type CleanupDecision = { ok: boolean; refusals: string[]; deleteBranch: boolean };

/**
 * Được dọn KHÔNG. Mỗi lý do từ chối là một cách mất việc đã thấy hoặc tưởng tượng được; không có
 * cờ nào bỏ qua được vế "bẩn" hay "commit chưa lên remote".
 */
export function cleanupDecision(f: WorktreeFacts, cfg: Config, opts: { allowUnowned: boolean }): CleanupDecision {
  const r: string[] = [];
  if (f.isMain) r.push("MAIN: cây chính của kho");
  if (f.isCurrent) r.push("CURRENT: không tự dọn cây đang đứng");
  if (f.locked) r.push("LOCKED: cây đang bị khoá (`git worktree lock`) — chủ của nó chưa cho gỡ");
  if (f.prunable) r.push("PRUNABLE: thư mục đã mất — dùng `git worktree prune`, không phải cleanup");
  if (f.dirty !== 0) r.push(f.dirty < 0 ? "UNKNOWN: không đọc được trạng thái" : `DIRTY: ${f.dirty} thay đổi chưa commit`);
  if (f.merged === null) r.push("NOT_MERGED: không có bằng chứng đã vào nhánh tích hợp");
  if (f.uniqueLocal !== 0 && f.merged !== "ANCESTOR")
    r.push(f.uniqueLocal < 0 ? "UNPUSHED?: không đo được commit chưa lên remote" : `UNPUSHED: ${f.uniqueLocal} commit chỉ có ở máy này`);
  const recent = f.idleHours === null || f.idleHours < cfg.activeWithinHours;
  if (f.merged === "EMPTY" && recent) r.push("EMPTY_BUT_RECENT: chưa có commit nào nhưng vừa được dùng — có thể worker mới bắt đầu");
  if (!f.owner) {
    if (!opts.allowUnowned) r.push("UNOWNED: cây không có phiếu giao việc của AI Tech Room — không biết ai đang giữ (thêm --allow-unowned nếu chủ shop cho phép)");
    else if (recent) r.push("UNOWNED_RECENT: cây không rõ chủ và vừa được dùng trong " + cfg.activeWithinHours + " giờ qua");
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
    return m && m.schema === 1 && m.mission && m.task ? m : null;
  } catch {
    return null;
  }
}

function writeManifest(worktree: string, m: Manifest): string {
  const dir = adminDirOf(worktree);
  if (!dir) throw new Error(`không tìm được thư mục quản trị git của ${worktree}`);
  const file = path.join(dir, MANIFEST_FILE);
  writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
  writeFileSync(path.join(dir, "ai-tech-brief.md"), renderBrief(m));
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

/**
 * Bằng chứng đã vào `ref`. Thứ tự từ mạnh tới yếu; trả `null` khi không chứng minh được — và
 * `null` nghĩa là KHÔNG DỌN, kể cả khi thực ra đã vào. Báo thiếu ở đây an toàn, báo thừa thì không.
 */
export function mergeEvidence(cwd: string, tip: string | null, ref: string, opts: { baseSha?: string; pr?: number } = {}): MergeEvidence | null {
  if (!tip) return null;
  const own = opts.baseSha ? countRange(cwd, [`${opts.baseSha}..${tip}`]) : -1;
  if (opts.baseSha && own === 0) return "EMPTY";
  if (gitRun(cwd, ["merge-base", "--is-ancestor", tip, ref]).code === 0) return "ANCESTOR";
  if (opts.pr) {
    const hit = gitTry(cwd, ["log", "-n", "2000", "--format=%s", "--fixed-strings", `--grep=(#${opts.pr})`, ref]);
    if (hit && hit.split(/\r?\n/).some((s) => s.trimEnd().endsWith(`(#${opts.pr})`))) return "PR_SUBJECT";
  }
  const mb = gitTry(cwd, ["merge-base", tip, ref]);
  if (!mb) return null;
  const files = (gitTry(cwd, ["diff", "--name-only", "--no-renames", mb, tip]) ?? "").split(/\r?\n/).filter(Boolean);
  if (files.length === 0 || files.length > 300) return null;
  return gitRun(cwd, ["diff", "--quiet", tip, ref, "--", ...files]).code === 0 ? "CONTENT" : null;
}

/* ═════════════ 9 · NGỮ CẢNH KHO ═════════════ */

export type RepoCtx = { cwd: string; top: string; mainWorktree: string; worktreeParent: string; config: Config; configErrors: string[] };

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
  const wt = wts.find((w) => samePath(w.path, t.run?.worktree ?? "") && !w.prunable);
  const dirty = wt ? dirtyCount(wt.path).n : 0;
  const commits = tip ? countRange(ctx.top, [`${t.run.baseSha}..${tip}`]) : 0;
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
    dirty: d.n,
    uniqueLocal,
    merged: e.prunable ? null : mergeEvidence(ctx.top, tip, ref, { baseSha: manifest?.baseSha }),
    idleHours: e.prunable ? null : idleHoursOf(e.path, d.files, now),
  };
}

/** Số cây WORKER đang chạy trên cả máy — chỉ đếm cây có phiếu (cây lạ không rõ là việc hay rác). */
export function globalRunningWorkers(ctx: RepoCtx, wts: readonly WorktreeEntry[]): { n: number; who: string[] } {
  const who: string[] = [];
  for (const w of wts) {
    if (w.prunable || w.bare) continue;
    const m = readManifest(w.path);
    if (!m || !w.head) continue;
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
4. Commit tiếng Việt có dấu, chỉ tệp của việc này (\`git add <tệp>\`, không \`git add -A\`). Không ghi tên model AI.
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
type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

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

/* ═════════════ 12 · LỆNH ═════════════ */

type Args = { _: string[]; flags: Set<string> };
function parseArgs(argv: readonly string[]): Args {
  const a: Args = { _: [], flags: new Set() };
  for (const x of argv) {
    if (x.startsWith("--")) a.flags.add(x.slice(2));
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
  const problems: string[] = [];
  if (gitTry(ctx.top, ["check-ref-format", "--branch", branch]) === null) problems.push(`tên nhánh ${branch} không hợp lệ`);
  if (gitTry(ctx.top, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) problems.push(`nhánh ${branch} đã tồn tại ở máy này`);
  if (gitTry(ctx.top, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`])) problems.push(`nhánh ${remote}/${branch} đã tồn tại`);
  const reg = wts.find((w) => samePath(w.path, wtPath));
  if (reg) problems.push(`worktree ${wtPath} đã được đăng ký (nhánh ${reg.branch ?? "tách rời"})`);
  else if (existsSync(wtPath)) problems.push(`thư mục ${wtPath} đã tồn tại`);
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
  process.stdout.write(renderBrief(m));
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
  const changed = tip ? (gitTry(ctx.top, ["diff", "--name-only", "--no-renames", `${t.run.baseSha}..${tip}`]) ?? "").split(/\r?\n/).filter(Boolean) : [];
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
      for (const w of wts) if (readManifest(w.path)) chosen.push(w);
      continue;
    }
    const m = /^([a-z0-9-]+):([a-z0-9-]+)$/.exec(t);
    if (m) {
      const { mission } = requireMission(ctx, m[1]);
      const task = mission.tasks.find((x) => x.id === m[2]);
      const w = task?.run ? wts.find((x) => samePath(x.path, task.run?.worktree ?? "")) : undefined;
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
    const d = cleanupDecision(f, ctx.config, { allowUnowned: flags.has("allow-unowned") });
    if (!d.ok) {
      refused++;
      out(`  ✗ ${w.path}\n      ${d.refusals.join("\n      ")}`);
      continue;
    }
    out(`  ✓ ${w.path} — git worktree remove${d.deleteBranch ? ` · git branch -D ${f.branch}` : ""}`);
    if (!apply) continue;
    // Không --force: git tự từ chối nếu cây bẩn — lớp an toàn thứ hai, phòng khi trạng thái đổi giữa lúc đo và lúc làm.
    const rm = gitRun(ctx.top, ["worktree", "remove", w.path]);
    if (rm.code !== 0) {
      refused++;
      out(`      git từ chối: ${rm.err}`);
      continue;
    }
    if (d.deleteBranch && f.branch) {
      // -D an toàn ở đây VÌ đã chứng minh: mọi commit có trên remote hoặc đã nằm trong nhánh tích hợp.
      const br = gitRun(ctx.top, ["branch", "-D", f.branch]);
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
  if (!t?.run) return;
  t.run.cleanedAt = new Date().toISOString();
  if (f.head) t.run.mergedTip = f.head;
  if (f.merged && f.merged !== "EMPTY") t.run.mergedEvidence = f.merged;
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
}

function cmdNew(ctx: RepoCtx, id: string | undefined, title: string[]): number {
  if (!id || !SLUG_RE.test(id)) throw new UsageError(`tên sứ mệnh phải khớp ${SLUG_RE}`);
  const file = path.join(missionsDir(ctx), `${id}.json`);
  if (existsSync(file)) throw new Error(`${file} đã có`);
  const m = {
    schema: 1,
    id,
    title: title.join(" ") || id,
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
  writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
  out(`✓ ${file}\n  sửa tasks rồi: npm run ai -- validate ${id}`);
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
  npm run ai -- new <sứ-mệnh> [tiêu đề]                  tạo .ai/missions/<sứ-mệnh>.json mẫu
`;

export async function main(argv: readonly string[], cwd: string): Promise<number> {
  const a = parseArgs(argv);
  const [cmd, ...rest] = a._;
  if (!cmd || cmd === "help" || a.flags.has("help")) {
    out(HELP);
    return cmd ? 0 : 2;
  }
  const ctx = openRepo(cwd);
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
    case "new":
      return cmdNew(ctx, rest[0], rest.slice(1));
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

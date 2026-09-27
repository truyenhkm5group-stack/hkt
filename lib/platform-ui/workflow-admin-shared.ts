import { DEPARTMENT_LABEL, DEPARTMENT_ORDER } from "@/lib/constants/departments";
import { DOMAIN_EVENTS, domainEventLabel, type DomainEventSpec } from "@/lib/constants/domain-events";
import { objectDef } from "@/lib/constants/object-registry";
import { WORK_PRIORITIES, WORK_PRIORITY_LABEL } from "@/lib/constants/work";
import type { FieldError, FieldOption, FieldRef, FieldType, ListFilterOp } from "@/lib/metadata/types";
import { errorsFor, FILTER_OP_LABEL, filterOpsFor, NUMERIC_TYPES, suggestFieldKey, type CatalogField } from "@/lib/platform-ui/metadata-admin-shared";
import type {
  TaskPriority,
  WorkflowAction,
  WorkflowCondition,
  WorkflowGate,
  WorkflowMode,
  WorkflowRule,
  WorkflowRuleStatus,
  WorkflowRunStatus,
  WorkflowStep,
  WorkflowTrigger,
} from "@/lib/workflow/types";

/**
 * ═══════════ GIAO DIỆN LUẬT TỰ ĐỘNG — PHẦN THUẦN, DÙNG CHUNG MÁY CHỦ + TRÌNH DUYỆT ═══════════
 *
 * Hai màn hình `/settings/workflows` (danh sách) và `/settings/workflows/[id]` (form luật) cùng lõi
 * `lib/platform-ui/workflow-admin.ts` đọc tệp này. Không đọc CSDL, không import gì chỉ-máy-chủ.
 *
 * Form KHÔNG vẽ sơ đồ: luật là bốn khối ô chọn — KHI NÀO · ĐIỀU KIỆN · LÀM GÌ · CỬA DUYỆT (phase-3-plan §5).
 * Bản nháp của form (`RuleDraft`) giữ mọi ô ở dạng CHỮ như người gõ; `draftToInput()` mới đổi sang hình của
 * hợp đồng (`docs/platform/phase-3-contracts.md` mục 2) — số thành số, danh sách thành mảng, ô trống thành
 * không có. Kiểm ở đây chỉ để báo sớm; dịch vụ `lib/workflow/rules.ts` kiểm lại và câu của nó mới là lời
 * cuối, in NGUYÊN VĂN dưới đúng ô.
 */

// ═══════════ NHÃN ═══════════

export const RULE_STATUS_LABEL: Record<WorkflowRuleStatus, string> = {
  DRAFT: "Nháp",
  ACTIVE: "Đang bật",
  PAUSED: "Tạm dừng",
  ARCHIVED: "Đã lưu trữ",
};

export const RULE_STATUS_TONE: Record<WorkflowRuleStatus, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  ACTIVE: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  PAUSED: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  ARCHIVED: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
};

export const MODE_LABEL: Record<WorkflowMode, string> = {
  DRY_RUN: "Chạy thử",
  LIVE: "Chạy thật",
};

export const MODE_TONE: Record<WorkflowMode, string> = {
  DRY_RUN: "bg-sky-50 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300",
  LIVE: "bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200",
};

export const RUN_STATUS_LABEL: Record<WorkflowRunStatus, string> = {
  DRY_RUN: "Chạy thử — không làm thật",
  PENDING: "Đang chờ chạy",
  WAITING_APPROVAL: "Chờ duyệt",
  DONE: "Đã làm",
  SKIPPED: "Bỏ qua",
  FAILED: "Lỗi",
  REJECTED: "Bị từ chối",
};

/**
 * Nhãn của MỘT lượt chạy. `SKIPPED` mang hai nghĩa ở bộ máy: không có câu lỗi = điều kiện KHÔNG KHỚP (lượt ghi lại
 * để người khai luật thấy vì sao luật không làm gì); có câu lỗi = bỏ qua vì lý do khác (luật đổi phiên bản trong lúc
 * chờ duyệt…) — câu lỗi in ngay dưới nhãn. Gộp hai nghĩa làm một nhãn là để người đọc đi tìm sai chỗ.
 */
export function runStatusLabel(status: WorkflowRunStatus, error: string | null): string {
  if (status === "SKIPPED" && !error) return "Bỏ qua — không khớp điều kiện";
  return RUN_STATUS_LABEL[status];
}

export const RUN_STATUS_TONE: Record<WorkflowRunStatus, string> = {
  DRY_RUN: "bg-sky-50 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300",
  PENDING: "bg-muted text-muted-foreground",
  WAITING_APPROVAL: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  DONE: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  SKIPPED: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
  FAILED: "bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200",
  REJECTED: "bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-200",
};

export const STEP_STATUS_LABEL: Record<WorkflowStep["status"], string> = {
  PLANNED: "Sẽ làm",
  DONE: "Đã làm",
  FAILED: "Lỗi",
  SKIPPED: "Bỏ qua",
};

export const ACTION_KIND_LABEL: Record<WorkflowAction["kind"], string> = {
  create_task: "Tạo việc",
  notify: "Báo trong ERP",
  set_custom_value: "Ghi giá trị",
};

export const TRIGGER_KIND_LABEL: Record<WorkflowTrigger["kind"], string> = {
  event: "Sự kiện hệ thống",
  custom_status: "Trạng thái nghiệp vụ đổi",
};

/** Lượt chạy chờ duyệt: yêu cầu nằm ở hàng đợi duyệt đã có — trang Cần xử lý (`/alerts`) và bàn làm việc `/work`. */
export const APPROVAL_QUEUE_HREF = "/alerts";

export const PRIORITY_OPTIONS: { value: TaskPriority; label: string }[] = WORK_PRIORITIES.map((p) => ({ value: p, label: WORK_PRIORITY_LABEL[p] }));
export const DEPARTMENT_OPTIONS: { value: string; label: string }[] = DEPARTMENT_ORDER.map((d) => ({ value: d, label: DEPARTMENT_LABEL[d] }));

// ═══════════ SỰ KIỆN CHỌN ĐƯỢC ═══════════

/** Sự kiện riêng của lượt đổi trạng thái nghiệp vụ custom — chọn qua khối «Trạng thái nghiệp vụ đổi», không qua danh sách sự kiện. */
export const CUSTOM_STATUS_EVENT = "custom_status.changed";

export type EventOption = { name: string; label: string; subjectType: string };

/**
 * Sự kiện chọn được làm trigger: tên ĐANG PHÁT (`LIVE`) trong sổ — tên `RESERVED` chưa ai phát, chọn là một luật
 * không bao giờ chạy. Bỏ `workflow.*` (luật nghe chính workflow là vòng lặp — W7) và sự kiện trạng thái custom
 * (đã có khối riêng, chọn được đối tượng + field + giá trị).
 */
export function workflowEventOptions(): EventOption[] {
  const specs: readonly DomainEventSpec[] = DOMAIN_EVENTS;
  return specs.filter((e) => e.status === "LIVE" && !e.name.startsWith("workflow.") && e.name !== CUSTOM_STATUS_EVENT).map((e) => ({
    name: e.name,
    label: domainEventLabel(e.name),
    subjectType: e.subjectType,
  }));
}

// ═══════════ DANH MỤC FIELD THEO ĐỐI TƯỢNG ═══════════

/** Field custom kiểu «Trạng thái nghiệp vụ» của một đối tượng — nguồn của trigger `custom_status`. */
export type StatusFieldOption = { key: string; label: string; options: { value: string; label: string }[] };

/** Một đối tượng nhìn từ form luật: danh mục field (điều kiện) + field trạng thái custom (trigger). */
export type WorkflowObjectOption = { key: string; label: string; catalog: CatalogField[]; statusFields: StatusFieldOption[] };

export function statusFieldsOf(catalog: readonly CatalogField[]): StatusFieldOption[] {
  return catalog
    .filter((c) => !c.system && c.type === "status")
    .map((c) => ({ key: c.ref.slice("custom:".length), label: c.label, options: c.options.map((o: FieldOption) => ({ value: o.value, label: o.label })) }));
}

/**
 * Đối tượng mà điều kiện / hành động ghi giá trị của luật nói tới: trigger trạng thái ⇒ đối tượng đã chọn;
 * trigger sự kiện ⇒ `subjectType` của sự kiện NẾU nó là một đối tượng trong sổ (vd lệnh sản xuất); còn lại
 * `null` — sự kiện không gắn đối tượng nào có field khai trong sổ.
 */
export function subjectObjectKey(draft: Pick<RuleDraft, "triggerKind" | "event" | "objectKey">, events: readonly EventOption[]): string | null {
  if (draft.triggerKind === "custom_status") return draft.objectKey || null;
  const subject = events.find((e) => e.name === draft.event)?.subjectType ?? null;
  return subject && objectDef(subject) ? subject : null;
}

// ═══════════ BẢN NHÁP CỦA FORM ═══════════

export type ConditionRowDraft = { field: string; op: ListFilterOp; value: string };

export type ActionDraft =
  | { kind: "create_task"; title: string; summary: string; departmentCode: string; priority: TaskPriority; dueInHours: string }
  | { kind: "notify"; message: string }
  | { kind: "set_custom_value"; field: string; value: string };

export type RuleDraft = {
  name: string;
  key: string;
  description: string;
  triggerKind: WorkflowTrigger["kind"];
  event: string;
  objectKey: string;
  fieldKey: string;
  to: string[];
  from: string[];
  match: "all" | "any";
  conditions: ConditionRowDraft[];
  /**
   * Điều kiện ĐÃ LƯU mà form một tầng không vẽ lại được (nhóm lồng nhóm — dịch vụ nhận được, form này thì
   * không). Giữ NGUYÊN khi lưu, thay vì làm phẳng và đổi nghĩa luật mà người sửa không hề biết.
   */
  lockedConditions: WorkflowCondition | null;
  actions: ActionDraft[];
  gateOn: boolean;
  gateReason: string;
};

export function blankRuleDraft(): RuleDraft {
  return { name: "", key: "", description: "", triggerKind: "event", event: "", objectKey: "", fieldKey: "", to: [], from: [], match: "all", conditions: [], lockedConditions: null, actions: [], gateOn: false, gateReason: "" };
}

export function blankAction(kind: ActionDraft["kind"]): ActionDraft {
  if (kind === "create_task") return { kind, title: "", summary: "", departmentCode: "", priority: "NORMAL", dueInHours: "" };
  if (kind === "notify") return { kind, message: "" };
  return { kind, field: "", value: "" };
}

function valueToText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map((v) => String(v)).join(", ");
  return String(value);
}

function isLeaf(c: WorkflowCondition): c is Extract<WorkflowCondition, { field: FieldRef }> {
  return "field" in c;
}

/** Điều kiện đã lưu ⇒ các dòng của form. `null` = form một tầng không vẽ được (nhóm lồng nhau). */
export function conditionToRows(cond: WorkflowCondition | null): { match: "all" | "any"; rows: ConditionRowDraft[] } | null {
  if (!cond) return { match: "all", rows: [] };
  const toRow = (c: WorkflowCondition): ConditionRowDraft | null => (isLeaf(c) ? { field: c.field, op: c.op, value: valueToText(c.value) } : null);
  if (isLeaf(cond)) return { match: "all", rows: [toRow(cond) as ConditionRowDraft] };
  const match = "all" in cond ? "all" : "any";
  const children = "all" in cond ? cond.all : cond.any;
  const rows = children.map(toRow);
  if (rows.some((r) => r === null)) return null;
  return { match, rows: rows as ConditionRowDraft[] };
}

function actionToDraft(a: WorkflowAction): ActionDraft {
  if (a.kind === "create_task") {
    return { kind: a.kind, title: a.title, summary: a.summary ?? "", departmentCode: a.departmentCode ?? "", priority: a.priority ?? "NORMAL", dueInHours: a.dueInHours === undefined ? "" : String(a.dueInHours) };
  }
  if (a.kind === "notify") return { kind: a.kind, message: a.message };
  return { kind: a.kind, field: a.field, value: valueToText(a.value) };
}

export function ruleToDraft(rule: Pick<WorkflowRule, "name" | "key" | "description" | "trigger" | "conditions" | "actions" | "gate">): RuleDraft {
  const cond = conditionToRows(rule.conditions);
  const t = rule.trigger;
  return {
    name: rule.name,
    key: rule.key,
    description: rule.description ?? "",
    triggerKind: t.kind,
    event: t.kind === "event" ? t.event : "",
    objectKey: t.kind === "custom_status" ? t.objectKey : "",
    fieldKey: t.kind === "custom_status" ? t.fieldKey : "",
    to: t.kind === "custom_status" ? [...t.to] : [],
    from: t.kind === "custom_status" ? [...(t.from ?? [])] : [],
    match: cond?.match ?? "all",
    conditions: cond?.rows ?? [],
    lockedConditions: cond ? null : rule.conditions,
    actions: rule.actions.map(actionToDraft),
    gateOn: rule.gate !== null && rule.gate !== undefined,
    gateReason: rule.gate?.reason ?? "",
  };
}

// ═══════════ BẢN NHÁP ⇒ ĐẦU VÀO CỦA DỊCH VỤ ═══════════

/** Đầu vào lưu luật — đúng các khoá của hợp đồng mục 2; `status` / `mode` / `version` do máy chủ gán. */
export type WorkflowRuleInput = {
  key: string;
  name: string;
  description: string | null;
  trigger: WorkflowTrigger;
  conditions: WorkflowCondition | null;
  actions: WorkflowAction[];
  gate: WorkflowGate;
};

function typeOf(ref: string, catalog: readonly CatalogField[]): FieldType | null {
  return catalog.find((c) => c.ref === ref)?.type ?? null;
}

/**
 * Chữ người gõ ⇒ giá trị của phép so. Số chỉ đổi khi field là số VÀ chữ là số hợp lệ — chữ lạ đi nguyên văn
 * để dịch vụ từ chối bằng câu của nó, thay vì bị lặng lẽ biến thành 0.
 */
export function parseValue(raw: string, op: ListFilterOp, type: FieldType | null): unknown {
  if (op === "empty" || op === "not_empty") return undefined;
  const one = (s: string): unknown => {
    const t = s.trim();
    if (type && NUMERIC_TYPES.includes(type) && t !== "" && Number.isFinite(Number(t))) return Number(t);
    if (type === "boolean") return t === "true" ? true : t === "false" ? false : t;
    return t;
  };
  if (op === "in") return raw.split(",").map((s) => s.trim()).filter(Boolean).map(one);
  return one(raw);
}

function optionalText(s: string): string | undefined {
  return s.trim() ? s.trim() : undefined;
}

export function draftToInput(draft: RuleDraft, catalog: readonly CatalogField[]): WorkflowRuleInput {
  const trigger: WorkflowTrigger =
    draft.triggerKind === "event"
      ? { kind: "event", event: draft.event }
      : { kind: "custom_status", objectKey: draft.objectKey, fieldKey: draft.fieldKey, to: [...draft.to], ...(draft.from.length ? { from: [...draft.from] } : {}) };
  let conditions: WorkflowCondition | null;
  if (draft.lockedConditions) conditions = draft.lockedConditions;
  else if (draft.conditions.length === 0) conditions = null;
  else {
    const leaves: WorkflowCondition[] = draft.conditions.map((r) => {
      const value = parseValue(r.value, r.op, typeOf(r.field, catalog));
      return value === undefined ? { field: r.field as FieldRef, op: r.op } : { field: r.field as FieldRef, op: r.op, value };
    });
    conditions = draft.match === "all" ? { all: leaves } : { any: leaves };
  }
  const actions: WorkflowAction[] = draft.actions.map((a) => {
    if (a.kind === "create_task") {
      const hours = a.dueInHours.trim();
      const summary = optionalText(a.summary);
      return {
        kind: a.kind,
        title: a.title.trim(),
        ...(summary ? { summary } : {}),
        ...(a.departmentCode ? { departmentCode: a.departmentCode } : {}),
        priority: a.priority,
        ...(hours ? { dueInHours: Number(hours) } : {}),
      };
    }
    if (a.kind === "notify") return { kind: a.kind, message: a.message.trim() };
    return { kind: a.kind, field: a.field, value: parseValue(a.value, "eq", typeOf(`custom:${a.field}`, catalog)) };
  });
  return {
    key: draft.key.trim(),
    name: draft.name.trim(),
    description: optionalText(draft.description) ?? null,
    trigger,
    conditions,
    actions,
    gate: draft.gateOn ? { kind: "approval", reason: draft.gateReason.trim() } : null,
  };
}

// ═══════════ KIỂM SỚM ═══════════

/** Gợi ý khoá luật từ tên: bỏ dấu, chữ thường, `_` — cùng bộ gợi ý với khoá field (chỉ là GỢI Ý, sửa được trước khi lưu). */
export function suggestRuleKey(name: string, taken: ReadonlySet<string> = new Set()): string {
  return suggestFieldKey(name, taken);
}

/** Khoá lỗi của một dòng điều kiện — trùng đường dẫn mà lược đồ của dịch vụ báo (`conditions.all.2.value`). */
export function conditionErrorName(match: "all" | "any", index: number): string {
  return `conditions.${match}.${index}`;
}

/**
 * Kiểm sớm để UX — dịch vụ kiểm lại (tên sự kiện có trong sổ, field có thật, giá trị trạng thái có thật, W7…).
 * Khoá lỗi dùng cùng tên thuộc tính với đầu vào để màn hình đặt câu báo dưới đúng ô.
 */
export function checkRuleDraft(draft: RuleDraft, opts: { creating: boolean; takenKeys: ReadonlySet<string> }): FieldError[] {
  const errors: FieldError[] = [];
  if (!draft.name.trim()) errors.push({ field: "name", message: "Tên luật không được để trống." });
  if (opts.creating) {
    const key = draft.key.trim();
    if (!/^[a-z][a-z0-9_]{1,40}$/.test(key)) errors.push({ field: "key", message: "Khoá chỉ gồm chữ thường không dấu, số và «_», bắt đầu bằng chữ, 2–41 ký tự." });
    else if (opts.takenKeys.has(key)) errors.push({ field: "key", message: `Khoá «${key}» đã có luật khác dùng.` });
  }
  if (draft.triggerKind === "event") {
    if (!draft.event) errors.push({ field: "trigger.event", message: "Chọn sự kiện kích hoạt luật." });
  } else {
    if (!draft.objectKey) errors.push({ field: "trigger.objectKey", message: "Chọn đối tượng." });
    else if (!draft.fieldKey) errors.push({ field: "trigger.fieldKey", message: "Chọn field trạng thái nghiệp vụ." });
    else if (draft.to.length === 0) errors.push({ field: "trigger.to", message: "Chọn ít nhất một giá trị ĐÍCH — luật chạy khi trạng thái đổi SANG giá trị đó." });
  }
  if (!draft.lockedConditions) {
    draft.conditions.forEach((r, i) => {
      const name = conditionErrorName(draft.match, i);
      if (!r.field) errors.push({ field: `${name}.field`, message: "Chọn field." });
      if (r.op !== "empty" && r.op !== "not_empty" && !r.value.trim()) errors.push({ field: `${name}.value`, message: "Nhập giá trị so." });
    });
  }
  if (draft.actions.length === 0) errors.push({ field: "actions", message: "Luật cần ít nhất một việc để làm." });
  if (draft.actions.filter((a) => a.kind === "notify").length > 1) errors.push({ field: "actions", message: "Mỗi luật tối đa MỘT thông báo — một tin gom cho lượt chạy (luật 26)." });
  draft.actions.forEach((a, i) => {
    if (a.kind === "create_task") {
      if (a.title.trim().length < 2) errors.push({ field: `actions.${i}.title`, message: "Tiêu đề việc quá ngắn." });
      const h = a.dueInHours.trim();
      if (h && !(Number.isInteger(Number(h)) && Number(h) >= 1)) errors.push({ field: `actions.${i}.dueInHours`, message: "Hạn tính bằng giờ nguyên, từ 1 trở lên." });
    } else if (a.kind === "notify") {
      if (!a.message.trim()) errors.push({ field: `actions.${i}.message`, message: "Nội dung báo không được để trống." });
    } else if (!a.field) errors.push({ field: `actions.${i}.field`, message: "Chọn field tuỳ biến để ghi." });
  });
  if (draft.gateOn && draft.gateReason.trim().length < 3) errors.push({ field: "gate.reason", message: "Nói lý do cần người duyệt — người duyệt đọc câu này trước khi bấm." });
  return errors;
}

/** Lỗi không thuộc ô nào đang hiện — in ở đầu form, không bao giờ biến mất. */
export function orphanErrors(errors: readonly FieldError[], shown: readonly string[]): FieldError[] {
  return errors.filter((e) => !shown.some((name) => errorsFor([e], name).length > 0));
}

// ═══════════ TÓM TẮT ═══════════

/** Một dòng «khi nào» cho bảng danh sách. */
export function triggerSummary(trigger: WorkflowTrigger): string {
  if (trigger.kind === "event") return `Sự kiện · ${domainEventLabel(trigger.event)}`;
  const obj = objectDef(trigger.objectKey)?.label ?? trigger.objectKey;
  const from = trigger.from?.length ? `${trigger.from.join(" / ")} → ` : "→ ";
  return `${obj} · ${trigger.fieldKey} ${from}${trigger.to.join(" / ")}`;
}

/** Phép so hợp với field (theo kiểu); field lạ / không có danh mục ⇒ mọi phép so. */
export function opsForField(ref: string, catalog: readonly CatalogField[]): { value: ListFilterOp; label: string }[] {
  const type = typeOf(ref, catalog);
  const ops: ListFilterOp[] = type ? filterOpsFor(type) : (Object.keys(FILTER_OP_LABEL) as ListFilterOp[]);
  return ops.map((op) => ({ value: op, label: FILTER_OP_LABEL[op] }));
}

/**
 * Hộp xác nhận chuyển CHẠY THẬT nói đúng những gì máy SẼ làm với luật NÀY — liệt kê theo loại hành động có
 * trong luật, không một câu chung chung.
 */
export function liveConsequences(actions: readonly WorkflowAction[], gate: WorkflowGate): string[] {
  const out: string[] = [];
  const kinds = new Set(actions.map((a) => a.kind));
  if (kinds.has("create_task")) out.push("TẠO VIỆC THẬT trong hàng đợi của phòng được chọn — người trong phòng sẽ thấy và phải xử lý.");
  if (kinds.has("notify")) out.push("GỬI BÁO THẬT trong ERP tới người của phòng / quản trị.");
  if (kinds.has("set_custom_value")) out.push("GHI GIÁ TRỊ THẬT vào field tuỳ biến của bản ghi — người xem bản ghi thấy giá trị mới.");
  if (gate) out.push("Trước mỗi lượt, máy xin DUYỆT và chỉ làm sau khi một người duyệt.");
  return out;
}

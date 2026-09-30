/**
 * ═══════════ SỔ LUẬT TỰ ĐỘNG (Phase 3 · W1) — CHỈ MÁY CHỦ ═══════════
 *
 * Hợp đồng: docs/platform/phase-3-contracts.md mục 4. Một cửa duy nhất ghi `workflow_rules`; mọi lượt ghi ⇒
 * `audit()` entity `WORKFLOW_RULE` kèm TRƯỚC/SAU. Quyền (`workflow:manage`) kiểm ở tầng action.
 *
 * Luật không thương lượng:
 *  · LUÔN LƯU NHÁP. Luật mới sinh ra ở `DRAFT` + `DRY_RUN` (luật 23, 25 của AGENTS.md); sửa một luật đang
 *    `ACTIVE` / `PAUSED` đưa nó về `DRAFT` + `DRY_RUN` và TĂNG phiên bản — người sửa phải bật lại có chủ đích,
 *    và lượt chạy nào cũng ghi phiên bản luật nó đã dùng.
 *  · Khoá `^[a-z][a-z0-9_]{1,40}$`, BẤT BIẾN, duy nhất trong tổ chức (ảnh chụp `meta_config_versions` và email
 *    máy `workflow:<khoá>` trong nhật ký gắn theo nó).
 *  · Mọi tham chiếu phải CÓ THẬT lúc lưu: tên sự kiện trong sổ khai, đối tượng trong sổ đối tượng, field custom
 *    kiểu `status` ACTIVE với giá trị trong tuỳ chọn, phòng ban trong CSDL. Kiểm LẠI lúc bật (field có thể đã
 *    bị lưu trữ sau khi luật được lưu).
 *  · Chặn vòng lặp trực tiếp: luật nghe `custom_status.changed` mà lại ghi CHÍNH field đó. Vòng lặp gián tiếp
 *    (A ghi B, B ghi A) bị chặn lúc CHẠY bằng độ sâu nhân quả (W7).
 *  · `ARCHIVED` là điểm cuối — không sửa, không bật lại (khuôn "không xoá — lưu trữ" của Phase 2).
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { GENERIC_MESSAGE_VAR_KEYS, isMessagingConnector, MESSAGE_TEMPLATE_MAX, ORDER_MESSAGE_VAR_KEYS, unknownTemplateKeys } from "@/lib/messaging/types";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { DEPARTMENT_CODES } from "@/lib/constants/departments";
import { DOMAIN_EVENT_BY_NAME, METADATA_RECORD_SUBJECT } from "@/lib/constants/domain-events";
import { isObjectKey } from "@/lib/constants/object-registry";
import { checkObject, isUniqueViolation, loadCustomDefs } from "@/lib/metadata/common";
import { resolveObject } from "@/lib/metadata/object-resolver";
import { zodFieldErrors } from "@/lib/metadata/fields";
import { FIELD_KEY_PATTERN, type CustomFieldDef, type FieldError, type MetadataActor } from "@/lib/metadata/types";
import { validateCustomValues } from "@/lib/metadata/validate";
import { ensureEventCursor } from "@/lib/workflow/cursor";
import { conditionDepth, WORKFLOW_CONDITION_MAX_DEPTH, WORKFLOW_CONDITION_OPS } from "@/lib/workflow/evaluate";
import { EVENT_SUBJECT_REFS, PAYLOAD_REF_PREFIX } from "@/lib/workflow/subject";
import { recordEventObjectProblem } from "@/lib/workflow/trigger-object";
import type { WorkflowAction, WorkflowCondition, WorkflowGate, WorkflowMode, WorkflowRule, WorkflowRuleStatus, WorkflowTrigger } from "@/lib/workflow/types";

export const WORKFLOW_RULE_KEY_PATTERN = /^[a-z][a-z0-9_]{1,40}$/;
/** Sự kiện phát ra từ chính custom field — nguồn trigger `custom_status`. */
export const CUSTOM_STATUS_EVENT = "custom_status.changed";
export const WORKFLOW_MAX_ACTIONS = 10;

export type WorkflowActor = MetadataActor;
export type WorkflowErrorCode = "INVALID" | "NOT_FOUND" | "CONFLICT";
export type WorkflowFailure = { ok: false; code: WorkflowErrorCode; errors: FieldError[] };
export type WorkflowRuleResult = { ok: true; rule: WorkflowRule } | WorkflowFailure;

function failW(code: WorkflowErrorCode, errors: FieldError[] | string, field = "_"): WorkflowFailure {
  return { ok: false, code, errors: typeof errors === "string" ? [{ field, message: errors }] : errors };
}

/** Email MÁY của một luật — `requested_by_email`, nhật ký, người tạo việc. Không phải một tài khoản (luật 36). */
export function machineEmailOf(ruleKey: string): string {
  return `workflow:${ruleKey}`;
}

type RuleRow = typeof schema.workflowRules.$inferSelect;

export function toRule(r: RuleRow): WorkflowRule {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description ?? null,
    status: r.status as WorkflowRuleStatus,
    mode: r.mode as WorkflowMode,
    trigger: r.trigger as WorkflowTrigger,
    conditions: (r.conditions ?? null) as WorkflowCondition | null,
    actions: (Array.isArray(r.actions) ? r.actions : []) as WorkflowAction[],
    gate: (r.gate ?? null) as WorkflowGate,
    version: r.version,
  };
}

/** Đối tượng mà luật nói về — nơi điều kiện `custom:` và hành động `set_custom_value` trỏ tới. `null` = không có bản ghi. */
export function triggerObjectKey(trigger: WorkflowTrigger): string | null {
  if (trigger.kind === "custom_status") return trigger.objectKey;
  if (trigger.objectKey) return trigger.objectKey;
  const spec = DOMAIN_EVENT_BY_NAME[trigger.event];
  return spec && isObjectKey(spec.subjectType) ? spec.subjectType : null;
}

// ─────────────────────────── Kiểm hình dạng (zod) ───────────────────────────

const statusValueZ = z.string().trim().min(1).max(100);

const triggerZ = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("event"), event: z.string().trim().min(3, "chọn một sự kiện").max(80), objectKey: z.string().trim().min(1).max(60).optional() }).strict(),
  z
    .object({
      kind: z.literal("custom_status"),
      objectKey: z.string().trim().min(1, "chọn đối tượng").max(60),
      fieldKey: z.string().trim().min(1, "chọn field trạng thái").max(60),
      to: z.array(statusValueZ).min(1, "chọn ít nhất một trạng thái đích").max(50),
      from: z.array(statusValueZ).max(50).optional(),
    })
    .strict(),
]);

const actionZ = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("create_task"),
      title: z.string().trim().min(2, "tiêu đề việc quá ngắn").max(200),
      summary: z.string().trim().max(2000).optional(),
      departmentCode: z.string().trim().max(40).optional(),
      priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).optional(),
      dueInHours: z.number().int("hạn tính bằng giờ nguyên").min(1).max(24 * 365).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("notify"), message: z.string().trim().min(1, "thông báo không được rỗng").max(500) }).strict(),
  z.object({ kind: z.literal("set_custom_value"), field: z.string().trim().min(1, "chọn field").max(60), value: z.unknown() }).strict(),
  z
    .object({
      kind: z.literal("send_message"),
      connectorKey: z.string().trim().min(1, "chọn kết nối nhắn tin").max(60),
      destination: z.string().trim().max(120).optional(),
      template: z.string().trim().min(1, "mẫu tin không được rỗng").max(MESSAGE_TEMPLATE_MAX),
    })
    .strict(),
]);

const gateZ = z.object({ kind: z.literal("approval"), reason: z.string().trim().min(3, "nói vì sao cần người duyệt").max(300) }).strict();

const ruleInputZ = z
  .object({
    id: z.string().min(1).max(200).optional(),
    key: z.string().trim(),
    name: z.string().trim().min(1, "luật phải có tên").max(120),
    description: z.string().trim().max(1000).nullable().optional(),
    trigger: triggerZ,
    conditions: z.unknown().optional(),
    actions: z.array(actionZ).min(1, "luật phải có ít nhất một hành động").max(WORKFLOW_MAX_ACTIONS),
    gate: gateZ.nullable().optional(),
  })
  .strict();

type ParsedRule = {
  id?: string;
  key: string;
  name: string;
  description: string | null;
  trigger: WorkflowTrigger;
  conditions: WorkflowCondition | null;
  actions: WorkflowAction[];
  gate: WorkflowGate;
};

const REF_PATTERN = /^(system|custom):[A-Za-z_][A-Za-z0-9_.]{0,80}$/;

/** Kiểm cây điều kiện: hình dạng, độ sâu, phép, giá trị. Tham chiếu field kiểm riêng (cần CSDL). */
function checkConditionShape(cond: unknown, path: string, errors: FieldError[], refs: { ref: string; path: string }[]) {
  if (!cond || typeof cond !== "object" || Array.isArray(cond)) {
    errors.push({ field: path, message: "Điều kiện sai hình: cần { all: [...] }, { any: [...] } hoặc { field, op, value }." });
    return;
  }
  const c = cond as Record<string, unknown>;
  const keys = Object.keys(c);
  if ("all" in c || "any" in c) {
    const k = "all" in c ? "all" : "any";
    if (keys.length !== 1 || !Array.isArray(c[k])) {
      errors.push({ field: path, message: `Nhóm "${k}" phải là một danh sách điều kiện và không kèm khoá khác.` });
      return;
    }
    const kids = c[k] as unknown[];
    if (kids.length > 20) errors.push({ field: path, message: "Một nhóm tối đa 20 điều kiện." });
    kids.forEach((x, i) => checkConditionShape(x, `${path}.${k}.${i}`, errors, refs));
    return;
  }
  if (keys.some((k) => !["field", "op", "value"].includes(k))) {
    errors.push({ field: path, message: "Điều kiện chỉ nhận field · op · value." });
    return;
  }
  if (typeof c.field !== "string" || !REF_PATTERN.test(c.field)) {
    errors.push({ field: path, message: `Field "${String(c.field)}" không hợp lệ — dạng system:<khoá> hoặc custom:<khoá>.` });
    return;
  }
  if (!WORKFLOW_CONDITION_OPS.includes(c.op as never)) {
    errors.push({ field: path, message: `Phép "${String(c.op)}" không có trong tập phép cho phép.` });
    return;
  }
  const scalar = (v: unknown) => typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
  if (c.op === "in") {
    if (!Array.isArray(c.value) || c.value.length === 0 || c.value.length > 200 || !c.value.every(scalar)) errors.push({ field: path, message: 'Phép "in" cần một danh sách giá trị (1–200).' });
  } else if (c.op === "empty" || c.op === "not_empty") {
    if (c.value !== undefined && c.value !== null) errors.push({ field: path, message: `Phép "${c.op}" không nhận giá trị.` });
  } else if (!scalar(c.value)) {
    errors.push({ field: path, message: `Phép "${c.op}" cần một giá trị (chữ, số hoặc có/không).` });
  } else if (c.op === "contains" && (typeof c.value !== "string" || c.value.length === 0)) {
    errors.push({ field: path, message: 'Phép "contains" cần một đoạn chữ.' });
  }
  refs.push({ ref: c.field, path });
}

async function departmentExists(code: string): Promise<boolean> {
  if (!(DEPARTMENT_CODES as readonly string[]).includes(code)) return false;
  const db = await getDb();
  const [row] = await db.select({ id: schema.departments.id }).from(schema.departments).where(and(eq(schema.departments.code, code), eq(schema.departments.active, true))).limit(1);
  return Boolean(row);
}

/**
 * Kiểm TOÀN BỘ một luật (hình dạng + tham chiếu có thật trong CSDL tổ chức). Dùng cho cả lúc lưu và lúc bật.
 * Trả mọi lỗi một lượt, mỗi lỗi gắn với đúng ô (`trigger.event`, `actions.0.field`, `conditions.all.1`…).
 */
export async function validateRuleInput(raw: unknown): Promise<{ ok: true; rule: ParsedRule } | WorkflowFailure> {
  const parsed = ruleInputZ.safeParse(raw);
  if (!parsed.success) return failW("INVALID", zodFieldErrors(parsed.error));
  const v = parsed.data;
  const errors: FieldError[] = [];
  if (!WORKFLOW_RULE_KEY_PATTERN.test(v.key)) errors.push({ field: "key", message: "Khoá luật: chữ thường không dấu, số, gạch dưới; bắt đầu bằng chữ; 2–41 ký tự." });

  // ── Trigger ──
  const trigger = v.trigger as WorkflowTrigger;
  let statusDef: CustomFieldDef | null = null;
  const objectKey = triggerObjectKey(trigger);
  let customDefs: CustomFieldDef[] = [];
  if (trigger.kind === "event") {
    if (trigger.event.startsWith("workflow.")) errors.push({ field: "trigger.event", message: "Luật không được nghe sự kiện do chính workflow phát (chặn vòng lặp)." });
    else if (!DOMAIN_EVENT_BY_NAME[trigger.event]) errors.push({ field: "trigger.event", message: `Sự kiện "${trigger.event}" không có trong sổ sự kiện.` });
    else if (trigger.objectKey) {
      // Chỉ sự kiện trên BẢN GHI metadata mang `objectKey` trong payload — sự kiện của miền khác không lọc theo đối tượng được.
      const recordProblem = recordEventObjectProblem(trigger.event, trigger.objectKey);
      if (DOMAIN_EVENT_BY_NAME[trigger.event].subjectType !== METADATA_RECORD_SUBJECT) errors.push({ field: "trigger.objectKey", message: `Sự kiện "${trigger.event}" không gắn với bản ghi của một đối tượng — bỏ chọn đối tượng.` });
      // `custom_record.*` chỉ phát cho đối tượng tuỳ biến — trên đối tượng hệ thống luật lưu được nhưng không bao giờ chạy (P1 #7).
      else if (recordProblem) errors.push({ field: "trigger.objectKey", message: recordProblem });
      else {
        const checked = await checkObject(trigger.objectKey, "customFields");
        if (!checked.ok) errors.push({ field: "trigger.objectKey", message: checked.errors[0]?.message ?? "Đối tượng không hỗ trợ field custom." });
      }
    }
  } else {
    const checked = await checkObject(trigger.objectKey, "customFields");
    if (!checked.ok) errors.push({ field: "trigger.objectKey", message: checked.errors[0]?.message ?? "Đối tượng không hỗ trợ field custom." });
    else {
      customDefs = await loadCustomDefs(trigger.objectKey, false);
      statusDef = customDefs.find((d) => d.key === trigger.fieldKey) ?? null;
      if (!statusDef) errors.push({ field: "trigger.fieldKey", message: `Field "${trigger.fieldKey}" không tồn tại (hoặc đã lưu trữ) trên ${checked.def.label}.` });
      else if (statusDef.type !== "status") errors.push({ field: "trigger.fieldKey", message: `Field "${statusDef.label}" không phải kiểu trạng thái nghiệp vụ.` });
      else {
        const values = new Set(statusDef.options.map((o) => o.value));
        for (const x of trigger.to) if (!values.has(x)) errors.push({ field: "trigger.to", message: `Trạng thái "${x}" không có trong tuỳ chọn của "${statusDef.label}".` });
        for (const x of trigger.from ?? []) if (!values.has(x)) errors.push({ field: "trigger.from", message: `Trạng thái "${x}" không có trong tuỳ chọn của "${statusDef.label}".` });
      }
    }
  }
  const objectResolved = objectKey ? await resolveObject(objectKey) : null;
  if (trigger.kind === "event" && objectKey && objectResolved?.customizable) customDefs = await loadCustomDefs(objectKey, false).catch(() => []);

  // ── Điều kiện ──
  let conditions: WorkflowCondition | null = null;
  if (v.conditions !== undefined && v.conditions !== null) {
    const refs: { ref: string; path: string }[] = [];
    const before = errors.length;
    checkConditionShape(v.conditions, "conditions", errors, refs);
    if (conditionDepth(v.conditions) > WORKFLOW_CONDITION_MAX_DEPTH) errors.push({ field: "conditions", message: `Cây điều kiện sâu tối đa ${WORKFLOW_CONDITION_MAX_DEPTH} tầng.` });
    const def = objectResolved;
    const systemKeys = new Set((def?.fields ?? []).map((f) => `system:${f.key}`));
    const customKeys = new Set(customDefs.map((d) => `custom:${d.key}`));
    for (const { ref, path } of refs) {
      if ((EVENT_SUBJECT_REFS as readonly string[]).includes(ref) || ref.startsWith(PAYLOAD_REF_PREFIX)) continue;
      if (ref.startsWith("system:")) {
        if (!systemKeys.has(ref)) errors.push({ field: path, message: def ? `${def.label} không có field hệ thống "${ref.slice(7)}".` : `Sự kiện này không gắn với bản ghi — chỉ dùng được system:event.* và system:payload.*.` });
      } else if (!customKeys.has(ref)) {
        errors.push({ field: path, message: def ? `Field custom "${ref.slice(7)}" không tồn tại (hoặc đã lưu trữ) trên ${def.label}.` : "Sự kiện này không gắn với bản ghi có field custom." });
      }
    }
    if (errors.length === before) conditions = v.conditions as WorkflowCondition;
  }

  // ── Hành động ──
  const actions = v.actions as WorkflowAction[];
  if (actions.filter((a) => a.kind === "notify").length > 1) errors.push({ field: "actions", message: "Mỗi luật tối đa MỘT thông báo — một tin gom cho lượt chạy, không một tin mỗi hành động (luật 26)." });
  for (const [i, a] of actions.entries()) {
    const path = `actions.${i}`;
    if (a.kind === "create_task" && a.departmentCode && !(await departmentExists(a.departmentCode))) errors.push({ field: `${path}.departmentCode`, message: `Phòng ban "${a.departmentCode}" không tồn tại.` });
    if (a.kind === "send_message") {
      if (!isMessagingConnector(a.connectorKey)) errors.push({ field: `${path}.connectorKey`, message: `"${a.connectorKey}" không phải kết nối nhắn tin theo tổ chức (Lark / Telegram / hộp thử).` });
      const unknown = unknownTemplateKeys(a.template, objectKey === "order" ? ORDER_MESSAGE_VAR_KEYS : GENERIC_MESSAGE_VAR_KEYS);
      if (unknown.length) errors.push({ field: `${path}.template`, message: `Mẫu tin có ô không điền được: ${unknown.map((k) => `{{${k}}}`).join(", ")}.` });
    }
    if (a.kind === "set_custom_value") {
      if (!objectKey) {
        errors.push({ field: `${path}.field`, message: "Luật này không gắn với một bản ghi có field custom — không ghi giá trị được." });
        continue;
      }
      if (trigger.kind === "event" && trigger.event === CUSTOM_STATUS_EVENT) {
        errors.push({ field: `${path}.field`, message: "Luật nghe mọi lượt đổi trạng thái không được ghi giá trị custom (vòng lặp trực tiếp)." });
        continue;
      }
      if (trigger.kind === "custom_status" && a.field === trigger.fieldKey) {
        errors.push({ field: `${path}.field`, message: `Luật nghe "${trigger.fieldKey}" không được ghi chính field đó (vòng lặp trực tiếp).` });
        continue;
      }
      if (!FIELD_KEY_PATTERN.test(a.field)) {
        errors.push({ field: `${path}.field`, message: `Khoá field "${a.field}" không hợp lệ.` });
        continue;
      }
      const d = customDefs.find((x) => x.key === a.field);
      if (!d) {
        errors.push({ field: `${path}.field`, message: `Field custom "${a.field}" không tồn tại (hoặc đã lưu trữ) trên ${objectResolved?.label ?? objectKey}.` });
        continue;
      }
      if (d.type === "file" || d.type === "user" || d.type === "relation" || d.type === "relation_many") {
        errors.push({ field: `${path}.field`, message: `Luật tự động không ghi được field kiểu "${d.type}" — giá trị tham chiếu phải do người chọn.` });
        continue;
      }
      const check = validateCustomValues([{ ...d, required: false }], { [d.key]: a.value }, null);
      for (const e of check.errors) errors.push({ field: `${path}.value`, message: e.message });
    }
  }

  if (errors.length > 0) return failW("INVALID", errors);
  return {
    ok: true,
    rule: {
      ...(v.id ? { id: v.id } : {}),
      key: v.key,
      name: v.name,
      description: v.description?.trim() ? v.description.trim() : null,
      trigger,
      conditions,
      actions,
      gate: (v.gate ?? null) as WorkflowGate,
    },
  };
}

// ─────────────────────────── Đọc ───────────────────────────

export async function listRules(): Promise<WorkflowRule[]> {
  const db = await getDb();
  const rows = await db.select().from(schema.workflowRules).orderBy(asc(schema.workflowRules.name), asc(schema.workflowRules.key));
  return rows.map(toRule);
}

export async function getRule(id: string): Promise<WorkflowRule | null> {
  if (typeof id !== "string" || id.length === 0 || id.length > 200) return null;
  const db = await getDb();
  const [row] = await db.select().from(schema.workflowRules).where(eq(schema.workflowRules.id, id)).limit(1);
  return row ? toRule(row) : null;
}

function snapshotOf(r: WorkflowRule) {
  return { key: r.key, name: r.name, description: r.description, status: r.status, mode: r.mode, trigger: r.trigger, conditions: r.conditions, actions: r.actions, gate: r.gate, version: r.version };
}

// ─────────────────────────── Ghi ───────────────────────────

/** Lưu luật — LUÔN về `DRAFT` + `DRY_RUN`. Có `id` ⇒ sửa (khoá bất biến, phiên bản +1, khoá lạc quan). */
export async function saveRule(input: unknown, actor: WorkflowActor): Promise<WorkflowRuleResult> {
  const checked = await validateRuleInput(input);
  if (!checked.ok) return checked;
  const v = checked.rule;
  const db = await getDb();
  const t = schema.workflowRules;
  const now = new Date();

  if (v.id) {
    const [row] = await db.select().from(t).where(eq(t.id, v.id)).limit(1);
    if (!row) return failW("NOT_FOUND", "Luật không tồn tại.", "id");
    const before = toRule(row);
    if (before.status === "ARCHIVED") return failW("INVALID", "Luật đã lưu trữ — không sửa được.", "id");
    if (before.key !== v.key) return failW("INVALID", "Khoá luật là bất biến — không đổi được sau khi tạo.", "key");
    const [updated] = await db
      .update(t)
      .set({
        name: v.name,
        description: v.description,
        trigger: v.trigger,
        conditions: v.conditions,
        actions: v.actions,
        gate: v.gate,
        status: "DRAFT",
        mode: "DRY_RUN",
        version: row.version + 1,
        updatedBy: actor.id,
        updatedAt: now,
      })
      .where(and(eq(t.id, v.id), eq(t.version, row.version)))
      .returning();
    if (!updated) return failW("CONFLICT", "Luật vừa được người khác sửa — tải lại rồi lưu lại.");
    const rule = toRule(updated);
    await audit({
      userId: actor.id,
      userEmail: actor.email,
      action: "WORKFLOW_RULE_SAVE",
      entity: "WORKFLOW_RULE",
      entityId: rule.id,
      before: snapshotOf(before),
      after: snapshotOf(rule),
      reason: before.status === "DRAFT" ? "Sửa luật nháp" : `Sửa luật đang ${before.status} ⇒ về NHÁP + CHẠY THỬ, phải bật lại có chủ đích`,
    });
    return { ok: true, rule };
  }

  const [dup] = await db.select({ id: t.id }).from(t).where(eq(t.key, v.key)).limit(1);
  if (dup) return failW("INVALID", `Đã có luật mang khoá "${v.key}".`, "key");
  try {
    const [created] = await db
      .insert(t)
      .values({ key: v.key, name: v.name, description: v.description, status: "DRAFT", mode: "DRY_RUN", trigger: v.trigger, conditions: v.conditions, actions: v.actions, gate: v.gate, version: 1, createdBy: actor.id, updatedBy: actor.id })
      .returning();
    const rule = toRule(created);
    await audit({ userId: actor.id, userEmail: actor.email, action: "WORKFLOW_RULE_SAVE", entity: "WORKFLOW_RULE", entityId: rule.id, before: null, after: snapshotOf(rule), reason: "Tạo luật (NHÁP + CHẠY THỬ)" });
    return { ok: true, rule };
  } catch (error) {
    if (isUniqueViolation(error)) return failW("INVALID", `Đã có luật mang khoá "${v.key}".`, "key");
    throw error;
  }
}

const STATUS_FROM: Record<"ACTIVE" | "PAUSED" | "ARCHIVED", readonly WorkflowRuleStatus[]> = {
  ACTIVE: ["DRAFT", "PAUSED"],
  PAUSED: ["ACTIVE"],
  ARCHIVED: ["DRAFT", "ACTIVE", "PAUSED"],
};

/**
 * Đổi trạng thái luật. `ACTIVE`: kiểm LẠI toàn bộ tham chiếu, ghi ảnh chụp bất biến `meta_config_versions`
 * (kind `WORKFLOW`, một dòng cho mỗi phiên bản được bật) và khởi tạo con trỏ sự kiện nếu tổ chức chưa có.
 */
export async function setRuleStatus(id: string, status: "ACTIVE" | "PAUSED" | "ARCHIVED", actor: WorkflowActor): Promise<WorkflowRuleResult> {
  const before = await getRule(id);
  if (!before) return failW("NOT_FOUND", "Luật không tồn tại.", "id");
  if (before.status === status) return { ok: true, rule: before };
  if (!STATUS_FROM[status]?.includes(before.status)) return failW("INVALID", `Không chuyển được luật từ ${before.status} sang ${status}.`, "status");
  if (status === "ACTIVE") {
    const again = await validateRuleInput({ id: before.id, key: before.key, name: before.name, description: before.description, trigger: before.trigger, conditions: before.conditions, actions: before.actions, gate: before.gate });
    if (!again.ok) return again;
  }
  const db = await getDb();
  const t = schema.workflowRules;
  const now = new Date();
  const [row] = await db
    .update(t)
    .set({ status, updatedBy: actor.id, updatedAt: now, ...(status === "ACTIVE" ? { activatedBy: actor.id, activatedAt: now } : {}) })
    .where(and(eq(t.id, id), eq(t.version, before.version), eq(t.status, before.status)))
    .returning();
  if (!row) return failW("CONFLICT", "Luật vừa được người khác sửa — tải lại rồi làm lại.");
  const rule = toRule(row);
  if (status === "ACTIVE") {
    const v = schema.metaConfigVersions;
    const [has] = await db
      .select({ id: v.id })
      .from(v)
      .where(and(eq(v.kind, "WORKFLOW"), eq(v.objectKey, "workflow"), eq(v.configKey, rule.key), eq(v.version, rule.version)))
      .limit(1);
    if (!has) await db.insert(v).values({ kind: "WORKFLOW", objectKey: "workflow", configKey: rule.key, version: rule.version, snapshot: snapshotOf(rule), actorId: actor.id, actorEmail: actor.email });
    await ensureEventCursor(db);
  }
  await audit({
    userId: actor.id,
    userEmail: actor.email,
    action: "WORKFLOW_RULE_STATUS",
    entity: "WORKFLOW_RULE",
    entityId: rule.id,
    before: { status: before.status, mode: before.mode, version: before.version },
    after: { status: rule.status, mode: rule.mode, version: rule.version },
    reason: status === "ACTIVE" ? `Bật luật (phiên bản ${rule.version}, ${rule.mode === "LIVE" ? "CHẠY THẬT" : "CHẠY THỬ"})` : status === "PAUSED" ? "Tạm dừng luật" : "Lưu trữ luật",
  });
  return { ok: true, rule };
}

/** Chuyển CHẠY THỬ ⇄ CHẠY THẬT. `LIVE` chỉ khi luật đang `ACTIVE` — không có luật nào chạy thật từ nháp. */
export async function setRuleMode(id: string, mode: "DRY_RUN" | "LIVE", actor: WorkflowActor): Promise<WorkflowRuleResult> {
  const before = await getRule(id);
  if (!before) return failW("NOT_FOUND", "Luật không tồn tại.", "id");
  if (before.mode === mode) return { ok: true, rule: before };
  if (mode === "LIVE" && before.status !== "ACTIVE") return failW("INVALID", "Chỉ luật đang BẬT mới chuyển sang chạy thật được — bật luật và xem kết quả chạy thử trước.", "mode");
  const db = await getDb();
  const t = schema.workflowRules;
  const [row] = await db
    .update(t)
    .set({ mode, updatedBy: actor.id, updatedAt: new Date() })
    .where(and(eq(t.id, id), eq(t.version, before.version), eq(t.mode, before.mode), mode === "LIVE" ? eq(t.status, "ACTIVE") : sql`true`))
    .returning();
  if (!row) return failW("CONFLICT", "Luật vừa được người khác sửa — tải lại rồi làm lại.");
  const rule = toRule(row);
  await audit({
    userId: actor.id,
    userEmail: actor.email,
    action: "WORKFLOW_RULE_MODE",
    entity: "WORKFLOW_RULE",
    entityId: rule.id,
    before: { mode: before.mode, status: before.status, version: before.version },
    after: { mode: rule.mode, status: rule.status, version: rule.version },
    reason: mode === "LIVE" ? "Chuyển sang CHẠY THẬT — từ lượt kế tiếp máy làm thật" : "Về CHẠY THỬ — máy chỉ ghi việc SẼ làm",
  });
  return { ok: true, rule };
}

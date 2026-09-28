/**
 * ═══════════ SỔ ACTION CỦA TRANG ĐỘNG — PHẦN MÁY CHỦ (Phase 4 · G5, G6) ═══════════
 *
 * Nút trên trang KHÔNG mang logic: nó gửi `(slug, blockId, input)`. Máy chủ đọc lại cấu hình ĐÃ XUẤT BẢN theo
 * `slug + blockId` (không bao giờ tin cấu hình client gửi lên), lấy khoá action + phần đầu vào ĐÃ GHIM trong
 * cấu hình, rồi mới gọi handler. Mỗi handler gọi ĐÚNG đường nghiệp vụ có sẵn — không đường ghi thứ hai:
 *  · `create_record`     ⇒ `createCustomerCore` (cổng `customerCreateGate`, form `create` đã xuất bản);
 *  · `update_safe_field` ⇒ `saveCustomValues` (CHỈ field custom; quyền theo field; luật chuyển trạng thái);
 *  · `run_workflow`      ⇒ `runWorkflows()` của Phase 3 (không engine thứ hai);
 *  · `request_approval`  ⇒ đổi field trạng thái kích hoạt một luật CÓ CỬA DUYỆT, rồi `runWorkflows()` — yêu cầu
 *    duyệt do chính bộ máy Phase 3 tạo.
 *
 * ĐẦU VÀO ĐÃ GHIM THẮNG ĐẦU VÀO CLIENT: `{ ...client, ...ghim }`. Nút "sửa field X" không bao giờ thành cửa ghi
 * field Y chỉ vì client gửi `field: "Y"`. Và `update_safe_field` BẮT BUỘC ghim `objectKey` + `field` — nút để client
 * tự chọn field là một cổng ghi tổng quát, thứ sổ đóng này sinh ra để chặn.
 *
 * Lớp trình duyệt (`lib/actions/page-actions.ts`) do agent CORE nối: nó cung cấp `loadPublished` (= `getPageBySlug`)
 * và người dùng của phiên. Hàm ở đây không đọc bảng `meta_pages` — một lớp lưu trữ, một chỗ.
 *
 * HÀNH ĐỘNG THEO DÒNG (Phase 5): `executePageAction(..., { loadPublished, recordId, actionIndex })` — khối phải là
 * BẢNG của bản ĐÃ XUẤT BẢN, `rowActions[actionIndex]` phải có, bản ghi `recordId` phải TỒN TẠI và nằm trong PHẠM VI
 * người bấm (cổng của nguồn danh sách + `rowInScope`) TRƯỚC khi handler chạy. Đối tượng + bản ghi do MÁY CHỦ ghim
 * (thắng mọi đầu vào client): dòng của bảng khách không bao giờ thành cửa sửa một đơn hàng.
 */
import { getTableName } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/lib/audit";
import type { Permission } from "@/lib/auth/permissions";
import { rowInScope, type ScopeDecision } from "@/lib/auth/scope-guard";
import { can, type SessionUser } from "@/lib/auth/session";
import { SCOPE_RESOURCE_BY_KEY } from "@/lib/constants/data-scope-policy";
import { objectDef, type AnyObjectDef } from "@/lib/constants/object-registry";
import { isModuleKey } from "@/lib/constants/platform-modules";
import { loadCustomDefs, objectModuleOff, recordExists } from "@/lib/metadata/common";
import { MetadataError, type MetaFailure } from "@/lib/metadata/errors";
import { resolveObject } from "@/lib/metadata/object-resolver";
import { OBJECT_RECORD_PERMISSIONS, objectAccess } from "@/lib/metadata/permissions";
import { FIELD_KEY_PATTERN, type CustomFieldDef, type FieldError } from "@/lib/metadata/types";
import { canEditField, getCustomValues, saveCustomValues } from "@/lib/metadata/values";
import { listSource, pageAction } from "@/lib/pages/catalog";
import { ROW_ACTION_KEYS } from "@/lib/pages/components";
import { customRecordVisible, isCustomKey, recordHref } from "@/lib/pages/page-objects";
import { gateSource, moduleOn, OBJECT_SCOPE_RESOURCE, pageDetailHref } from "@/lib/pages/runtime-common";
import { pageObjectTable } from "@/lib/queries/page-data";
import { flattenBlocks, type ButtonConfig, type KanbanConfig, type PageActionSpec, type PageBlock, type PageDefinition, type PageSchema, type TableConfig } from "@/lib/pages/types";
import { createCustomerCore, customerCreateGate } from "@/lib/records/customer-create";
import { runWorkflows, triggerMatches } from "@/lib/workflow/engine";
import { CUSTOM_STATUS_EVENT, listRules, WORKFLOW_RULE_KEY_PATTERN } from "@/lib/workflow/rules";

export { PAGE_ACTIONS } from "@/lib/pages/catalog";

export type PageActionResult = { ok: true; redirectTo?: string; message?: string } | { ok: false; error: string; code?: string; errors?: FieldError[] };

/** Nạp cấu hình ĐÃ XUẤT BẢN theo slug — tiêm `getPageBySlug` của agent CORE (hoặc một bản giả trong bài kiểm). */
export type PublishedPageLoader = (slug: string) => Promise<{ page: PageDefinition; schema: PageSchema } | PageSchema | null>;

const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,60}$/;
const recordIdZ = z.string().min(1).max(200);
const plainRecord = z.record(z.string(), z.unknown());

/** Lược đồ đầu vào (sau khi gộp phần ghim) của từng action — tập đóng, khoá lạ bị từ chối. */
const INPUTS: Record<string, z.ZodType> = {
  open_page: z.object({ slug: z.string().regex(SLUG_PATTERN) }).strict(),
  open_record: z.object({ objectKey: z.string().min(1).max(60), recordId: recordIdZ }).strict(),
  create_record: z.object({ system: plainRecord.default({}), custom: plainRecord.default({}) }).strict(),
  update_safe_field: z.object({ objectKey: z.string().min(1).max(60), recordId: recordIdZ, field: z.string().regex(FIELD_KEY_PATTERN), value: z.unknown() }).strict(),
  run_workflow: z.object({}).strict(),
  request_approval: z.object({ ruleKey: z.string().regex(WORKFLOW_RULE_KEY_PATTERN), recordId: recordIdZ }).strict(),
};

/** Khoá BẮT BUỘC phải ghim trong cấu hình đã xuất bản (client không được tự chọn). */
const MUST_PIN: Record<string, string[]> = {
  open_page: ["slug"],
  open_record: ["objectKey"],
  update_safe_field: ["objectKey", "field"],
  request_approval: ["ruleKey"],
};

function metaError(r: MetaFailure): PageActionResult {
  return { ok: false, error: r.errors[0]?.message ?? "Không thực hiện được.", code: r.code, errors: r.errors };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Đối tượng theo khoá: sổ tĩnh; khoá `x_…` (Phase 6) ⇒ đối tượng tuỳ biến CÒN HOẠT ĐỘNG của tổ chức hiện hành (đã lưu
 * trữ / của tổ chức khác ⇒ `null`, cùng một câu "không có").
 */
async function objectOf(key: string): Promise<AnyObjectDef | null> {
  const sys = objectDef(key);
  if (sys) return sys;
  if (!isCustomKey(key)) return null;
  const def = await resolveObject(key);
  return def && !def.system && def.custom?.status === "ACTIVE" ? def : null;
}

/** Module của đối tượng bật cho người + tổ chức — đối tượng tuỳ biến cần CẢ `apps` lẫn nhóm menu của nó. */
async function objectOn(user: SessionUser, def: AnyObjectDef): Promise<boolean> {
  if (!(await moduleOn(user, def.module))) return false;
  return def.system || (await objectModuleOff(def)) === null;
}

async function scopeAllowsRecord(user: SessionUser, def: AnyObjectDef, permission: string, recordId: string): Promise<boolean> {
  // Bản ghi tuỳ biến: MỘT câu hỏi — module + đủ khoá xem + đúng đối tượng + chưa xoá + trong phạm vi CUSTOM_RECORDS.
  if (!def.system) return customRecordVisible(user, def, recordId);
  const resource = OBJECT_SCOPE_RESOURCE[def.key] ?? null;
  const gate = await gateSource(user, { module: def.module, permission, label: def.labelPlural }, resource);
  if (!gate.ok) return false;
  return rowAllowed(gate.decision, resource, def, recordId);
}

/** Dòng cụ thể có trong phạm vi không — bảng của sổ phạm vi phải là ĐÚNG bảng của đối tượng, không thì từ chối. */
async function rowAllowed(decision: ScopeDecision, resource: string | null, def: AnyObjectDef, recordId: string): Promise<boolean> {
  if (decision.allow === "ALL") return true;
  if (decision.allow === "NONE" || !resource) return false;
  const res = SCOPE_RESOURCE_BY_KEY[resource];
  const { table, id } = pageObjectTable(def);
  // Mệnh đề phạm vi viết trên bảng của sổ phạm vi; hỏi nó trên một bảng khác là hỏi sai câu — từ chối.
  if (!res || res.table !== getTableName(table)) return false;
  return rowInScope(decision, res.table, id.name, recordId);
}

async function activeCustomField(objectKey: string, field: string): Promise<CustomFieldDef | null> {
  const defs = await loadCustomDefs(objectKey, false);
  return defs.find((d) => d.key === field && d.status === "ACTIVE") ?? null;
}

// ─────────────────────────── Handler ───────────────────────────

type Input = Record<string, unknown>;

async function openRecord(input: Input, user: SessionUser): Promise<PageActionResult> {
  const def = await objectOf(String(input.objectKey));
  const href = def ? recordHref(def, String(input.recordId)) : undefined;
  if (!def || !href) return { ok: false, error: "Đối tượng này không có trang chi tiết." };
  const perms = objectAccess(def).view;
  const perm = perms[0];
  if (!(await objectOn(user, def))) return { ok: false, error: `Module "${def.module}" chưa được bật cho tổ chức này.`, code: "MODULE_DISABLED" };
  if (!perms.every((p) => can(user, p as Permission))) return { ok: false, error: `Bạn không có quyền xem ${def.labelPlural}.`, code: "FORBIDDEN" };
  const id = String(input.recordId);
  if (!(await recordExists(def, id)) || !(await scopeAllowsRecord(user, def, perm, id))) return { ok: false, error: "Bản ghi không tồn tại.", code: "NOT_FOUND" };
  return { ok: true, redirectTo: href };
}

async function createRecord(input: Input, user: SessionUser): Promise<PageActionResult> {
  const r = await createCustomerCore(user, { system: input.system, custom: input.custom });
  if (!r.ok) return metaError(r);
  return { ok: true, redirectTo: pageDetailHref("customer", r.id), message: "Đã tạo khách hàng." };
}

async function updateSafeField(input: Input, user: SessionUser): Promise<PageActionResult> {
  const def = await objectOf(String(input.objectKey));
  if (!def || !def.capabilities.customFields || !def.customizable) return { ok: false, error: "Đối tượng không có field bổ sung.", code: "NOT_SUPPORTED" };
  if (!(await objectOn(user, def))) return { ok: false, error: `Module "${def.module}" chưa được bật cho tổ chức này.`, code: "MODULE_DISABLED" };
  const field = String(input.field);
  // CHỈ field custom: khoá trùng field hệ thống không bao giờ là field custom (sổ cấm trùng), nên tra định nghĩa là đủ.
  const fdef = await activeCustomField(def.key, field);
  if (!fdef) return { ok: false, error: `"${field}" không phải field bổ sung đang dùng — chỉ field bổ sung sửa được từ trang.`, code: "NOT_FOUND" };
  const id = String(input.recordId);
  if (!(await scopeAllowsRecord(user, def, objectAccess(def).view[0], id))) return { ok: false, error: "Bản ghi không tồn tại.", code: "NOT_FOUND" };
  const r = await saveCustomValues(def.key, id, { [field]: input.value }, user);
  if (!r.ok) return metaError(r);
  return { ok: true, message: r.changed.length ? `Đã lưu ${fdef.label}.` : "Không có gì thay đổi." };
}

async function runWorkflowNow(): Promise<PageActionResult> {
  const r = await runWorkflows();
  return { ok: true, message: `Đã xét ${r.events} sự kiện · ${r.runs} lượt chạy · ${r.executed} đã làm · ${r.waiting} chờ duyệt · ${r.failed} lỗi.` };
}

async function requestApproval(input: Input, user: SessionUser, spec: PageActionSpec): Promise<PageActionResult> {
  const objectKey = spec.objectKey ?? "";
  const def = objectDef(objectKey);
  if (!def) return { ok: false, error: "Action khai đối tượng không có trong sổ." };
  if (!(await moduleOn(user, "work"))) return { ok: false, error: "Module Công việc chưa bật — luật tự động không chạy.", code: "MODULE_DISABLED" };
  const rules = await listRules();
  const rule = rules.find((r) => r.key === input.ruleKey);
  if (!rule) return { ok: false, error: "Luật được khai trên nút không tồn tại.", code: "NOT_FOUND" };
  if (rule.status !== "ACTIVE" || rule.mode !== "LIVE") return { ok: false, error: `Luật "${rule.name}" chưa bật chạy thật — không có yêu cầu duyệt nào được tạo.`, code: "INVALID" };
  if (rule.gate?.kind !== "approval") return { ok: false, error: `Luật "${rule.name}" không có cửa duyệt — nút "Gửi yêu cầu duyệt" không dùng được với nó.`, code: "INVALID" };
  if (rule.trigger.kind !== "custom_status" || rule.trigger.objectKey !== def.key || rule.trigger.to.length === 0) {
    return { ok: false, error: `Luật "${rule.name}" không kích hoạt bằng trạng thái bổ sung của ${def.label}.`, code: "INVALID" };
  }
  const fieldKey = rule.trigger.fieldKey;
  const target = rule.trigger.to[0];
  const recordId = String(input.recordId);
  if (!(await scopeAllowsRecord(user, def, OBJECT_RECORD_PERMISSIONS[def.key].view, recordId))) return { ok: false, error: "Bản ghi không tồn tại.", code: "NOT_FOUND" };
  const current = (await getCustomValues(def.key, [recordId], user)).get(recordId)?.[fieldKey];
  const ev = { name: CUSTOM_STATUS_EVENT, payload: { objectKey: def.key, fieldKey, from: typeof current === "string" ? current : null, to: target } };
  /*
    MỌI luật chạy thật khác khớp cùng lượt đổi cũng phải có cửa duyệt. Một luật không cửa duyệt khớp ở đây sẽ
    chạy hành động NGAY khi nút được bấm — nút mang tên "gửi yêu cầu duyệt" mà làm việc không qua duyệt là nói dối.
  */
  const ungated = rules.filter((r) => r.id !== rule.id && r.status === "ACTIVE" && r.mode === "LIVE" && !r.gate && triggerMatches(r.trigger, ev));
  if (ungated.length) return { ok: false, error: `Có luật chạy ngay không qua duyệt cũng khớp lượt đổi này (${ungated.map((r) => r.name).join(", ")}) — sửa luật trước khi dùng nút.`, code: "CONFLICT" };
  if (current === target) return { ok: false, error: "Bản ghi đã ở trạng thái kích hoạt — không phát sinh yêu cầu mới.", code: "INVALID" };
  const saved = await saveCustomValues(def.key, recordId, { [fieldKey]: target }, user);
  if (!saved.ok) return metaError(saved);
  const r = await runWorkflows();
  return {
    ok: true,
    message: r.waiting > 0 ? "Đã gửi yêu cầu duyệt." : "Đã đổi trạng thái; luật không tạo yêu cầu duyệt ở lượt này (điều kiện của luật không khớp hoặc lượt chạy kế tiếp sẽ xét).",
  };
}

const HANDLERS: Record<string, (input: Input, user: SessionUser, spec: PageActionSpec) => Promise<PageActionResult>> = {
  open_page: async (input) => ({ ok: true, redirectTo: `/p/${String(input.slug)}` }),
  open_record: (input, user) => openRecord(input, user),
  create_record: (input, user) => createRecord(input, user),
  update_safe_field: (input, user) => updateSafeField(input, user),
  run_workflow: () => runWorkflowNow(),
  request_approval: (input, user, spec) => requestApproval(input, user, spec),
};

/** Mọi action trong sổ có handler, và ngược lại — bài kiểm khoá. */
export const PAGE_ACTION_HANDLER_KEYS = Object.keys(HANDLERS);

// ─────────────────────────── Khả dụng (cho khối nút) ───────────────────────────

/** Nút có bấm được không, theo NGƯỜI XEM — chỉ để vẽ; `executePageAction` vẫn kiểm lại toàn bộ. */
export async function actionAvailability(spec: PageActionSpec, pinned: Input, user: SessionUser): Promise<{ enabled: boolean; reason?: string }> {
  if (spec.module && !(await moduleOn(user, spec.module))) return { enabled: false, reason: `Module "${spec.module}" chưa được bật.` };
  if (spec.permission && !can(user, spec.permission as Permission)) return { enabled: false, reason: "Bạn không có quyền dùng nút này." };
  for (const k of MUST_PIN[spec.key] ?? []) if (pinned[k] === undefined) return { enabled: false, reason: `Nút chưa khai "${k}".` };
  if (spec.key === "create_record") {
    const gate = await customerCreateGate(user);
    if (!gate.allowed) return { enabled: false, reason: gate.reason };
  }
  if (spec.key === "update_safe_field") {
    const def = await objectOf(String(pinned.objectKey));
    if (!def || !(await objectOn(user, def))) return { enabled: false, reason: "Đối tượng của nút chưa bật." };
    try {
      const fdef = await activeCustomField(def.key, String(pinned.field));
      if (!fdef || !canEditField(user, def, fdef)) return { enabled: false, reason: "Bạn không sửa được field này." };
    } catch (error) {
      if (error instanceof MetadataError) return { enabled: false, reason: error.message };
      throw error;
    }
  }
  return { enabled: true };
}

// ─────────────────────────── Cửa vào duy nhất ───────────────────────────

/** Khối theo id trong bản ĐÃ XUẤT BẢN — kể cả khối con của cột (một nút đặt trong cột vẫn bấm được). */
function findBlock(schema: PageSchema, blockId: string): PageBlock | null {
  return flattenBlocks(schema).find((f) => f.block.id === blockId)?.block ?? null;
}

/** Action nhận `objectKey` trong đầu vào (hai loại còn lại khai đối tượng ở sổ). */
const OBJECT_INPUT_ACTIONS = new Set(["open_record", "update_safe_field"]);

/**
 * Hành động theo dòng của một BẢNG đã xuất bản: tra `rowActions[index]`, kiểm bản ghi tồn tại + trong phạm vi người
 * bấm, rồi ghim đối tượng + bản ghi. Mọi nhánh lỗi trả `{ error }` — không có nhánh nào chạy handler khi chưa kiểm xong.
 */
async function rowActionOfBlock(block: PageBlock, index: unknown, recordId: unknown, user: SessionUser): Promise<{ key: string; pinned: Input } | PageActionResult> {
  if (block.type !== "table") return { ok: false, error: "Khối này không có hành động theo dòng.", code: "INVALID" };
  const cfg = block.config as TableConfig;
  const list = Array.isArray(cfg.rowActions) ? cfg.rowActions : [];
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= list.length) return { ok: false, error: "Hành động theo dòng không có trong bản đã xuất bản của trang.", code: "NOT_FOUND" };
  const ra = list[index];
  const spec = pageAction(String(ra?.action ?? ""));
  if (!spec || !ROW_ACTION_KEYS.includes(spec.key)) return { ok: false, error: `Action "${String(ra?.action)}" không dùng được trên từng dòng.`, code: "INVALID" };
  const def = await objectOf(String(cfg.source ?? ""));
  // Đối tượng tuỳ biến không nằm trong sổ tĩnh: cổng của nó là `objectAccess(def).view` (kiểm trong `scopeAllowsRecord`).
  const src = def ? (def.system ? listSource(def.key) : { permission: objectAccess(def).view[0] }) : null;
  if (!def || !src) return { ok: false, error: "Bảng trỏ đối tượng không có trong sổ.", code: "INVALID" };
  if (spec.objectKey && spec.objectKey !== def.key) return { ok: false, error: `Action "${spec.label}" không dùng cho ${def.labelPlural}.`, code: "INVALID" };
  const id = recordIdZ.safeParse(recordId);
  if (!id.success) return { ok: false, error: "Thiếu bản ghi của dòng.", code: "INVALID" };
  // Tồn tại + trong phạm vi NGƯỜI BẤM theo đúng cổng của bảng — id gõ tay của dòng không thấy được ⇒ "không tồn tại".
  if (!(await recordExists(def, id.data)) || !(await scopeAllowsRecord(user, def, src.permission, id.data))) return { ok: false, error: "Bản ghi không tồn tại.", code: "NOT_FOUND" };
  const pinned: Input = { ...(isPlainObject(ra.input) ? ra.input : {}), recordId: id.data };
  if (OBJECT_INPUT_ACTIONS.has(spec.key)) pinned.objectKey = def.key;
  return { key: spec.key, pinned };
}

/** Khoá action + phần ghim của một khối ĐÃ XUẤT BẢN. Khối không phát action ⇒ `null`. */
function actionOfBlock(block: PageBlock): { key: string; pinned: Input } | null {
  if (block.type === "button") {
    const cfg = block.config as ButtonConfig;
    return { key: cfg.action, pinned: isPlainObject(cfg.input) ? cfg.input : {} };
  }
  if (block.type === "kanban") {
    const cfg = block.config as KanbanConfig;
    if (!cfg.allowMove || typeof cfg.statusField !== "string" || !cfg.statusField.startsWith("custom:")) return null;
    return { key: "update_safe_field", pinned: { objectKey: cfg.objectKey, field: cfg.statusField.slice("custom:".length) } };
  }
  return null;
}

export type ExecutePageActionDeps = {
  loadPublished: PublishedPageLoader;
  /** Hành động theo dòng: bản ghi của dòng được bấm (máy chủ kiểm tồn tại + phạm vi). */
  recordId?: string;
  /** Hành động theo dòng: vị trí trong `rowActions` ĐÃ XUẤT BẢN của bảng. */
  actionIndex?: number;
};

export async function executePageAction(slug: string, blockId: string, input: unknown, user: SessionUser, deps: ExecutePageActionDeps): Promise<PageActionResult> {
  if (typeof slug !== "string" || !SLUG_PATTERN.test(slug) || typeof blockId !== "string" || blockId.length === 0 || blockId.length > 60) {
    return { ok: false, error: "Yêu cầu không hợp lệ." };
  }
  const loaded = await deps.loadPublished(slug);
  if (!loaded) return { ok: false, error: "Trang không tồn tại hoặc chưa xuất bản.", code: "NOT_FOUND" };
  const schema = "schema" in loaded ? loaded.schema : loaded;
  const page = "page" in loaded ? loaded.page : null;
  if (page) {
    if (page.status !== "ACTIVE") return { ok: false, error: "Trang đã lưu trữ.", code: "NOT_FOUND" };
    if (isModuleKey(page.moduleKey) && !(await moduleOn(user, page.moduleKey))) return { ok: false, error: "Module của trang chưa được bật.", code: "MODULE_DISABLED" };
    if (page.requiredPermission && !can(user, page.requiredPermission as Permission)) return { ok: false, error: "Bạn không có quyền mở trang này.", code: "FORBIDDEN" };
  }
  // Khối tra trong bản ĐÃ XUẤT BẢN — bản nháp có khối này mà chưa xuất bản ⇒ không tồn tại với người dùng.
  const block = findBlock(schema, blockId);
  if (!block) return { ok: false, error: "Nút không có trong bản đã xuất bản của trang.", code: "NOT_FOUND" };
  const isRow = deps.actionIndex !== undefined || deps.recordId !== undefined;
  let act: { key: string; pinned: Input } | null;
  if (isRow) {
    const row = await rowActionOfBlock(block, deps.actionIndex, deps.recordId, user);
    if ("ok" in row) return row;
    act = row;
  } else act = actionOfBlock(block);
  if (!act) return { ok: false, error: "Khối này không có thao tác.", code: "INVALID" };
  const spec = pageAction(act.key);
  const handler = HANDLERS[act.key];
  const inputZ = INPUTS[act.key];
  if (!spec || !handler || !inputZ) return { ok: false, error: `Action "${act.key}" không có trong sổ.`, code: "INVALID" };
  if (spec.module && !(await moduleOn(user, spec.module))) return { ok: false, error: `Module "${spec.module}" chưa được bật cho tổ chức này.`, code: "MODULE_DISABLED" };
  if (spec.permission && !can(user, spec.permission as Permission)) return { ok: false, error: "Bạn không có quyền dùng nút này.", code: "FORBIDDEN" };
  for (const k of MUST_PIN[spec.key] ?? []) if (act.pinned[k] === undefined) return { ok: false, error: `Nút chưa khai "${k}" trong cấu hình đã xuất bản.`, code: "INVALID" };
  if (input !== undefined && input !== null && !isPlainObject(input)) return { ok: false, error: "Dữ liệu gửi lên không đúng dạng.", code: "INVALID" };
  const merged = { ...(input ?? {}), ...act.pinned };
  const parsed = inputZ.safeParse(merged);
  if (!parsed.success) return { ok: false, error: "Dữ liệu gửi lên không đúng dạng.", code: "INVALID" };
  let result: PageActionResult;
  try {
    result = await handler(parsed.data as Input, user, spec);
  } catch (error) {
    if (error instanceof MetadataError) return { ok: false, error: error.message, code: error.code };
    console.error(`[page-action] ${slug}#${blockId} (${spec.key}) lỗi:`, error instanceof Error ? error.message : String(error));
    return { ok: false, error: "Không thực hiện được thao tác — thử lại sau.", code: "DATA_ERROR" };
  }
  if (spec.sideEffect === "WRITE") {
    await audit({
      userId: user.id,
      userEmail: user.email,
      action: "PAGE_ACTION_RUN",
      entity: "META_PAGE",
      entityId: `${slug}#${blockId}`,
      detail: { action: spec.key, ok: result.ok, ...(isRow ? { rowAction: deps.actionIndex, recordId: String(act.pinned.recordId) } : {}), ...(result.ok ? {} : { code: result.code ?? null }) },
    });
  }
  return result;
}

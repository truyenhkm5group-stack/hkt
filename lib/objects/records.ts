/**
 * ═══════════ BẢN GHI CỦA ĐỐI TƯỢNG TUỲ BIẾN (Phase 6 · mục 1–6) — CHỈ MÁY CHỦ ═══════════
 *
 * Lõi dịch vụ DUY NHẤT ghi `custom_records` và nơi DUY NHẤT phát `custom_record.created|updated|deleted`. Giá trị
 * field đi qua ĐÚNG đường ghi của Phase 2 (`saveCustomValues` — kiểm hợp lệ, quyền theo field, tham chiếu có thật,
 * chuyển trạng thái, khoá lạc quan, nhật ký, sự kiện `custom_status.changed`); tệp này chỉ thêm CỘT HỆ THỐNG
 * (tên · người phụ trách) và vòng đời bản ghi.
 *
 * CỔNG, theo thứ tự (`recordGate`) — lỗi ở bước nào thì 0 dòng được ghi / 0 dòng được đọc:
 *  1. khoá phân giải được thành đối tượng TUỲ BIẾN của tổ chức hiện hành, chưa lưu trữ (`getDb()` = CSDL của tổ chức
 *     người gọi ⇒ khoá / id của tổ chức khác không tồn tại ở đây);
 *  2. module `apps` + nhóm menu của đối tượng đang bật (tắt ⇒ `MODULE_DISABLED`, kể cả ADMIN);
 *  3. đủ khoá quyền (`records:view|write` + khoá siết của đối tượng);
 *  4. phạm vi dữ liệu `CUSTOM_RECORDS` (chủ dòng `owner_id`): `NONE` ⇒ từ chối; dòng ngoài phạm vi ⇒ "không tồn tại"
 *     CÙNG MỘT CÂU với id không có — không cho dò id nào có thật.
 *
 * Xoá = đặt `deleted_at` (không xoá cứng). Ngoại lệ DUY NHẤT: lượt tạo mà bước ghi giá trị bị từ chối ⇒ gỡ dòng
 * VỪA chèn trong cùng lượt (chưa ai thấy, chưa sự kiện nào) — không để lại một bản ghi thiếu dữ liệu mà người bấm tưởng
 * chưa được tạo (cùng lối `lib/records/customer-create.ts`).
 */
import { and, asc, count, desc, eq, ilike, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { andScope, type ScopeDecision } from "@/lib/auth/scope-guard";
import type { SessionUser } from "@/lib/auth/session";
import { domainEventLabel, METADATA_RECORD_SUBJECT } from "@/lib/constants/domain-events";
import type { AnyObjectDef } from "@/lib/constants/object-registry";
import { emitDomainEvent } from "@/lib/events/emit";
import { checkEntitlement } from "@/lib/entitlements/check";
import { idColumnOf, loadCustomDefs, objectModuleOff, recordScopeSql } from "@/lib/metadata/common";
import { CUSTOM_RECORD_FORM_CREATE, CUSTOM_RECORD_FORM_EDIT, CUSTOM_RECORD_LIST, customObjectHref, TITLE_MAX_LENGTH } from "@/lib/metadata/custom-object-def";
import { MetadataError, type MetaFailure } from "@/lib/metadata/errors";
import { parseRef, writableCustomKeys, writableSystemKeys } from "@/lib/metadata/form-schema";
import { getPublishedForm } from "@/lib/metadata/forms";
import { getPublishedListView } from "@/lib/metadata/lists";
import { withMetadataReadScope } from "@/lib/metadata/read-scope";
import { resolveObject } from "@/lib/metadata/object-resolver";
import { canViewObject, canWriteObject, objectScope, recordTitles, visibleRecordIds } from "@/lib/metadata/record-access";
import { RELATION_TYPES, type CustomFieldDef, type CustomValues, type FieldRef, type ListFilter, type ListViewSchema } from "@/lib/metadata/types";
import { validateCustomValues } from "@/lib/metadata/validate";
import { canEditField, canViewField, customValuesFilterSql, saveCustomValues } from "@/lib/metadata/values";
import { objectsFail } from "@/lib/objects/objects";
import type { CustomRecordDetail, CustomRecordRow, ObjectsFailure, ObjectsResult, ReverseRelationGroup } from "@/lib/objects/types";
import { pageDetailHref } from "@/lib/pages/runtime-common";
import { getRecordTimeline, type RecordTimelineRaw } from "@/lib/queries/record-timeline";
import { userLabelsByIds } from "@/lib/queries/users";
import { rowsOf } from "@/lib/sql-rows";
import type { ListParams } from "@/lib/search-params";

type Viewer = SessionUser;
type RecordRow = typeof schema.customRecords.$inferSelect;

/** Thông tin đối tượng gửi xuống trang (tuần tự hoá được). */
export type ObjectHeader = { key: string; label: string; labelPlural: string; icon: string; titleLabel: string; description: string | null };

function header(def: AnyObjectDef): ObjectHeader {
  return { key: def.key, label: def.label, labelPlural: def.labelPlural, icon: def.custom?.icon ?? "box", titleLabel: def.custom?.titleLabel ?? "Tên", description: def.custom?.description ?? null };
}

function fromMeta(r: MetaFailure): ObjectsFailure {
  return { ok: false, code: r.code, errors: r.errors.map((e) => ({ path: e.field, message: e.message })) };
}

const NOT_FOUND_TEXT = "Bản ghi không tồn tại.";
const notFound = () => objectsFail("NOT_FOUND", NOT_FOUND_TEXT, "record");

// ─────────────────────────── Cổng ───────────────────────────

export type RecordGate = { ok: true; def: AnyObjectDef; decision: ScopeDecision } | ObjectsFailure;

/** Cổng của mọi lượt đọc / ghi bản ghi — module → quyền → phạm vi (xem đầu tệp). */
export async function recordGate(objectKey: string, viewer: Viewer, mode: "view" | "write"): Promise<RecordGate> {
  const def = typeof objectKey === "string" ? await resolveObject(objectKey) : null;
  if (!def || def.system) return objectsFail("NOT_FOUND", `Không có đối tượng «${String(objectKey).slice(0, 60)}» trong tổ chức này.`, "object");
  if (def.custom?.status === "ARCHIVED") return objectsFail("NOT_FOUND", `${def.label} đã được lưu trữ.`, "object");
  const off = await objectModuleOff(def);
  if (off || (viewer.modules && !viewer.modules.includes(def.module))) return objectsFail("MODULE_DISABLED", `Module "${off ?? def.module}" của ${def.label} chưa được bật cho tổ chức này.`, "object");
  if (!(mode === "write" ? canWriteObject(viewer, def) : canViewObject(viewer, def))) {
    return objectsFail("FORBIDDEN", mode === "write" ? `Bạn không có quyền tạo / sửa ${def.labelPlural.toLocaleLowerCase("vi")}.` : `Bạn không có quyền xem ${def.labelPlural.toLocaleLowerCase("vi")}.`, "object");
  }
  const decision = await objectScope(viewer, def, mode);
  if (decision.allow === "NONE") return objectsFail("FORBIDDEN", `${decision.reason} ${decision.fix}`.trim(), "scope");
  return { ok: true, def, decision };
}

function liveWhere(def: AnyObjectDef): SQL {
  const t = schema.customRecords;
  return and(eq(t.objectKey, def.key), isNull(t.deletedAt))!;
}

async function loadRecord(def: AnyObjectDef, id: string, decision: ScopeDecision): Promise<RecordRow | null> {
  if (typeof id !== "string" || id.length === 0 || id.length > 200) return null;
  const db = await getDb();
  const t = schema.customRecords;
  const [row] = await db.select().from(t).where(andScope(and(eq(t.id, id), liveWhere(def)), decision)).limit(1);
  return row ?? null;
}

function viewableFields(viewer: Viewer, def: AnyObjectDef, defs: CustomFieldDef[]): CustomFieldDef[] {
  return defs.filter((d) => d.status === "ACTIVE" && canViewField(viewer, def, d));
}

function pickValues(values: CustomValues | null | undefined, keys: ReadonlySet<string>): CustomValues {
  const out: CustomValues = {};
  for (const [k, v] of Object.entries(values ?? {})) if (keys.has(k)) out[k] = v;
  return out;
}

/**
 * Tên của bản ghi ĐÍCH cho mọi field quan hệ người xem được xem, theo field ⇒ id ⇒ tên. CHỈ đích người xem XEM ĐƯỢC
 * (quyền + module + phạm vi của đích) — id khác vắng mặt ⇒ nơi vẽ in "—" (hợp đồng mục 3).
 */
export async function relationLabelsFor(viewer: Viewer, fields: readonly CustomFieldDef[], valuesList: readonly CustomValues[]): Promise<Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, string>> = {};
  const byTarget = new Map<string, { fields: string[]; ids: Set<string> }>();
  for (const f of fields) {
    if (!RELATION_TYPES.includes(f.type) || !f.relationObject) continue;
    const bucket = byTarget.get(f.relationObject) ?? { fields: [], ids: new Set<string>() };
    bucket.fields.push(f.key);
    for (const v of valuesList) {
      const raw = v[f.key];
      for (const id of Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]) bucket.ids.add(String(id));
    }
    byTarget.set(f.relationObject, bucket);
  }
  for (const [targetKey, bucket] of byTarget) {
    const target = await resolveObject(targetKey);
    const titles = target && target.custom?.status !== "ARCHIVED" && bucket.ids.size ? await recordTitles(viewer, target, [...bucket.ids]) : new Map<string, string>();
    for (const k of bucket.fields) out[k] = Object.fromEntries(titles);
  }
  return out;
}

// ─────────────────────────── Danh sách ───────────────────────────

/** Field hệ thống sắp được + biểu thức SQL. */
const SYSTEM_SORT: Record<string, SQL> = {
  "system:title": sql`lower(${schema.customRecords.title})`,
  "system:owner": sql`${schema.customRecords.ownerId}`,
  "system:created_at": sql`${schema.customRecords.createdAt}`,
  "system:updated_at": sql`${schema.customRecords.updatedAt}`,
};
const SORTABLE_CUSTOM_TYPES = new Set(["text", "number", "currency", "date", "datetime", "select", "status", "boolean", "email", "phone", "url"]);

function customSortSql(f: CustomFieldDef): SQL {
  const v = sql`cv.values -> ${f.key}::text`;
  if (f.type === "number" || f.type === "currency") return sql`(case when jsonb_typeof(${v}) = 'number' then (cv.values ->> ${f.key}::text)::numeric end)`;
  return sql`(cv.values ->> ${f.key}::text)`;
}

/** Bộ lọc mặc định trên field HỆ THỐNG của bản ghi tuỳ biến (tên / người phụ trách). Phép khác ⇒ bỏ (không bao giờ ném). */
function systemFilterSql(f: ListFilter): SQL | undefined {
  const t = schema.customRecords;
  const key = parseRef(f.ref)?.key;
  const col = key === "title" ? t.title : key === "owner" ? t.ownerId : null;
  if (!col) return undefined;
  switch (f.op) {
    case "eq":
      return typeof f.value === "string" ? eq(col, f.value) : undefined;
    case "neq":
      return typeof f.value === "string" ? sql`(${col} is null or ${col} <> ${f.value})` : undefined;
    case "contains":
      return typeof f.value === "string" && f.value ? ilike(col, `%${f.value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) : undefined;
    case "in":
      return Array.isArray(f.value) && f.value.length ? inArray(col, f.value.map(String)) : undefined;
    case "empty":
      return sql`(${col} is null or btrim(${col}) = '')`;
    case "not_empty":
      return sql`(${col} is not null and btrim(${col}) <> '')`;
    default:
      return undefined;
  }
}

export type RecordListResult = {
  object: ObjectHeader;
  schema: ListViewSchema;
  listVersion: number;
  customFields: CustomFieldDef[];
  rows: CustomRecordRow[];
  total: number;
  pageCount: number;
  sortable: string[];
  sort: { id: string; dir: "asc" | "desc" };
  userNames: Record<string, string>;
  relationLabels: Record<string, Record<string, string>>;
  canCreate: boolean;
  /** Bộ lọc mặc định bị bỏ vì người xem không xem được field — nói ra, không lặng lẽ biến mất. */
  filtersSkipped: number;
  scopeExplain: string;
};

/**
 * Danh sách bản ghi — lọc / sắp / phân trang ở MÁY CHỦ theo danh sách đã xuất bản (Phase 2) + phạm vi người xem.
 * `extra.fieldEq`: lọc bằng trên field tuỳ biến lọc được mà người xem XEM ĐƯỢC (field khác bị bỏ — lọc theo một field
 * không được xem là để lộ giá trị của nó qua việc bản ghi có mặt hay không).
 */
export function listRecords(objectKey: string, params: ListParams, viewer: Viewer, extra: { fieldEq?: Record<string, string>; mine?: boolean } = {}): Promise<ObjectsResult<RecordListResult>> {
  // Một lượt danh sách = một phạm vi đọc metadata (cổng, danh sách đã xuất bản, field, đích quan hệ hỏi chung một lần).
  return withMetadataReadScope(() => listRecordsInScope(objectKey, params, viewer, extra));
}

async function listRecordsInScope(objectKey: string, params: ListParams, viewer: Viewer, extra: { fieldEq?: Record<string, string>; mine?: boolean }): Promise<ObjectsResult<RecordListResult>> {
  const gate = await recordGate(objectKey, viewer, "view");
  if (!gate.ok) return gate;
  const { def, decision } = gate;
  let view: Awaited<ReturnType<typeof getPublishedListView>>;
  let defs: CustomFieldDef[];
  try {
    [view, defs] = await Promise.all([getPublishedListView(objectKey, CUSTOM_RECORD_LIST), loadCustomDefs(objectKey, false)]);
  } catch (error) {
    if (error instanceof MetadataError) return objectsFail(error.code, error.message);
    throw error;
  }
  const fields = viewableFields(viewer, def, defs);
  const viewable = new Map(fields.map((f) => [f.key, f]));
  const t = schema.customRecords;

  // ── Điều kiện ──
  const conds: (SQL | undefined)[] = [liveWhere(def)];
  const q = params.q?.trim();
  if (q) conds.push(ilike(t.title, `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`));
  if (extra.mine) conds.push(eq(t.ownerId, viewer.id));
  const customFilters: ListFilter[] = [];
  let filtersSkipped = 0;
  for (const f of view.schema.defaultFilters) {
    const p = parseRef(f.ref);
    if (p?.kind === "system") conds.push(systemFilterSql(f));
    else if (p && viewable.has(p.key)) customFilters.push(f);
    else filtersSkipped += 1;
  }
  for (const [key, value] of Object.entries(extra.fieldEq ?? {})) {
    const f = viewable.get(key);
    if (!f || !f.filterable || !value) continue;
    customFilters.push({ ref: `custom:${key}` as FieldRef, op: "eq", value: f.type === "boolean" ? value === "true" : f.type === "number" || f.type === "currency" ? Number(value) : value });
  }
  if (customFilters.length) conds.push(customValuesFilterSql(objectKey, customFilters));
  const where = andScope(and(...conds.filter((c): c is SQL => Boolean(c))), decision);

  // ── Sắp xếp ──
  const sortable = [...Object.keys(SYSTEM_SORT), ...fields.filter((f) => SORTABLE_CUSTOM_TYPES.has(f.type)).map((f) => `custom:${f.key}`)];
  const wanted = params.sort && sortable.includes(params.sort) ? params.sort : view.schema.defaultSort && sortable.includes(view.schema.defaultSort.ref) ? view.schema.defaultSort.ref : "system:updated_at";
  const dir: "asc" | "desc" = params.sort && sortable.includes(params.sort) ? params.dir : (view.schema.defaultSort?.dir ?? "desc");
  const sortExpr = wanted.startsWith("custom:") ? customSortSql(viewable.get(wanted.slice(7))!) : SYSTEM_SORT[wanted];
  const order = dir === "asc" ? sql`${sortExpr} asc nulls last` : sql`${sortExpr} desc nulls last`;

  const db = await getDb();
  const cvJoin = sql`left join ${schema.customValues} cv on cv.object_key = ${t.objectKey} and cv.record_id = ${t.id}`;
  const [{ n }] = await db.select({ n: count() }).from(t).where(where);
  const total = Number(n);
  const pageSize = params.pageSize;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(params.page, pageCount);
  const rows = await db.execute(
    sql`select ${t.id} as id, ${t.title} as title, ${t.ownerId} as owner_id, ${t.createdAt} as created_at, ${t.updatedAt} as updated_at, cv.values as values
        from ${t} ${cvJoin}
        where ${where}
        order by ${order}, ${t.id} asc
        limit ${pageSize} offset ${(page - 1) * pageSize}`,
  );
  const list = rowsOf<{ id: string; title: string; owner_id: string | null; created_at: Date | string; updated_at: Date | string; values: CustomValues | null }>(rows);
  const keys = new Set(viewable.keys());
  const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
  const userIds = [
    ...list.map((r) => r.owner_id).filter((x): x is string => Boolean(x)),
    ...list.flatMap((r) => fields.filter((f) => f.type === "user").map((f) => r.values?.[f.key]).filter((x): x is string => typeof x === "string")),
  ];
  const userNames = await userLabelsByIds(userIds);
  const out: CustomRecordRow[] = list.map((r) => ({
    id: String(r.id),
    title: r.title,
    ownerId: r.owner_id ?? null,
    ownerName: r.owner_id ? (userNames[r.owner_id] ?? null) : null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    values: pickValues(r.values, keys),
  }));
  const relationLabels = await relationLabelsFor(
    viewer,
    fields.filter((f) => view.schema.columns.some((c) => c.visible && c.ref === `custom:${f.key}`)),
    out.map((r) => r.values),
  );
  return {
    ok: true,
    object: header(def),
    schema: view.schema,
    listVersion: view.version,
    customFields: fields,
    rows: out,
    total,
    pageCount,
    sortable,
    sort: { id: wanted, dir },
    userNames,
    relationLabels,
    canCreate: canWriteObject(viewer, def),
    filtersSkipped,
    scopeExplain: decision.allow === "ROWS" ? decision.explain : "",
  };
}

// ─────────────────────────── Một bản ghi ───────────────────────────

export type RecordDetailResult = {
  object: ObjectHeader;
  record: CustomRecordDetail;
  customFields: CustomFieldDef[];
  userNames: Record<string, string>;
  relationLabels: Record<string, Record<string, string>>;
  canWrite: boolean;
};

export async function getRecord(objectKey: string, id: string, viewer: Viewer): Promise<ObjectsResult<RecordDetailResult>> {
  const gate = await recordGate(objectKey, viewer, "view");
  if (!gate.ok) return gate;
  const row = await loadRecord(gate.def, id, gate.decision);
  if (!row) return notFound();
  const defs = await loadCustomDefs(objectKey, false);
  const fields = viewableFields(viewer, gate.def, defs);
  const db = await getDb();
  const [cv] = await db
    .select({ values: schema.customValues.values })
    .from(schema.customValues)
    .where(and(eq(schema.customValues.objectKey, objectKey), eq(schema.customValues.recordId, row.id)))
    .limit(1);
  const values = pickValues(cv?.values, new Set(fields.map((f) => f.key)));
  const userIds = [row.ownerId, row.createdBy, row.updatedBy, ...fields.filter((f) => f.type === "user").map((f) => values[f.key])].filter((x): x is string => typeof x === "string");
  const userNames = await userLabelsByIds(userIds);
  const canWrite = canWriteObject(viewer, gate.def) && (await visibleRecordIds(viewer, gate.def, [row.id], "write")).has(row.id);
  return {
    ok: true,
    object: header(gate.def),
    record: {
      id: row.id,
      title: row.title,
      ownerId: row.ownerId,
      ownerName: row.ownerId ? (userNames[row.ownerId] ?? null) : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      values,
      version: row.version,
      createdBy: row.createdBy,
      updatedBy: row.updatedBy,
    },
    customFields: fields,
    userNames,
    relationLabels: await relationLabelsFor(viewer, fields, [values]),
    canWrite,
  };
}

// ─────────────────────────── Ghi ───────────────────────────

export type RecordInput = { system?: Record<string, unknown>; custom?: CustomValues; version?: number };

type SystemPatch = { title?: string; ownerId?: string | null };

/** Kiểm cột hệ thống gửi lên theo form ĐÃ XUẤT BẢN. `creating`: tên bắt buộc có mặt. */
async function checkSystem(
  viewer: Viewer,
  decision: ScopeDecision,
  input: Record<string, unknown>,
  writable: Map<string, boolean>,
  current: RecordRow | null,
  titleLabel: string,
): Promise<{ patch: SystemPatch; errors: { path: string; message: string }[] }> {
  const errors: { path: string; message: string }[] = [];
  const patch: SystemPatch = {};
  for (const key of Object.keys(input)) {
    if (!writable.has(key) || (key !== "title" && key !== "owner")) errors.push({ path: `system:${key}`, message: `Trường "${key}" không nhận ghi qua form này (ẩn hoặc chỉ đọc).` });
  }
  if (!current && !writable.has("title")) errors.push({ path: "system:title", message: `Form tạo đã xuất bản không có ô ${titleLabel} — sửa form trước.` });
  if ("title" in input && writable.has("title")) {
    const raw = input.title;
    const title = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : raw === null || raw === undefined ? "" : null;
    if (title === null) errors.push({ path: "system:title", message: `${titleLabel} phải là chữ.` });
    else if (!title) errors.push({ path: "system:title", message: `${titleLabel} là bắt buộc.` });
    else if ([...title].length > TITLE_MAX_LENGTH) errors.push({ path: "system:title", message: `${titleLabel} tối đa ${TITLE_MAX_LENGTH} ký tự.` });
    else if (!current || title !== current.title) patch.title = title;
  } else if (!current) errors.push({ path: "system:title", message: `${titleLabel} là bắt buộc.` });
  if ("owner" in input && writable.has("owner")) {
    const raw = input.owner;
    // Tạo mới mà ô để trống ⇒ người tạo là chủ (mặc định), không phải "không ai phụ trách".
    const owner = typeof raw === "string" && raw.trim() ? raw.trim() : current ? null : viewer.id;
    if (writable.get("owner") && !owner) errors.push({ path: "system:owner", message: "Người phụ trách là bắt buộc." });
    else if (owner !== (current ? current.ownerId : viewer.id)) {
      // Phạm vi hẹp chỉ đặt CHÍNH MÌNH làm người phụ trách: giao cho người khác là đẩy bản ghi ra khỏi phạm vi của mình
      // (và vào phạm vi của người ta) — việc của người có phạm vi Toàn công ty / quản trị.
      if (decision.allow !== "ALL" && owner !== viewer.id) errors.push({ path: "system:owner", message: "Phạm vi dữ liệu của bạn chỉ cho đặt chính mình làm người phụ trách." });
      else if (owner) {
        const db = await getDb();
        const [u] = await db.select({ id: schema.users.id, active: schema.users.active }).from(schema.users).where(eq(schema.users.id, owner)).limit(1);
        if (!u || !u.active) errors.push({ path: "system:owner", message: "Người phụ trách: tài khoản không tồn tại (hoặc đã tắt) trong tổ chức này." });
        else patch.ownerId = owner;
      } else patch.ownerId = null;
    }
  }
  return { patch, errors };
}

export async function createRecord(objectKey: string, input: RecordInput, viewer: Viewer): Promise<ObjectsResult<{ id: string; href: string }>> {
  const gate = await recordGate(objectKey, viewer, "write");
  if (!gate.ok) return gate;
  const { def, decision } = gate;
  const sysIn = input?.system && typeof input.system === "object" && !Array.isArray(input.system) ? input.system : {};
  const customIn = input?.custom && typeof input.custom === "object" && !Array.isArray(input.custom) ? input.custom : {};
  const [form, defs] = await Promise.all([getPublishedForm(objectKey, CUSTOM_RECORD_FORM_CREATE), loadCustomDefs(objectKey, true)]);
  const sys = await checkSystem(viewer, decision, sysIn, writableSystemKeys(form.schema), null, def.custom?.titleLabel ?? "Tên");
  const errors = [...sys.errors];
  // Field tuỳ biến: kiểm TRƯỚC khi chèn bản ghi (cùng hàm máy chủ dùng khi ghi).
  const writable = writableCustomKeys(form.schema);
  for (const key of Object.keys(customIn)) {
    const d = defs.find((x) => x.key === key && x.status === "ACTIVE");
    if (d && !writable.has(key)) errors.push({ path: key, message: `Field "${d.label}" không nhận ghi qua form này (ẩn hoặc chỉ đọc).` });
    else if (d && !canEditField(viewer, def, d)) errors.push({ path: key, message: `Bạn không có quyền sửa "${d.label}".` });
  }
  const effective = defs.map((d) => (d.required && d.status === "ACTIVE" && !canEditField(viewer, def, d) ? { ...d, required: false } : d));
  for (const e of validateCustomValues(effective, customIn, null).errors) if (!errors.some((x) => x.path === e.field)) errors.push({ path: e.field, message: e.message });
  if (errors.length) return objectsFail("INVALID", errors);
  // Hạn mức gói (Phase 10 · §5) — SAU cổng quyền và kiểm đầu vào (người không được tạo nhận đúng câu của cổng), TRƯỚC
  // lượt chèn. Tổ chức nhà = nội bộ, không đếm gì.
  const ent = await checkEntitlement("records", 1);
  if (!ent.ok) return objectsFail("INVALID", ent.error);

  const db = await getDb();
  const t = schema.customRecords;
  const ownerId = "ownerId" in sys.patch ? (sys.patch.ownerId ?? null) : viewer.id;
  const [created] = await db.insert(t).values({ objectKey, title: sys.patch.title!, ownerId, createdBy: viewer.id, updatedBy: viewer.id }).returning();
  if (Object.keys(customIn).length) {
    const saved = await saveCustomValues(objectKey, created.id, customIn, viewer, { formKey: CUSTOM_RECORD_FORM_CREATE });
    if (!saved.ok) {
      await db.delete(schema.customValues).where(and(eq(schema.customValues.objectKey, objectKey), eq(schema.customValues.recordId, created.id)));
      await db.delete(t).where(eq(t.id, created.id));
      return fromMeta(saved);
    }
  }
  await db.transaction(async (tx) => {
    await emitDomainEvent(tx, {
      name: "custom_record.created",
      subjectType: METADATA_RECORD_SUBJECT,
      subjectId: `${objectKey}:${created.id}`,
      payload: { objectKey, recordId: created.id, ownerId, fields: Object.keys(customIn).sort() },
      actorKind: "USER",
      actorId: viewer.id,
      source: `objects:${objectKey}`,
      dedupeKey: `custom_record.created:${created.id}`,
    });
  });
  await audit({
    userId: viewer.id,
    userEmail: viewer.email,
    action: "CUSTOM_RECORD_CREATE",
    entity: "CUSTOM_RECORD",
    entityId: `${objectKey}:${created.id}`,
    before: null,
    after: { title: created.title, ownerId },
    reason: `Tạo qua form "${CUSTOM_RECORD_FORM_CREATE}" (phiên bản ${form.version}${form.isDefault ? ", mặc định" : ""})`,
  });
  return { ok: true, id: created.id, href: customObjectHref(objectKey, created.id) };
}

export async function updateRecord(objectKey: string, id: string, input: RecordInput, viewer: Viewer): Promise<ObjectsResult<{ values: CustomValues; changed: string[]; version: number }>> {
  const gate = await recordGate(objectKey, viewer, "write");
  if (!gate.ok) return gate;
  const { def, decision } = gate;
  const row = await loadRecord(def, id, decision);
  if (!row) return notFound();
  if (typeof input?.version === "number" && input.version !== row.version) return objectsFail("CONFLICT", "Bản ghi vừa được người khác sửa — tải lại rồi lưu lại.");
  const sysIn = input?.system && typeof input.system === "object" && !Array.isArray(input.system) ? input.system : {};
  const customIn = input?.custom && typeof input.custom === "object" && !Array.isArray(input.custom) ? input.custom : {};
  const form = await getPublishedForm(objectKey, CUSTOM_RECORD_FORM_EDIT);
  const sys = await checkSystem(viewer, decision, sysIn, writableSystemKeys(form.schema), row, def.custom?.titleLabel ?? "Tên");
  if (sys.errors.length) return objectsFail("INVALID", sys.errors);

  let customChanged: string[] = [];
  let values: CustomValues = {};
  if (Object.keys(customIn).length) {
    const saved = await saveCustomValues(objectKey, id, customIn, viewer, { formKey: CUSTOM_RECORD_FORM_EDIT });
    if (!saved.ok) return fromMeta(saved);
    customChanged = saved.changed;
    values = saved.values;
  }
  const systemChanged = Object.keys(sys.patch).map((k) => (k === "ownerId" ? "system:owner" : `system:${k}`));
  const changed = [...systemChanged, ...customChanged];
  if (changed.length === 0) return { ok: true, values, changed: [], version: row.version };

  const db = await getDb();
  const t = schema.customRecords;
  const version = await db.transaction(async (tx) => {
    const [u] = await tx
      .update(t)
      .set({ ...sys.patch, version: row.version + 1, updatedBy: viewer.id, updatedAt: new Date() })
      .where(and(eq(t.id, id), eq(t.version, row.version), isNull(t.deletedAt)))
      .returning({ version: t.version });
    if (!u) return null;
    await emitDomainEvent(tx, {
      name: "custom_record.updated",
      subjectType: METADATA_RECORD_SUBJECT,
      subjectId: `${objectKey}:${id}`,
      payload: { objectKey, recordId: id, changed, version: u.version },
      actorKind: "USER",
      actorId: viewer.id,
      source: `objects:${objectKey}`,
      dedupeKey: `custom_record.updated:${id}:${u.version}`,
    });
    return u.version;
  });
  if (version === null) return objectsFail("CONFLICT", "Bản ghi vừa được người khác sửa — tải lại rồi lưu lại.");
  if (systemChanged.length) {
    await audit({
      userId: viewer.id,
      userEmail: viewer.email,
      action: "CUSTOM_RECORD_UPDATE",
      entity: "CUSTOM_RECORD",
      entityId: `${objectKey}:${id}`,
      before: Object.fromEntries(Object.keys(sys.patch).map((k) => [k, k === "title" ? row.title : row.ownerId])),
      after: sys.patch,
    });
  }
  return { ok: true, values, changed, version };
}

export async function deleteRecord(objectKey: string, id: string, viewer: Viewer): Promise<ObjectsResult> {
  const gate = await recordGate(objectKey, viewer, "write");
  if (!gate.ok) return gate;
  const row = await loadRecord(gate.def, id, gate.decision);
  if (!row) return notFound();
  const db = await getDb();
  const t = schema.customRecords;
  const done = await db.transaction(async (tx) => {
    const [u] = await tx
      .update(t)
      .set({ deletedAt: new Date(), version: row.version + 1, updatedBy: viewer.id, updatedAt: new Date() })
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .returning({ id: t.id });
    if (!u) return false;
    await emitDomainEvent(tx, {
      name: "custom_record.deleted",
      subjectType: METADATA_RECORD_SUBJECT,
      subjectId: `${objectKey}:${id}`,
      payload: { objectKey, recordId: id },
      actorKind: "USER",
      actorId: viewer.id,
      source: `objects:${objectKey}`,
      dedupeKey: `custom_record.deleted:${id}`,
    });
    return true;
  });
  // Đã xoá (bấm hai lần) ⇒ không ghi gì thêm — cùng câu "không tồn tại".
  if (!done) return notFound();
  await audit({ userId: viewer.id, userEmail: viewer.email, action: "CUSTOM_RECORD_DELETE", entity: "CUSTOM_RECORD", entityId: `${objectKey}:${id}`, before: { title: row.title, ownerId: row.ownerId }, after: null });
  return { ok: true };
}

// ─────────────────────────── Chiều ngược của quan hệ ───────────────────────────

const REVERSE_SCAN = 200;
const REVERSE_SHOW = 50;

/**
 * Bản ghi TRỎ TỚI một bản ghi (một-nhiều = chiều ngược của `relation` / `relation_many`), nhóm theo (đối tượng, field).
 * Chỉ nhóm của đối tượng người xem mở được + field người xem được xem; chỉ bản ghi nguồn người xem xem được (phạm vi).
 * Nơi gọi đã kiểm người xem xem được bản ghi ĐÍCH. Tìm theo `custom_values` của CSDL tổ chức hiện hành.
 */
export function reverseRelations(targetObjectKey: string, targetId: string, viewer: Viewer): Promise<ReverseRelationGroup[]> {
  // Nhiều field của CÙNG đối tượng nguồn trỏ về đây ⇒ đối tượng + field của nó đọc một lần (lib/metadata/read-scope.ts).
  return withMetadataReadScope(() => reverseRelationsInScope(targetObjectKey, targetId, viewer));
}

async function reverseRelationsInScope(targetObjectKey: string, targetId: string, viewer: Viewer): Promise<ReverseRelationGroup[]> {
  const db = await getDb();
  const mf = schema.metaCustomFields;
  const fieldRows = await db
    .select()
    .from(mf)
    .where(and(eq(mf.relationObject, targetObjectKey), eq(mf.status, "ACTIVE"), inArray(mf.fieldType, ["relation", "relation_many"])))
    .orderBy(asc(mf.objectKey), asc(mf.position));
  const out: ReverseRelationGroup[] = [];
  const cv = schema.customValues;
  for (const f of fieldRows) {
    const source = await resolveObject(f.objectKey);
    if (!source || source.custom?.status === "ARCHIVED") continue;
    const defs = await loadCustomDefs(f.objectKey, false);
    const fd = defs.find((d) => d.key === f.fieldKey);
    if (!fd || !canViewField(viewer, source, fd)) continue;
    const hits = await db
      .select({ recordId: cv.recordId })
      .from(cv)
      .where(and(eq(cv.objectKey, f.objectKey), sql`(${cv.values} -> ${f.fieldKey}::text = to_jsonb(${targetId}::text) or ${cv.values} -> ${f.fieldKey}::text @> jsonb_build_array(${targetId}::text))`))
      .orderBy(desc(cv.updatedAt))
      .limit(REVERSE_SCAN);
    if (!hits.length) continue;
    const titles = await recordTitles(viewer, source, hits.map((h) => h.recordId));
    if (!titles.size) continue;
    const ids = hits.map((h) => h.recordId).filter((x) => titles.has(x));
    out.push({
      objectKey: source.key,
      objectLabel: source.labelPlural,
      fieldKey: fd.key,
      fieldLabel: fd.label,
      records: ids.slice(0, REVERSE_SHOW).map((x) => ({ id: x, title: titles.get(x)!, href: source.system ? (pageDetailHref(source.key, x) ?? null) : customObjectHref(source.key, x) })),
      truncated: ids.length > REVERSE_SHOW || hits.length >= REVERSE_SCAN,
    });
  }
  return out;
}

// ─────────────────────────── Dòng thời gian ───────────────────────────

export type RecordTimelineEntry = { id: string; at: string; title: string; detail: string; source: string };

/**
 * Dòng thời gian của bản ghi = `audit_logs` + `domain_events` (subject `custom_record`) — hai nhật ký có sẵn, không chép.
 * Mốc chạm tới field người xem KHÔNG được xem thì không hiện (kể cả tên field). Nơi gọi đã kiểm người xem xem được bản ghi.
 */
export async function recordTimeline(objectKey: string, recordId: string, viewer: Viewer, def: AnyObjectDef): Promise<RecordTimelineEntry[]> {
  const defs = await loadCustomDefs(objectKey, true);
  const hidden = new Set(defs.filter((d) => d.status !== "ACTIVE" || !canViewField(viewer, def, d)).map((d) => d.key));
  const raw: RecordTimelineRaw[] = await getRecordTimeline(objectKey, recordId, 100);
  const label = new Map(defs.map((d) => [d.key, d.label]));
  return raw
    .filter((e) => !e.fieldKeys.some((k) => hidden.has(k)))
    .map((e) => ({
      id: e.id,
      at: e.at.toISOString(),
      title: e.kind === "EVENT" ? domainEventLabel(e.name) : e.title,
      detail: e.kind === "EVENT" ? e.detail : e.fieldKeys.map((k) => label.get(k) ?? (k === "ownerId" ? "Người phụ trách" : k === "title" ? "Tên" : k)).join(", "),
      source: e.source,
    }));
}

// ─────────────────────────── Lựa chọn cho ô quan hệ ───────────────────────────

const RELATION_PICK_MAX = 200;

/**
 * Lựa chọn cho ô `relation` / `relation_many` của form: tối đa 200 bản ghi ĐÍCH người xem XEM ĐƯỢC (quyền + module +
 * phạm vi), xếp theo tên. Đích nhiều hơn trần ⇒ ô vẫn nhận mã gõ tay (máy chủ kiểm lại khi ghi).
 */
export async function relationOptionsFor(viewer: Viewer, fields: readonly CustomFieldDef[]): Promise<Record<string, { id: string; label: string }[]>> {
  const out: Record<string, { id: string; label: string }[]> = {};
  const cache = new Map<string, { id: string; label: string }[]>();
  for (const f of fields) {
    if (!RELATION_TYPES.includes(f.type) || !f.relationObject) continue;
    if (!cache.has(f.relationObject)) {
      const target = await resolveObject(f.relationObject);
      let opts: { id: string; label: string }[] = [];
      if (target && target.custom?.status !== "ARCHIVED" && !(await objectModuleOff(target)) && canViewObject(viewer, target)) {
        const decision = await objectScope(viewer, target, "view");
        if (decision.allow !== "NONE") {
          const db = await getDb();
          const table = (schema as unknown as Record<string, unknown>)[target.table] as PgTable;
          const idCol = idColumnOf(target);
          const titleColName = target.fields.find((x) => x.key === target.titleField)?.column ?? target.idColumn;
          const titleCol = ((table as unknown as Record<string, unknown>)[titleColName] ?? idCol) as PgColumn;
          const where = recordScopeSql(target);
          const rows = await db
            .select({ id: sql<string>`${idCol}::text`, title: sql<string | null>`${titleCol}::text` })
            .from(table)
            .where(decision.allow === "ROWS" ? (target.system ? sql`false` : andScope(where, decision)) : where)
            .orderBy(sql`${titleCol} asc`)
            .limit(RELATION_PICK_MAX);
          opts = rows.map((r) => ({ id: String(r.id), label: r.title?.trim() ? r.title : String(r.id) }));
        }
      }
      cache.set(f.relationObject, opts);
    }
    out[f.key] = cache.get(f.relationObject)!;
  }
  return out;
}

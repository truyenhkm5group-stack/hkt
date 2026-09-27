/**
 * ═══════════ LÕI THUẦN CỦA FORM / DANH SÁCH THEO METADATA (Phase 2, M8 · M9) ═══════════
 *
 * Không "use client", không JSX, không đọc CSDL: cả trang máy chủ lẫn component trình duyệt gọi
 * được, và bài kiểm `tests/metadata-runtime.test.ts` gọi thẳng. Hợp đồng:
 * docs/platform/phase-2-contracts.md mục 1 (M7–M10) và mục 3 (luật form).
 *
 * Ba việc, mỗi việc một hàm:
 *  · `buildFormLayout`  — schema đã xuất bản + định nghĩa field ⇒ section → field ĐÃ PHÂN GIẢI để vẽ.
 *    `required` chỉ CHẶT thêm (field bắt buộc không nới được), field hệ thống `editable: false` luôn
 *    chỉ đọc, field ẩn không vẽ (và vì thế không gửi lên — máy chủ vẫn là chỗ chặn thật).
 *  · `applyListView`    — áp danh sách đã xuất bản lên CỘT CỦA MÃ NGUỒN: thứ tự, ẩn/hiện, chèn cột
 *    custom. Không schema ⇒ trả NGUYÊN mảng cột (tổ chức chưa cấu hình thấy y hệt hôm nay). Cột mã
 *    nguồn không field nào trỏ tới giữ nguyên, đứng ngay sau cột gốc đứng trước nó.
 *  · `formatCustomValue` — in một giá trị custom theo kiểu; chưa có giá trị ⇒ "—" (AGENTS.md mục 42).
 */
import { formatDate, formatDateTime, formatNumber, formatVND, MISSING_TEXT } from "@/lib/format";
import type { CustomFieldDef, CustomValues, FieldError, FieldOption, FieldRef, FieldType, FieldValidation, FormSchema, ListViewSchema, SystemFieldDef } from "@/lib/metadata/types";
import { validateCustomValues } from "@/lib/metadata/validate";

// ───────────────────────── Tham chiếu field ─────────────────────────

export function parseFieldRef(ref: string): { kind: "system" | "custom"; key: string } | null {
  if (ref.startsWith("system:")) return ref.length > 7 ? { kind: "system", key: ref.slice(7) } : null;
  if (ref.startsWith("custom:")) return ref.length > 7 ? { kind: "custom", key: ref.slice(7) } : null;
  return null;
}

/** Id cột của một field custom trong bảng — trùng dạng `FieldRef` để cột và cấu hình nói cùng một khoá. */
export function customColumnId(key: string): FieldRef {
  return `custom:${key}`;
}

// ───────────────────────── Form ─────────────────────────

export type ResolvedFormField = {
  ref: FieldRef;
  kind: "system" | "custom";
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  readOnly: boolean;
  /** Vì sao chỉ đọc (hiện dưới ô) — `null` khi ô sửa được. */
  readOnlyReason: string | null;
  defaultValue: unknown;
  options: FieldOption[];
  validation: FieldValidation;
  transitions: Record<string, string[]>;
  relationObject: string | null;
  helpText: string | null;
};

export type ResolvedFormSection = { key: string; label: string; fields: ResolvedFormField[] };

export type FormLayoutOptions = {
  /**
   * Field hệ thống CHỈ ĐỌC trong form này dù sổ khai `editable` — kèm lý do in dưới ô. Vd khách hàng
   * đồng bộ từ Pancake: sửa ở ERP thì lượt đồng bộ kế tiếp ghi đè lại.
   */
  systemReadOnlyReason?: string | null;
  /**
   * Khoá field custom người đang xem SỬA ĐƯỢC — trang máy chủ tính bằng `canEditField` của dịch vụ (quyền
   * ghi của đối tượng + `editPermission` của field). Vắng mặt ⇒ không thu hẹp. Chỉ để UX: máy chủ chặn
   * lại khi ghi.
   */
  customEditable?: readonly string[];
  /** Lý do cụ thể cho field custom bị khoá (vd tệp trên form tạo). Vắng ⇒ "Không đủ quyền sửa trường này". */
  customLockedReason?: Readonly<Record<string, string>>;
};

/**
 * Schema ⇒ section/field để vẽ. Ref lạ, field custom ARCHIVED, field `visible: false` bị bỏ; section
 * không còn field nào bị bỏ; một field chỉ vẽ MỘT lần dù schema nhắc hai lần.
 *
 * Cùng luật với `normalizeFormSchema` của dịch vụ (lib/metadata/form-schema.ts): field BẮT BUỘC mà form
 * không khai chỉ đọc thì KHÔNG ẩn được — ẩn nó là một form không bao giờ lưu nổi.
 */
export function buildFormLayout(schema: FormSchema, system: readonly SystemFieldDef[], custom: readonly CustomFieldDef[], opts: FormLayoutOptions = {}): ResolvedFormSection[] {
  const systemByKey = new Map(system.map((f) => [f.key, f]));
  const customByKey = new Map(custom.filter((f) => f.status === "ACTIVE").map((f) => [f.key, f]));
  const seen = new Set<string>();
  const sections: ResolvedFormSection[] = [];
  for (const section of schema.sections) {
    const fields: ResolvedFormField[] = [];
    for (const cfg of section.fields) {
      const ref = parseFieldRef(cfg.ref);
      if (!ref || seen.has(cfg.ref)) continue;
      if (ref.kind === "system") {
        const def = systemByKey.get(ref.key);
        if (!def || !(cfg.visible || ((def.required || cfg.required) && !cfg.readOnly && def.editable))) continue;
        seen.add(cfg.ref);
        const reason = !def.editable ? "Trường hệ thống — không sửa ở đây" : opts.systemReadOnlyReason ? opts.systemReadOnlyReason : cfg.readOnly ? "Form khai chỉ đọc" : null;
        fields.push({
          ref: cfg.ref,
          kind: "system",
          key: def.key,
          label: def.label,
          type: def.type,
          required: def.required || cfg.required,
          readOnly: reason !== null,
          readOnlyReason: reason,
          defaultValue: cfg.defaultValue,
          options: def.options ?? [],
          validation: {},
          transitions: {},
          relationObject: null,
          helpText: null,
        });
      } else {
        const def = customByKey.get(ref.key);
        if (!def || !(cfg.visible || ((def.required || cfg.required) && !cfg.readOnly))) continue;
        seen.add(cfg.ref);
        const lacksPermission = opts.customEditable !== undefined && !opts.customEditable.includes(def.key);
        const reason = lacksPermission ? (opts.customLockedReason?.[def.key] ?? "Không đủ quyền sửa trường này") : cfg.readOnly ? "Form khai chỉ đọc" : null;
        fields.push({
          ref: cfg.ref,
          kind: "custom",
          key: def.key,
          label: def.label,
          type: def.type,
          required: def.required || cfg.required,
          readOnly: reason !== null,
          readOnlyReason: reason,
          defaultValue: cfg.defaultValue !== undefined ? cfg.defaultValue : def.defaultValue,
          options: [...def.options].sort((a, b) => a.position - b.position),
          validation: def.validation ?? {},
          transitions: def.transitions ?? {},
          relationObject: def.relationObject,
          helpText: def.helpText,
        });
      }
    }
    if (fields.length) sections.push({ key: section.key, label: section.label, fields });
  }
  return sections;
}

/** Giá trị trống theo nghĩa "chưa nhập": `null`, `undefined`, chuỗi rỗng/khoảng trắng, mảng rỗng. */
export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Giá trị ban đầu của form: giá trị đã lưu, không có thì mặc định (của form, rồi của field) — CHỈ
 * cho ô sửa được và chưa có giá trị. Ô chỉ đọc không bao giờ nhận mặc định: nó sẽ trông như đã lưu.
 */
export function initialFormValues(sections: readonly ResolvedFormSection[], values: { system: Record<string, unknown>; custom: CustomValues }): { system: Record<string, unknown>; custom: CustomValues } {
  const system: Record<string, unknown> = {};
  const custom: CustomValues = {};
  for (const s of sections) {
    for (const f of s.fields) {
      const bucket = f.kind === "system" ? system : custom;
      const stored = f.kind === "system" ? values.system[f.key] : values.custom[f.key];
      bucket[f.key] = isEmptyValue(stored) && !f.readOnly && f.defaultValue !== undefined && f.defaultValue !== null ? f.defaultValue : (stored ?? null);
    }
  }
  return { system, custom };
}

/**
 * Trạng thái nghiệp vụ: các giá trị được CHỌN từ giá trị hiện tại. Chưa có giá trị ⇒ mọi giá trị
 * đang bật; có giá trị ⇒ chính nó + đích khai trong `transitions` (bảng chuyển rỗng = mọi chuyển
 * đều được, đúng hợp đồng `CustomFieldDef.transitions`). Giá trị tắt không bao giờ là đích, nhưng
 * giá trị hiện tại vẫn hiện dù đã tắt — nếu không ô sẽ trông như trống.
 */
export function statusTargets(options: readonly FieldOption[], transitions: Record<string, string[]>, current: unknown): FieldOption[] {
  const sorted = [...options].sort((a, b) => a.position - b.position);
  const cur = typeof current === "string" && current ? current : null;
  if (!cur) return sorted.filter((o) => o.active);
  const hasTable = Object.keys(transitions).length > 0;
  const allowed = new Set(hasTable ? (transitions[cur] ?? []) : sorted.map((o) => o.value));
  return sorted.filter((o) => o.value === cur || (o.active && allowed.has(o.value)));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9 .-]{8,15}$/;

/**
 * Kiểm phía trình duyệt — CHỈ để UX (M6: kiểm thật chạy ở máy chủ). Ô chỉ đọc không kiểm: người dùng
 * không sửa được thì báo lỗi ở đó chỉ là chặn nút Lưu vô cớ.
 *
 * Field custom đi qua ĐÚNG hàm máy chủ dùng (`validateCustomValues`, thuần) trên các field SỬA ĐƯỢC của
 * form — hai bên không thể nói hai luật. Field hệ thống (form tạo bản ghi) kiểm tối thiểu ở đây; máy
 * chủ kiểm lại bằng lược đồ của đường ghi.
 */
export function validateFormClient(
  sections: readonly ResolvedFormSection[],
  values: { system: Record<string, unknown>; custom: CustomValues },
  customDefs: readonly CustomFieldDef[],
  storedCustom: CustomValues | null,
): FieldError[] {
  const errors: FieldError[] = [];
  const editableCustom = new Set<string>();
  const input: CustomValues = {};
  for (const s of sections) {
    for (const f of s.fields) {
      if (f.readOnly) continue;
      if (f.kind === "custom") {
        editableCustom.add(f.key);
        input[f.key] = values.custom[f.key] ?? null;
        continue;
      }
      const id = fieldErrorKey(f);
      const v = f.kind === "system" ? values.system[f.key] : values.custom[f.key];
      if (isEmptyValue(v)) {
        if (f.required) errors.push({ field: id, message: `${f.label} là bắt buộc` });
        continue;
      }
      const msg = checkValue(f, v);
      if (msg) errors.push({ field: id, message: msg });
    }
  }
  if (editableCustom.size) {
    // `required` của field theo form (chặt hơn định nghĩa) cũng áp ở đây.
    const requiredByForm = new Set(sections.flatMap((s) => s.fields.filter((f) => f.kind === "custom" && f.required).map((f) => f.key)));
    const defs = customDefs.filter((d) => editableCustom.has(d.key)).map((d) => (requiredByForm.has(d.key) ? { ...d, required: true } : d));
    errors.push(...validateCustomValues(defs, input, storedCustom).errors);
  }
  return errors;
}

function checkValue(f: ResolvedFormField, v: unknown): string | null {
  const val = f.validation;
  switch (f.type) {
    case "number":
    case "currency": {
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n)) return `${f.label} phải là số`;
      if (f.type === "currency" && !Number.isInteger(n)) return `${f.label} là tiền VND — số nguyên`;
      if (val.min !== undefined && n < val.min) return `${f.label} tối thiểu ${formatNumber(val.min)}`;
      if (val.max !== undefined && n > val.max) return `${f.label} tối đa ${formatNumber(val.max)}`;
      return null;
    }
    case "email":
      return typeof v === "string" && EMAIL_RE.test(v.trim()) ? null : `${f.label} không phải email hợp lệ`;
    case "phone":
      return typeof v === "string" && PHONE_RE.test(v.trim()) ? null : `${f.label} không phải số điện thoại hợp lệ`;
    case "url":
      return typeof v === "string" && /^https?:\/\/\S+$/i.test(v.trim()) ? null : `${f.label} phải bắt đầu bằng http:// hoặc https://`;
    case "select":
    case "status":
      return f.options.some((o) => o.value === v) ? null : `${f.label}: giá trị không có trong danh sách`;
    case "multi_select":
      return Array.isArray(v) && v.every((x) => f.options.some((o) => o.value === x)) ? null : `${f.label}: có giá trị không có trong danh sách`;
    case "text":
    case "textarea": {
      const s = String(v);
      if (val.minLength !== undefined && s.length < val.minLength) return `${f.label} tối thiểu ${val.minLength} ký tự`;
      if (val.maxLength !== undefined && s.length > val.maxLength) return `${f.label} tối đa ${val.maxLength} ký tự`;
      return null;
    }
    default:
      return null;
  }
}

/** Khoá lỗi theo hợp đồng `FieldError.field`: khoá field custom, hoặc `system:<khoá>`. */
export function fieldErrorKey(f: Pick<ResolvedFormField, "kind" | "key">): string {
  return f.kind === "system" ? `system:${f.key}` : f.key;
}

/** Chuỗi ô tiền ⇒ số nguyên VND (bỏ mọi dấu phân cách). Rỗng ⇒ `null`, KHÔNG phải 0. */
export function parseCurrencyInput(raw: string): number | null {
  const neg = raw.trim().startsWith("-");
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) ? (neg ? -n : n) : null;
}

// ───────────────────────── Ngày giờ theo giờ Việt Nam ─────────────────────────

/** ISO ⇒ giá trị ô `datetime-local` theo GIỜ VIỆT NAM (không theo múi giờ máy người dùng). */
export function isoToVnLocalInput(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 16);
}

/** Giá trị ô `datetime-local` (hiểu là giờ Việt Nam) ⇒ ISO UTC. Rỗng ⇒ `null`. */
export function vnLocalInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(`${value}:00+07:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ───────────────────────── Danh sách ─────────────────────────

/**
 * Áp danh sách đã xuất bản lên cột của mã nguồn.
 *
 * `refColumns`: field hệ thống ⇒ id cột mã nguồn đang hiện nó (một cột có thể gánh nhiều field, vd
 * cột "Khách hàng" gánh tên + SĐT). Một cột HIỆN khi ít nhất một field trỏ tới nó hiện; ẨN khi mọi
 * field trỏ tới nó đều ẩn. Cột không field nào nhắc tới giữ như mã nguồn: đứng ngay sau cột gốc
 * đứng trước nó trong mảng ban đầu.
 *
 * `customColumns`: cột custom đã dựng, theo khoá field (field không có cột — vd đã ARCHIVED — thì
 * bị bỏ). Nếu mọi cột đều bị ẩn, trả nguyên mảng: một bảng không cột nào là cấu hình hỏng, không
 * phải ý muốn.
 */
export function applyListView<C extends { id?: string }>(columns: readonly C[], schema: ListViewSchema | null | undefined, opts: { refColumns: Readonly<Record<string, readonly string[]>>; customColumns?: ReadonlyMap<string, C> }): C[] {
  if (!schema || !schema.columns.length) return [...columns];
  const byId = new Map<string, C>();
  for (const c of columns) if (c.id) byId.set(c.id, c);
  const mentioned = new Set<string>();
  const ordered: { id: string; col: C }[] = [];
  const placed = new Set<string>();

  for (const cfg of schema.columns) {
    const ref = parseFieldRef(cfg.ref);
    if (!ref) continue;
    if (ref.kind === "system") {
      for (const id of opts.refColumns[ref.key] ?? []) {
        const col = byId.get(id);
        if (!col) continue;
        mentioned.add(id);
        // Vị trí của một cột gánh nhiều field = vị trí field HIỆN đầu tiên nhắc tới nó.
        if (cfg.visible && !placed.has(id)) {
          placed.add(id);
          ordered.push({ id, col });
        }
      }
    } else {
      const id = customColumnId(ref.key);
      const col = opts.customColumns?.get(ref.key);
      if (!col || placed.has(id) || !cfg.visible) continue;
      placed.add(id);
      ordered.push({ id, col });
    }
  }

  // Cột mã nguồn không ai nhắc tới: chèn ngay sau cột gốc đứng trước nó (hoặc lên đầu).
  // `ordered` chỉ chứa cột HIỆN; cột được nhắc mà mọi field của nó ẩn thì không vào lại ở bước dưới.
  const out = [...ordered];
  columns.forEach((col, index) => {
    const id = col.id;
    if (id && mentioned.has(id)) return;
    let at = 0;
    for (let k = index - 1; k >= 0; k--) {
      const prevId = columns[k].id;
      const pos = prevId ? out.findIndex((o) => o.id === prevId) : -1;
      if (pos >= 0) {
        at = pos + 1;
        break;
      }
    }
    // Cột custom schema đặt ngay sau cột gốc ấy thuộc về cột gốc — không chen vào giữa.
    while (at < out.length && out[at].id.startsWith("custom:")) at++;
    out.splice(at, 0, { id: id ?? `__${index}`, col });
  });
  return out.length ? out.map((o) => o.col) : [...columns];
}

/** Sắp xếp mặc định của danh sách ⇒ id cột mã nguồn, CHỈ khi truy vấn sắp được cột đó. */
export function listViewDefaultSort(schema: ListViewSchema | null | undefined, refColumns: Readonly<Record<string, readonly string[]>>, sortable: readonly string[]): { sort: string; dir: "asc" | "desc" } | null {
  const ds = schema?.defaultSort;
  if (!ds) return null;
  const ref = parseFieldRef(ds.ref);
  if (!ref || ref.kind !== "system") return null;
  const id = (refColumns[ref.key] ?? []).find((c) => sortable.includes(c));
  return id ? { sort: id, dir: ds.dir } : null;
}

/** Bộ lọc mặc định CHỈ của field custom (bộ lọc field hệ thống đi qua thanh lọc sẵn có của trang). */
export function customDefaultFilters(schema: ListViewSchema | null | undefined) {
  return (schema?.defaultFilters ?? []).filter((f) => parseFieldRef(f.ref)?.kind === "custom");
}

/** Field custom cần cột: được danh sách nhắc tới VÀ đang hiện. */
export function visibleCustomKeys(schema: ListViewSchema | null | undefined): string[] {
  if (!schema) return [];
  const keys: string[] = [];
  for (const c of schema.columns) {
    const ref = parseFieldRef(c.ref);
    if (ref?.kind === "custom" && c.visible && !keys.includes(ref.key)) keys.push(ref.key);
  }
  return keys;
}

// ───────────────────────── In giá trị ─────────────────────────

export type FormatContext = { userNames?: Readonly<Record<string, string>> };

function optionLabel(options: readonly FieldOption[], value: unknown): string {
  const s = String(value);
  return options.find((o) => o.value === s)?.label ?? s;
}

/** In một giá trị custom theo kiểu field. Chưa có giá trị ⇒ "—" (CHƯA BIẾT, không phải 0). */
export function formatCustomValue(def: Pick<CustomFieldDef, "type" | "options">, value: unknown, ctx: FormatContext = {}): string {
  if (isEmptyValue(value)) return MISSING_TEXT;
  switch (def.type) {
    case "currency":
      return formatVND(typeof value === "number" ? value : Number(value));
    case "number":
      return formatNumber(typeof value === "number" ? value : Number(value));
    case "boolean":
      return value === true ? "Có" : value === false ? "Không" : MISSING_TEXT;
    case "date":
      return formatDate(String(value));
    case "datetime":
      return formatDateTime(String(value));
    case "select":
    case "status":
      return optionLabel(def.options, value);
    case "multi_select":
      return Array.isArray(value) ? value.map((v) => optionLabel(def.options, v)).join(", ") : optionLabel(def.options, value);
    case "user":
      return ctx.userNames?.[String(value)] ?? String(value);
    default:
      return String(value);
  }
}

// ───────────────────────── Trạng thái HỆ THỐNG (M10) ─────────────────────────

/**
 * Nhãn tổ chức ĐÃ KHAI cho một trạng thái hệ thống: chỉ giá trị có nhãn khác nhãn mặc định của sổ.
 * Giá trị không có trong map ⇒ hiển thị như cũ (nhãn đối tác gửi về, rồi nhãn mặc định). Khai trùng
 * đúng chữ mặc định thì kết quả hiển thị vẫn giống hệt — không sai.
 */
export function statusLabelOverrides(defaults: readonly FieldOption[], resolved: readonly FieldOption[] | null): Record<string, string> {
  if (!resolved) return {};
  const base = new Map(defaults.map((o) => [o.value, o.label]));
  const out: Record<string, string> = {};
  for (const o of resolved) if (base.has(o.value) && base.get(o.value) !== o.label) out[o.value] = o.label;
  return out;
}

/**
 * Áp cấu hình trạng thái lên tuỳ chọn của một bộ lọc: nhãn, thứ tự, và ẨN giá trị tổ chức đã tắt —
 * trừ giá trị đang được chọn trên URL (ẩn nó là để người dùng bị lọc mà không thấy mình đang lọc gì).
 */
export function applyStatusFacet<O extends { value: string; label: string }>(options: readonly O[], resolved: readonly FieldOption[] | null, selected: readonly string[] = []): O[] {
  if (!resolved) return [...options];
  const byValue = new Map(resolved.map((o, i) => [o.value, { ...o, rank: i }]));
  return options
    .filter((o) => byValue.get(o.value)?.active !== false || selected.includes(o.value))
    .map((o) => {
      const r = byValue.get(o.value);
      return r ? { ...o, label: r.label } : o;
    })
    .sort((a, b) => (byValue.get(a.value)?.rank ?? Number.MAX_SAFE_INTEGER) - (byValue.get(b.value)?.rank ?? Number.MAX_SAFE_INTEGER));
}

const FILTER_OP_TEXT: Record<string, string> = { eq: "=", neq: "≠", contains: "chứa", gte: "≥", lte: "≤", in: "thuộc", empty: "trống", not_empty: "có giá trị" };

/** Một câu mô tả bộ lọc mặc định để in cạnh danh sách (người đọc phải biết mình đang bị lọc bởi gì). */
export function describeListFilter(filter: { ref: string; op: string; value?: unknown }, def: Pick<CustomFieldDef, "label" | "type" | "options"> | undefined, ctx: FormatContext = {}): string {
  const label = def?.label ?? filter.ref;
  const op = FILTER_OP_TEXT[filter.op] ?? filter.op;
  if (filter.op === "empty" || filter.op === "not_empty") return `${label} ${op}`;
  const fmt = (v: unknown) => (def ? formatCustomValue(def, v, ctx) : String(v));
  const value = Array.isArray(filter.value) ? filter.value.map(fmt).join(", ") : fmt(filter.value);
  return `${label} ${op} ${value}`;
}

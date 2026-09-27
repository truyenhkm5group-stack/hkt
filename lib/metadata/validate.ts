/**
 * ═══════════ KIỂM HỢP LỆ GIÁ TRỊ CUSTOM (M6) — HÀM THUẦN, CLIENT-SAFE ═══════════
 *
 * Máy chủ LUÔN chạy hàm này trước khi ghi (`lib/metadata/values.ts`); trình duyệt được gọi lại cùng hàm
 * để báo lỗi sớm, nhưng lượt ở trình duyệt chỉ là UX. Không đọc CSDL: `user` / `relation` / `file` chỉ
 * được kiểm HÌNH DẠNG ở đây, còn việc id có tồn tại trong CSDL của tổ chức hay không là việc của máy chủ.
 *
 * Bốn luật mà hàm này không thương lượng:
 *  1. KHOÁ LẠ hoặc field đã ARCHIVED trong đầu vào ⇒ LỖI "field không tồn tại", không âm thầm bỏ qua —
 *     bỏ qua im lặng thì người gõ tưởng đã lưu.
 *  2. Rỗng / `null` / `undefined` ⇒ XOÁ KHOÁ (không lưu chuỗi rỗng). Khoá vắng mặt = CHƯA BIẾT; không có
 *     nhánh nào đổi nó thành 0 hay `false` (AGENTS.md 8.5).
 *  3. `values` trả về là bản ĐÃ GỘP: giá trị cũ (`previous`) + đúng các khoá gửi lên. Khoá cũ không gửi
 *     lên giữ nguyên — kể cả khoá của field đã ARCHIVED (M4: giá trị giữ nguyên, chỉ không nhận ghi).
 *  4. `required` xét trên bản ĐÃ GỘP: field bắt buộc mà bản ghi chưa có giá trị thì lượt lưu nào cũng báo,
 *     đúng như một form bắt buộc — nơi gọi nới cho field người đó không sửa được bằng cách truyền `required:false`.
 *
 * BIỂU THỨC KIỂM (`pattern`) — chặn ReDoS bằng BA lớp, vì trần độ dài một mình KHÔNG đủ: `^(a+)+$` trên
 * 30 chữ `a` + một ký tự lạ đã là 2^30 bước. (1) mẫu ≤ 200 ký tự, giá trị ≤ 2.000 ký tự; (2) cấm lượng từ
 * lặp lồng nhau / lặp một nhóm có phép hoặc (`(a+)+`, `(a|aa)*`) và cấm tham chiếu ngược; (3) tối đa
 * `MAX_UNBOUNDED_QUANTIFIERS` lượng từ không chặn trên. Mẫu được NEO hai đầu (`^(?:…)$`) — cùng nghĩa với
 * thuộc tính `pattern` của ô nhập HTML, để trình duyệt và máy chủ nói cùng một điều. Mẫu không biên dịch
 * được / không an toàn ⇒ LỖI CẤU HÌNH trả về như một lỗi field, không ném.
 */
import type { CustomFieldDef, CustomValues, FieldError, FieldOption, FieldValidation } from "@/lib/metadata/types";

export const PATTERN_MAX_LENGTH = 200;
export const PATTERN_VALUE_MAX_LENGTH = 2_000;
export const TEXT_MAX_LENGTH = 2_000;
export const TEXTAREA_MAX_LENGTH = 20_000;
export const ID_MAX_LENGTH = 200;
export const MULTI_SELECT_MAX_ITEMS = 100;
/** Trần kích thước của CẢ dòng giá trị một bản ghi (JSON). */
export const RECORD_VALUES_MAX_BYTES = 256_000;
export const MAX_UNBOUNDED_QUANTIFIERS = 3;
/** `{n,m}` với m − n lớn hơn ngưỡng này bị coi như không chặn trên (giá trị tới 2.000 ký tự). */
const BOUNDED_SPAN_LIMIT = 50;

const nf = new Intl.NumberFormat("vi-VN");

// ─────────────────────────── Biểu thức kiểm ───────────────────────────

/** Lý do mẫu KHÔNG an toàn để chạy, hoặc `null`. Phân tích cú pháp tối giản — nghi ngờ thì từ chối. */
export function unsafePatternReason(pattern: string): string | null {
  type Frame = { quant: boolean; alt: boolean };
  const stack: Frame[] = [{ quant: false, alt: false }];
  let unbounded = 0;
  let closed: Frame | null = null;
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    const top = stack[stack.length - 1];
    if (c === "\\") {
      const n = pattern[i + 1];
      if (n !== undefined && /[1-9k]/.test(n)) return "không dùng tham chiếu ngược (\\1, \\k<…>)";
      i += 2;
      closed = null;
      continue;
    }
    if (c === "[") {
      i += 1;
      if (pattern[i] === "^") i += 1;
      if (pattern[i] === "]") i += 1;
      while (i < pattern.length && pattern[i] !== "]") i += pattern[i] === "\\" ? 2 : 1;
      i += 1;
      closed = null;
      continue;
    }
    if (c === "(") {
      stack.push({ quant: false, alt: false });
      i += 1;
      if (pattern[i] === "?") {
        i += 1;
        if (pattern[i] === "<" && pattern[i + 1] !== "=" && pattern[i + 1] !== "!") {
          while (i < pattern.length && pattern[i] !== ">") i += 1;
          i += 1;
        } else if (pattern[i] === "<") i += 2;
        else i += 1;
      }
      closed = null;
      continue;
    }
    if (c === ")") {
      if (stack.length <= 1) return "ngoặc đóng thừa";
      const frame = stack.pop()!;
      const parent = stack[stack.length - 1];
      parent.quant ||= frame.quant;
      parent.alt ||= frame.alt;
      closed = frame;
      i += 1;
      continue;
    }
    if (c === "|") {
      top.alt = true;
      closed = null;
      i += 1;
      continue;
    }
    if (c === "*" || c === "+" || c === "?" || c === "{") {
      let repeating = false;
      let open = false;
      // Lượng từ ĐỘ DÀI THAY ĐỔI (`*`, `+`, `?`, `{n,m}` với m ≠ n) mới sinh nhập nhằng; `{n}` cố định thì không —
      // `(\.\d{3})*` là tuyến tính.
      let variable = true;
      if (c === "*" || c === "+") {
        repeating = true;
        open = true;
        i += 1;
      } else if (c === "?") {
        i += 1;
      } else {
        const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
        if (!m) {
          i += 1;
          closed = null;
          continue;
        }
        const lo = Number(m[1]);
        const hi = m[2] ? (m[3] === "" ? Number.POSITIVE_INFINITY : Number(m[3])) : lo;
        repeating = hi > 1;
        variable = hi !== lo;
        open = hi === Number.POSITIVE_INFINITY || hi - lo > BOUNDED_SPAN_LIMIT;
        i += m[0].length;
      }
      if (pattern[i] === "?") i += 1;
      if (repeating && closed && (closed.quant || closed.alt)) return "không lặp một nhóm có lượng từ hoặc phép hoặc bên trong (vd (a+)+, (a|b)*) — dùng lớp ký tự [..] thay thế";
      if (variable) top.quant = true;
      if (open) unbounded += 1;
      closed = null;
      continue;
    }
    closed = null;
    i += 1;
  }
  if (unbounded > MAX_UNBOUNDED_QUANTIFIERS) return `tối đa ${MAX_UNBOUNDED_QUANTIFIERS} lượng từ không giới hạn (*, +, {n,})`;
  return null;
}

export type PatternCheck = { ok: true; regex: RegExp } | { ok: false; message: string };

/** Biên dịch mẫu (đã neo hai đầu) sau khi kiểm độ dài + độ an toàn. Không bao giờ ném. */
export function compilePattern(pattern: string): PatternCheck {
  if (pattern.length > PATTERN_MAX_LENGTH) return { ok: false, message: `mẫu kiểm dài quá ${PATTERN_MAX_LENGTH} ký tự` };
  const unsafe = unsafePatternReason(pattern);
  if (unsafe) return { ok: false, message: `mẫu kiểm không an toàn: ${unsafe}` };
  try {
    return { ok: true, regex: new RegExp(`^(?:${pattern})$`) };
  } catch {
    return { ok: false, message: "mẫu kiểm không biên dịch được" };
  }
}

// ─────────────────────────── Ép kiểu từng field ───────────────────────────

type Coerced = { value: unknown } | { error: string };

const EMAIL = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const VN_PHONE = /^0(?:[35789]\d{8}|2\d{9})$/;
const ID_SHAPE = /^[A-Za-z0-9_.:-]+$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:(\.\d{1,3})\d*)?)?(Z|[+-]\d{2}:?\d{2})?$/;

function isBlank(raw: unknown): boolean {
  return raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "") || (Array.isArray(raw) && raw.length === 0);
}

function asText(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return null;
}

function lengthOf(s: string): number {
  return [...s].length;
}

function checkLength(def: CustomFieldDef, s: string, cap: number): string | null {
  const v: FieldValidation = def.validation ?? {};
  const n = lengthOf(s);
  if (n > cap) return `${def.label} dài quá ${nf.format(cap)} ký tự.`;
  if (typeof v.minLength === "number" && n < v.minLength) return `${def.label} phải có ít nhất ${nf.format(v.minLength)} ký tự.`;
  if (typeof v.maxLength === "number" && n > v.maxLength) return `${def.label} tối đa ${nf.format(v.maxLength)} ký tự.`;
  return null;
}

function checkPattern(def: CustomFieldDef, s: string): string | null {
  const pattern = def.validation?.pattern;
  if (!pattern) return null;
  if (s.length > PATTERN_VALUE_MAX_LENGTH) return `${def.label} dài quá ${nf.format(PATTERN_VALUE_MAX_LENGTH)} ký tự để kiểm theo mẫu.`;
  const compiled = compilePattern(pattern);
  if (!compiled.ok) return `Cấu hình field "${def.label}" lỗi: ${compiled.message} — báo quản trị sửa cấu hình.`;
  if (!compiled.regex.test(s)) return def.validation.patternMessage?.trim() || `${def.label} không đúng định dạng.`;
  return null;
}

function checkRange(def: CustomFieldDef, n: number): string | null {
  const v = def.validation ?? {};
  if (typeof v.min === "number" && n < v.min) return `${def.label} phải ≥ ${nf.format(v.min)}.`;
  if (typeof v.max === "number" && n > v.max) return `${def.label} phải ≤ ${nf.format(v.max)}.`;
  return null;
}

function stringRule(def: CustomFieldDef, s: string, cap: number): Coerced {
  const e = checkLength(def, s, cap) ?? checkPattern(def, s);
  return e ? { error: e } : { value: s };
}

function validDate(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function optionOf(def: CustomFieldDef, value: string): FieldOption | undefined {
  return (def.options ?? []).find((o) => o.value === value);
}

function labelOf(def: CustomFieldDef, value: unknown): string {
  return typeof value === "string" ? (optionOf(def, value)?.label ?? value) : String(value);
}

/**
 * Tuỳ chọn hợp lệ để GHI: phải có trong danh sách và đang ACTIVE. Ngoại lệ duy nhất: giá trị ĐÃ LƯU từ
 * trước (form gửi lại nguyên giá trị cũ) — tắt một tuỳ chọn không được làm bản ghi đang mang nó hết lưu được.
 */
function checkOption(def: CustomFieldDef, value: string, previouslyHeld: boolean): string | null {
  const opt = optionOf(def, value);
  if (!opt) return `${def.label}: "${value}" không nằm trong danh sách tuỳ chọn.`;
  if (!opt.active && !previouslyHeld) return `${def.label}: tuỳ chọn "${opt.label}" đã ngừng dùng.`;
  return null;
}

export function coerceFieldValue(def: CustomFieldDef, raw: unknown, previous: unknown): Coerced {
  if (isBlank(raw)) return { value: undefined };
  switch (def.type) {
    case "text": {
      const s = asText(raw);
      if (s === null) return { error: `${def.label} phải là chữ.` };
      return stringRule(def, s.trim(), TEXT_MAX_LENGTH);
    }
    case "textarea": {
      const s = asText(raw);
      if (s === null) return { error: `${def.label} phải là chữ.` };
      return stringRule(def, s.replace(/\r\n?/g, "\n").trim(), TEXTAREA_MAX_LENGTH);
    }
    case "email": {
      if (typeof raw !== "string") return { error: `${def.label} phải là địa chỉ email.` };
      const s = raw.trim().toLowerCase();
      if (s.length > 254 || !EMAIL.test(s)) return { error: `${def.label}: "${raw.trim()}" không phải email hợp lệ.` };
      return stringRule(def, s, 254);
    }
    case "phone": {
      const s0 = asText(raw);
      if (s0 === null) return { error: `${def.label} phải là số điện thoại.` };
      let s = s0.trim().replace(/[\s.()-]/g, "");
      if (s.startsWith("+84")) s = `0${s.slice(3)}`;
      else if (s.startsWith("84") && s.length >= 11) s = `0${s.slice(2)}`;
      if (!VN_PHONE.test(s)) return { error: `${def.label}: "${s0.trim()}" không phải số điện thoại Việt Nam hợp lệ (10 số di động hoặc 11 số cố định).` };
      return stringRule(def, s, 11);
    }
    case "url": {
      if (typeof raw !== "string") return { error: `${def.label} phải là đường dẫn.` };
      const s = raw.trim();
      if (s.length > PATTERN_VALUE_MAX_LENGTH) return { error: `${def.label} dài quá ${nf.format(PATTERN_VALUE_MAX_LENGTH)} ký tự.` };
      let ok = false;
      try {
        const u = new URL(s);
        ok = u.protocol === "http:" || u.protocol === "https:";
      } catch {
        ok = false;
      }
      if (!ok) return { error: `${def.label}: chỉ nhận đường dẫn http:// hoặc https://.` };
      return stringRule(def, s, PATTERN_VALUE_MAX_LENGTH);
    }
    case "number": {
      let n: number;
      if (typeof raw === "number") n = raw;
      else if (typeof raw === "string" && /^-?\d+(\.\d+)?$/.test(raw.trim())) n = Number(raw.trim());
      else return { error: `${def.label} phải là số.` };
      if (!Number.isFinite(n)) return { error: `${def.label} phải là số hữu hạn.` };
      const e = checkRange(def, n);
      return e ? { error: e } : { value: n };
    }
    case "currency": {
      let n: number;
      if (typeof raw === "number") n = raw;
      else if (typeof raw === "string") {
        const s = raw.trim();
        if (/^-?\d+$/.test(s)) n = Number(s);
        else if (/^-?\d{1,3}(?:[.,\s]\d{3})+$/.test(s)) n = Number(s.replace(/[.,\s]/g, ""));
        else return { error: `${def.label} phải là số tiền nguyên VND (vd 150000 hoặc 150.000).` };
      } else return { error: `${def.label} phải là số tiền.` };
      if (!Number.isSafeInteger(n)) return { error: `${def.label} phải là số nguyên VND (không có phần lẻ).` };
      const e = checkRange(def, n);
      return e ? { error: e } : { value: n };
    }
    case "boolean": {
      if (typeof raw === "boolean") return { value: raw };
      if (raw === 1 || raw === 0) return { value: raw === 1 };
      if (typeof raw === "string") {
        const s = raw.trim().toLowerCase();
        if (s === "true" || s === "1") return { value: true };
        if (s === "false" || s === "0") return { value: false };
      }
      return { error: `${def.label} chỉ nhận có / không.` };
    }
    case "date": {
      const m = typeof raw === "string" ? DATE.exec(raw.trim()) : null;
      if (!m || !validDate(Number(m[1]), Number(m[2]), Number(m[3]))) return { error: `${def.label} phải là ngày dạng YYYY-MM-DD.` };
      return { value: m[0] };
    }
    case "datetime": {
      const s = typeof raw === "string" ? raw.trim() : "";
      const m = DATETIME.exec(s);
      if (!m || !validDate(Number(m[1]), Number(m[2]), Number(m[3])) || Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6] ?? 0) > 59) {
        return { error: `${def.label} phải là ngày giờ ISO (vd 2026-09-27T14:30).` };
      }
      // Không múi giờ ⇒ giờ Việt Nam (ô datetime-local của trình duyệt gửi đúng dạng này). Lưu UTC ISO.
      const local = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}${m[7] ?? ""}`;
      const zone = !m[8] ? "+07:00" : m[8] === "Z" ? "Z" : `${m[8].slice(0, 3)}:${m[8].slice(-2)}`;
      const t = new Date(`${local}${zone}`);
      if (Number.isNaN(t.getTime())) return { error: `${def.label} phải là ngày giờ hợp lệ.` };
      return { value: t.toISOString() };
    }
    case "select":
    case "status": {
      if (typeof raw !== "string") return { error: `${def.label} phải là một tuỳ chọn.` };
      const v = raw.trim();
      const e = checkOption(def, v, previous === v);
      if (e) return { error: e };
      if (def.type === "status" && typeof previous === "string" && previous !== v) {
        const transitions = def.transitions ?? {};
        if (Object.keys(transitions).length > 0 && !(transitions[previous] ?? []).includes(v)) {
          return { error: `${def.label}: không được chuyển từ "${labelOf(def, previous)}" sang "${labelOf(def, v)}".` };
        }
      }
      return { value: v };
    }
    case "multi_select": {
      const list = typeof raw === "string" ? [raw] : raw;
      if (!Array.isArray(list) || !list.every((x) => typeof x === "string")) return { error: `${def.label} phải là danh sách tuỳ chọn.` };
      const held = new Set(Array.isArray(previous) ? previous.filter((x): x is string => typeof x === "string") : []);
      const uniq = [...new Set((list as string[]).map((x) => x.trim()).filter(Boolean))];
      if (uniq.length > MULTI_SELECT_MAX_ITEMS) return { error: `${def.label}: tối đa ${MULTI_SELECT_MAX_ITEMS} lựa chọn.` };
      for (const v of uniq) {
        const e = checkOption(def, v, held.has(v));
        if (e) return { error: e };
      }
      if (uniq.length === 0) return { value: undefined };
      const pos = (v: string) => optionOf(def, v)?.position ?? 0;
      return { value: uniq.sort((a, b) => pos(a) - pos(b)) };
    }
    case "user":
    case "relation":
    case "file": {
      const s = asText(raw)?.trim() ?? null;
      if (s === null || s.length > ID_MAX_LENGTH || !ID_SHAPE.test(s)) return { error: `${def.label}: mã tham chiếu không hợp lệ.` };
      return { value: s };
    }
    default:
      return { error: `${def.label}: kiểu field không hỗ trợ.` };
  }
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const proto: unknown = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

/**
 * Kiểm + ép kiểu `input` theo `defs` (định nghĩa của ĐỐI TƯỢNG, gồm cả ARCHIVED để báo đúng lỗi), gộp với
 * `previous`. Trả `values` ĐÃ GỘP và danh sách lỗi — có lỗi thì nơi gọi KHÔNG được ghi `values`.
 */
export function validateCustomValues(defs: CustomFieldDef[], input: CustomValues, previous: CustomValues | null): { values: CustomValues; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const prev: CustomValues = isPlainObject(previous) ? previous : {};
  const values: CustomValues = { ...prev };
  if (!isPlainObject(input)) return { values, errors: [{ field: "_", message: "Dữ liệu gửi lên không đúng dạng (cần một object theo khoá field)." }] };
  const byKey = new Map(defs.map((d) => [d.key, d]));
  for (const key of Object.keys(input)) {
    const def = byKey.get(key);
    if (!def || def.status !== "ACTIVE") {
      errors.push({ field: key, message: `Field "${key}" không tồn tại (hoặc đã lưu trữ).` });
      continue;
    }
    const r = coerceFieldValue(def, input[key], prev[key]);
    if ("error" in r) {
      errors.push({ field: key, message: r.error });
      continue;
    }
    if (r.value === undefined) delete values[key];
    else values[key] = r.value;
  }
  for (const def of defs) {
    if (def.status !== "ACTIVE" || !def.required) continue;
    if (errors.some((e) => e.field === def.key)) continue;
    if (isBlank(values[def.key])) errors.push({ field: def.key, message: `${def.label} là bắt buộc.` });
  }
  if (errors.length === 0 && JSON.stringify(values).length > RECORD_VALUES_MAX_BYTES) {
    errors.push({ field: "_", message: `Tổng dữ liệu bổ sung của bản ghi vượt ${nf.format(RECORD_VALUES_MAX_BYTES)} ký tự.` });
  }
  return { values, errors };
}

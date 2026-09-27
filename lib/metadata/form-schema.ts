/**
 * ═══════════ FORM METADATA — DỰNG MẶC ĐỊNH, CHUẨN HOÁ, KIỂM LƯỢC ĐỒ (M7, M8) — THUẦN, CLIENT-SAFE ═══════════
 *
 * Máy chủ (`lib/metadata/forms.ts`) và trình soạn form (giao diện) gọi CÙNG các hàm này, nên "form trông
 * thế nào" không có hai định nghĩa.
 *
 * LUẬT CHUẨN HOÁ — áp ở MỌI lần đọc, không chỉ lúc lưu, vì định nghĩa field đổi SAU khi form đã xuất bản:
 *  · ref lạ (field hệ thống không có trong sổ, field custom không tồn tại hoặc đã ARCHIVED) ⇒ BỎ khỏi form.
 *    Form không bao giờ vẽ một ô trỏ vào thứ không còn nhận ghi.
 *  · `required` chỉ được CHẶT hơn định nghĩa: `def.required || cfg.required` — form không nới được field
 *    bắt buộc của hệ thống hay của field custom.
 *  · field hệ thống `editable: false` ⇒ luôn `readOnly` (số liệu tính ra, dữ liệu đồng bộ từ đối tác).
 *  · field bắt buộc mà người dùng sửa được ⇒ luôn `visible` — ẩn nó là làm form không lưu được nữa.
 *  · ref trùng ⇒ giữ lần xuất hiện đầu.
 *
 * FIELD CUSTOM MỚI (tạo sau lần xuất bản gần nhất) — CHỐT:
 *  · Form MẶC ĐỊNH (tổ chức chưa xuất bản bao giờ) dựng lại từ định nghĩa ở MỖI lần đọc ⇒ field mới hiện ngay.
 *  · Form ĐÃ XUẤT BẢN: field mới KHÔNG tự hiện cho tới lần xuất bản sau. Lý do: bố cục đã xuất bản là một
 *    quyết định của người cấu hình (thứ tự, nhóm, cái gì ẩn); chèn ô vào form đang chạy là sửa quyết định
 *    đó mà không ai bấm, và "bản xuất bản là ảnh chụp bất biến" (M12) sẽ không còn đúng với thứ người dùng
 *    thấy. NGOẠI LỆ DUY NHẤT: field mới BẮT BUỘC được nối vào cuối (hiện) — thiếu nó thì mọi lượt lưu qua
 *    form đó bị chặn bởi luật bắt buộc ở `validateCustomValues`, tức là form hỏng chứ không phải "giữ nguyên".
 *  · Bản NHÁP (trình soạn) nối mọi field chưa có vào cuối ở trạng thái ẨN (`appendMissing`) để người cấu
 *    hình thấy và chọn bật.
 */
import { z } from "zod";
import { objectDef } from "@/lib/constants/object-registry";
import type { CustomFieldDef, FieldError, FieldRef, FormFieldConfig, FormSchema, FormSection, SystemFieldDef } from "@/lib/metadata/types";

export const FORM_MAX_SECTIONS = 20;
export const FORM_MAX_FIELDS = 300;
const SECTION_KEY = /^[a-z][a-z0-9_]{0,40}$/;
export const FIELD_REF_PATTERN = /^(system|custom):[a-z][a-z0-9_]{0,40}$/;

export const fieldRefZ = z.string().regex(FIELD_REF_PATTERN, "ref field phải dạng system:<khoá> hoặc custom:<khoá>") as unknown as z.ZodType<FieldRef>;

const formFieldZ = z.object({
  ref: fieldRefZ,
  visible: z.boolean(),
  readOnly: z.boolean(),
  required: z.boolean(),
  defaultValue: z.unknown().optional(),
});

export const formSchemaZ = z
  .object({
    version: z.literal(1),
    sections: z
      .array(
        z.object({
          key: z.string().regex(SECTION_KEY, "khoá nhóm chỉ gồm chữ thường, số, gạch dưới"),
          label: z.string().trim().min(1, "nhóm phải có tên").max(100),
          fields: z.array(formFieldZ).max(FORM_MAX_FIELDS),
        }),
      )
      .max(FORM_MAX_SECTIONS),
  })
  .superRefine((s, ctx) => {
    const keys = new Set<string>();
    let total = 0;
    for (const sec of s.sections) {
      if (keys.has(sec.key)) ctx.addIssue({ code: "custom", message: `khoá nhóm "${sec.key}" bị trùng`, path: ["sections"] });
      keys.add(sec.key);
      total += sec.fields.length;
    }
    if (total > FORM_MAX_FIELDS) ctx.addIssue({ code: "custom", message: `form tối đa ${FORM_MAX_FIELDS} ô`, path: ["sections"] });
  });

export function parseRef(ref: string): { kind: "system" | "custom"; key: string } | null {
  if (!FIELD_REF_PATTERN.test(ref)) return null;
  const i = ref.indexOf(":");
  return { kind: ref.slice(0, i) as "system" | "custom", key: ref.slice(i + 1) };
}

export function activeCustom(custom: readonly CustomFieldDef[]): CustomFieldDef[] {
  return custom.filter((c) => c.status === "ACTIVE").sort((a, b) => a.position - b.position || a.key.localeCompare(b.key));
}

function hasValue(v: unknown): boolean {
  return v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "");
}

/** Form MẶC ĐỊNH: field hệ thống `editable` (nhóm "Thông tin chính") + mọi field custom ACTIVE ("Thông tin bổ sung"). */
export function defaultFormSchema(objectKey: string, formKey: string, customDefs: readonly CustomFieldDef[]): FormSchema {
  const def = objectDef(objectKey);
  const purpose = def?.forms.find((f) => f.key === formKey)?.purpose ?? "edit";
  const sections: FormSection[] = [];
  const system = (def?.fields ?? []).filter((f) => f.editable);
  if (system.length > 0) {
    sections.push({
      key: "main",
      label: "Thông tin chính",
      fields: system.map((f) => ({ ref: `system:${f.key}` as FieldRef, visible: true, readOnly: false, required: f.required })),
    });
  }
  const custom = activeCustom(customDefs);
  if (custom.length > 0 || sections.length === 0) {
    sections.push({
      key: "custom",
      label: "Thông tin bổ sung",
      fields: custom.map((c) => ({
        ref: `custom:${c.key}` as FieldRef,
        visible: true,
        readOnly: false,
        required: c.required,
        ...(purpose === "create" && hasValue(c.defaultValue) ? { defaultValue: c.defaultValue } : {}),
      })),
    });
  }
  return { version: 1, sections };
}

type Resolved = { kind: "system"; def: SystemFieldDef } | { kind: "custom"; def: CustomFieldDef };

function resolveRef(ref: string, system: readonly SystemFieldDef[], custom: readonly CustomFieldDef[]): Resolved | null {
  const p = parseRef(ref);
  if (!p) return null;
  if (p.kind === "system") {
    const def = system.find((s) => s.key === p.key);
    return def ? { kind: "system", def } : null;
  }
  const def = custom.find((c) => c.key === p.key && c.status === "ACTIVE");
  return def ? { kind: "custom", def } : null;
}

function normalizeField(cfg: FormFieldConfig, r: Resolved): FormFieldConfig {
  const readOnly = cfg.readOnly === true || (r.kind === "system" && !r.def.editable);
  const required = r.def.required || cfg.required === true;
  const visible = cfg.visible === true || (required && !readOnly);
  const out: FormFieldConfig = { ref: cfg.ref, visible, readOnly, required };
  if (!readOnly && hasValue(cfg.defaultValue)) out.defaultValue = cfg.defaultValue;
  return out;
}

/**
 * Chuẩn hoá một form (đã xuất bản hoặc nháp) theo định nghĩa field HIỆN TẠI. `appendMissing` chỉ dùng cho
 * bản nháp trong trình soạn: nối mọi field custom ACTIVE chưa có vào cuối ở trạng thái ẩn.
 */
export function normalizeFormSchema(
  schema: FormSchema,
  system: readonly SystemFieldDef[],
  custom: readonly CustomFieldDef[],
  opts: { appendMissing?: boolean } = {},
): FormSchema {
  const seenRefs = new Set<string>();
  const seenSections = new Set<string>();
  const sections: FormSection[] = [];
  for (const sec of schema?.sections ?? []) {
    if (!sec || typeof sec.key !== "string" || seenSections.has(sec.key)) continue;
    seenSections.add(sec.key);
    const fields: FormFieldConfig[] = [];
    for (const cfg of sec.fields ?? []) {
      if (!cfg || typeof cfg.ref !== "string" || seenRefs.has(cfg.ref)) continue;
      const r = resolveRef(cfg.ref, system, custom);
      if (!r) continue;
      seenRefs.add(cfg.ref);
      fields.push(normalizeField(cfg, r));
    }
    sections.push({ key: sec.key, label: sec.label, fields });
  }
  const missing = activeCustom(custom).filter((c) => !seenRefs.has(`custom:${c.key}`) && (opts.appendMissing || c.required));
  if (missing.length > 0) {
    let target = sections[sections.length - 1];
    if (!target) {
      target = { key: "custom", label: "Thông tin bổ sung", fields: [] };
      sections.push(target);
    }
    for (const c of missing) target.fields.push({ ref: `custom:${c.key}`, visible: c.required, readOnly: false, required: c.required });
  }
  return { version: 1, sections };
}

/** Ref trong form KHÔNG trỏ được vào field nào đang nhận ghi — lưu nháp báo lỗi thay vì bỏ im lặng. */
export function formRefProblems(schema: FormSchema, system: readonly SystemFieldDef[], custom: readonly CustomFieldDef[]): FieldError[] {
  const errors: FieldError[] = [];
  const seen = new Set<string>();
  for (const sec of schema.sections) {
    for (const cfg of sec.fields) {
      if (seen.has(cfg.ref)) errors.push({ field: cfg.ref, message: `"${cfg.ref}" xuất hiện hai lần trong form.` });
      seen.add(cfg.ref);
      if (!resolveRef(cfg.ref, system, custom)) errors.push({ field: cfg.ref, message: `Field "${cfg.ref}" không tồn tại hoặc đã lưu trữ.` });
    }
  }
  return errors;
}

/** Khoá field custom mà form cho GHI: hiện và không chỉ đọc. */
export function writableCustomKeys(schema: FormSchema): Set<string> {
  const out = new Set<string>();
  for (const sec of schema.sections) {
    for (const cfg of sec.fields) {
      const p = parseRef(cfg.ref);
      if (p?.kind === "custom" && cfg.visible && !cfg.readOnly) out.add(p.key);
    }
  }
  return out;
}

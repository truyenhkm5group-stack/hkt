/**
 * ═══════════ TẠO KHÁCH HÀNG QUA FORM METADATA (Phase 2, đối tượng mẫu `customer`) ═══════════
 *
 * LÕI của `createCustomerAction` — tách khỏi tệp "use server" vì hai lẽ: mọi hàm xuất khẩu của tệp đó là
 * một cửa gọi được từ trình duyệt (hàm nhận `SessionUser` ở đó là để người gọi tự khai mình là ai), và
 * bài kiểm cần gọi đúng hàm action gọi mà không có cookie của Next.
 *
 * HÀNG RÀO, theo thứ tự:
 *  1. Quyền `customers:write` (mặc định chỉ Quản trị — chốt Phase 2).
 *  2. Năng lực `create` của sổ đối tượng: khách CHỈ tạo tay được khi tổ chức KHÔNG bật module khai ở
 *     `requiresModuleOff` (`connector_pancake`). Tổ chức dùng Pancake có khách do đồng bộ tạo; một khách
 *     tạo tay sẽ không có `pancake_id` và lượt đồng bộ kế tiếp đẻ ra bản thứ hai của cùng người đó.
 *  3. Form `create` ĐÃ XUẤT BẢN quyết định ô nào nhận ghi: ô ẩn / chỉ đọc gửi lên ⇒ từ chối (M6).
 *  4. Field custom kiểm TRƯỚC khi chèn khách (cùng `validateCustomValues` của dịch vụ); rồi ghi qua đúng
 *     đường ghi `saveCustomValues` (quyền theo field, tham chiếu user/relation, nhật ký). Lượt ghi ấy vẫn
 *     từ chối (vd tài khoản được chọn không tồn tại) ⇒ gỡ dòng khách VỪA chèn — không để lại một khách
 *     thiếu hồ sơ mà người bấm tưởng chưa được tạo.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { objectDef } from "@/lib/constants/object-registry";
import { fail, type MetaFailure } from "@/lib/metadata/errors";
import { listFields } from "@/lib/metadata/fields";
import { parseRef } from "@/lib/metadata/form-schema";
import { getPublishedForm } from "@/lib/metadata/forms";
import type { FieldError, FormSchema } from "@/lib/metadata/types";
import { validateCustomValues } from "@/lib/metadata/validate";
import { canEditField, saveCustomValues } from "@/lib/metadata/values";
import { canUseModule } from "@/lib/platform/capabilities";

export const CUSTOMER_CREATE_FORM = "create";

/** Cột hệ thống của khách mà form tạo được phép ghi — khớp field `editable` của sổ. */
const SYSTEM_LIMITS: Record<string, { column: "name" | "phone" | "address" | "province"; max: number }> = {
  name: { column: "name", max: 200 },
  phone: { column: "phone", max: 30 },
  address: { column: "address", max: 500 },
  province: { column: "province", max: 100 },
};

const PHONE_RE = /^\+?[0-9]{8,15}$/;

export type CreateGate = { allowed: true } | { allowed: false; code: "FORBIDDEN" | "NOT_SUPPORTED" | "MODULE_DISABLED"; reason: string };

/** Người này có được tạo khách ở tổ chức hiện hành không — trang dùng để hiện nút / trả 404. */
export async function customerCreateGate(user: SessionUser): Promise<CreateGate> {
  const def = objectDef("customer");
  const create = def?.capabilities.create;
  if (!def || !create) return { allowed: false, code: "NOT_SUPPORTED", reason: "Khách hàng không có form tạo." };
  if (!(await canUseModule(def.module))) return { allowed: false, code: "MODULE_DISABLED", reason: "Module Khách hàng chưa bật cho tổ chức này." };
  if (create.requiresModuleOff && (await canUseModule(create.requiresModuleOff))) {
    return { allowed: false, code: "NOT_SUPPORTED", reason: "Tổ chức đang dùng kết nối Pancake: khách do đồng bộ tạo, không tạo tay (tránh hai bản ghi cho cùng một người)." };
  }
  if (!can(user, "customers:write")) return { allowed: false, code: "FORBIDDEN", reason: "Bạn không có quyền tạo khách hàng (customers:write)." };
  return { allowed: true };
}

/** Ô của form nhận ghi: hiện và không chỉ đọc. Bắt buộc theo form (chặt hơn định nghĩa). */
function writableRefs(schemaForm: FormSchema) {
  const system = new Map<string, boolean>();
  const custom = new Set<string>();
  for (const sec of schemaForm.sections) {
    for (const cfg of sec.fields) {
      const p = parseRef(cfg.ref);
      if (!p || !cfg.visible || cfg.readOnly) continue;
      if (p.kind === "system") system.set(p.key, cfg.required);
      else custom.add(p.key);
    }
  }
  return { system, custom };
}

const inputZ = z.object({ system: z.record(z.string(), z.unknown()).default({}), custom: z.record(z.string(), z.unknown()).default({}) });

export type CreateCustomerResult = { ok: true; id: string } | MetaFailure;

export async function createCustomerCore(user: SessionUser, rawInput: unknown): Promise<CreateCustomerResult> {
  const gate = await customerCreateGate(user);
  if (!gate.allowed) return fail(gate.code, gate.reason);
  const parsed = inputZ.safeParse(rawInput);
  if (!parsed.success) return fail("INVALID", "Dữ liệu gửi lên không đúng dạng.");
  const { system: sysIn, custom: customIn } = parsed.data;

  const [form, fields] = await Promise.all([getPublishedForm("customer", CUSTOMER_CREATE_FORM), listFields("customer")]);
  const writable = writableRefs(form.schema);
  const errors: FieldError[] = [];

  // ── Field hệ thống ──
  const row: { name: string; phone: string | null; address: string; province: string } = { name: "", phone: null, address: "", province: "" };
  for (const key of Object.keys(sysIn)) {
    if (!writable.system.has(key) || !SYSTEM_LIMITS[key]) errors.push({ field: `system:${key}`, message: `Trường "${key}" không nhận ghi qua form này (ẩn hoặc chỉ đọc).` });
  }
  for (const f of fields.system) {
    if (!writable.system.has(f.key)) continue;
    const lim = SYSTEM_LIMITS[f.key];
    if (!lim) continue;
    const raw = sysIn[f.key];
    if (raw !== undefined && raw !== null && typeof raw !== "string") {
      errors.push({ field: `system:${f.key}`, message: `${f.label} phải là chữ.` });
      continue;
    }
    let v = (raw ?? "").trim();
    if (f.key === "phone" && v) {
      v = v.replace(/[\s.-]/g, "");
      if (!PHONE_RE.test(v)) {
        errors.push({ field: "system:phone", message: "Số điện thoại chỉ gồm 8–15 chữ số (có thể có dấu + ở đầu)." });
        continue;
      }
    }
    if (v.length > lim.max) errors.push({ field: `system:${f.key}`, message: `${f.label} tối đa ${lim.max} ký tự.` });
    else if (!v && (f.required || writable.system.get(f.key))) errors.push({ field: `system:${f.key}`, message: `${f.label} là bắt buộc.` });
    else if (lim.column === "phone") row.phone = v || null;
    else row[lim.column] = v;
  }
  // Tên là cột NOT NULL: form đã xuất bản không cho ghi tên ⇒ không tạo được khách nào — nói thẳng.
  if (!writable.system.has("name")) errors.push({ field: "system:name", message: "Form tạo khách đã xuất bản không có ô Tên khách — sửa form trước." });

  // ── Field custom: kiểm TRƯỚC khi chèn khách ──
  const obj = objectDef("customer")!;
  const customKeys = Object.keys(customIn);
  for (const key of customKeys) {
    const def = fields.custom.find((d) => d.key === key);
    if (!writable.custom.has(key)) errors.push({ field: key, message: `Field "${key}" không nhận ghi qua form này (ẩn hoặc chỉ đọc).` });
    else if (def && !canEditField(user, obj, def)) errors.push({ field: key, message: `Bạn không có quyền sửa "${def.label}".` });
  }
  const effective = fields.custom.map((d) => (d.required && !canEditField(user, obj, d) ? { ...d, required: false } : d));
  errors.push(...validateCustomValues(effective, customIn, null).errors.filter((e) => !errors.some((x) => x.field === e.field)));
  if (errors.length) return fail("INVALID", errors);

  // ── Ghi ──
  const db = await getDb();
  const [created] = await db
    .insert(schema.customers)
    .values({ name: row.name, phone: row.phone, phones: row.phone ? [row.phone] : [], address: row.address, province: row.province })
    .returning({ id: schema.customers.id });
  if (customKeys.length) {
    const saved = await saveCustomValues("customer", created.id, customIn, user, { formKey: CUSTOMER_CREATE_FORM });
    if (!saved.ok) {
      await db.delete(schema.customers).where(eq(schema.customers.id, created.id));
      return saved;
    }
  }
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "CUSTOMER_CREATE",
    entity: "CUSTOMER",
    entityId: created.id,
    before: null,
    after: { ...row, customKeys },
    reason: `Tạo tay qua form metadata "${CUSTOMER_CREATE_FORM}" (phiên bản ${form.version}${form.isDefault ? ", mặc định" : ""})`,
  });
  return { ok: true, id: created.id };
}

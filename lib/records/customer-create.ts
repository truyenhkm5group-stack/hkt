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
import { eq, sql } from "drizzle-orm";
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
import { canUseModule, orgHasSyncedSource } from "@/lib/platform/capabilities";

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
  if (create.requiresModuleOff && (await orgHasSyncedSource("customers"))) {
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

// ─────────────────────────── Khách do MÁY tạo — chatbot bán hàng (0180) ───────────────────────────

/** Cổng CỦA TỔ CHỨC cho lượt tạo khách (không hỏi người): module Khách bật + tổ chức không đồng bộ khách từ Pancake. */
export async function customerOrgGate(): Promise<CreateGate> {
  const def = objectDef("customer");
  const create = def?.capabilities.create;
  if (!def || !create) return { allowed: false, code: "NOT_SUPPORTED", reason: "Khách hàng không có form tạo." };
  if (!(await canUseModule(def.module))) return { allowed: false, code: "MODULE_DISABLED", reason: "Module Khách hàng chưa bật cho tổ chức này." };
  if (create.requiresModuleOff && (await orgHasSyncedSource("customers"))) return { allowed: false, code: "NOT_SUPPORTED", reason: "Tổ chức đang dùng kết nối Pancake: khách do đồng bộ tạo." };
  return { allowed: true };
}

/** SĐT về dạng lưu (bỏ khoảng trắng / chấm / gạch); sai dạng ⇒ `null`. */
export function normalizeCustomerPhone(raw: string): string | null {
  const v = raw.trim().replace(/[\s.-]/g, "");
  return PHONE_RE.test(v) ? v : null;
}

/**
 * Chatbot bán hàng tạo (hoặc tìm lại) khách. Cùng cột, cùng luật SĐT với form tạo khách; KHÁCH ĐÃ CÓ cùng SĐT ⇒ dùng lại
 * ĐÚNG khách đó (một người, một bản ghi) nhưng KHÔNG đổi tên / địa chỉ đang lưu (AGENTS.md mục 3.12: không tự điền đè).
 * Địa chỉ giao của lần mua này đi vào ĐƠN (người nhận), không vào hồ sơ khách. Máy không giả làm người (luật 36).
 */
export async function createCustomerAsAgent(
  agent: { name: string; source: string },
  input: { name: string; phone: string; address: string; province?: string },
  /** Đặt lịch hẹn không giao hàng nên không cần địa chỉ — mọi đường lên ĐƠN vẫn bắt buộc. */
  opts: { addressOptional?: boolean } = {},
): Promise<{ ok: true; id: string; existing: boolean } | MetaFailure> {
  const gate = await customerOrgGate();
  if (!gate.allowed) return fail(gate.code, gate.reason);
  const name = input.name.trim().slice(0, 200);
  const phone = normalizeCustomerPhone(input.phone);
  const address = input.address.trim().slice(0, 500);
  const province = (input.province ?? "").trim().slice(0, 100);
  const errors: FieldError[] = [];
  if (name.length < 2) errors.push({ field: "system:name", message: "Tên khách ít nhất 2 ký tự." });
  if (!phone) errors.push({ field: "system:phone", message: "Số điện thoại chỉ gồm 8–15 chữ số (có thể có dấu + ở đầu)." });
  if (address.length < 5 && !(opts.addressOptional && address.length === 0)) errors.push({ field: "system:address", message: "Địa chỉ quá ngắn." });
  if (errors.length || !phone) return fail("INVALID", errors);
  const db = await getDb();
  // Tìm-rồi-thêm trong MỘT giao dịch có khoá theo SĐT (TD-20): hai hội thoại cùng SĐT gửi đồng thời không đẻ hai khách.
  const res = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`customer-phone:${phone}`}, 0))`);
    const [found] = await tx.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.phone, phone)).limit(1);
    if (found) return { id: found.id, existing: true };
    const [row] = await tx.insert(schema.customers).values({ name, phone, phones: [phone], address, province }).returning({ id: schema.customers.id });
    return { id: row.id, existing: false };
  });
  if (res.existing) return { ok: true, id: res.id, existing: true };
  const created = { id: res.id };
  await audit({ userId: null, userEmail: `agent:${agent.source}`, actorKind: "AGENT", action: "CUSTOMER_CREATE", entity: "CUSTOMER", entityId: created.id, before: null, after: { name, phone, address, province }, reason: `Tạo bởi ${agent.name}` });
  return { ok: true, id: created.id, existing: false };
}

// ─────────────────────────── Sửa thông tin cơ bản của khách TẠO TAY (pilot P1 #11) ───────────────────────────

export const CUSTOMER_PROFILE_FORM = "profile";

/**
 * Thông tin cơ bản (tên · SĐT · địa chỉ · tỉnh) sửa được khi và chỉ khi: cùng cổng tạo khách (module bật, tổ chức KHÔNG
 * bật `connector_pancake`, có `customers:write`) VÀ khách không mang `pancake_id` (không phải bản đồng bộ). Khách Pancake
 * giữ chỉ đọc như cũ: sửa ở ERP thì lượt đồng bộ kế tiếp ghi đè lại, người sửa tưởng đã lưu mà dữ liệu tự quay về.
 */
export async function customerBasicsGate(user: SessionUser, customer: { pancakeId: string | null }): Promise<CreateGate> {
  if (customer.pancakeId) return { allowed: false, code: "NOT_SUPPORTED", reason: "Khách đồng bộ từ Pancake — sửa ở Pancake, không sửa ở ERP." };
  return customerCreateGate(user);
}

export type UpdateCustomerBasicsResult = { ok: true; changed: string[] } | MetaFailure;

/** Ghi thông tin cơ bản qua form `profile` đã xuất bản — chỉ ô hiện và không chỉ đọc; cùng luật chuẩn hoá với lượt tạo. */
export async function updateCustomerBasicsCore(user: SessionUser, customerId: string, rawSystem: unknown): Promise<UpdateCustomerBasicsResult> {
  const parsed = z.record(z.string(), z.unknown()).safeParse(rawSystem ?? {});
  if (!parsed.success) return fail("INVALID", "Dữ liệu gửi lên không đúng dạng.");
  const sysIn = parsed.data;
  const db = await getDb();
  const customer = await db.query.customers.findFirst({ where: eq(schema.customers.id, customerId), columns: { id: true, pancakeId: true, name: true, phone: true, address: true, province: true } });
  if (!customer) return fail("NOT_FOUND", "Không tìm thấy khách trong tổ chức này.");
  const gate = await customerBasicsGate(user, customer);
  if (!gate.allowed) return fail(gate.code, gate.reason);

  const [form, fields] = await Promise.all([getPublishedForm("customer", CUSTOMER_PROFILE_FORM), listFields("customer")]);
  const writable = writableRefs(form.schema);
  const errors: FieldError[] = [];
  const patch: { name?: string; phone?: string | null; phones?: string[]; address?: string; province?: string } = {};
  for (const key of Object.keys(sysIn)) {
    if (!writable.system.has(key) || !SYSTEM_LIMITS[key]) errors.push({ field: `system:${key}`, message: `Trường "${key}" không nhận ghi qua form này (ẩn hoặc chỉ đọc).` });
  }
  for (const f of fields.system) {
    const lim = SYSTEM_LIMITS[f.key];
    if (!lim || !(f.key in sysIn) || !writable.system.has(f.key)) continue;
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
    else if (lim.column === "phone") {
      patch.phone = v || null;
      patch.phones = v ? [v] : [];
    } else patch[lim.column] = v;
  }
  if (errors.length) return fail("INVALID", errors);
  const changed = (Object.keys(patch) as (keyof typeof patch)[]).filter((k) => k !== "phones" && patch[k] !== customer[k as "name" | "phone" | "address" | "province"]);
  if (!changed.length) return { ok: true, changed: [] };

  await db.update(schema.customers).set({ ...patch, updatedAt: new Date() }).where(eq(schema.customers.id, customerId));
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "CUSTOMER_UPDATE_BASICS",
    entity: "CUSTOMER",
    entityId: customerId,
    before: Object.fromEntries(changed.map((k) => [k, customer[k as "name" | "phone" | "address" | "province"]])),
    after: Object.fromEntries(changed.map((k) => [k, patch[k]])),
    reason: `Sửa thông tin cơ bản của khách tạo tay qua form "${CUSTOMER_PROFILE_FORM}" (phiên bản ${form.version}${form.isDefault ? ", mặc định" : ""})`,
  });
  return { ok: true, changed };
}

"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { checkEntitlement } from "@/lib/entitlements/check";
import { MetadataError, type MetadataErrorCode } from "@/lib/metadata/errors";
import type { CustomValues, FieldError } from "@/lib/metadata/types";
import { saveCustomFile, saveCustomValues } from "@/lib/metadata/values";
import { createCustomerCore, CUSTOMER_PROFILE_FORM, updateCustomerBasicsCore } from "@/lib/records/customer-create";

/**
 * ═══════════ SERVER ACTION GHI BẢN GHI QUA FORM METADATA (Phase 2) ═══════════
 *
 * Mỏng: phiên → lõi (`lib/records/*` — quyền, năng lực, form đã xuất bản, kiểm hợp lệ, nhật ký) →
 * `revalidatePath`. Lỗi nghiệp vụ trả `{ error, errors, code }` cùng hình `MetaActionResult` của
 * `lib/actions/metadata.ts`, để `DynamicForm` tô đúng ô. Không `router.refresh()` ở client.
 */

type Failure = { error: string; errors: FieldError[]; code: MetadataErrorCode };

function failure(r: { code: MetadataErrorCode; errors: FieldError[] }): Failure {
  return { error: r.errors.map((e) => e.message).join(" · ") || "Không lưu được.", errors: r.errors, code: r.code };
}

/** Tạo khách từ form `create` — chỉ khi tổ chức KHÔNG bật `connector_pancake` và người bấm có `customers:write`. */
export async function createCustomerAction(input: { system: Record<string, unknown>; custom: Record<string, unknown> }): Promise<({ ok: true; id: string; redirectTo: string; message: string }) | Failure> {
  const user = await requireUser();
  const r = await createCustomerCore(user, input);
  if (!r.ok) return failure(r);
  revalidatePath("/customers");
  return { ok: true, id: r.id, redirectTo: `/customers/${r.id}`, message: "Đã tạo khách hàng" };
}

/**
 * Lưu form `profile` của MỘT khách (pilot P1 #11): thông tin cơ bản (chỉ khách TẠO TAY ở tổ chức không bật Pancake —
 * cổng ở `updateCustomerBasicsCore`) rồi field bổ sung (cùng dịch vụ `saveCustomValues` như trước). Khách Pancake gửi
 * thông tin cơ bản ⇒ từ chối, không ghi gì.
 */
export async function saveCustomerProfileAction(input: { recordId: string; system: Record<string, unknown>; custom: Record<string, unknown> }): Promise<({ ok: true; values?: CustomValues; message: string }) | Failure> {
  const user = await requireUser();
  const recordId = typeof input?.recordId === "string" ? input.recordId : "";
  if (!recordId) return { error: "Thiếu mã khách.", errors: [{ field: "_", message: "Thiếu mã khách." }], code: "INVALID" };
  const system = input.system && typeof input.system === "object" ? input.system : {};
  const custom = (input.custom && typeof input.custom === "object" ? input.custom : {}) as CustomValues;
  let values: CustomValues | undefined;
  try {
    if (Object.keys(system).length) {
      const r = await updateCustomerBasicsCore(user, recordId, system);
      if (!r.ok) return failure(r);
    }
    if (Object.keys(custom).length) {
      const r = await saveCustomValues("customer", recordId, custom, user, { formKey: CUSTOMER_PROFILE_FORM });
      if (!r.ok) return failure(r);
      values = r.values;
    }
  } catch (error) {
    // Lượt ĐỌC metadata ném `MetadataError` (module tắt, form không có) — trả lỗi như các action metadata khác.
    if (error instanceof MetadataError) return { error: error.message, errors: [{ field: "_", message: error.message }], code: error.code };
    throw error;
  }
  revalidatePath(`/customers/${recordId}`);
  revalidatePath("/customers");
  return { ok: true, values, message: "Đã lưu hồ sơ khách" };
}

/**
 * Tải tệp cho field custom kiểu `file` của MỘT khách (`FormData`: `recordId`, `field`, `file`). Quyền, trần
 * dung lượng, tồn tại bản ghi và gán id tệp vào giá trị đều ở `saveCustomFile` (dịch vụ M1).
 */
export async function uploadCustomerFileAction(formData: FormData): Promise<{ ok: true; id: string; filename: string } | { ok: false; error: string }> {
  const user = await requireUser();
  const recordId = formData.get("recordId");
  const field = formData.get("field");
  const file = formData.get("file");
  if (typeof recordId !== "string" || typeof field !== "string" || !(file instanceof File)) return { ok: false, error: "Thiếu tệp hoặc thiếu bản ghi." };
  const ent = await checkEntitlement("storageMb", file.size / (1024 * 1024));
  if (!ent.ok) return { ok: false, error: ent.error };
  const r = await saveCustomFile("customer", recordId, field, { filename: file.name, mime: file.type, data: Buffer.from(await file.arrayBuffer()) }, user);
  if (!r.ok) return { ok: false, error: r.errors.map((e) => e.message).join(" · ") || "Không tải lên được." };
  revalidatePath(`/customers/${recordId}`);
  return { ok: true, id: r.file.id, filename: r.file.filename };
}

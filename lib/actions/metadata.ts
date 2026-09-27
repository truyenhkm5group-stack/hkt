"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { objectDef } from "@/lib/constants/object-registry";
import { MetadataError, type MetadataErrorCode, type MetaFailure } from "@/lib/metadata/errors";
import type { CustomValues, FieldError } from "@/lib/metadata/types";
import { saveCustomValues } from "@/lib/metadata/values";

/**
 * ═══════════ SERVER ACTION GHI GIÁ TRỊ CUSTOM (M14) ═══════════
 *
 * Mỏng có chủ đích: đọc phiên → gọi `lib/metadata/*` (nơi DUY NHẤT đọc/ghi bảng `meta_*` và `custom_values`,
 * kiểm hợp lệ, ghi nhật ký) → `revalidatePath`. Lỗi nghiệp vụ trả `{ error, errors, code }`, không ném. KHÔNG
 * kèm `router.refresh()` ở phía client — hai cơ chế cùng lúc là dựng trang hai lần (PR #272).
 *
 * Action CẤU HÌNH (field / form / danh sách / trạng thái, quyền `metadata:manage`) KHÔNG nằm ở đây: chúng ở
 * MỘT lớp duy nhất `lib/actions/metadata-admin.ts`, đi qua lõi có bài kiểm `lib/platform-ui/metadata-admin.ts`.
 * Hai lớp action cho cùng một lượt ghi là hai chỗ để kiểm quyền lệch nhau.
 *
 * Ghi GIÁ TRỊ custom chỉ cần phiên: quyền ghi của ĐỐI TƯỢNG (`lib/metadata/permissions.ts` — khoá do chính
 * module của đối tượng sở hữu) và `editPermission` của từng field được ép TRONG dịch vụ, không ở đây, để mọi
 * đường gọi (action, job, kiểm thử) đi qua cùng một hàng rào.
 */

export type MetaActionResult<T> = ({ ok: true } & T) | { error: string; errors: FieldError[]; code: MetadataErrorCode };

function failure(r: MetaFailure): { error: string; errors: FieldError[]; code: MetadataErrorCode } {
  return { error: r.errors.map((e) => e.message).join(" · ") || "Không lưu được.", errors: r.errors, code: r.code };
}

async function guarded<T>(fn: () => Promise<MetaActionResult<T>>): Promise<MetaActionResult<T>> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof MetadataError) return { error: error.message, errors: [{ field: "_", message: error.message }], code: error.code };
    throw error;
  }
}

/** Trang của đối tượng (danh sách + chi tiết, dẫn xuất từ sổ). */
function revalidateObject(objectKey: string) {
  const def = objectDef(objectKey);
  for (const list of def?.lists ?? []) {
    revalidatePath(list.route);
    revalidatePath(`${list.route}/[id]`, "page");
  }
}

const keyZ = z.string().min(1).max(60);

const valuesInputZ = z.object({
  objectKey: keyZ,
  recordId: z.string().min(1).max(200),
  values: z.record(z.string(), z.unknown()),
  formKey: keyZ.optional(),
});

/**
 * Ghi giá trị custom của MỘT bản ghi. Quyền: có phiên; dịch vụ ép quyền GHI của đối tượng (khách ⇒
 * `customers:write`, đối tượng khác ⇒ `metadata:manage` vì Phase 2 chưa có đường ghi runtime cho chúng —
 * `lib/metadata/permissions.ts`) + `editPermission` của từng field + bản ghi phải tồn tại trong CSDL của tổ chức
 * người gọi. `formKey` (tuỳ chọn) ⇒ chỉ nhận field hiện và không chỉ đọc trong form đã xuất bản.
 */
export async function saveCustomValuesAction(input: { objectKey: string; recordId: string; values: CustomValues; formKey?: string }): Promise<MetaActionResult<{ values: CustomValues; version: number }>> {
  const user = await requireUser();
  return guarded(async () => {
    const parsed = valuesInputZ.safeParse(input);
    if (!parsed.success) return { error: "Dữ liệu gửi lên không đúng dạng.", errors: [{ field: "_", message: "Dữ liệu gửi lên không đúng dạng." }], code: "INVALID" };
    const { objectKey, recordId, values, formKey } = parsed.data;
    const r = await saveCustomValues(objectKey, recordId, values, user, formKey ? { formKey } : {});
    if (!r.ok) return failure(r);
    if (r.changed.length > 0) revalidateObject(objectKey);
    return { ok: true, values: r.values, version: r.version };
  });
}

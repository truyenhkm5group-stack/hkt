/**
 * ═══════════ ĐỐI TƯỢNG TUỲ BIẾN TRONG TRANG ĐỘNG (Phase 6 · hợp đồng §7) — CHỈ MÁY CHỦ ═══════════
 *
 * Phần chung của trình phân giải khối (`lib/pages/data-sources.ts`) và sổ action (`lib/pages/actions.ts`) khi khoá đối
 * tượng là `x_…`. KHÔNG có cổng thứ hai: mọi lượt đi qua `recordGate` của dịch vụ bản ghi (lib/objects/records.ts) —
 * khoá phân giải được trong CSDL tổ chức hiện hành, đối tượng chưa lưu trữ, module `apps` + nhóm menu bật, đủ MỌI khoá
 * `objectAccess(def)`, phạm vi `CUSTOM_RECORDS` khác `NONE` — rồi đổi mã lỗi sang mã của khối.
 *
 * Mọi truy vấn trên `custom_records` phải mang `recordScopeSql(def)` (đúng `object_key` + chưa xoá mềm): mọi đối tượng
 * tuỳ biến dùng chung MỘT bảng, quên điều kiện ấy là bảng "Hợp đồng" hiện cả "Công trình".
 */
import type { ScopeDecision } from "@/lib/auth/scope-guard";
import type { SessionUser } from "@/lib/auth/session";
import type { AnyObjectDef } from "@/lib/constants/object-registry";
import { customObjectHref } from "@/lib/metadata/custom-object-def";
import { visibleRecordIds } from "@/lib/metadata/record-access";
import { isCustomObjectKey } from "@/lib/metadata/types";
import { recordGate } from "@/lib/objects/records";
import { pageDetailHref } from "@/lib/pages/runtime-common";
import type { BlockIssue } from "@/lib/pages/types";

export type CustomObjectGate = { ok: true; def: AnyObjectDef; decision: ScopeDecision } | { ok: false; code: BlockIssue["code"]; message: string };

export function isCustomKey(key: unknown): key is string {
  return typeof key === "string" && isCustomObjectKey(key);
}

/** Cổng của một đối tượng tuỳ biến cho MỘT người — cùng `recordGate` của trang /o/…, mã lỗi đổi sang mã của khối. */
export async function customObjectGate(user: SessionUser, objectKey: string, mode: "view" | "write" = "view"): Promise<CustomObjectGate> {
  const g = await recordGate(objectKey, user, mode);
  if (g.ok) return { ok: true, def: g.def, decision: g.decision };
  const code: BlockIssue["code"] = g.code === "MODULE_DISABLED" || g.code === "FORBIDDEN" || g.code === "NOT_FOUND" ? g.code : "INVALID_CONFIG";
  return { ok: false, code, message: g.errors[0]?.message ?? "Không mở được đối tượng này." };
}

/** Bản ghi tuỳ biến này người xem thấy (hoặc ghi) được không — đúng đối tượng, chưa xoá, trong phạm vi. */
export async function customRecordVisible(user: SessionUser, def: AnyObjectDef, id: string, mode: "view" | "write" = "view"): Promise<boolean> {
  return (await visibleRecordIds(user, def, [id], mode)).has(id);
}

/** Trang chi tiết của một bản ghi: đối tượng hệ thống ⇒ trang cũ (nếu có); tuỳ biến ⇒ `/o/<khoá>/<id>`. */
export function recordHref(def: Pick<AnyObjectDef, "key" | "system">, id: string): string | undefined {
  return def.system ? pageDetailHref(def.key, id) : customObjectHref(def.key, id);
}

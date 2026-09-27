/**
 * Phần dùng chung của trình phân giải khối và sổ action (Phase 4) — CHỈ MÁY CHỦ.
 *
 * Ba câu hỏi, hỏi theo ĐÚNG thứ tự của `requireResource` (quyền trước, phạm vi sau):
 *  1. module có bật cho TỔ CHỨC HIỆN HÀNH không (`canUseModule` — nguồn duy nhất; `user.modules` chỉ thu hẹp thêm);
 *  2. người xem có ĐÚNG khoá quyền cổng vào của trang cũ không (`can`);
 *  3. phạm vi dữ liệu (`decideScope` của scope-guard) — `NONE` ⇒ từ chối, không trả rỗng lặng lẽ.
 * Mọi nhánh lỗi rơi về phía HẸP HƠN (luật 31): thiếu khai ⇒ từ chối, không bao giờ mở.
 */
import type { Permission } from "@/lib/auth/permissions";
import { decideScope, type ScopeDecision } from "@/lib/auth/scope-guard";
import { can, type SessionUser } from "@/lib/auth/session";
import type { ModuleKey } from "@/lib/constants/platform-modules";
import { canUseModule } from "@/lib/platform/capabilities";
import type { BlockIssue } from "@/lib/pages/types";

/** Trang chi tiết CÓ SẴN của từng đối tượng — `rowLink` / `open_record` chỉ trỏ vào đây. */
export const PAGE_DETAIL_ROUTES: Readonly<Partial<Record<string, string>>> = {
  customer: "/customers",
  order: "/orders",
  product: "/products",
  shipment: "/shipments",
  model: "/models",
};

export function pageDetailHref(objectKey: string, id: string): string | undefined {
  const base = PAGE_DETAIL_ROUTES[objectKey];
  return base ? `${base}/${encodeURIComponent(id)}` : undefined;
}

/**
 * Loại dữ liệu của sổ phạm vi (`lib/constants/data-scope-policy.ts`) mà TRANG CŨ của đối tượng dùng trong
 * `requireResource`. `null` ⇒ trang cũ không qua sổ phạm vi (chỉ cổng quyền) — giữ đúng như vậy.
 */
export const OBJECT_SCOPE_RESOURCE: Readonly<Record<string, string | null>> = {
  customer: "CUSTOMERS",
  order: "ORDERS",
  product: "INVENTORY",
  shipment: "SHIPMENTS",
  return: "RETURNS",
  production_order: null,
  model: null,
};

export async function moduleOn(user: SessionUser, module: ModuleKey): Promise<boolean> {
  if (user.modules && !user.modules.includes(module)) return false;
  return canUseModule(module);
}

export type GateResult = { ok: true; decision: ScopeDecision } | { ok: false; code: BlockIssue["code"]; message: string };

const ALL: ScopeDecision = { allow: "ALL", explain: "Nguồn không qua sổ phạm vi — cùng cổng với trang cũ." };

/** Module → quyền → phạm vi. Trả quyết định phạm vi để nơi gọi ghép vào `where` (`andScope`) hoặc hỏi từng dòng. */
export async function gateSource(user: SessionUser, spec: { module: ModuleKey | null; permission: string | null; label: string }, resource: string | null): Promise<GateResult> {
  if (spec.module && !(await moduleOn(user, spec.module))) return { ok: false, code: "MODULE_DISABLED", message: `Module "${spec.module}" chưa được bật cho tổ chức này.` };
  if (spec.permission && !can(user, spec.permission as Permission)) return { ok: false, code: "FORBIDDEN", message: `Bạn không có quyền xem ${spec.label} (${spec.permission}).` };
  if (!resource) return { ok: true, decision: ALL };
  const decision = await decideScope(resource, user, spec.permission ?? undefined);
  if (decision.allow === "NONE") return { ok: false, code: "FORBIDDEN", message: `${decision.reason} ${decision.fix}`.trim() };
  return { ok: true, decision };
}

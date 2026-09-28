/**
 * ═══════════ HAI CỬA VÀO CHO MỌI NGƯỜI GỌI (màn Mẫu, AI Phase 8, onboarding Phase 10) — CHỈ MÁY CHỦ ═══════════
 *
 *   planForOrg(bp, user)          đọc ảnh chụp tổ chức CỦA PHIÊN → `planBlueprint` (chạy thử, không ghi)
 *   installBlueprint(bp, user)    lập lại kế hoạch NGAY LÚC CÀI → so `planHash` với bản người đã xem → `applyBlueprint`
 *
 * Lập lại kế hoạch lúc cài là cố ý: không tin kế hoạch gửi lên từ trình duyệt (nó là dữ liệu của client), và tổ chức
 * có thể đã đổi giữa lúc xem trước và lúc bấm. Kế hoạch khác bản đã xem ⇒ từ chối, bắt xem lại — người bấm chỉ xác
 * nhận thứ họ đã THẤY.
 */
import { can, type SessionUser } from "@/lib/auth/session";
import { applyBlueprint } from "@/lib/blueprints/apply";
import { planBlueprint } from "@/lib/blueprints/plan";
import { readOrgState } from "@/lib/blueprints/state";
import type { ApplyResult, Blueprint, BlueprintPlan, StepResolution } from "@/lib/blueprints/types";

export async function planForOrg(bp: Blueprint, user: SessionUser, resolutions: Record<string, StepResolution> = {}): Promise<BlueprintPlan> {
  const orgState = await readOrgState(bp, { orgIsHome: user.organization?.isHome === true });
  // Quyền đọc theo module ĐANG BẬT của tổ chức (không theo danh sách module có thể đã cũ trong phiên).
  const subject: SessionUser = { ...user, modules: orgState.enabledModules };
  return planBlueprint(bp, { orgState, can: (p) => can(subject, p as Parameters<typeof can>[1]), resolutions });
}

export async function installBlueprint(bp: Blueprint, user: SessionUser, opts: { expectedPlanHash?: string | null; resolutions?: Record<string, StepResolution> } = {}): Promise<ApplyResult> {
  if (!user.organization) return { ok: false, installId: null, failedStep: null, errors: [{ path: "", message: "Phiên chưa gắn tổ chức — đăng nhập lại." }], outcomes: [] };
  const plan = await planForOrg(bp, user, opts.resolutions ?? {});
  if (opts.expectedPlanHash && opts.expectedPlanHash !== plan.planHash) {
    return { ok: false, installId: null, failedStep: null, errors: [{ path: "planHash", message: "Tổ chức đã đổi từ lúc xem trước — kế hoạch không còn như bạn đã xem. Xem trước lại rồi cài." }], outcomes: [] };
  }
  return applyBlueprint(plan, user, { blueprint: bp });
}

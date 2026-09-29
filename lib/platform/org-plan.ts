import { and, eq, isNull } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { HOME_PLAN_KEY, listPlans, planKeyOf } from "@/lib/entitlements/check";
import { platformAudit } from "@/lib/platform/audit";
import { parseOperatorTarget, type KillSwitchResult } from "@/lib/platform/kill-switches";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";

/**
 * ═══════════ ĐỔI GÓI CỦA MỘT TỔ CHỨC — NGƯỜI VẬN HÀNH, KHÔNG SQL (docs/platform/pilot-operations.md §4) ═══════════
 *
 * Trước bản này `platform_organizations.plan` chỉ được ghi LÚC TẠO tổ chức: khách pilot vào gói `trial` (3 người dùng)
 * muốn thêm người thì chỉ còn đường sửa CSDL tay. Hàm này là đường ghi DUY NHẤT sau lúc tạo:
 *  · chỉ người vận hành của tổ chức nhà (`platformOperatorDenial`), bắt buộc lý do, ghi `platform_audit_log`
 *    (`ORG_PLAN_SET`, trước → sau); nhật ký hỏng ⇒ hoàn gói cũ;
 *  · gói phải có trong `platform_plans`; KHÔNG cấp gói `internal` (không giới hạn — gói của tổ chức nhà) cho khách;
 *  · tổ chức nhà không đổi gói (nhà luôn `internal`, `planKeyOf`);
 *  · ghi CÓ ĐIỀU KIỆN theo gói đang đọc được — hai người bấm cùng lúc thì lượt sau được báo tải lại, không đè im lặng;
 *  · hạ gói KHÔNG xoá gì: hạn mức mới chỉ chặn lượt TẠO kế tiếp (`checkEntitlement`), dữ liệu đang có giữ nguyên.
 * Hạn mức AI đọc gói qua cùng `planKeyOf` nên đổi theo, trễ tối đa thời gian đệm của sổ tổ chức.
 */
export async function setOrganizationPlan(user: SessionUser, input: unknown): Promise<KillSwitchResult> {
  // Hỏi người vận hành NGAY tại lõi, trước mọi lượt đọc (S21) — `parseOperatorTarget` hỏi lại lần nữa, vô hại.
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const raw = (input && typeof input === "object" ? input : {}) as { orgCode?: unknown; reason?: unknown; planKey?: unknown };
  const p = await parseOperatorTarget(user, raw);
  if ("error" in p) return p;
  const { org, reason, actor } = p;
  if (org.isHome) return { error: "Tổ chức nhà luôn ở gói nội bộ — không đổi gói từ màn hình này." };
  const planKey = typeof raw.planKey === "string" ? raw.planKey.trim() : "";
  if (!planKey) return { error: "Chọn gói." };
  if (planKey === HOME_PLAN_KEY) return { error: "Gói nội bộ (không giới hạn) chỉ dành cho tổ chức nhà — không cấp cho khách." };
  const plan = (await listPlans()).find((x) => x.key === planKey);
  if (!plan) return { error: `Không có gói «${planKey}» trong sổ gói.` };
  const from = planKeyOf(org);
  if (from === planKey) return { ok: true, changed: false, message: `«${org.name}» đang ở gói ${plan.name} sẵn.` };

  const pdb = await getPlatformDb();
  const t = schema.platformOrganizations;
  // Cột trống = `trial` theo `planKeyOf` ⇒ điều kiện phải khớp cả hai cách ghi của cùng một gói.
  const stored = org.plan?.trim() || null;
  const write = async (next: string | null, expect: string | null) =>
    (
      await pdb
        .update(t)
        .set({ plan: next, updatedAt: new Date() })
        .where(and(eq(t.code, org.code), expect === null ? isNull(t.plan) : eq(t.plan, expect)))
        .returning({ id: t.id })
    ).length > 0;
  const won = await write(planKey, stored);
  invalidateOrganizations();
  if (!won) return { error: "Gói vừa được người khác đổi — tải lại trang." };
  try {
    await platformAudit({ action: "ORG_PLAN_SET", targetOrgCode: org.code, subject: "plan", before: { plan: from }, after: { plan: planKey }, reason, source: "UI", actor });
  } catch {
    await write(stored, planKey);
    invalidateOrganizations();
    return { error: "Không ghi được nhật ký nền tảng — đã hoàn lại gói cũ, chưa đổi gì." };
  }
  return { ok: true, changed: true, message: `Đã chuyển «${org.name}» sang gói ${plan.name}. Hạn mức mới áp cho lượt tạo kế tiếp; không dữ liệu nào bị xoá.` };
}

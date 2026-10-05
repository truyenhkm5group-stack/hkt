import { and, eq, isNull } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { platformAudit } from "@/lib/platform/audit";
import { parseOperatorTarget, type KillSwitchResult } from "@/lib/platform/kill-switches";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";

/**
 * ═══════════ ĐẶT THƯƠNG HIỆU CỦA MỘT TỔ CHỨC — NGƯỜI VẬN HÀNH QUYẾT, MÁY KHÔNG ĐOÁN (0215) ═══════════
 *
 * `platform_organizations.brand` được ghi tự động MỘT lần lúc khách tự đăng ký (host của trang /start). Tổ chức có từ
 * trước 0215 để trống — host lúc đăng ký của họ không được lưu ở đâu, nên máy KHÔNG backfill (AGENTS.md mục 35). Người vận
 * hành biết khách đến từ Chốt Đơn Tự Động thì đặt tay ở đây; đó là một QUYẾT ĐỊNH CỦA NGƯỜI có lý do và có nhật ký, không
 * phải một phép đoán.
 *
 * Hệ quả duy nhất: liên kết gửi cho người của tổ chức (mời, đặt lại mật khẩu, tin nhóm) đi về phần mềm của thương hiệu đó
 * (`organizationBaseUrl`). Không đổi dữ liệu, quyền, gói hay module. Cùng khuôn với đổi gói (lib/platform/org-plan.ts):
 * chỉ người vận hành tổ chức nhà, bắt buộc lý do, ghi CÓ ĐIỀU KIỆN theo giá trị đang đọc, nhật ký hỏng ⇒ hoàn lại.
 */
export const ORG_BRANDS = ["vnx", "chotdon"] as const;
export type OrgBrand = (typeof ORG_BRANDS)[number];
export const ORG_BRAND_LABEL: Record<OrgBrand, string> = { vnx: "VNXcommerce (erp.vnxcommerce.com)", chotdon: "Chốt Đơn Tự Động (app.chotdontudong.com)" };

export async function setOrganizationBrand(user: SessionUser, input: unknown): Promise<KillSwitchResult> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const raw = (input && typeof input === "object" ? input : {}) as { orgCode?: unknown; reason?: unknown; brand?: unknown };
  const p = await parseOperatorTarget(user, raw);
  if ("error" in p) return p;
  const { org, reason, actor } = p;
  if (org.isHome) return { error: "Tổ chức nhà luôn dùng erp.vnxcommerce.com — không đổi thương hiệu từ màn hình này." };
  const brand = (ORG_BRANDS as readonly unknown[]).includes(raw.brand) ? (raw.brand as OrgBrand) : null;
  if (!brand) return { error: "Chọn thương hiệu." };
  const stored = org.brand ?? null;
  if (stored === brand) return { ok: true, changed: false, message: `«${org.name}» đang mang thương hiệu ${ORG_BRAND_LABEL[brand]} sẵn.` };

  const pdb = await getPlatformDb();
  const t = schema.platformOrganizations;
  const write = async (next: OrgBrand | null, expect: OrgBrand | null) =>
    (
      await pdb
        .update(t)
        .set({ brand: next, updatedAt: new Date() })
        .where(and(eq(t.code, org.code), expect === null ? isNull(t.brand) : eq(t.brand, expect)))
        .returning({ id: t.id })
    ).length > 0;
  const won = await write(brand, stored);
  invalidateOrganizations();
  if (!won) return { error: "Thương hiệu vừa được người khác đổi — tải lại trang." };
  try {
    await platformAudit({ action: "ORG_BRAND_SET", targetOrgCode: org.code, subject: "brand", before: { brand: stored }, after: { brand }, reason, source: "UI", actor });
  } catch {
    await write(stored, brand);
    invalidateOrganizations();
    return { error: "Không ghi được nhật ký nền tảng — đã hoàn lại thương hiệu cũ, chưa đổi gì." };
  }
  return { ok: true, changed: true, message: `Đã đặt «${org.name}» thuộc ${ORG_BRAND_LABEL[brand]}. Liên kết mời, đặt lại mật khẩu và tin nhóm từ nay về đúng phần mềm này.` };
}

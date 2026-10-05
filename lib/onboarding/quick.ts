import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { recordIdentity } from "@/lib/auth/identities";
import { normalizeEmail, normalizePhone } from "@/lib/auth/identity-shared";
import { OAUTH_IDENTITY_KIND, type SocialProfile } from "@/lib/auth/oauth";
import type { SessionSubject } from "@/lib/auth/session";
import { templateBlueprint } from "@/lib/blueprints/templates";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization, getHomeOrganization } from "@/lib/platform/organizations";
import { consumeSignupOtp, phoneOtpRequired, verifySignupOtp } from "@/lib/onboarding/phone-otp";
import { createOrganizationFromSignup, listOnboardingStates, type SignupActor } from "@/lib/onboarding/service";
import { ADMIN_PASSWORD_MIN, orgCodeBase, orgCodeCandidates, quickSignupZ } from "@/lib/onboarding/quick-shared";
import { BUSINESS_TYPE_SPEC, closeUnderDependencies, firstIssue, SELECTABLE_MODULES, type SignupDraft } from "@/lib/onboarding/shared";

/**
 * ═══════════ ĐĂNG KÝ NHANH MỘT MÀN HÌNH — CHỈ MÁY CHỦ (docs/platform/quick-start.md) ═══════════
 *
 * Dựng ĐẦY ĐỦ bản nháp của trình hướng dẫn từ năm ô (hoặc ba ô + hồ sơ Google / Facebook) rồi giao cho ĐÚNG lõi tạo tổ
 * chức `createOrganizationFromSignup` — không có đường tạo thứ hai. Máy tự quyết:
 *  · MÃ tổ chức: từ tên cửa hàng, chưa ai dùng (gốc, gốc-2 … gốc-9, rồi đuôi ngẫu nhiên). Khách không phải nghĩ ra mã.
 *  · MẪU + MODULE: mẫu gợi ý của ngành hàng (như bước «Loại hình» của trình hướng dẫn), CỘNG «AI bán hàng» — mục tiêu của
 *    đăng ký nhanh là vào việc với Fanpage ngay.
 *  · Tên quản trị: tên từ Google / Facebook, không có thì «Chủ cửa hàng» (đổi được sau).
 *  · Đăng ký bằng Google / Facebook: mật khẩu NGẪU NHIÊN không ai biết — đăng nhập lại bằng đúng nút đó, hoặc bằng
 *    email / SĐT sau khi đặt mật khẩu qua liên kết đặt lại.
 */

export type QuickSignupResult = { ok: true; orgCode: string; loggedIn: boolean } | { error: string; needOtp?: true };

/** Mã tổ chức chưa ai dùng cho tên cửa hàng này. */
export async function freeOrgCode(storeName: string): Promise<string> {
  const home = (await getHomeOrganization()).code;
  for (const code of orgCodeCandidates(orgCodeBase(storeName))) {
    if (code !== home && !(await findOrganization(code))) return code;
  }
  for (let i = 0; i < 5; i++) {
    const code = `${orgCodeBase(storeName).slice(0, 24)}-${randomBytes(3).toString("hex")}`;
    if (!(await findOrganization(code))) return code;
  }
  throw new Error("Không tìm được mã tổ chức trống — thử lại.");
}

/** Module của ngành hàng (mẫu gợi ý, cắt theo module chọn được) + «AI bán hàng», đóng theo phụ thuộc. */
export function quickModules(businessType: keyof typeof BUSINESS_TYPE_SPEC): { templateKey: string | null; modules: string[] } {
  const spec = BUSINESS_TYPE_SPEC[businessType];
  const tpl = spec.templateKey ? templateBlueprint(spec.templateKey) : null;
  const base = tpl ? tpl.modules.filter((m) => SELECTABLE_MODULES.includes(m)) : spec.modules;
  return { templateKey: tpl?.key ?? null, modules: closeUnderDependencies([...base, "ai_sales"]).modules };
}

export async function quickSignup(raw: unknown, who: SignupActor, opts: { issue?: (subject: SessionSubject) => Promise<void>; social?: SocialProfile | null } = {}): Promise<QuickSignupResult> {
  const parsed = quickSignupZ.safeParse(raw);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const input = parsed.data;
  const social = opts.social ?? null;

  const phone = normalizePhone(input.phone);
  if (!phone) return { error: "Số điện thoại di động không hợp lệ (vd 0912 345 678)." };
  const email = social?.email ?? normalizeEmail(input.email);
  if (!email) return { error: social ? `Tài khoản ${social.provider === "google" ? "Google" : "Facebook"} không cho biết email — nhập email.` : "Email không hợp lệ." };
  let password = input.password;
  if (social) password = randomBytes(24).toString("base64url");
  else if (password.length < ADMIN_PASSWORD_MIN) return { error: `Mật khẩu ít nhất ${ADMIN_PASSWORD_MIN} ký tự.` };

  // Bấm hai lần / trình duyệt gửi lại: email này vừa tự tạo một cửa hàng ⇒ không đẻ cửa hàng thứ hai với mã khác.
  const states = await listOnboardingStates();
  const mine = Object.entries(states).find(([, s]) => s.adminEmail === email && s.source !== "OPERATOR" && (s.state === "DONE" || s.state === "RUNNING"));
  if (mine) return { error: mine[1].state === "RUNNING" ? "Cửa hàng của bạn đang được tạo — đợi vài giây rồi đăng nhập." : "Email này đã có cửa hàng — đăng nhập để vào." };

  // XÁC MINH SĐT (khi người vận hành bật): SĐT sắp thành danh tính đăng nhập — phải là số của chính người đăng ký.
  let otpId: string | null = null;
  if (who.kind !== "operator" && (await phoneOtpRequired())) {
    const v = await verifySignupOtp(phone, input.otp);
    if ("error" in v) return { error: v.error, needOtp: true };
    otpId = v.id;
  }

  const code = await freeOrgCode(input.storeName);
  const plan = quickModules(input.businessType);
  const draft: SignupDraft = {
    invite: input.invite ?? null,
    org: { name: input.storeName, code },
    admin: { name: (social?.name ?? "").trim().slice(0, 120) || "Chủ cửa hàng", email, password },
    plan: { businessType: input.businessType, templateKey: plan.templateKey, modules: plan.modules },
    planKey: null,
  };
  const r = await createOrganizationFromSignup(draft, who, opts.issue ? { issue: opts.issue } : {});
  if ("error" in r) return { error: r.error };
  if (otpId) await consumeSignupOtp(otpId);

  // SĐT của quản trị + chỉ mục danh tính: đăng nhập lại bằng SĐT / email / nút Google·Facebook ở trang chung, không cần mã.
  const adminId = await withOrganization(code, async () => {
    const db = await getDb();
    const [u] = await db.update(schema.users).set({ phone, updatedAt: new Date() }).where(eq(schema.users.email, email)).returning({ id: schema.users.id });
    return u?.id ?? null;
  });
  if (adminId) {
    await recordIdentity("EMAIL", email, code, adminId);
    await recordIdentity("PHONE", phone, code, adminId);
    if (social) await recordIdentity(OAUTH_IDENTITY_KIND[social.provider], social.subject, code, adminId);
  }
  return { ok: true, orgCode: r.orgCode, loggedIn: r.loggedIn };
}

import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { setSettingJson } from "@/lib/settings";
import { INTL_SEARCH_PROVINCES } from "@/lib/wholesale/areas-intl";
import type { CoreResult } from "@/lib/wholesale/campaigns";
import { WHOLESALE_EMAIL_SETTING_KEY } from "@/lib/wholesale/email-constants";
import { getEmailSettings } from "@/lib/wholesale/email-outbox-store";

/**
 * ═══════════ CỔNG PHÁP LÝ THEO NƯỚC CHO THƯ CHÀO HÀNG (issue #1085) — GHI ═══════════
 *
 * `wholesale.email.allowedCountries`: danh sách nước ĐÃ RÀ LUẬT thư chào hàng. Mặc định RỖNG, không có nước mặc định, kể cả
 * `VN`. Nước chưa có ⇒ thư chỉ chạy thử (cổng `evaluateEmailSend` giữ thư ở chế độ gửi thật với `COUNTRY_NOT_REVIEWED`).
 * Đây là một quyết định PHÁP LÝ nên chỉ QUẢN TRỊ (vai trò ADMIN, có `wholesale:config`) sửa được, bắt buộc lý do, có audit.
 */

/** Nước chọn được: 15 nước của quét quốc tế + `VN` (khách trong nước). Mã lạ không vào được danh sách. */
export const EMAIL_COUNTRY_CHOICES: readonly { code: string; label: string }[] = [
  { code: "VN", label: "Việt Nam (khách trong nước)" },
  ...INTL_SEARCH_PROVINCES.map((p) => ({ code: p.locale?.regionCode ?? "", label: p.label })).filter((c) => /^[A-Z]{2}$/.test(c.code)),
];
const CODES = new Set(EMAIL_COUNTRY_CHOICES.map((c) => c.code));

const inputSchema = z.object({
  countries: z.array(z.string().trim().toUpperCase()).max(60),
  reason: z.string().trim().min(10, "Ghi lý do (ít nhất 10 ký tự) — đã rà luật nước nào, ai rà, căn cứ gì.").max(500),
});

export async function saveEmailAllowedCountriesCore(user: SessionUser, raw: unknown): Promise<CoreResult<{ countries: string[] }>> {
  if (!can(user, "wholesale:config") || user.role !== "ADMIN") return { error: "Chỉ quản trị (chủ shop) sửa được danh sách nước đã rà luật thư chào hàng." };
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const unknown = parsed.data.countries.filter((c) => !CODES.has(c));
  if (unknown.length) return { error: `Mã nước không có trong danh sách: ${unknown.join(", ")}.` };
  const countries = [...new Set(parsed.data.countries)].sort();
  const before = await getEmailSettings();
  await setSettingJson(WHOLESALE_EMAIL_SETTING_KEY, { ...before, allowedCountries: countries });
  await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_EMAIL_COUNTRIES", entity: "SETTINGS", entityId: `${WHOLESALE_EMAIL_SETTING_KEY}.allowedCountries`, before: { allowedCountries: before.allowedCountries }, after: { allowedCountries: countries }, reason: parsed.data.reason });
  return { ok: true, countries };
}

import { findIdentity, type IdentityHit } from "@/lib/auth/identities";
import { OAUTH_IDENTITY_KIND, type SocialProfile } from "@/lib/auth/oauth";

/**
 * Người vừa xác minh ở Google / Facebook là AI trong nền tảng (docs/platform/quick-start.md):
 *  1. đã từng đăng nhập bằng đúng nút này ⇒ danh tính `GOOGLE` / `FACEBOOK` theo mã người dùng của nhà cung cấp;
 *  2. chưa ⇒ EMAIL đã xác minh của hồ sơ khớp tài khoản nào (email của tài khoản ERP thuộc về người đó);
 *  3. không khớp gì ⇒ người mới: sang đăng ký nhanh với hồ sơ điền sẵn.
 * Một tổ chức ⇒ vào thẳng; nhiều ⇒ hỏi chọn. Mỗi tổ chức lấy MỘT tài khoản (mới dùng nhất).
 */
export type SocialResolution = { kind: "LOGIN"; hit: IdentityHit } | { kind: "PICK"; hits: IdentityHit[] } | { kind: "SIGNUP" };

function onePerOrg(hits: readonly IdentityHit[]): IdentityHit[] {
  const seen = new Set<string>();
  return hits.filter((h) => (seen.has(h.orgCode) ? false : (seen.add(h.orgCode), true)));
}

export async function resolveSocial(profile: SocialProfile): Promise<SocialResolution> {
  let hits = await findIdentity(OAUTH_IDENTITY_KIND[profile.provider], profile.subject);
  if (hits.length === 0 && profile.email) hits = await findIdentity("EMAIL", profile.email);
  hits = onePerOrg(hits);
  if (hits.length === 0) return { kind: "SIGNUP" };
  if (hits.length === 1) return { kind: "LOGIN", hit: hits[0] };
  return { kind: "PICK", hits };
}

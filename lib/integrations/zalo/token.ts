/**
 * ═══════════ TOKEN ZALO OA — QUYẾT ĐỊNH THUẦN «DÙNG TIẾP HAY LÀM MỚI» ═══════════
 *
 * Bí mật của kết nối `zalo-oa` gồm ba ô người dán (`appSecret`, `oaSecretKey`, `refreshToken`) và ba ô MÁY ghi sau mỗi lần
 * làm mới (`accessToken`, `accessTokenExpiresAt`, `tokenPairOf`). `tokenPairOf` = dấu của refresh token đi CÙNG access token
 * đang lưu: người dán một refresh token MỚI (đổi OA, lấy lại token) thì dấu lệch ⇒ access token cũ coi như không có — nếu
 * không, bot sẽ trả lời bằng token của OA cũ cho tới khi nó hết hạn.
 *
 * Lưu cặp mới là việc của `lib/connectors/service.ts::rotateOrgConnectionSecrets` (khoá tư vấn + đọc lại + mã hoá). Tệp này
 * không đọc / ghi CSDL.
 */
import { createHash } from "node:crypto";
import { ZALO_LIMITS, zaloRefreshTokens, type ZaloDeps } from "@/lib/integrations/zalo/oa";

export const ZALO_MACHINE_SECRETS = ["accessToken", "accessTokenExpiresAt", "tokenPairOf"] as const;

export function tokenPairOf(refreshToken: string): string {
  return createHash("sha256").update(`zalo-pair:${refreshToken.trim()}`).digest("hex").slice(0, 24);
}

/** Access token còn dùng được (đúng cặp với refresh token đang lưu, còn hạn quá `refreshSkewMs`) hoặc `null`. HÀM THUẦN. */
export function usableAccessToken(secrets: Readonly<Record<string, string>>, now: Date): string | null {
  const access = (secrets.accessToken ?? "").trim();
  const refresh = (secrets.refreshToken ?? "").trim();
  const exp = Date.parse(secrets.accessTokenExpiresAt ?? "");
  if (!access || !refresh || !Number.isFinite(exp)) return null;
  if (secrets.tokenPairOf !== tokenPairOf(refresh)) return null;
  return exp - ZALO_LIMITS.refreshSkewMs > now.getTime() ? access : null;
}

/**
 * Làm mới bằng refresh token đang lưu ⇒ access token + BẢN VÁ bí mật phải lưu NGAY (refresh token cũ đã bị Zalo huỷ).
 * Còn dùng được ⇒ không gọi Zalo, bản vá `null`.
 */
export async function ensureZaloAccessToken(
  current: { secrets: Readonly<Record<string, string>>; settings: Readonly<Record<string, string>> },
  deps: ZaloDeps = {},
): Promise<{ ok: true; accessToken: string; patch: Record<string, string> | null } | { ok: false; error: string }> {
  const now = (deps.now ?? (() => new Date()))();
  const still = usableAccessToken(current.secrets, now);
  if (still) return { ok: true, accessToken: still, patch: null };
  const r = await zaloRefreshTokens({ appId: (current.settings.appId ?? "").trim(), appSecret: (current.secrets.appSecret ?? "").trim(), refreshToken: (current.secrets.refreshToken ?? "").trim() }, deps);
  if (!r.ok) return r;
  return {
    ok: true,
    accessToken: r.pair.accessToken,
    patch: { accessToken: r.pair.accessToken, refreshToken: r.pair.refreshToken, accessTokenExpiresAt: r.pair.expiresAt.toISOString(), tokenPairOf: tokenPairOf(r.pair.refreshToken) },
  };
}

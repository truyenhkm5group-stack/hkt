import { memo } from "@/lib/cache";
import { assessFbScopes, type FbScopeAssessment } from "@/lib/constants/fb-token-scopes";
import { env } from "@/lib/env";
import { FacebookAdsClient } from "@/lib/integrations/facebook/client";
import { openOrgGraphCredential } from "@/lib/marketing/meta-ads-org-write";
import { currentOrganization } from "@/lib/platform/context";

/**
 * Client để HỎI token đang chạy: nhà ⇒ biến môi trường như cũ; tổ chức khách ⇒ token System User của CHÍNH tổ chức
 * (kết nối «meta-ads-org», chỉ đọc). `null` = tổ chức chưa có token nào để hỏi (lý do ở `reason`).
 */
async function tokenClient(): Promise<{ client: FacebookAdsClient | null; reason: string | null }> {
  const org = await currentOrganization();
  if (org.isHome) return env.facebook.accessToken ? { client: new FacebookAdsClient(), reason: null } : { client: null, reason: "Máy chủ chưa có FACEBOOK_ACCESS_TOKEN." };
  const c = await openOrgGraphCredential("READ");
  if (!c.ok) return { client: null, reason: `Chưa có token của tổ chức: ${c.reason}` };
  return { client: FacebookAdsClient.fromOrgConnection({ organization: c.org, accessToken: c.token, adAccountIds: c.adAccountIds }), reason: null };
}

/**
 * Trần chờ câu trả lời quyền. Client Facebook cho mỗi lượt gọi tới 90 giây kèm thử lại — đúng cho job
 * đồng bộ, sai cho một ô hiển thị nằm trên `/ads`: Facebook chậm thì cả trang quyết định đứng theo.
 * Quá trần ⇒ `UNKNOWN` ("chưa biết"), không bao giờ ⇒ "thiếu".
 */
export const FB_SCOPE_TIMEOUT_MS = 5_000;

/**
 * Quyền của token Facebook đang chạy — hỏi Facebook, nhớ 10 phút.
 *
 * Token chỉ đổi khi có một lượt deploy (secret → `.env` → khởi động lại container, tức là bộ nhớ tạm
 * cũng mất), nên hỏi lại mỗi lần mở trang là tốn một lượt gọi Graph API cho một câu trả lời không đổi.
 * Lỗi KHÔNG ném ra: trang Cấu hình và `/ads` phải hiện được "chưa biết" thay vì sập.
 */
export async function getFbTokenScopes(): Promise<FbScopeAssessment> {
  return memo("fb-token-scopes", 600_000, async () => {
    const { client } = await tokenClient();
    const hasToken = client !== null;
    if (!client) return assessFbScopes({ hasToken, permissions: null });
    let hetGio: NodeJS.Timeout | undefined;
    try {
      const permissions = await Promise.race([
        client.getPermissions(),
        new Promise<never>((_, reject) => {
          hetGio = setTimeout(() => reject(new Error(`quá ${FB_SCOPE_TIMEOUT_MS / 1000} giây chưa trả lời`)), FB_SCOPE_TIMEOUT_MS);
        }),
      ]);
      return assessFbScopes({ hasToken, permissions });
    } catch (e) {
      return assessFbScopes({ hasToken, permissions: null, error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (hetGio) clearTimeout(hetGio);
    }
  });
}

/** Token Facebook đang chạy thuộc ứng dụng nào. `KNOWN` = Facebook trả lời; `UNKNOWN` = chưa hỏi được (lý do ở `error`). */
export type FbTokenIdentity =
  | { state: "KNOWN"; appId: string; appName: string; type: string; isValid: boolean; expiresAt: number | null }
  | { state: "UNKNOWN"; error: string };

/**
 * Token đang chạy của ỨNG DỤNG NÀO — hỏi Facebook (`debug_token`), nhớ 10 phút như quyền (token chỉ đổi khi deploy). Không
 * ném: không có token / Facebook chậm quá `FB_SCOPE_TIMEOUT_MS` / lỗi ⇒ `UNKNOWN` kèm lý do, không bao giờ đoán một ứng dụng.
 */
export async function getFbTokenIdentity(): Promise<FbTokenIdentity> {
  return memo("fb-token-identity", 600_000, async (): Promise<FbTokenIdentity> => {
    const { client, reason } = await tokenClient();
    if (!client) return { state: "UNKNOWN", error: reason ?? "Chưa có token." };
    let hetGio: NodeJS.Timeout | undefined;
    try {
      const id = await Promise.race([
        client.tokenIdentity(),
        new Promise<never>((_, reject) => {
          hetGio = setTimeout(() => reject(new Error(`quá ${FB_SCOPE_TIMEOUT_MS / 1000} giây chưa trả lời`)), FB_SCOPE_TIMEOUT_MS);
        }),
      ]);
      return id.appId ? { state: "KNOWN", ...id } : { state: "UNKNOWN", error: "Facebook không trả mã ứng dụng của token." };
    } catch (e) {
      return { state: "UNKNOWN", error: e instanceof Error ? e.message : String(e) };
    } finally {
      if (hetGio) clearTimeout(hetGio);
    }
  });
}

/** Câu "token thuộc ứng dụng …" cho người đọc + đường tới trang cài đặt của ĐÚNG ứng dụng ấy. Hàm THUẦN. */
export function describeFbTokenApp(t: FbTokenIdentity): string {
  if (t.state !== "KNOWN") return `Chưa hỏi được Facebook token thuộc ứng dụng nào (${t.error}).`;
  const loai = t.type === "SYSTEM_USER" ? "người dùng hệ thống" : t.type === "USER" ? "tài khoản cá nhân" : t.type || "không rõ loại";
  return `Token ERP đang dùng thuộc ứng dụng "${t.appName || "không tên"}" (ID ${t.appId}, token ${loai}${t.isValid ? "" : ", ĐÃ HẾT HIỆU LỰC"}). Chính ứng dụng NÀY phải ở chế độ Live: developers.facebook.com/apps/${t.appId}/settings/basic/ → mục "Đăng" phải có nhãn "Đã đăng".`;
}


import { memo } from "@/lib/cache";
import { assessFbScopes, type FbScopeAssessment } from "@/lib/constants/fb-token-scopes";
import { env } from "@/lib/env";
import { FacebookAdsClient } from "@/lib/integrations/facebook/client";

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
    const hasToken = Boolean(env.facebook.accessToken);
    if (!hasToken) return assessFbScopes({ hasToken, permissions: null });
    let hetGio: NodeJS.Timeout | undefined;
    try {
      const permissions = await Promise.race([
        new FacebookAdsClient().getPermissions(),
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

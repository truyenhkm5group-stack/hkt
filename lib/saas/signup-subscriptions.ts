/**
 * ═══════════ THUÊ BAO SẢN PHẨM CỦA CỬA HÀNG TỰ ĐĂNG KÝ — CHỈ MÁY CHỦ (kiểm vỏ khách 08/10/2026 · F-02) ═══════════
 *
 * VÌ SAO CÓ BƯỚC NÀY. `/start` (trình hướng dẫn lẫn đăng ký nhanh) cấp workspace bằng `provisionOrganization` với ĐÚNG module
 * lõi (`core`, `work`); bước 6 của nó (`openSubscriptionsForProductsInUse`) vì vậy chạy lúc CHƯA có module độc quyền nào bật ⇒
 * không mở gì. Mẫu ngành cài SAU đó mới bật `ai_sales` / module ERP — qua `setOrganizationModule`, đường ấy không mở thuê bao.
 * Kết quả đo production 08/10/2026: workspace tự đăng ký (`brand` khác NULL) không có dòng `platform_product_subscriptions`
 * nào ⇒ trang Gói của khách báo «chưa có thuê bao», số thuê bao / khách theo sản phẩm thiếu đúng các cửa hàng tự đăng ký.
 *
 * KHÔNG CÓ LUẬT MỞ THUÊ BAO THỨ HAI. Sản phẩm = sản phẩm workspace ĐANG DÙNG theo module (`productsInUse` — cùng luật backfill
 * 0224, cùng vỏ app `salesAgentShell`, cùng nút «Mở thuê bao còn thiếu» của người vận hành); đường ghi =
 * `openSubscriptionsForProductsInUse` (CHỈ THÊM; chỉ mục duy nhất thuê bao sống ⇒ gọi hai lần không đẻ dòng thứ hai). Thuê bao
 * mở ra y như luồng người vận hành: `ACTIVE`, theo gói workspace (`plan_key NULL`), có nhật ký `PRODUCT_SUBSCRIBE`. Dùng thử
 * KHÔNG nằm trên thuê bao sản phẩm: tình trạng hiệu lực (`TRIAL` · `ACTIVE` · `PAST_DUE` · `EXPIRED`) đọc từ thu phí của
 * workspace (`lib/saas/policy.ts::effectiveSubscriptionStatus`, mốc dùng thử chụp lúc đăng ký bởi `initWorkspaceBilling`) —
 * bước này không đặt số ngày nào, không bật thu phí, không tạo khoá.
 *
 * THƯƠNG HIỆU (host khách đăng ký, 0215) chỉ để ĐỐI CHIẾU (`brandProductKey`): đăng ký nhanh luôn bật `ai_sales` nên khách
 * host Chốt Đơn luôn có thuê bao `chotdon`; khách chọn mẫu ngành đầy đủ thì đồng thời là khách ERP — đúng như vỏ app đối xử với
 * họ. Mở theo thương hiệu thay cho module là đẻ ra luật thứ hai, và thuê bao sẽ nói một điều còn vỏ app nói điều khác.
 *
 * KHÔNG BAO GIỜ NÉM. Lỗi ở đây không được làm hỏng lượt đăng ký (cửa hàng đã dựng xong, khách đã có quản trị) nhưng cũng không
 * được nuốt im: trả `{ ok: false, error }`, ghi `console.warn`, và ghi MỘT dòng nhật ký nền tảng `ORG_SETUP` · chủ đề
 * `product-subscriptions` (trang khách của người vận hành đọc được, cờ «Module lệch thuê bao» cũng bật). Sửa bù: chạy lại
 * `scripts/saas-subscription-repair.ts --apply` (đi qua đúng hàm này) hoặc nút «Mở thuê bao còn thiếu».
 */
import { platformAudit, type PlatformActor, type PlatformAuditSource } from "@/lib/platform/audit";
import { findOrganization } from "@/lib/platform/organizations";
import { openSubscriptionsForProductsInUse, productsInUse, type SaasSource } from "@/lib/saas/accounts";
import { PRODUCTS, type ProductDef } from "@/lib/saas/catalog";

/** Nguồn ghi trên dòng thuê bao (CHECK của 0224 đã khai sẵn `SIGNUP`): thuê bao sinh ra từ luồng tự đăng ký. */
export const SIGNUP_SUBSCRIPTION_SOURCE: SaasSource = "SIGNUP";
/** Chủ đề của dòng nhật ký nền tảng khi bước này hỏng (`ORG_SETUP`). */
export const SIGNUP_SUBSCRIPTION_AUDIT_SUBJECT = "product-subscriptions";

export type SignupSubscriptionOutcome =
  /** `opened` = vừa mở ở lượt này; `inUse` = sản phẩm đang dùng theo module (đã có thuê bao thì không mở lại). */
  | { ok: true; opened: string[]; inUse: string[] }
  | { ok: false; error: string };

/** Sản phẩm mà THƯƠNG HIỆU của host bán (danh mục khai `ProductDef.brand`). `null` = không theo dõi thương hiệu / không sản phẩm nào. */
export function brandProductKey(brand: string | null | undefined, catalog: readonly ProductDef[] = PRODUCTS): string | null {
  if (!brand) return null;
  return catalog.find((p) => p.brand === brand)?.key ?? null;
}

/**
 * Mở thuê bao cho sản phẩm workspace ĐANG DÙNG mà chưa có thuê bao sống — bước «thuê bao» của luồng tự đăng ký, chạy SAU khi
 * mẫu ngành đã bật module. Dùng chung cho `/start` (`lib/onboarding/service.ts::runSetup`) và cho lượt sửa bù
 * (`lib/saas/subscription-repair.ts`). Idempotent; không bao giờ ném (xem đầu tệp).
 *
 * `beforeOpen` chỉ dành cho bộ kiểm thử (móc tiêm lỗi của `/start`): nó chạy BÊN TRONG vùng bắt lỗi, nên một lỗi tiêm ở đây
 * đi đúng đường của một lỗi thật.
 */
export async function openSignupSubscriptions(orgCode: string, ctx: { actor: PlatformActor; reason: string; auditSource: PlatformAuditSource; beforeOpen?: () => void }): Promise<SignupSubscriptionOutcome> {
  try {
    const org = await findOrganization(orgCode);
    if (!org) throw new Error(`Không có workspace "${orgCode}".`);
    if (org.isHome) throw new Error("Workspace nhà không đi luồng tự đăng ký — thuê bao của nhà do người vận hành quản.");
    ctx.beforeOpen?.();
    const opened = await openSubscriptionsForProductsInUse(org.code, { actor: ctx.actor, source: SIGNUP_SUBSCRIPTION_SOURCE, reason: ctx.reason });
    return { ok: true, opened, inUse: await productsInUse(org.code) };
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    console.warn(`[saas] chưa mở được thuê bao sản phẩm cho ${orgCode}: ${error}`);
    try {
      await platformAudit({ action: "ORG_SETUP", targetOrgCode: orgCode, subject: SIGNUP_SUBSCRIPTION_AUDIT_SUBJECT, after: { step: "SUBSCRIPTIONS", outcome: "FAILED" }, reason: error, source: ctx.auditSource, actor: ctx.actor });
    } catch (auditError) {
      console.warn(`[saas] không ghi được nhật ký lỗi mở thuê bao cho ${orgCode}: ${auditError instanceof Error ? auditError.message : String(auditError)}`);
    }
    return { ok: false, error };
  }
}

import type { CampaignSetup } from "@/lib/constants/campaign-setup";
import type { TemplateAd } from "@/lib/integrations/facebook/ads-write";

/**
 * ═══════════ ÁP SETUP CAMP LÊN QUẢNG CÁO MẪU — HÀM THUẦN ═══════════
 *
 * Đường đăng vẫn DỰNG từ quảng cáo mẫu (mọi thứ người không chọn giữ nguyên như mẫu), chỉ thay đúng những gì setup nói.
 * Không đọc CSDL, không gọi mạng; ra là một `TemplateAd` mới, không sửa đối tượng vào. Xem `lib/constants/campaign-setup.ts`.
 *
 *  · Mục tiêu `MESSAGES` / `REACH` thay mục tiêu chiến dịch + BỘ tham số nhóm tương ứng (tổ hợp chuẩn, không trộn).
 *  · Đối tượng quảng bá (`promoted_object.page_id`) luôn đổi sang fanpage đã chọn — tin nhắn của khách phải về đúng page
 *    đứng tên bài.
 *  · TKQC khác tài khoản của quảng cáo mẫu ⇒ BỎ tệp đối tượng tuỳ chỉnh (`custom_audiences`…) khỏi targeting: chúng thuộc
 *    tài khoản kia, gửi sang là Facebook từ chối cả nhóm.
 *  · Người chọn FANPAGE khác fanpage của bài mẫu ⇒ bỏ tài khoản Instagram của bài mẫu (nó gắn với page cũ, gửi kèm page
 *    mới là Facebook từ chối bài). Không chọn khác ⇒ giữ nguyên như trước giờ.
 *  · Người đặt tuổi khác mẫu mà mẫu bật Advantage+ đối tượng ⇒ tắt Advantage+ để tuổi là RÀNG BUỘC (Facebook không nhận tuổi
 *    tối đa < 65 khi Advantage+ bật, và người đã chọn tuổi thì không muốn nó chỉ là "gợi ý").
 */

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

const norm = (id: string | null | undefined) => (id ?? "").replace(/^act_/, "").trim();

export function applyCampaignSetup(t: TemplateAd, s: CampaignSetup): TemplateAd {
  const out = clone(t);
  const targeting: Record<string, unknown> = { ...(out.adset.targeting ?? {}) };

  if (t.accountId && norm(t.accountId) !== norm(s.adAccountId)) {
    for (const k of ["custom_audiences", "excluded_custom_audiences"]) delete targeting[k];
  }

  if (s.geo !== null) {
    const cu = targeting.geo_locations && typeof targeting.geo_locations === "object" ? (targeting.geo_locations as Record<string, unknown>) : {};
    const loc: Record<string, unknown> = {};
    if (Array.isArray(cu.location_types)) loc.location_types = cu.location_types;
    const regions = s.geo.filter((g) => g.type === "region").map((g) => ({ key: g.key }));
    const cities = s.geo.filter((g) => g.type === "city").map((g) => ({ key: g.key }));
    if (regions.length === 0 && cities.length === 0) loc.countries = ["VN"];
    if (regions.length) loc.regions = regions;
    if (cities.length) loc.cities = cities;
    targeting.geo_locations = loc;
  }

  const tuoiDoi = (s.ageMin !== null && s.ageMin !== targeting.age_min) || (s.ageMax !== null && s.ageMax !== targeting.age_max);
  if (s.ageMin !== null) targeting.age_min = s.ageMin;
  if (s.ageMax !== null) targeting.age_max = s.ageMax;
  if (tuoiDoi && targeting.targeting_automation && typeof targeting.targeting_automation === "object") {
    const ta = { ...(targeting.targeting_automation as Record<string, unknown>) };
    if (ta.advantage_audience === 1) ta.advantage_audience = 0;
    targeting.targeting_automation = ta;
  }
  if (s.gender === "ALL") delete targeting.genders;
  else if (s.gender === "FEMALE") targeting.genders = [2];
  else if (s.gender === "MALE") targeting.genders = [1];

  out.adset.targeting = targeting;

  const specPage = out.objectStorySpec && typeof out.objectStorySpec.page_id === "string" ? out.objectStorySpec.page_id : "";
  if (out.objectStorySpec && specPage && specPage !== s.pageId) {
    delete out.objectStorySpec.instagram_user_id;
    delete out.objectStorySpec.instagram_actor_id;
  }

  if (s.objective === "MESSAGES" || s.objective === "REACH") {
    out.adset.optimizationGoal = s.objective === "MESSAGES" ? "CONVERSATIONS" : "REACH";
    out.adset.billingEvent = "IMPRESSIONS";
    out.adset.destinationType = s.objective === "MESSAGES" ? "MESSENGER" : null;
    out.adset.bidStrategy = "LOWEST_COST_WITHOUT_CAP";
    out.adset.bidAmount = null;
    out.adset.promotedObject = { page_id: s.pageId };
    if (out.campaign) out.campaign = { ...out.campaign, objective: s.objective === "MESSAGES" ? "OUTCOME_ENGAGEMENT" : "OUTCOME_AWARENESS" };
  } else if (out.adset.promotedObject && typeof out.adset.promotedObject.page_id === "string") {
    out.adset.promotedObject = { ...out.adset.promotedObject, page_id: s.pageId };
  }
  return out;
}

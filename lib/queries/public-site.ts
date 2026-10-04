import { env } from "@/lib/env";
import { DEFAULT_PLAN_KEY, listPlans } from "@/lib/entitlements/check";
import { parseLimits } from "@/lib/entitlements/kinds";
import { signupMode } from "@/lib/onboarding/service";
import type { SignupMode } from "@/lib/onboarding/shared";

/**
 * DỮ LIỆU CỦA TRANG GIỚI THIỆU CÔNG KHAI (`/gioi-thieu`, phục vụ tại `/` của tên miền gốc).
 *
 * Chỉ đọc HAI thứ của nền tảng, không một dòng dữ liệu khách nào:
 *  · chế độ đăng ký đang có hiệu lực — để nút «Đăng ký» nói đúng điều sẽ xảy ra khi bấm (mở · cần mã mời · tạm đóng);
 *  · gói cước trong `platform_plans` — giá in trên trang LÀ giá người vận hành đặt ở `/platform`, không gõ lại số nào ở
 *    đây (gõ lại là mở đường cho trang giới thiệu nói một giá, hoá đơn nói giá khác).
 *
 * Đọc lỗi thì trang vẫn dựng: chế độ đăng ký `null` = CHƯA BIẾT (nút trung tính, không khẳng định mở hay đóng), danh sách
 * gói rỗng = ẩn bảng giá — không bao giờ in một giá đoán.
 */

export type PublicPlan = {
  key: string;
  name: string;
  description: string | null;
  /** Giá một tháng; `null` ở gói khởi điểm = gói không bán, KHÔNG phải 0 ₫. */
  priceVnd: number | null;
  /** `undefined` = gói chưa khai hạn mức đó — trang không in dòng ấy. `null` = không giới hạn. */
  users: number | null | undefined;
  records: number | null | undefined;
  storageMb: number | null | undefined;
  /** Trả 12 tháng được tặng thêm bao nhiêu tháng (`platform_plans.yearly_free_months`); 0 = không có ưu đãi. */
  yearlyFreeMonths: number;
  /** Gói có hạn mức AI dùng chung cho trợ lý chat (`limits.ai.platformCreditUsdPerMonth > 0`, 0194). Đọc từ dữ liệu gói. */
  aiIncluded: boolean;
};

export type PublicSiteData = {
  signup: SignupMode | null;
  signupUrl: string;
  loginUrl: string;
  /** Gói tổ chức tự đăng ký bắt đầu ở đó (`trial`), nếu nền tảng còn khai nó. */
  starterPlan: PublicPlan | null;
  /** Gói đang bán (có giá), theo thứ tự người vận hành xếp. */
  plans: PublicPlan[];
};

/** Gói có kèm credit AI dùng chung không — đọc `limits.ai.platformCreditUsdPerMonth`, thiếu / sai kiểu ⇒ không. */
function planIncludesAi(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const ai = (raw as Record<string, unknown>).ai;
  if (!ai || typeof ai !== "object") return false;
  const credit = (ai as Record<string, unknown>).platformCreditUsdPerMonth;
  return typeof credit === "number" && credit > 0;
}

function toPublicPlan(row: Awaited<ReturnType<typeof listPlans>>[number]): PublicPlan {
  const { limits, undeclared } = parseLimits(row.limits);
  const pick = (k: "users" | "records" | "storageMb") => (undeclared.includes(k) ? undefined : limits[k]);
  return { key: row.key, name: row.name, description: row.description, priceVnd: row.priceVnd, users: pick("users"), records: pick("records"), storageMb: pick("storageMb"), yearlyFreeMonths: row.yearlyFreeMonths, aiIncluded: planIncludesAi(row.limits) };
}

export async function getPublicSiteData(): Promise<PublicSiteData> {
  const [signup, rows] = await Promise.all([signupMode().catch(() => null), listPlans().catch(() => [])]);
  const base = env.appUrl;
  return {
    signup,
    signupUrl: `${base}/start`,
    loginUrl: `${base}/login`,
    starterPlan: (() => {
      const row = rows.find((r) => r.key === DEFAULT_PLAN_KEY);
      return row ? toPublicPlan(row) : null;
    })(),
    plans: rows.filter((r) => typeof r.priceVnd === "number" && r.priceVnd > 0).map(toPublicPlan),
  };
}

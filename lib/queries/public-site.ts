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

function toPublicPlan(row: Awaited<ReturnType<typeof listPlans>>[number]): PublicPlan {
  const { limits, undeclared } = parseLimits(row.limits);
  const pick = (k: "users" | "records" | "storageMb") => (undeclared.includes(k) ? undefined : limits[k]);
  return { key: row.key, name: row.name, description: row.description, priceVnd: row.priceVnd, users: pick("users"), records: pick("records"), storageMb: pick("storageMb") };
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

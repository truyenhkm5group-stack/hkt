/**
 * ═══════════ ĐĂNG KÝ NHANH MỘT MÀN HÌNH — PHẦN THUẦN, client-safe (docs/platform/quick-start.md) ═══════════
 *
 * Trước: 7 bước, 8 cú bấm, 6 ô gõ (mã mời · tên + MÃ tổ chức · tên + email + mật khẩu + nhập lại · loại hình · mẫu ·
 * module · xem trước). Sau: MỘT màn hình — tên cửa hàng, ngành hàng, SĐT, email, mật khẩu (hoặc một nút Google /
 * Facebook thay cho hai ô cuối). Mọi thứ còn lại MÁY tự chọn từ ngành hàng, theo đúng gợi ý mà trình hướng dẫn đầy đủ vẫn
 * gợi ý — và vẫn đi qua ĐÚNG lõi tạo tổ chức (`createOrganizationFromSignup`): cờ đăng ký, mã mời, trần theo IP, xem
 * trước kế hoạch, hạn mức gói. Trình hướng dẫn đầy đủ còn nguyên cho người muốn tự chọn mẫu / module.
 */
import { z } from "zod";
import { ADMIN_PASSWORD_MIN, BUSINESS_TYPE_SPEC, RESERVED_ORG_CODES, type BusinessType } from "@/lib/onboarding/shared";

/** Ngành hàng hiện ở form nhanh — những ngành có MẪU dựng sẵn và bán qua Fanpage. Ngành khác: trình hướng dẫn đầy đủ. */
export const QUICK_BUSINESS_TYPES = ["food", "seafood", "fashion", "spa", "restaurant", "ecommerce"] as const satisfies readonly BusinessType[];
export type QuickBusinessType = (typeof QUICK_BUSINESS_TYPES)[number];

export const QUICK_BUSINESS_LABEL: Record<QuickBusinessType, string> = {
  food: "Thực phẩm, đặc sản",
  seafood: "Hải sản lẻ + sỉ",
  fashion: "Thời trang",
  spa: "Spa, làm đẹp",
  restaurant: "Nhà hàng, quán ăn",
  ecommerce: "Bán lẻ online khác",
};

export const quickSignupZ = z.object({
  storeName: z.string().trim().min(2, "Tên cửa hàng ít nhất 2 ký tự").max(120, "Tên cửa hàng tối đa 120 ký tự"),
  businessType: z.enum(QUICK_BUSINESS_TYPES, { error: "Chọn ngành hàng" }),
  phone: z.string().trim().max(30),
  email: z.string().trim().max(200).optional().default(""),
  password: z.string().max(200).optional().default(""),
  invite: z.string().trim().max(80).optional().nullable(),
});
export type QuickSignupInput = z.input<typeof quickSignupZ>;

/** Mã tổ chức GỐC từ tên cửa hàng: bỏ dấu, chữ thường, gạch nối, ≤ 24 ký tự, bắt đầu bằng chữ, không trùng mã dành riêng. */
export function orgCodeBase(storeName: string): string {
  const slug = storeName
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
  let base = /^[a-z]/.test(slug) ? slug : `shop-${slug}`.replace(/-+$/g, "");
  if (base.length < 2) base = "shop";
  if ((RESERVED_ORG_CODES as readonly string[]).includes(base)) base = `${base}-shop`;
  return base;
}

/** Những mã thử lần lượt khi mã gốc đã có người dùng: gốc, gốc-2 … gốc-9 (đuôi ngẫu nhiên do máy chủ thêm sau cùng). */
export function orgCodeCandidates(base: string): string[] {
  return [base, ...Array.from({ length: 8 }, (_, i) => `${base.slice(0, 28)}-${i + 2}`)];
}

export function quickBusinessHint(t: QuickBusinessType): string {
  return BUSINESS_TYPE_SPEC[t].hint;
}

export { ADMIN_PASSWORD_MIN };

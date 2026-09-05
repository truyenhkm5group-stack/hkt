/** Chăm sóc khách băn khoăn chưa mua & bán chéo cho khách đã nhận hàng (settings "outreach.config") */
export type OutreachConfig = {
  shopName: string;
  /** Mã giảm giá / ưu đãi chèn vào tin (tuỳ chọn) */
  discountCode: string;
  /** Khách nhắn trong N ngày gần đây mà chưa có đơn → băn khoăn chưa mua */
  nurtureDays: number;
  /** Bán chéo: đơn giao thành công từ N1 đến N2 ngày trước */
  crossSellFromDays: number;
  crossSellToDays: number;
  /** Không nhắn lại cùng một khách trong N ngày */
  cooldownDays: number;
  /** Giới hạn gửi mỗi ngày */
  dailyLimit: number;
  /** Gợi ý bán chéo theo mã hàng đã mua (productId → productIds); trống = lấy top bán chạy chưa mua */
  crossSellMap: Record<string, string[]>;
  nurtureTemplate: string;
  crossSellTemplate: string;
};

export const OUTREACH_KEY = "outreach.config";

export const DEFAULT_OUTREACH: OutreachConfig = {
  shopName: "Hải An Fashion",
  discountCode: "",
  nurtureDays: 2,
  crossSellFromDays: 3,
  crossSellToDays: 14,
  cooldownDays: 14,
  dailyLimit: 200,
  crossSellMap: {},
  nurtureTemplate:
    "Chào {ten} ơi, em thấy mình còn băn khoăn về {san_pham} nên nhắn hỏi thăm ạ 💛 Mình cần thêm ảnh thật, tư vấn size hay chính sách đổi trả thì cứ nhắn em nhé. Shop hỗ trợ đổi size miễn phí và kiểm tra hàng trước khi thanh toán ạ.{uu_dai}",
  crossSellTemplate:
    "Chào {ten} ơi, {shop} cảm ơn mình đã tin tưởng đặt {san_pham} ạ 💛 Mình mặc có vừa và ưng ý không ạ? Mẫu này đang được nhiều chị kết hợp cùng {goi_y}. Mình nhắn em để giữ size sớm nhé.{uu_dai}",
};

export const SEGMENT_LABEL: Record<string, string> = { NURTURE: "Băn khoăn chưa mua", CROSS_SELL: "Bán chéo sau nhận hàng" };
export const OUTREACH_STATUS_LABEL: Record<string, string> = { PENDING: "Chờ gửi", SENT: "Đã gửi", FAILED: "Lỗi", SKIPPED: "Bỏ qua" };
export const OUTREACH_STATUS_TONE: Record<string, string> = {
  PENDING: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  SENT: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  FAILED: "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
  SKIPPED: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
};

/** Ghép mẫu tin: {ten} {san_pham} {goi_y} {shop} {uu_dai} */
export function renderTemplate(template: string, vars: { ten: string; san_pham: string; goi_y: string; shop: string; discountCode: string }) {
  const uuDai = vars.discountCode ? ` Mình nhập mã ${vars.discountCode} để được ưu đãi cho đơn tiếp theo nhé.` : "";
  return template
    .replace(/\{ten\}/g, vars.ten || "chị")
    .replace(/\{san_pham\}/g, vars.san_pham || "sản phẩm bên em")
    .replace(/\{goi_y\}/g, vars.goi_y || "các mẫu mới của shop")
    .replace(/\{shop\}/g, vars.shop || "shop")
    .replace(/\{uu_dai\}/g, uuDai)
    .replace(/\s+\n/g, "\n")
    .trim();
}

/** Tên gọi thân mật từ tên đầy đủ ("Nguyễn Thị Lan" → "chị Lan") */
export function shortName(fullName: string) {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (!parts.length || /^khach hang/i.test(fullName.normalize("NFD").replace(/[̀-ͯ]/g, ""))) return "chị";
  return `chị ${parts[parts.length - 1]}`;
}

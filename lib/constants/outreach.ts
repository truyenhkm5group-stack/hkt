/** Chăm sóc khách băn khoăn chưa mua & bán chéo cho khách đã nhận hàng (settings "outreach.config") */
export type OutreachConfig = {
  shopName: string;
  /** Mã giảm giá / ưu đãi chèn vào tin qua biến {uu_dai} (tuỳ chọn) */
  discountCode: string;
  /** Ưu đãi chốt nhanh trong kịch bản băn khoăn, biến {giam} (VD "50k/váy") */
  nurtureDiscount: string;
  /** Cửa sổ băn khoăn: khách nhắn trong N giờ gần đây (24 = 1 ngày, 168 = 7 ngày) mà chưa có đơn */
  nurtureWindowHours: number;
  /** @deprecated dùng nurtureWindowHours; giữ để đọc cấu hình cũ */
  nurtureDays?: number;
  /** Kịch bản băn khoăn nhiều bước: mỗi bước một tin, cách nhau nurtureStepGapDays ngày */
  nurtureSteps: string[];
  nurtureStepGapDays: number;
  /** Bán chéo: đơn giao thành công từ N1 đến N2 ngày trước */
  crossSellFromDays: number;
  crossSellToDays: number;
  /** Không nhắn lại cùng một khách trong N ngày sau khi kết thúc kịch bản */
  cooldownDays: number;
  /** Giới hạn gửi mỗi ngày */
  dailyLimit: number;
  /** Gợi ý bán chéo theo mã hàng đã mua (productId → productIds); trống = lấy top bán chạy chưa mua */
  crossSellMap: Record<string, string[]>;
  /** Ảnh / video gửi kèm theo mã hàng gợi ý (productId → URL công khai); trống = dùng ảnh sản phẩm từ Pancake */
  crossSellMedia: Record<string, string[]>;
  /** Gửi kèm ảnh sản phẩm gợi ý trong tin bán chéo */
  attachProductImages: boolean;
  /** Số ảnh/video tối đa gửi kèm mỗi khách */
  maxMediaPerMessage: number;
  /** Ưu đãi khách cũ mua thêm mẫu khác (biến {giam}) */
  crossSellDiscount: string;
  /** Ưu đãi "giá siêu hời" cho mã hoàn cao & tồn nhiều (biến {giam}) */
  clearanceDiscount: string;
  /** Mã được coi là cần xả: tỷ lệ hoàn ≥ N% VÀ tồn đủ bán ≥ M ngày (hoặc nằm trong danh sách chọn tay) */
  clearanceReturnRatePct: number;
  clearanceStockDays: number;
  clearanceProductIds: string[];
  /** Mẫu tin bán chéo khi gợi ý là mã xả (giá siêu hời) */
  crossSellClearanceTemplate: string;
  /** @deprecated bước 1 cũ; giữ để đọc cấu hình cũ */
  nurtureTemplate?: string;
  crossSellTemplate: string;
};

export const OUTREACH_KEY = "outreach.config";

/** Kịch bản băn khoăn mặc định (7 ngày, mỗi ngày một tin) — theo kịch bản chốt đơn của shop */
export const DEFAULT_NURTURE_STEPS: string[] = [
  "Chị yêu ơi,\nChúc mừng chị đã là 1 trong 10 khách hàng được chọn ngẫu nhiên nhận ưu đãi dành riêng cho người may mắn nhất trong ngày!\nNếu chị chốt đơn trước 24h hôm nay, em sẽ giảm ngay {giam} cho chị nha.\nĐừng bỏ lỡ cơ hội này, em sẵn sàng hỗ trợ chị lên đơn liền nha!",
  "Chị ơi, em hiểu rằng chị vẫn còn băn khoăn, nhưng em thật sự tin rằng sản phẩm này rất đáng để chị đầu tư. Chất liệu cao cấp, thiết kế tỉ mỉ từ những thợ may lành nghề với kinh nghiệm lâu năm, đảm bảo sẽ làm chị hài lòng. Chị tin thử diện 1 váy bên em, em tin sẽ làm chị hài lòng ạ!",
  "Chị ơi, mỗi mẫu váy đều là tâm huyết của {shop}, em tin chị sẽ hài lòng với chất lượng – chỉn chu từng đường kim mũi chỉ, xứng đáng với số tiền mình bỏ ra ạ. Chị chốt mẫu này để em lên đơn nha 💖",
  "Chị ơi, em hiểu mình đang cân nhắc. Chị yên tâm bên em được kiểm hàng trước khi thanh toán, nên chị cứ đặt thử 1 sản phẩm nha. Hàng tới tay nếu chị chưa ưng, mình hoàn lại cho em liền ạ 🌸",
  "Dạ chị ơi, mẫu này em còn đúng vài chiếc thôi ạ. Nếu chị cần mặc gấp hay muốn em giữ size, báo em sớm nha 💖",
  "Chị ơi, mình đang bận hay còn phân vân điểm nào để em hỗ trợ thêm cho mình ạ? 💕\nBên em luôn hỗ trợ chị:\n✔️ Xem – thử hàng trước khi thanh toán\n✔️ Đổi hàng trong 7 ngày nếu chưa ưng\n✔️ Lỗi sản phẩm, shop chịu phí ship 2 chiều\nChị mình cứ yên tâm thử giúp em 1 lần nha, bên em cam kết chất lượng và form dáng sẽ không làm mình thất vọng đâu ạ",
  "Chị ơi, em xin phép hỏi mình một chút nha 🥰 Hiện chị còn đang cân nhắc mẫu này hay mình đã chọn được mẫu khác rồi ạ? Chị chia sẻ để em tư vấn đúng nhu cầu cho mình, đỡ mất thời gian của chị nha ❤️",
];

export const DEFAULT_OUTREACH: OutreachConfig = {
  shopName: "Hải An Fashion",
  discountCode: "",
  nurtureDiscount: "50k/váy",
  nurtureWindowHours: 168,
  nurtureSteps: DEFAULT_NURTURE_STEPS,
  nurtureStepGapDays: 1,
  crossSellFromDays: 3,
  crossSellToDays: 14,
  cooldownDays: 14,
  dailyLimit: 200,
  crossSellMap: {},
  crossSellMedia: {},
  attachProductImages: true,
  maxMediaPerMessage: 3,
  crossSellDiscount: "50K",
  clearanceDiscount: "100K",
  clearanceReturnRatePct: 35,
  clearanceStockDays: 45,
  clearanceProductIds: [],
  crossSellTemplate:
    "Chào {ten} ơi, {shop} cảm ơn mình đã tin tưởng đặt {san_pham} ạ 💛 Mình mặc có vừa và ưng ý không ạ?\nKhách cũ của shop mua thêm mẫu khác được giảm ngay {giam} ạ. Mẫu {goi_y} đang được nhiều chị kết hợp cùng {san_pham}, em gửi ảnh thật bên dưới mình xem nhé. Mình chốt em giữ size sớm ạ 💛{uu_dai}",
  crossSellClearanceTemplate:
    "Chào {ten} ơi, {shop} cảm ơn mình đã tin tưởng đặt {san_pham} ạ 💛 Mình mặc có vừa và ưng ý không ạ?\nShop đang có mẫu {goi_y} giá siêu hời, riêng khách cũ như mình được giảm thêm {giam} ạ. Em gửi ảnh/video thật bên dưới, mình xem ưng thì báo em giữ size ngay nhé, số lượng có hạn ạ 🔥{uu_dai}",
};

export const NURTURE_WINDOWS = [
  { hours: 24, label: "24 giờ" },
  { hours: 168, label: "7 ngày" },
] as const;

export const OFFER_LABEL: Record<string, string> = { STANDARD: "Khách cũ giảm", CLEARANCE: "Giá siêu hời · xả" };

export const SEGMENT_LABEL: Record<string, string> = { NURTURE: "Băn khoăn chưa mua", CROSS_SELL: "Bán chéo sau nhận hàng" };
export const OUTREACH_STATUSES = ["PENDING", "SENT", "FAILED", "SKIPPED", "CONVERTED", "REPLIED"] as const;
export const OUTREACH_STATUS_LABEL: Record<string, string> = { PENDING: "Chờ gửi", SENT: "Đã gửi hết", FAILED: "Lỗi", SKIPPED: "Bỏ qua", CONVERTED: "Đã mua", REPLIED: "Khách đã trả lời" };
export const OUTREACH_STATUS_TONE: Record<string, string> = {
  PENDING: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  SENT: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  FAILED: "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
  SKIPPED: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  CONVERTED: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  REPLIED: "bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
};

export type TemplateVars = { ten: string; san_pham: string; goi_y: string; shop: string; discountCode: string; giam?: string };

/** Ghép mẫu tin: {ten} {san_pham} {goi_y} {shop} {uu_dai} {giam} */
export function renderTemplate(template: string, vars: TemplateVars) {
  const uuDai = vars.discountCode ? ` Mình nhập mã ${vars.discountCode} để được ưu đãi cho đơn tiếp theo nhé.` : "";
  return template
    .replace(/\{ten\}/g, vars.ten || "chị")
    .replace(/\{san_pham\}/g, vars.san_pham || "sản phẩm bên em")
    .replace(/\{goi_y\}/g, vars.goi_y || "các mẫu mới của shop")
    .replace(/\{shop\}/g, vars.shop || "shop")
    .replace(/\{giam\}/g, vars.giam || "ưu đãi riêng")
    .replace(/\{uu_dai\}/g, uuDai)
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/** Tên gọi thân mật từ tên đầy đủ ("Nguyễn Thị Lan" → "chị Lan") */
export function shortName(fullName: string) {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (!parts.length || /^khach hang/i.test(fullName.normalize("NFD").replace(/[̀-ͯ]/g, ""))) return "chị";
  return `chị ${parts[parts.length - 1]}`;
}

/** Mục đã đến hạn gửi chưa (PENDING và nextAt ≤ bây giờ) */
export function isDue(row: { status: string; nextAt: Date | string | null }, now = Date.now()) {
  return row.status === "PENDING" && (!row.nextAt || new Date(row.nextAt).getTime() <= now);
}

/** Chuẩn hoá cấu hình cũ → mới (nurtureDays / nurtureTemplate) */
export function normalizeOutreachConfig(raw: Partial<OutreachConfig> | null | undefined): OutreachConfig {
  const cfg = { ...DEFAULT_OUTREACH, ...(raw ?? {}) };
  if (!raw?.nurtureWindowHours && raw?.nurtureDays) cfg.nurtureWindowHours = Math.max(24, raw.nurtureDays * 24);
  if (!raw?.nurtureSteps?.length) cfg.nurtureSteps = raw?.nurtureTemplate ? [raw.nurtureTemplate, ...DEFAULT_NURTURE_STEPS.slice(1)] : DEFAULT_NURTURE_STEPS;
  cfg.nurtureSteps = cfg.nurtureSteps.map((s) => s.trim()).filter(Boolean);
  if (!cfg.nurtureSteps.length) cfg.nurtureSteps = DEFAULT_NURTURE_STEPS;
  cfg.crossSellMap = cfg.crossSellMap ?? {};
  cfg.crossSellMedia = cfg.crossSellMedia ?? {};
  cfg.attachProductImages = cfg.attachProductImages !== false;
  cfg.maxMediaPerMessage = Math.min(6, Math.max(1, Number(cfg.maxMediaPerMessage) || 3));
  cfg.clearanceProductIds = Array.isArray(cfg.clearanceProductIds) ? cfg.clearanceProductIds : [];
  cfg.crossSellDiscount = cfg.crossSellDiscount || "50K";
  cfg.clearanceDiscount = cfg.clearanceDiscount || "100K";
  if (!cfg.crossSellClearanceTemplate) cfg.crossSellClearanceTemplate = DEFAULT_OUTREACH.crossSellClearanceTemplate;
  // mẫu bán chéo cũ (trước khi có ưu đãi khách cũ) → thay bằng mẫu mới có {giam}
  if (cfg.crossSellTemplate && !/\{giam\}/.test(cfg.crossSellTemplate) && /Mẫu này đang được nhiều chị kết hợp cùng/.test(cfg.crossSellTemplate)) cfg.crossSellTemplate = DEFAULT_OUTREACH.crossSellTemplate;
  cfg.nurtureStepGapDays = Math.max(1, Number(cfg.nurtureStepGapDays) || 1);
  return cfg;
}

/** URL có phải video (để hiển thị đúng và gửi đúng kiểu) */
export function isVideoUrl(url: string) {
  return /\.(mp4|mov|m4v|webm)(\?|$)/i.test(url) || /youtube\.com|youtu\.be|facebook\.com\/.*\/videos|fb\.watch|tiktok\.com/i.test(url);
}

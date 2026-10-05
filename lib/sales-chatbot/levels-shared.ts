/**
 * ═══════════ LEVEL KHÁCH TRONG HỘI THOẠI — PHẦN THUẦN (client import được) ═══════════
 *
 * Chủ shop 06/10/2026 (áp dụng cho MỌI tổ chức SaaS AI bán hàng): «Tự động thêm level khách và cho phép lọc theo level khách
 * để AI sales agent phân loại và gửi kịch bản chat tương ứng với từng level» — ví dụ thời trang: Ấn gửi tin nhắn · Cho số đo ·
 * Chọn mẫu · Cho đủ SĐT + địa chỉ, đủ thông tin đơn · Cho đủ SĐT + địa chỉ, thiếu thông tin đơn · Cho SĐT, thiếu địa chỉ ·
 * Cho địa chỉ, thiếu SĐT · Phản hồi upsell / cross-sell.
 *
 * Level là PHÉP ĐỌC trên dữ liệu hội thoại đã có (tin khách, sổ trạng thái bot, đơn) — KHÔNG gọi AI, chạy lại ra cùng kết quả,
 * nên lọc / đếm / kịch bản đều đứng trên cùng một hàm. Danh sách ĐÓNG; ngành nào không có khái niệm thì level ấy không hiện
 * (ngành thực phẩm không có «Cho số đo»). Nhận ra SĐT / địa chỉ / món bằng dấu hiệu chữ — không chắc thì xếp level THẤP hơn,
 * không bao giờ nâng level bằng đoán.
 */

export const CUSTOMER_LEVELS = ["ORDERED", "UPSELL_REPLY", "FULL_INFO_ORDER", "FULL_INFO_NO_ITEM", "PHONE_ONLY", "ADDRESS_ONLY", "PICKED_ITEM", "MEASUREMENTS", "NEW_MESSAGE", "DECLINED"] as const;
export type CustomerLevel = (typeof CUSTOMER_LEVELS)[number];

export const CUSTOMER_LEVEL_LABEL: Record<CustomerLevel, string> = {
  NEW_MESSAGE: "Ấn gửi tin nhắn",
  MEASUREMENTS: "Cho số đo",
  PICKED_ITEM: "Chọn mẫu / món",
  FULL_INFO_ORDER: "Đủ SĐT + địa chỉ · đủ thông tin đơn",
  FULL_INFO_NO_ITEM: "Đủ SĐT + địa chỉ · thiếu thông tin đơn",
  PHONE_ONLY: "Cho SĐT · thiếu địa chỉ",
  ADDRESS_ONLY: "Cho địa chỉ · thiếu SĐT",
  UPSELL_REPLY: "Phản hồi upsell / cross-sell",
  ORDERED: "Đã chốt đơn",
  DECLINED: "Từ chối",
};

/** Thứ tự hiện (theo phễu, từ đầu tới cuối). */
export const CUSTOMER_LEVEL_FUNNEL: readonly CustomerLevel[] = ["NEW_MESSAGE", "MEASUREMENTS", "PICKED_ITEM", "PHONE_ONLY", "ADDRESS_ONLY", "FULL_INFO_NO_ITEM", "FULL_INFO_ORDER", "UPSELL_REPLY", "ORDERED", "DECLINED"];

/** Màu chip (lớp Tailwind ĐÓNG) — nóng dần theo phễu. */
export const CUSTOMER_LEVEL_CLASS: Record<CustomerLevel, string> = {
  NEW_MESSAGE: "bg-zinc-200 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-100",
  MEASUREMENTS: "bg-sky-100 text-sky-900 dark:bg-sky-950/60 dark:text-sky-100",
  PICKED_ITEM: "bg-blue-100 text-blue-900 dark:bg-blue-950/60 dark:text-blue-100",
  PHONE_ONLY: "bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-100",
  ADDRESS_ONLY: "bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-100",
  FULL_INFO_NO_ITEM: "bg-orange-100 text-orange-900 dark:bg-orange-950/60 dark:text-orange-100",
  FULL_INFO_ORDER: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-100",
  UPSELL_REPLY: "bg-violet-100 text-violet-900 dark:bg-violet-950/60 dark:text-violet-100",
  ORDERED: "bg-green-600 text-white dark:bg-green-500 dark:text-black",
  DECLINED: "bg-rose-100 text-rose-900 dark:bg-rose-950/60 dark:text-rose-100",
};

export type LevelPack = "food" | "fashion" | "generic";

/** Level có nghĩa với ngành của tổ chức (gói ngành của bot — `salesPackFor`). */
export function levelsForPack(pack: LevelPack): CustomerLevel[] {
  return CUSTOMER_LEVEL_FUNNEL.filter((l) => l !== "MEASUREMENTS" || pack === "fashion");
}

// ─────────────────────────── DẤU HIỆU TRONG CHỮ ───────────────────────────

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase();

const PHONE_RE = /(?:\+?84|0)(?:[\s.-]?\d){8,10}/;
/** Từ chỉ địa chỉ MẠNH (đã bỏ dấu): «đường», «phường», «xã», «quận», «huyện», «thôn», «ấp», «ngõ», «hẻm», «tỉnh», «TP»… */
const ADDRESS_STRONG_RE = /\b(so nha|duong|phuong|xa |thi tran|quan \w|huyen|thon|ap \w|to dan pho|ngo |ngach|hem|kiet|khu pho|tinh |thanh pho|tp\.?\s?\w|kdc|chung cu|toa nha|kcn)/;
/** Dấu YẾU — một mình không đủ («mẫu số 3» không phải địa chỉ): «số 12», «p.5», «q3». Cần hai dấu yếu. */
const ADDRESS_WEAK_RE = /\b(so \d+|p\.?\s?\d{1,2}|q\.?\s?\d{1,2})\b/g;
/** Số đo cơ thể (thời trang): «cao 1m60», «nặng 50kg», «vòng eo 68», «1m6 50kg», «160cm». */
const MEASURE_RE = /\b(cao|nang|vong|eo|nguc|mong|bung)\s*:?\s*\d|\b1m\d{1,2}\b|\b1[4-9]\d\s?cm\b|\b\d{2,3}\s?kg\b.*\b(cao|1m\d)|\b(1m\d{1,2}|cao).*\b\d{2,3}\s?(kg|ky|can)\b/;
/** Khách nói MÓN / MẪU / SỐ LƯỢNG: «lấy 2kg», «size M», «mẫu số 3», «màu đen», «cho chị 1 bộ». */
const ITEM_RE = /\b(\d+(?:[.,]\d+)?\s?(kg|ky|ki|can|cai|bo|hop|tui|chiec|doi|goi|lo|set|thung|hu|phan|suat)\b|size\s?[smlx0-9]|mau (so )?\d|ma (so )?\d|mau (den|trang|do|xanh|vang|hong|nau|be|xam|tim|kem)|lay (1|2|3|mot|hai|ba)|nua ky|nua kg)/;
const DECLINE_RE = /\b(khong (mua|lay|can) nua|thoi khong|huy don|khong lay dau|de sau|khi khac)\b/;

/** Chữ có SĐT không. HÀM THUẦN. */
export function textHasPhone(text: string): boolean {
  return PHONE_RE.test(text);
}

/** Chữ có giống địa chỉ không — một dòng đủ dài mang từ chỉ địa chỉ. HÀM THUẦN. */
export function textHasAddress(text: string): boolean {
  const f = ` ${fold(text).replace(/\s+/g, " ")} `;
  if (f.trim().length < 12) return false;
  return ADDRESS_STRONG_RE.test(f) || (f.match(ADDRESS_WEAK_RE)?.length ?? 0) >= 2;
}

export function textHasMeasurements(text: string): boolean {
  return MEASURE_RE.test(fold(text));
}

/** Cụm số đo cơ thể («nặng 50kg», «cao 1m60», «vòng eo 68») — bỏ đi trước khi tìm món, kẻo «50kg» thành «lấy 50kg». */
const MEASURE_PHRASE_RE = /\b(can nang|nang|cao|vong \w+|eo|nguc|mong|bung)\s*:?\s*\d+(?:[.,]\d+)?\s?(kg|ky|can|cm|m\d*)?|\b1m\d{1,2}\b|\b1[4-9]\d\s?cm\b/g;

export function textHasItem(text: string): boolean {
  return ITEM_RE.test(fold(text).replace(MEASURE_PHRASE_RE, " "));
}

// ─────────────────────────── PHÂN LOẠI ───────────────────────────

export type LevelInput = {
  pack: LevelPack;
  /** Tin của KHÁCH trong lượt mua đang xét (sau đơn gần nhất), cũ → mới. */
  customerTexts: readonly string[];
  /** Sổ trạng thái bot: SĐT / địa chỉ khách đã cho, giỏ / nháp, bước bán. */
  statePhone: boolean;
  stateAddress: boolean;
  stateItems: boolean;
  stage: string | null;
  /** Có đơn còn sống tạo trong lượt mua này (bot chốt / máy ghi / người tạo). */
  hasOpenOrder: boolean;
  /** Khách nhắn SAU câu upsell / cross-sell của bot (bước UPSELL). */
  repliedAfterUpsell: boolean;
};

/**
 * Level của khách — mức CAO NHẤT đạt được, theo thứ tự: đã chốt đơn → phản hồi upsell → đủ SĐT + địa chỉ (+ món?) → chỉ
 * SĐT / chỉ địa chỉ → chọn mẫu → cho số đo (thời trang) → từ chối → mới nhắn. HÀM THUẦN.
 */
export function classifyCustomerLevel(i: LevelInput): CustomerLevel {
  if (i.hasOpenOrder) return "ORDERED";
  const joined = i.customerTexts.join("\n");
  const phone = i.statePhone || i.customerTexts.some(textHasPhone);
  const address = i.stateAddress || i.customerTexts.some((t) => textHasAddress(t.replace(PHONE_RE, " ")));
  const item = i.stateItems || i.customerTexts.some(textHasItem);
  if (i.stage === "UPSELL" && i.repliedAfterUpsell) return "UPSELL_REPLY";
  if (phone && address) return item ? "FULL_INFO_ORDER" : "FULL_INFO_NO_ITEM";
  if (phone) return "PHONE_ONLY";
  if (address) return "ADDRESS_ONLY";
  if (item) return "PICKED_ITEM";
  if (i.pack === "fashion" && i.customerTexts.some(textHasMeasurements)) return "MEASUREMENTS";
  if (i.stage === "DECLINED" || DECLINE_RE.test(fold(joined))) return "DECLINED";
  return "NEW_MESSAGE";
}

export function parseCustomerLevel(v: unknown): CustomerLevel | null {
  return typeof v === "string" && (CUSTOMER_LEVELS as readonly string[]).includes(v) ? (v as CustomerLevel) : null;
}

// ─────────────────────────── KỊCH BẢN THEO LEVEL ───────────────────────────

export const LEVEL_SCRIPTS_SETTING_KEY = "ai.salesChatbot.levelScripts";
export const LEVEL_SCRIPT_MAX = 600;

/** Kịch bản theo level do shop viết (chữ hướng dẫn cho bot, không phải câu gửi nguyên văn). Thiếu ⇒ không thêm gì. */
export type LevelScripts = Partial<Record<CustomerLevel, string>>;

export function parseLevelScripts(raw: unknown): LevelScripts {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: LevelScripts = {};
  for (const l of CUSTOMER_LEVELS) {
    const v = o[l];
    if (typeof v === "string" && v.trim()) out[l] = v.trim().slice(0, LEVEL_SCRIPT_MAX);
  }
  return out;
}

/** Gợi ý mặc định khi shop chưa viết — để ô soạn không trống trơn (KHÔNG tự dùng: bot chỉ đọc kịch bản shop đã lưu). */
export const LEVEL_SCRIPT_HINT: Record<CustomerLevel, string> = {
  NEW_MESSAGE: "Chào khách, hỏi đúng nhu cầu, báo giá ngắn gọn và hỏi một câu dễ trả lời.",
  MEASUREMENTS: "Dựa số đo tư vấn size cụ thể, gợi ý 1–2 mẫu hợp dáng, hỏi khách chọn mẫu nào.",
  PICKED_ITEM: "Khẳng định lựa chọn của khách, xin SĐT + địa chỉ để lên đơn.",
  PHONE_ONLY: "Cảm ơn khách đã để số, xin địa chỉ nhận hàng (thôn / xã / tỉnh).",
  ADDRESS_ONLY: "Cảm ơn khách, xin số điện thoại nhận hàng.",
  FULL_INFO_NO_ITEM: "Khách đã đủ SĐT + địa chỉ: xác nhận món + số lượng để lên đơn ngay.",
  FULL_INFO_ORDER: "Tóm tắt đơn (món, số lượng, tiền, địa chỉ) và gợi ý thêm một món đi kèm.",
  UPSELL_REPLY: "Chốt phần khách vừa đồng ý thêm, tóm tắt lại tổng tiền.",
  ORDERED: "Cảm ơn khách, báo thời gian giao dự kiến, không chào bán lại.",
  DECLINED: "Tôn trọng quyết định, để lại lời mời nhẹ nhàng, không nài ép.",
};

/** Dòng thêm vào lời nhắc của bot cho level hiện tại — '' khi shop chưa viết kịch bản cho level đó. HÀM THUẦN. */
export function levelScriptPrompt(level: CustomerLevel | null, scripts: LevelScripts): string {
  if (!level) return "";
  const s = scripts[level];
  return s ? `KỊCH BẢN THEO LEVEL KHÁCH — khách đang ở level «${CUSTOMER_LEVEL_LABEL[level]}»: ${s}` : "";
}

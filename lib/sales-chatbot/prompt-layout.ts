import { getSettingJson } from "@/lib/settings";

/**
 * ═══════════ THỨ TỰ KHỐI LỜI NHẮC HỆ THỐNG CỦA BOT BÁN HÀNG — ĐỆM TIỀN TỐ (AI Sales GĐ3, quyết định lead 22/10/2026) ═══════════
 *
 * Nhà cung cấp AI đệm (cache) lời nhắc theo TIỀN TỐ: phần đầu giống hệt lượt trước thì đọc từ đệm, rẻ hơn ~10 lần. Bản cũ (LEGACY) xếp
 * khối KHÁCH CŨ ngay sau luật — trước câu mẫu, kiến thức, sổ tay — và Customer 360 trước bài học, nên tiền tố vỡ theo TỪNG khách và
 * gần như cả lời nhắc tĩnh (~12.900 ký tự) bị tính đủ giá ở mỗi lượt.
 *
 * CACHE_FIRST xếp lại ĐÚNG các khối ấy theo độ bền: TĨNH (luật · câu mẫu · sổ tay · bài học — đổi khi shop sửa cấu hình) → NGÀY (kiến
 * thức theo hạn khuyến mãi · đặt lịch có «hôm nay») → GIỜ (dòng THỜI GIAN) → HỘI THOẠI (khách cũ · Customer 360 · level · tên khách ·
 * đơn đã chốt) → LƯỢT (giỏ · địa chỉ · liên hệ · lời mời vừa nhận · bối cảnh). Không thêm, không bớt, không sửa một dòng: tập dòng của
 * hai cách xếp là MỘT (bài kiểm hoán vị trên bộ hội thoại vàng). Trong cùng một tầng giữ thứ tự cũ.
 *
 * Anthropic: khối TĨNH đi thành khối `system` riêng mang `cache_control` (`AiRequest.systemCacheBreak`); phần còn lại là khối thứ hai
 * không đánh dấu. Gemini / OpenAI đệm tiền tố tự động — chỉ cần thứ tự.
 *
 * CÔNG TẮC (không cần deploy): `settings` của TỔ CHỨC, khoá `sales.prompt-layout`, dạng OBJECT `{"layout":"CACHE_FIRST"}`. Thiếu khoá,
 * chuỗi trần, giá trị lạ, lỗi đọc ⇒ LEGACY (đúng lời nhắc hôm nay, từng ký tự). Đổi thứ tự là đổi hành vi model ⇒ mặc định TẮT; chỉ
 * bật theo canary của lead (bench A/A rồi A/B, HSLC ≥ 3 ngày làm việc).
 */

export const PROMPT_LAYOUT_SETTING_KEY = "sales.prompt-layout";

export const PROMPT_LAYOUTS = ["LEGACY", "CACHE_FIRST"] as const;
export type PromptLayout = (typeof PROMPT_LAYOUTS)[number];

/** Tầng của một khối, xếp theo độ bền (bền nhất trước). */
export const PROMPT_TIERS = ["STATIC", "DAY", "HOUR", "CONVERSATION", "TURN"] as const;
export type PromptTier = (typeof PROMPT_TIERS)[number];

/** Một khối lời nhắc — `text` rỗng bị bỏ như `filter(Boolean)` của bản cũ. */
export type PromptPart = { text: string; tier: PromptTier };

/** Đọc giá trị công tắc đã lưu. Chỉ OBJECT `{layout: "CACHE_FIRST"}` bật; mọi thứ khác ⇒ LEGACY. HÀM THUẦN. */
export function parsePromptLayout(raw: unknown): PromptLayout {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "LEGACY";
  return (raw as { layout?: unknown }).layout === "CACHE_FIRST" ? "CACHE_FIRST" : "LEGACY";
}

/** Ghi đè TRONG TIẾN TRÌNH cho bench A/B và bài kiểm (không ghi CSDL). `null` ⇒ đọc công tắc. */
let layoutOverride: PromptLayout | null = null;
export function setPromptLayoutOverride(layout: PromptLayout | null): void {
  layoutOverride = layout;
}

/** Cách xếp của tổ chức ngữ cảnh cho MỘT lượt. Lỗi đọc ⇒ LEGACY. */
export async function loadPromptLayout(): Promise<PromptLayout> {
  if (layoutOverride) return layoutOverride;
  return parsePromptLayout(await getSettingJson<unknown>(PROMPT_LAYOUT_SETTING_KEY, null).catch(() => null));
}

/**
 * Ghép lời nhắc. `parts` theo THỨ TỰ CŨ. LEGACY ⇒ đúng chuỗi `filter(Boolean).join("\n")` của bản cũ, không có điểm cắt. CACHE_FIRST ⇒ xếp
 * ổn định theo tầng; `cacheBreak` = số ký tự của phần TĨNH (điểm cắt khối đệm), `undefined` khi không có phần tĩnh hoặc không có phần
 * nào sau nó. HÀM THUẦN.
 */
export function assembleSystemPrompt(parts: readonly PromptPart[], layout: PromptLayout): { system: string; cacheBreak?: number } {
  const kept = parts.filter((p) => p.text);
  if (layout === "LEGACY") return { system: kept.map((p) => p.text).join("\n") };
  const rank = (t: PromptTier) => PROMPT_TIERS.indexOf(t);
  const ordered = kept.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p.tier) - rank(b.p.tier) || a.i - b.i).map((x) => x.p);
  const system = ordered.map((p) => p.text).join("\n");
  const staticText = ordered.filter((p) => p.tier === "STATIC").map((p) => p.text).join("\n");
  return staticText && staticText.length < system.length ? { system, cacheBreak: staticText.length } : { system };
}

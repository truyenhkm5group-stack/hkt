import { z } from "zod";

/**
 * ═══════════ SLO CỦA AI BÁN HÀNG (chủ shop chốt 06/10/2026, sau sự cố P0 cùng ngày) ═══════════
 *
 * Sự cố: tài khoản trả trước Google AI Studio cạn lúc 11:38 — bot HSLC im ~2 giờ, máy ngừng ghi đơn, và KHÔNG có gì trong hệ
 * thống nói ra điều đó: AI hỏng ⇒ lượt chat vẫn trả «ok» kèm trạng thái chuyển nhân viên, tin khách được chốt DONE với ghi
 * chú «Chuyển nhân viên». Hàng chờ trống trơn trong khi không khách nào được trả lời. Người phát hiện là chủ shop.
 *
 * Các con số dưới đây là QUYẾT ĐỊNH của chủ shop (luật 38: đích là quyết định kinh doanh) — đây là mặc định, ghi đè THƯA ở
 * `settings[AI_SALES_SLO_SETTING_KEY]` (lưu cả bảng thì sửa mặc định trong mã không bao giờ tới production — luật 54):
 *  · tin khách vào ERP gần thời gian thực;
 *  · AI trả lời bình thường < 60 giây;
 *  · tin đủ điều kiện xử lý mà > 5 phút chưa xử lý ⇒ CẢNH BÁO; > 10 phút ⇒ NGUY CẤP;
 *  · provider lỗi / hết quota ⇒ báo RÕ nguyên nhân.
 */
export const AI_SALES_SLO_SETTING_KEY = "ai.salesHealth.slo";

export const DEFAULT_AI_SALES_SLO = {
  /** AI trả lời bình thường dưới mốc này (giây) — đo từ lúc tin khách vào ERP tới câu bot đầu tiên gửi đi. */
  replyTargetSeconds: 60,
  /** Tin đủ điều kiện xử lý nằm chờ quá mốc này (phút) ⇒ CẢNH BÁO. */
  backlogWarnMinutes: 5,
  /** … quá mốc này (phút) ⇒ NGUY CẤP. */
  backlogCriticalMinutes: 10,
  /**
   * Cửa sổ nhìn lỗi provider (phút): trong cửa sổ có ≥ `providerErrorBurst` lượt lỗi và KHÔNG lượt nào thành công sau lượt lỗi
   * cuối ⇒ NGUY CẤP. Lỗi lớp không tự khỏi (hết tiền · khoá bị từ chối · chạm quota) ⇒ NGUY CẤP ngay từ lượt đầu.
   */
  providerWindowMinutes: 15,
  providerErrorBurst: 3,
  /**
   * BOT IM: trong `silentWindowMinutes` có ≥ `silentMinCustomerMessages` tin khách đã được máy chốt xử lý mà KHÔNG có câu
   * bot nào gửi đi ⇒ NGUY CẤP. Đây là bộ bắt đúng sự cố 06/10 — hàng chờ trống nhưng không ai được trả lời.
   */
  silentWindowMinutes: 30,
  silentMinCustomerMessages: 3,
  /** Job lưới an toàn (`sales-followup`: quét lại tin rơi · ghi đơn từ hội thoại) không chạy quá mốc này (phút) ⇒ CẢNH BÁO. */
  followupStaleMinutes: 20,
  /** Mẫu tối thiểu để nói về độ trễ P95 — dưới mẫu này là CHƯA ĐỦ DỮ LIỆU, không phải "nhanh". */
  latencyMinSample: 10,
  /** Webhook im lặng: khung giờ này mọi hôm có ≥ mốc này tin khách mà giờ qua 0 tin ⇒ CẢNH BÁO. Dưới 5 ngày nền ⇒ CHƯA BIẾT. */
  webhookSilentBaselineMin: 3,
  webhookBaselineMinDays: 5,
  /** Đang NGUY CẤP: nhắc lại mỗi mốc này (phút) cho tới khi hết — một tin mỗi khung, không một tin mỗi lượt kiểm. */
  remindEveryMinutes: 60,
} as const;

export type AiSalesSlo = { -readonly [K in keyof typeof DEFAULT_AI_SALES_SLO]: number };

const sloOverrideZ = z
  .object(Object.fromEntries(Object.keys(DEFAULT_AI_SALES_SLO).map((k) => [k, z.number().positive().max(100_000)])) as Record<keyof AiSalesSlo, z.ZodNumber>)
  .partial();

/**
 * Ghép phần đè (thưa) lên mặc định. Ô sai kiểu bị bỏ RIÊNG ô đó; cặp cảnh báo/nguy cấp sai thứ tự ⇒ bỏ CẢ CẶP về mặc định
 * (sửa hộ một ô là đoán ý người nhập — luật 54).
 */
export function resolveAiSalesSlo(raw: unknown): AiSalesSlo {
  const out: AiSalesSlo = { ...DEFAULT_AI_SALES_SLO };
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(k in DEFAULT_AI_SALES_SLO)) continue;
    const one = sloOverrideZ.safeParse({ [k]: v });
    if (one.success) (out as Record<string, number>)[k] = v as number;
  }
  if (out.backlogWarnMinutes >= out.backlogCriticalMinutes) {
    out.backlogWarnMinutes = DEFAULT_AI_SALES_SLO.backlogWarnMinutes;
    out.backlogCriticalMinutes = DEFAULT_AI_SALES_SLO.backlogCriticalMinutes;
  }
  return out;
}

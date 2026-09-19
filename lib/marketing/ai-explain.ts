import { getAiProvider } from "@/lib/ai/provider";
import { aiDisabledReason } from "@/lib/ai/router";
import { memo } from "@/lib/cache";
import { MARKETING_AI_SYSTEM, buildAiContext, type BaselineLike, type MarketingAiContext } from "@/lib/marketing/ai-context";
import type { MarketingFinding } from "@/lib/marketing/diagnose";
import type { MarketingDailyBase } from "@/lib/queries/marketing-daily";

/**
 * ═══════════ LỚP GIẢI THÍCH BẰNG AI — TUỲ CHỌN, VÀ KHÔNG BAO GIỜ CHẶN ĐƯỜNG ═══════════
 *
 * Dùng lại ĐÚNG hạ tầng AI đã có (`lib/ai/provider.ts`): không khoá API riêng, không cấu hình
 * riêng, không nhà cung cấp thứ hai.
 *
 * ─── THỨ TỰ KHÔNG ĐƯỢC ĐẢO ───
 *
 *   bộ máy chỉ số (xác định)  →  máy phân tích quy tắc (thuần)  →  bối cảnh có cấu trúc  →  AI
 *
 * AI đứng CUỐI và chỉ viết chữ. Bảng vẫn đọc được, chẩn đoán vẫn chạy, cảnh báo vẫn gửi khi không
 * có khoá API — phần AI đơn giản là không xuất hiện. Đó là điều kiện để một lớp tuỳ chọn được phép
 * tồn tại trong một báo cáo tiền: nó không được là một điểm hỏng mới.
 *
 * Không có phát hiện nào thì KHÔNG gọi mô hình. Trả tiền để nghe "mọi thứ đều ổn" là lãng phí, và
 * một đoạn văn tự sinh mỗi ngày sẽ nhanh chóng không ai đọc.
 */

export type MarketingExplanation = {
  text: string;
  model: string;
  /** Bối cảnh ĐÚNG như đã gửi — để truy được vì sao mô hình nói câu đó. */
  context: MarketingAiContext;
};

/**
 * ĐỆM LÀ MỘT PHẦN CỦA THIẾT KẾ, KHÔNG PHẢI TỐI ƯU THÊM.
 *
 * Không có nó thì mỗi lần tải trang là một lần gọi mô hình — bấm đổi kỳ năm lần là năm lần trả
 * tiền cho cùng một đoạn văn. Khoá đệm mang TOÀN BỘ thứ quyết định câu trả lời (phạm vi · kỳ · mốc
 * · các con số · các phát hiện), nên đệm không bao giờ trả về lời giải thích của một kỳ khác.
 *
 * 10 phút: đủ lâu để bấm qua lại không tốn thêm, đủ ngắn để một lượt đồng bộ mới kịp đổi câu trả lời.
 */
export async function explainMarketing(input: Parameters<typeof explainMarketingUncached>[0]) {
  const key = JSON.stringify([input.scopeLabel, input.periodLabel, input.basisLabel, input.totals, input.findings.map((f) => `${f.kind}:${f.severity}`)]);
  return memo(`marketingAi:${key}`, 600_000, () => explainMarketingUncached(input));
}

async function explainMarketingUncached(input: {
  scopeLabel: string;
  periodLabel: string;
  basisLabel: string;
  totals: MarketingDailyBase;
  baseline: BaselineLike | null;
  findings: MarketingFinding[];
  warnings: string[];
}): Promise<{ explanation: MarketingExplanation | null; skipped: string | null }> {
  if (!input.findings.length) return { explanation: null, skipped: "Không có phát hiện nào — không cần diễn giải" };
  const disabled = aiDisabledReason();
  if (disabled) return { explanation: null, skipped: disabled };
  // `tier: "analysis"` — đây là việc đọc số và xếp nguyên nhân, không phải trả lời nhanh.
  const provider = getAiProvider("analysis");
  if (!provider) return { explanation: null, skipped: "Chưa cấu hình nhà cung cấp AI" };

  const context = buildAiContext(input);
  try {
    const res = await provider.complete({
      system: MARKETING_AI_SYSTEM,
      tools: [],
      maxTokens: 800,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Đây là số liệu marketing đã tính sẵn. Hãy giải thích ngắn gọn điều gì đang xảy ra, xếp nguyên nhân có khả năng nhất lên trước, và nói rõ nên làm gì.\n\n${JSON.stringify(context, null, 2)}`,
            },
          ],
        },
      ],
    });
    const text = res.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!text) return { explanation: null, skipped: "Mô hình không trả về nội dung" };
    return { explanation: { text, model: res.model, context }, skipped: null };
  } catch (e) {
    /*
      LỖI CỦA MÔ HÌNH KHÔNG ĐƯỢC LÀM HỎNG BÁO CÁO.

      Quá tải, hết hạn mức, mạng đứt — cả ba đều là chuyện của nhà cung cấp, và không cái nào là lý
      do để chủ shop không xem được lợi nhuận hôm qua. Nuốt lỗi ở đây là ĐÚNG, nhưng phải NÓI RA lý
      do chứ không im lặng trả về rỗng: im lặng thì không ai biết phần giải thích đã biến mất.
    */
    return { explanation: null, skipped: `Không gọi được AI: ${e instanceof Error ? e.message : String(e)}` };
  }
}

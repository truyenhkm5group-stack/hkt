import { homeBotBannerLines } from "@/lib/constants/home-bot-health";
import { readHomeBotHealth } from "@/lib/home-bot/health";

/**
 * BANNER SỨC KHOẺ BOT NHÀ (24/10/2026 — bot nhà im 6 giờ vì Gemini 403 mà không ai biết). Đọc khoá settings `home-bot.health` mà bot nhà
 * đẩy lên (lib/constants/home-bot-health.ts). RIÊNG với AiProviderIncidentBanner: khoá bot nhà là project KHÁC khoá nền tảng, nên sự cố
 * của nó không được chặn bench / probe nền tảng. Bot chưa từng báo (bản cũ) ⇒ không hiện gì — không kết luận.
 */
export async function HomeBotHealthBanner() {
  const lines = homeBotBannerLines(await readHomeBotHealth(), new Date());
  if (!lines.length) return null;
  return (
    <div role="alert" className="space-y-1 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-100" data-home-bot-health>
      {lines.map((l) => (
        <p key={l}>🔴 {l}</p>
      ))}
      <p className="text-xs opacity-80">Nhân viên trực trả lời tay các page nhà tới khi hồi phục. Chi tiết: ops chatbot-status.</p>
    </div>
  );
}

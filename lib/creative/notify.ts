import { loadAlertConfig } from "@/lib/alerts/config";
import { sendLark } from "@/lib/alerts/lark";
import { sendTelegram } from "@/lib/alerts/telegram";
import { env } from "@/lib/env";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import { shiftDay } from "@/lib/constants/marketing-decision-ledger";

/**
 * ═══════════ TIN BÁO CỦA VÒNG MẪU ═══════════
 *
 * Vòng mẫu có đúng MỘT việc cần người: bấm duyệt lô trước 5:30. Nên tin báo quan trọng nhất là
 * "lô ngày mai đã sẵn, còn tới HH:MM để duyệt" — thiếu nó thì lô quá hạn trong im lặng và cả một ngày
 * test mất đi mà không ai biết vì sao.
 *
 * Chống gửi lặp bằng sổ trong `settings` (`creative.notified`), khoá = loại tin + ngày lô. CHỈ GHI SỔ
 * KHI GỬI ĐƯỢC — Lark hỏng một lượt thì tick sau gửi lại (cùng cơ chế với bản tin marketing).
 */

const SENT_KEY = "creative.notified";

export type CreativeNotice = {
  kind: "READY" | "EXPIRED" | "PUBLISHED" | "KILLED";
  batchDay: string;
  title: string;
  lines: string[];
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Gửi một tin (Lark kênh chính + Telegram nếu có). Trả `true` nếu ít nhất một kênh nhận được. */
export async function sendCreativeNotice(n: CreativeNotice): Promise<{ sent: boolean; skipped?: string; errors: string[] }> {
  const ledger = await getSettingJson<Record<string, string>>(SENT_KEY, {});
  const key = `${n.kind}:${n.batchDay}`;
  if (ledger[key]) return { sent: false, skipped: "đã gửi", errors: [] };

  const cfg = await loadAlertConfig();
  const link = `${env.appUrl}/marketing/creatives`;
  const errors: string[] = [];
  let ok = false;
  if (cfg.larkWebhookUrl) {
    const r = await sendLark(cfg.larkWebhookUrl, cfg.larkSecret, n.title, [...n.lines.map((text) => [{ text }]), [{ text: "Mở vòng mẫu", href: link }]]);
    if (r.ok) ok = true;
    else errors.push(`Lark: ${r.error ?? "lỗi"}`);
  }
  if (cfg.telegramBotToken && cfg.telegramChatId) {
    const html = [`<b>${escapeHtml(n.title)}</b>`, ...n.lines.map(escapeHtml), `<a href="${link}">Mở vòng mẫu</a>`].join("\n");
    const r = await sendTelegram(cfg.telegramBotToken, cfg.telegramChatId, html);
    if (r.ok) ok = true;
    else errors.push(`Telegram: ${r.error ?? "lỗi"}`);
  }
  if (!cfg.larkWebhookUrl && !(cfg.telegramBotToken && cfg.telegramChatId)) return { sent: false, skipped: "chưa khai kênh Lark/Telegram", errors };
  if (ok) {
    ledger[key] = new Date().toISOString();
    // Chỉ giữ 30 ngày để `settings` không phình vô hạn.
    const keep = shiftDay(n.batchDay, -30);
    for (const k of Object.keys(ledger)) if (k.slice(k.indexOf(":") + 1) < keep) delete ledger[k];
    await setSettingJson(SENT_KEY, ledger);
  }
  return { sent: ok, errors };
}

/** Giờ Việt Nam dạng `HH:MM dd/MM` cho câu chữ tin báo. */
export function vnClock(at: Date): string {
  const d = new Date(at.getTime() + 7 * 3_600_000).toISOString();
  return `${d.slice(11, 16)} ${d.slice(8, 10)}/${d.slice(5, 7)}`;
}

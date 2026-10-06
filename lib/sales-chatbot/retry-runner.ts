/**
 * Lượt THỬ LẠI tin khách bị DEAD vì AI hỏng (job `sales-followup`, 5 phút) — tách khỏi inbound-retry.ts để không vòng import
 * (fanpage.ts / messenger.ts dùng inbound-retry.ts). Luật nằm ở `requeueDecision` (hàm thuần): còn trong 30 phút, chưa hết
 * lượt, tới mốc lùi dần, provider ĐÃ có lượt thành công sau lúc hỏng, chưa ai của shop / bot trả lời. Không ném.
 */
import { salesAiUsageHealth } from "@/lib/ai-usage/sales-health";
import { currentOrganization } from "@/lib/platform/context";
import { AI_DOWN_HANDOFF_REASON } from "@/lib/sales-chatbot/engine";
import { processFanpageThread } from "@/lib/sales-chatbot/fanpage";
import { requeueAiDownDeadLetters } from "@/lib/sales-chatbot/inbound-retry";
import { processMessengerThread } from "@/lib/sales-chatbot/messenger";

export type RetryRun = { checked: number; requeued: number; replies: number; detail: string };

export async function retryAiDownMessages(now: Date = new Date()): Promise<RetryRun> {
  try {
    const org = await currentOrganization();
    const usage = await salesAiUsageHealth(org.code, now, 15).catch(() => null);
    const r = await requeueAiDownDeadLetters(AI_DOWN_HANDOFF_REASON, usage?.lastOkAt ?? null, now);
    let replies = 0;
    for (const th of r.requeued) {
      // Page Pancake hay page nối thẳng Meta — mỗi hàm tự từ chối page không phải của kênh nó.
      const f = await processFanpageThread(th.pageId, th.threadId, { catchUp: true }).catch(() => null);
      const viaPancake = f !== null && !(f.skipped ?? "").startsWith("Kết nối fanpage chưa bật");
      const res = viaPancake ? f : await processMessengerThread(th.pageId, th.threadId, { catchUp: true }).catch(() => null);
      replies += res?.replies ?? 0;
    }
    const why = Object.entries(r.skipped)
      .map(([k, n]) => `${n} ${k}`)
      .join(" · ");
    return { checked: r.checked, requeued: r.requeued.length, replies, detail: r.checked ? `thử lại tin AI hỏng: xét ${r.checked} · trả lại hàng chờ ${r.requeued.length} · trả lời ${replies}${why ? ` (bỏ qua: ${why})` : ""}` : "" };
  } catch (e) {
    return { checked: 0, requeued: 0, replies: 0, detail: `thử lại tin AI hỏng: lỗi ${e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120)}` };
  }
}

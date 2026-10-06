/**
 * Trạng thái đồng bộ «Pancake qua API» của tổ chức NGỮ CẢNH — luật ở `pancake-poll-shared.ts`. Lưu ở bảng `settings` của
 * CSDL tổ chức (khoá `ai.salesChatbot.pancakePoll`), nên mốc đồng bộ sống qua khởi động lại và không bao giờ lẫn tổ chức.
 * Không có bí mật nào ở đây — token nằm trong kết nối đã mã hoá.
 */
import { getSettingJson, setSettingJson } from "@/lib/settings";
import { noteWebhook, parsePollState, type PancakePollState } from "@/lib/sales-chatbot/pancake-poll-shared";

export const PANCAKE_POLL_SETTING_KEY = "ai.salesChatbot.pancakePoll";

export async function loadPollState(pageId: string): Promise<PancakePollState> {
  return parsePollState(await getSettingJson<unknown>(PANCAKE_POLL_SETTING_KEY, null), pageId);
}

export async function savePollState(state: PancakePollState): Promise<void> {
  await setSettingJson(PANCAKE_POLL_SETTING_KEY, state);
}

/** Webhook Pancake vừa có tin cho `pageId` ⇒ ghi mốc (thưa — tối đa 5 phút một lần). Không ném: webhook phải trả 200 nhanh. */
export async function markPancakeWebhook(pageId: string, now: Date = new Date()): Promise<void> {
  try {
    const next = noteWebhook(await loadPollState(pageId), now.getTime());
    if (next) await savePollState(next);
  } catch (error) {
    console.error(`[pancake-poll] ghi mốc webhook: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
  }
}

"use server";

import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { CHATBOT_AD_BOTS_KEY, saveAdBotSchema, type AdBotConfig } from "@/lib/constants/chatbot-ad-bots";
import { getAdBotConfig, pushAdBots, type AdBotPushResult } from "@/lib/integrations/chatbot/ad-bots";
import { setSettingJson } from "@/lib/settings";

/**
 * Bot riêng theo quảng cáo: lưu lớp GHI ĐÈ của người (bật/tắt · mã mẫu · hướng dẫn) rồi đẩy ngay sang bot.
 * Tên người sửa do MÁY CHỦ đọc từ phiên (mục 34), không nhận từ client.
 */

type Result = { ok: true; message: string } | { error: string };
const PATH = "/chatbot/ad-bots";

function pushNote(r: AdBotPushResult): string {
  return r.ok ? `Đã gửi ${r.accepted} bot riêng sang bot chat.` : `Đã lưu nhưng CHƯA gửi được sang bot chat: ${r.error}. Bấm "Gửi lại sang bot" khi bot chạy.`;
}

export async function saveAdBotAction(input: unknown): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "cs:config")) return { error: "Bạn không có quyền sửa bot chat (cs:config)." };
  const parsed = saveAdBotSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { adId, enabled, productCode, instructions } = parsed.data;
  const config = await getAdBotConfig();
  const before = config.overrides[adId] ?? null;
  const next: AdBotConfig = {
    ...config,
    overrides: {
      ...config.overrides,
      [adId]: { enabled, productCode: productCode.toUpperCase(), instructions: instructions.trim(), updatedByUserId: user.id, updatedByName: user.name || user.email, updatedAt: new Date().toISOString() },
    },
  };
  await setSettingJson(CHATBOT_AD_BOTS_KEY, next);
  await audit({ userId: user.id, userEmail: user.email, action: "CHATBOT_AD_BOT_SAVE", entity: "CHATBOT_AD_BOT", entityId: adId, before, after: next.overrides[adId] });
  const r = await pushAdBots();
  revalidatePath(PATH);
  return { ok: true, message: `Đã lưu bot riêng của quảng cáo ${adId}. ${pushNote(r)}` };
}

export async function setAdBotsEnabledAction(enabled: boolean): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "cs:config")) return { error: "Bạn không có quyền sửa bot chat (cs:config)." };
  const config = await getAdBotConfig();
  await setSettingJson(CHATBOT_AD_BOTS_KEY, { ...config, enabled: enabled === true });
  await audit({ userId: user.id, userEmail: user.email, action: "CHATBOT_AD_BOT_SWITCH", entity: "CHATBOT_AD_BOT", entityId: "*", before: { enabled: config.enabled }, after: { enabled: enabled === true } });
  const r = await pushAdBots();
  revalidatePath(PATH);
  return { ok: true, message: `${enabled ? "Đã BẬT" : "Đã TẮT"} bot riêng theo quảng cáo. ${pushNote(r)}` };
}

export async function syncAdBotsAction(): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "cs:config")) return { error: "Bạn không có quyền sửa bot chat (cs:config)." };
  const r = await pushAdBots();
  await audit({ userId: user.id, userEmail: user.email, action: "CHATBOT_AD_BOT_SYNC", entity: "CHATBOT_AD_BOT", entityId: "*", after: r });
  revalidatePath(PATH);
  return r.ok ? { ok: true, message: `Đã gửi ${r.accepted} bot riêng sang bot chat.` } : { error: r.error };
}

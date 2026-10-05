"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { clearPendingPages, loadPendingPages, MESSENGER_SETTINGS_PATH } from "@/lib/integrations/messenger/connect";
import { connectMessengerPages, disconnectMessengerPage, setMessengerPagesAi } from "@/lib/sales-chatbot/messenger";

/**
 * Nối các page NGƯỜI CHỌN trong danh sách vừa cấp quyền (danh sách + token niêm phong ở máy chủ, khoá theo tổ chức + người;
 * client chỉ gửi MÃ page — không bao giờ gửi / nhận token). Page không có trong danh sách vừa cấp quyền bị bỏ.
 */
export async function pickMessengerPagesAction(pageIds: unknown): Promise<{ ok: true; message: string } | { error: string }> {
  const user = await requirePermission("settings:manage");
  if (!user.organization) return { error: "Phiên không mang tổ chức." };
  const ids = Array.isArray(pageIds) ? [...new Set(pageIds.filter((x): x is string => typeof x === "string"))] : [];
  if (!ids.length) return { error: "Chưa chọn page nào." };
  const pages = await loadPendingPages(user.organization.code, user.id);
  if (!pages) return { error: "Danh sách page đã hết hạn — bấm «Kết nối Facebook Page» lại." };
  const chosen = pages.filter((p) => ids.includes(p.id));
  if (!chosen.length) return { error: "Không có page nào đã chọn trong danh sách vừa cấp quyền." };
  const r = await connectMessengerPages(user, chosen);
  if ("ok" in r) {
    await clearPendingPages(user.id);
    revalidatePath(MESSENGER_SETTINGS_PATH);
  }
  return "ok" in r ? { ok: true, message: r.message } : r;
}

/** Gỡ MỘT page (`pageId`) hoặc cả kết nối (không `pageId`). */
export async function disconnectMessengerAction(pageId?: string): Promise<{ ok: true; message: string } | { error: string }> {
  const user = await requirePermission("settings:manage");
  const r = await disconnectMessengerPage(user, typeof pageId === "string" && pageId ? pageId : undefined);
  if ("ok" in r) revalidatePath(MESSENGER_SETTINGS_PATH);
  return r;
}

/** Bật / tạm dừng AI cho các page đã chọn (hàng loạt). */
export async function setMessengerPagesAiAction(pageIds: unknown, aiEnabled: boolean): Promise<{ ok: true; message: string } | { error: string }> {
  const user = await requirePermission("settings:manage");
  const ids = Array.isArray(pageIds) ? pageIds.filter((x): x is string => typeof x === "string") : [];
  const r = await setMessengerPagesAi(user, ids, aiEnabled === true);
  if ("ok" in r) revalidatePath(MESSENGER_SETTINGS_PATH);
  return r;
}

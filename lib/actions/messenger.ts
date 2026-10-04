"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { requirePermission } from "@/lib/auth/session";
import { MESSENGER_PAGES_COOKIE, MESSENGER_SETTINGS_PATH, openPendingPages } from "@/lib/integrations/messenger/connect";
import { connectMessengerPage, disconnectMessengerPage } from "@/lib/sales-chatbot/messenger";

/**
 * Messenger trực tiếp (lib/sales-chatbot/messenger.ts). Vỏ mỏng: quyền Cài đặt → lõi (lõi đi qua ĐÚNG lõi kết nối: mã hoá token,
 * kiểm tra, nhật ký) → làm mới trang. Token page chỉ đọc từ cookie MÃ HOÁ của chính người đã bấm kết nối — client chỉ gửi mã page.
 */
export async function pickMessengerPageAction(pageId: unknown): Promise<{ ok: true; message: string } | { error: string }> {
  const user = await requirePermission("settings:manage");
  if (!user.organization) return { error: "Phiên không mang tổ chức." };
  const jar = await cookies();
  const pages = await openPendingPages(jar.get(MESSENGER_PAGES_COOKIE)?.value, user.organization.code, user.id);
  if (!pages) return { error: "Danh sách page đã hết hạn — bấm «Kết nối Facebook Page» lại." };
  const page = pages.find((p) => p.id === pageId);
  if (!page) return { error: "Không có page này trong danh sách vừa cấp quyền." };
  const r = await connectMessengerPage(user, page);
  if ("ok" in r) {
    jar.set(MESSENGER_PAGES_COOKIE, "", { path: "/", maxAge: 0 });
    revalidatePath(MESSENGER_SETTINGS_PATH);
  }
  return r;
}

export async function disconnectMessengerAction(): Promise<{ ok: true; message: string } | { error: string }> {
  const user = await requirePermission("settings:manage");
  const r = await disconnectMessengerPage(user);
  if ("ok" in r) revalidatePath(MESSENGER_SETTINGS_PATH);
  return r;
}

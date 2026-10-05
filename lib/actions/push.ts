"use server";

import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { pushToUsers, removePushSubscription, savePushSubscription } from "@/lib/push/service";

/**
 * Bật / tắt thông báo đẩy trên MÁY ĐANG DÙNG (docs/platform/pwa.md). Vỏ mỏng: người đang đăng nhập → zod → lõi. Đăng ký luôn
 * gắn với `user.id` của phiên — client chỉ gửi khoá trình duyệt cấp, không gửi được «bật cho người khác».
 */
const subscriptionSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().min(80).max(200), auth: z.string().min(16).max(64) }),
});

export async function enablePushAction(input: unknown, userAgent: unknown): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  const parsed = subscriptionSchema.safeParse(input);
  if (!parsed.success) return { error: "Trình duyệt gửi đăng ký không hợp lệ — tải lại trang rồi bật lại." };
  const s = parsed.data;
  return savePushSubscription(user.id, { endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth, userAgent: typeof userAgent === "string" ? userAgent : null });
}

export async function disablePushAction(endpoint: unknown): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  if (typeof endpoint !== "string" || !endpoint) return { error: "Thiếu đăng ký của máy này." };
  await removePushSubscription(user.id, endpoint);
  return { ok: true };
}

/** Gửi thử một thông báo tới MỌI máy người này đã bật. */
export async function testPushAction(): Promise<{ ok: true; message: string } | { error: string }> {
  const user = await requireUser();
  const r = await pushToUsers([{ userId: user.id, title: "VNXcommerce ERP", body: "Thông báo đã bật trên máy này.", href: "/settings/profile" }]);
  if (!r.sent && !r.failed && !r.removed) return { error: "Chưa có máy nào bật thông báo." };
  if (!r.sent) return { error: `Không gửi được (${r.failed} lỗi tạm, ${r.removed} đăng ký đã hết hạn — bật lại).` };
  return { ok: true, message: `Đã gửi tới ${r.sent} máy.` };
}

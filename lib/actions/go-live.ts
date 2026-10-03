"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { quickConnectFanpage, quickEnableBot } from "@/lib/onboarding/go-live";

/**
 * «Vào việc ngay» trên trang Bắt đầu (lib/onboarding/go-live.ts). Vỏ mỏng: đọc phiên → lõi (lõi gọi ĐÚNG các hàm kết nối /
 * chatbot đang có — kiểm quyền `settings:manage` / `ai_sales:manage`, mã hoá bí mật, ghi nhật ký) → làm mới trang.
 */
export async function quickConnectFanpageAction(input: { pageId: string; pageAccessToken: string }): Promise<{ ok: true; message: string } | { error: string }> {
  const user = await requireUser();
  const r = await quickConnectFanpage(user, input ?? {});
  if ("ok" in r) {
    revalidatePath("/");
    revalidatePath("/ai/sales-chatbot");
  }
  return r;
}

export async function quickEnableBotAction(): Promise<{ ok: true; message: string } | { error: string }> {
  const user = await requireUser();
  const r = await quickEnableBot(user);
  if ("ok" in r) {
    revalidatePath("/");
    revalidatePath("/ai/sales-chatbot");
  }
  return r;
}

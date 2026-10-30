"use server";

import { revalidatePath } from "next/cache";
import { can, requireUser } from "@/lib/auth/session";
import type { CoreResult } from "@/lib/wholesale/campaigns";
import { runEmailInboundJob, saveEmailInboundSettingsCore } from "@/lib/wholesale/email-reply";

/** Vỏ Next của E3 «đọc & phân loại thư trả lời». Lõi (`lib/wholesale/email-reply.ts`) tự kiểm quyền và ghi nhật ký. */

export async function saveEmailInboundSettingsAction(input: unknown): Promise<CoreResult> {
  const user = await requireUser();
  const r = await saveEmailInboundSettingsCore(user, input);
  if ("ok" in r) revalidatePath("/wholesale/outbox");
  return r;
}

/** «Đọc hộp thư ngay» — đúng một lượt của job (cùng khoá), chỉ người cấu hình. */
export async function runEmailInboundNowAction(): Promise<CoreResult<{ detail: string }>> {
  const user = await requireUser();
  if (!can(user, "wholesale:config")) return { error: "Chỉ người cấu hình (wholesale:config) chạy đọc hộp thư bằng tay." };
  const r = await runEmailInboundJob({ trigger: "MANUAL", actor: `wholesale-email-inbound:${user.email}` });
  revalidatePath("/wholesale/outbox");
  return { ok: true, detail: r.detail };
}

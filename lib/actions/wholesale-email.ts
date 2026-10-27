"use server";

import { revalidatePath } from "next/cache";
import { can, requireUser } from "@/lib/auth/session";
import type { CoreResult } from "@/lib/wholesale/campaigns";
import {
  approveEmailCore,
  bulkApproveEmailCore,
  cancelEmailCore,
  editEmailDraftCore,
  emailDraftFromOutreachCore,
  queueEmailCore,
  reopenEmailCore,
  runEmailOutboxJob,
  saveEmailSettingsCore,
  setEmailPauseCore,
} from "@/lib/wholesale/email-outbox";
import { getEmailSettings } from "@/lib/wholesale/email-store";

/**
 * Vỏ Next của Hộp thư đi bán sỉ (E1). Lõi (`lib/wholesale/email-outbox.ts`) tự kiểm quyền, phạm vi dữ liệu của lead và ghi
 * nhật ký; tệp này chỉ lấy người dùng và làm mới trang. Không có hành động nào gửi thẳng: «Chạy thử gửi» chỉ chạy MỘT lượt hàng
 * đợi — đúng đường của job, đúng cổng chính sách.
 */

function refresh() {
  revalidatePath("/wholesale/outbox");
  revalidatePath("/wholesale/outreach");
}

export async function emailDraftFromOutreachAction(outreachId: string, input: { subject?: string } = {}): Promise<CoreResult<{ id: string }>> {
  const user = await requireUser();
  const r = await emailDraftFromOutreachCore(user, outreachId, input);
  if ("ok" in r) refresh();
  return r;
}

export async function editEmailDraftAction(id: string, input: { subject: string; body: string }): Promise<CoreResult> {
  const user = await requireUser();
  const r = await editEmailDraftCore(user, id, input);
  if ("ok" in r) refresh();
  return r;
}

export async function approveEmailAction(id: string, input: { queue: boolean }): Promise<CoreResult<{ warnings: string[] }>> {
  const user = await requireUser();
  const r = await approveEmailCore(user, id, input);
  if ("ok" in r) refresh();
  return r;
}

export async function bulkApproveEmailAction(ids: string[], input: { queue: boolean }): Promise<CoreResult<{ approved: number; skipped: number }>> {
  const user = await requireUser();
  const r = await bulkApproveEmailCore(user, ids, input);
  if ("ok" in r) refresh();
  return r;
}

export async function queueEmailAction(id: string): Promise<CoreResult> {
  const user = await requireUser();
  const r = await queueEmailCore(user, id);
  if ("ok" in r) refresh();
  return r;
}

export async function cancelEmailAction(id: string): Promise<CoreResult> {
  const user = await requireUser();
  const r = await cancelEmailCore(user, id);
  if ("ok" in r) refresh();
  return r;
}

export async function reopenEmailAction(id: string): Promise<CoreResult> {
  const user = await requireUser();
  const r = await reopenEmailCore(user, id);
  if ("ok" in r) refresh();
  return r;
}

export async function saveEmailSettingsAction(input: unknown): Promise<CoreResult> {
  const user = await requireUser();
  const r = await saveEmailSettingsCore(user, input);
  if ("ok" in r) refresh();
  return r;
}

export async function setEmailPauseAction(input: { scope: "ORG" | "CAMPAIGN" | "DOMAIN"; target?: string; paused: boolean; reason?: string }): Promise<CoreResult> {
  const user = await requireUser();
  const r = await setEmailPauseCore(user, input);
  if ("ok" in r) refresh();
  return r;
}

/**
 * «Chạy thử gửi»: MỘT lượt hàng đợi ngay (cùng khoá với job). Chạy thử ⇒ người chăm lead (`wholesale:work`) bấm được; gửi thật ⇒
 * chỉ người cấu hình (`wholesale:config`).
 */
export async function runEmailOutboxNowAction(): Promise<CoreResult<{ detail: string }>> {
  const user = await requireUser();
  const s = await getEmailSettings();
  if (!can(user, s.mode === "LIVE" ? "wholesale:config" : "wholesale:work")) return { error: s.mode === "LIVE" ? "Chế độ gửi thật: chỉ người cấu hình (wholesale:config) chạy hàng đợi bằng tay." : "Bạn không có quyền chăm lead khách sỉ (wholesale:work)." };
  if (s.mode === "OFF") return { error: "Email của tổ chức đang TẮT — bật «Chạy thử» ở phần cấu hình bên dưới trước." };
  const r = await runEmailOutboxJob({ trigger: "MANUAL", actor: `wholesale-email:${user.email}` });
  refresh();
  return { ok: true, detail: r.detail };
}

"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import type { CoreResult } from "@/lib/wholesale/campaigns";
import { markZaloUndeliverableCore, undoZaloUndeliverableCore } from "@/lib/wholesale/contact-plan-store";
import { saveEmailAllowedCountriesCore } from "@/lib/wholesale/email-countries";
import { emailDraftForLeadCore } from "@/lib/wholesale/email-outbox";

/**
 * Vỏ Next của kế hoạch kênh (Nước ngoài — Email · Trong nước — Zalo · chuyển sang email) và cổng nước của thư chào hàng.
 * Lõi tự kiểm quyền (`wholesale:work` / quản trị), phạm vi dữ liệu, zod và audit; tệp này chỉ lấy người dùng và làm mới trang.
 */

function refresh(leadId?: string) {
  revalidatePath("/wholesale/outreach");
  revalidatePath("/wholesale/outbox");
  if (leadId) revalidatePath(`/wholesale/leads/${leadId}`);
}

export async function markZaloUndeliverableAction(leadId: string, input: { reason: string; note?: string }): Promise<CoreResult> {
  const user = await requireUser();
  const r = await markZaloUndeliverableCore(user, leadId, input);
  if ("ok" in r) refresh(leadId);
  return r;
}

export async function undoZaloUndeliverableAction(leadId: string, input: { note?: string } = {}): Promise<CoreResult> {
  const user = await requireUser();
  const r = await undoZaloUndeliverableCore(user, leadId, input);
  if ("ok" in r) refresh(leadId);
  return r;
}

/** Làn «Trong nước — chuyển sang email»: soạn thư email cho lead (đúng đường soạn của E1) rồi đưa vào Hộp thư đi — vẫn chạy thử. */
export async function emailDraftForLeadAction(leadId: string): Promise<CoreResult<{ id: string; note: string | null }>> {
  const user = await requireUser();
  const r = await emailDraftForLeadCore(user, leadId, { useAi: false });
  if ("ok" in r) refresh(leadId);
  return r;
}

export async function saveEmailAllowedCountriesAction(input: { countries: string[]; reason: string }): Promise<CoreResult<{ countries: string[] }>> {
  const user = await requireUser();
  const r = await saveEmailAllowedCountriesCore(user, input);
  if ("ok" in r) refresh();
  return r;
}

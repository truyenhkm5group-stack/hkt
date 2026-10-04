"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { can, requireUser } from "@/lib/auth/session";
import { bindOrganization } from "@/lib/platform/background";
import { changeCampaignStateCore, cloneCampaignCore, createCampaignCore, previewCampaignCore, startCampaignCore, type CoreResult, type CampaignPreview } from "@/lib/wholesale/campaigns";
import { saveLeadHunterConfigCore } from "@/lib/wholesale/config-core";
import type { OutreachChannel } from "@/lib/wholesale/constants";
import { sendLeadsToFieldCore, type HandoffReport } from "@/lib/wholesale/field-handoff";
import { runWholesaleLeadsJob } from "@/lib/wholesale/job";
import {
  addLeadNoteCore,
  addLeadsToCampaignCore,
  assignLeadsCore,
  convertLeadCore,
  editLeadCore,
  importLeadsCore,
  logCallCore,
  markQualifiedCore,
  removeSuppressionCore,
  requestRefreshCore,
  saveOpportunityCore,
  updateLeadStatusCore,
  type ImportReport,
} from "@/lib/wholesale/leads";
import { approveOutreachCore, cancelOutreachCore, markOutreachSentCore, prepareOutreachCore, queueOutreachCore, recordOutreachResultCore } from "@/lib/wholesale/outreach";

/**
 * Vỏ Next của Săn khách sỉ. Lõi (`lib/wholesale/*`) tự kiểm quyền, phạm vi dữ liệu, ghi nhật ký. Quét KHÔNG chạy trong
 * yêu cầu HTTP: nút «Bắt đầu» / «Tiếp tục» / «Chạy ngay» chỉ xếp một lượt nền (`after`) — job theo lịch làm phần còn lại.
 */

function refreshLead(leadId?: string) {
  revalidatePath("/wholesale/leads");
  revalidatePath("/wholesale/outreach");
  revalidatePath("/wholesale/dashboard");
  if (leadId) revalidatePath(`/wholesale/leads/${leadId}`);
}

function refreshHunter() {
  revalidatePath("/wholesale/lead-hunter");
  revalidatePath("/wholesale/leads");
}

/** Một lượt quét nền ngay sau khi trả lời người bấm — cùng đường với job theo lịch (khoá theo tổ chức, không chồng). */
async function kickTick() {
  after(await bindOrganization(async () => void (await runWholesaleLeadsJob({ trigger: "MANUAL", actor: "lead-hunter:button", budgetMs: 45_000 }))));
}

export async function previewCampaignAction(input: unknown): Promise<CoreResult<{ preview: CampaignPreview }>> {
  const user = await requireUser();
  return previewCampaignCore(user, input);
}

export async function createCampaignAction(input: unknown): Promise<CoreResult<{ id: string }>> {
  const user = await requireUser();
  const r = await createCampaignCore(user, input);
  if ("ok" in r) refreshHunter();
  return r;
}

export async function startCampaignAction(id: string): Promise<CoreResult<{ queued: number; skippedFresh: number }>> {
  const user = await requireUser();
  const r = await startCampaignCore(user, id);
  if ("ok" in r) {
    await kickTick();
    refreshHunter();
  }
  return r;
}

export async function changeCampaignStateAction(id: string, op: "pause" | "resume" | "stop"): Promise<CoreResult<{ status: string }>> {
  const user = await requireUser();
  const r = await changeCampaignStateCore(user, id, op);
  if ("ok" in r) {
    if (op === "resume") await kickTick();
    refreshHunter();
  }
  return r;
}

export async function cloneCampaignAction(id: string): Promise<CoreResult<{ id: string }>> {
  const user = await requireUser();
  const r = await cloneCampaignCore(user, id);
  if ("ok" in r) refreshHunter();
  return r;
}

export async function runLeadHunterNowAction(): Promise<CoreResult> {
  const user = await requireUser();
  if (!can(user, "wholesale:scan")) return { error: "Bạn không có quyền chạy quét (wholesale:scan)." };
  await kickTick();
  return { ok: true };
}

export async function saveLeadHunterConfigAction(input: unknown): Promise<CoreResult> {
  const user = await requireUser();
  const r = await saveLeadHunterConfigCore(user, input);
  if ("ok" in r) {
    revalidatePath("/wholesale/settings");
    refreshHunter();
  }
  return r;
}

export async function importLeadsAction(text: string): Promise<CoreResult<{ report: ImportReport }>> {
  const user = await requireUser();
  const r = await importLeadsCore(user, text);
  if ("ok" in r) refreshLead();
  return r;
}

export async function updateLeadStatusAction(leadId: string, input: unknown): Promise<CoreResult<{ status: string }>> {
  const user = await requireUser();
  const r = await updateLeadStatusCore(user, leadId, input);
  if ("ok" in r) refreshLead(leadId);
  return r;
}

export async function addLeadNoteAction(leadId: string, input: unknown): Promise<CoreResult> {
  const user = await requireUser();
  const r = await addLeadNoteCore(user, leadId, input);
  if ("ok" in r) refreshLead(leadId);
  return r;
}

export async function logCallAction(leadId: string, input: unknown): Promise<CoreResult<{ status: string }>> {
  const user = await requireUser();
  const r = await logCallCore(user, leadId, input);
  if ("ok" in r) refreshLead(leadId);
  return r;
}

/** Gửi khách tiềm năng cho nhân viên thị trường (Telegram / Zalo / Lark theo cấu hình Săn khách sỉ). */
export async function sendLeadsToFieldAction(input: { leadIds: string[]; destination: number | null; note: string }): Promise<CoreResult<{ report: HandoffReport }>> {
  const user = await requireUser();
  const r = await sendLeadsToFieldCore(user, input);
  if ("ok" in r) refreshLead(input.leadIds.length === 1 ? input.leadIds[0] : undefined);
  return r;
}

export async function assignLeadsAction(input: { leadIds: string[]; userId: string | null }): Promise<CoreResult<{ changed: number }>> {
  const user = await requireUser();
  const r = await assignLeadsCore(user, input);
  if ("ok" in r) refreshLead();
  return r;
}

export async function addLeadsToCampaignAction(input: { leadIds: string[]; campaignId: string }): Promise<CoreResult<{ added: number; blocked: number }>> {
  const user = await requireUser();
  const r = await addLeadsToCampaignCore(user, input);
  if ("ok" in r) refreshLead();
  return r;
}

export async function markQualifiedAction(leadIds: string[]): Promise<CoreResult<{ changed: number }>> {
  const user = await requireUser();
  const r = await markQualifiedCore(user, leadIds);
  if ("ok" in r) refreshLead();
  return r;
}

export async function saveOpportunityAction(leadId: string, input: unknown): Promise<CoreResult> {
  const user = await requireUser();
  const r = await saveOpportunityCore(user, leadId, input);
  if ("ok" in r) refreshLead(leadId);
  return r;
}

export async function convertLeadAction(leadId: string, input: unknown): Promise<CoreResult<{ customerId: string; existing: boolean }>> {
  const user = await requireUser();
  const r = await convertLeadCore(user, leadId, input);
  if ("ok" in r) {
    refreshLead(leadId);
    revalidatePath(`/customers/${r.customerId}`);
  }
  return r;
}

export async function editLeadAction(leadId: string, input: unknown): Promise<CoreResult<{ changed: string[] }>> {
  const user = await requireUser();
  const r = await editLeadCore(user, leadId, input);
  if ("ok" in r) refreshLead(leadId);
  return r;
}

export async function requestRefreshAction(leadId: string): Promise<CoreResult> {
  const user = await requireUser();
  const r = await requestRefreshCore(user, leadId);
  if ("ok" in r) {
    await kickTick();
    refreshLead(leadId);
  }
  return r;
}

export async function removeSuppressionAction(id: string, reason: string): Promise<CoreResult> {
  const user = await requireUser();
  const r = await removeSuppressionCore(user, id, reason);
  if ("ok" in r) revalidatePath("/wholesale/settings");
  return r;
}

export async function prepareOutreachAction(leadId: string, input: { channel: OutreachChannel; useAi: boolean }): Promise<CoreResult<{ id: string; note: string | null }>> {
  const user = await requireUser();
  const r = await prepareOutreachCore(user, leadId, input);
  if ("ok" in r) refreshLead(leadId);
  return r;
}

export async function queueOutreachAction(leadIds: string[], channel: OutreachChannel): Promise<CoreResult<{ queued: number; skipped: number }>> {
  const user = await requireUser();
  const r = await queueOutreachCore(user, leadIds, channel);
  if ("ok" in r) refreshLead();
  return r;
}

export async function approveOutreachAction(itemId: string, input: { message: string }): Promise<CoreResult> {
  const user = await requireUser();
  const r = await approveOutreachCore(user, itemId, input);
  if ("ok" in r) refreshLead();
  return r;
}

export async function markOutreachSentAction(itemId: string): Promise<CoreResult> {
  const user = await requireUser();
  const r = await markOutreachSentCore(user, itemId);
  if ("ok" in r) refreshLead();
  return r;
}

export async function recordOutreachResultAction(itemId: string, input: unknown): Promise<CoreResult<{ status: string }>> {
  const user = await requireUser();
  const r = await recordOutreachResultCore(user, itemId, input);
  if ("ok" in r) refreshLead();
  return r;
}

export async function cancelOutreachAction(itemId: string): Promise<CoreResult> {
  const user = await requireUser();
  const r = await cancelOutreachCore(user, itemId);
  if ("ok" in r) refreshLead();
  return r;
}

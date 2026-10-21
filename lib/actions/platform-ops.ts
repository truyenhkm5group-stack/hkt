"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { disableOrgConnection, setOrganizationSuspended, setWorkflowsPaused, type KillSwitchResult } from "@/lib/platform/kill-switches";
import { setOrganizationBrand } from "@/lib/platform/org-brand";
import { setOrganizationPlan } from "@/lib/platform/org-plan";
import { setDirectConnectOpen, type SetDirectConnectResult } from "@/lib/platform/direct-connect-flag";
import { confirmPilotUat, setPilotStage, type PilotWriteResult } from "@/lib/platform/pilot";

/**
 * ═══════════ SERVER ACTION VẬN HÀNH KHÁCH PILOT — `/platform/org/<mã>` ═══════════
 *
 * Vỏ của Next: đọc phiên (`requirePermission("platform:operate")`) → lõi ở `lib/platform/pilot.ts` /
 * `lib/platform/kill-switches.ts` (kiểm lại người vận hành của TỔ CHỨC NHÀ, lý do, nhật ký nền tảng) → `revalidatePath`.
 * Mã tổ chức đến từ trình duyệt chỉ là ĐÍCH do người vận hành chọn; lõi không đổi ngữ cảnh tổ chức của phiên.
 */

function refresh(orgCode: unknown) {
  revalidatePath("/platform");
  if (typeof orgCode === "string") revalidatePath(`/platform/org/${encodeURIComponent(orgCode)}`);
}

export async function setPilotStageAction(input: { orgCode: string; stage: string; reason: string; override: boolean }): Promise<PilotWriteResult> {
  const user = await requirePermission("platform:operate");
  const r = await setPilotStage(user, input);
  if ("ok" in r && r.changed) refresh(input?.orgCode);
  return r;
}

export async function confirmPilotUatAction(input: { orgCode: string; note: string }): Promise<PilotWriteResult> {
  const user = await requirePermission("platform:operate");
  const r = await confirmPilotUat(user, input);
  if ("ok" in r) refresh(input?.orgCode);
  return r;
}

export async function setOrgSuspendedAction(input: { orgCode: string; suspend: boolean; reason: string }): Promise<KillSwitchResult> {
  const user = await requirePermission("platform:operate");
  const r = await setOrganizationSuspended(user, input);
  if ("ok" in r && r.changed) refresh(input?.orgCode);
  return r;
}

export async function setWorkflowsPausedAction(input: { orgCode: string; paused: boolean; reason: string }): Promise<KillSwitchResult> {
  const user = await requirePermission("platform:operate");
  const r = await setWorkflowsPaused(user, input);
  if ("ok" in r && r.changed) refresh(input?.orgCode);
  return r;
}

export async function disableOrgConnectionAction(input: { orgCode: string; connectorKey: string; reason: string }): Promise<KillSwitchResult> {
  const user = await requirePermission("platform:operate");
  const r = await disableOrgConnection(user, input);
  if ("ok" in r && r.changed) refresh(input?.orgCode);
  return r;
}

export async function setOrgPlanAction(input: { orgCode: string; planKey: string; reason: string }): Promise<KillSwitchResult> {
  const user = await requirePermission("platform:operate");
  const r = await setOrganizationPlan(user, input);
  if ("ok" in r && r.changed) refresh(input?.orgCode);
  return r;
}

export async function setOrgBrandAction(input: { orgCode: string; brand: string; reason: string }): Promise<KillSwitchResult> {
  const user = await requirePermission("platform:operate");
  const r = await setOrganizationBrand(user, input);
  if ("ok" in r && r.changed) refresh(input?.orgCode);
  return r;
}

/**
 * Cờ «Nối thẳng Facebook» (`meta.direct-connect.open`) — mở cho đúng cửa hàng dựng cho người duyệt Meta App Review. Lõi kiểm lại
 * người vận hành, lý do, mã cửa hàng và ghi nhật ký nền tảng; các trang đọc cờ ở lượt dựng kế tiếp.
 */
export async function setDirectConnectOpenAction(input: { mode: string; orgCodes: string; reason: string }): Promise<SetDirectConnectResult> {
  const user = await requirePermission("platform:operate");
  const r = await setDirectConnectOpen(user, input);
  if ("ok" in r && r.changed) {
    revalidatePath("/platform");
    for (const p of ["/ai/sales-chatbot/messenger", "/ai/sales-chatbot", "/ai/channels"]) revalidatePath(p);
  }
  return r;
}

"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import type { CoreResult } from "@/lib/wholesale/campaigns";
import {
  approveQuotationCore,
  createQuotationCore,
  markQuotationSentCore,
  previewQuotationCore,
  recordQuotationDecisionCore,
  returnQuotationCore,
  reviseQuotationCore,
  submitQuotationCore,
  type QuotationParty,
  type SaveResult,
} from "@/lib/wholesale/quotation";
import type { QuotationResult } from "@/lib/wholesale/quotation-engine";

/**
 * Vỏ Next của Báo giá sỉ. Lõi (`lib/wholesale/quotation.ts`) tự kiểm quyền (`wholesale:work` / `wholesale:config`), phạm vi
 * dữ liệu, zod, gọi bộ tính tất định, ghi và `audit`. Lỗi nghiệp vụ trả `{ error }`, không ném.
 */

function refresh(id?: string, extra?: string) {
  revalidatePath("/wholesale/quotations");
  if (id) revalidatePath(`/wholesale/quotations/${id}`);
  if (extra) revalidatePath(`/wholesale/quotations/${extra}`);
}

export async function previewQuotationAction(input: unknown): Promise<CoreResult<{ result: QuotationResult; party: QuotationParty }>> {
  const user = await requireUser();
  return previewQuotationCore(user, input);
}

export async function createQuotationAction(input: unknown): Promise<CoreResult<SaveResult>> {
  const user = await requireUser();
  const r = await createQuotationCore(user, input);
  if ("ok" in r) refresh(r.id);
  return r;
}

export async function reviseQuotationAction(id: string, input: unknown): Promise<CoreResult<SaveResult>> {
  const user = await requireUser();
  const r = await reviseQuotationCore(user, id, input);
  if ("ok" in r) refresh(r.id, id);
  return r;
}

export async function submitQuotationAction(id: string): Promise<CoreResult<{ status: string; replayed: boolean }>> {
  const user = await requireUser();
  const r = await submitQuotationCore(user, id);
  if ("ok" in r) refresh(id);
  return r;
}

export async function approveQuotationAction(id: string): Promise<CoreResult<{ status: string; replayed: boolean }>> {
  const user = await requireUser();
  const r = await approveQuotationCore(user, id);
  if ("ok" in r) refresh(id);
  return r;
}

export async function returnQuotationAction(id: string, reason: string): Promise<CoreResult<{ status: string; replayed: boolean }>> {
  const user = await requireUser();
  const r = await returnQuotationCore(user, id, reason);
  if ("ok" in r) refresh(id);
  return r;
}

export async function markQuotationSentAction(id: string): Promise<CoreResult<{ status: string; replayed: boolean }>> {
  const user = await requireUser();
  const r = await markQuotationSentCore(user, id);
  if ("ok" in r) refresh(id);
  return r;
}

export async function recordQuotationDecisionAction(id: string, input: unknown): Promise<CoreResult<{ status: string; replayed: boolean }>> {
  const user = await requireUser();
  const r = await recordQuotationDecisionCore(user, id, input);
  if ("ok" in r) refresh(id);
  return r;
}

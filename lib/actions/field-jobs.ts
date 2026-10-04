"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import {
  addFieldJobPhotoCore,
  createFieldJobCore,
  deleteFieldJobPhotoCore,
  moveFieldJobCore,
  openFieldJobRevisitCore,
  recordFieldJobReceiptCore,
  updateFieldJobQuoteCore,
  voidFieldJobReceiptCore,
  type FieldJobCreateInput,
  type FieldJobMoveInput,
  type FieldJobQuoteInput,
  type FieldJobResult,
} from "@/lib/records/field-jobs";

/** Vỏ Next của phiếu công việc. Lõi (`lib/records/field-jobs.ts`) tự kiểm `field_jobs:write`. */

function refresh(jobId?: string) {
  revalidatePath("/field-jobs");
  if (jobId) revalidatePath(`/field-jobs/${jobId}`);
}

export async function createFieldJobAction(input: FieldJobCreateInput): Promise<FieldJobResult> {
  const user = await requireUser();
  const r = await createFieldJobCore(user, input);
  if (r.ok) refresh();
  return r;
}

export async function updateFieldJobQuoteAction(jobId: string, input: FieldJobQuoteInput): Promise<FieldJobResult> {
  const user = await requireUser();
  const r = await updateFieldJobQuoteCore(user, jobId, input);
  if (r.ok) refresh(jobId);
  return r;
}

export async function moveFieldJobAction(jobId: string, input: FieldJobMoveInput): Promise<FieldJobResult> {
  const user = await requireUser();
  const r = await moveFieldJobCore(user, jobId, input);
  if (r.ok) refresh(jobId);
  return r;
}

export async function recordFieldJobReceiptAction(jobId: string, input: { amount: number; method: string; note: string }): Promise<FieldJobResult> {
  const user = await requireUser();
  const r = await recordFieldJobReceiptCore(user, jobId, input);
  if (r.ok) refresh(jobId);
  return r;
}

export async function voidFieldJobReceiptAction(jobId: string, receiptId: string, reason: string): Promise<FieldJobResult> {
  const user = await requireUser();
  const r = await voidFieldJobReceiptCore(user, receiptId, reason);
  if (r.ok) refresh(jobId);
  return r;
}

export async function addFieldJobPhotoAction(jobId: string, input: { phase: string; contentType: string; base64: string }): Promise<FieldJobResult> {
  const user = await requireUser();
  const r = await addFieldJobPhotoCore(user, jobId, input);
  if (r.ok) refresh(jobId);
  return r;
}

export async function deleteFieldJobPhotoAction(jobId: string, photoId: string): Promise<FieldJobResult> {
  const user = await requireUser();
  const r = await deleteFieldJobPhotoCore(user, photoId);
  if (r.ok) refresh(jobId);
  return r;
}

export async function openFieldJobRevisitAction(jobId: string, issue: string): Promise<FieldJobResult> {
  const user = await requireUser();
  const r = await openFieldJobRevisitCore(user, jobId, issue);
  if (r.ok) refresh(jobId);
  return r;
}

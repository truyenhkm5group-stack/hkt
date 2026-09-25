"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import type { Actor } from "@/lib/constants/actor";
import { SAMPLE_REVIEW_DECISIONS } from "@/lib/constants/production-os";
import { describeFollow } from "@/lib/production/lifecycle";
import { createSampleCore, reviewSampleCore, submitSampleCore, updateSampleCore } from "@/lib/production/samples";

/**
 * ═══════════ SERVER ACTION: MẪU · DUYỆT MẪU ═══════════
 *
 * Ghi mẫu / gửi duyệt / yêu cầu sửa: `production:write`. Duyệt / loại: `production:approve` — đọc Ở ĐÂY
 * từ phiên đăng nhập và truyền vào lõi dưới tên `canApprove` (lõi từ chối khi `false`). Không có đường
 * máy: người duyệt luôn là `users.id` của phiên này.
 */
type Result<T = object> = ({ ok: true } & T) | { error: string };

const urlList = z.array(z.string().trim().url("Link ảnh phải là URL http(s)").max(600).refine((u) => /^https?:\/\//i.test(u), "Chỉ nhận link http(s)")).max(20).default([]);

const fieldsSchema = z.object({
  supplierId: z.string().trim().min(1).nullable().default(null),
  costVnd: z.number().int("Tiền là số nguyên VND").min(0).max(100_000_000).nullable().default(null),
  images: urlList,
  notes: z.string().trim().max(3000).default(""),
  problems: z.string().trim().max(3000).default(""),
});

const createSchema = z.object({ modelId: z.string().min(1, "Chọn mẫu"), topicId: z.string().trim().min(1).nullable().default(null), fields: fieldsSchema });
const updateSchema = z.object({ sampleId: z.string().min(1), fields: fieldsSchema });
const reviewSchema = z.object({ sampleId: z.string().min(1), decision: z.enum(SAMPLE_REVIEW_DECISIONS), note: z.string().trim().max(3000).nullable().default(null) });

function actorOf(user: { id: string; name: string | null; email: string }): Actor {
  return { id: user.id, label: user.name || user.email };
}

function revalidateProduction() {
  revalidatePath("/production", "layout");
  revalidatePath("/work");
}

export async function createSample(input: unknown): Promise<Result<{ sampleId: string; version: number; lifecycle: string | null }>> {
  const user = await requireUser();
  if (!can(user, "production:write")) return { error: "Không có quyền ghi mẫu" };
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const db = await getDb();
  const r = await createSampleCore(db, { ...parsed.data, actor: actorOf(user) });
  if ("error" in r) return r;
  await audit({ userId: user.id, userEmail: user.email, action: "SAMPLE_CREATE", entity: "SAMPLE", entityId: r.sampleId, after: { modelId: parsed.data.modelId, version: r.version }, detail: { lifecycle: r.lifecycle } });
  revalidateProduction();
  revalidatePath(`/models/${parsed.data.modelId}`);
  return { ok: true, sampleId: r.sampleId, version: r.version, lifecycle: describeFollow(r.lifecycle) };
}

export async function updateSample(input: unknown): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "production:write")) return { error: "Không có quyền sửa mẫu" };
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const db = await getDb();
  const r = await updateSampleCore(db, { ...parsed.data, actor: actorOf(user) });
  if ("error" in r) return r;
  await audit({ userId: user.id, userEmail: user.email, action: "SAMPLE_UPDATE", entity: "SAMPLE", entityId: parsed.data.sampleId, after: parsed.data.fields });
  revalidateProduction();
  return { ok: true };
}

export async function submitSample(sampleId: string): Promise<Result<{ noop: boolean; lifecycle: string | null }>> {
  const user = await requireUser();
  if (!can(user, "production:write")) return { error: "Không có quyền" };
  if (!sampleId) return { error: "Thiếu mẫu" };
  const db = await getDb();
  const r = await submitSampleCore(db, { sampleId, actor: actorOf(user) });
  if ("error" in r) return r;
  if (!r.noop) {
    await audit({ userId: user.id, userEmail: user.email, action: "SAMPLE_SUBMIT", entity: "SAMPLE", entityId: sampleId, after: { status: "SUBMITTED" }, detail: { lifecycle: r.lifecycle } });
    revalidateProduction();
  }
  return { ok: true, noop: r.noop, lifecycle: r.lifecycle ? describeFollow(r.lifecycle) : null };
}

export async function reviewSample(input: unknown): Promise<Result<{ status: string; designVersion: number | null; lifecycle: string | null }>> {
  const user = await requireUser();
  if (!can(user, "production:write") && !can(user, "production:approve")) return { error: "Không có quyền duyệt mẫu" };
  const parsed = reviewSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const db = await getDb();
  const r = await reviewSampleCore(db, { ...parsed.data, actor: actorOf(user), canApprove: can(user, "production:approve") });
  if ("error" in r) return r;
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "SAMPLE_REVIEW",
    entity: "SAMPLE",
    entityId: parsed.data.sampleId,
    after: { decision: parsed.data.decision, status: r.status, designVersionId: r.designVersionId },
    reason: parsed.data.note ?? undefined,
    detail: { lifecycle: r.lifecycle },
  });
  revalidateProduction();
  return { ok: true, status: r.status, designVersion: r.designVersion, lifecycle: r.lifecycle ? describeFollow(r.lifecycle) : null };
}

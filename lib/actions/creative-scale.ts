"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { SCALE_KINDS } from "@/lib/constants/creative-loop";
import { activateScaleDraft, buildScaleDraft, dismissScaleDraft, pauseScaleDraft, scaleLaunchProposal, type ScaleLaunchProposal } from "@/lib/creative/scale";

/**
 * ═══════════ SCALE MẪU THẮNG — NHỮNG CÚ BẤM CỦA NGƯỜI ═══════════
 *
 * Đặc tả: `docs/creative-loop.md` §5f. Mẫu hai bước: `lib/actions/ads-budget.ts` (đề nghị → phiếu HMAC → áp).
 *
 *   · `draftScaleCampaign`   — "Dựng nháp": máy sao chép chiến dịch mẫu, thay bài, đặt ngân sách. Mọi thứ TẮT.
 *   · `proposeScaleLaunch`   — CHỈ ĐỌC: số sẽ bật + PHIẾU của chính người bấm.
 *   · `launchScaleDraft`     — "Duyệt chạy": nhận lại phiếu, tính lại, đọc lại bản sao, bật mẩu → nhóm → chiến dịch.
 *   · `pauseScaleCampaign`   — tắt chiến dịch scale đang chạy (chỉ làm GIẢM tiền).
 *   · `dismissScaleProposal` — "Bỏ qua" đề nghị / nháp hỏng. Không gọi Facebook.
 *
 * Tệp này KHÔNG gọi mạng: mọi lời gọi đi qua `lib/creative/scale.ts` → `lib/integrations/facebook/ads-write.ts`.
 * Quyền dùng lại `expenses:write` như duyệt lô / tiêu thêm (docs/creative-loop.md §8). Người thao tác lưu
 * bằng `users.id`; tên do MÁY CHỦ đọc từ `users` (AGENTS.md mục 34).
 */

const PATH = "/marketing/creatives";

type Fail = { error: string };

async function actorOf(user: { id: string; email: string }): Promise<{ id: string; label: string }> {
  const db = await getDb();
  const [u] = await db.select({ name: schema.users.name, email: schema.users.email }).from(schema.users).where(eq(schema.users.id, user.id)).limit(1);
  return { id: user.id, label: u?.name || u?.email || user.email };
}

const draftSchema = z.object({ variantId: z.string().trim().min(1), kind: z.enum(SCALE_KINDS) }).strict();

export async function draftScaleCampaign(raw: { variantId: string; kind: string }): Promise<{ ok: true; detail: string } | Fail> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
  const parsed = draftSchema.safeParse(raw);
  if (!parsed.success) return { error: "Đầu vào không hợp lệ" };
  const db = await getDb();
  const actor = await actorOf(user);
  const r = await buildScaleDraft(db, { ...parsed.data, actor }, new Date());
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: r.ok ? "CREATIVE_SCALE_DRAFTED" : "CREATIVE_SCALE_DRAFT_FAILED",
    entity: "CREATIVE_VARIANT",
    entityId: parsed.data.variantId,
    after: { kind: parsed.data.kind, ok: r.ok, denial: r.ok ? null : r.denial },
    reason: r.detail,
  });
  revalidatePath(PATH);
  return r.ok ? { ok: true, detail: r.detail } : { error: r.detail };
}

const idSchema = z.object({ draftId: z.string().trim().min(1) }).strict();

/** BƯỚC 1 — ĐỀ NGHỊ BẬT. Chỉ đọc, không ghi một dòng nào, không gọi Facebook. */
export async function proposeScaleLaunch(raw: { draftId: string }): Promise<ScaleLaunchProposal | Fail> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
  const parsed = idSchema.safeParse(raw);
  if (!parsed.success) return { error: "Đầu vào không hợp lệ" };
  return scaleLaunchProposal(await getDb(), parsed.data.draftId, user.id, new Date());
}

const launchSchema = z
  .object({
    draftId: z.string().trim().min(1),
    ticket: z.string().min(8),
    signed: z
      .object({
        draftId: z.string(),
        campaignId: z.string(),
        adsetId: z.string(),
        adId: z.string(),
        creativeId: z.string(),
        dailyBudgetVnd: z.number().int(),
        budgetLevel: z.string(),
      })
      .strict(),
  })
  .strict();

export type LaunchScaleInput = z.infer<typeof launchSchema>;

/** BƯỚC 2 — BẬT. Mọi con số tính lại từ CSDL; số trên phiếu chỉ dùng để SO. */
export async function launchScaleDraft(raw: LaunchScaleInput): Promise<{ ok: true; detail: string } | Fail> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
  const parsed = launchSchema.safeParse(raw);
  if (!parsed.success) return { error: "Đầu vào không hợp lệ" };
  const db = await getDb();
  const actor = await actorOf(user);
  const r = await activateScaleDraft(db, { ...parsed.data, actor }, new Date());
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: r.ok ? "CREATIVE_SCALE_ACTIVATED" : "CREATIVE_SCALE_ACTIVATE_FAILED",
    entity: "CREATIVE_SCALE_DRAFT",
    entityId: parsed.data.draftId,
    after: { ok: r.ok, denial: r.ok ? null : r.denial, signed: parsed.data.signed },
    reason: r.detail,
  });
  revalidatePath(PATH);
  return r.ok ? { ok: true, detail: r.detail } : { error: r.detail };
}

export async function pauseScaleCampaign(raw: { draftId: string }): Promise<{ ok: true; detail: string } | Fail> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
  const parsed = idSchema.safeParse(raw);
  if (!parsed.success) return { error: "Đầu vào không hợp lệ" };
  const db = await getDb();
  const actor = await actorOf(user);
  const r = await pauseScaleDraft(db, { draftId: parsed.data.draftId, actor }, new Date());
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: r.ok ? "CREATIVE_SCALE_PAUSED" : "CREATIVE_SCALE_PAUSE_FAILED",
    entity: "CREATIVE_SCALE_DRAFT",
    entityId: parsed.data.draftId,
    after: { ok: r.ok, denial: r.ok ? null : r.denial },
    reason: r.detail,
  });
  revalidatePath(PATH);
  return r.ok ? { ok: true, detail: r.detail } : { error: r.detail };
}

export async function dismissScaleProposal(raw: { draftId: string }): Promise<{ ok: true; detail: string } | Fail> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
  const parsed = idSchema.safeParse(raw);
  if (!parsed.success) return { error: "Đầu vào không hợp lệ" };
  const db = await getDb();
  const actor = await actorOf(user);
  const r = await dismissScaleDraft(db, { draftId: parsed.data.draftId, actor }, new Date());
  await audit({ userId: user.id, userEmail: user.email, action: "CREATIVE_SCALE_DISMISSED", entity: "CREATIVE_SCALE_DRAFT", entityId: parsed.data.draftId, after: { ok: r.ok }, reason: r.detail });
  revalidatePath(PATH);
  return r.ok ? { ok: true, detail: r.detail } : { error: r.detail };
}

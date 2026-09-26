"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { priceWarnings } from "@/lib/creative/copy-edit";
import { captionManualGenImage, drawManualGen, promoteManualGenImage, reviewManualGenImage, startManualDesignGen, startManualGen } from "@/lib/creative/manual-gen";
import type { CreativeLoopConfig } from "@/lib/constants/creative-loop";
import { readCurrentCreativeConfig } from "@/lib/queries/creative-loop";
import { manualDesignStartSchema, manualGenPromoteSchema, manualGenReviewSchema, manualGenStartSchema } from "@/lib/validation/creative";

/**
 * ═══════════ VÒNG MẪU — GEN ẢNH BẰNG TAY (chủ shop 25/09/2026, §5i) ═══════════
 *
 * Mọi luật nằm ở `lib/creative/manual-gen.ts`. Tệp này chỉ: kiểm quyền → lược đồ → đọc tên người thao tác
 * từ MÁY CHỦ (AGENTS.md mục 34) → gọi đường ghi → nhật ký.
 *
 * Quyền `ideas:write` — cùng quyền tải mẫu tự làm / soạn câu chữ: gen ảnh và đưa vào lô là BIÊN TẬP nội
 * dung. Tiền quảng cáo vẫn chỉ đi sau lượt duyệt lô (`expenses:write`); tiền VẼ ẢNH đi qua trần ảnh / ngày
 * chung với lô hằng ngày.
 *
 * "Gen ảnh" KHÔNG vẽ trong action: ghi lượt rồi trả lời ngay, việc vẽ chạy trong `after()` (sau phản hồi,
 * trên tiến trình máy chủ Node) — lượt vòng mẫu vẽ nốt nếu tiến trình ấy chết. Màn hình tự tải lại để hiện
 * tiến độ.
 */

const PATH = "/marketing/creatives";

type Fail = { error: string };

async function actorOf(userId: string, fallback: string) {
  const db = await getDb();
  const who = await db.query.users.findFirst({ where: eq(schema.users.id, userId), columns: { name: true, email: true } });
  return { id: userId, name: who?.name?.trim() || who?.email || fallback };
}

export async function startManualGenRun(raw: unknown): Promise<{ ok: true; genId: string; requested: number; allowed: number; note: string | null } | Fail> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Bạn không có quyền gen ảnh" };
  const parsed = manualGenStartSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const db = await getDb();
  const actor = await actorOf(user.id, user.email);
  const { config } = await readCurrentCreativeConfig(db);
  const r = await startManualGen(db, { productPhotoSourceId: d.productPhotoSourceId, ownAdSourceId: d.ownAdSourceId || null, idea: d.idea }, config, actor, new Date());
  if (!r.ok) return { error: r.error };

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "CREATIVE_MANUAL_GEN_START",
    entity: "CREATIVE_MANUAL_GEN",
    entityId: r.genId,
    after: { productPhotoSourceId: d.productPhotoSourceId, ownAdSourceId: d.ownAdSourceId || null, idea: d.idea, requested: r.requested, allowed: r.allowed, capped: r.reason },
  });
  drawAfterResponse(r.genId, config);
  revalidatePath(PATH);
  return { ok: true, genId: r.genId, requested: r.requested, allowed: r.allowed, note: r.reason };
}

/** Vẽ SAU phản hồi — nút bấm không treo. Lỗi ở đây không làm hỏng gì: ảnh còn `PLANNED` thì lượt vòng mẫu vẽ nốt. */
function drawAfterResponse(genId: string, config: CreativeLoopConfig) {
  after(async () => {
    try {
      await drawManualGen(await getDb(), { genId, config });
    } catch (e) {
      console.error("[creative-manual-gen] vẽ sau phản hồi lỗi:", e instanceof Error ? e.message : String(e));
    }
  });
}

/** "Gen thiết kế mới" — mỗi ảnh một THIẾT KẾ MỚI lai DNA của các mẫu bán tốt người chọn (§5i, kiểu `DESIGN`). */
export async function startManualDesignRun(raw: unknown): Promise<{ ok: true; genId: string; requested: number; allowed: number; note: string | null } | Fail> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Bạn không có quyền gen ảnh" };
  const parsed = manualDesignStartSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const db = await getDb();
  const actor = await actorOf(user.id, user.email);
  const { config } = await readCurrentCreativeConfig(db);
  const r = await startManualDesignGen(db, { inspirationProductIds: d.inspirationProductIds, idea: d.idea }, config, actor, new Date());
  if (!r.ok) return { error: r.error };

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "CREATIVE_MANUAL_GEN_START",
    entity: "CREATIVE_MANUAL_GEN",
    entityId: r.genId,
    after: { kind: "DESIGN", inspirationProductIds: d.inspirationProductIds, idea: d.idea, requested: r.requested, allowed: r.allowed, note: r.reason },
  });
  drawAfterResponse(r.genId, config);
  revalidatePath(PATH);
  return { ok: true, genId: r.genId, requested: r.requested, allowed: r.allowed, note: r.reason };
}

export async function reviewManualGenImageAction(raw: unknown): Promise<{ ok: true; status: "APPROVED" | "REJECTED"; captionError: string | null } | Fail> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Không có quyền" };
  const parsed = manualGenReviewSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const db = await getDb();
  const actor = await actorOf(user.id, user.email);
  const r = await reviewManualGenImage(db, { imageId: d.imageId, decision: d.decision, reason: d.reason }, actor, new Date());
  if (!r.ok) return { error: r.error };
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: d.decision === "APPROVE" ? "CREATIVE_MANUAL_GEN_APPROVED" : "CREATIVE_MANUAL_GEN_REJECTED",
    entity: "CREATIVE_MANUAL_GEN_IMAGE",
    entityId: d.imageId,
    after: { status: r.status, caption: r.caption ? (r.caption.ok ? "OK" : r.caption.error) : null },
    reason: d.reason || undefined,
  });
  revalidatePath(PATH);
  return { ok: true, status: r.status, captionError: r.caption && !r.caption.ok ? r.caption.error : null };
}

const recaptionSchema = z.object({ imageId: z.string().trim().min(1) }).strict();

/** "AI viết lại" câu chữ theo ảnh cho một ảnh đã duyệt (ghi đè câu đang có của dòng ảnh, CHƯA vào lô). */
export async function recaptionManualGenImage(raw: unknown): Promise<{ ok: true; headline: string; primaryText: string } | Fail> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Không có quyền" };
  const parsed = recaptionSchema.safeParse(raw);
  if (!parsed.success) return { error: "Đầu vào không hợp lệ" };
  const db = await getDb();
  const r = await captionManualGenImage(db, parsed.data.imageId, new Date());
  if (!r.ok) return { error: r.error };
  revalidatePath(PATH);
  return { ok: true, headline: r.headline, primaryText: r.primaryText };
}

export async function promoteManualGenImageAction(raw: unknown): Promise<{ ok: true; batchDay: string; slot: number; names: { campaign: string; adset: string; ad: string }; designCode: string | null; warnings: string[] } | Fail> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Không có quyền đưa bài vào lô" };
  const parsed = manualGenPromoteSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const db = await getDb();
  const actor = await actorOf(user.id, user.email);
  const { config } = await readCurrentCreativeConfig(db);
  const r = await promoteManualGenImage(
    db,
    { imageId: d.imageId, headline: d.headline, primaryText: d.primaryText, names: { campaign: d.campaignName, adset: d.adsetName, ad: d.adName }, predictedSeq: d.predictedSeq },
    config,
    actor,
    new Date(),
  );
  if (!r.ok) return { error: r.error };
  // Giá khác giá ERP (mockup) / giá đề nghị (thiết kế): cảnh báo, không chặn — cùng luật với mẫu tự làm.
  const warnings = priceWarnings(`${d.headline}\n${d.primaryText}`, r.priceVnd);
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "CREATIVE_MANUAL_GEN_PROMOTED",
    entity: "CREATIVE_VARIANT",
    entityId: r.variantId,
    after: { imageId: d.imageId, batchId: r.batchId, batchDay: r.batchDay, slot: r.slot, nameSeq: r.nameSeq, names: r.names, designCode: r.designCode, warnings },
  });
  revalidatePath(PATH);
  return { ok: true, batchDay: r.batchDay, slot: r.slot, names: r.names, designCode: r.designCode, warnings };
}

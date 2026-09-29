"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { priceWarnings } from "@/lib/creative/copy-edit";
import { writeCopyOptions, captionManualGenImage, drawManualGen, publishManualGenImageInstant, republishVariantInstant, startManualEdit, reviewManualGenImage, requeueFailedManualGenImage, saveManualGenDraft, startManualDesignGen, startManualGen, unqueueManualGenDraft, type InstantOutcome } from "@/lib/creative/manual-gen";
import { searchAdGeoLocations, type GeoSearchHit } from "@/lib/integrations/facebook/ads-write";
import { readCurrentCreativeConfig } from "@/lib/queries/creative-loop";
import { loadManualGenImagePrompt } from "@/lib/queries/creative-manual-gen";
import { copyOptionsSchema, creativeRepublishSchema, manualDesignStartSchema, manualEditStartSchema, manualGenDraftSchema, manualGenInstantSchema, manualGenReviewSchema, manualGenStartSchema } from "@/lib/validation/creative";
import { bindOrganization } from "@/lib/platform/background";

/**
 * ═══════════ VÒNG MẪU — GEN ẢNH BẰNG TAY (chủ shop 25/09/2026, §5i) ═══════════
 *
 * Mọi luật nằm ở `lib/creative/manual-gen.ts`. Tệp này chỉ: kiểm quyền → lược đồ → đọc tên người thao tác
 * từ MÁY CHỦ (AGENTS.md mục 34) → gọi đường ghi → nhật ký.
 *
 * Quyền `ideas:write` — cùng quyền tải mẫu tự làm / soạn câu chữ: gen ảnh và đưa vào lô là BIÊN TẬP nội
 * dung. Tiền quảng cáo vẫn chỉ đi sau lượt duyệt (`expenses:write`): "Đăng camp" là soạn bài VÀ duyệt chi trong
 * một cú bấm, nên đòi CẢ HAI quyền. Tiền VẼ ẢNH không còn trần / ngày (chủ shop 26/09/2026) — màn hình in tiền
 * ước tính trước khi bấm và tiền thật từng ảnh / cả lượt sau khi vẽ.
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
  const r = await startManualGen(db, { productPhotoSourceId: d.productPhotoSourceId, ownAdSourceId: d.ownAdSourceId || null, idea: d.idea, count: d.count, uploads: decodeUploads(d.uploads), studio: d.studio }, config, actor);
  if (!r.ok) return { error: r.error };

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "CREATIVE_MANUAL_GEN_START",
    entity: "CREATIVE_MANUAL_GEN",
    entityId: r.genId,
    after: { productPhotoSourceId: d.productPhotoSourceId, ownAdSourceId: d.ownAdSourceId || null, idea: d.idea, requested: r.requested, uploads: d.uploads.length, studio: d.studio },
  });
  await drawAfterResponse(r.genId);
  revalidatePath(PATH);
  return { ok: true, genId: r.genId, requested: r.requested, allowed: r.allowed, note: r.reason };
}

/**
 * "Sửa ảnh" — từ một ảnh đã tạo, vẽ 1–4 ảnh mới theo yêu cầu sửa (đổi màu · kiểu trình bày · chi tiết). Cùng quyền và cùng
 * đường vẽ-sau-phản-hồi với "Gen ảnh"; ảnh mới vào một lượt `EDIT` chờ duyệt như mọi ảnh gen tay.
 */
export async function startManualEditRun(raw: unknown): Promise<{ ok: true; genId: string; requested: number } | Fail> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Bạn không có quyền gen ảnh" };
  const parsed = manualEditStartSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const db = await getDb();
  const actor = await actorOf(user.id, user.email);
  const { config } = await readCurrentCreativeConfig(db);
  const r = await startManualEdit(db, { sourceImageId: d.sourceImageId, request: { color: d.color, layout: d.layout, detail: d.detail }, count: d.count }, config, actor);
  if (!r.ok) return { error: r.error };
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "CREATIVE_MANUAL_GEN_START",
    entity: "CREATIVE_MANUAL_GEN",
    entityId: r.genId,
    after: { kind: "EDIT", sourceImageId: d.sourceImageId, color: d.color, layout: d.layout, detail: d.detail, requested: r.requested },
  });
  await drawAfterResponse(r.genId);
  revalidatePath(PATH);
  return { ok: true, genId: r.genId, requested: r.requested };
}

/** Ảnh tải lên (base64 đã qua lược đồ) ⇒ byte. Đường ghi tự kiểm loại ảnh / kích thước khi lưu. */
function decodeUploads(list: readonly string[]): Uint8Array[] {
  return list.map((b64) => new Uint8Array(Buffer.from(b64, "base64")));
}

/** Vẽ SAU phản hồi — nút bấm không treo. Lỗi ở đây không làm hỏng gì: ảnh còn `PLANNED` thì lượt vòng mẫu vẽ nốt. */
async function drawAfterResponse(genId: string) {
  /*
    Tổ chức CHỤP lúc bấm (request còn sống), việc sau phản hồi tự bọc `withOrganization` — không
    dựa vào việc Next có mang ngữ cảnh vào `after()` hay không (audit ISO-16).
  */
  after(await bindOrganization(async () => {
    try {
      await drawManualGen(await getDb(), { genId });
    } catch (e) {
      console.error("[creative-manual-gen] vẽ sau phản hồi lỗi:", e instanceof Error ? e.message : String(e));
    }
  }));
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
  const r = await startManualDesignGen(db, { inspirationProductIds: d.inspirationProductIds, idea: d.idea, count: d.count, uploads: decodeUploads(d.uploads), studio: d.studio }, config, actor, new Date());
  if (!r.ok) return { error: r.error };

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "CREATIVE_MANUAL_GEN_START",
    entity: "CREATIVE_MANUAL_GEN",
    entityId: r.genId,
    after: { kind: "DESIGN", inspirationProductIds: d.inspirationProductIds, idea: d.idea, requested: r.requested, allowed: r.allowed, uploads: d.uploads.length, note: r.reason, studio: d.studio },
  });
  await drawAfterResponse(r.genId);
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

/**
 * "Đăng camp" — ảnh đã duyệt lên Facebook NGAY (chạy ngay hoặc hẹn giờ), không chờ lô 6:00 hôm sau. Mọi luật ở
 * `publishManualGenImageInstant`; action chạy ĐỒNG BỘ (sáu lời gọi Facebook, vài giây) để người bấm thấy ngay
 * camp đã chạy hay vì sao chưa.
 */
export async function publishManualGenImageNowAction(
  raw: unknown,
): Promise<{ ok: true; outcome: InstantOutcome; detail: string; startAt: string; endAt: string; names: { campaign: string; adset: string; ad: string }; designCode: string | null; warnings: string[] } | Fail> {
  const user = await requireUser();
  if (!can(user, "ideas:write") || !can(user, "expenses:write")) return { error: "Đăng camp cần cả quyền soạn bài (ideas:write) lẫn quyền duyệt chi quảng cáo (expenses:write)." };
  const parsed = manualGenInstantSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const db = await getDb();
  const actor = await actorOf(user.id, user.email);
  const { config } = await readCurrentCreativeConfig(db);
  const r = await publishManualGenImageInstant(
    db,
    { imageId: d.imageId, headline: d.headline, primaryText: d.primaryText, names: { campaign: d.campaignName, adset: d.adsetName, ad: d.adName }, predictedSeq: d.predictedSeq, scheduleAt: d.scheduleAt ? new Date(d.scheduleAt) : null, setup: d.setup },
    config,
    actor,
    new Date(),
  );
  if (!r.ok) return { error: r.error };
  const warnings = priceWarnings(`${d.headline}\n${d.primaryText}`, r.priceVnd);
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "CREATIVE_INSTANT_PUBLISH",
    entity: "CREATIVE_VARIANT",
    entityId: r.variantId,
    after: { imageId: d.imageId, batchId: r.batchId, batchDay: r.batchDay, startAt: r.startAt.toISOString(), endAt: r.endAt.toISOString(), scheduled: r.scheduled, outcome: r.outcome, detail: r.detail, names: r.names, designCode: r.designCode, setup: d.setup, warnings },
  });
  revalidatePath(PATH);
  return { ok: true, outcome: r.outcome, detail: r.detail, startAt: r.startAt.toISOString(), endAt: r.endAt.toISOString(), names: r.names, designCode: r.designCode, warnings };
}

/**
 * "Lưu" — bài của ảnh đã duyệt vào HÀNG ĐỢI ĐĂNG CAMP (câu chữ + ba tên). Không dựng lô, không gọi Facebook: chỉ là
 * biên tập nội dung ⇒ quyền `ideas:write`. Đăng từ hàng đợi vẫn qua `publishManualGenImageNowAction` (cần cả
 * `expenses:write`).
 */
export async function saveManualGenDraftAction(raw: unknown): Promise<{ ok: true; queuedAt: string } | Fail> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Không có quyền soạn bài" };
  const parsed = manualGenDraftSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const db = await getDb();
  const actor = await actorOf(user.id, user.email);
  const r = await saveManualGenDraft(db, { imageId: d.imageId, headline: d.headline, primaryText: d.primaryText, names: { campaign: d.campaignName, adset: d.adsetName, ad: d.adName }, setup: d.setup }, actor, new Date());
  if (!r.ok) return { error: r.error };
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "CREATIVE_MANUAL_GEN_QUEUED",
    entity: "CREATIVE_MANUAL_GEN_IMAGE",
    entityId: d.imageId,
    after: { headline: d.headline, primaryText: d.primaryText, names: { campaign: d.campaignName, adset: d.adsetName, ad: d.adName }, setup: d.setup ?? null },
  });
  revalidatePath(PATH);
  return { ok: true, queuedAt: r.queuedAt.toISOString() };
}

/** Bỏ một bài khỏi hàng đợi đăng camp (bản nháp câu chữ vẫn giữ trên ảnh). */
export async function unqueueManualGenDraftAction(raw: unknown): Promise<{ ok: true } | Fail> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Không có quyền" };
  const parsed = recaptionSchema.safeParse(raw);
  if (!parsed.success) return { error: "Đầu vào không hợp lệ" };
  const db = await getDb();
  const r = await unqueueManualGenDraft(db, parsed.data.imageId, new Date());
  if (!r.ok) return { error: r.error };
  await audit({ userId: user.id, userEmail: user.email, action: "CREATIVE_MANUAL_GEN_UNQUEUED", entity: "CREATIVE_MANUAL_GEN_IMAGE", entityId: parsed.data.imageId, after: {} });
  revalidatePath(PATH);
  return { ok: true };
}

const geoSchema = z.object({ q: z.string().trim().min(2, "Gõ ít nhất 2 ký tự").max(80) }).strict();

/** Tìm tỉnh / thành để nhắm vị trí khi Đăng camp — lời gọi ĐỌC Facebook (không ghi, không tốn tiền). */
export async function searchGeoAction(raw: unknown): Promise<{ ok: true; hits: GeoSearchHit[] } | Fail> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Không có quyền" };
  const parsed = geoSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Đầu vào không hợp lệ" };
  try {
    return { ok: true, hits: await searchAdGeoLocations(parsed.data.q) };
  } catch (e) {
    return { error: `Không tìm được vị trí trên Facebook: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** "Trả về hàng đợi" — ảnh đã bấm đăng mà hỏng khi trên Facebook chưa có chiến dịch / nhóm nào (luật ở `requeueFailedManualGenImage`). */
export async function requeueFailedManualGenImageAction(raw: unknown): Promise<{ ok: true } | Fail> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Không có quyền" };
  const parsed = recaptionSchema.safeParse(raw);
  if (!parsed.success) return { error: "Đầu vào không hợp lệ" };
  const db = await getDb();
  const r = await requeueFailedManualGenImage(db, parsed.data.imageId);
  if (!r.ok) return { error: r.error };
  await audit({ userId: user.id, userEmail: user.email, action: "CREATIVE_MANUAL_GEN_REQUEUED", entity: "CREATIVE_MANUAL_GEN_IMAGE", entityId: parsed.data.imageId, after: {} });
  revalidatePath(PATH);
  return { ok: true };
}

/** Câu lệnh đã gửi máy vẽ của một ảnh — mở từ nút "Câu lệnh" trên thẻ ảnh (chỉ đọc). */
export async function loadManualGenPromptAction(raw: unknown): Promise<{ ok: true; prompt: string; idea: string; size: string; quality: string; model: string } | Fail> {
  const user = await requireUser();
  if (!can(user, "ideas:view")) return { error: "Không có quyền" };
  const parsed = z.object({ imageId: z.string().trim().min(1).max(80) }).safeParse(raw);
  if (!parsed.success) return { error: "Thiếu mã ảnh" };
  const r = await loadManualGenImagePrompt(await getDb(), parsed.data.imageId);
  if (!r) return { error: "Không tìm thấy ảnh." };
  return { ok: true, ...r };
}

/**
 * "Đăng lại camp" (tab ④ Đang chạy) — camp MỚI từ ảnh + câu chữ của một mẫu đã lên Facebook, trên TKQC / fanpage / setup người
 * chọn. Cùng quyền với "Đăng camp": soạn bài VÀ duyệt chi (người bấm là lượt duyệt của lô `INSTANT` riêng).
 */
export async function republishVariantAction(raw: unknown): Promise<{ ok: true; outcome: InstantOutcome; detail: string; names: { campaign: string; adset: string; ad: string } } | Fail> {
  const user = await requireUser();
  if (!can(user, "ideas:write") || !can(user, "expenses:write")) return { error: "Đăng lại camp cần cả quyền soạn bài (ideas:write) lẫn quyền duyệt chi quảng cáo (expenses:write)." };
  const parsed = creativeRepublishSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const db = await getDb();
  const actor = await actorOf(user.id, user.email);
  const { config } = await readCurrentCreativeConfig(db);
  const r = await republishVariantInstant(
    db,
    { variantId: d.variantId, headline: d.headline, primaryText: d.primaryText, names: { campaign: d.campaignName, adset: d.adsetName, ad: d.adName }, predictedSeq: d.predictedSeq, scheduleAt: d.scheduleAt ? new Date(d.scheduleAt) : null, setup: d.setup },
    config,
    actor,
    new Date(),
  );
  if (!r.ok) return { error: r.error };
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "CREATIVE_REPUBLISH",
    entity: "CREATIVE_VARIANT",
    entityId: r.variantId,
    after: { from: d.variantId, batchId: r.batchId, startAt: r.startAt.toISOString(), scheduled: r.scheduled, outcome: r.outcome, detail: r.detail, names: r.names, setup: d.setup },
  });
  revalidatePath(PATH);
  return { ok: true, outcome: r.outcome, detail: r.detail, names: r.names };
}

/** "AI viết theo công thức" — N phương án (mỗi phương án một công thức), mặc định không ghi giá. Chỉ trả phương án, không lưu. */
export async function writeCopyOptionsAction(raw: unknown): Promise<{ ok: true; options: { headline: string; primaryText: string; formula?: string }[]; priceStripped: boolean } | Fail> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Bạn không có quyền soạn bài" };
  const parsed = copyOptionsSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const r = await writeCopyOptions(await getDb(), parsed.data.imageId, { formulas: parsed.data.formulas, noPrice: parsed.data.noPrice }, new Date());
  if (!r.ok) return { error: r.error };
  return { ok: true, options: r.options, priceStripped: r.priceStripped };
}

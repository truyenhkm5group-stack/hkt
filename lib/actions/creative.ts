"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { CREATIVE_HARD_LIMITS, CREATIVE_WRITE_DENIAL_REASON } from "@/lib/constants/creative-loop";
import { adsWriteHardEnabled, adsWriteMode } from "@/lib/integrations/facebook/ads-write";
import { gateCreativeWritePrefix } from "@/lib/marketing/creative-write-gate";
import { approvalDigest, batchTicket, verifyBatchTicket } from "@/lib/creative/approval";
import { describeRule } from "@/lib/creative/judge";
import { batchApprovalContent, batchConfig, committedTestSpendForDay, pauseCreativeVariant } from "@/lib/creative/publish";

/**
 * ═══════════ BÀN TAY CỦA VÒNG MẪU — NHỮNG CÚ BẤM CỦA NGƯỜI ═══════════
 *
 * Đặc tả: `docs/creative-loop.md` §0–§3. Mẫu: `lib/actions/ads-budget.ts` (hai bước, phiếu HMAC).
 *
 *   1. `proposeBatchApproval()` — CHỈ ĐỌC. Trả về digest, PHIẾU, tổng tiền sẽ cam kết, khung giờ,
 *      luật tắt, và mọi lý do cổng sẽ chặn — người bấm thấy toàn bộ trước khi có một đồng nào đi.
 *   2. `approveBatch()` — nhận lại phiếu, TÍNH LẠI digest từ CSDL, so phiếu cho ĐÚNG người, rồi mới
 *      chuyển lô sang `APPROVED`. **Action này KHÔNG gọi Facebook**: việc đăng do lượt tick của vòng
 *      làm, và lượt ấy lại tính digest lần nữa trước lời gọi đầu tiên.
 *
 * Quyền: duyệt / từ chối / tắt dùng lại `expenses:write` như bàn tay Nấc 3; gạt một mẫu khỏi lô dùng
 * `ideas:write` (việc biên tập nội dung, chưa chạm tiền). Quyền riêng hẹp hơn là đổi vai trò (mục 7).
 *
 * Tên người duyệt do MÁY CHỦ đọc từ `users` — không nhận từ client (AGENTS.md mục 34).
 *
 * "Cho tiêu thêm" CỐ Ý chưa có action ở đây: cửa ghi (`extendAdset`) và nhánh cổng đã có, nhưng nút
 * bấm cần số đo HỨA HẸN của bộ chấm (gói B) — nối ở bước tích hợp, không đoán trước.
 */

const PATH = "/marketing/creatives";
const T = schema;

type Fail = { error: string };

async function tenNguoiDung(userId: string): Promise<string> {
  const db = await getDb();
  const [u] = await db.select({ name: T.users.name, email: T.users.email }).from(T.users).where(eq(T.users.id, userId)).limit(1);
  return u?.name || u?.email || "";
}

async function loadBatch(batchId: string) {
  const db = await getDb();
  const [b] = await db.select().from(T.creativeBatches).where(eq(T.creativeBatches.id, batchId)).limit(1);
  return b ?? null;
}

export type BatchApprovalProposal = {
  batchId: string;
  batchDay: string;
  digest: string;
  /** Phiếu duyệt. `null` = không duyệt được lúc này, lý do ở `blockers`. */
  ticket: string | null;
  /** Số mẫu trong phiếu (không tính mẫu đã gạt / sinh lỗi). */
  variantCount: number;
  /** Số mẫu SẼ được đăng = min(số mẫu, số mẫu tối đa của lô). */
  publishCount: number;
  budgetPerVariantVnd: number;
  /** Tổng tiền sẽ CAM KẾT trên Facebook = số mẫu đăng × ngân sách một mẫu. */
  totalVnd: number;
  startAt: string;
  endAt: string;
  approvalDeadline: string;
  killRules: string[];
  /** Nơi tiền sẽ chảy — người duyệt phải thấy, không chỉ thấy con số. */
  adAccountId: string;
  testCampaignId: string;
  pageId: string;
  /** Mọi lý do cổng sẽ chặn nếu duyệt bây giờ. Rỗng = không thấy lý do chặn nào. */
  blockers: string[];
  /** Điều nên biết nhưng không chặn. */
  warnings: string[];
};

/** BƯỚC 1 — ĐỀ NGHỊ DUYỆT LÔ. Chỉ đọc, không ghi một dòng nào, không gọi Facebook. */
export async function proposeBatchApproval(batchId: string): Promise<BatchApprovalProposal | Fail> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
  if (!batchId) return { error: "Thiếu mã lô" };
  const b = await loadBatch(batchId);
  if (!b) return { error: "Không tìm thấy lô." };

  const db = await getDb();
  const now = new Date();
  const content = await batchApprovalContent(db, b);
  const digest = approvalDigest(content);
  const { config, budgetPerVariantVnd, configComplete } = batchConfig(b.configSnapshot);
  const tran = Math.min(config.batchSize, CREATIVE_HARD_LIMITS.maxBatchSize);
  const publishCount = Math.min(content.variants.length, tran);
  const totalVnd = publishCount * budgetPerVariantVnd;

  const blockers: string[] = [];
  const warnings: string[] = [];
  if (b.status !== "PENDING_APPROVAL") blockers.push(`Lô đang ở trạng thái ${b.status}, không phải "Chờ duyệt".`);
  if (now.getTime() >= b.approvalDeadline.getTime()) blockers.push("Đã quá hạn duyệt của lô — không đồng nào được chi.");
  if (content.variants.length === 0) blockers.push("Lô không có mẫu nào để duyệt.");
  if (content.variants.some((v) => !v.imageSha256)) blockers.push("Có mẫu chưa có ảnh.");
  // Cổng đăng xem trước NHƯ THỂ lô đã duyệt — nếu không thì mọi lần đều báo "chưa duyệt" và che lý do thật.
  const pre = gateCreativeWritePrefix({ hardEnabled: adsWriteHardEnabled(), mode: adsWriteMode(), action: "CREATE_ADSET", configComplete, approved: true, approvalMatches: true });
  if (!pre.ok) blockers.push(pre.reason);
  if (budgetPerVariantVnd > CREATIVE_HARD_LIMITS.maxBudgetPerVariantVnd) blockers.push(CREATIVE_WRITE_DENIAL_REASON.OVER_VARIANT_BUDGET);
  const daCamKet = await committedTestSpendForDay(db, b.batchDay);
  if (daCamKet + totalVnd > CREATIVE_HARD_LIMITS.maxDailyTestSpendVnd) {
    blockers.push(`${CREATIVE_WRITE_DENIAL_REASON.OVER_DAILY_CAP} (Sổ đã ghi ${daCamKet.toLocaleString("vi-VN")}đ cho ngày ${b.batchDay}.)`);
  }
  if (content.variants.length > tran) warnings.push(`Lô có ${content.variants.length} mẫu nhưng chỉ ${tran} mẫu đầu (theo ô) được đăng — gạt bớt để tự chọn.`);
  if (config.killRules.length === 0) warnings.push("Lô chưa có luật tắt: máy sẽ KHÔNG tự tắt mẫu nào, mỗi mẫu chạy hết ngân sách rồi tự dừng.");

  return {
    batchId: b.id,
    batchDay: b.batchDay,
    digest,
    ticket: blockers.length === 0 ? batchTicket(user.id, b.id, digest) : null,
    variantCount: content.variants.length,
    publishCount,
    budgetPerVariantVnd,
    totalVnd,
    startAt: b.startAt.toISOString(),
    endAt: b.endAt.toISOString(),
    approvalDeadline: b.approvalDeadline.toISOString(),
    killRules: config.killRules.map(describeRule),
    adAccountId: config.adAccountId,
    testCampaignId: config.testCampaignId,
    pageId: config.pageId,
    blockers,
    warnings,
  };
}

const approveSchema = z.object({ batchId: z.string().min(1), ticket: z.string().min(8) });

/**
 * BƯỚC 2 — DUYỆT LÔ. Chỉ đổi trạng thái; KHÔNG gọi Facebook.
 *
 * Phiếu được so với digest TÍNH LẠI ngay lúc bấm: người A xem lô, người B gạt một mẫu, người A bấm
 * duyệt ⇒ digest đã đổi ⇒ phiếu vô hiệu ⇒ người A phải mở lại và thấy đúng lô sẽ chạy.
 */
export async function approveBatch(raw: z.infer<typeof approveSchema>): Promise<{ ok: true; digest: string } | Fail> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
  const parsed = approveSchema.safeParse(raw);
  if (!parsed.success) return { error: "Đầu vào không hợp lệ" };
  const { batchId, ticket } = parsed.data;

  const b = await loadBatch(batchId);
  if (!b) return { error: "Không tìm thấy lô." };
  if (b.status !== "PENDING_APPROVAL") return { error: `Lô đang ở trạng thái ${b.status}, không duyệt được.` };
  const now = new Date();
  if (now.getTime() >= b.approvalDeadline.getTime()) return { error: "Đã quá hạn duyệt của lô." };

  const db = await getDb();
  const content = await batchApprovalContent(db, b);
  if (content.variants.length === 0) return { error: "Lô không có mẫu nào để duyệt." };
  if (content.variants.some((v) => !v.imageSha256)) return { error: "Có mẫu chưa có ảnh — không duyệt được." };
  const { configComplete, budgetPerVariantVnd } = batchConfig(b.configSnapshot);
  if (!configComplete) return { error: CREATIVE_WRITE_DENIAL_REASON.CONFIG_INCOMPLETE };
  if (budgetPerVariantVnd > CREATIVE_HARD_LIMITS.maxBudgetPerVariantVnd) return { error: CREATIVE_WRITE_DENIAL_REASON.OVER_VARIANT_BUDGET };

  const digest = approvalDigest(content);
  if (!verifyBatchTicket(ticket, user.id, b.id, digest)) {
    return { error: "Phiếu duyệt không khớp — nội dung lô đã đổi sau khi bạn mở (hoặc phiếu của người khác). Mở lại để xem đúng lô sẽ chạy." };
  }

  const ten = await tenNguoiDung(user.id);
  const rows = await db
    .update(T.creativeBatches)
    .set({ status: "APPROVED", approvalDigest: digest, approvedByUserId: user.id, approvedByName: ten, approvedAt: now, updatedAt: now })
    .where(and(eq(T.creativeBatches.id, b.id), eq(T.creativeBatches.status, "PENDING_APPROVAL")))
    .returning({ id: T.creativeBatches.id });
  if (rows.length === 0) return { error: "Lô vừa đổi trạng thái — mở lại để xem." };

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "CREATIVE_BATCH_APPROVED",
    entity: "CREATIVE_BATCH",
    entityId: b.id,
    before: { status: b.status },
    after: { status: "APPROVED", digest, variants: content.variants.length, budgetPerVariantVnd, startAt: b.startAt.toISOString(), endAt: b.endAt.toISOString() },
    reason: `Duyệt lô ${b.batchDay}: ${content.variants.length} mẫu × ${budgetPerVariantVnd.toLocaleString("vi-VN")}đ.`,
  });
  revalidatePath(PATH);
  return { ok: true, digest };
}

const rejectBatchSchema = z.object({ batchId: z.string().min(1), reason: z.string().trim().min(1).max(1000) });

/**
 * TỪ CHỐI CẢ LÔ. Được cả khi lô đã duyệt NHƯNG chưa có gì lên Facebook — đó là nút dừng khẩn trước
 * giờ đăng. Lô đã có nhóm quảng cáo thì từ chối không dừng được tiền: phải tắt từng mẫu.
 */
export async function rejectBatch(raw: z.infer<typeof rejectBatchSchema>): Promise<{ ok: true } | Fail> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
  const parsed = rejectBatchSchema.safeParse(raw);
  if (!parsed.success) return { error: "Cần ghi lý do từ chối" };
  const { batchId, reason } = parsed.data;

  const b = await loadBatch(batchId);
  if (!b) return { error: "Không tìm thấy lô." };
  if (b.status !== "PENDING_APPROVAL" && b.status !== "APPROVED") return { error: `Lô đang ở trạng thái ${b.status}, không từ chối được.` };
  const db = await getDb();
  const [daLen] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(T.creativeVariants)
    .where(and(eq(T.creativeVariants.batchId, b.id), isNotNull(T.creativeVariants.fbAdsetId)));
  if (Number(daLen?.n ?? 0) > 0) return { error: "Lô đã có nhóm quảng cáo trên Facebook — từ chối không dừng được tiền. Hãy tắt từng mẫu." };

  const now = new Date();
  const rows = await db
    .update(T.creativeBatches)
    .set({ status: "REJECTED", error: `Từ chối: ${reason}`, updatedAt: now })
    .where(and(eq(T.creativeBatches.id, b.id), inArray(T.creativeBatches.status, ["PENDING_APPROVAL", "APPROVED"])))
    .returning({ id: T.creativeBatches.id });
  if (rows.length === 0) return { error: "Lô vừa đổi trạng thái — mở lại để xem." };

  await audit({ userId: user.id, userEmail: user.email, action: "CREATIVE_BATCH_REJECTED", entity: "CREATIVE_BATCH", entityId: b.id, before: { status: b.status }, after: { status: "REJECTED" }, reason });
  revalidatePath(PATH);
  return { ok: true };
}

const rejectVariantSchema = z.object({ variantId: z.string().min(1), reason: z.string().trim().max(1000).default("") });

/**
 * GẠT MỘT MẪU khỏi lô đang chờ duyệt. Mẫu bị gạt ra khỏi digest, nên mọi phiếu đã phát cho lô ấy tự
 * vô hiệu — người duyệt phải mở lại và thấy lô MỚI.
 */
export async function rejectVariant(raw: { variantId: string; reason?: string }): Promise<{ ok: true } | Fail> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Không có quyền" };
  const parsed = rejectVariantSchema.safeParse(raw);
  if (!parsed.success) return { error: "Đầu vào không hợp lệ" };
  const { variantId, reason } = parsed.data;

  const db = await getDb();
  const [row] = await db
    .select({ v: T.creativeVariants, batchStatus: T.creativeBatches.status })
    .from(T.creativeVariants)
    .innerJoin(T.creativeBatches, eq(T.creativeBatches.id, T.creativeVariants.batchId))
    .where(eq(T.creativeVariants.id, variantId))
    .limit(1);
  if (!row) return { error: "Không tìm thấy mẫu." };
  if (row.batchStatus !== "PENDING_APPROVAL") return { error: "Chỉ gạt được mẫu khi lô đang chờ duyệt." };
  if (row.v.status === "REJECTED") return { ok: true };
  if (row.v.status !== "GENERATED" && row.v.status !== "PLANNED" && row.v.status !== "GEN_FAILED") return { error: `Mẫu đang ở trạng thái ${row.v.status}, không gạt được.` };

  const now = new Date();
  await db
    .update(T.creativeVariants)
    .set({ status: "REJECTED", rejectReason: reason, rejectedByUserId: user.id, updatedAt: now })
    .where(eq(T.creativeVariants.id, variantId));
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "CREATIVE_VARIANT_REJECTED",
    entity: "CREATIVE_VARIANT",
    entityId: variantId,
    before: { status: row.v.status },
    after: { status: "REJECTED" },
    reason: reason || "Gạt khỏi lô lúc duyệt",
  });
  revalidatePath(PATH);
  return { ok: true };
}

const pauseSchema = z.object({ variantId: z.string().min(1) });

/**
 * NGƯỜI TẮT TAY một mẫu đang chạy. Cú bấm của chính người đăng nhập là căn cứ (không cần luật tắt),
 * nhưng vẫn đi qua ĐỦ cổng: chốt cứng env, nấc COPILOT, nhóm phải do vòng tạo. Tắt chỉ làm GIẢM tiền.
 */
export async function pauseVariantNow(raw: { variantId: string }): Promise<{ ok: true; detail: string } | Fail> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
  const parsed = pauseSchema.safeParse(raw);
  if (!parsed.success) return { error: "Đầu vào không hợp lệ" };

  const db = await getDb();
  const ten = (await tenNguoiDung(user.id)) || user.email;
  const r = await pauseCreativeVariant(db, { variantId: parsed.data.variantId, kind: "HUMAN", confirmed: true, actor: { id: user.id, label: user.email } }, new Date(), {
    env: { hardEnabled: adsWriteHardEnabled(), mode: adsWriteMode() },
  });

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: r.ok ? "CREATIVE_VARIANT_PAUSED" : "CREATIVE_VARIANT_PAUSE_FAILED",
    entity: "CREATIVE_VARIANT",
    entityId: parsed.data.variantId,
    after: { ok: r.ok, denial: r.ok ? null : r.denial },
    reason: `${ten} tắt tay · ${r.detail}`,
  });
  revalidatePath(PATH);
  return r.ok ? { ok: true, detail: r.detail } : { error: r.detail };
}

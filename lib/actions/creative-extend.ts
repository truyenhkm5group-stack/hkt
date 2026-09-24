"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { actionToken, verifyActionToken } from "@/lib/ai/policy";
import { CREATIVE_HARD_LIMITS, CREATIVE_VERDICT_LABEL, type CreativeVerdict, type VariantStatus } from "@/lib/constants/creative-loop";
import { approvalDigest } from "@/lib/creative/approval";
import { extensionMatchesTicket, planExtension, type ExtensionInput } from "@/lib/creative/extend";
import { judgeVariant } from "@/lib/creative/judge";
import { REAL_CREATIVE_WRITER, batchApprovalContent, batchConfig, extendedOnDay, logAction } from "@/lib/creative/publish";
import { formatDateTime } from "@/lib/format";
import { adsWriteHardEnabled, adsWriteMode, vndToFbMinor } from "@/lib/integrations/facebook/ads-write";
import { effectiveEndAt, effectiveJudgeConfig, extendedEndAtOf, readCurrentCreativeConfig, variantMetrics } from "@/lib/queries/creative-loop";

/**
 * ═══════════ "CHO TIÊU THÊM" — HAI BƯỚC, KHÔNG BAO GIỜ MỘT ═══════════
 *
 * Đặc tả: `docs/creative-loop.md` §0 (điều suy ra 1: tắt không cần bấm, TIÊU THÊM PHẢI BẤM) và §3.
 * Mẫu: `lib/actions/ads-budget.ts` (đề nghị → phiếu HMAC → áp).
 *
 *   1. `proposeExtension()` — CHỈ ĐỌC. Đo mẫu, chấm SỐNG, tính số tiền / ngân sách mới / khung mới
 *      (hàm thuần `planExtension`), chạy cổng nhánh `EXTEND_ADSET`, trả PHIẾU hoặc lý do bị chặn.
 *   2. `applyExtension()`   — nhận lại phiếu, TÍNH LẠI toàn bộ từ CSDL (không tin số từ client), chạy
 *      cổng lần nữa, gọi `extendAdset` qua CỬA GHI (`REAL_CREATIVE_WRITER`), ghi sổ
 *      `creative_fb_actions` — kể cả lượt bị chặn / hỏng.
 *
 * Tệp này KHÔNG gọi mạng: mọi lời gọi Facebook đi qua `lib/integrations/facebook/ads-write.ts`.
 * Quyền dùng lại `expenses:write` như duyệt lô (docs/creative-loop.md §8). Người thao tác lưu bằng
 * `users.id` + email do MÁY CHỦ đọc từ phiên (AGENTS.md mục 34).
 */

const PATH = "/marketing/creatives";
/** Tên tool trong phiếu. Đổi chuỗi này là vô hiệu hoá mọi phiếu đang lưu hành — đó là ý muốn. */
const TOOL = "CREATIVE_EXTEND";
const T = schema;

type Fail = { error: string };

export type ExtensionProposal = {
  variantId: string;
  batchDay: string;
  slot: number;
  headline: string;
  verdict: CreativeVerdict;
  verdictLabel: string;
  reasons: string[];
  /** Ngân sách trọn đời đã cam kết. `null` = CHƯA BIẾT. */
  currentLifetimeVnd: number | null;
  addVnd: number | null;
  /** Số tiền thêm đã bị kẹp bởi trần một lượt bấm. */
  clamped: boolean;
  newLifetimeVnd: number | null;
  currentEndAt: string;
  newEndAt: string | null;
  extendedTodayVnd: number;
  perClickCapVnd: number;
  dailyCapVnd: number;
  /** Phiếu. `null` = không cho tiêu thêm được lúc này, lý do ở `blocked`. */
  ticket: string | null;
  blocked: string | null;
};

/** Đầu vào ký trong phiếu — ĐÚNG những gì quyết định hậu quả, không hơn. */
function tokenPayload(i: { variantId: string; addVnd: number; newLifetimeVnd: number; newEndAt: string }) {
  return { variantId: i.variantId, addVnd: i.addVnd, newLifetimeVnd: i.newLifetimeVnd, newEndAt: i.newEndAt };
}

/**
 * Hạn hiện tại của nhóm: `end_time` của lượt tiêu thêm ĐÃ ÁP gần nhất, không có thì cuối khung test.
 * Đọc trên SỔ (thứ đã thật sự gửi Facebook), không trên một cột suy ra.
 */
async function currentEndAtOf(db: Db, variantId: string, batchEndAt: Date): Promise<Date> {
  return effectiveEndAt(batchEndAt, (await extendedEndAtOf(db, [variantId])).get(variantId));
}

type Ctx = {
  v: typeof T.creativeVariants.$inferSelect;
  b: typeof T.creativeBatches.$inferSelect;
  verdict: CreativeVerdict;
  reasons: string[];
  input: Omit<ExtensionInput, "approved" | "approvalMatches">;
  digestMatches: boolean;
  currency: "VND" | "USD";
};

/** Mọi thứ phép tính cần, đọc lại từ CSDL — bước đề nghị và bước áp gọi CHUNG hàm này. */
async function loadContext(db: Db, variantId: string, now: Date): Promise<Ctx | Fail> {
  const [row] = await db
    .select({ v: T.creativeVariants, b: T.creativeBatches })
    .from(T.creativeVariants)
    .innerJoin(T.creativeBatches, eq(T.creativeBatches.id, T.creativeVariants.batchId))
    .where(eq(T.creativeVariants.id, variantId))
    .limit(1);
  if (!row) return { error: "Không tìm thấy mẫu." };
  const { v, b } = row;

  const { config: current } = await readCurrentCreativeConfig(db);
  const metrics = (await variantMetrics(db, [{ id: v.id, fbAdId: v.fbAdId, startAt: b.startAt }])).get(v.id);
  if (!metrics) return { error: "Không đọc được số đo của mẫu." };
  // Phán quyết SỐNG — luật tắt của ảnh chụp lô, luật giữ hiện tại (xem `effectiveJudgeConfig`).
  const j = judgeVariant({ status: v.status as VariantStatus, startAt: b.startAt, endAt: b.endAt, libraryAt: v.libraryAt, metrics }, effectiveJudgeConfig(b.configSnapshot, current), now);

  const snap = batchConfig(b.configSnapshot);
  const digestMatches = b.approvalDigest !== "" && approvalDigest(await batchApprovalContent(db, b)) === b.approvalDigest;
  const env = { hardEnabled: adsWriteHardEnabled(), mode: adsWriteMode() };

  return {
    v,
    b,
    verdict: j.verdict,
    reasons: j.reasons,
    digestMatches,
    currency: snap.config.currency,
    input: {
      status: v.status as VariantStatus,
      fbAdsetId: v.fbAdsetId,
      batchApproved: b.approvalDigest !== "",
      verdict: j.verdict,
      committedBudgetVnd: v.committedBudgetVnd,
      budgetPerVariantVnd: snap.budgetPerVariantVnd,
      currentEndAt: await currentEndAtOf(db, v.id, b.endAt),
      now,
      hardEnabled: env.hardEnabled,
      mode: env.mode,
      configComplete: snap.configComplete,
      testCampaignId: snap.config.testCampaignId,
      startAt: b.startAt,
      batchSize: snap.config.batchSize,
      extendedTodayVnd: await extendedOnDay(db, now),
    },
  };
}

/** BƯỚC 1 — ĐỀ NGHỊ TIÊU THÊM. Chỉ đọc, không ghi một dòng nào, không gọi Facebook. */
export async function proposeExtension(raw: { variantId: string }): Promise<ExtensionProposal | Fail> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
  const variantId = typeof raw?.variantId === "string" ? raw.variantId.trim() : "";
  if (!variantId) return { error: "Thiếu mã mẫu" };

  const db = await getDb();
  const now = new Date();
  const c = await loadContext(db, variantId, now);
  if ("error" in c) return c;

  // Xem trước NHƯ THỂ người đã bấm — nếu không thì mọi lần đều báo "chưa duyệt" và che lý do thật.
  const r = planExtension({ ...c.input, approved: true, approvalMatches: c.digestMatches });
  const plan = r.ok ? r : r.plan;
  const newEndAt = plan ? plan.newEndAt.toISOString() : null;

  return {
    variantId: c.v.id,
    batchDay: c.b.batchDay,
    slot: c.v.slot,
    headline: c.v.headline,
    verdict: c.verdict,
    verdictLabel: CREATIVE_VERDICT_LABEL[c.verdict],
    reasons: c.reasons,
    currentLifetimeVnd: c.v.committedBudgetVnd,
    addVnd: plan?.addVnd ?? null,
    clamped: plan?.clamped ?? false,
    newLifetimeVnd: plan?.newLifetimeVnd ?? null,
    currentEndAt: c.input.currentEndAt.toISOString(),
    newEndAt,
    extendedTodayVnd: c.input.extendedTodayVnd,
    perClickCapVnd: CREATIVE_HARD_LIMITS.maxExtensionPerClickVnd,
    dailyCapVnd: CREATIVE_HARD_LIMITS.maxDailyExtensionVnd,
    ticket: r.ok && newEndAt ? actionToken(user.id, TOOL, tokenPayload({ variantId: c.v.id, addVnd: r.addVnd, newLifetimeVnd: r.newLifetimeVnd, newEndAt })) : null,
    blocked: r.ok ? null : r.reason,
  };
}

const applySchema = z.object({
  variantId: z.string().min(1),
  addVnd: z.number().int().positive(),
  newLifetimeVnd: z.number().int().positive(),
  newEndAt: z.string().min(10),
  ticket: z.string().min(8),
});

export type ApplyExtensionInput = z.infer<typeof applySchema>;

/**
 * BƯỚC 2 — ÁP. Ghi sổ trước khi trả về, kể cả khi bị chặn hay hỏng.
 *
 * Số trên phiếu chỉ dùng để SO: mọi con số được tính lại từ CSDL. Tiền phải khớp tuyệt đối (bấm lần
 * hai sau khi lần một đã áp ⇒ ngân sách trọn đời tính lại đã khác ⇒ phiếu vô hiệu, không cộng hai lần).
 */
export async function applyExtension(raw: ApplyExtensionInput): Promise<{ ok: true; detail: string } | Fail> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
  const parsed = applySchema.safeParse(raw);
  if (!parsed.success) return { error: "Đầu vào không hợp lệ" };
  const input = parsed.data;
  const signedEnd = new Date(input.newEndAt);
  if (!Number.isFinite(signedEnd.getTime())) return { error: "Khung giờ trên phiếu không đọc được." };

  const db = await getDb();
  const now = new Date();
  const c = await loadContext(db, input.variantId, now);
  if ("error" in c) return c;

  const confirmed = verifyActionToken(input.ticket, user.id, TOOL, tokenPayload(input));
  const first = planExtension({ ...c.input, approved: confirmed, approvalMatches: c.digestMatches });
  const fresh = first.ok ? first : first.plan;
  // Điều kiện của MẪU hỏng (không nhóm, không biết ngân sách…) ⇒ không có gì để ghi, không vào sổ.
  if (!fresh) return { error: first.ok ? "Không tính được lượt tiêu thêm." : first.reason };

  const match = extensionMatchesTicket({ addVnd: input.addVnd, newLifetimeVnd: input.newLifetimeVnd, newEndAt: signedEnd }, fresh, now);
  const final = match.ok ? first : planExtension({ ...c.input, approved: confirmed, approvalMatches: false });

  const actor = { id: user.id, label: user.email };
  const mode = adsWriteMode();
  const adsetId = c.v.fbAdsetId ?? "";
  const lifetimeMinor = vndToFbMinor(fresh.newLifetimeVnd, c.currency);
  const request = {
    adset_id: adsetId,
    add_vnd: fresh.addVnd,
    previous_lifetime_vnd: c.v.committedBudgetVnd,
    lifetime_budget_vnd: fresh.newLifetimeVnd,
    lifetime_budget_minor: lifetimeMinor,
    currency: c.currency,
    previous_end_time: c.input.currentEndAt.toISOString(),
    // Khung ĐÃ KÝ — người bấm đã thấy đúng mốc này; mốc tính lại chỉ dùng để kiểm phiếu còn hạn.
    end_time: signedEnd.toISOString(),
  };
  const base = { actionDay: c.b.batchDay, batchId: c.b.id, variantId: c.v.id, action: "EXTEND_ADSET" as const, actor, mode, targetId: adsetId, request };

  if (!final.ok) {
    const detail = match.ok ? final.reason : `${final.reason} ${match.reason}`;
    await logAction(db, { ...base, outcome: "DENIED", denial: final.gate && !final.gate.ok ? final.gate.denial : "", detail, amountVnd: fresh.addVnd });
    await audit({ userId: user.id, userEmail: user.email, action: "CREATIVE_EXTEND_DENIED", entity: "CREATIVE_VARIANT", entityId: c.v.id, after: request, reason: detail });
    revalidatePath(PATH);
    return { error: detail };
  }

  try {
    await REAL_CREATIVE_WRITER.extendAdset(adsetId, { lifetimeBudgetMinor: lifetimeMinor, endTime: signedEnd });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logAction(db, { ...base, outcome: "FAILED", detail: msg, amountVnd: fresh.addVnd });
    await audit({ userId: user.id, userEmail: user.email, action: "CREATIVE_EXTEND_FAILED", entity: "CREATIVE_VARIANT", entityId: c.v.id, after: request, reason: msg });
    revalidatePath(PATH);
    return { error: `Facebook từ chối: ${msg}` };
  }

  const detail = `Cho tiêu thêm ${fresh.addVnd.toLocaleString("vi-VN")}đ — ngân sách trọn đời ${fresh.newLifetimeVnd.toLocaleString("vi-VN")}đ, chạy tới ${formatDateTime(signedEnd)}.`;
  // Id đã có sẵn; ngân sách mới và dòng sổ ĐÃ ÁP đi CÙNG một giao dịch: có cái này thì có cái kia.
  await db.transaction(async (tx) => {
    await tx
      .update(T.creativeVariants)
      .set({ committedBudgetVnd: fresh.newLifetimeVnd, status: "LIVE", updatedAt: now })
      .where(eq(T.creativeVariants.id, c.v.id));
    await logAction(tx, { ...base, outcome: "APPLIED", detail, amountVnd: fresh.addVnd });
  });
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "CREATIVE_EXTENDED",
    entity: "CREATIVE_VARIANT",
    entityId: c.v.id,
    before: { status: c.v.status, committedBudgetVnd: c.v.committedBudgetVnd, endAt: c.input.currentEndAt.toISOString() },
    after: { status: "LIVE", committedBudgetVnd: fresh.newLifetimeVnd, endAt: signedEnd.toISOString(), addVnd: fresh.addVnd },
    reason: detail,
  });
  revalidatePath(PATH);
  return { ok: true, detail };
}

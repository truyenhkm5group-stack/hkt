import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { actionToken, stableStringify, verifyActionToken } from "@/lib/ai/policy";
import type { Actor } from "@/lib/constants/actor";
import {
  CREATIVE_WRITE_DENIAL_REASON,
  SCALE_ELIGIBLE_VERDICTS,
  SCALE_KINDS,
  SCALE_KIND_LABEL,
  SCALE_KIND_OBJECTIVES,
  SCALE_TEMPLATE_FIELD,
  type CreativeLoopConfig,
  type CreativeVerdict,
  type CreativeWriteDenial,
  type ScaleBudgetLevel,
  type ScaleDraftStatus,
  type ScaleKind,
  type ScaleWriteAction,
  type VariantStatus,
} from "@/lib/constants/creative-loop";
import { vnDay } from "@/lib/constants/marketing-decision-ledger";
import { judgeVariant } from "@/lib/creative/judge";
import { buildObjectStorySpec } from "@/lib/creative/story-spec";
import type { CreativeWriteEnv } from "@/lib/creative/publish";
import {
  adsWriteHardEnabled,
  adsWriteMode,
  copyScaleCampaign,
  createAdCreative,
  readAdsKillSwitch,
  readCampaignTree,
  setScaleAdCreative,
  setScaleDailyBudget,
  setScaleStatus,
  vndToFbMinor,
  type CampaignTree,
} from "@/lib/integrations/facebook/ads-write";
import { gateScaleWrite, type ScaleGateInput } from "@/lib/marketing/creative-write-gate";
import { effectiveEndAt, effectiveJudgeConfig, extendedEndAtOf, readCurrentCreativeConfig, variantMetrics, type VariantMetricsRow } from "@/lib/queries/creative-loop";

/**
 * ═══════════ SCALE MẪU THẮNG — ĐỀ NGHỊ · DỰNG NHÁP (TẮT) · NGƯỜI DUYỆT THÌ BẬT ═══════════
 *
 * Đặc tả: `docs/creative-loop.md` §5f. Cổng: `gateScaleWrite` (`lib/marketing/creative-write-gate.ts`).
 * Cửa ghi: `lib/integrations/facebook/ads-write.ts` — tệp này KHÔNG gọi mạng, chỉ gọi hàm của cửa ghi qua
 * `deps.writer` (mặc định là hàm thật; kiểm thử tiêm bản giả).
 *
 * Chủ shop quyết 24/09/2026: "Mẫu test thắng thì scale — mục tiêu tối đa hoá lượt mua qua tin nhắn và
 * khách hàng tiềm năng, tạo BẢN NHÁP CHỜ DUYỆT, 500.000đ/ngày mỗi chiến dịch". Vẫn nấc COPILOT.
 *
 * ─── BỐN TÍNH CHẤT MÀ MỌI NHÁNH PHẢI GIỮ ───
 *
 *  1. **Đề nghị không gọi Facebook.** Lượt chấm chỉ CHÈN dòng `PROPOSED` (khoá (mẫu, loại) ⇒ chạy lại
 *     không đẻ dòng thứ hai).
 *  2. **Nháp LUÔN TẮT.** Bản sao đi với `status_option=PAUSED`; hỏng giữa chừng thì KHÔNG bước nào bật
 *     gì, và dòng nháp ghi rõ id bản sao để người xoá tay. Đọc lại bản sao mà thấy chiến dịch ĐANG
 *     BẬT (không nên xảy ra) ⇒ tắt ngay rồi mới báo lỗi.
 *  3. **Bật chỉ với phiếu của đúng người**, khoá (chiến dịch · nhóm · mẩu · bài · ngân sách · cấp ngân
 *     sách); trước khi bật đọc LẠI bản sao trên Facebook — ai sửa ngân sách / bài trên Ads Manager sau
 *     khi phát phiếu thì không bật. Thứ tự bật: mẩu → nhóm → CHIẾN DỊCH (công tắc tổng) cuối cùng: hỏng
 *     giữa chừng thì chiến dịch vẫn TẮT, không có nửa nào đang chạy.
 *  4. **Mọi bước vào sổ `creative_fb_actions`** — APPLIED · DENIED · FAILED, kể cả lượt bị chặn; mỗi dòng
 *     mang `scale_draft_id` trong `request`. Lượt chặn KHÔNG gộp trùng như sổ đăng lô: ở đây mỗi dòng là
 *     một cú bấm của người, không phải một vòng hỏi lại mười phút một lần.
 */

const T = schema;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Exec = Db | Tx;
type DraftRow = typeof T.creativeScaleDrafts.$inferSelect;
type VariantRow = typeof T.creativeVariants.$inferSelect;
type BatchRow = typeof T.creativeBatches.$inferSelect;

// ───────────────────────────── PHỤ THUỘC TIÊM ĐƯỢC ─────────────────────────────

export type ScaleWriter = {
  readCampaignTree: typeof readCampaignTree;
  copyScaleCampaign: typeof copyScaleCampaign;
  createAdCreative: typeof createAdCreative;
  setScaleAdCreative: typeof setScaleAdCreative;
  setScaleDailyBudget: typeof setScaleDailyBudget;
  setScaleStatus: typeof setScaleStatus;
};

export const REAL_SCALE_WRITER: ScaleWriter = { readCampaignTree, copyScaleCampaign, createAdCreative, setScaleAdCreative, setScaleDailyBudget, setScaleStatus };

export type ScaleDeps = {
  writer?: ScaleWriter;
  env?: CreativeWriteEnv;
  /** Công tắc khẩn cấp — tiêm cho kiểm thử. Mặc định đọc `settings` (lỗi đọc ⇒ coi như kéo). */
  killSwitch?: () => Promise<{ killed: boolean; reason: string | null }>;
};

function resolveDeps(deps: ScaleDeps = {}) {
  return {
    writer: deps.writer ?? REAL_SCALE_WRITER,
    env: deps.env ?? { hardEnabled: adsWriteHardEnabled(), mode: adsWriteMode() },
    killSwitch: deps.killSwitch ?? readAdsKillSwitch,
  };
}

export type ScaleResult = { ok: true; detail: string; draftId: string } | { ok: false; detail: string; denial: CreativeWriteDenial | null };

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const vnd = (n: number) => `${Math.round(n).toLocaleString("vi-VN")}đ`;

// ───────────────────────────── SỔ GHI ─────────────────────────────

type ScaleLog = {
  draft: Pick<DraftRow, "id" | "variantId" | "batchId" | "kind">;
  action: ScaleWriteAction;
  outcome: "APPLIED" | "DENIED" | "FAILED";
  denial?: CreativeWriteDenial | "";
  detail: string;
  targetId?: string;
  amountVnd?: number | null;
  request?: Record<string, unknown>;
  actor: Actor;
  mode: string;
  now: Date;
};

/** Một dòng sổ cho mỗi lượt — KHÔNG kèm token (cửa ghi tự gắn token, nơi gọi không cầm nó). */
async function logScale(db: Exec, r: ScaleLog) {
  await db.insert(T.creativeFbActions).values({
    actionDay: vnDay(r.now),
    batchId: r.draft.batchId,
    variantId: r.draft.variantId,
    action: r.action,
    outcome: r.outcome,
    denial: r.outcome === "APPLIED" ? "" : (r.denial ?? ""),
    detail: r.detail.slice(0, 2000),
    targetId: r.targetId ?? "",
    amountVnd: r.amountVnd ?? null,
    request: { scale_draft_id: r.draft.id, kind: r.draft.kind, ...(r.request ?? {}) },
    actorUserId: r.actor.id,
    actorEmail: r.actor.label,
    mode: r.mode,
  });
}

// ───────────────────────────── PHÁN QUYẾT SỐNG ─────────────────────────────

/** Phán quyết SỐNG của mẫu gốc — cùng bộ luật hai nguồn với lượt chấm, cùng hạn đã kéo khi tiêu thêm. */
export async function liveVerdictOf(db: Db, v: VariantRow, b: BatchRow, now: Date): Promise<{ verdict: CreativeVerdict; metrics: VariantMetricsRow | null }> {
  const { config: current } = await readCurrentCreativeConfig(db);
  const [metrics, extended] = await Promise.all([variantMetrics(db, [{ id: v.id, fbAdId: v.fbAdId, startAt: b.startAt }]), extendedEndAtOf(db, [v.id])]);
  const m = metrics.get(v.id) ?? null;
  if (!m) return { verdict: "PENDING", metrics: null };
  const j = judgeVariant(
    { status: v.status as VariantStatus, startAt: b.startAt, endAt: effectiveEndAt(b.endAt, extended.get(v.id)), libraryAt: v.libraryAt, metrics: m },
    effectiveJudgeConfig(b.configSnapshot, current),
    now,
  );
  return { verdict: j.verdict, metrics: m };
}

// ───────────────────────────── 1. ĐỀ NGHỊ (lượt chấm gọi) ─────────────────────────────

export type ScaleCandidate = { variantId: string; batchId: string; verdict: CreativeVerdict; metrics: Record<string, unknown> };

/**
 * Mẫu vừa đạt THẮNG / HỨA HẸN ⇒ một dòng `PROPOSED` cho MỖI loại scale. `ON CONFLICT DO NOTHING` trên
 * khoá (mẫu, loại): chạy mười phút một lần không đẻ dòng thứ hai, và dòng người đã BỎ QUA không mọc lại.
 * KHÔNG gọi Facebook. Trả id các dòng MỚI chèn ở lượt này.
 */
export async function proposeScale(db: Db, candidates: ScaleCandidate[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of candidates) {
    if (!SCALE_ELIGIBLE_VERDICTS.includes(c.verdict)) continue;
    for (const kind of SCALE_KINDS) {
      const rows = await db
        .insert(T.creativeScaleDrafts)
        .values({ variantId: c.variantId, batchId: c.batchId, kind, status: "PROPOSED", proposedVerdict: c.verdict, proposalMetrics: c.metrics })
        .onConflictDoNothing({ target: [T.creativeScaleDrafts.variantId, T.creativeScaleDrafts.kind] })
        .returning({ id: T.creativeScaleDrafts.id });
      for (const r of rows) out.push(r.id);
    }
  }
  return out;
}

// ───────────────────────────── ĐỌC NGỮ CẢNH ─────────────────────────────

type Ctx = { draft: DraftRow; variant: VariantRow; batch: BatchRow; config: CreativeLoopConfig; templateId: string; configComplete: boolean };

async function loadCtx(db: Db, where: { draftId: string } | { variantId: string; kind: ScaleKind }): Promise<Ctx | null> {
  const cond = "draftId" in where ? eq(T.creativeScaleDrafts.id, where.draftId) : and(eq(T.creativeScaleDrafts.variantId, where.variantId), eq(T.creativeScaleDrafts.kind, where.kind));
  const [row] = await db
    .select({ d: T.creativeScaleDrafts, v: T.creativeVariants, b: T.creativeBatches })
    .from(T.creativeScaleDrafts)
    .innerJoin(T.creativeVariants, eq(T.creativeVariants.id, T.creativeScaleDrafts.variantId))
    .innerJoin(T.creativeBatches, eq(T.creativeBatches.id, T.creativeVariants.batchId))
    .where(cond)
    .limit(1);
  if (!row) return null;
  const { config } = await readCurrentCreativeConfig(db);
  const kind = row.d.kind as ScaleKind;
  const templateId = config.scaleTemplates[SCALE_TEMPLATE_FIELD[kind]] ?? "";
  return { draft: row.d, variant: row.v, batch: row.b, config, templateId, configComplete: !!config.adAccountId && !!config.pageId && !!templateId };
}

/** Số nháp KHÁC của cùng mẫu đã THỬ sao chép (có mốc thử hoặc có id bản sao). */
async function otherCopiedDrafts(db: Exec, d: DraftRow): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(T.creativeScaleDrafts)
    .where(and(eq(T.creativeScaleDrafts.variantId, d.variantId), ne(T.creativeScaleDrafts.id, d.id), or(isNotNull(T.creativeScaleDrafts.copyAttemptedAt), isNotNull(T.creativeScaleDrafts.fbCampaignId))));
  return Number(r?.n ?? 0);
}

/** Tổng ngân sách ngày của các chiến dịch scale KHÁC đang bật — đếm trên bảng nháp, không trên cấu hình. */
export async function activeScaleTotalVnd(db: Exec, exceptDraftId = ""): Promise<number> {
  const [r] = await db
    .select({ total: sql<number>`coalesce(sum(${T.creativeScaleDrafts.dailyBudgetVnd}), 0)::int` })
    .from(T.creativeScaleDrafts)
    .where(and(eq(T.creativeScaleDrafts.status, "ACTIVE"), ne(T.creativeScaleDrafts.id, exceptDraftId)));
  return Number(r?.total ?? 0);
}

/** Tiền tố tên bản sao — người trên Ads Manager nhận ra ngay, và là chìa khoá tìm bản sao mồ côi. */
export function scaleNamePrefix(d: Pick<DraftRow, "kind">, b: Pick<BatchRow, "batchDay">, v: Pick<VariantRow, "slot">): string {
  return `[VM scale ${d.kind === "LEADS" ? "KHTN" : "MUA-TN"}] ${b.batchDay} #${v.slot}`;
}

// ───────────────────────────── KIỂM HÌNH DẠNG (hàm thuần) ─────────────────────────────

/**
 * Chiến dịch mẫu / bản sao có đúng hình dạng máy làm được không. Hàm THUẦN — chạy cho chiến dịch MẪU
 * trước khi sao chép (hỏng ⇒ không sao chép gì) và cho BẢN SAO sau khi sao chép.
 *
 * ĐÚNG một nhóm + một mẩu: `deep_copy` đồng bộ chỉ nhận ≤ 3 mẩu, và "mẩu nào nhận bài mẫu thắng" không
 * được là một phép đoán. Ngân sách TRỌN ĐỜI bị từ chối: chủ shop chốt NGÂN SÁCH NGÀY.
 */
export function checkScaleTree(
  tree: CampaignTree,
  kind: ScaleKind,
  content: { pageId: string; imageHash: string; primaryText: string; headline: string },
): { ok: true; level: ScaleBudgetLevel; spec: Record<string, unknown> } | { ok: false; error: string } {
  if (tree.truncated) return { ok: false, error: "Chiến dịch có quá nhiều nhóm/mẩu (Facebook còn trang sau) — chiến dịch mẫu phải có ĐÚNG một nhóm + một mẩu." };
  if (tree.adsets.length !== 1 || tree.ads.length !== 1) return { ok: false, error: `Chiến dịch có ${tree.adsets.length} nhóm, ${tree.ads.length} mẩu — phải ĐÚNG một nhóm + một mẩu.` };
  const want = SCALE_KIND_OBJECTIVES[kind];
  if (!tree.objective || !want.includes(tree.objective)) {
    return { ok: false, error: `Mục tiêu chiến dịch là ${tree.objective ?? "không đọc được"}, loại "${SCALE_KIND_LABEL[kind]}" cần ${want.join(" / ")} — kiểm lại id chiến dịch mẫu đã khai.` };
  }
  const adset = tree.adsets[0];
  const ad = tree.ads[0];
  if (tree.lifetimeBudgetMinor !== null || adset.lifetimeBudgetMinor !== null) return { ok: false, error: "Chiến dịch mẫu dùng ngân sách TRỌN ĐỜI — nháp scale đặt ngân sách NGÀY. Đổi mẫu sang ngân sách ngày." };
  if (ad.adsetId && ad.adsetId !== adset.id) return { ok: false, error: "Mẩu không nằm trong nhóm của chiến dịch — dữ liệu Facebook mâu thuẫn, không đoán." };
  if (adset.promotedPageId && adset.promotedPageId !== content.pageId) {
    return { ok: false, error: `Nhóm của chiến dịch mẫu gửi về fanpage ${adset.promotedPageId}, khác fanpage đã khai ${content.pageId}.` };
  }
  if (ad.hasAssetFeed) return { ok: false, error: "Mẩu mẫu dùng quảng cáo động (asset_feed_spec) — máy không đoán hình dạng quảng cáo." };
  const spec = buildObjectStorySpec(ad.objectStorySpec, content);
  if (!spec.ok) return { ok: false, error: spec.error };
  return { ok: true, level: tree.dailyBudgetMinor !== null ? "CAMPAIGN" : "ADSET", spec: spec.spec };
}

// ───────────────────────────── 2. DỰNG NHÁP (người bấm) ─────────────────────────────

export type BuildScaleRequest = { variantId: string; kind: ScaleKind; actor: Actor };

/**
 * Người bấm "Dựng nháp": sao chép chiến dịch mẫu (TẮT) → đọc bản sao → tạo bài từ ảnh + câu chữ của mẫu
 * thắng → gắn vào mẩu của bản sao → đặt ngân sách ngày đúng cấp. Không bước nào BẬT gì.
 */
export async function buildScaleDraft(db: Db, req: BuildScaleRequest, now: Date, deps?: ScaleDeps): Promise<ScaleResult> {
  const d = resolveDeps(deps);
  const ctx = await loadCtx(db, { variantId: req.variantId, kind: req.kind });
  if (!ctx) return { ok: false, denial: null, detail: "Không có đề nghị scale cho mẫu + loại này." };
  const { draft, variant: v, batch: b, config: cfg, templateId } = ctx;
  const mode = d.env.mode;
  const log = (x: Omit<ScaleLog, "draft" | "actor" | "mode" | "now">, exec: Exec = db) => logScale(exec, { ...x, draft, actor: req.actor, mode, now });

  const alreadyCopied = draft.copyAttemptedAt !== null || draft.fbCampaignId !== null;
  // Đã từng thử sao chép (kể cả hỏng) thì không dựng lại: có thể đã có một bản sao mồ côi trên Facebook.
  if (!(draft.status === "PROPOSED" || (draft.status === "FAILED" && !alreadyCopied))) {
    return { ok: false, denial: null, detail: `Nháp đang ở trạng thái ${draft.status} — không dựng lại.` };
  }

  const { verdict } = await liveVerdictOf(db, v, b, now);
  const budgetVnd = cfg.scaleDailyBudgetVnd;
  const baseGate: Omit<ScaleGateInput, "action"> = {
    hardEnabled: d.env.hardEnabled,
    mode,
    configComplete: ctx.configComplete,
    approved: true, // người vừa bấm "Dựng nháp"; mọi thứ dựng ra vẫn TẮT
    approvalMatches: true,
    sourceCampaignId: templateId,
    templateCampaignId: templateId,
    ourCopy: false,
    verdict,
    alreadyCopied,
    otherDraftsForVariant: await otherCopiedDrafts(db, draft),
    budgetVnd,
    activeTotalVnd: 0,
  };
  const denyLog = async (action: ScaleWriteAction, denial: CreativeWriteDenial, detail: string): Promise<ScaleResult> => {
    await log({ action, outcome: "DENIED", denial, detail, request: { source_campaign_id: templateId, daily_budget_vnd: budgetVnd } });
    await db.update(T.creativeScaleDrafts).set({ error: detail, updatedAt: now }).where(eq(T.creativeScaleDrafts.id, draft.id));
    return { ok: false, denial, detail };
  };

  const g0 = gateScaleWrite({ ...baseGate, action: "COPY_SCALE_CAMPAIGN" });
  if (!g0.ok) return denyLog("COPY_SCALE_CAMPAIGN", g0.denial, g0.reason);

  const kill = await d.killSwitch();
  if (kill.killed) return denyLog("COPY_SCALE_CAMPAIGN", "KILL_SWITCH", `${CREATIVE_WRITE_DENIAL_REASON.KILL_SWITCH} ${kill.reason ?? ""}`.trim());

  const content = { pageId: cfg.pageId, imageHash: v.fbImageHash, primaryText: v.primaryText, headline: v.headline };
  if (!v.fbImageHash) return { ok: false, denial: null, detail: "Mẫu chưa có ảnh trên tài khoản quảng cáo (chưa từng đăng) — không dựng được bài scale." };

  // Giữ chỗ: chỉ MỘT lượt được dựng nháp này (hai cú bấm cùng lúc không sao chép hai lần).
  const claimed = await db
    .update(T.creativeScaleDrafts)
    .set({ status: "DRAFTING", error: "", updatedAt: now })
    .where(and(eq(T.creativeScaleDrafts.id, draft.id), inArray(T.creativeScaleDrafts.status, ["PROPOSED", "FAILED"]), isNull(T.creativeScaleDrafts.copyAttemptedAt), isNull(T.creativeScaleDrafts.fbCampaignId)))
    .returning({ id: T.creativeScaleDrafts.id });
  if (claimed.length === 0) return { ok: false, denial: null, detail: "Nháp này đang được dựng bởi một lượt khác." };

  const setDraft = (patch: Partial<typeof T.creativeScaleDrafts.$inferInsert>, exec: Exec = db) =>
    exec.update(T.creativeScaleDrafts).set({ ...patch, updatedAt: now }).where(eq(T.creativeScaleDrafts.id, draft.id));

  // ── Đọc chiến dịch MẪU (chỉ đọc). Hình dạng lạ ⇒ không sao chép gì; nháp dựng lại được. ──
  let tpl: CampaignTree;
  try {
    tpl = await d.writer.readCampaignTree(templateId);
  } catch (e) {
    const msg = `Không đọc được chiến dịch mẫu ${templateId}: ${errText(e)}`;
    await setDraft({ status: "FAILED", error: msg });
    return { ok: false, denial: null, detail: msg };
  }
  const shape = checkScaleTree(tpl, draft.kind as ScaleKind, content);
  if (!shape.ok) {
    const msg = `Chiến dịch mẫu ${templateId} không dùng được: ${shape.error}`;
    await setDraft({ status: "FAILED", error: msg });
    return { ok: false, denial: null, detail: msg };
  }

  // ── Sao chép — mốc thử ghi TRƯỚC lời gọi: phản hồi rơi mất thì dòng này vẫn nói "có thể đã có bản sao". ──
  const namePrefix = scaleNamePrefix(draft, b, v);
  await setDraft({ copyAttemptedAt: now, sourceCampaignId: templateId, currency: cfg.currency });
  let copiedId: string;
  try {
    const cp = await d.writer.copyScaleCampaign(templateId, { namePrefix });
    copiedId = cp.copiedCampaignId;
    await db.transaction(async (tx) => {
      await setDraft({ fbCampaignId: copiedId }, tx);
      await log(
        { action: "COPY_SCALE_CAMPAIGN", outcome: "APPLIED", detail: `Đã sao chép chiến dịch mẫu ${templateId} → ${copiedId} (TẮT).`, targetId: copiedId, request: { source_campaign_id: templateId, deep_copy: true, status_option: "PAUSED", name_prefix: namePrefix, objects: cp.objects } },
        tx,
      );
    });
  } catch (e) {
    const msg = `Sao chép chiến dịch mẫu hỏng: ${errText(e)} Nếu Facebook đã kịp tạo bản sao thì nó đang TẮT — tìm chiến dịch có tiền tố "${namePrefix}" trên Ads Manager và xoá tay.`;
    await log({ action: "COPY_SCALE_CAMPAIGN", outcome: "FAILED", detail: msg, request: { source_campaign_id: templateId, name_prefix: namePrefix } });
    await setDraft({ status: "FAILED", error: msg });
    return { ok: false, denial: null, detail: msg };
  }

  const ids = { campaign: copiedId, adset: "", ad: "" };
  const orphan = () => `Bản sao ${ids.campaign}${ids.adset ? ` (nhóm ${ids.adset}` : ""}${ids.ad ? `, mẩu ${ids.ad})` : ids.adset ? ")" : ""} đang TẮT — xoá tay trên Ads Manager nếu không dùng.`;
  const fail = async (action: ScaleWriteAction | null, msg: string): Promise<ScaleResult> => {
    const full = `${msg} ${orphan()}`;
    if (action) await log({ action, outcome: "FAILED", detail: full, targetId: ids.campaign });
    await setDraft({ status: "FAILED", error: full });
    return { ok: false, denial: null, detail: full };
  };

  // ── Đọc BẢN SAO. Nó phải TẮT và đúng hình dạng; lỡ đang bật thì tắt NGAY rồi mới báo. ──
  let copy: CampaignTree;
  try {
    copy = await d.writer.readCampaignTree(copiedId);
  } catch (e) {
    return fail(null, `Không đọc được bản sao ${copiedId}: ${errText(e)}.`);
  }
  if (copy.status === "ACTIVE") {
    try {
      await d.writer.setScaleStatus(copiedId, "PAUSED");
      await log({ action: "PAUSE_SCALE", outcome: "APPLIED", detail: "Bản sao đọc về đang BẬT (không nên xảy ra) — máy tắt ngay.", targetId: copiedId, request: { status: "PAUSED" } });
    } catch (e) {
      await log({ action: "PAUSE_SCALE", outcome: "FAILED", detail: `Bản sao đang BẬT mà tắt không được: ${errText(e)} — TẮT TAY NGAY trên Ads Manager.`, targetId: copiedId });
    }
    return fail(null, "Bản sao đọc về ở trạng thái ĐANG BẬT — máy đã xin tắt và dừng dựng nháp.");
  }
  const copyShape = checkScaleTree(copy, draft.kind as ScaleKind, content);
  ids.adset = copy.adsets[0]?.id ?? "";
  ids.ad = copy.ads[0]?.id ?? "";
  if (!copyShape.ok) return fail(null, `Bản sao không đúng hình dạng: ${copyShape.error}`);
  const level = copyShape.level;
  await setDraft({ fbAdsetId: ids.adset, fbAdId: ids.ad, budgetLevel: level });

  const step = (action: ScaleWriteAction) => {
    const g = gateScaleWrite({ ...baseGate, action, ourCopy: true, alreadyCopied: true });
    return g;
  };

  // ── Tạo bài từ ảnh + câu chữ của mẫu thắng, theo khuôn bài của CHÍNH bản sao. ──
  const g1 = step("CREATE_SCALE_CREATIVE");
  if (!g1.ok) {
    await log({ action: "CREATE_SCALE_CREATIVE", outcome: "DENIED", denial: g1.denial, detail: g1.reason, targetId: ids.ad });
    return fail(null, g1.reason);
  }
  let creativeId: string;
  try {
    const cr = await d.writer.createAdCreative(cfg.adAccountId, { name: `${namePrefix} · bài`, objectStorySpec: copyShape.spec });
    creativeId = cr.id;
    await db.transaction(async (tx) => {
      await setDraft({ fbCreativeId: creativeId }, tx);
      await log({ action: "CREATE_SCALE_CREATIVE", outcome: "APPLIED", detail: "Đã tạo bài quảng cáo từ ảnh + câu chữ của mẫu thắng.", targetId: creativeId, request: { account: cfg.adAccountId, object_story_spec: copyShape.spec } }, tx);
    });
  } catch (e) {
    return fail("CREATE_SCALE_CREATIVE", `Tạo bài quảng cáo hỏng: ${errText(e)}.`);
  }

  // ── Gắn bài vào mẩu của bản sao. ──
  const g2 = step("SET_SCALE_AD_CREATIVE");
  if (!g2.ok) {
    await log({ action: "SET_SCALE_AD_CREATIVE", outcome: "DENIED", denial: g2.denial, detail: g2.reason, targetId: ids.ad });
    return fail(null, g2.reason);
  }
  try {
    await d.writer.setScaleAdCreative(ids.ad, creativeId);
    await log({ action: "SET_SCALE_AD_CREATIVE", outcome: "APPLIED", detail: `Đã gắn bài ${creativeId} vào mẩu ${ids.ad}.`, targetId: ids.ad, request: { ad_id: ids.ad, creative_id: creativeId } });
  } catch (e) {
    return fail("SET_SCALE_AD_CREATIVE", `Gắn bài vào mẩu hỏng: ${errText(e)}.`);
  }

  // ── Đặt ngân sách NGÀY đúng cấp (CBO ⇒ chiến dịch, ABO ⇒ nhóm). ──
  const g3 = step("SET_SCALE_BUDGET");
  if (!g3.ok) {
    await log({ action: "SET_SCALE_BUDGET", outcome: "DENIED", denial: g3.denial, detail: g3.reason, targetId: ids.campaign });
    return fail(null, g3.reason);
  }
  const budgetTarget = level === "CAMPAIGN" ? ids.campaign : ids.adset;
  const minor = vndToFbMinor(budgetVnd, cfg.currency);
  try {
    await d.writer.setScaleDailyBudget(budgetTarget, minor);
    await db.transaction(async (tx) => {
      await setDraft({ dailyBudgetVnd: budgetVnd }, tx);
      await log(
        {
          action: "SET_SCALE_BUDGET",
          outcome: "APPLIED",
          detail: `Đặt ngân sách ngày ${vnd(budgetVnd)} ở cấp ${level === "CAMPAIGN" ? "chiến dịch (CBO)" : "nhóm (ABO)"} — vẫn TẮT.`,
          targetId: budgetTarget,
          request: { level, object_id: budgetTarget, daily_budget_vnd: budgetVnd, daily_budget_minor: minor, currency: cfg.currency },
        },
        tx,
      );
    });
  } catch (e) {
    return fail("SET_SCALE_BUDGET", `Đặt ngân sách hỏng: ${errText(e)}.`);
  }

  await setDraft({ status: "DRAFT", error: "", draftedByUserId: req.actor.id, draftedByName: req.actor.label, draftedAt: now });
  return { ok: true, draftId: draft.id, detail: `Đã dựng nháp "${SCALE_KIND_LABEL[draft.kind as ScaleKind]}" — chiến dịch ${ids.campaign} đang TẮT, ${vnd(budgetVnd)}/ngày. Bấm "Duyệt chạy" để bật.` };
}

// ───────────────────────────── 3. DUYỆT CHẠY (hai bước) ─────────────────────────────

/** Tên tool trong phiếu. Đổi chuỗi này là vô hiệu hoá mọi phiếu đang lưu hành — đó là ý muốn. */
export const SCALE_ACTIVATE_TOOL = "CREATIVE_SCALE_ACTIVATE";

/** ĐÚNG những gì quyết định hậu quả của cú bấm bật — phiếu khoá trên đây. */
export type ScaleTicketPayload = { draftId: string; campaignId: string; adsetId: string; adId: string; creativeId: string; dailyBudgetVnd: number; budgetLevel: string };

export function scaleTicketPayload(dr: Pick<DraftRow, "id" | "fbCampaignId" | "fbAdsetId" | "fbAdId" | "fbCreativeId" | "dailyBudgetVnd" | "budgetLevel">): ScaleTicketPayload {
  return {
    draftId: dr.id,
    campaignId: dr.fbCampaignId ?? "",
    adsetId: dr.fbAdsetId ?? "",
    adId: dr.fbAdId ?? "",
    creativeId: dr.fbCreativeId ?? "",
    dailyBudgetVnd: dr.dailyBudgetVnd ?? 0,
    budgetLevel: dr.budgetLevel,
  };
}

export function scaleTicket(userId: string, p: ScaleTicketPayload): string {
  return actionToken(userId, SCALE_ACTIVATE_TOOL, p);
}

export type ScaleLaunchProposal = {
  draftId: string;
  kind: ScaleKind;
  payload: ScaleTicketPayload;
  verdict: CreativeVerdict;
  activeTotalVnd: number;
  /** Phiếu. `null` = không bật được lúc này, lý do ở `blocked`. */
  ticket: string | null;
  blocked: string | null;
};

/** BƯỚC 1 — ĐỀ NGHỊ BẬT. Chỉ đọc CSDL, không ghi, không gọi Facebook. */
export async function scaleLaunchProposal(db: Db, draftId: string, userId: string, now: Date, deps?: ScaleDeps): Promise<ScaleLaunchProposal | { error: string }> {
  const d = resolveDeps(deps);
  const ctx = await loadCtx(db, { draftId });
  if (!ctx) return { error: "Không tìm thấy nháp scale." };
  if (ctx.draft.status !== "DRAFT") return { error: `Nháp đang ở trạng thái ${ctx.draft.status} — chỉ nháp đã dựng xong mới duyệt chạy được.` };
  const { verdict } = await liveVerdictOf(db, ctx.variant, ctx.batch, now);
  const payload = scaleTicketPayload(ctx.draft);
  const activeTotalVnd = await activeScaleTotalVnd(db, ctx.draft.id);
  // Xem trước NHƯ THỂ người đã bấm — nếu không thì mọi lần đều báo "chưa duyệt" và che lý do thật.
  const g = gateScaleWrite({
    hardEnabled: d.env.hardEnabled,
    mode: d.env.mode,
    action: "ACTIVATE_SCALE",
    configComplete: ctx.configComplete,
    approved: true,
    approvalMatches: true,
    sourceCampaignId: null,
    templateCampaignId: ctx.templateId,
    ourCopy: !!ctx.draft.fbCampaignId,
    verdict,
    alreadyCopied: true,
    otherDraftsForVariant: 0,
    budgetVnd: payload.dailyBudgetVnd,
    activeTotalVnd,
  });
  return { draftId: ctx.draft.id, kind: ctx.draft.kind as ScaleKind, payload, verdict, activeTotalVnd, ticket: g.ok ? scaleTicket(userId, payload) : null, blocked: g.ok ? null : g.reason };
}

export type ActivateScaleRequest = { draftId: string; signed: ScaleTicketPayload; ticket: string; actor: Actor & { id: string } };

/**
 * BƯỚC 2 — BẬT. Tính lại từ CSDL, so phiếu cho ĐÚNG người, đọc LẠI bản sao trên Facebook, rồi bật
 * mẩu → nhóm → chiến dịch. Bật lại một nháp đã ACTIVE ⇒ trả về thành công, không ghi gì (mục 61).
 */
export async function activateScaleDraft(db: Db, req: ActivateScaleRequest, now: Date, deps?: ScaleDeps): Promise<ScaleResult> {
  const d = resolveDeps(deps);
  const ctx = await loadCtx(db, { draftId: req.draftId });
  if (!ctx) return { ok: false, denial: null, detail: "Không tìm thấy nháp scale." };
  const { draft } = ctx;
  if (draft.status === "ACTIVE") return { ok: true, draftId: draft.id, detail: "Chiến dịch scale đã bật từ trước — không ghi gì thêm." };
  if (draft.status !== "DRAFT") return { ok: false, denial: null, detail: `Nháp đang ở trạng thái ${draft.status} — không bật được.` };

  const mode = d.env.mode;
  const log = (x: Omit<ScaleLog, "draft" | "actor" | "mode" | "now">, exec: Exec = db) => logScale(exec, { ...x, draft, actor: req.actor, mode, now });
  const fresh = scaleTicketPayload(draft);
  const approved = verifyActionToken(req.ticket, req.actor.id, SCALE_ACTIVATE_TOOL, req.signed);
  const matches = stableStringify(req.signed) === stableStringify(fresh);
  const { verdict } = await liveVerdictOf(db, ctx.variant, ctx.batch, now);
  const activeTotalVnd = await activeScaleTotalVnd(db, draft.id);

  const deny = async (denial: CreativeWriteDenial, detail: string): Promise<ScaleResult> => {
    await log({ action: "ACTIVATE_SCALE", outcome: "DENIED", denial, detail, targetId: fresh.campaignId, request: { signed: req.signed, fresh } });
    return { ok: false, denial, detail };
  };

  const g = gateScaleWrite({
    hardEnabled: d.env.hardEnabled,
    mode,
    action: "ACTIVATE_SCALE",
    configComplete: ctx.configComplete,
    approved,
    approvalMatches: matches,
    sourceCampaignId: null,
    templateCampaignId: ctx.templateId,
    ourCopy: !!draft.fbCampaignId && req.signed.campaignId === draft.fbCampaignId,
    verdict,
    alreadyCopied: true,
    otherDraftsForVariant: 0,
    budgetVnd: fresh.dailyBudgetVnd,
    activeTotalVnd,
  });
  if (!g.ok) return deny(g.denial, g.reason);

  const kill = await d.killSwitch();
  if (kill.killed) return deny("KILL_SWITCH", `${CREATIVE_WRITE_DENIAL_REASON.KILL_SWITCH} ${kill.reason ?? ""}`.trim());

  // Đọc LẠI bản sao: ai sửa bài / ngân sách trên Ads Manager sau khi phát phiếu thì không bật thứ người duyệt chưa thấy.
  let tree: CampaignTree;
  try {
    tree = await d.writer.readCampaignTree(fresh.campaignId);
  } catch (e) {
    return { ok: false, denial: null, detail: `Không đọc được chiến dịch nháp trên Facebook — chưa bật gì. ${errText(e)}` };
  }
  const drift = scaleTreeDrift(tree, fresh, draft.currency);
  if (drift) return deny("APPROVAL_MISMATCH", `${CREATIVE_WRITE_DENIAL_REASON.APPROVAL_MISMATCH} ${drift}`);

  // Mẩu → nhóm → CHIẾN DỊCH. Chiến dịch là công tắc tổng và bật CUỐI: hỏng trước đó thì không gì chạy.
  const order: { id: string; what: string }[] = [
    { id: fresh.adId, what: "mẩu" },
    { id: fresh.adsetId, what: "nhóm" },
    { id: fresh.campaignId, what: "chiến dịch" },
  ];
  for (const o of order) {
    const isCampaign = o.id === fresh.campaignId;
    try {
      await d.writer.setScaleStatus(o.id, "ACTIVE");
    } catch (e) {
      const msg = `Bật ${o.what} ${o.id} hỏng: ${errText(e)} ${isCampaign ? "Chiến dịch vẫn TẮT" : "Chiến dịch chưa bật"} — không có gì đang chạy. Bấm "Duyệt chạy" lại sau khi xem lỗi.`;
      await log({ action: "ACTIVATE_SCALE", outcome: "FAILED", detail: msg, targetId: o.id, request: { status: "ACTIVE", object: o.what } });
      await db.update(T.creativeScaleDrafts).set({ error: msg, updatedAt: now }).where(eq(T.creativeScaleDrafts.id, draft.id));
      return { ok: false, denial: null, detail: msg };
    }
    if (!isCampaign) await log({ action: "ACTIVATE_SCALE", outcome: "APPLIED", detail: `Đã bật ${o.what} ${o.id} (chiến dịch vẫn TẮT tới bước cuối).`, targetId: o.id, request: { status: "ACTIVE", object: o.what } });
  }
  const detail = `Đã BẬT chiến dịch scale ${fresh.campaignId} — ${vnd(fresh.dailyBudgetVnd)}/ngày. Người duyệt: ${req.actor.label}.`;
  await db.transaction(async (tx) => {
    await tx
      .update(T.creativeScaleDrafts)
      .set({ status: "ACTIVE", approvedByUserId: req.actor.id, approvedByName: req.actor.label, approvedAt: now, error: "", updatedAt: now })
      .where(and(eq(T.creativeScaleDrafts.id, draft.id), eq(T.creativeScaleDrafts.status, "DRAFT")));
    await log({ action: "ACTIVATE_SCALE", outcome: "APPLIED", detail, targetId: fresh.campaignId, amountVnd: fresh.dailyBudgetVnd, request: { status: "ACTIVE", object: "chiến dịch", daily_budget_vnd: fresh.dailyBudgetVnd } }, tx);
  });
  return { ok: true, draftId: draft.id, detail };
}

/** Bản sao trên Facebook còn đúng thứ người duyệt thấy không. `null` = khớp; chuỗi = lệch ở đâu. Hàm THUẦN. */
export function scaleTreeDrift(tree: CampaignTree, p: ScaleTicketPayload, currency: string): string | null {
  if (tree.id !== p.campaignId) return `(Đọc về chiến dịch ${tree.id}, phiếu nói ${p.campaignId}.)`;
  if (tree.adsets.length !== 1 || tree.ads.length !== 1 || tree.truncated) return `(Bản sao nay có ${tree.adsets.length} nhóm, ${tree.ads.length} mẩu.)`;
  if (tree.adsets[0].id !== p.adsetId || tree.ads[0].id !== p.adId) return "(Nhóm / mẩu của bản sao đã khác.)";
  if (tree.ads[0].creativeId !== p.creativeId) return `(Mẩu đang gắn bài ${tree.ads[0].creativeId ?? "∅"}, phiếu duyệt bài ${p.creativeId}.)`;
  const want = vndToFbMinor(p.dailyBudgetVnd, currency);
  const got = p.budgetLevel === "CAMPAIGN" ? tree.dailyBudgetMinor : tree.adsets[0].dailyBudgetMinor;
  if (got !== want) return `(Ngân sách ngày trên Facebook là ${got ?? "không đọc được"}, phiếu duyệt ${want} — đơn vị nhỏ nhất của ${currency}.)`;
  return null;
}

// ───────────────────────────── 4. TẮT · BỎ QUA ─────────────────────────────

/** Tắt chiến dịch scale đang chạy. Chỉ làm GIẢM tiền — công tắc khẩn cấp vẫn cho đi (`{status: PAUSED}`). */
export async function pauseScaleDraft(db: Db, req: { draftId: string; actor: Actor }, now: Date, deps?: ScaleDeps): Promise<ScaleResult> {
  const d = resolveDeps(deps);
  const ctx = await loadCtx(db, { draftId: req.draftId });
  if (!ctx) return { ok: false, denial: null, detail: "Không tìm thấy nháp scale." };
  const { draft } = ctx;
  if (draft.status === "PAUSED") return { ok: true, draftId: draft.id, detail: "Chiến dịch scale đã tắt từ trước — không ghi gì thêm." };
  const campaignId = draft.fbCampaignId;
  if (draft.status !== "ACTIVE" || !campaignId) return { ok: false, denial: null, detail: `Nháp đang ở trạng thái ${draft.status} — không có gì đang chạy để tắt.` };
  const log = (x: Omit<ScaleLog, "draft" | "actor" | "mode" | "now">, exec: Exec = db) => logScale(exec, { ...x, draft, actor: req.actor, mode: d.env.mode, now });
  const g = gateScaleWrite({
    hardEnabled: d.env.hardEnabled,
    mode: d.env.mode,
    action: "PAUSE_SCALE",
    configComplete: true,
    approved: true,
    approvalMatches: true,
    sourceCampaignId: null,
    templateCampaignId: ctx.templateId,
    ourCopy: true,
    verdict: "PENDING",
    alreadyCopied: true,
    otherDraftsForVariant: 0,
    budgetVnd: 0,
    activeTotalVnd: 0,
  });
  if (!g.ok) {
    await log({ action: "PAUSE_SCALE", outcome: "DENIED", denial: g.denial, detail: g.reason, targetId: campaignId });
    return { ok: false, denial: g.denial, detail: g.reason };
  }
  try {
    await d.writer.setScaleStatus(campaignId, "PAUSED");
  } catch (e) {
    await log({ action: "PAUSE_SCALE", outcome: "FAILED", detail: errText(e), targetId: campaignId, request: { status: "PAUSED" } });
    return { ok: false, denial: null, detail: `Facebook từ chối: ${errText(e)}` };
  }
  const detail = `Đã tắt chiến dịch scale ${campaignId} (${req.actor.label}).`;
  await db.transaction(async (tx) => {
    await tx.update(T.creativeScaleDrafts).set({ status: "PAUSED", pausedAt: now, updatedAt: now }).where(eq(T.creativeScaleDrafts.id, draft.id));
    await log({ action: "PAUSE_SCALE", outcome: "APPLIED", detail, targetId: campaignId, request: { status: "PAUSED" } }, tx);
  });
  return { ok: true, draftId: draft.id, detail };
}

/** Bỏ qua một đề nghị (hoặc một nháp dựng hỏng). Không gọi Facebook; dòng ở lại để máy không đề nghị lại. */
export async function dismissScaleDraft(db: Db, req: { draftId: string; actor: Actor & { id: string } }, now: Date): Promise<ScaleResult> {
  const rows = await db
    .update(T.creativeScaleDrafts)
    .set({ status: "DISMISSED", dismissedByUserId: req.actor.id, dismissedAt: now, updatedAt: now })
    .where(and(eq(T.creativeScaleDrafts.id, req.draftId), inArray(T.creativeScaleDrafts.status, ["PROPOSED", "FAILED"] satisfies ScaleDraftStatus[])))
    .returning({ id: T.creativeScaleDrafts.id, fbCampaignId: T.creativeScaleDrafts.fbCampaignId });
  if (rows.length === 0) return { ok: false, denial: null, detail: "Chỉ bỏ qua được đề nghị chưa dựng, hoặc nháp dựng hỏng." };
  const orphan = rows[0].fbCampaignId ? ` Bản sao ${rows[0].fbCampaignId} vẫn nằm TẮT trên Ads Manager — xoá tay nếu không dùng.` : "";
  return { ok: true, draftId: req.draftId, detail: `Đã bỏ qua.${orphan}` };
}

// ───────────────────────────── 5. TIN BÁO ─────────────────────────────

/** Đề nghị chưa báo — lượt tick gom thành MỘT tin, gửi được thì đóng dấu `notified_at`. */
export async function unnotifiedProposals(db: Db): Promise<{ id: string; kind: string; headline: string; slot: number; batchDay: string; verdict: string }[]> {
  return db
    .select({ id: T.creativeScaleDrafts.id, kind: T.creativeScaleDrafts.kind, headline: T.creativeVariants.headline, slot: T.creativeVariants.slot, batchDay: T.creativeBatches.batchDay, verdict: T.creativeScaleDrafts.proposedVerdict })
    .from(T.creativeScaleDrafts)
    .innerJoin(T.creativeVariants, eq(T.creativeVariants.id, T.creativeScaleDrafts.variantId))
    .innerJoin(T.creativeBatches, eq(T.creativeBatches.id, T.creativeVariants.batchId))
    .where(and(eq(T.creativeScaleDrafts.status, "PROPOSED"), isNull(T.creativeScaleDrafts.notifiedAt)));
}

export async function markProposalsNotified(db: Db, ids: string[], now: Date): Promise<void> {
  if (ids.length === 0) return;
  await db.update(T.creativeScaleDrafts).set({ notifiedAt: now }).where(inArray(T.creativeScaleDrafts.id, ids));
}

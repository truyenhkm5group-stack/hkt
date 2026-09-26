import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { stableStringify } from "@/lib/ai/policy";
import type { AdsWriteMode } from "@/lib/constants/ads-write";
import type { Actor } from "@/lib/constants/actor";
import {
  CREATIVE_WRITE_DENIAL_REASON,
  PUBLISH_REQUIRED_FIELDS,
  normalizeCreativeConfig,
  variantRuleSet,
  type CreativeLoopConfig,
  type CreativeRule,
  type CreativeWriteAction,
  type CreativeWriteDenial,
} from "@/lib/constants/creative-loop";
import { vnDay } from "@/lib/constants/marketing-decision-ledger";
import {
  activateTestCampaign,
  adsWriteHardEnabled,
  adsWriteMode,
  createAd,
  createAdCreative,
  createTestAdset,
  createTestCampaign,
  extendAdset,
  pauseAdset,
  readAdsKillSwitch,
  readTemplateAd,
  testCampaignFields,
  uploadAdImage,
  vndToFbMinor,
  type TemplateAd,
} from "@/lib/integrations/facebook/ads-write";
import { gateCreativeWrite, gateCreativeWritePrefix, type CreativeGateInput, type CreativePauseKind } from "@/lib/marketing/creative-write-gate";
import { approvalDigest, type ApprovalContent } from "@/lib/creative/approval";
import { sha256Hex } from "@/lib/creative/images";
import { describeRule } from "@/lib/creative/judge";
import { buildObjectStorySpec } from "@/lib/creative/story-spec";
import { publishOrder } from "@/lib/creative/manual";

/**
 * ═══════════ ĐĂNG LÔ ĐÃ DUYỆT · TẮT THEO LUẬT — BÀN TAY CỦA VÒNG MẪU ═══════════
 *
 * Đặc tả: `docs/creative-loop.md` §1–§3. Cổng: `lib/marketing/creative-write-gate.ts`. Cửa ghi:
 * `lib/integrations/facebook/ads-write.ts` — tệp này KHÔNG gọi mạng, chỉ gọi các hàm của cửa ghi qua
 * `deps.writer` (mặc định là hàm thật; kiểm thử tiêm bản giả).
 *
 * ─── BỐN TÍNH CHẤT MÀ MỌI NHÁNH PHẢI GIỮ ───
 *
 *  1. **Không duyệt thì không một lời gọi nào.** Lô phải `APPROVED`, và digest TÍNH LẠI từ CSDL (băm
 *     ảnh đọc từ `creative_images.sha256`) phải khớp `approval_digest`. Lệch ⇒ ghi sổ DENIED
 *     `APPROVAL_MISMATCH` và dừng — kể cả đọc mẩu mẫu cũng không.
 *  2. **Mọi bước vào sổ `creative_fb_actions`**: APPLIED · FAILED · DENIED, kể cả lượt bị chặn.
 *     Lượt DENIED trùng hệt (cùng lô · mẫu · hành động · mã chặn) chỉ ghi MỘT lần: vòng chạy mười
 *     phút một lần, và một sổ đầy bản sao của cùng một lần chặn thì không ai đọc nữa.
 *  3. **Id Facebook lưu NGAY khi có**, cùng giao dịch với dòng sổ. Chết giữa chừng thì lượt sau CHẠY
 *     TIẾP từ bước dở: mẫu đã có nhóm mà chưa có mẩu thì chỉ tạo mẩu, KHÔNG tạo nhóm thứ hai (hai
 *     nhóm là hai lần cam kết 200.000đ cho một mẫu).
 *  4. **Hỏng thì không tự thử lại.** Bước nào FAILED thì mẫu thành `PUBLISH_FAILED` — cùng lý do với
 *     `retries: 0` của cửa ghi: phản hồi rơi mất sau khi Facebook đã tạo nhóm thì thử lại là nhóm thứ
 *     hai. Nhóm đã tạo mà tạo mẩu hỏng thì TẮT nhóm (dọn dẹp) rồi mới đánh dấu lỗi. Bước TẠO chiến dịch /
 *     nhóm / mẩu ghi `fb_pending_step` NGAY TRƯỚC lời gọi và xoá cùng giao dịch lưu id: lượt sau thấy dấu
 *     ấy còn ⇒ tiến trình đã chết giữa lời gọi và lúc ghi ⇒ KHÔNG gửi lại, đánh lỗi kèm tên để tìm tay.
 *
 * ─── MỖI BÀI MỘT CHIẾN DỊCH (chủ shop chốt 25/09/2026, `docs/creative-loop.md` §5i) ───
 *
 * Mỗi mẫu: tải ảnh → tạo bài → tạo CHIẾN DỊCH riêng (TẮT, trường chép từ chiến dịch của mẩu mẫu) → tạo
 * NHÓM trong đó (ngân sách TRỌN ĐỜI 200.000đ + `end_time` như cũ) → tạo MẨU → BẬT chiến dịch (công tắc
 * tổng, bước CUỐI — chỉ tới đây mẫu mới `LIVE`). Hỏng ở bất kỳ bước nào trước khi bật ⇒ chiến dịch vẫn
 * TẮT, không đồng nào chảy, id đã tạo nằm nguyên trên mẫu và trong sổ. Mẫu đã có nhóm mà KHÔNG có chiến
 * dịch riêng là mẫu đăng dở theo cấu trúc CŨ (chung chiến dịch test) ⇒ đi tiếp đúng đường cũ.
 */

const T = schema;

// ───────────────────────────── PHỤ THUỘC TIÊM ĐƯỢC ─────────────────────────────

/** Các hàm của cửa ghi mà vòng dùng. Mặc định là hàm thật; kiểm thử tiêm bản giả để không chạm Facebook. */
export type CreativeWriter = {
  readTemplateAd: typeof readTemplateAd;
  uploadAdImage: typeof uploadAdImage;
  createAdCreative: typeof createAdCreative;
  createTestCampaign: typeof createTestCampaign;
  createTestAdset: typeof createTestAdset;
  createAd: typeof createAd;
  activateTestCampaign: typeof activateTestCampaign;
  pauseAdset: typeof pauseAdset;
  extendAdset: typeof extendAdset;
};

export const REAL_CREATIVE_WRITER: CreativeWriter = { readTemplateAd, uploadAdImage, createAdCreative, createTestCampaign, createTestAdset, createAd, activateTestCampaign, pauseAdset, extendAdset };

/** Chốt env ĐỌC Ở TẦNG GỌI rồi truyền vào cổng thuần. Cửa ghi thật còn đọc lại lần nữa trước lời gọi mạng. */
export type CreativeWriteEnv = { hardEnabled: boolean; mode: AdsWriteMode };

export type CreativeDeps = { writer?: CreativeWriter; env?: CreativeWriteEnv };

function resolveDeps(deps: CreativeDeps = {}): { writer: CreativeWriter; env: CreativeWriteEnv } {
  return { writer: deps.writer ?? REAL_CREATIVE_WRITER, env: deps.env ?? { hardEnabled: adsWriteHardEnabled(), mode: adsWriteMode() } };
}

/** Máy tự làm: không có tài khoản người nào chịu trách nhiệm (AGENTS.md mục 34 — `id: null` là MÁY). */
export const CREATIVE_LOOP_ACTOR: Actor = { id: null, label: "job:creative-loop" };

// ───────────────────────────── ẢNH CHỤP CẤU HÌNH CỦA LÔ ─────────────────────────────

export type BatchConfig = {
  config: CreativeLoopConfig;
  /** Ngân sách một mẫu đọc NGUYÊN từ ảnh chụp (chưa kẹp) — để cổng nói thật khi nó vượt trần. */
  budgetPerVariantVnd: number;
  configComplete: boolean;
};

/**
 * Lô chạy theo ẢNH CHỤP cấu hình lúc lập lô (`config_snapshot`), không theo cấu hình hiện tại: luật
 * tắt, ngân sách và khung giờ mà người duyệt đã thấy là của ảnh chụp, và phiếu duyệt khoá trên đó.
 *
 * Ngân sách thiếu trong ảnh chụp ⇒ cấu hình KHÔNG ĐỦ — không lấy mặc định: người duyệt phải thấy đúng
 * con số sẽ bị cam kết, không phải một con số mà máy tự điền.
 */
export function batchConfig(snapshot: Record<string, unknown>): BatchConfig {
  const { config, problems } = normalizeCreativeConfig(snapshot);
  const raw = snapshot.budgetPerVariantVnd;
  const budgetKnown = typeof raw === "number" && Number.isFinite(raw);
  const missing = problems.some((p) => (PUBLISH_REQUIRED_FIELDS as readonly string[]).includes(p.field));
  return { config, budgetPerVariantVnd: budgetKnown ? raw : 0, configComplete: budgetKnown && !missing };
}

/** Mẫu nằm trong phiếu duyệt: mọi mẫu đã có ảnh và không bị gạt / sinh lỗi. Trạng thái đổi dọc đường đăng không làm digest đổi. */
const DIGEST_STATUSES = ["GENERATED", "LIVE", "PAUSED", "ENDED", "PUBLISH_FAILED"];

type BatchRow = typeof T.creativeBatches.$inferSelect;
type VariantRow = typeof T.creativeVariants.$inferSelect;

/** Nội dung mà phiếu duyệt khoá, dựng lại từ CSDL. Đường duyệt và đường đăng gọi CHUNG hàm này. */
export async function batchApprovalContent(db: Db, batch: Pick<BatchRow, "id" | "batchDay" | "startAt" | "endAt" | "configSnapshot">): Promise<ApprovalContent> {
  const cfg = batchConfig(batch.configSnapshot);
  const rows = await db
    .select({
      id: T.creativeVariants.id,
      primaryText: T.creativeVariants.primaryText,
      headline: T.creativeVariants.headline,
      rules: T.creativeVariants.rulesSnapshot,
      campaignName: T.creativeVariants.campaignName,
      adsetName: T.creativeVariants.adsetName,
      adName: T.creativeVariants.adName,
      sha256: T.creativeImages.sha256,
    })
    .from(T.creativeVariants)
    .leftJoin(T.creativeImages, eq(T.creativeImages.id, T.creativeVariants.imageId))
    .where(and(eq(T.creativeVariants.batchId, batch.id), inArray(T.creativeVariants.status, DIGEST_STATUSES)));
  return {
    batchDay: batch.batchDay,
    startAt: batch.startAt,
    endAt: batch.endAt,
    budgetPerVariantVnd: cfg.budgetPerVariantVnd,
    killRules: cfg.config.killRules,
    variants: rows.map((r) => ({ id: r.id, imageSha256: r.sha256 ?? "", primaryText: r.primaryText, headline: r.headline, rules: r.rules ?? null, names: { campaign: r.campaignName, adset: r.adsetName, ad: r.adName } })),
  };
}

// ───────────────────────────── SỔ GHI ─────────────────────────────

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Exec = Db | Tx;

export type LogInput = {
  actionDay: string;
  batchId: string | null;
  variantId: string | null;
  action: CreativeWriteAction;
  outcome: "APPLIED" | "DENIED" | "FAILED";
  denial?: CreativeWriteDenial | "";
  detail: string;
  targetId?: string;
  amountVnd?: number | null;
  /** Các trường đã gửi — KHÔNG BAO GIỜ kèm token (cửa ghi tự gắn token, nơi gọi không cầm nó). */
  request?: Record<string, unknown>;
  actor: Actor;
  mode: string;
};

export async function logAction(db: Exec, r: LogInput) {
  if (r.outcome === "DENIED") {
    // Một lần chặn là MỘT sự kiện, dù vòng hỏi lại mười phút một lần.
    const [dup] = await db
      .select({ id: T.creativeFbActions.id })
      .from(T.creativeFbActions)
      .where(
        and(
          r.batchId ? eq(T.creativeFbActions.batchId, r.batchId) : isNull(T.creativeFbActions.batchId),
          r.variantId ? eq(T.creativeFbActions.variantId, r.variantId) : isNull(T.creativeFbActions.variantId),
          eq(T.creativeFbActions.action, r.action),
          eq(T.creativeFbActions.outcome, "DENIED"),
          eq(T.creativeFbActions.denial, r.denial ?? ""),
        ),
      )
      .limit(1);
    if (dup) return;
  }
  await db.insert(T.creativeFbActions).values({
    actionDay: r.actionDay,
    batchId: r.batchId,
    variantId: r.variantId,
    action: r.action,
    outcome: r.outcome,
    denial: r.outcome === "APPLIED" ? "" : (r.denial ?? ""),
    detail: r.detail.slice(0, 2000),
    targetId: r.targetId ?? "",
    amountVnd: r.amountVnd ?? null,
    request: r.request ?? {},
    actorUserId: r.actor.id,
    actorEmail: r.actor.label,
    mode: r.mode,
  });
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Tổng tiền test ĐÃ CAM KẾT cho một ngày chạy — đếm trên SỔ (lượt tạo nhóm đã áp), không trên cấu hình. */
export async function committedTestSpendForDay(db: Exec, actionDay: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${T.creativeFbActions.amountVnd}), 0)::int` })
    .from(T.creativeFbActions)
    .where(and(eq(T.creativeFbActions.actionDay, actionDay), eq(T.creativeFbActions.action, "CREATE_ADSET"), eq(T.creativeFbActions.outcome, "APPLIED")));
  return Number(row?.total ?? 0);
}

/**
 * Tổng tiền "tiêu thêm" đã áp trong NGÀY BẤM (giờ Việt Nam), toàn shop. Đếm theo mốc ghi sổ chứ không
 * theo `action_day` — `action_day` là ngày CHẠY của lô, còn trần tiêu thêm là trần của một ngày bấm.
 */
export async function extendedOnDay(db: Exec, now: Date): Promise<number> {
  const day = vnDay(now);
  const from = new Date(`${day}T00:00:00+07:00`);
  const to = new Date(from.getTime() + 24 * 3_600_000);
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${T.creativeFbActions.amountVnd}), 0)::int` })
    .from(T.creativeFbActions)
    .where(
      and(
        eq(T.creativeFbActions.action, "EXTEND_ADSET"),
        eq(T.creativeFbActions.outcome, "APPLIED"),
        gte(T.creativeFbActions.createdAt, from),
        lt(T.creativeFbActions.createdAt, to),
      ),
    );
  return Number(row?.total ?? 0);
}

async function publishedInBatch(db: Exec, batchId: string, exceptVariantId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(T.creativeVariants)
    .where(
      and(
        eq(T.creativeVariants.batchId, batchId),
        isNotNull(T.creativeVariants.fbAdsetId),
        ne(T.creativeVariants.status, "PUBLISH_FAILED"),
        ne(T.creativeVariants.id, exceptVariantId),
      ),
    );
  return Number(row?.n ?? 0);
}

// ───────────────────────────── ĐĂNG ─────────────────────────────

export type PublishBatchResult = "PUBLISHED" | "IN_PROGRESS" | "DENIED" | "TOO_LATE" | "ERROR" | "FAILED";

export type PublishBatchReport = {
  batchId: string;
  batchDay: string;
  result: PublishBatchResult;
  live: number;
  failed: number;
  denied: number;
  detail: string;
};

/** Hai mã chặn này không đổi trong suốt ngày chạy — mẫu bị chúng chặn coi như đã xử lý xong. */
const FINAL_DENIALS: readonly CreativeWriteDenial[] = ["OVER_BATCH_SIZE", "OVER_DAILY_CAP"];

/**
 * Đăng mọi lô `APPROVED` còn trước giờ chạy. Gọi mỗi lượt tick của vòng; chạy lại bao nhiêu lần cũng
 * không đăng một mẫu hai lần (xem tính chất 3 ở đầu tệp).
 */
export async function publishApprovedBatches(db: Db, now: Date, deps?: CreativeDeps): Promise<PublishBatchReport[]> {
  const d = resolveDeps(deps);
  const batches = await db.select().from(T.creativeBatches).where(eq(T.creativeBatches.status, "APPROVED")).orderBy(asc(T.creativeBatches.batchDay));
  const out: PublishBatchReport[] = [];
  for (const b of batches) out.push(await publishOneBatch(db, b, now, d));
  return out;
}

/**
 * Đăng MỘT lô ngay lúc này — đường của nút "Đăng camp" (lô `INSTANT`). Đi qua ĐÚNG `publishOneBatch` của lượt
 * tick: tính lại digest, công tắc khẩn, năm chốt đầu, cổng từng bước, sổ ghi. Lô không còn `APPROVED` (vd lượt
 * tick vừa đăng xong) ⇒ `null`, không gọi gì.
 */
export async function publishBatchNow(db: Db, batchId: string, now: Date, deps?: CreativeDeps): Promise<PublishBatchReport | null> {
  const [b] = await db.select().from(T.creativeBatches).where(and(eq(T.creativeBatches.id, batchId), eq(T.creativeBatches.status, "APPROVED"))).limit(1);
  if (!b) return null;
  return publishOneBatch(db, b, now, resolveDeps(deps));
}

async function loadVariants(db: Exec, batchId: string): Promise<VariantRow[]> {
  return db.select().from(T.creativeVariants).where(eq(T.creativeVariants.batchId, batchId)).orderBy(asc(T.creativeVariants.slot));
}

async function publishOneBatch(db: Db, b: BatchRow, now: Date, d: { writer: CreativeWriter; env: CreativeWriteEnv }): Promise<PublishBatchReport> {
  const report: PublishBatchReport = { batchId: b.id, batchDay: b.batchDay, result: "IN_PROGRESS", live: 0, failed: 0, denied: 0, detail: "" };
  const { config, budgetPerVariantVnd, configComplete } = batchConfig(b.configSnapshot);
  const machine = CREATIVE_LOOP_ACTOR;
  const mode = d.env.mode;
  const log = (x: Omit<LogInput, "actionDay" | "batchId" | "actor" | "mode">, exec: Exec = db) =>
    logAction(exec, { ...x, actionDay: b.batchDay, batchId: b.id, actor: machine, mode });

  const variants = await loadVariants(db, b.id);
  // Mẫu TỰ LÀM đăng trước ô máy lập — trần số mẫu cắt ở cuối danh sách (`publishOrder`).
  const pending = publishOrder(variants.filter((v) => v.status === "GENERATED"));

  /*
    QUÁ GIỜ CHẠY THÌ KHÔNG ĐĂNG, VÀ LÔ PHẢI RỜI TRẠNG THÁI "ĐÃ DUYỆT".

    Đây là một SỰ THẬT của đồng hồ, không phải một lượt xin ghi: sau `startAt` không gì của lô này còn
    đăng được nữa. Mẫu chưa đăng giữ nguyên trạng thái; mỗi mẫu để lại MỘT dòng DENIED `TOO_LATE`
    ("máy đã định đăng mà không kịp"). Nhóm đăng dở (có nhóm, chưa có mẩu) thì tắt dọn dẹp.
  */
  if (now.getTime() >= b.startAt.getTime()) {
    for (const v of pending) {
      await log({ variantId: v.id, action: nextStep(v), outcome: "DENIED", denial: "TOO_LATE", detail: CREATIVE_WRITE_DENIAL_REASON.TOO_LATE });
      report.denied += 1;
      if (v.fbAdsetId) await pauseCreativeVariant(db, { variantId: v.id, kind: "CLEANUP", actor: machine }, now, { writer: d.writer, env: d.env });
      // Chiến dịch riêng đã tạo mà chưa bật thì vẫn TẮT — không đồng nào chảy; id giữ nguyên để người xoá tay.
      if (v.fbAdsetId || v.fbCampaignId) await db.update(T.creativeVariants).set({ status: "PUBLISH_FAILED", updatedAt: now }).where(eq(T.creativeVariants.id, v.id));
    }
    const live = variants.filter(isOnFacebook).length;
    await db
      .update(T.creativeBatches)
      .set(
        live > 0
          ? { status: "PUBLISHED", publishedAt: b.publishedAt ?? now, error: pending.length ? `Quá giờ chạy: ${pending.length} mẫu chưa kịp đăng.` : b.error, updatedAt: now }
          : { status: "EXPIRED", error: "Quá giờ chạy mà chưa đăng được mẫu nào — không đồng nào được chi.", updatedAt: now },
      )
      .where(and(eq(T.creativeBatches.id, b.id), eq(T.creativeBatches.status, "APPROVED")));
    return { ...report, result: "TOO_LATE", live, detail: `Quá giờ chạy — ${pending.length} mẫu không đăng.` };
  }

  /*
    CÔNG TẮC KHẨN CẤP TRƯỚC MỌI LỜI GỌI FACEBOOK CỦA LÔ.

    `graphPost()` tự chặn từng lời gọi ghi, nên bỏ đoạn này đi cũng không lọt đồng nào. Nhưng khi đó
    mỗi mẫu sẽ vấp ở bước tải ảnh và thành `PUBLISH_FAILED` — một lô đã duyệt bị giết vĩnh viễn chỉ
    vì ai đó kéo công tắc năm phút. Dừng ở đây thì lô vẫn ĐÃ DUYỆT: nhả công tắc trước giờ chạy là
    lượt kế tiếp đăng tiếp. Không đọc được công tắc ⇒ coi như đang kéo (mục 31).
  */
  const kill = await readAdsKillSwitch();
  if (kill.killed) {
    const detail = `${CREATIVE_WRITE_DENIAL_REASON.KILL_SWITCH} ${kill.reason ?? ""}`.trim();
    await log({ variantId: null, action: "CREATE_ADSET", outcome: "DENIED", denial: "KILL_SWITCH", detail });
    return { ...report, result: "DENIED", denied: 1, detail };
  }

  const digestNow = approvalDigest(await batchApprovalContent(db, b));
  const approved = b.status === "APPROVED" && b.approvalDigest !== "";
  const approvalMatches = approved && digestNow === b.approvalDigest;

  /*
    NĂM CHỐT ĐẦU TRƯỚC KHI ĐỌC FACEBOOK.

    Đường ghi đang tắt, cấu hình thiếu, hay nội dung đã đổi sau khi duyệt ⇒ không tiêu một lượt gọi
    API nào, kể cả lượt ĐỌC mẩu mẫu. Chặn ở đây là chặn cả lô, nên dòng sổ không gắn mẫu nào.
  */
  const prefix = gateCreativeWritePrefix({ hardEnabled: d.env.hardEnabled, mode, action: "CREATE_ADSET", configComplete, approved, approvalMatches });
  if (!prefix.ok) {
    const extra = prefix.denial === "APPROVAL_MISMATCH" ? ` (digest đã duyệt ${b.approvalDigest.slice(0, 12)}…, tính lại ${digestNow.slice(0, 12)}…)` : "";
    await log({ variantId: null, action: "CREATE_ADSET", outcome: "DENIED", denial: prefix.denial, detail: prefix.reason + extra });
    return { ...report, result: "DENIED", denied: 1, detail: prefix.reason };
  }

  if (pending.length > 0) {
    let template: TemplateAd;
    try {
      template = await d.writer.readTemplateAd(config.templateAdId);
    } catch (e) {
      const msg = `Không đọc được mẩu mẫu ${config.templateAdId}: ${errText(e)}`;
      await db.update(T.creativeBatches).set({ error: msg, updatedAt: now }).where(eq(T.creativeBatches.id, b.id));
      return { ...report, result: "ERROR", detail: msg };
    }
    // Hình dạng bài mẫu kiểm MỘT lần cho cả lô, trước lời gọi ghi đầu tiên: mẫu lạ thì không tải một tấm ảnh nào.
    const shape = templateShapeError(template, config.pageId, pending.some(needsOwnCampaign));
    if (shape) {
      await db.update(T.creativeBatches).set({ error: shape, updatedAt: now }).where(eq(T.creativeBatches.id, b.id));
      return { ...report, result: "ERROR", detail: shape };
    }

    const runDenials = new Map<string, CreativeWriteDenial>();
    for (const v0 of pending) {
      const r = await publishOneVariant(db, { batch: b, variant: v0, template, config, budgetPerVariantVnd, configComplete, approved, approvalMatches, now, deps: d, log });
      if (r.kind === "LIVE") report.live += 1;
      else if (r.kind === "FAILED") report.failed += 1;
      else if (r.kind === "DENIED") {
        report.denied += 1;
        runDenials.set(v0.id, r.denial);
      }
    }

    const after = await loadVariants(db, b.id);
    const conLai = after.filter((v) => v.status === "GENERATED");
    const xong = conLai.every((v) => FINAL_DENIALS.includes(runDenials.get(v.id) ?? "HARD_DISABLED"));
    if (!xong) return { ...report, result: "IN_PROGRESS", detail: `${conLai.length} mẫu chưa đăng xong — lượt sau chạy tiếp.` };
  }

  const all = await loadVariants(db, b.id);
  const live = all.filter(isOnFacebook).length;
  if (live > 0) {
    await db.update(T.creativeBatches).set({ status: "PUBLISHED", publishedAt: now, updatedAt: now }).where(and(eq(T.creativeBatches.id, b.id), eq(T.creativeBatches.status, "APPROVED")));
    return { ...report, result: "PUBLISHED", detail: `Đã đăng ${live} mẫu.` };
  }
  const msg = "Không mẫu nào đăng được — xem sổ ghi Facebook của lô.";
  await db.update(T.creativeBatches).set({ status: "FAILED", error: msg, updatedAt: now }).where(and(eq(T.creativeBatches.id, b.id), eq(T.creativeBatches.status, "APPROVED")));
  return { ...report, result: "FAILED", detail: msg };
}

type IdCols = Pick<VariantRow, "fbImageHash" | "fbCreativeId" | "fbCampaignId" | "fbAdsetId" | "fbAdId">;

/** Mẫu đăng dở theo cấu trúc CŨ: đã có nhóm trong chiến dịch test chung, không có chiến dịch riêng. */
export function isLegacyStructure(v: Pick<VariantRow, "fbAdsetId" | "fbCampaignId">): boolean {
  return !!v.fbAdsetId && !v.fbCampaignId;
}

/** Mẫu còn phải TẠO chiến dịch riêng. */
function needsOwnCampaign(v: Pick<VariantRow, "fbAdsetId" | "fbCampaignId">): boolean {
  return !isLegacyStructure(v) && !v.fbCampaignId;
}

/** Mẫu đã thật sự lên Facebook và từng chạy (không tính mẫu đăng dở / chiến dịch chưa bật). */
function isOnFacebook(v: Pick<VariantRow, "status">): boolean {
  return v.status === "LIVE" || v.status === "PAUSED" || v.status === "ENDED";
}

/** Bước kế tiếp của một mẫu, suy từ những id Facebook nó đã có. Hàm thuần. */
export function nextStep(v: IdCols): CreativeWriteAction {
  if (!v.fbImageHash) return "UPLOAD_IMAGE";
  if (!v.fbCreativeId) return "CREATE_CREATIVE";
  if (needsOwnCampaign(v)) return "CREATE_CAMPAIGN";
  if (!v.fbAdsetId) return "CREATE_ADSET";
  if (!v.fbAdId) return "CREATE_AD";
  return isLegacyStructure(v) ? "CREATE_AD" : "ACTIVATE_CAMPAIGN";
}

/**
 * Mẩu mẫu có dùng được để đăng không — hàm THUẦN, MỘT phép kiểm cho cả lượt đăng lô lẫn "Đăng camp" (kiểm TRƯỚC khi
 * ghi dòng nào). Ba câu hỏi:
 *  · Nhóm mẫu tối ưu tin nhắn về một fanpage KHÁC fanpage đã khai ⇒ bài đứng tên trang này mà tin nhắn của khách chảy
 *    sang trang kia: tiền vẫn tiêu, đơn không ai thấy. Chặn, không đoán trang nào đúng.
 *  · Mỗi bài một chiến dịch (§5i): chiến dịch của mẩu mẫu phải đọc được và để ngân sách ở cấp NHÓM (chỉ khi còn bài cần
 *    chiến dịch mới — `needCampaign`).
 *  · Bài mẫu dựng lại được thành bài của mình (`buildObjectStorySpec`, kể cả mẫu là quảng cáo động dạng ảnh đơn).
 * Được ⇒ `null`; không ⇒ câu lỗi cho người.
 */
export function templateShapeError(template: TemplateAd, pageId: string, needCampaign: boolean): string | null {
  const promotedPage = typeof template.adset.promotedObject?.page_id === "string" ? template.adset.promotedObject.page_id : null;
  if (promotedPage && promotedPage !== pageId) return `Nhóm của mẩu mẫu gửi tin nhắn về fanpage ${promotedPage}, khác fanpage đã khai ${pageId} — sửa cấu hình hoặc chọn mẩu mẫu khác.`;
  const camp = needCampaign ? campaignShapeError(template) : null;
  if (camp) return camp;
  const thu = buildObjectStorySpec(template.objectStorySpec, { pageId, imageHash: "kiem-tra", primaryText: "kiem-tra", headline: "" }, template.assetFeedSpec);
  return thu.ok ? null : thu.error;
}

/** Chiến dịch của mẩu mẫu KHÔNG dựng được chiến dịch riêng ⇒ câu lỗi; được ⇒ `null`. Hàm thuần. */
export function campaignShapeError(template: TemplateAd): string | null {
  if (!template.campaign) return "Không đọc được chiến dịch của mẩu mẫu (mục tiêu, hạng mục đặc biệt) — không tạo được chiến dịch riêng cho từng bài.";
  try {
    testCampaignFields("kiem-tra", template.campaign);
    return null;
  } catch (e) {
    return errText(e);
  }
}

/**
 * Tên sẽ gửi Facebook: tên người đã duyệt (§5i), rỗng ⇒ tên cũ `VM <ngày> #<ô>` (mẫu của lô trước khi có
 * khuôn tên). Bài quảng cáo (creative) giữ tên cũ — nó không hiện ở Ads Manager cạnh chiến dịch / nhóm / mẩu.
 */
export function publishNames(batchDay: string, v: Pick<VariantRow, "slot" | "campaignName" | "adsetName" | "adName">): { creative: string; campaign: string; adset: string; ad: string } {
  const legacy = `VM ${batchDay} #${v.slot}`;
  return { creative: legacy, campaign: v.campaignName || legacy, adset: v.adsetName || legacy, ad: v.adName || legacy };
}

/** `SKIPPED` = mẫu vừa đổi trạng thái / đang có lượt khác gửi — không ghi gì, lượt sau xét lại. */
type VariantOutcome = { kind: "LIVE" } | { kind: "FAILED" } | { kind: "SKIPPED" } | { kind: "DENIED"; denial: CreativeWriteDenial };

type PublishCtx = {
  batch: BatchRow;
  variant: VariantRow;
  template: TemplateAd;
  config: CreativeLoopConfig;
  budgetPerVariantVnd: number;
  configComplete: boolean;
  approved: boolean;
  approvalMatches: boolean;
  now: Date;
  deps: { writer: CreativeWriter; env: CreativeWriteEnv };
  log: (x: Omit<LogInput, "actionDay" | "batchId" | "actor" | "mode">, exec?: Exec) => Promise<void>;
};

async function publishOneVariant(db: Db, c: PublishCtx): Promise<VariantOutcome> {
  const { batch: b, config: cfg, now } = c;
  const v = { ...c.variant };
  const w = c.deps.writer;
  const account = cfg.adAccountId;
  const names = publishNames(b.batchDay, v);

  const markFailed = () => db.update(T.creativeVariants).set({ status: "PUBLISH_FAILED", fbPendingStep: "", fbPendingAt: null, updatedAt: now }).where(eq(T.creativeVariants.id, v.id));
  /** Dọn nhóm đã tạo (nếu có) rồi đánh lỗi. Chiến dịch riêng chưa bật thì vẫn TẮT — không cần lời gọi nào. */
  const failAndCleanup = async () => {
    if (v.fbAdsetId) await pauseCreativeVariant(db, { variantId: v.id, kind: "CLEANUP", actor: CREATIVE_LOOP_ACTOR }, now, c.deps);
    await markFailed();
    return { kind: "FAILED" as const };
  };

  /*
    DẤU "ĐANG GỬI" CÒN LẠI TỪ LƯỢT TRƯỚC ⇒ KHÔNG GỬI LẠI.

    Dấu được ghi NGAY TRƯỚC lời gọi tạo chiến dịch / nhóm / mẩu và xoá cùng giao dịch lưu id. Nó còn ở
    đây nghĩa là tiến trình chết giữa lúc Facebook nhận lời gọi và lúc ERP ghi kết quả: đối tượng CÓ THỂ
    đã tồn tại mà ERP không biết id. Gửi lại là một chiến dịch / nhóm thứ hai — nên đánh lỗi, nói tên để
    người tìm tay trên Ads Manager (chiến dịch riêng chưa bật thì vẫn TẮT, không đồng nào chảy).
  */
  if (v.fbPendingStep) {
    const step = v.fbPendingStep as CreativeWriteAction;
    const ten = step === "CREATE_CAMPAIGN" ? names.campaign : step === "CREATE_ADSET" ? names.adset : names.ad;
    await c.log({
      variantId: v.id,
      action: step,
      outcome: "FAILED",
      detail: `Lượt trước đã gửi "${step}" lúc ${v.fbPendingAt?.toISOString() ?? "?"} mà không ghi được kết quả — có thể Facebook đã tạo đối tượng tên "${ten}". Không gửi lại. Tìm theo tên trên Ads Manager để xoá tay${v.fbCampaignId ? ` (chiến dịch riêng ${v.fbCampaignId} vẫn TẮT)` : ""}.`,
    });
    return failAndCleanup();
  }
  /** Ghi dấu "đang gửi" — có điều kiện chưa có dấu nào, để hai lượt không cùng gửi một bước. */
  const claim = async (step: CreativeWriteAction) => {
    const rows = await db
      .update(T.creativeVariants)
      .set({ fbPendingStep: step, fbPendingAt: now, updatedAt: now })
      .where(and(eq(T.creativeVariants.id, v.id), eq(T.creativeVariants.fbPendingStep, ""), eq(T.creativeVariants.status, "GENERATED")))
      .returning({ id: T.creativeVariants.id });
    return rows.length > 0;
  };

  /** Cổng cho MỘT bước — đếm lại số mẫu đã đăng và tiền đã cam kết trên sổ ngay trước bước ấy. */
  const gate = async (action: CreativeWriteAction, targetCampaignId: string | null = null) => {
    const input: CreativeGateInput = {
      hardEnabled: c.deps.env.hardEnabled,
      mode: c.deps.env.mode,
      action,
      configComplete: c.configComplete,
      approved: c.approved,
      approvalMatches: c.approvalMatches,
      testCampaignId: cfg.testCampaignId,
      targetCampaignId,
      templateCampaignId: c.template.campaignId,
      ownCampaignId: v.fbCampaignId,
      ourAdset: false,
      now,
      startAt: b.startAt,
      budgetPerVariantVnd: c.budgetPerVariantVnd,
      publishedInBatch: await publishedInBatch(db, b.id, v.id),
      batchSize: cfg.batchSize,
      committedDayVnd: await committedTestSpendForDay(db, b.batchDay),
      variantHasAdset: !!v.fbAdsetId,
      pauseKind: null,
      killRuleFired: false,
      promising: false,
      extensionVnd: 0,
      extendedTodayVnd: 0,
    };
    const g = gateCreativeWrite(input);
    if (!g.ok) await c.log({ variantId: v.id, action, outcome: "DENIED", denial: g.denial, detail: g.reason });
    return g;
  };

  // ── 1. Tải ảnh ──
  if (!v.fbImageHash) {
    const g = await gate("UPLOAD_IMAGE");
    if (!g.ok) return { kind: "DENIED", denial: g.denial };
    const [img] = v.imageId
      ? await db
          .select({ sha256: T.creativeImages.sha256, data: T.creativeImages.data })
          .from(T.creativeImages)
          .where(and(eq(T.creativeImages.id, v.imageId), isNull(T.creativeImages.purgedAt)))
          .limit(1)
      : [];
    if (!img || !img.data) {
      await c.log({ variantId: v.id, action: "UPLOAD_IMAGE", outcome: "FAILED", detail: "Mẫu không còn điểm ảnh trong CSDL." });
      await markFailed();
      return { kind: "FAILED" };
    }
    /*
      BĂM LẠI TỪ CHÍNH CÁC BYTE SẮP GỬI ĐI. Digest khoá trên cột `sha256`; nếu điểm ảnh bị tráo mà cột
      băm giữ nguyên thì digest vẫn khớp — nên phép so cuối cùng phải làm trên byte thật.
    */
    if (sha256Hex(Buffer.from(img.data, "base64")) !== img.sha256) {
      await c.log({ variantId: v.id, action: "UPLOAD_IMAGE", outcome: "DENIED", denial: "APPROVAL_MISMATCH", detail: `${CREATIVE_WRITE_DENIAL_REASON.APPROVAL_MISMATCH} (Điểm ảnh không khớp băm đã duyệt.)` });
      return { kind: "DENIED", denial: "APPROVAL_MISMATCH" };
    }
    try {
      const hash = await w.uploadAdImage(account, img.data);
      await db.transaction(async (tx) => {
        await tx.update(T.creativeVariants).set({ fbImageHash: hash, updatedAt: now }).where(eq(T.creativeVariants.id, v.id));
        await c.log({ variantId: v.id, action: "UPLOAD_IMAGE", outcome: "APPLIED", detail: "Đã tải ảnh lên tài khoản quảng cáo.", targetId: hash, request: { account, imageId: v.imageId, sha256: img.sha256 } }, tx);
      });
      v.fbImageHash = hash;
    } catch (e) {
      await c.log({ variantId: v.id, action: "UPLOAD_IMAGE", outcome: "FAILED", detail: errText(e), request: { account, imageId: v.imageId } });
      await markFailed();
      return { kind: "FAILED" };
    }
  }

  // ── 2. Tạo bài quảng cáo ──
  if (!v.fbCreativeId) {
    const g = await gate("CREATE_CREATIVE");
    if (!g.ok) return { kind: "DENIED", denial: g.denial };
    const spec = buildObjectStorySpec(c.template.objectStorySpec, { pageId: cfg.pageId, imageHash: v.fbImageHash, primaryText: v.primaryText, headline: v.headline }, c.template.assetFeedSpec);
    const name = names.creative;
    if (!spec.ok) {
      await c.log({ variantId: v.id, action: "CREATE_CREATIVE", outcome: "FAILED", detail: spec.error });
      await markFailed();
      return { kind: "FAILED" };
    }
    try {
      const cr = await w.createAdCreative(account, { name, objectStorySpec: spec.spec });
      await db.transaction(async (tx) => {
        await tx.update(T.creativeVariants).set({ fbCreativeId: cr.id, fbPostId: cr.effectiveObjectStoryId, updatedAt: now }).where(eq(T.creativeVariants.id, v.id));
        await c.log({ variantId: v.id, action: "CREATE_CREATIVE", outcome: "APPLIED", detail: "Đã tạo bài quảng cáo.", targetId: cr.id, request: { account, name, object_story_spec: spec.spec } }, tx);
      });
      v.fbCreativeId = cr.id;
      v.fbPostId = cr.effectiveObjectStoryId;
    } catch (e) {
      await c.log({ variantId: v.id, action: "CREATE_CREATIVE", outcome: "FAILED", detail: errText(e), request: { account, name } });
      await markFailed();
      return { kind: "FAILED" };
    }
  }

  const legacy = isLegacyStructure(v);

  // ── 3. Tạo CHIẾN DỊCH riêng của bài — LUÔN TẮT (§5i). Mẫu đăng dở theo cấu trúc cũ bỏ qua bước này. ──
  if (needsOwnCampaign(v)) {
    const g = await gate("CREATE_CAMPAIGN");
    if (!g.ok) return { kind: "DENIED", denial: g.denial };
    const tpl = c.template.campaign;
    const name = names.campaign;
    if (!tpl) {
      await c.log({ variantId: v.id, action: "CREATE_CAMPAIGN", outcome: "FAILED", detail: "Không đọc được chiến dịch của mẩu mẫu." });
      await markFailed();
      return { kind: "FAILED" };
    }
    const request = { account, name, status: "PAUSED", objective: tpl.objective, special_ad_categories: tpl.specialAdCategories, buying_type: tpl.buyingType, template_campaign_id: c.template.campaignId };
    if (!(await claim("CREATE_CAMPAIGN"))) return { kind: "SKIPPED" };
    try {
      const campaignId = await w.createTestCampaign(account, { name, template: tpl });
      await db.transaction(async (tx) => {
        await tx.update(T.creativeVariants).set({ fbCampaignId: campaignId, fbPendingStep: "", fbPendingAt: null, updatedAt: now }).where(eq(T.creativeVariants.id, v.id));
        await c.log({ variantId: v.id, action: "CREATE_CAMPAIGN", outcome: "APPLIED", detail: "Đã tạo chiến dịch riêng của bài — đang TẮT, chỉ bật ở bước cuối.", targetId: campaignId, request }, tx);
      });
      v.fbCampaignId = campaignId;
    } catch (e) {
      await c.log({ variantId: v.id, action: "CREATE_CAMPAIGN", outcome: "FAILED", detail: errText(e), request });
      await markFailed();
      return { kind: "FAILED" };
    }
  }

  // ── 4. Tạo nhóm test — lượt DUY NHẤT cam kết tiền ──
  if (!v.fbAdsetId) {
    const campaignId = legacy ? cfg.testCampaignId : (v.fbCampaignId ?? "");
    const g = await gate("CREATE_ADSET", campaignId || null);
    if (!g.ok) return { kind: "DENIED", denial: g.denial };
    const name = names.adset;
    const request = {
      account,
      name,
      campaign_id: campaignId,
      lifetime_budget_vnd: c.budgetPerVariantVnd,
      lifetime_budget_minor: vndToFbMinor(c.budgetPerVariantVnd, cfg.currency),
      currency: cfg.currency,
      start_time: b.startAt.toISOString(),
      end_time: b.endAt.toISOString(),
      template_ad_id: c.template.adId,
    };
    if (!(await claim("CREATE_ADSET"))) return { kind: "SKIPPED" };
    try {
      const adsetId = await w.createTestAdset(account, {
        name,
        campaignId,
        lifetimeBudgetMinor: request.lifetime_budget_minor,
        startTime: b.startAt,
        endTime: b.endAt,
        template: c.template.adset,
      });
      // Id nhóm và dòng sổ cam kết tiền đi CÙNG một giao dịch: có cái này thì có cái kia.
      await db.transaction(async (tx) => {
        await tx.update(T.creativeVariants).set({ fbAdsetId: adsetId, fbPendingStep: "", fbPendingAt: null, updatedAt: now }).where(eq(T.creativeVariants.id, v.id));
        await c.log({ variantId: v.id, action: "CREATE_ADSET", outcome: "APPLIED", detail: "Đã tạo nhóm test (ngân sách trọn đời + end_time).", targetId: adsetId, amountVnd: c.budgetPerVariantVnd, request }, tx);
      });
      v.fbAdsetId = adsetId;
    } catch (e) {
      await c.log({ variantId: v.id, action: "CREATE_ADSET", outcome: "FAILED", detail: `${errText(e)}${v.fbCampaignId ? ` · chiến dịch riêng ${v.fbCampaignId} vẫn TẮT` : ""}`, request });
      await markFailed();
      return { kind: "FAILED" };
    }
  }

  // ── 5. Tạo mẩu ──
  if (!v.fbAdId) {
    const g = await gate("CREATE_AD");
    if (!g.ok) return { kind: "DENIED", denial: g.denial };
    const name = names.ad;
    const adsetId = v.fbAdsetId ?? "";
    const request = { account, name, adset_id: adsetId, creative_id: v.fbCreativeId };
    if (!(await claim("CREATE_AD"))) return { kind: "SKIPPED" };
    try {
      const adId = await w.createAd(account, { name, adsetId, creativeId: v.fbCreativeId });
      await db.transaction(async (tx) => {
        // Cấu trúc cũ: có mẩu là đang chạy. Cấu trúc mới: chiến dịch riêng còn TẮT — `LIVE` chỉ sau bước bật.
        await tx
          .update(T.creativeVariants)
          .set(legacy ? { fbAdId: adId, fbPendingStep: "", fbPendingAt: null, status: "LIVE", committedBudgetVnd: c.budgetPerVariantVnd, publishedAt: now, updatedAt: now } : { fbAdId: adId, fbPendingStep: "", fbPendingAt: null, updatedAt: now })
          .where(eq(T.creativeVariants.id, v.id));
        await c.log({ variantId: v.id, action: "CREATE_AD", outcome: "APPLIED", detail: legacy ? "Đã tạo mẩu quảng cáo — mẫu đang chạy." : "Đã tạo mẩu quảng cáo — chờ bật chiến dịch.", targetId: adId, request }, tx);
      });
      v.fbAdId = adId;
      if (legacy) return { kind: "LIVE" };
    } catch (e) {
      await c.log({ variantId: v.id, action: "CREATE_AD", outcome: "FAILED", detail: errText(e), request });
      // Nhóm đã có mà mẩu không — tắt nhóm để nó không bao giờ tiêu tiền ngoài ý muốn, rồi mới báo lỗi.
      return failAndCleanup();
    }
  }
  if (legacy) return { kind: "LIVE" };

  // ── 6. BẬT chiến dịch riêng — công tắc tổng, bước CUỐI ──
  {
    const campaignId = v.fbCampaignId ?? "";
    const g = await gate("ACTIVATE_CAMPAIGN", campaignId || null);
    if (!g.ok) return { kind: "DENIED", denial: g.denial };
    try {
      await w.activateTestCampaign(campaignId);
      await db.transaction(async (tx) => {
        await tx.update(T.creativeVariants).set({ status: "LIVE", committedBudgetVnd: c.budgetPerVariantVnd, publishedAt: now, updatedAt: now }).where(eq(T.creativeVariants.id, v.id));
        await c.log({ variantId: v.id, action: "ACTIVATE_CAMPAIGN", outcome: "APPLIED", detail: "Đã bật chiến dịch riêng — mẫu đang chạy.", targetId: campaignId, request: { campaign_id: campaignId, status: "ACTIVE" } }, tx);
      });
      return { kind: "LIVE" };
    } catch (e) {
      await c.log({ variantId: v.id, action: "ACTIVATE_CAMPAIGN", outcome: "FAILED", detail: `${errText(e)} · chiến dịch ${campaignId} vẫn TẮT`, request: { campaign_id: campaignId, status: "ACTIVE" } });
      return failAndCleanup();
    }
  }
}

// ───────────────────────────── TẮT ─────────────────────────────

export type PauseRequest = {
  variantId: string;
  kind: CreativePauseKind;
  actor: Actor;
  /** `KILL_RULE`: luật đã kích hoạt — phải nằm trong luật tắt của ảnh chụp lô. */
  rule?: CreativeRule | null;
  /** Nhóm mà nơi gọi định tắt. Khác nhóm của mẫu ⇒ `NOT_OUR_AD`. */
  adsetId?: string;
  /** Lô mà nơi gọi nghĩ mẫu thuộc về. Khác ⇒ `NOT_OUR_AD`. */
  batchId?: string;
  /** `HUMAN`: người đã bấm xác nhận. */
  confirmed?: boolean;
};

export type PauseResult = { ok: true; detail: string } | { ok: false; denial: CreativeWriteDenial | null; detail: string };

function sameRule(a: CreativeRule, b: CreativeRule): boolean {
  const norm = (r: CreativeRule) => stableStringify({ metric: r.metric, op: r.op, value: r.value, minSpendVnd: r.minSpendVnd, label: r.label || undefined });
  return norm(a) === norm(b);
}

/**
 * Tắt MỘT mẫu — một đường cho cả ba căn cứ (luật tắt · người bấm · dọn dẹp), để ba căn cứ không mọc
 * ra ba cách ghi sổ. Mẫu đã `PAUSED` thì trả về thành công mà KHÔNG ghi gì (cùng tinh thần AGENTS.md
 * mục 61: bấm hai lần không đẻ hai dòng).
 */
export async function pauseCreativeVariant(db: Db, req: PauseRequest, now: Date, deps?: CreativeDeps): Promise<PauseResult> {
  const d = resolveDeps(deps);
  const [row] = await db
    .select({ v: T.creativeVariants, b: T.creativeBatches })
    .from(T.creativeVariants)
    .innerJoin(T.creativeBatches, eq(T.creativeBatches.id, T.creativeVariants.batchId))
    .where(eq(T.creativeVariants.id, req.variantId))
    .limit(1);
  if (!row) return { ok: false, denial: null, detail: "Không tìm thấy mẫu." };
  const { v, b } = row;
  if (v.status === "PAUSED") return { ok: true, detail: "Mẫu đã tắt từ trước — không ghi gì thêm." };
  if (req.kind !== "CLEANUP" && v.status !== "LIVE") return { ok: false, denial: null, detail: `Mẫu không còn chạy (${v.status}) — không có gì để tắt.` };

  const cfg = batchConfig(b.configSnapshot);
  const adsetId = v.fbAdsetId ?? "";
  const ourAdset = !!v.fbAdsetId && (req.adsetId === undefined || req.adsetId === v.fbAdsetId) && (req.batchId === undefined || req.batchId === v.batchId);
  const rule = req.rule ?? null;
  // Luật tắt THUỘC LÔ = luật tắt của ảnh chụp lô, hoặc luật RIÊNG của ô (ô mockup) — cả hai nằm trong phiếu duyệt.
  const allowedKill = variantRuleSet(v.rulesSnapshot, cfg.config).killRules;
  const killRuleFired = req.kind === "KILL_RULE" && rule !== null && allowedKill.some((r) => sameRule(r, rule));

  const g = gateCreativeWrite({
    hardEnabled: d.env.hardEnabled,
    mode: d.env.mode,
    action: "PAUSE_ADSET",
    configComplete: cfg.configComplete,
    // Máy tắt (theo luật / dọn dẹp) đứng trên lượt duyệt lô đã khoá bộ luật; người tắt đứng trên cú bấm của chính họ.
    approved: req.kind === "HUMAN" ? req.confirmed === true : b.approvalDigest !== "",
    approvalMatches: true,
    testCampaignId: cfg.config.testCampaignId,
    targetCampaignId: null,
    templateCampaignId: null,
    ourAdset,
    now,
    startAt: b.startAt,
    budgetPerVariantVnd: cfg.budgetPerVariantVnd,
    publishedInBatch: 0,
    batchSize: cfg.config.batchSize,
    committedDayVnd: 0,
    variantHasAdset: !!v.fbAdsetId,
    pauseKind: req.kind,
    killRuleFired,
    promising: false,
    extensionVnd: 0,
    extendedTodayVnd: 0,
  });

  const lyDo =
    req.kind === "KILL_RULE" && rule ? `Luật tắt: ${describeRule(rule)}` : req.kind === "HUMAN" ? `Người tắt tay: ${req.actor.label}` : "Dọn nhóm đăng dở (máy tự tắt nhóm do chính nó tạo).";
  const base = { actionDay: b.batchDay, batchId: b.id, variantId: v.id, action: "PAUSE_ADSET" as const, actor: req.actor, mode: d.env.mode };

  if (!g.ok) {
    await logAction(db, { ...base, outcome: "DENIED", denial: g.denial, detail: `${g.reason} ${lyDo}`, targetId: req.adsetId ?? adsetId, request: { adset_id: req.adsetId ?? adsetId, kind: req.kind, rule } });
    return { ok: false, denial: g.denial, detail: g.reason };
  }

  try {
    await d.writer.pauseAdset(adsetId);
  } catch (e) {
    await logAction(db, { ...base, outcome: "FAILED", detail: `${errText(e)} · ${lyDo}`, targetId: adsetId, request: { adset_id: adsetId, status: "PAUSED", kind: req.kind } });
    return { ok: false, denial: null, detail: errText(e) };
  }
  await db.transaction(async (tx) => {
    if (req.kind !== "CLEANUP") {
      await tx.update(T.creativeVariants).set({ status: "PAUSED", pausedAt: now, pauseReason: lyDo, updatedAt: now }).where(eq(T.creativeVariants.id, v.id));
    } else {
      await tx.update(T.creativeVariants).set({ pausedAt: now, pauseReason: lyDo, updatedAt: now }).where(eq(T.creativeVariants.id, v.id));
    }
    await logAction(tx, { ...base, outcome: "APPLIED", detail: lyDo, targetId: adsetId, request: { adset_id: adsetId, status: "PAUSED", kind: req.kind, rule } });
  });
  return { ok: true, detail: lyDo };
}

/** Một lệnh tắt từ bộ chấm (gói B): mẫu nào, lô nào, nhóm nào, vì luật nào. */
export type CreativeKill = { variantId: string; batchId: string; adsetId: string; rule: CreativeRule };

export type KillReport = { variantId: string; ok: boolean; denial: CreativeWriteDenial | null; detail: string };

/**
 * Tắt theo luật. Mỗi lệnh đi qua cổng như một lượt máy tắt (`KILL_RULE`): lô phải có
 * `approval_digest`, và luật phải nằm trong luật tắt của ẢNH CHỤP lô — hoặc trong LUẬT RIÊNG của ô
 * (`rules_snapshot`, ô mockup), cũng nằm trong phiếu duyệt. Luật gõ thêm vào cấu hình sau khi duyệt KHÔNG
 * tắt được mẫu của lô cũ, vì người duyệt chưa từng thấy nó.
 */
export async function applyKills(db: Db, kills: CreativeKill[], now: Date, deps?: CreativeDeps): Promise<KillReport[]> {
  const out: KillReport[] = [];
  for (const k of kills) {
    const r = await pauseCreativeVariant(db, { variantId: k.variantId, batchId: k.batchId, adsetId: k.adsetId, kind: "KILL_RULE", rule: k.rule, actor: CREATIVE_LOOP_ACTOR }, now, deps);
    out.push({ variantId: k.variantId, ok: r.ok, denial: r.ok ? null : r.denial, detail: r.detail });
  }
  return out;
}

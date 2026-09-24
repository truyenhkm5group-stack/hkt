"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { actionToken, verifyActionToken } from "@/lib/ai/policy";
import { ACTION_FOR_DECISION, ADS_WRITE_ACTION_LABEL, ADS_WRITE_DENIAL_REASON, ADS_WRITE_LIMITS, type AdsWriteAction } from "@/lib/constants/ads-write";
import { vnDay } from "@/lib/constants/marketing-decision-ledger";
import type { AdsAction, DecisionBasis } from "@/lib/constants/ads-decision";
import { actionFor, brakeState, gateAdsWrite, gateIntradayScale, planProductBudget, subjectDetail, subjectFreshness, type PlanRow, type PlanTarget } from "@/lib/marketing/ads-write-gate";
import { INTRADAY_DECISION, intradayNextBudget, intradayRateCheck, intradayScaleVerdict } from "@/lib/constants/ads-intraday";
import { appliedTodayByCampaign, getIntradayBoard } from "@/lib/queries/ads-intraday";
import { decisionStability, productCampaignCandidates, spendAroundWindow } from "@/lib/queries/marketing-ledger";
import {
  adsWriteDisabledReason,
  adsWriteHardEnabled,
  adsWriteMode,
  applyAdsWrite,
  brakeObservations,
  campaignChangesToday,
  readCampaignState,
  shiftedToday,
} from "@/lib/integrations/facebook/ads-write";

/**
 * ═══════════ BÀN TAY CỦA PHÒNG MARKETING — HAI BƯỚC, KHÔNG BAO GIỜ MỘT ═══════════
 *
 * Đặc tả: `docs/marketing-ai-department.md` mục 5. Chủ shop duyệt 22/09/2026 ở nấc `COPILOT`.
 *
 *   1. `proposeAdsBudgetChange()` — ĐỌC, không ghi gì. Trả về đề nghị kèm PHIẾU DUYỆT
 *      (HMAC của người · tool · đầu vào đã chuẩn hoá).
 *   2. `applyAdsBudgetChange()`   — nhận lại phiếu, tính lại y hệt ở máy chủ, rồi mới gọi Facebook.
 *
 * ─── VÌ SAO PHIẾU DUYỆT LÀ HMAC CHỨ KHÔNG PHẢI MỘT CỜ `confirmed: true` ───
 *
 * Một cờ boolean đến từ trình duyệt, nên nó nói được bất cứ điều gì. Phiếu HMAC gắn với NGƯỜI và
 * với ĐẦU VÀO: đổi một chữ số trong ngân sách sau khi đề nghị đã phát là phiếu vô hiệu, và không ai
 * duyệt hộ người khác được. Cơ chế này đã có sẵn ở `lib/ai/policy.ts` cho AI Copilot — dùng lại
 * nguyên, không dựng cái thứ hai.
 *
 * ─── MỌI LƯỢT ĐỀU VÀO SỔ, KỂ CẢ LƯỢT BỊ CHẶN ───
 *
 * *"Máy đã ĐỊNH làm gì"* là thông tin quý nhất khi đánh giá một cỗ máy tự chủ. Một sổ chỉ ghi lượt
 * thành công sẽ khiến một luật sai trông như một luật thận trọng: nó xin sai hai mươi lần mỗi ngày,
 * hàng rào chặn hết, và không ai biết để đi sửa luật.
 */

/** Tên tool trong phiếu duyệt. Đổi chuỗi này là vô hiệu hoá mọi phiếu đang lưu hành — đó là ý muốn. */
const TOOL = "ads.budget";

export type AdsProposal = {
  campaignId: string;
  campaignName: string;
  decision: string;
  action: AdsWriteAction | null;
  actionLabel: string;
  currentBudgetVnd: number | null;
  nextBudgetVnd: number | null;
  heldDays: number;
  /** Phiếu duyệt. `null` = không đề nghị được, lý do ở `blocked`. */
  token: string | null;
  blocked: string | null;
  /** Cảnh báo KHÔNG chặn — ví dụ ngân sách đặt ở cấp nhóm nên đổi ở cấp chiến dịch vô tác dụng. */
  warning: string | null;
};

const applySchema = z.object({
  campaignId: z.string().min(1),
  action: z.enum(["SET_DAILY_BUDGET", "PAUSE_CAMPAIGN"]),
  nextBudgetVnd: z.number().int().nullable(),
  token: z.string().min(8),
});

export type ApplyAdsBudgetInput = z.infer<typeof applySchema>;

/** Đầu vào ký trong phiếu duyệt — ĐÚNG ba trường quyết định hậu quả, không hơn. */
function tokenPayload(i: { campaignId: string; action: AdsWriteAction; nextBudgetVnd: number | null }) {
  return { campaignId: i.campaignId, action: i.action, nextBudgetVnd: i.nextBudgetVnd };
}

const ledger = schema.adsDecisionLedger;

async function latestLedgerRow(campaignId: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(ledger)
    .where(and(eq(ledger.dimension, "campaign"), eq(ledger.entityKey, campaignId)))
    .orderBy(desc(ledger.decisionDay))
    .limit(1);
  return row ?? null;
}

/**
 * BƯỚC 1 — ĐỀ NGHỊ. Chỉ đọc, không ghi một dòng nào.
 *
 * Cố ý KHÔNG gọi Facebook khi đường ghi đang đóng: không có gì để đề nghị thì cũng không có lý do
 * gì để tiêu một lượt gọi API và một giây chờ của người dùng.
 */
export async function proposeAdsBudgetChange(campaignId: string): Promise<AdsProposal | { error: string }> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
  if (!campaignId) return { error: "Thiếu mã chiến dịch" };

  const row = await latestLedgerRow(campaignId);
  if (!row) return { error: "Chưa có dòng sổ quyết định nào cho chiến dịch này — bật job `marketing-decision-ledger` trước đã." };

  const action = ACTION_FOR_DECISION[row.action] ?? null;
  const today = vnDay(new Date());
  const stability = (await decisionStability("campaign", [campaignId], today)).get(campaignId);

  const base: AdsProposal = {
    campaignId,
    campaignName: row.entityName,
    decision: row.action,
    action,
    actionLabel: action ? ADS_WRITE_ACTION_LABEL[action] : "—",
    currentBudgetVnd: null,
    nextBudgetVnd: null,
    heldDays: stability?.heldDays ?? 0,
    token: null,
    blocked: null,
    warning: null,
  };

  const disabled = adsWriteDisabledReason();
  if (disabled) return { ...base, blocked: disabled };
  if (!action) return { ...base, blocked: `Khuyến nghị "${row.action}" không đẻ ra hành động ngân sách nào.` };

  /*
    CHIẾN DỊCH TRƯỚC, ĐỘ BỀN SAU — CÙNG THỨ TỰ VỚI `gateAdsWrite`.

    Hỏi Facebook trước khi hỏi độ bền tốn thêm một lượt gọi cho những đề nghị chưa chín. Đổi lại,
    người bấm nghe được câu đúng: "chiến dịch này đã chạy lại từ 20/09" quan trọng hơn hẳn "khuyến
    nghị mới giữ 2 ngày" — câu sau hứa rằng đợi thêm một ngày là bấm được, trong khi không phải.
  */
  const state = await readCampaignState(campaignId).catch(() => null);
  const quanh = await spendAroundWindow(campaignId, row.periodFrom, row.periodTo);
  const subject = { status: state?.status ?? null, spendInWindowVnd: quanh.inWindow, spendAfterWindowVnd: quanh.afterWindow };
  const tuoi = subjectFreshness(subject);
  if (!tuoi.ok) return { ...base, blocked: `${ADS_WRITE_DENIAL_REASON[tuoi.denial]} ${subjectDetail(subject)}`.trim() };
  if (!state) return { ...base, blocked: "Không đọc được trạng thái chiến dịch từ Facebook." };

  if (!stability?.ready) return { ...base, blocked: stability?.reason ?? "Chưa đo được độ bền của khuyến nghị." };

  const next =
    action === "PAUSE_CAMPAIGN" || state.dailyBudgetVnd === null
      ? null
      : Math.round(state.dailyBudgetVnd * (1 + ADS_WRITE_LIMITS.proposeStepPct));

  return {
    ...base,
    campaignName: state.name || row.entityName,
    currentBudgetVnd: state.dailyBudgetVnd,
    nextBudgetVnd: next,
    token: actionToken(user.id, TOOL, tokenPayload({ campaignId, action, nextBudgetVnd: next })),
    warning: state.budgetAtAdsetLevel ? "Chiến dịch này đặt ngân sách ở CẤP NHÓM — đổi ở cấp chiến dịch sẽ không có tác dụng gì." : null,
  };
}

type ApplyResult = { ok: true; detail: string } | { error: string };

/** BƯỚC 2 — ÁP. Ghi sổ trước khi trả về, kể cả khi bị chặn. */
export async function applyAdsBudgetChange(raw: ApplyAdsBudgetInput): Promise<ApplyResult> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
  const parsed = applySchema.safeParse(raw);
  if (!parsed.success) return { error: "Đầu vào không hợp lệ" };
  const input = parsed.data;

  const today = vnDay(new Date());
  const row = await latestLedgerRow(input.campaignId);
  if (!row) return { error: "Chưa có dòng sổ quyết định nào cho chiến dịch này." };
  const stability = (await decisionStability("campaign", [input.campaignId], today)).get(input.campaignId);
  if (!stability) return { error: "Không đọc được độ bền của khuyến nghị." };

  /*
    PHIẾU DUYỆT TÍNH LẠI Ở MÁY CHỦ.

    Client gửi lại đúng chuỗi nó nhận; máy chủ băm lại từ (người · tool · đầu vào) rồi so bằng phép
    so hằng-thời-gian. Sửa một chữ số trong ngân sách sau khi đề nghị đã phát ⇒ không khớp ⇒ không ghi.
  */
  const confirmed = verifyActionToken(input.token, user.id, TOOL, tokenPayload(input));

  const state = await readCampaignState(input.campaignId).catch(() => null);
  const quanh = await spendAroundWindow(input.campaignId, row.periodFrom, row.periodTo);
  const brake = brakeState(await brakeObservations().catch(() => []));

  const gate = gateAdsWrite({
    hardEnabled: adsWriteHardEnabled(),
    mode: adsWriteMode(),
    confirmed,
    decision: row.action as AdsAction,
    // Căn cứ lấy từ DÒNG SỔ, không nhận từ client — client gửi được thì hàng rào chỉ là lời khuyên.
    basis: row.basis as DecisionBasis,
    // Trạng thái SỐNG từ Facebook và tiền sau kỳ — đọc ở máy chủ ngay lúc bấm, không tin client.
    subject: { status: state?.status ?? null, spendInWindowVnd: quanh.inWindow, spendAfterWindowVnd: quanh.afterWindow },
    level: "campaign",
    stability,
    currentBudgetVnd: state?.dailyBudgetVnd ?? null,
    nextBudgetVnd: input.nextBudgetVnd,
    shiftedTodayVnd: await shiftedToday(today),
    changesForCampaignToday: await campaignChangesToday(input.campaignId, today),
    brake,
  });

  const db = await getDb();
  const common = {
    changeDay: today,
    campaignId: input.campaignId,
    campaignName: state?.name || row.entityName,
    action: input.action,
    decision: row.action,
    ledgerId: row.id,
    heldDays: stability.heldDays,
    budgetBefore: state?.dailyBudgetVnd ?? null,
    profitBefore: row.profitAfterAds,
    actorUserId: user.id,
    // TÊN do MÁY CHỦ đọc từ phiên, KHÔNG nhận từ client (AGENTS.md mục 34).
    actorEmail: user.email,
    mode: adsWriteMode(),
  };

  if (!gate.allow) {
    await db.insert(schema.adsBudgetChanges).values({ ...common, outcome: "DENIED", denial: gate.denial, detail: gate.reason, budgetAfter: null });
    await audit({
      userId: user.id,
      userEmail: user.email,
      action: "ADS_BUDGET_DENIED",
      entity: "CAMPAIGN",
      entityId: input.campaignId,
      reason: gate.reason,
      after: { action: input.action, nextBudgetVnd: input.nextBudgetVnd },
    });
    return { error: gate.reason };
  }

  const applied = await applyAdsWrite({
    campaignId: input.campaignId,
    action: gate.action,
    nextBudgetVnd: input.nextBudgetVnd,
    currency: state?.currency ?? "VND",
  });

  await db.insert(schema.adsBudgetChanges).values({
    ...common,
    outcome: applied.ok ? "APPLIED" : "FAILED",
    denial: "",
    detail: applied.detail,
    budgetAfter: applied.ok && gate.action === "SET_DAILY_BUDGET" ? input.nextBudgetVnd : null,
  });

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: applied.ok ? "ADS_BUDGET_APPLIED" : "ADS_BUDGET_FAILED",
    entity: "CAMPAIGN",
    entityId: input.campaignId,
    before: { dailyBudgetVnd: state?.dailyBudgetVnd ?? null, status: state?.status ?? "" },
    after: { action: gate.action, nextBudgetVnd: input.nextBudgetVnd },
    reason: `Khuyến nghị ${row.action} đã giữ ${stability.heldDays} ngày · ${applied.detail}`,
  });

  for (const path of ["/ads", "/work", "/"]) revalidatePath(path);
  return applied.ok ? { ok: true, detail: applied.detail } : { error: applied.detail };
}


/* ═══════════════════ BÀN TAY Ở CẤP MÃ HÀNG ═══════════════════ */

/**
 * Tên tool RIÊNG cho kế hoạch cấp mã: một phiếu duyệt cấp chiến dịch không được dùng để áp một kế
 * hoạch cấp mã, và ngược lại. Hai tool, hai không gian phiếu.
 */
const TOOL_PRODUCT = "ads.budget.product";

export type ProductBudgetPlan = {
  productId: string;
  productName: string;
  decision: string;
  heldDays: number;
  rows: PlanRow[];
  /** Phiếu duyệt — CHỈ phủ những dòng được phép. `null` = không có dòng nào áp được. */
  token: string | null;
  /** Lý do chặn CẢ kế hoạch (ghi đang tắt · khuyến nghị không có hành động · chưa chín · không có chiến dịch nào chạy). */
  blocked: string | null;
  totalShiftVnd: number;
};

/**
 * Đầu vào ký trong phiếu: mã hàng + đúng tập (chiến dịch → ngân sách đích), xếp theo mã chiến dịch
 * để thứ tự hiển thị không làm đổi chữ ký. Đổi một con số, thêm hay bớt một chiến dịch ⇒ phiếu vô hiệu.
 */
function productTokenPayload(productId: string, rows: { campaignId: string; nextBudgetVnd: number | null }[]) {
  return {
    productId,
    rows: [...rows].sort((a, b) => a.campaignId.localeCompare(b.campaignId)).map((r) => ({ c: r.campaignId, n: r.nextBudgetVnd })),
  };
}

async function latestProductLedgerRow(productId: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(ledger)
    .where(and(eq(ledger.dimension, "product"), eq(ledger.entityKey, productId)))
    .orderBy(desc(ledger.decisionDay))
    .limit(1);
  return row ?? null;
}

/** Đọc trạng thái sống của từng ứng viên — song song, và lỗi của một chiến dịch không làm hỏng cả kế hoạch. */
async function readTargets(list: { campaignId: string; name: string }[], today: string): Promise<PlanTarget[]> {
  return Promise.all(
    list.map(async (c) => {
      const [state, changesToday] = await Promise.all([
        readCampaignState(c.campaignId).catch(() => null),
        campaignChangesToday(c.campaignId, today),
      ]);
      return {
        campaignId: c.campaignId,
        name: state?.name || c.name,
        // `null` = không đọc được ⇒ `subjectFreshness` chặn dòng ấy với lý do riêng, không đoán.
        status: state ? state.status : null,
        currentBudgetVnd: state?.dailyBudgetVnd ?? null,
        changesToday,
      };
    }),
  );
}

/**
 * BƯỚC 1 — ĐỀ NGHỊ KẾ HOẠCH. Chỉ đọc, không ghi một dòng nào.
 *
 * Trả về TỪNG chiến dịch sẽ đổi ra sao hoặc vì sao bị chặn — người bấm thấy toàn bộ trước khi có một
 * đồng nào bị đổi. Đây chính là bản CHẠY THỬ mà kho này đòi ở mọi đường ghi hàng loạt.
 */
export async function proposeProductBudgetPlan(productId: string): Promise<ProductBudgetPlan | { error: string }> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
  if (!productId) return { error: "Thiếu mã hàng" };

  const row = await latestProductLedgerRow(productId);
  if (!row) return { error: "Chưa có dòng sổ quyết định nào cho mã hàng này." };

  const today = vnDay(new Date());
  const stability = (await decisionStability("product", [productId], today)).get(productId);
  const base: ProductBudgetPlan = {
    productId,
    productName: row.entityName,
    decision: row.action,
    heldDays: stability?.heldDays ?? 0,
    rows: [],
    token: null,
    blocked: null,
    totalShiftVnd: 0,
  };

  const disabled = adsWriteDisabledReason();
  if (disabled) return { ...base, blocked: disabled };
  if (!actionFor(row.action as AdsAction, "product")) return { ...base, blocked: `Khuyến nghị "${row.action}" của mã không đẻ ra hành động ngân sách nào.` };
  if (!stability?.ready) return { ...base, blocked: stability?.reason ?? "Chưa đo được độ bền của khuyến nghị cấp mã." };

  const ungVien = await productCampaignCandidates(productId);
  if (!ungVien.length) return { ...base, blocked: "Mã này không có chiến dịch nào chi tiền trong 7 ngày qua — không có gì để đổi." };

  const targets = await readTargets(ungVien, today);
  const rows = planProductBudget({
    hardEnabled: adsWriteHardEnabled(),
    mode: adsWriteMode(),
    // Đề nghị xem trước NHƯ THỂ đã có người xác nhận — nếu không thì mọi dòng đều bị chặn vì
    // "chưa ai bấm", và người đọc không thấy được lý do THẬT của từng dòng.
    confirmed: true,
    decision: row.action as AdsAction,
    basis: row.basis as DecisionBasis,
    stability,
    brake: brakeState(await brakeObservations().catch(() => [])),
    shiftedTodayVnd: await shiftedToday(today),
    targets,
  });
  const duoc = rows.filter((r) => r.allow);
  return {
    ...base,
    rows,
    token: duoc.length ? actionToken(user.id, TOOL_PRODUCT, productTokenPayload(productId, duoc)) : null,
    blocked: duoc.length ? null : "Không chiến dịch nào của mã này đổi được lúc này — lý do từng dòng ở bảng dưới.",
    totalShiftVnd: duoc.reduce((t, r) => t + Math.abs(r.deltaVnd), 0),
  };
}

const applyProductSchema = z.object({
  productId: z.string().min(1),
  rows: z.array(z.object({ campaignId: z.string().min(1), nextBudgetVnd: z.number().int().nullable() })).min(1).max(50),
  token: z.string().min(8),
});

export type ApplyProductPlanInput = z.infer<typeof applyProductSchema>;

/**
 * BƯỚC 2 — ÁP KẾ HOẠCH. Đọc lại MỌI THỨ ở máy chủ, kiểm lại từng dòng với trạng thái SỐNG, rồi mới ghi.
 *
 * Mỗi chiến dịch một dòng `ads_budget_changes`, kể cả dòng bị chặn, và tất cả cùng trỏ `ledger_id`
 * về dòng sổ CẤP MÃ — nhờ vậy phanh biết đây là MỘT quyết định chứ không phải N quyết định.
 */
export async function applyProductBudgetPlan(raw: ApplyProductPlanInput): Promise<{ ok: true; detail: string } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
  const parsed = applyProductSchema.safeParse(raw);
  if (!parsed.success) return { error: "Đầu vào không hợp lệ" };
  const input = parsed.data;

  const confirmed = verifyActionToken(input.token, user.id, TOOL_PRODUCT, productTokenPayload(input.productId, input.rows));
  const row = await latestProductLedgerRow(input.productId);
  if (!row) return { error: "Chưa có dòng sổ quyết định nào cho mã hàng này." };
  const today = vnDay(new Date());
  const stability = (await decisionStability("product", [input.productId], today)).get(input.productId);
  if (!stability) return { error: "Không đọc được độ bền của khuyến nghị cấp mã." };

  const targets = await readTargets(input.rows.map((r) => ({ campaignId: r.campaignId, name: "" })), today);
  const plan = planProductBudget({
    hardEnabled: adsWriteHardEnabled(),
    mode: adsWriteMode(),
    confirmed,
    decision: row.action as AdsAction,
    basis: row.basis as DecisionBasis,
    stability,
    brake: brakeState(await brakeObservations().catch(() => [])),
    shiftedTodayVnd: await shiftedToday(today),
    targets,
    lockedNext: new Map(input.rows.map((r) => [r.campaignId, r.nextBudgetVnd])),
  });

  const db = await getDb();
  let applied = 0;
  let denied = 0;
  let failed = 0;
  for (const r of plan) {
    const common = {
      changeDay: today,
      campaignId: r.campaignId,
      campaignName: r.name,
      action: "SET_DAILY_BUDGET" as const,
      decision: row.action,
      // Dòng sổ CẤP MÃ — phanh gom theo đây, nên một quyết định là một quan sát.
      ledgerId: row.id,
      heldDays: stability.heldDays,
      budgetBefore: r.currentBudgetVnd,
      profitBefore: row.profitAfterAds,
      actorUserId: user.id,
      actorEmail: user.email,
      mode: adsWriteMode(),
    };
    if (!r.allow) {
      denied += 1;
      await db.insert(schema.adsBudgetChanges).values({ ...common, outcome: "DENIED", denial: r.denial ?? "", detail: `[theo mã ${row.entityName}] ${r.reason}`, budgetAfter: null });
      continue;
    }
    const kq = await applyAdsWrite({ campaignId: r.campaignId, action: "SET_DAILY_BUDGET", nextBudgetVnd: r.nextBudgetVnd, currency: "VND" });
    if (kq.ok) applied += 1;
    else failed += 1;
    await db.insert(schema.adsBudgetChanges).values({
      ...common,
      outcome: kq.ok ? "APPLIED" : "FAILED",
      denial: "",
      detail: `[theo mã ${row.entityName}] ${kq.detail}`,
      budgetAfter: kq.ok ? r.nextBudgetVnd : null,
    });
  }

  const tomTat = `Mã ${row.entityName} (${row.action}, giữ ${stability.heldDays} ngày): ${applied} chiến dịch đã đổi · ${denied} bị chặn · ${failed} lỗi khi ghi.`;
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: failed ? "ADS_BUDGET_FAILED" : applied ? "ADS_BUDGET_APPLIED" : "ADS_BUDGET_DENIED",
    entity: "PRODUCT",
    entityId: input.productId,
    reason: tomTat,
    after: { rows: plan.map((r) => ({ campaignId: r.campaignId, next: r.nextBudgetVnd, allow: r.allow, denial: r.denial })) },
  });

  for (const path of ["/ads", "/work", "/"]) revalidatePath(path);
  return applied > 0 ? { ok: true, detail: tomTat } : { error: tomTat };
}

/* ═══════════════════ LÀN NHANH: TĂNG NGÂN SÁCH TRONG NGÀY ═══════════════════ */

/**
 * Tên tool RIÊNG: phiếu duyệt của làn nhanh không dùng được cho làn sổ quyết định, và ngược lại —
 * hai làn đứng trên hai căn cứ khác nhau, nên một chữ ký không được đi qua cả hai.
 */
const TOOL_INTRADAY = "ads.budget.intraday";

export type IntradayProposal = {
  campaignId: string;
  campaignName: string;
  currentBudgetVnd: number | null;
  nextBudgetVnd: number | null;
  /** Câu căn cứ bằng số HÔM NAY — người bấm phải đọc được vì sao máy đề nghị. */
  why: string;
  token: string | null;
  blocked: string | null;
  warning: string | null;
};

const intradayApplySchema = z.object({
  campaignId: z.string().min(1),
  nextBudgetVnd: z.number().int(),
  token: z.string().min(8),
});

function intradayTokenPayload(i: { campaignId: string; nextBudgetVnd: number | null }) {
  return { campaignId: i.campaignId, nextBudgetVnd: i.nextBudgetVnd };
}

/** BƯỚC 1 — ĐỀ NGHỊ tăng trong ngày. Chỉ đọc. */
export async function proposeIntradayScale(campaignId: string): Promise<IntradayProposal | { error: string }> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
  if (!campaignId) return { error: "Thiếu mã chiến dịch" };

  const board = await getIntradayBoard();
  const row = board.rows.find((r) => r.campaignId === campaignId);
  const base: IntradayProposal = {
    campaignId,
    campaignName: row?.name ?? campaignId,
    currentBudgetVnd: null,
    nextBudgetVnd: null,
    why: row?.verdict.reason ?? "Chiến dịch không có số chi hay đơn chốt nào hôm nay.",
    token: null,
    blocked: null,
    warning: null,
  };
  const disabled = adsWriteDisabledReason();
  if (disabled) return { ...base, blocked: disabled };
  if (!row || !row.verdict.eligible) return { ...base, blocked: `${ADS_WRITE_DENIAL_REASON.INTRADAY_NOT_ELIGIBLE} ${base.why}` };
  if (row.rate && !row.rate.ok) return { ...base, blocked: `${ADS_WRITE_DENIAL_REASON.INTRADAY_RATE_LIMIT} ${row.rate.reason}` };

  const state = await readCampaignState(campaignId).catch(() => null);
  if (!state) return { ...base, blocked: ADS_WRITE_DENIAL_REASON.SUBJECT_UNREADABLE };
  if (state.status !== "ACTIVE") return { ...base, blocked: `${ADS_WRITE_DENIAL_REASON.SUBJECT_NOT_RUNNING} (Facebook báo: ${state.status}.)` };
  const next = intradayNextBudget(state.dailyBudgetVnd);
  if (next === null) return { ...base, blocked: "Chưa đọc được ngân sách ngày hiện tại của chiến dịch." };

  return {
    ...base,
    campaignName: state.name || base.campaignName,
    currentBudgetVnd: state.dailyBudgetVnd,
    nextBudgetVnd: next,
    token: actionToken(user.id, TOOL_INTRADAY, intradayTokenPayload({ campaignId, nextBudgetVnd: next })),
    warning: state.budgetAtAdsetLevel ? "Chiến dịch này đặt ngân sách ở CẤP NHÓM — đổi ở cấp chiến dịch sẽ không có tác dụng gì." : null,
  };
}

/** BƯỚC 2 — ÁP. Máy chủ đọc lại MỌI thứ (số hôm nay, trạng thái, ngân sách, nhịp, phanh), rồi mới gọi Facebook. */
export async function applyIntradayScale(raw: z.infer<typeof intradayApplySchema>): Promise<ApplyResult> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Không có quyền" };
  const parsed = intradayApplySchema.safeParse(raw);
  if (!parsed.success) return { error: "Đầu vào không hợp lệ" };
  const input = parsed.data;

  const now = new Date();
  const today = vnDay(now);
  const confirmed = verifyActionToken(input.token, user.id, TOOL_INTRADAY, intradayTokenPayload(input));
  const board = await getIntradayBoard(now);
  const row = board.rows.find((r) => r.campaignId === input.campaignId);
  const verdict = row?.verdict ?? intradayScaleVerdict({ spendKnown: false, spend: 0, bookedOrders: 0, bookedRevenue: 0 });
  // Nhịp đọc LẠI ngay lúc bấm: hai người bấm cùng lúc thì người thứ hai phải thấy lượt của người thứ nhất.
  const moc = (await appliedTodayByCampaign([input.campaignId], today)).get(input.campaignId) ?? [];
  const state = await readCampaignState(input.campaignId).catch(() => null);

  const gate = gateIntradayScale({
    hardEnabled: adsWriteHardEnabled(),
    mode: adsWriteMode(),
    confirmed,
    brake: brakeState(await brakeObservations().catch(() => [])),
    status: state?.status ?? null,
    verdict,
    rate: intradayRateCheck(moc, now),
    currentBudgetVnd: state?.dailyBudgetVnd ?? null,
    nextBudgetVnd: input.nextBudgetVnd,
    shiftedTodayVnd: await shiftedToday(today),
  });

  const db = await getDb();
  const common = {
    changeDay: today,
    campaignId: input.campaignId,
    campaignName: state?.name || row?.name || input.campaignId,
    action: "SET_DAILY_BUDGET",
    decision: INTRADAY_DECISION,
    ledgerId: null,
    heldDays: 0,
    budgetBefore: state?.dailyBudgetVnd ?? null,
    // Làn nhanh không đứng trên lợi nhuận đã đo — để TRỐNG, không bịa một con số cho phanh so (mục 42).
    profitBefore: null,
    actorUserId: user.id,
    actorEmail: user.email,
    mode: adsWriteMode(),
  };

  if (!gate.allow) {
    await db.insert(schema.adsBudgetChanges).values({ ...common, outcome: "DENIED", denial: gate.denial, detail: gate.reason, budgetAfter: null });
    await audit({ userId: user.id, userEmail: user.email, action: "ADS_BUDGET_DENIED", entity: "CAMPAIGN", entityId: input.campaignId, reason: gate.reason, after: { lane: "INTRADAY", nextBudgetVnd: input.nextBudgetVnd } });
    return { error: gate.reason };
  }

  const applied = await applyAdsWrite({ campaignId: input.campaignId, action: "SET_DAILY_BUDGET", nextBudgetVnd: input.nextBudgetVnd, currency: state?.currency ?? "VND" });
  await db.insert(schema.adsBudgetChanges).values({
    ...common,
    outcome: applied.ok ? "APPLIED" : "FAILED",
    denial: "",
    detail: `${applied.detail} · Căn cứ trong ngày: ${verdict.reason}`,
    budgetAfter: applied.ok ? input.nextBudgetVnd : null,
  });
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: applied.ok ? "ADS_BUDGET_APPLIED" : "ADS_BUDGET_FAILED",
    entity: "CAMPAIGN",
    entityId: input.campaignId,
    before: { dailyBudgetVnd: state?.dailyBudgetVnd ?? null, status: state?.status ?? "" },
    after: { lane: "INTRADAY", nextBudgetVnd: input.nextBudgetVnd },
    reason: `Tăng trong ngày · ${verdict.reason} · ${applied.detail}`,
  });
  for (const path of ["/ads", "/work", "/"]) revalidatePath(path);
  return applied.ok ? { ok: true, detail: applied.detail } : { error: applied.detail };
}

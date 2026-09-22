"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { actionToken, verifyActionToken } from "@/lib/ai/policy";
import { ACTION_FOR_DECISION, ADS_WRITE_ACTION_LABEL, ADS_WRITE_LIMITS, type AdsWriteAction } from "@/lib/constants/ads-write";
import { vnDay } from "@/lib/constants/marketing-decision-ledger";
import type { AdsAction, DecisionBasis } from "@/lib/constants/ads-decision";
import { brakeState, gateAdsWrite } from "@/lib/marketing/ads-write-gate";
import { decisionStability } from "@/lib/queries/marketing-ledger";
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
  if (!stability?.ready) return { ...base, blocked: stability?.reason ?? "Chưa đo được độ bền của khuyến nghị." };

  const state = await readCampaignState(campaignId).catch(() => null);
  if (!state) return { ...base, blocked: "Không đọc được trạng thái chiến dịch từ Facebook." };

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
  const brake = brakeState(await brakeObservations().catch(() => []));

  const gate = gateAdsWrite({
    hardEnabled: adsWriteHardEnabled(),
    mode: adsWriteMode(),
    confirmed,
    decision: row.action as AdsAction,
    // Căn cứ lấy từ DÒNG SỔ, không nhận từ client — client gửi được thì hàng rào chỉ là lời khuyên.
    basis: row.basis as DecisionBasis,
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

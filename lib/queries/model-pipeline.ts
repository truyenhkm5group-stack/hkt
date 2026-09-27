import { asc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo } from "@/lib/cache";
import { lifecycleEvidenceGap, type LifecycleEvidenceGap } from "@/lib/constants/evidence-gaps";
import { winnerFollowUp } from "@/lib/constants/early-topic";
import { buildDeclarePreview } from "@/lib/constants/model-bulk-declare";
import { deriveModelSuggestions, loadSource, type Loaded, type Model360Block, type ModelSuggestion } from "@/lib/constants/model-360";
import { isModelState, type ModelState } from "@/lib/constants/model-lifecycle";
import { LINKED_RECEIPT_FROM, STALE_CREATIVE_TRACK_STATES, staleFactsOf, staleStateSuggestion } from "@/lib/constants/model-stale-state";
import type { ModelSignal } from "@/lib/constants/model-signal";
import {
  matchesPipelineFilters,
  pickNextAction,
  pipelineChips,
  pipelineColumnOf,
  pipelineFiltersKey,
  worstStockRisk,
  type PipelineCard,
  type PipelineFilters,
} from "@/lib/constants/model-pipeline";
import { countTopicsBlockingSuggestion } from "@/lib/constants/production-os";
import type { StockRisk } from "@/lib/constants/slow-moving";
import { deriveStockFeedback, mergeStockFeedbackSuggestions } from "@/lib/constants/stock-feedback";
import { activeMembershipsByUser } from "@/lib/org/membership";
import { getAdsDecision, type AdsDecisionRow } from "@/lib/queries/ads-decision";
import { evidenceFactsOfSummary } from "@/lib/queries/evidence-gaps";
import { getInventoryDecisionReport } from "@/lib/queries/inventory-decision";
import { pickModelInventoryRows } from "@/lib/queries/model-360";
import { spendMappedProductIds, summarizeModelAds, type ModelAdsSummary } from "@/lib/queries/model-ads";
import { getModelProductionSummariesBatch, type ModelProductionSummary } from "@/lib/queries/model-production";
import { getModelSignalsBatch } from "@/lib/queries/model-signal";
import { getLinkedReceiptCountsBatch } from "@/lib/queries/model-stale-state";
import { getModelsEvidenceBatch } from "@/lib/queries/models";
import { getSlowMoving } from "@/lib/queries/slow-moving";
import { getStockFeedbackShop } from "@/lib/queries/stock-feedback";
import { resolvePeriod } from "@/lib/search-params";

/**
 * ═══════════ BẢNG QUY TRÌNH MẪU — ĐỌC NGUỒN THEO LÔ (Company OS · Agent BD) ═══════════
 *
 * Mỗi nguồn đọc ĐÚNG MỘT LẦN cho cả sổ rồi cắt theo mẫu — không truy vấn nào theo từng thẻ:
 *
 *  · sổ mẫu        — một câu (mẫu + sản phẩm + người phụ trách) + một câu lịch sử (mốc khai gần nhất);
 *  · tín hiệu      — `getModelSignalsBatch` (S) — nhãn tín hiệu của từng mẫu;
 *  · quảng cáo     — `getAdsDecision(30 ngày, "product")` + `spendMappedProductIds` ⇒ `summarizeModelAds` từng
 *                    mã (đúng thứ `getModelAdsSummary` làm cho một mã) — CHỈ khi người xem được xem quảng cáo;
 *  · quyết định tồn — `getInventoryDecisionReport` ⇒ `pickModelInventoryRows`;
 *  · sản xuất      — `getModelProductionSummariesBatch` (C) ⇒ `winnerFollowUp` (T) + chỗ hở chứng từ (P2);
 *  · phản hồi tồn  — `getStockFeedbackShop` (X) ⇒ `deriveStockFeedback` từng mã;
 *  · lớp tồn       — `getSlowMoving` (V) ⇒ lớp tệ nhất của mẫu (nhãn thẻ);
 *  · gợi ý khai    — `getModelsEvidenceBatch` (Q) ⇒ `buildDeclarePreview`, chỉ cho mẫu CHƯA KHAI và người KHAI được;
 *  · lời khai đi sau thực tế (ST) — CÙNG lô chứng cứ (thiết kế + chi QC, cho mẫu khai còn trước THẮNG) + tóm tắt
 *                    sản xuất ở trên + `getLinkedReceiptCountsBatch` (mẫu Đang sản xuất) ⇒ `staleStateSuggestion`,
 *                    chỉ cho người KHAI được;
 *  · phòng ban     — `activeMembershipsByUser` (đường đọc DUY NHẤT của tư cách thành viên, luật 32).
 *
 * Rồi mỗi mẫu đi qua CÙNG phép dựng đề xuất của trang 360 (`deriveModelSuggestions` + `mergeStockFeedbackSuggestions`,
 * cùng cổng quyền từng khối) — bài kiểm so thẻ với đường một-mẫu trên mọi mẫu của CSDL kiểm thử. Không ngưỡng,
 * không luật mới: phần thuần (cột, nhãn, việc tiếp theo, lọc) ở `lib/constants/model-pipeline.ts`.
 */

export type PipelineAccess = {
  allowed: Record<Model360Block, boolean>;
  /** `models:write` — gợi ý khai (Q) chỉ là việc của người khai được. */
  canWrite: boolean;
  /** `production:write` — link "Tạo topic sản xuất" trong đề xuất (như trang 360). */
  canCreateTopic: boolean;
};

export type PipelineOption = { value: string; label: string };

export type PipelineBoard = {
  cards: PipelineCard[];
  /** Tổng mẫu trong sổ (trước bộ lọc) — phân biệt "sổ trống" với "lọc không ra". */
  totalModels: number;
  ownerOptions: PipelineOption[];
  deptOptions: PipelineOption[];
  periodLabel: string;
  /** Nguồn đọc hỏng — thẻ vẫn ra, phần phụ thuộc nguồn đó CHƯA BIẾT (không phải "không có việc"). */
  failed: { source: string; error: string }[];
  notes: string[];
};

/** Kỳ của mọi nguồn theo kỳ — CÙNG mặc định của trang 360 (30 ngày) để hai màn hình nói cùng một việc. */
export const PIPELINE_PERIOD_KEY = "30d" as const;

/** Mẫu kèm mọi dữ kiện đã cắt — đầu vào của phép dựng thẻ. Tách ra để bài kiểm so với đường một-mẫu. */
export type PipelineModelSources = {
  modelId: string;
  code: string;
  state: ModelState | null;
  productId: string | null;
  signal: { signal: ModelSignal; summary: string } | null;
  ads: ModelAdsSummary | null;
  inventory: ReturnType<typeof pickModelInventoryRows> | null;
  production: ModelProductionSummary | null;
  stockFeedback: ReturnType<typeof deriveStockFeedback> | null;
};

/**
 * Danh sách đề xuất của MỘT mẫu — ĐÚNG phép dựng của khối Đề xuất trang 360 (`SuggestionsBlock`): cùng đầu
 * vào, cùng `deriveModelSuggestions`, cùng `mergeStockFeedbackSuggestions`. Quyền đã được áp ở bước đọc
 * (nguồn không được xem ⇒ `null`, như trang 360).
 */
export function pipelineSuggestions(s: PipelineModelSources, access: PipelineAccess, periodQuery: string): ModelSuggestion[] {
  const base = deriveModelSuggestions({
    modelId: s.modelId,
    declaredState: s.state,
    signal: s.signal,
    ads: s.ads ? { status: s.ads.status, action: s.ads.decision?.action ?? null, reason: s.ads.decision?.reason ?? "", spend: s.ads.spend, cpo: s.ads.cpo, profitAfterAds: s.ads.profitAfterAds } : null,
    inventory: s.inventory ? { rows: s.inventory.rows, dataGate: s.inventory.dataGate.state } : null,
    creativeHref: s.productId ? `/marketing/creatives?tab=thu-vien&mau=${encodeURIComponent(s.productId)}` : null,
    periodQuery,
    production: s.production ? { trackTopics: countTopicsBlockingSuggestion(s.production.topics), winnerFollowUp: winnerFollowUp(s.production) } : null,
    canCreateTopic: access.canCreateTopic,
  });
  return s.stockFeedback ? mergeStockFeedbackSuggestions(base, s.stockFeedback.recommendations) : base;
}

/** Chỗ hở lời khai ≠ chứng từ (P2) dựng từ tóm tắt sản xuất — đúng đường ô vàng của trang 360. */
export function pipelineGap(s: Pick<PipelineModelSources, "modelId" | "code" | "state" | "production">): LifecycleEvidenceGap | null {
  return s.production ? lifecycleEvidenceGap(evidenceFactsOfSummary({ id: s.modelId, code: s.code, state: s.state }, s.production)) : null;
}

function failedOf(xs: readonly (Loaded<unknown> | null)[]): { source: string; error: string }[] {
  return xs.filter((x): x is Extract<Loaded<unknown>, { ok: false }> => !!x && !x.ok).map((x) => ({ source: x.source, error: x.error }));
}

/**
 * Bảng quy trình của người xem. Đệm theo QUYỀN (quyền đổi thì nguồn được đọc đổi) + BỘ LỌC (AGENTS.md §2);
 * các nguồn bên dưới còn đệm riêng của chúng.
 */
export async function getModelPipelineBoard(access: PipelineAccess, filters: PipelineFilters): Promise<PipelineBoard> {
  const accessKey = JSON.stringify({ a: access.allowed, w: access.canWrite, t: access.canCreateTopic });
  return memo(`modelPipelineBoard:v1:${accessKey}:${pipelineFiltersKey(filters)}`, 60_000, () => boardUncached(access, filters));
}

async function boardUncached(access: PipelineAccess, filters: PipelineFilters): Promise<PipelineBoard> {
  const db = await getDb();
  const pm = schema.productModels;
  const p = schema.products;
  const u = schema.users;
  const h = schema.productModelStateHistory;
  const range = resolvePeriod({}, PIPELINE_PERIOD_KEY);
  const periodQuery = `period=${PIPELINE_PERIOD_KEY}`;
  const { allowed } = access;

  const [models, lastChange, memberships] = await Promise.all([
    db
      .select({ id: pm.id, code: pm.code, name: pm.name, productName: p.name, image: p.image, state: pm.lifecycleState, productId: pm.productId, ownerUserId: pm.ownerUserId, ownerName: u.name, createdAt: pm.createdAt })
      .from(pm)
      .leftJoin(p, eq(p.id, pm.productId))
      .leftJoin(u, eq(u.id, pm.ownerUserId))
      .orderBy(asc(pm.code)),
    db.select({ modelId: h.modelId, at: sql<string>`max(${h.occurredAt})`.as("pl_last_change") }).from(h).groupBy(h.modelId),
    loadSource("phòng ban của người phụ trách", () => activeMembershipsByUser()),
  ]);
  const ids = models.map((m) => m.id);
  const undeclared = models.filter((m) => m.state === null);
  // Chứng cứ creative cho lời khai còn trước THẮNG (ST) đọc CÙNG lượt với gợi ý khai (Q) — một lô, không hai.
  const creativeTrack = models.filter((m) => isModelState(m.state) && STALE_CREATIVE_TRACK_STATES.includes(m.state));
  const evidenceTargets = [...undeclared, ...creativeTrack].map((m) => m.id);
  const inProduction = models.filter((m) => m.state === LINKED_RECEIPT_FROM).map((m) => m.id);

  const [signals, ads, inv, prod, feedback, slow, evidence, receipts] = await Promise.all([
    loadSource("tín hiệu mẫu", () => getModelSignalsBatch(range)),
    allowed.ADS
      ? loadSource("quảng cáo (bảng quyết định chiều mã hàng)", async () => {
          const [decision, mapped] = await Promise.all([getAdsDecision(range, "product"), spendMappedProductIds(db)]);
          return { decision, mapped };
        })
      : Promise.resolve(null),
    allowed.INVENTORY ? loadSource("quyết định tồn", () => getInventoryDecisionReport()) : Promise.resolve(null),
    allowed.PRODUCTION ? loadSource("sản xuất (getModelProductionSummariesBatch)", () => getModelProductionSummariesBatch(ids)) : Promise.resolve(null),
    allowed.INVENTORY ? loadSource("phản hồi tồn → creative / quảng cáo", () => getStockFeedbackShop({ adsVisible: allowed.ADS })) : Promise.resolve(null),
    allowed.INVENTORY ? loadSource("hàng chậm (lớp tồn)", () => getSlowMoving()) : Promise.resolve(null),
    access.canWrite && evidenceTargets.length ? loadSource("chứng cứ giai đoạn / thiết kế của mẫu", () => getModelsEvidenceBatch(evidenceTargets)) : Promise.resolve(null),
    access.canWrite && allowed.PRODUCTION && inProduction.length ? loadSource("phiếu nhập đã nối lệnh / lô sản xuất", () => getLinkedReceiptCountsBatch(inProduction)) : Promise.resolve(null),
  ]);
  const notes: string[] = [];
  if (feedback && feedback.ok) notes.push(...feedback.data.notes);

  // ── Cắt nguồn cả shop theo mẫu / mã hàng ──
  const signalOf = new Map(signals.ok ? signals.data.rows.map((r) => [r.model.id, r]) : []);
  const lastOf = new Map(lastChange.map((r) => [r.modelId, r.at ? new Date(r.at) : null]));
  const adsRowOf = new Map<string, AdsDecisionRow>();
  if (ads && ads.ok) for (const r of ads.data.decision.rows) if (!adsRowOf.has(r.key)) adsRowOf.set(r.key, r);
  const feedbackOf = new Map(feedback && feedback.ok ? feedback.data.inputs.map((i) => [i.productId, i]) : []);
  const riskOf = new Map<string, StockRisk[]>();
  if (slow && slow.ok) for (const r of slow.data.rows) riskOf.set(r.productId, [...(riskOf.get(r.productId) ?? []), r.risk]);
  const declareOf = new Map(
    evidence && evidence.ok
      ? buildDeclarePreview(
          undeclared.map((m) => ({ id: m.id, code: m.code, name: m.name, productName: m.productName, image: m.image, state: null })),
          evidence.data,
        ).map((r) => [r.modelId, r])
      : [],
  );
  const deptsOfUser = new Map<string, string[]>();
  const deptName = new Map<string, string>();
  if (memberships.ok) {
    for (const [userId, list] of memberships.data) {
      deptsOfUser.set(userId, list.map((d) => d.departmentId));
      for (const d of list) deptName.set(d.departmentId, d.name);
    }
  }

  const all: PipelineCard[] = models.map((m) => {
    const state = isModelState(m.state) ? m.state : null;
    const pid = m.productId ?? null;
    const sig = signalOf.get(m.id) ?? null;
    const production = prod && prod.ok ? (prod.data.get(m.id) ?? null) : null;
    const sources: PipelineModelSources = {
      modelId: m.id,
      code: m.code,
      state,
      productId: pid,
      signal: sig ? { signal: sig.signal.signal, summary: sig.signal.summary } : null,
      ads:
        pid && ads && ads.ok
          ? summarizeModelAds(pid, adsRowOf.get(pid) ?? null, { spendMapped: ads.data.mapped.has(pid), orderCoveragePct: ads.data.decision.confidence.coveragePct, spendAtAdGrainPct: ads.data.decision.spendDetail.pct })
          : null,
      inventory: pid && inv && inv.ok ? pickModelInventoryRows(inv.data, pid) : null,
      production,
      stockFeedback: pid && feedback && feedback.ok ? (() => {
        const input = feedbackOf.get(pid);
        return input ? deriveStockFeedback(input) : { recommendations: [], insufficient: [] };
      })() : null,
    };
    const gap = pipelineGap(sources);
    const declare = state === null ? (declareOf.get(m.id) ?? null) : null;
    // ST: chỉ người KHAI được mới thấy đề xuất cập nhật; nguồn không đọc được ⇒ ô CHƯA BIẾT ⇒ không đề xuất từ nó.
    const stale =
      access.canWrite && state !== null
        ? staleStateSuggestion(state, staleFactsOf(evidence && evidence.ok ? (evidence.data.get(m.id) ?? null) : null, production, receipts && receipts.ok ? (receipts.data.get(m.id) ?? null) : null))
        : null;
    const last = lastOf.get(m.id) ?? null;
    return {
      modelId: m.id,
      code: m.code,
      name: m.name || m.productName || "",
      image: m.image ?? null,
      state,
      column: pipelineColumnOf(state),
      since: last ?? (state === null ? m.createdAt : null),
      sinceIsRegistered: !last && state === null,
      ownerUserId: m.ownerUserId,
      ownerName: m.ownerName ?? null,
      signal: sig ? sig.signal.signal : null,
      chips: pipelineChips({
        state,
        gap,
        stockRisk: pid ? worstStockRisk(riskOf.get(pid) ?? []) : null,
        sampleWaiting: production?.latestSample?.status === "SUBMITTED",
        // Topic đọc từ CÙNG tóm tắt sản xuất (C) — gác quyền khối Sản xuất như trang 360; không đọc được ⇒ chưa biết.
        trackTopics: production ? countTopicsBlockingSuggestion(production.topics) : null,
      }),
      next: pickNextAction({
        modelId: m.id,
        state,
        gap,
        declareSuggestion: declare && declare.suggested ? { state: declare.suggested, reasons: declare.reasons } : null,
        stale,
        suggestions: pipelineSuggestions(sources, access, periodQuery),
      }),
    };
  });

  const ownerIds = new Map<string, string>();
  let coChuaGiao = false;
  for (const c of all) {
    if (c.ownerUserId) ownerIds.set(c.ownerUserId, c.ownerName ?? "Tài khoản đã khoá");
    else coChuaGiao = true;
  }
  const ownerOptions: PipelineOption[] = [...ownerIds].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, "vi"));
  if (coChuaGiao) ownerOptions.push({ value: "none", label: "Chưa giao người phụ trách" });
  const deptIds = new Set<string>();
  for (const id of ownerIds.keys()) for (const d of deptsOfUser.get(id) ?? []) deptIds.add(d);
  const deptOptions: PipelineOption[] = [...deptIds].map((value) => ({ value, label: deptName.get(value) ?? value })).sort((a, b) => a.label.localeCompare(b.label, "vi"));

  return {
    cards: all.filter((c) => matchesPipelineFilters(c, filters, deptsOfUser)),
    totalModels: all.length,
    ownerOptions,
    deptOptions,
    periodLabel: range.label,
    failed: failedOf([memberships, signals, ads, inv, prod, feedback, slow, evidence, receipts]),
    notes,
  };
}

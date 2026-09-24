import { and, eq, isNull } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { tienAiHomNay, tranNgayUsd } from "@/lib/ai/budget";
import { estimateCostUsd, getAiProvider } from "@/lib/ai/provider";
import { xetTranNgay } from "@/lib/constants/ai-budget";
import {
  CREATIVE_RULE_VERSION,
  GENE_LABEL,
  GENE_VALUE_LABEL,
  GENE_VOCAB_VERSION,
  parseGenes,
  type CreativeRule,
  type CreativeVerdict,
  type VariantStatus,
} from "@/lib/constants/creative-loop";
import { vnDay } from "@/lib/constants/marketing-decision-ledger";
import { judgeVariant } from "@/lib/creative/judge";
import { geneStats, outcomeOf, relativeBaseline, type GeneStat, type Observation } from "@/lib/creative/learn";
import { purgeCreativeImage } from "@/lib/creative/images";
import { proposeScale, type ScaleCandidate } from "@/lib/creative/scale";
import {
  effectiveJudgeConfig,
  evaluationCandidates,
  purgeCandidates,
  readCurrentCreativeConfig,
  sameRule,
  variantMetrics,
  type VariantMetricsRow,
} from "@/lib/queries/creative-loop";

/**
 * ═══════════ LƯỢT CHẤM CỦA VÒNG MẪU — ĐO · CHẤM · CHỐT · HỌC ═══════════
 *
 * Đặc tả: `docs/creative-loop.md` §1 (dòng "mỗi lượt tick"), §4, §5. Tick gọi mỗi ~10 phút, nên
 * hàm này phải LŨY ĐẲNG: chạy hai lần cùng lúc `now` (hoặc cùng ngày) không đẻ dòng thứ hai, không
 * chốt thư viện hai lần, không dời mốc đã chốt.
 *
 * Việc của nó, theo thứ tự:
 *  1. Chọn mẫu: LIVE / PAUSED / ENDED đăng trong 45 ngày + mọi mẫu đã vào thư viện.
 *  2. Đo: `variantMetrics` (chi hạt AD + đơn theo `ad_id` qua `ORDER_OUTCOME_FAST`).
 *  3. Chấm: `judgeVariant` — luật TẮT của LÔ, luật GIỮ của cấu hình HIỆN TẠI (lý do ở
 *     `effectiveJudgeConfig`).
 *  4. Hệ quả ghi CSDL — chỉ ba sự kiện một chiều, mỗi cái canh bằng điều kiện `where`:
 *       · LIVE mà đã qua `endAt` ⇒ `ENDED` (Facebook đã tự dừng theo `end_time`, không gọi gì);
 *       · `WIN` lần đầu ⇒ chốt `library_at` + `library_orders` (không bao giờ gỡ);
 *       · `LOSE` lần đầu ⇒ `lost_at`.
 *  5. Trả danh sách `kills` cho bàn tay (gói C) thực thi. Hàm này KHÔNG gọi Facebook.
 *  6. Sổ phán quyết: một dòng mỗi (ngày VN × mẫu), ghi đè trong ngày.
 *  7. Xoá ĐIỂM ẢNH mẫu thua quá hạn giữ (giữ dòng, gen, số đo).
 *  8. Học: `geneStats` ⇒ sổ học một dòng mỗi ngày VN. Bản tin chữ là TUỲ CHỌN và không bao giờ chặn.
 */

export type KillOrder = {
  variantId: string;
  batchId: string;
  /** Nhóm QC cần tắt. `null` nếu mẫu LIVE mà thiếu id nhóm — vẫn trả về để cổng của gói C từ chối
   *  có ghi sổ, thay vì lặng lẽ bỏ một lệnh tắt. */
  adsetId: string | null;
  rule: CreativeRule;
};

export type NarrativeInput = { day: string; stats: GeneStat[]; observations: number; relativeObservations: number };

/** Viết bản tin từ bảng đã đếm. `null` = không viết (AI tắt, chạm trần, hoặc không có gì để nói). */
export type NarrativeWriter = (input: NarrativeInput, now: Date) => Promise<{ text: string; model: string } | null>;

export type EvaluateDeps = {
  /** Tiêm cho kiểm thử. `undefined` ⇒ viết bằng `getAiProvider("routine")`; `null` ⇒ không viết. */
  writeNarrative?: NarrativeWriter | null;
};

export type EvaluateResult = {
  /** Số mẫu đã chấm trong lượt này. */
  judged: number;
  kills: KillOrder[];
  /** Id mẫu vừa được chốt vào thư viện ở LƯỢT NÀY (lượt sau không lặp lại). */
  newWins: string[];
  /** Id mẫu vừa bị chốt thua ở lượt này. */
  losses: string[];
  /** Id mẫu vừa chuyển LIVE → ENDED ở lượt này. */
  ended: string[];
  /** Id mẫu vừa bị xoá điểm ảnh ở lượt này. */
  purged: string[];
  /** Id dòng ĐỀ NGHỊ scale vừa chèn ở lượt này (mẫu THẮNG / HỨA HẸN — §5f). Không gọi Facebook. */
  scaleProposals: string[];
  learning: { observations: number; relative: number };
  /** Cảnh báo không chặn (vd bản tin AI hỏng) — để job ghi vào `sync_runs`. */
  warnings: string[];
};

type MetricsSnapshot = Pick<VariantMetricsRow, "spendVnd" | "impressions" | "clicks" | "messages" | "bookedOrders" | "deliveredOrders" | "returnedOrders">;

function metricsSnapshot(m: VariantMetricsRow): MetricsSnapshot {
  // `null` giữ nguyên là `null` (CHƯA BIẾT) — sổ phán quyết không được biến nó thành 0.
  return {
    spendVnd: m.spendVnd,
    impressions: m.impressions,
    clicks: m.clicks,
    messages: m.messages,
    bookedOrders: m.bookedOrders,
    deliveredOrders: m.deliveredOrders,
    returnedOrders: m.returnedOrders,
  };
}

export async function evaluateCreatives(db: Db, now: Date, deps: EvaluateDeps = {}): Promise<EvaluateResult> {
  const day = vnDay(now);
  const warnings: string[] = [];
  const v = schema.creativeVariants;

  const candidates = await evaluationCandidates(db, now);
  const { config: current } = await readCurrentCreativeConfig(db);
  const metrics = await variantMetrics(
    db,
    candidates.map((c) => ({ id: c.variant.id, fbAdId: c.variant.fbAdId, startAt: c.batch.startAt })),
  );

  const kills: KillOrder[] = [];
  const newWins: string[] = [];
  const losses: string[] = [];
  const ended: string[] = [];
  const observations: Observation[] = [];
  const scaleCandidates: ScaleCandidate[] = [];

  for (const { variant, batch } of candidates) {
    const m = metrics.get(variant.id) as VariantMetricsRow;
    const status = variant.status as VariantStatus;
    const judgeCfg = effectiveJudgeConfig(batch.configSnapshot, current);
    const j = judgeVariant({ status, startAt: batch.startAt, endAt: batch.endAt, libraryAt: variant.libraryAt, metrics: m }, judgeCfg, now);

    // LỆNH TẮT: chỉ mẫu còn LIVE và còn TRONG khung — qua `endAt` thì Facebook đã tự dừng. Luật đã
    // kích hoạt phải thuộc snapshot của lô; kiểm lại tường minh dù `judgeCfg.killRules` vốn chỉ lấy
    // từ snapshot, vì đây là hàng rào tiền và một lần tái cấu trúc sai sẽ không ai nhìn thấy.
    if (status === "LIVE" && now < batch.endAt && j.verdict === "KILL" && j.firedKillRule && judgeCfg.killRules.some((r) => sameRule(r, j.firedKillRule as CreativeRule))) {
      kills.push({ variantId: variant.id, batchId: batch.id, adsetId: variant.fbAdsetId, rule: j.firedKillRule });
    }

    if (status === "LIVE" && now >= batch.endAt) {
      const rows = await db
        .update(v)
        .set({ status: "ENDED", updatedAt: now })
        .where(and(eq(v.id, variant.id), eq(v.status, "LIVE")))
        .returning({ id: v.id });
      if (rows.length > 0) ended.push(variant.id);
    }

    if (j.verdict === "WIN" && variant.libraryAt === null) {
      const rows = await db
        .update(v)
        .set({ libraryAt: now, libraryOrders: m.bookedOrders, updatedAt: now })
        .where(and(eq(v.id, variant.id), isNull(v.libraryAt)))
        .returning({ id: v.id });
      if (rows.length > 0) newWins.push(variant.id);
    }

    if (j.verdict === "LOSE" && variant.lostAt === null) {
      const rows = await db
        .update(v)
        .set({ lostAt: now, updatedAt: now })
        .where(and(eq(v.id, variant.id), isNull(v.lostAt)))
        .returning({ id: v.id });
      if (rows.length > 0) losses.push(variant.id);
    }

    await db
      .insert(schema.creativeVerdicts)
      .values({ verdictDay: day, variantId: variant.id, verdict: j.verdict, reasons: j.reasons, metrics: metricsSnapshot(m), ruleVersion: CREATIVE_RULE_VERSION })
      .onConflictDoUpdate({
        target: [schema.creativeVerdicts.verdictDay, schema.creativeVerdicts.variantId],
        set: { verdict: j.verdict, reasons: j.reasons, metrics: metricsSnapshot(m), ruleVersion: CREATIVE_RULE_VERSION, updatedAt: now },
      });

    // ĐỀ NGHỊ scale (§5f): chỉ chèn dòng đề nghị, không gọi Facebook — người bấm mới dựng nháp.
    if (j.verdict === "WIN" || j.verdict === "PROMISING") scaleCandidates.push({ variantId: variant.id, batchId: batch.id, verdict: j.verdict, metrics: metricsSnapshot(m) });

    const genes = parseGenes(variant.genes);
    if (genes) {
      observations.push({
        variantId: variant.id,
        productId: variant.productId ?? "",
        genes,
        genesVersion: variant.genesVersion,
        verdict: j.verdict as CreativeVerdict,
        spendVnd: m.spendVnd,
        bookedOrders: m.bookedOrders,
      });
    }
  }

  // Đề nghị hỏng KHÔNG được làm hỏng lượt chấm (lượt chấm còn giữ phanh tắt sớm) — chỉ cảnh báo.
  let scaleProposals: string[] = [];
  try {
    scaleProposals = await proposeScale(db, scaleCandidates);
  } catch (e) {
    warnings.push(`Đề nghị scale không ghi được: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ─── XOÁ ĐIỂM ẢNH MẪU THUA QUÁ HẠN ───
  // Hạn giữ là cấu hình HIỆN TẠI: nó không chạm tiền, và người vừa rút ngắn/kéo dài hạn giữ muốn nó
  // có hiệu lực cho cả mẫu cũ.
  const purged: string[] = [];
  for (const c of await purgeCandidates(db, now, current.loserImageRetentionDays)) {
    if (await purgeCreativeImage(db, c.imageId)) purged.push(c.variantId);
  }

  // ─── HỌC ───
  const learning = await learn(db, day, now, observations, deps, warnings);

  return { judged: candidates.length, kills, newWins, losses, ended, purged, scaleProposals, learning, warnings };
}

/**
 * Đếm quan sát ĐÚNG như `geneStats` đếm: cùng phiên bản từ vựng, cùng nền tương đối, và chỉ quan
 * sát có kết cục (`outcomeOf ≠ null`) — "quan sát" là thứ dạy được máy, không phải mọi mẫu có gen.
 */
export function countObservations(obs: Observation[]): { observations: number; relative: number } {
  const same = obs.filter((o) => o.genesVersion === GENE_VOCAB_VERSION);
  const baseline = relativeBaseline(same);
  let observations = 0;
  let relative = 0;
  for (const o of same) {
    const r = outcomeOf(o, baseline);
    if (!r) continue;
    observations += 1;
    if (r.basis === "RELATIVE") relative += 1;
  }
  return { observations, relative };
}

async function learn(db: Db, day: string, now: Date, obs: Observation[], deps: EvaluateDeps, warnings: string[]): Promise<{ observations: number; relative: number }> {
  const stats = geneStats(obs);
  const counts = countObservations(obs);
  const L = schema.creativeLearnings;
  const [existing] = await db.select({ geneStats: L.geneStats, narrative: L.narrative, narrativeModel: L.narrativeModel }).from(L).where(eq(L.learningDay, day)).limit(1);

  // BẢN TIN: chỉ viết lại khi BẢNG đã đổi. Tick 10 phút một lần mà gọi mô hình mỗi lần là tiêu tiền
  // để nói lại đúng một câu. Bảng đổi mà viết hỏng ⇒ để RỖNG, không giữ bản tin của bảng cũ: một
  // đoạn văn tả những con số không còn đúng còn tệ hơn không có đoạn văn nào.
  // So bằng chuỗi CHUẨN HOÁ: jsonb của Postgres sắp lại thứ tự khoá, nên `JSON.stringify` thô của
  // dòng đọc về không bao giờ bằng bản vừa tính — và bản tin sẽ bị viết lại ở MỌI lượt tick.
  const unchanged = existing !== undefined && stableJson(existing.geneStats) === stableJson(stats);
  let narrative = existing?.narrative ?? "";
  let narrativeModel = existing?.narrativeModel ?? "";
  if (!unchanged || !narrative) {
    narrative = "";
    narrativeModel = "";
    if (counts.observations > 0) {
      const writer = deps.writeNarrative === undefined ? defaultNarrativeWriter(db) : deps.writeNarrative;
      if (writer) {
        try {
          const out = await writer({ day, stats, observations: counts.observations, relativeObservations: counts.relative }, now);
          if (out && out.text.trim()) {
            narrative = out.text.trim().slice(0, 4000);
            narrativeModel = out.model;
          }
        } catch (e) {
          warnings.push(`Bản tin học không viết được: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  const row = {
    geneStats: stats as unknown as Record<string, unknown>[],
    observations: counts.observations,
    relativeObservations: counts.relative,
    narrative,
    narrativeModel,
    ruleVersion: CREATIVE_RULE_VERSION,
    genesVersion: GENE_VOCAB_VERSION,
  };
  await db
    .insert(L)
    .values({ learningDay: day, ...row })
    .onConflictDoUpdate({ target: L.learningDay, set: { ...row, updatedAt: now } });
  return counts;
}

/** JSON với khoá đối tượng được sắp — hai giá trị bằng nhau về nội dung cho cùng một chuỗi. */
export function stableJson(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(stableJson).join(",")}]`;
  if (x && typeof x === "object") {
    const rec = x as Record<string, unknown>;
    return `{${Object.keys(rec)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(rec[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(x) ?? "null";
}

// ───────────────────────────── BẢN TIN (TUỲ CHỌN) ─────────────────────────────

const NARRATIVE_SYSTEM = [
  "Bạn viết một bản tin ngắn (tối đa 6 câu, tiếng Việt có dấu) cho chủ một shop thời trang về việc",
  "máy đã học được gì từ các mẫu quảng cáo. Bạn CHỈ được diễn đạt lại bảng số được đưa vào:",
  "không thêm con số, không suy ra nguyên nhân, không khuyến nghị ngân sách, không nói tới mẫu cụ thể.",
  "Nếu phần lớn quan sát đứng trên căn cứ TƯƠNG ĐỐI, phải nói rõ đó là so với trung vị của chính các",
  "mẫu, không phải ngưỡng lãi. Giá trị thử ít hơn 3 lần thì nói là chưa đủ để kết luận.",
].join(" ");

/** Bảng đưa cho mô hình — chỉ những giá trị gen đã có quan sát. */
export function narrativePrompt(input: NarrativeInput): string {
  const lines = [
    `Ngày học: ${input.day}. Tổng quan sát có kết cục: ${input.observations}, trong đó ${input.relativeObservations} đứng trên căn cứ TƯƠNG ĐỐI.`,
    "Mỗi dòng: nhóm gen = giá trị | số mẫu đã thử | số thành công | số THẮNG | tỷ lệ hậu nghiệm.",
  ];
  for (const s of input.stats) {
    if (s.tests === 0) continue;
    lines.push(`${GENE_LABEL[s.key]} = ${GENE_VALUE_LABEL[s.value] ?? s.value} | ${s.tests} | ${s.successes} | ${s.wins} | ${(s.posteriorMean * 100).toFixed(0)}%`);
  }
  return lines.join("\n");
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

/**
 * Người viết mặc định: bậc `routine`, qua phanh tiền AI trong ngày (`lib/ai/budget.ts`), và ghi một
 * dòng `ai_interactions` để lượt gọi này nằm trong chính cái sổ mà phanh đọc — lượt gọi không vào sổ
 * là tiền phanh không thấy. AI tắt hoặc chạm trần ⇒ `null`, không ném.
 */
function defaultNarrativeWriter(db: Db): NarrativeWriter {
  return async (input, now) => {
    const provider = getAiProvider("routine");
    if (!provider) return null;
    const spent = await tienAiHomNay(now);
    const gate = xetTranNgay({ daTieu: spent.usd, tran: await tranNgayUsd() });
    if (!gate.choPhep) return null;
    const prompt = narrativePrompt(input);
    const started = Date.now();
    let answer = "";
    let model = provider.model;
    let status: "OK" | "ERROR" = "OK";
    let error: string | null = null;
    let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    try {
      const res = await provider.complete({ system: NARRATIVE_SYSTEM, messages: [{ role: "user", content: [{ type: "text", text: prompt }] }], tools: [], maxTokens: 700 });
      answer = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
      model = res.model || provider.model;
      usage = res.usage;
    } catch (e) {
      status = "ERROR";
      error = e instanceof Error ? e.message : String(e);
    }
    const cost = estimateCostUsd(model, usage);
    try {
      await db.insert(schema.aiInteractions).values({
        userId: null,
        provider: provider.name,
        model,
        route: "creative-loop/learning",
        entityType: "creative_learning",
        entityId: input.day,
        prompt: clip(prompt, 4000),
        answer: clip(answer, 8000),
        usage,
        // Chuỗi rỗng = chưa biết giá, không phải 0 (cùng quy ước với Copilot).
        costUsd: cost === null ? "" : cost.toFixed(6),
        latencyMs: Date.now() - started,
        rounds: 1,
        status,
        error,
      });
    } catch {
      // Sổ AI hỏng không được làm hỏng lượt chấm; bản tin vẫn dùng được.
    }
    if (status === "ERROR") throw new Error(error ?? "AI lỗi");
    return answer ? { text: answer, model } : null;
  };
}

/**
 * ═══════════ SỔ DÙNG AI — `recordAiUsage()` LÀ ĐƯỜNG GHI DUY NHẤT (docs/platform/ai-usage.md) — CHỈ MÁY CHỦ ═══════════
 *
 * Bảng `platform_ai_usage` ở CSDL NHÀ (`getPlatformDb()`) — mặt phẳng điều khiển: người vận hành nhìn mọi tổ chức từ MỘT
 * chỗ, và một tổ chức không có đường nào sửa sổ của mình (CSDL của họ không chứa bảng thật).
 *
 *  · Một dòng = một lượt AI. Không prompt, không câu trả lời, không khoá — chỉ số đếm, model, nguồn trả tiền.
 *  · `costUsd` / token `null` ⇒ ghi NULL — CHƯA BIẾT, không bao giờ 0 (luật 42). Tổng tiền chỉ cộng lượt đã định giá;
 *    số lượt chưa định giá đếm riêng và in cạnh tổng.
 *  · Mọi câu đọc lọc `org_code` (và `billing_source` khi tính hạn mức): tổ chức A không bao giờ trừ vào B, BYOK không bao
 *    giờ trừ vào credit nền tảng.
 */
import { and, desc, eq, gte, inArray, lte, ne, sql, type SQL } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { dauNgayVN } from "@/lib/ai/budget";
import {
  AI_BILLING_SOURCES,
  AI_USAGE_ERROR_CLASSES,
  AI_USAGE_FEATURES,
  AI_USAGE_MODALITIES,
  AI_USAGE_STATUSES,
  EMPTY_SOURCE_USAGE,
  monthStartVN,
  type AiBillingSource,
  type AiSourceUsage,
  type AiUsageErrorClass,
  type AiUsageFeature,
  type AiUsageModality,
  type AiUsageStatus,
  AI_USAGE_WORKLOADS,
  type AiUsageWorkload,
} from "@/lib/ai-usage/types";
import { usageEventKey } from "@/lib/pricing/meter";
import { rowsOf } from "@/lib/sql-rows";

export type AiUsageEntry = {
  orgCode: string;
  feature: AiUsageFeature;
  source: AiBillingSource;
  provider: string | null;
  model: string | null;
  /** Số lời gọi model của lượt (0 khi bị chặn trước khi gọi). */
  requests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** USD ước tính; `null` = CHƯA BIẾT. */
  costUsd: number | null;
  status: AiUsageStatus;
  /** Khoá tài khoản (luật 34); `null` = máy. */
  actorId: string | null;
  ref?: string | null;
  at?: Date;
  /**
   * KHOÁ SỰ KIỆN (0222): cùng tổ chức + cùng khoá ⇒ chỉ MỘT dòng — lượt thử lại của CÙNG lời gọi AI không bị tính hai lần.
   * Dựng bằng `lib/pricing/meter.ts::usageEventKey`. Bỏ trống ⇒ ghi như trước (mỗi lời gọi một dòng).
   */
  eventKey?: string | null;
  /** Hội thoại khách sinh ra lượt — chi phí AI / hội thoại chính xác (0222). */
  conversationId?: string | null;
  /** `TEXT` · `VISION` · `IMAGE` (0222). */
  modality?: AiUsageModality | null;
  /** QUAN SÁT (0232): phần của `inputTokens` đọc từ bộ đệm · phần của `outputTokens` là suy nghĩ · thời gian gọi · loại việc. */
  cachedTokens?: number | null;
  /**
   * Phần của `inputTokens` là GHI VÀO bộ đệm (0253, khi nhà cung cấp trả) — tách để phân tích; tiền USD vốn đã tính phần này
   * (`estimateCostUsd`). `null` = nhà cung cấp không trả / nơi gọi không khai.
   */
  cacheWriteTokens?: number | null;
  thinkingTokens?: number | null;
  latencyMs?: number | null;
  /**
   * LOẠI VIỆC — BẮT BUỘC khai (giai đoạn 2, 21/10/2026: 18% chi phí AI 14 ngày HSLC ghi sổ không nhãn). Danh sách đóng
   * `AI_USAGE_WORKLOADS`; `null` chỉ khi nơi gọi THẬT SỰ không biết (đường lỗi của khoá dự phòng chuyển tiếp nhãn của lượt gốc).
   */
  workload: AiUsageWorkload | null;
  /**
   * AI IM CÓ TÊN (0237): `ERROR` ⇒ lớp lỗi (`aiErrorClassOf`); `BLOCKED_QUOTA` ⇒ trần nào chạm (`AiQuotaBlockReason`). Bỏ trống ⇒
   * NULL = CHƯA PHÂN LOẠI. Giá trị ngoài danh sách đóng ⇒ NULL (dòng sổ tiền không được mất vì một nhãn sai). Dòng `OK` không mang lớp.
   */
  errorClass?: AiUsageErrorClass | null;
};

const intOrNull = (v: number | null): number | null => (v === null || !Number.isFinite(v) ? null : Math.max(0, Math.round(v)));

/**
 * KHOÁ SỰ KIỆN của MỘT lần gọi model: `<loại việc>:<hội thoại | ref>:<mã lượt logic>:<vòng>:<lần thử>`. LẦN THỬ nằm TRONG khoá ⇒
 * lượt thử lại là dòng RIÊNG (tiền thật không bao giờ bị khoá làm biến mất), đếm retry = số dòng cùng tiền tố có lần thử > 0. Khoá
 * chỉ chặn BẢN SAO TUYỆT ĐỐI của cùng một lần thử (hai worker nhận cùng một lượt) — và mỗi lần chặn được đếm (`duplicateBlockedCount`).
 */
export function aiCallKey(p: { workload: AiUsageWorkload; scope: string | null | undefined; turn: string | number; round?: number; attempt?: number }): string | null {
  return usageEventKey([p.workload, p.scope || "-", p.turn, p.round ?? 0, p.attempt ?? 0]);
}

/** Cột 0253 có ở CSDL nhà chưa — dò `information_schema`, đệm 60 giây; lỗi dò ⇒ coi như CHƯA có (rơi về câu chèn không có cột). */
const CACHE_WRITE_PROBE_MS = 60_000;
let cacheWriteProbe: { at: number; value: boolean } | null = null;
async function ledgerHasCacheWrite(pdb: Awaited<ReturnType<typeof getPlatformDb>>): Promise<boolean> {
  if (cacheWriteProbe && Date.now() - cacheWriteProbe.at < CACHE_WRITE_PROBE_MS) return cacheWriteProbe.value;
  let value = false;
  try {
    const [r] = rowsOf<{ n: number }>(
      await pdb.execute(sql`select count(*)::int as n from information_schema.columns where table_schema = current_schema() and table_name = 'platform_ai_usage' and column_name = 'cache_write_tokens'`),
    );
    value = Number(r?.n) === 1;
  } catch {
    value = false;
  }
  cacheWriteProbe = { at: Date.now(), value };
  return value;
}

/** Chỉ cho kiểm thử: quên kết quả dò cột 0253 (sau khi bài kiểm đổi lược đồ). */
export function resetLedgerColumnProbeForTests(): void {
  cacheWriteProbe = null;
}

let duplicateBlocked = 0;
/** Số lần khoá sự kiện chặn một BẢN SAO TUYỆT ĐỐI trong tiến trình này (bộ đếm nhẹ — đủ để biết có xử lý trùng hay không). */
export function duplicateBlockedCount(): number {
  return duplicateBlocked;
}

/** Vi phạm ĐÚNG ràng buộc loại việc (lược đồ chưa áp 0252 không biết loại việc mới) — các lỗi khác vẫn ném. */
function isWorkloadCheckViolation(error: unknown): boolean {
  const e = error as { code?: string; constraint?: string; message?: string; cause?: { code?: string; constraint?: string; message?: string } } | null;
  const code = e?.code ?? e?.cause?.code;
  const name = e?.constraint ?? e?.cause?.constraint ?? `${e?.message ?? ""} ${e?.cause?.message ?? ""}`;
  return code === "23514" && /platform_ai_usage_workload_check/.test(name);
}

/**
 * Ghi MỘT dòng. Ném khi dữ liệu sai hình hoặc CSDL hỏng — nơi gọi quyết (AI Builder: lỗi hiện ra; Copilot: nuốt).
 * `recorded: false` = khoá sự kiện đã có (lượt thử lại / gói tin trùng) — KHÔNG có dòng thứ hai, không tính tiền hai lần.
 */
let benchCapture: ((e: AiUsageEntry) => void) | null = null;

/**
 * CHỈ benchmark phát lại (scripts/platform-ai-bench.ts — tiến trình RIÊNG, không phải máy chủ app): lượt AI của phát lại không
 * phải lượt dùng của shop ⇒ KHÔNG ghi vào sổ thật (không trừ hạn mức, không lẫn vào chi phí / A/B) — chuyển cho hàm bắt để
 * tính tiền / token / độ trễ của chính benchmark. `null` để gỡ.
 */
export function setAiUsageCaptureForBench(fn: ((e: AiUsageEntry) => void) | null) {
  benchCapture = fn;
}

export async function recordAiUsage(e: AiUsageEntry): Promise<{ recorded: boolean }> {
  if (benchCapture) {
    benchCapture(e);
    return { recorded: false };
  }
  if (!(AI_USAGE_FEATURES as readonly string[]).includes(e.feature)) throw new Error(`Tính năng AI lạ: ${e.feature}`);
  if (!(AI_BILLING_SOURCES as readonly string[]).includes(e.source)) throw new Error(`Nguồn tính tiền AI lạ: ${e.source}`);
  if (!(AI_USAGE_STATUSES as readonly string[]).includes(e.status)) throw new Error(`Trạng thái lượt AI lạ: ${e.status}`);
  if (e.modality && !(AI_USAGE_MODALITIES as readonly string[]).includes(e.modality)) throw new Error(`Loại lượt AI lạ: ${e.modality}`);
  const eventKey = e.eventKey?.trim() ? e.eventKey.trim().slice(0, 200) : null;
  const pdb = await getPlatformDb();
  // CÂU CHÈN LIỆT KÊ CỘT (tiền lệ 0245 · lib/constants/migration-serve-compat.ts): drizzle `insert(bảng)` liệt kê MỌI cột của lược đồ ⇒ CSDL
  // nhà chưa áp 0253 (migrate lúc khởi động hỏng chỉ ghi log, máy chủ VẪN phục vụ) báo «column does not exist» và MỌI lượt dùng AI mất
  // dòng tiền. `cache_write_tokens` chỉ được ghi khi CSDL đã có cột (`ledgerHasCacheWrite`).
  const withCacheWrite = await ledgerHasCacheWrite(pdb);
  const insertSql = (workload: AiUsageWorkload | null, onConflict: boolean) => {
    const cols: [string, SQL][] = [
      ["id", sql`${crypto.randomUUID()}`],
      ["org_code", sql`${e.orgCode}`],
      ["feature", sql`${e.feature}`],
      ["billing_source", sql`${e.source}`],
      ["provider", sql`${e.provider}`],
      ["model", sql`${e.model}`],
      ["requests", sql`${Math.max(0, Math.round(e.requests))}`],
      ["input_tokens", sql`${intOrNull(e.inputTokens)}`],
      ["output_tokens", sql`${intOrNull(e.outputTokens)}`],
      ["cost_usd", sql`${e.costUsd === null || !Number.isFinite(e.costUsd) ? null : e.costUsd}`],
      ["status", sql`${e.status}`],
      ["actor_id", sql`${e.actorId}`],
      ["ref", sql`${e.ref ?? null}`],
      ["event_key", sql`${eventKey}`],
      ["conversation_id", sql`${e.conversationId ?? null}`],
      ["modality", sql`${e.modality ?? null}`],
      ["cached_tokens", sql`${intOrNull(e.cachedTokens ?? null)}`],
      ["thinking_tokens", sql`${intOrNull(e.thinkingTokens ?? null)}`],
      ["latency_ms", sql`${intOrNull(e.latencyMs ?? null)}`],
      ["workload", sql`${workload}`],
      ["error_class", sql`${e.status !== "OK" && e.errorClass && (AI_USAGE_ERROR_CLASSES as readonly string[]).includes(e.errorClass) ? e.errorClass : null}`],
      ...(e.at ? ([["at", sql`${e.at.toISOString()}::timestamptz`]] as [string, SQL][]) : []),
      ...(withCacheWrite ? ([["cache_write_tokens", sql`${intOrNull(e.cacheWriteTokens ?? null)}`]] as [string, SQL][]) : []),
    ];
    return sql`insert into "platform_ai_usage" (${sql.raw(cols.map(([k]) => `"${k}"`).join(", "))}) values (${sql.join(
      cols.map(([, v]) => v),
      sql`, `,
    )})${onConflict ? sql` on conflict do nothing` : sql``} returning "id"`;
  };
  const write = async (workload: AiUsageWorkload | null): Promise<{ recorded: boolean }> => {
    if (!eventKey) {
      await pdb.execute(insertSql(workload, false));
      return { recorded: true };
    }
    // Chỉ mục duy nhất (org_code, event_key) là ràng buộc duy nhất có thể va (id là ngẫu nhiên) — va ⇒ BẢN SAO TUYỆT ĐỐI, bỏ qua + đếm.
    const rows = rowsOf<{ id: string }>(await pdb.execute(insertSql(workload, true)));
    if (!rows.length) {
      duplicateBlocked += 1;
      console.warn(JSON.stringify({ evt: "ai_usage_duplicate_blocked", feature: e.feature, workload, status: e.status }));
    }
    return { recorded: rows.length > 0 };
  };
  const workload = e.workload && (AI_USAGE_WORKLOADS as readonly string[]).includes(e.workload) ? e.workload : null;
  try {
    return await write(workload);
  } catch (error) {
    // Lược đồ chưa áp 0252 (serve-compat) không biết loại việc mới ⇒ ghi lại KHÔNG nhãn: dòng tiền / hạn mức không được mất vì một nhãn.
    if (workload !== null && isWorkloadCheckViolation(error)) return write(null);
    throw error;
  }
}

const t = schema.platformAiUsage;
/** Lượt BỊ CHẶN không phải một lượt dùng: không gọi model, không tốn tiền. */
const used = ne(t.status, "BLOCKED_QUOTA");

/**
 * Mức dùng của ĐÚNG một tổ chức × ĐÚNG một nguồn — đầu vào của `evaluateAiQuota`. Luôn đọc TƯƠI (không đệm).
 *
 * TRẦN LƯỢT (hôm nay / tháng) đếm lượt SOẠN — AI Builder và Copilot, mỗi lượt là một người bấm. Lượt của chatbot bán
 * hàng (`sales_chatbot`, 0180) là mỗi câu KHÁCH của shop gõ: đếm chung vào trần 10 lượt/ngày của gói `trial` là để một
 * shop mất chatbot sau câu thứ mười của khách đầu tiên. Chatbot có trần kỹ thuật riêng (`SALES_CHATBOT_LIMITS`). TRẦN
 * TIỀN (USD tháng) thì đếm MỌI tính năng — đó là thứ bảo vệ hoá đơn của khách, bất kể ai gọi model.
 */
export async function sourceUsage(orgCode: string, source: AiBillingSource, now: Date = new Date()): Promise<AiSourceUsage> {
  const pdb = await getPlatformDb();
  const day = dauNgayVN(now);
  // «Học từ hội thoại cũ» (sales_playbook) cũng không ăn trần lượt / ngày của AI Builder: một lượt học là vài lời gọi
  // gom nhiều hội thoại — trần CHI PHÍ của gói vẫn chặn như mọi lượt BYOK.
  const counted = sql`${t.feature} not in ('sales_chatbot', 'sales_playbook')`;
  const [r] = await pdb
    .select({
      today: sql<number>`count(*) filter (where ${t.at} >= ${day.toISOString()}::timestamptz and ${counted})`,
      month: sql<number>`count(*) filter (where ${counted})`,
      cost: sql<string | null>`sum(${t.costUsd})`,
      unknown: sql<number>`count(*) filter (where ${t.costUsd} is null)`,
    })
    .from(t)
    .where(and(eq(t.orgCode, orgCode), eq(t.billingSource, source), gte(t.at, monthStartVN(now)), used));
  if (!r) return EMPTY_SOURCE_USAGE;
  return { requestsToday: Number(r.today ?? 0), requestsMonth: Number(r.month ?? 0), costUsdMonth: Number(r.cost ?? 0), unknownCostMonth: Number(r.unknown ?? 0) };
}

export type AiUsageTotals = {
  source: AiBillingSource;
  /** Lượt AI (dòng sổ, không kể lượt bị chặn). */
  turns: number;
  /** Lời gọi model. */
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Tổng USD của lượt ĐÃ định giá; `null` khi không lượt nào định giá được (CHƯA BIẾT, không phải 0). */
  costUsd: number | null;
  unknownCost: number;
  blocked: number;
};

async function totalsSince(orgCode: string, since: Date): Promise<AiUsageTotals[]> {
  const pdb = await getPlatformDb();
  const rows = await pdb
    .select({
      source: t.billingSource,
      turns: sql<number>`count(*) filter (where ${used})`,
      requests: sql<number>`coalesce(sum(${t.requests}), 0)`,
      input: sql<number>`coalesce(sum(${t.inputTokens}), 0)`,
      output: sql<number>`coalesce(sum(${t.outputTokens}), 0)`,
      cost: sql<string | null>`sum(${t.costUsd})`,
      unknown: sql<number>`count(*) filter (where ${used} and ${t.costUsd} is null)`,
      blocked: sql<number>`count(*) filter (where ${t.status} = 'BLOCKED_QUOTA')`,
    })
    .from(t)
    .where(and(eq(t.orgCode, orgCode), gte(t.at, since)))
    .groupBy(t.billingSource);
  return rows.map((r) => ({
    source: r.source as AiBillingSource,
    turns: Number(r.turns),
    requests: Number(r.requests),
    inputTokens: Number(r.input),
    outputTokens: Number(r.output),
    costUsd: r.cost === null ? null : Number(r.cost),
    unknownCost: Number(r.unknown),
    blocked: Number(r.blocked),
  }));
}

/** Hôm nay + tháng này, theo nguồn, của MỘT tổ chức. */
export async function aiUsageOverview(orgCode: string, now: Date = new Date()): Promise<{ today: AiUsageTotals[]; month: AiUsageTotals[] }> {
  const [today, month] = await Promise.all([totalsSince(orgCode, dauNgayVN(now)), totalsSince(orgCode, monthStartVN(now))]);
  return { today, month };
}

export type AiUsageDayRow = { day: string; source: AiBillingSource; feature: string; model: string | null; turns: number; requests: number; inputTokens: number; outputTokens: number; costUsd: number | null; unknownCost: number; blocked: number };

/** Theo ngày (giờ VN) × nguồn × tính năng × model, `days` ngày gần nhất — màn người vận hành. */
export async function aiUsageDaily(orgCode: string, days = 31, now: Date = new Date()): Promise<AiUsageDayRow[]> {
  const pdb = await getPlatformDb();
  const since = new Date(dauNgayVN(now).getTime() - (days - 1) * 86_400_000);
  const dayExpr = sql<string>`to_char((${t.at} at time zone 'UTC') + interval '7 hours', 'YYYY-MM-DD')`;
  const rows = await pdb
    .select({
      day: dayExpr,
      source: t.billingSource,
      feature: t.feature,
      model: t.model,
      turns: sql<number>`count(*) filter (where ${used})`,
      requests: sql<number>`coalesce(sum(${t.requests}), 0)`,
      input: sql<number>`coalesce(sum(${t.inputTokens}), 0)`,
      output: sql<number>`coalesce(sum(${t.outputTokens}), 0)`,
      cost: sql<string | null>`sum(${t.costUsd})`,
      unknown: sql<number>`count(*) filter (where ${used} and ${t.costUsd} is null)`,
      blocked: sql<number>`count(*) filter (where ${t.status} = 'BLOCKED_QUOTA')`,
    })
    .from(t)
    .where(and(eq(t.orgCode, orgCode), gte(t.at, since)))
    .groupBy(dayExpr, t.billingSource, t.feature, t.model)
    .orderBy(desc(dayExpr));
  return rows.map((r) => ({
    day: String(r.day),
    source: r.source as AiBillingSource,
    feature: r.feature,
    model: r.model,
    turns: Number(r.turns),
    requests: Number(r.requests),
    inputTokens: Number(r.input),
    outputTokens: Number(r.output),
    costUsd: r.cost === null ? null : Number(r.cost),
    unknownCost: Number(r.unknown),
    blocked: Number(r.blocked),
  }));
}

export type AiUsageRefRow = { day: string; ref: string | null; feature: string; turns: number; costUsd: number | null; unknownCost: number };

/**
 * Theo ngày (giờ VN) × `ref` × tính năng, cho MỘT tổ chức và một tập tính năng — báo cáo chi phí của chính tổ chức đó
 * (vd chatbot bán hàng chia tiền cho đơn / SĐT, lib/sales-chatbot/cost-report.ts). Tiền `null` = mọi lượt chưa định giá.
 */
export async function aiUsageByRef(orgCode: string, features: readonly AiUsageFeature[], since: Date, until: Date | null = null): Promise<AiUsageRefRow[]> {
  const pdb = await getPlatformDb();
  const dayExpr = sql<string>`to_char((${t.at} at time zone 'UTC') + interval '7 hours', 'YYYY-MM-DD')`;
  const rows = await pdb
    .select({
      day: dayExpr,
      ref: t.ref,
      feature: t.feature,
      turns: sql<number>`count(*) filter (where ${used})`,
      cost: sql<string | null>`sum(${t.costUsd})`,
      unknown: sql<number>`count(*) filter (where ${used} and ${t.costUsd} is null)`,
    })
    .from(t)
    .where(and(eq(t.orgCode, orgCode), inArray(t.feature, [...features]), gte(t.at, since), until ? lte(t.at, until) : undefined))
    .groupBy(dayExpr, t.ref, t.feature);
  return rows.map((r) => ({ day: String(r.day), ref: r.ref, feature: r.feature, turns: Number(r.turns), costUsd: r.cost === null ? null : Number(r.cost), unknownCost: Number(r.unknown) }));
}

export type AiTopOrgRow = { orgCode: string; costUsd: number | null; turns: number; unknownCost: number; blocked: number; sources: AiBillingSource[] };

/** Top tổ chức theo chi phí AI THÁNG NÀY (trang `/platform`). Tổ chức chỉ có lượt chưa định giá vẫn hiện, xếp cuối. */
export async function topOrgsByAiCost(limit = 10, now: Date = new Date()): Promise<AiTopOrgRow[]> {
  const pdb = await getPlatformDb();
  const cost = sql<string | null>`sum(${t.costUsd})`;
  const rows = await pdb
    .select({
      orgCode: t.orgCode,
      cost,
      turns: sql<number>`count(*) filter (where ${used})`,
      unknown: sql<number>`count(*) filter (where ${used} and ${t.costUsd} is null)`,
      blocked: sql<number>`count(*) filter (where ${t.status} = 'BLOCKED_QUOTA')`,
      sources: sql<string>`string_agg(distinct ${t.billingSource}, ',')`,
    })
    .from(t)
    .where(gte(t.at, monthStartVN(now)))
    .groupBy(t.orgCode)
    .orderBy(sql`${cost} desc nulls last`, t.orgCode)
    .limit(Math.max(1, Math.min(100, limit)));
  return rows.map((r) => ({
    orgCode: r.orgCode,
    costUsd: r.cost === null ? null : Number(r.cost),
    turns: Number(r.turns),
    unknownCost: Number(r.unknown),
    blocked: Number(r.blocked),
    sources: String(r.sources ?? "").split(",").filter(Boolean) as AiBillingSource[],
  }));
}

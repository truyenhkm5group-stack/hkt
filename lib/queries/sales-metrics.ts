import { and, eq, gte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";

/**
 * BÓC TÁCH SỐ ĐO NẤC CHẠY NGẦM — theo page · ngày · ý định · bản nhắc · mô hình.
 *
 * ═══ VÌ SAO TỆP NÀY KHÔNG TỰ TÍNH LẠI MỘT CON SỐ TỔNG NÀO ═══
 *
 * `shadowMetrics()` trong `lib/queries/sales-review.ts` là nơi DUY NHẤT định nghĩa các con số tổng
 * của nấc chạy ngầm. Tệp này chỉ đổi ĐỘ MỊN, không đổi định nghĩa: cùng một bộ lọc
 * (`ai_runs` với `subject_type = 'CONVERSATION'` và `started_at >= mốc`), cùng một cách đếm.
 *
 * Và đó không phải một lời hứa suông — `tests/sales-regression.test.ts` CỘNG các dòng bóc tách lại
 * rồi so với `shadowMetrics()` từng con số. Hai nguồn sự thật cho cùng một con số thì sớm muộn lệch
 * nhau, và chúng luôn lệch đúng vào ngày cần chúng khớp (AGENTS.md mục 8.12).
 *
 * ═══ MỘT LƯỢT CHẠY NẰM Ở ĐÚNG MỘT DÒNG ═══
 *
 * Với bốn chiều đầu, các dòng PHÂN HOẠCH tập lượt chạy: mọi lượt thuộc đúng một dòng, và cộng lại
 * đúng bằng tổng. Chỗ dễ sai nhất là Ý ĐỊNH — một lượt mang nhiều ý định, nên `unnest` sẽ làm tổng
 * các dòng LỚN HƠN số lượt thật mà không ai nhận ra. Vì vậy chiều ấy lấy Ý ĐỊNH ĐẦU TIÊN (ý định
 * chính), và một lượt chưa đọc được ý định nào vẫn có dòng của nó chứ không biến mất.
 *
 * MÔ HÌNH thì KHÔNG phân hoạch được ở độ mịn lượt chạy: một lượt có thể gọi mô hình hai lần (bước
 * Hiểu và bước Soạn), hoặc không gọi lần nào. Nên nó là một bảng RIÊNG ở độ mịn LẦN GỌI, và hàm
 * riêng — gộp chung vào một bảng là in hai độ mịn dưới cùng một cột "số lượt".
 */

/** Chiều bóc tách PHÂN HOẠCH được tập lượt chạy — mỗi lượt thuộc đúng một dòng. */
export const RUN_BREAKDOWNS = ["PAGE", "DATE", "INTENT", "PROMPT_VERSION"] as const;
export type RunBreakdown = (typeof RUN_BREAKDOWNS)[number];

export const RUN_BREAKDOWN_LABEL: Record<RunBreakdown, string> = {
  PAGE: "Fanpage",
  DATE: "Ngày",
  INTENT: "Ý định chính",
  PROMPT_VERSION: "Bản nhắc",
};

export type RunBreakdownRow = {
  key: string;
  /** Nhãn đọc được. Ô trống in ra là CHƯA BIẾT, không bị bỏ khỏi bảng. */
  label: string;
  runs: number;
  handoffs: number;
  /** Mẫu số 0 ⇒ `null`, không phải 0% (AGENTS.md mục 42). */
  handoffRate: number | null;
  errors: number;
  medianLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  /** `null` = có lượt CHƯA KHAI ĐƠN GIÁ ⇒ chi phí của dòng này là CHƯA BIẾT, không phải 0đ. */
  costVnd: number | null;
  unpricedRuns: number;
};

function sinceOf(days: number): Date {
  return new Date(Date.now() - Math.min(Math.max(days, 1), 90) * 86_400_000);
}

export async function salesRunBreakdown(days = 7, dim: RunBreakdown = "PAGE"): Promise<RunBreakdownRow[]> {
  const db = await getDb();
  const since = sinceOf(days);
  const r = schema.aiRuns;
  const c = schema.salesConversations;
  const v = schema.aiAgentVersions;

  /*
    Khoá gom của từng chiều. `coalesce(nullif(...))` ở đây KHÔNG phải để làm đẹp: thiếu nó thì mọi
    lượt có ô rỗng rơi vào cùng một dòng `null` không tên, và người đọc không phân biệt được "chưa
    khai" với một lỗi gom nhóm.
  */
  const khoa =
    dim === "PAGE"
      ? sql<string>`coalesce(nullif(${c.pageId}, ''), '(chưa rõ page)')`
      : dim === "DATE"
        ? sql<string>`to_char(${r.startedAt} at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`
        : dim === "INTENT"
          ? // Ý ĐỊNH ĐẦU TIÊN, không unnest: một lượt phải thuộc đúng một dòng, nếu không tổng các
            // dòng lớn hơn số lượt và cả bảng thôi cộng được.
            sql<string>`coalesce(nullif(${r.understanding} #>> '{intents,0}', ''), '(chưa đọc được ý định)')`
          : sql<string>`coalesce(nullif(${v.version}::text, ''), '(chưa gắn bản nhắc)')`;

  const rows = await db
    .select({
      key: khoa,
      runs: sql<number>`count(*)`,
      handoffs: sql<number>`count(*) filter (where ${r.status} = 'HANDED_OFF')`,
      errors: sql<number>`count(*) filter (where ${r.error} is not null)`,
      median: sql<number>`coalesce(percentile_cont(0.5) within group (order by ${r.latencyMs}), 0)`,
      input: sql<number>`coalesce(sum(${r.inputTokens}), 0)`,
      output: sql<number>`coalesce(sum(${r.outputTokens}), 0)`,
      cost: sql<number>`coalesce(sum(${r.costVnd}), 0)`,
      unpriced: sql<number>`count(*) filter (where ${r.costVnd} is null)`,
    })
    .from(r)
    .leftJoin(c, eq(c.id, r.subjectId))
    .leftJoin(v, eq(v.id, r.agentVersionId))
    // ĐÚNG bộ lọc của `shadowMetrics()`. Lệch một vế là hai bảng nói hai con số về cùng một tuần.
    .where(and(gte(r.startedAt, since), eq(r.subjectType, "CONVERSATION")))
    .groupBy(khoa)
    .orderBy(sql`count(*) desc`);

  return rows.map((x) => {
    const runs = Number(x.runs);
    const unpriced = Number(x.unpriced);
    return {
      key: String(x.key),
      label: String(x.key),
      runs,
      handoffs: Number(x.handoffs),
      handoffRate: runs > 0 ? (Number(x.handoffs) / runs) * 100 : null,
      errors: Number(x.errors),
      medianLatencyMs: Math.round(Number(x.median)),
      inputTokens: Number(x.input),
      outputTokens: Number(x.output),
      // Một lượt chưa khai đơn giá làm CẢ DÒNG thành CHƯA BIẾT — y như `shadowMetrics()` làm với
      // con số tổng. Cộng phần đã biết rồi in ra như thể đó là toàn bộ chi phí là nói thiếu.
      costVnd: unpriced > 0 ? null : Number(x.cost),
      unpricedRuns: unpriced,
    };
  });
}

export type ModelBreakdownRow = {
  provider: string;
  model: string;
  tier: string;
  /** ĐỘ MỊN LẦN GỌI, không phải lượt chạy — một lượt có thể gọi mô hình hai lần hoặc không lần nào. */
  calls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costVnd: number | null;
  unpricedCalls: number;
  medianLatencyMs: number;
  /** Bảng giá đã dùng. Rỗng = chưa khai giá ⇒ chi phí là CHƯA BIẾT. */
  pricingVersions: string[];
};

/**
 * Bóc tách theo MÔ HÌNH, ở độ mịn LẦN GỌI.
 *
 * Tách hẳn khỏi bảng trên và khai độ mịn ngay trong tên cột: gộp hai độ mịn dưới cùng một cột
 * "số lượt" là cách chắc chắn nhất để ai đó chia nhầm hai con số cho nhau.
 */
export async function salesModelBreakdown(days = 7): Promise<ModelBreakdownRow[]> {
  const db = await getDb();
  const since = sinceOf(days);
  const m = schema.aiModelCalls;

  const rows = await db
    .select({
      provider: m.provider,
      model: m.model,
      tier: m.tier,
      calls: sql<number>`count(*)`,
      failed: sql<number>`count(*) filter (where not ${m.ok})`,
      input: sql<number>`coalesce(sum(${m.inputTokens}), 0)`,
      output: sql<number>`coalesce(sum(${m.outputTokens}), 0)`,
      cached: sql<number>`coalesce(sum(${m.cachedInputTokens}), 0)`,
      cost: sql<number>`coalesce(sum(${m.costVnd}), 0)`,
      unpriced: sql<number>`count(*) filter (where ${m.costVnd} is null)`,
      median: sql<number>`coalesce(percentile_cont(0.5) within group (order by ${m.latencyMs}), 0)`,
      // Bảng giá đứng CẠNH số tiền, luôn luôn: một con số tiền không nói nó tính theo bảng giá nào
      // thì hai kỳ khác giá trông giống hệt nhau khi đọc lại.
      versions: sql<string[]>`coalesce(array_agg(distinct nullif(${m.pricingVersion}, '')) filter (where nullif(${m.pricingVersion}, '') is not null), '{}')`,
    })
    .from(m)
    .where(gte(m.createdAt, since))
    .groupBy(m.provider, m.model, m.tier)
    .orderBy(sql`count(*) desc`);

  return rows.map((x) => {
    const unpriced = Number(x.unpriced);
    return {
      provider: x.provider,
      model: x.model,
      tier: x.tier,
      calls: Number(x.calls),
      failedCalls: Number(x.failed),
      inputTokens: Number(x.input),
      outputTokens: Number(x.output),
      cachedInputTokens: Number(x.cached),
      costVnd: unpriced > 0 ? null : Number(x.cost),
      unpricedCalls: unpriced,
      medianLatencyMs: Math.round(Number(x.median)),
      pricingVersions: (x.versions ?? []) as string[],
    };
  });
}

/**
 * Các fanpage ĐÃ CÓ hội thoại trong ERP — dùng cho ô lọc của trang soát.
 *
 * Đọc từ chính `sales_conversations` chứ không từ bảng hồ sơ fanpage: một page có hội thoại mà
 * chưa ai khai hồ sơ vẫn phải lọc được, và đó lại đúng là page cần soát nhất.
 */
export async function pagesWithConversations(): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .selectDistinct({ pageId: schema.salesConversations.pageId })
    .from(schema.salesConversations)
    .where(sql`${schema.salesConversations.pageId} <> ''`)
    .orderBy(schema.salesConversations.pageId);
  return rows.map((r) => r.pageId);
}

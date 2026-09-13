import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { KR_DEFAULT_MINIMUM_SAMPLE, METRIC_BINDINGS, metricStateOf, type MetricValue } from "@/lib/constants/metric-bindings";
import { slaStateOf } from "@/lib/constants/work";
import { CARRIER_EVENT_SOURCES, sqlSourceList } from "@/lib/constants/truth";
import { COUNT_DELIVERED, COUNT_RETURNED, DELIVERED_COGS, DELIVERED_REVENUE, IS_DELIVERED, metricScope, successRate } from "@/lib/queries/metrics";
import { PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { collectWorkItems } from "@/lib/queries/work-adapters";
import { rowsOf } from "@/lib/sql-rows";
import type { DepartmentCode } from "@/lib/constants/departments";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ ĐỌC SỐ THẬT CHO OKR / BSC ═══════════
 *
 * Mỗi khoá trong `lib/constants/metric-bindings.ts` có đúng một hàm ở đây. Không hàm nào viết lại
 * một công thức đã tồn tại: tỷ lệ giao thành công đi qua `ORDER_OUTCOME` + `successRate`, doanh thu
 * đi qua `DELIVERED_REVENUE`, tồn đọng công việc đi qua chính phép chiếu của hàng đợi.
 *
 * KHÔNG BAO GIỜ TRẢ 0 THAY CHO "CHƯA BIẾT". Chưa đủ dữ liệu thì `value: null` — một KR hiện 0%
 * trông hệt một KR đang thất bại, và chủ shop sẽ ra quyết định trên cái nhìn đó.
 */

const o = schema.orders;

type Ctx = { period: Period; department?: DepartmentCode | null };

async function outcomeAggregate(period: Period) {
  const db = await getDb();
  const rows = await db
    .select({
      delivered: COUNT_DELIVERED,
      returned: COUNT_RETURNED,
      revenue: DELIVERED_REVENUE,
      cogs: DELIVERED_COGS,
      // Bao nhiêu đơn giao thành công tra được giá vốn — mẫu số của cảnh báo độ phủ.
      cogsKnown: sql<number>`count(*) filter (where ${IS_DELIVERED} and ${DELIVERED_COGS_KNOWN})`,
    })
    .from(o)
    .leftJoin(schema.shipments, and(eq(schema.shipments.orderId, o.id), PRIMARY_ATTEMPT))
    .where(metricScope(period));
  const r = rows[0];
  return { delivered: Number(r?.delivered ?? 0), returned: Number(r?.returned ?? 0), revenue: Number(r?.revenue ?? 0), cogs: Number(r?.cogs ?? 0), cogsKnown: Number(r?.cogsKnown ?? 0) };
}

/** Đơn có tra được giá vốn hay không — dùng để báo độ phủ, không để lọc. */
const DELIVERED_COGS_KNOWN = sql`exists (select 1 from order_items oi where oi.order_id = ${o.id})`;

const CARRIER_SOURCES = sqlSourceList(CARRIER_EVENT_SOURCES);

/* ═══════════════════ TỪNG CHỈ SỐ ═══════════════════ */

/*
  MỖI HÀM ĐỌC PHẢI KHAI CỠ MẪU.

  `sample` là BẮT BUỘC (có thể là `null`) chứ không phải tuỳ chọn — nhờ vậy một chỉ số thêm vào
  ngày mai KHÔNG THỂ quên khai, nó sẽ không biên dịch được. `null` là câu trả lời đúng cho chỉ số
  không đếm quan sát (tiền, số dư): ở đó "cỡ mẫu" không có nghĩa gì.
*/
const RESOLVERS: Record<string, (ctx: Ctx) => Promise<Omit<MetricValue, "key" | "at" | "trust" | "state"> & { sample: number | null }>> = {
  async delivery_success_rate({ period }) {
    const a = await outcomeAggregate(period);
    // Mẫu của một TỶ LỆ là mẫu số của chính nó: đơn ĐÃ kết thúc. Đơn đang đi chưa nói được gì.
    return { value: successRate(a.delivered, a.returned), sample: a.delivered + a.returned };
  },
  async return_rate({ period }) {
    const a = await outcomeAggregate(period);
    const finished = a.delivered + a.returned;
    return { value: finished ? Math.round((a.returned / finished) * 1000) / 10 : null, sample: finished };
  },
  async delivered_revenue({ period }) {
    // TIỀN không có cỡ mẫu: 40 triệu là 40 triệu, không phải "40 triệu trên n quan sát".
    return { value: (await outcomeAggregate(period)).revenue, sample: null };
  },
  async delivered_orders({ period }) {
    const a = await outcomeAggregate(period);
    // Chưa đơn nào kết thúc thì "0 đơn giao thành công" là SỰ THẬT, không phải chưa biết.
    // Đây là SỐ ĐẾM, không phải tỷ lệ ⇒ không có ngưỡng mẫu để so.
    return { value: a.delivered, sample: null };
  },
  async delivered_contribution({ period }) {
    const a = await outcomeAggregate(period);
    if (!a.delivered) return { value: null, coverage: null, sample: 0, note: "Chưa có đơn giao thành công nào trong kỳ" };
    const coverage = a.cogsKnown / a.delivered;
    return { value: a.revenue - a.cogs, coverage, sample: null, note: coverage < 1 ? `Chỉ ${Math.round(coverage * 100)}% đơn giao thành công tra được giá vốn` : "" };
  },

  async return_inspection_backlog() {
    const db = await getDb();
    /*
      Kiện ĐVVC ĐÃ TRẢ VỀ mà kho CHƯA lập phiếu. Đúng định nghĩa của luật kho mục 10: hàng hoàn
      KHÔNG tự vào tồn, "ĐVVC báo đã hoàn" là chưa đủ — phải có phiếu với số đếm thực tế.
    */
    const rows = rowsOf<{ n: number }>(
      await db.execute(sql`
        select count(*)::int as n
        from shipments s
        where s.stage = 'RETURNED'
          and exists (select 1 from shipment_events e where e.shipment_id = s.id and e.source in (${sql.raw(CARRIER_SOURCES)}))
          and not exists (select 1 from return_inspections ri where ri.shipment_id = s.id)
      `),
    );
    return { value: Number(rows[0]?.n ?? 0), sample: null };
  },

  async unclassified_bank_txns() {
    const db = await getDb();
    const rows = await db.select({ n: sql<number>`count(*)::int` }).from(schema.bankTransactions).where(eq(schema.bankTransactions.accountingGroup, "UNCLASSIFIED"));
    return { value: Number(rows[0]?.n ?? 0), sample: null };
  },

  async cod_outstanding() {
    const db = await getDb();
    /*
      Tiền THỰC THU chưa ghi nhận về ngân hàng. Dùng `cod_collected` — con số CÓ CHỨNG TỪ — chứ không
      dùng `cod_amount` (số khai): số khai chưa phải tiền. Cố ý KHÔNG lọc theo `stage`: tiền và
      logistics là hai chiều riêng (AGENTS mục 0.1); vận đơn có tiền thực thu mà stage còn cũ hay
      đang ở chiều hoàn vẫn là tiền chưa về, bỏ nó ra là đếm thiếu.
    */
    const rows = rowsOf<{ v: number }>(
      await db.execute(sql`
        select coalesce(sum(s.cod_collected), 0)::bigint as v
        from shipments s
        where coalesce(s.cod_collected, 0) > 0 and s.cod_status <> 'PAID_TO_BANK'
      `),
    );
    return { value: Number(rows[0]?.v ?? 0), sample: null };
  },

  async ads_spend({ period }) {
    const db = await getDb();
    const conds = [sql`1 = 1`];
    if (period.from) conds.push(sql`a.spend_date >= ${period.from}`);
    if (period.to) conds.push(sql`a.spend_date <= ${period.to}`);
    const rows = rowsOf<{ v: number }>(await db.execute(sql`select coalesce(sum(a.spend), 0)::bigint as v from ad_spends a where ${sql.join(conds, sql` and `)}`));
    return { value: Number(rows[0]?.v ?? 0), sample: null };
  },

  async profit_after_ads({ period }) {
    const { getAdsDecision } = await import("@/lib/queries/ads-decision");
    const d = await getAdsDecision(period, "campaign");
    const known = d.rows.filter((r) => r.spendKnown);
    if (!known.length) return { value: null, coverage: 0, sample: 0, note: "Không dòng nào biết số chi — Facebook chỉ trả chi tiêu ở cấp chiến dịch" };
    return { value: known.reduce((s, r) => s + r.profitAfterAds, 0), coverage: known.length / d.rows.length, sample: null, note: known.length < d.rows.length ? `${d.rows.length - known.length} dòng không biết số chi, KHÔNG tính vào tổng` : "" };
  },

  async work_overdue({ department }) {
    const { items } = await collectWorkItems();
    const now = new Date();
    const list = department ? items.filter((i) => i.department === department) : items;
    return { value: list.filter((i) => slaStateOf(i.slaAt ?? i.dueAt, now) === "BREACHED").length, sample: null };
  },
  async work_open({ department }) {
    const { items } = await collectWorkItems();
    return { value: (department ? items.filter((i) => i.department === department) : items).length, sample: null };
  },
  async work_unassigned({ department }) {
    const { items } = await collectWorkItems();
    const list = department ? items.filter((i) => i.department === department) : items;
    return { value: list.filter((i) => !i.assignee).length, sample: null };
  },
  async work_sla_on_time({ department }) {
    const { items } = await collectWorkItems();
    const now = new Date();
    const list = (department ? items.filter((i) => i.department === department) : items).filter((i) => (i.slaAt ?? i.dueAt) !== null);
    // KHÔNG việc nào có hạn ⇒ không có tỷ lệ nào để nói. `null`, không phải 100%.
    if (!list.length) return { value: null, sample: 0, note: "Không việc nào trong phạm vi này có đặt hạn" };
    return { value: Math.round((list.filter((i) => slaStateOf(i.slaAt ?? i.dueAt, now) !== "BREACHED").length / list.length) * 1000) / 10, sample: list.length };
  },
};

/** Đọc một chỉ số. Khoá không có trong sổ ⇒ `null` kèm ghi chú — KHÔNG đoán, KHÔNG trả 0. */
export async function resolveMetric(key: string, ctx: Ctx): Promise<MetricValue> {
  const binding = METRIC_BINDINGS[key];
  const at = new Date();
  if (!binding) return { key, value: null, at, trust: "MANUAL", state: "UNKNOWN", note: "Chỉ số không có trong sổ đăng ký — nhập tay" };
  const run = RESOLVERS[key];
  if (!run) return { key, value: null, at, trust: binding.trust, state: "UNKNOWN", note: "Chỉ số đã khai nhưng chưa có hàm đọc" };
  try {
    const r = await run(ctx);
    /*
      TRẠNG THÁI TÍNH Ở ĐÂY, MỘT CHỖ.

      Để từng hàm đọc tự chấm "đủ hay chưa đủ" thì sớm muộn hai hàm dùng hai ngưỡng khác nhau, và
      không ai phát hiện vì cả hai đều trả về một con số trông hợp lý.
    */
    const state = metricStateOf({ value: r.value, sample: r.sample, minimumSample: binding.minimumSample ?? KR_DEFAULT_MINIMUM_SAMPLE });
    return { key, at, trust: binding.trust, state, ...r };
  } catch (e) {
    // Một chỉ số hỏng KHÔNG được làm sập cả trang mục tiêu — và cũng không được biến thành 0.
    return { key, value: null, at, trust: binding.trust, state: "UNKNOWN", note: `Chưa đọc được: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Đọc nhiều chỉ số một lượt. Trùng khoá chỉ đọc một lần. */
export async function resolveMetrics(keys: string[], ctx: Ctx): Promise<Map<string, MetricValue>> {
  const unique = [...new Set(keys.filter((k) => k && k !== "MANUAL"))];
  const values = await Promise.all(unique.map((k) => resolveMetric(k, ctx)));
  return new Map(values.map((v) => [v.key, v]));
}

/** Chỉ số đã khai trong sổ nhưng chưa có hàm đọc — lá chắn kiểm thử dùng. */
export const METRICS_WITHOUT_RESOLVER = Object.keys(METRIC_BINDINGS).filter((k) => !RESOLVERS[k]);

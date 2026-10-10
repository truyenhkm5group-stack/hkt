/**
 * ═══════════ GIÁ TRỊ KHÁCH HÀNG — ĐỌC ẢNH CHỤP (CHỈ MÁY CHỦ · CHỈ CSDL NHÀ) ═══════════
 *
 * Màn `/platform/saas` (khối «Giá trị khách hàng») và `/platform/customers/<mã>` (khối «Giá trị & kinh tế đơn vị») đọc ẢNH CHỤP mà
 * lượt chụp của JOB nhà đã ghi (`platform_tenant_value_snapshots` · `platform_tenant_health_daily`, 0240) — tệp này KHÔNG mở CSDL
 * của tổ chức nào, KHÔNG gọi lượt chụp, và KHÔNG tự chụp khi chưa có ảnh hôm nay: thiếu thì màn hình nói «chưa có ảnh chụp hôm
 * nay» và hiện ảnh gần nhất (tests/saas-value-ui.test.ts quét mã).
 *
 * Bảng: MỘT câu `distinct on (org_code)` lấy ảnh MỚI NHẤT mỗi tổ chức của cửa sổ đang xem (kèm ô bội số của cửa sổ BỘI SỐ D12 —
 * bội số chỉ có nghĩa ở đó — qua `lateral` trong cùng câu), phân trang + sắp theo CỘT PHẲNG với `NULL` xếp cuối; rồi MỘT câu sức
 * khoẻ ngày gần nhất của đúng các tổ chức trên trang. Không N+1, không phụ thuộc số khách.
 */
import { and, desc, gte, inArray, sql } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { vnDate } from "@/lib/billing/rules";
import { TENANT_VALUE_BOARD_PAGE_SIZE, TENANT_VALUE_DEFAULT_SORT, isTenantValueSortKey, type TenantValueSortKey } from "@/lib/constants/tenant-value-board";
import { DEFAULT_TENANT_VALUE_DECISIONS, TENANT_VALUE_WINDOWS, type TenantValueWindow } from "@/lib/constants/tenant-value-metrics";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import { rowsOf } from "@/lib/sql-rows";
import { healthView, tenantValueRowView, tenantValueWindowView, type HealthView, type TenantHealthRaw, type TenantValueBoardRow, type TenantValueRawRow, type TenantValueWindowView } from "@/lib/saas/tenant-value-view";

/** Mã cột sắp xếp ⇒ biểu thức SQL (danh sách TRẮNG — không bao giờ ghép chuỗi người dùng gửi vào câu lệnh). */
const SORT_SQL: Record<TenantValueSortKey, string> = {
  customerSpend: "s.customer_spend_vnd",
  variableCogs: "s.variable_cogs_vnd",
  valueMultiple: "m.value_multiple_milli",
  platformProfit: "s.platform_gross_profit_vnd",
  org: "lower(coalesce(o.name, s.org_code))",
};

export type TenantValueBoardQuery = { window: TenantValueWindow; page: number; pageSize?: number; sort?: string; dir?: "asc" | "desc"; now?: Date };

export type TenantValueBoard = {
  window: TenantValueWindow;
  /** Cửa sổ của ô bội số (D12). */
  multipleWindow: TenantValueWindow;
  today: string;
  rows: TenantValueBoardRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  sort: TenantValueSortKey;
  dir: "asc" | "desc";
  /** Mốc chụp MỚI NHẤT trong mọi ảnh của cửa sổ này (không chỉ trang đang xem) — `null` = chưa có ảnh nào. */
  latestCapturedAtMs: number | null;
  latestCapturedDay: string | null;
  /** Số tổ chức có ảnh HÔM NAY cho cửa sổ này / tổng số tổ chức có ảnh. */
  capturedToday: number;
};

type SqlRow = {
  org_code: string;
  captured_day: string;
  captured_ms: number | string;
  metrics: unknown;
  formula_version: string;
  source_errors: string[] | null;
  org_name: string | null;
  org_status: string | null;
  account_code: string | null;
  multiple_metrics: unknown;
  multiple_day: string | null;
  total: number | string;
};

const toNum = (v: number | string | null | undefined): number => (typeof v === "number" ? v : Number(v ?? 0));

function parseJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

/** Sức khoẻ NGÀY GẦN NHẤT (không chỉ hôm nay) của một tập tổ chức — một câu. */
async function latestHealth(orgCodes: readonly string[]): Promise<Map<string, TenantHealthRaw>> {
  if (!orgCodes.length) return new Map();
  const pdb = await getPlatformDb();
  const h = schema.platformTenantHealthDaily;
  const rows = await pdb
    .selectDistinctOn([h.orgCode], { orgCode: h.orgCode, day: h.day, level: h.level, churnRisk: h.churnRisk, reasonCodes: h.reasonCodes, gapCodes: h.gapCodes, churnReasonCodes: h.churnReasonCodes, topIssue: h.topIssue })
    .from(h)
    .where(inArray(h.orgCode, [...orgCodes]))
    .orderBy(h.orgCode, desc(h.day));
  return new Map(rows.map((r) => [r.orgCode, r]));
}

/**
 * Bảng giá trị — KHÔNG hỏi người (đọc thô cho bài kiểm). Màn hình đi qua `loadTenantValueBoard` (hỏi người vận hành trước).
 * `page` vượt quá số trang ⇒ trả trang rỗng kèm tổng thật.
 */
export async function readTenantValueBoard(q: TenantValueBoardQuery): Promise<TenantValueBoard> {
  const pdb = await getPlatformDb();
  const now = q.now ?? new Date();
  const today = vnDate(now);
  const window = (TENANT_VALUE_WINDOWS as readonly number[]).includes(q.window) ? q.window : DEFAULT_TENANT_VALUE_DECISIONS.defaultWindowDays;
  const multipleWindow = DEFAULT_TENANT_VALUE_DECISIONS.multipleWindowDays;
  const pageSize = Math.min(Math.max(Math.trunc(q.pageSize ?? TENANT_VALUE_BOARD_PAGE_SIZE), 1), 100);
  const page = Math.max(Math.trunc(q.page || 1), 1);
  const sort: TenantValueSortKey = isTenantValueSortKey(q.sort) ? q.sort : TENANT_VALUE_DEFAULT_SORT;
  const dir = q.dir === "asc" ? "asc" : "desc";
  const order = sql.raw(`${SORT_SQL[sort]} ${dir} nulls last, s.org_code asc`);

  const result = await pdb.execute(sql`
    select s.org_code, s.captured_day::text as captured_day, (extract(epoch from s.captured_at) * 1000)::float8 as captured_ms,
           s.metrics, s.formula_version, s.source_errors,
           o.name as org_name, o.status as org_status, a.code as account_code,
           m.metrics as multiple_metrics, m.captured_day::text as multiple_day,
           count(*) over ()::int as total
      from (
        select distinct on (org_code) org_code, captured_day, captured_at, metrics, formula_version, source_errors,
               customer_spend_vnd, variable_cogs_vnd, platform_gross_profit_vnd, orders_pending
          from platform_tenant_value_snapshots
         where window_days = ${window}
         order by org_code, captured_day desc
      ) s
      left join platform_organizations o on o.code = s.org_code
      left join platform_accounts a on a.id = o.account_id
      left join lateral (
        select x.captured_day, x.value_multiple_milli,
               jsonb_build_object('customer_value_multiple', x.metrics -> 'customer_value_multiple', 'ai_credited_cogs_coverage', x.metrics -> 'ai_credited_cogs_coverage') as metrics
          from platform_tenant_value_snapshots x
         where x.org_code = s.org_code and x.window_days = ${multipleWindow}
         order by x.captured_day desc
         limit 1
      ) m on true
     order by ${order}
     limit ${pageSize} offset ${(page - 1) * pageSize}
  `);
  const raw = rowsOf<SqlRow>(result);

  // Tổng quan của CẢ cửa sổ (không chỉ trang): mốc chụp mới nhất, số tổ chức có ảnh hôm nay — và tổng thật khi trang vượt cuối.
  const t = schema.platformTenantValueSnapshots;
  const [meta] = rowsOf<{ orgs: number | string; latest_ms: number | string | null; latest_day: string | null; today_orgs: number | string }>(
    await pdb.execute(sql`
      select count(distinct ${t.orgCode})::int as orgs,
             (extract(epoch from max(${t.capturedAt})) * 1000)::float8 as latest_ms,
             max(${t.capturedDay})::text as latest_day,
             count(distinct ${t.orgCode}) filter (where ${t.capturedDay} = ${today}::date)::int as today_orgs
        from ${t}
       where ${t.windowDays} = ${window}
    `),
  );
  const total = raw.length ? toNum(raw[0].total) : toNum(meta?.orgs);
  const health = await latestHealth(raw.map((r) => r.org_code));
  const rows = raw.map((r) => {
    const v: TenantValueRawRow = {
      orgCode: r.org_code,
      orgName: r.org_name,
      orgStatus: r.org_status,
      accountCode: r.account_code,
      capturedDay: r.captured_day,
      capturedAtMs: toNum(r.captured_ms),
      formulaVersion: r.formula_version,
      sourceErrors: r.source_errors ?? [],
      metrics: parseJson(r.metrics),
      multiple: r.multiple_day ? { metrics: parseJson(r.multiple_metrics), capturedDay: r.multiple_day } : null,
    };
    return tenantValueRowView(v, health.get(r.org_code) ?? null, today);
  });
  const latestMs = meta?.latest_ms === null || meta?.latest_ms === undefined ? null : toNum(meta.latest_ms);
  return {
    window,
    multipleWindow,
    today,
    rows,
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    sort,
    dir,
    latestCapturedAtMs: latestMs,
    latestCapturedDay: meta?.latest_day ?? null,
    capturedToday: toNum(meta?.today_orgs),
  };
}

/** Màn `/platform/saas`: hỏi người vận hành TRƯỚC lượt đọc đầu tiên (S21), rồi đọc ảnh. */
export async function loadTenantValueBoard(user: SessionUser, q: TenantValueBoardQuery): Promise<{ ok: true; value: TenantValueBoard } | { ok: false; error: string }> {
  const denial = platformOperatorDenial(user);
  if (denial) return { ok: false, error: denial };
  return { ok: true, value: await readTenantValueBoard(q) };
}

// ─────────────────────────── Một khách: ba cửa sổ + dải sức khoẻ 30 ngày ───────────────────────────

export const HEALTH_STRIP_DAYS = 30;

export type TenantValueDetailOrg = {
  orgCode: string;
  /** Ảnh mới nhất của từng cửa sổ — vắng = chưa có ảnh cửa sổ đó. */
  windows: Partial<Record<TenantValueWindow, TenantValueWindowView>>;
  /** Sức khoẻ ngày gần nhất trong dải (không chỉ hôm nay). */
  latest: HealthView | null;
  /** Dải mức sức khoẻ — MỘT ô mỗi ngày trong `HEALTH_STRIP_DAYS` ngày, ngày chưa chụp là `null` (chưa đo, không phải «khoẻ»). */
  strip: { day: string; health: HealthView | null }[];
};

export type TenantValueDetail = { today: string; orgs: TenantValueDetailOrg[] };

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Đọc thô cho bài kiểm — màn hình đi qua `loadTenantValueDetail`. */
export async function readTenantValueDetail(orgCodes: readonly string[], now: Date = new Date()): Promise<TenantValueDetail> {
  const today = vnDate(now);
  if (!orgCodes.length) return { today, orgs: [] };
  const pdb = await getPlatformDb();
  const t = schema.platformTenantValueSnapshots;
  const h = schema.platformTenantHealthDaily;
  const codes = [...orgCodes];
  const snaps = await pdb
    .selectDistinctOn([t.orgCode, t.windowDays], { orgCode: t.orgCode, windowDays: t.windowDays, capturedDay: t.capturedDay, capturedAt: t.capturedAt, metrics: t.metrics, formulaVersion: t.formulaVersion, sourceErrors: t.sourceErrors })
    .from(t)
    .where(inArray(t.orgCode, codes))
    .orderBy(t.orgCode, t.windowDays, desc(t.capturedDay));
  const from = addDays(today, -(HEALTH_STRIP_DAYS - 1));
  const healthRows = await pdb
    .select({ orgCode: h.orgCode, day: h.day, level: h.level, churnRisk: h.churnRisk, reasonCodes: h.reasonCodes, gapCodes: h.gapCodes, churnReasonCodes: h.churnReasonCodes, topIssue: h.topIssue })
    .from(h)
    .where(and(inArray(h.orgCode, codes), gte(h.day, from)))
    .orderBy(h.orgCode, h.day);
  return {
    today,
    orgs: codes.map((code) => {
      const own = snaps.filter((s) => s.orgCode === code);
      const healthByDay = new Map(healthRows.filter((r) => r.orgCode === code).map((r) => [r.day, r]));
      const latestHealth = [...healthByDay.values()].at(-1) ?? null;
      const windows: TenantValueDetailOrg["windows"] = {};
      for (const s of own) {
        if (!(TENANT_VALUE_WINDOWS as readonly number[]).includes(s.windowDays)) continue;
        windows[s.windowDays as TenantValueWindow] = tenantValueWindowView({ capturedDay: s.capturedDay, capturedAtMs: s.capturedAt.getTime(), formulaVersion: s.formulaVersion, sourceErrors: s.sourceErrors, metrics: s.metrics }, today);
      }
      const strip = Array.from({ length: HEALTH_STRIP_DAYS }, (_, i) => {
        const day = addDays(from, i);
        return { day, health: healthView(healthByDay.get(day) ?? null, today) };
      });
      return { orgCode: code, windows, latest: healthView(latestHealth, today), strip };
    }),
  };
}

/** Khối «Giá trị & kinh tế đơn vị» của một khách — hỏi người vận hành TRƯỚC lượt đọc đầu tiên (S21). */
export async function loadTenantValueDetail(user: SessionUser, orgCodes: readonly string[], now: Date = new Date()): Promise<{ ok: true; value: TenantValueDetail } | { ok: false; error: string }> {
  const denial = platformOperatorDenial(user);
  if (denial) return { ok: false, error: denial };
  return { ok: true, value: await readTenantValueDetail(orgCodes, now) };
}

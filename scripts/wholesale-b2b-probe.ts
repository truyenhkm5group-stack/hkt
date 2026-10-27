/*
  ops `wholesale-b2b-probe` — ẢNH CHỤP SỐ ĐẾM CỦA SĂN KHÁCH SỈ + GIÁ SỈ TRÊN MỘT TỔ CHỨC (CHỈ ĐỌC, chương trình AI B2B Sales Agent
  của HSLC, P1-D 27/10/2026).

  Vì sao có: trước khi dựng tác tử bán sỉ (AI B2B Sales Agent) cần biết NỀN thật của tổ chức — module đã bật chưa, chiến dịch quét
  chạy tới đâu, bao nhiêu lead có cách liên lạc, bao nhiêu lead đã thành khách và có đơn, bảng giá sỉ phủ bao nhiêu mẫu mã, AI đã soạn
  bao nhiêu lời chào. Đo trước rồi mới đặt đích — không đoán.

  Đọc: `settings["wholesale.leadHunter"]` (chỉ trường KHÔNG bí mật: mức tự động, ngân sách, hạn mức miễn phí), wholesale_campaigns ·
  wholesale_campaign_cells · wholesale_api_usage · wholesale_leads · wholesale_outreach_items · wholesale_lead_activities ·
  wholesale_suppressions · orders (qua customer_id của lead) · price_lists · price_list_items · product_variants ·
  customer_trade_terms ở CSDL TỔ CHỨC; `platform_ai_usage` (feature `lead_hunter`, lọc ĐÚNG org_code) và cấu hình module ở CSDL NHÀ.

  · Doanh thu lead → đơn là DOANH THU THEO ĐƠN (tổng tiền hàng sau giảm của đơn chưa huỷ / xoá), CHƯA đối chiếu tiền thật — chỉ để
    tham khảo, không phải kết quả đơn (ORDER_OUTCOME) và không phải tiền thu được.
  · Bảng / cột chưa có ở CSDL tổ chức (chưa áp migration) ⇒ mục đó in «chưa có bảng», KHÔNG sập, KHÔNG in 0.
  · Kênh [ops:tom-tat] CHỈ số đếm / tiền — không tên, SĐT, email, URL, địa chỉ. Mẫu dòng (đã che số dài) chỉ ở phần MÃ HOÁ.

  Mở CSDL tổ chức bằng getDbForInspection (máy chủ ép chỉ đọc, không migrate, không tạo), kiểm `default_transaction_read_only`
  trước khi đọc. Không ghi gì, không gọi API ngoài.
  arg: "[--org=<mã tổ chức>]" (mặc định hslc-hmt-shop).
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("wholesale-b2b-probe.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";
import "dotenv/config";
import { sql, type SQL } from "drizzle-orm";
import { getDbForInspection, getPlatformDb, type Db } from "@/db";
import { canUseFeature, canUseModule } from "@/lib/platform/capabilities";
import { findOrganization } from "@/lib/platform/organizations";
import { packSummaryLines } from "@/lib/ops/summary-lines";
import { rowsOf } from "@/lib/sql-rows";
import { mergeLeadHunterConfig, LEAD_HUNTER_SETTING_KEY } from "@/lib/wholesale/config";

export const B2B_PROBE_DEFAULT_ORG = "hslc-hmt-shop";
/** Số tuần gần nhất của bảng «lead tạo theo tuần». */
export const B2B_PROBE_WEEKS = 8;
/** Cửa sổ của sổ chi phí API / hoạt động / AI. */
export const B2B_PROBE_DAYS = 30;
/** Mẫu dòng mỗi nhóm in vào phần mã hoá. */
export const B2B_PROBE_SAMPLES = 10;
const USAGE = "[--org=<mã tổ chức>]";
const TAG = "wholesale-b2b-probe";

export function parseB2bProbeArgs(argv: readonly string[]): { org: string } | { error: string } {
  let org = B2B_PROBE_DEFAULT_ORG;
  for (const a of argv) {
    if (a.startsWith("--org=")) org = a.slice(6).trim();
    else return { error: `tham số lạ «${a.slice(0, 40)}»` };
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(org)) return { error: "sai mã tổ chức" };
  return { org };
}

// ─────────────────────────── PHẦN THUẦN ───────────────────────────

/** Tiền VND nguyên, phân cách nghìn bằng dấu chấm. `null` ⇒ «—» (chưa biết, không phải 0). */
export function vnd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")} ₫`;
}

/** micro-USD ⇒ «US$x,xx». */
export function usdFromMicros(micros: number): string {
  return `US$${(micros / 1_000_000).toFixed(2).replace(".", ",")}`;
}

/** Bảng đếm theo nhãn ⇒ các mảnh «nhãn n» theo thứ tự giảm dần (mỗi mảnh một nhãn để `packSummaryLines` ngắt dòng được). Rỗng ⇒ «(không dòng nào)». */
export function countsParts(rows: readonly { k: string | null; n: number }[]): string[] {
  if (!rows.length) return ["(không dòng nào)"];
  return [...rows].sort((a, b) => b.n - a.n || String(a.k).localeCompare(String(b.k))).map((r) => `${r.k ?? "(trống)"} ${r.n}`);
}

/** Che dãy số dài (SĐT, mã) và địa chỉ thư / URL trong mẫu dòng của phần mã hoá. */
export function mask(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/\S+@\S+/g, "<email>")
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/\d{6,}/g, "######")
    .slice(0, 80);
}

/** Lỗi «bảng / cột chưa có» của Postgres (42P01 / 42703) — drizzle có thể bọc trong `cause`. */
export function isMissingRelation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string }; message?: string } | null;
  const code = e?.code ?? e?.cause?.code;
  if (code === "42P01" || code === "42703") return true;
  return /does not exist/i.test(String(e?.message ?? "")) && /relation|column/i.test(String(e?.message ?? ""));
}

export const MISSING = "chưa có bảng" as const;
export type Section<T> = T | typeof MISSING;

/** Chạy một mục; bảng / cột chưa có ⇒ `MISSING` (mục khác vẫn chạy). Lỗi khác NÉM — không giấu lỗi thật thành «chưa có». */
export async function section<T>(fn: () => Promise<T>): Promise<Section<T>> {
  try {
    return await fn();
  } catch (error) {
    if (isMissingRelation(error)) return MISSING;
    throw error;
  }
}

// ─────────────────────────── ĐỌC CSDL ───────────────────────────

type KN = { k: string | null; n: number };
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const q = async <T>(db: Db, query: SQL): Promise<T[]> => rowsOf<T>(await db.execute(query));
const counts = async (db: Db, query: SQL): Promise<KN[]> => (await q<{ k: string | null; n: number }>(db, query)).map((r) => ({ k: r.k, n: num(r.n) }));

export type B2bProbeSummary = {
  config: Section<{ saved: boolean; automationLevel: string; useAi: boolean; dailyUsd: number; monthlyUsd: number; dailyRequestLimit: number; freeTierEnabled: boolean; freeTierSafetyPct: number; discoveryTier: string; fieldSalesDestinations: number }>;
  campaigns: Section<KN[]>;
  cells: Section<KN[]>;
  apiUsage: Section<{ calls: number; billable: number; failed: number; costMicros: number }>;
  leads: Section<{ total: number; withPhone: number; withEmail: number; withWebsite: number; duplicate: number; doNotContact: number; won: number; withCustomer: number }>;
  leadGrades: Section<KN[]>;
  leadStatuses: Section<KN[]>;
  leadWeeks: Section<KN[]>;
  outreach: Section<KN[]>;
  activities: Section<KN[]>;
  suppressions: Section<KN[]>;
  leadOrders: Section<{ withCustomer: number; noConvertedAt: number; leadsWithOrder: number; orders: number; revenue: number }>;
  pricing: Section<{ activeLists: number; defaultLists: number; items: number; tieredVariants: number; sellingVariants: number }>;
  tradeTerms: Section<{ rows: number; withPriceList: number; withCreditLimit: number; withPaymentTerms: number }>;
  ai: Section<{ rows: number; requests: number; costUsd: number | null; unknownCost: number; byStatus: KN[] }>;
};

export async function runWholesaleB2bProbe(opts: { db: Db; platformDb: Db; orgCode: string; now: Date; label: string; moduleEnabled: boolean | null; features: Record<string, boolean | null> }): Promise<B2bProbeSummary> {
  const { db, platformDb, orgCode, now } = opts;
  const since = new Date(now.getTime() - B2B_PROBE_DAYS * 86_400_000).toISOString();
  const weeksSince = new Date(now.getTime() - B2B_PROBE_WEEKS * 7 * 86_400_000).toISOString();

  const config = await section(async () => {
    const [row] = await q<{ value: string }>(db, sql`select value from settings where key = ${LEAD_HUNTER_SETTING_KEY}`);
    let raw: unknown = null;
    if (row) {
      try {
        raw = JSON.parse(row.value);
      } catch {
        raw = null;
      }
    }
    // Chỉ trường KHÔNG bí mật. Lời chào, kịch bản, chat ID nhận tin… KHÔNG in — kể cả ở phần mã hoá.
    const c = mergeLeadHunterConfig(raw);
    return {
      saved: Boolean(row),
      automationLevel: c.outreach.automationLevel,
      useAi: c.outreach.useAi,
      dailyUsd: c.budget.dailyUsd,
      monthlyUsd: c.budget.monthlyUsd,
      dailyRequestLimit: c.budget.dailyRequestLimit,
      freeTierEnabled: c.freeTier.enabled,
      freeTierSafetyPct: c.freeTier.safetyPct,
      discoveryTier: c.discoveryTier,
      fieldSalesDestinations: c.fieldSales.destinations.length,
    };
  });

  const campaigns = await section(() => counts(db, sql`select status as k, count(*)::int as n from wholesale_campaigns where not is_template group by status`));
  const cells = await section(() => counts(db, sql`select status as k, count(*)::int as n from wholesale_campaign_cells group by status`));
  const apiUsage = await section(async () => {
    const [r] = await q<Record<string, unknown>>(
      db,
      sql`select count(*)::int as calls, count(*) filter (where billable)::int as billable, count(*) filter (where not ok)::int as failed,
                 coalesce(sum(cost_micros), 0)::bigint as cost
            from wholesale_api_usage where at >= ${since}::timestamptz`,
    );
    return { calls: num(r?.calls), billable: num(r?.billable), failed: num(r?.failed), costMicros: num(r?.cost) };
  });

  const leads = await section(async () => {
    const [r] = await q<Record<string, unknown>>(
      db,
      sql`select count(*)::int as total,
                 count(*) filter (where coalesce(normalized_phone, phone_raw, '') <> '')::int as with_phone,
                 count(*) filter (where coalesce(email, '') <> '')::int as with_email,
                 count(*) filter (where coalesce(website, website_domain, '') <> '')::int as with_website,
                 count(*) filter (where duplicate_of_lead_id is not null or enrichment_status = 'DUPLICATE')::int as duplicate,
                 count(*) filter (where contact_status = 'DO_NOT_CONTACT')::int as dnc,
                 count(*) filter (where contact_status = 'WON')::int as won,
                 count(*) filter (where customer_id is not null)::int as with_customer
            from wholesale_leads`,
    );
    return {
      total: num(r?.total),
      withPhone: num(r?.with_phone),
      withEmail: num(r?.with_email),
      withWebsite: num(r?.with_website),
      duplicate: num(r?.duplicate),
      doNotContact: num(r?.dnc),
      won: num(r?.won),
      withCustomer: num(r?.with_customer),
    };
  });
  const leadGrades = await section(() => counts(db, sql`select coalesce(lead_grade, '(chưa chấm)') as k, count(*)::int as n from wholesale_leads group by 1`));
  const leadStatuses = await section(() => counts(db, sql`select contact_status as k, count(*)::int as n from wholesale_leads group by 1`));
  const leadWeeks = await section(() =>
    counts(
      db,
      sql`select to_char(date_trunc('week', created_at at time zone 'Asia/Ho_Chi_Minh'), 'YYYY-MM-DD') as k, count(*)::int as n
            from wholesale_leads where created_at >= ${weeksSince}::timestamptz group by 1 order by 1`,
    ),
  );
  const outreach = await section(() => counts(db, sql`select channel || '×' || status as k, count(*)::int as n from wholesale_outreach_items group by channel, status`));
  const activities = await section(() => counts(db, sql`select kind as k, count(*)::int as n from wholesale_lead_activities where created_at >= ${since}::timestamptz group by 1`));
  const suppressions = await section(() => counts(db, sql`select kind as k, count(*)::int as n from wholesale_suppressions group by 1`));

  // Lead → khách → đơn SAU mốc chuyển thành khách. Lead có khách mà KHÔNG có mốc chuyển ⇒ đếm riêng, KHÔNG gán đơn (không đoán mốc).
  const leadOrders = await section(async () => {
    const [r] = await q<Record<string, unknown>>(
      db,
      sql`with l as (
            select id, customer_id, converted_at from wholesale_leads where customer_id is not null
          ), o as (
            select l.id as lead_id, o.id as order_id, coalesce(o.total_price_after_discount, o.total_price, 0) as tien
              from l join orders o on o.customer_id = l.customer_id
             where l.converted_at is not null and o.inserted_at >= l.converted_at and o.stage::text not in ('CANCELLED', 'DELETED')
          )
          select (select count(*)::int from l) as with_customer,
                 (select count(*)::int from l where converted_at is null) as no_converted,
                 (select count(distinct lead_id)::int from o) as leads_with_order,
                 (select count(distinct order_id)::int from o) as orders,
                 (select coalesce(sum(tien), 0)::bigint from (select distinct order_id, tien from o) d) as revenue`,
    );
    return { withCustomer: num(r?.with_customer), noConvertedAt: num(r?.no_converted), leadsWithOrder: num(r?.leads_with_order), orders: num(r?.orders), revenue: num(r?.revenue) };
  });

  const pricing = await section(async () => {
    const [r] = await q<Record<string, unknown>>(
      db,
      sql`select (select count(*)::int from price_lists where active) as active_lists,
                 (select count(*)::int from price_lists where active and is_default) as default_lists,
                 (select count(*)::int from price_list_items i join price_lists p on p.id = i.price_list_id where p.active) as items,
                 (select count(distinct i.variant_id)::int from price_list_items i join price_lists p on p.id = i.price_list_id
                   join product_variants v on v.id = i.variant_id where p.active and not v.is_hidden and not v.is_removed) as tiered,
                 (select count(*)::int from product_variants v join products p on p.id = v.product_id
                   where not v.is_hidden and not v.is_removed and not p.is_hidden and not p.is_removed) as selling`,
    );
    return { activeLists: num(r?.active_lists), defaultLists: num(r?.default_lists), items: num(r?.items), tieredVariants: num(r?.tiered), sellingVariants: num(r?.selling) };
  });
  const tradeTerms = await section(async () => {
    const [r] = await q<Record<string, unknown>>(
      db,
      sql`select count(*)::int as n, count(price_list_id)::int as pl, count(credit_limit)::int as cl, count(payment_terms_days)::int as pt from customer_trade_terms`,
    );
    return { rows: num(r?.n), withPriceList: num(r?.pl), withCreditLimit: num(r?.cl), withPaymentTerms: num(r?.pt) };
  });

  // Sổ AI ở CSDL NHÀ — LUÔN lọc đúng org_code (không bao giờ đọc lượt của tổ chức khác).
  const ai = await section(async () => {
    const [r] = await q<Record<string, unknown>>(
      platformDb,
      sql`select count(*)::int as n, coalesce(sum(requests), 0)::int as requests, sum(cost_usd)::float8 as cost, count(*) filter (where cost_usd is null)::int as unknown_cost
            from platform_ai_usage where org_code = ${orgCode} and feature = 'lead_hunter' and at >= ${since}::timestamptz`,
    );
    const byStatus = await counts(platformDb, sql`select status as k, count(*)::int as n from platform_ai_usage where org_code = ${orgCode} and feature = 'lead_hunter' and at >= ${since}::timestamptz group by 1`);
    const cost = r?.cost === null || r?.cost === undefined ? null : Number(r.cost);
    return { rows: num(r?.n), requests: num(r?.requests), costUsd: cost, unknownCost: num(r?.unknown_cost), byStatus };
  });

  const s: B2bProbeSummary = { config, campaigns, cells, apiUsage, leads, leadGrades, leadStatuses, leadWeeks, outreach, activities, suppressions, leadOrders, pricing, tradeTerms, ai };
  for (const line of summaryLines(s, opts)) console.log(`[ops:tom-tat] ${line}`);

  // ── PHẦN MÃ HOÁ (console.log thường): mẫu dòng, đã che số dài / thư / URL. ──
  const samples: [string, SQL][] = [
    ["chiến dịch", sql`select id, name, status, max_leads, created_at from wholesale_campaigns where not is_template order by created_at desc limit ${B2B_PROBE_SAMPLES}`],
    ["lead mới nhất", sql`select id, business_name, lead_grade, lead_score, contact_status, segment, province_label, (customer_id is not null) as co_khach, created_at from wholesale_leads order by created_at desc limit ${B2B_PROBE_SAMPLES}`],
    ["lead đã thành khách", sql`select id, business_name, contact_status, customer_id, converted_at, won_at from wholesale_leads where customer_id is not null order by converted_at desc nulls last limit ${B2B_PROBE_SAMPLES}`],
    ["bảng giá đang bật", sql`select p.id, p.name, p.is_default, count(i.id)::int as so_bac from price_lists p left join price_list_items i on i.price_list_id = p.id where p.active group by p.id order by p.created_at limit ${B2B_PROBE_SAMPLES}`],
  ];
  for (const [label, query] of samples) {
    console.log(`— Mẫu «${label}»:`);
    const rows = await section(() => q<Record<string, unknown>>(db, query));
    if (rows === MISSING) console.log(`  ${MISSING}`);
    else for (const r of rows) console.log(`  · ${Object.entries(r).map(([k, v]) => `${k}=${mask(v instanceof Date ? v.toISOString() : String(v ?? ""))}`).join(" ")}`);
  }
  return s;
}

/** Dòng tóm tắt công khai — CHỈ số đếm / tiền / nhãn trạng thái. HÀM THUẦN. */
export function summaryLines(s: B2bProbeSummary, opts: { label: string; moduleEnabled: boolean | null; features: Record<string, boolean | null> }): string[] {
  const out: string[] = [];
  const yn = (b: boolean | null) => (b === null ? "chưa đo" : b ? "BẬT" : "TẮT");
  const sec = <T>(v: Section<T>, f: (x: T) => string[]): string[] => (v === MISSING ? [MISSING] : f(v));
  // Dòng ≤ 280 BYTE (ops cắt `cut -c1-300` theo byte) — bộ dồn DÙNG CHUNG của lib/ops/summary-lines, không viết luật thứ hai.
  const add = (head: string, parts: string[]) => out.push(...packSummaryLines(`${TAG}: ${head}`, parts));

  add(opts.label, [`module wholesale_leads ${yn(opts.moduleEnabled)}`, ...Object.entries(opts.features).map(([k, v]) => `${k.replace("wholesale_leads.", "")} ${yn(v)}`)]);
  add("cấu hình", sec(s.config, (c) => [
    c.saved ? "đã lưu" : "chưa lưu (mặc định)",
    `tự động ${c.automationLevel}`,
    `AI soạn ${c.useAi ? "có" : "không"}`,
    `ngân sách US$${c.dailyUsd}/ngày`,
    `US$${c.monthlyUsd}/tháng`,
    `${c.dailyRequestLimit} lượt/ngày`,
    `chỉ miễn phí ${c.freeTierEnabled ? "BẬT" : "TẮT"} (chừa ${Math.round(c.freeTierSafetyPct * 100)}%)`,
    `tầng ${c.discoveryTier}`,
    `nơi nhận lead ${c.fieldSalesDestinations}`,
  ]));
  add("chiến dịch", sec(s.campaigns, countsParts));
  add("ô quét", sec(s.cells, countsParts));
  add(`API ${B2B_PROBE_DAYS} ngày`, sec(s.apiUsage, (a) => [`${a.calls} lượt`, `tính tiền ${a.billable}`, `lỗi ${a.failed}`, `ước tính ${usdFromMicros(a.costMicros)}`, "chưa trừ hạn mức miễn phí — hoá đơn Google mới là số thật"]));
  add("lead", sec(s.leads, (l) => [`tổng ${l.total}`, `có SĐT ${l.withPhone}`, `có email ${l.withEmail}`, `có website ${l.withWebsite}`, `trùng ${l.duplicate}`, `không liên hệ ${l.doNotContact}`, `WON ${l.won}`, `có customer_id ${l.withCustomer}`]));
  add("lead theo hạng", sec(s.leadGrades, countsParts));
  add("lead theo trạng thái", sec(s.leadStatuses, countsParts));
  add(`lead tạo theo tuần (${B2B_PROBE_WEEKS} tuần, giờ VN)`, sec(s.leadWeeks, (w) => (w.length ? w.map((r) => `${r.k} ${r.n}`) : ["(không dòng nào)"])));
  add("tiếp cận kênh×trạng thái", sec(s.outreach, countsParts));
  add(`hoạt động ${B2B_PROBE_DAYS} ngày theo loại`, sec(s.activities, countsParts));
  add("danh sách không liên hệ", sec(s.suppressions, countsParts));
  add("lead → đơn", sec(s.leadOrders, (o) => [
    `lead có khách ${o.withCustomer}`,
    `thiếu mốc chuyển ${o.noConvertedAt} (không gán đơn)`,
    `lead có đơn sau mốc chuyển ${o.leadsWithOrder}`,
    `${o.orders} đơn`,
    vnd(o.revenue),
    "doanh thu theo đơn, chưa đối chiếu tiền thật",
  ]));
  add("giá sỉ", sec(s.pricing, (p) => [`bảng giá đang bật ${p.activeLists} (mặc định ${p.defaultLists})`, `${p.items} bậc giá`, `biến thể có bậc ${p.tieredVariants}/${p.sellingVariants} đang bán`]));
  add("điều khoản khách", sec(s.tradeTerms, (t) => [`${t.rows} dòng`, `gán bảng giá ${t.withPriceList}`, `hạn mức nợ ${t.withCreditLimit}`, `hạn trả ${t.withPaymentTerms}`]));
  add(`AI lead_hunter ${B2B_PROBE_DAYS} ngày`, sec(s.ai, (a) => [
    `${a.rows} dòng`,
    `${a.requests} lượt gọi`,
    `chi phí ${a.costUsd === null ? "—" : `US$${a.costUsd.toFixed(4).replace(".", ",")}`}`,
    ...(a.unknownCost ? [`${a.unknownCost} dòng chưa biết giá`] : []),
    ...(a.byStatus.length ? countsParts(a.byStatus) : []),
  ]));
  return out;
}

async function thoat(code: number): Promise<never> {
  await new Promise<void>((done) => process.stdout.write("", () => done()));
  process.exit(code);
}

async function main() {
  const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s}`);
  const args = parseB2bProbeArgs(process.argv.slice(2));
  if ("error" in args) {
    tomTat(`${TAG}: DỪNG · cách dùng sai — ${args.error} (arg: ${USAGE})`);
    return thoat(64);
  }
  const org = await findOrganization(args.org);
  if (!org) {
    tomTat(`${TAG}: DỪNG · không có tổ chức «${args.org}»`);
    return thoat(1);
  }
  const db: Db = await getDbForInspection({ code: org.code, isHome: org.isHome });
  const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") !== "on") {
    tomTat(`${TAG}: DỪNG · phiên CSDL KHÔNG ở chế độ chỉ đọc — không đọc gì`);
    return thoat(1);
  }
  const platformDb = await getPlatformDb();
  // Cấu hình module đọc ở CSDL nhà; lỗi đọc ⇒ «chưa đo», không đoán BẬT / TẮT.
  const safe = async (f: () => Promise<boolean>) => f().catch(() => null);
  const moduleEnabled = await safe(() => canUseModule("wholesale_leads", org.code));
  const features: Record<string, boolean | null> = {};
  for (const k of ["wholesale_leads.website_enrichment", "wholesale_leads.ai_opener"] as const) features[k] = await safe(() => canUseFeature(k, org.code));
  const now = new Date();
  await runWholesaleB2bProbe({ db, platformDb, orgCode: org.code, now, label: `${org.isHome ? "tổ chức nhà" : "tổ chức đã chọn"} · tới ${now.toISOString()}`, moduleEnabled, features });
  return thoat(0);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch(async (e) => {
    console.error(`${TAG} lỗi:`, e instanceof Error ? e.message : e);
    console.log(`[ops:tom-tat] ${TAG}: LỖI ngoài phép đo — chi tiết trong phần mã hoá`);
    await thoat(1);
  });
}

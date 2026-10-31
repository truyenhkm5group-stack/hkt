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

  Mục «email» (chủ shop bật gửi thật 31/10/2026 — người vận hành kiểm cấu hình mà KHÔNG mở được CSDL tổ chức khách): các khoá
  `wholesale.email` · `wholesale.emailInbound` (+ `.cursor`) · `wholesale.emailAiDraft` · `wholesale.emailSequence` · `wholesale.reorder` ·
  `wholesale.quotation` đọc qua ĐÚNG luật của đường chạy — `mergeSettingJson(value, <mặc định của getter>)` rồi hàm parse / merge của
  từng module (không JSON.parse tay); kết nối `gws-smtp` ở `org_connections` (chỉ trạng thái · mốc kiểm · khớp mã tổ chức — KHÔNG đọc
  `secrets_enc`, `secret_hints`, `settings`, `last_test_message`); `wholesale_email_outbox` · `wholesale_email_events` 7 ngày. Lý do
  chờ / chặn ghi ở CSDL là CÂU CHỮ (có thể mang tên miền / địa chỉ thư) ⇒ quy về MÃ ở `EMAIL_BLOCK_REASONS` trước khi in, chữ gốc
  không bao giờ ra tóm tắt. Tóm tắt chỉ chế độ · cờ · trần · mã nước · số đếm — không địa chỉ thư, không tên miền, không danh tính
  người gửi (chỉ nói THIẾU trường nào).

  · Doanh thu lead → đơn là DOANH THU THEO ĐƠN (tổng tiền hàng sau giảm của đơn chưa huỷ / xoá), CHƯA đối chiếu tiền thật — chỉ để
    tham khảo, không phải kết quả đơn (ORDER_OUTCOME) và không phải tiền thu được.
  · Bảng / cột chưa có ở CSDL tổ chức (chưa áp migration) ⇒ mục đó in «chưa có bảng», KHÔNG sập, KHÔNG in 0.
  · Kênh tóm tắt công khai CHỈ số đếm / tiền — không định danh người (tên, số điện thoại, thư, đường dẫn, địa chỉ). Mẫu dòng (đã che số dài) chỉ ở phần MÃ HOÁ.

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
import { mergeSettingJson } from "@/lib/settings";
import { mergeLeadHunterConfig, LEAD_HUNTER_SETTING_KEY } from "@/lib/wholesale/config";
import { EMAIL_AI_SETTING_KEY, parseEmailAiSettings } from "@/lib/wholesale/email-ai-draft";
import { EMAIL_BLOCK_REASON_LABEL, EMAIL_BLOCK_REASONS, mergeEmailSettings, senderIdentityMissing, WHOLESALE_EMAIL_SETTING_KEY, type EmailMode } from "@/lib/wholesale/email-constants";
import { EMAIL_INBOUND_CURSOR_KEY, EMAIL_INBOUND_SETTING_KEY, parseEmailInboundSettings, parseInboundCursor } from "@/lib/wholesale/email-reply";
import { EMAIL_SEQUENCE_SETTING_KEY, parseEmailSequenceSettings } from "@/lib/wholesale/email-sequence";
import { parseQuotationPolicy, QUOTATION_SETTING_KEY } from "@/lib/wholesale/quotation-engine";
import { parseWholesaleReorderSettings, WHOLESALE_REORDER_SETTING_KEY } from "@/lib/wholesale/reorder";

export const B2B_PROBE_DEFAULT_ORG = "hslc-hmt-shop";
/** Số tuần gần nhất của bảng «lead tạo theo tuần». */
export const B2B_PROBE_WEEKS = 8;
/** Cửa sổ của sổ chi phí API / hoạt động / AI. */
export const B2B_PROBE_DAYS = 30;
/** Mẫu dòng mỗi nhóm in vào phần mã hoá. */
export const B2B_PROBE_SAMPLES = 10;
/** Cửa sổ của hộp thư đi / sự kiện thư / thư bị chặn. */
export const B2B_PROBE_MAIL_DAYS = 7;
/** Connector gửi + đọc thư thật duy nhất hôm nay (`LIVE_EMAIL_ADAPTERS`, E2/E3). */
export const B2B_PROBE_MAIL_CONNECTOR = "gws-smtp";
/** Trần số dòng lý do chờ / chặn kéo về để quy mã (đủ xa trần gửi cứng 1.000 thư / ngày). */
const MAIL_REASON_ROWS = 5000;
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

/**
 * Câu lý do chờ (`last_error` của thư QUEUED) / chặn (`blocked_reason`) ⇒ MÃ lý do. Đường ghi (`lib/wholesale/email-outbox.ts`) nối
 * `decision.details` bằng « · », mỗi mảnh BẮT ĐẦU bằng `EMAIL_BLOCK_REASON_LABEL[mã]` rồi tới chi tiết (có thể là tên miền / địa chỉ
 * thư) ⇒ khớp TIỀN TỐ từng mảnh, chi tiết bị bỏ. Hai câu không thuộc cổng: «Chưa gửi được ở chế độ …» (cổng cho qua nhưng chưa có nhà
 * cung cấp) ⇒ `NO_PROVIDER`; «Lần n: …» (nhà cung cấp lỗi tạm, đang lùi dần) ⇒ `PROVIDER_RETRY`. Không nhận ra ⇒ `OTHER` (đếm, không
 * đoán). HÀM THUẦN.
 */
export function mailReasonCodes(text: string | null | undefined): string[] {
  const t = String(text ?? "").trim();
  if (!t) return [];
  const segs = t.split(" · ");
  const codes: string[] = EMAIL_BLOCK_REASONS.filter((r) => segs.some((seg) => seg.startsWith(EMAIL_BLOCK_REASON_LABEL[r])));
  if (codes.length) return codes;
  if (t.startsWith("Chưa gửi được ở chế độ")) return ["NO_PROVIDER"];
  if (/^Lần \d+:/.test(t)) return ["PROVIDER_RETRY"];
  return ["OTHER"];
}

/** Đếm mã lý do trên nhiều câu (một thư nhiều lý do ⇒ mỗi mã đếm một lần). HÀM THUẦN. */
export function mailReasonCounts(texts: readonly (string | null)[]): { k: string; n: number }[] {
  const m = new Map<string, number>();
  for (const t of texts) for (const c of new Set(mailReasonCodes(t))) m.set(c, (m.get(c) ?? 0) + 1);
  return [...m].map(([k, n]) => ({ k, n }));
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
  mailConfig: Section<B2bMailConfig>;
  /** `null` = chưa có dòng kết nối. */
  mailConnection: Section<{ status: string; lastTestAt: string | null; lastTestOk: boolean | null; orgMatch: boolean } | null>;
  mailOutbox: Section<KN[]>;
  mailEvents: Section<KN[]>;
  mailQueue: Section<{ queued: number; withReason: number; reasons: KN[] }>;
  mailBlocked: Section<KN[]>;
};

/** Cấu hình email — CHỈ cờ / trần / mã nước / có-không. Không địa chỉ, không tên miền, không mẫu thư, không danh tính người gửi. */
export type B2bMailConfig = {
  saved: boolean;
  mode: EmailMode;
  paused: boolean;
  liveOwnerEnabled: boolean;
  limits: { perHour: number; perDay: number; perRecipientDomainPerDay: number };
  countries: string[];
  senderMissing: string[];
  blockedDomains: number;
  pausedCampaigns: number;
  inbound: { enabled: boolean; cursor: boolean; aiClassify: boolean; maxClassify: number | null; classifyCapUsd: number | null };
  aiDraft: { enabled: boolean; maxDrafts: number | null; capUsd: number | null };
  sequence: { maxFollowups: number | null; gapDays: number | null; templateVi: boolean; templateEn: boolean };
  reorderAfterDays: number | null;
  quote: { saved: boolean; maxDiscount: boolean; minMargin: boolean; tax: boolean };
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

  // ── EMAIL ── settings đọc qua ĐÚNG luật của getter (mergeSettingJson + mặc định của getter + parse của module), không JSON.parse tay.
  const mailSince = new Date(now.getTime() - B2B_PROBE_MAIL_DAYS * 86_400_000).toISOString();
  const mailConfig = await section(async () => {
    const keys = [WHOLESALE_EMAIL_SETTING_KEY, EMAIL_INBOUND_SETTING_KEY, EMAIL_INBOUND_CURSOR_KEY, EMAIL_AI_SETTING_KEY, EMAIL_SEQUENCE_SETTING_KEY, WHOLESALE_REORDER_SETTING_KEY, QUOTATION_SETTING_KEY];
    const rows = await q<{ key: string; value: string }>(db, sql`select key, value from settings where key in (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})`);
    const raw = new Map(rows.map((r) => [r.key, r.value]));
    // Giống `getSettingJson(key, fallback)`: không có dòng ⇒ fallback; có ⇒ mergeSettingJson(value, fallback).
    const read = <T>(key: string, fallback: T): T => {
      const v = raw.get(key);
      return v === undefined ? fallback : mergeSettingJson(v, fallback);
    };
    const m = mergeEmailSettings(read<unknown>(WHOLESALE_EMAIL_SETTING_KEY, null)); // = getEmailSettings
    const inbound = parseEmailInboundSettings(read<unknown>(EMAIL_INBOUND_SETTING_KEY, null)); // = getEmailInboundSettings
    const cursor = parseInboundCursor(read<unknown>(EMAIL_INBOUND_CURSOR_KEY, null)); // = readCursor của job đọc thư
    // getEmailAiSettings trộn với mặc định {enabled:false, null, null}; parse chỉ đọc ba ô ấy và ô thiếu ⇒ đúng giá trị mặc định đó, nên {} cho cùng kết quả.
    const aiDraft = parseEmailAiSettings(read<Record<string, unknown>>(EMAIL_AI_SETTING_KEY, {}));
    const seq = parseEmailSequenceSettings(read<Record<string, unknown>>(EMAIL_SEQUENCE_SETTING_KEY, {})); // = getEmailSequenceSettings
    const reorder = parseWholesaleReorderSettings(read<Record<string, unknown>>(WHOLESALE_REORDER_SETTING_KEY, {})); // = getWholesaleReorderSettings
    const quote = parseQuotationPolicy(read<Record<string, unknown>>(QUOTATION_SETTING_KEY, {})); // = loadQuotationPolicyView
    const cfg: B2bMailConfig = {
      saved: raw.has(WHOLESALE_EMAIL_SETTING_KEY),
      mode: m.mode,
      paused: m.paused,
      liveOwnerEnabled: Boolean(m.liveEnabledByUserId),
      limits: { ...m.limits },
      countries: [...m.allowedCountries],
      senderMissing: senderIdentityMissing(m.sender),
      blockedDomains: m.blockedDomains.length,
      pausedCampaigns: m.pausedCampaignIds.length,
      inbound: { enabled: inbound.enabled, cursor: cursor !== null, aiClassify: inbound.aiClassify, maxClassify: inbound.dailyMaxClassify, classifyCapUsd: inbound.dailyCostCapUsd },
      aiDraft: { enabled: aiDraft.enabled, maxDrafts: aiDraft.dailyMaxDrafts, capUsd: aiDraft.dailyCostCapUsd },
      sequence: { maxFollowups: seq.maxFollowups, gapDays: seq.gapDays, templateVi: seq.templates.vi.length > 0, templateEn: seq.templates.en.length > 0 },
      reorderAfterDays: reorder.afterDays,
      quote: { saved: raw.has(QUOTATION_SETTING_KEY), maxDiscount: quote.maxDiscountPercent !== null, minMargin: quote.minMarginPercent !== null, tax: quote.taxRatePercent !== null },
    };
    return cfg;
  });
  // Kết nối: CHỈ trạng thái + mốc kiểm + khớp mã tổ chức (điều kiện `openActiveConnection`, trừ bước giải bí mật). Không đọc cột bí mật / câu kiểm.
  const mailConnection = await section(async () => {
    const [r] = await q<{ status: string; last_test_at: Date | string | null; last_test_ok: boolean | null; org_match: boolean }>(
      db,
      sql`select status, last_test_at, last_test_ok, (org_code = ${orgCode}) as org_match from org_connections where connector_key = ${B2B_PROBE_MAIL_CONNECTOR}`,
    );
    if (!r) return null;
    const at = r.last_test_at === null ? null : `${new Date(r.last_test_at).toISOString().slice(0, 16)}Z`;
    return { status: r.status, lastTestAt: at, lastTestOk: r.last_test_ok, orgMatch: r.org_match === true };
  });
  const mailOutbox = await section(() =>
    counts(db, sql`select status || coalesce('/' || mode, '') as k, count(*)::int as n from wholesale_email_outbox where created_at >= ${mailSince}::timestamptz group by 1`),
  );
  const mailEvents = await section(() =>
    counts(
      db,
      sql`select e.kind || coalesce('/' || o.mode, '') as k, count(*)::int as n
            from wholesale_email_events e left join wholesale_email_outbox o on o.id = e.outbox_id
           where e.created_at >= ${mailSince}::timestamptz group by 1`,
    ),
  );
  // Lý do là CÂU CHỮ ⇒ kéo về rồi quy MÃ ở đây; chữ gốc không rời hàm này.
  const mailQueue = await section(async () => {
    const [c] = await q<{ n: number }>(db, sql`select count(*)::int as n from wholesale_email_outbox where status = 'QUEUED'`);
    const texts = await q<{ t: string }>(db, sql`select last_error as t from wholesale_email_outbox where status = 'QUEUED' and coalesce(last_error, '') <> '' limit ${MAIL_REASON_ROWS}`);
    return { queued: num(c?.n), withReason: texts.length, reasons: mailReasonCounts(texts.map((r) => r.t)) };
  });
  const mailBlocked = await section(async () => {
    const texts = await q<{ t: string | null }>(db, sql`select blocked_reason as t from wholesale_email_outbox where status = 'BLOCKED' and updated_at >= ${mailSince}::timestamptz limit ${MAIL_REASON_ROWS}`);
    return mailReasonCounts(texts.map((r) => r.t));
  });

  const s: B2bProbeSummary = { config, campaigns, cells, apiUsage, leads, leadGrades, leadStatuses, leadWeeks, outreach, activities, suppressions, leadOrders, pricing, tradeTerms, ai, mailConfig, mailConnection, mailOutbox, mailEvents, mailQueue, mailBlocked };
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

  // ── EMAIL ── chỉ chế độ / cờ / trần / mã nước / số đếm / mã lý do.
  const dash = (v: number | null) => (v === null ? "—" : String(v));
  const usd = (v: number | null) => (v === null ? "—" : `US$${String(v).replace(".", ",")}`);
  add("email cấu hình", sec(s.mailConfig, (m) => [
    `chế độ ${m.mode}`,
    m.saved ? "đã lưu" : "chưa lưu (mặc định OFF)",
    `dừng khẩn ${m.paused ? "BẬT" : "tắt"}`,
    `LIVE chủ shop bật ${m.liveOwnerEnabled ? "có" : "chưa"}`,
    `trần ${m.limits.perHour}/giờ`,
    `${m.limits.perDay}/ngày`,
    `${m.limits.perRecipientDomainPerDay}/tên miền nhận/ngày`,
    `nước đã rà ${m.countries.length ? m.countries.join(",") : "(chưa nước nào)"}`,
    m.senderMissing.length ? `người gửi thiếu ${m.senderMissing.join(", ")}` : "danh tính người gửi đủ",
    `tên miền bị dừng ${m.blockedDomains}`,
    `chiến dịch bị dừng ${m.pausedCampaigns}`,
  ]));
  add(`email kết nối ${B2B_PROBE_MAIL_CONNECTOR}`, sec(s.mailConnection, (c) =>
    c === null
      ? ["chưa có kết nối"]
      : [
          `trạng thái ${c.status}`,
          `kiểm lần cuối ${c.lastTestAt ?? "chưa kiểm"}${c.lastTestOk === null ? "" : c.lastTestOk ? " ĐẠT" : " KHÔNG ĐẠT"}`,
          c.orgMatch ? "mã tổ chức khớp" : "mã tổ chức LỆCH (máy không dùng)",
          `máy dùng được ${c.status === "ACTIVE" && c.lastTestOk === true && c.orgMatch ? "có" : "không"} (chưa xét giải mã bí mật)`,
        ]));
  add("email AI", sec(s.mailConfig, (m) => [
    `đọc thư trả lời ${m.inbound.enabled ? "BẬT" : "TẮT"}`,
    `mốc UID ${m.inbound.cursor ? "có" : "chưa có"}`,
    `AI phân loại ${m.inbound.aiClassify ? "BẬT" : "TẮT"} trần ${dash(m.inbound.maxClassify)} thư/ngày ${usd(m.inbound.classifyCapUsd)}/ngày`,
    `AI soạn nháp ${m.aiDraft.enabled ? "BẬT" : "TẮT"} trần ${dash(m.aiDraft.maxDrafts)} nháp/ngày ${usd(m.aiDraft.capUsd)}/ngày`,
  ]));
  add("email chuỗi nhắc · mua lại · báo giá", sec(s.mailConfig, (m) => [
    m.sequence.maxFollowups === null || m.sequence.gapDays === null
      ? `chuỗi nhắc chưa khai (${dash(m.sequence.maxFollowups)} lần / ${dash(m.sequence.gapDays)} ngày) ⇒ không nhắc`
      : `chuỗi nhắc ${m.sequence.maxFollowups} lần cách ${m.sequence.gapDays} ngày`,
    `mẫu tĩnh vi ${m.sequence.templateVi ? "có" : "không"} · en ${m.sequence.templateEn ? "có" : "không"}`,
    m.reorderAfterDays === null ? "mua lại sỉ chưa khai ⇒ không nhắc" : `mua lại sỉ sau ${m.reorderAfterDays} ngày`,
    `chính sách báo giá ${m.quote.saved ? "đã lưu" : "chưa lưu"}`,
    `chiết khấu tối đa ${m.quote.maxDiscount ? "có" : "chưa khai"}`,
    `biên tối thiểu ${m.quote.minMargin ? "có" : "chưa khai"}`,
    `thuế + căn cứ ${m.quote.tax ? "có" : "chưa khai"}`,
  ]));
  add(`hộp thư đi tạo trong ${B2B_PROBE_MAIL_DAYS} ngày (trạng thái/chế độ)`, sec(s.mailOutbox, countsParts));
  add(`sự kiện thư ${B2B_PROBE_MAIL_DAYS} ngày (loại/chế độ)`, sec(s.mailEvents, countsParts));
  add("thư đang chờ gửi (QUEUED)", sec(s.mailQueue, (w) => [`tổng ${w.queued}`, `có lý do chờ ${w.withReason}`, ...(w.reasons.length ? countsParts(w.reasons) : [])]));
  add(`thư bị chặn ${B2B_PROBE_MAIL_DAYS} ngày theo mã`, sec(s.mailBlocked, countsParts));
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

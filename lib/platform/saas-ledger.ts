import { and, eq, gte, isNotNull, lt, ne, sql } from "drizzle-orm";
import { getDbFor, getPlatformDb, schema, type Db } from "@/db";
import { addonMonthlyVnd, parseAddonPrices, parseAddonUnits } from "@/lib/billing/addons";
import { billingStanding, mrrContribution, vnDate, type BillingStandingKind } from "@/lib/billing/rules";
import type { SessionUser } from "@/lib/auth/session";
import { connectionStatusRows } from "@/lib/connectors/service";
import { planKeyOf, type PlanRow } from "@/lib/entitlements/check";
import { platformAudit } from "@/lib/platform/audit";
import { KILL_SWITCH_REASON_MIN } from "@/lib/platform/kill-switches";
import { getHomeOrganization, listOrganizations } from "@/lib/platform/organizations";
import { plansForOrg } from "@/lib/pricing/price-book";
import type { Organization } from "@/lib/platform/types";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import { ORDER_OUTCOME, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { HISTORY_CREATED_BY } from "@/lib/sales-chatbot/history-shared";
import { rowsOf } from "@/lib/sql-rows";
import {
  ACTIVATION_MILESTONES,
  CHANNEL_CONNECTOR_KEYS,
  MILESTONE_SPECS,
  parseCostDeclaration,
  type ActivationMilestone,
  type AiCost,
  type PlatformCostDeclaration,
  type SaasDailyRow,
  type UsageDayRow,
} from "@/lib/platform/saas-metrics";

/**
 * ═══════════ SỔ KINH TẾ SAAS — ĐƯỜNG ĐỌC / GHI DUY NHẤT (0203 · docs/productization/11_SAAS_METRICS_SPEC.md) ═══════════
 *
 * Mặt phẳng điều khiển (CSDL NHÀ). Ba việc:
 *  1. `captureSaasSnapshot` — ảnh chụp MRR của HÔM NAY (giờ VN) cho mọi tổ chức, cùng công thức với bảng thu phí
 *     (`mrrContribution`). Chỉ ghi ngày hôm nay — ngày đã qua là đóng băng, mã này không có đường nào ghi ngày cũ.
 *  2. Quét mốc kích hoạt còn thiếu của tổ chức khách ACTIVE: mở CSDL tổ chức (`getDbFor`) để lấy min thời điểm của
 *     chứng từ có thật. CHỈ đọc số đếm / mốc — không đọc nội dung hội thoại, tên, SĐT. Ghi một lần (`DO NOTHING`).
 *  3. Khai chi phí nền tảng (hạ tầng / hỗ trợ) — người vận hành, bắt buộc lý do, nhật ký nền tảng.
 * Lỗi của MỘT tổ chức không làm hỏng ảnh chụp của tổ chức khác — được trả về trong `errors`.
 */

export const PLATFORM_COSTS_KEY = "platform.economics.costs";

function snapshotRow(org: Organization, plans: PlanRow[], sub: { billingEnabled: boolean; paidThrough: string | null; graceDays: number; addons: unknown } | undefined, day: string): SaasDailyRow & { mrrNote: string | null } {
  const planKey = planKeyOf(org);
  const plan = plans.find((p) => p.key === planKey);
  const terms = sub ? { billingEnabled: sub.billingEnabled, paidThrough: sub.paidThrough, graceDays: sub.graceDays } : null;
  const standing = billingStanding(terms, day).kind;
  const monthly = addonMonthlyVnd(parseAddonUnits(sub?.addons), parseAddonPrices(plan?.addonPrices));
  const c = mrrContribution({ isHome: org.isHome, orgStatus: org.status, standing, planPriceVnd: plan?.priceVnd ?? null, addonMonthly: monthly });
  return { day, orgCode: org.code, orgStatus: org.status, isHome: org.isHome, planKey, billingEnabled: sub?.billingEnabled ?? false, standing, paying: c.paying, mrrVnd: c.mrrVnd, mrrNote: c.note };
}

export type SnapshotResult = { day: string; orgs: number; mrrVnd: number; milestonesAdded: number; usageRows: number; errors: string[] };

export async function captureSaasSnapshot(now: Date = new Date()): Promise<SnapshotResult> {
  const day = vnDate(now);
  const orgs = await listOrganizations();
  const pdb = await getPlatformDb();
  const subs = new Map((await pdb.select().from(schema.platformSubscriptions)).map((s) => [s.orgCode, { billingEnabled: s.billingEnabled, paidThrough: s.paidThrough ?? null, graceDays: s.graceDays, addons: s.addons }]));
  // Giá của MỖI tổ chức theo phiên bản giá đã ghim (0228) — MRR là số khách thật trả, không phải giá niêm yết hôm nay.
  const live = orgs.filter((o) => o.status !== "SETUP_FAILED");
  const rows: (SaasDailyRow & { mrrNote: string | null })[] = [];
  const errors: string[] = [];
  for (const o of live) {
    // Không đọc được sổ giá / ghim ⇒ BỎ dòng của tổ chức này hôm nay (lượt sau chụp lại) — ghi 0 / "không trả tiền" là bịa (luật 42).
    const plans = await plansForOrg(o.code, now).catch((e: unknown) => {
      errors.push(`${o.code}: không đọc được bảng giá — bỏ qua ảnh chụp MRR hôm nay (${e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120)})`);
      return null;
    });
    if (plans) rows.push(snapshotRow(o, plans, subs.get(o.code), day));
  }
  const t = schema.platformSaasDaily;
  for (const r of rows) {
    const values = { day: r.day, orgCode: r.orgCode, orgStatus: r.orgStatus, isHome: r.isHome, planKey: r.planKey, billingEnabled: r.billingEnabled, standing: r.standing, paying: r.paying, mrrVnd: r.mrrVnd, mrrNote: r.mrrNote, capturedAt: now };
    // Khoá (day, org): chỉ có thể trùng với dòng CỦA HÔM NAY — ảnh chụp cuối ngày thắng. Ngày cũ không bao giờ được ghi.
    await pdb.insert(t).values(values).onConflictDoUpdate({ target: [t.day, t.orgCode], set: { ...values } });
  }
  const milestonesAdded = await scanMilestones(orgs, errors);
  const usageRows = await captureUsage(orgs, now, errors);
  return { day, orgs: rows.length, mrrVnd: rows.reduce((s, r) => s + (r.mrrVnd ?? 0), 0), milestonesAdded, usageRows, errors };
}

// ─────────────────────────── Sổ dùng theo ngày (0204) ───────────────────────────

export type OrgUsage = { conversationsStarted: number; customerMessages: number; botMessages: number; aiActiveConversations: number; aiOrders: number };

/**
 * Số dùng của MỘT tổ chức trong [from, to) — đọc CSDL của tổ chức đó. Kênh THỬ (khung thử · phát lại · copilot) không bao giờ
 * tính. Tin khách = khối chữ của khách (không tính kết quả công cụ); tin bot = tin của bot, không tính tin page chép vào lịch
 * sử («[Shop đã nhắn] …»). Câu SQL là hằng — không nhận tên bảng từ đầu vào.
 */
export async function readOrgUsage(db: Db, from: Date, to: Date): Promise<OrgUsage> {
  const [r] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      with conv as (select id, created_by from sales_chat_conversations where channel <> 'TEST'),
      msg as (
        select m.conversation_id, m.role, m.content
        from sales_chat_messages m join conv on conv.id = m.conversation_id
        where m.created_at >= ${from} and m.created_at < ${to} and m.content->0->>'type' = 'text'
          -- Lời chào mặc định của hội thoại do LƯỢT NHẬP LỊCH SỬ tạo (lib/sales-chatbot/history.ts) không phải tin bot gửi ai.
          and not (m.seq = 1 and coalesce(conv.created_by, '') = ${HISTORY_CREATED_BY})
      )
      select
        (select count(*) from sales_chat_conversations where channel <> 'TEST' and coalesce(created_by, '') <> ${HISTORY_CREATED_BY} and created_at >= ${from} and created_at < ${to})::int as started,
        (select count(*) from msg where role = 'user')::int as customer,
        (select count(*) from msg where role = 'assistant' and coalesce(content->0->>'text', '') not like '[Shop đã nhắn]%')::int as bot,
        (select count(distinct conversation_id) from msg where role = 'assistant' and coalesce(content->0->>'text', '') not like '[Shop đã nhắn]%')::int as active,
        (select count(*) from orders o join sales_chat_conversations c on c.order_id = o.id where c.channel <> 'TEST' and o.created_at >= ${from} and o.created_at < ${to})::int as ai_orders
    `),
  );
  const n = (k: string) => Number(r?.[k] ?? 0);
  return { conversationsStarted: n("started"), customerMessages: n("customer"), botMessages: n("bot"), aiActiveConversations: n("active"), aiOrders: n("ai_orders") };
}

/**
 * Fanpage đang hoạt động: dòng `org_channel_pages` ACTIVE · PAGE. Không có dòng nào mà tổ chức vẫn có kết nối kênh đang bật
 * (nối trước 0220 bằng một hàng kết nối đơn) ⇒ `null` — chưa đếm được, KHÔNG phải 0 fanpage.
 */
export async function readFanpagesActive(db: Db): Promise<number | null> {
  const [r] = rowsOf<{ pages: number; legacy: number }>(
    await db.execute(sql`
      select
        (select count(*) from org_channel_pages where status = 'ACTIVE' and kind = 'PAGE')::int as pages,
        (select count(*) from org_connections where status = 'ACTIVE' and connector_key in (${sql.join(
          CHANNEL_CONNECTOR_KEYS.map((k) => sql`${k}`),
          sql`, `,
        )}))::int as legacy
    `),
  );
  const pages = Number(r?.pages ?? 0);
  if (pages > 0) return pages;
  return Number(r?.legacy ?? 0) > 0 ? null : 0;
}

/** [đầu ngày, đầu ngày hôm sau) của ngày `YYYY-MM-DD` giờ Việt Nam, ở UTC. */
function vnDayRange(day: string): { from: Date; to: Date } {
  const from = new Date(`${day}T00:00:00+07:00`);
  return { from, to: new Date(from.getTime() + 86_400_000) };
}

async function captureUsage(orgs: Organization[], now: Date, errors: string[]): Promise<number> {
  const pdb = await getPlatformDb();
  const u = schema.platformTenantUsageDaily;
  const today = vnDate(now);
  const yesterday = vnDate(new Date(now.getTime() - 86_400_000));
  let written = 0;
  for (const org of orgs) {
    if (org.status !== "ACTIVE") continue;
    try {
      const db = await getDbFor(org);
      // Fanpage đang hoạt động là số TỨC THỜI (0222): chỉ ghi vào dòng HÔM NAY; dòng hôm qua giữ số đã chụp hôm qua.
      // Đọc hỏng ⇒ NULL (chưa đo), không làm hỏng các số đếm khác của tổ chức.
      const fanpagesActive = await readFanpagesActive(db).catch(() => null);
      // Hôm qua + hôm nay — tin tới muộn của hôm qua vẫn vào; ngày cũ hơn không bao giờ được tính lại.
      for (const day of [yesterday, today]) {
        const { from, to } = vnDayRange(day);
        const usage = await readOrgUsage(db, from, to);
        const values = { day, orgCode: org.code, ...usage, capturedAt: now, ...(day === today ? { fanpagesActive } : {}) };
        await pdb.insert(u).values(values).onConflictDoUpdate({ target: [u.day, u.orgCode], set: { ...values } });
        written += 1;
      }
    } catch (e) {
      errors.push(`[${org.code}] sổ dùng: ${e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160)}`);
    }
  }
  return written;
}

export type UsageTotals = OrgUsage & { days: number };

/** Tổng sổ dùng theo tổ chức từ ngày `fromDay` (tính cả hai đầu). Ngày chưa có dòng KHÔNG được coi là 0 — `days` nói đã có bao nhiêu ngày. */
export async function readUsageTotals(fromDay: string): Promise<Map<string, UsageTotals>> {
  const pdb = await getPlatformDb();
  const u = schema.platformTenantUsageDaily;
  const rows = await pdb
    .select({
      orgCode: u.orgCode,
      days: sql<number>`count(*)::int`,
      conversationsStarted: sql<number>`coalesce(sum(${u.conversationsStarted}), 0)::int`,
      customerMessages: sql<number>`coalesce(sum(${u.customerMessages}), 0)::int`,
      botMessages: sql<number>`coalesce(sum(${u.botMessages}), 0)::int`,
      aiActiveConversations: sql<number>`coalesce(sum(${u.aiActiveConversations}), 0)::int`,
      aiOrders: sql<number>`coalesce(sum(${u.aiOrders}), 0)::int`,
    })
    .from(u)
    .where(gte(u.day, fromDay))
    .groupBy(u.orgCode);
  return new Map(rows.map((r) => [r.orgCode, { days: Number(r.days), conversationsStarted: Number(r.conversationsStarted), customerMessages: Number(r.customerMessages), botMessages: Number(r.botMessages), aiActiveConversations: Number(r.aiActiveConversations), aiOrders: Number(r.aiOrders) }]));
}

/** Min thời điểm, bỏ qua giá trị không đọc được. */
function minDate(values: readonly (Date | string | null | undefined)[]): Date | null {
  let best: Date | null = null;
  for (const v of values) {
    if (!v) continue;
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) continue;
    if (!best || d < best) best = d;
  }
  return best;
}

async function firstAt(db: Db, query: ReturnType<typeof sql>): Promise<Date | null> {
  const [row] = rowsOf<{ at: Date | string | null }>(await db.execute(query));
  return minDate([row?.at ?? null]);
}

/**
 * Mốc của MỘT tổ chức trong CSDL của nó. Chỉ những mốc được hỏi (`want`). Câu SQL là hằng — tên bảng / cột không đến từ
 * đầu vào. Bảng chưa có (tổ chức chưa migrate tới) ⇒ ném, người gọi ghi lỗi cho tổ chức đó.
 */
export async function readOrgMilestones(db: Db, want: ReadonlySet<ActivationMilestone>): Promise<Partial<Record<ActivationMilestone, Date>>> {
  const out: Partial<Record<ActivationMilestone, Date>> = {};
  if (want.has("CHANNEL_CONNECTED")) {
    const keys = new Set<string>(CHANNEL_CONNECTOR_KEYS);
    const at = minDate((await connectionStatusRows(db)).filter((c) => keys.has(c.connectorKey) && c.status === "ACTIVE").map((c) => c.activatedAt ?? c.updatedAt));
    if (at) out.CHANNEL_CONNECTED = at;
  }
  const q: Partial<Record<ActivationMilestone, ReturnType<typeof sql>>> = {
    CATALOG_IMPORTED: sql`select min(created_at) as at from products`,
    // Hội thoại do lượt nhập lịch sử tạo là khách CŨ của page, không phải lần đầu khách tới qua sản phẩm.
    FIRST_CONVERSATION: sql`select min(created_at) as at from sales_chat_conversations where channel <> 'TEST' and coalesce(created_by, '') <> ${HISTORY_CREATED_BY}`,
    FIRST_AI_REPLY: sql`select min(created_at) as at from sales_chat_conversations where channel <> 'TEST' and ai_calls > 0`,
    FIRST_AI_ORDER: sql`select min(o.created_at) as at from orders o join sales_chat_conversations c on c.order_id = o.id where c.channel <> 'TEST'`,
  };
  for (const [m, query] of Object.entries(q) as [ActivationMilestone, ReturnType<typeof sql>][]) {
    if (!want.has(m)) continue;
    const at = await firstAt(db, query);
    if (at) out[m] = at;
  }
  if (want.has("FIRST_DELIVERED_AI_ORDER")) {
    // Kết cục đơn = ORDER_OUTCOME — MỘT công thức cho mọi báo cáo (AGENTS §0.2), không viết lại điều kiện giao thành công.
    const o = schema.orders;
    const s = schema.shipments;
    const c = schema.salesChatConversations;
    const [r] = await db
      .select({ at: sql<Date | string | null>`min(${o.createdAt})` })
      .from(o)
      .innerJoin(c, eq(c.orderId, o.id))
      .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
      .where(and(ne(c.channel, "TEST"), sql`${ORDER_OUTCOME} = 'DELIVERED'`));
    const at = minDate([r?.at ?? null]);
    if (at) out.FIRST_DELIVERED_AI_ORDER = at;
  }
  return out;
}

async function scanMilestones(orgs: Organization[], errors: string[]): Promise<number> {
  const pdb = await getPlatformDb();
  const m = schema.platformOrgMilestones;
  const have = new Map<string, Set<string>>();
  for (const r of await pdb.select({ orgCode: m.orgCode, milestone: m.milestone }).from(m)) {
    if (!have.has(r.orgCode)) have.set(r.orgCode, new Set());
    have.get(r.orgCode)!.add(r.milestone);
  }
  // Ngày tạo tổ chức đọc thẳng sổ tổ chức (kiểu `Organization` đệm trong bộ nhớ không mang nó).
  const createdAt = new Map((await pdb.select({ code: schema.platformOrganizations.code, at: schema.platformOrganizations.createdAt }).from(schema.platformOrganizations)).map((r) => [r.code, r.at]));
  let added = 0;
  for (const org of orgs) {
    if (org.isHome || org.status !== "ACTIVE") continue;
    const got = have.get(org.code) ?? new Set<string>();
    const rows: { orgCode: string; milestone: string; reachedAt: Date; source: string }[] = [];
    const signedUp = createdAt.get(org.code);
    if (!got.has("SIGNED_UP") && signedUp) rows.push({ orgCode: org.code, milestone: "SIGNED_UP", reachedAt: signedUp, source: MILESTONE_SPECS.SIGNED_UP.source });
    const want = new Set(ACTIVATION_MILESTONES.filter((k) => k !== "SIGNED_UP" && MILESTONE_SPECS[k].availability === "MEASURED" && !got.has(k)));
    if (want.size) {
      try {
        const found = await readOrgMilestones(await getDbFor(org), want);
        for (const [k, at] of Object.entries(found) as [ActivationMilestone, Date][]) rows.push({ orgCode: org.code, milestone: k, reachedAt: at, source: MILESTONE_SPECS[k].source });
      } catch (e) {
        errors.push(`[${org.code}] mốc kích hoạt: ${e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160)}`);
      }
    }
    if (rows.length) {
      const r = await pdb.insert(m).values(rows).onConflictDoNothing().returning({ k: m.milestone });
      added += r.length;
    }
  }
  return added;
}

// ─────────────────────────── Đọc ───────────────────────────

export async function readSaasDaily(fromDay: string): Promise<SaasDailyRow[]> {
  const pdb = await getPlatformDb();
  const t = schema.platformSaasDaily;
  const rows = await pdb.select().from(t).where(gte(t.day, fromDay)).orderBy(t.day);
  return rows.map((r) => ({ day: r.day, orgCode: r.orgCode, orgStatus: r.orgStatus, isHome: r.isHome, planKey: r.planKey, billingEnabled: r.billingEnabled, standing: r.standing as BillingStandingKind, paying: r.paying, mrrVnd: r.mrrVnd }));
}

export async function readFirstSnapshotDay(): Promise<string | null> {
  const pdb = await getPlatformDb();
  const [r] = await pdb.select({ d: sql<string | null>`min(${schema.platformSaasDaily.day})::text` }).from(schema.platformSaasDaily);
  return r?.d ?? null;
}

export async function readMilestones(): Promise<Map<string, Partial<Record<ActivationMilestone, Date>>>> {
  const pdb = await getPlatformDb();
  const out = new Map<string, Partial<Record<ActivationMilestone, Date>>>();
  for (const r of await pdb.select().from(schema.platformOrgMilestones)) {
    if (!(ACTIVATION_MILESTONES as readonly string[]).includes(r.milestone)) continue;
    if (!out.has(r.orgCode)) out.set(r.orgCode, {});
    out.get(r.orgCode)![r.milestone as ActivationMilestone] = r.reachedAt;
  }
  return out;
}

/** Tổ chức có ít nhất một hoá đơn ĐÃ THU — sự thật bất biến, phân biệt dùng thử với đã rời. */
export async function readEverPaidOrgs(): Promise<Set<string>> {
  const pdb = await getPlatformDb();
  const i = schema.platformInvoices;
  const rows = await pdb.selectDistinct({ orgCode: i.orgCode }).from(i).where(eq(i.status, "PAID"));
  return new Set(rows.map((r) => r.orgCode));
}

export type AiUsageByOrg = { platform: AiCost; byok: AiCost; home: AiCost; errors: number; requests: number };

const zeroCost = (): AiCost => ({ costUsd: 0, requests: 0, unpricedRequests: 0 });

/** Sổ AI theo tổ chức trong [from, to) — tiền chưa định giá đếm riêng, không bao giờ coi là 0 đồng. */
export async function readAiUsageByOrg(from: Date, to: Date): Promise<Map<string, AiUsageByOrg>> {
  const pdb = await getPlatformDb();
  const a = schema.platformAiUsage;
  const rows = await pdb
    .select({
      orgCode: a.orgCode,
      source: a.billingSource,
      requests: sql<number>`coalesce(sum(${a.requests}), 0)::int`,
      costUsd: sql<number>`coalesce(sum(${a.costUsd}), 0)::float8`,
      unpriced: sql<number>`coalesce(sum(${a.requests}) filter (where ${a.costUsd} is null and ${a.status} = 'OK'), 0)::int`,
      errors: sql<number>`coalesce(sum(${a.requests}) filter (where ${a.status} = 'ERROR'), 0)::int`,
    })
    .from(a)
    .where(and(gte(a.at, from), lt(a.at, to)))
    .groupBy(a.orgCode, a.billingSource);
  const out = new Map<string, AiUsageByOrg>();
  for (const r of rows) {
    if (!out.has(r.orgCode)) out.set(r.orgCode, { platform: zeroCost(), byok: zeroCost(), home: zeroCost(), errors: 0, requests: 0 });
    const o = out.get(r.orgCode)!;
    const bucket = r.source === "PLATFORM" ? o.platform : r.source === "BYOK" ? o.byok : o.home;
    bucket.costUsd += Number(r.costUsd);
    bucket.requests += Number(r.requests);
    bucket.unpricedRequests += Number(r.unpriced);
    o.errors += Number(r.errors);
    o.requests += Number(r.requests);
  }
  return out;
}

/** Lần đăng nhập gần nhất theo tổ chức (chỉ mục danh tính — chỉ mốc, không ai). */
export async function readLastLoginByOrg(): Promise<Map<string, Date>> {
  const pdb = await getPlatformDb();
  const p = schema.platformIdentities;
  const rows = await pdb.select({ orgCode: p.orgCode, at: sql<Date | string | null>`max(${p.lastUsedAt})` }).from(p).where(isNotNull(p.lastUsedAt)).groupBy(p.orgCode);
  const out = new Map<string, Date>();
  for (const r of rows) {
    const d = minDate([r.at]);
    if (d) out.set(r.orgCode, d);
  }
  return out;
}

// ─────────────────────────── Chi phí nền tảng chủ shop khai ───────────────────────────

export async function readCostDeclaration(): Promise<PlatformCostDeclaration> {
  const pdb = await getPlatformDb();
  const row = await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, PLATFORM_COSTS_KEY) });
  return parseCostDeclaration(row?.value);
}

/** Trần một khoản khai / tháng — chặn gõ thừa số 0, không phải luật kinh doanh. */
export const PLATFORM_COST_MAX_VND = 2_000_000_000;

function moneyInput(raw: unknown): number | null | { error: string } {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(typeof raw === "string" ? raw.replace(/[.\s,₫]/g, "") : raw);
  if (!Number.isInteger(n) || n < 0 || n > PLATFORM_COST_MAX_VND) return { error: `Số tiền phải là số nguyên VND từ 0 tới ${PLATFORM_COST_MAX_VND.toLocaleString("vi-VN")}.` };
  return n;
}

export async function setPlatformCostDeclaration(user: SessionUser, raw: { infraMonthlyVnd?: unknown; supportMonthlyVnd?: unknown; reason?: unknown }): Promise<{ ok: true; message: string } | { error: string }> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const reason = typeof raw.reason === "string" ? raw.reason.trim().slice(0, 500) : "";
  if (reason.length < KILL_SWITCH_REASON_MIN) return { error: `Ghi căn cứ của con số (ít nhất ${KILL_SWITCH_REASON_MIN} ký tự) — nó vào nhật ký nền tảng.` };
  const infra = moneyInput(raw.infraMonthlyVnd);
  if (infra !== null && typeof infra === "object") return infra;
  const support = moneyInput(raw.supportMonthlyVnd);
  if (support !== null && typeof support === "object") return support;
  const before = await readCostDeclaration();
  const next = { infraMonthlyVnd: infra, supportMonthlyVnd: support, reason, updatedAt: new Date().toISOString(), updatedByEmail: user.email };
  const pdb = await getPlatformDb();
  const set = { value: next, updatedAt: new Date(), updatedBy: `${user.organization?.code ?? ""}:${user.id}`, updatedByEmail: user.email };
  await pdb.insert(schema.platformSettings).values({ key: PLATFORM_COSTS_KEY, ...set }).onConflictDoUpdate({ target: schema.platformSettings.key, set });
  const home = await getHomeOrganization();
  await platformAudit({
    action: "PLATFORM_COSTS_SET",
    targetOrgCode: home.code,
    subject: PLATFORM_COSTS_KEY,
    before: { infraMonthlyVnd: before.infraMonthlyVnd, supportMonthlyVnd: before.supportMonthlyVnd },
    after: { infraMonthlyVnd: infra, supportMonthlyVnd: support },
    reason,
    source: "UI",
    actor: user.organization ? { orgCode: user.organization.code, userId: user.id, email: user.email } : null,
  });
  return { ok: true, message: "Đã lưu chi phí nền tảng — biên lợi nhuận tính lại ngay." };
}

/** Một ngày của sổ dùng: phần xu hướng của cockpit + tin khách / tin bot / fanpage lúc chụp / mốc chụp (màn sức khoẻ khách). */
export type UsageDayDetail = UsageDayRow & { customerMessages: number; botMessages: number; fanpagesActive: number | null; capturedAt: Date };

/**
 * Dòng sổ dùng theo ngày từ `fromDay`, gom theo tổ chức, cũ trước — MỘT câu cho xu hướng tuần của cockpit và sức khoẻ khách
 * (`lib/saas/customer-signals.ts`). Ngày VẮNG = chưa chụp (chưa đo), không phải 0. `fanpagesActive` `NULL` = chưa đếm được.
 */
export async function readUsageDaily(fromDay: string): Promise<Map<string, UsageDayDetail[]>> {
  const pdb = await getPlatformDb();
  const u = schema.platformTenantUsageDaily;
  const rows = await pdb
    .select({ orgCode: u.orgCode, day: u.day, conversationsStarted: u.conversationsStarted, aiOrders: u.aiOrders, customerMessages: u.customerMessages, botMessages: u.botMessages, fanpagesActive: u.fanpagesActive, capturedAt: u.capturedAt })
    .from(u)
    .where(gte(u.day, fromDay))
    .orderBy(u.day);
  const out = new Map<string, UsageDayDetail[]>();
  for (const r of rows) {
    if (!out.has(r.orgCode)) out.set(r.orgCode, []);
    out.get(r.orgCode)!.push({ day: r.day, conversationsStarted: r.conversationsStarted, aiOrders: r.aiOrders, customerMessages: r.customerMessages, botMessages: r.botMessages, fanpagesActive: r.fanpagesActive, capturedAt: r.capturedAt });
  }
  return out;
}

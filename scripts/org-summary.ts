/*
  ops `org-summary` — MỘT TỔ CHỨC KHÁCH ĐANG Ở ĐÂU, BẰNG SỐ ĐẾM (CHỈ ĐỌC).

  Vì sao có (03–04/10/2026): HSLC báo «đã xong» phần tự cấu hình (module · phí giao · kết nối Meta · giá vốn) mà agent
  không kiểm được — `db-query` chỉ mở CSDL nhà. Script này mở CSDL CỦA MỘT TỔ CHỨC bằng `getDbForInspection` (máy chủ ép
  chỉ đọc, không migrate, không tạo CSDL) và in: module đang bật, công tắc chatbot / ghi đơn từ hội thoại, phí giao, kết
  nối (trạng thái + lần kiểm gần nhất, KHÔNG bao giờ bí mật), đơn 30 ngày theo trạng thái / kênh / kết quả, chi tiêu
  quảng cáo + lượt đồng bộ, giá vốn của mẫu mã, chi phí, hội thoại chatbot.

  KHÔNG đọc cột nào mang dữ liệu của NGƯỜI (tên, SĐT, địa chỉ, ghi chú, nội dung tin nhắn) — chỉ số đếm, tổng tiền, trạng
  thái, mốc. Cả lượt chạy trong `ma_hoa_ket_qua`; dòng mang tiền tố "[ops:tom-tat] " ra log công khai.

  CHỈ ĐỌC do Postgres ép (`ERP_READ_ONLY=1` trước lần mở kết nối đầu tiên); `main` hỏi lại rồi dừng nếu không phải.

  arg: `<mã tổ chức>`; rỗng ⇒ in danh sách tổ chức (mã · tên · trạng thái) để chọn.
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("org-summary.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { and, eq, gte, sql } from "drizzle-orm";
import { getDbForInspection, schema, type Db } from "@/db";
import { getEnabledModules } from "@/lib/platform/capabilities";
import { findOrganization, listOrganizations } from "@/lib/platform/organizations";
import { ORDER_OUTCOME, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s}`);

/** Trần của kênh tóm tắt (cùng số với các script tóm tắt khác). */
export const SUMMARY_MAX_LINES = 60;
export const SUMMARY_MAX_CHARS = 300;
export const ORG_SUMMARY_DAYS = 30;

/** Một mục đọc được (`ok`) hoặc không (`reason`) — mục hỏng in `—` KÈM lý do, không bao giờ 0 (luật 42). */
export type Muc<T> = { ok: true; value: T } | { ok: false; reason: string };
type Count = { key: string; n: number; amount?: number | null };

export type OrgSummary = {
  org: { code: string; name: string; status: string; isHome: boolean };
  modules: Muc<string[]>;
  settings: Muc<{ chatbotEnabled: boolean | null; orderSyncEnabled: boolean | null; orderSyncSince: string | null; deliveryFee: number | null; receiptPricing: string | null }>;
  connections: Muc<{ key: string; status: string; lastTestOk: boolean | null; lastTestAt: string | null; adAccounts: number | null }[]>;
  ordersByStage: Muc<Count[]>;
  ordersBySource: Muc<Count[]>;
  outcomes: Muc<Count[]>;
  delivery: Muc<{ deliveredNotes: number; withFee: number; feeSum: number; returnedManual: number; payments: number; paymentSum: number }>;
  ads: Muc<{ rows: number; auto: number; spend: number; lastDate: string | null; accounts: number }>;
  syncRuns: Muc<{ job: string; status: string; at: string | null }[]>;
  costs: Muc<{ variants: number; withReceiptCost: number; withManualCost: number }>;
  expenses: Muc<Count[]>;
  chat: Muc<{ conversations: number; handoff: number; inbound24h: number; syncOutcomes: Count[] }>;
};

/** Số in ra: `null` / NaN ⇒ `—` (CHƯA BIẾT), 0 thật ⇒ `0` (luật 42). */
export function dem(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("vi-VN") : "—";
}

function muc<T>(m: Muc<T>, f: (v: T) => string): string {
  return m.ok ? f(m.value) : `— (không đọc được: ${m.reason.slice(0, 120)})`;
}

const counts = (xs: readonly Count[], money = false) => (xs.length ? xs.map((x) => `${x.key || "(trống)"} ${dem(x.n)}${money && x.amount != null ? ` · ${dem(x.amount)} ₫` : ""}`).join(" · ") : "0");

/** Các dòng tóm tắt — HÀM THUẦN, mỗi dòng ≤ SUMMARY_MAX_CHARS, cả lượt ≤ SUMMARY_MAX_LINES. */
export function orgSummaryLines(s: OrgSummary): string[] {
  const d = ORG_SUMMARY_DAYS;
  const lines = [
    `Tổ chức ${s.org.code} «${s.org.name}» · ${s.org.status}${s.org.isHome ? " · NHÀ" : ""}`,
    `Module bật: ${muc(s.modules, (m) => m.join(", ") || "(không)")}`,
    `Module cần cho báo cáo: ${muc(s.modules, (m) => ["finance", "marketing", "returns", "ai_sales"].map((k) => `${k} ${m.includes(k) ? "BẬT" : "TẮT"}`).join(" · "))}`,
    `Cấu hình: ${muc(s.settings, (v) => `chatbot ${v.chatbotEnabled === null ? "—" : v.chatbotEnabled ? "BẬT" : "TẮT"} · ghi đơn từ hội thoại ${v.orderSyncEnabled === null ? "—" : v.orderSyncEnabled ? `BẬT từ ${v.orderSyncSince ?? "—"}` : "TẮT"} · phí giao ${v.deliveryFee === null ? "chưa khai" : `${dem(v.deliveryFee)} ₫`} · định giá phiếu nhập ${v.receiptPricing ?? "mặc định"}`)}`,
    `Kết nối: ${muc(s.connections, (cs) => (cs.length ? cs.map((c) => `${c.key} ${c.status}${c.lastTestOk === null ? "" : c.lastTestOk ? " ✓kiểm" : " ✗kiểm"}${c.lastTestAt ? ` ${c.lastTestAt}` : ""}${c.adAccounts !== null ? ` · ${c.adAccounts} TKQC` : ""}`).join(" | ") : "(chưa có)"))}`,
    `Đơn ${d} ngày theo trạng thái: ${muc(s.ordersByStage, (x) => counts(x, true))}`,
    `Đơn ${d} ngày theo kênh: ${muc(s.ordersBySource, (x) => counts(x))}`,
    `Kết quả đơn ${d} ngày (ORDER_OUTCOME): ${muc(s.outcomes, (x) => counts(x, true))}`,
    `Giao hàng: ${muc(s.delivery, (v) => `phiếu giao còn hiệu lực ${dem(v.deliveredNotes)} · có phí giao ${dem(v.withFee)} (Σ ${dem(v.feeSum)} ₫) · đơn tay giao không thành công ${dem(v.returnedManual)} · phiếu thu ${dem(v.payments)} (Σ ${dem(v.paymentSum)} ₫)`)}`,
    `Quảng cáo ${d} ngày: ${muc(s.ads, (v) => `${dem(v.rows)} dòng (${dem(v.auto)} tự động) · ${dem(v.accounts)} TKQC · chi ${dem(v.spend)} ₫ · ngày mới nhất ${v.lastDate ?? "—"}`)}`,
    `Lượt đồng bộ gần nhất: ${muc(s.syncRuns, (rs) => (rs.length ? rs.map((r) => `${r.job} ${r.status} ${r.at ?? "—"}`).join(" | ") : "(chưa có)"))}`,
    `Giá vốn: ${muc(s.costs, (v) => `${dem(v.variants)} mẫu mã đang bán · ${dem(v.withReceiptCost)} có đơn giá phiếu nhập · ${dem(v.withManualCost)} có giá vốn khai tay`)}`,
    `Chi phí ${d} ngày: ${muc(s.expenses, (x) => counts(x, true))}`,
    `Chatbot: ${muc(s.chat, (v) => `${dem(v.conversations)} hội thoại · ${dem(v.handoff)} cần người · ${dem(v.inbound24h)} tin khách 24 giờ · ghi đơn: ${counts(v.syncOutcomes)}`)}`,
  ];
  return lines.slice(0, SUMMARY_MAX_LINES).map((l) => (l.length > SUMMARY_MAX_CHARS ? `${l.slice(0, SUMMARY_MAX_CHARS - 1)}…` : l));
}

async function doc<T>(f: () => Promise<T>): Promise<Muc<T>> {
  try {
    return { ok: true, value: await f() };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  }
}

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const iso = (v: unknown) => (v ? new Date(v as string).toISOString().slice(0, 16).replace("T", " ") : null);

/** Đọc mọi mục của MỘT tổ chức trên handle CHỈ ĐỌC `db` (chỉ cột không mang dữ liệu người). */
export async function collectOrgSummary(org: OrgSummary["org"], db: Db, now: Date = new Date()): Promise<OrgSummary> {
  const since = new Date(now.getTime() - ORG_SUMMARY_DAYS * 86_400_000);
  const o = schema.orders;
  const setting = async (key: string): Promise<unknown> => {
    const [r] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, key)).limit(1);
    if (!r?.value) return null;
    try {
      return JSON.parse(r.value) as unknown;
    } catch {
      return null;
    }
  };
  return {
    org,
    modules: await doc(async () => [...(await getEnabledModules(org.code))].sort()),
    settings: await doc(async () => {
      const bot = (await setting("ai.salesChatbot")) as { enabled?: unknown } | null;
      const sync = (await setting("ai.salesOrderSync")) as { enabled?: unknown; enabledAt?: unknown } | null;
      const fee = await setting("orders.manualDeliveryFee");
      const pricing = await setting("inventory.receiptPricing");
      return {
        chatbotEnabled: bot ? bot.enabled === true : null,
        orderSyncEnabled: sync ? sync.enabled === true : null,
        orderSyncSince: sync && typeof sync.enabledAt === "string" ? iso(sync.enabledAt) : null,
        deliveryFee: typeof fee === "number" ? fee : null,
        receiptPricing: typeof pricing === "string" ? pricing : pricing && typeof pricing === "object" ? JSON.stringify(pricing).slice(0, 40) : null,
      };
    }),
    connections: await doc(async () => {
      const c = schema.orgConnections;
      const rows = await db.select({ key: c.connectorKey, status: c.status, lastTestOk: c.lastTestOk, lastTestAt: c.lastTestAt, settings: c.settings }).from(c);
      return rows.map((r) => {
        const ids = (r.settings as Record<string, unknown> | null)?.adAccountIds;
        return { key: r.key, status: r.status, lastTestOk: r.lastTestOk, lastTestAt: iso(r.lastTestAt), adAccounts: typeof ids === "string" ? ids.split(/[,\s]+/).filter(Boolean).length : Array.isArray(ids) ? ids.length : null };
      });
    }),
    ordersByStage: await doc(async () =>
      (await db.select({ key: o.stage, n: sql<number>`count(*)::int`, amount: sql<number>`coalesce(sum(${o.totalPriceAfterDiscount}), 0)::bigint` }).from(o).where(gte(o.insertedAt, since)).groupBy(o.stage)).map((r) => ({ key: String(r.key), n: num(r.n), amount: num(r.amount) })),
    ),
    ordersBySource: await doc(async () =>
      (await db.select({ key: sql<string>`coalesce(${o.source}, '')`, n: sql<number>`count(*)::int` }).from(o).where(gte(o.insertedAt, since)).groupBy(sql`1`)).map((r) => ({ key: r.key, n: num(r.n) })),
    ),
    outcomes: await doc(async () =>
      (
        await db
          .select({ key: sql<string>`${ORDER_OUTCOME}`, n: sql<number>`count(*)::int`, amount: sql<number>`coalesce(sum(${o.totalPriceAfterDiscount}), 0)::bigint` })
          .from(o)
          .leftJoin(schema.shipments, and(eq(schema.shipments.orderId, o.id), PRIMARY_ATTEMPT))
          .where(gte(o.insertedAt, since))
          .groupBy(sql`1`)
      ).map((r) => ({ key: r.key, n: num(r.n), amount: num(r.amount) })),
    ),
    delivery: await doc(async () => {
      const [dn] = rowsOf<Record<string, unknown>>(await db.execute(sql`select count(*)::int as n from order_delivery_notes where voided_at is null`));
      const [fee] = rowsOf<Record<string, unknown>>(await db.execute(sql`select count(*) filter (where partner_fee > 0)::int as n, coalesce(sum(partner_fee) filter (where stage = 'DELIVERED'), 0)::bigint as s, count(*) filter (where stage = 'RETURNED' and id like 'erp-%')::int as r from orders where id like 'erp-%'`));
      const [pay] = rowsOf<Record<string, unknown>>(await db.execute(sql`select count(*)::int as n, coalesce(sum(case when kind = 'RECEIPT' then amount else -amount end), 0)::bigint as s from order_payments where status = 'CONFIRMED'`));
      return { deliveredNotes: num(dn?.n), withFee: num(fee?.n), feeSum: num(fee?.s), returnedManual: num(fee?.r), payments: num(pay?.n), paymentSum: num(pay?.s) };
    }),
    ads: await doc(async () => {
      const a = schema.adSpends;
      const [r] = await db
        .select({ rows: sql<number>`count(*)::int`, auto: sql<number>`count(*) filter (where ${a.externalKey} is not null)::int`, spend: sql<number>`coalesce(sum(${a.spend}), 0)::bigint`, last: sql<string | null>`max(${a.spendDate})::text`, accounts: sql<number>`count(distinct ${a.accountId})::int` })
        .from(a)
        .where(gte(a.spendDate, since));
      return { rows: num(r?.rows), auto: num(r?.auto), spend: num(r?.spend), lastDate: r?.last ?? null, accounts: num(r?.accounts) };
    }),
    syncRuns: await doc(async () => {
      const t = schema.syncRuns;
      const rows = await db.select({ job: t.job, status: t.status, at: t.startedAt }).from(t).orderBy(sql`${t.startedAt} desc`).limit(6);
      return rows.map((r) => ({ job: r.job, status: r.status, at: iso(r.at) }));
    }),
    costs: await doc(async () => {
      const [r] = rowsOf<Record<string, unknown>>(
        await db.execute(sql`select count(*)::int as v,
          count(*) filter (where exists (select 1 from stock_receipt_items i join stock_receipts r on r.id = i.receipt_id where i.variant_id = pv.id and r.kind = 'RECEIPT' and i.unit_cost > 0))::int as rc,
          count(*) filter (where coalesce(pv.last_imported_price, 0) > 0)::int as mc
          from product_variants pv where pv.is_removed = false`),
      );
      return { variants: num(r?.v), withReceiptCost: num(r?.rc), withManualCost: num(r?.mc) };
    }),
    expenses: await doc(async () => {
      const e = schema.expenses;
      return (await db.select({ key: sql<string>`${e.category}::text`, n: sql<number>`count(*)::int`, amount: sql<number>`coalesce(sum(${e.amount}), 0)::bigint` }).from(e).where(gte(e.occurredAt, since)).groupBy(sql`1`)).map((r) => ({ key: r.key, n: num(r.n), amount: num(r.amount) }));
    }),
    chat: await doc(async () => {
      const [c] = rowsOf<Record<string, unknown>>(await db.execute(sql`select count(*)::int as n, count(*) filter (where status = 'HANDOFF')::int as h from sales_chat_conversations`));
      const [i] = rowsOf<Record<string, unknown>>(await db.execute(sql`select count(*)::int as n from sales_chat_inbound where created_at >= ${new Date(now.getTime() - 86_400_000)} and coalesce(note, '') not in ('BOT_SENT', 'PAGE_REPLY')`));
      const outs = rowsOf<Record<string, unknown>>(await db.execute(sql`select state->'orderSync'->>'lastOutcome' as k, count(*)::int as n from sales_chat_conversations where state ? 'orderSync' group by 1`));
      return { conversations: num(c?.n), handoff: num(c?.h), inbound24h: num(i?.n), syncOutcomes: outs.map((x) => ({ key: String(x.k ?? ""), n: num(x.n) })) };
    }),
  };
}

async function main() {
  const code = (process.argv[2] ?? "").trim();
  const list = await listOrganizations();
  if (!code) {
    tomTat(`Chưa chọn tổ chức — ${list.length} tổ chức: ${list.map((x) => `${x.code} «${x.name}» ${x.status}${x.isHome ? " NHÀ" : ""}`).join(" | ")}`.slice(0, SUMMARY_MAX_CHARS * 3));
    process.exit(0);
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(code)) {
    console.error("org-summary: mã tổ chức chỉ gồm chữ thường, số, - hoặc _.");
    process.exit(1);
  }
  const org = await findOrganization(code);
  if (!org) {
    tomTat(`Không có tổ chức «${code}». Có: ${list.map((x) => x.code).join(", ")}`);
    process.exit(1);
  }
  const db = await getDbForInspection({ code: org.code, isHome: org.isHome });
  const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") !== "on") {
    console.error("org-summary: phiên CSDL không ở chế độ chỉ đọc — KHÔNG chạy.");
    process.exit(1);
  }
  const s = await collectOrgSummary({ code: org.code, name: org.name, status: org.status, isHome: org.isHome }, db);
  for (const line of orgSummaryLines(s)) tomTat(line);
  process.exit(0);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch((e) => {
    console.error("org-summary lỗi:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}

/*
  ops `customer-360-probe` — VÌ SAO BOT KHÔNG NHẬN RA KHÁCH CŨ, VÀ BAO NHIÊU KHÁCH CŨ BỊ HỎI LẠI (CHỈ ĐỌC, CHỈ SỐ ĐẾM).

  Vì sao có (11/10/2026, ca «Nga Ho Thien» — hội thoại 45c36073…): khách mua từ 03/2025, nói «Vẫn địa chỉ cũ», bot vẫn xin địa chỉ;
  khung khách ERP «Chưa có SĐT · Chưa biết khách là ai». Năm giả thuyết, mỗi cái sửa ở một chỗ khác — phép đo phải tách được:
   H1 ERP KHÔNG CÓ đơn cũ của khách (tổ chức chưa đồng bộ đơn Pancake POS / chỉ kéo 30 ngày)?
   H2 Pancake CÓ đơn (`recent_orders` của phản hồi tin) mà ERP không đọc?
   H3 ERP CÓ đơn mang đúng mã hội thoại (`orders.conversation_id` = `thread_id`) mà bot không tra (chỉ tra qua SĐT)?
   H4 Có SĐT (Pancake ghi nhận) mà không khớp hồ sơ / đơn ERP nào?
   H5 Hồ sơ Pancake của hội thoại chưa từng được đọc (state.returning trống) / tin cũ không chứa địa chỉ?

  Hai phần:
   1. `--conv=<uuid>`: dữ kiện của MỘT hội thoại — hàng hội thoại ERP (có / không, mốc, cờ) · hồ sơ Pancake đã lưu (đếm) · đơn ERP theo
      từng phép nối (THREAD · FB_ID · PHONE) · gọi Pancake GET tin của hội thoại (1 trang): số SĐT, số `recent_orders`, đọc được bằng
      `mapOrder` bao nhiêu, có địa chỉ / xã bao nhiêu, bao nhiêu đơn đã có trong ERP, DÁNG khoá (đã che) · hồ sơ Customer 360 (nếu bản
      đang chạy đã có `lib/sales-chatbot/customer-360.ts` — chưa có thì in «CHƯA ĐO ĐƯỢC», không đoán).
   2. `--days=N` (mặc định 30): bối cảnh ERP của tổ chức (hồ sơ khách có mã Pancake / mã Facebook, đơn đồng bộ, đơn mang mã hội thoại,
      hội thoại nối được với đơn qua mã hội thoại) + ba thước đo của `measureReturningMetrics` (khách cũ được nhận ra · mua lại · bị hỏi
      lại SĐT / địa chỉ).

  KHÔNG in tên, SĐT, địa chỉ, chữ tin, mã khách — chỉ số đếm / đúng-sai / dáng khoá đã che. Cả lượt MÃ HOÁ (ops-vps
  `OPS_THAO_TAC_MA_HOA`). CHỈ ĐỌC do Postgres ép (`ERP_READ_ONLY=1` trước lần mở kết nối đầu tiên + hỏi lại phiên); Pancake CHỈ GET.

  arg: `<mã tổ chức> [--conv=<uuid>] [--days=1..60]`.
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("customer-360-probe.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { and, eq, gte, inArray, ne, or, sql } from "drizzle-orm";
import { getDbForInspection, schema, type Db } from "@/db";
import { pageTokensForOffboard } from "@/lib/connectors/service";
import { PANCAKE_PAGES_API, scrubSecrets } from "@/lib/connectors/testers";
import { mapOrder } from "@/lib/integrations/pancake/mapper";
import { findOrganization } from "@/lib/platform/organizations";
import { FANPAGE_CONNECTOR } from "@/lib/sales-chatbot/fanpage";
import { normalizeVnPhone, vouchedOrder } from "@/lib/sales-chatbot/returning";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);
/** Loại lỗi (TypeError · AbortError…) — không câu lỗi, câu lỗi có thể mang URL. */
const tenLoi = (e: unknown) => (e instanceof Error ? e.constructor.name || "Error" : "lỗi");

// ─────────────────────────── PHẦN THUẦN ───────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseProbeArgs(argv: readonly string[]): { code: string; conv: string | null; days: number } | { error: string } {
  const code = (argv.find((a) => !a.startsWith("--")) ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(code)) return { error: "thiếu / sai mã tổ chức" };
  const conv = argv.find((a) => a.startsWith("--conv="))?.slice(7) ?? null;
  if (conv !== null && !UUID.test(conv)) return { error: "--conv phải là mã hội thoại (uuid)" };
  const raw = argv.find((a) => a.startsWith("--days="))?.slice(7);
  const days = raw === undefined ? 30 : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 60) return { error: "--days phải là số nguyên 1..60" };
  return { code, conv, days };
}

/** Khoá đối tượng trông như MÃ ⇒ `<mã>` (map theo mã khách không lộ ra). HÀM THUẦN. */
export function maskProbeKey(k: string): string {
  if (/^\d{4,}$/.test(k)) return "<mã>";
  if (k.length >= 16 && /\d/.test(k) && /^[\w-]+$/.test(k)) return "<mã>";
  return k.length > 40 ? "<khoá dài>" : k;
}

/** Đường khoá (không giá trị) của một đối tượng, sâu tối đa `depth`, mảng ⇒ `x[]` đi vào phần tử đầu. HÀM THUẦN. */
export function keyPaths(v: unknown, prefix = "", depth = 2): string[] {
  if (depth < 0 || v === null || typeof v !== "object") return [];
  if (Array.isArray(v)) return v.length ? keyPaths(v[0], `${prefix}[]`, depth) : [];
  const out: string[] = [];
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const p = prefix ? `${prefix}.${maskProbeKey(k)}` : maskProbeKey(k);
    out.push(p);
    if (x && typeof x === "object") out.push(...keyPaths(x, p, depth - 1));
  }
  return out;
}

/** Tháng (YYYY-MM) của một mốc — đủ để biết lịch sử đi xa tới đâu, không in ngày giờ cụ thể. HÀM THUẦN. */
export function monthOf(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const t = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(t.getTime()) ? "—" : t.toISOString().slice(0, 7);
}

const ADDRESS_HINT = /\b(so nha|so \d|ngo|ngach|hem|kiet|duong|phuong|xa|quan|huyen|thon|xom|tp|thanh pho|tinh)\b/;
/** Một câu có DÁNG địa chỉ không (đếm, không in) — chữ đã bỏ dấu. HÀM THUẦN. */
export function looksLikeAddress(folded: string): boolean {
  return ADDRESS_HINT.test(folded) && /\d/.test(folded);
}

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// ─────────────────────────── ĐỌC ───────────────────────────

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
type StateLike = { customer?: { phone?: string; address?: string; savedAddress?: boolean }; draft?: { orderId?: string | null }; confirmed?: { orderId?: string | null }; returning?: { fetchedAt?: string; phones?: string[]; fbIds?: string[]; prior?: { from: string; text: string; at: string }[]; recentOrders?: unknown[] } };

async function probeConversation(db: Db, orgCode: string, convId: string) {
  const cv = schema.salesChatConversations;
  const o = schema.orders;
  const c = schema.customers;
  const [conv] = await db.select({ id: cv.id, channel: cv.channel, pageId: cv.pageId, threadId: cv.threadId, createdAt: cv.createdAt, customerId: cv.customerId, customerPhone: cv.customerPhone, state: cv.state, status: cv.status }).from(cv).where(eq(cv.id, convId)).limit(1);
  if (!conv) {
    tomTat(`HT ${convId.slice(0, 8)}: KHÔNG có trong CSDL tổ chức ${orgCode}`);
    return;
  }
  const st = (conv.state ?? {}) as StateLike;
  const prof = st.returning;
  const prior = prof?.prior ?? [];
  const priorCustomer = prior.filter((m) => m.from === "customer");
  // Chỉ CỜ có / không — tính trước để dòng tóm tắt không mang tên trường của người (tests/ops-log-leak.test.ts).
  const coSdtKhach = Boolean(st.customer?.phone);
  const coDiaChiKhach = Boolean(st.customer?.address);
  tomTat(`HT ${convId.slice(0, 8)}: kênh ${conv.channel} · trạng thái ${conv.status} · mở ${monthOf(conv.createdAt)} · có page ${Boolean(conv.pageId)} · có mã hội thoại ${Boolean(conv.threadId)} · hồ sơ khách ERP gắn ${Boolean(conv.customerId)} · SĐT hội thoại ${Boolean(conv.customerPhone)} · state.customer ${Boolean(st.customer)} (SĐT ${coSdtKhach} · địa chỉ ${coDiaChiKhach})`);
  tomTat(
    `HT hồ sơ Pancake đã lưu (state.returning): ${prof ? "CÓ" : "KHÔNG"}${prof ? ` · tuổi ${prof.fetchedAt ? Math.round((Date.now() - new Date(prof.fetchedAt).getTime()) / 3_600_000) : "?"} giờ · SĐT ${prof.phones?.length ?? 0} · mã FB ${prof.fbIds?.length ?? 0} · tin cũ ${prior.length} (của khách ${priorCustomer.length}, dáng địa chỉ ${priorCustomer.filter((m) => looksLikeAddress(fold(m.text))).length}, xa nhất ${monthOf(prior[0]?.at)}) · recent_orders ${prof.recentOrders === undefined ? "CHƯA ĐỌC (bản cũ)" : prof.recentOrders.length}` : ""}`,
  );

  // Đơn ERP theo từng phép nối — chỉ đếm.
  const thread = conv.threadId ? await db.select({ n: sql<number>`count(*)::int`, first: sql<Date | null>`min(${o.insertedAt})` }).from(o).where(and(eq(o.conversationId, conv.threadId), ne(o.stage, "DELETED"))) : [{ n: 0, first: null }];
  const own = await db.select({ n: sql<number>`count(*)::int` }).from(o).where(and(eq(o.salesConversationId, conv.id), ne(o.stage, "DELETED")));
  const phones = [...new Set([st.customer?.phone ?? "", conv.customerPhone ?? "", ...(prof?.phones ?? [])].map((p) => normalizeVnPhone(p)).filter((p): p is string => Boolean(p)))];
  let byPhoneCustomers = 0;
  let byPhoneOrders = 0;
  let byPhoneVouched = 0;
  if (phones.length) {
    const phoneArray = sql.join(
      phones.map((p) => sql`${p}`),
      sql`, `,
    );
    const custs = await db
      .select({ id: c.id })
      .from(c)
      .where(or(inArray(c.phone, phones), sql`${c.phones} && array[${phoneArray}]::text[]`));
    byPhoneCustomers = custs.length;
    const who = or(custs.length ? inArray(o.customerId, custs.map((x) => x.id)) : undefined, inArray(o.shipPhone, phones), inArray(o.billPhone, phones))!;
    byPhoneOrders = Number((await db.select({ n: sql<number>`count(*)::int` }).from(o).where(and(who, ne(o.stage, "DELETED"))))[0]?.n ?? 0);
    byPhoneVouched = Number((await db.select({ n: sql<number>`count(*)::int` }).from(o).where(and(who, ne(o.stage, "DELETED"), vouchedOrder(o))))[0]?.n ?? 0);
  }
  const fbIds = prof?.fbIds ?? [];
  const byFb = fbIds.length ? (await db.select({ id: c.id }).from(c).where(inArray(c.fbId, fbIds))).length : 0;
  tomTat(`HT đơn ERP: theo mã hội thoại ${thread[0]?.n ?? 0} (xa nhất ${monthOf(thread[0]?.first)}) · của bot trong hội thoại ${own[0]?.n ?? 0} · SĐT đã biết ${phones.length} ⇒ hồ sơ ${byPhoneCustomers} · đơn ${byPhoneOrders} (có người đứng sau ${byPhoneVouched}) · mã FB ⇒ hồ sơ ${byFb}`);

  // Pancake: GET tin của hội thoại (1 trang) — chỉ đếm + dáng khoá.
  if (conv.pageId && conv.threadId) {
    const { tokens } = await pageTokensForOffboard(db, orgCode, FANPAGE_CONNECTOR);
    const token = tokens.get(conv.pageId);
    if (!token) tomTat("PANCAKE: page của hội thoại không có token (chưa nối / không giải mã được) — CHƯA ĐO ĐƯỢC");
    else {
      const url = `${PANCAKE_PAGES_API}/v1/pages/${encodeURIComponent(conv.pageId)}/conversations/${encodeURIComponent(conv.threadId)}/messages?page_access_token=${encodeURIComponent(token)}`;
      try {
        const res = await fetch(url, { method: "GET", redirect: "manual", headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (!res.ok || !body || body.success === false) tomTat(`PANCAKE: HTTP ${res.status} · success=${body ? str(body.success) || "—" : "không JSON"} — CHƯA ĐO ĐƯỢC`);
        else {
          const arr = (k: string) => (Array.isArray(body[k]) ? (body[k] as unknown[]) : null);
          const msgs = arr("messages") ?? [];
          const times = msgs.map((m) => str((m as { inserted_at?: unknown }).inserted_at)).filter(Boolean).sort();
          const ro = arr("recent_orders");
          const mapped = (ro ?? []).map((x) => mapOrder(x)).filter((x): x is NonNullable<ReturnType<typeof mapOrder>> => Boolean(x));
          const inErp = mapped.length ? (await db.select({ id: o.id }).from(o).where(inArray(o.id, mapped.map((m) => m.id)))).length : 0;
          const stages: Record<string, number> = {};
          for (const m of mapped) stages[m.stage] = (stages[m.stage] ?? 0) + 1;
          const rPhones = new Set(mapped.map((m) => normalizeVnPhone(m.shipPhone || m.billPhone)).filter((p): p is string => Boolean(p)));
          tomTat(`PANCAKE tin: ${msgs.length} tin trang 1 (xa nhất ${monthOf(times[0] ? `${times[0]}Z` : null)}) · conv_phone_numbers ${arr("conv_phone_numbers")?.length ?? "KHÔNG KHOÁ"} · recent_phone_numbers ${arr("recent_phone_numbers")?.length ?? "KHÔNG KHOÁ"} · recent_orders ${ro ? ro.length : "KHÔNG KHOÁ"}`);
          tomTat(`PANCAKE recent_orders: mapOrder đọc được ${mapped.length}/${ro?.length ?? 0} · có địa chỉ ${mapped.filter((m) => (m.shipAddress || m.shipFullAddress).trim()).length} · có xã ${mapped.filter((m) => m.shipCommune.trim()).length} · có tỉnh ${mapped.filter((m) => m.shipProvince.trim()).length} · ĐÃ có trong ERP ${inErp} · SĐT trùng SĐT đã biết ${[...rPhones].filter((p) => phones.includes(p)).length}/${rPhones.size} · khâu ${Object.entries(stages).map(([k, n]) => `${k} ${n}`).join(" · ") || "—"} · mang mã hội thoại này ${mapped.filter((m) => m.conversationId === conv.threadId).length}`);
          const keys = ro && ro.length ? [...new Set(keyPaths(ro[0], "", 1))].sort() : [];
          for (let i = 0; i < keys.length && i < 120; i += 20) tomTat(`PANCAKE recent_orders[0] khoá: ${keys.slice(i, i + 20).join(", ")}`);
          tomTat(`PANCAKE khoá gốc phản hồi tin: ${Object.keys(body).map(maskProbeKey).sort().join(", ").slice(0, 250)}`);
        }
      } catch (e) {
        tomTat(`PANCAKE: lỗi mạng (${tenLoi(e)}) — CHƯA ĐO ĐƯỢC`);
        console.log(scrubSecrets(e instanceof Error ? e.message : String(e), [token]).slice(0, 160));
      }
    }
  }

  // Hồ sơ Customer 360 của bản ĐANG CHẠY (ops lấy lib/ từ ảnh đang chạy — bản chưa có tệp này ⇒ CHƯA ĐO ĐƯỢC).
  try {
    const m = await import("@/lib/sales-chatbot/customer-360");
    const c360 = await m.loadCustomer360({ conversationId: conv.id, pageId: conv.pageId, threadId: conv.threadId, state: conv.state as never }, { db });
    tomTat(`C360: nối ${c360.identity.match} · khách ${c360.buyer} · Pancake ${c360.identity.pancake} · địa chỉ đề xuất ${c360.suggestion} (${c360.addresses.map((a) => a.confidence).join(",") || "—"}) · lý do không có ${c360.noAddressReason ?? "—"} · che ${c360.masked} · đơn trước ${c360.history?.orders ?? "—"} (giao ${c360.history?.delivered ?? "—"} · hoàn ${c360.history?.returned ?? "—"} · huỷ ${c360.history?.cancelled ?? "—"})`);
    const msgs = await db.select({ content: schema.salesChatMessages.content }).from(schema.salesChatMessages).where(and(eq(schema.salesChatMessages.conversationId, conv.id), eq(schema.salesChatMessages.role, "assistant")));
    const texts = msgs.map((r) => (Array.isArray(r.content) ? (r.content as { type?: string; text?: string }[]).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n") : ""));
    const f = m.botContactFacts(texts);
    tomTat(`HT tin bot: ${texts.length} · xin SĐT/địa chỉ ${f.askedContact} lần · đề xuất thông tin cũ trước khi xin ${f.offeredOldFirst}`);
  } catch (e) {
    tomTat(`C360: CHƯA ĐO ĐƯỢC — bản đang chạy chưa có lib/sales-chatbot/customer-360.ts (${tenLoi(e)})`);
  }
}

async function probeOrg(db: Db, days: number) {
  const o = schema.orders;
  const cv = schema.salesChatConversations;
  const since = new Date(Date.now() - days * 86_400_000);
  const [cu] = rowsOf<Record<string, unknown>>(await db.execute(sql`select count(*)::int as n, count(*) filter (where pancake_id is not null)::int as pancake, count(*) filter (where coalesce(fb_id, '') <> '')::int as fb from customers`));
  const [od] = await db
    .select({ n: sql<number>`count(*)::int`, erp: sql<number>`count(*) filter (where ${o.id} like 'erp-%')::int`, conv: sql<number>`count(*) filter (where ${o.conversationId} is not null)::int`, first: sql<Date | null>`min(${o.insertedAt})` })
    .from(o)
    .where(ne(o.stage, "DELETED"));
  tomTat(`TỔ CHỨC: hồ sơ khách ${Number(cu?.n ?? 0)} (mã Pancake ${Number(cu?.pancake ?? 0)} · mã FB ${Number(cu?.fb ?? 0)}) · đơn ${od?.n ?? 0} (tạo trong ERP ${od?.erp ?? 0} · đồng bộ ${(od?.n ?? 0) - (od?.erp ?? 0)} · mang mã hội thoại ${od?.conv ?? 0} · xa nhất ${monthOf(od?.first)})`);
  const [hv] = await db
    .select({
      n: sql<number>`count(*)::int`,
      thread: sql<number>`count(*) filter (where ${cv.threadId} is not null)::int`,
      linked: sql<number>`count(*) filter (where exists (select 1 from orders x where x.conversation_id = ${cv.threadId} and x.stage <> 'DELETED' and x.inserted_at < ${cv.createdAt}))::int`,
      prof: sql<number>`count(*) filter (where ${cv.state} ? 'returning')::int`,
      phones: sql<number>`count(*) filter (where jsonb_array_length(coalesce(${cv.state}->'returning'->'phones', '[]'::jsonb)) > 0)::int`,
      ro: sql<number>`count(*) filter (where ${cv.state}->'returning' ? 'recentOrders')::int`,
    })
    .from(cv)
    .where(and(ne(cv.channel, "TEST"), gte(cv.createdAt, since)));
  tomTat(`HỘI THOẠI ${days} ngày: ${hv?.n ?? 0} · có mã hội thoại ${hv?.thread ?? 0} · có đơn ERP CŨ mang đúng mã hội thoại ${hv?.linked ?? 0} · có hồ sơ Pancake ${hv?.prof ?? 0} (có SĐT ${hv?.phones ?? 0} · đã đọc recent_orders ${hv?.ro ?? 0})`);
  try {
    const m = await import("@/lib/sales-chatbot/customer-360");
    const r = await m.measureReturningMetrics({ db, since, until: new Date() });
    tomTat(`THƯỚC ĐO ${days} ngày: ${m.returningMetricsSentence(r.metrics)}`);
    tomTat(`THƯỚC ĐO nối: ${Object.entries(r.byMatch).map(([k, n]) => `${k} ${n}`).join(" · ") || "—"}`);
  } catch (e) {
    tomTat(`THƯỚC ĐO: CHƯA ĐO ĐƯỢC — bản đang chạy chưa có lib/sales-chatbot/customer-360.ts (${tenLoi(e)})`);
  }
}

async function main() {
  const args = parseProbeArgs(process.argv.slice(2));
  if ("error" in args) {
    tomTat(`customer-360-probe: DỪNG · cách dùng sai — ${args.error} (arg: <mã tổ chức> [--conv=<uuid>] [--days=1..60])`);
    process.exit(1);
  }
  const org = await findOrganization(args.code);
  if (!org) {
    tomTat(`customer-360-probe: DỪNG · không có tổ chức «${args.code}»`);
    process.exit(1);
  }
  const db: Db = await getDbForInspection({ code: org.code, isHome: org.isHome });
  const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") !== "on") {
    tomTat("customer-360-probe: DỪNG · phiên CSDL KHÔNG ở chế độ chỉ đọc — không đọc gì");
    process.exit(1);
  }
  tomTat(`customer-360-probe ${org.code}: lúc ${new Date().toISOString().slice(0, 16)}Z`);
  if (args.conv) await probeConversation(db, org.code, args.conv);
  await probeOrg(db, args.days);
  process.exit(0);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch((e) => {
    console.error("customer-360-probe lỗi:", e instanceof Error ? e.name : "lỗi");
    tomTat("customer-360-probe: LỖI ngoài phép đo — chi tiết trong phần mã hoá");
    process.exit(1);
  });
}

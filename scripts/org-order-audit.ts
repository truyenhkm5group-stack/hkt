/*
  ops `org-order-audit` — ĐƠN CỦA MỘT TỔ CHỨC KHÁCH TRONG MỘT NGÀY: ĐỦ CHƯA, ĐÚNG CHƯA, KỊP CHƯA (CHỈ ĐỌC).

  Vì sao có (05/10/2026): chủ shop HSLC so «Mới 26» trên POS Pancake với «23» trên trang Đơn hàng ERP và hỏi đồng bộ có đúng,
  đủ, realtime không. Hai con số KHÔNG đếm cùng một thứ: POS tự đẻ một đơn rỗng («Chưa có sản phẩm») cho MỖI hội thoại mà khách
  để lại SĐT; ERP chỉ có đơn khi có người / bot / máy đọc hội thoại thấy lời chốt có hàng. Muốn biết thiếu thật hay không phải
  đối chiếu TỪNG hội thoại có SĐT với đơn ERP — script này làm đúng việc ấy:

   1. Hội thoại có SĐT trong ngày — SĐT khách gõ trong tin webhook đã ghi (`sales_chat_inbound`). Không gọi Pancake: bí mật
      kết nối chỉ mở được qua lib/connectors/service.ts trong ngữ cảnh tổ chức, mà ngữ cảnh ấy migrate CSDL (không chỉ đọc).
      Tổng này đặt cạnh số «Mới» của POS là đủ để thấy webhook có rơi hội thoại hay không.
   2. Ghép với đơn ERP tạo trong ngày (khoá hội thoại `orders.sales_conversation_id` trước, rồi SĐT) — và đơn 7 ngày trước
      (khách đã có đơn, hôm nay chỉ nhắn thêm).
   3. Hội thoại có SĐT mà không có đơn ⇒ in LÝ DO theo nhật ký ghi đơn (`state.orderSync`) + trạng thái bot + 8 tin cuối, để
      phân biệt «khách chưa chốt» với «máy bỏ sót».
   4. KỊP: mỗi đơn — từ tin khách cuối trước đơn tới lúc đơn vào ERP; và nhịp job `sales-followup` (lưới an toàn 5 phút).

  Có tên, SĐT, chữ tin ⇒ cả lượt chạy trong `ma_hoa_ket_qua`; chỉ dòng mang tiền tố [ops:tom-tat] (số đếm) ra log công khai.
  CHỈ ĐỌC do Postgres ép (`ERP_READ_ONLY=1` trước lần mở kết nối đầu tiên).

  arg: `<mã tổ chức> [--day=YYYY-MM-DD]` (ngày giờ Việt Nam; mặc định hôm nay).
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("org-order-audit.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { getDbForInspection, schema, type Db } from "@/db";
import { findOrganization } from "@/lib/platform/organizations";
import { normalizeVnPhone } from "@/lib/sales-chatbot/returning";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);

const VN_OFFSET_MS = 7 * 3_600_000;
const PRIOR_ORDER_DAYS = 7;

// ─────────────────────────── PHẦN THUẦN ───────────────────────────

/** Ngày giờ Việt Nam `YYYY-MM-DD` ⇒ [00:00, 24:00) theo UTC. Không truyền ⇒ hôm nay theo giờ VN. HÀM THUẦN. */
export function vnDayWindow(day: string | null, now: Date = new Date()): { day: string; from: Date; to: Date } {
  const d = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : new Date(now.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
  const from = new Date(Date.parse(`${d}T00:00:00Z`) - VN_OFFSET_MS);
  return { day: d, from, to: new Date(from.getTime() + 86_400_000) };
}

/** Mọi SĐT Việt Nam trong một đoạn chữ (đã chuẩn hoá 0xxxxxxxxx). HÀM THUẦN. */
export function phonesIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:\+?84|0)(?:[\s.-]?\d){8,10}/g)) {
    const n = normalizeVnPhone(m[0]);
    if (n) out.add(n);
  }
  return [...out];
}

export type AuditOrder = { id: string; at: Date; stage: string; source: string; phones: string[]; name: string; convId: string | null; total: number; province?: string; ward?: string };
export type AuditThread = {
  threadId: string;
  convId: string | null;
  name: string;
  /** SĐT khách gõ trong tin webhook đã ghi (mốc tin đầu tiên mang SĐT đó). */
  chatPhones: { phone: string; at: Date }[];
  /** Tin khách (mốc) trong ngày — để đo độ trễ. */
  customerAts: Date[];
};
export type PriorOrder = { id: string; at: Date; phones: string[] };

export type ThreadVerdict =
  | { kind: "ORDER_TODAY"; orderIds: string[]; by: "CONVERSATION" | "PHONE" }
  | { kind: "ORDER_BEFORE"; orderId: string; at: Date }
  | { kind: "NO_ORDER" };

/**
 * Hội thoại có SĐT ⇒ có đơn hôm nay (khoá hội thoại trước, rồi SĐT) · đã có đơn trong 7 ngày trước · KHÔNG có đơn.
 * Đơn hôm nay không ghép được hội thoại nào ⇒ `unmatchedOrders`. HÀM THUẦN.
 */
export function auditMatch(threads: readonly AuditThread[], orders: readonly AuditOrder[], prior: readonly PriorOrder[]): { verdicts: Map<string, ThreadVerdict>; unmatchedOrders: AuditOrder[] } {
  const used = new Set<string>();
  const verdicts = new Map<string, ThreadVerdict>();
  for (const t of threads) {
    const phones = new Set(t.chatPhones.map((p) => p.phone));
    const byConv = t.convId ? orders.filter((o) => o.convId === t.convId) : [];
    if (byConv.length) {
      byConv.forEach((o) => used.add(o.id));
      verdicts.set(t.threadId, { kind: "ORDER_TODAY", orderIds: byConv.map((o) => o.id), by: "CONVERSATION" });
      continue;
    }
    const byPhone = orders.filter((o) => o.phones.some((p) => phones.has(p)));
    if (byPhone.length) {
      byPhone.forEach((o) => used.add(o.id));
      verdicts.set(t.threadId, { kind: "ORDER_TODAY", orderIds: byPhone.map((o) => o.id), by: "PHONE" });
      continue;
    }
    const before = [...prior].filter((o) => o.phones.some((p) => phones.has(p))).sort((a, b) => b.at.getTime() - a.at.getTime())[0];
    verdicts.set(t.threadId, before ? { kind: "ORDER_BEFORE", orderId: before.id, at: before.at } : { kind: "NO_ORDER" });
  }
  return { verdicts, unmatchedOrders: orders.filter((o) => !used.has(o.id)) };
}

/** Độ trễ (phút) từ tin khách cuối TRƯỚC lúc đơn vào ERP tới lúc đơn vào; không có tin trước đó ⇒ `null`. HÀM THUẦN. */
export function orderLagMinutes(orderAt: Date, customerAts: readonly Date[]): number | null {
  const before = customerAts.filter((a) => a.getTime() <= orderAt.getTime()).sort((a, b) => b.getTime() - a.getTime())[0];
  return before ? Math.round(((orderAt.getTime() - before.getTime()) / 60_000) * 10) / 10 : null;
}

export function quantile(xs: readonly number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))];
}

// ─────────────────────────── ĐỌC DỮ LIỆU ───────────────────────────

const vnTime = (d: Date | null | undefined) => (d ? new Date(d.getTime() + VN_OFFSET_MS).toISOString().slice(11, 16) : "—");
const vnDateTime = (d: Date | null | undefined) => (d ? new Date(d.getTime() + VN_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ") : "—");

async function main() {
  const args = process.argv.slice(2);
  const code = (args.find((a) => !a.startsWith("--")) ?? "").trim();
  const dayArg = args.find((a) => a.startsWith("--day="))?.slice(6) ?? null;
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(code)) {
    console.error("org-order-audit: arg = <mã tổ chức> [--day=YYYY-MM-DD]");
    process.exit(1);
  }
  const org = await findOrganization(code);
  if (!org) {
    tomTat(`Không có tổ chức «${code}».`);
    process.exit(1);
  }
  const db: Db = await getDbForInspection({ code: org.code, isHome: org.isHome });
  const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") !== "on") {
    console.error("org-order-audit: phiên CSDL không ở chế độ chỉ đọc — KHÔNG chạy.");
    process.exit(1);
  }
  const { day, from, to } = vnDayWindow(dayArg);
  console.log(`Tổ chức ${org.code} (${org.name}) · ngày ${day} (giờ VN) · ${from.toISOString()} → ${to.toISOString()}`);

  // 1. Đơn ERP trong ngày + 7 ngày trước.
  const o = schema.orders;
  const orderRows = await db
    .select({ id: o.id, at: o.insertedAt, stage: o.stage, source: o.source, bill: o.billPhone, ship: o.shipPhone, name: o.billFullName, conv: o.salesConversationId, total: o.totalPriceAfterDiscount, province: o.shipProvince, ward: o.shipCommune })
    .from(o)
    .where(and(gte(o.insertedAt, new Date(from.getTime() - PRIOR_ORDER_DAYS * 86_400_000)), lt(o.insertedAt, to)));
  const toPhones = (...xs: (string | null)[]) => [...new Set(xs.map((x) => normalizeVnPhone(x ?? "")).filter((x): x is string => Boolean(x)))];
  const allOrders = orderRows.map((r) => ({ id: r.id, at: new Date(r.at), stage: String(r.stage), source: r.source, phones: toPhones(r.bill, r.ship), name: r.name ?? "", convId: r.conv, total: Number(r.total ?? 0), province: r.province ?? "", ward: r.ward ?? "" }));
  const today = allOrders.filter((x) => x.at >= from && x.stage !== "DELETED");
  const deletedToday = allOrders.filter((x) => x.at >= from && x.stage === "DELETED");
  const prior = allOrders.filter((x) => x.at < from && x.stage !== "DELETED");

  // 2. Tin webhook trong ngày (đủ mọi loại — đo cả tin page / bot để in 8 tin cuối).
  const t = schema.salesChatInbound;
  const inbound = await db
    .select({ pageId: t.pageId, threadId: t.threadId, text: t.text, name: t.customerName, note: t.note, kind: t.kind, status: t.status, at: t.createdAt })
    .from(t)
    .where(and(gte(t.createdAt, from), lt(t.createdAt, to)))
    .orderBy(t.createdAt);
  const isCustomer = (note: string | null) => !["BOT_SENT", "PAGE_REPLY"].includes(note ?? "");
  const byThread = new Map<string, typeof inbound>();
  for (const m of inbound) {
    const list = byThread.get(m.threadId) ?? [];
    list.push(m);
    byThread.set(m.threadId, list);
  }

  // 3. Hội thoại ERP (khoá + trạng thái + nhật ký ghi đơn).
  const c = schema.salesChatConversations;
  const convRows = await db
    .select({ id: c.id, threadId: c.threadId, channel: c.channel, status: c.status, handoff: c.handoffReason, lastBotAt: c.lastBotAt, lastCustomerAt: c.lastCustomerAt, orderId: c.orderId, draftOrderId: c.draftOrderId, state: c.state })
    .from(c)
    .where(sql`${c.threadId} is not null and (${c.lastCustomerAt} >= ${from} or ${c.updatedAt} >= ${from})`);
  const convByThread = new Map(convRows.filter((r) => r.threadId).map((r) => [r.threadId as string, r]));

  // 5. Dựng hội thoại có SĐT (hợp hai nguồn).
  const threadIds = new Set<string>(byThread.keys());
  const threads: AuditThread[] = [];
  for (const id of threadIds) {
    const msgs = (byThread.get(id) ?? []).filter((m) => isCustomer(m.note));
    const chatPhones: { phone: string; at: Date }[] = [];
    for (const m of msgs) for (const p of phonesIn(m.text)) if (!chatPhones.some((x) => x.phone === p)) chatPhones.push({ phone: p, at: new Date(m.at) });
    if (!chatPhones.length) continue;
    threads.push({ threadId: id, convId: convByThread.get(id)?.id ?? null, name: msgs.find((m) => m.name)?.name ?? "", chatPhones, customerAts: msgs.map((m) => new Date(m.at)) });
  }
  const active = threads;
  const { verdicts, unmatchedOrders } = auditMatch(active, today, prior);

  // ── IN (phần MÃ HOÁ) ──
  console.log(`\n══ ĐƠN ERP TẠO TRONG NGÀY: ${today.length} (đã xoá: ${deletedToday.length}) ══`);
  const lagBySource = new Map<string, number[]>();
  const threadOfOrder = new Map<string, AuditThread>();
  for (const th of active) {
    const v = verdicts.get(th.threadId);
    if (v?.kind === "ORDER_TODAY") for (const id of v.orderIds) threadOfOrder.set(id, th);
  }
  for (const x of [...today].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const th = threadOfOrder.get(x.id) ?? null;
    const lag = th ? orderLagMinutes(x.at, th.customerAts) : null;
    if (lag !== null) lagBySource.set(x.source, [...(lagBySource.get(x.source) ?? []), lag]);
    console.log(`${vnTime(x.at)} · ${x.id.slice(-8)} · ${x.stage} · ${x.source} · ${x.name} · ${x.phones.join("/") || "không SĐT"} · ${x.total.toLocaleString("vi-VN")} ₫ · ${x.ward ? `${x.ward}, ${x.province}` : x.province ? `${x.province} (CHƯA có xã)` : "CHƯA có tỉnh"} · ${th ? `hội thoại …${th.threadId.slice(-8)} · trễ ${lag ?? "—"} phút sau tin khách cuối` : "KHÔNG ghép được hội thoại có SĐT"}`);
  }

  const counts = { orderToday: 0, orderBefore: 0, noOrder: 0 };
  const reasons = new Map<string, number>();
  console.log(`\n══ HỘI THOẠI CÓ SĐT TRONG NGÀY: ${active.length} ══`);
  for (const th of [...active].sort((a, b) => (a.chatPhones[0]?.at.getTime() ?? 0) - (b.chatPhones[0]?.at.getTime() ?? 0))) {
    const v = verdicts.get(th.threadId)!;
    const conv = convByThread.get(th.threadId);
    const st = (conv?.state ?? {}) as Record<string, unknown>;
    const sync = st.orderSync as { lastOutcome?: string; lastResult?: string; checkedUntil?: string; lastRunAt?: string } | undefined;
    const phones = th.chatPhones.map((p) => p.phone).join("/");
    const head = `…${th.threadId.slice(-8)} · ${th.name || "?"} · ${phones} · SĐT lúc ${vnTime(th.chatPhones[0]?.at)} · ${th.customerAts.length} tin khách · hội thoại ${conv ? `${conv.status}${conv.handoff ? ` (${conv.handoff.slice(0, 60)})` : ""}` : "CHƯA mở trong ERP"}`;
    if (v.kind === "ORDER_TODAY") {
      counts.orderToday += 1;
      console.log(`✓ ${head} ⇒ đơn hôm nay (${v.by === "CONVERSATION" ? "khoá hội thoại" : "SĐT"}): ${v.orderIds.map((x) => x.slice(-8)).join(", ")}`);
      continue;
    }
    if (v.kind === "ORDER_BEFORE") {
      counts.orderBefore += 1;
      console.log(`○ ${head} ⇒ đã có đơn ${v.orderId.slice(-8)} lúc ${vnDateTime(v.at)} (trước hôm nay)`);
      continue;
    }
    counts.noOrder += 1;
    const reason = !conv ? "NO_CONVERSATION" : sync?.lastOutcome ?? (conv.status === "HANDOFF" ? "HANDOFF_NOT_READ" : "NOT_READ");
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    console.log(`✗ ${head}`);
    console.log(`    lý do: ${reason}${sync ? ` · ghi đơn đọc tới ${vnDateTime(sync.checkedUntil ? new Date(sync.checkedUntil) : null)}: «${(sync.lastResult ?? "").slice(0, 200)}»` : ""} · bot nhắn cuối ${vnDateTime(conv?.lastBotAt)} · nháp ${st.draft ? "CÓ" : "không"} · đã chốt ${st.confirmed ? "CÓ" : "không"}`);
    for (const m of (byThread.get(th.threadId) ?? []).slice(-8)) {
      const who = m.note === "BOT_SENT" ? "BOT" : m.note === "PAGE_REPLY" ? "PAGE" : "KHÁCH";
      console.log(`    ${vnTime(new Date(m.at))} ${who}: ${m.text.replace(/\s+/g, " ").slice(0, 160)}`);
    }
  }
  if (unmatchedOrders.length) {
    console.log(`\n══ ĐƠN HÔM NAY KHÔNG GHÉP ĐƯỢC HỘI THOẠI CÓ SĐT HÔM NAY: ${unmatchedOrders.length} ══`);
    for (const x of unmatchedOrders) console.log(`${vnTime(x.at)} · ${x.id.slice(-8)} · ${x.source} · ${x.name} · ${x.phones.join("/")} · hội thoại ${x.convId ?? "—"}`);
  }

  // 6. Nhịp job `sales-followup` trong ngày.
  const s = schema.syncRuns;
  const runs = await db.select({ status: s.status, at: s.startedAt }).from(s).where(and(eq(s.job, "sales-followup"), gte(s.startedAt, from), lt(s.startedAt, to))).orderBy(s.startedAt);
  let maxGap = 0;
  for (let i = 1; i < runs.length; i++) maxGap = Math.max(maxGap, (new Date(runs[i].at).getTime() - new Date(runs[i - 1].at).getTime()) / 60_000);
  const failed = runs.filter((r) => r.status !== "SUCCESS").length;

  // ── TÓM TẮT (số đếm, ra log công khai) ──
  const bySource = new Map<string, number>();
  for (const x of today) bySource.set(x.source, (bySource.get(x.source) ?? 0) + 1);
  tomTat(`Tổ chức ${org.code} · ngày ${day}: đơn ERP ${today.length} (${[...bySource].map(([k, n]) => `${k} ${n}`).join(" · ") || "0"}) · đã xoá ${deletedToday.length}`);
  tomTat(`Hội thoại có SĐT hôm nay ${active.length}: có đơn hôm nay ${counts.orderToday} · đã có đơn ≤${PRIOR_ORDER_DAYS} ngày trước ${counts.orderBefore} · KHÔNG đơn ${counts.noOrder}`);
  tomTat(`Không đơn theo lý do: ${[...reasons].map(([k, n]) => `${k} ${n}`).join(" · ") || "0"}`);
  tomTat(`Đơn không ghép được hội thoại có SĐT hôm nay: ${unmatchedOrders.length}`);
  tomTat(`Địa chỉ đơn: có tỉnh + xã ${today.filter((x) => x.ward).length} · chỉ tỉnh ${today.filter((x) => x.province && !x.ward).length} · chưa có tỉnh ${today.filter((x) => !x.province).length}`);
  for (const [src, xs] of lagBySource) tomTat(`Trễ (phút, tin khách cuối → đơn) «${src}»: n=${xs.length} · trung vị ${quantile(xs, 0.5) ?? "—"} · p90 ${quantile(xs, 0.9) ?? "—"} · max ${Math.max(...xs)}`);
  tomTat(`Job sales-followup: ${runs.length} lượt · ${failed} lỗi · khoảng hở lớn nhất ${Math.round(maxGap)} phút`);
  process.exit(0);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch((e) => {
    console.error("org-order-audit lỗi:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}

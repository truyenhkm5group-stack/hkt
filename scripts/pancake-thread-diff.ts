/*
  ops `pancake-thread-diff` — TIN PANCAKE ĐỐI CHIẾU VỚI SỔ TIN ERP VÀ HỘP THƯ (CHỈ ĐỌC, KHÔNG IN CHỮ TIN / TÊN / SĐT / TOKEN).

  Vì sao có (P0 14/10/2026, HSLC): chủ shop thấy hội thoại «Châu Dương» trên Pancake nhưng Hộp thư khách của ERP không hiện như mong
  đợi. Chưa biết tin mất ở bước nào — webhook Pancake → `sales_chat_inbound` → hội thoại → `listInbox` → giao diện — hay dữ liệu CÓ mà
  bị lọc / ẩn / xếp sai. Script này đo từng bước bằng một NGUỒN ĐỘC LẬP (API Pancake), không bằng chính hệ thống đã có thể bỏ sót:

   1. API Pancake (token page của CHÍNH tổ chức qua `pageTokensForOffboard`, CHỈ GET, nghỉ giữa các lượt gọi, dừng khi 429): tin của
      luồng — đúng điểm cuối `fetchThreadMessages` — và danh sách hội thoại v2 (`type=INBOX&order_by=updated_at`, như `catchUpFanpage`).
   2. Tin Pancake được lọc bằng ĐÚNG luật của đường nhập lịch sử (`planHistoryMessages`: bỏ ghi chú tự động, tin thu hồi, bình luận) —
      đó là tập tin ERP LẼ RA phải có. So với `sales_chat_inbound` theo `message_id`, rồi (tin phía page) theo CHỮ trong 10 phút vì
      bot ghi mã tạm `bot-out:` và tiếng vọng bị lọc theo chữ.
   3. Hộp thư: chạy ĐÚNG `listInbox` của trang (bộ lọc mặc định, 100 dòng) trong `withOrganization` với handle CSDL CHỈ ĐỌC
      (`bindReadOnlyOrgHandle` + `inboxReader` của inbox-perf-probe — danh tính KHÔNG gửi tin được ⇒ không ghi gì).

  arg: `<mã tổ chức> [--conv=<uuid>] [--hours=1..72] [--threads=1..200]`
   · `--conv`: MỘT hội thoại — số tin hai bên theo phía, thiếu / thừa, mốc tin cuối, mốc hội thoại, vị trí trong trang đầu «Tất cả» và
     từng thẻ, hạng nếu chỉ xếp theo tin gần nhất.
   · không `--conv`: toàn tổ chức trong `--hours` (mặc định 72) — luồng Pancake có tin mới vs luồng có trong ERP, tin thiếu theo giờ,
     độ trễ webhook→sổ p50/p95 (cảnh báo khi p95 > 5 giây), số hội thoại lẽ ra lên trang đầu mà không lên.

  Cả lượt MÃ HOÁ (ops-vps `OPS_THAO_TAC_MA_HOA`); dòng [ops:tom-tat] chỉ mang số đếm / mốc / mã trạng thái — mã hội thoại, mã luồng,
  chữ tin, tên khách, SĐT, token CHỈ nằm ở phần mã hoá (mã hội thoại) hoặc không in ở đâu cả (phần còn lại).
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("pancake-thread-diff.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { and, desc, eq, gte, ne, sql } from "drizzle-orm";
import { getDbForInspection, schema, type Db } from "@/db";
import { pageTokensForOffboard } from "@/lib/connectors/service";
import { PANCAKE_PAGES_API, scrubSecrets } from "@/lib/connectors/testers";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import { FANPAGE_CONNECTOR, fanpageVisitorKey, PAGE_REPLIED_REASON } from "@/lib/sales-chatbot/fanpage";
import { planHistoryMessages } from "@/lib/sales-chatbot/history";
import { inboundSide, listInbox } from "@/lib/sales-chatbot/inbox";
import { INBOX_FILTERS, type InboxFilter, type TimelineSide } from "@/lib/sales-chatbot/inbox-shared";
import { INBOX_ACTIVITY_SQL } from "@/lib/sales-chatbot/inbox-states";
import { rowsOf } from "@/lib/sql-rows";
import { bindReadOnlyOrgHandle, inboxReader } from "./inbox-perf-probe";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);

// ─────────────────────────── PHẦN THUẦN ───────────────────────────

export const DIFF_DEFAULT_HOURS = 72;
export const DIFF_MAX_HOURS = 72;
export const DIFF_DEFAULT_THREADS = 60;
export const DIFF_MAX_THREADS = 200;
/** Tin Pancake mới hơn mốc này chưa kịp tới qua webhook — đếm riêng «quá mới», không tính thiếu (độ trễ thật vài giây). */
export const DIFF_TOO_FRESH_MS = 2 * 60_000;
/** Cửa sổ khớp theo chữ (tiếng vọng bot / nhân viên ERP — cùng `ECHO_WINDOW_MS` của đường nhập). */
export const DIFF_TEXT_WINDOW_MS = 10 * 60_000;
/** Ngưỡng cảnh báo độ trễ webhook→sổ (P0 14/10/2026). */
export const WEBHOOK_P95_WARN_MS = 5_000;
/** Trang đầu của hộp thư (bộ lọc mặc định của page.tsx). */
export const INBOX_FIRST_PAGE = 100;

export type DiffArgs = { code: string; conv: string | null; hours: number; threads: number };

export function parseDiffArgs(argv: readonly string[]): DiffArgs | { error: string } {
  const code = (argv.find((a) => !a.startsWith("--")) ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(code)) return { error: "thiếu / sai mã tổ chức" };
  const raw = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const num = (k: string, def: number, max: number): number | null => {
    const r = raw(k);
    const n = r === undefined ? def : Number(r);
    return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
  };
  const conv = raw("conv") ?? null;
  if (conv !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conv)) return { error: "--conv phải là mã hội thoại dạng uuid" };
  const hours = num("hours", DIFF_DEFAULT_HOURS, DIFF_MAX_HOURS);
  const threads = num("threads", DIFF_DEFAULT_THREADS, DIFF_MAX_THREADS);
  if (hours === null) return { error: `--hours phải là số nguyên 1..${DIFF_MAX_HOURS}` };
  if (threads === null) return { error: `--threads phải là số nguyên 1..${DIFF_MAX_THREADS}` };
  return { code, conv: conv ? conv.toLowerCase() : null, hours, threads };
}

/** Một tin Pancake ERP lẽ ra phải có (đã qua luật `planHistoryMessages`). */
export type PcMsg = { id: string; side: "CUSTOMER" | "PAGE"; at: number; text: string };
/** Một dòng `sales_chat_inbound` của luồng. */
export type ErpRow = { messageId: string; side: TimelineSide; at: number; text: string; imported: boolean };

export type ThreadDiff = {
  pancake: { CUSTOMER: number; PAGE: number };
  erp: Record<TimelineSide, number>;
  matchedById: { CUSTOMER: number; PAGE: number };
  matchedByText: { CUSTOMER: number; PAGE: number };
  tooFresh: number;
  missing: PcMsg[];
  /** Dòng ERP trong cửa sổ không khớp tin Pancake nào (mã tạm `bot-out:` / `staff-out:` không tính — đó là bản ghi của ERP). */
  extra: ErpRow[];
  /** Độ trễ webhook→sổ (ms) của tin khách khớp theo mã, KHÔNG phải dòng nhập lịch sử. */
  latencies: number[];
  lastPancakeAt: number | null;
  lastErpAt: number | null;
  lastPancakeCustomerAt: number | null;
};

const ws = (s: string) => s.replace(/\s+/g, " ").trim();
const ERP_OWN_PREFIX = /^(bot-out|staff-out):/;

/**
 * So tin Pancake với dòng sổ ERP của CÙNG luồng. Cửa sổ so = từ tin Pancake cũ nhất đã đọc (trang tin đầu của Pancake chỉ chứa các tin
 * gần nhất) — dòng ERP cũ hơn nằm ngoài phép so. Khớp theo mã trước; tin phía page chưa khớp thì khớp theo chữ với dòng bot / nhân
 * viên / page trong 10 phút, mỗi dòng ERP dùng một lần. HÀM THUẦN.
 */
export function diffThread(pc: readonly PcMsg[], erp: readonly ErpRow[], nowMs: number): ThreadDiff {
  const out: ThreadDiff = {
    pancake: { CUSTOMER: 0, PAGE: 0 },
    erp: { CUSTOMER: 0, BOT: 0, STAFF: 0, PAGE: 0 },
    matchedById: { CUSTOMER: 0, PAGE: 0 },
    matchedByText: { CUSTOMER: 0, PAGE: 0 },
    tooFresh: 0,
    missing: [],
    extra: [],
    latencies: [],
    lastPancakeAt: null,
    lastErpAt: null,
    lastPancakeCustomerAt: null,
  };
  if (!pc.length) {
    out.lastErpAt = erp.length ? Math.max(...erp.map((r) => r.at)) : null;
    return out;
  }
  const lo = Math.min(...pc.map((m) => m.at)) - 60_000;
  const window = erp.filter((r) => r.at >= lo);
  for (const r of window) out.erp[r.side] += 1;
  out.lastErpAt = erp.length ? Math.max(...erp.map((r) => r.at)) : null;
  const byId = new Map(window.map((r) => [r.messageId, r]));
  // Dòng ERP có thể nằm NGOÀI cửa sổ theo mốc (webhook ghi created_at = giờ nhận) mà vẫn trùng mã — tra mã trên toàn bộ.
  for (const r of erp) if (!byId.has(r.messageId)) byId.set(r.messageId, r);
  const used = new Set<string>();
  const pending: PcMsg[] = [];
  for (const m of [...pc].sort((a, b) => a.at - b.at)) {
    out.pancake[m.side] += 1;
    out.lastPancakeAt = Math.max(out.lastPancakeAt ?? 0, m.at);
    if (m.side === "CUSTOMER") out.lastPancakeCustomerAt = Math.max(out.lastPancakeCustomerAt ?? 0, m.at);
    const hit = byId.get(m.id);
    if (hit) {
      used.add(hit.messageId);
      out.matchedById[m.side] += 1;
      if (m.side === "CUSTOMER" && !hit.imported) out.latencies.push(hit.at - m.at);
      continue;
    }
    pending.push(m);
  }
  for (const m of pending) {
    const t = ws(m.text);
    const wantSides: readonly TimelineSide[] = m.side === "CUSTOMER" ? ["CUSTOMER"] : ["BOT", "STAFF", "PAGE"];
    const hit = t
      ? window.find((r) => !used.has(r.messageId) && wantSides.includes(r.side) && Math.abs(r.at - m.at) <= DIFF_TEXT_WINDOW_MS && (ws(r.text) === t || (ws(r.text).length >= 20 && t.includes(ws(r.text)))))
      : undefined;
    if (hit) {
      used.add(hit.messageId);
      out.matchedByText[m.side] += 1;
      continue;
    }
    if (nowMs - m.at < DIFF_TOO_FRESH_MS) {
      out.tooFresh += 1;
      continue;
    }
    out.missing.push(m);
  }
  out.extra = window.filter((r) => !used.has(r.messageId) && !ERP_OWN_PREFIX.test(r.messageId));
  return out;
}

/** Phân vị (nearest-rank) — `null` khi không có mẫu. HÀM THUẦN. */
export function phanVi(xs: readonly number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

/** Giờ Việt Nam «dd/MM HH:mm» của một mốc — `—` khi không có. HÀM THUẦN. */
export function vnTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const d = new Date(ms + 7 * 3_600_000).toISOString();
  return `${d.slice(8, 10)}/${d.slice(5, 7)} ${d.slice(11, 16)}`;
}

/** Giờ Việt Nam (0..23) của một mốc — để đếm tin thiếu theo giờ. HÀM THUẦN. */
export const vnHour = (ms: number) => new Date(ms + 7 * 3_600_000).getUTCHours();

const ms = (x: number | null) => (x === null ? "—" : `${Math.round(x)}`);

// ─────────────────────────── ĐỌC ───────────────────────────

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const tsOf = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
};
function pancakeMs(v: unknown): number | null {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return null;
  const t = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`);
  return Number.isFinite(t) ? t : null;
}

type Pancake = { get: (path: string) => Promise<Record<string, unknown> | null>; limited: () => boolean; failed: () => number; calls: () => number };

/** Bộ gọi Pancake CHỈ GET cho MỘT page: nghỉ 500 ms giữa các lượt, 429 ⇒ dừng hẳn, lỗi không in token. */
function pancakeClient(pageId: string, token: string): Pancake {
  let limited = false;
  let failed = 0;
  let calls = 0;
  const q = `page_access_token=${encodeURIComponent(token)}`;
  return {
    limited: () => limited,
    failed: () => failed,
    calls: () => calls,
    get: async (path) => {
      if (limited) return null;
      if (calls) await new Promise((r) => setTimeout(r, 500));
      calls += 1;
      try {
        const res = await fetch(`${PANCAKE_PAGES_API}${path}${path.includes("?") ? "&" : "?"}${q}`, { method: "GET", redirect: "manual", headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
        if (res.status === 429) {
          limited = true;
          return null;
        }
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (!res.ok || !body || body.success === false) {
          failed += 1;
          return null;
        }
        return body;
      } catch (e) {
        failed += 1;
        console.log(`Pancake lỗi: ${scrubSecrets(e instanceof Error ? e.message : String(e), [token, pageId]).slice(0, 120)}`);
        return null;
      }
    },
  };
}

async function pancakeThread(pc: Pancake, pageId: string, threadId: string, nowMs: number): Promise<PcMsg[] | null> {
  const body = await pc.get(`/v1/pages/${encodeURIComponent(pageId)}/conversations/${encodeURIComponent(threadId)}/messages`);
  if (!body || !Array.isArray(body.messages)) return null;
  const plan = planHistoryMessages(body.messages as unknown[], pageId, { nowMs, freshMs: 0, fallbackName: "" });
  return plan.rows.map((r) => ({ id: r.messageId, side: r.side, at: r.at.getTime(), text: r.text }));
}

async function erpThread(db: Db, pageId: string, threadId: string): Promise<ErpRow[]> {
  const t = schema.salesChatInbound;
  const rows = await db
    .select({ messageId: t.messageId, note: t.note, text: t.text, createdAt: t.createdAt, importedAt: t.importedAt })
    .from(t)
    .where(and(eq(t.pageId, pageId), eq(t.threadId, threadId)))
    .orderBy(desc(t.createdAt))
    .limit(2000);
  return rows.map((r) => ({ messageId: r.messageId, side: inboundSide(r.note, r.messageId), at: r.createdAt.getTime(), text: r.text, imported: r.importedAt !== null }));
}

type ListCheck = { ok: true; positions: Partial<Record<InboxFilter, number | null>>; counts: Record<InboxFilter, number>; firstPageIds: string[] } | { ok: false; error: string };

/** ĐÚNG `listInbox` của trang trong ngữ cảnh tổ chức, handle chỉ đọc. `filters` = các thẻ cần dò vị trí của `target`. */
async function inboxCheck(org: { code: string; name: string; isHome: boolean; brand?: "vnx" | "chotdon" | null }, target: string | null, filters: readonly InboxFilter[]): Promise<ListCheck> {
  await bindReadOnlyOrgHandle(org);
  return withOrganization(org.code, async (): Promise<ListCheck> => {
    const reader = await inboxReader(org);
    if (!reader.ok) return { ok: false, error: reader.error };
    const positions: Partial<Record<InboxFilter, number | null>> = {};
    let counts: Record<InboxFilter, number> | null = null;
    let firstPageIds: string[] = [];
    for (const f of filters) {
      const r = await listInbox(reader.user, { filter: f, channel: null, q: "", label: null, page: null, phone: null, level: null, assignee: null, period: null, from: null, to: null, limit: INBOX_FIRST_PAGE, handler: null });
      if (!r.ok) return { ok: false, error: `listInbox(${f}): ${r.error}` };
      counts ??= r.counts;
      if (f === "ALL") firstPageIds = r.rows.map((x) => x.id);
      if (target) {
        const i = r.rows.findIndex((x) => x.id === target);
        positions[f] = i >= 0 ? i + 1 : null;
      }
    }
    return { ok: true, positions, counts: counts ?? (Object.fromEntries(INBOX_FILTERS.map((f) => [f, 0])) as Record<InboxFilter, number>), firstPageIds };
  });
}

/** Nhãn của ghi chú dòng sổ tin cho kênh TÓM TẮT: chỉ các hằng của hệ thống; câu khác (lỗi gửi…) ⇒ «KHÁC» — câu gốc chỉ ở phần mã hoá. */
const KNOWN_LEDGER_LABELS: ReadonlySet<string> = new Set(["BOT_SENT", "PAGE_REPLY", "HISTORY", "MEDIA_ONLY"]);
const ledgerLabel = (v: string | null) => (v === null ? "—" : v === PAGE_REPLIED_REASON ? "PAGE_REPLIED" : KNOWN_LEDGER_LABELS.has(v) ? v : "KHÁC");

async function runConversation(db: Db, org: { code: string; name: string; isHome: boolean; brand?: "vnx" | "chotdon" | null }, convId: string, tokens: Map<string, string>) {
  const c = schema.salesChatConversations;
  const [conv] = await db
    .select({
      id: c.id,
      channel: c.channel,
      status: c.status,
      handoffReason: c.handoffReason,
      pageId: c.pageId,
      threadId: c.threadId,
      lastCustomerAt: c.lastCustomerAt,
      lastBotAt: c.lastBotAt,
      lastStaffAt: c.lastStaffAt,
      historyUntil: c.historyUntil,
      staffSeenAt: c.staffSeenAt,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      createdBy: c.createdBy,
      assignee: c.assigneeUserId,
      activity: INBOX_ACTIVITY_SQL,
    })
    .from(c)
    .where(eq(c.id, convId))
    .limit(1);
  if (!conv) {
    tomTat(`pancake-thread-diff ${org.code}: KHÔNG có hội thoại đó trong CSDL tổ chức`);
    return;
  }
  console.log(`hội thoại ${conv.id} · luồng …${(conv.threadId ?? "").slice(-6)}`);
  let unread: string = "—";
  try {
    const [u] = rowsOf<Record<string, unknown>>(await db.execute(sql`select "turn_unhandled" as u from "sales_chat_conversations" where "id" = ${convId}`));
    unread = u?.u === null || u?.u === undefined ? "NULL" : String(u.u);
  } catch {
    unread = "chưa có cột 0245";
  }
  const activity = tsOf(conv.activity);
  tomTat(
    `HỘI THOẠI · kênh ${conv.channel} · ${conv.status}${conv.handoffReason ? ` (${String(conv.handoffReason).slice(0, 30)})` : ""} · chưa đọc 0245=${unread} · phụ trách ${conv.assignee ? "có" : "không"} · tạo ${vnTime(tsOf(conv.createdAt))}${conv.createdBy ? ` bởi ${String(conv.createdBy).slice(0, 24)}` : ""}`,
  );
  tomTat(`MỐC ERP: khách ${vnTime(tsOf(conv.lastCustomerAt))} · bot ${vnTime(tsOf(conv.lastBotAt))} · nv ERP ${vnTime(tsOf(conv.lastStaffAt))} · lịch sử ${vnTime(tsOf(conv.historyUntil))} · đã xem ${vnTime(tsOf(conv.staffSeenAt))} · updated ${vnTime(tsOf(conv.updatedAt))} · HOẠT ĐỘNG (khoá xếp) ${vnTime(activity)}`);

  // Sổ tin ERP theo trạng thái / ghi chú.
  const t = schema.salesChatInbound;
  if (conv.pageId && conv.threadId) {
    const st = await db
      .select({ status: t.status, note: t.note, n: sql<number>`count(*)::int`, last: sql<Date>`max(${t.createdAt})` })
      .from(t)
      .where(and(eq(t.pageId, conv.pageId), eq(t.threadId, conv.threadId)))
      .groupBy(t.status, t.note);
    console.log(`sổ tin ERP (chi tiết): ${st.map((r) => `${r.status}/${r.note ?? "—"} ${r.n}`).join(" | ")}`);
    const ledger = st.map((r) => `${r.status}/${ledgerLabel(r.note)} ${r.n} (cuối ${vnTime(tsOf(r.last))})`).join(" · ");
    tomTat(`SỔ TIN ERP: ${ledger || "KHÔNG CÓ DÒNG NÀO"}`);
  }

  // Pancake.
  const token = conv.pageId ? tokens.get(conv.pageId) : undefined;
  if (!conv.pageId || !conv.threadId || !token) {
    tomTat(`PANCAKE: CHƯA ĐO ĐƯỢC — ${!conv.pageId || !conv.threadId ? "hội thoại không có page/luồng" : "không có token của page này"}`);
  } else {
    const pc = pancakeClient(conv.pageId, token);
    const nowMs = Date.now();
    const msgs = await pancakeThread(pc, conv.pageId, conv.threadId, nowMs);
    if (!msgs) tomTat(`PANCAKE: không đọc được tin${pc.limited() ? " (429)" : ""}`);
    else {
      const erp = await erpThread(db, conv.pageId, conv.threadId);
      const d = diffThread(msgs, erp, nowMs);
      tomTat(`TIN (cửa sổ trang tin đầu của Pancake, từ ${vnTime(msgs.length ? Math.min(...msgs.map((m) => m.at)) : null)}): Pancake khách ${d.pancake.CUSTOMER} · page ${d.pancake.PAGE} | ERP khách ${d.erp.CUSTOMER} · bot ${d.erp.BOT} · nv ERP ${d.erp.STAFF} · page ${d.erp.PAGE}`);
      tomTat(`KHỚP: theo mã khách ${d.matchedById.CUSTOMER} · page ${d.matchedById.PAGE} | theo chữ khách ${d.matchedByText.CUSTOMER} · page ${d.matchedByText.PAGE} | quá mới ${d.tooFresh}`);
      const miss = (side: "CUSTOMER" | "PAGE") => d.missing.filter((m) => m.side === side);
      tomTat(`THIẾU (có ở Pancake, không có ở ERP): khách ${miss("CUSTOMER").length} [${miss("CUSTOMER").slice(-6).map((m) => vnTime(m.at)).join(", ")}] · page ${miss("PAGE").length} [${miss("PAGE").slice(-6).map((m) => vnTime(m.at)).join(", ")}]`);
      tomTat(`THỪA (ERP có, Pancake không): ${d.extra.length} — ${d.extra.slice(0, 6).map((r) => `${r.side} ${vnTime(r.at)}`).join(", ") || "không"}`);
      tomTat(`TIN CUỐI: Pancake ${vnTime(d.lastPancakeAt)} (khách ${vnTime(d.lastPancakeCustomerAt)}) · ERP ${vnTime(d.lastErpAt)} · trễ webhook tin khách p50 ${ms(phanVi(d.latencies, 50))} ms · max ${ms(d.latencies.length ? Math.max(...d.latencies) : null)} ms (n=${d.latencies.length})`);
      if (activity !== null && d.lastPancakeAt !== null) {
        const lag = d.lastPancakeAt - activity;
        tomTat(`KHOÁ XẾP hộp thư so với tin cuối Pancake: ${lag > 60_000 ? `TỤT ${Math.round(lag / 60_000)} phút (tin mới phía Pancake không đẩy mốc hoạt động)` : "khớp (≤ 1 phút)"}`);
      }
    }
  }

  // Hộp thư.
  const all = await db.select({ n: sql<number>`count(*)::int` }).from(c).where(ne(c.channel, "TEST"));
  const [ahead] = activity !== null ? await db.select({ n: sql<number>`count(*)::int` }).from(c).where(and(ne(c.channel, "TEST"), sql`${INBOX_ACTIVITY_SQL} > ${new Date(activity)}`)) : [{ n: null as number | null }];
  const check = await inboxCheck(org, convId, INBOX_FILTERS);
  if (!check.ok) {
    tomTat(`HỘP THƯ: CHƯA ĐO ĐƯỢC — ${check.error.slice(0, 200)}`);
    return;
  }
  tomTat(`HỘP THƯ trang đầu (${INBOX_FIRST_PAGE} dòng): ${INBOX_FILTERS.map((f) => `${f} ${check.positions[f] ?? "∅"}/${check.counts[f]}`).join(" · ")}`);
  tomTat(`HẠNG nếu chỉ xếp theo tin gần nhất: ${ahead?.n === null || ahead?.n === undefined ? "—" : ahead.n + 1}/${all[0]?.n ?? "—"} · «Tất cả» xếp CHƯA ĐỌC trước (${check.counts.UNREAD} hội thoại chưa đọc đứng trên mọi hội thoại đã xử lý)`);
}

async function runOrg(db: Db, org: { code: string; name: string; isHome: boolean; brand?: "vnx" | "chotdon" | null }, hours: number, threadCap: number, tokens: Map<string, string>) {
  const nowMs = Date.now();
  const since = nowMs - hours * 3_600_000;
  const c = schema.salesChatConversations;
  let threadsSeen = 0;
  let threadsRead = 0;
  let inErp = 0;
  let notInErp = 0;
  let missCustomer = 0;
  let missPage = 0;
  let tooFresh = 0;
  let pcCustomer = 0;
  let pcPage = 0;
  let lagging = 0;
  const missByHour = new Map<number, number>();
  const latencies: number[] = [];
  const lastPc = new Map<string, number>(); // conv id ⇒ mốc tin cuối Pancake
  let limited = false;
  for (const [pageId, token] of tokens) {
    if (threadsSeen >= threadCap || limited) break;
    const pc = pancakeClient(pageId, token);
    const listed: { id: string; updated: number }[] = [];
    let cursor = "";
    for (let page = 0; page < 10 && listed.length < threadCap - threadsSeen; page++) {
      const body = await pc.get(`/v2/pages/${encodeURIComponent(pageId)}/conversations?type=INBOX&order_by=updated_at${cursor ? `&last_conversation_id=${encodeURIComponent(cursor)}` : ""}`);
      const list = (Array.isArray(body?.conversations) ? body.conversations : []) as Record<string, unknown>[];
      if (!list.length) break;
      let older = false;
      for (const x of list) {
        const u = pancakeMs(x.updated_at);
        if (u === null) continue;
        if (u < since) {
          older = true;
          continue;
        }
        if (str(x.id)) listed.push({ id: str(x.id), updated: u });
      }
      const last = str(list[list.length - 1]?.id);
      if (older || !last || last === cursor) break;
      cursor = last;
    }
    const batch = listed.slice(0, threadCap - threadsSeen);
    threadsSeen += batch.length;
    const keys = batch.map((b) => fanpageVisitorKey(pageId, b.id));
    const convs = keys.length ? await db.select({ id: c.id, visitorKey: c.visitorKey, activity: INBOX_ACTIVITY_SQL }).from(c).where(and(eq(c.channel, "FANPAGE"), sql`${c.visitorKey} in (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})`)) : [];
    const convBy = new Map(convs.map((x) => [x.visitorKey, x]));
    for (const th of batch) {
      const conv = convBy.get(fanpageVisitorKey(pageId, th.id));
      const msgs = await pancakeThread(pc, pageId, th.id, nowMs);
      if (pc.limited()) {
        limited = true;
        break;
      }
      if (!msgs) continue;
      threadsRead += 1;
      const inWin = msgs.filter((m) => m.at >= since);
      if (!inWin.length) continue;
      if (conv) inErp += 1;
      else notInErp += 1;
      const d = diffThread(msgs, await erpThread(db, pageId, th.id), nowMs);
      for (const m of d.missing) {
        if (m.at < since) continue;
        if (m.side === "CUSTOMER") missCustomer += 1;
        else missPage += 1;
        missByHour.set(vnHour(m.at), (missByHour.get(vnHour(m.at)) ?? 0) + 1);
      }
      tooFresh += d.tooFresh;
      pcCustomer += inWin.filter((m) => m.side === "CUSTOMER").length;
      pcPage += inWin.filter((m) => m.side === "PAGE").length;
      latencies.push(...d.latencies);
      if (conv && d.lastPancakeAt !== null) {
        lastPc.set(conv.id, d.lastPancakeAt);
        const act = tsOf(conv.activity);
        if (act === null || d.lastPancakeAt - act > 60_000) lagging += 1;
      }
    }
  }
  tomTat(`TOÀN TỔ CHỨC ${hours} giờ · ${tokens.size} page · luồng Pancake có cập nhật đọc được ${threadsRead}/${threadsSeen}${limited ? " · DỪNG vì 429 (số dưới chỉ trên phần đã đọc)" : ""} · có tin trong kỳ: có hội thoại ERP ${inErp} · KHÔNG có ${notInErp}`);
  tomTat(`TIN trong kỳ (theo luật nhập): Pancake khách ${pcCustomer} · page ${pcPage} | THIẾU ở ERP: khách ${missCustomer} · page ${missPage} · quá mới ${tooFresh}`);
  tomTat(`THIẾU theo giờ VN: ${[...missByHour].sort((a, b) => a[0] - b[0]).map(([h, n]) => `${h}h ${n}`).join(" · ") || "không"}`);
  const p95 = phanVi(latencies, 95);
  tomTat(`TRỄ webhook→sổ (tin khách khớp mã, không tính nhập lịch sử): p50 ${ms(phanVi(latencies, 50))} ms · p95 ${ms(p95)} ms · max ${ms(latencies.length ? Math.max(...latencies) : null)} ms (n=${latencies.length})${p95 !== null && p95 > WEBHOOK_P95_WARN_MS ? ` · CẢNH BÁO p95 > ${WEBHOOK_P95_WARN_MS / 1000} s` : ""}`);
  tomTat(`KHOÁ XẾP TỤT (tin cuối Pancake mới hơn mốc hoạt động ERP > 1 phút): ${lagging}/${lastPc.size} hội thoại`);

  // Hộp thư: trang đầu «Tất cả» so với 100 hội thoại hoạt động gần nhất và 100 luồng Pancake mới nhất.
  const top = await db.select({ id: c.id }).from(c).where(ne(c.channel, "TEST")).orderBy(desc(INBOX_ACTIVITY_SQL), desc(c.id)).limit(INBOX_FIRST_PAGE);
  const check = await inboxCheck(org, null, ["ALL"]);
  if (!check.ok) {
    tomTat(`HỘP THƯ: CHƯA ĐO ĐƯỢC — ${check.error.slice(0, 200)}`);
    return;
  }
  const first = new Set(check.firstPageIds);
  const outByActivity = top.filter((x) => !first.has(x.id)).length;
  const pcTop = [...lastPc].sort((a, b) => b[1] - a[1]).slice(0, INBOX_FIRST_PAGE);
  const outByPancake = pcTop.filter(([id]) => !first.has(id)).length;
  tomTat(`HỘP THƯ «Tất cả» trang đầu ${check.firstPageIds.length} dòng · chưa đọc ${check.counts.UNREAD}/${check.counts.ALL} · trong 100 hoạt động gần nhất theo ERP KHÔNG lên trang đầu ${outByActivity} · trong ${pcTop.length} luồng Pancake mới nhất KHÔNG lên ${outByPancake}`);
}

async function main() {
  const args = parseDiffArgs(process.argv.slice(2));
  if ("error" in args) {
    tomTat(`pancake-thread-diff: DỪNG · cách dùng sai — ${args.error} (arg: <mã tổ chức> [--conv=<uuid>] [--hours=1..${DIFF_MAX_HOURS}] [--threads=1..${DIFF_MAX_THREADS}])`);
    process.exit(64);
  }
  const org = await findOrganization(args.code);
  if (!org) {
    tomTat(`pancake-thread-diff: DỪNG · không có tổ chức «${args.code}»`);
    process.exit(1);
  }
  const db: Db = await getDbForInspection({ code: org.code, isHome: org.isHome });
  const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") !== "on") {
    tomTat("pancake-thread-diff: DỪNG · phiên CSDL KHÔNG ở chế độ chỉ đọc — không đọc gì");
    process.exit(70);
  }
  const { tokens } = await pageTokensForOffboard(db, org.code, FANPAGE_CONNECTOR);
  tomTat(`pancake-thread-diff ${org.code} · ${args.conv ? "MỘT hội thoại" : `toàn tổ chức ${args.hours} giờ · tối đa ${args.threads} luồng`} · page có token ${tokens.size}`);
  if (args.conv) await runConversation(db, org, args.conv, tokens);
  else if (!tokens.size) tomTat("PANCAKE: CHƯA ĐO ĐƯỢC — không page Pancake nào có token");
  else await runOrg(db, org, args.hours, args.threads, tokens);
  // Hội thoại đã đọc gần đây nhất trong sổ — để biết lượt đo có đang nhìn đúng tổ chức sống không.
  const [fresh] = await db.select({ last: sql<Date>`max(${schema.salesChatInbound.createdAt})` }).from(schema.salesChatInbound).where(gte(schema.salesChatInbound.createdAt, new Date(Date.now() - 86_400_000)));
  tomTat(`dòng sổ tin mới nhất của tổ chức: ${vnTime(tsOf(fresh?.last))} · ghi chú: «quá mới» = tin < ${DIFF_TOO_FRESH_MS / 60_000} phút (chưa kịp tới), không tính thiếu`);
  process.exit(0);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch((e) => {
    console.log(`LỖI: ${e instanceof Error ? scrubSecrets(e.message, []).slice(0, 300) : "lỗi"}`);
    tomTat("pancake-thread-diff: LỖI ngoài phép đo — chi tiết trong phần mã hoá");
    process.exit(1);
  });
}

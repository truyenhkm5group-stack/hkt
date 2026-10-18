/*
  ops `conv-money-trace` — TRUY VẾT TIỀN + NGUỒN GỐC TỪNG TIN BOT CỦA MỘT HỘI THOẠI BÁN HÀNG (CHỈ ĐỌC).

  Vì sao có (P0 14/10/2026, HSLC): hai ca cùng mẫu —
   · «Châu Dương» (đơn #91F3641C): shop báo 1kg 280.000 ₫ · 2kg 540.000 ₫, khách lấy 1kg, bot báo TỔNG 640.000 ₫ + miễn ship; kiểm
     toán nói «đơn: MISMATCH» (câu bot ≠ đơn) mà quét lệch giá nói đơn giá đúng ⇒ con số sai nằm ở CHỮ, không ở đơn.
   · «Viet Nguyen Thi» (đơn #899250E3): khách đủ món + SĐT + địa chỉ, bot gửi câu upsell rồi TỰ nói «Dạ, anh/chị nói rõ hơn giúp em
     nhé» (EMPTY_REPLY_TEXT của engine) khi khách không nhắn gì mới.
  `sales-lifecycle-audit` chỉ đếm đường trả lời; nó không nói số tiền trong câu đến từ đâu, câu nào là câu cố định của máy, và lượt
  nào được kích hoạt bởi cái gì. Script này dựng LẠI dòng thời gian của MỘT hội thoại:

   1. TIN PHÍA FANPAGE (`sales_chat_inbound`): mốc, loại dòng (khách / PAGE_REPLY / BOT_SENT / MEDIA_ONLY), trạng thái xử lý + ghi chú
      máy, người gửi (sender_kind · transport · người gửi = chính page?), có ảnh, số lượt thử, chữ TRÙNG một dòng trước (băm), số
      tiền VND trong chữ. Không in chữ, không in mã người gửi.
   2. LỊCH SỬ CỦA BOT (`sales_chat_messages`) theo seq: tin khách của lượt (băm + có trùng tin khách trước / trùng chữ bot · page ⇒
      ECHO), mỗi tin bot: NGUỒN THẬT — câu cố định của engine (EMPTY_REPLY «nói rõ hơn» · câu an toàn claim-guard · câu giữ đơn ·
      câu chuyển người · câu AI hỏng · quá vòng công cụ) hay câu mẫu (khớp mẫu đang có) hay chữ model hay câu chép từ page
      («[Shop đã nhắn]»); số tiền VND + số nào là «tổng»; mỗi số thuộc tập nào của hàng rào số tiền LÚC ĐỌC (báo giá hội thoại
      `state.quote` · giá công cụ đã trả `state.priceFacts` · tập tham chiếu danh mục `referenceAmounts`) — số «tổng» khác tổng báo
      giá / tổng đơn được đánh dấu LỆCH.
   3. CÔNG CỤ: tên, OK / LỖI + tóm tắt máy (chỉ công cụ tiền / câu mẫu), dòng giỏ / nháp (mẫu mã theo DANH MỤC, SL, đơn giá, giảm,
      thành tiền), tiền hàng · ship · COD.
   4. SỰ KIỆN (`sales_conversation_events`): loại, mode, công cụ, số tiền, lý do.
   5. TRẠNG THÁI hiện tại: báo giá gần nhất · đơn nháp (dòng + báo giá nháp + tổng khách đã thấy) · chốt · giỏ có thẩm quyền (#819 —
      chỉ món đã gắn mẫu mã mới in tên) · upsell.
   6. ĐƠN nối với hội thoại (khoá bot · ô đơn của hội thoại · `--order=<mã ngắn>`): dòng hàng, SL, đơn giá, giảm, phí ship, tổng,
      báo giá lưu trong đơn.
   7. CÂU MẪU đang có: mã · có SỐ TIỀN CỐ ĐỊNH gõ trong câu (không phải ô điền giá) không — câu mẫu không đi qua báo giá giỏ.

  `--scan --days=N` (mặc định 3, trần 30): đếm trên mọi hội thoại có hoạt động trong N ngày — (A) câu «nói rõ hơn» của engine, tách:
  có / KHÔNG có tin khách mới kể từ tin bot trước; (B) tin bot có số «tổng» khác tổng báo giá / tổng đơn nháp ngay sau đó. Mã hội
  thoại mẫu chỉ ở phần MÃ HOÁ.

  KHÔNG in tên, SĐT, địa chỉ, chữ tin. ĐƯỢC in: số tiền VND, tên sản phẩm / mẫu mã trong danh mục, số lượng, nguồn gốc tin, mã hội
  thoại / mã ngắn đơn. Vẫn MÃ HOÁ cả lượt; [ops:tom-tat] là số. CHỈ ĐỌC do Postgres ép (`ERP_READ_ONLY=1` trước lần mở kết nối đầu
  tiên + hỏi lại phiên); hàm lib đọc qua `getDb()` chạy trên handle CHỈ ĐỌC gắn cho tổ chức rồi `withOrganization`.

  arg: `<mã tổ chức> --conv=<uuid> [--order=<mã ngắn 8 ký tự>]` hoặc `<mã tổ chức> --scan [--days=1..30]`.
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("conv-money-trace.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { createHash } from "node:crypto";
import { and, asc, eq, gte, inArray, like, or, sql, type SQL } from "drizzle-orm";
import { getDbForInspection, schema, type Db } from "@/db";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import { CLAIM_SAFE_TEXT, extractVndAmounts } from "@/lib/sales-chatbot/claim-guard";
import { EMPTY_REPLY_TEXT, loadSalesChatbotConfig, SHOP_SAID } from "@/lib/sales-chatbot/engine";
import { catalogReferenceAmounts } from "@/lib/sales-chatbot/quote";
import { listQuickReplies, loadFocusProducts } from "@/lib/sales-chatbot/quick-replies";
import { fitsFocus, productFocusOf, quickReplyCovers, type FocusLine, type FocusProduct } from "@/lib/sales-chatbot/quick-reply-focus";
import { parsePlaceholders } from "@/lib/sales-chatbot/quick-replies-shared";
import { foldVi } from "@/lib/sales-chatbot/text";
import { DEFAULT_SHIPPING_ROUTING } from "@/lib/constants/shipping-routing";
import { addressReviewOpenOf, decideShippingRoute, orderReviewOpenOf } from "@/lib/shipping/route";
import { rowsOf } from "@/lib/sql-rows";

/** Tên lỗi in được ra kênh công khai: CHỈ dạng «<nhóm đã biết>: <lý do>» của tools.ts, không chữ số, không ngoặc trích / @. Tên lỗi sau
 *  này nội suy dữ liệu khách mà không theo dạng ấy thì không lọt (kho PUBLIC). */
const SAFE_ERROR_TITLE = /^(?:Lưu khách|Đơn nháp|Sửa đơn|Chốt|Khách cũ): [^\d«»"'@:]{1,60}$|^Đơn đã chốt$/u;
const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);
const vnd = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) ? `${Math.round(n).toLocaleString("vi-VN")} ₫` : "—");

export const TRACE_DEFAULT_SCAN_DAYS = 3;
export const TRACE_MAX_SCAN_DAYS = 30;
export const TRACE_MAX_SCAN_CONVERSATIONS = 3000;
const USAGE = `<mã tổ chức> --conv=<uuid> [--order=<mã ngắn>] | <mã tổ chức> --scan [--days=1..${TRACE_MAX_SCAN_DAYS} | --since=<ISO UTC>]`;

// ─────────────────────────── PHẦN THUẦN ───────────────────────────

export type TraceArgs = { code: string; conv: string | null; order: string | null; scan: boolean; days: number; since?: Date; at?: Date; windowMin?: number };

export function parseTraceArgs(argv: readonly string[]): TraceArgs | { error: string } {
  const code = (argv.find((a) => !a.startsWith("--")) ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(code)) return { error: "thiếu / sai mã tổ chức" };
  const val = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const conv = val("conv") ?? null;
  if (conv !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conv)) return { error: "--conv phải là mã hội thoại dạng uuid" };
  const order = (val("order") ?? "").replace(/^#/, "") || null;
  if (order !== null && !/^[0-9a-f]{8}$/i.test(order)) return { error: "--order phải là mã ngắn 8 ký tự (vd 91F3641C)" };
  const scan = argv.includes("--scan");
  // `--at=<ISO UTC> [--window=phút]`: tìm hội thoại theo MỐC GIỜ chủ shop báo («khoảng 17:06») — KHÔNG nhận tên khách ở ô arg (kho PUBLIC,
  // ô arg hiện ở trang lượt chạy). Danh sách + chữ tin chỉ ở phần MÃ HOÁ; [ops:tom-tat] chỉ số đếm.
  const rawAt = val("at");
  let at: Date | undefined;
  if (rawAt !== undefined) {
    at = new Date(rawAt);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/.test(rawAt) || Number.isNaN(at.getTime())) return { error: "--at phải là mốc UTC dạng 2026-10-18T10:06Z" };
  }
  const rawWin = val("window");
  const windowMin = rawWin === undefined ? 15 : Number(rawWin);
  if (!Number.isInteger(windowMin) || windowMin < 1 || windowMin > 120) return { error: "--window phải là số phút nguyên 1..120" };
  if (!scan && !conv && !order && !at) return { error: "cần --conv=<uuid>, --order=<mã ngắn>, --at=<mốc UTC> hoặc --scan" };
  const rawDays = val("days");
  const days = rawDays === undefined ? TRACE_DEFAULT_SCAN_DAYS : Number(rawDays);
  if (!Number.isInteger(days) || days < 1 || days > TRACE_MAX_SCAN_DAYS) return { error: `--days phải là số nguyên 1..${TRACE_MAX_SCAN_DAYS}` };
  // `--since=<ISO UTC>` (thay `--days`): đo đúng khoảng SAU một lượt deploy — cửa sổ «N ngày» trùm cả trước bản sửa nên không nói được bản sửa có ăn không.
  const rawSince = val("since");
  let since: Date | undefined;
  if (rawSince !== undefined) {
    since = new Date(rawSince);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/.test(rawSince) || Number.isNaN(since.getTime())) return { error: "--since phải là mốc UTC dạng 2026-10-14T08:10Z" };
  }
  return { code, conv: conv?.toLowerCase() ?? null, order: order?.toLowerCase() ?? null, scan, days, ...(since ? { since } : {}), ...(at ? { at, windowMin } : {}) };
}

type Block = { type?: unknown; text?: unknown; name?: unknown; input?: unknown; id?: unknown; toolUseId?: unknown; content?: unknown; isError?: unknown };
const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : []);
export const textOf = (content: unknown) =>
  blocksOf(content)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => String(b.text))
    .join("\n")
    .trim();

/** Băm ngắn của chữ đã chuẩn hoá — so trùng mà không in chữ. HÀM THUẦN. */
export const hashText = (t: string) => createHash("sha256")["update"](foldVi(t).replace(/\s+/g, " ").trim()).digest("hex").slice(0, 8);

/** Cụm đứng ngay trước một số tiền làm nó là «TỔNG phải trả» (đã bỏ dấu). «tổng tiền hàng» / «tạm tính» là tiền hàng, không phải tổng. */
const TOTAL_CUE_RE = /(?:^| )(?:tong +cong|tong +tien(?! +hang)|tong +don|tong +thanh +toan|tong(?! +tien +hang)|can +thanh +toan|thanh +toan|tat +ca +la|het +tat +ca|cod|thu +ho)(?= |$)/g;

/** Bỏ dấu GIỮ NGUYÊN độ dài (mỗi ký tự ra đúng một ký tự) — chỉ số trên chữ đã bỏ dấu dùng được trên chữ gốc. HÀM THUẦN. */
export function foldKeepLength(s: string): string {
  let out = "";
  for (const ch of s) {
    const b = ch.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
    out += b.length === 1 && /[a-z0-9]/.test(b) ? b : ch.length === 1 ? " " : " ".repeat(ch.length);
  }
  return out;
}

/**
 * Số tiền mang nghĩa «TỔNG» trong một câu bot: đoạn sau cụm tổng (tới hết dòng / câu); có «=» ⇒ lấy phần sau dấu «=» cuối; lấy số
 * ĐẦU TIÊN của phần đó. HÀM THUẦN. (Bản kiểm của máy chủ nằm ở claim-guard; đây là bản ĐỌC cho truy vết — không chặn gì.)
 */
export function totalClaimsIn(text: string): number[] {
  const out: number[] = [];
  for (const seg of text.normalize("NFC").split(/\n|[.!?]\s+(?=\p{Lu})/u)) {
    const folded = foldKeepLength(seg);
    TOTAL_CUE_RE.lastIndex = 0;
    const m = TOTAL_CUE_RE.exec(folded);
    if (!m) continue;
    let rest = seg.slice(m.index + m[0].length);
    const eqAt = rest.lastIndexOf("=");
    if (eqAt >= 0) rest = rest.slice(eqAt + 1);
    const first = extractVndAmounts(rest)[0];
    if (typeof first === "number") out.push(first);
  }
  return [...new Set(out)];
}

export type FixedTextKind = "EMPTY_REPLY" | "CLAIM_SAFE" | "CART_HOLD" | "HANDOFF" | "AI_DOWN" | "TOOL_ROUNDS" | "SHOP_SAID";

/** Câu cố định của máy (không phải chữ model) — nhận theo đúng hằng số đang chạy. HÀM THUẦN. */
export function fixedTextKind(text: string, extra: { handoff?: string | null; aiDown?: string | null } = {}): FixedTextKind | null {
  const t = text.trim();
  if (t.startsWith(SHOP_SAID)) return "SHOP_SAID";
  if (t === EMPTY_REPLY_TEXT) return "EMPTY_REPLY";
  if ((Object.values(CLAIM_SAFE_TEXT) as string[]).includes(t)) return "CLAIM_SAFE";
  if (/^Dạ, (?:em giữ đơn|mình lấy) .+ như (?:mình )?đã chọn nhé\.$/u.test(t)) return "CART_HOLD";
  if (extra.handoff && t === extra.handoff.trim()) return "HANDOFF";
  if (extra.aiDown && t === extra.aiDown.trim()) return "AI_DOWN";
  if (t.startsWith("Dạ em cần kiểm thêm")) return "TOOL_ROUNDS";
  return null;
}

/** Phần chữ CỐ ĐỊNH đầu câu mẫu (trước ô điền giá đầu tiên) — để nhận câu mẫu đã gửi mà không cần mã. HÀM THUẦN. */
export function quickReplyHead(answer: string): string {
  const ph = parsePlaceholders(answer)[0];
  const head = ph ? answer.slice(0, answer.indexOf(ph.raw)) : answer;
  return foldVi(head).replace(/\s+/g, " ").trim().slice(0, 40);
}

/**
 * D — CÂU MẪU SAI MÓN (P0 18/10/2026, ca «ThanhPhương»): tin bot vừa gửi trùng đầu câu của câu mẫu nào, và mọi câu mẫu trùng đều nói về
 * món KHÁC món khách đang hỏi (cùng luật `quick-reply-focus.ts` của lượt sống) ⇒ trả câu mẫu đó; không trùng / đúng món / chưa rõ món ⇒
 * `null`. Đầu câu ngắn hơn 12 ký tự không dùng (trùng nhầm). HÀM THUẦN.
 */
export function wrongProductTemplate<T extends { title: string; answer: string; head: string }>(sent: string, lines: readonly FocusLine[], templates: readonly T[], products: readonly FocusProduct[]): T | null {
  const head = foldVi(sent).replace(/\s+/g, " ").trim().slice(0, 40);
  const hits = templates.filter((t) => t.head.length >= 12 && head.startsWith(t.head));
  if (!hits.length) return null;
  const focus = productFocusOf(lines, products);
  if (!focus.focus.length && !focus.declined.length) return null;
  const wrong = hits.filter((t) => !fitsFocus(quickReplyCovers(t, products), focus));
  return wrong.length === hits.length ? wrong[0] : null;
}

/** Số tiền CỐ ĐỊNH gõ trong câu mẫu (ngoài ô điền giá) — câu mẫu không đi qua báo giá giỏ. HÀM THUẦN. */
export function fixedAmountsInTemplate(answer: string): number[] {
  let rest = answer;
  for (const p of parsePlaceholders(answer)) rest = rest.split(p.raw).join(" ");
  return [...new Set(extractVndAmounts(rest))];
}

export type AmountSets = { quote: ReadonlySet<number>; facts: ReadonlySet<number>; reference: ReadonlySet<number> };
/** Nhãn tập của một số tiền: Q báo giá hội thoại · F giá công cụ · R tham chiếu danh mục · — không thuộc tập nào. HÀM THUẦN. */
export function amountTag(n: number, s: AmountSets): string {
  const tags = [s.quote.has(n) ? "Q" : "", s.facts.has(n) ? "F" : "", s.reference.has(n) ? "R" : ""].join("");
  return tags || "—";
}

type LineView = { variant_id?: unknown; name?: unknown; quantity?: unknown; unit_price?: unknown; discount?: unknown; line_total?: unknown };
/** Dòng giỏ / nháp + tổng trong kết quả công cụ (JSON). HÀM THUẦN. */
export function moneyOfToolResult(raw: unknown): { lines: { variantId: string; quantity: number; unitPrice: number | null; discount: number; lineTotal: number | null }[]; subtotal: number | null; shipping: number | null; total: number | null; summary: string; deliver: string | null; error: boolean } | null {
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const src = (p.cart && typeof p.cart === "object" ? (p.cart as Record<string, unknown>) : p) as Record<string, unknown>;
  const lines = (Array.isArray(src.lines) ? (src.lines as LineView[]) : []).map((l) => ({ variantId: String(l.variant_id ?? ""), quantity: Number(l.quantity ?? 0), unitPrice: num(l.unit_price), discount: num(l.discount) ?? 0, lineTotal: num(l.line_total) }));
  return { lines, subtotal: num(src.subtotal), shipping: num(src.shipping_fee), total: num(src.cod_total ?? src.total), summary: typeof p.__summary === "string" ? p.__summary : "", deliver: typeof p.__deliver === "string" ? p.__deliver : null, error: typeof p.error === "string" };
}

// ─────────────────────────── ĐỌC ───────────────────────────

type DbHolder = { __erpDb?: { orgs?: Map<string, { db?: Db }> } };
/** Handle CHỈ ĐỌC cho tổ chức (cùng cách scripts/inbox-perf-probe.ts) — hàm lib dùng `getDb()` đọc qua handle này. */
async function bindReadOnlyOrgHandle(org: { code: string; isHome: boolean }, db: Db): Promise<void> {
  if (org.isHome) return;
  const holder = (globalThis as unknown as DbHolder).__erpDb;
  if (!holder || typeof holder !== "object") throw new Error("Không thấy sổ handle CSDL của db/index.ts — dừng.");
  const orgs = (holder.orgs ??= new Map());
  if (!(orgs instanceof Map)) throw new Error("Sổ handle CSDL tổ chức đổi cấu trúc — dừng.");
  if (!orgs.get(org.code)?.db) orgs.set(org.code, { db });
}

type Ctx = { names: Map<string, string>; reference: Set<number>; handoffText: string | null; aiDownText: string | null; templates: { code: string; head: string; fixed: number[]; title: string }[] };

async function loadCtx(db: Db): Promise<Ctx> {
  const cfg = await loadSalesChatbotConfig();
  const reference = await catalogReferenceAmounts(cfg).catch(() => new Set<number>());
  const pv = schema.productVariants;
  const pr = schema.products;
  const names = new Map<string, string>();
  for (const r of await db.select({ id: pv.id, name: pr.name, detail: pv.detail, size: pv.size }).from(pv).leftJoin(pr, eq(pr.id, pv.productId)).limit(20_000)) names.set(r.id, `${r.name ?? "?"}${r.detail || r.size ? ` · ${r.detail || r.size}` : ""}`);
  const rows = await listQuickReplies().catch(() => []);
  const templates = rows.map((r, i) => ({ code: `#${i + 1}${r.active ? "" : "(tắt)"}`, head: quickReplyHead(r.answer), fixed: fixedAmountsInTemplate(r.answer), title: r.title }));
  const handoffText = typeof (cfg as { handoff?: { message?: unknown } }).handoff?.message === "string" ? String((cfg as { handoff: { message: string } }).handoff.message) : null;
  return { names, reference, handoffText, aiDownText: null, templates };
}

const shortOrder = (id: string | null | undefined) => (id ? (id.startsWith("erp-") ? `#${id.slice(4, 12).toUpperCase()}` : `${id.slice(0, 10)}…`) : "—");

export async function traceConversation(db: Db, convId: string, orderShort: string | null, ctx: Ctx) {
  const c = schema.salesChatConversations;
  const [conv] = await db.select().from(c).where(eq(c.id, convId)).limit(1);
  if (!conv) {
    tomTat("conv-money-trace: DỪNG · không có hội thoại này trong tổ chức đã chọn");
    return false;
  }
  const st = (conv.state ?? {}) as Record<string, unknown>;
  const quote = st.quote as { id?: string; verified?: boolean; subtotal?: number; total?: number | null; amounts?: number[]; at?: string } | undefined;
  const draft = st.draft as { orderId?: string | null; lines?: { variantId: string; quantity: number }[]; unitPrices?: Record<string, number>; quote?: { id?: string; subtotal?: number; total?: number | null }; seenTotal?: number; shownTurn?: number; firstShownTurn?: number } | undefined;
  const confirmed = st.confirmed as { orderId?: string | null; total?: number; at?: string; auto?: boolean; valid?: boolean } | undefined;
  const cart = st.cart as { selectedItems?: { productId?: string | null; variantId?: string | null; quantity?: number; unit?: string; customerExplicit?: boolean; sourceMessageId?: number | null; label?: string }[]; turn?: number | null; at?: string; relaxedTurn?: number | null } | undefined;
  const sets: AmountSets = { quote: new Set(quote?.verified ? (quote.amounts ?? []) : []), facts: new Set(Array.isArray(st.priceFacts) ? (st.priceFacts as number[]) : []), reference: ctx.reference };
  const variantLabel = (v: string) => ctx.names.get(v) ?? `mẫu mã ?${v.slice(-6)}`;

  console.log(`Hội thoại ${conv.id} · kênh ${conv.channel} · trạng thái ${conv.status} · lượt ${conv.turns} · câu mẫu ${conv.quickReplies} · lời gọi AI ${conv.aiCalls} · lỗi lượt: ${conv.lastError ? conv.lastError.slice(0, 160) : "—"}`);

  // 1. Tin phía fanpage.
  const inb = schema.salesChatInbound;
  const inbound = conv.pageId && conv.threadId ? await db.select().from(inb).where(and(eq(inb.pageId, conv.pageId), eq(inb.threadId, conv.threadId))).orderBy(asc(inb.createdAt)).limit(2000) : [];
  const seenInb = new Map<string, number>();
  const inbCounts: Record<string, number> = {};
  console.log(`— Tin phía fanpage (${inbound.length}):`);
  for (const r of inbound) {
    const kind = r.note === "PAGE_REPLY" ? "PAGE" : r.note === "BOT_SENT" ? "BOT_SENT" : r.note === "MEDIA_ONLY" ? "MEDIA" : "KHÁCH";
    inbCounts[`${kind}/${r.status}`] = (inbCounts[`${kind}/${r.status}`] ?? 0) + 1;
    const h = r.text ? hashText(r.text) : "";
    const dup = h && seenInb.has(h) ? ` · TRÙNG chữ dòng #${seenInb.get(h)}` : "";
    if (h && !seenInb.has(h)) seenInb.set(h, inbound.indexOf(r) + 1);
    const amounts = extractVndAmounts(r.text);
    console.log(`  [${inbound.indexOf(r) + 1}] ${r.createdAt.toISOString()} ${kind} · ${r.status}${r.note && !["PAGE_REPLY", "BOT_SENT", "MEDIA_ONLY"].includes(r.note) ? ` (${r.note.slice(0, 80)})` : ""} · gửi ${r.senderKind ?? "?"}/${r.transport ?? "?"}${r.senderId && r.senderId === conv.pageId ? " · NGƯỜI GỬI = PAGE" : ""} · ảnh ${Array.isArray(r.imageUrls) ? r.imageUrls.length : 0} · thử ${r.attempts}${r.importedAt ? " · nhập lịch sử" : ""} · ${r.text.length} ký tự${h ? ` · băm ${h}` : ""}${dup}${amounts.length ? ` · tiền ${amounts.map(vnd).join(", ")}` : ""} · mã tin …${r.messageId.slice(-6)}`);
  }

  // 2 + 3. Lịch sử của bot.
  const m = schema.salesChatMessages;
  const msgs = await db.select({ seq: m.seq, role: m.role, content: m.content, at: m.createdAt }).from(m).where(eq(m.conversationId, conv.id)).orderBy(asc(m.seq)).limit(400);
  const userHashes = new Map<string, number>();
  const botHashes = new Set<string>([...inbound.filter((r) => r.note === "PAGE_REPLY" || r.note === "BOT_SENT").map((r) => hashText(r.text))]);
  const toolNames = new Map<string, string>();
  const src: Record<string, number> = {};
  const tools: Record<string, number> = {};
  const toolErrors: Record<string, number> = {};
  let mismatches = 0;
  let emptyNoNew = 0;
  let lastUserSeq: number | null = null;
  let userSinceBot = false;
  const latestTotal = () => quote?.total ?? null;
  let runningQuoteTotal: number | null = null;
  const bump = (o: Record<string, number>, k: string) => (o[k] = (o[k] ?? 0) + 1);
  const botLine = (seq: number, at: Date, text: string, origin: string) => {
    const fixed = fixedTextKind(text, { handoff: ctx.handoffText, aiDown: ctx.aiDownText });
    let label = fixed ? `CỐ ĐỊNH:${fixed}` : origin;
    if (!fixed && origin === "MODEL") {
      const head = foldVi(text).replace(/\s+/g, " ").trim().slice(0, 40);
      const t = ctx.templates.find((x) => x.head.length >= 12 && head.startsWith(x.head));
      if (t) label = `CÂU MẪU ${t.code} (khớp chữ)`;
    }
    bump(src, label.split(" (")[0]);
    const amounts = extractVndAmounts(text);
    const totals = totalClaimsIn(text);
    const ref = runningQuoteTotal ?? latestTotal();
    const bad = totals.filter((n) => ref !== null && n !== ref);
    if (bad.length) mismatches += 1;
    if (fixed === "EMPTY_REPLY" && !userSinceBot) emptyNoNew += 1;
    console.log(
      `  bot #${seq} ${at.toISOString()} · NGUỒN ${label} · kích hoạt bởi tin khách #${lastUserSeq ?? "—"}${userSinceBot ? "" : " (KHÔNG có tin khách mới kể từ tin bot trước)"} · ${text.length} ký tự` +
        `${amounts.length ? ` · tiền ${amounts.map((n) => `${vnd(n)}[${amountTag(n, sets)}]`).join(", ")}` : ""}${totals.length ? ` · TỔNG ${totals.map(vnd).join(", ")}${bad.length ? ` ≠ báo giá ${vnd(ref)} — LỆCH` : ref !== null ? " = báo giá" : " (chưa có báo giá giỏ)"}` : ""}`,
    );
    userSinceBot = false;
  };
  console.log(`— Lịch sử bot (${msgs.length} tin; tập số: Q báo giá hội thoại · F giá công cụ · R tham chiếu danh mục · — không thuộc tập nào):`);
  for (const x of msgs) {
    if (x.role === "user") {
      const t = textOf(x.content);
      if (t) {
        const h = hashText(t);
        const echo = botHashes.has(h) ? " · TRÙNG chữ bot/page (ECHO?)" : "";
        const dup = userHashes.has(h) ? ` · TRÙNG tin khách #${userHashes.get(h)}` : "";
        if (!userHashes.has(h)) userHashes.set(h, x.seq);
        const img = /\[Khách gửi (?:\d+ )?ảnh:/.test(t) ? " · có dòng ảnh" : "";
        const amounts = extractVndAmounts(t);
        console.log(`  khách #${x.seq} ${x.at.toISOString()} · ${t.length} ký tự · băm ${h}${img}${echo}${dup}${amounts.length ? ` · tiền ${amounts.map(vnd).join(", ")}` : ""}`);
        lastUserSeq = x.seq;
        userSinceBot = true;
      }
      for (const b of blocksOf(x.content)) {
        if (b.type !== "tool_result") continue;
        const tn = toolNames.get(String(b.toolUseId ?? "")) ?? "?";
        bump(tools, `${tn} ${b.isError ? "LỖI" : "OK"}`);
        const mo = moneyOfToolResult(b.content);
        // #871: tên lỗi của công cụ lên đơn / lưu khách là CHUỖI HẰNG trong tools.ts — đưa ra kênh tóm tắt khi không mang chữ số / ngoặc
        // trích (tức không thể chứa SĐT, địa chỉ, chữ khách). Lý do «create_draft_order LỖI 3» trước đây chỉ nằm trong phần mã hoá.
        if (b.isError && /draft|customer|confirm/.test(tn) && mo?.summary && SAFE_ERROR_TITLE.test(mo.summary)) bump(toolErrors, `${tn}: ${mo.summary}`);
        const moneyTool = /cart|draft|confirm|price|quick/.test(tn);
        const lines = mo?.lines.length ? ` · dòng ${mo.lines.map((l) => `${variantLabel(l.variantId)} × ${l.quantity} @ ${vnd(l.unitPrice)}${l.discount ? ` − ${vnd(l.discount)}` : ""} = ${vnd(l.lineTotal)}`).join(" | ")}` : "";
        const money = mo && (mo.subtotal !== null || mo.total !== null) ? ` · tiền hàng ${vnd(mo.subtotal)} · ship ${vnd(mo.shipping)} · COD ${vnd(mo.total)}` : "";
        if (mo && !b.isError && (mo.total !== null || mo.subtotal !== null) && /cart|draft|confirm/.test(tn)) runningQuoteTotal = mo.total ?? mo.subtotal;
        console.log(`    ↳ kết quả ${tn}: ${b.isError ? "LỖI" : "OK"}${moneyTool && mo?.summary ? ` «${mo.summary.slice(0, 90)}»` : ""}${lines}${money}`);
        if (mo?.deliver) botLine(x.seq, x.at, mo.deliver, `CÂU MẪU qua send_quick_reply`);
      }
      continue;
    }
    for (const b of blocksOf(x.content)) {
      if (b.type === "tool_use" && typeof b.name === "string") {
        toolNames.set(String(b.id ?? ""), b.name);
        const inp = (b.input ?? {}) as Record<string, unknown>;
        const items = Array.isArray(inp.items) ? (inp.items as { variant_id?: unknown; quantity?: unknown }[]).map((i) => `${variantLabel(String(i.variant_id ?? ""))} × ${Number(i.quantity ?? 0)}`).join(" | ") : "";
        console.log(`  gọi #${x.seq} ${x.at.toISOString()} ${b.name}${items ? ` · ${items}` : ""}${typeof inp.code === "string" ? ` · mã ${inp.code.slice(0, 8)}` : ""}${typeof inp.stage === "string" ? ` · bước ${inp.stage.slice(0, 12)}` : ""} · khoá vào: ${Object.keys(inp).slice(0, 12).join(",")}`);
      }
    }
    const t = textOf(x.content);
    if (t) botLine(x.seq, x.at, t, t.startsWith(SHOP_SAID) ? "PAGE (chép)" : "MODEL");
  }

  // 4. Sự kiện.
  const e = schema.salesConversationEvents;
  const evs = await db.select({ type: e.type, at: e.occurredAt, payload: e.payload, amount: e.amountVnd, reason: e.reasonCode, orderId: e.orderId, actor: e.actorKind }).from(e).where(eq(e.conversationId, conv.id)).orderBy(asc(e.occurredAt)).limit(500);
  console.log(`— Sự kiện (${evs.length}):`);
  for (const v of evs) {
    const p = (v.payload ?? {}) as Record<string, unknown>;
    const keys = ["mode", "tools", "reason", "code", "decision", "from", "to", "tool", "responseMs"].filter((k) => p[k] !== undefined).map((k) => `${k}=${JSON.stringify(p[k]).slice(0, 80)}`);
    console.log(`  ${v.at.toISOString()} ${v.type} · ${v.actor}${v.amount !== null ? ` · ${vnd(Number(v.amount))}` : ""}${v.reason ? ` · lý do ${v.reason}` : ""}${v.orderId ? ` · đơn ${shortOrder(v.orderId)}` : ""}${keys.length ? ` · ${keys.join(" ")}` : ""}`);
  }

  // 5. Trạng thái.
  console.log(`— Trạng thái: báo giá ${quote ? `${quote.verified ? "ĐÃ" : "CHƯA"} xác thực · tiền hàng ${vnd(quote.subtotal)} · tổng ${vnd(quote.total ?? null)} · ${quote.at ?? "?"}` : "—"} · giá công cụ đã nhớ ${sets.facts.size} số · tập tham chiếu ${ctx.reference.size} số`);
  if (draft) console.log(`  nháp ${shortOrder(draft.orderId)} · ${(draft.lines ?? []).map((l) => `${variantLabel(l.variantId)} × ${l.quantity} @ ${vnd(draft.unitPrices?.[l.variantId])}`).join(" | ")} · báo giá nháp tiền hàng ${vnd(draft.quote?.subtotal)} · tổng ${vnd(draft.quote?.total ?? null)} · khách đã thấy tổng ${vnd(draft.seenTotal)} · lượt thấy ${draft.firstShownTurn ?? "—"}/${draft.shownTurn ?? "—"}`);
  if (confirmed) console.log(`  chốt ${shortOrder(confirmed.orderId)} · tổng ${vnd(confirmed.total)} · ${confirmed.auto ? "máy tự chốt" : "theo lời đồng ý"} · qua kiểm ${confirmed.valid === undefined ? "?" : confirmed.valid ? "có" : "KHÔNG"} · ${confirmed.at ?? "?"}`);
  console.log(`  giỏ có thẩm quyền: ${cart?.selectedItems?.length ? cart.selectedItems.map((it) => `${it.variantId ? variantLabel(it.variantId) : it.productId ? "món đã gắn SP" : "(chưa gắn mẫu mã)"} ${it.quantity}${it.unit === "g" ? "g" : " gói"}${it.customerExplicit ? " · khách nói" : " · bot đề xuất"} · tin #${it.sourceMessageId ?? "—"}`).join(" | ") : "—"} · lượt ${cart?.turn ?? "—"} · nới ${cart?.relaxedTurn ?? "—"} · upsell gửi ${st.upsellSent ? `có (lượt ${String(st.upsellTurn ?? "?")})` : "không"}`);

  // 6. Đơn.
  const o = schema.orders;
  const conds: SQL[] = [eq(o.salesConversationId, conv.id)];
  for (const id of [conv.orderId, conv.draftOrderId, draft?.orderId, confirmed?.orderId]) if (id) conds.push(eq(o.id, id));
  if (orderShort) conds.push(like(o.id, `erp-${orderShort}%`));
  const orders = await db.select({ id: o.id, stage: sql<string>`${o.stage}::text`, at: o.insertedAt, total: o.totalPriceAfterDiscount, totalPrice: o.totalPrice, discount: o.totalDiscount, fee: o.shippingFee, cod: o.cod, raw: o.raw, sc: o.salesConversationId, province: o.shipProvince, ward: o.shipCommune }).from(o).where(or(...conds)).limit(20);
  const items = orders.length ? await db.select().from(schema.orderItems).where(inArray(schema.orderItems.orderId, orders.map((r) => r.id))) : [];
  for (const r of orders) {
    const raw = (r.raw ?? {}) as Record<string, unknown>;
    const rq = raw.quote as { subtotal?: number; total?: number | null; id?: string } | undefined;
    const its = items.filter((i) => i.orderId === r.id);
    console.log(`— Đơn ${shortOrder(r.id)} · ${r.stage} · ${r.at?.toISOString() ?? "?"} · nối ${r.sc === conv.id ? "khoá bot" : "ô đơn / mã ngắn"} · tiền hàng ${vnd(Number(r.totalPrice ?? 0))} · giảm ${vnd(Number(r.discount ?? 0))} · sau giảm ${vnd(Number(r.total ?? 0))} · ship ${vnd(Number(r.fee ?? 0))} · COD ${vnd(r.cod === null ? null : Number(r.cod))} · báo giá lưu ${rq ? `${vnd(rq.subtotal)} / tổng ${vnd(rq.total ?? null)}` : "—"}`);
    for (const i of its) console.log(`    ${i.variantId ? variantLabel(i.variantId) : i.productName} × ${i.quantity} @ ${vnd(Number(i.unitPrice ?? 0))} · giảm/cái ${vnd(Number(i.discountEach ?? 0))} · giảm dòng ${vnd(Number(i.totalDiscount ?? 0))} · thành tiền ${vnd(i.lineTotal === null ? null : Number(i.lineTotal))}${i.isBonus ? " · TẶNG" : ""}`);
    // CỜ CẦN KIỂM + GIỮ KHỎI VẬN ĐƠN (chủ shop 18/10/2026, ca 42f28794 «đã xác nhận mà thiếu xã»): mã cờ (danh sách đóng của
    // order-review, ngoài danh sách ⇒ KHAC), số mục đã có người gỡ, và hai câu hỏi của tuyến giao bằng ĐÚNG hàm của nó. Chỉ mã + có/không.
    // Tuyến giao hỏi bằng CHÍNH decideShippingRoute (lib/shipping/route.ts) — không viết lại luật. Cấu hình hãng / cân / vận đơn đã có
    // KHÔNG xét ở đây (mặc định, không hãng nào bật), nên chỉ đọc mã giữ của các bước ĐỊA CHỈ + CỜ; bước sau đó in «không giữ vì địa chỉ /
    // cờ». Ô xã trống ⇒ NO_WARD, kể cả khi KHÔNG có cờ (người chốt tay không gắn cờ — đúng thiết kế). Chỉ mã, không địa chỉ.
    const tuyen = decideShippingRoute(
      { isErp: true, stage: r.stage, province: String(r.province ?? ""), ward: String(r.ward ?? ""), hasLiveShipment: false, weightGrams: null, confirmedAt: null, updatedAt: new Date(), auto: null, addressReviewOpen: addressReviewOpenOf(raw), orderReviewOpen: orderReviewOpenOf(raw) },
      DEFAULT_SHIPPING_ROUTING,
      new Set(),
      new Date(),
    );
    const giu = tuyen.kind === "HOLD" && ["NOT_CONFIRMED", "ADDRESS_REVIEW", "ORDER_REVIEW", "NO_PROVINCE", "NO_WARD"].includes(tuyen.code) ? tuyen.code : "không giữ vì địa chỉ / cờ (bước hãng / cân không xét ở đây)";
    tomTat(`đơn ${shortOrder(r.id)}: ${r.stage} · cờ kiểm ${reviewCodesText(raw)} · ô tỉnh ${String(r.province ?? "").trim() ? "có" : "TRỐNG"} · ô xã ${String(r.ward ?? "").trim() ? "có" : "TRỐNG"} · tuyến giao: ${giu}`);
  }

  // 7. Câu mẫu có số tiền cố định.
  const fixedTpl = ctx.templates.filter((t) => t.fixed.length);
  for (const t of fixedTpl) console.log(`  câu mẫu ${t.code} «${t.title.slice(0, 40)}» có SỐ TIỀN CỐ ĐỊNH: ${t.fixed.map((n) => `${vnd(n)}[${amountTag(n, sets)}]`).join(", ")}`);

  const fmt = (x: Record<string, number>) => Object.entries(x).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" · ") || "0";
  tomTat(`conv-money-trace: ${conv.channel} · ${conv.status} · tin bot theo NGUỒN: ${fmt(src)}`);
  if (Object.keys(toolErrors).length) tomTat(`Lỗi công cụ (tên lỗi hằng): ${fmt(toolErrors)}`);
  tomTat(`Công cụ: ${fmt(tools)} · tin bot có số TỔNG lệch báo giá ${mismatches} · câu «nói rõ hơn» không có tin khách mới ${emptyNoNew}`);
  tomTat(`Báo giá hội thoại: ${quote ? `${quote.verified ? "xác thực" : "CHƯA xác thực"} · tiền hàng ${vnd(quote.subtotal)} · tổng ${vnd(quote.total ?? null)}` : "—"} · nháp ${draft ? `tổng ${vnd(draft.quote?.total ?? null)} · khách thấy ${vnd(draft.seenTotal)}` : "—"} · chốt ${confirmed ? vnd(confirmed.total) : "—"} · upsell ${st.upsellSent ? "đã gửi" : "chưa"}`);
  for (const r of orders) {
    const its = items.filter((i) => i.orderId === r.id);
    tomTat(`Đơn ${shortOrder(r.id)} ${r.stage}: ${its.map((i) => `${i.variantId ? variantLabel(i.variantId) : i.productName} × ${i.quantity} @ ${vnd(Number(i.unitPrice ?? 0))}${Number(i.totalDiscount ?? 0) ? ` − ${vnd(Number(i.totalDiscount))}` : ""}`).join(" | ")} · ship ${vnd(Number(r.fee ?? 0))} · tổng ${vnd(Number(r.total ?? 0) + Number(r.fee ?? 0))}`);
  }
  tomTat(`Tin fanpage: ${fmt(inbCounts)} · câu mẫu có số tiền cố định ${fixedTpl.length}/${ctx.templates.length}${fixedTpl.length ? ` (${fixedTpl.slice(0, 4).map((tp) => `${tp.code}: ${tp.fixed.map(vnd).join("/")}`).join(" · ")})` : ""}`);
  return true;
}

/** Quét mẫu chung: (A) «nói rõ hơn» có / không có tin khách mới · (B) số TỔNG trong tin bot ≠ tổng giỏ / nháp ngay trước đó. */
export async function scanPatterns(db: Db, days: number, now: Date, since?: Date) {
  const from = since ?? new Date(now.getTime() - days * 86_400_000);
  const span = since ? `từ ${since.toISOString()}` : `${days} ngày`;
  const c = schema.salesChatConversations;
  const convs = await db.select({ id: c.id }).from(c).where(gte(c.updatedAt, from)).limit(TRACE_MAX_SCAN_CONVERSATIONS + 1);
  const ids = convs.slice(0, TRACE_MAX_SCAN_CONVERSATIONS).map((x) => x.id);
  const m = schema.salesChatMessages;
  const A = { total: 0, noNew: 0, convs: new Set<string>() };
  const B = { msgs: 0, convs: new Set<string>(), noQuote: 0 };
  const D = { msgs: 0, convs: new Set<string>(), images: 0, byTitle: new Map<string, number>() };
  const tpls = (await listQuickReplies().catch(() => [])).map((r) => ({ title: r.title, answer: r.answer, head: quickReplyHead(r.answer), images: r.images.length }));
  const products = await loadFocusProducts().catch(() => [] as FocusProduct[]);
  const checkD = (conv: string, sent: string, lines: readonly FocusLine[]) => {
    const w = wrongProductTemplate(sent, lines, tpls, products);
    if (!w) return;
    D.msgs += 1;
    D.convs.add(conv);
    if (w.images) D.images += 1;
    D.byTitle.set(w.title, (D.byTitle.get(w.title) ?? 0) + 1);
  };
  for (let i = 0; i < ids.length; i += 200) {
    const rows = await db.select({ conv: m.conversationId, seq: m.seq, role: m.role, content: m.content }).from(m).where(and(inArray(m.conversationId, ids.slice(i, i + 200)), gte(m.createdAt, from))).orderBy(asc(m.conversationId), asc(m.seq));
    let cur = "";
    let userSince = false;
    let quoteTotal: number | null = null;
    let lines: FocusLine[] = [];
    for (const r of rows) {
      if (r.conv !== cur) [cur, userSince, quoteTotal, lines] = [r.conv, false, null, []];
      if (r.role === "user") {
        if (textOf(r.content)) {
          userSince = true;
          lines.push({ who: "CUSTOMER", text: textOf(r.content) });
        }
        for (const b of blocksOf(r.content)) {
          if (b.type !== "tool_result" || b.isError) continue;
          const mo = moneyOfToolResult(b.content);
          if (mo && (mo.total !== null || mo.subtotal !== null) && mo.lines.length) quoteTotal = mo.total ?? mo.subtotal;
          // Câu mẫu gửi qua công cụ là một tin bot tới khách — sau nó, «nói rõ hơn» không có tin khách mới là câu thừa.
          if (mo?.deliver) {
            userSince = false;
            checkD(r.conv, mo.deliver, lines);
            lines.push({ who: "SHOP", text: mo.deliver });
          }
        }
        continue;
      }
      const t = textOf(r.content);
      if (!t) continue;
      if (t.startsWith(SHOP_SAID)) {
        lines.push({ who: "SHOP", text: t });
        continue;
      }
      checkD(r.conv, t, lines);
      lines.push({ who: "SHOP", text: t });
      if (t === EMPTY_REPLY_TEXT) {
        A.total += 1;
        if (!userSince) {
          A.noNew += 1;
          A.convs.add(r.conv);
        }
      }
      const totals = totalClaimsIn(t);
      if (totals.length && quoteTotal === null) B.noQuote += 1;
      if (totals.some((n) => quoteTotal !== null && n !== quoteTotal)) {
        B.msgs += 1;
        B.convs.add(r.conv);
      }
      userSince = false;
    }
  }
  console.log(`Quét ${span} tới ${now.toISOString()} · ${ids.length} hội thoại`);
  console.log(`  mẫu A (≤ 20): ${[...A.convs].slice(0, 20).join(" ") || "—"}`);
  console.log(`  mẫu B (≤ 20): ${[...B.convs].slice(0, 20).join(" ") || "—"}`);
  console.log(`  mẫu D (≤ 20): ${[...D.convs].slice(0, 20).join(" ") || "—"}`);
  for (const [title, n] of [...D.byTitle.entries()].sort((a, b) => b[1] - a[1])) console.log(`  D câu mẫu «${title}»: ${n} tin`);
  tomTat(`conv-money-trace quét ${span}: ${ids.length}${convs.length > TRACE_MAX_SCAN_CONVERSATIONS ? "+" : ""} hội thoại`);
  tomTat(`A câu «nói rõ hơn» của engine: ${A.total} tin · KHÔNG có tin khách mới kể từ tin bot trước ${A.noNew} tin / ${A.convs.size} hội thoại`);
  tomTat(`B tin bot có số TỔNG ≠ tổng giỏ / nháp máy chủ ngay trước: ${B.msgs} tin / ${B.convs.size} hội thoại · số TỔNG khi chưa có giỏ / nháp nào ${B.noQuote} tin`);
  tomTat(`D câu mẫu nói về món KHÁC món khách đang hỏi: ${D.msgs} tin / ${D.convs.size} hội thoại · kèm ảnh ${D.images} tin · ${D.byTitle.size} câu mẫu khác nhau · ${tpls.length} câu mẫu · ${products.length} sản phẩm`);
  // C — P0 khách cũ mua lại (#886): lượt bình luận ĐÃ CHÉP sang hộp thư (`carryCommentTurn` gắn nhãn cố định ở đầu tin khách) và đơn được
  // gắn cờ ROUND_ABANDONED trong kỳ. Chỉ số đếm. Nhãn gõ lại ở đây (không import) vì ops lấy script từ main nhưng lib từ ảnh đang chạy;
  // tests/conv-money-trace.test.ts đối chiếu đúng chuỗi này với engine.ts.
  const [carried] = await db
    .select({ n: sql<number>`count(*)::int`, convs: sql<number>`count(distinct ${m.conversationId})::int` })
    .from(m)
    .where(and(gte(m.createdAt, from), eq(m.role, "user"), sql`${m.content}::text like ${`%${COMMENT_CARRY_LABEL}%`}`));
  const o = schema.orders;
  const [abandoned] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(o)
    .where(sql`exists (select 1 from jsonb_array_elements(coalesce(${o.raw}->'review'->'entries', '[]'::jsonb)) e where e->>'code' = 'ROUND_ABANDONED' and e->>'at' >= ${from.toISOString()})`);
  // MẪU SỐ của dòng C — chỉ từ thứ ĐÃ LƯU (sales_chat_inbound: kind · status · note). Nhánh ALREADY ghi SKIPPED + đúng câu lý do cố định;
  // nhánh bot nhắn riêng THÀNH CÔNG không có dấu riêng (DONE, ghi chú rỗng hoặc cảnh báo — chung trạng thái với nhánh khác) ⇒ in đúng tên
  // nhóm lưu được, không gọi nó là «đã nhắn». «Khách đã có hội thoại hộp thư» KHÔNG được lưu ở đâu ⇒ in «chưa ghi lại», không suy đoán.
  const ib = schema.salesChatInbound;
  // Nhóm do SQL xếp vào một danh sách ĐÓNG (không giá trị cột chữ nào ra khỏi CSDL); ngoài danh sách ⇒ KHAC.
  const nhom = await db
    .select({
      k: sql<string>`case when ${ib.status} = 'SKIPPED' and ${ib.note} like ${`${COMMENT_ALREADY_NOTE}%`} then 'ALREADY' when ${ib.status} = 'DONE' and ${ib.note} is null then 'DONE_TRONG' when ${ib.status} = 'DONE' then 'DONE_CO_GHI_CHU' when ${ib.status} = 'SKIPPED' then 'BO_QUA_KHAC' when ${ib.status} = 'DEAD' then 'HONG' when ${ib.status} in ('PENDING', 'PROCESSING') then 'DANG_CHO' else 'KHAC' end`,
      n: sql<number>`count(*)::int`,
    })
    .from(ib)
    .where(and(eq(ib.kind, "COMMENT"), gte(ib.createdAt, from)))
    .groupBy(sql`1`);
  const dem = (k: (typeof COMMENT_GROUPS)[number]) => Number(nhom.find((r) => r.k === k)?.n ?? 0);
  const tong = COMMENT_GROUPS.reduce((s, k) => s + dem(k), 0);
  tomTat(`C mẫu số: tin bình luận trong kỳ ${tong} · Pancake / nhân viên đã nhắn riêng TRƯỚC (ALREADY) ${dem("ALREADY")} · DONE không ghi chú ${dem("DONE_TRONG")} · DONE có ghi chú ${dem("DONE_CO_GHI_CHU")} · bỏ qua lý do khác ${dem("BO_QUA_KHAC")} · hỏng ${dem("HONG")} · đang chờ ${dem("DANG_CHO")} · KHÁC ${dem("KHAC")} · trong đó khách ĐÃ có hội thoại hộp thư: chưa ghi lại — không đếm được`);
  tomTat(`C bình luận mua lại chép sang hộp thư: ${carried?.n ?? 0} tin / ${carried?.convs ?? 0} hội thoại · đơn gắn cờ ROUND_ABANDONED: ${abandoned?.n ?? 0}`);
  // Kết quả TỪNG lần đưa bình luận sang hộp thư (`state.commentCarry` — engine.ts::recordCommentCarry, mã ĐÓNG; ngoài danh sách ⇒ KHAC).
  const cvc = schema.salesChatConversations;
  const kq = await db
    .select({
      k: sql<string>`case ${cvc.state}->'commentCarry'->>'outcome' when 'MOVED' then 'MOVED' when 'EXISTING_INBOX' then 'EXISTING_INBOX' when 'OPENED_NEW' then 'OPENED_NEW' when 'ALREADY_COPIED' then 'ALREADY_COPIED' when 'NO_INBOX' then 'NO_INBOX' when 'FAILED' then 'FAILED' else 'KHAC' end`,
      n: sql<number>`count(*)::int`,
      tin: sql<number>`coalesce(sum(case when (${cvc.state}->'commentCarry'->>'copied') ~ '^[0-9]+$' then (${cvc.state}->'commentCarry'->>'copied')::int else 0 end), 0)::int`,
    })
    .from(cvc)
    .where(sql`${cvc.state}->'commentCarry'->>'at' >= ${from.toISOString()}`)
    .groupBy(sql`1`);
  const kqDem = (k: string) => Number(kq.find((r) => r.k === k)?.n ?? 0);
  const kqTin = kq.reduce((s, r) => s + Number(r.tin), 0);
  tomTat(`C kết quả chép: chuyển cả hội thoại ${kqDem("MOVED")} · chép sang hộp thư ĐÃ CÓ ${kqDem("EXISTING_INBOX")} · mở hộp thư rồi chép ${kqDem("OPENED_NEW")} · đã chép từ trước ${kqDem("ALREADY_COPIED")} · không có hộp thư ${kqDem("NO_INBOX")} · lỗi ${kqDem("FAILED")} · KHÁC ${kqDem("KHAC")} · tin đã chép ${kqTin}`);
}

/** Đầu câu lý do fanpage.ts::deliverCommentReply ghi vào dòng tin khi bình luận ĐÃ được nhắn riêng (ALREADY) — bài kiểm đối chiếu. */
export const COMMENT_ALREADY_NOTE = "Bình luận đã được nhắn riêng";

/** Danh sách ĐÓNG các nhóm của mẫu số dòng C (SQL xếp; ngoài danh sách ⇒ KHAC). */
const COMMENT_GROUPS = ["ALREADY", "DONE_TRONG", "DONE_CO_GHI_CHU", "BO_QUA_KHAC", "HONG", "DANG_CHO", "KHAC"] as const;

/** Hội thoại có tin trong [at − w, at + w] — mã hội thoại + từng tin trong cửa sổ (vai · giờ · 160 ký tự) ở phần MÃ HOÁ; tóm tắt chỉ số đếm. */
async function listAround(db: Db, at: Date, windowMin: number): Promise<void> {
  const m = schema.salesChatMessages;
  const from = new Date(at.getTime() - windowMin * 60_000);
  const to = new Date(at.getTime() + windowMin * 60_000);
  const rows = await db.select({ conv: m.conversationId, seq: m.seq, role: m.role, content: m.content, at: m.createdAt }).from(m).where(and(gte(m.createdAt, from), sql`${m.createdAt} <= ${to}`)).orderBy(asc(m.conversationId), asc(m.seq)).limit(2000);
  const convs = [...new Set(rows.map((r) => r.conv))];
  tomTat(`conv-money-trace --at=${at.toISOString()} ±${windowMin}′: ${convs.length} hội thoại · ${rows.length} tin trong cửa sổ`);
  for (const c of convs) {
    console.log(`— hội thoại ${c}`);
    for (const r of rows.filter((x) => x.conv === c)) {
      const t = textOf(r.content).replace(/\s+/g, " ").trim();
      if (t) console.log(`  ${r.at.toISOString()} ${r.role === "assistant" ? "BOT " : "KHÁCH"} #${r.seq} ${t.slice(0, 160)}`);
    }
  }
}

/**
 * Cờ cần kiểm của đơn — chỉ MÃ, không chữ ghi chú, không tên người: cờ ĐANG MỞ (`raw.review.entries`) và các lượt NGƯỜI ĐÃ KIỂM
 * (`raw.reviewLog` — bấm «Xác nhận đơn» / «Huỷ đơn» xoá cờ khỏi `review` và chuyển vào đây, order-review.ts::withReviewResolved). Mã trong
 * danh sách ĐÓNG giữ nguyên, ngoài danh sách ⇒ KHAC. HÀM THUẦN.
 */
export function reviewCodesText(raw: Record<string, unknown>): string {
  const dong = new Set(["CUSTOMER_CANCELLED", "ADDRESS_UNRESOLVED", "CANCEL_BLOCKED", "PRICE_DISPUTED", "PRICE_MISMATCH", "UPSELL_UNCONSENTED", "ROUND_ABANDONED"]);
  const ma = (xs: unknown): string[] => (Array.isArray(xs) ? xs : []).map((e) => (e && typeof e === "object" && dong.has(String((e as { code?: unknown }).code ?? "")) ? String((e as { code: unknown }).code) : "KHAC"));
  const review = raw.review && typeof raw.review === "object" ? (raw.review as { entries?: unknown }) : null;
  const mo = ma(review?.entries);
  const log = Array.isArray(raw.reviewLog) ? (raw.reviewLog as Record<string, unknown>[]) : [];
  const daKiem = log.map((l) => `${l?.action === "CONFIRMED" || l?.action === "CANCELLED" ? String(l.action) : "KHAC"}:${ma(l?.entries).join("+") || "—"}`);
  return `đang mở ${mo.join("+") || "không"} · người đã kiểm ${daKiem.join(", ") || "chưa"}`;
}

/** Nhãn đầu tin khách mà `carryCommentTurn` (lib/sales-chatbot/engine.ts) gắn khi chép lượt bình luận sang hộp thư. */
export const COMMENT_CARRY_LABEL = "[Khách bình luận trên bài viết lúc ";

async function main() {
  const args = parseTraceArgs(process.argv.slice(2));
  if ("error" in args) {
    tomTat(`conv-money-trace: DỪNG · cách dùng sai — ${args.error} (arg: ${USAGE})`);
    process.stdout.write("", () => process.exit(1));
    return;
  }
  const org = await findOrganization(args.code);
  if (!org) {
    tomTat(`conv-money-trace: DỪNG · không có tổ chức «${args.code}»`);
    process.stdout.write("", () => process.exit(1));
    return;
  }
  const db: Db = await getDbForInspection({ code: org.code, isHome: org.isHome });
  const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") !== "on") {
    tomTat("conv-money-trace: DỪNG · phiên CSDL KHÔNG ở chế độ chỉ đọc — không đọc gì");
    process.stdout.write("", () => process.exit(70));
    return;
  }
  await bindReadOnlyOrgHandle({ code: org.code, isHome: org.isHome }, db);
  let ok = true;
  await withOrganization(org.code, async () => {
    if (args.scan) await scanPatterns(db, args.days, new Date(), args.since);
    // Chỉ có mã đơn ngắn (8 ký tự ĐẦU sau «erp-» như màn hình đơn, hoặc 8 ký tự CUỐI như org-order-audit in) ⇒ tìm hội thoại của đơn.
    let conv = args.conv;
    if (!conv && args.order) {
      const o = schema.orders;
      const rows = await db.select({ id: o.id, conv: o.salesConversationId }).from(o).where(or(like(o.id, `erp-${args.order}%`), like(o.id, `%${args.order}`))).limit(3);
      const convs = [...new Set(rows.map((r) => r.conv).filter((x): x is string => Boolean(x)))];
      tomTat(`conv-money-trace: --order=${args.order} khớp ${rows.length} đơn · ${convs.length} hội thoại`);
      if (convs.length !== 1) ok = false;
      else conv = convs[0];
    }
    if (!conv && args.at) await listAround(db, args.at, args.windowMin ?? 15);
    if (conv) ok = await traceConversation(db, conv, args.order, await loadCtx(db));
  });
  process.stdout.write("", () => process.exit(ok ? 0 : 1));
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch((e) => {
    console.error("conv-money-trace lỗi:", e instanceof Error ? e.message : e);
    tomTat("conv-money-trace: LỖI ngoài phép đo — chi tiết trong phần mã hoá");
    process.stdout.write("", () => process.exit(1));
  });
}

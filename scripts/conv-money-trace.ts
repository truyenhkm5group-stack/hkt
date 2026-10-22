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
import { and, asc, eq, gte, inArray, like, lte, or, sql, type SQL } from "drizzle-orm";
import { getDbForInspection, getPlatformDb, schema, type Db } from "@/db";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import { CLAIM_SAFE_TEXT, extractVndAmounts, paymentSignalInCustomerText } from "@/lib/sales-chatbot/claim-guard";
import { amountsIn, applyCustomerCartMessage, type CartCommitment } from "@/lib/sales-chatbot/cart-commitment";
import { classifyDeliveryQuestion } from "@/lib/sales-chatbot/delivery-intent";
import { EMPTY_REPLY_TEXT, loadSalesChatbotConfig, SHOP_SAID } from "@/lib/sales-chatbot/engine";
import type { OfferFacts } from "@/lib/sales-chatbot/next-best-action";
import { choiceAmountText, quantityOnlyAnswer } from "@/lib/sales-chatbot/round-check";
import { loadOfferFacts } from "@/lib/sales-chatbot/offer-facts";
import { phonesInText } from "@/lib/sales-chatbot/customer-360";
import { catalogReferenceAmounts } from "@/lib/sales-chatbot/quote";
import { listQuickReplies, loadFocusProducts, loadQuickReplySettings } from "@/lib/sales-chatbot/quick-replies";
import { fitsFocus, productFocusOf, quickReplyCovers, quickReplyFocusGuard, type FocusLine, type FocusProduct } from "@/lib/sales-chatbot/quick-reply-focus";
import { isMultiPart, looksLikeOrdering, looksWholesale, matchQuickReplyByKeyword, parsePlaceholders, type KeywordMatch, type QuickReplyEntry } from "@/lib/sales-chatbot/quick-replies-shared";
import { foldVi, sentencesOf } from "@/lib/sales-chatbot/text";
import { addressTextGiven, asksAnyAddressPart } from "@/lib/sales-chatbot/address-memory";
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
export const TRACE_MAX_REPLAY_CONVERSATIONS = 10;
const USAGE = `<mã tổ chức> --conv=<uuid> [--order=<mã ngắn>] | <mã tổ chức> --scan [--days=1..${TRACE_MAX_SCAN_DAYS} | --since=<ISO UTC>] | <mã tổ chức> --replay-quick=<uuid>[,<uuid>…]`;

// ─────────────────────────── PHẦN THUẦN ───────────────────────────

export type TraceArgs = { code: string; conv: string | null; order: string | null; scan: boolean; days: number; since?: Date; until?: Date; at?: Date; windowMin?: number; replayQuick?: string[] };

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
  // `--replay-quick=<uuid>,…` (P0 18/10/2026): PHÁT LẠI TẤT ĐỊNH bước câu mẫu của từng tin khách — bộ khớp chữ trần (như trước #898) và sau
  // luật món đang bàn, trên câu mẫu + danh mục ĐANG có. Không gọi AI, không tạo hội thoại / tin nào, không ghi gì; kèm một bộ biến thể cố định.
  const rawReplay = val("replay-quick");
  let replayQuick: string[] | undefined;
  if (rawReplay !== undefined) {
    replayQuick = rawReplay.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (!replayQuick.length || replayQuick.length > TRACE_MAX_REPLAY_CONVERSATIONS || !replayQuick.every((x) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x))) return { error: `--replay-quick nhận 1..${TRACE_MAX_REPLAY_CONVERSATIONS} mã hội thoại uuid, cách nhau dấu phẩy` };
  }
  if (!scan && !conv && !order && !at && !replayQuick) return { error: "cần --conv=<uuid>, --order=<mã ngắn>, --at=<mốc UTC>, --replay-quick=<uuid,…> hoặc --scan" };
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
  // `--until=<ISO UTC>` (cùng `--since`): đóng cửa sổ quét — so HAI cửa sổ dài bằng nhau trước / sau một lượt deploy (dòng D, E).
  const rawUntil = val("until");
  let until: Date | undefined;
  if (rawUntil !== undefined) {
    until = new Date(rawUntil);
    if (!since || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/.test(rawUntil) || Number.isNaN(until.getTime()) || until.getTime() <= since.getTime()) return { error: "--until cần --since và phải là mốc UTC SAU --since" };
  }
  return { code, conv: conv?.toLowerCase() ?? null, order: order?.toLowerCase() ?? null, scan, days, ...(since ? { since } : {}), ...(until ? { until } : {}), ...(at ? { at, windowMin } : {}), ...(replayQuick ? { replayQuick } : {}) };
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

/**
 * MẪU SỐ của dòng D + PHÁT LẠI: bước câu mẫu khớp chữ cho MỘT tin khách, trước và sau luật món đang bàn (#898). `eligible` = tin qua
 * được các luật bỏ qua THEO CHỮ của lượt sống (báo đã chuyển khoản · dấu hiệu chốt · nhiều câu) và bộ khớp chữ trần có ứng viên; luật
 * bỏ qua theo TRẠNG THÁI (đơn nháp đang lên, hậu mãi, ngữ cảnh bài viết…) không dựng lại được ở đây — số này là TRẦN TRÊN của lượt sống.
 * `wrongBefore` = câu thắng của bộ khớp trần nói về món khác món đang bàn; `wrongAfter` = như vậy sau luật — phải luôn là `false`.
 */
export type QuickDecision = { eligible: boolean; raw: string; after: string; changed: boolean; wrongBefore: boolean; wrongAfter: boolean; defaultBefore: boolean; quickAfter: boolean; sizeYield: boolean };

const matchLabel = (m: KeywordMatch) => (m.kind === "MATCH" ? `MATCH «${m.entry.title}»` : m.kind === "AMBIGUOUS" ? `AMBIGUOUS ${m.entries.map((e) => `«${e.title}»`).join(" | ")}` : "NONE");

/**
 * `sizeBlocked` (#868 trên đường câu mẫu, 19/10/2026): câu mẫu thắng sau luật món mà hỏi lại quy cách / mời gói lớn cho món khách ĐÃ chọn
 * khối lượng ⇒ lượt sống nhường AI (`quickReplySizeConflict`). Không truyền ⇒ không xét (bản quét không dựng lại giỏ từng hội thoại).
 */
export function quickDecisionAt(
  lines: readonly FocusLine[],
  entries: readonly QuickReplyEntry[],
  products: readonly FocusProduct[],
  upsellIds: readonly string[] = [],
  sizeBlocked?: (entry: QuickReplyEntry) => boolean,
): QuickDecision {
  const text = lines[lines.length - 1]?.text ?? "";
  const skipped = !text.trim() || Boolean(paymentSignalInCustomerText(text)) || looksLikeOrdering(text) || isMultiPart(text);
  const raw = skipped ? ({ kind: "NONE" } as KeywordMatch) : matchQuickReplyByKeyword(text, entries);
  const g = quickReplyFocusGuard(lines, products, upsellIds);
  const after = skipped ? ({ kind: "NONE" } as KeywordMatch) : matchQuickReplyByKeyword(text, entries.filter((e) => g.answers(e)));
  const sizeYield = after.kind === "MATCH" && Boolean(sizeBlocked?.(after.entry));
  const sends = (m: KeywordMatch) => m.kind === "MATCH" && !looksWholesale(text) && !(m === after && sizeYield);
  const afterLabel = sizeYield ? `${matchLabel(after)} ⇒ NHƯỜNG AI (khách đã chọn khối lượng)` : matchLabel(after);
  return {
    eligible: raw.kind !== "NONE",
    raw: matchLabel(raw),
    after: afterLabel,
    changed: matchLabel(raw) !== afterLabel,
    // SAI MÓN = đã biết món đang bàn mà câu mẫu nói món khác. MẶC ĐỊNH KHÔNG CĂN CỨ = chưa biết món nào mà câu mẫu gắn món tự trả lời
    // (chủ shop 18/10: không mặc định món bán chạy) — hai lỗi khác nhau, đếm riêng.
    wrongBefore: sends(raw) && raw.kind === "MATCH" && g.onTable.length > 0 && !g.fits(raw.entry),
    wrongAfter: sends(after) && after.kind === "MATCH" && (g.onTable.length > 0 ? !g.fits(after.entry) : g.coversOf(after.entry).length > 0),
    defaultBefore: sends(raw) && raw.kind === "MATCH" && g.onTable.length === 0 && g.coversOf(raw.entry).length > 0,
    quickAfter: sends(after),
    sizeYield,
  };
}

/** Biến thể cố định cho `--replay-quick` (cách khách HSLC hỏi thật + các ca chủ shop nêu). Chữ TỰ DỰNG — không phải tin khách. */
export const QUICK_REPLAY_VARIANTS: { key: string; lines: FocusLine[] }[] = [
  ...["xin giá chả cá", "Xin giá chả cá nhé shop", "Báo giá chả cá thu?", "cho xin giá chả cá thu", "chả cá bao nhiêu 1kg", "xin gia cha ca", "nem bao nhiêu", "giá nem", "ruốc tôm bao nhiêu", "1 hộp ruốc tôm", "giá chả cá với nem sao shop", "báo giá", "Xin giá 1 kg", "chả mực giá sao"].map((t) => ({ key: t, lines: [{ who: "CUSTOMER" as const, text: t }] })),
  { key: "page chả cá → báo giá", lines: [{ who: "SHOP", text: "[Shop đã nhắn] Chả cá thu Hạ Long nhà làm, nhắn shop để được báo giá ạ" }, { who: "CUSTOMER", text: "báo giá" }] },
  { key: "page chả cá → Xin giá 1 kg", lines: [{ who: "SHOP", text: "[Shop đã nhắn] Chả cá thu Hạ Long nhà làm, nhắn shop để được báo giá ạ" }, { who: "CUSTOMER", text: "Xin giá 1 kg" }] },
  { key: "từ chối nem → báo giá", lines: [{ who: "CUSTOMER", text: "chả cá thu" }, { who: "CUSTOMER", text: "không lấy nem đâu em" }, { who: "CUSTOMER", text: "báo giá" }] },
  ...["Giá bao nhiêu 1kg ạ", "xin giá", "giá sao shop", "Cho mình 1kg"].map((t) => ({ key: `hỏi chung: ${t}`, lines: [{ who: "CUSTOMER" as const, text: t }] })),
  // Chủ shop 18/10 (chốt hoàn thành): ruốc · combo nhiều món · khách cũ mua lại.
  ...["ruốc tôm 250g bao nhiêu", "ruốc cá thu còn không", "1 kg chả mực giã tay, 1 Nem hải sản tôm bề bề", "cho mình 1kg chả cá với 1 hộp ruốc tôm", "lấy như lần trước nhé", "cho chị 1kg như đợt trước"].map((t) => ({ key: t, lines: [{ who: "CUSTOMER" as const, text: t }] })),
  { key: "khách cũ: đơn trước chả cá → lấy như lần trước", lines: [{ who: "SHOP", text: "Dạ chị đặt lại chả cá thu 1kg như đơn trước ạ?" }, { who: "CUSTOMER", text: "lấy như lần trước nhé" }] },
  // #868 trên câu mẫu (19/10/2026, HSLC): khách nói khối lượng ngay trong tin ⇒ câu mẫu hỏi lại «1kg hay 2kg» phải nhường AI.
  { key: "đã chọn: cho chị 1kg chả cá thu", lines: [{ who: "CUSTOMER", text: "cho chị 1kg chả cá thu" }] },
  // #917 (20/10/2026): gõ nhầm hỏi / ngã, số trần không đơn vị, gõ hoa đầu từ — giỏ phải đọc ra Chả cá thu / Chả mực.
  ...["cho chị 1kg chã cá thu", "chã mực 2kg", "1 chả cá thu", "Lấy 2 Gói Chả Cá Thu"].map((t) => ({ key: `đã chọn: ${t}`, lines: [{ who: "CUSTOMER" as const, text: t }] })),
  { key: "shop mời nem → giá sao em", lines: [{ who: "CUSTOMER", text: "chả cá thu giá sao em" }, { who: "SHOP", text: "Dạ chả cá thu 1kg 280.000đ ạ. Chị lấy thêm nem hải sản không ạ?" }, { who: "CUSTOMER", text: "giá sao em" }] },
];

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

/**
 * Lý do «chưa gửi» của lời mời sau chốt mà lượt ĐỦ điều kiện mời (cửa sổ mở, câu dùng được) — khác HANDOFF / ghi đơn hỏng / lượt hỏng
 * (không mời là đúng) và MEDIA_SLOT_BUSY (câu mẫu khác đã gửi ảnh trong lượt).
 */
export const UPSELL_SKIP_VALID_NOT_SENT: ReadonlySet<string> = new Set(["NO_CONFIRM_MESSAGE", "GUARD_BLOCKED", "APPEND_FAILED"]);

/** Cửa sổ quanh lời mời ERP để tìm ảnh page gửi — CÙNG số với `PAGE_MEDIA_ROUND_FALLBACK_MS` (tools.ts; bài kiểm đối chiếu). */
export const UPSELL_DUP_WINDOW_HOURS = 24;

/** Câu bot XIN SĐT / XIN địa chỉ (câu nhắc lại số để xác nhận, câu «giao về … như lần trước» KHÔNG phải xin lại). HÀM THUẦN. */
export const BOT_ASKS_PHONE_RE = /(?:xin|cho em|gửi|gui|để lại|de lai|cung cấp|cung cap)[^.?!\n]{0,40}(?:số điện thoại|so dien thoai|sđt|sdt|số đt)/i;
export const BOT_ASKS_ADDRESS_RE = /(?:xin|cho em|gửi|gui|để lại|de lai|cung cấp|cung cap)[^.?!\n]{0,40}(?:địa chỉ|dia chi)/i;
export const asksPhone = (t: string) => BOT_ASKS_PHONE_RE.test(t);
export const asksAddressAgain = (t: string) => BOT_ASKS_ADDRESS_RE.test(t) && !/như lần trước|lần trước/i.test(t);

/**
 * SĐT hộp thư hiện cho hội thoại — CÙNG thứ tự với `inboxPhoneOf` (lib/sales-chatbot/known-contact.ts; ops lấy script từ main nhưng lib từ
 * ảnh đang chạy, nên chép lại ở đây và bài kiểm đối chiếu). `null` ⇒ hộp thư in «Chưa có SĐT». HÀM THUẦN.
 */
export function shownPhoneOf(p: { customerPhone?: string | null; statePhone?: string | null; knownPhone?: string | null; convPhone?: string | null }): string | null {
  for (const v of [p.customerPhone, p.statePhone, p.knownPhone, p.convPhone]) {
    const t = (v ?? "").trim();
    if (t) return t;
  }
  return null;
}

/** Cửa sổ «cùng lượt mua» của dòng O: chữ địa chỉ khách gửi quá chừng này trước tin bot không tính (bằng hạn lượt mua của bot — 3 ngày). */
export const ADDRESS_ASK_WINDOW_MS = 3 * 24 * 3_600_000;

/**
 * O · KNOWN_ADDRESS_REASKED theo AGENTS 3.12b (chủ shop chốt 22/10/2026): tin bot `botText` lúc `botAt` có HỎI / XIN bất kỳ phần nào của
 * địa chỉ trong khi khách ĐÃ gửi chữ địa chỉ (trong `ADDRESS_ASK_WINDOW_MS` trước đó). Cùng định nghĩa với điểm chặn của engine
 * (`addressTextGiven` · `asksAnyAddressPart`) — script import từ lib nên CHỈ chạy được trên image đã có PR address-resolver-ladder.
 * `null` = khách chưa gửi chữ địa chỉ (không vào mẫu số). HÀM THUẦN.
 */
export function addressAskAfterText(customer: readonly { text: string; at: number }[], botText: string, botAt: number): boolean | null {
  const texts = customer.filter((c) => c.at <= botAt && botAt - c.at <= ADDRESS_ASK_WINDOW_MS).map((c) => c.text);
  if (!addressTextGiven(texts)) return null;
  return sentencesOf(botText).some(asksAnyAddressPart);
}

export type UpsellScanRow = { pco: Record<string, unknown> | null; confirmed: Record<string, unknown> | null; cancel: unknown; declined: unknown; dispute: Record<string, unknown> | null; pageMedia: boolean };

/**
 * H · UPSELL_SKIPPED_VALID_TEMPLATE / I · UPSELL_DUPLICATE (P0 21/10/2026, ca HSLC «Mai Le») cho lượt chốt GẦN NHẤT của một hội thoại
 * (`state.postConfirmOffer` — lượt mua mới ghi đè lượt cũ). H: cửa sổ đóng CHỈ vì đơn còn chờ xác minh ĐỊA CHỈ (không huỷ · không từ chối ·
 * không tranh chấp giá), hoặc lời mời đủ điều kiện mà không đi (`UPSELL_SKIP_VALID_NOT_SENT`). I: ERP đã gửi lời mời VÀ page / Pancake gửi
 * ảnh trong ± `UPSELL_DUP_WINDOW_HOURS` giờ. HÀM THUẦN.
 */
export function upsellScanVerdict(r: UpsellScanRow): { sent: boolean; skippedValid: boolean; duplicate: boolean } {
  const p = r.pco ?? {};
  const sent = p.sent === true;
  const addressOnly = r.confirmed?.valid === false && r.confirmed?.pending === "ADDRESS" && !r.cancel && !r.declined && r.dispute?.open !== true;
  const skippedValid = (p.outcome === "ORDER_PROBLEM" && addressOnly) || (p.outcome === "NOT_SENT" && UPSELL_SKIP_VALID_NOT_SENT.has(String(p.notSentReason ?? "")));
  return { sent, skippedValid, duplicate: sent && r.pageMedia };
}

/** Quét mẫu chung: (A) «nói rõ hơn» có / không có tin khách mới · (B) số TỔNG trong tin bot ≠ tổng giỏ / nháp ngay trước đó. */
export async function scanPatterns(db: Db, days: number, now: Date, since?: Date) {
  const from = since ?? new Date(now.getTime() - days * 86_400_000);
  const span = since ? `từ ${since.toISOString()}` : `${days} ngày`;
  const c = schema.salesChatConversations;
  // Kênh TEST (khung thử của chủ shop, ops kiểm trực tiếp `org-ai-cutover --probe-set`) không phải khách thật ⇒ ngoài phép đo.
  const convs = await db.select({ id: c.id }).from(c).where(and(gte(c.updatedAt, from), sql`${c.channel} <> 'TEST'`)).limit(TRACE_MAX_SCAN_CONVERSATIONS + 1);
  const ids = convs.slice(0, TRACE_MAX_SCAN_CONVERSATIONS).map((x) => x.id);
  const m = schema.salesChatMessages;
  const A = { total: 0, noNew: 0, convs: new Set<string>() };
  const B = { msgs: 0, convs: new Set<string>(), noQuote: 0 };
  const D = { msgs: 0, convs: new Set<string>(), images: 0, byTitle: new Map<string, number>() };
  // F (P0 21/10/2026, HSLC «Lan Nguyen»): tin khách CHỈ là câu trả lời số lượng («2kg», «lấy 2» sau «1kg hay 2kg?») mà tin bot NGAY SAU lại
  // hỏi lại số lượng hoặc gửi lại một câu đã gửi trong hội thoại. Cùng định nghĩa với engine (`quantityOnlyAnswer` · `choiceAmountText`).
  // Câu mẫu = 0 token; lượt AI = một lời gọi model thừa. Mẫu số = số tin khách chỉ là câu trả lời số lượng.
  const F = { base: 0, msgs: 0, quick: 0, model: 0, convs: new Set<string>() };
  // G · UNANSWERED_SECONDARY_INTENT (P0 21/10/2026, ca «Xuân Đoàn»): tin khách có SỐ LƯỢNG + câu hỏi THỜI GIAN GIAO («Cho chị 2kg. Mấy ngày
  // nhận được hàng?») mà tin bot NGAY SAU không đụng tới chuyện giao (giao / nhận / ngày / địa chỉ / ship). Mẫu số = số tin hai ý như thế.
  const G = { base: 0, miss: 0, convs: new Set<string>() };
  // J · BANNED_REPLY_USED (P0 21/10/2026, chủ shop bỏ câu «nhân viên sẽ xác nhận lại địa chỉ»): tin bot mang đúng câu ấy. Mẫu số = số lượt
  // công cụ chốt đơn thành công (kết quả `"confirmed":true`) trong kỳ — mỗi lượt chốt là một chỗ câu ấy có thể xuất hiện.
  const J = { base: 0, msgs: 0, convs: new Set<string>() };
  // K · KNOWN_CUSTOMER_PHONE_REASK / L · KNOWN_CUSTOMER_ADDRESS_REASK / M · CUSTOMER_PROFILE_SYNC_MISMATCH (P0 21/10/2026, chủ shop: khách cũ
  // không bị xin lại SĐT / địa chỉ; hội thoại có SĐT thì hồ sơ không «Chưa có SĐT»). K: tin bot xin SĐT khi SĐT ĐÃ BIẾT CHẮC — khách tự gõ
  // trước đó trong kỳ quét, hoặc hội thoại có đơn nối chắc mang SĐT (đơn tạo trước tin bot). Mẫu số = mọi tin bot xin SĐT. L: tin bot xin
  // địa chỉ (không phải câu «như lần trước») trong hội thoại có đơn nối chắc mang địa chỉ tạo TRƯỚC tin đó hơn một ngày. Mẫu số = mọi tin
  // bot xin địa chỉ trong hội thoại có đơn như thế. M: hội thoại có tin khách chứa SĐT mà hộp thư không có SĐT nào để hiện.
  const K = { base: 0, msgs: 0, convs: new Set<string>() };
  const L = { base: 0, msgs: 0, convs: new Set<string>() };
  // O · KNOWN_ADDRESS_REASKED (AGENTS 3.12b, 22/10/2026): tin bot hỏi / xin bất kỳ phần nào của địa chỉ sau khi khách đã gửi CHỮ địa chỉ
  // (`addressAskAfterText`). Mẫu số = tin bot gửi khi khách đã có chữ địa chỉ trong cửa sổ. Chỉ đọc tin TRONG kỳ quét ⇒ chữ địa chỉ gửi
  // trước mốc `--since` không thấy ⇒ số là TRẦN DƯỚI (ESTIMATED).
  const O = { base: 0, msgs: 0, convs: new Set<string>(), ids: [] as string[] };
  const typedPhoneConvs = new Set<string>();
  const ordT = schema.orders;
  const threadOrders = new Map<string, { phoneAt: number | null; addressAt: number | null }>();
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    const rowsO = await db
      .select({ conv: ordT.salesConversationId, at: ordT.insertedAt, phone: ordT.shipPhone, bill: ordT.billPhone, addr: ordT.shipAddress })
      .from(ordT)
      .where(and(inArray(ordT.salesConversationId, part), sql`${ordT.stage} not in ('DELETED', 'CANCELLED')`));
    for (const o of rowsO) {
      if (!o.conv || !o.at) continue;
      const cur = threadOrders.get(o.conv) ?? { phoneAt: null, addressAt: null };
      const t = o.at.getTime();
      if ((o.phone ?? "").trim() || (o.bill ?? "").trim()) cur.phoneAt = cur.phoneAt === null ? t : Math.min(cur.phoneAt, t);
      if ((o.addr ?? "").trim()) cur.addressAt = cur.addressAt === null ? t : Math.min(cur.addressAt, t);
      threadOrders.set(o.conv, cur);
    }
  }
  const hashConv = (id: string) => createHash("sha256")["update"](id).digest("hex").slice(0, 8);
  const rowsQr = await listQuickReplies().catch(() => []);
  const tpls = rowsQr.map((r) => ({ title: r.title, answer: r.answer, head: quickReplyHead(r.answer), images: r.images.length }));
  const products = await loadFocusProducts().catch(() => [] as FocusProduct[]);
  // MẪU SỐ (chủ shop 18/10: «0/39 chưa phải nghiệm thu»): số tin khách mà câu mẫu ĐƯỢC XÉT, cùng câu mẫu đang bật + câu upsell hôm nay.
  const active: QuickReplyEntry[] = rowsQr.filter((r) => r.active).map((r) => ({ id: r.id, title: r.title, triggers: r.triggers, answer: r.answer }));
  const upsellId = (await loadQuickReplySettings().catch(() => null))?.upsellReplyId ?? null;
  const N = { customer: 0, eligible: 0, changed: 0, wrongBefore: 0, wrongAfter: 0, sends: 0, defaultBefore: 0, quickAfter: 0 };
  const countDecision = (lines: readonly FocusLine[]) => {
    const d = quickDecisionAt(lines, active, products, upsellId ? [upsellId] : []);
    N.customer += 1;
    if (d.eligible) N.eligible += 1;
    if (d.changed) N.changed += 1;
    if (d.wrongBefore) N.wrongBefore += 1;
    if (d.defaultBefore) N.defaultBefore += 1;
    if (d.quickAfter) N.quickAfter += 1;
    if (d.wrongAfter) N.wrongAfter += 1;
  };
  const checkD = (conv: string, sent: string, lines: readonly FocusLine[]) => {
    const head = foldVi(sent).replace(/\s+/g, " ").trim().slice(0, 40);
    if (tpls.some((t) => t.head.length >= 12 && head.startsWith(t.head))) N.sends += 1;
    const w = wrongProductTemplate(sent, lines, tpls, products);
    if (!w) return;
    D.msgs += 1;
    D.convs.add(conv);
    if (w.images) D.images += 1;
    D.byTitle.set(w.title, (D.byTitle.get(w.title) ?? 0) + 1);
  };
  for (let i = 0; i < ids.length; i += 200) {
    const rows = await db.select({ conv: m.conversationId, seq: m.seq, role: m.role, content: m.content, at: m.createdAt }).from(m).where(and(inArray(m.conversationId, ids.slice(i, i + 200)), gte(m.createdAt, from), lte(m.createdAt, now))).orderBy(asc(m.conversationId), asc(m.seq));
    let cur = "";
    let userSince = false;
    let quoteTotal: number | null = null;
    let lines: FocusLine[] = [];
    let qtyAnswer = false;
    let prevBot = "";
    let sentHeads = new Set<string>();
    let secondAsk = false;
    let phoneTyped = false;
    let custTexts: { text: string; at: number }[] = [];
    for (const r of rows) {
      if (r.conv !== cur) [cur, userSince, quoteTotal, lines, qtyAnswer, prevBot, sentHeads, secondAsk, phoneTyped, custTexts] = [r.conv, false, null, [], false, "", new Set<string>(), false, false, []];
      if (r.role === "user") {
        if (textOf(r.content)) {
          const said = textOf(r.content);
          if (phonesInText(said).length) {
            phoneTyped = true;
            typedPhoneConvs.add(r.conv);
          }
          qtyAnswer = quantityOnlyAnswer(said, []) || choiceAmountText(said, prevBot) !== null;
          if (qtyAnswer) F.base += 1;
          secondAsk = amountsIn(said).length > 0 && classifyDeliveryQuestion(said)?.intent === "DELIVERY_TIME";
          if (secondAsk) G.base += 1;
          userSince = true;
          if (r.at) custTexts.push({ text: said, at: r.at.getTime() });
          lines.push({ who: "CUSTOMER", text: textOf(r.content) });
          countDecision(lines);
        }
        for (const b of blocksOf(r.content)) {
          if (b.type !== "tool_result" || b.isError) continue;
          if (typeof b.content === "string" && b.content.includes('"confirmed":true')) J.base += 1;
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
        prevBot = t.slice(SHOP_SAID.length).trim();
        continue;
      }
      const tord = threadOrders.get(r.conv);
      const atMs = r.at ? r.at.getTime() : Number.NaN;
      if (asksPhone(t)) {
        K.base += 1;
        if (phoneTyped || (tord?.phoneAt != null && tord.phoneAt < atMs)) {
          K.msgs += 1;
          K.convs.add(r.conv);
        }
      }
      if (tord?.addressAt != null && tord.addressAt < atMs - 86_400_000 && BOT_ASKS_ADDRESS_RE.test(t)) {
        L.base += 1;
        if (asksAddressAgain(t)) {
          L.msgs += 1;
          L.convs.add(r.conv);
        }
      }
      const reask = Number.isFinite(atMs) ? addressAskAfterText(custTexts, t, atMs) : null;
      if (reask !== null) {
        O.base += 1;
        if (reask) {
          O.msgs += 1;
          if (!O.convs.has(r.conv) && O.ids.length < 20) O.ids.push(r.conv);
          O.convs.add(r.conv);
        }
      }
      if (t.includes(CLAIM_SAFE_TEXT.ORDER_PENDING_ADDRESS)) {
        J.msgs += 1;
        J.convs.add(r.conv);
      }
      const headF = foldVi(t).replace(/\s+/g, " ").trim().slice(0, 60);
      if (qtyAnswer && userSince && (/\d+(?:[.,]\d+)?\s?kg\s+hay\s+\d+(?:[.,]\d+)?\s?kg|muốn (?:mua|lấy) \d/iu.test(t) || sentHeads.has(headF))) {
        F.msgs += 1;
        F.convs.add(r.conv);
        if (tpls.some((x) => x.head.length >= 12 && headF.startsWith(x.head))) F.quick += 1;
        else F.model += 1;
      }
      if (secondAsk && userSince && !/(?:^| )(?:giao|nhan|ngay|dia chi|ship|van chuyen)(?= |$)/.test(foldVi(t))) {
        G.miss += 1;
        G.convs.add(r.conv);
      }
      secondAsk = false;
      sentHeads.add(headF);
      prevBot = t;
      qtyAnswer = false;
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
  console.log(`  mẫu F (≤ 20): ${[...F.convs].slice(0, 20).join(" ") || "—"}`);
  console.log(`  mẫu F băm (≤ 20): ${[...F.convs].slice(0, 20).map(hashConv).join(" ") || "—"}`);
  console.log(`  mẫu G (≤ 20): ${[...G.convs].slice(0, 20).join(" ") || "—"}`);
  console.log(`  mẫu G băm (≤ 20): ${[...G.convs].slice(0, 20).map(hashConv).join(" ") || "—"}`);
  console.log(`  mẫu J (≤ 20): ${[...J.convs].slice(0, 20).join(" ") || "—"}`);
  console.log(`  mẫu K (≤ 20): ${[...K.convs].slice(0, 20).join(" ") || "—"}`);
  console.log(`  mẫu L (≤ 20): ${[...L.convs].slice(0, 20).join(" ") || "—"}`);
  for (const [title, n] of [...D.byTitle.entries()].sort((a, b) => b[1] - a[1])) console.log(`  D câu mẫu «${title}»: ${n} tin`);
  tomTat(`conv-money-trace quét ${span}: ${ids.length}${convs.length > TRACE_MAX_SCAN_CONVERSATIONS ? "+" : ""} hội thoại`);
  tomTat(`F CUSTOMER_SELECTED_QUANTITY_BUT_BOT_REASKED — trả lời số lượng ngắn mà bot hỏi lại / gửi lại câu đã gửi: ${F.msgs} tin / ${F.convs.size} hội thoại · câu mẫu ${F.quick} (0 token) · AI ${F.model} (lời gọi model thừa) · mẫu số ${F.base} tin khách chỉ là câu trả lời số lượng (MEASURED)`);
  tomTat(`G UNANSWERED_SECONDARY_INTENT — tin khách có số lượng + hỏi thời gian giao mà tin bot ngay sau không đụng tới chuyện giao: ${G.miss} tin / ${G.convs.size} hội thoại · mẫu số ${G.base} tin hai ý (MEASURED)`);
  tomTat(`K KNOWN_CUSTOMER_PHONE_REASK — tin bot xin SĐT khi SĐT đã biết chắc (khách tự gõ trước đó · đơn nối chắc mang SĐT): ${K.msgs} tin / ${K.convs.size} hội thoại · mẫu số ${K.base} tin bot xin SĐT (MEASURED — SĐT gõ TRƯỚC kỳ quét không thấy ⇒ số này là SÀN)`);
  tomTat(`L KNOWN_CUSTOMER_ADDRESS_REASK — tin bot xin lại địa chỉ (không phải câu «như lần trước») khi hội thoại có đơn nối chắc mang địa chỉ từ hơn một ngày trước: ${L.msgs} tin / ${L.convs.size} hội thoại · mẫu số ${L.base} tin bot xin địa chỉ trong các hội thoại ấy (MEASURED)`);
  tomTat(`J BANNED_REPLY_USED — tin bot mang câu «nhân viên sẽ xác nhận lại địa chỉ»: ${J.msgs} tin / ${J.convs.size} hội thoại · mẫu số ${J.base} lượt chốt đơn thành công (MEASURED)`);
  tomTat(`A câu «nói rõ hơn» của engine: ${A.total} tin · KHÔNG có tin khách mới kể từ tin bot trước ${A.noNew} tin / ${A.convs.size} hội thoại`);
  tomTat(`B tin bot có số TỔNG ≠ tổng giỏ / nháp máy chủ ngay trước: ${B.msgs} tin / ${B.convs.size} hội thoại · số TỔNG khi chưa có giỏ / nháp nào ${B.noQuote} tin`);
  tomTat(`D câu mẫu nói về món KHÁC món khách đang hỏi: ${D.msgs} tin / ${D.convs.size} hội thoại · kèm ảnh ${D.images} tin · ${D.byTitle.size} câu mẫu khác nhau · ${tpls.length} câu mẫu · ${products.length} sản phẩm`);
  tomTat(`D mẫu số: tin khách ${N.customer} · câu mẫu được xét (khớp chữ có ứng viên, trần trên) ${N.eligible} · tin bot là câu mẫu ${N.sends} · luật món đổi quyết định ${N.changed} · khớp trần sẽ sai món ${N.wrongBefore} · sau luật vẫn sai ${N.wrongAfter} (câu mẫu đang bật ${active.length})`);
  const cvq = schema.salesChatConversations;
  const [closed] = await db.select({ n: sql<number>`count(*)::int` }).from(cvq).where(sql`${cvq.state}->'quickGuardClosed'->>'at' >= ${from.toISOString()}`);
  tomTat(`D mặc định / nhường AI: khớp trần mặc định một món khi CHƯA rõ món ${N.defaultBefore} · sau luật câu mẫu tự trả lời ${N.quickAfter} / ${N.eligible} được xét · nhường AI ${N.eligible - N.quickAfter} · hội thoại câu mẫu tạm dừng vì lỗi danh mục ${closed?.n ?? 0}`);
  // #868 trên câu mẫu (19/10/2026): mỗi lần câu mẫu NHƯỜNG AI vì khách đã chọn khối lượng là MỘT lời gọi AI thay cho câu mẫu 0 token —
  // đếm từ mốc thật engine ghi (`state.quickSizeYields`), không dựng lại. Kênh thử không tính.
  const yieldsOf = sql`case when jsonb_typeof(${cvq.state}->'quickSizeYields') = 'array' then ${cvq.state}->'quickSizeYields' else '[]'::jsonb end`;
  const inWindow = sql`(select count(*) from jsonb_array_elements_text(${yieldsOf}) as y(at) where y.at >= ${from.toISOString()} and y.at <= ${now.toISOString()})`;
  const [sy] = await db.select({ n: sql<number>`coalesce(sum(${inWindow}), 0)::int`, convs: sql<number>`(count(*) filter (where ${inWindow} > 0))::int` }).from(cvq).where(sql`${cvq.channel} <> 'TEST'`);
  tomTat(`D nhường AI vì khách đã chọn khối lượng (#868 trên câu mẫu · khớp chữ + AI chọn mã; KHÔNG đếm công cụ send_quick_reply — ở đó model đã được gọi): ${sy?.n ?? 0} lượt / ${sy?.convs ?? 0} hội thoại — mỗi lượt là một lời gọi AI thay cho câu mẫu 0 token`);
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
  // M — hội thoại có tin khách chứa SĐT mà hộp thư không có SĐT nào để hiện (cùng thứ tự `inboxPhoneOf`).
  const cvm = schema.salesChatConversations;
  const typedIds = [...typedPhoneConvs];
  let mismatch = 0;
  const mismatchIds: string[] = [];
  for (let i = 0; i < typedIds.length; i += 500) {
    const part = typedIds.slice(i, i + 500);
    const rowsM = await db
      .select({ id: cvm.id, conv: cvm.customerPhone, st: sql<string | null>`${cvm.state}->'customer'->>'phone'`, kp: sql<string | null>`${cvm.state}->'knownPhone'->>'phone'`, cu: schema.customers.phone })
      .from(cvm)
      .leftJoin(schema.customers, eq(schema.customers.id, cvm.customerId))
      .where(inArray(cvm.id, part));
    for (const r of rowsM) {
      if (shownPhoneOf({ customerPhone: r.cu, statePhone: r.st, knownPhone: r.kp, convPhone: r.conv }) !== null) continue;
      mismatch += 1;
      if (mismatchIds.length < 20) mismatchIds.push(r.id);
    }
  }
  console.log(`  mẫu M (≤ 20): ${mismatchIds.join(" ") || "—"}`);
  tomTat(`M CUSTOMER_PROFILE_SYNC_MISMATCH — hội thoại có tin khách chứa SĐT mà hộp thư in «Chưa có SĐT»: ${mismatch} / ${typedIds.length} hội thoại khách đã gõ SĐT (MEASURED)`);
  // H · I — lời mời sau chốt (lượt chốt gần nhất của mỗi hội thoại có mốc lời mời trong kỳ). Câu upsell chưa cài ⇒ H không áp dụng.
  const upRows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select c.id, c.state->'postConfirmOffer' as pco, c.state->'confirmed' as confirmed, c.state->'cancelRequest' as cancel,
        c.state->'declined' as declined, c.state->'priceDispute' as dispute,
        exists (select 1 from "sales_chat_inbound" i where i.page_id = c.page_id and i.thread_id = c.thread_id and i.note = 'PAGE_REPLY'
          and coalesce(i.sender_kind, '') not in ('AI_AGENT', 'META_SYSTEM')
          and (case when jsonb_typeof(i.image_urls) = 'array' then jsonb_array_length(i.image_urls) else 0 end) > 0
          and i.created_at between (c.state->'postConfirmOffer'->>'at')::timestamptz - ${UPSELL_DUP_WINDOW_HOURS} * interval '1 hour'
            and (c.state->'postConfirmOffer'->>'at')::timestamptz + ${UPSELL_DUP_WINDOW_HOURS} * interval '1 hour') as page_media
      from "sales_chat_conversations" c
      where c.channel <> 'TEST' and c.state->'postConfirmOffer'->>'at' >= ${from.toISOString()} and c.state->'postConfirmOffer'->>'at' <= ${now.toISOString()}`),
  );
  const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);
  const UP = { rounds: upRows.length, sent: 0, skipped: 0, dup: 0, skippedIds: [] as string[], dupIds: [] as string[] };
  for (const r of upRows) {
    const v = upsellScanVerdict({ pco: obj(r.pco), confirmed: obj(r.confirmed), cancel: r.cancel, declined: r.declined, dispute: obj(r.dispute), pageMedia: r.page_media === true || r.page_media === "t" });
    if (v.sent) UP.sent += 1;
    if (v.skippedValid) [UP.skipped, UP.skippedIds] = [UP.skipped + 1, [...UP.skippedIds, String(r.id)]];
    if (v.duplicate) [UP.dup, UP.dupIds] = [UP.dup + 1, [...UP.dupIds, String(r.id)]];
  }
  console.log(`  mẫu O (≤ 20): ${O.ids.join(" ") || "—"}`);
  tomTat(`O KNOWN_ADDRESS_REASKED (AGENTS 3.12b) — tin bot hỏi / xin bất kỳ phần nào của địa chỉ khi khách ĐÃ gửi chữ địa chỉ (≤ 3 ngày trước): ${O.msgs} tin / ${O.convs.size} hội thoại · mẫu số ${O.base} tin bot sau chữ địa chỉ (ESTIMATED — chỉ chữ địa chỉ gửi trong kỳ quét; phải = 0 sau deploy)`);
  console.log(`  mẫu H (≤ 20): ${UP.skippedIds.slice(0, 20).join(" ") || "—"}`);
  console.log(`  mẫu I (≤ 20): ${UP.dupIds.slice(0, 20).join(" ") || "—"}`);
  tomTat(
    upsellId
      ? `H UPSELL_SKIPPED_VALID_TEMPLATE — shop có câu upsell, lượt chốt đủ điều kiện mà KHÔNG mời (cửa sổ đóng chỉ vì địa chỉ chờ xác minh · lời mời không đi vì không có tin xác nhận / hàng rào / ghép lỗi): ${UP.skipped} / ${UP.rounds} lượt chốt có ghi lời mời (MEASURED — lượt chốt gần nhất mỗi hội thoại)`
      : `H UPSELL_SKIPPED_VALID_TEMPLATE — KHÔNG ÁP DỤNG: shop chưa chọn câu upsell (${UP.rounds} lượt chốt có ghi lời mời)`,
  );
  tomTat(`I UPSELL_DUPLICATE — ERP đã gửi lời mời VÀ page / Pancake gửi ảnh trong ± ${UPSELL_DUP_WINDOW_HOURS} giờ: ${UP.dup} / ${UP.sent} lời mời ERP đã gửi (MEASURED)`);
  tomTat(`C kết quả chép: chuyển cả hội thoại ${kqDem("MOVED")} · chép sang hộp thư ĐÃ CÓ ${kqDem("EXISTING_INBOX")} · mở hộp thư rồi chép ${kqDem("OPENED_NEW")} · đã chép từ trước ${kqDem("ALREADY_COPIED")} · không có hộp thư ${kqDem("NO_INBOX")} · lỗi ${kqDem("FAILED")} · KHÁC ${kqDem("KHAC")} · tin đã chép ${kqTin}`);
}

/**
 * E — TỐC ĐỘ + CHI PHÍ TRẢ LỜI (chủ shop 18/10: «không đánh đổi chất lượng bán hàng lấy tiết kiệm token» — nên phải ĐO cả hai chiều):
 * lượt bot trả lời theo chế độ (sổ sự kiện `ai.replied`: AI · QUICK_REPLY · SYSTEM) kèm trung vị / p90 thời gian phản hồi; lời gọi AI
 * của bot bán hàng theo loại việc (sổ AI nền tảng `platform_ai_usage`: số lời gọi, token vào / ra, trung vị độ trễ). Chỉ đọc, chỉ số đếm.
 */
export async function scanAiPerformance(db: Db, orgCode: string, from: Date, to: Date): Promise<void> {
  const ev = schema.salesConversationEvents;
  const byMode = await db
    .select({
      mode: sql<string>`case ${ev.payload}->>'mode' when 'AI' then 'AI' when 'QUICK_REPLY' then 'QUICK_REPLY' when 'SYSTEM' then 'SYSTEM' else 'KHAC' end`,
      n: sql<number>`count(*)::int`,
      p50: sql<number | null>`percentile_cont(0.5) within group (order by case when (${ev.payload}->>'responseMs') ~ '^[0-9]+([.][0-9]+)?$' then (${ev.payload}->>'responseMs')::numeric end)`,
      p90: sql<number | null>`percentile_cont(0.9) within group (order by case when (${ev.payload}->>'responseMs') ~ '^[0-9]+([.][0-9]+)?$' then (${ev.payload}->>'responseMs')::numeric end)`,
    })
    .from(ev)
    .where(and(eq(ev.type, "ai.replied"), sql`${ev.channel} <> 'TEST'`, gte(ev.occurredAt, from), lte(ev.occurredAt, to)))
    .groupBy(sql`1`);
  const sec = (ms: number | null | undefined) => (typeof ms === "number" && Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : "—");
  const total = byMode.reduce((s, r) => s + Number(r.n), 0);
  tomTat(
    `E lượt bot trả lời ${from.toISOString()} → ${to.toISOString()}: ${total} · ${["QUICK_REPLY", "AI", "SYSTEM", "KHAC"]
      .map((k) => {
        const r = byMode.find((x) => x.mode === k);
        return `${k} ${r ? Number(r.n) : 0}${r ? ` (trung vị ${sec(Number(r.p50))} · p90 ${sec(Number(r.p90))})` : ""}`;
      })
      .join(" · ")}`,
  );
  const pdb = await getPlatformDb();
  const u = schema.platformAiUsage;
  const byWork = await pdb
    .select({
      w: sql<string>`case when ${u.workload} is null then 'KHONG_KHAI' when ${u.workload} = 'sales_chatbot' then 'sales_chatbot' when ${u.workload} = 'quick_extract' then 'quick_extract' else 'KHAC' end`,
      calls: sql<number>`coalesce(sum(${u.requests}), 0)::int`,
      inTok: sql<number>`coalesce(sum(${u.inputTokens}), 0)::bigint`,
      outTok: sql<number>`coalesce(sum(${u.outputTokens}), 0)::bigint`,
      p50: sql<number | null>`percentile_cont(0.5) within group (order by ${u.latencyMs})`,
    })
    .from(u)
    .where(and(eq(u.orgCode, orgCode), eq(u.feature, "sales_chatbot"), eq(u.status, "OK"), gte(u.at, from), lte(u.at, to)))
    .groupBy(sql`1`);
  tomTat(
    `E lời gọi AI bot bán hàng: ${byWork.length ? byWork.map((r) => `${r.w} ${Number(r.calls)} lời gọi · token vào ${Number(r.inTok)} · ra ${Number(r.outTok)} · trung vị ${sec(Number(r.p50))}`).join(" | ") : "0"}`,
  );
}

/**
 * `--replay-quick`: mỗi tin khách của các hội thoại được chọn (theo thứ tự, cùng dòng shop / page xen giữa) + bộ biến thể cố định ⇒ quyết
 * định câu mẫu trước / sau luật món đang bàn, trên câu mẫu + danh mục ĐANG có. Chỉ đọc. Chữ khách KHÔNG in (băm); tên câu mẫu là nội
 * dung shop ⇒ phần mã hoá; [ops:tom-tat] chỉ số đếm.
 */
async function replayQuick(db: Db, convIds: readonly string[]): Promise<void> {
  const rowsQr = await listQuickReplies().catch(() => []);
  const active: QuickReplyEntry[] = rowsQr.filter((r) => r.active).map((r) => ({ id: r.id, title: r.title, triggers: r.triggers, answer: r.answer }));
  const products = await loadFocusProducts().catch(() => [] as FocusProduct[]);
  const upsellId = (await loadQuickReplySettings().catch(() => null))?.upsellReplyId ?? null;
  const ups = upsellId ? [upsellId] : [];
  // Luật quy cách trên câu mẫu (#868, 19/10/2026) — ops lấy script từ MAIN nhưng lib từ ẢNH ĐANG CHẠY ⇒ đọc luật qua import động: ảnh
  // chưa có luật ⇒ in «CHƯA ĐO ĐƯỢC», không giả vờ là đã xét. Giỏ dựng lại từ chữ khách (cùng `applyCustomerCartMessage` của lượt sống;
  // không có món vừa được mời / danh mục đầy đủ như lượt sống ⇒ có thể bỏ sót, không bịa thêm), câu mẫu xét theo chữ GỐC (ô giá chưa điền).
  const nba = (await import("@/lib/sales-chatbot/next-best-action")) as Record<string, unknown>;
  const sizeRule = typeof nba.quickReplySizeConflict === "function" ? (nba.quickReplySizeConflict as (text: string, input: { cart?: CartCommitment; lastUserText: string; facts: OfferFacts | null; covers?: readonly string[] }) => boolean) : null;
  const facts = sizeRule ? await loadOfferFacts(await loadSalesChatbotConfig(), upsellId).catch(() => null) : null;
  const names = products.map((p) => p.name);
  const sizeBlockedFor = (cart: CartCommitment | undefined, lastUserText: string) => (sizeRule ? (e: QuickReplyEntry) => sizeRule(e.answer, { cart, lastUserText, facts, covers: quickReplyCovers(e, products) }) : undefined);
  const now = new Date();
  const m = schema.salesChatMessages;
  const T = { turns: 0, eligible: 0, changed: 0, wrongBefore: 0, wrongAfter: 0, found: 0, defaultBefore: 0, sizeYield: 0 };
  for (const id of convIds) {
    const rows = await db.select({ seq: m.seq, role: m.role, content: m.content }).from(m).where(eq(m.conversationId, id)).orderBy(asc(m.seq)).limit(400);
    if (rows.length) T.found += 1;
    console.log(`— Phát lại câu mẫu · hội thoại ${id} · ${rows.length} tin`);
    const lines: FocusLine[] = [];
    let cart: CartCommitment | undefined;
    for (const r of rows) {
      const t = textOf(r.content);
      if (!t) continue;
      if (r.role !== "user") {
        lines.push({ who: "SHOP", text: t });
        continue;
      }
      if (blocksOf(r.content).some((b) => b.type === "tool_result")) continue;
      lines.push({ who: "CUSTOMER", text: t });
      cart = applyCustomerCartMessage(cart, t, r.seq, now, { catalog: names });
      const d = quickDecisionAt(lines, active, products, ups, sizeBlockedFor(cart, t));
      if (d.sizeYield) T.sizeYield += 1;
      T.turns += 1;
      if (d.eligible) T.eligible += 1;
      if (d.changed) T.changed += 1;
      if (d.wrongBefore) T.wrongBefore += 1;
      if (d.defaultBefore) T.defaultBefore += 1;
      if (d.wrongAfter) T.wrongAfter += 1;
      if (d.eligible) console.log(`  khách #${r.seq} (băm ${hashText(t)}) · trần: ${d.raw} · sau luật: ${d.after}${d.wrongBefore ? " · TRẦN SAI MÓN" : ""}${d.defaultBefore ? " · TRẦN MẶC ĐỊNH MÓN" : ""}${d.wrongAfter ? " · SAU LUẬT VẪN SAI MÓN" : ""}`);
    }
  }
  const V = { n: 0, changed: 0, wrongBefore: 0, wrongAfter: 0, defaultBefore: 0 };
  console.log("— Biến thể cố định:");
  for (const v of QUICK_REPLAY_VARIANTS) {
    let vc: CartCommitment | undefined;
    v.lines.forEach((l, i) => {
      if (l.who === "CUSTOMER") vc = applyCustomerCartMessage(vc, l.text, i + 1, now, { catalog: names });
    });
    const d = quickDecisionAt(v.lines, active, products, ups, sizeBlockedFor(vc, v.lines[v.lines.length - 1]?.text ?? ""));
    V.n += 1;
    if (d.changed) V.changed += 1;
    if (d.wrongBefore) V.wrongBefore += 1;
    if (d.defaultBefore) V.defaultBefore += 1;
    if (d.wrongAfter) V.wrongAfter += 1;
    console.log(`  «${v.key}» · trần: ${d.raw} · sau luật: ${d.after}${d.wrongBefore ? " · TRẦN SAI MÓN" : ""}${d.defaultBefore ? " · TRẦN MẶC ĐỊNH MÓN" : ""}${d.wrongAfter ? " · SAU LUẬT VẪN SAI MÓN" : ""}`);
  }
  tomTat(`replay-quick: ${T.found}/${convIds.length} hội thoại · tin khách ${T.turns} · câu mẫu được xét ${T.eligible} · luật món đổi quyết định ${T.changed} · khớp trần sai món ${T.wrongBefore} · khớp trần mặc định món ${T.defaultBefore} · sau luật vẫn sai ${T.wrongAfter}`);
  tomTat(`replay-quick luật quy cách (#868 trên câu mẫu): ${sizeRule ? `câu mẫu nhường AI vì khách đã chọn khối lượng ${T.sizeYield} tin` : "CHƯA ĐO ĐƯỢC — ảnh đang chạy chưa có quickReplySizeConflict"}`);
  tomTat(`replay-quick biến thể: ${V.n} · luật món đổi quyết định ${V.changed} · khớp trần sai món ${V.wrongBefore} · khớp trần mặc định món ${V.defaultBefore} · sau luật vẫn sai ${V.wrongAfter} · câu mẫu đang bật ${active.length} · sản phẩm ${products.length}`);
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
    if (args.scan) {
      const now = args.until ?? new Date();
      await scanPatterns(db, args.days, now, args.since);
      await scanAiPerformance(db, org.code, args.since ?? new Date(now.getTime() - args.days * 86_400_000), now);
    }
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
    if (args.replayQuick) await replayQuick(db, args.replayQuick);
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

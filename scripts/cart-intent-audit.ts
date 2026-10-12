/*
  ops `cart-intent-audit` — BOT CÓ TỰ HẠ SỐ LƯỢNG KHÁCH ĐÃ NÓI, HAY CỨ HỎI / MỜI KHI ĐƠN ĐÃ ĐỦ ĐỂ CHỐT? ĐO TRÊN MỘT TỔ CHỨC (CHỈ ĐỌC).

  Vì sao có (P0 HSLC 12/10/2026): khách «Cho chị 2kg chả cá thu / ĐT … / F4/22A …» (món + 2kg + SĐT + địa chỉ trong một tin), rồi
  «Ngon chị mới lấy nha em» ⇒ AI «Mình lấy 1kg ăn thử trước nhé…». Script đo PHẠM VI của hai lỗi trong N ngày — để có số TRƯỚC khi
  deploy bản sửa (nhánh `fix/sticky-cart-intent`, giỏ có thẩm quyền) và số SAU (`--since=<mốc deploy>`).

  Thước đo (ESTIMATED — đọc từ CHỮ tin khách / tin bot và dòng hàng của kết quả công cụ, không từ sổ giỏ):
   · CART_INTENT_DRIFT — khách nói TƯỜNG MINH số lượng X, sau đó (không có câu sửa tường minh của khách ở giữa) bot ĐỀ XUẤT Y < X /
     gói ăn thử trong chữ, HOẶC đơn nháp / đơn chốt trong kết quả công cụ có lượng Y < X. Mẫu số = hội thoại có số lượng tường minh.
   · ORDER_READY_LOOP — hội thoại đã đủ ORDER_READY (số lượng tường minh + SĐT hợp lệ + địa chỉ đọc được tỉnh / thành trong tin khách)
     mà, trước khi đơn chốt, bot VẪN hỏi / tư vấn / mời chung chung ở ≥ 1 lượt trả lời một tin khách SAU tin đủ điều kiện (lượt trả lời
     NGAY tin đủ điều kiện được phép mang một câu mời thêm món + tóm tắt — luật mời đúng một lần của shop). Mẫu số = hội thoại ORDER_READY.

  BỘ LUẬT câu khách «sửa tường minh / mơ hồ» và câu bot «hạ số lượng / gói ăn thử / hỏi lại số lượng» là BẢN SAO TỰ CHỨA của
  `lib/sales-chatbot/cart-commitment.ts` (nhánh fix/sticky-cart-intent): ops lấy script từ `main` nhưng `lib/` từ image ĐANG CHẠY, nên
  muốn đo TRƯỚC deploy thì script không được import tệp lib mới. Khi image đã có tệp đó, thay khối bản sao bằng import — một luật,
  một chỗ.

  arg: `<mã tổ chức> [--days=1..30] [--since=<ISO>]` (mặc định 7 ngày). `--since` = CHỈ đếm sự việc từ mốc đó (vd mốc deploy) — tin
  trước mốc vẫn được đọc để biết khách đã nói gì. Kênh [ops:tom-tat] chỉ số đếm + tỷ lệ — KHÔNG tên, SĐT, địa chỉ, chữ tin, mã hội thoại.
  Mã hội thoại theo từng lỗi chỉ ở phần MÃ HOÁ. CHỈ ĐỌC do Postgres ép (`ERP_READ_ONLY=1`, kiểm lại `default_transaction_read_only`);
  CSDL tổ chức mở bằng getDbForInspection (không migrate, không tạo) và script KHÔNG gọi hàm lib nào đọc `getDb()`.
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("cart-intent-audit.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { and, asc, gte, inArray, sql } from "drizzle-orm";
import { getDbForInspection, schema, type Db } from "@/db";
import { resolveRecipientPlace } from "@/lib/address/vn-address";
import { findOrganization } from "@/lib/platform/organizations";
import { foldVi } from "@/lib/sales-chatbot/text";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);

// ═══════════════ BẢN SAO TỰ CHỨA — lib/sales-chatbot/cart-commitment.ts (nhánh fix/sticky-cart-intent) ═══════════════
export type CartUnit = "g" | "pack";

/**
 * Một món trong giỏ có thẩm quyền. `quantity` theo `unit` (gram hoặc số gói / cái). `sourceMessageId` = seq tin khách đã nói số
 * này (`null` = đọc từ đơn nháp do bot lên). `customerExplicit` = khách TỰ nói số lượng ⇒ dính; `false` = bot đề xuất (vd món mời
 * thêm khách nhận bằng «ok») ⇒ không dính. `productId` / `variantId` gắn khi đơn nháp đầu tiên có món đó (`bindCommitment`).
 */
export type CommittedItem = {
  label: string;
  match: string;
  productId: string | null;
  variantId: string | null;
  sku: string | null;
  quantity: number;
  unit: CartUnit;
  sourceMessageId: number | null;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  customerExplicit: boolean;
};

/** `clarify` = câu khách có vẻ muốn sửa nhưng không chắc sửa món nào ⇒ giỏ GIỮ NGUYÊN, model hỏi lại. */
export type CartCommitment = { selectedItems: CommittedItem[]; turn: number | null; at: string; clarify?: string | null };

export type CartIntentKind = "ORDER" | "SET" | "ADD" | "REDUCE" | "REMOVE" | "CANCEL" | "QUESTION" | "AMBIGUOUS";
export type CartAmount = { value: number; unit: CartUnit; label: string; display: string; index: number; end: number };
/** `tentative` = số lượng nói kèm câu hỏi giá («lấy 2kg bao nhiêu em») — chỉ THÊM món mới vào giỏ, không bao giờ sửa món đã có. */
export type CartIntent = { kind: CartIntentKind; amounts: CartAmount[]; label: string | null; tentative?: boolean };

// ─────────────────────────── ĐỌC SỐ LƯỢNG ───────────────────────────

const WORD_NUM: Record<string, number> = { mot: 1, hai: 2, ba: 3, bon: 4, nam: 5, sau: 6, bay: 7, tam: 8, chin: 9, muoi: 10 };
const WEIGHT_UNIT = "kg|kí|ký|ki|ky|cân|can|gram|gr|g";
const PACK_UNIT = "túi|tui|gói|goi|hộp|hop|set|phần|phan|bịch|bich|khay|combo|suất|suat|hũ|hủ|hu|lọ|lo|cái|cai|chiếc|chiec|đôi|doi|bộ|bo|cây|cay";
const NUM_WORD = "một|mot|hai|ba|bốn|bon|năm|nam|sáu|sau|bảy|bay|tám|tam|chín|chin|mười|muoi";
const WEIGHT_RE = new RegExp(`(\\d+(?:[.,]\\d+)?|${NUM_WORD}|nửa|nua)\\s*(${WEIGHT_UNIT})(?:\\s*(rưỡi|ruoi))?(?![\\p{L}\\d])`, "giu");
const PACK_RE = new RegExp(`(\\d{1,3}|${NUM_WORD})\\s*(${PACK_UNIT})(?![\\p{L}\\d])`, "giu");

const numOf = (raw: string): number | null => {
  const f = foldVi(raw);
  if (f === "nua") return 0.5;
  if (WORD_NUM[f] !== undefined) return WORD_NUM[f];
  const n = Number(raw.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Từ không phải tên món (đại từ · trợ từ · động từ mua / sửa · từ chỉ liên lạc). */
const STOP = new Set(
  "chi anh em minh toi c a e ban cho lay mua dat gui ship giao them con doi bot giam thoi nhe nha ah voi va la thi nua sua thanh sang lai chot len don order de ok oke okie vang u uh roi khong ko k phai chu ma cua loai dt sdt so dien thoai dia gium giup luon di hang nay kia do nao the vay duoc dc can cai tong hay hoac moi ngon an truoc chiu bao nhieu bn gia sao dung tien het may tui goi hop set phan bich khay combo suat hu lo chiec bo cay kg ky ki kí can gram gr g x da uhm oki shop".split(" "),
);
const CUT_RE = /[\n,/;:+!?()[\]|.&]|\d/;

function labelTokens(s: string): string[] {
  return foldVi(s).split(" ").filter(Boolean);
}

/** Tên món ĐỨNG SAU số lượng («2kg chả cá thu / ĐT…» ⇒ «chả cá thu»), không có thì ĐỨNG TRƯỚC («chả cá thu 2kg»). */
function labelAround(text: string, index: number, end: number): { match: string; display: string } {
  const after = text.slice(end, end + 60);
  const cut = after.search(CUT_RE);
  const seg = (cut < 0 ? after : after.slice(0, cut)).trim();
  const words = seg.split(/\s+/).filter(Boolean);
  const take: string[] = [];
  for (const w of words) {
    const f = foldVi(w);
    if (!f || STOP.has(f) || take.length >= 5) break;
    take.push(w);
  }
  if (take.length) return { match: foldVi(take.join(" ")), display: take.join(" ") };
  const before = text.slice(Math.max(0, index - 60), index);
  const lastCut = Math.max(...[...before.matchAll(/[\n,/;:+!?()[\]|.&]|\d/g)].map((m) => m.index ?? -1), -1);
  const bwords = before.slice(lastCut + 1).trim().split(/\s+/).filter(Boolean);
  while (bwords.length && STOP.has(foldVi(bwords[bwords.length - 1]))) bwords.pop();
  const run: string[] = [];
  for (let i = bwords.length - 1; i >= 0 && run.length < 5; i--) {
    const f = foldVi(bwords[i]);
    if (!f || STOP.has(f)) break;
    run.unshift(bwords[i]);
  }
  return run.length ? { match: foldVi(run.join(" ")), display: run.join(" ") } : { match: "", display: "" };
}

/** Mọi số lượng khách nói trong câu: khối lượng (gram) và số gói / cái, theo thứ tự xuất hiện, kèm tên món quanh nó. HÀM THUẦN. */
export function amountsIn(text: string): CartAmount[] {
  const out: CartAmount[] = [];
  for (const m of text.matchAll(WEIGHT_RE)) {
    const n = numOf(m[1]);
    if (n === null) continue;
    const unit = foldVi(m[2]);
    const half = m[3] ? 0.5 : 0;
    const grams = Math.round(/^(?:gram|gr|g)$/.test(unit) ? n + half : (n + half) * 1000);
    if (grams <= 0) continue;
    const idx = m.index ?? 0;
    const lb = labelAround(text, idx, idx + m[0].length);
    out.push({ value: grams, unit: "g", label: lb.match, display: lb.display, index: idx, end: idx + m[0].length });
  }
  for (const m of text.matchAll(PACK_RE)) {
    const n = numOf(m[1]);
    if (n === null || !Number.isInteger(n)) continue;
    const idx = m.index ?? 0;
    if (out.some((a) => idx < a.end && idx + m[0].length > a.index)) continue;
    const lb = labelAround(text, idx, idx + m[0].length);
    out.push({ value: n, unit: "pack", label: lb.match, display: lb.display, index: idx, end: idx + m[0].length });
  }
  out.sort((a, b) => a.index - b.index);
  // «2 túi 1kg» / «2 gói loại 1kg» = 2 × 1kg = 2kg — MỘT lượng, không phải «2 gói» + «1kg» (ca «Chị Hoàn» 11/10/2026).
  for (let i = 0; i + 1 < out.length; i++) {
    const a = out[i];
    const b = out[i + 1];
    if (a.unit !== "pack" || b.unit !== "g" || !/^\s*(?:loại|loai|cỡ|co|size|x|×)?\s*$/i.test(text.slice(a.end, b.index))) continue;
    out.splice(i, 2, { ...b, value: a.value * b.value, index: a.index, label: b.label || a.label, display: b.display || a.display });
  }
  return out;
}

/** «2kg» · «500g» · «1,5kg» · «2 gói». HÀM THUẦN. */
export function amountText(value: number, unit: CartUnit): string {
  if (unit === "pack") return `${value} gói`;
  if (value % 1000 === 0) return `${value / 1000}kg`;
  if (value < 1000) return `${value}g`;
  return `${(value / 1000).toLocaleString("vi-VN")}kg`;
}

// ─────────────────────────── PHÂN LOẠI CÂU KHÁCH ───────────────────────────

/** Sáu từ cuối của MỆNH ĐỀ đứng ngay trước một vị trí (cắt ở dấu câu — «khuyến mãi gì ko, lấy 2 gói» không phủ định «2 gói»). */
const tail = (s: string) => {
  const clause = s.slice(Math.max(0, s.length - 48));
  const cut = Math.max(...[...clause.matchAll(/[\n,.;!?]/g)].map((m) => m.index ?? -1), -1);
  return foldVi(clause.slice(cut + 1)).split(" ").slice(-6).join(" ");
};
const head = (s: string) => foldVi(s.slice(0, 30)).split(" ").slice(0, 3).join(" ");

/**
 * Câu khách nói gì về GIỎ. Chỉ những mẫu chắc chắn mới đổi giỏ; còn lại `AMBIGUOUS` (không có số lượng) hoặc `QUESTION` (hỏi giá /
 * hỏi điều kiện — «1kg bao nhiêu», «nếu lấy 3kg thì sao») ⇒ GIỮ NGUYÊN. HÀM THUẦN.
 *  · ORDER  — nói số lượng một cách khẳng định («cho chị 2kg chả cá thu», «2kg nhé») ⇒ đặt đúng số đó;
 *  · SET    — câu sửa có dấu hiệu sửa («đổi còn 1kg», «lấy 1kg thôi», «thôi lấy 3kg», «không phải 2kg, 1kg thôi»);
 *  · ADD / REDUCE — «thêm 1kg» / «bớt 1kg»; REMOVE — «không lấy chả cá nữa»; CANCEL — «thôi không lấy nữa» (cả đơn).
 */
export function classifyCartMessage(text: string): CartIntent {
  const raw = text.toLowerCase();
  const f = foldVi(text);
  const none = (kind: CartIntentKind): CartIntent => ({ kind, amounts: [], label: null });
  if (/(?:^| )(?:neu|thi) /.test(` ${f} `)) return none("QUESTION");
  // Cả đơn: «thôi không lấy nữa», «không mua nữa», «huỷ đơn» — KHÔNG gồm «không lấy THÊM / GÌ nữa» (= đủ rồi, giữ đơn).
  if (/(?:^| )(?:khong|ko|k) (?:lay|mua|dat|can) nua(?: |$)|(?:^| )huy don(?: |$)|(?:^| )thoi (?:khong|ko|k) (?:lay|mua|dat)(?! (?:them|gi|vay|nhu))(?: |$)/.test(f)) return none("CANCEL");
  // Một món: «không lấy chả cá nữa», «bỏ chả mực đi», «thôi không lấy chả mực nữa».
  const rm = f.match(/(?:^| )(?:khong|ko|k|bo|thoi|huy) (?:(?:lay|mua|dat|can) )?((?:[a-z]+ ){0,4}[a-z]+) (?:nua|di|ra)(?: |$)/);
  if (rm) {
    const tokens = rm[1].split(" ").filter((w) => !STOP.has(w));
    if (tokens.length && !/(?:^| )(?:them|gi)(?: |$)/.test(rm[1])) return { kind: "REMOVE", amounts: [], label: tokens.join(" ") };
  }
  const all = amountsIn(text);
  // «không phải 2kg», «không lấy 2kg đâu» — số bị phủ định là số CŨ, không phải số mới.
  const amounts = all.filter((a) => !/(?:khong|ko|k) (?:phai|lay|mua)(?: la)?$/.test(tail(text.slice(0, a.index))));
  if (!amounts.length) return none("AMBIGUOUS");
  const buyVerb = /(?:^| )(?:lay|cho|dat|mua|gui|ship|chot|order|lam|len don)(?: (?:chi|em|anh|minh|toi|c|a|e|cho chi|cho em|cho anh|cho minh|them))*$/;
  const priceAsk = raw.includes("?") || /(?:^| )(?:bao nhieu|bn|nhieu tien|may tien|het bao|gia (?:bao|sao|the nao|nhieu|nhu)|(?:duoc|dc|co|dung|phai) (?:khong|ko|k)|the nao|sao|tinh tien|tinh gia|bao gia)(?: |$)/.test(f) || /(?:^| )(?:khong|ko|k|hong|hok)(?: (?:em|e|a|shop|ban|vay|nhi))?$/.test(f);
  const last = amounts[amounts.length - 1];
  const leadOf = (a: CartAmount) => tail(text.slice(0, a.index));
  const trailOf = (a: CartAmount) => head(text.slice(a.end));
  if (amounts.some((a) => /(?:^| )(?:them|cong them|lay them|them cho (?:chi|em|anh|minh))$/.test(leadOf(a)) || /^nua(?: |$)/.test(trailOf(a)))) {
    return { kind: "ADD", amounts: amounts.filter((a) => /(?:^| )(?:them|cong them|lay them|them cho (?:chi|em|anh|minh))$/.test(leadOf(a)) || /^nua(?: |$)/.test(trailOf(a))), label: null };
  }
  if (/(?:^| )(?:bot|giam|bot di|bot cho (?:chi|em|anh|minh))$/.test(leadOf(last))) return { kind: "REDUCE", amounts: [last], label: null };
  const correction =
    /(?:^| )(?:doi|sua|chuyen)(?: (?:thanh|sang|lai|ve))?(?: (?:con|lay))?$/.test(leadOf(last)) ||
    /(?:^| )con$/.test(leadOf(last)) ||
    /(?:^| )thoi (?:lay|cho|dat)(?: (?:chi|em|anh|minh))?$/.test(leadOf(last)) ||
    /^thoi(?: |$)/.test(trailOf(last)) ||
    /chỉ\s+(?:lấy|mua|đặt)\s*$/.test(raw.slice(0, last.index)) ||
    all.length > amounts.length;
  if (correction && !(priceAsk && !/(?:^| )(?:doi|sua|thoi)(?: |$)/.test(f))) return { kind: "SET", amounts: [last], label: null };
  if (priceAsk) return amounts.some((a) => buyVerb.test(leadOf(a))) ? { kind: "ORDER", amounts, label: null, tentative: true } : none("QUESTION");
  return { kind: "ORDER", amounts, label: null };
}

// ─────────────────────────── GIỎ ───────────────────────────

/** Hai tên cùng một món: tập từ của tên ngắn nằm trong tên dài («chả cá» ⊂ «chả cá thu (1kg)»). HÀM THUẦN. */
export function labelsMatch(a: string, b: string): boolean {
  const ta = labelTokens(a).filter((w) => !/^\d/.test(w) && w !== "kg" && w !== "g");
  const tb = labelTokens(b).filter((w) => !/^\d/.test(w) && w !== "kg" && w !== "g");
  if (!ta.length || !tb.length) return false;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return short.every((w) => long.includes(w));
}

/** Món của giỏ khớp một tên (đúng MỘT món — khớp nhiều là mơ hồ ⇒ `null`). */
function findItem(items: readonly CommittedItem[], label: string): number | null {
  const hits = items.map((it, i) => (labelsMatch(it.match, label) ? i : -1)).filter((i) => i >= 0);
  return hits.length === 1 ? hits[0] : null;
}

const newItem = (a: CartAmount, turn: number | null): CommittedItem => ({ label: a.display, match: a.label, productId: null, variantId: null, sku: null, quantity: a.value, unit: a.unit, sourceMessageId: turn, confidence: a.label ? "HIGH" : "MEDIUM", customerExplicit: true });

/**
 * Áp MỘT tin khách lên giỏ. Trả ĐÚNG đối tượng cũ khi không đổi gì (engine chỉ ghi khi khác). Câu sửa không rõ món nào (giỏ nhiều
 * món, câu không nêu tên) ⇒ giỏ giữ nguyên + `clarify` để model hỏi lại. HÀM THUẦN.
 */
export function applyCustomerCartMessage(cart: CartCommitment | undefined, text: string, turn: number | null, now: Date): CartCommitment | undefined {
  const intent = classifyCartMessage(text);
  if (intent.kind === "AMBIGUOUS" || intent.kind === "QUESTION") return cart?.clarify ? { ...cart, clarify: null } : cart;
  const items = [...(cart?.selectedItems ?? [])];
  const at = now.toISOString();
  const done = (next: CommittedItem[], clarify: string | null = null): CartCommitment => ({ selectedItems: next, turn, at, clarify });
  if (intent.kind === "CANCEL") return items.length ? done([]) : cart;
  if (intent.kind === "REMOVE") {
    const i = findItem(items, intent.label ?? "");
    if (i === null) return items.length ? done(items, `Khách muốn bỏ «${intent.label}» nhưng giỏ không có đúng một món khớp — hỏi lại món nào`) : cart;
    return done(items.filter((_, k) => k !== i));
  }
  const explicit = items.filter((x) => x.customerExplicit);
  /** Món mà một số lượng nói tới: khớp tên, hoặc không tên mà giỏ có đúng MỘT món khách đã nói. */
  const target = (a: CartAmount): number | "NEW" | "AMBIGUOUS" => {
    if (a.label) {
      const i = findItem(items, a.label);
      if (i !== null) return i;
      if (items.some((x) => labelsMatch(x.match, a.label))) return "AMBIGUOUS";
      // «Cho chị 2kg» rồi «2kg chả cá thu nhé» — giỏ có đúng MỘT món chưa rõ tên ⇒ đó là món này, không phải món thứ hai.
      return items.length === 1 && !items[0].match ? 0 : "NEW";
    }
    if (explicit.length === 1) return items.indexOf(explicit[0]);
    if (!items.length) return "NEW";
    return items.length === 1 ? 0 : "AMBIGUOUS";
  };
  let changed = false;
  for (const a of intent.amounts) {
    const t = target(a);
    if (t === "AMBIGUOUS") return done(items, `Khách nói ${amountText(a.value, a.unit)} nhưng giỏ có ${items.length} món — chưa rõ món nào, GIỮ NGUYÊN và hỏi lại`);
    if (t === "NEW") {
      if (intent.kind === "REDUCE") continue;
      items.push(newItem(a, turn));
      changed = true;
      continue;
    }
    if (intent.tentative) continue;
    const cur = items[t];
    if (cur.unit !== a.unit && intent.kind !== "ORDER" && intent.kind !== "SET") continue;
    const base = cur.unit === a.unit ? cur.quantity : 0;
    const quantity = intent.kind === "ADD" ? base + a.value : intent.kind === "REDUCE" ? base - a.value : a.value;
    if (quantity <= 0) items.splice(t, 1);
    else items[t] = { ...cur, quantity, unit: a.unit, sourceMessageId: turn, customerExplicit: true, confidence: cur.productId || a.label ? "HIGH" : "MEDIUM", ...(a.label && !cur.match ? { match: a.label, label: a.display } : {}) };
    changed = true;
  }
  return changed ? done(items) : cart;
}

/** Tên sản phẩm bỏ phần quy cách trong ngoặc («Chả mực giã tay (Size: 1kg)» ⇒ «Chả mực giã tay»). */
const productName = (name: string) => name.replace(/\s*\([^)]*\)\s*$/, "").trim() || name;

// ─────────────────────────── CHỮ BOT ───────────────────────────

const TRIAL_RE = /(?:^| )(?:an thu|dung thu|thu truoc|lay thu|mua thu|goi thu|thu (?:1|mot|it)|it thoi|lay it)(?: |$)/;
const REASK_RE = /(?:^| )(?:lay|mua|dat|can)? ?(?:may|bao nhieu) (?:kg|ky|ki|can|goi|hop|tui|phan|lang)(?: |$)/;

/** Câu GIỮ ĐƠN thay câu bot định hạ số lượng — «Dạ, em giữ đơn 2kg chả cá thu như mình đã chọn nhé.» HÀM THUẦN. */
export function holdCartText(cart: CartCommitment): string {
  const parts = cart.selectedItems.filter((x) => x.customerExplicit).map((x) => `${amountText(x.quantity, x.unit)}${x.label ? ` ${x.label.toLowerCase()}` : ""}`);
  return `Dạ, em giữ đơn ${parts.join(" + ") || "như cũ"} như mình đã chọn nhé.`;
}

/**
 * Chữ bot sắp gửi có ĐỀ XUẤT ÍT HƠN số khách đã chốt, quay lại GÓI ĂN THỬ, hay HỎI LẠI số lượng đã biết không. Có ⇒ trả câu giữ
 * đơn để thay chỗ. Câu nói lại đúng số khách chọn, mời THÊM món, hay giải thích quy gói («2kg = 2 gói 1kg») đều qua. HÀM THUẦN.
 */
export function cartHoldVerdict(botText: string, cart: CartCommitment | undefined, customerText = ""): { reason: "DOWNSELL" | "TRIAL" | "REASK"; safeText: string; note: string } | null {
  const explicit = cart?.selectedItems.filter((x) => x.customerExplicit) ?? [];
  if (!cart || !explicit.length) return null;
  const f = foldVi(botText);
  // Khách VỪA hỏi về đúng lượng đó («1kg thì bao nhiêu?») ⇒ bot trả lời câu hỏi, không phải tự hạ số lượng.
  const asked = amountsIn(customerText);
  const all = amountsIn(botText);
  // Đơn giá («400.000đ một gói», «1kg 280.000 ₫», «280k/kg», «mỗi gói») là báo giá theo đơn vị, không phải đề nghị lấy ít hơn.
  const unitPrice = (a: CartAmount) =>
    /(?:\d[\d.,]*\s*(?:đ|₫|k|nghìn|ngàn|vnđ|vnd)|\/|mỗi|moi)\s*$/i.test(botText.slice(Math.max(0, a.index - 16), a.index)) || /^\s*(?:[:=–-]\s*)?\d[\d.,]*\s*(?:đ|₫|k(?![\p{L}])|nghìn|ngàn|tr(?![\p{L}])|vnđ|vnd)/iu.test(botText.slice(a.end, a.end + 24));
  const said = all.filter((a) => !/(?:^| )(?:them|cong|cong them|kem|lay them|tang|tang kem)$/.test(tail(botText.slice(0, a.index))) && !asked.some((q) => q.unit === a.unit && q.value === a.value) && !unitPrice(a));
  const single = explicit.length === 1 ? explicit[0] : null;
  // Chỉ lượng nói về CHÍNH món đó (không tên, hoặc tên khớp) — «tặng 1 gói ruốc» không phải hạ «2 gói chả mực».
  const aboutItem = (a: CartAmount) => Boolean(single) && a.unit === single!.unit && (!a.label || !single!.match || labelsMatch(a.label, single!.match));
  const smaller = said.some((a) => aboutItem(a) && a.value < single!.quantity);
  const mentionsCommitted = single ? all.some((a) => a.unit === single.unit && a.value === single.quantity) : true;
  const hit = (reason: "DOWNSELL" | "TRIAL" | "REASK", note: string) => ({ reason, safeText: holdCartText(cart), note });
  // «lấy THÊM 0,5kg chả mực ăn thử» là mời thêm món (được) — chỉ chặn gói ăn thử THAY cho số khách đã chốt.
  if (TRIAL_RE.test(f) && (smaller || (/(?:^| )(?:lay|mua|dat|chon)(?: |$)/.test(f) && !/(?:^| )them(?: |$)/.test(f)))) return hit("TRIAL", "AI gợi ý gói ăn thử / lấy ít hơn sau khi khách đã chốt số lượng — đã thay bằng câu giữ đơn");
  if (smaller && !mentionsCommitted) return hit("DOWNSELL", "AI đề xuất số lượng thấp hơn số khách đã chốt — đã thay bằng câu giữ đơn");
  if (REASK_RE.test(f) && (botText.includes("?") || /(?:^| )(?:a|ak|nhe|nha|vay)$/.test(f))) return hit("REASK", "AI hỏi lại số lượng khách đã nói — đã thay bằng câu giữ đơn");
  const pair = said.length >= 2 && /(?:^| )hay(?: |$)/.test(f) && botText.includes("?");
  if (pair) return hit("REASK", "AI hỏi lại số lượng khách đã nói — đã thay bằng câu giữ đơn");
  return null;
}

// ═══════════════ HẾT BẢN SAO ═══════════════

export const CART_AUDIT_DEFAULT_DAYS = 7;
export const CART_AUDIT_MAX_DAYS = 30;
/** Trần hội thoại đọc — đủ cho một shop, có trần để không quét vô hạn. */
export const CART_AUDIT_MAX_CONVERSATIONS = 5000;
/** Số mã hội thoại tối đa in cho mỗi lỗi (phần MÃ HOÁ). */
export const CART_AUDIT_LIST_CAP = 300;
const USAGE = `<mã tổ chức> [--days=1..${CART_AUDIT_MAX_DAYS}] [--since=<ISO>]`;

export type CartAuditArgs = { code: string; days: number; since: Date | null };

/** Soát đối số. HÀM THUẦN. */
export function parseCartAuditArgs(argv: readonly string[], now: Date = new Date()): CartAuditArgs | { error: string } {
  const bad = argv.find((a) => a.startsWith("--") && !/^--(days|since)=/.test(a));
  if (bad) return { error: `cờ lạ ${bad.slice(0, 20)}` };
  const code = (argv.find((a) => !a.startsWith("--")) ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(code)) return { error: "thiếu / sai mã tổ chức" };
  const raw = argv.find((a) => a.startsWith("--days="))?.slice(7);
  const days = raw === undefined ? CART_AUDIT_DEFAULT_DAYS : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > CART_AUDIT_MAX_DAYS) return { error: `--days phải là số nguyên 1..${CART_AUDIT_MAX_DAYS}` };
  const rawSince = argv.find((a) => a.startsWith("--since="))?.slice(8);
  let since: Date | null = null;
  if (rawSince !== undefined) {
    const t = /^\d{4}-\d{2}-\d{2}/.test(rawSince) ? Date.parse(rawSince) : NaN;
    if (!Number.isFinite(t)) return { error: "--since phải là mốc ISO (vd 2026-10-12T14:30:00+07:00)" };
    if (t > now.getTime()) return { error: "--since ở tương lai" };
    if (t < now.getTime() - CART_AUDIT_MAX_DAYS * 86_400_000) return { error: `--since cũ hơn ${CART_AUDIT_MAX_DAYS} ngày` };
    since = new Date(t);
  }
  return { code, days, since };
}

type Block = { type?: unknown; text?: unknown; name?: unknown; content?: unknown; isError?: unknown };
const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : []);
const textOf = (content: unknown) =>
  blocksOf(content)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => String(b.text))
    .join("\n")
    .trim();
/** Tin «[Shop đã nhắn] …» là tin page / nhân viên chép vào lịch sử — không phải chữ bot. */
const SHOP_SAID_RE = /^\[Shop đã nhắn\]/;

export type AuditMsg = { seq: number; role: string; at: Date; content: unknown };
export type DriftKind = "TEXT_DOWNSELL" | "TEXT_TRIAL" | "DRAFT_REDUCED";
export type ConversationVerdict = {
  /** Có ít nhất một số lượng khách nói tường minh (trong cả hội thoại). */
  explicit: boolean;
  drift: { seq: number; at: Date; kind: DriftKind }[];
  /** Mốc tin khách làm hội thoại đủ ORDER_READY (null = chưa bao giờ). */
  readyAt: Date | null;
  loop: { seq: number; at: Date; kind: "REASK" | "UPSELL" | "CONSULT" | "CONFIRM_ASK" }[];
};

const PHONE_IN_TEXT_RE = /(?:\+?84|0)(?:[\s.-]?\d){8,10}(?!\d)/;
const AT_END_Q = /(?:\?|(?:^| )(?:khong|ko|k|a|nhe|nha|nhi|chua|khong a|nhe a|nha a)\s*$)/;

/** Bot hỏi / tư vấn / mời chung chung khi đơn đã đủ để chốt (đọc từ chữ, ESTIMATED). HÀM THUẦN. */
export function genericSalesAsk(botText: string, cart: CartCommitment | undefined, customerText: string): "REASK" | "UPSELL" | "CONSULT" | "CONFIRM_ASK" | null {
  const f = foldVi(botText);
  const asks = botText.includes("?") || AT_END_Q.test(f);
  if (!asks) return null;
  const hold = cartHoldVerdict(botText, cart, customerText);
  if (hold?.reason === "REASK") return "REASK";
  if (/(?:^| )(?:cho em xin|xin) (?:sdt|so dien thoai|so dt|dia chi|ten|ho ten)(?: |$)/.test(f)) return "REASK";
  if (/(?:^| )(?:lay them gi|them gi (?:khong|ko|nua)|them mon|co muon (?:lay |dung |mua )?them|lay them (?:mon|it|chut)|chon them)(?: |$)/.test(f)) return "UPSELL";
  if (/(?:^| )(?:co chot|chot (?:don )?(?:khong|ko|luon khong|nhe|nha)|xac nhan giup|em gui don (?:nhe|luon|nha)|em len don (?:nhe|luon nhe|nha))(?: |$)/.test(f)) return "CONFIRM_ASK";
  if (/(?:^| )(?:can tu van|tham khao|muon (?:xem|tim hieu)|quan tam (?:mon|san pham)|lay mon nao|chon mon nao|mon nao)(?: |$)/.test(f)) return "CONSULT";
  return null;
}

/** Lượng (gram hoặc gói) của MỘT món trong dòng hàng kết quả công cụ (`lines[].name` mang quy cách «(1kg)»). */
function draftAmount(lines: readonly { name: string; quantity: number }[], item: CommittedItem): number | null {
  const mine = item.match ? lines.filter((l) => labelsMatch(item.match, productName(l.name))) : lines;
  const products = new Set(mine.map((l) => foldVi(productName(l.name))));
  if (!mine.length || (!item.match && products.size !== 1)) return null;
  if (item.unit === "pack") return mine.reduce((s, l) => s + l.quantity, 0);
  let grams = 0;
  for (const l of mine) {
    const w = amountsIn(l.name).find((a) => a.unit === "g");
    if (!w) return null;
    grams += w.value * l.quantity;
  }
  return grams;
}

/**
 * Đi MỘT hội thoại theo thứ tự tin: tin khách cập nhật giỏ (cùng luật với bản sửa), tin bot đối chiếu với giỏ, kết quả công cụ ghi
 * đơn đối chiếu với giỏ. `windowStart` = chỉ ĐẾM sự việc từ mốc đó (tin trước mốc vẫn đọc để biết khách đã nói gì). HÀM THUẦN.
 */
export function auditConversation(msgs: readonly AuditMsg[], windowStart: Date): ConversationVerdict {
  let cart: CartCommitment | undefined;
  let phone = false;
  let address = false;
  let readyAt: Date | null = null;
  let customerAfterReady = 0;
  let confirmed = false;
  let lastCustomer = "";
  let explicit = false;
  const drift: ConversationVerdict["drift"] = [];
  const loop: ConversationVerdict["loop"] = [];
  const counted = (at: Date) => at.getTime() >= windowStart.getTime();
  for (const m of [...msgs].sort((a, b) => a.seq - b.seq)) {
    const blocks = blocksOf(m.content);
    if (m.role === "user" && blocks.some((b) => b.type === "tool_result")) {
      for (const b of blocks.filter((x) => x.type === "tool_result" && x.isError !== true)) {
        let p: Record<string, unknown> | null = null;
        try {
          p = JSON.parse(String(b.content)) as Record<string, unknown>;
        } catch {
          p = null;
        }
        if (!p) continue;
        if (p.confirmed === true || p.auto_confirmed === true) confirmed = true;
        const lines = Array.isArray(p.lines) ? (p.lines as { name?: unknown; quantity?: unknown }[]).filter((l) => typeof l.name === "string" && typeof l.quantity === "number").map((l) => ({ name: String(l.name), quantity: Number(l.quantity) })) : [];
        if (!lines.length || !("order_code" in p) || !cart) continue;
        for (const item of cart.selectedItems.filter((x) => x.customerExplicit)) {
          const got = draftAmount(lines, item);
          if (got !== null && got < item.quantity && counted(m.at)) drift.push({ seq: m.seq, at: m.at, kind: "DRAFT_REDUCED" });
        }
      }
      continue;
    }
    const text = textOf(m.content);
    if (!text) continue;
    if (m.role === "user") {
      lastCustomer = text;
      cart = applyCustomerCartMessage(cart, text, m.seq, m.at);
      const items = cart?.selectedItems.filter((x) => x.customerExplicit) ?? [];
      if (items.length) explicit = true;
      if (PHONE_IN_TEXT_RE.test(text)) phone = true;
      if (resolveRecipientPlace({ address: text, province: "", ward: "" }).province) address = true;
      if (readyAt) customerAfterReady += 1;
      else if (items.length && phone && address) readyAt = m.at;
      continue;
    }
    if (m.role !== "assistant" || SHOP_SAID_RE.test(text)) continue;
    const hold = cartHoldVerdict(text, cart, lastCustomer);
    if (hold && hold.reason !== "REASK" && counted(m.at)) drift.push({ seq: m.seq, at: m.at, kind: hold.reason === "TRIAL" ? "TEXT_TRIAL" : "TEXT_DOWNSELL" });
    if (readyAt && !confirmed && customerAfterReady >= 1 && counted(m.at)) {
      const ask = genericSalesAsk(text, cart, lastCustomer);
      if (ask) loop.push({ seq: m.seq, at: m.at, kind: ask });
    }
  }
  return { explicit, drift, readyAt, loop };
}

/** «3/40 (7,5%)» · mẫu < 30 ⇒ «· mẫu nhỏ»; mẫu 0 ⇒ «CHƯA ĐO ĐƯỢC». HÀM THUẦN. */
export function rateText(n: number, d: number): string {
  if (!d) return "CHƯA ĐO ĐƯỢC (mẫu 0)";
  return `${n}/${d} (${((n / d) * 100).toLocaleString("vi-VN", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%)${d < 30 ? " · mẫu nhỏ" : ""}`;
}

export type CartAuditResult = {
  conversations: number;
  explicit: number;
  driftConvs: string[];
  driftByKind: Record<DriftKind, number>;
  ready: number;
  loopConvs: string[];
  loopByKind: Record<string, number>;
};

const chunk = <T,>(xs: readonly T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** Đọc hội thoại cập nhật từ `windowStart` + toàn bộ tin của chúng (chỉ ĐỌC), chấm từng hội thoại, in tóm tắt. */
export async function runCartIntentAudit(db: Db, opts: { windowStart: Date; now: Date; label: string; convIds?: readonly string[] }): Promise<CartAuditResult> {
  const c = schema.salesChatConversations;
  const m = schema.salesChatMessages;
  const convRows = await db
    .select({ id: c.id })
    .from(c)
    .where(and(gte(c.updatedAt, opts.windowStart), ...(opts.convIds ? [inArray(c.id, [...opts.convIds])] : [])))
    .orderBy(sql`${c.updatedAt} desc`)
    .limit(CART_AUDIT_MAX_CONVERSATIONS);
  const ids = convRows.map((r) => r.id);
  const byConv = new Map<string, AuditMsg[]>();
  for (const part of chunk(ids, 200)) {
    for (const r of await db.select({ conv: m.conversationId, seq: m.seq, role: m.role, content: m.content, at: m.createdAt }).from(m).where(inArray(m.conversationId, part)).orderBy(asc(m.conversationId), asc(m.seq))) {
      byConv.set(r.conv, [...(byConv.get(r.conv) ?? []), { seq: r.seq, role: r.role, at: r.at, content: r.content }]);
    }
  }
  const out: CartAuditResult = { conversations: ids.length, explicit: 0, driftConvs: [], driftByKind: { TEXT_DOWNSELL: 0, TEXT_TRIAL: 0, DRAFT_REDUCED: 0 }, ready: 0, loopConvs: [], loopByKind: {} };
  for (const id of ids) {
    const v = auditConversation(byConv.get(id) ?? [], opts.windowStart);
    if (v.explicit) out.explicit += 1;
    if (v.drift.length) {
      out.driftConvs.push(id);
      for (const d of v.drift) out.driftByKind[d.kind] += 1;
    }
    if (v.readyAt) out.ready += 1;
    if (v.loop.length) {
      out.loopConvs.push(id);
      for (const l of v.loop) out.loopByKind[l.kind] = (out.loopByKind[l.kind] ?? 0) + 1;
    }
  }
  const kinds = (r: Record<string, number>) => Object.entries(r).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(" · ") || "0";
  tomTat(`cart-intent-audit ${opts.label}: ${out.conversations}${out.conversations >= CART_AUDIT_MAX_CONVERSATIONS ? "+" : ""} hội thoại cập nhật trong kỳ · có số lượng khách nói tường minh ${out.explicit} · đủ ORDER_READY ${out.ready}`);
  tomTat(`CART_INTENT_DRIFT (ESTIMATED — đọc từ chữ + dòng hàng kết quả công cụ): ${rateText(out.driftConvs.length, out.explicit)} hội thoại có số lượng tường minh · sự việc ${kinds(out.driftByKind)}`);
  tomTat(`ORDER_READY_LOOP (ESTIMATED — đọc từ chữ): ${rateText(out.loopConvs.length, out.ready)} hội thoại đủ ORDER_READY vẫn bị hỏi / mời / tư vấn chung chung trước khi chốt · lượt ${kinds(out.loopByKind)}`);
  tomTat("mã hội thoại theo từng lỗi ở phần MÃ HOÁ");
  console.log(`  CART_INTENT_DRIFT (${out.driftConvs.length}, in ≤ ${CART_AUDIT_LIST_CAP}): ${out.driftConvs.slice(0, CART_AUDIT_LIST_CAP).join(" ") || "—"}`);
  console.log(`  ORDER_READY_LOOP (${out.loopConvs.length}, in ≤ ${CART_AUDIT_LIST_CAP}): ${out.loopConvs.slice(0, CART_AUDIT_LIST_CAP).join(" ") || "—"}`);
  return out;
}

async function thoat(code: number): Promise<never> {
  // Xả stdout RỒI mới thoát: stdout vào ống là ghi bất đồng bộ — `process.exit()` ngay sau console.log cắt mất khối tóm tắt cuối.
  await new Promise<void>((done) => process.stdout.write("", () => done()));
  process.exit(code);
}

async function main() {
  const now = new Date();
  const args = parseCartAuditArgs(process.argv.slice(2), now);
  if ("error" in args) {
    tomTat(`cart-intent-audit: DỪNG · cách dùng sai — ${args.error} (arg: ${USAGE})`);
    return thoat(1);
  }
  const org = await findOrganization(args.code);
  if (!org) {
    tomTat(`cart-intent-audit: DỪNG · không có tổ chức «${args.code}»`);
    return thoat(1);
  }
  const db: Db = await getDbForInspection({ code: org.code, isHome: org.isHome });
  const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") !== "on") {
    tomTat("cart-intent-audit: DỪNG · phiên CSDL KHÔNG ở chế độ chỉ đọc — không đọc gì");
    return thoat(1);
  }
  const windowStart = args.since ?? new Date(now.getTime() - args.days * 86_400_000);
  await runCartIntentAudit(db, { windowStart, now, label: args.since ? `từ ${args.since.toISOString()}` : `${args.days} ngày tới ${now.toISOString()}` });
  return thoat(0);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch(async (e) => {
    console.error("cart-intent-audit lỗi:", e instanceof Error ? e.message : e);
    tomTat("cart-intent-audit: LỖI ngoài phép đo — chi tiết trong phần mã hoá");
    await thoat(1);
  });
}

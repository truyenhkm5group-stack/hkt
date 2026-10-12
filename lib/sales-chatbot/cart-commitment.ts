/**
 * ═══════════ GIỎ CÓ THẨM QUYỀN — SỐ LƯỢNG KHÁCH NÓI TƯỜNG MINH LÀ «DÍNH» (P0 12/10/2026, HSLC) ═══════════
 *
 * Ca production: khách «Cho chị 2kg chả cá thu / ĐT 03… / F4/22A …» (món + 2kg + SĐT + địa chỉ trong một tin), rồi «Ngon chị mới
 * lấy nha em» ⇒ AI «Mình lấy 1kg ăn thử trước nhé…» — tự HẠ số lượng khách đã chốt. Gốc: model dựng lại giỏ từ văn xuôi mỗi lượt và
 * đọc một câu mơ hồ thành lời hoãn. Sửa ở MÁY CHỦ, không trông vào lời dặn:
 *
 *  1. `classifyCartMessage` — câu khách là SỬA TƯỜNG MINH («đổi còn 1kg», «lấy 1kg thôi», «bớt 1kg», «thôi lấy 3kg», «không lấy chả cá
 *     nữa») hay MƠ HỒ («ok», «ngon chị mới lấy nha em», «không lấy thêm đâu», «để lần sau», «thế nhé», «ship giúp chị»). Mặc định BẢO
 *     THỦ: không chắc là sửa ⇒ KHÔNG đổi giỏ (giữ số khách đã nói; model hỏi lại nếu cần).
 *  2. `applyCustomerCartMessage` — giỏ `selectedItems[]` (món · số lượng · đơn vị · tin nguồn · độ tin · `customerExplicit`) chỉ đổi khi
 *     có câu sửa tường minh MỚI.
 *  3. `commitmentViolation` — công cụ ghi đơn (create / update_draft_order) cố GIẢM / BỎ một món khách đã nói tường minh ⇒ TỪ CHỐI.
 *     Tăng / thêm món khác (mời thêm món) vẫn được — upsell không bao giờ là downsell.
 *  4. `cartHoldVerdict` — chữ bot đề xuất ít hơn / gói ăn thử / hỏi lại số lượng đã biết ⇒ thay bằng câu GIỮ ĐƠN.
 *  5. `orderReadiness` + `cartCommitmentPrompt` — trạng thái thẩm quyền (món, số lượng, SĐT, địa chỉ, giá máy chủ, mức sẵn sàng) đưa
 *     vào lời nhắc TRƯỚC lời gọi model. Mức «đủ để chốt» của đơn nháp đọc từ `autoConfirmBlocker` (P0-A) — không có luật thứ hai.
 *
 * HÀM THUẦN, không đọc CSDL. Không động tới giá / tồn / SKU: số tiền vẫn chỉ từ báo giá máy chủ (`quote.ts`).
 */
import { resolveRecipientPlace } from "@/lib/address/vn-address";
import { manualOrderGaps } from "@/lib/constants/manual-orders";
import { formatVND } from "@/lib/format";
import { foldVi } from "@/lib/sales-chatbot/text";

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

// ─────────────────────────── ĐỐI CHIẾU VỚI CÔNG CỤ GHI ĐƠN ───────────────────────────

/** Tên sản phẩm bỏ phần quy cách trong ngoặc («Chả mực giã tay (Size: 1kg)» ⇒ «Chả mực giã tay»). */
const productName = (name: string) => name.replace(/\s*\([^)]*\)\s*$/, "").trim() || name;

/** Dòng hàng model đề nghị (`Priced.asked` — trước khi máy chủ quy gói). */
export type AskedLine = { variantId: string; productId: string | null; name: string; quantity: number; weightGrams: number | null };

/** Sản phẩm của đơn đề nghị ứng với một món trong giỏ: đã gắn ⇒ theo mã; chưa ⇒ khớp tên (đúng một); giỏ một món + đơn một món ⇒ món đó. */
function productFor(item: CommittedItem, cart: CartCommitment, asked: readonly AskedLine[]): string | null {
  if (item.productId) return item.productId;
  const products = [...new Set(asked.map((l) => l.productId).filter((x): x is string => Boolean(x)))];
  if (item.match) {
    const hits = products.filter((p) => asked.some((l) => l.productId === p && labelsMatch(item.match, l.name)));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return null;
  }
  const unbound = cart.selectedItems.filter((x) => !x.productId);
  const boundProducts = new Set(cart.selectedItems.map((x) => x.productId).filter(Boolean));
  const free = products.filter((p) => !boundProducts.has(p));
  if (unbound.length === 1 && free.length === 1 && (!item.match || cart.selectedItems.length === 1)) return free[0];
  // Câu không nêu tên («cho chị 2 gói, thêm 1 ruốc») mà đơn có nhiều món ⇒ món DUY NHẤT có đúng lượng khách nói.
  if (item.match) return null;
  const exact = free.filter((p) => proposedAmount(p, item.unit, asked) === item.quantity);
  return exact.length === 1 ? exact[0] : null;
}

/** Lượng đề nghị của một sản phẩm theo đơn vị của món trong giỏ; `null` = không đo được (thiếu khối lượng mẫu mã). */
function proposedAmount(productId: string, unit: CartUnit, asked: readonly AskedLine[]): number | null {
  const lines = asked.filter((l) => l.productId === productId);
  if (unit === "pack") return lines.reduce((s, l) => s + l.quantity, 0);
  if (lines.some((l) => l.weightGrams == null)) return lines.length ? null : 0;
  return lines.reduce((s, l) => s + (l.weightGrams ?? 0) * l.quantity, 0);
}

/**
 * KIỂM CỨNG phía máy chủ: đơn đề nghị GIẢM hoặc BỎ một món khách đã nói tường minh mà giỏ chưa ghi nhận câu sửa tường minh nào mới
 * hơn ⇒ câu lỗi cho model (công cụ từ chối). Tăng / thêm món khác ⇒ `null` (được). Không đo được ⇒ `null` (không đoán). HÀM THUẦN.
 */
export function commitmentViolation(cart: CartCommitment | undefined, asked: readonly AskedLine[]): string | null {
  if (!cart) return null;
  for (const item of cart.selectedItems) {
    if (!item.customerExplicit) continue;
    const pid = productFor(item, cart, asked);
    if (!pid) continue;
    const proposed = proposedAmount(pid, item.unit, asked);
    if (proposed === null || proposed >= item.quantity) continue;
    const name = item.label || asked.find((l) => l.productId === pid)?.name || "món khách chọn";
    const want = amountText(item.quantity, item.unit);
    const what = proposed === 0 ? `bỏ «${name}»` : `hạ «${name}» từ ${want} xuống ${amountText(proposed, item.unit)}`;
    return `KHÔNG được ${what}: khách đã nói TƯỜNG MINH ${want} ${name}${item.sourceMessageId !== null ? ` (tin #${item.sourceMessageId})` : ""} và CHƯA có câu sửa tường minh nào mới hơn. Giữ ĐÚNG ${want}; KHÔNG gợi ý gói ăn thử / gói nhỏ hơn, KHÔNG hỏi lại số lượng. Chỉ đổi khi khách nói rõ («đổi còn …», «lấy … thôi», «bớt …», «không lấy … nữa»). Mời thêm món chỉ được THÊM món khác — khách không nhận lời mời thì chốt đúng đơn ${want} ${name}.`;
  }
  return null;
}

/**
 * Sau khi đơn nháp ghi xong: gắn sản phẩm / mẫu mã cho món của giỏ, và ghi món bot đề xuất mà khách chưa nói số (`customerExplicit
 * = false`, không dính) theo đúng lượng của đơn. Món khách đã nói giữ NGUYÊN số khách nói (sàn), kể cả khi đơn lấy nhiều hơn. HÀM THUẦN.
 */
export function bindCommitment(cart: CartCommitment | undefined, asked: readonly AskedLine[], turn: number | null, now: Date): CartCommitment | undefined {
  const products = [...new Set(asked.map((l) => l.productId).filter((x): x is string => Boolean(x)))];
  if (!products.length) return cart;
  const base: CartCommitment = cart ?? { selectedItems: [], turn, at: now.toISOString() };
  const items = base.selectedItems.map((it) => {
    if (it.productId) return it;
    const pid = productFor(it, base, asked);
    if (!pid) return it;
    const line = asked.find((l) => l.productId === pid)!;
    return { ...it, productId: pid, variantId: line.variantId, label: it.label || productName(line.name), match: it.match || foldVi(productName(line.name)), confidence: "HIGH" as const };
  });
  const bound = new Set(items.map((x) => x.productId).filter(Boolean));
  const kept = items.filter((x) => x.customerExplicit || (x.productId && products.includes(x.productId)));
  for (const pid of products) {
    const line = asked.find((l) => l.productId === pid)!;
    const grams = proposedAmount(pid, "g", asked);
    const unit: CartUnit = grams !== null && grams > 0 ? "g" : "pack";
    const amount = unit === "g" ? grams! : proposedAmount(pid, "pack", asked)!;
    const i = kept.findIndex((x) => x.productId === pid);
    if (i >= 0) {
      if (!kept[i].customerExplicit) kept[i] = { ...kept[i], quantity: amount, unit };
      continue;
    }
    if (bound.has(pid)) continue;
    kept.push({ label: productName(line.name), match: foldVi(productName(line.name)), productId: pid, variantId: line.variantId, sku: null, quantity: amount, unit, sourceMessageId: null, confidence: "LOW", customerExplicit: false });
  }
  const same = cart && kept.length === cart.selectedItems.length && kept.every((x, i) => JSON.stringify(x) === JSON.stringify(cart.selectedItems[i]));
  return same ? cart : { ...base, selectedItems: kept, at: now.toISOString() };
}

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

// ─────────────────────────── MỨC SẴN SÀNG + LỜI NHẮC ───────────────────────────

export type OrderReadiness = "CONFIRMED" | "ORDER_READY" | "NEED_ITEMS" | "NEED_PHONE" | "NEED_ADDRESS" | "ON_HOLD" | "BROWSING";

const PHONE_IN_TEXT_RE = /(?:\+?84|0)(?:[\s.-]?\d){8,10}(?!\d)/;

type ReadinessInput = {
  cart?: CartCommitment;
  customer?: { phone: string; address: string; province: string };
  draft?: { lines: readonly unknown[]; recipient: { phone: string; address: string; province: string } };
  confirmed?: unknown;
  /** `autoConfirmBlocker` của đơn nháp (P0-A) — `null` = đủ để chốt. Chỉ xét khi có đơn nháp. */
  blocker: string | null;
  lastUserText: string;
  /** Câu cuối của khách đang hoãn / từ chối (cùng biểu thức với P0-A). */
  hesitating: boolean;
};

/**
 * Đơn đang ở mức nào. Có đơn nháp ⇒ đúng điều kiện tự chốt P0-A (`blocker`). Chưa có ⇒ giỏ có món khách nói tường minh + SĐT hợp
 * lệ + địa chỉ đọc được tỉnh / thành (từ khách đã lưu hoặc NGAY trong câu khách) ⇒ ORDER_READY. HÀM THUẦN.
 */
export function orderReadiness(s: ReadinessInput): { level: OrderReadiness; missing: string | null } {
  if (s.confirmed) return { level: "CONFIRMED", missing: null };
  const explicit = s.cart?.selectedItems.filter((x) => x.customerExplicit) ?? [];
  if (s.draft) {
    if (!s.blocker) return { level: "ORDER_READY", missing: null };
    if (/SĐT/.test(s.blocker)) return { level: "NEED_PHONE", missing: s.blocker };
    if (/Địa chỉ/.test(s.blocker)) return { level: "NEED_ADDRESS", missing: s.blocker };
    if (/món \/ số lượng/.test(s.blocker)) return { level: "NEED_ITEMS", missing: s.blocker };
    return { level: "ON_HOLD", missing: s.blocker };
  }
  if (!explicit.length) return { level: "BROWSING", missing: null };
  if (s.hesitating) return { level: "ON_HOLD", missing: "Khách chưa quyết mua (đang hoãn / cân nhắc)" };
  if (explicit.every((x) => !x.match && !x.productId)) return { level: "NEED_ITEMS", missing: "Câu khách nêu số lượng mà không nêu tên món — xác định món theo lịch sử hội thoại (chỉ hỏi lại khi thật sự chưa rõ), KHÔNG hỏi lại số lượng" };
  const phone = s.customer?.phone ?? (s.lastUserText.match(PHONE_IN_TEXT_RE)?.[0] ?? "");
  const address = s.customer?.address ?? s.lastUserText;
  const province = s.customer?.province || resolveRecipientPlace({ address, province: "", ward: "" }).province;
  const gaps = manualOrderGaps({ phone, address, province }, explicit.length);
  if (gaps.includes("SĐT")) return { level: "NEED_PHONE", missing: "Chưa có SĐT hợp lệ" };
  if (gaps.includes("địa chỉ") || gaps.includes("tỉnh / thành")) return { level: "NEED_ADDRESS", missing: "Chưa có địa chỉ giao đọc được tỉnh / thành" };
  return { level: "ORDER_READY", missing: null };
}

const maskPhone = (p: string) => {
  const d = p.replace(/\D/g, "");
  return d.length >= 3 ? `…${d.slice(-3)}` : "có";
};

/**
 * Khối «ĐƠN HIỆN TẠI» đưa vào lời nhắc TRƯỚC lời gọi model — model đọc trạng thái máy chủ giữ, không dựng lại giỏ từ lịch sử chat.
 * Chỉ có khi giỏ có món khách nói tường minh (lời nhắc các hội thoại khác không đổi). HÀM THUẦN.
 */
export function cartCommitmentPrompt(
  s: { cart?: CartCommitment; customer?: { phone: string; address: string; province: string }; draft?: { lines: readonly { variantId: string; quantity: number }[]; quote?: { subtotal: number; total: number | null } }; confirmed?: unknown },
  r: { level: OrderReadiness; missing: string | null },
  opts: { autoConfirm?: boolean } = {},
): string {
  const explicit = s.cart?.selectedItems.filter((x) => x.customerExplicit) ?? [];
  if (!s.cart || !explicit.length) return "";
  const items = s.cart.selectedItems.map((x) => `${amountText(x.quantity, x.unit)} ${x.label || "(chưa rõ món)"}${x.customerExplicit ? ` — khách nói TƯỜNG MINH${x.sourceMessageId !== null ? ` ở tin #${x.sourceMessageId}` : ""}, CỐ ĐỊNH` : " — bot đề xuất, khách chưa nói số"}`);
  const money = s.draft?.quote ? `đơn nháp ${s.draft.lines.length} dòng · tiền hàng ${formatVND(s.draft.quote.subtotal)} (giá MÁY CHỦ — đọc đúng số này)` : "chưa có đơn nháp / báo giá máy chủ";
  const phone = s.customer?.phone ? `đã có (${maskPhone(s.customer.phone)})` : "chưa lưu";
  const addr = s.customer?.address ? `đã có${s.customer.province || resolveRecipientPlace({ address: s.customer.address, province: "", ward: "" }).province ? " — đọc được tỉnh / thành" : " — CHƯA đọc được tỉnh / thành"}` : "chưa lưu";
  const act: Record<OrderReadiness, string> = {
    ORDER_READY: s.draft
      ? opts.autoConfirm
        ? "đủ để chốt ⇒ gọi update_draft_order (không cần đổi gì) để máy chủ tự chốt rồi gửi đúng say_to_customer. KHÔNG hỏi «lấy thêm gì không», KHÔNG tư vấn / mời lại."
        : "đủ để chốt ⇒ đọc tóm tắt ngắn ĐÚNG đơn trên; khách đồng ý ⇒ confirm_order. KHÔNG tư vấn / mời lại."
      : "đủ món + số lượng + SĐT + địa chỉ ⇒ create_customer rồi create_draft_order NGAY với ĐÚNG số lượng trên (máy chủ tính giá, tự chốt nếu shop bật). KHÔNG hỏi thêm, KHÔNG tư vấn chung chung.",
    NEED_PHONE: `CHỈ hỏi đúng phần còn thiếu (${r.missing ?? "SĐT"}). GIỮ NGUYÊN món + số lượng.`,
    NEED_ADDRESS: `CHỈ hỏi đúng phần còn thiếu của địa chỉ (${r.missing ?? "địa chỉ giao"}). GIỮ NGUYÊN món + số lượng, không đổi món.`,
    NEED_ITEMS: `${r.missing ?? "Chưa rõ món"}.`,
    ON_HOLD: `${r.missing ?? "chưa chốt được — không tự chốt"}; vẫn GIỮ NGUYÊN món + số lượng, không đề xuất ít hơn.`,
    CONFIRMED: "đơn đã chốt — không xin xác nhận lại.",
    BROWSING: "chưa đủ thông tin.",
  };
  return [
    "ĐƠN HIỆN TẠI — TRẠNG THÁI THẨM QUYỀN của máy chủ (KHÔNG tự dựng lại giỏ từ lịch sử chat):",
    `  · Món: ${items.join(" · ")}`,
    `  · Tiền: ${money}`,
    `  · SĐT: ${phone} · Địa chỉ: ${addr}`,
    `  · Mức sẵn sàng: ${r.level} — ${act[r.level]}`,
    s.cart.clarify ? `  · Cần hỏi lại: ${s.cart.clarify}` : "",
    "LUẬT GIỎ: số lượng khách nói TƯỜNG MINH là CỐ ĐỊNH. KHÔNG đề xuất ít hơn, KHÔNG gợi ý gói ăn thử / gói nhỏ hơn, KHÔNG hỏi lại số lượng đã biết. Câu mơ hồ («ok», «ngon chị mới lấy nha em», «không lấy thêm», «để lần sau», «thế nhé») KHÔNG đổi giỏ. Chỉ câu SỬA rõ ràng («đổi còn 1kg», «lấy 1kg thôi», «bớt 1kg», «không lấy chả cá nữa») mới đổi — máy chủ cập nhật dòng trên và TỪ CHỐI mọi lần hạ / bỏ món khác. Mời thêm món chỉ được THÊM món khác; khách không nhận lời mời ⇒ quay về chốt đúng đơn trên.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Câu khách chỉ TỪ CHỐI LỜI MỜI THÊM MÓN («để lần sau», «không cần thêm», «không lấy thêm», «thế thôi», «vậy thôi») — không phải
 * hoãn cả đơn. Chỉ dùng SAU khi bot đã mời thêm món và giỏ có món khách nói tường minh. HÀM THUẦN.
 */
export function declinesAddOnOnly(text: string): boolean {
  const f = foldVi(text);
  if (/(?:^| )(?:suy nghi|hoi (?:chong|vo|nha|lai)|chua (?:chot|lay|mua|dat)|khoan)(?: |$)/.test(f)) return false;
  return /(?:^| )(?:de lan sau|lan sau (?:nhe|nha|nhe em|nha em|chi lay|minh lay)|khong (?:can|lay) them|ko (?:can|lay) them|the thoi|vay thoi|du roi|thoi du)(?: |$)/.test(f);
}

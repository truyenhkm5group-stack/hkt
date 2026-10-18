/**
 * ═══════════ CÂU MẪU PHẢI NÓI ĐÚNG MÓN KHÁCH HỎI — HÀM THUẦN (P0 18/10/2026, ca «ThanhPhương», HSLC) ═══════════
 *
 * Khách hỏi «xin giá chả cá», bot gửi câu mẫu NEM HẢI SẢN (120.000 ₫ + ảnh nem) sau 0,3 giây. Không phải AI chọn sai: câu mẫu
 * «Nem hải sản tôm bề bề giá bao nhiêu» mang sẵn các cách hỏi «xin giá chả cá», «Báo giá chả cá thu?», «báo giá»… và khớp chữ
 * liền cả cụm (8 điểm) — cao hơn mọi cách hỏi của câu mẫu chả cá thu («Xin giá chả cá thu?» thiếu chữ «thu» nên không khớp).
 * Bước khớp chữ chỉ so CỤM TỪ, không hề biết câu mẫu nói về MÓN nào — một cách hỏi gắn nhầm câu mẫu là đủ để bán sai món.
 *
 * Luật (lõi, mọi tổ chức): MÓN KHÁCH ĐANG HỎI là món khách gọi tên ở tin MỚI NHẤT có gọi tên món trong lượt mua hiện tại
 * (bỏ mệnh đề từ chối — «không lấy nem» không phải đang hỏi nem); khách chưa gọi tên món nào thì lấy món của câu shop / page
 * vừa nói (tin tự động của page giới thiệu chả cá ⇒ «cho giá» là hỏi giá chả cá). MÓN CỦA CÂU MẪU = mã SKU trong chỗ trống
 * `{{giá:SKU}}` / `{{tồn:SKU}}` + tên món trong tiêu đề / câu trả lời. Câu mẫu nói về món KHÁC mọi món khách đang hỏi ⇒
 * không được trả lời câu đó (khớp chữ · AI chọn mã · công cụ `send_quick_reply`) — lượt rơi về bước sau (AI đọc hiểu / chatbot
 * đầy đủ), tức là tốn token chứ không bán sai món. Câu mẫu không gắn món nào (ship, địa chỉ, cảm ơn, menu chung) không bị ảnh hưởng.
 * Bán thêm món khác chỉ đi qua câu UPSELL và cửa sổ lời mời (`next-best-action.ts`), SAU khi đã trả lời đúng món khách hỏi.
 *
 * Nhận diện tên món (`productsNamedIn`) CHẶT HƠN `namedProductsIn` của giỏ: bỏ dấu thì «giá» = «giã», nên «xin giá chả cá» đủ hai từ
 * («chả» + «gia») của «Chả mực giã tay». Ở đây: từ ĐẦU của tên + từ PHÂN BIỆT đứng LIỀN SAU nó (bỏ qua từ chung của cả nhóm cùng từ
 * đầu) — «chả cá» ⇒ Chả cá thu, «chả mực» ⇒ Chả mực giã tay, «ruốc bông tôm» ⇒ Ruốc bông tôm; từ đầu chỉ một món có ⇒ đủ tự nó
 * («nem»). Nhận thiếu chỉ làm câu mẫu không bị lọc (như trước bản vá); nhận thừa chỉ làm câu mẫu bị loại (tốn token, không sai món).
 */
import { mentionText } from "@/lib/sales-chatbot/cart-commitment";
import { parsePlaceholders, type QuickReplyEntry } from "@/lib/sales-chatbot/quick-replies-shared";
import { foldVi } from "@/lib/sales-chatbot/text";

/** Một sản phẩm đang bán: tên (để nhận diện trong chữ) + mã SKU các mẫu mã (để đọc chỗ trống của câu mẫu). */
export type FocusProduct = { name: string; skus: readonly string[] };

/** Món khách đang hỏi. `source` = căn cứ: chữ khách · câu shop / page vừa nói · không có. `declined` = món khách đã từ chối trong lượt. */
export type ProductFocus = { focus: string[]; declined: string[]; source: "CUSTOMER" | "SHOP" | "NONE" };

const uniq = (xs: readonly string[]) => [...new Set(xs)];
const PLACEHOLDER_STRIP_RE = /\{\{[^}]*\}\}/g;

/** Từ của tên món: bỏ mọi phần trong ngoặc («Ruốc bông (chà bông) tôm» ⇒ «ruoc bong tom»), bỏ số và đơn vị khối lượng. */
const nameTokens = (name: string) =>
  foldVi(name.replace(/\([^)]*\)/g, " "))
    .split(" ")
    .filter((w) => w && !/^\d/.test(w) && w !== "kg" && w !== "g");

/** Các món được GỌI TÊN trong chữ (xem đầu tệp). HÀM THUẦN. */
export function productsNamedIn(text: string, names: readonly string[]): string[] {
  const said = foldVi(text).split(" ").filter(Boolean);
  if (!said.length) return [];
  const toks = uniq(names).map((n) => ({ n, t: nameTokens(n) })).filter((x) => x.t.length);
  const out: string[] = [];
  for (const { n, t } of toks) {
    const group = toks.filter((x) => x.t[0] === t[0]);
    if (group.length === 1) {
      if (said.includes(t[0])) out.push(n);
      continue;
    }
    // Từ chung của cả nhóm cùng từ đầu («bong» của hai loại ruốc bông) được bỏ qua; từ ngay sau đó phải là từ RIÊNG của món này.
    const shared = new Set(t.filter((w) => group.every((x) => x.t.includes(w))));
    const own = new Set(t.filter((w) => !shared.has(w) && group.filter((x) => x.t.includes(w)).length === 1));
    for (let i = 0; i < said.length; i++) {
      if (said[i] !== t[0]) continue;
      let j = i + 1;
      while (j < said.length && shared.has(said[j])) j++;
      if (j < said.length && own.has(said[j])) {
        out.push(n);
        break;
      }
    }
  }
  return out;
}

/** Món một câu mẫu nói tới: SKU trong chỗ trống + tên món trong tiêu đề / câu trả lời (KHÔNG đọc cách hỏi — đó là thứ cần kiểm). */
export function quickReplyCovers(entry: Pick<QuickReplyEntry, "title" | "answer">, products: readonly FocusProduct[]): string[] {
  const skus = new Set(parsePlaceholders(entry.answer).filter((h) => h.kind !== "ship" && h.sku).map((h) => h.sku.toUpperCase()));
  const bySku = products.filter((p) => p.skus.some((s) => skus.has(s.toUpperCase()))).map((p) => p.name);
  const byText = productsNamedIn(`${entry.title}\n${entry.answer.replace(PLACEHOLDER_STRIP_RE, " ")}`, products.map((p) => p.name));
  return uniq([...bySku, ...byText]);
}

/**
 * Món khách đang hỏi. `customerTexts` cũ ⇒ mới (phần tử cuối = tin hiện tại), chỉ trong LƯỢT MUA hiện tại; `shopText` = câu shop /
 * page / bot gần nhất. Món được gọi tên trong mệnh đề từ chối vào `declined`, trừ khi khách gọi tên lại nó ở mệnh đề không từ chối.
 */
export function productFocusOf(customerTexts: readonly string[], shopText: string | null, products: readonly FocusProduct[]): ProductFocus {
  const names = products.map((p) => p.name);
  if (!names.length) return { focus: [], declined: [], source: "NONE" };
  const positive: string[] = [];
  const negative: string[] = [];
  let focus: string[] = [];
  for (let i = customerTexts.length - 1; i >= 0; i--) {
    const t = customerTexts[i] ?? "";
    if (!t.trim()) continue;
    const said = productsNamedIn(mentionText([t]), names);
    positive.push(...said);
    negative.push(...productsNamedIn(t, names).filter((n) => !said.includes(n)));
    if (!focus.length && said.length) focus = said;
  }
  const declined = uniq(negative).filter((n) => !positive.includes(n));
  if (focus.length) return { focus: uniq(focus), declined, source: "CUSTOMER" };
  const shop = shopText ? productsNamedIn(shopText, names).filter((n) => !declined.includes(n)) : [];
  return shop.length ? { focus: uniq(shop), declined, source: "SHOP" } : { focus: [], declined, source: "NONE" };
}

/**
 * Câu mẫu có được trả lời khách lúc này không: không gắn món nào ⇒ được; có món khách đang hỏi ⇒ phải nói tới ít nhất một món đó;
 * chưa rõ khách hỏi món gì ⇒ không được nói ĐÚNG những món khách vừa từ chối.
 */
export function fitsFocus(covers: readonly string[], f: ProductFocus): boolean {
  if (!covers.length) return true;
  if (f.focus.length) return covers.some((c) => f.focus.includes(c));
  if (f.declined.length) return covers.some((c) => !f.declined.includes(c));
  return true;
}

/**
 * Câu mẫu có trả lời ĐỦ món khách đang hỏi không — cho bước câu mẫu THAY cả lượt trả lời (khớp chữ · AI chọn mã): khách hỏi «giá chả
 * cá với nem» thì câu báo giá chả cá chỉ trả lời nửa câu ⇒ không đủ, để chatbot đầy đủ trả lời cả hai. Công cụ `send_quick_reply` dùng
 * `fitsFocus` (model gửi được hai câu mẫu, mỗi câu một món).
 */
export function answersFocus(covers: readonly string[], f: ProductFocus): boolean {
  if (!covers.length || !f.focus.length) return fitsFocus(covers, f);
  return f.focus.every((n) => covers.includes(n));
}

/** Bộ lọc dựng MỘT lần mỗi lượt: món khách đang hỏi + phép thử từng câu mẫu (nhớ kết quả theo mã câu mẫu). */
type EntryKey = Pick<QuickReplyEntry, "id" | "title" | "answer">;
export type QuickReplyFocusGuard = { focus: ProductFocus; fits: (entry: EntryKey) => boolean; answers: (entry: EntryKey) => boolean; coversOf: (entry: EntryKey) => string[] };

export function quickReplyFocusGuard(customerTexts: readonly string[], shopText: string | null, products: readonly FocusProduct[]): QuickReplyFocusGuard {
  const focus = productFocusOf(customerTexts, shopText, products);
  const memo = new Map<string, string[]>();
  const coversOf = (e: EntryKey) => {
    let c = memo.get(e.id);
    if (!c) memo.set(e.id, (c = quickReplyCovers(e, products)));
    return c;
  };
  return { focus, coversOf, fits: (e) => fitsFocus(coversOf(e), focus), answers: (e) => answersFocus(coversOf(e), focus) };
}

/**
 * KIỂM TĨNH cách hỏi (màn hình câu mẫu · ops `org-catalog`): cách hỏi gọi tên món mà câu mẫu KHÔNG nói tới — đúng lỗi của câu nem
 * mang «xin giá chả cá». Câu mẫu không gắn món nào thì không có xung đột (câu menu chung được phép mang «có chả mực không»).
 */
export function triggerProductConflicts(entry: Pick<QuickReplyEntry, "title" | "answer" | "triggers">, products: readonly FocusProduct[]): { trigger: string; names: string[] }[] {
  const covers = quickReplyCovers(entry, products);
  if (!covers.length) return [];
  const names = products.map((p) => p.name);
  return entry.triggers.map((trigger) => ({ trigger, names: productsNamedIn(trigger, names).filter((n) => !covers.includes(n)) })).filter((x) => x.names.length > 0);
}

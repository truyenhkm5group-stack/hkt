/**
 * ═══════════ ĐỒNG Ý NGẮN VỚI LỜI MỜI MỘT MÓN (P0 21/10/2026, chủ shop — ca HSLC «Vit Xiem») — HÀM THUẦN ═══════════
 *
 * Ca thật (hội thoại a470ae92…, 12:23–12:24Z): khách «Lấy 1/2 ram tôm bề bề» ⇒ bot đề xuất «nem hải sản tôm bề bề nhà em đóng hộp 10 cái
 * giá 120.000 ₫, mình lấy 1 hộp luôn nha?» ⇒ khách thả 👍 rồi gõ «Ok» ⇒ `update_draft_order` bị chặn «khách chưa gọi tên món» (hàng rào chỉ
 * đọc CHÍNH tin «Ok») ⇒ bot bắt khách «nhắn giúp em "lấy 1 hộp nem hải sản tôm bề bề"». Chủ shop ĐỔI LUẬT (thay luật «ok không thêm» của
 * #927 / #930 cho trường hợp MỘT món): lời mời có ĐÚNG MỘT mẫu mã + giá xác định, khách trả lời TRỰC TIẾP bằng «Ok», «vâng», «được», «lấy
 * luôn», «thêm nhé», 👍 ⇒ ĐỒNG Ý ⇒ thêm luôn, không hỏi lại tên món. Câu mời nhiều món (không món đích) ⇒ vẫn hỏi «món nào» (#930).
 *
 * Lời mời được ghi vào `state.directOffer` ở CUỐI lượt bot gửi nó (engine), từ một trong hai nguồn:
 *   · `POST_CONFIRM` — lời mời sau chốt có món đích (`postConfirmOffer` OFFERED + đã gửi + productId / variantId / giá);
 *   · `BOT_PROPOSAL` — câu bot gửi CUỐI lượt gọi tên ĐÚNG MỘT sản phẩm của danh mục và mang ĐÚNG giá của ĐÚNG MỘT mẫu mã của nó, sản phẩm
 *     chưa có trong giỏ / đơn (đọc lại tổng đơn KHÔNG phải lời mời).
 * Lượt đó còn câu hỏi KHÁC lời mời («mình cho em xin SĐT ạ?») ⇒ `ambiguous` ⇒ «Ok» không biết trả lời câu nào ⇒ không tính.
 */
import type { CatalogItem } from "@/lib/sales-chatbot/catalog";
import { isShortYes, NEGATIVE_EMOJI_RE } from "@/lib/sales-chatbot/next-best-action";
import { calledByName, mentionsProduct } from "@/lib/sales-chatbot/cart-commitment";
import { extractVndAmounts } from "@/lib/sales-chatbot/claim-guard";
import { foldVi } from "@/lib/sales-chatbot/text";

export type DirectOffer = {
  productId: string;
  variantId: string;
  name: string;
  price: number;
  /** Lượt (seq tin khách) bot GỬI lời mời — khách trả lời trực tiếp ⇔ `prevTurn` của lượt sau bằng số này. */
  turn: number;
  at: string;
  source: "POST_CONFIRM" | "BOT_PROPOSAL";
  /** Lượt gửi lời mời còn câu hỏi khác ⇒ «Ok» mơ hồ ⇒ không tính đồng ý. */
  ambiguous?: boolean;
};

/** Chữ đại diện của nhãn like khi đưa vào hàng chờ của bot (fanpage.ts). */
export const LIKE_TEXT = "👍";

const EMOJI_RE = /[\p{Extended_Pictographic}\u{FE0F}\u{1F3FB}-\u{1F3FF}]/gu;

/**
 * Câu ĐỒNG Ý NGẮN: chỉ biểu tượng 👍 / 👌, hoặc câu «có» đóng của `isShortYes` (ok · vâng · được · lấy luôn · thêm nhé…) — kèm hay không
 * kèm biểu tượng. Có phủ định / câu hỏi / chữ thừa («ok nhưng…», «ok để chị hỏi chồng») ⇒ không. Có biểu tượng buồn / giận / chê
 * (`NEGATIVE_EMOJI_RE` của next-best-action — một luật cho mọi đường đồng ý) ⇒ không, kể cả «👍😢» chỉ toàn biểu tượng. HÀM THUẦN.
 */
export function isShortAccept(text: string): boolean {
  const t = text.normalize("NFC").trim();
  if (!t) return false;
  if (NEGATIVE_EMOJI_RE.test(t)) return false;
  const rest = t.replace(EMOJI_RE, " ").trim();
  // Chỉ biểu tượng: chỉ 👍 / 👌 là đồng ý (😢 / 😂 không đọc được ý).
  if (!rest) return /[👍👌]/u.test(t);
  return isShortYes(rest);
}

/**
 * Lời mời MỘT món trong câu bot (nguồn `BOT_PROPOSAL`). `catalog` = mẫu mã của tổ chức; `held` = sản phẩm đã có trong giỏ / đơn. Câu phải là
 * lời MỜI (có «?» hoặc «lấy» / «thêm» / «nha» cuối câu) — câu kể giá không phải mời. HÀM THUẦN.
 */
export function proposalOf(text: string, catalog: readonly CatalogItem[], held: ReadonlySet<string>): Omit<DirectOffer, "turn" | "at" | "ambiguous"> | null {
  const f = ` ${foldVi(text).replace(/[^a-z0-9]+/g, " ")} `;
  if (!/[?？]/.test(text) && !/ (?:lay|them|nha|nhe) /.test(f)) return null;
  const amounts = new Set(extractVndAmounts(text));
  if (!amounts.size) return null;
  const byProduct = new Map<string, CatalogItem[]>();
  for (const c of catalog) {
    const list = byProduct.get(c.productId) ?? [];
    list.push(c);
    byProduct.set(c.productId, list);
  }
  const named = [...byProduct.entries()].filter(([, vs]) => mentionsProduct(vs[0].name, text) || calledByName(vs[0].name, text));
  if (named.length !== 1) return null;
  const [productId, variants] = named[0];
  if (held.has(productId)) return null;
  const priced = variants.filter((v) => !v.addOnOnly && v.price !== null && amounts.has(v.price));
  if (priced.length !== 1) return null;
  const v = priced[0];
  return { productId, variantId: v.variantId, name: v.name, price: v.price!, source: "BOT_PROPOSAL" };
}

/** Dặn model khi khách vừa đồng ý (đường model — chưa có đơn để máy chủ tự thêm). Giá máy chủ, không bắt khách gõ lại tên món. HÀM THUẦN. */
export function acceptedOfferPrompt(o: Pick<DirectOffer, "name" | "variantId" | "price">): string {
  return `KHÁCH VỪA ĐỒNG Ý lời mời (máy chủ xác nhận — trả lời trực tiếp lời mời một món): thêm 1 × ${o.name} (variant_id ${o.variantId}). KHÔNG hỏi lại tên món, KHÔNG bắt khách nhắn lại cú pháp. Lên / sửa đơn với đúng variant_id này (giá máy chủ tính lại); chỉ nói đã thêm SAU khi công cụ ghi thành công.`;
}

/**
 * Khách ĐỒNG Ý lời mời — đúng tin KẾ TIẾP sau lời mời (`prevTurn === offer.turn`), câu đồng ý ngắn, không người / page xen giữa, lượt mời
 * không mơ hồ, khách chưa từ chối. HÀM THUẦN.
 */
export function acceptsOffer(i: { offer: DirectOffer | undefined | null; prevTurn: number | undefined; text: string; humanBetween: boolean; declined: boolean }): DirectOffer | null {
  const o = i.offer;
  if (!o || o.ambiguous || i.declined || i.humanBetween) return null;
  if (i.prevTurn === undefined || i.prevTurn !== o.turn) return null;
  return isShortAccept(i.text) ? o : null;
}

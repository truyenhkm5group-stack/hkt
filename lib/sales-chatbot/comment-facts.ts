/**
 * ═══ BÌNH LUẬN CỦA CHÍNH KHÁCH ⇒ HỘP THƯ BIẾT (P2-3 / P2-4 — P0 HSLC 24/10/2026, ca «Trần Thị Ngọc») ═══
 *
 * Khách bình luận SĐT + địa chỉ, bot chốt đơn ở hội thoại BÌNH LUẬN; 3 phút sau khách nhắn Messenger ⇒ hội thoại HỘP THƯ không biết gì ⇒ câu
 * mẫu «xin SĐT + địa chỉ», khách «Địa chỉ gửi rồi mà». Nay: lượt đầu (và cứ mỗi `LINKED_COMMENT_RECHECK_MS` khi CHƯA tìm thấy) của hội thoại
 * fanpage tra hội thoại bình luận CÙNG KHÁCH bằng identity-link (CHỈ mức VERIFIED — định danh nền tảng, không tên, không SĐT) trong 7 ngày:
 *  · hồ sơ nhận hàng khách đã cho ở bình luận (`state.customer` do create_customer ghi) được CHÉP sang khi hộp thư chưa có hồ sơ — mang nguồn
 *    COMMENT + id hội thoại + mốc ⇒ mức sẵn sàng · hàng rào hỏi lại (câu mẫu lẫn chữ model) · lời nhắc đều thấy «đã có SĐT / địa chỉ»;
 *  · đơn đang mở của hội thoại bình luận CHỈ được NÊU trong lời nhắc (không ghi, không nhân bản) — gộp / sửa đơn là việc của pha 3 (code-erp-95).
 * Không ghi gì vào hội thoại bình luận.
 */
import { inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { manualOrderShortCode } from "@/lib/constants/manual-orders";
import { asksAnyAddressPart, asksForPhone, continuesSameOrder } from "@/lib/sales-chatbot/address-memory";
import { sameCustomerConversations } from "@/lib/sales-chatbot/identity-link";
import { sentencesOf } from "@/lib/sales-chatbot/text";
import type { ChatState } from "@/lib/sales-chatbot/tools";

export const LINKED_COMMENT_RECHECK_MS = 10 * 60_000;
export const LINKED_COMMENT_DAYS = 7;

export type LinkedComment = {
  checkedAt: string;
  found: boolean;
  conversationId?: string;
  evidence?: string[];
  /** Đơn đang mở / đã chốt của hội thoại bình luận (chỉ để NÊU). */
  orderId?: string | null;
  /** Đã chép hồ sơ nhận hàng từ bình luận sang hộp thư ở lượt này. */
  customerCopied?: boolean;
};

/** Có phải tra lại không: chưa tra · hoặc lần trước KHÔNG thấy và đã quá chu kỳ. Đã thấy ⇒ không tra nữa. HÀM THUẦN. */
export function needsLinkedCheck(st: Pick<ChatState, "linkedComment">, now: Date): boolean {
  const l = st.linkedComment;
  if (!l) return true;
  if (l.found) return false;
  const at = Date.parse(l.checkedAt);
  return !Number.isFinite(at) || now.getTime() - at >= LINKED_COMMENT_RECHECK_MS;
}

/** Hồ sơ nhận hàng dùng được của hội thoại bình luận (không phải thử, có SĐT hoặc địa chỉ). HÀM THUẦN. */
export function usableCommentCustomer(c: ChatState["customer"] | undefined, sourceConversationId: string, now: Date): NonNullable<ChatState["customer"]> | null {
  if (!c || c.simulated) return null;
  if (!c.phone?.trim() && !c.address?.trim()) return null;
  return { ...c, at: c.at ?? now.toISOString(), source: "COMMENT", sourceConversationId };
}

/** Tra hội thoại bình luận cùng khách (VERIFIED). Lỗi đọc ⇒ ném (nơi gọi bỏ qua, không chặn lượt). */
export async function loadLinkedComment(conversationId: string, now: Date): Promise<{ link: LinkedComment; customer: NonNullable<ChatState["customer"]> | null }> {
  const at = now.toISOString();
  const same = (await sameCustomerConversations(conversationId, { sinceDays: LINKED_COMMENT_DAYS, now })).filter((x) => x.verdict.level === "VERIFIED");
  if (!same.length) return { link: { checkedAt: at, found: false }, customer: null };
  const c = schema.salesChatConversations;
  const rows = await (await getDb()).select({ id: c.id, state: c.state }).from(c).where(inArray(c.id, same.map((x) => x.conversationId)));
  const comment = rows.find((r) => {
    const st = (r.state ?? {}) as ChatState;
    return Boolean(st.commentOrigin || st.postContext);
  });
  if (!comment) return { link: { checkedAt: at, found: false }, customer: null };
  const st = (comment.state ?? {}) as ChatState;
  const verdict = same.find((x) => x.conversationId === comment.id)!.verdict;
  const customer = usableCommentCustomer(st.customer, comment.id, now);
  return {
    link: { checkedAt: at, found: true, conversationId: comment.id, evidence: verdict.evidence.map((e) => e.kind), orderId: st.confirmed?.orderId ?? st.draft?.orderId ?? null, customerCopied: Boolean(customer) },
    customer,
  };
}

/**
 * Hồ sơ nhận hàng CHÉP TỪ BÌNH LUẬN còn đứng không: hồ sơ mang nguồn COMMENT và tin khách mới nhất nói tiếp về đơn (không đổi người nhận
 * / nơi giao / SĐT, không gửi thông tin mới — `continuesSameOrder`). Hàng rào hỏi lại chung chỉ coi địa chỉ là «đã biết» khi khách gõ nó
 * TRONG luồng này hoặc khi bị hỏi lần hai, nên lần hỏi ĐẦU của hộp thư lọt qua — đúng câu «xin SĐT + địa chỉ» của ca Ngọc. HÀM THUẦN.
 */
export function commentContactHeld(st: Pick<ChatState, "customer">, lastCustomerText: string): { address: boolean; phone: boolean } {
  const c = st.customer;
  if (c?.source !== "COMMENT" || c.simulated || !continuesSameOrder(lastCustomerText)) return { address: false, phone: false };
  return { address: Boolean(c.address?.trim()), phone: Boolean(c.phone?.trim()) };
}

export const COMMENT_CONTACT_KNOWN_TEXT = "Dạ em đã có SĐT và địa chỉ mình gửi ở bình luận rồi ạ.";

/** Bỏ câu xin lại địa chỉ / SĐT đã có từ bình luận; giữ câu khác. Bỏ hết ⇒ câu ghi nhận. HÀM THUẦN. */
export function dropCommentContactAsks(text: string, held: { address: boolean; phone: boolean }): { text: string; dropped: number } {
  if ((!held.address && !held.phone) || !text.trim()) return { text, dropped: 0 };
  const asks = (s: string) => (held.address && asksAnyAddressPart(s)) || (held.phone && asksForPhone(s));
  let dropped = 0;
  const lines = text.split(/\n/);
  const kept = lines
    .map((line) => {
      const ss = sentencesOf(line);
      const keep = ss.filter((s) => !asks(s));
      dropped += ss.length - keep.length;
      return keep.length === ss.length ? line : keep.join(" ");
    })
    .filter((line, i) => line.trim() || !lines[i].trim());
  if (!dropped) return { text, dropped: 0 };
  return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim() || COMMENT_CONTACT_KNOWN_TEXT, dropped };
}

/** Lời nhắc: khách này vừa bình luận — thông tin đã có, đơn đã có. Rỗng khi không liên kết. HÀM THUẦN. */
export function linkedCommentPrompt(link: LinkedComment | undefined): string {
  if (!link?.found) return "";
  const lines = ["KHÁCH NÀY VỪA BÌNH LUẬN TRÊN BÀI VIẾT CỦA PAGE (cùng một người — đã xác minh bằng định danh Facebook, không đoán):"];
  if (link.customerCopied) lines.push("· SĐT / địa chỉ nhận hàng khách gửi trong bình luận ĐÃ CÓ trong hồ sơ khách — KHÔNG xin lại, không hỏi lại phường / xã của địa chỉ ấy.");
  if (link.orderId) lines.push(`· Khách ĐÃ CÓ đơn #${manualOrderShortCode(link.orderId)} lên từ lượt bình luận — KHÔNG nói «chưa có đơn»; khách muốn thêm món thì hỏi gộp vào đơn đó, không tự lên đơn mới khác ý khách.`);
  return lines.join("\n");
}

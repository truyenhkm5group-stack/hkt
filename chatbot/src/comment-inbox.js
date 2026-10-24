/**
 * Hop thu ma tin rieng cua MOT binh luan da mo (`private_reply_conversation` cua Pancake) — module THUAN: khong import config / logger
 * (nhu order-view.js), bai kiem nap duoc ma khong chot DATA_DIR cua bot.
 *
 * P0 24/10/2026 (ca HSLC «Tran Thi Ngoc», do bang ops comment-inbox-link-probe): `private_reply_conversation.id` la ma TIN rieng cua Meta
 * («m_...»), luong hop thu Pancake nam o `conversation_id` dang `<page_id>_<PSID>`. Ban cu lay `id` TRUOC `conversation_id` nen gui anh
 * vao «/conversations/m_...» — Pancake tra loi, anh cua cau tra loi binh luan khong bao gio toi khach (chatbot-status: «Gui anh san pham
 * loi: ... /conversations/m_...»). Luat (giong lib/sales-chatbot/fanpage.ts::privateReplyInboxId): chi nhan ung vien khop
 * `^<page_id>_\d+$`; khong co ma Pancake cho biet da nhan rieng ⇒ dung `<page_id>_<from_id>` (PSID = from.id nguoi binh luan, cung page);
 * from_id khong phai chuoi so ⇒ KHONG doan (null). Khong bao gio tra «m_...».
 */
export function privateReplyInboxId(prc, pageId, fromId) {
  const str = (x) => (typeof x === "string" ? x.trim() : typeof x === "number" ? String(x) : "");
  const page = str(pageId);
  const replied = typeof prc === "string" ? prc.trim().length > 0 : Boolean(prc && typeof prc === "object");
  if (!replied) return { replied: false, inboxId: null, source: "NONE" };
  const candidates = typeof prc === "string" ? [prc.trim()] : [str(prc.conversation_id), str(prc.id)];
  const pageEsc = page.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const shape = new RegExp(`^${pageEsc}_\\d+$`);
  const ok = page ? candidates.find((x) => shape.test(x)) : undefined;
  if (ok) return { replied: true, inboxId: ok, source: "PANCAKE_CONV_ID" };
  const from = str(fromId);
  if (/^\d+$/.test(page) && /^\d+$/.test(from)) return { replied: true, inboxId: `${page}_${from}`, source: "DERIVED_PAGE_PSID" };
  return { replied: true, inboxId: null, source: "NONE" };
}

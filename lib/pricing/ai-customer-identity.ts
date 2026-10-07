/**
 * ═══════════ DANH TÍNH CHUẨN CỦA MỘT KHÁCH AI — HÀM THUẦN (chỉ băm) · CHỈ MÁY CHỦ (docs/saas/PRICING_V1.md §II.2) ═══════════
 *
 * Khoá đồng hồ cũ (0228) là `ai_customer:<kỳ>:<kênh>:<page>:<visitor_key>`, mà `visitor_key` của kênh FANPAGE là băm của (page,
 * MÃ HỘI THOẠI): Pancake khoá theo mã hội thoại của Pancake, Messenger trực tiếp theo PSID. Cùng một người đổi đường nhận tin
 * giữa tháng (gỡ Pancake, nối Messenger — `channel-ownership.ts` chỉ cho MỘT đường mỗi page, nhưng đường ấy đổi được) ⇒ hai
 * hội thoại ⇒ hai khoá ⇒ đếm HAI khách AI. Khoá mới KHÔNG chứa mã hội thoại:
 *
 *   aic:<kỳ YYYY-MM>:<page>:<băm(loại:page:mã khách chuẩn)>
 *
 *  · FANPAGE: mã khách chuẩn = PSID khi đọc được TẤT ĐỊNH từ mã hội thoại — Messenger trực tiếp dùng chính PSID làm mã hội thoại;
 *    hội thoại INBOX của Pancake mang dạng `<page>_<PSID>` (khớp ĐÚNG tiền tố page + phần đuôi toàn chữ số). CHỈ hội thoại tin nhắn
 *    (INBOX) mới được suy PSID: hội thoại BÌNH LUẬN có thể mang mã `<page>_<bài>` trông y hệt `<page>_<PSID>` mà là của CẢ BÀI —
 *    suy PSID ở đó là gộp mọi người bình luận thành một khách. Bình luận ⇒ khoá theo NGƯỜI bình luận (`from_id`, loại COMMENTER);
 *    không có ⇒ theo hội thoại. Mọi dạng khác (mã lạ) ⇒ KHÔNG đoán: khoá theo `visitor_key` của hội thoại (loại THREAD) — có thể
 *    đếm dư khi đổi đường, không bao giờ gộp hai người thành một.
 *  · ZALO: mã người dùng Zalo của OA (cột `thread_id`); WEB: `visitor_key` (băm mã khách truy cập của trình duyệt).
 *
 * KỲ CHUYỂN TIẾP: dòng khoá cũ GIỮ NGUYÊN (không backfill). Trước khi ghi khoá mới, đường ghi tra `aliases` — mọi khoá (cũ lẫn
 * mới-theo-hội-thoại) mà CÙNG khách này có thể đã mang trong kỳ. Thấy một cái ⇒ ghi khoá mới với SỐ LƯỢNG 0 (đánh dấu «đã đếm
 * qua khoá cũ»), để các đường sau gặp khoá mới và dừng. Tổng `sum(quantity)` của kỳ vì thế đếm mỗi khách chuẩn đúng một lần.
 */
import { createHash } from "node:crypto";
import { aiCustomerEventKey } from "@/lib/pricing/versions";

/**
 * `threadKind` = loại hội thoại của lượt vừa trả lời (`sales_chat_inbound.kind`): thiếu ⇒ hội thoại tin nhắn như trước. `commenterId`
 * = mã người bình luận (`from_id`) của bình luận được trả lời — chỉ có nghĩa khi `threadKind = "COMMENT"`.
 */
export type AiCustomerConv = { channel: string; pageId: string | null; threadId: string | null; visitorKey: string | null; threadKind?: "INBOX" | "COMMENT" | null; commenterId?: string | null };
export type AiCustomerIdentityKind = "PSID" | "COMMENTER" | "ZALO" | "WEB" | "THREAD";
export type AiCustomerIdentity = { page: string; kind: AiCustomerIdentityKind; id: string };

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const keyPart = (s: string) => s.trim().replace(/[^\w.\-]/g, "_");
const PSID_RE = /^\d{5,}$/;

/**
 * BẢN SAO TƯỜNG MINH của `lib/sales-chatbot/fanpage.ts::fanpageVisitorKey` (import tệp kênh vào sổ giá là vòng import) —
 * `tests/saas-l5-billing-trial.test.ts` so hai hàm trên cùng đầu vào, nên chúng không trôi xa nhau được.
 */
export function fanpageVisitorKeyMirror(pageId: string, threadId: string): string {
  return sha(`fanpage:${pageId}:${threadId}`);
}

/** Danh tính chuẩn của khách trong hội thoại. Khung THỬ / thiếu thành phần ⇒ `null` (không ghi). */
export function canonicalAiCustomer(conv: AiCustomerConv): AiCustomerIdentity | null {
  const page = (conv.pageId ?? "").trim();
  const thread = (conv.threadId ?? "").trim();
  const vk = (conv.visitorKey ?? "").trim();
  if (conv.channel === "FANPAGE") {
    if (conv.threadKind === "COMMENT") {
      const who = (conv.commenterId ?? "").trim();
      if (page && who) return { page, kind: "COMMENTER", id: who };
      return vk ? { page: page || "-", kind: "THREAD", id: vk } : null;
    }
    if (page && PSID_RE.test(thread)) return { page, kind: "PSID", id: thread };
    if (page && thread.startsWith(`${page}_`) && PSID_RE.test(thread.slice(page.length + 1))) return { page, kind: "PSID", id: thread.slice(page.length + 1) };
    return vk ? { page: page || "-", kind: "THREAD", id: vk } : null;
  }
  if (conv.channel === "ZALO") {
    if (page && thread) return { page, kind: "ZALO", id: thread };
    return vk ? { page: page || "-", kind: "THREAD", id: vk } : null;
  }
  if (conv.channel === "WEB") return vk ? { page: "web", kind: "WEB", id: vk } : null;
  return null;
}

/** Khoá mới của MỘT khách chuẩn trong MỘT kỳ. Kỳ sai dạng / khoá quá 200 ký tự ⇒ `null`. */
export function aiCustomerKeyOf(month: string, id: AiCustomerIdentity): string | null {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  const key = `aic:${month}:${keyPart(id.page)}:${sha(`${id.kind}:${id.page}:${id.id}`).slice(0, 40)}`;
  return key.length <= 200 ? key : null;
}

/**
 * Khoá mới + mọi khoá CÙNG khách có thể đã mang trong kỳ (khoá cũ 0228 của chính hội thoại; với PSID: khoá cũ và khoá THREAD của
 * cả hai đường — Messenger `<PSID>` lẫn Pancake `<page>_<PSID>`). Không có danh tính ⇒ `null`.
 */
export function aiCustomerKeys(month: string, conv: AiCustomerConv): { key: string; aliases: string[]; identity: AiCustomerIdentity } | null {
  const identity = canonicalAiCustomer(conv);
  if (!identity) return null;
  const key = aiCustomerKeyOf(month, identity);
  if (!key) return null;
  const aliases = new Set<string>();
  const legacy = aiCustomerEventKey({ month, channel: conv.channel, pageId: conv.pageId, customerKey: conv.visitorKey });
  if (legacy) aliases.add(legacy);
  if (identity.kind === "PSID") {
    for (const thread of [identity.id, `${identity.page}_${identity.id}`]) {
      const vk = fanpageVisitorKeyMirror(identity.page, thread);
      const old = aiCustomerEventKey({ month, channel: "FANPAGE", pageId: identity.page, customerKey: vk });
      if (old) aliases.add(old);
      const viaThread = aiCustomerKeyOf(month, { page: identity.page, kind: "THREAD", id: vk });
      if (viaThread) aliases.add(viaThread);
    }
  }
  aliases.delete(key);
  return { key, aliases: [...aliases], identity };
}

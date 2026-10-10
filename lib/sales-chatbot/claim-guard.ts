/**
 * ═══════════ HÀNG RÀO KHẲNG ĐỊNH CHƯA XÁC MINH — CHỈ MÁY CHỦ (P0 10/10/2026) ═══════════
 *
 * Sự cố: AI bán hàng nói với khách «Dạ em đã nhận được tiền» chỉ vì khách gửi ẢNH chuyển khoản, và «Dạ em chốt đơn … tổng
 * 280k» khi KHÔNG có đơn ERP nào nối với hội thoại (kiểm toán lifecycle 10/10/2026, nguyên nhân gốc (a)(b)). Trước tệp này
 * không có kiểm nào của MÁY CHỦ trên chữ gửi khách: luật duy nhất là một câu trong lời nhắc («ảnh chuyển khoản ⇒ handoff»),
 * và câu mẫu (khớp chữ / AI chọn mã) chạy TRƯỚC lượt AI mà không biết gì về đơn hay tiền.
 *
 * Tệp này giữ ba thứ:
 *  1. `paymentSignalInCustomerText` — tin KHÁCH có dấu hiệu đã trả tiền (dòng ảnh chuyển khoản do máy đọc ảnh ghi, hoặc
 *     «ck rồi» / «đã chuyển khoản»). Đó là LỜI KHÁCH, không bao giờ là bằng chứng tiền đã về (AGENTS 0.1 — tiền đi theo
 *     chứng từ). Máy chủ chuyển người ngay, không đợi model tự gọi `handoff_to_human`; câu mẫu không chạy.
 *  2. `detectClaims` / `guardClaims` — câu của BOT khẳng định «đã nhận tiền / thanh toán xong» hoặc «đã chốt đơn / đơn đã xác
 *     nhận». Chỉ bắt câu KHẲNG ĐỊNH: câu hỏi, câu đề nghị («em chốt đơn cho mình nhé?»), câu phủ định / điều kiện («khi nhận
 *     được tiền em báo») đi qua — chặn quá tay thì bot im giữa lúc bán.
 *  3. `claimFactsLoader` — đọc ERP để quyết câu khẳng định có căn cứ không:
 *       · TIỀN đã xác minh ⇔ đơn tạo tay nối với hội thoại có chứng từ thu `order_payments` CONFIRMED đủ số
 *         (`manualPaymentStatus` = PAID — nhân viên ghi qua `recordManualPaymentCore`, khoá `users.id`). Trả trước khai trên POS
 *         Pancake là LỜI KHAI của nhân viên, không phải xác minh; trạng thái đơn `PAID` của Pancake KHÔNG bao giờ là tiền thật.
 *         Hôm nay tổ chức khách không có luồng ngân hàng nào ⇒ thực tế gần như luôn chặn — đúng hướng (PR-L7 mới mở rộng nguồn).
 *       · ĐƠN có thật ⇔ bot đã chốt (`state.confirmed`, kể cả mô phỏng ở khung THỬ) hoặc một đơn ERP còn sống nối với hội thoại
 *         (`orders.id = conv.order_id`, `orders.sales_conversation_id`, hoặc cùng luồng Pancake `page_id + conversation_id`).
 *         ĐƠN NHÁP của chính bot (chưa `confirm_order`) KHÔNG tính: công cụ tự gắn nhãn nó «Nháp — chưa chốt», nên cho câu
 *         «đã chốt» đi qua trên một bản nháp là thả đúng lời nói sai cần chặn.
 *     Lỗi đọc ⇒ coi như CHƯA xác minh: mọi nhánh lỗi rơi về phía HẸP (chặn + chuyển người), không bao giờ về phía khẳng định.
 *
 * Bị chặn ⇒ câu đó KHÔNG được ghi / gửi; thay bằng câu an toàn đã khai ở đây (kênh không nhắn tin) và chuyển người. Kênh nhắn
 * tin (fanpage / Zalo) chuyển người thì bot IM theo luật kênh sẵn có — câu an toàn cũng không gửi, nhân viên trả lời.
 */
import { and, eq, inArray, notInArray, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { manualOrderAmountDue, manualPaymentStatus, sumConfirmedPayments } from "@/lib/constants/order-payments";
import { foldVi } from "@/lib/sales-chatbot/text";
import type { ChatState } from "@/lib/sales-chatbot/tools";

// ═══ CÂU AN TOÀN + LÝ DO CHUYỂN NGƯỜI — một chỗ khai, không gõ lại ở nơi gọi ═══

/** Nhãn máy ghi vào mô tả ảnh chuyển khoản — người và AI đọc lịch sử đều thấy đây là ảnh khách gửi, chưa ai đối soát. */
export const UNVERIFIED_PAYMENT_IMAGE_LABEL = "ẢNH CHUYỂN KHOẢN — CHƯA XÁC MINH (ảnh khách gửi, shop chưa đối soát)";

export const CLAIM_SAFE_TEXT = {
  /** Khách gửi ảnh chuyển khoản / biên lai. */
  PAYMENT_IMAGE: "Dạ em đã nhận ảnh anh/chị gửi, em chuyển nhân viên kiểm tra giúp mình ngay ạ.",
  /** Khách gõ «ck rồi», hoặc bot định nói đã nhận tiền. */
  PAYMENT: "Dạ em ghi nhận thông tin anh/chị gửi, em chuyển nhân viên kiểm tra giúp mình ngay ạ.",
  /** Bot định nói đã chốt đơn mà chưa có đơn. */
  ORDER: "Dạ em đang hoàn tất đơn, anh/chị chờ em xác nhận lại nhé.",
} as const;

/** Lý do chuyển người — tiền tố `classifyHandoffReason` đọc (events-shared.ts) để đếm theo nhóm. */
export const CLAIM_HANDOFF_REASON = {
  PAYMENT_IMAGE: "Khách báo đã chuyển khoản — gửi ảnh chuyển khoản, cần nhân viên đối soát (bot không xác nhận tiền)",
  PAYMENT_TEXT: "Khách báo đã chuyển khoản — cần nhân viên đối soát (bot không xác nhận tiền)",
  PAYMENT_RECEIVED: "AI định khẳng định đã nhận tiền khi chưa có chứng từ thu — đã chặn câu, nhân viên đối soát",
  ORDER_CONFIRMED: "AI định khẳng định đã chốt đơn khi chưa có đơn ERP — đã chặn câu, nhân viên kiểm đơn",
} as const;

// ═══ PHẦN THUẦN ═══

export type PaymentSignal = "IMAGE" | "TEXT";
export type ClaimKind = "PAYMENT_RECEIVED" | "ORDER_CONFIRMED";
export type ClaimFacts = { paymentVerified: boolean; orderConfirmed: boolean };
export type ClaimVerdict = { ok: true } | { ok: false; claim: ClaimKind; safeText: string; handoffReason: string; note: string };

/** Ảnh có dấu hiệu chứng từ thanh toán — đọc trên MÔ TẢ của máy đọc ảnh (đã bỏ dấu). */
const PAYMENT_IMAGE_RE =
  /\b(?:chuyen khoan|chuyen tien|giao dich|bien lai|bien nhan|hoa don chuyen|uy nhiem chi|so tien|so tai khoan|stk|noi dung ck|internet banking|mobile banking|vietqr|ma qr ngan hang|momo|zalopay|vnpay|ngan hang|vietcombank|techcombank|vietinbank|agribank|bidv|vpbank|tpbank|mb bank|mbbank|acb|sacombank|ck thanh cong)\b/;

/** Dòng ảnh do `imageLine` ghi: «[Khách gửi ảnh: …]» / «[Khách gửi 2 ảnh: …]». */
const IMAGE_SEGMENT_RE = /\[Khách gửi (?:\d+ )?ảnh: ([^\]]*)\]/g;

/** Mô tả ảnh có phải ảnh chứng từ thanh toán không. HÀM THUẦN. */
export function looksLikePaymentImage(description: string): boolean {
  if (description.includes(UNVERIFIED_PAYMENT_IMAGE_LABEL)) return true;
  return PAYMENT_IMAGE_RE.test(` ${foldVi(description)} `);
}

/** Từ đứng ngay trước một cụm làm nó KHÔNG còn là lời khẳng định: phủ định, tương lai, điều kiện, mong muốn. */
const BLOCKERS = new Set(["chua", "khong", "ko", "k", "chang", "se", "khi", "neu", "de", "doi", "muon", "can", "lieu", "hay", "hoac", "truoc", "sau", "phai"]);

/** Đuôi câu hỏi (đã bỏ dấu): «… chưa ạ», «… không ạ», «… hả shop». */
const QUESTION_TAIL_RE = /\b(?:chua|khong|ko|hong|hem|nhi|ha|sao|the nao|bao gio)(?:\s+(?:a|ah|ak|vay|v|nha|nhe|shop|em|chi|anh|ban|c|e))*\s*$/;
/** Đuôi câu đề nghị: «… nhé», «… nha», «… được không». */
const PROPOSAL_TAIL_RE = /\b(?:nhe|nha|nhen|nghen|nhak|nhs|duoc khong|dc ko|dc khong|ok khong|okie|nhe a|nha a)(?:\s+(?:a|ah|chi|anh|ban|minh|c|e))*\s*$/;
/** Dấu đã xong: «đã», «rồi», «xong», «vừa», «thành công». */
const DONE_RE = /\b(?:da|roi|r|xong|vua|thanh cong)\b/;

/**
 * Bỏ dấu cho phép đọc luật. «Dạ» (lời thưa) và «đã» cùng thành «da» khi bỏ dấu — «Dạ thanh toán khi nhận hàng ạ» sẽ đọc như
 * «đã thanh toán». Nên «dạ» đổi thành «vâng» TRƯỚC khi bỏ dấu; «da» còn lại là «đã» (hoặc khách gõ không dấu).
 */
function foldClaim(s: string): string {
  return foldVi(s.normalize("NFC").replace(/(^|[^\p{L}])[dD][ạẠ](?=$|[^\p{L}])/gu, "$1vâng"));
}

/** Mệnh đề của một câu trả lời: cắt theo dấu câu, xuống dòng, dấu phẩy. Giữ cờ «có dấu hỏi» trước khi bỏ dấu. */
function clausesOf(text: string): { folded: string; question: boolean }[] {
  const out: { folded: string; question: boolean }[] = [];
  for (const m of text.matchAll(/[^.!?…;:\n,]+[.!?…;:\n,]*/g)) {
    const t = m[0].trim();
    if (!t) continue;
    const folded = foldClaim(t);
    if (folded) out.push({ folded, question: /\?/.test(t) });
  }
  return out;
}

/** Ba từ ngay trước vị trí `index` trong mệnh đề đã bỏ dấu có từ chặn không. */
function blockedBefore(folded: string, index: number): boolean {
  const words = folded.slice(0, index).trim().split(/\s+/).filter(Boolean).slice(-3);
  return words.some((w) => BLOCKERS.has(w));
}

type ClaimRule = { kind: ClaimKind; re: RegExp; needsDone: boolean | ((m: RegExpExecArray, clause: string) => boolean); allowProposal: boolean };

/**
 * Luật nhận câu khẳng định — đọc trên mệnh đề ĐÃ BỎ DẤU. `needsDone` = cụm chỉ là lời khẳng định khi mệnh đề có dấu đã xong
 * («shop nhận chuyển khoản» là chính sách, «shop ĐÃ nhận chuyển khoản» mới là khẳng định). `allowProposal` = đuôi «nhé» không
 * cứu được cụm (vd «em đã chốt đơn rồi nhé» vẫn là khẳng định — xử lý bằng `needsDone`).
 */
const CLAIM_RULES: readonly ClaimRule[] = [
  // «nhận được tiền / nhận đủ tiền / nhận chuyển khoản / thấy tiền / ghi nhận thanh toán»
  {
    kind: "PAYMENT_RECEIVED",
    re: /\b(?:nhan|thay|check)\s+(duoc\s+|dc\s+|du\s+|duoc du\s+)?(?:tien|ck|chuyen khoan|khoan chuyen|thanh toan|khoan thanh toan|tien chuyen khoan|tien ck|tien coc|coc|tien hang)\b/,
    needsDone: (m) => !m[1],
    allowProposal: false,
  },
  // «tiền về rồi / tiền đã vào tài khoản»
  { kind: "PAYMENT_RECEIVED", re: /\btien\s+(?:da\s+)?(?:ve|vao)(?:\s+(?:roi|r|tai khoan|tk|du|a)\b|\s*$)/, needsDone: false, allowProposal: false },
  // «chuyển khoản thành công / giao dịch thành công / thanh toán thành công»
  { kind: "PAYMENT_RECEIVED", re: /\b(?:chuyen khoan|ck|giao dich|thanh toan|chuyen tien)\s+(?:da\s+)?thanh cong\b/, needsDone: false, allowProposal: false },
  // «đã thanh toán / thanh toán xong / thanh toán đủ»
  { kind: "PAYMENT_RECEIVED", re: /\b(?:(?:da|vua)\s+thanh toan|thanh toan\s+(?:xong|roi|du))\b/, needsDone: false, allowProposal: false },
  // «em chốt đơn …» / «đã chốt đơn» / «em chốt cho chị …» — trừ đơn NHÁP và «em chốt lại: …» (đọc lại tóm tắt)
  { kind: "ORDER_CONFIRMED", re: /\b(?:(?:em|shop|ben em|ben shop)\s+(?:da\s+|vua\s+)?chot\b(?!\s+lai)(?!\s+(?:don\s+)?nhap)|(?:da|vua)\s+chot\s+don\b(?!\s+nhap)|chot\s+don\s+(?:roi|xong|thanh cong)\b)/, needsDone: false, allowProposal: true },
  // «đã lên / tạo / đặt đơn» — chỉ khi đã xong; đơn NHÁP không tính
  { kind: "ORDER_CONFIRMED", re: /\b(?:len|tao|dat|ghi)\s+(?:don|don hang)\b(?!\s+nhap)/, needsDone: true, allowProposal: true },
  // «đặt hàng thành công»
  { kind: "ORDER_CONFIRMED", re: /\bdat\s+(?:hang|don)\s+thanh cong\b/, needsDone: false, allowProposal: false },
  // «đơn (của chị) đã được chốt / xác nhận» — «đơn được xác nhận KHI chị đồng ý» không có dấu đã xong ⇒ không tính
  { kind: "ORDER_CONFIRMED", re: /\bdon(?:\s+hang)?(?:\s+cua\s+(?:minh|chi|anh|ban|em|c|a))?\s+(?:da\s+|vua\s+)?(?:duoc\s+)?(?:chot|xac nhan|len|tao|ghi nhan)\b/, needsDone: true, allowProposal: false },
  // «em đã xác nhận đơn» — chỉ khi đã xong («em xác nhận lại đơn: …» là đọc tóm tắt)
  { kind: "ORDER_CONFIRMED", re: /\bxac nhan\s+(?:lai\s+)?don\b/, needsDone: true, allowProposal: true },
  // «shop đã nhận đơn / em nhận được đơn của chị» — «shop nhận đơn tới 17h» là chính sách, không phải khẳng định
  { kind: "ORDER_CONFIRMED", re: /\b(?:em|shop|ben em|ben shop)\s+(?:da\s+)?nhan\s+(duoc\s+)?don\b/, needsDone: (m) => !m[1], allowProposal: true },
];

/**
 * Loại khẳng định có trong câu của BOT (rỗng = không khẳng định gì cần căn cứ). Chỉ mệnh đề KHẲNG ĐỊNH: câu hỏi, câu đề nghị,
 * cụm đứng sau phủ định / tương lai / điều kiện đều bỏ qua. HÀM THUẦN.
 */
export function detectClaims(text: string): ClaimKind[] {
  const found = new Set<ClaimKind>();
  for (const c of clausesOf(text)) {
    if (c.question || QUESTION_TAIL_RE.test(c.folded)) continue;
    const proposal = PROPOSAL_TAIL_RE.test(c.folded);
    const done = DONE_RE.test(c.folded);
    for (const rule of CLAIM_RULES) {
      if (found.has(rule.kind)) continue;
      const m = rule.re.exec(c.folded);
      if (!m) continue;
      if (blockedBefore(c.folded, m.index)) continue;
      const needsDone = typeof rule.needsDone === "function" ? rule.needsDone(m, c.folded) : rule.needsDone;
      if (needsDone && !done) continue;
      if (proposal && rule.allowProposal && !done) continue;
      found.add(rule.kind);
    }
  }
  return [...found];
}

/** Bảng chân lý: khẳng định nào cần căn cứ nào. Không khẳng định ⇒ luôn qua. HÀM THUẦN. */
export function claimVerdict(claims: readonly ClaimKind[], facts: ClaimFacts): ClaimVerdict {
  if (claims.includes("PAYMENT_RECEIVED") && !facts.paymentVerified) {
    return { ok: false, claim: "PAYMENT_RECEIVED", safeText: CLAIM_SAFE_TEXT.PAYMENT, handoffReason: CLAIM_HANDOFF_REASON.PAYMENT_RECEIVED, note: "Đã chặn câu AI khẳng định đã nhận tiền — chưa có chứng từ thu" };
  }
  if (claims.includes("ORDER_CONFIRMED") && !facts.orderConfirmed) {
    return { ok: false, claim: "ORDER_CONFIRMED", safeText: CLAIM_SAFE_TEXT.ORDER, handoffReason: CLAIM_HANDOFF_REASON.ORDER_CONFIRMED, note: "Đã chặn câu AI khẳng định đã chốt đơn — chưa có đơn ERP" };
  }
  return { ok: true };
}

/** `detectClaims` + `claimVerdict`. HÀM THUẦN. */
export function guardClaims(text: string, facts: ClaimFacts): ClaimVerdict {
  return claimVerdict(detectClaims(text), facts);
}

/**
 * Bản dùng trong lượt bot: chỉ ĐỌC ERP khi câu thật sự có khẳng định (đa số câu không có ⇒ 0 truy vấn). Lỗi đọc ⇒ chặn.
 */
export async function guardOutgoing(text: string, facts: () => Promise<ClaimFacts>): Promise<ClaimVerdict> {
  const claims = detectClaims(text);
  if (!claims.length) return { ok: true };
  const f = await facts().catch((): ClaimFacts => ({ paymentVerified: false, orderConfirmed: false }));
  return claimVerdict(claims, f);
}

/** Lời khách «đã chuyển khoản» gõ tay (đã bỏ dấu) — chỉ cụm nói về TIỀN, không bắt «đã chuyển địa chỉ». */
const CUSTOMER_PAID_RULES: readonly RegExp[] = [
  /\b(?:da|vua|moi)\s+(?:ck|chuyen khoan|chuyen tien|thanh toan|gui tien|bank|banking)\b/,
  /\b(?:ck|chuyen khoan|chuyen tien|thanh toan|gui tien|bank|chuyen)\s+(?:roi|xong|r)\b/,
  /\b(?:ck|chuyen khoan|chuyen tien)\s+(?:cho|qua)\s+(?:shop|em|ban|b|c|e|s)\s+(?:roi|xong|r)\b/,
];

/**
 * Tin KHÁCH có dấu hiệu đã trả tiền không: `IMAGE` = dòng ảnh chuyển khoản (máy đọc ảnh ghi), `TEXT` = khách gõ «ck rồi»,
 * «đã chuyển khoản»…; `null` = không. Câu hỏi («chuyển khoản được không», «ck rồi hả») không tính. HÀM THUẦN.
 */
export function paymentSignalInCustomerText(text: string): PaymentSignal | null {
  for (const m of text.matchAll(IMAGE_SEGMENT_RE)) if (looksLikePaymentImage(m[1] ?? "")) return "IMAGE";
  const typed = text.replace(IMAGE_SEGMENT_RE, " ");
  for (const c of clausesOf(typed)) {
    if (c.question || QUESTION_TAIL_RE.test(c.folded)) continue;
    for (const re of CUSTOMER_PAID_RULES) {
      const m = re.exec(c.folded);
      if (m && !blockedBefore(c.folded, m.index)) return "TEXT";
    }
  }
  return null;
}

/** Câu trả lời + lý do chuyển người khi khách báo đã trả tiền. HÀM THUẦN. */
export function paymentSignalHandoff(signal: PaymentSignal): { safeText: string; reason: string } {
  return signal === "IMAGE" ? { safeText: CLAIM_SAFE_TEXT.PAYMENT_IMAGE, reason: CLAIM_HANDOFF_REASON.PAYMENT_IMAGE } : { safeText: CLAIM_SAFE_TEXT.PAYMENT, reason: CLAIM_HANDOFF_REASON.PAYMENT_TEXT };
}

/**
 * Mô tả ảnh do AI đọc ảnh viết ⇒ ảnh chứng từ thanh toán mang nhãn CHƯA XÁC MINH và chữ «thành công» của ẢNH thành lời trích,
 * không còn là dữ kiện. Ảnh khác giữ nguyên. HÀM THUẦN.
 */
export function labelPaymentImageDescription(description: string): string {
  if (!looksLikePaymentImage(description) || description.includes(UNVERIFIED_PAYMENT_IMAGE_LABEL)) return description;
  const neutral = description.replace(/\b((?:chuyển khoản|chuyển tiền|giao dịch|thanh toán)\s+)thành công\b/gi, "$1(ảnh ghi «thành công» — chưa xác minh)");
  return `${UNVERIFIED_PAYMENT_IMAGE_LABEL}: ${neutral}`;
}

// ═══ PHẦN MÁY CHỦ — đọc căn cứ ═══

export type ClaimConversation = { id: string; orderId: string | null; pageId: string | null; threadId: string | null };

/**
 * Bộ đọc căn cứ cho MỘT lượt: phần CSDL đọc một lần (lười — chỉ khi có câu khẳng định), phần `state` đọc lúc hỏi (công cụ
 * `confirm_order` có thể vừa chốt ở vòng trước của chính lượt này).
 */
export function claimFactsLoader(conv: ClaimConversation): (state: ChatState) => Promise<ClaimFacts> {
  let db: Promise<{ orders: { id: string; stage: string }[]; paidOrderIds: Set<string> }> | null = null;
  return async (state) => {
    if (!db) db = linkedOrderFacts(conv);
    const r = await db;
    const botDraft = !state.confirmed ? (state.draft?.orderId ?? null) : null;
    const liveOrders = r.orders.filter((o) => !(o.id === botDraft && o.stage === "NEW"));
    return { paymentVerified: liveOrders.some((o) => r.paidOrderIds.has(o.id)), orderConfirmed: Boolean(state.confirmed) || liveOrders.length > 0 };
  };
}

async function linkedOrderFacts(conv: ClaimConversation): Promise<{ orders: { id: string; stage: string }[]; paidOrderIds: Set<string> }> {
  const d = await getDb();
  const o = schema.orders;
  const links: SQL[] = [eq(o.salesConversationId, conv.id)];
  if (conv.orderId) links.push(eq(o.id, conv.orderId));
  if (conv.pageId && conv.threadId) links.push(and(eq(o.pageId, conv.pageId), eq(o.conversationId, conv.threadId))!);
  const orders = await d
    .select({ id: o.id, stage: sql<string>`${o.stage}::text`, total: o.totalPriceAfterDiscount, ship: o.shippingFee })
    .from(o)
    .where(and(or(...links), notInArray(o.stage, ["CANCELLED", "DELETED"])))
    .limit(20);
  const manual = orders.filter((x) => x.id.startsWith("erp-"));
  const paidOrderIds = new Set<string>();
  if (manual.length) {
    const p = schema.orderPayments;
    const rows = await d.select({ orderId: p.orderId, kind: p.kind, amount: p.amount, status: p.status }).from(p).where(inArray(p.orderId, manual.map((x) => x.id)));
    for (const x of manual) {
      const sums = sumConfirmedPayments(rows.filter((r) => r.orderId === x.id).map((r) => ({ kind: r.kind, amount: Number(r.amount), status: r.status })));
      if (manualPaymentStatus(sums, manualOrderAmountDue({ totalPriceAfterDiscount: Number(x.total ?? 0), shippingFee: Number(x.ship ?? 0) })).status === "PAID") paidOrderIds.add(x.id);
    }
  }
  return { orders: orders.map((x) => ({ id: x.id, stage: x.stage })), paidOrderIds };
}

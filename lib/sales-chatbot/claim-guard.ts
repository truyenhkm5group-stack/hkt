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
 *  2. `detectClaims` / `guardClaims` — câu của BOT khẳng định «đã nhận tiền / thanh toán xong», «đã chốt đơn / đơn đã xác
 *     nhận» hoặc «đã huỷ đơn» (căn cứ: cancel_order trả cancelled = true). Chỉ bắt câu KHẲNG ĐỊNH: câu hỏi, câu đề nghị («em chốt đơn cho mình nhé?»), câu phủ định / điều kiện («khi nhận
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
import { isManualOrderId, manualOrderGaps } from "@/lib/constants/manual-orders";
import { manualOrderAmountDue, manualPaymentStatus, sumConfirmedPayments } from "@/lib/constants/order-payments";
import { orderReviewOf } from "@/lib/constants/order-review";
import { formatVND } from "@/lib/format";
import { namedProductsIn } from "@/lib/sales-chatbot/cart-commitment";
import type { ReferenceBreakdown } from "@/lib/sales-chatbot/quote";
import { PRICE_UNVERIFIED_PREFIX } from "@/lib/sales-chatbot/quote-shared";
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
  /** Bot định nói đã huỷ đơn mà lõi đơn chưa huỷ (cancel_order chưa trả cancelled = true). */
  CANCEL: "Dạ em ghi nhận yêu cầu của mình, em chuyển nhân viên kiểm tra đơn giúp mình ngay ạ.",
  /** Đơn ĐÃ TẠO nhưng địa chỉ chưa chuẩn hoá được (xã / phường / tỉnh) — đơn chờ nhân viên xác nhận, chưa phải «đã lên đơn». */
  ORDER_PENDING_ADDRESS: "Dạ em đã ghi nhận đơn của mình, nhân viên sẽ xác nhận lại địa chỉ giúp mình ngay ạ.",
  /**
   * Cùng tình huống, khi tổ chức bật `upsellAfterContact` (P0 21/10/2026): chỉ vế GHI NHẬN — không hứa nhân viên gọi lại, không «đã lên
   * đơn». Việc xác minh địa chỉ là việc NỘI BỘ (cờ ADDRESS_UNRESOLVED · hàng «Cần người kiểm»), khách không phải chờ nó.
   */
  ORDER_RECEIVED: "Dạ em đã ghi nhận đơn của mình ạ.",
  /** Đơn ĐÃ TẠO nhưng còn ô cần kiểm (giá · SĐT · cờ cần người kiểm). */
  ORDER_PENDING_CHECK: "Dạ em đã ghi nhận đơn của mình, nhân viên sẽ kiểm tra và xác nhận lại đơn giúp mình ngay ạ.",
  /** Bot định nói một số tiền không khớp báo giá máy chủ đã xác thực. */
  PRICE: "Dạ em kiểm lại giá chính xác và báo mình ngay ạ.",
  /** Bot định nói đã đổi địa chỉ / lịch giao / ghi chú / thêm món vào đơn mà không công cụ nào ghi (HOTFIX 12/10/2026, ca «Đỗ Là»). */
  ORDER_EDIT: "Dạ em ghi nhận yêu cầu thay đổi của mình, em chuyển nhân viên cập nhật đơn giúp mình ngay ạ.",
  /** Bot định hứa hoàn tiền / đổi hàng / gửi bù / bồi thường — việc bot không có quyền làm. */
  REFUND: "Dạ em xin lỗi mình, em chuyển nhân viên kiểm tra và hỗ trợ mình ngay ạ.",
  /**
   * Khách than GIAO CHẬM / chưa nhận hàng (P0 21/10/2026, ca HSLC #BD31267C). Gửi SAU khi lượt chuyển người đã ghi — một câu xin lỗi + đã
   * chuyển nhân viên. KHÔNG một mốc nào («gửi ngay», «chuẩn bị gửi», «hôm nay nhận»): máy chủ không có chứng từ cho mốc đó.
   */
  DELIVERY_DELAY: "Dạ em xin lỗi mình vì đã để mình chờ lâu ạ. Em đã chuyển nhân viên kiểm tra đơn và báo lại mình sớm nhất ạ.",
  /** Khách phản đối giá mà máy chủ không xác minh được số khách nói ⇒ nhân viên kiểm. */
  PRICE_DISPUTE: "Dạ em ghi nhận ý mình về giá, em chuyển nhân viên kiểm tra lại giá chính xác và báo mình ngay ạ.",
} as const;

/**
 * Câu nói với khách khi đơn đã ghi mà địa chỉ chưa ghép được — MỘT chỗ chọn cho cả hàng rào lẫn công cụ chốt / sửa đơn. `quiet` =
 * tổ chức bật `upsellAfterContact`. HÀM THUẦN.
 */
export function pendingAddressText(quiet: boolean): string {
  return quiet ? CLAIM_SAFE_TEXT.ORDER_RECEIVED : CLAIM_SAFE_TEXT.ORDER_PENDING_ADDRESS;
}

/** Lý do chuyển người — tiền tố `classifyHandoffReason` đọc (events-shared.ts) để đếm theo nhóm. */
export const CLAIM_HANDOFF_REASON = {
  PAYMENT_IMAGE: "Khách báo đã chuyển khoản — gửi ảnh chuyển khoản, cần nhân viên đối soát (bot không xác nhận tiền)",
  PAYMENT_TEXT: "Khách báo đã chuyển khoản — cần nhân viên đối soát (bot không xác nhận tiền)",
  PAYMENT_RECEIVED: "AI định khẳng định đã nhận tiền khi chưa có chứng từ thu — đã chặn câu, nhân viên đối soát",
  ORDER_CONFIRMED: "AI định khẳng định đã chốt đơn khi chưa có đơn ERP — đã chặn câu, nhân viên kiểm đơn",
  ORDER_CANCELLED: "AI định khẳng định đã huỷ đơn khi lõi đơn chưa huỷ — đã chặn câu, nhân viên kiểm đơn",
  /** Đơn có nhưng chưa qua kiểm — KHÔNG chuyển người (đơn đã nằm trong hàng «Cần người kiểm»); chỉ ghi lý do vào nhật ký. */
  ORDER_PENDING: "AI định khẳng định đã lên đơn khi đơn còn cần kiểm (địa chỉ / giá / SĐT) — đã thay câu, đơn chờ nhân viên xác nhận",
  PRICE_UNVERIFIED: `${PRICE_UNVERIFIED_PREFIX}: AI định báo số tiền không khớp báo giá máy chủ đã xác thực — đã chặn câu, nhân viên xác minh giá`,
  PRICE_DISPUTED: "Giá / tồn bất thường — PRICE_DISPUTED: khách phản đối giá đã báo, máy chủ không xác minh được số khách nói — nhân viên kiểm giá, KHÔNG chốt đơn",
  ORDER_EDITED: "AI định khẳng định đã sửa đơn (địa chỉ / lịch giao / ghi chú / món) khi không công cụ nào ghi — đã chặn câu, nhân viên cập nhật đơn",
  REFUND_PROMISE: "AI định hứa hoàn tiền / đổi hàng / gửi bù — việc bot không có quyền làm, đã chặn câu, nhân viên xử lý khiếu nại",
} as const;

// ═══ PHẦN THUẦN ═══

export type PaymentSignal = "IMAGE" | "TEXT";
export type ClaimKind = "PAYMENT_RECEIVED" | "ORDER_CONFIRMED" | "ORDER_CANCELLED" | "PRICE_UNVERIFIED" | "ORDER_EDITED" | "REFUND_PROMISE";
/**
 * `orderCancelled` = công cụ `cancel_order` đã trả cancelled = true trong hội thoại (`state.cancelledOrders`, ghi SAU khi lõi đơn huỷ xong — #786).
 * `orderConfirmed` = có đơn ĐÃ TẠO **và** QUA KIỂM (P0 11/10/2026 — `orderValidityOf`): đơn «CẦN XÁC THỰC» (địa chỉ chưa ghép, tổng lệch báo
 * giá, thiếu SĐT, cờ cần người kiểm) KHÔNG đủ cho câu «đã lên đơn». `orderPending` = có đơn đã tạo nhưng chưa qua kiểm — vì sao.
 * `allowedAmounts` = mọi số tiền máy chủ đã xác thực cho hội thoại (báo giá gần nhất · giá công cụ đã trả · tập tham chiếu của danh mục);
 * KHÔNG khai ⇒ không kiểm số tiền (bài kiểm cũ / người gọi chưa cấp).
 */
/**
 * `orderEditedThisTurn` (HOTFIX 12/10/2026) = công cụ lên / sửa đơn ĐÃ GHI THÀNH CÔNG trong CHÍNH lượt này (`state.draft.shownTurn` = lượt) —
 * căn cứ duy nhất cho câu «em đã đổi địa chỉ / đã thêm món vào đơn». Vắng ⇒ không có căn cứ.
 */
/**
 * `totals` (P0 14/10/2026, ca «Châu Dương» — bot báo TỔNG 640.000 ₫ cho 1kg 280.000 ₫): số TỔNG của REVISION giỏ / nháp / đơn chốt
 * hiện tại theo báo giá máy chủ (`totalAllowedOf`). Vắng ⇒ hội thoại chưa có giỏ ⇒ số «tổng» xét như mọi số tiền khác (tập tham chiếu).
 * Có ⇒ một số mang nghĩa «tổng» trong chữ bot phải THUỘC `totals.allowed`; `current` = tổng để nói lại cho khách (`null` = báo giá đã
 * cũ so với giỏ / chưa biết phí ship ⇒ không có số nào để nói thay).
 */
export type ClaimTotals = { allowed: ReadonlySet<number>; current: ServerTotal | null; stale: boolean };
/** Tổng để nói lại: `shipping` = phí ship đã gồm trong tổng · `null` = không tách được (đơn đã chốt) · `"UNKNOWN"` = phí ship chưa biết (tổng = tiền hàng). */
export type ServerTotal = { total: number; shipping: number | null | "UNKNOWN" };
/**
 * `suspicious` (review vòng 3): số tiền là MỘT TỔNG đã tính cho một giỏ KHÁC giỏ hiện tại — tổng máy chủ đã báo trước đó (`seenTotals`) hoặc
 * bội số của mẫu mã KHÔNG có trong giỏ — trừ giá niêm yết một đơn vị, bội số của món đang có trong giỏ, giá công cụ đã trả và tổng hợp lệ
 * hiện tại. Có mặt ở BẤT KỲ đâu trong câu (không cần chữ «tổng») ⇒ chặn + người. `unitPrices` = giá một đơn vị (được nói cạnh chữ COD).
 */
/**
 * Review vòng 4: `seen` = tổng máy chủ đã báo trong hội thoại (LUẬT B — không phải tổng hiện tại ⇒ luôn chặn); `namedAmounts` = tên sản phẩm
 * → bội số giá của nó (câu «nem 120k một hộp, 2 hộp 240k» gọi tên món thì được nói bội số của CHÍNH món đó); `shipFee` / `freeShipFrom` =
 * phí ship cố định và ngưỡng miễn ship của cấu hình (được nói cạnh chữ thanh toán).
 */
/** `quietAddressReview` = tổ chức bật `upsellAfterContact`: đơn chỉ chờ xác minh ĐỊA CHỈ ⇒ câu thay là `ORDER_RECEIVED`, không phải `ORDER_PENDING_ADDRESS`. */
export type ClaimFacts = { paymentVerified: boolean; orderConfirmed: boolean; orderCancelled: boolean; orderPending?: "ADDRESS" | "CHECK" | null; quietAddressReview?: boolean; allowedAmounts?: ReadonlySet<number>; orderEditedThisTurn?: boolean; totals?: ClaimTotals; suspicious?: ReadonlySet<number>; unitPrices?: ReadonlySet<number>; seen?: ReadonlySet<number>; namedAmounts?: ReadonlyMap<string, ReadonlySet<number>>; shipFee?: number | null; freeShipFrom?: number | null; rejected?: ReadonlySet<number> };
/** `handoff = false` ⇒ thay câu nhưng KHÔNG chuyển người (câu an toàn vẫn gửi trên mọi kênh). */
export type ClaimVerdict = { ok: true } | { ok: false; claim: ClaimKind; safeText: string; handoffReason: string; note: string; handoff: boolean; amounts?: number[] };

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
  // «em / shop đã huỷ đơn» · «đơn của chị đã được huỷ» — chỉ khi đã xong («em huỷ đơn cho chị nhé» là đề nghị; «ĐƠN CHƯA HUỶ» bị
  // phủ định chặn). Căn cứ duy nhất: cancel_order trả cancelled = true (#786 — «đã huỷ» chỉ đúng khi lõi đơn ghi xong).
  { kind: "ORDER_CANCELLED", re: /\b(?:(?:em|shop|ben em|ben shop)\s+(?:da\s+|vua\s+)?huy\s+(?:don|giup|cho)|(?:da|vua)\s+huy\s+don)\b/, needsDone: true, allowProposal: true },
  { kind: "ORDER_CANCELLED", re: /\bdon(?:\s+hang)?(?:\s+cua\s+(?:minh|chi|anh|ban|em|c|a))?\s+(?:da\s+|vua\s+)?(?:duoc\s+)?huy\b/, needsDone: true, allowProposal: false },
  // «shop đã nhận đơn / em nhận được đơn của chị» — «shop nhận đơn tới 17h» là chính sách, không phải khẳng định
  { kind: "ORDER_CONFIRMED", re: /\b(?:em|shop|ben em|ben shop)\s+(?:da\s+)?nhan\s+(duoc\s+)?don\b/, needsDone: (m) => !m[1], allowProposal: true },
  // «em đã đổi địa chỉ giao …» · «em cập nhật ghi chú giao Chủ nhật … rồi» · «đã sửa đơn» · «đổi lịch giao xong» (HOTFIX 12/10/2026, «Đỗ Là»)
  // («ghi đơn» / «lên đơn» là luật ORDER_CONFIRMED ở trên — không đếm ở đây.)
  { kind: "ORDER_EDITED", re: /\b(?:doi|sua|cap nhat|chuyen)\s+(?:lai\s+)?(?:dia chi|sdt|so dien thoai|ngay giao|lich giao|gio giao|ghi chu|thong tin don|nguoi nhan)\b|\bsua\s+(?:lai\s+)?don\b/, needsDone: true, allowProposal: false },
  // «em thêm 1 hũ ruốc vào đơn cho chị rồi ạ»
  { kind: "ORDER_EDITED", re: /\bthem\s+(?:\S+\s+){0,4}vao\s+(?:don|don hang)\b/, needsDone: true, allowProposal: false },
  // «em ghi chú giao giờ hành chính rồi ạ» · «em note lại cho kho rồi» · «em báo kho rồi» · «em đổi sang 2 hộp rồi ạ» (review #821 vòng 2)
  { kind: "ORDER_EDITED", re: /\b(?:ghi chu|note|bao kho|dan kho|nhan kho|bao ben kho)\b|\bdoi\s+(?:lai\s+)?sang\s+\S+/, needsDone: true, allowProposal: false },
  // «Dạ đơn của chị em đã đổi xong ạ» · «đơn đã sửa rồi» (review #821 vòng 3)
  { kind: "ORDER_EDITED", re: /\bdon(?:\s+hang)?(?:\s+cua\s+(?:minh|chi|anh|ban|c|a))?(?:\s+(?:em|shop))?\s+(?:da\s+)?(?:duoc\s+)?(?:doi|sua|cap nhat)\b/, needsDone: true, allowProposal: false },
];

/**
 * Lời HỨA bot không có quyền thực hiện (HOTFIX 12/10/2026): hoàn tiền · đổi hàng · gửi bù / gửi lại hàng · bồi thường. Khác các luật trên:
 * «sẽ», «nhé» KHÔNG cứu được câu (hứa tương lai vẫn là hứa); chỉ phủ định đứng ngay trước, câu hỏi, hoặc mệnh đề CHÍNH SÁCH có điều kiện
 * («nếu hàng lỗi shop hoàn tiền», «trong vòng 3 ngày», «theo chính sách») mới không tính — đọc lại chính sách của shop là việc hợp lệ.
 */
const REFUND_PROMISE_RE = /\b(?:hoan|tra lai|gui lai|chuyen lai)\s+(?:lai\s+)?(?:tien|tien hang|tien cho)\b|\bdoi\s+(?:lai\s+)?(?:hang|san pham|sp|mon|goi|hop|hu)(?:\s+moi)?\s+cho\b|\bgui\s+bu\b|\bgui\s+lai\s+(?:\d+\s+)?(?:hang|don|goi|hop|hu|mon|san pham|sp)\b|\bboi thuong\b/;
const REFUND_NEGATION = new Set(["chua", "khong", "ko", "k", "chang", "khoi"]);
/** Chủ ngữ là ĐVVC / bưu tá («bên vận chuyển sẽ gửi lại hàng cho chị») — bot đang thuật lời khai của hãng, không phải shop hứa. */
const CARRIER_SUBJECT_RE = /\b(?:ben van chuyen|don vi van chuyen|dvvc|buu ta|buu cuc|shipper|nha van chuyen|viettel post|ghtk|ghn|j&t)\b/;
const POLICY_CONDITIONAL_RE = /\b(?:neu|khi|truong hop|chinh sach|trong vong|quy dinh|dieu kien)\b/;

function refundPromiseIn(c: { folded: string; question: boolean }): boolean {
  if (c.question || QUESTION_TAIL_RE.test(c.folded) || POLICY_CONDITIONAL_RE.test(c.folded)) return false;
  const m = REFUND_PROMISE_RE.exec(c.folded);
  if (!m) return false;
  const beforeText = c.folded.slice(0, m.index);
  if (CARRIER_SUBJECT_RE.test(beforeText)) return false;
  // Phủ định trong BỐN từ trước cụm: «em không có quyền hoàn tiền» · «shop chưa thể hoàn tiền».
  const before = beforeText.trim().split(/\s+/).filter(Boolean).slice(-4);
  return !before.some((w) => REFUND_NEGATION.has(w));
}

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
  for (const c of clausesOf(text)) if (refundPromiseIn(c)) found.add("REFUND_PROMISE");
  return [...found];
}

// ═══ SỐ TIỀN TRONG CHỮ BOT (P0 authoritative-quote 11/10/2026) ═══

/** «1tr2» = 1.200.000 · «1tr250» = 1.250.000. */
const MILLION_SPLIT_RE = /(^|[^\d.,])(\d{1,3})\s*(?:tr|triệu|trieu|củ)(\d{1,3})(?![\d\p{L}])/giu;
/** «280k» · «20K» · «1,5 triệu» · «300 nghìn» — đơn vị bắt buộc; «2kg» không phải tiền (sau «k» là chữ). */
const UNIT_AMOUNT_RE = /(^|[^\d.,])(\d+(?:[.,]\d+)?)\s*(k|nghìn|nghin|ngàn|ngan|tr|triệu|trieu|củ)(?![\p{L}\d])/giu;
/** «540.000» · «1.080.000 ₫» · «560,000đ» — dấu tách nghìn đủ nhóm ba chữ số; số dính trong chuỗi số dài hơn (SĐT có chấm) không tính. */
const GROUPED_AMOUNT_RE = /(^|[^\d.,])(\d{1,3}(?:[.,]\d{3})+)(?![\d]|[.,]\d)/gu;
/** «540000đ» · «0đ» · «30000 vnđ» — số trơn chỉ là tiền khi có ký hiệu tiền ngay sau. */
const PLAIN_CURRENCY_RE = /(^|[^\d.,])(\d+)\s*(?:đ|₫|vnđ|vnd|đồng|dong)(?![\p{L}\d])/giu;

/**
 * Mọi số tiền VND trong một câu (đồng, số nguyên). Số trơn không đơn vị, không tách nghìn (SĐT, số lượng, mã) KHÔNG tính; khối lượng
 * («2kg», «500g»), «x2», giờ giấc cũng không. Mỗi đoạn chỉ đọc MỘT lần (đọc xong thì xoá khỏi chuỗi trước luật sau). HÀM THUẦN.
 */
export function extractVndAmounts(text: string): number[] {
  const out: number[] = [];
  let rest = text.normalize("NFC");
  const take = (re: RegExp, value: (m: string[]) => number) => {
    rest = rest.replace(re, (...args: unknown[]) => {
      const m = args.slice(0, -2).map((x) => (typeof x === "string" ? x : ""));
      const v = value(m);
      if (Number.isFinite(v)) out.push(Math.round(v));
      return `${m[1]} `;
    });
  };
  take(MILLION_SPLIT_RE, (m) => Number(m[2]) * 1_000_000 + Number(m[3]) * 10 ** (6 - m[3].length));
  take(UNIT_AMOUNT_RE, (m) => Number(m[2].replace(",", ".")) * (m[3].toLowerCase() === "k" || m[3].toLowerCase().startsWith("ng") ? 1000 : 1_000_000));
  take(GROUPED_AMOUNT_RE, (m) => Number(m[2].replace(/[.,]/g, "")));
  take(PLAIN_CURRENCY_RE, (m) => Number(m[2]));
  return out;
}

/**
 * Cụm khách PHẢN ĐỐI giá (đã bỏ dấu): «… chứ», «sao lại …», «tưởng …», «bảo là …», «tính sai / nhầm», «đắt thế», «không phải …».
 * «chứ» chỉ tính khi đứng cuối mệnh đề (đuôi phản bác), không tính «chứ không» giữa câu.
 */
const DISPUTE_PHRASE_RE = /\b(?:sao lai|sao gia|sao tinh|tuong la|tuong gia|bao la|bao gia la|niem yet|dat the|dat vay|dat qua|nham|sai gia|sai tien|tinh sai|tinh nham|khong phai|ko phai|k phai|ma sao|tinh lai)\b|\bchu\s*(?:a|ah|ak|nhi|nha|em|shop|e|c|chi)?\s*[.!?]*\s*$/;
/** Cụm hoàn toàn khẳng định sai giá — không cần số tiền để biết khách đang khiếu nại giá. */
const DISPUTE_STRONG_RE = /\b(?:sai gia|sai tien|tinh sai|tinh nham|nham gia)\b/;

export type PriceDispute = { amounts: number[]; phrase: boolean };

/**
 * Khách PHẢN ĐỐI giá đã báo (PRICE_DISPUTED — chủ shop 11/10/2026, ca «Chị Hoàn»: bot báo 560.000 ₫, khách «2 ký giá 540đ chứ», bot vẫn
 * để đơn «ĐÃ XÁC NHẬN»). HÀM THUẦN. Chỉ xét khi hội thoại ĐÃ có báo giá. Phản đối = (a) khách nói số tiền KHÁC mọi số của báo giá gần nhất
 * (hoặc nhắc lại chính số đã báo) kèm cụm phản bác, hoặc (b) cụm khẳng định sai giá («tính sai», «sai giá»). Khách hay gõ «540đ» / «540» cho 540.000 ₫ ⇒ số < 10.000
 * nhân 1.000. Khách nói đúng số của báo giá («ok 560 nhé») hay chỉ hỏi chung («ship bao nhiêu») ⇒ không phải phản đối.
 */
export function detectPriceDispute(customerText: string, quote: { amounts: readonly number[]; total: number | null; subtotal: number } | null | undefined): PriceDispute | null {
  if (!quote) return null;
  const folded = foldClaim(customerText).trim();
  const amounts = [...new Set(extractVndAmounts(customerText).map((n) => (n > 0 && n < 10_000 ? n * 1000 : n)).filter((n) => n > 0))];
  const quoted = new Set<number>([...quote.amounts, quote.subtotal, ...(quote.total !== null ? [quote.total] : [])]);
  const differs = amounts.filter((n) => !quoted.has(n));
  const phrase = DISPUTE_PHRASE_RE.test(folded);
  if (phrase && amounts.length) return { amounts: differs, phrase };
  if (DISPUTE_STRONG_RE.test(folded)) return { amounts: differs, phrase: true };
  return null;
}

/** Bỏ dấu GIỮ NGUYÊN độ dài (mỗi ký tự ra đúng một ký tự, ký tự ngoài chữ / số thành khoảng trắng) — chỉ số dùng được trên chữ gốc. HÀM THUẦN. */
export function foldKeepLength(s: string): string {
  let out = "";
  for (const ch of s) {
    const b = ch.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
    out += b.length === 1 && /[a-z0-9]/.test(b) ? b : " ".repeat(ch.length);
  }
  return out;
}

/**
 * Cụm «TỔNG phải trả» (đã bỏ dấu). KHÔNG có «cod» / «thanh toán» trần («thanh toán 30k ship ạ» là phí ship) và «tổng» chỉ tính khi số
 * tiền đứng NGAY sau («tổng hợp lại đơn», «tổng cộng có 3 loại» không phải tổng). «tổng tiền hàng» là TIỀN HÀNG.
 */
const TOTAL_CUE_RE = /(?:^| )(?:tong +cong|tong +tien(?! +hang)|tong +don|tong +thanh +toan|can +thanh +toan|tat +ca +la|het +tat +ca|tong(?! +(?:tien +hang|hop)))(?= |$)/g;
const NEXT_CUE_RE = /(?:^| )tong(?= |$)/;
/** Câu giả định / phương án («nếu lấy 2kg thì tổng 540k», «thêm 1 hộp nem 120k thì tổng 430k») — số trong đó không phải tổng của đơn. */
const HYPOTHETICAL_RE = /(?:^| )(?:neu|thi|gia su)(?= |$)/;
/** Chữ đệm được phép giữa cụm tổng và số tiền: «tổng: 310k», «tổng = 310k», «tổng cộng là 310k», «tổng đơn của mình là 310k». */
const TOTAL_FILLER_RE = /^[\s:=]*(?:(?:của|cua)\s+(?:mình|minh|chị|chi|anh|em|bạn|ban|đơn|don)\s+)?(?:(?:là|la|chỉ|chi|còn|con|hết|het|vẫn|van|sẽ|se)\s+)*[\s:=]*/iu;

/**
 * Số tiền mang nghĩa «TỔNG» trong chữ bot (P0 14/10/2026, review): mỗi dòng / câu KHÔNG giả định có cụm tổng mà số tiền đứng NGAY sau
 * (chỉ chữ đệm «:», «là», «của mình là») ⇒ số đó; phần sau có «=» ⇒ số sau dấu «=» cuối («tổng: 280k + 30k = 310k»). Không chắc là tổng
 * ⇒ KHÔNG trả gì (số đó vẫn đi qua kiểm tập số tiền như mọi số khác). HÀM THUẦN.
 */
export function totalClaimsIn(text: string): number[] {
  const out: number[] = [];
  for (const seg of text.normalize("NFC").split(/\n|[.!?;]\s+(?=\p{Lu})/u)) {
    const folded = foldKeepLength(seg);
    if (HYPOTHETICAL_RE.test(folded)) continue;
    TOTAL_CUE_RE.lastIndex = 0;
    for (let m = TOTAL_CUE_RE.exec(folded); m; m = TOTAL_CUE_RE.exec(folded)) {
      let rest = seg.slice(m.index + m[0].length);
      const next = foldKeepLength(rest).search(NEXT_CUE_RE);
      if (next > 0) rest = rest.slice(0, next);
      const head = rest.replace(TOTAL_FILLER_RE, "");
      if (!/^\d/.test(head)) continue;
      const eqAt = head.lastIndexOf("=");
      const first = extractVndAmounts(eqAt >= 0 ? head.slice(eqAt + 1) : head)[0];
      if (typeof first === "number" && first > 0) out.push(first);
    }
  }
  return [...new Set(out)];
}

/** Cụm báo TỔNG / thanh toán (đã bỏ dấu, review vòng 3): «tổng» (trừ «tổng hợp», «tổng tiền hàng»), «thành tiền», «tính ra», «cộng lại», «tất cả», «giá trị đơn», «thanh toán», «COD», «thu hộ», dấu «=». */
const BROAD_CUE_RE = /(?:^| )(?:tong(?! +(?:tien +hang|hop))|thanh +tien|tinh +ra|cong(?: +lai)?|tat +ca|gia +tri +don|thanh +toan|cod|thu +ho|chuan +bi)(?= |$)|=/g;
/** Chữ liệt kê giữa cụm và số đầu tiên («tổng cộng có 3 loại: …», «gồm») ⇒ mệnh đề là danh sách giá, không phải câu báo tổng. */
const LIST_WORDS = new Set(["co", "gom", "loai", "nhu"]);
/** Chữ ngay sau một số trơn (không đơn vị) để coi nó là NGHÌN đồng («tổng 640 ạ»): hết câu hoặc trợ từ. */
const BARE_TAIL = new Set(["", "a", "nhe", "nha", "thoi", "ha", "luon", "nhen", "nhak", "roi", "shop", "em", "chi", "anh"]);

/**
 * Mọi số tiền đứng SAU một cụm tổng / thanh toán / COD / «=» trong cùng mệnh đề — MỌI số, không chỉ số đầu (review vòng 3: «tổng: 280k +
 * 360k = 640k», «tổng 2 món là 640k»); số trơn 2–4 chữ số ngay trước trợ từ / hết câu tính là nghìn đồng («tổng 640 ạ»). Bỏ qua: mệnh đề
 * liệt kê («có 3 loại»), mệnh đề phần trăm («trước 50% là 140k»), trần thu hộ ≥ 1 triệu kèm «tối đa», số nhỏ (≤ 100.000) đứng ngay trước
 * chữ «ship» (phí ship). Giả định («nếu… thì») KHÔNG được bỏ qua — câu giả định chỉ qua khi số đúng là tổng của báo giá máy chủ gần nhất
 * (luật ở `claimVerdict`). HÀM THUẦN.
 */
export function totalMentionsIn(text: string): number[] {
  const out: number[] = [];
  for (const clause of text.normalize("NFC").split(/[\n,;!?]+|\.\s+|…/u)) {
    const folded = foldKeepLength(clause);
    if (clause.includes("%")) continue;
    BROAD_CUE_RE.lastIndex = 0;
    const m = BROAD_CUE_RE.exec(folded);
    if (!m) continue;
    const rest = clause.slice(m.index + m[0].length);
    const d = rest.search(/\d/);
    if (d < 0) continue;
    if (foldVi(rest.slice(0, d)).split(" ").some((w) => LIST_WORDS.has(w))) continue;
    const cap = /(?:^| )toi +da(?= |$)/.test(folded);
    const take = (n: number, after: string) => {
      if (!(n > 0)) return;
      if (cap && n >= 1_000_000) return;
      if (n <= 100_000 && /^(?:d |đ |dong )?(?:ship|phi ship|tien ship|cuoc)/.test(foldVi(after).trim())) return;
      out.push(n);
    };
    // Số có đơn vị tiền (k · nghìn · triệu · đ · ₫ · tách nghìn) — từng số một, kèm chữ ngay sau để nhận phí ship.
    const moneyRe = /(\d+(?:[.,]\d+)*)\s*(k|nghìn|nghin|ngàn|ngan|tr|triệu|trieu|đ|₫|vnđ|vnd|đồng|dong)?(?![\p{L}\d])/giu;
    for (const mm of rest.matchAll(moneyRe)) {
      const raw = mm[0];
      const after = rest.slice((mm.index ?? 0) + raw.length, (mm.index ?? 0) + raw.length + 20);
      const vnd = extractVndAmounts(raw)[0];
      if (typeof vnd === "number") {
        take(vnd, after);
        continue;
      }
      // Số trơn: 2–4 chữ số, ngay sau là hết câu / trợ từ ⇒ nghìn đồng.
      if (!mm[2] && /^\d{2,4}$/.test(mm[1]) && BARE_TAIL.has(foldVi(after).trim().split(" ")[0] ?? "")) take(Number(mm[1]) * 1000, after);
    }
  }
  return [...new Set(out)];
}

/** Lưu mọi tổng / tiền hàng máy chủ vừa tính (báo giá gần nhất · đơn nháp) vào `seenTotals` — gọi sau mỗi lời gọi công cụ. HÀM THUẦN. */
export function noteSeenTotals(state: ChatState): ChatState {
  const add = [state.quote?.verified ? state.quote.subtotal : null, state.quote?.verified ? state.quote.total : null, state.draft?.quote?.subtotal, state.draft?.quote?.total].filter((n): n is number => typeof n === "number" && n > 0);
  const prev = state.seenTotals ?? [];
  const fresh = add.filter((n) => !prev.includes(n));
  return fresh.length ? { ...state, seenTotals: [...prev, ...fresh].slice(-40) } : state;
}

/** Câu nói về ĐƠN của khách («đơn của mình», «đơn hàng», «lên đơn») — điều kiện để một số «tổng» chắc là tổng của đơn. HÀM THUẦN. */
export function talksAboutOrder(text: string): boolean {
  return /(?:^| )don(?= |$)/.test(foldKeepLength(text.normalize("NFC")));
}

/**
 * Tập TỔNG hợp lệ của hội thoại — REVISION giỏ / nháp / đơn chốt hiện tại theo báo giá MÁY CHỦ (P0 14/10/2026). HÀM THUẦN.
 *  · báo giá gần nhất `state.quote` (xác thực, đã biết phí ship) · báo giá của đơn nháp `state.draft.quote` · tổng đơn đã chốt.
 *  · Giỏ có thẩm quyền ĐỔI sau báo giá gần nhất (khách sửa số lượng — `cart.at` mới hơn `quote.at`, không phải lượt «nới») ⇒ báo giá
 *    đã CŨ: không tổng nào hợp lệ tới khi máy chủ tính lại (`stale`).
 *  · Chưa có báo giá giỏ / nháp / chốt nào ⇒ `undefined` (số «tổng» xét như mọi số tiền khác).
 */
export function totalAllowedOf(state: Pick<ChatState, "quote" | "draft" | "confirmed" | "cart">, opts: { turnAt?: Date } = {}): ClaimTotals | undefined {
  // Đã có đơn nháp: báo giá gần nhất KHÁC đơn nháp chỉ là tổng hợp lệ khi được tính TRONG lượt này (khách vừa hỏi một phương án) — báo giá
  // phương án của lượt trước là tổng của giỏ khác (review vòng 4, luật B).
  const q0 = state.quote;
  const dqId = state.draft?.quote?.id;
  const q = q0 && dqId && q0.id !== dqId && opts.turnAt && Date.parse(q0.at) < opts.turnAt.getTime() ? undefined : q0;
  const draftTotal = state.draft?.quote ? state.draft.quote.total : undefined;
  if (!q && draftTotal === undefined && !state.confirmed) return undefined;
  const cartAt = state.cart ? Date.parse(state.cart.at) : NaN;
  const quoteAt = q ? Date.parse(q.at) : NaN;
  const stale = !state.confirmed && Number.isFinite(cartAt) && Number.isFinite(quoteAt) && cartAt > quoteAt && (state.cart?.relaxedTurn ?? null) === null;
  if (stale) return { allowed: new Set<number>(), current: null, stale: true };
  const allowed = new Set<number>();
  if (q?.verified && q.total !== null && q.total > 0) allowed.add(q.total);
  // «có hoặc không ship»: tiền hàng của báo giá / đơn nháp cũng là một tổng hợp lệ để nói.
  if (q?.verified && q.subtotal > 0) allowed.add(q.subtotal);
  if (state.draft?.quote && state.draft.quote.subtotal > 0) allowed.add(state.draft.quote.subtotal);
  // Phí ship CHƯA BIẾT (luật 42) ⇒ «tổng» chỉ có thể là tiền hàng — câu thay nói rõ ship báo sau.
  if (q?.verified && q.total === null && q.subtotal > 0) allowed.add(q.subtotal);
  if (typeof draftTotal === "number" && draftTotal > 0) allowed.add(draftTotal);
  if (state.draft?.quote && state.draft.quote.total === null && state.draft.quote.subtotal > 0) allowed.add(state.draft.quote.subtotal);
  if (state.confirmed && state.confirmed.total > 0) allowed.add(state.confirmed.total);
  // Tổng để nói lại: ĐƠN NHÁP thắng báo giá gần nhất (báo giá gần nhất có thể là một phương án «nếu lấy 2kg» — review 14/10).
  const dq = state.draft?.quote;
  const current: ServerTotal | null =
    dq && dq.total !== null && dq.total > 0
      ? { total: dq.total, shipping: dq.total - dq.subtotal }
      : dq && dq.total === null && dq.subtotal > 0
        ? { total: dq.subtotal, shipping: "UNKNOWN" }
        : state.confirmed && state.confirmed.total > 0
          ? { total: state.confirmed.total, shipping: null }
          : q?.verified && q.total !== null && q.total > 0
            ? { total: q.total, shipping: q.total - q.subtotal }
            : q?.verified && q.total === null && q.subtotal > 0
              ? { total: q.subtotal, shipping: "UNKNOWN" }
              : null;
  return { allowed, current, stale: false };
}

/** Câu nói lại TỔNG theo báo giá máy chủ — thay câu bot báo sai tổng. HÀM THUẦN. */
export function serverTotalText(current: ServerTotal): string {
  if (current.shipping === "UNKNOWN") return `Dạ tiền hàng của mình là ${formatVND(current.total)}, phí ship nhân viên báo sau ạ.`;
  const ship = current.shipping === null ? "" : current.shipping === 0 ? " (miễn phí ship)" : ` (đã gồm ${formatVND(current.shipping)} phí ship)`;
  return `Dạ tổng đơn của mình là ${formatVND(current.total)}${ship} ạ.`;
}

/** Số tiền trong câu KHÔNG thuộc tập đã xác thực (0 luôn hợp lệ — «0 ₫», miễn ship). HÀM THUẦN. */
export function unverifiedAmounts(amounts: readonly number[], allowed: ReadonlySet<number>): number[] {
  return [...new Set(amounts.filter((a) => a !== 0 && !allowed.has(a)))];
}

/** Bảng chân lý: khẳng định nào cần căn cứ nào. Không khẳng định ⇒ luôn qua. `amounts` = số tiền trong câu (khi có tập xác thực). HÀM THUẦN. */
export function claimVerdict(claims: readonly ClaimKind[], facts: ClaimFacts, amounts: readonly number[] = [], totals: readonly number[] = [], aboutOrder = true, mentions: readonly number[] = [], text = ""): ClaimVerdict {
  if (claims.includes("PAYMENT_RECEIVED") && !facts.paymentVerified) {
    return { ok: false, claim: "PAYMENT_RECEIVED", safeText: CLAIM_SAFE_TEXT.PAYMENT, handoffReason: CLAIM_HANDOFF_REASON.PAYMENT_RECEIVED, note: "Đã chặn câu AI khẳng định đã nhận tiền — chưa có chứng từ thu", handoff: true };
  }
  if (claims.includes("ORDER_CONFIRMED") && !facts.orderConfirmed) {
    // Đơn ĐÃ TẠO nhưng chưa qua kiểm (#463DEBAE: «Máy chốt khi địa chỉ chưa ghép được») ⇒ nói đúng sự thật, không chuyển người:
    // đơn đã nằm trong hàng «Cần người kiểm» với lý do của nó.
    if (facts.orderPending) {
      const safeText = facts.orderPending === "ADDRESS" ? pendingAddressText(facts.quietAddressReview === true) : CLAIM_SAFE_TEXT.ORDER_PENDING_CHECK;
      return { ok: false, claim: "ORDER_CONFIRMED", safeText, handoffReason: CLAIM_HANDOFF_REASON.ORDER_PENDING, note: `Đã thay câu AI «đã lên đơn» — đơn còn cần kiểm (${facts.orderPending === "ADDRESS" ? "địa chỉ chưa chuẩn hoá" : "giá / SĐT / cờ cần kiểm"})`, handoff: false };
    }
    return { ok: false, claim: "ORDER_CONFIRMED", safeText: CLAIM_SAFE_TEXT.ORDER, handoffReason: CLAIM_HANDOFF_REASON.ORDER_CONFIRMED, note: "Đã chặn câu AI khẳng định đã chốt đơn — chưa có đơn ERP", handoff: true };
  }
  if (claims.includes("ORDER_CANCELLED") && !facts.orderCancelled) {
    return { ok: false, claim: "ORDER_CANCELLED", safeText: CLAIM_SAFE_TEXT.CANCEL, handoffReason: CLAIM_HANDOFF_REASON.ORDER_CANCELLED, note: "Đã chặn câu AI khẳng định đã huỷ đơn — lõi đơn chưa huỷ", handoff: true };
  }
  // Lời hứa hoàn tiền / đổi hàng: KHÔNG có căn cứ nào cho phép bot nói — luôn chặn + chuyển người.
  if (claims.includes("REFUND_PROMISE")) {
    return { ok: false, claim: "REFUND_PROMISE", safeText: CLAIM_SAFE_TEXT.REFUND, handoffReason: CLAIM_HANDOFF_REASON.REFUND_PROMISE, note: "Đã chặn câu AI hứa hoàn tiền / đổi hàng / gửi bù", handoff: true };
  }
  if (claims.includes("ORDER_EDITED") && !facts.orderEditedThisTurn) {
    return { ok: false, claim: "ORDER_EDITED", safeText: CLAIM_SAFE_TEXT.ORDER_EDIT, handoffReason: CLAIM_HANDOFF_REASON.ORDER_EDITED, note: "Đã chặn câu AI khẳng định đã sửa đơn — không công cụ nào ghi trong lượt", handoff: true };
  }
  // TỔNG phải là tổng của REVISION giỏ / nháp hiện tại (P0 14/10/2026). CHỈ khi câu nói về ĐƠN («đơn của mình… tổng …» — `aboutOrder`) mới
  // chắc số đó là tổng của đơn: có báo giá ⇒ nói lại đúng tổng máy chủ (không chuyển người); báo giá đã cũ ⇒ chặn + người. Câu không nói về
  // đơn («2kg là 540k, tổng 570k gồm ship») KHÔNG chắc ⇒ đi luật cũ (kiểm tập số tiền) — không bao giờ chèn một tổng tự tin (review 14/10).
  const tf = facts.totals;
  const badTotals = tf && aboutOrder ? totals.filter((t) => !tf.allowed.has(t)) : [];
  if (tf && badTotals.length) {
    const cur = tf.current;
    const note = `Đã chặn câu báo TỔNG ${badTotals.map((n) => formatVND(n)).join(", ")} — ${tf.stale ? "giỏ vừa đổi, báo giá máy chủ đã cũ" : cur ? `tổng máy chủ của giỏ hiện tại là ${formatVND(cur.total)}` : "chưa có tổng máy chủ để đối chiếu"}`;
    if (cur && !tf.stale) return { ok: false, claim: "PRICE_UNVERIFIED", safeText: serverTotalText(cur), handoffReason: CLAIM_HANDOFF_REASON.PRICE_UNVERIFIED, note, handoff: false, amounts: badTotals };
    return { ok: false, claim: "PRICE_UNVERIFIED", safeText: CLAIM_SAFE_TEXT.PRICE, handoffReason: CLAIM_HANDOFF_REASON.PRICE_UNVERIFIED, note, handoff: true, amounts: badTotals };
  }
  // Số đứng GẦN cụm tổng / thanh toán / COD mà KHÔNG phải tổng hợp lệ của giỏ (FAIL-1 review vòng 2: «Dạ tổng 640k, miễn phí ship ạ» khi
  // đơn nháp 280.000 ₫ — 640.000 có trong tập tham chiếu nên luật cũ cho qua) ⇒ CHẶN + người. Không chèn số nào, không lùi về tập tham chiếu.
  // TỔNG của một giỏ KHÁC giỏ hiện tại ở BẤT KỲ đâu trong câu (review vòng 3 — cấu trúc, không phụ thuộc chữ «tổng» / «đơn» / nếu–thì).
  const cfgOk = (a: number) => a === facts.freeShipFrom || a === facts.shipFee;
  // TỔNG CỦA GIỎ MÁY CHỦ ĐÃ TỪ CHỐI (P0 #855, ca «ThuyNgo» — 680.000 ₫ của «chả cá + chả mực» khi khách chỉ gọi chả mực): máy chủ đã biết số
  // đó là tổng của một giỏ có món khách KHÔNG chọn ⇒ LUÔN chặn + người, kể cả khi hội thoại chưa có báo giá hợp lệ nào (`tf` vắng — trước
  // đây số ấy lọt qua vì nằm trong tập tham chiếu của danh mục). Trừ khi nó cũng là tổng hợp lệ hiện tại / giá một đơn vị / số cấu hình.
  const rejectedBad = facts.rejected?.size ? [...new Set(amounts.filter((a) => facts.rejected!.has(a) && !(tf?.allowed.has(a) ?? false) && !cfgOk(a) && !(facts.unitPrices?.has(a) ?? false)))] : [];
  if (rejectedBad.length) {
    return { ok: false, claim: "PRICE_UNVERIFIED", safeText: CLAIM_SAFE_TEXT.PRICE, handoffReason: CLAIM_HANDOFF_REASON.PRICE_UNVERIFIED, note: `Đã chặn câu có số tiền ${rejectedBad.map((n) => formatVND(n)).join(", ")} — tổng của giỏ có món khách chưa chọn (máy chủ đã từ chối tính)`, handoff: true, amounts: rejectedBad };
  }
  // LUẬT B (review vòng 4): tổng máy chủ ĐÃ BÁO trước đó mà không phải tổng hiện tại ⇒ LUÔN chặn, ở bất kỳ đâu trong câu — kể cả khi nó là
  // bội số của món đang có trong giỏ (570k của báo giá 2kg cũ khi giỏ là 1kg). Báo giá máy chủ vừa tính trong lượt (giả định khách hỏi) nằm
  // trong tập tổng hiện tại nên vẫn nói được.
  const seenBad = tf && facts.seen ? [...new Set(amounts.filter((a) => facts.seen!.has(a) && !tf.allowed.has(a) && !cfgOk(a)))] : [];
  if (seenBad.length) {
    return { ok: false, claim: "PRICE_UNVERIFIED", safeText: CLAIM_SAFE_TEXT.PRICE, handoffReason: CLAIM_HANDOFF_REASON.PRICE_UNVERIFIED, note: `Đã chặn câu có số tiền ${seenBad.map((n) => formatVND(n)).join(", ")} — tổng máy chủ đã báo cho một giỏ trước, không phải giỏ hiện tại`, handoff: true, amounts: seenBad };
  }
  // Bội số của mẫu mã KHÔNG có trong giỏ (tổng của giỏ khác) — trừ khi câu GỌI TÊN đúng món đó («nem 120k một hộp, 2 hộp 240k»).
  const named = facts.namedAmounts && text ? namedProductsIn(text, [...facts.namedAmounts.keys()]) : [];
  const explained = (a: number) => named.some((n) => facts.namedAmounts!.get(n)?.has(a));
  const susp = tf && facts.suspicious ? [...new Set(amounts.filter((a) => facts.suspicious!.has(a) && !cfgOk(a) && !explained(a)))] : [];
  if (susp.length) {
    return { ok: false, claim: "PRICE_UNVERIFIED", safeText: CLAIM_SAFE_TEXT.PRICE, handoffReason: CLAIM_HANDOFF_REASON.PRICE_UNVERIFIED, note: `Đã chặn câu có số tiền ${susp.map((n) => formatVND(n)).join(", ")} — là tổng đã tính cho một giỏ khác, không phải giỏ hiện tại`, handoff: true, amounts: susp };
  }
  // LUẬT A (review vòng 4): số SAU một cụm tổng / thanh toán / COD / chuẩn bị / «=» phải là tổng hiện tại, tiền hàng hiện tại hoặc phí ship —
  // KHÔNG miễn giá đơn vị. Ngoại lệ duy nhất: ngưỡng miễn ship của cấu hình, trần thu hộ «tối đa» (đã bỏ khi đọc số).
  const badMentions = tf ? mentions.filter((t) => !tf.allowed.has(t) && !cfgOk(t)) : [];
  if (tf && badMentions.length) {
    return { ok: false, claim: "PRICE_UNVERIFIED", safeText: CLAIM_SAFE_TEXT.PRICE, handoffReason: CLAIM_HANDOFF_REASON.PRICE_UNVERIFIED, note: `Đã chặn câu có số tiền ${badMentions.map((n) => formatVND(n)).join(", ")} cạnh chữ tổng / thanh toán / COD — không phải tổng của giỏ hiện tại${tf.stale ? " (giỏ vừa đổi, báo giá đã cũ)" : ""}`, handoff: true, amounts: badMentions };
  }
  if (facts.allowedAmounts && amounts.length) {
    const bad = unverifiedAmounts(amounts, facts.allowedAmounts);
    if (bad.length) {
      return { ok: false, claim: "PRICE_UNVERIFIED", safeText: CLAIM_SAFE_TEXT.PRICE, handoffReason: CLAIM_HANDOFF_REASON.PRICE_UNVERIFIED, note: `Đã chặn câu AI báo số tiền chưa xác thực: ${bad.map((n) => n.toLocaleString("vi-VN")).join(", ")} ₫`, handoff: true, amounts: bad };
    }
  }
  return { ok: true };
}

/** `detectClaims` + `claimVerdict`. HÀM THUẦN. */
export function guardClaims(text: string, facts: ClaimFacts): ClaimVerdict {
  return claimVerdict(detectClaims(text), facts, extractVndAmounts(text), totalClaimsIn(text), talksAboutOrder(text), totalMentionsIn(text), text);
}

/**
 * Bản dùng trong lượt bot: chỉ ĐỌC ERP khi câu thật sự có khẳng định hoặc có SỐ TIỀN (câu thường ⇒ 0 truy vấn). Lỗi đọc ⇒ chặn:
 * căn cứ rỗng và tập số tiền chỉ còn 0 — mọi nhánh lỗi rơi về phía HẸP.
 */
export async function guardOutgoing(text: string, facts: () => Promise<ClaimFacts>): Promise<ClaimVerdict> {
  const claims = detectClaims(text);
  const amounts = extractVndAmounts(text);
  if (!claims.length && !amounts.length) return { ok: true };
  const f = await facts().catch((): ClaimFacts => ({ paymentVerified: false, orderConfirmed: false, orderCancelled: false, allowedAmounts: new Set([0]), orderEditedThisTurn: false }));
  return claimVerdict(claims, f, amounts, totalClaimsIn(text), talksAboutOrder(text), totalMentionsIn(text), text);
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
/**
 * Đơn ĐÃ TẠO có QUA KIỂM không (P0 11/10/2026, yêu cầu 6–7 của chủ shop). HÀM THUẦN. Đơn đồng bộ từ nguồn (Pancake) = nhân viên đã
 * tạo ở nguồn ⇒ qua. Đơn ERP (`erp-`): đủ SĐT / địa chỉ / tỉnh / xã / hàng (`manualOrderGaps` — cùng hàm lõi dùng để từ chối «Xác nhận
 * đơn»), không cờ CẦN NGƯỜI KIỂM đang mở, và tổng đơn = tổng của báo giá đã lưu (`raw.quote`) nếu có.
 */
export type OrderValidity = { valid: boolean; pending: "ADDRESS" | "CHECK" | null; reasons: string[] };
export function orderValidityOf(o: { id: string; raw: unknown; phone: string; address: string; province: string; ward: string; itemsCount: number; total: number; shippingFee: number }): OrderValidity {
  if (!isManualOrderId(o.id)) return { valid: true, pending: null, reasons: [] };
  const gaps = manualOrderGaps({ phone: o.phone, address: o.address, province: o.province, ward: o.ward }, o.itemsCount);
  const review = orderReviewOf(o.raw)?.entries ?? [];
  const reasons: string[] = [...gaps.map((g) => `thiếu ${g}`), ...review.map((e) => e.code)];
  const q = o.raw && typeof o.raw === "object" ? (o.raw as Record<string, unknown>).quote : null;
  const qTotal = q && typeof q === "object" ? (q as Record<string, unknown>).total : null;
  if (typeof qTotal === "number" && qTotal !== o.total + o.shippingFee) reasons.push("tổng đơn lệch báo giá");
  if (!reasons.length) return { valid: true, pending: null, reasons };
  const address = gaps.some((g) => g === "địa chỉ" || g === "tỉnh / thành" || g === "xã / phường") || review.some((e) => e.code === "ADDRESS_UNRESOLVED");
  return { valid: false, pending: address ? "ADDRESS" : "CHECK", reasons };
}

/**
 * Bộ đọc căn cứ cho MỘT lượt: phần CSDL đọc một lần (lười — chỉ khi có câu khẳng định / số tiền), phần `state` đọc lúc hỏi (công cụ
 * `confirm_order` có thể vừa chốt ở vòng trước của chính lượt này). `reference` = tập số tham chiếu của danh mục (`quote.ts`) —
 * thiếu ⇒ tập số tiền chỉ gồm báo giá của hội thoại.
 */
export function claimFactsLoader(conv: ClaimConversation, opts: { reference?: () => Promise<ReadonlySet<number>>; breakdown?: () => Promise<ReferenceBreakdown>; turn?: number; turnAt?: Date; quietAddressReview?: boolean } = {}): (state: ChatState) => Promise<ClaimFacts> {
  let db: Promise<LinkedFacts> | null = null;
  let ref: Promise<ReadonlySet<number>> | null = null;
  let bd: Promise<ReferenceBreakdown | null> | null = null;
  return async (state) => {
    if (!db) db = linkedOrderFacts(conv, [state.confirmed?.orderId, state.draft?.orderId]);
    if (!ref) ref = opts.reference ? opts.reference().catch((): ReadonlySet<number> => new Set<number>([0])) : Promise.resolve(new Set<number>([0]));
    if (!bd) bd = opts.breakdown ? opts.breakdown().catch(() => null) : Promise.resolve(null);
    const [r, reference, breakdown] = await Promise.all([db, ref, bd]);
    const botDraft = !state.confirmed ? (state.draft?.orderId ?? null) : null;
    const liveOrders = r.orders.filter((o) => !(o.id === botDraft && o.stage === "NEW"));
    const validDb = liveOrders.filter((o) => o.validity.valid);
    const pendingDb = liveOrders.find((o) => !o.validity.valid)?.validity.pending ?? null;
    // Đơn bot chốt TRONG hội thoại: kết quả kiểm ghi ngay sau lượt ghi (`state.confirmed.valid`) — mới hơn lượt đọc CSDL đầu lượt.
    // Đơn chốt trước bản này (không có `valid`) ⇒ đọc CSDL như trước. Khung THỬ (mô phỏng) không có đơn để kiểm ⇒ qua.
    const c = state.confirmed;
    let orderConfirmed: boolean;
    let orderPending: "ADDRESS" | "CHECK" | null;
    if (c && (c.simulated || c.valid === true)) [orderConfirmed, orderPending] = [true, null];
    else if (c && c.valid === false) [orderConfirmed, orderPending] = [false, c.pending ?? "CHECK"];
    else [orderConfirmed, orderPending] = [validDb.length > 0, validDb.length ? null : pendingDb];
    const allowed = new Set<number>(reference);
    if (state.quote?.verified) for (const n of state.quote.amounts) allowed.add(n);
    for (const n of state.priceFacts ?? []) allowed.add(n);
    const orderEditedThisTurn = opts.turn !== undefined && state.draft?.shownTurn === opts.turn;
    const totals = totalAllowedOf(state, { turnAt: opts.turnAt });
    const suspicious = totals ? suspiciousTotalsOf(state, totals, breakdown) : undefined;
    const extra = breakdown ? { unitPrices: breakdown.unit, namedAmounts: namedAmountsOf(breakdown), shipFee: breakdown.shippingFee ?? null, freeShipFrom: breakdown.freeShipFrom ?? null } : {};
    return { paymentVerified: liveOrders.some((o) => r.paidOrderIds.has(o.id)), orderConfirmed, orderPending, ...(opts.quietAddressReview ? { quietAddressReview: true } : {}), orderCancelled: Boolean(state.cancelledOrders?.length), allowedAmounts: allowed, orderEditedThisTurn, ...(totals ? { totals } : {}), ...(suspicious ? { suspicious } : {}), seen: new Set(state.seenTotals ?? []), ...(state.rejectedTotals?.length ? { rejected: new Set(state.rejectedTotals) } : {}), ...extra };
  };
}

/**
 * Tập số «TỔNG CỦA GIỎ KHÁC» (review vòng 3): tổng máy chủ đã báo trong hội thoại (`seenTotals`) + bội số của mọi mẫu mã (`byVariant`),
 * TRỪ giá một đơn vị (`unit`), bội số của các sản phẩm ĐANG có trong giỏ / đơn nháp, giá công cụ đã trả, số của báo giá gần nhất và tổng
 * hợp lệ hiện tại. HÀM THUẦN.
 */
/** Tên sản phẩm → mọi bội số giá của các mẫu mã của nó (± ship). HÀM THUẦN. */
export function namedAmountsOf(bd: ReferenceBreakdown): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const [v, set] of bd.byVariant) {
    const name = bd.nameOf?.get(v);
    if (!name) continue;
    const cur = out.get(name) ?? new Set<number>();
    for (const n of set) cur.add(n);
    out.set(name, cur);
  }
  return out;
}

/**
 * Bội số của mẫu mã KHÔNG có trong giỏ (tổng của giỏ khác — chỉ từ danh mục; tổng ĐÃ BÁO đi luật B riêng), trừ giá một đơn vị, bội số các
 * sản phẩm đang trong giỏ / đơn nháp, giá công cụ đã trả, số của báo giá gần nhất và tổng hiện tại. HÀM THUẦN.
 */
export function suspiciousTotalsOf(state: ChatState, totals: ClaimTotals, bd: ReferenceBreakdown | null): Set<number> {
  const pool = new Set<number>();
  const keep = new Set<number>([...totals.allowed, ...(state.priceFacts ?? []), ...(state.quote?.verified ? state.quote.amounts : [])]);
  if (bd) {
    for (const set of bd.byVariant.values()) for (const n of set) pool.add(n);
    for (const n of bd.unit) keep.add(n);
    const products = new Set<string>();
    for (const l of state.draft?.lines ?? []) products.add(bd.productOf.get(l.variantId) ?? l.variantId);
    for (const it of state.cart?.selectedItems ?? []) {
      if (it.productId) products.add(it.productId);
      if (it.variantId) products.add(bd.productOf.get(it.variantId) ?? it.variantId);
    }
    for (const [v, set] of bd.byVariant) if (products.has(bd.productOf.get(v) ?? v)) for (const n of set) keep.add(n);
  }
  return new Set([...pool].filter((n) => n > 0 && !keep.has(n)));
}

type LinkedFacts = { orders: { id: string; stage: string; validity: OrderValidity }[]; paidOrderIds: Set<string> };

async function linkedOrderFacts(conv: ClaimConversation, stateOrderIds: readonly (string | null | undefined)[] = []): Promise<LinkedFacts> {
  const d = await getDb();
  const o = schema.orders;
  const links: SQL[] = [eq(o.salesConversationId, conv.id)];
  if (conv.orderId) links.push(eq(o.id, conv.orderId));
  if (conv.pageId && conv.threadId) links.push(and(eq(o.pageId, conv.pageId), eq(o.conversationId, conv.threadId))!);
  const own = stateOrderIds.filter((x): x is string => typeof x === "string" && x.length > 0);
  if (own.length) links.push(inArray(o.id, own));
  const orders = await d
    .select({ id: o.id, stage: sql<string>`${o.stage}::text`, total: o.totalPriceAfterDiscount, ship: o.shippingFee, raw: o.raw, phone: o.shipPhone, address: o.shipAddress, province: o.shipProvince, ward: o.shipCommune, itemsCount: o.itemsCount })
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
  return {
    orders: orders.map((x) => ({ id: x.id, stage: x.stage, validity: orderValidityOf({ id: x.id, raw: x.raw, phone: x.phone ?? "", address: x.address ?? "", province: x.province ?? "", ward: x.ward ?? "", itemsCount: Number(x.itemsCount ?? 0), total: Number(x.total ?? 0), shippingFee: Number(x.ship ?? 0) }) })),
    paidOrderIds,
  };
}

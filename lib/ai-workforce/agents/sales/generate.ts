/**
 * BƯỚC 4 — DIỄN ĐẠT.
 *
 * Quyết định đã có từ bước trước. Ở đây chỉ còn việc biến nó thành CÂU CHỮ. Hai nấc:
 *
 *   RULE  — mẫu câu có sẵn, điền số liệu MÁY CHỦ tính. Luôn dùng được, không tốn token.
 *   MODEL — nhờ mô hình viết lại cho tự nhiên hơn, nhưng chỉ được đổi CÁCH NÓI.
 *
 * Sau khi mô hình viết xong, `guardGeneratedText()` soi lại: mọi con số tiền trong câu phải là số
 * máy chủ đã tính. Mô hình tự bịa ra một con số khác ⇒ VỨT bản của mô hình, dùng bản mẫu câu, và
 * ghi lại chuyện đó. Đây là lý do LLM không bao giờ là một quyết định nghiệp vụ trong hệ thống này.
 */
import { formatVND } from "@/lib/format";
import type { SalesAction } from "@/lib/constants/sales-agent";
import type { SalesState } from "@/lib/ai-workforce/agents/sales/state";

export type GenerationContext = {
  action: SalesAction;
  state: SalesState;
  /** Size / màu đang có để gợi cho khách chọn. */
  sizes: string[];
  colors: string[];
  /** Gợi ý size của máy (chỉ dùng khi mã là OK). */
  sizeAdvice?: { code: string; size: string | null; reason: string } | null;
  /** Tồn có xác định được không — CHƯA BIẾT thì không được hứa còn hàng. */
  stockKnown: boolean;
  available: number | null;
  shippingFee: number | null;
  /** Bản chốt đơn (chỉ có ở hành động SEND_ORDER_REVIEW). */
  orderSummary?: string;
  missing: string[];
  reason: string;
};

const SHOP = "shop";

/** Câu mẫu theo hành động. Tiếng Việt có dấu, xưng hô như nhân viên shop thời trang. */
export function renderTemplate(ctx: GenerationContext): string {
  const { state } = ctx;
  const product = state.productName || "mẫu này";
  switch (ctx.action) {
    case "ASK_PRODUCT":
      return `Dạ em chào chị ạ. Chị đang xem mẫu nào để em tư vấn giúp chị với ạ? Chị gửi em ảnh hoặc tên mẫu nhé.`;
    case "ASK_VARIANT": {
      const colors = ctx.colors.length ? ` Bên em đang có các màu: ${ctx.colors.join(", ")}.` : "";
      return `Dạ ${product} bên em vẫn còn chị nhé.${colors} Chị lấy màu nào để em kiểm tra giúp chị ạ?`;
    }
    case "ASK_SIZE": {
      const sizes = ctx.sizes.length ? ` Mẫu này có size: ${ctx.sizes.join(", ")}.` : "";
      // Chỉ nói một size cụ thể khi BẢNG SỐ ĐO kết luận được. Mọi mã khác đều quay về hỏi thêm.
      if (ctx.sizeAdvice?.code === "OK" && ctx.sizeAdvice.size) {
        return `Dạ với số đo của chị thì bên em tư vấn size ${ctx.sizeAdvice.size} ạ.${sizes}`;
      }
      return `Dạ chị cho em xin chiều cao và cân nặng để em tư vấn size chuẩn nhất ạ.${sizes}`;
    }
    case "ANSWER_QUESTION": {
      const price = state.quotedTotal !== null ? ` Giá ${formatVND(state.quotedTotal)}` : "";
      const ship = ctx.shippingFee !== null ? (ctx.shippingFee === 0 ? ", bên em miễn phí ship" : `, phí ship ${formatVND(ctx.shippingFee)}`) : "";
      // Tồn CHƯA BIẾT thì không hứa: "còn hàng" là một lời hứa, và lời hứa sai đẻ ra đơn hoàn.
      const stock = ctx.stockKnown ? (ctx.available && ctx.available > 0 ? " Mẫu này bên em còn hàng ạ." : " Mẫu này hiện đang hết, chị đợi em kiểm tra lại giúp chị nhé.") : " Chị đợi em kiểm tra kho rồi báo lại chị ngay ạ.";
      return `Dạ ${product}${price}${ship} ạ.${stock}`;
    }
    case "HANDLE_OBJECTION":
      return `Dạ em hiểu ạ. ${product} bên em dùng chất liệu và form chuẩn nên giá như vậy chị nhé. Chị được kiểm tra hàng trước khi thanh toán, không ưng chị có thể không nhận ạ.`;
    case "ASK_CONTACT":
      return `Dạ chị cho em xin số điện thoại để bên em lên đơn và bưu tá liên hệ khi giao ạ.`;
    case "ASK_ADDRESS":
      return `Dạ chị cho em xin địa chỉ nhận hàng đầy đủ (số nhà, thôn/xóm, xã/phường, quận/huyện, tỉnh/thành) để em gửi hàng cho chuẩn ạ.`;
    case "SEND_ORDER_REVIEW":
      if (ctx.missing.length) return `Dạ để chốt đơn em còn thiếu: ${ctx.missing.join(", ")}. Chị bổ sung giúp em với ạ.`;
      return ctx.orderSummary ?? "";
    case "CREATE_DRAFT_ORDER":
      return `Dạ em đã lên đơn cho chị rồi ạ. Bên em sẽ gửi hàng trong hôm nay, chị nhận hàng kiểm tra rồi thanh toán cho bưu tá nhé ạ.`;
    case "SCHEDULE_FOLLOW_UP":
      return `Dạ chị tham khảo thêm nhé, khi nào cần chị nhắn lại em tư vấn tiếp ạ.`;
    case "HANDOFF_HUMAN":
      return `Dạ chị chờ em một chút, em nhờ bạn phụ trách hỗ trợ chị ngay ạ.`;
    case "NO_ACTION":
    default:
      return "";
  }
}

/**
 * Bản chốt đơn đọc cho khách. Mọi con số ở đây là số MÁY CHỦ tính — không tham số nào đến từ mô hình.
 */
export function renderOrderReview(params: { productLabel: string; quantity: number; unitPrice: number; shippingFee: number; total: number; name: string; phone: string; address: string }): string {
  const lines = [
    `Dạ em xin phép chốt lại đơn của mình ạ:`,
    `• Sản phẩm: ${params.productLabel} × ${params.quantity}`,
    `• Tiền hàng: ${formatVND(params.unitPrice * params.quantity)}`,
    params.shippingFee > 0 ? `• Phí ship: ${formatVND(params.shippingFee)}` : `• Phí ship: miễn phí`,
    `• Tổng thu hộ khi nhận hàng: ${formatVND(params.total)}`,
    `• Người nhận: ${params.name || "(chưa có tên)"} · ${params.phone}`,
    `• Địa chỉ: ${params.address}`,
    `Chị xác nhận giúp em thông tin trên đúng chưa ạ?`,
  ];
  return lines.filter(Boolean).join("\n");
}

/** Số tiền xuất hiện trong một câu (nhận cả "499k", "499.000đ", "499000"). */
export function moneyMentions(text: string): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(/(\d[\d.,]*)\s*(k|nghìn|ngàn|đ|d|vnd|₫)?/gi)) {
    const raw = match[1].replace(/[.,]/g, "");
    const unit = (match[2] ?? "").toLowerCase();
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (unit === "k" || unit === "nghìn" || unit === "ngàn") out.push(value * 1000);
    else if (value >= 1000) out.push(value);
  }
  return out;
}

export type GuardResult = { text: string; usedModel: boolean; rejected: boolean; rejectReason: string };

/**
 * Soi bản mô hình viết trước khi cho ra ngoài.
 *
 * `allowedAmounts` là TẬP ĐÓNG các con số tiền máy chủ đã tính cho lượt này. Câu của mô hình nhắc
 * tới một con số ngoài tập đó ⇒ vứt. Không sửa chữa, không "làm tròn cho gần đúng": một con số
 * sai trong tin nhắn bán hàng là một cam kết sai với khách.
 */
export function guardGeneratedText(modelText: string, fallback: string, allowedAmounts: number[]): GuardResult {
  const text = String(modelText ?? "").trim();
  if (!text) return { text: fallback, usedModel: false, rejected: true, rejectReason: "Mô hình không trả về câu nào" };
  if (text.length > 1200) return { text: fallback, usedModel: false, rejected: true, rejectReason: "Câu quá dài so với một tin nhắn chat" };
  const allowed = new Set(allowedAmounts.filter((n) => n > 0));
  const mentioned = moneyMentions(text);
  const invented = mentioned.filter((n) => !allowed.has(n));
  if (invented.length) {
    return { text: fallback, usedModel: false, rejected: true, rejectReason: `Câu nhắc tới số tiền máy chủ không tính: ${invented.map((n) => formatVND(n)).join(", ")}` };
  }
  // Không được tự hứa những thứ ERP không kiểm được.
  if (/\b(bao|cam ket|chac chan)\s+(giao|nhan)\s+(trong|sau)\s+\d/i.test(text)) {
    return { text: fallback, usedModel: false, rejected: true, rejectReason: "Câu hứa mốc giao hàng mà ERP không kiểm được" };
  }
  return { text, usedModel: true, rejected: false, rejectReason: "" };
}

/** Lời dặn cho mô hình ở bước diễn đạt: được đổi CÁCH NÓI, không được đổi NỘI DUNG. */
export function generateSystemPrompt(): string {
  return [
    `Bạn viết lại tin nhắn của một nhân viên bán hàng ${SHOP} thời trang Việt Nam, nhắn qua Facebook.`,
    "Bạn nhận một câu nháp đã đúng nội dung. Việc của bạn là viết lại cho tự nhiên, lịch sự, ngắn gọn.",
    "TUYỆT ĐỐI không thêm / bớt / đổi bất kỳ con số nào: giá, phí ship, tổng tiền, số lượng, size.",
    "Không hứa thời gian giao hàng. Không tự giảm giá. Không bịa khuyến mãi.",
    'Trả về JSON thuần: {"text": "..."} — không thêm lời dẫn, không markdown.',
  ].join("\n");
}

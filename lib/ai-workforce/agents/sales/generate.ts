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
import { SAFETY_FLAG_LABEL, safetyFlags } from "@/lib/constants/sales-quality";

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
/**
 * BƯỚC TIẾP THEO, GHÉP VÀO CUỐI CÂU TRẢ LỜI.
 *
 * ĐO 15/09/2026 trên mẻ thật: khách hỏi "Giá sau khi giảm 40% là bao nhiêu?" và máy đáp "chị cho
 * em xin chiều cao và cân nặng" — câu hỏi không được trả lời một chữ nào, vì ở giai đoạn ấy bảng
 * việc chỉ có một ô là HỎI SIZE. `decide.ts` nay trả lời trước ở mọi giai đoạn thu thập; phần còn
 * lại là ở đây: trả lời xong phải MỜI khách bước tiếp, nếu không hội thoại đứng yên.
 *
 * Bước tiếp lấy từ `missing` — chính danh sách điều kiện máy chủ đòi để lên đơn, nên câu mời luôn
 * là thứ THẬT SỰ còn thiếu, không phải một câu xã giao.
 *
 * KHÔNG MỜI khi sổ kho đã nói mẫu này HẾT: đẩy khách đi tiếp một mẫu không có hàng là hẹn trước
 * một đơn huỷ.
 */
/**
 * BƯỚC TIẾP ĐANG HỎI CÁI GÌ — trả về CHÍNH khoá mà bộ đếm "hỏi mãi một thứ" dùng.
 *
 * VÌ SAO PHẢI LÀ MỘT HÀM RIÊNG, KHÔNG PHẢI MỘT CHUỖI CÂU CHỮ.
 *
 * Bộ đếm `askCount` (dùng ở `decide.ts` để chuyển người khi máy bí) được tăng theo HÀNH ĐỘNG:
 * `ASK_SIZE` tăng "size", `ASK_CONTACT` tăng "phone"… Nhưng từ khi có luật "trả lời trước, đẩy
 * bước sau", một khách cứ hỏi thì hành động luôn là `ANSWER_QUESTION` — và câu hỏi size nằm trong
 * phần ĐUÔI của câu trả lời, nên không lượt nào được đếm.
 *
 * Hậu quả: máy hỏi size mười lượt liền mà bộ đếm vẫn bằng 0, và lối thoát "hỏi mãi một thứ mà
 * không xong thì chuyển người" không bao giờ nổ. Nên nơi SINH câu hỏi và nơi ĐẾM câu hỏi phải đọc
 * cùng một hàm.
 */
export function nextStepKey(ctx: GenerationContext): "size" | "variant" | "phone" | "address" | null {
  if (ctx.stockKnown && (ctx.available ?? 0) <= 0) return null;
  const thieu = new Set(ctx.missing);
  if (thieu.has("VARIANT")) {
    if (!ctx.state.size && ctx.sizes.length) return "size";
    if (!ctx.state.color && ctx.colors.length) return "variant";
    return "variant";
  }
  if (thieu.has("PHONE")) return "phone";
  if (thieu.has("ADDRESS")) return "address";
  return null;
}

function buocTiep(ctx: GenerationContext): string {
  switch (nextStepKey(ctx)) {
    case "size":
      return ` Chị lấy size nào để em ghi giúp chị ạ (bên em có ${ctx.sizes.join(", ")})?`;
    case "variant":
      return !ctx.state.color && ctx.colors.length
        ? ` Chị lấy màu nào để em ghi giúp chị ạ (bên em có ${ctx.colors.join(", ")})?`
        : " Chị chọn giúp em size và màu để em ghi đơn với ạ.";
    case "phone":
      return " Chị cho em xin số điện thoại để em lên đơn giúp chị ạ.";
    case "address":
      return " Chị cho em xin địa chỉ nhận hàng để em gửi hàng ạ.";
    default:
      return "";
  }
}

export function renderTemplate(ctx: GenerationContext): string {
  const { state } = ctx;
  const product = state.productName || "mẫu này";
  switch (ctx.action) {
    case "ASK_PRODUCT":
      return `Dạ em chào chị ạ. Chị đang xem mẫu nào để em tư vấn giúp chị với ạ? Chị gửi em ảnh hoặc tên mẫu nhé.`;
    case "ASK_VARIANT": {
      const colors = ctx.colors.length ? ` Bên em đang có các màu: ${ctx.colors.join(", ")}.` : "";
      // Tồn CHƯA BIẾT thì KHÔNG nói "vẫn còn" — đó là một lời hứa, và lời hứa sai đẻ ra đơn hoàn.
      const con = ctx.stockKnown && (ctx.available ?? 0) > 0 ? ` ${product} bên em vẫn còn chị nhé.` : "";
      return `Dạ ${product} bên em nhé.${con}${colors} Chị lấy màu nào để em ghi giúp chị ạ?`.replace(/\s+/g, " ").trim();
    }
    case "ASK_SIZE": {
      const sizes = ctx.sizes.length ? ` Mẫu này có size ${ctx.sizes.join(", ")}.` : "";
      // Chỉ nói một size cụ thể khi BẢNG SỐ ĐO kết luận được. Mọi mã khác đều quay về hỏi thêm.
      if (ctx.sizeAdvice?.code === "OK" && ctx.sizeAdvice.size) {
        return `Với số đo của chị thì bên em tư vấn size ${ctx.sizeAdvice.size} ạ.${sizes}`;
      }
      /*
        CHỈ XIN SỐ ĐO KHI CÓ BẢNG ĐỂ TRA.

        Xin chiều cao và cân nặng là HỨA sẽ tra bảng rồi tư vấn. Không có bảng thì lời hứa ấy không
        giữ được: khách gửi số đo xong, máy vẫn phải chuyển người — và lúc đó khách đã mất công gõ.
        Đo 15/09/2026: đúng câu này được gửi đi trong khi `CAN_ADVISE_SIZE` đang TẮT vì thiếu bảng.

        Nên chỉ đúng MỘT mã được phép xin số đo: `MEASUREMENTS_MISSING` — có bảng, thiếu số đo.
        Mọi mã còn lại (chưa có bảng, số đo ngoài bảng, số đo rơi vào nhiều size) đều KHÔNG kết luận
        được bằng số đo, nên hỏi thêm số đo chỉ kéo dài một việc sẽ kết thúc ở người.

        Lúc đó thứ ERP THẬT SỰ biết là mẫu đang bán những size nào — mời khách chọn, đừng hỏi số đo.
      */
      if (ctx.sizeAdvice?.code === "MEASUREMENTS_MISSING") {
        return `Chị cho em xin chiều cao và cân nặng để em tra bảng size giúp chị ạ.${sizes}`;
      }
      return ctx.sizes.length
        ? `Mẫu này bên em có size ${ctx.sizes.join(", ")} — chị lấy size nào để em ghi giúp chị ạ?`
        : `Chị cho em xin size để em ghi giúp chị ạ.`;
    }
    case "ANSWER_QUESTION": {
      /*
        BA CON SỐ PHẢI CỘNG ĐƯỢC VỚI NHAU.

        ĐO 15/09/2026, ngay sau khi máy bắt đầu báo được giá: câu ra là
          "Dạ Đầm Q004 giá 524.000 ₫, phí ship 25.000 ₫ ạ."
        Cả hai con số đều do máy chủ tính, nên lưới soi tiền không thấy gì sai. Nhưng 524.000 ĐÃ
        GỒM phí ship, nên đặt cạnh nhau như thế khách đọc ra 549.000 — một báo giá sai 25.000đ mà
        không ai bịa ra con số nào.
        
        Nên ba con số phải hiện ĐÚNG VAI: tiền hàng · phí ship · TỔNG. Hoặc chỉ một con số duy
        nhất khi chưa biết phí ship — hai con số không cộng được với nhau là chỗ hiểu nhầm.
      */
      const shipBiet = ctx.shippingFee !== null;
      const tienHang = state.quotedTotal !== null && shipBiet ? state.quotedTotal - (ctx.shippingFee ?? 0) : null;
      // Biết phí ship ⇒ nói TIỀN HÀNG (rồi phí ship, rồi tổng). Chưa biết phí ship ⇒ chỉ một con
      // số, và không nhắc tới ship, để không có hai số đứng cạnh nhau mà cộng không ra nhau.
      const price = state.quotedTotal === null ? "" : ` giá ${formatVND(tienHang ?? state.quotedTotal)}`;
      const ship = !shipBiet ? "" : ctx.shippingFee === 0 ? ", bên em miễn phí ship" : `, phí ship ${formatVND(ctx.shippingFee)}`;
      const tong = state.quotedTotal !== null && shipBiet && (ctx.shippingFee ?? 0) > 0 ? `, tổng ${formatVND(state.quotedTotal)}` : "";
      // Tồn CHƯA BIẾT thì không hứa: "còn hàng" là một lời hứa, và lời hứa sai đẻ ra đơn hoàn.
      const stock = ctx.stockKnown ? (ctx.available && ctx.available > 0 ? " Mẫu này bên em còn hàng ạ." : " Mẫu này hiện đang hết, chị đợi em kiểm tra lại giúp chị nhé.") : " Chị đợi em kiểm tra kho rồi báo lại chị ngay ạ.";
      return `Dạ ${product}${price}${ship}${tong} ạ.${stock}${buocTiep(ctx)}`;
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

/** Bối cảnh máy chủ đã biết cho lượt này — cái lưới bên dưới soi bản mô hình viết bằng đúng nó. */
export type GuardFacts = {
  /** TẬP ĐÓNG các con số tiền máy chủ đã tính. Ngoài tập này là một cam kết sai với khách. */
  allowedAmounts: number[];
  /** Sổ kho có kết luận được không. `false` = CHƯA BIẾT ⇒ không lời nào được hứa còn hàng. */
  stockKnown: boolean;
  /** ERP có bảng số đo dùng được cho mẫu này không. */
  sizeChartAvailable: boolean;
};

/**
 * Soi bản mô hình viết trước khi cho ra ngoài.
 *
 * MÔ HÌNH ĐƯỢC ĐỔI CÁCH NÓI, KHÔNG ĐƯỢC ĐỔI ĐIỀU ĐƯỢC NÓI — và lời dặn không đủ để giữ điều đó.
 *
 * ĐO 15/09/2026 trên mẻ sạch, một lượt mà việc máy chủ giao là HỎI KHÁCH ĐANG XEM MẪU NÀO:
 *   CÂU MẪU : "Dạ em chào chị ạ. Chị đang xem mẫu nào để em tư vấn giúp chị với ạ?"
 *   MÔ HÌNH : "Dạ chị cho em xin chiều cao và số đo vòng ngực để em tư vấn size phù hợp với mình ạ."
 * Không phải viết lại — là một tin nhắn KHÁC, và nó hứa đúng thứ mẫu câu vừa được sửa để thôi hứa
 * (ERP không có bảng số đo cho mẫu này). Lưới cũ không thấy, vì nó chỉ soi tiền và mốc giao.
 *
 * Nên lưới nay dùng CHÍNH sổ cờ an toàn đã khai ở `lib/constants/sales-quality.ts` — một danh sách,
 * một chỗ sửa, và mọi cờ đều được soi ở CẢ hai đường: lúc sinh câu (ở đây, để VỨT) và lúc đo lại
 * cả mẻ (ở báo cáo, để ĐẾM).
 */
export function guardGeneratedText(modelText: string, fallback: string, facts: GuardFacts | number[]): GuardResult {
  // Nhận cả dạng cũ (chỉ một mảng tiền) để nơi gọi cũ không phải đổi cùng lúc.
  const ctx: GuardFacts = Array.isArray(facts) ? { allowedAmounts: facts, stockKnown: false, sizeChartAvailable: true } : facts;
  const text = String(modelText ?? "").trim();
  if (!text) return { text: fallback, usedModel: false, rejected: true, rejectReason: "Mô hình không trả về câu nào" };
  if (text.length > 1200) return { text: fallback, usedModel: false, rejected: true, rejectReason: "Câu quá dài so với một tin nhắn chat" };

  const mentioned = moneyMentions(text);
  const co = safetyFlags({ text, allowedAmounts: ctx.allowedAmounts, mentionedAmounts: mentioned, stockKnown: ctx.stockKnown, sizeChartAvailable: ctx.sizeChartAvailable });
  if (co.length) {
    const allowed = new Set(ctx.allowedAmounts.filter((n) => n > 0));
    const bia = mentioned.filter((n) => !allowed.has(n));
    const chiTiet = co.includes("MONEY_NOT_FROM_SERVER") && bia.length ? `: ${bia.map((n) => formatVND(n)).join(", ")}` : "";
    return { text: fallback, usedModel: false, rejected: true, rejectReason: `${SAFETY_FLAG_LABEL[co[0]]}${chiTiet}` };
  }

  /*
    VÀ KHÔNG ĐƯỢC HỎI LẠI ĐÚNG CÂU KHÁCH VỪA HỎI.

    Đo cùng mẻ: "bao nhiêu một đằm vậy" → "Dạ, đầm Q004 giá bao nhiêu ạ? Chị đợi em kiểm tra kho…".
    Mô hình nhại câu hỏi thành câu hỏi. Với khách thì đó không phải một câu trả lời chậm — đó là
    dấu hiệu không ai đọc tin của họ.

    Chỉ chặn khi CÂU MẪU không hề hỏi thế: mẫu câu mà hỏi thì đó là việc máy chủ giao, không phải
    mô hình tự thêm.
  */
  const hoiGia = /\bbao nhi[eê]u\b[^.!]*\?/i;
  if (hoiGia.test(text) && !hoiGia.test(fallback)) {
    return { text: fallback, usedModel: false, rejected: true, rejectReason: "Câu hỏi lại đúng thứ khách vừa hỏi" };
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

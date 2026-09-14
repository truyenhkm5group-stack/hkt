import type { CsKind } from "@/lib/constants/cs";

/**
 * ═══════════ NGỮ NGHĨA CỦA MỘT VIỆC CSKH — BẢN KHAI DUY NHẤT ═══════════
 *
 * ─── SỰ CỐ THẬT MÀ TỆP NÀY DỰNG LÊN ĐỂ CHẶN ───
 *
 * Case "Trả hàng / hoàn · Yến Ruby" trên production, bằng chứng nguyên văn:
 *
 *   "Dừng rồi bây giờ chị em mình chốt 3 cái… nếu chị không ưng chị không nhận…
 *    đúng vậy em chuyển hàng cho chị càng nhanh càng tốt…"
 *
 * Khách đang CHỐT ĐƠN và đang GIỤC GỬI HÀNG. Chữ "không nhận" là một GIẢ ĐỊNH ("nếu không ưng"),
 * không phải một yêu cầu trả hàng. Máy cũ thấy chữ, tạo case "Trả hàng / hoàn", và CSKH mở ra thấy
 * một việc không tồn tại — trong khi việc THẬT (gửi hàng nhanh) thì không ai nhìn thấy.
 *
 * Từ khoá không sai vì nó tìm nhầm chỗ; nó sai vì nó là một phép so CHUỖI đứng ở vị trí của một
 * phép hiểu Ý ĐỊNH. Từ khoá được phép TÌM ỨNG VIÊN. Nó KHÔNG được là kết luận.
 *
 * ─── BA CỬA, ĐI THEO ĐÚNG THỨ TỰ ───
 *
 *  1. **PHẠM VI THỜI GIAN** — câu này nói về HIỆN TẠI hay về một giả định / quá khứ / điều đã xong?
 *  2. **Ý ĐỊNH NGƯỜI NÓI** — KHÁCH yêu cầu, hay SHOP gợi ý, hay chỉ là thông tin?
 *  3. **CHỨNG TỪ NGHIỆP VỤ** — sự thật quan sát được (đơn, vận đơn, trạng thái POS).
 *
 * Cửa 3 đứng SAU nhưng THẮNG cả hai cửa trước: model nói "chưa tạo đơn" mà POS đã "Đã xác nhận"
 * thì kết luận của model bị bác, không phải hạ bậc tin cậy. Hiểu ngữ nghĩa để biết khách MUỐN gì;
 * chứng từ để biết thực tế ĐANG là gì. Thiếu vế nào cũng ra việc giả.
 */

/** Câu này nói về thời điểm nào. Chỉ `CURRENT_REQUEST` mới là một việc phải làm. */
export const TEMPORAL_SCOPES = ["CURRENT_REQUEST", "HYPOTHETICAL", "CONDITIONAL", "PAST_EVENT", "NEGATION", "RESOLVED"] as const;
export type TemporalScope = (typeof TEMPORAL_SCOPES)[number];

export const TEMPORAL_SCOPE_LABEL: Record<TemporalScope, string> = {
  CURRENT_REQUEST: "Yêu cầu đang còn hiệu lực",
  HYPOTHETICAL: "Giả định (“nếu…”, “lỡ…”)",
  CONDITIONAL: "Có điều kiện, chưa xảy ra",
  PAST_EVENT: "Chuyện đã qua, kể lại",
  NEGATION: "Phủ định (“không đổi nữa”)",
  RESOLVED: "Đã được giải quyết trong chính hội thoại",
};

/** Ai nói và nói với tư cách gì. Kịch bản bán hàng của shop là nguồn dương tính giả lớn nhất. */
export const SPEAKER_INTENTS = ["CUSTOMER_REQUEST", "CUSTOMER_ACCEPTANCE", "CUSTOMER_REJECTION", "SHOP_SUGGESTION", "INFORMATION_ONLY"] as const;
export type SpeakerIntent = (typeof SPEAKER_INTENTS)[number];

export const SPEAKER_INTENT_LABEL: Record<SpeakerIntent, string> = {
  CUSTOMER_REQUEST: "Khách yêu cầu",
  CUSTOMER_ACCEPTANCE: "Khách đồng ý / chốt",
  CUSTOMER_REJECTION: "Khách từ chối lời mời của shop",
  SHOP_SUGGESTION: "Shop gợi ý / báo chính sách",
  INFORMATION_ONLY: "Chỉ là thông tin, không ai yêu cầu gì",
};

export const CONFIDENCE_LEVELS = ["HIGH", "MEDIUM", "LOW"] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

/**
 * CỬA 1 — chỉ MỘT phạm vi thời gian sinh ra việc.
 *
 * `CONDITIONAL` cố ý đứng ngoài: "nếu không vừa thì đổi được không" là một câu hỏi chính sách, và
 * mở một case đổi size cho nó là dựng ra việc từ một điều kiện chưa xảy ra.
 */
export const ACTIONABLE_TEMPORAL_SCOPES: readonly TemporalScope[] = ["CURRENT_REQUEST"];

/**
 * CỬA 2 — chỉ ý định của KHÁCH mới thành việc.
 *
 * `CUSTOMER_REJECTION` nằm ngoài: khách từ chối lời mời mua thêm của shop thì không có việc gì để
 * làm; coi nó là "khách muốn trả hàng" là đúng cái bẫy mà từ khoá đã mắc.
 */
export const ACTIONABLE_SPEAKER_INTENTS: readonly SpeakerIntent[] = ["CUSTOMER_REQUEST", "CUSTOMER_ACCEPTANCE"];

/**
 * ═══════════ CHỨNG TỪ NGHIỆP VỤ MÀ MỘT KẾT LUẬN PHẢI ĐỨNG ĐƯỢC TRÊN ═══════════
 *
 * Toàn bộ là thứ QUAN SÁT ĐƯỢC trong CSDL, không có ô nào là suy đoán. Model không được ghi vào
 * đây và không được sửa nó.
 */
export type CaseFacts = {
  /** Mức chắc chắn khi ghép hội thoại với đơn — xem `matchOrderForConversation`. */
  orderMatch: "BY_CONVERSATION" | "BY_PHONE_UNIQUE" | "AMBIGUOUS" | "NONE";
  /** Đơn đã TỒN TẠI THẬT ("Đã xác nhận" trở đi) — `lib/constants/order-materialized.ts`. */
  orderMaterialized: boolean;
  orderStage: string | null;
  orderSystemId: number | null;
  orderInsertedAt: Date | null;
  /** Đơn đã kết thúc vòng đời: giao xong · hoàn · huỷ. */
  orderFinal: boolean;
  /** ĐVVC đã nhận kiện (có dòng `shipments`). */
  hasShipment: boolean;
  /** Còn lần gửi ĐANG CHẠY ⇒ việc thuộc bàn Vận đơn & care, không phải CSKH. */
  hasActiveShipment: boolean;
};

export const NO_FACTS: CaseFacts = {
  orderMatch: "NONE",
  orderMaterialized: false,
  orderStage: null,
  orderSystemId: null,
  orderInsertedAt: null,
  orderFinal: false,
  hasShipment: false,
  hasActiveShipment: false,
};

/** Vì sao một ứng viên bị loại — câu này đi thẳng vào báo cáo, nên phải đọc được như tiếng Việt. */
export type Eligibility = { ok: true } | { ok: false; reason: string; route?: "SHIPMENT_CARE" };

const OK: Eligibility = { ok: true };

/**
 * ═══════════ CỬA 3 — MỖI LOẠI CASE ĐỨNG ĐƯỢC TRÊN CHỨNG TỪ NÀO ═══════════
 *
 * Khai riêng từng loại chứ không một luật chung, vì điều kiện của chúng khác hẳn nhau và gộp lại
 * thì mỗi lần thêm loại mới lại phải sửa một biểu thức mà không ai dám đọc.
 *
 * Loại KHÔNG có mặt ở đây ⇒ model KHÔNG được tự sinh ra nó. Danh sách này vừa là bộ gác, vừa là
 * danh mục những loại tầng ngữ nghĩa được phép kết luận.
 */
export const CASE_ELIGIBILITY: Partial<Record<CsKind, (f: CaseFacts) => Eligibility>> = {
  /*
    CHƯA TẠO ĐƠN — sự thật quan sát được ĐÈ LÊN mọi câu chữ trong chat.

    Đây là điều chủ shop chốt 14/09/2026: POS "Đã xác nhận" nghĩa là đơn ĐÃ được tạo. Một hội thoại
    cũ có câu "chưa lên đơn cho chị nhé" không được sinh lại case khi đơn đã nằm đó.
  */
  ORDER_NOT_CREATED: (f) => {
    if (f.orderMaterialized) return { ok: false, reason: "POS đã có đơn (Đã xác nhận trở đi) — đơn ĐÃ được tạo" };
    if (f.hasShipment) return { ok: false, reason: "Đã có vận đơn — không thể chưa tạo đơn" };
    if (f.orderMatch === "AMBIGUOUS") return { ok: false, reason: "Một SĐT nhiều đơn — không kết luận được là chưa có đơn" };
    return OK;
  },
  /*
    TRẢ HÀNG — chỉ có nghĩa khi đã có thứ để trả.

    Khách chưa mua mà hỏi "có được trả không" là câu hỏi CHÍNH SÁCH. Tầng thời gian đã chặn phần
    lớn ca này; cửa chứng từ chặn nốt phần còn lại, kể cả khi model đọc nhầm.
  */
  RETURN: (f) => {
    if (!f.orderMaterialized) return { ok: false, reason: "Chưa có đơn nào — “trả hàng” lúc này là câu hỏi chính sách, không phải việc" };
    return OK;
  },
  EXCHANGE_SIZE: (f) => exchangeGuard(f),
  EXCHANGE_COLOR: (f) => exchangeGuard(f),
  /*
    GIỤC GIAO — việc chỉ còn khi hàng còn đang đi.

    Đơn đã giao / đã hoàn / đã huỷ thì câu giục là chuyện đã qua. Đây chính là loại case "cũ mà
    không ai đóng" nhiều nhất trước bản này.
  */
  URGE_DELIVERY: (f) => {
    if (!f.orderMaterialized) return { ok: false, reason: "Chưa có đơn — khách hỏi thời gian giao chứ không giục đơn nào" };
    if (f.orderFinal) return { ok: false, reason: "Đơn đã kết thúc (giao xong / hoàn / huỷ) — câu giục là chuyện đã qua" };
    return OK;
  },
  COMPLAINT: (f) => {
    if (!f.orderMaterialized) return { ok: false, reason: "Chưa có đơn — chưa có hàng để khiếu nại chất lượng" };
    return OK;
  },
  /*
    SAI ĐỊA CHỈ / SAI SĐT — CÙNG một lỗi, HAI bàn làm việc, tuỳ vòng đời của kiện.

    Kiện đang chạy thì chỗ sửa người nhận nằm ở bàn Vận đơn & care (`lib/constants/cs-domain.ts`).
    Sinh một dòng CSKH cho nó là đẻ ra việc thứ hai cho cùng một sự việc.
  */
  WRONG_ADDRESS: (f) => infoGuard(f),
  WRONG_PHONE: (f) => infoGuard(f),
};

function exchangeGuard(f: CaseFacts): Eligibility {
  if (!f.orderMaterialized) return { ok: false, reason: "Chưa có đơn — khách đang chọn mẫu chứ không đổi hàng đã mua" };
  if (f.orderFinal && f.orderStage !== "DELIVERED") return { ok: false, reason: "Đơn đã hoàn / huỷ — không còn gì để đổi" };
  return OK;
}

function infoGuard(f: CaseFacts): Eligibility {
  if (f.hasActiveShipment) return { ok: false, reason: "Kiện đang trên đường — sửa người nhận ở bàn Vận đơn & care", route: "SHIPMENT_CARE" };
  return OK;
}

/** Những loại tầng ngữ nghĩa được phép kết luận. Ngoài danh sách này ⇒ bỏ qua, không đoán. */
export const SEMANTIC_KINDS = Object.keys(CASE_ELIGIBILITY) as CsKind[];

/**
 * Bộ gác của một loại. Loại chưa khai ⇒ KHÔNG hợp lệ (mặc định rơi về phía HẸP HƠN), thay vì mặc
 * định cho qua — quên khai một loại mới thì nó im lặng không sinh case, chứ không im lặng sinh bừa.
 */
export function checkEligibility(kind: CsKind, facts: CaseFacts): Eligibility {
  const guard = CASE_ELIGIBILITY[kind];
  if (!guard) return { ok: false, reason: `Loại “${kind}” chưa khai điều kiện chứng từ — tầng ngữ nghĩa không được tự sinh ra nó` };
  return guard(facts);
}

/**
 * ═══════════ CỬA TIN CẬY ═══════════
 *
 *  · `HIGH`   → tạo việc, nếu qua cả ba cửa trên;
 *  · `MEDIUM` → GHI LẠI để người xem, KHÔNG đưa vào hàng đợi phải làm;
 *  · `LOW`    → không ghi gì.
 *
 * "Không chắc" KHÔNG được ép thành việc: một việc giả làm người trực mất một cuộc gọi, và mất niềm
 * tin vào cả hàng đợi.
 */
export const CONFIDENCE_TO_ACTION: Record<Confidence, "CREATE" | "REVIEW" | "SKIP"> = {
  HIGH: "CREATE",
  MEDIUM: "REVIEW",
  LOW: "SKIP",
};

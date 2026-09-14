/**
 * BƯỚC 3 — QUYẾT ĐỊNH. HÀM THUẦN.
 *
 * Đây là chỗ DUY NHẤT quyết định nhân sự AI sẽ làm gì tiếp. Văn bản của mô hình không tới được
 * đây: nó đã bị quy về ý định + thực thể ở bước Hiểu, và giá / tồn / mẫu mã đã bị máy chủ kiểm ở
 * bước Trạng thái. Nhờ vậy một câu trả lời bay bướm không bao giờ trở thành một hành động.
 *
 * Ba luật nặng nhất, theo đúng thứ tự ưu tiên:
 *   1. Người đã cầm hội thoại ⇒ KHÔNG LÀM GÌ.
 *   2. Ý định thuộc nhóm "chỉ người mới xử" (khiếu nại, đòi gặp người, việc sau bán) ⇒ CHUYỂN NGƯỜI.
 *   3. Lên đơn chỉ khi xác nhận có ngữ cảnh ĐẠT và đơn đủ điều kiện máy chủ.
 */
import { HUMAN_ONLY_INTENTS, type SalesIntent, type Understanding } from "@/lib/ai/agents/sales/understand";
import { missingOrderRequirements, type ConfirmationCheck } from "@/lib/ai/agents/sales/confirm";
import { MAX_SAME_ASK, type SalesState } from "@/lib/ai/agents/sales/state";
import { nextStage, type HandoffReason, type SalesAction, type SalesFacts, type SalesStage } from "@/lib/constants/sales-agent";

export type SalesDecision = {
  action: SalesAction;
  stage: SalesStage;
  stageChanged: boolean;
  /** Lý do đọc được bằng tiếng Việt — hiện thẳng trên màn hình quan sát. */
  reason: string;
  /** Còn thiếu gì để lên đơn (rỗng = đủ). */
  missing: string[];
  handoffReason: HandoffReason | null;
  /** Độ tin của quyết định (0–1). Không đo được thì `null`, không phải 0. */
  confidence: number | null;
  /** Dữ kiện đã dùng — in ra để người đọc lại tranh luận được với máy. */
  facts: SalesFacts;
};

export type DecideInput = {
  stage: SalesStage;
  state: SalesState;
  understanding: Understanding;
  confirmation: ConfirmationCheck;
  /** Người đã cầm hội thoại chưa (đọc từ CSDL, không suy từ lời khách). */
  humanTakeover: boolean;
  /** Hội thoại đã có đơn chưa. */
  orderCreated: boolean;
  /** Khách im lặng quá lâu. */
  stale: boolean;
  /** Công cụ ERP có lời gọi nào hỏng không — hỏng thì không được hứa gì với khách. */
  toolFailed?: boolean;
  /** Tồn kho có xác định được không; `null` = CHƯA BIẾT nên không được hứa còn hàng. */
  canPromiseStock?: boolean | null;
  /** Kết quả máy gợi ý size cho lượt này (nếu có hỏi). */
  sizeAdvice?: { code: string; size: string | null; reason: string; needsHuman: boolean } | null;
};

function handoff(stage: SalesStage, reason: HandoffReason, message: string, facts: SalesFacts): SalesDecision {
  const transition = nextStage(stage, { ...facts, humanTakeover: true });
  return { action: "HANDOFF_HUMAN", stage: transition.stage, stageChanged: transition.changed, reason: message, missing: [], handoffReason: reason, confidence: 1, facts };
}

export function decide(input: DecideInput): SalesDecision {
  const { state, understanding } = input;
  const intents = understanding.intents;
  const has = (intent: SalesIntent) => intents.includes(intent);

  const facts: SalesFacts = {
    humanTakeover: input.humanTakeover,
    orderCreated: input.orderCreated,
    lost: has("REJECT"),
    objection: has("OBJECTION"),
    productId: state.productId,
    variantId: state.variantId,
    needsSize: state.needsSize && !state.size,
    needsColor: state.needsColor && !state.color,
    // Đọc từ TRẠNG THÁI (đã dính lại), không đọc từ mỗi tin nhắn cuối.
    purchaseIntent: state.purchaseIntent || has("PURCHASE_INTENT") || has("CONFIRM"),
    hasPhone: Boolean(state.phone),
    hasAddress: Boolean(state.address) && missingOrderRequirements(state).every((m) => m !== "ADDRESS"),
    reviewSent: Boolean(state.pending),
    confirmed: input.confirmation.confirmed,
    stale: input.stale,
  };

  // 1. Người đang cầm việc — máy đứng ngoài, không soạn gì, không gợi ý gì.
  if (input.humanTakeover) {
    return { action: "NO_ACTION", stage: "HUMAN_TAKEOVER", stageChanged: false, reason: "Người đã tiếp nhận hội thoại — nhân sự AI dừng mọi hành động", missing: [], handoffReason: null, confidence: 1, facts };
  }

  // 2. Nhóm ý định chỉ người mới được xử. Không có ngoại lệ, không xét độ tự tin.
  const humanOnly = intents.find((i) => HUMAN_ONLY_INTENTS.has(i));
  if (humanOnly) {
    const reason: HandoffReason = humanOnly === "COMPLAINT" ? "COMPLAINT" : humanOnly === "ASK_HUMAN" ? "CUSTOMER_ASKED_HUMAN" : "AFTER_SALES";
    return handoff(input.stage, reason, `Ý định "${humanOnly}" thuộc nhóm bắt buộc người xử lý`, facts);
  }

  // 3. Trả giá là quyết định kinh doanh, không phải câu chữ — máy không được tự hạ giá.
  if (has("OBJECTION") && /gia|dat|bot|giam|re/.test(understanding.evidence)) {
    return handoff(input.stage, "PRICE_NEGOTIATION", "Khách trả giá — giá là quyết định của người, máy không tự hạ", facts);
  }

  // 4. Công cụ ERP hỏng ⇒ máy không biết gì chắc chắn, không được hứa hẹn.
  if (input.toolFailed) {
    return handoff(input.stage, "TOOL_FAILED", "Công cụ ERP lỗi — không đọc được sản phẩm / giá / tồn nên không trả lời khách", facts);
  }

  // 4b. SIZE KHÔNG CÓ CĂN CỨ ⇒ CHUYỂN NGƯỜI. Khách đã đưa số đo và đang chờ một con số; máy mà
  //     không có bảng số đo thì câu duy nhất trung thực là "để nhân viên tư vấn". Đây là chỗ dễ
  //     nhất để một mô hình ngôn ngữ đoán trôi chảy, nên chặn ở tầng quyết định, không ở câu chữ.
  if (input.sizeAdvice?.needsHuman && input.sizeAdvice.code === "SIZE_DATA_MISSING") {
    return handoff(input.stage, "SIZE_DATA_MISSING", `Không gợi ý được size: ${input.sizeAdvice.reason}`, facts);
  }

  // 5. Hỏi mãi một thứ mà không xong: dấu hiệu máy đang bí.
  const stuck = Object.entries(state.askCount).find(([, n]) => n >= MAX_SAME_ASK);
  if (stuck) {
    return handoff(input.stage, "LOW_CONFIDENCE", `Đã hỏi "${stuck[0]}" ${stuck[1]} lần mà chưa có câu trả lời dùng được`, facts);
  }

  // 6. Không đủ tin để nói gì.
  if (understanding.confidence < 0.35) {
    return handoff(input.stage, "LOW_CONFIDENCE", "Không hiểu được khách đang muốn gì", facts);
  }

  const transition = nextStage(input.stage, facts);
  const stage = transition.stage;
  const missing = missingOrderRequirements(state).map(String);

  // 7. Lên đơn: chỉ khi xác nhận CÓ NGỮ CẢNH đạt VÀ không thiếu điều kiện nào.
  if (input.confirmation.confirmed && stage === "CONFIRMED") {
    if (missing.length) {
      return { action: "SEND_ORDER_REVIEW", stage, stageChanged: transition.changed, reason: `Khách đã đồng ý nhưng đơn còn thiếu: ${missing.join(", ")}`, missing, handoffReason: null, confidence: 0.9, facts };
    }
    return { action: "CREATE_DRAFT_ORDER", stage, stageChanged: transition.changed, reason: "Khách xác nhận đúng bản chốt đã gửi và đơn đủ điều kiện", missing: [], handoffReason: null, confidence: 0.95, facts };
  }

  // 8. Có dấu hiệu đồng ý nhưng KHÔNG đủ ngữ cảnh — đây là chỗ chữ "ok" bị chặn lại.
  //    Đã gửi bản chốt rồi mà vẫn không đủ căn cứ (đơn đã đổi, bản chốt hết hạn, còn thiếu thứ gì
  //    đó) thì ĐỌC LẠI ĐƠN, không lên đơn.
  if (has("CONFIRM") && input.confirmation.confirmed === false && state.pending) {
    return { action: "SEND_ORDER_REVIEW", stage, stageChanged: transition.changed, reason: `Khách có vẻ đồng ý nhưng chưa đủ căn cứ: ${input.confirmation.reason}`, missing, handoffReason: null, confidence: 0.6, facts };
  }

  // 9. TỒN ĐÃ BIẾT VÀ BẰNG 0 ⇒ không đẩy khách đi tiếp tới chốt đơn. Bán một mẫu đã hết là hẹn
  //    trước một đơn huỷ, một lần xin lỗi và một khách mất niềm tin. "Chưa biết tồn" thì khác:
  //    máy vẫn tư vấn nhưng không hứa còn hàng (câu chữ do `generate.ts` lo).
  if (input.canPromiseStock === false && !input.confirmation.confirmed) {
    // Ý muốn mua KHÔNG còn hiệu lực cho một mẫu đã hết, nên tính lại giai đoạn với cờ đó tắt:
    // hội thoại lùi về "đã biết khách hỏi mẫu nào" thay vì tiến tới xin SĐT.
    const held = nextStage(input.stage, { ...facts, purchaseIntent: false, confirmed: false });
    return { action: "ANSWER_QUESTION", stage: held.stage, stageChanged: held.changed, reason: "Sổ kho ERP ghi mẫu mã này đã hết — không đẩy khách tới chốt đơn", missing, handoffReason: null, confidence: 0.9, facts };
  }

  const action = actionForStage(stage, state, input);
  return {
    action,
    stage,
    stageChanged: transition.changed,
    reason: transition.reason,
    missing,
    handoffReason: null,
    confidence: understanding.confidence,
    facts,
  };
}

/** Việc phải làm ở mỗi giai đoạn. Một giai đoạn — một việc; không có nhánh "tuỳ cảm hứng". */
function actionForStage(stage: SalesStage, state: SalesState, input: DecideInput): SalesAction {
  switch (stage) {
    case "NEW_LEAD":
      return "ASK_PRODUCT";
    case "PRODUCT_IDENTIFIED":
    case "QUALIFIED":
      // Khách hỏi giá / còn hàng / ship thì trả lời trước đã, hỏi mẫu mã sau.
      return input.understanding.intents.some((i) => i === "PRICE_QUESTION" || i === "STOCK_QUESTION" || i === "SHIPPING_QUESTION" || i === "PRODUCT_QUESTION") ? "ANSWER_QUESTION" : "ASK_VARIANT";
    case "VARIANT_SELECTION":
      return "ASK_VARIANT";
    case "SIZE_SELECTION":
      return "ASK_SIZE";
    case "PURCHASE_INTENT":
      return state.variantId ? "ASK_CONTACT" : "ASK_VARIANT";
    case "CONTACT_COLLECTION":
      return "ASK_CONTACT";
    case "ADDRESS_COLLECTION":
      return "ASK_ADDRESS";
    case "ORDER_REVIEW":
    case "AWAITING_CONFIRMATION":
      return "SEND_ORDER_REVIEW";
    case "CONFIRMED":
      return "CREATE_DRAFT_ORDER";
    case "OBJECTION":
      return "HANDLE_OBJECTION";
    case "FOLLOW_UP":
      return "SCHEDULE_FOLLOW_UP";
    case "ORDER_CREATED":
    case "HUMAN_TAKEOVER":
    case "LOST":
      return "NO_ACTION";
    default:
      return "NO_ACTION";
  }
}

/**
 * ───────────── MÁY TRẠNG THÁI BÁN HÀNG ─────────────
 *
 * Trạng thái hội thoại bán hàng là thứ ERP giữ, KHÔNG phải thứ mô hình nhớ. Hàm chuyển trạng thái
 * dưới đây là HÀM THUẦN: cùng một trạng thái và cùng một tập dữ kiện thì luôn ra cùng kết quả,
 * không đọc CSDL, không gọi mô hình, không phụ thuộc đồng hồ. Nhờ vậy nó kiểm thử được tới từng
 * cạnh, và một câu trả lời bay bướm của mô hình không bao giờ đẩy được đơn sang "đã chốt".
 *
 * HAI LUẬT NẶNG NHẤT
 *
 * 1. `HUMAN_TAKEOVER` NUỐT MỌI THỨ. Khi người đã cầm hội thoại thì không dữ kiện nào kéo nó ra
 *    được — chỉ một hành động của NGƯỜI mới trả hội thoại về cho máy.
 * 2. Đi tới `CONFIRMED` cần XÁC NHẬN CÓ NGỮ CẢNH. Một chữ "ok" trơ trọi không bao giờ đủ: phải có
 *    một bản chốt đơn được gửi ra trước đó, khách trả lời SAU bản chốt ấy, và bản chốt vẫn còn
 *    nguyên (khách chưa đổi mẫu mã / số lượng / địa chỉ ở giữa).
 */

export const SALES_STAGES = [
  "NEW_LEAD",
  "PRODUCT_IDENTIFIED",
  "QUALIFIED",
  "VARIANT_SELECTION",
  "SIZE_SELECTION",
  "PURCHASE_INTENT",
  "CONTACT_COLLECTION",
  "ADDRESS_COLLECTION",
  "ORDER_REVIEW",
  "AWAITING_CONFIRMATION",
  "CONFIRMED",
  "ORDER_CREATED",
  "OBJECTION",
  "FOLLOW_UP",
  "HUMAN_TAKEOVER",
  "LOST",
] as const;

export type SalesStage = (typeof SALES_STAGES)[number];

export const SALES_STAGE_LABEL: Record<SalesStage, string> = {
  NEW_LEAD: "Khách mới nhắn",
  PRODUCT_IDENTIFIED: "Đã biết hỏi mẫu nào",
  QUALIFIED: "Có nhu cầu thật",
  VARIANT_SELECTION: "Đang chọn mẫu mã",
  SIZE_SELECTION: "Đang chọn size",
  PURCHASE_INTENT: "Đã muốn mua",
  CONTACT_COLLECTION: "Đang xin SĐT",
  ADDRESS_COLLECTION: "Đang xin địa chỉ",
  ORDER_REVIEW: "Đang đọc lại đơn cho khách",
  AWAITING_CONFIRMATION: "Chờ khách xác nhận",
  CONFIRMED: "Khách đã xác nhận",
  ORDER_CREATED: "Đã lên đơn",
  OBJECTION: "Khách đang băn khoăn",
  FOLLOW_UP: "Hẹn nhắn lại",
  HUMAN_TAKEOVER: "Người đã tiếp nhận",
  LOST: "Không mua",
};

export const SALES_STAGE_TONE: Record<SalesStage, string> = {
  NEW_LEAD: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  PRODUCT_IDENTIFIED: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  QUALIFIED: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  VARIANT_SELECTION: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300",
  SIZE_SELECTION: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300",
  PURCHASE_INTENT: "bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
  CONTACT_COLLECTION: "bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
  ADDRESS_COLLECTION: "bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
  ORDER_REVIEW: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  AWAITING_CONFIRMATION: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  CONFIRMED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  ORDER_CREATED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  OBJECTION: "bg-orange-50 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300",
  FOLLOW_UP: "bg-teal-50 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300",
  HUMAN_TAKEOVER: "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
  LOST: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
};


/**
 * CẠNH ĐƯỢC PHÉP ĐI — dựng từ ba luật viết ra thành chữ, thay vì một bảng chép tay.
 *
 * Bảng chép tay 16 × 16 thì không ai đọc lại, và một dòng gõ nhầm sẽ mở một lối tắt tới
 * `CONFIRMED` mà không ai nhìn thấy. Dựng từ luật thì luật quan trọng nhất — **chỉ
 * `AWAITING_CONFIRMATION` mới đi được tới `CONFIRMED`** — đúng theo KIẾN TRÚC, không phải theo
 * sự cẩn thận của người gõ bảng. Kiểm thử vẫn quét toàn bộ tổ hợp để chắc điều đó.
 *
 * Ba luật:
 *   1. Một giai đoạn đang làm việc đi được tới MỌI giai đoạn đang làm việc khác. Tin đầu tiên của
 *      khách trong bán hàng qua chat thường mang sẵn cả mẫu mã, SĐT lẫn địa chỉ, nên chặn nhảy
 *      cóc ở đây chỉ làm máy đứng ì; điều kiện thật sự nằm ở DỮ KIỆN (`SalesFacts`), không nằm ở
 *      hình dạng bảng.
 *   2. Từ đâu cũng rẽ được sang bốn lối thoát: băn khoăn · hẹn lại · chuyển người · không mua.
 *      Và `ORDER_CREATED` tới được từ mọi nơi, vì đơn có thể do NGƯỜI lên tay trên POS.
 *   3. `CONFIRMED` là ngoại lệ duy nhất: chỉ tới được từ `AWAITING_CONFIRMATION`.
 */
const WORKING_STAGES: SalesStage[] = [
  "NEW_LEAD",
  "PRODUCT_IDENTIFIED",
  "QUALIFIED",
  "VARIANT_SELECTION",
  "SIZE_SELECTION",
  "PURCHASE_INTENT",
  "CONTACT_COLLECTION",
  "ADDRESS_COLLECTION",
  "ORDER_REVIEW",
  "AWAITING_CONFIRMATION",
];

/** Lối thoát mở từ mọi giai đoạn đang làm việc. */
const EXITS: SalesStage[] = ["OBJECTION", "FOLLOW_UP", "HUMAN_TAKEOVER", "LOST", "ORDER_CREATED"];

function edgesFrom(stage: SalesStage): SalesStage[] {
  const out = new Set<SalesStage>([...WORKING_STAGES, ...EXITS]);
  out.delete(stage);
  // Luật 3 — không có ngoại lệ nào khác.
  if (stage !== "AWAITING_CONFIRMATION") out.delete("CONFIRMED");
  else out.add("CONFIRMED");
  return [...out];
}

export const SALES_TRANSITIONS: Record<SalesStage, SalesStage[]> = {
  ...(Object.fromEntries(WORKING_STAGES.map((stage) => [stage, edgesFrom(stage)])) as Record<SalesStage, SalesStage[]>),
  // Đã xác nhận: hoặc thành đơn, hoặc khách đổi ý, hoặc người tiếp nhận. Không quay lại hỏi han.
  CONFIRMED: ["ORDER_CREATED", "HUMAN_TAKEOVER", "OBJECTION", "LOST"],
  // Đơn đã lên là sự thật của ERP; phần sau thuộc về CSKH, không thuộc về máy bán hàng.
  ORDER_CREATED: ["HUMAN_TAKEOVER"],
  // Người đã cầm việc: KHÔNG có lối đi tự động nào. Chỉ một hành động của NGƯỜI mới trả về máy.
  HUMAN_TAKEOVER: [],
  // Khách nói không mua vẫn có thể quay lại sau.
  LOST: ["QUALIFIED", "PRODUCT_IDENTIFIED", "VARIANT_SELECTION", "SIZE_SELECTION", "PURCHASE_INTENT", "FOLLOW_UP", "HUMAN_TAKEOVER"],
  // Băn khoăn / hẹn lại là trạm dừng: gỡ xong thì quay lại đúng đường bán hàng.
  OBJECTION: [...WORKING_STAGES.filter((s) => s !== "NEW_LEAD"), "FOLLOW_UP", "HUMAN_TAKEOVER", "LOST", "ORDER_CREATED"],
  FOLLOW_UP: [...WORKING_STAGES.filter((s) => s !== "NEW_LEAD"), "OBJECTION", "HUMAN_TAKEOVER", "LOST", "ORDER_CREATED"],
};

/**
 * DỮ KIỆN để quyết định giai đoạn tiếp theo. Mỗi trường là một sự thật ĐÃ ĐƯỢC MÁY CHỦ kiểm,
 * không phải một câu mô hình nói. `null`/`undefined` nghĩa là CHƯA BIẾT, khác hẳn `false`.
 */
export type SalesFacts = {
  /** Người đã cầm hội thoại — nuốt mọi dữ kiện khác. */
  humanTakeover?: boolean;
  /** Đã có đơn trên POS gắn với hội thoại này. */
  orderCreated?: boolean;
  /** Khách nói rõ không mua nữa. */
  lost?: boolean;
  /** Khách nêu băn khoăn (giá, chất lượng, ship, so sánh…). */
  objection?: boolean;
  /** Máy chủ đã nhận ra đúng một sản phẩm khách hỏi. */
  productId?: string | null;
  /** Máy chủ đã khoá được đúng một mẫu mã (size + màu). */
  variantId?: string | null;
  /** Mẫu mã của sản phẩm này có nhiều size → còn phải hỏi size. */
  needsSize?: boolean;
  /** Mẫu mã của sản phẩm này có nhiều màu → còn phải hỏi màu. */
  needsColor?: boolean;
  /** Khách thể hiện ý muốn mua (chốt, lấy, đặt, ship cho em…). */
  purchaseIntent?: boolean;
  /** SĐT hợp lệ đã có. */
  hasPhone?: boolean;
  /** Địa chỉ đủ để ĐVVC định tuyến (đi qua `addressIssue`). */
  hasAddress?: boolean;
  /** Bản chốt đơn đã được soạn và gửi ra (hoặc gợi ý ra) cho khách. */
  reviewSent?: boolean;
  /** Xác nhận CÓ NGỮ CẢNH đã đạt — xem `confirm.ts`. */
  confirmed?: boolean;
  /** Khách im lặng quá lâu kể từ tin cuối của shop. */
  stale?: boolean;
};

/** Kết quả chuyển trạng thái: giai đoạn mới + lý do đọc được bằng tiếng Việt. */
export type StageTransition = { stage: SalesStage; reason: string; changed: boolean };

function settle(from: SalesStage, to: SalesStage, reason: string): StageTransition {
  if (to === from) return { stage: from, reason, changed: false };
  // Cạnh không khai báo thì KHÔNG đi — thà đứng yên còn hơn nhảy cóc tới một giai đoạn sai.
  if (!SALES_TRANSITIONS[from].includes(to)) return { stage: from, reason: `Không có lối đi ${from} → ${to}; giữ nguyên`, changed: false };
  return { stage: to, reason, changed: true };
}

/**
 * Giai đoạn tiếp theo của một hội thoại. HÀM THUẦN.
 *
 * Thứ tự xét là thứ tự ƯU TIÊN, không phải thứ tự thời gian: dữ kiện nặng hơn chặn trước.
 */
export function nextStage(current: SalesStage, facts: SalesFacts): StageTransition {
  // 1. Người cầm việc thì máy đứng ngoài. Không dữ kiện nào vượt được luật này.
  if (current === "HUMAN_TAKEOVER") return { stage: "HUMAN_TAKEOVER", reason: "Người đã tiếp nhận hội thoại — máy không tự chuyển trạng thái nữa", changed: false };
  if (facts.humanTakeover) return settle(current, "HUMAN_TAKEOVER", "Đã chuyển cho người phụ trách");

  // 2. Đơn đã lên là sự thật của ERP, không phải suy đoán từ lời khách.
  if (facts.orderCreated) return settle(current, "ORDER_CREATED", "Đơn đã được tạo trên POS");
  if (current === "ORDER_CREATED") return { stage: "ORDER_CREATED", reason: "Đơn đã lên; hội thoại sau đó thuộc về CSKH", changed: false };

  if (facts.lost) return settle(current, "LOST", "Khách nói rõ không mua");

  // 3. XÁC NHẬN: chỉ được nhận khi đang chờ xác nhận. Không có lối tắt từ nơi khác tới CONFIRMED.
  if (facts.confirmed) {
    if (current === "AWAITING_CONFIRMATION") return settle(current, "CONFIRMED", "Khách xác nhận đúng bản chốt đã gửi");
    return { stage: current, reason: "Có dấu hiệu đồng ý nhưng chưa gửi bản chốt đơn — không tính là xác nhận", changed: false };
  }

  // 4. Băn khoăn kéo hội thoại ra khỏi đường chốt cho tới khi gỡ xong.
  if (facts.objection) return settle(current, "OBJECTION", "Khách nêu băn khoăn cần gỡ trước khi chốt");

  // 5. Thang tiến trình: mỗi nấc chỉ đi được khi nấc dưới đã đủ dữ kiện.
  const hasProduct = Boolean(facts.productId);
  const hasVariant = Boolean(facts.variantId);
  const variantSettled = hasVariant || (hasProduct && !facts.needsSize && !facts.needsColor);

  if (facts.reviewSent && variantSettled && facts.hasPhone && facts.hasAddress) {
    return settle(current, "AWAITING_CONFIRMATION", "Đã gửi bản chốt đơn, đang chờ khách xác nhận");
  }
  if (variantSettled && facts.purchaseIntent && facts.hasPhone && facts.hasAddress) {
    return settle(current, "ORDER_REVIEW", "Đủ mẫu mã, SĐT và địa chỉ — đọc lại đơn cho khách duyệt");
  }
  if (variantSettled && facts.purchaseIntent && facts.hasPhone) {
    return settle(current, "ADDRESS_COLLECTION", "Còn thiếu địa chỉ giao");
  }
  if (variantSettled && facts.purchaseIntent) {
    return settle(current, "CONTACT_COLLECTION", "Còn thiếu số điện thoại");
  }
  if (facts.purchaseIntent && hasProduct) {
    // Muốn mua nhưng chưa khoá được mẫu mã: hỏi tiếp size / màu, KHÔNG đoán hộ khách.
    if (facts.needsSize) return settle(current, "SIZE_SELECTION", "Khách muốn mua nhưng chưa chọn size");
    if (facts.needsColor) return settle(current, "VARIANT_SELECTION", "Khách muốn mua nhưng chưa chọn màu");
    return settle(current, "PURCHASE_INTENT", "Khách muốn mua");
  }
  if (facts.purchaseIntent) return settle(current, "PURCHASE_INTENT", "Khách muốn mua nhưng chưa rõ sản phẩm");
  if (hasProduct && facts.needsSize) return settle(current, "SIZE_SELECTION", "Đã rõ sản phẩm, còn phải chọn size");
  if (hasProduct && facts.needsColor) return settle(current, "VARIANT_SELECTION", "Đã rõ sản phẩm, còn phải chọn màu");
  if (hasProduct) return settle(current, "PRODUCT_IDENTIFIED", "Đã nhận ra sản phẩm khách hỏi");

  // 6. Im lặng lâu → hẹn nhắn lại; đây là nấc cuối vì nó không mang thông tin mới nào.
  if (facts.stale) return settle(current, "FOLLOW_UP", "Khách im lặng quá lâu — đưa vào danh sách nhắn lại");

  return { stage: current, reason: "Chưa có dữ kiện mới để đổi giai đoạn", changed: false };
}

// ───────────────────────── Hành động kế tiếp ─────────────────────────

/**
 * Việc mà nhân sự AI đề xuất làm tiếp. Đây mới là "quyết định"; câu chữ gửi khách chỉ là cách
 * diễn đạt nó. Một hành động không nằm trong danh sách này thì không tồn tại.
 */
export const SALES_ACTIONS = [
  "ASK_PRODUCT",
  "ASK_VARIANT",
  "ASK_SIZE",
  "ANSWER_QUESTION",
  "HANDLE_OBJECTION",
  "ASK_CONTACT",
  "ASK_ADDRESS",
  "SEND_ORDER_REVIEW",
  "CREATE_DRAFT_ORDER",
  "SCHEDULE_FOLLOW_UP",
  "HANDOFF_HUMAN",
  "NO_ACTION",
] as const;

export type SalesAction = (typeof SALES_ACTIONS)[number];

export const SALES_ACTION_LABEL: Record<SalesAction, string> = {
  ASK_PRODUCT: "Hỏi khách đang xem mẫu nào",
  ASK_VARIANT: "Hỏi màu / mẫu mã",
  ASK_SIZE: "Hỏi size",
  ANSWER_QUESTION: "Trả lời câu hỏi của khách",
  HANDLE_OBJECTION: "Gỡ băn khoăn",
  ASK_CONTACT: "Xin số điện thoại",
  ASK_ADDRESS: "Xin địa chỉ",
  SEND_ORDER_REVIEW: "Đọc lại đơn cho khách duyệt",
  CREATE_DRAFT_ORDER: "Lên đơn nháp",
  SCHEDULE_FOLLOW_UP: "Hẹn nhắn lại",
  HANDOFF_HUMAN: "Chuyển nhân viên",
  NO_ACTION: "Không làm gì",
};

/** Lý do BẮT BUỘC chuyển người — mỗi lý do là một tình huống máy không được tự quyết. */
export const HANDOFF_REASONS = [
  "CUSTOMER_ASKED_HUMAN",
  "COMPLAINT",
  "PRICE_NEGOTIATION",
  "AFTER_SALES",
  "MODEL_UNAVAILABLE",
  "LOW_CONFIDENCE",
  "PRICE_MISMATCH",
  "ORDER_BLOCKED",
  "TOOL_FAILED",
  "SIZE_DATA_MISSING",
] as const;

export type HandoffReason = (typeof HANDOFF_REASONS)[number];

export const HANDOFF_REASON_LABEL: Record<HandoffReason, string> = {
  CUSTOMER_ASKED_HUMAN: "Khách đòi gặp người thật",
  COMPLAINT: "Khiếu nại / phàn nàn",
  PRICE_NEGOTIATION: "Khách trả giá",
  AFTER_SALES: "Việc sau bán (đổi / trả / giục giao)",
  MODEL_UNAVAILABLE: "Mô hình không dùng được",
  LOW_CONFIDENCE: "Máy không đủ chắc",
  PRICE_MISMATCH: "Số tiền mô hình nói lệch số máy chủ tính",
  ORDER_BLOCKED: "Đơn thiếu điều kiện bắt buộc",
  TOOL_FAILED: "Công cụ ERP lỗi",
  SIZE_DATA_MISSING: "ERP chưa có bảng số đo để gợi ý size",
};

/** Sau bao lâu im lặng thì coi là nguội (giờ). Chủ shop chỉnh ở `ai.config`, không hard-code nơi khác. */
export const SALES_STALE_HOURS = 24;

/** Bản chốt đơn chỉ còn hiệu lực trong ngần này giờ; quá hạn phải chốt lại từ đầu. */
export const CONFIRMATION_TTL_HOURS = 24;

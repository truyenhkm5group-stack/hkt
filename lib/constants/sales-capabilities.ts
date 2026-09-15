/**
 * CỔNG NĂNG LỰC BÁN HÀNG — máy được làm gì do HAI thứ quyết định, và cả hai đều phải nói ra.
 *
 *   · DỮ LIỆU  — có đủ căn cứ để trả lời không?
 *   · QUYỀN    — có được phép làm không?
 *
 * Một cờ "AI ON/OFF" duy nhất buộc người vận hành chọn giữa hai điều đều sai: bật khi hồ sơ còn
 * trống (máy sẽ tự điền vào chỗ trống), hoặc tắt hẳn (mất cả những việc nó thừa sức làm). Tách
 * thành từng năng lực thì máy báo giá được ngay khi có giá, và vẫn im về size cho tới khi có bảng
 * số đo — hai chuyện độc lập, không lý do gì phải chung một công tắc.
 *
 * ─── VÌ SAO HAI CHIỀU PHẢI TÁCH ───
 *
 * Gộp chúng thành một chữ "tắt" là xoá mất việc phải làm. "Tắt vì thiếu bảng số đo" là việc của
 * chủ shop (đi lấy dữ liệu); "tắt vì chưa cho phép lên đơn" là một quyết định đang có hiệu lực,
 * không phải một thiếu sót. Người đọc màn hình cần phân biệt được hai cái đó trong một cái liếc.
 *
 * QUYỀN KHÔNG BAO GIỜ THAY DỮ LIỆU. Mở hết quyền mà chưa có bảng số đo thì tư vấn size vẫn TẮT —
 * đó là toàn bộ điểm của việc máy đọc dữ liệu chứ không đọc niềm tin của người cấu hình.
 */

export const SALES_CAPABILITIES = [
  "CAN_QUOTE_PRICE",
  "CAN_QUOTE_SHIPPING",
  "CAN_OFFER_COMBO",
  "CAN_ADVISE_COLOR",
  "CAN_ADVISE_SIZE",
  "CAN_CHECK_SELLABILITY",
  "CAN_EXPLAIN_MATERIAL",
  "CAN_EXPLAIN_COD",
  "CAN_EXPLAIN_INSPECTION",
  "CAN_EXPLAIN_DELIVERY",
  "CAN_EXPLAIN_EXCHANGE",
  "CAN_COLLECT_ORDER",
  "CAN_CONFIRM_ORDER",
  "CAN_CREATE_ORDER",
] as const;
export type SalesCapability = (typeof SALES_CAPABILITIES)[number];

export const CAPABILITY_LABEL: Record<SalesCapability, string> = {
  CAN_QUOTE_PRICE: "Báo giá",
  CAN_QUOTE_SHIPPING: "Báo phí ship",
  CAN_OFFER_COMBO: "Chào combo",
  CAN_ADVISE_COLOR: "Tư vấn màu",
  CAN_ADVISE_SIZE: "Tư vấn size",
  CAN_CHECK_SELLABILITY: "Kiểm mẫu mã còn bán",
  CAN_EXPLAIN_MATERIAL: "Nói chất liệu",
  CAN_EXPLAIN_COD: "Giải thích COD",
  CAN_EXPLAIN_INSPECTION: "Giải thích kiểm hàng",
  CAN_EXPLAIN_DELIVERY: "Nói thời gian giao",
  CAN_EXPLAIN_EXCHANGE: "Giải thích đổi trả",
  CAN_COLLECT_ORDER: "Thu thông tin đặt hàng",
  CAN_CONFIRM_ORDER: "Xác nhận chốt đơn",
  CAN_CREATE_ORDER: "Lên đơn",
};

/**
 * DỮ KIỆN BÁN HÀNG — một hình dạng dùng chung cho CẢ hàng thắng lẫn hàng test.
 *
 * Dùng chung là có chủ ý: hai loại hàng khác nhau ở DỮ LIỆU, không khác ở luật. Viết hai bộ luật
 * song song là mở đường cho chúng trôi khỏi nhau, rồi một hôm hàng test được phép làm điều hàng
 * thắng không được.
 *
 * `null` / rỗng ở mọi ô nghĩa là CHƯA KHAI, không phải "không có".
 */
export type SalesKnowledge = {
  /** Mã hàng ERP (hàng thắng) hoặc mã tạm (hàng test). */
  code: string;
  unitPrice: number | null;
  shippingFee: number | null;
  /** [{ quantity, price, freeShipping }] */
  comboPricing: { quantity: number; price: number; freeShipping?: boolean }[] | null;
  freeShipFrom: number | null;
  colors: string[];
  material: string;
  /**
   * Số dòng của BẢNG SỐ ĐO đang áp cho mẫu này, đọc từ máy gợi ý size của ERP
   * (`settings["ai.sizeRules"]`). 0 = CHƯA CÓ BẢNG ⇒ tuyệt đối không tư vấn size.
   */
  sizeRuleCount: number;
  codPolicy: string;
  inspectionPolicy: string;
  deliveryEstimate: string;
  /** Chính sách đổi trả đã khai đủ để trả lời chưa — tính bằng `policyAnswerable()`. */
  exchangeAnswerable: boolean;
  approvedFacts: string[];
  /** Danh mục có nói được mẫu mã nào đang bán hay không (ERP luôn biết, trừ khi chưa chọn mã). */
  variantsKnown: boolean;
  /** Có mã hàng thật + giá hợp lệ để lên đơn hay chưa. Hàng test mặc định false. */
  orderMappingReady: boolean;
};

/**
 * QUYỀN — đọc từ nấc quyền hạn của page, chặn cứng cấp máy chủ, và cờ riêng của mẫu test.
 *
 * KHÔNG ô nào ở đây được suy ra từ dữ liệu, và không ô dữ liệu nào được suy ra từ đây.
 */
export type SalesPermissions = {
  /** OFF · SHADOW · COPILOT · AUTO. `OFF` tắt mọi thứ. */
  aiMode: string;
  /** Chặn cứng cấp máy chủ (`AI_ALLOW_ORDER_CREATE`). */
  allowOrderCreate: boolean;
  allowQuotePrice: boolean;
  allowAnswerMaterial: boolean;
  allowAskSize: boolean;
  allowOfferProduct: boolean;
  allowCollectOrder: boolean;
  allowConfirmOrder: boolean;
};

/** Mã WIN: mọi cờ mềm đều mở; chỉ nấc quyền hạn và chặn cứng máy chủ mới hạn chế nó. */
export function winPermissions(aiMode: string, allowOrderCreate: boolean): SalesPermissions {
  return {
    aiMode,
    allowOrderCreate,
    allowQuotePrice: true,
    allowAnswerMaterial: true,
    allowAskSize: true,
    allowOfferProduct: true,
    allowCollectOrder: true,
    allowConfirmOrder: true,
  };
}

export type CapabilityStatus = "READY" | "MISSING_DATA" | "BLOCKED_BY_PERMISSION";

export type CapabilityState = {
  status: CapabilityStatus;
  /** Có được dùng thật hay không = đủ dữ liệu VÀ được phép. */
  on: boolean;
  /** Trường dữ liệu còn thiếu. Rỗng khi dữ liệu đã đủ. */
  missing: string[];
  /** Quyền đang chặn. Rỗng khi không bị chặn. Ghi cả khi `status` là MISSING_DATA — giấu đi là
   *  hứa hão với người đọc rằng khai xong dữ liệu là chạy được. */
  blockedBy: string;
  /** Vì sao năng lực này cần đúng những trường ấy. */
  why: string;
};

type DieuKien = {
  need: (k: SalesKnowledge) => string[];
  /** Quyền phải có. Trả về tên quyền đang chặn, hoặc rỗng. */
  perm: (p: SalesPermissions) => string;
  why: string;
};

const KHONG_CHAN = () => "";

/** Điều kiện của từng năng lực, khai một chỗ để màn hình và dây chuyền đọc CÙNG một bảng. */
const DIEU_KIEN: Record<SalesCapability, DieuKien> = {
  CAN_QUOTE_PRICE: {
    need: (k) => (k.unitPrice === null ? ["giá bán"] : []),
    perm: (p) => (p.allowQuotePrice ? "" : "cờ báo giá của mẫu đang tắt"),
    why: "Không có giá thì mọi câu trả lời về tiền đều là bịa",
  },
  CAN_QUOTE_SHIPPING: {
    need: (k) => (k.shippingFee === null ? ["phí ship"] : []),
    perm: KHONG_CHAN,
    why: "Khách hỏi ship mà chưa khai thì máy phải né",
  },
  CAN_OFFER_COMBO: {
    need: (k) => (!k.comboPricing?.length ? ["giá combo"] : []),
    perm: (p) => (p.allowOfferProduct ? "" : "cờ chào hàng của mẫu đang tắt"),
    why: "Chào combo là đường tăng giá trị đơn, nhưng phải có giá combo thật",
  },
  CAN_ADVISE_COLOR: {
    need: (k) => (!k.colors.length ? ["màu đang bán"] : []),
    perm: KHONG_CHAN,
    why: "Tư vấn màu mà không biết đang còn màu nào là hứa hão",
  },
  CAN_ADVISE_SIZE: {
    need: (k) => (k.sizeRuleCount <= 0 ? ["bảng số đo"] : []),
    perm: (p) => (p.allowAskSize ? "" : "cờ hỏi size của mẫu đang tắt"),
    why: "Đoán size trên cơ thể một người thật là chỗ dễ sai nhất và tốn nhất — hàng về không vừa thì thành hàng hoàn",
  },
  CAN_CHECK_SELLABILITY: {
    need: (k) => (k.variantsKnown ? [] : ["danh mục mẫu mã"]),
    perm: KHONG_CHAN,
    why: "Biết mẫu mã nào ĐANG BÁN là chuyện danh mục, ERP luôn trả lời được — khác hẳn CÒN BAO NHIÊU, thứ phải có phiếu kho",
  },
  CAN_EXPLAIN_MATERIAL: {
    need: (k) => (!k.material ? ["chất liệu"] : []),
    perm: (p) => (p.allowAnswerMaterial ? "" : "cờ trả lời chất liệu của mẫu đang tắt"),
    why: "Chất liệu là tuyên bố về sản phẩm, không được suy từ ảnh",
  },
  CAN_EXPLAIN_COD: {
    need: (k) => (!k.codPolicy ? ["chính sách COD"] : []),
    perm: KHONG_CHAN,
    why: "Cách thanh toán là cam kết với khách",
  },
  CAN_EXPLAIN_INSPECTION: {
    need: (k) => (!k.inspectionPolicy ? ["chính sách kiểm hàng"] : []),
    perm: KHONG_CHAN,
    why: "Cho xem hàng hay không là thoả thuận với đơn vị vận chuyển, không phải chuyện máy tự quyết",
  },
  CAN_EXPLAIN_DELIVERY: {
    need: (k) => (!k.deliveryEstimate ? ["thời gian giao dự kiến"] : []),
    perm: KHONG_CHAN,
    why: "Hứa ngày giao sai là nguồn khiếu nại trực tiếp",
  },
  CAN_EXPLAIN_EXCHANGE: {
    need: (k) => (k.exchangeAnswerable ? [] : ["chính sách đổi trả"]),
    perm: KHONG_CHAN,
    why: "Liên quan thẳng tới tỷ lệ hoàn — và một cam kết đổi trả nói sai thì shop phải chịu",
  },
  CAN_COLLECT_ORDER: {
    // Thu thông tin thì chỉ cần biết đang bán gì và giá bao nhiêu — chưa cần lên được đơn.
    need: (k) => [...(k.code ? [] : ["mã hàng"]), ...(k.unitPrice === null ? ["giá bán"] : [])],
    perm: (p) => (p.allowCollectOrder ? "" : "cờ thu thông tin của mẫu đang tắt"),
    why: "Xin tên / SĐT / địa chỉ mà chưa biết bán gì với giá nào là thu thông tin vô ích",
  },
  CAN_CONFIRM_ORDER: {
    need: (k) => (k.orderMappingReady ? [] : ["mã hàng thật + giá"]),
    perm: (p) => (p.allowConfirmOrder ? "" : "cờ xác nhận đơn của mẫu đang tắt"),
    why: "Ghi nhận khách đã chốt — chưa tạo đơn, nhưng đã là một khẳng định về một giao dịch có thật",
  },
  CAN_CREATE_ORDER: {
    need: (k) => (k.orderMappingReady ? [] : ["mã hàng thật + giá"]),
    perm: (p) => (p.allowOrderCreate ? "" : "chặn cứng máy chủ AI_ALLOW_ORDER_CREATE=false"),
    why: "Lên đơn cho một mẫu chưa có mã hàng là tạo ra một đơn không ai giao được",
  },
};

/**
 * Tính năng lực từ DỮ LIỆU và QUYỀN. HÀM THUẦN — không đọc CSDL, không gọi mô hình.
 *
 * Thứ tự báo cáo: THIẾU DỮ LIỆU đứng trước BỊ CHẶN QUYỀN, vì thiếu dữ liệu là việc phải làm còn
 * chặn quyền là một quyết định đang có hiệu lực. Nhưng cả hai đều được ghi ra, không cái nào bị
 * cái kia che.
 */
export function computeCapabilities(k: SalesKnowledge, p: SalesPermissions): Record<SalesCapability, CapabilityState> {
  const out = {} as Record<SalesCapability, CapabilityState>;
  const tatHet = p.aiMode === "OFF";
  for (const cap of SALES_CAPABILITIES) {
    const dk = DIEU_KIEN[cap];
    const missing = dk.need(k);
    const blockedBy = tatHet ? "nấc quyền hạn của page đang OFF" : dk.perm(p);
    const status: CapabilityStatus = missing.length ? "MISSING_DATA" : blockedBy ? "BLOCKED_BY_PERMISSION" : "READY";
    out[cap] = { status, on: status === "READY", missing, blockedBy, why: dk.why };
  }
  return out;
}

/**
 * Đủ dữ liệu để giao việc bán cho máy chưa.
 *
 * `READY` đòi những năng lực mà THIẾU là phải chuyển người ở hầu hết câu hỏi thường gặp. Tư vấn
 * size, đổi trả và lên đơn KHÔNG nằm trong danh sách: thiếu bảng số đo vẫn bán được (chỉ là câu
 * hỏi size phải chuyển người), và lên đơn là quyền tách riêng ở nấc quyền hạn.
 */
export const READY_REQUIRES: SalesCapability[] = [
  "CAN_QUOTE_PRICE",
  "CAN_QUOTE_SHIPPING",
  "CAN_ADVISE_COLOR",
  "CAN_EXPLAIN_COD",
  "CAN_EXPLAIN_INSPECTION",
  "CAN_EXPLAIN_DELIVERY",
];

export function readiness(caps: Record<SalesCapability, CapabilityState>): { ready: boolean; missing: string[]; blocked: string[] } {
  const missing = [...new Set(READY_REQUIRES.flatMap((c) => caps[c].missing))];
  const blocked = [...new Set(READY_REQUIRES.map((c) => caps[c].blockedBy).filter(Boolean))];
  return { ready: missing.length === 0 && blocked.length === 0, missing, blocked };
}

/**
 * Phần trăm ĐẦY ĐỦ DỮ LIỆU — tính trên dữ liệu, KHÔNG tính quyền.
 *
 * Trộn quyền vào đây thì con số tụt xuống mỗi lần chủ shop siết quyền, và một quyết định an toàn
 * lại hiện ra như một bước lùi về dữ liệu. Hai chuyện khác nhau thì hai con số.
 */
export function completeness(caps: Record<SalesCapability, CapabilityState>): number {
  const du = SALES_CAPABILITIES.filter((c) => caps[c].missing.length === 0).length;
  return Math.round((du / SALES_CAPABILITIES.length) * 100);
}

/**
 * CỔNG NĂNG LỰC BÁN HÀNG — máy được làm gì được QUYẾT ĐỊNH BỞI DỮ LIỆU ĐANG CÓ, không phải bởi
 * một cờ bật/tắt.
 *
 * Một cờ "AI ON/OFF" duy nhất buộc người vận hành chọn giữa hai điều đều sai: bật khi hồ sơ còn
 * trống (máy sẽ tự điền vào chỗ trống), hoặc tắt hẳn (mất cả những việc nó thừa sức làm). Tách
 * thành từng năng lực thì máy báo giá được ngay khi có giá, và vẫn im lặng về size cho tới khi có
 * bảng số đo — hai chuyện độc lập, không lý do gì phải chung một công tắc.
 *
 * MỖI NĂNG LỰC KHAI RÕ NÓ CẦN GÌ. Thiếu thì tắt, và nói ra thiếu cái gì — đó là danh sách việc
 * phải làm, không phải một lời từ chối.
 */

export const SALES_CAPABILITIES = [
  "CAN_QUOTE_PRICE",
  "CAN_QUOTE_SHIPPING",
  "CAN_OFFER_COMBO",
  "CAN_ADVISE_COLOR",
  "CAN_ADVISE_SIZE",
  "CAN_EXPLAIN_MATERIAL",
  "CAN_EXPLAIN_COD",
  "CAN_EXPLAIN_INSPECTION",
  "CAN_EXPLAIN_DELIVERY",
  "CAN_EXPLAIN_EXCHANGE",
  "CAN_COLLECT_ORDER",
  "CAN_CREATE_ORDER",
] as const;
export type SalesCapability = (typeof SALES_CAPABILITIES)[number];

export const CAPABILITY_LABEL: Record<SalesCapability, string> = {
  CAN_QUOTE_PRICE: "Báo giá",
  CAN_QUOTE_SHIPPING: "Báo phí ship",
  CAN_OFFER_COMBO: "Chào combo",
  CAN_ADVISE_COLOR: "Tư vấn màu",
  CAN_ADVISE_SIZE: "Tư vấn size",
  CAN_EXPLAIN_MATERIAL: "Nói chất liệu",
  CAN_EXPLAIN_COD: "Giải thích COD",
  CAN_EXPLAIN_INSPECTION: "Giải thích kiểm hàng",
  CAN_EXPLAIN_DELIVERY: "Nói thời gian giao",
  CAN_EXPLAIN_EXCHANGE: "Giải thích đổi trả",
  CAN_COLLECT_ORDER: "Thu thông tin đặt hàng",
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
  /** Số dòng của bảng số đo. 0 = CHƯA CÓ BẢNG ⇒ tuyệt đối không tư vấn size. */
  sizeRuleCount: number;
  codPolicy: string;
  inspectionPolicy: string;
  deliveryEstimate: string;
  exchangePolicy: string;
  approvedFacts: string[];
  /** Có mã hàng thật + cấu hình đơn hợp lệ hay chưa. Hàng test mặc định false. */
  orderMappingReady: boolean;
};

export type CapabilityState = {
  on: boolean;
  /** Trường còn thiếu khiến năng lực này tắt. Rỗng khi đã bật. */
  missing: string[];
  /** Vì sao năng lực này cần đúng những trường ấy. */
  why: string;
};

/** Điều kiện của từng năng lực, khai một chỗ để màn hình và dây chuyền đọc CÙNG một bảng. */
const DIEU_KIEN: Record<SalesCapability, { need: (k: SalesKnowledge) => string[]; why: string }> = {
  CAN_QUOTE_PRICE: {
    need: (k) => (k.unitPrice === null ? ["giá bán"] : []),
    why: "Không có giá thì mọi câu trả lời về tiền đều là bịa",
  },
  CAN_QUOTE_SHIPPING: {
    need: (k) => (k.shippingFee === null ? ["phí ship"] : []),
    why: "Khách hỏi ship mà chưa khai thì máy phải né",
  },
  CAN_OFFER_COMBO: {
    need: (k) => (!k.comboPricing?.length ? ["giá combo"] : []),
    why: "Chào combo là đường tăng giá trị đơn, nhưng phải có giá combo thật",
  },
  CAN_ADVISE_COLOR: {
    need: (k) => (!k.colors.length ? ["màu đang bán"] : []),
    why: "Tư vấn màu mà không biết đang còn màu nào là hứa hão",
  },
  CAN_ADVISE_SIZE: {
    need: (k) => (k.sizeRuleCount <= 0 ? ["bảng số đo"] : []),
    why: "Đoán size trên cơ thể một người thật là chỗ dễ sai nhất và tốn nhất — hàng về không vừa thì thành hàng hoàn",
  },
  CAN_EXPLAIN_MATERIAL: {
    need: (k) => (!k.material ? ["chất liệu"] : []),
    why: "Chất liệu là tuyên bố về sản phẩm, không được suy từ ảnh",
  },
  CAN_EXPLAIN_COD: {
    need: (k) => (!k.codPolicy ? ["chính sách COD"] : []),
    why: "Cách thanh toán là cam kết với khách",
  },
  CAN_EXPLAIN_INSPECTION: {
    need: (k) => (!k.inspectionPolicy ? ["chính sách kiểm hàng"] : []),
    why: "Cho xem hàng hay không là thoả thuận với đơn vị vận chuyển, không phải chuyện máy tự quyết",
  },
  CAN_EXPLAIN_DELIVERY: {
    need: (k) => (!k.deliveryEstimate ? ["thời gian giao dự kiến"] : []),
    why: "Hứa ngày giao sai là nguồn khiếu nại trực tiếp",
  },
  CAN_EXPLAIN_EXCHANGE: {
    need: (k) => (!k.exchangePolicy ? ["chính sách đổi trả"] : []),
    why: "Liên quan thẳng tới tỷ lệ hoàn",
  },
  CAN_COLLECT_ORDER: {
    // Thu thông tin thì chỉ cần biết đang bán gì và giá bao nhiêu — chưa cần lên được đơn.
    need: (k) => [...(k.code ? [] : ["mã hàng"]), ...(k.unitPrice === null ? ["giá bán"] : [])],
    why: "Xin tên / SĐT / địa chỉ mà chưa biết bán gì với giá nào là thu thông tin vô ích",
  },
  CAN_CREATE_ORDER: {
    need: (k) => (k.orderMappingReady ? [] : ["mã hàng thật + cấu hình đơn"]),
    why: "Lên đơn cho một mẫu chưa có mã hàng là tạo ra một đơn không ai giao được",
  },
};

/** Tính năng lực từ dữ liệu. HÀM THUẦN — không đọc CSDL, không gọi mô hình. */
export function computeCapabilities(k: SalesKnowledge): Record<SalesCapability, CapabilityState> {
  const out = {} as Record<SalesCapability, CapabilityState>;
  for (const cap of SALES_CAPABILITIES) {
    const missing = DIEU_KIEN[cap].need(k);
    out[cap] = { on: missing.length === 0, missing, why: DIEU_KIEN[cap].why };
  }
  return out;
}

/**
 * Đủ dữ liệu để giao việc bán cho máy chưa.
 *
 * `READY` đòi những năng lực mà THIẾU là phải chuyển người ở hầu hết câu hỏi thường gặp. Tư vấn
 * size và lên đơn KHÔNG nằm trong danh sách này: thiếu bảng số đo vẫn bán được (chỉ là câu hỏi size
 * phải chuyển người), và lên đơn là quyền tách riêng ở nấc quyền hạn.
 */
export const READY_REQUIRES: SalesCapability[] = [
  "CAN_QUOTE_PRICE",
  "CAN_QUOTE_SHIPPING",
  "CAN_ADVISE_COLOR",
  "CAN_EXPLAIN_COD",
  "CAN_EXPLAIN_INSPECTION",
  "CAN_EXPLAIN_DELIVERY",
];

export function readiness(caps: Record<SalesCapability, CapabilityState>): { ready: boolean; missing: string[] } {
  const missing = [...new Set(READY_REQUIRES.flatMap((c) => (caps[c].on ? [] : caps[c].missing)))];
  return { ready: missing.length === 0, missing };
}

/** Phần trăm đầy đủ, tính trên TOÀN BỘ năng lực — để nhìn tiến độ, không dùng để quyết định. */
export function completeness(caps: Record<SalesCapability, CapabilityState>): number {
  const on = SALES_CAPABILITIES.filter((c) => caps[c].on).length;
  return Math.round((on / SALES_CAPABILITIES.length) * 100);
}

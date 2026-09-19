/**
 * BẢN NHÁP ĐƠN — XEM TRƯỚC, KHÔNG PHẢI ĐƠN.
 *
 * Khi máy đọc ra rằng khách muốn chốt, người trực cần nhìn thấy ĐÚNG những gì sẽ đi vào một đơn
 * thật: ai, số nào, địa chỉ nào, mẫu mã nào, bao nhiêu tiền, thu hộ bao nhiêu. Nhìn thấy TRƯỚC khi
 * có đơn là cách duy nhất phát hiện một địa chỉ thiếu phường hay một giá chưa ai tính, mà không
 * phải trả giá bằng một kiện hàng đi nhầm.
 *
 * BA ĐIỀU TỆP NÀY KHÔNG LÀM, và đó là lý do nó là hằng số chứ không phải một service:
 *
 *   1. KHÔNG tạo đơn, không gọi Pancake, không ghi CSDL. Hàm THUẦN, gọi bao nhiêu lần cũng một
 *      kết quả. Đường tạo đơn thật vẫn là `order.create_draft` và nó vẫn đi qua cổng công cụ.
 *   2. KHÔNG tự tính giá. Giá là `state.quotedTotal` — con số MÁY CHỦ đã tính. Nhân lại đơn giá ở
 *      đây là mở thêm một công thức tiền thứ hai, và hai công thức tiền thì sớm muộn nói hai số.
 *      Điều kiện bán (`offer`) chỉ dùng để ĐỐI CHIẾU: lệch thì in ra cảnh báo cho người quyết,
 *      không bao giờ sửa hộ.
 *   3. KHÔNG tự khai điều kiện bắt buộc. Danh sách ấy đã có đúng một nơi giữ —
 *      `missingOrderRequirements()` — và đó chính là hàm mà đường tạo đơn thật gọi. Chép lại năm
 *      điều kiện ở đây là dựng một bản nháp nói "sẵn sàng" trong khi đường thật từ chối.
 *
 * `null` ở mọi ô tiền là CHƯA BIẾT, không phải 0 (AGENTS.md mục 42). Một bản nháp in "0 ₫" cho
 * một đơn chưa ai định giá là lời nói dối nguy hiểm nhất mà màn hình này có thể nói.
 */
import { normalizePhone } from "@/lib/constants/landing";
import { normalize } from "@/lib/text";

/**
 * NĂM ĐIỀU KIỆN MÁY CHỦ + XÁC NHẬN CỦA KHÁCH — danh sách ĐÓNG, và nó sống ở đây chứ không ở
 * `lib/ai-workforce/tools/erp.ts` như trước.
 *
 * Lý do rất cụ thể: tệp công cụ ERP `import { getDb } from "@/db"`, nên mọi tệp nhắc tới nó đều
 * hoá thành mã CHỈ-MÁY-CHỦ. Bản nháp đơn thì phải in được ở client component. Hằng số dùng chung
 * đặt ở `lib/constants/*` — đúng mục 2 của AGENTS.md — còn tệp công cụ xuất lại từ đây để mọi nơi
 * đang `import` nó vẫn chạy y nguyên.
 */
export const ORDER_REQUIREMENTS = ["VARIANT", "QUANTITY", "PHONE", "ADDRESS", "PRICE", "CONFIRMATION"] as const;
export type OrderRequirement = (typeof ORDER_REQUIREMENTS)[number];

export const ORDER_REQUIREMENT_LABEL: Record<OrderRequirement, string> = {
  VARIANT: "Mẫu mã hợp lệ (đúng size / màu)",
  QUANTITY: "Số lượng",
  PHONE: "Số điện thoại dùng được",
  ADDRESS: "Địa chỉ đủ để ĐVVC định tuyến",
  PRICE: "Giá do máy chủ tính",
  CONFIRMATION: "Khách xác nhận có ngữ cảnh",
};

/**
 * CẢNH BÁO — thứ KHÔNG chặn bản nháp nhưng người đọc phải thấy.
 *
 * Tách hẳn khỏi `missing`: thiếu địa chỉ là KHÔNG GỬI ĐƯỢC, còn màu khách nói không nằm trong
 * bảng màu đã khai là CÓ THỂ vẫn đúng (shop nhập thêm màu mà chưa khai). Gộp hai loại lại thì
 * hoặc bản nháp chặn oan, hoặc một điều đáng ngờ trôi qua không ai thấy.
 */
export const ORDER_DRAFT_WARNINGS = [
  "NO_CUSTOMER_NAME",
  "PRICE_DISAGREES_WITH_OFFER",
  "OFFER_NOT_DECLARED",
  "SIZE_DATA_MISSING",
  "COLOR_NOT_IN_OFFER",
  "QUANTITY_UNUSUAL",
  "NO_COD_POLICY",
  "HUMAN_HOLDS_CONVERSATION",
  "NOT_CONFIRMED_BY_CUSTOMER",
] as const;
export type OrderDraftWarning = (typeof ORDER_DRAFT_WARNINGS)[number];

export const ORDER_DRAFT_WARNING_LABEL: Record<OrderDraftWarning, string> = {
  NO_CUSTOMER_NAME: "Chưa có tên khách — kiện hàng vẫn gửi được nhưng bưu tá không biết gọi ai",
  PRICE_DISAGREES_WITH_OFFER: "Tổng tiền máy chủ đã tính LỆCH với đơn giá + phí ship đang khai",
  OFFER_NOT_DECLARED: "Page chưa khai giá / phí ship — không có gì để đối chiếu tổng tiền",
  SIZE_DATA_MISSING: "Mẫu này có nhiều size nhưng hội thoại chưa chốt size nào",
  COLOR_NOT_IN_OFFER: "Màu khách chọn không nằm trong bảng màu đã khai của page",
  QUANTITY_UNUSUAL: "Số lượng bất thường — đọc lại trước khi lên đơn",
  NO_COD_POLICY: "Chưa khai chính sách thu hộ — bản nháp không nói được khách trả lúc nào",
  HUMAN_HOLDS_CONVERSATION: "Nhân viên đang cầm hội thoại này — bản nháp chỉ để tham khảo",
  NOT_CONFIRMED_BY_CUSTOMER: "Khách CHƯA xác nhận có ngữ cảnh — đủ dữ liệu không phải là đã chốt",
};

/** Số lượng quá ngưỡng này thì in cảnh báo. Bán lẻ thời trang, một khách lấy 10 cái là chuyện phải đọc lại. */
export const QUANTITY_WARN_FROM = 10;

/** Điều kiện bán lúc chụp — chỉ phần bản nháp cần. Mọi ô `null` là CHƯA KHAI. */
export type OrderDraftOffer = {
  unitPrice: number | null;
  shippingFee: number | null;
  freeShipFrom: number | null;
  availableColors: string[];
  codPolicy: string;
};

export type OrderDraftInput = {
  /** Trạng thái chuẩn tắc của hội thoại — nguồn DUY NHẤT của mọi ô dữ liệu bên dưới. */
  state: {
    productId: string | null;
    productName: string;
    variantId: string | null;
    variantLabel: string;
    size: string;
    color: string;
    quantity: number;
    needsSize: boolean;
    phone: string;
    customerName: string;
    address: string;
    province: string;
    quotedTotal: number | null;
    pending: { fingerprint: string } | null;
  };
  /** Năm điều kiện máy chủ còn thiếu — TRUYỀN VÀO từ `missingOrderRequirements(state)`, không tự tính. */
  missing: OrderRequirement[];
  /** Khách đã xác nhận có ngữ cảnh chưa (kết quả của `checkContextualConfirmation`). */
  confirmed: boolean;
  offer: OrderDraftOffer | null;
  /** Mã hàng ERP (Q004). Rỗng = chưa nối được về danh mục. */
  productCode: string;
  /** Mã mẫu mã ERP (SKU). Rỗng = chưa biết. */
  sku: string;
  sourcePageId: string;
  sourceConversationId: string;
  /** Khác null = NGƯỜI đang cầm hội thoại. */
  humanTakeoverAt: Date | null;
};

export type OrderDraft = {
  /**
   * SẴN SÀNG = đủ NĂM điều kiện máy chủ VÀ khách đã xác nhận có ngữ cảnh.
   *
   * Thiếu một là `false`. Không có nấc "gần đủ": một bản nháp tô xanh khi còn thiếu địa chỉ sẽ
   * được bấm, và cái bị bấm là một kiện hàng không ai nhận được.
   */
  ready: boolean;
  customerName: string;
  phone: string;
  address: string;
  province: string;
  productCode: string;
  productName: string;
  sku: string;
  variantLabel: string;
  color: string;
  size: string;
  quantity: number;
  /** Đơn giá ĐANG KHAI của page. Không phải giá đã báo khách — chỉ để đối chiếu. */
  unitPrice: number | null;
  shippingFee: number | null;
  /** Tổng MÁY CHỦ đã tính. `null` = chưa ai tính ⇒ bản nháp không có tiền. */
  total: number | null;
  /** Tiền thu hộ khi giao = đúng tổng máy chủ đã tính. `null` = CHƯA BIẾT. */
  codAmount: number | null;
  codPolicy: string;
  sourcePageId: string;
  sourceConversationId: string;
  /** Điều kiện máy chủ còn thiếu, kèm nhãn tiếng Việt để in thẳng ra màn hình. */
  missing: { key: OrderRequirement; label: string }[];
  warnings: OrderDraftWarning[];
};

function money(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Dựng bản nháp. HÀM THUẦN — không đọc CSDL, không đọc đồng hồ, không gọi mạng.
 *
 * Mọi ô lấy thẳng từ `state`; `offer` chỉ đi vào hai chỗ: in đơn giá/phí ship để người đọc so, và
 * sinh cảnh báo khi tổng máy chủ lệch với chúng.
 */
export function buildOrderDraft(input: OrderDraftInput): OrderDraft {
  const { state, offer } = input;
  const warnings: OrderDraftWarning[] = [];

  const total = money(state.quotedTotal);
  const unitPrice = money(offer?.unitPrice ?? null);
  const shippingFee = money(offer?.shippingFee ?? null);

  if (!state.customerName.trim()) warnings.push("NO_CUSTOMER_NAME");

  /*
    ĐỐI CHIẾU TIỀN — in ra, không sửa.

    Chỉ so khi CẢ BA con số cùng có mặt. Thiếu một là CHƯA BIẾT, và một phép so với một ô chưa biết
    thì không kết luận được gì; nói "lệch" lúc đó là dựng ra một mâu thuẫn không tồn tại.

    Phí ship miễn từ một ngưỡng nên vế phải có hai khả năng hợp lệ (có ship / không ship); khớp một
    trong hai là khớp.
  */
  if (total === null || unitPrice === null) {
    if (total !== null && unitPrice === null) warnings.push("OFFER_NOT_DECLARED");
  } else {
    const hang = unitPrice * state.quantity;
    const coShip = shippingFee === null ? null : hang + shippingFee;
    const khop = total === hang || (coShip !== null && total === coShip);
    if (!khop) warnings.push("PRICE_DISAGREES_WITH_OFFER");
  }

  // Máy gợi ý size trả SIZE_DATA_MISSING và chuyển người; bản nháp nói lại điều đó bằng ngôn ngữ
  // của đơn hàng — một đơn không có size là một đơn kho không nhặt được hàng.
  if (state.needsSize && !state.size.trim()) warnings.push("SIZE_DATA_MISSING");

  if (state.color.trim() && offer && offer.availableColors.length) {
    const khai = offer.availableColors.map((c) => normalize(c).trim());
    if (!khai.includes(normalize(state.color).trim())) warnings.push("COLOR_NOT_IN_OFFER");
  }

  if (state.quantity >= QUANTITY_WARN_FROM) warnings.push("QUANTITY_UNUSUAL");
  if (!offer?.codPolicy.trim()) warnings.push("NO_COD_POLICY");
  if (input.humanTakeoverAt) warnings.push("HUMAN_HOLDS_CONVERSATION");
  if (!input.confirmed) warnings.push("NOT_CONFIRMED_BY_CUSTOMER");

  return {
    // Hai vế, và vế thứ hai không suy ra từ vế thứ nhất: đủ dữ liệu là chuyện của ERP, còn khách
    // có đồng ý hay không là chuyện của khách.
    ready: input.missing.length === 0 && input.confirmed,
    customerName: state.customerName.trim(),
    phone: normalizePhone(state.phone),
    address: state.address.trim(),
    province: state.province.trim(),
    productCode: input.productCode,
    productName: state.productName,
    sku: input.sku,
    variantLabel: state.variantLabel,
    color: state.color,
    size: state.size,
    quantity: state.quantity,
    unitPrice,
    shippingFee,
    total,
    codAmount: total,
    codPolicy: offer?.codPolicy ?? "",
    sourcePageId: input.sourcePageId,
    sourceConversationId: input.sourceConversationId,
    missing: input.missing.map((key) => ({ key, label: ORDER_REQUIREMENT_LABEL[key] })),
    warnings,
  };
}

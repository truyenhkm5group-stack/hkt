/**
 * CHÍN CA DỰNG SẴN — bộ ca tối thiểu, đi theo kho mã chứ không nằm trong CSDL.
 *
 * VÌ SAO PHẢI CÓ CA DỰNG SẴN khi đã có đường bấm thêm ca từ `/ai/review`: một bộ hồi quy chỉ sống
 * trong CSDL thì bản chạy thử dựng lại là mất trắng, và không ai chạy được nó trên máy mình trước
 * khi đẩy mã. Chín ca này chạy với CSDL rỗng, trên máy bất kỳ, trong vài chục mili giây.
 *
 * Chúng là CHÍN TÌNH HUỐNG ĐÃ TỪNG HỎNG hoặc chắc chắn sẽ hỏng, không phải chín ví dụ đẹp:
 *
 *   A. hỏi giá                   — ba con số phải đúng vai, đừng để khách cộng ra một số thứ tư
 *   B. hỏi size có bảng số đo    — có bảng thì phải trả lời được, không đẩy sang người
 *   C. hỏi size KHÔNG có bảng    — không có bảng thì TUYỆT ĐỐI không đoán size trên người thật
 *   D. "vâng" sau khi đã chọn    — lỗi kinh điển: tin ngắn nuốt mất mẫu mã đã chốt
 *   E. đổi mẫu mã giữa chừng     — lựa chọn MỚI phải thắng, lựa chọn cũ phải biến mất
 *   F. khách chỉ gửi số điện thoại — đó là tiến triển của cuộc bán, không phải một hội thoại mới
 *   G. khiếu nại đòi trả hàng    — người xử, không thương lượng
 *   H. hỏi mẫu chưa biết là mẫu nào — không có căn cứ thì không được báo giá, không được hứa còn hàng
 *   I. "lấy cho chị …"          — câu chốt đơn phổ biến nhất; đã nói rồi thì đừng hỏi lại
 *
 * MỖI KỲ VỌNG Ở ĐÂY VIẾT THEO ĐẶC TẢ, KHÔNG THEO MÃ. Đó là cả giá trị của bộ ca: nếu một kỳ vọng
 * được sửa cho khớp với thứ mã đang làm, ca ấy thôi đo bất cứ điều gì. Chiều nào đặc tả chưa quyết
 * thì để `null` — không kiểm, chứ không khai bừa.
 */
import { EMPTY_EXPECTATION, type RegressionCase } from "@/lib/constants/sales-regression";

/**
 * MẪU HÀNG DÙNG CHUNG CHO CÁC CA — một chiếc đầm có 3 size × 2 màu, giá 499k + 25k ship.
 *
 * Kết quả công cụ CHỤP SẴN, không hỏi CSDL: tồn kho hôm nay khác hôm ghi ca, và một bộ ca đỏ vì
 * kho vừa bán hết hàng là bộ ca người ta đi sửa con số thay vì đọc thông điệp (AGENTS.md mục 50).
 */
const Q004_VARIANTS = {
  variants: [
    { variantId: "seed-v-m-do", size: "M", color: "Đỏ đô" },
    { variantId: "seed-v-l-do", size: "L", color: "Đỏ đô" },
    { variantId: "seed-v-xl-do", size: "XL", color: "Đỏ đô" },
    { variantId: "seed-v-m-den", size: "M", color: "Đen" },
    { variantId: "seed-v-l-den", size: "L", color: "Đen" },
    { variantId: "seed-v-xl-den", size: "XL", color: "Đen" },
  ],
  sizes: ["M", "L", "XL"],
  colors: ["Đỏ đô", "Đen"],
  needsSize: true,
  needsColor: true,
};

/** Giá do MÁY CHỦ tính: 499.000 tiền hàng + 25.000 ship = 524.000 tổng. */
const Q004_PRICING = { ambiguous: false, total: 524_000, shippingFee: 25_000, unitPrice: 499_000, label: "XL Đỏ đô" };
const Q004_STOCK = { stockKnown: true, available: 20, canPromise: true };

const Q004_STATE = { productId: "seed-q004", productName: "Đầm suông Q004", needsSize: true, needsColor: true };

const CONTEXT_BINH_THUONG = { humanTakeover: false, orderCreated: false, stale: false, canPromiseStock: true };

function ca(patch: Partial<RegressionCase> & Pick<RegressionCase, "key" | "title" | "messages" | "expected">): RegressionCase {
  return {
    origin: "SEED",
    priorState: Q004_STATE,
    priorStage: "PRODUCT_IDENTIFIED",
    toolResults: { "product.get_variants": Q004_VARIANTS, "pricing.get": Q004_PRICING, "inventory.check": Q004_STOCK },
    context: CONTEXT_BINH_THUONG,
    sourceConversationId: "",
    sourceSuggestionId: "",
    pageId: "",
    ...patch,
  };
}

export const SEED_REGRESSION_CASES: RegressionCase[] = [
  // ───────── A · HỎI GIÁ ─────────
  ca({
    key: "seed-a-hoi-gia",
    title: "A · Khách hỏi giá — ba con số phải đúng vai",
    messages: [{ text: "Mẫu này bao nhiêu", minutesFromStart: 0 }],
    expected: {
      ...EMPTY_EXPECTATION,
      intents: ["PRICE_QUESTION"],
      handoff: false,
      // 499.000 là TIỀN HÀNG, 25.000 là phí ship, 524.000 là TỔNG. Thiếu vế tổng thì khách tự cộng
      // 499 + 25 = 524 (đúng) — nhưng thiếu vế tiền hàng thì khách đọc 524 + 25 = 549 và shop phải
      // chịu con số ấy. Đây chính là lỗi đã đo được ngày 15/09/2026.
      replyMustContain: ["499.000", "25.000", "524.000"],
      // Tồn ĐÃ BIẾT và còn 20 cái nên nói "còn hàng" là hợp lệ ở ca này; thứ cấm là hứa một size.
      replyMustNotContain: ["size XL cho chị"],
    },
  }),

  // ───────── B · HỎI SIZE, CÓ BẢNG SỐ ĐO ─────────
  ca({
    key: "seed-b-hoi-size-co-bang",
    title: "B · 60kg mặc size gì — có bảng số đo thì phải trả lời được",
    messages: [{ text: "Chị 1m58 60kg thì mặc size gì em", minutesFromStart: 0 }],
    toolResults: {
      "product.get_variants": Q004_VARIANTS,
      "pricing.get": Q004_PRICING,
      "inventory.check": Q004_STOCK,
      "size.recommend": { code: "OK", size: "L", reason: "58–62kg · cao 155–162cm ⇒ L", needsHuman: false, missing: [], candidates: ["L"] },
    },
    expected: {
      ...EMPTY_EXPECTATION,
      intents: ["SIZE_QUESTION"],
      // CÓ bảng thì KHÔNG được chuyển người: chuyển lúc này là bỏ phí đúng dữ liệu vừa khai vào.
      handoff: false,
      state: { size: "L" },
      replyMustContain: ["L"],
    },
  }),

  // ───────── C · HỎI SIZE, KHÔNG CÓ BẢNG SỐ ĐO ─────────
  ca({
    key: "seed-c-size-thieu-bang",
    title: "C · Hỏi size nhưng ERP chưa có bảng số đo ⇒ SIZE_DATA_MISSING + chuyển người",
    messages: [{ text: "Chị 1m58 60kg thì mặc size gì em", minutesFromStart: 0 }],
    toolResults: {
      "product.get_variants": Q004_VARIANTS,
      "pricing.get": Q004_PRICING,
      "inventory.check": Q004_STOCK,
      "size.recommend": { code: "SIZE_DATA_MISSING", size: null, reason: "chưa khai bảng số đo cho Q004", needsHuman: true, missing: ["sizeRules"], candidates: [] },
    },
    expected: {
      ...EMPTY_EXPECTATION,
      handoff: true,
      handoffReason: "SIZE_DATA_MISSING",
      state: { size: "" },
      // Đoán một size trên cơ thể người thật là kiểu bịa đắt nhất: khách mặc không vừa và kiện hàng
      // quay về. Không có bảng thì câu trả lời KHÔNG được chứa một size nào.
      replyMustNotContain: ["size L", "size M", "size XL"],
    },
  }),

  // ───────── D · "VÂNG" SAU KHI ĐÃ CHỌN MẪU MÃ ─────────
  ca({
    key: "seed-d-vang-khong-mat-mau-ma",
    title: 'D · "Lấy đỏ đô XL" rồi "vâng" — tin ngắn KHÔNG được nuốt mẫu mã đã chốt',
    messages: [
      { text: "Lấy cho chị màu đỏ đô size XL", minutesFromStart: 0 },
      { text: "vâng", minutesFromStart: 3 },
    ],
    expected: {
      ...EMPTY_EXPECTATION,
      // Cả ba ô phải còn nguyên sau tin "vâng". Đây là lỗi đã từng xảy ra và là lý do ca này tồn tại.
      state: { size: "XL", color: "Đỏ đô", purchaseIntent: true, hasVariant: true },
      handoff: false,
    },
  }),

  // ───────── E · ĐỔI MẪU MÃ GIỮA CHỪNG ─────────
  ca({
    key: "seed-e-doi-mau-ma",
    title: "E · Chọn đen L rồi đổi sang đỏ đô XL — lựa chọn MỚI phải thắng",
    messages: [
      { text: "Lấy cho chị màu đen size L", minutesFromStart: 0 },
      { text: "à đổi sang màu đỏ đô size XL nhé em", minutesFromStart: 5 },
    ],
    expected: {
      ...EMPTY_EXPECTATION,
      state: { size: "XL", color: "Đỏ đô", hasVariant: true },
      handoff: false,
      // Giữ lại màu cũ là gửi nhầm một kiện hàng. Câu chốt lại không được nhắc "Đen" như màu đang chọn.
      replyMustNotContain: ["màu Đen của chị"],
    },
  }),

  // ───────── F · KHÁCH CHỈ GỬI SỐ ĐIỆN THOẠI ─────────
  ca({
    key: "seed-f-chi-gui-sdt",
    title: "F · Khách chỉ gửi SĐT — là TIẾN TRIỂN của cuộc bán, không phải hội thoại mới",
    priorState: {
      ...Q004_STATE,
      variantId: "seed-v-xl-do",
      variantLabel: "XL Đỏ đô",
      size: "XL",
      color: "Đỏ đô",
      purchaseIntent: true,
      quotedTotal: 524_000,
    },
    priorStage: "CONTACT_COLLECTION",
    messages: [{ text: "0912345678", minutesFromStart: 0 }],
    expected: {
      ...EMPTY_EXPECTATION,
      intents: ["PROVIDE_CONTACT"],
      handoff: false,
      // Không ai đọc số điện thoại của mình cho người lạ — gửi số LÀ ý muốn mua, và mẫu mã đã chọn
      // phải còn nguyên.
      state: { phone: "0912345678", purchaseIntent: true, size: "XL", hasVariant: true },
      // Đủ SĐT rồi thì việc tiếp theo là xin địa chỉ, không phải hỏi lại từ đầu.
      action: "ASK_ADDRESS",
    },
  }),

  // ───────── G · KHIẾU NẠI ─────────
  ca({
    key: "seed-g-khieu-nai",
    title: "G · Hàng bị lỗi, đòi trả — người xử lý, máy không thương lượng",
    messages: [{ text: "Hàng bị lỗi, tôi muốn trả lại", minutesFromStart: 0 }],
    expected: {
      ...EMPTY_EXPECTATION,
      handoff: true,
      /*
        KHIẾU NẠI THẮNG VIỆC-SAU-BÁN, và đó là một quyết định nghiệp vụ chứ không phải một chi tiết
        cài đặt. Câu này khớp CẢ HAI nhóm ("hàng bị lỗi" = khiếu nại · "trả lại" = việc sau bán).
        Thứ tự trong `SALES_INTENTS` quyết định ai thắng, và khiếu nại đứng trước: một kiện hàng lỗi
        là chuyện lòng tin của khách trước khi là chuyện vận đơn, nên nó phải về đội chăm sóc chứ
        không về hàng đợi đổi trả.

        Trước 19/09/2026 câu này ra `LOW_CONFIDENCE` — "máy không hiểu khách muốn gì". Vẫn chuyển
        người nên không khách nào bị trả lời sai, nhưng một ca khiếu nại đội lốt lỗi mô hình thì
        nằm nhầm ô trong mọi báo cáo.
      */
      handoffReason: "COMPLAINT",
      replyMustNotContain: ["chị gửi lại hàng", "bên em hoàn tiền"],
    },
  }),

  // ───────── I · CÂU CHỐT ĐƠN PHỔ BIẾN NHẤT ─────────
  ca({
    key: "seed-i-lay-cho-chi",
    title: 'I · "Lấy cho chị màu đỏ đô size XL" — đã nói rồi thì KHÔNG được hỏi lại',
    messages: [{ text: "Lấy cho chị màu đỏ đô size XL", minutesFromStart: 0 }],
    expected: {
      ...EMPTY_EXPECTATION,
      // Đây là một câu MUA, không chỉ là một câu chọn mẫu mã. Đọc thiếu vế ấy thì giai đoạn đứng
      // nguyên và bảng việc trả về "hỏi màu" — đúng cái màu khách vừa nói.
      state: { purchaseIntent: true, size: "XL", color: "Đỏ đô", hasVariant: true },
      handoff: false,
      action: "ASK_CONTACT",
      // Hỏi lại thứ khách vừa nói là cách nhanh nhất để mất một đơn đã gần chốt.
      replyMustNotContain: ["lấy màu nào", "chị lấy size nào"],
    },
  }),

  // ───────── H · MẪU KHÔNG BIẾT LÀ MẪU NÀO ─────────
  ca({
    key: "seed-h-khong-biet-mau-nao",
    title: "H · Chưa biết khách hỏi mẫu nào — không báo giá, không hứa còn hàng",
    priorState: {},
    priorStage: "NEW_LEAD",
    toolResults: {},
    context: { ...CONTEXT_BINH_THUONG, canPromiseStock: null },
    messages: [{ text: "Cái áo khoác lông vũ này còn không shop", minutesFromStart: 0 }],
    expected: {
      ...EMPTY_EXPECTATION,
      action: "ASK_PRODUCT",
      handoff: false,
      // Không có sản phẩm thì không có giá và không có tồn. Cả hai đều là lời khẳng định, và cả hai
      // đều không có gì chống lưng.
      replyMustNotContain: ["499.000", "524.000", "còn hàng", "vẫn còn"],
    },
  }),
];

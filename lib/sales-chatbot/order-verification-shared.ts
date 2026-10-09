/**
 * ═══════════ «ĐƠN ĐANG CHỐT» CỦA MỘT HỘI THOẠI — KIỂM TỪNG Ô (INBOX-V2-B) — HÀM THUẦN, CLIENT-SAFE ═══════════
 *
 * Panel đầu cột phải của hộp thư trả lời «khách này đang mua gì» và «đơn đã đủ để đi chưa». Tệp này KHÔNG khai luật mới: mỗi ô đọc
 * lại ĐÚNG hàm mà lõi ghi đơn (`lib/records/order-create.ts`) dùng để nhận / từ chối đơn — AGENTS §8.12 (logic chung không chép
 * sang trang) và bài học «luật có bản sao ngoài hàm chung»:
 *  · SĐT · địa chỉ · tỉnh · xã / phường · có hàng ⇒ `manualOrderGaps` (cùng hàm `confirmOrderReviewCore` từ chối nút «Xác nhận đơn»,
 *    cùng hàm công tắc «đơn đủ thông tin = đã xác nhận» của chủ shop 04–05/10/2026 dùng qua `manualOrderComplete`);
 *  · số lượng · đơn giá · chiết khấu · mẫu mã trùng dòng ⇒ `manualOrderTotals` (zod + phép tính tiền của đường ghi);
 *  · mẫu mã KHÔNG còn / ĐÃ GỠ ⇒ cùng điều kiện `prepare()` của lõi từ chối («Mẫu mã … đã gỡ — không nhận đơn mới»);
 *  · đơn giá 0 ₫ ở dòng không phải hàng tặng ⇒ cùng nghĩa với `agentUnitPrice` (giá ≤ 0 = CHƯA CÓ GIÁ, không phải 0 ₫);
 *  · phí ship «CHƯA BÁO» ⇒ `orderShipNote` — đơn lưu 0 nhưng đó là CHƯA BIẾT (luật 42), tổng tiền vì thế cũng chưa biết;
 *  · cờ CẦN NGƯỜI KIỂM (#675: khách huỷ · địa chỉ chưa ghép) ⇒ `orders.raw.review`; nút nào có ⇒ `quickConfirmKind`.
 *
 * Ba mức của một ô: `OK` · `CẦN KIỂM` (có dữ liệu nhưng người phải nhìn lại — không chặn lõi) · `THIẾU` (thiếu / không hợp lệ ⇒ lõi
 * TỪ CHỐI xác nhận). Nút «Xác nhận & tạo đơn» tắt khi có ô `THIẾU` và in đúng lý do của ô ấy — lõi cũng từ chối, nút chỉ nói trước.
 *
 * Bốn trạng thái của đơn — KHÔNG đoán: thiếu căn cứ ⇒ `CẦN XÁC THỰC`, không bao giờ `ĐỦ THÔNG TIN`.
 */
import { manualOrderGaps, manualOrderTotals } from "@/lib/constants/manual-orders";
import { quickConfirmKind, type OrderReviewEntry, type OrderReviewResolution } from "@/lib/constants/order-review";

export const ORDER_VERIFICATION_STATES = ["ĐỦ THÔNG TIN", "CẦN XÁC THỰC", "ĐÃ XÁC NHẬN", "ĐÃ TẠO ĐƠN"] as const;
export type OrderVerificationState = (typeof ORDER_VERIFICATION_STATES)[number];
export type FieldState = "OK" | "CẦN KIỂM" | "THIẾU";
export const VERIFIED_FIELDS = ["phone", "address", "sku", "qty", "price"] as const;
export type VerifiedField = (typeof VERIFIED_FIELDS)[number];
export type FieldCheck = { state: FieldState; reason?: string };
export const FIELD_LABEL: Record<VerifiedField, string> = { phone: "SĐT", address: "Địa chỉ", sku: "SKU / mẫu mã", qty: "Số lượng", price: "Giá" };

/** Một dòng hàng của đơn — đọc NGUYÊN từ `order_items` (giá là giá đơn đã GHI, không tính lại). `unitPrice = null` = chưa biết. */
export type OrderSummaryLine = {
  sku: string;
  productName: string;
  variation: string;
  quantity: number;
  unitPrice: number | null;
  /** Chiết khấu của dòng (`order_items.total_discount`). */
  discount: number;
  lineTotal: number | null;
  isBonus: boolean;
  variantId: string | null;
  /** Mẫu mã còn trong danh mục của tổ chức. */
  variantKnown: boolean;
  variantRemoved: boolean;
};

/**
 * Đơn ĐANG CHỐT của hội thoại (đơn còn sống mới nhất gắn với hội thoại) — máy chủ dựng ở `lib/sales-chatbot/order-summary.ts`.
 * Tiền là số nguyên VND; `null` = CHƯA BIẾT (in «—»), không bao giờ 0.
 */
export type ConversationOrderSummary = {
  orderId: string;
  shortCode: string;
  stage: string;
  stageLabel: string;
  /** Đơn tạo trong ERP (`erp-…`) — chỉ đơn này xác nhận được ở ERP; đơn đồng bộ xác nhận ở nguồn. */
  manual: boolean;
  byBot: boolean;
  insertedAt: string;
  /** Đơn có lần gửi CÒN GIỮ ĐƠN ở hãng vận chuyển (`attemptHoldsOrder`). */
  hasShipment: boolean;
  recipient: { name: string; phone: string; address: string; province: string; district: string; ward: string };
  lines: OrderSummaryLine[];
  /** `orders.items_count` — số dòng đơn KHAI; khác số dòng đọc được ⇒ dòng hàng chưa đọc đủ. */
  itemsCount: number;
  money: {
    /** Tiền hàng trước chiết khấu. */
    goods: number;
    /** Chiết khấu dòng + chiết khấu đơn. */
    discount: number;
    /** `null` = phí ship CHƯA BÁO (đơn lưu 0 nhưng chưa biết). */
    shipping: number | null;
    shippingNote: "UNKNOWN" | "FREE_IF_AREA" | null;
    /** Khách phải trả = tiền hàng sau chiết khấu + phí ship; `null` khi phí ship chưa biết. */
    total: number | null;
  };
  review: OrderReviewEntry[];
  reconfirms: OrderReviewResolution[];
  /** Số đơn còn sống KHÁC của cùng hội thoại — > 0 thì «đơn đang chốt» là đơn nào chưa chắc. */
  otherActive: number;
};

export type OrderVerificationInput = Pick<ConversationOrderSummary, "manual" | "stage" | "hasShipment" | "recipient" | "lines" | "itemsCount" | "money" | "review" | "otherActive">;
export type OrderVerification = { state: OrderVerificationState; fields: Record<VerifiedField, FieldCheck>; reasons: string[] };

/** Giai đoạn đơn đã sang khâu giao — từ đây «tạo đơn» đã xong, panel không còn gì để xác nhận. */
const FULFILLMENT_STAGES = new Set(["PACKING", "READY_TO_SHIP", "SHIPPED", "DELIVERED", "PAID", "RETURNING", "PARTIAL_RETURN", "RETURNED"]);

const OK: FieldCheck = { state: "OK" };
const lineName = (l: OrderSummaryLine, i: number) => `dòng ${i + 1}${l.sku ? ` (${l.sku})` : l.productName ? ` (${l.productName})` : ""}`;

function addressCheck(gaps: readonly string[], review: readonly OrderReviewEntry[], address: string): FieldCheck {
  if (gaps.includes("địa chỉ")) return { state: "THIẾU", reason: address.trim() ? "Địa chỉ quá ngắn (dưới 5 ký tự)" : "Chưa có địa chỉ" };
  if (gaps.includes("tỉnh / thành")) return { state: "THIẾU", reason: "Chưa ghép được tỉnh / thành từ địa chỉ" };
  if (gaps.includes("xã / phường")) return { state: "THIẾU", reason: "Chưa ghép được xã / phường — chưa gửi hãng vận chuyển được" };
  if (review.some((e) => e.code === "ADDRESS_UNRESOLVED")) return { state: "CẦN KIỂM", reason: "Máy chốt khi địa chỉ chưa ghép được — kiểm lại xã / phường" };
  return OK;
}

/**
 * Kiểm từng ô + kết luận trạng thái đơn. HÀM THUẦN — cùng đầu vào ra cùng kết quả, không đọc đồng hồ.
 *
 * Thứ tự kết luận:
 *  1. Đơn đồng bộ (không `erp-`), đơn đã có vận đơn còn giữ đơn, hoặc đã sang khâu giao ⇒ `ĐÃ TẠO ĐƠN`.
 *  2. Còn cờ CẦN NGƯỜI KIỂM (khách huỷ · địa chỉ chưa ghép) ⇒ `CẦN XÁC THỰC` — kể cả đơn đã «Đã xác nhận».
 *  3. «Đã xác nhận» ⇒ `ĐÃ XÁC NHẬN` (người / công tắc đã quyết; ô còn thiếu vẫn được tô để sửa đơn).
 *  4. Đơn nháp («Mới» / «Chờ hàng»): mọi ô `OK` và hội thoại chỉ có MỘT đơn đang mở ⇒ `ĐỦ THÔNG TIN`; còn lại ⇒ `CẦN XÁC THỰC`.
 */
export function orderVerification(i: OrderVerificationInput): OrderVerification {
  const gaps = manualOrderGaps({ phone: i.recipient.phone, address: i.recipient.address, province: i.recipient.province, ward: i.recipient.ward }, i.itemsCount);
  const phone: FieldCheck = gaps.includes("SĐT") ? { state: "THIẾU", reason: i.recipient.phone.trim() ? "SĐT không hợp lệ (cần 8–15 chữ số)" : "Chưa có SĐT" } : OK;
  const address = addressCheck(gaps, i.review, i.recipient.address);

  // Dòng hàng: cùng phép kiểm của đường ghi (`manualOrderTotals`). Đơn giá chưa biết không đưa vào phép tính — báo riêng.
  const known = i.lines.every((l) => l.unitPrice !== null);
  const totals = known ? manualOrderTotals(i.lines.map((l) => ({ variantId: l.variantId ?? "", quantity: l.quantity, unitPrice: l.unitPrice ?? 0, discount: l.discount })), 0, 0) : null;
  const errorsAt = (suffix: string) => (totals && !totals.ok ? totals.errors.filter((e) => e.field.endsWith(suffix)) : []);
  const lineIndex = (field: string) => Number(field.split(".")[1]);

  let sku: FieldCheck = OK;
  let qty: FieldCheck = OK;
  let price: FieldCheck = OK;
  if (!i.lines.length) {
    const unread = i.itemsCount > 0;
    sku = unread ? { state: "CẦN KIỂM", reason: `Đơn khai ${i.itemsCount} dòng hàng nhưng chưa đọc được dòng nào` } : { state: "THIẾU", reason: "Đơn chưa có hàng" };
    qty = unread ? { state: "CẦN KIỂM", reason: "Chưa đọc được số lượng" } : { state: "THIẾU", reason: "Đơn chưa có hàng" };
    price = unread ? { state: "CẦN KIỂM", reason: "Chưa đọc được đơn giá" } : { state: "THIẾU", reason: "Đơn chưa có hàng" };
  } else {
    const missing = i.lines.findIndex((l) => !l.variantId || !l.variantKnown);
    const removed = i.lines.findIndex((l) => l.variantId && l.variantKnown && l.variantRemoved);
    const dup = errorsAt(".variantId")[0];
    if (missing >= 0) sku = i.manual ? { state: "THIẾU", reason: `${lineName(i.lines[missing], missing)} chưa nối mẫu mã trong danh mục` } : { state: "CẦN KIỂM", reason: `${lineName(i.lines[missing], missing)} chưa nối mẫu mã ERP` };
    else if (removed >= 0) sku = { state: "THIẾU", reason: `Mẫu mã ${lineName(i.lines[removed], removed)} đã gỡ — không nhận đơn mới` };
    else if (dup) sku = { state: "CẦN KIỂM", reason: `${lineName(i.lines[lineIndex(dup.field)], lineIndex(dup.field))}: ${dup.message}` };
    else if (i.itemsCount > i.lines.length) sku = { state: "CẦN KIỂM", reason: `Đơn khai ${i.itemsCount} dòng hàng, đọc được ${i.lines.length}` };
    // Lõi đếm hàng theo `items_count` của đơn (cùng đối số `manualOrderGaps` ở `confirmOrderReviewCore`) — khai 0 dòng là lõi từ chối.
    if (gaps.includes("hàng") && sku.state !== "THIẾU") sku = { state: "THIẾU", reason: "Đơn khai 0 dòng hàng — lõi đơn từ chối xác nhận" };

    const badQty = errorsAt(".quantity")[0];
    if (badQty) qty = { state: "THIẾU", reason: `${lineName(i.lines[lineIndex(badQty.field)], lineIndex(badQty.field))}: ${badQty.message}` };

    const unknownPrice = i.lines.findIndex((l) => l.unitPrice === null);
    const badPrice = errorsAt(".unitPrice")[0] ?? errorsAt(".discount")[0];
    const zero = i.lines.findIndex((l) => l.unitPrice === 0 && !l.isBonus);
    if (unknownPrice >= 0) price = { state: "THIẾU", reason: `${lineName(i.lines[unknownPrice], unknownPrice)} chưa có đơn giá` };
    else if (badPrice) price = { state: "THIẾU", reason: `${lineName(i.lines[lineIndex(badPrice.field)], lineIndex(badPrice.field))}: ${badPrice.message}` };
    else if (zero >= 0) price = { state: "CẦN KIỂM", reason: `${lineName(i.lines[zero], zero)} đơn giá 0 ₫ — mẫu mã chưa có giá bán?` };
  }
  if (price.state === "OK" && i.money.shippingNote === "UNKNOWN") price = { state: "CẦN KIỂM", reason: "Phí ship chưa báo — tổng tiền chưa biết" };
  else if (price.state === "OK" && i.money.shippingNote === "FREE_IF_AREA") price = { state: "CẦN KIỂM", reason: "Miễn ship NẾU đúng khu vực — kiểm địa chỉ trước khi giao" };

  const fields: Record<VerifiedField, FieldCheck> = { phone, address, sku, qty, price };
  const fieldReasons = VERIFIED_FIELDS.flatMap((k) => (fields[k].state === "OK" ? [] : [fields[k].reason ?? fields[k].state]));
  const reasons = [...(i.review.length ? [`Cần người kiểm: ${[...new Set(i.review.map((e) => e.code === "CUSTOMER_CANCELLED" ? "khách báo huỷ" : "địa chỉ chưa ghép"))].join(", ")}`] : []), ...(i.otherActive > 0 ? [`Hội thoại còn ${i.otherActive} đơn khác đang mở`] : []), ...fieldReasons];

  let state: OrderVerificationState;
  if (!i.manual || i.hasShipment || FULFILLMENT_STAGES.has(i.stage)) state = "ĐÃ TẠO ĐƠN";
  else if (i.review.length) state = "CẦN XÁC THỰC";
  else if (i.stage === "CONFIRMED") state = "ĐÃ XÁC NHẬN";
  else state = fieldReasons.length || i.otherActive > 0 ? "CẦN XÁC THỰC" : "ĐỦ THÔNG TIN";
  return { state, fields, reasons };
}

/**
 * Nút «Xác nhận & tạo đơn» của panel: có hay không theo `quickConfirmKind` (cùng phân nhánh với `confirmOrderReviewCore`), chỉ đơn
 * `erp-` và chỉ khi người này được sửa đơn (`canDecide` — cổng `manualOrderGate` máy chủ tính). Ô `THIẾU` ⇒ tắt, kèm lý do của ô
 * đó — lõi cũng từ chối. HÀM THUẦN.
 */
export function orderConfirmButton(s: Pick<ConversationOrderSummary, "manual" | "stage" | "review">, v: OrderVerification, canDecide: boolean): { show: false } | { show: true; enabled: boolean; reason: string | null; kind: "CONFIRM" | "RESOLVE" } {
  const kind = s.manual ? quickConfirmKind(s.stage, s.review.length > 0) : null;
  if (!kind || !canDecide || v.state === "ĐÃ TẠO ĐƠN") return { show: false };
  const blocking = VERIFIED_FIELDS.find((k) => v.fields[k].state === "THIẾU");
  return blocking ? { show: true, enabled: false, reason: `${FIELD_LABEL[blocking]}: ${v.fields[blocking].reason ?? "thiếu"} — sửa đơn trước`, kind } : { show: true, enabled: true, reason: null, kind };
}


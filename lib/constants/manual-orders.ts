/**
 * ═══════════ ĐƠN HÀNG TẠO TAY — CHO TỔ CHỨC KHÔNG CÓ NGUỒN ĐƠN ĐỒNG BỘ (pilot P0 #3) — THUẦN, CLIENT-SAFE ═══════════
 *
 * Tổ chức nhà nhận đơn từ Pancake (`orders.id` = id Pancake dạng chuỗi số, đồng bộ ghi đè mỗi lượt). Tổ chức KHÔNG bật
 * `connector_pancake` không có đường nào đưa một đơn vào ERP. Tệp này khai phần THUẦN của đường tạo tay:
 *
 *  · LUẬT "tổ chức không có nguồn đơn": cùng một câu hỏi với khách và sản phẩm — `orgHasSyncedSource("orders")`
 *    (lib/platform/capabilities.ts), khớp năng lực `create.requiresModuleOff` của đối tượng `order` trong sổ đối tượng.
 *    Tổ chức nhà luôn bật Pancake ⇒ không nút, trang /orders/new 404, action từ chối kể cả Quản trị.
 *  · ĐỊNH DANH: id đơn tạo tay mang tiền tố `erp-` (id Pancake là chuỗi số, không bao giờ bắt đầu bằng chữ đó) — cùng tiền
 *    tố với sản phẩm / mẫu mã tạo tay. "Đơn này tạo tay hay đồng bộ" đọc được từ CHÍNH id, và `orders.raw` mang lời khai
 *    gốc `{ origin: "ERP_MANUAL" }` (cột `raw` là "lời khai gốc" của bản ghi: payload Pancake với đơn đồng bộ). KHÔNG cột
 *    mới, KHÔNG migration — `orders.source` đã là KÊNH BÁN (Facebook / Zalo / …), dùng nó làm cờ nguồn là trộn hai nghĩa.
 *  · KẾT QUẢ ĐƠN KHÔNG ĐỔI: đơn tay không có vận đơn ⇒ `ORDER_OUTCOME` cho đúng nhánh sẵn có (`NOT_SHIPPED`, huỷ ⇒
 *    `CANCELLED`). Không thêm nhánh nào — "đơn không qua ĐVVC thì giao / thu thế nào" là quyết định còn chờ chủ nền tảng
 *    (G-ORDER). Vì vậy trạng thái chọn được chỉ là các bước TRƯỚC khi gửi: không có "Đã nhận", "Đã thu tiền".
 *  · TỒN KHO KHÔNG ĐỔI: tạo đơn không ghi phiếu kho nào (luật 10 — tồn thực tế chỉ giảm qua `SHIPMENT_LEFT_WAREHOUSE`
 *    hoặc phiếu XUẤT TAY). Đơn "Đã xác nhận" giữ hàng ở cột khả dụng như mọi đơn đã chốt. Trang đơn có lối "Lập phiếu
 *    xuất kho" dẫn tới luồng ISSUE sẵn có, điền sẵn mẫu mã + số lượng — người kho sửa theo số ĐẾM THẬT rồi lưu.
 *  · BÁO CÁO MARKETER (luật 3.9 — tổng = số đơn XÁC NHẬN PANCAKE): đơn tay nằm NGOÀI phép so ấy (`NOT_MANUAL_ORDER` ở
 *    `lib/queries/manual-order-sql.ts`).
 */
import type { OrderStage } from "@/db/schema";
import { ORDER_STAGE_LABEL } from "@/lib/constants/pancake";

export const MANUAL_ORDER_ID_PREFIX = "erp-";
export const MANUAL_ORDER_ORIGIN = "ERP_MANUAL" as const;

/** Đơn do người tạo trên ERP — không phải bản đồng bộ. */
export function isManualOrderId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(MANUAL_ORDER_ID_PREFIX);
}

/** Id mới cho đơn tạo tay. `crypto.randomUUID` có ở Node ≥ 19 và mọi trình duyệt hiện hành. */
export function newManualOrderId(): string {
  return `${MANUAL_ORDER_ID_PREFIX}${globalThis.crypto.randomUUID()}`;
}

/** Mã ngắn để người đọc gọi tên đơn (8 ký tự đầu sau tiền tố) — chỉ hiển thị, không phải khoá. */
export function manualOrderShortCode(id: string): string {
  return isManualOrderId(id) ? id.slice(MANUAL_ORDER_ID_PREFIX.length, MANUAL_ORDER_ID_PREFIX.length + 8).toUpperCase() : id;
}

/**
 * Trạng thái chọn được khi tạo / sửa đơn tay: CHỈ các bước trước khi gửi hàng. Mã số là mã Pancake của cùng trạng thái
 * (`PANCAKE_ORDER_STATUS`) để cột `orders.status` không mang một giá trị lạ với mọi màn hình đang đọc nó.
 */
export const MANUAL_ORDER_STAGES = ["NEW", "WAITING", "CONFIRMED"] as const satisfies readonly OrderStage[];
export type ManualOrderStage = (typeof MANUAL_ORDER_STAGES)[number];

export const MANUAL_ORDER_STATUS_CODE: Record<ManualOrderStage | "CANCELLED", number> = { NEW: 0, WAITING: 11, CONFIRMED: 1, CANCELLED: 6 };

export const MANUAL_ORDER_STAGE_HINT: Record<ManualOrderStage, string> = {
  NEW: "Mới ghi nhận, chưa chốt — chưa giữ hàng, chưa vào số đơn xác nhận.",
  WAITING: "Khách đã đặt nhưng đang chờ hàng về — chưa giữ hàng.",
  CONFIRMED: "Đã chốt với khách — giữ hàng ở cột khả dụng cho tới khi xuất kho.",
};

export function manualOrderStageLabel(stage: ManualOrderStage | "CANCELLED"): string {
  return ORDER_STAGE_LABEL[stage];
}

export function isManualOrderStage(v: unknown): v is ManualOrderStage {
  return typeof v === "string" && (MANUAL_ORDER_STAGES as readonly string[]).includes(v);
}

/** Trần của một đơn tay — chặn đầu vào vô lý trước khi chạm CSDL. */
export const MANUAL_ORDER_LIMITS = { maxLines: 100, maxQuantity: 100_000, maxMoney: 10_000_000_000, noteMax: 2000, channelMax: 60, reasonMin: 3, reasonMax: 500 } as const;

export type ManualOrderLineInput = { variantId: string; quantity: number; unitPrice: number; discount: number };
export type ManualOrderLineTotals = ManualOrderLineInput & { subtotal: number; lineTotal: number };
export type ManualOrderTotals = {
  lines: ManualOrderLineTotals[];
  /** Tổng tiền hàng trước chiết khấu (Σ số lượng × đơn giá). */
  totalPrice: number;
  /** Chiết khấu dòng + chiết khấu đơn. */
  totalDiscount: number;
  /** Tiền hàng sau chiết khấu — CÙNG nghĩa với cột của đơn Pancake (không gồm phí ship). */
  totalPriceAfterDiscount: number;
  shippingFee: number;
  /** Khách phải trả = tiền hàng sau chiết khấu + phí ship. Chỉ để hiển thị. */
  grandTotal: number;
  totalQuantity: number;
};
export type TotalsError = { field: string; message: string };

const isMoney = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= MANUAL_ORDER_LIMITS.maxMoney;

/**
 * Tính tiền của đơn tay — hàm THUẦN, dùng chung cho form (hiện số trước khi bấm) và máy chủ (số được LƯU). Tiền là số
 * nguyên VND; mọi lỗi gắn với đúng ô (`lines.<i>.quantity`, `orderDiscount`…). Chiết khấu không được lớn hơn tiền hàng:
 * một đơn âm tiền không có nghĩa nào trong bất kỳ báo cáo nào.
 */
export function manualOrderTotals(lines: readonly ManualOrderLineInput[], orderDiscount: number, shippingFee: number): { ok: true; totals: ManualOrderTotals } | { ok: false; errors: TotalsError[] } {
  const errors: TotalsError[] = [];
  if (lines.length === 0) errors.push({ field: "lines", message: "Đơn cần ít nhất một dòng hàng." });
  if (lines.length > MANUAL_ORDER_LIMITS.maxLines) errors.push({ field: "lines", message: `Một đơn tối đa ${MANUAL_ORDER_LIMITS.maxLines} dòng hàng.` });
  const seen = new Set<string>();
  const out: ManualOrderLineTotals[] = [];
  lines.forEach((l, i) => {
    const p = `lines.${i}`;
    if (!l.variantId) errors.push({ field: `${p}.variantId`, message: "Chọn mẫu mã." });
    else if (seen.has(l.variantId)) errors.push({ field: `${p}.variantId`, message: "Mẫu mã này đã có ở dòng khác — gộp số lượng vào một dòng." });
    seen.add(l.variantId);
    if (!Number.isSafeInteger(l.quantity) || l.quantity < 1 || l.quantity > MANUAL_ORDER_LIMITS.maxQuantity) errors.push({ field: `${p}.quantity`, message: `Số lượng là số nguyên từ 1 tới ${MANUAL_ORDER_LIMITS.maxQuantity.toLocaleString("vi-VN")}.` });
    if (!isMoney(l.unitPrice)) errors.push({ field: `${p}.unitPrice`, message: "Đơn giá là số tiền nguyên (đồng), không âm." });
    if (!isMoney(l.discount)) errors.push({ field: `${p}.discount`, message: "Chiết khấu là số tiền nguyên (đồng), không âm." });
    const subtotal = Number.isSafeInteger(l.quantity) && isMoney(l.unitPrice) ? l.quantity * l.unitPrice : 0;
    if (isMoney(l.discount) && l.discount > subtotal) errors.push({ field: `${p}.discount`, message: "Chiết khấu dòng lớn hơn tiền hàng của dòng." });
    out.push({ ...l, subtotal, lineTotal: Math.max(0, subtotal - (isMoney(l.discount) ? l.discount : 0)) });
  });
  if (!isMoney(orderDiscount)) errors.push({ field: "orderDiscount", message: "Chiết khấu đơn là số tiền nguyên (đồng), không âm." });
  if (!isMoney(shippingFee)) errors.push({ field: "shippingFee", message: "Phí ship là số tiền nguyên (đồng), không âm." });
  const afterLines = out.reduce((s, l) => s + l.lineTotal, 0);
  if (isMoney(orderDiscount) && orderDiscount > afterLines) errors.push({ field: "orderDiscount", message: "Chiết khấu đơn lớn hơn tiền hàng sau chiết khấu dòng." });
  if (errors.length) return { ok: false, errors };
  const totalPrice = out.reduce((s, l) => s + l.subtotal, 0);
  const totalDiscount = out.reduce((s, l) => s + l.discount, 0) + orderDiscount;
  const totalPriceAfterDiscount = totalPrice - totalDiscount;
  return {
    ok: true,
    totals: { lines: out, totalPrice, totalDiscount, totalPriceAfterDiscount, shippingFee, grandTotal: totalPriceAfterDiscount + shippingFee, totalQuantity: out.reduce((s, l) => s + l.quantity, 0) },
  };
}

/** Lựa chọn của form đơn tay (máy chủ dựng ở `manualOrderFormOptions`). */
export type ManualOrderCustomerOption = { id: string; name: string; phone: string | null; province: string };
export type ManualOrderVariantOption = { id: string; label: string; sku: string; price: number | null };

/** Lời khai gốc lưu ở `orders.raw` của đơn tay. */
export type ManualOrderRaw = { origin: typeof MANUAL_ORDER_ORIGIN; orderDiscount: number; createdBy: string | null };

/** Đọc lời khai gốc; bản ghi đồng bộ / hỏng ⇒ `null`. */
export function manualOrderRaw(raw: unknown): ManualOrderRaw | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<ManualOrderRaw>;
  return r.origin === MANUAL_ORDER_ORIGIN ? { origin: MANUAL_ORDER_ORIGIN, orderDiscount: Number.isSafeInteger(r.orderDiscount) ? Number(r.orderDiscount) : 0, createdBy: typeof r.createdBy === "string" ? r.createdBy : null } : null;
}

/** Tham số trên /inventory/receipts mở hộp thoại XUẤT TAY điền sẵn theo một đơn tay. */
export const ISSUE_PREFILL_PARAM = "xuat-don";

export function issueReceiptHref(orderId: string): string {
  return `/inventory/receipts?${ISSUE_PREFILL_PARAM}=${encodeURIComponent(orderId)}`;
}

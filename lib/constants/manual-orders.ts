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
 *  · GIAO HÀNG (G-ORDER — chủ nền tảng quyết 29/09/2026, docs/business-rules/ORDER_OUTCOME.md mục 11): đơn tay
 *    "Đã xác nhận" được XÁC NHẬN ĐÃ GIAO bằng PHIẾU GIAO CÓ KÝ NHẬN (`order_delivery_notes`). Có phiếu còn hiệu lực ⇒
 *    stage `DELIVERED`, `ORDER_OUTCOME` = `DELIVERED` (nhánh đầu bảng, chỉ đơn `erp-` không vận đơn), hàng ra khỏi kho
 *    (`ORDER_LEFT_WAREHOUSE`: tồn thực tế giảm, thôi giữ ở khả dụng). Chưa có phiếu ⇒ như trước: `NOT_SHIPPED`, huỷ ⇒
 *    `CANCELLED`. Trạng thái chọn được ở form tạo / sửa vẫn chỉ là các bước TRƯỚC khi giao — "Đã nhận" chỉ tới bằng phiếu.
 *  · TIỀN KHÔNG ĐI THEO PHIẾU GIAO: phiếu không chứng minh đã thu. Tiền theo CHỨNG TỪ THANH TOÁN (`order_payments`, 0181 —
 *    `lib/constants/order-payments.ts`, ORDER_OUTCOME.md mục 11.1): thu đủ ⇒ `DELIVERED` ở `ORDER_OUTCOME_VERIFIED`, còn lại
 *    `UNVERIFIED`. Doanh thu + giá vốn DANH NGHĨA của đơn tay đã giao vào mọi tổng dựng trên DELIVERED ở tổ chức không
 *    đồng bộ đơn (`REVENUE_RECOGNIZED_ON_DELIVERY`, mục 11.3 — chủ shop HSLC 03/10/2026); thực thu vẫn theo `paid_at`.
 *  · GIAO KHÔNG THÀNH CÔNG (mục 11.2): «Đã xác nhận» ⇒ «Đã hoàn», `ORDER_OUTCOME` = RETURNED, hàng quay lại tồn ngay.
 *  · TỒN KHO: tạo / sửa đơn không ghi phiếu kho nào (luật 10). Đơn "Đã xác nhận" giữ hàng ở cột khả dụng như mọi đơn đã
 *    chốt; XÁC NHẬN GIAO mới đưa hàng ra khỏi kho. KHÔNG lập phiếu XUẤT TAY cho đơn tay — làm cả hai là trừ hai lần
 *    (lối "Lập phiếu xuất kho" của bản trước đã bỏ). Huỷ phiếu giao (ghi nhầm, bắt buộc lý do) ⇒ đơn về "Đã xác nhận".
 *  · BÁO CÁO MARKETER (luật 3.9 — tổng = số đơn XÁC NHẬN PANCAKE): ở tổ chức đồng bộ Pancake đơn tay nằm NGOÀI phép so ấy
 *    (`IN_SALES_REPORTS` ở `lib/queries/manual-order-sql.ts`); tổ chức chỉ có đơn tay thì báo cáo danh nghĩa có chúng.
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

export const MANUAL_ORDER_STATUS_CODE: Record<ManualOrderStage | "CANCELLED" | "DELIVERED" | "RETURNED", number> = { NEW: 0, WAITING: 11, CONFIRMED: 1, CANCELLED: 6, DELIVERED: 3, RETURNED: 5 };

export const MANUAL_ORDER_STAGE_HINT: Record<ManualOrderStage, string> = {
  NEW: "Mới ghi nhận, chưa chốt — chưa giữ hàng, chưa vào số đơn xác nhận.",
  WAITING: "Khách đã đặt nhưng đang chờ hàng về — chưa giữ hàng.",
  CONFIRMED: "Đã chốt với khách — giữ hàng ở cột khả dụng cho tới khi xác nhận đã giao (phiếu giao có ký nhận).",
};

export function manualOrderStageLabel(stage: ManualOrderStage | "CANCELLED" | "DELIVERED" | "RETURNED"): string {
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

// ─────────────────────────── Phiếu giao có ký nhận (G-ORDER) ───────────────────────────

/** Trần của phiếu giao — chặn đầu vào vô lý trước khi chạm CSDL. `futureSkewMs`: lệch đồng hồ máy người ghi. */
export const DELIVERY_NOTE_LIMITS = { receiverMax: 120, noteMax: 1000, reasonMin: 3, reasonMax: 500, futureSkewMs: 5 * 60_000 } as const;

/**
 * Đơn ở trạng thái nào thì XÁC NHẬN GIAO được — CHỈ "Đã xác nhận". `NEW` / `WAITING` chưa chốt với khách (chưa giữ hàng,
 * chưa vào số đơn xác nhận): nhận phiếu ở đó là bỏ qua bước chốt. `CANCELLED` / `DELIVERED`: đã kết thúc.
 */
export const MANUAL_DELIVERY_FROM_STAGES = ["CONFIRMED"] as const satisfies readonly OrderStage[];

/** Cùng tập với điều kiện SQL của giao dịch ghi phiếu (`confirmManualDeliveryCore`) — một danh sách, hai chỗ đọc. */
export function canConfirmManualDelivery(stage: string): boolean {
  return (MANUAL_DELIVERY_FROM_STAGES as readonly string[]).includes(stage);
}

/**
 * ═══ GIAO KHÔNG THÀNH CÔNG (chủ shop HSLC 03/10/2026 — ORDER_OUTCOME.md mục 11.2) ═══
 *
 * Đơn tay «Đã xác nhận» mà khách không nhận / hoàn ⇒ stage `RETURNED` (mã Pancake 5 «Đã hoàn»). `ORDER_OUTCOME` có sẵn
 * nhánh `o.stage = 'RETURNED'` cho đơn không vận đơn ⇒ đơn tính là HOÀN trong tỷ lệ giao thành công. Hàng QUAY LẠI TỒN
 * NGAY (chủ shop chọn, khác luật 4 của đơn qua ĐVVC): đơn không còn ở «giữ hàng» và chưa từng «rời kho» (không có phiếu
 * giao), nên khả dụng tự cộng lại — không phiếu kho nào được tạo. Chỉ từ «Đã xác nhận»; đơn đã có phiếu giao phải huỷ
 * phiếu trước. Ghi nhầm ⇒ hoàn tác về «Đã xác nhận» (giữ hàng lại).
 */
export const MANUAL_FAILED_FROM_STAGES = ["CONFIRMED"] as const satisfies readonly OrderStage[];
export function canMarkManualDeliveryFailed(stage: string): boolean {
  return (MANUAL_FAILED_FROM_STAGES as readonly string[]).includes(stage);
}

/**
 * PHÍ GIAO MỖI ĐƠN GIAO THÀNH CÔNG của tổ chức tạo đơn tay (chủ shop HSLC 03/10/2026: «đồng giá 40K/1 đơn giao thành
 * công») — khoá `settings['orders.manualDeliveryFee']`, số nguyên ₫; chưa khai ⇒ `null` (không ghi gì, không đoán). Ghi
 * vào `orders.partner_fee` lúc xác nhận đã giao (phí ĐVVC shop trả — đường cước mà mọi báo cáo lợi nhuận đã đọc), về 0
 * khi huỷ phiếu giao; đơn giao không thành công không mang phí.
 */
export const MANUAL_DELIVERY_FEE_SETTING_KEY = "orders.manualDeliveryFee";

/**
 * ═══ ĐƠN ĐỦ THÔNG TIN = ĐÃ XÁC NHẬN (chủ shop HSLC 04/10/2026) ═══
 *
 * «Đơn có đầy đủ thông tin: SĐT, địa chỉ, SKU được tính là đơn hàng luôn (không cần xác nhận), chỉ trừ những đơn huỷ.»
 * 05/10/2026 thêm: địa chỉ phải GHÉP ĐƯỢC tỉnh + xã theo địa giới mới («tự tạo đơn đã xác nhận khi thông tin đã chính xác»).
 * Công tắc THEO TỔ CHỨC (`settings['orders.autoConfirmComplete']` = `{ enabled }`, mặc định TẮT): bật thì đơn tay «Mới» đủ ba thứ ⇒ ghi
 * thẳng «Đã xác nhận» ở lõi ghi đơn (`lib/records/order-create.ts`) — một chỗ cho chatbot, ghi đơn từ hội thoại và form
 * tạo tay, nên MỌI báo cáo đang đếm đơn đã xác nhận (hiệu quả quảng cáo, lợi nhuận danh nghĩa, marketer) tự đếm đúng mà
 * không báo cáo nào phải đổi định nghĩa «đơn». Giữ hàng ở kho như mọi đơn đã chốt. «Chờ hàng» là lựa chọn tường minh của
 * người ⇒ không tự đổi. Vượt hạn mức nợ của khách ⇒ giữ «Mới» (không báo lỗi, không lặng lẽ xác nhận).
 */
export const AUTO_CONFIRM_COMPLETE_SETTING_KEY = "orders.autoConfirmComplete";

/**
 * TỔ CHỨC ĐÃ CHUYỂN HẲN SANG ERP (chủ shop chốt 04/10/2026 — ORDER_OUTCOME.md mục 11.3). Shop đến từ Pancake nhập lịch sử đơn
 * Pancake rồi tắt kết nối: CSDL có đơn không `erp-` nên phép nhận diện «tổ chức đồng bộ đơn» theo dữ liệu đẩy MỌI đơn ERP
 * mới ra khỏi báo cáo. Dòng này là lời TUYÊN BỐ của quản trị shop (bấm một lần): từ đó đơn ERP vào mọi báo cáo. Giá trị
 * `{ since, by }` — ai, khi nào. Tổ chức nhà không bao giờ có dòng này (lõi chặn).
 */
export const ERP_NATIVE_SETTING_KEY = "orders.erpNative";

/**
 * Chỗ còn thiếu để đơn ĐỦ & ĐÚNG THÔNG TIN — rỗng = đủ. SĐT 8–15 chữ số · địa chỉ ≥ 5 ký tự · tỉnh + xã / phường đã ghép được
 * vào danh mục địa giới mới · ít nhất một dòng hàng. Tỉnh + xã (chủ shop HSLC 05/10/2026: «tự tạo đơn đã xác nhận khi thông
 * tin đã chính xác … chưa mapping được thì đưa phương án»): ô xã chỉ có giá trị khi lõi ghi đơn đã ĐỐI CHIẾU được với danh mục
 * (`resolveRecipientPlace`) hoặc người đã chọn — nên «có xã» = «đã ghép được», đẩy sang hãng vận chuyển được. HÀM THUẦN.
 */
export function manualOrderGaps(recipient: { phone: string; address: string; province?: string; ward?: string }, lineCount: number): string[] {
  const digits = recipient.phone.replace(/\D/g, "");
  const out: string[] = [];
  if (digits.length < 8 || digits.length > 15) out.push("SĐT");
  if (recipient.address.trim().length < 5) out.push("địa chỉ");
  else if (!(recipient.province ?? "").trim()) out.push("tỉnh / thành");
  else if (!(recipient.ward ?? "").trim()) out.push("xã / phường");
  if (lineCount < 1) out.push("hàng");
  return out;
}

/** Đơn ĐỦ & ĐÚNG THÔNG TIN (`manualOrderGaps` rỗng). HÀM THUẦN. */
export function manualOrderComplete(recipient: { phone: string; address: string; province?: string; ward?: string }, lineCount: number): boolean {
  return manualOrderGaps(recipient, lineCount).length === 0;
}
export function parseManualDeliveryFee(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n >= 0 && n <= 10_000_000 ? n : null;
}

/**
 * Phần của một đơn ĐÃ CHỐT mà nhóm vận hành phải biết khi nó đổi (0180) — tên đi trong payload `order.updated` và
 * trong tin «cập nhật đơn». Ghi chú / kênh bán không nằm đây: đổi chúng không đổi việc đóng gói / giao / thu.
 */
export const ORDER_MATERIAL_CHANGE_LABEL = { lines: "Hàng / số lượng / giá", shipping_address: "Người nhận / địa chỉ", amount_due: "Tiền thu (COD)", customer: "Khách hàng", stage: "Trạng thái" } as const;
export type OrderMaterialChange = keyof typeof ORDER_MATERIAL_CHANGE_LABEL;

/**
 * Dòng ghi chú do MÁY viết vào đơn — máy cần chúng (chống trùng theo mã tin, nhắc nhân viên kiểm) nhưng người đóng gói thì
 * không: «Ghi tự động… KIỂM rồi chốt đơn», «Lời chốt …», «Mã tin fanpage: m_…», dòng phí ship / tồn. Chủ shop HSLC
 * 05/10/2026: tin báo đơn «gửi nội dung ngắn gọn lại, bỏ những nội dung không cần thiết». Ghi chú trong ĐƠN giữ nguyên.
 */
const MACHINE_NOTE_LINE = /^(Ghi tự động từ hội thoại|Lời chốt |Mã tin fanpage|Phí ship|Miễn ship|Tồn chưa xác nhận|Sổ kho đang thiếu)/i;

/** Ghi chú đơn cho tin nhóm: chỉ phần NGƯỜI cần đọc (dặn giao hàng, cảnh báo SĐT / địa chỉ lấy từ đơn trước). HÀM THUẦN. */
export function orderNoteForGroup(note: string | null | undefined): string {
  return (note ?? "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter((x) => x && !MACHINE_NOTE_LINE.test(x))
    .join(" · ");
}

/**
 * Ghi chú máy nói gì về phí ship: CHƯA BÁO (đơn lưu 0 nhưng 0 đó là CHƯA BIẾT — luật 42: không in «0 ₫») · miễn phí NẾU
 * đúng khu vực · không nói gì. HÀM THUẦN.
 */
export function orderShipNote(note: string | null | undefined): "UNKNOWN" | "FREE_IF_AREA" | null {
  const lines = (note ?? "").split(/\r?\n/).map((x) => x.trim());
  if (lines.some((x) => /^Phí ship: CHƯA BÁO/i.test(x))) return "UNKNOWN";
  if (lines.some((x) => /^Miễn ship NẾU/i.test(x))) return "FREE_IF_AREA";
  return null;
}

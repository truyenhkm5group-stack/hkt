/**
 * TRẠNG THÁI CHUẨN TẮC của một hội thoại bán hàng.
 *
 * ERP giữ trạng thái; mô hình KHÔNG nhớ gì cả. Mỗi lượt chạy đọc trạng thái từ CSDL, tính trạng
 * thái mới bằng hàm thuần, rồi ghi lại. Nhờ vậy: chạy lại một tin nhắn cho cùng kết quả, đổi mô
 * hình không làm đổi trạng thái, và khi số liệu sai thì mở đúng một dòng ra đọc là thấy.
 *
 * `null` ở đây nghĩa là CHƯA BIẾT, không phải "không có" — y hệt luật tiền của ERP.
 */
import { SALES_STAGES, type SalesStage } from "@/lib/constants/sales-agent";

/** Bản chốt đơn đã gửi cho khách và đang chờ trả lời. Đây là thứ biến chữ "ok" thành xác nhận. */
export type PendingConfirmation = {
  /** Mốc gửi bản chốt (ISO). Khách phải trả lời SAU mốc này. */
  sentAt: string;
  /** Dấu vân tay của bản chốt: đổi mẫu mã / số lượng / địa chỉ là đổi vân tay ⇒ xác nhận cũ vô hiệu. */
  fingerprint: string;
  /** Nội dung đã đọc cho khách, để đối chiếu khi tranh luận. */
  summary: string;
  variantId: string;
  quantity: number;
  total: number;
};

export type SalesState = {
  productId: string | null;
  productName: string;
  variantId: string | null;
  variantLabel: string;
  size: string;
  color: string;
  quantity: number;
  /**
   * Khách ĐÃ từng nói muốn mua. DÍNH LẠI trong trạng thái, không đọc lại từ tin nhắn cuối:
   * khách nói "em muốn mua" ở tin thứ nhất rồi tin thứ hai chỉ nhắn "size L" — nếu ý muốn mua
   * chỉ sống trong một tin thì máy sẽ tụt về hỏi lại từ đầu ở mọi lượt sau.
   */
  purchaseIntent: boolean;
  /** Mẫu mã của sản phẩm này có nhiều size/màu hay không — do công cụ ERP trả về, không tự đoán. */
  needsSize: boolean;
  needsColor: boolean;
  phone: string;
  customerName: string;
  address: string;
  province: string;
  /** Giá do MÁY CHỦ tính lần gần nhất (VND). null = chưa tính. */
  quotedTotal: number | null;
  pending: PendingConfirmation | null;
  /** Băn khoăn đang mở, để lượt sau còn biết đã gỡ chưa. */
  openObjection: string;
  /** Số lần máy đã hỏi cùng một thứ — hỏi mãi một câu là lúc phải chuyển người. */
  askCount: Record<string, number>;
};

export const EMPTY_SALES_STATE: SalesState = {
  productId: null,
  productName: "",
  variantId: null,
  variantLabel: "",
  size: "",
  color: "",
  quantity: 1,
  purchaseIntent: false,
  needsSize: false,
  needsColor: false,
  phone: "",
  customerName: "",
  address: "",
  province: "",
  quotedTotal: null,
  pending: null,
  openObjection: "",
  askCount: {},
};

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Đọc trạng thái từ cột JSON, chịu được dữ liệu cũ / hỏng: thiếu trường thì về mặc định an toàn. */
export function parseSalesState(raw: unknown): SalesState {
  if (!raw || typeof raw !== "object") return { ...EMPTY_SALES_STATE };
  const v = raw as Record<string, unknown>;
  const pendingRaw = v.pending;
  let pending: PendingConfirmation | null = null;
  if (pendingRaw && typeof pendingRaw === "object") {
    const p = pendingRaw as Record<string, unknown>;
    if (str(p.sentAt) && str(p.fingerprint)) {
      pending = {
        sentAt: str(p.sentAt),
        fingerprint: str(p.fingerprint),
        summary: str(p.summary),
        variantId: str(p.variantId),
        quantity: num(p.quantity, 1),
        total: num(p.total, 0),
      };
    }
  }
  const askCount: Record<string, number> = {};
  if (v.askCount && typeof v.askCount === "object") {
    for (const [k, n] of Object.entries(v.askCount as Record<string, unknown>)) askCount[k] = num(n, 0);
  }
  return {
    productId: str(v.productId) || null,
    productName: str(v.productName),
    variantId: str(v.variantId) || null,
    variantLabel: str(v.variantLabel),
    size: str(v.size),
    color: str(v.color),
    quantity: Math.max(1, num(v.quantity, 1)),
    purchaseIntent: Boolean(v.purchaseIntent),
    needsSize: Boolean(v.needsSize),
    needsColor: Boolean(v.needsColor),
    phone: str(v.phone),
    customerName: str(v.customerName),
    address: str(v.address),
    province: str(v.province),
    quotedTotal: v.quotedTotal === null || v.quotedTotal === undefined ? null : num(v.quotedTotal, 0),
    pending,
    openObjection: str(v.openObjection),
    askCount,
  };
}

export function parseStage(raw: unknown): SalesStage {
  const value = String(raw ?? "");
  return (SALES_STAGES as readonly string[]).includes(value) ? (value as SalesStage) : "NEW_LEAD";
}

/**
 * Dấu vân tay của một bản chốt. Đổi mẫu mã, số lượng, SĐT hay địa chỉ là ĐỔI ĐƠN — bản chốt cũ
 * không còn hiệu lực, và một chữ "ok" gửi sau đó không được tính cho đơn mới.
 */
export function confirmationFingerprint(state: Pick<SalesState, "variantId" | "quantity" | "phone" | "address" | "province" | "quotedTotal">): string {
  return [state.variantId ?? "", state.quantity, state.phone, state.address.trim().toLowerCase(), state.province.trim().toLowerCase(), state.quotedTotal ?? ""].join("|");
}

/** Đếm số lần đã hỏi một thứ; quá ngưỡng là dấu hiệu máy đang bí, phải chuyển người. */
export function bumpAsk(state: SalesState, key: string): SalesState {
  return { ...state, askCount: { ...state.askCount, [key]: (state.askCount[key] ?? 0) + 1 } };
}

export const MAX_SAME_ASK = 3;

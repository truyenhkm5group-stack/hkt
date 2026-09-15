/**
 * CHÍNH SÁCH ĐỔI / TRẢ — cấu trúc, có phiên bản, do NGƯỜI khai.
 *
 * Kiểm tra ERP ngày 15/09/2026: không có chỗ nào phát biểu chính sách đổi trả với khách.
 * `lib/constants/case-semantics.ts` biết ĐỊNH TUYẾN một ca đổi hàng (ca này có hợp lệ không, ai
 * xử lý), nhưng đó là luật nội bộ — nó không nói với khách "bao nhiêu ngày", "ai chịu phí chiều
 * về". Hai chuyện khác nhau, và suy cái sau từ cái trước là bịa một cam kết.
 *
 * ─── VÌ SAO CÓ CẤU TRÚC CHỨ KHÔNG PHẢI MỘT Ô CHỮ ───
 *
 * Một ô chữ tự do thì máy chỉ đọc lại được nguyên văn. Khách hỏi "đổi màu được không" mà ô chữ
 * viết về đổi size thì máy hoặc trả lời lạc, hoặc im. Tách từng nhánh ra thì mỗi câu hỏi có đúng
 * một ô trả lời nó, và ô nào chưa khai thì CHỈ nhánh ấy phải chuyển người.
 *
 * ─── KHÔNG SUY CHÍNH SÁCH TỪ CHAT CŨ ───
 *
 * Tin nhắn cũ của shop có thể có câu "đổi trong 7 ngày nhé" — đó là một nhân viên nói với một
 * khách trong một hoàn cảnh, không phải chính sách. Máy đọc nó rồi nói lại với 500 khách khác là
 * biến một câu ứng khẩu thành cam kết của shop.
 */

export const EXCHANGE_KINDS = ["SIZE", "COLOR", "PRODUCT"] as const;
export type ExchangeKind = (typeof EXCHANGE_KINDS)[number];

export const EXCHANGE_KIND_LABEL: Record<ExchangeKind, string> = {
  SIZE: "Đổi size",
  COLOR: "Đổi màu",
  PRODUCT: "Đổi sang mẫu khác",
};

/** Ai chịu phí vận chuyển chiều đổi. `UNSET` = CHƯA KHAI, không phải "miễn phí". */
export const SHIP_PAYERS = ["UNSET", "SHOP", "CUSTOMER", "SHARED"] as const;
export type ShipPayer = (typeof SHIP_PAYERS)[number];

export const SHIP_PAYER_LABEL: Record<ShipPayer, string> = {
  UNSET: "chưa khai",
  SHOP: "shop chịu",
  CUSTOMER: "khách chịu",
  SHARED: "mỗi bên một nửa",
};

/** Một nhánh đổi. `allowed = null` nghĩa là CHƯA KHAI — khác hẳn `false` (đã khai là KHÔNG hỗ trợ). */
export type ExchangeBranch = {
  allowed: boolean | null;
  /** Số ngày kể từ lúc khách nhận hàng. `null` = chưa khai. */
  days: number | null;
  /** Điều kiện để được đổi, ví dụ "còn nguyên tem, chưa giặt". Rỗng = chưa khai. */
  conditions: string;
  shipPayer: ShipPayer;
};

export type SalesPolicy = {
  exchange: Record<ExchangeKind, ExchangeBranch>;
  /** Hàng lỗi do shop — thường khác hẳn nhánh đổi thường, nên tách riêng. */
  shopFault: { allowed: boolean | null; days: number | null; conditions: string; shipPayer: ShipPayer };
  /** Trả hàng lấy lại tiền. Nhiều shop KHÔNG hỗ trợ, và "không hỗ trợ" là một câu trả lời hợp lệ. */
  refund: { allowed: boolean | null; days: number | null; conditions: string; shipPayer: ShipPayer };
  /** Các trường hợp KHÔNG hỗ trợ, khai tường minh. Máy nói được "trường hợp này bên em không nhận". */
  notSupported: string[];
};

const NHANH_RONG: ExchangeBranch = { allowed: null, days: null, conditions: "", shipPayer: "UNSET" };

/** MẶC ĐỊNH TRỐNG HOÀN TOÀN — và không được thêm giá trị mẫu nào. Xem ghi chú đầu tệp. */
export const EMPTY_SALES_POLICY: SalesPolicy = {
  exchange: { SIZE: { ...NHANH_RONG }, COLOR: { ...NHANH_RONG }, PRODUCT: { ...NHANH_RONG } },
  shopFault: { ...NHANH_RONG },
  refund: { ...NHANH_RONG },
  notSupported: [],
};

/** Một nhánh đã khai đủ để trả lời khách chưa: phải biết CÓ/KHÔNG, và nếu có thì phải biết mấy ngày. */
export function branchAnswerable(b: ExchangeBranch): boolean {
  if (b.allowed === null) return false;
  if (b.allowed === false) return true; // "bên em không nhận đổi" là một câu trả lời đầy đủ
  return b.days !== null;
}

/** Chính sách đã đủ để máy trả lời câu "đổi trả thế nào": ít nhất nhánh SIZE phải trả lời được. */
export function policyAnswerable(p: SalesPolicy | null): boolean {
  return Boolean(p && branchAnswerable(p.exchange.SIZE));
}

/** Đếm số nhánh đã khai — để hiện tiến độ, không để quyết định. */
export function policyFilled(p: SalesPolicy | null): number {
  if (!p) return 0;
  const ds = [p.exchange.SIZE, p.exchange.COLOR, p.exchange.PRODUCT, p.shopFault, p.refund];
  return ds.filter(branchAnswerable).length;
}

/**
 * Dựng câu trả lời cho MỘT nhánh, từ chính các ô đã khai. HÀM THUẦN.
 *
 * Trả `null` khi nhánh chưa khai — nơi gọi phải chuyển người, chứ không nhận về một câu chung
 * chung nghe như đã trả lời.
 */
export function branchSentence(kind: ExchangeKind | "SHOP_FAULT" | "REFUND", b: ExchangeBranch): string | null {
  if (!branchAnswerable(b)) return null;
  const ten =
    kind === "SHOP_FAULT" ? "hàng lỗi do bên em" : kind === "REFUND" ? "trả hàng hoàn tiền" : EXCHANGE_KIND_LABEL[kind].toLowerCase();
  if (b.allowed === false) return `${ten} thì bên em chưa hỗ trợ ạ`;
  const phan = [`${ten} được trong ${b.days} ngày kể từ khi chị nhận hàng`];
  if (b.conditions) phan.push(b.conditions);
  if (b.shipPayer !== "UNSET") phan.push(`phí ship đổi ${SHIP_PAYER_LABEL[b.shipPayer]}`);
  return phan.join(", ");
}

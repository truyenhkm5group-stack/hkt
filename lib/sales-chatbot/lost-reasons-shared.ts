/**
 * ═══════════ VÌ SAO KHÁCH KHÔNG MUA — PHÂN LOẠI LÚC ĐỌC (docs/product-audit.md P6) ═══════════
 *
 * Không đổi công cụ của bot (đổi lược đồ công cụ là đổi thứ model đang thấy khi nói với khách thật): lý do suy từ sổ sự kiện
 * ĐÃ CÓ, bằng hàm THUẦN có phiên bản. Không lưu nhãn nào ⇒ không có nhãn người xác nhận nào để ghi đè; sửa luật là tăng
 * `LOST_REASON_VERSION`, không viết lại dữ liệu.
 *
 * Một hội thoại có khách nhắn trong kỳ là «KHÔNG MUA» khi KHÔNG có đơn (bot chốt / người lên / người chốt) VÀ đã ngã ngũ:
 *  · khách TỪ CHỐI RÕ (`conversation.declined`) ⇒ phân loại câu lý do bằng luật từ khoá; không khớp ⇒ `OTHER`;
 *  · đã CHUYỂN NGƯỜI mà ERP không thấy đơn ⇒ `HANDED_TO_HUMAN` — nhân viên có thể đã bán trên kênh khác, nên đây KHÔNG phải
 *    kết luận «mất khách», chỉ là «ngoài tầm đo của bot»;
 *  · khách IM quá khung nhắn của kênh (24 giờ — sau đó bot không còn được nhắn) ⇒ sau báo giá / chưa báo giá (SUY RA).
 * Còn trong khung 24 giờ và chưa từ chối ⇒ CHƯA NGÃ NGŨ (`null`), không phải «mất».
 */

export const LOST_REASON_VERSION = 1;

export const LOST_REASONS = [
  "PRICE_TOO_HIGH",
  "SHIPPING_COST",
  "OUT_OF_STOCK",
  "SIZE_UNAVAILABLE",
  "PRODUCT_NOT_SUITABLE",
  "CUSTOMER_DELAYED",
  "BOUGHT_ELSEWHERE",
  "OTHER",
  "HANDED_TO_HUMAN",
  "NO_RESPONSE_AFTER_PRICE",
  "NO_RESPONSE",
] as const;
export type LostReason = (typeof LOST_REASONS)[number];

export const LOST_REASON_LABEL: Record<LostReason, string> = {
  PRICE_TOO_HIGH: "Chê giá cao",
  SHIPPING_COST: "Ngại phí ship / giao hàng",
  OUT_OF_STOCK: "Hết hàng",
  SIZE_UNAVAILABLE: "Không có size / quy cách hợp",
  PRODUCT_NOT_SUITABLE: "Sản phẩm không hợp",
  CUSTOMER_DELAYED: "Để sau / còn suy nghĩ",
  BOUGHT_ELSEWHERE: "Đã mua chỗ khác",
  OTHER: "Từ chối — lý do khác",
  HANDED_TO_HUMAN: "Chuyển người, ERP không thấy đơn",
  NO_RESPONSE_AFTER_PRICE: "Im lặng sau khi nghe giá",
  NO_RESPONSE: "Im lặng, chưa tới bước báo giá",
};

/** Căn cứ của nhãn: khách nói rõ + khớp từ khoá · khách nói rõ, không khớp · chuyển người · suy ra từ im lặng. */
export type LostBasis = "DECLINED_MATCHED" | "DECLINED_UNMATCHED" | "HANDOFF" | "SILENCE";

/** Khung nhắn của kênh (Facebook 24 giờ). Quá khung bot không được nhắn nữa ⇒ hội thoại im lặng mới được coi là đã ngã ngũ. */
export const LOST_SILENCE_MS = 24 * 3_600_000;

/** Bỏ dấu + thường hoá để so từ khoá tiếng Việt. HÀM THUẦN. */
export function foldText(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "d").toLowerCase();
}

/**
 * Luật từ khoá theo THỨ TỰ (khớp đầu tiên thắng): lý do cụ thể đứng trước lý do chung. Viết CÓ DẤU. Câu lý do do model viết
 * (có dấu) nhưng khách cũng hay gõ không dấu ⇒ so thêm bản bỏ dấu — TRỪ từ mơ hồ khi bỏ dấu: «đắt» / «đặt» cùng thành `dat`,
 * «mắc» / «mặc» cùng thành `mac`; «khách không đặt nữa» không được thành «chê giá».
 */
const RULES: readonly { code: Exclude<LostReason, "OTHER" | "HANDED_TO_HUMAN" | "NO_RESPONSE_AFTER_PRICE" | "NO_RESPONSE">; words: readonly string[] }[] = [
  { code: "SHIPPING_COST", words: ["phí ship", "tiền ship", "phí giao", "ship đắt", "ship cao", "vận chuyển", "cước ship"] },
  { code: "OUT_OF_STOCK", words: ["hết hàng", "không còn hàng", "hết màu", "không có hàng"] },
  { code: "SIZE_UNAVAILABLE", words: ["size", "không vừa", "không có cỡ", "hết cỡ", "quy cách"] },
  { code: "BOUGHT_ELSEWHERE", words: ["mua chỗ khác", "mua nơi khác", "mua rồi", "đã mua", "bên khác"] },
  { code: "PRICE_TOO_HIGH", words: ["đắt", "giá cao", "mắc", "không đủ tiền", "chát", "rẻ hơn", "chê giá"] },
  { code: "CUSTOMER_DELAYED", words: ["suy nghĩ", "để sau", "lần sau", "cuối tháng", "khi khác", "chưa cần", "tham khảo", "hỏi chồng", "hỏi vợ"] },
  { code: "PRODUCT_NOT_SUITABLE", words: ["không hợp", "không thích", "không phù hợp", "không đẹp", "không giống"] },
];
/** Từ KHÔNG được so ở bản bỏ dấu (bỏ dấu là trùng một từ nghĩa khác). */
const AMBIGUOUS_WHEN_FOLDED = new Set(["đắt", "mắc", "chát"]);

const spaced = (s: string) => ` ${s.replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

/** Phân loại câu lý do từ chối. `evidence` = từ khoá khớp (để người đọc thấy vì sao). HÀM THUẦN. */
export function classifyDeclineText(text: string): { code: LostReason; evidence: string | null } {
  const raw = spaced(text.normalize("NFC").toLowerCase());
  const folded = spaced(foldText(text));
  for (const r of RULES) {
    for (const w of r.words) {
      if (raw.includes(` ${w} `)) return { code: r.code, evidence: w };
      if (!AMBIGUOUS_WHEN_FOLDED.has(w) && folded.includes(` ${foldText(w)} `)) return { code: r.code, evidence: w };
    }
  }
  return { code: "OTHER", evidence: null };
}

export type LostFacts = {
  /** Có đơn trong kỳ (bot chốt · người lên / chốt). */
  ordered: boolean;
  /** Câu lý do của lần từ chối gần nhất; `null` = không từ chối rõ. */
  declinedReason: string | null;
  handedOff: boolean;
  quoted: boolean;
  /** Tin khách cuối cùng. */
  lastCustomerAt: Date;
};

/** Lý do không mua của một hội thoại; `null` = đã mua hoặc CHƯA NGÃ NGŨ. HÀM THUẦN. */
export function lostReasonOf(f: LostFacts, now: Date): { code: LostReason; basis: LostBasis; evidence: string | null } | null {
  if (f.ordered) return null;
  if (f.declinedReason !== null) {
    const c = classifyDeclineText(f.declinedReason);
    return { code: c.code, basis: c.evidence ? "DECLINED_MATCHED" : "DECLINED_UNMATCHED", evidence: c.evidence };
  }
  if (now.getTime() - f.lastCustomerAt.getTime() < LOST_SILENCE_MS) return null;
  if (f.handedOff) return { code: "HANDED_TO_HUMAN", basis: "HANDOFF", evidence: null };
  return { code: f.quoted ? "NO_RESPONSE_AFTER_PRICE" : "NO_RESPONSE", basis: "SILENCE", evidence: null };
}

export type LostReport = {
  /** Hội thoại có khách nhắn trong kỳ — mẫu số chung với phễu. */
  conversations: number;
  ordered: number;
  open: number;
  lost: number;
  rows: { code: LostReason; label: string; count: number; share: number | null }[];
};

/** Gộp nhãn từng hội thoại thành bảng. Mọi hội thoại rơi vào ĐÚNG MỘT trong: có đơn · chưa ngã ngũ · một lý do. HÀM THUẦN. */
export function lostReport(items: readonly { ordered: boolean; reason: LostReason | null }[]): LostReport {
  const counts = new Map<LostReason, number>();
  let ordered = 0;
  let open = 0;
  for (const it of items) {
    if (it.ordered) ordered += 1;
    else if (it.reason === null) open += 1;
    else counts.set(it.reason, (counts.get(it.reason) ?? 0) + 1);
  }
  const lost = items.length - ordered - open;
  const rows = LOST_REASONS.filter((c) => counts.has(c))
    .map((code) => ({ code, label: LOST_REASON_LABEL[code], count: counts.get(code)!, share: lost > 0 ? counts.get(code)! / lost : null }))
    .sort((a, b) => b.count - a.count);
  return { conversations: items.length, ordered, open, lost, rows };
}

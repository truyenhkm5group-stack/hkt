/**
 * ═══════════ KIẾN THỨC CỦA SHOP CHO CHATBOT BÁN HÀNG (sổ AIS-05) — THUẦN, CLIENT-SAFE ═══════════
 *
 * Ba ô CÓ CẤU TRÚC ở trang Cấu hình AI Sales, lưu cùng `settings['ai.salesChatbot']` (không migration):
 *  · Câu hỏi thường gặp — từng cặp hỏi → đáp;
 *  · Chính sách — bốn ô chữ: đổi trả · bảo hành · vận chuyển / giao hàng · thanh toán;
 *  · Khuyến mãi đang chạy — tên · nội dung · từ ngày · đến ngày (giờ Việt Nam, tính cả hai đầu).
 *
 * Luật bất di bất dịch của chủ shop: «AI không được bịa: giá · tồn · SKU · giảm giá · chính sách». Nên:
 *  · bot CHỈ trả lời chính sách / câu thường gặp / khuyến mãi theo ĐÚNG chữ shop khai; mục chưa khai ⇒ nói chưa có thông
 *    tin và chuyển người (`handoff_to_human`, nhóm «Ngoài chính sách») — không tự đặt chính sách;
 *  · khuyến mãi chữ chỉ là MÔ TẢ cho khách. Số tiền giảm của một đơn CHỈ từ công cụ tính giỏ (`calculate_cart` · đơn nháp ·
 *    `volume-discount.ts`). Không phép tính tiền nào đọc ô này — `tests/ai-sales-knowledge.test.ts` quét mã nguồn;
 *  · khuyến mãi hết hạn (hoặc chưa tới ngày) tự KHÔNG vào lời nhắc.
 *
 * Mọi ô rỗng (mặc định) ⇒ `knowledgePrompt` trả `""` và lời nhắc GIỐNG HỆT trước khi có tính năng này (hội thoại vàng khoá).
 */
import { vnDateKey } from "@/lib/format";

export type SalesFaqItem = { q: string; a: string };
export type SalesPolicies = { returns: string; warranty: string; shipping: string; payment: string };
/** `from` / `to` dạng YYYY-MM-DD (ngày giờ Việt Nam), `null` = không giới hạn ở đầu đó. */
export type SalesPromotion = { title: string; content: string; from: string | null; to: string | null };

export const DEFAULT_SALES_POLICIES: SalesPolicies = { returns: "", warranty: "", shipping: "", payment: "" };

/** Trần KỸ THUẬT (độ dài lời nhắc), không phải ngưỡng nghiệp vụ. */
export const SALES_KNOWLEDGE_LIMITS = { faqItems: 30, faqQuestion: 200, faqAnswer: 800, policy: 1000, promotions: 10, promoTitle: 100, promoContent: 500 } as const;

/** Thứ tự và nhãn của bốn chính sách — form và lời nhắc dùng CHUNG. */
export const SALES_POLICY_KEYS = ["returns", "warranty", "shipping", "payment"] as const satisfies readonly (keyof SalesPolicies)[];
export const SALES_POLICY_LABEL: Record<keyof SalesPolicies, string> = { returns: "Đổi trả", warranty: "Bảo hành", shipping: "Vận chuyển / giao hàng", payment: "Thanh toán" };

export type PromotionState = "ACTIVE" | "EXPIRED" | "UPCOMING";

/** Khuyến mãi so với NGÀY giờ Việt Nam của `now` — tính cả ngày bắt đầu và ngày kết thúc. HÀM THUẦN. */
export function promotionState(p: Pick<SalesPromotion, "from" | "to">, now: Date): PromotionState {
  const today = vnDateKey(now);
  if (p.to && today > p.to) return "EXPIRED";
  if (p.from && today < p.from) return "UPCOMING";
  return "ACTIVE";
}

/** Khuyến mãi ĐANG CHẠY tại `now` — chỉ những cái này được nói với khách. */
export function activePromotions(list: readonly SalesPromotion[], now: Date): SalesPromotion[] {
  return list.filter((p) => promotionState(p, now) === "ACTIVE");
}

/** Chữ shop gõ nhiều dòng ⇒ một dòng trong lời nhắc (giữ ranh giới bằng « / »), để khối không vỡ định dạng. */
const oneLine = (s: string) => s.trim().replace(/\s*\n+\s*/g, " / ");
const dmy = (key: string) => `${key.slice(8, 10)}/${key.slice(5, 7)}/${key.slice(0, 4)}`;

function promoWhen(p: SalesPromotion): string {
  if (p.from && p.to) return ` (từ ${dmy(p.from)} đến hết ${dmy(p.to)})`;
  if (p.to) return ` (đến hết ${dmy(p.to)})`;
  if (p.from) return ` (từ ${dmy(p.from)})`;
  return "";
}

/**
 * Khối KIẾN THỨC CỦA SHOP trong lời nhắc hệ thống. Không có dữ liệu nào (kể cả chỉ có khuyến mãi đã hết hạn) ⇒ `""`.
 * HÀM THUẦN: cùng cấu hình + cùng ngày ⇒ cùng chữ.
 */
export function knowledgePrompt(cfg: { faq: readonly SalesFaqItem[]; policies: SalesPolicies; promotions: readonly SalesPromotion[] }, now: Date): string {
  const policies = SALES_POLICY_KEYS.filter((k) => cfg.policies[k].trim());
  const missing = SALES_POLICY_KEYS.filter((k) => !cfg.policies[k].trim());
  const faq = cfg.faq.filter((f) => f.q.trim() && f.a.trim());
  const promos = activePromotions(cfg.promotions, now).filter((p) => p.title.trim() && p.content.trim());
  if (!policies.length && !faq.length && !promos.length) return "";
  const lines = [
    "KIẾN THỨC CỦA SHOP (chủ shop tự khai — không được trái các luật trên): câu hỏi về chính sách, câu hỏi thường gặp và khuyến mãi ⇒ trả lời ĐÚNG theo nội dung dưới đây, diễn đạt ngắn gọn nhưng KHÔNG thêm, bớt hay suy ra điều shop chưa viết.",
  ];
  if (policies.length) {
    lines.push("CHÍNH SÁCH CỦA SHOP:");
    for (const k of policies) lines.push(`  · ${SALES_POLICY_LABEL[k]}: ${oneLine(cfg.policies[k])}`);
    if (missing.length) lines.push(`  · Chưa khai riêng: ${missing.map((k) => SALES_POLICY_LABEL[k].toLowerCase()).join(", ")}.`);
  }
  if (faq.length) {
    lines.push("CÂU HỎI THƯỜNG GẶP (khách hỏi cùng ý, dù khác chữ ⇒ trả lời theo câu đáp):");
    for (const f of faq) lines.push(`  H: ${oneLine(f.q)}\n  Đ: ${oneLine(f.a)}`);
  }
  if (promos.length) {
    lines.push("KHUYẾN MÃI ĐANG CHẠY (chỉ là MÔ TẢ để nói với khách khi hỏi — đọc đúng lời mô tả, nhưng số tiền của một đơn CHỈ lấy từ calculate_cart / đơn nháp: công cụ không trừ thì KHÔNG tự trừ, KHÔNG tự tính lại tổng, KHÔNG cộng dồn khuyến mãi):");
    for (const p of promos) lines.push(`  · ${oneLine(p.title)}${promoWhen(p)}: ${oneLine(p.content)}`);
  }
  lines.push(
    "CHƯA CÓ THÔNG TIN: câu hỏi chính sách / khuyến mãi mà ở đây, «Về shop» và «Hướng dẫn thêm của shop» đều KHÔNG có ⇒ shop CHƯA có thông tin: KHÔNG tự đặt chính sách / khuyến mãi, KHÔNG đoán theo thông lệ — handoff_to_human với reason «Ngoài chính sách — <chủ đề>».",
  );
  return lines.join("\n");
}

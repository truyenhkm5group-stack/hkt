/**
 * ═══════════ MIỄN PHÍ SHIP CỦA CHATBOT BÁN HÀNG — HÀM THUẦN (03/10/2026) ═══════════
 *
 * Chủ shop Hải Sản Làng Chài 03/10/2026: «Miễn phí ship từ 1kg hoặc giá trị đơn hàng từ 300K trong nội thành Hà Nội, TP HCM
 * nên không trả lời khách như thế này: (phí ship nhân viên sẽ báo sau khi chốt đơn)». Trước đây bot chỉ biết hai trạng thái
 * — phí ship CỐ ĐỊNH hoặc «nhân viên báo sau» — và tiền trong tóm tắt (tổng thu khi giao) phải do MÁY tính, không để AI tự
 * cộng (luật 2 của bot). Nên luật miễn ship là CẤU HÌNH của từng shop (`SalesChatbotConfig.freeShipping`) và máy áp nó ở
 * đúng chỗ tính tiền (`priceLines` trong tools.ts).
 *
 * Đạt MỘT trong hai ngưỡng (tiền hàng ≥ `minSubtotal` · khối lượng ≥ `minWeightGrams`) VÀ địa chỉ thuộc `areas` ⇒ phí ship 0.
 * Khối lượng: cột `product_variants.weight` (gram); trống ⇒ đọc quy cách trong tên mẫu mã («Size 1kg», «500g»); một dòng
 * không đọc được ⇒ KHÔNG xét ngưỡng khối lượng (không đoán), chỉ còn ngưỡng tiền. Khu vực so theo TỪ (bỏ dấu, «quận 1» không
 * khớp «quận 12»). Đạt ngưỡng mà chưa có / chưa khớp địa chỉ ⇒ «miễn ship nếu giao trong …» — không khẳng định, không bịa phí.
 */
import { foldVi } from "@/lib/sales-chatbot/text";

export type FreeShippingRule = { enabled: boolean; minSubtotal: number | null; minWeightGrams: number | null; areas: string[] };
export const DEFAULT_FREE_SHIPPING: FreeShippingRule = { enabled: false, minSubtotal: null, minWeightGrams: null, areas: [] };

/** Khối lượng một mẫu mã (gram): cột weight > 0 ⇒ dùng; trống ⇒ quy cách trong tên («1kg», «0,5 kg», «500g»); không ra ⇒ `null`. */
export function variantWeightGrams(weight: number | null | undefined, ...texts: readonly string[]): number | null {
  if (typeof weight === "number" && weight > 0) return weight;
  const m = /(\d+(?:[.,]\d+)?)\s*(kg|kí|ký|ki|ky|cân|can|gram|gr|g)(?![\p{L}])/iu.exec(texts.join(" "));
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return null;
  return /^(g|gr|gram)$/i.test(m[2]) ? Math.round(n) : Math.round(n * 1000);
}

/** Địa chỉ có thuộc một khu vực miễn ship không — so theo TỪ trên chữ bỏ dấu. */
export function inFreeShipArea(address: string, areas: readonly string[]): boolean {
  const a = ` ${foldVi(address)} `;
  return areas.some((x) => {
    const k = foldVi(x);
    return Boolean(k) && a.includes(` ${k} `);
  });
}

export type ShipVerdict =
  /** Luật tắt — phí ship theo phí cố định / «báo sau» như cũ. */
  | { kind: "OFF" }
  /** Chưa đạt ngưỡng — phí ship như cũ, nói được còn thiếu bao nhiêu. */
  | { kind: "BELOW"; text: string }
  /** Đạt ngưỡng, địa chỉ chưa có / chưa khớp khu vực — miễn ship CÓ ĐIỀU KIỆN. */
  | { kind: "FREE_IF_AREA"; text: string }
  /** Đạt ngưỡng và địa chỉ thuộc khu vực (hoặc shop không giới hạn khu vực) — phí ship 0. */
  | { kind: "FREE"; text: string };

const kgText = (g: number) => (g % 1000 === 0 ? `${g / 1000}kg` : `${(g / 1000).toLocaleString("vi-VN")}kg`);

/** Câu chính sách để AI nói lại (vd «Miễn ship đơn từ 1kg hoặc từ 300.000 ₫, giao nội thành Hà Nội / TP HCM»). */
export function freeShipPolicyText(rule: FreeShippingRule, formatVnd: (n: number) => string): string {
  if (!rule.enabled) return "";
  const conds = [rule.minWeightGrams !== null ? `từ ${kgText(rule.minWeightGrams)}` : "", rule.minSubtotal !== null ? `tiền hàng từ ${formatVnd(rule.minSubtotal)}` : ""].filter(Boolean);
  const where = rule.areas.length ? `, giao trong ${rule.areas.join(" / ")}` : "";
  return `Miễn phí ship cho đơn ${conds.length ? conds.join(" hoặc ") : "mọi giá trị"}${where}`;
}

export function freeShipVerdict(rule: FreeShippingRule, subtotal: number, weightGrams: number | null, address: string | null, formatVnd: (n: number) => string): ShipVerdict {
  if (!rule.enabled || (rule.minSubtotal === null && rule.minWeightGrams === null && !rule.areas.length)) return { kind: "OFF" };
  const byAmount = rule.minSubtotal === null ? rule.minWeightGrams === null : subtotal >= rule.minSubtotal;
  const byWeight = rule.minWeightGrams !== null && weightGrams !== null && weightGrams >= rule.minWeightGrams;
  const policy = freeShipPolicyText(rule, formatVnd);
  if (!byAmount && !byWeight) {
    const gaps = [rule.minSubtotal !== null ? `thêm ${formatVnd(rule.minSubtotal - subtotal)} tiền hàng` : "", rule.minWeightGrams !== null && weightGrams !== null ? `thêm ${kgText(rule.minWeightGrams - weightGrams)}` : ""].filter(Boolean);
    return { kind: "BELOW", text: gaps.length ? `${policy} — đơn này còn thiếu ${gaps.join(" hoặc ")}` : policy };
  }
  if (!rule.areas.length || (address && inFreeShipArea(address, rule.areas))) return { kind: "FREE", text: "Miễn phí ship" };
  return { kind: "FREE_IF_AREA", text: `Miễn phí ship nếu giao trong ${rule.areas.join(" / ")}; ngoài khu vực này nhân viên báo phí ship` };
}

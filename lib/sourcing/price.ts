/**
 * ═══ GIÁ NGUỒN THEO BẬC (SRC-3) — HÀM THUẦN, CLIENT-SAFE ═══
 *
 * Tiền tệ Trung Quốc lưu bằng số nguyên FEN (1 ¥ = 100 fen), không bao giờ số thực: «12.30 ¥» là 1230, không phải
 * 12.299999. Mọi đường VÀO (`parseCnyInput`, `parsePriceTiers`) và RA (`formatCny`, `serializePriceTiers`) đi qua tệp này — không
 * chỗ nào khác được nhân / chia 100 hay đọc thẳng jsonb bậc giá.
 */
import { SOURCING_PRICE_TIERS_MAX } from "@/lib/constants/sourcing";

/** Một bậc giá: mua từ `fromQty` cái trở lên thì mỗi cái `priceFen`. */
export type PriceTier = { fromQty: number; priceFen: number };

const MAX_FEN = 100_000_000; // 1.000.000 ¥ / cái — vượt nữa là gõ nhầm
const MAX_QTY = 10_000_000;

/** Chữ người gõ («12.3», «12,30», «¥ 12.30») ⇒ fen. Âm, quá 2 số lẻ, chữ lạ ⇒ `null` (KHÔNG đoán). */
export function parseCnyInput(raw: string): number | null {
  const s = raw.replace(/[¥元\s]/g, "").replace(",", ".");
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const fen = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return fen <= MAX_FEN ? fen : null;
}

/** fen ⇒ «¥12.30». `null` ⇒ «—» (CHƯA BIẾT, AGENTS 42). Không qua số thực. */
export function formatCny(fen: number | null): string {
  if (fen === null || !Number.isInteger(fen)) return "—";
  const sign = fen < 0 ? "-" : "";
  const a = Math.abs(fen);
  return `${sign}¥${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

/**
 * Kiểm + chuẩn hoá danh sách bậc: ít nhất một bậc, `fromQty` nguyên dương TĂNG NGHIÊM NGẶT, giá nguyên fen dương. Sai ⇒ câu lỗi
 * (để người sửa), không tự sắp xếp lại / bỏ bậc — sửa hộ là đoán ý người nhập.
 */
export function validatePriceTiers(tiers: readonly PriceTier[]): string | null {
  if (!tiers.length) return "Cần ít nhất một bậc giá.";
  if (tiers.length > SOURCING_PRICE_TIERS_MAX) return `Tối đa ${SOURCING_PRICE_TIERS_MAX} bậc giá.`;
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    if (!Number.isInteger(t.fromQty) || t.fromQty < 1 || t.fromQty > MAX_QTY) return `Bậc ${i + 1}: số lượng phải là số nguyên ≥ 1.`;
    if (!Number.isInteger(t.priceFen) || t.priceFen < 1 || t.priceFen > MAX_FEN) return `Bậc ${i + 1}: giá phải lớn hơn 0.`;
    if (i > 0 && t.fromQty <= tiers[i - 1].fromQty) return `Bậc ${i + 1}: số lượng phải lớn hơn bậc trước (${tiers[i - 1].fromQty}).`;
  }
  return null;
}

/** Đọc jsonb bậc giá từ CSDL. Hình dạng sai ⇒ `null` (màn hình in «bậc giá hỏng», không in 0). */
export function parsePriceTiers(raw: unknown): PriceTier[] | null {
  if (!Array.isArray(raw)) return null;
  const out: PriceTier[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") return null;
    const { fromQty, priceFen } = r as Record<string, unknown>;
    if (typeof fromQty !== "number" || typeof priceFen !== "number") return null;
    out.push({ fromQty, priceFen });
  }
  return validatePriceTiers(out) ? null : out;
}

/** Ghi jsonb bậc giá — chỉ đúng hai khoá, đúng thứ tự. Ném nếu không hợp lệ (đường ghi đã kiểm trước, đây là chốt cuối). */
export function serializePriceTiers(tiers: readonly PriceTier[]): PriceTier[] {
  const err = validatePriceTiers(tiers);
  if (err) throw new Error(err);
  return tiers.map((t) => ({ fromQty: t.fromQty, priceFen: t.priceFen }));
}

export type PriceAtQty =
  | { kind: "PRICE"; priceFen: number; tierFrom: number; belowMoq: boolean }
  | { kind: "BELOW_LOWEST_TIER"; lowestFrom: number }
  | { kind: "UNKNOWN" };

/**
 * Giá MỖI CÁI khi mua `qty` cái: bậc có `fromQty` LỚN NHẤT mà ≤ `qty`. Dưới bậc thấp nhất ⇒ không có giá (nguồn không bán số
 * đó), KHÔNG lấy giá bậc thấp nhất. `belowMoq` khi có MOQ và `qty` < MOQ — giá vẫn in, kèm cờ.
 */
export function priceAtQty(tiers: readonly PriceTier[] | null, qty: number, moq: number | null): PriceAtQty {
  if (!tiers || !tiers.length) return { kind: "UNKNOWN" };
  let hit: PriceTier | null = null;
  for (const t of tiers) if (t.fromQty <= qty) hit = t;
  if (!hit) return { kind: "BELOW_LOWEST_TIER", lowestFrom: tiers[0].fromQty };
  return { kind: "PRICE", priceFen: hit.priceFen, tierFrom: hit.fromQty, belowMoq: moq !== null && qty < moq };
}

/** Số ×100 nguyên (điểm 480 ⇒ «4,80», tỷ lệ 9550 ⇒ «95,50») — không qua số thực. `null` ⇒ «—». */
export function formatHundredths(n: number | null): string {
  if (n === null || !Number.isInteger(n)) return "—";
  return `${Math.floor(n / 100)},${String(n % 100).padStart(2, "0")}`;
}

/** «4.8» ⇒ 480 · «95,5%» ⇒ 9550 · trống ⇒ `null` (chưa khai). Tối đa 2 số lẻ, vượt `max` / chữ lạ ⇒ "INVALID". Không qua số thực. */
export function parseHundredthsInput(raw: string, max: number): number | null | "INVALID" {
  const v = raw.trim().replace(",", ".").replace("%", "");
  if (!v) return null;
  const m = /^(\d{1,5})(?:\.(\d{1,2}))?$/.exec(v);
  if (!m) return "INVALID";
  const n = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return n <= max ? n : "INVALID";
}

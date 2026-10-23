/**
 * ═══ GIÁ VỀ VIỆT NAM ƯỚC TÍNH CHO MỘT CÁI (SRC-4 · docs/tech/ai-sourcing.md §3.3) — HÀM THUẦN, CLIENT-SAFE ═══
 *
 * Luôn là số ƯỚC TÍNH, chỉ để hiển thị — KHÔNG vào giá dự tính, KHÔNG vào giá vốn (giá vốn thật chỉ từ phiếu kho khi hàng về).
 *
 *   giá mua            = giá bậc CNY(sl) × tỷ giá
 *   cước nội địa TQ    = cước một lượt mua CNY ÷ sl × tỷ giá
 *   phí mua hộ         = phí % × GIÁ MUA                                  (căn cứ: giá mua — Tech Lead 23/10)
 *   cước TQ → VN       = cước ₫/kg × cân nặng một cái
 *   trị giá tính thuế  = giá mua + cước nội địa + cước TQ → VN            (kiểu CIF, như hải quan VN tính)
 *   thuế / phí nhập    = thuế % × trị giá tính thuế                       (một tỷ lệ gộp; tham số không tách thuế NK / VAT)
 *   khoản khác         = ₫ / cái
 *   giá về             = tổng các khoản ĐÃ LÀM TRÒN tới đồng — người đọc cộng lại đúng số in ra
 *
 * KHÔNG CÓ SỐ MẶC ĐỊNH: thiếu một tham số / cân nặng ⇒ khoản đó `null` kèm lý do, giá về `null`. Thiếu một khoản cước cấu thành
 * trị giá tính thuế ⇒ thuế cũng `null` («chưa tính được căn cứ thuế») — không lùi về giá mua. Dưới MOQ ⇒ không tính (§3.3).
 * Tỷ giá cũ ⇒ vẫn tính, kèm cờ.
 */
import { LANDED_COST_FIELDS, fxStale, landedCostMissing, type LandedCostConfig } from "@/lib/constants/sourcing";
import { fenToVnd, priceAtQty, type PriceTier } from "@/lib/sourcing/price";

export const LANDED_PARTS = ["purchase", "domestic", "agentFee", "freight", "duty", "other"] as const;
export type LandedPartKey = (typeof LANDED_PARTS)[number];
export const LANDED_PART_LABEL: Record<LandedPartKey, string> = {
  purchase: "Giá mua",
  domestic: "Cước nội địa Trung Quốc",
  agentFee: "Phí mua hộ",
  freight: "Cước Trung Quốc → Việt Nam",
  duty: "Thuế / phí nhập",
  other: "Khoản khác",
};

export type LandedPart = { vnd: number | null; missing: string | null };

export type LandedCost =
  | { kind: "NO_PRICE"; reason: string }
  | { kind: "BELOW_MOQ"; qty: number; moq: number }
  | {
      kind: "ESTIMATE";
      qty: number;
      /** `null` khi còn khoản thiếu — xem `missing`. */
      totalVnd: number | null;
      /** Câu nói vì sao chưa có tổng; rỗng khi đủ. */
      missing: string[];
      parts: Record<LandedPartKey, LandedPart>;
      /** Hai căn cứ in ra màn hình: giá mua (căn cứ phí mua hộ) và trị giá tính thuế (CIF). */
      bases: { purchaseVnd: number | null; cifVnd: number | null };
      /** `null` = chưa có ngày áp tỷ giá. */
      fxStale: boolean | null;
      /** Thuế khai đúng 0% — màn hình nói «có thể cước / kg đã bao thuế». */
      dutyDeclaredZero: boolean;
    };

const labelOf = (key: string) => LANDED_COST_FIELDS.find((f) => f.key === key)?.label ?? key;
const missingParam = (key: string) => `chưa khai «${labelOf(key)}»`;

export function landedCostAtQty(input: { tiers: readonly PriceTier[] | null; moq: number | null; weightG: number | null; qty: number; cfg: LandedCostConfig; now: Date }): LandedCost {
  const { tiers, moq, weightG, qty, cfg, now } = input;
  const price = priceAtQty(tiers, qty, moq);
  if (price.kind === "UNKNOWN") return { kind: "NO_PRICE", reason: "chưa chụp giá / bậc giá hỏng" };
  if (price.kind === "BELOW_LOWEST_TIER") return { kind: "NO_PRICE", reason: `nguồn bán từ ${price.lowestFrom} cái` };
  if (price.belowMoq && moq !== null) return { kind: "BELOW_MOQ", qty, moq };

  const rate = cfg.cnyToVnd;
  const vnd = (x: number) => Math.round(x);
  const part = (v: number | null, missing: string | null): LandedPart => (v === null ? { vnd: null, missing } : { vnd: vnd(v), missing: null });

  const purchase = part(rate === null ? null : fenToVnd(price.priceFen, rate), missingParam("cnyToVnd"));
  const domestic = part(rate === null || cfg.cnDomesticShipCny === null ? null : (cfg.cnDomesticShipCny / qty) * rate, rate === null ? missingParam("cnyToVnd") : missingParam("cnDomesticShipCny"));
  const agentFee =
    cfg.agentFeePercent === null
      ? { vnd: null, missing: missingParam("agentFeePercent") }
      : purchase.vnd === null
        ? { vnd: null, missing: "chưa có giá mua (căn cứ phí mua hộ)" }
        : part((purchase.vnd * cfg.agentFeePercent) / 100, null);
  const freight =
    cfg.intlFreightVndPerKg === null
      ? { vnd: null, missing: missingParam("intlFreightVndPerKg") }
      : weightG === null
        ? { vnd: null, missing: "chưa khai cân nặng một cái" }
        : part((cfg.intlFreightVndPerKg * weightG) / 1000, null);

  const cifParts: [LandedPart, string][] = [
    [purchase, "giá mua"],
    [domestic, "cước nội địa"],
    [freight, "cước Trung Quốc → Việt Nam"],
  ];
  const cifMissing = cifParts.filter(([p]) => p.vnd === null).map(([, name]) => name);
  const cifVnd = cifMissing.length ? null : purchase.vnd! + domestic.vnd! + freight.vnd!;
  const duty =
    cfg.dutyVatPercent === null
      ? { vnd: null, missing: missingParam("dutyVatPercent") }
      : cifVnd === null
        ? { vnd: null, missing: `thiếu ${cifMissing.join(", ")} nên chưa tính được căn cứ thuế (trị giá CIF)` }
        : part((cifVnd * cfg.dutyVatPercent) / 100, null);
  const other = part(cfg.otherVndPerUnit, missingParam("otherVndPerUnit"));

  const parts: Record<LandedPartKey, LandedPart> = { purchase, domestic, agentFee, freight, duty, other };
  const missing = [...new Set([...LANDED_PARTS.map((k) => parts[k].missing).filter((m): m is string => m !== null), ...(cfg.fxAsOf === null ? [missingParam("fxAsOf")] : [])])];
  const totalVnd = missing.length ? null : LANDED_PARTS.reduce((s, k) => s + parts[k].vnd!, 0);
  return { kind: "ESTIMATE", qty, totalVnd, missing, parts, bases: { purchaseVnd: purchase.vnd, cifVnd }, fxStale: fxStale(cfg, now), dutyDeclaredZero: cfg.dutyVatPercent === 0 };
}

/** Cấu hình rỗng hoàn toàn (B4 chưa khai) — màn hình nói một câu thay vì sáu dòng «chưa khai». */
export function landedConfigEmpty(cfg: LandedCostConfig): boolean {
  return landedCostMissing(cfg).length === LANDED_COST_FIELDS.length;
}

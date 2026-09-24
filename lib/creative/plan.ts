import { GENE_KEYS, geneSignature, type CreativeSourceKind, type GeneKey, type Genes, type SlotMode } from "@/lib/constants/creative-loop";
import { hashSeed, seededRandom, thompsonPick, type GeneStat } from "@/lib/creative/learn";

/**
 * ═══════════ LẬP LÔ NGÀY MAI — HÀM THUẦN ═══════════
 *
 * Vào: mã hàng có ảnh thật · nguồn cảm hứng · mẫu tốt đã có · thống kê gen · chữ ký các mẫu gần đây.
 * Ra: danh sách Ô, mỗi ô là một BẢN GIAO VIỆC đủ để LLM viết câu lệnh và máy sinh ảnh — cùng câu
 * "vì sao" đọc được.
 *
 * Không đọc CSDL, không gọi mạng. Hạt giống là ngày của lô ⇒ chạy lại ra ĐÚNG lô cũ.
 *
 * ─── HAI LOẠI Ô ───
 *
 *  · `EXPLOIT` — biến thể của một mẫu THẮNG / HỨA HẸN: giữ nguyên mã hàng và năm gen, đổi ĐÚNG MỘT
 *    gen. Đổi một gen mỗi lần là cách duy nhất để biết cái gì làm nên chiến thắng — đổi ba gen cùng
 *    lúc thì mẫu con thắng hay thua cũng không dạy được gì. Mẫu cha là một mẫu của vòng
 *    (`variantId`) HOẶC một quảng cáo cũ của shop (`ownAdSourceId`, nguồn `OWN_AD` đủ sáu gen + có mã
 *    hàng) — ô con của nguồn ấy ghi nó vào `inspirationSourceId`.
 *  · `EXPLORE` — ý mới: một nguồn cảm hứng ít được dùng nhất, gen đọc từ nguồn ấy, gen còn thiếu chọn
 *    bằng Thompson. Quảng cáo cũ của shop chưa đủ gen đứng TRƯỚC spy · tay · R&D: nó đã bán được.
 *
 * Chưa có mẫu tốt nào ⇒ toàn bộ lô là THĂM DÒ. Đó là đúng: khai thác một thứ chưa tồn tại là bịa.
 *
 * ─── KHÔNG ĐỦ Ô THÌ NÓI RA, KHÔNG NHỒI ───
 *
 * Trùng chữ ký (cùng mã + cùng bộ gen với một mẫu gần đây hoặc một ô khác) ⇒ thử đổi gen khác, tối
 * đa vài lần, rồi BỎ Ô và ghi vào `shortfall`. Lô 8 ô có lý do tốt hơn lô 10 ô có 2 ô lặp lại
 * chính mẫu đã thua tuần trước (cùng tinh thần mục 25: không nhồi, không cắt bớt im lặng).
 */

export type PlanProduct = {
  productId: string;
  /** Nguồn `PRODUCT_PHOTO` dùng làm gốc điểm ảnh. */
  photoSourceId: string;
  /** Số mẫu của mã này đã test trong 30 ngày — mã ít được thử được ưu tiên ở ô thăm dò. */
  recentTests: number;
};

export type PlanInspiration = {
  sourceId: string;
  kind: Exclude<CreativeSourceKind, "PRODUCT_PHOTO">;
  /** Nhãn ngắn cho câu "vì sao" (tên quảng cáo cũ…). */
  label?: string;
  productId: string | null;
  genes: Partial<Genes>;
  usedCount: number;
};

export type PlanParent = {
  /** Mẫu cha là một mẫu của vòng. Cha là quảng cáo cũ của shop ⇒ `null` và `ownAdSourceId` có giá trị. */
  variantId: string | null;
  /** Mẫu cha là nguồn `OWN_AD` (quảng cáo cũ của shop đủ sáu gen + có mã hàng). */
  ownAdSourceId?: string | null;
  productId: string;
  genes: Genes;
  verdict: "WIN" | "PROMISING";
  bookedOrders: number;
  spendVnd: number | null;
  imageId: string | null;
};

export type PlanInput = {
  batchDay: string;
  slotCount: number;
  exploreShare: number;
  products: PlanProduct[];
  inspirations: PlanInspiration[];
  parents: PlanParent[];
  stats: GeneStat[];
  recentSignatures: readonly string[];
};

export type PlannedSlot = {
  slot: number;
  mode: SlotMode;
  productId: string;
  productPhotoSourceId: string;
  inspirationSourceId: string | null;
  parentVariantId: string | null;
  /** Ảnh mẫu cha — ảnh CỦA SHOP nên được gửi điểm ảnh làm tham chiếu bố cục. */
  parentImageId: string | null;
  genes: Genes;
  mutatedGene: GeneKey | null;
  why: string;
};

export type PlanShortfall = { missing: number; reasons: string[] };

export type BatchPlan = { slots: PlannedSlot[]; shortfall: PlanShortfall | null };

const MAX_DEDUP_ATTEMPTS = 6;

/** Khoá ổn định của một mẫu cha — mẫu của vòng hoặc nguồn quảng cáo cũ. */
export function parentKey(p: Pick<PlanParent, "variantId" | "ownAdSourceId">): string {
  return p.variantId ?? `src:${p.ownAdSourceId ?? ""}`;
}

/** Xếp mẫu cha: THẮNG trước, rồi đơn trên mỗi triệu chi (mẫu chưa có chi đứng sau), rồi id cho ổn định. */
export function rankParents(parents: PlanParent[]): PlanParent[] {
  const eff = (p: PlanParent) => (p.spendVnd && p.spendVnd > 0 ? p.bookedOrders / (p.spendVnd / 1_000_000) : -1);
  return [...parents].sort((a, b) => (a.verdict === b.verdict ? 0 : a.verdict === "WIN" ? -1 : 1) || eff(b) - eff(a) || parentKey(a).localeCompare(parentKey(b)));
}

export function planBatch(input: PlanInput): BatchPlan {
  const reasons: string[] = [];
  const photoOf = new Map(input.products.map((p) => [p.productId, p.photoSourceId]));
  if (input.products.length === 0 || input.slotCount <= 0) {
    return { slots: [], shortfall: input.slotCount > 0 ? { missing: input.slotCount, reasons: ["Chưa có mã hàng nào có ảnh sản phẩm thật — máy không sinh mẫu cho sản phẩm nó không nhìn thấy."] } : null };
  }

  const rand = seededRandom(`creative:${input.batchDay}`);
  const seen = new Set(input.recentSignatures);
  const slots: PlannedSlot[] = [];
  const parents = rankParents(input.parents.filter((p) => photoOf.has(p.productId)));
  const exploitCount = parents.length > 0 ? Math.round(input.slotCount * (1 - input.exploreShare)) : 0;
  const products = [...input.products].sort((a, b) => a.recentTests - b.recentTests || a.productId.localeCompare(b.productId));
  // Quảng cáo cũ của shop (chưa đủ gen để làm mẫu cha) đứng trước: nó đã bán được, spy / tay / R&D thì chưa.
  const ownFirst = (x: PlanInspiration) => (x.kind === "OWN_AD" ? 0 : 1);
  const inspirations = [...input.inspirations].sort((a, b) => ownFirst(a) - ownFirst(b) || a.usedCount - b.usedCount || a.sourceId.localeCompare(b.sourceId));

  const accept = (s: Omit<PlannedSlot, "slot">): boolean => {
    const sig = geneSignature(s.productId, s.genes);
    if (seen.has(sig)) return false;
    seen.add(sig);
    slots.push({ ...s, slot: slots.length + 1 });
    return true;
  };

  let dupSkips = 0;

  // ─── KHAI THÁC ───
  for (let i = 0; i < exploitCount; i += 1) {
    const parent = parents[i % parents.length];
    const start = hashSeed(`${input.batchDay}:${parentKey(parent)}:${i}`) % GENE_KEYS.length;
    const fromOwnAd = parent.variantId === null;
    let placed = false;
    for (let attempt = 0; attempt < MAX_DEDUP_ATTEMPTS && !placed; attempt += 1) {
      const key = GENE_KEYS[(start + attempt) % GENE_KEYS.length];
      const genes: Genes = { ...parent.genes, [key]: thompsonPick(key, input.stats, rand, [parent.genes[key]]) };
      placed = accept({
        mode: "EXPLOIT",
        productId: parent.productId,
        productPhotoSourceId: photoOf.get(parent.productId) as string,
        // Cha là quảng cáo cũ ⇒ ghi nguồn vào `inspirationSourceId` (đường điểm ảnh đọc lại LOẠI của nó).
        inspirationSourceId: fromOwnAd ? (parent.ownAdSourceId ?? null) : null,
        parentVariantId: parent.variantId,
        parentImageId: parent.imageId,
        genes,
        mutatedGene: key,
        why: fromOwnAd
          ? `Biến thể của quảng cáo cũ của shop — ${parent.verdict === "WIN" ? "mẫu THẮNG" : "chỉ số tốt"} (${parent.bookedOrders} đơn) — chỉ đổi ${key}.`
          : `Biến thể của mẫu ${parent.verdict === "WIN" ? "THẮNG" : "hứa hẹn"} (${parent.bookedOrders} đơn) — chỉ đổi ${key}.`,
      });
    }
    if (!placed) dupSkips += 1;
  }

  // ─── THĂM DÒ ───
  const exploreCount = input.slotCount - exploitCount;
  for (let i = 0; i < exploreCount; i += 1) {
    const insp = inspirations.length > 0 ? inspirations[i % inspirations.length] : null;
    const product = insp?.productId && photoOf.has(insp.productId) ? input.products.find((p) => p.productId === insp.productId)! : products[i % products.length];
    let placed = false;
    for (let attempt = 0; attempt < MAX_DEDUP_ATTEMPTS && !placed; attempt += 1) {
      const genes = {} as Genes;
      for (const key of GENE_KEYS) {
        const given = insp?.genes[key];
        // Lượt thử lại thứ n bỏ n gen đọc từ nguồn để Thompson chọn thay — đủ để thoát khỏi chữ ký trùng.
        const keepGiven = given !== undefined && GENE_KEYS.indexOf(key) >= attempt;
        (genes as Record<GeneKey, string>)[key] = keepGiven ? (given as string) : thompsonPick(key, input.stats, rand);
      }
      placed = accept({
        mode: "EXPLORE",
        productId: product.productId,
        productPhotoSourceId: product.photoSourceId,
        inspirationSourceId: insp?.sourceId ?? null,
        parentVariantId: null,
        parentImageId: null,
        genes,
        mutatedGene: null,
        why: insp
          ? insp.kind === "OWN_AD"
            ? `Ý mới từ quảng cáo cũ của shop${insp.label ? ` «${insp.label}»` : ""} (chưa đủ gen để làm mẫu cha; đã dùng ${insp.usedCount} lần).`
            : `Ý mới từ nguồn ${insp.kind} (đã dùng ${insp.usedCount} lần).`
          : "Ý mới — chưa có nguồn cảm hứng nào, gen chọn hoàn toàn theo thống kê.",
      });
    }
    if (!placed) dupSkips += 1;
  }

  if (dupSkips > 0) reasons.push(`${dupSkips} ô bị bỏ vì mọi biến thể thử được đều trùng một mẫu gần đây — thêm ảnh đầu vào hoặc mã hàng mới để lô đủ.`);
  return { slots, shortfall: reasons.length ? { missing: input.slotCount - slots.length, reasons } : null };
}

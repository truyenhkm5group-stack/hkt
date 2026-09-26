import { GENE_KEYS, geneSignature, mockupRulesFromHistory, type CreativeSourceKind, type GeneKey, type Genes, type SlotMode, type VariantRulesSnapshot } from "@/lib/constants/creative-loop";
import { planDesigns, type DesignPlanInput, type PlannedDesign } from "@/lib/creative/design";
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
  /** Chia ô cũ (trước 24/09/2026): tỷ lệ thăm dò trên `slotCount`. Bỏ qua khi có `exploitCount` / `exploreCount`. */
  exploreShare?: number;
  /**
   * Số ô KHAI THÁC tường minh (lô mới: đúng một ô mockup cho mỗi mẫu cha trong `parents`). Có trường này
   * thì `slotCount` / `exploreShare` không dùng để chia.
   */
  exploitCount?: number;
  /** Số ô THĂM DÒ tường minh (`exploreSlots` của cấu hình). */
  exploreCount?: number;
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
  const wanted = input.exploitCount !== undefined || input.exploreCount !== undefined ? (input.exploitCount ?? 0) + (input.exploreCount ?? 0) : input.slotCount;
  if (input.products.length === 0 || wanted <= 0) {
    return { slots: [], shortfall: wanted > 0 ? { missing: wanted, reasons: ["Chưa có mã hàng nào có ảnh sản phẩm thật — máy không sinh mẫu cho sản phẩm nó không nhìn thấy."] } : null };
  }

  const rand = seededRandom(`creative:${input.batchDay}`);
  const seen = new Set(input.recentSignatures);
  const slots: PlannedSlot[] = [];
  const parents = rankParents(input.parents.filter((p) => photoOf.has(p.productId)));
  const explicit = input.exploitCount !== undefined || input.exploreCount !== undefined;
  const exploitCount = parents.length === 0 ? 0 : explicit ? Math.max(0, input.exploitCount ?? 0) : Math.round(input.slotCount * (1 - (input.exploreShare ?? 0)));
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
  const exploreCount = explicit ? Math.max(0, input.exploreCount ?? 0) : input.slotCount - exploitCount;
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
  return { slots, shortfall: reasons.length ? { missing: exploitCount + exploreCount - slots.length, reasons } : null };
}

// ───────────────────────────── LÔ HẰNG NGÀY (chủ shop 24/09/2026) ─────────────────────────────

/** Mẫu thắng chủ shop CHỌN chạy mockup hằng ngày: theo nguồn `OWN_AD` và / hoặc theo mã hàng. */
export type MockupSelection = { sourceIds: readonly string[]; productIds: readonly string[] };

/**
 * Mẫu cha cho các ô MOCKUP — hàm thuần. Nguồn `OWN_AD` được chọn ⇒ đúng mẫu cha của nguồn ấy; mã hàng
 * được chọn ⇒ mẫu cha TỐT NHẤT của chính mã ấy (`rankParents`: thắng trước, rồi đơn / triệu chi) chưa
 * bị chọn qua đường kia. Chọn mà không lập được ⇒ một câu lý do, không lặng lẽ bỏ.
 */
export function selectMockupParents(parents: PlanParent[], sel: MockupSelection, productsWithPhoto: ReadonlySet<string>): { parents: PlanParent[]; reasons: string[] } {
  const chosen: PlanParent[] = [];
  const keys = new Set<string>();
  const reasons: string[] = [];
  const usable = parents.filter((p) => productsWithPhoto.has(p.productId));
  for (const id of sel.sourceIds) {
    const p = usable.find((x) => x.ownAdSourceId === id);
    if (!p) {
      reasons.push(`Quảng cáo cũ ${id} được bật mockup nhưng chưa làm mẫu cha được (chưa đủ sáu gen, chưa gắn mã hàng, mã chưa có ảnh sản phẩm thật, hoặc nằm ngoài danh sách mã ưu tiên).`);
      continue;
    }
    if (keys.has(parentKey(p))) continue;
    keys.add(parentKey(p));
    chosen.push(p);
  }
  for (const pid of sel.productIds) {
    const p = rankParents(usable.filter((x) => x.productId === pid)).find((x) => !keys.has(parentKey(x)));
    if (!p) {
      if (!chosen.some((x) => x.productId === pid)) reasons.push(`Mã ${pid} được bật mockup nhưng chưa có mẫu cha đủ sáu gen (mẫu thắng / hứa hẹn của vòng hoặc quảng cáo cũ của shop) có ảnh sản phẩm thật.`);
      continue;
    }
    keys.add(parentKey(p));
    chosen.push(p);
  }
  return { parents: chosen, reasons };
}

/** Một ô của lô hằng ngày: ô máy lập thường, hoặc ô THIẾT KẾ (không gắn mã hàng — mẫu chưa tồn tại). */
export type ComposedSlot = Omit<PlannedSlot, "productId"> & {
  productId: string | null;
  design: PlannedDesign | null;
  /** Luật riêng của ô mockup (chụp lúc lập lô). `null` ⇒ ô dùng luật chung của lô. */
  rulesSnapshot: VariantRulesSnapshot | null;
};

export type ComposeInput = {
  batchDay: string;
  /** Số ô máy được lập = số mẫu đăng + sinh dư − số mẫu tự làm đã có. */
  budget: number;
  /** Số ô thiết kế (đã cộng sinh dư). */
  designSlots: number;
  exploreSlots: number;
  plan: PlanInput;
  mockup: MockupSelection;
  design: Omit<DesignPlanInput, "batchDay" | "count">;
  /** Chi / tin nhắn của từng mẩu QC lịch sử, theo mã — đầu vào của luật riêng ô mockup. */
  mockupHistory: ReadonlyMap<string, readonly number[]>;
};

/** Gen QUẢNG CÁO của ô thiết kế: ảnh thời trang có NGƯỜI MẪU MẶC (chủ shop 24/09) — không "không người", không trải phẳng. */
export const DESIGN_GENE_EXCLUDE: Partial<Record<GeneKey, readonly string[]>> = { model: ["NONE"], scene: ["FLATLAY"] };

/**
 * LÔ HẰNG NGÀY — hàm THUẦN, tất định theo ngày lô. Thứ tự ô = thứ tự ĐĂNG sau mẫu tự làm (chủ shop
 * 24/09/2026): THIẾT KẾ MỚI (phần chính) → MOCKUP mẫu thắng được chọn (mỗi mẫu 1 ô, luật riêng theo mã)
 * → THĂM DÒ. Ô vượt `budget` bị cắt ở CUỐI thứ tự ấy, và `shortfall` nói ra.
 */
export function composeDailyBatch(input: ComposeInput): { slots: ComposedSlot[]; shortfall: PlanShortfall | null } {
  const reasons: string[] = [];
  let missing = 0;
  const budget = Math.max(0, input.budget);

  // ─── THIẾT KẾ MỚI ───
  const designCount = Math.min(budget, Math.max(0, input.designSlots));
  const dp = planDesigns({ ...input.design, batchDay: input.batchDay, count: designCount });
  if (dp.shortfall) {
    reasons.push(...dp.shortfall.reasons);
    missing += dp.shortfall.missing;
  }
  const rand = seededRandom(`design-genes:${input.batchDay}`);
  const slots: ComposedSlot[] = dp.designs.map((d, i) => {
    const genes = {} as Genes;
    for (const key of GENE_KEYS) (genes as Record<GeneKey, string>)[key] = thompsonPick(key, input.plan.stats, rand, DESIGN_GENE_EXCLUDE[key] ?? []);
    return {
      slot: i + 1,
      mode: "DESIGN" as const,
      productId: null,
      productPhotoSourceId: d.photoSourceId,
      inspirationSourceId: null,
      parentVariantId: null,
      parentImageId: null,
      genes,
      mutatedGene: null,
      why: `Thiết kế mới ${d.code}: ${d.why}`,
      design: d,
      rulesSnapshot: null,
    };
  });

  // ─── MOCKUP + THĂM DÒ ───
  let left = budget - slots.length;
  const photo = new Set(input.plan.products.map((p) => p.productId));
  const sel = selectMockupParents(input.plan.parents, input.mockup, photo);
  reasons.push(...sel.reasons);
  missing += sel.reasons.length;
  const mockupParents = rankParents(sel.parents);
  const mockupCount = Math.min(left, mockupParents.length);
  if (mockupParents.length > mockupCount) {
    reasons.push(`${mockupParents.length - mockupCount} mockup bị cắt vì chạm số ô tối đa của lô (thiết kế mới và mẫu tự làm đứng trước).`);
    missing += mockupParents.length - mockupCount;
  }
  left -= mockupCount;
  const exploreCount = Math.min(left, Math.max(0, input.exploreSlots));
  if (mockupCount + exploreCount > 0) {
    const pb = planBatch({ ...input.plan, parents: mockupParents.slice(0, mockupCount), exploitCount: mockupCount, exploreCount });
    if (pb.shortfall) {
      reasons.push(...pb.shortfall.reasons);
      missing += pb.shortfall.missing;
    }
    for (const s of pb.slots) {
      const exploit = s.mode === "EXPLOIT";
      slots.push({
        ...s,
        slot: slots.length + 1,
        why: exploit ? `Mockup hằng ngày (chủ shop chọn) — ${s.why}` : s.why,
        design: null,
        rulesSnapshot: exploit ? mockupRulesFromHistory(s.productId, input.mockupHistory.get(s.productId) ?? []) : null,
      });
    }
  }
  // Không mã nào có ảnh sản phẩm thật ⇒ nói ĐÚNG thứ còn thiếu trước mọi lý do khác: đó là việc người làm được ngay.
  if (slots.length === 0 && input.plan.products.length === 0) reasons.unshift("Chưa có mã hàng nào có ảnh sản phẩm thật (trong danh sách mã ưu tiên, nếu có khai) — máy không sinh mẫu cho sản phẩm nó không nhìn thấy.");
  return { slots, shortfall: reasons.length ? { missing, reasons } : null };
}

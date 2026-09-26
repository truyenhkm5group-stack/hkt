import {
  DESIGN_DNA_KEYS,
  DESIGN_DNA_LABEL,
  DESIGN_DNA_PROMPT_EN,
  DESIGN_DNA_VALUE_LABEL,
  DESIGN_DNA_VERSION,
  DESIGN_DNA_VOCAB,
  DESIGN_NOVELTY,
  DESIGN_PARENT_RULES,
  DNA_NO_UPPER_BODY,
  designCode,
  dnaDifference,
  dnaSignature,
  type CreativeVerdict,
  type DesignDna,
  type DesignDnaKey,
} from "@/lib/constants/creative-loop";
import { hashSeed, sampleBeta, seededRandom } from "@/lib/creative/learn";

/**
 * ═══════════ LẬP THIẾT KẾ SẢN PHẨM MỚI — HÀM THUẦN ═══════════
 *
 * Chủ shop 24/09/2026: *"thiết kế sản phẩm mới (áo/váy chưa từng có) lấy DNA từ các mã đã bán tốt và
 * các mẩu quảng cáo lịch sử có chỉ số tốt — mẫu mới PHẢI KHÁC các mẫu cũ."*
 *
 * Không đọc CSDL, không gọi mạng, không đọc đồng hồ. Hạt giống là NGÀY LÔ ⇒ chạy lại cùng ngày ra đúng
 * các thiết kế cũ (cùng tinh thần `planBatch`).
 *
 * ─── MỘT THIẾT KẾ = LAI HAI MÃ CHA + ĐỘT BIẾN ───
 *
 *  1. CHỌN CHA MẸ theo điểm "bán tốt" (`designParentScore`, lấy mẫu có trọng số). Cha TRỘI (A) phải có
 *     ảnh sản phẩm thật: ảnh ấy là ảnh tham chiếu (chất ảnh, thương hiệu) gửi máy sinh ảnh, và giá của A
 *     là giá đề nghị. Mẹ (B) chỉ cần DNA.
 *  2. LAI từng thuộc tính: nhóm hàng theo A (thiết kế thuộc nhóm hàng shop đã bán được); thuộc tính khác
 *     lấy của A hoặc B — chọn bằng lấy mẫu Thompson trên thống kê DNA của các THIẾT KẾ ĐÃ TEST
 *     (`dnaStats`, học như `learn.ts`): giá trị thiết kế đã thắng được ưu tiên, giá trị đã thua nhiều lần
 *     tự bị bỏ, không cần xoá dữ liệu.
 *  3. ĐỘT BIẾN: mỗi thuộc tính (trừ nhóm hàng) có xác suất `mutationRate` lấy một giá trị KHÁC cả cha lẫn
 *     mẹ (Thompson trên phần còn lại của từ vựng). Thuộc tính cả hai cha mẹ đều CHƯA BIẾT ⇒ Thompson trên
 *     cả từ vựng — chưa biết không được đoán thành giá trị của ai.
 *  4. MỚI LẠ: DNA phải khác DNA của MỌI mã đang có và mọi thiết kế 30 ngày gần nhất (kể cả thiết kế vừa lập
 *     trong chính lượt này) ở ít nhất `DESIGN_NOVELTY.minDiffAttributes` thuộc tính — thuộc tính chưa biết
 *     không tính là khác (`dnaDifference`). Trượt ⇒ thử lại, mỗi lần ÉP đột biến thêm một thuộc tính.
 *
 * ─── KHÔNG ĐỦ THÌ NÓI RA, KHÔNG NHỒI ───
 *
 * Không có mã cha đủ điều kiện, hoặc thử hết lượt mà không ra thiết kế đủ mới lạ ⇒ lô ít thiết kế hơn và
 * `shortfall` nói vì sao (cùng tinh thần `planBatch` và AGENTS.md mục 25).
 */

export type DesignParent = {
  productId: string;
  /** Tên + mã hiển thị — chỉ cho câu "vì sao". */
  label: string;
  dna: Partial<DesignDna>;
  /** `designParentScore` — trọng số chọn. */
  score: number;
  /** Nguồn `PRODUCT_PHOTO` của mã (ảnh tham chiếu). `null` ⇒ mã chỉ làm được MẸ, không làm cha trội. */
  photoSourceId: string | null;
  /** Giá bán của mã (một giá duy nhất), `null` = không suy được. */
  priceVnd: number | null;
  /** Số đo làm nên điểm — chỉ để HIỂN THỊ ở ô chọn cảm hứng của gen tay; phép lập thiết kế không đọc. */
  metrics?: { delivered: number; returned: number; spendVnd: number | null; messages: number | null };
};

export type DnaObservation = { dna: DesignDna; dnaVersion: number; verdict: CreativeVerdict };

export type DnaStat = { key: DesignDnaKey; value: string; tests: number; successes: number; wins: number };

export type DesignPlanInput = {
  batchDay: string;
  count: number;
  parents: DesignParent[];
  /** DNA (một phần) của MỌI mã đang có, cùng phiên bản từ vựng. */
  existingDna: Partial<DesignDna>[];
  /** DNA của các thiết kế trong `DESIGN_NOVELTY.recentDesignDays` ngày gần nhất. */
  recentDesigns: DesignDna[];
  stats: DnaStat[];
  /** Số thứ tự đầu tiên của mã `TK-…-NN` (mặc định 1). */
  firstIndex?: number;
  /**
   * Hạt giống riêng — gen tay truyền id lượt để hai lượt cùng ngày ra hai bộ thiết kế khác nhau (và khác ô
   * thiết kế của lô cùng ngày). Bỏ trống ⇒ hạt giống là ngày lô, y như trước.
   */
  seed?: string;
};

export type PlannedDesign = {
  code: string;
  dna: DesignDna;
  /** Mã cha — TRỘI đứng đầu. */
  parentProductIds: string[];
  /** Nguồn ảnh sản phẩm thật của cha trội — ảnh tham chiếu DUY NHẤT của ô. */
  photoSourceId: string;
  /** Giá đề nghị = giá của cha trội; `null` khi không suy được (câu chữ không ghi giá). */
  priceVnd: number | null;
  mutated: DesignDnaKey[];
  /** Khác thứ gần nó nhất (mã đang có / thiết kế gần đây) ở bấy nhiêu thuộc tính. */
  minDiff: number;
  why: string;
};

export type DesignPlan = { designs: PlannedDesign[]; shortfall: { missing: number; reasons: string[] } | null };

/** Số lượt thử tối đa cho MỘT thiết kế trước khi nhận là không lập được. */
export const DESIGN_MAX_ATTEMPTS = 12;

// ───────────────────────────── HỌC TỪ THIẾT KẾ ĐÃ TEST ─────────────────────────────

/**
 * Thống kê DNA của các thiết kế đã NGÃ NGŨ — cùng một phép đếm như `geneStats`: `WIN`/`PROMISING` là
 * thành công, `KILL`/`LOSE` là thất bại, phán quyết khác (đang chạy, chưa kết luận) không dạy được gì.
 * Chỉ quan sát cùng phiên bản từ vựng DNA.
 */
export function dnaStats(observations: DnaObservation[]): DnaStat[] {
  const obs = observations.filter((o) => o.dnaVersion === DESIGN_DNA_VERSION && ["WIN", "PROMISING", "KILL", "LOSE"].includes(o.verdict));
  const out: DnaStat[] = [];
  for (const key of DESIGN_DNA_KEYS) {
    for (const value of DESIGN_DNA_VOCAB[key] as readonly string[]) {
      const s: DnaStat = { key, value, tests: 0, successes: 0, wins: 0 };
      for (const o of obs) {
        if (o.dna[key] !== value) continue;
        s.tests += 1;
        if (o.verdict === "WIN" || o.verdict === "PROMISING") s.successes += 1;
        if (o.verdict === "WIN") s.wins += 1;
      }
      out.push(s);
    }
  }
  return out;
}

/** Thompson trên một TẬP CON của từ vựng một thuộc tính. Tập rỗng ⇒ giá trị đầu của từ vựng. */
export function thompsonPickDna<K extends DesignDnaKey>(key: K, candidates: readonly string[], stats: DnaStat[], rand: () => number): DesignDna[K] {
  const pool = candidates.length ? candidates : (DESIGN_DNA_VOCAB[key] as readonly string[]);
  let best = pool[0];
  let bestScore = -1;
  for (const value of pool) {
    const s = stats.find((x) => x.key === key && x.value === value);
    const succ = s?.successes ?? 0;
    const score = sampleBeta(1 + succ, 1 + (s?.tests ?? 0) - succ, rand);
    if (score > bestScore) {
      bestScore = score;
      best = value;
    }
  }
  return best as DesignDna[K];
}

// ───────────────────────────── CÂU LỆNH ẢNH ─────────────────────────────

/**
 * Mô tả tiếng Anh TẤT ĐỊNH của một thiết kế — gắn vào câu lệnh ảnh bởi mã nguồn (`writer.ts`), không
 * nhờ LLM nhớ. Một thiết kế mang nhãn "cổ vuông" mà ảnh ra cổ tròn thì mọi phép học sau đó đếm sai.
 */
export function designPromptEn(dna: DesignDna): string {
  const P = DESIGN_DNA_PROMPT_EN;
  const parts = [P.silhouette[dna.silhouette], P.length[dna.length], P.neckline[dna.neckline], P.sleeve[dna.sleeve], `made of ${P.material[dna.material]}`, P.pattern[dna.pattern], `in ${P.colorFamily[dna.colorFamily]}`, `with ${P.detail[dna.detail]}`, P.style[dna.style]].filter(Boolean);
  return `NEW GARMENT DESIGN (does not exist yet): ${P.category[dna.category]} — ${parts.join(", ")}. Worn by a Vietnamese model, commercial fashion e-commerce photo.`;
}

/** Câu tiếng Việt ngắn của một DNA — cho câu "vì sao", ghi chú câu chữ, màn hình. */
export function describeDnaVi(dna: Partial<DesignDna>): string {
  return DESIGN_DNA_KEYS.filter((k) => dna[k] !== undefined && !(dna[k] === "NONE" && (k === "neckline" || k === "sleeve")))
    .map((k) => (DESIGN_DNA_VALUE_LABEL[k] as Record<string, string>)[dna[k] as string])
    .join(" · ");
}

// ───────────────────────────── LẬP THIẾT KẾ ─────────────────────────────

/** Lấy mẫu có trọng số (trọng số = điểm). Tất định theo `rand`. */
function weightedPick(pool: DesignParent[], rand: () => number): DesignParent | null {
  if (pool.length === 0) return null;
  const total = pool.reduce((s, p) => s + Math.max(0, p.score), 0);
  if (total <= 0) return pool[Math.floor(rand() * pool.length) % pool.length];
  let r = rand() * total;
  for (const p of pool) {
    r -= Math.max(0, p.score);
    if (r <= 0) return p;
  }
  return pool[pool.length - 1];
}

/** Cổ / tay theo nhóm hàng: quần, short, chân váy không có cổ / tay; áo, đầm thì phải có giá trị thật. */
function coherent(dna: DesignDna, stats: DnaStat[], rand: () => number): DesignDna {
  const out = { ...dna };
  if (DNA_NO_UPPER_BODY.includes(out.category)) {
    out.neckline = "NONE";
    out.sleeve = "NONE";
    return out;
  }
  if (out.sleeve === "NONE") out.sleeve = thompsonPickDna("sleeve", (DESIGN_DNA_VOCAB.sleeve as readonly string[]).filter((v) => v !== "NONE"), stats, rand);
  return out;
}

/**
 * Lập `count` thiết kế cho lô `batchDay` — xem đầu tệp. Hàm THUẦN.
 */
export function planDesigns(input: DesignPlanInput): DesignPlan {
  const reasons: string[] = [];
  if (input.count <= 0) return { designs: [], shortfall: null };
  // Mẹ: mọi mã có nhóm hàng đọc được. Cha trội: thêm điều kiện có ảnh sản phẩm thật.
  const sorted = [...input.parents].filter((p) => p.dna.category !== undefined && p.score > 0).sort((a, b) => b.score - a.score || a.productId.localeCompare(b.productId));
  const dominantPool = sorted.filter((p) => p.photoSourceId !== null);
  if (dominantPool.length === 0) {
    return {
      designs: [],
      shortfall: {
        missing: input.count,
        reasons: [
          sorted.length === 0
            ? "Chưa có mã nào đủ điều kiện làm mã cha: cần mã bán tốt (đơn giao thành công / chi tin nhắn tốt) VÀ đã đọc được DNA — DNA được đọc dần mỗi lượt dựng lô."
            : "Các mã bán tốt đã có DNA nhưng chưa mã nào có ẢNH SẢN PHẨM THẬT (nguồn PRODUCT_PHOTO) — ảnh ấy là ảnh tham chiếu bắt buộc của ô thiết kế. Bấm “Nhập ảnh sản phẩm từ Pancake”.",
        ],
      },
    };
  }

  const rand = seededRandom(input.seed === undefined ? `design:${input.batchDay}` : `design:${input.seed}`);
  const seedKey = input.seed ?? input.batchDay;
  const accepted: PlannedDesign[] = [];
  const seen = new Set<string>();
  const others: Partial<DesignDna>[] = [...input.existingDna, ...input.recentDesigns];
  let notNovel = 0;
  const first = input.firstIndex ?? 1;
  const mutable = DESIGN_DNA_KEYS.filter((k) => k !== "category");

  for (let i = 0; i < input.count; i += 1) {
    let placed = false;
    for (let attempt = 0; attempt < DESIGN_MAX_ATTEMPTS && !placed; attempt += 1) {
      const a = weightedPick(dominantPool, rand) as DesignParent;
      const b = weightedPick(
        sorted.filter((p) => p.productId !== a.productId),
        rand,
      );
      // Lượt thử lại thứ n ÉP đột biến n thuộc tính (chọn tất định) — đủ để thoát khỏi một DNA trùng.
      const start = hashSeed(`${seedKey}:${i}:${attempt}`) % mutable.length;
      const forced = new Set(Array.from({ length: Math.min(attempt, mutable.length) }, (_, j) => mutable[(start + j) % mutable.length]));
      const child = { category: a.dna.category } as DesignDna;
      const mutated: DesignDnaKey[] = [];
      for (const k of mutable) {
        const pv = [...new Set([a.dna[k], b?.dna[k]].filter((x): x is NonNullable<typeof x> => x !== undefined))] as string[];
        const mutate = forced.has(k) || rand() < DESIGN_PARENT_RULES.mutationRate || pv.length === 0;
        if (mutate) {
          const rest = (DESIGN_DNA_VOCAB[k] as readonly string[]).filter((v) => !pv.includes(v));
          (child as Record<DesignDnaKey, string>)[k] = thompsonPickDna(k, rest, input.stats, rand);
          if (pv.length > 0) mutated.push(k);
        } else {
          (child as Record<DesignDnaKey, string>)[k] = pv.length === 1 ? pv[0] : thompsonPickDna(k, pv, input.stats, rand);
        }
      }
      const dna = coherent(child, input.stats, rand);
      const sig = dnaSignature(dna);
      const pool = [...others, ...accepted.map((d) => d.dna)];
      const minDiff = pool.length ? Math.min(...pool.map((o) => dnaDifference(dna, o))) : DESIGN_DNA_KEYS.length;
      if (seen.has(sig) || minDiff < DESIGN_NOVELTY.minDiffAttributes) continue;
      seen.add(sig);
      const n = first + accepted.length;
      const mutText = mutated.length ? mutated.map((k) => DESIGN_DNA_LABEL[k].toLowerCase()).join(", ") : "không";
      accepted.push({
        code: designCode(input.batchDay, n),
        dna,
        parentProductIds: b ? [a.productId, b.productId] : [a.productId],
        photoSourceId: a.photoSourceId as string,
        priceVnd: a.priceVnd,
        mutated,
        minDiff,
        why: `Lai ${a.label} (điểm ${a.score})${b ? ` × ${b.label} (điểm ${b.score})` : " (chưa có mã thứ hai để lai)"} · đột biến: ${mutText} · khác mã / thiết kế gần nhất ở ${minDiff} thuộc tính.`,
      });
      placed = true;
    }
    if (!placed) notNovel += 1;
  }
  if (notNovel > 0) reasons.push(`${notNovel} ô thiết kế bị bỏ: thử ${DESIGN_MAX_ATTEMPTS} lần mà không ra DNA khác mọi mã đang có và mọi thiết kế ${DESIGN_NOVELTY.recentDesignDays} ngày gần nhất ở ít nhất ${DESIGN_NOVELTY.minDiffAttributes} thuộc tính — thêm mã bán tốt có DNA để máy có thêm vật liệu lai.`);
  return { designs: accepted, shortfall: reasons.length ? { missing: input.count - accepted.length, reasons } : null };
}

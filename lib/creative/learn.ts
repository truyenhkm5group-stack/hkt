import { GENE_KEYS, GENE_VOCAB, GENE_VOCAB_VERSION, type CreativeVerdict, type GeneKey, type Genes } from "@/lib/constants/creative-loop";

/**
 * ═══════════ HỌC TỪ CÁC MẪU ĐÃ NGÃ NGŨ — HÀM THUẦN ═══════════
 *
 * "Tự rút kinh nghiệm" ở đây là một phép ĐẾM có kiểm thử, không phải một đoạn văn mô hình viết:
 * với mỗi giá trị gen (vd `scene = CAFE`), bao nhiêu mẫu mang nó đã thử, bao nhiêu thành công.
 * Mô hình chỉ được DIỄN ĐẠT lại bảng này thành bản tin (`docs/creative-loop.md` §6).
 *
 * ─── THÀNH CÔNG LÀ GÌ — HAI CĂN CỨ, VÀ PHẢI NÓI RA ĐANG DÙNG CĂN CỨ NÀO ───
 *
 *  · `RULES`    — mẫu có phán quyết theo luật của chủ shop: `WIN`/`PROMISING` là thành công,
 *                 `KILL`/`LOSE` là thất bại.
 *  · `RELATIVE` — mẫu `UNJUDGED` (chưa có luật giữ) nhưng CÓ số chi: thành công khi chi/đơn không tệ
 *                 hơn TRUNG VỊ của chính nhóm ấy. Đây là căn cứ TƯƠNG ĐỐI, không phải ngưỡng — nó
 *                 không nói mẫu nào lãi, chỉ nói mẫu nào khá hơn nửa kia. Màn hình in tỷ lệ quan sát
 *                 đứng trên căn cứ này, vì học trên nó là học "đỡ tệ hơn", không phải "tốt".
 *
 * Trung vị chứ không trung bình: một mẫu may mắn ra 30 đơn kéo trung bình lên và làm mọi mẫu bình
 * thường trông như thất bại (cùng lý do với nền trung vị ở mục 52).
 *
 * ─── VÌ SAO LẤY MẪU THOMPSON ───
 *
 * Mỗi giá trị gen là một "máy đánh bạc" với tỷ lệ thành công chưa biết, ước lượng bằng phân phối
 * Beta(1 + thành công, 1 + thất bại). Mỗi lần chọn, rút MỘT mẫu ngẫu nhiên từ mỗi phân phối rồi
 * lấy giá trị lớn nhất. Giá trị chưa thử có phân phối rộng nên thỉnh thoảng thắng — đó là THĂM DÒ
 * tự nhiên, không cần một tham số "tò mò" do người đoán. Giá trị đã thử nhiều mà kém thì phân phối
 * hẹp ở thấp, gần như không bao giờ được chọn lại — đó là LOẠI mà không cần xoá dữ liệu.
 *
 * Ngẫu nhiên nhưng TẤT ĐỊNH: hạt giống là ngày của lô, nên chạy lại cùng ngày ra cùng lô (điều kiện
 * để một lượt chạy lại của job không đẻ ra lô thứ hai khác nội dung — cùng tinh thần mục 25).
 */

export type Observation = {
  variantId: string;
  productId: string;
  genes: Genes;
  genesVersion: number;
  verdict: CreativeVerdict;
  spendVnd: number | null;
  bookedOrders: number;
};

export type OutcomeBasis = "RULES" | "RELATIVE";

export type GeneStat = {
  key: GeneKey;
  value: string;
  tests: number;
  successes: number;
  wins: number;
  spendVnd: number;
  bookedOrders: number;
  /** Trung bình hậu nghiệm (1 + thành công) / (2 + số thử). Chưa thử ⇒ 0,5 — CHƯA BIẾT, in kèm `tests`. */
  posteriorMean: number;
  /** Số quan sát đứng trên căn cứ TƯƠNG ĐỐI. */
  relativeCount: number;
};

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Chi / đơn của các mẫu `UNJUDGED` có chi — nền của căn cứ tương đối. */
export function relativeBaseline(obs: Observation[]): number | null {
  return median(obs.filter((o) => o.verdict === "UNJUDGED" && o.spendVnd !== null && o.spendVnd > 0 && o.bookedOrders > 0).map((o) => (o.spendVnd as number) / o.bookedOrders));
}

/** Kết quả của MỘT quan sát. `null` = không dạy được gì (chưa ngã ngũ, hoặc không có số chi). */
export function outcomeOf(o: Observation, baselineCpo: number | null): { success: boolean; basis: OutcomeBasis } | null {
  if (o.verdict === "WIN" || o.verdict === "PROMISING") return { success: true, basis: "RULES" };
  if (o.verdict === "KILL" || o.verdict === "LOSE") return { success: false, basis: "RULES" };
  if (o.verdict !== "UNJUDGED" || o.spendVnd === null || o.spendVnd <= 0) return null;
  // Chi tiền mà 0 đơn là thất bại ở MỌI nền. Có đơn thì so với trung vị; chưa có nền ⇒ không dạy.
  if (o.bookedOrders === 0) return { success: false, basis: "RELATIVE" };
  if (baselineCpo === null) return null;
  return { success: o.spendVnd / o.bookedOrders <= baselineCpo, basis: "RELATIVE" };
}

export function geneStats(observations: Observation[]): GeneStat[] {
  const obs = observations.filter((o) => o.genesVersion === GENE_VOCAB_VERSION);
  const baseline = relativeBaseline(obs);
  const out: GeneStat[] = [];
  for (const key of GENE_KEYS) {
    for (const value of GENE_VOCAB[key] as readonly string[]) {
      const s: GeneStat = { key, value, tests: 0, successes: 0, wins: 0, spendVnd: 0, bookedOrders: 0, posteriorMean: 0.5, relativeCount: 0 };
      for (const o of obs) {
        if (o.genes[key] !== value) continue;
        const r = outcomeOf(o, baseline);
        if (!r) continue;
        s.tests += 1;
        if (r.success) s.successes += 1;
        if (r.basis === "RELATIVE") s.relativeCount += 1;
        if (o.verdict === "WIN") s.wins += 1;
        s.spendVnd += o.spendVnd ?? 0;
        s.bookedOrders += o.bookedOrders;
      }
      s.posteriorMean = (1 + s.successes) / (2 + s.tests);
      out.push(s);
    }
  }
  return out;
}

// ───────────────────────────── NGẪU NHIÊN TẤT ĐỊNH ─────────────────────────────

/** Băm chuỗi thành số 32 bit (FNV-1a). */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — đủ tốt cho việc chọn gen, và quan trọng hơn: tất định theo hạt giống. */
export function seededRandom(seed: string): () => number {
  let a = hashSeed(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function normal(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Gamma(shape ≥ 1, 1) theo Marsaglia–Tsang. */
function gamma(shape: number, rand: () => number): number {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(rand);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rand();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(Math.max(u, 1e-12)) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function sampleBeta(a: number, b: number, rand: () => number): number {
  const x = gamma(a, rand);
  const y = gamma(b, rand);
  return x / (x + y);
}

/**
 * Chọn MỘT giá trị cho một gen bằng lấy mẫu Thompson, trừ các giá trị trong `exclude`.
 * Không còn giá trị nào ⇒ trả giá trị đầu của từ vựng (không bao giờ trả `undefined`).
 */
export function thompsonPick<K extends GeneKey>(key: K, stats: GeneStat[], rand: () => number, exclude: readonly string[] = []): Genes[K] {
  const vocab = (GENE_VOCAB[key] as readonly string[]).filter((v) => !exclude.includes(v));
  if (vocab.length === 0) return GENE_VOCAB[key][0] as Genes[K];
  let best = vocab[0];
  let bestScore = -1;
  for (const value of vocab) {
    const s = stats.find((x) => x.key === key && x.value === value);
    const succ = s?.successes ?? 0;
    const fail = (s?.tests ?? 0) - succ;
    const score = sampleBeta(1 + succ, 1 + fail, rand);
    if (score > bestScore) {
      bestScore = score;
      best = value;
    }
  }
  return best as Genes[K];
}

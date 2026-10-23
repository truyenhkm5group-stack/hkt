/**
 * ═══ ĐIỂM CỦA MẪU NGUỒN (SRC-4 · docs/tech/ai-sourcing.md §3.4) — HÀM THUẦN, CLIENT-SAFE ═══
 *
 * Ba nhóm TÁCH RỜI, không gộp thành một số:
 *  · NHÀ CUNG CẤP — từng thành phần + độ phủ. Điểm tổng (0–100) CHỈ khi chủ shop khai trọng số (`sourcing.scoreWeights`); thiếu
 *    một thành phần có trọng số ⇒ tổng `null` + «thiếu: …» (không tính trên phần còn lại — tổng trên mẫu số thiếu là một số khác).
 *  · KHỚP YÊU CẦU — từ khoá Trung của câu yêu cầu (bộ sinh SRC-2) có / không có trong tên Trung của mẫu. ✓ / ✗, KHÔNG ra con số.
 *  · TIỀM NĂNG — chưa đo được: mẫu chưa gắn nhóm hàng của shop (nối dữ liệu bán hàng ở SRC-5).
 * Không tô màu, không xếp hạng khi chưa kết luận được (AGENTS 44).
 */
import { SUPPLIER_SCORE_COMPONENTS, SUPPLIER_SCORE_LABEL, scoreWeightsDeclared, type SourcingScoreWeights, type SupplierScoreComponent } from "@/lib/constants/sourcing";
import { buildChineseQueries } from "@/lib/sourcing/query";

export type SupplierFacts = { ratingX100: number | null; responseRateBp: number | null; verified: boolean | null; yearsOnPlatform: number | null };

export type SupplierScore = {
  /** Thành phần đã quy về 0–1; `null` = chưa có số. */
  components: { key: SupplierScoreComponent; label: string; normalized: number | null }[];
  coverage: { have: number; of: number };
  /** 0–100, nguyên; `null` khi chưa khai trọng số hoặc thiếu thành phần có trọng số. */
  total: number | null;
  totalNote: string;
};

export function supplierScore(f: SupplierFacts | null, w: SourcingScoreWeights): SupplierScore {
  const raw: Record<SupplierScoreComponent, number | null> = {
    rating: f?.ratingX100 == null ? null : f.ratingX100 / 500,
    responseRate: f?.responseRateBp == null ? null : f.responseRateBp / 10_000,
    verified: f?.verified == null ? null : f.verified ? 1 : 0,
    years: f?.yearsOnPlatform == null || w.yearsCap === null ? null : Math.min(f.yearsOnPlatform, w.yearsCap) / w.yearsCap,
  };
  // Độ phủ đếm SỐ ĐÃ KHAI, không phụ thuộc trần (số năm có số mà chưa có trần vẫn là «có số»).
  const has: Record<SupplierScoreComponent, boolean> = { rating: f?.ratingX100 != null, responseRate: f?.responseRateBp != null, verified: f?.verified != null, years: f?.yearsOnPlatform != null };
  const components = SUPPLIER_SCORE_COMPONENTS.map((key) => ({ key, label: SUPPLIER_SCORE_LABEL[key], normalized: raw[key] }));
  const coverage = { have: SUPPLIER_SCORE_COMPONENTS.filter((k) => has[k]).length, of: SUPPLIER_SCORE_COMPONENTS.length };
  if (!scoreWeightsDeclared(w)) return { components, coverage, total: null, totalNote: "Chưa có điểm tổng — chủ shop chưa khai trọng số." };
  const weighted = SUPPLIER_SCORE_COMPONENTS.filter((k) => (w.supplier[k] ?? 0) > 0);
  if (weighted.includes("years") && w.yearsCap === null) return { components, coverage, total: null, totalNote: "Chưa có điểm tổng — trọng số số năm cần khai trần số năm." };
  const lack = weighted.filter((k) => raw[k] === null);
  if (lack.length) return { components, coverage, total: null, totalNote: `Chưa đủ căn cứ — thiếu: ${lack.map((k) => SUPPLIER_SCORE_LABEL[k]).join(", ")}.` };
  const sumW = weighted.reduce((s, k) => s + w.supplier[k]!, 0);
  const total = Math.round((weighted.reduce((s, k) => s + w.supplier[k]! * raw[k]!, 0) / sumW) * 100);
  return { components, coverage, total, totalNote: `Theo trọng số chủ shop khai (${weighted.map((k) => `${SUPPLIER_SCORE_LABEL[k]} ${w.supplier[k]}`).join(" · ")}).` };
}

export type RequestMatch =
  | { kind: "NO_REQUEST" }
  | { kind: "NO_TITLE" }
  | { kind: "MATCH"; terms: { label: string; zh: string; hit: boolean }[]; unmatched: string[] };

/** Từ khoá Trung của câu yêu cầu có trong tên Trung của mẫu không — từng ý một, mọi từ đồng nghĩa của ý đó đều tính là có. */
export function requestMatch(request: string, titleZh: string): RequestMatch {
  if (!request.trim()) return { kind: "NO_REQUEST" };
  if (!titleZh.trim()) return { kind: "NO_TITLE" };
  const build = buildChineseQueries(request);
  const title = titleZh.replace(/\s+/g, "");
  const terms = build.terms.map((t) => {
    const found = t.zh.find((z) => title.includes(z.replace(/\s+/g, "")));
    return { label: t.label, zh: found ?? t.zh[0], hit: found !== undefined };
  });
  return { kind: "MATCH", terms, unmatched: build.unmatched };
}

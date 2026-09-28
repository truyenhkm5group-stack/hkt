/**
 * ═══════════ XẾP FANPAGE CHO MỘT CAMP — HÀM THUẦN ═══════════
 *
 * Chủ shop 28/09/2026: "Khi set camp cho mã nào sẽ hiện ưu tiên trên đầu là các fanpage đã từng ra đơn mã đó. Camp nào chạy
 * mẫu test thì ưu tiên hiện những fanpage chưa từng ra đơn nhưng đã từng chạy các mẫu tương tự."
 *
 *  · Camp MÃ WIN (`WIN`): page đã có ĐƠN XÁC NHẬN chứa mã ấy lên đầu, nhiều đơn trước.
 *  · Camp TEST: page CHƯA TỪNG có đơn xác nhận nào (mọi mã) mà ĐÃ CHẠY ADS cho mẫu TƯƠNG TỰ lên đầu.
 *    "Tương tự" = CÙNG NHÓM HÀNG theo DNA (`category`: Đầm / Áo sơ mi / Quần…) — nhóm hàng là điều kiện bắt buộc, không phải
 *    một điểm cộng (một page chạy quần không phải page hợp để test đầm dù trùng màu). Trong cùng nhóm, xếp theo số thuộc
 *    tính DNA trùng nhau (dáng · độ dài · cổ · tay · chất liệu · hoạ tiết · màu · chi tiết · phong cách) của mẫu GẦN NHẤT
 *    page đã chạy, rồi theo tiền ads đã chi cho các mẫu tương tự. Thuộc tính CHƯA BIẾT ở một bên không tính là trùng.
 *  · Mọi page còn lại GIỮ NGUYÊN thứ tự mặc định (nhiều đơn 30 ngày trước) — đây là phép ĐƯA LÊN ĐẦU, không phải sắp lại cả
 *    danh sách, và không ẩn page nào.
 *
 * Không có bằng chứng thì không đoán: mẫu chưa đọc được nhóm hàng ⇒ không xếp theo mẫu tương tự và NÓI RA (`note`).
 * Bằng chứng do máy chủ dựng (`loadFanpageEvidence`): đơn từ `orders` × `order_items` (đơn xác nhận), page của một quảng
 * cáo từ `fb_ads.story_id` (`<page_id>_<post_id>`), mã của tiền ads từ `ad_spends.product_id` (ghép từ tên chiến dịch).
 */

/** Bằng chứng fanpage cho các mã đang hiện trên màn hình. Mọi khoá là id Facebook của page / id sản phẩm. */
export type FanpageEvidence = {
  /** Page đã có ÍT NHẤT MỘT đơn xác nhận (bất kỳ mã). */
  orderedPages: string[];
  /** Số đơn xác nhận theo mã → page. Chỉ có cho mã của các ảnh đang hiện. */
  ordersByProduct: Record<string, Record<string, number>>;
  /** Page CHƯA từng có đơn xác nhận → các mã nó đã chạy ads (tiền đã chi, đồng). */
  ranByPage: Record<string, { productId: string; spendVnd: number }[]>;
  /** DNA (một phần — thuộc tính chưa đọc được thì vắng khoá) của các mã liên quan. */
  dna: Record<string, Record<string, string>>;
  /** Nhãn ngắn của mã (mã hàng hoặc tên) — để câu gợi ý nói page đã chạy mẫu nào. */
  productLabel: Record<string, string>;
};

export const EMPTY_FANPAGE_EVIDENCE: FanpageEvidence = { orderedPages: [], ordersByProduct: {}, ranByPage: {}, dna: {}, productLabel: {} };

/** Camp đang dựng: loại camp + mã của ảnh (nếu có) + DNA của ảnh (ảnh thiết kế mới mang DNA riêng, không có mã). */
export type CampPageTarget = { kind: "WIN" | "TEST"; productId: string | null; dna: Record<string, string> | null };

/** Thuộc tính DNA so trùng — mọi khoá trừ nhóm hàng (nhóm hàng là điều kiện, không phải điểm). */
const SIMILAR_KEYS = ["silhouette", "length", "neckline", "sleeve", "material", "pattern", "colorFamily", "detail", "style"] as const;

/**
 * Độ gần của hai DNA: `null` = KHÔNG tương tự (khác nhóm hàng, hoặc một bên chưa đọc được nhóm hàng); số = số thuộc tính
 * trùng (cả hai bên đều biết và bằng nhau). Hàm THUẦN.
 */
export function dnaSimilarity(a: Record<string, string> | null | undefined, b: Record<string, string> | null | undefined): number | null {
  if (!a?.category || !b?.category || a.category !== b.category) return null;
  return SIMILAR_KEYS.filter((k) => a[k] && b[k] && a[k] === b[k]).length;
}

type PageLike = { id: string };

export type RankedFanpages<P extends PageLike> = {
  /** Cùng các page vào, page ưu tiên lên đầu. `hint` = vì sao page ấy được ưu tiên (`null` = thứ tự mặc định). */
  pages: (P & { hint: string | null })[];
  /** Số page được đưa lên đầu. */
  prioritized: number;
  /** Câu nói ra khi KHÔNG xếp được (thiếu mã / thiếu DNA / chưa page nào khớp). `null` = đã xếp. */
  note: string | null;
};

const fmtVnd = (n: number) => `${Math.round(n).toLocaleString("vi-VN")}đ`;

/** Xếp fanpage cho một camp (xem đầu tệp). Hàm THUẦN, ỔN ĐỊNH: page cùng hạng giữ thứ tự vào. */
export function rankFanpagesForCamp<P extends PageLike>(pages: readonly P[], ev: FanpageEvidence, t: CampPageTarget): RankedFanpages<P> {
  const plain = (note: string | null): RankedFanpages<P> => ({ pages: pages.map((p) => ({ ...p, hint: null })), prioritized: 0, note });
  const scored: { p: P; key: number[]; hint: string }[] = [];

  if (t.kind === "WIN") {
    if (!t.productId) return plain("Ảnh không thuộc mã hàng nào — không xếp được theo đơn của mã.");
    const byPage = ev.ordersByProduct[t.productId] ?? {};
    for (const p of pages) {
      const n = byPage[p.id] ?? 0;
      if (n > 0) scored.push({ p, key: [n], hint: `${n.toLocaleString("vi-VN")} đơn mã này` });
    }
    if (scored.length === 0) return plain("Chưa fanpage nào có đơn xác nhận của mã này.");
  } else {
    const dna = t.dna ?? (t.productId ? ev.dna[t.productId] : undefined) ?? null;
    if (!dna?.category) return plain("Mẫu chưa đọc được nhóm hàng (DNA) — chưa xếp được theo mẫu tương tự.");
    const ordered = new Set(ev.orderedPages);
    for (const p of pages) {
      if (ordered.has(p.id)) continue;
      const similar = (ev.ranByPage[p.id] ?? [])
        .map((r) => ({ ...r, sim: dnaSimilarity(dna, ev.dna[r.productId]) }))
        .filter((r): r is typeof r & { sim: number } => r.sim !== null)
        .sort((a, b) => b.sim - a.sim || b.spendVnd - a.spendVnd);
      if (similar.length === 0) continue;
      const spend = similar.reduce((s, r) => s + r.spendVnd, 0);
      const names = similar.slice(0, 2).map((r) => ev.productLabel[r.productId] || r.productId);
      const more = similar.length > 2 ? ` +${similar.length - 2}` : "";
      scored.push({ p, key: [similar[0].sim, spend], hint: `chưa ra đơn · đã chạy ${similar.length} mẫu tương tự (${names.join(", ")}${more}) · ${fmtVnd(spend)}` });
    }
    if (scored.length === 0) return plain("Chưa fanpage nào chưa-ra-đơn từng chạy mẫu cùng nhóm hàng.");
  }

  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) if ((b[i] ?? 0) !== (a[i] ?? 0)) return (b[i] ?? 0) - (a[i] ?? 0);
    return 0;
  };
  const top = scored.map((s, i) => ({ ...s, i })).sort((a, b) => cmp(a.key, b.key) || a.i - b.i);
  const topIds = new Set(top.map((s) => s.p.id));
  return {
    pages: [...top.map((s) => ({ ...s.p, hint: s.hint })), ...pages.filter((p) => !topIds.has(p.id)).map((p) => ({ ...p, hint: null }))],
    prioritized: top.length,
    note: null,
  };
}

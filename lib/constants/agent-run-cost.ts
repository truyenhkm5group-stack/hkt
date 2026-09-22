/**
 * ═══════════ ĐỌC VÀ IN TIỀN CỦA MỘT LƯỢT CHẠY AGENT ═══════════
 *
 * ─── VÌ SAO CON SỐ NÀY PHẢI HIỆN RA MÀN HÌNH ───
 *
 * Ngày 22/09/2026 chủ shop hết sạch tín dụng API và hỏi *"tiền đi đâu"*. Không ai trả lời được —
 * kể cả tôi. Sổ `ai_interactions` chỉ ghi lượt gọi TRONG ERP; agent chạy trên máy GitHub Actions
 * nên KHÔNG có mặt ở đó, tức đúng thứ tiêu nhiều nhất lại là thứ duy nhất không hiện ở đâu cả.
 *
 * Tiền nay đã về tới `tech_agent_runs.metadata.chiPhi`. Nhưng **dữ liệu có mà không ai nhìn thấy
 * thì vẫn là không đo được**: chủ shop sẽ lại phát hiện bằng cách hết tiền, không phải bằng số.
 *
 * ─── BA TRẠNG THÁI, BA CÁCH IN (AGENTS.md mục 42) ───
 *
 *  · có số        → `$0,0895`
 *  · CHƯA ĐO ĐƯỢC → `—`  (lượt chạy trước bản vá 22/09, hoặc một vòng không định giá được)
 *  · chưa gọi model lần nào → `$0` THẬT
 *
 * Gộp hai trạng thái đầu thành `$0` là nói dối đúng theo hướng dễ chịu: nhìn vào thì tưởng phòng
 * này miễn phí. Bốn trong năm lượt của TECH-3 rơi vào nhóm CHƯA ĐO ĐƯỢC vì chúng chạy trước khi
 * đường ghi tiền tồn tại — và chúng phải hiện ra đúng như vậy, không được backfill (mục 8.8).
 */

export type ChiPhiLuot = {
  /** `null` = CHƯA ĐO ĐƯỢC. Khác hẳn 0. */
  usd: number | null;
  soVong: number | null;
  /** Có bản ghi chi phí hay không — phân biệt "lượt cũ không có gì" với "có ghi nhưng không định giá được". */
  coGhi: boolean;
};

const so = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Đọc chi phí từ `metadata` của một dòng lượt chạy — HÀM THUẦN, chịu được dữ liệu cũ.
 *
 * Dòng cũ không có khoá `chiPhi`; dòng mới có thể có `chiPhi: null` (runner chưa gọi model lần nào,
 * hoặc lượt hỏng trước khi định giá). Hai ca ấy KHÁC nhau và phải đọc ra khác nhau.
 */
export function docChiPhiLuot(metadata: unknown): ChiPhiLuot {
  /*
    `metadata` là cột `jsonb` — nó có thể là CHUỖI, SỐ hay mảng, không chỉ là đối tượng. Toán tử
    `in` ném lỗi trên những giá trị ấy, và một trang việc sập vì một dòng sổ lạ là cái giá quá đắt
    cho một con số phụ. Đã cắn thật khi viết bài kiểm cho chính hàm này.
  */
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return { usd: null, soVong: null, coGhi: false };
  }
  const m = metadata as Record<string, unknown>;
  if (!("chiPhi" in m) || m.chiPhi === null || typeof m.chiPhi !== "object" || Array.isArray(m.chiPhi)) {
    return { usd: null, soVong: null, coGhi: false };
  }
  const c = m.chiPhi as Record<string, unknown>;
  return { usd: so(c.usd), soVong: so(c.soVong), coGhi: true };
}

/** In tiền một lượt. `null` ra `—`, KHÔNG ra `$0` (mục 42). */
export function nhanChiPhi(c: ChiPhiLuot): string {
  if (c.usd === null) return "—";
  return `$${c.usd.toFixed(4)}`;
}

export type TongChiPhi = {
  /** Tổng phần ĐỊNH GIÁ ĐƯỢC. Là CẬN DƯỚI khi `chuaDoDuoc > 0`. */
  usd: number;
  /** Số lượt không định giá được — tổng ở trên đang thiếu chừng ấy lượt. */
  chuaDoDuoc: number;
  soLuot: number;
};

/**
 * Cộng tiền nhiều lượt — HÀM THUẦN.
 *
 * KHÔNG trả `null` khi có lượt chưa đo được: một tổng cận dưới kèm số lượt còn thiếu vẫn dùng được,
 * còn `null` thì màn hình không hiện gì và người đọc mất luôn phần đã biết. Nhưng nó phải NÓI RA
 * mình là cận dưới — cộng im lặng rồi in như một tổng đầy đủ mới là nói dối bằng phép cộng.
 */
export function congChiPhiLuot(ds: ChiPhiLuot[]): TongChiPhi {
  let usd = 0;
  let chuaDoDuoc = 0;
  for (const c of ds) {
    if (c.usd === null) chuaDoDuoc += 1;
    else usd += c.usd;
  }
  return { usd: Math.round(usd * 1_000_000) / 1_000_000, chuaDoDuoc, soLuot: ds.length };
}

/** In tổng kèm phần chưa đo được — không bao giờ in một tổng thiếu như thể nó đủ. */
export function nhanTongChiPhi(t: TongChiPhi): string {
  const tien = `$${t.usd.toFixed(4)}`;
  if (t.chuaDoDuoc === 0) return tien;
  return `${tien} (cận dưới — ${t.chuaDoDuoc}/${t.soLuot} lượt chưa đo được)`;
}

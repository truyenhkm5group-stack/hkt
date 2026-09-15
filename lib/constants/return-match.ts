/**
 * ═══════════ CHẤM ĐIỂM ỨNG VIÊN CHO MỘT KIỆN KHÔNG CÒN MÃ VẬN ĐƠN ═══════════
 *
 * Người kho cầm một cái áo. Nhãn mất. Họ biết: mã hàng Q004, màu đỏ đô, size XL — và đôi khi nhớ
 * được số điện thoại khách vì tờ phiếu gói hàng vẫn còn.
 *
 * ─── VÌ SAO MÁY KHÔNG ĐƯỢC TỰ NỐI ───
 *
 * "Q004 đỏ đô XL" là hàng BÁN CHẠY. Trong ba tháng có hàng trăm đơn khớp đúng ba thuộc tính ấy.
 * Một máy chấm điểm chọn ra đơn cao điểm nhất sẽ luôn chọn được MỘT đơn, và nó trông rất thuyết
 * phục — nhưng nó vừa gán một lượt hoàn cho một khách đã nhận hàng xong. Sai lầm đó không báo lỗi,
 * không ai phát hiện, và nó làm bẩn cả tỷ lệ hoàn của mã hàng lẫn hồ sơ của khách.
 *
 * Nên không có đường nào tự nối. Máy xếp hạng và NÓI RA vì sao — `signals` là danh sách bằng chứng
 * đã khớp, đọc được bằng tiếng người. Người kho nhìn bằng chứng rồi quyết.
 *
 * ─── HAI LOẠI BẰNG CHỨNG, KHÔNG BAO GIỜ CỘNG NGANG NHAU ───
 *
 *  · ĐỊNH DANH (mã vận đơn, mã đơn, SĐT) — trỏ tới MỘT đơn. Một mình nó đã đáng tin.
 *  · MÔ TẢ (mã hàng, màu, size, tên khách) — trỏ tới MỘT NHÓM đơn. Cộng bao nhiêu bằng chứng mô tả
 *    cũng không thành định danh: mười đơn cùng khớp cả bốn thuộc tính thì cả mười cùng điểm.
 *
 * Nên `HIGH` **bắt buộc** có ít nhất một bằng chứng định danh. Không có định danh thì trần là
 * `MEDIUM`, dù khớp hết mọi thuộc tính mô tả — đó chính là ca "hàng bán chạy" ở trên.
 *
 * ─── VÌ SAO Ở `lib/constants/`, KHÔNG PHẢI Ở `lib/returns/` ───
 *
 * Màn hình kho vẽ nhãn bằng chứng và mức tin cậy, nên nó cần CHÍNH những hằng số này. Để chúng
 * cạnh truy vấn (`lib/returns/candidate-match.ts`, có `import "@/db"`) là kéo cả trình điều khiển
 * Postgres vào gói của trình duyệt — bản dựng đứt ngay ở `Can't resolve 'dns'`. Phần THUẦN ở đây,
 * phần chạm CSDL ở kia; cả hai phía import từ một chỗ nên không thể lệch nhau (AGENTS.md mục 2).
 */

import type { ReturnProductContext } from "@/lib/returns/product-context";

export type CandidateQuery = {
  /** Mã vận đơn đọc được (có thể chỉ còn một phần trên nhãn rách). */
  tracking: string;
  /** Mã đơn Pancake (`orders.system_id`) hoặc khoá đơn. */
  orderCode: string;
  phone: string;
  customerName: string;
  sku: string;
  color: string;
  size: string;
};

export const EMPTY_CANDIDATE_QUERY: CandidateQuery = { tracking: "", orderCode: "", phone: "", customerName: "", sku: "", color: "", size: "" };

/**
 * BẰNG CHỨNG ĐÃ KHỚP — và trọng số của nó.
 *
 * Các con số này là THỨ TỰ ƯU TIÊN viết thành số, không phải xác suất. Điều duy nhất chúng phải
 * giữ: mọi bằng chứng ĐỊNH DANH phải lớn hơn TỔNG mọi bằng chứng MÔ TẢ cộng lại, để một đơn khớp
 * đủ bốn thuộc tính không bao giờ vượt được một đơn có đúng số điện thoại.
 * `tests/return-unidentified.test.ts` khoá bất biến đó.
 */
export const SIGNAL_WEIGHT = {
  /** Mã vận đơn khớp nguyên vẹn — mạnh nhất, vì mã vận đơn là duy nhất trong hệ thống ĐVVC. */
  TRACKING_EXACT: 100,
  /** Mã đơn khớp nguyên vẹn. */
  ORDER_EXACT: 95,
  /** Phần mã còn đọc được trên nhãn rách khớp — vẫn là định danh, nhưng có thể trúng nhiều kiện. */
  TRACKING_PARTIAL: 60,
  /** Số điện thoại khách khớp. Định danh yếu nhất: một khách mua nhiều lần. */
  PHONE_EXACT: 55,

  // ── Từ đây là MÔ TẢ: trỏ tới một NHÓM, không tới một đơn ──
  SKU_EXACT: 12,
  COLOR_MATCH: 5,
  SIZE_MATCH: 5,
  NAME_MATCH: 6,
  /** Vận đơn đang ở chiều hoàn / đã hoàn — đúng loại kiện mà kho đang cầm. */
  RETURNING_NOW: 8,
  /** Đơn gần đây hơn thì khả năng là kiện đang cầm cao hơn. Rất nhẹ, chỉ để phá thế hoà. */
  RECENT: 3,
} as const;

export type CandidateSignal = keyof typeof SIGNAL_WEIGHT;

/** Bằng chứng ĐỊNH DANH: trỏ tới một đơn cụ thể. Chỉ những khoá này mở được mức `HIGH`. */
export const IDENTITY_SIGNALS: readonly CandidateSignal[] = ["TRACKING_EXACT", "ORDER_EXACT", "TRACKING_PARTIAL", "PHONE_EXACT"];

export const SIGNAL_LABEL: Record<CandidateSignal, string> = {
  TRACKING_EXACT: "Đúng mã vận đơn",
  ORDER_EXACT: "Đúng mã đơn",
  TRACKING_PARTIAL: "Khớp phần mã đọc được",
  PHONE_EXACT: "Đúng số điện thoại",
  SKU_EXACT: "Đúng mã hàng",
  COLOR_MATCH: "Đúng màu",
  SIZE_MATCH: "Đúng size",
  NAME_MATCH: "Trùng tên khách",
  RETURNING_NOW: "Vận đơn đang hoàn / đã hoàn",
  RECENT: "Đơn gần đây",
};

export type Confidence = "HIGH" | "MEDIUM" | "LOW";

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  HIGH: "Rất có thể",
  MEDIUM: "Có thể",
  LOW: "Yếu",
};

export const CONFIDENCE_HINT: Record<Confidence, string> = {
  HIGH: "Có ít nhất một bằng chứng ĐỊNH DANH (mã vận đơn / mã đơn / SĐT) khớp. Vẫn phải người xác nhận.",
  MEDIUM: "Chỉ khớp mô tả hàng, hoặc định danh yếu. Đối chiếu thêm trước khi nối.",
  LOW: "Khớp rất ít. Nối ở mức này gần như chắc chắn gán nhầm cho một khách vô can.",
};

/**
 * NGƯỠNG ĐIỂM — mốc TRÌNH BÀY (chia nhóm để người đọc phân biệt), không phải ngưỡng nghiệp vụ tính
 * ra tiền. Nhưng vẫn chỉ được đổi ở đúng chỗ này, và đổi thì phải chạy lại bài kiểm bất biến.
 */
export const CONFIDENCE_SCORE = { HIGH: 55, MEDIUM: 20 } as const;

export type Candidate = {
  shipmentId: string;
  /** Mã đọc được của vận đơn — `null` khi vận đơn chưa có mã nào. */
  code: string | null;
  orderId: string | null;
  orderCode: string | null;
  receiverName: string;
  receiverPhone: string;
  stage: string;
  returnedAt: Date | null;
  orderedAt: Date | null;
  /** Hàng của đơn, dựng bằng định danh (`product-context.ts`) — để người kho đối chiếu bằng mắt. */
  ctx: ReturnProductContext;
  score: number;
  confidence: Confidence;
  signals: CandidateSignal[];
  /**
   * Vận đơn này ĐÃ ĐƯỢC ĐẾM rồi. Nối vào nó là cộng tồn lần hai cho cùng một món hàng, nên đường
   * ghi từ chối — nhưng vẫn phải HIỆN RA, vì nó thường chính là câu trả lời cho "kiện này là gì".
   */
  alreadyInspected: boolean;
};

// ───────────────────────── Chuẩn hoá ─────────────────────────

export const up = (v: string | null | undefined) => (v ?? "").trim().toUpperCase();
/** Máy quét hay chèn khoảng trắng và dấu gạch; so mã thì bỏ hết những gì không phải chữ-số. */
export const alnum = (v: string | null | undefined) => up(v).replace(/[^0-9A-Z]/g, "");
/** SĐT Việt Nam: so 9 chữ số cuối để `0987…`, `+8498…`, `8498…` cùng khớp nhau. */
export const phoneKey = (v: string | null | undefined) => {
  const d = (v ?? "").replace(/\D/g, "");
  return d.length >= 9 ? d.slice(-9) : "";
};
const fold = (v: string | null | undefined) =>
  (v ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();

/** Mã vận đơn ngắn hơn chừng này thì "khớp một phần" trúng quá nhiều kiện để có nghĩa. */
export const MIN_PARTIAL_TRACKING = 4;
/** Dưới ngưỡng này thì SĐT không đủ để khoanh vùng. */
export const MIN_PHONE = 6;

/**
 * CHẤM ĐIỂM MỘT ỨNG VIÊN — HÀM THUẦN.
 *
 * Tách khỏi truy vấn để kiểm thử được bằng dữ liệu dựng tay: luật quan trọng nhất ở đây ("mô tả
 * không bao giờ thắng định danh") phải khoá được mà không cần một cơ sở dữ liệu.
 */
export function scoreCandidate(
  q: CandidateQuery,
  c: {
    code: string | null;
    trackingCode?: string | null;
    orderReference?: string | null;
    orderId: string | null;
    orderCode: string | null;
    receiverName: string;
    receiverPhone: string;
    stage: string;
    returnedAt: Date | null;
    orderedAt: Date | null;
    items: { sku: string; name: string; color: string; size: string }[];
  },
  now = new Date(),
): { score: number; confidence: Confidence; signals: CandidateSignal[] } {
  const signals: CandidateSignal[] = [];

  const codes = [c.code, c.trackingCode, c.orderReference].map(alnum).filter(Boolean);
  const qTracking = alnum(q.tracking);
  if (qTracking) {
    if (codes.some((x) => x === qTracking)) signals.push("TRACKING_EXACT");
    else if (qTracking.length >= MIN_PARTIAL_TRACKING && codes.some((x) => x.includes(qTracking) || qTracking.includes(x))) signals.push("TRACKING_PARTIAL");
  }

  const qOrder = up(q.orderCode);
  if (qOrder && (up(c.orderCode) === qOrder || up(c.orderId) === qOrder)) signals.push("ORDER_EXACT");

  const qPhone = phoneKey(q.phone);
  if (qPhone && phoneKey(c.receiverPhone) === qPhone) signals.push("PHONE_EXACT");

  const qName = fold(q.customerName);
  if (qName.length >= 3 && fold(c.receiverName).includes(qName)) signals.push("NAME_MATCH");

  /*
    MÔ TẢ SO TRÊN TỪNG DÒNG HÀNG, KHÔNG SO CHÉO.

    Đơn có hai dòng — Q004 đỏ M và Q009 đen XL — mà so chéo thì "Q004 + XL" khớp cả hai nửa và đơn
    này trông như khớp hoàn hảo. Nó không khớp: không dòng nào của đơn là Q004 XL. Nên màu và size
    chỉ được tính TRÊN CHÍNH dòng đã khớp mã hàng.
  */
  const qSku = up(q.sku);
  const qColor = fold(q.color);
  const qSize = up(q.size);
  const skuLines = qSku ? c.items.filter((it) => up(it.sku) === qSku || up(it.sku).startsWith(`${qSku}-`) || fold(it.name).includes(fold(q.sku))) : [];
  if (qSku && skuLines.length) signals.push("SKU_EXACT");
  // Không khai mã hàng thì màu/size xét trên toàn đơn — vẫn là mô tả, vẫn không mở được `HIGH`.
  const lines = skuLines.length ? skuLines : qSku ? [] : c.items;
  if (qColor && lines.some((it) => fold(it.color) === qColor)) signals.push("COLOR_MATCH");
  if (qSize && lines.some((it) => up(it.size) === qSize)) signals.push("SIZE_MATCH");

  if (["RETURNING", "RETURNED"].includes(up(c.stage))) signals.push("RETURNING_NOW");

  const moc = c.returnedAt ?? c.orderedAt;
  if (moc && now.getTime() - moc.getTime() <= 60 * 86_400_000) signals.push("RECENT");

  const score = signals.reduce((t, k) => t + SIGNAL_WEIGHT[k], 0);
  const coDinhDanh = signals.some((k) => IDENTITY_SIGNALS.includes(k));
  /*
    TRẦN `MEDIUM` KHI KHÔNG CÓ ĐỊNH DANH.

    Đây là dòng ngăn ca "hàng bán chạy": mã hàng + màu + size + đang hoàn + gần đây cộng lại vẫn
    chỉ nói "kiện này là một trong nhóm đơn ấy", không nói là đơn nào.
  */
  const confidence: Confidence = !coDinhDanh
    ? score >= CONFIDENCE_SCORE.MEDIUM
      ? "MEDIUM"
      : "LOW"
    : score >= CONFIDENCE_SCORE.HIGH
      ? "HIGH"
      : score >= CONFIDENCE_SCORE.MEDIUM
        ? "MEDIUM"
        : "LOW";

  return { score, confidence, signals };
}


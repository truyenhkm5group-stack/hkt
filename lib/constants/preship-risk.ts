/**
 * ═══════════ CHẤM RỦI RO TRƯỚC KHI GIAO — GIẢI THÍCH ĐƯỢC TỪNG ĐIỂM ═══════════
 *
 * Đặc tả: `docs/revenue-conversion-contract.md`.
 *
 * Câu hỏi duy nhất file này trả lời: **đơn này gửi đi thì khả năng hoàn có cao hơn mặt bằng không, và
 * vì sao.** Chỉ dùng tín hiệu CÓ TRƯỚC lúc bàn giao ĐVVC.
 *
 * ─── BỐN ĐIỀU PHẢI NÓI THẲNG NGAY TỪ ĐẦU ───
 *
 * 1. **Trọng số dưới đây là GIẢ THIẾT, không phải kết quả học máy.** Người đặt ra theo hiểu biết
 *    nghiệp vụ. Việc chứng minh chúng có tách được nhóm giao thành công khỏi nhóm hoàn hay không là
 *    của `getPreshipRiskBacktest()`. Kiểm định nói KHÔNG tách được thì báo cáo phải nói KHÔNG — tuyệt
 *    đối không sửa trọng số cho tới khi số liệu đẹp rồi mới công bố.
 *
 * 2. **Điểm KHÔNG phải xác suất hoàn.** Nó là một chỉ số tương đối 0–100 để XẾP THỨ TỰ việc cần soát.
 *    Xác suất hoàn thật chỉ có sau kiểm định, theo từng nhóm, kèm cỡ mẫu.
 *
 * 3. **Không tín hiệu nào ở đây là căn cứ kết luận kết quả đơn.** Kết quả đơn chỉ có MỘT nguồn:
 *    `ORDER_OUTCOME` (`lib/queries/return-rate.ts`). Điểm rủi ro là DỰ BÁO trước khi gửi và không bao
 *    giờ được ghi vào chỗ mà báo cáo doanh thu / lương / tồn kho đọc.
 *
 * 4. **Điểm cao KHÔNG tự huỷ đơn.** Nó chỉ sinh một việc cần làm (xin cọc, gọi xác nhận). Tự huỷ đơn
 *    của khách thật vì một con số máy chấm là cách nhanh nhất để mất khách, và để mất luôn niềm tin
 *    vào chính con số đó.
 */
import { RECOMMENDATION_CONFIDENCE, type RecommendationConfidence } from "@/lib/constants/recommendation";

/** Ba mức, không nhiều hơn: thang năm mức thì không ai hành động khác nhau được. */
export type RiskBand = "LOW" | "MEDIUM" | "HIGH";

export const RISK_BAND_LABEL: Record<RiskBand, string> = {
  LOW: "Rủi ro thấp",
  MEDIUM: "Rủi ro trung bình",
  HIGH: "Rủi ro cao",
};

export const RISK_BAND_TONE: Record<RiskBand, string> = {
  LOW: "bg-muted text-muted-foreground",
  MEDIUM: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  HIGH: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
};

/** Việc cần làm theo mức. `HIGH` KHÔNG bao giờ là "huỷ đơn". */
export const RISK_BAND_ACTION: Record<RiskBand, string> = {
  LOW: "Gửi bình thường, không cần soát thêm.",
  MEDIUM: "Gọi hoặc nhắn xác nhận lại địa chỉ và thời gian nhận hàng trước khi đẩy sang ĐVVC.",
  HIGH: "Xin cọc / chuyển khoản trước, hoặc gọi xác nhận chắc chắn rồi mới gửi. KHÔNG tự huỷ đơn của khách — chỉ ghi lại kết quả liên hệ.",
};

export type RiskSignalKey =
  /** Khách này đã hoàn nhiều đơn trong chính ERP (theo SĐT, dùng kết quả đơn chuẩn). */
  | "CUSTOMER_RETURN_HISTORY"
  /** Pancake đánh dấu chặn khách này. */
  | "CUSTOMER_BLOCKED"
  /** Địa chỉ thiếu cấp hành chính hoặc quá ngắn để bưu tá tìm được. */
  | "ADDRESS_INCOMPLETE"
  /** Mẫu mã trên đơn có tỷ lệ hoàn lịch sử cao. */
  | "SKU_RETURN_HISTORY"
  /** Dãy số điện thoại sai hình dạng số Việt Nam. */
  | "PHONE_MALFORMED"
  /** Tỉnh/thành có tỷ lệ hoàn lịch sử cao. */
  | "PROVINCE_RETURN_HISTORY"
  /** Kênh đặt hàng có tỷ lệ hoàn lịch sử cao. */
  | "SOURCE_RETURN_HISTORY"
  /** Một SĐT gắn với nhiều khách khác nhau — dấu hiệu gõ sai hoặc số dùng chung. */
  | "PHONE_SHARED"
  /** SĐT chưa từng có đơn nào — khách hoàn toàn mới. */
  | "NEW_PHONE"
  /** Khách đã chuyển khoản trước — tín hiệu TỐT, trừ điểm. */
  | "PREPAID"
  /** Khách đã nhận hàng thành công nhiều lần — tín hiệu TỐT, trừ điểm. */
  | "LOYAL_CUSTOMER";

export type RiskSignalSpec = {
  key: RiskSignalKey;
  label: string;
  /** Điểm TỐI ĐA tín hiệu này góp. Số âm = tín hiệu tốt, làm giảm rủi ro. */
  maxPoints: number;
  /** Vì sao tín hiệu này có lý về nghiệp vụ. BẮT BUỘC — một trọng số không có lý do là số bịa. */
  rationale: string;
  /** Cột / biểu thức thật cấp dữ liệu. */
  source: string;
};

/**
 * BẢNG TRỌNG SỐ — chỗ DUY NHẤT được sửa khi chủ shop muốn đổi cách chấm.
 *
 * Tổng điểm dương đúng bằng 100 theo thiết kế, để `score` đọc được như "mức rủi ro tương đối".
 * Sửa xong PHẢI chạy lại kiểm định; trọng số mới chưa kiểm định thì chưa được công bố là tốt hơn.
 *
 * KHÔNG CÓ TÍN HIỆU "COD CAO" ở đây, và đó là một quyết định:
 * số tiền phải trả tại cửa là ĐỘ LỚN THIỆT HẠI, không phải XÁC SUẤT xảy ra. Trộn hai thứ vào một
 * điểm sẽ làm đơn 2 triệu của khách ruột bị soát trước đơn 300K của khách đã hoàn bốn lần — sai
 * người, sai việc. COD đi vào `expectedLossVnd`, hiện ở một dòng riêng.
 */
export const RISK_SIGNALS: RiskSignalSpec[] = [
  {
    key: "CUSTOMER_RETURN_HISTORY",
    label: "Khách đã hoàn nhiều đơn",
    maxPoints: 30,
    rationale:
      "Tín hiệu mạnh nhất, và là tín hiệu duy nhất nói về chính con người sẽ nhận kiện hàng này. Người đã từ chối nhận hàng ba lần thì lần thứ tư không phải chuyện tình cờ.",
    source: "ORDER_OUTCOME_FAST theo 9 số cuối của orders.bill_phone, LOẠI chính đơn đang chấm",
  },
  {
    key: "CUSTOMER_BLOCKED",
    label: "Pancake đánh dấu chặn",
    maxPoints: 18,
    rationale: "Có người thật đã bấm chặn khách này vì một lý do đã xảy ra. Đây là nhãn của người, không phải máy đoán.",
    source: "customers.is_block",
  },
  {
    key: "ADDRESS_INCOMPLETE",
    label: "Địa chỉ thiếu / quá ngắn",
    maxPoints: 14,
    rationale: "Bưu tá không tìm được nhà thì kiện hàng quay về, bất kể khách có muốn mua hay không. Đây là rủi ro của chứng từ, không phải của khách.",
    source: "orders.ship_province / ship_commune / ship_full_address",
  },
  {
    key: "SKU_RETURN_HISTORY",
    label: "Mẫu mã hay bị hoàn",
    maxPoints: 10,
    rationale: "Hàng thời trang hoàn vì lệch size hoặc lệch màu so với ảnh. Đó là thuộc tính của mẫu mã, lặp lại trên mọi khách.",
    source: "order_items.variant_id nối kết quả đơn trong 180 ngày",
  },
  {
    key: "PHONE_MALFORMED",
    label: "Số điện thoại sai hình dạng",
    maxPoints: 10,
    rationale: "Gọi không được thì không xác nhận được, và bưu tá cũng không liên lạc được khi tới nơi.",
    source: "orders.bill_phone / ship_phone",
  },
  {
    key: "PROVINCE_RETURN_HISTORY",
    label: "Khu vực hay bị hoàn",
    maxPoints: 7,
    rationale: "Chất lượng phát của từng bưu cục khác nhau; có vùng tỷ lệ phát lại thành công thấp hơn hẳn.",
    source: "orders.ship_province nối kết quả đơn trong 180 ngày",
  },
  {
    key: "SOURCE_RETURN_HISTORY",
    label: "Kênh hay bị hoàn",
    maxPoints: 6,
    rationale: "Đơn từ landing điền form và đơn chốt qua chat có mức cam kết rất khác nhau.",
    source: "ORDER_SOURCE nối kết quả đơn trong 180 ngày",
  },
  {
    key: "PHONE_SHARED",
    label: "Một SĐT nhiều khách",
    maxPoints: 3,
    rationale: "Thường là gõ sai số, số tổng đài, hoặc người nhận hộ — cả ba đều làm việc xác nhận thất bại.",
    source: "đếm customers khác nhau cùng 9 số cuối SĐT",
  },
  {
    key: "NEW_PHONE",
    label: "Khách hoàn toàn mới",
    maxPoints: 2,
    /*
      CỐ Ý ĐẶT GẦN BẰNG 0. "Chưa biết" KHÔNG phải "xấu" — mọi khách tốt đều từng là khách mới đúng
      một lần. Cho tín hiệu này điểm cao là biến hệ thống thành cái máy trừng phạt khách mới, và shop
      sẽ mất đúng nhóm cần giữ nhất.
    */
    rationale: "Chưa có lịch sử nào để dựa vào. Đây là THIẾU THÔNG TIN, không phải bằng chứng xấu — nên điểm cố ý đặt gần bằng 0.",
    source: "không có đơn nào khác cùng 9 số cuối SĐT",
  },
  {
    key: "PREPAID",
    label: "Đã chuyển khoản trước",
    maxPoints: -25,
    rationale: "Khách đã trả tiền rồi thì gần như không còn lý do từ chối nhận. Đây là tín hiệu tốt mạnh nhất ERP có.",
    source: "orders.prepaid + orders.transfer_money",
  },
  {
    key: "LOYAL_CUSTOMER",
    label: "Khách đã mua thành công nhiều lần",
    maxPoints: -15,
    rationale: "Người đã nhận hàng và trả tiền nhiều lần là nhóm hoàn thấp nhất. Không trừ điểm cho họ là để họ bị soát như khách lạ.",
    source: "ORDER_OUTCOME_FAST = 'DELIVERED' theo 9 số cuối SĐT",
  },
];

export const RISK_SIGNAL_LABEL: Record<RiskSignalKey, string> = Object.fromEntries(RISK_SIGNALS.map((s) => [s.key, s.label])) as Record<RiskSignalKey, string>;
export const RISK_SIGNAL_MAX: Record<RiskSignalKey, number> = Object.fromEntries(RISK_SIGNALS.map((s) => [s.key, s.maxPoints])) as Record<RiskSignalKey, number>;

/** Tổng điểm dương tối đa. Bằng 100 theo thiết kế — bài kiểm khoá con số này. */
export const RISK_MAX_POSITIVE = RISK_SIGNALS.filter((s) => s.maxPoints > 0).reduce((t, s) => t + s.maxPoints, 0);

/**
 * NGƯỠNG CHIA MỨC. Chỉ sửa khi chủ shop yêu cầu, và phải chạy lại kiểm định sau khi sửa.
 *
 * `high = 40` chứ không phải 70: không đơn nào đạt gần 100 điểm (vừa hoàn nhiều, vừa thiếu địa chỉ,
 * vừa sai SĐT, vừa mẫu mã xấu là cực kỳ hiếm). Ngưỡng phải ở mức có đủ đơn rơi vào để việc soát
 * thành một danh sách làm được, không phải một danh sách rỗng.
 */
export const RISK_THRESHOLDS = { medium: 20, high: 40 } as const;

export function bandOf(score: number): RiskBand {
  if (score >= RISK_THRESHOLDS.high) return "HIGH";
  if (score >= RISK_THRESHOLDS.medium) return "MEDIUM";
  return "LOW";
}

/**
 * SỐ TÍN HIỆU KHÔNG TRA ĐƯỢC TỐI ĐA CÒN CHO PHÉP KẾT LUẬN "RỦI RO CAO".
 *
 * Quá mốc này thì mức bị HẠ xuống `MEDIUM` và tin cậy về `LOW`. Đây là luật "thiếu chiều nào thì
 * KHÔNG phán" đã có ở `classifyProduct` (`lib/constants/product-verdict.ts`): một điểm dựng từ 2/11
 * tín hiệu không đáng tin bằng điểm dựng từ 10/11, và người đọc phải thấy được điều đó thay vì nhận
 * một nhãn "rủi ro cao" nghe như đã kiểm chứng.
 */
export const MAX_UNMEASURABLE_FOR_HIGH = 4;

export type RiskReason = {
  key: RiskSignalKey;
  label: string;
  points: number;
  /** Số liệu THẬT của chính đơn này, không phải mô tả chung. Ví dụ "hoàn 4/5 đơn (80%)". */
  evidence: string;
};

export type RiskScore = {
  /** 0–100 sau khi chặn hai đầu. KHÔNG phải xác suất hoàn. */
  score: number;
  band: RiskBand;
  /** Xếp theo điểm giảm dần; tín hiệu tốt (điểm âm) xuống cuối. */
  reasons: RiskReason[];
  /** Ba lý do đầu — đủ để hành động, không bắt người đọc duyệt 11 dòng. */
  topReasons: RiskReason[];
  /** Tín hiệu KHÔNG tra được dữ liệu. Thiếu dữ liệu KHÔNG phải an toàn. */
  unmeasurable: RiskSignalKey[];
  recommendedAction: string;
  /** Mức tin cậy của chính điểm này — dùng lại thang của `lib/constants/recommendation.ts`. */
  confidence: RecommendationConfidence;
  /** Bao nhiêu phần tín hiệu tra được (0–1). */
  completeness: number;
  /** Mức đã bị HẠ vì thiếu dữ liệu hay chưa — nói ra thay vì âm thầm. */
  bandCapped: boolean;
  /**
   * THIỆT HẠI DỰ KIẾN nếu đơn này hoàn (đồng): tiền hàng không thu được + cước hai chiều.
   * ĐỘ LỚN, KHÔNG phải xác suất — cố ý tách khỏi `score`. `null` = chưa biết giá trị đơn.
   */
  expectedLossVnd: number | null;
};

/** Ghép điểm thành kết luận. MỘT chỗ duy nhất để mọi nơi cho ra cùng con số. */
export function composeRisk(input: {
  reasons: RiskReason[];
  unmeasurable: RiskSignalKey[];
  expectedLossVnd: number | null;
}): RiskScore {
  const raw = input.reasons.reduce((t, r) => t + r.points, 0);
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  const thieu = input.unmeasurable.length;
  const capped = thieu > MAX_UNMEASURABLE_FOR_HIGH;
  const rawBand = bandOf(score);
  // Thiếu quá nhiều chiều thì KHÔNG phán "cao". Hạ mức, và ghi lại là đã hạ.
  const band: RiskBand = capped && rawBand === "HIGH" ? "MEDIUM" : rawBand;
  const known = RISK_SIGNALS.length - thieu;
  const completeness = RISK_SIGNALS.length > 0 ? Math.round((known / RISK_SIGNALS.length) * 100) / 100 : 0;
  const confidence: RecommendationConfidence =
    thieu > MAX_UNMEASURABLE_FOR_HIGH ? RECOMMENDATION_CONFIDENCE.LOW : thieu > 1 ? RECOMMENDATION_CONFIDENCE.MEDIUM : RECOMMENDATION_CONFIDENCE.HIGH;
  const sorted = [...input.reasons].sort((a, b) => b.points - a.points);
  return {
    score,
    band,
    reasons: sorted,
    topReasons: sorted.filter((r) => r.points > 0).slice(0, 3),
    unmeasurable: input.unmeasurable,
    recommendedAction: RISK_BAND_ACTION[band],
    confidence,
    completeness,
    bandCapped: capped && rawBand === "HIGH",
    expectedLossVnd: input.expectedLossVnd,
  };
}

/* ───────────────────── NGƯỠNG NHẬN DIỆN TÍN HIỆU ───────────────────── */

/**
 * Tỷ lệ hoàn lịch sử từ mức này trở lên mới coi là "hay bị hoàn".
 *
 * Lấy theo mặt bằng thật của shop: đo trên production 07/09/2026 tỷ lệ hoàn tổng quanh 50%, nên một
 * mẫu mã / khu vực chỉ đáng gắn cờ khi nó xấu HƠN mặt bằng rõ rệt. Đặt ngưỡng tuyệt đối thấp hơn
 * mặt bằng sẽ gắn cờ gần như mọi thứ, và một cờ gắn khắp nơi không còn là thông tin.
 */
export const HIGH_RETURN_RATE = 0.6;

/** Dưới số đơn đã kết thúc này thì KHÔNG kết luận tỷ lệ — trả "chưa tra được", không trả 0. */
export const MIN_SAMPLE_FOR_RATE = 20;

/** Địa chỉ ngắn hơn số ký tự này thì bưu tá gần như chắc chắn không tìm được nhà. */
export const MIN_ADDRESS_LENGTH = 15;

/* ───────────────────── KIỂM ĐỊNH ───────────────────── */

/**
 * ───────────── KIỂM ĐỊNH: TÁCH ĐƯỢC HAY KHÔNG ─────────────
 *
 * CHIA THEO THỜI GIAN, không chia ngẫu nhiên. Tỷ lệ hoàn theo mẫu mã / khu vực / kênh / khách được
 * học từ nửa CŨ và chấm điểm cho nửa MỚI. Học và chấm trên cùng một tập là tự chấm bài của mình:
 * điểm sẽ đẹp và vô nghĩa.
 */
export const BACKTEST_TRAIN_RATIO = 0.7;

/** Dưới số đơn này thì KHÔNG công bố kết luận kiểm định — mẫu quá nhỏ. */
export const BACKTEST_MIN_ORDERS = 100;

/**
 * Dưới mức nâng này thì KHÔNG được nói điểm rủi ro có tác dụng.
 *
 * 1,3 nghĩa là nhóm rủi ro cao phải hoàn nhiều hơn mặt bằng ít nhất 30%. Đặt thấp hơn thì mọi dao
 * động ngẫu nhiên cũng thành "có tác dụng", và một lần công bố sai như thế làm mất tin cậy vào cả hệ
 * thống — mất nhiều hơn cái nó định đem lại.
 */
export const MIN_LIFT_TO_CLAIM = 1.3;

export type BacktestBand = {
  band: RiskBand;
  orders: number;
  delivered: number;
  returned: number;
  /** Tỷ lệ hoàn của nhóm (0–1). `null` khi nhóm dưới cỡ mẫu tối thiểu. */
  returnRate: number | null;
  /** Tỷ lệ hoàn nhóm / tỷ lệ hoàn chung. > 1 = nhóm này xấu hơn mặt bằng. */
  lift: number | null;
};

export type BacktestVerdict = "PHÂN BIỆT ĐƯỢC" | "KHÔNG PHÂN BIỆT ĐƯỢC" | "KHÔNG ĐỦ MẪU";

export type RiskBacktest = {
  /** Đơn đã biết kết quả trong nửa KIỂM TRA. */
  orders: number;
  /** Đơn đã biết kết quả trong nửa HỌC (chỉ để biết mẫu học dày hay mỏng). */
  trainOrders: number;
  /** Tỷ lệ hoàn chung của nửa kiểm tra — mặt bằng để so. `null` khi chưa đủ mẫu. */
  baselineReturnRate: number | null;
  bands: BacktestBand[];
  /** Trong số đơn bị chấm CAO, bao nhiêu phần thật sự hoàn. "Soát 10 đơn thì mấy đơn đáng soát." */
  highPrecision: number | null;
  /** Trong số đơn thật sự hoàn, bao nhiêu phần bị chấm CAO. "Soát được bao nhiêu phần vấn đề." */
  highRecall: number | null;
  /** Tỷ lệ hoàn nhóm cao / mặt bằng. */
  uplift: number | null;
  /** Nhóm cao ≥ trung bình ≥ thấp về tỷ lệ hoàn hay không. */
  monotone: boolean;
  /** Phần đơn chấm được điểm (0–1). Điểm phủ 30% đơn thì không kết luận được gì cho cả shop. */
  coverage: number;
  verdict: BacktestVerdict;
  /** Nói thẳng vì sao ra kết luận đó. */
  verdictReason: string;
  /** Giới hạn của chính phép kiểm định này. Bắt buộc không rỗng — bài kiểm khoá điều đó. */
  limitations: string[];
  trainTo: Date | null;
  testFrom: Date | null;
};

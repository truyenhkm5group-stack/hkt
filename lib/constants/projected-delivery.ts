import type { CarrierSubstate } from "@/lib/constants/carrier-substate";

/**
 * ═══════════ MỘT HỢP ĐỒNG DUY NHẤT CHO "TỶ LỆ GIAO THÀNH CÔNG ƯỚC TÍNH" ═══════════
 *
 * ─── HỢP ĐỒNG (chủ shop chốt 13/09/2026) ───
 *
 *   TL GTC THỰC TẾ    = Đã giao ÷ (Đã giao + Không thành công)      — đơn đang giao KHÔNG ở mẫu số
 *   Ước tính giao được = Đã giao thật + Σ(số đơn đang ở trạng thái s × P(s))
 *   TL GTC ƯỚC TÍNH   = Ước tính giao được ÷ (Đã gửi − đơn ngoài ước tính)
 *   DT GTC ƯỚC TÍNH   = DT các đơn ĐÃ GIAO + Σ(DT từng đơn đang chạy × P(trạng thái của nó))
 *
 * "Đã giao" / "Không thành công" đọc từ `ORDER_OUTCOME` (`lib/queries/return-rate.ts`) — KHÔNG đọc
 * `shipments.stage`, KHÔNG đọc mã ĐVVC thô. Lý do đo được trên production: mã 501 của CHIỀU HOÀN,
 * đơn "giao thành công" thu 30.000đ, đơn 50K–100K (`RETURNED_BY_RULE`) — cả ba là đơn hoàn theo
 * luật kết quả đơn nhưng theo `stage` thì là "đã giao". Đếm bằng stage là tự thổi tử số.
 *
 * P(s) HỌC TỪ LỊCH SỬ THẬT, không có con số nào gõ tay:
 *
 *     P(giao thành công │ đang ở trạng thái s)
 *   = số vận đơn TỪNG ở s và sau đó có kết quả DELIVERED (theo ORDER_OUTCOME)
 *   ÷ số vận đơn TỪNG ở s và ĐÃ KẾT THÚC (DELIVERED · RETURNED · RETURNED_BY_RULE)
 *
 * Bốn điều dễ làm sai, và bản này khoá cả bốn:
 *
 *  1. **Vận đơn chưa có kết cục KHÔNG vào mẫu số học xác suất.** Trộn "chưa biết" với "đã biết là
 *     hỏng" thì xác suất tụt chỉ vì hôm nay bán được nhiều.
 *  2. **Một vận đơn đi qua một trạng thái BAO NHIÊU LẦN cũng chỉ là MỘT quan sát.** Webhook Viettel
 *     Post thử lại tới 5 lần; đếm theo sự kiện là để số lần thử lại quyết định xác suất.
 *  3. **Chỉ học từ vận đơn ĐỦ CHÍN.** Kiện mới gửi 3 ngày mà đã có kết cục thì gần như chắc là giao
 *     được (hoàn mất lâu hơn nhiều) — học từ nhóm ấy là học một mẫu lệch về phía lạc quan
 *     (right-censoring). Xem `TRAINING_WINDOW`.
 *  4. **Trạng thái cuối (đã giao / đã hoàn / đã huỷ) KHÔNG phải trạng thái để dự báo.** Một kiện
 *     "từng ở trạng thái đã giao" thì P = 1 — đó là lộ đáp án, không phải tri thức. Xem
 *     `MODELLED_SUBSTATES`.
 *
 * Mô hình chỉ được in ra kèm KẾT QUẢ THỬ NGƯỢC (`backtestConfidenceOf`): chưa thử, hoặc thử mà sai,
 * thì con số ước tính mang nhãn tin cậy thấp / chưa đủ dữ liệu — không bao giờ mang vẻ chắc chắn.
 */

/**
 * Phiên bản CÔNG THỨC. Đổi cách tính ⇒ tăng số, để ảnh chụp kỳ cũ không bị đọc bằng luật mới.
 *
 * V4 (chủ shop chốt 26/09/2026): *"Tỷ lệ GTC của mã nào thì ước tính cho mã đấy, không dùng chung
 * của toàn shop vì mã hoàn cao, GTC thấp sẽ ảnh hưởng đến các mã khác"*. Có mã hàng thì KHÔNG còn
 * bậc toàn shop — xem `PROBABILITY_FALLBACK`.
 */
export const PROJECTED_GTC_VERSION = "PROJECTED_GTC_V4";

/**
 * ĐỘ TIN CẬY THEO CỠ MẪU của MỘT xác suất trạng thái.
 *
 * Ngưỡng không phải con số đẹp: chúng là điểm mà sai số chuẩn của một tỷ lệ nhị phân quanh 0,5 rơi
 * xuống dưới mức còn dùng để quyết định được — ±5 điểm ở 100 mẫu, ±9 ở 30, ±16 ở 10. Dưới 10 thì
 * một kiện đổi kết cục làm tỷ lệ nhảy hơn 10 điểm, nên nó KHÔNG phải một xác suất; nó là tiếng ồn.
 */
export const CONFIDENCE_THRESHOLDS = { HIGH: 100, MEDIUM: 30, LOW: 10 } as const;

export type ProbabilityConfidence = "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT_DATA";

export function confidenceOf(sample: number): ProbabilityConfidence {
  if (sample >= CONFIDENCE_THRESHOLDS.HIGH) return "HIGH";
  if (sample >= CONFIDENCE_THRESHOLDS.MEDIUM) return "MEDIUM";
  if (sample >= CONFIDENCE_THRESHOLDS.LOW) return "LOW";
  return "INSUFFICIENT_DATA";
}

export const CONFIDENCE_LABEL: Record<ProbabilityConfidence, string> = {
  HIGH: "Tin cậy cao",
  MEDIUM: "Tin cậy vừa",
  LOW: "Mẫu nhỏ",
  INSUFFICIENT_DATA: "Chưa đủ dữ liệu",
};

/** Màu nhãn tin cậy — trung tính khi chưa đủ dữ liệu, không đỏ: "chưa đo được" không phải "làm kém". */
export const CONFIDENCE_TONE: Record<ProbabilityConfidence, string> = {
  HIGH: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  MEDIUM: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  LOW: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  INSUFFICIENT_DATA: "bg-muted text-muted-foreground",
};

/**
 * ═══════════ TUỔI KIỆN LÀ MỘT CHIỀU RIÊNG, KHÔNG PHẢI MỘT CHI TIẾT ═══════════
 *
 * Hai kiện cùng mang trạng thái "Chờ xử lý" nhưng một cái mới 6 giờ còn một cái đã 9 ngày KHÔNG có
 * cùng triển vọng. Gộp chúng vào một xác suất là để kiện mới kéo kiện treo lên, và kiện treo kéo
 * kiện mới xuống — con số ra đúng trung bình và sai cho cả hai.
 *
 * Ranh giới lấy theo chính nhịp giao hàng đo được trên production (13/09/2026, "ĐVVC nhận → kết cục
 * cuối"): giao được p50 2,8 ngày · p95 5,7 ngày; hoàn p50 7,0 ngày · p95 13,1 ngày. Nghĩa là qua
 * mốc 72 giờ mà chưa tới tay khách thì kiện đã rời khỏi vùng "bình thường" của đơn giao được.
 */
export const AGE_BUCKETS = [
  { key: "H0_24", label: "< 24h", fromHours: 0, toHours: 24 },
  { key: "H24_48", label: "24–48h", fromHours: 24, toHours: 48 },
  { key: "H48_72", label: "48–72h", fromHours: 48, toHours: 72 },
  { key: "H72_PLUS", label: "> 72h", fromHours: 72, toHours: Number.POSITIVE_INFINITY },
] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number]["key"];

export const AGE_BUCKET_LABEL: Record<AgeBucket, string> = Object.fromEntries(AGE_BUCKETS.map((b) => [b.key, b.label])) as Record<AgeBucket, string>;

/** Tuổi (giờ) → rổ. Tuổi âm (mốc bàn giao muộn hơn mốc quan sát) rơi vào rổ đầu — không có rổ "âm". */
export function ageBucketOf(hours: number): AgeBucket {
  for (const b of AGE_BUCKETS) if (hours < b.toHours) return b.key;
  return "H72_PLUS";
}

/**
 * MỐC CHỤP ẢNH KHI HUẤN LUYỆN — mỗi rổ tuổi một mốc đại diện, cộng thêm ba mốc cho rổ cuối vì rổ
 * đó mở tới vô hạn và là chỗ mọi kiện treo nằm lại.
 *
 * Vì sao phải chụp ảnh chứ không đọc "kiện từng đi qua trạng thái nào": mô hình được DÙNG để trả
 * lời "kiện đang ở trạng thái s, tuổi a — bao nhiêu phần trăm tới được tay khách". Học từ "từng đi
 * qua s" là học một câu hỏi khác, và bài thử ngược (vốn đã chấm bằng ảnh chụp) sẽ đo lệch chính
 * thứ nó đang chấm.
 */
export const TRAINING_SNAPSHOT_OFFSETS_HOURS = [12, 36, 60, 96, 144, 240] as const;

/**
 * THỨ TỰ LÙI KHI MẪU KHÔNG ĐỦ — hẹp trước, rộng sau, và cuối cùng là THỪA NHẬN KHÔNG BIẾT.
 *
 * Cố ý KHÔNG có bậc nào trả về một con số mặc định. Hết bậc thì kết quả là `null`, và màn hình in
 * "chưa đo được" — khác hẳn 0% (đã đo và bằng không) và khác hẳn một con số đoán trông như đã đo.
 *
 * ─── VÌ SAO KHÔNG CÓ BẬC "DÒNG SẢN PHẨM" ───
 *
 * Chủ shop gọi hàng bằng `products.custom_id` (`Q001`…`X001`) và mỗi mã đã là MỘT dòng sản phẩm
 * với 15–20 mẫu mã bên dưới. Dựng thêm một tầng "họ sản phẩm" phía trên sáu mã hiện có là dựng một
 * tầng có đúng một phần tử — nó không thêm mẫu, chỉ thêm một cái tên.
 *
 * ─── V4: CÓ MÃ HÀNG THÌ KHÔNG BAO GIỜ XUỐNG BẬC TOÀN SHOP ───
 *
 * Chủ shop chốt 26/09/2026. Tỷ lệ nền toàn shop là một cái tên lịch sự cho tỷ lệ của Đầm Q002 (62%
 * tập học, GTC 26,7% — xem `lib/constants/delivery-rate.ts`), nên một mã hoàn cao kéo tụt ước tính
 * của MỌI mã khác. Đo production 26/09/2026: mọi đơn Q004 chưa gửi được cân bằng P(chưa rời kho)
 * toàn shop ≈ 25% — ngày nào toàn đơn mới thì DT GTC ƯT in đúng 25,2% doanh số, trong khi Q004
 * tự giao được hơn một nửa.
 *
 *     có mã hàng    PRODUCT_STATE_AGE → PRODUCT_STATE → PRODUCT_ALL → NONE
 *     không có mã   GLOBAL_STATE_AGE → GLOBAL_STATE → NONE
 *
 * `PRODUCT_ALL` = tỷ lệ giao được của CHÍNH mã trên mọi kiện đã kết thúc của nó trong cửa sổ học,
 * không tách trạng thái — bằng chứng thô hơn nhưng vẫn là của mã đang xem. Nó đỡ những trạng thái
 * mà mã chưa đủ 10 quan sát; không có nó thì đơn ấy thành "ngoài ước tính" và tiền của nó bị tính
 * 0 ₫ giao được — lệch xuống còn nặng hơn lệch vì mượn. Mã không có nổi 10 kiện kết thúc thì
 * `NONE`: bảng lợi nhuận tự rơi về thang bậc tỷ lệ (co ngót / tỷ lệ khai ở Giả định), cũng KHÔNG
 * mượn của mã khác.
 *
 * "Không có mã" chỉ còn là đơn NHIỀU mã khi cộng Ở GRAIN ĐƠN (con số toàn shop) — ở đó không có mã
 * nào để bị kéo tụt. Ở bảng theo mã, dòng của mã nào cân bằng xác suất của CHÍNH mã đó, kể cả khi
 * đơn có thêm mã khác. Lúc HỌC thì kiện nhiều mã vẫn không vào ô nào theo mã: đếm nó vào cả hai là
 * nhân đôi một quan sát.
 */
export const PROBABILITY_FALLBACK = ["PRODUCT_STATE_AGE", "PRODUCT_STATE", "PRODUCT_ALL", "GLOBAL_STATE_AGE", "GLOBAL_STATE", "NONE"] as const;
export type ProbabilityBasis = (typeof PROBABILITY_FALLBACK)[number];

/** Bậc nào là quan sát của CHÍNH mã hàng — đếm vào `projectedFromOwn`, không phải phần đi mượn. */
export const OWN_PRODUCT_BASES: readonly ProbabilityBasis[] = ["PRODUCT_STATE_AGE", "PRODUCT_STATE", "PRODUCT_ALL"];

export const BASIS_LABEL: Record<ProbabilityBasis, string> = {
  PRODUCT_STATE_AGE: "theo mã hàng + trạng thái + tuổi kiện",
  PRODUCT_STATE: "theo mã hàng + trạng thái",
  PRODUCT_ALL: "theo mã hàng (mọi trạng thái)",
  GLOBAL_STATE_AGE: "theo trạng thái + tuổi kiện (toàn shop)",
  GLOBAL_STATE: "theo trạng thái (toàn shop)",
  NONE: "chưa đo được",
};

/**
 * CỠ MẪU TỐI THIỂU CỦA MỘT Ô ĐIỀU KIỆN HOÁ.
 *
 * Bằng `CONFIDENCE_THRESHOLDS.LOW` — đúng ngưỡng mà dưới nó một kiện đổi kết cục làm tỷ lệ nhảy
 * hơn 10 điểm. Một ô 6 quan sát vẫn cho ra "66,7%", và con số đó in ra trông y hệt một con số đo
 * từ 600 quan sát; bậc lùi tồn tại để chuyện đó không xảy ra.
 *
 * Sửa số này là đổi mô hình: phải chạy lại `scripts/bench/projection-backtest.ts` và chép số đo
 * (MAE · bias · độ phủ) vào chú thích, không được đổi bằng cảm giác.
 */
export const MIN_CELL_SAMPLE = CONFIDENCE_THRESHOLDS.LOW;

/**
 * TRẠNG THÁI ĐƯỢC PHÉP DỰ BÁO — chỉ những trạng thái mà một đơn ĐANG GIAO (`ORDER_OUTCOME =
 * IN_TRANSIT`) có thể đang ở.
 *
 * `DELIVERED` · `RETURNED` · `CANCELLED` là trạng thái CUỐI: một vận đơn "từng ở đó" thì kết cục đã
 * ngã ngũ, P sẽ là 1 hoặc 0 — đưa vào mô hình là để đáp án chảy vào lời giải. `RETURNING` cũng
 * không dự báo: `ORDER_OUTCOME` xếp kiện đang chuyển hoàn vào `RETURNED` (đã kết thúc), nên nó
 * không bao giờ là "đang giao". `WAITING_PROCESSING` và `WAITING_REDELIVERY` là hai trạng thái
 * RIÊNG với hai xác suất riêng — đó là điểm chủ shop yêu cầu tường minh.
 */
export const MODELLED_SUBSTATES = [
  "AWAITING_PICKUP",
  "PICKUP_FAILED",
  "PICKED_UP",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "WAITING_REDELIVERY",
  "WAITING_PROCESSING",
  "DELIVERY_EXCEPTION",
  "UNKNOWN",
] as const satisfies readonly CarrierSubstate[];
export type ModelledSubstate = (typeof MODELLED_SUBSTATES)[number];

export function isModelledSubstate(s: string): s is ModelledSubstate {
  return (MODELLED_SUBSTATES as readonly string[]).includes(s);
}

/**
 * ĐƠN CHƯA GỬI (`ORDER_OUTCOME = NOT_SHIPPED`) là một trạng thái dự báo RIÊNG, chỉ dùng cho DOANH
 * THU của cohort theo ngày chốt đơn — nó không phải "đã gửi" nên KHÔNG vào mẫu số của tỷ lệ GTC.
 * P(NOT_SHIPPED) học từ đơn đã chốt trong cửa sổ huấn luyện và đã kết thúc, KỂ CẢ HUỶ: một đơn chưa
 * gửi vẫn có thể bị huỷ, và huỷ thì doanh thu bằng 0.
 *
 * V4: học RIÊNG từng mã (đơn thuộc đúng một mã). Mã chưa đủ 10 đơn chốt đã kết thúc thì lùi về
 * `PRODUCT_ALL` của chính mã — con số ấy KHÔNG trừ phần huỷ trước khi gửi nên lệch lên một chút,
 * và nhãn bậc nói ra điều đó; mượn P(chưa rời kho) của toàn shop thì lệch theo mã hoàn nặng nhất.
 */
export const NOT_SHIPPED_STATE = "NOT_SHIPPED" as const;
export type ProjectedState = ModelledSubstate | typeof NOT_SHIPPED_STATE;

/**
 * CỬA SỔ HUẤN LUYỆN — chống mẫu lệch vì kiện chưa đủ chín (right-censoring).
 *
 * Đơn hoàn mất lâu hơn đơn giao được nhiều: ĐVVC phát hụt vài lần, chờ xử lý, rồi mới chuyển hoàn.
 * Nếu học từ MỌI kiện đã kết thúc tính tới hôm nay, nhóm gửi trong hai tuần gần nhất chỉ gồm những
 * kiện ĐÃ KỊP có kết cục — tức phần lớn là giao được — và mô hình lạc quan hơn thực tế.
 *
 * Nên chỉ học từ kiện ĐVVC nhận trước hôm nay ít nhất H ngày, với H = phân vị 95 của thời gian
 * "ĐVVC nhận → kết cục cuối" của chính các đơn HOÀN trong dữ liệu (đo, không đoán). Chưa đủ mẫu để
 * đo thì dùng `maturityDefaultDays`; đo ra quá dài (dữ liệu có ca treo bất thường) thì chặn ở
 * `maturityCapDays` để không bỏ mất cả tháng dữ liệu.
 *
 * ĐO PRODUCTION 13/09/2026 (chỉ đọc) — "ĐVVC nhận → kết cục cuối":
 *   · giao được  n = 707 · p50 2,8 ngày · p95  5,7 ngày
 *   · hoàn       n = 459 · p50 7,0 ngày · p95 13,1 ngày
 * Đơn hoàn mất gấp 2,3 lần đơn giao — đúng cơ chế lệch mẫu nói trên. Mặc định 14 ngày là p95 của
 * đơn hoàn làm tròn lên; trần 21 ngày là 1,5 lần con số đó, đủ chỗ cho một tháng xấu.
 */
export const TRAINING_WINDOW = {
  /** Chỉ học từ kiện ĐVVC nhận trong N ngày gần nhất — xa hơn thì chất lượng giao vận đã khác. */
  windowDays: 180,
  /** H mặc định khi chưa đủ đơn hoàn để đo phân vị (= p95 đo được 13,1 ngày, làm tròn lên). */
  maturityDefaultDays: 14,
  /** Trần của H đo được (1,5 × p95 đo được). */
  maturityCapDays: 21,
  /** Phân vị của thời gian hoàn dùng làm H. */
  maturityQuantile: 0.95,
  /** Số đơn hoàn tối thiểu để tin phân vị đo được — dưới ngưỡng thì dùng mặc định. */
  minReturnedForMaturity: CONFIDENCE_THRESHOLDS.MEDIUM,
} as const;

/**
 * PHẦN "NGOÀI ƯỚC TÍNH" TỐI ĐA.
 *
 * Đơn đang ở trạng thái chưa đủ mẫu KHÔNG được gán một xác suất đoán — nó nằm ngoài phép tính và
 * được nói ra. Nhưng khi phần ấy quá lớn thì con số còn lại không còn đại diện cho cohort: tỷ lệ
 * ước tính khi đó là `null` (chưa đo được), không phải một con số tính trên nửa tập đơn.
 */
export const UNMODELLED_SHARE_MAX = 0.5;

/**
 * TỶ LỆ GTC ƯỚC TÍNH — công thức duy nhất, dùng chung cho hàm chủ đạo, dòng gộp trên bảng, và bài
 * kiểm. Trả `null` (CHƯA ĐO ĐƯỢC) khi mẫu số rỗng hoặc phần ngoài ước tính quá lớn.
 *
 * Mẫu số LOẠI đơn ngoài ước tính: giữ chúng ở mẫu số mà không có gì ở tử số là ngầm coi P = 0 cho
 * đúng nhóm mà mô hình vừa thừa nhận không biết gì.
 */
export function projectedRateOf(input: { projectedDelivered: number; eligibleSent: number; active: number; unmodelledActive: number }): number | null {
  const mauSo = input.eligibleSent - input.unmodelledActive;
  if (!(mauSo > 0)) return null;
  if (input.active > 0 && input.unmodelledActive / input.active > UNMODELLED_SHARE_MAX) return null;
  return Math.round((input.projectedDelivered / mauSo) * 1000) / 10;
}

/* ═══════════════════ THỬ NGƯỢC (BACKTEST) ═══════════════════ */

/** Mốc chụp ảnh sau khi ĐVVC nhận kiện (ngày). Phủ từ "vừa rời kho" tới "đã treo lâu". */
export const BACKTEST_SNAPSHOT_OFFSETS_DAYS = [1, 3, 5, 7, 10] as const;

/** Số tháng gần nhất đem ra thử, mỗi tháng huấn luyện lại bằng dữ liệu TRƯỚC tháng đó. */
export const BACKTEST_MONTHS = 3;

/**
 * NGƯỠNG TIN CẬY CỦA MÔ HÌNH, từ kết quả thử ngược.
 *
 *  · `n`      — số vận đơn được chấm (không phải số ảnh chụp: 5 ảnh của một kiện không độc lập).
 *  · `bias`   — dự báo trung bình − tỷ lệ giao thật. Dương = mô hình LẠC QUAN, hướng sai nguy hiểm
 *               hơn vì nó thổi doanh thu và lợi nhuận ước tính.
 *  · `slope`  — độ dốc hiệu chuẩn (thực tế theo dự báo, qua các thập phân vị): 1 = nói 70% thì
 *               đúng 70%; < 1 = dự báo quá tự tin ở hai đầu; > 1 = quá dè dặt.
 *
 * `HIGH` đòi cả ba; `MEDIUM` bỏ điều kiện độ dốc (cần nhiều điểm dự báo khác nhau mới đo được);
 * `LOW` chỉ cần có mẫu tối thiểu; còn lại là CHƯA ĐỦ DỮ LIỆU — không phải "mô hình sai".
 */
export const BACKTEST_CONFIDENCE = {
  HIGH: { minN: CONFIDENCE_THRESHOLDS.HIGH, maxAbsBias: 0.03, slope: [0.8, 1.2] as const },
  MEDIUM: { minN: CONFIDENCE_THRESHOLDS.MEDIUM, maxAbsBias: 0.07 },
  LOW: { minN: CONFIDENCE_THRESHOLDS.LOW },
} as const;

export function backtestConfidenceOf(input: { n: number; bias: number | null; slope: number | null }): ProbabilityConfidence {
  const { n, bias, slope } = input;
  if (n < BACKTEST_CONFIDENCE.LOW.minN || bias === null) return "INSUFFICIENT_DATA";
  const lech = Math.abs(bias);
  const h = BACKTEST_CONFIDENCE.HIGH;
  if (n >= h.minN && lech <= h.maxAbsBias && slope !== null && slope >= h.slope[0] && slope <= h.slope[1]) return "HIGH";
  const m = BACKTEST_CONFIDENCE.MEDIUM;
  if (n >= m.minN && lech <= m.maxAbsBias) return "MEDIUM";
  return "LOW";
}

export type CalibrationBin = {
  /** Cận dưới của thập phân vị (0, 0.1, …, 0.9). */
  from: number;
  n: number;
  predicted: number;
  observed: number;
};

export type BacktestStats = {
  /** Số vận đơn được chấm. */
  n: number;
  /** Số ảnh chụp (vận đơn × mốc). */
  observations: number;
  predicted: number | null;
  observed: number | null;
  bias: number | null;
  brier: number | null;
  mae: number | null;
  /** Độ dốc hiệu chuẩn — `null` khi mọi dự báo cùng một giá trị (không đo được). */
  slope: number | null;
  calibration: CalibrationBin[];
};

/**
 * Cộng dồn các ảnh chụp thành thống kê thử ngược. Hàm THUẦN để bài kiểm chạy không cần CSDL.
 *
 * `shipmentId` để đếm `n` theo vận đơn; nhiều ảnh chụp của cùng một kiện là quan sát có tương quan
 * nên không được đếm như mẫu độc lập.
 */
export function summarizeBacktest(points: { shipmentId: string; p: number; y: 0 | 1 }[]): BacktestStats {
  const observations = points.length;
  const n = new Set(points.map((x) => x.shipmentId)).size;
  if (!observations) return { n, observations, predicted: null, observed: null, bias: null, brier: null, mae: null, slope: null, calibration: [] };
  let tongP = 0;
  let tongY = 0;
  let tongBinhPhuong = 0;
  let tongTuyetDoi = 0;
  const bins = new Map<number, { n: number; p: number; y: number }>();
  for (const x of points) {
    tongP += x.p;
    tongY += x.y;
    tongBinhPhuong += (x.p - x.y) ** 2;
    tongTuyetDoi += Math.abs(x.p - x.y);
    const from = Math.min(9, Math.floor(x.p * 10)) / 10;
    const b = bins.get(from) ?? { n: 0, p: 0, y: 0 };
    b.n += 1;
    b.p += x.p;
    b.y += x.y;
    bins.set(from, b);
  }
  const calibration: CalibrationBin[] = [...bins.entries()]
    .map(([from, b]) => ({ from, n: b.n, predicted: lam3(b.p / b.n), observed: lam3(b.y / b.n) }))
    .sort((a, b) => a.from - b.from);
  return {
    n,
    observations,
    predicted: lam3(tongP / observations),
    observed: lam3(tongY / observations),
    bias: lam3((tongP - tongY) / observations),
    brier: lam3(tongBinhPhuong / observations),
    mae: lam3(tongTuyetDoi / observations),
    slope: calibrationSlope(calibration),
    calibration,
  };
}

/**
 * Độ dốc hiệu chuẩn = hồi quy có trọng số (theo n) của "quan sát" lên "dự báo" qua các thập phân
 * vị. Cần ít nhất hai điểm có dự báo khác nhau; nếu không thì `null` — không bịa 1.
 */
export function calibrationSlope(bins: CalibrationBin[]): number | null {
  const tongN = bins.reduce((a, b) => a + b.n, 0);
  if (!tongN || bins.length < 2) return null;
  const xTb = bins.reduce((a, b) => a + b.n * b.predicted, 0) / tongN;
  const yTb = bins.reduce((a, b) => a + b.n * b.observed, 0) / tongN;
  let tu = 0;
  let mau = 0;
  for (const b of bins) {
    tu += b.n * (b.predicted - xTb) * (b.observed - yTb);
    mau += b.n * (b.predicted - xTb) ** 2;
  }
  if (mau < 1e-9) return null;
  return lam3(tu / mau);
}

function lam3(v: number): number {
  // `+ 0` xoá dấu của -0: lệch "âm không" in ra "-0" và làm so sánh chặt thất bại dù giá trị bằng 0.
  return Math.round(v * 1000) / 1000 + 0;
}

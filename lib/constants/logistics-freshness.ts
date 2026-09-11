/**
 * ═══════════ KHẢ NĂNG TRA CỨU VÀ ĐỘ TƯƠI CỦA VẬN ĐƠN ═══════════
 *
 * ─── VÌ SAO CẦN "KHẢ NĂNG TRA CỨU" ───
 *
 * ĐO ĐƯỢC trên production 11/09/2026, đếm theo nguồn của `shipment_events`:
 *
 *   PANCAKE       22.773 sự kiện · 1.630 vận đơn · 1.287 nhận trong 24h · 71 trong 1h
 *   VTP_WEBHOOK    2.713 sự kiện ·   624 vận đơn · 1.134 nhận trong 24h · 139 trong 1h
 *   VTP_IMPORT     1.626 sự kiện (nhập tay, đứng từ 08/09)
 *   VTP_POLL           0 sự kiện  ← CHƯA BAO GIỜ sinh ra một sự kiện nào
 *
 * Và `sync_runs` nói thẳng lý do: *"Tài khoản API Viettel Post không thấy bất kỳ vận đơn nào trong
 * 10 vận đơn vừa tra (lượt thứ 548 liên tiếp). Vận đơn do Pancake tạo thuộc tài khoản khác."*
 *
 * Nghĩa là suốt thời gian qua ERP vẫn đều đặn gọi một API không bao giờ trả về gì cho những vận đơn
 * này. Không sai kết quả, nhưng tốn request, tốn thời gian job, và làm log đầy tiếng ồn che mất
 * những lỗi thật.
 *
 * Nên mỗi vận đơn tự khai KHẢ NĂNG của nó, và bộ tra cứu chỉ hỏi những vận đơn hỏi được.
 *
 * ─── KHÔNG HẠ CHẤT LƯỢNG SỰ THẬT ───
 *
 * Đây KHÔNG phải hạ cấp thẩm quyền nguồn. Thứ tự thẩm quyền giữ nguyên như `ORDER_OUTCOME` đã chốt:
 * chứng từ ĐVVC trước, rồi tiền. `WEBHOOK_ONLY` chỉ nói "đừng gọi API cho vận đơn này nữa" — nó
 * không đổi một chữ nào trong cách kết luận đơn.
 */

export const TRACKING_CAPABILITIES = ["API_TRACKABLE", "WEBHOOK_ONLY", "UNKNOWN_CAPABILITY"] as const;
export type TrackingCapability = (typeof TRACKING_CAPABILITIES)[number];

export const CAPABILITY_LABEL: Record<TrackingCapability, string> = {
  API_TRACKABLE: "Tra được qua API",
  WEBHOOK_ONLY: "Chỉ nhận webhook",
  UNKNOWN_CAPABILITY: "Chưa rõ",
};

export const CAPABILITY_NOTE: Record<TrackingCapability, string> = {
  API_TRACKABLE: "Tài khoản API Viettel Post đọc được vận đơn này — vừa nhận webhook, vừa đối chiếu định kỳ qua API.",
  WEBHOOK_ONLY:
    "Tài khoản API hiện tại KHÔNG đọc được vận đơn này (đã thử đủ số lần). Trạng thái đến từ webhook; ERP thôi gọi API cho nó để khỏi tốn request và làm nhiễu log.",
  UNKNOWN_CAPABILITY: "Chưa đủ bằng chứng. Bộ tra cứu còn thử một số lần có giới hạn rồi mới kết luận.",
};

/**
 * SAU BAO NHIÊU LẦN TRA HỤT THÌ KẾT LUẬN "KHÔNG ĐỌC ĐƯỢC".
 *
 * Ba lần, cố ý nhỏ: API trả "không thấy" là một câu trả lời DỨT KHOÁT, không phải lỗi tạm thời —
 * vận đơn hoặc thuộc tài khoản này hoặc không. Để 10 lần chỉ là tốn thêm bảy lần vô ích.
 *
 * Vẫn có `capabilityProbes` đếm riêng cho từng vận đơn: kết luận theo TỪNG VẬN ĐƠN chứ không theo
 * tài khoản, để ngày shop trỏ ERP về đúng tài khoản thì vận đơn mới tự được xếp lại đúng.
 */
export const CAPABILITY_PROBE_LIMIT = 3;

/**
 * ═══════════ ĐỘ TƯƠI THEO TỪNG CHẶNG ═══════════
 *
 * Một kiện "chờ lấy hàng" ba ngày và một kiện "đang đi giao" ba ngày là hai chuyện khác hẳn nhau.
 * Nên ngưỡng đi theo CHẶNG, và đặt ở một chỗ để không rải hằng số khắp nơi.
 *
 * Số giờ đo từ SỰ KIỆN ĐVVC gần nhất (webhook hoặc Pancake chuyển tiếp), KHÔNG phải từ lần tra cứu
 * gần nhất: tra cứu mà API không trả về gì thì không làm dữ liệu tươi hơn một giây nào.
 *
 * Ngưỡng dựng từ phân bố đo được trên production 11/09/2026 (554 kiện đang chạy):
 *
 *   <6h  158  ·  6–24h  214  ·  1–3 ngày  114  ·  >3 ngày  68
 *
 *   PENDING          110 kiện · tuổi TB 14,9h   ← chờ lấy hàng, chậm là bình thường
 *   IN_TRANSIT       172 kiện · tuổi TB 20,8h
 *   OUT_FOR_DELIVERY  67 kiện · tuổi TB 22,8h   ← đang đi giao mà im 22 giờ là bất thường
 *   DELIVERY_FAILED   31 kiện · tuổi TB 36,2h   ← đang cần người gọi khách
 *   RETURNING        170 kiện · tuổi TB 46,3h   ← chiều hoàn vốn chậm
 */
export const FRESHNESS_CLASSES = ["FRESH", "AGING", "STALE", "CRITICAL_STALE"] as const;
export type FreshnessClass = (typeof FRESHNESS_CLASSES)[number];

export const FRESHNESS_LABEL: Record<FreshnessClass, string> = {
  FRESH: "Mới",
  AGING: "Bắt đầu cũ",
  STALE: "Cũ",
  CRITICAL_STALE: "Cũ nghiêm trọng",
};

export const FRESHNESS_TONE: Record<FreshnessClass, string> = {
  FRESH: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  AGING: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  STALE: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  CRITICAL_STALE: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
};

/** Ngưỡng giờ cho từng chặng: dưới `aging` là mới, quá `critical` là cũ nghiêm trọng. */
export type FreshnessThreshold = { aging: number; stale: number; critical: number; why: string };

export const FRESHNESS_BY_STAGE: Record<string, FreshnessThreshold> = {
  // Chờ ĐVVC tới lấy: một ngày là bình thường ở giờ cao điểm, hai ngày thì phải hỏi.
  PENDING: { aging: 24, stale: 48, critical: 96, why: "Chờ lấy hàng — chậm vài ngày là chuyện thường, quá 4 ngày thì kiện có thể đã thất lạc trước khi rời kho." },
  PICKED_UP: { aging: 12, stale: 24, critical: 72, why: "Vừa rời kho, phải có mốc nhập tuyến sớm." },
  IN_TRANSIT: { aging: 24, stale: 48, critical: 96, why: "Đang chạy tuyến — mỗi chặng thường có một mốc mỗi ngày." },
  // Đang đi giao mà im lặng là dấu hiệu xấu nhất: bưu tá hoặc đã giao, hoặc đã hụt mà chưa báo.
  OUT_FOR_DELIVERY: { aging: 8, stale: 24, critical: 48, why: "Đang đi giao thì kết quả phải có trong ngày. Im quá một ngày nghĩa là ERP không biết kiện đã tới tay khách hay chưa." },
  // Đã giao hụt: cửa sổ gọi lại khách rất ngắn, dữ liệu cũ ở đây làm mất đơn.
  DELIVERY_FAILED: { aging: 12, stale: 24, critical: 48, why: "Giao hụt là lúc cần người gọi khách ngay; số liệu cũ ở đây trực tiếp làm mất đơn." },
  RETURNING: { aging: 48, stale: 96, critical: 168, why: "Chiều hoàn vốn chậm và ít mốc hơn chiều đi." },
};

/** Chặng không khai riêng thì dùng ngưỡng chung này. */
export const FRESHNESS_DEFAULT: FreshnessThreshold = { aging: 24, stale: 48, critical: 96, why: "Ngưỡng chung cho chặng chưa khai riêng." };

export function thresholdFor(stage: string): FreshnessThreshold {
  return FRESHNESS_BY_STAGE[stage] ?? FRESHNESS_DEFAULT;
}

/**
 * Xếp hạng độ tươi từ số giờ kể từ sự kiện ĐVVC gần nhất.
 *
 * `null` (chưa có sự kiện nào) ⇒ `CRITICAL_STALE`: không có tin tức gì là tình huống xấu nhất, tệ
 * hơn tin cũ. Cố ý KHÔNG trả `FRESH` cho dữ liệu trống.
 */
export function classifyFreshness(hours: number | null, stage: string): FreshnessClass {
  if (hours === null) return "CRITICAL_STALE";
  const t = thresholdFor(stage);
  if (hours >= t.critical) return "CRITICAL_STALE";
  if (hours >= t.stale) return "STALE";
  if (hours >= t.aging) return "AGING";
  return "FRESH";
}

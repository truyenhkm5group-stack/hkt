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
 * ═══════════ "API KHÔNG THẤY VẬN ĐƠN NÀY" LÀ MỘT PHÂN LOẠI, KHÔNG PHẢI MỘT LỖI ═══════════
 *
 * Câu này do `syncViettelPostShipments` ghi vào `shipments.vtp_last_error` khi API trả "không tồn
 * tại". Nó nói về PHẠM VI TÀI KHOẢN — một sự thật cố định của 2.139/2.151 vận đơn — chứ không phải
 * một sự cố của lần gọi, và nó đã có nhà riêng ở `tracking_capability`.
 *
 * Đo trên production 16/09/2026: cả 18 dòng mang `vtp_last_error` đều là ĐÚNG câu này, và hàng đợi
 * đối chiếu bản đầu xếp chúng ở HẠNG MỘT dưới nhãn "Lỗi đối chiếu". Người trực mở hàng đợi, thấy
 * 18 dòng nói "API không đọc được kiện này", và KHÔNG CÓ GÌ để làm — ERP đã biết và đã thôi hỏi.
 * 17 trong số đó còn đang dò dở (`vtp_sync_attempts = 2`) nên sẽ tự chuyển sang `WEBHOOK_ONLY`,
 * trong khi câu lỗi thì nằm lại vĩnh viễn.
 *
 * Nên mọi màn hình coi `vtp_last_error` là VIỆC PHẢI LÀM đều phải loại câu này ra trước.
 */
export const CAPABILITY_SCOPE_ERROR = "Tài khoản API Viettel Post không thấy vận đơn này (vận đơn do Pancake tạo thuộc tài khoản khác)";

/** Câu lỗi này có phải là phán quyết phạm vi tài khoản không (tức KHÔNG phải việc của người trực). */
export function laLoiPhamViTaiKhoan(error: string | null | undefined): boolean {
  return Boolean(error && error.includes("không thấy vận đơn này"));
}

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

/*
 * ═══════════ NGƯỠNG IM LẶNG LÀ QUYẾT ĐỊNH VẬN HÀNH, KHÔNG PHẢI HẰNG SỐ ═══════════
 *
 * Các con số trên dựng từ phân bố đo được 11/09/2026. Nhưng phân bố đó đổi theo mùa: giáp Tết
 * tuyến Bắc chậm thêm một ngày là chuyện bình thường, và một ngưỡng không đổi được sẽ hoặc chôn
 * hàng đợi dưới hàng trăm kiện "cũ" mà không kiện nào đáng lo, hoặc im lặng đúng lúc cần hét.
 *
 * Nên chủ shop sửa được mà không cần deploy. Cùng lối với `work.sla`:
 *
 *  · GHI ĐÈ LÀ THƯA — chỉ chặng nào ĐÃ SỬA mới nằm trong `settings`. Lưu cả bảng thì sửa
 *    `FRESHNESS_BY_STAGE` trong mã sẽ không bao giờ tới được production nữa vì bản chụp cũ đè lên.
 *  · ĐỌC PHẢI LUÔN THÀNH CÔNG — một dòng rác trong `settings` không được làm sập hàng đợi của cả
 *    shop; `sanitizeFreshness` bỏ khoá hỏng và giữ phần còn lại.
 *  · BA MỐC PHẢI TĂNG DẦN. `aging ≤ stale ≤ critical` là điều kiện để `classifyFreshness` còn có
 *    nghĩa: đảo thứ tự thì một kiện nhảy thẳng sang "nghiêm trọng" trước khi kịp "bắt đầu cũ", và
 *    cảnh báo bắn ra sớm hơn chính cái ngưỡng in trên màn hình. Bộ ghi đè sai thứ tự bị BỎ NGUYÊN
 *    CẢ CHẶNG, không sửa hộ — sửa hộ là đoán ý người nhập.
 */

export const FRESHNESS_KEY = "logistics.freshness";

/** Dải cho phép: 1 giờ tới 30 ngày. Ngoài dải là gõ nhầm đơn vị, không phải một quyết định. */
export const FRESHNESS_HOURS_MIN = 1;
export const FRESHNESS_HOURS_MAX = 24 * 30;

/** Chỉ các chặng CÓ KHAI mặc định mới nhận ghi đè — khoá lạ là gõ nhầm, không phải chặng mới. */
export const FRESHNESS_STAGE_KEYS = Object.keys(FRESHNESS_BY_STAGE);

export type FreshnessOverrides = Record<string, { aging: number; stale: number; critical: number }>;

export function sanitizeFreshness(raw: unknown): FreshnessOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: FreshnessOverrides = {};
  for (const [stage, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!FRESHNESS_BY_STAGE[stage]) continue;
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const o = v as Record<string, unknown>;
    const so = (k: string) => {
      const n = Number(o[k]);
      return Number.isFinite(n) && n >= FRESHNESS_HOURS_MIN && n <= FRESHNESS_HOURS_MAX ? Math.round(n) : null;
    };
    const aging = so("aging");
    const stale = so("stale");
    const critical = so("critical");
    if (aging === null || stale === null || critical === null) continue;
    // Thứ tự sai ⇒ bỏ CẢ chặng. Sửa hộ một ô là đoán ý người nhập, và con số đoán ra sẽ đứng trên
    // màn hình như thể có ai đó đã chọn nó.
    if (!(aging <= stale && stale <= critical)) continue;
    out[stage] = { aging, stale, critical };
  }
  return out;
}

/**
 * Ngưỡng ĐANG CÓ HIỆU LỰC cho một chặng: ghi đè của chủ shop nếu có, còn lại lấy từ mã.
 *
 * `why` luôn lấy từ MÃ kể cả khi số bị ghi đè: câu giải thích nói VÌ SAO chặng này cần một ngưỡng
 * riêng, và lý lẽ ấy không đổi khi ai đó chỉnh con số.
 */
export function effectiveThresholdFor(stage: string, overrides: FreshnessOverrides = {}): FreshnessThreshold {
  const base = thresholdFor(stage);
  const o = overrides[stage];
  return o ? { ...o, why: base.why } : base;
}

/** Như `classifyFreshness` nhưng áp ghi đè của chủ shop. Cùng một luật, chỉ khác bộ số. */
export function classifyFreshnessWith(hours: number | null, stage: string, overrides: FreshnessOverrides = {}): FreshnessClass {
  if (hours === null) return "CRITICAL_STALE";
  const t = effectiveThresholdFor(stage, overrides);
  if (hours >= t.critical) return "CRITICAL_STALE";
  if (hours >= t.stale) return "STALE";
  if (hours >= t.aging) return "AGING";
  return "FRESH";
}

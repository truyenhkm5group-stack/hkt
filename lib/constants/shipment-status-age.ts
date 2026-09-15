import type { ShipmentStage } from "@/db/schema";
import type { CaseTeam } from "@/lib/constants/action-queue";
import { CARRIER_EVENT_SOURCES, sqlSourceList } from "@/lib/constants/truth";

/**
 * ═══════════ TUỔI CHẶNG HIỆN TẠI (`status_age`) ═══════════
 *
 * Một câu hỏi, và chỉ một: **kiện này đã đứng ở chặng HIỆN TẠI bao lâu rồi?**
 *
 * ─── VÌ SAO ĐÂY KHÔNG PHẢI CÁI ĐỒNG HỒ ĐÃ CÓ ───
 *
 * ERP đang có hai đồng hồ, và không cái nào trả lời câu trên:
 *
 *  1. **ĐỘ TƯƠI** (`lib/constants/logistics-freshness.ts`) đo IM LẶNG: bao lâu rồi ERP không nghe
 *     tin gì về kiện này. Câu hỏi của nó là *"ERP có biết kiện đang ở đâu không"*.
 *  2. **TUỔI TỪ LÚC TẠO VẬN ĐƠN** (rổ `AWAITING_PICKUP` của tháp giao vận) đo từ `created_at`.
 *     Câu hỏi của nó là *"gói hàng đã đi chưa"*.
 *
 * Hai cái đó KHÔNG thay được tuổi chặng, và chính kho mã này đã ghi lại cái giá của việc thiếu nó.
 * Chú thích của rổ `AWAITING_PICKUP` (lib/constants/delivery-tower.ts, 13/09/2026) kể đúng một ca:
 * 106 kiện chưa bao giờ rời kho, 61.451.999đ COD, và **0/106 kiện im lặng quá 96 giờ** — vì ĐVVC
 * vẫn đều đặn gửi "phân công bưu tá", nên đồng hồ im lặng cứ bị đặt lại. Chúng có thể nằm đó vĩnh
 * viễn mà không rổ nào chạm tới.
 *
 * Đồng hồ ở đây không bị đặt lại bởi một sự kiện CÙNG CHẶNG. Mười lần "phân công bưu tá" vẫn là
 * mười lần đứng yên ở `PENDING`, và tuổi chặng nói đúng như vậy.
 *
 * ─── MỐC VÀO CHẶNG ĐO TỪ ĐÂU ───
 *
 * `status_age = now − stage_since`, với `stage_since` = **sự kiện SỚM NHẤT trong loạt LIỀN KỀ CUỐI
 * CÙNG mang đúng chặng hiện tại của vận đơn**. Nói cách khác: lùi từ sự kiện mới nhất về trước,
 * đi ngược qua các sự kiện cùng chặng, dừng ở sự kiện đầu tiên mang chặng KHÁC.
 *
 * Vì sao phải là "loạt liền kề cuối cùng" chứ không phải `min()` của mọi sự kiện cùng chặng: một
 * kiện đi `IN_TRANSIT → OUT_FOR_DELIVERY → DELIVERY_FAILED → IN_TRANSIT` (quay lại tuyến sau khi
 * giao hụt) mà lấy `min()` thì tuổi chặng của nó tính từ lần trung chuyển ĐẦU TIÊN — ra một con số
 * lớn gấp nhiều lần sự thật, và một cảnh báo dựa trên con số đó là cảnh báo giả.
 *
 * ─── BA QUYẾT ĐỊNH VỀ DỮ LIỆU, KHAI THẲNG ───
 *
 *  1. **Chặng hiện tại lấy ở `shipments.stage`**, không lấy ở sự kiện mới nhất. `shipments.stage`
 *     là chặng CHUẨN HOÁ của ERP, có đúng hai nơi ghi (`SHIPMENT_STAGE_WRITERS`). Đọc chặng từ sự
 *     kiện mới nhất là dựng một sự thật thứ hai song song với nó.
 *  2. **Sự kiện không mang chặng (`NULL`) hoặc mang `UNKNOWN` bị BỎ QUA** — không cắt loạt, không
 *     kéo dài loạt. Chúng không khẳng định kiện đang ở chặng nào, nên để chúng cắt loạt là làm
 *     tuổi chặng ngắn đi vì một dòng không nói gì.
 *  3. **Không có sự kiện nào mang chặng hiện tại ⇒ `NULL` ⇒ CHƯA BIẾT.** KHÔNG lùi về
 *     `shipments.created_at`, `updated_at`, `orders.inserted_at` hay bất kỳ mốc nào của ERP: đó là
 *     mốc của ERP hoặc của người bấm nút, không phải mốc kiện hàng vào chặng. Kiện như vậy nằm
 *     NGOÀI cohort và **số kiện rơi ra phải in ra cạnh bảng** — cùng luật với `carrier_handoff_at`
 *     (AGENTS.md mục 41) và cùng luật "CHƯA BIẾT không in thành 0" (mục 42).
 *
 * ─── NGƯỠNG LÀ GIẢ THIẾT CỦA NGƯỜI, VÀ ĐÃ ĐƯỢC ĐO LẠI ───
 *
 * Các ngưỡng dưới đây do người đặt theo hiểu biết nghiệp vụ. Ngày 15/09/2026 chúng được ĐỐI CHIẾU
 * với phân bố thật trên production (ops `db-query` CHỈ ĐỌC, runs #1024 và #1026), 406 kiện đang chạy:
 *
 *   chặng              n    đo được   p50     p75     p90     lớn nhất
 *   RETURNING         165     149    33,4h   98,0h   240,8h    287h
 *   PENDING           109     109    58,1h  122,8h   148,7h   5672h
 *   IN_TRANSIT         80      80    37,2h   49,7h    49,9h    114,6h
 *   DELIVERY_FAILED    33      33    31,4h   71,5h    98,7h    242,3h
 *   OUT_FOR_DELIVERY   19      19    10,2h   33,2h   103,4h    170,7h
 *
 * Số kiện VƯỢT ngưỡng đang cài (cùng lượt đo):
 *
 *   chặng              n    quá hạn   cảnh báo   để mắt
 *   RETURNING         166    24 (14%)    38        66
 *   PENDING           109    42 (39%)   104 (95%) 104 (95%)
 *   IN_TRANSIT         80     2 (2,5%)   40        46
 *   DELIVERY_FAILED    33    24 (73%)    25        27
 *   OUT_FOR_DELIVERY   18     7 (39%)     8        14
 *
 * ─── HAI ĐIỀU SỐ ĐO NÓI RA, VÀ CHÚNG KHÁC NHAU ───
 *
 * 1. **`PENDING` có ngưỡng HỎNG.** Mức "để mắt" (24h) và mức "cảnh báo" (48h) cùng bắt 104/109 kiện
 *    — 95%, và hai mức KHÔNG phân biệt được nhau. Một mức cảnh báo bật trên 95% dân số không mang
 *    một bit thông tin nào. Phân bố thật (p50 58h · p75 123h · p90 149h) nói rằng chờ bưu tá tới
 *    lấy ~2,5 ngày là mặt bằng của shop này.
 *
 * 2. **`DELIVERY_FAILED` 73% quá hạn KHÔNG phải ngưỡng hỏng.** Ngưỡng 24 giờ đến thẳng từ yêu cầu
 *    của chủ shop ("giao không thành công: xử lý trong 12–24h"), và trung vị thực tế là 31,4 giờ.
 *    Con số ấy nói SHOP ĐANG CHẬM trên đúng nhóm cứu được nhiều tiền nhất, không nói cái thước sai.
 *    Nới ngưỡng ở đây là bịt đồng hồ báo cháy cho đỡ ồn.
 *
 * `IN_TRANSIT` (2,5% quá hạn, p90 49,9h dưới ngưỡng 72h) là ngưỡng hiệu chỉnh tốt — giữ nguyên.
 *
 * ─── VÌ SAO MÃ NGUỒN KHÔNG TỰ SỬA CON SỐ NÀO ───
 *
 * Ngưỡng SLA là NGƯỠNG NGHIỆP VỤ, và `AGENTS.md` mục 7 buộc hỏi chủ shop trước khi đổi. Phân biệt
 * hai câu trên — "cái thước sai" và "đội đang chậm" — là một quyết định kinh doanh, không phải một
 * phép tính. Nên số đo nằm ở đây làm bằng chứng, còn con số vẫn nguyên và sửa được KHÔNG CẦN DEPLOY
 * qua `settings` khoá `logistics.dwell-sla` (màn hình cấu hình: Công việc → Cấu hình).
 *
 * **Đề xuất chờ chủ shop quyết** — chỉ cho `PENDING`, theo đúng phân bố đo được:
 *   để mắt 48h (≈ p50) · cảnh báo 96h (≈ p75) · ngoại lệ 168h (≈ p90+)
 * Bốn chặng còn lại giữ nguyên.
 */

/**
 * ═══ CHẶNG NÀO THUỘC ĐỒNG HỒ NÀY, CHẶNG NÀO KHÔNG ═══
 *
 * `null` = CỐ Ý không đặt ngưỡng, và có đúng hai lý do:
 *
 *  · **Chặng KẾT THÚC** (`DELIVERED` · `RETURNED` · `CANCELLED`): kiện đã xong việc của nó. Tuổi
 *    chặng vẫn ĐO ĐƯỢC và vẫn hiện ra (bao lâu rồi kiện đã giao xong), nhưng nó không còn là việc
 *    của ai — đặt hạn ở đây là bịa ra một hàng đợi trễ hạn gồm toàn việc đã xong.
 *  · **`UNKNOWN`**: không biết kiện đang ở chặng nào thì không có ngưỡng nào áp được. Việc phải làm
 *    với nhóm này là ĐI TRA, và nó đã có chủ: rổ "Quá lâu không cập nhật" của tháp giao vận.
 *
 * `RETURNING` CÓ ngưỡng: hàng đang trên đường về vẫn là vốn nằm ngoài kho, và hàng hoàn quá lâu
 * chưa về là một khiếu nại phải mở — khác hẳn `RETURNED` (đã về, việc chuyển sang kho kiểm đếm).
 */
export type DwellThreshold = {
  /** Bắt đầu để mắt. Chưa phải việc, chỉ là "đừng quên cái này". */
  watch: number;
  /** Bất thường: cần người nhìn vào trong ngày. */
  warning: number;
  /** Ngoại lệ: phải có người xử lý, và nó vào hàng đợi việc. */
  exception: number;
  why: string;
};

export const DWELL_SLA: Record<ShipmentStage, DwellThreshold | null> = {
  /*
    Hàng CÒN TRONG KHO. Số giờ lấy lại từ `FRESHNESS_BY_STAGE.PENDING` (24/48/96) — không gõ số
    mới. Đó là bộ số đã được dựng từ phân bố production 11/09/2026, và rổ `AWAITING_PICKUP` của
    tháp giao vận đã dùng chính `.critical` của nó làm ĐỒNG HỒ TUỔI (không phải đồng hồ im lặng)
    từ 13/09 — nên tái dùng ở đây là nối tiếp một tiền lệ đã có, không phải trộn hai loại đồng hồ.
  */
  PENDING: {
    watch: 24,
    warning: 48,
    exception: 96,
    why:
      "Kiện chưa rời kho: chậm vài ngày ở giờ cao điểm là chuyện thường, nhưng quá 4 ngày thì gói hàng có thể đã thất lạc ngay trong kho — " +
      "và đây là nhóm cứu được TRỌN VẸN vì hàng vẫn trong tay shop. ĐO 15/09/2026: p50 58h, p75 123h, p90 149h — hai mức dưới cùng bắt " +
      "104/109 kiện (95%) nên chúng đang KHÔNG phân biệt được nhau. Đề xuất 48/96/168 đang chờ chủ shop quyết (xem đầu tệp).",
  },
  PICKED_UP: {
    watch: 12,
    warning: 24,
    exception: 72,
    why: "Vừa rời kho thì phải có mốc nhập tuyến sớm. Đứng yên ở 'đã lấy hàng' quá một ngày nghĩa là kiện chưa vào được tuyến nào.",
  },
  /*
    Chủ shop đề xuất 24 / 48 / 72 cho "đang vận chuyển". Đồng hồ IM LẶNG của cùng chặng đang là
    24/48/96. Lấy 72 theo đề xuất, và ĐÂY KHÔNG PHẢI MÂU THUẪN: im lặng 96 giờ là "ERP không nghe
    tin gì"; đứng yên 72 giờ ở cùng một chặng là "kiện không đi tới đâu" — câu sau nghiêm trọng
    hơn, nên ngưỡng chặt hơn là đúng chiều.
  */
  IN_TRANSIT: {
    watch: 24,
    warning: 48,
    exception: 72,
    why: "Mỗi chặng tuyến thường có một mốc mỗi ngày. Ba ngày không nhích khỏi 'đang trung chuyển' là kiện đang nằm ở một bưu cục nào đó, không phải đang chạy.",
  },
  /*
    "Đang giao" phải kết thúc TRONG NGÀY: hoặc khách nhận, hoặc bưu tá ghi giao hụt. Đề xuất của
    chủ shop — "qua ngày mà chưa kết thúc: warning; 24h: exception" — dịch thẳng thành 12/24 và
    không cần một con số thứ ba lớn hơn.
  */
  OUT_FOR_DELIVERY: {
    watch: 8,
    warning: 12,
    exception: 24,
    why: "Bưu tá đã cầm kiện đi giao thì kết quả phải có trong ngày. Quá 24 giờ mà không có kết cục nghĩa là ERP không biết kiện đã tới tay khách hay chưa — và mọi báo cáo phía sau đang đứng trên một dấu hỏi.",
  },
  /*
    Giao hụt là nhóm CỨU ĐƯỢC NHIỀU TIỀN NHẤT (`RECOVERABILITY.DELIVERY_FAILED = 1`). Ngưỡng theo
    đề xuất của chủ shop: xử lý trong 12–24 giờ.
  */
  DELIVERY_FAILED: {
    watch: 6,
    warning: 12,
    exception: 24,
    why: "Cửa sổ gọi lại khách sau khi giao hụt rất ngắn — quá một ngày là bưu tá đã đi tuyến khác và đơn rơi vào chiều hoàn. Đây là nhóm cứu được nhiều tiền nhất nên ngưỡng chặt nhất.",
  },
  RETURNING: {
    watch: 48,
    warning: 96,
    exception: 168,
    why: "Chiều hoàn vốn chậm và ít mốc hơn chiều đi. Nhưng quá một tuần chưa về tới kho thì đó là hàng có nguy cơ thất lạc trên đường về — phải mở khiếu nại, không phải chờ tiếp.",
  },

  /* ─── Chặng KẾT THÚC: đo được, nhưng không đặt hạn. Xem chú thích ở trên. ─── */
  DELIVERED: null,
  RETURNED: null,
  CANCELLED: null,
  UNKNOWN: null,
};

/** Bốn mức, theo đúng thứ tự nặng dần. */
export const DWELL_LEVELS = ["OK", "WATCH", "WARNING", "EXCEPTION"] as const;
export type DwellLevel = (typeof DWELL_LEVELS)[number];

export const DWELL_LEVEL_LABEL: Record<DwellLevel, string> = {
  OK: "Trong hạn",
  WATCH: "Để mắt",
  WARNING: "Bất thường",
  EXCEPTION: "Ngoại lệ · phải xử lý",
};

export const DWELL_LEVEL_TONE: Record<DwellLevel, string> = {
  OK: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  WATCH: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  WARNING: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  EXCEPTION: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
};

/**
 * VÌ SAO KHÔNG KẾT LUẬN ĐƯỢC MỨC. Ba lý do, ba nghĩa khác hẳn nhau — và không lý do nào được in
 * ra thành "Trong hạn", vì "chưa đo được" không phải "đang ổn" (AGENTS.md mục 39, 42).
 */
export const DWELL_UNRATED = ["NO_EVIDENCE", "TERMINAL_STAGE", "NO_THRESHOLD"] as const;
export type DwellUnrated = (typeof DWELL_UNRATED)[number];

export const DWELL_UNRATED_LABEL: Record<DwellUnrated, string> = {
  NO_EVIDENCE: "Chưa biết vào chặng lúc nào",
  TERMINAL_STAGE: "Chặng kết thúc · không đặt hạn",
  NO_THRESHOLD: "Chặng chưa khai ngưỡng",
};

export const DWELL_UNRATED_HINT: Record<DwellUnrated, string> = {
  NO_EVIDENCE:
    "Không có sự kiện ĐVVC nào mang đúng chặng hiện tại của vận đơn, nên KHÔNG có mốc vào chặng. Kiện nằm ngoài cohort đo tuổi chặng — đây là chỗ trống dữ liệu, không phải một kiện đang ổn.",
  TERMINAL_STAGE: "Kiện đã tới chặng kết thúc (giao xong · hoàn xong · huỷ). Tuổi chặng vẫn đo được nhưng không còn là việc của ai.",
  NO_THRESHOLD: "Chặng này chưa khai ngưỡng tuổi. Việc phải làm là đi tra kiện đang ở đâu, và nó thuộc rổ 'Quá lâu không cập nhật' của tháp giao vận.",
};

/** Chặng KẾT THÚC — dùng để phân biệt "không đặt hạn vì đã xong" với "chưa khai ngưỡng". */
export const TERMINAL_STAGES: readonly ShipmentStage[] = ["DELIVERED", "RETURNED", "CANCELLED"] as const;

/**
 * ═══ NHỮNG THỨ ĐỒNG HỒ NÀY CỐ Ý KHÔNG ĐO ═══
 *
 * Chủ shop liệt kê "chờ phát lại · chờ xử lý · chờ duyệt hoàn" cùng nhóm với các chặng ĐVVC. Chúng
 * KHÔNG phải chặng ĐVVC: chúng là trạng thái CARE NỘI BỘ (`shipment_care.care_status`), và mỗi cái
 * đã có hạn riêng ở `CARE_SLA` + luật `SHIPMENT_CARE` của `lib/constants/work-sla.ts`.
 *
 * Khai ra ở đây, giống hệt `ALERT_KINDS_OWNED_ELSEWHERE`, vì lý do giống hệt: đặt thêm một hạn
 * thứ hai cho cùng một sự việc thì người cấu hình sửa một cái và tưởng đã xong, còn mọi bảng tổng
 * hợp đếm việc đó HAI LẦN.
 */
export const DWELL_OWNED_ELSEWHERE = [
  { what: "Chờ phát lại", owner: "shipment_care.care_status = 'WAITING_REDELIVERY' · CARE_SLA" },
  { what: "Chờ xử lý (đội đang cầm)", owner: "shipment_care.care_status = 'IN_PROGRESS' · CARE_SLA.resolveHours" },
  { what: "Chờ duyệt hoàn", owner: "shipment_care.care_status = 'WAITING_CARRIER' · CARE_SLA + hàng đợi kiểm đếm hàng hoàn" },
] as const;

/**
 * ═══ NGUỒN NÀO ĐƯỢC LÀM CHỨNG CHO MỐC VÀO CHẶNG ═══
 *
 * KHÁC `CARRIER_DOCUMENT_SOURCES` của `carrier_handoff_at`, và sự khác đó là cố ý.
 *
 * Mốc bàn giao là một khẳng định định nghĩa COHORT: nó quyết định kiện nào vào lô "đã gửi" của
 * tuần, nên nó chỉ nhận chứng từ đến thẳng từ ĐVVC. Mốc vào chặng là một ĐỒNG HỒ VẬN HÀNH: nó
 * không vào một báo cáo tiền nào, và mục đích duy nhất của nó là **không để sót kiện nào**.
 *
 * Đo trên production 11/09/2026, đếm sự kiện theo nguồn:
 *   PANCAKE 22.773 sự kiện · 1.630 vận đơn   |   VTP_WEBHOOK 2.713 · 624   |   VTP_IMPORT 1.626
 *
 * Bỏ `PANCAKE` ra khỏi danh sách này thì khoảng một nghìn vận đơn ĐANG SỐNG rơi thẳng vào
 * "chưa biết" — tức là cái đồng hồ sinh ra để không sót kiện nào lại tự làm mù đúng phần lớn nhất
 * của kho vận đơn. Pancake ở đây là ĐVVC CHUYỂN TIẾP, không phải một nguồn sự thật thứ hai.
 *
 * Luật "dữ liệu Viettel Post ưu tiên hơn Pancake" (AGENTS.md mục 3.6) không bị đụng tới: nó nói về
 * cách xử lý MÂU THUẪN khi hai nguồn nói khác nhau, còn ở đây cả hai nói cùng một điều — chặng nào,
 * lúc nào. Và `sinceBasis` ghi lại nguồn nào đã cấp mốc, nên đếm được bao nhiêu kiện đang dựa vào
 * bản chuyển tiếp thay vì chứng từ gốc.
 */
export const PANCAKE_RELAY_SOURCE = "PANCAKE" as const;
export const DWELL_EVIDENCE_SOURCES: readonly string[] = [...CARRIER_EVENT_SOURCES, PANCAKE_RELAY_SOURCE] as const;

/** Nguồn đã cấp mốc vào chặng. `null` khi chưa có mốc. */
export type DwellBasis = "CARRIER_DOCUMENT" | "PANCAKE_RELAY";

export const DWELL_BASIS_LABEL: Record<DwellBasis, string> = {
  CARRIER_DOCUMENT: "Chứng từ ĐVVC",
  PANCAKE_RELAY: "Pancake chuyển tiếp",
};

export const DWELL_BASIS_HINT: Record<DwellBasis, string> = {
  CARRIER_DOCUMENT: "Sự kiện đến thẳng hệ thống Viettel Post (webhook · tệp bảng kê · tra API · người chép tay từ trang ĐVVC).",
  PANCAKE_RELAY: "Trạng thái ĐVVC do Pancake chuyển tiếp. Vẫn là mốc của ĐVVC, chỉ là đi qua một chặng nữa — dùng được cho đồng hồ vận hành, KHÔNG dùng làm chứng từ kết luận đơn.",
};

/** Khoá `settings` chứa phần chủ shop ghi đè. Chỉ giữ số giờ; nhãn và lý do nằm ở mã. */
export const DWELL_SLA_SETTING_KEY = "logistics.dwell-sla";

/**
 * Ghi đè từng chặng. `null` cho cả chặng = tắt hạn cho chặng đó (một quyết định có người ký), còn
 * bỏ trống một mức thì mức đó lấy mặc định.
 */
export type DwellOverrides = Partial<Record<ShipmentStage, Partial<DwellThreshold> | null>>;

export function thresholdOf(stage: ShipmentStage, overrides?: DwellOverrides | null): DwellThreshold | null {
  const base = DWELL_SLA[stage];
  if (!overrides || !Object.hasOwn(overrides, stage)) return base;
  const ov = overrides[stage];
  if (ov === null) return null;
  if (!ov) return base;
  // Ghi đè một phần mà chặng chưa có mặc định thì phải khai ĐỦ ba mức — nửa bộ ngưỡng là bộ ngưỡng sai.
  if (!base) {
    const { watch, warning, exception } = ov;
    if (watch === undefined || warning === undefined || exception === undefined) return null;
    return { watch, warning, exception, why: ov.why ?? "Ngưỡng do chủ shop khai, chặng này không có mặc định." };
  }
  return { ...base, ...ov };
}

/** Mức tuổi chặng. Ngưỡng là "ĐẠT tới thì tính", nên đúng 24 giờ ở ngưỡng 24 đã là mức đó. */
export function dwellLevelOf(ageHours: number, t: DwellThreshold): DwellLevel {
  if (ageHours >= t.exception) return "EXCEPTION";
  if (ageHours >= t.warning) return "WARNING";
  if (ageHours >= t.watch) return "WATCH";
  return "OK";
}

/* ═══════════════════ ĐO MỐC VÀO CHẶNG ═══════════════════ */

export type DwellEvent = {
  source: string;
  /** Chặng chuẩn hoá của sự kiện. `null` / `UNKNOWN` = không khẳng định chặng nào — bị bỏ qua. */
  normalizedStage: ShipmentStage | null;
  occurredAt: Date | null;
};

export type DwellVerdict = {
  /** Mốc vào chặng hiện tại. `null` = CHƯA BIẾT, không phải "vừa mới vào". */
  since: Date | null;
  /** Giờ đã đứng ở chặng hiện tại. `null` khi `since` là `null`. */
  ageHours: number | null;
  /** `null` khi không kết luận được — đọc `unrated` để biết vì sao. */
  level: DwellLevel | null;
  unrated: DwellUnrated | null;
  /** Số sự kiện thuộc loạt liền kề cuối cùng. `1` = vừa vào chặng; lớn hơn = đã lặp lại tại chỗ. */
  eventsInRun: number;
  /** Nguồn đã cấp mốc vào chặng. `null` khi chưa có mốc. */
  sinceBasis: DwellBasis | null;
};

const ALLOWED_SOURCES = new Set<string>(DWELL_EVIDENCE_SOURCES);
const DOC_SOURCES = new Set<string>(CARRIER_EVENT_SOURCES);

function usable(e: DwellEvent): e is DwellEvent & { normalizedStage: ShipmentStage; occurredAt: Date } {
  if (!ALLOWED_SOURCES.has(e.source)) return false;
  if (!e.normalizedStage || e.normalizedStage === "UNKNOWN") return false;
  return e.occurredAt instanceof Date && Number.isFinite(e.occurredAt.getTime());
}

/**
 * BẢN SINH ĐÔI BẰNG TYPESCRIPT của `STAGE_SINCE_SQL`. Hàm THUẦN: cùng tập sự kiện ⇒ cùng kết quả,
 * bất kể thứ tự truyền vào và bất kể gọi bao nhiêu lần. Phát lại một gói tin webhook mười lần vẫn
 * ra đúng một mốc — `tests/shipment-status-age.test.ts` chứng minh thay vì tin lời.
 */
export function stageDwellFrom(
  events: readonly DwellEvent[],
  currentStage: ShipmentStage,
  now: Date,
  overrides?: DwellOverrides | null,
): DwellVerdict {
  const rated = (v: Omit<DwellVerdict, "level" | "unrated">): DwellVerdict => {
    if (v.ageHours === null) return { ...v, level: null, unrated: "NO_EVIDENCE" };
    if (TERMINAL_STAGES.includes(currentStage)) return { ...v, level: null, unrated: "TERMINAL_STAGE" };
    const t = thresholdOf(currentStage, overrides);
    if (!t) return { ...v, level: null, unrated: "NO_THRESHOLD" };
    return { ...v, level: dwellLevelOf(v.ageHours, t), unrated: null };
  };

  // Mốc cắt: sự kiện MỚI NHẤT mang một chặng KHÁC. Mọi sự kiện cùng chặng sau mốc đó là một loạt.
  let cut: number | null = null;
  for (const e of events) {
    if (!usable(e) || e.normalizedStage === currentStage) continue;
    const t = e.occurredAt.getTime();
    if (cut === null || t > cut) cut = t;
  }

  let since: number | null = null;
  let sinceBasis: DwellBasis | null = null;
  let eventsInRun = 0;
  for (const e of events) {
    if (!usable(e) || e.normalizedStage !== currentStage) continue;
    const t = e.occurredAt.getTime();
    if (cut !== null && t <= cut) continue;
    eventsInRun += 1;
    const basis: DwellBasis = DOC_SOURCES.has(e.source) ? "CARRIER_DOCUMENT" : "PANCAKE_RELAY";
    // Bằng giờ thì CHỨNG TỪ GỐC thắng bản chuyển tiếp — cùng luật phá hoà với `carrierHandoffFrom`.
    if (since === null || t < since || (t === since && basis === "CARRIER_DOCUMENT")) {
      since = t;
      sinceBasis = basis;
    }
  }

  if (since === null) return rated({ since: null, ageHours: null, eventsInRun: 0, sinceBasis: null });
  return rated({ since: new Date(since), ageHours: Math.max(0, (now.getTime() - since) / 3_600_000), eventsInRun, sinceBasis });
}

/* ═══════════════════ BIỂU THỨC SQL ═══════════════════ */

const SOURCES = sqlSourceList(DWELL_EVIDENCE_SOURCES);

/**
 * MỐC VÀO CHẶNG HIỆN TẠI, dạng biểu thức tương quan để dùng trong `select` / `where`.
 *
 * Dùng TÊN BẢNG ĐẦY ĐỦ `"shipments"` chứ không phải bí danh: Drizzle phát ra tên bảng thật, nên
 * một chuỗi SQL thô mang bí danh sẽ hỏng với "missing FROM-clause entry" (cùng cái bẫy đã ghi ở
 * `lib/constants/carrier-handoff.ts`).
 *
 * `'-infinity'::timestamptz` cho trường hợp CHƯA từng có sự kiện chặng khác — khi đó cả loạt sự
 * kiện cùng chặng đều được tính, đúng như bản TypeScript.
 *
 * Chi phí: hai lượt quét theo `shipment_events_shipment_idx` (shipment_id, occurred_at) cho mỗi
 * vận đơn — không có lượt quét toàn bảng nào.
 */
export const STAGE_SINCE_SQL = `(select min(e.occurred_at) from shipment_events e
  where e.shipment_id = "shipments"."id"
    and e.source in (${SOURCES})
    and e.normalized_stage::text = "shipments"."stage"::text
    and e.occurred_at > coalesce((
      select max(e2.occurred_at) from shipment_events e2
      where e2.shipment_id = "shipments"."id"
        and e2.source in (${SOURCES})
        and e2.normalized_stage is not null
        and e2.normalized_stage::text <> 'UNKNOWN'
        and e2.normalized_stage::text <> "shipments"."stage"::text
    ), '-infinity'::timestamptz))`;

/** Giờ đã đứng ở chặng hiện tại. `NULL` = CHƯA BIẾT — đừng bọc `coalesce(..., 0)` quanh nó. */
export const STAGE_AGE_HOURS_SQL = `(extract(epoch from (now() - ${STAGE_SINCE_SQL})) / 3600.0)`;

/* ═══════════════════ VIỆC PHẢI LÀM VÀ AI LÀM ═══════════════════ */

/**
 * VIỆC TIẾP THEO cho một kiện đứng quá lâu ở chặng này. Bắt buộc phải có với MỌI chặng có ngưỡng:
 * một ngoại lệ chỉ có ghi chú mà không có việc phải làm thì không ai làm nó (yêu cầu mục 18 của
 * chủ shop). Câu ở đây là việc của CHẶNG; việc của từng kiện cụ thể do người xử lý ghi thêm.
 *
 * Chặng kết thúc vẫn có câu, nhưng là câu MÔ TẢ — chúng không sinh việc vì không có hạn.
 */
export const DWELL_NEXT_ACTION: Record<ShipmentStage, string> = {
  PENDING:
    "Gọi bưu cục giục tới lấy hàng. Nếu ĐVVC ghi “khách chưa chuẩn bị xong hàng” thì hỏi KHO trước — có thể hàng chưa đóng chứ không phải bưu tá chậm. Hàng vẫn trong tay shop nên cứu được trọn vẹn.",
  PICKED_UP: "Tra mã trên trang Viettel Post xem kiện đã vào tuyến nào chưa; chưa có mốc nhập tuyến thì gọi bưu cục nhận hàng hỏi kiện đang nằm ở đâu.",
  IN_TRANSIT: "Gọi tổng đài ĐVVC hỏi kiện đang mắc ở bưu cục nào và bao giờ đi tiếp; không có câu trả lời thì mở khiếu nại thất lạc.",
  OUT_FOR_DELIVERY: "Gọi khách hỏi đã nhận hàng chưa, rồi gọi bưu tá xác nhận kết quả chuyến giao. KHÔNG kết luận đã giao từ việc kiện nằm lâu ở trạng thái này.",
  DELIVERY_FAILED: "Gọi khách xác nhận còn nhận hàng không, rồi báo bưu tá phát lại. Khách từ chối thì duyệt hoàn SỚM để đỡ cước lưu kho — đừng để treo.",
  RETURNING: "Tra tiến độ chiều hoàn; quá hạn mà chưa về tới kho thì mở khiếu nại với ĐVVC. Hàng hoàn chưa về là vốn đang nằm ngoài kho.",
  DELIVERED: "Không còn việc của giao vận. Phần còn lại là đối soát COD.",
  RETURNED: "Kho kiểm đếm thực nhận rồi lập phiếu tái nhập — hàng hoàn KHÔNG tự vào tồn.",
  CANCELLED: "Không còn việc. Kiểm tra đơn gốc đã được xử lý đúng chưa.",
  UNKNOWN: "Tra mã trên trang Viettel Post rồi nhập tay mốc trạng thái để vá lại lịch sử.",
};

/**
 * PHÒNG CHỊU TRÁCH NHIỆM theo chặng — phân tách trách nhiệm theo vòng đời (yêu cầu mục 8).
 * Dùng lại đúng `CaseTeam` của `lib/constants/action-queue.ts`, không đặt tên nhóm riêng.
 *
 * `PENDING` thuộc KHO chứ không thuộc giao vận, và đó là một quyết định: kiện chưa rời kho thì
 * hàng vẫn trong tay shop, người đi giục bưu tá là người đang giữ hàng.
 */
export const DWELL_TEAM: Record<ShipmentStage, CaseTeam> = {
  PENDING: "WAREHOUSE",
  PICKED_UP: "LOGISTICS",
  IN_TRANSIT: "LOGISTICS",
  // Có khách thật đang chờ ở đầu kia, và việc phải làm là GỌI.
  OUT_FOR_DELIVERY: "CS",
  DELIVERY_FAILED: "CS",
  RETURNING: "LOGISTICS",
  DELIVERED: "FINANCE",
  RETURNED: "WAREHOUSE",
  CANCELLED: "LOGISTICS",
  UNKNOWN: "DATA",
};

/* ═══════════════════ ĐỌC CẤU HÌNH AN TOÀN ═══════════════════ */

/**
 * LỌC SẠCH PHẦN GHI ĐÈ TRƯỚC KHI DÙNG.
 *
 * Bảng ghi đè nằm ở `settings` — một ô JSON mà người sửa được qua màn hình cấu hình VÀ qua ops
 * `set-setting`. Nghĩa là nó có thể mang bất cứ hình dạng nào: một chuỗi, một số, một chặng không
 * tồn tại, một ngưỡng âm, hay ba mức đảo lộn thứ tự.
 *
 * Một cấu hình hỏng KHÔNG được làm sập bộ phát hiện (yêu cầu mục 9 của chủ shop). Nên mọi giá trị
 * không đọc được đều bị BỎ QUA và chặng đó rơi về mặc định của mã — hướng AN TOÀN, vì mặc định là
 * bộ số đã chạy thật. Cách hỏng duy nhất còn lại là "sửa xong mà không thấy đổi gì", và cách đó
 * nhìn ra được ngay trên màn hình.
 *
 * Ba mức phải TĂNG DẦN: `watch <= warning <= exception`. Đảo thứ tự thì một kiện 10 giờ có thể xếp
 * `EXCEPTION` trong khi kiện 100 giờ xếp `WATCH` — bảng màu nói ngược với sự thật.
 */
export function sanitizeDwellOverrides(raw: unknown): DwellOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: DwellOverrides = {};
  const nguon = raw as Record<string, unknown>;

  for (const stage of Object.keys(DWELL_SLA) as ShipmentStage[]) {
    if (!Object.hasOwn(nguon, stage)) continue;
    const v = nguon[stage];
    // `null` là một quyết định có nghĩa: TẮT hạn cho chặng này.
    if (v === null) {
      out[stage] = null;
      continue;
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;

    const o = v as Record<string, unknown>;
    const so = (k: string): number | undefined => {
      const n = o[k];
      // Chỉ nhận số hữu hạn, dương, và trong cùng biên với bảng hạn công việc.
      return typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 2160 ? n : undefined;
    };
    const phan: Partial<DwellThreshold> = {};
    const w = so("watch");
    const wa = so("warning");
    const ex = so("exception");
    if (w !== undefined) phan.watch = w;
    if (wa !== undefined) phan.warning = wa;
    if (ex !== undefined) phan.exception = ex;
    if (typeof o.why === "string" && o.why.trim()) phan.why = o.why.trim();
    if (!Object.keys(phan).length) continue;

    // Kiểm thứ tự trên BỘ NGƯỠNG CUỐI CÙNG (mặc định đã áp phần ghi đè), không chỉ trên phần gửi lên.
    const base = DWELL_SLA[stage];
    const cuoi = base ? { ...base, ...phan } : phan;
    if (cuoi.watch !== undefined && cuoi.warning !== undefined && cuoi.exception !== undefined) {
      if (!(cuoi.watch <= cuoi.warning && cuoi.warning <= cuoi.exception)) continue;
    }
    out[stage] = phan;
  }
  return out;
}

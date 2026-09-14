/**
 * ═══════════ TỪ "HOÀN BAO NHIÊU" SANG "AI PHẢI SỬA CÁI GÌ" ═══════════
 *
 * ─── VẤN ĐỀ ───
 *
 * Báo cáo hoàn hiện nói được rất chính xác *bao nhiêu đơn hoàn* và *vì lý do gì*. Nhưng một con số
 * "hoàn 55,4%" không tự đi tới ai cả. Chủ shop đọc xong vẫn phải tự dịch: lý do này thuộc về xưởng
 * hay thuộc về bảng size? Ca "khách từ chối" là lỗi sản phẩm hay là khách đổi ý?
 *
 * Tệp này là BẢN DỊCH ĐÓ, viết ra thành luật thay vì để mỗi người đọc tự dịch một kiểu.
 *
 * ─── BỐN NGUYÊN TẮC, KHÔNG THƯƠNG LƯỢNG ───
 *
 * 1. **Không gom mọi đơn hoàn thành "lỗi sản phẩm".** Năm lớp vấn đề dưới đây có năm phòng ban
 *    khác nhau và năm cách sửa khác nhau. Gộp lại là gửi cả nghìn ca cho một phòng không sửa được
 *    gì — và phòng đó sẽ thôi đọc báo cáo.
 * 2. **Lớp vấn đề SUY TỪ LÝ DO, không suy từ con số.** Tỷ lệ hoàn cao chỉ nói CÓ chuyện; lý do mới
 *    nói chuyện GÌ. Mã hàng hoàn nhiều mà lý do toàn "không liên lạc được" là vấn đề giao vận, và
 *    đem nó đi họp chất lượng vải là phí một buổi họp.
 * 3. **Không có ngưỡng đạt/không đạt ghi cứng ở đây** (AGENTS.md mục 38). Đích nằm ở
 *    `metric_targets`; chưa có đích thì hiện THỰC TẾ và không kết luận. Thứ duy nhất tệp này khai
 *    là CỠ MẪU TỐI THIỂU để một cảnh báo được phép xuất hiện — đó là câu hỏi "đã đủ quan sát để
 *    nói chưa", khác hẳn câu hỏi "bao nhiêu thì gọi là kém".
 * 4. **Việc đề xuất KHÔNG tự giao cho một cá nhân** (AGENTS.md mục 22). Luật sở hữu chỉ trỏ tới
 *    PHÒNG BAN: máy không biết hôm nay ai nghỉ, và một việc mang tên người không làm được nó sẽ
 *    biến mất khỏi hàng đợi phòng.
 */
import type { DepartmentCode } from "@/lib/constants/departments";
import type { ReturnReason } from "@/lib/constants/return-reason";

/* ═══════════════════ NĂM LỚP VẤN ĐỀ ═══════════════════ */

export const PROBLEM_CLASSES = ["PRODUCT_QUALITY", "SIZE_FIT", "LOGISTICS", "SALES_CONSULTING", "CUSTOMER_BEHAVIOR", "DATA_GAP"] as const;
export type ProblemClass = (typeof PROBLEM_CLASSES)[number];

export const PROBLEM_LABEL: Record<ProblemClass, string> = {
  PRODUCT_QUALITY: "Chất lượng sản phẩm",
  SIZE_FIT: "Kích thước / form dáng",
  LOGISTICS: "Giao vận",
  SALES_CONSULTING: "Chốt đơn & nhập liệu",
  CUSTOMER_BEHAVIOR: "Hành vi khách",
  DATA_GAP: "Thiếu dữ liệu",
};

/** Phòng ban SỞ HỮU lớp vấn đề. Không bao giờ là một cá nhân. */
export const PROBLEM_DEPARTMENT: Record<ProblemClass, DepartmentCode> = {
  PRODUCT_QUALITY: "WAREHOUSE",
  SIZE_FIT: "SALES",
  LOGISTICS: "LOGISTICS",
  SALES_CONSULTING: "SALES",
  CUSTOMER_BEHAVIOR: "SALES",
  DATA_GAP: "LOGISTICS",
};

/** Việc phải làm khi lớp này nổi lên. Một câu, đủ để người nhận biết bắt đầu từ đâu. */
export const PROBLEM_ACTION: Record<ProblemClass, string> = {
  PRODUCT_QUALITY: "Kiểm lại lô vải / thành phẩm của mã này trước khi đóng gói lô tiếp theo. Chăm khách kỹ hơn không sửa được nhóm này.",
  SIZE_FIT: "Rà bảng size trên trang bán và kịch bản tư vấn chốt đơn. Nhóm này thường sửa được bằng thông tin, không bằng đổi hàng.",
  LOGISTICS: "Làm việc với Viettel Post về tuyến / bưu tá của các kiện này, và siết hàng đợi chăm sóc kiện chờ phát lại.",
  SALES_CONSULTING: "Rà lại khâu chốt đơn: thông tin khách, địa chỉ, số điện thoại, cam kết với khách trước khi tạo vận đơn.",
  CUSTOMER_BEHAVIOR: "Xem lại chính sách đặt cọc / xác minh SĐT cho nhóm khách và nguồn đơn hay boom.",
  DATA_GAP: "Đi lấy lý do hoàn cho các kiện chưa có chứng từ — bảng lý do chỉ tốt bằng phần dữ liệu đã thu.",
};

/** Vì sao lớp này quan trọng — hiện trên tooltip, để người đọc không phải tin lời. */
export const PROBLEM_HINT: Record<ProblemClass, string> = {
  PRODUCT_QUALITY: "Khách đã cầm hàng trên tay rồi mới từ chối vì sản phẩm. Tiền ship hai chiều đã mất, và hàng về kho thường không bán lại được nguyên giá.",
  SIZE_FIT: "Khách muốn mua nhưng món hàng không vừa. Đây là nhóm dễ cứu nhất: một bảng size đúng đổi thẳng thành đơn giao thành công.",
  LOGISTICS: "Kiện không tới được tay khách vì khâu vận chuyển — không liên lạc được, phát hụt nhiều lần, khách đi vắng.",
  SALES_CONSULTING: "Thông tin đơn sai ngay từ lúc chốt: địa chỉ, số điện thoại, hoặc khách không nhớ đã đặt.",
  CUSTOMER_BEHAVIOR: "Khách cố ý không nhận. Không sửa được bằng sản phẩm hay bằng giao vận.",
  DATA_GAP: "Không phải một lý do — là chỗ chưa có chứng từ. Số này TĂNG sau khi thôi khẳng định thứ không chứng minh được là đúng hướng.",
};

/**
 * LÝ DO → LỚP VẤN ĐỀ. Khai TỪNG lý do, không khai theo nhóm.
 *
 * Nhóm lý do (`RETURN_REASON_GROUP_OF`) trả lời "chuyện gì đã xảy ra"; lớp vấn đề trả lời "ai sửa
 * được". Hai câu hỏi khác nhau nên hai bảng khác nhau — và chúng KHÔNG trùng nhau ở nhóm `OTHER`:
 * `WAREHOUSE_PACKED_WRONG` (kho đóng nhầm) và `SALES_CONFIRMED_WRONG` (sale chốt sai) cùng nằm ở
 * "Lý do khác" nhưng đi tới hai phòng ban khác nhau.
 */
export const PROBLEM_OF_REASON: Record<ReturnReason, ProblemClass> = {
  QUALITY_POOR: "PRODUCT_QUALITY",
  QUALITY_COLOR_BAD: "PRODUCT_QUALITY",
  QUALITY_FABRIC_BAD: "PRODUCT_QUALITY",
  QUALITY_SEWING_BAD: "PRODUCT_QUALITY",
  QUALITY_NOT_AS_PICTURED: "PRODUCT_QUALITY",
  QUALITY_FABRIC_HOT: "PRODUCT_QUALITY",
  QUALITY_TOO_THICK: "PRODUCT_QUALITY",
  QUALITY_FABRIC_THIN: "PRODUCT_QUALITY",
  QUALITY_DEFECT: "PRODUCT_QUALITY",
  QUALITY_LOOKS_BAD_ON: "PRODUCT_QUALITY",
  DAMAGED: "PRODUCT_QUALITY",
  SIZE_TIGHT: "SIZE_FIT",
  SIZE_TIGHT_TOP: "SIZE_FIT",
  SIZE_TIGHT_BOTTOM: "SIZE_FIT",
  SIZE_LOOSE: "SIZE_FIT",
  SIZE_LOOSE_TOP: "SIZE_FIT",
  SIZE_LOOSE_BOTTOM: "SIZE_FIT",
  SIZE_DOES_NOT_FIT: "SIZE_FIT",
  // Tư vấn sai size là lỗi KHÂU BÁN, không phải lỗi bảng size — nên nó thuộc lớp chốt đơn.
  SIZE_SALES_ADVICE_WRONG: "SALES_CONSULTING",
  SLOW_DELIVERY: "LOGISTICS",
  CUSTOMER_AWAY: "LOGISTICS",
  CUSTOMER_UNREACHABLE: "LOGISTICS",
  CUSTOMER_RESCHEDULE_FAILED: "LOGISTICS",
  DELIVERY_ATTEMPTS_EXHAUSTED: "LOGISTICS",
  CARRIER_EXCEPTION: "LOGISTICS",
  CARRIER_NO_SUPPORT: "LOGISTICS",
  BOOM_NO_REASON: "CUSTOMER_BEHAVIOR",
  BOOM_MULTIPLE_ATTEMPTS: "CUSTOMER_BEHAVIOR",
  CUSTOMER_REFUSED: "CUSTOMER_BEHAVIOR",
  CUSTOMER_CHANGED_MIND: "CUSTOMER_BEHAVIOR",
  WRONG_ADDRESS: "SALES_CONSULTING",
  WRONG_PHONE: "SALES_CONSULTING",
  SALES_CONFIRMED_WRONG: "SALES_CONSULTING",
  DUPLICATE_ORDER: "SALES_CONSULTING",
  CANCELLED_BEFORE_SHIP: "SALES_CONSULTING",
  WAREHOUSE_PACKED_WRONG: "PRODUCT_QUALITY",
  WRONG_ITEM: "PRODUCT_QUALITY",
  SHOP_REQUESTED_RETURN: "SALES_CONSULTING",
  /*
    `OTHER` là lý do CÓ CHỨNG TỪ nhưng chứng từ không nói rõ nguyên nhân — khác hẳn `UNKNOWN` (không
    có chứng từ nào). Cả hai đều chưa giao được cho phòng nào sửa, nên cùng thuộc lớp "thiếu dữ
    liệu"; việc phải làm là đi hỏi, không phải đi sửa sản phẩm.
  */
  OTHER: "DATA_GAP",
  UNKNOWN: "DATA_GAP",
};

/* ═══════════════════ KHI NÀO ĐƯỢC PHÉP NÓI ═══════════════════ */

/**
 * CỠ MẪU TỐI THIỂU ĐỂ MỘT CẢNH BÁO ĐƯỢC XUẤT HIỆN.
 *
 * Đây KHÔNG phải ngưỡng đạt/không đạt (thứ đó nằm ở `metric_targets`). Đây là câu hỏi khác: đã đủ
 * quan sát để phát biểu chưa.
 *
 * `minFinished = 20` là con số mà bảng hiệu quả theo mã ĐÃ dùng để in nhãn "mẫu quá nhỏ" bên cạnh
 * tỷ lệ — giữ đúng một ngưỡng cho cả hai chỗ, nếu không màn hình sẽ vừa nói "chưa đủ để kết luận"
 * vừa dựng một cảnh báo dựa trên chính con số đó.
 *
 * `minReasonCases = 5` cho một lý do: dưới mức đó, một ca đổi nhãn làm tỷ trọng nhảy hơn 20 điểm.
 */
export const ALERT_MIN_SAMPLE = {
  /** Đơn ĐÃ KẾT THÚC tối thiểu của một mã hàng để cảnh báo về mã đó. */
  minFinished: 20,
  /** Số ca tối thiểu của một lý do để gọi nó là "nguyên nhân chính". */
  minReasonCases: 5,
  /** Đơn tối thiểu của một marketer để so tỷ lệ hoàn của người đó với toàn shop. */
  minMarketerFinished: 30,
  /** Chênh lệch tối thiểu (điểm %) so với kỳ trước để gọi là "xấu đi", khi cả hai kỳ đủ mẫu. */
  minTrendPoints: 5,
  /** Chênh lệch tối thiểu (điểm %) so với toàn shop để nêu tên một marketer / một mã. */
  minGapPoints: 8,
} as const;

/** Số việc tối đa trong khối "Cần chú ý". Danh sách dài hơn thì không ai xử lý hết — và biết vậy. */
export const ACTION_LIST_MAX = 8;

/* ═══════════════════ MỘT VIỆC ĐỀ XUẤT ═══════════════════ */

export const ACTION_SEVERITIES = ["HIGH", "MEDIUM", "INFO"] as const;
export type ActionSeverity = (typeof ACTION_SEVERITIES)[number];

export const SEVERITY_LABEL: Record<ActionSeverity, string> = {
  HIGH: "Cần xử lý ngay",
  MEDIUM: "Nên xem",
  INFO: "Ghi nhận",
};

export const SEVERITY_TONE: Record<ActionSeverity, string> = {
  HIGH: "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
  MEDIUM: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  INFO: "bg-muted text-muted-foreground",
};

/**
 * MỘT DÒNG TRONG KHỐI "CẦN CHÚ Ý".
 *
 * `evidence` là điều khiến khối này khác một danh sách cảm tính: mỗi dòng mang theo con số và cỡ
 * mẫu đã dựng nên nó, nên người nhận kiểm chứng được thay vì phải tin.
 */
export type ReturnAction = {
  /** Khoá ổn định giữa hai lần tải — để nút "Tạo công việc" không tạo hai việc cho cùng một chuyện. */
  key: string;
  severity: ActionSeverity;
  problem: ProblemClass;
  department: DepartmentCode;
  title: string;
  /** Câu số liệu: cái gì, bao nhiêu, so với cái gì. */
  evidence: string;
  /** Việc phải làm — lấy từ `PROBLEM_ACTION`, có thể được làm cụ thể hơn theo ngữ cảnh. */
  action: string;
  /** Mã hàng liên quan, để nút tạo việc điền sẵn. `null` = việc toàn shop. */
  productCode: string | null;
  /** Đường mở thẳng tới danh sách chứng cứ. */
  href: string | null;
  /** Cỡ mẫu đứng sau dòng này. Luôn in ra cạnh con số. */
  sample: number;
};

/* ═══════════════════ NHÃN RỦI RO CỦA MỘT MÃ HÀNG ═══════════════════ */

/**
 * ═══ NHÃN RỦI RO CHỈ TỒN TẠI KHI CÓ ĐÍCH VÀ CÓ ĐỦ MẪU ═══
 *
 * `NO_TARGET` và `INSUFFICIENT` KHÔNG phải "tốt" và cũng không phải "xấu" — chúng là hai câu trả
 * lời khác nhau cho câu hỏi "vì sao chưa kết luận được", và màn hình phải phân biệt được chúng với
 * `HIGH_RISK` (AGENTS.md mục 39: làm kém khác chưa đủ dữ liệu).
 *
 * Ngưỡng đạt/không đạt KHÔNG nằm ở đây: nó đến từ `metric_targets` qua `evaluateMetric`
 * (AGENTS.md mục 38 và 44). Tệp này chỉ đặt tên cho kết quả.
 */
export const RISK_LEVELS = ["GOOD", "WATCH", "HIGH_RISK", "NO_TARGET", "INSUFFICIENT"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const RISK_LABEL: Record<RiskLevel, string> = {
  GOOD: "Đạt đích",
  WATCH: "Cần chú ý",
  HIGH_RISK: "Rủi ro cao",
  NO_TARGET: "Chưa đặt đích",
  INSUFFICIENT: "Chưa đủ dữ liệu",
};

export const RISK_TONE: Record<RiskLevel, string> = {
  GOOD: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  WATCH: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  HIGH_RISK: "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
  // Trung tính, KHÔNG đỏ: "chưa đặt đích" và "chưa đủ dữ liệu" không phải lời chê.
  NO_TARGET: "bg-muted text-muted-foreground",
  INSUFFICIENT: "bg-muted text-muted-foreground",
};

export const RISK_HINT: Record<RiskLevel, string> = {
  GOOD: "Tỷ lệ giao thành công của mã này đạt đích công ty đang đặt cho chỉ số GTC.",
  WATCH: "Dưới đích nhưng chưa tới mức đã khai là nghiêm trọng.",
  HIGH_RISK: "Dưới ngưỡng nghiêm trọng mà chủ shop đã khai cùng lúc với đích.",
  NO_TARGET: "Chưa ai đặt đích cho chỉ số GTC ở Mục tiêu → Đích chỉ số. Màn hình hiện THỰC TẾ và không kết luận đạt/không đạt.",
  INSUFFICIENT: "Chưa đủ đơn đã kết thúc để nói gì về mã này. Đây KHÔNG phải kết luận xấu.",
};

/** Khoá chỉ số dùng để chấm mã hàng. Phải là khoá có thật trong sổ gộp (`METRIC_REGISTRY`). */
export const PRODUCT_RISK_METRIC = "delivery_success_rate";

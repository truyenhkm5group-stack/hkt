/**
 * ═══════════ SỔ KHAI THÀNH PHẦN LƯƠNG — MỘT MÁY CHUNG CHO MỌI PHÒNG BAN ═══════════
 *
 * ─── VẤN ĐỀ NÀY GIẢI ───
 *
 * Bảng lương cũ khai cơ chế trả tiền bằng ĐÚNG BỐN Ô trên hồ sơ nhân sự (`lib/constants/payroll.ts`
 * ::`Employee`): `fixed`, `percentTotal`, `percentPersonal`, `percentRevenue`. Bốn ô ấy sinh ra cho
 * MKTer và chỉ vừa với MKTer. Một nhân viên kho ăn lương theo ngày công, một thợ may ăn theo sản
 * phẩm, một bạn CSKH ăn lương cứng + KPI — không ai trong số họ khai được bằng bốn ô đó, nên cách
 * duy nhất để đỡ họ là thêm `if` vào lõi phép tính. Mỗi chức danh mới là một lần sửa lõi.
 *
 * Nên cơ chế trả tiền chuyển từ BỐN Ô CỨNG sang MỘT DANH SÁCH THÀNH PHẦN do người khai. Thêm chức
 * danh mới = khai một chính sách mới trên màn hình, KHÔNG sửa một dòng mã nào.
 *
 * ─── VÌ SAO KHÔNG PHẢI MỘT Ô GÕ CÔNG THỨC ───
 *
 * Cách nhanh nhất để "cấu hình được mọi thứ" là cho gõ một biểu thức rồi `eval`. Nó cũng là cách
 * nhanh nhất để một dòng chữ trong CSDL chạy được mã tuỳ ý trên máy chủ, và để một công thức sai
 * chính tả trở thành một kỳ lương sai mà không có kiểm thử nào bắt được. Ở đây làm ngược lại: một
 * TẬP ĐÓNG các kiểu phép tính, mỗi kiểu có tham số khai rõ, kiểm được bằng zod và kiểm thử được
 * từng cái một. Muốn thêm kiểu tính mới thì thêm vào tập này — một lần, có kiểm thử — chứ không
 * phải mở cửa cho mọi biểu thức.
 *
 * ─── BA CHIỀU KHÔNG SUY RA LẪN NHAU ───
 *
 * Cùng tinh thần `lib/constants/access-scope.ts`:
 *   · **HÌNH THỨC LÀM VIỆC** (`employment_type`: toàn thời gian · bán thời gian · cộng tác) và
 *   · **NƠI LÀM VIỆC** (`work_mode`: tại chỗ · từ xa · kết hợp) là THUỘC TÍNH LAO ĐỘNG;
 *   · **CÁCH TRẢ TIỀN** là CHÍNH SÁCH LƯƠNG.
 * Làm từ xa KHÔNG phải một công thức lương. Một người làm từ xa vẫn có thể ăn lương cứng, ăn theo
 * giờ, ăn hoa hồng hay ăn theo sản phẩm. Máy tính lương TUYỆT ĐỐI không được đọc `work_mode` hay
 * `employment_type` để đoán ra công thức — nó chỉ đọc chính sách đã gán.
 */

/** Hình thức làm việc — THUỘC TÍNH LAO ĐỘNG, không phải công thức lương. */
export const EMPLOYMENT_TYPES = ["FULL_TIME", "PART_TIME", "CONTRACTOR"] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];
export const EMPLOYMENT_TYPE_LABEL: Record<EmploymentType, string> = {
  FULL_TIME: "Toàn thời gian",
  PART_TIME: "Bán thời gian",
  CONTRACTOR: "Cộng tác viên / khoán",
};

/** Nơi làm việc — THUỘC TÍNH LAO ĐỘNG, không phải công thức lương. */
export const WORK_MODES = ["ONSITE", "REMOTE", "HYBRID"] as const;
export type WorkMode = (typeof WORK_MODES)[number];
export const WORK_MODE_LABEL: Record<WorkMode, string> = {
  ONSITE: "Tại chỗ",
  REMOTE: "Từ xa",
  HYBRID: "Kết hợp",
};

export const EMPLOYMENT_STATUSES = ["ACTIVE", "ON_LEAVE", "TERMINATED"] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];
export const EMPLOYMENT_STATUS_LABEL: Record<EmploymentStatus, string> = {
  ACTIVE: "Đang làm",
  ON_LEAVE: "Tạm nghỉ",
  TERMINATED: "Đã nghỉ",
};

/**
 * ═══ LOẠI THÀNH PHẦN — CÁI NÀY QUYẾT ĐỊNH DẤU VÀ CHỖ ĐỨNG TRONG PHIẾU LƯƠNG ═══
 *
 * Loại KHÔNG quyết định phép tính (đó là việc của `calc`). Nó quyết định hai thứ khác:
 *   · khoản này CỘNG vào thu nhập hay TRỪ đi (`PAYROLL_COMPONENT_SIGN`);
 *   · nó đứng ở nhóm nào khi in phiếu lương.
 * Tách hai thứ ấy ra là vì "thưởng KPI" và "hoa hồng" tính khác nhau nhưng cùng cộng vào thu nhập,
 * còn "tạm ứng" và "khấu trừ" tính khác nhau nhưng cùng trừ đi.
 */
export const PAYROLL_COMPONENT_KINDS = [
  "FIXED",
  "TIME_BASED",
  "KPI",
  "COMMISSION",
  "PROFIT_SHARE",
  "PIECE_RATE",
  "BONUS",
  "ALLOWANCE",
  "ADJUSTMENT",
  "ADVANCE",
  "DEDUCTION",
  "REIMBURSEMENT",
] as const;
export type PayrollComponentKind = (typeof PAYROLL_COMPONENT_KINDS)[number];

export const PAYROLL_COMPONENT_KIND_LABEL: Record<PayrollComponentKind, string> = {
  FIXED: "Lương cứng / phụ cấp cố định",
  TIME_BASED: "Theo thời gian (ngày công · giờ · ca)",
  KPI: "Thưởng KPI",
  COMMISSION: "Hoa hồng",
  PROFIT_SHARE: "Chia lợi nhuận",
  PIECE_RATE: "Khoán sản phẩm",
  BONUS: "Thưởng",
  ALLOWANCE: "Phụ cấp",
  ADJUSTMENT: "Điều chỉnh",
  ADVANCE: "Tạm ứng",
  DEDUCTION: "Khấu trừ",
  REIMBURSEMENT: "Hoàn ứng / chi hộ",
};

/** `+1` = cộng vào thu nhập · `-1` = trừ vào lương. `ADJUSTMENT` mang dấu của chính số tiền. */
export const PAYROLL_COMPONENT_SIGN: Record<PayrollComponentKind, 1 | -1> = {
  FIXED: 1,
  TIME_BASED: 1,
  KPI: 1,
  COMMISSION: 1,
  PROFIT_SHARE: 1,
  PIECE_RATE: 1,
  BONUS: 1,
  ALLOWANCE: 1,
  ADJUSTMENT: 1,
  ADVANCE: -1,
  DEDUCTION: -1,
  REIMBURSEMENT: 1,
};

/**
 * ═══════════ SỔ ĐĂNG KÝ ĐẦU VÀO — CHỈ NỐI VÀO CHỖ CÓ SỐ THẬT ═══════════
 *
 * Cùng luật với `lib/constants/metric-catalog.ts` (AGENTS.md mục 37) và
 * `lib/constants/metric-bindings.ts` (mục 20): một thành phần lương chỉ được nhân với một đại lượng
 * mà ERP THẬT SỰ đọc được, và mỗi đại lượng phải khai rõ nó đến từ đâu.
 *
 * Hai mức, và sự khác nhau giữa chúng là toàn bộ vấn đề:
 *
 *   · **`MEASURED`** — ERP tự đo được từ chứng từ đã có. Số đổi khi dữ liệu nguồn đổi, và truy
 *     nguyên được về đơn / phiếu / bảng kê.
 *   · **`MANUAL`** — ERP KHÔNG có bảng nào giữ đại lượng này (chấm công, số sản phẩm đã duyệt, %
 *     KPI…). Nó phải do NGƯỜI nhập vào `payroll_inputs`, có tên người nhập và mốc thời gian.
 *
 * Cấm tuyệt đối một cách thứ ba: viết một truy vấn GẦN ĐÚNG rồi gọi nó là số đo. Chưa đo được thì
 * khai `MANUAL` và bắt người nhập — chỗ trống nhìn thấy được tốt hơn một con số không ai kiểm lại
 * được (AGENTS.md mục 20 · 45).
 *
 * KHÔNG ĐƯỢC ĐỔI KHOÁ. `salary_policy_components.basis_key` và `payroll_inputs.input_key` đã lưu
 * chúng; đổi khoá là làm mồ côi mọi chính sách và mọi số đã nhập (cùng luật với
 * `METRIC_CATALOG`).
 */
export type PayrollInputAvailability = "MEASURED" | "MANUAL";
export type PayrollInputUnit = "VND" | "COUNT" | "DAY" | "HOUR" | "PERCENT";

export type PayrollInputSpec = {
  key: string;
  label: string;
  unit: PayrollInputUnit;
  availability: PayrollInputAvailability;
  /** Câu trả lời cho "con số này ở đâu ra" — in thẳng ra màn hình, không diễn giải lại. */
  source: string;
  /** Đại lượng này đo được ở mức TỪNG NGƯỜI không? `false` ⇒ là số của cả shop. */
  perPerson: boolean;
  /** Đường dẫn để người đọc bấm vào xem chứng từ gốc (`null` = chưa có màn hình truy nguyên). */
  drilldown: string | null;
};

export const PAYROLL_INPUTS: readonly PayrollInputSpec[] = [
  {
    key: "PROFIT_PERSONAL",
    label: "Lợi nhuận quy kết cho cá nhân",
    unit: "VND",
    availability: "MEASURED",
    source:
      "`lib/queries/payroll.ts::getMarketerReport` — doanh thu giao thành công của các mã, quy kết theo ảnh chụp người phụ trách fanpage tại mốc đơn lên, trừ quảng cáo của chính người đó, giá vốn hàng đã giao và phần chi phí vận hành phân bổ.",
    perPerson: true,
    drilldown: "/payroll?marketer=",
  },
  {
    key: "PROFIT_SHOP",
    label: "Lợi nhuận toàn shop trong kỳ",
    unit: "VND",
    availability: "MEASURED",
    source: "`lib/queries/payroll.ts::getPayrollReport` — lợi nhuận của cơ sở đang chọn, cùng con số với báo cáo lợi nhuận.",
    perPerson: false,
    drilldown: "/reports/profit",
  },
  {
    key: "REVENUE_PERSONAL",
    label: "Doanh thu giao thành công quy kết cho cá nhân",
    unit: "VND",
    availability: "MEASURED",
    source: "`lib/queries/payroll.ts::getMarketerReport` — `attributedRevenue`, chỉ đơn có `ORDER_OUTCOME = 'DELIVERED'`.",
    perPerson: true,
    drilldown: "/payroll?marketer=",
  },
  {
    key: "ORDERS_PERSONAL",
    label: "Số đơn giao thành công quy kết cho cá nhân",
    unit: "COUNT",
    availability: "MEASURED",
    source: "`lib/queries/payroll.ts::getMarketerReport` — `attributedOrders`.",
    perPerson: true,
    drilldown: "/payroll?marketer=",
  },
  {
    key: "PERIOD_DAYS",
    label: "Số ngày của đoạn tính lương",
    unit: "DAY",
    availability: "MEASURED",
    source: "Số ngày lịch Việt Nam chồng lấn giữa kỳ lương và đoạn hiệu lực của phân công (`inclusiveDays`).",
    perPerson: true,
    drilldown: null,
  },
  {
    key: "WORK_DAYS",
    label: "Ngày công được duyệt",
    unit: "DAY",
    availability: "MANUAL",
    source:
      "ERP CHƯA có bảng chấm công. Người phụ trách nhập vào `payroll_inputs` cho từng người từng kỳ, có tên người nhập và mốc thời gian. Không suy ra từ số đơn, số ca hay bất kỳ dấu vết hệ thống nào.",
    perPerson: true,
    drilldown: null,
  },
  {
    key: "WORK_HOURS",
    label: "Giờ công được duyệt",
    unit: "HOUR",
    availability: "MANUAL",
    source: "ERP CHƯA có bảng chấm công theo giờ. Nhập tay vào `payroll_inputs`, có người nhập và mốc thời gian.",
    perPerson: true,
    drilldown: null,
  },
  {
    key: "SHIFTS",
    label: "Số ca được duyệt",
    unit: "COUNT",
    availability: "MANUAL",
    source: "ERP CHƯA có bảng xếp ca. Nhập tay vào `payroll_inputs`.",
    perPerson: true,
    drilldown: null,
  },
  {
    key: "PIECES",
    label: "Số sản phẩm / đầu việc đã nghiệm thu",
    unit: "COUNT",
    availability: "MANUAL",
    source:
      "ERP CHƯA đo được sản lượng đã nghiệm thu ở mức TỪNG NGƯỜI (bảng `production_*` ghi theo lệnh sản xuất, không theo người thực hiện). Nhập tay vào `payroll_inputs`.",
    perPerson: true,
    drilldown: null,
  },
  {
    key: "KPI_PERCENT",
    label: "% hoàn thành KPI",
    unit: "PERCENT",
    availability: "MANUAL",
    source:
      "Chấm KPI là một quyết định của người quản lý, không phải một truy vấn. Nhập tay vào `payroll_inputs`; muốn nối vào một chỉ số ERP đo được thì khai ở `lib/constants/metric-registry.ts` rồi đặt đích ở `metric_targets` — KHÔNG viết một truy vấn gần đúng ở đây.",
    perPerson: true,
    drilldown: "/performance",
  },
] as const;

export const PAYROLL_INPUT_KEYS = PAYROLL_INPUTS.map((i) => i.key);
export type PayrollInputKey = (typeof PAYROLL_INPUTS)[number]["key"];

const INPUT_BY_KEY = new Map(PAYROLL_INPUTS.map((i) => [i.key, i]));
export function payrollInput(key: string): PayrollInputSpec | null {
  return INPUT_BY_KEY.get(key) ?? null;
}

/** Đại lượng phải do người nhập — màn hình dùng để biết khi nào cần mở ô nhập. */
export function isManualInput(key: string): boolean {
  return payrollInput(key)?.availability === "MANUAL";
}

/**
 * ═══ TẬP ĐÓNG CÁC KIỂU PHÉP TÍNH ═══
 *
 *  · `FIXED_AMOUNT`    — một số tiền khai sẵn (lương cứng, phụ cấp).
 *  · `PER_UNIT`        — `đại lượng × đơn giá` (giờ công × đơn giá giờ; sản phẩm × đơn giá khoán).
 *  · `RATE_OF_BASIS`   — `đại lượng × %` (hoa hồng doanh thu, chia lợi nhuận).
 *  · `TIERED_RATE`     — `%` đổi theo bậc của đại lượng (bậc nào áp cho phần vượt bậc đó).
 *  · `THRESHOLD_BONUS` — đạt ngưỡng thì được một khoản cố định, không đạt thì 0.
 *
 * Không có `EXPRESSION`, và cố ý không có. Xem khối chú thích đầu file.
 *
 * VÀ CỐ Ý KHÔNG CÓ "SỐ TIỀN NHẬP TAY TỪNG KỲ" Ở ĐÂY. Thưởng nóng, tạm ứng và khấu trừ đã có ĐÚNG
 * MỘT chỗ ở: bảng `payroll_adjustments`, nơi mỗi khoản bắt buộc mang LÝ DO, người tạo và người
 * duyệt. Thêm một đường thứ hai cho cùng loại tiền là để hai nơi cùng ghi một khoản, và rồi một
 * khoản được trả hai lần mà không bảng nào sai (AGENTS.md mục 15 — một nguồn cho một khoản chi).
 */
export const PAYROLL_CALC_TYPES = [
  "FIXED_AMOUNT",
  "PER_UNIT",
  "RATE_OF_BASIS",
  "TIERED_RATE",
  "THRESHOLD_BONUS",
] as const;
export type PayrollCalcType = (typeof PAYROLL_CALC_TYPES)[number];

export const PAYROLL_CALC_TYPE_LABEL: Record<PayrollCalcType, string> = {
  FIXED_AMOUNT: "Số tiền cố định",
  PER_UNIT: "Đại lượng × đơn giá",
  RATE_OF_BASIS: "Đại lượng × phần trăm",
  TIERED_RATE: "Phần trăm theo bậc",
  THRESHOLD_BONUS: "Đạt ngưỡng được thưởng",
};

/**
 * CÁCH CHIA THEO ĐOẠN KHI NGƯỜI VÀO / NGHỈ / ĐỔI CHÍNH SÁCH GIỮA KỲ.
 *
 *  · `PERIOD_DAYS` — chia theo số ngày của đoạn trên tổng số ngày của THÁNG chứa đoạn đó. Dùng cho
 *    khoản khai theo tháng (lương cứng, phụ cấp): vào làm ngày 15 thì nhận nửa tháng.
 *  · `NONE` — không chia. Dùng cho khoản đã tính trên chính đại lượng của đoạn (giờ công của đoạn,
 *    hoa hồng trên doanh thu của đoạn): chia thêm lần nữa là chia hai lần.
 *
 * Mặc định của `FIXED`/`ALLOWANCE` là `PERIOD_DAYS`; của mọi loại khác là `NONE`. Đây là mặc định
 * an toàn chứ không phải luật cứng — chính sách khai khác được.
 */
export const PAYROLL_PRORATE_RULES = ["PERIOD_DAYS", "NONE"] as const;
export type PayrollProrateRule = (typeof PAYROLL_PRORATE_RULES)[number];
export const PAYROLL_PRORATE_LABEL: Record<PayrollProrateRule, string> = {
  PERIOD_DAYS: "Chia theo số ngày làm việc trong tháng",
  NONE: "Không chia (đại lượng đã thuộc đoạn)",
};

/**
 * LÀM TRÒN LÀ MỘT QUYẾT ĐỊNH, KHÔNG PHẢI MỘT CHI TIẾT KỸ THUẬT.
 * Tiền VND là số nguyên (AGENTS.md mục 1), nên mặc định `ROUND` về đồng. `ROUND_1000` cho shop
 * muốn phiếu lương tròn nghìn.
 */
export const PAYROLL_ROUNDING_RULES = ["ROUND", "FLOOR", "CEIL", "ROUND_1000"] as const;
export type PayrollRoundingRule = (typeof PAYROLL_ROUNDING_RULES)[number];
export const PAYROLL_ROUNDING_LABEL: Record<PayrollRoundingRule, string> = {
  ROUND: "Làm tròn về đồng",
  FLOOR: "Làm tròn xuống đồng",
  CEIL: "Làm tròn lên đồng",
  ROUND_1000: "Làm tròn về nghìn",
};

export function applyRounding(value: number, rule: PayrollRoundingRule): number {
  switch (rule) {
    case "FLOOR":
      return Math.floor(value);
    case "CEIL":
      return Math.ceil(value);
    case "ROUND_1000":
      return Math.round(value / 1000) * 1000;
    case "ROUND":
    default:
      return Math.round(value);
  }
}

/** Một bậc: từ `from` trở lên thì phần vượt áp `ratePercent`. Bậc đầu luôn `from = 0`. */
export type PayrollTier = { from: number; ratePercent: number };

/** Tham số phép tính — tập ĐÓNG, mỗi nhánh khai đủ cái nó cần. */
export type PayrollCalcParams =
  | { type: "FIXED_AMOUNT"; amount: number }
  | { type: "PER_UNIT"; basisKey: string; unitRate: number }
  | { type: "RATE_OF_BASIS"; basisKey: string; ratePercent: number }
  | { type: "TIERED_RATE"; basisKey: string; tiers: PayrollTier[] }
  | { type: "THRESHOLD_BONUS"; basisKey: string; threshold: number; amount: number };

/** Một thành phần trong một PHIÊN BẢN chính sách. Bất biến khi phiên bản đã dùng để chốt lương. */
export type PolicyComponent = {
  /** Khoá ổn định trong phạm vi một chính sách — phiếu lương và sổ lỗ lưu khoá này. */
  code: string;
  label: string;
  kind: PayrollComponentKind;
  calc: PayrollCalcParams;
  prorate: PayrollProrateRule;
  rounding: PayrollRoundingRule;
  /** Sàn (`null` = không có). Áp SAU khi tính, TRƯỚC khi làm tròn. */
  minAmount: number | null;
  /** Trần (`null` = không có). */
  maxAmount: number | null;
  /**
   * Bù lỗ lũy kế: cơ sở tính bị trừ phần lỗ còn treo của kỳ trước, và phần âm còn lại chuyển sang
   * kỳ sau. CHỈ bật cho thành phần khai rõ — KHÔNG mặc định cho mọi chức danh (yêu cầu mục 9).
   */
  carryForward: boolean;
  sortOrder: number;
  note: string;
};

/** Mặc định an toàn cho một thành phần mới — màn hình và zod cùng dùng. */
export function defaultProrate(kind: PayrollComponentKind): PayrollProrateRule {
  return kind === "FIXED" || kind === "ALLOWANCE" ? "PERIOD_DAYS" : "NONE";
}

/**
 * Bù lỗ CHỈ có nghĩa với thành phần tính trên một đại lượng CÓ THỂ ÂM — tức lợi nhuận. Doanh thu,
 * số đơn, giờ công, sản phẩm không bao giờ âm, nên "lỗ mang sang" ở đó là một khái niệm rỗng và
 * bật nó lên chỉ tạo ra một dòng sổ không bao giờ khác 0.
 */
export function carryForwardAllowed(calc: PayrollCalcParams): boolean {
  if (calc.type !== "RATE_OF_BASIS" && calc.type !== "TIERED_RATE") return false;
  return calc.basisKey === "PROFIT_PERSONAL" || calc.basisKey === "PROFIT_SHOP";
}

/** Đại lượng mà một thành phần cần. `null` = không cần đại lượng nào (số cố định / nhập tay). */
export function componentBasisKey(calc: PayrollCalcParams): string | null {
  return calc.type === "FIXED_AMOUNT" ? null : calc.basisKey;
}

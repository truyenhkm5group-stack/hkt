import type { DepartmentCode } from "@/lib/constants/departments";

/**
 * ═══════════ SỔ ĐĂNG KÝ CHỈ SỐ — CHỖ DỄ BỊA NHẤT CỦA TOÀN BỘ HỆ OKR ═══════════
 *
 * Một Key Result là một con số có đích. Cám dỗ khi làm OKR là viết một truy vấn "gần đúng" cho mọi
 * mục tiêu ai đó nghĩ ra, rồi gọi nó là chỉ số. Sáu tháng sau không ai nhớ con số đó đo cái gì, và
 * cả công ty lái theo nó.
 *
 * Nên: **KR và ô BSC chỉ nối được vào khoá CÓ TRONG SỔ NÀY.** Mỗi khoá khai rõ ba thứ:
 *
 *  1. `resolver` — tên hàm đọc số thật. Không có hàm thì không có khoá.
 *  2. `trust`    — và đây là cột quan trọng nhất:
 *       · `MEASURED`  đọc thẳng từ truy vấn đã có contract test. Hiện số, không kèm cảnh báo.
 *       · `ESTIMATED` tính được nhưng phụ thuộc độ phủ dữ liệu. Hiện số KÈM nhãn ước tính.
 *       · `MANUAL`    ERP chưa đo được. Người nhập tay, có mốc và có tên người nhập.
 *  3. `basis`    — một câu nói con số này đến từ đâu, để người đọc kiểm chứng được.
 *
 * Yêu cầu nghiệp vụ: *"Nếu metric chưa có nguồn trustworthy thì manual KR hoặc UNKNOWN, không
 * bịa."* Sổ này là cách thực thi điều đó ở mức mã nguồn — `okr_key_results.metric_source` chỉ nhận
 * `MANUAL` hoặc một khoá ở đây, và `tests/work-os.test.ts` khoá lại.
 *
 * KHÔNG có khoá nào cho những thứ ERP thật sự chưa đo: thời gian phản hồi tin nhắn đầu tiên ở cấp
 * lead (xem `conversation_funnel` — độ phủ chưa đủ), tỷ lệ nghỉ việc, số giờ đào tạo. Chúng để
 * `MANUAL`, và như thế trung thực hơn một truy vấn nghe có vẻ đúng.
 */

export const METRIC_TRUSTS = ["MEASURED", "ESTIMATED", "MANUAL"] as const;
export type MetricTrust = (typeof METRIC_TRUSTS)[number];

export const METRIC_TRUST_LABEL: Record<MetricTrust, string> = {
  MEASURED: "Đo được",
  ESTIMATED: "Ước tính",
  MANUAL: "Nhập tay",
};

export const METRIC_TRUST_HINT: Record<MetricTrust, string> = {
  MEASURED: "Đọc thẳng từ truy vấn đã có kiểm thử hợp đồng",
  ESTIMATED: "Tính được nhưng phụ thuộc độ phủ dữ liệu — đọc kèm cảnh báo độ phủ",
  MANUAL: "ERP chưa đo được chỉ số này; người phụ trách tự nhập",
};

export const METRIC_UNITS = ["NUMBER", "VND", "PERCENT", "COUNT", "DAYS", "HOURS"] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];

export const METRIC_UNIT_LABEL: Record<MetricUnit, string> = {
  NUMBER: "Số",
  VND: "Đồng",
  PERCENT: "%",
  COUNT: "Việc",
  DAYS: "Ngày",
  HOURS: "Giờ",
};

export type MetricDirection = "UP" | "DOWN";

export type MetricBinding = {
  key: string;
  label: string;
  unit: MetricUnit;
  /** `UP` = càng cao càng tốt. `DOWN` = càng thấp càng tốt (hoàn, tồn đọng, quá hạn). */
  direction: MetricDirection;
  trust: MetricTrust;
  /** Phòng ban thường dùng chỉ số này — chỉ để GỢI Ý khi tạo KR, không giới hạn. */
  department: DepartmentCode | null;
  /** Nguồn số liệu, viết để người đọc kiểm chứng được. */
  basis: string;
  /** Dưới ngần này quan sát thì KR mang trạng thái `DATA_INSUFFICIENT`. Bỏ trống = `KR_DEFAULT_MINIMUM_SAMPLE`. */
  minimumSample?: number;
  /**
   * ĐỌC ĐƯỢC Ở MỨC MÃ HÀNG KHÔNG — quyết định chỉ số này có được đặt đích RIÊNG cho một mã hay không.
   *
   * Khai TƯỜNG MINH chứ không suy: "báo cáo có một bảng theo mã hàng" KHÔNG đủ để kết luận chỉ số
   * đọc được ở mức mã. Tiền quảng cáo chẳng hạn có bảng theo mã, nhưng con số ở đó là phần CHIA
   * theo tỷ trọng, không phải phép đo trên chính mã ấy — đặt đích cho nó là đặt đích cho một phép
   * chia. Chỉ bật cờ này cho chỉ số mà tử số VÀ mẫu số đều đếm được trên đúng tập đơn của mã.
   */
  productGrain?: boolean;
};

export const METRIC_BINDINGS: Record<string, MetricBinding> = {
  /* ───── Bán hàng & kết quả đơn ───── */
  delivery_success_rate: {
    key: "delivery_success_rate",
    label: "Tỷ lệ giao thành công (GTC)",
    unit: "PERCENT",
    direction: "UP",
    trust: "MEASURED",
    department: "LOGISTICS",
    basis: "ORDER_OUTCOME · giao thành công ÷ (giao thành công + hoàn), chỉ đơn ĐÃ kết thúc (lib/queries/metrics.ts::successRate)",
    // Bảng "Rủi ro theo mã hàng" đếm tử số và mẫu số trên ĐÚNG tập đơn của từng mã — không chia,
    // không phân bổ. Nên đích riêng cho một mã là một phát biểu có nghĩa.
    productGrain: true,
  },
  return_rate: {
    key: "return_rate",
    label: "Tỷ lệ hoàn",
    unit: "PERCENT",
    direction: "DOWN",
    trust: "MEASURED",
    department: "LOGISTICS",
    basis: "ORDER_OUTCOME · (RETURNED + RETURNED_BY_RULE) ÷ đơn đã kết thúc",
    productGrain: true,
  },
  delivered_revenue: {
    key: "delivered_revenue",
    label: "Doanh thu giao thành công",
    unit: "VND",
    direction: "UP",
    trust: "MEASURED",
    department: "SALES",
    basis: "DELIVERED_REVENUE (lib/queries/metrics.ts) — giá trị đơn ĐÃ tới tay khách, không phải số lên đơn",
  },
  delivered_orders: {
    key: "delivered_orders",
    label: "Số đơn giao thành công",
    unit: "COUNT",
    direction: "UP",
    trust: "MEASURED",
    department: "SALES",
    basis: "COUNT_DELIVERED (lib/queries/metrics.ts)",
  },
  delivered_contribution: {
    key: "delivered_contribution",
    label: "Lợi nhuận góp (doanh thu giao − giá vốn)",
    unit: "VND",
    direction: "UP",
    trust: "ESTIMATED",
    department: "MANAGEMENT",
    // Giá vốn tra "sống" theo phiếu nhập gần nhất; mẫu mã chưa có phiếu thì thiếu giá vốn.
    basis: "DELIVERED_REVENUE − DELIVERED_COGS. Ước tính vì độ phủ giá vốn chưa 100% (mẫu mã chưa có phiếu nhập)",
  },

  /* ───── Kho & hàng hoàn ───── */
  return_inspection_backlog: {
    key: "return_inspection_backlog",
    label: "Kiện hoàn chờ kiểm đếm",
    unit: "COUNT",
    direction: "DOWN",
    trust: "MEASURED",
    department: "WAREHOUSE",
    basis: "Vận đơn ĐVVC đã trả về mà chưa có phiếu tái nhập — hàng hoàn KHÔNG tự vào tồn (luật kho mục 10)",
  },

  /* ───── Tài chính ───── */
  unclassified_bank_txns: {
    key: "unclassified_bank_txns",
    label: "Dòng tiền chưa phân loại",
    unit: "COUNT",
    direction: "DOWN",
    trust: "MEASURED",
    department: "FINANCE",
    basis: "bank_transactions.accounting_group = 'UNCLASSIFIED'",
  },
  cod_outstanding: {
    key: "cod_outstanding",
    label: "COD đã giao mà tiền chưa về",
    unit: "VND",
    direction: "DOWN",
    trust: "MEASURED",
    department: "FINANCE",
    basis: "Tiền thực thu trên vận đơn đã giao nhưng cod_status chưa tới PAID_TO_BANK",
  },

  /* ───── Marketing ───── */
  ads_spend: {
    key: "ads_spend",
    label: "Chi quảng cáo",
    unit: "VND",
    direction: "DOWN",
    trust: "MEASURED",
    department: "MARKETING",
    basis: "ad_spends — tiền đã tiêu theo tài khoản quảng cáo",
  },
  profit_after_ads: {
    key: "profit_after_ads",
    label: "Lợi nhuận sau quảng cáo",
    unit: "VND",
    direction: "UP",
    trust: "ESTIMATED",
    department: "MARKETING",
    basis: "getAdsDecision — ước tính vì phụ thuộc độ phủ gán chiến dịch cho đơn (adsAttributionCoverage)",
  },

  /*
    BỐN CHỈ SỐ CỦA BÁO CÁO HIỆU QUẢ THEO NGÀY.

    Chúng ở đây chứ không ở một bảng cấu hình riêng, vì `metric_targets` là nơi DUY NHẤT được giữ
    đích đạt/không đạt (AGENTS.md mục 38 và 43). Dựng một bảng "Target CPA / Target ROAS" thứ hai
    sẽ làm đích của một KR và đích của thẻ điểm nói hai con số khác nhau về cùng một chỉ số.

    Cả bốn đều đọc CÙNG bộ máy với bảng theo ngày (`getMarketingDaily` trên mốc cohort), nên con số
    dùng để chấm đích và con số người dùng nhìn thấy trên màn hình là một.

    KHÔNG khai `productGrain` cho CPA và ROAS: tiền quảng cáo ghép về mã hàng qua `ad_spends.
    product_id` là một phép GÁN chiến dịch, không phải phép đo trên chính tập đơn của mã — đặt đích
    cho nó là đặt đích cho một phép gán.
  */
  marketing_cpa: {
    key: "marketing_cpa",
    label: "Chi phí quảng cáo cho một đơn (CPA)",
    unit: "VND",
    direction: "DOWN",
    trust: "MEASURED",
    department: "MARKETING",
    basis: "getMarketingDaily (mốc ngày phát sinh đơn) — chi quảng cáo ÷ đơn đã xác nhận, đã loại đơn trùng",
  },
  marketing_roas_delivered: {
    key: "marketing_roas_delivered",
    label: "ROAS theo doanh thu thực",
    // Sổ này không có đơn vị "lần"; ROAS là một TỶ SỐ không thứ nguyên nên đi cùng `NUMBER`.
    // Cố ý KHÔNG thêm một đơn vị mới chỉ cho một chỉ số: `performance_snapshots` đã lưu các đơn vị
    // hiện có, và mỗi đơn vị mới là một nhánh phải xử lý ở mọi nơi định dạng số.
    unit: "NUMBER",
    direction: "UP",
    trust: "MEASURED",
    department: "MARKETING",
    basis: "getMarketingDaily — DOANH THU GIAO THÀNH CÔNG ÷ chi quảng cáo. KHÔNG dùng doanh số POS: đơn hoàn cũng lên POS",
  },
  marketing_close_rate: {
    key: "marketing_close_rate",
    label: "Tỷ lệ chốt (đơn ÷ tin nhắn)",
    unit: "PERCENT",
    direction: "UP",
    trust: "ESTIMATED",
    /*
      ESTIMATED chứ không MEASURED, và lý do phải đọc được: tử số đếm theo MỐC ĐƠN còn mẫu số đếm
      theo NGÀY FACEBOOK BÁO CÁO. Khách nhắn tối nay chốt sáng mai rơi vào hai ngày khác nhau. Con
      số đúng để đọc XU HƯỚNG, không đúng để gọi là tỷ lệ chuyển đổi tuyệt đối.
    */
    department: "MARKETING",
    basis: "getMarketingDaily — đơn đã xác nhận ÷ tin nhắn quảng cáo (ad_spends.messages/leads)",
  },
  marketing_margin: {
    key: "marketing_margin",
    label: "Biên lợi nhuận góp sau quảng cáo",
    unit: "PERCENT",
    direction: "UP",
    trust: "ESTIMATED",
    department: "MARKETING",
    basis: "getMarketingDaily — (DT thực − giá vốn − cước/phí − chi QC) ÷ DT thực. Ước tính vì độ phủ giá vốn chưa 100%",
  },

  /* ───── Vận hành công việc (tự Work OS đo) ───── */
  work_overdue: {
    key: "work_overdue",
    label: "Việc quá hạn",
    unit: "COUNT",
    direction: "DOWN",
    trust: "MEASURED",
    department: null,
    basis: "Hàng đợi công việc — việc CÓ đặt hạn mà đã vỡ hạn",
  },
  work_open: {
    key: "work_open",
    label: "Việc đang mở",
    unit: "COUNT",
    direction: "DOWN",
    trust: "MEASURED",
    department: null,
    basis: "Hàng đợi công việc — việc chưa đóng ở mọi nguồn",
  },
  work_sla_on_time: {
    key: "work_sla_on_time",
    label: "Tỷ lệ việc trong hạn",
    unit: "PERCENT",
    direction: "UP",
    trust: "MEASURED",
    department: null,
    basis: "Việc CÓ ĐẶT HẠN còn trong hạn ÷ việc có đặt hạn. Việc không đặt hạn KHÔNG vào mẫu số",
  },
  work_unassigned: {
    key: "work_unassigned",
    label: "Việc chưa ai nhận",
    unit: "COUNT",
    direction: "DOWN",
    trust: "MEASURED",
    department: null,
    basis: "Hàng đợi công việc — việc đang mở mà không có người phụ trách ở cả nguồn lẫn lớp công việc",
  },
};

export const METRIC_KEYS = Object.keys(METRIC_BINDINGS);

export function isMetricKey(k: string): boolean {
  return k === "MANUAL" || Object.hasOwn(METRIC_BINDINGS, k);
}

export function metricBinding(k: string): MetricBinding | null {
  return METRIC_BINDINGS[k] ?? null;
}

/**
 * Giá trị chỉ số. `value = null` là CHƯA ĐO ĐƯỢC, không phải 0.
 *
 * `coverage` chỉ có với chỉ số `ESTIMATED`: phần dữ liệu tra được (0–1). Dưới ngưỡng thì giao diện
 * phải nói thẳng là con số đang đứng trên một mẫu nhỏ, thay vì hiện nó như một sự thật.
 */
export type MetricValue = { key: string; value: number | null; at: Date; trust: MetricTrust; coverage?: number | null; note?: string; sample?: number | null; state?: MetricState };

/**
 * ═══════════ CHƯA ĐỦ DỮ LIỆU KHÔNG PHẢI LÀ ĐANG THẤT BẠI ═══════════
 *
 *   OK                — có số, đứng trên đủ quan sát. Đọc và quyết định được.
 *   DATA_INSUFFICIENT — CÓ số nhưng mẫu dưới ngưỡng. Số vẫn hiện, KHÔNG chấm đạt/không đạt.
 *   UNKNOWN           — không có quan sát nào. `value = null`, không bao giờ là 0.
 *
 * Vì sao `DATA_INSUFFICIENT` phải là một trạng thái riêng chứ không gộp vào `UNKNOWN`: hai thứ
 * này dẫn tới hai hành động khác nhau. `UNKNOWN` là "đi lấy dữ liệu"; `DATA_INSUFFICIENT` là
 * "đợi thêm vài tuần, đường ống đang chạy đúng". Gộp lại thì cả hai đều thành "hỏng".
 *
 * Và vì sao vẫn HIỆN con số thay vì giấu: giấu đi thì người đọc tưởng chưa có gì chạy. Hiện kèm
 * cỡ mẫu để họ tự thấy "75% trên 4 quan sát" là câu chưa nói được gì.
 */
export type MetricState = "OK" | "DATA_INSUFFICIENT" | "UNKNOWN";

export const METRIC_STATE_LABEL: Record<MetricState, string> = {
  OK: "Đủ dữ liệu",
  DATA_INSUFFICIENT: "Chưa đủ dữ liệu để kết luận",
  UNKNOWN: "Chưa đo được",
};

/**
 * Cỡ mẫu tối thiểu để một KR được chấm. Mặc định lấy đúng ngưỡng của thẻ điểm hiệu suất
 * (`SAMPLE_FLOOR.medium`) — hai chỗ dùng hai ngưỡng khác nhau là hai câu trả lời cho cùng một
 * câu hỏi. Chỉ số nào cần ngưỡng riêng thì khai `minimumSample` ở chính dòng của nó.
 */
export const KR_DEFAULT_MINIMUM_SAMPLE = 20;

export function metricStateOf(input: { value: number | null; sample: number | null | undefined; minimumSample: number }): MetricState {
  if (input.value === null) return "UNKNOWN";
  // Chỉ số không đếm quan sát (tiền, số dư, số lượt) thì không có ngưỡng nào để so — đọc thẳng.
  if (input.sample === null || input.sample === undefined) return "OK";
  if (input.sample <= 0) return "UNKNOWN";
  return input.sample < input.minimumSample ? "DATA_INSUFFICIENT" : "OK";
}

/**
 * Phần trăm hoàn thành một KR. `null` khi CHƯA ĐO ĐƯỢC.
 *
 * Có `baseline` thì tính theo quãng đường đã đi (`(current − baseline) / (target − baseline)`) —
 * đúng cả với chỉ số càng-thấp-càng-tốt vì cả tử lẫn mẫu cùng đổi dấu. Không có baseline thì so
 * thẳng với đích.
 *
 * KHÔNG kẹp trên 100%: vượt đích là một sự thật đáng thấy, cắt nó đi là giấu thành tích. Kẹp dưới
 * 0% thì có: đi lùi so với xuất phát vẫn là "chưa đi được gì", và một số âm trên thanh tiến độ chỉ
 * gây hiểu nhầm.
 */
export function krProgress(input: { baseline: number | null; target: number; current: number | null; direction: MetricDirection }): number | null {
  if (input.current === null) return null;
  if (input.baseline !== null && input.target !== input.baseline) {
    return Math.max(0, ((input.current - input.baseline) / (input.target - input.baseline)) * 100);
  }
  if (input.target === 0) return input.current === 0 ? 100 : 0;
  const ratio = input.direction === "UP" ? input.current / input.target : input.target / input.current;
  return Number.isFinite(ratio) ? Math.max(0, ratio * 100) : null;
}

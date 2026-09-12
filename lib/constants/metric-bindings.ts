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
  },
  return_rate: {
    key: "return_rate",
    label: "Tỷ lệ hoàn",
    unit: "PERCENT",
    direction: "DOWN",
    trust: "MEASURED",
    department: "LOGISTICS",
    basis: "ORDER_OUTCOME · (RETURNED + RETURNED_BY_RULE) ÷ đơn đã kết thúc",
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
export type MetricValue = { key: string; value: number | null; at: Date; trust: MetricTrust; coverage?: number | null; note?: string };

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

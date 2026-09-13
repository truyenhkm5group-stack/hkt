import type { DepartmentCode } from "@/lib/constants/departments";
import { METRIC_BINDINGS, type MetricUnit as BindingUnit } from "@/lib/constants/metric-bindings";
import { METRIC_CATALOG, type MetricSpec } from "@/lib/constants/metric-catalog";

/**
 * ═══════════ MỘT KHÔNG GIAN KHOÁ CHO ĐÍCH, DẪN XUẤT TỪ HAI SỔ ĐÃ CÓ ═══════════
 *
 * ─── VẤN ĐỀ ───
 *
 * Kho mã này có HAI sổ chỉ số, mỗi sổ đúng cho việc của nó:
 *
 *   · `METRIC_CATALOG`  (14 khoá) — chỉ số HIỆU SUẤT mức người / phòng. Có `metric_targets`.
 *   · `METRIC_BINDINGS` (14 khoá) — chỉ số KINH DOANH mức công ty, thứ KR và ô BSC nối vào.
 *
 * Nhưng bảng `metric_targets` chỉ nhận khoá của sổ THỨ NHẤT. Hệ quả đo được ở mã nguồn:
 *
 *   · KR không có đường nào tới một đích có thẩm quyền. `okr_key_results` tự giữ `target`,
 *     `unit`, `direction` của riêng nó — ba cột lặp lại đúng thứ `METRIC_BINDINGS` đã khai, và
 *     AGENTS.md mục 23 đã cấm ghi cứng chiều/đơn vị ở ô BSC vì lý do y hệt.
 *   · Đích đặt cho "tỷ lệ hoàn" ở màn hình mục tiêu và đích đặt cho "tỷ lệ hoàn" ở thẻ điểm là
 *     hai con số khác nhau, không ai buộc chúng bằng nhau.
 *
 * ─── CÁCH SỬA: DẪN XUẤT, KHÔNG KHAI LẠI ───
 *
 * Tệp này KHÔNG khai thêm một chỉ số nào. Nó đọc hai sổ đang có và dựng một khung nhìn chung để
 * `metric_targets` nhận được khoá của cả hai — đúng cách `DEPT_METRIC_KEYS` và `DEPT_LINKAGE`
 * được dẫn xuất từ sổ chỉ số (AGENTS.md mục 37). Thêm chỉ số vẫn chỉ làm ở hai sổ gốc.
 *
 * Hai không gian khoá hiện KHÔNG giao nhau (14 + 14 = 28). Đó là điều kiện để gộp được, nên nó
 * được KIỂM THỬ chứ không phải được hy vọng: một khoá trùng sẽ làm đích của chỉ số này âm thầm áp
 * cho chỉ số kia.
 */

export type MetricOrigin = "CATALOG" | "BINDING";

/** Chiều dùng chung. Hai sổ viết hai kiểu (`HIGHER_BETTER`/`LOWER_BETTER` và `UP`/`DOWN`) — quy về một. */
export type TargetDirection = "HIGHER_BETTER" | "LOWER_BETTER" | "RANGE" | "CONTEXT";

export type TargetableMetric = {
  key: string;
  label: string;
  unit: BindingUnit;
  direction: TargetDirection;
  origin: MetricOrigin;
  department: DepartmentCode | null;
  /** Câu nói con số này đến từ đâu — để người đặt đích biết mình đang đặt đích cho cái gì. */
  basis: string;
  /** Đo được ở mức NGƯỜI không? Quyết định việc có cho đặt đích cho một cá nhân hay không. */
  personGrain: boolean;
  /** Kết quả do bên ngoài đồng quyết định (ĐVVC giao được hay không, hàng hỏng trên đường về). */
  shared: boolean;
  /** Chưa có nguồn thật ⇒ KHÔNG nối được vào đích, y như không nối được vào KR. */
  targetable: boolean;
  /** `targetable = false` ⇒ thiếu ĐÚNG cái gì. */
  missingWhat?: string;
};

const CATALOG_UNIT: Record<MetricSpec["unit"], BindingUnit> = { PERCENT: "PERCENT", COUNT: "COUNT", VND: "VND", HOURS: "HOURS", DAYS: "DAYS" };
const CATALOG_DIRECTION: Record<MetricSpec["direction"], TargetDirection> = { HIGHER_BETTER: "HIGHER_BETTER", LOWER_BETTER: "LOWER_BETTER", CONTEXT: "CONTEXT" };

const fromCatalog = (m: MetricSpec): TargetableMetric => ({
  key: m.key,
  label: m.label,
  unit: CATALOG_UNIT[m.unit],
  direction: CATALOG_DIRECTION[m.direction],
  origin: "CATALOG",
  department: m.department,
  basis: m.source,
  personGrain: m.grain === "PERSON",
  shared: m.shared,
  targetable: m.availability === "MEASURED" && m.direction !== "CONTEXT",
  missingWhat: m.availability === "UNAVAILABLE" ? m.missingWhat : m.direction === "CONTEXT" ? "Chỉ số đọc bối cảnh, không có chiều tốt/xấu nên không đặt đích được" : undefined,
});

const fromBinding = (key: string): TargetableMetric => {
  const b = METRIC_BINDINGS[key];
  return {
    key: b.key,
    label: b.label,
    unit: b.unit,
    direction: b.direction === "UP" ? "HIGHER_BETTER" : "LOWER_BETTER",
    origin: "BINDING",
    department: b.department,
    basis: b.basis,
    // Chỉ số kinh doanh đo ở mức CÔNG TY / PHÒNG. Không cái nào đọc được ở mức một con người,
    // nên không cái nào được phép trở thành đích chấm một cá nhân.
    personGrain: false,
    shared: false,
    // `MANUAL` = ERP chưa đo được. Đặt đích cho nó là đặt đích cho một con số người tự gõ.
    targetable: b.trust !== "MANUAL",
    missingWhat: b.trust === "MANUAL" ? "ERP chưa đo được chỉ số này — người phụ trách tự nhập, nên không có gì để chấm tự động" : undefined,
  };
};

/** TOÀN BỘ khoá đặt đích được, dẫn xuất từ hai sổ. Không khai thêm ở đây. */
export const TARGETABLE_METRICS: Record<string, TargetableMetric> = Object.fromEntries([
  ...METRIC_CATALOG.map((m) => [m.key, fromCatalog(m)] as const),
  ...Object.keys(METRIC_BINDINGS).map((k) => [k, fromBinding(k)] as const),
]);

export const TARGETABLE_KEYS = Object.keys(TARGETABLE_METRICS);

export function metricOf(key: string): TargetableMetric | null {
  return TARGETABLE_METRICS[key] ?? null;
}

/**
 * ═══ PHẠM VI CỦA MỘT ĐÍCH ═══
 *
 * `PRODUCT` CỐ Ý KHÔNG CÓ. Không sổ nào đang khai một chỉ số đọc được ở mức mã hàng, nên thêm
 * phạm vi đó là mở một ô cho một thứ chưa có nguồn — đúng điều AGENTS.md mục 37 cấm. Khi nào có
 * chỉ số mức mã hàng thật thì thêm cả hai cùng lúc.
 */
export const TARGET_SCOPES = ["COMPANY", "DEPARTMENT", "POSITION", "USER"] as const;
export type TargetScope = (typeof TARGET_SCOPES)[number];

export const TARGET_SCOPE_LABEL: Record<TargetScope, string> = {
  COMPANY: "Toàn công ty",
  DEPARTMENT: "Phòng ban",
  POSITION: "Chức danh",
  USER: "Cá nhân",
};

/** Tầng HẸP hơn thắng. Không cộng, không trung bình — hai đích chồng nhau thì cái RIÊNG hơn là cái đúng. */
export const TARGET_PRECEDENCE: Record<TargetScope, number> = { COMPANY: 1, DEPARTMENT: 2, POSITION: 3, USER: 4 };

/**
 * ĐƯỢC PHÉP ĐẶT ĐÍCH CHO MỘT CON NGƯỜI CỤ THỂ KHÔNG?
 *
 * Ba điều kiện, và cả ba đều là luật đã có chứ không phải ý mới:
 *
 *  1. Chỉ số phải đọc được ở mức NGƯỜI. Chỉ số mức công ty gắn tên một người là chấm người đó
 *     bằng kết quả của cả shop.
 *  2. Chỉ số KHÔNG được mang cờ `shared`. AGENTS.md mục 24 và 27: thứ bên ngoài đồng quyết định
 *     (ĐVVC giao được hay không) đọc làm bối cảnh, không phải điểm chấm người.
 *  3. Chỉ số phải thật sự đo được.
 */
export function canTargetPerson(key: string): { ok: boolean; reason?: string } {
  const m = metricOf(key);
  if (!m) return { ok: false, reason: "Chỉ số không có trong sổ" };
  if (!m.targetable) return { ok: false, reason: m.missingWhat ?? "Chỉ số chưa đo được" };
  if (!m.personGrain) return { ok: false, reason: `"${m.label}" đo ở mức công ty / phòng, không đọc được ở mức một người` };
  if (m.shared) return { ok: false, reason: `"${m.label}" là KẾT QUẢ CHUNG — phần lớn do bên ngoài quyết định, nên đọc làm bối cảnh chứ không đặt đích cho một cá nhân` };
  return { ok: true };
}

/** Phạm vi nào hợp lệ cho một chỉ số. Dùng chung cho lược đồ đầu vào VÀ lúc dựng ô chọn. */
export function scopesFor(key: string): TargetScope[] {
  const m = metricOf(key);
  if (!m?.targetable) return [];
  const base: TargetScope[] = ["COMPANY", "DEPARTMENT", "POSITION"];
  return canTargetPerson(key).ok ? [...base, "USER"] : base;
}

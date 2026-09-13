/**
 * ═══════════ DANH MỤC CHỈ SỐ CÓ THẨM QUYỀN — MỘT SỔ, KHÔNG PHẢI NHIỀU BẢN ═══════════
 *
 * Trước tệp này, một chỉ số hiệu suất được mô tả ở ba nơi: câu SQL tính nó, bảng chú giải cho
 * người đọc (`DEPT_PERF`), và danh mục khoá cho ảnh chụp (`DEPT_METRIC_KEYS`). Ba nơi thì tới
 * ngày chúng nói khác nhau — và cái sai sẽ là cái nói rằng có số, trong khi thật ra không có.
 *
 * Sổ này là bản khai duy nhất. Mỗi chỉ số phải trả lời đủ mười hai câu trước khi được dùng để
 * nói bất cứ điều gì về một con người:
 *
 *   key · department · definition · grain · numerator · denominator
 *   source · attributionRule · confidenceRule · minimumSample · direction · unit
 *
 * ─── `UNAVAILABLE` LÀ MỘT MỤC HỢP LỆ, KHÔNG PHẢI MỘT CHỖ TRỐNG ───
 *
 * Chỉ số chủ shop MUỐN có nhưng dữ liệu chưa cho phép vẫn được khai, kèm lý do chính xác thiếu
 * cái gì. Bỏ chúng ra ngoài thì màn hình trông đầy đủ và không ai biết còn thiếu gì; bịa một
 * nguồn thay thế thì tệ hơn nữa.
 *
 * ─── KHÔNG THÊM CHỈ SỐ KHÔNG CÓ NGUỒN THẬT ───
 *
 * `source` phải trỏ tới bảng/cột có thật. Một chỉ số khai nguồn là "sẽ có sau" là một lời hứa,
 * và lời hứa không đo được ai cả.
 */
import type { DepartmentCode } from "@/lib/constants/departments";
import type { PersonLinkage } from "@/lib/constants/metric-provenance";

export type MetricDirection = "HIGHER_BETTER" | "LOWER_BETTER" | "CONTEXT";
export type MetricUnit = "PERCENT" | "COUNT" | "VND" | "HOURS" | "DAYS";
export type MetricGrain = "PERSON" | "DEPARTMENT";

export type MetricSpec = {
  /**
   * KHOÁ LÀ THỨ ĐÃ NẰM TRONG CSDL — KHÔNG ĐỔI ĐỂ CHO ĐẸP.
   *
   * `performance_snapshots.metric_key` đã lưu những khoá này trên production. Đổi khoá là làm mồ
   * côi toàn bộ ảnh chụp cũ: bảng xu hướng sẽ thấy một chỉ số mới bắt đầu từ hôm nay và một chỉ số
   * cũ dừng lại, thay vì một đường liền. Nên sổ này NHẬN khoá đang chạy, không áp một cách đặt tên
   * mới lên nó.
   */
  key: string;
  department: DepartmentCode;
  label: string;
  /** Một câu: chỉ số này nói lên điều gì về công việc. */
  definition: string;
  grain: MetricGrain;
  /** Tử số đếm cái gì. `null` khi chỉ số là một con số tuyệt đối (tiền, số lượt). */
  numerator: string | null;
  /** Mẫu số đếm cái gì — phải nói rõ "bao nhiêu CÁI GÌ", không chỉ "bao nhiêu". */
  denominator: string;
  /** Bảng / cột có thật mà chỉ số này đọc. */
  source: string;
  /** Cách nối một dòng dữ liệu về một con người. Quyết định trần độ tin cậy. */
  linkage: PersonLinkage;
  /** Một câu: phần nào của con số này KHÔNG do người đó quyết được. */
  attributionRule: string;
  /** Kết quả do bên ngoài đồng quyết định ⇒ đọc làm bối cảnh, không phải điểm chấm người. */
  shared: boolean;
  /** Dưới ngần này quan sát thì không xếp hạng và không tô màu. */
  minimumSample: number;
  direction: MetricDirection;
  unit: MetricUnit;
  availability: "MEASURED" | "UNAVAILABLE";
  /** `UNAVAILABLE` ⇒ thiếu ĐÚNG cái gì. Bắt buộc, và phải cụ thể tới mức sửa được. */
  missingWhat?: string;
};

const SALES: MetricSpec[] = [
  {
    key: "sales_followup_sla",
    department: "SALES",
    label: "Trả lời / đóng case trong hạn",
    definition: "Người bán phản hồi và đưa case tới kết luận trong hạn đã đặt.",
    grain: "PERSON",
    numerator: "case đóng trong hạn",
    denominator: "case CSKH CÓ ĐẶT HẠN mà người này đã đóng trong kỳ",
    source: "cs_cases (resolved_at, assignee_user_id) + hạn từ lib/constants/action-queue.ts::CASE_SLA_HOURS",
    linkage: "USER_ID",
    attributionRule: "Chỉ tính case người này đóng. Đơn hoàn do bưu tá giao hỏng KHÔNG tính vào đây.",
    shared: false,
    minimumSample: 20,
    direction: "HIGHER_BETTER",
    unit: "PERCENT",
    availability: "MEASURED",
  },
  {
    key: "sales_conversion",
    department: "SALES",
    label: "Hội thoại ra đơn",
    definition: "Tỷ lệ case có mã hội thoại dẫn tới một đơn hàng.",
    grain: "PERSON",
    numerator: "case có đơn sinh ra từ hội thoại",
    denominator: "case có mã hội thoại (case không có mã thì không nối được, rơi khỏi cả tử lẫn mẫu)",
    source: "cs_cases.conversation_id → orders.conversation_id",
    linkage: "USER_ID",
    attributionRule: "Không tính đơn đến từ kênh khác; chỉ đơn lần ra được từ hội thoại của chính case này.",
    shared: false,
    minimumSample: 20,
    direction: "HIGHER_BETTER",
    unit: "PERCENT",
    availability: "MEASURED",
  },
  {
    key: "sales_delivered_quality",
    department: "SALES",
    label: "Đơn từ case này giao thành công",
    definition: "Chất lượng đơn chốt ra: bao nhiêu phần trăm đi tới nơi.",
    grain: "PERSON",
    numerator: "đơn có kết quả DELIVERED",
    denominator: "đơn sinh từ hội thoại của case, chỉ tính đơn ĐÃ kết thúc",
    source: "ORDER_OUTCOME (lib/queries/return-rate.ts)",
    linkage: "USER_ID",
    attributionRule: "KẾT QUẢ CHUNG: người chốt không quyết được bưu tá có giao được hay không. Đọc làm bối cảnh.",
    shared: true,
    minimumSample: 20,
    direction: "HIGHER_BETTER",
    unit: "PERCENT",
    availability: "MEASURED",
  },
  {
    key: "sales_contribution",
    department: "SALES",
    label: "Doanh thu giao thành công từ case",
    definition: "Tiền thật về từ những đơn sinh ra từ case người này đóng.",
    grain: "PERSON",
    numerator: null,
    denominator: "đơn giao thành công sinh từ case người này đóng",
    source: "orders.total_price_after_discount lọc theo ORDER_OUTCOME = DELIVERED",
    linkage: "USER_ID",
    attributionRule: "Giá trị đơn phụ thuộc mặt hàng khách chọn, không phụ thuộc người xử lý. Là ĐÓNG GÓP, không phải điểm.",
    shared: true,
    minimumSample: 1,
    direction: "CONTEXT",
    unit: "VND",
    availability: "MEASURED",
  },
];

const LOGISTICS: MetricSpec[] = [
  {
    key: "care_sla",
    department: "LOGISTICS",
    label: "Đóng ca care trong hạn",
    definition: "Tốc độ xử lý một ca chăm sóc kiện hàng.",
    grain: "PERSON",
    numerator: "ca đóng trong hạn (hạn chụp tại thời điểm ca vào hàng đợi)",
    denominator: "ca care người này đã đóng trong kỳ",
    source: "care_case_events (actor_id, ảnh chụp SLA từng sự kiện)",
    linkage: "USER_ID",
    attributionRule: "Chỉ đo việc HỌ LÀM: gọi kịp, ghi nhận, gửi yêu cầu. KHÔNG tính kết quả chuyến giao.",
    shared: false,
    minimumSample: 20,
    direction: "HIGHER_BETTER",
    unit: "PERCENT",
    availability: "MEASURED",
  },
  {
    key: "care_recovered",
    department: "LOGISTICS",
    label: "Kiện cứu được sau khi care",
    definition: "Kiện đi tới nơi sau khi có người chăm.",
    grain: "PERSON",
    numerator: "kiện có kết quả DELIVERED",
    denominator: "kiện có ca care do người này đóng, chỉ kiện ĐÃ kết thúc",
    source: "shipment_care.owner_id + ORDER_OUTCOME",
    linkage: "USER_ID",
    attributionRule: "KẾT QUẢ CHUNG: kết quả cuối do ĐVVC quyết và tới sau khi ca đã đóng. Bối cảnh, không phải điểm.",
    shared: true,
    minimumSample: 20,
    direction: "HIGHER_BETTER",
    unit: "PERCENT",
    availability: "MEASURED",
  },
  {
    key: "care_cod_recovered",
    department: "LOGISTICS",
    label: "Tiền COD giữ lại được",
    definition: "Tiền thực thu từ kiện giao thành công sau khi được chăm.",
    grain: "PERSON",
    numerator: null,
    denominator: "kiện giao thành công sau khi người này đóng ca",
    source: "shipments.cod_collected lọc theo ORDER_OUTCOME = DELIVERED",
    linkage: "USER_ID",
    attributionRule: "Số tiền phụ thuộc giá trị đơn, không phụ thuộc người xử lý. Là ĐÓNG GÓP, không phải điểm.",
    shared: true,
    minimumSample: 1,
    direction: "CONTEXT",
    unit: "VND",
    availability: "MEASURED",
  },
];

const WAREHOUSE: MetricSpec[] = [
  {
    key: "inspection_sla",
    department: "WAREHOUSE",
    label: "Kiểm đếm hàng hoàn trong hạn",
    definition: "Kiện hoàn về được kiểm đếm nhanh, để hàng quay lại bán được sớm.",
    grain: "PERSON",
    numerator: "lượt kiểm xong trong hạn kể từ khi ghi nhận đã về",
    denominator: "lượt kiểm hàng hoàn người này thực hiện trong kỳ",
    source: "return_inspections (received_by, inspected_by)",
    linkage: "USER_ID",
    attributionRule: "Chỉ tính lượt kiểm của chính người này. Hàng về chậm do ĐVVC không tính vào đây.",
    shared: false,
    minimumSample: 20,
    direction: "HIGHER_BETTER",
    unit: "PERCENT",
    availability: "MEASURED",
  },
  {
    key: "inspection_discrepancy",
    department: "WAREHOUSE",
    label: "Tỷ lệ kiện có lệch",
    definition: "Kiện kiểm ra hàng hỏng hoặc không bán lại được.",
    grain: "PERSON",
    numerator: "món không bán lại được",
    denominator: "món hàng hoàn người này đã kiểm trong kỳ",
    source: "return_inspection_items",
    linkage: "USER_ID",
    attributionRule: "KẾT QUẢ CHUNG: hàng hỏng trên đường về không do người kiểm gây ra. Đọc để biết chất lượng hàng về.",
    shared: true,
    minimumSample: 20,
    direction: "LOWER_BETTER",
    unit: "PERCENT",
    availability: "MEASURED",
  },
  {
    key: "inventory_accuracy",
    department: "WAREHOUSE",
    label: "Độ chính xác tồn kho",
    definition: "Tồn sổ khớp tồn thực đếm được.",
    grain: "DEPARTMENT",
    numerator: "mẫu mã khớp giữa sổ và kiểm kê",
    denominator: "mẫu mã được kiểm kê trong kỳ",
    source: "—",
    linkage: "USER_ID",
    attributionRule: "Mức SỔ, không quy về cá nhân: một mẫu mã đi qua tay nhiều người.",
    shared: false,
    minimumSample: 20,
    direction: "HIGHER_BETTER",
    unit: "PERCENT",
    availability: "UNAVAILABLE",
    missingWhat:
      "Chưa có nghiệp vụ KIỂM KÊ định kỳ trong ERP. `stock_receipts` ghi phiếu nhập/xuất, không ghi lượt đếm đối chiếu. Muốn đo thì phải có phiếu kiểm kê ghi số đếm thực tế cạnh số sổ tại cùng một thời điểm.",
  },
];

const FINANCE: MetricSpec[] = [
  {
    key: "reconciliation_completeness",
    department: "FINANCE",
    label: "Độ đầy đủ đối soát",
    definition: "Phần dòng sao kê đã được phân loại / nối chứng từ.",
    grain: "DEPARTMENT",
    numerator: "dòng đã phân loại",
    denominator: "dòng sao kê trong kỳ",
    source: "bank_transactions",
    linkage: "USER_ID",
    attributionRule: "Mức SỔ: một dòng tiền có thể do nhiều người chạm, nên không quy về cá nhân.",
    shared: false,
    minimumSample: 20,
    direction: "HIGHER_BETTER",
    unit: "PERCENT",
    availability: "MEASURED",
  },
  {
    key: "unresolved_aging",
    department: "FINANCE",
    label: "Dòng tiền treo lâu nhất",
    definition: "Tuổi của dòng tiền chưa phân loại cũ nhất.",
    grain: "DEPARTMENT",
    numerator: null,
    denominator: "dòng sao kê chưa phân loại còn treo",
    source: "bank_transactions (occurred_at của dòng chưa phân loại)",
    linkage: "USER_ID",
    attributionRule: "Mức SỔ. `null` = không còn dòng nào treo, KHÔNG phải 0 ngày.",
    shared: false,
    minimumSample: 1,
    direction: "LOWER_BETTER",
    unit: "DAYS",
    availability: "MEASURED",
  },
  {
    key: "finance_actions",
    department: "FINANCE",
    label: "Lượt phân loại / nối chứng từ",
    definition: "Khối lượng thao tác đối soát của một người.",
    grain: "PERSON",
    numerator: null,
    denominator: "lượt phân loại / nối chứng từ ghi trong nhật ký hệ thống",
    source: "audit_logs (BANK_CLASSIFY, BANK_LINK, user_id)",
    linkage: "USER_ID",
    attributionRule: "Là SỐ LƯỢT, không phải điểm chất lượng. Nhiều lượt không có nghĩa làm tốt hơn.",
    shared: false,
    minimumSample: 1,
    direction: "CONTEXT",
    unit: "COUNT",
    availability: "MEASURED",
  },
];

const MARKETING: MetricSpec[] = [
  {
    key: "marketing_contribution_after_ads",
    department: "MARKETING",
    label: "Đóng góp sau chi phí quảng cáo",
    definition: "Lợi nhuận còn lại sau khi trừ chi quảng cáo, quy về người phụ trách.",
    grain: "PERSON",
    numerator: null,
    denominator: "đơn giao thành công quy được về marketer trong kỳ",
    source: "—",
    linkage: "FREE_TEXT",
    attributionRule: "Kết quả giao hàng KHÔNG thuộc phạm vi marketing; chỉ đo phần chi tiêu và doanh thu quy được.",
    shared: true,
    minimumSample: 20,
    direction: "HIGHER_BETTER",
    unit: "VND",
    availability: "UNAVAILABLE",
    missingWhat:
      "`ad_spends.marketer_id` trỏ tới nhân sự khai trong bảng LƯƠNG, không phải tài khoản ERP — hai sổ danh tính khác nhau. Và `orders` không có cột 'ai chạy quảng cáo ra đơn này'; ghép qua fanpage chỉ đúng khi mỗi fanpage có đúng một marketer. Muốn đo ở độ mịn NGƯỜI thì cần nối `ad_spends.marketer_id` về `users.id` và một đường quy đơn về chiến dịch.",
  },
];

export const METRIC_CATALOG: MetricSpec[] = [...SALES, ...LOGISTICS, ...WAREHOUSE, ...FINANCE, ...MARKETING];

export const METRIC_BY_KEY: Record<string, MetricSpec> = Object.fromEntries(METRIC_CATALOG.map((m) => [m.key, m]));

/** Chỉ số ĐO ĐƯỢC của một phòng. Dùng cho ảnh chụp và cho màn hiệu suất. */
export function metricsOf(department: DepartmentCode, grain?: MetricGrain): MetricSpec[] {
  return METRIC_CATALOG.filter((m) => m.department === department && m.availability === "MEASURED" && (!grain || m.grain === grain));
}

/** Chỉ số chủ shop muốn mà chưa đo được — kèm lý do, để đây là danh sách VIỆC chứ không phải chỗ trống. */
export function unavailableOf(department: DepartmentCode): MetricSpec[] {
  return METRIC_CATALOG.filter((m) => m.department === department && m.availability === "UNAVAILABLE");
}

/** KR / KPI chỉ được nối vào chỉ số CÓ TRONG SỔ và ĐO ĐƯỢC. Không có tên gõ tay nào là "tự động". */
export function isBindableMetric(key: string): boolean {
  return METRIC_BY_KEY[key]?.availability === "MEASURED";
}

/**
 * ═══════════ PHIÊN BẢN NGUỒN ═══════════
 *
 * Tăng khi một chỉ số bắt đầu ĐỌC CHỖ KHÁC — không phải khi công thức đổi (cái đó là
 * `METRIC_DEFINITION_VERSION`). Ví dụ đúng: case CSKH chuyển từ nối bằng ô chữ `assignee` sang
 * nối bằng khoá `assignee_user_id`.
 *
 * Vì sao phải tách: cùng một công thức, cùng một người, nhưng hai nguồn cho HAI TẬP DÒNG khác
 * nhau. Kỳ trước gom cả case gõ tên gần đúng, kỳ này chỉ gom case nối bằng khoá — số tụt xuống
 * không phải vì người đó làm kém đi. Màn hình xu hướng đọc hai cột này để in "đổi nguồn giữa hai
 * kỳ" thay vì vẽ một mũi tên đi xuống.
 *
 * v2 (13/09/2026): thêm `assignee_user_id` · `created_by_user_id` · `received_by_user_id` ·
 * `inspected_by_user_id` · `previous_owner_id` / `next_owner_id`.
 */
export const METRIC_SOURCE_VERSION = 2;

/**
 * CÁCH NỐI NGƯỜI THẬT SỰ ĐANG DÙNG, đo từ chính dữ liệu của kỳ — không phải từ bản khai.
 *
 * Bản khai trong sổ nói nguồn HỖ TRỢ cái gì; hàm này nói kỳ này THỰC TẾ nối được bằng gì. Hai
 * thứ lệch nhau suốt giai đoạn chuyển tiếp: cột khoá đã có, nhưng dòng cũ vẫn rỗng.
 *
 * Còn MỘT dòng chưa nối được bằng khoá thì cả con số tụt về `FREE_TEXT`. Không lấy tỷ lệ phần
 * trăm làm "gần đúng": một con số trộn 90% khoá với 10% tên gõ tay vẫn có thể quy nhầm cho người
 * khác, và nhầm một dòng là đủ để kết luận sai về một con người.
 */
export function observedLinkage(input: { total: number; withUserId: number }): PersonLinkage {
  if (input.total <= 0) return "FREE_TEXT";
  return input.withUserId >= input.total ? "USER_ID" : "FREE_TEXT";
}

/** Chủ thể chưa nối được về tài khoản nào. KHÔNG bỏ khỏi báo cáo — bỏ đi là giấu phần chưa quy kết được. */
export const UNASSIGNED_SUBJECT_ID = "__UNASSIGNED__";
export const UNASSIGNED_SUBJECT_LABEL = "Chưa ai nhận";

/**
 * ═══════════ MỨC ĐỘ DÙNG ĐƯỢC CỦA MỘT CHỈ SỐ ═══════════
 *
 *   TRUSTED     — có nguồn, nối bằng khoá, đủ mẫu. Dùng để nói về một con người.
 *   WEAK        — có số nhưng nối bằng tên gõ tay hoặc mẫu quá bé. Đọc làm bối cảnh.
 *   UNKNOWN     — có nguồn nhưng kỳ này KHÔNG có quan sát nào. Không phải 0, không phải "kém".
 *   UNAVAILABLE — chưa có nguồn để đo. Là VIỆC PHẢI LÀM, không phải một ô trống.
 */
export type MetricTrust = "TRUSTED" | "WEAK" | "UNKNOWN" | "UNAVAILABLE";

export const TRUST_LABEL: Record<MetricTrust, string> = {
  TRUSTED: "Dùng được",
  WEAK: "Yếu — đọc làm bối cảnh",
  UNKNOWN: "Chưa đo được kỳ này",
  UNAVAILABLE: "Chưa có nguồn",
};

export function metricTrust(input: { spec: MetricSpec; value: number | null; sample: number; linkage: PersonLinkage }): MetricTrust {
  if (input.spec.availability === "UNAVAILABLE") return "UNAVAILABLE";
  if (input.value === null || input.sample <= 0) return "UNKNOWN";
  if (input.linkage === "FREE_TEXT") return "WEAK";
  if (input.sample < input.spec.minimumSample) return "WEAK";
  return "TRUSTED";
}

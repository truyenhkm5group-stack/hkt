import type { DepartmentCode } from "@/lib/constants/departments";

/**
 * ═══════════ SỔ LỖ HỔNG DỮ LIỆU — MỖI DÒNG PHẢI DẪN TỚI MỘT VIỆC LÀM ĐƯỢC ═══════════
 *
 * ─── VÌ SAO CẦN MỘT SỔ, KHÔNG PHẢI MỘT MÀN HÌNH ĐẸP ───
 *
 * Một bảng "chất lượng dữ liệu" chỉ in ra con số là một bảng không ai mở lần thứ hai. Người đọc
 * thấy "412 đơn thiếu giá vốn" rồi không biết làm gì với nó: ai sửa, sửa ở đâu, sửa xong thì con
 * số này về bao nhiêu mới là đủ.
 *
 * Nên mỗi lỗ hổng ở đây BẮT BUỘC khai đủ: đếm được gì · nặng tới đâu · nguồn nào sinh ra nó ·
 * lần gần nhất là khi nào · vài dòng ví dụ · và VIỆC PHẢI LÀM, viết ở dạng người kho / người kế
 * toán đọc xong là đứng dậy làm được.
 *
 * ─── PHÂN LOẠI CHỖ TRỐNG (đây mới là phần quan trọng) ───
 *
 * Không phải mọi `UNKNOWN` đều là một lỗi. Gộp chúng lại rồi đi "giảm số UNKNOWN" là cách chắc
 * chắn nhất để ai đó lấp chỗ trống bằng một phép đoán và biến một lỗ hổng thành một lời khẳng
 * định sai. Bốn loại, và chỉ HAI loại là việc phải làm:
 *
 *   TRUE_UNKNOWN — KHÔNG có chứng cứ nào tồn tại. Giữ nguyên. Đây là câu trả lời ĐÚNG, và mọi
 *                  nỗ lực "sửa" nó đều là bịa. Ví dụ: 78% vận đơn hoàn không có chứng từ nào nêu
 *                  lý do — ĐVVC chỉ báo kiện đã chuyển hoàn, không ai hỏi khách.
 *   RESOLVABLE   — dữ liệu ĐÃ CÓ trong kho nhưng chưa ai nối vào. SỬA ĐƯỢC bằng mã nguồn.
 *   STALE        — dữ liệu có, đường ống chưa chạy lại. SỬA ĐƯỢC bằng cách chạy job.
 *   AMBIGUOUS    — có NHIỀU ứng viên và không căn cứ nào chọn được. Giữ nguyên trạng thái mơ hồ
 *                  và đưa cho NGƯỜI quyết. Máy chọn bừa một cái trông y hệt như máy biết.
 *
 * `fixable` được suy ra từ loại, không khai tay: chỉ `RESOLVABLE` và `STALE` sửa được.
 */

export const UNKNOWN_KINDS = ["TRUE_UNKNOWN", "RESOLVABLE", "STALE", "AMBIGUOUS"] as const;
export type UnknownKind = (typeof UNKNOWN_KINDS)[number];

export const UNKNOWN_KIND_LABEL: Record<UnknownKind, string> = {
  TRUE_UNKNOWN: "Không có chứng cứ — giữ nguyên",
  RESOLVABLE: "Dữ liệu đã có, chưa nối",
  STALE: "Đường ống chưa chạy lại",
  AMBIGUOUS: "Nhiều ứng viên — người quyết",
};

export const UNKNOWN_KIND_HINT: Record<UnknownKind, string> = {
  TRUE_UNKNOWN: "Không chứng từ nào tồn tại để trả lời câu hỏi này. Đây là câu trả lời ĐÚNG — mọi cách 'sửa' nó đều là đoán.",
  RESOLVABLE: "Dữ liệu đã nằm trong kho, chỉ là chưa có đường nối tới chỗ cần đọc. Sửa bằng mã nguồn.",
  STALE: "Dữ liệu có, nhưng lớp đọc chưa chạy lại từ lúc nó về. Sửa bằng cách chạy job đồng bộ.",
  AMBIGUOUS: "Có nhiều ứng viên và không căn cứ nào chọn được. Giữ nguyên và đưa cho người quyết — máy chọn bừa trông y hệt máy biết.",
};

/** Chỉ hai loại là VIỆC PHẢI LÀM. Suy ra từ loại, không khai tay — hai chỗ khai là hai chỗ lệch. */
export function isFixable(kind: UnknownKind): boolean {
  return kind === "RESOLVABLE" || kind === "STALE";
}

export type DqSeverity = "BLOCKING" | "HIGH" | "MEDIUM" | "INFO";

export const DQ_SEVERITY_LABEL: Record<DqSeverity, string> = {
  BLOCKING: "Chặn ra quyết định",
  HIGH: "Nặng",
  MEDIUM: "Cần xử lý",
  INFO: "Theo dõi",
};

export const DQ_SEVERITY_TONE: Record<DqSeverity, string> = {
  BLOCKING: "bg-destructive/10 text-destructive",
  HIGH: "bg-warning/15 text-amber-700 dark:text-amber-300",
  MEDIUM: "bg-info/12 text-info",
  INFO: "bg-muted text-muted-foreground",
};

export const DQ_CHECKS = [
  "shipment-no-handoff",
  "shipment-order-ambiguous",
  "bank-unclassified",
  "cogs-unknown",
  "attribution-unknown",
  "variant-unmapped",
  "metric-target-missing",
  "integration-stale",
] as const;
export type DqCheck = (typeof DQ_CHECKS)[number];

export type DqCheckSpec = {
  key: DqCheck;
  label: string;
  /** Một câu: chỗ trống này khiến con số nào nói sai. */
  why: string;
  severity: DqSeverity;
  kind: UnknownKind;
  /** Bảng/cột có thật mà phép đếm này đọc. Không có nguồn thật thì không có mục. */
  source: string;
  /** VIỆC PHẢI LÀM, viết cho người sẽ làm nó — không phải cho người viết code. */
  action: string;
  /** Phòng ban làm việc đó. PHÒNG BAN, không bao giờ một cá nhân (AGENTS.md mục 22). */
  owner: DepartmentCode;
  /** Đường dẫn mở ra đúng danh sách đang đếm. Rỗng = chưa có màn hình drill-down. */
  href: string;
};

export const DQ_CHECK_SPECS: Record<DqCheck, DqCheckSpec> = {
  "shipment-no-handoff": {
    key: "shipment-no-handoff",
    label: "Vận đơn chưa có chứng cứ ĐVVC tiếp nhận",
    why: "Kiện không có mốc bàn giao nằm NGOÀI mọi cohort 'Đã gửi' — tỷ lệ giao thành công, tuổi kiện và SLA giao vận đều không thấy nó.",
    severity: "HIGH",
    kind: "TRUE_UNKNOWN",
    source: "shipments + shipment_events qua CARRIER_HANDOFF_AT_SQL (lib/constants/carrier-handoff.ts)",
    action: "Phần lớn nhóm này là kiện ĐVVC CHƯA lấy được hoặc shop đã huỷ lấy — đó là sự thật, không phải lỗi. Việc cần làm là rà lại những kiện đã tạo vận đơn từ lâu mà bưu tá chưa tới lấy, rồi huỷ hoặc đặt lại lịch lấy hàng.",
    owner: "LOGISTICS",
    href: "/shipments?stage=PENDING",
  },
  "shipment-order-ambiguous": {
    key: "shipment-order-ambiguous",
    label: "Vận đơn hoàn lần ra nhiều đơn",
    why: "Không biết kiện thuộc đơn nào thì không biết trong kiện có món gì — người kho phải mở ra đếm bằng mắt, và hàng hoàn không vào lại tồn đúng.",
    severity: "MEDIUM",
    kind: "AMBIGUOUS",
    source: "shipments.order_reference → nhiều shipments.order_id (lib/returns/product-context.ts)",
    action: "Ở bàn nhận hàng hoàn, mở kiện có nhãn 'Mã gốc ra nhiều đơn', đối chiếu mã vận đơn với đơn rồi gắn tay. ERP KHÔNG chọn hộ.",
    owner: "WAREHOUSE",
    href: "/inventory/returns",
  },
  "bank-unclassified": {
    key: "bank-unclassified",
    label: "Dòng tiền chưa phân loại",
    why: "Dòng chưa phân loại không vào báo cáo nào, nên số dư sổ khớp mà lợi nhuận thì thiếu đúng phần đó.",
    severity: "HIGH",
    kind: "RESOLVABLE",
    source: "bank_transactions.accounting_group = 'UNCLASSIFIED'",
    action: "Mở sổ ngân hàng, gán nhóm kế toán cho từng dòng. Dòng lặp lại hàng tháng thì đặt một luật tự động — luật KHÔNG bao giờ ghi đè dòng đã phân loại tay.",
    owner: "FINANCE",
    href: "/bank?group=UNCLASSIFIED",
  },
  "cogs-unknown": {
    key: "cogs-unknown",
    label: "Đơn đã giao mà chưa tra được giá vốn",
    why: "Giá vốn thiếu bị tính bằng 0, nên lợi nhuận của những đơn này đang CAO HƠN thực tế — sai theo hướng dễ chịu nhất, tức là hướng nguy hiểm nhất.",
    severity: "BLOCKING",
    kind: "RESOLVABLE",
    source: "IS_MISSING_COGS (lib/queries/data-quality.ts) — đơn DELIVERED có doanh thu mà giá vốn = 0",
    action: "Nhập phiếu nhập kho CÓ ĐƠN GIÁ cho những mẫu mã liên quan. Một phiếu nhập cũ có giá là đủ để ERP tra ngược.",
    owner: "WAREHOUSE",
    href: "/data-quality?issue=missing-cogs",
  },
  "attribution-unknown": {
    key: "attribution-unknown",
    label: "Việc chưa nối được về tài khoản người làm",
    why: "Dòng không có khoá người thì không vào thẻ điểm. Trước đây chúng TRÔNG như quy kết được vì có ô chữ — và ô chữ đó có thể là tên một job.",
    severity: "MEDIUM",
    kind: "RESOLVABLE",
    source: "cs_cases.assignee_user_id · shipment_care.owner_id · return_inspections.*_by_user_id",
    action: "Từ nay giao việc bằng ô CHỌN TÀI KHOẢN (đã thay ô gõ tay). Dòng lịch sử KHÔNG backfill — đoán người cho việc cũ là tạo ra một lời khẳng định sai về ai đã làm gì.",
    owner: "MANAGEMENT",
    href: "/work/settings",
  },
  "variant-unmapped": {
    key: "variant-unmapped",
    label: "Dòng hàng chưa ghép được mẫu mã",
    why: "Dòng không có mẫu mã thì không trừ tồn, không vào kế hoạch sản xuất, không vào báo cáo theo mã hàng.",
    severity: "MEDIUM",
    kind: "RESOLVABLE",
    source: "order_items.variant_id IS NULL",
    action: "Đồng bộ lại sản phẩm từ Pancake; mẫu mã đã xoá bên Pancake thì tạo lại trong ERP rồi ghép.",
    owner: "WAREHOUSE",
    href: "/products",
  },
  "metric-target-missing": {
    key: "metric-target-missing",
    label: "Chỉ số đo được nhưng chưa ai đặt đích",
    why: "Không có đích thì thẻ điểm chỉ hiện con số và KHÔNG kết luận được đạt hay chưa — đúng luật, nhưng cũng nghĩa là chỉ số đó chưa dùng để lái việc gì.",
    severity: "INFO",
    kind: "TRUE_UNKNOWN",
    source: "metric_targets so với sổ chỉ số gộp (lib/constants/metric-registry.ts)",
    action: "Chủ shop đặt đích ở màn hình Cấu hình bàn làm việc, kèm LÝ DO. ERP cố ý không đặt sẵn đích nào — một đích do máy nghĩ ra sẽ được đọc như chuẩn của shop.",
    owner: "MANAGEMENT",
    href: "/work/settings",
  },
  "integration-stale": {
    key: "integration-stale",
    label: "Kết nối dữ liệu đã lâu không về",
    why: "Đường ống đứng im thì mọi con số phía sau nó vẫn hiện ra bình thường, chỉ là của hôm kia. Đây là kiểu hỏng không màn hình nào tự nói ra.",
    severity: "HIGH",
    kind: "STALE",
    source: "sync_runs + integration_health (lib/queries/integration-health.ts)",
    action: "Mở trang Kết nối dữ liệu, xem kết nối nào đang đỏ rồi chạy lại job của nó. Hỏng do khoá hết hạn thì cấp lại khoá.",
    owner: "MANAGEMENT",
    href: "/integrations",
  },
};

export const DQ_CHECK_LIST: DqCheckSpec[] = DQ_CHECKS.map((k) => DQ_CHECK_SPECS[k]);

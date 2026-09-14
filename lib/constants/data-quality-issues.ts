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
  "cs-stale-order-not-created",
  "cs-duplicate-actionable-customer",
  "return-tracking-not-found",
  "return-sku-unresolved",
  "return-qty-mismatch",
  "return-duplicate-receipt",
  "return-received-without-expected-item",
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
    label: "Chỉ số đo được nhưng chưa ai đặt mục tiêu",
    why: "Không có đích thì thẻ điểm chỉ hiện con số và KHÔNG kết luận được đạt hay chưa — đúng luật, nhưng cũng nghĩa là chỉ số đó chưa dùng để lái việc gì.",
    severity: "INFO",
    kind: "TRUE_UNKNOWN",
    source: "metric_targets so với sổ chỉ số gộp (lib/constants/metric-registry.ts)",
    action: "Chủ shop đặt mục tiêu ở Công việc → Cấu hình → Mục tiêu chỉ số, kèm LÝ DO. ERP cố ý không đặt sẵn con số nào — một mục tiêu do máy nghĩ ra sẽ được đọc như chuẩn của shop.",
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
  /* ═══════════ CSKH ═══════════ */
  "cs-stale-order-not-created": {
    key: "cs-stale-order-not-created",
    label: "“Chưa tạo đơn” trong khi đơn đã có",
    why: "Case mang một điều kiện SỐNG (‘đơn chưa tồn tại’) hết đúng ngay khi ai đó lên đơn. Người trực mở hàng đợi, thấy việc, rồi gọi cho khách đã mua tuần trước để hỏi có muốn đặt hàng không.",
    severity: "HIGH",
    kind: "RESOLVABLE",
    source: "cs_cases kind=ORDER_NOT_CREATED đang mở, đối chiếu ba bậc chứng cứ ở lib/cs/reconcile-order-created.ts",
    action: "Máy đối chiếu chạy cùng job `cs-chat` (15 phút/lần) và tự đóng mềm phần có chứng cứ. Con số còn lại là case CÓ NGƯỜI NHẬN hoặc đã ghi kết luận — máy không quyết thay người, nên người đó phải xem lại.",
    owner: "SALES",
    href: "/cs?view=theo-case&kind=ORDER_NOT_CREATED",
  },
  "cs-duplicate-actionable-customer": {
    key: "cs-duplicate-actionable-customer",
    label: "Một khách chiếm nhiều dòng việc",
    why: "Người trực gọi cho cùng một khách nhiều lần, hoặc gọi một lần rồi vẫn thấy mấy dòng đỏ còn lại mà không biết đã xử lý tới đâu.",
    severity: "MEDIUM",
    kind: "RESOLVABLE",
    source: "cs_cases đang mở, gom theo customer_id rồi tới số điện thoại đã chuẩn hoá",
    action: "Dùng tab “Theo khách” — nó gom sẵn mỗi khách thành một dòng và cho xử lý cả cụm. KHÔNG gộp case: mỗi việc vẫn giữ mã, loại và lịch sử riêng.",
    owner: "SALES",
    href: "/cs?view=theo-khach",
  },

  /* ═══════════ HÀNG HOÀN ═══════════ */
  "return-tracking-not-found": {
    key: "return-tracking-not-found",
    label: "Sổ hàng hoàn ghi mã vận đơn ERP không có",
    why: "Kiện có thật trên kệ nhưng ERP không biết nó tồn tại, nên nó không nằm trong bất kỳ con số hàng hoàn nào và hàng trong đó không bao giờ về lại tồn.",
    severity: "MEDIUM",
    kind: "AMBIGUOUS",
    source: "hmt_return_reconciliation.match_status = 'UNMATCHED_TRACKING'",
    action: "Mở lại bảng tính ở đúng dòng đã ghi, đối chiếu mã với vận đơn trên trang Viettel Post. Sai chính tả thì sửa sổ; kiện chưa đồng bộ thì chạy job `vtp-tracking` rồi đối soát lại.",
    owner: "WAREHOUSE",
    href: "/inventory/returns",
  },
  "return-sku-unresolved": {
    key: "return-sku-unresolved",
    label: "Dòng sản phẩm trong sổ hoàn không lần ra mẫu mã",
    why: "Không biết món nào về thì không đối chiếu được với hàng kỳ vọng của kiện — và không có căn cứ nào để kho đếm lại.",
    severity: "MEDIUM",
    kind: "AMBIGUOUS",
    source: "hmt_return_reconciliation.match_status in ('AMBIGUOUS_SKU','SKU_MISMATCH')",
    action: "Mơ hồ: danh mục có hai mẫu mã không phân biệt được — tách chúng ra rồi đối soát lại. Không khớp: sổ ghi màu/size không có trong danh mục, hoặc món đó không thuộc đơn của kiện; cả hai đều cần người mở kiện xem.",
    owner: "WAREHOUSE",
    href: "/inventory/returns",
  },
  "return-qty-mismatch": {
    key: "return-qty-mismatch",
    label: "Số món trong sổ hoàn vượt số kỳ vọng",
    why: "Sổ ghi nhiều hơn số đơn có. Hoặc sổ ghi trùng dòng, hoặc kiện chứa hàng của một đơn khác — cả hai đều làm phép cộng tồn sai nếu cứ nhận bừa.",
    severity: "MEDIUM",
    kind: "AMBIGUOUS",
    source: "hmt_return_reconciliation.match_status in ('QUANTITY_CONFLICT','DUPLICATE_SOURCE_ROW','CONFLICT')",
    action: "Đối chiếu số dòng trong bảng tính với dòng hàng của đơn. KHÔNG cắt bớt cho vừa — số dôi ra là một câu hỏi thật.",
    owner: "WAREHOUSE",
    href: "/inventory/returns",
  },
  "return-duplicate-receipt": {
    key: "return-duplicate-receipt",
    label: "Một kiện hoàn có nhiều phiếu tái nhập",
    why: "Mỗi phiếu tái nhập cộng tồn một lần. Hai phiếu cho một kiện là tồn ảo, và nó không hiện ra ở đâu cho tới kỳ kiểm kê.",
    severity: "BLOCKING",
    kind: "RESOLVABLE",
    source: "stock_receipt_items gộp theo shipment_id, đếm số phiếu RETURN khác nhau",
    action: "Lập phiếu điều chỉnh kho trừ đi phần cộng thừa, ghi rõ lý do. KHÔNG xoá phiếu cũ — xoá ngược lịch sử làm mất dấu ai đã cộng.",
    owner: "WAREHOUSE",
    href: "/inventory/receipts",
  },
  "return-received-without-expected-item": {
    key: "return-received-without-expected-item",
    label: "Kiện đã nhận nhưng không biết trong đó có gì",
    why: "Kho bấm nhận rồi mà ERP không lần ra đơn, nên không có danh sách hàng kỳ vọng để đối chiếu lúc đếm. Người kho đứng trước kiện hàng và không có gì để so.",
    severity: "HIGH",
    kind: "AMBIGUOUS",
    source: "return_inspections status=RECEIVED mà shipment không lần ra order_items nào",
    action: "Ở bàn nhận hàng hoàn, gắn tay kiện với đúng đơn (mã gốc của vận đơn chiều về thường lần ra được). Không gắn được thì đếm theo mã hàng đọc trên tem và lập phiếu tái nhập tay có ghi mã vận đơn.",
    owner: "WAREHOUSE",
    href: "/inventory/returns",
  },
};

export const DQ_CHECK_LIST: DqCheckSpec[] = DQ_CHECKS.map((k) => DQ_CHECK_SPECS[k]);

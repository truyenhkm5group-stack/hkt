import type { CaseTeam, CaseType } from "@/lib/constants/action-queue";

/**
 * ═══════ PHỄU VẬN HÀNH — MỘT SỔ ĐĂNG KÝ CHO CẢ DÒNG CHẢY KINH DOANH ═══════
 *
 * Mỗi khâu phải trả lời được BỐN câu, và bốn câu đó quyết định những trường có ở đây:
 *
 *   A. ĐANG KẸT Ở ĐÂU?              → `backlog` + `aging` (đo ở stage-health.ts)
 *   B. VIỆC NÀO CẦN LÀM NGAY?       → `caseTypes` — bắc cầu sang Hàng đợi công việc đã có
 *   C. AI PHỤ TRÁCH?                → `team`
 *   D. XỬ LÝ THU HỒI ĐƯỢC BAO NHIÊU? → `moneyMeaning` + bộ ước lượng ở lib/queries/impact.ts
 *
 * ─── VÌ SAO KHÔNG TỰ ĐẺ RA HỆ THỐNG CẢNH BÁO MỚI ───
 *
 * Hàng đợi công việc đã có sẵn: loại việc, đội phụ trách, SLA từng loại, trọng số còn-cứu-được,
 * hành động khuyến nghị, điểm ưu tiên giải thích được. Dựng một lớp cảnh báo thứ hai song song sẽ
 * tạo ra hai danh sách việc nói hai con số khác nhau cho cùng một vấn đề — đúng thứ tệ nhất có thể
 * làm với một hệ thống vận hành.
 *
 * Nên sổ này chỉ **bắc cầu**: khâu nào ứng với loại việc nào. Ngoại lệ, chủ trách nhiệm, hành động
 * và điểm ưu tiên vẫn do Hàng đợi quyết định, ở đúng một chỗ.
 *
 * ─── TÌNH TRẠNG NGUỒN DỮ LIỆU ───
 *
 * Đo trên production 10/09/2026. Khâu nào nguồn chưa có thì ghi thẳng `DATA_UNAVAILABLE` — KHÔNG
 * bịa số, và vẫn giữ hợp đồng để ngày có dữ liệu là cắm vào được.
 */

export type StageKey =
  | "ADS"
  | "LEAD"
  | "ORDER_CREATED"
  | "CONFIRMED"
  | "RISK_REVIEW"
  | "READY_TO_SHIP"
  | "HANDED_TO_CARRIER"
  | "IN_TRANSIT"
  | "DELIVERED"
  | "RETURNING"
  | "COD_EXPECTED"
  | "CASH_RECEIVED"
  | "RETURN_INSPECTION"
  | "INVENTORY"
  | "PRODUCTION"
  | "REPEAT";

/** Nguồn dữ liệu của khâu đang ở tình trạng nào. Không có `HEALTHY` giả — đo từ chính CSDL. */
export type SourceStatus = "HEALTHY" | "DEGRADED" | "DATA_UNAVAILABLE";

export type StageSpec = {
  key: StageKey;
  label: string;
  /** Thứ tự trong dòng chảy — dùng để tính tỷ lệ chuyển sang khâu kế tiếp. */
  order: number;
  team: CaseTeam;
  /** Loại việc của Hàng đợi thuộc về khâu này. Đây là cầu nối duy nhất, không nhân bản luật. */
  caseTypes: CaseType[];
  /** Tiền ở khâu này NGHĨA LÀ GÌ — trộn lẫn các loại tiền là cách nhanh nhất để mất tin cậy. */
  moneyMeaning: string;
  /** Bấm vào con số thì đi đâu để thấy ĐÚNG những bản ghi đã đếm. */
  href: string;
  /** Vì sao nguồn ở tình trạng đó — nói bằng con số đo được, không bằng cảm tính. */
  sourceNote: string;
};

/**
 * Mốc tuổi dùng chung. Đặt ở một chỗ để mọi khâu đọc cùng một thang — mỗi màn hình tự chia mốc
 * riêng thì hai người nhìn hai bảng sẽ cãi nhau về "quá hạn" nghĩa là gì.
 */
export const AGING_BUCKETS = [
  { key: "duoi2h", label: "dưới 2 giờ", maxHours: 2 },
  { key: "2den6h", label: "2–6 giờ", maxHours: 6 },
  { key: "6den24h", label: "6–24 giờ", maxHours: 24 },
  { key: "1den3ngay", label: "1–3 ngày", maxHours: 72 },
  { key: "tren3ngay", label: "trên 3 ngày", maxHours: Number.POSITIVE_INFINITY },
] as const;

export type AgingKey = (typeof AGING_BUCKETS)[number]["key"];

export const OPERATING_FUNNEL: StageSpec[] = [
  {
    key: "ADS",
    label: "Quảng cáo · kéo khách",
    order: 1,
    team: "ADS",
    caseTypes: ["ADS_BILLING", "ADS_ANOMALY"],
    moneyMeaning: "Tiền ĐÃ CHI để có khách. Không phải tiền treo — nó đã ra khỏi tài khoản rồi; con số ở đây là phần đang chi sai hoặc sắp không chi được nữa.",
    href: "/ads",
    sourceNote: "Chi tiêu Meta + kết quả đơn. Quy kết đơn về chiến dịch có độ phủ riêng, xem trang Quảng cáo.",
  },
  {
    key: "LEAD",
    label: "Khách nhắn / tiềm năng",
    order: 2,
    team: "CS",
    caseTypes: ["CS_CASE"],
    moneyMeaning: "Chưa quy ra tiền được — chưa có mô hình xác định nào nối một cuộc hội thoại với doanh thu.",
    href: "/cs",
    sourceNote:
      "Nguồn là case CSKH dựng từ hội thoại Pancake, KHÔNG phải toàn bộ tin nhắn. Không có mốc phản hồi đầu tiên cho từng lead, nên tỷ lệ và thời gian phản hồi CHƯA đo được.",
  },
  {
    key: "ORDER_CREATED",
    label: "Đơn đã lên",
    order: 3,
    team: "CS",
    caseTypes: ["NEW_ORDER_UNPROCESSED", "ORDER_INCOMPLETE"],
    moneyMeaning: "Giá trị ĐÃ LÊN ĐƠN — chưa phải doanh thu, vì đơn còn có thể huỷ hoặc hoàn.",
    href: "/orders",
    sourceNote: "Đơn Pancake đồng bộ mỗi 3 phút.",
  },
  {
    key: "CONFIRMED",
    label: "Chờ xác nhận",
    order: 4,
    team: "CS",
    caseTypes: ["ORDER_ADDRESS_NOT_NORMALIZED"],
    moneyMeaning: "Giá trị đơn đang CHỜ được xác nhận — vẫn là tiền chưa chắc, nhưng còn cứu được bằng một cuộc gọi.",
    href: "/orders?stage=NEW",
    sourceNote: "Trạng thái đơn Pancake.",
  },
  {
    key: "RISK_REVIEW",
    label: "Soát rủi ro trước gửi",
    order: 5,
    team: "CS",
    caseTypes: ["RISKY_ORDER"],
    moneyMeaning: "Giá trị đơn đang chờ soát — gửi nhầm đơn rủi ro thì mất cả hàng lẫn hai chiều cước.",
    href: "/alerts?type=RISKY_ORDER",
    sourceNote: "Luật chấm rủi ro dựng từ lịch sử hoàn của khách, địa chỉ và giá trị COD.",
  },
  {
    key: "READY_TO_SHIP",
    label: "Chờ bàn giao ĐVVC",
    order: 6,
    team: "WAREHOUSE",
    caseTypes: ["ORDER_CONFIRMATION_STALE"],
    moneyMeaning: "Doanh thu đang BỊ CHẶN trước khi rời kho — hàng còn nguyên, chỉ thiếu thao tác.",
    href: "/orders?stage=CONFIRMED",
    sourceNote: "Đơn đã xác nhận mà chưa có vận đơn.",
  },
  {
    key: "HANDED_TO_CARRIER",
    label: "Đã bàn giao ĐVVC",
    order: 7,
    // Kiện hàng là của giao vận, nhưng việc TỒN ĐỌNG ở khâu này chỉ có một loại: không biết vận
    // đơn nào thuộc đơn nào. Người sửa được chuyện đó là đội dữ liệu, nên chủ khâu ghi theo người
    // xử lý được, không theo người sở hữu kiện hàng.
    team: "DATA",
    caseTypes: ["ORPHAN_SHIPMENT", "AMBIGUOUS_ORDER_SHIPMENT_MAPPING"],
    moneyMeaning: "COD đang nằm trên đường — chưa phải tiền của shop.",
    href: "/shipments",
    sourceNote: "Vận đơn Viettel Post, webhook + tra cứu định kỳ.",
  },
  {
    key: "IN_TRANSIT",
    label: "Đang giao / giao hụt",
    order: 8,
    team: "LOGISTICS",
    caseTypes: ["DELIVERY_FAILED", "DELIVERY_STALE", "CANCELLED_BUT_SHIPPING"],
    moneyMeaning: "COD ĐANG RỦI RO: giao hụt mà không ai gọi lại thì phần lớn thành đơn hoàn.",
    href: "/shipments?stage=DELIVERY_FAILED",
    sourceNote: "Sự kiện ĐVVC — nguồn chứng từ mạnh nhất.",
  },
  {
    key: "DELIVERED",
    label: "Giao thành công",
    order: 9,
    team: "LOGISTICS",
    caseTypes: [],
    moneyMeaning: "Doanh thu ĐÃ GHI NHẬN theo chứng từ giao hàng — vẫn chưa chắc là tiền đã về.",
    href: "/reports/returns",
    sourceNote: "Kết quả đơn tính bằng ORDER_OUTCOME, không suy từ tiền.",
  },
  {
    key: "RETURNING",
    label: "Hoàn về",
    order: 10,
    team: "LOGISTICS",
    caseTypes: ["RETURNING"],
    moneyMeaning: "Doanh thu ĐÃ MẤT của đơn đó, cộng thêm cước hai chiều.",
    href: "/reports/returns",
    sourceNote: "Sự kiện ĐVVC chiều hoàn.",
  },
  {
    key: "COD_EXPECTED",
    label: "COD chờ về",
    order: 11,
    team: "FINANCE",
    caseTypes: ["COD_OVERDUE"],
    moneyMeaning: "TIỀN MẶT chưa về tài khoản. Đây là tiền thật, không phải ước tính.",
    href: "/cod?recon=unproven",
    sourceNote: "Bảng kê Viettel Post.",
  },
  {
    key: "CASH_RECEIVED",
    label: "Tiền đã về",
    order: 12,
    team: "FINANCE",
    caseTypes: [],
    moneyMeaning: "Tiền mặt ĐÃ VỀ, có chứng từ đối chiếu.",
    href: "/cod",
    sourceNote: "Bảng kê COD. Sổ ngân hàng chưa nhập nên chưa đối chiếu được với số dư thật.",
  },
  {
    key: "RETURN_INSPECTION",
    label: "Hàng hoàn chờ kiểm đếm",
    order: 13,
    team: "WAREHOUSE",
    caseTypes: ["RETURN_RECEIVED_PENDING_INSPECTION"],
    moneyMeaning: "Giá vốn đang NẰM NGOÀI SỔ: hàng có thật trong kho mà tồn chưa tính, nên kế hoạch sản xuất đặt thừa đúng bằng lượng đó.",
    href: "/inventory/returns",
    sourceNote: "Kiện hoàn ĐVVC đã trả về shop.",
  },
  {
    key: "INVENTORY",
    label: "Tồn kho & vốn",
    order: 14,
    team: "WAREHOUSE",
    caseTypes: ["LOW_STOCK_RISK", "STOCKOUT_RISK"],
    moneyMeaning: "Vốn đang nằm trong hàng, và doanh thu có thể mất khi hết hàng.",
    href: "/products",
    sourceNote: "Sổ kho dựng từ phiếu nhập và mốc xuất kho ĐVVC.",
  },
  {
    key: "PRODUCTION",
    label: "Sản xuất / nhập hàng",
    order: 15,
    team: "PRODUCTION",
    caseTypes: [],
    moneyMeaning: "Vốn đã cam kết với xưởng, chưa nhận hàng.",
    href: "/inventory/planning",
    sourceNote: "Lệnh sản xuất.",
  },
  {
    key: "REPEAT",
    label: "Mua lại / chăm sóc",
    order: 16,
    team: "CS",
    caseTypes: ["CUSTOMER_RECOVERY"],
    moneyMeaning: "Doanh thu ĐÃ NHẬN của khách cũ. Giá trị vòng đời tương lai là ước tính, để riêng.",
    href: "/customers/retention",
    sourceNote: "Khách và đơn đã giao thành công.",
  },
];

/**
 * LOẠI VIỆC CỐ Ý KHÔNG THUỘC KHÂU NÀO — kèm lý do.
 *
 * Không phải mọi việc đều nằm trên dòng chảy. Nhét bừa một việc cắt ngang vào một khâu sẽ nói dối
 * về phạm vi của nó: người đọc tưởng chỉ khâu ấy hỏng, trong khi cả bảng đang sai.
 *
 * `tests/operating-funnel.test.ts` bắt buộc mọi loại việc phải hoặc thuộc ĐÚNG MỘT khâu, hoặc có
 * tên ở đây. Thêm loại việc mới mà quên xếp khâu thì bài kiểm đỏ, không phải im lặng biến mất.
 */
export const NGOAI_PHEU: Partial<Record<CaseType, string>> = {
  DATA_ERROR: "Dữ liệu sai làm lệch MỌI khâu, không riêng khâu nào. Xếp nó vào một khâu là nói dối về phạm vi ảnh hưởng.",
  PROFITABILITY_ALERT: "Cảnh báo mức kinh doanh (mẫu mã / kênh đang lỗ), không phải một chỗ tắc trong dòng chảy hàng.",
  OTHER: "Loại rơi vãi, không mang nghĩa vận hành nào.",
};

export const STAGE_BY_KEY: Record<StageKey, StageSpec> = Object.fromEntries(OPERATING_FUNNEL.map((s) => [s.key, s])) as Record<StageKey, StageSpec>;

/** Khâu kế tiếp trong dòng chảy — dùng để tính tỷ lệ chuyển. */
export function nextStage(key: StageKey): StageSpec | null {
  const cur = STAGE_BY_KEY[key];
  return OPERATING_FUNNEL.find((s) => s.order === cur.order + 1) ?? null;
}

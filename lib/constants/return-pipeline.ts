import type { CaseTeam } from "@/lib/constants/action-queue";

/**
 * ═══════════ ĐƯỜNG ỐNG HÀNG HOÀN — TỒN ĐỌNG ≠ VIỆC PHẢI LÀM ═══════════
 *
 * Kho đang có **471 kiện hoàn**, còn hàng đợi việc chỉ mở **16 việc**. Nhìn qua thì tưởng hỏng.
 * Không hỏng: luật cảnh báo cố ý nêu đích danh 15 kiện CŨ NHẤT rồi gộp phần còn lại thành MỘT việc,
 * vì sinh mỗi kiện một việc sẽ đẩy vài trăm dòng vào hàng đợi cùng lúc, chiếm trọn màn hình và làm
 * cả hàng đợi bị bỏ qua — kể cả việc gấp thật.
 *
 * Nhưng 455 kiện còn lại KHÔNG được biến mất khỏi số liệu. Chúng là **tồn đọng của một đường ống**:
 * một phép đo, không phải một danh sách việc. Hai thứ khác nhau và cần hai chỗ khác nhau:
 *
 *   ĐƯỜNG ỐNG (ở đây)   — toàn bộ 471 kiện đang ở đâu, giữ bao nhiêu vốn, tồn bao lâu.
 *   HÀNG ĐỢI VIỆC       — kiện nào cần một người bắt tay vào NGAY, hôm nay.
 *
 * ─── VÌ SAO CÁC KHÂU NÀY TÁCH ĐƯỢC ───
 *
 * Ba mốc khác nhau trong CSDL, ba nghĩa khác nhau, không được gộp:
 *
 *   `shipments.stage = 'RETURNING'`      ĐVVC đang chở hàng về — chưa ai làm gì được.
 *   `shipments.stage = 'RETURNED'`       ĐVVC nói đã trả về shop.
 *   `shipments.return_received_at`       KHO xác nhận đã cầm kiện hàng trên tay.
 *   `return_inspections.status`          RECEIVED = chờ đếm · INSPECTED = đã đếm xong.
 *   `return_inspections.stock_receipt_id` Đã lập phiếu tái nhập — hàng THẬT SỰ vào lại tồn.
 *
 * "ĐVVC báo đã hoàn" không phải "hàng về kho", và "hàng về kho" không phải "hàng vào tồn". Mỗi
 * khoảng trống giữa hai mốc là một chỗ vốn nằm im mà không ai đếm.
 */

export type ReturnStageKey =
  | "RETURNING_TO_SENDER"
  | "CARRIER_RETURN_DELIVERED"
  | "INSPECTION_PENDING"
  | "INSPECTED"
  | "RESTOCKED"
  | "WRITTEN_OFF";

export type ReturnStageSpec = {
  key: ReturnStageKey;
  label: string;
  order: number;
  team: CaseTeam;
  /** Khâu này CÓ việc cho người làm hay chỉ là số liệu đi qua. */
  actionable: boolean;
  /**
   * Số giờ nằm ở khâu này thì coi là trễ. `null` = KHÔNG đặt hạn, và phải nói được vì sao —
   * đặt hạn cho việc không ai làm gì được chỉ tạo ra số trễ hạn giả.
   */
  slaHours: number | null;
  /** Tiền ở khâu này nghĩa là gì. Trộn lẫn các loại tiền là cách nhanh nhất để mất tin cậy. */
  moneyMeaning: string;
  href: string;
};

/**
 * HẠN Ở TỪNG KHÂU.
 *
 * `CARRIER_RETURN_DELIVERED` 72 giờ: cùng ngưỡng với luật cảnh báo `returnInspectionDays` để hai
 * nơi không nói hai con số. `INSPECTION_PENDING` 72 giờ: khớp `CASE_SLA_HOURS.RETURN_RECEIVED_PENDING_INSPECTION`.
 */
export const RETURN_PIPELINE: ReturnStageSpec[] = [
  {
    key: "RETURNING_TO_SENDER",
    label: "ĐVVC đang chở về",
    order: 1,
    team: "LOGISTICS",
    actionable: false,
    // Không đặt hạn: hàng đang trên xe, không thao tác nào của shop rút ngắn được.
    slaHours: null,
    moneyMeaning: "Giá vốn đang trên đường về. Doanh thu của đơn đã mất rồi; đây là phần vốn CÓ THỂ lấy lại nếu hàng về nguyên vẹn.",
    href: "/shipments?stage=RETURNING",
  },
  {
    key: "CARRIER_RETURN_DELIVERED",
    label: "ĐVVC đã trả · kho chưa nhận",
    order: 2,
    team: "WAREHOUSE",
    actionable: true,
    slaHours: 72,
    moneyMeaning: "Vốn NẰM NGOÀI SỔ: hàng đã ở chỗ shop mà ERP chưa biết. Kế hoạch sản xuất đang đặt thừa đúng bằng lượng này.",
    href: "/inventory/returns",
  },
  {
    key: "INSPECTION_PENDING",
    label: "Kho đã nhận · chờ đếm",
    order: 3,
    team: "WAREHOUSE",
    actionable: true,
    slaHours: 72,
    moneyMeaning: "Vốn đã cầm trên tay nhưng chưa biết bán lại được bao nhiêu — chưa đếm thì chưa được cộng vào tồn.",
    href: "/inventory/returns",
  },
  {
    key: "INSPECTED",
    label: "Đã đếm · chờ xử lý",
    order: 4,
    team: "WAREHOUSE",
    actionable: true,
    // Đếm xong mà chưa lập phiếu là khoảng trống ngắn; một ngày là quá đủ.
    slaHours: 24,
    moneyMeaning: "Đã biết bán lại được bao nhiêu, nhưng chưa lập phiếu nên tồn vẫn chưa đổi.",
    href: "/inventory/returns",
  },
  {
    key: "RESTOCKED",
    label: "Đã vào lại tồn",
    order: 5,
    team: "WAREHOUSE",
    actionable: false,
    slaHours: null,
    moneyMeaning: "Vốn ĐÃ GIẢI PHÓNG — số thật, đo từ phiếu tái nhập, không phải ước tính.",
    href: "/inventory/receipts",
  },
  {
    key: "WRITTEN_OFF",
    label: "Đếm xong · không bán lại được",
    order: 6,
    team: "WAREHOUSE",
    actionable: false,
    slaHours: null,
    moneyMeaning: "Vốn MẤT HẲN: hỏng, thiếu, hoặc không đúng hàng. Đây là thất thoát có tên, không được lặng lẽ cộng vào tồn.",
    href: "/inventory/returns",
  },
];

export const RETURN_STAGE_BY_KEY: Record<ReturnStageKey, ReturnStageSpec> = Object.fromEntries(
  RETURN_PIPELINE.map((s) => [s.key, s]),
) as Record<ReturnStageKey, ReturnStageSpec>;

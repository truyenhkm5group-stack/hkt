/**
 * ───────────────────── BỘ LUẬT ĐỐI SOÁT DỮ LIỆU ─────────────────────
 *
 * Danh mục các kiểu lệch mà ERP biết cách phát hiện. Mỗi luật nói rõ: mức nghiêm trọng, nghĩa là
 * gì, nên làm gì, và — quan trọng nhất — **có được tự sửa hay không**.
 *
 * Nguyên tắc bất di dịch (docs/business-rules/ORDER_OUTCOME.md mục 10):
 *  · CHỈ tự sửa khi kết quả là XÁC ĐỊNH và suy được từ chính nguồn sự thật của chiều đó.
 *  · Lệch GIỮA HAI CHIỀU (tiền nói một đằng, giao hàng nói một nẻo) thì TUYỆT ĐỐI không tự sửa:
 *    máy không biết bên nào đúng, và sửa bừa là bịa ra chứng từ.
 *
 * Đây chính là chỗ ERP từng sai nặng nhất (F1/F2 trong docs/erp-data-truth-audit.md): job cũ thấy
 * "COD đã về ngân hàng mà vận đơn chưa giao" liền ghi thẳng vận đơn thành GIAO THÀNH CÔNG.
 */

export type IssueSeverity = "ERROR" | "WARNING" | "INFO";

export type ReconciliationRuleKey =
  | "SHIPMENT_STATE_DRIFT"
  | "DELIVERED_WITHOUT_LOGISTICS_EVIDENCE"
  | "MISSING_PRODUCT_MAPPING"
  | "ZERO_TOTAL_WITH_ITEMS"
  | "PAYMENT_DELIVERED_CONFLICT"
  | "COD_STATE_CONFLICT"
  | "COD_NOT_APPLICABLE_WITH_AMOUNT"
  | "ORDER_WITH_TRACKING_NO_SHIPMENT"
  | "SHIPMENT_WITHOUT_ORDER"
  | "DUPLICATE_TRACKING"
  | "STALE_SHIPMENT"
  | "UNKNOWN_VTP_STATUS"
  | "INVALID_EVENT_ORDER"
  | "DELIVERED_WITHOUT_DATE"
  | "ORDER_SHIPMENT_CONFLICT"
  | "AMBIGUOUS_ORDER_SHIPMENT_MAPPING"
  | "ORDER_WITH_MULTIPLE_SHIPMENTS"
  | "INVENTORY_RETURN_CONFLICT"
  | "FAILED_EVENT_PROCESSING"
  | "COD_OVERDUE_UNPAID"
  | "EXPENSE_NEEDS_ALLOCATION_REVIEW"
  | "NEGATIVE_STOCK"
  | "STOCK_MISSING_OPENING_BALANCE";

/** Loại đối tượng mà một vi phạm trỏ tới — quyết định drill-down mở trang nào. */
export type IssueEntity = "shipment" | "order" | "order_item" | "webhook_event" | "shipment_event";

export type ReconciliationRule = {
  key: ReconciliationRuleKey;
  severity: IssueSeverity;
  entity: IssueEntity;
  label: string;
  /** Nghĩa thật của con số này. */
  reason: string;
  /** Người vận hành nên làm gì. */
  suggestedAction: string;
  /**
   * Có được TỰ SỬA không. `false` nghĩa là chỉ báo cáo — kể cả khi trông có vẻ hiển nhiên.
   * Sửa được thì phải nói rõ sửa theo nguồn sự thật nào.
   */
  autoRepair: false | { from: string };
};

export const RECONCILIATION_RULES: Record<ReconciliationRuleKey, ReconciliationRule> = {
  SHIPMENT_STATE_DRIFT: {
    key: "SHIPMENT_STATE_DRIFT",
    entity: "shipment",
    severity: "WARNING",
    label: "Ảnh chụp vận đơn lệch với lịch sử sự kiện",
    reason: "`shipments.stage` khác trạng thái dựng lại từ `shipment_events`. Ảnh chụp đã bị một luồng nào đó ghi sai, hoặc còn sót từ trước khi trạng thái được tính từ lịch sử.",
    suggestedAction: "Dựng lại ảnh chụp từ lịch sử — lịch sử là nguồn sự thật.",
    autoRepair: { from: "lịch sử sự kiện Viettel Post (materializeShipmentState)" },
  },
  /**
   * MỘT ĐƠN CÓ HƠN MỘT VẬN ĐƠN GẮN VÀO.
   *
   * Vì sao đây là luật đối soát chứ không phải chuyện nhỏ: gần như MỌI báo cáo đều
   * `orders left join shipments`, nên một đơn hai vận đơn sẽ được đếm HAI LẦN — doanh thu cộng đôi,
   * số đơn cộng đôi, tỷ lệ giao thành công lệch, lợi nhuận sai.
   *
   * Đo trên production 09/09/2026: 2.430 đơn, **0 đơn** rơi vào trường hợp này. Số liệu đang đúng.
   * Không phải may: luật 7 (`AGENTS.md`) bắt vận đơn chiều hoàn mang `order_id NULL` nên nguồn sinh
   * vận đơn thứ hai phổ biến nhất không lọt vào phép nối.
   *
   * Nhưng nó IM LẶNG: ngày đầu tiên có một ca, mọi con số tiền sai mà không gì báo. Luật này tồn tại
   * để ngày đó có người biết — và để KHÔNG ai phải đổi grain báo cáo trước khi có ca thật.
   */
  ORDER_WITH_MULTIPLE_SHIPMENTS: {
    key: "ORDER_WITH_MULTIPLE_SHIPMENTS",
    entity: "order",
    severity: "ERROR",
    label: "Một đơn có nhiều vận đơn — báo cáo sẽ đếm hai lần",
    reason:
      "Báo cáo nối đơn với vận đơn rồi tính trên từng dòng, nên đơn có hai vận đơn bị đếm hai lần: doanh thu cộng đôi, số đơn cộng đôi, tỷ lệ giao thành công lệch. Vận đơn chiều hoàn KHÔNG gây ra chuyện này (nó mang `order_id` rỗng theo thiết kế) — nên một ca ở đây nghĩa là có vận đơn thứ hai được gắn thật vào đơn.",
    suggestedAction:
      "Mở đơn, xác định vận đơn nào là thật. Nếu shop gửi lại đơn bằng vận đơn mới thì phải quyết định đếm thế nào TRƯỚC khi số liệu kỳ này được chốt — đây là quyết định nghiệp vụ, ERP cố ý không tự chọn.",
    // KHÔNG tự sửa: máy không biết vận đơn nào là thật, và đoán sai là xoá mất một lần gửi hàng có
    // thật khỏi sổ.
    autoRepair: false,
  },
  COD_NOT_APPLICABLE_WITH_AMOUNT: {
    key: "COD_NOT_APPLICABLE_WITH_AMOUNT",
    entity: "shipment",
    severity: "WARNING",
    label: "Ghi 'không thu hộ' nhưng vận đơn vẫn có tiền thu hộ",
    reason: "`cod_status = NOT_APPLICABLE` chỉ đúng khi `cod_amount = 0`. Có tiền thu hộ mà ghi 'không thu hộ' là xoá mất dấu vết đòi tiền Viettel Post.",
    suggestedAction: "Đưa về 'Chưa thu' (PENDING) — CHƯA BIẾT, không phải thu 0đ.",
    autoRepair: { from: "chính số tiền thu hộ trên vận đơn (codStatusForAmount)" },
  },
  PAYMENT_DELIVERED_CONFLICT: {
    key: "PAYMENT_DELIVERED_CONFLICT",
    entity: "shipment",
    severity: "ERROR",
    label: "Tiền đã về nhưng vận đơn chưa ghi giao thành công",
    reason: "Bảng kê nói tiền của vận đơn này đã về, còn hành trình Viettel Post thì chưa từng ghi phát thành công. Một trong hai nguồn sai, và MÁY KHÔNG BIẾT BÊN NÀO.",
    suggestedAction: "Đối chiếu tay với Viettel Post. TUYỆT ĐỐI không lấy tiền để kết luận đã giao — đó là điều đặc tả cấm.",
    autoRepair: false,
  },
  COD_STATE_CONFLICT: {
    key: "COD_STATE_CONFLICT",
    entity: "shipment",
    severity: "ERROR",
    label: "Trạng thái tiền mâu thuẫn với chính chứng từ tiền",
    reason: "Ví dụ: đã ghi nhận số thực thu > 0 nhưng trạng thái vẫn là 'không thu hộ', hoặc vận đơn đã hoàn/huỷ mà tiền vẫn ghi đã về ngân hàng.",
    suggestedAction: "Mở sổ chứng từ bảng kê của vận đơn để xem dòng nào tạo ra con số đó.",
    autoRepair: false,
  },
  ORDER_WITH_TRACKING_NO_SHIPMENT: {
    key: "ORDER_WITH_TRACKING_NO_SHIPMENT",
    entity: "order",
    severity: "WARNING",
    label: "Đơn đã sang bước gửi hàng nhưng ERP chưa có vận đơn",
    reason: "Pancake ghi đơn đã gửi/đã nhận/đang hoàn nhưng ERP không có dòng vận đơn nào. Đơn này nằm ngoài mọi số liệu logistics.",
    suggestedAction: "Nhập danh sách vận đơn từ Viettel Post, hoặc kiểm tra đơn có thực sự được đẩy sang ĐVVC chưa.",
    autoRepair: false,
  },
  SHIPMENT_WITHOUT_ORDER: {
    key: "SHIPMENT_WITHOUT_ORDER",
    entity: "shipment",
    severity: "WARNING",
    label: "Vận đơn chưa ghép được với đơn nào",
    reason:
      "Vận đơn có trên Viettel Post nhưng chưa ghép được đơn ERP. Không vào doanh thu, lợi nhuận, tồn kho, marketing. CỐ Ý không đếm vận đơn CHIỀU HOÀN (chúng là dòng riêng, không có đơn — đúng thiết kế) và gói tin TEST của ĐVVC.",
    suggestedAction: "Ghép tay theo mã tham chiếu ở trang Chất lượng dữ liệu. Số điện thoại KHÔNG đủ làm danh tính.",
    autoRepair: false,
  },
  DUPLICATE_TRACKING: {
    key: "DUPLICATE_TRACKING",
    entity: "shipment",
    severity: "ERROR",
    label: "Một mã vận đơn nằm trên nhiều dòng",
    reason: "Cùng một mã vận đơn xuất hiện ở nhiều dòng `shipments`. Mọi tổng hợp theo vận đơn sẽ đếm hai lần.",
    suggestedAction: "Xem hai dòng khác nhau chỗ nào rồi gộp tay; không tự xoá vì có thể mỗi dòng mang một phần dữ liệu.",
    autoRepair: false,
  },
  STALE_SHIPMENT: {
    key: "STALE_SHIPMENT",
    entity: "shipment",
    severity: "WARNING",
    label: "Vận đơn chưa kết thúc, lâu không có tin mới",
    reason: "Vận đơn đang mở mà Viettel Post không gửi tin nào trong nhiều ngày — có thể webhook rơi, có thể hàng đang kẹt thật.",
    suggestedAction: "Chạy đối chiếu qua API hoặc nhập lại danh sách vận đơn; nếu vẫn im thì hỏi Viettel Post.",
    autoRepair: false,
  },
  UNKNOWN_VTP_STATUS: {
    key: "UNKNOWN_VTP_STATUS",
    entity: "shipment_event",
    severity: "WARNING",
    label: "Viettel Post gửi trạng thái ERP chưa hiểu",
    reason: "Sự kiện có mã / chữ không nằm trong bảng mã của ERP nên không dựng được trạng thái. Sự kiện vẫn được lưu nguyên vẹn.",
    suggestedAction: "Bổ sung mã vào `lib/constants/viettelpost.ts` rồi dựng lại trạng thái. Không được đoán.",
    autoRepair: false,
  },
  INVALID_EVENT_ORDER: {
    key: "INVALID_EVENT_ORDER",
    entity: "shipment",
    severity: "ERROR",
    label: "Mốc thời gian đi ngược",
    reason: "Giao thành công trước cả khi lấy hàng, hoặc hoàn về trước khi rời kho. Nghĩa là một trong các mốc bị ghi sai.",
    suggestedAction: "Dựng lại các mốc từ lịch sử sự kiện; nếu lịch sử vẫn ngược thì hỏi Viettel Post.",
    autoRepair: false,
  },
  DELIVERED_WITHOUT_DATE: {
    key: "DELIVERED_WITHOUT_DATE",
    entity: "shipment",
    severity: "WARNING",
    label: "Vận đơn ghi giao thành công nhưng không có mốc giao",
    reason: "Không có mốc giao thì không tính được thời gian giao vận và không biết bao giờ tới hạn trả tiền.",
    suggestedAction: "Dựng lại mốc từ lịch sử. Nếu lịch sử không có thì để trống — KHÔNG lấy ngày cập nhật của ERP thay vào, đó là bịa mốc.",
    autoRepair: { from: "lịch sử sự kiện Viettel Post (materializeShipmentState)" },
  },
  AMBIGUOUS_ORDER_SHIPMENT_MAPPING: {
    key: "AMBIGUOUS_ORDER_SHIPMENT_MAPPING",
    entity: "shipment",
    severity: "WARNING",
    label: "Không biết vận đơn nào thuộc đơn nào",
    reason:
      "Cùng một số điện thoại có nhiều đơn chưa gắn được mã vận đơn, và bằng chứng của ĐVVC không phân biệt được đơn nào ứng với vận đơn nào. Máy CỐ Ý không đoán: gán bừa là bịa ra chứng từ.",
    suggestedAction:
      "Chỉ cần xử lý khi các cách ghép hợp lệ cho ra KẾT QUẢ KHÁC NHAU (ví dụ một vận đơn giao thành công, một vận đơn hoàn). Nếu mọi cách ghép đều cho cùng kết quả thì tổng hợp đã đúng, không cần làm gì.",
    autoRepair: false,
  },
  NEGATIVE_STOCK: {
    key: "NEGATIVE_STOCK",
    entity: "order",
    severity: "WARNING",
    label: "Tồn kho âm",
    reason:
      "Sổ kho tính tồn = phiếu kho − đã xuất qua ĐVVC. Ra số âm nghĩa là hàng đã xuất nhiều hơn số từng nhập — gần như luôn do THIẾU SỐ DƯ ĐẦU KỲ, không phải do bán quá.",
    suggestedAction:
      "Kiểm kê thực tế rồi lập phiếu nhập ghi rõ 'số dư đầu kỳ theo kiểm kê ngày …'. TUYỆT ĐỐI không lập phiếu bù cho khớp số: bịa một con số vào sổ kho đúng là loại sai mà ERP sinh ra để chống.",
    autoRepair: false,
  },
  STOCK_MISSING_OPENING_BALANCE: {
    key: "STOCK_MISSING_OPENING_BALANCE",
    entity: "order",
    severity: "WARNING",
    label: "Mẫu mã đã xuất hàng nhưng chưa có phiếu nhập nào",
    reason:
      "Có đơn đã xuất hàng của mẫu mã này nhưng sổ kho chưa từng ghi một phiếu nhập nào cho nó. Mọi con số tồn của mẫu mã đó đều vô nghĩa cho tới khi có số dư đầu kỳ.",
    suggestedAction: "Đếm thực tế và lập phiếu nhập số dư đầu kỳ. ERP hiện 'Chưa có phiếu nhập' thay vì hiện số, nên không ai bị lừa bởi số 0.",
    autoRepair: false,
  },
  EXPENSE_NEEDS_ALLOCATION_REVIEW: {
    key: "EXPENSE_NEEDS_ALLOCATION_REVIEW",
    entity: "order",
    severity: "WARNING",
    label: "Khoản chi theo kỳ chưa khai kỳ hiệu lực",
    reason:
      "Thuê mặt bằng, lương và phần mềm là chi phí THEO KỲ. Chưa khai kỳ thì báo cáo buộc phải ghi trọn khoản vào đúng ngày phát sinh, nên lợi nhuận của một tuần hay một khoảng ngắn sẽ sai — hoặc gánh cả tháng, hoặc bằng 0.",
    suggestedAction:
      "Mở Chi phí, sửa khoản này và điền kỳ hiệu lực (từ ngày → đến ngày). ERP CỐ Ý không tự đoán kỳ: một khoản phần mềm có thể là tháng, quý hay năm.",
    autoRepair: false,
  },
  ORDER_SHIPMENT_CONFLICT: {
    key: "ORDER_SHIPMENT_CONFLICT",
    entity: "shipment",
    severity: "WARNING",
    label: "Pancake và Viettel Post nói hai điều khác nhau",
    reason: "Trạng thái đơn trên Pancake mâu thuẫn với trạng thái vận đơn. Theo quy tắc của shop, Viettel Post thắng — nhưng nhân viên vẫn đang nhìn số sai trên Pancake.",
    suggestedAction: "Sửa trạng thái trên Pancake cho khớp; ERP không ghi ngược lại Pancake.",
    autoRepair: false,
  },
  INVENTORY_RETURN_CONFLICT: {
    key: "INVENTORY_RETURN_CONFLICT",
    entity: "shipment",
    severity: "ERROR",
    label: "Kho xác nhận nhận hàng hoàn của vận đơn không phải đơn hoàn",
    reason: "Có mốc kho thực nhận hàng hoàn nhưng vận đơn không hề hoàn. Hoặc kho nhận nhầm, hoặc trạng thái vận đơn sai — dù cách nào thì tồn kho cũng đang thừa.",
    suggestedAction: "Đối chiếu phiếu tái nhập với vận đơn thật.",
    autoRepair: false,
  },
  FAILED_EVENT_PROCESSING: {
    key: "FAILED_EVENT_PROCESSING",
    entity: "webhook_event",
    severity: "WARNING",
    label: "Gói tin nhận được nhưng chưa xử lý được",
    reason: "Webhook hỏng lúc xử lý, hoặc tới trước khi đơn tương ứng được đồng bộ về ERP. Gói tin gốc vẫn còn nguyên.",
    suggestedAction: "Chạy lại: `npx tsx scripts/vtp-retry-webhooks.ts`. Xử lý lại là idempotent nên chạy bao nhiêu lần cũng được.",
    autoRepair: false,
  },
  DELIVERED_WITHOUT_LOGISTICS_EVIDENCE: {
    key: "DELIVERED_WITHOUT_LOGISTICS_EVIDENCE",
    entity: "shipment",
    severity: "ERROR",
    label: "Ghi giao thành công nhưng không có chứng từ logistics",
    reason: "Ảnh chụp vận đơn là 'đã giao' nhưng lịch sử không có sự kiện nào của Viettel Post nói đã phát thành công. Kết luận này không dựa trên chứng từ nào cả.",
    suggestedAction: "Tra lại vận đơn trên Viettel Post rồi nhập danh sách vận đơn; nếu không có chứng từ thì KHÔNG được tính vào doanh thu.",
    autoRepair: false,
  },
  MISSING_PRODUCT_MAPPING: {
    key: "MISSING_PRODUCT_MAPPING",
    entity: "order_item",
    severity: "WARNING",
    label: "Dòng đơn chưa ghép được mẫu mã",
    reason: "Dòng đơn không trỏ tới mẫu mã nào trong ERP nên không trừ tồn, không vào kế hoạch sản xuất và không tra được giá vốn.",
    suggestedAction: "Đồng bộ lại sản phẩm từ Pancake, hoặc tạo mẫu mã còn thiếu.",
    autoRepair: false,
  },
  ZERO_TOTAL_WITH_ITEMS: {
    key: "ZERO_TOTAL_WITH_ITEMS",
    entity: "order",
    severity: "WARNING",
    label: "Đơn có hàng nhưng tổng tiền bằng 0",
    reason: "Đơn có sản phẩm mà giá trị bằng 0. Hàng vẫn rời kho nhưng doanh thu ghi nhận là 0 — hoặc là đơn tặng/bảo hành, hoặc là dữ liệu hỏng.",
    suggestedAction: "Kiểm tra trên Pancake xem có phải đơn tặng không; nếu không thì sửa giá rồi đồng bộ lại.",
    autoRepair: false,
  },
  COD_OVERDUE_UNPAID: {
    key: "COD_OVERDUE_UNPAID",
    entity: "shipment",
    severity: "WARNING",
    label: "Giao xong quá lâu mà tiền chưa về",
    reason: "Đã phát thành công quá hạn trả tiền của Viettel Post mà chưa thấy dòng bảng kê nào.",
    suggestedAction: "Đòi Viettel Post, hoặc nhập bảng kê còn thiếu.",
    autoRepair: false,
  },
};

export const RECONCILIATION_RULE_ORDER: ReconciliationRuleKey[] = Object.keys(RECONCILIATION_RULES) as ReconciliationRuleKey[];

export const SEVERITY_ORDER: IssueSeverity[] = ["ERROR", "WARNING", "INFO"];

export const SEVERITY_LABEL: Record<IssueSeverity, string> = {
  ERROR: "Nghiêm trọng",
  WARNING: "Cảnh báo",
  INFO: "Thông tin",
};

export const SEVERITY_TONE: Record<IssueSeverity, string> = {
  ERROR: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  WARNING: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  INFO: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
};

/** Các luật ERP được phép tự sửa — dùng cho kiểm thử bất biến và cho nhãn trên giao diện. */
export const AUTO_REPAIRABLE_RULES = RECONCILIATION_RULE_ORDER.filter((k) => RECONCILIATION_RULES[k].autoRepair !== false);

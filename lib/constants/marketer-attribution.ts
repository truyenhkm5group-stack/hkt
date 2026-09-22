/**
 * ═══════════ QUY KẾT MARKETER CHO MỘT ĐƠN — ĐI BẰNG QUAN HỆ, KHÔNG ĐỌC TÊN CHIẾN DỊCH ═══════════
 *
 * ─── CÂU HỎI ───
 *
 * "Đơn này do ai chạy quảng cáo mang về?" Nó KHÁC hẳn câu hỏi mà báo cáo Quảng cáo/Lương đang trả
 * lời — chỗ đó **chia doanh số của một mã hàng theo tỷ trọng TIỀN QUẢNG CÁO** mỗi marketer đã chi
 * cho mã đó. Phép chia ấy đúng cho việc phân bổ LỢI NHUẬN (một mã có ba người cùng chạy thì doanh
 * số của mã chia ba), nhưng nó KHÔNG nói được đơn số 12345 là của ai — và báo cáo hoàn cần đúng
 * điều đó: một marketer đưa về đơn dễ hoàn phải nhìn thấy trên chính những đơn của mình.
 *
 * ─── ĐƯỜNG ĐI, VÀ VÌ SAO KHÔNG CÓ ĐƯỜNG THỨ HAI ───
 *
 *   orders.ad_id  → fb_ads.campaign_id                          (bằng chứng trực tiếp nhất)
 *   orders.post_id → fb_ads.post_id → campaign_id               (chỉ khi bài thuộc ĐÚNG 1 chiến dịch)
 *   campaign_id   → ad_spends.marketer_id                       (chỉ khi chiến dịch có ĐÚNG 1 người)
 *
 * Hai mắt xích đầu đã có sẵn ở `lib/queries/ads-attribution-link.ts` và được ROAS dùng — tệp này
 * KHÔNG viết lại chúng, chỉ nối thêm mắt xích thứ ba.
 *
 * ─── ĐƯỜNG THỨ HAI: FANPAGE, VÀ VÌ SAO NÓ PHẢI CÓ MẶT ───
 *
 * Đo production 22/09/2026 trên 1.782 đơn ĐÃ KẾT THÚC: đường quảng cáo nói được **720 đơn (40,4%)**
 * — 1.031 đơn không mang `ad_id` và cũng không có `post_id` nối về đúng một chiến dịch. Đó không
 * phải lỗi đồng bộ: khách nhắn thẳng vào fanpage thì Pancake không có mẩu quảng cáo nào để gửi.
 * Bảng "Chất lượng đầu vào theo marketer" vì thế bỏ hơn nửa số đơn vào nhóm "Chưa xác định", và
 * một bảng như thế không dùng để kết luận được điều gì.
 *
 * Mắt xích thứ hai đã nằm sẵn trong kho mã từ 14/09/2026 mà báo cáo hoàn chưa hỏi tới:
 *
 *   orders.page_id → fanpage_marketer_assignments (KHOẢNG HIỆU LỰC) → marketer
 *   ảnh chụp lại ở `order_attributions.marketer_id` (mỗi đơn ĐÚNG MỘT dòng)
 *
 * Nó phủ **1.727/1.782 đơn (96,9%)**. Tệp này KHÔNG tự tra sổ phân công: nó đọc ẢNH CHỤP, vì ảnh
 * chụp là hàm của (page, MỐC ĐƠN LÊN) chứ không phải (page, HÔM NAY) — đổi người phụ trách hôm nay
 * không được viết lại báo cáo tháng trước (`lib/constants/fanpage-attribution.ts`, luật bất biến 1).
 *
 * ─── THỨ TỰ THẨM QUYỀN, VÀ CON SỐ NÓI RẰNG NÓ HIẾM KHI QUAN TRỌNG ───
 *
 * `MARKETER_EVIDENCE_ORDER` là chỗ DUY NHẤT khai thứ tự. Chủ shop chốt (22/09/2026): **quảng cáo
 * trước, fanpage lấp chỗ trống** — chiến dịch nào tiêu tiền của ai là bằng chứng trực tiếp nhất.
 *
 * Đo cùng ngày trên 720 đơn mà CẢ HAI đường cùng lên tiếng: **0 đơn mâu thuẫn**. Hai đường đang nói
 * cùng một tên trên mọi đơn, nên thứ tự hôm nay không đổi một con số nào — nhưng nó sẽ đổi vào ngày
 * một marketer chạy quảng cáo đổ về fanpage của người khác, nên nó vẫn phải được khai ra và ĐẾM.
 *
 * **CHÚ Ý — bảng LƯƠNG đang chạy thứ tự NGƯỢC LẠI** (`lib/constants/payroll.ts::attributionShares`:
 * ảnh chụp fanpage → bảng gán phẳng → quảng cáo), và lý do ghi trong đó cũng là một quyết định của
 * chủ shop. Hai chỗ KHÔNG được âm thầm khác nhau: `marketerEvidenceConflicts` phải được in ra màn
 * hình, và khi con số ấy khác 0 thì đây là việc phải mang lên hỏi, không phải việc tự chọn một bên.
 *
 * **TUYỆT ĐỐI KHÔNG dò chữ trong `ad_spends.campaign`.** Kho mã có sẵn `Employee.aliases` (những
 * mẩu chữ như `"QA4"`, `"QUAN TA"`) và cám dỗ là `campaign ilike '%QA4%'`. Đó đúng là lớp lỗi mà
 * `lib/queries/product-code.ts` đã ghi lại bằng số đo: bốn mã hàng của chính shop này có bốn quy
 * ước đặt tên khác nhau, và không có ngưỡng chuỗi nào vừa đủ rộng vừa đủ hẹp. Quy kết sai ở đây
 * không chỉ làm lệch một báo cáo — nó ghi tỷ lệ hoàn của người này lên thẻ điểm của người kia.
 *
 * ─── BỐN TÌNH TRẠNG, VÀ BA TRONG SỐ ĐÓ LÀ "CHƯA XÁC ĐỊNH" ───
 *
 * `RESOLVED` là tình trạng DUY NHẤT cho phép ghi tên một người. Ba tình trạng còn lại đều hiện ra
 * màn hình dưới cùng một nhãn "Chưa xác định" nhưng được ĐẾM RIÊNG, vì cách sửa của chúng khác
 * nhau: thiếu mắt xích quảng cáo thì phải đồng bộ Facebook, thiếu khai báo thì chủ shop khai ở
 * trang Quảng cáo, còn nhập nhằng thì phải tách chiến dịch.
 *
 * ─── LUẬT BẤT BIẾN: BẬT CHIỀU MARKETER KHÔNG ĐƯỢC LÀM ĐỔI TỔNG ───
 *
 * Mỗi đơn thuộc ĐÚNG MỘT nhóm marketer (kể cả nhóm "Chưa xác định"), nên cộng mọi nhóm phải ra
 * đúng con số khi không bật chiều nào. Không chia một đơn cho hai người, không bỏ rơi đơn không
 * quy kết được. `tests/marketer-attribution.test.ts` khoá điều này.
 */

/** Khoá nhóm của đơn KHÔNG quy kết được. Là một nhóm thật, luôn hiện, không bao giờ bị lọc mất. */
export const MARKETER_UNRESOLVED = "__unresolved__" as const;
export const MARKETER_UNRESOLVED_LABEL = "Chưa xác định";

/**
 * HAI LOẠI BẰNG CHỨNG, và mỗi loại trả lời một câu hơi khác nhau.
 *
 * `AD_CAMPAIGN` nói "tiền quảng cáo của ai tạo ra đơn này"; `FANPAGE_ASSIGNMENT` nói "đơn này rơi
 * vào fanpage ai đang phụ trách lúc nó lên". Cả hai đều là KHAI BÁO của chủ shop đi bằng KHOÁ —
 * không đường nào dò chữ trong tên chiến dịch hay tên page.
 */
export const MARKETER_EVIDENCE = ["AD_CAMPAIGN", "FANPAGE_ASSIGNMENT"] as const;
export type MarketerEvidence = (typeof MARKETER_EVIDENCE)[number];

export const MARKETER_EVIDENCE_LABEL: Record<MarketerEvidence, string> = {
  AD_CAMPAIGN: "theo chiến dịch quảng cáo",
  FANPAGE_ASSIGNMENT: "theo fanpage phụ trách",
};

export const MARKETER_EVIDENCE_HINT: Record<MarketerEvidence, string> = {
  AD_CAMPAIGN: "Đơn mang ad_id (hoặc post_id thuộc đúng một chiến dịch) → chiến dịch → người phụ trách khai ở bảng chi tiêu quảng cáo.",
  FANPAGE_ASSIGNMENT: "Đơn phát sinh trên một fanpage đã có người phụ trách TẠI MỐC ĐƠN LÊN, đọc từ ảnh chụp order_attributions — không phải người phụ trách hôm nay.",
};

/**
 * THỨ TỰ THẨM QUYỀN — chỗ DUY NHẤT khai nó. Đứng trước thì thắng khi hai đường cùng lên tiếng.
 *
 * Đổi thứ tự ở đây là đổi cho mọi báo cáo đi qua `orderMarketerJoin()` cùng lúc, và phải có chủ
 * shop chốt (AGENTS.md mục 7). Xem khối đầu tệp về chỗ bảng lương đang khai ngược lại.
 */
export const MARKETER_EVIDENCE_ORDER: readonly MarketerEvidence[] = ["AD_CAMPAIGN", "FANPAGE_ASSIGNMENT"];

export const MARKETER_LINK_STATES = [
  "RESOLVED",
  "RESOLVED_BY_PAGE",
  "NO_CAMPAIGN",
  "CAMPAIGN_NO_MARKETER",
  "AMBIGUOUS",
  "PAGE_NO_ASSIGNMENT",
  "DUPLICATE_ORDER",
] as const;
export type MarketerLinkState = (typeof MARKETER_LINK_STATES)[number];

/** Hai tình trạng ghi được tên một người. Mọi tình trạng còn lại hiện dưới nhãn "Chưa xác định". */
export const MARKETER_RESOLVED_STATES: readonly MarketerLinkState[] = ["RESOLVED", "RESOLVED_BY_PAGE"];

export const MARKETER_LINK_LABEL: Record<MarketerLinkState, string> = {
  RESOLVED: "Quy kết được — theo chiến dịch quảng cáo",
  RESOLVED_BY_PAGE: "Quy kết được — theo fanpage phụ trách",
  NO_CAMPAIGN: "Không nối được về chiến dịch, cũng không có fanpage",
  CAMPAIGN_NO_MARKETER: "Chiến dịch chưa khai marketer phụ trách",
  AMBIGUOUS: "Chiến dịch có nhiều marketer — nhập nhằng",
  PAGE_NO_ASSIGNMENT: "Fanpage chưa gán marketer tại mốc đơn lên",
  DUPLICATE_ORDER: "Đơn bị nhập lại — cố ý không quy kết cho ai",
};

/** Việc phải làm để lấp từng loại chỗ trống. Một bảng chỉ in con số là bảng không ai mở lần thứ hai. */
export const MARKETER_LINK_FIX: Record<MarketerLinkState, string> = {
  RESOLVED: "",
  RESOLVED_BY_PAGE: "",
  NO_CAMPAIGN:
    "Đơn không có ad_id, không có post_id nối được về đúng một chiến dịch, và Pancake cũng không gửi page_id (đơn nhập tay, đơn landing, nguồn khác). Chạy đồng bộ Facebook (job facebook-ad-index) để bổ sung mối nối bài viết → chiến dịch.",
  CAMPAIGN_NO_MARKETER: "Chiến dịch đã nối được nhưng chưa ai khai người phụ trách. Khai ở Quảng cáo → Ghép chiến dịch với marketer.",
  AMBIGUOUS: "Cùng một chiến dịch đang mang hai marketer khác nhau trong bảng chi tiêu. Chọn một người ở Quảng cáo → Ghép chiến dịch, hoặc tách chiến dịch.",
  PAGE_NO_ASSIGNMENT:
    "Đơn có fanpage nhưng tại MỐC ĐƠN LÊN chưa ai được phân công page đó. Gán ở Marketing → Fanpage → Gán fanpage → marketer, và lùi mốc hiệu lực về ngày đơn đầu tiên của page.",
  DUPLICATE_ORDER:
    "Đơn này được kết luận là một lần đặt bị nhập lại, nên quy kết cố ý để trống (xem Marketing → Fanpage). Sai thì sửa ở đó, KHÔNG ép tên vào đây.",
};

/** Độ phủ quy kết — số và tỷ lệ, kèm tách theo lý do thiếu. `pct` là `null` khi không có đơn nào. */
export type MarketerCoverage = {
  total: number;
  resolved: number;
  pct: number | null;
  byState: Record<MarketerLinkState, number>;
  /** Phần quy kết được, vỡ theo LOẠI BẰNG CHỨNG. Cộng hai ô = `resolved`. */
  byEvidence: Record<MarketerEvidence, number>;
  /**
   * Số đơn mà CẢ HAI đường cùng lên tiếng nhưng nói HAI TÊN khác nhau.
   *
   * Phải in ra màn hình. Bằng 0 thì thứ tự thẩm quyền không đổi con số nào; khác 0 thì đây là
   * việc mang lên hỏi chủ shop — và cũng là lúc bảng lương (đang khai thứ tự ngược) nói khác
   * bảng này về cùng một đơn.
   */
  conflicts: number;
};

/**
 * NGƯỠNG CẢNH BÁO ĐỘ PHỦ. Dưới ngưỡng thì mọi con số theo marketer phải đi kèm cảnh báo: con số
 * đúng cho phần quy kết được, nhưng phần quy kết được có thể không đại diện cho toàn shop.
 *
 * 70% không phải con số đẹp: đó là mức mà nhóm "Chưa xác định" vẫn còn nhỏ hơn nhóm lớn nhất
 * trong ba marketer — trên mức đó, xếp hạng giữa các marketer còn có nghĩa.
 */
export const MARKETER_COVERAGE_WARN_PCT = 70;

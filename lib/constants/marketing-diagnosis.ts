import type { DepartmentCode } from "@/lib/constants/departments";

/**
 * ═══════════ NGƯỠNG LÊN TIẾNG CỦA MÁY PHÂN TÍCH MARKETING ═══════════
 *
 * ─── ĐÂY KHÔNG PHẢI NGƯỠNG NGHIỆP VỤ ───
 *
 * Không con số nào ở đây đụng tới một phép tính tiền. Chúng chỉ quyết định KHI NÀO ERP lên tiếng.
 * Ngưỡng ĐẠT / KHÔNG ĐẠT (CPA bao nhiêu là tốt, margin bao nhiêu là đủ) KHÔNG nằm ở đây và không
 * được phép nằm ở đây — chúng là quyết định kinh doanh, sống ở bảng `metric_targets` theo ba tầng
 * (công ty → phòng ban → chức danh), có người đặt và có lý do (AGENTS.md mục 38).
 *
 * Vì thế máy phân tích này chia làm hai loại phát hiện, và sự khác nhau ấy phải đọc được:
 *
 *   · SO VỚI CHÍNH MÌNH (`RELATIVE`) — "hôm nay tệ hơn hẳn 7 ngày qua". Không cần ai đặt đích,
 *     vì nền so sánh là dữ liệu của chính shop. Luôn chạy được.
 *   · SO VỚI ĐÍCH (`TARGET`) — "CPA vượt đích". Chỉ chạy khi chủ shop ĐÃ đặt đích. Chưa đặt thì
 *     KHÔNG kết luận, và màn hình nói rõ là chưa có đích chứ không im lặng.
 *
 * ─── THÀ BỎ SÓT CÒN HƠN BÁO BỪA ───
 *
 * Một hàng đợi đầy cảnh báo sai sẽ bị bỏ qua toàn bộ, kể cả cảnh báo đúng. Nên mọi quy tắc đều có
 * hai cửa: đủ MẪU (bao nhiêu tin nhắn / đơn / tiền) và đủ ĐỘ CHÍN (bao nhiêu đơn đã ngã ngũ).
 */

export const MARKETING_DIAGNOSIS = {
  /** Cửa sổ làm nền so sánh. 7 ngày phủ trọn một tuần nên không bị lệch vì cuối tuần. */
  baselineDays: 7,
  /** Dưới ngần này tin nhắn thì mọi tỷ lệ chốt chỉ là may rủi của vài cuộc. */
  minMessages: 30,
  /** Dưới ngần này đơn thì không kết luận về CPA / AOV / lợi nhuận. */
  minOrders: 5,
  /** Dưới ngần này tiền quảng cáo thì chênh lệch chỉ là dao động bật/tắt hằng ngày. */
  minSpend: 300_000,
  /** Dưới ngần này đơn ĐÃ KẾT THÚC thì tỷ lệ giao thành công dao động quá mạnh để nói gì. */
  minFinished: 10,

  /** Chi tăng từ mức này (so với nền) mới xét nhóm "chi tăng mà hàng không ra theo". */
  spendSurgePct: 40,
  /** ...và tin nhắn / doanh thu tăng dưới mức này thì đúng là tiền chảy ra mà hàng không ra. */
  outputLagPct: 10,
  /** Giá một tin nhắn đắt hơn nền từng này phần trăm ⇒ nghi creative mỏi. */
  costPerMessageUpPct: 35,
  /** Tỷ lệ chốt tụt từng này phần trăm TƯƠNG ĐỐI so với nền ⇒ vấn đề chốt đơn, không phải quảng cáo. */
  closeRateDropPct: 25,
  /** CPA đắt hơn nền từng này phần trăm ⇒ một đơn đang tốn nhiều tiền hơn hẳn. */
  cpaUpPct: 30,
  /** Giá trị đơn trung bình tụt từng này phần trăm ⇒ mix sản phẩm đổi hoặc bỏ bán kèm. */
  aovDropPct: 20,
  /** Tỷ lệ giao thành công tụt từng này ĐIỂM phần trăm ⇒ chất lượng đơn / logistics. */
  deliveryDropPoints: 12,
  /** Tỷ lệ hoàn tăng từng này ĐIỂM phần trăm ⇒ cảnh báo mã hàng / chất lượng đơn. */
  returnUpPoints: 12,
  /** Doanh thu thực tăng nhưng lợi nhuận góp tụt từng này phần trăm ⇒ chi phí chạy nhanh hơn doanh thu. */
  profitDropPct: 25,
  /** Số ngày lỗ liên tiếp trước khi leo thang. */
  consecutiveLossDays: 3,
  /** Chi tiêu từ mức này mà KHÔNG ra đơn nào ⇒ cảnh báo NÓNG, không chờ hết ngày. */
  spendNoOrderHot: 1_000_000,
} as const;

export const MARKETING_FINDING_KINDS = [
  "SPEND_UP_OUTPUT_FLAT",
  "CREATIVE_FATIGUE",
  "CLOSE_RATE_DROP",
  "CPA_UP",
  "AOV_DROP",
  "DELIVERY_DROP",
  "RETURN_UP",
  "COST_OUTRUNS_REVENUE",
  "LOSS_STREAK",
  "SPEND_NO_ORDERS",
  "DATA_STALE",
  "TARGET_MISS",
] as const;
export type MarketingFindingKind = (typeof MARKETING_FINDING_KINDS)[number];

export type FindingSeverity = "INFO" | "WARNING" | "CRITICAL";

/** Loại phát hiện: so với chính mình, hay so với một đích do người đặt. */
export type FindingBasis = "RELATIVE" | "TARGET" | "ABSOLUTE";

export const MARKETING_FINDING_LABEL: Record<MarketingFindingKind, string> = {
  SPEND_UP_OUTPUT_FLAT: "Chi tăng mạnh mà đầu ra không tăng theo",
  CREATIVE_FATIGUE: "Giá tin nhắn đắt lên — nghi creative mỏi",
  CLOSE_RATE_DROP: "Tỷ lệ chốt tụt",
  CPA_UP: "Chi phí một đơn đắt lên",
  AOV_DROP: "Giá trị đơn trung bình tụt",
  DELIVERY_DROP: "Tỷ lệ giao thành công tụt",
  RETURN_UP: "Tỷ lệ hoàn tăng",
  COST_OUTRUNS_REVENUE: "Doanh thu tăng nhưng lợi nhuận tụt",
  LOSS_STREAK: "Lỗ nhiều ngày liên tiếp",
  SPEND_NO_ORDERS: "Tiêu tiền mà không ra đơn",
  DATA_STALE: "Nguồn dữ liệu đứng im",
  TARGET_MISS: "Dưới đích đã đặt",
};

/**
 * ĐỀ XUẤT HÀNH ĐỘNG — mỗi câu nói một việc CÓ THỂ LÀM NGAY, kèm chỗ để làm.
 *
 * Cố ý KHÔNG có câu nào dạng "hãy tối ưu quảng cáo": một câu như thế không nói được ai phải mở
 * màn hình nào, nên nó chỉ làm dài thêm cảnh báo. Mỗi hành động dưới đây trỏ tới một khâu cụ thể
 * và một người cụ thể chịu trách nhiệm khâu đó.
 */
export const MARKETING_FINDING_ACTIONS: Record<MarketingFindingKind, string[]> = {
  SPEND_UP_OUTPUT_FLAT: [
    "Mở bóc tách theo chiến dịch của chính ngày này: chiến dịch nào ăn phần tiền tăng thêm.",
    "So CPM / CTR của chiến dịch đó với tuần trước — tiền đắt lên vì đấu giá hay vì creative kém.",
    "Nếu tiền tăng do một chiến dịch mới bật: hạ ngân sách về mức cũ và chạy lại 48 giờ trước khi kết luận.",
  ],
  CREATIVE_FATIGUE: [
    "Lọc các mẩu quảng cáo có CTR giảm mạnh nhất trong 7 ngày và tắt nhóm đuôi.",
    "Đưa vào 2–3 creative mới cùng thông điệp, giữ nguyên tệp và ngân sách để so được.",
    "Kiểm tra tần suất hiển thị (frequency): trên 2,5 là dấu hiệu tệp đã bão hoà.",
  ],
  CLOSE_RATE_DROP: [
    "Traffic vẫn về — vấn đề nằm ở khâu chốt. Nghe lại 10 hội thoại gần nhất chưa ra đơn.",
    "Đo thời gian phản hồi lần đầu trong ngày: chậm hơn 5 phút là mất đơn, không phải mất traffic.",
    "Rà kịch bản trả lời và bảng giá đang dùng — có mã nào vừa đổi giá hoặc hết size không.",
  ],
  CPA_UP: [
    "Kiểm tra CPM/CPC trước: bình thường ⇒ vấn đề ở chuyển đổi tin nhắn → đơn, không phải ở traffic.",
    "Bóc tách theo chiến dịch và cắt nhóm CPA cao nhất nếu đã đủ mẫu.",
    "So CPA với lãi gộp một đơn của chính mã đang chạy — dưới mức đó thì càng chạy càng lỗ.",
  ],
  AOV_DROP: [
    "Xem mix mã hàng của ngày: có phải đang đẩy mã giá thấp.",
    "Bật lại combo / bán kèm trên kịch bản chốt đơn.",
    "Kiểm tra chương trình giảm giá đang chạy — giảm sâu làm AOV tụt mà đơn không tăng tương ứng.",
  ],
  DELIVERY_DROP: [
    "Khả năng chất lượng đơn thấp: rà lại khâu xác nhận SĐT / địa chỉ / màu / size trước khi đẩy vận đơn.",
    "Mở hàng đợi vận đơn để xem tụt ở khâu nào: chưa lấy hàng, giao hỏng, hay khách từ chối.",
    "Đối chiếu với tệp khách rủi ro (đã hoàn nhiều lần) — nhóm này nên xin cọc.",
  ],
  RETURN_UP: [
    "Khoanh vùng theo MÃ HÀNG trước: một mã hỏng kéo cả ngày xuống.",
    "Đọc lý do hoàn của chính những kiện đó — sai size, sai màu, khách không nhận, hay chất lượng.",
    "Nếu lý do là sai mô tả: sửa nội dung quảng cáo trước khi tăng ngân sách trở lại.",
  ],
  COST_OUTRUNS_REVENUE: [
    "So ba tỷ lệ trên cùng dòng: QC/DT thực, giá vốn/DT, cước/DT — cái nào phình ra.",
    "Giá vốn phình ⇒ kiểm tra phiếu nhập gần nhất của mã đang bán.",
    "Cước phình ⇒ kiểm tra tỷ lệ hoàn: mỗi đơn hoàn gánh cả cước đi lẫn cước về.",
  ],
  LOSS_STREAK: [
    "Đây không còn là một ngày xấu. Dừng tăng ngân sách cho tới khi có ngày dương trở lại.",
    "Bóc tách theo mã hàng trên cả chuỗi ngày lỗ — thường là một mã kéo cả nhóm.",
    "Báo cho quản lý: cần quyết định cắt hay đổi mã, không phải chỉnh nhỏ.",
  ],
  SPEND_NO_ORDERS: [
    "Kiểm tra ngay luồng nhận tin: webhook Pancake còn về không, page còn nhận tin không.",
    "Kiểm tra mẩu quảng cáo có bị từ chối / tài khoản có bị hạn chế không.",
    "Nếu cả hai đều bình thường thì tắt chiến dịch và soi lại tệp — tiền đang chảy không đổi lấy gì.",
  ],
  DATA_STALE: [
    "Đừng đọc lợi nhuận của những ngày gần đây cho tới khi nguồn này đồng bộ lại.",
    "Chạy lại job đồng bộ tương ứng ở trang Kết nối dữ liệu.",
    "Nếu lỗi lặp lại: kiểm tra token / quyền của tài khoản tích hợp.",
  ],
  TARGET_MISS: [
    "Chỉ số này đang dưới đích do chủ shop đặt — xem lý do đặt đích để biết mức nào là chấp nhận được.",
    "Bóc tách để tìm phần kéo chỉ số xuống trước khi đổi đích.",
  ],
};

/**
 * ═══════════ PHÒNG BAN CHỊU TRÁCH NHIỆM — MỘT PHÁT HIỆN KHÔNG CÓ CHỦ LÀ MỘT PHÁT HIỆN KHÔNG AI LÀM ═══════════
 *
 * ─── VÌ SAO LÀ PHÒNG BAN, KHÔNG BAO GIỜ LÀ MỘT NGƯỜI ───
 *
 * AGENTS.md mục 22: máy không biết hôm nay ai nghỉ, và một việc mang tên người không làm được nó
 * sẽ biến mất khỏi hàng đợi phòng. Ở đây còn một lý do nữa: phần lớn phát hiện KHÔNG do người chạy
 * quảng cáo gây ra. "Tỷ lệ giao thành công tụt" gửi cho MKTer là gửi nhầm cửa — họ không điều được
 * bưu tá, và sau vài lần như vậy họ thôi đọc cả những phát hiện thật sự của mình.
 *
 * Bốn nhóm, và ranh giới giữa chúng chính là ranh giới của cái phễu:
 *
 *   MARKETING → tiền và traffic (chi, giá tin nhắn, CPA, creative)
 *   SALES     → tin nhắn đã về mà không thành đơn, hoặc thành đơn nhỏ hơn
 *   LOGISTICS → đơn đã chốt mà không tới tay khách
 *   MANAGEMENT→ quyết định cắt / đổi hướng, và những chỗ ERP tự biết mình đang mù
 */
export const MARKETING_FINDING_OWNER: Record<MarketingFindingKind, DepartmentCode> = {
  SPEND_UP_OUTPUT_FLAT: "MARKETING",
  CREATIVE_FATIGUE: "MARKETING",
  // Traffic VẪN VỀ — mất đơn ở khâu trả lời, không ở khâu quảng cáo.
  CLOSE_RATE_DROP: "SALES",
  CPA_UP: "MARKETING",
  // Giá trị đơn do mix mã hàng và kịch bản bán kèm quyết định, cả hai nằm ở khâu chốt đơn.
  AOV_DROP: "SALES",
  DELIVERY_DROP: "LOGISTICS",
  RETURN_UP: "LOGISTICS",
  COST_OUTRUNS_REVENUE: "MANAGEMENT",
  // Lỗ ba ngày liên tiếp là quyết định cắt hay đổi mã, không phải một lần chỉnh ngân sách.
  LOSS_STREAK: "MANAGEMENT",
  SPEND_NO_ORDERS: "MARKETING",
  // Nguồn đứng im là việc của người giữ tích hợp, không của người đọc báo cáo.
  DATA_STALE: "MANAGEMENT",
  TARGET_MISS: "MANAGEMENT",
};

/**
 * ═══════════ NGUYÊN NHÂN CÓ KHẢ NĂNG NHẤT — CÂU TRẢ LỜI CHO "VÌ SAO" ═══════════
 *
 * Bằng chứng nói CHUYỆN GÌ ĐÃ XẢY RA; câu ở đây nói NÓ THƯỜNG DO ĐÂU. Hai thứ tách nhau vì chúng
 * có độ chắc chắn khác hẳn: bằng chứng là số đo, còn đây là một giả thuyết xếp trước — và phải
 * đọc được là giả thuyết, nếu không người đọc sẽ hành động như thể nó đã được chứng minh.
 *
 * Mỗi câu phải PHÂN BIỆT được hai khả năng, vì đó là thứ quyết định ai đi làm gì: cùng một "CPA
 * tăng", nếu CPM tăng theo thì việc nằm ở đấu giá / creative, còn nếu CPM đứng yên thì việc nằm ở
 * khâu chốt đơn. Một câu không phân biệt được hai vế ấy thì không đáng in ra.
 */
export const MARKETING_FINDING_WHY: Record<MarketingFindingKind, string> = {
  SPEND_UP_OUTPUT_FLAT: "Thường là một chiến dịch mới bật ăn phần ngân sách tăng thêm mà chưa qua giai đoạn học, hoặc tệp đã bão hoà nên cùng số tiền mua được ít hiển thị hơn.",
  CREATIVE_FATIGUE: "Giá một tin nhắn đắt lên trong khi tệp không đổi thường là creative đã chạy quá lâu với cùng một nhóm người — tần suất hiển thị cao là dấu hiệu xác nhận.",
  CLOSE_RATE_DROP: "Traffic vẫn về nhưng ít đơn hơn ⇒ khả năng cao nằm ở khâu TRẢ LỜI chứ không ở quảng cáo: chậm phản hồi, kịch bản mới, hoặc mã đang bán hết size.",
  CPA_UP: "Nếu CPM/CPC gần như không đổi thì phần đắt lên đến từ chuyển đổi tin nhắn → đơn, tức khâu chốt; CPM tăng theo mới là chuyện của đấu giá và creative.",
  AOV_DROP: "Thường là mix mã hàng dịch sang mã giá thấp, hoặc kịch bản bán kèm / combo không còn được dùng.",
  DELIVERY_DROP: "Hai nguyên nhân hay gặp và tách được: chất lượng đơn đầu vào (SĐT, địa chỉ, khách không chắc mua) hoặc tuyến giao của ĐVVC. Bóc theo khu vực sẽ chỉ ra vế nào.",
  RETURN_UP: "Thường tập trung ở MỘT mã hàng chứ không rải đều — sai size, sai màu so với mô tả, hoặc chất lượng lô hàng mới nhập.",
  COST_OUTRUNS_REVENUE: "Doanh thu tăng mà lợi nhuận tụt nghĩa là một trong ba tỷ lệ đang phình: quảng cáo, giá vốn, hoặc cước và phí hoàn. Ba tỷ lệ ấy sửa ở ba chỗ khác nhau.",
  LOSS_STREAK: "Ba ngày lỗ liên tiếp không còn là dao động. Thường là một mã hàng kéo cả nhóm, hoặc giá bán không còn đỡ nổi CPA hiện tại.",
  SPEND_NO_ORDERS: "Tiền chạy mà không một đơn nào thường KHÔNG phải vấn đề quảng cáo: luồng nhận tin đứt (webhook, page) hay tài khoản bị hạn chế hay gặp hơn nhiều.",
  DATA_STALE: "Nguồn đứng im nghĩa là ERP đang thiếu một vế, không phải kết quả kinh doanh xấu đi. Đừng đọc lợi nhuận của những ngày này cho tới khi đồng bộ lại.",
  TARGET_MISS: "Chỉ số dưới mức chủ shop đã chốt. Trước khi đổi đích, bóc tách để biết phần nào kéo nó xuống — một chiều dữ liệu xấu có thể che cả nhóm còn lại đang tốt.",
};

export const MARKETING_FINDING_BASIS: Record<MarketingFindingKind, FindingBasis> = {
  SPEND_UP_OUTPUT_FLAT: "RELATIVE",
  CREATIVE_FATIGUE: "RELATIVE",
  CLOSE_RATE_DROP: "RELATIVE",
  CPA_UP: "RELATIVE",
  AOV_DROP: "RELATIVE",
  DELIVERY_DROP: "RELATIVE",
  RETURN_UP: "RELATIVE",
  COST_OUTRUNS_REVENUE: "RELATIVE",
  LOSS_STREAK: "ABSOLUTE",
  SPEND_NO_ORDERS: "ABSOLUTE",
  DATA_STALE: "ABSOLUTE",
  TARGET_MISS: "TARGET",
};

/**
 * ───────────── CHỐNG SPAM ─────────────
 *
 * Mỗi (loại · phạm vi · ngày) chỉ được nói MỘT LẦN. Khoá chống trùng mang luôn NGÀY để một vấn đề
 * kéo dài ba ngày vẫn là ba việc thật, chứ không phải một việc bị lặp.
 */
export function findingDedupeKey(kind: MarketingFindingKind, scope: string, day: string): string {
  return `mkt-daily:${kind}:${scope || "all"}:${day}`;
}

/** Số cảnh báo tối đa gửi đi trong một lượt — quá số này thì gửi bản tóm tắt, không gửi từng cái. */
export const MARKETING_ALERT_MAX_PER_RUN = 6;

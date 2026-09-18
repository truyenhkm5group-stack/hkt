import { CARE_ACTION_KINDS, type CareActionKind } from "@/lib/constants/delivery-tower";

/**
 * ═══════════ KẾT CỤC MỘT CA CHĂM SÓC — ĐỌC RA LÚC XEM, KHÔNG GHI VÀO CSDL ═══════════
 *
 * ─── VẤN ĐỀ ĐO ĐƯỢC TRÊN PRODUCTION 16/09/2026 ───
 *
 * `shipment_care.care_outcome` do `lib/care/lifecycle.ts::chotKetQua` ghi, và nó đọc DUY NHẤT chứng
 * từ ĐVVC: kiện cuối cùng `DELIVERED` ⇒ `RESCUED_DIRECT` ("Cứu được"). Nó KHÔNG hề hỏi câu quan
 * trọng nhất — **có ai của shop làm gì không?**
 *
 * Đếm trên 319 đợt care thật:
 *
 *   care_outcome      đợt   có hành động người   có sự kiện người
 *   RESCUED_DIRECT     44           17                  22
 *   RESCUE_FAILED      29           13                  15
 *   PENDING           103           13                  17
 *   (chưa gán)        145           27                  37
 *
 * Nghĩa là **22–27 trong 44 ca mang nhãn "Cứu được" là ĐVVC tự phục hồi**: kiện đi
 * `Chờ phát lại → Đang giao → Giao thành công` mà không ai gọi một cuộc nào. Gọi đó là công của
 * đội chăm sóc là chấm điểm sai — và chấm SAI THEO HƯỚNG CÓ LỢI, thứ không ai đi kiểm lại.
 *
 * ─── VÌ SAO ĐỌC RA LÚC XEM CHỨ KHÔNG GHI THÊM CỘT ───
 *
 * Ba lý do, và lý do thứ ba là lý do thật:
 *
 *  1. `care_outcome` đã có 174 dòng dữ liệu thật và một ràng buộc `CHECK`. Đổi danh sách giá trị là
 *     làm mồ côi lịch sử.
 *  2. Ghi thêm một cột "có người chăm không" nghĩa là phải BACKFILL nó cho 319 dòng cũ — tức đoán,
 *     đúng thứ mục 35 cấm.
 *  3. **Câu trả lời đổi khi dữ liệu đổi.** Một ca hôm nay chưa có hành động người, ngày mai nhân
 *     viên ghi nhận cuộc gọi đã thực hiện, thì kết cục phải đổi theo. Một cột ghi cứng sẽ giữ mãi
 *     câu trả lời của lần chạy đầu tiên.
 *
 * Nên mọi thứ dưới đây là HÀM THUẦN, và `care_outcome` giữ nguyên vai trò của nó: **chứng từ ĐVVC
 * nói kiện kết thúc thế nào**. Lớp này chỉ trả lời thêm: *ai đã làm gì trước khi điều đó xảy ra.*
 */

/**
 * ─── HÀNH ĐỘNG NÀO LÀ "NGƯỜI THẬT SỰ CHĂM" ───
 *
 * Toàn bộ `CARE_ACTION_KINDS` đều do NGƯỜI ghi — theo chính đặc tả của bảng đó: *"KHÔNG có loại nào
 * tự chạy. ERP ghi lại việc NGƯỜI đã làm; nó không tự nhắn khách."* Nên một dòng `care_actions` là
 * bằng chứng chăm sóc không cần bàn thêm.
 *
 * `OTHER` VẪN TÍNH: nó là ô ghi chú tự do mà nhân viên dùng khi việc họ làm không rơi vào bảy loại
 * kia. Loại nó ra là phạt người đã làm việc chỉ vì việc đó không có sẵn một cái nút.
 */
export const HUMAN_CARE_ACTION_KINDS: readonly CareActionKind[] = CARE_ACTION_KINDS;

/**
 * ─── SỰ KIỆN CA NÀO KHÔNG ĐƯỢC TÍNH LÀ "CHẠM VÀO" ───
 *
 * `source = 'SYSTEM'` bị loại vì đó là máy. Và `ASSIGN` bị loại **kể cả khi do người bấm**: giao
 * việc cho người khác không phải là chăm sóc kiện hàng — nó là điều phối. Tính nó thì một trưởng
 * nhóm bấm giao 50 ca trong ba phút sẽ làm 50 ca trông như đã được xử lý.
 *
 * Đây là lựa chọn THIÊN VỀ PHÍA HẸP: thà đếm thiếu một lần chạm thật còn hơn đếm thừa một lần
 * không có thật, vì con số này dùng để nói "đội có làm gì không".
 */
export const NON_TOUCH_EVENT_ACTIONS = ["ASSIGN"] as const;

/**
 * ═══════════ MƯỜI KẾT CỤC, VÀ HAI CẶP PHẢI ĐỨNG RIÊNG ═══════════
 *
 * Hai cặp quan trọng nhất là `*_AFTER_CARE` và `*_WITHOUT_MANUAL_CARE`. Thiếu vế thứ hai thì mọi
 * kiện giao được đều trông như công của đội, và mọi kiện hoàn đều trông như đội đã cố mà không nổi.
 */
export const CASE_OUTCOMES = [
  "DELIVERED_AFTER_CARE",
  "REDELIVERED_AFTER_CARE",
  "DELIVERED_WITHOUT_MANUAL_CARE",
  "RETURNED_AFTER_CARE",
  "RETURNED_WITHOUT_MANUAL_CARE",
  "CUSTOMER_REFUSED",
  "CUSTOMER_UNREACHABLE",
  "NO_CHANGE",
  "UNRESOLVED",
  "OTHER",
] as const;
export type CaseOutcome = (typeof CASE_OUTCOMES)[number];

export const CASE_OUTCOME_LABEL: Record<CaseOutcome, string> = {
  DELIVERED_AFTER_CARE: "Giao được SAU khi có người chăm",
  REDELIVERED_AFTER_CARE: "Giao được sau khi người YÊU CẦU PHÁT LẠI",
  DELIVERED_WITHOUT_MANUAL_CARE: "Giao được mà KHÔNG ai chăm",
  RETURNED_AFTER_CARE: "Hoàn dù đã có người chăm",
  RETURNED_WITHOUT_MANUAL_CARE: "Hoàn, KHÔNG ai chăm",
  CUSTOMER_REFUSED: "Khách xác nhận không lấy",
  CUSTOMER_UNREACHABLE: "Gọi nhưng không liên lạc được",
  NO_CHANGE: "Không phải điều kiện cần care",
  UNRESOLVED: "Chưa có kết quả cuối",
  OTHER: "Khác",
};

export const CASE_OUTCOME_HINT: Record<CaseOutcome, string> = {
  DELIVERED_AFTER_CARE:
    "Có ÍT NHẤT MỘT hành động chăm sóc của người TRƯỚC khi chứng từ ĐVVC chốt giao thành công. Đây là thứ gần nhất với “đội cứu được đơn” mà dữ liệu chứng minh được — vẫn là QUAN SÁT, không phải nhân quả.",
  REDELIVERED_AFTER_CARE: "Người đã gửi yêu cầu phát lại sang ĐVVC, và sau đó kiện giao thành công. Cụ thể hơn “có người chăm”, nên đứng riêng.",
  DELIVERED_WITHOUT_MANUAL_CARE:
    "ĐVVC TỰ phục hồi: kiện đi Chờ phát lại → Đang giao → Giao thành công mà không ai của shop làm gì. Đo 16/09/2026: 22–27 trong 44 ca từng mang nhãn “Cứu được” thuộc nhóm này.",
  RETURNED_AFTER_CARE: "Đội đã làm việc nhưng kiện vẫn quay đầu. KHÔNG phải lỗi của người chăm — nhiều kiện không cứu được bằng bất kỳ cuộc gọi nào.",
  RETURNED_WITHOUT_MANUAL_CARE: "Kiện hoàn mà không ai chạm vào. Đây là nhóm đáng hỏi nhất: có phải vì không kịp, hay vì không ai thấy?",
  CUSTOMER_REFUSED: "Có ghi nhận “Khách xác nhận không lấy”. Lý do dứt khoát, nên nó thắng mọi nhãn kết cục khác.",
  CUSTOMER_UNREACHABLE: "Chỉ có các lần gọi KHÔNG bắt máy, chưa lần nào nói chuyện được. Vấn đề nằm ở số điện thoại, không nằm ở kịch bản chăm sóc.",
  NO_CHANGE: "Máy mở ca rồi tự đóng vì kiện chưa bao giờ ở điều kiện cần care (mã 102 trước mốc lấy hàng). KHÔNG vào bất kỳ tỷ lệ nào.",
  UNRESOLVED: "Kiện chưa tới đích và cũng chưa quay đầu. CHƯA BIẾT — nằm ngoài cả tử số lẫn mẫu số.",
  OTHER: "Không rơi vào nhóm nào ở trên. Nếu nhóm này lớn lên thì bảng phân loại đang thiếu một trường hợp thật.",
};

/** Kết cục đã NGÃ NGŨ — chỉ những cái này mới vào mẫu số của bất kỳ tỷ lệ nào. */
export const CASE_OUTCOME_IS_FINAL: Record<CaseOutcome, boolean> = {
  DELIVERED_AFTER_CARE: true,
  REDELIVERED_AFTER_CARE: true,
  DELIVERED_WITHOUT_MANUAL_CARE: true,
  RETURNED_AFTER_CARE: true,
  RETURNED_WITHOUT_MANUAL_CARE: true,
  CUSTOMER_REFUSED: true,
  CUSTOMER_UNREACHABLE: true,
  NO_CHANGE: false,
  UNRESOLVED: false,
  OTHER: false,
};

/** Kết cục có CÔNG của người — cố ý KHÔNG gồm `DELIVERED_WITHOUT_MANUAL_CARE`. */
export const CASE_OUTCOME_HAS_HUMAN_CREDIT: Record<CaseOutcome, boolean> = {
  DELIVERED_AFTER_CARE: true,
  REDELIVERED_AFTER_CARE: true,
  DELIVERED_WITHOUT_MANUAL_CARE: false,
  RETURNED_AFTER_CARE: true,
  RETURNED_WITHOUT_MANUAL_CARE: false,
  CUSTOMER_REFUSED: true,
  CUSTOMER_UNREACHABLE: true,
  NO_CHANGE: false,
  UNRESOLVED: false,
  OTHER: false,
};

export type CaseFacts = {
  /** `care_outcome` đang lưu — chứng từ ĐVVC nói kiện kết thúc thế nào. `null` = chưa chốt. */
  storedOutcome: string | null;
  /** `resolution` — quyết định của shop. `NOT_CARE_CONDITION` nghĩa là ca chưa bao giờ là việc. */
  resolution: string | null;
  /** Có ÍT NHẤT MỘT dòng `care_actions` trong khoảng từ lúc mở ca tới lúc chốt kết quả. */
  humanActionBeforeOutcome: boolean;
  /** Các loại hành động đã ghi nhận trong khoảng đó — quyết định `CUSTOMER_REFUSED` / `UNREACHABLE`. */
  actionKinds: readonly string[];
  /** Người đã gửi lệnh PHÁT LẠI sang ĐVVC (không phải máy). */
  humanRequestedRedelivery: boolean;
};

/**
 * ═══════════ THỨ TỰ XÉT — CỤ THỂ TRƯỚC, CHUNG CHUNG SAU ═══════════
 *
 * Thứ tự ở đây là một QUYẾT ĐỊNH, không phải chuyện ngẫu nhiên, nên nó được viết ra:
 *
 *  1. `NO_CHANGE` đứng đầu tuyệt đối. Ca máy mở rồi tự đóng vì chưa bao giờ là điều kiện cần care
 *     thì KHÔNG được vào bất kỳ tỷ lệ nào — kể cả khi tình cờ có ai đó ghi một dòng ghi chú.
 *  2. Kiện GIAO ĐƯỢC xét trước kiện HOÀN, vì "đã tới tay khách" là sự thật mạnh nhất về gói hàng.
 *  3. Trong nhánh HOÀN, LÝ DO thắng KẾT QUẢ: "khách xác nhận không lấy" nói được điều mà
 *     "hoàn dù đã chăm" không nói. Biết lý do thì sửa được; biết kết quả thì chỉ đếm được.
 *  4. `CUSTOMER_UNREACHABLE` chỉ khi TOÀN BỘ lần tiếp xúc đều là gọi-không-bắt-máy. Có một lần nói
 *     chuyện được là đã liên lạc được, dù kết quả cuối vẫn hoàn.
 *
 * Hàm THUẦN: chạy hai lần ra cùng kết quả, không đọc CSDL, kiểm thử được mà không cần máy chủ.
 */
export function deriveCaseOutcome(f: CaseFacts): CaseOutcome {
  if (f.resolution === "NOT_CARE_CONDITION") return "NO_CHANGE";

  const delivered = f.storedOutcome === "RESCUED_DIRECT" || f.storedOutcome === "RESCUED_EXCHANGE";
  const failed = f.storedOutcome === "RESCUE_FAILED";

  if (delivered) {
    if (f.humanRequestedRedelivery) return "REDELIVERED_AFTER_CARE";
    return f.humanActionBeforeOutcome ? "DELIVERED_AFTER_CARE" : "DELIVERED_WITHOUT_MANUAL_CARE";
  }

  if (failed) {
    if (f.actionKinds.includes("CUSTOMER_REFUSED")) return "CUSTOMER_REFUSED";
    // Gọi mà chưa lần nào nói chuyện được: vấn đề ở SỐ ĐIỆN THOẠI, không ở kịch bản chăm sóc.
    const coGoiHut = f.actionKinds.includes("CALLED_NO_ANSWER");
    const coTiepXuc = f.actionKinds.some((k) => k !== "CALLED_NO_ANSWER");
    if (coGoiHut && !coTiepXuc) return "CUSTOMER_UNREACHABLE";
    return f.humanActionBeforeOutcome ? "RETURNED_AFTER_CARE" : "RETURNED_WITHOUT_MANUAL_CARE";
  }

  // `PENDING`, `UNATTRIBUTED`, và `NULL` đều là CHƯA NGÃ NGŨ — không đoán thêm.
  if (f.storedOutcome === null || f.storedOutcome === "PENDING" || f.storedOutcome === "UNATTRIBUTED") return "UNRESOLVED";
  return "OTHER";
}

/**
 * ═══════════ KỲ BÁO CÁO LỌC THEO MỐC NÀO ═══════════
 *
 * "7 ngày gần đây" KHÔNG phải một câu hỏi đầy đủ: bảy ngày của ca MỞ RA và bảy ngày của ca CHỐT
 * KẾT QUẢ là hai tập ca khác nhau, và hai con số khác nhau. Một ca mở ngày 1 chốt ngày 20 thuộc kỳ
 * nào? Câu trả lời tuỳ vào việc đang hỏi "đội nhận bao nhiêu việc" hay "đội xong được bao nhiêu".
 *
 * Nên mỗi báo cáo phải KHAI mốc nó lọc theo, và màn hình phải in ra.
 */
export const PERIOD_BASES = ["CASE_OPENED_AT", "CASE_RESOLVED_AT"] as const;
export type PeriodBasis = (typeof PERIOD_BASES)[number];

export const PERIOD_BASIS_LABEL: Record<PeriodBasis, string> = {
  CASE_OPENED_AT: "theo NGÀY MỞ ca",
  CASE_RESOLVED_AT: "theo NGÀY CHỐT kết quả",
};

export const PERIOD_BASIS_HINT: Record<PeriodBasis, string> = {
  CASE_OPENED_AT:
    "Lọc theo lúc ca được mở. Trả lời “kỳ này đội nhận bao nhiêu việc”. Ca mở cuối kỳ có thể chưa chốt, nên tỷ lệ kết cục đọc theo mốc này sẽ thấp giả tạo.",
  CASE_RESOLVED_AT:
    "Lọc theo lúc chứng từ ĐVVC chốt kết quả. Trả lời “kỳ này đội xong được bao nhiêu”. Ca chốt trong kỳ có thể đã mở từ kỳ trước, nên khối lượng việc đọc theo mốc này KHÔNG bằng số ca mở.",
};

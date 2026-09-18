/**
 * ═══════════ HÀNG ĐỢI "VTP CẦN ĐỐI CHIẾU" ═══════════
 *
 * ─── VÌ SAO PHẢI CÓ MỘT HÀNG ĐỢI RIÊNG ───
 *
 * 2.138/2.151 vận đơn là `WEBHOOK_ONLY` (đo 16/09/2026): tài khoản API không đọc được chúng, nên
 * webhook là nguồn tin DUY NHẤT và ERP KHÔNG có cách tự vá khi webhook rơi. Cách duy nhất là một
 * CON NGƯỜI mở viettelpost.vn tra lại — hoặc tải tệp về nhập.
 *
 * Nhưng "một con người phải đi tra" chỉ thành việc khi có một danh sách nói rõ TRA CÁI GÌ VÀ VÌ
 * SAO. Trước bản này các dấu hiệu ấy nằm rải rác: cờ `vtp_raw_mapped` ở một truy vấn, `vtp_last_error`
 * ở một truy vấn khác, độ tươi ở tháp giao vận, khoảng hụt webhook ở sổ riêng. Không màn hình nào
 * cộng chúng lại, nên không ai từng nhìn thấy "hôm nay có bao nhiêu kiện ERP đang nói sai".
 *
 * ─── ĐÂY KHÔNG PHẢI HÀNG ĐỢI CARE ───
 *
 * Care hỏi "kiện này có cần gọi khách không". Hàng đợi này hỏi một câu khác hẳn: "ERP có đang tin
 * một điều không còn đúng không". Một kiện giao thành công từ hôm qua KHÔNG cần care, nhưng nếu
 * ERP vẫn ghi "đang vận chuyển" thì nó cần đối chiếu. Gộp hai thứ vào một hàng đợi là làm hỏng cả
 * hai bộ số đo hiệu quả.
 *
 * ─── VÀ NÓ KHÔNG SINH RA MỘT LƯỢT GỌI API NÀO ───
 *
 * Toàn bộ hàng đợi dựng từ dữ liệu ĐÃ CÓ trong CSDL. Nó không hỏi Viettel Post một câu nào — đúng
 * ra là ngược lại: nó tồn tại CHÍNH VÌ ERP không hỏi được.
 */

export const RECONCILE_REASONS = [
  "SYNC_ERROR",
  "UNMAPPED_STATUS",
  "WEBHOOK_GAP",
  "CONTRADICTION",
  "CARE_WITHOUT_MOVEMENT",
  "STALE_NO_NEWS",
] as const;
export type ReconcileReason = (typeof RECONCILE_REASONS)[number];

export const RECONCILE_REASON_LABEL: Record<ReconcileReason, string> = {
  SYNC_ERROR: "Lỗi đối chiếu",
  UNMAPPED_STATUS: "ĐVVC nói câu ERP chưa dịch được",
  WEBHOOK_GAP: "Webhook đã rơi gói tin",
  CONTRADICTION: "Dữ liệu tự mâu thuẫn",
  CARE_WITHOUT_MOVEMENT: "Đội đang care mà ĐVVC không nhúc nhích",
  STALE_NO_NEWS: "Im lặng quá ngưỡng của chặng",
};

/** Câu nói NGƯỜI TRỰC PHẢI LÀM GÌ — một hàng đợi chỉ in lý do là hàng đợi không ai mở lần thứ hai. */
export const RECONCILE_REASON_FIX: Record<ReconcileReason, string> = {
  SYNC_ERROR: "Lượt hỏi lại gần nhất lỗi. Xem câu lỗi ở cột bên; nếu là lỗi mạng thì ERP tự lùi dần và thử lại, nếu là lỗi quyền thì phải sửa tài khoản API.",
  UNMAPPED_STATUS: "Viettel Post gửi một trạng thái ERP chưa có trong bảng mã. Chữ gốc vẫn được giữ nguyên; bổ sung mã vào `VTP_STATUS` rồi nhập lại là kiện tự xếp đúng.",
  WEBHOOK_GAP: "Lần nhập tệp gần đây phát hiện ERP đi sau ĐVVC ở kiện này. Trạng thái đã được vá bằng tệp — việc còn lại là xem có kiện nào khác cùng đợt bị rơi mà chưa nhập tệp không.",
  CONTRADICTION: "ERP đang giữ hai điều không thể cùng đúng (ví dụ: cờ 'đã kết thúc' bật nhưng chặng vẫn đang chạy). Phải tra tay trên viettelpost.vn rồi nhập tệp đè lại.",
  CARE_WITHOUT_MOVEMENT: "Đội đã mở ca chăm sóc nhưng từ đó tới nay ĐVVC không gửi thêm mốc nào. Hoặc ĐVVC thật sự đứng im (phải giục bưu cục), hoặc webhook đang rơi cho kiện này.",
  STALE_NO_NEWS: "Kiện im lặng lâu hơn ngưỡng của chặng nó đang đứng. Với kiện chỉ nhận webhook thì im lặng KHÔNG chứng minh được là không có gì xảy ra — phải tra lại.",
};

/**
 * MỨC ƯU TIÊN THEO ĐỘ CHẮC CHẮN CỦA BẰNG CHỨNG, không theo độ ồn.
 *
 * Số nhỏ đứng trước. `SYNC_ERROR` và `UNMAPPED_STATUS` là những thứ ERP BIẾT CHẮC nó đang không
 * hiểu — sửa được và sửa xong thì hết hẳn. `STALE_NO_NEWS` đứng cuối vì im lặng là bằng chứng YẾU
 * NHẤT: phần lớn kiện im lặng thật sự không có gì xảy ra, và để nó lên đầu sẽ chôn năm loại trên
 * dưới hàng trăm dòng không đáng làm.
 */
export const RECONCILE_REASON_RANK: Record<ReconcileReason, number> = {
  SYNC_ERROR: 1,
  UNMAPPED_STATUS: 2,
  CONTRADICTION: 3,
  WEBHOOK_GAP: 4,
  CARE_WITHOUT_MOVEMENT: 5,
  STALE_NO_NEWS: 6,
};

export const RECONCILE_REASON_TONE: Record<ReconcileReason, string> = {
  SYNC_ERROR: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  UNMAPPED_STATUS: "bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-300",
  CONTRADICTION: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  WEBHOOK_GAP: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  CARE_WITHOUT_MOVEMENT: "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300",
  STALE_NO_NEWS: "bg-muted text-muted-foreground",
};

/**
 * BAO LÂU THÌ MỘT KHOẢNG HỤT ĐÃ PHÁT HIỆN THÔI LÀ VIỆC.
 *
 * Khoảng hụt là chuyện ĐÃ XẢY RA và đã được tệp vá xong; giữ nó mãi trong hàng đợi là biến một sự
 * việc thành một dòng vĩnh viễn. Bảy ngày đủ để người trực thấy cụm rơi gần nhất, và sổ
 * `vtp_webhook_gaps` vẫn giữ toàn bộ lịch sử để tính tỷ lệ.
 */
export const GAP_QUEUE_DAYS = 7;

/**
 * CARE MỞ BAO LÂU MÀ ĐVVC IM THÌ THÀNH VIỆC ĐỐI CHIẾU.
 *
 * 24 giờ: dưới mức đó thì "chưa có mốc mới" là chuyện bình thường của mọi kiện đang chạy tuyến, và
 * đưa vào đây chỉ làm hàng đợi phồng lên bằng chính số ca care đang mở.
 */
export const CARE_SILENCE_HOURS = 24;

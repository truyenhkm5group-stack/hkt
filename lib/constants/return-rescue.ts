/**
 * ═══════════ "TỶ LỆ CỨU ĐƠN" — CHỈ SỐ DỄ BỊA NHẤT CỦA CẢ BÁO CÁO ═══════════
 *
 * Cám dỗ: lấy `số đơn giao thành công có lý do X ÷ số đơn có lý do X` rồi gọi đó là tỷ lệ cứu.
 * Sai, vì nó trả lời một câu hỏi KHÁC. Một đơn có thể giao thành công mà chẳng ai cứu cả — nó
 * chưa bao giờ gặp nguy cơ hoàn. Đếm nó vào tử số là ghi công cho một việc không ai làm.
 *
 * ─── ĐỊNH NGHĨA CANONICAL ───
 *
 * Một ca được tính là ĐÃ CỨU khi có ĐỦ BA điều, nối với nhau bằng khoá chứ không bằng suy đoán:
 *
 *   1. NGUY CƠ   — ca đã từng rơi vào trạng thái có nguy cơ hoàn (phát hỏng, tồn, chờ phát lại)
 *                  hoặc đã được mở một ca care mang lý do hoàn.
 *   2. CAN THIỆP — có một thao tác của NGƯỜI giữa mốc nguy cơ và mốc kết quả cuối.
 *   3. KẾT QUẢ   — kết quả cuối của chính vận đơn/đơn đó là GIAO THÀNH CÔNG.
 *
 * Thiếu (2) thì kiện tự giao được ở lần thử sau, không ai cứu. Thiếu liên kết xác định giữa (1)
 * và (3) thì không chứng minh được đây là cùng một ca.
 *
 * ─── VÀ ĐÂY LÀ PHẦN QUAN TRỌNG NHẤT ───
 *
 * Nếu ERP chưa ghi được (2) — chưa có thao tác nào của người trên ca hoàn — thì tỷ lệ cứu đơn
 * KHÔNG PHẢI 0%. Nó là CHƯA ĐO ĐƯỢC.
 *
 * Hai con số đó dẫn tới hai kết luận trái ngược: "0%" nói đội chăm sóc làm việc mà không cứu được
 * ca nào; "chưa đo được" nói ERP chưa ghi lại việc họ làm. In nhầm cái thứ nhất là vu oan cho một
 * đội ngũ bằng một lỗ hổng dữ liệu.
 *
 * Bảng Excel của shop cũng đang để cột này bằng 0 ở MỌI dòng — dấu hiệu rõ ràng rằng ở đó nó cũng
 * chưa được theo dõi, chứ không phải shop chưa cứu được đơn nào trong 454 ca.
 */
export type RescueCoverage = {
  /** Số ca ĐỦ ĐIỀU KIỆN xét cứu: đã từng có nguy cơ hoàn trong phạm vi lọc. */
  eligible: number;
  /** Trong đó, số ca có ít nhất một thao tác của NGƯỜI được ghi lại. */
  withIntervention: number;
  /** Số ca đã cứu được: có nguy cơ · có can thiệp · kết quả cuối là giao thành công. */
  rescued: number;
};

export type RescueRate = { value: number | null; state: "MEASURED" | "NOT_TRACKED" | "NO_CASES" };

export const RESCUE_STATE_LABEL: Record<RescueRate["state"], string> = {
  MEASURED: "Đo được",
  NOT_TRACKED: "Chưa theo dõi được",
  NO_CASES: "Không có ca nào",
};

/**
 * TỶ LỆ CỨU ĐƠN, hoặc lý do không tính được.
 *
 * Ba lối ra, và chỉ một trong ba là một con số:
 *   · không có ca nào có nguy cơ   → `NO_CASES`     (không phải 0%)
 *   · có ca nhưng KHÔNG ca nào được ghi thao tác người → `NOT_TRACKED` (không phải 0%)
 *   · có ca và có thao tác được ghi → tỷ lệ thật
 */
export function rescueRate(c: RescueCoverage): RescueRate {
  if (c.eligible <= 0) return { value: null, state: "NO_CASES" };
  /*
    KHÔNG một ca nào có thao tác người được ghi ⇒ đường ống theo dõi chưa chạy, không phải đội
    chăm sóc thất bại. Kể cả khi có ca kết thúc giao thành công: không có bằng chứng ai đã làm gì
    thì không quy được công cho ai.
  */
  if (c.withIntervention <= 0) return { value: null, state: "NOT_TRACKED" };
  return { value: Math.round((c.rescued / c.eligible) * 1000) / 10, state: "MEASURED" };
}

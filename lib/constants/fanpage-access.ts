/**
 * ═══════════ FANPAGE CÒN ĐỌC ĐƯỢC TÊN HAY KHÔNG — VÀ VÌ SAO NÓ KHÔNG LIÊN QUAN TỚI QUY KẾT ═══════════
 *
 * Quy kết đi bằng `page_id`, và `page_id` nằm sẵn trên từng đơn Pancake gửi về. Việc token hiện tại
 * còn đọc được TÊN page hay không là một câu hỏi HOÀN TOÀN KHÁC — nó chỉ quyết định màn hình hiện
 * "Linh Tây Luxury" hay hiện một dãy 15 chữ số.
 *
 * Trộn hai thứ đó là cách một fanpage lịch sử trở thành không quản lý được: đo trên production
 * 15/09/2026, 7/15 fanpage có `name` rỗng vì không nằm trong 20 page token đọc được, và 129 đơn
 * treo ở đó chỉ vì màn hình không hiện nổi một cái tên để người khai nhận ra page nào.
 *
 * ─── TRẠNG THÁI SUY RA, KHÔNG LƯU ───
 *
 * So `last_seen_in_api_at` của page với mốc LỚN NHẤT của cả bảng:
 *
 *   · bằng mốc lớn nhất  ⇒ `ACTIVE`      — có mặt trong lần liệt kê gần nhất;
 *   · nhỏ hơn / `NULL`   ⇒ `HISTORICAL`  — token hiện tại không còn đọc được page này;
 *   · cả bảng đều `NULL` ⇒ `UNKNOWN`     — API chưa bao giờ gọi được, KHÔNG kết luận gì.
 *
 * Nhánh thứ ba là chỗ dễ sai nhất và là lý do trạng thái được SUY RA chứ không lưu: hôm API lỗi
 * (Pancake trả 502 — đã xảy ra ngày 15/09), không dòng nào được cập nhật, nên mốc lớn nhất đứng
 * yên và KHÔNG page nào bị kết luận nhầm là mất quyền. Nếu lưu trạng thái, đúng hôm ấy cả 15 page
 * sẽ bị ghi "mất quyền" và không có gì sửa lại được.
 */

export const FANPAGE_ACCESS_STATUSES = ["ACTIVE", "HISTORICAL", "UNKNOWN"] as const;
export type FanpageAccessStatus = (typeof FANPAGE_ACCESS_STATUSES)[number];

export const FANPAGE_ACCESS_LABEL: Record<FanpageAccessStatus, string> = {
  ACTIVE: "Còn quyền truy cập",
  HISTORICAL: "Không còn quyền truy cập · lịch sử",
  UNKNOWN: "Chưa xác định",
};

export const FANPAGE_ACCESS_HINT: Record<FanpageAccessStatus, string> = {
  ACTIVE: "Page có mặt trong lần Pancake liệt kê gần nhất — tên do API cập nhật.",
  HISTORICAL: "Token Pancake hiện tại không còn đọc được page này. Đơn cũ vẫn quy kết bình thường bằng Page ID; chỉ cần đặt tên gợi nhớ để người khai nhận ra.",
  UNKNOWN: "Chưa lần nào đọc được danh sách page từ Pancake, nên KHÔNG kết luận page còn quyền hay không.",
};

export const FANPAGE_ACCESS_TONE: Record<FanpageAccessStatus, string> = {
  ACTIVE: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  HISTORICAL: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  UNKNOWN: "bg-muted text-muted-foreground",
};

/**
 * Trạng thái truy cập của MỘT page, suy từ hai mốc. Hàm thuần.
 *
 * `newestSeenAt` là mốc lớn nhất của CẢ BẢNG — nơi gọi tính một lần rồi truyền vào, để 15 page
 * không thành 15 lượt quét bảng.
 */
export function fanpageAccessStatus(lastSeenAt: Date | null, newestSeenAt: Date | null): FanpageAccessStatus {
  if (!newestSeenAt) return "UNKNOWN";
  if (!lastSeenAt) return "HISTORICAL";
  return lastSeenAt.getTime() >= newestSeenAt.getTime() ? "ACTIVE" : "HISTORICAL";
}

/**
 * TÊN HIỂN THỊ — tên NGƯỜI đặt thắng tên API, và cuối cùng mới tới Page ID.
 *
 * Thứ tự này có chủ đích: người đặt alias vì API không đọc được tên, nên nếu API thắng thì ngày
 * lấy lại quyền, cái tên họ chọn biến mất mà không ai hiểu vì sao.
 */
export function fanpageDisplayName(page: { alias?: string | null; name?: string | null; externalPageId: string }): string {
  const alias = (page.alias ?? "").trim();
  if (alias) return alias;
  const name = (page.name ?? "").trim();
  if (name) return name;
  return page.externalPageId;
}

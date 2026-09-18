/**
 * ═══════════ TỪ VỰNG CỦA MÀN HÌNH XEM TRƯỚC KHI NHẬP TỆP VIETTEL POST ═══════════
 *
 * Tách khỏi `lib/integrations/viettelpost/import-preview.ts` vì tệp đó chạm `node:crypto` và CSDL:
 * kéo nó vào một client component là kéo cả trình đọc Excel và drizzle sang trình duyệt.
 * `tests/client-boundary-exports.test.ts` khoá ranh giới này ở mức mã nguồn.
 *
 * Chín phán quyết, và bốn trong số đó KHÔNG phải lỗi:
 *  · `SAME` / `DUPLICATE_ROW` — tệp nói đúng thứ ERP đang giữ;
 *  · `OLDER` — tệp mang chứng từ CŨ HƠN. ERP cố ý không hạ trạng thái (luật đã có từ trước);
 *  · `UNKNOWN_STATUS` — ERP chưa dịch được câu của ĐVVC. Chữ gốc vẫn vào sổ, không bị ném đi.
 * Gộp chúng vào một nhãn "bỏ qua" là mời người dùng đọc một sự cố thành chuyện bình thường, hoặc
 * ngược lại.
 */
export const PREVIEW_VERDICTS = ["SAME", "NEWER", "OLDER", "STATUS_CONFLICT", "UNMATCHED", "UNKNOWN_STATUS", "AMBIGUOUS", "INVALID", "DUPLICATE_ROW"] as const;
export type PreviewVerdict = (typeof PREVIEW_VERDICTS)[number];

export const PREVIEW_VERDICT_LABEL: Record<PreviewVerdict, string> = {
  SAME: "Giống ERP",
  NEWER: "Mới hơn ERP",
  OLDER: "Cũ hơn ERP",
  STATUS_CONFLICT: "Cùng mốc, khác trạng thái",
  UNMATCHED: "Không có trong ERP",
  UNKNOWN_STATUS: "Trạng thái ERP chưa hiểu",
  AMBIGUOUS: "Ghép được nhiều vận đơn",
  INVALID: "Dòng không dùng được",
  DUPLICATE_ROW: "Trùng dòng trong cùng tệp",
};

export const PREVIEW_VERDICT_HINT: Record<PreviewVerdict, string> = {
  SAME: "ERP đã có đúng chứng từ này — ghi vào cũng không đổi gì.",
  NEWER: "Tệp mang chứng từ MUỘN HƠN thứ ERP đang giữ. Đây là phần tệp thật sự vá được.",
  OLDER: "Tệp mang chứng từ CŨ HƠN. ERP giữ trạng thái mới hơn và vẫn ghi dòng này vào lịch sử — không bao giờ hạ trạng thái vì một tệp cũ.",
  STATUS_CONFLICT: "ĐVVC và ERP nói hai điều khác nhau về ĐÚNG MỘT khoảnh khắc. Không phải lỗi ghép dòng: mã đã ghép chắc chắn, chỉ hai lời khai không khớp. Đường ghi dừng lại cho người đối chiếu, vì chọn hộ một bên là bịa ra một chứng từ.",
  UNMATCHED: "ERP chưa có vận đơn nào mang mã này. Không tự tạo: một vận đơn không gắn đơn là một vận đơn không ai đối chiếu được.",
  UNKNOWN_STATUS: "Chữ của Viettel Post được ghi nguyên văn vào sổ trạng thái và lên chính vận đơn, nhưng KHÔNG dùng để kết luận chặng — không đủ căn cứ thì không đoán.",
  AMBIGUOUS: "Mã hoặc số điện thoại ghép được nhiều vận đơn. Người phải quyết, máy không đoán.",
  INVALID: "Thiếu mốc thời gian đọc được. Không có mốc thì không so được mới/cũ, nên dòng bị bỏ qua.",
  DUPLICATE_ROW: "Cùng vận đơn, cùng trạng thái, cùng mốc với một dòng khác trong chính tệp này.",
};

export const PREVIEW_VERDICT_TONE: Record<PreviewVerdict, string> = {
  SAME: "bg-muted text-muted-foreground",
  NEWER: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
  OLDER: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  STATUS_CONFLICT: "bg-orange-100 text-orange-800 dark:bg-orange-950/60 dark:text-orange-300",
  UNMATCHED: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  UNKNOWN_STATUS: "bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-300",
  AMBIGUOUS: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  INVALID: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  DUPLICATE_ROW: "bg-muted text-muted-foreground",
};

/** Thứ tự đọc: việc phải làm trước, chuyện bình thường sau. */
export const PREVIEW_VERDICT_ORDER: PreviewVerdict[] = ["NEWER", "STATUS_CONFLICT", "UNKNOWN_STATUS", "AMBIGUOUS", "UNMATCHED", "OLDER", "INVALID", "DUPLICATE_ROW", "SAME"];

/**
 * ═══════════ HAI LOẠI "KHÔNG KHỚP", HAI VIỆC PHẢI LÀM KHÁC HẲN NHAU ═══════════
 *
 * `AMBIGUOUS` và `STATUS_CONFLICT` từng là MỘT nhãn. Chúng nghe giống nhau và sửa khác nhau hoàn toàn:
 *
 *  · `AMBIGUOUS`       — LỖI GHÉP. Không biết dòng này thuộc vận đơn nào. Sửa bằng cách tra lại mã /
 *                        số điện thoại, hoặc chấp nhận là tệp có dòng không dùng được.
 *  · `STATUS_CONFLICT` — ĐÃ GHÉP ĐÚNG, nhưng ĐVVC và ERP khai khác nhau về cùng một khoảnh khắc.
 *                        Sửa bằng cách mở viettelpost.vn tra chính mã đó và quyết bên nào đúng.
 *
 * Gộp lại thì một bảng 40 dòng "cần người quyết" không nói được người trực phải mở cái gì ra xem.
 */
export const MAPPING_ERROR_VERDICTS: PreviewVerdict[] = ["AMBIGUOUS", "INVALID"];

/**
 * ═══════════ CỘT `conflicts` CỦA SỔ NHẬP TỆP GỒM NHỮNG PHÁN QUYẾT NÀO ═══════════
 *
 * `vtp_import_batches.conflicts` là MỘT con số, còn phán quyết thì có chín. Đường GHI đếm
 * "mọi thứ không phải updated/linked/leg/stale/duplicate" nên nó gồm cả xung đột trạng thái; đường
 * CHẠY THỬ phải đếm đúng cùng tập ấy, nếu không hai lượt trên cùng một tệp ghi hai con số khác nhau
 * vào cùng một cột và không ai biết bên nào đúng.
 *
 * Khai thành danh sách chứ không cộng tay tại chỗ gọi: thêm một phán quyết mới thì chỉ có ĐÚNG MỘT
 * chỗ phải nghĩ xem nó thuộc nhóm nào, và `tests/vtp-source-of-truth.test.ts` bắt được nếu quên.
 */
export const LEDGER_CONFLICT_VERDICTS: PreviewVerdict[] = ["AMBIGUOUS", "STATUS_CONFLICT"];

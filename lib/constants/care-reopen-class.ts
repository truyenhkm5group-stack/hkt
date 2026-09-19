/**
 * ═══════════ MỘT ĐỢT CHĂM SÓC THỨ HAI: THẬT, GIẢ, HAY CHƯA RÕ ═══════════
 *
 * ─── VÌ SAO PHẢI PHÂN LOẠI ───
 *
 * Tới 18/09/2026, luật mở ca chỉ hỏi "kiện này có đợt nào ĐANG MỞ không?" (xem mục 59). Người bấm
 * hoàn tất làm `active = false`, nên bộ đối chiếu 10 phút/lần dựng lại một đợt MỚI cho đúng tình
 * trạng ĐVVC cũ. Những đợt ấy KHÔNG phải việc mới — chúng là bản sao của một việc đã xong.
 *
 * Luật đã được vá, nhưng các đợt đã trót sinh ra vẫn nằm trong CSDL và vẫn được đếm như những ca
 * độc lập ở **mọi** con số: số ca mở, số ca đã giao người, tỷ lệ cứu đơn, thời gian xử lý, số thao
 * tác trên mỗi ca. Nếu không gọi tên chúng thì mọi báo cáo care còn nói sai rất lâu sau khi lỗi
 * đã hết.
 *
 * ─── ĐỌC RA LÚC XEM, KHÔNG GHI VÀO CSDL ───
 *
 * Không thêm cột, không sửa một dòng lịch sử nào. Ba lý do:
 *
 *  1. Lịch sử phải tra lại được nguyên vẹn — mục 8.8 cấm backfill lặng lẽ.
 *  2. Phân loại là một SUY LUẬN từ bằng chứng, không phải một sự kiện. Bằng chứng có thể đầy thêm
 *     (một sự kiện ĐVVC đến muộn được nhập vào) và lúc đó kết luận phải đổi theo.
 *  3. Một cột ghi cứng sẽ giữ mãi kết luận của lần chạy đầu tiên.
 *
 * ─── BA CÂU TRẢ LỜI, VÀ CÂU THỨ BA LÀ CÂU QUAN TRỌNG ───
 *
 * Cám dỗ là chia hai: thật / giả. Nhưng đo được 18/09 trên 19 cặp đợt liên tiếp:
 *
 *   10 cặp  FALSE_REOPEN_LEGACY   — mốc kích hoạt cũ hơn lúc đóng VÀ không có sự kiện ĐVVC nào xen giữa
 *    6 cặp  REOPEN_UNVERIFIED     — mốc cũ hơn NHƯNG có sự kiện ĐVVC xen giữa: không kết luận được
 *    3 cặp  LEGITIMATE_REOPEN     — mốc kích hoạt mới hơn lúc đóng, sự cố thật
 *
 * Gộp 6 cặp giữa vào nhóm "giả" sẽ là khẳng định một điều không chứng minh được — và nó làm con số
 * "lỗi" to lên 60%. Gộp vào nhóm "thật" thì giấu mất chúng. Chúng đứng RIÊNG, và đứng riêng là câu
 * trả lời đúng (mục 45: `AMBIGUOUS` để người quyết).
 */

export const REOPEN_CLASSES = ["FIRST_EPISODE", "LEGITIMATE_REOPEN", "FALSE_REOPEN_LEGACY", "REOPEN_UNVERIFIED"] as const;
export type ReopenClass = (typeof REOPEN_CLASSES)[number];

export const REOPEN_CLASS_LABEL: Record<ReopenClass, string> = {
  FIRST_EPISODE: "Đợt đầu tiên của kiện",
  LEGITIMATE_REOPEN: "Sự cố mới — mở lại đúng",
  FALSE_REOPEN_LEGACY: "Bản sao do lỗi cũ",
  REOPEN_UNVERIFIED: "Chưa đủ bằng chứng để kết luận",
};

export const REOPEN_CLASS_HINT: Record<ReopenClass, string> = {
  FIRST_EPISODE: "Kiện chưa từng có đợt nào trước đó.",
  LEGITIMATE_REOPEN: "Mốc ĐVVC kích hoạt đợt này MỚI HƠN lúc đóng đợt trước — kiện hỏng thêm một lần nữa thật.",
  FALSE_REOPEN_LEGACY:
    "Mốc kích hoạt KHÔNG mới hơn lúc đóng đợt trước, VÀ không có sự kiện ĐVVC nào xen giữa. Đây là bản sao sinh ra bởi lỗi mở ca đã vá ngày 18/09/2026 — KHÔNG đếm như một ca nghiệp vụ độc lập.",
  REOPEN_UNVERIFIED:
    "Mốc kích hoạt không mới hơn lúc đóng, NHƯNG có sự kiện ĐVVC xen giữa. Không đủ để khẳng định là bản sao, cũng không đủ để khẳng định là sự cố mới. Để riêng, không đoán.",
};

/** Đợt được tính như MỘT CA NGHIỆP VỤ ĐỘC LẬP. Bản sao do lỗi cũ thì không. */
export const REOPEN_CLASS_COUNTS_AS_CASE: Record<ReopenClass, boolean> = {
  FIRST_EPISODE: true,
  LEGITIMATE_REOPEN: true,
  FALSE_REOPEN_LEGACY: false,
  REOPEN_UNVERIFIED: true,
};

export type ReopenFacts = {
  episodeNo: number;
  /** Mốc ĐVVC kích hoạt đợt này (`opened_at`). */
  triggerAt: Date | null;
  /** Mốc đóng của đợt liền trước. `null` = không có đợt trước. */
  previousClosedAt: Date | null;
  /** Có sự kiện ĐVVC nào xảy ra trong khoảng (đóng đợt trước → lúc dựng đợt này] không. */
  carrierEventBetween: boolean;
};

/**
 * Hàm THUẦN. Cùng luật với `canOpenNewEpisode()` ở `lib/care/reopen-guard.ts` nhưng trả lời một câu
 * KHÁC: hàm kia hỏi *"có được mở không"* (nhìn tới trước), hàm này hỏi *"đợt đã mở rồi là loại gì"*
 * (nhìn lại sau, và có thêm bằng chứng sự kiện ĐVVC mà lúc mở chưa tra).
 */
export function classifyReopen(f: ReopenFacts): ReopenClass {
  if (f.episodeNo <= 1 || !f.previousClosedAt) return "FIRST_EPISODE";
  if (f.triggerAt && f.triggerAt.getTime() > f.previousClosedAt.getTime()) return "LEGITIMATE_REOPEN";
  // Mốc không mới hơn. Có sự kiện ĐVVC xen giữa ⇒ có thể đã có chuyện xảy ra mà mốc không phản ánh.
  return f.carrierEventBetween ? "REOPEN_UNVERIFIED" : "FALSE_REOPEN_LEGACY";
}

/**
 * ═══════════ LÚC LUẬT MỚI BẮT ĐẦU CHẠY TRÊN PRODUCTION ═══════════
 *
 * Mốc này chia đôi mọi con số về lỗi mở lại: TRƯỚC là di sản đã biết và đã vá, SAU là lỗi CÒN ĐANG
 * XẢY RA. Gộp hai bên vào một con số làm chủ shop tưởng lỗi vẫn chưa hết trong khi nó đã hết.
 *
 * Giá trị lấy từ lần deploy thật (run #35305088847, hoàn tất 18/09/2026 ~04:10Z), không phải một
 * con số ước lượng. Bất kỳ đợt nào mang nhãn `FALSE_REOPEN_LEGACY` mà được tạo SAU mốc này là một
 * lỗi MỚI và phải được điều tra — con số đó phải bằng 0.
 */
export const REOPEN_GUARD_LIVE_AT = new Date("2026-09-18T04:10:00.000Z");

/**
 * ═══════════ "LỖI CÒN ĐANG XẢY RA HAY KHÔNG" — VỊ TỪ THUẦN, NHẬN MỐC TỪ NGOÀI ═══════════
 *
 * ─── VÌ SAO PHẢI TÁCH RA KHỎI TRUY VẤN ───
 *
 * Luật này so một mốc của DỮ LIỆU với một mốc LỊCH CỐ ĐỊNH (`REOPEN_GUARD_LIVE_AT`). Đó đúng là
 * điều nó phải làm — nhưng nó cũng là cái bẫy mà mục 50 của AGENTS.md sinh ra để cấm: một bài kiểm
 * gieo dữ liệu bằng "20 giờ trước" rồi so với mốc ấy sẽ XANH hôm nay và ĐỎ ngày mai, vì cửa sổ
 * trượt theo đồng hồ thật quét qua một cái mốc đứng yên. Và vì workflow deploy chạy `npm test`
 * trước khi đụng máy chủ, một bài kiểm như vậy chặn MỌI lần deploy vào đúng cái ngày nó trở mặt.
 *
 * Nhận `guardLiveAt` qua THAM SỐ thì bài kiểm khoá được ĐÚNG cái biên (trước · đúng · sau) bằng ba
 * mốc do chính nó dựng, không đọc đồng hồ hệ thống một lần nào. Production vẫn gọi với hằng số
 * thật, nên không có đường ghi thứ hai và không có hành vi nào đổi.
 *
 * BIÊN LÀ CHỖ DỄ SAI NHẤT: đợt tạo ĐÚNG vào mốc luật chạy KHÔNG tính là lỗi mới — lúc đó bản vá
 * vừa mới lên, và tính nó vào con số "còn đang xảy ra" là đổ cho bản vá một lỗi nó vừa chặn.
 */
export function isFalseReopenAfterFix(row: { reopenClass: ReopenClass; openedAt: Date | null }, guardLiveAt: Date = REOPEN_GUARD_LIVE_AT): boolean {
  return row.reopenClass === "FALSE_REOPEN_LEGACY" && row.openedAt !== null && row.openedAt.getTime() > guardLiveAt.getTime();
}

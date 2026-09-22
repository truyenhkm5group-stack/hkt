/**
 * ═══════════ BÀN TAY CỦA PHÒNG MARKETING — HÀNG RÀO ĐỨNG TRƯỚC, HÀNH ĐỘNG ĐỨNG SAU ═══════════
 *
 * Đặc tả: `docs/marketing-ai-department.md` mục 5. Chủ shop duyệt 22/09/2026, **ở nấc `COPILOT`**:
 * agent ĐỀ NGHỊ, người bấm xác nhận thì ERP mới gọi Facebook.
 *
 * Tệp này giữ MỌI con số và MỌI nấc quyền của đường ghi. Không hằng số nào của đường ghi được nằm
 * ở chỗ khác — một cái trần rải ra hai nơi là một cái trần sẽ có hai giá trị.
 *
 * ─── VÌ SAO TRẦN PHẢI CÓ TRƯỚC LỜI GỌI ĐẦU TIÊN ───
 *
 * Mọi lớp sai của một cỗ máy tiêu tiền đều có cùng hình dạng: nó làm đúng thứ được bảo, rất nhanh,
 * rất nhiều lần. Một lỗi dấu trong phép tính phần trăm không làm hỏng một chiến dịch — nó làm hỏng
 * tất cả, trong một đêm, và sáng hôm sau không ai dựng lại được ngân sách cũ vì không ai ghi lại.
 * Nên trần và sổ phải có TRƯỚC, không phải "thêm sau khi chạy ổn".
 */

/**
 * ───────────── NẤC QUYỀN HẠN ─────────────
 *
 * Chép đúng thang của nền tảng nhân sự AI (`docs/ai-workforce.md` §3) vì lớp lỗi giống hệt, chỉ
 * khác là ở đây tiền chảy ra ngay chứ không qua một khách hàng.
 */
export type AdsWriteMode = "OFF" | "COPILOT" | "AUTO";

/**
 * TRẦN CỨNG CỦA MÃ NGUỒN. Khai `AUTO` ở env hay ở `settings` cũng bị kẹp xuống `COPILOT`.
 *
 * Chủ shop duyệt `COPILOT` và **chỉ** `COPILOT`. Nâng lên `AUTO` là một quyết định MỚI, không phải
 * một bước kế tiếp mặc nhiên — nên nó phải là một lần sửa mã có người đọc, không phải một biến môi
 * trường ai đó gõ lúc nửa đêm.
 */
export const MAX_ALLOWED_ADS_WRITE_MODE: AdsWriteMode = "COPILOT";

const MODE_RANK: Record<AdsWriteMode, number> = { OFF: 0, COPILOT: 1, AUTO: 2 };

export function clampAdsWriteMode(want: AdsWriteMode): AdsWriteMode {
  return MODE_RANK[want] > MODE_RANK[MAX_ALLOWED_ADS_WRITE_MODE] ? MAX_ALLOWED_ADS_WRITE_MODE : want;
}

/**
 * ───────────── BỐN CÁI TRẦN, VÀ CHÚNG CHẶN BỐN THỨ KHÁC NHAU ─────────────
 *
 * > **Bốn con số này CHƯA được chủ shop chốt** (AGENTS.md mục 7) — chúng là đề xuất khởi điểm, và
 * > mã nguồn nói thẳng như vậy. Đường ghi vẫn TẮT cho tới khi có `ADS_WRITE_ENABLED=true`, nên chưa
 * > con số nào trong đây từng chạm tiền thật.
 */
export const ADS_WRITE_LIMITS = {
  /**
   * Phần trăm tối đa ngân sách MỘT chiến dịch được đổi trong MỘT lần.
   *
   * Chặn lỗi biên độ: một phép tính sai dấu hay sai đơn vị (đồng ↔ xu) sẽ vỡ ở đây thay vì nhân
   * ngân sách lên trăm lần. 30% cũng là mức Facebook còn giữ được giai đoạn học của chiến dịch —
   * nhảy gấp đôi thường làm thuật toán phân phối chạy lại từ đầu.
   */
  maxStepPct: 0.3,
  /**
   * Bước ĐỀ NGHỊ mặc định — CỐ Ý thấp hơn trần.
   *
   * Nếu đề nghị luôn bằng đúng trần thì trần thôi là trần: nó thành giá trị mặc định, và cái lưới
   * an toàn biến mất vào trong hành vi bình thường. Một cái trần chỉ còn là trần khi hoạt động
   * thường ngày không chạm tới nó.
   */
  proposeStepPct: 0.2,
  /**
   * Tổng tiền/ngày được dịch chuyển trên TOÀN SHOP (cộng trị tuyệt đối mọi lượt đổi).
   *
   * Chặn lỗi số lượng: từng lượt đều trong biên độ mà ba mươi lượt trong một giờ thì vẫn là thảm
   * hoạ. Đây là cái trần mà một vòng lặp hỏng đâm vào.
   */
  maxDailyShiftVnd: 2_000_000,
  /**
   * Số lần MỘT chiến dịch được đổi trong 24 giờ.
   *
   * Chặn dao động: sổ quyết định chạy trên cửa sổ 14 ngày, nên đổi ngân sách hai lần trong một ngày
   * là hành động trên cùng một dữ liệu hai lần. Lần thứ hai không mang thêm thông tin nào.
   */
  maxChangesPerCampaignPerDay: 1,
  /**
   * Sàn ngân sách ngày. Dưới mức này Facebook phân phối nhỏ giọt và mọi số đo thành vô nghĩa —
   * "giảm 30% mãi" sẽ tiệm cận 0 mà không bao giờ tới, để lại một chiến dịch sống dở.
   * Muốn dừng hẳn thì TẮT chiến dịch, đó là một hành động khác và nó có tên riêng.
   */
  minDailyBudgetVnd: 50_000,
  /**
   * PHANH: bấy nhiêu lượt đổi liên tiếp mà lợi nhuận góp sau quảng cáo ĐI XUỐNG ⇒ dừng toàn bộ
   * đường ghi và báo người.
   *
   * Máy phải biết tự nghi ngờ mình. Không có phanh thì một luật sai sẽ tự tin hơn sau mỗi lần sai.
   */
  brakeConsecutiveWorse: 3,
} as const;

/**
 * ───────────── HAI HÀNH ĐỘNG, VÀ KHÔNG CÓ HÀNH ĐỘNG THỨ BA ─────────────
 *
 * Cố ý KHÔNG có: tạo chiến dịch · sửa đối tượng · sửa creative · đổi mục tiêu tối ưu · đụng tài
 * khoản quảng cáo. Mọi thứ đó đều đòi phán đoán mà ERP không có dữ liệu để đưa ra, và mỗi cái là
 * một bề mặt sai mới. Hai hành động dưới đây là hai thứ DUY NHẤT mà `decideAction()` thật sự kết
 * luận được.
 */
export type AdsWriteAction = "SET_DAILY_BUDGET" | "PAUSE_CAMPAIGN";

export const ADS_WRITE_ACTION_LABEL: Record<AdsWriteAction, string> = {
  SET_DAILY_BUDGET: "Đổi ngân sách ngày",
  PAUSE_CAMPAIGN: "Tạm dừng chiến dịch",
};

/** Khuyến nghị nào đẻ ra được hành động nào. Khuyến nghị không có mặt ở đây thì KHÔNG có bàn tay. */
export const ACTION_FOR_DECISION: Record<string, AdsWriteAction | null> = {
  SCALE: "SET_DAILY_BUDGET",
  CUT: "PAUSE_CAMPAIGN",
  // Sửa khâu giao là việc của kho và CSKH, không phải việc của ngân sách. Nối nó vào một nút đổi
  // tiền là chữa sai bệnh — đúng thứ `FIX_DELIVERY` sinh ra để ngăn.
  FIX_DELIVERY: null,
  HOLD: null,
  WATCH: null,
  INSUFFICIENT_DATA: null,
  NO_SPEND_DATA: null,
};

/**
 * ───────────── KẾT QUẢ MỘT LƯỢT XIN GHI ─────────────
 *
 * `DENIED` vẫn được GHI SỔ. "Máy đã ĐỊNH làm gì" là thông tin quý nhất khi đánh giá một cỗ máy tự
 * chủ, và nó chỉ tồn tại nếu lượt bị chặn cũng để lại dấu.
 */
export type AdsWriteOutcome = "APPLIED" | "DENIED" | "FAILED";

/** Vì sao một lượt xin ghi bị chặn. Mỗi lý do sửa ở một chỗ khác nên không được gộp. */
export type AdsWriteDenial =
  | "HARD_DISABLED"
  | "MODE_OFF"
  | "NOT_CONFIRMED"
  | "NOT_STABLE"
  | "NO_ACTION_FOR_DECISION"
  | "STEP_TOO_BIG"
  | "DAILY_CAP"
  | "CAMPAIGN_RATE_LIMIT"
  | "BELOW_MIN_BUDGET"
  | "BRAKE_ON";

export const ADS_WRITE_DENIAL_REASON: Record<AdsWriteDenial, string> = {
  HARD_DISABLED: "Đường ghi quảng cáo đang TẮT ở cấp máy chủ (ADS_WRITE_ENABLED). Đây là chốt ngoài cùng, không mở được từ giao diện hay từ bảng settings.",
  MODE_OFF: "Nấc quyền hạn đang OFF.",
  NOT_CONFIRMED: "Nấc COPILOT đòi người bấm xác nhận. Không có phiếu duyệt hợp lệ thì không ghi.",
  NOT_STABLE: "Khuyến nghị chưa chín: chưa giữ đủ số ngày, hoặc đổi ý quá nhiều lần, hoặc sổ quyết định chưa ghi tới hôm nay.",
  NO_ACTION_FOR_DECISION: "Khuyến nghị này không đẻ ra một hành động ngân sách nào.",
  STEP_TOO_BIG: `Vượt biên độ một lần (${Math.round(ADS_WRITE_LIMITS.maxStepPct * 100)}%).`,
  DAILY_CAP: `Vượt trần dịch chuyển ngân sách trong ngày (${ADS_WRITE_LIMITS.maxDailyShiftVnd.toLocaleString("vi-VN")}đ).`,
  CAMPAIGN_RATE_LIMIT: `Chiến dịch này đã đổi ${ADS_WRITE_LIMITS.maxChangesPerCampaignPerDay} lần trong 24 giờ.`,
  BELOW_MIN_BUDGET: `Sẽ hạ ngân sách xuống dưới sàn ${ADS_WRITE_LIMITS.minDailyBudgetVnd.toLocaleString("vi-VN")}đ. Muốn dừng hẳn thì tạm dừng chiến dịch, đó là một hành động khác.`,
  BRAKE_ON: `PHANH ĐANG BẬT: ${ADS_WRITE_LIMITS.brakeConsecutiveWorse} lượt đổi gần nhất đều làm lợi nhuận góp sau quảng cáo đi xuống. Đường ghi dừng cho tới khi người xem lại.`,
};

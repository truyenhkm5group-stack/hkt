import { BUSINESS_ACTIONS, type BusinessAction } from "@/lib/constants/care-outcome";

/**
 * ═══════════ BA KẾT QUẢ XỬ LÝ — NGÔN NGỮ CỦA NGƯỜI TRỰC, KHÔNG PHẢI MỘT CHIỀU DỮ LIỆU MỚI ═══════════
 *
 * ─── VÌ SAO TỆP NÀY TỒN TẠI ───
 *
 * Chủ shop chốt 18/09/2026: người trực vận đơn mỗi ngày chỉ phải trả lời ĐÚNG MỘT câu hỏi cho mỗi
 * kiện — *“kiện này thôi rồi, đi tiếp, hay để lát nữa?”*. Ba câu trả lời đó là:
 *
 *   ĐÃ HOÀN · PHÁT TIẾP · XỬ LÝ SAU
 *
 * Trước bản này ba việc ấy nằm sau hai lớp: mở popover “Xử lý” rồi đọc một danh sách BỐN quyết
 * định mang tên kế toán (“Duyệt hoàn”, “Theo dõi tiếp”). Người trực phải dịch từ việc mình vừa làm
 * sang tên trong menu, mỗi kiện một lần, vài chục lần một buổi.
 *
 * ─── KHÔNG SINH RA MỘT SỔ THỨ HAI ───
 *
 * Đây là MỘT LỚP NGÔN NGỮ, không phải một cột mới, không phải một bảng mới, không phải một vòng đời
 * mới. Mỗi kết quả trỏ về ĐÚNG MỘT `BusinessAction` đã có và đã được ghi vào `care_business_actions`
 * (chỉ thêm, có actor, có mốc, có lệnh ĐVVC kèm theo). Thêm một cột `resolution_action` song song là
 * tự nhận lấy câu hỏi *“hai chỗ lệch nhau thì tin chỗ nào”* — và câu đó không có câu trả lời tốt.
 *
 * `EXCHANGE` (Đổi) cố ý KHÔNG có mặt trong ba nút: nó cần một vận đơn thay thế đã tồn tại, nên nó
 * không phải một cú bấm mà là một quy trình. Nó vẫn ở menu đầy đủ trong bàn làm việc.
 *
 * ─── BA CHIỀU VẪN LÀ BA CHIỀU (mục 9 của đề bài, luật 47 của AGENTS.md) ───
 *
 *   1. ĐVVC nói gì   — `shipments.stage` / `carrierSubstate`, chứng từ, đội không sửa được.
 *   2. Đội đang ở đâu — `shipment_care.care_status` (Chưa xử lý · Đang xử lý · Chờ khách…).
 *   3. Đội quyết gì  — chính tệp này.
 *
 * Người trực bấm “Đã hoàn” KHÔNG làm vận đơn thành `RETURNED`, KHÔNG đổi `ORDER_OUTCOME`, KHÔNG đưa
 * hàng vào tồn. Nó là một câu trong sổ: *shop thôi không cứu kiện này nữa*. Hàng chỉ thành hoàn khi
 * Viettel Post báo, và chỉ vào lại kho khi kho lập phiếu đếm thực tế.
 */
export const RESOLUTION_ACTIONS = ["RETURNED", "REDELIVER", "FOLLOW_UP_LATER"] as const;
export type ResolutionAction = (typeof RESOLUTION_ACTIONS)[number];

/** Kết quả xử lý → quyết định nghiệp vụ đã có. MỘT chiều duy nhất, không có cột lưu riêng. */
export const RESOLUTION_TO_BUSINESS: Record<ResolutionAction, BusinessAction> = {
  RETURNED: "APPROVE_RETURN",
  REDELIVER: "REQUEST_REDELIVERY",
  FOLLOW_UP_LATER: "CONTINUE_MONITORING",
};

/**
 * Chiều ngược, để đọc lịch sử. `EXCHANGE` trả `null` — nó là một quyết định thật nhưng KHÔNG phải
 * một trong ba nút, và ánh xạ ép nó vào một nút nào đó sẽ làm báo cáo đếm nhầm.
 */
export function resolutionOf(action: BusinessAction | null | undefined): ResolutionAction | null {
  if (!action) return null;
  const found = RESOLUTION_ACTIONS.find((r) => RESOLUTION_TO_BUSINESS[r] === action);
  return found ?? null;
}

export const RESOLUTION_LABEL: Record<ResolutionAction, string> = {
  RETURNED: "Đã hoàn",
  REDELIVER: "Phát tiếp",
  FOLLOW_UP_LATER: "Xử lý sau",
};

/**
 * Câu giải thích PHẢI nói ra điều mỗi nút KHÔNG làm — ba hiểu nhầm dưới đây là thứ làm hỏng số liệu
 * nhanh nhất, và chúng chỉ bị chặn bằng chữ đứng ngay cạnh nút.
 */
export const RESOLUTION_HINT: Record<ResolutionAction, string> = {
  RETURNED:
    "Shop quyết định thôi không cứu kiện này nữa và duyệt cho hàng quay về. ĐÂY LÀ QUYẾT ĐỊNH NỘI BỘ — vận đơn KHÔNG thành “đã hoàn” vì cú bấm này, tồn kho KHÔNG tăng, doanh thu KHÔNG đổi. Viettel Post báo hoàn thì mới là hoàn; kho lập phiếu đếm thì hàng mới vào tồn.",
  REDELIVER:
    "Nhờ Viettel Post đi phát thêm một lần nữa. Lệnh được ĐVVC NHẬN không có nghĩa hàng đã tới tay khách — ca vẫn mở cho tới khi hành trình nói kết cục.",
  FOLLOW_UP_LATER:
    "Chưa gửi gì sang ĐVVC, chỉ hẹn giờ xem lại. Ca vẫn MỞ và quay về đầu hàng đợi đúng giờ hẹn — nên bắt buộc phải có giờ, hẹn không giờ là ca chìm mất.",
};

/**
 * MÀU: đi theo `BUSINESS_ACTION_TONE` về mặt ngữ nghĩa nhưng khai lại ở đây vì ba nút này là một
 * BỘ ĐIỀU KHIỂN (segmented control) chứ không phải một nhãn — nền đặc chỉ dành cho ô ĐANG CHỌN,
 * hai ô còn lại phải mờ đi, nếu không người trực nhìn ba mảng màu và không biết cái nào đang đúng.
 *
 * Đỏ cho “Đã hoàn” (quyết định tốn tiền, khó đảo) · xanh ngọc cho “Phát tiếp” (còn cứu được) ·
 * hổ phách cho “Xử lý sau” (chưa xong, còn nợ một lần quay lại). Chữ luôn đứng cạnh màu: màn hình
 * này phải đọc được khi in đen trắng và khi người dùng mù màu.
 */
export const RESOLUTION_TONE: Record<ResolutionAction, string> = {
  RETURNED: "bg-red-100 text-red-900 dark:bg-red-950/70 dark:text-red-200",
  REDELIVER: "bg-teal-100 text-teal-900 dark:bg-teal-950/70 dark:text-teal-200",
  FOLLOW_UP_LATER: "bg-amber-100 text-amber-900 dark:bg-amber-950/70 dark:text-amber-200",
};

/** Viền cho ô ĐANG CHỌN — nền không đủ: hai chế độ sáng/tối có độ tương phản nền rất khác nhau. */
export const RESOLUTION_RING: Record<ResolutionAction, string> = {
  RETURNED: "border-red-400 dark:border-red-700",
  REDELIVER: "border-teal-400 dark:border-teal-700",
  FOLLOW_UP_LATER: "border-amber-400 dark:border-amber-700",
};

/* ───────────────────────── MẪU NOTE THEO KẾT QUẢ ───────────────────────── */

/**
 * Mẫu note GẮN VỚI TỪNG KẾT QUẢ, không phải một rổ chung: người vừa bấm “Đã hoàn” cần những câu
 * của “Đã hoàn”, đưa cả 24 mẫu ra thì họ lại phải đọc để tìm.
 *
 * Bộ này là MẶC ĐỊNH. Chủ shop ghi đè bằng khoá `care.resolutionNotes` trong bảng `settings`
 * (xem `getResolutionNotePresets`) — mẫu là ngôn ngữ của shop, không phải hằng số của phần mềm.
 * Ô nhập tự do LUÔN có: mẫu để bấm nhanh, không phải để giới hạn người ta nói gì.
 */
export const RESOLUTION_NOTES_KEY = "care.resolutionNotes";

export const RESOLUTION_NOTES_DEFAULT: Record<ResolutionAction, string[]> = {
  RETURNED: ["Khách từ chối nhận", "Không liên lạc được nhiều lần", "Khách xác nhận không lấy nữa", "Duyệt hoàn về shop", "Bưu cục xác nhận hoàn"],
  REDELIVER: ["Khách hẹn nhận chiều nay", "Khách hẹn nhận ngày mai", "Đã gọi bưu tá, hẹn phát lại", "Khách đổi số điện thoại", "Đã xác nhận lại địa chỉ", "Yêu cầu phát lại"],
  FOLLOW_UP_LATER: ["Chờ khách phản hồi", "Chờ bưu tá gọi lại", "Chờ CSKH xác minh", "Hẹn gọi lại sau", "Chờ Viettel Post cập nhật"],
};

/** Số mẫu tối đa mỗi kết quả — chặn ở lược đồ đầu vào để một lần dán nhầm không phá màn hình. */
export const RESOLUTION_NOTES_MAX = 20;

/* ───────────────────────── HẸN XEM LẠI ───────────────────────── */

/**
 * SÁU LỐI HẸN cho “Xử lý sau”. Bốn cái đầu là bấm một phát; `end_of_day` / `tomorrow` neo vào GIỜ
 * LÀM VIỆC chứ không cộng thêm N giờ — “cuối buổi” lúc 9 giờ sáng và lúc 4 giờ chiều phải ra cùng
 * một mốc, nếu không hai người trực cùng bấm “cuối buổi” sẽ hẹn hai giờ khác nhau.
 *
 * `custom` không có ở đây: nó mở ô chọn ngày giờ, không tính ra mốc nào.
 */
export const FOLLOW_UP_CHOICES = [
  { key: "30m", label: "30 phút", minutes: 30 },
  { key: "1h", label: "1 giờ", minutes: 60 },
  { key: "2h", label: "2 giờ", minutes: 120 },
  { key: "end_of_day", label: "Cuối buổi", minutes: null },
  { key: "tomorrow", label: "Sáng mai", minutes: null },
] as const;
export type FollowUpChoice = (typeof FOLLOW_UP_CHOICES)[number]["key"];

/** Giờ kết thúc buổi làm và giờ bắt đầu buổi sáng — theo đồng hồ của máy người trực (giờ VN). */
export const WORK_DAY_END_HOUR = 18;
export const WORK_DAY_START_HOUR = 9;

/**
 * HÀM THUẦN: một lựa chọn + một mốc “bây giờ” ⇒ một mốc hẹn. Không đọc `Date.now()` bên trong, nên
 * kiểm thử gọi được mà không phải ghim một ngày tuyệt đối (luật 50).
 *
 * “Cuối buổi” mà bấm sau giờ tan làm ⇒ cuối buổi NGÀY MAI: hẹn vào một mốc đã trôi qua là hẹn giả,
 * ca sẽ nhảy lại vào hàng đợi ngay lập tức và người trực học cách bỏ qua chính cảnh báo đó.
 */
export function followUpAtFrom(choice: FollowUpChoice, now: Date): Date {
  const spec = FOLLOW_UP_CHOICES.find((c) => c.key === choice);
  if (spec?.minutes) return new Date(now.getTime() + spec.minutes * 60_000);
  const d = new Date(now);
  if (choice === "end_of_day") {
    d.setHours(WORK_DAY_END_HOUR, 0, 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d;
  }
  // tomorrow
  d.setDate(d.getDate() + 1);
  d.setHours(WORK_DAY_START_HOUR, 0, 0, 0);
  return d;
}

/* ───────────────────────── LỌC THEO KẾT QUẢ ───────────────────────── */

/**
 * Rổ lọc “kết quả xử lý”. `none` là CHƯA AI QUYẾT — cố ý là một rổ riêng chứ không phải “không
 * lọc”: đó chính là rổ người trực cần mở đầu ca, và nếu nó lẫn vào “Tất cả” thì nó không tồn tại.
 */
export const RESOLUTION_FILTER_KEYS = ["none", ...RESOLUTION_ACTIONS] as const;
export type ResolutionFilterKey = (typeof RESOLUTION_FILTER_KEYS)[number];

export const RESOLUTION_FILTER_LABEL: Record<ResolutionFilterKey, string> = {
  none: "Chưa quyết định",
  RETURNED: RESOLUTION_LABEL.RETURNED,
  REDELIVER: RESOLUTION_LABEL.REDELIVER,
  FOLLOW_UP_LATER: RESOLUTION_LABEL.FOLLOW_UP_LATER,
};

/**
 * Rổ lọc theo CÁI HẸN. Tách khỏi rổ kết quả vì nó trả lời câu khác: kết quả nói *đã quyết gì*, cái
 * hẹn nói *bao giờ phải quay lại*. Một ca “Xử lý sau” hẹn tuần sau và một ca “Xử lý sau” quá hạn từ
 * hôm qua là hai việc khác hẳn nhau.
 *
 * `overdue` đứng trước `today` trong danh sách vì nó là rổ phải làm trước — và một ca quá hạn KHÔNG
 * còn nằm trong “hôm nay” nữa: hai rổ này rời nhau, không chồng lấn.
 */
export const FOLLOW_UP_FILTERS = ["overdue", "today", "tomorrow", "later", "none"] as const;
export type FollowUpFilterKey = (typeof FOLLOW_UP_FILTERS)[number];

export const FOLLOW_UP_FILTER_LABEL: Record<FollowUpFilterKey, string> = {
  overdue: "Quá hẹn",
  today: "Đến hạn hôm nay",
  tomorrow: "Hẹn ngày mai",
  later: "Hẹn xa hơn",
  none: "Chưa hẹn",
};

export const FOLLOW_UP_FILTER_HINT: Record<FollowUpFilterKey, string> = {
  overdue: "Đã tới giờ hẹn mà chưa ai quay lại. Rổ này phải rỗng cuối mỗi buổi.",
  today: "Giờ hẹn nằm trong hôm nay và còn ở phía trước.",
  tomorrow: "Giờ hẹn rơi vào ngày mai.",
  later: "Giờ hẹn xa hơn ngày mai. Không phải việc của hôm nay, nhưng cũng KHÔNG phải “chưa hẹn” — gộp hai thứ đó lại là làm mất một cái hẹn có thật.",
  none: "Chưa ai đặt giờ quay lại cho ca này.",
};

/**
 * Cái hẹn của một ca rơi vào rổ nào. HÀM THUẦN, nhận `now` từ ngoài. So sánh theo NGÀY LỊCH của
 * máy người xem chứ không theo “cộng 24 giờ”: 23 giờ đêm nay cộng 24 giờ là 11 giờ trưa mai, và
 * người trực đọc “hôm nay” là hết ngày hôm nay, không phải hết 24 giờ tới.
 */
export function followUpBucket(followUpAt: Date | null, now: Date): FollowUpFilterKey {
  if (!followUpAt) return "none";
  if (followUpAt.getTime() <= now.getTime()) return "overdue";
  const ngay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const lech = Math.round((ngay(followUpAt) - ngay(now)) / 86_400_000);
  if (lech <= 0) return "today";
  if (lech === 1) return "tomorrow";
  return "later";
}

/** Kiểm thử và bộ lọc dùng chung danh sách này để chắc chắn ba nút phủ đúng ba quyết định. */
export const RESOLUTION_COVERS: BusinessAction[] = BUSINESS_ACTIONS.filter((a) => resolutionOf(a) !== null);

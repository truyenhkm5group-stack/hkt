/**
 * ═══════════ BA KẾT QUẢ XỬ LÝ CASE — CHIỀU THỨ BA, KHÔNG PHẢI MỘT LỆNH GỬI ĐVVC ═══════════
 *
 * ─── CÂU HỎI TỆP NÀY TRẢ LỜI ───
 *
 * Chủ shop chốt 18/09/2026: người trực vận đơn mỗi ngày chỉ phải trả lời ĐÚNG MỘT câu hỏi cho mỗi
 * kiện — *"kiện này thôi rồi, đi tiếp, hay để lát nữa?"*. Ba câu trả lời:
 *
 *   ĐÃ HOÀN · PHÁT TIẾP · XỬ LÝ SAU
 *
 * ─── VÀ ĐÂY LÀ KẾT QUẢ CÔNG VIỆC CỦA NGƯỜI, KHÔNG PHẢI MỘT LỆNH GỬI ĐI ĐÂU CẢ (19/09/2026) ───
 *
 * Bản đầu tiên ánh xạ ba nút này về `BusinessAction` (`APPROVE_RETURN` / `REQUEST_REDELIVERY` /
 * `CONTINUE_MONITORING`) để khỏi phải thêm bảng. Sai, và sai ở chỗ nguy hiểm: hai trong ba hành
 * động ấy GỬI MỘT LỆNH sang Viettel Post, nên đường ghi của chúng từ chối khi ĐVVC không nhận lệnh.
 * Hệ quả là **năng lực API của ERP quyết định xem NHÂN VIÊN có ghi nhận được việc mình vừa làm hay
 * không** — thiếu `VIETTELPOST_API_KEY`, API lỗi, kiện chưa có mã vận đơn, kiện đã kết thúc, kiện đi
 * hãng khác: cả năm tình huống đều khoá mất một phép đo về CON NGƯỜI.
 *
 * Ba kết quả ở đây **KHÔNG BAO GIỜ bị khoá** và **KHÔNG BAO GIỜ gọi API ĐVVC**. Chúng ghi vào sổ
 * riêng `care_decisions` (chỉ thêm). Việc gửi lệnh sang ĐVVC vẫn còn nguyên, nhưng là MỘT HÀNH ĐỘNG
 * KHÁC ở một khối khác trên màn hình ("Thao tác Viettel Post") — khối đó được phép khoá, được phép
 * hỏi lại, được phép báo lỗi API.
 *
 * ─── BA CHIỀU, KHÔNG CHIỀU NÀO SUY RA CHIỀU NÀO (luật 47) ───
 *
 *   1. ĐVVC nói gì   — `shipments.stage` / `carrierSubstate`, chứng từ, đội không sửa được.
 *   2. Đội đang ở đâu — `shipment_care.care_status` (Chưa xử lý · Đang xử lý · Chờ khách…).
 *   3. Đội quyết gì  — chính tệp này.
 *
 * Người trực bấm "Đã hoàn" trong khi ĐVVC đang báo "Đang chuyển hoàn" thì màn hình in ra CẢ HAI:
 *
 *   Care: Đã hoàn · VTP: Đang chuyển hoàn
 *
 * KHÔNG cái nào đổi cái kia. `CARE_RETURN` không làm vận đơn thành `RETURNED`, không đổi
 * `ORDER_OUTCOME`, không đưa một món nào vào tồn. Hàng chỉ thành hoàn khi Viettel Post báo, và chỉ
 * vào lại kho khi kho lập phiếu đếm thực tế.
 *
 * ─── VÌ SAO KHOÁ MANG TIỀN TỐ `CARE_` ───
 *
 * `APPROVE_RETURN` đọc lên như một lệnh gửi ĐVVC, và nó đúng là một lệnh gửi ĐVVC. Một lập trình
 * viên sáu tháng sau đọc `decision = 'RETURNED'` trong CSDL sẽ tin rằng kiện đã hoàn thật. Tiền tố
 * `CARE_` làm câu đó không đọc nhầm được: đây là quyết định của ĐỘI CHĂM SÓC, không phải trạng thái
 * của gói hàng.
 */
export const CARE_DECISIONS = ["CARE_RETURN", "CARE_CONTINUE_DELIVERY", "CARE_FOLLOW_UP"] as const;
export type CareDecision = (typeof CARE_DECISIONS)[number];

/**
 * Nhận một chuỗi bất kỳ đọc từ CSDL và trả về một kết quả HỢP LỆ, hoặc `null`.
 *
 * `null` = CHƯA AI QUYẾT, và một chuỗi lạ (dữ liệu cũ, một bản vá sai) cũng ra `null` chứ KHÔNG bị
 * ép vào một trong ba rổ: đoán hộ ở đây là một con số sai không ai phát hiện ra được.
 */
export function careDecisionOf(value: string | null | undefined): CareDecision | null {
  return value && (CARE_DECISIONS as readonly string[]).includes(value) ? (value as CareDecision) : null;
}

export const RESOLUTION_LABEL: Record<CareDecision, string> = {
  CARE_RETURN: "Đã hoàn",
  CARE_CONTINUE_DELIVERY: "Phát tiếp",
  CARE_FOLLOW_UP: "Xử lý sau",
};

/**
 * Câu giải thích PHẢI nói ra điều mỗi nút KHÔNG làm — ba hiểu nhầm dưới đây là thứ làm hỏng số liệu
 * nhanh nhất, và chúng chỉ bị chặn bằng chữ đứng ngay cạnh nút.
 */
export const RESOLUTION_HINT: Record<CareDecision, string> = {
  CARE_RETURN:
    "GHI NHẬN: shop thôi không cứu kiện này nữa, để hàng quay về. Đây là KẾT QUẢ XỬ LÝ CASE, không phải một lệnh gửi đi — cú bấm này KHÔNG gọi Viettel Post, KHÔNG làm vận đơn thành “đã hoàn”, KHÔNG tăng tồn kho, KHÔNG đổi doanh thu. Muốn gửi lệnh duyệt hoàn sang ĐVVC thì dùng khối “Thao tác Viettel Post”.",
  CARE_CONTINUE_DELIVERY:
    "GHI NHẬN: người xử lý muốn kiện được phát tiếp (khách đã hẹn lại, đã sửa địa chỉ, đã gọi bưu tá…). Cú bấm này KHÔNG gọi Viettel Post — muốn gửi yêu cầu phát lại thì dùng khối “Thao tác Viettel Post”.",
  CARE_FOLLOW_UP:
    "GHI NHẬN: chưa chốt được, hẹn giờ quay lại. Ca vẫn MỞ và trở về hàng đợi đúng giờ hẹn — nên bắt buộc phải có giờ, hẹn không giờ là ca chìm mất.",
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
export const RESOLUTION_TONE: Record<CareDecision, string> = {
  CARE_RETURN: "bg-red-100 text-red-900 dark:bg-red-950/70 dark:text-red-200",
  CARE_CONTINUE_DELIVERY: "bg-teal-100 text-teal-900 dark:bg-teal-950/70 dark:text-teal-200",
  CARE_FOLLOW_UP: "bg-amber-100 text-amber-900 dark:bg-amber-950/70 dark:text-amber-200",
};

/** Viền cho ô ĐANG CHỌN — nền không đủ: hai chế độ sáng/tối có độ tương phản nền rất khác nhau. */
export const RESOLUTION_RING: Record<CareDecision, string> = {
  CARE_RETURN: "border-red-400 dark:border-red-700",
  CARE_CONTINUE_DELIVERY: "border-teal-400 dark:border-teal-700",
  CARE_FOLLOW_UP: "border-amber-400 dark:border-amber-700",
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

export const RESOLUTION_NOTES_DEFAULT: Record<CareDecision, string[]> = {
  CARE_RETURN: ["Khách từ chối nhận", "Không liên lạc được nhiều lần", "Khách xác nhận không lấy nữa", "Duyệt hoàn về shop", "Bưu cục xác nhận hoàn"],
  CARE_CONTINUE_DELIVERY: ["Khách hẹn nhận chiều nay", "Khách hẹn nhận ngày mai", "Đã gọi bưu tá, hẹn phát lại", "Khách đổi số điện thoại", "Đã xác nhận lại địa chỉ", "Yêu cầu phát lại"],
  CARE_FOLLOW_UP: ["Chờ khách phản hồi", "Chờ bưu tá gọi lại", "Chờ CSKH xác minh", "Hẹn gọi lại sau", "Chờ Viettel Post cập nhật"],
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
export const RESOLUTION_FILTER_KEYS = ["none", ...CARE_DECISIONS] as const;
export type ResolutionFilterKey = (typeof RESOLUTION_FILTER_KEYS)[number];

export const RESOLUTION_FILTER_LABEL: Record<ResolutionFilterKey, string> = {
  none: "Chưa quyết định",
  CARE_RETURN: RESOLUTION_LABEL.CARE_RETURN,
  CARE_CONTINUE_DELIVERY: RESOLUTION_LABEL.CARE_CONTINUE_DELIVERY,
  CARE_FOLLOW_UP: RESOLUTION_LABEL.CARE_FOLLOW_UP,
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

/**
 * TRẠNG THÁI XỬ LÝ mà mỗi kết quả đưa ca tới — KHÔNG phải trạng thái ĐVVC.
 *
 * Giữ nguyên ba trạng thái đang chạy trên production, không thêm giá trị mới vào
 * `shipment_care.care_status` (cột có ràng buộc CHECK và dữ liệu thật). `CARE_FOLLOW_UP` đi tới
 * `WAITING_REDELIVERY` vì `CARE_WORKFLOW_LABEL` đã gọi đúng ô đó là "Theo dõi tiếp" từ bản 13/09 —
 * thêm một trạng thái thứ mười chỉ để đặt lại tên là làm mồ côi dữ liệu đang có.
 *
 * Chuyển KHÔNG hợp lệ (ca đã đóng) thì GIỮ NGUYÊN trạng thái cũ và vẫn ghi quyết định: kết quả xử
 * lý là lời khai của người, nó không được mất chỉ vì bảng chuyển trạng thái nói không.
 */
export const DECISION_NEXT_CARE_STATUS: Record<CareDecision, "WAITING_CARRIER" | "WAITING_REDELIVERY"> = {
  CARE_RETURN: "WAITING_CARRIER",
  CARE_CONTINUE_DELIVERY: "WAITING_REDELIVERY",
  CARE_FOLLOW_UP: "WAITING_REDELIVERY",
};

/**
 * ═══════════ KẾT QUẢ NÀO KẾT THÚC PHẦN VIỆC CỦA ĐỘI ═══════════
 *
 * Chủ shop báo 22/09/2026: ca đã bấm "Đã hoàn" vẫn nằm nguyên ở "Cần care", nhân viên vận đơn
 * không để ý thì **gọi lại khách một lần nữa cho một kiện đã chốt bỏ**.
 *
 * Nguyên nhân: cả ba kết quả đều đẩy ca vào một trạng thái CHỜ kèm một GIỜ HẸN, mà hễ hẹn tới giờ
 * là `careViewOf` kéo ca về "Cần care". Đúng với hai kết quả đầu — "Phát tiếp" phải quay lại để
 * xem bưu tá có đi thật không, "Xử lý sau" thì chính người trực đặt giờ. SAI với "Đã hoàn": shop
 * đã thôi cứu kiện, người mở ca ra không còn gì để làm, và thứ duy nhất còn thiếu là CHỨNG TỪ của
 * ĐVVC — thứ đến bằng webhook, không đến bằng việc một nhân viên mở lại ca lúc 9 giờ sáng.
 *
 * Nên "Đã hoàn" là kết quả DUY NHẤT không có giờ hẹn: ca rời "Cần care", nằm ở "Đang chờ kết quả"
 * cho tới khi ĐVVC chốt (`applyCarrierEventToCare` → `chotKetQua`), rồi sang "Đã xử lý".
 *
 * Ba điều nó KHÔNG làm, để không đọc nhầm thành một cái nút "đánh dấu xong":
 *
 *  · KHÔNG đóng đợt care (`active` giữ nguyên). Đóng đợt là bỏ dòng khỏi phép đọc `loadCareRows`
 *    (chỉ lấy đợt đang mở) ⇒ kiện còn trong rổ tháp giao vận sẽ hiện lại TRẮNG TRƠN ở "Chưa xử
 *    lý", đúng triệu chứng "mất note" của luật 60. Kết quả và note phải còn đứng trên dòng.
 *  · KHÔNG chốt `care_outcome`. Kết cục cứu đơn chỉ đọc chứng từ ĐVVC (luật 56).
 *  · KHÔNG giấu việc vĩnh viễn: kiện đứng im quá ngưỡng vẫn nổi lên ở hàng đợi đối chiếu
 *    (`/shipments?view=reconcile`, luật 53) — đó là hàng đợi hỏi "ERP có đang tin một điều không
 *    còn đúng không", câu hỏi khác hẳn "có cần gọi khách không".
 *
 * Đổi ý thì bấm "Phát tiếp" ngay trên dòng ở tab "Đang chờ kết quả" — nó cấp lại một giờ hẹn mới.
 */
export const DECISION_ENDS_TEAM_WORK: Record<CareDecision, boolean> = {
  CARE_RETURN: true,
  CARE_CONTINUE_DELIVERY: false,
  CARE_FOLLOW_UP: false,
};

/**
 * Kết quả nào BẮT BUỘC có lý do theo danh mục. Chỉ "Đã hoàn": suy lý do hoàn từ chứng từ ĐVVC chỉ
 * phủ ~22% vận đơn, phần còn lại chỉ người vừa gọi khách mới biết — bỏ bước đó thì báo cáo lý do
 * hoàn rỗng vĩnh viễn và không ai lấy lại được.
 */
export const DECISION_NEEDS_REASON: Record<CareDecision, boolean> = {
  CARE_RETURN: true,
  CARE_CONTINUE_DELIVERY: false,
  CARE_FOLLOW_UP: false,
};

/** Kết quả nào BẮT BUỘC có giờ hẹn. CSDL cũng chặn (`care_decisions_follow_up_check`). */
export const DECISION_NEEDS_FOLLOW_UP: Record<CareDecision, boolean> = {
  CARE_RETURN: false,
  CARE_CONTINUE_DELIVERY: false,
  CARE_FOLLOW_UP: true,
};

/**
 * ═══════════ LÝ DO HOÀN: CHỌN DANH MỤC, HOẶC NÓI RA BẰNG CHỮ ═══════════
 *
 * Chủ shop báo 21/09/2026: bấm "Đã hoàn", bấm một chip MẪU NHANH ("Khách từ chối nhận") hoặc gõ
 * tay ("bơm hàng"), nút "Ghi nhận Đã hoàn" vẫn xám. Hai thứ cùng lúc dựng nên bức tường ấy:
 *
 *   · Bảng LÝ DO HOÀN bị kẹp trong một ô cuộn cao 176px. Năm nhóm, chỉ ba nhóm đầu lọt vào tầm
 *     mắt — đúng hai nhóm bị cắt (**Cố ý boom hàng**, **Lý do khác**) lại là chỗ chứa "cố ý boom
 *     hàng" và "khách từ chối nhận", tức chính hai câu người dùng đang muốn nói.
 *   · Chip MẪU NHANH nằm ngay dưới, cùng kiểu dáng, nên bấm vào nó CẢM GIÁC như đã chọn lý do.
 *     Nó chỉ điền vào ô note. Màn hình thì đáp lại bằng một câu không nhắc gì tới note:
 *     "Chọn lý do rồi mới ghi nhận được."
 *
 * Luật thay thế: **lý do hoàn có thể đến từ DANH MỤC hoặc từ CHỮ CỦA NGƯỜI XỬ LÝ — nhưng không
 * bao giờ từ hư không.** Có note mà chưa chọn danh mục ⇒ ghi `OTHER` ("Lý do khác (có ghi chú)"),
 * và chính ô note là phần "có ghi chú" ấy. Không danh mục VÀ không note thì vẫn chặn: đó mới là
 * trường hợp đặc tả lo — một dòng hoàn không ai nói vì sao.
 *
 * `OTHER` CỐ Ý khác `UNKNOWN` (`lib/constants/return-reason.ts`): `OTHER` = đã hỏi, đã biết, chỉ
 * không nằm trong danh mục; `UNKNOWN` = chưa ai hỏi. Rơi về `UNKNOWN` ở đây là biến một câu trả
 * lời có thật của người trực thành một khoảng trống dữ liệu.
 *
 * HÀM THUẦN, một bản, hai chỗ gọi: màn hình dùng nó để quyết định nút có bấm được không, máy chủ
 * dùng chính nó để quyết định có ghi hay không. Hai bản riêng là mở đường cho màn hình cho bấm còn
 * máy chủ từ chối — hoặc ngược lại, tệ hơn: máy chủ ghi `null` trong khi người dùng tưởng đã khai.
 */
export const REASON_FROM_NOTE = "OTHER";

export type DecisionReason = { ok: true; reasonCode: string | undefined; fromNote: boolean } | { ok: false; error: string };

export function decisionReasonCode(decision: CareDecision, reasonCode: string | undefined | null, note: string | undefined | null): DecisionReason {
  const chon = reasonCode?.trim() || "";
  const chu = note?.trim() || "";
  if (!DECISION_NEEDS_REASON[decision]) return { ok: true, reasonCode: chon || undefined, fromNote: false };
  if (chon) return { ok: true, reasonCode: chon, fromNote: false };
  if (chu) return { ok: true, reasonCode: REASON_FROM_NOTE, fromNote: true };
  return { ok: false, error: "Chọn lý do hoàn trong danh mục, hoặc ghi một câu vào ô note — báo cáo lý do hoàn rỗng vĩnh viễn nếu bước này bỏ qua" };
}

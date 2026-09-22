import type { CareStatus } from "@/lib/constants/care";

/**
 * ═══════════ "ĐÃ XỬ LÝ MẤY LẦN RỒI" — MỘT ĐỊNH NGHĨA, ĐỌC RA LÚC XEM ═══════════
 *
 * Hàng đợi care trả lời được "kiện này cần người" nhưng chưa bao giờ trả lời được "đã có ai làm gì
 * với nó chưa, và làm mấy lần". Hậu quả đo được: thẻ "Backlog cần care" của Báo cáo hiệu quả care
 * gộp MỘT kiện chưa ai mở ra nhìn với MỘT kiện đã gọi khách ba lượt và đang chờ tới giờ hẹn. Hai
 * tình huống ấy đòi hai hành động trái ngược — một cái là "đi làm ngay", một cái là "đừng đụng
 * vào" — nên gộp chúng vào một con số là làm chủ shop đọc sai tình hình theo đúng hướng tệ nhất:
 * đội trông như không làm gì trong khi họ đã làm ba lượt.
 *
 * ─── VÌ SAO KHÔNG THÊM MỘT CỘT `round_count` ───
 *
 * Cùng ba lý do với `lib/constants/care-effect.ts` (kết cục ca), và lý do thứ ba vẫn là lý do thật:
 *
 *  1. Cột mới phải BACKFILL cho các đợt đang chạy ⇒ đoán, đúng thứ mục 35 cấm.
 *  2. Mọi đường ghi sau này (AI, job, thao tác hàng loạt) đều phải nhớ tăng nó; lần quên đầu tiên
 *     thì màn hình nói sai mà không ai biết.
 *  3. **Câu trả lời đổi khi dữ liệu đổi.** Nhân viên bổ sung một dòng hành động của hôm qua thì số
 *     lượt phải đổi theo. Một cột ghi cứng giữ mãi câu trả lời của lần chạy đầu tiên.
 *
 * Nên toàn bộ tệp này THUẦN: không đọc CSDL, không đọc đồng hồ ngầm, chạy hai lần ra cùng kết quả.
 */

/* ─────────────────────────── MỘT LƯỢT XỬ LÝ LÀ GÌ ─────────────────────────── */

/**
 * HAI SỔ ĐƯỢC TÍNH LÀ VIỆC, VÀ CHỈ HAI:
 *
 *  · `ACTION`   — một dòng `care_actions`: người ghi việc mình ĐÃ LÀM với khách (gọi · nhắn · sửa
 *                 địa chỉ · hẹn lại). Theo chính đặc tả của bảng đó, KHÔNG loại nào tự chạy.
 *  · `DECISION` — một dòng `care_decisions`: người bấm một KẾT QUẢ (Đã hoàn · Phát tiếp · Xử lý
 *                 sau). Đây là lời khai của người, ghi được cả khi ĐVVC không nhận lệnh.
 *
 * KHÔNG tính vào đây: đổi trạng thái, nhận việc, đặt hẹn. Chúng là "CHẠM VÀO" — đếm riêng ở
 * `touches`, theo đúng luật 57: gộp lại thì không phân biệt được *đội đã làm việc* với *đội đã
 * nhìn thấy*, và một trưởng nhóm bấm giao 50 ca trong ba phút sẽ làm 50 ca trông như đã xử lý.
 */
export const CARE_ROUND_KINDS = ["ACTION", "DECISION"] as const;
export type CareRoundKind = (typeof CARE_ROUND_KINDS)[number];

/**
 * CỬA SỔ GỘP — "gọi khách xong rồi bấm Phát tiếp" LÀ MỘT LẦN LÀM VIỆC, KHÔNG PHẢI HAI.
 *
 * `recordCareDecision` ghi vào `care_decisions`, `addCareNote` ghi vào `care_actions`. Hai đường
 * ghi khác nhau, nên một thao tác duy nhất của người trực (gọi khách → ghi note → bấm kết quả) để
 * lại HAI dòng ở hai sổ. Đếm thẳng số dòng thì "đã xử lý 2 lượt" thật ra là một lượt.
 *
 * Đây là ngưỡng TRÌNH BÀY (gộp dòng cho dễ đọc), KHÔNG phải ngưỡng nghiệp vụ kết luận đơn — nó
 * không đụng `RETURN_RULE`, không đụng `ORDER_OUTCOME`. Sửa ở ĐÚNG chỗ này, đừng gõ lại số 5.
 *
 * Căn cứ đo được trên production (xem `docs/care-rounds.md`): khoảng cách giữa hai ghi nhận liên
 * tiếp của cùng một kiện đứng thành hai cụm tách hẳn nhau — một cụm dưới vài phút (cùng một lần
 * ngồi làm) và một cụm tính bằng giờ / ngày (lần quay lại thật). Mix việc đổi thì ĐO LẠI rồi sửa
 * ở đây, đừng đoán.
 */
export const CARE_ROUND_MERGE_MINUTES = 5;

/**
 * Một ghi nhận thô, trước khi gộp. `actorId = null` = chưa nối tài khoản (luật 35) — vẫn là việc thật.
 *
 * `kind` KHÔNG tham gia phép đếm — nó ở đây để nơi gọi nói ra mình đang đếm sổ nào. Chính vì vậy
 * `careRoundCount` nhận một hình dạng RỘNG HƠN (`{ at, actorId }`): cùng luật gộp ấy còn dùng để
 * đếm "số lần chạm", và số lần chạm gồm cả những dòng không phải một lượt xử lý.
 */
export type CareRoundEntry = { at: Date; actorId: string | null; kind: CareRoundKind };

/**
 * ĐẾM SỐ LƯỢT XỬ LÝ. Hai ghi nhận CÙNG NGƯỜI cách nhau không quá cửa sổ gộp là MỘT lượt.
 *
 * `actorId` cùng `null` được coi là CÙNG NGƯỜI, và đó là lựa chọn THIÊN VỀ PHÍA ĐẾM THIẾU: hai
 * dòng cũ không nối được tài khoản có thể là hai người khác nhau, nhưng đếm thừa một lượt làm một
 * ca trông đã được xử lý nhiều hơn thực tế — tức là GIẤU việc. Đếm thiếu thì ca nổi lên hàng đợi
 * sớm hơn, và người trực mở ra thấy ngay là đã làm rồi. Sai về phía nào cũng là sai, nhưng chỉ một
 * trong hai chiều đó tự sửa được khi có người nhìn.
 */
export function careRoundCount(entries: readonly { at: Date; actorId: string | null }[], mergeMinutes: number = CARE_ROUND_MERGE_MINUTES): number {
  if (!entries.length) return 0;
  const xep = [...entries].sort((a, b) => a.at.getTime() - b.at.getTime());
  const cua = mergeMinutes * 60_000;
  let n = 1;
  let truoc = xep[0];
  for (let i = 1; i < xep.length; i += 1) {
    const nay = xep[i];
    const gopDuoc = nay.actorId === truoc.actorId && nay.at.getTime() - truoc.at.getTime() <= cua;
    if (!gopDuoc) n += 1;
    truoc = nay;
  }
  return n;
}

/**
 * ═══════════ CỘNG MỘT LƯỢT VỪA GHI, BẰNG ĐÚNG LUẬT MÁY CHỦ DÙNG ═══════════
 *
 * Bàn care KHÔNG tải lại trang sau mỗi thao tác — nó vá đúng dòng vừa đổi. Nhưng "đã xử lý mấy
 * lượt" là một phép đếm trên dữ liệu máy chủ, nên nếu trình duyệt không biết cộng thì người vừa
 * ghi note xong sẽ thấy note của mình hiện ra NGAY BÊN TRÊN dòng chữ "Chưa xử lý lần nào". Một
 * dòng tự mâu thuẫn với chính nó là cách nhanh nhất để người dùng thôi tin cả hai nửa.
 *
 * Cộng thêm một lượt KHÔNG cần đọc lại toàn bộ lịch sử: `careRoundCount` chỉ gộp hai ghi nhận LIỀN
 * KỀ, nên một ghi nhận mới ở CUỐI chỉ phải so với ghi nhận cuối cùng đang có. Hai dữ kiện đó
 * (`lastRoundAt`, `lastRoundActorId`) đi kèm sẵn trong `CareHistory`.
 *
 * Vẫn là HÀM THUẦN, vẫn là MỘT luật — không có bản sao nào của phép gộp ở phía trình duyệt.
 */
export function careRoundAppend(
  truoc: { rounds: number; lastRoundAt: Date | null; lastRoundActorId: string | null },
  moi: { at: Date; actorId: string | null },
  mergeMinutes: number = CARE_ROUND_MERGE_MINUTES,
): { rounds: number; lastRoundAt: Date; lastRoundActorId: string | null } {
  const gopDuoc =
    truoc.lastRoundAt !== null && truoc.rounds > 0 && moi.actorId === truoc.lastRoundActorId && moi.at.getTime() - truoc.lastRoundAt.getTime() <= mergeMinutes * 60_000;
  return { rounds: gopDuoc ? truoc.rounds : truoc.rounds + 1, lastRoundAt: moi.at, lastRoundActorId: moi.actorId };
}

/* ─────────────────────────── BĂNG LỌC ─────────────────────────── */

/**
 * BỐN RỔ. `0` đứng riêng tuyệt đối vì nó là rổ DUY NHẤT nói "chưa ai đụng vào" — mọi rổ còn lại
 * đều là "đã có người làm, câu hỏi chỉ là mấy lượt". Gộp `0` vào `1` là xoá mất đúng cái ranh giới
 * mà bộ lọc này sinh ra để vẽ.
 */
export const CARE_ROUND_BANDS = [
  { key: "0", label: "Chưa xử lý lần nào", min: 0, max: 0 },
  { key: "1", label: "Đã xử lý 1 lượt", min: 1, max: 1 },
  { key: "2", label: "Đã xử lý 2 lượt", min: 2, max: 2 },
  { key: "3plus", label: "Đã xử lý ≥ 3 lượt", min: 3, max: Number.POSITIVE_INFINITY },
] as const;
export type CareRoundBand = (typeof CARE_ROUND_BANDS)[number]["key"];
export const CARE_ROUND_BAND_KEYS = CARE_ROUND_BANDS.map((b) => b.key) as readonly CareRoundBand[];

export const CARE_ROUND_BAND_HINT: Record<CareRoundBand, string> = {
  "0": "Chưa ai ghi một hành động chăm sóc hay một kết quả nào cho ĐỢT NÀY. Đây là rổ phải mở đầu mỗi buổi.",
  "1": "Đã có đúng một lượt: một lần gọi / nhắn / sửa, hoặc một lần bấm kết quả.",
  "2": "Đã quay lại lần thứ hai. Kiện còn nằm đây nghĩa là lượt đầu chưa giải quyết được.",
  "3plus": "Từ ba lượt trở lên mà kiện vẫn chưa ngã ngũ. Gọi thêm một lượt nữa thường không đổi được gì — cân nhắc escalate hoặc chốt Đã hoàn.",
};

export function careRoundBand(n: number): CareRoundBand {
  const b = CARE_ROUND_BANDS.find((x) => n >= x.min && n <= x.max);
  return b?.key ?? "0";
}

/* ─────────────────────────── BA CÂU HỎI, BA CON SỐ ─────────────────────────── */

/**
 * ═══════════ "CÒN TREO" KHÔNG PHẢI MỘT CON SỐ, NÓ LÀ BA ═══════════
 *
 * Kiện đang ở góc nhìn "Cần care" rơi vào đúng một trong ba nhóm, và mỗi nhóm đòi một việc khác:
 *
 *   UNTOUCHED        chưa ai đụng             → đi làm, đây là backlog thật
 *   WORKED_DUE       đã xử lý, tới lượt lại    → đọc lại lượt trước rồi làm tiếp
 *   WORKED_SCHEDULED đã xử lý, đang trong hẹn  → ĐỪNG đụng, chưa tới giờ
 *
 * Nhóm thứ ba nằm trong "Cần care" chỉ vì trạng thái xử lý chưa được chuyển sang CHỜ — ghi note
 * không tự đổi trạng thái, và đúng ra nó không nên tự đổi (ghi note không phải một quyết định).
 * Nhưng nó KHÔNG phải việc của lúc này, nên đếm nó vào backlog là thổi phồng chính con số chủ shop
 * dùng để đánh giá đội.
 *
 * Hàm THUẦN, nhận `now` từ ngoài (luật 50: không ghim đồng hồ trong bài kiểm).
 */
export const CARE_BACKLOG_GROUPS = ["UNTOUCHED", "WORKED_DUE", "WORKED_SCHEDULED"] as const;
export type CareBacklogGroup = (typeof CARE_BACKLOG_GROUPS)[number];

export const CARE_BACKLOG_GROUP_LABEL: Record<CareBacklogGroup, string> = {
  UNTOUCHED: "Chưa ai đụng",
  WORKED_DUE: "Đã xử lý, tới lượt lại",
  WORKED_SCHEDULED: "Đã xử lý, đang trong hẹn",
};

export const CARE_BACKLOG_GROUP_HINT: Record<CareBacklogGroup, string> = {
  UNTOUCHED: "Không có lượt xử lý nào trong đợt này. Đây là con số trả lời đúng câu “còn bao nhiêu kiện chưa được care”.",
  WORKED_DUE: "Đã có người làm ít nhất một lượt, nhưng cái hẹn đã qua (hoặc chưa ai đặt hẹn) nên kiện quay lại hàng đợi. Là việc — nhưng là việc TIẾP TỤC, không phải việc mới.",
  WORKED_SCHEDULED: "Đã có người làm và đã hẹn giờ quay lại ở phía trước. KHÔNG phải việc của lúc này; đếm nó vào backlog là làm đội trông như đang bỏ bê đúng thứ họ vừa xử lý xong.",
};

export function careBacklogGroup(rounds: number, followUpAt: Date | null, now: Date): CareBacklogGroup {
  if (rounds <= 0) return "UNTOUCHED";
  // Một cái hẹn không có giờ không phải một cái hẹn — cùng luật với `careViewOf`.
  if (followUpAt !== null && followUpAt.getTime() > now.getTime()) return "WORKED_SCHEDULED";
  return "WORKED_DUE";
}

/* ─────────────────────────── DÒNG THỜI GIAN RÚT GỌN ─────────────────────────── */

/**
 * CHIỀU ĐVVC KHÔNG CÓ MẶT Ở ĐÂY.
 *
 * Luật 47: lời khai của ĐVVC và kết luận của ERP là hai thứ, không bao giờ gộp. Dòng thời gian
 * dưới đây là NHẬT KÝ CỦA ĐỘI (ai làm gì, đổi trạng thái gì) — hành trình Viettel Post nằm ở cột
 * "VTP báo" và ở ngăn kéo, dưới nhãn của chính nó. Trộn hai thứ vào một danh sách trên cùng một
 * dòng bảng là dựng lại đúng cái nhầm lẫn mà cả hệ thống đang chống.
 */
export const CARE_TIMELINE_KINDS = ["ACTION", "DECISION", "STATUS", "ASSIGN", "FOLLOW_UP", "CARRIER_REQUEST", "LIFECYCLE"] as const;
export type CareTimelineKind = (typeof CARE_TIMELINE_KINDS)[number];

export const CARE_TIMELINE_KIND_LABEL: Record<CareTimelineKind, string> = {
  ACTION: "Chăm sóc",
  DECISION: "Kết quả",
  STATUS: "Trạng thái",
  ASSIGN: "Giao việc",
  FOLLOW_UP: "Đặt hẹn",
  CARRIER_REQUEST: "Lệnh ĐVVC",
  LIFECYCLE: "Vòng đời ca",
};

/**
 * MÀU CHỮ, KHÔNG NỀN ĐẶC. Nền đặc trên bàn care đã thuộc về TRẠNG THÁI CARE (`CARE_STATUS_TONE`)
 * và KẾT QUẢ XỬ LÝ (`BUSINESS_ACTION_TONE`); thêm một dải nền thứ ba là dựng một thứ trông hệt cái
 * nhãn nhưng nói về chuyện khác — cùng lý do với chip hạn ở `lib/care/filters.ts`.
 */
export const CARE_TIMELINE_KIND_TONE: Record<CareTimelineKind, string> = {
  ACTION: "text-emerald-700 dark:text-emerald-300",
  DECISION: "text-sky-700 dark:text-sky-300",
  STATUS: "text-muted-foreground",
  ASSIGN: "text-muted-foreground",
  FOLLOW_UP: "text-indigo-700 dark:text-indigo-300",
  CARRIER_REQUEST: "text-violet-700 dark:text-violet-300",
  LIFECYCLE: "text-amber-700 dark:text-amber-300",
};

/** Dòng nào là một LƯỢT XỬ LÝ — DẪN XUẤT từ loại, không khai tay ở một chỗ thứ hai. */
export const CARE_TIMELINE_IS_ROUND: Record<CareTimelineKind, boolean> = {
  ACTION: true,
  DECISION: true,
  STATUS: false,
  ASSIGN: false,
  FOLLOW_UP: false,
  CARRIER_REQUEST: false,
  LIFECYCLE: false,
};

/**
 * SỐ DÒNG LỊCH SỬ ĐI KÈM MỖI KIỆN XUỐNG TRÌNH DUYỆT.
 *
 * Hàng đợi care gửi cả trăm kiện trong một lượt dựng; kèm nguyên nhật ký của từng kiện là nhân
 * kích thước gói dữ liệu lên nhiều lần để phục vụ một thứ người dùng chỉ mở ra ở vài dòng. Sáu
 * dòng đủ kể câu chuyện của một đợt thường gặp (mở → gọi → hẹn → gọi lại → chốt), và khi bị cắt
 * thì `timelineTruncated` NÓI RA — không bao giờ để người đọc tưởng mình đang nhìn toàn bộ.
 * Nhật ký đầy đủ nằm ở ngăn kéo, nơi chỉ tải đúng một kiện.
 */
export const CARE_TIMELINE_INLINE_MAX = 6;

/** Một dòng nhật ký care rút gọn, dùng chung cho hàng đợi và cho ngăn kéo. */
export type CareTimelineEntry = {
  at: Date;
  kind: CareTimelineKind;
  /** Nhãn ngắn đã dựng sẵn ở máy chủ: "Gọi — khách nghe máy", "Phát tiếp", "Chưa xử lý → Đang xử lý". */
  label: string;
  note: string;
  /**
   * TÊN người làm, đọc từ `users` ở máy chủ (luật 34). `""` kèm `bySystem = true` là MÁY làm; `""`
   * kèm `bySystem = false` là CHƯA NỐI TÀI KHOẢN. Hai thứ đó khác hẳn nhau nên KHÔNG được in ra
   * cùng một cụm chữ (luật 36).
   */
  actor: string;
  bySystem: boolean;
};

/** Nhãn "A → B" của một lần đổi trạng thái — dựng ở MỘT chỗ để hai màn hình không viết hai kiểu. */
export function careStatusArrow(from: CareStatus | null, to: CareStatus | null, label: Record<CareStatus, string>): string {
  if (to === null) return "";
  return from === null || from === to ? label[to] : `${label[from]} → ${label[to]}`;
}

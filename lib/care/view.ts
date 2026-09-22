import { CARE_SLA, CARE_TERMINAL_STATUSES, CARE_WAITING_STATUSES, type CareStatus, type CareView } from "@/lib/constants/care";
import { DECISION_ENDS_TEAM_WORK, type CareDecision } from "@/lib/constants/care-resolution";

/**
 * Luật thuần (không đụng CSDL) để cả máy chủ lẫn trình duyệt tính CÙNG một kết quả: kiện thuộc góc
 * nhìn nào, SLA còn hay đã vỡ. Client vá dòng sau mỗi hành động bằng đúng luật này — không cần tải lại.
 */
export type CareStateLike = {
  status: CareStatus;
  followUpAt: Date | null;
  doneAt: Date | null;
  firstResponseAt: Date | null;
  /**
   * Kết quả xử lý gần nhất của ĐỢT này (`CareState.lastDecision`). Optional vì hợp đồng
   * `CareState` khai nó optional — nơi gọi cũ không truyền thì coi như CHƯA AI QUYẾT, và nhánh
   * thiếu dữ kiện rơi về phía HIỆN RA chứ không phải phía giấu đi.
   */
  lastDecision?: { decision: CareDecision } | null;
  /**
   * MỐC LƯỢT XỬ LÝ ĐẦU TIÊN của đợt (`CareHistory.firstRoundAt`) — xem `teamResponded`.
   *
   * BA GIÁ TRỊ, BA NGHĨA, và đó là lý do trường này optional chứ không phải `Date | null` trơn:
   *   `undefined` = nơi gọi CHƯA ĐỌC lịch sử ⇒ lùi về cột `firstResponseAt` (hành vi cũ)
   *   `null`      = ĐÃ ĐỌC và KHÔNG có lượt nào ⇒ đội chưa phản hồi
   *   một `Date`  = lượt xử lý thật đầu tiên
   * Gộp hai nghĩa đầu lại là biến CHƯA BIẾT thành một khẳng định (luật 42).
   */
  firstRoundAt?: Date | null;
  /**
   * ĐVVC đã nói thêm điều gì kể từ lượt xử lý cuối (`CareHistory.carrierNewsAfterLastRound`).
   * `undefined` = chưa đọc được ⇒ coi như không có tin mới, tức giữ nguyên hành vi cũ.
   */
  carrierNewsAfterLastRound?: boolean;
};

/**
 * ĐỘI ĐÃ XONG PHẦN CỦA MÌNH CHƯA — một vị từ, ba nơi đọc.
 *
 * Ca mang kết quả "Đã hoàn" thì không còn việc nào cho người cho tới khi ĐVVC lên tiếng (xem
 * `DECISION_ENDS_TEAM_WORK`). Ba nơi phải cùng nghe một câu trả lời, nếu không màn hình sẽ đẩy ca
 * ra khỏi "Cần care" nhưng vẫn đếm nó vào số vỡ hạn — một cảnh báo không bấm vào đâu được.
 */
export function teamWorkEnded(care: CareStateLike): boolean {
  const d = care.lastDecision?.decision;
  return d !== undefined && d !== null && DECISION_ENDS_TEAM_WORK[d] === true;
}

/**
 * ═══════════ ĐỘI ĐÃ PHẢN HỒI CHƯA — ĐỌC THEO VIỆC ĐÃ LÀM, KHÔNG THEO MỘT CÚ BẤM GIAO VIỆC ═══════════
 *
 * `shipment_care.first_response_at` được `setCareOwner` ghi NGAY LÚC GIAO VIỆC. Đo production
 * 22/09/2026: **22 trong 25 đợt chưa xử lý lần nào vẫn mang mốc ấy**, tất cả đều ở `ASSIGNED` với
 * 0 hành động chăm sóc và 0 lần chạm. Hệ quả: 22 ca ấy KHÔNG BAO GIỜ bị tính vỡ hạn phản hồi đầu
 * dù chưa ai gọi một cuộc nào, và trung vị "phản hồi đầu" đo tốc độ BẤM GIAO VIỆC.
 *
 * Chủ shop chốt 22/09/2026: sửa Ở TẦNG ĐỌC. Cột trong CSDL GIỮ NGUYÊN — không migration, không
 * backfill (đoán là thứ mục 35 cấm), không mất một dòng lịch sử nào, và đảo ngược được bằng cách
 * thôi truyền `firstRoundAt`. Câu hỏi "đã phản hồi chưa" thì đọc theo LƯỢT XỬ LÝ thật.
 *
 * Nơi gọi chưa đọc lịch sử (`firstRoundAt === undefined`) lùi về cột cũ: một màn hình chưa cập
 * nhật phải giữ hành vi cũ chứ không được lặng lẽ kết luận "chưa ai phản hồi" cho mọi ca.
 */
export function teamResponded(care: CareStateLike, queueSince: Date): boolean {
  const moc = care.firstRoundAt !== undefined ? care.firstRoundAt : care.firstResponseAt;
  return moc !== null && moc.getTime() >= queueSince.getTime();
}

/**
 * ═══════════ CÁI HẸN CÒN HIỆU LỰC KHÔNG ═══════════
 *
 * Một cái hẹn là lời khai *"tôi đã làm phần mình, tới giờ đó tôi quay lại"*. Nó đứng trên bức
 * tranh của LÚC ĐẶT HẸN. Người trực gọi khách lúc 9 giờ rồi hẹn xem lại chiều mai; 10 giờ Viettel
 * Post báo phát hụt lần nữa — cái hẹn ấy không còn nói về tình trạng hiện tại của kiện nữa, nhưng
 * nó vẫn giữ ca nằm im tới chiều mai. Đo 22/09/2026: **3 trong 17 đợt đã xử lý** rơi vào đúng đó.
 *
 * Nên tin mới của ĐVVC làm HẾT HIỆU LỰC cái hẹn: ca quay lại "Cần care" để có người đọc lại.
 * Nó KHÔNG xoá cái hẹn (`follow_up_at` giữ nguyên) và KHÔNG ghi gì vào CSDL — đây là một câu hỏi
 * đọc ra lúc xem, nên nó tự đúng lại khi có người xử lý thêm một lượt.
 *
 * "Không có giờ hẹn" vẫn là KHÔNG CÓ HẸN, y như trước: một cái hẹn không có giờ không phải một
 * cái hẹn (đo 13/09/2026 — 16 ca chờ với `follow_up_at` NULL biến mất khỏi Cần care vĩnh viễn).
 */
export function followUpStillHolds(care: CareStateLike, now: Date): boolean {
  if (care.followUpAt === null || care.followUpAt.getTime() <= now.getTime()) return false;
  return care.carrierNewsAfterLastRound !== true;
}

export type CareSla = {
  firstResponseDueAt: Date;
  resolveDueAt: Date;
  firstResponseBreached: boolean;
  resolveBreached: boolean;
};

/**
 * Ngưỡng SLA đang hiệu lực. Mặc định lấy từ `CARE_SLA`; máy chủ đọc phần ghi đè của chủ shop qua
 * sổ hạn xử lý (`lib/care/sla.ts` → `getWorkConfig()`, luật 22) rồi truyền xuống — hàm thuần ở đây
 * không đọc CSDL nên trình duyệt và máy chủ vẫn tính cùng một kết quả trên cùng một bộ số.
 */
export type CareSlaHours = { firstResponseHours: number; resolveHours: number };
export const DEFAULT_CARE_SLA_HOURS: CareSlaHours = { firstResponseHours: CARE_SLA.firstResponseHours, resolveHours: CARE_SLA.resolveHours };

/**
 * Góc nhìn của một kiện đang trong điều kiện cần care:
 *  · NEW / ASSIGNED / IN_PROGRESS      → Cần care
 *  · WAITING_*                          → Đang chờ kết quả; tới hạn theo dõi thì về Cần care.
 *                                          KHÔNG có giờ hẹn = đã tới hạn: một cái hẹn không có giờ
 *                                          không phải một cái hẹn (đo 13/09/2026: 16 ca chờ với
 *                                          follow_up_at NULL biến mất khỏi Cần care vĩnh viễn)
 *  · ESCALATED                          → Escalated
 *  · RESOLVED / CANCELLED               → Đã xử lý; nhưng nếu kiện VÀO LẠI điều kiện cần care sau khi
 *                                          đóng (giao hụt mới) thì là "mở lại" và về Cần care
 */
export function careViewOf(care: CareStateLike, queueSince: Date, now = new Date()): { view: Exclude<CareView, "all">; reopened: boolean } {
  if (CARE_WAITING_STATUSES.includes(care.status)) {
    /*
      "ĐÃ HOÀN" ĐỨNG TRƯỚC LUẬT GIỜ HẸN.

      Luật dưới đây ("chờ mà hết hạn ⇒ về Cần care") sinh ra để cứu 16 ca chờ với `follow_up_at`
      NULL biến mất vĩnh viễn (13/09/2026). Nhưng nó không phân biệt được hai thứ khác hẳn nhau:
      ca CHƯA AI QUYẾT GÌ mà không có hẹn (phải hiện ra), và ca đội đã CHỐT BỎ (không còn việc cho
      người — chờ chứng từ ĐVVC). Trộn hai thứ đó lại thì nhân viên mở một ca đã chốt và gọi lại
      khách, đúng việc chủ shop báo ngày 22/09/2026.
    */
    if (teamWorkEnded(care)) return { view: "waiting", reopened: false };
    return { view: followUpStillHolds(care, now) ? "waiting" : "care", reopened: false };
  }
  if (care.status === "ESCALATED") return { view: "escalated", reopened: false };
  if (CARE_TERMINAL_STATUSES.includes(care.status)) {
    const reopened = care.doneAt !== null && queueSince.getTime() > care.doneAt.getTime();
    return { view: reopened ? "care" : "done", reopened };
  }
  return { view: "care", reopened: false };
}

export function slaOf(queueSince: Date, care: CareStateLike, now = new Date(), hours: CareSlaHours = DEFAULT_CARE_SLA_HOURS): CareSla {
  const firstResponseDueAt = new Date(queueSince.getTime() + hours.firstResponseHours * 3600_000);
  const resolveDueAt = new Date(queueSince.getTime() + hours.resolveHours * 3600_000);
  const responded = teamResponded(care, queueSince);
  // Ca mang kết quả "Đã hoàn" cũng đứng ở đây: đội đã chốt, đồng hồ ĐÓNG CA của họ dừng. Không
  // dừng thì ca rời "Cần care" nhưng vẫn cộng vào số vỡ hạn ở đầu trang — một con số đỏ mà bấm vào
  // không ra dòng nào, và người xem học cách bỏ qua cả ô đó.
  const closed = CARE_TERMINAL_STATUSES.includes(care.status) || care.status === "ESCALATED" || teamWorkEnded(care);
  // Đang CHỜ với một cái hẹn CÒN HIỆU LỰC: đội đã làm phần mình, đồng hồ đóng ca tạm dừng. Hẹn đã
  // qua, không có giờ hẹn, hoặc ĐVVC đã nói thêm điều gì sau lượt cuối ⇒ đồng hồ chạy tiếp. CÙNG
  // một vị từ với `careViewOf`: ca nào rời "Đang chờ" thì đồng hồ của nó cũng phải chạy lại, nếu
  // không thì nó nằm ở Cần care mà mãi mãi không bao giờ vỡ hạn.
  const paused = CARE_WAITING_STATUSES.includes(care.status) && followUpStillHolds(care, now);
  return {
    firstResponseDueAt,
    resolveDueAt,
    firstResponseBreached: !responded && now.getTime() > firstResponseDueAt.getTime(),
    resolveBreached: !closed && !paused && now.getTime() > resolveDueAt.getTime(),
  };
}

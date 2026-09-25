import { CARE_SLA, CARE_TERMINAL_STATUSES, CARE_WAITING_STATUSES, type CareStatus, type CareView } from "@/lib/constants/care";
import { DECISION_ENDS_TEAM_WORK, type CareDecision } from "@/lib/constants/care-resolution";
import { returnApproved } from "@/lib/constants/care-return-approval";
import type { CarrierSubstate } from "@/lib/constants/carrier-substate";

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
  /**
   * ĐVVC báo một lần GIAO HỤT MỚI sau lúc đội chốt kết quả gần nhất (mốc `DELIVERY_FAILED` mới nhất
   * của kiện muộn hơn `lastDecision.at`). `undefined` = chưa đọc được ⇒ coi như KHÔNG có.
   */
  carrierFailedAfterDecision?: boolean;
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
 * ═══════════ KẾT QUẢ ĐÃ CHỐT ⇒ CA NẰM Ở "ĐANG CHỜ KẾT QUẢ", KHÔNG Ở "CẦN CARE" ═══════════
 *
 * Chủ shop báo 25/09/2026 (tối): ca có kết quả "Phát tiếp", trạng thái "Chờ phát lại", vẫn đứng ở
 * "Cần care" vì giờ hẹn đã qua / ĐVVC có tin mới. Chủ shop chốt: ca đã xử lý và có kết quả trên
 * ERP thì về "Đang chờ kết quả" (hoặc "Đã xử lý"), không ở "Cần care".
 *
 *  · "Đã hoàn"   — đội hết việc, chờ chứng từ ĐVVC (`teamWorkEnded`).
 *  · "Phát tiếp" — đội đã làm phần mình, chờ bưu tá phát lại. Giờ hẹn qua hay tin ĐVVC thường
 *                  (trung chuyển, chờ xử lý…) KHÔNG kéo ca về; "Quá hẹn" vẫn hiện trên dòng và lọc
 *                  được ở tab chờ. Chỉ một lần GIAO HỤT MỚI sau lúc bấm mới là việc mới
 *                  (`carrierFailedAfterDecision`) ⇒ ca về "Cần care" để người quyết lại.
 *  · "Xử lý sau" — chính là một cái hẹn: tới giờ thì phải quay lại, giữ luật giờ hẹn như cũ.
 *
 * Chỉ áp khi ca ĐANG CHỜ (`CARE_WAITING_STATUSES`). Người đổi sang "Đang xử lý" là người đang cầm
 * việc ⇒ về "Cần care" như thường.
 */
export function decisionParksCase(care: CareStateLike): boolean {
  if (teamWorkEnded(care)) return true;
  return care.lastDecision?.decision === "CARE_CONTINUE_DELIVERY" && care.carrierFailedAfterDecision !== true;
}

/** Ca đang chờ có được nằm yên ở "Đang chờ kết quả" không — một vị từ cho góc nhìn, SLA và bộ lọc. */
export function waitingHolds(care: CareStateLike, now: Date): boolean {
  return CARE_WAITING_STATUSES.includes(care.status) && (decisionParksCase(care) || followUpStillHolds(care, now));
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
    return { view: waitingHolds(care, now) ? "waiting" : "care", reopened: false };
  }
  if (care.status === "ESCALATED") return { view: "escalated", reopened: false };
  if (CARE_TERMINAL_STATUSES.includes(care.status)) {
    const reopened = care.doneAt !== null && queueSince.getTime() > care.doneAt.getTime();
    return { view: reopened ? "care" : "done", reopened };
  }
  return { view: "care", reopened: false };
}

/**
 * ═══════════ KIỆN ĐANG QUAY ĐẦU MÀ KHÔNG CÒN VIỆC CHO NGƯỜI ⇒ RỜI "CẦN CARE" ═══════════
 *
 * Chủ shop báo 25/09/2026: kiện ERP đã chốt "Đã hoàn" và Viettel Post đang báo "Đang chuyển hoàn"
 * vẫn đứng ở "Cần care", mang nhãn "mở lại" + "vỡ SLA". Hai đường kéo nó vào:
 *   · ca đã đóng (Đã xong) bị `careViewOf` coi là MỞ LẠI vì mốc vào hàng đợi của ca đã đóng lấy
 *     theo TIN ĐVVC CUỐI — mà kiện trên đường hoàn thì ĐVVC gửi tin đều đặn (nhận ở bưu cục trung
 *     chuyển, chuyển tiếp…). Mỗi tin của chiều hoàn "mở lại" một ca đội đã chốt.
 *   · case khách ("Khách muốn trả / không nhận") còn mở thì kéo kiện vào, vì chiều hoàn CHƯA CHỐT
 *     (`isRunningHandoff`) — đúng, ĐVVC chưa báo 504.
 *
 * Kiện ở CHIỀU HOÀN (chặng `RETURNING` leg-aware, hoặc trạng thái con "Đang chuyển hoàn") hết việc
 * cho người khi MỘT trong hai điều sau đúng:
 *   · đội đã chốt kết quả "Đã hoàn" cho ĐỢT đang hiển thị (`teamWorkEnded`) — đội đã quyết cho
 *     hoàn, không còn cuộc gọi nào phải làm; hoặc
 *   · ĐVVC đã DUYỆT hoàn (502/515 — `returnApproved`, mục 66): từ mốc đó shop không còn cửa phát
 *     tiếp, ca đã được máy chốt `RESCUE_FAILED`.
 * 505 "Yêu cầu chuyển hoàn" mà đội CHƯA chốt gì thì VẪN là việc — shop còn bấm phát tiếp được.
 *
 * Luật này chỉ đổi GÓC NHÌN của hàng đợi. Nó KHÔNG đổi chặng vận đơn, KHÔNG đổi `ORDER_OUTCOME`,
 * không đưa món nào vào tồn — hàng chỉ thành hoàn khi ĐVVC báo 504 (luật 47, 66).
 *
 * Hàm thuần: máy chủ dựng hàng đợi và trình duyệt vá dòng sau cú bấm đọc CÙNG một câu, nên bấm
 * "Đã hoàn" trên một kiện đang chuyển hoàn thì dòng rời "Cần care" ngay, không đợi tải lại; còn
 * bấm "Mở lại" (đợt mới chưa có kết quả) thì nó quay về — người bấm mở lại là người thấy việc.
 */
export type CarrierLegLike = { stage: string; substate: CarrierSubstate; vtpStatus: number | null; rawStatus: string };

export function returnLegSettled(carrier: CarrierLegLike, care: CareStateLike): boolean {
  const chieuHoan = carrier.stage === "RETURNING" || carrier.substate === "RETURNING";
  if (!chieuHoan) return false;
  return teamWorkEnded(care) || returnApproved({ code: carrier.vtpStatus, text: carrier.rawStatus });
}

/**
 * GÓC NHÌN CỦA MỘT DÒNG HÀNG ĐỢI — một cửa cho máy chủ và trình duyệt.
 *
 * `inCareCondition = false` (kiện không còn trong rổ care nào) và kiện quay đầu đã hết việc đều
 * về "Đã xử lý"; còn lại đi theo trạng thái đợt care (`careViewOf`).
 */
export function queueViewOf(row: { inCareCondition: boolean; carrier: CarrierLegLike; queueSince: Date }, care: CareStateLike, now = new Date()): { view: Exclude<CareView, "all">; reopened: boolean } {
  if (!row.inCareCondition || returnLegSettled(row.carrier, care)) return { view: "done", reopened: false };
  return careViewOf(care, row.queueSince, now);
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
  const paused = waitingHolds(care, now);
  return {
    firstResponseDueAt,
    resolveDueAt,
    firstResponseBreached: !responded && now.getTime() > firstResponseDueAt.getTime(),
    resolveBreached: !closed && !paused && now.getTime() > resolveDueAt.getTime(),
  };
}

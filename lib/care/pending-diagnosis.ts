import type { ShipmentStage } from "@/db/schema";
import { CARE_TERMINAL_STAGES } from "@/lib/care/entry";
import { returnApproved } from "@/lib/constants/care-return-approval";

/**
 * ═══════════ MỘT CA "ĐANG TREO" ĐANG TREO VÌ ĐÂU ═══════════
 *
 * "Đang treo" ở báo cáo hiệu quả care = đợt chăm sóc mà ĐVVC CHƯA nói kết cục cuối. Nó KHÔNG phải
 * "Cần care" của hàng đợi, và chủ shop hỏi đúng câu đó (23/09/2026): vì sao hai con số không bằng
 * nhau. Hai câu hỏi khác nhau:
 *
 *   Cần care   — kiện NÀO đang cần NGƯỜI làm gì đó ngay bây giờ (grain KIỆN, một tab của hàng đợi).
 *   Đang treo  — đợt NÀO chưa có câu trả lời "cứu được hay không" (grain ĐỢT, theo chứng từ ĐVVC).
 *
 * Đo production 23/09/2026 (70 đợt đang treo): 64 đợt còn mở và rải qua nhiều tab của hàng đợi
 * (Cần care · Đang chờ kết quả · …), 6 đợt là lỗi chốt ca của ERP. Nên danh sách phải nói ra lý do
 * cho TỪNG dòng thay vì một câu giải thích chung:
 *
 *   · MỘT lý do là LỖI của ERP — đợt lẽ ra đã phải chốt:
 *       `CARRIER_FINISHED`  ĐVVC đã báo kết thúc (giao / hoàn / huỷ / đã duyệt hoàn) mà đợt vẫn
 *                           chưa chốt. Đo 23/09/2026: 6/70 (3 đợt người đã đóng trên kiện đã giao,
 *                           3 đợt cũ của kiện có nhiều đợt). Từ bản vá cùng ngày, bộ đối chiếu 10
 *                           phút/lần chốt cả đợt người đã đóng lẫn đợt cũ, nên nhóm này phải về 0 —
 *                           thấy nó trên màn hình là thấy bộ đối chiếu không chạy.
 *   · `SUPERSEDED`          đợt CŨ của một kiện đã có đợt mới hơn, kiện CHƯA kết thúc. Không phải
 *                           lỗi: nó được chốt cùng lúc với kiện. Phân loại bản sao / thật (luật 62)
 *                           là việc của phía ĐỌC, không phải của đường chốt.
 *   · `AWAITING_EXCHANGE`   kiện gốc đã quay về nhưng có ĐƠN ĐỔI đang chạy — vòng đời CỐ Ý chờ.
 *   · Còn lại: ca đang nằm ở ĐÂU trong hàng đợi. Câu trả lời lấy từ CHÍNH hàng đợi
 *     (`getCareQueue`), KHÔNG suy lại từ điều kiện mở ca: bản nháp đầu của hàm này dùng
 *     `careEntryFor` và gọi nhầm 31 ca đang mở trên kiện "Chờ xử lý" chiều hoàn là "kiện đang đi
 *     tiếp" — điều kiện MỞ ca không phải tập kiện của hàng đợi (vòng đời cố ý giữ ca mở trên chiều
 *     hoàn chưa duyệt, mục 66). Viết điều kiện thứ hai ở đây là để hai nơi nói hai điều.
 *
 * Hàm THUẦN: không đọc CSDL.
 */
export const PENDING_DIAGNOSES = ["CARRIER_FINISHED", "SUPERSEDED", "AWAITING_EXCHANGE", "QUEUE_CARE", "QUEUE_WAITING", "QUEUE_ESCALATED", "QUEUE_DONE", "OUT_OF_QUEUE"] as const;
export type PendingDiagnosis = (typeof PENDING_DIAGNOSES)[number];

/** Kiện đang ở tab nào của hàng đợi care — đọc từ `getCareQueue`, `null` = không có trong hàng đợi. */
export type QueueView = "care" | "waiting" | "escalated" | "done" | null;

export const PENDING_DIAGNOSIS_LABEL: Record<PendingDiagnosis, string> = {
  SUPERSEDED: "Đợt cũ — chốt cùng kiện",
  CARRIER_FINISHED: "ĐVVC đã kết thúc, ca chưa chốt",
  AWAITING_EXCHANGE: "Chờ kết cục đơn đổi",
  QUEUE_CARE: "Ở tab Cần care",
  QUEUE_WAITING: "Ở tab Đang chờ kết quả",
  QUEUE_ESCALATED: "Ở tab Escalated",
  QUEUE_DONE: "Đã đóng — chờ ĐVVC",
  OUT_OF_QUEUE: "Không nằm trong hàng đợi — chờ ĐVVC",
};

export const PENDING_DIAGNOSIS_HINT: Record<PendingDiagnosis, string> = {
  SUPERSEDED: "Kiện đã có một đợt chăm sóc mới hơn và chưa kết thúc. Đợt cũ này sẽ được chốt cùng lúc với kiện, theo đúng chứng từ Viettel Post — không phải việc nhân viên còn nợ.",
  CARRIER_FINISHED: "Viettel Post đã báo kết cục cuối nhưng đợt chưa được chốt. Bộ đối chiếu (10 phút/lần) lẽ ra đã chốt nó — lỗi của ERP, không phải việc nhân viên còn nợ.",
  AWAITING_EXCHANGE: "Kiện gốc đã quay về nhưng đội đã gửi đơn đổi. Ca chờ kết cục của đơn đổi mới kết luận cứu được hay không — đúng thiết kế.",
  QUEUE_CARE: "Kiện đang ở tab Cần care — việc đang chờ người làm.",
  QUEUE_WAITING: "Đội đã làm phần mình và hẹn xem lại; kiện nằm ở tab Đang chờ kết quả, KHÔNG ở Cần care.",
  QUEUE_ESCALATED: "Kiện đã được đẩy lên cấp trên; nằm ở tab Escalated, không ở Cần care.",
  QUEUE_DONE: "Nhân viên đã đóng ca; kiện nằm ở tab Đã xử lý. Kết quả cứu được hay không vẫn chờ chứng từ cuối của Viettel Post.",
  OUT_OF_QUEUE: "Kiện hiện không thuộc tab nào của hàng đợi (đang đi tiếp bình thường, hoặc đã đóng quá cửa sổ Đã xử lý). Không còn việc cho người; kết quả chờ chứng từ cuối của Viettel Post.",
};

/** Lý do nào là LỖI của ERP (đợt lẽ ra đã phải có kết quả). */
export const PENDING_DIAGNOSIS_IS_DEFECT: Record<PendingDiagnosis, boolean> = {
  SUPERSEDED: false,
  CARRIER_FINISHED: true,
  AWAITING_EXCHANGE: false,
  QUEUE_CARE: false,
  QUEUE_WAITING: false,
  QUEUE_ESCALATED: false,
  QUEUE_DONE: false,
  OUT_OF_QUEUE: false,
};

export type PendingCaseFacts = {
  episodeNo: number;
  /** Số thứ tự đợt LỚN NHẤT của cùng kiện. */
  latestEpisodeNo: number;
  stage: ShipmentStage;
  vtpStatus: number | null;
  vtpStatusName: string | null;
  /** Đợt có đơn đổi thay thế đang chạy. */
  hasReplacement: boolean;
  /** Kiện đang ở tab nào của hàng đợi (của KIỆN, nên chỉ có nghĩa với đợt mới nhất). */
  queueView: QueueView;
};

export function diagnosePending(f: PendingCaseFacts): PendingDiagnosis {
  const ketThuc = CARE_TERMINAL_STAGES.includes(f.stage) || (f.stage === "RETURNING" && returnApproved({ code: f.vtpStatus, text: f.vtpStatusName }));
  // Kiện gốc thất bại mà có đơn đổi: vòng đời CỐ Ý chưa kết luận. Kiện gốc đã giao thì không có lý do chờ.
  if (ketThuc && f.hasReplacement && f.stage !== "DELIVERED") return "AWAITING_EXCHANGE";
  if (ketThuc) return "CARRIER_FINISHED";
  // Tab hàng đợi là của KIỆN — chỉ đợt mới nhất mới đứng ở đó. Đợt cũ chờ kiện kết thúc.
  if (f.episodeNo < f.latestEpisodeNo) return "SUPERSEDED";
  if (f.queueView === "care") return "QUEUE_CARE";
  if (f.queueView === "waiting") return "QUEUE_WAITING";
  if (f.queueView === "escalated") return "QUEUE_ESCALATED";
  if (f.queueView === "done") return "QUEUE_DONE";
  return "OUT_OF_QUEUE";
}

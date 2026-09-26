import { and, eq, isNotNull, lte, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { audit } from "@/lib/audit";
import { approvalExecutedDedupeKey } from "@/lib/approvals/service";

/**
 * ═══════ DỌN LỜI DUYỆT KẸT GIỮA "GIỮ CHỖ" VÀ "THANH TOÁN" (Company OS · Agent N) ═══════
 *
 * Đường `DEFERRED` (`lib/approvals/execution.ts`) lật yêu cầu sang `EXECUTED` ở cổng để GIỮ CHỖ, rồi
 * thanh toán theo kết quả thật: xong ⇒ phát `approval.executed`; hỏng ⇒ trả về `APPROVED`. Tiến trình
 * chết đúng giữa hai bước (deploy khởi động lại container, hết bộ nhớ) thì yêu cầu nằm `EXECUTED` mà
 * không có sự kiện — phía an toàn, nhưng không ai dọn: người xin bị kẹt, không làm lại được mà cũng
 * không xin lại được (lời duyệt đã "dùng").
 *
 * Lượt dọn chạy trong job `alerts` (10 phút/lần — KHÔNG thêm lịch). Một yêu cầu được trả lại CHỈ KHI
 * cả bốn điều kiện cùng đúng, kiểm TRONG MỘT câu UPDATE (hai lượt dọn chồng nhau ⇒ một hiệu lực):
 *
 *  1. `status = 'EXECUTED'`.
 *  2. KHÔNG có `approval.executed` — dấu hiệu THÀNH CÔNG dứt khoát. Có sự kiện thì không bao giờ động
 *     vào, dù cũ đến đâu (cùng hàng rào với `releaseApprovalExecution`).
 *  3. Nhật ký cổng khai lượt tiêu thụ là `DEFERRED` (dòng `approval.execute:*`, `detail.settlement`).
 *     Hai đường kia (`IMMEDIATE`, `IN_TRANSACTION`) lật + phát sự kiện TRONG CÙNG giao dịch nên không
 *     kẹt được; còn yêu cầu `EXECUTED` từ TRƯỚC khi `approval.executed` LIVE (Agent K) cũng không có sự
 *     kiện — nhưng chúng ĐÃ chạy thật, và nhật ký của chúng không mang `settlement`. Thiếu điều kiện
 *     này là hồi sinh lời duyệt của những việc đã làm xong. (Tiến trình chết TRƯỚC khi kịp ghi dòng
 *     nhật ký cổng ⇒ yêu cầu nằm lại `EXECUTED` — phía an toàn, đếm được.)
 *  4. Giữ chỗ từ quá `APPROVAL_RESERVATION_TIMEOUT_MINUTES` phút (`executed_at`).
 */

/**
 * HẠN GIỮ CHỖ — tham số KỸ THUẬT, không phải ngưỡng nghiệp vụ. Một server action có cổng duyệt chạy
 * trong một request HTTP: proxy phía trước cắt request sau vài phút, và thao tác nặng nhất (chốt kỳ
 * lương, nhập phiếu kho nhiều dòng) đo bằng giây. 120 phút là hơn hai bậc độ lớn trên thời gian chạy
 * dài nhất có thể — đủ để không bao giờ trả lại lời duyệt của một thao tác CÒN ĐANG CHẠY (trả lại lúc
 * ấy thì lượt khẳng định sau đó hụt và lời duyệt dùng được lần hai) — mà vẫn nhỏ so với hạn 72 giờ của
 * lời duyệt, nên người xin còn gần trọn hạn để làm lại.
 */
export const APPROVAL_RESERVATION_TIMEOUT_MINUTES = 120;

/**
 * Câu ghi vào `execution_error`. Nói rõ việc CÓ THỂ đã được ghi một phần hoặc trọn vẹn: tiến trình chết
 * SAU khi thao tác ghi xong mà TRƯỚC khi kịp khẳng định cũng để lại đúng dấu vết này.
 */
export const STUCK_RESERVATION_ERROR = "Máy dừng giữa lúc thực thi — lời duyệt được trả lại. Kiểm tra việc đã được ghi chưa trước khi làm lại.";

/** Mốc mà giữ chỗ TRƯỚC nó là đã quá hạn. */
export function reservationStaleBefore(now: Date): Date {
  return new Date(now.getTime() - APPROVAL_RESERVATION_TIMEOUT_MINUTES * 60_000);
}

export type ReservationSweepResult = { released: string[] };

/** Trả lời duyệt kẹt về `APPROVED` + `execution_error`. Lũy đẳng; gọi lại không đổi gì thêm. */
export async function releaseStuckApprovalReservations(db: Db, now: Date = new Date()): Promise<ReservationSweepResult> {
  const a = schema.approvalRequests;
  const ev = schema.domainEvents;
  const log = schema.auditLogs;
  const rows = await db
    .update(a)
    .set({ status: "APPROVED", executedAt: null, executionError: STUCK_RESERVATION_ERROR })
    .where(
      and(
        eq(a.status, "EXECUTED"),
        isNotNull(a.executedAt),
        lte(a.executedAt, reservationStaleBefore(now)),
        sql`not exists (select 1 from ${ev} where ${ev.dedupeKey} = ${approvalExecutedDedupeKey("")} || ${a.id})`,
        sql`exists (select 1 from ${log} where ${log.entity} = 'APPROVAL_REQUEST' and ${log.entityId} = ${a.id} and ${log.action} like 'approval.execute:%' and ${log.detail} ->> 'settlement' = 'DEFERRED')`,
      ),
    )
    .returning({ id: a.id, group: a.group, action: a.action });
  for (const r of rows) {
    await audit({
      userId: null,
      userEmail: "system:approval-reservation-sweep",
      actorKind: "SYSTEM",
      action: `approval.reservation_released:${r.action}`,
      entity: "APPROVAL_REQUEST",
      entityId: r.id,
      correlationId: r.id,
      reason: `Giữ chỗ quá ${APPROVAL_RESERVATION_TIMEOUT_MINUTES} phút mà không có approval.executed — tiến trình đã dừng giữa lúc thực thi; lời duyệt trả lại để người xin làm lại.`,
      detail: { group: r.group, executionError: STUCK_RESERVATION_ERROR },
    });
  }
  return { released: rows.map((r) => r.id) };
}

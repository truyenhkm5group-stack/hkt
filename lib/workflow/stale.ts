/**
 * ═══════════ LƯỢT CHẠY TREO — CHẨN ĐOÁN (Phase 3.1) — CHỈ MÁY CHỦ, CHỈ ĐỌC ═══════════
 *
 * Bốn loại, mỗi loại một câu trả lời khác cho "vì sao lượt này chưa xong" — gộp thành một ô "treo" là mất khả
 * năng sửa đúng chỗ:
 *  · `LEASE_EXPIRED`        — PENDING mà quá hạn giữ: tiến trình thực thi đã chết giữa chừng. Lượt kế tiếp của
 *                             bộ máy tự chiếm lại (tối đa `WORKFLOW_MAX_ATTEMPTS` lần); còn nằm đây nghĩa là luật
 *                             đang tạm dừng / về chạy thử, hoặc chưa tới lượt kế tiếp.
 *  · `DECISION_NOT_APPLIED` — WAITING_APPROVAL mà lời duyệt đã có kết quả (duyệt / từ chối / hết hạn) quá
 *                             `STALE_DECISION_MINUTES` rồi vẫn chưa được xử lý: bộ máy không chạy (module Cần xử lý
 *                             tắt, job cảnh báo hỏng) hoặc luật đang tạm dừng.
 *  · `UNSETTLED_APPROVAL`   — lượt đã chốt (DONE / FAILED / SKIPPED) mà lời duyệt vẫn APPROVED, chưa thanh toán
 *                             (không `executed_at`, không `execution_error`):
 *                             tiến trình chết giữa lúc chốt lượt và lúc thanh toán. Lượt kế tiếp tự thanh toán.
 *  · `STUCK_FAILED`         — FAILED vì treo (quá số lần thử, hoặc hành động chưa chứng minh được lũy đẳng) trong
 *                             `STALE_FAILED_WINDOW_DAYS` ngày gần nhất: người phải xem, máy không thử nữa.
 *
 * Mọi mốc so bằng `now()` của CSDL (không phải đồng hồ tiến trình): hai máy lệch giờ vẫn nói cùng một điều.
 * Hàm nhận `Db` để chẩn đoán CLI chỉ-đọc (`platform:diagnostics`) dùng lại đúng câu hỏi này trên CSDL tổ chức
 * nó tự mở — không có luật thứ hai.
 */
import { and, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { WORKFLOW_LEASE_MINUTES, WORKFLOW_STUCK_ERROR_PREFIX } from "@/lib/workflow/types";

/** Lời duyệt đã có kết quả bao lâu mà lượt chạy chưa xử lý thì coi là treo — ba nhịp của job cảnh báo. */
export const STALE_DECISION_MINUTES = 30;
/** Lượt FAILED vì treo còn hiện trong cảnh báo bao nhiêu ngày (sau đó chỉ còn ở bảng lượt chạy của luật). */
export const STALE_FAILED_WINDOW_DAYS = 7;

export const STALE_RUN_KINDS = ["LEASE_EXPIRED", "DECISION_NOT_APPLIED", "UNSETTLED_APPROVAL", "STUCK_FAILED"] as const;
export type StaleRunKind = (typeof STALE_RUN_KINDS)[number];

export const STALE_RUN_KIND_LABEL: Record<StaleRunKind, string> = {
  LEASE_EXPIRED: "Đang chạy thì dừng — quá hạn giữ",
  DECISION_NOT_APPLIED: "Đã có lời duyệt mà chưa xử lý",
  UNSETTLED_APPROVAL: "Đã chạy xong, lời duyệt chưa thanh toán",
  STUCK_FAILED: "Dừng vì treo — máy không thử nữa",
};

export type StaleRun = {
  id: string;
  ruleId: string;
  kind: StaleRunKind;
  status: string;
  attempt: number;
  leaseUntil: Date | null;
  subjectType: string | null;
  subjectId: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const LEASE_INTERVAL = sql.raw(`interval '${WORKFLOW_LEASE_MINUTES} minutes'`);

/**
 * Điều kiện "PENDING và quá hạn giữ" — MỘT định nghĩa cho cả bộ máy (chiếm lại) lẫn chẩn đoán. Dòng PENDING cũ
 * (trước 0162) không có hạn giữ ⇒ tính hạn từ `updated_at`.
 */
export function leaseExpiredSql(): SQL {
  const r = schema.workflowRuns;
  return sql`(${r.status} = 'PENDING' and coalesce(${r.leaseUntil}, ${r.updatedAt} + ${LEASE_INTERVAL}) < now())`;
}

export async function staleRunsOn(db: Db, opts: { limit?: number } = {}): Promise<StaleRun[]> {
  const r = schema.workflowRuns;
  const a = schema.approvalRequests;
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 500));
  const decidedLongAgo = sql`${a.decidedAt} < now() - ${sql.raw(`interval '${STALE_DECISION_MINUTES} minutes'`)}`;
  const kind = sql<StaleRunKind>`case
    when ${leaseExpiredSql()} then 'LEASE_EXPIRED'
    when ${r.status} = 'WAITING_APPROVAL' then 'DECISION_NOT_APPLIED'
    when ${r.status} = 'FAILED' and ${r.error} like ${`${WORKFLOW_STUCK_ERROR_PREFIX}%`} then 'STUCK_FAILED'
    else 'UNSETTLED_APPROVAL' end`;
  const rows = await db
    .select({
      id: r.id,
      ruleId: r.ruleId,
      kind,
      status: r.status,
      attempt: r.attempt,
      leaseUntil: r.leaseUntil,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      error: r.error,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })
    .from(r)
    .leftJoin(a, eq(a.id, r.approvalRequestId))
    .where(
      or(
        leaseExpiredSql(),
        and(eq(r.status, "WAITING_APPROVAL"), inArray(a.status, ["APPROVED", "REJECTED", "EXPIRED"]), decidedLongAgo),
        and(
          inArray(r.status, ["DONE", "FAILED", "SKIPPED"]),
          isNotNull(r.approvalRequestId),
          eq(a.status, "APPROVED"),
          isNull(a.executedAt),
          // Lượt hỏng đã thanh toán BẰNG LỖI (lời duyệt giữ APPROVED + executionError — không bị tính là đã làm) ⇒ không treo.
          isNull(a.executionError),
          sql`coalesce(${r.finishedAt}, ${r.updatedAt}) < now() - ${sql.raw(`interval '${STALE_DECISION_MINUTES} minutes'`)}`,
        ),
        and(eq(r.status, "FAILED"), sql`${r.error} like ${`${WORKFLOW_STUCK_ERROR_PREFIX}%`}`, sql`${r.updatedAt} > now() - ${sql.raw(`interval '${STALE_FAILED_WINDOW_DAYS} days'`)}`),
      ),
    )
    .orderBy(desc(r.updatedAt), desc(r.id))
    .limit(limit);
  return rows.map((x) => ({ ...x, kind: x.kind as StaleRunKind }));
}

/** Số lượt treo theo loại — cho dòng cảnh báo và chẩn đoán CLI. */
export async function countStaleRunsOn(db: Db): Promise<{ total: number; byKind: Record<StaleRunKind, number> }> {
  const rows = await staleRunsOn(db, { limit: 500 });
  const byKind = Object.fromEntries(STALE_RUN_KINDS.map((k) => [k, 0])) as Record<StaleRunKind, number>;
  for (const x of rows) byKind[x.kind] += 1;
  return { total: rows.length, byKind };
}

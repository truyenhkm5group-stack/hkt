import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, like, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { approvalExecutionNote } from "@/lib/approvals/execution-note";
import { approvalValidSince } from "@/lib/approvals/service";
import { APPROVAL_GROUP_LABEL, type ApprovalGroup } from "@/lib/constants/approval";

/**
 * ═══════ ĐỌC SỔ YÊU CẦU PHÊ DUYỆT — MỘT TRUY VẤN CHO HAI MÀN HÌNH ═══════
 *
 * Mục "việc chờ duyệt" ở trang Cần xử lý (`listPendingApprovals`) và nguồn việc `APPROVAL` trên
 * `/work` (`adaptApprovals`) đọc CÙNG hàm này. Hai truy vấn viết riêng thì một ngày hai màn hình sẽ
 * nói hai con số khác nhau về cùng một hàng chờ (AGENTS.md mục 8.12).
 *
 * `decidedSince`: kèm các yêu cầu ĐÃ quyết từ mốc đó (thẻ điểm cần việc đã đóng trong cửa sổ).
 */
export type ApprovalRequestRow = typeof schema.approvalRequests.$inferSelect;

export async function listApprovalRequests(opts: { includeDecided?: boolean; decidedSince?: Date | null; limit?: number } = {}): Promise<ApprovalRequestRow[]> {
  const db = await getDb();
  const a = schema.approvalRequests;
  let where: SQL | undefined = eq(a.status, "PENDING");
  if (opts.includeDecided) where = undefined;
  else if (opts.decidedSince) where = or(eq(a.status, "PENDING"), gte(a.decidedAt, opts.decidedSince));
  return db
    .select()
    .from(a)
    .where(where)
    .orderBy(desc(a.requestedAt))
    .limit(opts.limit ?? 300);
}


/**
 * ═══════ LỜI DUYỆT ĐÃ BỊ TRẢ LẠI — CÒN DÙNG ĐƯỢC, KÈM CÂU LỖI (Company OS · Agent N) ═══════
 *
 * `APPROVED` + `execution_error` + chưa thực thi + còn trong hạn duyệt: lời duyệt đã quay về tay người
 * xin sau một lần thực thi không hoàn tất. Làm lại ĐÚNG việc sẽ dùng nó — nên đây đúng là lúc người xin
 * và người duyệt phải thấy câu lỗi. Hết hạn duyệt thì lời duyệt không mở khoá được gì nữa (phải xin lại),
 * nên không còn đường làm lại mù — không liệt kê.
 */
export async function listReturnedApprovals(now: Date, limit = 50): Promise<ApprovalRequestRow[]> {
  const db = await getDb();
  const a = schema.approvalRequests;
  return db
    .select()
    .from(a)
    .where(and(eq(a.status, "APPROVED"), isNotNull(a.executionError), isNull(a.executedAt), gt(a.decidedAt, approvalValidSince(now))))
    .orderBy(desc(a.decidedAt))
    .limit(limit);
}

/**
 * LÚC lời duyệt bị trả lại — dòng nhật ký gần nhất của lượt hỏng (`approval.execute_failed:*`) hoặc lượt
 * dọn (`approval.reservation_released:*`). `execution_error` không có cột thời điểm riêng; không có dòng
 * nhật ký ⇒ không có trong Map ⇒ CHƯA BIẾT (không đoán bằng `decided_at`).
 */
export async function approvalFailureTimes(ids: readonly string[]): Promise<Map<string, Date>> {
  if (!ids.length) return new Map();
  const db = await getDb();
  const l = schema.auditLogs;
  const rows = await db
    .select({ id: l.entityId, at: sql<Date>`max(${l.createdAt})` })
    .from(l)
    .where(and(eq(l.entity, "APPROVAL_REQUEST"), inArray(l.entityId, [...ids]), or(like(l.action, "approval.execute_failed:%"), like(l.action, "approval.reservation_released:%"))))
    .groupBy(l.entityId);
  return new Map(rows.filter((r) => r.at).map((r) => [r.id, new Date(r.at)]));
}

/** Một dòng của mục "việc chờ duyệt" trên trang Cần xử lý. */
export type ApprovalSectionItem = {
  id: string;
  group: ApprovalGroup;
  groupLabel: string;
  summary: string;
  amount: number | null;
  requestedByEmail: string;
  requestedAt: Date;
  /** Người đang xem có được duyệt việc này không — người xin thì KHÔNG; lời duyệt đã trả lại thì không còn gì để duyệt. */
  canDecide: boolean;
  /** `true` = đã duyệt, lời duyệt bị TRẢ LẠI sau lần thực thi không hoàn tất (xem `listReturnedApprovals`). */
  returned: boolean;
  /** Người đang xem là người xin. */
  isRequester: boolean;
  /** Câu nhắc (`approvalExecutionNote`) — `null` khi không có `execution_error`. */
  executionNote: string | null;
  /** Lúc lần thực thi hỏng / bị dọn — `null` = chưa biết. */
  executionFailedAt: Date | null;
};

/**
 * Dữ liệu của mục "việc chờ duyệt": yêu cầu ĐANG CHỜ + lời duyệt ĐÃ TRẢ LẠI (kèm câu nhắc và lúc hỏng).
 * Tách khỏi server action để kiểm thử chạy được đúng đường đọc thật (không phiên đăng nhập).
 */
export async function listApprovalSectionItems(viewer: { id: string; canDecide: boolean }, now: Date, limit = 50): Promise<ApprovalSectionItem[]> {
  const [cho, traLai] = await Promise.all([listApprovalRequests({ limit }), listReturnedApprovals(now, limit)]);
  const luc = await approvalFailureTimes([...cho, ...traLai].filter((r) => r.executionError).map((r) => r.id));
  const map = (r: ApprovalRequestRow, returned: boolean): ApprovalSectionItem => ({
    id: r.id,
    group: r.group as ApprovalGroup,
    groupLabel: APPROVAL_GROUP_LABEL[r.group as ApprovalGroup] ?? r.group,
    summary: r.summary,
    amount: r.amount ?? null,
    requestedByEmail: r.requestedByEmail,
    requestedAt: r.requestedAt,
    canDecide: !returned && viewer.canDecide && r.requestedBy !== viewer.id,
    returned,
    isRequester: r.requestedBy === viewer.id,
    executionNote: approvalExecutionNote(r.executionError),
    executionFailedAt: luc.get(r.id) ?? null,
  });
  return [...cho.map((r) => map(r, false)), ...traLai.map((r) => map(r, true))];
}

import { desc, eq, gte, or, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";

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


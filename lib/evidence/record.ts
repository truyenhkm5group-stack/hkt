import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { CASE_TEAM, caseTypeOf, type CaseTeam } from "@/lib/constants/action-queue";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ GHI BẰNG CHỨNG HÀNH ĐỘNG ═══════════
 *
 * Nằm NGOÀI `lib/queries/*` một cách cố ý: thư mục đó chỉ được đọc, và `tests/audit-trail` khoá
 * điều đó ở mức mã nguồn. Đây là phép GHI, nên nó ở đây, và chỉ được gọi từ Server Action đã kiểm
 * quyền — cùng lý do mà lớp tư vấn không được tự sửa dữ liệu.
 *
 * Phần ĐỌC (báo cáo năng suất) ở `lib/queries/action-evidence.ts`.
 */

export type EvidenceInput = {
  notificationId: string;
  kind: string;
  entityType: string;
  entityId: string;
  detectedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date;
  actorId: string;
  actorEmail: string;
};

/**
 * Ghi một dòng bằng chứng khi người dùng đóng việc.
 *
 * Chụp lại TIỀN ĐANG TREO và KẾT QUẢ ĐƠN ngay lúc đóng — cả hai đều đổi được về sau, và một bảng
 * năng suất đọc giá trị hôm nay để nói về việc làm tháng trước là một bảng nói dối.
 *
 * `onConflictDoNothing` theo `notification_id`: bấm đóng hai lần không thành hai công.
 */
export async function ghiBangChung(input: EvidenceInput): Promise<void> {
  const db = await getDb();
  const type = caseTypeOf(input.kind);
  const team: CaseTeam = CASE_TEAM[type] ?? "DATA";

  // Tiền và kết quả đơn CHỈ tra được khi việc gắn với một đơn hoặc một vận đơn.
  let moneyAtRisk: number | null = null;
  let outcome: string | null = null;
  if (input.entityType === "ORDER" && input.entityId) {
    const [r] = rowsOf<{ tien: string | number | null; ket: string | null }>(
      await db.execute(sql`
        select o.total_price_after_discount as tien,
               (select m.outcome from canonical_order_outcome m where m.order_id = o.id limit 1) as ket
          from orders o where o.id = ${input.entityId}
      `),
    );
    moneyAtRisk = r?.tien === null || r?.tien === undefined ? null : Number(r.tien);
    outcome = r?.ket ?? null;
  } else if (input.entityType === "SHIPMENT" && input.entityId) {
    const [r] = rowsOf<{ tien: string | number | null }>(
      await db.execute(sql`select cod_amount as tien from shipments where id = ${input.entityId}`),
    );
    moneyAtRisk = r?.tien === null || r?.tien === undefined ? null : Number(r.tien);
  }

  const gio = input.detectedAt ? Math.max(0, Math.round((input.completedAt.getTime() - input.detectedAt.getTime()) / 3_600_000)) : null;

  await db
    .insert(schema.actionEvidence)
    .values({
      notificationId: input.notificationId,
      caseType: type,
      team,
      entityType: input.entityType,
      entityId: input.entityId,
      actorId: input.actorId,
      actorEmail: input.actorEmail,
      detectedAt: input.detectedAt,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      hoursToClose: gio,
      moneyAtRisk,
      outcomeAtClose: outcome,
    })
    .onConflictDoNothing({ target: schema.actionEvidence.notificationId });
}

import { desc, eq, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  CASE_ACTION,
  CASE_TYPE_LABEL,
  ageLabel,
  caseScore,
  caseTypeOf,
  priorityOf,
  type CasePriority,
  type CaseStatus,
  type CaseType,
} from "@/lib/constants/action-queue";

/**
 * HÀNG ĐỢI VIỆC — một danh sách duy nhất, xếp theo mức ưu tiên tính được.
 *
 * Nguồn là bảng `notifications` (đã có cơ chế chống trùng và tự đóng khi điều kiện hết), nên
 * không sinh thêm một bảng việc thứ hai để rồi hai nơi lệch nhau.
 *
 * BA TRẠNG THÁI TÁCH BẠCH, và trước đây chúng bị gộp làm một:
 *  · ĐÃ ĐỌC        — có người nhìn thấy (`read_by`);
 *  · ĐÃ TIẾP NHẬN  — có người nhận xử lý (`acknowledged_*`);
 *  · ĐÃ XONG       — việc đã xử lý xong (`resolved_at`).
 * "Đọc rồi" không có nghĩa là "có người làm".
 */

const n = schema.notifications;

export type ActionCase = {
  id: string;
  type: CaseType;
  typeLabel: string;
  entityType: string;
  entityId: string;
  priority: CasePriority;
  score: number;
  severity: string;
  title: string;
  /** Vì sao việc này xuất hiện. */
  reason: string;
  detectedAt: Date;
  ageHours: number;
  ageLabel: string;
  status: CaseStatus;
  /** Ai đang cầm việc. `null` = chưa ai nhận. */
  owner: { id: string; name: string } | null;
  acknowledgedBy: string | null;
  recommendedAction: string;
  href: string;
};

export type ActionQueue = {
  cases: ActionCase[];
  totals: Record<CasePriority, number>;
  byType: { type: CaseType; label: string; count: number }[];
  /** Việc chưa ai nhận — con số quan trọng nhất của một hàng đợi. */
  unassigned: number;
  /** Việc quá 3 ngày chưa ai nhận. */
  neglected: number;
};

/** Số tiền liên quan tới việc, nếu tra được — dùng cho phần "giá trị tiền" của điểm ưu tiên. */
async function amountsFor(entityIds: string[]): Promise<Map<string, number>> {
  if (!entityIds.length) return new Map();
  const db = await getDb();
  const rows = await db
    .select({ id: schema.orders.id, amount: schema.orders.totalPriceAfterDiscount })
    .from(schema.orders)
    .where(sql`${schema.orders.id} in ${entityIds}`);
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.id, Number(r.amount ?? 0));
  const shipments = await db
    .select({ id: schema.shipments.id, amount: schema.shipments.codAmount })
    .from(schema.shipments)
    .where(sql`${schema.shipments.id} in ${entityIds}`);
  for (const r of shipments) map.set(r.id, Number(r.amount ?? 0));
  return map;
}

export async function getActionQueue(options: { limit?: number; assignedTo?: string } = {}): Promise<ActionQueue> {
  const db = await getDb();
  const limit = options.limit ?? 200;
  const rows = await db
    .select({
      id: n.id,
      kind: n.kind,
      severity: n.severity,
      title: n.title,
      body: n.body,
      href: n.href,
      entityType: n.entityType,
      entityId: n.entityId,
      occurredAt: n.occurredAt,
      createdAt: n.createdAt,
      assignedTo: n.assignedTo,
      assignedAt: n.assignedAt,
      acknowledgedBy: n.acknowledgedBy,
      acknowledgedAt: n.acknowledgedAt,
      ownerName: schema.users.name,
      ownerEmail: schema.users.email,
    })
    .from(n)
    .leftJoin(schema.users, eq(schema.users.id, n.assignedTo))
    .where(options.assignedTo ? sql`${n.resolvedAt} is null and ${n.assignedTo} = ${options.assignedTo}` : isNull(n.resolvedAt))
    .orderBy(desc(n.createdAt))
    .limit(limit);

  const amounts = await amountsFor([...new Set(rows.map((r) => r.entityId).filter(Boolean))]);
  const now = Date.now();

  const cases: ActionCase[] = rows.map((r) => {
    const type = caseTypeOf(r.kind);
    const detectedAt = r.occurredAt ?? r.createdAt;
    const ageHours = Math.max(0, (now - detectedAt.getTime()) / 3_600_000);
    const score = caseScore({ severity: r.severity, ageHours, amount: amounts.get(r.entityId) ?? null, type });
    return {
      id: r.id,
      type,
      typeLabel: CASE_TYPE_LABEL[type],
      entityType: r.entityType,
      entityId: r.entityId,
      priority: priorityOf(score),
      score,
      severity: r.severity,
      title: r.title,
      reason: r.body,
      detectedAt,
      ageHours,
      ageLabel: ageLabel(ageHours),
      status: r.acknowledgedAt ? "ACKNOWLEDGED" : "OPEN",
      owner: r.assignedTo ? { id: r.assignedTo, name: r.ownerName || r.ownerEmail || r.assignedTo } : null,
      acknowledgedBy: r.acknowledgedBy,
      recommendedAction: CASE_ACTION[type],
      href: r.href,
    };
  });

  cases.sort((a, b) => b.score - a.score || b.ageHours - a.ageHours);

  const totals: Record<CasePriority, number> = { URGENT: 0, HIGH: 0, NORMAL: 0, LOW: 0 };
  const byTypeMap = new Map<CaseType, number>();
  let unassigned = 0;
  let neglected = 0;
  for (const c of cases) {
    totals[c.priority] += 1;
    byTypeMap.set(c.type, (byTypeMap.get(c.type) ?? 0) + 1);
    if (!c.owner) {
      unassigned += 1;
      if (c.ageHours > 72) neglected += 1;
    }
  }
  const byType = [...byTypeMap.entries()]
    .map(([type, count]) => ({ type, label: CASE_TYPE_LABEL[type], count }))
    .sort((a, b) => b.count - a.count);

  return { cases, totals, byType, unassigned, neglected };
}

import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { DEPARTMENT_LABEL, type DepartmentCode } from "@/lib/constants/departments";
import { getScorecard, type Scorecard } from "@/lib/queries/bsc";
import { listObjectives, type ObjectiveView } from "@/lib/queries/okr";
import { getDepartmentCockpit, type DepartmentHealth } from "@/lib/queries/work";
import { getPerformance, type WorkerScorecard } from "@/lib/queries/work-performance";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ KỲ REVIEW — VÀ TẠI SAO PHẢI CÓ ẢNH CHỤP ═══════════
 *
 * AGENTS.md mục 8.9: *không silent correction kỳ đã chốt*.
 *
 * Nếu báo cáo tháng 9 được dựng bằng truy vấn của tháng 11 thì mỗi lần ai đó sửa một công thức,
 * con số tháng 9 ÂM THẦM đổi — và cuộc họp tháng 10 đã diễn ra trên một con số không còn tồn tại.
 * Chuyện này không phải giả định: `canonical_order_outcome` có hẳn cột `logic_version` vì luật kết
 * quả đơn đã đổi nhiều lần trong đời kho mã này.
 *
 * Nên: `DRAFT` tính sống mỗi lần mở; `FINAL` **chỉ đọc `snapshot`**, không truy vấn lại gì cả.
 * Ràng buộc `review_cycles_final_check` không cho phép một kỳ `FINAL` mà thiếu ảnh chụp.
 */

export const REVIEW_KINDS = ["WEEKLY", "MONTHLY", "QUARTERLY"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export const REVIEW_KIND_LABEL: Record<ReviewKind, string> = {
  WEEKLY: "Review tuần",
  MONTHLY: "Review tháng",
  QUARTERLY: "Review quý",
};

/** Phiên bản logic dựng ảnh chụp. Đổi cấu trúc `ReviewSnapshot` thì TĂNG số này. */
export const SNAPSHOT_VERSION = 1;

export type ReviewSnapshot = {
  version: number;
  builtAt: string;
  periodFrom: string;
  periodTo: string;
  departments: DepartmentHealth[];
  objectives: ObjectiveView[];
  scorecard: Scorecard | null;
  people: WorkerScorecard[];
  /** Nguồn không đọc được lúc chụp. Ảnh chụp thiếu mảng nào thì phải nói ra, không im lặng. */
  failedSources: string[];
};

export type ReviewView = {
  id: string;
  kind: ReviewKind;
  scope: "COMPANY" | "DEPARTMENT";
  departmentCode: DepartmentCode | null;
  departmentName: string;
  period: string;
  periodStart: Date;
  periodEnd: Date;
  status: "DRAFT" | "FINAL";
  /** `true` = số đọc từ ảnh chụp, KHÔNG tính lại. */
  frozen: boolean;
  snapshot: ReviewSnapshot;
  highlights: string;
  issues: string;
  nextActions: string;
  finalizedAt: Date | null;
  finalizedByName: string;
};

/** Dựng ảnh chụp của một kỳ từ dữ liệu HIỆN TẠI. Chỉ gọi khi kỳ còn `DRAFT` hoặc lúc chốt. */
export async function buildSnapshot(opts: { from: Date; to: Date; department: DepartmentCode | null; departmentId: string | null; okrPeriod: string }): Promise<ReviewSnapshot> {
  const metricPeriod: Period = { key: "custom", from: opts.from, to: opts.to, label: "Kỳ review", fromKey: null, toKey: null };
  const [cockpit, objectives, scorecard, people] = await Promise.all([
    getDepartmentCockpit(),
    listObjectives({ period: opts.okrPeriod, departmentId: opts.departmentId ?? undefined }, metricPeriod),
    getScorecard({ scope: opts.department ? "DEPARTMENT" : "COMPANY", departmentId: opts.departmentId, period: opts.okrPeriod }, metricPeriod),
    getPerformance({ from: opts.from, to: opts.to, department: opts.department }),
  ]);
  return {
    version: SNAPSHOT_VERSION,
    builtAt: new Date().toISOString(),
    periodFrom: opts.from.toISOString(),
    periodTo: opts.to.toISOString(),
    departments: opts.department ? cockpit.rows.filter((r) => r.department === opts.department) : cockpit.rows,
    objectives,
    scorecard,
    people,
    failedSources: cockpit.failedSources.map((f) => `${f.source}: ${f.error}`),
  };
}

export async function getReview(id: string): Promise<ReviewView | null> {
  const db = await getDb();
  const row = await db.query.reviewCycles.findFirst({ where: eq(schema.reviewCycles.id, id) });
  if (!row) return null;
  const dept = row.departmentId ? await db.query.departments.findFirst({ where: eq(schema.departments.id, row.departmentId), columns: { code: true, name: true } }) : null;
  const finalizedBy = row.finalizedBy ? await db.query.users.findFirst({ where: eq(schema.users.id, row.finalizedBy), columns: { name: true } }) : null;
  const deptCode = (dept?.code as DepartmentCode | undefined) ?? null;

  /*
    KỲ ĐÃ CHỐT: ĐỌC ẢNH CHỤP, KHÔNG TÍNH LẠI.

    Đây là toàn bộ lý do bảng này tồn tại. Gọi `buildSnapshot` ở đây cho kỳ `FINAL` là xoá sạch giá
    trị của việc chốt kỳ — và làm nó một cách vô hình.
  */
  const snapshot =
    row.status === "FINAL" && row.snapshot
      ? (row.snapshot as ReviewSnapshot)
      : await buildSnapshot({ from: row.periodStart, to: row.periodEnd, department: deptCode, departmentId: row.departmentId, okrPeriod: row.period });

  return {
    id: row.id,
    kind: row.kind as ReviewKind,
    scope: row.scope as "COMPANY" | "DEPARTMENT",
    departmentCode: deptCode,
    departmentName: dept?.name ?? (deptCode ? DEPARTMENT_LABEL[deptCode] : "Toàn shop"),
    period: row.period,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    status: row.status as "DRAFT" | "FINAL",
    frozen: row.status === "FINAL",
    snapshot,
    highlights: row.highlights,
    issues: row.issues,
    nextActions: row.nextActions,
    finalizedAt: row.finalizedAt,
    finalizedByName: finalizedBy?.name ?? "",
  };
}

export async function listReviews(opts: { departmentId?: string | null; limit?: number } = {}) {
  const db = await getDb();
  const r = schema.reviewCycles;
  const conds = opts.departmentId === undefined ? [] : [opts.departmentId === null ? isNull(r.departmentId) : eq(r.departmentId, opts.departmentId)];
  return db
    .select({
      id: r.id,
      kind: r.kind,
      scope: r.scope,
      period: r.period,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      status: r.status,
      departmentName: schema.departments.name,
      finalizedAt: r.finalizedAt,
    })
    .from(r)
    .leftJoin(schema.departments, eq(schema.departments.id, r.departmentId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(r.periodStart))
    .limit(opts.limit ?? 30);
}

/** Khoảng thời gian của một kỳ, giờ Việt Nam. Tuần ISO bắt đầu thứ Hai. */
export function periodRange(kind: ReviewKind, at: Date = new Date()): { period: string; start: Date; end: Date } {
  const vn = new Date(at.getTime() + 7 * 3_600_000);
  const y = vn.getUTCFullYear();
  const m = vn.getUTCMonth();
  if (kind === "MONTHLY") {
    return { period: `${y}-${String(m + 1).padStart(2, "0")}`, start: new Date(Date.UTC(y, m, 1, -7)), end: new Date(Date.UTC(y, m + 1, 1, -7) - 1) };
  }
  if (kind === "QUARTERLY") {
    const q = Math.floor(m / 3);
    return { period: `${y}-Q${q + 1}`, start: new Date(Date.UTC(y, q * 3, 1, -7)), end: new Date(Date.UTC(y, (q + 1) * 3, 1, -7) - 1) };
  }
  const dow = vn.getUTCDay() === 0 ? 7 : vn.getUTCDay();
  const monday = new Date(Date.UTC(y, m, vn.getUTCDate() - (dow - 1), -7));
  const end = new Date(monday.getTime() + 7 * 24 * 3_600_000 - 1);
  const thursday = new Date(Date.UTC(y, m, vn.getUTCDate() - (dow - 1) + 3));
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { period: `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`, start: monday, end };
}

/** Kỳ chỉ số tương ứng một kỳ review — để mọi con số trong review nói về đúng khoảng đó. */
export function metricPeriodOf(start: Date, end: Date): Period {
  return { key: "custom", from: start, to: end, label: "Kỳ review", fromKey: null, toKey: null };
}

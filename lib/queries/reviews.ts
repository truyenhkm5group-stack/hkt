import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { DEPARTMENT_LABEL, type DepartmentCode } from "@/lib/constants/departments";
import { getScorecard, type Scorecard } from "@/lib/queries/bsc";
import { listObjectives, type ObjectiveView } from "@/lib/queries/okr";
import { slaStateOf } from "@/lib/constants/work";
import { collectWorkItems } from "@/lib/queries/work-adapters";
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

/**
 * Phiên bản logic dựng ảnh chụp. Đổi cấu trúc `ReviewSnapshot` thì TĂNG số này.
 *
 * v2 thêm `totals` · `bottleneck` · `topIssues` để cuộc họp tuần đọc được trên MỘT màn hình. Ảnh
 * chụp v1 vẫn đọc được: `normalizeSnapshot` dựng lại `totals` và `bottleneck` từ bảng phòng ban
 * (dữ liệu v1 đã có đủ), còn `topIssues` để rỗng kèm lời nói rõ — KHÔNG tính lại từ hôm nay, vì
 * tính lại là sửa ngầm một kỳ đã chốt.
 */
export const SNAPSHOT_VERSION = 2;

/** Con số toàn kỳ, cộng từ bảng phòng ban — để dòng đầu cuộc họp không phải tự cộng nhẩm. */
export type ReviewTotals = {
  open: number;
  overdue: number;
  blocked: number;
  unassigned: number;
  moneyAtRisk: number;
  /** Số việc CHƯA TRA ĐƯỢC tiền. `moneyAtRisk` đứng trên phần còn lại, và người đọc phải biết. */
  moneyUnknown: number;
};

/**
 * NÚT THẮT: phòng đang chặn cả guồng, và VÌ SAO là phòng đó.
 *
 * Không chọn theo số việc nhiều nhất — phòng đông việc nhất thường là phòng bận nhất, không phải
 * phòng kẹt nhất. Chọn theo TỶ LỆ QUÁ HẠN, cùng thước mà `healthOf` đã dùng, để hai chỗ không nói
 * hai câu khác nhau về cùng một phòng.
 */
export type ReviewBottleneck = { department: DepartmentCode; label: string; reason: string; overdue: number; open: number; blocked: number } | null;

/** Việc đáng mang ra họp: gấp nhất, giữ nhiều tiền nhất, và AI đang cầm nó. */
export type ReviewIssue = { key: string; title: string; department: DepartmentCode; owner: string; moneyAtRisk: number | null; overdue: boolean; url: string; source: string };

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
  /* ───── v2 ───── */
  totals: ReviewTotals;
  bottleneck: ReviewBottleneck;
  topIssues: ReviewIssue[];
};

export function totalsOf(departments: DepartmentHealth[]): ReviewTotals {
  return departments.reduce<ReviewTotals>(
    (acc, d) => ({
      open: acc.open + d.open,
      overdue: acc.overdue + d.overdue,
      blocked: acc.blocked + d.blocked,
      unassigned: acc.unassigned + d.unassigned,
      moneyAtRisk: acc.moneyAtRisk + d.money.atRisk,
      moneyUnknown: acc.moneyUnknown + d.money.unknown,
    }),
    { open: 0, overdue: 0, blocked: 0, unassigned: 0, moneyAtRisk: 0, moneyUnknown: 0 },
  );
}

export function bottleneckOf(departments: DepartmentHealth[]): ReviewBottleneck {
  const ungVien = departments.filter((d) => d.open > 0 && (d.overdue > 0 || d.blocked > 0));
  if (!ungVien.length) return null;
  const worst = [...ungVien].sort((a, b) => b.overdue / b.open - a.overdue / a.open || b.blocked - a.blocked)[0];
  const tyLe = Math.round((worst.overdue / worst.open) * 100);
  return {
    department: worst.department,
    label: worst.label,
    reason:
      worst.blocked >= 5
        ? `${worst.blocked} việc BỊ CHẶN — nút thắt nội bộ, gỡ được ngay trong cuộc họp này`
        : `${tyLe}% việc của phòng đã quá hạn (${worst.overdue}/${worst.open})`,
    overdue: worst.overdue,
    open: worst.open,
    blocked: worst.blocked,
  };
}

/**
 * Đọc một ảnh chụp bất kỳ phiên bản nào về hình dạng hiện tại.
 *
 * Trường v2 thiếu thì DỰNG LẠI TỪ CHÍNH ẢNH CHỤP (bảng phòng ban đã có đủ số), tuyệt đối không
 * truy vấn lại hôm nay: một kỳ đã chốt mà đọc số của hôm nay là đúng thứ AGENTS.md mục 8.9 cấm.
 * `topIssues` không dựng lại được từ v1 nên để rỗng — giao diện nói rõ "ảnh chụp đời cũ".
 */
export function normalizeSnapshot(raw: ReviewSnapshot): ReviewSnapshot {
  return {
    ...raw,
    totals: raw.totals ?? totalsOf(raw.departments ?? []),
    bottleneck: raw.bottleneck ?? bottleneckOf(raw.departments ?? []),
    topIssues: raw.topIssues ?? [],
  };
}

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
  /** Kỳ ĐÃ CHỐT gần nhất cùng loại và cùng phạm vi. `null` = chưa có kỳ nào để so. */
  previous: { period: string; totals: ReviewTotals } | null;
};

/** Dựng ảnh chụp của một kỳ từ dữ liệu HIỆN TẠI. Chỉ gọi khi kỳ còn `DRAFT` hoặc lúc chốt. */
export async function buildSnapshot(opts: { from: Date; to: Date; department: DepartmentCode | null; departmentId: string | null; okrPeriod: string }): Promise<ReviewSnapshot> {
  const metricPeriod: Period = { key: "custom", from: opts.from, to: opts.to, label: "Kỳ review", fromKey: null, toKey: null };
  const [cockpit, objectives, scorecard, people, queue] = await Promise.all([
    getDepartmentCockpit(),
    listObjectives({ period: opts.okrPeriod, departmentId: opts.departmentId ?? undefined }, metricPeriod),
    getScorecard({ scope: opts.department ? "DEPARTMENT" : "COMPANY", departmentId: opts.departmentId, period: opts.okrPeriod }, metricPeriod),
    getPerformance({ from: opts.from, to: opts.to, department: opts.department }),
    collectWorkItems(),
  ]);
  const departments = opts.department ? cockpit.rows.filter((r) => r.department === opts.department) : cockpit.rows;

  /*
    TOP ISSUE: VIỆC MANG RA HỌP, KÈM TÊN NGƯỜI.

    Xếp theo ĐIỂM ƯU TIÊN (đã gộp mức nghiêm trọng, tuổi việc, tiền và khả năng cứu được) chứ không
    theo số tiền: việc giữ nhiều tiền nhưng đã hết cứu được thì mang ra họp cũng không đổi được gì.
    Năm dòng, vì một cuộc họp tuần không xử lý nổi hơn năm việc — danh sách dài hơn là danh sách
    không ai làm.
  */
  const topIssues: ReviewIssue[] = queue.items
    .filter((i) => (opts.department ? i.department === opts.department : true))
    .filter((i) => i.status !== "DONE" && i.status !== "CANCELLED")
    .filter((i) => slaStateOf(i.slaAt ?? i.dueAt, opts.to) === "BREACHED" || i.priority === "URGENT" || i.status === "BLOCKED")
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((i) => ({
      key: i.key,
      title: i.title,
      department: i.department,
      owner: i.assignee?.name ?? "",
      moneyAtRisk: i.money.atRisk,
      overdue: slaStateOf(i.slaAt ?? i.dueAt, opts.to) === "BREACHED",
      url: i.sourceUrl,
      source: i.sourceType,
    }));

  return {
    version: SNAPSHOT_VERSION,
    builtAt: new Date().toISOString(),
    periodFrom: opts.from.toISOString(),
    periodTo: opts.to.toISOString(),
    departments,
    objectives,
    scorecard,
    people,
    failedSources: cockpit.failedSources.map((f) => `${f.source}: ${f.error}`),
    totals: totalsOf(departments),
    bottleneck: bottleneckOf(departments),
    topIssues,
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
  const snapshot = normalizeSnapshot(
    row.status === "FINAL" && row.snapshot
      ? (row.snapshot as ReviewSnapshot)
      : await buildSnapshot({ from: row.periodStart, to: row.periodEnd, department: deptCode, departmentId: row.departmentId, okrPeriod: row.period }),
  );

  /*
    ═══ SO VỚI KỲ TRƯỚC — CON SỐ QUAN TRỌNG NHẤT CỦA MỘT CUỘC HỌP TUẦN ═══

    "38 việc quá hạn" không nói lên điều gì. "38, tuần trước 52" nói rằng phòng đang gỡ được; "38,
    tuần trước 19" nói rằng đang hỏng. Chỉ so với kỳ CÙNG LOẠI và CÙNG PHẠM VI — so tuần với quý
    là so hai thứ khác nhau — và chỉ với kỳ ĐÃ CHỐT: một kỳ nháp tính sống, nên "kỳ trước" của nó
    sẽ đổi mỗi lần mở trang và cái mũi tên tăng/giảm thành vô nghĩa.
  */
  const truoc = await db.query.reviewCycles.findFirst({
    where: and(
      eq(schema.reviewCycles.kind, row.kind),
      eq(schema.reviewCycles.status, "FINAL"),
      row.departmentId ? eq(schema.reviewCycles.departmentId, row.departmentId) : isNull(schema.reviewCycles.departmentId),
      lt(schema.reviewCycles.periodStart, row.periodStart),
    ),
    orderBy: [desc(schema.reviewCycles.periodStart)],
  });
  const previous = truoc?.snapshot
    ? { period: truoc.period, totals: normalizeSnapshot(truoc.snapshot as ReviewSnapshot).totals }
    : null;

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
    previous,
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

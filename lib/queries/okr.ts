import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { DepartmentCode } from "@/lib/constants/departments";
import { krProgress, metricBinding, type MetricTrust, type MetricUnit } from "@/lib/constants/metric-bindings";
import { resolveMetrics } from "@/lib/queries/metric-resolver";
import { KR_CONFIDENCES, OKR_LEVELS, OKR_STATUSES, type KrConfidence, type OkrLevel, type OkrStatus } from "@/lib/constants/okr";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ OKR — BA TẦNG, VÀ MỘT LUẬT VỀ SỰ TRUNG THỰC ═══════════
 *
 * Objective là ĐỊNH TÍNH ("giao hàng đáng tin hơn"); Key Result là ĐỊNH LƯỢNG ("GTC ≥ 92%"). Trộn
 * hai thứ là cách nhanh nhất biến OKR thành một danh sách KPI đội lốt.
 *
 * ─── `current = null` KHÔNG BAO GIỜ ĐƯỢC HIỂN THỊ THÀNH 0% ───
 *
 * Một KR chưa đo được và một KR đang ở 0% là hai tình huống đối lập: cái đầu là *ta không biết*,
 * cái sau là *ta đang thất bại*. Hiện cả hai bằng một thanh tiến độ rỗng là trộn chúng lại, và
 * người đọc sẽ hành động sai ở đúng một nửa số trường hợp. Nên `progress` trả `null`, và giao diện
 * in "chưa đo được" chứ không vẽ thanh.
 */

export type KeyResultView = {
  id: string;
  title: string;
  metricSource: string;
  metricLabel: string;
  /** `MANUAL` = người nhập; còn lại là mức tin cậy của chỉ số trong sổ đăng ký. */
  trust: MetricTrust;
  /** Câu nói con số này ở đâu ra. Rỗng với KR nhập tay chưa khai. */
  basis: string;
  unit: MetricUnit;
  direction: "UP" | "DOWN";
  baseline: number | null;
  target: number;
  current: number | null;
  currentAt: Date | null;
  /** `null` = CHƯA ĐO ĐƯỢC. Không kẹp trên 100% — vượt đích là sự thật đáng thấy. */
  progress: number | null;
  confidence: KrConfidence;
  ownerName: string;
  /** Cảnh báo độ phủ của chỉ số `ESTIMATED`; rỗng khi không có gì phải cảnh báo. */
  note: string;
};

export type ObjectiveView = {
  id: string;
  level: OkrLevel;
  title: string;
  description: string;
  departmentCode: DepartmentCode | null;
  departmentName: string;
  ownerName: string;
  period: string;
  status: OkrStatus;
  keyResults: KeyResultView[];
  /**
   * Tiến độ Objective = TRUNG BÌNH tiến độ các KR ĐO ĐƯỢC, **mỗi KR kẹp ở 100% khi cộng vào**.
   *
   * Hai luật khác nhau, và cả hai đều cần:
   *
   *  · Ở TỪNG KR, phần trăm KHÔNG kẹp — vượt đích 150% là một sự thật đáng thấy.
   *  · Ở MỨC OBJECTIVE, mỗi KR chỉ đóng góp tối đa 100%. Nếu không, một KR vượt đích sẽ che một KR
   *    đang chết: ba KR ở 150% / 0% / 0% sẽ hiện 50%, nghe như "đi được nửa đường", trong khi thực
   *    tế hai phần ba mục tiêu chưa nhúc nhích. Objective là AND, không phải trung bình cộng.
   *
   * KR chưa đo KHÔNG bị tính là 0: làm thế thì một Objective có 3 KR tốt và 1 KR chưa nối chỉ số
   * sẽ hiện 75% trong khi thực tế nó đang 100% trên phần đo được. `measuredCount` nói rõ trung
   * bình này đứng trên bao nhiêu KR.
   */
  progress: number | null;
  measuredCount: number;
  totalCount: number;
};

function toView(kr: typeof schema.okrKeyResults.$inferSelect, live: { value: number | null; note?: string } | undefined, ownerName: string): KeyResultView {
  const binding = metricBinding(kr.metricSource);
  // Chỉ số có trong sổ ⇒ đọc SỐ SỐNG. Chỉ số `MANUAL` ⇒ giá trị người nhập gần nhất.
  const current = binding ? (live?.value ?? null) : kr.current;
  return {
    id: kr.id,
    title: kr.title,
    metricSource: kr.metricSource,
    metricLabel: binding?.label ?? "Nhập tay",
    trust: binding?.trust ?? "MANUAL",
    basis: binding?.basis ?? "",
    unit: kr.unit as MetricUnit,
    direction: kr.direction as "UP" | "DOWN",
    baseline: kr.baseline,
    target: kr.target,
    current,
    currentAt: binding ? new Date() : kr.currentAt,
    progress: krProgress({ baseline: kr.baseline, target: kr.target, current, direction: kr.direction as "UP" | "DOWN" }),
    confidence: kr.confidence as KrConfidence,
    ownerName,
    note: live?.note ?? "",
  };
}

export { KR_CONFIDENCES, OKR_LEVELS, OKR_STATUSES };
export type { KrConfidence, OkrLevel, OkrStatus };

export type OkrQuery = { period: string; level?: OkrLevel; departmentId?: string; ownerUserId?: string; includeDraft?: boolean };

export async function listObjectives(q: OkrQuery, metricPeriod: Period): Promise<ObjectiveView[]> {
  const db = await getDb();
  const ob = schema.okrObjectives;
  const conds = [eq(ob.period, q.period)];
  if (q.level) conds.push(eq(ob.level, q.level));
  if (q.departmentId) conds.push(eq(ob.departmentId, q.departmentId));
  if (q.ownerUserId) conds.push(eq(ob.ownerUserId, q.ownerUserId));
  if (!q.includeDraft) conds.push(inArray(ob.status, ["ACTIVE", "CLOSED"]));

  const objectives = await db
    .select({
      id: ob.id,
      level: ob.level,
      title: ob.title,
      description: ob.description,
      departmentCode: schema.departments.code,
      departmentName: schema.departments.name,
      ownerName: schema.users.name,
      period: ob.period,
      status: ob.status,
      sortOrder: ob.sortOrder,
    })
    .from(ob)
    .leftJoin(schema.departments, eq(schema.departments.id, ob.departmentId))
    .leftJoin(schema.users, eq(schema.users.id, ob.ownerUserId))
    .where(and(...conds))
    .orderBy(asc(ob.level), asc(ob.sortOrder), asc(ob.title));

  if (!objectives.length) return [];
  const krs = await db.query.okrKeyResults.findMany({
    where: inArray(schema.okrKeyResults.objectiveId, objectives.map((o) => o.id)),
    orderBy: [asc(schema.okrKeyResults.sortOrder)],
  });
  const owners = await db.query.users.findMany({ columns: { id: true, name: true } });
  const ownerName = new Map(owners.map((u) => [u.id, u.name]));

  // Một lượt đọc cho mọi chỉ số của mọi KR — không N+1.
  const values = await resolveMetrics(krs.map((k) => k.metricSource), { period: metricPeriod });

  return objectives.map((o) => {
    const list = krs.filter((k) => k.objectiveId === o.id).map((k) => toView(k, values.get(k.metricSource), k.ownerUserId ? (ownerName.get(k.ownerUserId) ?? "") : ""));
    const measured = list.filter((k) => k.progress !== null);
    return {
      id: o.id,
      level: o.level as OkrLevel,
      title: o.title,
      description: o.description,
      departmentCode: (o.departmentCode as DepartmentCode | null) ?? null,
      departmentName: o.departmentName ?? "",
      ownerName: o.ownerName ?? "",
      period: o.period,
      status: o.status as OkrStatus,
      keyResults: list,
      progress: measured.length ? measured.reduce((s, k) => s + Math.min(100, k.progress ?? 0), 0) / measured.length : null,
      measuredCount: measured.length,
      totalCount: list.length,
    };
  });
}

/** Lịch sử chấm một KR — nguồn của đường xu hướng. Mới nhất trước. */
export async function krCheckins(keyResultId: string, limit = 50) {
  const db = await getDb();
  return db.query.okrCheckins.findMany({
    where: eq(schema.okrCheckins.keyResultId, keyResultId),
    orderBy: [desc(schema.okrCheckins.createdAt)],
    limit,
  });
}

/** Kỳ đang có Objective — để dựng bộ chọn kỳ mà không hard-code. */
export async function okrPeriods(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.selectDistinct({ period: schema.okrObjectives.period }).from(schema.okrObjectives).orderBy(desc(schema.okrObjectives.period));
  return rows.map((r) => r.period);
}

/** Kỳ hiện tại theo quý, giờ Việt Nam. `2026-Q3`. */
export function currentQuarter(at: Date = new Date()): string {
  const vn = new Date(at.getTime() + 7 * 3_600_000);
  return `${vn.getUTCFullYear()}-Q${Math.floor(vn.getUTCMonth() / 3) + 1}`;
}

export function quarterRange(period: string): { start: Date; end: Date } | null {
  const m = /^(\d{4})-Q([1-4])$/.exec(period);
  if (!m) return null;
  const year = Number(m[1]);
  const q = Number(m[2]);
  // Giờ Việt Nam: quý bắt đầu 00:00 ngày 1 (UTC+7) và kết thúc ngay trước quý sau.
  const start = new Date(Date.UTC(year, (q - 1) * 3, 1, -7));
  const end = new Date(Date.UTC(year, q * 3, 1, -7) - 1);
  return { start, end };
}

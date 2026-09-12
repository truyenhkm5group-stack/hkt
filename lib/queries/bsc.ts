import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { BSC_PERSPECTIVES, BSC_PERSPECTIVE_HINT, BSC_PERSPECTIVE_LABEL, BSC_PERSPECTIVE_TONE, DEFAULT_TEMPLATES, type BscPerspective } from "@/lib/constants/bsc";
import type { DepartmentCode } from "@/lib/constants/departments";
import { metricBinding, type MetricTrust, type MetricUnit } from "@/lib/constants/metric-bindings";
import { resolveMetrics } from "@/lib/queries/metric-resolver";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ THẺ ĐIỂM CÂN BẰNG (BSC) — THỰC DỤNG, KHÔNG GIÁO ĐIỀU ═══════════
 *
 * Bốn góc nhìn là cố định — đó là định nghĩa của BSC, không phải lựa chọn. Nhưng **chỉ số và
 * TRỌNG SỐ hoàn toàn do chủ shop khai.**
 *
 * `DEFAULT_TEMPLATES` bên dưới là GỢI Ý KHỞI ĐỘNG, và đó là tất cả những gì nó là. Chép chúng vào
 * mã như chân lý ("Marketing thì đo ROAS") là áp một mô hình kinh doanh lên một shop cụ thể; ba
 * tháng sau chủ shop muốn đo khác thì phải sửa code. Nên chúng chỉ được dùng khi người dùng bấm
 * "dựng thẻ điểm mẫu", và sau đó là dữ liệu bình thường, sửa thoải mái.
 *
 * ─── ĐIỂM MỘT GÓC NHÌN: CHỈ TÍNH TRÊN Ô ĐO ĐƯỢC ───
 *
 * Ô chưa đo được KHÔNG tính là 0 điểm. Nó rơi khỏi cả tử lẫn mẫu, và `coverage` nói rõ điểm này
 * đứng trên bao nhiêu phần trọng số. Một thẻ điểm 40% mà thực ra chỉ đo được 2/6 ô thì con số 40%
 * không có nghĩa gì, và người đọc phải biết điều đó.
 */

export { BSC_PERSPECTIVES, BSC_PERSPECTIVE_HINT, BSC_PERSPECTIVE_LABEL, BSC_PERSPECTIVE_TONE, DEFAULT_TEMPLATES };
export type { BscPerspective };

export type BscMetricView = {
  id: string;
  perspective: BscPerspective;
  label: string;
  metricSource: string;
  trust: MetricTrust;
  basis: string;
  unit: MetricUnit;
  direction: "UP" | "DOWN";
  target: number | null;
  value: number | null;
  weight: number;
  /** Điểm 0–100 của riêng ô này. `null` = chưa đo được hoặc chưa đặt đích. */
  score: number | null;
  note: string;
};

export type BscPerspectiveView = {
  perspective: BscPerspective;
  label: string;
  metrics: BscMetricView[];
  /** Điểm góc nhìn = trung bình có trọng số CỦA CÁC Ô ĐO ĐƯỢC. `null` khi không ô nào đo được. */
  score: number | null;
  /** Phần trọng số thật sự đo được (0–1). Thấp ⇒ điểm ở trên chỉ nói về một mảnh nhỏ. */
  coverage: number;
};

export type Scorecard = {
  id: string;
  scope: "COMPANY" | "DEPARTMENT";
  departmentCode: DepartmentCode | null;
  name: string;
  period: string;
  perspectives: BscPerspectiveView[];
  score: number | null;
  coverage: number;
};

/**
 * Điểm một ô: đạt đích = 100. Không kẹp trên — vượt đích đáng được thấy.
 * Với chỉ số càng-thấp-càng-tốt, đích 0 là hợp lệ và được xử lý riêng (chia cho 0).
 */
export function metricScore(value: number | null, target: number | null, direction: "UP" | "DOWN"): number | null {
  if (value === null || target === null) return null;
  if (direction === "UP") return target === 0 ? (value >= 0 ? 100 : 0) : Math.max(0, (value / target) * 100);
  // Càng thấp càng tốt: đích 0 nghĩa là "không còn cái nào" — chỉ 0 mới đạt 100.
  if (target === 0) return value === 0 ? 100 : 0;
  return value === 0 ? 100 : Math.max(0, (target / value) * 100);
}

export async function getScorecard(opts: { scope: "COMPANY" | "DEPARTMENT"; departmentId?: string | null; period: string }, metricPeriod: Period): Promise<Scorecard | null> {
  const db = await getDb();
  const c = schema.bscScorecards;
  const card = await db.query.bscScorecards.findFirst({
    where: and(eq(c.scope, opts.scope), eq(c.period, opts.period), opts.departmentId ? eq(c.departmentId, opts.departmentId) : isNull(c.departmentId)),
  });
  if (!card) return null;

  const metrics = await db.query.bscMetrics.findMany({ where: eq(schema.bscMetrics.scorecardId, card.id), orderBy: [asc(schema.bscMetrics.sortOrder)] });
  const dept = card.departmentId ? await db.query.departments.findFirst({ where: eq(schema.departments.id, card.departmentId), columns: { code: true } }) : null;
  const deptCode = (dept?.code as DepartmentCode | undefined) ?? null;
  const values = await resolveMetrics(metrics.map((m) => m.metricSource), { period: metricPeriod, department: deptCode });

  const views: BscMetricView[] = metrics.map((m) => {
    const binding = metricBinding(m.metricSource);
    const live = values.get(m.metricSource);
    const value = binding ? (live?.value ?? null) : m.manualValue;
    return {
      id: m.id,
      perspective: m.perspective as BscPerspective,
      label: m.label,
      metricSource: m.metricSource,
      trust: binding?.trust ?? "MANUAL",
      basis: binding?.basis ?? "",
      unit: m.unit as MetricUnit,
      direction: m.direction as "UP" | "DOWN",
      target: m.target,
      value,
      weight: m.weight,
      score: metricScore(value, m.target, m.direction as "UP" | "DOWN"),
      note: live?.note ?? "",
    };
  });

  const perspectives: BscPerspectiveView[] = BSC_PERSPECTIVES.map((p) => {
    const list = views.filter((v) => v.perspective === p);
    const scored = list.filter((v) => v.score !== null);
    const totalWeight = list.reduce((s, v) => s + v.weight, 0);
    const scoredWeight = scored.reduce((s, v) => s + v.weight, 0);
    return {
      perspective: p,
      label: BSC_PERSPECTIVE_LABEL[p],
      metrics: list,
      score: scoredWeight ? scored.reduce((s, v) => s + (v.score ?? 0) * v.weight, 0) / scoredWeight : null,
      coverage: totalWeight ? scoredWeight / totalWeight : 0,
    };
  }).filter((p) => p.metrics.length > 0);

  const measured = perspectives.filter((p) => p.score !== null);
  const totalWeightAll = views.reduce((s, v) => s + v.weight, 0);
  const scoredWeightAll = views.filter((v) => v.score !== null).reduce((s, v) => s + v.weight, 0);

  return {
    id: card.id,
    scope: card.scope as "COMPANY" | "DEPARTMENT",
    departmentCode: deptCode,
    name: card.name,
    period: card.period,
    perspectives,
    // Bốn góc nhìn CÂN BẰNG NHAU ở cấp thẻ — đó chính là ý nghĩa của chữ "cân bằng" trong BSC.
    // Trọng số chỉ phân biệt các ô BÊN TRONG một góc nhìn.
    score: measured.length ? measured.reduce((s, p) => s + (p.score ?? 0), 0) / measured.length : null,
    coverage: totalWeightAll ? scoredWeightAll / totalWeightAll : 0,
  };
}

export async function listScorecards(period: string) {
  const db = await getDb();
  return db
    .select({
      id: schema.bscScorecards.id,
      scope: schema.bscScorecards.scope,
      name: schema.bscScorecards.name,
      period: schema.bscScorecards.period,
      departmentId: schema.bscScorecards.departmentId,
      departmentCode: schema.departments.code,
      active: schema.bscScorecards.active,
    })
    .from(schema.bscScorecards)
    .leftJoin(schema.departments, eq(schema.departments.id, schema.bscScorecards.departmentId))
    .where(eq(schema.bscScorecards.period, period))
    .orderBy(asc(schema.bscScorecards.scope), asc(schema.departments.sortOrder));
}

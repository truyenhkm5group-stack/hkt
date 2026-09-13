/**
 * ═══════════ XU HƯỚNG ĐỌC TỪ ẢNH CHỤP, KHÔNG TÍNH LẠI ═══════════
 *
 * Một người ở 68 và đang LÊN khác hẳn một người ở 68 và đang XUỐNG, dù con số bằng nhau — và đó
 * là khác biệt quyết định người quản lý nên nói gì với họ.
 *
 * Xu hướng CHỈ đọc từ `performance_snapshots`. Tính lại kỳ trước bằng truy vấn hôm nay sẽ cho một
 * con số khác với con số đã in ra hồi đó mỗi khi có ai sửa công thức — và lúc ấy "xu hướng" chỉ
 * đang đo mức độ thay đổi của mã nguồn.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { MetricConfidence } from "@/lib/constants/metric-provenance";

export type SnapshotPoint = {
  period: string;
  periodStart: Date;
  value: number | null;
  sample: number;
  confidence: MetricConfidence;
  definitionVersion: number;
  /** Phiên bản NGUỒN lúc chụp — xem `METRIC_SOURCE_VERSION`. Khác `definitionVersion`: đổi chỗ đọc, không đổi công thức. */
  sourceVersion: number;
};

export type MetricTrend = {
  metricKey: string;
  metricLabel: string;
  unit: string;
  points: SnapshotPoint[];
  /** Kỳ gần nhất có số đo được. */
  latest: SnapshotPoint | null;
  /** Kỳ liền trước đó có số đo được. */
  previous: SnapshotPoint | null;
  /**
   * Chênh lệch theo ĐƠN VỊ CỦA CHÍNH CHỈ SỐ, không phải phần trăm của phần trăm.
   * `null` khi thiếu một trong hai đầu — không suy ra 0.
   */
  delta: number | null;
  /**
   * Hai kỳ được tính bằng HAI PHIÊN BẢN CÔNG THỨC khác nhau ⇒ chênh lệch không đọc là "tốt lên"
   * hay "xấu đi" được. Nói ra thay vì im lặng vẽ một mũi tên.
   */
  definitionChanged: boolean;
  /**
   * Hai kỳ ĐỌC TỪ HAI NGUỒN khác nhau (ví dụ: case nối bằng ô chữ → nối bằng khoá tài khoản).
   * Cùng công thức nhưng khác TẬP DÒNG, nên chênh lệch cũng không đọc thành xu hướng được.
   */
  sourceChanged: boolean;
};

export async function metricTrend(input: {
  subjectType: "PERSON" | "DEPARTMENT";
  subjectId: string;
  kind?: "WEEKLY" | "MONTHLY";
  limit?: number;
}): Promise<MetricTrend[]> {
  const db = await getDb();
  const t = schema.performanceSnapshots;
  const rows = await db
    .select({
      metricKey: t.metricKey,
      metricLabel: t.metricLabel,
      unit: t.unit,
      period: t.period,
      periodStart: t.periodStart,
      value: t.value,
      sample: t.sample,
      confidence: t.confidence,
      definitionVersion: t.definitionVersion,
      sourceVersion: t.sourceVersion,
    })
    .from(t)
    .where(and(eq(t.subjectType, input.subjectType), eq(t.subjectId, input.subjectId), eq(t.kind, input.kind ?? "WEEKLY")))
    .orderBy(desc(t.periodStart))
    .limit(input.limit ?? 200);

  const theoChiSo = new Map<string, MetricTrend>();
  for (const r of rows) {
    const cur =
      theoChiSo.get(r.metricKey) ??
      ({ metricKey: r.metricKey, metricLabel: r.metricLabel, unit: r.unit, points: [], latest: null, previous: null, delta: null, definitionChanged: false, sourceChanged: false } as MetricTrend);
    cur.points.push({
      period: r.period,
      periodStart: r.periodStart,
      value: r.value === null ? null : Number(r.value),
      sample: r.sample,
      confidence: r.confidence as MetricConfidence,
      definitionVersion: r.definitionVersion,
      sourceVersion: r.sourceVersion,
    });
    theoChiSo.set(r.metricKey, cur);
  }

  for (const tr of theoChiSo.values()) {
    // `points` đang xếp mới → cũ. Xu hướng chỉ dùng kỳ ĐO ĐƯỢC; kỳ `null` không phải một điểm rơi.
    const doDuoc = tr.points.filter((p) => p.value !== null);
    tr.latest = doDuoc[0] ?? null;
    tr.previous = doDuoc[1] ?? null;
    tr.delta = tr.latest && tr.previous ? Math.round((tr.latest.value! - tr.previous.value!) * 10) / 10 : null;
    tr.definitionChanged = Boolean(tr.latest && tr.previous && tr.latest.definitionVersion !== tr.previous.definitionVersion);
    /*
      ĐỔI NGUỒN GIỮA HAI KỲ — KHÔNG VẼ MŨI TÊN.

      Kỳ trước gom case nối bằng TÊN GÕ TAY, kỳ này chỉ gom case nối bằng KHOÁ tài khoản: hai kỳ
      đứng trên hai TẬP DÒNG khác nhau. Con số tụt xuống không nói người đó làm kém đi, nó nói
      phép đo vừa hẹp lại. Vẽ một mũi tên đi xuống ở đây là nói dối bằng đồ thị.
    */
    tr.sourceChanged = Boolean(tr.latest && tr.previous && tr.latest.sourceVersion !== tr.previous.sourceVersion);
    tr.points.reverse();
  }

  return [...theoChiSo.values()].sort((a, b) => a.metricLabel.localeCompare(b.metricLabel, "vi"));
}

/** Kỳ đã chụp gần nhất — để màn hình nói được "số này chụp lúc nào" thay vì để người đọc đoán. */
export async function latestSnapshotPeriod(kind: "WEEKLY" | "MONTHLY" = "WEEKLY"): Promise<{ period: string; calculatedAt: Date; rows: number } | null> {
  const db = await getDb();
  const t = schema.performanceSnapshots;
  const [row] = await db
    .select({ period: t.period, calculatedAt: sql<Date>`max(${t.calculatedAt})`, rows: sql<number>`count(*)::int` })
    .from(t)
    .where(eq(t.kind, kind))
    .groupBy(t.period, t.periodStart)
    .orderBy(desc(t.periodStart))
    .limit(1);
  return row ? { period: row.period, calculatedAt: new Date(row.calculatedAt), rows: Number(row.rows) } : null;
}

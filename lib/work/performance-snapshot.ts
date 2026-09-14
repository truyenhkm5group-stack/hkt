/**
 * ═══════════ CHỤP HIỆU SUẤT MỘT KỲ — GHI MỘT LẦN, KHÔNG BAO GIỜ GHI ĐÈ ═══════════
 *
 * Thẻ điểm sống tính lại mỗi lần mở, và điều đó đúng cho "tuần này đang thế nào". Nó SAI cho
 * "quý trước chị Lan đạt bao nhiêu": chỉ cần ai đó sửa một mệnh đề `WHERE` là con số của quý
 * trước đổi theo, lặng lẽ, không đối chiếu được với bản đã in ra hồi đó.
 *
 * ─── BA LUẬT ───
 *
 * 1. **Không ghi đè.** `ON CONFLICT DO NOTHING` trên khoá `(kỳ, chủ thể, chỉ số)`. Chạy lại job
 *    bao nhiêu lần cũng ra cùng một kết quả, và lần chạy thứ hai không đổi được gì.
 * 2. **Không chụp kỳ chưa đóng.** Chụp tuần đang chạy dở sẽ đóng băng một con số nửa vời thành
 *    "sự thật của tuần đó" — và vì luật 1, sẽ không sửa được nữa.
 * 3. **Chụp cả `null`.** Kỳ không có quan sát nào vẫn ghi một dòng `value = null`. Bỏ trống thì
 *    sau này không phân biệt được "kỳ đó chưa đo được" với "chưa từng chạy job".
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { DEPARTMENT_CODES, type DepartmentCode } from "@/lib/constants/departments";
import { DEPT_LINKAGE, DEPT_METRIC_KEYS, type DeptMetricSpec } from "@/lib/constants/department-performance";
import { METRIC_DEFINITION_VERSION, periodKey, periodRange } from "@/lib/constants/metric-provenance";
import { METRIC_SOURCE_VERSION } from "@/lib/constants/metric-catalog";
import { getDeptPerformance } from "@/lib/queries/dept-performance";
import { activeMembershipsByUser } from "@/lib/org/membership";

export type SnapshotResult = {
  period: string;
  kind: "WEEKLY" | "MONTHLY";
  from: Date;
  to: Date;
  /** Số dòng THỰC SỰ được ghi thêm. Chạy lại lần hai phải ra 0. */
  written: number;
  /** Dòng bị bỏ qua vì kỳ đó đã chụp rồi — bằng chứng của tính bất biến, không phải lỗi. */
  skipped: number;
  byDepartment: { code: DepartmentCode; people: number; metrics: number }[];
  skippedReason?: string;
};

/**
 * Chụp kỳ CHỨA `at` — mặc định là kỳ TRƯỚC kỳ hiện tại, vì kỳ hiện tại chưa đóng.
 *
 * `force` chỉ dùng cho kiểm thử và cho lần chụp bù đầu tiên: nó KHÔNG cho phép ghi đè (luật 1 vẫn
 * giữ), nó chỉ bỏ qua việc kiểm "kỳ đã đóng chưa".
 */
export async function snapshotPerformance(input: { kind: "WEEKLY" | "MONTHLY"; at?: Date; force?: boolean; now?: Date }): Promise<SnapshotResult> {
  const now = input.now ?? new Date();
  const at = input.at ?? lui(input.kind, now);
  const { from, to } = periodRange(input.kind, at);
  const period = periodKey(input.kind, at);
  const base: SnapshotResult = { period, kind: input.kind, from, to, written: 0, skipped: 0, byDepartment: [] };

  if (!input.force && to.getTime() > now.getTime()) {
    return { ...base, skippedReason: `Kỳ ${period} chưa đóng (tới ${to.toISOString()}) — chụp bây giờ sẽ đóng băng một con số nửa vời.` };
  }

  const db = await getDb();
  const [users, thanhVien] = await Promise.all([
    db.query.users.findMany({ columns: { id: true, name: true, email: true, active: true } }),
    activeMembershipsByUser(),
  ]);

  const rows: (typeof schema.performanceSnapshots.$inferInsert)[] = [];

  for (const code of DEPARTMENT_CODES) {
    const nguoi = users
      .filter((u) => u.active && (thanhVien.get(u.id) ?? []).some((m) => m.code === code))
      .map((u) => ({ id: u.id, name: u.name, email: u.email }));
    if (!nguoi.length) continue;

    const perf = await getDeptPerformance({ department: code, from, to, people: nguoi });
    const danhMuc = DEPT_METRIC_KEYS[code] ?? [];
    const linkage = DEPT_LINKAGE[code] ?? "USER_ID";
    let soChiSo = 0;

    /*
      GHI ĐỦ DANH MỤC, KHÔNG CHỈ GHI THỨ ĐO ĐƯỢC.

      Hàm đo chỉ trả dòng cho người CÓ hoạt động trong kỳ. Nếu chỉ chụp từng ấy thì một kỳ trống
      không để lại dấu vết — và sau này "kỳ đó chưa đo được gì" trông y hệt "kỳ đó job chưa chạy".
      Cái thứ nhất là sự thật về công việc; cái thứ hai là lỗ hổng dữ liệu. Phân biệt được hai cái
      là lý do bảng danh mục tồn tại.
    */
    for (const p of perf.people) {
      const coSan = new Map(p.metrics.map((m) => [m.key, m]));
      for (const spec of danhMuc.filter((d) => d.owner === "PERSON")) {
        const m = coSan.get(spec.key);
        soChiSo += 1;
        rows.push(
          m
            ? dong(m, { kind: input.kind, period, from, to, subjectType: "PERSON", subjectId: p.userId, subjectLabel: p.name, departmentCode: code })
            : trong(spec, linkage, perf.missingAttribution, { kind: input.kind, period, from, to, subjectType: "PERSON", subjectId: p.userId, subjectLabel: p.name, departmentCode: code }),
        );
      }
    }

    const teamCoSan = new Map(perf.team.map((m) => [m.key, m]));
    for (const spec of danhMuc.filter((d) => d.owner === "DEPARTMENT")) {
      const m = teamCoSan.get(spec.key);
      soChiSo += 1;
      rows.push(
        m
          ? dong(m, { kind: input.kind, period, from, to, subjectType: "DEPARTMENT", subjectId: code, subjectLabel: perf.label, departmentCode: code })
          : trong(spec, linkage, perf.missingAttribution, { kind: input.kind, period, from, to, subjectType: "DEPARTMENT", subjectId: code, subjectLabel: perf.label, departmentCode: code }),
      );
    }
    base.byDepartment.push({ code, people: perf.people.length, metrics: soChiSo });
  }

  if (!rows.length) return base;

  /*
    Đếm TRƯỚC và SAU thay vì tin vào số dòng trả về: `onConflictDoNothing` không cho biết dòng nào
    đã bị bỏ, mà chính con số "bị bỏ" là bằng chứng bất biến cần in ra.
  */
  const khoa = rows.map((r) => r.metricKey!);
  const truoc = await db
    .select({ id: schema.performanceSnapshots.id })
    .from(schema.performanceSnapshots)
    .where(and(eq(schema.performanceSnapshots.period, period), inArray(schema.performanceSnapshots.metricKey, [...new Set(khoa)])));

  await db.insert(schema.performanceSnapshots).values(rows).onConflictDoNothing();

  const sau = await db
    .select({ id: schema.performanceSnapshots.id })
    .from(schema.performanceSnapshots)
    .where(and(eq(schema.performanceSnapshots.period, period), inArray(schema.performanceSnapshots.metricKey, [...new Set(khoa)])));

  base.written = sau.length - truoc.length;
  base.skipped = rows.length - base.written;
  return base;
}

type Ctx = {
  kind: "WEEKLY" | "MONTHLY";
  period: string;
  from: Date;
  to: Date;
  subjectType: "PERSON" | "DEPARTMENT";
  subjectId: string;
  subjectLabel: string;
  departmentCode: DepartmentCode;
};

function dong(m: Awaited<ReturnType<typeof getDeptPerformance>>["people"][number]["metrics"][number], c: Ctx): typeof schema.performanceSnapshots.$inferInsert {
  return {
    kind: c.kind,
    period: c.period,
    periodStart: c.from,
    periodEnd: c.to,
    subjectType: c.subjectType,
    subjectId: c.subjectId,
    subjectLabel: c.subjectLabel,
    departmentCode: c.departmentCode,
    metricKey: m.key,
    metricLabel: m.label,
    value: m.value,
    unit: m.unit,
    // Ràng buộc CSDL: có giá trị thì phải có mẫu số. Giữ hai thứ đi cùng nhau ngay từ đây.
    sample: m.value === null ? 0 : m.sample,
    denominatorLabel: m.denominatorLabel,
    confidence: m.confidence,
    linkage: m.linkage,
    shared: m.shared,
    attribution: m.attribution,
    basis: m.basis,
    calculatedAt: new Date(),
    definitionVersion: METRIC_DEFINITION_VERSION,
    sourceVersion: METRIC_SOURCE_VERSION,
  };
}

/** Dòng CHƯA ĐO ĐƯỢC: có mặt trong lịch sử, mang đủ xuất xứ, và `value = null` — không phải 0. */
function trong(spec: DeptMetricSpec, linkage: "USER_ID" | "EMAIL" | "FREE_TEXT", attribution: string, c: Ctx): typeof schema.performanceSnapshots.$inferInsert {
  return {
    kind: c.kind,
    period: c.period,
    periodStart: c.from,
    periodEnd: c.to,
    subjectType: c.subjectType,
    subjectId: c.subjectId,
    subjectLabel: c.subjectLabel,
    departmentCode: c.departmentCode,
    metricKey: spec.key,
    metricLabel: spec.label,
    value: null,
    unit: spec.unit,
    sample: 0,
    denominatorLabel: spec.denominatorLabel,
    confidence: "UNKNOWN",
    linkage,
    shared: false,
    attribution,
    basis: "Không có quan sát nào trong kỳ — dòng này ghi lại rằng ĐÃ ĐO và kết quả là chưa biết, khác với chưa từng chạy.",
    calculatedAt: new Date(),
    definitionVersion: METRIC_DEFINITION_VERSION,
    sourceVersion: METRIC_SOURCE_VERSION,
  };
}

/** Lùi một kỳ: kỳ hiện tại chưa đóng nên không chụp được. */
function lui(kind: "WEEKLY" | "MONTHLY", now: Date): Date {
  return kind === "WEEKLY"
    ? new Date(now.getTime() - 7 * 86_400_000)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
}

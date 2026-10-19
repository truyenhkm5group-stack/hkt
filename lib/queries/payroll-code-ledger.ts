/**
 * ═══════════ SỔ PHÂN CÔNG MKTer ↔ MÃ VÀ ĐIỀU KHOẢN THƯỞNG THEO MÃ — LỚP ĐỌC ═══════════
 *
 * Đặc tả: `docs/payroll-code-ledger.md`. Phép tính: `lib/payroll/code-ledger.ts` (hàm thuần).
 *
 * Tệp này KHÔNG import `getPayrollReport` / `getMarketerReport` — bảng lương truyền vào hàm đọc
 * báo cáo theo đoạn, để không có vòng module.
 *
 * ─── ĐỔI PHÂN CÔNG GIỮA THÁNG ───
 *
 * Mỗi mã được cắt thành các ĐOẠN mà trong đó phân công + điều khoản không đổi. Phần của mỗi đoạn trong
 * lợi nhuận đủ điều kiện của tháng đi theo DOANH THU GIAO THÀNH CÔNG phát sinh trong đoạn (nghiệp vụ
 * thật của đoạn), và trọng số SUPPORT theo chi phí quảng cáo / doanh thu quy kết đo TRONG đoạn —
 * không chia theo số ngày, không chia đều.
 */
import { and, eq, gte, isNull, lte, or } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { CodeAssignment, CodeSegment, CodeTerms, WeightMethod } from "@/lib/payroll/code-ledger";
import { addDays, vnDateKey, vnStartOfDay } from "@/lib/format";
import type { Period } from "@/lib/search-params";

/** Phân công / điều khoản ĐÃ DUYỆT có hiệu lực chồng lên [from, to]. */
export async function loadCodeBook(from: Date, to: Date): Promise<{ assignments: CodeAssignment[]; terms: CodeTerms[] }> {
  const db = await getDb();
  const a = schema.productMarketerAssignments;
  const t = schema.productBonusTerms;
  const [rowsA, rowsT] = await Promise.all([
    db
      .select()
      .from(a)
      .where(and(eq(a.status, "APPROVED"), lte(a.effectiveFrom, to), or(isNull(a.effectiveTo), gte(a.effectiveTo, from)))),
    db
      .select()
      .from(t)
      .where(and(eq(t.status, "APPROVED"), lte(t.effectiveFrom, to), or(isNull(t.effectiveTo), gte(t.effectiveTo, from)))),
  ]);
  return {
    assignments: rowsA.map((r) => ({
      id: r.id,
      productId: r.productId,
      employeeId: r.employeeId,
      role: r.role as CodeAssignment["role"],
      ownerRateBp: r.ownerRateBp,
      weightMethod: (r.weightMethod as WeightMethod | null) ?? null,
      weightBp: r.weightBp,
      from: r.effectiveFrom,
      to: r.effectiveTo,
      policyRef: r.policyRef,
    })),
    terms: rowsT.map((r) => ({
      id: r.id,
      productId: r.productId,
      supportPoolBp: r.supportPoolBp,
      maxBonusAmount: r.maxBonusAmount,
      from: r.effectiveFrom,
      to: r.effectiveTo,
      policyRef: r.policyRef,
    })),
  };
}

/**
 * Các mốc cắt đoạn của các mã `productIds` trong [from, to]: đầu kỳ, mọi ngày bắt đầu và (ngày sau)
 * ngày kết thúc của phân công / điều khoản rơi vào giữa kỳ. Theo NGÀY lịch Việt Nam — mốc hiệu lực
 * khai theo ngày. Mốc ngoài [from, to] bị bỏ (một dòng sửa tay kết thúc giữa ngày cuối tháng không
 * được đẻ ra một đoạn ngược chiều).
 */
export function segmentBounds(productIds: string | readonly string[], from: Date, to: Date, assignments: readonly CodeAssignment[], terms: readonly CodeTerms[]): { from: Date; to: Date }[] {
  const ids = new Set(typeof productIds === "string" ? [productIds] : productIds);
  const fromKey = vnDateKey(from);
  const toKey = vnDateKey(to);
  const startKeys = new Set<string>([fromKey]);
  const them = (k: string) => {
    if (k > fromKey && k <= toKey) startKeys.add(k);
  };
  for (const x of [...assignments.filter((a) => ids.has(a.productId)), ...terms.filter((t) => t.productId === null || ids.has(t.productId))]) {
    them(vnDateKey(x.from));
    if (x.to) them(addDays(vnDateKey(x.to), 1));
  }
  const starts = [...startKeys].sort();
  return starts.map((k, i) => ({
    from: i === 0 ? from : vnStartOfDay(k),
    to: i + 1 < starts.length ? new Date(vnStartOfDay(starts[i + 1]).getTime() - 1) : to,
  }));
}

/** Phần một mã trong một báo cáo: doanh thu, chi phí QC và doanh thu quy kết của từng MKTer, và phần chưa gán cho ai. */
export type CodeFacts = {
  revenue: number;
  adSpendByEmployee: Map<string, number>;
  revenueByEmployee: Map<string, number>;
  unattributedAdSpend: number;
  unattributedRevenue: number;
};

export type ReportFacts = (period: Period) => Promise<Map<string, CodeFacts>>;

const rong = (): CodeFacts => ({ revenue: 0, adSpendByEmployee: new Map(), revenueByEmployee: new Map(), unattributedAdSpend: 0, unattributedRevenue: 0 });
const cong = (a: CodeFacts, b: CodeFacts): CodeFacts => {
  const gop = (x: Map<string, number>, y: Map<string, number>) => {
    const out = new Map(x);
    for (const [k, v] of y) out.set(k, (out.get(k) ?? 0) + v);
    return out;
  };
  return {
    revenue: a.revenue + b.revenue,
    adSpendByEmployee: gop(a.adSpendByEmployee, b.adSpendByEmployee),
    revenueByEmployee: gop(a.revenueByEmployee, b.revenueByEmployee),
    unattributedAdSpend: a.unattributedAdSpend + b.unattributedAdSpend,
    unattributedRevenue: a.unattributedRevenue + b.unattributedRevenue,
  };
};

/**
 * ĐOẠN CỦA NHIỀU MÃ, MỘT LƯỢT ĐO. Mốc của mọi mã gom thành MỘT bộ mảnh chung; mỗi mảnh đo đúng một
 * báo cáo (song song, memo theo kỳ ở `getMarketerReport`), rồi mỗi mã cộng các mảnh nằm trong đoạn
 * của RIÊNG nó. Không đổi giữa tháng ⇒ dùng ngay số của tháng, không đo thêm gì.
 *
 * `null` cho một mã = có nhiều đoạn nhưng KHÔNG đoạn nào có doanh thu giao thành công để biết phần của
 * từng đoạn ⇒ người gọi đưa vào CHỜ ĐỐI SOÁT. Chia đều theo số đoạn là đúng thứ đặc tả cấm.
 */
export async function buildCodeSegmentsFor(
  productIds: readonly string[],
  period: { from: Date; to: Date },
  book: { assignments: readonly CodeAssignment[]; terms: readonly CodeTerms[] },
  monthFacts: Map<string, CodeFacts>,
  factsFor: ReportFacts,
): Promise<Map<string, CodeSegment[] | null>> {
  const out = new Map<string, CodeSegment[] | null>();
  if (!productIds.length) return out;
  const manh = segmentBounds(productIds, period.from, period.to, book.assignments, book.terms);
  const doManh: Map<string, CodeFacts>[] =
    manh.length === 1
      ? [monthFacts]
      : await Promise.all(manh.map((b) => factsFor({ key: "custom", from: b.from, to: b.to, fromKey: vnDateKey(b.from), toKey: vnDateKey(b.to), label: `${vnDateKey(b.from)} → ${vnDateKey(b.to)}` })));
  for (const pid of productIds) {
    const own = segmentBounds(pid, period.from, period.to, book.assignments, book.terms);
    const facts = own.map((s) =>
      manh.reduce((acc, m, i) => (m.from.getTime() >= s.from.getTime() && m.to.getTime() <= s.to.getTime() ? cong(acc, doManh[i].get(pid) ?? rong()) : acc), rong()),
    );
    if (own.length === 1) {
      const f = monthFacts.get(pid) ?? rong();
      out.set(pid, [{ from: own[0].from, to: own[0].to, weight: 1, adSpendByEmployee: f.adSpendByEmployee, revenueByEmployee: f.revenueByEmployee, unattributedAdSpend: f.unattributedAdSpend, unattributedRevenue: f.unattributedRevenue }]);
      continue;
    }
    const tong = facts.reduce((t, f) => t + Math.max(0, f.revenue), 0);
    if (tong <= 0) {
      out.set(pid, null);
      continue;
    }
    out.set(
      pid,
      own.map((s, i) => ({
        from: s.from,
        to: s.to,
        weight: Math.max(0, facts[i].revenue) / tong,
        adSpendByEmployee: facts[i].adSpendByEmployee,
        revenueByEmployee: facts[i].revenueByEmployee,
        unattributedAdSpend: facts[i].unattributedAdSpend,
        unattributedRevenue: facts[i].unattributedRevenue,
      })),
    );
  }
  return out;
}

export type CodeBookRow = {
  kind: "ASSIGNMENT" | "TERMS";
  id: string;
  productId: string | null;
  code: string;
  productName: string;
  employeeId: string | null;
  role: string | null;
  ownerRateBp: number | null;
  weightMethod: string | null;
  weightBp: number | null;
  supportPoolBp: number | null;
  maxBonusAmount: number | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  policyRef: string;
  status: string;
  note: string;
  approvedByName: string;
  approvedAt: Date | null;
};

/** Toàn bộ sổ (kể cả dòng đã kết thúc / huỷ) cho màn hình quản lý — lịch sử không bị giấu. */
export async function listCodeBook(): Promise<CodeBookRow[]> {
  const db = await getDb();
  const a = schema.productMarketerAssignments;
  const t = schema.productBonusTerms;
  const p = schema.products;
  const u = schema.users;
  const [ra, rt] = await Promise.all([
    db
      .select({ r: a, customId: p.customId, name: p.name, approver: u.name })
      .from(a)
      .leftJoin(p, eq(p.id, a.productId))
      .leftJoin(u, eq(u.id, a.approvedBy)),
    db
      .select({ r: t, customId: p.customId, name: p.name, approver: u.name })
      .from(t)
      .leftJoin(p, eq(p.id, t.productId))
      .leftJoin(u, eq(u.id, t.approvedBy)),
  ]);
  const rows: CodeBookRow[] = [
    ...ra.map(({ r, customId, name, approver }) => ({
      kind: "ASSIGNMENT" as const,
      id: r.id,
      productId: r.productId,
      code: customId || name || r.productId,
      productName: name ?? "",
      employeeId: r.employeeId,
      role: r.role,
      ownerRateBp: r.ownerRateBp,
      weightMethod: r.weightMethod,
      weightBp: r.weightBp,
      supportPoolBp: null,
      maxBonusAmount: null,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
      policyRef: r.policyRef,
      status: r.status,
      note: r.note,
      approvedByName: approver ?? "",
      approvedAt: r.approvedAt,
    })),
    ...rt.map(({ r, customId, name, approver }) => ({
      kind: "TERMS" as const,
      id: r.id,
      productId: r.productId,
      code: r.productId ? customId || name || r.productId : "Mặc định công ty",
      productName: name ?? "",
      employeeId: null,
      role: null,
      ownerRateBp: null,
      weightMethod: null,
      weightBp: null,
      supportPoolBp: r.supportPoolBp,
      maxBonusAmount: r.maxBonusAmount,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
      policyRef: r.policyRef,
      status: r.status,
      note: r.note,
      approvedByName: approver ?? "",
      approvedAt: r.approvedAt,
    })),
  ];
  return rows.sort((x, y) => (x.code === y.code ? y.effectiveFrom.getTime() - x.effectiveFrom.getTime() : x.code < y.code ? -1 : 1));
}

/** Danh sách mã cho ô chọn của biểu mẫu: mã còn bán (chưa gỡ), xếp theo mã. */
export async function listCodeOptions(): Promise<{ id: string; label: string }[]> {
  const db = await getDb();
  const p = schema.products;
  const rows = await db.select({ id: p.id, customId: p.customId, name: p.name }).from(p).where(eq(p.isRemoved, false));
  return rows
    .map((r) => ({ id: r.id, label: r.customId ? `${r.customId} · ${r.name}` : r.name }))
    .sort((x, y) => x.label.localeCompare(y.label, "vi"));
}

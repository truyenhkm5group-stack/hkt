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
import { vnDateKey, vnEndOfDay, vnStartOfDay } from "@/lib/format";
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
 * Các mốc cắt đoạn của MỘT mã trong [from, to]: đầu kỳ, mọi ngày bắt đầu và (ngày sau) ngày kết thúc
 * của phân công / điều khoản rơi vào giữa kỳ. Theo NGÀY lịch Việt Nam — mốc hiệu lực khai theo ngày.
 */
export function segmentBounds(productId: string, from: Date, to: Date, assignments: readonly CodeAssignment[], terms: readonly CodeTerms[]): { from: Date; to: Date }[] {
  const startKeys = new Set<string>([vnDateKey(from)]);
  const inside = (d: Date) => d.getTime() > from.getTime() && d.getTime() <= to.getTime();
  const nextDayKey = (d: Date) => vnDateKey(new Date(vnEndOfDay(vnDateKey(d)).getTime() + 1));
  for (const x of [...assignments.filter((a) => a.productId === productId), ...terms.filter((t) => t.productId === productId || t.productId === null)]) {
    if (inside(x.from)) startKeys.add(vnDateKey(x.from));
    if (x.to && x.to.getTime() < to.getTime() && x.to.getTime() >= from.getTime()) startKeys.add(nextDayKey(x.to));
  }
  const starts = [...startKeys].sort();
  return starts.map((k, i) => ({
    from: vnStartOfDay(k),
    to: i + 1 < starts.length ? new Date(vnStartOfDay(starts[i + 1]).getTime() - 1) : to,
  }));
}

/** Phần một mã trong một báo cáo: doanh thu, chi phí QC và doanh thu quy kết của từng MKTer. */
export type CodeFacts = {
  revenue: number;
  adSpendByEmployee: Map<string, number>;
  revenueByEmployee: Map<string, number>;
};

export type ReportFacts = (period: Period) => Promise<Map<string, CodeFacts>>;

/**
 * Dựng các đoạn của một mã. Một đoạn ⇒ dùng ngay số của tháng (`monthFacts`), không tính thêm báo cáo
 * nào. Nhiều đoạn ⇒ một báo cáo cho mỗi đoạn (memo theo kỳ ở `getMarketerReport`).
 */
export async function buildCodeSegments(
  productId: string,
  period: { from: Date; to: Date },
  book: { assignments: readonly CodeAssignment[]; terms: readonly CodeTerms[] },
  monthFacts: Map<string, CodeFacts>,
  factsFor: ReportFacts,
): Promise<CodeSegment[]> {
  const bounds = segmentBounds(productId, period.from, period.to, book.assignments, book.terms);
  const empty: CodeFacts = { revenue: 0, adSpendByEmployee: new Map(), revenueByEmployee: new Map() };
  if (bounds.length === 1) {
    const f = monthFacts.get(productId) ?? empty;
    return [{ from: bounds[0].from, to: bounds[0].to, weight: 1, adSpendByEmployee: f.adSpendByEmployee, revenueByEmployee: f.revenueByEmployee }];
  }
  const facts = await Promise.all(
    bounds.map((b) =>
      factsFor({ key: "custom", from: b.from, to: b.to, fromKey: vnDateKey(b.from), toKey: vnDateKey(b.to), label: `${vnDateKey(b.from)} → ${vnDateKey(b.to)}` }).then((m) => m.get(productId) ?? empty),
    ),
  );
  const tong = facts.reduce((t, f) => t + Math.max(0, f.revenue), 0);
  return bounds.map((b, i) => ({
    from: b.from,
    to: b.to,
    // Không có doanh thu ở đoạn nào thì mã cũng không có phần đủ điều kiện để chia — trọng số ấy không được dùng.
    weight: tong > 0 ? Math.max(0, facts[i].revenue) / tong : 1 / bounds.length,
    adSpendByEmployee: facts[i].adSpendByEmployee,
    revenueByEmployee: facts[i].revenueByEmployee,
  }));
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

/**
 * ═══ THỰC HIỆN QUYẾT ĐỊNH LƯƠNG CỦA CHỦ SHOP (ỦY QUYỀN 22/10/2026) — MẶC ĐỊNH CHẠY THỬ ═══
 *
 * Ops `payroll-owner-apply` (kết quả MÃ HOÁ). Chủ shop 22/10/2026: «Bạn tự làm luôn đi» · «Tôi cấp quyền cho bạn
 * làm. Hãy làm cho đến khi hoàn tất» · «Tham khảo thêm bảng tính sổ ngân hàng rồi tự làm cho đến khi hoàn tất».
 *
 * Không tham số = CHẠY THỬ: in trước / sau từng mục, KHÔNG ghi gì. `--apply` = ghi. Chạy lại lần hai không đổi gì
 * (mỗi mục so trạng thái hiện tại với đích trước khi làm).
 *
 * Mọi lượt ghi đi qua ĐÚNG lõi mà màn hình gọi — không có câu `insert` / `update` nào trong tệp này
 * (`tests/payroll-owner-apply.test.ts` quét mã nguồn):
 *  0. Chi phí: `updateExpenseAs` — 11 khoản sao kê chủ shop đã xếp «Chi phí vận hành khác» trên sổ ngân hàng mà dòng
 *     chi phí còn mang nhóm Cước ⇒ đổi nhóm cho khớp; 1 khoản sổ ngân hàng xếp «Phí hoàn», trả cho cá nhân ngoài
 *     Viettel Post ⇒ khai «Điều chỉnh có lý do» kèm mã giao dịch.
 *  1. Nguồn ghi nhận chi phí nhân sự: CHỈ KIỂM = «Bảng Lương» (chủ shop đã tự chuyển 22/10 05:59Z).
 *  2. Quy chế chia thưởng: `saveProfitGatePolicyAs`.
 *  3. Hồ sơ nhân sự: `saveEmployeeAs` (giữ nguyên mọi ô khác, kể cả tài khoản nhận lương).
 *  4. Sổ mã: `revokeCodeRowAs` → `saveCodeAssignmentAs` → `approveCodeRowAs`.
 *  5. Chốt lương LẦN LƯỢT từng tháng: `calculatePayrollPeriodAs` → `movePayrollRunAs` (gửi duyệt · duyệt · khoá) — CHỈ
 *     khi ngay trước đó tháng ấy: cổng đã xác lập · mọi người có thực nhận · thưởng % LN đúng dự kiến. Lệch ⇒ DỪNG.
 *
 * Người thao tác = tài khoản chủ shop khai ở `org.owner` (id · còn bật · ADMIN — `isDeclaredOwner`); thiếu ⇒ DỪNG.
 * Kho PUBLIC: bản kế hoạch chỉ chứa mã (UUID · mã giao dịch ngân hàng · mã hàng), không tên, không số tài khoản.
 */
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { guardWithinScope } from "@/lib/approvals/execution";
import { isDeclaredOwner, ORG_OWNER_KEY, parseOrgOwner } from "@/lib/constants/org-owner";
import { DEFAULT_PROFIT_GATE_CONFIG, PAYROLL_PROFIT_GATE_KEY, type ProfitGateConfig } from "@/lib/constants/payroll-profit-gate";
import { monthPeriod } from "@/lib/constants/payroll-autopilot";
import { normalizePayrollStatus, isFrozen } from "@/lib/constants/payroll-lifecycle";
import { updateExpenseAs } from "@/lib/finance/expense-service";
import { vnDateKey } from "@/lib/format";
import { approveCodeRowAs, revokeCodeRowAs, saveCodeAssignmentAs } from "@/lib/payroll/code-book-service";
import { saveEmployeeAs } from "@/lib/payroll/employee-service";
import { profitGateSchema, saveProfitGatePolicyAs } from "@/lib/payroll/profit-gate-service";
import { calculatePayrollPeriodAs, movePayrollRunAs } from "@/lib/payroll/run-service";
import { getPayrollReport, listEmployees, monthReportPeriod } from "@/lib/queries/payroll";
import { DEFAULT_PAYROLL_RECOGNITION, PAYROLL_RECOGNITION_KEY, type PayrollRecognitionConfig } from "@/lib/queries/payroll-cost";
import { getSettingJson } from "@/lib/settings";
import { codeAssignmentSchema } from "@/lib/validation/payroll-code";
import { employeeSchema } from "@/lib/validation/payroll";
import { expenseSchema } from "@/lib/validation/expenses";
import { clearMemo } from "@/lib/cache";
import type { Employee } from "@/lib/constants/payroll";

export const AUDIT_NOTE = "Chủ shop ủy quyền Tech Lead thực hiện, 22/10/2026";

export type OwnerApplyPlan = {
  expenses: { id: string; ft: string; amount: number; to: { category: "OTHER" | "RETURN_FEE"; costSource: "MANUAL" | "MANUAL_ADJUSTMENT"; reason: string } }[];
  gate: Record<string, unknown>;
  employees: { id: string; set: Partial<Pick<Employee, "percentPersonal" | "percentTotal" | "startedOn">> }[];
  code: { productId: string; employeeId: string; fromRateBp: number; toRatePercent: number; effectiveFrom: string; policyRef: string; revokeReason: string; note: string } | null;
  months: string[];
  /** Thưởng % LN ĐỦ ĐIỀU KIỆN dự kiến của từng tháng (chủ shop 21/10: lỗ lũy kế mọi tháng ⇒ 0). */
  expectedEligibleBonus: number;
  basis: "profit1";
};

const MKT_REF = "Quy chế thưởng MKT theo mã 21/10/2026";
const NV_HIEU = "63752895-1ed3-4880-bdac-916880d52d97";
const NV_TRINH = "590efdb6-e5e0-4b57-b40f-1cdcb717f750";
const NV_NHAT = "fe7ae7d7-74ad-4a70-b382-93359d4a2785";
const NV_QUAN = "b6373e43-97ea-45a3-908d-3f55e2a4b1ce";
const CHI_KHAC = "Sổ ngân hàng: chủ shop xếp giao dịch này nhóm «Chi phí vận hành khác» (OTHER_EXPENSE) — không phải cước vận đơn.";

/** Kế hoạch production (đo 22/10/2026: db-query 39733590290 · 39731480532 · 39733710649). */
export const PLAN: OwnerApplyPlan = {
  expenses: [
    ["99813862-2486-4fd6-8ecc-a2ec717b501b", "FT26224840326065", 250_000],
    ["b4173f9a-1786-44a3-9455-c83404ce2164", "FT26225825220301", 66_000],
    ["8269d937-821a-45d0-9efb-ec984695bbdd", "FT26226683106653", 200_000],
    ["246e66d2-608c-41e0-840e-d50d74129e01", "FT26226906037760", 150_000],
    ["411e9fab-95af-46c9-8877-f8137c1550b9", "FT26229266557229", 137_000],
    ["2e1fa612-6dc7-4528-ab97-4b55f16d10f3", "FT26230244009516", 328_000],
    ["aefbad82-3117-4d31-8ff8-9c2846d880b2", "FT26230700414510", 120_000],
    ["9e0d562e-935c-4c51-b748-0562141705da", "FT26239449675780", 110_000],
    ["f2cf45e0-8cde-4ca9-9b9c-69cdd3539878", "FT26239926466081", 176_000],
    ["707c9209-94b6-47ca-848b-10deb3a1ba80", "FT26240476739487", 100_000],
    ["cfc925d7-6a3a-42b0-8c48-eace71adf243", "FT26241271998066", 1_000_000],
  ]
    .map(([id, ft, amount]): OwnerApplyPlan["expenses"][number] => ({ id: id as string, ft: ft as string, amount: amount as number, to: { category: "OTHER", costSource: "MANUAL", reason: "" } }))
    .concat([
      {
        id: "2f504319-a008-4594-9d13-98f436d613d5",
        ft: "FT26246226079025",
        amount: 502_000,
        to: { category: "RETURN_FEE" as const, costSource: "MANUAL_ADJUSTMENT" as const, reason: "Phí hoàn trả ngoài vận đơn Viettel Post — sổ ngân hàng FT26246226079025, chủ shop xếp nhóm «Phí hoàn»; trả cho cá nhân, không nằm trong bảng kê ĐVVC." },
      },
    ]),
  gate: {
    openingMonth: "2026-06",
    openingCumulative: 0,
    openingHighWater: 0,
    openingPaidBonus: 0,
    poolCapPercent: "",
    poolCapSchedule: [
      { fromMonth: "2026-06", percent: 35 },
      { fromMonth: "2026-11", percent: 40 },
    ],
    residualClaimantId: NV_QUAN,
    regulationRef: MKT_REF,
    reason: "Chủ shop quyết 21/10/2026: số dư mở sổ 0 ₫ tại 06/2026; trần 35% tới 10/2026, 40% từ 11/2026; Quân nhận phần còn lại.",
  },
  employees: [
    { id: NV_HIEU, set: { percentPersonal: 0 } },
    { id: NV_TRINH, set: { percentPersonal: 0, startedOn: "2026-08-01" } },
    { id: NV_NHAT, set: { startedOn: "2026-08-01" } },
  ],
  code: {
    productId: "8e8e0507-fd40-480e-a13c-426ede8233cc",
    employeeId: NV_HIEU,
    fromRateBp: 2500,
    toRatePercent: 30,
    effectiveFrom: "2026-06-01",
    policyRef: MKT_REF,
    revokeReason: "Chủ shop đổi Hiếu lên 30% ngày 21/10/2026",
    note: "Chủ shop đổi tỷ lệ OWNER mã Q006 lên 30% ngày 21/10/2026",
  },
  months: ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10"],
  expectedEligibleBonus: 0,
  basis: "profit1",
};

type Log = { detail: (s: string) => void; summary: (s: string) => void };
const consoleLog: Log = { detail: (s) => console.log(s), summary: (s) => console.log(`[ops:tom-tat] ${s}`) };
const tien = (v: number | null | undefined) => (v === null || v === undefined ? "—" : Math.round(v).toLocaleString("vi-VN"));

export type OwnerApplyResult = { stoppedAt: string | null; reason: string | null; changes: number; months: { month: string; status: string }[] };

/** Hồ sơ hiện tại ⇒ đầu vào của `employeeSchema` (giữ nguyên mọi ô), rồi đè đúng các ô của kế hoạch. */
export function employeeFormOf(e: Employee, set: OwnerApplyPlan["employees"][number]["set"]) {
  return {
    id: e.id,
    name: e.name,
    shortName: e.shortName ?? "",
    department: e.department,
    aliases: (e.aliases ?? []).join(", "),
    accountIds: (e.accountIds ?? []).join(", "),
    userEmail: e.userEmail ?? "",
    fixed: e.fixed,
    percentTotal: set.percentTotal ?? e.percentTotal,
    percentPersonal: set.percentPersonal ?? e.percentPersonal,
    percentRevenue: e.percentRevenue,
    active: e.active,
    note: e.note ?? "",
    startedOn: set.startedOn ?? e.startedOn ?? "",
    leftOn: e.leftOn ?? "",
    bankBin: e.bankBin ?? "",
    bankAccount: e.bankAccount ?? "",
    bankAccountName: e.bankAccountName ?? "",
  };
}

/**
 * Tháng đủ điều kiện chốt: cổng đã xác lập · mọi người có thực nhận · thưởng đủ điều kiện = dự kiến.
 * Câu trả về đi vào kênh TÓM TẮT CÔNG KHAI ⇒ chỉ có SỐ ĐẾM, không tên, không số tiền của một người.
 */
export function monthVerdict(r: { established: boolean; status: string; lines: { name: string; salary: number | null; eligible: number | null }[] }, expectedBonus: number): string | null {
  if (!r.established) return `cổng lợi nhuận chưa xác lập (${r.status})`;
  const thieu = r.lines.filter((l) => l.salary === null).length;
  if (thieu) return `${thieu}/${r.lines.length} người chưa có thực nhận`;
  const chuaBiet = r.lines.filter((l) => l.eligible === null).length;
  if (chuaBiet) return `${chuaBiet}/${r.lines.length} người chưa biết thưởng % LN đủ điều kiện`;
  const lech = r.lines.reduce((t, l) => t + (l.eligible ?? 0), 0) !== expectedBonus;
  if (lech) return "tổng thưởng % LN đủ điều kiện khác dự kiến (chi tiết từng người ở phần mã hoá)";
  return null;
}

export async function runOwnerApply(plan: OwnerApplyPlan, opts: { apply: boolean; log?: Log }): Promise<OwnerApplyResult> {
  const log = opts.log ?? consoleLog;
  const db = await getDb();
  const out: OwnerApplyResult = { stoppedAt: null, reason: null, changes: 0, months: [] };
  const dung = (buoc: string, ly: string) => {
    out.stoppedAt = buoc;
    out.reason = ly;
    log.summary(`✗ DỪNG ở ${buoc}: ${ly}`);
    return out;
  };
  log.summary(`payroll-owner-apply · ${opts.apply ? "GHI THẬT" : "CHẠY THỬ (thêm --apply để ghi)"}`);

  // ── Người thao tác = chủ shop đã khai ──
  const [oRow] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, ORG_OWNER_KEY)).limit(1);
  const decl = parseOrgOwner(oRow?.value ?? null);
  const [u] = decl ? await db.select({ id: schema.users.id, email: schema.users.email, active: schema.users.active, role: schema.users.role }).from(schema.users).where(eq(schema.users.id, decl.userId)).limit(1) : [];
  if (!decl || !u || !isDeclaredOwner(decl, u)) return dung("người thao tác", "org.owner chưa khai hoặc không hợp lệ (id · còn bật · ADMIN)");
  const actor = { id: u.id, email: u.email, role: String(u.role) };
  const guard = (input: Parameters<typeof guardWithinScope>[2]) => guardWithinScope(db, { id: actor.id, email: actor.email }, input);
  log.summary("người thao tác: chủ shop khai ở org.owner (id · còn bật · ADMIN)");

  // ── 0 · Chi phí theo sổ ngân hàng ──
  let doi0 = 0;
  for (const x of plan.expenses) {
    const [e] = await db.select().from(schema.expenses).where(eq(schema.expenses.id, x.id)).limit(1);
    if (!e) return dung("0 · chi phí", `không thấy khoản ${x.id}`);
    if (!e.reference.includes(x.ft) || e.amount !== x.amount) return dung("0 · chi phí", `khoản ${x.id} không còn khớp (mã giao dịch / số tiền đã đổi) — không sửa`);
    const xong = e.category === x.to.category && e.costSource === x.to.costSource && (x.to.costSource !== "MANUAL_ADJUSTMENT" || e.reason.trim() === x.to.reason);
    log.detail(`   0 · ${x.id} · ${vnDateKey(e.occurredAt)} · ${tien(e.amount)} · ${e.category}/${e.costSource} → ${x.to.category}/${x.to.costSource}${xong ? " · ĐÃ ĐÚNG" : ""}`);
    if (xong) continue;
    doi0++;
    if (!opts.apply) continue;
    const parsed = expenseSchema.safeParse({ category: x.to.category, description: e.description, amount: e.amount, occurredAt: vnDateKey(e.occurredAt), reference: e.reference, costSource: x.to.costSource, reason: x.to.costSource === "MANUAL_ADJUSTMENT" ? x.to.reason : (e.reason ?? "") || CHI_KHAC });
    if (!parsed.success) return dung("0 · chi phí", `${x.id}: ${parsed.error.issues[0]?.message}`);
    const kq = await updateExpenseAs({ id: actor.id, email: actor.email }, x.id, parsed.data, { guard, auditNote: `${AUDIT_NOTE} · theo sổ ngân hàng ${x.ft}` });
    if ("error" in kq) return dung("0 · chi phí", `${x.id}: ${kq.error}`);
    out.changes++;
  }
  log.summary(`0 · chi phí: ${plan.expenses.length} khoản · ${doi0} cần đổi${opts.apply ? " · đã ghi" : ""}`);

  // ── 1 · Nguồn ghi nhận chi phí nhân sự (chỉ kiểm) ──
  const rec = await getSettingJson<PayrollRecognitionConfig>(PAYROLL_RECOGNITION_KEY, DEFAULT_PAYROLL_RECOGNITION);
  if (rec.mode !== "PAYROLL") return dung("1 · nguồn ghi nhận", `đang là ${rec.mode} — chủ shop chuyển «Bảng Lương» ở Lương → Cấu hình (có cổng người thứ hai + nhật ký)`);
  log.summary("1 · nguồn ghi nhận chi phí nhân sự = Bảng Lương ✓");

  // ── 2 · Quy chế chia thưởng ──
  const gp = profitGateSchema.safeParse(plan.gate);
  if (!gp.success) return dung("2 · quy chế", gp.error.issues[0]?.message ?? "lược đồ");
  const cfg = await getSettingJson<ProfitGateConfig>(PAYROLL_PROFIT_GATE_KEY, DEFAULT_PROFIT_GATE_CONFIG);
  const a = cfg.active;
  const lichKhop = (x: { fromMonth: string; percent: number }[] | undefined) => JSON.stringify([...(x ?? [])].sort((p, q) => p.fromMonth.localeCompare(q.fromMonth))) === JSON.stringify([...gp.data.poolCapSchedule].sort((p, q) => p.fromMonth.localeCompare(q.fromMonth)));
  const gateXong =
    Boolean(a) &&
    a!.openingMonth === gp.data.openingMonth &&
    a!.openingCumulative === gp.data.openingCumulative &&
    a!.openingHighWater === gp.data.openingHighWater &&
    (a!.poolCapPercent ?? null) === gp.data.poolCapPercent &&
    lichKhop(a!.poolCapSchedule) &&
    (a!.residualClaimant?.employeeId ?? null) === (gp.data.residualClaimantId ?? null) &&
    a!.regulationRef === gp.data.regulationRef;
  log.detail(`   2 · quy chế hiện tại: ${a ? `v${a.version} mở sổ ${a.openingMonth}` : "CHƯA KHAI"} ⇒ đích: mở sổ ${gp.data.openingMonth} · lịch ${gp.data.poolCapSchedule.map((m) => `${m.percent}% từ ${m.fromMonth}`).join(" · ")} · người nhận phần còn lại ${gp.data.residualClaimantId ?? "—"}${gateXong ? " · ĐÃ ĐÚNG" : ""}`);
  if (!gateXong && opts.apply) {
    const kq = await saveProfitGatePolicyAs({ id: actor.id, email: actor.email }, gp.data, { guard, auditNote: AUDIT_NOTE });
    if ("error" in kq) return dung("2 · quy chế", kq.error);
    out.changes++;
  }
  log.summary(`2 · quy chế chia thưởng: ${gateXong ? "đã đúng" : opts.apply ? "đã khai phiên bản mới" : "cần khai phiên bản mới"}`);

  // ── 3 · Hồ sơ nhân sự ──
  const nv = await listEmployees();
  let doi3 = 0;
  for (const x of plan.employees) {
    const e = nv.find((n) => n.id === x.id);
    if (!e) return dung("3 · hồ sơ", `không thấy nhân sự ${x.id}`);
    const dich = employeeFormOf(e, x.set);
    const xong = dich.percentPersonal === e.percentPersonal && dich.percentTotal === e.percentTotal && dich.startedOn === (e.startedOn ?? "");
    log.detail(`   3 · ${e.shortName || e.name}: % cá nhân ${e.percentPersonal} → ${dich.percentPersonal} · % tổng ${e.percentTotal} → ${dich.percentTotal} · vào làm ${e.startedOn ?? "—"} → ${dich.startedOn || "—"}${xong ? " · ĐÃ ĐÚNG" : ""}`);
    if (xong) continue;
    doi3++;
    if (!opts.apply) continue;
    const parsed = employeeSchema.safeParse(dich);
    if (!parsed.success) return dung("3 · hồ sơ", `${x.id}: ${parsed.error.issues[0]?.message}`);
    await saveEmployeeAs({ id: actor.id, email: actor.email }, parsed.data, { auditNote: AUDIT_NOTE });
    out.changes++;
  }
  log.summary(`3 · hồ sơ nhân sự: ${plan.employees.length} người · ${doi3} cần sửa${opts.apply ? " · đã ghi" : ""}`);

  // ── 4 · Sổ mã ──
  if (plan.code) {
    const c = plan.code;
    const t = schema.productMarketerAssignments;
    const dong = await db.select().from(t).where(eq(t.productId, c.productId));
    const cua = dong.filter((r) => r.employeeId === c.employeeId && r.role === "OWNER");
    const dichBp = Math.round(c.toRatePercent * 100);
    const daCo = cua.find((r) => r.status === "APPROVED" && r.ownerRateBp === dichBp);
    const cu = cua.find((r) => r.status === "APPROVED" && r.ownerRateBp === c.fromRateBp);
    log.detail(`   4 · mã ${c.productId.slice(0, 8)} · nhân sự ${c.employeeId.slice(0, 8)}: OWNER ${(c.fromRateBp / 100).toFixed(0)}% → ${c.toRatePercent}% từ ${c.effectiveFrom}${daCo ? " · ĐÃ ĐÚNG" : ""}`);
    if (!daCo && opts.apply) {
      if (cu) {
        const r1 = await revokeCodeRowAs(actor, { kind: "ASSIGNMENT", id: cu.id, reason: c.revokeReason }, { guard, auditNote: AUDIT_NOTE });
        if ("error" in r1) return dung("4 · sổ mã (huỷ)", r1.error);
        out.changes++;
      }
      const cho = cua.find((r) => r.status === "PENDING" && r.ownerRateBp === dichBp);
      let idMoi = cho?.id ?? null;
      if (!idMoi) {
        const parsed = codeAssignmentSchema.safeParse({ productId: c.productId, employeeId: c.employeeId, role: "OWNER", ownerRatePercent: c.toRatePercent, effectiveFrom: c.effectiveFrom, policyRef: c.policyRef, note: c.note });
        if (!parsed.success) return dung("4 · sổ mã (giao)", parsed.error.issues[0]?.message ?? "lược đồ");
        const r2 = await saveCodeAssignmentAs(actor, parsed.data, { auditNote: AUDIT_NOTE });
        if ("error" in r2) return dung("4 · sổ mã (giao)", r2.error);
        idMoi = r2.id ?? null;
        out.changes++;
      }
      if (!idMoi) return dung("4 · sổ mã (giao)", "không đọc được mã dòng mới");
      const r3 = await approveCodeRowAs(actor, { kind: "ASSIGNMENT", id: idMoi }, { guard, auditNote: AUDIT_NOTE });
      if ("error" in r3) return dung("4 · sổ mã (duyệt)", r3.error);
      out.changes++;
    }
    log.summary(`4 · sổ mã: ${daCo ? "đã đúng" : opts.apply ? "đã huỷ dòng cũ · giao · duyệt" : "cần huỷ dòng cũ · giao · duyệt"}`);
  }

  // ── 5 · Chốt lương lần lượt ──
  if (!opts.apply) log.summary("5 · CHẠY THỬ: phép kiểm từng tháng dưới đây đọc dữ liệu HIỆN TẠI — bước 0–4 chưa ghi, và tháng sau chỉ xác lập khi tháng trước đã khoá.");
  for (const m of plan.months) {
    const mp = monthPeriod(m);
    const p = schema.payrollPeriods;
    const [ky] = await db.select({ status: p.status }).from(p).where(and(eq(p.periodKey, mp.periodKey), eq(p.basis, plan.basis))).limit(1);
    const hienTai = ky ? normalizePayrollStatus(ky.status) : null;
    if (hienTai && isFrozen(hienTai)) {
      out.months.push({ month: m, status: "ĐÃ KHOÁ" });
      log.summary(`5 · ${m}: đã khoá — bỏ qua`);
      continue;
    }
    clearMemo();
    const r = await getPayrollReport(monthReportPeriod(m), plan.basis);
    const lines = r.lines.map((l) => ({ name: l.employee.shortName || l.employee.name, salary: l.salary, eligible: l.profitShare.eligible }));
    for (const l of lines) log.detail(`   5 · ${m} · ${l.name.padEnd(12)} thực nhận ${tien(l.salary).padStart(12)} · thưởng LN đủ ĐK ${tien(l.eligible)}`);
    const sai = monthVerdict({ established: r.profitGate.result.established, status: r.profitGate.result.status, lines }, plan.expectedEligibleBonus);
    if (sai) {
      out.months.push({ month: m, status: `CHƯA CHỐT: ${sai}` });
      return opts.apply ? dung(`5 · chốt ${m}`, sai) : (log.summary(`5 · ${m}: chưa chốt được — ${sai}`), out);
    }
    if (!opts.apply) {
      out.months.push({ month: m, status: "đủ điều kiện chốt" });
      log.summary(`5 · ${m}: đủ điều kiện chốt (cổng ${r.profitGate.result.status}, ${lines.length} người, thưởng LN đủ ĐK = dự kiến)`);
      return out; // tháng sau chỉ xác lập khi tháng này đã khoá ⇒ chạy thử dừng ở đây
    }
    // Lượt trước dừng giữa chừng ở «Đã duyệt» thì chỉ còn khoá (kỳ đã duyệt không tính lại được — phải «Trả lại» trước).
    const buoc = hienTai === "APPROVED" ? (["LOCK"] as const) : (["SUBMIT_REVIEW", "APPROVE", "LOCK"] as const);
    if (hienTai !== "APPROVED") {
      const tinh = await calculatePayrollPeriodAs({ id: actor.id, email: actor.email }, { from: mp.fromKey, to: mp.toKey, basis: plan.basis, note: AUDIT_NOTE });
      if ("error" in tinh) return dung(`5 · tính ${m}`, tinh.error);
    }
    for (const action of buoc) {
      const mv = await movePayrollRunAs({ id: actor.id, email: actor.email }, { periodKey: mp.periodKey, basis: plan.basis, action, reason: AUDIT_NOTE }, { guard });
      if ("error" in mv) return dung(`5 · ${action} ${m}`, mv.error);
    }
    out.changes++;
    out.months.push({ month: m, status: "ĐÃ KHOÁ (lượt này)" });
    log.summary(`5 · ${m}: đã tính · gửi duyệt · duyệt · khoá`);
  }
  log.summary(`xong · ${out.changes} lượt ghi`);
  return out;
}

if (process.argv[1]?.endsWith("payroll-owner-apply.ts")) {
  runOwnerApply(PLAN, { apply: process.argv.includes("--apply") })
    .then((r) => process.exit(r.stoppedAt ? 1 : 0))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}

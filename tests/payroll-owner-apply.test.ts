/**
 * ═══ `scripts/payroll-owner-apply.ts` — THỰC HIỆN QUYẾT ĐỊNH LƯƠNG CỦA CHỦ SHOP QUA ĐÚNG LÕI CỦA MÀN HÌNH ═══
 *
 * Bốn điều Tech Lead đặt làm điều kiện (22/10/2026):
 *   1. CHẠY THỬ không ghi gì — đếm từng bảng / từng khoá settings trước và sau.
 *   2. Chạy lại lần hai (sau `--apply`) không đổi gì — 0 lượt ghi, nhật ký không dài thêm.
 *   3. Một tháng lệch dự kiến ⇒ DỪNG đúng ở tháng đó, kỳ ấy không được tạo.
 *   4. Server action và script đi qua CÙNG MỘT lõi; tệp action không còn bản sao logic ghi (quét mã nguồn).
 *
 * Dữ liệu riêng: tháng 01–03/2030, tiền tố `poa-`; settings dùng chung được trả lại khi xong.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { and, eq, like, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { ORG_OWNER_KEY } from "@/lib/constants/org-owner";
import { PAYROLL_EMPLOYEES_KEY, type Employee } from "@/lib/constants/payroll";
import { PAYROLL_CARRYOVER_KEY } from "@/lib/constants/payroll-carryover";
import { DEFAULT_PROFIT_GATE_CONFIG, PAYROLL_PROFIT_GATE_KEY, type ProfitGateConfig } from "@/lib/constants/payroll-profit-gate";
import { monthPeriodKey } from "@/lib/queries/payroll-profit-gate";
import { PAYROLL_RECOGNITION_KEY } from "@/lib/queries/payroll-cost";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import { monthVerdict, runOwnerApply, type OwnerApplyPlan } from "../scripts/payroll-owner-apply";

const OWNER = "poa-chu";
const X: Employee = { id: "poa-x", name: "Nhân sự POA X", shortName: "POA-X", department: "Marketing", aliases: [], accountIds: [], userEmail: "", fixed: 1_000_000, percentTotal: 0, percentPersonal: 20, percentRevenue: 0, active: true, note: "" };
const Y: Employee = { ...X, id: "poa-y", name: "Nhân sự POA Y", shortName: "POA-Y", fixed: 0, percentTotal: 35, percentPersonal: 0 };

const PLAN: OwnerApplyPlan = {
  expenses: [
    { id: "poa-e1", ft: "FTPOA0001", amount: 250_000, to: { category: "OTHER", costSource: "MANUAL", reason: "" } },
    { id: "poa-e2", ft: "FTPOA0002", amount: 502_000, to: { category: "RETURN_FEE", costSource: "MANUAL_ADJUSTMENT", reason: "Phí hoàn ngoài vận đơn — sổ ngân hàng FTPOA0002" } },
  ],
  gate: {
    openingMonth: "2030-01",
    openingCumulative: 0,
    openingHighWater: 0,
    openingPaidBonus: 0,
    poolCapPercent: "",
    poolCapSchedule: [
      { fromMonth: "2030-01", percent: 35 },
      { fromMonth: "2030-11", percent: 40 },
    ],
    residualClaimantId: Y.id,
    regulationRef: "Quy chế kiểm thử POA",
    reason: "Bài kiểm payroll-owner-apply",
  },
  employees: [{ id: X.id, set: { percentPersonal: 0, startedOn: "2030-01-01" } }],
  code: { productId: "poa-prod", employeeId: X.id, fromRateBp: 2500, toRatePercent: 30, effectiveFrom: "2030-01-01", policyRef: "Quy chế kiểm thử POA", revokeReason: "Chủ shop đổi lên 30% (kiểm thử)", note: "kiểm thử" },
  months: ["2030-01", "2030-02"],
  expectedEligibleBonus: 0,
  basis: "profit1",
};

const SETTINGS = [ORG_OWNER_KEY, PAYROLL_EMPLOYEES_KEY, PAYROLL_PROFIT_GATE_KEY, PAYROLL_RECOGNITION_KEY, PAYROLL_CARRYOVER_KEY];

/** Ảnh trạng thái của mọi thứ script có thể chạm — để chứng minh "không ghi gì". */
async function anh(db: Db) {
  const st = await db.select({ key: schema.settings.key, value: schema.settings.value }).from(schema.settings);
  return JSON.stringify({
    settings: st.filter((s) => SETTINGS.includes(s.key)).sort((a, b) => a.key.localeCompare(b.key)),
    expenses: await db.select().from(schema.expenses).where(like(schema.expenses.id, "poa-%")),
    codes: await db.select().from(schema.productMarketerAssignments).where(eq(schema.productMarketerAssignments.productId, "poa-prod")),
    periods: await db.select({ n: sql<number>`count(*)::int` }).from(schema.payrollPeriods),
    audits: await db.select({ n: sql<number>`count(*)::int` }).from(schema.auditLogs),
  });
}

function testSourceFences() {
  const doc = (f: string) => readFileSync(f, "utf8");
  const script = doc("scripts/payroll-owner-apply.ts");
  for (const cam of [".insert(", ".update(", ".delete(", "db.execute(", "setSettingJson(", "transitionPayrollRunAs("]) {
    assert.ok(!script.includes(cam), `script không tự ghi (${cam}) — mọi lượt ghi qua lõi của màn hình`);
  }
  for (const loi of ["updateExpenseAs(", "saveProfitGatePolicyAs(", "saveEmployeeAs(", "revokeCodeRowAs(", "saveCodeAssignmentAs(", "approveCodeRowAs(", "calculatePayrollPeriodAs(", "movePayrollRunAs("]) {
    assert.ok(script.includes(loi), `script gọi lõi ${loi}`);
  }

  /** Thân một hàm top-level (tới dòng `}` đầu tiên ở cột 0). */
  const than = (src: string, header: string) => {
    const i = src.indexOf(header);
    assert.ok(i >= 0, `có ${header}`);
    return src.slice(i, src.indexOf("\n}\n", i) + 2);
  };
  // Mỗi cặp: [tệp action, hàm action, lõi nó phải gọi, mảnh logic ghi KHÔNG được còn trong thân action]
  const cap: [string, string, string, string[]][] = [
    ["lib/actions/payroll-code.ts", "export async function saveCodeAssignment(", "saveCodeAssignmentAs(", [".insert(", "audit("]],
    ["lib/actions/payroll-code.ts", "export async function approveCodeRow(", "approveCodeRowAs(", [".update(", ".set({", "audit(", "guardSecondApproval({"]],
    ["lib/actions/payroll-code.ts", "export async function revokeCodeRow(", "revokeCodeRowAs(", [".update(", ".set({", "audit(", "guardSecondApproval({"]],
    ["lib/actions/payroll-policy.ts", "export async function saveProfitGatePolicy(", "saveProfitGatePolicyAs(", ["ghiSoCong(", "audit(", "guardSecondApproval({"]],
    ["lib/actions/payroll.ts", "export async function saveEmployee(", "saveEmployeeAs(", ["setSettingJson(", "audit(", "reapplyAdsMapping("]],
    ["lib/actions/expenses.ts", "export async function updateExpense(", "updateExpenseAs(", [".update(", "audit(", "guardSecondApproval({"]],
    ["lib/actions/payroll-run.ts", "export async function movePayrollRun(", "movePayrollRunAs(", ["transitionPayrollRunAs(", "canTransition(", "guardSecondApproval({"]],
  ];
  for (const [tep, header, loi, cam] of cap) {
    const b = than(doc(tep), header);
    assert.ok(b.includes(loi), `${tep}: ${header.trim()} gọi ${loi}`);
    for (const c of cam) assert.ok(!b.includes(c), `${tep}: ${header.trim()} không còn bản sao logic ghi (${c}) — đã chuyển vào lõi`);
  }
  // Lõi KHÔNG phải server action: "use server" biến mọi export thành cửa gọi từ trình duyệt, kể cả hàm nhận `guard`.
  for (const tep of ["lib/payroll/code-book-service.ts", "lib/payroll/profit-gate-service.ts", "lib/payroll/employee-service.ts", "lib/finance/expense-service.ts", "lib/payroll/run-service.ts"]) {
    assert.ok(!/^\s*["']use server["']/m.test(doc(tep)), `${tep} không phải server action`);
  }
}

function testVerdictPure() {
  const ok = { established: true, status: "NO_ELIGIBLE_PROFIT", lines: [{ name: "Tên Riêng A", salary: 5, eligible: 0 }] };
  assert.equal(monthVerdict(ok, 0), null);
  assert.match(monthVerdict({ ...ok, established: false, status: "NOT_ESTABLISHED" }, 0) ?? "", /chưa xác lập/);
  const thieu = monthVerdict({ ...ok, lines: [{ name: "Tên Riêng A", salary: null, eligible: 0 }] }, 0) ?? "";
  assert.match(thieu, /1\/1 người chưa có thực nhận/);
  assert.ok(!thieu.includes("Tên Riêng A"), "câu dừng đi ra kênh tóm tắt công khai ⇒ không mang tên người");
  assert.match(monthVerdict({ ...ok, lines: [{ name: "A", salary: 5, eligible: null }] }, 0) ?? "", /chưa biết thưởng/);
  const lech = monthVerdict({ ...ok, lines: [{ name: "A", salary: 5, eligible: 123_456 }] }, 0) ?? "";
  assert.match(lech, /khác dự kiến/);
  assert.ok(!lech.includes("123"), "không in số tiền của một người ra kênh tóm tắt");
}

async function testFlow(db: Db) {
  const truoc = new Map<string, unknown>();
  for (const k of SETTINGS) truoc.set(k, await getSettingJson<unknown>(k, null));
  try {
    await db.insert(schema.users).values({ id: OWNER, email: "poa-chu@t.local", name: "Chủ shop POA", role: "ADMIN", passwordHash: "x", active: true }).onConflictDoNothing();
    await setSettingJson(ORG_OWNER_KEY, { userId: OWNER, decidedAt: "2030-01-01", note: "kiểm thử" });
    await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [X, Y] });
    await setSettingJson(PAYROLL_RECOGNITION_KEY, { mode: "PAYROLL" });
    await setSettingJson(PAYROLL_CARRYOVER_KEY, { enabled: false, startMonth: null, startNote: "" });
    await setSettingJson(PAYROLL_PROFIT_GATE_KEY, DEFAULT_PROFIT_GATE_CONFIG);
    await db.insert(schema.products).values({ id: "poa-prod", name: "Mã kiểm thử POA" }).onConflictDoNothing();
    await db.insert(schema.productMarketerAssignments).values({ id: "poa-as-1", productId: "poa-prod", employeeId: X.id, role: "OWNER", ownerRateBp: 2500, effectiveFrom: new Date("2029-12-31T17:00:00Z"), policyRef: "QC-POA", status: "APPROVED", approvedBy: OWNER, approvedAt: new Date("2029-12-31T17:00:00Z") });
    await db.insert(schema.expenses).values([
      { id: "poa-e1", category: "SHIPPING", description: "Chuyển khoản POA 1", amount: 250_000, occurredAt: new Date("2030-01-11T17:00:00Z"), reference: "MB FTPOA0001" },
      { id: "poa-e2", category: "RETURN_FEE", description: "Chuyển khoản POA 2", amount: 502_000, occurredAt: new Date("2030-01-12T17:00:00Z"), reference: "MB FTPOA0002" },
    ]);
    clearMemo();

    // ── 1 · CHẠY THỬ không ghi gì ──
    const tomTat: string[] = [];
    const chiTiet: string[] = [];
    const log = { summary: (s: string) => tomTat.push(s), detail: (s: string) => chiTiet.push(s) };
    const a0 = await anh(db);
    const thu = await runOwnerApply(PLAN, { apply: false, log });
    assert.equal(await anh(db), a0, "1. CHẠY THỬ không đổi một dòng / một khoá settings / một dòng nhật ký nào");
    assert.equal(thu.changes, 0);
    assert.equal(thu.stoppedAt, null, "chạy thử không phải lỗi");
    assert.match(thu.months[0]?.status ?? "", /CHƯA CHỐT: cổng lợi nhuận chưa xác lập/, "chạy thử đọc dữ liệu HIỆN TẠI: quy chế chưa khai ⇒ nói ra, không giả vờ");
    assert.ok(tomTat.some((s) => /0 · chi phí: 2 khoản · 2 cần đổi/.test(s)));
    assert.ok(tomTat.some((s) => /2 · quy chế chia thưởng: cần khai/.test(s)));
    assert.ok(tomTat.some((s) => /3 · hồ sơ nhân sự: 1 người · 1 cần sửa/.test(s)));
    for (const s of tomTat) for (const e of [X, Y]) assert.ok(!s.includes(e.name) && !s.includes(e.shortName ?? "§"), `kênh tóm tắt công khai không mang tên người: ${s}`);
    assert.ok(chiTiet.some((s) => s.includes("POA-X")), "tên chỉ ở phần chi tiết (mã hoá)");

    // ── 2 · GHI ──
    const ghi = await runOwnerApply(PLAN, { apply: true, log: { summary: () => {}, detail: () => {} } });
    assert.equal(ghi.stoppedAt, null, `ghi trọn: ${ghi.reason}`);
    assert.deepEqual(ghi.months.map((m) => m.status), ["ĐÃ KHOÁ (lượt này)", "ĐÃ KHOÁ (lượt này)"], "hai tháng chốt LẦN LƯỢT — tháng 2 chỉ xác lập sau khi tháng 1 khoá");
    const e = await db.select().from(schema.expenses).where(like(schema.expenses.id, "poa-%"));
    assert.deepEqual(e.sort((a, b) => a.id.localeCompare(b.id)).map((r) => [r.category, r.costSource]), [["OTHER", "MANUAL"], ["RETURN_FEE", "MANUAL_ADJUSTMENT"]]);
    assert.equal(e.find((r) => r.id === "poa-e2")?.reason, PLAN.expenses[1].to.reason);
    const cfg = await getSettingJson<ProfitGateConfig>(PAYROLL_PROFIT_GATE_KEY, DEFAULT_PROFIT_GATE_CONFIG);
    assert.deepEqual([cfg.active?.openingMonth, cfg.active?.poolCapPercent, cfg.active?.residualClaimant?.employeeId, cfg.active?.approvedById], ["2030-01", null, Y.id, OWNER], "quy chế khai qua lõi, người duyệt = chủ shop");
    const nv = (await getSettingJson<{ list: Employee[] }>(PAYROLL_EMPLOYEES_KEY, { list: [] })).list.find((n) => n.id === X.id)!;
    assert.deepEqual([nv.percentPersonal, nv.startedOn, nv.fixed, nv.name], [0, "2030-01-01", X.fixed, X.name], "hồ sơ: đổi đúng ô kế hoạch, giữ nguyên mọi ô khác");
    const codes = await db.select().from(schema.productMarketerAssignments).where(eq(schema.productMarketerAssignments.productId, "poa-prod"));
    assert.deepEqual(codes.map((c) => `${c.ownerRateBp}:${c.status}`).sort(), ["2500:REVOKED", "3000:APPROVED"], "sổ mã: huỷ dòng 25% · dòng 30% đã duyệt");
    for (const m of PLAN.months) {
      const [k] = await db.select({ status: schema.payrollPeriods.status, snapshot: schema.payrollPeriods.snapshot }).from(schema.payrollPeriods).where(and(eq(schema.payrollPeriods.periodKey, monthPeriodKey(m)), eq(schema.payrollPeriods.basis, "profit1")));
      assert.equal(k?.status, "LOCKED", `${m} đã khoá`);
    }
    const nk = await db.select({ action: schema.auditLogs.action, reason: schema.auditLogs.reason }).from(schema.auditLogs).where(eq(schema.auditLogs.userId, OWNER));
    for (const act of ["EXPENSE_UPDATE", "PAYROLL_PROFIT_GATE_POLICY", "SETTINGS_UPDATE", "PAYROLL_RUN_LOCK"]) {
      assert.ok(nk.some((r) => r.action === act && (r.reason ?? "").includes("Chủ shop ủy quyền Tech Lead")), `nhật ký ${act} mang người thao tác = chủ shop và lý do ủy quyền`);
    }

    // ── 3 · CHẠY LẠI: không đổi gì ──
    clearMemo();
    const a1 = await anh(db);
    const lai = await runOwnerApply(PLAN, { apply: true, log: { summary: () => {}, detail: () => {} } });
    assert.equal(lai.changes, 0, "2. chạy lần hai: 0 lượt ghi");
    assert.equal(lai.stoppedAt, null);
    assert.deepEqual(lai.months.map((m) => m.status), ["ĐÃ KHOÁ", "ĐÃ KHOÁ"]);
    assert.equal(await anh(db), a1, "2. chạy lần hai không đổi dữ liệu, không thêm dòng nhật ký");

    // ── 4 · LỆCH DỰ KIẾN ⇒ DỪNG ĐÚNG THÁNG ──
    clearMemo();
    const lech = await runOwnerApply({ ...PLAN, months: ["2030-03"], expectedEligibleBonus: 1 }, { apply: true, log: { summary: () => {}, detail: () => {} } });
    assert.equal(lech.stoppedAt, "5 · chốt 2030-03", "3. tháng lệch dự kiến ⇒ dừng ở đúng tháng đó");
    assert.match(lech.reason ?? "", /khác dự kiến/);
    const [k3] = await db.select({ id: schema.payrollPeriods.id }).from(schema.payrollPeriods).where(eq(schema.payrollPeriods.periodKey, monthPeriodKey("2030-03")));
    assert.equal(k3, undefined, "3. kỳ lệch KHÔNG được tạo");

    // ── Người thao tác không phải chủ shop đã khai ⇒ dừng trước mọi bước ──
    await setSettingJson(ORG_OWNER_KEY, { userId: "poa-khong-co", decidedAt: null, note: "" });
    const a2 = await anh(db);
    const sai = await runOwnerApply(PLAN, { apply: true, log: { summary: () => {}, detail: () => {} } });
    assert.equal(sai.stoppedAt, "người thao tác");
    assert.equal(await anh(db), a2, "không có chủ shop hợp lệ ⇒ không ghi gì");
  } finally {
    for (const [k, v] of truoc) {
      if (v === null) await db.delete(schema.settings).where(eq(schema.settings.key, k));
      else await setSettingJson(k, v);
    }
    clearMemo();
  }
}

export async function testPayrollOwnerApply(db: Db) {
  testSourceFences();
  testVerdictPure();
  await testFlow(db);
  console.log("  ✓ payroll-owner-apply: chạy thử không ghi · ghi qua đúng lõi của màn hình (chi phí · quy chế · hồ sơ · sổ mã · chốt kỳ LẦN LƯỢT) · chạy lại 0 lượt ghi · lệch dự kiến ⇒ dừng đúng tháng · kênh tóm tắt không tên/tiền · action và script cùng một lõi");
}

/**
 * ═══════ TRUNG TÂM ĐỐI SOÁT LƯƠNG (Payroll V2, chủ shop 20/10/2026) ═══════
 *
 * Đặc tả `docs/payroll-code-ledger.md` §10. Khoá:
 *  · đề xuất số dư mở sổ chỉ cộng số ĐO ĐƯỢC, tháng thiếu căn cứ nói ra thiếu gì, và không bao giờ là
 *    "đủ căn cứ" khi còn một tháng thiếu — chưa biết không thành 0 (mục 42);
 *  · một danh sách phê duyệt, mỗi mục một PHÒNG (không phải một người — mục 22), có lối sửa;
 *  · phí chiều hoàn VÀO cơ sở lương: phần nối được về đơn gốc gắn mã, phần còn lại vào chi phí chung,
 *    tổng = máy chi phí (không ghi trùng, không bỏ sót);
 *  · phân công / điều khoản lưu ra là CHỜ DUYỆT và bảng lương không đọc dòng chờ;
 *  · lương cứng của người chưa khai ngày vào làm là CHƯA BIẾT khi dựng lại số dư lịch sử (không nhân cho mọi
 *    tháng), nhưng lá chắn chốt lương của kỳ đang trả (cảnh báo nghĩa vụ, quyền cầm nguồn) GIỮ NGUYÊN.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { setSettingJson, getSettingJson } from "@/lib/settings";
import { PAYROLL_EMPLOYEES_KEY, type Employee } from "@/lib/constants/payroll";
import { APPROVAL_ITEM_KEYS, APPROVAL_ITEM_OWNER, buildApprovalList, personalShareWithoutCode, buildOpeningProposal, codGapCause, historicalSalary, issueOwner, reconCenterDefaultRange, type ApprovalInput, type OpeningMonthInput } from "@/lib/payroll/recon-center";
import { adaptPayrollRecon, collectWorkItems, payrollReconWorkItems } from "@/lib/queries/work-adapters";
import { departmentFor, SOURCES_WITHOUT_OWNER } from "@/lib/constants/work-ownership";
import { slaHoursFor, SOURCES_WITHOUT_SLA } from "@/lib/constants/work-sla";
import { MONEY_UNKNOWN } from "@/lib/constants/work";
import { getReconCenter } from "@/lib/queries/payroll-recon-center";
import { DEPARTMENT_CODES } from "@/lib/constants/departments";
import { getRecognizedPayrollCost, PAYROLL_RECOGNITION_KEY } from "@/lib/queries/payroll-cost";
import { getRecognizedCosts, returnCostByProduct } from "@/lib/queries/cost-engine";
import { getPayrollReport, monthReportPeriod } from "@/lib/queries/payroll";
import { getMonthReconciliation } from "@/lib/queries/payroll-reconciliation";
import { codSplit, cogsGapsByVariant } from "@/lib/queries/payroll-recon-center";
import { listCodeBook, loadCodeBook } from "@/lib/queries/payroll-code-ledger";

const TR = 1_000_000;
const thang = (monthKey: string, over: Partial<OpeningMonthInput> = {}): OpeningMonthInput => ({
  monthKey,
  revenue: 50 * TR,
  recognizedCost: 40 * TR,
  salaryGapEvidenced: 0,
  salaryUndated: 0,
  unknownCostLines: 0,
  unknownCostRevenue: 0,
  revenueWithoutMoney: 0,
  openValue: 0,
  beforeFirstExpense: false,
  ...over,
});

function testPure() {
  /* ── Đề xuất mở sổ: số đo, không giả định; thiếu căn cứ thì nói ra, không tự "đủ" ── */
  const du = buildOpeningProposal("2026-06", "2026-03", [thang("2026-03"), thang("2026-04", { revenue: 10 * TR }), thang("2026-05"), thang("2026-06", { revenue: 999 * TR })]);
  assert.deepEqual(du.months.map((m) => m.monthKey), ["2026-03", "2026-04", "2026-05"], "chỉ các tháng TRƯỚC mốc mở sổ");
  assert.equal(du.measuredCumulative, 10 * TR - 30 * TR + 10 * TR, "lũy kế = Σ (doanh thu − chi phí ghi nhận − lương có căn cứ chưa ghi)");
  assert.equal(du.measuredHighWater, 10 * TR, "đỉnh của đường lũy kế");
  assert.equal(du.complete, true);
  const luong = buildOpeningProposal("2026-06", "2026-05", [thang("2026-05", { salaryGapEvidenced: 8 * TR, salaryUndated: 5 * TR })]);
  assert.equal(luong.measuredCumulative, 2 * TR, "lương CÓ căn cứ trừ vào; lương của người chưa khai ngày vào làm KHÔNG trừ (chưa biết)");
  assert.equal(luong.complete, false, "nhưng tháng có lương chưa biết thì đề xuất CHƯA đủ căn cứ");
  assert.ok(luong.months[0].gaps.some((g) => g.includes("chưa khai ngày vào làm")));
  const chuaChi = buildOpeningProposal("2026-06", "2025-08", [thang("2025-08", { recognizedCost: 0, beforeFirstExpense: true }), thang("2025-09", { unknownCostLines: 3, unknownCostRevenue: 2 * TR })]);
  assert.equal(chuaChi.complete, false, "tháng trước khoản chi đầu tiên: chi phí vận hành CHƯA BIẾT, không phải 0");
  assert.deepEqual(chuaChi.incompleteMonths, ["2025-08", "2025-09"]);
  assert.ok(chuaChi.months[1].gaps[0].includes("3 dòng"), "giá vốn 0 là lợi nhuận ảo — phải nêu");
  const rong = buildOpeningProposal("2026-06", "2026-06", []);
  assert.equal(rong.complete, false, "không có tháng nào để đo thì không phải 'đủ căn cứ'");
  assert.equal(JSON.stringify(buildOpeningProposal("2026-06", "2026-03", [thang("2026-03")])), JSON.stringify(buildOpeningProposal("2026-06", "2026-03", [thang("2026-03")])), "hàm thuần, chạy hai lần ra một");

  /* ── Lương khi dựng lại lịch sử: phần chưa khai ngày là CHƯA BIẾT ở cả ba nguồn ── */
  const ls = (o: Partial<Parameters<typeof historicalSalary>[0]>) => historicalSalary({ payrollCovered: true, obligation: null, undated: 8 * TR, fixedSalary: 13 * TR, salaryExpenseDocs: 0, recognizedCost: 50 * TR, ...o });
  assert.deepEqual(ls({}), { recognizedCost: 42 * TR, salaryGapEvidenced: 0, salaryUndated: 8 * TR }, "bảng Lương cầm nguồn, không chứng từ ⇒ trừ ngược phần chưa khai ngày");
  assert.deepEqual(ls({ salaryExpenseDocs: 10 * TR }), { recognizedCost: 47 * TR, salaryGapEvidenced: 0, salaryUndated: 3 * TR }, "có 10tr chứng từ lương ⇒ chỉ trừ phần vượt chứng từ (13 − 10), tiền đã có chứng từ không rơi");
  assert.deepEqual(ls({ salaryExpenseDocs: 20 * TR }), { recognizedCost: 50 * TR, salaryGapEvidenced: 0, salaryUndated: 0 }, "chứng từ đủ phủ ⇒ không có gì chưa biết");
  assert.deepEqual(ls({ payrollCovered: false, obligation: 13 * TR }), { recognizedCost: 50 * TR, salaryGapEvidenced: 5 * TR, salaryUndated: 8 * TR }, "chưa có khoản lương ⇒ chỉ trừ phần có ngày vào làm");
  assert.deepEqual(ls({ payrollCovered: false, salaryExpenseDocs: 9 * TR }), { recognizedCost: 50 * TR, salaryGapEvidenced: 0, salaryUndated: 0 }, "bảng Chi phí có khoản lương thật ⇒ đó là chứng từ");

  /* ── Danh sách phê duyệt duy nhất ── */
  const goc: ApprovalInput = {
    opening: chuaChi,
    gatePolicyDeclared: false,
    undatedEmployees: [{ id: "e1", name: "Mai", monthlyFixed: 8 * TR }],
    pendingAssignments: 2,
    pendingTerms: 1,
    codesWithoutOwner: 4,
    monthsNeedingSignoff: ["2026-09"],
    cogsGaps: { variants: 5, lines: 26, revenue: 17.7 * TR },
    codReceivable: { orders: 100, revenue: 113 * TR, over30Orders: 7 },
    duplicateSourceWarnings: 1,
    personalShareWithoutCode: [{ id: "e9", name: "Nhật", percentPersonal: 25 }],
  };
  const ds = buildApprovalList(goc);
  assert.deepEqual(ds.map((x) => x.key), ["opening-balance", "undated-employees", "pending-code-rows", "codes-without-owner", "months-signoff", "cogs-gaps", "cod-receivable", "duplicate-source", "personal-share-no-code"]);
  for (const x of ds) {
    assert.ok((DEPARTMENT_CODES as readonly string[]).includes(x.owner), `${x.key}: chủ của việc là một PHÒNG có thật`);
    assert.ok(x.href.startsWith("/"), `${x.key}: có lối sửa`);
    assert.ok(x.action.length > 10 && x.cause.length > 10, `${x.key}: có nguyên nhân và việc cần làm`);
  }
  assert.ok(ds[0].cause.includes("CHƯA ĐỦ CĂN CỨ"), "đề xuất thiếu căn cứ phải nói ra, không trình như số đã duyệt");
  assert.ok(!buildApprovalList({ ...goc, gatePolicyDeclared: true }).some((x) => x.key === "opening-balance"), "quy chế đã có người khai ⇒ không đề xuất lại số dư");
  const sach = buildApprovalList({ ...goc, gatePolicyDeclared: true, undatedEmployees: [], pendingAssignments: 0, pendingTerms: 0, codesWithoutOwner: 0, monthsNeedingSignoff: [], cogsGaps: { variants: 0, lines: 0, revenue: 0 }, codReceivable: { orders: 0, revenue: 0, over30Orders: 0 }, duplicateSourceWarnings: 0, personalShareWithoutCode: [] });
  assert.equal(sach.length, 0, "dữ liệu đủ thì danh sách RỖNG — không bịa việc");

  /* ── % LN cá nhân mà không phụ trách mã — chỉ hỏi khi có người nhận phần còn lại (chủ shop 21/10/2026) ── */
  const nv = [
    { id: "q", name: "Quân", active: true, percentPersonal: 0 },
    { id: "h", name: "Hiếu", active: true, percentPersonal: 30 },
    { id: "n", name: "Nhật", active: true, percentPersonal: 25 },
    { id: "x", name: "Nghỉ", active: false, percentPersonal: 10 },
    { id: "r", name: "Nhận phần còn lại", active: true, percentPersonal: 5 },
  ];
  assert.deepEqual(personalShareWithoutCode(nv, new Set(["h"]), "r").map((e) => e.id), ["n"], "có % cá nhân · không mã · còn làm · không phải người nhận ⇒ hỏi chủ shop");
  assert.deepEqual(personalShareWithoutCode(nv, new Set(["h"]), null), [], "quy chế không có người nhận phần còn lại ⇒ không hỏi (y như trước)");
  const hoi = ds.find((x) => x.key === "personal-share-no-code")!;
  assert.deepEqual([hoi.kind, hoi.owner, hoi.href], ["DECIDE", "MANAGEMENT", "/payroll"], "việc QUYẾT của chủ shop, link hồ sơ nhân sự");

  /* ── Phép chiếu lên /work (chủ shop 21/10): mỗi mục một việc của ĐÚNG phòng, không tiền, không câu nguyên nhân ── */
  const ky = new Date("2026-10-01T00:00:00+07:00");
  const viec = payrollReconWorkItems(ds, ky, new Date("2026-10-21T00:00:00+07:00"));
  assert.deepEqual(viec.map((v) => [v.key, v.department]), ds.map((x) => [`PAYROLL_RECON:${x.key}`, APPROVAL_ITEM_OWNER[x.key]]), "một mục ⇒ một việc, giao PHÒNG của mục (một bảng APPROVAL_ITEM_OWNER)");
  for (const v of viec) {
    assert.equal(v.statusAuthority, "SOURCE", `${v.sourceKey}: phép chiếu — trạng thái thuộc miền lương (luật 19)`);
    assert.equal(v.assignee, null, `${v.sourceKey}: giao phòng, không giao người`);
    assert.deepEqual(v.money, MONEY_UNKNOWN, `${v.sourceKey}: không mang tiền — COD phải thu đã nằm trong việc COD quá hạn theo vận đơn`);
    assert.ok(v.sourceUrl.startsWith("/") && v.summary.length > 10, `${v.sourceKey}: có việc cần làm và link màn hình nhập`);
    assert.ok(!v.actions.includes("WORK_STATUS"), `${v.sourceKey}: không có nút «đánh dấu xong» — dữ liệu đủ thì việc tự rời hàng đợi`);
    assert.equal(v.createdAt.getTime(), ky.getTime(), "mốc là kỳ lương đang xét, không phải giờ đọc");
  }
  const hr = viec.find((v) => v.sourceKey === "undated-employees")!;
  assert.ok(!/\/tháng|8\.000\.000/.test(`${hr.title} ${hr.summary} ${hr.recommendedAction} ${hr.evidence.detail}`), "việc HR không in lương cứng từng người — hàng đợi phòng mở cho người không có quyền xem lương");
  assert.ok(!viec.some((v) => v.summary.includes("lũy kế đo được")), "không mang lũy kế lợi nhuận sang hàng đợi");
  assert.deepEqual(payrollReconWorkItems([], ky, ky), [], "danh sách rỗng ⇒ không việc nào");
  for (const k of APPROVAL_ITEM_KEYS) {
    const khac = DEPARTMENT_CODES.find((x) => x !== APPROVAL_ITEM_OWNER[k])!;
    assert.equal(departmentFor("PAYROLL_RECON", k, khac, null), APPROVAL_ITEM_OWNER[k], `${k}: luật sở hữu mặc định = phòng của mục (không rơi về phòng adapter đoán)`);
    assert.equal(slaHoursFor("PAYROLL_RECON", k, null), null, `${k}: CỐ Ý không đặt hạn — không bịa ngưỡng`);
  }
  assert.equal(departmentFor("PAYROLL_RECON", "cogs-gaps", "FINANCE", { "PAYROLL_RECON:cogs-gaps": "PRODUCTION" }), "PRODUCTION", "chủ shop chuyển phòng bằng ghi đè work.ownership, không deploy");
  assert.equal(slaHoursFor("PAYROLL_RECON", "cod-receivable", { "PAYROLL_RECON:cod-receivable": 48 }), 48, "và đặt hạn bằng work.sla");
  assert.ok(!SOURCES_WITHOUT_SLA.includes("PAYROLL_RECON") && !SOURCES_WITHOUT_OWNER.includes("PAYROLL_RECON"), "nguồn mới có đủ luật hạn và luật sở hữu");
  assert.deepEqual(reconCenterDefaultRange("2026-02"), { fromMonth: "2025-10", toMonth: "2026-02" }, "khoảng mặc định qua năm");

  /* ── Nguyên nhân phải thu COD · phòng của từng khoản ── */
  assert.equal(codGapCause(null, false), "NO_STATEMENT");
  assert.equal(codGapCause("PENDING", true), "STATEMENT_NO_CASH");
  assert.equal(codGapCause("DISPUTED", true), "DISPUTED");
  assert.equal(codGapCause("COLLECTED", false), "COLLECTED_NOT_PAID");
  assert.equal(issueOwner("cogs"), "WAREHOUSE");
  assert.equal(issueOwner("warn:PAYROLL_OBLIGATION_NOT_RECOGNIZED"), "HR");
  assert.equal(issueOwner("ads-code-nomk"), "MARKETING");
  assert.equal(issueOwner("khoa-la"), "FINANCE", "khoá lạ ⇒ người giữ sổ đối soát, không rơi mất");
}

function testSourceFences() {
  const act = readFileSync("lib/actions/payroll-code.ts", "utf8");
  const approve = act.slice(act.indexOf("export async function approveCodeRow"), act.indexOf("export async function endCodeRow"));
  assert.ok(approve.length > 100, "có đường DUYỆT riêng");
  assert.equal((act.match(/\.set\(\{ status: "APPROVED"/g) ?? []).length, 1, "chỉ MỘT lệnh ghi đưa dòng sang APPROVED");
  assert.ok(approve.includes('.set({ status: "APPROVED"'), "và lệnh ấy nằm trong approveCodeRow");
  assert.ok(!/\.values\(\{[^}]*status: "APPROVED"/.test(act), "không đường khai nào chèn thẳng một dòng ĐÃ DUYỆT");
  assert.equal((act.match(/status: "PENDING", createdBy: guard\.id, approvedBy: null, approvedAt: null/g) ?? []).length, 2, "khai phân công và khai điều khoản đều chỉ tạo dòng CHỜ DUYỆT");
  assert.ok(approve.includes('if (duyet.id && duyet.id === row.createdBy && !(duyet.id === guard.id && guard.role === "ADMIN"))'), "người khai không tự duyệt (trừ chủ shop)");
  assert.ok(/guardSecondApproval/.test(approve), "duyệt đi qua duyệt người thứ hai của nhóm PAYROLL_EDIT");
  assert.ok(approve.includes("if (!duyet.id) return"), "không duyệt một dòng mà không ghi được ai đã duyệt");
  const q = readFileSync("lib/queries/payroll-code-ledger.ts", "utf8");
  assert.ok((q.match(/eq\(a\.status, "APPROVED"\)/g) ?? []).length >= 1 && (q.match(/eq\(t\.status, "APPROVED"\)/g) ?? []).length >= 1, "bảng lương chỉ đọc dòng ĐÃ DUYỆT");
  const mig = readFileSync("drizzle/0250_payroll_code_pending.sql", "utf8");
  assert.ok(!/\b(INSERT|UPDATE|DELETE)\b/i.test(mig.replace(/^--.*$/gm, "")), "migration 0250 không đổi dòng nào");
  const center = readFileSync("lib/queries/payroll-recon-center.ts", "utf8");
  assert.ok(!/\.(insert|update|delete)\(/.test(center), "Trung tâm CHỈ ĐỌC");
  const work = readFileSync("lib/queries/work-adapters.ts", "utf8");
  const chieu = work.slice(work.indexOf("export function payrollReconWorkItems"), work.indexOf("export async function adaptPayrollRecon"));
  assert.ok(chieu.length > 100 && !/a\.cause/.test(chieu), "phép chiếu /work không đọc câu nguyên nhân (có lương cứng · lũy kế)");
  assert.ok(!/APPROVAL_ITEM_OWNER|"(HR|FINANCE|WAREHOUSE|MARKETING|MANAGEMENT)"/.test(chieu), "phép chiếu không khai lại phòng — đọc a.owner");
  const page = readFileSync("app/(dashboard)/payroll/reconciliation/center/page.tsx", "utf8");
  assert.ok(!/@\/lib\/actions/.test(page), "trang Trung tâm không có nút ghi số nào");
  const pr = readFileSync("lib/queries/payroll.ts", "utf8");
  assert.ok(/exp\.returnLegCost/.test(pr) && /returnCostByProduct/.test(pr), "tổng phí chiều hoàn của bảng lương lấy từ máy chi phí, phép chia cũng sống ở máy chi phí");
}

const d = (iso: string) => new Date(`${iso}T00:00:00+07:00`);
const nv = (id: string, over: Partial<Employee> = {}): Employee => ({ id, name: `NV ${id}`, shortName: id, department: "Quản lý", aliases: [], accountIds: [], fixed: 8 * TR, percentTotal: 0, percentPersonal: 0, percentRevenue: 0, active: true, note: "", ...over });

async function reset(db: Db) {
  await db.delete(schema.productMarketerAssignments).where(sql`${schema.productMarketerAssignments.id} like 'rc-%'`);
  await db.delete(schema.shipments).where(sql`${schema.shipments.id} like 'rc-%'`);
  await db.delete(schema.orderItems).where(sql`${schema.orderItems.id} like 'rc-%'`);
  await db.delete(schema.orders).where(sql`${schema.orders.id} like 'rc-%'`);
  await db.delete(schema.productVariants).where(sql`${schema.productVariants.id} like 'rc-%'`);
  await db.delete(schema.products).where(sql`${schema.products.id} like 'rc-%'`);
  clearMemo();
}

async function testFlow(db: Db) {
  const nvTruoc = await getSettingJson<unknown>(PAYROLL_EMPLOYEES_KEY, { list: [] });
  const ghiNhanTruoc = await getSettingJson<unknown>(PAYROLL_RECOGNITION_KEY, null);
  await reset(db);
  try {
    /*
      ── Lương cứng: lời khai CĂN CỨ tách riêng, LÁ CHẮN CHỐT LƯƠNG GIỮ NGUYÊN ──
      Kỳ đang chốt lương luôn là kỳ ĐÃ QUA, nên người chưa khai ngày vào làm vẫn phải được trừ ở máy chi phí
      và vẫn bật cảnh báo "lợi nhuận không trừ đồng lương nào" — hạ hai thứ đó là cho chốt kỳ trên 0 ₫ lương.
    */
    await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [nv("rc-e1")] });
    await setSettingJson(PAYROLL_RECOGNITION_KEY, { mode: "LEGACY_EXPENSES" });
    clearMemo();
    const qua = monthReportPeriod("2025-08");
    const khongNgay = await getRecognizedPayrollCost(qua);
    assert.equal(khongNgay.fixedSalaryDueUndated, 8 * TR, "lương của người chưa khai ngày vào làm được nêu riêng");
    assert.equal(khongNgay.fixedSalaryDueEvidenced, 0);
    assert.equal(khongNgay.fixedSalaryDue, 8 * TR, "nhưng nghĩa vụ lương của kỳ KHÔNG bị hạ");
    const engineQua = await getRecognizedCosts(qua);
    assert.equal(engineQua.warnings.find((w) => w.rule === "PAYROLL_OBLIGATION_NOT_RECOGNIZED")?.amount, 8 * TR, "cảnh báo nghĩa vụ lương vẫn đủ 8 triệu — chốt kỳ vẫn bị chặn khi lợi nhuận chưa trừ lương");
    await setSettingJson(PAYROLL_RECOGNITION_KEY, { mode: "PAYROLL" });
    clearMemo();
    const payrollMode = await getRecognizedPayrollCost(qua);
    assert.equal(payrollMode.coverage, "COMPLETE", "chế độ PAYROLL: bảng Lương vẫn cầm nguồn (không lùi về 0 ₫ vì một người chưa khai ngày)");
    assert.equal(payrollMode.fixedSalary, 8 * TR);
    await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [nv("rc-e1", { startedOn: "2025-01-01" })] });
    clearMemo();
    const coNgay = await getRecognizedPayrollCost(qua);
    assert.equal(coNgay.fixedSalaryDueEvidenced, 8 * TR, "khai ngày vào làm theo hợp đồng ⇒ có căn cứ");
    assert.equal(coNgay.fixedSalaryDueUndated, 0);
    await setSettingJson(PAYROLL_RECOGNITION_KEY, { mode: "LEGACY_EXPENSES" });
    await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [] });

    /* ── Phí chiều hoàn vào cơ sở lương (03/2031) ── */
    await db.insert(schema.products).values({ id: "rc-prod-a", name: "Mã đối soát A", customId: "RC-A" });
    await db.insert(schema.productVariants).values({ id: "rc-var-a", productId: "rc-prod-a", sku: "RC-A", detail: "mặc định" });
    await db.insert(schema.orders).values({ id: "rc-o1", insertedAt: d("2031-03-05"), stage: "DELIVERED", status: 3, totalPriceAfterDiscount: 300_000, partnerFee: 0, returnFee: 0, cod: 300_000 });
    await db.insert(schema.orderItems).values({ id: "rc-o1-i0", orderId: "rc-o1", variantId: "rc-var-a", productId: "rc-prod-a", productName: "Mã A", quantity: 1, lineTotal: 300_000, unitCost: 0, isBonus: false });
    // Đơn HOÀN của cùng mã: vận đơn chiều về đã phát ⇒ ORDER_OUTCOME kết luận hoàn (đúng luật), và phí chiều về gắn về mã A.
    await db.insert(schema.orders).values({ id: "rc-o2", insertedAt: d("2031-03-06"), stage: "RETURNED", status: 5, totalPriceAfterDiscount: 200_000, partnerFee: 0, returnFee: 15_000, cod: 200_000 });
    await db.insert(schema.orderItems).values({ id: "rc-o2-i0", orderId: "rc-o2", variantId: "rc-var-a", productId: "rc-prod-a", productName: "Mã A", quantity: 1, lineTotal: 200_000, unitCost: 0, isBonus: false });
    await db.insert(schema.shipments).values([
      { id: "rc-o1-s", orderId: "rc-o1", vtpOrderNumber: "RC0000000001", stage: "DELIVERED", shippingFee: 0, codAmount: 300_000, codCollected: 300_000, codStatus: "RECONCILED", deliveredAt: d("2031-03-08") },
      { id: "rc-o2-s", orderId: "rc-o2", vtpOrderNumber: "RC0000000002", stage: "RETURNED", shippingFee: 0, codAmount: 200_000, codCollected: 0, returnedAt: d("2031-03-18") },
      // Chiều về của đơn rc-o2 — nối được về mã A qua mã vận đơn gốc.
      { id: "rc-r1", orderId: null, orderReference: "RC0000000002", vtpOrderNumber: "RC0000000002P1", stage: "DELIVERED", shippingFee: 30_000, deliveredAt: d("2031-03-20") },
      // Chiều về KHÔNG tìm thấy vận đơn gốc ⇒ chi phí chung.
      { id: "rc-r2", orderId: null, orderReference: "RC-KHONG-CO", vtpOrderNumber: "RC-KHONG-CO-P1", stage: "DELIVERED", shippingFee: 12_000, deliveredAt: d("2031-03-21") },
    ]);
    clearMemo();
    const ky = monthReportPeriod("2031-03");
    const theoMa = await returnCostByProduct(ky);
    assert.equal(Math.round(theoMa.get("rc-prod-a") ?? 0), 45_000, "chiều về nối được (30K) + phí hoàn ghi trên đơn hoàn (15K) ⇒ gắn đúng mã");
    const engine = await getRecognizedCosts(ky);
    const tongMay = engine.components.RETURN_COST.amount - engine.logisticsAdjustment.returnFee;
    assert.equal(tongMay, 57_000, "máy chi phí ghi nhận hai vận đơn chiều về + phí hoàn trên đơn");
    const r = await getPayrollReport(ky, "profit1");
    const t = r.marketers.totals;
    assert.equal(t.returnLeg.amount, tongMay, "tổng phí chiều hoàn của cơ sở lương = máy chi phí (không bỏ sót)");
    assert.equal(t.returnLeg.toCodes, 45_000);
    assert.equal(t.returnLeg.shared, 12_000, "phần không nối được vào chi phí chung");
    assert.equal(t.returnLeg.toCodes + t.returnLeg.shared, tongMay, "không ghi trùng");
    const a = r.marketers.products.find((p) => p.productId === "rc-prod-a");
    // Hai vận đơn chiều đi chưa có cước Viettel Post (0) ⇒ cước ƯỚC TÍNH theo lịch cước (AGENTS.md mục 80), cùng cột.
    assert.equal(engine.shippingEstimate.orders, 2, "hai vận đơn chiều đi thiếu cước VTP ⇒ ước tính, đếm riêng");
    assert.equal(a?.shipping, 45_000 + engine.shippingEstimate.amount, "phần chiều hoàn gắn mã (45K) nằm trong cột vận chuyển của mã, cạnh cước chiều đi ước tính");
    const recon = await getMonthReconciliation("2031-03", { report: r });
    assert.equal(recon.lines.find((l) => l.key === "return-cost")?.status, "MATCHED", "bảng đối soát: cơ sở lương = máy chi phí");
    assert.equal(recon.classes.NOT_IN_BASIS, 0, "phí chiều hoàn không còn là 'chưa vào cơ sở'");
    assert.equal(recon.lines.find((l) => l.key === "shipping")?.basis, recon.lines.find((l) => l.key === "shipping")?.source, "cước chiều đi không bị phí chiều hoàn làm lệch");
    // Bỏ hai vận đơn chiều về ⇒ lợi nhuận công ty tăng ĐÚNG 42.000 ₫: không ghi trùng, không bỏ sót phần chi phí chung.
    await db.delete(schema.shipments).where(sql`${schema.shipments.id} in ('rc-r1', 'rc-r2')`);
    clearMemo();
    const khongHoan = await getPayrollReport(ky, "profit1");
    assert.equal(khongHoan.marketers.totals.profit - t.profit, 42_000, "phí chiều hoàn trừ khỏi lợi nhuận công ty đúng một lần");
    const aKhong = khongHoan.marketers.products.find((p) => p.productId === "rc-prod-a");
    assert.equal((a?.operatingAlloc ?? 0) - (aKhong?.operatingAlloc ?? 0), 12_000, "phần không nối được là chi phí CHUNG chia xuống mã theo doanh thu (mã A là mã duy nhất có doanh thu), không nằm treo ở cấp shop");
    assert.equal(t.sharedUnallocated, khongHoan.marketers.totals.sharedUnallocated, "và không đẩy thêm gì vào phần không chia được");
    await db.insert(schema.shipments).values([
      { id: "rc-r1", orderId: null, orderReference: "RC0000000002", vtpOrderNumber: "RC0000000002P1", stage: "DELIVERED", shippingFee: 30_000, deliveredAt: d("2031-03-20") },
      { id: "rc-r2", orderId: null, orderReference: "RC-KHONG-CO", vtpOrderNumber: "RC-KHONG-CO-P1", stage: "DELIVERED", shippingFee: 12_000, deliveredAt: d("2031-03-21") },
    ]);
    clearMemo();

    /* ── Truy giá vốn: mã A không phiếu nhập, không giá Pancake ⇒ nêu nguyên nhân, không tự điền ── */
    const gaps = await cogsGapsByVariant(ky.from as Date, ky.to as Date);
    const g = gaps.find((x) => x.productId === "rc-prod-a");
    assert.equal(g?.cause, "NO_RECEIPT");
    assert.deepEqual(g?.sampleOrderIds, ["rc-o1"], "kèm mã đơn để tra");
    assert.equal(a?.cogs, 0, "giá vốn vẫn là 0 trong cơ sở — Trung tâm chỉ đọc, không đặt giá");

    /* ── COD: doanh thu kế toán ≠ tiền thực nhận ── */
    const cod = await codSplit("2031-03");
    assert.equal(cod.accounting.revenue, 300_000);
    assert.equal(cod.withMoney.revenue, 300_000, "có COD thực thu ⇒ có chứng từ tiền");
    assert.equal(cod.receivable.orders, 0);
    assert.equal(cod.codHeldByCarrier, 300_000, "ĐVVC đã thu, chưa ghi đã trả về ngân hàng ⇒ chưa phải tiền thực nhận");
    assert.equal(cod.cashReceived, 0);

    /* ── /work: việc theo phòng ĐỌC ĐÚNG danh sách của Trung tâm, tự rời hàng đợi khi dữ liệu đủ ── */
    const luc = d("2031-03-25");
    clearMemo();
    assert.deepEqual(await adaptPayrollRecon(luc), [], "tổ chức chưa khai bảng lương ⇒ không việc nào (không ồn)");
    await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [nv("rc-e1")] });
    clearMemo();
    const khoang = reconCenterDefaultRange("2031-03");
    const goc = (await getReconCenter(khoang.fromMonth, khoang.toMonth)).approvals;
    const tren = await adaptPayrollRecon(luc);
    assert.deepEqual(tren.map((v) => v.sourceKey), goc.map((x) => x.key), "đúng các mục của Trung tâm đối soát, cùng khoảng tháng mặc định");
    assert.ok(tren.some((v) => v.sourceKey === "undated-employees" && v.department === "HR"), "nhân sự chưa khai ngày vào làm ⇒ việc của phòng Nhân sự");
    assert.ok(tren.some((v) => v.sourceKey === "cogs-gaps" && v.department === "WAREHOUSE" && v.sourceUrl === "/inventory/cost-center"), "dòng thiếu giá vốn ⇒ việc của Kho, link màn hình nhập giá");
    const hang = await collectWorkItems({ sources: ["PAYROLL_RECON"], now: luc });
    assert.deepEqual(hang.failed, [], "nguồn chạy trong hạn giờ");
    assert.deepEqual(hang.items.map((v) => v.key).sort(), tren.map((v) => v.key).sort(), "hàng đợi /work có đủ, không trùng");
    await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [nv("rc-e1", { startedOn: "2025-01-01" })] });
    clearMemo();
    assert.ok(!(await adaptPayrollRecon(luc)).some((v) => v.sourceKey === "undated-employees"), "khai ngày vào làm xong ⇒ việc tự rời hàng đợi, không ai bấm «xong»");
    await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [] });
    clearMemo();

    /* ── Phân công CHỜ DUYỆT: bảng lương không đọc, sổ vẫn hiện ── */
    await db.insert(schema.productMarketerAssignments).values({ id: "rc-asg-1", productId: "rc-prod-a", employeeId: "rc-e1", role: "OWNER", ownerRateBp: 1000, effectiveFrom: d("2031-03-01"), policyRef: "QC-RC", status: "PENDING" });
    const book = await loadCodeBook(ky.from, ky.to);
    assert.ok(!book.assignments.some((x) => x.id === "rc-asg-1"), "dòng CHỜ DUYỆT không vào bảng lương — không có tỷ lệ mặc định nào áp thay");
    assert.equal((await listCodeBook()).find((x) => x.id === "rc-asg-1")?.status, "PENDING", "nhưng sổ quản lý vẫn hiện để duyệt");
    await assert.rejects(
      db.insert(schema.productMarketerAssignments).values({ id: "rc-asg-2", productId: "rc-prod-a", employeeId: "rc-e1", role: "SUPPORT", weightMethod: "AD_SPEND", effectiveFrom: d("2031-03-01"), status: "APPROVED" }),
      "CSDL chặn dòng APPROVED không có mốc duyệt (0250)",
    );
    const macDinh = await db.execute(sql`select column_default from information_schema.columns where table_name = 'product_marketer_assignments' and column_name = 'status'`);
    assert.match(String(((macDinh as unknown as { rows?: { column_default: string }[] }).rows ?? [])[0]?.column_default ?? ""), /PENDING/, "mặc định của cột là CHỜ DUYỆT");
  } finally {
    await reset(db);
    await setSettingJson(PAYROLL_EMPLOYEES_KEY, nvTruoc);
    if (ghiNhanTruoc === null) await db.delete(schema.settings).where(sql`${schema.settings.key} = ${PAYROLL_RECOGNITION_KEY}`);
    else await setSettingJson(PAYROLL_RECOGNITION_KEY, ghiNhanTruoc);
    clearMemo();
  }
}

export async function testPayrollReconCenter(db: Db) {
  testPure();
  testSourceFences();
  await testFlow(db);
  console.log(
    "✓ Trung tâm đối soát lương: đề xuất mở sổ chỉ từ số đo (thiếu căn cứ ⇒ nói ra, không tự 'đủ') · MỘT danh sách phê duyệt, mỗi mục một PHÒNG + lối sửa · phí chiều hoàn vào cơ sở (gắn mã qua đơn gốc · phần còn lại vào chi phí chung · tổng = máy chi phí) · phân công CHỜ DUYỆT không vào lương · lương người chưa khai ngày vào làm tách riêng, lá chắn chốt lương giữ nguyên · truy giá vốn không tự điền · COD tách kế toán / phải thu / tiền thực nhận · mỗi mục thành việc /work của ĐÚNG phòng (phép chiếu, không tiền, không lương cứng, tự rời khi dữ liệu đủ)",
  );
}

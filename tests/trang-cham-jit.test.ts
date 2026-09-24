import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * ═══════════ VÒNG VÁ 24/09/2026 — CÁC TRANG CÒN CHẬM TẮT JIT, PHỄU CÓ ĐỆM ═══════════
 *
 * Nguyên nhân đã CHỨNG MINH ở chỗ khác (docs/perf/JIT-bat-tat-2026-09-23.md): Postgres biên dịch
 * JIT cho câu mang biểu thức kết quả đơn — cùng câu 8,4 s bật JIT, 43 ms tắt JIT. Các dòng dưới
 * đây là những câu CÙNG HỌ trên các trang còn chậm (/data-quality · /cod · /customers ·
 * /products · /reports/cashflow · /reports/funnel · /reports/returns · /landing) mà chưa đi qua
 * `chayKhongJit`.
 *
 * KHÁC bảng trong `testMetricResolverTatJit` (agent-chi-phi.test.ts): bảng đó chỉ nhận chỗ ĐÃ ĐO
 * bật/tắt. Bảng này là chỗ bọc THEO HÌNH DẠNG — số đo trước/sau là việc của lượt đo sau deploy,
 * lệnh nằm ở docs/perf/vong-va-2026-09-24.md. Đo xong chỗ nào thì chuyển dòng đó sang bảng kia.
 *
 * PGlite không có JIT (và `chayKhongJit` đi thẳng ở đó), nên bài chỉ canh được MÃ NGUỒN. Mỗi dòng
 * cắt ĐÚNG thân hàm của nó: một `chayKhongJit` ở hàm bên cạnh không được làm chốt này xanh.
 */
const BOC_THEO_HINH_DANG: { tep: string; ham: string; soLan: number }[] = [
  // /data-quality — trang chậm nhất đo được (53,98 s)
  { tep: "lib/queries/data-quality.ts", ham: "export async function dataQualitySummary(", soLan: 1 },
  { tep: "lib/queries/data-quality.ts", ham: "export async function dataQualityOrders(", soLan: 2 },
  { tep: "lib/queries/data-quality-issues.ts", ham: "export async function getDataQualityIssues(", soLan: 1 },
  // /cod — 18–30 s; cả sáu hàm của trang đều lọc/nhóm theo kết quả đơn trên mọi vận đơn
  { tep: "lib/queries/cod-settlement.ts", ham: "export async function codSettlementSummary(", soLan: 1 },
  { tep: "lib/queries/cod-settlement.ts", ham: "export async function listCodSettlement(", soLan: 2 },
  { tep: "lib/queries/cod-settlement.ts", ham: "export async function codSettlementCounts(", soLan: 1 },
  { tep: "lib/queries/cod-settlement.ts", ham: "export async function statementGapDays(", soLan: 1 },
  { tep: "lib/queries/cod-settlement.ts", ham: "export async function missingStatementPeriods(", soLan: 1 },
  // /customers — chạy song song với câu danh sách ĐÃ ĐO (listCustomers 7.463 → 100 ms)
  { tep: "lib/queries/customers.ts", ham: "export async function customerFacets(", soLan: 2 },
  { tep: "lib/queries/customers.ts", ham: "export async function customerSummary(", soLan: 1 },
  // /products — cùng ba bảng dẫn xuất sổ kho với câu danh sách đã tắt JIT
  { tep: "lib/queries/products.ts", ham: "export async function listProducts(", soLan: 2 },
  { tep: "lib/queries/products.ts", ham: "async function productFacetsUncached(", soLan: 1 },
  { tep: "lib/queries/products.ts", ham: "async function productSummaryUncached(", soLan: 1 },
  // /reports/cashflow — tab dự phóng và tab đối chiếu
  { tep: "lib/queries/cashflow.ts", ham: "async function buildCashflow(", soLan: 1 },
  { tep: "lib/queries/profit-cash-bridge.ts", ham: "async function vonLuuDong(", soLan: 1 },
  // /reports/funnel — các khối cùng trang
  { tep: "lib/queries/conversion-funnel.ts", ham: "export async function getConversionFunnel(", soLan: 1 },
  { tep: "lib/queries/conversion-funnel.ts", ham: "export async function getConversionByDimension(", soLan: 1 },
  // /reports/returns — hai câu còn lại cạnh `baseRows` đã đo
  { tep: "lib/queries/return-intelligence.ts", ham: "async function careRows(", soLan: 1 },
  { tep: "lib/queries/return-intelligence.ts", ham: "async function trendPoints(", soLan: 1 },
  // /crm — `ORDER_FACTS` trên TOÀN BỘ đơn
  { tep: "lib/queries/crm.ts", ham: "async function dsKhach(", soLan: 1 },
  { tep: "lib/queries/crm.ts", ham: "async function dsTheoDonDaDat(", soLan: 1 },
  { tep: "lib/queries/crm.ts", ham: "async function dsKhoangCach(", soLan: 1 },
  { tep: "lib/queries/crm.ts", ham: "async function cohortsUncached(", soLan: 1 },
  { tep: "lib/queries/crm.ts", ham: "async function finishRetention(", soLan: 1 },
  // /landing
  { tep: "lib/queries/landing.ts", ham: "export async function listLandingOrders(", soLan: 1 },
  { tep: "lib/queries/landing.ts", ham: "export async function landingSummary(", soLan: 1 },
  // /reports/profit (tiền thật)
  { tep: "lib/queries/profit-cash.ts", ham: "export async function getCashProfitReport(", soLan: 3 },
  // /ads + bảng lương — perf-probe 24/09/2026: 5.388–7.705 ms trên đường thật, 31–36 ms khi tắt JIT
  { tep: "lib/queries/payroll.ts", ham: "export async function salesByProductPage(", soLan: 1 },
  // /reports?tab=nominal, /ads/daily — perf-probe 24/09/2026: 4.908 ms, cùng phép gộp vsales đã đo 8.578 → 26 ms
  { tep: "lib/queries/profit-nominal.ts", ham: "async function stockByProduct(", soLan: 1 },
];

const goc = path.resolve(__dirname, "..");
const docTep = (tep: string) => readFileSync(path.join(goc, tep), "utf8");

/** Thân MỘT hàm: từ chữ ký tới dấu `}` đóng ở cột 0. Không cắt được ⇒ đỏ, không quét cả tệp. */
function thanHam(tep: string, ham: string): string {
  const ma = docTep(tep);
  const dau = ma.indexOf(ham);
  assert.ok(dau >= 0, `${tep}: phải còn hàm ${ham}`);
  const cuoi = ma.indexOf("\n}\n", dau);
  assert.ok(cuoi > dau, `${tep}: không cắt được thân ${ham}`);
  const than = ma.slice(dau, cuoi);
  assert.ok(than.length < 30000, `${tep}: thân ${ham} dài bất thường — phép canh đang quét nhầm cả tệp`);
  return than;
}

export function testTrangChamTatJit() {
  for (const d of BOC_THEO_HINH_DANG) {
    const than = thanHam(d.tep, d.ham);
    const n = than.split("chayKhongJit(db,").length - 1;
    assert.ok(n >= d.soLan, `${d.tep} · ${d.ham}: cần ${d.soLan} câu chạy trong chayKhongJit, thấy ${n} — câu mang biểu thức kết quả đơn trên tập lớn`);
  }

  /*
    `dataQualitySummary` còn đổi HÌNH DẠNG: kết quả đơn SỐNG tính một lần mỗi đơn trong bảng dẫn
    xuất có rào `OUTCOME_FENCE`, thay vì nội tuyến vào ~20 cột gộp. Mất rào là Postgres kéo bảng lên
    và nhân lại số lần tính — bài dữ liệu vẫn xanh, chỉ có thời gian quay về như cũ.
  */
  const dq = thanHam("lib/queries/data-quality.ts", "export async function dataQualitySummary(");
  assert.ok(dq.includes(".offset(OUTCOME_FENCE)"), "dataQualitySummary: bảng dẫn xuất kết quả đơn phải có rào OUTCOME_FENCE");
  /*
    Giao dịch giữ MỘT kết nối; một lời gọi `db.` (không phải `tx.`) bên trong nó xin thêm kết nối
    thứ hai. Bể chỉ có 5 — năm giao dịch như thế cùng lúc là tắc hẳn (db/index.ts: "giao dịch ôm
    nhầm hàm").
  */
  const giaoDich = dq.slice(dq.indexOf("chayKhongJit(db, async (tx)"), dq.indexOf("return { row, unlinked"));
  assert.ok(giaoDich.length > 0, "dataQualitySummary: phải cắt được thân giao dịch");
  assert.ok(!/\bawait\s+db\s*\./.test(giaoDich), "dataQualitySummary: bên trong chayKhongJit chỉ được dùng `tx`, không mượn thêm kết nối bằng `db`");

  /*
    /reports/funnel: bốn phép tổng hợp phải đi qua `memo()` với khoá chứa MỌI tham số đổi kết quả
    (AGENTS.md mục 2). Thiếu `field` trong khoá của bảng nhân sự là hai vai khác nhau đọc chung một
    đệm — con số của người chốt đơn hiện dưới tên người chăm sóc.
  */
  const DEM: { tep: string; ham: string; khoa: string[] }[] = [
    { tep: "lib/queries/sales-funnel.ts", ham: "export async function getSalesFunnel(", khoa: ["periodKey(period)"] },
    { tep: "lib/queries/sales-funnel.ts", ham: "export async function getAttributionCoverage(", khoa: ["periodKey(period)"] },
    { tep: "lib/queries/sales-funnel.ts", ham: "export async function getFunnelBySource(", khoa: ["periodKey(period)"] },
    { tep: "lib/queries/staff-performance.ts", ham: "export async function getStaffPerformance(", khoa: ["${field}", "periodKey(period)"] },
  ];
  for (const d of DEM) {
    const than = thanHam(d.tep, d.ham);
    const m = /return memo\(`([^`]*)`,\s*(\d[\d_]*)/.exec(than);
    assert.ok(m, `${d.tep} · ${d.ham}: phải trả qua memo() — trang phễu từng chạy lại 4 phép tổng hợp mỗi lần mở (34,4 s)`);
    for (const k of d.khoa) assert.ok(m[1].includes(k), `${d.tep} · ${d.ham}: khoá đệm thiếu ${k}`);
    const ttl = Number(m[2].replace(/_/g, ""));
    assert.ok(ttl >= 60_000 && ttl <= 120_000, `${d.tep} · ${d.ham}: đệm báo cáo 60–120 giây (AGENTS.md mục 2), thấy ${ttl}`);
  }

  console.log(
    `✓ Vòng vá trang chậm: ${BOC_THEO_HINH_DANG.length} hàm chạy câu kết quả đơn trong chayKhongJit (bọc theo hình dạng, chờ đo sau deploy) · dataQualitySummary tính kết quả một lần mỗi đơn sau rào OUTCOME_FENCE · 4 phép tổng hợp của /reports/funnel có đệm, khoá đủ tham số`,
  );
}

if (process.argv[1] && /trang-cham-jit\.test\.ts$/.test(process.argv[1])) {
  try {
    testTrangChamTatJit();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

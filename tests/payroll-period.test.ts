import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { PAYROLL_BASIS_ELIGIBILITY, PAYROLL_CALC_VERSION, PAYROLL_EMPLOYEES_KEY, payrollPeriodKey } from "@/lib/constants/payroll";
import { getPayrollReport } from "@/lib/queries/payroll";
import { buildPayrollSnapshot, getPayrollPeriodState, payrollDrift } from "@/lib/queries/payroll-period";
import type { Period } from "@/lib/search-params";
import { setSettingJson } from "@/lib/settings";

/**
 * ═══════════ KỲ LƯƠNG ĐÃ CHỐT LÀ BẤT BIẾN ═══════════
 *
 * Trước bản này bảng lương KHÔNG có danh tính kỳ: mở là tính lại từ đầu. Nên đổi một tỷ lệ thưởng
 * hôm nay làm đổi bảng lương THÁNG TRƯỚC, sau khi tiền đã trả — và không ai thấy, vì con số vẫn ra
 * và vẫn trông hợp lý.
 *
 * Bộ này khoá bốn điều, mỗi điều chặn một cách hỏng khác nhau:
 *   1. ảnh chụp giữ được TỶ LỆ TẠI LÚC CHỐT, không phải tỷ lệ hôm nay;
 *   2. đổi tỷ lệ sau khi chốt KHÔNG làm đổi một con số nào của kỳ đã chốt;
 *   3. nhưng phần chênh ấy PHẢI hiện ra như một đề xuất điều chỉnh — không được giấu;
 *   4. và chốt mà thiếu ảnh chụp bị CSDL chặn.
 *
 * Dữ liệu đặt ở tháng 06/2027 để không chạm fixture của bộ khác.
 */

/**
 * Drizzle bọc lỗi CSDL lại ("Failed query: …") nên tên ràng buộc nằm ở `cause`, không ở `message`.
 * Đọc thẳng `message` sẽ làm bài kiểm XANH GIẢ: insert bị chặn thật, mà khẳng định thì trượt.
 */
function loiCo(e: unknown, chuoi: string): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur; i += 1) {
    const o = cur as { message?: string; cause?: unknown };
    if (String(o?.message ?? "").includes(chuoi)) return true;
    cur = o?.cause;
  }
  return String(e).includes(chuoi);
}

const d = (iso: string) => new Date(`${iso}T00:00:00+07:00`);
const dEnd = (iso: string) => new Date(`${iso}T23:59:59+07:00`);
const KY: Period = { key: "custom", from: d("2027-06-01"), to: dEnd("2027-06-30"), label: "Tháng 6/2027", fromKey: "2027-06-01", toKey: "2027-06-30" };

const NHAN_SU = (fixed: number, percentTotal: number) => [
  { id: "pp-emp-1", name: "Trần Thị Bích", shortName: "Bích", department: "Marketing", aliases: [], accountIds: [], userEmail: "bich@shop.vn", fixed, percentTotal, percentPersonal: 0, percentRevenue: 0, active: true, note: "" },
];

export async function testPayrollPeriod(db: Db) {
  await db.delete(schema.payrollPeriods).where(sql`${schema.payrollPeriods.periodKey} like '2027-06-%'`);
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: NHAN_SU(6_000_000, 10) });
  clearMemo();

  /* ── 1 · KHOÁ KỲ ĐỌC ĐƯỢC BẰNG MẮT, VÀ KỲ KHÔNG CÓ MỐC THÌ KHÔNG CÓ KHOÁ ── */
  assert.equal(payrollPeriodKey(KY.from, KY.to), "2027-06-01..2027-06-30", "khoá kỳ dùng chính hai mốc ngày, không dùng nhãn 'Tháng này'");
  assert.equal(payrollPeriodKey(null, null), null, "kỳ không có mốc đầu/cuối thì KHÔNG có khoá — và đó là câu trả lời đúng, không phải một khoá giả");

  /* ── 2 · CHƯA CHỐT ⇒ KHÔNG CÓ DÒNG NÀO, và màn hình tính sống ── */
  const truocKhiChot = await getPayrollPeriodState(KY, "profit1");
  assert.equal(truocKhiChot.status, "NONE", "chưa ai bấm thì không có kỳ nào — một lượt nâng cấp không được biến kỳ nào thành 'đã chốt'");
  assert.equal(truocKhiChot.snapshot, null);
  assert.equal(truocKhiChot.basisEligible, true, "LN1 đủ điều kiện chốt lương");

  /* ── 3 · CHỤP LẠI: ảnh phải mang TỶ LỆ TẠI LÚC CHỐT ── */
  const banTinh = await getPayrollReport(KY, "profit1");
  const dongTruoc = banTinh.lines.find((l) => l.employee.id === "pp-emp-1");
  assert.ok(dongTruoc, "ca thử phải có dòng lương");
  assert.equal(dongTruoc?.fixed, 6_000_000, "trọn tháng 6 (30 ngày) ⇒ trọn lương tháng");
  const anh = buildPayrollSnapshot(banTinh, KY, "2027-06-01..2027-06-30");
  assert.equal(anh.calcVersion, PAYROLL_CALC_VERSION, "ảnh mang phiên bản phép tính lúc chụp");
  assert.equal(anh.lines[0]?.percentTotal, 10, "ảnh giữ TỶ LỆ TẠI LÚC CHỐT, không phải một con trỏ tới sổ nhân sự");
  assert.equal(anh.lines[0]?.fixed, 6_000_000);
  assert.equal(anh.totalSalary, banTinh.totalSalary, "tổng lương của ảnh = tổng lương lúc chụp");
  assert.ok(anh.attributionCoverage, "ảnh mang cả ĐỘ PHỦ nguồn quy kết — sáu tháng sau vẫn trả lời được 'số này dựa trên căn cứ nào'");
  assert.ok(Array.isArray(anh.costWarnings), "và mang nguyên văn cảnh báo của máy chi phí lúc ấy");

  await db.insert(schema.payrollPeriods).values({
    periodKey: "2027-06-01..2027-06-30",
    periodStart: KY.from!,
    periodEnd: KY.to!,
    basis: "profit1",
    status: "FINAL",
    snapshot: anh,
    calcVersion: PAYROLL_CALC_VERSION,
    note: "đã đối chiếu bảng kê COD tháng 6",
    finalizedAt: new Date(),
  });

  /* ── 4 · SỬA HỒ SƠ NHÂN SỰ SAU KHI CHỐT ⇒ KỲ ĐÃ CHỐT KHÔNG ĐỔI MỘT CON SỐ NÀO ──
     Đổi CẢ lương cứng (6tr → 9tr) lẫn tỷ lệ thưởng (10% → 50%): hai đường khác nhau vào cùng một
     con số lương, và cả hai đều phải bị chặn ở cửa kỳ đã chốt. */
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: NHAN_SU(9_000_000, 50) });
  clearMemo();
  const sauKhiDoi = await getPayrollPeriodState(KY, "profit1");
  assert.equal(sauKhiDoi.status, "FINAL", "kỳ vẫn ở trạng thái đã chốt");
  assert.equal(sauKhiDoi.snapshot?.lines[0]?.percentTotal, 10, "SỬA HỒ SƠ HÔM NAY KHÔNG ĐƯỢC VIẾT LẠI KỲ ĐÃ TRẢ TIỀN — ảnh vẫn giữ tỷ lệ 10%");
  assert.equal(sauKhiDoi.snapshot?.lines[0]?.fixed, 6_000_000, "và vẫn giữ lương cứng 6tr của lúc chốt, không phải 9tr của hôm nay");
  assert.equal(sauKhiDoi.snapshot?.totalSalary, anh.totalSalary, "và tổng lương của kỳ đứng yên");
  assert.equal(sauKhiDoi.note, "đã đối chiếu bảng kê COD tháng 6", "ghi chú lúc chốt đọc lại được");

  /* ── 5 · NHƯNG PHẦN CHÊNH PHẢI HIỆN RA — giấu đi cũng sai như ghi đè ── */
  const banTinhMoi = await getPayrollReport(KY, "profit1");
  const chenh = payrollDrift(sauKhiDoi.snapshot!, banTinhMoi);
  assert.ok(chenh.length > 0, "đổi tỷ lệ mà bảng chênh lệch rỗng nghĩa là chủ shop không bao giờ biết có gì đã đổi");
  assert.ok(
    chenh.some((c) => c.field === `line:pp-emp-1` && c.snapshot !== c.live),
    "dòng của người bị sửa hồ sơ phải nằm trong đề xuất điều chỉnh",
  );
  const tongLuong = chenh.find((c) => c.field === "totalSalary");
  assert.ok(tongLuong && tongLuong.diff !== null && tongLuong.diff !== 0, "và tổng lương phải nêu đúng số tiền chênh, không phải một dấu gạch");

  /* ── 6 · KHÔNG ĐỔI GÌ ⇒ KHÔNG CÓ ĐỀ XUẤT NÀO (bảng chênh lệch không được kêu vì nhiễu) ── */
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: NHAN_SU(6_000_000, 10) });
  clearMemo();
  const banTinhCu = await getPayrollReport(KY, "profit1");
  assert.deepEqual(payrollDrift(sauKhiDoi.snapshot!, banTinhCu), [], "dữ liệu không đổi thì không có chênh lệch nào — nếu không, bảng ấy kêu mỗi lần mở và không ai đọc nữa");

  /* ── 7 · CHỐT MÀ THIẾU ẢNH CHỤP BỊ CHẶN Ở CSDL ── */
  await assert.rejects(
    () =>
      db.insert(schema.payrollPeriods).values({
        periodKey: "2027-06-01..2027-06-15",
        periodStart: d("2027-06-01"),
        periodEnd: dEnd("2027-06-15"),
        basis: "profit1",
        status: "FINAL",
        finalizedAt: new Date(),
      }),
    (e: unknown) => loiCo(e, "payroll_periods_final_check"),
    "7. 'chốt' mà không có ảnh chụp thì lần mở sau vẫn tính lại — CSDL phải chặn",
  );

  /* ── 8 · BA CƠ SỞ KHÔNG ĐỦ ĐIỀU KIỆN KHÔNG ĐƯỢC CHỐT (luật ở MỘT chỗ, không chép vào CSDL) ── */
  for (const b of ["profit2", "cash", "nominal"] as const) {
    assert.equal(PAYROLL_BASIS_ELIGIBILITY[b].eligible, false, `8. ${b} không được dùng để chốt lương`);
    const st = await getPayrollPeriodState(KY, b);
    assert.equal(st.basisEligible, false, `8. trạng thái kỳ phải nói rõ ${b} không đủ điều kiện, để màn hình không hiện nút chốt`);
  }

  await db.delete(schema.payrollPeriods).where(sql`${schema.payrollPeriods.periodKey} like '2027-06-%'`);
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [] });
  clearMemo();

  console.log(
    "✓ Kỳ lương: khoá kỳ đọc được bằng mắt · ảnh chụp giữ TỶ LỆ LÚC CHỐT · đổi tỷ lệ sau đó KHÔNG viết lại kỳ đã trả tiền · phần chênh hiện ra như ĐỀ XUẤT điều chỉnh (và im lặng khi không có gì đổi) · chốt thiếu ảnh chụp bị CSDL chặn · ba cơ sở không đủ điều kiện không hiện nút chốt",
  );
}

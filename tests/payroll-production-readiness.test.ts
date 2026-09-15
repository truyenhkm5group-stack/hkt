/**
 * ═══════════ CỔNG SẴN SÀNG PRODUCTION CỦA MODULE LƯƠNG ═══════════
 *
 * Bộ này KHÁC hai bộ kia về mục đích, nên nó đứng riêng:
 *
 *  · `payroll-engine.test.ts`        — 30 tình huống của PHÉP TÍNH (máy làm đúng luật chưa).
 *  · `payroll-policy-engine.test.ts` — phần NỐI vào bảng lương thật (chính sách có chạm tới số không).
 *  · tệp này                         — những cách module này làm SAI TIỀN TRÊN PRODUCTION.
 *
 * Mỗi khối dưới đây khoá lại một lỗi ĐÃ CÓ THẬT trong kho mã, tìm ra ở lượt soát trước khi phát
 * hành. Không khối nào là một tình huống tưởng tượng — đó là điều kiện để chúng còn ở đây sau này
 * thay vì bị ai đó dọn đi vì "bài này chẳng bao giờ đỏ".
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { calculatePayrollItem } from "@/lib/payroll/engine";
import { resolveSegments, isWorkingSegment, type EmploymentRow, type PayrollSegment, type PolicyAssignmentRow, type PolicyVersionRow } from "@/lib/payroll/policy-resolve";
import { employmentOverlaps, assignmentOverlaps } from "@/lib/payroll/policy-validation";
import { carryoverMonth } from "@/lib/payroll/profit-carryover";
import { isFrozen, normalizePayrollStatus, PAYROLL_ACTION_SPEC, PAYROLL_RUN_STATUSES } from "@/lib/constants/payroll-lifecycle";
import { applyRounding, type PolicyComponent } from "@/lib/constants/payroll-components";
import { adjustmentSchema, VND_COLUMN_MAX } from "@/lib/validation/payroll-policy";
import { formatVND } from "@/lib/format";
import { RECON_STATUSES, activeSources, classifyEmployee, gateVerdict, hasActivity, tallyStatuses } from "@/lib/payroll/reconcile-gate";

const d = (iso: string) => new Date(`${iso}T00:00:00+07:00`);
const dEnd = (iso: string) => new Date(`${iso}T23:59:59.999+07:00`);

const NHAN_SU: EmploymentRow = {
  id: "em-1",
  employeeId: "e1",
  departmentId: null,
  departmentName: "",
  positionId: null,
  positionName: "",
  managerUserId: null,
  employmentType: "FULL_TIME",
  workMode: "ONSITE",
  status: "ACTIVE",
  standardWorkDays: null,
  effectiveFrom: d("2020-01-01"),
  effectiveTo: null,
};

function doan(from: string, to: string, versionId: string, version: number, days: number): PayrollSegment {
  return {
    from: d(from),
    to: dEnd(to),
    days,
    employment: NHAN_SU,
    hasEmploymentRecord: true,
    policyId: "p1",
    policyCode: "P1",
    policyName: "Chính sách thử",
    policyVersionId: versionId,
    policyVersion: version,
  };
}

function thanhPhan(over: Partial<PolicyComponent> & Pick<PolicyComponent, "code" | "kind" | "calc">): PolicyComponent {
  return {
    label: over.code,
    prorate: "NONE",
    rounding: "ROUND",
    minAmount: null,
    maxAmount: null,
    carryForward: false,
    sortOrder: 1,
    note: "",
    ...over,
  } as PolicyComponent;
}

export function testPayrollProductionReadiness() {
  /*
    ═══════════════════════════════════════════════════════════════════════════════════════
    1 · BÙ LỖ LŨY KẾ KHÔNG ĐƯỢC ÁP LẠI TỪ ĐẦU Ở TỪNG ĐOẠN
    ═══════════════════════════════════════════════════════════════════════════════════════

    LỖI THẬT ĐÃ SỬA. Bản trước đưa CÙNG một số dư đầu kỳ vào từng đoạn, nên một kỳ bị cắt làm hai
    (đổi phiên bản chính sách giữa tháng, đổi phòng, vào làm giữa kỳ) bù lỗ HAI LẦN.

    Cách hỏng kín ở chỗ nó sai về CẢ HAI phía và cả hai đều lặng lẽ:
      · người nhận HỤT đúng phần hoa hồng đáng lẽ được trả, và
      · số dư chuyển sang kỳ sau vẫn còn âm, nên tháng sau bù tiếp một lần nữa.

    Phép kiểm là một BẤT BIẾN, không phải một con số chép tay: cùng tổng lợi nhuận và cùng số dư
    đầu kỳ thì kỳ bị cắt phải ra ĐÚNG BẰNG kỳ không bị cắt. Viết kiểu này thì đổi tỷ lệ hay đổi
    cách làm tròn về sau cũng không làm bài đỏ oan.
  */
  {
    const hh = thanhPhan({
      code: "HH",
      kind: "COMMISSION",
      calc: { type: "RATE_OF_BASIS", basisKey: "PROFIT_PERSONAL", ratePercent: 10 },
      carryForward: true,
    });
    const chung = { employeeId: "e1", employeeName: "A", adjustments: [], carryOpening: { HH: -10_000_000 } };

    const motDoan = calculatePayrollItem({
      ...chung,
      segments: [{ segment: doan("2026-09-01", "2026-09-30", "v1", 1, 30), components: [hh], basis: { PROFIT_PERSONAL: 16_000_000 } }],
    });
    const haiDoan = calculatePayrollItem({
      ...chung,
      segments: [
        { segment: doan("2026-09-01", "2026-09-15", "v1", 1, 15), components: [hh], basis: { PROFIT_PERSONAL: 8_000_000 } },
        { segment: doan("2026-09-16", "2026-09-30", "v2", 2, 15), components: [hh], basis: { PROFIT_PERSONAL: 8_000_000 } },
      ],
    });

    assert.equal(motDoan.components[0].amount, 600_000, "1. một đoạn: (16tr − 10tr) × 10% = 600.000");
    assert.equal(
      haiDoan.components[0].amount,
      motDoan.components[0].amount,
      "1. CẮT KỲ LÀM HAI KHÔNG ĐƯỢC LÀM ĐỔI SỐ TIỀN — bù lỗ là một nghĩa vụ của cả kỳ, không phải một nghĩa vụ cho mỗi đoạn",
    );
    assert.equal(haiDoan.components[0].carry!.openingBalance, -10_000_000, "1. số dư ĐẦU phải là số dư đầu KỲ, không phải số dư giữa kỳ của đoạn cuối");
    assert.equal(haiDoan.components[0].carry!.lossApplied, 10_000_000, "1. tổng phần lỗ được bù cộng qua các đoạn");
    assert.equal(haiDoan.components[0].carry!.closingBalance, 0, "1. hết lỗ thì chuyển tiếp bằng 0 — còn âm là tháng sau bù thêm một lần nữa");
    assert.equal(
      haiDoan.components[0].carry!.commissionBase,
      motDoan.components[0].carry!.commissionBase,
      "1. cơ sở tính hoa hồng của kỳ bị cắt phải bằng cơ sở của kỳ không bị cắt",
    );

    // Ba đoạn cũng vậy — bất biến không phụ thuộc vào cắt mấy nhát.
    const baDoan = calculatePayrollItem({
      ...chung,
      segments: [
        { segment: doan("2026-09-01", "2026-09-10", "v1", 1, 10), components: [hh], basis: { PROFIT_PERSONAL: 4_000_000 } },
        { segment: doan("2026-09-11", "2026-09-20", "v2", 2, 10), components: [hh], basis: { PROFIT_PERSONAL: 4_000_000 } },
        { segment: doan("2026-09-21", "2026-09-30", "v3", 3, 10), components: [hh], basis: { PROFIT_PERSONAL: 8_000_000 } },
      ],
    });
    assert.equal(baDoan.components[0].amount, 600_000, "1. ba đoạn cũng ra đúng con số ấy");

    // Lỗ CHƯA HẾT: phần còn lại phải chuyển tiếp đúng một lần, không nhân lên theo số đoạn.
    const conLo = calculatePayrollItem({
      ...chung,
      segments: [
        { segment: doan("2026-09-01", "2026-09-15", "v1", 1, 15), components: [hh], basis: { PROFIT_PERSONAL: 2_000_000 } },
        { segment: doan("2026-09-16", "2026-09-30", "v2", 2, 15), components: [hh], basis: { PROFIT_PERSONAL: 2_000_000 } },
      ],
    });
    assert.equal(conLo.components[0].amount, 0, "1. còn lỗ ⇒ chưa có hoa hồng, nhưng KHÔNG âm — lỗ không biến thành khoản người lao động nợ shop");
    assert.equal(conLo.components[0].carry!.closingBalance, -6_000_000, "1. −10tr + 4tr = −6tr chuyển tiếp — MỘT lần, không phải −8tr vì bù hai lượt");
  }

  /*
    ═══════════════════════════════════════════════════════════════════════════════════════
    2 · KỲ ĐÃ ĐÓNG BĂNG ĐỌC THEO `isFrozen`, KHÔNG SO CHUỖI VỚI 'FINAL'
    ═══════════════════════════════════════════════════════════════════════════════════════

    LỖI THẬT ĐÃ SỬA. Cổng chặn nhập liệu hỏi đúng chữ `status = 'FINAL'`. Nhưng vòng đời sáu trạng
    thái GHI `LOCKED` khi khoá và `PAID` khi đã trả — `FINAL` chỉ còn là giá trị CŨ trên production.
    Nên một kỳ vừa khoá xong vẫn nhận thêm số liệu chấm công và khoản điều chỉnh mới: ảnh chụp đã
    đóng băng, tiền đã trả theo nó, còn dữ liệu nguồn thì tiếp tục đổi bên dưới.

    Ở tầng hàm thuần, bài khoá đúng mệnh đề mà cổng chặn phải dùng.
  */
  {
    assert.equal(isFrozen(normalizePayrollStatus("FINAL")), true, "2. giá trị CŨ trên production vẫn phải đọc là ĐÃ ĐÓNG BĂNG");
    assert.equal(isFrozen(normalizePayrollStatus("LOCKED")), true, "2. khoá kỳ ⇒ đóng băng");
    assert.equal(isFrozen(normalizePayrollStatus("PAID")), true, "2. đã trả ⇒ đóng băng");
    for (const s of ["DRAFT", "CALCULATED", "UNDER_REVIEW", "APPROVED"] as const) {
      assert.equal(isFrozen(s), false, `2. ${s} còn sửa được — đó chính là lý do bốn trạng thái ấy tồn tại`);
    }
    assert.equal(isFrozen(normalizePayrollStatus("XYZ")), false, "2. trạng thái lạ rơi về DRAFT, phía HẸP hơn không phải phía đóng băng");
    assert.equal(
      PAYROLL_RUN_STATUSES.filter((s) => isFrozen(s)).length,
      2,
      "2. đúng HAI trạng thái đóng băng — thêm trạng thái mới mà quên khai vào `isFrozen` thì bài này đỏ",
    );
  }

  /*
    ═══════════════════════════════════════════════════════════════════════════════════════
    3 · MỐC HIỆU LỰC THEO GIỜ VIỆT NAM: KHÔNG CHỒNG, KHÔNG HỞ, KHÔNG LỆCH MỘT NGÀY
    ═══════════════════════════════════════════════════════════════════════════════════════

    ERP chạy ở Việt Nam (UTC+7) nhưng CSDL lưu `timestamptz` và Node chạy giờ UTC. Một mốc "đến hết
    31/08" lưu thành `2026-08-31T23:59:59+07:00` = `2026-08-31T16:59:59Z`. Quy đổi sai một nhịp là
    chính sách cũ thừa hoặc thiếu MỘT NGÀY — và một ngày lương cứng của một người là tiền thật.

    Bài dựng đúng tình huống chuyển giao: A đến hết 31/08, B từ 01/09.
  */
  {
    const gan: PolicyAssignmentRow[] = [
      { id: "a1", employeeId: "e1", policyId: "pa", policyCode: "A", policyName: "A", effectiveFrom: d("2026-01-01"), effectiveTo: dEnd("2026-08-31") },
      { id: "a2", employeeId: "e1", policyId: "pb", policyCode: "B", policyName: "B", effectiveFrom: d("2026-09-01"), effectiveTo: null },
    ];
    const ban: PolicyVersionRow[] = [
      { id: "va", policyId: "pa", version: 1, effectiveFrom: d("2026-01-01"), effectiveTo: null, status: "ACTIVE" },
      { id: "vb", policyId: "pb", version: 1, effectiveFrom: d("2026-01-01"), effectiveTo: null, status: "ACTIVE" },
    ];

    // Tháng 8 trọn vẹn: CHỈ chính sách A, và đủ 31 ngày.
    const t8 = resolveSegments({ from: d("2026-08-01"), to: dEnd("2026-08-31"), employments: [NHAN_SU], policyAssignments: gan, policyVersions: ban });
    assert.deepEqual([...new Set(t8.map((s) => s.policyCode))], ["A"], "3. tháng 8 chỉ thuộc chính sách A — không có một ngày nào của B lọt vào");
    assert.equal(t8.reduce((t, s) => t + s.days, 0), 31, "3. tháng 8 phải đủ 31 ngày, không 30 không 32");

    // Tháng 9 trọn vẹn: CHỈ chính sách B, và đủ 30 ngày.
    const t9 = resolveSegments({ from: d("2026-09-01"), to: dEnd("2026-09-30"), employments: [NHAN_SU], policyAssignments: gan, policyVersions: ban });
    assert.deepEqual([...new Set(t9.map((s) => s.policyCode))], ["B"], "3. tháng 9 chỉ thuộc chính sách B — ngày 01/09 KHÔNG được còn dính A");
    assert.equal(t9.reduce((t, s) => t + s.days, 0), 30, "3. tháng 9 phải đủ 30 ngày");

    /*
      KHOẢNG BẮC QUA ĐIỂM CHUYỂN GIAO: hai đoạn, chia đúng 31 + 30, KHÔNG HỞ và KHÔNG CHỒNG.
      Đây là phép kiểm mạnh nhất trong khối: tổng số ngày bằng đúng số ngày của khoảng thì không
      thể vừa hở vừa chồng mà vẫn cộng ra đúng.
    */
    const bac = resolveSegments({ from: d("2026-08-01"), to: dEnd("2026-09-30"), employments: [NHAN_SU], policyAssignments: gan, policyVersions: ban });
    const lamViec = bac.filter(isWorkingSegment);
    assert.equal(lamViec.length, 2, "3. bắc qua điểm chuyển giao phải ra ĐÚNG hai đoạn");
    assert.equal(lamViec[0].policyCode, "A");
    assert.equal(lamViec[1].policyCode, "B");
    assert.equal(lamViec[0].days, 31, "3. đoạn A đúng 31 ngày của tháng 8");
    assert.equal(lamViec[1].days, 30, "3. đoạn B đúng 30 ngày của tháng 9");
    assert.equal(lamViec[0].days + lamViec[1].days, 61, "3. tổng bằng đúng số ngày của khoảng ⇒ không hở, không chồng");
    assert.equal(
      lamViec[1].from.getTime() - lamViec[0].to.getTime(),
      1,
      "3. đoạn sau bắt đầu ngay SAU mốc cuối của đoạn trước, cách đúng 1ms — hở một nhịp là một ngày không thuộc chính sách nào",
    );

    /*
      MỐC CUỐI GHI 23:59:59 (KHÔNG mili-giây) TỪNG SINH RA MỘT "NGÀY MA".
      `effectiveTo + 1ms` rơi vào giữa ngày, đẻ ra một đoạn dài 999ms mà `inclusiveDays` đếm thành
      một ngày TRỌN. Người ta bị tính thêm một ngày lương cứng không tồn tại.
    */
    const ganCu: PolicyAssignmentRow[] = [
      { ...gan[0], effectiveTo: new Date("2026-08-31T23:59:59+07:00") },
      gan[1],
    ];
    const cu = resolveSegments({ from: d("2026-08-01"), to: dEnd("2026-09-30"), employments: [NHAN_SU], policyAssignments: ganCu, policyVersions: ban });
    assert.equal(cu.filter(isWorkingSegment).reduce((t, s) => t + s.days, 0), 61, "3. mốc cuối ghi 23:59:59 vẫn phải ra 61 ngày — không đẻ thêm một ngày ma");
    assert.equal(cu.filter(isWorkingSegment).length, 2, "3. và vẫn đúng hai đoạn, không phải ba");
  }

  /*
    ═══════════════════════════════════════════════════════════════════════════════════════
    4 · HAI DÒNG PHÂN CÔNG CHỒNG LẤN PHẢI CHẶN CHỐT KỲ
    ═══════════════════════════════════════════════════════════════════════════════════════

    LỖI THẬT ĐÃ SỬA. Phép kiểm sổ khai soi chồng lấn của GÁN CHÍNH SÁCH nhưng bỏ qua PHÂN CÔNG LAO
    ĐỘNG — trong khi dòng phân công mang cả `status`. `resolveSegments` lấy dòng có `effectiveFrom`
    MUỘN NHẤT, nên chỉ cần thêm một dòng "đã nghỉ" mốc muộn hơn là cả đoạn ấy thôi được tính lương,
    im lặng, không lỗi nào nổ ra.
  */
  {
    const ten = () => "Người thử";
    const chong: EmploymentRow[] = [
      { ...NHAN_SU, id: "em-a", effectiveFrom: d("2026-01-01"), effectiveTo: null, status: "ACTIVE" },
      { ...NHAN_SU, id: "em-b", effectiveFrom: d("2026-06-01"), effectiveTo: null, status: "TERMINATED" },
    ];
    const loi = employmentOverlaps(chong, ten);
    assert.equal(loi.length, 1, "4. hai dòng phân công cùng phủ một ngày phải bị nêu ra");
    assert.equal(loi[0].blocking, true, "4. và phải CHẶN chốt kỳ — nó quyết định có tính lương hay không");
    assert.match(loi[0].message, /TERMINATED/, "4. câu chặn phải nói rõ trạng thái của hai dòng");

    const noiTiep: EmploymentRow[] = [
      { ...NHAN_SU, id: "em-a", effectiveFrom: d("2026-01-01"), effectiveTo: dEnd("2026-05-31") },
      { ...NHAN_SU, id: "em-b", effectiveFrom: d("2026-06-01"), effectiveTo: null },
    ];
    assert.equal(employmentOverlaps(noiTiep, ten).length, 0, "4. nối tiếp nhau đúng mốc thì KHÔNG phải chồng lấn");
    assert.equal(assignmentOverlaps([], ten).length, 0, "4. sổ rỗng không sinh cảnh báo");
  }

  /*
    ═══════════════════════════════════════════════════════════════════════════════════════
    5 · ĐỘ CHÍNH XÁC TIỀN: VND LÀ SỐ NGUYÊN, LÀM TRÒN ĐÚNG MỘT LẦN, KHÔNG CÓ `-0`
    ═══════════════════════════════════════════════════════════════════════════════════════

    JavaScript không có kiểu thập phân, nên mọi tỷ lệ đều đi qua dấu phẩy động. Luật của kho mã là
    tiền VND LUÔN là số nguyên và phép làm tròn nằm ở ĐÚNG MỘT chỗ trong máy tính (bước 6), sau
    sàn/trần. Bài này khoá cả ba điều đó bằng những con số mà dấu phẩy động làm sai nếu để trôi.
  */
  {
    // 0.1 + 0.2 kinh điển, nhưng dưới dạng một khoản hoa hồng thật.
    const raw = 0.1 + 0.2;
    assert.notEqual(raw, 0.3, "5. tiền đề: dấu phẩy động KHÔNG cộng đúng — nên tiền không được giữ ở dạng thập phân");

    const hh = thanhPhan({ code: "HH", kind: "COMMISSION", calc: { type: "RATE_OF_BASIS", basisKey: "REVENUE_PERSONAL", ratePercent: 0.3 } });
    const r = calculatePayrollItem({
      employeeId: "e1", employeeName: "A", adjustments: [], carryOpening: {},
      segments: [{ segment: doan("2026-09-01", "2026-09-30", "v1", 1, 30), components: [hh], basis: { REVENUE_PERSONAL: 123_456_789 } }],
    });
    const tien = r.components[0].amount!;
    assert.ok(Number.isInteger(tien), "5. mọi khoản tiền ra khỏi máy phải là SỐ NGUYÊN đồng");
    assert.equal(tien, Math.round(123_456_789 * 0.003), "5. và bằng đúng phép làm tròn MỘT lần trên tích đầy đủ, không phải tổng của các phần đã làm tròn trước");

    // Trần áp TRƯỚC làm tròn: làm tròn lên một khoản đã chạm trần sẽ vượt trần.
    const tran = thanhPhan({
      code: "HH2", kind: "COMMISSION",
      calc: { type: "RATE_OF_BASIS", basisKey: "REVENUE_PERSONAL", ratePercent: 50 },
      maxAmount: 1_000_000, rounding: "ROUND_1000",
    });
    const rt = calculatePayrollItem({
      employeeId: "e1", employeeName: "A", adjustments: [], carryOpening: {},
      segments: [{ segment: doan("2026-09-01", "2026-09-30", "v1", 1, 30), components: [tran], basis: { REVENUE_PERSONAL: 99_999_999 } }],
    });
    assert.equal(rt.components[0].amount, 1_000_000, "5. chạm trần rồi làm tròn KHÔNG được vượt trần — một cái trần vượt được thì không phải trần");
    assert.equal(rt.components[0].cappedBy, "MAX", "5. và phải nói ra là đã bị cắt");

    // `-0` không được lọt ra: nó in thành "-0" ở `Intl` và thành `-0` trong JSON ảnh chụp.
    const khauTru = thanhPhan({ code: "KT", kind: "DEDUCTION", calc: { type: "FIXED_AMOUNT", amount: 0 } });
    const rk = calculatePayrollItem({
      employeeId: "e1", employeeName: "A", adjustments: [], carryOpening: {},
      segments: [{ segment: doan("2026-09-01", "2026-09-30", "v1", 1, 30), components: [khauTru], basis: {} }],
    });
    assert.equal(Object.is(rk.components[0].amount, -0), false, "5. khấu trừ bằng 0 KHÔNG được ra `-0` — nó vào ảnh chụp thành `-0` và in ra thành '-0 ₫'");
    assert.equal(Object.is(rk.totalDeductions, -0), false, "5. tổng khấu trừ cũng vậy");
    assert.equal(JSON.stringify(rk.components[0].amount), "0", "5. và ảnh chụp JSON phải ghi `0`");
    assert.equal(formatVND(rk.components[0].amount!), "0 ₫", "5. in ra màn hình là '0 ₫'");

    // Làm tròn: bốn luật, và mỗi luật phải làm đúng thứ nó khai.
    assert.equal(applyRounding(1_500.4, "ROUND"), 1_500);
    assert.equal(applyRounding(1_500.6, "ROUND"), 1_501);
    assert.equal(applyRounding(1_500.9, "FLOOR"), 1_500);
    assert.equal(applyRounding(1_500.1, "CEIL"), 1_501);
    assert.equal(applyRounding(1_499, "ROUND_1000"), 1_000, "5. 1.499 làm tròn về nghìn là 1.000");
    assert.equal(applyRounding(1_500, "ROUND_1000"), 2_000, "5. 1.500 làm tròn về nghìn là 2.000");

    /*
      TRẦN CỦA Ô TIỀN PHẢI BẰNG TRẦN CỦA CỘT.
      Cột tiền là `integer` (2.147.483.647đ). Lược đồ đầu vào trước bản này cho tới 10 tỷ, nên một
      khoản 3 tỷ qua được zod rồi chết ở Postgres bằng một câu lỗi tiếng Anh không ai sửa được.
    */
    assert.equal(VND_COLUMN_MAX, 2_147_483_647, "5. trần phải đúng bằng trần của kiểu `integer`");
    assert.equal(adjustmentSchema.safeParse({ employeeId: "e1", periodKey: "2026-09-01..2026-09-30", kind: "BONUS", label: "x", amount: 3_000_000_000, reason: "thử" }).success, false, "5. 3 tỷ phải bị chặn Ở LƯỢC ĐỒ, không phải ở Postgres");
    assert.equal(adjustmentSchema.safeParse({ employeeId: "e1", periodKey: "2026-09-01..2026-09-30", kind: "BONUS", label: "x", amount: VND_COLUMN_MAX, reason: "thử" }).success, true, "5. đúng trần thì vẫn nhận");
  }

  /*
    ═══════════════════════════════════════════════════════════════════════════════════════
    6 · MKTER: CHUỖI PHÉP TÍNH TỪ DOANH THU TỚI HOA HỒNG, VÀ HOA HỒNG KHÔNG TỰ TRỪ VÀO CƠ SỞ
    ═══════════════════════════════════════════════════════════════════════════════════════

    Đây là tình huống trọng tâm của cả module, viết ra thành số để đọc được bằng mắt:

        Doanh thu giao thành công        200.000.000
      − Giá vốn hàng đã giao              90.000.000
      − Quảng cáo của chính người đó      35.000.000
      − Cước vận chuyển                    8.000.000
      − Phí hoàn                           2.000.000
      − Chi phí vận hành phân bổ          15.000.000
      ───────────────────────────────────────────────
      = LỢI NHUẬN TRƯỚC LƯƠNG BIẾN ĐỔI    50.000.000

    Rồi mới tới sổ lỗ, rồi mới tới hoa hồng. Điều phải đứng vững: HOA HỒNG KHÔNG nằm trong cái trừ
    ở trên. Đưa nó vào là định nghĩa vòng tròn, và hậu quả đo được — hoa hồng kỳ trước làm giảm cơ
    sở tính hoa hồng kỳ này, mỗi kỳ một lần, về phía người lao động nhận ít đi.
  */
  {
    const doanhThu = 200_000_000;
    const giaVon = 90_000_000;
    const quangCao = 35_000_000;
    const cuoc = 8_000_000;
    const phiHoan = 2_000_000;
    const vanHanh = 15_000_000;
    const coSo = doanhThu - giaVon - quangCao - cuoc - phiHoan - vanHanh;
    assert.equal(coSo, 50_000_000, "6. cơ sở lợi nhuận trước lương biến đổi");

    const TY_LE = 10;
    const hh = thanhPhan({ code: "HH", kind: "COMMISSION", calc: { type: "RATE_OF_BASIS", basisKey: "PROFIT_PERSONAL", ratePercent: TY_LE }, carryForward: true });
    const tinh = (moTruoc: number, loiNhuan: number) =>
      calculatePayrollItem({
        employeeId: "mkt", employeeName: "MKTer", adjustments: [], carryOpening: { HH: moTruoc },
        segments: [{ segment: doan("2026-09-01", "2026-09-30", "v1", 1, 30), components: [hh], basis: { PROFIT_PERSONAL: loiNhuan } }],
      }).components[0];

    // Không lỗ mang sang.
    const sach = tinh(0, coSo);
    assert.equal(sach.carry!.commissionBase, 50_000_000, "6. không lỗ mang sang ⇒ cơ sở tính hoa hồng bằng chính lợi nhuận");
    assert.equal(sach.amount, 5_000_000, "6. hoa hồng = 50tr × 10%");

    // Có lỗ mang sang −20tr.
    const coLo = tinh(-20_000_000, coSo);
    assert.equal(coLo.carry!.lossApplied, 20_000_000, "6. bù hết 20tr lỗ cũ");
    assert.equal(coLo.carry!.commissionBase, 30_000_000, "6. lợi nhuận tính hoa hồng sau bù = max(0, −20tr + 50tr)");
    assert.equal(coLo.amount, 3_000_000, "6. hoa hồng = 30tr × 10%");
    assert.equal(coLo.carry!.closingBalance, 0, "6. hết lỗ ⇒ không chuyển tiếp");

    /*
      HOA HỒNG KHÔNG ĐƯỢC TỰ TRỪ VÀO CƠ SỞ.

      Đo bằng số: nếu kỳ sau lấy cơ sở ĐÃ TRỪ hoa hồng kỳ này (50tr − 5tr = 45tr) thì hoa hồng kỳ
      sau tụt từ 5.000.000 xuống 4.500.000 — mỗi kỳ mất 10%, và không ai đi kiểm một con số thấp.
    */
    const kySau = tinh(0, coSo);
    const neuTruNham = tinh(0, coSo - sach.amount!);
    assert.equal(kySau.amount, 5_000_000, "6. kỳ sau cùng lợi nhuận ⇒ cùng hoa hồng");
    assert.equal(neuTruNham.amount, 4_500_000, "6. (chứng minh cái sai) trừ hoa hồng vào cơ sở làm hụt đúng 500.000đ mỗi kỳ");
    assert.notEqual(kySau.amount, neuTruNham.amount, "6. hai con số PHẢI khác nhau — bằng nhau nghĩa là cơ sở đang tự trừ chính nó");

    // Lợi nhuận ÂM không sinh ra một khoản phải trả ÂM.
    const am = tinh(0, -12_000_000);
    assert.equal(am.amount, 0, "6. tháng lỗ ⇒ hoa hồng 0, KHÔNG phải số âm trừ vào lương cứng");
    assert.equal(am.carry!.closingBalance, -12_000_000, "6. nhưng phần âm không bị vứt — nó chuyển sang kỳ sau");
  }

  /*
    ═══════════════════════════════════════════════════════════════════════════════════════
    7 · CHUỖI BÙ LỖ BỐN THÁNG, VÀ TÍNH LẠI KHÔNG LÀM ĐỔI SỐ
    ═══════════════════════════════════════════════════════════════════════════════════════

        T1  −10.000.000   → chuyển tiếp  −10.000.000
        T2   −5.000.000   → chuyển tiếp  −15.000.000
        T3   +8.000.000   → chuyển tiếp   −7.000.000
        T4  +20.000.000   → cơ sở tính HH 13.000.000

    Con số cuối là điểm của cả chuỗi: hoa hồng T4 chỉ được tính trên 13 triệu, không phải 20 triệu.
  */
  {
    const chuoi = [-10_000_000, -5_000_000, 8_000_000, 20_000_000];
    let mo = 0;
    const ketQua = chuoi.map((ln) => {
      const r = carryoverMonth({ openingBalance: mo, realProfit: ln, commissionPercent: 10 });
      mo = r.closingBalance ?? 0;
      return r;
    });
    assert.equal(ketQua[0].closingBalance, -10_000_000, "7. T1 chuyển tiếp −10tr");
    assert.equal(ketQua[1].closingBalance, -15_000_000, "7. T2 chuyển tiếp −15tr");
    assert.equal(ketQua[2].closingBalance, -7_000_000, "7. T3 chuyển tiếp −7tr");
    assert.equal(ketQua[3].commissionBase, 13_000_000, "7. T4 chỉ tính hoa hồng trên 13tr, không phải 20tr");
    assert.equal(ketQua[3].closingBalance, 0, "7. T4 hết lỗ");
    for (const r of ketQua.slice(0, 3)) assert.equal(r.commissionBase, 0, "7. ba tháng đầu chưa có cơ sở tính hoa hồng");

    // TÍNH LẠI T4 NHIỀU LẦN trên cùng số dư đầu ⇒ cùng một kết quả, không cộng dồn.
    const lai = [0, 1, 2].map(() => carryoverMonth({ openingBalance: -7_000_000, realProfit: 20_000_000, commissionPercent: 10 }));
    assert.deepEqual(lai[1], lai[0], "7. tính lại lần hai ra đúng kết quả lần một");
    assert.deepEqual(lai[2], lai[0], "7. và lần ba cũng vậy — hàm THUẦN nên nó không thể khác");
  }

  /*
    ═══════════════════════════════════════════════════════════════════════════════════════
    8 · SÁU CHÍNH SÁCH MẪU CHẠY QUA MÁY THẬT
    ═══════════════════════════════════════════════════════════════════════════════════════

    Không phải để kiểm phép nhân — khối 5 đã làm việc đó. Đây là để chứng minh SÁU CÁCH TRẢ LƯƠNG
    thật sự khai được bằng sổ chính sách hiện có, không cần một nhánh `if` nào theo chức danh. Máy
    không biết ai là MKTer, ai ở kho: nó chỉ đọc thành phần.

    Số trong khối này là số FIXTURE. Không con số nào ở đây là mức lương thật của ai.
  */
  {
    const chay = (comps: PolicyComponent[], basis: Record<string, number | null>) =>
      calculatePayrollItem({
        employeeId: "e1", employeeName: "A", adjustments: [], carryOpening: { HH: 0, LN: 0 },
        segments: [{ segment: doan("2026-09-01", "2026-09-30", "v1", 1, 30), components: comps, basis }],
      });

    // A · Toàn thời gian, lương cứng.
    const A = chay([thanhPhan({ code: "BASE", kind: "FIXED", calc: { type: "FIXED_AMOUNT", amount: 12_000_000 }, prorate: "PERIOD_DAYS" })], {});
    assert.equal(A.netPay, 12_000_000, "8A. trọn tháng ⇒ đúng khoản tháng, không dư không thiếu vì làm tròn");

    // B · Bán thời gian, trả theo giờ.
    const B = chay([thanhPhan({ code: "HOUR", kind: "TIME_BASED", calc: { type: "PER_UNIT", basisKey: "WORK_HOURS", unitRate: 45_000 } })], { WORK_HOURS: 96 });
    assert.equal(B.netPay, 96 * 45_000, "8B. giờ công × đơn giá");

    // C · Lương cứng + thưởng KPI theo ngưỡng.
    const C = chay(
      [
        thanhPhan({ code: "BASE", kind: "FIXED", calc: { type: "FIXED_AMOUNT", amount: 10_000_000 }, prorate: "PERIOD_DAYS" }),
        thanhPhan({ code: "KPI", kind: "KPI", calc: { type: "THRESHOLD_BONUS", basisKey: "KPI_PERCENT", threshold: 80, amount: 2_000_000 } }),
      ],
      { KPI_PERCENT: 85 },
    );
    assert.equal(C.netPay, 12_000_000, "8C. đạt ngưỡng KPI ⇒ cộng đủ khoản thưởng");
    const C2 = chay(
      [
        thanhPhan({ code: "BASE", kind: "FIXED", calc: { type: "FIXED_AMOUNT", amount: 10_000_000 }, prorate: "PERIOD_DAYS" }),
        thanhPhan({ code: "KPI", kind: "KPI", calc: { type: "THRESHOLD_BONUS", basisKey: "KPI_PERCENT", threshold: 80, amount: 2_000_000 } }),
      ],
      { KPI_PERCENT: 79 },
    );
    assert.equal(C2.netPay, 10_000_000, "8C. chưa đạt ⇒ 0, không có phần thưởng nào chia tỷ lệ");

    // D · Sale: lương cứng + hoa hồng doanh thu theo bậc.
    const D = chay(
      [
        thanhPhan({ code: "BASE", kind: "FIXED", calc: { type: "FIXED_AMOUNT", amount: 8_000_000 }, prorate: "PERIOD_DAYS" }),
        thanhPhan({
          code: "HH", kind: "COMMISSION",
          calc: { type: "TIERED_RATE", basisKey: "REVENUE_PERSONAL", tiers: [{ from: 0, ratePercent: 1 }, { from: 100_000_000, ratePercent: 2 }] },
        }),
      ],
      { REVENUE_PERSONAL: 150_000_000 },
    );
    // Bậc áp cho PHẦN VƯỢT: 100tr × 1% + 50tr × 2% = 2.000.000
    assert.equal(D.components.find((c) => c.code === "HH")!.amount, 2_000_000, "8D. bậc áp cho phần vượt, không áp cho toàn bộ — nếu không, vượt ngưỡng một đồng làm thưởng nhảy bậc");
    assert.equal(D.netPay, 10_000_000);

    // E · Marketing: chia lợi nhuận, có bù lỗ.
    const E = calculatePayrollItem({
      employeeId: "e1", employeeName: "A", adjustments: [], carryOpening: { LN: -6_000_000 },
      segments: [{
        segment: doan("2026-09-01", "2026-09-30", "v1", 1, 30),
        components: [thanhPhan({ code: "LN", kind: "PROFIT_SHARE", calc: { type: "RATE_OF_BASIS", basisKey: "PROFIT_PERSONAL", ratePercent: 15 }, carryForward: true })],
        basis: { PROFIT_PERSONAL: 26_000_000 },
      }],
    });
    assert.equal(E.netPay, Math.round((26_000_000 - 6_000_000) * 0.15), "8E. chia lợi nhuận SAU khi bù hết lỗ mang sang");

    // F · Khoán sản phẩm.
    const F = chay([thanhPhan({ code: "KHOAN", kind: "PIECE_RATE", calc: { type: "PER_UNIT", basisKey: "PIECES", unitRate: 3_500 } })], { PIECES: 1_240 });
    assert.equal(F.netPay, 1_240 * 3_500, "8F. sản lượng × đơn giá khoán");

    // Cả sáu đều phải ra một con số ĐÃ BIẾT — không cái nào rơi vào CHƯA BIẾT vì thiếu khai báo.
    for (const [ten, r] of [["A", A], ["B", B], ["C", C], ["D", D], ["E", E], ["F", F]] as const) {
      assert.notEqual(r.netPay, null, `8. chính sách ${ten} phải tính ra được`);
      assert.equal(r.problems.length, 0, `8. chính sách ${ten} không được còn vấn đề cấu hình`);
      assert.equal(r.missing.length, 0, `8. chính sách ${ten} không được thiếu đại lượng`);
    }

    // THIẾU ĐẠI LƯỢNG ⇒ CHƯA BIẾT, không phải 0 — và nói rõ ai phải nhập.
    const thieu = chay([thanhPhan({ code: "HOUR", kind: "TIME_BASED", calc: { type: "PER_UNIT", basisKey: "WORK_HOURS", unitRate: 45_000 } })], {});
    assert.equal(thieu.netPay, null, "8. chưa chấm công ⇒ thực nhận CHƯA BIẾT, không phải 0 đồng");
    assert.equal(thieu.missing.length, 1, "8. và nói ĐÚNG cái đang thiếu");
    assert.equal(thieu.missing[0].availability, "MANUAL", "8. cùng với việc ai phải đi nhập nó");
  }

  /*
    ═══════════════════════════════════════════════════════════════════════════════════════
    10 · GÁN CHÍNH SÁCH MÀ CHƯA KHAI PHÂN CÔNG: PHẢI NÓI RA, KHÔNG ĐƯỢC TRẢ 0đ IM LẶNG
    ═══════════════════════════════════════════════════════════════════════════════════════

    LỖI THẬT ĐÃ SỬA, VÀ LÀ LỖI NGUY HIỂM NHẤT TRONG CẢ MODULE.

    Không có dòng phân công lao động nào thì không đoạn nào là "đoạn làm việc"; vòng lặp bỏ qua tất
    cả; người ấy ra `netPay = 0` với `problems` RỖNG và `missing` RỖNG. Cổng chặn chốt kỳ đọc đúng
    hai danh sách ấy, nên kỳ VẪN CHỐT ĐƯỢC với người ấy ở 0đ — không cảnh báo, không dấu hỏi.

    Đo trên production 15/09/2026 bằng `db-query` (chỉ đọc): `employment_assignments` RỖNG, cả 4
    nhân sự đều chưa khai phân công. Nghĩa là lượt bấm "Chuyển sang máy chung" ĐẦU TIÊN trên
    production đã đi thẳng vào đường này.

    Phép kiểm phải phân biệt được HAI tình huống mà bản trước gộp làm một.
  */
  {
    const gan: PolicyAssignmentRow[] = [
      { id: "a1", employeeId: "e1", policyId: "p1", policyCode: "P1", policyName: "P1", effectiveFrom: d("2026-01-01"), effectiveTo: null },
    ];
    const ban: PolicyVersionRow[] = [{ id: "v1", policyId: "p1", version: 1, effectiveFrom: d("2026-01-01"), effectiveTo: null, status: "ACTIVE" }];
    const luong = thanhPhan({ code: "BASE", kind: "FIXED", calc: { type: "FIXED_AMOUNT", amount: 12_000_000 }, prorate: "PERIOD_DAYS" });
    const tinh = (employments: EmploymentRow[]) => {
      const segs = resolveSegments({ from: d("2026-09-01"), to: dEnd("2026-09-30"), employments, policyAssignments: gan, policyVersions: ban });
      return calculatePayrollItem({
        employeeId: "e1", employeeName: "A", adjustments: [], carryOpening: {},
        segments: segs.map((segment) => ({ segment, components: [luong], basis: {} })),
      });
    };

    // (a) CHƯA KHAI PHÂN CÔNG — ERP không biết người này có đi làm hay không.
    const chuaKhai = tinh([]);
    assert.equal(chuaKhai.netPay, 0, "10. con số vẫn là 0 (máy không bịa ra một khoản lương)");
    assert.equal(chuaKhai.problems.length, 1, "10. NHƯNG phải có ĐÚNG MỘT dòng nói vì sao — 0đ im lặng là thứ không ai đi kiểm");
    assert.match(chuaKhai.problems[0], /CHƯA khai phân công lao động/, "10. và nói đúng việc phải làm");
    assert.match(chuaKhai.problems[0], /01\/09\/2026/, "10. ngày in ra phải là ngày VIỆT NAM — máy chủ chạy UTC nên `toLocaleDateString` in lùi một ngày");

    // (b) ĐÃ NGHỈ VIỆC trước kỳ — 0đ là câu trả lời ĐÚNG, và không được kêu ca gì.
    const daNghi = tinh([{ ...NHAN_SU, effectiveFrom: d("2020-01-01"), effectiveTo: dEnd("2026-06-30") }]);
    assert.equal(daNghi.netPay, 0, "10. đã nghỉ trước kỳ ⇒ 0đ");
    assert.equal(daNghi.problems.length, 0, "10. và KHÔNG cảnh báo gì — người ta thật sự không làm ngày nào, đây là câu trả lời đúng");

    // (c) ĐANG LÀM — tính ra tiền như thường.
    const dangLam = tinh([NHAN_SU]);
    assert.equal(dangLam.netPay, 12_000_000, "10. có phân công ⇒ tính ra tiền");
    assert.equal(dangLam.problems.length, 0, "10. và không có vấn đề gì");

    /*
      HAI TÌNH HUỐNG (a) VÀ (b) RA CÙNG MỘT CON SỐ nhưng KHÁC NHAU VỀ BẢN CHẤT.
      Đây chính là điều bản trước không phân biệt được, và là lý do cột `hasEmploymentRecord` tồn tại.
    */
    assert.equal(chuaKhai.netPay, daNghi.netPay, "10. (tiền đề) hai tình huống ra cùng một con số…");
    assert.notEqual(chuaKhai.problems.length, daNghi.problems.length, "10. …nên phải phân biệt được bằng `problems`, không bằng con số");
  }

  /*
    ═══════════════════════════════════════════════════════════════════════════════════════
    9 · MỌI CỬA VÀO DỮ LIỆU LƯƠNG PHẢI CÓ CỔNG — QUÉT MÃ NGUỒN, KHÔNG TIN VÀO MẮT
    ═══════════════════════════════════════════════════════════════════════════════════════

    Một cái nút ẩn không phải một lớp bảo vệ. Lương là dữ liệu nhạy cảm nhất trong ERP, và cửa vào
    nó KHÔNG phải màn hình — là Server Action (gọi thẳng được) và route API (mở URL là chạy).

    Bài quét mã ĐÃ VÀO KHO (`git show HEAD:`), không đọc đĩa: một cửa mới thêm mà quên cổng sẽ đỏ
    ngay trên máy người viết, thay vì đợi tới lúc có người thử.
  */
  {
    const dsTep = execSync("git ls-files lib/actions app/api", { encoding: "utf8" })
      .split("\n")
      .filter((f) => f.trim() && /payroll/i.test(f));
    assert.ok(dsTep.length >= 5, "9. phải quét được các tệp cửa vào của lương");

    for (const tep of dsTep) {
      const ma = execSync(`git show HEAD:${tep}`, { encoding: "utf8" });
      const laRoute = tep.startsWith("app/api/");
      // Tên các hàm xuất ra ngoài: Server Action (`export async function X`) hoặc handler HTTP.
      const cua = [...ma.matchAll(/^export async function (\w+)\s*\(/gm)].map((m) => m[1]);
      for (const ten of cua) {
        const than = ma.slice(ma.indexOf(`export async function ${ten}`));
        const dau = than.slice(0, 2500);
        assert.match(
          dau,
          /requireUser\(\)|getCurrentUser\(\)|requireManage\(\)/,
          `9. ${tep}::${ten} phải xác định NGƯỜI trước khi làm gì — gọi thẳng một Server Action không đi qua màn hình nào`,
        );
        /*
          PHẢI KIỂM QUYỀN, KHÔNG CHỈ KIỂM ĐÃ ĐĂNG NHẬP.

          Nhận cả `can(user, "payroll:…")` viết thẳng lẫn `can(user, spec.permission)` đọc từ bảng
          — `movePayrollRun` cố ý đọc từ bảng để màn hình và máy chủ dùng chung một nguồn. Bản
          thân bảng ấy được khoá riêng ở cuối khối này, nên không có đường nào lọt.
        */
        assert.match(
          dau,
          /can\(\s*user\s*,|requireManage\(\)/,
          `9. ${tep}::${ten} phải kiểm QUYỀN lương, không chỉ kiểm đã đăng nhập`,
        );
        if (laRoute) {
          assert.match(than.slice(0, 4000), /employeeMatchesUser/, `9. ${tep}::${ten} là đường xuất dữ liệu: phải lọc theo KHOÁ TÀI KHOẢN cho người chỉ xem của mình`);
        }
      }
    }

    /*
      QUYỀN XEM ≠ QUYỀN KHAI BÁO ≠ QUYỀN DUYỆT.

      Ba việc nặng nhất — duyệt, khoá, đánh dấu đã trả — phải đòi `payroll:approve`. Người khai số
      và người duyệt số không nên là một; để `payroll:manage` tự mang theo quyền duyệt là bỏ hẳn
      lớp soát thứ hai.
    */
    // `REJECT` cũng ở nhóm DUYỆT: nó đi được từ `APPROVED` về `CALCULATED`, nghĩa là nó RÚT LẠI
    // một chữ ký duyệt. Ai rút được chữ ký thì phải là người ký được.
    for (const viec of ["APPROVE", "REJECT", "LOCK", "UNLOCK", "MARK_PAID"] as const) {
      assert.equal(PAYROLL_ACTION_SPEC[viec].permission, "payroll:approve", `9. “${PAYROLL_ACTION_SPEC[viec].label}” phải đòi quyền DUYỆT lương`);
    }
    for (const viec of ["CALCULATE", "SUBMIT_REVIEW"] as const) {
      assert.equal(PAYROLL_ACTION_SPEC[viec].permission, "payroll:manage", `9. “${PAYROLL_ACTION_SPEC[viec].label}” đòi quyền khai báo`);
    }
    // Ba việc làm đổi một kỳ ĐÃ CÓ SỐ phải cần người thứ hai.
    for (const viec of ["UNLOCK", "MARK_PAID"] as const) {
      assert.equal(PAYROLL_ACTION_SPEC[viec].secondApproval, true, `9. “${PAYROLL_ACTION_SPEC[viec].label}” một mình quyết là quá nhiều quyền`);
    }
    assert.equal(PAYROLL_ACTION_SPEC.UNLOCK.requiresReason, true, "9. mở khoá một kỳ đã trả tiền bắt buộc có LÝ DO");
  }

  /*
    ═══════════════════════════════════════════════════════════════════════════════════════
    11 · CỔNG ĐỐI CHIẾU: KHÔNG ĐƯỢC KẾT LUẬN "KHỚP" TRÊN DỮ LIỆU RỖNG
    ═══════════════════════════════════════════════════════════════════════════════════════

    LỖI THẬT ĐÃ SỬA, VÀ LÀ LỖI VỀ CÁCH ĐỌC KẾT QUẢ CHỨ KHÔNG PHẢI VỀ PHÉP TÍNH.

    Lượt đối chiếu đầu tiên trên production trả "4/4 khớp, lệch 0đ" và nghe như một cổng đã qua.
    Nó không phải: bảng lương trên production RỖNG, chưa ai được gán chính sách, nên cả hai đường
    đều trả về cùng một thứ *không có gì*. Hai phép tính cùng ra 0 trên dữ liệu rỗng KHÔNG chứng
    minh chúng đồng ý — chỉ chứng minh không có gì để bất đồng.

    Kết quả RỖNG NGHĨA nguy hiểm vì nó trông y hệt một kết quả tốt, và nó xuất hiện đúng lúc người
    ta muốn nghe điều đó nhất: ngay trước khi phát hành.
  */
  {
    const nen = { employeeId: "e1", employeeName: "A", missingConfig: [] as string[], hasOwnActivity: true, hasLegacyLine: true, netDiff: 0, hasUnexplainedDiff: false };

    assert.equal(classifyEmployee(nen), "MATCH", "11. có thứ để so + lệch 0 ⇒ KHỚP");
    assert.equal(
      classifyEmployee({ ...nen, hasOwnActivity: false }),
      "INSUFFICIENT_DATA",
      "11. KHÔNG có gì để so thì 0 = 0 KHÔNG phải một phép khớp — đây là toàn bộ điểm của khối này",
    );
    assert.equal(classifyEmployee({ ...nen, hasLegacyLine: false }), "INSUFFICIENT_DATA", "11. đường cũ không ra dòng nào ⇒ không so được");
    assert.equal(classifyEmployee({ ...nen, netDiff: null }), "INSUFFICIENT_DATA", "11. một bên CHƯA BIẾT ⇒ không kết luận");
    assert.equal(classifyEmployee({ ...nen, netDiff: 5_000 }), "EXPECTED_CHANGE", "11. có lệch nhưng giải thích được");
    assert.equal(classifyEmployee({ ...nen, hasUnexplainedDiff: true }), "BUG", "11. lệch không giải thích được là LỖI");
    assert.equal(classifyEmployee({ ...nen, missingConfig: ["chưa khai phân công"] }), "NEEDS_CONFIG", "11. thiếu khai báo là việc phải làm, không phải một khoản lệch");

    /* THỨ TỰ ƯU TIÊN — phần dễ sai nhất, vì mỗi nhãn sai đều "nghe hợp lý". */
    assert.equal(
      classifyEmployee({ ...nen, missingConfig: ["thiếu"], hasUnexplainedDiff: true }),
      "BUG",
      "11. LỖI thắng THIẾU KHAI BÁO — một khoản lệch không giải thích được không được che bằng một nhãn dễ nghe hơn",
    );
    assert.equal(
      classifyEmployee({ ...nen, missingConfig: ["thiếu"], hasOwnActivity: false }),
      "NEEDS_CONFIG",
      "11. THIẾU KHAI BÁO trước KHÔNG ĐỦ DỮ LIỆU — cái đầu có người làm được ngay, cái sau phải đợi kỳ sau",
    );

    /* ═══ HOẠT ĐỘNG NGUỒN CỦA KỲ ═══ */
    const rong = { orders: 0, deliveredOrders: 0, revenue: 0, adSpend: 0, expenses: 0, shipments: 0, fixedSalaryDeclared: 0 };
    assert.equal(hasActivity(rong), false, "11. kỳ toàn số 0 KHÔNG có hoạt động");
    assert.equal(hasActivity({ ...rong, orders: 1 }), true, "11. một đơn cũng là có hoạt động");
    assert.equal(
      hasActivity({ ...rong, fixedSalaryDeclared: 12_000_000 }),
      true,
      "11. kỳ không có đơn nhưng CÓ lương cứng khai vẫn tính lương được — lương cứng đi theo THỜI GIAN, không theo đơn",
    );
    assert.deepEqual(activeSources({ ...rong, orders: 3, expenses: 2 }), ["orders", "expenses"], "11. nêu ĐÚNG nguồn nào có số, để người đọc tự thấy căn cứ");

    /* ═══ KẾT LUẬN CỔNG — bốn kết quả, không có ô "tạm được" ═══ */
    assert.equal(gateVerdict({ environmentOk: false, periodHasActivity: true, statuses: ["MATCH"] }).verdict, "RECONCILIATION_BLOCKED_BY_ENVIRONMENT", "11. không chạy được an toàn thì KHÔNG hạ chuẩn");
    assert.equal(
      gateVerdict({ environmentOk: true, periodHasActivity: false, statuses: ["MATCH", "MATCH", "MATCH", "MATCH"] }).verdict,
      "RECONCILIATION_BLOCKED_BY_CONFIG",
      "11. BỐN NGƯỜI “KHỚP” TRÊN MỘT KỲ RỖNG VẪN KHÔNG ĐƯỢC ĐẠT — đây chính là kết quả rỗng nghĩa mà production đã trả về",
    );
    assert.equal(gateVerdict({ environmentOk: true, periodHasActivity: true, statuses: ["MATCH", "BUG"] }).verdict, "NOT_READY_BUG_FOUND", "11. một LỖI là đủ để chặn");
    assert.equal(
      gateVerdict({ environmentOk: true, periodHasActivity: true, statuses: ["NEEDS_CONFIG", "NEEDS_CONFIG"] }).verdict,
      "RECONCILIATION_BLOCKED_BY_CONFIG",
      "11. kỳ có dữ liệu nhưng không ai tính được cả hai đường ⇒ vướng khai báo, chưa phải đạt",
    );
    assert.equal(
      gateVerdict({ environmentOk: true, periodHasActivity: true, statuses: ["MATCH", "NEEDS_CONFIG"] }).verdict,
      "RECONCILIATION_PASS",
      "11. có người đối chiếu được trên kỳ CÓ dữ liệu và không ai lỗi ⇒ đạt, kể cả khi người khác còn thiếu khai báo",
    );

    const dem = tallyStatuses(["MATCH", "MATCH", "BUG"]);
    assert.equal(dem.MATCH, 2);
    assert.equal(dem.BUG, 1);
    assert.equal(Object.keys(dem).length, RECON_STATUSES.length, "11. bảng tổng hợp phải giữ ĐỦ mọi khoá kể cả khoá bằng 0 — thiếu một dòng là một bảng nói dối");
  }

  /*
    ═══════════════════════════════════════════════════════════════════════════════════════
    12 · SCRIPT ĐỐI CHIẾU: DỪNG NẾU KHÔNG CHỨNG MINH ĐƯỢC CHỈ ĐỌC, VÀ CHỨNG MINH KHÔNG GHI
    ═══════════════════════════════════════════════════════════════════════════════════════

    Quét mã ĐÃ VÀO KHO. Ba điều kiện, và cả ba đều là thứ "sẽ đúng cho tới lần sửa sau" nếu chỉ
    viết trong khối chú thích.
  */
  {
    const src = execSync("git show HEAD:scripts/payroll-reconcile.ts", { encoding: "utf8" });
    const nguon = execSync("git show HEAD:lib/queries/payroll-reconcile-source.ts", { encoding: "utf8" });

    assert.ok(src.includes("assertReadOnlySession"), "12. script phải HỎI Postgres xem phiên có chỉ đọc không");
    assert.ok(
      !/catch[\s\S]{0,200}assertReadOnlySession/.test(src),
      "12. và KHÔNG được bắt lỗi ấy để chạy tiếp — fail closed nghĩa là không có nhánh nào đi vòng",
    );
    assert.ok(nguon.includes("current_setting('transaction_read_only')"), "12. hỏi CHÍNH máy chủ, không tin biến môi trường");
    assert.ok(
      !/insert into|\.insert\(|\.update\(|\.delete\(/.test(nguon.replace(/\/\*[\s\S]*?\*\//g, "")),
      "12. tệp nguồn của lượt đối chiếu không được có một lệnh ghi nào",
    );
    assert.ok(src.includes("payrollTableSnapshot") && src.includes("diffSnapshots"), "12. phải chụp ảnh đếm TRƯỚC và SAU — chứng minh, không khẳng định");
    assert.ok(nguon.includes("audit_logs"), "12. ảnh đếm phải gồm cả nhật ký: một lượt ghi nhật ký ngoài ý muốn cũng là một dòng THÊM");
    assert.ok(src.includes("findPeriodWithActivity"), "12. phải tự tìm kỳ CÓ dữ liệu, không ghim cứng một tháng trong mã");
    assert.ok(src.includes("gateVerdict"), "12. và phải in ra một kết luận cổng, không để người đọc tự suy");
  }

  console.log(
    "  ✓ Sẵn sàng production (lương): bù lỗ không áp lại từng đoạn (cắt kỳ KHÔNG đổi tiền) · kỳ đóng băng đọc bằng isFrozen · mốc hiệu lực không hở/không chồng/không lệch 1 ngày · phân công chồng lấn bị chặn · VND nguyên & làm tròn một lần & không `-0` · MKTer 6 bước + hoa hồng không tự trừ · chuỗi bù lỗ 4 tháng · 6 chính sách mẫu · chưa khai phân công thì NÓI RA thay vì trả 0đ im lặng · mọi cửa vào đều có cổng quyền · KHÔNG kết luận “khớp” trên dữ liệu rỗng · script đối chiếu fail-closed và chứng minh không ghi",
  );
}

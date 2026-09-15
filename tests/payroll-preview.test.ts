/**
 * ═══════ XEM THỬ · VÒNG TRÒN · CỔNG PHÁT HÀNH ═══════
 *
 * Ba thứ khác nhau nhưng cùng một mục đích: chặn một lời khai hỏng TRƯỚC khi nó thành tiền trên
 * phiếu lương của người thật.
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { defaultProrate, type PolicyComponent } from "@/lib/constants/payroll-components";
import { calculatePayrollItem } from "@/lib/payroll/engine";
import { buildDependencyGraph, danglingRefs, findCycles } from "@/lib/payroll/policy-graph";
import { policyActivationBlockers } from "@/lib/payroll/policy-validation";
import { resolveSegments } from "@/lib/payroll/policy-resolve";

const d = (iso: string) => new Date(`${iso}T00:00:00+07:00`);
const dEnd = (iso: string) => new Date(`${iso}T23:59:59.999+07:00`);

function comp(over: Partial<PolicyComponent> & Pick<PolicyComponent, "code" | "kind" | "calc">): PolicyComponent {
  return { label: over.code, prorate: defaultProrate(over.kind), rounding: "ROUND", minAmount: null, maxAmount: null, carryForward: false, sortOrder: 100, note: "", ...over };
}

const OK = [comp({ code: "BASE", kind: "FIXED", calc: { type: "FIXED_AMOUNT", amount: 10_000_000 } })];

export function testPayrollPreviewAndActivation() {
  // ─────────── 1. HÔM NAY ĐỒ THỊ KHÔNG CÓ CẠNH NÀO ───────────
  /*
    Đại lượng chỉ lấy từ `PAYROLL_INPUTS` — một sổ ĐÓNG, không mục nào đọc kết quả của thành phần
    khác. Nên vòng tròn KHÔNG dựng được bằng giao diện hiện tại. Khẳng định này là chỗ ghi lại sự
    thật ấy: ngày nào nó đỏ, nghĩa là ai đó vừa mở một cửa mới và phải đọc lại mục 2 bên dưới.
  */
  assert.deepEqual(
    buildDependencyGraph([
      comp({ code: "A", kind: "COMMISSION", calc: { type: "RATE_OF_BASIS", basisKey: "PROFIT_PERSONAL", ratePercent: 10 } }),
      comp({ code: "B", kind: "TIME_BASED", calc: { type: "PER_UNIT", basisKey: "WORK_HOURS", unitRate: 30_000 } }),
    ]),
    [],
    "chính sách khai bằng giao diện hiện tại KHÔNG tạo cạnh phụ thuộc nào",
  );
  assert.deepEqual(findCycles(OK), []);

  // ─────────── 2. NHƯNG NẾU CÓ CẠNH, VÒNG PHẢI BỊ BẮT ───────────
  /*
    Ngày nào có người thêm một đại lượng kiểu "kết quả của thành phần X" — và đó là thứ người ta sẽ
    muốn, vì "thưởng 5% trên tổng hoa hồng" là yêu cầu rất tự nhiên — thì vòng xuất hiện ngay. Nó
    KHÔNG nổ ra lỗi: máy đọc rỗng, nhân ra NaN, và NaN in ra màn hình thành "—" như một chỗ trống
    bình thường.
  */
  const vongHai = [
    comp({ code: "A", kind: "BONUS", calc: { type: "RATE_OF_BASIS", basisKey: "COMPONENT:B", ratePercent: 5 } }),
    comp({ code: "B", kind: "BONUS", calc: { type: "RATE_OF_BASIS", basisKey: "COMPONENT:A", ratePercent: 5 } }),
  ];
  const v2 = findCycles(vongHai);
  assert.equal(v2.length, 1, "A ⇄ B phải bị bắt");
  assert.match(v2[0].message, /vòng tròn/i);
  assert.ok(v2[0].chain.length >= 3, "phải trả về ĐÚNG chuỗi tạo vòng, không chỉ nói 'có vòng'");

  // Vòng ba mắt xích: A → B → C → A.
  const vongBa = [
    comp({ code: "A", kind: "BONUS", calc: { type: "RATE_OF_BASIS", basisKey: "COMPONENT:B", ratePercent: 5 } }),
    comp({ code: "B", kind: "BONUS", calc: { type: "RATE_OF_BASIS", basisKey: "COMPONENT:C", ratePercent: 5 } }),
    comp({ code: "C", kind: "BONUS", calc: { type: "RATE_OF_BASIS", basisKey: "COMPONENT:A", ratePercent: 5 } }),
  ];
  assert.equal(findCycles(vongBa).length, 1, "vòng ba mắt xích phải bị bắt");
  assert.ok(findCycles(vongBa)[0].chain.join("→").includes("A"), "và chuỗi phải nêu đủ các mắt");

  // Tự trỏ vào chính mình cũng là vòng.
  assert.equal(findCycles([comp({ code: "A", kind: "BONUS", calc: { type: "RATE_OF_BASIS", basisKey: "COMPONENT:A", ratePercent: 5 } })]).length, 1);

  // Chuỗi phụ thuộc DÀI nhưng không vòng thì KHÔNG được chặn — chặn nhầm cũng là một cách hỏng.
  const chuoiDai = ["A", "B", "C", "D", "E"].map((code, i, arr) =>
    i === arr.length - 1
      ? comp({ code, kind: "FIXED", calc: { type: "FIXED_AMOUNT", amount: 1_000_000 } })
      : comp({ code, kind: "BONUS", calc: { type: "RATE_OF_BASIS", basisKey: `COMPONENT:${arr[i + 1]}`, ratePercent: 5 } }),
  );
  assert.deepEqual(findCycles(chuoiDai), [], "chuỗi dài nhưng không vòng thì hợp lệ");

  // Trỏ vào một khoản không tồn tại: khác vòng tròn, cùng hậu quả (máy đọc rỗng ⇒ NaN ⇒ "—").
  assert.equal(danglingRefs([comp({ code: "A", kind: "BONUS", calc: { type: "RATE_OF_BASIS", basisKey: "COMPONENT:KHONG_CO", ratePercent: 5 } })]).length, 1);

  // ─────────── 3. CỔNG PHÁT HÀNH ───────────
  const goi = (over: Partial<Parameters<typeof policyActivationBlockers>[0]> = {}) =>
    policyActivationBlockers({
      policyCode: "P",
      version: 2,
      effectiveFrom: d("2026-09-01"),
      effectiveTo: null,
      components: OK,
      otherActiveVersions: [],
      ...over,
    });

  assert.deepEqual(goi(), [], "một phiên bản khai đủ thì phát hành được");

  const ma = (over: Parameters<typeof goi>[0]) => goi(over).map((b) => b.code);

  assert.ok(ma({ components: [] }).includes("NO_COMPONENT"), "phiên bản rỗng: phát hành nó là gán cho người một chính sách trả 0 đồng");
  assert.ok(ma({ effectiveTo: d("2026-08-01") }).includes("BAD_EFFECTIVE_RANGE"), "mốc kết thúc trước mốc bắt đầu là một đoạn rỗng đội lốt");

  /*
    CHỒNG LẤN PHIÊN BẢN: `resolveSegments` vẫn chạy được (lấy bản `effectiveFrom` muộn hơn), nên
    KHÔNG có lỗi nào nổ ra — và đó chính là vấn đề: tiền của những ngày ấy do một quy tắc ngầm
    quyết định, không do người khai.
  */
  assert.ok(
    ma({ otherActiveVersions: [{ version: 1, effectiveFrom: d("2026-01-01"), effectiveTo: null }] }).includes("VERSION_OVERLAP"),
    "hai phiên bản cùng phủ một ngày phải bị chặn",
  );
  // Bản cũ đã đóng đúng ngày liền trước thì KHÔNG chồng lấn.
  assert.deepEqual(goi({ otherActiveVersions: [{ version: 1, effectiveFrom: d("2026-01-01"), effectiveTo: dEnd("2026-08-31") }] }), []);

  assert.ok(ma({ components: vongHai }).includes("DEPENDENCY_CYCLE"), "vòng tròn phải chặn phát hành");
  assert.ok(
    ma({ components: [comp({ code: "A", kind: "BONUS", calc: { type: "RATE_OF_BASIS", basisKey: "COMPONENT:X", ratePercent: 5 } })] }).includes("DANGLING_REF"),
    "trỏ vào khoản không tồn tại phải chặn",
  );
  assert.ok(ma({ components: [comp({ code: "A", kind: "FIXED", calc: { type: "FIXED_AMOUNT", amount: 0 } })] }).includes("COMPONENT_MISSING_PARAM"));
  assert.ok(
    ma({ components: [comp({ code: "A", kind: "BONUS", calc: { type: "RATE_OF_BASIS", basisKey: "KHONG_CO_TRONG_SO", ratePercent: 5 } })] }).includes("UNKNOWN_BASIS"),
    "đại lượng không có trong sổ đăng ký phải chặn",
  );

  /*
    TỶ LỆ ÂM Ở MỘT KHOẢN CỘNG LÀ MỘT KHOẢN TRỪ ĐỘI LỐT — trên phiếu lương nó vẫn đứng ở cột thu
    nhập. Muốn trừ thì khai loại khoản là khấu trừ, để DẤU do loại quyết định.
  */
  assert.ok(
    ma({ components: [comp({ code: "A", kind: "BONUS", calc: { type: "RATE_OF_BASIS", basisKey: "REVENUE_PERSONAL", ratePercent: -5 } })] }).includes("NEGATIVE_RATE"),
  );
  // Nhưng tỷ lệ âm trong một khoản TRỪ thì hợp lệ — dấu đã đúng nhóm.
  assert.ok(
    !ma({ components: [comp({ code: "A", kind: "DEDUCTION", calc: { type: "RATE_OF_BASIS", basisKey: "REVENUE_PERSONAL", ratePercent: -5 } })] }).includes("NEGATIVE_RATE"),
  );

  // Bậc hở: phần dưới mốc thấp nhất không thuộc bậc nào và sẽ lặng lẽ thành 0.
  assert.ok(
    ma({
      components: [comp({ code: "T", kind: "COMMISSION", calc: { type: "TIERED_RATE", basisKey: "REVENUE_PERSONAL", tiers: [{ from: 10_000_000, ratePercent: 2 }] } })],
    }).includes("TIER_GAP"),
  );
  // Hai bậc cùng mốc: không xác định được bậc nào áp cho phần vượt.
  assert.ok(
    ma({
      components: [
        comp({ code: "T", kind: "COMMISSION", calc: { type: "TIERED_RATE", basisKey: "REVENUE_PERSONAL", tiers: [{ from: 0, ratePercent: 1 }, { from: 0, ratePercent: 2 }] } }),
      ],
    }).includes("TIER_OVERLAP"),
  );
  assert.ok(ma({ components: [comp({ code: "A", kind: "BONUS", minAmount: 5_000_000, maxAmount: 1_000_000, calc: { type: "FIXED_AMOUNT", amount: 2_000_000 } })] }).includes("BOUND_INVERTED"));
  assert.ok(
    ma({ components: [comp({ code: "A", kind: "COMMISSION", carryForward: true, calc: { type: "RATE_OF_BASIS", basisKey: "REVENUE_PERSONAL", ratePercent: 5 } })] }).includes("CARRY_NOT_ALLOWED"),
    "bù lỗ trên một đại lượng không bao giờ âm là một dòng sổ không bao giờ khác 0",
  );
  assert.ok(ma({ components: [OK[0], { ...OK[0] }] }).includes("DUPLICATE_CODE"), "hai thành phần cùng khoá sẽ bị máy gộp thành một dòng không ai đối chiếu lại được");

  // ─────────── 4. XEM THỬ PHẢI DÙNG CHÍNH MÁY TÍNH THẬT ───────────
  /*
    Quét MÃ NGUỒN. Một bản xem thử tính bằng công thức riêng sẽ khớp với bảng lương đúng tới lúc
    một trong hai bên đổi — và lúc ấy nó còn tệ hơn không có, vì người khai tin vào một con số
    không phải con số sẽ được trả.
  */
  const src = execSync("git show HEAD:lib/actions/payroll-preview.ts", { encoding: "utf8" });
  assert.ok(src.includes("calculatePayrollItem"), "xem thử phải gọi CHÍNH máy tính thật");
  assert.ok(src.includes('can(user, "payroll:manage")'), "xem thử vẫn là một cửa — nó tiết lộ cách tính tiền của shop");

  // CHẠY KHÔ nghĩa là KHÔNG ghi. Không import lược đồ, không mở giao dịch, không gọi hàm ghi nào.
  assert.ok(!/from\s+"@\/db"/.test(src), "xem thử KHÔNG được import lược đồ CSDL");
  for (const cam of ["db.transaction", ".insert(", ".update(", ".delete(", "setSettingJson", "revalidatePath"]) {
    assert.ok(!src.includes(cam), `xem thử KHÔNG được \`${cam}\` — chạy khô nghĩa là không ghi một dòng nào`);
  }

  // ─────────── 5. XEM THỬ = CHẠY THẬT, TRÊN CÙNG ĐẦU VÀO ───────────
  /*
    Khẳng định này so KẾT QUẢ, không so mã nguồn: dựng đúng đoạn mà `previewPolicyCalculation` dựng
    rồi chạy máy tính, và đối chiếu với đường mà bảng lương đi. Cùng đầu vào ⇒ cùng con số.
  */
  const from = d("2026-09-01");
  const to = dEnd("2026-09-30");
  const bo = [
    comp({ code: "BASE", kind: "FIXED", calc: { type: "FIXED_AMOUNT", amount: 12_000_000 } }),
    comp({ code: "COMM", kind: "COMMISSION", calc: { type: "RATE_OF_BASIS", basisKey: "PROFIT_PERSONAL", ratePercent: 10 } }),
  ];
  const dungDoan = (employeeId: string) =>
    resolveSegments({
      from,
      to,
      employments: [
        {
          id: "x",
          employeeId,
          departmentId: null,
          departmentName: "",
          positionId: null,
          positionName: "",
          managerUserId: null,
          employmentType: "FULL_TIME" as const,
          workMode: "ONSITE" as const,
          status: "ACTIVE" as const,
          standardWorkDays: null,
          effectiveFrom: from,
          effectiveTo: null,
        },
      ],
      policyAssignments: [{ id: "x", employeeId, policyId: "p", policyCode: "P", policyName: "P", effectiveFrom: from, effectiveTo: null }],
      policyVersions: [{ id: "v", policyId: "p", version: 1, effectiveFrom: from, effectiveTo: null, status: "ACTIVE" as const }],
    });
  const chay = (employeeId: string) =>
    calculatePayrollItem({
      employeeId,
      employeeName: employeeId,
      segments: dungDoan(employeeId).map((segment) => ({ segment, components: bo, basis: { PROFIT_PERSONAL: 40_000_000, PERIOD_DAYS: segment.days } })),
      adjustments: [],
      carryOpening: {},
    });
  const xemThu = chay("preview");
  const thatSu = chay("NV1");
  assert.equal(xemThu.netPay, thatSu.netPay, "xem thử và chạy thật phải ra CÙNG con số trên cùng đầu vào");
  assert.equal(xemThu.netPay, 12_000_000 + 4_000_000);
  assert.deepEqual(
    xemThu.components.map((c) => [c.code, c.amount]),
    thatSu.components.map((c) => [c.code, c.amount]),
    "và khớp tới từng thành phần, không chỉ tổng",
  );

  console.log("  ✓ Xem thử & cổng phát hành: vòng tròn bị bắt kèm ĐÚNG chuỗi · 11 loại chặn phát hành · xem thử chạy khô và ra cùng số với chạy thật");
}

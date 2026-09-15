/**
 * ═══════ CƠ SỞ TÍNH LƯƠNG KHÔNG TỰ TRỪ CHÍNH NÓ — NĂM CA SỐ HỌC ═══════
 *
 * Bộ này khoá phép số học mà mọi lời giải thích kiến trúc ở trên phải quy về. Nếu một ngày ai đó
 * "tối ưu" bằng cách cho hoa hồng trừ vào cơ sở của chính nó, con số sẽ không nổ ra lỗi — nó chỉ
 * nhỏ dần mỗi lần tính lại, và không ai thấy cho tới lúc có người hỏi vì sao lương giảm.
 *
 * Ca gốc là 100 / 60 / 10%. Ở đây nhân lên thang VND thật (100tr / 60tr) vì hai lý do, và cả hai
 * đều là bài học từ chính lần viết bài kiểm này:
 *
 *   · tiền trong ERP là SỐ NGUYÊN VND (AGENTS.md mục 1), nên đo ở thang 40 đồng là đo một thứ
 *     không tồn tại;
 *   · ở thang nhỏ, điểm bất động 40 × 0,1 / 1,1 = 3,636 làm tròn thành 4 — TRÙNG với đáp án đúng.
 *     Một bài kiểm không phân biệt được đúng với sai là một bài kiểm không canh gì cả.
 *
 * Thang VND:
 *
 *     ĐÚNG : cơ sở = 40.000.000 · hoa hồng = 4.000.000 · kế toán = 36.000.000
 *     SAI  : hoa hồng = 10% × (40tr − hoa hồng) ⇒ 3.636.364 — điểm bất động của một vòng lặp
 */
import assert from "node:assert/strict";
import { accountingProfitAfterCompensation } from "@/lib/queries/compensation-basis";
import { COMPENSATION_PROFIT_RULES } from "@/lib/constants/compensation-profit";
import { calculatePayrollItem } from "@/lib/payroll/engine";
import { resolveSegments, type EmploymentRow, type PolicyAssignmentRow, type PolicyVersionRow } from "@/lib/payroll/policy-resolve";
import { defaultProrate, type PolicyComponent } from "@/lib/constants/payroll-components";

const d = (iso: string) => new Date(`${iso}T00:00:00+07:00`);
const dEnd = (iso: string) => new Date(`${iso}T23:59:59.999+07:00`);
const KY = { from: d("2026-09-01"), to: dEnd("2026-09-30") };

const emp: EmploymentRow = {
  id: "e1",
  employeeId: "NV1",
  departmentId: null,
  departmentName: "",
  positionId: null,
  positionName: "",
  managerUserId: null,
  employmentType: "FULL_TIME",
  workMode: "ONSITE",
  status: "ACTIVE",
  standardWorkDays: null,
  effectiveFrom: d("2026-01-01"),
  effectiveTo: null,
};
const gan: PolicyAssignmentRow = { id: "a1", employeeId: "NV1", policyId: "P1", policyCode: "P", policyName: "P", effectiveFrom: d("2026-01-01"), effectiveTo: null };
const ban: PolicyVersionRow = { id: "v1", policyId: "P1", version: 1, effectiveFrom: d("2026-01-01"), effectiveTo: null, status: "ACTIVE" };

function comp(over: Partial<PolicyComponent> & Pick<PolicyComponent, "code" | "kind" | "calc">): PolicyComponent {
  return { label: over.code, prorate: defaultProrate(over.kind), rounding: "ROUND", minAmount: null, maxAmount: null, carryForward: false, sortOrder: 100, note: "", ...over };
}

/** Chạy máy tính thật trên một cơ sở cho trước. Không mô phỏng lại phép nhân nào. */
function hoaHong(coSo: number, tyLe: number, carryOpening: number | null = null, bu = false) {
  const segs = resolveSegments({ ...KY, employments: [emp], policyAssignments: [gan], policyVersions: [ban] });
  const c = comp({ code: "COMM", kind: "COMMISSION", carryForward: bu, calc: { type: "RATE_OF_BASIS", basisKey: "PROFIT_PERSONAL", ratePercent: tyLe } });
  return calculatePayrollItem({
    employeeId: "NV1",
    employeeName: "A",
    segments: segs.map((segment) => ({ segment, components: [c], basis: { PROFIT_PERSONAL: coSo } })),
    adjustments: [],
    carryOpening: { COMM: carryOpening },
  });
}

export function testCompensationBasisArithmetic() {
  // ─────────── CA A · CƠ SỞ 40, TỶ LỆ 10% ⇒ HOA HỒNG ĐÚNG 4 ───────────
  {
    const doanhThu = 100_000_000;
    const chiPhiKhongKeHoaHong = 60_000_000;
    const coSo = doanhThu - chiPhiKhongKeHoaHong;
    assert.equal(coSo, 40_000_000, "cơ sở = doanh thu − chi phí KHÔNG kể thù lao biến đổi");

    const r = hoaHong(coSo, 10);
    assert.equal(r.netPay, 4_000_000, "hoa hồng = 10% × 40tr = 4tr");
    /*
      Điểm bất động của vòng lặp là 40tr × 0,1 / 1,1 = 3.636.364. Khẳng định này chặn đúng cái đó
      bằng một con số cụ thể, không bằng một lời hứa kiến trúc.
    */
    const diemBatDong = Math.round((coSo * 0.1) / 1.1);
    assert.equal(diemBatDong, 3_636_364, "điểm bất động của ca hỏng");
    assert.notEqual(r.netPay, diemBatDong, "KHÔNG được ra điểm bất động — đó là dấu hiệu hoa hồng đang tự trừ khỏi cơ sở của nó");
  }

  // ─────────── CA B · LỢI NHUẬN KẾ TOÁN = 40 − 4 = 36 ───────────
  {
    assert.equal(accountingProfitAfterCompensation(40_000_000, 4_000_000), 36_000_000);
    // CHƯA BIẾT hoa hồng ⇒ CHƯA BIẾT lợi nhuận kế toán. Không được đọc thành "bằng cơ sở".
    assert.equal(accountingProfitAfterCompensation(40_000_000, null), null, "hoa hồng chưa biết ⇒ lợi nhuận kế toán chưa biết, không phải 40tr");
  }

  // ─────────── CA C · TÍNH LẠI NHIỀU LẦN VẪN LÀ 4 ───────────
  {
    /*
      Đây là ca mà một vòng lặp ẩn lộ ra rõ nhất: nó không nổ ra lỗi, nó chỉ làm con số NHỎ DẦN —
      4 → 3,6 → 3,24 … Mỗi lượt mở trang là một lượt trừ thêm.
    */
    const lan = [0, 1, 2, 3, 4].map(() => hoaHong(40_000_000, 10).netPay);
    assert.deepEqual(lan, [4_000_000, 4_000_000, 4_000_000, 4_000_000, 4_000_000], "tính lại năm lần vẫn đúng 4tr — không nhỏ dần");

    // Và nếu ai đó thật sự trừ hoa hồng khỏi cơ sở, chuỗi sẽ nhỏ dần. Chứng minh ca hỏng tồn tại.
    let coSoHong = 40_000_000;
    const chuoiHong: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const h = Math.round(coSoHong * 0.1);
      chuoiHong.push(h);
      coSoHong -= h;
    }
    assert.deepEqual(chuoiHong, [4_000_000, 3_600_000, 3_240_000], "ca hỏng CÓ THẬT: trừ hoa hồng khỏi cơ sở thì con số nhỏ dần qua mỗi lượt");
  }

  // ─────────── CA D · BÁO CÁO CHI PHÍ HIỆN HOA HỒNG, CƠ SỞ KHÔNG ĐỔI ───────────
  {
    /*
      Sau khi bảng lương tính xong, hoa hồng 4 là một khoản chi có thật và báo cáo kế toán phải
      hiện nó. Việc ấy KHÔNG được làm cơ sở đổi — nếu không, lượt tính sau lại ra số khác.
    */
    assert.equal(COMPENSATION_PROFIT_RULES.COMMISSION.included, false, "hoa hồng nằm NGOÀI cơ sở theo lời khai");
    assert.equal(COMPENSATION_PROFIT_RULES.COMMISSION.dependsOnCompensation, true);
    const coSoSauKhiBietHoaHong = 100_000_000 - 60_000_000; // chi phí không kể hoa hồng KHÔNG đổi
    assert.equal(coSoSauKhiBietHoaHong, 40_000_000, "biết hoa hồng rồi thì cơ sở VẪN là 40tr");
    assert.equal(hoaHong(coSoSauKhiBietHoaHong, 10).netPay, 4_000_000, "và lượt tính sau vẫn ra 4tr");
    assert.equal(accountingProfitAfterCompensation(40_000_000, 4_000_000), 36_000_000, "chỉ lợi nhuận KẾ TOÁN đổi, và nó là con số khác tên");
  }

  // ─────────── CA E · HAI THÀNH PHẦN CÙNG LẤY MỘT CƠ SỞ, KHÔNG TỰ TRỪ LẪN NHAU ───────────
  {
    /*
      Hai khoản thù lao biến đổi trên cùng một người: hoa hồng 10% và chia lợi nhuận 5%. Cả hai
      đứng trên CÙNG cơ sở 40 ⇒ 4 và 2. Nếu khoản thứ hai lấy cơ sở đã trừ khoản thứ nhất (36 × 5%
      = 1,8) thì thứ tự khai trong chính sách quyết định số tiền — một luật không ai khai ở đâu cả.

      Muốn có phụ thuộc tuần tự thì chính sách phải nói ra; máy KHÔNG tự suy.
    */
    const segs = resolveSegments({ ...KY, employments: [emp], policyAssignments: [gan], policyVersions: [ban] });
    const r = calculatePayrollItem({
      employeeId: "NV1",
      employeeName: "A",
      segments: segs.map((segment) => ({
        segment,
        components: [
          comp({ code: "COMM", kind: "COMMISSION", calc: { type: "RATE_OF_BASIS", basisKey: "PROFIT_PERSONAL", ratePercent: 10 }, sortOrder: 10 }),
          comp({ code: "SHARE", kind: "PROFIT_SHARE", calc: { type: "RATE_OF_BASIS", basisKey: "PROFIT_PERSONAL", ratePercent: 5 }, sortOrder: 20 }),
        ],
        basis: { PROFIT_PERSONAL: 40_000_000 },
      })),
      adjustments: [],
      carryOpening: {},
    });
    assert.equal(r.components.find((c) => c.code === "COMM")?.amount, 4_000_000);
    assert.equal(r.components.find((c) => c.code === "SHARE")?.amount, 2_000_000, "khoản thứ hai đứng trên CÙNG cơ sở 40tr, không phải trên 36tr");
    assert.equal(r.netPay, 6_000_000);

    // Đảo thứ tự khai KHÔNG được làm đổi một đồng nào.
    const daoThuTu = calculatePayrollItem({
      employeeId: "NV1",
      employeeName: "A",
      segments: segs.map((segment) => ({
        segment,
        components: [
          comp({ code: "SHARE", kind: "PROFIT_SHARE", calc: { type: "RATE_OF_BASIS", basisKey: "PROFIT_PERSONAL", ratePercent: 5 }, sortOrder: 10 }),
          comp({ code: "COMM", kind: "COMMISSION", calc: { type: "RATE_OF_BASIS", basisKey: "PROFIT_PERSONAL", ratePercent: 10 }, sortOrder: 20 }),
        ],
        basis: { PROFIT_PERSONAL: 40_000_000 },
      })),
      adjustments: [],
      carryOpening: {},
    });
    assert.equal(daoThuTu.netPay, r.netPay, "đảo thứ tự khai không đổi số tiền — nếu đổi thì thứ tự dòng đang là một luật ngầm");
  }

  // ─────────── BÙ LỖ ĐỨNG TRÊN CƠ SỞ, KHÔNG TRÊN SỐ ĐÃ TRỪ HOA HỒNG ───────────
  {
    const r = hoaHong(40_000_000, 10, -10_000_000, true);
    assert.equal(r.components[0].carry?.commissionBase, 30_000_000, "bù lỗ trừ vào CƠ SỞ (40tr − 10tr), không trừ vào số đã trừ hoa hồng");
    assert.equal(r.netPay, 3_000_000, "10% × 30tr");
    assert.equal(accountingProfitAfterCompensation(40_000_000, 3_000_000), 37_000_000);
  }

  console.log("  ✓ Cơ sở tính lương: 40tr → hoa hồng 4tr → kế toán 36tr (KHÔNG ra điểm bất động 3.636.364) · tính lại năm lần vẫn 4tr · hai thành phần cùng một cơ sở · đảo thứ tự không đổi tiền");
}

/**
 * ═══════ CHIỀU PHỤ THUỘC GIỮA CHI PHÍ VÀ LƯƠNG — MỘT CHIỀU, VÀ CÓ NGƯỜI CANH ═══════
 *
 * ─── SỰ THẬT PHẢI NÓI TRƯỚC ───
 *
 * Bản ghi chép ngày 15/09 nói có vòng gọi hàm
 * `getOperatingCost → payroll-cost → getPayrollReport → getMarketerReport → getOperatingCost`.
 * Đọc lại mã nguồn thì KHÔNG có vòng ấy ở mức chạy: `payroll-cost.ts` chỉ đọc `settings`. Lời mô
 * tả ấy sai, và bài kiểm này là chỗ sửa nó thành một sự thật KIỂM ĐƯỢC thay vì một câu khẳng định.
 *
 * Vòng ấy là vòng SẼ xuất hiện nếu ai đó đi tính hoa hồng bằng cách gọi ngược bảng lương. Đây là
 * cái bẫy, và bộ này canh đúng cái bẫy đó — quét MÃ NGUỒN chứ không chạy, vì một vòng đệ quy chỉ
 * lộ ra lúc chạy thì nó đã treo một yêu cầu thật của người dùng rồi.
 *
 * Chiều đúng, và mũi tên chỉ đi một chiều:
 *
 *     nguồn → chi phí → CƠ SỞ TÍNH LƯƠNG → máy lương → thù lao biến đổi → KẾ TOÁN
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";

/** Đọc mã ĐÃ VÀO KHO, không đọc đĩa — cùng cách `tests/repo-integrity.test.ts` làm. */
function nguon(path: string): string {
  return execSync(`git show HEAD:${path}`, { encoding: "utf8" });
}

/**
 * BỎ CHÚ THÍCH TRƯỚC KHI QUÉT.
 *
 * Mấy tệp này GIẢI THÍCH vì sao chúng không gọi ngược, nên tên hàm bị cấm xuất hiện đầy trong chú
 * thích. Bản đầu của bài kiểm chỉ bỏ những dòng BẮT ĐẦU bằng `*` / `//`, nên nó vẫn đọc trúng các
 * dòng NỐI TIẾP bên trong một khối `/* … *\/` và báo nhầm.
 *
 * Bỏ cả khối thay vì bỏ từng dòng: một bài kiểm báo nhầm là một bài kiểm người ta sẽ tắt.
 */
function boChuThich(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Các định danh mà một tệp ở TẦNG DƯỚI tuyệt đối không được nhắc tới. */
const CAM_GOI_NGUOC = ["getPayrollReport", "getMarketerReport", "calculatePayrollItem", "carryoverMonth", "solveCommissionWithCarryover"];

export function testPayrollDependencyDirection() {
  // ─────────── 1. TẦNG CHI PHÍ KHÔNG ĐƯỢC BIẾT GÌ VỀ BẢNG LƯƠNG ───────────
  /*
    Ba tệp này đứng DƯỚI bảng lương trong cây phụ thuộc. Một lời gọi ngược từ đây là một vòng đệ
    quy — và nó sẽ không nổ ra ở kiểm thử đơn vị, nó sẽ treo một yêu cầu thật trên production.
  */
  for (const tep of ["lib/queries/payroll-cost.ts", "lib/queries/cost-engine.ts", "lib/queries/compensation-basis.ts"]) {
    const src = nguon(tep);
    for (const ten of CAM_GOI_NGUOC) {
      // Cho phép nhắc trong CHÚ THÍCH (các tệp này giải thích vì sao không gọi), cấm trong MÃ.
      const khongPhaiChuThich = boChuThich(src);
      assert.ok(
        !khongPhaiChuThich.includes(ten),
        `${tep} gọi \`${ten}\` — đó là một lời gọi NGƯỢC từ tầng chi phí lên tầng lương, và nó tạo đệ quy vô hạn. Chi phí phải đứng DƯỚI lương, không bao giờ trên.`,
      );
    }
    assert.ok(!src.includes('from "@/lib/queries/payroll"'), `${tep} import từ \`lib/queries/payroll\` — sai chiều phụ thuộc`);
  }

  // ─────────── 2. TẦNG CƠ SỞ CHỈ ĐƯỢC ĐỌC MÁY CHI PHÍ, KHÔNG DỰNG NGUỒN THỨ HAI ───────────
  /*
    `getOperatingCostForCompensationBasis` phải DẪN XUẤT từ `getRecognizedCosts`, không tự truy vấn
    lại `expenses`/`shipments`. Một nguồn thứ hai cho cùng một khoản chi là hai con số sẽ lệch nhau
    (AGENTS.md mục 18 — một đường duy nhất).
  */
  const coSo = nguon("lib/queries/compensation-basis.ts");
  assert.ok(coSo.includes("getRecognizedCosts"), "tầng cơ sở phải đọc từ máy chi phí chung");
  assert.ok(!coSo.includes("getDb()"), "tầng cơ sở KHÔNG được tự mở truy vấn — nó dẫn xuất, không phải một nguồn thứ hai");
  assert.ok(!/from\s+"@\/db"/.test(coSo), "tầng cơ sở không được import lược đồ CSDL");

  // ─────────── 3. BẢNG LƯƠNG PHẢI DÙNG NỀN ĐÃ TRỪ THÙ LAO BIẾN ĐỔI ───────────
  /*
    Đây là lỗi tiền THẬT đang chạy trước bản này: `getOperatingCost()` trả TỔNG khối vận hành, và
    khối ấy bao gồm hoa hồng. Con số ấy đi vào lợi nhuận từng mã rồi thành cơ sở tính hoa hồng —
    nên hoa hồng của kỳ TRƯỚC làm giảm cơ sở của kỳ NÀY.
  */
  const luong = nguon("lib/queries/payroll.ts");
  assert.ok(luong.includes("getOperatingCostForCompensationBasis(period)"), "bảng lương phải dựng cơ sở bằng nền đã trừ thù lao biến đổi");
  const macGoi = boChuThich(luong)
    .split("\n")
    .filter((d) => /\bgetOperatingCost\(/.test(d) && !d.includes("ForCompensationBasis"));
  assert.deepEqual(macGoi, [], "bảng lương KHÔNG được dùng tổng khối vận hành làm cơ sở — tổng ấy có hoa hồng bên trong");

  // ─────────── 4. LỢI NHUẬN KẾ TOÁN TÍNH Ở TẦNG SAU, KHÔNG Ở TẦNG CHI PHÍ ───────────
  assert.ok(
    !boChuThich(coSo).includes("accountingProfit ="),
    "lợi nhuận kế toán KHÔNG được tính trong tầng chi phí: nó cần con số hoa hồng, mà hoa hồng lại cần tầng chi phí",
  );
  assert.ok(luong.includes("accountingProfitAfterCompensation"), "lợi nhuận kế toán tính ở tầng SAU bảng lương");

  // ─────────── 5. KHÔNG LỌC BẰNG Ô CHỮ ───────────
  /*
    "description NOT LIKE '%commission%'" là cách phân loại bằng chữ người gõ. Đổi một chữ hoa là
    một khoản tiền đổi loại, và không ai thấy. Phân loại phải đi bằng KHOÁ khai sẵn.
  */
  for (const tep of ["lib/queries/compensation-basis.ts", "lib/queries/cost-engine.ts", "lib/queries/payroll-cost.ts"]) {
    const src = nguon(tep);
    assert.ok(!/like\s+'%.*(commission|hoa hồng|thưởng)/i.test(boChuThich(src)), `${tep} phân loại chi phí bằng ô CHỮ — đổi một chữ hoa là một khoản tiền đổi loại`);
  }
  assert.ok(coSo.includes("COMPENSATION_PROFIT_RULES"), "loại khoản nào ra khỏi cơ sở phải đọc từ SỔ KHAI, không gõ tên");

  console.log("  ✓ Chiều phụ thuộc: chi phí đứng DƯỚI lương · tầng cơ sở dẫn xuất chứ không dựng nguồn thứ hai · kế toán tính ở tầng sau · không phân loại bằng ô chữ");
}

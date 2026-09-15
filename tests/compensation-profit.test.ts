/**
 * ═══════ CƠ SỞ LỢI NHUẬN TÍNH LƯƠNG — KHÔNG VÒNG TRÒN, KHÔNG BỎ SÓT ═══════
 *
 * Bộ này khoá LỜI KHAI ở `lib/constants/compensation-profit.ts`. Nó không đo tiền; nó chặn đúng
 * hai cách hỏng mà một sổ khai như thế có thể mắc:
 *
 *  1. **Vòng tròn** — một khoản là hàm của cơ sở mà lại nằm trong cơ sở. Không có giá trị nào thoả,
 *     và mọi cách "giải" đều là chọn một điểm dừng tuỳ tiện rồi gọi đó là kết quả.
 *  2. **Bỏ sót** — một thành phần chi phí thật không được khai. Cơ sở khi ấy cao hơn sự thật đúng
 *     bằng khoản bị bỏ sót, không có gì báo, và đó là con số dùng để trả tiền.
 *
 * Hàm thuần, chạy bằng số viết tay, không cần CSDL.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COST_COMPONENTS } from "@/lib/constants/cost-authority";
import {
  assertNoCompensationCycle,
  COMPENSATION_EXCLUDED_COMPONENTS,
  COMPENSATION_INCLUDED_COMPONENTS,
  COMPENSATION_PROFIT_BASIS,
  COMPENSATION_PROFIT_RULES,
  compensationBasisViolations,
  VARIABLE_COMPENSATION_BASIS_KEYS,
} from "@/lib/constants/compensation-profit";
import { PAYROLL_INPUTS } from "@/lib/constants/payroll-components";

export function testCompensationProfitBasis() {
  // ─────────── 1. SỔ KHAI PHẢI NHẤT QUÁN VỚI CHÍNH NÓ ───────────
  assert.deepEqual(compensationBasisViolations(), [], "sổ cơ sở tính lương phải không có vi phạm nào");

  // ─────────── 2. KHAI ĐỦ MỌI THÀNH PHẦN CHI PHÍ ───────────
  for (const c of COST_COMPONENTS) {
    assert.ok(COMPENSATION_PROFIT_RULES[c], `thành phần chi phí “${c}” chưa khai trong sổ cơ sở tính lương`);
  }
  assert.equal(
    COMPENSATION_INCLUDED_COMPONENTS.length + COMPENSATION_EXCLUDED_COMPONENTS.length,
    COST_COMPONENTS.length,
    "mỗi thành phần phải thuộc đúng MỘT phía — trong hoặc ngoài cơ sở",
  );

  // ─────────── 3. ĐÚNG MỘT THỨ BỊ LOẠI, VÀ NÓ PHẢI LÀ HOA HỒNG ───────────
  /*
    Đây là ranh giới làm nên cái tên "trước thù lao biến đổi". Nếu một ngày có thêm thứ gì đó bị
    loại khỏi cơ sở, bài này đỏ — và đó là lúc phải hỏi: khoản chi thật ấy vì sao không được trừ
    vào cơ sở trả tiền cho người?
  */
  assert.deepEqual(COMPENSATION_EXCLUDED_COMPONENTS, ["COMMISSION"], "chỉ hoa hồng bị loại khỏi cơ sở, và vì nó là hàm của chính cơ sở");
  assert.equal(COMPENSATION_PROFIT_RULES.COMMISSION.dependsOnCompensation, true);
  assert.equal(COMPENSATION_PROFIT_RULES.COMMISSION.included, false);

  // ─────────── 4. LƯƠNG CỨNG PHẢI Ở TRONG ───────────
  /*
    Không phải vì nó nhỏ hơn — vì nó KHÔNG phải hàm của lợi nhuận: một con số khai theo tháng,
    tính được trước khi biết lợi nhuận. Loại nó ra là làm cơ sở trả tiền cao hơn sự thật đúng bằng
    quỹ lương, ở mọi kỳ.
  */
  assert.equal(COMPENSATION_PROFIT_RULES.SALARY.included, true, "lương cứng nằm TRONG cơ sở — nó không phụ thuộc vào lợi nhuận");
  assert.equal(COMPENSATION_PROFIT_RULES.SALARY.dependsOnCompensation, false);

  // ─────────── 5. MỘT SỔ KHAI HỎNG PHẢI BỊ BẮT ───────────
  const hong = { ...COMPENSATION_PROFIT_RULES, COMMISSION: { ...COMPENSATION_PROFIT_RULES.COMMISSION, included: true } };
  const viPham = compensationBasisViolations(hong);
  assert.ok(viPham.length > 0, "đưa hoa hồng vào cơ sở của chính nó PHẢI bị bắt");
  assert.match(viPham[0], /vòng tròn/i, "và lời báo phải nói đúng nó là vòng tròn");

  // ─────────── 6. KHÔNG ĐẠI LƯỢNG NÀO CỦA CHÍNH SÁCH ĐỌC TỪ BẢNG LƯƠNG ───────────
  /*
    Đây là điều làm vòng tròn KHÔNG THỂ xảy ra ở mức chính sách — và bài này biến nó từ một sự
    thật ngẫu nhiên thành một ràng buộc. Ngày nào có người thêm một đại lượng kiểu "chi phí nhân
    sự" vào sổ đầu vào rồi nối một thành phần lương vào đó, bài này đỏ ngay, chứ không đợi tới lúc
    một kỳ lương ra số vô nghĩa.
  */
  const doTuBangLuong = PAYROLL_INPUTS.filter((i) => /payroll|lương|salary|commission|hoa hồng/i.test(i.source) && /bảng lương/i.test(i.source)).map((i) => i.key);
  assert.deepEqual(doTuBangLuong, [], "không đại lượng nào trong sổ đầu vào được đọc từ chính bảng lương");

  const viPhamVong = assertNoCompensationCycle(
    [
      { code: "COMM", label: "Hoa hồng lợi nhuận", basisKey: "PROFIT_PERSONAL" },
      { code: "BASE", label: "Lương cứng", basisKey: null },
    ],
    doTuBangLuong,
  );
  assert.deepEqual(viPhamVong, [], "chính sách hiện có không tạo vòng tròn nào");

  // Và nếu có ngày một đại lượng như thế tồn tại, hàm phải bắt được.
  const gia = assertNoCompensationCycle([{ code: "X", label: "Thưởng theo quỹ lương", basisKey: "PAYROLL_COST" }], ["PAYROLL_COST"]);
  assert.equal(gia.length, 1, "thành phần tính trên một đại lượng đọc từ bảng lương PHẢI bị chặn");
  assert.match(gia[0], /đầu vào của chính nó/);

  // ─────────── 7. HAI ĐẠI LƯỢNG LỢI NHUẬN LÀ THÙ LAO BIẾN ĐỔI ───────────
  for (const k of VARIABLE_COMPENSATION_BASIS_KEYS) {
    assert.ok(PAYROLL_INPUTS.some((i) => i.key === k), `đại lượng “${k}” phải có thật trong sổ đầu vào`);
  }

  // ─────────── 8. `profit1` THÔI LÀ KHÁI NIỆM NGHIỆP VỤ ───────────
  /*
    Nó chỉ còn được phép xuất hiện như một giá trị TƯƠNG THÍCH: ở URL, ở ánh xạ, và ở
    `payroll_periods.basis` của các kỳ đã chốt (đổi giá trị lưu trữ là làm mồ côi chúng). Không
    màn hình nào được in chuỗi ấy ra cho người đọc.
  */
  const src = readFileSync("app/(dashboard)/payroll/page.tsx", "utf8");
  /*
    HAI LUẬT KHÁC NHAU CHO HAI CHUỖI, vì chúng có vai trò khác nhau:

     · `LN1` / `LN2` — KHÔNG có công dụng nào trong mã ngoài việc hiện ra cho người đọc. Cấm ở mọi
       chỗ, kể cả trong chú thích: một chú thích còn gọi nó là "LN1" là một chú thích sẽ dạy người
       sửa sau tiếp tục dùng cái tên ấy.
     · `profit1` / `profit2` — VẪN hợp lệ như GIÁ TRỊ tương thích (tham số URL, so sánh nhánh, khoá
       của `payroll_periods.basis` ở các kỳ đã chốt). Chỉ cấm khi nó nằm trong phần chữ hiện ra
       giữa hai thẻ JSX.
  */
  assert.ok(!/\bLN[12]\b/.test(src), "màn hình lương không được dùng tên `LN1`/`LN2` — nó không nói lên điều gì");
  const textJsx = [...src.matchAll(/>([^<>{}]{2,200})</g)].map((m) => m[1]);
  const loLot = textJsx.find((t) => /\bprofit[12]\b/.test(t));
  assert.ok(!loLot, `phần chữ hiện ra cho người đọc không được chứa \`profit1\`/\`profit2\`: ${loLot ?? ""}`);
  assert.equal(COMPENSATION_PROFIT_BASIS, "PRE_VARIABLE_COMPENSATION_PROFIT");

  console.log("  ✓ Cơ sở lợi nhuận tính lương: không vòng tròn · khai đủ 11 thành phần · chỉ hoa hồng bị loại và có lý do · lương cứng nằm trong");
}

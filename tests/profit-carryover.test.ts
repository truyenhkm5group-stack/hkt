/**
 * ═══════ LỖ LŨY KẾ THEO TỪNG MKTer — KIỂM THỬ PHÉP TÍNH THUẦN ═══════
 *
 * Mọi con số trong file này là con số CHỦ SHOP ĐƯA trong yêu cầu ngày 15/09/2026, không phải số tôi
 * tự nghĩ ra cho dễ xanh. Ca nào lệch thì code sai, không phải bài kiểm sai.
 */
import assert from "node:assert/strict";
import {
  carryoverChain,
  carryoverMonth,
  solveCommissionWithCarryover,
  solveShopPayroll,
} from "@/lib/payroll/profit-carryover";

const TR = 1_000_000;

export async function testProfitCarryover() {
  /* ── 1 · CHUỖI THÁNG 8 / 9 / 10 CỦA CHỦ SHOP: LN thực −10, +6, +9 triệu, tỷ lệ 10% ──
   *
   * Đây là ca gốc. Nếu `max(…, 0)` vẫn còn nuốt số âm thì tháng 10 sẽ trả hoa hồng trên đủ 9 triệu
   * (900.000đ) thay vì trên 5 triệu (500.000đ) — chênh đúng phần lỗ chưa bù.
   */
  const chuoi = carryoverChain(
    [
      { openingBalance: 0, realProfit: -10 * TR, commissionPercent: 10 },
      { openingBalance: 0, realProfit: 6 * TR, commissionPercent: 10 },
      { openingBalance: 0, realProfit: 9 * TR, commissionPercent: 10 },
    ],
    0,
  );
  assert.deepEqual(
    chuoi.map((r) => r.closingBalance),
    [-10 * TR, -4 * TR, 0],
    "1. lỗ chuyển tiếp phải là −10, −4, 0 triệu",
  );
  assert.deepEqual(
    chuoi.map((r) => r.commissionBase),
    [0, 0, 5 * TR],
    "1. cơ sở hoa hồng phải là 0, 0, 5 triệu — tháng 10 chỉ được tính trên phần VƯỢT lỗ",
  );
  assert.deepEqual(
    chuoi.map((r) => r.payableCommission),
    [0, 0, 500_000],
    "1. tiền hoa hồng phải trả: 0, 0, 500.000đ",
  );
  assert.deepEqual(
    chuoi.map((r) => r.signedCommission),
    [-1 * TR, -400_000, 500_000],
    "1. hoa hồng CÓ DẤU vẫn hiện số âm để theo dõi, dù tiền trả bằng 0",
  );
  // Số âm để theo dõi KHÔNG được cộng dồn thành một khoản nợ: −1 triệu và −0,4 triệu không thành
  // −1,4 triệu. Chỉ số dư LỢI NHUẬN mới chuyển kỳ.
  assert.equal(chuoi[1].closingBalance, -4 * TR, "1. số dư chuyển kỳ là đơn vị LỢI NHUẬN, không phải tiền hoa hồng cộng dồn");
  assert.deepEqual(
    chuoi.map((r) => r.lossApplied),
    [0, 6 * TR, 4 * TR],
    "1. phần lỗ ĐƯỢC BÙ mỗi tháng: 0, 6, 4 triệu (tháng 10 chỉ dùng 4 trong 9 triệu để bù)",
  );

  /* ── 2 · LỖ CŨ −10 TRIỆU, THÁNG SAU VỪA HOÀ VỐN (+10) HOẶC VƯỢT (+15) ── */
  const hoaVon = carryoverMonth({ openingBalance: -10 * TR, realProfit: 10 * TR, commissionPercent: 10 });
  assert.equal(hoaVon.commissionBase, 0, "2. vừa bù hết lỗ ⇒ cơ sở hoa hồng bằng 0");
  assert.equal(hoaVon.payableCommission, 0, "2. và không trả đồng hoa hồng nào");
  assert.equal(hoaVon.closingBalance, 0, "2. nhưng lỗ đã hết — không còn chuyển tiếp");

  const vuot = carryoverMonth({ openingBalance: -10 * TR, realProfit: 15 * TR, commissionPercent: 10 });
  assert.equal(vuot.commissionBase, 5 * TR, "2. lãi 15 trên lỗ 10 ⇒ cơ sở chỉ 5 triệu, KHÔNG phải 15");
  assert.equal(vuot.payableCommission, 500_000, "2. 10% của 5 triệu = 500.000đ");
  assert.equal(vuot.closingBalance, 0, "2. hết lỗ chuyển tiếp");

  /* ── 3 · LỖ KHÔNG BỊ XOÁ KHI TIỀN TRẢ BẰNG 0 ──
   * Tháng lỗ trả 0 đồng; nếu code coi "trả 0 nên coi như xong" thì số dư sẽ về 0 và tháng sau ăn
   * hoa hồng trên toàn bộ lợi nhuận.
   */
  const thangLo = carryoverMonth({ openingBalance: -4 * TR, realProfit: -3 * TR, commissionPercent: 10 });
  assert.equal(thangLo.payableCommission, 0, "3. tháng lỗ không trả hoa hồng");
  assert.equal(thangLo.closingBalance, -7 * TR, "3. nhưng lỗ CỘNG THÊM, không bị xoá: −4 + (−3) = −7 triệu");
  assert.equal(thangLo.lossAdded, 3 * TR, "3. và phần lỗ mới phát sinh hiện ra được");

  /* ── 4 · THÁNG KHÔNG PHÁT SINH NHƯNG ĐÃ XÁC MINH: giữ nguyên số dư, không tự về 0 ── */
  const thangRong = carryoverMonth({ openingBalance: -7 * TR, realProfit: 0, commissionPercent: 10 });
  assert.equal(thangRong.closingBalance, -7 * TR, "4. tháng không hoạt động giữ nguyên lỗ");
  assert.equal(thangRong.lossApplied, 0, "4. và không bù được đồng nào");

  /* ── 5 · QUA NĂM MỚI KHÔNG RESET ──
   * Không có nhánh nào theo tháng lịch trong phép tính, nên đây là bài khoá hành vi: chuỗi 12 → 1
   * phải đi thẳng qua mốc năm.
   */
  const quaNam = carryoverChain(
    [
      { openingBalance: 0, realProfit: -5 * TR, commissionPercent: 10 }, // tháng 12
      { openingBalance: 0, realProfit: 2 * TR, commissionPercent: 10 }, // tháng 1 năm sau
    ],
    -2 * TR,
  );
  assert.equal(quaNam[0].closingBalance, -7 * TR, "5. tháng 12 cộng dồn tiếp số dư cũ");
  assert.equal(quaNam[1].closingBalance, -5 * TR, "5. sang tháng 1 KHÔNG reset về 0");
  assert.equal(quaNam[1].payableCommission, 0, "5. và vẫn chưa được hoa hồng");

  /* ── 6 · SỐ DƯ CHƯA BIẾT LÀ UNKNOWN, KHÔNG PHẢI 0 (AGENTS.md mục 42) ──
   * Đây là lá chắn chống đúng cái cám dỗ "thiếu dữ liệu thì cho 0 cho chạy": cho 0 nghĩa là khẳng
   * định người ấy KHÔNG còn lỗ, và khẳng định sai đó trả tiền thật ra ngoài.
   */
  const chuaBiet = carryoverMonth({ openingBalance: null, realProfit: 9 * TR, commissionPercent: 10 });
  assert.equal(chuaBiet.commissionBase, null, "6. chưa biết số dư ⇒ cơ sở hoa hồng CHƯA BIẾT");
  assert.equal(chuaBiet.payableCommission, null, "6. và tiền phải trả cũng CHƯA BIẾT, không phải 0");
  assert.equal(chuaBiet.closingBalance, null, "6. số dư cuối kỳ cũng chưa biết");
  assert.ok((chuaBiet.unknownReason ?? "").length > 10, "6. và phải nói được VÌ SAO chưa biết");

  /* ── 7 · ĐỔI TỶ LỆ: bù lỗ theo ĐƠN VỊ LỢI NHUẬN trước, rồi áp tỷ lệ tháng hưởng ──
   * Lỗ −10 triệu sinh ra ở tháng tỷ lệ 10%; tháng sau LN thực +15 triệu, tỷ lệ 20%.
   * Đúng: bù 10 triệu lợi nhuận rồi tính 20% trên 5 triệu = 1 triệu.
   * Sai (quy lỗ thành "nợ hoa hồng 1 triệu" rồi trừ vào tiền): 20%×15tr − 1tr = 2 triệu.
   */
  const doiTyLe = carryoverMonth({ openingBalance: -10 * TR, realProfit: 15 * TR, commissionPercent: 20 });
  assert.equal(doiTyLe.commissionBase, 5 * TR, "7. cơ sở sau bù lỗ là 5 triệu");
  assert.equal(doiTyLe.payableCommission, 1 * TR, "7. 20% của 5 triệu = 1 triệu (KHÔNG phải 2 triệu)");

  /* ── 8 · GIẢI HỆ KHI HOA HỒNG LÀ CHI PHÍ ──
   * 8a. Ca chủ shop nêu ở mục 3.3: còn 20 triệu trước thưởng, thưởng 10% trên lợi nhuận SAU thưởng.
   */
  const hePhang = solveCommissionWithCarryover({ beforeCommission: 20 * TR, openingBalance: 0, commissionPercent: 10 });
  assert.equal(hePhang.solved, true, "8a. hệ phải giải được");
  assert.equal(hePhang.payableCommission, 1_818_182, "8a. thưởng ≈ 1.818.182đ");
  assert.equal(hePhang.realProfit, 18_181_818, "8a. lợi nhuận sau thưởng ≈ 18.181.818đ");
  assert.equal(
    (hePhang.realProfit ?? 0) + (hePhang.payableCommission ?? 0),
    20 * TR,
    "8a. LÀM TRÒN: P + H phải bằng đúng Q, không rơi mất đồng nào",
  );

  /* 8b. Ca mục 3.5: Q = 20 triệu, lỗ cũ −10 triệu, tỷ lệ 10%. */
  const heCoLo = solveCommissionWithCarryover({ beforeCommission: 20 * TR, openingBalance: -10 * TR, commissionPercent: 10 });
  assert.equal(heCoLo.realProfit, 19_090_909, "8b. LN thực ≈ 19.090.909đ");
  assert.equal(heCoLo.payableCommission, 909_091, "8b. hoa hồng ≈ 909.091đ");
  assert.equal(heCoLo.commissionBase, 9_090_909, "8b. cơ sở hoa hồng ≈ 9.090.909đ");
  assert.equal(heCoLo.closingBalance, 0, "8b. lỗ cũ đã bù hết");
  assert.equal(
    (heCoLo.realProfit ?? 0) + (heCoLo.payableCommission ?? 0),
    20 * TR,
    "8b. P + H = Q",
  );
  /*
    LỖ CŨ KHÔNG ĐƯỢC TRỪ LẦN HAI. Cách làm sai là lấy Q − |lỗ cũ| = 10 triệu rồi gọi đó là LN thực
    của tháng. LN thực của tháng là 19.090.909đ; −10 triệu chỉ là số dư để tính THƯỞNG.
  */
  assert.notEqual(heCoLo.realProfit, 10 * TR, "8b. lỗ cũ KHÔNG được trừ vào lợi nhuận thực của tháng");

  /* 8c. Q + D ≤ 0 ⇒ không trả thưởng, và lợi nhuận thực không bị đụng vào. */
  const heAm = solveCommissionWithCarryover({ beforeCommission: 5 * TR, openingBalance: -10 * TR, commissionPercent: 10 });
  assert.equal(heAm.payableCommission, 0, "8c. chưa bù hết lỗ ⇒ thưởng 0");
  assert.equal(heAm.realProfit, 5 * TR, "8c. LN thực vẫn là 5 triệu");
  assert.equal(heAm.closingBalance, -5 * TR, "8c. còn −5 triệu chuyển tiếp");

  /* 8d. Chưa biết số dư ⇒ KHÔNG giải, không in số. */
  const heChuaBiet = solveCommissionWithCarryover({ beforeCommission: 20 * TR, openingBalance: null, commissionPercent: 10 });
  assert.equal(heChuaBiet.solved, false, "8d. thiếu số dư đầu kỳ thì không được giải bừa");
  assert.equal(heChuaBiet.realProfit, null, "8d. và không in ra một con số nào");

  /* ── 9 · HỆ NHIỀU NGƯỜI: A lỗ, B lãi — KHÔNG BÙ CHÉO ── */
  const nhieuNguoi = solveShopPayroll({
    revenue: 100 * TR,
    otherCost: 60 * TR,
    people: [
      { employeeId: "A", percentTotal: 0, percentPersonal: 10, percentRevenue: 0, fixed: 5 * TR, personalProfit: -8 * TR, personalRevenue: 20 * TR, openingBalance: 0 },
      { employeeId: "B", percentTotal: 0, percentPersonal: 10, percentRevenue: 0, fixed: 5 * TR, personalProfit: 12 * TR, personalRevenue: 40 * TR, openingBalance: 0 },
    ],
  });
  assert.equal(nhieuNguoi.solved, true, "9. hệ hai người phải giải được");
  const a = nhieuNguoi.people.find((p) => p.employeeId === "A");
  const b = nhieuNguoi.people.find((p) => p.employeeId === "B");
  assert.equal(a?.bonusPersonal, 0, "9. A lỗ ⇒ không hoa hồng cá nhân");
  assert.equal(a?.carry.closingBalance, -8 * TR, "9. A mang −8 triệu sang tháng sau");
  assert.equal(b?.bonusPersonal, 1_200_000, "9. B lãi 12 triệu ⇒ 10% = 1.200.000đ");
  assert.equal(b?.carry.closingBalance, 0, "9. B không có lỗ mang sang");
  // Lỗ của A KHÔNG được bù bằng lãi của B: nếu bù chéo, cơ sở của B sẽ còn 4 triệu.
  assert.equal(b?.carry.commissionBase, 12 * TR, "9. KHÔNG bù chéo — lãi của B không dùng để lấp lỗ của A");

  /* ── 10 · % LỢI NHUẬN TỔNG LÀM HỆ VÔ NGHIỆM ⇒ CHẶN, KHÔNG IN SỐ ── */
  const voNghiem = solveShopPayroll({
    revenue: 100 * TR,
    otherCost: 10 * TR,
    people: [
      { employeeId: "X", percentTotal: -150, percentPersonal: 0, percentRevenue: 0, fixed: 0, personalProfit: 0, personalRevenue: 0, openingBalance: 0 },
    ],
  });
  assert.equal(voNghiem.solved, false, "10. tổng % lợi nhuận ≤ −100% ⇒ hệ vô nghiệm, phải chặn");
  assert.equal(voNghiem.shopProfit, null, "10. và KHÔNG in ra một con số lợi nhuận nào");

  /* ── 11 · % LỢI NHUẬN TỔNG: giải đóng, không lặp ──
   * Hai người mỗi người 10% lợi nhuận toàn shop; K = 22 triệu ⇒ P = 22/1,2.
   */
  const coPhanTram = solveShopPayroll({
    revenue: 100 * TR,
    otherCost: 70 * TR,
    people: [
      { employeeId: "C", percentTotal: 10, percentPersonal: 0, percentRevenue: 0, fixed: 4 * TR, personalProfit: 0, personalRevenue: 0, openingBalance: 0 },
      { employeeId: "D", percentTotal: 10, percentPersonal: 0, percentRevenue: 0, fixed: 4 * TR, personalProfit: 0, personalRevenue: 0, openingBalance: 0 },
    ],
  });
  assert.equal(coPhanTram.shopProfit, Math.round((22 * TR) / 1.2), "11. P_shop = K / (1 + ΣA), giải đóng");
  // Chạy lại phải ra đúng một kết quả — hàm thuần, không phụ thuộc thứ tự hay vòng lặp.
  const lanHai = solveShopPayroll({
    revenue: 100 * TR,
    otherCost: 70 * TR,
    people: [
      { employeeId: "C", percentTotal: 10, percentPersonal: 0, percentRevenue: 0, fixed: 4 * TR, personalProfit: 0, personalRevenue: 0, openingBalance: 0 },
      { employeeId: "D", percentTotal: 10, percentPersonal: 0, percentRevenue: 0, fixed: 4 * TR, personalProfit: 0, personalRevenue: 0, openingBalance: 0 },
    ],
  });
  assert.equal(lanHai.shopProfit, coPhanTram.shopProfit, "11. chạy hai lần ra cùng một số");

  /* ── 12 · MỘT NGƯỜI CHƯA BIẾT SỐ DƯ ⇒ TỔNG CHI PHÍ LƯƠNG CHƯA BIẾT, KHÔNG ÂM THẦM BỎ QUA ── */
  const thieuSoDu = solveShopPayroll({
    revenue: 100 * TR,
    otherCost: 50 * TR,
    people: [
      { employeeId: "E", percentTotal: 0, percentPersonal: 10, percentRevenue: 0, fixed: 5 * TR, personalProfit: 10 * TR, personalRevenue: 0, openingBalance: null },
    ],
  });
  assert.equal(thieuSoDu.payrollCost, null, "12. thiếu số dư của một người ⇒ tổng chi phí lương CHƯA BIẾT");
  assert.equal(thieuSoDu.people[0].payable, null, "12. và dòng của người ấy cũng chưa biết, không phải 0");

  console.log(
    "✓ Lỗ lũy kế: chuỗi 8/9/10 ra đúng −10/−4/0 và 0/0/500.000đ · lỗ không bị xoá khi tiền trả bằng 0 · qua năm mới không reset · chưa biết là UNKNOWN chứ không phải 0 · đổi tỷ lệ thì bù theo LỢI NHUẬN trước · hệ hoa hồng-là-chi-phí giải đóng với P + H = Q · nhiều người không bù chéo · hệ vô nghiệm bị chặn",
  );
}

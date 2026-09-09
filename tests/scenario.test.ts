import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SCENARIO_LEVER_LABEL, SCENARIO_LEVER_NOTE, SCENARIO_LIMIT } from "@/lib/constants/scenario";
import { clampLevers, simulate, type ScenarioBaseline } from "@/lib/queries/scenario";

/**
 * ───────── MÔ PHỎNG KỊCH BẢN ─────────
 *
 * Hai điều phải khoá:
 *
 * 1. **Mô phỏng KHÔNG BAO GIỜ GHI.** Một công cụ "thử xem sao" mà lỡ ghi vào dữ liệu thật là cách
 *    tệ nhất để mất số liệu: người dùng tưởng mình đang thử, hệ thống thì đang sửa. Kiểm ở mức mã
 *    nguồn để lời hứa không nằm trong tài liệu mà nằm trong CI.
 *
 * 2. **Không đổi công thức lợi nhuận.** Mô phỏng chỉ đổi các SỐ HẠNG; công thức
 *    (doanh thu − giá vốn − cước − phí hoàn − phí sàn − quảng cáo − vận hành) phải y hệt trang Báo
 *    cáo. Nếu ai đó "đơn giản hoá" công thức trong mô phỏng, hai trang sẽ nói hai con số khác nhau
 *    về cùng một kỳ.
 */

const BASE: ScenarioBaseline = {
  finishedOrders: 100,
  successOrders: 70,
  revenue: 70_000_000,
  cogs: 35_000_000,
  shipping: 3_000_000,
  returnFee: 1_500_000,
  marketplaceFee: 500_000,
  adSpend: 10_000_000,
  operating: 5_000_000,
};

export function testScenario() {
  // ───────── 1. Không đòn bẩy nào ⇒ kịch bản PHẢI bằng đúng hiện tại ─────────
  // Một mô phỏng làm lệch con số ngay cả khi chưa ai kéo gì là mô phỏng không dùng được.
  {
    const r = simulate(BASE, {});
    assert.deepEqual(r.next, r.base, "không đặt đòn bẩy thì kịch bản phải trùng khít hiện tại");
    assert.equal(r.profitDelta, 0);
    assert.equal(r.base.successRate, 70);
    assert.equal(r.base.netProfit, 70_000_000 - 35_000_000 - 3_000_000 - 1_500_000 - 500_000 - 10_000_000 - 5_000_000);
    assert.equal(r.base.margin, Math.round((r.base.netProfit / r.base.revenue) * 1000) / 10);
  }

  // ───────── 2. Tỷ lệ giao thành công tăng: kéo doanh thu và giá vốn, KHÔNG kéo cước chiều đi ─────────
  // Số đơn gửi đi không đổi khi tỷ lệ giao đổi — đó là chỗ dễ tính sai nhất và cũng là chỗ làm
  // kịch bản trông đẹp hơn thực tế nếu để cước giảm theo.
  {
    const r = simulate(BASE, { successRatePoints: 10 });
    assert.equal(r.next.successOrders, 80, "70% + 10 điểm trên 100 đơn kết thúc = 80 đơn giao được");
    assert.equal(r.next.revenue, Math.round(70_000_000 * (80 / 70)), "doanh thu theo số đơn giao được, giữ nguyên giá trung bình");
    assert.equal(r.next.cogs, Math.round(35_000_000 * (80 / 70)), "giá vốn của đơn giao thành công đi cùng nhịp với doanh thu");
    assert.equal(r.next.shipping, BASE.shipping, "cước chiều đi bám số đơn GỬI ĐI — không đổi khi tỷ lệ giao đổi");
    assert.equal(r.next.returnFee, Math.round(1_500_000 * (20 / 30)), "hoàn ít đi thì phí hoàn giảm đúng theo tỷ lệ");
    assert.ok(r.profitDelta > 0, "giao được nhiều hơn mà lãi gộp dương thì lợi nhuận phải tăng");
  }

  // ───────── 3. Công thức lợi nhuận không được đổi ─────────
  {
    const r = simulate(BASE, { successRatePoints: 5, cogsPercent: 10, shippingPercent: -20, opexPercent: 15 });
    const n = r.next;
    assert.equal(
      n.netProfit,
      n.revenue - n.cogs - n.shipping - n.returnFee - n.marketplaceFee - n.adSpend - n.operating,
      "lợi nhuận ròng phải đúng công thức của trang Báo cáo, không được rút gọn khác đi",
    );
    assert.equal(n.grossProfit, n.revenue - n.cogs);
  }

  // ───────── 4. Chi quảng cáo là đòn bẩy CHI PHÍ, không phải đòn bẩy doanh thu ─────────
  // Cho doanh thu tăng theo ngân sách là nhân với ROAS quy kết — ở mức phủ hiện tại đó là bịa.
  {
    const r = simulate(BASE, { adSpendPercent: 50 });
    assert.equal(r.next.adSpend, 15_000_000);
    assert.equal(r.next.revenue, BASE.revenue, "tăng ngân sách KHÔNG được tự sinh ra doanh thu");
    assert.equal(r.profitDelta, -5_000_000, "chi thêm bao nhiêu thì lợi nhuận giảm đúng bấy nhiêu");
    assert.ok(
      r.assumptions.some((a) => a.includes("KHÔNG tăng theo ngân sách")),
      "phải nói thẳng vì sao doanh thu không đi theo ngân sách",
    );
  }

  // ───────── 5. Đòn bẩy bị chặn trong khoảng cho phép ─────────
  // Kéo giá lên 300% rồi đọc lợi nhuận như thật là tự lừa mình: mô hình này không mô hình hoá cầu.
  {
    const l = clampLevers({ successRatePoints: 999, pricePercent: -999, cogsPercent: Number.NaN, opexPercent: Infinity });
    assert.equal(l.successRatePoints, SCENARIO_LIMIT.successRatePoints);
    assert.equal(l.pricePercent, -SCENARIO_LIMIT.percent);
    assert.equal(l.cogsPercent, 0, "giá trị không phải số phải thành 0, không được làm sập trang");
    assert.equal(l.opexPercent, 0, "vô cực cũng vậy");

    // Tỷ lệ giao thành công không bao giờ vượt 100% dù kéo hết cỡ.
    const r = simulate({ ...BASE, successOrders: 95 }, { successRatePoints: 999 });
    assert.ok((r.next.successRate ?? 0) <= 100, "không có kịch bản nào giao thành công hơn 100%");
    assert.ok(r.next.successOrders <= r.next.finishedOrders);
  }

  // ───────── 6. Điểm hoà vốn giải đúng và nhất quán với chính mô phỏng ─────────
  // Kỳ lỗ thật: giao được 30/100 đơn, lãi gộp mỗi đơn không bù nổi cước, phí hoàn và quảng cáo.
  const LO: ScenarioBaseline = {
    finishedOrders: 100,
    successOrders: 30,
    revenue: 30_000_000,
    cogs: 18_000_000,
    shipping: 3_000_000,
    returnFee: 3_000_000,
    marketplaceFee: 500_000,
    adSpend: 8_000_000,
    operating: 4_000_000,
  };
  {
    const lo = simulate(LO, {});
    assert.ok(lo.base.netProfit < 0, "dựng sẵn một kỳ đang lỗ để có gì mà hoà vốn");
    const be = lo.breakEvenSuccessRate;
    assert.ok(be !== null && be > (lo.base.successRate ?? 0), "đang lỗ thì mức hoà vốn phải CAO hơn tỷ lệ hiện tại");
    // Kéo tỷ lệ giao tới đúng mức hoà vốn thì lợi nhuận phải xấp xỉ 0.
    const tai_diem = simulate(LO, { successRatePoints: Math.min(SCENARIO_LIMIT.successRatePoints, (be ?? 0) - (lo.base.successRate ?? 0)) });
    if ((be ?? 0) - (lo.base.successRate ?? 0) <= SCENARIO_LIMIT.successRatePoints) {
      assert.ok(Math.abs(tai_diem.next.netProfit) < 500_000, `tại mức hoà vốn ${be}% lợi nhuận phải xấp xỉ 0, đang là ${tai_diem.next.netProfit}`);
    }
  }

  // ───────── 7. Không có dữ liệu thì trả CHƯA BIẾT, không phải 0 ─────────
  {
    const r = simulate({ finishedOrders: 0, successOrders: 0, revenue: 0, cogs: 0, shipping: 0, returnFee: 0, marketplaceFee: 0, adSpend: 0, operating: 0 }, { successRatePoints: 10 });
    assert.equal(r.base.successRate, null, "không có đơn kết thúc thì tỷ lệ giao là CHƯA BIẾT");
    assert.equal(r.base.margin, null, "không có doanh thu thì biên lợi nhuận là CHƯA BIẾT, không phải 0%");
    assert.equal(r.breakEvenSuccessRate, null, "không có gì để giải thì không được bịa ra một mức hoà vốn");
    assert.ok(Number.isFinite(r.next.revenue), "không được chia cho 0 rồi in ra Infinity");
  }

  // ───────── 8. RANH GIỚI CỨNG: mô phỏng không chứa một phép ghi nào ─────────
  const src = readFileSync("lib/queries/scenario.ts", "utf8");
  for (const pattern of [/\.update\s*\(/, /\.insert\s*\(/, /\.delete\s*\(/, /setSettingJson/, /revalidatePath/]) {
    assert.ok(!pattern.test(src), `mô phỏng KHÔNG được ghi dữ liệu, nhưng khớp ${pattern}`);
  }
  const page = readFileSync("app/(dashboard)/reports/scenario/page.tsx", "utf8");
  assert.ok(!/use server|action=\{/.test(page), "trang mô phỏng chỉ được dùng form GET — không server action, không ghi");

  // Mỗi đòn bẩy phải có nhãn tiếng Việt và nói rõ nó KÉO THEO cái gì.
  for (const key of Object.keys(SCENARIO_LEVER_LABEL) as (keyof typeof SCENARIO_LEVER_LABEL)[]) {
    assert.ok(SCENARIO_LEVER_LABEL[key].length > 3, `thiếu nhãn đòn bẩy ${key}`);
    assert.ok(SCENARIO_LEVER_NOTE[key].length > 20, `${key}: phải nói rõ đòn bẩy này kéo theo cái gì`);
  }

  console.log(
    `✓ Mô phỏng kịch bản: không đòn bẩy thì trùng khít hiện tại · công thức lợi nhuận giữ nguyên · quảng cáo chỉ là chi phí · đòn bẩy bị chặn · hoà vốn giải đúng · KHÔNG chứa phép ghi nào`,
  );
}

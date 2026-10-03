import assert from "node:assert/strict";
import { clearMemo } from "@/lib/cache";
import { findSizeBreaks, SIZE_BREAK_LABEL, SIZE_BREAK_RULE, type SizeBreakVariant } from "@/lib/constants/size-break";
import { getInventoryDecisionReport } from "@/lib/queries/inventory-decision";
import { getReplenishmentPlan } from "@/lib/queries/planning";

/**
 * ĐỨT SIZE (`lib/constants/size-break.ts`).
 *
 * Điều phải khoá: màu "còn hàng" mà phần lớn lượng bán rơi vào size đã hết thì PHẢI được gọi tên; màu
 * hết sạch không phải đứt size; CHƯA BIẾT tồn và ÍT ĐƠN không bao giờ ra kết luận; thiếu số hàng đặt
 * xưởng thì không bịa câu hành động; và vốn của phần còn lại là CHƯA BIẾT khi thiếu giá nhập.
 */

let seq = 0;
function v(over: Partial<SizeBreakVariant> & Pick<SizeBreakVariant, "size">): SizeBreakVariant {
  seq += 1;
  return {
    variantId: `v${seq}`,
    productId: "p1",
    productName: "Đầm suông",
    productCode: "Q005",
    color: "Đen",
    stockKnown: true,
    available: 10,
    status: "OK",
    sold30: 0,
    unitCost: 100_000,
    suggestedQty: 0,
    openPoQty: 0,
    ...over,
  };
}

export function testSizeBreakPure() {
  const R = SIZE_BREAK_RULE;
  assert.ok(R.minGroupSold30 >= 5, "dưới 5 đơn thì tỷ trọng size chỉ là nhiễu");
  assert.ok(R.brokenSharePct > 0 && R.brokenSharePct < 100);
  for (const k of Object.keys(SIZE_BREAK_LABEL) as (keyof typeof SIZE_BREAK_LABEL)[]) assert.ok(SIZE_BREAK_LABEL[k].length > 3, `thiếu nhãn ${k}`);

  // ───────── Ca chuẩn: M, L đã hết chiếm 90% lượng bán, S và XL còn 35 cái ─────────
  {
    const r = findSizeBreaks([
      v({ size: "S", available: 20, sold30: 2 }),
      v({ size: "M", available: 0, status: "OUT", sold30: 10, suggestedQty: 12 }),
      v({ size: "L", available: -2, status: "OUT", sold30: 8, suggestedQty: 10 }),
      v({ size: "XL", available: 15, sold30: 0, status: "IDLE" }),
    ]);
    assert.equal(r.evaluated, 1);
    assert.equal(r.groups.length, 1, "màu còn 35 cái mà 90% khách muốn size đã hết phải được gọi tên");
    const g = r.groups[0];
    assert.equal(g.level, "BROKEN");
    assert.equal(g.brokenSharePct, 90);
    assert.deepEqual(g.brokenSizes.map((l) => l.size), ["M", "L"], "size mất nhiều lượng bán nhất đứng trước");
    assert.equal(g.lostSold30, 18);
    assert.equal(g.remainingUnits, 35, "khả dụng ÂM của size L không được trừ vào phần còn lại");
    assert.deepEqual(g.remainingSizes.map((l) => l.size), ["S", "XL"]);
    assert.equal(g.remainingCapital, 3_500_000, "vốn ở size còn = khả dụng × giá nhập");
    assert.ok(g.reason.includes("90%") && g.reason.includes("M, L") && g.reason.includes("35 cái"), g.reason);
    assert.ok(g.action?.includes("M 12") && g.action.includes("L 10"), `câu hành động phải nói đặt bù đúng size: ${g.action}`);
    assert.ok(g.action?.includes("quảng cáo"), "đứt size phải nhắc đừng đẩy quảng cáo");
  }

  // ───────── Hết sạch mọi size ⇒ HẾT HÀNG, không phải đứt size ─────────
  {
    const r = findSizeBreaks([
      v({ size: "M", available: 0, status: "OUT", sold30: 10 }),
      v({ size: "L", available: -3, status: "OUT", sold30: 8 }),
    ]);
    assert.equal(r.groups.length, 0, "màu không còn cái nào thì không có 'còn hàng mà thiếu size'");
  }

  // ───────── Ít đơn ⇒ chưa phán, và được ĐẾM RIÊNG ─────────
  {
    const r = findSizeBreaks([
      v({ size: "M", available: 0, status: "OUT", sold30: R.minGroupSold30 - 2 }),
      v({ size: "L", available: 20, sold30: 1 }),
    ]);
    assert.equal(r.groups.length, 0);
    assert.equal(r.insufficient, 1);
    assert.equal(r.evaluated, 0);
  }

  // ───────── Size đang bán mà CHƯA CÓ PHIẾU NHẬP ⇒ cả màu không kết luận ─────────
  {
    const r = findSizeBreaks([
      v({ size: "M", available: 0, status: "OUT", sold30: 10 }),
      v({ size: "L", stockKnown: false, available: 0, status: "UNKNOWN", sold30: 6 }),
      v({ size: "XL", available: 20, sold30: 1 }),
    ]);
    assert.equal(r.groups.length, 0, "chưa biết tồn của size L thì không ai biết màu này đứt hay không");
    assert.equal(r.unknown, 1);
  }
  {
    // Size chưa có phiếu nhập mà KHÔNG ai mua thì không cản kết luận.
    const r = findSizeBreaks([
      v({ size: "M", available: 0, status: "OUT", sold30: 10 }),
      v({ size: "XXL", stockKnown: false, available: 0, status: "UNKNOWN", sold30: 0 }),
      v({ size: "XL", available: 20, sold30: 2 }),
    ]);
    assert.equal(r.unknown, 0);
    assert.equal(r.groups.length, 1);
  }

  // ───────── Sắp đứt: size đã hết + size hết trước khi lô mới về mới vượt ngưỡng ─────────
  {
    const r = findSizeBreaks([
      v({ size: "S", available: 30, sold30: 9 }),
      v({ size: "M", available: 0, status: "OUT", sold30: 5, suggestedQty: 8 }),
      v({ size: "L", available: 2, status: "CRITICAL", sold30: 6, suggestedQty: 9 }),
    ]);
    const g = r.groups[0];
    assert.equal(g?.level, "AT_RISK", "25% đã hết chưa đủ, cộng size sắp hết 30% thì đủ");
    assert.deepEqual(g.brokenSizes.map((l) => l.size).sort(), ["L", "M"]);
    assert.equal(g.remainingUnits, 30, "size sắp hết không được tính vào phần 'còn hàng'");
    assert.ok(g.action?.startsWith("Đặt bù ngay"), g.action ?? "");
  }

  // ───────── Biên ngưỡng: đúng bằng ngưỡng thì gọi tên, dưới ngưỡng thì không ─────────
  {
    const at = findSizeBreaks([v({ size: "M", available: 0, status: "OUT", sold30: 40 }), v({ size: "L", available: 50, sold30: 60 })]);
    assert.equal(at.groups.length, 1, `đúng ${R.brokenSharePct}% phải được gọi tên`);
    assert.equal(at.groups[0].level, "BROKEN", "đúng bằng ngưỡng là ĐÃ đứt size, không phải lùi xuống sắp đứt");
    const below = findSizeBreaks([v({ size: "M", available: 0, status: "OUT", sold30: 39 }), v({ size: "L", available: 50, sold30: 61 })]);
    assert.equal(below.groups.length, 0);
    assert.equal(below.evaluated, 1, "dưới ngưỡng vẫn là đã xét, không phải chưa phán");
  }

  // ───────── Một size thì không có dải size để đứt — không xét, không đếm ─────────
  {
    const r = findSizeBreaks([v({ size: "Free", available: 0, status: "OUT", sold30: 30 })]);
    assert.deepEqual([r.evaluated, r.insufficient, r.unknown, r.groups.length], [0, 0, 0, 0]);
  }

  // ───────── Màu là nhóm riêng; màu viết lệch hoa/thường/khoảng trắng là cùng một màu ─────────
  {
    const r = findSizeBreaks([
      v({ size: "M", color: "Đen", available: 0, status: "OUT", sold30: 12 }),
      v({ size: "L", color: " đen ", available: 20, sold30: 3 }),
      v({ size: "M", color: "Trắng", available: 15, sold30: 12 }),
      v({ size: "L", color: "Trắng", available: 15, sold30: 3 }),
    ]);
    assert.equal(r.evaluated, 2);
    assert.equal(r.groups.length, 1);
    assert.equal(r.groups[0].color, "Đen");
  }

  // ───────── Giá nhập CHƯA BIẾT ở size còn ⇒ vốn CHƯA BIẾT; ở size đã hết thì không ảnh hưởng ─────────
  {
    const unknownRemaining = findSizeBreaks([v({ size: "M", available: 0, status: "OUT", sold30: 12 }), v({ size: "L", available: 20, sold30: 3, unitCost: null })]);
    assert.equal(unknownRemaining.groups[0].remainingCapital, null, "thiếu giá nhập thì vốn là CHƯA BIẾT, không phải 0đ");
    const unknownBroken = findSizeBreaks([v({ size: "M", available: 0, status: "OUT", sold30: 12, unitCost: null }), v({ size: "L", available: 20, sold30: 3 })]);
    assert.equal(unknownBroken.groups[0].remainingCapital, 2_000_000);
  }

  // ───────── Câu hành động: thiếu số đặt xưởng ⇒ KHÔNG có câu; đã đặt đủ ⇒ chờ hàng ─────────
  {
    const noPo = findSizeBreaks([v({ size: "M", available: 0, status: "OUT", sold30: 12, openPoQty: null, suggestedQty: null }), v({ size: "L", available: 20, sold30: 3, openPoQty: null })]);
    assert.equal(noPo.groups[0].action, null, "nguồn không đọc lệnh SX thì không được đề xuất số đặt");
    assert.ok(noPo.groups[0].reason.length > 20, "vẫn phải in sự việc");
    const covered = findSizeBreaks([v({ size: "M", available: 0, status: "OUT", sold30: 12, openPoQty: 30, suggestedQty: 0 }), v({ size: "L", available: 20, sold30: 3 })]);
    assert.ok(covered.groups[0].action?.startsWith("Đã đặt xưởng M 30"), covered.groups[0].action ?? "");
    const noPlan = findSizeBreaks([v({ size: "M", available: 0, status: "OUT", sold30: 12, suggestedQty: 0 }), v({ size: "L", available: 20, sold30: 3 })]);
    assert.ok(noPlan.groups[0].action?.includes("Kế hoạch SX chưa có số đặt"), "không có số thì nói ra, không bịa số");
  }

  // ───────── Thứ tự: đã đứt trước sắp đứt; cùng mức thì mất nhiều lượng bán hơn đứng trước ─────────
  {
    const vs = [
      v({ productId: "a", size: "M", available: 0, status: "OUT", sold30: 10 }),
      v({ productId: "a", size: "L", available: 9, sold30: 2 }),
      v({ productId: "b", size: "M", available: 0, status: "OUT", sold30: 40 }),
      v({ productId: "b", size: "L", available: 9, sold30: 5 }),
      v({ productId: "c", size: "M", available: 3, status: "CRITICAL", sold30: 80 }),
      v({ productId: "c", size: "L", available: 9, sold30: 5 }),
    ];
    const r = findSizeBreaks(vs);
    assert.deepEqual(r.groups.map((g) => g.productId), ["b", "a", "c"]);
    // Hàm thuần: đảo thứ tự đầu vào không đổi kết quả.
    assert.deepEqual(findSizeBreaks([...vs].reverse()), r, "cùng tập đầu vào phải ra cùng kết quả bất kể thứ tự");
  }
}

/**
 * Mức CSDL: khối đứt size của trang Quyết định vốn tồn kho phải đứng trên ĐÚNG dòng Kế hoạch SX — mỗi
 * size được gọi tên phải là một mẫu mã có thật trong kế hoạch, với đúng khả dụng ấy.
 */
export async function testSizeBreakReport() {
  clearMemo();
  const [report, plan] = await Promise.all([getInventoryDecisionReport(), getReplenishmentPlan()]);
  const sb = report.sizeBreaks;
  assert.ok(sb, "báo cáo quyết định tồn kho phải mang khối đứt size");
  assert.deepEqual(sb.rule, { ...SIZE_BREAK_RULE });
  const planBy = new Map(plan.rows.map((r) => [r.variantId, r]));
  for (const g of sb.groups) {
    assert.ok(g.brokenSharePct >= SIZE_BREAK_RULE.brokenSharePct, `${g.key}: dưới ngưỡng mà vẫn bị gọi tên`);
    assert.ok(g.remainingUnits > 0, `${g.key}: màu hết sạch không phải đứt size`);
    assert.ok(g.totalSold30 >= SIZE_BREAK_RULE.minGroupSold30, `${g.key}: ít đơn mà vẫn phán`);
    for (const l of [...g.brokenSizes, ...g.remainingSizes]) {
      const p = planBy.get(l.variantId);
      assert.ok(p, `${g.key}: size ${l.size} không có trong Kế hoạch SX`);
      assert.equal(p.available, l.available, `${g.key}: khả dụng size ${l.size} phải đúng số Kế hoạch SX`);
      assert.equal(p.sold30, l.sold30);
      assert.equal(p.productId, g.productId);
    }
    assert.notEqual(g.action, null, "trang Quyết định vốn tồn kho có số đặt xưởng nên luôn có câu hành động");
  }
  clearMemo();
}

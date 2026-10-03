import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { clearMemo } from "@/lib/cache";
import { buildOrderBudget, compareProposals, type BudgetCash, type BudgetFlow, type BudgetProposal } from "@/lib/constants/order-budget";
import { getInventoryDecisionReport } from "@/lib/queries/inventory-decision";
import { getOrderBudget } from "@/lib/queries/order-budget";

/**
 * NGÂN SÁCH ĐẶT HÀNG (`lib/constants/order-budget.ts`).
 *
 * Điều phải khoá: số dư CHƯA BIẾT không bao giờ thành 0 (không dòng nào "trong dư địa"); thiếu tài khoản
 * thì dư địa là CẬN DƯỚI và phải nói ra; đề xuất thiếu giá nhập không được nhét vào ngân sách như 0đ;
 * đặt theo ưu tiên và DỪNG ở dòng đầu tiên không vừa; và số dư ngân hàng không lộ ra trang tồn kho cho
 * người không có quyền xem Dòng tiền.
 */

const cash = (over: Partial<BudgetCash> = {}): BudgetCash => ({ total: 100_000_000, complete: true, unknownAccounts: 0, stalestAt: null, chainBreaks: 0, ...over });
const flow = (over: Partial<BudgetFlow> = {}): BudgetFlow => ({ days: 30, codExpected: 20_000_000, adsPlanned: 20_000_000, opexPlanned: 10_000_000, productionDue: 0, net: -10_000_000, ...over });
let seq = 0;
const prop = (over: Partial<BudgetProposal> = {}): BudgetProposal => {
  seq += 1;
  return { variantId: `v${String(seq).padStart(3, "0")}`, productId: "p1", label: `Mẫu ${seq}`, decision: "REORDER", qty: 10, capital: 10_000_000, grossImpactEstimate: null, ...over };
};

export function testOrderBudgetPure() {
  // ───────── Đủ tiền: dư địa = số dư + dòng tiền ròng ─────────
  {
    const b = buildOrderBudget({ cash: cash(), flow: flow(), proposals: [prop({ capital: 30_000_000 }), prop({ capital: 20_000_000 })] });
    assert.equal(b.headroom, 90_000_000, "dư địa = 100tr số dư + (−10tr) dòng tiền ròng");
    assert.equal(b.verdict, "FITS");
    assert.equal(b.requiredKnown, 50_000_000);
    assert.equal(b.afterAll, 40_000_000);
    assert.equal(b.fundedCount, 2);
    assert.ok(b.lines.every((l) => l.state === "FUNDED"));
    assert.equal(b.headroomIsLowerBound, false);
  }

  // ───────── Số dư CHƯA BIẾT ⇒ không dư địa, không dòng nào "trong dư địa" ─────────
  {
    const b = buildOrderBudget({ cash: cash({ total: null }), flow: flow(), proposals: [prop()] });
    assert.equal(b.headroom, null, "chưa biết số dư thì dư địa là CHƯA BIẾT, không phải dòng tiền ròng");
    assert.equal(b.afterAll, null);
    assert.equal(b.verdict, "UNKNOWN_CASH");
    assert.ok(b.lines.every((l) => l.state === "UNKNOWN_CASH"), "không được xếp dòng nào vào trong/ngoài dư địa khi chưa biết số dư");
    assert.equal(b.fundedCount + b.unfundedCount, 0);
    assert.ok(b.caveats.some((c) => c.includes("số dư")), "phải nói ra vì sao không so được");
  }

  // ───────── Dừng ở dòng ĐẦU TIÊN không vừa — không nhảy cóc nhét dòng rẻ ưu tiên thấp ─────────
  {
    const b = buildOrderBudget({
      cash: cash({ total: 50_000_000 }),
      flow: flow({ net: 0 }),
      proposals: [
        prop({ decision: "REORDER", capital: 5_000_000 }),
        prop({ decision: "STOCKOUT_RISK", capital: 20_000_000, grossImpactEstimate: 1_000_000 }),
        prop({ decision: "STOCKOUT_RISK", capital: 40_000_000, grossImpactEstimate: 5_000_000 }),
      ],
    });
    assert.deepEqual(b.lines.map((l) => [l.capital, l.state]), [
      [40_000_000, "FUNDED"],
      [20_000_000, "UNFUNDED"],
      [5_000_000, "UNFUNDED"],
    ], "dòng 5tr vừa túi nhưng đứng SAU một dòng ưu tiên cao hơn không vừa — vẫn ngoài dư địa");
    assert.equal(b.verdict, "OVER");
    assert.equal(b.unfundedCapital, 25_000_000);
    assert.equal(b.afterAll, -15_000_000, "âm = thiếu bao nhiêu nếu đặt hết");
    assert.deepEqual(b.lines.map((l) => l.cumulative), [40_000_000, 60_000_000, 65_000_000]);
  }

  // ───────── Biên: cộng dồn ĐÚNG BẰNG dư địa vẫn là vừa ─────────
  {
    const b = buildOrderBudget({ cash: cash({ total: 30_000_000 }), flow: flow({ net: 0 }), proposals: [prop({ capital: 30_000_000 })] });
    assert.equal(b.lines[0].state, "FUNDED");
    assert.equal(b.verdict, "FITS");
    assert.equal(b.afterAll, 0);
  }

  // ───────── Hết dư địa trước khi đặt ─────────
  {
    const b = buildOrderBudget({ cash: cash({ total: 5_000_000 }), flow: flow({ net: -8_000_000 }), proposals: [prop({ capital: 1_000_000 })] });
    assert.equal(b.headroom, -3_000_000);
    assert.equal(b.verdict, "NO_HEADROOM");
    assert.equal(b.lines[0].state, "UNFUNDED");
  }

  // ───────── Thiếu giá nhập: không xếp vào ngân sách, không chặn dòng sau, đếm riêng ─────────
  {
    const b = buildOrderBudget({
      cash: cash({ total: 20_000_000 }),
      flow: flow({ net: 0 }),
      proposals: [prop({ decision: "STOCKOUT_RISK", capital: null, grossImpactEstimate: 9_000_000 }), prop({ capital: 15_000_000 })],
    });
    const unknown = b.lines.find((l) => l.capital === null);
    assert.equal(unknown?.state, "UNKNOWN_COST");
    assert.equal(unknown?.cumulative, null, "dòng chưa biết giá không có số cộng dồn");
    assert.equal(b.requiredKnown, 15_000_000, "chưa biết giá thì KHÔNG cộng 0đ vào tổng");
    assert.equal(b.requiredUnknownCount, 1);
    assert.equal(b.lines.find((l) => l.capital === 15_000_000)?.state, "FUNDED");
    assert.ok(b.caveats.some((c) => c.includes("CHƯA CÓ GIÁ NHẬP")));
  }

  // ───────── Thiếu tài khoản ⇒ CẬN DƯỚI; chuỗi số dư đứt và chi vận hành 0đ đều phải nói ra ─────────
  {
    const b = buildOrderBudget({ cash: cash({ complete: false, unknownAccounts: 2, chainBreaks: 3 }), flow: flow({ opexPlanned: 0 }), proposals: [prop()] });
    assert.equal(b.headroomIsLowerBound, true);
    assert.ok(b.caveats.some((c) => c.includes("CẬN DƯỚI") && c.includes("2 tài khoản")));
    assert.ok(b.caveats.some((c) => c.includes("đứt 3 chỗ")));
    assert.ok(b.caveats.some((c) => c.includes("Chi vận hành")));
  }

  // ───────── Không có gì để đặt; số lượng 0 bị bỏ ─────────
  {
    const b = buildOrderBudget({ cash: cash(), flow: flow(), proposals: [prop({ qty: 0 })] });
    assert.equal(b.verdict, "NOTHING_TO_ORDER");
    assert.equal(b.lines.length, 0);
  }

  // ───────── Thứ tự ưu tiên ổn định: nguy cơ hết hàng trước; ước mất lớn trước; rẻ trước; đảo đầu vào không đổi ─────────
  {
    const ps = [
      prop({ decision: "REORDER", capital: 1_000_000, grossImpactEstimate: null }),
      prop({ decision: "STOCKOUT_RISK", capital: 9_000_000, grossImpactEstimate: null }),
      prop({ decision: "STOCKOUT_RISK", capital: 3_000_000, grossImpactEstimate: null }),
      prop({ decision: "STOCKOUT_RISK", capital: 50_000_000, grossImpactEstimate: 2_000_000 }),
    ];
    const order = [...ps].sort(compareProposals).map((p) => p.capital);
    assert.deepEqual(order, [50_000_000, 3_000_000, 9_000_000, 1_000_000]);
    const a = buildOrderBudget({ cash: cash(), flow: flow(), proposals: ps });
    const b = buildOrderBudget({ cash: cash(), flow: flow(), proposals: [...ps].reverse() });
    assert.deepEqual(a, b, "cùng tập đề xuất phải ra cùng ngân sách bất kể thứ tự đầu vào");
  }
}

/**
 * Mức CSDL + mã nguồn: ngân sách đứng trên ĐÚNG đề xuất của trang Quyết định vốn tồn kho, và trang ấy chỉ
 * đọc số dư ngân hàng sau cổng quyền tài chính.
 */
export async function testOrderBudgetReport() {
  clearMemo();
  const report = await getInventoryDecisionReport();
  const b = await getOrderBudget(report);
  assert.equal(b.horizonDays, 30);
  assert.equal(b.requiredKnown, report.summary.capitalRequired, "tổng vốn đề xuất của ngân sách phải bằng thẻ 'Vốn cần cho đề xuất đặt'");
  const expected = report.rows.filter((r) => (r.decision === "STOCKOUT_RISK" || r.decision === "REORDER") && (r.suggestedQty ?? 0) > 0).map((r) => r.variantId).sort();
  assert.deepEqual(b.lines.map((l) => l.variantId).sort(), expected, "mỗi đề xuất đặt là đúng một dòng ngân sách");
  if (b.cash.total === null) assert.equal(b.headroom, null, "CSDL mẫu chưa có số dư ⇒ dư địa CHƯA BIẾT");

  const page = readFileSync(path.join(process.cwd(), "app/(dashboard)/inventory/decisions/page.tsx"), "utf8");
  const gate = page.indexOf('decideScope("FINANCE"');
  const read = page.indexOf("getOrderBudget(report)");
  assert.ok(page.includes('can(user, "reports:cash")'), "trang tồn kho phải hỏi quyền xem Dòng tiền trước khi đọc số dư ngân hàng");
  assert.ok(gate > 0 && read > gate, "cổng phạm vi FINANCE phải đứng TRƯỚC lượt đọc ngân sách");
  assert.match(page, /financeOk \? await getOrderBudget\(report\) : null/, "không có quyền thì KHÔNG gọi hàm đọc số dư");
  clearMemo();
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { computePlan, type PlanInput } from "@/lib/constants/planning";
import { explainPlan, type PlanExplainContext } from "@/lib/constants/plan-explain";

/*
  ĐỀ XUẤT ĐẶT HÀNG THEO GTC + LỜI DIỄN GIẢI — hàm thuần, không đọc CSDL, không đọc đồng hồ thật
  (mọi phép tính nhận `HOM_NAY` truyền vào — AGENTS.md mục 50).
*/
const HOM_NAY = new Date("2026-09-23T03:00:00Z");
const CTX: PlanExplainContext = { deliveryRate: 50, deliverySource: "history", vtpReturnLagDays: 8, restockDays: 2 };

/** 2 cái/ngày gửi đi, SX 7 · đủ bán 14 · an toàn 3 ngày, GTC 50%, hàng hoàn bán lại được 80%, độ trễ hoàn 10 ngày. */
const GOC: PlanInput = {
  stock: 20,
  stockKnown: true,
  committed: 4,
  soldInWindow: 28,
  windowDays: 14,
  leadTimeDays: 7,
  coverDays: 14,
  safetyDays: 3,
  roundTo: 1,
  inTransit: 10,
  awaitingReturn: 5,
  returnRate: 0.5,
  returnRecoveryRate: 0.8,
  returnLagDays: 10,
};

/** Chạy các bước diễn giải như một phép tính: phải ra ĐÚNG số đề xuất. */
function replay(steps: ReturnType<typeof explainPlan>["steps"]) {
  let acc = 0;
  let afterTarget = false;
  for (const st of steps) {
    if (st.key === "target") { assert.equal(acc, st.qty, `các dòng trước "Cần có" phải cộng ra ${st.qty}, ra ${acc}`); afterTarget = true; continue; }
    if (st.key === "gap") { assert.equal(Math.max(0, acc), st.qty, `"Còn thiếu" phải bằng cần có − đã có (${Math.max(0, acc)}), ra ${st.qty}`); acc = st.qty; continue; }
    if (st.op === "↑") { acc = st.qty; continue; }
    acc += st.op === "+" ? st.qty : -st.qty;
  }
  assert.ok(afterTarget, "lời diễn giải phải có dòng Cần có");
  return acc;
}

export function testPlanExplain() {
  // ───────── 1. Chưa đo được độ trễ hoàn ⇒ ĐÚNG công thức cũ (không trừ hàng hoàn của đơn mới) ─────────
  const khongDo = computePlan({ ...GOC, returnLagDays: null }, HOM_NAY);
  assert.equal(khongDo.futureReturnCredit, 0, "chưa đo độ trễ hoàn thì không được trừ hàng hoàn tương lai");
  assert.equal(khongDo.target, Math.ceil(2 * (7 + 14)) + Math.ceil(2 * 3), "mục tiêu = gửi đi × (SX + đủ bán) + an toàn khi chưa đo được độ trễ");

  // ───────── 2. Trừ hàng hoàn của CHÍNH các đơn tương lai về kịp bán lại ─────────
  const coDo = computePlan(GOC, HOM_NAY);
  // 2 cái/ngày × 50% hoàn × 80% bán lại × (24 − 10) ngày = 11,2 ⇒ làm tròn XUỐNG 11
  assert.equal(coDo.futureReturnCredit, 11, "hàng hoàn về kịp = gửi đi × tỷ lệ hoàn × tỷ lệ bán lại × (kỳ − độ trễ), làm tròn xuống");
  assert.equal(coDo.target, 48 - 11);
  assert.equal(coDo.netVelocity, 2 * (1 - 0.5 * 0.8), "hao kho ròng = gửi đi × (1 − hoàn × bán lại)");
  assert.ok(coDo.suggested < khongDo.suggested, "tính GTC phải làm số đặt NHỎ HƠN khi có hàng hoàn về kịp");

  // Số ngày còn bán: 16 cái khả dụng < 2 × 10 ngày ⇒ hết trước khi hàng hoàn kịp về ⇒ hao theo tốc độ gửi đi
  assert.equal(coDo.daysOfCover, 16 / 2);
  // 40 cái: 20 cái đầu hết trong 10 ngày, 20 cái sau hao ròng 1,2/ngày
  const nhieu = computePlan({ ...GOC, stock: 44 }, HOM_NAY);
  assert.ok(Math.abs((nhieu.daysOfCover ?? 0) - (10 + 20 / 1.2)) < 1e-9, "sau độ trễ hoàn, kho hao theo tốc độ RÒNG");

  // ───────── 3. Đơn điệu: GTC thấp hơn / độ trễ ngắn hơn không bao giờ làm đặt NHIỀU hơn ─────────
  for (const q of [0, 0.2, 0.4, 0.6]) {
    const a = computePlan({ ...GOC, returnRate: q }, HOM_NAY).suggested;
    const b = computePlan({ ...GOC, returnRate: q + 0.2 }, HOM_NAY).suggested;
    assert.ok(b <= a, `tỷ lệ hoàn ${q + 0.2} phải đặt ≤ tỷ lệ hoàn ${q} (${b} > ${a})`);
  }
  for (const lag of [0, 5, 10, 20]) {
    const a = computePlan({ ...GOC, returnLagDays: lag }, HOM_NAY).suggested;
    const b = computePlan({ ...GOC, returnLagDays: lag + 5 }, HOM_NAY).suggested;
    assert.ok(b >= a, `độ trễ hoàn ${lag + 5} ngày phải đặt ≥ độ trễ ${lag} ngày`);
  }
  assert.ok(computePlan({ ...GOC, returnLagDays: 30 }, HOM_NAY).futureReturnCredit === 0, "độ trễ dài hơn cả kỳ ⇒ không hàng hoàn nào về kịp");

  // ───────── 4. Lời diễn giải cộng lại ĐÚNG bằng số đề xuất — ở nhiều trạng thái ─────────
  const cases: PlanInput[] = [
    GOC,
    { ...GOC, returnLagDays: null },
    { ...GOC, stock: 0, committed: 9 }, // âm: phải bù đơn đã chốt
    { ...GOC, stock: 300 }, // dư: không đặt
    { ...GOC, roundTo: 10 },
    { ...GOC, minOrderQty: 100 },
    { ...GOC, countIncoming: false },
    { ...GOC, soldInWindow: 0, peakDayQty: 0 },
  ];
  for (const i of cases) {
    const out = computePlan(i, HOM_NAY);
    const e = explainPlan(i, out, CTX, HOM_NAY);
    assert.equal(e.known, true);
    assert.equal(replay(e.steps), out.suggested, `các bước diễn giải phải ra đúng số đề xuất ${out.suggested} (đầu vào ${JSON.stringify(i)})`);
    assert.ok(e.summary.length > 0 && e.basis.length === 2, "phải có câu khuyến nghị và hai dòng căn cứ");
    const base = e.scenarios.find((s) => s.key === "BASE");
    assert.equal(base?.suggested, out.suggested, "kịch bản 'như hiện tại' phải là CHÍNH số đề xuất");
  }

  // ───────── 5. Kịch bản đi đúng chiều ─────────
  const e = explainPlan(GOC, coDo, CTX, HOM_NAY);
  const sc = Object.fromEntries(e.scenarios.map((s) => [s.key, s.suggested]));
  assert.ok(sc.SLOW <= sc.BASE && sc.BASE <= sc.FAST, "bán chậm ≤ hiện tại ≤ bán nhanh");
  assert.ok(sc.GTC_UP >= sc.BASE && sc.BASE >= sc.GTC_DOWN, "GTC cao hơn (ít hoàn) phải đặt NHIỀU hơn, GTC thấp hơn đặt ÍT hơn");
  assert.ok(sc.NO_RESTOCK >= sc.BASE, "kho không tái nhập kịp ⇒ số đặt tối đa");
  assert.equal(sc.NO_RESTOCK, khongDo.suggested, "kịch bản kho không tái nhập kịp = không trừ hàng hoàn tương lai");
  assert.ok(e.steps.some((s) => s.key === "future-returns" && s.qty === 11), "lời giải phải in dòng trừ hàng hoàn của đơn mới");
  // GTC là giả định (chưa đo) thì phải NÓI RA
  const gia = explainPlan(GOC, coDo, { ...CTX, deliverySource: "default" }, HOM_NAY);
  assert.ok(gia.notes.some((n) => n.includes("CHƯA phải số đo")), "GTC chưa đo được thì ghi chú phải nói rõ");

  // ───────── 6. Chưa có phiếu nhập ⇒ KHÔNG có số đặt, chỉ có nhu cầu tham khảo ─────────
  const chuaBiet: PlanInput = { ...GOC, stockKnown: false };
  const eu = explainPlan(chuaBiet, computePlan(chuaBiet, HOM_NAY), CTX, HOM_NAY);
  assert.equal(eu.known, false);
  assert.equal(eu.steps.length, 0, "chưa biết tồn thì không có phép tính đặt hàng nào");
  assert.equal(computePlan(chuaBiet, HOM_NAY).suggested, 0);
  assert.equal(eu.demandIfUnknown, coDo.target, "nhu cầu tham khảo = mục tiêu khi CHƯA trừ tồn");

  // ───────── 7. Quét mã nguồn: kế hoạch không tự tính tỷ lệ hoàn; màn hình không in tồn Pancake ─────────
  const goc = process.cwd();
  const doc = (f: string) => readFileSync(path.join(goc, f), "utf8");
  const planning = doc("lib/queries/planning.ts");
  assert.ok(!/MIN_RETURN_RATE_SAMPLE/.test(planning), "kế hoạch không được tự tính tỷ lệ hoàn theo mẫu mã/toàn shop — dùng thang bậc GTC chung");
  assert.ok(/deliveryRates\.byProduct\.get/.test(planning), "tỷ lệ hoàn của kế hoạch phải đọc từ thang bậc GTC theo mã");
  for (const f of [
    "app/(dashboard)/products/[id]/page.tsx",
    "app/(dashboard)/products/columns.tsx",
    "app/(dashboard)/inventory/planning/page.tsx",
    "app/(dashboard)/orders/[id]/page.tsx",
    "app/(dashboard)/inventory/columns.tsx",
  ]) {
    const src = doc(f);
    assert.ok(!/remainQuantity|pancakeStock|pancakeRemain/.test(src), `${f}: không in tồn Pancake ra màn hình (tồn Pancake âm ở 12/12 mẫu mã Q005, đo 23/09/2026)`);
  }
}

/**
 * ═══════════ BỘ ĐO ĐƠN VÀNG v2 — Golden Conversation Dataset v2 + bộ đo (sứ mệnh saas-order-accuracy · lát C1) ═══════════
 *
 * Ba lớp, theo thứ tự:
 *  1. BỘ ĐO THUẦN đúng (`lib/sales-chatbot/order-golden-metrics.ts`): từng chỉ số trên ca tự dựng, mẫu số 0 ⇒ `null` (không 0),
 *     cờ CRITICAL khi chốt sai / đơn trùng vượt 0, tách chốt sai theo căn cứ, chấm đơn SỚM NHẤT khi có đơn trùng.
 *  2. DATASET đúng hình: ≥ 20 hội thoại, đủ 19 kịch bản §23, nhãn không tự mâu thuẫn, giá nhãn = giá shop thử, KHÔNG PII thật.
 *  3. KHUNG CHẠY chạy được (engine hỏi model đúng số vòng kịch bản, máy chủ từ chối đúng công cụ kịch bản định) và SỐ ĐO HIỆN
 *     TRẠNG đúng như `baseline.json` / `BASELINE.md`. Bài này KHÔNG khẳng định số «đẹp»: hôm nay chốt sai > 0 thì nó khẳng định
 *     ĐÚNG con số ấy — đổi luật chốt / sửa lỗi ⇒ `npx tsx tests/order-golden/update-baseline.ts`, đưa diff số đo vào PR.
 *
 * Không phụ thuộc đồng hồ / máy (AGENTS mục 50 · 65): mọi mốc là đồng hồ thật của chính lượt chạy, không ngày tuyệt đối; đầu ra
 * so sánh không chứa ngày / id; tệp đọc bỏ CRLF.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  isConfirmedOrder,
  isCountedOrder,
  labelProblems,
  ORDER_GOLDEN_METRIC_INFO,
  ORDER_GOLDEN_METRICS,
  phoneKey,
  placeKey,
  scoreOrderCase,
  summarizeOrderGolden,
  type GoldenOrder,
  type GoldenOrderLine,
  type ObservedOrder,
  type OrderConfirmBasis,
  type OrderConfirmVerdict,
  type OrderGoldenLabel,
} from "@/lib/sales-chatbot/order-golden-metrics";
import { firstDiff, GOLDEN_SHOPS } from "../sales-agent-golden/harness";
import { LABEL_PRICES, LABEL_SHIPPING_FEE, ORDER_GOLDEN_CASES, SECTION_23_SCENARIOS } from "./cases";
import { labelFor, ORDER_GOLDEN_VARIANTS, runOrderGolden, type OrderGoldenRun } from "./harness";
import { compactBaseline, renderBaselineTables, tablesBlockOf } from "./report";

export const ORDER_GOLDEN_BASELINE_JSON = path.join("tests", "order-golden", "baseline.json");
export const ORDER_GOLDEN_BASELINE_MD = path.join("tests", "order-golden", "BASELINE.md");
const CASES_SOURCE = path.join("tests", "order-golden", "cases.ts");

/** SĐT giả của dataset (kho PUBLIC): 09xx000xxx. */
const FAKE_PHONE = /^09\d{2}000\d{3}$/;

// ─────────────────────────── 1 · BỘ ĐO THUẦN ───────────────────────────

function testOrderGoldenMetrics() {
  assert.deepEqual([...ORDER_GOLDEN_METRICS].sort(), Object.keys(ORDER_GOLDEN_METRIC_INFO).sort(), "mỗi chỉ số có định nghĩa tử / mẫu");

  // Chuẩn hoá so khớp.
  assert.equal(phoneKey("+84 912.000-101"), "0912000101");
  assert.equal(phoneKey("84912000101"), "0912000101");
  assert.equal(phoneKey("0912 000 101"), "0912000101");
  assert.equal(placeKey("Thành phố Hà Nội"), "ha noi");
  assert.equal(placeKey("Hà Nội"), "ha noi");
  assert.equal(placeKey("Phường Hoàn Kiếm"), "hoan kiem");
  assert.equal(placeKey("Xã Bát Tràng"), "bat trang");
  assert.equal(placeKey("Tỉnh Gia Lai"), "gia lai");

  const lineA: GoldenOrderLine = { sku: "A", variant: "1kg", quantity: 2, unit: "gói", unitPrice: 100 };
  const lineC: GoldenOrderLine = { sku: "C", variant: "500g", quantity: 1, unit: "hộp", unitPrice: 50 };
  const want = (lines: GoldenOrderLine[] = [lineA], total = 230): GoldenOrder => ({ lines, phone: "0912000101", address: { province: "Hà Nội", district: null, ward: "Hoàn Kiếm", line: "Số 7 ngõ Thử" }, shippingFee: 30, total });
  const lab = (o: GoldenOrder | null, verdict: OrderConfirmVerdict, basis: OrderConfirmBasis): OrderGoldenLabel => ({ intent: o !== null, expectedOrders: o ? 1 : 0, order: o, confirm: { verdict, basis, why: "thử" } });
  const ord = (over: Partial<ObservedOrder> = {}): ObservedOrder => ({
    id: "o",
    stage: "NEW",
    lines: [{ sku: "A", quantity: 2, unitPrice: 100 }],
    phone: "0912000101",
    province: "Thành phố Hà Nội",
    ward: "Phường Hoàn Kiếm",
    addressLine: "Số 7 ngõ Thử, Phường Hoàn Kiếm, Hà Nội",
    shippingFee: 30,
    total: 230,
    confirmedEvents: 0,
    ...over,
  });
  const obs = (key: string, orders: ObservedOrder[]) => ({ key, orders });

  // Nhãn tự mâu thuẫn bị bắt trước khi thành «hệ chấm sai».
  const verifyLabel = lab(want(), "NEED_VERIFICATION", "NO_CONSENT");
  const noLabel = lab(null, "NEED_VERIFICATION", "NO_ORDER");
  assert.deepEqual(labelProblems(verifyLabel), []);
  assert.deepEqual(labelProblems(noLabel), []);
  assert.ok(labelProblems(lab(want([lineA], 999), "NEED_VERIFICATION", "NO_CONSENT")).some((p) => p.includes("tổng")), "tổng lệch Σ SL × giá + ship");
  assert.ok(labelProblems({ ...verifyLabel, confirm: { verdict: "AUTO_CONFIRM_OK", basis: "NO_CONSENT", why: "x" } }).length > 0, "căn cứ «chưa đồng ý» đi với tự chốt");
  assert.ok(labelProblems({ ...verifyLabel, expectedOrders: 0 }).length > 0, "có nhãn đơn mà nói không có đơn");
  assert.ok(labelProblems(lab(null, "NEED_VERIFICATION", "NO_CONSENT")).length > 0, "ca không đơn phải mang căn cứ NO_ORDER");
  assert.ok(labelProblems(lab(want([lineA, lineA], 430), "NEED_VERIFICATION", "NO_CONSENT")).some((p) => p.includes("hai dòng")), "một SKU hai dòng");
  assert.ok(labelProblems({ ...verifyLabel, confirm: { ...verifyLabel.confirm, why: " " } }).length > 0, "nhãn chốt phải có lý do");
  assert.ok(labelProblems(lab(want(), "AUTO_CONFIRM_OK", "RULE_6")).some((p) => p.includes("dependsOn")), "căn cứ là luật của chủ shop ⇒ phải khai dependsOn");
  assert.deepEqual(labelProblems({ ...lab(want(), "AUTO_CONFIRM_OK", "RULE_AUTO_CONFIRM"), confirm: { verdict: "AUTO_CONFIRM_OK", basis: "RULE_AUTO_CONFIRM", why: "luật 04/10", dependsOn: "luật 04/10" } }), [], "luật 04/10 là căn cứ cho tự chốt");

  // «Đã chốt» = phát order.confirmed hoặc «Đã xác nhận» trở đi, KỂ CẢ đơn sau đó bị huỷ; đơn huỷ từng chốt vẫn được đếm.
  assert.equal(isConfirmedOrder({ stage: "CANCELLED", confirmedEvents: 1 }), true, "đã phát order.confirmed rồi huỷ vẫn là đã chốt");
  assert.equal(isConfirmedOrder({ stage: "PACKING", confirmedEvents: 0 }), true, "đang đóng gói = đã qua chốt");
  assert.equal(isConfirmedOrder({ stage: "NEW", confirmedEvents: 0 }), false);
  assert.deepEqual([isCountedOrder({ stage: "CANCELLED", confirmedEvents: 1 }), isCountedOrder({ stage: "CANCELLED", confirmedEvents: 0 }), isCountedOrder({ stage: "NEW", confirmedEvents: 0 })], [true, false, true], "nháp huỷ khi chưa chốt mới là đã dọn sạch");

  // Chấm từng ca.
  const s1 = scoreOrderCase(verifyLabel, obs("dung", [ord()]));
  assert.deepEqual([s1.created, s1.duplicates, s1.missing, s1.confirmed, s1.falseAutoConfirm, s1.missedConfirm, s1.fields?.wrong], [1, 0, 0, false, false, null, []], "đơn đúng, còn Mới, nhãn đòi người xác minh");
  const s2 = scoreOrderCase(verifyLabel, obs("chot-sai", [ord({ stage: "CONFIRMED", confirmedEvents: 1 })]));
  assert.equal(s2.falseAutoConfirm, true, "«Đã xác nhận» khi nhãn đòi người xác minh = chốt sai");
  const s3 = scoreOrderCase(lab(want(), "AUTO_CONFIRM_OK", "CUSTOMER_AGREED"), obs("lo-chot", [ord()]));
  assert.deepEqual([s3.falseAutoConfirm, s3.missedConfirm], [null, true], "khách đã đồng ý mà đơn còn Mới = bỏ lỡ lời chốt");
  const s4 = scoreOrderCase(verifyLabel, obs("trung", [ord({ id: "o1" }), ord({ id: "o2", phone: "0999000999" })]));
  assert.deepEqual([s4.created, s4.duplicates, s4.fields?.wrong], [2, 1, []], "hai đơn cho một lần mua = một đơn trùng; chấm đơn SỚM NHẤT");
  const s5 = scoreOrderCase(verifyLabel, obs("thieu", []));
  assert.deepEqual([s5.created, s5.missing, s5.fields], [0, 1, null], "thiếu đơn ⇒ không chấm trường");
  const s6 = scoreOrderCase(noLabel, obs("ao", [ord({ stage: "CONFIRMED" })]));
  assert.deepEqual([s6.created, s6.duplicates, s6.falseAutoConfirm, s6.fields], [1, 0, true, null], "đơn không có thật mà đã chốt");
  assert.equal(scoreOrderCase(noLabel, obs("ao-hai", [ord(), ord()])).duplicates, 1, "hai đơn không có thật ⇒ đơn thứ hai là trùng");
  const s7 = scoreOrderCase(noLabel, obs("da-huy", [ord({ stage: "CANCELLED" }), ord({ stage: "DELETED" })]));
  assert.deepEqual([s7.created, s7.falseAutoConfirm], [0, false], "đơn đã huỷ / đã xoá không còn là đơn máy để lại");
  const sc = scoreOrderCase(noLabel, obs("chot-roi-huy", [ord({ stage: "CANCELLED", confirmedEvents: 1 })]));
  assert.deepEqual([sc.created, sc.confirmed, sc.falseAutoConfirm], [1, true, true], "đơn CANCELLED đã phát order.confirmed ⇒ tính đã chốt (hại đã xảy ra)");
  const sd = scoreOrderCase(verifyLabel, obs("trung-chot-roi-huy", [ord({ id: "o1" }), ord({ id: "o2", stage: "CANCELLED", confirmedEvents: 1 })]));
  assert.deepEqual([sd.created, sd.duplicates, sd.falseAutoConfirm], [2, 1, true], "đơn trùng đã chốt rồi huỷ vẫn là đơn trùng");
  const s8 = scoreOrderCase(verifyLabel, obs("sai-sku", [ord({ lines: [{ sku: "B", quantity: 2, unitPrice: 100 }] })]));
  assert.equal(s8.fields?.sku, false);
  assert.deepEqual(s8.fields?.lines, [{ sku: "A", matched: false, quantityOk: null, priceOk: null }], "dòng sai SKU không chấm SL / giá lần hai");
  const s9 = scoreOrderCase(lab(want([lineA, lineC], 280), "NEED_VERIFICATION", "NO_CONSENT"), obs("sai-sl", [ord({ lines: [{ sku: "A", quantity: 3, unitPrice: 100 }], total: 330 })]));
  assert.deepEqual(s9.fields?.wrong, ["sku", "quantity:A", "total"], "thiếu một dòng + sai SL dòng còn lại + sai tổng; giá dòng khớp vẫn đúng");
  assert.equal(scoreOrderCase(verifyLabel, obs("sdt", [ord({ phone: "+84 912 000 101" })])).fields?.phone, true, "SĐT khác định dạng, cùng số");
  assert.deepEqual(scoreOrderCase(verifyLabel, obs("sdt-sai", [ord({ phone: "0912000110" })])).fields?.wrong, ["phone"]);
  assert.deepEqual(scoreOrderCase(verifyLabel, obs("gia-sai", [ord({ lines: [{ sku: "A", quantity: 2, unitPrice: 90 }] })])).fields?.wrong, ["price:A"]);
  const noWard = lab({ ...want(), address: { ...want().address, ward: null } }, "NEED_VERIFICATION", "ADDRESS_UNRESOLVED");
  assert.equal(scoreOrderCase(noWard, obs("xa-trong", [ord({ ward: "" })])).fields?.address.ward, true, "xã nhãn null + máy để trống = đúng");
  assert.equal(scoreOrderCase(noWard, obs("xa-doan", [ord({ ward: "Phường Cửa Nam" })])).fields?.address.ward, false, "xã nhãn null + máy điền = đoán");
  assert.equal(scoreOrderCase(verifyLabel, obs("dong", [ord({ addressLine: "so 7 ngo thu, p hoan kiem hn" })])).fields?.address.line, true, "dòng địa chỉ so CHỨA, bỏ dấu");
  assert.equal(scoreOrderCase(verifyLabel, obs("dong-ranh-gioi", [ord({ addressLine: "Số 7 ngõ Thửa, Phường Hoàn Kiếm" })])).fields?.address.line, false, "so theo ranh giới từ: «ngõ Thử» không khớp «ngõ Thửa»");
  assert.deepEqual(scoreOrderCase(verifyLabel, obs("dong-sai", [ord({ addressLine: "10 đường Mẫu, Phường Hoàn Kiếm" })])).fields?.wrong, ["address_line"]);
  assert.deepEqual(scoreOrderCase(verifyLabel, obs("tinh-sai", [ord({ province: "Thành phố Hải Phòng" })])).fields?.wrong, ["province"]);

  // Gộp: tử / mẫu từng chỉ số, ca sai, cờ CRITICAL, tách căn cứ.
  const scores = [s1, s2, s3, s4, s5, s6, s9];
  const sum = summarizeOrderGolden(scores);
  const nd = (m: (typeof ORDER_GOLDEN_METRICS)[number]) => [sum.metrics[m].numerator, sum.metrics[m].denominator];
  assert.deepEqual(
    Object.fromEntries(ORDER_GOLDEN_METRICS.map((m) => [m, nd(m)])),
    {
      order_intent_recall: [5, 6],
      order_intent_precision: [5, 6],
      sku_accuracy: [4, 5],
      quantity_accuracy: [4, 5],
      phone_accuracy: [5, 5],
      address_component_accuracy: [15, 15],
      price_accuracy: [5, 5],
      total_accuracy: [4, 5],
      false_auto_confirm_rate: [2, 6],
      missed_confirm_rate: [1, 1],
      duplicate_order_rate: [1, 7],
      missing_order_rate: [1, 6],
      human_correction_rate: [1, 5],
    },
  );
  assert.equal(sum.metrics.false_auto_confirm_rate.rate, 2 / 6);
  assert.deepEqual(sum.critical.map((c) => [c.metric, c.cases]), [["false_auto_confirm_rate", ["chot-sai", "ao"]], ["duplicate_order_rate", ["trung"]]], "chốt sai + đơn trùng vượt 0 ⇒ cờ CRITICAL kèm ca");
  assert.deepEqual(sum.falseAutoConfirmWithOrder, { rate: 1 / 5, numerator: 1, denominator: 5 }, "bỏ ca NO_ORDER khỏi mẫu số chốt sai");
  assert.deepEqual(sum.falseAutoConfirmByBasis, { NO_CONSENT: { rate: 1 / 5, numerator: 1, denominator: 5 }, NO_ORDER: { rate: 1, numerator: 1, denominator: 1 } });
  assert.deepEqual([sum.failing.order_intent_recall, sum.failing.order_intent_precision, sum.failing.quantity_accuracy, sum.failing.missed_confirm_rate, sum.failing.missing_order_rate], [["thieu"], ["ao"], ["sai-sl"], ["lo-chot"], ["thieu"]]);
  assert.deepEqual(summarizeOrderGolden(scores), sum, "hàm thuần: chạy lại ra đúng như cũ");

  // Mẫu số 0 ⇒ null (CHƯA ĐO ĐƯỢC), không 0; tỷ lệ null không bao giờ bật cờ.
  const empty = summarizeOrderGolden([s7]);
  assert.deepEqual(empty.metrics.duplicate_order_rate, { rate: null, numerator: 0, denominator: 0 }, "không đơn nào ⇒ tỷ lệ trùng CHƯA ĐO ĐƯỢC");
  for (const m of ["order_intent_recall", "order_intent_precision", "sku_accuracy", "quantity_accuracy", "phone_accuracy", "address_component_accuracy", "price_accuracy", "total_accuracy", "missed_confirm_rate", "missing_order_rate", "human_correction_rate"] as const) {
    assert.equal(empty.metrics[m].rate, null, `${m}: mẫu số 0 ⇒ null`);
  }
  assert.deepEqual(empty.metrics.false_auto_confirm_rate, { rate: 0, numerator: 0, denominator: 1 }, "đo được và bằng 0 — khác CHƯA ĐO ĐƯỢC");
  assert.deepEqual(empty.critical, [], "0 và null không bật cờ");
  assert.equal(summarizeOrderGolden([]).cases, 0);
}

// ─────────────────────────── 2 · DATASET ───────────────────────────

function testOrderGoldenDataset() {
  const cases = ORDER_GOLDEN_CASES;
  assert.ok(cases.length >= 20, `dataset v2 cần ≥ 20 hội thoại, có ${cases.length}`);
  const keys = cases.map((c) => c.key);
  assert.equal(new Set(keys).size, keys.length, "khoá ca không trùng");
  for (const k of keys) assert.match(k, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `khoá ổn định dạng chữ-thường-gạch-nối: ${k}`);
  const missing = SECTION_23_SCENARIOS.filter((s) => !cases.some((c) => c.scenario === s));
  assert.deepEqual(missing, [], "mỗi kịch bản §23 có ít nhất một hội thoại");

  const shop = GOLDEN_SHOPS["order-food"];
  assert.deepEqual(Object.fromEntries(shop.products.map((p) => [p.sku, p.price])), LABEL_PRICES, "giá nhãn = giá ERP của shop thử");
  assert.equal(shop.shippingFee, LABEL_SHIPPING_FEE, "phí ship nhãn = phí ship cấu hình bot của shop thử");

  for (const c of cases) {
    for (const v of ORDER_GOLDEN_VARIANTS) assert.deepEqual(labelProblems(labelFor(c, v)), [], `[${c.key} · ${v}] nhãn tự mâu thuẫn`);
    if (c.confirmWhenAutoConfirmOn) assert.equal(c.confirmWhenAutoConfirmOn.basis, "RULE_AUTO_CONFIRM", `[${c.key}] nhãn riêng của biến thể BẬT chỉ đến từ luật 04/10`);
    assert.equal(c.model === "TRAP", Boolean(c.trap?.trim()), `[${c.key}] ca TRAP phải ghi lỗi model mô phỏng, ca GOOD thì không`);
    assert.ok(c.turns.length > 0 && c.turns.every((t) => t.say.trim().length > 0), `[${c.key}] mỗi lượt có lời khách`);
    if (c.label.order) {
      assert.match(c.label.order.phone, FAKE_PHONE, `[${c.key}] SĐT nhãn phải là số giả 09xx000xxx`);
      for (const l of c.label.order.lines) assert.ok(l.sku in LABEL_PRICES, `[${c.key}] SKU ${l.sku} không có trong shop thử`);
    }
  }

  // KHÔNG PII THẬT (kho PUBLIC): mọi chuỗi trông như SĐT trong MÃ NGUỒN dataset phải là số giả 09xx000xxx.
  const src = readFileSync(CASES_SOURCE, "utf8");
  const phones = [...src.matchAll(/(?:\+?84|0)(?:[\s.-]?\d){8,10}/g)].map((m) => phoneKey(m[0]));
  assert.ok(phones.length >= cases.length, `quét được SĐT trong dataset (${phones.length})`);
  assert.deepEqual(phones.filter((p) => !FAKE_PHONE.test(p)), [], "dataset chỉ được chứa SĐT giả dạng 09xx000xxx");
}

// ─────────────────────────── 3 · KHUNG CHẠY + SỐ ĐO HIỆN TRẠNG ───────────────────────────

async function testOrderGoldenBaseline() {
  const runs: OrderGoldenRun[] = [];
  for (const v of ORDER_GOLDEN_VARIANTS) runs.push(await runOrderGolden(v));
  for (const run of runs) {
    assert.equal(run.cases.length, ORDER_GOLDEN_CASES.length, `[${run.variant}] mọi hội thoại đều chạy`);
    for (const c of run.cases) {
      const def = ORDER_GOLDEN_CASES.find((x) => x.key === c.key);
      assert.ok(def);
      assert.deepEqual(c.scriptIssues, [], `[${run.variant}] ${c.key}: engine hỏi model lệch số vòng kịch bản — kịch bản không còn đi đúng đường đã định`);
      assert.deepEqual(c.toolErrors, def.expectToolErrors ?? [], `[${run.variant}] ${c.key}: máy chủ từ chối công cụ khác với kịch bản định`);
    }
    // Bất biến AN TOÀN đang đúng hôm nay — khẳng định thẳng (không chỉ qua baseline), để một lần cập nhật baseline ẩu không «hợp
    // thức hoá» được đơn trùng hay giá không từ ERP.
    assert.equal(run.summary.metrics.duplicate_order_rate.numerator, 0, `[${run.variant}] không đơn trùng`);
    assert.equal(run.summary.metrics.price_accuracy.rate, 1, `[${run.variant}] đơn giá luôn đọc từ ERP`);
    const lost = run.cases.find((c) => c.key === "mat-trang-thai-goi-lai");
    assert.equal(lost?.observation.orders.length, 1, `[${run.variant}] mất trạng thái rồi khách gửi lại ⇒ khoá lần mua trả lại ĐÚNG đơn cũ`);
  }

  // Số đo hiện trạng = baseline đã duyệt, từng ô.
  const expected = JSON.parse(readFileSync(ORDER_GOLDEN_BASELINE_JSON, "utf8")) as unknown;
  const got = JSON.parse(JSON.stringify(compactBaseline(runs))) as unknown;
  const d = firstDiff(expected, got);
  assert.equal(
    d,
    null,
    d
      ? `Số đo đơn vàng v2 đổi tại ${d.path}\n  cũ: ${JSON.stringify(d.expected)}\n  mới: ${JSON.stringify(d.actual)}\nNếu thay đổi là CỐ Ý: npx tsx tests/order-golden/update-baseline.ts, sửa nhận định trong BASELINE.md cho khớp, đưa diff vào PR.`
      : "",
  );
  // Tài liệu chủ shop đọc không được cũ hơn mã: khối bảng số trong BASELINE.md trùng nguyên văn khối dựng lại.
  const md = readFileSync(ORDER_GOLDEN_BASELINE_MD, "utf8").replace(/\r\n/g, "\n");
  assert.equal(tablesBlockOf(md), renderBaselineTables(runs).trim(), "bảng số trong BASELINE.md lệch lượt chạy — npx tsx tests/order-golden/update-baseline.ts");

  const nd = (run: OrderGoldenRun, m: "false_auto_confirm_rate" | "duplicate_order_rate" | "missing_order_rate") => `${run.summary.metrics[m].numerator}/${run.summary.metrics[m].denominator}`;
  const [off, on] = runs;
  const critical = runs.flatMap((r) => r.summary.critical.map((c) => `${r.variant}:${c.metric}`));
  console.log(
    `  ✓ bộ đo đơn vàng v2: ${ORDER_GOLDEN_CASES.length} hội thoại có nhãn × 2 biến thể qua chatTurn thật; bộ đo thuần (mẫu số 0 ⇒ null, cờ CRITICAL); số đo hiện trạng khớp BASELINE — chốt sai TẮT ${nd(off, "false_auto_confirm_rate")} · BẬT ${nd(on, "false_auto_confirm_rate")}, đơn trùng ${nd(off, "duplicate_order_rate")} · ${nd(on, "duplicate_order_rate")}, thiếu đơn ${nd(off, "missing_order_rate")} · ${nd(on, "missing_order_rate")}${critical.length ? ` — ⚠ CRITICAL (luật hiện hành, chờ chủ shop quyết — tests/order-golden/BASELINE.md): ${critical.join(", ")}` : ""}`,
  );
}

export async function testOrderGolden() {
  testOrderGoldenMetrics();
  testOrderGoldenDataset();
  await testOrderGoldenBaseline();
}

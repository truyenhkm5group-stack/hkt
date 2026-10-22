/**
 * ═══════════ P0 22/10/2026 — HÀNG RÀO SỐ LƯỢNG / ĐƠN VỊ (đơn HSLC #8037F35A, đã ẩn danh) ═══════════
 *
 * Ca thật (conv-money-trace run 39716504139): đơn TỰ CHỐT 540.000 ₫ ⇒ khách «Thêm 10 nem hải sản tôm bề bề» (nem bán «Hộp 10 cái»,
 * 120.000 ₫/hộp) ⇒ giỏ đọc «10 nem» thành 10 GÓI khách nói tường minh ⇒ model gọi update_draft_order nem × 1 ⇒ hàng rào cam kết từ chối
 * «hạ số lượng khách đã chốt» ⇒ model gọi lại × 10 ⇒ OK ⇒ đơn đã chốt 1.740.000 ₫ và bot báo khách con số đó. Chuỗi chatTurn dưới đây
 * dựng ĐÚNG chuỗi #30 → #39 (model giả làm đúng hai lời gọi của ca thật); phải ĐỎ trên main trước bản sửa.
 * Dữ liệu tự dựng: tên «Lan», SĐT 0961007xxx, địa chỉ thử — không có tin khách thật.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { AUTO_CONFIRM_COMPLETE_SETTING_KEY } from "@/lib/constants/manual-orders";
import { amountsIn, applyCustomerCartMessage, bareResolution, cartDraftDiff, commitmentViolation, packQuestion, quantityUnitIssue, type AskedLine } from "@/lib/sales-chatbot/cart-commitment";
import { staffTotalConflict, totalClauses } from "@/lib/sales-chatbot/cancel-recovery";
import { extractVndAmounts } from "@/lib/sales-chatbot/claim-guard";
import { QUICK_REPLY_SETTING_KEY } from "@/lib/sales-chatbot/quick-replies-shared";
import { SHOP_SAID } from "@/lib/sales-chatbot/engine";
import { createProductCore } from "@/lib/records/product-create";
import { packMultiplierLeaks, scanThreadQuality, type QualityMsg } from "@/lib/sales-quality/detectors";
import { CONFIRMED_EDIT_MAX_GROWTH, ORDER_GUARD_CODES } from "@/lib/constants/sales-order-guard";
import { SALES_QUALITY_CODES, SALES_QUALITY_SPEC } from "@/lib/constants/sales-quality";
import { setSettingJson } from "@/lib/settings";
import { runGoldenCases, say, tool, type GoldenCase, type GoldenTurn, type StepCtx } from "./sales-agent-golden/harness";

const NEM = "Nem hải sản tôm bề bề";
const CATALOG = ["Ruốc bông tôm 100%", NEM, "Chả mực giã tay"];
const NOW = new Date();
const line = (productId: string, name: string, quantity: number): AskedLine => ({ variantId: `v-${productId}`, productId, name, quantity, weightGrams: null });
const NEM_LINE = (q: number) => line("p-nem", `${NEM} · Size: Hộp 10 cái`, q);

/* ───── 1 · Thuần ───── */
function testThuan() {
  // Số TRẦN (không chữ đơn vị) mang cờ `bare`; «10 cái» / «10 hộp» thì không.
  assert.equal(amountsIn("Thêm 10 nem hải sản tôm bề bề", CATALOG)[0]?.bare, true, "«10 nem» không kèm đơn vị");
  assert.equal(amountsIn("Thêm 10 cái nem hải sản tôm bề bề", CATALOG)[0]?.pieces, true);
  assert.notEqual(amountsIn("Thêm 10 hộp nem hải sản tôm bề bề", CATALOG)[0]?.bare, true, "«10 hộp» nói rõ đơn vị");
  const cart = (text: string) => applyCustomerCartMessage(undefined, text, 30, NOW, { catalog: CATALOG });
  const c10 = cart("Thêm 10 nem hải sản tôm bề bề");
  assert.equal(c10?.selectedItems[0].bare, true, "dòng giỏ giữ dấu số trần");

  // Thẩm quyền: suy ra (bội quy cách) / mơ hồ / nói rõ.
  assert.deepEqual(bareResolution({ bare: true, unit: "pack", quantity: 10 }, [NEM_LINE(1)]), { kind: "INFERRED", packs: 1, perPack: 10 });
  assert.deepEqual(bareResolution({ bare: true, unit: "pack", quantity: 20 }, [NEM_LINE(1)]), { kind: "INFERRED", packs: 2, perPack: 10 });
  assert.deepEqual(bareResolution({ bare: true, unit: "pack", quantity: 5 }, [NEM_LINE(1)]), { kind: "AMBIGUOUS", perPack: 10 });
  assert.deepEqual(bareResolution({ bare: false, unit: "pack", quantity: 10 }, [NEM_LINE(1)]), { kind: "STATED" }, "«10 hộp» có thẩm quyền như cũ");
  assert.deepEqual(bareResolution({ bare: true, unit: "pack", quantity: 1 }, [line("p-muc", "Chả mực giã tay · Size: 1kg", 1)]), { kind: "STATED" }, "món không bán theo hộp N cái ⇒ số trần là số gói (#855 «1 mực»)");
  assert.deepEqual(bareResolution({ bare: true, unit: "pack", quantity: 2 }, [line("p-hop", "Ruốc · Size: Hộp", 1)]), { kind: "STATED" }, "quy cách không ghi số cái ⇒ luật cũ");

  // GỐC CỦA CA: hàng rào cam kết KHÔNG còn chặn 1 hộp vì «10 nem» (trước: «KHÔNG được hạ … từ 10 gói xuống 1 gói»).
  assert.equal(commitmentViolation(c10, [NEM_LINE(1)], 31), null, "1 hộp 10 cái = 10 nem ⇒ không chặn");
  assert.equal(cartDraftDiff(c10, [NEM_LINE(1)]).length, 0, "đơn 1 hộp KHÔNG lệch giỏ");
  assert.deepEqual(cartDraftDiff(c10, [NEM_LINE(10)]).map((d) => [d.wantAmount, d.gotAmount]), [[1, 10]], "đơn 10 hộp LỆCH giỏ (suy ra 1 hộp)");

  // Hàng rào số lượng / đơn vị.
  assert.equal(quantityUnitIssue(c10, [NEM_LINE(1)]), null, "1 hộp ⇒ qua");
  const sai = quantityUnitIssue(c10, [NEM_LINE(10)]);
  assert.equal(sai?.code, "PACK_MULTIPLIER_MISMATCH", "10 hộp cho «10 nem» ⇒ sai bội");
  assert.match(sai?.message ?? "", /10 cái = 1 hộp \(quantity 1\)/);
  const c5 = cart("Thêm 5 nem hải sản tôm bề bề");
  const mo = quantityUnitIssue(c5, [NEM_LINE(1)]);
  assert.equal(mo?.code, "QUANTITY_UNIT_AMBIGUOUS", "5 không chia hết 10 ⇒ mơ hồ");
  assert.equal(mo?.ask, packQuestion(NEM, 10));
  assert.equal(mo?.ask, "Dạ nem hải sản tôm bề bề bên em đóng hộp 10 cái, mình lấy mấy hộp ạ?", "đúng một câu ngắn");
  assert.equal(quantityUnitIssue(c5, [line("p-muc", "Chả mực giã tay · Size: 1kg", 1)]), null, "sản phẩm không có trong đơn đề nghị ⇒ không xét");
  assert.equal(quantityUnitIssue(cart("Thêm 10 hộp nem hải sản tôm bề bề"), [NEM_LINE(10)]), null, "«10 hộp» ⇒ 10 hộp hợp lệ");
  assert.equal(quantityUnitIssue(cart("Thêm 10 cái nem hải sản tôm bề bề"), [NEM_LINE(1)]), null, "«10 cái» ⇒ 1 hộp hợp lệ");

  // Hằng số ở MỘT chỗ; mọi mã chặn là mã 2B có đặc tả.
  assert.equal(CONFIRMED_EDIT_MAX_GROWTH, 2);
  for (const c of [...ORDER_GUARD_CODES, "STAFF_AI_QUOTE_CONFLICT" as const]) {
    assert.ok((SALES_QUALITY_CODES as readonly string[]).includes(c), `mã 2B: ${c}`);
    assert.ok(SALES_QUALITY_SPEC[c].action.length > 20, `${c} có việc phải làm`);
  }
  console.log("  ✓ thuần: số trần ≠ số hộp · bội quy cách ⇒ suy ra · không chia hết ⇒ một câu hỏi · hàng rào cam kết không ép số suy ra");
}

/* ───── 1b · Mã nguồn: MỌI đường ghi đơn, MỘT hằng số ───── */
function testNguon() {
  const tools = readFileSync("lib/sales-chatbot/tools.ts", "utf8");
  assert.equal((tools.match(/quantityUnitIssue\(state\.cart, priced\.asked\)/g) ?? []).length, 2, "hàng rào số lượng / đơn vị ở CẢ sửa đơn nháp lẫn chốt đơn");
  assert.ok(tools.indexOf("quantityUnitIssue(state.cart, priced.asked)") < tools.indexOf("commitmentViolation(state.cart, priced.asked"), "chạy TRƯỚC hàng rào cam kết");
  assert.match(tools, /after > before \* CONFIRMED_EDIT_MAX_GROWTH/, "ngưỡng tổng tăng đọc hằng số");
  for (const f of ["lib/sales-chatbot/tools.ts", "lib/sales-chatbot/cart-commitment.ts", "lib/sales-quality/detectors.ts"]) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /before \* 2(?!\d)|MAX_GROWTH\s*=\s*2/, `${f}: không lặp số ×2 ngoài lib/constants/sales-order-guard.ts`);
  }
  console.log("  ✓ mã nguồn: hàng rào trên mọi đường ghi đơn, trước hàng rào cam kết · ngưỡng ×2 ở MỘT hằng số");
}

/* ───── 2 · Bộ dò 2B ───── */
function testBoDo() {
  const at = (m: number) => new Date(Date.UTC(2031, 2, 1, 3, m));
  const text = (t: string) => [{ type: "text", text: t }];
  const msgs: QualityMsg[] = [
    { seq: 1, role: "user", at: at(0), content: text("Thêm 10 nem hải sản tôm bề bề") },
    { seq: 2, role: "assistant", at: at(1), content: [{ type: "tool_use", name: "update_draft_order", input: {} }] },
    { seq: 3, role: "user", at: at(1), content: [{ type: "tool_result", isError: true, content: JSON.stringify({ error: "x", guard: "PACK_MULTIPLIER_MISMATCH" }) }] },
    { seq: 4, role: "assistant", at: at(2), content: [{ type: "tool_use", name: "update_draft_order", input: {} }] },
    { seq: 5, role: "user", at: at(2), content: [{ type: "tool_result", isError: true, content: JSON.stringify({ error: "y", guard: "CART_TOTAL_CONFLICT" }) }] },
    { seq: 6, role: "assistant", at: at(3), content: text("Dạ tổng đơn của mình là 1.740.000 ₫ ạ.") },
    { seq: 7, role: "assistant", at: at(4), content: text(`${SHOP_SAID} Dạ đơn mình tổng 400.000 ₫ nha chị`) },
    { seq: 8, role: "assistant", at: at(5), content: text(`${SHOP_SAID} Dạ tổng 1.740.000 ₫ ạ`) },
    { seq: 9, role: "user", at: at(6), content: [{ type: "tool_result", isError: true, content: JSON.stringify({ error: "khác" }) }] },
  ];
  const r = scanThreadQuality(msgs, { from: at(0), to: at(30), templates: [], products: [] });
  const n = (c: string) => r.hits.filter((h) => h.code === c).length;
  assert.equal(n("PACK_MULTIPLIER_MISMATCH"), 1);
  assert.equal(n("CART_TOTAL_CONFLICT"), 1);
  assert.equal(n("STAFF_AI_QUOTE_CONFLICT"), 1, "page 400.000 ≠ bot 1.740.000 — tin page trùng tổng bot không tính");
  assert.equal(n("QUANTITY_UNIT_AMBIGUOUS") + n("ORDER_UPDATED_WITHOUT_VERIFIED_CONSENT"), 0, "lỗi công cụ không mang mã ⇒ không tính");
  assert.equal(r.bases.orderWrites, 2, "mẫu số = lần gọi công cụ ghi đơn");
  assert.equal(r.bases.staffTotals, 2, "mẫu số = tin page báo tổng");
  assert.equal(r.hits.find((h) => h.code === "STAFF_AI_QUOTE_CONFLICT")?.source, undefined, "không có tập mẫu tự động ⇒ không gắn nguồn");
  // Mẫu tự động Pancake in tổng CỐ ĐỊNH (ca #8037F35A) ⇒ cùng mã, nhánh nguồn «PAGE_AUTOMATION».
  const auto = scanThreadQuality(msgs, { from: at(0), to: at(30), templates: [], products: [], automationTexts: new Set(["Dạ đơn mình tổng 400.000 ₫ nha chị"]) });
  assert.deepEqual(auto.hits.filter((h) => h.code === "STAFF_AI_QUOTE_CONFLICT").map((h) => h.source), ["PAGE_AUTOMATION"], "tổng lệch từ mẫu tự động page");
  // Một định nghĩa «câu báo tổng» cho cả luật chuyển người lẫn bộ dò.
  assert.deepEqual(totalClauses("Dạ 1kg 280k, tổng 400.000 ₫ nha"), [[400_000]], "đơn giá không phải tổng");
  // Mọi cách viết cùng một tổng (dấu nghìn chấm / phẩy · «k» có dấu nghìn · «tr»): đọc ra CÙNG một số.
  for (const t of ["tổng 1.740.000 ₫", "tổng 1,740,000 ₫", "tổng 1.740k", "tổng 1,740k", "tổng 1tr740", "tổng 1740k"]) assert.deepEqual(totalClauses(t), [[1_740_000]], `«${t}» = 1.740.000 ₫`);
  assert.deepEqual(totalClauses("tổng 1,5tr"), [[1_500_000]], "thập phân của triệu giữ nguyên");
  // Bộ đọc tiền DÙNG CHUNG (hàng rào khẳng định giá · claim-guard · quote · conv-money-trace): chỉ «N.NNNk» đổi nghĩa (dấu nghìn); ca cũ y nguyên.
  const vnd: [string, number][] = [["1.740k", 1_740_000], ["1,740k", 1_740_000], ["2.5k", 2_500], ["1.5k", 1_500], ["1.000", 1_000], ["30.000đ", 30_000], ["1.200.000", 1_200_000], ["350k", 350_000], ["1,5tr", 1_500_000], ["280.000 ₫", 280_000]];
  for (const [t, n] of vnd) assert.deepEqual(extractVndAmounts(t), [n], `extractVndAmounts(«${t}») = ${n}`);
  assert.equal(staffTotalConflict(["tổng 400.000 ₫"], [1_740_000]), 400_000);
  assert.equal(staffTotalConflict(["phí ship 30.000 ₫"], [1_740_000]), null);
  console.log("  ✓ 2B: mã chặn đọc từ ô guard của kết quả công cụ · tổng page ≠ tổng bot · mẫu số lần ghi đơn / tin báo tổng");
}

/* ───── 2b · PACK_MULTIPLIER_LEAKED — «lọt tới khách» (sổ tái diễn đọc mã này) ───── */
function testLotToiKhach() {
  const NEM_NAME = `${NEM} (Size: Hộp 10 cái)`;
  const products = [{ name: NEM, skus: ["NEM-10"] }, { name: "Ruốc bông tôm 100%", skus: ["RUOC-TOM"] }];
  const names = products.map((p) => p.name);
  // Hàm thuần: số hộp = số cái / số trần khách nói (bội quy cách) ⇒ lọt; đúng số hộp / khách nói rõ «hộp» ⇒ không.
  assert.deepEqual(packMultiplierLeaks("Thêm 10 nem hải sản tôm bề bề", [{ name: NEM_NAME, quantity: 10 }], names), [{ name: NEM, quantity: 10, perPack: 10 }], "ca #8037F35A: 10 nem ⇒ 10 hộp");
  assert.deepEqual(packMultiplierLeaks("Thêm 10 cái nem hải sản tôm bề bề", [{ name: NEM_NAME, quantity: 10 }], names).length, 1, "«10 cái» ⇒ 10 hộp cũng là lọt");
  assert.deepEqual(packMultiplierLeaks("Thêm 10 nem hải sản tôm bề bề", [{ name: NEM_NAME, quantity: 1 }], names), [], "đúng 1 hộp ⇒ không bắt");
  assert.deepEqual(packMultiplierLeaks("Thêm 10 hộp nem hải sản tôm bề bề", [{ name: NEM_NAME, quantity: 10 }], names), [], "khách nói rõ «10 hộp» ⇒ không bắt");
  assert.deepEqual(packMultiplierLeaks("Thêm 5 nem hải sản tôm bề bề", [{ name: NEM_NAME, quantity: 5 }], names), [], "không phải bội quy cách ⇒ không kết luận lọt (đã là việc của QUANTITY_UNIT_AMBIGUOUS)");
  assert.deepEqual(packMultiplierLeaks("Thêm 1 hộp ruốc", [{ name: "Ruốc bông tôm 100% (Size: 250g)", quantity: 1 }], names), [], "mẫu mã không bán theo hộp N cái ⇒ không xét");
  assert.deepEqual(packMultiplierLeaks("giao chiều nhé", [{ name: NEM_NAME, quantity: 10 }], names), [], "tin khách không nói số món ⇒ không bắt");

  // Chuỗi #30 → #39 của ca thật trên LỊCH SỬ: lần × 1 bị chặn, lần × 10 ghi THÀNH CÔNG ⇒ bắt, mốc = lượt ghi đơn.
  const at = (m: number) => new Date(Date.UTC(2031, 2, 1, 3, m));
  const text = (t: string) => [{ type: "text", text: t }];
  const result = (q: number) => JSON.stringify({ order_code: "#X", lines: [{ variant_id: "v-ruoc", name: "Ruốc bông tôm 100% (Size: 250g)", quantity: 1 }, { variant_id: "v-nem", name: NEM_NAME, quantity: q }] });
  const chuoi = (finalQty: number): QualityMsg[] => [
    { seq: 1, role: "user", at: at(0), content: text("Thêm 10 nem hải sản tôm bề bề") },
    { seq: 2, role: "assistant", at: at(1), content: [{ type: "tool_use", id: "u1", name: "update_draft_order", input: {} }] },
    { seq: 3, role: "user", at: at(1), content: [{ type: "tool_result", toolUseId: "u1", isError: true, content: JSON.stringify({ error: "KHÔNG được hạ" }) }] },
    { seq: 4, role: "assistant", at: at(2), content: [{ type: "tool_use", id: "u2", name: "update_draft_order", input: {} }] },
    { seq: 5, role: "user", at: at(2), content: [{ type: "tool_result", toolUseId: "u2", isError: false, content: result(finalQty) }] },
    { seq: 6, role: "assistant", at: at(3), content: text("Dạ em thêm vào đơn rồi ạ.") },
    // Lượt sửa sau (đổi ghi chú) đọc lại đúng các dòng cũ ⇒ KHÔNG bắt lần hai cho cùng (món, số).
    { seq: 7, role: "user", at: at(4), content: text("Thêm 10 nem hải sản tôm bề bề giao chiều nhé") },
    { seq: 8, role: "assistant", at: at(5), content: [{ type: "tool_use", id: "u3", name: "update_draft_order", input: {} }] },
    { seq: 9, role: "user", at: at(5), content: [{ type: "tool_result", toolUseId: "u3", isError: false, content: result(finalQty) }] },
  ];
  const w = { from: at(0), to: at(30), templates: [], products };
  const sai = scanThreadQuality(chuoi(10), w).hits.filter((h) => h.code === "PACK_MULTIPLIER_LEAKED");
  assert.equal(sai.length, 1, "trước bản sửa (ghi 10 hộp) ⇒ bắt đúng MỘT lần");
  assert.equal(sai[0].at.getTime(), at(2).getTime(), "mốc của hit = lượt ghi đơn (sổ tái diễn đếm theo mốc từng hit)");
  assert.equal(scanThreadQuality(chuoi(1), w).hits.filter((h) => h.code === "PACK_MULTIPLIER_LEAKED").length, 0, "đúng 1 hộp ⇒ không bắt");
  // Kết quả công cụ KHÔNG phải ghi đơn (calculate_cart — báo giá) mang cùng dòng ⇒ không phải đơn đã ghi.
  const quote = chuoi(10).map((m) => (m.seq === 4 ? { ...m, content: [{ type: "tool_use", id: "u2", name: "calculate_cart", input: {} }] } : m)).filter((m) => m.seq < 7);
  assert.equal(scanThreadQuality(quote, w).hits.filter((h) => h.code === "PACK_MULTIPLIER_LEAKED").length, 0, "báo giá không phải đơn đã ghi");
  assert.ok((SALES_QUALITY_CODES as readonly string[]).includes("PACK_MULTIPLIER_LEAKED"), "mã 2B có đặc tả (không khẳng định «phần tử cuối» — nhánh khác cũng thêm mã ở cuối)");
  console.log("  ✓ 2B PACK_MULTIPLIER_LEAKED: chuỗi #30 → #39 ghi 10 hộp ⇒ bắt một lần, mốc = lượt ghi · đúng 1 hộp / «10 hộp» / không bội / báo giá ⇒ không bắt");
}

/* ───── 3 · chatTurn: chuỗi #30 → #39 và biến thể ───── */
const ADDR = "9 Hai Bà Trưng, Phường Hoàn Kiếm, Thành phố Hà Nội";
const INFO = (phone: string) => `Cho chị 1 hộp ruốc bông tôm, Lan ${phone}, ${ADDR}`;
const orderInfo = (phone: string) => [
  () => [tool("create_customer", { name: "Lan", phone, address: ADDR })],
  ({ v }: StepCtx) => [tool("create_draft_order", { items: [{ variant_id: v("RUOC-TOM"), quantity: 1 }] })],
  () => [say("Dạ em lên đơn 1 × Ruốc bông tôm 100% cho mình rồi ạ, shop giao theo thông tin mình vừa gửi nhé.")],
];
const items = (v: StepCtx["v"], nem: number) => ({ items: [{ variant_id: v("RUOC-TOM"), quantity: 1 }, { variant_id: v("NEM-10"), quantity: nem }] });
const failed = (r: StepCtx["results"]) => r.some((x) => typeof x.error === "string");
/** Đúng hai lời gọi của ca thật: × 1 trước; bị từ chối thì làm theo lời từ chối của máy chủ (× 10). */
const caThat: GoldenTurn["ai"] = [
  ({ v }) => [tool("update_draft_order", items(v, 1))],
  ({ v, results }) => (failed(results) ? [tool("update_draft_order", items(v, 10))] : [say("Dạ em thêm 1 hộp nem hải sản tôm bề bề (10 cái) vào đơn cho mình rồi ạ.")]),
  () => [say("Dạ em thêm vào đơn cho mình rồi ạ.")],
];
const once = (nem: number, ok: string): GoldenTurn["ai"] => [({ v }) => [tool("update_draft_order", items(v, nem))], ({ results }) => [say(failed(results) ? "Dạ nem hải sản tôm bề bề bên em đóng hộp 10 cái, mình lấy mấy hộp ạ?" : ok)]];
const turn = (n: number, sayText: string, ai: GoldenTurn["ai"]): GoldenCase["turns"] => [{ say: INFO(`09610070${n}`), ai: orderInfo(`09610070${n}`) }, { say: sayText, ai }];

const CASES: GoldenCase[] = [
  { key: "qg-ca-that", title: "Ca #8037F35A: «Thêm 10 nem» với nem hộp 10 cái ⇒ 1 hộp, KHÔNG 10 hộp", shop: "food", channel: "WEB", turns: turn(11, "Thêm 10 nem hải sản tôm bề bề", caThat) },
  { key: "qg-10-cai", title: "«10 cái» ⇒ 1 hộp", shop: "food", channel: "WEB", turns: turn(12, "Thêm 10 cái nem hải sản tôm bề bề", once(1, "Dạ em thêm 1 hộp rồi ạ.")) },
  { key: "qg-1-hop", title: "«1 hộp» ⇒ 1 hộp", shop: "food", channel: "WEB", turns: turn(13, "Thêm 1 hộp nem hải sản tôm bề bề", once(1, "Dạ em thêm 1 hộp rồi ạ.")) },
  { key: "qg-20-nem", title: "«20 nem» (bội quy cách) ⇒ 2 hộp", shop: "food", channel: "WEB", turns: turn(14, "Thêm 20 nem hải sản tôm bề bề", once(2, "Dạ em thêm 2 hộp rồi ạ.")) },
  { key: "qg-5-nem", title: "«5 nem» (không chia hết) ⇒ không ghi, hỏi đúng một câu", shop: "food", channel: "WEB", turns: turn(15, "Thêm 5 nem hải sản tôm bề bề", once(1, "Dạ em thêm rồi ạ.")) },
  { key: "qg-sai-boi", title: "«10 nem» mà model ghi thẳng 10 hộp trên đơn đã chốt ⇒ không ghi, chuyển người", shop: "food", channel: "WEB", turns: turn(16, "Thêm 10 nem hải sản tôm bề bề", once(10, "Dạ em thêm rồi ạ.")) },
  { key: "qg-10-hop", title: "«10 hộp» khách nói RÕ đơn vị ⇒ 10 hộp, kể cả khi tổng gấp > 2 lần (lời khách là căn cứ)", shop: "food", channel: "WEB", turns: turn(17, "Thêm 10 hộp nem hải sản tôm bề bề", once(10, "Dạ em thêm 10 hộp rồi ạ.")) },
  { key: "qg-50-nem", title: "«50 nem» (suy ra 5 hộp) trên đơn đã chốt, tổng gấp 2,7 lần ⇒ không ghi tự động, chuyển người", shop: "food", channel: "WEB", turns: turn(19, "Thêm 50 nem hải sản tôm bề bề", once(5, "Dạ em thêm 5 hộp rồi ạ.")) },
  {
    key: "qg-khong-loi",
    title: "Khách không nói số lượng mà model tăng đơn đã chốt ⇒ không ghi, chuyển người",
    shop: "food",
    channel: "WEB",
    turns: turn(18, "giao giờ hành chính giúp chị nhé", [({ v }) => [tool("update_draft_order", { items: [{ variant_id: v("RUOC-TOM"), quantity: 2 }] })], () => [say("Dạ vâng ạ.")]]),
  },
];

async function orderLines(conversationId: string, ids: ReadonlyMap<string, string>) {
  const db = await getDb();
  const [o] = await db.select({ id: schema.orders.id, total: schema.orders.totalPriceAfterDiscount }).from(schema.orders).where(eq(schema.orders.salesConversationId, conversationId)).limit(1);
  if (!o) return { lines: [] as string[], total: null };
  const sku = new Map([...ids.entries()].map(([k, id]) => [id, k]));
  const lines = (await db.select({ v: schema.orderItems.variantId, q: schema.orderItems.quantity }).from(schema.orderItems).where(eq(schema.orderItems.orderId, o.id))).map((l) => `${sku.get(String(l.v)) ?? l.v}×${l.q}`).sort();
  return { lines, total: o.total === null ? null : Number(o.total) };
}

async function testChatTurn() {
  const seen = new Set<string>();
  await runGoldenCases(CASES, {
    orgSuffix: "-qg",
    beforeCase: async (_c, ctx) => {
      const db = await getDb();
      if (!ctx.ids.get("NEM-10")) {
        const r = await createProductCore(await ctx.admin(), { name: NEM, code: "NEM-10", unit: "hộp", retailPrice: 120_000, cost: null, variants: [{ sku: "NEM-10", size: "Hộp 10 cái", color: "", retailPrice: 120_000, cost: null, selling: true }] });
        if (!r.ok) throw new Error(`không tạo được NEM-10: ${JSON.stringify(r)}`);
        const vRow = await db.query.productVariants.findFirst({ where: eq(schema.productVariants.productId, r.id) });
        (ctx.ids as Map<string, string>).set("NEM-10", vRow!.id);
        const [rc] = await db.insert(schema.stockReceipts).values({ kind: "RECEIPT", receivedAt: new Date(), reference: "QG-NAP", totalQuantity: 200, createdBy: "test" }).returning({ id: schema.stockReceipts.id });
        await db.insert(schema.stockReceiptItems).values([{ receiptId: rc.id, variantId: vRow!.id, quantity: 100, unitCost: 60_000 }, { receiptId: rc.id, variantId: ctx.ids.get("RUOC-TOM")!, quantity: 100, unitCost: 100_000 }]);
      }
      await setSettingJson(QUICK_REPLY_SETTING_KEY, { enabled: false, aiMatch: false, upsellReplyId: null, autoLearn: false, autoActivate: false });
      await setSettingJson(AUTO_CONFIRM_COMPLETE_SETTING_KEY, { enabled: true });
    },
    afterCase: async (c, ctx, t) => {
      seen.add(c.key);
      const { lines, total } = await orderLines(ctx.conversationId, ctx.ids);
      const last = t.turns[t.turns.length - 1];
      const shown = last.shown.join(" | ");
      const results = JSON.stringify(last.rounds.map((r) => r.results));
      if (c.key !== "qg-10-hop") assert.ok(!lines.includes("NEM-10×10"), `[${c.key}] KHÔNG BAO GIỜ 10 hộp từ «10 nem»: ${lines.join(", ")} · ${results.slice(0, 500)}`);
      if (c.key === "qg-ca-that" || c.key === "qg-10-cai" || c.key === "qg-1-hop") {
        assert.deepEqual(lines, ["NEM-10×1", "RUOC-TOM×1"], `[${c.key}] đúng 1 hộp: ${lines.join(", ")} · ${results.slice(0, 600)}`);
        assert.equal(total, 470_000, `[${c.key}] tổng 350.000 + 120.000`);
        assert.doesNotMatch(shown, /1\.550\.000|1\.200\.000/, `[${c.key}] không báo tổng 10 hộp: ${shown}`);
      }
      if (c.key === "qg-10-hop") {
        assert.deepEqual(lines, ["NEM-10×10", "RUOC-TOM×1"], `[qg-10-hop] khách nói «10 hộp» ⇒ 10 hộp: ${lines.join(", ")} · ${results.slice(0, 400)}`);
        assert.notEqual(t.final.status, "HANDOFF", "lời khách rõ đơn vị không phải tổng bất thường");
        assert.match(shown, /1\.550\.000 ₫/, `[qg-10-hop] báo lại TỔNG ERP mới ngay trong câu (khách thấy nếu gõ nhầm): ${shown}`);
      }
      if (c.key === "qg-20-nem") assert.deepEqual(lines, ["NEM-10×2", "RUOC-TOM×1"], `[qg-20-nem] 2 hộp: ${lines.join(", ")} · ${results.slice(0, 400)}`);
      if (c.key === "qg-5-nem") {
        assert.deepEqual(lines, ["RUOC-TOM×1"], `[qg-5-nem] không ghi: ${lines.join(", ")}`);
        assert.match(results, /QUANTITY_UNIT_AMBIGUOUS/, "[qg-5-nem] mã chặn trong kết quả công cụ");
        assert.match(shown, /mình lấy mấy hộp ạ\?/, `[qg-5-nem] hỏi đúng một câu: ${shown}`);
      }
      if (c.key === "qg-sai-boi" || c.key === "qg-50-nem" || c.key === "qg-khong-loi") {
        assert.deepEqual(lines, ["RUOC-TOM×1"], `[${c.key}] đơn đã chốt giữ nguyên: ${lines.join(", ")} · ${results.slice(0, 400)}`);
        assert.equal(t.final.status, "HANDOFF", `[${c.key}] chuyển người: ${JSON.stringify(t.final).slice(0, 300)}`);
        // Công cụ trả `requireHuman` ⇒ lượt dừng ở bước chuyển người (bộ chạy không chụp kết quả công cụ) — đọc mã qua LÝ DO chuyển người.
        const why = String(t.final.handoffReason ?? "");
        assert.match(why, { "qg-sai-boi": /không kèm đơn vị, đơn đề nghị sai bội quy cách hộp/, "qg-50-nem": /tổng 350\.000 ₫ ⇒ 950\.000 ₫ \(gấp 2,7 lần\)/, "qg-khong-loi": /đề nghị tăng Ruốc bông tôm 100% chưa có lời khách/ }[c.key]!, `[${c.key}] đúng lý do chặn: ${why} · ${results.slice(0, 300)}`);
        assert.doesNotMatch(shown, /Tổng đơn mới|đã cập nhật|1\.550\.000|1\.470\.000/, `[${c.key}] không nói đã sửa / không báo tổng mới: ${shown}`);
      }
    },
  });
  assert.equal(seen.size, CASES.length, "mọi ca đều chạy");
  console.log("  ✓ chatTurn: ca #8037F35A ⇒ 1 hộp, tổng 470.000 · «10 cái» / «1 hộp» / «20 nem» / «10 hộp» đúng hộp · «5 nem» hỏi một câu · sai bội / «50 nem» tổng ×2,7 / không lời khách ⇒ chuyển người, đơn giữ nguyên");
}

export async function testP0QtyUnitGuard(): Promise<void> {
  testThuan();
  testNguon();
  testBoDo();
  testLotToiKhach();
  await testChatTurn();
  console.log("✓ P0 hàng rào số lượng / đơn vị (đơn HSLC #8037F35A): «10 nem» không còn thành 10 hộp; mọi lần chặn mang mã 2B");
}

if (process.argv[1] && /p0-qty-unit-guard\.test\.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testP0QtyUnitGuard)
    .then(
      () => process.exit(0),
      (e) => {
        console.error(e);
        process.exit(1);
      },
    );
}

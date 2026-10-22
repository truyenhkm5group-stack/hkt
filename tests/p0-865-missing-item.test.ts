/**
 * ═══════════ P0 #865 — MÓN KHÁCH NÓI TƯỜNG MINH BỊ BỎ SÓT KHỎI ĐƠN (HSLC 16/10/2026, đã ẩn danh) ═══════════
 *
 * Ca thật: khách chốt «1kg chả cá thu và 1 chai mắm» (430k), đơn tự chốt chỉ có chả cá 280k. Dựng lại trên main 23/10/2026 bằng chatTurn
 * (model giả lên đơn thiếu một món): đơn TỰ CHỐT thiếu món, bot nói «Dạ em lên đơn cho mình rồi ạ». Gốc: món khách nói chỉ được GẮN sản
 * phẩm khi nó có trong đơn nháp, nên món vắng mặt hẳn không bao giờ được gắn và `commitmentViolation` / `cartDraftDiff` bỏ qua nó.
 *
 *  1. Thuần: món vắng mặt ⇒ từ chối «KHÔNG được bỏ» + lệch «đơn ghi 0»; đủ món / khách đã bỏ / hỏi giá rồi thôi / tên không chắc ⇒ không.
 *  2. chatTurn (tự chốt BẬT): model lên đơn thiếu ruốc ⇒ công cụ từ chối, không đơn nào chốt thiếu; model sửa ⇒ đơn đủ hai món.
 * Dữ liệu tự dựng (tên «Lan», SĐT 0961008xxx, địa chỉ thử) — không có tin khách thật. Không gọi mạng, không ghim ngày.
 */
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { AUTO_CONFIRM_COMPLETE_SETTING_KEY } from "@/lib/constants/manual-orders";
import { applyCustomerCartMessage, cartDraftDiff, commitmentViolation, type AskedLine } from "@/lib/sales-chatbot/cart-commitment";
import { QUICK_REPLY_SETTING_KEY } from "@/lib/sales-chatbot/quick-replies-shared";
import { variantWeightGrams } from "@/lib/sales-chatbot/shipping";
import { gramsMentioned } from "@/lib/sales-chatbot/tools";
import { setSettingJson } from "@/lib/settings";
import { runGoldenCases, say, tool, type GoldenCase, type StepCtx } from "./sales-agent-golden/harness";

const CATALOG = ["Chả mực giã tay", "Ruốc bông tôm 100%", "Mực khô câu"];
const NOW = new Date();
const MUC: AskedLine = { variantId: "v-muc", productId: "p-muc", name: "Chả mực giã tay · Size: 1kg", quantity: 1, weightGrams: 1000 };
const RUOC: AskedLine = { variantId: "v-ruoc", productId: "p-ruoc", name: "Ruốc bông tôm 100% · Size: 250g", quantity: 1, weightGrams: 250 };
const cartOf = (...texts: string[]) => texts.reduce<ReturnType<typeof applyCustomerCartMessage>>((c, t, i) => applyCustomerCartMessage(c, t, i + 1, NOW, { catalog: CATALOG }), undefined);

function testThuan() {
  const both = cartOf("Chị lấy 1kg chả mực giã tay và 1 hũ ruốc bông tôm nhé");
  const v = commitmentViolation(both, [MUC]);
  assert.ok(v?.startsWith("KHÔNG được bỏ «Ruốc bông tôm 100%»"), `thiếu hẳn ruốc ⇒ từ chối: ${v}`);
  assert.deepEqual(
    cartDraftDiff(both, [MUC]).map((d) => [d.label, d.wantAmount, d.gotAmount]),
    [["Ruốc bông tôm 100%", 1, 0]],
    "lệch «đơn ghi 0» cho món vắng mặt",
  );
  assert.equal(commitmentViolation(both, [MUC, RUOC]), null, "đủ hai món ⇒ không chặn");
  assert.deepEqual(cartDraftDiff(both, [MUC, RUOC]), [], "đủ hai món ⇒ không lệch");
  assert.equal(commitmentViolation(cartOf("1 chả mực, 1 ruốc"), [MUC])?.startsWith("KHÔNG được bỏ «Ruốc bông tôm 100%»"), true, "số trần vẫn là món khách gọi tên — bỏ sót vẫn sai");
  // Khách đã bỏ / hỏi giá rồi chỉ lấy món khác / khen món ⇒ giỏ không còn món đó ⇒ không chặn.
  for (const seq of [
    ["Chị lấy 1kg chả mực giã tay và 1 hũ ruốc bông tôm", "bỏ ruốc nhé em"],
    ["Chị lấy 1kg chả mực giã tay và 1 hũ ruốc bông tôm", "không lấy ruốc nữa"],
    ["Chị lấy 1kg chả mực giã tay và 1 hũ ruốc bông tôm", "thôi lấy chả mực thôi"],
    ["1 hũ ruốc bông tôm bao nhiêu em?", "thôi chị lấy 1kg chả mực giã tay thôi"],
    ["ruốc bông tôm có ngon không em", "lấy 1kg chả mực giã tay"],
  ]) {
    assert.equal(commitmentViolation(cartOf(...seq), [MUC]), null, `${JSON.stringify(seq)} ⇒ khách không còn lấy ruốc`);
  }
  // Ca thật dùng chữ «chai»: trước bản sửa «1 chai mắm» không vào giỏ ⇒ hàng rào không có gì để bám.
  const sauce = (catalog: string[], text: string) => applyCustomerCartMessage(undefined, text, 1, NOW, { catalog })?.selectedItems.map((i) => `${i.label}:${i.quantity}${i.unit}`) ?? [];
  assert.deepEqual(sauce(["Chả cá thu", "Nước mắm cá cơm"], "Chị lấy 1kg chả cá thu và 1 chai mắm"), ["Chả cá thu:1000g", "Nước mắm cá cơm:1pack"], "«1 chai mắm» vào giỏ");
  assert.deepEqual(sauce(["Chả cá thu", "Nước mắm cá cơm"], "1 thùng nước mắm"), ["Nước mắm cá cơm:1pack"], "«thùng» là đơn vị");
  // Luật đối xứng của bộ đọc tên: từ đứng TRƯỚC đoạn khớp mà tên danh mục không có ⇒ món khác — «nước mắm» không phải «Mắm tôm chua»
  // (nếu không, hàng rào bỏ sót sẽ ép model thêm SAI món).
  assert.deepEqual(sauce(["Chả cá thu", "Mắm tôm chua"], "Chị lấy 1kg chả cá thu và 1 chai nước mắm"), ["Chả cá thu:1000g"], "«nước mắm» không bị gán vào «Mắm tôm chua»");
  assert.deepEqual(sauce(["Chả mực giã tay", "Ruốc bông tôm 100%"], "mẹ chị thích ruốc, lấy 1 hũ ruốc"), ["Ruốc bông tôm 100%:1pack"], "câu thường vẫn đọc như cũ");
  // «lạng» = 100 g (trước đây giỏ RỖNG với «5 lạng chả mực»); chỉ dạng có dấu — «số 12 Láng Hạ» không phải 1,2 kg.
  const muc = (text: string) => applyCustomerCartMessage(undefined, text, 1, NOW, { catalog: CATALOG })?.selectedItems.map((i) => `${i.label}:${i.quantity}${i.unit}`) ?? [];
  assert.deepEqual(muc("Chị lấy 5 lạng chả mực"), ["Chả mực giã tay:500g"]);
  assert.deepEqual(muc("2 lạng rưỡi chả mực giã tay"), ["Chả mực giã tay:250g"]);
  assert.deepEqual(muc("Giao số 12 Láng Hạ, 1kg chả mực"), ["Chả mực giã tay:1000g"], "«Láng» của địa chỉ không phải đơn vị");
  assert.deepEqual(gramsMentioned("5 lạng chả mực, giao số 12 Láng Hạ"), [500], "bộ đọc khối lượng của công cụ cùng luật");
  assert.equal(variantWeightGrams(null, "Gói 3 lạng"), 300, "quy cách mẫu mã cùng luật");
  // «kilo» / «ký lô» (= kg): trước đây «1 kilo chả mực» cho giỏ rỗng, «2 ký lô chả cá thu» thì «lô» thành tên món (mất tên chả mực).
  assert.deepEqual(muc("Chị lấy 1 kilo chả mực"), ["Chả mực giã tay:1000g"]);
  assert.deepEqual(muc("2 ký lô chả mực giã tay"), ["Chả mực giã tay:2000g"]);
  assert.deepEqual(gramsMentioned("1kilo chả mực"), [1000]);
  // Lượt khách có dấu hiệu sửa mà máy không áp chắc (relaxedTurn) ⇒ không chặn — luật an toàn sẵn có của giỏ.
  const relaxed = both ? { ...both, relaxedTurn: 9 } : both;
  assert.equal(commitmentViolation(relaxed, [MUC], 9), null);
  console.log("  ✓ thuần: món khách gọi tên vắng mặt hẳn khỏi đơn ⇒ «KHÔNG được bỏ» + lệch «đơn ghi 0» · đủ món / đã bỏ / chỉ hỏi giá / lượt nới ⇒ không chặn · «chai» / «thùng» là đơn vị · «nước mắm» không thành «Mắm tôm chua» · «5 lạng» = 500 g, «Láng Hạ» không phải khối lượng");
}

const ADDR = "9 Hai Bà Trưng, Phường Hoàn Kiếm, Thành phố Hà Nội";
const one = (v: StepCtx["v"]) => ({ items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] });
const two = (v: StepCtx["v"]) => ({ items: [{ variant_id: v("CHA-MUC"), quantity: 1 }, { variant_id: v("RUOC-TOM"), quantity: 1 }] });
const failed = (r: StepCtx["results"]) => r.some((x) => typeof x.error === "string");

const CASES: GoldenCase[] = [
  {
    key: "p865-mot-tin",
    title: "Một tin đủ: 2 món + SĐT + địa chỉ — model lên đơn thiếu ruốc ⇒ bị từ chối, sửa lại đủ hai món",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        say: `Chị lấy 1kg chả mực giã tay và 1 hũ ruốc bông tôm, Lan 0961008301, ${ADDR}`,
        ai: [
          () => [tool("create_customer", { name: "Lan", phone: "0961008301", address: ADDR })],
          ({ v }) => [tool("create_draft_order", one(v))],
          ({ v, results }) => (failed(results) ? [tool("create_draft_order", two(v))] : [say("Dạ em lên đơn cho mình rồi ạ.")]),
          () => [say("Dạ em lên đơn cho mình rồi ạ.")],
        ],
      },
    ],
  },
  {
    key: "p865-hai-tin",
    title: "Khách chọn 2 món rồi mới gửi thông tin — model lên đơn thiếu ruốc ⇒ bị từ chối",
    shop: "food",
    channel: "WEB",
    turns: [
      { say: "Chị lấy 1kg chả mực giã tay và 1 hũ ruốc bông tôm nhé", ai: [() => [say("Dạ mình cho em xin SĐT và địa chỉ nhận hàng ạ.")]] },
      {
        say: `Lan 0961008302, ${ADDR}`,
        ai: [() => [tool("create_customer", { name: "Lan", phone: "0961008302", address: ADDR })], ({ v }) => [tool("create_draft_order", one(v))], () => [say("Dạ em lên đơn cho mình rồi ạ.")]],
      },
    ],
  },
];

async function testChatTurn() {
  const seen = new Set<string>();
  await runGoldenCases(CASES, {
    orgSuffix: "-865",
    beforeCase: async () => {
      await setSettingJson(QUICK_REPLY_SETTING_KEY, { enabled: false, aiMatch: false, upsellReplyId: null, autoLearn: false, autoActivate: false });
      await setSettingJson(AUTO_CONFIRM_COMPLETE_SETTING_KEY, { enabled: true });
    },
    afterCase: async (c, ctx, t) => {
      seen.add(c.key);
      const db = await getDb();
      const [o] = await db.select({ id: schema.orders.id, stage: schema.orders.stage, total: schema.orders.totalPriceAfterDiscount }).from(schema.orders).where(eq(schema.orders.salesConversationId, ctx.conversationId)).limit(1);
      const sku = new Map([...ctx.ids.entries()].map(([k, id]) => [id, k]));
      const lines = o ? (await db.select({ v: schema.orderItems.variantId, q: schema.orderItems.quantity }).from(schema.orderItems).where(eq(schema.orderItems.orderId, o.id))).map((l) => `${sku.get(String(l.v)) ?? l.v}×${l.q}`).sort() : [];
      const last = t.turns[t.turns.length - 1];
      const results = JSON.stringify(last.rounds.map((r) => r.results));
      assert.match(results, /KHÔNG được bỏ «Ruốc bông tôm 100%»/, `[${c.key}] lần lên đơn thiếu ruốc bị từ chối: ${results.slice(0, 500)}`);
      assert.ok(!(o?.stage === "CONFIRMED" && !lines.includes("RUOC-TOM×1")), `[${c.key}] KHÔNG BAO GIỜ có đơn chốt thiếu ruốc: ${o?.stage} ${lines.join(", ")}`);
      if (c.key === "p865-mot-tin") {
        assert.deepEqual(lines, ["CHA-MUC×1", "RUOC-TOM×1"], `[${c.key}] model sửa ⇒ đơn đủ hai món: ${lines.join(", ")}`);
        assert.equal(o?.stage, "CONFIRMED", `[${c.key}] đơn đủ món tự chốt`);
        assert.equal(o?.total, 750_000, `[${c.key}] 400.000 + 350.000`);
      }
    },
  });
  assert.equal(seen.size, CASES.length, "mọi ca đều chạy");
  console.log("  ✓ chatTurn (tự chốt BẬT): lên đơn thiếu món khách đã gọi tên ⇒ công cụ từ chối, không đơn chốt thiếu món · model sửa ⇒ đơn đủ hai món 750.000 ₫");
}

export async function testP0865MissingItem(): Promise<void> {
  testThuan();
  await testChatTurn();
  console.log("✓ P0 #865: món khách nói tường minh không còn bị bỏ sót khỏi đơn (kể cả đơn tự chốt)");
}

if (process.argv[1] && /p0-865-missing-item\.test\.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testP0865MissingItem)
    .then(
      () => process.exit(0),
      (e) => {
        console.error(e);
        process.exit(1);
      },
    );
}

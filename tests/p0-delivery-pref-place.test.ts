/**
 * P0 21/10/2026 — BOT NHẬN NHẦM ĐỊA CHỈ THÀNH LỊCH GIAO (HSLC, đơn #F12342D4, đã che tên / SĐT / địa chỉ cụ thể):
 *
 *  · Khách gửi một tin: 1kg chả cá thu + SĐT + địa chỉ «… đường Lĩnh Nam, Hoàng Mai, Hà Nội». Đơn ghi đúng (món · số lượng · giá), cờ
 *    ADDRESS_UNRESOLVED vì ô xã trống — đúng quy trình. NHƯNG bot gửi thêm «Dạ em đã nhận lời dặn giờ giao của mình ạ» (khách không hẹn
 *    giờ nào) như một tin rời bên cạnh câu xác nhận.
 *  · Gốc (đo trên hàm thuần): `classifyDeliveryQuestion` khớp «mai» TRẦN ở bất kỳ đâu khi câu có một động từ giao («về / gửi / giao /
 *    cho … về») ⇒ «Hoàng Mai», «Mai Dịch» = NGÀY MAI ⇒ `deliveryPreferenceOf` trả cả tin làm lời hẹn ⇒ câu «đã nhận lời dặn» + ghi chú
 *    «Khách hẹn giờ giao» mang nguyên địa chỉ vào đơn.
 *  · Bản sửa (lõi, không phải lời nhắc): «mai» thuộc một TÊN NƠI của danh mục địa giới (gồm tên cũ) hoặc đứng ngay sau giới từ / tiền tố nơi
 *    chốn thì không phải ngày mai; ghi chú hẹn giờ của tin gộp bỏ các vế là địa chỉ / SĐT.
 * Dữ liệu giả.
 */
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { AUTO_CONFIRM_COMPLETE_SETTING_KEY } from "@/lib/constants/manual-orders";
import { adminPlaceNamesFolded } from "@/lib/address/vn-address";
import { SCHEDULE_NOTED_TEXT } from "@/lib/sales-chatbot/address-memory";
import { classifyDeliveryQuestion, deliveryPreferenceOf } from "@/lib/sales-chatbot/delivery-intent";
import type { ChatState } from "@/lib/sales-chatbot/tools";
import { setSettingJson } from "@/lib/settings";
import { runGoldenCases, say, tool, type GoldenCase } from "./sales-agent-golden/harness";

/** Địa chỉ có chữ «Mai» trong TÊN NƠI — không bao giờ là lịch giao. */
export const PLACE_NOT_SCHEDULE = [
  "Cho 1kg về đường Lĩnh Nam, Hoàng Mai",
  "Gửi ngõ 218 đường Lĩnh Nam, Hoàng Mai",
  "Giao về Mai Dịch",
  "giao về phường Mai Động nhé",
  "ship về hoang mai nhe",
  "giao về khu Mai Hắc Đế",
  "Gửi về Tương Mai giúp chị",
  "về Bạch Mai nhé em",
];
/** Lịch giao THẬT — vẫn là ngày mai, kể cả khi đi cùng một tên nơi có chữ «Mai». */
export const REAL_SCHEDULE = ["Mai giao 1kg về Hoàng Mai", "Sáng mai 9h giao giúp chị", "chiều mai nhận", "giao cho chị chiều mai nhé", "8 giờ mai giao nhé", "về Tân Mai mai giao nhé"];

function testThuan() {
  assert.ok(adminPlaceNamesFolded().includes("hoang mai") && adminPlaceNamesFolded().includes("mai dich"), "tên nơi đọc từ danh mục (cả tên cũ), không gõ tay");
  for (const t of PLACE_NOT_SCHEDULE) {
    assert.equal(classifyDeliveryQuestion(t), null, `«${t}» là địa chỉ, không phải hỏi / hẹn lịch giao`);
    assert.equal(deliveryPreferenceOf(t), null, `«${t}» không phải lời hẹn giờ giao`);
  }
  for (const t of REAL_SCHEDULE) {
    assert.deepEqual(classifyDeliveryQuestion(t), { intent: "DELIVERY_TIME", nuance: "TOMORROW" }, `«${t}» là giao NGÀY MAI`);
    assert.ok(deliveryPreferenceOf(t), `«${t}» là lời hẹn giờ giao`);
  }
  // Câu hỏi về ngày mai vẫn là câu hỏi (không bị tên nơi nuốt mất).
  assert.deepEqual(classifyDeliveryQuestion("giao mai hả em"), { intent: "DELIVERY_TIME", nuance: "TOMORROW" });
  assert.equal(deliveryPreferenceOf("mai có giao không?"), null, "hỏi chính sách không phải lời hẹn");
  // Tin GỘP món + SĐT + địa chỉ + giờ giao thật: ghi chú hẹn giờ không mang địa chỉ / SĐT, giữ đúng mốc khách hẹn.
  const all = "Cho chị 1kg chả cá thu, 0912345678, ngõ 218 Lĩnh Nam, Hoàng Mai, Hà Nội, mai 9h giao giúp chị";
  assert.equal(deliveryPreferenceOf(all), "Cho chị 1kg chả cá thu, mai 9h giao giúp chị");
  const lines = "Cho chị 1kg chả cá thu\nKhách A 0912345678\nNgõ 218 Lĩnh Nam Hoàng Mai Hà Nội\nChiều mai giao giúp chị";
  const note = deliveryPreferenceOf(lines) ?? "";
  assert.match(note, /Chiều mai giao giúp chị/);
  assert.doesNotMatch(note, /Lĩnh Nam|Hà Nội|0912345678/, `ghi chú hẹn giờ không chứa địa chỉ / SĐT: ${note}`);
  // Hành vi cũ giữ nguyên (#871).
  assert.equal(deliveryPreferenceOf("chị lấy 2kg, tuần sau giao"), "chị lấy 2kg, tuần sau giao");
  assert.equal(deliveryPreferenceOf("Giao sáng mai khoảng 9h"), "Giao sáng mai khoảng 9h");
}

const ADDR_HM = "ngõ 218 đường Lĩnh Nam, Hoàng Mai, Hà Nội";
const orderSteps = (phone: string, address: string) => [
  () => [tool("create_customer", { name: "Khách A", phone, address })],
  ({ v }: { v: (sku: string) => string }) => [tool("create_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })],
  () => [say("Dạ em lên đơn 1kg chả mực giã tay cho mình rồi ạ.")],
];
const CASES: GoldenCase[] = [
  { key: "dp-f12342d4", title: "Đúng ca #F12342D4: món + SĐT + địa chỉ Hoàng Mai trong MỘT tin ⇒ một câu xác nhận, KHÔNG «đã nhận lời dặn giờ giao», không ghi lời hẹn giả", shop: "food", channel: "FANPAGE", turns: [
    // Đúng DÁNG tin thật (83 ký tự): «Cho 1kg về …» — chính động từ «về» bật bộ đọc lịch giao.
    { say: `Cho chị 1kg chả mực giã tay về ${ADDR_HM}, sđt 0961006201`, ai: orderSteps("0961006201", ADDR_HM) },
  ] },
  { key: "dp-hen-that", title: "Tin có cả giờ giao THẬT ⇒ ghi lời hẹn đúng vế thời gian, không mang địa chỉ / SĐT", shop: "food", channel: "FANPAGE", turns: [
    { say: `Cho chị 1kg chả mực giã tay về ${ADDR_HM}, sđt 0961006202, mai 9h giao giúp chị`, ai: orderSteps("0961006202", ADDR_HM) },
  ] },
];

async function testChatTurn() {
  const seen = new Set<string>();
  await runGoldenCases(CASES, {
    orgSuffix: "-dpp",
    beforeCase: async () => {
      await setSettingJson(AUTO_CONFIRM_COMPLETE_SETTING_KEY, { enabled: true });
    },
    afterCase: async (c, ctx, t) => {
      seen.add(c.key);
      const db = await getDb();
      const [row] = await db.select({ state: schema.salesChatConversations.state }).from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, ctx.conversationId));
      const st = (row.state ?? {}) as ChatState;
      const [o] = await db.select({ note: schema.orders.note, stage: schema.orders.stage, total: schema.orders.totalPriceAfterDiscount }).from(schema.orders).where(eq(schema.orders.salesConversationId, ctx.conversationId));
      const shown = t.turns[0].shown;
      assert.ok(o, `[${c.key}] đơn đã ghi`);
      assert.deepEqual(t.final.order?.items, [{ sku: "CHA-MUC", quantity: 1, price: 400_000 }], `[${c.key}] đúng mã · số lượng · giá`);
      if (c.key === "dp-f12342d4") {
        assert.ok(!shown.includes(SCHEDULE_NOTED_TEXT), `không «đã nhận lời dặn giờ giao» khi khách không hẹn: ${shown.join(" | ")}`);
        assert.equal(st.deliveryPref, undefined, "không lưu lời hẹn giao giả");
        assert.doesNotMatch(o.note ?? "", /hẹn giờ giao/, `ghi chú đơn không có lời hẹn giả: ${o.note}`);
      }
      if (c.key === "dp-hen-that") {
        assert.match(st.deliveryPref?.text ?? "", /mai 9h giao giúp chị/);
        assert.doesNotMatch(st.deliveryPref?.text ?? "", /Lĩnh Nam|0961006202/, `lời hẹn không mang địa chỉ / SĐT: ${st.deliveryPref?.text}`);
      }
    },
  });
  assert.deepEqual([...seen].sort(), CASES.map((c) => c.key).sort());
}

export async function testP0DeliveryPrefPlace(): Promise<void> {
  testThuan();
  await testChatTurn();
  console.log("✓ P0 địa chỉ ≠ lịch giao: «Hoàng Mai / Mai Dịch / Mai Động …» (tên nơi từ danh mục) không còn là ngày mai · «mai giao / sáng mai 9h / 8 giờ mai» giữ nguyên · ca #F12342D4 không «đã nhận lời dặn giờ giao» · ghi chú hẹn giờ không mang địa chỉ / SĐT");
}

/**
 * P0 21/10/2026 (chủ shop, ca HSLC e68f2cfe…): khách cũ — 04/10 khách gõ địa chỉ + SĐT lúc nhân viên đang trả lời, nhân viên lên đơn «nối
 * khoá bot»; 21/10 «chị 1kg chả cá thu nữa nhé» ⇒ bot xin lại SĐT. Gốc: hàng rào hỏi lại coi SĐT là ĐÃ BIẾT (bỏ câu xin của model) nhưng
 * mức sẵn sàng của giỏ chỉ biết `state.customer` ⇒ câu khi lượt im xin lại đúng câu vừa bị bỏ; đơn nhân viên lên không vào bước hỏi «đơn
 * mới hay vẫn đơn đó»; hộp thư hai đường đọc SĐT. Luật mới (AGENTS 3.12, 21/10): nhận diện CHẮC ⇒ tự nạp SĐT; địa chỉ lần trước ⇒ MỘT câu
 * «giao về … như lần trước không ạ?». Thuần + chatTurn thật (`gd-food-kcc`, `gd-food-kcc2`). Dữ liệu dựng, không PII thật.
 */
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { AUTO_CONFIRM_COMPLETE_SETTING_KEY } from "@/lib/constants/manual-orders";
import { orderReadiness } from "@/lib/sales-chatbot/cart-commitment";
import { certainPhonesOf, loadCustomer360 } from "@/lib/sales-chatbot/customer-360";
import { SHOP_SAID, silenceFallbackText } from "@/lib/sales-chatbot/engine";
import { inboxPhoneOf, knownPhoneOf, knownPhonePrompt, knownPhoneStateOf, normalizeVnPhone as kcNormalize, previousAddressQuestion, usableKnownPhone } from "@/lib/sales-chatbot/known-contact";
import { normalizeVnPhone } from "@/lib/sales-chatbot/returning";
import { roundCheckOrderOf } from "@/lib/sales-chatbot/round-check";
import type { ChatState } from "@/lib/sales-chatbot/tools";
import { setSettingJson } from "@/lib/settings";
import { asksAddressAgain, asksPhone, shownPhoneOf } from "@/scripts/conv-money-trace";
import { runGoldenCases, say, tool, type GoldenCase, type GoldenHookCtx } from "./sales-agent-golden/harness";

const PHONE = "0961005501";
const OLD_ADDR = "Số 12 ngõ 5 Phố Huế, Hai Bà Trưng, Hà Nội";
const DAY = 86_400_000;
const STAFF_ORDER = "erp-1d4ee348-0000-4000-8000-000000000001";

function testThuan() {
  // Một định nghĩa chuẩn hoá SĐT.
  assert.equal(normalizeVnPhone, kcNormalize, "returning.normalizeVnPhone là re-export của known-contact");
  for (const raw of ["+84961005501", "84961005501", "0961 005 501", "abc"]) assert.equal(normalizeVnPhone(raw), kcNormalize(raw));

  assert.deepEqual(knownPhoneOf({ customerTexts: ["chị lấy 1kg", "0961.005.501", "ok"] }), { kind: "ONE", phone: PHONE, sources: ["THREAD_TYPED"] }, "khách tự gõ trong luồng");
  assert.deepEqual(knownPhoneOf({ customerPhone: "0912000111", customerTexts: [PHONE] }), { kind: "ONE", phone: "0912000111", sources: ["THREAD_CUSTOMER"] }, "khách đã lưu lượt này thắng");
  assert.deepEqual(knownPhoneOf({ customerTexts: [], orders: [{ phone: PHONE, link: "THREAD" }] }), { kind: "ONE", phone: PHONE, sources: ["THREAD_ORDER"] }, "đơn của chính hội thoại");
  assert.deepEqual(knownPhoneOf({ customerTexts: [PHONE], orders: [{ phone: PHONE, link: "FB_ID" }] }), { kind: "ONE", phone: PHONE, sources: ["THREAD_TYPED", "FB_ID"] });
  assert.deepEqual(knownPhoneOf({ customerTexts: [PHONE, "à nhầm 0912000111"] }), { kind: "MANY", phones: [PHONE, "0912000111"] }, "hai số khác nhau ⇒ hỏi chọn, không đoán");
  assert.deepEqual(knownPhoneOf({ customerTexts: ["2 hộp 500g nhé"] }), { kind: "NONE" });
  assert.equal(usableKnownPhone({ kind: "MANY", phones: ["a", "b"] }), null, "nhiều số ⇒ không tự điền");
  // Bảo mật: mức PHONE (ai cũng gõ được SĐT người khác) KHÔNG BAO GIỜ là nguồn chắc.
  assert.deepEqual(certainPhonesOf([{ phone: PHONE, link: "PHONE" }, { phone: "0912000111", link: "THREAD" }]), [{ phone: "0912000111", link: "THREAD" }]);
  // Lời nhắc chỉ ĐUÔI số.
  const pr = knownPhonePrompt({ kind: "ONE", phone: PHONE, sources: ["THREAD_ORDER"] });
  assert.match(pr, /đuôi 5501/);
  assert.ok(!pr.includes(PHONE), "lời nhắc không mang nguyên số");
  assert.equal(knownPhonePrompt({ kind: "ONE", phone: PHONE, sources: ["THREAD_CUSTOMER"] }), "", "khách đã lưu ⇒ khối cũ lo, không thêm chữ");
  assert.deepEqual(knownPhoneStateOf({ kind: "MANY", phones: ["a", "b"] }, new Date()), null);

  // Mức sẵn sàng đọc SĐT / địa chỉ đã biết — không còn hai luật nói hai điều.
  const cart = { selectedItems: [{ customerExplicit: true, label: "Chả mực giã tay", productId: "p1", match: null, quantity: 1, unit: "kg", pieces: null, sourceMessageId: 3 }] } as unknown as ChatState["cart"];
  assert.equal(orderReadiness({ cart, blocker: null, lastUserText: "1kg nữa nhé", hesitating: false }).level, "NEED_PHONE", "như cũ khi không có gì");
  assert.equal(orderReadiness({ cart, blocker: null, lastUserText: "1kg nữa nhé", hesitating: false, knownPhone: PHONE }).level, "NEED_ADDRESS", "SĐT đã biết ⇒ chỉ còn thiếu địa chỉ");
  assert.equal(orderReadiness({ cart, blocker: null, lastUserText: "1kg nữa nhé", hesitating: false, knownPhone: PHONE, knownAddress: { address: OLD_ADDR, province: "Hà Nội" } }).level, "ORDER_READY");
  const st = { cart } as ChatState;
  assert.equal(silenceFallbackText(st, "1kg nữa nhé", 5, false, 4, { phone: { kind: "MANY", phones: [PHONE, "0912000111"] } }), "Dạ mình nhận hàng số đuôi 5501 hay 0111 ạ?");
  assert.equal(silenceFallbackText(st, "1kg nữa nhé", 5, false, 4, { phone: { kind: "ONE", phone: PHONE, sources: ["THREAD_TYPED"] }, previousAddress: "…, Hai Bà Trưng, Hà Nội" }), "Dạ em giao về Hai Bà Trưng, Hà Nội như lần trước được không ạ?");
  assert.equal(previousAddressQuestion("…"), "Dạ em giao về địa chỉ lần trước của mình được không ạ?");

  // Đơn để hỏi «đơn mới hay vẫn đơn đó»: đơn bot chốt, không có thì đơn NHÂN VIÊN lên.
  assert.equal(roundCheckOrderOf({ confirmed: { orderId: "erp-a", simulated: false, total: 1, at: "x" } } as ChatState)?.staff, false);
  assert.deepEqual(roundCheckOrderOf({ orderSync: { orders: [{ orderId: STAFF_ORDER, at: "2026-10-04T14:54:00Z", agreementAt: "", agreementId: "", total: 400_000 }] } } as unknown as ChatState), { orderId: STAFF_ORDER, simulated: false, total: 400_000, at: "2026-10-04T14:54:00Z", staff: true });

  // Hộp thư: một thứ tự cho danh sách + khung khách; bộ quét dùng đúng thứ tự đó.
  const samples = [{ customerPhone: "", statePhone: null, knownPhone: PHONE, convPhone: "0912000111" }, { customerPhone: "0900000001", statePhone: PHONE }, { convPhone: " " }, {}];
  for (const x of samples) assert.equal(shownPhoneOf(x), inboxPhoneOf(x), JSON.stringify(x));
  assert.equal(inboxPhoneOf({ knownPhone: PHONE, convPhone: "0912000111" }), PHONE);
  assert.ok(asksPhone("Dạ mình cho em xin số điện thoại nhận hàng ạ.") && !asksPhone("Dạ em giao về Hai Bà Trưng như lần trước được không ạ?"));
  assert.ok(asksAddressAgain("Mình gửi em địa chỉ nhận hàng nhé") && !asksAddressAgain("Dạ em giao về địa chỉ lần trước của mình được không ạ? Hay mình gửi em địa chỉ mới"));
  console.log("  ✓ thuần: một chuẩn hoá SĐT · nguồn chắc (tự gõ · đơn của hội thoại · mã Facebook; KHÔNG mức PHONE) · nhiều số ⇒ hỏi chọn · mức sẵn sàng đọc SĐT / địa chỉ đã biết · câu «như lần trước» · đơn nhân viên vào bước hỏi · hộp thư một thứ tự");
}

async function addMessages(ctx: GoldenHookCtx, rows: readonly { role: "user" | "assistant"; text: string }[], at: Date) {
  const db = await getDb();
  const m = schema.salesChatMessages;
  const have = await db.select({ seq: m.seq }).from(m).where(eq(m.conversationId, ctx.conversationId));
  let seq = have.length ? Math.max(...have.map((r) => r.seq)) : 0;
  for (const r of rows) await db.insert(m).values({ conversationId: ctx.conversationId, seq: ++seq, role: r.role, content: [{ type: "text", text: r.text }], createdAt: at });
}

const PRIOR = [
  { role: "assistant" as const, text: `${SHOP_SAID} Dạ, mình đặt hàng cho em xin tên, SĐT, địa chỉ nhé` },
  { role: "user" as const, text: `Ship đến ${OLD_ADDR}` },
  { role: "user" as const, text: PHONE },
  { role: "assistant" as const, text: `${SHOP_SAID} Dạ, em chốt đơn của chị 1kg chả mực ạ` },
];

/** Ca thật: tin cũ 17 ngày trước + đơn NHÂN VIÊN lên từ hội thoại (state.orderSync) + đơn ERP nối hội thoại. */
async function seedStaffOrder(ctx: GoldenHookCtx) {
  const at = new Date(Date.now() - 17 * DAY);
  await addMessages(ctx, PRIOR, at);
  const db = await getDb();
  await db.insert(schema.orders).values({ id: STAFF_ORDER, status: 1, stage: "CONFIRMED", insertedAt: at, salesConversationId: ctx.conversationId, shipFullName: "Lan", shipPhone: PHONE, billPhone: PHONE, shipAddress: OLD_ADDR, shipProvince: "", shipCommune: "", totalPriceAfterDiscount: 400_000 });
  const c = schema.salesChatConversations;
  const [row] = await db.select({ state: c.state }).from(c).where(eq(c.id, ctx.conversationId));
  const orderSync = { orders: [{ orderId: STAFF_ORDER, at: at.toISOString(), agreementAt: at.toISOString(), agreementId: "", total: 400_000 }] };
  await db.update(c).set({ state: { ...((row?.state ?? {}) as object), orderSync } }).where(eq(c.id, ctx.conversationId));
}

const ROUND_ASK = /Mình đang có đơn #(?:<MÃ ĐƠN>|1D4EE348) \(400\.000 ₫\) đặt ngày \d\d\/\d\d — lần này mình muốn đặt thêm một đơn mới, hay vẫn là đơn đó ạ\?/;

const CASES: GoldenCase[] = [
  { key: "kc-cung-luot", title: "Khách đã gõ SĐT + địa chỉ trong luồng, «1kg nữa nhé», model xin SĐT ⇒ KHÔNG xin lại (hàng rào + mức sẵn sàng cùng một câu trả lời)", shop: "food", channel: "WEB", turns: [
    { say: "chị 1kg chả mực nữa nhé", before: (ctx) => addMessages(ctx, PRIOR, new Date()), ai: [() => [say("Dạ mình cho em xin số điện thoại nhận hàng ạ.")]] },
  ] },
  { key: "kc-tu-nap-sdt", title: "Model lưu khách BỎ TRỐNG SĐT ⇒ máy chủ điền số khách đã gõ trong luồng, đơn lên đúng số", shop: "food", channel: "WEB", turns: [
    { say: "chị 1kg chả mực nữa nhé", before: (ctx) => addMessages(ctx, PRIOR, new Date()), ai: [() => [tool("create_customer", { name: "Lan", address: OLD_ADDR })], ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Dạ em lên đơn cho mình rồi ạ.")]] },
  ] },
  { key: "kc-don-nhan-vien", title: "Ca thật (17 ngày sau đơn nhân viên lên): hỏi «đơn mới hay vẫn đơn đó» ⇒ «đơn mới» ⇒ KHÔNG xin SĐT, MỘT câu «như lần trước» ⇒ «đúng rồi em» ⇒ đơn mới đúng SĐT + địa chỉ cũ", shop: "food", channel: "WEB", turns: [
    { say: "chị 1kg chả mực nữa nhé", before: seedStaffOrder, ai: [] },
    { say: "đơn mới em nhé", ai: [() => [say("Dạ mình cho em xin số điện thoại nhận hàng ạ.")]] },
    { say: "đúng rồi em", ai: [() => [tool("create_customer", { use_saved_address: true, customer_confirmation: "đúng rồi em" })], ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })], () => [say("Dạ em lên đơn cho mình rồi ạ.")]] },
  ] },
  { key: "kc-van-don-do", title: "Đơn nhân viên lên, khách «vẫn đơn đó» ⇒ chuyển nhân viên (bot không sửa đơn người lên), không đơn thứ hai", shop: "food", channel: "WEB", turns: [
    { say: "chị 1kg chả mực nữa nhé", before: seedStaffOrder, ai: [] },
    { say: "vẫn đơn đó em", ai: [] },
  ] },
];

async function stateOf(id: string): Promise<ChatState> {
  const db = await getDb();
  const [c] = await db.select({ state: schema.salesChatConversations.state }).from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, id));
  return (c?.state ?? {}) as ChatState;
}

async function testChatTurn() {
  const seen = new Set<string>();
  await runGoldenCases(CASES, {
    orgSuffix: "-kcc",
    beforeCase: async (_c, ctx) => {
      const db = await getDb();
      const [has] = await db.select({ id: schema.stockReceipts.id }).from(schema.stockReceipts).where(eq(schema.stockReceipts.reference, "KCC-NAP")).limit(1);
      if (!has) {
        const [rc] = await db.insert(schema.stockReceipts).values({ kind: "RECEIPT", receivedAt: new Date(), reference: "KCC-NAP", totalQuantity: 20, createdBy: "test" }).returning({ id: schema.stockReceipts.id });
        await db.insert(schema.stockReceiptItems).values({ receiptId: rc.id, variantId: ctx.ids.get("CHA-MUC")!, quantity: 20, unitCost: 200_000 });
      }
      await setSettingJson(AUTO_CONFIRM_COMPLETE_SETTING_KEY, { enabled: true });
      // Ca «vẫn đơn đó» dùng lại mã đơn nhân viên của ca trước — xoá trước khi gieo lại.
      await db.delete(schema.orders).where(eq(schema.orders.id, STAFF_ORDER));
    },
    afterCase: async (c, ctx, t) => {
      seen.add(c.key);
      const all = t.turns.flatMap((x) => x.shown);
      const st = await stateOf(ctx.conversationId);
      const results = JSON.stringify(t.turns.map((x) => x.rounds.map((r) => r.results)));
      const db = await getDb();
      const orders = await db.select().from(schema.orders).where(eq(schema.orders.salesConversationId, ctx.conversationId));
      assert.ok(!all.some((s) => /số điện thoại/i.test(s) && /xin/i.test(s)), `[${c.key}] bot xin lại SĐT: ${all.join(" | ")}`);
      assert.ok(!all.some((s) => s.includes("Số 12")), `[${c.key}] không đọc số nhà cho khách: ${all.join(" | ")}`);
      if (c.key === "kc-cung-luot") {
        assert.equal(st.knownPhone?.phone, PHONE, "SĐT đã biết vào state (hộp thư đọc)");
        assert.ok(all.length > 0, "lượt không im");
      }
      if (c.key === "kc-tu-nap-sdt") {
        const mine = orders.find((o) => o.id !== STAFF_ORDER);
        assert.ok(mine, results.slice(0, 600));
        assert.equal(mine?.shipPhone || mine?.billPhone, PHONE, `máy chủ điền SĐT đã biết: ${results.slice(0, 600)}`);
        assert.equal(st.customer?.phone, PHONE);
      }
      if (c.key === "kc-don-nhan-vien") {
        assert.match(t.turns[0].shown.join(" "), ROUND_ASK, `đơn nhân viên vào bước hỏi: ${t.turns[0].shown.join(" | ")}`);
        assert.deepEqual(t.turns[1].shown, ["Dạ em giao về Hai Bà Trưng, Hà Nội như lần trước được không ạ?"], `MỘT câu «như lần trước», không xin SĐT: ${t.turns[1].shown.join(" | ")}`);
        const mine = orders.filter((o) => o.id !== STAFF_ORDER);
        assert.equal(mine.length, 1, `đúng MỘT đơn mới: ${results.slice(0, 800)}`);
        assert.equal(mine[0].shipPhone || mine[0].billPhone, PHONE, "đơn mới đúng SĐT đã biết");
        assert.match(mine[0].shipAddress ?? "", /Phố Huế/, "đơn mới đúng địa chỉ lần trước khách vừa xác nhận");
        const staff = orders.find((o) => o.id === STAFF_ORDER);
        assert.equal(staff?.totalPriceAfterDiscount, 400_000, "đơn nhân viên lên KHÔNG bị sửa");
      }
      if (c.key === "kc-van-don-do") {
        assert.match(t.turns[0].shown.join(" "), ROUND_ASK);
        assert.match(String(t.final.handoffReason ?? st.handoff?.reason ?? ""), /đơn #(?:<MÃ ĐƠN>|1D4EE348) nhân viên đã lên/, JSON.stringify(t.final));
        assert.equal(orders.filter((o) => o.id !== STAFF_ORDER).length, 0, "không đơn thứ hai");
      }
    },
  });
  assert.equal(seen.size, CASES.length, "mọi ca đều chạy");
}

/**
 * BẢO MẬT: (1) PSID khác trên cùng page không thấy SĐT của luồng khác (đơn nối theo hội thoại / luồng); (2) người lạ gõ SĐT của khách khác
 * ⇒ địa chỉ của khách đó KHÔNG đọc ra (mức PHONE ⇒ che, không phải nguồn chắc); (3) tổ chức khác không đọc được đơn của tổ chức này.
 */
async function testSecurity() {
  let otherThreadConv = "";
  await runGoldenCases(
    [
      { key: "kcs-luong-khac", title: "PSID khác cùng page", shop: "food", channel: "FANPAGE", turns: [{ say: "chị 1kg chả mực nhé", ai: [() => [say("Dạ mình cho em xin số điện thoại nhận hàng ạ.")]] }] },
      { key: "kcs-nguoi-la", title: "Người lạ gõ SĐT của khách khác", shop: "food", channel: "WEB", turns: [{ say: `chị lấy 1kg chả mực, số ${PHONE}`, ai: [() => [say("Dạ mình cho em xin địa chỉ nhận hàng ạ.")]] }] },
    ],
    {
      orgSuffix: "-kcs",
      beforeCase: async (c) => {
        if (c.key !== "kcs-luong-khac") return;
        const db = await getDb();
        // Đơn của luồng A (page pg-kc, luồng thr-A) mang SĐT + địa chỉ đã xác minh.
        await db.insert(schema.orders).values({ id: "erp-aaaa0001-0000-4000-8000-000000000001", status: 1, stage: "CONFIRMED", insertedAt: new Date(Date.now() - 20 * DAY), pageId: "pg-kc", conversationId: "thr-A", shipPhone: PHONE, billPhone: PHONE, shipAddress: OLD_ADDR, shipProvince: "Hà Nội", shipCommune: "Phường Hai Bà Trưng", totalPriceAfterDiscount: 400_000 });
      },
      afterCase: async (c, ctx, t) => {
        const all = t.turns.flatMap((x) => x.shown).join(" | ");
        const db = await getDb();
        const [row] = await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, ctx.conversationId));
        const st = (row.state ?? {}) as ChatState;
        if (c.key === "kcs-luong-khac") {
          otherThreadConv = ctx.conversationId;
          const c360 = await loadCustomer360({ conversationId: ctx.conversationId, pageId: "pg-kc", threadId: "thr-B", state: st });
          assert.deepEqual(c360.certainPhones, [], "luồng B không thấy đơn / SĐT của luồng A");
          assert.equal(st.knownPhone, undefined, "không SĐT đã biết cho luồng B");
          assert.match(all, /số điện thoại/, "luồng B: bot xin SĐT như khách mới");
        }
        if (c.key === "kcs-nguoi-la") {
          assert.doesNotMatch(all, /Phố Huế|Số 12|như lần trước/, `không lộ / không gợi ý địa chỉ của chủ SĐT: ${all}`);
          const c360 = await loadCustomer360({ conversationId: ctx.conversationId, pageId: null, threadId: null, state: st });
          assert.ok(c360.certainPhones.every((p) => p.link !== ("PHONE" as never)), "mức PHONE không vào nguồn chắc");
        }
      },
    },
  );
  assert.ok(otherThreadConv, "ca luồng khác đã chạy");
  // Tổ chức khác (CSDL riêng): cùng page + luồng A nhưng KHÔNG có đơn nào.
  await runGoldenCases([{ key: "kcs-to-chuc-khac", title: "Tổ chức B", shop: "food", channel: "WEB", turns: [{ say: "1kg chả mực nhé", ai: [() => [say("Dạ vâng ạ.")]] }] }], {
    orgSuffix: "-kcs2",
    afterCase: async (_c, ctx) => {
      const c360 = await loadCustomer360({ conversationId: ctx.conversationId, pageId: "pg-kc", threadId: "thr-A", state: {} as ChatState });
      assert.deepEqual(c360.certainPhones, [], "tổ chức B không đọc được đơn của tổ chức A");
    },
  });
  console.log("  ✓ bảo mật: luồng khác cùng page không thấy SĐT · người lạ gõ SĐT khách khác không lộ địa chỉ · tổ chức khác không đọc đơn");
}

export async function testP0KnownCustomerContact(): Promise<void> {
  testThuan();
  await testChatTurn();
  await testSecurity();
  console.log("✓ P0 khách cũ (ca e68f2cfe): SĐT đã biết một nguồn (tự gõ trong luồng · đơn của hội thoại · mã Facebook) — không xin lại · lượt mua mới MỘT câu «như lần trước» · đơn nhân viên lên vào bước hỏi đơn mới / vẫn đơn đó · hộp thư một thứ tự SĐT · bảo mật luồng / người lạ / tổ chức");
}

if (process.argv[1] && /p0-known-customer-contact\.test\.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testP0KnownCustomerContact)
    .then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
}

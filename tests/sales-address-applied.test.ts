/**
 * ═══════════ P0 «DỨT ĐIỂM XIN LẠI ĐỊA CHỈ» — ca HSLC 22/10/2026 10:04–10:09, đơn #8037F35A (Tech Lead code-erp-17 giao) ═══════════
 *
 * Hình dạng THẬT của ca (conv-money-trace run 39716504139, ẩn danh — chỉ độ dài / thứ tự / lời gọi công cụ):
 *  · MỘT tin khách mang tên + SĐT + địa chỉ (không phường) ⇒ create_customer + create_draft_order ⇒ đơn TỰ CHỐT khi chưa có phường;
 *  · tin 15 ký tự «Phường Kim Liên» ĐỨNG RIÊNG ⇒ update_draft_order có ward ⇒ OK, đơn có ô tỉnh + ô xã;
 *  · update_draft_order sau đó gửi LẠI ward ⇒ LỖI «xã / phường chưa xác nhận» (tin cuối không còn nhắc phường);
 *  · cờ ADDRESS_UNRESOLVED dựng lúc tự chốt KHÔNG được xét lại ⇒ ERP vẫn «cần kiểm địa chỉ», tuyến ADDRESS_REVIEW.
 * Khoá:
 *  1. phường khách đã cho vào đơn, gửi lại đúng phường đã lưu không bị từ chối (idempotent);
 *  2. lượt ghi của MÁY mà đơn nay có phường ⇒ gỡ ĐÚNG dòng cờ máy dựng, vết `ADDRESS_SETTLED` (máy, byUserId null) — không gỡ cờ khác;
 *  3. model quên gửi ward ⇒ máy chủ tự áp phường từ tin chỉ-phường của khách;
 *  4. xác minh địa chỉ ĐỘC LẬP với upsell (chủ shop 22/10/2026): cờ upsellAfterContact TẮT vẫn không có câu «nhân viên sẽ xác nhận lại địa chỉ»;
 *  5. không câu bot nào xin lại phường / địa chỉ sau khi khách đã cho.
 * Dữ liệu dựng (không PII): SĐT 0961005xxx, số nhà / ngõ hư cấu.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { customerStatedAddresses, parseCustomerAddress, wardFromCustomerWords } from "@/lib/address/customer-address";
import { AUTO_CONFIRM_COMPLETE_SETTING_KEY } from "@/lib/constants/manual-orders";
import { ORDER_REVIEW_ACTIONS, orderReviewLogOf, orderReviewOf, withAddressSettled, type OrderReviewAction } from "@/lib/constants/order-review";
import { SALES_QUALITY_CODES, SALES_QUALITY_SPEC } from "@/lib/constants/sales-quality";
import { cancelEvidenceOf } from "@/lib/records/order-cancel-reconcile";
import { keptWardOf } from "@/lib/sales-chatbot/tools";
import { addressNotApplied, scanThreadQuality } from "@/lib/sales-quality/detectors";
import { CLAIM_SAFE_TEXT } from "@/lib/sales-chatbot/claim-guard";
import { QUICK_REPLY_SETTING_KEY } from "@/lib/sales-chatbot/quick-replies-shared";
import { setSettingJson } from "@/lib/settings";
import { addressReviewOpenOf } from "@/lib/shipping/route";
import { runGoldenCases, say, tool, type GoldenCase, type GoldenHookCtx } from "./sales-agent-golden/harness";

const STREET = "Số 10 ngõ 5 Lương Định Của, Hà Nội";
const WARD = "Phường Kim Liên";
const BANNED = CLAIM_SAFE_TEXT.ORDER_PENDING_ADDRESS;
const INFO = (phone: string) => `Cho chị 1 hộp ruốc bông tôm, Lan ${phone}, ${STREET}`;
/** Câu bot xin lại phường / địa chỉ (câu hỏi). */
const ASKS_ADDRESS = /(?:phường|xã|địa chỉ)[^.!?]*\?/iu;

export function testSalesAddressAppliedPure() {
  // (3) Ghép tin chỉ-phường: dòng địa chỉ có tỉnh (không phường) rồi tin riêng «Phường Kim Liên» — kể cả khi tin địa chỉ lẫn tên món + SĐT
  // (đúng dáng tin 96 ký tự của ca thật).
  for (const texts of [[STREET, WARD], ["0961005100", STREET, WARD], [INFO("0961005100"), WARD]]) {
    const s = customerStatedAddresses(texts);
    if (texts[0] !== INFO("0961005100")) assert.ok(s.some((x) => x.ward === WARD && x.province === "Thành phố Hà Nội" && x.houseNumber === "10"), `${JSON.stringify(texts)} ⇒ ${JSON.stringify(s.map((x) => [x.ward, x.street]))}`);
    assert.equal(wardFromCustomerWords(parseCustomerAddress(STREET), STREET, texts)?.ward, WARD, `${JSON.stringify(texts)}: máy chủ tự áp phường từ lời khách`);
  }
  // Không ghép bừa: tin chỉ-phường của TỈNH KHÁC, hoặc tin không phải tên phường.
  assert.equal(customerStatedAddresses([STREET, "Phường Bến Thành"]).filter((x) => x.ward).length, 0, "phường không thuộc tỉnh của dòng địa chỉ ⇒ không ghép");
  assert.equal(customerStatedAddresses([STREET, "ok em"]).length, 0);
  // Phường đứng TRƯỚC địa chỉ ⇒ không ghép xuôi (có thể là phần của địa chỉ cũ).
  assert.equal(wardFromCustomerWords(parseCustomerAddress(STREET), STREET, [WARD, STREET]), null, "tin chỉ-phường trước tin địa chỉ ⇒ không tự áp");
  // Khách sửa phường ở tin sau ⇒ không áp phường cũ.
  assert.equal(wardFromCustomerWords(parseCustomerAddress(STREET), STREET, [STREET, WARD, "à nhầm, phường Văn Miếu - Quốc Tử Giám"]), null, "tin sau nêu phường khác ⇒ không áp");
  // Địa chỉ cũ không bị gắn phường của tin chỉ-phường đứng TRƯỚC một địa chỉ mới khác.
  assert.equal(wardFromCustomerWords(parseCustomerAddress("Số 3 ngõ 9 Trần Duy Hưng, Hà Nội"), "Số 3 ngõ 9 Trần Duy Hưng, Hà Nội", [STREET, WARD, "Số 3 ngõ 9 Trần Duy Hưng, Hà Nội"]), null, "phường của địa chỉ cũ không lọt vào địa chỉ mới");

  // (2) Gỡ ĐÚNG dòng cờ máy; cờ khác (khách đổi địa chỉ · khách huỷ) giữ nguyên.
  const at = "2026-10-22T03:06:56.000Z";
  const machine = { code: "ADDRESS_UNRESOLVED" as const, note: "Máy chốt khi địa chỉ chưa ghép được (tỉnh Thành phố Hà Nội, chưa có xã / phường) — dòng địa chỉ: x", quote: null, at, by: "Bot" };
  const changed = { code: "ADDRESS_UNRESOLVED" as const, note: "Khách đổi địa chỉ giao — địa chỉ trước: «a»; cần người xác minh", quote: null, at, by: "Bot" };
  const cancel = { code: "CUSTOMER_CANCELLED" as const, note: "Khách báo huỷ", quote: "huỷ", at, by: "Bot" };
  const only = withAddressSettled({ review: { entries: [machine] } }, { at: "2026-10-22T03:07:33.000Z", byName: "Bot", ward: WARD });
  assert.ok(only.changed && orderReviewOf(only.raw) === null, "chỉ có dòng máy ⇒ cờ đóng");
  const log = orderReviewLogOf(only.raw)[0];
  assert.ok(log.action === "ADDRESS_SETTLED" && log.byUserId === null && log.entries.length === 1 && log.byName.includes(WARD), JSON.stringify(log));
  const mixed = withAddressSettled({ review: { entries: [machine, cancel] } }, { at: "2026-10-22T03:07:33.000Z", byName: "Bot", ward: WARD });
  assert.deepEqual(orderReviewOf(mixed.raw)?.entries.map((e) => e.code), ["CUSTOMER_CANCELLED"], "cờ khách huỷ KHÔNG bị gỡ");
  assert.equal(withAddressSettled({ review: { entries: [changed] } }, { at, byName: "Bot", ward: WARD }).changed, false, "khách đổi địa chỉ ⇒ người xác minh, máy không gỡ");
  assert.equal(withAddressSettled({}, { at, byName: "Bot", ward: WARD }).changed, false);

  // (1) Gửi lại đúng phường đã lưu ⇒ giữ; phường khác / địa chỉ khác / tin cuối nêu phường khác ⇒ đi đường kiểm như cũ.
  const stored = { name: "Lan", phone: "0961005100", address: STREET, province: "", ward: WARD };
  const next = { name: "Lan", phone: "0961005100", address: STREET, province: "" };
  assert.equal(keptWardOf(stored, next, WARD, "giao giờ hành chính giúp chị nhé"), WARD, "gửi lại phường đã lưu ⇒ nhận");
  assert.equal(keptWardOf(stored, next, "Kim Liên", "ok em"), WARD, "khác tiền tố «phường» vẫn là cùng phường");
  assert.equal(keptWardOf(stored, next, "Phường Văn Miếu - Quốc Tử Giám", "ok em"), null, "phường KHÁC ⇒ không giữ");
  assert.equal(keptWardOf(stored, { ...next, address: "Số 3 ngõ 9 Trần Duy Hưng, Hà Nội" }, WARD, "ok em"), null, "địa chỉ khác ⇒ không giữ");
  assert.equal(keptWardOf(stored, next, WARD, "à nhầm, phường Văn Miếu - Quốc Tử Giám"), null, "tin cuối nêu phường khác ⇒ không giữ");
  assert.equal(keptWardOf({ ...stored, ward: undefined }, next, WARD, "ok em"), null, "chưa lưu phường ⇒ đi đường kiểm");

  // «Xác nhận lại sau huỷ» của bộ đối soát huỷ: TỪNG action của vết (vùng tiền).
  const t0 = Date.now();
  const base = { id: "erp-x", stage: "CONFIRMED", insertedAt: new Date(t0 - 3_600_000), review: null, cancellation: null, confirmedAt: null, declinedAt: new Date(t0 - 60_000).toISOString() };
  const expect: Record<OrderReviewAction, "AI_AGREED" | null> = { CONFIRMED: null, CUSTOMER_RECONFIRMED: null, CANCELLED: "AI_AGREED", ADDRESS_SETTLED: "AI_AGREED" };
  assert.deepEqual([...ORDER_REVIEW_ACTIONS].sort(), Object.keys(expect).sort(), "bài kiểm phủ ĐỦ mọi action của vết");
  for (const action of ORDER_REVIEW_ACTIONS) {
    const reviewLog = [{ entries: [], action, at: new Date(t0).toISOString(), byUserId: null, byName: "x" }];
    assert.equal(cancelEvidenceOf({ ...base, reviewLog }), expect[action], `${action} sau lời huỷ ⇒ ${expect[action] ?? "không phải ứng viên"}`);
  }

  // 2B: câu ghi nhận không còn là «lần chặn khẳng định»; mã mới ở CUỐI danh sách, khoá cũ giữ nguyên.
  const w = { from: new Date(t0 - 3_600_000), to: new Date(t0 + 3_600_000), templates: [], products: [] };
  const msg = (role: string, text: string, i: number) => ({ seq: i, role, at: new Date(t0 + i * 1000), content: [{ type: "text", text }] });
  assert.deepEqual(scanThreadQuality([msg("user", "ok", 1), msg("assistant", CLAIM_SAFE_TEXT.ORDER_RECEIVED, 2)], w).hits, [], "ORDER_RECEIVED không tính là CLAIM_GUARD_BLOCK");
  assert.deepEqual(scanThreadQuality([msg("user", "ck rồi", 1), msg("assistant", CLAIM_SAFE_TEXT.PAYMENT, 2)], w).hits.map((h) => h.code), ["CLAIM_GUARD_BLOCK"], "câu an toàn khác vẫn tính");
  // Mã mới THÊM SAU các khoá đã lưu (không chen giữa, không đổi thứ tự cũ) — các nhánh khác cũng thêm mã ở cuối nên «phần tử cuối» không phải bất biến.
  const OLD_CODES = ["HANDOFF_UNANSWERED", "QTY_REASKED", "SECONDARY_INTENT_UNANSWERED", "WRONG_PRODUCT_TEMPLATE", "ADDRESS_REASK", "COMPLAINT_WHILE_SELLING", "CLARIFY_FALLBACK", "CLAIM_GUARD_BLOCK", "UPSELL_ACCEPTED_BUT_REASKED", "UPSELL_ACCEPTED_NOT_ATTACHED"];
  assert.deepEqual(SALES_QUALITY_CODES.slice(0, OLD_CODES.length), OLD_CODES, "khoá cũ giữ nguyên thứ tự ở đầu danh sách");
  assert.ok(SALES_QUALITY_CODES.indexOf("ADDRESS_RECEIVED_BUT_NOT_APPLIED") >= OLD_CODES.length, "mã mới đứng SAU các khoá cũ");
  assert.ok(SALES_QUALITY_CODES.includes("ADDRESS_REASK") && !(SALES_QUALITY_CODES as readonly string[]).includes("KNOWN_ADDRESS_REASKED"), "khoá lưu ADDRESS_REASK giữ nguyên — một hiện tượng, một mã");
  assert.match(SALES_QUALITY_SPEC.ADDRESS_REASK.label, /KNOWN_ADDRESS_REASKED/);
  const flaggedRaw = { review: { entries: [machine] } };
  assert.equal(addressNotApplied({ raw: flaggedRaw, shipAddress: STREET, shipProvince: "", shipCommune: WARD }, []), true, "đơn có phường mà cờ máy còn mở ⇒ đếm (đúng lỗi của ca)");
  assert.equal(addressNotApplied({ raw: flaggedRaw, shipAddress: STREET, shipProvince: "", shipCommune: "" }, [STREET, WARD]), true, "khách đã nêu phường của đúng địa chỉ mà đơn trống ⇒ đếm");
  assert.equal(addressNotApplied({ raw: flaggedRaw, shipAddress: STREET, shipProvince: "", shipCommune: "" }, [STREET]), false, "khách chưa cho phường ⇒ không phải lỗi");
  assert.equal(addressNotApplied({ raw: { review: { entries: [changed] } }, shipAddress: STREET, shipProvince: "", shipCommune: WARD }, []), false, "cờ «khách đổi địa chỉ» là việc của người ⇒ không đếm");
  assert.equal(addressNotApplied({ raw: {}, shipAddress: STREET, shipProvince: "", shipCommune: WARD }, []), false);

  // Ảnh chụp golden `hau-mai-da-nhan-hang` (bước 1 đổi đúng câu chờ địa chỉ; PR-A address-resolver-ladder 22/10/2026 đổi tiếp có chủ ý: đơn
  // chỉ chờ địa chỉ là đơn ĐÃ CHỐT với khách ⇒ câu chốt thường của bot đi qua). Không câu nào của ca còn nhắc «nhân viên xác nhận địa chỉ».
  const snap = readFileSync("tests/sales-agent-golden/snapshots/hau-mai-da-nhan-hang.json", "utf8");
  assert.ok(!snap.includes(BANNED) && !snap.includes(CLAIM_SAFE_TEXT.ORDER_RECEIVED), "ca hậu mãi: không câu cũ, không câu ghi nhận thay câu chốt");
  console.log("  ✓ thuần: tin chỉ-phường ghép vào địa chỉ có tỉnh đứng trước nó · không ghép tỉnh khác / địa chỉ cũ · gỡ đúng dòng cờ máy, vết ADDRESS_SETTLED");
}

const draft = (v: (sku: string) => string, extra: Record<string, unknown> = {}) => tool("update_draft_order", { items: [{ variant_id: v("RUOC-TOM"), quantity: 1 }], ...extra });
const firstTurn = (phone: string) => ({
  say: INFO(phone),
  ai: [
    () => [tool("create_customer", { name: "Lan", phone, address: STREET })],
    ({ v }: { v: (sku: string) => string }) => [tool("create_draft_order", { items: [{ variant_id: v("RUOC-TOM"), quantity: 1 }] })],
    () => [say("Dạ em lên đơn 1 × Ruốc bông tôm 100% cho mình rồi ạ.")],
  ],
});

const CASES: GoldenCase[] = [
  {
    key: "saa-kim-lien-tach-tin",
    title: "Dáng ca thật: tên + SĐT + địa chỉ (không phường) ⇒ tự chốt; «Phường Kim Liên» đứng riêng ⇒ sửa đơn có ward; gửi lại ward ⇒ không bị từ chối; cờ địa chỉ tự đóng",
    shop: "food",
    channel: "WEB",
    turns: [
      firstTurn("0961005201"),
      { say: WARD, ai: [({ v }) => [draft(v, { ward: WARD })], () => [say("Dạ em cập nhật phường cho đơn rồi ạ.")]] },
      { say: "giao giờ hành chính giúp chị nhé", ai: [({ v }) => [draft(v, { ward: WARD, delivery_note: "giờ hành chính" })], () => [say("Dạ vâng ạ.")]] },
    ],
  },
  {
    key: "saa-kim-lien-model-quen-ward",
    title: "Model sửa đơn mà QUÊN gửi ward ⇒ máy chủ tự áp phường từ tin chỉ-phường của khách",
    shop: "food",
    channel: "WEB",
    turns: [firstTurn("0961005202"), { say: WARD, ai: [({ v }) => [draft(v)], () => [say("Dạ em ghi nhận rồi ạ.")]] }],
  },
];

async function orderOf(conversationId: string) {
  const db = await getDb();
  const [o] = await db.select().from(schema.orders).where(eq(schema.orders.salesConversationId, conversationId));
  return o ?? null;
}

export async function testSalesAddressAppliedChat() {
  const seen = new Set<string>();
  await runGoldenCases(CASES, {
    orgSuffix: "-saa",
    beforeCase: async () => {
      // Cờ upsellAfterContact TẮT (mặc định) — xác minh địa chỉ phải đúng mà KHÔNG cần cờ (chủ shop 22/10/2026).
      await setSettingJson(QUICK_REPLY_SETTING_KEY, { enabled: true, aiMatch: false, upsellReplyId: null, autoLearn: false, autoActivate: false, autoUpsellOffer: false, upsellAfterContact: false });
      await setSettingJson(AUTO_CONFIRM_COMPLETE_SETTING_KEY, { enabled: true });
    },
    afterCase: async (c, ctx: GoldenHookCtx, t) => {
      seen.add(c.key);
      const o = await orderOf(ctx.conversationId);
      const all = t.turns.flatMap((x) => x.shown);
      const results = t.turns.map((x) => JSON.stringify(x.rounds.map((r) => r.results)));
      assert.ok(o, `[${c.key}] có đơn`);
      assert.equal(o.stage, "CONFIRMED", `[${c.key}] đơn tự chốt như chính sách`);
      // (4) Không câu «nhân viên sẽ xác nhận lại địa chỉ» dù cờ upsell TẮT.
      assert.ok(!all.some((s) => s.includes(BANNED)), `[${c.key}] câu cũ tới khách: ${all.join(" | ")}`);
      // 22/10/2026 (AGENTS 3.12b): đơn chỉ chờ địa chỉ là đơn ĐÃ CHỐT với khách ⇒ câu chốt THƯỜNG của bot đi qua nguyên văn, không câu ghi nhận.
      assert.ok(t.turns[0].shown.includes("Dạ em lên đơn 1 × Ruốc bông tôm 100% cho mình rồi ạ.") && !t.turns[0].shown.includes(CLAIM_SAFE_TEXT.ORDER_RECEIVED), `[${c.key}] lượt chốt ⇒ câu chốt thường: ${t.turns[0].shown.join(" | ")} · ${results[0].slice(0, 600)}`);
      // (1) Phường vào đơn; lượt gửi lại không bị từ chối.
      assert.equal(o.shipCommune, WARD, `[${c.key}] phường khách đã cho vào đơn: ${results.slice(1).join(" || ").slice(0, 900)}`);
      for (const r of results.slice(1)) assert.doesNotMatch(r, /xã \/ phường chưa xác nhận/, `[${c.key}] gửi lại đúng phường đã lưu bị từ chối: ${r.slice(0, 600)}`);
      // (2) Cờ địa chỉ của máy tự đóng, có vết của MÁY.
      assert.equal(addressReviewOpenOf(o.raw), false, `[${c.key}] cờ ADDRESS_UNRESOLVED còn mở sau khi đơn đã có phường: ${JSON.stringify(orderReviewOf(o.raw))}`);
      const settled = orderReviewLogOf(o.raw).find((r) => r.action === "ADDRESS_SETTLED");
      assert.ok(settled && settled.byUserId === null, `[${c.key}] vết gỡ cờ của máy: ${JSON.stringify(orderReviewLogOf(o.raw))}`);
      // (5) Sau khi khách đã cho, không câu nào xin lại phường / địa chỉ.
      for (const s of t.turns.slice(1).flatMap((x) => x.shown)) assert.doesNotMatch(s, ASKS_ADDRESS, `[${c.key}] xin lại địa chỉ: ${s}`);
    },
  });
  assert.equal(seen.size, CASES.length, "mọi ca đều chạy");
}

export async function testSalesAddressApplied(): Promise<void> {
  testSalesAddressAppliedPure();
  await testSalesAddressAppliedChat();
  console.log("✓ P0 xin lại địa chỉ (HSLC #8037F35A): tin chỉ-phường vào đơn · gửi lại phường đã lưu không bị từ chối · cờ địa chỉ của máy tự đóng (vết ADDRESS_SETTLED) · model quên ward ⇒ máy chủ tự áp · không câu «nhân viên sẽ xác nhận lại địa chỉ» dù cờ upsell tắt · không xin lại địa chỉ");
}

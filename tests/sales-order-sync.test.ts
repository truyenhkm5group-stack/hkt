/**
 * ═══════════ GHI ĐƠN TỪ HỘI THOẠI FANPAGE + KHÁCH MUA LẠI (lib/sales-chatbot/order-sync.ts · tools.ts) ═══════════
 *
 * Chủ shop HSLC 03/10/2026: «bật/tắt chatbot không ảnh hưởng đến việc đồng bộ đơn hàng» và «khách cũ mua lại không cho lại
 * SĐT, địa chỉ thì phải biết mà lên được đơn — tính là đơn mới».
 *
 *  1. THUẦN — đọc JSON của AI (rào ```json, rác), SĐT trong chữ, địa chỉ có thật trong hội thoại, mốc cắt, quyết định của máy
 *     chủ (lời chốt cũ · món lạ · bịa SĐT · bịa địa chỉ ⇒ không lên đơn; khách cũ ⇒ lấy SĐT / địa chỉ đơn trước), lượt mua mới
 *     trần lượt của bot đếm theo lượt mua.
 *  2. TỔ CHỨC THẬT `os-hslc`: bot TẮT mà đơn nhân viên chốt vẫn vào ERP (trạng thái «Mới», kênh riêng, mã tin chốt trong ghi
 *     chú, chuông người làm đơn); chạy lại không ghi trùng; khách mua lại không gửi SĐT / địa chỉ ⇒ đơn MỚI theo đơn trước;
 *     bot BẬT và đang trả lời ⇒ không ghi (đơn của bot); bật / tắt bot và bật / tắt ghi đơn là hai khoá cài đặt riêng.
 *  3. BOT: khách quen quay lại sau 3 ngày (hội thoại đã quá 60 lượt) ⇒ lượt mua mới, không «Hội thoại quá dài»; lượt chat
 *     không xoá nhật ký ghi đơn mà job vừa ghi trong lúc lượt đang chạy.
 *
 * Mốc thời gian đi theo ĐỒNG HỒ THẬT (luật 50): mọi mốc tính từ `new Date()` lúc chạy.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { AiBlock, AiProvider, AiRequest, AiResponse } from "@/lib/ai/provider";
import type { SessionUser } from "@/lib/auth/session";
import { saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_LIMITS, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { chatTurn, cycleStartTurns, loadSalesChatbotConfig, openConversation, POST_ORDER_HANDOFF_MS, setSalesChatProviderForTests } from "@/lib/sales-chatbot/engine";
import { addressGrounded, decideOrderSync, loadOrderSyncConfig, orderSyncPrompt, parseOrderSyncReply, phonesInText, reorderConfirmText, reorderTotalVisible, runFanpageOrderSync, saveOrderSyncConfig, syncCutoff, syncFanpageThreadWhenQuiet, type OrderSyncReply, type SyncMessage } from "@/lib/sales-chatbot/order-sync";
import { ORDER_SYNC_CHANNEL, ORDER_SYNC_LIMITS, ORDER_SYNC_SETTING_KEY, orderGroupText, parseOrderSyncConfig, type OrderSyncThreadState } from "@/lib/sales-chatbot/order-sync-shared";
import type { ReturningCustomer } from "@/lib/sales-chatbot/returning";
import type { ChatState } from "@/lib/sales-chatbot/tools";
import { setSettingJson } from "@/lib/settings";
import { orderChatThreads } from "@/lib/queries/orders";

const ORG = "os-hslc";
const PAGE = "5566778899";

async function cleanupOrg() {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, ORG) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

const reply = (over: Partial<OrderSyncReply>): OrderSyncReply => ({ kind: "NEW_ORDER", items: [], recipient_name: "", recipient_phone: "", address: "", use_previous_address: false, delivery_note: "", agreement_index: null, summary: "", ...over });

function testPure() {
  // ── Đọc câu trả lời của AI ──
  assert.equal(parseOrderSyncReply("không có gì"), null);
  assert.equal(parseOrderSyncReply('{"kind":"MAYBE"}'), null, "loại lạ ⇒ không nhận");
  const fenced = parseOrderSyncReply('Đây:\n```json\n{"kind":"NEW_ORDER","items":[{"variant_id":"v1","quantity":2}],"agreement_index":5}\n```');
  assert.ok(fenced && fenced.kind === "NEW_ORDER" && fenced.items[0].quantity === 2 && fenced.use_previous_address === false, "bỏ rào ```json, ô thiếu lấy mặc định");
  assert.equal(parseOrderSyncReply('{"kind":"NEW_ORDER","items":[{"variant_id":"v1","quantity":0}]}'), null, "số lượng 0 ⇒ không nhận");

  // ── SĐT / địa chỉ / mốc cắt ──
  assert.deepEqual(phonesInText("Lan 0912 345 678, gọi +84 987.654.321 nhé, mã 12345"), ["0912345678", "0987654321"]);
  assert.deepEqual(phonesInText("sđt 0909938344 1kg nhé"), ["0909938344"], "số di động 10 chữ số không nuốt chữ số của con số đứng sau");
  assert.deepEqual(phonesInText("bàn 0243 826 1234"), ["02438261234"], "số bàn 11 chữ số giữ nguyên");
  const corpus = "Chị Lan 0912345678, 12 Hàng Bạc, Hoàn Kiếm, Hà Nội";
  assert.ok(addressGrounded("12 Hàng Bạc, Q. Hoàn Kiếm, Hà Nội", corpus), "AI viết gọn lại vẫn nhận (≥ 70% từ có trong hội thoại)");
  assert.ok(!addressGrounded("45 Lý Thường Kiệt, Hai Bà Trưng, Hà Nội", corpus), "địa chỉ không có trong hội thoại ⇒ không nhận");
  assert.ok(!addressGrounded("Hà Nội", corpus), "quá ngắn ⇒ không nhận");
  assert.equal(syncCutoff([null, undefined, "2026-10-01T00:00:00Z", new Date("2026-10-02T00:00:00Z"), "rác"]), Date.parse("2026-10-02T00:00:00Z"));
  assert.equal(syncCutoff([]), 0);
  assert.deepEqual(parseOrderSyncConfig(null), { enabled: false, enabledAt: null }, "chưa cấu hình ⇒ TẮT");
  assert.deepEqual(parseOrderSyncConfig({ enabled: "yes" }), { enabled: false, enabledAt: null }, "sai hình ⇒ TẮT");

  // ── Quyết định của máy chủ ──
  const t0 = Date.parse("2026-10-03T03:00:00Z");
  const at = (min: number) => new Date(t0 + min * 60_000).toISOString();
  const msgs: SyncMessage[] = [
    { index: 1, id: "m1", from: "customer", text: "Cho chị 2kg chả mực", at: at(0) },
    { index: 2, id: "m2", from: "shop", text: "Dạ chị cho em SĐT, địa chỉ ạ", at: at(1) },
    { index: 3, id: "m3", from: "customer", text: corpus, at: at(2) },
    { index: 4, id: "m4", from: "customer", text: "ok em lên đơn", at: at(3) },
  ];
  const ids = new Set(["v1", "v2"]);
  const base = { messages: msgs, cutoffMs: t0 - 1, catalogIds: ids, returning: null, knownPhones: [], fallbackName: "Khách FB" };
  // (04/10/2026 · «Đỗ Thị Hoa») tin nhóm của đơn ghi từ hội thoại phải ĐỦ: tên, SĐT, địa chỉ, món × SL × giá, tiền hàng, ship, thu.
  const gt = orderGroupText({ header: "🧾 ĐƠN MỚI", name: "Đỗ Thị Hoa", phone: "0985664363", address: "27 Trương Mỹ, phường Lê Thanh Nghị", province: "Hải Dương", lines: [{ name: "Chả cá thu (Size: 1kg (2 túi 0,5kg))", quantity: 1, unitPrice: 280_000, lineTotal: 280_000 }], subtotal: 280_000, shippingFee: null, shipText: null, warnings: [] });
  for (const k of ["THU TIỀN: 280.000", "+ ship", "Khách: Đỗ Thị Hoa · 0985664363", "Địa chỉ: 27 Trương Mỹ, phường Lê Thanh Nghị, Hải Dương", "• Chả cá thu (Size: 1kg (2 túi 0,5kg)) × 1 × 280.000", "Tiền hàng: 280.000", "Ship: chưa báo"]) assert.ok(gt.includes(k), `tin nhóm thiếu «${k}»: ${gt}`);
  // (04/10/2026) chủ shop: không mã đơn, không nguồn, không link ERP.
  for (const k of ["#", "Nguồn", "ERP", "http"]) assert.ok(!gt.includes(k), `tin nhóm không được có «${k}»: ${gt}`);
  const gt2 = orderGroupText({ header: "🧾 ĐƠN MỚI", name: "Lan", phone: "0912345678", address: "12 Hàng Bạc, Hà Nội", province: "Hà Nội", lines: [{ name: "Chả mực", quantity: 2, unitPrice: 400_000, lineTotal: 800_000 }], subtotal: 800_000, shippingFee: 0, shipText: "Miễn phí", warnings: ["Địa chỉ theo đơn trước — xác nhận với khách"] });
  assert.ok(gt2.includes("Địa chỉ: 12 Hàng Bạc, Hà Nội\n") && gt2.includes("Ship: Miễn phí") && !gt2.includes("+ ship") && gt2.includes("Địa chỉ theo đơn trước"), gt2);
  const good = decideOrderSync({ ...base, reply: reply({ items: [{ variant_id: "v1", quantity: 1 }, { variant_id: "v1", quantity: 1 }], recipient_name: "Lan", recipient_phone: "0912.345.678", address: "12 Hàng Bạc, Hoàn Kiếm, Hà Nội", agreement_index: 4 }) });
  assert.ok(good.kind === "CREATE", JSON.stringify(good));
  assert.deepEqual(good.lines, [{ variantId: "v1", quantity: 2 }], "hai dòng cùng mã ⇒ gộp");
  assert.deepEqual([good.recipient.phone, good.phoneFrom, good.addressFrom, good.agreement.id], ["0912345678", "CHAT", "CHAT", "m4"]);
  assert.equal(decideOrderSync({ ...base, cutoffMs: Date.parse(at(3)), reply: reply({ items: [{ variant_id: "v1", quantity: 1 }], recipient_phone: "0912345678", address: corpus, agreement_index: 4 }) }).kind, "SKIP", "lời chốt KHÔNG sau mốc cắt (thuộc đơn đã ghi) ⇒ không lên đơn lần hai");
  assert.equal(decideOrderSync({ ...base, reply: reply({ items: [{ variant_id: "v1", quantity: 1 }], recipient_phone: "0912345678", address: corpus, agreement_index: 99 }) }).kind, "SKIP", "chỉ số tin không có thật");
  assert.match((decideOrderSync({ ...base, reply: reply({ items: [{ variant_id: "lạ", quantity: 1 }], recipient_phone: "0912345678", address: corpus, agreement_index: 4 }) }) as { reason: string }).reason, /danh mục/, "món ngoài danh mục ⇒ nhân viên lên tay");
  const madeUpPhone = decideOrderSync({ ...base, reply: reply({ items: [{ variant_id: "v1", quantity: 1 }], recipient_phone: "0999888777", address: corpus, agreement_index: 4 }) });
  assert.ok(madeUpPhone.kind === "SKIP" && /SĐT/.test(madeUpPhone.reason), "SĐT không có trong hội thoại, không có khách cũ ⇒ không lên đơn");
  const madeUpAddr = decideOrderSync({ ...base, reply: reply({ items: [{ variant_id: "v1", quantity: 1 }], recipient_phone: "0912345678", address: "45 Lý Thường Kiệt, Hai Bà Trưng, Hà Nội", agreement_index: 4 }) });
  assert.ok(madeUpAddr.kind === "SKIP" && /địa chỉ/.test(madeUpAddr.reason), "địa chỉ bịa ⇒ không lên đơn");
  const old: ReturningCustomer = { trust: "THREAD", customerId: "c1", name: "Nguyễn Thị Lan", phone: "0912345678", address: "12 Hàng Bạc, Hoàn Kiếm", province: "Hà Nội", orders: 1, lastOrderAt: at(-1000), lastItems: [] };
  const again: SyncMessage[] = [{ index: 1, id: "n1", from: "customer", text: "Cho chị 1kg chả mực nữa nhé", at: at(10) }, { index: 2, id: "n2", from: "customer", text: "ừ em", at: at(11) }];
  const reorder = decideOrderSync({ ...base, messages: again, returning: old, reply: reply({ items: [{ variant_id: "v1", quantity: 1 }], use_previous_address: true, agreement_index: 2 }) });
  assert.ok(reorder.kind === "CREATE" && reorder.phoneFrom === "PREVIOUS" && reorder.addressFrom === "PREVIOUS", JSON.stringify(reorder));
  // REVIEW BẢO MẬT 08/10/2026 (CRITICAL): khách cũ chỉ khớp qua SĐT xuất hiện trong hội thoại (mức PHONE — ai cũng gõ được SĐT
  // người khác) ⇒ KHÔNG dùng SĐT / địa chỉ lần trước. Không có lối tắt «hội thoại từng có đơn mang SĐT đó» (review vòng 3: kẻ gian
  // tự lên đơn nháp ghi SĐT nạn nhân là có) — chỉ khớp mã Facebook (FB_ID) hoặc khách tự khai trong hội thoại (THREAD).
  const phoneOnly: ReturningCustomer = { ...old, trust: "PHONE", lastItems: ["Chả cá thu (1kg) × 2"] };
  const spoof = decideOrderSync({ ...base, messages: again, returning: phoneOnly, reply: reply({ items: [{ variant_id: "v1", quantity: 1 }], use_previous_address: true, agreement_index: 2 }) });
  assert.ok(spoof.kind === "SKIP" && /chưa chứng minh là cùng người/.test(spoof.reason), `chỉ khớp SĐT ⇒ không lên đơn về địa chỉ cũ: ${JSON.stringify(spoof)}`);
  const byFbId: ReturningCustomer = { ...phoneOnly, trust: "FB_ID" };
  const viaFb = decideOrderSync({ ...base, messages: again, returning: byFbId, reply: reply({ items: [{ variant_id: "v1", quantity: 1 }], use_previous_address: true, agreement_index: 2 }) });
  assert.ok(viaFb.kind === "CREATE" && viaFb.addressFrom === "PREVIOUS" && viaFb.phoneFrom === "PREVIOUS", `khớp mã Facebook ⇒ khách cũ đặt lại như luật HSLC: ${JSON.stringify(viaFb)}`);
  assert.ok(orderSyncPrompt({ shop: "S", catalog: [], messages: again, cutoffMs: 0, returning: byFbId, lastRecorded: null }).user.includes("Chả cá thu"), "FB_ID ⇒ lời nhắc có món lần trước");
  const spoofPrompt = orderSyncPrompt({ shop: "S", catalog: [], messages: again, cutoffMs: 0, returning: phoneOnly, lastRecorded: null });
  assert.ok(!spoofPrompt.user.includes("Chả cá thu") && !spoofPrompt.system.includes("Chả cá thu") && /CHƯA chứng minh là cùng người/.test(spoofPrompt.user + spoofPrompt.system), "lời nhắc ghi đơn không mang món / thông tin cũ khi chưa chứng minh");
  assert.deepEqual(reorder.recipient, { name: "Nguyễn Thị Lan", phone: "0912345678", address: "12 Hàng Bạc, Hoàn Kiếm", province: "Hà Nội" }, "khách cũ không gửi lại ⇒ SĐT / địa chỉ / tên đơn trước");
  // ── Luật chốt của chủ shop HSLC (05/10/2026) ──
  //  · «Nguyễn Thị Nguyệt Quế»: khách chỉ hỏi giá; nhân viên DÁN LẠI lời đặt hàng cũ của khách + «E giao về đây cho c nhé» ⇒
  //    SĐT / địa chỉ chỉ nằm trong tin của SHOP ⇒ KHÔNG phải khách chốt hôm nay, dù AI chỉ vào tin nào.
  const pasted: SyncMessage[] = [
    { index: 1, id: "q1", from: "customer", text: "Báo giá chả cá thu?", at: at(0) },
    { index: 2, id: "q2", from: "shop", text: "Dạ 280k/1kg, mình lấy 1kg hay 2kg ạ?", at: at(1) },
    { index: 3, id: "q3", from: "shop", text: "Tôi một kí nhé, gởi về địa chỉ: 10/76/5 Hoàng Hoa Thám p 7 Q Bình Thạnh, số điện thoại: 0912345678", at: at(2) },
    { index: 4, id: "q4", from: "shop", text: "E giao về đây cho c nhé", at: at(3) },
  ];
  const quePick = reply({ items: [{ variant_id: "v1", quantity: 1 }], recipient_phone: "0912345678", address: "10/76/5 Hoàng Hoa Thám p 7 Q Bình Thạnh", agreement_index: 4 });
  for (const idx of [1, 3, 4]) {
    const r = decideOrderSync({ ...base, messages: pasted, knownPhones: ["0912345678"], reply: { ...quePick, agreement_index: idx } });
    assert.equal(r.kind, "SKIP", `SĐT / địa chỉ do SHOP dán lại ⇒ không lên đơn (tin ${idx}): ${JSON.stringify(r)}`);
  }
  const queOld = decideOrderSync({ ...base, messages: pasted, returning: old, reply: { ...quePick, agreement_index: 4 } });
  assert.equal(queOld.kind, "SKIP", "khách cũ nhưng tin chốt là của shop ⇒ không lên đơn theo địa chỉ cũ");
  //  · Khách TỰ gửi SĐT + địa chỉ rồi im lặng (shop nhắn «em lên đơn nhé») ⇒ CHỐT, lời chốt là tin khách gửi thông tin.
  const gave: SyncMessage[] = [
    { index: 1, id: "g1", from: "customer", text: "Báo giá chả cá thu?", at: at(0) },
    { index: 2, id: "g2", from: "shop", text: "Dạ 280k/1kg ạ, mình nhắn SĐT + địa chỉ em giao", at: at(1) },
    { index: 3, id: "g3", from: "customer", text: "Lan 0912345678, 12 Hàng Bạc, Hoàn Kiếm, Hà Nội", at: at(2) },
    { index: 4, id: "g4", from: "shop", text: "Dạ em lên đơn cho chị nhé", at: at(3) },
  ];
  const silentOk = decideOrderSync({ ...base, messages: gave, reply: reply({ items: [{ variant_id: "v1", quantity: 1 }], recipient_phone: "0912345678", address: "12 Hàng Bạc, Hoàn Kiếm, Hà Nội", agreement_index: 4 }) });
  assert.ok(silentOk.kind === "CREATE" && silentOk.agreement.id === "g3" && silentOk.phoneFrom === "CHAT" && silentOk.addressFrom === "CHAT", `khách tự gửi đủ SĐT + địa chỉ, im lặng sau đó ⇒ chốt: ${JSON.stringify(silentOk)}`);
  //  · Khách CŨ nhắn đặt lại về địa chỉ cũ ⇒ chốt theo thông tin lần trước (máy nhắn xác nhận lại cho khách).
  const reorderMsgs: SyncMessage[] = [{ index: 1, id: "r1", from: "customer", text: "Giao lại cho chị 1kg chả cá về địa chỉ cũ nhé", at: at(0) }];
  const re = decideOrderSync({ ...base, messages: reorderMsgs, returning: old, reply: reply({ items: [{ variant_id: "v1", quantity: 1 }], use_previous_address: true, agreement_index: 1 }) });
  assert.ok(re.kind === "CREATE" && re.phoneFrom === "PREVIOUS" && re.addressFrom === "PREVIOUS" && re.agreement.id === "r1", JSON.stringify(re));
  const conf = reorderConfirmText({ lines: [{ name: "Chả cá thu (1kg)", quantity: 1 }], total: 280_000, shippingFee: null, address: "12 Hàng Bạc, Hoàn Kiếm, Thành phố Hà Nội", phone: "0912345678" });
  for (const k of ["Chả cá thu (1kg) × 1", "280.000", "+ phí ship", "12 Hàng Bạc", "0912345678"]) assert.ok(conf.includes(k), `tin xác nhận lại thiếu «${k}»: ${conf}`);
  // Tổng theo bảng giá RIÊNG của hồ sơ khớp SĐT chỉ nhắn ra khi khớp mã Facebook (review bảo mật #647 M-a) — giá của đơn không đổi.
  assert.deepEqual(
    [
      reorderTotalVisible({ wholesalePricing: false, trust: "THREAD", hasCustomerList: true }),
      reorderTotalVisible({ wholesalePricing: true, trust: "THREAD", hasCustomerList: false }),
      reorderTotalVisible({ wholesalePricing: true, trust: "THREAD", hasCustomerList: true }),
      reorderTotalVisible({ wholesalePricing: true, trust: "FB_ID", hasCustomerList: true }),
      reorderTotalVisible({ wholesalePricing: true, trust: null, hasCustomerList: true }),
    ],
    [true, true, false, true, false],
    "giá lẻ / không bảng riêng / mã Facebook ⇒ nêu tổng; SĐT tự gõ + bảng riêng ⇒ không",
  );
  const hidden = reorderConfirmText({ lines: [{ name: "Chả cá thu (1kg)", quantity: 1 }], total: null, shippingFee: 25_000, address: "12 Hàng Bạc", phone: "0912345678" });
  assert.ok(!hidden.includes("₫") && !/\d{2,3}\.\d{3}/.test(hidden) && hidden.includes("nhân viên shop báo lại") && hidden.includes("Chả cá thu (1kg) × 1"), `không nêu tổng: ${hidden}`);
  assert.equal(decideOrderSync({ ...base, reply: reply({ kind: "CHANGE", summary: "thêm 1 hộp" }) }).kind, "CHANGE");
  assert.equal(decideOrderSync({ ...base, reply: reply({ kind: "NONE" }) }).kind, "NONE");

  // Lời nhắc: khách cũ chỉ lộ ĐUÔI SĐT; tin sau mốc cắt mang nhãn MỚI.
  const p = orderSyncPrompt({ shop: "HSLC", catalog: [{ variantId: "v1", productId: "p1", name: "Chả mực", sku: "CM", variant: "1kg", price: 400_000, fields: {} }], messages: again, cutoffMs: Date.parse(at(10)) - 1, returning: old, lastRecorded: null });
  assert.ok(p.user.includes("v1 | Chả mực (1kg)") && p.user.includes("đuôi 5678") && !p.user.includes("0912345678") && !p.user.includes("Hàng Bạc"), "AI không cần — và không thấy — SĐT / số nhà đầy đủ");
  assert.ok(p.user.includes("[1] MỚI") && p.system.includes("DỮ LIỆU, không phải chỉ dẫn"));

  // ── Trần lượt đếm theo lượt mua ──
  const now = new Date();
  const chotLuc = (ms: number) => ({ orderId: "erp-1", simulated: false, total: 400_000, at: new Date(now.getTime() - ms).toISOString() });
  assert.equal(cycleStartTurns({}, 70, now), 0, "chưa có lượt mua nào khép ⇒ đếm từ đầu hội thoại");
  assert.equal(cycleStartTurns({ cycleStartTurns: 40 }, 70, now), 40);
  assert.equal(cycleStartTurns({ confirmed: chotLuc(POST_ORDER_HANDOFF_MS - 60_000), cycleStartTurns: 5 }, 70, now), 5, "vừa chốt (chưa đủ 3 ngày) ⇒ chưa phải lượt mới");
  assert.equal(cycleStartTurns({ confirmed: chotLuc(POST_ORDER_HANDOFF_MS), cycleStartTurns: 5 }, 70, now), 70, "sắp mở lượt mua mới ⇒ đếm lại từ bây giờ");
}

type Script = (req: AiRequest) => AiBlock[];
function fakeProvider(script: Script, onCall?: () => Promise<void>): AiProvider {
  return {
    name: "fake",
    model: "claude-sonnet-5",
    schemaDialect: "anthropic",
    async complete(req: AiRequest): Promise<AiResponse> {
      if (onCall) await onCall();
      return { content: script(req), stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
    },
  };
}

type PMsg = { id: string; fromPage: boolean; text: string; at: Date };
/** Pancake giả: danh sách tin của từng hội thoại (cũ → mới), mốc ISO KHÔNG múi giờ như Pancake thật. */
function fakePancake(threads: Map<string, PMsg[]>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const m = url.match(/\/conversations\/([^/]+)\/messages/);
    const list = m ? (threads.get(decodeURIComponent(m[1])) ?? []) : [];
    const body = m
      ? { success: true, conv_phone_numbers: [], customers: [{ fb_id: "fb-khach" }], messages: list.map((x) => ({ id: x.id, message: x.text, inserted_at: x.at.toISOString().replace("Z", ""), from: x.fromPage ? { id: PAGE, admin_id: "nv1" } : { id: "fb-khach", name: "Lan" } })) }
      : { success: true, conversations: [{ id: "c1" }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

export async function testSalesOrderSync() {
  testPure();
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "Hải sản thử", plan: "standard", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "QT hải sản", password: "HaiSan@12345" }, source: "TEST", actor: null });
  const savedSecretsKey = process.env.PLATFORM_SECRETS_KEY;
  process.env.PLATFORM_SECRETS_KEY = "khoa-kiem-thu-ghi-don-0123456789abcdefghijklmnopqrstuvwxyz";
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const admin: SessionUser = { id: u.id, email: u.email, name: "QT hải sản", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: "Hải sản thử", isHome: false }, modules: [...(await getEnabledModules(ORG))] };
      await db.insert(schema.products).values({ id: "erp-os-p", name: "Chả mực giã tay", raw: { origin: "ERP_MANUAL" } });
      await db.insert(schema.productVariants).values({ id: "erp-os-v", productId: "erp-os-p", sku: "CHA-MUC", size: "1kg", retailPrice: 400_000 });
      // Bài này kiểm đường KHOÁ RIÊNG của shop (BYOK, nhà cung cấp giả) — đường AI dùng chung có bài ở tests/quick-start.test.ts.
      await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, connectorKey: "anthropic-byok", enabled: false, shippingFee: 30_000 });

      const probe = fakePancake(new Map());
      assert.ok("ok" in (await saveConnection(admin, { connectorKey: "pancake-fanpage", settings: { pageId: PAGE }, secrets: { pageAccessToken: "pancake_page_token_os_0123456789" } })));
      assert.ok("ok" in (await testOrgConnection(admin, "pancake-fanpage", { tester: { fetch: probe } })));
      assert.ok("ok" in (await setConnectionStatus(admin, "pancake-fanpage", "ACTIVE")));

      // ── Hai công tắc, hai khoá: bật ghi đơn không đụng bot; tắt bot không đụng ghi đơn ──
      const t0 = Date.now();
      assert.deepEqual((await runFanpageOrderSync()).detail, ["ghi đơn từ hội thoại đang tắt"], "chưa bật ⇒ không làm gì");
      assert.ok("error" in (await saveOrderSyncConfig({ ...admin, role: "MANAGER", permissions: [] }, true)), "thiếu ai_sales:manage ⇒ từ chối");
      assert.ok("ok" in (await saveOrderSyncConfig(admin, true, new Date(t0 - 3_600_000))));
      assert.equal((await loadSalesChatbotConfig()).enabled, false, "bật ghi đơn KHÔNG bật bot");
      const sync0 = await loadOrderSyncConfig();
      assert.ok(sync0.enabled && sync0.enabledAt === new Date(t0 - 3_600_000).toISOString());
      assert.ok("ok" in (await saveOrderSyncConfig(admin, true, new Date(t0))), "bật lại khi đang bật");
      assert.equal((await loadOrderSyncConfig()).enabledAt, sync0.enabledAt, "đang bật mà lưu lại ⇒ giữ mốc bật cũ");

      // ── Hội thoại 1: bot TẮT, nhân viên chốt trên fanpage ──
      const min = (m: number) => new Date(t0 + m * 60_000);
      const threads = new Map<string, PMsg[]>();
      threads.set("t-1", [
        { id: "m1", fromPage: false, text: "Shop ơi cho chị 2kg chả mực", at: min(-30) },
        { id: "m2", fromPage: true, text: "Dạ chị cho em xin SĐT và địa chỉ ạ", at: min(-29) },
        { id: "m3", fromPage: false, text: "Lan 0912 345 678, 12 Hàng Bạc, Hoàn Kiếm, Hà Nội", at: min(-28) },
        { id: "m4", fromPage: true, text: "Em lên đơn 2kg chả mực về 12 Hàng Bạc nhé chị", at: min(-27) },
        { id: "m5", fromPage: false, text: "ok em", at: min(-26) },
      ]);
      const inbound = (threadId: string, id: string, text: string, at: Date, note: string | null = null) =>
        db.insert(schema.salesChatInbound).values({ pageId: PAGE, threadId, messageId: id, text, customerName: note ? null : "Lan Nguyễn", status: note ? "DONE" : "SKIPPED", note: note ?? "Shop chưa mở chat.", createdAt: at });
      await inbound("t-1", "m1", "Shop ơi cho chị 2kg chả mực", min(-30));
      await inbound("t-1", "m4", "Em lên đơn", min(-27), "PAGE_REPLY");
      await inbound("t-1", "m5", "ok em", min(-26));
      let calls = 0;
      setSalesChatProviderForTests(() =>
        fakeProvider((req) => {
          calls += 1;
          const text = req.messages.map((m) => m.content.map((b) => (b.type === "text" ? b.text : "")).join("")).join("");
          if (text.includes("ừ em gửi như cũ"))
            return [{ type: "text", text: JSON.stringify({ kind: "NEW_ORDER", items: [{ variant_id: "erp-os-v", quantity: 1 }], use_previous_address: true, agreement_index: 8, summary: "Khách cũ đặt lại 1kg" }) }];
          return [{ type: "text", text: "```json\n" + JSON.stringify({ kind: "NEW_ORDER", items: [{ variant_id: "erp-os-v", quantity: 2 }], recipient_name: "Lan", recipient_phone: "0912345678", address: "12 Hàng Bạc, Hoàn Kiếm, Hà Nội", agreement_index: 5, summary: "Chốt 2kg chả mực" }) + "\n```" }];
        }),
      );
      try {
        const fetchImpl = fakePancake(threads);
        const r1 = await runFanpageOrderSync({ fetch: fetchImpl });
        assert.deepEqual([r1.checked, r1.created, r1.errors], [1, 1, 0], JSON.stringify(r1));
        const orders1 = await db.select().from(schema.orders);
        assert.equal(orders1.length, 1);
        const o1 = orders1[0];
        assert.deepEqual([o1.stage, o1.source, o1.shipPhone, o1.shipAddress, o1.totalPriceAfterDiscount, o1.shippingFee], ["NEW", ORDER_SYNC_CHANNEL, "0912345678", "12 Hàng Bạc, Hoàn Kiếm, Hà Nội", 800_000, 30_000], "bot TẮT vẫn lên đơn «Mới», giá đọc từ ERP, phí ship theo cấu hình");
        assert.ok(o1.note.includes("Mã tin fanpage: m5") && o1.note.includes("KIỂM rồi chốt"), o1.note);
        assert.equal((await db.select().from(schema.customers).where(eq(schema.customers.phone, "0912345678"))).length, 1, "khách được tạo theo SĐT");
        const inbox = await db.select().from(schema.userMessages).where(and(eq(schema.userMessages.userId, u.id), eq(schema.userMessages.kind, "SALES_ORDER_SYNC")));
        assert.equal(inbox.length, 1, "người làm đơn nhận chuông");
        assert.equal((await loadSalesChatbotConfig()).enabled, false, "bot vẫn tắt");

        // Chạy lại khi không có tin mới ⇒ không đọc lại, không gọi AI, không đơn thứ hai.
        const before = calls;
        const r2 = await runFanpageOrderSync({ fetch: fetchImpl });
        assert.deepEqual([r2.checked, r2.created, calls], [0, 0, before], JSON.stringify(r2));
        // Hội thoại đã đọc tới tin cuối bị loại NGAY trong SQL (không chiếm chỗ trong trần ứng viên — HSLC 05/10/2026).
        assert.deepEqual(r2.detail, ["không hội thoại nào mới yên"], "hội thoại đã đọc không còn là ứng viên");

        // ── GHI NGAY (chủ shop HSLC 05/10/2026: tin báo đơn tới trễ 13–16 phút) ⇒ webhook hẹn MỘT lượt cho ĐÚNG hội thoại khi
        // nó yên `quietMinutes` phút; tin mới hơn tới trong lúc đợi ⇒ lượt này thôi (lượt đợi của tin mới lo).
        threads.set("t-q", [{ id: "q1", fromPage: false, text: "Cho chị 1kg chả mực nhé", at: min(-3) }]);
        await inbound("t-q", "q1", "Cho chị 1kg chả mực nhé", min(-3));
        const slept: number[] = [];
        const nap = async (ms: number) => void slept.push(ms);
        assert.equal(await syncFanpageThreadWhenQuiet(PAGE, "t-q", { fetch: fetchImpl, now: () => min(-2), sleep: nap }), null, "hội thoại chưa yên ⇒ chưa đọc");
        assert.equal(slept[0], ORDER_SYNC_LIMITS.quietMinutes * 60_000 + 5_000, "đợi đúng khoảng yên");
        assert.ok(ORDER_SYNC_LIMITS.quietMinutes <= 2, "tin báo đơn tới trong vài phút, không phải 10 + nhịp job");
        const quiet = await syncFanpageThreadWhenQuiet(PAGE, "t-q", { fetch: fetchImpl, now: () => min(0), sleep: nap });
        assert.equal(quiet?.checked, 1, `yên đủ ⇒ đọc ĐÚNG một hội thoại: ${JSON.stringify(quiet)}`);
        const [cq] = await db.select({ state: schema.salesChatConversations.state }).from(schema.salesChatConversations).where(eq(schema.salesChatConversations.threadId, "t-q"));
        assert.ok(((cq.state as ChatState).orderSync as OrderSyncThreadState | undefined)?.lastRunAt, "hội thoại có nhật ký ghi đơn");

        // ── Khách cũ mua lại, KHÔNG gửi lại SĐT / địa chỉ ⇒ đơn MỚI theo đơn trước ──
        const later = (m: number) => new Date(t0 + 3 * 3_600_000 + m * 60_000);
        threads.get("t-1")!.push(
          { id: "m6", fromPage: false, text: "Cho chị 1kg chả mực nữa nhé", at: later(-20) },
          { id: "m7", fromPage: true, text: "Dạ em gửi về địa chỉ cũ nhé chị", at: later(-19) },
          { id: "m8", fromPage: false, text: "ừ em gửi như cũ", at: later(-18) },
        );
        await inbound("t-1", "m6", "Cho chị 1kg chả mực nữa nhé", later(-20));
        await inbound("t-1", "m8", "ừ em gửi như cũ", later(-18));
        const r3 = await runFanpageOrderSync({ fetch: fetchImpl, now: () => later(0) });
        assert.deepEqual([r3.checked, r3.created], [1, 1], JSON.stringify(r3));
        const orders2 = await db.select().from(schema.orders);
        assert.equal(orders2.length, 2, "lần mua sau là ĐƠN MỚI, không gộp vào đơn cũ");
        const o2 = orders2.find((o) => o.id !== o1.id)!;
        assert.deepEqual([o2.stage, o2.shipPhone, o2.shipAddress, o2.customerId, o2.totalPriceAfterDiscount], ["NEW", "0912345678", "12 Hàng Bạc, Hoàn Kiếm, Hà Nội", o1.customerId, 400_000], "SĐT + địa chỉ + khách theo đơn trước");
        assert.ok(o2.note.includes("lấy từ ĐƠN TRƯỚC") && o2.note.includes("Mã tin fanpage: m8"), o2.note);
        const [conv] = await db.select({ id: schema.salesChatConversations.id, state: schema.salesChatConversations.state }).from(schema.salesChatConversations).where(eq(schema.salesChatConversations.threadId, "t-1"));
        const log = (conv.state as ChatState).orderSync as OrderSyncThreadState;
        assert.deepEqual([log.orders.length, log.lastOutcome, log.customer?.phone], [2, "CREATED", "0912345678"]);
        // Nút «Chat» trên danh sách đơn: cả hai đơn tra ngược ra đúng hội thoại Pancake; đơn lạ không ra gì.
        const threadsOf = await orderChatThreads([o1.id, o2.id, "erp-khong-co"]);
        const pick = (x: { pageId: string | null; threadId: string | null; conversationId: string; channel: string } | undefined) => x && { pageId: x.pageId, threadId: x.threadId, conversationId: x.conversationId, channel: x.channel };
        assert.deepEqual([pick(threadsOf.get(o1.id)), pick(threadsOf.get(o2.id)), threadsOf.has("erp-khong-co")], [{ pageId: PAGE, threadId: "t-1", conversationId: conv.id, channel: "FANPAGE" }, { pageId: PAGE, threadId: "t-1", conversationId: conv.id, channel: "FANPAGE" }, false]);

        // ── Bot BẬT và đang trả lời ⇒ đơn là việc của bot, job không ghi ──
        await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, connectorKey: "anthropic-byok", enabled: true, shippingFee: 30_000 });
        threads.set("t-2", [{ id: "b1", fromPage: false, text: "ok chốt 1kg, 0987654321, 5 Lê Lợi, Huế", at: min(-25) }]);
        await inbound("t-2", "b1", "ok chốt 1kg, 0987654321, 5 Lê Lợi, Huế", min(-25));
        const callsBefore = calls;
        const r4 = await runFanpageOrderSync({ fetch: fetchImpl });
        assert.deepEqual([r4.checked, r4.created, calls], [0, 0, callsBefore], "bot đang phụ trách ⇒ không đọc, không tốn AI");
        assert.equal((await db.select().from(schema.orders)).length, 2);
        const [c2] = await db.select({ state: schema.salesChatConversations.state }).from(schema.salesChatConversations).where(eq(schema.salesChatConversations.threadId, "t-2"));
        assert.equal(((c2.state as ChatState).orderSync as OrderSyncThreadState).lastOutcome, "BOT");
        // ── Bot BẬT nhưng NGƯỜI nhắn sau tin cuối của bot (nhân viên chốt trên Pancake) ⇒ vẫn đọc hội thoại — không miss đơn ──
        threads.set("t-3", [
          { id: "h1", fromPage: false, text: "chốt cho chị 1kg nhé", at: min(-26) },
          { id: "h2", fromPage: true, text: "Dạ em lên đơn cho chị luôn ạ", at: min(-25) },
        ]);
        await inbound("t-3", "h1", "chốt cho chị 1kg nhé", min(-26));
        await inbound("t-3", "h2", "Dạ em lên đơn cho chị luôn ạ", min(-25), "PAGE_REPLY");
        const callsB = calls;
        const r5 = await runFanpageOrderSync({ fetch: fetchImpl });
        assert.ok(r5.checked === 1 && calls > callsB, `người nhắn sau bot ⇒ hội thoại vẫn được đọc (${JSON.stringify(r5)})`);
        const [c3] = await db.select({ state: schema.salesChatConversations.state }).from(schema.salesChatConversations).where(eq(schema.salesChatConversations.threadId, "t-3"));
        assert.notEqual(((c3.state as ChatState).orderSync as OrderSyncThreadState).lastOutcome, "BOT");
        // ── «Bot phụ trách» KHÔNG khoá hội thoại (HSLC 05/10/2026: khách chốt 1kg lúc 14:07, kịch bản Pancake trả lời, hội thoại
        //    bị ghi «BOT» rồi không bao giờ đọc lại): người nhắn mà khách KHÔNG nhắn thêm ⇒ lượt sau vẫn đọc. Máy không lên được
        //    đơn (SĐT AI đưa không có trong hội thoại) mà khách đã để SĐT ⇒ báo người làm đơn, MỘT lần.
        threads.set("t-2", [...(threads.get("t-2") ?? []), { id: "b2", fromPage: true, text: "Dạ em lên đơn 1kg cho anh ạ", at: min(-25) }]);
        await inbound("t-2", "b2", "Dạ em lên đơn 1kg cho anh ạ", min(-25), "PAGE_REPLY");
        const r6 = await runFanpageOrderSync({ fetch: fetchImpl });
        assert.equal(r6.checked, 1, `hội thoại từng ghi «BOT» được đọc lại khi có người nhắn (${JSON.stringify(r6)})`);
        const [c2b] = await db.select({ id: schema.salesChatConversations.id, state: schema.salesChatConversations.state }).from(schema.salesChatConversations).where(eq(schema.salesChatConversations.threadId, "t-2"));
        const log2 = (c2b.state as ChatState).orderSync as OrderSyncThreadState;
        assert.equal(log2.lastOutcome, "SKIPPED");
        assert.match(log2.lastResult, /đã báo nhân viên/);
        const leads = await db.select({ body: schema.notifications.body }).from(schema.notifications).where(eq(schema.notifications.entityId, c2b.id));
        assert.ok(leads.length === 1 && leads[0].body.includes("0987654321"), `một tin báo «khách để SĐT» kèm SĐT: ${JSON.stringify(leads)}`);
        await runFanpageOrderSync({ fetch: fetchImpl });
        assert.equal((await db.select({ id: schema.notifications.id }).from(schema.notifications).where(eq(schema.notifications.entityId, c2b.id))).length, 1, "không báo lại cùng SĐT");
        // Tắt ghi đơn không đụng bot.
        assert.ok("ok" in (await saveOrderSyncConfig(admin, false)));
        assert.equal((await loadSalesChatbotConfig()).enabled, true, "tắt ghi đơn KHÔNG tắt bot");

        // ── BOT: khách quen quay lại sau 3 ngày ⇒ lượt mua mới, KHÔNG «Hội thoại quá dài»; lượt chat giữ nhật ký ghi đơn ──
        const opened = await openConversation("TEST");
        const turnsBefore = SALES_CHATBOT_LIMITS.turnsPerConversation + 5;
        const oldConfirm = { orderId: null, simulated: true, total: 400_000, at: new Date(t0 - POST_ORDER_HANDOFF_MS - 3_600_000).toISOString() };
        await db
          .update(schema.salesChatConversations)
          .set({ turns: turnsBefore, state: { customer: { id: null, name: "Lan", phone: "0912345678", address: "12 Hàng Bạc", province: "Hà Nội", simulated: true }, confirmed: oldConfirm, stage: "DONE" } })
          .where(eq(schema.salesChatConversations.id, opened.id));
        const concurrent: OrderSyncThreadState = { checkedUntil: new Date(t0).toISOString(), lastRunAt: new Date(t0).toISOString(), lastOutcome: "NONE", lastResult: "ghi giữa lượt", orders: [] };
        setSalesChatProviderForTests(() =>
          fakeProvider(
            () => [{ type: "text", text: "Dạ chị lấy mấy kg ạ?" }],
            // Job ghi đơn ghi nhật ký TRONG LÚC lượt chat đang chạy.
            async () => {
              await db.update(schema.salesChatConversations).set({ state: { ...((await db.select({ s: schema.salesChatConversations.state }).from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, opened.id)))[0].s as ChatState), orderSync: concurrent } }).where(eq(schema.salesChatConversations.id, opened.id));
            },
          ),
        );
        const turn = await chatTurn(opened.id, "Shop ơi cho chị đặt thêm chả mực", { channel: "TEST" });
        assert.ok(turn.ok, JSON.stringify(turn));
        assert.notEqual(turn.view.status, "HANDOFF", "đếm lượt theo lượt mua ⇒ khách quen không bị «Hội thoại quá dài»");
        const [after] = await db.select({ state: schema.salesChatConversations.state }).from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, opened.id));
        const sa = after.state as ChatState;
        assert.ok(!sa.confirmed && sa.pastOrders?.length === 1 && sa.customer?.phone === "0912345678" && sa.cycleStartTurns === turnsBefore, JSON.stringify(sa));
        assert.equal(sa.orderSync?.lastResult, "ghi giữa lượt", "lượt chat không xoá nhật ký ghi đơn");
      } finally {
        setSalesChatProviderForTests(null);
      }
      assert.notEqual(ORDER_SYNC_SETTING_KEY as string, SALES_CHATBOT_SETTING_KEY as string, "hai công tắc, hai khoá cài đặt");
    });
    console.log("  ✓ ghi đơn từ hội thoại fanpage: bot TẮT vẫn lên đơn «Mới» · chạy lại không trùng · khách cũ không gửi lại SĐT/địa chỉ ⇒ đơn MỚI theo đơn trước · bot đang trả lời ⇒ không ghi · người nhắn sau bot ⇒ vẫn đọc · hai công tắc độc lập · trần lượt bot theo lượt mua · lượt chat giữ nhật ký ghi đơn");
  } finally {
    if (savedSecretsKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = savedSecretsKey;
    await cleanupOrg();
  }
}

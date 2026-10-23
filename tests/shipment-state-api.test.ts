/**
 * ═══ Cửa nội bộ bot nhà → ERP: chặng vận đơn theo chứng từ VTP (23/10/2026) ═══
 *
 * Pilot pos-reship-link: đơn Pancake «Đã hủy» trong khi kiện gửi lại đã giao; partner_status POS mô tả vận đơn GỐC. Khoá: (1) route chỉ
 * đọc, khoá header so thời gian hằng, khoá rỗng ⇒ 401, ≤ 20 mã mỗi loại, mã lạ ⇒ 400, không tiền / người nhận; chỉ vận đơn CÓ chứng từ;
 * đơn ⇒ lần gửi CHÍNH (PRIMARY_ATTEMPT); (2) middleware mở ĐÚNG một đường; (3) bot: đơn huỷ thật vẫn «Đã hủy» · huỷ + gửi lại đã giao ⇒
 * «đã được gửi lại» + mã mới + chặng ERP · trạng thái tiêu cực của Pancake không nói thẳng khi ERP không có chứng từ · route lỗi ⇒ câu cũ.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { eq, inArray, like } from "drizzle-orm";
import { NextRequest } from "next/server";
import { schema, type Db } from "@/db";
import { parseShipmentQuery, SHIPMENT_STATE_MAX_CODES, SHIPMENT_STATE_PATH } from "@/lib/constants/shipment-state-api";
import { primaryShipmentsByOrders, shipmentStatesByCodes } from "@/lib/queries/shipment-state-internal";
import { GET } from "@/app/api/internal/shipment-state/route";

function testParse() {
  assert.deepEqual(parseShipmentQuery("pke1552761607, 155281559687,PKE1552761607", null), { codes: ["PKE1552761607", "155281559687"], orders: [] }, "viết hoa, bỏ trùng");
  assert.deepEqual(parseShipmentQuery(null, "6457"), { codes: [], orders: ["6457"] });
  assert.ok("error" in parseShipmentQuery(null, null) && "error" in parseShipmentQuery("", ""), "không có gì để hỏi ⇒ lỗi");
  assert.ok("error" in parseShipmentQuery("PKE1'; drop", null), "mã lạ ⇒ lỗi, không lọc ngầm");
  assert.ok("error" in parseShipmentQuery(null, "erp-abc"), "đơn ERP không nhận");
  const nhieu = Array.from({ length: SHIPMENT_STATE_MAX_CODES + 1 }, (_, i) => `PKE${String(1000000000 + i)}`).join(",");
  assert.ok("error" in parseShipmentQuery(nhieu, null), `> ${SHIPMENT_STATE_MAX_CODES} mã ⇒ lỗi`);
}

function testSource() {
  const mw = readFileSync("middleware.ts", "utf8");
  assert.match(mw, /const PUBLIC_EXACT = \[[^\]]*SHIPMENT_STATE_PATH\]/, "mở ĐÚNG đường này, khớp từng chữ");
  assert.doesNotMatch(mw, /PUBLIC_PREFIXES = \[[^\]]*"\/api\/internal/, "không mở tiền tố /api/internal");
  assert.equal(SHIPMENT_STATE_PATH, "/api/internal/shipment-state");
  const q = readFileSync("lib/queries/shipment-state-internal.ts", "utf8");
  for (const col of ["receiver", "cod_amount", "cod_collected", "codAmount", "codCollected", "ship_phone", "bill_phone", "total_price"]) assert.ok(!q.includes(col), `truy vấn không đọc ${col}`);
  assert.match(q, /\$\{PRIMARY_ATTEMPT\}/, "lần gửi chính theo đúng PRIMARY_ATTEMPT");
  const r = readFileSync("app/api/internal/shipment-state/route.ts", "utf8");
  assert.match(r, /secretEquals\(request\.headers\.get\(SHIPMENT_STATE_TOKEN_HEADER\), chatbotConfig\(\)\.token\)/, "khoá qua header, so thời gian hằng");
  assert.ok(!r.includes("searchParams.get(\"token\")"), "không nhận khoá trên URL");
  const compose = readFileSync("docker-compose.prod.yml", "utf8");
  assert.match(compose, /ERP_INTERNAL_URL: http:\/\/app:3000/, "bot biết đường tới ERP trong mạng nội bộ");
}

async function testDbAndRoute(db: Db) {
  const s = schema.shipments;
  const DON = "990611";
  const donDep = async () => {
    await db.delete(s).where(like(s.id, "ssa-%"));
    await db.delete(schema.orders).where(eq(schema.orders.id, DON));
  };
  await donDep();
  const saved = process.env.CHATBOT_ADMIN_TOKEN;
  try {
    await db.insert(schema.orders).values({ id: DON, systemId: 990611, stage: "CANCELLED", cod: 524000, insertedAt: new Date("2026-10-20T00:00:00Z") });
    await db.insert(s).values([
      { id: "ssa-1", orderId: DON, carrier: "Viettel Post", vtpOrderNumber: "PKE9906110001", trackingCode: "PKE10999061100", attemptNo: 1, stage: "CANCELLED", isFinal: true, vtpStatusDate: new Date("2026-10-21T08:00:00Z"), receiverPhone: "0901234567", codAmount: 524000 },
      { id: "ssa-2", orderId: DON, carrier: "Viettel Post", vtpOrderNumber: "155990611002", trackingCode: "155990611002", attemptNo: 2, stage: "DELIVERED", isFinal: true, vtpStatusDate: new Date("2026-10-22T03:00:00Z"), raw: { reship: { of: "ssa-1", by: "VTP_WEBHOOK", at: "2026-10-21T00:00:00Z" } }, receiverPhone: "0901234567", codAmount: 524000 },
      { id: "ssa-3", orderId: null, carrier: "Viettel Post", vtpOrderNumber: "155990611003", trackingCode: "155990611003", stage: "IN_TRANSIT" },
    ]);
    const states = await shipmentStatesByCodes(["PKE9906110001", "155990611002", "155990611003"]);
    assert.deepEqual(states.map((x) => x.code).sort(), ["155990611002", "PKE9906110001"], "chỉ vận đơn CÓ chứng từ VTP");
    const ords = await primaryShipmentsByOrders([DON, "990612"]);
    assert.deepEqual(ords, [{ orderId: DON, code: "155990611002", stage: "DELIVERED", final: true, at: "2026-10-22T03:00:00.000Z", reship: true }], "lần gửi CHÍNH = lần gửi kế đã giao");

    const call = (qs: string, token?: string) => GET(new NextRequest(`http://app:3000${SHIPMENT_STATE_PATH}?${qs}`, { headers: token === undefined ? {} : { "x-chatbot-token": token } }));
    process.env.CHATBOT_ADMIN_TOKEN = "";
    assert.equal((await call(`orders=${DON}`, "")).status, 401, "khoá máy chủ rỗng ⇒ 401 mọi lượt");
    process.env.CHATBOT_ADMIN_TOKEN = "khoa-thu-ssa-1234";
    assert.equal((await call(`orders=${DON}`)).status, 401, "thiếu khoá ⇒ 401");
    assert.equal((await call(`orders=${DON}`, "khoa-thu-ssa-1235")).status, 401, "khoá sai ⇒ 401");
    assert.equal((await call(`orders=${DON}&token=khoa-thu-ssa-1234`)).status, 401, "khoá trên URL không được nhận");
    assert.equal((await call("codes=x'y", "khoa-thu-ssa-1234")).status, 400);
    const ok = await call(`codes=155990611002&orders=${DON}`, "khoa-thu-ssa-1234");
    assert.equal(ok.status, 200);
    const text = await ok.text();
    assert.ok(!/0901234567|524000|receiver|cod_?amount|"cod"/i.test(text), `không tiền, không người nhận: ${text}`);
    const body = JSON.parse(text) as { states: { code: string }[]; orders: { orderId: string; reship: boolean }[] };
    assert.deepEqual([body.states.map((x) => x.code), body.orders.map((x) => [x.orderId, x.reship])], [["155990611002"], [[DON, true]]]);
  } finally {
    if (saved === undefined) delete process.env.CHATBOT_ADMIN_TOKEN;
    else process.env.CHATBOT_ADMIN_TOKEN = saved;
    await donDep();
    await db.delete(s).where(inArray(s.id, ["ssa-1", "ssa-2", "ssa-3"]));
  }
}

type BotOrders = {
  describeOrder: (o: Record<string, unknown>, erp?: { byCode: Record<string, unknown>; byOrder: Record<string, unknown> }) => string;
  erpOrderView: (orders: Record<string, unknown>[], opts: { fetchImpl: (u: string, i: { headers: Record<string, string> }) => Promise<unknown>; now?: () => number; baseUrl?: string; token?: string }) => Promise<{ byCode: Record<string, unknown>; byOrder: Record<string, unknown> }>;
};

async function testBot() {
  // Module THUẦN (không nạp config / logger): nạp nó không chốt DATA_DIR của bot cho các bài sau.
  const bot = (await import(pathToFileURL(path.resolve("chatbot/src/order-view.js")).href)) as BotOrders;
  const huy = { id: 6457, status: 6, items: [{ quantity: 1, variation_info: { display_id: "CCT-1KG" } }], partner: { order_number_vtp: "155281559687", extend_code: "PKE10948632210", partner_status: "canceled", picked_up_at: "2026-10-20T03:00:00" }, cod: 524000 };
  // Đơn huỷ THẬT (ERP không có lần gửi kế) ⇒ vẫn «Đã hủy», như hôm nay.
  const that = bot.describeOrder(huy);
  assert.match(that, /^Đơn #6457: Đã hủy/, that);
  // Huỷ + gửi lại đã giao ⇒ «đã được gửi lại», mã mới + chặng ERP, không mốc lấy hàng của vận đơn cũ.
  const view = { byCode: {}, byOrder: { "6457": { orderId: "6457", code: "155281559687", stage: "DELIVERED", final: true, at: "2026-10-22T03:33:03Z", reship: true } } };
  const lai = bot.describeOrder(huy, view);
  assert.match(lai, /^Đơn #6457: Đơn đã được gửi lại/, lai);
  assert.match(lai, /mã vận đơn mới 155281559687 \(Viettel Post, đã giao thành công\)/, lai);
  assert.ok(!/Đã hủy|bưu tá đã lấy hàng ngày/.test(lai), `không «Đã hủy», không mốc của vận đơn cũ: ${lai}`);
  // Đơn CHƯA PUT (POS còn mã GỐC, partner_status của mã gốc) + lần gửi kế đã giao ⇒ vẫn câu «gửi lại» với mã MỚI theo ERP: route mức
  // đơn làm bot nói đúng cho cả 326 đơn mà không cần ghi gì lên POS.
  const chuaPut = { ...huy, partner: { order_number_vtp: "PKE1552761607", extend_code: "PKE10948632210", partner_status: "canceled", picked_up_at: "2026-10-20T03:00:00" } };
  const cp = bot.describeOrder(chuaPut, view);
  assert.match(cp, /^Đơn #6457: Đơn đã được gửi lại/, cp);
  assert.match(cp, /mã vận đơn mới 155281559687 \(Viettel Post, đã giao thành công\)/, cp);
  assert.ok(!cp.includes("PKE1552761607") && !cp.includes("bưu tá đã lấy hàng ngày"), `không nhắc mã / mốc của vận đơn gốc: ${cp}`);
  // Lần gửi kế cũng đã huỷ ⇒ vẫn «Đã hủy».
  assert.match(bot.describeOrder(huy, { byCode: {}, byOrder: { "6457": { ...view.byOrder["6457"], stage: "CANCELLED" } } }), /^Đơn #6457: Đã hủy/);
  // Không phải lần gửi KẾ (một lần gửi, đã giao) ⇒ không bịa «gửi lại».
  assert.match(bot.describeOrder(huy, { byCode: {}, byOrder: { "6457": { ...view.byOrder["6457"], reship: false } } }), /^Đơn #6457: Đã hủy/);
  // Trạng thái tiêu cực của Pancake, ERP không có chứng từ ⇒ không nói thẳng, chỉ mã + tra cứu.
  const hoan = { id: 7001, status: 3, partner: { order_number_vtp: "PKE1999000001", partner_status: "returned" } };
  const h1 = bot.describeOrder(hoan);
  assert.ok(!h1.includes("đã hoàn về shop") && h1.includes("tra cứu Viettel Post"), h1);
  // Có chứng từ ERP ⇒ nói theo ERP.
  assert.match(bot.describeOrder(hoan, { byCode: { PKE1999000001: { code: "PKE1999000001", stage: "DELIVERED", final: true } }, byOrder: {} }), /PKE1999000001 \(Viettel Post, đã giao thành công\)/);
  // Trạng thái bình thường, không chứng từ ⇒ như hôm nay.
  assert.match(bot.describeOrder({ id: 7002, status: 3, partner: { order_number_vtp: "PKE1999000002", partner_status: "delivering" } }), /\(Viettel Post, đang giao\)/);

  // erpOrderView: một lượt hỏi; lỗi ⇒ rỗng (câu cũ) và KHÔNG đệm lỗi; thành công ⇒ đệm; không khoá ⇒ không gọi.
  let calls = 0;
  let lastUrl = "";
  let lastToken = "";
  const okFetch = async (u: string, i: { headers: Record<string, string> }) => {
    calls += 1;
    lastUrl = u;
    lastToken = i.headers["x-chatbot-token"];
    return { ok: true, status: 200, json: async () => ({ states: [], orders: [view.byOrder["6457"]] }) };
  };
  const t0 = 1_000_000;
  const v1 = await bot.erpOrderView([huy], { fetchImpl: okFetch, now: () => t0, baseUrl: "http://erp.test", token: "k" });
  assert.equal(calls, 1);
  assert.ok(lastUrl.startsWith("http://erp.test/api/internal/shipment-state?codes=155281559687&orders=6457") && lastToken === "k", lastUrl);
  assert.equal((v1.byOrder["6457"] as { reship: boolean }).reship, true);
  await bot.erpOrderView([huy], { fetchImpl: okFetch, now: () => t0 + 30_000, baseUrl: "http://erp.test", token: "k" });
  assert.equal(calls, 1, "trong 90 giây ⇒ dùng đệm");
  let failCalls = 0;
  const failFetch = async () => {
    failCalls += 1;
    throw new Error("ECONNREFUSED");
  };
  const other = { ...huy, id: 6458, partner: { order_number_vtp: "155281559688" } };
  const v2 = await bot.erpOrderView([other], { fetchImpl: failFetch, now: () => t0, baseUrl: "http://erp.test", token: "k" });
  assert.deepEqual(v2, { byCode: {}, byOrder: {} }, "route lỗi ⇒ rỗng");
  await bot.erpOrderView([other], { fetchImpl: failFetch, now: () => t0 + 1, baseUrl: "http://erp.test", token: "k" });
  assert.equal(failCalls, 2, "lỗi KHÔNG được đệm");
  assert.match(bot.describeOrder(other, v2), /^Đơn #6458: Đã hủy/, "route lỗi ⇒ câu cũ");
  const deny = await bot.erpOrderView([other], { fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }), now: () => t0 + 2, baseUrl: "http://erp.test", token: "k" });
  assert.deepEqual(deny, { byCode: {}, byOrder: {} }, "401 ⇒ rỗng");
  let noTokenCalls = 0;
  await bot.erpOrderView([other], { fetchImpl: async () => ((noTokenCalls += 1), { ok: true }), baseUrl: "http://erp.test", token: "" });
  assert.equal(noTokenCalls, 0, "không khoá ⇒ không gọi");
}

export async function testShipmentStateApi(db: Db) {
  testParse();
  testSource();
  await testDbAndRoute(db);
  await testBot();
  console.log("  ✓ cửa nội bộ bot → ERP: khoá header (rỗng ⇒ 401) · ≤ 20 mã · chỉ chứng từ VTP · lần gửi chính · không tiền / người nhận · bot: huỷ thật vẫn «Đã hủy» · huỷ + gửi lại đã giao ⇒ «đã được gửi lại» · tiêu cực Pancake không nói thẳng · route lỗi ⇒ câu cũ");
}

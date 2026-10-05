/**
 * ═══════════ POS TỰ CHỦ — GIAO HÀNG NHANH (GHN) CỦA TỔ CHỨC (docs/verticals/pos-tu-chu.md · ORDER_OUTCOME.md mục 4.1) ═══════════
 *
 *  1. THUẦN — so khớp tên tỉnh / xã theo danh mục GHN (bỏ dấu, bỏ tiền tố, `extension_names`), mơ hồ ⇒ KHÔNG đoán; thân yêu
 *     cầu đúng tài liệu (client_order_code, cước shop trả, địa giới mới, không mua bảo hiểm, dịch vụ theo cân); đọc đúng MẪU
 *     PHẢN HỒI in trong tài liệu (Preview, Create); bảng mã trạng thái + danh sách mã cuối.
 *  2. KIỂM TRA KẾT NỐI — GET danh sách shop, đòi ShopId đã khai; token không lộ; không theo chuyển hướng.
 *  3. LUỒNG THẬT TRÊN CSDL TỔ CHỨC — tính cước trả địa chỉ GHN hiểu; xã không khớp ⇒ từ chối, KHÔNG gọi lệnh tạo; tạo ghi vận
 *     đơn GHN (mã ở `tracking_code`, không ở `vtp_order_number`); đứt mạng ⇒ giữ chỗ, «Thử lại» gửi CÙNG mã ⇒ đúng một vận
 *     đơn; huỷ; in; webhook (token theo tổ chức) đưa đơn tới GIAO THÀNH CÔNG trong `ORDER_OUTCOME`, gói lặp không đẻ sự kiện,
 *     `exception` không kết luận, đơn GHN tạo ngoài ERP chỉ được lưu.
 *
 * Không gọi mạng (luật 65): mọi lượt tới GHN đi qua máy chủ giả.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { cancelShipmentCore, carrierPanel, carrierWardOptionsCore, createShipmentCore, printLinkCore, quoteShipmentCore, retryCreateCore } from "@/lib/carriers/engine";
import { findConnector } from "@/lib/connectors/registry";
import { saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import { testGhnCarrier } from "@/lib/connectors/testers";
import { coreName, foldName, GHN_API, ghnCreatedOf, ghnOrderBody, ghnQuoteOf, matchPlace, parsePlaces } from "@/lib/constants/carrier-ghn";
import { carrierStatusMeta, finalStatuses } from "@/lib/constants/carrier-status";
import { carrierCreateOf } from "@/lib/constants/carrier-vtp";
import { acceptGhnWebhook, applyAcceptedGhnWebhook } from "@/lib/integrations/ghn/webhook";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { webhookUrlToken } from "@/lib/platform/webhooks";
import { createManualOrderCore } from "@/lib/records/order-create";
import { ORDER_OUTCOME } from "@/lib/queries/return-rate";
import { POST as ghnOrgPost } from "@/app/api/webhooks/ghn-org/[token]/route";

const ORG = "ghn-tao-don";
const ORG_SECRETS_KEY = "khoa-kiem-thu-ghn-tao-don-0123456789abcdefghijklmnopqrstuvwxyzAB";
const GHN_TOKEN = "5c1d8a9e-2f4b-11ed-a1b2-c3d4e5f60718";
const SHOP_ID = "92837";

async function cleanupOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

// Mẫu chép từ tài liệu developer.ghn.vn (04/10/2026) — Get Province (New) / Get Ward (New) / Preview / Create.
const PROVINCES = [
  { _id: 1000001, name: "Hồ Chí Minh", extension_names: ["hồ chí minh", "tp.hồ chí minh", "thành phố hồ chí minh", "hcm", "ho chi minh"], type: "province", parent_id: 1, status: 1 },
  { _id: 1000002, name: "Hà Nội", extension_names: ["hà nội", "tp.hà nội", "thành phố hà nội", "hn", "ha noi"], type: "province", parent_id: 1, status: 1 },
];
const WARDS_HCM = [
  { _id: 1003646, name: "Phường Vũng Tàu", extension_names: ["phường vũng tàu", "p.vũng tàu", "vũng tàu"], type: "ward", parent_id: 1000001, status: 1 },
  { _id: 1003001, name: "Phường Sài Gòn", extension_names: ["phường sài gòn", "p.sài gòn", "sài gòn"], type: "ward", parent_id: 1000001, status: 1 },
  { _id: 1003002, name: "Phường Bến Thành", extension_names: ["phường bến thành", "p.bến thành", "bến thành"], type: "ward", parent_id: 1000001, status: 1 },
  { _id: 1003999, name: "Phường Đã Gỡ", extension_names: [], type: "ward", parent_id: 1000001, status: 10 },
];
const PREVIEW_DATA = { order_code: "", fee: { main_service: 20900 }, total_fee: 20900, expected_delivery_time: "2026-07-16T16:59:59Z" };

function testPure() {
  assert.equal(foldName("Thành phố Hồ Chí Minh"), "thanh pho ho chi minh");
  assert.equal(coreName("TP. Hồ Chí Minh"), "ho chi minh");
  assert.equal(coreName("P. Sài Gòn"), "sai gon");
  assert.equal(coreName("Đặc khu Phú Quốc"), "phu quoc");
  const provinces = parsePlaces(PROVINCES);
  const wards = parsePlaces(WARDS_HCM);
  assert.equal(wards.length, 3, "mục đã gỡ (status ≠ 1) không vào danh mục");
  assert.equal(matchPlace(provinces, "TP. Hồ Chí Minh")?.name, "Hồ Chí Minh");
  assert.equal(matchPlace(provinces, "tp hcm".replace("tp ", "")) ?.name, "Hồ Chí Minh", "biến thể viết tắt trong extension_names");
  assert.equal(matchPlace(provinces, "", "72 Lê Thánh Tôn, Phường Sài Gòn, TP. Hồ Chí Minh")?.name, "Hồ Chí Minh", "đọc tỉnh từ phần cuối địa chỉ");
  assert.equal(matchPlace(wards, "", "72 Lê Thánh Tôn, P. Sài Gòn, TP. Hồ Chí Minh")?.name, "Phường Sài Gòn", "đọc xã từ một phần của địa chỉ");
  assert.equal(matchPlace(wards, "Phường 10"), null, "tên phường cũ không có trong danh mục mới ⇒ KHÔNG đoán");
  assert.equal(matchPlace([...wards, { id: 9, name: "Xã Sài Gòn", aliases: [] }], "Sài Gòn"), null, "hai mục khớp ⇒ mơ hồ ⇒ người chọn");

  const draft = {
    reference: "ERPABCDEF12-1",
    receiver: { name: "Tran Minh Anh", phone: "+84987654321", address: "72 Lê Thánh Tôn", province: "", ward: "" },
    lines: [{ name: "Áo thun", quantity: 2, unitPrice: 142_500, weightGrams: 300 }],
    goodsValue: 285_000,
    weightGrams: 600,
    cod: 285_000,
    serviceCode: "2",
    note: "",
  };
  const body = ghnOrderBody(draft, { province: "Hồ Chí Minh", ward: "Phường Sài Gòn" }, { requiredNote: "CHOXEMHANGKHONGTHU", defaultNote: "Gọi trước khi giao" });
  assert.equal(body.client_order_code, "ERPABCDEF12-1", "mã ERP của lần gửi ⇒ GHN chống trùng");
  assert.equal(body.payment_type_id, 1, "cước do shop trả — không cộng cước vào thu hộ lần hai");
  assert.equal(body.is_new_to_address, true, "địa giới mới: tỉnh + xã");
  assert.equal(body.to_ward_name, "Phường Sài Gòn");
  assert.equal(body.to_province_name, "Hồ Chí Minh");
  assert.ok(!("to_district_name" in body), "địa giới mới không có cấp huyện");
  assert.equal(body.to_phone, "0987654321");
  assert.equal(body.insurance_value, 0, "không tự mua bảo hiểm");
  assert.equal(body.service_type_id, 2);
  assert.equal(body.note, "Gọi trước khi giao", "ghi chú trống ⇒ mặc định của tổ chức");
  assert.equal(ghnOrderBody({ ...draft, weightGrams: 25_000, serviceCode: "5" }, { province: "Hồ Chí Minh", ward: "Phường Sài Gòn" }, { requiredNote: "KHONGCHOXEMHANG", defaultNote: "" }).service_type_id, 5, "từ 20 kg ⇒ hàng nặng");
  const quote = ghnQuoteOf(PREVIEW_DATA, draft, { province: "Hồ Chí Minh", ward: "Phường Sài Gòn" });
  assert.deepEqual(quote.services.map((s) => [s.code, s.fee]), [["2", 20_900]]);
  assert.equal(quote.receiverAddressAsRead, "Phường Sài Gòn, Hồ Chí Minh");
  assert.deepEqual(ghnCreatedOf({ order_code: "LADFYR", total_fee: 20_900 }), { trackingCode: "LADFYR", fee: 20_900 });
  assert.equal(ghnCreatedOf({ order_code: "" }), null);

  // Bảng mã: đúng tài liệu (cột Final), mã lạ ⇒ null.
  assert.equal(carrierStatusMeta("GHN_WEBHOOK", "delivered")?.final, true);
  assert.equal(carrierStatusMeta("GHN_WEBHOOK", "picked")?.stage, "PICKED_UP");
  assert.equal(carrierStatusMeta("GHN_WEBHOOK", "returning")?.leg, "RETURN");
  assert.equal(carrierStatusMeta("GHN_WEBHOOK", "exception")?.final, false, "exception: cần người xử lý — ERP không kết luận");
  assert.equal(carrierStatusMeta("GHN_WEBHOOK", "khong-co"), null);
  assert.equal(carrierStatusMeta("GHN_WEBHOOK", "5"), null, "mã GHTK không đọc bằng bảng GHN");
  assert.deepEqual(finalStatuses("GHN_WEBHOOK", "DELIVERED"), ["delivered"]);
  assert.deepEqual(finalStatuses("GHN_WEBHOOK", "DESTROYED").sort(), ["damage", "lost", "scrap"]);
  assert.deepEqual(finalStatuses("GHTK_WEBHOOK", "DELIVERED").sort(), ["5", "6"]);
  assert.deepEqual(finalStatuses("GHTK_WEBHOOK", "CANCELLED"), ["-1"]);

  const spec = findConnector("ghn-carrier");
  assert.ok(spec && spec.tenancy === "PER_ORG" && spec.module === "logistics" && spec.webhook?.binding === "GHN_ORG");
  assert.ok(spec.settings.find((f) => f.key === "token")?.secret, "token là ô bí mật");
}

type Mode = { create: "ok" | "network"; orderCode: string };

/** Máy chủ GHN giả: đúng đường dẫn tài liệu, kiểm tiêu đề Token / ShopId, đếm từng lượt. */
function fakeGhn(mode: Mode) {
  const calls: { path: string; method: string; body: Record<string, unknown> | null; headers: Record<string, string>; redirect: RequestRedirect | undefined }[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (url: string, init: RequestInit) => {
    assert.ok(url.startsWith(`${GHN_API}/`), `chỉ gọi địa chỉ hằng số: ${url}`);
    const u = new URL(url);
    const path = u.pathname.replace("/shiip/public-api/", "");
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ path, method: init.method ?? "GET", body, headers, redirect: init.redirect });
    if (headers.Token !== GHN_TOKEN) return json({ code: 401, message: "Token is not valid", data: null }, 401);
    if (path === "v2/shop/all") return json({ code: 200, message: "Success", data: { last_offset: 0, shops: [{ _id: Number(SHOP_ID), name: "Shop Thử GHN", address: "39 Nguyễn Thị Thập", status: 1 }] } });
    assert.equal(headers.ShopId, SHOP_ID, "API nghiệp vụ mang ShopId của tổ chức");
    if (path === "v3/master-data/province/all") return json({ code: 200, message: "Success", data: PROVINCES });
    if (path === "v3/master-data/ward/all-by-province-id") return json({ code: 200, message: "Success", data: u.searchParams.get("province_id") === "1000001" ? WARDS_HCM : [] });
    if (path === "v2/shipping-order/preview") return json({ code: 200, message: "Success", data: PREVIEW_DATA });
    if (path === "v2/shipping-order/create") {
      if (mode.create === "network") throw new TypeError("fetch failed: socket hang up");
      return json({ code: 200, message: "Success", message_display: `Tạo đơn hàng thành công. Mã đơn hàng: ${mode.orderCode}`, data: { order_code: mode.orderCode, fee: { main_service: 20_900 }, total_fee: 20_900, expected_delivery_time: "2026-07-15T16:59:59Z" } });
    }
    if (path === "v2/switch-status/cancel") return json({ code: 200, message: "Success", data: (body?.order_codes as string[]).map((c) => ({ order_code: c, result: true, message: "OK" })) });
    if (path === "v2/a5/gen-token") return json({ code: 200, message: "Success", data: { token: "1b744cae-8005-11f1-b50f-ba37616041ec" } });
    return json({ code: 404, message: "không có" }, 404);
  };
  return { fetch: fetchImpl, calls, count: (p: string) => calls.filter((c) => c.path === p).length };
}

async function testTester() {
  const ok = fakeGhn({ create: "ok", orderCode: "X" });
  const r = await testGhnCarrier({ secrets: { token: GHN_TOKEN }, settings: { shopId: SHOP_ID } }, { fetch: ok.fetch });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(ok.calls.map((c) => c.path), ["v2/shop/all"], "chỉ đọc danh sách shop — không tạo gì");
  assert.ok(ok.calls.every((c) => c.redirect === "manual"));
  assert.ok(r.message.includes("Shop Thử GHN") && !r.message.includes(GHN_TOKEN));
  const wrongShop = await testGhnCarrier({ secrets: { token: GHN_TOKEN }, settings: { shopId: "11111" } }, { fetch: fakeGhn({ create: "ok", orderCode: "X" }).fetch });
  assert.ok(!wrongShop.ok && wrongShop.message.includes("không có shop 11111"), wrongShop.message);
  const badToken = await testGhnCarrier({ secrets: { token: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }, settings: { shopId: SHOP_ID } }, { fetch: fakeGhn({ create: "ok", orderCode: "X" }).fetch });
  assert.ok(!badToken.ok && !badToken.message.includes("aaaaaaaa-bbbb"), badToken.message);
  const none = fakeGhn({ create: "ok", orderCode: "X" });
  assert.equal((await testGhnCarrier({ secrets: { token: "ngan" }, settings: { shopId: SHOP_ID } }, { fetch: none.fetch })).ok, false);
  assert.equal(none.calls.length, 0, "token sai dạng ⇒ không gọi");
}

const outcomeOf = async (db: Awaited<ReturnType<typeof getDb>>, orderId: string) =>
  (await db.select({ v: ORDER_OUTCOME }).from(schema.orders).leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id)).where(eq(schema.orders.id, orderId)))[0]?.v;

async function testFlow() {
  await cleanupOrg(ORG);
  const savedKey = process.env.PLATFORM_SECRETS_KEY;
  process.env.PLATFORM_SECRETS_KEY = ORG_SECRETS_KEY;
  try {
    await provisionOrganization({ code: ORG, name: "Shop tạo vận đơn GHN", plan: "standard", modules: ["customers", "products", "orders", "logistics"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "VanDonGhn@123" }, source: "TEST", actor: null });
    const enabled = await getEnabledModules(ORG);

    // Route: token sai ⇒ 401 TRƯỚC khi đọc body.
    const post = (token: string, body: unknown) => ghnOrgPost(new Request(`http://erp.test/api/webhooks/ghn-org/${token}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }) as never, { params: Promise.resolve({ token }) });
    assert.equal((await post(`${ORG}.sai-chu-ky`, { OrderCode: "X" })).status, 401);
    assert.ok(webhookUrlToken("GHN_ORG", ORG));

    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const admin = { id: u.id, email: u.email, name: "QT", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: "Shop tạo vận đơn GHN", isHome: false }, modules: [...enabled] } as unknown as SessionUser;

      const [c] = await db.insert(schema.customers).values({ name: "Tran Minh Anh", phone: "0987654321", address: "72 Lê Thánh Tôn, P. Sài Gòn", province: "TP. Hồ Chí Minh" }).returning({ id: schema.customers.id });
      await db.insert(schema.products).values({ id: "erp-ghn-prod", name: "Áo thun", raw: { origin: "ERP_MANUAL" } });
      await db.insert(schema.productVariants).values({ id: "erp-ghn-var", productId: "erp-ghn-prod", sku: "AT-M", size: "M", retailPrice: 142_500, weight: 300 });
      const mk = async () => {
        const r = await createManualOrderCore(admin, { customerId: c.id, stage: "CONFIRMED", channel: "Fanpage", note: "", orderDiscount: 0, shippingFee: 0, lines: [{ variantId: "erp-ghn-var", quantity: 2, unitPrice: 142_500, discount: 0 }] });
        assert.ok(r.ok, JSON.stringify(r));
        return r.id;
      };
      const orderId = await mk();

      const ghn = fakeGhn({ create: "ok", orderCode: "LADFYR" });
      const deps = { fetch: ghn.fetch };
      assert.ok("ok" in (await saveConnection(admin, { connectorKey: "ghn-carrier", settings: { shopId: SHOP_ID }, secrets: { token: GHN_TOKEN } })));
      assert.ok("ok" in (await testOrgConnection(admin, "ghn-carrier", { tester: { fetch: ghn.fetch } })));
      assert.ok("ok" in (await setConnectionStatus(admin, "ghn-carrier", "ACTIVE")));
      const panel = await carrierPanel(admin, orderId);
      assert.ok(panel?.carriers.find((x) => x.key === "GHN")?.ready && panel.carriers.find((x) => x.key === "GHN")?.needsStructuredAddress, JSON.stringify(panel));
      // Lõi ghi đơn đã ghép địa chỉ vào danh mục địa giới mới (05/10/2026): tên chuẩn + xã đọc từ «P. Sài Gòn».
      assert.deepEqual([panel.defaults.province, panel.defaults.ward], ["Thành phố Hồ Chí Minh", "Phường Sài Gòn"]);

      // Gợi ý xã theo danh mục GHN.
      const wo = await carrierWardOptionsCore(admin, "GHN", "tp hồ chí minh", deps);
      assert.ok(wo.ok && wo.province === "Hồ Chí Minh" && wo.wards.includes("Phường Sài Gòn") && !wo.wards.includes("Phường Đã Gỡ"), JSON.stringify(wo));

      // Xã không đọc ra ⇒ từ chối có lời dẫn, KHÔNG gọi preview.
      const vague = await quoteShipmentCore(admin, "GHN", orderId, { weightGrams: 600, cod: 285_000, ward: "Phường 10" }, deps);
      assert.ok(!vague.ok && vague.error.includes("xã / phường"), JSON.stringify(vague));
      assert.equal(ghn.count("v2/shipping-order/preview"), 0);
      // Đọc được từ địa chỉ đơn ⇒ tính cước.
      const q = await quoteShipmentCore(admin, "GHN", orderId, { weightGrams: 600, cod: 285_000 }, deps);
      assert.ok(q.ok && q.quote.receiverAddressAsRead === "Phường Sài Gòn, Hồ Chí Minh" && q.quote.services[0].code === "2", JSON.stringify(q));

      // ── Tạo ⇒ vận đơn GHN: mã ở tracking_code, KHÔNG ở vtp_order_number (cột của Viettel Post) ──
      const c1 = await createShipmentCore(admin, "GHN", orderId, { weightGrams: 600, cod: 285_000, serviceCode: "2", note: "" }, deps);
      assert.ok(c1.ok && c1.trackingCode === "LADFYR", JSON.stringify(c1));
      const sent = ghn.calls.filter((x) => x.path === "v2/shipping-order/create").at(-1)?.body;
      assert.ok(sent && String(sent.client_order_code).endsWith("-1") && sent.to_ward_name === "Phường Sài Gòn" && sent.is_new_to_address === true && sent.cod_amount === 285_000);
      const [s1] = await db.select().from(schema.shipments).where(eq(schema.shipments.orderId, orderId));
      assert.ok(s1.carrier === "GHN" && s1.trackingCode === "LADFYR" && s1.vtpOrderNumber === null && s1.stage === "PENDING" && s1.shippingFee === 20_900, JSON.stringify(s1));
      assert.equal(carrierCreateOf(s1.raw)?.carrier, "GHN");

      // ── Webhook: create → picked → delivered ⇒ GIAO THÀNH CÔNG; gói lặp không đẻ sự kiện ──
      const T0 = Date.now() - 3 * 3_600_000;
      const pkt = (Status: string, ms: number, OrderCode = "LADFYR", Type = "switch_status") => ({ ShopID: Number(SHOP_ID), Time: new Date(ms).toISOString(), OrderCode, ClientOrderCode: String(sent.client_order_code), Type, Status, Reason: "", ReasonCode: "", CODAmount: 285_000, CODTransferDate: null });
      const deliver = async (body: Record<string, unknown>) => applyAcceptedGhnWebhook(await acceptGhnWebhook(body, { userAgent: "ghn", contentType: "application/json" }), body);
      await deliver(pkt("ready_to_pick", T0, "LADFYR", "create"));
      assert.equal(await outcomeOf(db, orderId), "AWAITING_PICKUP", "GHN đã biết đơn, chưa lấy hàng ⇒ CHỜ LẤY, không phải đang giao");
      await deliver(pkt("picked", T0 + 3_600_000));
      assert.equal(await outcomeOf(db, orderId), "IN_TRANSIT");
      await deliver(pkt("exception", T0 + 5_000_000));
      const [sx] = await db.select().from(schema.shipments).where(eq(schema.shipments.id, s1.id));
      assert.equal(sx.stage, "PICKED_UP", "exception không dựng chặng");
      await deliver(pkt("delivered", T0 + 7_200_000));
      await deliver(pkt("delivered", T0 + 7_200_000));
      const [s1b] = await db.select().from(schema.shipments).where(eq(schema.shipments.id, s1.id));
      assert.ok(s1b.stage === "DELIVERED" && s1b.isFinal === true && s1b.vtpStatus === null, JSON.stringify({ stage: s1b.stage, final: s1b.isFinal, vtp: s1b.vtpStatus }));
      assert.equal(await outcomeOf(db, orderId), "DELIVERED", "mã cuối GHN là chứng từ (ORDER_OUTCOME mục 4.1)");
      const evs = await db.select().from(schema.shipmentEvents).where(and(eq(schema.shipmentEvents.shipmentId, s1.id), eq(schema.shipmentEvents.source, "GHN_WEBHOOK")));
      assert.equal(evs.length, 4, "gói lặp không đẻ sự kiện thứ hai");
      // Đơn GHN tạo NGOÀI ERP: chỉ lưu gói, không dựng vận đơn mồ côi.
      const before = (await db.select().from(schema.shipments)).length;
      await deliver(pkt("picked", T0, "NGOAIERP", "switch_status"));
      assert.equal((await db.select().from(schema.shipments)).length, before);
      assert.equal((await printLinkCore(admin, s1.id, deps)).ok, true, "đã giao vẫn in lại được nhãn");

      // ── Đứt mạng lúc tạo ⇒ giữ chỗ; «Thử lại» gửi CÙNG mã ⇒ đúng một vận đơn ──
      const order2 = await mk();
      const net = fakeGhn({ create: "network", orderCode: "LADXYZ" });
      const nw = await createShipmentCore(admin, "GHN", order2, { weightGrams: 600, cod: 285_000, serviceCode: "2", note: "" }, { fetch: net.fetch });
      assert.ok(!nw.ok && nw.error.includes("Thử lại"), JSON.stringify(nw));
      const [held] = await db.select().from(schema.shipments).where(eq(schema.shipments.orderId, order2));
      const firstCode = net.calls.find((x) => x.path === "v2/shipping-order/create")?.body?.client_order_code;
      const panel2 = await carrierPanel(admin, order2);
      assert.ok(panel2?.attempts.find((a) => a.id === held.id)?.canRetry, "GHN chống trùng bằng mã ⇒ thử lại được");
      const again = fakeGhn({ create: "ok", orderCode: "LADXYZ" });
      const rt = await retryCreateCore(admin, held.id, { fetch: again.fetch });
      assert.ok(rt.ok && rt.trackingCode === "LADXYZ", JSON.stringify(rt));
      assert.equal(again.calls.find((x) => x.path === "v2/shipping-order/create")?.body?.client_order_code, firstCode, "thử lại gửi CÙNG mã ERP");
      assert.equal((await db.select().from(schema.shipments).where(eq(schema.shipments.orderId, order2))).length, 1);

      // ── Huỷ khi GHN chưa lấy hàng ⇒ lời nhận lệnh; không tự đặt «Đã huỷ» ──
      const cx = await cancelShipmentCore(admin, held.id, { reason: "Khách đổi ý" }, { fetch: again.fetch });
      assert.ok(cx.ok, JSON.stringify(cx));
      assert.deepEqual(again.calls.find((x) => x.path === "v2/switch-status/cancel")?.body?.order_codes, ["LADXYZ"]);
      const [h2] = await db.select().from(schema.shipments).where(eq(schema.shipments.id, held.id));
      assert.equal(h2.stage, "PENDING", "chặng chỉ đổi theo webhook cancel");
      assert.equal((await cancelShipmentCore(admin, s1.id, { reason: "Thử huỷ đơn đã giao" }, deps)).ok, false, "đã giao ⇒ không huỷ");
    });
  } finally {
    if (savedKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = savedKey;
    await cleanupOrg(ORG);
  }
}

export async function testCarrierGhn() {
  testPure();
  await testTester();
  await testFlow();
  console.log("  ✓ POS tự chủ · GHN: so khớp tỉnh / xã theo danh mục GHN (mơ hồ ⇒ không đoán), thân yêu cầu đúng tài liệu (client_order_code, cước shop trả, địa giới mới, không bảo hiểm); kiểm tra đòi đúng ShopId, không lộ token; tạo ghi mã GHN ở tracking_code; webhook đưa đơn CHỜ LẤY → ĐANG GIAO → GIAO THÀNH CÔNG trong ORDER_OUTCOME, gói lặp không đẻ sự kiện, exception không kết luận, đơn ngoài ERP chỉ lưu; đứt mạng ⇒ «Thử lại» cùng mã ra đúng một vận đơn; huỷ chờ webhook");
}

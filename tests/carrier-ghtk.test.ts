/**
 * ═══════════ POS TỰ CHỦ — GIAO HÀNG TIẾT KIỆM (GHTK) CỦA TỔ CHỨC (docs/verticals/pos-tu-chu.md · ORDER_OUTCOME.md mục 4.1) ═══════════
 *
 *  1. THUẦN — thân Đăng đơn đúng tài liệu ver 1.5 (order.id = mã ERP, địa giới mới tỉnh + xã KHÔNG huyện, hamlet «Khác», cân
 *     tính bằng gam, cước shop trả); đọc đúng MẪU PHẢN HỒI in trong tài liệu (Tính phí, Đăng đơn, ORDER_ID_EXIST); bảng mã.
 *  2. KIỂM TRA KẾT NỐI — GET danh sách kho; token không lộ; không theo chuyển hướng; token sai dạng ⇒ không gọi.
 *  3. LUỒNG THẬT TRÊN CSDL TỔ CHỨC — thiếu xã ⇒ từ chối, KHÔNG gọi hãng; tính cước bỏ cách chở hãng nói không phục vụ; tạo ghi
 *     mã GHTK ở `tracking_code`; webhook form-urlencoded đưa đơn tới GIAO THÀNH CÔNG trong `ORDER_OUTCOME`, gói lặp không đẻ
 *     sự kiện, mã «shipper báo» không kết luận, đơn ngoài ERP chỉ lưu; nhãn PDF chỉ chuyển tiếp cho mã ERP tạo; đứt mạng ⇒
 *     «Thử lại» cùng mã nhận ORDER_ID_EXIST ⇒ đúng một vận đơn; huỷ theo mã GHTK, chờ webhook.
 *
 * Không gọi mạng (luật 65): mọi lượt tới GHTK đi qua máy chủ giả.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { cancelShipmentCore, carrierPanel, createShipmentCore, labelPdfCore, printLinkCore, quoteShipmentCore, retryCreateCore } from "@/lib/carriers/engine";
import { findConnector } from "@/lib/connectors/registry";
import { saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import { testGhtkCarrier } from "@/lib/connectors/testers";
import { GHTK_API, ghtkCreatedOf, ghtkOrderBody, ghtkServiceOf, type GhtkSender } from "@/lib/constants/carrier-ghtk";
import { carrierStatusMeta, finalStatuses } from "@/lib/constants/carrier-status";
import { carrierCreateOf } from "@/lib/constants/carrier-vtp";
import { acceptGhtkWebhook, applyAcceptedGhtkWebhook, readGhtkBody } from "@/lib/integrations/ghtk/webhook";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { webhookUrlToken } from "@/lib/platform/webhooks";
import { createManualOrderCore } from "@/lib/records/order-create";
import { ORDER_OUTCOME } from "@/lib/queries/return-rate";
import { POST as ghtkOrgPost } from "@/app/api/webhooks/ghtk-org/[token]/route";

const ORG = "ghtk-tao-don";
const ORG_SECRETS_KEY = "khoa-kiem-thu-ghtk-tao-don-0123456789abcdefghijklmnopqrstuvwxyzAB";
const GHTK_TOKEN = "APITokenSample-ca441e70288cB0515F310742";
const CLIENT_SOURCE = "S1234567";
const PICK = { clientSource: CLIENT_SOURCE, pickName: "Kho Thử", pickTel: "0911222333", pickAddress: "590 CMT8", pickProvince: "Hồ Chí Minh", pickWard: "Phường Nhiêu Lộc" };
const SENDER: GhtkSender = { name: PICK.pickName, phone: PICK.pickTel, address: PICK.pickAddress, province: PICK.pickProvince, ward: PICK.pickWard };
const PDF = new TextEncoder().encode("%PDF-1.4\n% nhãn thử\n%%EOF");

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

// Mẫu chép từ tài liệu api.ghtk.vn (04/10/2026) — Tính phí / Đăng đơn.
const FEE_ROAD = { success: true, fee: { name: "area1", fee: 30_400, insurance_fee: 15_000, delivery: true, extFees: [{ title: "Phụ phí hàng dễ vỡ", amount: 7_400, type: "fragile" }] } };
const FEE_FLY_NO = { success: true, fee: { name: "area1", fee: 0, insurance_fee: 0, delivery: false } };

function testPure() {
  const draft = {
    reference: "ERPABCDEF12-1",
    receiver: { name: "Tran Minh Anh", phone: "+84987654321", address: "72 Lê Thánh Tôn", province: "Hồ Chí Minh", ward: "Phường Sài Gòn" },
    lines: [{ name: "Áo thun", quantity: 2, unitPrice: 142_500, weightGrams: 300 }],
    goodsValue: 285_000,
    weightGrams: 600,
    cod: 285_000,
    serviceCode: "ROAD",
    note: "",
  };
  const body = ghtkOrderBody(draft, SENDER, "Gọi trước khi giao");
  const order = body.order as Record<string, unknown>;
  assert.equal(order.id, "ERPABCDEF12-1", "mã ERP của lần gửi ⇒ GHTK chặn trùng");
  assert.equal(order.province, "Hồ Chí Minh");
  assert.equal(order.ward, "Phường Sài Gòn");
  assert.ok(!("district" in order) && !("pick_district" in order), "địa giới mới: không cấp huyện (tài liệu: district không bắt buộc)");
  assert.equal(order.hamlet, "Khác", "không tách tên đường ⇒ hamlet «Khác» (tài liệu: street HOẶC hamlet)");
  assert.equal(order.tel, "0987654321");
  assert.equal(order.is_freeship, 1, "cước do shop trả — không cộng cước vào thu hộ lần hai");
  assert.equal(order.pick_money, 285_000);
  assert.equal(order.weight_option, "gram");
  assert.equal(order.total_weight, 600, "cân tính bằng gam — đúng số người nhập");
  assert.equal(order.note, "Gọi trước khi giao", "ghi chú trống ⇒ mặc định của tổ chức");
  assert.equal(order.transport, "road");
  assert.deepEqual((body.products as { weight: number; quantity: number }[]).map((p) => [p.quantity, p.weight]), [[2, 300]]);
  assert.equal((ghtkOrderBody({ ...draft, serviceCode: "FLY" }, SENDER, "").order as Record<string, unknown>).transport, "fly");
  assert.ok(String((ghtkOrderBody({ ...draft, note: "x".repeat(300) }, SENDER, "").order as Record<string, unknown>).note).length <= 120, "ghi chú ≤ 120 ký tự (tài liệu)");

  const road = ghtkServiceOf(FEE_ROAD, "road");
  assert.ok(road && road.fee === 45_400 && road.code === "ROAD" && road.extras.length === 1, JSON.stringify(road));
  assert.equal(ghtkServiceOf(FEE_FLY_NO, "fly"), null, "GHTK nói tuyến không phục vụ ⇒ không hiện dịch vụ");
  assert.deepEqual(ghtkCreatedOf({ success: true, order: { partner_id: "ERPABCDEF12-1", label: "S1.A1.2001297581", fee: "30400", insurance_fee: "15000" } }), { trackingCode: "S1.A1.2001297581", fee: 45_400, existed: false });
  assert.deepEqual(ghtkCreatedOf({ success: false, message: "Mã đơn hàng của bạn đã tồn tại", error: { code: "ORDER_ID_EXIST", partner_id: "a4", ghtk_label: "S1.A1.1737345" } }), { trackingCode: "S1.A1.1737345", fee: 0, existed: true }, "đơn của CHÍNH mã ERP này đã có ⇒ đó là đơn của lần gửi");
  assert.equal(ghtkCreatedOf({ success: false, error: { code: "ORDER_ID_EXIST" } }), null);
  assert.equal(ghtkCreatedOf({ success: true, order: {} }), null);

  // Bảng mã GHTK: số không đọc bằng bảng GHN / VTP; mã «shipper báo» chưa khai ⇒ null (lưu, không kết luận).
  assert.equal(carrierStatusMeta("GHTK_WEBHOOK", "5")?.stage, "DELIVERED");
  assert.equal(carrierStatusMeta("GHTK_WEBHOOK", "21")?.leg, "RETURN");
  assert.equal(carrierStatusMeta("GHTK_WEBHOOK", "45"), null);
  assert.equal(carrierStatusMeta("GHTK_WEBHOOK", "delivered"), null);
  assert.deepEqual(finalStatuses("GHTK_WEBHOOK", "DELIVERED").sort(), ["5", "6"]);

  // Thân webhook: form-urlencoded (tài liệu) và JSON.
  const form = readGhtkBody("label_id=S1.A1.17373471&partner_id=1234567&action_time=2016-11-02T12:18:39+07:00&status_id=5&reason_code=&reason=&weight=2.4&fee=1500&return_part_package=0", "application/x-www-form-urlencoded");
  assert.equal(form?.label_id, "S1.A1.17373471");
  assert.equal(form?.action_time, "2016-11-02T12:18:39+07:00", "dấu + trong mốc giờ không bị đổi thành khoảng trắng");
  assert.equal(readGhtkBody('{"label_id":"X","status_id":5}', "application/json")?.status_id, 5);
  assert.equal(readGhtkBody("", "application/x-www-form-urlencoded"), null);

  const spec = findConnector("ghtk-carrier");
  assert.ok(spec && spec.tenancy === "PER_ORG" && spec.module === "logistics" && spec.webhook?.binding === "GHTK_ORG");
  assert.ok(spec.settings.find((f) => f.key === "token")?.secret, "token là ô bí mật");
}

type Mode = { create: "ok" | "network" | "exists"; label: string };

/** Máy chủ GHTK giả: đúng đường dẫn tài liệu, kiểm tiêu đề Token / X-Client-Source, đếm từng lượt. */
function fakeGhtk(mode: Mode) {
  const calls: { path: string; method: string; query: URLSearchParams; body: Record<string, unknown> | null; headers: Record<string, string>; redirect: RequestRedirect | undefined }[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (url: string, init: RequestInit) => {
    assert.ok(url.startsWith(`${GHTK_API}/`), `chỉ gọi địa chỉ hằng số: ${url}`);
    const u = new URL(url);
    const path = u.pathname.replace(/^\//, "");
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ path, method: init.method ?? "GET", query: u.searchParams, body, headers, redirect: init.redirect });
    if (headers.Token !== GHTK_TOKEN) return json({ success: false, message: "Token không hợp lệ", error_code: "20101" }, 401);
    assert.equal(headers["X-Client-Source"], CLIENT_SOURCE, "mọi lượt mang mã shop của tổ chức");
    if (path === "services/shipment/list_pick_add") return json({ success: true, message: "", data: [{ pick_address_id: "88256", address: "590 CMT8, Phường Nhiêu Lộc, Hồ Chí Minh", pick_tel: "0911222333", pick_name: "Kho Thử" }] });
    if (path === "services/shipment/fee") return json(u.searchParams.get("transport") === "fly" ? FEE_FLY_NO : FEE_ROAD);
    if (path === "services/shipment/order/") {
      assert.equal(u.searchParams.get("ver"), "1.5");
      if (mode.create === "network") throw new TypeError("fetch failed: socket hang up");
      if (mode.create === "exists") return json({ success: false, message: "Mã đơn hàng của bạn đã tồn tại trên hệ thống GHTK", error: { code: "ORDER_ID_EXIST", partner_id: (body?.order as Record<string, unknown>)?.id, ghtk_label: mode.label, created: "2026-10-04T12:18:39+07:00", status: 2 } });
      return json({ success: true, message: "", order: { partner_id: (body?.order as Record<string, unknown>)?.id, label: mode.label, area: 1, fee: "30400", insurance_fee: "15000", estimated_pick_time: "Sáng 2026-10-05", estimated_deliver_time: "Chiều 2026-10-06", status_id: 2 } });
    }
    if (path.startsWith("services/shipment/cancel/")) return json({ success: true, message: "", log_id: "abc" });
    if (path.startsWith("services/label/")) return new Response(PDF, { status: 200, headers: { "content-type": "application/pdf" } });
    return json({ success: false, message: "không có" }, 404);
  };
  return { fetch: fetchImpl, calls, count: (p: string) => calls.filter((c) => c.path.startsWith(p)).length };
}

async function testTester() {
  const ok = fakeGhtk({ create: "ok", label: "X" });
  const r = await testGhtkCarrier({ secrets: { token: GHTK_TOKEN }, settings: PICK }, { fetch: ok.fetch });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(ok.calls.map((c) => c.path), ["services/shipment/list_pick_add"], "chỉ đọc danh sách kho — không tạo gì");
  assert.ok(ok.calls.every((c) => c.redirect === "manual"));
  assert.ok(r.message.includes("Kho Thử") && !r.message.includes(GHTK_TOKEN));
  const badToken = await testGhtkCarrier({ secrets: { token: "SaiTokenNhungDungDang-0000000000" }, settings: PICK }, { fetch: fakeGhtk({ create: "ok", label: "X" }).fetch });
  assert.ok(!badToken.ok && !badToken.message.includes("SaiTokenNhungDungDang"), badToken.message);
  const none = fakeGhtk({ create: "ok", label: "X" });
  assert.equal((await testGhtkCarrier({ secrets: { token: "ngan" }, settings: PICK }, { fetch: none.fetch })).ok, false);
  assert.equal((await testGhtkCarrier({ secrets: { token: GHTK_TOKEN }, settings: { ...PICK, clientSource: "" } }, { fetch: none.fetch })).ok, false);
  assert.equal(none.calls.length, 0, "token / mã shop sai dạng ⇒ không gọi");
}

const outcomeOf = async (db: Awaited<ReturnType<typeof getDb>>, orderId: string) =>
  (await db.select({ v: ORDER_OUTCOME }).from(schema.orders).leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id)).where(eq(schema.orders.id, orderId)))[0]?.v;

async function testFlow() {
  await cleanupOrg(ORG);
  const savedKey = process.env.PLATFORM_SECRETS_KEY;
  process.env.PLATFORM_SECRETS_KEY = ORG_SECRETS_KEY;
  try {
    await provisionOrganization({ code: ORG, name: "Shop tạo vận đơn GHTK", plan: "standard", modules: ["customers", "products", "orders", "logistics"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "VanDonGhtk@123" }, source: "TEST", actor: null });
    const enabled = await getEnabledModules(ORG);

    // Route: token sai ⇒ 401 TRƯỚC khi đọc body.
    const post = (token: string, body: string) => ghtkOrgPost(new Request(`http://erp.test/api/webhooks/ghtk-org/${token}`, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } }) as never, { params: Promise.resolve({ token }) });
    assert.equal((await post(`${ORG}.sai-chu-ky`, "label_id=X")).status, 401);
    assert.ok(webhookUrlToken("GHTK_ORG", ORG));

    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const admin = { id: u.id, email: u.email, name: "QT", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: "Shop tạo vận đơn GHTK", isHome: false }, modules: [...enabled] } as unknown as SessionUser;
      const viewer = { ...admin, role: "VIEWER", permissions: ["orders:read"] } as unknown as SessionUser;

      const [c] = await db.insert(schema.customers).values({ name: "Tran Minh Anh", phone: "0987654321", address: "72 Lê Thánh Tôn", province: "Hồ Chí Minh" }).returning({ id: schema.customers.id });
      await db.insert(schema.products).values({ id: "erp-ghtk-prod", name: "Áo thun", raw: { origin: "ERP_MANUAL" } });
      await db.insert(schema.productVariants).values({ id: "erp-ghtk-var", productId: "erp-ghtk-prod", sku: "AT-M", size: "M", retailPrice: 142_500, weight: 300 });
      const mk = async () => {
        const r = await createManualOrderCore(admin, { customerId: c.id, stage: "CONFIRMED", channel: "Fanpage", note: "", orderDiscount: 0, shippingFee: 0, lines: [{ variantId: "erp-ghtk-var", quantity: 2, unitPrice: 142_500, discount: 0 }] });
        assert.ok(r.ok, JSON.stringify(r));
        return r.id;
      };
      const orderId = await mk();

      const ghtk = fakeGhtk({ create: "ok", label: "S1.A1.2001297581" });
      const deps = { fetch: ghtk.fetch };
      assert.ok("ok" in (await saveConnection(admin, { connectorKey: "ghtk-carrier", settings: PICK, secrets: { token: GHTK_TOKEN } })));
      assert.ok("ok" in (await testOrgConnection(admin, "ghtk-carrier", { tester: { fetch: ghtk.fetch } })));
      assert.ok("ok" in (await setConnectionStatus(admin, "ghtk-carrier", "ACTIVE")));
      const panel = await carrierPanel(admin, orderId);
      const opt = panel?.carriers.find((x) => x.key === "GHTK");
      assert.ok(opt?.ready && opt.needsStructuredAddress, JSON.stringify(panel));

      // Thiếu xã ⇒ từ chối đúng ô, KHÔNG gọi tính phí.
      const noWard = await quoteShipmentCore(admin, "GHTK", orderId, { weightGrams: 600, cod: 285_000, province: "Hồ Chí Minh", ward: "" }, deps);
      assert.ok(!noWard.ok && noWard.error.includes("Xã / phường"), JSON.stringify(noWard));
      assert.equal(ghtk.count("services/shipment/fee"), 0);
      const place = { province: "Hồ Chí Minh", ward: "Phường Sài Gòn" };
      const q = await quoteShipmentCore(admin, "GHTK", orderId, { weightGrams: 600, cod: 285_000, ...place }, deps);
      assert.ok(q.ok && q.quote.services.length === 1 && q.quote.services[0].code === "ROAD" && q.quote.services[0].fee === 45_400, JSON.stringify(q));
      const feeCall = ghtk.calls.find((x) => x.path === "services/shipment/fee");
      assert.ok(feeCall && feeCall.query.get("weight") === "600" && feeCall.query.get("ward") === "Phường Sài Gòn" && !feeCall.query.has("district"), "tính phí: cân bằng gam, tỉnh + xã, không huyện");

      // ── Tạo ⇒ vận đơn GHTK: mã ở tracking_code, KHÔNG ở vtp_order_number ──
      const c1 = await createShipmentCore(admin, "GHTK", orderId, { weightGrams: 600, cod: 285_000, serviceCode: "ROAD", note: "", ...place }, deps);
      assert.ok(c1.ok && c1.trackingCode === "S1.A1.2001297581", JSON.stringify(c1));
      const sent = ghtk.calls.filter((x) => x.path === "services/shipment/order/").at(-1)?.body?.order as Record<string, unknown>;
      assert.ok(sent && String(sent.id).endsWith("-1") && sent.ward === "Phường Sài Gòn" && sent.pick_ward === "Phường Nhiêu Lộc" && sent.pick_money === 285_000 && sent.hamlet === "Khác", JSON.stringify(sent));
      const [s1] = await db.select().from(schema.shipments).where(eq(schema.shipments.orderId, orderId));
      assert.ok(s1.carrier === "GHTK" && s1.trackingCode === "S1.A1.2001297581" && s1.vtpOrderNumber === null && s1.stage === "PENDING" && s1.shippingFee === 45_400, JSON.stringify(s1));
      assert.equal(carrierCreateOf(s1.raw)?.carrier, "GHTK");

      // ── Webhook form-urlencoded: 2 → 3 → 45 (shipper báo, chưa khai) → 5 ⇒ GIAO THÀNH CÔNG; gói lặp không đẻ sự kiện ──
      const T0 = Date.now() - 3 * 3_600_000;
      const pkt = (status: string, ms: number, label = "S1.A1.2001297581") => `label_id=${encodeURIComponent(label)}&partner_id=${encodeURIComponent(String(sent.id))}&action_time=${encodeURIComponent(new Date(ms).toISOString().replace("Z", "+00:00"))}&status_id=${status}&reason_code=&reason=&weight=0.6&fee=30400&pick_money=285000&return_part_package=0`;
      const deliver = async (text: string) => {
        const body = readGhtkBody(text, "application/x-www-form-urlencoded");
        assert.ok(body);
        return applyAcceptedGhtkWebhook(await acceptGhtkWebhook(body, { userAgent: "ghtk", contentType: "application/x-www-form-urlencoded" }), body);
      };
      await deliver(pkt("2", T0));
      assert.equal(await outcomeOf(db, orderId), "AWAITING_PICKUP", "GHTK đã tiếp nhận, chưa lấy hàng ⇒ CHỜ LẤY");
      await deliver(pkt("3", T0 + 3_600_000));
      assert.equal(await outcomeOf(db, orderId), "IN_TRANSIT");
      await deliver(pkt("45", T0 + 5_000_000));
      const [sx] = await db.select().from(schema.shipments).where(eq(schema.shipments.id, s1.id));
      assert.equal(sx.stage, "PICKED_UP", "mã «shipper báo» chưa khai không dựng chặng");
      await deliver(pkt("5", T0 + 7_200_000));
      await deliver(pkt("5", T0 + 7_200_000));
      const [s1b] = await db.select().from(schema.shipments).where(eq(schema.shipments.id, s1.id));
      assert.ok(s1b.stage === "DELIVERED" && s1b.isFinal === true && s1b.vtpStatus === null, JSON.stringify({ stage: s1b.stage, final: s1b.isFinal, vtp: s1b.vtpStatus }));
      assert.equal(await outcomeOf(db, orderId), "DELIVERED", "mã cuối GHTK là chứng từ (ORDER_OUTCOME mục 4.1)");
      const evs = await db.select().from(schema.shipmentEvents).where(and(eq(schema.shipmentEvents.shipmentId, s1.id), eq(schema.shipmentEvents.source, "GHTK_WEBHOOK")));
      assert.equal(evs.length, 4, "gói lặp không đẻ sự kiện thứ hai");
      const before = (await db.select().from(schema.shipments)).length;
      await deliver(pkt("3", T0, "S1.A1.NGOAIERP"));
      assert.equal((await db.select().from(schema.shipments)).length, before, "đơn GHTK tạo ngoài ERP: chỉ lưu gói");

      // ── Nhãn: link trỏ về ERP (token không ra trình duyệt); PDF chỉ chuyển tiếp cho mã ERP tạo, cần quyền ──
      const link = await printLinkCore(admin, s1.id, deps);
      assert.ok(link.ok && link.url === "/api/carriers/label?carrier=GHTK&code=S1.A1.2001297581", JSON.stringify(link));
      assert.ok(!link.url.includes(GHTK_TOKEN));
      const pdf = await labelPdfCore(admin, "GHTK", "S1.A1.2001297581", deps);
      assert.ok(pdf.ok && new TextDecoder().decode(pdf.pdf).startsWith("%PDF"), JSON.stringify(pdf.ok ? "ok" : pdf));
      assert.ok(ghtk.calls.some((x) => x.path === "services/label/S1.A1.2001297581" && x.query.get("page_size") === "A6"));
      const labelCalls = ghtk.count("services/label/");
      assert.equal((await labelPdfCore(admin, "GHTK", "S1.A1.NGOAIERP", deps)).ok, false, "mã không phải lần gửi ERP ⇒ không tải");
      assert.equal((await labelPdfCore(viewer, "GHTK", "S1.A1.2001297581", deps)).ok, false, "thiếu quyền vận đơn ⇒ không tải");
      assert.equal((await labelPdfCore(admin, "GHN", "S1.A1.2001297581", deps)).ok, false, "sai hãng ⇒ không tải");
      assert.equal(ghtk.count("services/label/"), labelCalls, "ba lượt bị chặn không gọi GHTK");

      // ── Đứt mạng lúc tạo ⇒ giữ chỗ; «Thử lại» gửi CÙNG mã ⇒ GHTK trả ORDER_ID_EXIST + mã đã có ⇒ đúng một vận đơn ──
      const order2 = await mk();
      const net = fakeGhtk({ create: "network", label: "S1.A1.3000000001" });
      const nw = await createShipmentCore(admin, "GHTK", order2, { weightGrams: 600, cod: 285_000, serviceCode: "ROAD", note: "", ...place }, { fetch: net.fetch });
      assert.ok(!nw.ok && nw.error.includes("Thử lại"), JSON.stringify(nw));
      const [held] = await db.select().from(schema.shipments).where(eq(schema.shipments.orderId, order2));
      const firstId = (net.calls.find((x) => x.path === "services/shipment/order/")?.body?.order as Record<string, unknown>)?.id;
      assert.ok((await carrierPanel(admin, order2))?.attempts.find((a) => a.id === held.id)?.canRetry, "GHTK chặn trùng bằng mã ⇒ thử lại được");
      const again = fakeGhtk({ create: "exists", label: "S1.A1.3000000001" });
      const rt = await retryCreateCore(admin, held.id, { fetch: again.fetch });
      assert.ok(rt.ok && rt.trackingCode === "S1.A1.3000000001", JSON.stringify(rt));
      assert.equal((again.calls.find((x) => x.path === "services/shipment/order/")?.body?.order as Record<string, unknown>)?.id, firstId, "thử lại gửi CÙNG mã ERP");
      assert.equal((await db.select().from(schema.shipments).where(eq(schema.shipments.orderId, order2))).length, 1);

      // ── Huỷ khi GHTK chưa lấy hàng ⇒ lời nhận lệnh theo mã GHTK; không tự đặt «Đã huỷ» ──
      const cx = await cancelShipmentCore(admin, held.id, { reason: "Khách đổi ý" }, { fetch: again.fetch });
      assert.ok(cx.ok, JSON.stringify(cx));
      assert.ok(again.calls.some((x) => x.path === "services/shipment/cancel/S1.A1.3000000001" && x.method === "POST"));
      const [h2] = await db.select().from(schema.shipments).where(eq(schema.shipments.id, held.id));
      assert.equal(h2.stage, "PENDING", "chặng chỉ đổi theo webhook -1");
      assert.equal((await cancelShipmentCore(admin, s1.id, { reason: "Thử huỷ đơn đã giao" }, deps)).ok, false, "đã giao ⇒ không huỷ");
    });
  } finally {
    if (savedKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = savedKey;
    await cleanupOrg(ORG);
  }
}

export async function testCarrierGhtk() {
  testPure();
  await testTester();
  await testFlow();
  console.log("  ✓ POS tự chủ · GHTK: thân Đăng đơn đúng tài liệu ver 1.5 (order.id = mã ERP, tỉnh + xã không huyện, hamlet «Khác», cân bằng gam, cước shop trả); kiểm tra đọc danh sách kho, không lộ token; tính phí bỏ cách chở hãng không phục vụ; tạo ghi mã GHTK ở tracking_code; webhook form-urlencoded đưa đơn CHỜ LẤY → ĐANG GIAO → GIAO THÀNH CÔNG, gói lặp không đẻ sự kiện, mã «shipper báo» không kết luận, đơn ngoài ERP chỉ lưu; nhãn PDF chỉ chuyển tiếp cho mã ERP tạo, cần quyền; đứt mạng ⇒ «Thử lại» cùng mã nhận ORDER_ID_EXIST ⇒ đúng một vận đơn; huỷ chờ webhook");
}

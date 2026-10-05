/**
 * ═══════════ TUYẾN GIAO TỰ ĐỘNG — POS tự chủ P7 (lib/constants/shipping-routing.ts · lib/shipping/*) ═══════════
 *
 *  1. THUẦN — đọc cấu hình (hỏng ⇒ TẮT; công tắc chỉ nhận đúng `true`); quyết tuyến theo đúng thứ tự căn cứ (chưa xác nhận ·
 *     đã có vận đơn · thiếu tỉnh / xã · khu tự giao thắng hãng · chưa chọn / chưa bật hãng · thiếu cân · công tắc tắt · đơn
 *     xác nhận trước lúc bật · chờ thử lại · bỏ cuộc) — KHÔNG đoán; nhịp thử lại của máy.
 *  2. LUỒNG THẬT trên CSDL tổ chức + GHN giả (không mạng — luật 65): lưu cấu hình (tên lạ bị từ chối, tên chuẩn hoá, bật đòi
 *     hãng ĐANG BẬT, `autoSince`); xếp tuyến đúng từng đơn; job tạo ĐÚNG MỘT vận đơn cho đơn đi hãng (tác nhân MÁY, không mượn
 *     tài khoản), chạy lại / chạy song song không đẻ vận đơn thứ hai, đơn cũ không bị kéo sang hãng; hãng từ chối ⇒ ghi lỗi,
 *     chờ 30 phút, bỏ cuộc sau 3 lần, sửa đơn ⇒ thử lại ngay; gán người giao bằng khoá tài khoản; «Đã giao» đi qua phiếu giao.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import { GHN_API } from "@/lib/constants/carrier-ghn";
import { carrierCreateOf } from "@/lib/constants/carrier-vtp";
import { autoAttemptDue, nextFailedAttempts, parseShippingRoutingConfig, SHIPPING_ROUTING_LIMITS, type ShippingRoutingConfig } from "@/lib/constants/shipping-routing";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { confirmManualDeliveryCore, createManualOrderCore, manualOrderFormValues, updateManualOrderCore } from "@/lib/records/order-create";
import { decideShippingRoute, matchSelfArea, type RouteOrderInput } from "@/lib/shipping/route";
import { assignCourierCore, routedOrders, runShippingRoutes, saveShippingRoutingCore } from "@/lib/shipping/routing";
import { runJob } from "@/lib/sync/jobs";

const ORG = "tuyen-giao-tu-dong";
const ORG_SECRETS_KEY = "khoa-kiem-thu-tuyen-giao-0123456789abcdefghijklmnopqrstuvwxyzABCD";
const GHN_TOKEN = "5c1d8a9e-2f4b-11ed-a1b2-c3d4e5f60719";
const SHOP_ID = "92838";

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

// ─────────────────────────── 1 · THUẦN ───────────────────────────

function testPure() {
  assert.deepEqual(parseShippingRoutingConfig(null), { selfAreas: [], defaultCarrier: null, autoCreate: false, serviceCode: null, autoSince: null }, "chưa khai ⇒ TẮT");
  assert.equal(parseShippingRoutingConfig({ autoCreate: "true", defaultCarrier: "GHN", autoSince: "2026-10-06T00:00:00Z" }).autoCreate, false, "công tắc chỉ nhận đúng true");
  assert.equal(parseShippingRoutingConfig({ autoCreate: true, defaultCarrier: null, autoSince: "2026-10-06T00:00:00Z" }).autoCreate, false, "bật mà không có hãng ⇒ không bật");
  assert.equal(parseShippingRoutingConfig({ autoCreate: true, defaultCarrier: "XYZ", autoSince: "2026-10-06T00:00:00Z" }).defaultCarrier, null, "hãng lạ ⇒ null");
  assert.equal(parseShippingRoutingConfig({ serviceCode: "rẻ; drop" }).serviceCode, null, "mã dịch vụ lạ không lọt");

  const since = new Date("2026-10-06T08:00:00Z");
  const now = new Date("2026-10-06T12:00:00Z");
  const cfg: ShippingRoutingConfig = { selfAreas: [{ province: "Thành phố Hà Nội", wards: ["Phường Hoàn Kiếm"] }, { province: "Tỉnh Bắc Ninh", wards: [] }], defaultCarrier: "GHN", autoCreate: true, serviceCode: null, autoSince: since.toISOString() };
  const ready = new Set(["GHN"] as const);
  const base: RouteOrderInput = { isErp: true, stage: "CONFIRMED", province: "Thành phố Hồ Chí Minh", ward: "Phường Sài Gòn", hasLiveShipment: false, weightGrams: 600, confirmedAt: new Date("2026-10-06T09:00:00Z"), updatedAt: new Date("2026-10-06T09:00:00Z"), auto: null };
  const r = (o: Partial<RouteOrderInput>, c: Partial<ShippingRoutingConfig> = {}, rd: ReadonlySet<"VTP" | "GHN" | "GHTK"> = ready) => decideShippingRoute({ ...base, ...o }, { ...cfg, ...c }, rd, now);

  assert.deepEqual(r({ isErp: false }), { kind: "HOLD", code: "NOT_ERP", reason: "Đơn đồng bộ từ nguồn khác" });
  assert.equal((r({ stage: "NEW" }) as { code?: string }).code, "NOT_CONFIRMED");
  assert.deepEqual(r({ hasLiveShipment: true }), { kind: "SHIPPED" }, "đã có lần gửi còn hiệu lực ⇒ không xếp tuyến lần hai");
  assert.equal((r({ province: "" }) as { code?: string }).code, "NO_PROVINCE");
  assert.equal((r({ ward: " " }) as { code?: string }).code, "NO_WARD", "thiếu xã ⇒ GIỮ, không đọc lại dòng địa chỉ để đoán");
  assert.deepEqual(r({ province: "Hà Nội", ward: "phường hoàn kiếm" }), { kind: "SELF", area: "Phường Hoàn Kiếm" }, "khu tự giao khớp theo tên chuẩn, bỏ dấu, nhận tên tỉnh viết tắt");
  assert.deepEqual(r({ province: "Thành phố Hà Nội", ward: "Phường Ba Đình" }).kind, "CARRIER", "cùng tỉnh, khác xã ⇒ không tự giao");
  assert.deepEqual(r({ province: "Tỉnh Bắc Ninh", ward: "Phường Kinh Bắc", weightGrams: null }), { kind: "SELF", area: "Tỉnh Bắc Ninh" }, "khu cả tỉnh; tự giao không cần cân");
  assert.equal((r({}, { defaultCarrier: null }) as { code?: string }).code, "NO_CARRIER");
  assert.equal((r({}, {}, new Set()) as { code?: string }).code, "CARRIER_OFF", "hãng chưa bật ⇒ GIỮ");
  assert.equal((r({ weightGrams: null }) as { code?: string }).code, "NO_WEIGHT", "thiếu cân ⇒ GIỮ, không đoán cân");
  assert.deepEqual(r({}), { kind: "CARRIER", carrier: "GHN", weightGrams: 600, auto: { ok: true } });
  const off = r({}, { autoCreate: false });
  assert.ok(off.kind === "CARRIER" && !off.auto.ok && off.auto.why.includes("tắt"));
  const old = r({ confirmedAt: new Date("2026-10-06T07:59:59Z") });
  assert.ok(old.kind === "CARRIER" && !old.auto.ok && old.auto.why.includes("TRƯỚC lúc bật"), "đơn xác nhận trước lúc bật không bị kéo sang hãng");

  // Nhịp thử lại.
  const failedAt = new Date("2026-10-06T11:50:00Z");
  const st = (attempts: number) => ({ attempts, lastAt: failedAt, lastResult: "FAILED" as const, lastMessage: "Sai xã" });
  const wait = r({ auto: st(1) });
  assert.ok(wait.kind === "CARRIER" && !wait.auto.ok && wait.auto.why.includes("Sai xã"), "hỏng 10 phút trước ⇒ chờ, nói lỗi");
  assert.equal(autoAttemptDue(st(1), base.updatedAt, new Date(failedAt.getTime() + SHIPPING_ROUTING_LIMITS.autoRetryAfterMs)), "FRESH", "đủ 30 phút ⇒ thử lại");
  const gave = r({ auto: st(SHIPPING_ROUTING_LIMITS.autoMaxAttempts) });
  assert.ok(gave.kind === "HOLD" && gave.code === "AUTO_FAILED" && gave.reason.includes("Sai xã"), "đủ 3 lần ⇒ GIỮ kèm câu lỗi của hãng");
  assert.deepEqual(r({ auto: st(SHIPPING_ROUTING_LIMITS.autoMaxAttempts), updatedAt: new Date("2026-10-06T11:55:00Z") }).kind, "CARRIER", "người sửa đơn sau lần hỏng ⇒ thử lại ngay");
  assert.equal(nextFailedAttempts(st(2), base.updatedAt), 3);
  assert.equal(nextFailedAttempts(st(2), new Date("2026-10-06T11:55:00Z")), 1, "sửa đơn ⇒ đếm lại");
  assert.equal(nextFailedAttempts(null, base.updatedAt), 1);
  assert.equal(matchSelfArea([], "Hà Nội", "Phường Hoàn Kiếm"), null, "không khai khu tự giao ⇒ không đơn nào tự giao");
}

// ─────────────────────────── 2 · LUỒNG THẬT ───────────────────────────

const PROVINCES = [{ _id: 1000001, name: "Hồ Chí Minh", extension_names: ["hồ chí minh", "thành phố hồ chí minh"], type: "province", parent_id: 1, status: 1 }];
const WARDS_HCM = [{ _id: 1003001, name: "Phường Sài Gòn", extension_names: ["phường sài gòn", "sài gòn"], type: "ward", parent_id: 1000001, status: 1 }];

function fakeGhn(mode: { create: "ok" | "reject" | "network" }) {
  const calls: { path: string; body: Record<string, unknown> | null }[] = [];
  let seq = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (url: string, init: RequestInit) => {
    assert.ok(url.startsWith(`${GHN_API}/`), `chỉ gọi địa chỉ hằng số: ${url}`);
    const u = new URL(url);
    const path = u.pathname.replace("/shiip/public-api/", "");
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ path, body });
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (headers.Token !== GHN_TOKEN) return json({ code: 401, message: "Token is not valid", data: null }, 401);
    if (path === "v2/shop/all") return json({ code: 200, message: "Success", data: { last_offset: 0, shops: [{ _id: Number(SHOP_ID), name: "Shop tuyến giao", address: "1 Lê Lợi", status: 1 }] } });
    if (path === "v3/master-data/province/all") return json({ code: 200, message: "Success", data: PROVINCES });
    if (path === "v3/master-data/ward/all-by-province-id") return json({ code: 200, message: "Success", data: u.searchParams.get("province_id") === "1000001" ? WARDS_HCM : [] });
    if (path === "v2/shipping-order/preview") return json({ code: 200, message: "Success", data: { order_code: "", total_fee: 20_900, fee: { main_service: 20_900 }, expected_delivery_time: "2026-10-08T16:59:59Z" } });
    if (path === "v2/shipping-order/create") {
      if (mode.create === "network") throw new TypeError("fetch failed: socket hang up");
      if (mode.create === "reject") return json({ code: 400, message: "Số điện thoại người nhận không hợp lệ", data: null }, 400);
      seq += 1;
      return json({ code: 200, message: "Success", data: { order_code: `LTG${seq}`, total_fee: 20_900, fee: { main_service: 20_900 } } });
    }
    return json({ code: 404, message: "không có" }, 404);
  };
  return { fetch: fetchImpl, calls, count: (p: string) => calls.filter((c) => c.path === p).length };
}

async function testFlow() {
  await cleanupOrg(ORG);
  const savedKey = process.env.PLATFORM_SECRETS_KEY;
  process.env.PLATFORM_SECRETS_KEY = ORG_SECRETS_KEY;
  try {
    await provisionOrganization({ code: ORG, name: "Shop tuyến giao tự động", plan: "standard", modules: ["customers", "products", "orders", "logistics"], admin: { email: `admin@${ORG}.local`, name: "Quản trị", password: "TuyenGiao@123" }, source: "TEST", actor: null });
    const enabled = await getEnabledModules(ORG);
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const admin = { id: u.id, email: u.email, name: "Quản trị", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: "Shop tuyến giao tự động", isHome: false }, modules: [...enabled] } as unknown as SessionUser;
      const [shipper] = await db.insert(schema.users).values({ email: `shipper@${ORG}.local`, name: "Anh Giao", passwordHash: "x", role: "VIEWER" }).returning({ id: schema.users.id });

      await db.insert(schema.products).values({ id: "erp-tg-prod", name: "Chả mực", raw: { origin: "ERP_MANUAL" } });
      await db.insert(schema.productVariants).values([
        { id: "erp-tg-var", productId: "erp-tg-prod", sku: "CM-500", size: "500g", retailPrice: 200_000, weight: 500 },
        { id: "erp-tg-nowt", productId: "erp-tg-prod", sku: "CM-KG", size: "1kg", retailPrice: 380_000 },
      ]);
      const cust = async (name: string, phone: string, address: string, province: string) => (await db.insert(schema.customers).values({ name, phone, address, province }).returning({ id: schema.customers.id }))[0]!.id;
      const cHn = await cust("Khách Hà Nội", "0912000001", "12 Hàng Bài, Phường Hoàn Kiếm", "Hà Nội");
      const cHcm = await cust("Khách Sài Gòn", "0912000002", "72 Lê Thánh Tôn, P. Sài Gòn", "TP. Hồ Chí Minh");
      const cVague = await cust("Khách thiếu xã", "0912000003", "Số 5 ngõ nhỏ gần chợ", "Hà Nội");
      const mk = async (customerId: string, variantId = "erp-tg-var") => {
        const r = await createManualOrderCore(admin, { customerId, stage: "CONFIRMED", channel: "Fanpage", note: "", orderDiscount: 0, shippingFee: 25_000, lines: [{ variantId, quantity: 2, unitPrice: 200_000, discount: 0 }] });
        assert.ok(r.ok, JSON.stringify(r));
        return r.id;
      };

      // ── Cấu hình: tên lạ bị từ chối; bật tự tạo đòi hãng ĐANG BẬT ──
      const bad = await saveShippingRoutingCore(admin, { selfAreas: [{ province: "Hà Nội", wards: ["Phường Không Có Thật"] }], defaultCarrier: "GHN", autoCreate: false, serviceCode: null });
      assert.ok(!bad.ok && bad.error.includes("Phường Không Có Thật"), JSON.stringify(bad));
      const notReady = await saveShippingRoutingCore(admin, { selfAreas: [], defaultCarrier: "GHN", autoCreate: true, serviceCode: null });
      assert.ok(!notReady.ok && notReady.error.includes("chưa bật"), JSON.stringify(notReady));
      const viewer = { ...admin, role: "VIEWER", permissions: ["orders:read"] } as unknown as SessionUser;
      assert.equal((await saveShippingRoutingCore(viewer, { selfAreas: [], defaultCarrier: null, autoCreate: false, serviceCode: null })).ok, false, "không có settings:manage ⇒ không lưu");
      const saved = await saveShippingRoutingCore(admin, { selfAreas: [{ province: "hà nội", wards: ["phường hoàn kiếm"] }], defaultCarrier: "GHN", autoCreate: false, serviceCode: null });
      assert.ok(saved.ok && saved.config.selfAreas[0]?.province === "Thành phố Hà Nội" && saved.config.selfAreas[0]?.wards[0] === "Phường Hoàn Kiếm", "lưu TÊN CHUẨN");

      // Đơn xác nhận TRƯỚC khi bật tự tạo — sau này không bị kéo sang hãng.
      const oldHcm = await mk(cHcm);

      const ghn = fakeGhn({ create: "ok" });
      assert.ok("ok" in (await saveConnection(admin, { connectorKey: "ghn-carrier", settings: { shopId: SHOP_ID }, secrets: { token: GHN_TOKEN } })));
      assert.ok("ok" in (await testOrgConnection(admin, "ghn-carrier", { tester: { fetch: ghn.fetch } })));
      assert.ok("ok" in (await setConnectionStatus(admin, "ghn-carrier", "ACTIVE")));
      const on = await saveShippingRoutingCore(admin, { selfAreas: [{ province: "Hà Nội", wards: ["Phường Hoàn Kiếm"] }], defaultCarrier: "GHN", autoCreate: true, serviceCode: null });
      assert.ok(on.ok && on.config.autoCreate && on.config.autoSince, JSON.stringify(on));
      const again = await saveShippingRoutingCore(admin, { selfAreas: [{ province: "Hà Nội", wards: ["Phường Hoàn Kiếm"] }], defaultCarrier: "GHN", autoCreate: true, serviceCode: null });
      assert.ok(again.ok && again.config.autoSince === on.config.autoSince, "lưu lại không dời mốc bật");

      const selfId = await mk(cHn);
      const hcmId = await mk(cHcm);
      const vagueId = await mk(cVague);
      const noWeightId = await mk(cHcm, "erp-tg-nowt");

      const routes = async () => Object.fromEntries((await routedOrders()).rows.map((x) => [x.id, x]));
      let rt = await routes();
      assert.deepEqual(rt[selfId]?.route, { kind: "SELF", area: "Phường Hoàn Kiếm" });
      assert.equal(rt[selfId]?.toCollect, 425_000, "người giao thu đúng số khách còn phải trả (hàng + ship)");
      assert.deepEqual(rt[hcmId]?.route, { kind: "CARRIER", carrier: "GHN", weightGrams: 1000, auto: { ok: true } });
      assert.equal(rt[vagueId]?.route.kind === "HOLD" && rt[vagueId].route.code, "NO_WARD", "địa chỉ không ghép được xã ⇒ GIỮ");
      assert.equal(rt[noWeightId]?.route.kind === "HOLD" && rt[noWeightId].route.code, "NO_WEIGHT");
      assert.ok(rt[oldHcm]?.route.kind === "CARRIER" && !rt[oldHcm].route.auto.ok, "đơn cũ: đi hãng nhưng máy không tự tạo");

      // ── Job: đúng MỘT vận đơn cho đúng đơn; máy là tác nhân ──
      const run1 = await runShippingRoutes({}, { fetch: ghn.fetch });
      assert.ok(!run1.skipped && run1.created === 1 && run1.failed === 0, JSON.stringify(run1));
      const s1 = await db.select().from(schema.shipments).where(eq(schema.shipments.orderId, hcmId));
      assert.equal(s1.length, 1);
      assert.ok(s1[0]!.carrier === "GHN" && s1[0]!.trackingCode === "LTG1" && s1[0]!.codAmount === 425_000 && s1[0]!.weight === 1000, JSON.stringify(s1[0]));
      assert.equal(carrierCreateOf(s1[0]!.raw)?.by, null, "máy không mượn tài khoản của ai (luật 34/36)");
      const sent = ghn.calls.filter((c) => c.path === "v2/shipping-order/create");
      assert.equal(sent.length, 1, "đơn cũ, đơn tự giao, đơn giữ lại KHÔNG đi hãng");
      assert.equal(sent[0]!.body?.service_type_id, 2, "dịch vụ rẻ nhất từ bảng cước");
      const [log] = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "SHIPMENT_CARRIER_CREATE"), eq(schema.auditLogs.entityId, hcmId)));
      assert.ok(log && log.userEmail === "job:shipping-route" && log.userId === null, JSON.stringify(log));
      rt = await routes();
      assert.deepEqual(rt[hcmId]?.route, { kind: "SHIPPED" });
      assert.deepEqual(await runShippingRoutes({}, { fetch: ghn.fetch }), { skipped: "IDLE", detail: "Không đơn nào chờ máy tạo vận đơn." }, "chạy lại không đẻ vận đơn thứ hai");

      // ── Hai lượt song song cho cùng đơn ⇒ vẫn một vận đơn, không ghi «hỏng» ──
      const twin = await mk(cHcm);
      const [a, b] = await Promise.all([runShippingRoutes({}, { fetch: ghn.fetch }), runShippingRoutes({}, { fetch: ghn.fetch })]);
      assert.equal((await db.select().from(schema.shipments).where(eq(schema.shipments.orderId, twin))).length, 1, JSON.stringify([a, b]));
      const [twinDispatch] = await db.select().from(schema.orderDispatch).where(eq(schema.orderDispatch.orderId, twin));
      assert.equal(twinDispatch?.autoLastResult, "CREATED", "lượt thua cuộc đua không ghi đè thành «hỏng»");

      // ── Đứt mạng giữa lượt tạo ⇒ lõi giữ chỗ ở UNKNOWN; máy KHÔNG ghi «hỏng», KHÔNG tự gửi lại — người tra ở trang đơn ──
      const cut = await mk(cHcm);
      const net = fakeGhn({ create: "network" });
      const rn = await runShippingRoutes({}, { fetch: net.fetch });
      assert.ok(!rn.skipped && rn.created === 0 && rn.failed === 0 && rn.detail.length === 1, JSON.stringify(rn));
      const [held] = await db.select().from(schema.shipments).where(eq(schema.shipments.orderId, cut));
      assert.equal(carrierCreateOf(held?.raw)?.state, "UNKNOWN");
      assert.equal((await db.select().from(schema.orderDispatch).where(eq(schema.orderDispatch.orderId, cut))).length, 0, "giữ chỗ không rõ kết quả không phải lỗi của tuyến");
      assert.deepEqual((await routes())[cut]?.route, { kind: "SHIPPED" });
      assert.equal((await runShippingRoutes({}, { fetch: ghn.fetch })).skipped, "IDLE", "không tự gửi lại lượt không rõ kết quả");

      // ── Hãng từ chối ⇒ ghi lỗi, chờ, bỏ cuộc sau 3 lần; sửa đơn ⇒ thử lại ngay ──
      const rejected = await mk(cHcm);
      const rej = fakeGhn({ create: "reject" });
      const t0 = Date.now();
      const r1 = await runShippingRoutes({}, { fetch: rej.fetch });
      assert.ok(!r1.skipped && r1.failed === 1 && r1.detail[0]?.includes("không hợp lệ"), JSON.stringify(r1));
      assert.equal((await db.select().from(schema.shipments).where(eq(schema.shipments.orderId, rejected))).length, 0, "hãng từ chối ⇒ bỏ chỗ giữ");
      rt = await routes();
      assert.ok(rt[rejected]?.route.kind === "CARRIER" && !rt[rejected].route.auto.ok, "vừa hỏng ⇒ chờ");
      assert.equal((await runShippingRoutes({}, { fetch: rej.fetch })).skipped, "IDLE", "trong 30 phút không dội hãng");
      const later = (k: number) => new Date(t0 + k * (SHIPPING_ROUTING_LIMITS.autoRetryAfterMs + 60_000));
      assert.equal((await runShippingRoutes({ now: later(1) }, { fetch: rej.fetch }) as { failed?: number }).failed, 1);
      const [d2] = await db.select().from(schema.orderDispatch).where(eq(schema.orderDispatch.orderId, rejected));
      assert.equal(d2?.autoAttempts, 2);
      // Mốc lần hỏng là đồng hồ thật ⇒ «sau 30 phút» tính từ chính mốc đó (luật 50: không ghim ngày tuyệt đối).
      const after = (d: Date | null | undefined) => new Date((d?.getTime() ?? Date.now()) + SHIPPING_ROUTING_LIMITS.autoRetryAfterMs + 60_000);
      assert.equal((await runShippingRoutes({ now: after(d2?.autoLastAt) }, { fetch: rej.fetch }) as { failed?: number }).failed, 1);
      const [d3] = await db.select().from(schema.orderDispatch).where(eq(schema.orderDispatch.orderId, rejected));
      assert.equal(d3?.autoAttempts, SHIPPING_ROUTING_LIMITS.autoMaxAttempts);
      const gaveUp = (await routedOrders(after(d3?.autoLastAt))).rows.find((x) => x.id === rejected)?.route;
      assert.ok(gaveUp?.kind === "HOLD" && gaveUp.code === "AUTO_FAILED" && gaveUp.reason.includes("không hợp lệ"), JSON.stringify(gaveUp));
      const values = await manualOrderFormValues(rejected);
      assert.ok(values);
      assert.ok((await updateManualOrderCore(admin, rejected, { ...values, note: "đã gọi khách xác nhận SĐT" })).ok);
      const fixed = await runShippingRoutes({}, { fetch: ghn.fetch });
      assert.ok(!fixed.skipped && fixed.created === 1, `sửa đơn ⇒ máy thử lại ngay: ${JSON.stringify(fixed)}`);

      // ── Danh sách tự giao: gán người giao bằng KHOÁ tài khoản, «Đã giao» qua phiếu giao ──
      assert.equal((await assignCourierCore(admin, { orderIds: [selfId], courierUserId: "khong-co" })).ok, false);
      const asg = await assignCourierCore(admin, { orderIds: [selfId, hcmId + "-khong-co"], courierUserId: shipper!.id });
      assert.ok(asg.ok && asg.assigned === 1 && asg.skipped === 1 && asg.courierName === "Anh Giao", JSON.stringify(asg));
      rt = await routes();
      assert.ok(rt[selfId]?.courierUserId === shipper!.id && rt[selfId].courierName === "Anh Giao");
      const done = await confirmManualDeliveryCore(admin, selfId, { signedAt: new Date().toISOString(), receiverName: "Khách Hà Nội", note: "" });
      assert.ok(done.ok, JSON.stringify(done));
      assert.equal((await routes())[selfId], undefined, "đã giao ⇒ rời danh sách");

      // ── Job qua runJob: công tắc tắt ⇒ bỏ qua, không ghi sync_runs ──
      assert.ok((await saveShippingRoutingCore(admin, { selfAreas: [], defaultCarrier: "GHN", autoCreate: false, serviceCode: null })).ok);
      const before = (await db.select().from(schema.syncRuns).where(eq(schema.syncRuns.job, "shipping-route"))).length;
      const off = (await runJob("shipping-route", { trigger: "CRON", actor: "kiem-thu", org: ORG })) as { skipped?: string };
      assert.equal(off.skipped, "OFF", JSON.stringify(off));
      assert.equal((await db.select().from(schema.syncRuns).where(eq(schema.syncRuns.job, "shipping-route"))).length, before);
    });
  } finally {
    if (savedKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = savedKey;
    await cleanupOrg(ORG);
  }
}

export async function testShippingRouting() {
  testPure();
  await testFlow();
  console.log("  ✓ Tuyến giao tự động: cấu hình hỏng ⇒ TẮT; tuyến theo đúng thứ tự căn cứ, không đoán (thiếu xã / cân / hãng ⇒ giữ lại kèm lối sửa); khu tự giao thắng hãng; job tạo đúng một vận đơn bằng lõi chung (tác nhân máy), chạy lại / song song không đẻ thêm, đơn cũ không bị kéo; hãng từ chối ⇒ chờ 30 phút, bỏ cuộc sau 3 lần, sửa đơn ⇒ thử ngay; người giao là khoá tài khoản; «Đã giao» qua phiếu giao");
}


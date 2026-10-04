/**
 * ═══════════ POS TỰ CHỦ — TẠO VẬN ĐƠN VIETTEL POST TỪ ĐƠN ERP (docs/verticals/pos-tu-chu.md) ═══════════
 *
 *  1. THUẦN — cắt chuỗi theo BYTE (chữ có dấu), mã ERP mỗi lần gửi, thân yêu cầu đúng tên trường tài liệu (ORDER_PAYMENT 3
 *     khi có thu hộ / 1 khi không, CHECK_UNIQUE), đọc đúng MẪU PHẢN HỒI in trong tài liệu (tra cước, tạo đơn).
 *  2. KIỂM TRA KẾT NỐI — Login → ownerconnect → listInventory, chỉ tới partner.viettelpost.vn, không theo chuyển hướng,
 *     mật khẩu không bao giờ nằm trong câu trả về; thiếu người gửi ⇒ không gọi.
 *  3. LUỒNG THẬT TRÊN CSDL TỔ CHỨC — tạo vận đơn ghi đúng một dòng `shipments` (chặng mặc định, không tự ghi stage); bấm lần
 *     hai bị chặn và KHÔNG gọi hãng; đơn đang có vận đơn không sửa / huỷ được; huỷ ở hãng ⇒ lần gửi mới mang mã «-2»; hãng từ
 *     chối ⇒ không còn chỗ giữ; đứt mạng ⇒ GIỮ chỗ ở UNKNOWN, chặn tạo mới, «Bỏ lượt tạo» mới gỡ; client của tổ chức khác ⇒ ném
 *     trước khi gọi mạng; thiếu `shipments:manage` ⇒ từ chối.
 *
 * Không gọi mạng (luật 65): mọi lượt tới hãng đi qua máy chủ giả tiêm vào `deps.fetch`.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { BULK_MAX, bulkCreateCore, bulkPrintLinkCore, bulkQuoteCore, cancelShipmentCore, carrierPanel, createShipmentCore, discardCreateCore, printLinkCore, quoteShipmentCore } from "@/lib/carriers/engine";
import { VTP_ADAPTER } from "@/lib/carriers/adapters/vtp";
import { GHN_ADAPTER } from "@/lib/carriers/adapters/ghn";
import { findConnector } from "@/lib/connectors/registry";
import { saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import { testViettelPostCarrier } from "@/lib/connectors/testers";
import {
  attemptHoldsOrder,
  carrierCreateOf,
  clipBytes,
  draftProblems,
  linesWeight,
  parseVtpCreated,
  parseVtpQuote,
  receiverAddressLine,
  VTP_PARTNER_API,
  vtpCreateBody,
  vtpPrintUrl,
  vtpReferenceFor,
} from "@/lib/constants/carrier-vtp";
import { VtpCarrierClient } from "@/lib/integrations/viettelpost/carrier-org";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { CredentialOwnerMismatchError } from "@/lib/platform/credentials";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { createManualOrderCore, updateManualOrderCore } from "@/lib/records/order-create";

const ORG = "vtp-tao-don";
const ORG_SECRETS_KEY = "khoa-kiem-thu-vtp-tao-don-0123456789abcdefghijklmnopqrstuvwxyz";
const VTP_PASSWORD = "MatKhau-VTP-bi-mat-9876";
const SHORT_TOKEN = "token-ngan-han-abcdef123456";
const LONG_TOKEN = "token-dai-han-uvwxyz987654";

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

// Mẫu phản hồi chép NGUYÊN từ tài liệu partner2.viettelpost.vn/document (04/10/2026).
const DOC_QUOTE = {
  SENDER_ADDRESS: { PROVINCE_ID: 1, DISTRICT_ID: 25, WARD_ID: 498, ADDRESS: "P.Đại Mỗ - Q.Nam Từ Liêm - TP.Hà Nội" },
  RECEIVER_ADDRESS: { PROVINCE_ID: 1, DISTRICT_ID: 4, WARD_ID: 74, ADDRESS: "P.Định Công - Q.Hoàng Mai - TP.Hà Nội" },
  RESULT: [
    { MA_DV_CHINH: "VCN", TEN_DICHVU: "Chuyển phát nhanh", GIA_CUOC: 32000, THOI_GIAN: "24 giờ", EXCHANGE_WEIGHT: 0, EXTRA_SERVICE: [] },
    { MA_DV_CHINH: "PHS", TEN_DICHVU: "Nội tỉnh tiết kiệm", GIA_CUOC: 16500, THOI_GIAN: "24 giờ", EXCHANGE_WEIGHT: 0, EXTRA_SERVICE: [{ SERVICE_CODE: "GGD", SERVICE_NAME: "Giao Bưu phẩm tại điểm giao dịch", DESCRIPTION: null }] },
  ],
};
const DOC_CREATED = { ORDER_NUMBER: "15878180012", MONEY_COLLECTION: 562000, EXCHANGE_WEIGHT: 50, MONEY_TOTAL: 16500, MONEY_TOTAL_FEE: 15000, MONEY_FEE: 0, MONEY_COLLECTION_FEE: 0, MONEY_OTHER_FEE: 0, MONEY_VAS: 0, MONEY_VAT: 1500, KPI_HT: 48, RECEIVER_PROVINCE: 34, RECEIVER_DISTRICT: 390, RECEIVER_WARD: 7393, SORT_CODE: "HNI-CẦU GIẤY-NAT" };

function testPure() {
  // Trần 150 BYTE: «ệ» là 3 byte — cắt theo ký tự sẽ vượt trần mà không ai thấy.
  const longVi = "Số 18 ngõ 92 đường Nguyễn Khánh Toàn phường Quan Hoa quận Cầu Giấy thành phố Hà Nội Việt Nam ".repeat(3);
  const clipped = clipBytes(longVi);
  assert.ok(new TextEncoder().encode(clipped).length <= 150, "cắt theo byte UTF-8");
  assert.ok(longVi.startsWith(clipped.slice(0, 20)) && !clipped.endsWith(" "), "giữ phần đầu, không cắt đôi ký tự");
  assert.equal(vtpReferenceFor("a1b2c3d4", 2), "ERPA1B2C3D4-2", "mã ERP mỗi LẦN GỬI một mã");
  assert.equal(receiverAddressLine({ shipFullAddress: "", shipAddress: "12 Láng Hạ", shipCommune: "", shipDistrict: null, shipProvince: "Hà Nội" }), "12 Láng Hạ, Hà Nội");
  assert.equal(linesWeight([{ name: "A", quantity: 2, unitPrice: 1, weightGrams: 300 }, { name: "B", quantity: 1, unitPrice: 1, weightGrams: 0 }]), null, "một dòng thiếu cân ⇒ KHÔNG đoán");
  assert.equal(linesWeight([{ name: "A", quantity: 2, unitPrice: 1, weightGrams: 300 }]), 600);

  const draft = {
    reference: "ERPABCDEF12-1",
    sender: { name: "Shop Thử", phone: "0912345678", address: "34 Cửa Nam, Hoàn Kiếm, Hà Nội" },
    receiver: { name: "Chị Lan", phone: "0987654321", address: "Số 432 Hùng Vương, Phú Thọ" },
    lines: [{ name: "Đầm hoa", quantity: 2, unitPrice: 250_000, weightGrams: 300 }],
    goodsValue: 500_000,
    weightGrams: 600,
    cod: 530_000,
    serviceCode: "VCN",
    note: "",
  };
  assert.deepEqual(draftProblems(draft, { needService: true }), []);
  assert.ok(draftProblems({ ...draft, receiver: { ...draft.receiver, phone: "123" } }, { needService: true }).some((p) => p.field === "receiver"));
  assert.ok(draftProblems({ ...draft, weightGrams: 0 }, { needService: true }).some((p) => p.field === "weightGrams"));
  assert.ok(draftProblems({ ...draft, serviceCode: "" }, { needService: true }).some((p) => p.field === "serviceCode"));
  const body = vtpCreateBody(draft);
  assert.equal(body.ORDER_PAYMENT, 3, "có thu hộ ⇒ thu tiền hàng, KHÔNG thu cước (cước shop trả)");
  assert.equal(vtpCreateBody({ ...draft, cod: 0 }).ORDER_PAYMENT, 1, "không thu hộ ⇒ 1");
  assert.equal(body.CHECK_UNIQUE, true, "hãng chặn trùng mã ERP");
  assert.equal(body.MONEY_COLLECTION, 530_000);
  assert.equal(body.PRODUCT_NAME, "Đầm hoa ×2");
  assert.equal(body.ORDER_NOTE, "Cho xem hàng, không cho thử", "ghi chú trống ⇒ ghi chú mặc định");

  const quote = parseVtpQuote(DOC_QUOTE);
  assert.deepEqual(quote.services.map((s) => s.code), ["PHS", "VCN"], "xếp rẻ trước");
  assert.equal(quote.receiverAddressAsRead, "P.Định Công - Q.Hoàng Mai - TP.Hà Nội", "trả địa chỉ hãng hiểu để người bấm nhìn thấy");
  assert.equal(parseVtpQuote([{ MA_DV_CHINH: "LCOD", TEN_DICHVU: "x", GIA_CUOC: 20000 }]).services.length, 1, "đọc được cả dạng mảng của API cũ");
  const created = parseVtpCreated(DOC_CREATED);
  assert.ok(created && created.orderNumber === "15878180012" && created.moneyTotal === 16500 && created.sortCode === "HNI-CẦU GIẤY-NAT");
  assert.equal(parseVtpCreated({ MONEY_TOTAL: 1 }), null, "không có mã vận đơn ⇒ không có gì để lưu");
  assert.equal(vtpPrintUrl("ab+c=/d"), "https://digitalize.viettelpost.vn/DigitalizePrint/report.do?type=1&bill=ab%2Bc%3D%2Fd&showPostage=1");

  const raw = (state: string) => ({ carrierCreate: { state, reference: "R", by: null, at: new Date().toISOString() } });
  assert.equal(attemptHoldsOrder({ stage: "PENDING", raw: raw("UNKNOWN") }), true, "lượt không rõ kết quả vẫn GIỮ đơn");
  assert.equal(attemptHoldsOrder({ stage: "CANCELLED", raw: raw("CREATED") }), false);
  assert.equal(attemptHoldsOrder({ stage: "PENDING", raw: { ...raw("CREATED"), carrierCancel: { state: "ACCEPTED", at: "x", reason: "r", message: "" } } }), false, "hãng đã nhận lệnh huỷ ⇒ thôi giữ");
  assert.equal(VTP_ADAPTER.cancellable({ stage: "PICKED_UP", vtpStatus: 200 }), false, "Viettel Post đã nhận hàng (≥ 200) ⇒ không huỷ");
  assert.equal(VTP_ADAPTER.cancellable({ stage: "PENDING", vtpStatus: null }), true);
  assert.equal(GHN_ADAPTER.cancellable({ stage: "PICKED_UP", vtpStatus: null }), false, "GHN đã lấy hàng ⇒ không huỷ");
  assert.equal(GHN_ADAPTER.cancellable({ stage: "PENDING", vtpStatus: null }), true);

  const spec = findConnector("viettelpost-carrier");
  assert.ok(spec && spec.tenancy === "PER_ORG" && spec.module === "logistics" && spec.kind === "SHIPPING" && spec.capabilities.includes("create_label"));
  assert.ok(spec.settings.find((f) => f.key === "password")?.secret, "mật khẩu là ô bí mật");
}

type Mode = { create: "ok" | "reject" | "network"; nextNumber: number };

/** Máy chủ Viettel Post giả: đúng các đường dẫn tài liệu; đếm từng lượt để chứng minh «không gọi hãng». */
function fakeVtp(mode: Mode) {
  const calls: { path: string; body: Record<string, unknown> | null; token: string | null; redirect: RequestRedirect | undefined }[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (url: string, init: RequestInit) => {
    assert.ok(url.startsWith(`${VTP_PARTNER_API}/`), `chỉ gọi địa chỉ hằng số: ${url}`);
    const path = url.slice(VTP_PARTNER_API.length + 1);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ path, body, token: headers.Token ?? null, redirect: init.redirect });
    if (path === "user/Login") return body?.PASSWORD === VTP_PASSWORD ? json({ status: 200, error: false, message: "OK", data: { token: SHORT_TOKEN } }) : json({ status: 205, error: true, message: "Sai tài khoản hoặc mật khẩu", data: null });
    if (path === "user/ownerconnect") return json({ status: 200, error: false, message: "OK", data: { token: LONG_TOKEN } });
    if (path === "user/listInventory") return json({ status: 200, error: false, message: "OK", data: [{ groupaddressId: 1, name: "Kho Cửa Nam", address: "34 Cửa Nam" }] });
    assert.equal(headers.Token, LONG_TOKEN, "API nghiệp vụ dùng token DÀI HẠN của ownerconnect");
    if (path === "order/getPriceAllNlp") return json({ status: 200, error: false, message: "OK", data: DOC_QUOTE });
    if (path === "order/createOrderNlp") {
      if (mode.create === "network") throw new TypeError("fetch failed: socket hang up");
      if (mode.create === "reject") return json({ status: 204, error: true, message: "Địa chỉ người nhận không hợp lệ", data: null });
      return json({ status: 200, error: false, message: "OK", data: { ...DOC_CREATED, ORDER_NUMBER: String(mode.nextNumber++), MONEY_COLLECTION: body?.MONEY_COLLECTION } });
    }
    if (path === "order/UpdateOrder") return json({ status: 200, error: false, message: "Hủy đơn thành công", data: null });
    if (path === "order/printing-code") return json({ status: 200, error: false, message: "MA-IN-123=", data: null });
    return json({ status: 404, error: true, message: "không có" }, 404);
  };
  return { fetch: fetchImpl, calls, count: (p: string) => calls.filter((c) => c.path === p).length };
}

async function testTester() {
  const settings = { username: "0912345678", senderName: "Shop Thử", senderPhone: "0912345678", senderAddress: "34 Cửa Nam, Hoàn Kiếm, Hà Nội" };
  const ok = fakeVtp({ create: "ok", nextNumber: 1 });
  const r = await testViettelPostCarrier({ secrets: { password: VTP_PASSWORD }, settings }, { fetch: ok.fetch });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(ok.calls.map((c) => c.path), ["user/Login", "user/ownerconnect", "user/listInventory"], "chỉ đăng nhập + đọc kho — không tạo gì");
  assert.ok(ok.calls.every((c) => c.redirect === "manual"), "không theo chuyển hướng");
  assert.ok(r.message.includes("Kho Cửa Nam") && !r.message.includes(VTP_PASSWORD) && !r.message.includes(LONG_TOKEN));

  const bad = fakeVtp({ create: "ok", nextNumber: 1 });
  const wrong = await testViettelPostCarrier({ secrets: { password: "sai-mat-khau" }, settings }, { fetch: bad.fetch });
  assert.equal(wrong.ok, false);
  assert.ok(wrong.message.includes("Sai tài khoản") && !wrong.message.includes("sai-mat-khau"), wrong.message);

  const none = fakeVtp({ create: "ok", nextNumber: 1 });
  const noSender = await testViettelPostCarrier({ secrets: { password: VTP_PASSWORD }, settings: { ...settings, senderAddress: "" } }, { fetch: none.fetch });
  assert.equal(noSender.ok, false);
  assert.equal(none.calls.length, 0, "thiếu người gửi ⇒ không gọi");
}

async function testFlow() {
  await cleanupOrg(ORG);
  const savedKey = process.env.PLATFORM_SECRETS_KEY;
  process.env.PLATFORM_SECRETS_KEY = ORG_SECRETS_KEY;
  try {
    await provisionOrganization({ code: ORG, name: "Shop tự tạo vận đơn", plan: "standard", modules: ["customers", "products", "orders", "logistics"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "VanDon@12345" }, source: "TEST", actor: null });
    const enabled = await getEnabledModules(ORG);
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const org = { code: ORG, name: "Shop tự tạo vận đơn", isHome: false };
      const admin: SessionUser = { id: u.id, email: u.email, name: "QT", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: org, modules: [...enabled] } as SessionUser;
      const viewer: SessionUser = { ...admin, role: "MANAGER", permissions: ["orders:read", "orders:write", "shipments:view"] } as SessionUser;

      const [c] = await db.insert(schema.customers).values({ name: "Chị Lan", phone: "0987654321", address: "Số 432 Hùng Vương, Việt Trì", province: "Phú Thọ" }).returning({ id: schema.customers.id });
      await db.insert(schema.products).values({ id: "erp-vtp-prod", name: "Đầm hoa", raw: { origin: "ERP_MANUAL" } });
      await db.insert(schema.productVariants).values({ id: "erp-vtp-var", productId: "erp-vtp-prod", sku: "DH-M", size: "M", retailPrice: 250_000, weight: 300 });
      const made = await createManualOrderCore(admin, { customerId: c.id, stage: "CONFIRMED", channel: "Fanpage", note: "", orderDiscount: 0, shippingFee: 30_000, lines: [{ variantId: "erp-vtp-var", quantity: 2, unitPrice: 250_000, discount: 0 }] });
      assert.ok(made.ok, JSON.stringify(made));
      const orderId = made.id;

      // Chưa khai kết nối ⇒ khung hiện lời dẫn, không có nút tạo.
      const before = await carrierPanel(admin, orderId);
      assert.ok(before && !before.carriers.some((c) => c.ready) && before.connectionNote, JSON.stringify(before));
      assert.equal(await carrierPanel(viewer, orderId), null, "thiếu shipments:manage ⇒ không có khung");

      // Khai + kiểm tra (máy chủ giả) + bật — đúng đường của màn Kết nối.
      const vtp = fakeVtp({ create: "ok", nextNumber: 900000001 });
      const deps = { fetch: vtp.fetch };
      const saved = await saveConnection(admin, { connectorKey: "viettelpost-carrier", settings: { username: "0912345678", senderName: "Shop Thử", senderPhone: "0912345678", senderAddress: "34 Cửa Nam, Hoàn Kiếm, Hà Nội" }, secrets: { password: VTP_PASSWORD } });
      assert.ok("ok" in saved, JSON.stringify(saved));
      assert.ok("ok" in (await testOrgConnection(admin, "viettelpost-carrier", { tester: { fetch: vtp.fetch } })));
      assert.ok("ok" in (await setConnectionStatus(admin, "viettelpost-carrier", "ACTIVE")));
      const panel = await carrierPanel(admin, orderId);
      assert.ok(panel && panel.carriers.find((c) => c.key === "VTP")?.ready && !panel.carriers.find((c) => c.key === "GHN")?.ready && panel.connectionNote === null && panel.blockedReason === null, JSON.stringify(panel));
      assert.equal(panel.defaults.weightGrams, 600, "cân lấy từ mẫu mã × số lượng");
      assert.equal(panel.defaults.cod, 530_000, "thu hộ mặc định = khách còn phải trả (hàng + ship)");

      // Thiếu quyền ⇒ từ chối, không gọi hãng.
      const callsBefore = vtp.calls.length;
      assert.equal((await quoteShipmentCore(viewer, "VTP", orderId, { weightGrams: 600, cod: 530_000 }, deps)).ok, false);
      assert.equal(vtp.calls.length, callsBefore);

      const q = await quoteShipmentCore(admin, "VTP", orderId, { weightGrams: 600, cod: 530_000 }, deps);
      assert.ok(q.ok && q.quote.services[0].code === "PHS", JSON.stringify(q));

      // ── Tạo ⇒ đúng MỘT dòng shipments, chặng mặc định (lõi không ghi stage), mã ERP «-1» ──
      const c1 = await createShipmentCore(admin, "VTP", orderId, { weightGrams: 600, cod: 530_000, serviceCode: "PHS", note: "" }, deps);
      assert.ok(c1.ok && c1.trackingCode === "900000001", JSON.stringify(c1));
      const sent = vtp.calls.filter((x) => x.path === "order/createOrderNlp").at(-1)?.body;
      assert.ok(sent && sent.ORDER_PAYMENT === 3 && sent.CHECK_UNIQUE === true && sent.MONEY_COLLECTION === 530_000 && sent.ORDER_SERVICE === "PHS");
      assert.ok(!JSON.stringify(vtp.calls.map((x) => x.path)).includes(VTP_PASSWORD), "mật khẩu không bao giờ nằm trong URL");
      const rows1 = await db.select().from(schema.shipments).where(eq(schema.shipments.orderId, orderId));
      assert.equal(rows1.length, 1);
      const s1 = rows1[0];
      assert.ok(s1.trackingCode === "900000001" && s1.attemptNo === 1 && s1.direction === "OUTBOUND" && s1.stage === "PENDING" && s1.shippingFee === 16_500 && s1.codAmount === 530_000);
      assert.equal(s1.orderReference, sent.ORDER_NUMBER);
      assert.ok(String(s1.orderReference).endsWith("-1"));
      assert.equal(carrierCreateOf(s1.raw)?.state, "CREATED");

      // ── Bấm lần hai ⇒ bị chặn, KHÔNG gọi hãng ──
      const createCalls = vtp.count("order/createOrderNlp");
      const dup = await createShipmentCore(admin, "VTP", orderId, { weightGrams: 600, cod: 530_000, serviceCode: "PHS", note: "" }, deps);
      assert.ok(!dup.ok && dup.error.includes("lần gửi còn hiệu lực"), JSON.stringify(dup));
      assert.equal(vtp.count("order/createOrderNlp"), createCalls, "bị chặn trước khi gọi hãng");

      // ── Đơn đang có vận đơn ⇒ không sửa lặng lẽ ──
      const upd = await updateManualOrderCore(admin, orderId, { customerId: c.id, stage: "CONFIRMED", channel: "Fanpage", note: "đổi", orderDiscount: 0, shippingFee: 30_000, lines: [{ variantId: "erp-vtp-var", quantity: 3, unitPrice: 250_000, discount: 0 }] });
      assert.ok(!upd.ok && upd.code === "CONFLICT", JSON.stringify(upd));

      // ── In nhãn: link của chính hãng ──
      const pr = await printLinkCore(admin, s1.id, deps);
      assert.ok(pr.ok && pr.url === vtpPrintUrl("MA-IN-123="), JSON.stringify(pr));

      // ── Huỷ ở hãng ⇒ ghi lời nhận lệnh, KHÔNG tự đặt «Đã huỷ»; lần gửi mới mang mã «-2» ──
      const cx = await cancelShipmentCore(admin, s1.id, { reason: "Khách đổi địa chỉ" }, deps);
      assert.ok(cx.ok, JSON.stringify(cx));
      const [s1b] = await db.select().from(schema.shipments).where(eq(schema.shipments.id, s1.id));
      assert.equal(s1b.stage, "PENDING", "chặng chỉ đổi theo webhook 107");
      assert.equal(vtp.calls.filter((x) => x.path === "order/UpdateOrder").at(-1)?.body?.TYPE, 4);
      const c2 = await createShipmentCore(admin, "VTP", orderId, { weightGrams: 600, cod: 530_000, serviceCode: "VCN", note: "Gọi trước khi giao" }, deps);
      assert.ok(c2.ok, JSON.stringify(c2));
      const [s2] = await db.select().from(schema.shipments).where(and(eq(schema.shipments.orderId, orderId), eq(schema.shipments.attemptNo, 2)));
      assert.ok(s2 && String(s2.orderReference).endsWith("-2"), "mỗi lần gửi một mã ERP");
      assert.ok("ok" in (await cancelShipmentCore(admin, s2.id, { reason: "Thử nhánh từ chối" }, deps)));

      // ── Hãng TỪ CHỐI ⇒ chắc chắn không có vận đơn ⇒ không còn chỗ giữ ──
      vtp.calls.length = 0;
      const rejectMode = fakeVtp({ create: "reject", nextNumber: 0 });
      const rj = await createShipmentCore(admin, "VTP", orderId, { weightGrams: 600, cod: 530_000, serviceCode: "PHS", note: "" }, { fetch: rejectMode.fetch });
      assert.ok(!rj.ok && rj.error.includes("Địa chỉ người nhận không hợp lệ"), JSON.stringify(rj));
      assert.equal((await db.select().from(schema.shipments).where(eq(schema.shipments.orderId, orderId))).length, 2, "lượt bị từ chối không để lại dòng");

      // ── ĐỨT MẠNG giữa chừng ⇒ GIỮ chỗ (UNKNOWN), chặn tạo mới, không tự gửi lại ──
      const net = fakeVtp({ create: "network", nextNumber: 0 });
      const nw = await createShipmentCore(admin, "VTP", orderId, { weightGrams: 600, cod: 530_000, serviceCode: "PHS", note: "" }, { fetch: net.fetch });
      assert.ok(!nw.ok && nw.error.includes("Không rõ"), JSON.stringify(nw));
      assert.equal(net.count("order/createOrderNlp"), 1, "client không tự gửi lại lệnh tạo");
      const held = (await db.select().from(schema.shipments).where(eq(schema.shipments.orderId, orderId))).find((r) => carrierCreateOf(r.raw)?.state === "UNKNOWN");
      assert.ok(held && held.vtpOrderNumber === null);
      assert.equal((await createShipmentCore(admin, "VTP", orderId, { weightGrams: 600, cod: 530_000, serviceCode: "PHS", note: "" }, deps)).ok, false, "chỗ giữ không rõ kết quả chặn tạo mới");
      const panelHeld = await carrierPanel(admin, orderId);
      assert.ok(panelHeld?.attempts.find((a) => a.id === held.id)?.canDiscard);
      assert.ok((await discardCreateCore(admin, held.id)).ok);
      assert.equal((await db.select().from(schema.shipments).where(eq(schema.shipments.id, held.id))).length, 0);
      assert.equal((await discardCreateCore(admin, s1.id)).ok, false, "vận đơn có mã thì không «bỏ» được");

      // ── Client của tổ chức khác lọt vào ngữ cảnh này ⇒ ném TRƯỚC khi gọi mạng ──
      const stray = fakeVtp({ create: "ok", nextNumber: 1 });
      const foreign = VtpCarrierClient.fromOrgConnection({ organization: "to-chuc-khac", username: "x", password: VTP_PASSWORD }, { fetch: stray.fetch });
      await assert.rejects(() => foreign.quote({}), CredentialOwnerMismatchError);
      assert.equal(stray.calls.length, 0);

      // ── HÀNG LOẠT: đơn thiếu cân / chưa xác nhận bị BỎ QUA có lý do, đơn còn lại tạo qua đúng lõi một đơn ──
      await db.insert(schema.productVariants).values({ id: "erp-vtp-var-0g", productId: "erp-vtp-prod", sku: "DH-L", size: "L", retailPrice: 250_000, weight: 0 });
      const mk = async (variantId: string, stage: string) => {
        const r = await createManualOrderCore(admin, { customerId: c.id, stage, channel: "Fanpage", note: "", orderDiscount: 0, shippingFee: 0, lines: [{ variantId, quantity: 1, unitPrice: 250_000, discount: 0 }] });
        assert.ok(r.ok, JSON.stringify(r));
        return r.id;
      };
      const okId = await mk("erp-vtp-var", "CONFIRMED");
      const noWeightId = await mk("erp-vtp-var-0g", "CONFIRMED");
      const newId = await mk("erp-vtp-var", "NEW");
      const bulk = fakeVtp({ create: "ok", nextNumber: 700000001 });
      const bdeps = { fetch: bulk.fetch };
      assert.equal((await bulkQuoteCore(admin, "VTP", [noWeightId, newId], bdeps)).ok, false, "không đơn nào tạo được ⇒ không tra cước");
      const bq = await bulkQuoteCore(admin, "VTP", [noWeightId, newId, okId], bdeps);
      assert.ok(bq.ok && bq.sampleOrderId === okId, JSON.stringify(bq));
      const bc = await bulkCreateCore(admin, "VTP", [okId, noWeightId, newId, orderId], { serviceCode: "PHS" }, bdeps);
      assert.ok(bc.ok, JSON.stringify(bc));
      const byId = new Map(bc.rows.map((r) => [r.orderId, r]));
      assert.ok(byId.get(okId)?.ok && byId.get(okId)?.trackingCode === "700000001", JSON.stringify(bc.rows));
      assert.ok(!byId.get(noWeightId)?.ok && byId.get(noWeightId)?.message.includes("cân nặng"), "thiếu cân ⇒ bỏ qua, KHÔNG đoán");
      assert.ok(!byId.get(newId)?.ok && byId.get(newId)?.message.includes("Đã xác nhận"));
      // Đơn đầu bài: hai lần gửi đều đã được hãng nhận lệnh huỷ ⇒ không còn giữ đơn ⇒ lần gửi thứ BA, mã «-3».
      assert.ok(byId.get(orderId)?.ok && byId.get(orderId)?.trackingCode === "700000002", JSON.stringify(bc.rows));
      const [s3] = await db.select().from(schema.shipments).where(and(eq(schema.shipments.orderId, orderId), eq(schema.shipments.attemptNo, 3)));
      assert.ok(s3 && String(s3.orderReference).endsWith("-3"));
      assert.equal(bulk.count("order/createOrderNlp"), 2, "chỉ đơn đủ điều kiện mới gọi hãng");
      const again = await bulkCreateCore(admin, "VTP", [okId], { serviceCode: "PHS" }, bdeps);
      assert.ok(again.ok && !again.rows[0].ok && again.rows[0].message.includes("lần gửi còn hiệu lực"), "chạy lại lượt hàng loạt không đẻ vận đơn thứ hai");
      assert.equal(bulk.count("order/createOrderNlp"), 2);
      assert.equal((await bulkCreateCore(admin, "VTP", Array.from({ length: BULK_MAX + 1 }, (_, k) => `erp-x-${k}`), { serviceCode: "PHS" }, bdeps)).ok, false, "quá trần một lượt ⇒ từ chối cả lượt");
      // In: MỘT mã in cho mọi vận đơn ERP tạo còn in được — hai lần gửi đã có lệnh huỷ của đơn đầu bài KHÔNG in.
      const bp = await bulkPrintLinkCore(admin, "VTP", [okId, orderId, noWeightId], bdeps);
      assert.ok(bp.ok && bp.count === 2, JSON.stringify(bp));
      assert.deepEqual([...((bulk.calls.filter((x) => x.path === "order/printing-code").at(-1)?.body?.ORDER_ARRAY as string[]) ?? [])].sort(), ["700000001", "700000002"]);
      assert.equal((await bulkPrintLinkCore(viewer, "VTP", [okId], bdeps)).ok, false, "thiếu shipments:manage ⇒ từ chối");
    });
  } finally {
    if (savedKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = savedKey;
    await cleanupOrg(ORG);
  }
}

export async function testCarrierVtp() {
  testPure();
  await testTester();
  await testFlow();
  console.log("  ✓ POS tự chủ · Viettel Post: payload đúng tài liệu (byte, ORDER_PAYMENT, CHECK_UNIQUE), đọc đúng mẫu phản hồi; kiểm tra chỉ đăng nhập + đọc kho, không lộ mật khẩu; tạo ghi một dòng không tự ghi chặng, bấm hai lần không gọi hãng, đơn có vận đơn không sửa được, huỷ ⇒ lần gửi «-2», từ chối không để lại dòng, đứt mạng giữ chỗ tới khi người bỏ; client lạc tổ chức ném trước khi gọi mạng; hàng loạt bỏ qua đơn thiếu cân / chưa xác nhận có lý do, chạy lại không đẻ vận đơn, một mã in cho nhiều vận đơn");
}

/**
 * ═══════════ HỘP THƯ V2-B — «ĐƠN ĐANG CHỐT» Ở ĐẦU CỘT PHẢI ═══════════
 *
 *  · THUẦN `orderVerification`: từng ô (SĐT · địa chỉ · SKU · số lượng · giá) ở ba mức OK / CẦN KIỂM / THIẾU; bốn trạng thái đơn;
 *    mơ hồ (hai đơn đang mở) ⇒ CẦN XÁC THỰC; giá chưa biết ⇒ không OK; nút «Xác nhận & tạo đơn» tắt ĐÚNG khi lõi từ chối
 *    (`manualOrderGaps` rỗng ⇔ nút bật — đối chiếu trên cả một bảng người nhận, không chép luật).
 *  · HỢP ĐỒNG MÃ NGUỒN: panel chỉ gọi hai action có sẵn (đọc tóm tắt · `confirmOrderReviewAction`), không chạm lõi / CSDL; tệp thuần
 *    dùng lại validator của lõi (không regex SĐT riêng); bộ đọc là MỘT câu SQL; cột phải nhúng panel đúng một lần.
 *  · TỔ CHỨC THẬT `or-ib` (PGlite, tự cấp, tự dọn): đơn nháp bot ghi qua `createOrderAsAgent` ⇒ dòng hàng / tiền / địa chỉ tách ô;
 *    phí ship «CHƯA BÁO» ⇒ «—» (luật 42); xã chưa ghép ⇒ nút tắt và lõi cũng từ chối; hai đơn đang mở ⇒ CẦN XÁC THỰC; xác nhận qua lõi
 *    ⇒ ĐÃ XÁC NHẬN; quyền `ai_sales:view`; hội thoại khung thử / không có.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { WHOLESALE_BLUEPRINT } from "@/lib/blueprints/templates/wholesale";
import { manualOrderGaps } from "@/lib/constants/manual-orders";
import { reviewSeenOf, type OrderReviewEntry } from "@/lib/constants/order-review";
import { formatVND } from "@/lib/format";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { cancelManualOrderCore, confirmOrderReviewCore, createOrderAsAgent } from "@/lib/records/order-create";
import { itemFromJson, loadConversationOrderSummary } from "@/lib/sales-chatbot/order-summary";
import { orderConfirmButton, orderVerification, type ConversationOrderSummary, type OrderSummaryLine } from "@/lib/sales-chatbot/order-verification-shared";

const ORG = "or-ib";
const AGENT = { name: "Chatbot bán hàng", source: "lib/sales-chatbot/tools.ts" };

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

// ─────────────────────────── THUẦN ───────────────────────────

const line = (over: Partial<OrderSummaryLine> = {}): OrderSummaryLine => ({ sku: "CC-1KG", productName: "Chả cá thu", variation: "1kg", quantity: 1, unitPrice: 340_000, discount: 0, lineTotal: 340_000, isBonus: false, variantId: "v1", variantKnown: true, variantRemoved: false, ...over });
const mk = (over: Partial<ConversationOrderSummary> = {}): ConversationOrderSummary => ({
  orderId: "erp-x",
  shortCode: "X",
  stage: "NEW",
  stageLabel: "Mới",
  manual: true,
  byBot: true,
  insertedAt: "2026-10-10T01:00:00.000Z",
  hasShipment: false,
  recipient: { name: "Chị Nga", phone: "0919000808", address: "Số 7 ngõ Thử Nghiệm", province: "Hà Nội", district: "", ward: "Phường Hoàn Kiếm" },
  lines: [line()],
  itemsCount: 1,
  money: { goods: 340_000, discount: 0, shipping: 30_000, shippingNote: null, total: 370_000 },
  review: [],
  reconfirms: [],
  otherActive: 0,
  ...over,
});
const flag = (code: OrderReviewEntry["code"]): OrderReviewEntry => ({ code, note: "n", quote: code === "CUSTOMER_CANCELLED" ? "thôi không lấy" : null, at: "2026-10-10T02:00:00.000Z", by: "bot" });
const states = (s: ConversationOrderSummary) => {
  const v = orderVerification(s);
  return [v.state, v.fields.phone.state, v.fields.address.state, v.fields.sku.state, v.fields.qty.state, v.fields.price.state];
};

function testPure() {
  // Đủ thông tin.
  const ok = mk();
  assert.deepEqual(states(ok), ["ĐỦ THÔNG TIN", "OK", "OK", "OK", "OK", "OK"]);
  assert.deepEqual(orderConfirmButton(ok, orderVerification(ok), true), { show: true, enabled: true, reason: null, kind: "CONFIRM" }, "đơn nháp đủ ⇒ nút bật");
  assert.deepEqual(orderConfirmButton(ok, orderVerification(ok), false), { show: false }, "không có quyền sửa đơn ⇒ không nút");

  // SĐT.
  const noPhone = mk({ recipient: { ...ok.recipient, phone: "" } });
  assert.deepEqual(states(noPhone).slice(0, 2), ["CẦN XÁC THỰC", "THIẾU"]);
  assert.equal(orderVerification(noPhone).fields.phone.reason, "Chưa có SĐT");
  assert.equal(orderVerification(mk({ recipient: { ...ok.recipient, phone: "12345" } })).fields.phone.reason, "SĐT không hợp lệ (cần 8–15 chữ số)");
  const btnPhone = orderConfirmButton(noPhone, orderVerification(noPhone), true);
  assert.ok(btnPhone.show && !btnPhone.enabled && btnPhone.reason?.startsWith("SĐT:"), JSON.stringify(btnPhone));

  // Địa chỉ: thiếu · chưa ghép tỉnh · chưa ghép xã · cờ «địa chỉ chưa ghép» còn mở.
  assert.equal(orderVerification(mk({ recipient: { ...ok.recipient, address: "" } })).fields.address.reason, "Chưa có địa chỉ");
  assert.equal(orderVerification(mk({ recipient: { ...ok.recipient, address: "12" } })).fields.address.reason, "Địa chỉ quá ngắn (dưới 5 ký tự)");
  assert.equal(orderVerification(mk({ recipient: { ...ok.recipient, province: "" } })).fields.address.reason, "Chưa ghép được tỉnh / thành từ địa chỉ");
  const noWard = mk({ recipient: { ...ok.recipient, ward: "" } });
  assert.deepEqual(states(noWard).slice(0, 3), ["CẦN XÁC THỰC", "OK", "THIẾU"]);
  const btnWard = orderConfirmButton(noWard, orderVerification(noWard), true);
  assert.ok(btnWard.show && !btnWard.enabled && btnWard.reason?.includes("xã / phường"), "xã chưa ghép ⇒ nút tắt kèm lý do");
  const addrFlag = mk({ stage: "CONFIRMED", review: [flag("ADDRESS_UNRESOLVED")] });
  assert.deepEqual(states(addrFlag).slice(0, 3), ["CẦN XÁC THỰC", "OK", "CẦN KIỂM"], "đơn đã xác nhận còn cờ ⇒ CẦN XÁC THỰC");
  assert.deepEqual(orderConfirmButton(addrFlag, orderVerification(addrFlag), true), { show: true, enabled: true, reason: null, kind: "RESOLVE" }, "cờ còn mở ⇒ nút gỡ cờ (RESOLVE)");

  // Khách báo huỷ ⇒ người quyết, kể cả đơn đủ ô.
  const cancelled = mk({ review: [flag("CUSTOMER_CANCELLED")] });
  assert.equal(orderVerification(cancelled).state, "CẦN XÁC THỰC");
  assert.ok(orderVerification(cancelled).reasons[0].includes("khách báo huỷ"));

  // SKU: chưa nối mẫu mã · đã gỡ · trùng dòng · khai nhiều dòng hơn đọc được · không dòng nào.
  assert.equal(orderVerification(mk({ lines: [line({ variantId: null, variantKnown: false })] })).fields.sku.state, "THIẾU");
  assert.equal(orderVerification(mk({ manual: false, lines: [line({ variantId: null, variantKnown: false })] })).fields.sku.state, "CẦN KIỂM", "đơn đồng bộ: dòng chưa nối mẫu mã ERP là việc kiểm, không phải chặn");
  assert.equal(orderVerification(mk({ lines: [line({ variantRemoved: true })] })).fields.sku.reason, "Mẫu mã dòng 1 (CC-1KG) đã gỡ — không nhận đơn mới");
  assert.equal(orderVerification(mk({ lines: [line(), line()], itemsCount: 2 })).fields.sku.state, "CẦN KIỂM", "mẫu mã trùng dòng (manualOrderTotals)");
  assert.equal(orderVerification(mk({ itemsCount: 3 })).fields.sku.state, "CẦN KIỂM", "khai 3 dòng, đọc được 1");
  assert.deepEqual(states(mk({ lines: [], itemsCount: 0 })).slice(3), ["THIẾU", "THIẾU", "THIẾU"]);
  assert.deepEqual(states(mk({ lines: [], itemsCount: 2 })).slice(3), ["CẦN KIỂM", "CẦN KIỂM", "CẦN KIỂM"], "dòng hàng chưa đọc được ≠ đơn không có hàng");
  assert.equal(orderVerification(mk({ itemsCount: 0 })).fields.sku.state, "THIẾU", "lõi đếm items_count = 0 ⇒ từ chối");

  // Số lượng (cùng zod-trần của đường ghi).
  assert.equal(orderVerification(mk({ lines: [line({ quantity: 0 })] })).fields.qty.state, "THIẾU");
  assert.equal(orderVerification(mk({ lines: [line({ quantity: 1.5 })] })).fields.qty.state, "THIẾU");

  // Giá: chưa biết ⇒ THIẾU (không bao giờ OK); 0 ₫ dòng thường ⇒ CẦN KIỂM; 0 ₫ hàng tặng ⇒ OK; ship chưa báo / miễn ship có điều kiện.
  assert.equal(orderVerification(mk({ lines: [line({ unitPrice: null, lineTotal: null })] })).fields.price.state, "THIẾU");
  assert.equal(orderVerification(mk({ lines: [line({ unitPrice: 0, lineTotal: 0 })] })).fields.price.state, "CẦN KIỂM");
  assert.equal(orderVerification(mk({ lines: [line(), line({ variantId: "v2", unitPrice: 0, lineTotal: 0, isBonus: true })], itemsCount: 2 })).fields.price.state, "OK");
  const shipUnknown = mk({ money: { goods: 340_000, discount: 0, shipping: null, shippingNote: "UNKNOWN", total: null } });
  assert.deepEqual([orderVerification(shipUnknown).state, orderVerification(shipUnknown).fields.price.state, orderVerification(shipUnknown).fields.price.reason], ["CẦN XÁC THỰC", "CẦN KIỂM", "Phí ship chưa báo — tổng tiền chưa biết"]);
  assert.deepEqual(orderConfirmButton(shipUnknown, orderVerification(shipUnknown), true), { show: true, enabled: true, reason: null, kind: "CONFIRM" }, "CẦN KIỂM không chặn — lõi nhận, người kiểm rồi bấm");
  assert.equal(orderVerification(mk({ money: { goods: 340_000, discount: 0, shipping: 0, shippingNote: "FREE_IF_AREA", total: 340_000 } })).fields.price.state, "CẦN KIỂM");

  // Mơ hồ: hội thoại có hai đơn đang mở ⇒ CẦN XÁC THỰC (không đoán đơn nào là đơn đang chốt).
  assert.equal(orderVerification(mk({ otherActive: 1 })).state, "CẦN XÁC THỰC");

  // Đã xác nhận · đã tạo đơn.
  const confirmed = mk({ stage: "CONFIRMED" });
  assert.equal(orderVerification(confirmed).state, "ĐÃ XÁC NHẬN");
  assert.deepEqual(orderConfirmButton(confirmed, orderVerification(confirmed), true), { show: false }, "đã xác nhận, không cờ ⇒ không còn gì để bấm (lõi cũng không ghi gì)");
  assert.equal(orderVerification(mk({ stage: "CONFIRMED", recipient: { ...ok.recipient, ward: "" } })).state, "ĐÃ XÁC NHẬN", "người đã chốt: giữ kết luận, ô thiếu vẫn tô");
  assert.equal(orderVerification(mk({ stage: "CONFIRMED", hasShipment: true })).state, "ĐÃ TẠO ĐƠN");
  assert.equal(orderVerification(mk({ stage: "SHIPPED" })).state, "ĐÃ TẠO ĐƠN");
  assert.equal(orderVerification(mk({ manual: false })).state, "ĐÃ TẠO ĐƠN", "đơn đồng bộ đã nằm ở nguồn");
  assert.deepEqual(orderConfirmButton(mk({ manual: false }), orderVerification(mk({ manual: false })), true), { show: false });

  // GƯƠNG CỦA LÕI: trên cả một bảng người nhận, nút bật ⇔ `manualOrderGaps` rỗng (đúng điều kiện `confirmOrderReviewCore` từ chối).
  const phones = ["", "0919000808", "1234567", "+84 919 000 808", "0919.000.808"];
  const addresses = ["", "12", "Số 7 ngõ Thử Nghiệm"];
  const provinces = ["", "Hà Nội"];
  const wards = ["", "Phường Hoàn Kiếm"];
  for (const phone of phones)
    for (const address of addresses)
      for (const province of provinces)
        for (const ward of wards) {
          const s = mk({ recipient: { ...ok.recipient, phone, address, province, ward } });
          const b = orderConfirmButton(s, orderVerification(s), true);
          assert.ok(b.show);
          assert.equal(b.enabled, manualOrderGaps({ phone, address, province, ward }, 1).length === 0, `nút ⇔ lõi: ${JSON.stringify({ phone, address, province, ward })}`);
        }

  // Đọc dòng hàng JSON phòng thủ: thiếu trường ⇒ chưa biết (null), không 0.
  assert.deepEqual(itemFromJson({ sku: "A", quantity: 2 }).unitPrice, null);
  assert.equal(itemFromJson({ unitPrice: "180000" }).unitPrice, 180_000);
  assert.equal(itemFromJson(null).variantKnown, false);
}

// ─────────────────────────── HỢP ĐỒNG MÃ NGUỒN ───────────────────────────

function testSourceContract() {
  const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const panel = read("app/(dashboard)/ai/sales-chatbot/inbox/order-panel.tsx");
  const actionImports = [...panel.matchAll(/import \{([^}]*)\} from "@\/lib\/actions\/([^"]+)"/g)].flatMap((m) => m[1].split(",").map((x) => `${m[2]}:${x.trim()}`)).filter((x) => !x.endsWith(":")).sort();
  assert.deepEqual(actionImports, ["inbox-order-panel:inboxOrderSummaryAction", "manual-orders:confirmOrderReviewAction"], "panel chỉ gọi action đọc tóm tắt + action xác nhận CÓ SẴN");
  assert.ok(panel.includes("confirmOrderReviewAction(summary.orderId, reviewSeenOf(summary.review))"), "xác nhận gửi kèm dấu vết lý do đã thấy (#675 M1)");
  assert.ok(!/from "@\/lib\/records\//.test(panel) && !/from "@\/db"/.test(panel) && !/^import \{[^}]*\} from "@\/lib\/queries\//m.test(panel), "client component không chạm lõi / CSDL / truy vấn");
  assert.ok(panel.includes("IntersectionObserver"), "tải lười: chỉ hỏi máy chủ khi khối hiện trên màn hình");

  const shared = read("lib/sales-chatbot/order-verification-shared.ts");
  assert.ok(/import \{[^}]*manualOrderGaps[^}]*manualOrderTotals[^}]*\} from "@\/lib\/constants\/manual-orders"/.test(shared), "dùng lại validator của lõi đơn");
  assert.ok(/quickConfirmKind/.test(shared), "nút có / không theo cùng phân nhánh với lõi");
  assert.ok(!shared.includes("\\D/g") && !/digits\.length/.test(shared), "không có luật SĐT thứ hai");
  assert.ok(!/from "@\/db"|from "@\/lib\/records\/|from "@\/lib\/queries\/|from "drizzle-orm"/.test(shared), "tệp thuần, client-safe");

  const loader = read("lib/sales-chatbot/order-summary.ts");
  const body = loader.slice(loader.indexOf("export async function loadConversationOrderSummary"));
  assert.equal((body.match(/await db\b/g) ?? []).length, 1, "MỘT câu SQL cho mỗi hội thoại (không N+1)");
  assert.ok(!/\bfor\s*\(/.test(body), "không vòng lặp truy vấn");
  assert.ok(body.includes('"orders"."id"') && !/= \$\{o\.id\}/.test(body), "câu con tương quan viết tên cột tường minh");
  assert.ok(body.includes('can(user, "ai_sales:view")'), "đọc cần quyền xem hội thoại");

  const action = read("lib/actions/inbox-order-panel.ts");
  assert.ok(action.startsWith('"use server"') && action.includes("requireUser()") && !/\.insert\(|\.update\(|\.delete\(/.test(action), "action chỉ đọc, có phiên");

  const thread = read("app/(dashboard)/ai/sales-chatbot/inbox/thread-view.tsx");
  assert.equal((thread.match(/<InboxOrderPanel /g) ?? []).length, 1, "cột phải nhúng panel đúng một lần");
  const aside = thread.slice(thread.indexOf('data-testid="inbox-side"'));
  assert.ok(aside.indexOf("<InboxOrderPanel") < aside.indexOf("<CustomerHistoryCard"), "đơn đang chốt đứng TRÊN thông tin khách");
}

// ─────────────────────────── TỔ CHỨC THẬT ───────────────────────────

async function testOrg() {
  await cleanupOrg(ORG);
  const modules = [...WHOLESALE_BLUEPRINT.modules.filter((m) => m !== "core" && m !== "work"), "ai_sales"];
  await provisionOrganization({ code: ORG, name: "Thử panel đơn hộp thư", plan: "standard", modules, admin: { email: `admin@${ORG}.local`, name: "QT hộp thư", password: "HopThu@12345" }, source: "TEST", actor: null });
  try {
    const enabled = await getEnabledModules(ORG);
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const org = { code: ORG, name: "Thử panel đơn hộp thư", isHome: false };
      const admin: SessionUser = { id: u.id, email: u.email, name: "QT hộp thư", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: org, modules: [...enabled] };
      const noView: SessionUser = { ...admin, role: "MANAGER", permissions: ["orders:read"] };

      const [cust] = await db.insert(schema.customers).values({ name: "Chị Nga", phone: "0942000242", address: "9 đường Thí Điểm", province: "Hải Phòng" }).returning({ id: schema.customers.id });
      await db.insert(schema.products).values({ id: "erp-ib-prod", name: "Chả cá thu", raw: { origin: "ERP_MANUAL" } });
      await db.insert(schema.productVariants).values([
        { id: "erp-ib-1kg", productId: "erp-ib-prod", sku: "CC-1KG", size: "1kg", retailPrice: 340_000 },
        { id: "erp-ib-500", productId: "erp-ib-prod", sku: "CC-500G", size: "500g", retailPrice: 180_000 },
      ]);
      const opts = { pricing: "RETAIL" as const, allowShortStock: true };
      const input = (address: string, shippingFee: number, note = "") => ({
        customerId: cust.id,
        stage: "NEW" as const,
        lines: [
          { variantId: "erp-ib-1kg", quantity: 1, unitPrice: 340_000, discount: 0 },
          { variantId: "erp-ib-500", quantity: 2, unitPrice: 180_000, discount: 0 },
        ],
        orderDiscount: 0,
        shippingFee,
        note,
        channel: "Chatbot web",
        recipient: { name: "Chị Nga", phone: "0919.000.808", address, province: "" },
      });
      const newConv = async (channel = "WEB") => (await db.insert(schema.salesChatConversations).values({ channel }).returning({ id: schema.salesChatConversations.id }))[0].id;
      const load = async (conv: string, who: SessionUser = admin) => {
        const r = await loadConversationOrderSummary(who, conv);
        assert.ok(r.ok, JSON.stringify(r));
        return r.summary;
      };

      // ① Đơn nháp bot ghi (nối qua `draft_order_id` như engine ghi) ⇒ dòng hàng, tiền, địa chỉ tách ô, ĐỦ THÔNG TIN.
      const conv1 = await newConv();
      const draft = await createOrderAsAgent(AGENT, input("Số 7 ngõ Thử Nghiệm, Phường Hoàn Kiếm, Hà Nội", 30_000), opts);
      assert.ok(draft.ok, JSON.stringify(draft));
      await db.update(schema.salesChatConversations).set({ draftOrderId: draft.id }).where(eq(schema.salesChatConversations.id, conv1));
      const s1 = await load(conv1);
      assert.ok(s1);
      assert.equal(s1.orderId, draft.id);
      assert.deepEqual(
        s1.lines.map((l) => [l.sku, l.productName, l.variation, l.quantity, l.unitPrice, l.lineTotal, l.variantKnown]),
        [
          ["CC-1KG", "Chả cá thu", "1kg", 1, 340_000, 340_000, true],
          ["CC-500G", "Chả cá thu", "500g", 2, 180_000, 360_000, true],
        ],
        "dòng hàng đọc NGUYÊN từ order_items (giá đơn đã ghi)",
      );
      assert.deepEqual(s1.money, { goods: 700_000, discount: 0, shipping: 30_000, shippingNote: null, total: 730_000 });
      assert.equal(s1.recipient.phone, "0919000808", "SĐT dạng lõi đã chuẩn hoá");
      assert.equal(s1.recipient.address, "Số 7 ngõ Thử Nghiệm, Phường Hoàn Kiếm, Hà Nội", "địa chỉ chi tiết = dòng khách gửi");
      assert.ok(s1.recipient.province && s1.recipient.ward, `tỉnh + xã như lõi đã ghép: ${JSON.stringify(s1.recipient)}`);
      assert.equal(s1.recipient.district, "", "địa giới mới không có cấp huyện — không bịa");
      assert.deepEqual([s1.manual, s1.byBot, s1.hasShipment, s1.otherActive], [true, false, false, 0]);
      assert.equal(orderVerification(s1).state, "ĐỦ THÔNG TIN");

      // Quyền: thiếu `ai_sales:view` ⇒ không đọc.
      const denied = await loadConversationOrderSummary(noView, conv1);
      assert.ok(!denied.ok && denied.error.includes("ai_sales:view"));

      // ② Phí ship «CHƯA BÁO» (bot ghi 0 kèm dòng ghi chú) + xã chưa ghép ⇒ «—», nút tắt, lõi cũng từ chối.
      const conv2 = await newConv();
      const unknownShip = await createOrderAsAgent(AGENT, input("số 2 ngách 4 ngõ Giả, Hoàn Kiếm, Hà Nội", 0, "Phí ship: CHƯA BÁO — nhân viên cập nhật trước khi giao."), { ...opts, idempotencyKey: "ib-ship" });
      assert.ok(unknownShip.ok, JSON.stringify(unknownShip));
      await db.update(schema.orders).set({ salesConversationId: conv2 }).where(eq(schema.orders.id, unknownShip.id));
      const s2 = await load(conv2);
      assert.ok(s2);
      assert.deepEqual([s2.money.shipping, s2.money.total, s2.money.goods], [null, null, 700_000], "ship chưa báo ⇒ chưa biết, không 0");
      assert.deepEqual([formatVND(s2.money.shipping), formatVND(s2.money.total)], ["—", "—"], "in «—» (luật 42)");
      assert.equal(s2.recipient.ward, "", "chỉ có quận cũ ⇒ xã để trống (không đoán)");
      const v2 = orderVerification(s2);
      assert.deepEqual([v2.state, v2.fields.address.state, v2.fields.price.state], ["CẦN XÁC THỰC", "THIẾU", "CẦN KIỂM"]);
      const b2 = orderConfirmButton(s2, v2, true);
      assert.ok(b2.show && !b2.enabled && b2.reason?.includes("xã / phường"), JSON.stringify(b2));
      const core2 = await confirmOrderReviewCore(admin, s2.orderId, reviewSeenOf(s2.review));
      assert.ok(!core2.ok && core2.code === "CONFLICT" && core2.errors.some((e) => e.message.includes("xã / phường")), `nút tắt ⇔ lõi từ chối: ${JSON.stringify(core2)}`);

      // ③ Hội thoại chưa có đơn ⇒ null; khung thử / không có ⇒ lỗi đọc được.
      assert.equal(await load(await newConv()), null);
      const test = await loadConversationOrderSummary(admin, await newConv("TEST"));
      assert.ok(!test.ok, "khung thử không phải hộp thư");
      assert.ok(!(await loadConversationOrderSummary(admin, "khong-co")).ok);
      assert.ok(!(await loadConversationOrderSummary(admin, 42)).ok);

      // ④ Hai đơn đang mở trên cùng hội thoại ⇒ panel hiện đơn MỚI NHẤT, báo còn đơn khác, CẦN XÁC THỰC.
      const second = await createOrderAsAgent(AGENT, input("Số 7 ngõ Thử Nghiệm, Phường Hoàn Kiếm, Hà Nội", 30_000), { ...opts, idempotencyKey: "ib-second" });
      assert.ok(second.ok);
      await db.update(schema.orders).set({ salesConversationId: conv1, insertedAt: new Date(Date.now() + 60_000) }).where(eq(schema.orders.id, second.id));
      const s4 = await load(conv1);
      assert.ok(s4);
      assert.deepEqual([s4.orderId, s4.otherActive, orderVerification(s4).state], [second.id, 1, "CẦN XÁC THỰC"]);
      // Huỷ đơn thừa (lõi huỷ) ⇒ còn một đơn ⇒ đơn nháp ban đầu, đủ thông tin.
      assert.ok((await cancelManualOrderCore(admin, second.id, { reason: "Trùng đơn" })).ok);
      const s5 = await load(conv1);
      assert.ok(s5);
      assert.deepEqual([s5.orderId, s5.otherActive, orderVerification(s5).state], [draft.id, 0, "ĐỦ THÔNG TIN"]);

      // ⑤ Bấm «Xác nhận & tạo đơn» = lõi có sẵn ⇒ ĐÃ XÁC NHẬN; nút biến mất (không còn gì để xác nhận).
      const confirmed = await confirmOrderReviewCore(admin, s5.orderId, reviewSeenOf(s5.review));
      assert.ok(confirmed.ok, JSON.stringify(confirmed));
      const s6 = await load(conv1);
      assert.ok(s6);
      assert.deepEqual([s6.stage, orderVerification(s6).state, orderConfirmButton(s6, orderVerification(s6), true).show], ["CONFIRMED", "ĐÃ XÁC NHẬN", false]);
    });
  } finally {
    await cleanupOrg(ORG);
  }
}

export async function testInboxOrderPanel() {
  testPure();
  testSourceContract();
  await testOrg();
  console.log("  ✓ hộp thư V2-B «Đơn đang chốt»: dòng hàng / tiền / địa chỉ tách ô đọc từ đơn bot ghi (một câu SQL); ship chưa báo ⇒ «—»; kiểm từng ô theo validator của lõi (nút ⇔ manualOrderGaps); hai đơn mở ⇒ CẦN XÁC THỰC; xác nhận qua confirmOrderReviewCore ⇒ ĐÃ XÁC NHẬN; panel chỉ gọi action có sẵn, tải lười");
}

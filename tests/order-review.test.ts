/**
 * ═══════════ ĐƠN CẦN NGƯỜI KIỂM + LỜI XÁC NHẬN + SĐT CHUẨN HOÁ (chủ shop quyết 08/10/2026 · review độc lập #664) ═══════════
 *
 * Tổ chức THẬT `or-rv` (không Pancake; tự cấp, tự dọn):
 *  · `mark_declined` khi hội thoại đã có đơn ⇒ KHÔNG đổi stage, ghi chú «khách huỷ» (nguyên văn + mốc) + cờ CẦN NGƯỜI KIỂM,
 *    nhật ký `ORDER_REVIEW_FLAG`; câu y hệt gửi lại ⇒ không thêm dòng; công tắc «đơn đủ thông tin» không nâng đơn khách đã huỷ;
 *  · MÁY chốt khi xã chưa ghép ⇒ vẫn «Đã xác nhận», kèm cờ «địa chỉ chưa ghép»;
 *  · nút nhanh «Xác nhận đơn» đi ĐÚNG đường sửa đơn (quyền `orders:write`, sự kiện `order.confirmed`, gỡ cờ trong cùng lượt ghi,
 *    bấm hai lần không ghi thêm); đơn đã xác nhận còn cờ ⇒ chỉ gỡ cờ; «Huỷ đơn» = lõi huỷ đơn tay, gỡ cờ với hành động CANCELLED;
 *  · lọc «Cần người kiểm» ở danh sách đơn + con số trên nhãn;
 *  · SĐT người nhận lưu dạng chuẩn hoá ở ĐƯỜNG GHI.
 * Review độc lập #675: dấu vết lý do đã thấy (bot gắn «khách huỷ» sau khi trang dựng ⇒ từ chối, cả nhánh chốt lẫn gỡ cờ); lưu form
 * song song với gắn cờ ⇒ cờ còn; đơn thiếu xã ⇒ không chốt nhanh; khách huỷ đơn ĐÃ xác nhận ⇒ báo người; khách đồng ý lại ⇒ vết.
 * Phần thuần: `quotedInText` (≥ 2 chữ / số sau gấp dấu, ranh giới từ), các hàm `order-review.ts`; hợp đồng mã nguồn: nút nhanh
 * chỉ gọi hai server action có sẵn, lõi xác nhận không tự ghi stage.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { WHOLESALE_BLUEPRINT } from "@/lib/blueprints/templates/wholesale";
import { AUTO_CONFIRM_COMPLETE_SETTING_KEY } from "@/lib/constants/manual-orders";
import { orderReviewLogOf, orderReviewOf, quickConfirmKind, reconfirmsSinceOpen, reviewCodes, reviewFromValue, reviewSeenOf, unseenReviewEntries, withCustomerReconfirm, withReviewEntry, withReviewResolved, type OrderReviewEntry } from "@/lib/constants/order-review";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { listOrders, ORDER_SORTABLE, orderNeedsReviewCount } from "@/lib/queries/orders";
import { cancelManualOrderCore, canonicalRecipientPhone, confirmOrderReviewCore, createOrderAsAgent, flagOrderForReviewAsAgent, manualOrderFormValues, updateManualOrderCore, updateOrderAsAgent } from "@/lib/records/order-create";
import { parseSalesChatbotConfig } from "@/lib/sales-chatbot/config";
import { quotedInText } from "@/lib/sales-chatbot/text";
import { executeTool, type ChatState } from "@/lib/sales-chatbot/tools";
import { parseListParams } from "@/lib/search-params";
import { setSettingJson } from "@/lib/settings";
import { clearMemo } from "@/lib/cache";

const ORG = "or-rv";
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

const codeOf = (r: { ok: true } | { ok: false; code: string }) => (r.ok ? "OK" : r.code);

// ─────────────────────────── THUẦN ───────────────────────────

function testPure() {
  // Lời xác nhận: ≥ 2 chữ / số SAU gấp dấu + NFC, khớp theo RANH GIỚI TỪ.
  assert.equal(quotedInText("??", "??"), false, "chỉ dấu câu gấp ra rỗng ⇒ không phải lời đồng ý");
  assert.equal(quotedInText("...", "... ok"), false);
  assert.equal(quotedInText("👍👍", "👍👍"), false, "emoji gấp ra rỗng");
  assert.equal(quotedInText("ừ", "ừ"), false, "«ừ» một chữ sau gấp dấu");
  assert.equal(quotedInText("ừ".normalize("NFD"), "ừ"), false, "«ừ» dạng tổ hợp NFD (3 ký tự thô) vẫn chỉ một chữ");
  assert.equal(quotedInText("on", "không lấy đâu"), false, "«on» không khớp chuỗi con giữa từ «không»");
  assert.equal(quotedInText("ok", "okie để chị xem"), false, "«ok» không khớp «okie»");
  assert.equal(quotedInText("ok chốt", "Ok chốt đơn nhé em"), true, "đoạn nguyên văn theo ranh giới từ, bỏ dấu");
  assert.equal(quotedInText("chot di", "ok e oi chot di"), true);
  assert.equal(quotedInText("ok", "ok"), true, "«ok» hai chữ — luật hai chữ, không phải luật nghĩa");
  assert.equal(quotedInText("giao luôn", "ừ được em, giao luôn đi"), true);
  assert.equal(quotedInText("đồng ý", "để tôi hỏi vợ đã"), false, "model bịa lời đồng ý");

  // Cờ cần kiểm: thêm / trùng / gỡ / đọc lại.
  const e = (code: OrderReviewEntry["code"], quote: string | null = null): OrderReviewEntry => ({ code, note: "n", quote, at: "2026-10-08T01:00:00.000Z", by: "bot" });
  const base = { origin: "ERP_MANUAL", orderDiscount: 0, createdBy: null };
  const a = withReviewEntry(base, e("CUSTOMER_CANCELLED", "thôi không lấy"));
  assert.ok(a.changed);
  assert.deepEqual(reviewCodes(orderReviewOf(a.raw)), ["CUSTOMER_CANCELLED"]);
  assert.equal(withReviewEntry(a.raw, e("CUSTOMER_CANCELLED", "thôi không lấy")).changed, false, "câu khách y hệt ⇒ không thêm");
  const b = withReviewEntry(a.raw, e("CUSTOMER_CANCELLED", "huỷ giúp chị"));
  assert.equal(orderReviewOf(b.raw)?.entries.length, 2, "câu khách khác ⇒ một lời khai mới có mốc");
  const c = withReviewEntry(withReviewEntry(b.raw, e("ADDRESS_UNRESOLVED")).raw, e("ADDRESS_UNRESOLVED"));
  assert.deepEqual(reviewCodes(orderReviewOf(c.raw)), ["ADDRESS_UNRESOLVED", "CUSTOMER_CANCELLED"], "địa chỉ chưa ghép chỉ giữ một dòng");
  const r = withReviewResolved(c.raw, { action: "CANCELLED", at: "2026-10-08T02:00:00.000Z", byUserId: "u1", byName: "QT" });
  assert.ok(r.changed && orderReviewOf(r.raw) === null && r.resolved.length === 3);
  assert.deepEqual(orderReviewLogOf(r.raw).map((x) => [x.action, x.byUserId, x.entries.length]), [["CANCELLED", "u1", 3]], "lượt kiểm vào vết, quy kết bằng khoá tài khoản");
  assert.equal(withReviewResolved(r.raw, { action: "CONFIRMED", at: "x", byUserId: null, byName: "" }).changed, false, "không cờ ⇒ không ghi");
  assert.equal(r.raw.origin, "ERP_MANUAL", "lời khai gốc giữ nguyên");
  assert.equal(reviewFromValue(null), null);
  assert.equal(reviewFromValue({ entries: [{ code: "LA", note: "" }] }), null, "mã lạ bị bỏ — không bịa cờ");
  // Dấu vết đã thấy: lý do mới hơn mốc đã thấy, hoặc nhiều hơn số đã thấy ⇒ chưa thấy.
  const two = orderReviewOf(b.raw);
  assert.deepEqual(unseenReviewEntries(two, reviewSeenOf(two?.entries ?? [])), [], "thấy đủ ⇒ không còn gì mới");
  assert.equal(unseenReviewEntries(two, reviewSeenOf([])).length, 2, "trang dựng lúc chưa cờ ⇒ mọi lý do là mới");
  assert.equal(unseenReviewEntries(two, { count: 1, latestAt: "2026-10-08T01:00:00.000Z" }).length, 1, "cùng mốc nhưng thêm lý do ⇒ còn một lý do chưa thấy");
  // Khách xác nhận lại: một dòng vết, không gỡ cờ, câu y hệt không ghi lại; không cờ «khách huỷ» ⇒ không ghi.
  const rc = withCustomerReconfirm(a.raw, { at: "2026-10-08T03:00:00.000Z", byName: "bot", quote: "ok giao em" });
  assert.ok(rc.changed && orderReviewOf(rc.raw) !== null && reconfirmsSinceOpen(rc.raw).length === 1);
  assert.equal(withCustomerReconfirm(rc.raw, { at: "2026-10-08T03:05:00.000Z", byName: "bot", quote: "ok giao em" }).changed, false);
  assert.equal(withCustomerReconfirm(base, { at: "x", byName: "bot", quote: "ok" }).changed, false);
  assert.deepEqual([quickConfirmKind("NEW", false), quickConfirmKind("WAITING", true), quickConfirmKind("CONFIRMED", true), quickConfirmKind("CONFIRMED", false), quickConfirmKind("CANCELLED", true)], ["CONFIRM", "CONFIRM", "RESOLVE", null, null]);
}

// ─────────────────────────── HỢP ĐỒNG MÃ NGUỒN ───────────────────────────

function testSourceContract() {
  const quick = readFileSync("components/orders/order-review-quick.tsx", "utf8");
  const imports = [...quick.matchAll(/import \{([^}]*)\} from "@\/lib\/actions\/manual-orders"/g)].flatMap((m) => m[1].split(",").map((x) => x.trim())).filter(Boolean).sort();
  assert.deepEqual(imports, ["cancelManualOrderAction", "confirmOrderReviewAction"], "nút nhanh chỉ gọi hai server action đơn tay có sẵn");
  assert.ok(!/from "@\/lib\/records\//.test(quick) && !/from "@\/db"/.test(quick), "client component không chạm lõi / CSDL");
  const core = readFileSync("lib/records/order-create.ts", "utf8").replace(/\r\n/g, "\n");
  const start = core.indexOf("export async function confirmOrderReviewCore");
  const body = core.slice(start, core.indexOf("\n}\n", start));
  assert.ok(start > 0 && body.includes("manualOrderGate(user)") && body.includes("updateOrder(w, row.id"), "xác nhận nhanh: cổng sửa đơn + ĐÚNG đường sửa đơn");
  assert.ok(!/stage:\s*"CONFIRMED",\s*status/.test(body), "lõi xác nhận nhanh không tự ghi stage — không có đường đổi trạng thái thứ hai");
  const tools = readFileSync("lib/sales-chatbot/tools.ts", "utf8").replace(/\r\n/g, "\n");
  const ds = tools.indexOf('case "mark_declined"');
  const declined = tools.slice(ds, tools.indexOf("\n    }\n", ds));
  assert.ok(declined.includes("flagOrderForReviewAsAgent") && !/cancelManualOrder|cancelOrder\(/.test(declined), "mark_declined ghi cờ, không gọi đường huỷ");
  assert.equal((tools.match(/quotedInText\(/g) ?? []).length, 3, "ba chỗ kiểm lời trích dùng chung một hàm");
  assert.ok(!/foldVi\(ctx\.lastUserText\)\.includes/.test(tools), "không còn phép so chuỗi con cũ");
}

// ─────────────────────────── TỔ CHỨC THẬT ───────────────────────────

async function testOrg() {
  await cleanupOrg(ORG);
  const modules = WHOLESALE_BLUEPRINT.modules.filter((m) => m !== "core" && m !== "work");
  await provisionOrganization({ code: ORG, name: "Thử đơn cần kiểm", plan: "standard", modules, admin: { email: `admin@${ORG}.local`, name: "QT kiểm đơn", password: "DonHang@12345" }, source: "TEST", actor: null });
  try {
    const enabled = await getEnabledModules(ORG);
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const org = { code: ORG, name: "Thử đơn cần kiểm", isHome: false };
      const admin: SessionUser = { id: u.id, email: u.email, name: "QT kiểm đơn", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: org, modules: [...enabled] };
      const viewer: SessionUser = { ...admin, role: "MANAGER", permissions: ["orders:read"] };

      const [cust] = await db.insert(schema.customers).values({ name: "Chị Nga", phone: "0942000242", address: "9 đường Thí Điểm", province: "Hải Phòng" }).returning({ id: schema.customers.id });
      await db.insert(schema.products).values({ id: "erp-rv-prod", name: "Chả cá thu", raw: { origin: "ERP_MANUAL" } });
      await db.insert(schema.productVariants).values({ id: "erp-rv-var", productId: "erp-rv-prod", sku: "CC-1KG", size: "1kg", retailPrice: 340_000 });
      const [rc0] = await db.insert(schema.stockReceipts).values({ kind: "RECEIPT", receivedAt: new Date(), reference: "PN-RV", totalQuantity: 100, createdBy: u.email }).returning({ id: schema.stockReceipts.id });
      await db.insert(schema.stockReceiptItems).values({ receiptId: rc0.id, variantId: "erp-rv-var", quantity: 100, unitCost: 200_000 });
      const opts = { pricing: "RETAIL" as const, allowShortStock: true };
      const input = (stage: "NEW" | "CONFIRMED", address: string, phone = "0919.000.808") => ({ customerId: cust.id, stage, lines: [{ variantId: "erp-rv-var", quantity: 1, unitPrice: 340_000, discount: 0 }], orderDiscount: 0, shippingFee: 30_000, note: "", channel: "Chatbot web", recipient: { name: "Chị Nga", phone, address, province: "" } });
      const row = async (id: string) => {
        const [r] = await db.select({ stage: schema.orders.stage, raw: schema.orders.raw, shipPhone: schema.orders.shipPhone, shipCommune: schema.orders.shipCommune }).from(schema.orders).where(eq(schema.orders.id, id));
        return r;
      };
      const auditCount = async (action: string, id: string) => (await db.select({ id: schema.auditLogs.id }).from(schema.auditLogs).where(and(eq(schema.auditLogs.action, action), eq(schema.auditLogs.entityId, id)))).length;
      const confirmedEvents = async (id: string) => (await db.select({ id: schema.domainEvents.id }).from(schema.domainEvents).where(and(eq(schema.domainEvents.name, "order.confirmed"), eq(schema.domainEvents.subjectId, id)))).length;

      // ① SĐT chuẩn hoá ở đường ghi: khách gõ «0919.000.808» ⇒ đơn lưu «0919000808».
      const draft = await createOrderAsAgent(AGENT, input("NEW", "Số 7 ngõ Thử Nghiệm, Phường Hoàn Kiếm, Hà Nội"), opts);
      assert.ok(draft.ok, JSON.stringify(draft));
      const d0 = await row(draft.id);
      assert.equal(d0.shipPhone, "0919000808", "SĐT người nhận lưu dạng chuẩn hoá — không còn dấu chấm khách gõ");
      assert.ok(d0.shipCommune, "địa chỉ có phường ⇒ đã ghép được xã");
      assert.equal(orderReviewOf(d0.raw), null, "đơn bình thường không mang cờ");

      // ② mark_declined: đơn còn, stage không đổi, ghi chú «khách huỷ» nguyên văn + cờ; gửi lại y hệt ⇒ không thêm.
      const st: ChatState = { customer: { id: cust.id, name: "Chị Nga", phone: "0919000808", address: "x", province: "", simulated: false }, draft: { orderId: draft.id, lines: [{ variantId: "erp-rv-var", quantity: 1 }], unitPrices: { "erp-rv-var": 340_000 }, recipient: { name: "Chị Nga", phone: "0919000808", address: "x", province: "" }, note: "", simulated: false } };
      const tctx = (state: ChatState, last: string) => ({ conversationId: "conv-rv", channel: "WEB" as const, config: parseSalesChatbotConfig(null), state, lastUserText: last, agent: AGENT });
      const dec = await executeTool("mark_declined", { reason: "Khách đổi ý sau tóm tắt" }, tctx(st, "thôi em ơi chị không lấy nữa nhé"));
      assert.ok(!dec.isError && dec.state.stage === "DECLINED", dec.content);
      assert.ok(JSON.parse(dec.content).order_flagged?.length === 1, `báo cho model đơn đã chờ người kiểm: ${dec.content}`);
      const d1 = await row(draft.id);
      assert.equal(d1.stage, "NEW", "mark_declined KHÔNG đổi stage, không huỷ đơn");
      const rv = orderReviewOf(d1.raw);
      assert.deepEqual(rv?.entries.map((x) => [x.code, x.quote, x.note]), [["CUSTOMER_CANCELLED", "thôi em ơi chị không lấy nữa nhé", "Khách đổi ý sau tóm tắt"]], "ghi chú nguyên văn câu khách + lý do");
      assert.ok(rv?.entries[0].at, "có mốc");
      assert.equal(await auditCount("ORDER_REVIEW_FLAG", draft.id), 1);
      await executeTool("mark_declined", { reason: "Khách đổi ý sau tóm tắt" }, tctx(st, "thôi em ơi chị không lấy nữa nhé"));
      assert.equal(orderReviewOf((await row(draft.id)).raw)?.entries.length, 1, "câu y hệt gửi lại ⇒ không thêm dòng");
      assert.equal(await auditCount("ORDER_REVIEW_FLAG", draft.id), 1);
      // Khung thử không ghi gì; hội thoại chưa có đơn ⇒ như trước.
      const sim = await executeTool("mark_declined", { reason: "Chê đắt" }, { ...tctx({}, "thôi"), channel: "TEST" as const });
      assert.deepEqual(JSON.parse(sim.content), { declined: true });

      // ③ Công tắc «đơn đủ thông tin = đã xác nhận» BẬT: đơn khách đã báo huỷ KHÔNG được tự nâng (luật 04/10 «trừ đơn huỷ»).
      await setSettingJson(AUTO_CONFIRM_COMPLETE_SETTING_KEY, { enabled: true });
      const again = await updateOrderAsAgent(AGENT, draft.id, input("NEW", "Số 7 ngõ Thử Nghiệm, Phường Hoàn Kiếm, Hà Nội"), opts);
      assert.ok(again.ok);
      assert.equal((await row(draft.id)).stage, "NEW", "đơn mang cờ «khách huỷ» giữ «Mới» dù công tắc bật");
      assert.equal(orderReviewOf((await row(draft.id)).raw)?.entries.length, 1, "lượt sửa của máy giữ nguyên cờ");
      await setSettingJson(AUTO_CONFIRM_COMPLETE_SETTING_KEY, { enabled: false });

      // ④ Xã chưa ghép mà MÁY chốt ⇒ vẫn «Đã xác nhận» + cờ «địa chỉ chưa ghép».
      const amb = await createOrderAsAgent(AGENT, input("NEW", "số 2 ngách 4 ngõ Giả, Hoàn Kiếm, Hà Nội", "0936 000 181"), { ...opts, idempotencyKey: "rv-amb" });
      assert.ok(amb.ok);
      assert.equal((await row(amb.id)).shipCommune, "", "chỉ có quận cũ ⇒ để trống xã (không đoán)");
      const ambC = await updateOrderAsAgent(AGENT, amb.id, input("CONFIRMED", "số 2 ngách 4 ngõ Giả, Hoàn Kiếm, Hà Nội", "0936 000 181"), opts);
      assert.ok(ambC.ok, JSON.stringify(ambC));
      const a1 = await row(amb.id);
      assert.equal(a1.stage, "CONFIRMED", "vẫn chốt như trước");
      assert.equal(a1.shipPhone, "0936000181");
      assert.deepEqual(reviewCodes(orderReviewOf(a1.raw)), ["ADDRESS_UNRESOLVED"], "kèm cờ cần người kiểm + lý do");
      assert.equal(await confirmedEvents(amb.id), 1);

      // ⑤ Lọc «Cần người kiểm» ở danh sách đơn + con số trên nhãn (không qua bộ nhớ đệm của dải số — review #675, L6).
      clearMemo();
      const params = (raw: Record<string, string>) => parseListParams(raw, { defaultSort: "insertedAt", filterKeys: ["stage", "source", "carrier", "seller", "payment", "tag", "address", "fulfillment", "review"], sortable: ORDER_SORTABLE, defaultPeriod: "30d" });
      const flaggedList = await listOrders(params({ review: "flagged" }));
      assert.deepEqual(flaggedList.rows.map((r) => r.id).sort(), [draft.id, amb.id].sort(), "lọc ra đúng hai đơn mang cờ");
      assert.deepEqual(flaggedList.rows.find((r) => r.id === draft.id)?.review.map((x) => x.code), ["CUSTOMER_CANCELLED"], "dòng danh sách mang lý do");
      assert.deepEqual(flaggedList.rows.find((r) => r.id === amb.id)?.gaps, ["xã / phường"], "dòng danh sách mang chỗ thiếu ⇒ nút nhanh dẫn sang sửa đơn");
      assert.equal(await orderNeedsReviewCount(params({})), 2);

      // ⑥ Nút nhanh «Xác nhận đơn»: thiếu orders:write ⇒ từ chối, không ghi.
      const seenDraft = reviewSeenOf(orderReviewOf((await row(draft.id)).raw)?.entries ?? []);
      assert.equal(codeOf(await confirmOrderReviewCore(viewer, draft.id, seenDraft)), "FORBIDDEN");
      assert.equal(codeOf(await confirmOrderReviewCore(admin, draft.id, undefined)), "INVALID", "thiếu dấu vết đã xem ⇒ không đoán");
      assert.equal((await row(draft.id)).stage, "NEW");
      // Đơn «Mới» mang cờ ⇒ «Đã xác nhận» qua đường sửa đơn (sự kiện order.confirmed) + cờ gỡ trong cùng lượt ghi.
      const qc = await confirmOrderReviewCore(admin, draft.id, seenDraft);
      assert.ok(qc.ok, JSON.stringify(qc));
      const d2 = await row(draft.id);
      assert.equal(d2.stage, "CONFIRMED");
      assert.equal(orderReviewOf(d2.raw), null, "người xác nhận ⇒ gỡ cờ");
      assert.deepEqual(orderReviewLogOf(d2.raw).map((x) => [x.action, x.byUserId]), [["CONFIRMED", u.id]], "vết: ai xác nhận");
      assert.equal(await confirmedEvents(draft.id), 1, "đi qua đường sửa đơn ⇒ đúng một order.confirmed");
      assert.equal(await auditCount("ORDER_MANUAL_UPDATE", draft.id) >= 1, true);
      assert.equal(await auditCount("ORDER_REVIEW_RESOLVE", draft.id), 1);
      // Bấm hai lần ⇒ không ghi gì thêm.
      assert.ok((await confirmOrderReviewCore(admin, draft.id, seenDraft)).ok);
      assert.equal(await auditCount("ORDER_REVIEW_RESOLVE", draft.id), 1, "bấm lại không ghi thêm");
      assert.equal(await confirmedEvents(draft.id), 1);

      // ⑦ Đơn còn chỗ thiếu (xã trống) ⇒ nút nhanh từ chối, sửa đơn trước (L2). Lưu form KHÔNG làm mất cờ (gộp từ dòng đã khoá).
      const seenAmb = reviewSeenOf(orderReviewOf((await row(amb.id)).raw)?.entries ?? []);
      const gapRes = await confirmOrderReviewCore(admin, amb.id, seenAmb);
      assert.ok(!gapRes.ok && gapRes.code === "CONFLICT" && gapRes.errors.some((e) => e.message.includes("xã / phường")), JSON.stringify(gapRes));
      assert.deepEqual(reviewCodes(orderReviewOf((await row(amb.id)).raw)), ["ADDRESS_UNRESOLVED"], "từ chối ⇒ cờ còn nguyên");
      const ambValues = await manualOrderFormValues(amb.id);
      assert.ok(ambValues);
      assert.ok((await updateManualOrderCore(admin, amb.id, { ...ambValues, recipient: { ...ambValues.recipient, ward: "Phường Hoàn Kiếm" } })).ok);
      const a2 = await row(amb.id);
      assert.ok(a2.shipCommune, "người chọn xã");
      assert.deepEqual(reviewCodes(orderReviewOf(a2.raw)), ["ADDRESS_UNRESOLVED"], "lưu form giữ cờ — người bấm «Xác nhận đơn» mới gỡ");
      // M1: bot gắn «khách huỷ» SAU khi trang đã dựng ⇒ bấm với dấu vết cũ bị từ chối (nhánh gỡ cờ), cờ còn cả hai.
      assert.ok((await flagOrderForReviewAsAgent(AGENT, amb.id, { code: "CUSTOMER_CANCELLED", note: "Khách huỷ", quote: "thôi chị huỷ nhé" })).ok);
      const stale = await confirmOrderReviewCore(admin, amb.id, seenAmb);
      assert.ok(!stale.ok && stale.code === "CONFLICT" && stale.errors.some((e) => e.message.includes("Khách vừa báo huỷ")), JSON.stringify(stale));
      assert.deepEqual(reviewCodes(orderReviewOf((await row(amb.id)).raw)), ["ADDRESS_UNRESOLVED", "CUSTOMER_CANCELLED"], "từ chối ⇒ không gỡ cờ nào");
      // Tải lại (thấy đủ hai lý do) ⇒ gỡ được; đơn đã xác nhận ⇒ chỉ gỡ cờ, không order.confirmed lần hai.
      assert.ok((await confirmOrderReviewCore(admin, amb.id, reviewSeenOf(orderReviewOf((await row(amb.id)).raw)?.entries ?? []))).ok);
      const a3 = await row(amb.id);
      assert.deepEqual([a3.stage, orderReviewOf(a3.raw)], ["CONFIRMED", null]);
      assert.equal(await confirmedEvents(amb.id), 1, "gỡ cờ không phát order.confirmed lần hai");

      // M1 nhánh CHỐT: trang dựng khi đơn «Mới» chưa cờ; bot gắn «khách huỷ»; người bấm ⇒ từ chối, đơn giữ «Mới», không sự kiện.
      const fourth = await createOrderAsAgent(AGENT, input("NEW", "Số 7 ngõ Thử Nghiệm, Phường Hoàn Kiếm, Hà Nội"), { ...opts, idempotencyKey: "rv-fourth" });
      assert.ok(fourth.ok);
      const seenEmpty = reviewSeenOf([]);
      assert.ok((await flagOrderForReviewAsAgent(AGENT, fourth.id, { code: "CUSTOMER_CANCELLED", note: "Khách huỷ", quote: "huỷ đơn giúp chị" })).ok);
      const staleNew = await confirmOrderReviewCore(admin, fourth.id, seenEmpty);
      assert.ok(!staleNew.ok && staleNew.code === "CONFLICT", JSON.stringify(staleNew));
      const f1 = await row(fourth.id);
      assert.deepEqual([f1.stage, reviewCodes(orderReviewOf(f1.raw)), await confirmedEvents(fourth.id)], ["NEW", ["CUSTOMER_CANCELLED"], 0], "không chốt, không gỡ, không quy kết người bấm");

      // Lưu form SONG SONG với lượt gắn cờ ⇒ cờ còn (updateOrder dựng raw từ dòng đã khoá, không đè nguyên cột).
      const fifth = await createOrderAsAgent(AGENT, input("NEW", "Số 7 ngõ Thử Nghiệm, Phường Hoàn Kiếm, Hà Nội"), { ...opts, idempotencyKey: "rv-fifth" });
      assert.ok(fifth.ok);
      const fifthValues = await manualOrderFormValues(fifth.id);
      assert.ok(fifthValues);
      const [saved, flaggedNow] = await Promise.all([updateManualOrderCore(admin, fifth.id, { ...fifthValues, note: "Giao giờ hành chính" }), flagOrderForReviewAsAgent(AGENT, fifth.id, { code: "CUSTOMER_CANCELLED", note: "Khách huỷ", quote: "không lấy nữa" })]);
      assert.ok(saved.ok && flaggedNow.ok && flaggedNow.flagged);
      assert.deepEqual(reviewCodes(orderReviewOf((await row(fifth.id)).raw)), ["CUSTOMER_CANCELLED"], "lượt lưu form không làm mất cờ gắn cùng lúc");

      // L5: SĐT dạng Pancake (0…) cả với «+84…»; sửa đơn cũ chỉ khác ĐỊNH DẠNG SĐT ⇒ không phát order.updated giả.
      assert.equal(canonicalRecipientPhone("+84 936 000 182"), "0936000182");
      assert.equal(canonicalRecipientPhone("84936000182"), "0936000182");
      assert.equal(canonicalRecipientPhone("0919.000.808"), "0919000808");
      assert.equal(canonicalRecipientPhone("không có"), "không có", "không chuẩn hoá được ⇒ giữ chữ khách gõ");
      await db.update(schema.orders).set({ shipPhone: "0919.000.808" }).where(eq(schema.orders.id, draft.id));
      const updatedEvents = async (id: string) => (await db.select({ id: schema.domainEvents.id }).from(schema.domainEvents).where(and(eq(schema.domainEvents.name, "order.updated"), eq(schema.domainEvents.subjectId, id)))).length;
      const ev0 = await updatedEvents(draft.id);
      const draftValues = await manualOrderFormValues(draft.id);
      assert.ok(draftValues && (await updateManualOrderCore(admin, draft.id, draftValues)).ok);
      assert.equal(await updatedEvents(draft.id), ev0, "chỉ khác định dạng SĐT ⇒ không order.updated");
      assert.equal((await row(draft.id)).shipPhone, "0919000808");

      // ⑧ «Huỷ đơn» trên đơn mang cờ = lõi huỷ đơn tay; cờ gỡ với hành động CANCELLED.
      const third = await createOrderAsAgent(AGENT, input("NEW", "Số 7 ngõ Thử Nghiệm, Phường Hoàn Kiếm, Hà Nội"), { ...opts, idempotencyKey: "rv-third" });
      assert.ok(third.ok);
      assert.ok((await flagOrderForReviewAsAgent(AGENT, third.id, { code: "CUSTOMER_CANCELLED", note: "Khách huỷ", quote: "huỷ đơn giúp chị" })).ok);
      assert.equal(codeOf(await cancelManualOrderCore(viewer, third.id, { reason: "Khách huỷ (theo hội thoại)" })), "FORBIDDEN");
      assert.ok((await cancelManualOrderCore(admin, third.id, { reason: "Khách huỷ (theo hội thoại)" })).ok);
      const t1 = await row(third.id);
      assert.deepEqual([t1.stage, orderReviewOf(t1.raw), orderReviewLogOf(t1.raw)[0]?.action], ["CANCELLED", null, "CANCELLED"]);
      // Đơn đã huỷ ⇒ không gắn cờ nữa (lời huỷ không còn việc gì cho người); đơn đồng bộ / id lạ ⇒ không có đơn.
      assert.deepEqual(await flagOrderForReviewAsAgent(AGENT, third.id, { code: "CUSTOMER_CANCELLED", note: "x", quote: "lại huỷ" }), { ok: true, id: third.id, flagged: false, stage: "CANCELLED" });
      assert.equal(codeOf(await flagOrderForReviewAsAgent(AGENT, "123456", { code: "CUSTOMER_CANCELLED", note: "x", quote: null })), "NOT_FOUND");

      // L1: khách huỷ đơn ĐÃ XÁC NHẬN ⇒ báo người ngay (đường chuyển người có sẵn); L8: khách đồng ý lại ⇒ vết, cờ còn.
      const sixth = await createOrderAsAgent(AGENT, input("NEW", "Số 7 ngõ Thử Nghiệm, Phường Hoàn Kiếm, Hà Nội"), { ...opts, idempotencyKey: "rv-sixth" });
      assert.ok(sixth.ok);
      const st6: ChatState = { ...st, draft: { ...st.draft!, orderId: sixth.id, recipient: { name: "Chị Nga", phone: "0919000808", address: "Số 7 ngõ Thử Nghiệm, Phường Hoàn Kiếm, Hà Nội", province: "" } } };
      const ok6 = await executeTool("confirm_order", { customer_confirmation: "ok chốt đơn" }, tctx(st6, "ok chốt đơn nhé em"));
      assert.ok(!ok6.isError, ok6.content);
      assert.equal((await row(sixth.id)).stage, "CONFIRMED");
      const conv6 = "conv-rv-6";
      const dec6 = await executeTool("mark_declined", { reason: "Khách huỷ sau khi chốt" }, { ...tctx(ok6.state, "thôi em huỷ giúp chị đơn đó nhé"), conversationId: conv6 });
      assert.ok(!dec6.isError && (await row(sixth.id)).stage === "CONFIRMED", "đơn đã xác nhận không bị huỷ tự động");
      const notes6 = await db.select({ body: schema.notifications.body }).from(schema.notifications).where(eq(schema.notifications.entityId, conv6));
      assert.ok(notes6.some((n) => (n.body ?? "").includes("ĐÃ XÁC NHẬN")), `báo người khi khách huỷ đơn đã xác nhận: ${JSON.stringify(notes6)}`);
      // Khách quay lại đồng ý (lời xác nhận hợp lệ) ⇒ dòng «khách xác nhận lại», cờ GIỮ NGUYÊN.
      const back = await executeTool("confirm_order", { customer_confirmation: "ok giao em" }, tctx({ ...dec6.state, confirmed: undefined }, "ok giao em nhé"));
      assert.ok(!back.isError, back.content);
      const s6 = await row(sixth.id);
      assert.deepEqual(reviewCodes(orderReviewOf(s6.raw)), ["CUSTOMER_CANCELLED"], "khách đồng ý lại không tự gỡ cờ");
      assert.deepEqual(reconfirmsSinceOpen(s6.raw).map((r) => [r.action, r.quote]), [["CUSTOMER_RECONFIRMED", "ok giao em nhé"]], "vết «khách xác nhận lại» nguyên văn");

      // ⑧ Lời xác nhận chỉ dấu câu bị từ chối ở confirm_order (trước khi chạm CSDL).
      const qq = await executeTool("confirm_order", { customer_confirmation: "??" }, { ...tctx({ ...st, draft: { ...st.draft!, simulated: true } }, "??"), channel: "TEST" as const });
      assert.ok(qq.isError && !qq.state.confirmed, `«??» không phải lời đồng ý: ${qq.content}`);
      const sub = await executeTool("confirm_order", { customer_confirmation: "on" }, { ...tctx({ ...st, draft: { ...st.draft!, simulated: true } }, "chị không lấy đâu"), channel: "TEST" as const });
      assert.ok(sub.isError && !sub.state.confirmed, "chuỗi con giữa từ («on» trong «không») bị từ chối");
    });
  } finally {
    await cleanupOrg(ORG);
  }
}

export async function testOrderReview() {
  testPure();
  testSourceContract();
  await testOrg();
  console.log("  ✓ đơn cần người kiểm (08/10/2026): mark_declined ghi chú «khách huỷ» + cờ, không đổi stage; máy chốt khi xã chưa ghép ⇒ cờ; công tắc tự xác nhận không nâng đơn khách huỷ; nút nhanh Xác nhận / Huỷ đi đúng lõi + quyền + gỡ cờ (bấm lại không ghi); lọc «Cần người kiểm»; lời xác nhận ≥ 2 chữ + ranh giới từ; SĐT chuẩn hoá ở đường ghi (dạng 0… của Pancake, không order.updated giả); review #675: dấu vết đã thấy chặn chốt / gỡ cờ trên trang cũ, lưu form song song không mất cờ, đơn thiếu xã không chốt nhanh, khách huỷ đơn đã xác nhận ⇒ báo người, khách đồng ý lại ⇒ vết, cờ còn");
}

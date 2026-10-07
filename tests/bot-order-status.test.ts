/**
 * BOT TRA TRẠNG THÁI ĐƠN (Commerce Truth · Master Mission mục V) — `get_order_status` (sửa theo review độc lập 08/10/2026).
 *
 *  · PHẠM VI: CHỈ đơn gắn với CHÍNH hội thoại (`sales_conversation_id`) + đơn bot đã chốt trong hội thoại. KHÔNG theo
 *    `state.customer.id` — id ấy có thể đến từ SĐT khách gõ (`create_customer` trả id của chủ SĐT): kẻ gian gõ SĐT nạn nhân rồi
 *    hỏi «đơn của em tới đâu» là đọc được đơn + mã vận đơn của nạn nhân (CRITICAL). Luồng BÌNH LUẬN công khai không đọc đơn.
 *  · CÂU TRẠNG THÁI (`order-status-shared.ts`): trạng thái ĐƠN trước (huỷ · nháp) → vận đơn ĐẠI DIỆN (`vanDonDaiDien`) → chỉ
 *    nói «đơn vị vận chuyển báo …» khi chặng dựng từ CHỨNG TỪ ĐVVC → không vận đơn: phiếu giao ký nhận của đơn ERP. Đã thu tiền /
 *    COD mà chưa có sự kiện ĐVVC ⇒ «chưa có thông tin» (không suy «đã giao» từ tiền). Giao lỗi / đề nghị hoàn / đã hoàn / vận
 *    đơn huỷ ⇒ `needs_staff`: bot nói ĐÚNG lời khai rồi hỏi khách có cần nhân viên — KHÔNG tự chuyển người (một đơn hoàn cũ không
 *    khoá mọi câu hỏi sau), không hứa «sẽ giao lại / sẽ liên hệ». Chỉ «không thấy đơn» mới chuyển người ngay. Không nêu số tiền.
 *  · BÌNH LUẬN (review 2): lượt trả lời bình luận (gợi ý của engine) không đọc đơn; hội thoại bình luận đã bị đổi mã luồng sang
 *    mã hộp thư (`visitor_key` lệch) vẫn bị chặn; hội thoại page thiếu mã luồng ⇒ chặn (lỗi rơi về phía ĐÓNG).
 *  · Khung THỬ không đọc đơn thật; công cụ quy trình luôn bật (kể cả cấu hình cũ đã lưu).
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { parseSalesChatbotConfig } from "@/lib/sales-chatbot/config";
import { customerOrderStatus, NO_CARRIER_INFO } from "@/lib/sales-chatbot/order-status-shared";
import { fanpageVisitorKey } from "@/lib/sales-chatbot/fanpage";
import { executeTool, PROCESS_TOOLS, toolDefsFor, type ChatState } from "@/lib/sales-chatbot/tools";

const ORG = "bot-tra-don";

async function cleanup() {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, ORG) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, ORG));
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

type Ord = { orders: { order_code: string; status: string; carrier_status: string | null; tracking_code: string | null; needs_staff: boolean; total?: unknown }[]; note: string };

// ─────────────────────────── THUẦN — bảng chân lý câu trạng thái ───────────────────────────

function testPure() {
  const ship = (stage: string, carrierEvidence = true, statusCode: number | null = null, statusName: string | null = null) => ({ stage, carrierEvidence, statusCode, statusName });
  const st = (orderStage: string, shipment: ReturnType<typeof ship> | null, manual = true) => customerOrderStatus({ orderStage, manual, shipment });

  assert.equal(st("CANCELLED", ship("PENDING")).text, "Đơn đã huỷ", "đơn huỷ là huỷ dù vận đơn còn «chờ lấy»");
  assert.match(st("NEW", null).text, /chưa được chốt/, "đơn nháp chưa chốt ⇒ không nói «đang chuẩn bị»");
  const out = st("CONFIRMED", ship("OUT_FOR_DELIVERY"));
  assert.deepEqual([out.carrierSaid, out.needsStaff], [true, null]);
  assert.match(out.text, /^Đơn vị vận chuyển báo/);
  // Chặng KHÔNG có chứng từ ĐVVC (vd suy từ trạng thái Pancake) ⇒ không bao giờ «đơn vị vận chuyển báo …».
  assert.deepEqual([st("CONFIRMED", ship("PICKED_UP", false)).text, st("CONFIRMED", ship("PICKED_UP", false)).carrierSaid], [NO_CARRIER_INFO, false]);
  assert.match(st("CONFIRMED", ship("PENDING", false)).text, /Shop đã tạo vận đơn/, "vận đơn do shop tạo là sự thật của shop, không phải lời ĐVVC");
  // Giao lỗi / hoàn / vận đơn huỷ ⇒ cần nhân viên chăm sóc; câu nói với khách không hứa «giao lại» / «sẽ liên hệ».
  for (const s of [ship("DELIVERY_FAILED"), ship("RETURNING", true, 505, "Yêu cầu chuyển hoàn"), ship("RETURNING", true, 502, null), ship("RETURNED"), ship("CANCELLED")]) {
    const r = st("SHIPPED", s);
    assert.ok(r.needsStaff && !/giao lại|liên hệ/.test(r.text), `${s.stage}/${s.statusCode}: ${JSON.stringify(r)}`);
  }
  assert.match(st("SHIPPED", ship("RETURNING", true, 505, "Yêu cầu chuyển hoàn")).text, /khó giao/, "505 mới là ĐỀ NGHỊ hoàn — không nói «đang chuyển hoàn» làm khách buông đơn còn cứu được");
  assert.match(st("SHIPPED", ship("RETURNING", true, 502, null)).text, /đang chuyển hoàn/, "502 / 515 = đã duyệt hoàn");
  // Không vận đơn: đơn ERP có phiếu giao ký nhận ⇒ «shop đã giao»; giao hỏng ⇒ chuyển người; đơn Pancake không khẳng định «chưa giao».
  assert.match(st("DELIVERED", null, true).text, /phiếu ký nhận/);
  assert.ok(st("RETURNED", null, true).needsStaff);
  assert.ok(!/chưa giao/.test(st("DELIVERED", null, false).text), "đơn Pancake DELIVERED không có chứng từ — không kết luận gì từ trạng thái Pancake");
  assert.match(st("CONFIRMED", null, false).text, /chưa có thông tin vận chuyển/);
}

// ─────────────────────────── TỔ CHỨC THẬT ───────────────────────────

async function run() {
  await withOrganization(ORG, async () => {
    const db = await getDb();
    const conv = async (over: Partial<typeof schema.salesChatConversations.$inferInsert> = {}) => (await db.insert(schema.salesChatConversations).values({ channel: "WEB", ...over }).returning({ id: schema.salesChatConversations.id }))[0].id;
    const now = Date.now();
    const order = async (id: string, conversationId: string | null, minutesAgo: number, extra: Partial<typeof schema.orders.$inferInsert> = {}) => {
      await db.insert(schema.orders).values({ id, insertedAt: new Date(now - minutesAgo * 60_000), salesConversationId: conversationId, totalPrice: 350_000, stage: "CONFIRMED", ...extra });
    };
    const shipment = (orderId: string, code: string, extra: Partial<typeof schema.shipments.$inferInsert>) => db.insert(schema.shipments).values({ orderId, vtpOrderNumber: code, ...extra });

    const c1 = await conv();
    const c2 = await conv();
    // c1: đơn đang giao (CHỨNG TỪ ĐVVC) · đơn chưa có vận đơn · đơn ĐÃ THU TIỀN nhưng chưa có sự kiện ĐVVC nào.
    await order("erp-btd-o1", c1, 30);
    await shipment("erp-btd-o1", "BTD100001", { stage: "OUT_FOR_DELIVERY", vtpStatusName: "Đang giao hàng", vtpStatusDate: new Date(now - 10 * 60_000), vtpSyncSource: "VTP_WEBHOOK" });
    await order("erp-btd-o2", c1, 20);
    await order("erp-btd-o3", c1, 10);
    await shipment("erp-btd-o3", "BTD100003", { stage: "UNKNOWN", codStatus: "RECONCILED", codCollected: 350_000 });
    // Khách A (c2) có hồ sơ khách + đơn đã giao — KHÔNG được lộ sang hội thoại khác, kể cả khi hội thoại kia mang id khách của A.
    const [victim] = await db.insert(schema.customers).values({ id: "btd-cus-a", name: "Khách A", phone: "0901234567" }).returning({ id: schema.customers.id });
    await order("erp-btd-o9", c2, 5, { customerId: victim.id });
    await shipment("erp-btd-o9", "BTD100009", { stage: "DELIVERED", vtpStatusName: "Giao thành công", vtpStatusDate: new Date(now - 60_000), vtpSyncSource: "VTP_WEBHOOK" });

    const cfg = parseSalesChatbotConfig(null);
    const ctx = (conversationId: string, state: ChatState = {}, channel: "WEB" | "TEST" | "FANPAGE" = "WEB", commentTurn = false) => ({ conversationId, channel, config: cfg, state, lastUserText: "Đơn của em tới đâu rồi shop?", agent: { name: "t", source: "t" }, commentTurn });
    const ask = async (conversationId: string, state: ChatState = {}, channel: "WEB" | "TEST" | "FANPAGE" = "WEB", commentTurn = false) => {
      const r = await executeTool("get_order_status", {}, ctx(conversationId, state, channel, commentTurn));
      assert.ok(!r.isError, r.content);
      return { ...r, v: JSON.parse(r.content) as Ord };
    };

    // Công cụ quy trình luôn có (kể cả cấu hình cũ đã lưu không khai công cụ mới).
    assert.ok(PROCESS_TOOLS.includes("get_order_status") && toolDefsFor(cfg).some((d) => d.name === "get_order_status"));

    const r1 = await ask(c1);
    assert.equal(r1.v.orders.length, 3, `đúng ba đơn của hội thoại: ${r1.content}`);
    const byCode = new Map(r1.v.orders.map((o) => [o.tracking_code, o]));
    assert.match(byCode.get("BTD100001")?.status ?? "", /^Đơn vị vận chuyển báo bưu tá đang giao/, "chứng từ ĐVVC ⇒ câu «ĐVVC báo»");
    assert.equal(byCode.get("BTD100001")?.carrier_status, "Đang giao hàng", "kèm nguyên văn lời khai ĐVVC");
    assert.equal(byCode.get("BTD100003")?.status, NO_CARRIER_INFO, "đã thu tiền mà chưa có sự kiện ĐVVC ⇒ KHÔNG suy «đã giao» từ tiền");
    assert.equal(byCode.get("BTD100003")?.carrier_status, null);
    assert.ok(r1.v.orders.some((o) => o.tracking_code === null && /chưa có thông tin vận chuyển/.test(o.status)), "đơn chưa có vận đơn ⇒ không khẳng định «chưa giao»");
    assert.ok(!r1.content.includes("BTD100009") && r1.v.orders.every((o) => o.total === undefined), "đơn của khách khác không lộ; không nêu số tiền");
    assert.equal(r1.requireHuman, undefined, "không đơn nào cần người ⇒ bot tự trả lời");
    // Đơn Pancake: mã HIỂN THỊ (khách thấy trên POS / tin xác nhận), không phải id nội bộ; thiếu mã hiển thị ⇒ id (review #645, L2).
    const cP = await conv();
    await order("7712345678901234567", cP, 15, { displayId: 4321 });
    await order("7712345678901234999", cP, 14);
    const codes = (await ask(cP)).v.orders.map((x) => x.order_code).sort();
    assert.deepEqual(codes, ["#4321", "#7712345678901234999"], `mã đơn Pancake: ${JSON.stringify(codes)}`);
    assert.deepEqual(r1.v.orders.map((x) => x.order_code).sort(), ["#BTD-O1", "#BTD-O2", "#BTD-O3"], "đơn ERP giữ mã ngắn như cũ");

    // CRITICAL (review 08/10/2026): hội thoại mới mang `state.customer.id` của khách A (vd kẻ gian gõ SĐT của A ⇒ create_customer
    // trả id của A) ⇒ KHÔNG đọc được đơn nào của A.
    const attacker = await ask(await conv(), { customer: { id: victim.id, name: "Khách A", phone: "0901234567", address: "12 Lê Lợi", province: "", simulated: false } });
    assert.equal(attacker.v.orders.length, 0, `id khách trong state KHÔNG mở được đơn của người khác: ${attacker.content}`);
    assert.ok(!attacker.content.includes("BTD100009"));
    assert.ok(attacker.requireHuman && /KHÔNG xin SĐT/.test(attacker.v.note), "không thấy đơn ⇒ chuyển nhân viên, không xin SĐT để tự tra");

    // Đơn bot đã chốt trong hội thoại (state.confirmed) được tra dù đơn chưa gắn sales_conversation_id.
    await order("erp-btd-o5", null, 3);
    const r5 = await ask(await conv(), { confirmed: { orderId: "erp-btd-o5", simulated: false, total: 350_000, at: new Date().toISOString() } });
    assert.equal(r5.v.orders.length, 1, "đơn đã chốt trong hội thoại");

    // Trạng thái ĐƠN trước vận đơn · vận đơn ĐẠI DIỆN · hoàn ⇒ chuyển người.
    const c3 = await conv();
    await order("erp-btd-huy", c3, 50, { stage: "CANCELLED" });
    await shipment("erp-btd-huy", "BTD200001", { stage: "PENDING" });
    // Lần gửi 1 bị huỷ (có mốc) · lần gửi 2 vừa tạo, chưa có sự kiện ⇒ đại diện là lần 2 (không nói «vận đơn đã huỷ»).
    await order("erp-btd-gui2", c3, 40);
    await shipment("erp-btd-gui2", "BTD200002", { stage: "CANCELLED", attemptNo: 1, vtpStatusDate: new Date(now - 30 * 60_000), vtpSyncSource: "VTP_WEBHOOK", createdAt: new Date(now - 40 * 60_000) });
    await shipment("erp-btd-gui2", "BTD200003", { stage: "PENDING", attemptNo: 2, createdAt: new Date(now - 5 * 60_000) });
    // Đề nghị hoàn (505) ⇒ «khó giao», chuyển người.
    await order("erp-btd-hoan", c3, 30);
    await shipment("erp-btd-hoan", "BTD200004", { stage: "RETURNING", vtpStatus: 505, vtpStatusName: "Yêu cầu chuyển hoàn", vtpStatusDate: new Date(now - 60_000), vtpSyncSource: "VTP_WEBHOOK" });
    const r3 = await ask(c3);
    const by3 = new Map(r3.v.orders.map((o) => [o.tracking_code, o.status]));
    assert.equal(by3.get("BTD200001"), "Đơn đã huỷ", "đơn huỷ là huỷ dù vận đơn còn «chờ lấy»");
    assert.match(by3.get("BTD200003") ?? "", /Shop đã tạo vận đơn/, `lần gửi đại diện là lần 2: ${r3.content}`);
    assert.ok(!by3.has("BTD200002"), "không nói «vận đơn đã huỷ» của lần gửi cũ");
    assert.match(by3.get("BTD200004") ?? "", /khó giao/);
    assert.ok(r3.v.orders.find((o) => o.tracking_code === "BTD200004")?.needs_staff && /handoff_to_human/.test(r3.v.note), "đề nghị hoàn ⇒ cờ cần nhân viên + bot hỏi khách");
    assert.equal(r3.requireHuman, undefined, "KHÔNG tự chuyển người — khách vẫn nghe trạng thái, đơn cũ không khoá mọi câu hỏi sau");

    // Đơn ERP không vận đơn: phiếu giao ký nhận ⇒ «shop đã giao»; giao hỏng ⇒ chuyển người.
    const c4 = await conv();
    await order("erp-btd-phieu", c4, 20, { stage: "DELIVERED" });
    const r4 = await ask(c4);
    assert.match(r4.v.orders[0]?.status ?? "", /phiếu ký nhận/);
    await order("erp-btd-hong", c4, 10, { stage: "RETURNED" });
    const r4b = await ask(c4);
    assert.ok(r4b.v.orders.some((o) => o.needs_staff && /chưa thành công/.test(o.status)) && r4b.requireHuman === undefined, "giao hỏng ⇒ cần nhân viên, bot hỏi khách — không tự chuyển");

    // Luồng BÌNH LUẬN công khai (mã hội thoại có thể là của cả bài) ⇒ không đọc đơn, dù hội thoại có gắn đơn.
    const c5 = await conv({ channel: "FANPAGE", pageId: "777000111", threadId: "777000111_9988" });
    await order("erp-btd-bl", c5, 5);
    await db.insert(schema.salesChatInbound).values({ pageId: "777000111", threadId: "777000111_9988", messageId: "btd-cmt-1", text: "Đơn mình sao rồi", kind: "COMMENT", fromId: "u-1", status: "DONE" });
    const rc = await ask(c5, {}, "FANPAGE");
    assert.equal(rc.v.orders.length, 0, "bình luận công khai ⇒ không đọc đơn");
    assert.match(rc.v.note, /nhắn tin riêng/);
    // Lớp 1: lượt trả lời BÌNH LUẬN (gợi ý của engine) ⇒ không đọc đơn, kể cả ở hội thoại hộp thư có đơn.
    assert.equal((await ask(c1, {}, "WEB", true)).v.orders.length, 0, "lượt bình luận ⇒ không đọc đơn");
    // Hội thoại bình luận đã bị đổi mã luồng sang mã hộp thư sau khi trả lời bình luận (`markWaitingForCustomer`) ⇒ visitor_key lệch
    // (page, mã luồng mới) ⇒ vẫn chặn (review 2, mục A).
    const c6 = await conv({ channel: "FANPAGE", pageId: "777000111", threadId: "777000111_4455667788", visitorKey: fanpageVisitorKey("777000111", "777000111_9988") });
    await order("erp-btd-doima", c6, 4);
    const r6 = await ask(c6, {}, "FANPAGE");
    assert.ok(r6.v.orders.length === 0 && r6.requireHuman && !/nhắn tin riêng/.test(r6.v.note), `đổi mã luồng ⇒ chặn, chuyển người, không bảo «nhắn riêng»: ${r6.content}`);
    // Hội thoại hộp thư bình thường (visitor_key khớp) ⇒ đọc được đơn của chính nó.
    const c7 = await conv({ channel: "FANPAGE", pageId: "777000111", threadId: "777000111_1122334455", visitorKey: fanpageVisitorKey("777000111", "777000111_1122334455") });
    await order("erp-btd-hopthu", c7, 3);
    assert.equal((await ask(c7, {}, "FANPAGE")).v.orders.length, 1, "hộp thư bình thường ⇒ đọc đơn của chính hội thoại");
    // Hội thoại page thiếu mã luồng ⇒ chặn (lỗi rơi về phía ĐÓNG).
    const c8 = await conv({ channel: "FANPAGE", pageId: "777000111" });
    await order("erp-btd-thieuma", c8, 2);
    const r8 = await ask(c8, {}, "FANPAGE");
    assert.ok(r8.v.orders.length === 0 && r8.requireHuman && !/nhắn tin riêng/.test(r8.v.note), "thiếu mã luồng (hội thoại cũ) ⇒ chặn, chuyển người, câu trung tính");

    // Khung THỬ không đọc đơn thật.
    const t = await executeTool("get_order_status", {}, ctx(c1, {}, "TEST"));
    assert.equal((JSON.parse(t.content) as Ord).orders.length, 0, "khung thử không đọc đơn thật");
  });
}

export async function testBotOrderStatus() {
  testPure();
  // Engine báo «lượt trả lời bình luận» cho công cụ bằng ĐÚNG gợi ý mà cổng Số dư AI dùng (không suy lại ở nơi khác).
  assert.match(readFileSync("lib/sales-chatbot/engine.ts", "utf8"), /commentTurn: opts\.aiCustomer\?\.threadKind === "COMMENT"/, "engine truyền lượt bình luận xuống công cụ");
  await cleanup();
  await provisionOrganization({ code: ORG, name: ORG, plan: "starter", modules: ["customers", "products", "orders", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "TraDon@12345" }, source: "TEST", actor: null });
  try {
    await run();
  } finally {
    await cleanup();
  }
  console.log(
    "✓ Bot tra trạng thái đơn: chỉ đơn của CHÍNH hội thoại / đơn đã chốt trong hội thoại — id khách trong state (từ SĐT gõ tay) KHÔNG mở được đơn người khác · bình luận công khai không đọc đơn (lượt bình luận · luồng đổi mã · thiếu mã luồng) · trạng thái đơn trước vận đơn · vận đơn đại diện (luật chung) · «ĐVVC báo» chỉ khi có chứng từ ĐVVC · đã thu tiền mà chưa có sự kiện ĐVVC ⇒ không suy «đã giao» · đề nghị hoàn / giao lỗi / hoàn ⇒ cờ cần nhân viên, bot hỏi khách (không tự chuyển, không hứa giao lại) · không thấy đơn ⇒ chuyển người · phiếu ký nhận của đơn ERP · không nêu số tiền · khung thử không đọc đơn thật · công cụ luôn bật",
  );
}

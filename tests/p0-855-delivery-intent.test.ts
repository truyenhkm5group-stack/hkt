/**
 * P0 #855 — HỎI LỊCH GIAO ≠ HỎI TRẠNG THÁI ĐƠN (ca 16/10/2026: khách đã lên đơn hỏi «Hôm nào có hàng?», AI đọc câu trạng thái
 * «Shop đã nhận đơn — chưa có thông tin vận chuyển», nhân viên Page phải vào trả lời «Chiều nay giao ạ»).
 *
 *  · BỘ VÀNG phân loại: 100% câu thời gian giao (có dấu / không dấu, hôm nay · ngày mai · giao gấp) ⇒ DELIVERY_TIME; câu trạng thái ⇒
 *    ORDER_STATUS; câu không liên quan ⇒ null.
 *  · `deliveryTimeAnswer`: chỉ trả lời trực tiếp khi có căn cứ THẬT (chứng từ ĐVVC, ETA đọc được, ngày hẹn ghi trên đơn, phiếu ký
 *    nhận); không có ⇒ không hứa giờ, không đọc câu trạng thái, chuyển nhân viên. Nhân viên đã hẹn ⇒ AI không nói khác.
 *  · `get_order_status` (tổ chức THẬT): câu hỏi lịch giao đi đường riêng do MÁY CHỦ quyết — chuyển người không kèm câu trạng thái;
 *    câu hỏi trạng thái giữ nguyên hành vi cũ.
 *  · Chốt chặn chữ model `deliveryReplyViolation` + lời nhắc hậu mãi không đọc «status» thay giờ giao.
 * Dữ liệu giả, không tên / SĐT thật. Mốc thời gian đi theo đồng hồ thật (AGENTS mục 50).
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
import {
  carrierEtaDay,
  classifyDeliveryQuestion,
  DELIVERY_HANDOFF_TEXT,
  DELIVERY_SHOP_SAID_PREFIX,
  deliveryReplyViolation,
  deliveryTimeAnswer,
  GENERIC_STATUS_PHRASE,
  staffDeliveryCommitment,
  turnDeliverySay,
  type DeliveryFacts,
} from "@/lib/sales-chatbot/delivery-intent";
import { LIFECYCLE_SHOP_SAID_PREFIX, postSalePrompt } from "@/lib/sales-chatbot/lifecycle";
import { executeTool, toolDefsFor, type ChatState } from "@/lib/sales-chatbot/tools";
import { runGoldenCases, say, type GoldenCase } from "./sales-agent-golden/harness";

const ORG = "p0-855-lich-giao";

export const DELIVERY_GOLDEN = [
  "Hôm nào có hàng?",
  "Bao giờ nhận được?",
  "Chiều nay giao được không?",
  "mai co hang khong",
  "giao gấp được không",
  "hom nao co hang",
  "bao gio nhan duoc a",
  "khi nào hàng tới vậy shop",
  "Bao lâu thì nhận được hàng ạ",
  "giao trong ngày được không",
  "hôm nay có giao không",
  "Ngày mai giao được không shop",
  "em cần gấp, giao nhanh giúp em",
  "chieu nay giao duoc ko",
  "mấy giờ thì shipper tới",
  "có hàng chưa shop",
  "đã gửi chưa, bao giờ nhận được?",
  "Sáng mai có hàng không ạ",
  "Bao giờ thì giao",
  "hàng về chưa shop",
  "bh nhan dc hang vay",
  "Mấy ngày thì tới nơi ạ",
  "can gap lam shop oi",
  "giao som giup em duoc ko",
  "hnay giao dc k",
];
const NUANCE: Record<string, string> = {
  "Chiều nay giao được không?": "TODAY",
  "hôm nay có giao không": "TODAY",
  "hnay giao dc k": "TODAY",
  "mai co hang khong": "TOMORROW",
  "Ngày mai giao được không shop": "TOMORROW",
  "giao gấp được không": "URGENT",
  "can gap lam shop oi": "URGENT",
  "Hôm nào có hàng?": "GENERIC",
};
export const STATUS_GOLDEN = ["đơn của em sao rồi", "đã gửi chưa", "Đơn của em tới đâu rồi shop?", "shop gửi hàng cho em chưa", "kiểm tra giúp em đơn hàng", "đơn mình đã giao chưa ạ", "tình trạng đơn của em", "don cua e sao roi", "gui hang chua shop", "gửi cho tôi chưa"];
export const UNRELATED_GOLDEN = ["Giá 1kg bao nhiêu vậy", "Mai em chuyển khoản nhé", "mai em nhắn lại shop", "cho em xem ảnh sản phẩm", "ship về Hà Nội mất phí bao nhiêu", "còn hàng không shop", "Cảm ơn shop", "bao giờ shop mở cửa", "cái này còn size M không", "em muốn gặp nhân viên", "bao giờ nhân viên gọi em", "khi nào tôi chuyển khoản", "Ok chốt đơn", "Hôm nay giá có giảm không"];

const PROMISE_WORDS = /hôm nay|chiều nay|sáng nay|tối nay|ngày mai|sáng mai|chiều mai/i;

/** Ngày giờ VN dạng `dd/mm/yyyy` cách hôm nay `days` ngày — đi theo đồng hồ thật. */
function vnDdmmyyyy(days: number): string {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(new Date(Date.now() + days * 86_400_000));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("day")}/${g("month")}/${g("year")}`;
}

// ─────────────────────────── THUẦN ───────────────────────────

function testClassifier() {
  const missed = DELIVERY_GOLDEN.filter((t) => classifyDeliveryQuestion(t)?.intent !== "DELIVERY_TIME");
  assert.deepEqual(missed, [], `100% câu thời gian giao phải là DELIVERY_TIME — trượt: ${JSON.stringify(missed)}`);
  for (const [t, n] of Object.entries(NUANCE)) assert.equal(classifyDeliveryQuestion(t)?.nuance, n, `sắc thái «${t}»`);
  const notStatus = STATUS_GOLDEN.filter((t) => classifyDeliveryQuestion(t)?.intent !== "ORDER_STATUS");
  assert.deepEqual(notStatus, [], `câu trạng thái ⇒ ORDER_STATUS — trượt: ${JSON.stringify(notStatus)}`);
  const noisy = UNRELATED_GOLDEN.filter((t) => classifyDeliveryQuestion(t) !== null);
  assert.deepEqual(noisy, [], `câu không liên quan ⇒ null — nhận nhầm: ${JSON.stringify(noisy)}`);
  assert.equal(classifyDeliveryQuestion(""), null);
}

function facts(over: Partial<DeliveryFacts> = {}): DeliveryFacts {
  return {
    question: { intent: "DELIVERY_TIME", nuance: "GENERIC" },
    customerText: "Hôm nào có hàng?",
    orderStage: "CONFIRMED",
    manual: true,
    shipment: null,
    promisedAt: null,
    stock: null,
    staffSaid: null,
    liveOrders: 1,
    now: new Date(),
    ...over,
  };
}

function testAnswer() {
  const now = new Date();
  // Ca thật: đơn đã chốt, chưa có vận đơn, hỏi «Hôm nào có hàng?» ⇒ không câu trạng thái, không hứa giờ, chuyển người.
  const thivan = deliveryTimeAnswer(facts());
  assert.equal(thivan.kind, "HANDOFF");
  if (thivan.kind === "HANDOFF") {
    assert.equal(thivan.text, DELIVERY_HANDOFF_TEXT);
    assert.ok(!thivan.text.includes(GENERIC_STATUS_PHRASE) && !PROMISE_WORDS.test(thivan.text), thivan.text);
    assert.match(thivan.reason, /^Hỏi lịch giao — «Hôm nào có hàng\?»/);
  }
  // Hôm nay / ngày mai / giao gấp khi chưa có dữ liệu ⇒ KHÔNG hứa.
  for (const [nuance, text] of [["TODAY", "Chiều nay giao được không?"], ["TOMORROW", "mai co hang khong"], ["URGENT", "giao gấp được không"]] as const) {
    const a = deliveryTimeAnswer(facts({ question: { intent: "DELIVERY_TIME", nuance }, customerText: text }));
    assert.ok(a.kind === "HANDOFF" && !PROMISE_WORDS.test(a.text), `${nuance}: ${JSON.stringify(a)}`);
  }
  // Có vận đơn + chứng từ ĐVVC.
  const ship = (stage: string, carrierEvidence = true, expectedDelivery: string | null = null) => ({ stage, carrierEvidence, expectedDelivery });
  assert.equal(deliveryTimeAnswer(facts({ shipment: ship("OUT_FOR_DELIVERY") })).kind, "DIRECT", "bưu tá đang giao ⇒ trả lời trực tiếp");
  assert.equal(deliveryTimeAnswer(facts({ shipment: ship("DELIVERED") })).kind, "DIRECT");
  const eta = deliveryTimeAnswer(facts({ shipment: ship("IN_TRANSIT", true, vnDdmmyyyy(2)) }));
  assert.ok(eta.kind === "DIRECT" && /dự kiến giao khoảng ngày/.test(eta.text) && eta.text.includes(vnDdmmyyyy(2).slice(0, 5)), JSON.stringify(eta));
  assert.ok(deliveryTimeAnswer(facts({ shipment: ship("IN_TRANSIT", true, vnDdmmyyyy(0)) })).kind === "DIRECT", "ETA hôm nay của ĐVVC là căn cứ (nhãn «dự kiến»)");
  assert.equal(deliveryTimeAnswer(facts({ shipment: ship("IN_TRANSIT", true, "1 ngày") })).kind, "HANDOFF", "ETA không đọc được ⇒ không tin");
  assert.equal(deliveryTimeAnswer(facts({ shipment: ship("IN_TRANSIT", true, vnDdmmyyyy(-3)) })).kind, "HANDOFF", "ETA đã qua ⇒ không tin");
  assert.equal(deliveryTimeAnswer(facts({ shipment: ship("IN_TRANSIT", false, vnDdmmyyyy(2)) })).kind, "HANDOFF", "chặng không có chứng từ ĐVVC ⇒ không tin ETA");
  assert.equal(deliveryTimeAnswer(facts({ question: { intent: "DELIVERY_TIME", nuance: "URGENT" }, shipment: ship("IN_TRANSIT", true, vnDdmmyyyy(2)) })).kind, "HANDOFF", "xin giao gấp ⇒ người");
  assert.equal(deliveryTimeAnswer(facts({ shipment: ship("DELIVERY_FAILED") })).kind, "HANDOFF");
  assert.equal(deliveryTimeAnswer(facts({ shipment: ship("PENDING", false) })).kind, "HANDOFF", "vận đơn chờ lấy ⇒ chưa có lịch giao");
  // Ngày hẹn giao ghi trên đơn.
  const promised = deliveryTimeAnswer(facts({ promisedAt: new Date(now.getTime() + 3 * 86_400_000) }));
  assert.ok(promised.kind === "DIRECT" && /hẹn giao ngày/.test(promised.text), JSON.stringify(promised));
  assert.equal(deliveryTimeAnswer(facts({ promisedAt: new Date(now.getTime() - 3 * 86_400_000) })).kind, "HANDOFF", "hẹn đã qua ⇒ người");
  // Phiếu ký nhận của đơn ERP.
  assert.equal(deliveryTimeAnswer(facts({ orderStage: "DELIVERED" })).kind, "DIRECT");
  // Không chen vào: nhân viên đã hẹn ⇒ người, kể cả khi ĐVVC có tin.
  const staff = deliveryTimeAnswer(facts({ staffSaid: "Chiều nay giao ạ", shipment: ship("IN_TRANSIT", true, vnDdmmyyyy(3)) }));
  assert.ok(staff.kind === "HANDOFF" && /nhân viên đã hẹn «Chiều nay giao ạ»/.test(staff.reason) && !/ngày/.test(staff.text), JSON.stringify(staff));
  assert.equal(deliveryTimeAnswer(facts({ liveOrders: 2, shipment: ship("OUT_FOR_DELIVERY") })).kind, "HANDOFF", "nhiều đơn ⇒ không đoán đơn nào");
  assert.equal(deliveryTimeAnswer(facts({ stock: "WAITING" })).kind, "HANDOFF");
  assert.equal(deliveryTimeAnswer(facts({ orderStage: "NEW" })).kind, "NOT_APPLICABLE", "đơn nháp ⇒ luồng bán hàng thường");
  assert.equal(deliveryTimeAnswer(facts({ orderStage: "CANCELLED" })).kind, "HANDOFF");

  assert.equal(GENERIC_STATUS_PHRASE, "chưa có thông tin vận chuyển", "câu trạng thái của đơn không vận đơn (order-status-shared)");
  assert.equal(carrierEtaDay("Trong ngày", now), null);
  assert.equal(carrierEtaDay("31/02/2099", now), null, "ngày không có thật");
  assert.equal(carrierEtaDay(null, now), null);

  // Nhân viên đã nhắn lịch giao — chỉ tin phía shop mang tiền tố, không phải chữ bot.
  assert.equal(DELIVERY_SHOP_SAID_PREFIX, LIFECYCLE_SHOP_SAID_PREFIX, "tiền tố tin nhân viên = SHOP_SAID của engine");
  assert.equal(staffDeliveryCommitment(["Dạ em chào chị", `${DELIVERY_SHOP_SAID_PREFIX} Chiều nay giao ạ`]), "Chiều nay giao ạ");
  assert.equal(staffDeliveryCommitment(["Dạ chiều nay giao ạ"]), null, "chữ bot không phải lời nhân viên");
  assert.equal(staffDeliveryCommitment([`${DELIVERY_SHOP_SAID_PREFIX} Dạ chị chờ em xíu`]), null);

  // Chốt chặn chữ model.
  const statusReply = "Đơn mình hiện đang ở trạng thái: Shop đã nhận đơn — chưa có thông tin vận chuyển ạ.";
  assert.ok(deliveryReplyViolation("Hôm nào có hàng?", statusReply), "câu trạng thái trả cho câu hỏi lịch giao ⇒ vi phạm");
  assert.ok(deliveryReplyViolation("Hôm nào có hàng?", "Dạ chiều nay giao chị nhé"), "hứa chiều nay không căn cứ ⇒ vi phạm");
  assert.equal(deliveryReplyViolation("Hôm nào có hàng?", "Dạ đơn mình đang trên đường, đơn vị vận chuyển dự kiến giao trong hôm nay ạ.", "Dạ đơn mình đang trên đường, đơn vị vận chuyển dự kiến giao trong hôm nay ạ."), null, "câu máy chủ đã quyết ⇒ không chặn");
  assert.equal(deliveryReplyViolation("Hôm nào có hàng?", DELIVERY_HANDOFF_TEXT), null);
  assert.equal(deliveryReplyViolation("đơn của em sao rồi", statusReply), null, "câu hỏi trạng thái ⇒ câu trạng thái là đúng");

  // Căn cứ của lượt: chỉ kết quả công cụ SAU tin khách gần nhất.
  const da = (say: string) => JSON.stringify({ delivery_answer: { kind: "DIRECT", say } });
  assert.equal(turnDeliverySay([{ role: "user", content: [{ type: "text", text: "Bao giờ nhận?" }] }, { role: "assistant", content: [{ type: "tool_use" }] }, { role: "user", content: [{ type: "tool_result", content: da("Dạ bưu tá đang giao") }] }]), "Dạ bưu tá đang giao");
  assert.equal(turnDeliverySay([{ role: "user", content: [{ type: "tool_result", content: da("cũ") }] }, { role: "user", content: [{ type: "text", text: "Hôm nào có hàng?" }] }]), null, "kết quả của lượt cũ không phải căn cứ");

  // Lời nhắc hậu mãi + mô tả công cụ: câu hỏi KHI NÀO đi theo `delivery_answer`, không đọc «status» thay giờ giao.
  const p = postSalePrompt({ phase: "AWAITING_SHIPMENT", receivedBy: null, orderId: "erp-x", source: "" }, "X");
  assert.match(p, /delivery_answer/);
  assert.match(p, /KHÔNG đọc «status» thay cho giờ giao/);
  assert.match(p, /KHÔNG báo giá lại, KHÔNG hỏi lại địa chỉ, KHÔNG mời mua thêm/);
  assert.match(postSalePrompt({ phase: "IN_TRANSIT", receivedBy: null, orderId: "erp-x", source: "" }, "X"), /delivery_answer/);
  const def = toolDefsFor(parseSalesChatbotConfig(null)).find((d) => d.name === "get_order_status");
  assert.match(def?.description ?? "", /delivery_answer/);
  // Công cụ nhận câu khách + tin shop gần đây từ engine (không tự đoán).
  assert.match(readFileSync("lib/sales-chatbot/tools.ts", "utf8"), /orderStatusFor\(ctx\.conversationId, state, ctx\.commentTurn === true, \{ text: ctx\.lastUserText, shopTexts: ctx\.recentSaid \?\? \[\]/);
}

// ─────────────────────────── ENGINE THẬT (`chatTurn`, model giả) ───────────────────────────

const STATUS_REPLY = "Dạ đơn mình hiện đang ở trạng thái: Shop đã nhận đơn — chưa có thông tin vận chuyển ạ.";
/** Ca thật: khách ĐÃ lên đơn (đơn Pancake gắn hội thoại) rồi mới hỏi — hàng rào khẳng định «đã nhận đơn» qua được, chỉ chốt chặn lịch giao chặn. */
const withOrder = (id: string) => async ({ conversationId }: { conversationId: string }) => {
  const db = await getDb();
  await db.insert(schema.orders).values({ id, insertedAt: new Date(Date.now() - 30 * 60_000), salesConversationId: conversationId, totalPrice: 280_000, stage: "CONFIRMED" });
};
const ENGINE_CASES: GoldenCase[] = [
  {
    key: "p855-web-tu-viet-trang-thai",
    title: "Web: model KHÔNG gọi get_order_status, tự viết câu trạng thái + hứa «chiều nay» cho «Hôm nào có hàng?»",
    shop: "food",
    channel: "WEB",
    turns: [{ say: "Hôm nào có hàng?", before: withOrder("7712345000000855001"), ai: [() => [say(STATUS_REPLY), say("Dạ chiều nay giao chị nhé")]] }],
  },
  {
    key: "p855-fanpage-hua-chieu-nay",
    title: "Fanpage: model hứa «chiều nay giao» ⇒ chặn, bot im (luật kênh nhắn tin), chuyển nhân viên",
    shop: "food",
    channel: "FANPAGE",
    turns: [{ say: "Hôm nào có hàng?", before: withOrder("7712345000000855002"), ai: [() => [say("Dạ chiều nay giao chị nhé")]] }],
  },
  {
    key: "p855-web-hoi-trang-thai",
    title: "Web: hỏi TRẠNG THÁI ⇒ câu trạng thái không bị chặn",
    shop: "food",
    channel: "WEB",
    turns: [{ say: "đơn của em sao rồi", before: withOrder("7712345000000855003"), ai: [() => [say(STATUS_REPLY)]] }],
  },
];

async function runEngineCases() {
  const notified = new Map<string, number>();
  const got = await runGoldenCases(ENGINE_CASES, {
    orgSuffix: "-p855",
    afterCase: async (c) => {
      const db = await getDb();
      const rows = await db.select({ body: schema.notifications.body }).from(schema.notifications);
      notified.set(c.key, rows.filter((r) => r.body.includes("Hỏi lịch giao")).length - [...notified.values()].reduce((a, b) => a + b, 0));
    },
  });
  const web = got.get("p855-web-tu-viet-trang-thai")!;
  assert.deepEqual(web.turns[0].shown, [DELIVERY_HANDOFF_TEXT], `web: chỉ câu chuyển nhân viên tới khách — ${JSON.stringify(web.turns[0].shown)}`);
  assert.equal(web.final.status, "HANDOFF");
  assert.match(web.final.handoffReason ?? "", /^Hỏi lịch giao — «Hôm nào có hàng\?»/);
  assert.equal(notified.get("p855-web-tu-viet-trang-thai"), 1, "chuyển nhân viên đúng MỘT lần dù hai câu cùng vi phạm");
  const fb = got.get("p855-fanpage-hua-chieu-nay")!;
  assert.deepEqual(fb.turns[0].shown, [], `fanpage: bot im khi chuyển người — ${JSON.stringify(fb.turns[0].shown)}`);
  assert.equal(fb.final.status, "HANDOFF");
  assert.match(fb.final.handoffReason ?? "", /^Hỏi lịch giao/);
  assert.equal(notified.get("p855-fanpage-hua-chieu-nay"), 1);
  const st = got.get("p855-web-hoi-trang-thai")!;
  assert.deepEqual(st.turns[0].shown, [STATUS_REPLY], "câu hỏi trạng thái ⇒ câu trạng thái gửi bình thường");
  assert.notEqual(st.final.status, "HANDOFF");
}

// ─────────────────────────── TỔ CHỨC THẬT ───────────────────────────

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

type Out = { orders: { order_code: string; status?: string }[]; delivery_answer?: { kind: string; say?: string; say_to_customer?: string }; note: string };

async function run() {
  await withOrganization(ORG, async () => {
    const db = await getDb();
    const cfg = parseSalesChatbotConfig(null);
    const now = Date.now();
    const conv = async () => (await db.insert(schema.salesChatConversations).values({ channel: "WEB" }).returning({ id: schema.salesChatConversations.id }))[0].id;
    const order = async (id: string, conversationId: string, extra: Partial<typeof schema.orders.$inferInsert> = {}) => {
      await db.insert(schema.orders).values({ id, insertedAt: new Date(now - 30 * 60_000), salesConversationId: conversationId, totalPrice: 280_000, stage: "CONFIRMED", ...extra });
    };
    const ask = async (conversationId: string, text: string, recentSaid: string[] = []) => {
      const r = await executeTool("get_order_status", {}, { conversationId, channel: "WEB", config: cfg, state: {} as ChatState, lastUserText: text, recentSaid, agent: { name: "t", source: "t" } });
      assert.ok(!r.isError, r.content);
      return { ...r, v: JSON.parse(r.content) as Out };
    };

    // Ca ThivanNguyen (dữ liệu giả): đơn 1kg chả cá đã chốt, chưa vận đơn, hỏi «Hôm nào có hàng?».
    const c1 = await conv();
    await order("erp-p855-o1", c1);
    const r1 = await ask(c1, "Hôm nào có hàng?");
    assert.ok(r1.requireHuman && /^Hỏi lịch giao — «Hôm nào có hàng\?»/.test(r1.requireHuman), `máy chủ chuyển nhân viên: ${r1.requireHuman}`);
    assert.ok(!r1.content.includes(GENERIC_STATUS_PHRASE) && !r1.content.includes("Shop đã nhận đơn"), `không đưa câu trạng thái cho model đọc thay giờ giao: ${r1.content}`);
    assert.equal(r1.v.delivery_answer?.kind, "HANDOFF");
    assert.equal(r1.v.delivery_answer?.say_to_customer, DELIVERY_HANDOFF_TEXT);
    assert.ok(!PROMISE_WORDS.test(r1.v.delivery_answer?.say_to_customer ?? ""), "không hứa giờ");
    // Hôm nay / ngày mai / giao gấp, chưa có dữ liệu ⇒ không hứa.
    for (const t of ["Chiều nay giao được không?", "mai co hang khong", "giao gấp được không"]) {
      const r = await ask(c1, t);
      assert.ok(r.requireHuman && r.v.delivery_answer?.kind === "HANDOFF" && !PROMISE_WORDS.test(r.v.delivery_answer.say_to_customer ?? ""), `${t}: ${r.content}`);
    }
    // Câu hỏi TRẠNG THÁI giữ hành vi cũ: nói đúng status, không chuyển người.
    const st = await ask(c1, "Đơn của em sao rồi?");
    assert.equal(st.requireHuman, undefined);
    assert.match(st.v.orders[0]?.status ?? "", /chưa có thông tin vận chuyển/);
    assert.equal(st.v.delivery_answer, undefined);

    // Có vận đơn + chứng từ ĐVVC + ETA đọc được ⇒ trả lời trực tiếp.
    const c2 = await conv();
    await order("erp-p855-o2", c2);
    await db.insert(schema.shipments).values({ orderId: "erp-p855-o2", vtpOrderNumber: "P855000002", stage: "IN_TRANSIT", vtpStatusName: "Đang vận chuyển", vtpStatusDate: new Date(now - 60 * 60_000), vtpSyncSource: "VTP_WEBHOOK", expectedDelivery: vnDdmmyyyy(2) });
    const r2 = await ask(c2, "Bao giờ nhận được?");
    assert.equal(r2.requireHuman, undefined, r2.content);
    assert.ok(r2.v.delivery_answer?.kind === "DIRECT" && /dự kiến giao khoảng ngày/.test(r2.v.delivery_answer.say ?? ""), r2.content);
    // Nhân viên đã nhắn «Chiều nay giao ạ» ⇒ AI không nói khác (không đọc ETA trái lời nhân viên), chuyển về nhân viên.
    const r3 = await ask(c2, "Bao giờ nhận được?", [`${DELIVERY_SHOP_SAID_PREFIX} Chiều nay giao ạ`]);
    assert.ok(r3.requireHuman && /nhân viên đã hẹn/.test(r3.requireHuman) && r3.v.delivery_answer?.kind === "HANDOFF", r3.content);
    assert.ok(!r3.content.includes("dự kiến giao"), "không đưa ETA trái lời nhân viên");

    // Ngày hẹn giao đã ghi trên đơn ⇒ nói ngày hẹn.
    const c4 = await conv();
    await order("erp-p855-o4", c4, { customerPromisedAt: new Date(now + 3 * 86_400_000) });
    const r4 = await ask(c4, "hom nao co hang");
    assert.ok(r4.v.delivery_answer?.kind === "DIRECT" && /hẹn giao ngày/.test(r4.v.delivery_answer.say ?? ""), r4.content);
  });
}

export async function testP0855DeliveryIntent() {
  testClassifier();
  testAnswer();
  await cleanup();
  await provisionOrganization({ code: ORG, name: ORG, plan: "starter", modules: ["customers", "products", "orders", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "LichGiao@12345" }, source: "TEST", actor: null });
  try {
    await run();
  } finally {
    await cleanup();
  }
  await runEngineCases();
  console.log(
    `✓ P0 #855 hỏi lịch giao ≠ hỏi trạng thái: ${DELIVERY_GOLDEN.length}/${DELIVERY_GOLDEN.length} câu thời gian giao ⇒ DELIVERY_TIME · câu trạng thái ⇒ ORDER_STATUS · câu không liên quan ⇒ null · đơn chưa vận đơn hỏi «Hôm nào có hàng?» ⇒ máy chủ chuyển nhân viên, không câu trạng thái, không hứa giờ · hôm nay / ngày mai / giao gấp chưa có dữ liệu ⇒ không hứa · ETA ĐVVC đọc được / ngày hẹn ghi trên đơn ⇒ trả lời trực tiếp · nhân viên đã hẹn ⇒ AI không nói khác · chốt chặn chữ model qua chatTurn (web: câu chuyển nhân viên · fanpage: im · một lần báo)`,
  );
}

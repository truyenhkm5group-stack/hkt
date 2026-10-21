/**
 * P0 21/10/2026 — AI SALES TRẢ LỜI SAI KHI KHÁCH KHIẾU NẠI GIAO CHẬM (HSLC, đơn #BD31267C, đã che tên / SĐT / địa chỉ):
 *
 *  · Đơn 1kg chả mực chốt 16/10, ERP không có vận đơn (HSLC tạo vận đơn NGOÀI ERP). 21/10 khách nhắn «Đặt 1kg chả mực lâu rồi mà ko thấy
 *    giao hàng vậy shop». Không bộ nhận diện nào bắt câu này ⇒ lượt đi vào AI: bot tự hứa «gửi ngay / chuẩn bị gửi», hỏi khách còn băn
 *    khoăn gì, hội thoại không chuyển người, bộ nhắc gửi thêm hai tin chăm sóc chung.
 *  · Bản sửa (dùng lại hậu mãi có sẵn): `customerDeliveryDelaySignal` (có dấu / không dấu / viết tắt) + «đơn đâu rồi» khi đơn quá
 *    `DWELL_SLA.PENDING.warning` mà ERP chưa có thông tin vận chuyển ⇒ `COMPLAINT · DELIVERY_DELAY` ⇒ máy chủ chuyển người TRƯỚC, rồi MỘT
 *    câu xin lỗi + đã chuyển nhân viên (không mốc nào), mở ca CSKH `URGE_DELIVERY` khoá theo đơn, báo nhân viên một lần mỗi đơn.
 *
 * Ca: đúng câu #BD31267C · hỏi trạng thái bình thường · than chậm có dấu / không dấu · hàng gửi ngoài ERP · giao thất bại / đã hoàn ·
 * ĐVVC báo đã giao mà khách chưa nhận · hỏi thời gian giao trước khi mua · «Ok» sau chuyển người không đóng việc. Dữ liệu giả.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { and, eq, like } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { AUTO_CONFIRM_COMPLETE_SETTING_KEY } from "@/lib/constants/manual-orders";
import { CHAT_DELAY_CASE_SOURCE, chatDelayCaseRow } from "@/lib/cs/chat-delay-case";
import { CLAIM_SAFE_TEXT, detectClaims } from "@/lib/sales-chatbot/claim-guard";
import { customerComplaintSignal, customerDeliveryDelaySignal, customerOrderWhereSignal, customerPhaseOf, ORDER_WHERE_COMPLAINT_HOURS, type LifecycleSnapshot } from "@/lib/sales-chatbot/lifecycle";
import { customerOrderStatus, NO_SHIPMENT_YET } from "@/lib/sales-chatbot/order-status-shared";
import { customerRequestKinds } from "@/lib/sales-chatbot/postorder-release";
import { foldVi } from "@/lib/sales-chatbot/text";
import { setSettingJson } from "@/lib/settings";
import { waitingOrderVerdict } from "@/scripts/org-order-audit";
import { DELIVERY_GOLDEN, STATUS_GOLDEN, UNRELATED_GOLDEN } from "./p0-855-delivery-intent.test";
import { runGoldenCases, say, tool, type GoldenCase } from "./sales-agent-golden/harness";

/** Đúng câu khách ca #BD31267C (không mang PII). */
const CHAU = "Đặt 1kg chả mực lâu rồi mà ko thấy giao hàng vậy shop";

export const DELAY_GOLDEN = [
  CHAU,
  "đặt lâu rồi chưa thấy giao",
  "mãi chưa nhận",
  "sao chưa gửi",
  "chờ lâu quá",
  "hứa giao mà chưa thấy",
  "dat lau roi chua thay giao",
  "sao chua gui hang",
  "mai chua nhan dc hang",
  "đợi mãi không thấy ship",
  "lâu quá vậy shop chưa thấy hàng",
  "sao lâu thế chưa nhận được hàng",
  "đơn chị sao chưa giao vậy em",
  "sao giao chậm vậy em?",
  "giao cham qua",
];
/** Câu hỏi / câu thường — KHÔNG được nhận nhầm là than chậm (bắt nhầm ⇒ bot im với khách đang hỏi mua). */
export const NOT_DELAY_GOLDEN = [
  "bao giờ giao hàng vậy shop",
  "khi nào nhận được hàng em",
  "đơn của chị giao chưa em",
  "ship mấy ngày thì tới em",
  "Ok",
  "bảo quản được lâu không em",
  "chị chưa gửi địa chỉ nhé",
  "ko giao được tỉnh xa à em",
  "cho chị 1kg chả mực",
  "giao hàng có được xem hàng không",
  "để lâu có bị hỏng không",
  "em gửi chị số tài khoản nhé",
  "chưa nhận được tin nhắn của em",
  "giao mất bao lâu em",
  "ship lâu không em",
  "chờ mấy ngày thì có hàng",
  "giao cho mai nhé",
  "mai giao được không em",
  "giao lâu không shop",
  "đặt bây giờ thì bao lâu nhận",
  "giao cham xiu cung duoc",
  "ship cham cung duoc em",
  "hàng bị mốc rồi phải làm sao?",
];
const WHERE_GOLDEN = ["đơn tôi đâu rồi", "don toi dau r", "hàng đâu rồi em", "đơn của chị đâu vậy"];

function testThuan() {
  for (const t of DELAY_GOLDEN) assert.ok(customerDeliveryDelaySignal(t), `«${t}» là than giao chậm`);
  for (const t of [...NOT_DELAY_GOLDEN, ...DELIVERY_GOLDEN, ...STATUS_GOLDEN, ...UNRELATED_GOLDEN]) assert.ok(!customerDeliveryDelaySignal(t), `«${t}» KHÔNG phải than giao chậm`);
  for (const t of WHERE_GOLDEN) assert.ok(customerOrderWhereSignal(t), `«${t}» là hỏi đơn đâu`);
  assert.ok(!customerComplaintSignal(CHAU), "bộ nhận diện khiếu nại chung không bắt câu #BD31267C — đúng lỗ hổng của ca này");
  assert.equal(ORDER_WHERE_COMPLAINT_HOURS, 48, "ngưỡng «đơn đâu rồi» là DWELL_SLA.PENDING.warning — không số mới");

  const snap = (o: Partial<Pick<LifecycleSnapshot, "order" | "fulfillment" | "salesStage" | "orderId">>) => ({ order: "CONFIRMED" as const, fulfillment: "NONE" as const, salesStage: "AWAITING_CONFIRMATION" as const, orderId: "erp-bd31267c-x", ...o });
  const claims = (text: string) => ({ receipt: false, complaint: customerComplaintSignal(text), delay: customerDeliveryDelaySignal(text), whereAsk: customerOrderWhereSignal(text) });

  // (1) Đúng ca #BD31267C: đơn chốt 5 ngày, ERP không có vận đơn ⇒ khiếu nại giao chậm.
  const chau = customerPhaseOf(snap({}), claims(CHAU), 5);
  assert.deepEqual([chau.phase, chau.complaintKind, chau.fulfillment, chau.orderAgeDays], ["COMPLAINT", "DELIVERY_DELAY", "NONE", 5]);
  // (2) Hỏi trạng thái bình thường ⇒ KHÔNG khiếu nại.
  for (const t of ["đơn của chị giao chưa em", "bao giờ giao hàng vậy shop"]) assert.equal(customerPhaseOf(snap({}), claims(t), 1).phase, "AWAITING_SHIPMENT", `«${t}» là câu hỏi`);
  // (3) «đơn đâu rồi» — chỉ là khiếu nại khi quá ngưỡng VÀ ERP chưa có thông tin vận chuyển.
  assert.equal(customerPhaseOf(snap({}), claims("đơn tôi đâu rồi"), 1).phase, "AWAITING_SHIPMENT", "24 giờ < 48 ⇒ còn là câu hỏi");
  const where = customerPhaseOf(snap({}), claims("đơn tôi đâu rồi"), 3);
  assert.deepEqual([where.phase, where.complaintKind], ["COMPLAINT", "DELIVERY_DELAY"]);
  assert.match(where.source, /72 giờ, ERP chưa có thông tin vận chuyển/);
  assert.equal(customerPhaseOf(snap({ fulfillment: "SHIPPING" }), claims("đơn tôi đâu rồi"), 3).phase, "IN_TRANSIT", "đang giao có chứng từ ⇒ đọc trạng thái, không khiếu nại");
  // (4) Than chậm khi kiện đang đi (giao thất bại vẫn là SHIPPING ở chiều logistics) ⇒ khiếu nại, lý do nói kiện đang trên đường.
  assert.equal(customerPhaseOf(snap({ fulfillment: "SHIPPING" }), claims("sao lâu thế chưa nhận được hàng"), 4).complaintKind, "DELIVERY_DELAY");
  // (5) ĐVVC báo ĐÃ GIAO mà khách than chưa nhận ⇒ khiếu nại, nguồn nói rõ mâu thuẫn chứng từ.
  const disputed = customerPhaseOf(snap({ fulfillment: "DELIVERED" }), claims("đặt lâu rồi chưa thấy giao"), 4);
  assert.deepEqual([disputed.phase, disputed.complaintKind], ["COMPLAINT", "DELIVERY_DELAY"]);
  assert.match(disputed.source, /ĐÃ GIAO \(mâu thuẫn/);
  // (6) Đơn ĐÃ HOÀN (giao không thành công) mà khách hỏi sao chưa nhận ⇒ khiếu nại, khách chưa được báo.
  const returned = customerPhaseOf(snap({ order: "RETURNED" }), { ...claims("sao chưa nhận được hàng vậy shop"), notReceived: true }, 6);
  assert.deepEqual([returned.phase, returned.complaintKind], ["COMPLAINT", "DELIVERY_DELAY"]);
  assert.match(returned.source, /HOÀN/);
  // (7) Hỏi thời gian giao TRƯỚC KHI MUA (chưa có đơn) ⇒ không bao giờ là khiếu nại, kể cả câu có chữ «chưa giao».
  for (const t of ["giao mất bao lâu em", "sao chưa giao vậy"]) assert.equal(customerPhaseOf(snap({ order: "NONE", orderId: null, salesStage: "CONSULTING" }), claims(t), null).phase, "PRE_SALE", `«${t}» trước bán`);
  assert.equal(customerPhaseOf(snap({}), claims("sao giao chậm vậy em?"), 2).complaintKind, "DELIVERY_DELAY", "«sao giao chậm vậy» khớp cả khiếu nại chung — giao chậm xét TRƯỚC");
  // Khiếu nại chất lượng vẫn là khiếu nại CHUNG (luồng cũ).
  assert.equal(customerPhaseOf(snap({}), claims("hàng bị mốc rồi phải làm sao?"), 2).complaintKind, "GENERAL");

  // Bộ giữ chuyển người: lời than chậm là YÊU CẦU của khách ⇒ hội thoại không bị trả về AI.
  assert.deepEqual(customerRequestKinds([CHAU]), ["COMPLAINT"]);
  assert.deepEqual(customerRequestKinds(["Ok"]), [], "«Ok» không phải yêu cầu — và cũng không đóng khiếu nại");

  // Câu xin lỗi: không khẳng định, không hứa mốc, không nói đã gửi.
  assert.deepEqual(detectClaims(CLAIM_SAFE_TEXT.DELIVERY_DELAY), []);
  assert.doesNotMatch(foldVi(CLAIM_SAFE_TEXT.DELIVERY_DELAY), /gui ngay|chuan bi gui|hom nay|ngay mai|da gui|dang giao/);
  // get_order_status khi ERP không có vận đơn: nói đúng điều ERP biết, không «đã gửi», không «chưa gửi», không ngày giao.
  assert.equal(NO_SHIPMENT_YET, "Shop đã nhận đơn — chưa có thông tin vận chuyển trên hệ thống");
  const st = customerOrderStatus({ orderStage: "CONFIRMED", shipment: null, manual: true } as Parameters<typeof customerOrderStatus>[0]);
  assert.equal(st.text, NO_SHIPMENT_YET);
  assert.doesNotMatch(foldVi(st.text), /da gui|chua gui|hom nay|ngay mai/);

  // Engine: lượt chuyển người GHI TRƯỚC, câu xin lỗi gửi SAU (mục 6 của P0) — đọc mã nguồn, vì PGlite không cho thấy thứ tự hai lệnh ghi.
  const core = readFileSync("lib/sales-chatbot/engine.ts", "utf8");
  assert.match(core, /if \(delay\) \{\n\s*await bump\(\{ status: "HANDOFF"[^\n]*\n(?:[^\n]*\n){0,3}\s*await reply\(conv, seq, CLAIM_SAFE_TEXT\.DELIVERY_DELAY\);/, "giao chậm: bump HANDOFF trước reply");
  // Ca CSKH: khoá theo ĐƠN, lý do + thời gian chờ + điều ERP biết, không PII ngoài cột khách.
  const row = chatDelayCaseRow({ conversationId: "conv-1", orderId: "erp-bd31267c-x", shortCode: "BD31267C", waitedDays: 5.4, shipInfo: "ERP chưa có thông tin vận chuyển — kiểm POS / ĐVVC", customer: null });
  assert.deepEqual([row.kind, row.status, row.source, row.dedupeKey], ["URGE_DELIVERY", "OPEN", CHAT_DELAY_CASE_SOURCE, "sales-chat:delay:erp-bd31267c-x"]);
  assert.match(row.title, /đơn #BD31267C/);
  assert.match(row.detail, /chờ 5 ngày .*ERP chưa có thông tin vận chuyển/);
  // ops `org-order-audit --waiting`: ưu tiên + nguyên nhân, ngưỡng lấy từ DWELL_SLA.PENDING.
  const w = (o: Partial<Parameters<typeof waitingOrderVerdict>[0]>) => waitingOrderVerdict({ ageHours: 120, hasShipment: false, leftWarehouse: false, complained: false, convStatus: "WAITING", ...o });
  assert.deepEqual(w({ complained: true, ageHours: 5 })?.priority, "P1_KHACH_THAN", "khách đã than ⇒ P1 bất kể tuổi");
  assert.match(w({ complained: true })?.cause ?? "", /bot VẪN đang tự trả lời/, "ca #BD31267C: bot còn trả lời hội thoại khách đang than");
  assert.doesNotMatch(w({ complained: true, convStatus: "HANDOFF" })?.cause ?? "", /bot VẪN/);
  assert.equal(w({})?.priority, "P2_QUA_NGUONG_HONG", "120 giờ ≥ 96");
  assert.equal(w({ ageHours: 50 })?.priority, "P3_QUA_NGUONG_CANH_BAO", "50 giờ ≥ 48");
  assert.equal(w({ ageHours: 47 }), null, "trong hạn");
  assert.equal(w({ leftWarehouse: true, complained: true }), null, "đã rời kho ⇒ việc của tháp giao vận");
  assert.match(w({})?.cause ?? "", /ERP không có vận đơn — kiểm POS \/ ĐVVC \(chưa biết, không phải «chưa gửi»\)/);
  assert.match(w({ hasShipment: true })?.cause ?? "", /có vận đơn nhưng chưa rời kho/);
  assert.equal(chatDelayCaseRow({ conversationId: "conv-2", orderId: "erp-bd31267c-x", shortCode: null, waitedDays: null, shipInfo: "", customer: null }).dedupeKey, row.dedupeKey, "hội thoại khác cùng đơn ⇒ cùng một ca");
}

const ADDR = "9 Hai Bà Trưng, Phường Hoàn Kiếm, Thành phố Hà Nội";
const INFO = (phone: string) => `Cho chị 1kg chả mực giã tay, Lan ${phone}, ${ADDR}`;
const orderInfo = (phone: string) => [
  () => [tool("create_customer", { name: "Lan", phone, address: ADDR })],
  ({ v }: { v: (sku: string) => string }) => [tool("create_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })],
  () => [say("Dạ em lên đơn 1kg chả mực giã tay cho mình rồi ạ.")],
];
const ageOrder = (days: number) => async (ctx: { conversationId: string }) => {
  const db = await getDb();
  await db.update(schema.orders).set({ insertedAt: new Date(Date.now() - days * 86_400_000) }).where(eq(schema.orders.salesConversationId, ctx.conversationId));
};
/** Nếu model bị gọi ở lượt mà máy chủ phải tự quyết, kịch bản rỗng trả «[HẾT KỊCH BẢN]» — bài kiểm đếm số vòng model. */
const NO_MODEL: GoldenCase["turns"][number]["ai"] = [];

const CASES: GoldenCase[] = [
  { key: "delay-bd31267c", title: "Đúng ca #BD31267C: đơn chốt 5 ngày, ERP chưa có vận đơn, khách than ⇒ chuyển người TRƯỚC, MỘT câu xin lỗi, ca CSKH, «Ok» không làm gì", shop: "food", channel: "FANPAGE", turns: [
    { say: INFO("0961004201"), ai: orderInfo("0961004201") },
    { say: CHAU, before: ageOrder(5), ai: NO_MODEL },
    { say: "Ok", ai: NO_MODEL },
    { say: "sao chưa giao vậy shop", ai: NO_MODEL },
  ] },
  { key: "delay-hoi-thuong", title: "Hỏi trạng thái bình thường (đơn 1 ngày) ⇒ không chuyển người, AI trả lời", shop: "food", channel: "FANPAGE", turns: [
    { say: INFO("0961004202"), ai: orderInfo("0961004202") },
    { say: "đơn của chị giao chưa em", before: ageOrder(1), ai: [() => [say("Dạ em kiểm tra giúp mình ạ.")]] },
  ] },
  { key: "delay-don-dau-qua-han", title: "«đơn tôi đâu rồi» khi đơn đã 3 ngày, ERP chưa có thông tin vận chuyển ⇒ khiếu nại giao chậm", shop: "food", channel: "FANPAGE", turns: [
    { say: INFO("0961004203"), ai: orderInfo("0961004203") },
    { say: "đơn tôi đâu rồi", before: ageOrder(3), ai: NO_MODEL },
  ] },
];

async function testChatTurn() {
  const seen = new Set<string>();
  const out = await runGoldenCases(CASES, {
    orgSuffix: "-dly",
    beforeCase: async () => {
      await setSettingJson(AUTO_CONFIRM_COMPLETE_SETTING_KEY, { enabled: true });
    },
    afterCase: async (c, ctx, t) => {
      seen.add(c.key);
      const db = await getDb();
      const cases = await db.select().from(schema.csCases).where(eq(schema.csCases.conversationId, ctx.conversationId));
      const notes = await db.select({ key: schema.notifications.dedupeKey }).from(schema.notifications).where(and(eq(schema.notifications.entityId, ctx.conversationId), like(schema.notifications.dedupeKey, "sales-chat:complaint-delay:%")));
      const [o] = await db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.salesConversationId, ctx.conversationId));
      if (c.key === "delay-bd31267c") {
        assert.ok(o, "lượt 1 đã chốt đơn");
        const [, complain, ok, again] = t.turns;
        assert.equal(complain.rounds.length, 0, `máy chủ tự quyết — không gọi model: ${JSON.stringify(complain.rounds)}`);
        assert.deepEqual(complain.shown, [CLAIM_SAFE_TEXT.DELIVERY_DELAY], "MỘT câu xin lỗi + đã chuyển nhân viên, kể cả trên fanpage");
        assert.equal(complain.status, "HANDOFF");
        assert.match(t.final.handoffReason ?? "", /^Khiếu nại giao chậm — lời khách: giao chậm \/ chưa nhận được hàng \(đơn #(?:<MÃ ĐƠN>|[A-Z0-9]+)\) · khách đã chờ 5 ngày kể từ lúc lên đơn · ERP chưa có thông tin vận chuyển — kiểm POS \/ ĐVVC$/);
        for (const x of [ok, again]) {
          assert.deepEqual([x.rounds.length, x.shown, x.status], [0, [], "HANDOFF"], `«${x.customer}» sau chuyển người ⇒ bot im, không chăm sóc chung, không mời mua, khiếu nại không đóng`);
        }
        assert.equal(cases.length, 1, "MỘT ca CSKH dù khách nhắn than hai lần");
        assert.deepEqual([cases[0].kind, cases[0].status, cases[0].source, cases[0].orderId, cases[0].assignee, cases[0].assigneeUserId], ["URGE_DELIVERY", "OPEN", CHAT_DELAY_CASE_SOURCE, o.id, "", null], "ca mở, không gán người (sở hữu theo phòng)");
        assert.match(cases[0].detail, /khách đã chờ 5 ngày/);
        assert.deepEqual(notes.map((n) => n.key), [`sales-chat:complaint-delay:${ctx.conversationId}:${o.id}`], "báo nhân viên MỘT lần cho đơn");
        const all = t.turns.slice(1).flatMap((x) => x.shown).join("\n");
        assert.doesNotMatch(foldVi(all), /gui ngay|chuan bi gui|hom nay|mua them|con ban khoan/, "không hứa mốc, không mời mua, không hỏi băn khoăn");
      }
      if (c.key === "delay-hoi-thuong") {
        const q = t.turns[1];
        assert.ok(q.rounds.length > 0 && q.status !== "HANDOFF", `câu hỏi thường ⇒ AI trả lời, không chuyển người: ${q.status}`);
        assert.equal(cases.length, 0);
        assert.equal(notes.length, 0);
      }
      if (c.key === "delay-don-dau-qua-han") {
        const q = t.turns[1];
        assert.deepEqual([q.rounds.length, q.shown, q.status], [0, [CLAIM_SAFE_TEXT.DELIVERY_DELAY], "HANDOFF"]);
        assert.match(t.final.handoffReason ?? "", /^Khiếu nại giao chậm — lời khách hỏi đơn đâu — đơn đã 72 giờ, ERP chưa có thông tin vận chuyển/);
        assert.equal(cases.length, 1);
      }
    },
  });
  assert.deepEqual([...seen].sort(), CASES.map((c) => c.key).sort(), "mọi ca đã chạy");
  assert.equal(out.size, CASES.length);
}

export async function testP0ComplaintDeliveryDelay(): Promise<void> {
  testThuan();
  await testChatTurn();
  console.log("✓ P0 khiếu nại giao chậm: câu #BD31267C · có dấu / không dấu ⇒ chuyển người TRƯỚC + MỘT câu xin lỗi không mốc · ca CSKH URGE_DELIVERY một ca mỗi đơn · «đơn đâu rồi» chỉ khi quá 48 giờ · ĐVVC báo đã giao / đơn hoàn · «Ok» không đóng việc · câu hỏi thường không bị nhận nhầm");
}

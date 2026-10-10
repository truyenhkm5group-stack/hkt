/**
 * ═══════════ QUY KẾT TỪNG ĐƠN + FOLLOW-UP THU HỒI + KINH TẾ BOT (docs/revenue-attribution.md) ═══════════
 *
 * Khoá:
 *  · ba nhãn AI_ONLY / AI_ASSISTED / HUMAN_ONLY theo đúng định nghĩa: chỉ việc BÁN HÀNG THẬT của AI (báo giá · nháp · mời
 *    mua thêm · SĐT) mới là góp công — một câu bot trả lời thì không; người chạm vào SAU mốc chốt không làm mất «AI tự bán»;
 *    công của lượt mua trước không chảy sang lượt mua sau; đơn không có sự kiện ⇒ CHƯA BIẾT, không phải «người bán»;
 *  · follow-up thu hồi = đơn lên SAU tin khách trả lời lời nhắc, cùng lượt mua; khách tự quay lại không qua lời nhắc thì không;
 *  · kinh tế bot: chưa có đơn / mẫu dưới ngưỡng / chi phí 0 hay chưa biết ⇒ `null`, không phải 0;
 *  · trên CSDL tổ chức thật: tổng ba nhãn + chưa quy kết = số đơn của kỳ, doanh thu giao thành công qua ORDER_OUTCOME;
 *  · LÃI GỘP ĐÃ GIAO theo nhãn: giá vốn qua đường chung của Báo cáo lợi nhuận (`orderCogsFast`); đơn giá vốn 0 = CHƯA BIẾT,
 *    đứng riêng — không cộng vào lãi với giá vốn 0; chưa đơn nào biết giá vốn ⇒ biên `null`, không phải 0%;
 *  · THUỘC TÍNH CHỒNG AI_RECOVERED / AI_UPSELL: tập con của nhãn AI, không bao giờ cộng vào tổng; bảng nhãn chính không đổi
 *    một số khi có thuộc tính chồng; upsell của đơn huỷ / hoàn / chưa ngã ngũ không vào «đã giao»; số tiền thiếu ⇒ `null`;
 *    thu hồi mà nhãn chính là người bán ⇒ ngoài thuộc tính chồng, đếm ở `outsideAiLabels`; drill-down phân trang không trùng.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { resolvePermissions } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/session";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { MANUAL_ORDER_ORIGIN } from "@/lib/constants/manual-orders";
import { confirmManualDeliveryCore } from "@/lib/records/order-create";
import { listAttributedOrders, loadOrderAttribution } from "@/lib/sales-chatbot/attribution";
import {
  ATTRIBUTION_VERSION,
  attributeOrder,
  attributionOverlays,
  attributionTable,
  deliveredCogs,
  followupRecovery,
  grossMarginOf,
  orderUpsell,
  overlayTable,
  type AttributedOrder,
  type AttributionEvent,
  type OrderFacts,
} from "@/lib/sales-chatbot/attribution-shared";
import { recordConversationEvent } from "@/lib/sales-chatbot/events";
import { salesEconomics } from "@/lib/sales-chatbot/performance-shared";

const ORG = "quy-ket-don";
const T0 = new Date("2026-10-01T08:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const ev = (type: string, actorKind: string, min: number, extra: Partial<AttributionEvent> = {}): AttributionEvent => ({ type, actorKind, occurredAt: at(min), cycle: 0, orderId: null, ...extra });

function testPure() {
  const O = "erp-o1";
  // Bot tư vấn → SĐT → nháp → khách đồng ý (tác nhân CUSTOMER) ⇒ AI tự bán.
  const botSale = [ev("message.received", "CUSTOMER", 0), ev("ai.replied", "AI", 1), ev("quote.given", "AI", 1), ev("customer.identified", "CUSTOMER", 5), ev("order.drafted", "AI", 6, { orderId: O }), ev("order.confirmed", "CUSTOMER", 8, { orderId: O })];
  assert.equal(attributeOrder(O, botSale), "AI_ONLY");
  // Người chạm vào SAU mốc chốt (khách hỏi giao hàng) ⇒ vẫn AI tự bán.
  assert.equal(attributeOrder(O, [...botSale, ev("human.took_over", "HUMAN", 30)]), "AI_ONLY");
  // Chuyển người TRƯỚC mốc chốt, bot chốt sau khi người trả lại ⇒ AI góp công.
  assert.equal(attributeOrder(O, [...botSale.slice(0, 5), ev("handoff.requested", "AI", 7), ev("order.confirmed", "CUSTOMER", 20, { orderId: O })]), "AI_ASSISTED");

  const H = "erp-h1";
  // Người lên đơn trong khung chat; trước đó bot đã báo giá bằng công cụ ⇒ AI góp công.
  assert.equal(attributeOrder(H, [ev("message.received", "CUSTOMER", 0), ev("quote.given", "AI", 1), ev("human.took_over", "HUMAN", 10), ev("order.confirmed", "HUMAN", 12, { orderId: H })]), "AI_ASSISTED");
  // Bot chỉ chào (ai.replied) rồi người bán ⇒ NGƯỜI BÁN — một câu trả lời không phải góp công.
  assert.equal(attributeOrder(H, [ev("message.received", "CUSTOMER", 0), ev("ai.replied", "AI", 1), ev("human.took_over", "HUMAN", 3), ev("order.confirmed", "HUMAN", 12, { orderId: H })]), "HUMAN_ONLY");
  // Bot báo giá ở lượt mua TRƯỚC; lượt mua này người bán từ đầu ⇒ NGƯỜI BÁN (công không chảy sang lượt sau).
  assert.equal(attributeOrder(H, [ev("quote.given", "AI", 1), ev("message.received", "CUSTOMER", 100, { cycle: 1 }), ev("order.confirmed", "HUMAN", 120, { orderId: H, cycle: 1 })]), "HUMAN_ONLY");
  // Bot báo giá SAU mốc người lên đơn ⇒ không phải công trước đơn ⇒ NGƯỜI BÁN.
  assert.equal(attributeOrder(H, [ev("order.drafted", "HUMAN", 5, { orderId: H }), ev("quote.given", "AI", 6), ev("order.confirmed", "HUMAN", 9, { orderId: H })]), "HUMAN_ONLY");
  // AI ghi hộ đơn của nhân viên (order-sync: `order.drafted` tác nhân HUMAN) — chép lại không phải bán ⇒ NGƯỜI BÁN.
  assert.equal(attributeOrder(H, [ev("message.received", "CUSTOMER", 0), ev("human.took_over", "HUMAN", 1), ev("order.drafted", "HUMAN", 40, { orderId: H }), ev("order.confirmed", "HUMAN", 41, { orderId: H })]), "HUMAN_ONLY");
  // Không có sự kiện lên / chốt nào của chính đơn ⇒ CHƯA BIẾT.
  assert.equal(attributeOrder("erp-khong-co", botSale), null);

  const t = attributionTable(
    [
      { attribution: "AI_ONLY", valueVnd: 500_000, delivered: true, deliveredRevenueVnd: 500_000, settled: true, cancelled: false, deliveredCogsVnd: 300_000 },
      { attribution: "AI_ONLY", valueVnd: 300_000, delivered: false, deliveredRevenueVnd: 0, settled: true, cancelled: false, deliveredCogsVnd: 0 },
      { attribution: "HUMAN_ONLY", valueVnd: 200_000, delivered: false, deliveredRevenueVnd: 0, settled: false, cancelled: true, deliveredCogsVnd: 0 },
      { attribution: "HUMAN_ONLY", valueVnd: 450_000, delivered: true, deliveredRevenueVnd: 450_000, settled: true, cancelled: false, deliveredCogsVnd: null },
    ],
    2,
  );
  assert.deepEqual(t.AI_ONLY, { orders: 2, valueVnd: 800_000, delivered: 1, deliveredRevenueVnd: 500_000, settled: 2, cancelled: 0, grossProfitVnd: 200_000, costedRevenueVnd: 500_000, cogsUnknown: 0, cogsUnknownRevenueVnd: 0 });
  assert.deepEqual(t.AI_ASSISTED, { orders: 0, valueVnd: 0, delivered: 0, deliveredRevenueVnd: 0, settled: 0, cancelled: 0, grossProfitVnd: 0, costedRevenueVnd: 0, cogsUnknown: 0, cogsUnknownRevenueVnd: 0 });
  assert.equal(t.HUMAN_ONLY.cancelled, 1);
  assert.equal(t.unattributed, 2);
  // Lãi gộp đã giao: đơn chưa biết giá vốn đứng riêng — không cộng vào lãi với giá vốn 0; chưa đơn nào biết giá vốn ⇒ biên trống.
  assert.deepEqual([t.HUMAN_ONLY.grossProfitVnd, t.HUMAN_ONLY.costedRevenueVnd, t.HUMAN_ONLY.cogsUnknown, t.HUMAN_ONLY.cogsUnknownRevenueVnd], [0, 0, 1, 450_000]);
  assert.equal(grossMarginOf(t.AI_ONLY), 0.4);
  assert.equal(grossMarginOf(t.HUMAN_ONLY), null, "chưa đơn nào biết giá vốn ⇒ —, không phải 0%");
  assert.deepEqual([deliveredCogs(500_000, 300_000), deliveredCogs(500_000, 0), deliveredCogs(500_000, Number.NaN), deliveredCogs(0, 0)], [300_000, null, null, 0], "giá vốn 0 trên đơn có doanh thu = CHƯA BIẾT (cùng nghĩa IS_MISSING_COGS)");
  assert.equal(grossMarginOf({ grossProfitVnd: -50_000, costedRevenueVnd: 200_000 }), -0.25, "bán lỗ thì biên âm thật, không kẹp về 0");

  // Follow-up: nhắc → khách trả lời → đơn ⇒ thu hồi.
  const R = "erp-r1";
  const nudged = [ev("message.received", "CUSTOMER", 0), ev("quote.given", "AI", 1), ev("followup.sent", "AI", 60), ev("message.received", "CUSTOMER", 300), ev("order.drafted", "AI", 305, { orderId: R }), ev("order.confirmed", "CUSTOMER", 310, { orderId: R })];
  assert.deepEqual(followupRecovery(nudged, at(0)), { followedUp: true, replied: true, recoveredOrderIds: [R] });
  // Lời nhắc trước đầu kỳ ⇒ không xét.
  assert.deepEqual(followupRecovery(nudged, at(61)), { followedUp: false, replied: false, recoveredOrderIds: [] });
  // Nhắc mà khách không trả lời, vẫn có đơn (vd nhân viên gọi điện) ⇒ không phải thu hồi.
  assert.deepEqual(followupRecovery([ev("followup.sent", "AI", 60), ev("order.confirmed", "HUMAN", 400, { orderId: R })], at(0)), { followedUp: true, replied: false, recoveredOrderIds: [] });
  // Đơn lên TRƯỚC tin trả lời ⇒ không phải thu hồi.
  assert.deepEqual(followupRecovery([ev("followup.sent", "AI", 60), ev("order.drafted", "AI", 70, { orderId: R }), ev("message.received", "CUSTOMER", 300), ev("order.confirmed", "CUSTOMER", 310, { orderId: R })], at(0)).recoveredOrderIds, []);
  // Trả lời ở lượt mua khác ⇒ không phải trả lời lời nhắc này.
  assert.deepEqual(followupRecovery([ev("followup.sent", "AI", 60), ev("message.received", "CUSTOMER", 9000, { cycle: 1 }), ev("order.confirmed", "CUSTOMER", 9010, { orderId: R, cycle: 1 })], at(0)), { followedUp: true, replied: false, recoveredOrderIds: [] });
  // Đơn chỉ có nháp (chưa chốt) ⇒ chưa thu hồi.
  assert.deepEqual(followupRecovery(nudged.slice(0, 5), at(0)).recoveredOrderIds, []);

  // Kinh tế bot.
  const base = { conversations: 40, confirmedOrders: 4, confirmedValueVnd: 2_000_000, deliveredRevenueVnd: 1_500_000, aiCostVnd: 30_000, unknownCostTurns: 0 };
  assert.deepEqual(salesEconomics(base), { aovVnd: 500_000, deliveredRevenuePerConversationVnd: 37_500, aiCostPerConversationVnd: 750, revenuePerAiCost: 50, costIsLowerBound: false });
  assert.equal(salesEconomics({ ...base, confirmedOrders: 0, confirmedValueVnd: 0 }).aovVnd, null, "chưa có đơn ⇒ không có AOV");
  const few = salesEconomics({ ...base, conversations: 9 });
  assert.ok(few.deliveredRevenuePerConversationVnd === null && few.aiCostPerConversationVnd === null, "mẫu dưới 10 hội thoại ⇒ trống");
  assert.equal(salesEconomics({ ...base, aiCostVnd: 0 }).revenuePerAiCost, null, "chi phí 0 ⇒ không chia");
  const noMoney = salesEconomics({ ...base, aiCostVnd: null });
  assert.ok(noMoney.aiCostPerConversationVnd === null && noMoney.revenuePerAiCost === null, "không thấy tiền / chưa biết ⇒ trống");
  assert.equal(salesEconomics({ ...base, unknownCostTurns: 3 }).costIsLowerBound, true);
  // Trang chủ «Hôm nay AI làm ra bao nhiêu» KHÔNG có công thức riêng: chỉ đọc hai hàm của màn «Hiệu quả», không tự truy vấn.
  const home = readFileSync("components/onboarding/ai-sales-today.tsx", "utf8");
  assert.ok(home.includes("loadAiSalesPerformance(") && home.includes("loadOrderAttribution("), "trang chủ đọc đúng hai hàm của màn Hiệu quả");
  assert.ok(!/drizzle-orm|@\/db"|getDb\(|sql`/.test(home), "trang chủ không tự viết truy vấn — một công thức thứ hai là hai con số");
  assert.ok(readFileSync("components/onboarding/getting-started.tsx", "utf8").includes("<AiSalesToday user={user} />"), "khối AI hôm nay nằm trên trang chủ tổ chức khách");
  console.log("✓ Quy kết từng đơn · thuần: AI tự bán / AI góp công / người bán theo việc bán hàng THẬT (một câu trả lời không phải góp công) · người chạm SAU mốc chốt không làm mất AI tự bán · công không chảy sang lượt mua sau · AI ghi hộ đơn nhân viên = người bán · không sự kiện ⇒ chưa biết · follow-up thu hồi chỉ khi đơn lên SAU tin trả lời cùng lượt mua · kinh tế bot: chưa có đơn / mẫu bé / chi phí 0 ⇒ trống · trang chủ «hôm nay AI làm ra bao nhiêu» đọc đúng hai hàm của màn Hiệu quả, không công thức riêng");
}

function testOverlayPure() {
  // Nhãn chính KHÔNG đổi định nghĩa ⇒ phiên bản quy kết giữ nguyên (thuộc tính chồng không phải nhãn).
  assert.equal(ATTRIBUTION_VERSION, 1, "thêm thuộc tính chồng không được đổi ATTRIBUTION_VERSION");

  // ── Lời nhận mua thêm của MỘT đơn ──
  const U = "erp-u1";
  const sale = (extra: AttributionEvent[]) => [ev("message.received", "CUSTOMER", 0), ev("order.drafted", "AI", 5, { orderId: U }), ev("upsell.offered", "AI", 6), ...extra, ev("order.confirmed", "CUSTOMER", 8, { orderId: U })];
  assert.deepEqual(orderUpsell(U, sale([ev("upsell.accepted", "CUSTOMER", 7, { orderId: U, amountVnd: 120_000 })])), { accepted: true, amountVnd: 120_000 });
  // Nhận SAU mốc chốt ⇒ không phải mua thêm trước khi chốt.
  assert.deepEqual(orderUpsell(U, [...sale([]), ev("upsell.accepted", "CUSTOMER", 9, { orderId: U, amountVnd: 120_000 })]), { accepted: false, amountVnd: 0 });
  // Không mang mã đơn (nháp chưa có mã ERP), cùng lượt mua, lượt chỉ có một đơn ⇒ của đơn này; hai lần tăng cộng dồn.
  assert.deepEqual(orderUpsell(U, sale([ev("upsell.accepted", "CUSTOMER", 6, { amountVnd: 50_000 }), ev("upsell.accepted", "CUSTOMER", 7, { amountVnd: 30_000 })])), { accepted: true, amountVnd: 80_000 });
  // Không mang mã đơn mà lượt mua có HAI đơn ⇒ không biết của đơn nào ⇒ không gán cho đơn nào (đếm thiếu, không đếm hai lần).
  const twoOrders = [...sale([ev("upsell.accepted", "CUSTOMER", 7, { amountVnd: 50_000 })]), ev("order.drafted", "AI", 9, { orderId: "erp-u2" }), ev("order.confirmed", "CUSTOMER", 10, { orderId: "erp-u2" })];
  assert.equal(orderUpsell(U, twoOrders).accepted, false);
  assert.equal(orderUpsell("erp-u2", twoOrders).accepted, false);
  // Không mang mã đơn ở lượt mua KHÁC ⇒ không phải của đơn này; mang mã đơn KHÁC ⇒ không phải của đơn này.
  assert.equal(orderUpsell(U, sale([ev("upsell.accepted", "CUSTOMER", 7, { amountVnd: 50_000, cycle: 1 })])).accepted, false);
  assert.equal(orderUpsell(U, sale([ev("upsell.accepted", "CUSTOMER", 7, { orderId: "erp-khac", amountVnd: 50_000 })])).accepted, false);
  // Số tiền thiếu ⇒ CHƯA BIẾT, không cộng như 0.
  assert.deepEqual(orderUpsell(U, sale([ev("upsell.accepted", "CUSTOMER", 7, { orderId: U, amountVnd: null })])), { accepted: true, amountVnd: null });
  assert.deepEqual(orderUpsell(U, sale([ev("upsell.accepted", "CUSTOMER", 6, { orderId: U, amountVnd: 10_000 }), ev("upsell.accepted", "CUSTOMER", 7, { orderId: U })])), { accepted: true, amountVnd: null });

  // ── Cổng duy nhất: nhãn chính phải là nhãn AI ──
  const upEv = sale([ev("upsell.accepted", "CUSTOMER", 7, { orderId: U, amountVnd: 100_000 })]);
  assert.deepEqual(attributionOverlays({ orderId: U, attribution: "AI_ASSISTED", events: upEv, followupRecovered: true }).overlays, ["AI_RECOVERED", "AI_UPSELL"]);
  const humanRec = attributionOverlays({ orderId: U, attribution: "HUMAN_ONLY", events: upEv, followupRecovered: true });
  assert.deepEqual([humanRec.overlays, humanRec.followupRecovered, humanRec.upsellAccepted], [[], true, true], "thu hồi / nhận mua thêm mà nhãn chính là người bán ⇒ không mang thuộc tính chồng AI");
  assert.deepEqual(attributionOverlays({ orderId: U, attribution: null, events: upEv, followupRecovered: true }).overlays, [], "chưa quy kết ⇒ không thuộc tính chồng");
  assert.deepEqual(attributionOverlays({ orderId: U, attribution: "AI_ONLY", events: sale([]), followupRecovered: false }), { overlays: [], followupRecovered: false, upsellAccepted: false, upsellAmountVnd: 0 });

  // ── Tổng hợp: tập con của nhãn AI, không cộng vào tổng; upsell huỷ / hoàn / chưa ngã ngũ không vào «đã giao» ──
  const F = (o: Partial<OrderFacts>): OrderFacts => ({ valueVnd: 0, delivered: false, deliveredRevenueVnd: 0, settled: false, cancelled: false, deliveredCogsVnd: 0, ...o });
  const ov = (attribution: AttributedOrder["attribution"] | null, recovered: boolean, upsellAmount: number | null | false) => {
    const events = upsellAmount === false ? sale([]) : sale([ev("upsell.accepted", "CUSTOMER", 7, { orderId: U, amountVnd: upsellAmount })]);
    return attributionOverlays({ orderId: U, attribution, events, followupRecovered: recovered });
  };
  const giao = F({ valueVnd: 500_000, delivered: true, deliveredRevenueVnd: 500_000, settled: true, deliveredCogsVnd: 300_000 });
  const huy = F({ valueVnd: 450_000, cancelled: true });
  const hoan = F({ valueVnd: 300_000, settled: true });
  const cho = F({ valueVnd: 200_000 });
  const set = [
    { attribution: "AI_ONLY" as const, ...giao, overlay: ov("AI_ONLY", true, 100_000) },
    { attribution: "AI_ONLY" as const, ...huy, overlay: ov("AI_ONLY", false, 150_000) },
    { attribution: "AI_ASSISTED" as const, ...hoan, overlay: ov("AI_ASSISTED", true, 90_000) },
    { attribution: "AI_ASSISTED" as const, ...cho, overlay: ov("AI_ASSISTED", false, 80_000) },
    { attribution: "AI_ONLY" as const, ...giao, overlay: ov("AI_ONLY", false, false) },
    { attribution: "HUMAN_ONLY" as const, ...giao, overlay: ov("HUMAN_ONLY", true, 70_000) },
    { attribution: null, ...cho, overlay: ov(null, false, 60_000) },
  ];
  const labelled = set.filter((x): x is (typeof set)[number] & { attribution: AttributedOrder["attribution"] } => x.attribution !== null);
  const before = attributionTable(
    labelled.map((x) => ({ attribution: x.attribution, valueVnd: x.valueVnd, delivered: x.delivered, deliveredRevenueVnd: x.deliveredRevenueVnd, settled: x.settled, cancelled: x.cancelled, deliveredCogsVnd: x.deliveredCogsVnd })),
    1,
  );
  const after = attributionTable(labelled, 1);
  assert.deepEqual(after, before, "thuộc tính chồng không đổi một số nào của bảng nhãn chính");
  assert.equal(after.AI_ONLY.orders + after.AI_ASSISTED.orders + after.HUMAN_ONLY.orders + after.unattributed, set.length, "bốn nhóm cộng đúng bằng tập đơn");
  const t = overlayTable(set);
  assert.deepEqual(t.upsell, { orders: 4, deliveredOrders: 1, pending: 1, outsideAiLabels: 2, deliveredAmountVnd: 100_000, deliveredAmountUnknown: 0 }, "upsell đã giao chỉ gồm đơn DELIVERED — đơn huỷ 150K, hoàn 90K, chưa ngã ngũ 80K không vào");
  assert.deepEqual(t.recovered, { orders: 2, deliveredOrders: 1, pending: 0, outsideAiLabels: 1, deliveredRevenueVnd: 500_000 }, "thu hồi mà nhãn chính là người bán ⇒ ngoài thuộc tính chồng, đếm riêng");
  const aiOrders = after.AI_ONLY.orders + after.AI_ASSISTED.orders;
  assert.ok(t.upsell.orders <= aiOrders && t.recovered.orders <= aiOrders, "thuộc tính chồng ⊂ nhãn AI");
  assert.ok(t.recovered.deliveredRevenueVnd <= after.AI_ONLY.deliveredRevenueVnd + after.AI_ASSISTED.deliveredRevenueVnd, "doanh thu thu hồi ⊂ doanh thu quy cho AI");
  for (const x of set) if (x.overlay.overlays.length) assert.ok(x.attribution === "AI_ONLY" || x.attribution === "AI_ASSISTED", "mọi đơn mang thuộc tính chồng đều mang nhãn AI");
  // Số tiền thiếu trên đơn ĐÃ GIAO ⇒ tổng «đã giao» là CHƯA BIẾT; thiếu trên đơn huỷ thì không ảnh hưởng.
  const unknownDelivered = overlayTable([{ ...giao, overlay: ov("AI_ONLY", false, null) }, { ...giao, overlay: ov("AI_ONLY", false, 40_000) }]);
  assert.deepEqual([unknownDelivered.upsell.deliveredAmountVnd, unknownDelivered.upsell.deliveredAmountUnknown, unknownDelivered.upsell.deliveredOrders], [null, 1, 2]);
  const unknownCancelled = overlayTable([{ ...huy, overlay: ov("AI_ONLY", false, null) }, { ...giao, overlay: ov("AI_ONLY", false, 40_000) }]);
  assert.deepEqual([unknownCancelled.upsell.deliveredAmountVnd, unknownCancelled.upsell.deliveredAmountUnknown], [40_000, 0]);
  // Không có đơn upsell nào ⇒ 0 THẬT (không có phần tăng nào đã giao), không phải chưa biết.
  assert.equal(overlayTable([{ ...giao, overlay: ov("AI_ONLY", false, false) }]).upsell.deliveredAmountVnd, 0);
  console.log("✓ Thuộc tính chồng · thuần: AI_RECOVERED / AI_UPSELL ⊂ nhãn AI, bảng nhãn chính không đổi một số · lời nhận mua thêm thuộc đơn theo mã đơn hoặc cùng lượt mua một đơn (hai đơn ⇒ không gán) · sau mốc chốt không tính · upsell huỷ / hoàn / chưa ngã ngũ không vào «đã giao» · số tiền thiếu ⇒ chưa biết · thu hồi của người bán đếm riêng · ATTRIBUTION_VERSION giữ nguyên");
}

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

async function testRealOrg() {
  await withOrganization(ORG, async () => {
    const db = await getDb();
    const u = await db.query.users.findFirst({ where: eq(schema.users.email, `chu@${ORG}.local`) });
    assert.ok(u);
    const admin = { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: resolvePermissions("ADMIN", null), scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: ORG, isHome: false }, modules: [...(await getEnabledModules(ORG))] } as unknown as SessionUser;
    const now = Date.now();
    const m = (min: number) => new Date(now - 3 * 3_600_000 + min * 60_000);
    const conv = async () => (await db.insert(schema.salesChatConversations).values({ channel: "FANPAGE" }).returning({ id: schema.salesChatConversations.id }))[0].id;
    const order = (id: string, total: number, origin: string, convId: string) => db.insert(schema.orders).values({ id, stage: "CONFIRMED", status: 1, billFullName: "Khách", totalPrice: total, totalPriceAfterDiscount: total, insertedAt: new Date(), origin, salesConversationId: convId, raw: { origin: MANUAL_ORDER_ORIGIN, orderDiscount: 0, createdBy: null } });
    const rec = (convId: string, type: Parameters<typeof recordConversationEvent>[1]["type"], actorKind: Parameters<typeof recordConversationEvent>[1]["actorKind"], min: number, key: string, orderId?: string) => recordConversationEvent(convId, { type, actorKind, occurredAt: m(min), orderId: orderId ?? null, key });

    // c1 — bot tự bán, có lời nhắc và khách trả lời trước khi chốt (thu hồi), giao bằng phiếu ký nhận.
    const c1 = await conv();
    await order("erp-qk-ai", 600_000, "AI_AGENT", c1);
    // Giá vốn Pancake ghi trên dòng hàng (nguồn thứ hai của ORDER_COGS): 2 × 200.000đ.
    await db.insert(schema.orderItems).values({ id: "erp-qk-ai-1", orderId: "erp-qk-ai", productName: "Chả mực", quantity: 2, unitPrice: 300_000, unitCost: 200_000 });
    await rec(c1, "message.received", "CUSTOMER", 0, "msg:1");
    await rec(c1, "quote.given", "AI", 1, "quote:1");
    await rec(c1, "followup.sent", "AI", 60, "followup:1");
    await rec(c1, "message.received", "CUSTOMER", 90, "msg:2");
    await rec(c1, "order.drafted", "AI", 95, "draft:erp-qk-ai", "erp-qk-ai");
    await rec(c1, "order.confirmed", "CUSTOMER", 96, "confirm:erp-qk-ai", "erp-qk-ai");
    // c2 — bot báo giá, nhân viên nhận rồi tạo đơn trong khung chat ⇒ AI góp công.
    const c2 = await conv();
    await order("erp-qk-assist", 400_000, "ERP_FORM", c2);
    await rec(c2, "message.received", "CUSTOMER", 0, "msg:1");
    await rec(c2, "quote.given", "AI", 2, "quote:1");
    await rec(c2, "human.took_over", "HUMAN", 10, "staff:1");
    await rec(c2, "order.confirmed", "HUMAN", 20, "human-order:erp-qk-assist", "erp-qk-assist");
    // c3 — người bán từ đầu (bot chỉ chào) ⇒ người bán.
    const c3 = await conv();
    await order("erp-qk-human", 250_000, "ERP_FORM", c3);
    await rec(c3, "message.received", "CUSTOMER", 0, "msg:1");
    await rec(c3, "ai.replied", "AI", 1, "reply:1");
    await rec(c3, "human.took_over", "HUMAN", 3, "staff:1");
    await rec(c3, "order.confirmed", "HUMAN", 15, "human-order:erp-qk-human", "erp-qk-human");
    // c4 — khung THỬ: không bao giờ vào quy kết.
    const [c4] = await db.insert(schema.salesChatConversations).values({ channel: "TEST" }).returning({ id: schema.salesChatConversations.id });
    await rec(c4.id, "order.confirmed", "CUSTOMER", 5, "confirm:sim");

    const r0 = await loadOrderAttribution({ days: 7 });
    const t0 = r0.table;
    assert.deepEqual([t0.AI_ONLY.orders, t0.AI_ASSISTED.orders, t0.HUMAN_ONLY.orders, t0.unattributed], [1, 1, 1, 0], JSON.stringify(t0));
    assert.deepEqual([t0.AI_ONLY.valueVnd, t0.AI_ASSISTED.valueVnd, t0.HUMAN_ONLY.valueVnd], [600_000, 400_000, 250_000]);
    assert.equal(t0.AI_ONLY.deliveredRevenueVnd, 0, "chưa giao ⇒ chưa có doanh thu");
    assert.deepEqual([r0.followup.conversations, r0.followup.replied, r0.followup.recoveredOrders, r0.followup.recoveredValueVnd], [1, 1, 1, 600_000]);
    assert.equal(r0.followup.replyRate, null, "1 hội thoại < mẫu tối thiểu ⇒ trống");

    const d = await confirmManualDeliveryCore(admin, "erp-qk-ai", { signedAt: new Date().toISOString(), receiverName: "Khách" });
    assert.ok(d.ok, JSON.stringify(d));
    const r1 = await loadOrderAttribution({ days: 7 });
    assert.deepEqual([r1.table.AI_ONLY.delivered, r1.table.AI_ONLY.deliveredRevenueVnd, r1.table.AI_ONLY.settled], [1, 600_000, 1], "giao bằng phiếu ⇒ ORDER_OUTCOME = DELIVERED ⇒ doanh thu AI tự bán");
    assert.deepEqual([r1.followup.recoveredDelivered, r1.followup.recoveredDeliveredRevenueVnd], [1, 600_000]);
    assert.equal(r1.table.AI_ASSISTED.deliveredRevenueVnd + r1.table.HUMAN_ONLY.deliveredRevenueVnd, 0, "đơn chưa giao không có doanh thu");
    assert.deepEqual([r1.table.AI_ONLY.grossProfitVnd, r1.table.AI_ONLY.costedRevenueVnd, r1.table.AI_ONLY.cogsUnknown], [200_000, 600_000, 0], "lãi gộp AI tự bán = 600.000 − 2 × 200.000 (giá vốn qua đường chung của báo cáo lợi nhuận)");

    // Đơn AI góp công giao xong mà KHÔNG có nguồn giá vốn nào ⇒ chưa biết giá vốn, không cộng 400.000đ lãi giả.
    const d2 = await confirmManualDeliveryCore(admin, "erp-qk-assist", { signedAt: new Date().toISOString(), receiverName: "Khách" });
    assert.ok(d2.ok, JSON.stringify(d2));
    const r2 = await loadOrderAttribution({ days: 7 });
    const a2 = r2.table.AI_ASSISTED;
    assert.deepEqual([a2.deliveredRevenueVnd, a2.grossProfitVnd, a2.costedRevenueVnd, a2.cogsUnknown, a2.cogsUnknownRevenueVnd], [400_000, 0, 0, 1, 400_000]);

    // ── Thuộc tính chồng trên tổ chức thật: AI bán thêm (giao · huỷ · hoàn · chưa ngã ngũ) + thu hồi mà người bán ──
    const upsellSale = async (id: string, total: number, upsellOrderId: string | null, amountVnd: number) => {
      const cv = await conv();
      await order(id, total, "AI_AGENT", cv);
      await rec(cv, "message.received", "CUSTOMER", 0, "msg:1");
      await rec(cv, "quote.given", "AI", 1, "quote:1");
      await rec(cv, "order.drafted", "AI", 2, `draft:${id}`, id);
      await rec(cv, "upsell.offered", "AI", 3, "upsell-offer:0");
      // Không mang mã đơn = nháp lúc nhận chưa có mã ERP: lượt mua chỉ có một đơn ⇒ vẫn là của đơn này.
      await recordConversationEvent(cv, { type: "upsell.accepted", actorKind: "CUSTOMER", occurredAt: m(4), orderId: upsellOrderId, amountVnd, key: "upsell-accept:0:1" });
      await rec(cv, "order.confirmed", "CUSTOMER", 5, `confirm:${id}`, id);
    };
    await upsellSale("erp-qk-up-giao", 500_000, null, 100_000);
    await upsellSale("erp-qk-up-huy", 450_000, "erp-qk-up-huy", 150_000);
    await upsellSale("erp-qk-up-hoan", 300_000, "erp-qk-up-hoan", 90_000);
    await upsellSale("erp-qk-up-cho", 200_000, "erp-qk-up-cho", 80_000);
    await db.update(schema.orders).set({ stage: "CANCELLED" }).where(eq(schema.orders.id, "erp-qk-up-huy"));
    await db.update(schema.orders).set({ stage: "RETURNED" }).where(eq(schema.orders.id, "erp-qk-up-hoan"));
    const dUp = await confirmManualDeliveryCore(admin, "erp-qk-up-giao", { signedAt: new Date().toISOString(), receiverName: "Khách" });
    assert.ok(dUp.ok, JSON.stringify(dUp));
    // Bot chỉ NHẮC, khách trả lời, nhân viên nhận và chốt ⇒ thu hồi theo follow-up nhưng nhãn chính là NGƯỜI BÁN.
    const c9 = await conv();
    await order("erp-qk-th-nguoi", 350_000, "ERP_FORM", c9);
    await rec(c9, "followup.sent", "AI", 60, "followup:1");
    await rec(c9, "message.received", "CUSTOMER", 90, "msg:2");
    await rec(c9, "human.took_over", "HUMAN", 100, "staff:1");
    await rec(c9, "order.confirmed", "HUMAN", 110, "human-order:erp-qk-th-nguoi", "erp-qk-th-nguoi");

    const r3 = await loadOrderAttribution({ days: 7 });
    const t3 = r3.table;
    assert.deepEqual([t3.AI_ONLY.orders, t3.AI_ASSISTED.orders, t3.HUMAN_ONLY.orders, t3.unattributed], [5, 1, 2, 0], JSON.stringify(t3));
    assert.deepEqual([t3.AI_ONLY.delivered, t3.AI_ONLY.cancelled, t3.AI_ONLY.settled, t3.AI_ONLY.deliveredRevenueVnd], [2, 1, 3, 1_100_000], "giao 2 · huỷ 1 · hoàn 1 (đã ngã ngũ = giao + hoàn) qua ORDER_OUTCOME");
    assert.deepEqual(r3.upsell, { orders: 4, deliveredOrders: 1, pending: 1, outsideAiLabels: 0, deliveredAmountVnd: 100_000, deliveredAmountUnknown: 0 }, "upsell đã giao = 100K của đơn giao; 150K huỷ · 90K hoàn · 80K chưa ngã ngũ không vào");
    assert.deepEqual(r3.recovered, { orders: 1, deliveredOrders: 1, pending: 0, outsideAiLabels: 1, deliveredRevenueVnd: 600_000 }, JSON.stringify(r3.recovered));
    assert.equal(r3.followup.recoveredOrders, r3.recovered.orders + r3.recovered.outsideAiLabels, "follow-up thu hồi = thuộc tính chồng AI + phần nhãn người bán — không mất đơn nào");
    assert.ok(r3.upsell.orders + r3.recovered.orders <= 2 * (t3.AI_ONLY.orders + t3.AI_ASSISTED.orders) && r3.upsell.orders <= t3.AI_ONLY.orders + t3.AI_ASSISTED.orders, "thuộc tính chồng ⊂ nhãn AI");
    assert.ok((r3.upsell.deliveredAmountVnd ?? 0) <= t3.AI_ONLY.deliveredRevenueVnd + t3.AI_ASSISTED.deliveredRevenueVnd, "upsell đã giao ⊂ doanh thu quy cho AI");

    // ── Drill-down: cùng tập với bảng tổng, phân trang ổn định, không PII ──
    const all = t3.AI_ONLY.orders + t3.AI_ASSISTED.orders + t3.HUMAN_ONLY.orders + t3.unattributed;
    const p1 = await listAttributedOrders({ days: 7, page: 1, pageSize: 3 });
    const p2 = await listAttributedOrders({ days: 7, page: 2, pageSize: 3 });
    const p3 = await listAttributedOrders({ days: 7, page: 3, pageSize: 3 });
    const p4 = await listAttributedOrders({ days: 7, page: 4, pageSize: 3 });
    assert.deepEqual([p1.total, p1.pageCount, p1.rows.length, p2.rows.length, p3.rows.length, p4.rows.length], [all, 3, 3, 3, 2, 0], "tổng của danh sách = tổng bốn nhóm của bảng");
    const ids = [...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.orderId);
    assert.equal(new Set(ids).size, all, "trang 2 không trùng trang 1, ba trang phủ đủ tập");
    const p1Again = await listAttributedOrders({ days: 7, page: 1, pageSize: 3 });
    assert.deepEqual(p1Again.rows.map((r) => r.orderId), p1.rows.map((r) => r.orderId), "thứ tự ổn định giữa hai lần đọc");
    const keys = Object.keys(p1.rows[0]).sort();
    assert.deepEqual(keys, ["attribution", "cancelled", "confirmedAt", "conversationId", "delivered", "deliveredRevenueVnd", "orderId", "outcome", "overlays", "pending", "upsell", "valueVnd"], "dòng drill-down chỉ có mã + nhãn + kết cục + tiền của đơn — không tên / SĐT / địa chỉ");
    const ups = await listAttributedOrders({ days: 7, overlay: "AI_UPSELL" });
    assert.equal(ups.total, r3.upsell.orders);
    assert.ok(ups.rows.every((r) => (r.attribution === "AI_ONLY" || r.attribution === "AI_ASSISTED") && r.upsell !== null));
    const giaoRow = ups.rows.find((r) => r.orderId === "erp-qk-up-giao");
    assert.deepEqual([giaoRow?.outcome, giaoRow?.delivered, giaoRow?.deliveredRevenueVnd, giaoRow?.upsell?.amountVnd], ["DELIVERED", true, 500_000, 100_000]);
    assert.deepEqual(ups.rows.filter((r) => r.pending).map((r) => r.orderId), ["erp-qk-up-cho"]);
    const humans = await listAttributedOrders({ days: 7, attribution: "HUMAN_ONLY" });
    assert.deepEqual(humans.rows.map((r) => [r.orderId, r.overlays.length, r.upsell]).sort(), [["erp-qk-human", 0, null], ["erp-qk-th-nguoi", 0, null]], "người bán không mang thuộc tính chồng AI, kể cả khi được thu hồi qua lời nhắc");
  });
  console.log("✓ Quy kết từng đơn · tổ chức thật: ba hội thoại ⇒ AI tự bán / AI góp công / người bán (khung thử loại) · thuộc tính chồng AI bán thêm chỉ cộng phần tăng của đơn ĐÃ GIAO, thu hồi của người bán đếm riêng, drill-down phân trang cùng tập không trùng không PII · lời nhắc → khách trả lời → đơn ⇒ thu hồi · giao bằng phiếu ⇒ doanh thu AI tự bán và doanh thu thu hồi qua ORDER_OUTCOME · lãi gộp đã giao = doanh thu − giá vốn đường chung, đơn không có giá vốn đứng riêng (không lãi giả)");
}

export async function testOrderAttribution() {
  testPure();
  testOverlayPure();
  await cleanupOrg(ORG);
  await provisionOrganization({ code: ORG, name: "Shop quy kết đơn", plan: "trial", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `chu@${ORG}.local`, name: "Chủ shop", password: "QuyKetDon@2026!" }, source: "TEST", actor: null });
  try {
    await testRealOrg();
  } finally {
    await cleanupOrg(ORG);
  }
}

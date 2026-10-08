/**
 * SO AI vs NGƯỜI THEO NHÁNH + DRILL-DOWN VỀ HỘI THOẠI (lib/sales-chatbot/experiment-*.ts · DoD #9, #15).
 *
 *  1. THUẦN — nhánh không có đường ghi đơn ⇒ mọi số đơn `null` (không phải 0); mẫu dưới ngưỡng ⇒ tỷ lệ `null`; chênh lệch
 *     chỉ có khi CẢ HAI bên đo được; bộ lọc drill-down bỏ giá trị lạ; che SĐT giữ 3 số cuối.
 *  2. TỔ CHỨC THẬT `xr-shop` (AI giả): 12 hội thoại nhánh AI (một hội thoại bán thật tới lúc giao ⇒ ORDER_OUTCOME DELIVERED),
 *     12 hội thoại fanpage nhánh người (một đơn ghi hộ). «AI ghi đơn hộ nhân viên» TẮT ⇒ nhánh người «chưa đo», BẬT ⇒ có số;
 *     hội thoại khoá thử nghiệm KHÁC không lẫn vào; drill-down đúng nhóm / lý do / nhánh; xem lại hội thoại mở được, kênh
 *     THỬ thì không; tổ chức khác không thấy gì.
 *  3. LỢI NHUẬN THEO NHÁNH (Master Mission P0.5 + P1.7): lãi gộp đã giao cùng luật với bảng quy kết (#646) — đơn chưa có giá
 *     vốn đứng riêng, hoàn / huỷ không có doanh thu; lãi chưa đủ thì không chia / không trừ / không so; chi phí AI theo
 *     nhánh từ sổ AI (cả `order-sync:` của nhánh người, lượt chưa định giá ⇒ cận dưới, dòng trước NGÀY vào nhánh không tính);
 *     không được xem tiền ⇒ mọi ô tiền AI `null` và sổ AI không bị đọc; khung «Chi phí AI & ROI» ra ĐÚNG số dựng tay.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { dauNgayVN } from "@/lib/ai/budget";
import { addUsdAsVnd, conversationOfRef, sumConversationsAiCost } from "@/lib/ai-usage/conversation-cost";
import { recordAiUsage } from "@/lib/ai-usage/ledger";
import { resolvePermissions } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/session";
import { ERP_NATIVE_SETTING_KEY, MANUAL_ORDER_ORIGIN, MANUAL_ORDER_STATUS_CODE } from "@/lib/constants/manual-orders";
import { env } from "@/lib/env";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { confirmManualDeliveryCore } from "@/lib/records/order-create";
import { createProductCore } from "@/lib/records/product-create";
import { orderFactsOf } from "@/lib/sales-chatbot/attribution";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { chatTurn, openConversation, setSalesChatProviderForTests, visitorKeyOf } from "@/lib/sales-chatbot/engine";
import { listDrillConversations, loadConversationReview, loadExperimentReport } from "@/lib/sales-chatbot/experiment-report";
import { aiCostIsLowerBound, aiCostNote, armRaw, armStats, drillHref, grossProfitLift, liftOrNull, maskPhones, parseDrillFilter, profitAfterAiLift, STOPPED_LIFT_REASON } from "@/lib/sales-chatbot/experiment-shared";
import { basketStats, loadBasketStats } from "@/lib/sales-chatbot/basket";
import { saveModeConfig, loadModeConfig } from "@/lib/sales-chatbot/operating-mode";
import { OPERATING_MODE_SETTING_KEY } from "@/lib/sales-chatbot/operating-mode-shared";
import { saveOrderSyncConfig } from "@/lib/sales-chatbot/order-sync";
import { loadAiSalesPerformance } from "@/lib/sales-chatbot/performance";
import { setSettingJson } from "@/lib/settings";
import { fakeProvider, shopScript } from "./e2e-ai-sales-platform.test";

const ORG = "xr-shop";
const OTHER = "xr-khac";

/** Dữ kiện một đơn như máy chủ dựng (`orderFactsOf` — đường chung với bảng quy kết). */
const fact = (outcome: string, value: number, recognized: boolean, cogs: number) => orderFactsOf({ outcome, value, recognized, cogs });

function testProfitPure() {
  // Dữ kiện đơn: doanh thu CHỈ khi giao thành công VÀ được ghi nhận; giá vốn 0 trên đơn có doanh thu = CHƯA BIẾT.
  assert.deepEqual(fact("DELIVERED", 300_000, true, 120_000), { valueVnd: 300_000, delivered: true, deliveredRevenueVnd: 300_000, settled: true, cancelled: false, deliveredCogsVnd: 120_000 });
  assert.equal(fact("DELIVERED", 200_000, true, 0).deliveredCogsVnd, null, "giá vốn 0 trên đơn có doanh thu = CHƯA BIẾT, không phải lãi 100%");
  assert.equal(fact("DELIVERED", 200_000, false, 50_000).deliveredRevenueVnd, 0, "giao nhưng chưa được ghi nhận doanh thu ⇒ không doanh thu");
  const ret = fact("RETURNED", 700_000, true, 0);
  assert.deepEqual([ret.delivered, ret.settled, ret.deliveredRevenueVnd, ret.deliveredCogsVnd], [false, true, 0, 0], "hoàn: đã ngã ngũ, không doanh thu, không giá vốn");
  const huy = fact("CANCELLED", 900_000, true, 0);
  assert.deepEqual([huy.cancelled, huy.settled, huy.deliveredRevenueVnd], [true, false, 0], "huỷ: không vào mẫu số giao, không doanh thu");
  assert.equal(fact("IN_TRANSIT", 1, true, 0).settled, false);

  // Gộp một nhánh bằng `orderRow` — cùng luật bảng quy kết.
  const orders = [fact("DELIVERED", 300_000, true, 120_000), fact("DELIVERED", 1_150_000, true, 700_000), fact("DELIVERED", 200_000, true, 0), fact("CANCELLED", 600_000, true, 0), fact("RETURNED", 700_000, true, 0), fact("IN_TRANSIT", 750_000, true, 0)];
  const r = armRaw(12, orders);
  assert.deepEqual(r, { conversations: 12, orders: 6, ordersValueVnd: 3_700_000, settled: 4, delivered: 3, deliveredRevenueVnd: 1_650_000, grossProfitVnd: 630_000, costedRevenueVnd: 1_450_000, cogsUnknown: 1, cogsUnknownRevenueVnd: 200_000 });

  // Lãi CHƯA ĐỦ (còn đơn chưa có giá vốn): tổng in như bảng quy kết, còn chia / trừ / so thì không.
  const inc = armStats(r, 12, null, { costVnd: 500, turns: 3, unknownTurns: 0 });
  assert.deepEqual([inc.grossProfitVnd, inc.cogsUnknown, inc.cogsUnknownRevenueVnd, inc.grossProfitPerConversationVnd, inc.profitAfterAiVnd, inc.profitAfterAiPerConversationVnd], [630_000, 1, 200_000, null, null, null]);
  assert.equal(inc.grossMargin, 630_000 / 1_450_000, "biên chỉ trên đơn biết giá vốn");
  assert.equal(inc.aiCostVnd, 500, "chi phí AI là số đo của sổ AI — không phụ thuộc giá vốn");
  // Lãi ĐỦ.
  const full = armRaw(12, orders.filter((o) => !(o.delivered && o.deliveredCogsVnd === null)));
  const ok = armStats(full, 12, null, { costVnd: 30_000, turns: 40, unknownTurns: 0 });
  assert.deepEqual([ok.grossProfitVnd, ok.grossProfitPerConversationVnd, ok.aiCostVnd, ok.aiTurns, ok.aiUnknownTurns, ok.profitAfterAiVnd, ok.profitAfterAiPerConversationVnd], [630_000, 52_500, 30_000, 40, 0, 600_000, 50_000]);
  // Không được xem tiền AI ⇒ mọi ô tiền AI `null`; lãi gộp vẫn có.
  const noMoney = armStats(full, 12);
  assert.deepEqual([noMoney.aiCostVnd, noMoney.aiTurns, noMoney.aiUnknownTurns, noMoney.profitAfterAiVnd, noMoney.profitAfterAiPerConversationVnd, noMoney.grossProfitPerConversationVnd], [null, null, null, null, null, 52_500]);
  // Chưa lượt nào định giá ⇒ chi phí CHƯA BIẾT ⇒ lãi sau AI trống (không coi chi phí là 0).
  const unpriced = armStats(full, 12, null, { costVnd: null, turns: 5, unknownTurns: 5 });
  assert.deepEqual([unpriced.aiCostVnd, unpriced.aiUnknownTurns, unpriced.profitAfterAiVnd, unpriced.profitAfterAiPerConversationVnd], [null, 5, null, null]);
  // Dưới mẫu ⇒ mọi số / hội thoại `null`; tổng vẫn có.
  const few = armStats(full, 9, null, { costVnd: 30_000, turns: 40, unknownTurns: 0 });
  assert.deepEqual([few.grossProfitVnd, few.grossProfitPerConversationVnd, few.profitAfterAiVnd, few.profitAfterAiPerConversationVnd], [630_000, null, 600_000, null]);
  // Chưa đo (không đường ghi đơn) ⇒ lãi `null`, không phải 0; chi phí AI vẫn là số đo của sổ.
  const none = armStats(full, 0, "tắt", { costVnd: 1_000, turns: 2, unknownTurns: 0 });
  assert.deepEqual([none.grossProfitVnd, none.grossMargin, none.cogsUnknown, none.grossProfitPerConversationVnd, none.aiCostVnd, none.profitAfterAiVnd], [null, null, null, null, 1_000, null]);
  // Mọi đơn đã giao đều chưa có giá vốn ⇒ lãi gộp «—», không phải 0 ₫.
  const allUnknown = armStats(armRaw(12, [fact("DELIVERED", 200_000, true, 0)]), 12);
  assert.deepEqual([allUnknown.grossProfitVnd, allUnknown.grossMargin, allUnknown.cogsUnknown], [null, null, 1]);
  // Chưa đơn nào giao ⇒ lãi gộp 0 ₫ THẬT (đo được: không doanh thu nào), biên «—».
  const zero = armStats(armRaw(12, [fact("IN_TRANSIT", 500_000, true, 0)]), 12);
  assert.deepEqual([zero.grossProfitVnd, zero.grossMargin, zero.grossProfitPerConversationVnd], [0, null, 0]);
  // Bán lỗ thì âm thật, không kẹp về 0.
  const loss = armStats(armRaw(10, [fact("DELIVERED", 100_000, true, 150_000)]), 10, null, { costVnd: 20_000, turns: 1, unknownTurns: 0 });
  assert.deepEqual([loss.grossProfitVnd, loss.grossProfitPerConversationVnd, loss.profitAfterAiVnd, loss.profitAfterAiPerConversationVnd], [-50_000, -5_000, -70_000, -7_000]);

  // Chênh lệch «lãi sau AI / hội thoại»: chi phí một bên là cận dưới ⇒ có chiều; cả hai ⇒ trống; một bên chưa đo ⇒ trống.
  const humanRaw = armRaw(12, [fact("DELIVERED", 400_000, true, 300_000)]);
  const human = armStats(humanRaw, 12, null, { costVnd: 12_000, turns: 2, unknownTurns: 0 });
  assert.deepEqual([human.grossProfitPerConversationVnd, human.profitAfterAiPerConversationVnd], [8_333, 7_333]);
  assert.deepEqual(profitAfterAiLift(ok, human, true), { value: 42_667, bound: "EXACT", reason: null });
  const okLow = armStats(full, 12, null, { costVnd: 30_000, turns: 40, unknownTurns: 2 });
  assert.deepEqual(profitAfterAiLift(okLow, human, true), { value: 42_667, bound: "UPPER", reason: null }, "chi phí nhánh AI là cận dưới ⇒ chênh lệch là cận TRÊN");
  const humanLow = armStats(humanRaw, 12, null, { costVnd: 12_000, turns: 2, unknownTurns: 1 });
  assert.deepEqual(profitAfterAiLift(ok, humanLow, true), { value: 42_667, bound: "LOWER", reason: null }, "chi phí nhánh người là cận dưới ⇒ chênh lệch là cận DƯỚI");
  assert.deepEqual(profitAfterAiLift(okLow, humanLow, true), { value: null, bound: "EXACT", reason: null }, "cả hai cận dưới ⇒ không chiều nào chắc ⇒ trống");
  assert.deepEqual(profitAfterAiLift(ok, armStats(humanRaw, 0, "tắt", { costVnd: 0, turns: 0, unknownTurns: 0 }), true), { value: null, bound: "EXACT", reason: null }, "một bên chưa đo ⇒ không có chênh lệch — AI không thắng giả");
  assert.deepEqual(grossProfitLift(ok, human, true), { value: 44_167, bound: "EXACT", reason: null });
  assert.deepEqual(grossProfitLift(ok, inc, true), { value: null, bound: "EXACT", reason: null }, "lãi một bên chưa đủ ⇒ không so");
  assert.deepEqual(grossProfitLift(ok, few, true), { value: null, bound: "EXACT", reason: null }, "một bên dưới mẫu ⇒ không so");
  // Thử nghiệm đã DỪNG (chưa có mốc dừng): CẢ HAI chênh lệch lãi trống kèm lý do — dù hai nhánh đều có số.
  const stopped = { value: null, bound: "EXACT", reason: STOPPED_LIFT_REASON };
  assert.deepEqual([grossProfitLift(ok, human, false), profitAfterAiLift(ok, human, false), profitAfterAiLift(okLow, human, false)], [stopped, stopped, stopped]);
  assert.ok(STOPPED_LIFT_REASON.startsWith("Thử nghiệm đã dừng"));
  // Ô chi phí AI: «cận dưới» CHỈ cạnh một con số; ô «—» chỉ nói số lượt chưa định giá; không xem tiền ⇒ không dòng phụ.
  assert.deepEqual([aiCostIsLowerBound(okLow), aiCostIsLowerBound(ok), aiCostIsLowerBound(unpriced)], [true, false, false]);
  assert.deepEqual([aiCostNote(okLow), aiCostNote(ok), aiCostNote(unpriced), aiCostNote(noMoney)], ["cận dưới · 2 lượt chưa định giá", "40 lượt", "5 lượt chưa định giá", null]);
  assert.equal(aiCostNote({ aiCostVnd: null, aiTurns: 1_200, aiUnknownTurns: 0 }), "1.200 lượt", "số lượt in theo kiểu Việt Nam");

  // Sổ AI theo hội thoại: ánh xạ `ref`, mốc cắt theo NGÀY, lượt chưa định giá ⇒ cận dưới, chưa lượt nào định giá ⇒ CHƯA BIẾT.
  assert.deepEqual(conversationOfRef("c1"), { conversationId: "c1", orderSync: false });
  assert.deepEqual(conversationOfRef("order-sync:c1"), { conversationId: "c1", orderSync: true });
  assert.deepEqual([conversationOfRef(null), conversationOfRef("")], [null, null]);
  assert.deepEqual([addUsdAsVnd(null, null, 25_000), addUsdAsVnd(null, 0.5, 25_000), addUsdAsVnd(100, null, 25_000)], [null, 12_500, 100], "khoản chưa định giá không cộng 0");
  const rows = [
    { day: "2026-10-05", ref: "a1", feature: "sales_chatbot", turns: 2, costUsd: 0.25, unknownCost: 0 },
    { day: "2026-10-03", ref: "a1", feature: "sales_chatbot", turns: 9, costUsd: 4, unknownCost: 0 },
    { day: "2026-10-05", ref: "order-sync:h1", feature: "sales_chatbot", turns: 1, costUsd: 0.125, unknownCost: 0 },
    { day: "2026-10-06", ref: "a2", feature: "sales_chatbot", turns: 3, costUsd: null, unknownCost: 3 },
    { day: "2026-10-06", ref: "khac", feature: "sales_chatbot", turns: 7, costUsd: 8, unknownCost: 0 },
    { day: "2026-10-06", ref: null, feature: "sales_chatbot", turns: 1, costUsd: 16, unknownCost: 0 },
  ];
  assert.deepEqual(sumConversationsAiCost(rows, new Map([["a1", "2026-10-05"], ["a2", "2026-10-04"]]), 25_000), { costVnd: 6_250, turns: 5, unknownTurns: 3 }, "ngày trước mốc vào nhánh không tính; hội thoại ngoài tập không tính");
  assert.deepEqual(sumConversationsAiCost(rows, new Map([["h1", "2026-10-05"]]), 25_000), { costVnd: 3_125, turns: 1, unknownTurns: 0 }, "lượt ghi đơn hộ tính cho chính hội thoại nó đọc");
  assert.deepEqual(sumConversationsAiCost(rows, new Map([["a2", "2026-10-01"]]), 25_000), { costVnd: null, turns: 3, unknownTurns: 3 }, "mọi lượt chưa định giá ⇒ CHƯA BIẾT, không phải 0 ₫");
  assert.deepEqual(sumConversationsAiCost(rows, new Map(), 25_000), { costVnd: null, turns: 0, unknownTurns: 0 });
  console.log("  ✓ AI vs người · lợi nhuận (thuần): dữ kiện đơn qua đường chung, lãi gộp cùng luật bảng quy kết, lãi chưa đủ thì không chia / trừ / so, không xem tiền ⇒ tiền AI null, chênh lệch có chiều khi chi phí là cận dưới, sổ AI theo hội thoại cắt theo ngày vào nhánh");
}

function testPure() {
  const raw = { conversations: 12, orders: 3, ordersValueVnd: 900_000, settled: 2, delivered: 2, deliveredRevenueVnd: 600_000, grossProfitVnd: 0, costedRevenueVnd: 0, cogsUnknown: 0, cogsUnknownRevenueVnd: 0 };
  const none = armStats(raw, 0, "tắt");
  assert.deepEqual([none.orders, none.conversion, none.delivered, none.note], [null, null, null, "tắt"], "không đường ghi đơn ⇒ CHƯA ĐO, không phải 0");
  const s = armStats(raw, 12);
  assert.equal(s.conversion, 3 / 12);
  assert.equal(s.deliveredConversion, 2 / 12);
  assert.equal(s.deliveryRate, 1);
  assert.equal(s.aovVnd, 300_000);
  assert.equal(s.deliveredAovVnd, 300_000);
  assert.equal(armStats(raw, 9).conversion, null, "dưới 10 hội thoại ⇒ null");
  assert.equal(liftOrNull(0.3, null), null, "một bên chưa đo ⇒ không có chênh lệch — AI không thắng giả");
  assert.ok(Math.abs((liftOrNull(0.3, 0.2) ?? 0) - 0.1) < 1e-9);
  assert.deepEqual(parseDrillFilter({ days: "999", cohort: "XYZ", arm: "AI", reason: "WHOLESALE", confirmed: "1" }), { days: 30, cohort: null, arm: "AI", reason: "WHOLESALE", confirmed: true, lost: null, page: null });
  assert.equal(parseDrillFilter({ reason: "drop table" }).reason, null);
  assert.equal(drillHref({ days: 7, cohort: "AI_ONLY" }), "/ai/sales-chatbot/conversations?days=7&cohort=AI_ONLY");
  assert.equal(maskPhones("SĐT em 0912345678 nhé"), "SĐT em ••••678 nhé");
  assert.equal(maskPhones("+84 912 345 678"), "••••678");
  assert.equal(maskPhones("lấy 2 hộp 500g giá 250.000đ"), "lấy 2 hộp 500g giá 250.000đ", "không che số tiền / số lượng");
  // Bán chéo: sản phẩm chính = giá trị dòng lớn nhất; phần còn lại là giá trị bán chéo (đơn chốt, danh nghĩa).
  const b = basketStats([
    [{ productId: "cha", quantity: 2, valueVnd: 800_000 }, { productId: "ruoc", quantity: 1, valueVnd: 350_000 }],
    [{ productId: "cha", quantity: 1, valueVnd: 400_000 }, { productId: "cha", quantity: 1, valueVnd: 400_000 }],
    [],
  ]);
  assert.deepEqual([b.orders, b.multiProductOrders, b.crossSellValueVnd, b.itemsPerOrder], [2, 1, 350_000, 2.5], "đơn không dòng nào bị bỏ; hai dòng cùng sản phẩm không phải bán chéo");
  assert.equal(b.multiProductRate, null, "2 đơn < 10 ⇒ tỷ lệ null");
  const many = basketStats(Array.from({ length: 10 }, (_, i) => (i < 3 ? [{ productId: "a", quantity: 1, valueVnd: 1 }, { productId: "b", quantity: 1, valueVnd: 1 }] : [{ productId: "a", quantity: 1, valueVnd: 1 }])));
  assert.equal(many.multiProductRate, 0.3);
  console.log("  ✓ AI vs người (thuần): chưa đo ≠ 0, mẫu < 10 ⇒ null, chênh lệch chỉ khi hai bên đo được, lọc drill-down, che SĐT");
}

async function cleanup() {
  const pdb = await getPlatformDb();
  for (const code of [ORG, OTHER]) {
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
    if (org) {
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(schema.platformFlagOverrides).where(eq(schema.platformFlagOverrides.organizationId, org.id));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
    }
    await pdb.delete(schema.platformAiUsage).where(eq(schema.platformAiUsage.orgCode, code));
    await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, code));
    rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  }
  invalidateOrganizations();
  invalidateCapabilities();
}

async function adminOf(org: string): Promise<SessionUser> {
  const u = await (await getDb()).query.users.findFirst({ where: eq(schema.users.email, `chu@${org}.local`) });
  assert.ok(u);
  return { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: resolvePermissions("ADMIN", null), scope: "ALL", departmentCodes: [], positionId: null, organization: { code: org, name: org, isHome: false }, modules: [...(await getEnabledModules(org))] };
}

/**
 * Lãi gộp + chi phí AI theo nhánh trên tổ chức thật. Mốc ghim nhánh và dòng sổ AI dựng TẤT ĐỊNH theo đầu ngày giờ VN (luật 50):
 * cùng đồng hồ với cửa sổ 30 ngày của khung «Chi phí AI & ROI», không phụ thuộc giờ chạy trong ngày.
 */
async function armProfitLive(ids: { sold: string; humanIds: string[]; aiIds: string[]; oldId: string; key: string; admin: SessionUser }) {
  const db = await getDb();
  const pdb = await getPlatformDb();
  const c = schema.salesChatConversations;
  const rate = env.facebook.usdToVnd;
  const vnd = (usd: number) => Math.round(usd * rate);
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  const D0 = dauNgayVN(new Date()).getTime();
  const today = D0 + 11 * HOUR;
  const [A0, A1, A2, A3, A4] = ids.aiIds;
  const [H0, H1, H2, H3] = ids.humanIds;
  // A0 vào nhánh 5 ngày trước (mốc bắt đầu thử nghiệm), A1 hôm nay 10:00 (giờ VN).
  const pinAt = (at: number) => ({ experiment: { key: ids.key, arm: "AI", at: new Date(at).toISOString() } });
  await db.update(c).set({ state: pinAt(D0 - 5 * DAY + 10 * HOUR) }).where(eq(c.id, A0));
  await db.update(c).set({ state: pinAt(D0 + 10 * HOUR) }).where(eq(c.id, A1));
  const testConv = (await openConversation("TEST", { createdBy: "xr-cost" })).id;

  // ── Sổ AI: thay lượt của hội thoại bán thật ở trên bằng bộ dòng biết trước (USD là phân số nhị phân ⇒ cộng không sai số). ──
  await pdb.delete(schema.platformAiUsage).where(eq(schema.platformAiUsage.orgCode, ORG));
  const ledgerRow = (ref: string | null, at: number, costUsd: number | null, more: { status?: "OK" | "BLOCKED_QUOTA"; feature?: "sales_chatbot" | "sales_playbook"; org?: string } = {}) =>
    recordAiUsage({ orgCode: more.org ?? ORG, feature: more.feature ?? "sales_chatbot", source: "BYOK", provider: "fake", model: "m", requests: more.status === "BLOCKED_QUOTA" ? 0 : 1, inputTokens: null, outputTokens: null, costUsd, status: more.status ?? "OK", actorId: null, ref, at: new Date(at) });
  await ledgerRow(ids.sold, today, 1 / 64); // nhánh AI
  await ledgerRow(A1, D0 - 2 * DAY + 9 * HOUR, 1 / 8); // TRƯỚC ngày A1 vào nhánh ⇒ không tính cho nhánh
  await ledgerRow(A0, D0 - 4 * DAY + 9 * HOUR, 1 / 256); // sau ngày A0 vào nhánh ⇒ tính
  await ledgerRow(A1, today, null); // chưa định giá ⇒ chi phí nhánh AI là cận dưới
  await ledgerRow(`order-sync:${H0}`, today, 1 / 128); // AI ghi đơn hộ nhân viên ⇒ tiền AI của nhánh người
  await ledgerRow(H1, today, 1 / 512); // nhánh người
  await ledgerRow(ids.oldId, today, 1 / 4); // khoá thử nghiệm cũ ⇒ không nhánh nào
  await ledgerRow(testConv, today, 1 / 2); // khung thử ⇒ không nhánh nào
  await ledgerRow(null, today, 1 / 16); // không gắn hội thoại
  await ledgerRow(A0, D0 - 6 * DAY + 9 * HOUR, 1 / 32); // trước mốc bắt đầu thử nghiệm
  await ledgerRow(A0, D0 - 5 * DAY + 9 * HOUR, 1 / 1024); // CÙNG ngày A0 vào nhánh nhưng trước mốc — mốc sớm nhất cắt đúng tới giờ
  await ledgerRow(ids.sold, today, null, { status: "BLOCKED_QUOTA" }); // hạn mức chặn — không phải lượt dùng, không làm cận dưới
  await ledgerRow(ids.sold, today, 1, { feature: "sales_playbook" }); // tính năng khác
  await ledgerRow(ids.sold, today, 1, { org: OTHER }); // tổ chức khác

  // Khung «Chi phí AI & ROI» ra ĐÚNG số dựng tay — performance.ts dùng phép ánh xạ `ref` chung mà số không đổi (bài này xanh
  // trên cả performance.ts cũ lẫn mới). Bán hàng = mọi dòng không phải ghi đơn hộ / khung thử: 503/1024 USD, 9 lượt, 1 chưa định giá.
  const perf = await loadAiSalesPerformance(ORG, { withMoney: true });
  assert.deepEqual([perf.cost?.sellingVnd, perf.cost?.orderSyncVnd, perf.cost?.testVnd, perf.cost?.unknownCost, perf.cost?.turns], [vnd(503 / 1024), vnd(1 / 128), vnd(1 / 2), 1, 9], JSON.stringify(perf.cost));
  // Một page: tiền của hội thoại thuộc page — kể cả lượt `order-sync:` của chính hội thoại ấy.
  await db.update(c).set({ pageId: "xr-page" }).where(inArray(c.id, [A0, H0]));
  const perfPage = await loadAiSalesPerformance(ORG, { withMoney: true, pageId: "xr-page" });
  assert.deepEqual([perfPage.cost?.sellingVnd, perfPage.cost?.orderSyncVnd, perfPage.cost?.testVnd, perfPage.cost?.unknownCost, perfPage.cost?.turns], [vnd(37 / 1024), vnd(1 / 128), null, 0, 3], JSON.stringify(perfPage.cost));

  // ── Đơn: tổ chức «chuyển hẳn sang ERP» ⇒ đơn tay đã giao được ghi doanh thu dù CSDL có đơn không `erp-` (dữ liệu ở trên). ──
  await setSettingJson(ERP_NATIVE_SETTING_KEY, { since: new Date().toISOString(), by: ids.admin.id });
  const order = (id: string, total: number, conv: string, origin: string, stage: "CONFIRMED" | "CANCELLED" | "RETURNED" = "CONFIRMED") =>
    db.insert(schema.orders).values({ id, stage, status: MANUAL_ORDER_STATUS_CODE[stage], billFullName: "Khách", totalPrice: total, totalPriceAfterDiscount: total, insertedAt: new Date(), origin, salesConversationId: conv, raw: { origin: MANUAL_ORDER_ORIGIN, orderDiscount: 0, createdBy: null } });
  // Giá vốn Pancake ghi trên dòng hàng (nguồn thứ hai của giá vốn chung).
  const line = (orderId: string, quantity: number, unitPrice: number, unitCost: number) => db.insert(schema.orderItems).values({ id: `${orderId}-1`, orderId, productName: "Chả mực", quantity, unitPrice, unitCost });
  const deliver = async (id: string) => {
    const d = await confirmManualDeliveryCore(ids.admin, id, { signedAt: new Date().toISOString(), receiverName: "Khách" });
    assert.ok(d.ok, JSON.stringify(d));
  };
  // Nhánh AI: một đơn có giá vốn, một đơn KHÔNG có nguồn giá vốn nào, một đơn huỷ.
  await order("erp-xr-ai-cost", 300_000, A2, "AI_AGENT");
  await line("erp-xr-ai-cost", 1, 300_000, 120_000);
  await order("erp-xr-ai-nocost", 200_000, A3, "AI_AGENT");
  await order("erp-xr-ai-cancel", 600_000, A4, "AI_AGENT", "CANCELLED");
  // Nhánh người: một đơn có giá vốn, một đơn hoàn, một đơn chưa giao.
  await order("erp-xr-hu-cost", 400_000, H1, "AI_ORDER_SYNC");
  await line("erp-xr-hu-cost", 2, 200_000, 150_000);
  await order("erp-xr-hu-ret", 700_000, H2, "AI_ORDER_SYNC", "RETURNED");
  await order("erp-xr-hu-open", 250_000, H3, "AI_ORDER_SYNC");
  await deliver("erp-xr-ai-cost");
  await deliver("erp-xr-hu-cost");

  // (1) Lãi ĐỦ ở cả hai nhánh, được xem tiền.
  const r1 = await loadExperimentReport({ withMoney: true });
  assert.ok(r1 && r1.withMoney && r1.rateVndPerUsd === rate);
  const { AI: a1, HUMAN: h1 } = r1.arms;
  // Nhánh AI: đơn bán thật (1.150.000 − 2 × 250.000 − 200.000 theo phiếu nhập) + đơn 300.000 (giá vốn 120.000); huỷ / chưa giao không có doanh thu.
  assert.deepEqual([a1.orders, a1.delivered, a1.deliveredRevenueVnd, a1.grossProfitVnd, a1.cogsUnknown, a1.grossProfitPerConversationVnd], [5, 2, 1_450_000, 630_000, 0, 52_500]);
  assert.equal(a1.grossMargin, 630_000 / 1_450_000);
  // Nhánh người: đơn hoàn đã ngã ngũ nhưng không doanh thu, không lãi.
  assert.deepEqual([h1.orders, h1.delivered, h1.deliveryRate, h1.deliveredRevenueVnd, h1.grossProfitVnd, h1.cogsUnknown, h1.grossProfitPerConversationVnd], [4, 1, 0.5, 400_000, 100_000, 0, 8_333]);
  assert.ok(r1.running);
  assert.deepEqual(r1.profitLifts.grossProfitPerConversation, { value: 44_167, bound: "EXACT", reason: null });
  // Tiền AI theo nhánh: AI = 1/64 + 1/256 USD (dòng trước NGÀY vào nhánh, trước mốc sớm nhất, khoá cũ, khung thử, tổ chức khác,
  // tính năng khác bị loại; lượt bị chặn không tính) + 1 lượt chưa định giá ⇒ cận dưới. Người = lượt ghi đơn hộ + lượt của hội
  // thoại nhánh người.
  assert.deepEqual([a1.aiCostVnd, a1.aiTurns, a1.aiUnknownTurns], [vnd(5 / 256), 3, 1]);
  assert.deepEqual([h1.aiCostVnd, h1.aiTurns, h1.aiUnknownTurns], [vnd(5 / 512), 2, 0]);
  assert.deepEqual([a1.profitAfterAiVnd, a1.profitAfterAiPerConversationVnd], [630_000 - vnd(5 / 256), Math.round((630_000 - vnd(5 / 256)) / 12)]);
  assert.deepEqual([h1.profitAfterAiVnd, h1.profitAfterAiPerConversationVnd], [100_000 - vnd(5 / 512), Math.round((100_000 - vnd(5 / 512)) / 12)]);
  assert.deepEqual(r1.profitLifts.profitAfterAiPerConversation, { value: Math.round((630_000 - vnd(5 / 256)) / 12) - Math.round((100_000 - vnd(5 / 512)) / 12), bound: "UPPER", reason: null }, "chi phí nhánh AI là cận dưới ⇒ chênh lệch là cận trên");

  // (1b) Thử nghiệm DỪNG (chế độ rời EXPERIMENT, khoá giữ nguyên): số TỪNG nhánh y nguyên, nhưng KHÔNG chênh lệch lãi nào —
  // chưa lưu mốc dừng nên đơn / tiền AI sau lúc dừng (bot trả lời cả hội thoại nhánh người) vẫn cộng vào nhánh.
  const runningCfg = await loadModeConfig();
  assert.ok("ok" in (await saveModeConfig(ids.admin, { mode: "AUTOPILOT", aiSharePct: 50 })));
  const r1s = await loadExperimentReport({ withMoney: true });
  assert.ok(r1s && !r1s.running && r1s.key === r1.key, "dừng thử nghiệm không đổi khoá");
  assert.deepEqual(r1s.arms, r1.arms, "số từng nhánh không đổi khi dừng");
  const stoppedLift = { value: null, bound: "EXACT", reason: STOPPED_LIFT_REASON };
  assert.deepEqual(r1s.profitLifts, { grossProfitPerConversation: stoppedLift, profitAfterAiPerConversation: stoppedLift });
  assert.deepEqual((await loadExperimentReport({ withMoney: false }))?.profitLifts.grossProfitPerConversation, stoppedLift, "người không xem tiền cũng không thấy chênh lệch lãi khi đã dừng");
  // Chạy lại ĐÚNG khoá cũ (đi qua cửa chế độ thì vào lại EXPERIMENT là MỘT thử nghiệm mới, khoá mới).
  await setSettingJson(OPERATING_MODE_SETTING_KEY, runningCfg);
  assert.equal((await loadExperimentReport({ withMoney: true }))?.profitLifts.grossProfitPerConversation.value, 44_167);

  // (2) Không được xem tiền ⇒ mọi ô tiền AI `null`; lãi gộp giữ nguyên.
  const r2 = await loadExperimentReport({ withMoney: false });
  assert.ok(r2 && !r2.withMoney && r2.rateVndPerUsd === null);
  for (const a of [r2.arms.AI, r2.arms.HUMAN]) assert.deepEqual([a.aiCostVnd, a.aiTurns, a.aiUnknownTurns, a.profitAfterAiVnd, a.profitAfterAiPerConversationVnd], [null, null, null, null, null]);
  assert.deepEqual([r2.arms.AI.grossProfitVnd, r2.arms.HUMAN.grossProfitVnd], [630_000, 100_000]);
  assert.equal((await loadExperimentReport())?.withMoney, false, "mặc định KHÔNG tiền");
  // Sổ AI chỉ được đọc trong nhánh có quyền xem tiền — một chỗ đọc, sau cổng.
  const src = readFileSync("lib/sales-chatbot/experiment-report.ts", "utf8");
  const gate = src.indexOf("const rate = opts.withMoney ? env.facebook.usdToVnd : null;");
  const branch = src.indexOf("if (rate !== null) {", gate);
  const call = src.indexOf("aiCostOfConversationSets(org.code", branch);
  assert.ok(gate > 0 && branch > gate && call > branch && src.indexOf("aiCostOfConversationSets(", call + 1) === -1, "experiment-report.ts: sổ AI chỉ đọc sau cổng withMoney");

  // (3) «AI ghi đơn hộ nhân viên» TẮT ⇒ lãi nhánh người CHƯA ĐO (không phải 0) ⇒ không chênh lệch nào.
  assert.ok("ok" in (await saveOrderSyncConfig(ids.admin, false)));
  const r3 = await loadExperimentReport({ withMoney: true });
  assert.ok(r3);
  assert.deepEqual([r3.arms.HUMAN.grossProfitVnd, r3.arms.HUMAN.cogsUnknown, r3.arms.HUMAN.grossProfitPerConversationVnd, r3.arms.HUMAN.profitAfterAiVnd], [null, null, null, null]);
  assert.equal(r3.arms.HUMAN.aiCostVnd, vnd(5 / 512), "chi phí AI vẫn là số đo của sổ");
  assert.deepEqual([r3.profitLifts.grossProfitPerConversation.value, r3.profitLifts.profitAfterAiPerConversation.value], [null, null]);
  assert.ok("ok" in (await saveOrderSyncConfig(ids.admin, true)));

  // (3b) Nhánh người còn 4 hội thoại fanpage đo được (8 hội thoại chuyển sang Zalo — không có đường ghi đơn hộ) ⇒ dưới mẫu:
  // tổng vẫn in, «/ hội thoại» và chênh lệch trống — trong khi nhánh AI vẫn có số (chênh lệch trống vì MẪU, không vì AI).
  const zaloIds = ids.humanIds.slice(4);
  await db.update(c).set({ channel: "ZALO" }).where(inArray(c.id, zaloIds));
  const r3b = await loadExperimentReport({ withMoney: true });
  assert.ok(r3b);
  const hb = r3b.arms.HUMAN;
  assert.deepEqual([hb.conversations, hb.measurableConversations, hb.grossProfitVnd, hb.grossProfitPerConversationVnd, hb.profitAfterAiVnd, hb.profitAfterAiPerConversationVnd], [12, 4, 100_000, null, 100_000 - vnd(5 / 512), null]);
  assert.ok(hb.note?.includes("fanpage"), String(hb.note));
  assert.equal(r3b.arms.AI.grossProfitPerConversationVnd, 52_500, "nhánh AI vẫn đủ mẫu");
  assert.deepEqual([r3b.profitLifts.grossProfitPerConversation.value, r3b.profitLifts.profitAfterAiPerConversation.value], [null, null], "một nhánh dưới mẫu ⇒ không so");
  await db.update(c).set({ channel: "FANPAGE" }).where(inArray(c.id, zaloIds));

  // (4) Nhánh AI giao một đơn KHÔNG có giá vốn ⇒ đếm riêng; tổng lãi giữ phần biết giá vốn; chia / trừ / so đều trống.
  await deliver("erp-xr-ai-nocost");
  const r4 = await loadExperimentReport({ withMoney: true });
  assert.ok(r4);
  const a4 = r4.arms.AI;
  assert.deepEqual([a4.delivered, a4.deliveredRevenueVnd, a4.grossProfitVnd, a4.cogsUnknown, a4.cogsUnknownRevenueVnd, a4.grossProfitPerConversationVnd, a4.profitAfterAiVnd, a4.profitAfterAiPerConversationVnd], [3, 1_650_000, 630_000, 1, 200_000, null, null, null]);
  assert.equal(a4.aiCostVnd, vnd(5 / 256));
  assert.deepEqual([r4.profitLifts.grossProfitPerConversation, r4.profitLifts.profitAfterAiPerConversation.value], [{ value: null, bound: "EXACT", reason: null }, null], "lãi nhánh AI chưa đủ ⇒ không so (lý do ở dưới ô của nhánh, không ở cấp khối)");

  // Giao diện chỉ HIỂN THỊ chênh lệch lãi của báo cáo (đã chặn khi dừng) và dòng phụ ô chi phí qua hàm chung.
  const block = readFileSync("app/(dashboard)/ai/sales-chatbot/performance/experiment-block.tsx", "utf8");
  assert.ok(block.includes("report.profitLifts.grossProfitPerConversation") && block.includes("report.profitLifts.profitAfterAiPerConversation") && !/grossProfitLift\(|profitAfterAiLift\(/.test(block), "experiment-block.tsx không tự tính chênh lệch lãi");
  assert.ok(block.includes("liftNote: grossLift.reason") && block.includes("liftNote: afterAiLift.reason") && /\{row\.liftNote \? <div[^>]*>\{row\.liftNote\}<\/div> : null\}/.test(block), "lý do ở cấp khối in dưới ô chênh lệch");
  assert.ok(block.includes("sub: aiCostNote") && block.includes('"Lãi sau AI / hội thoại (ước tính)"'), "ô chi phí qua aiCostNote; nhãn lãi sau AI / hội thoại ghi ước tính");
  console.log("  ✓ AI vs người · lợi nhuận (tổ chức thật): lãi gộp đã giao theo nhánh cùng đường giá vốn, hoàn / huỷ không lãi, đơn thiếu giá vốn đứng riêng và chặn chia / trừ / so, chi phí AI theo nhánh từ sổ (ghi đơn hộ ⇒ nhánh người, trước ngày vào nhánh / khoá cũ / khung thử / tổ chức khác không tính, chưa định giá ⇒ cận dưới ⇒ chênh lệch cận trên), nhánh dưới mẫu / chưa đo ⇒ không so, thử nghiệm đã dừng ⇒ số từng nhánh y nguyên nhưng không chênh lệch lãi (kèm lý do), không xem tiền ⇒ null + không đọc sổ, khung Chi phí AI & ROI đúng số dựng tay (cả lọc page)");
}

export async function testSalesExperimentReport() {
  testPure();
  testProfitPure();
  await cleanup();
  for (const code of [ORG, OTHER]) {
    await provisionOrganization({ code, name: `Shop ${code}`, plan: "standard", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `chu@${code}.local`, name: "Chủ shop", password: "NhanhThu@2026!" }, source: "TEST", actor: null });
  }
  try {
    const ids = await withOrganization(ORG, async () => {
      const db = await getDb();
      const admin = await adminOf(ORG);
      const mk = async (name: string, code: string, price: number) => {
        const p = await createProductCore(admin, { name, code, unit: "gói", retailPrice: price, cost: null, variants: [{ sku: code, size: "", color: "", retailPrice: price, cost: null, selling: true }] });
        assert.ok(p.ok, JSON.stringify(p));
        const v = await db.query.productVariants.findFirst({ where: eq(schema.productVariants.productId, p.id) });
        assert.ok(v);
        return v.id;
      };
      const chaMuc = await mk("Chả mực giã tay", "XR-CHA-MUC", 400_000);
      const ruocTom = await mk("Ruốc bông tôm", "XR-RUOC-TOM", 350_000);
      const [rc] = await db.insert(schema.stockReceipts).values({ kind: "RECEIPT", receivedAt: new Date(), reference: "PN-XR-1", totalQuantity: 20, createdBy: admin.email }).returning({ id: schema.stockReceipts.id });
      await db.insert(schema.stockReceiptItems).values([
        { receiptId: rc.id, variantId: chaMuc, quantity: 10, unitCost: 250_000 },
        { receiptId: rc.id, variantId: ruocTom, quantity: 10, unitCost: 200_000 },
      ]);
      await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, connectorKey: "anthropic-byok", enabled: true, shippingFee: null });
      assert.equal(await loadExperimentReport(), null, "chưa chia hội thoại nào ⇒ không có khối");
      assert.ok("ok" in (await saveModeConfig(admin, { mode: "EXPERIMENT", aiSharePct: 50 })));
      const key = (await loadModeConfig()).experimentKey;
      const pin = (arm: "AI" | "HUMAN", k = key) => ({ experiment: { key: k, arm, at: new Date().toISOString() } });

      // Nhánh AI: một hội thoại bán thật tới lúc giao.
      setSalesChatProviderForTests(() => fakeProvider(shopScript({ chaMuc, ruocTom })));
      let sold: string;
      try {
        const vk = visitorKeyOf("xr-khach-web-0123456789abcdefgh");
        const w = await openConversation("WEB", { visitorKey: vk });
        for (const text of ["Chả mực bao nhiêu?", "Cho chị 2 gói, thêm 1 ruốc tôm.", "Nguyễn Thị Lan, 0912345678, 12 Hàng Bạc Hà Nội", "ok chốt đơn"]) assert.ok((await chatTurn(w.id, text, { channel: "WEB", visitorKey: vk })).ok);
        sold = w.id;
      } finally {
        setSalesChatProviderForTests(null);
      }
      const c = schema.salesChatConversations;
      await db.update(c).set({ state: { ...(await db.query.salesChatConversations.findFirst({ where: eq(c.id, sold) }))!.state, ...pin("AI") } }).where(eq(c.id, sold));
      const [soldConv] = await db.select().from(c).where(eq(c.id, sold));
      assert.ok(soldConv.orderId);
      assert.ok((await confirmManualDeliveryCore(admin, soldConv.orderId!, { signedAt: new Date().toISOString(), receiverName: "Lan" })).ok);
      const aiIds: string[] = [];
      for (let i = 0; i < 11; i++) {
        const [a] = await db.insert(c).values({ channel: "FANPAGE", visitorKey: `xr-ai-${i}`, turns: 1, state: pin("AI") }).returning({ id: c.id });
        aiIds.push(a.id);
      }
      // Nhánh người: 12 hội thoại fanpage, một đơn ghi hộ nhân viên (chưa giao).
      const humanIds: string[] = [];
      for (let i = 0; i < 12; i++) {
        const [h] = await db.insert(c).values({ channel: "FANPAGE", visitorKey: `xr-hu-${i}`, turns: 1, state: pin("HUMAN") }).returning({ id: c.id });
        humanIds.push(h.id);
      }
      await db.insert(schema.customers).values({ id: "xr-cus", name: "Khách người" });
      await db.insert(schema.orders).values({ id: "xr-ord-human", customerId: "xr-cus", billFullName: "Khách người", insertedAt: new Date(), totalPriceAfterDiscount: 500_000, origin: "AI_ORDER_SYNC", salesConversationId: humanIds[0] });
      // Khoá thử nghiệm CŨ — không được lẫn vào.
      const [old] = await db.insert(c).values({ channel: "FANPAGE", visitorKey: "xr-old", turns: 1, state: pin("AI", "e-cu") }).returning({ id: c.id });
      return { sold, humanIds, aiIds, oldId: old.id, key, admin };
    });

    await withOrganization(ORG, async () => {
      const off = await loadExperimentReport();
      assert.ok(off);
      assert.equal(off.arms.AI.conversations, 12, "khoá cũ không lẫn vào");
      assert.equal(off.arms.AI.orders, 1);
      assert.equal(off.arms.AI.delivered, 1, "giao bằng phiếu ⇒ ORDER_OUTCOME DELIVERED");
      assert.equal(off.arms.AI.conversion, 1 / 12);
      assert.equal(off.arms.HUMAN.conversations, 12);
      assert.equal(off.arms.HUMAN.orders, null, "ghi đơn hộ TẮT ⇒ nhánh người CHƯA ĐO, không phải 0");
      assert.ok(off.arms.HUMAN.note?.includes("TẮT"));
      assert.ok("ok" in (await saveOrderSyncConfig(ids.admin, true)));
      const on = await loadExperimentReport();
      assert.ok(on);
      assert.equal(on.arms.HUMAN.orders, 1);
      assert.equal(on.arms.HUMAN.conversion, 1 / 12);
      assert.equal(on.arms.HUMAN.delivered, 0);
      assert.equal(on.arms.HUMAN.measurableConversations, 12);

      // Bán chéo: đơn bán thật có chả mực + ruốc ⇒ 1 đơn ≥ 2 sản phẩm, giá trị bán chéo 350.000 ₫. Đơn ghi hộ người (origin
      // AI_ORDER_SYNC) không phải đơn bot chốt ⇒ không vào giỏ.
      const basket = await loadBasketStats({ days: 30 });
      assert.deepEqual([basket.booked.orders, basket.booked.multiProductOrders, basket.booked.crossSellValueVnd, basket.booked.itemsPerOrder], [1, 1, 350_000, 3]);
      assert.deepEqual([basket.delivered.orders, basket.delivered.crossSellValueVnd], [1, 350_000], "đơn đã giao bằng phiếu ⇒ vào giỏ đã giao");
      // Đơn bot chốt thứ hai, CHƯA giao (không vận đơn, không phiếu): vào giỏ đơn chốt, KHÔNG vào giỏ đã giao.
      const db = await getDb();
      await db.insert(schema.orders).values({ id: "xr-ord-ai-2", customerId: "xr-cus", billFullName: "Khách 2", insertedAt: new Date(), totalPriceAfterDiscount: 750_000, origin: "AI_AGENT", salesConversationId: ids.sold });
      await db.insert(schema.orderItems).values([
        { id: "xr-oi-2a", orderId: "xr-ord-ai-2", productId: "cha", quantity: 1, unitPrice: 400_000 },
        { id: "xr-oi-2b", orderId: "xr-ord-ai-2", productId: "ruoc", quantity: 1, unitPrice: 350_000 },
        { id: "xr-oi-2c", orderId: "xr-ord-ai-2", productId: "qua", quantity: 1, unitPrice: 90_000, isBonus: true },
      ]);
      await db.insert(schema.salesConversationEvents).values({ conversationId: ids.sold, cycle: 1, type: "order.confirmed", actorKind: "AI", channel: "WEB", occurredAt: new Date(), orderId: "xr-ord-ai-2", dedupeKey: "xr-ord-ai-2:confirmed" });
      const basket2 = await loadBasketStats({ days: 30 });
      assert.deepEqual([basket2.booked.orders, basket2.booked.multiProductOrders, basket2.booked.crossSellValueVnd], [2, 2, 700_000], "hàng tặng không phải bán chéo");
      assert.deepEqual([basket2.delivered.orders, basket2.delivered.crossSellValueVnd], [1, 350_000], "đơn chưa ngã ngũ không vào giỏ đã giao");
      // Drill-down: hội thoại bán thật có sổ sự kiện ⇒ vào nhóm AI tự xử lý, nhánh AI; không vào nhánh người / lý do sỉ.
      const viewer: SessionUser = { ...ids.admin, id: "xr-viewer", role: "VIEWER", permissions: ["ai_sales:view"] };
      const all = await listDrillConversations(viewer, parseDrillFilter({}));
      assert.ok("ok" in all && all.rows.some((r) => r.id === ids.sold));
      const aiOnly = await listDrillConversations(viewer, parseDrillFilter({ cohort: "AI_ONLY", confirmed: "1", arm: "AI" }));
      assert.ok("ok" in aiOnly && aiOnly.rows.map((r) => r.id).includes(ids.sold));
      const human = await listDrillConversations(viewer, parseDrillFilter({ arm: "HUMAN" }));
      assert.ok("ok" in human && !human.rows.some((r) => r.id === ids.sold));
      const sỉ = await listDrillConversations(viewer, parseDrillFilter({ reason: "WHOLESALE" }));
      assert.ok("ok" in sỉ && sỉ.rows.length === 0);
      const noPerm: SessionUser = { ...viewer, permissions: [] , role: "VIEWER" };
      assert.ok("error" in (await listDrillConversations({ ...noPerm, permissions: ["dashboard:view"] }, parseDrillFilter({}))), "không có ai_sales:view ⇒ từ chối");

      // Xem lại: mở được hội thoại thật; kênh THỬ không.
      const rv = await loadConversationReview(viewer, ids.sold);
      assert.ok("ok" in rv && rv.value.view.messages.length >= 8 && rv.value.events.some((e) => e.type === "order.confirmed") && rv.value.arm === "AI");
      const test = await openConversation("TEST", { createdBy: "xr" });
      assert.ok("error" in (await loadConversationReview(viewer, test.id)), "khung thử không mở ở màn xem lại");
    });

    // Lãi gộp + chi phí AI theo nhánh (Master Mission P0.5 + P1.7).
    await withOrganization(ORG, () => armProfitLive(ids));

    // Tổ chức khác: không thấy lượt nào, không mở được hội thoại bằng id.
    await withOrganization(OTHER, async () => {
      const other = await adminOf(OTHER);
      assert.equal(await loadExperimentReport(), null);
      assert.ok("error" in (await loadConversationReview(other, ids.sold)));
      const d = await listDrillConversations(other, parseDrillFilter({}));
      assert.ok("ok" in d && d.rows.length === 0);
    });
    console.log("  ✓ AI vs người (tổ chức thật): nhánh AI 1/12 đơn giao thật, nhánh người chưa đo khi ghi hộ tắt / có số khi bật, khoá cũ không lẫn, drill-down đúng nhóm, xem lại hội thoại, cô lập tổ chức");
  } finally {
    await cleanup();
  }
}

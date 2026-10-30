/**
 * MISSION CONTROL (chủ shop 30/10/2026) — đo các AI agent ĐANG CÓ theo sổ `lib/constants/department-ai.ts`.
 *
 *  1. THUẦN — không danh sách agent thứ hai (khoá đo = khoá sổ); chưa đo ⇒ null kèm thiếu gì; KHÔNG có điều kiện tốt nghiệp mặc định;
 *     kết luận chỉ khi có luật + đo được + đủ mẫu; ranh giới đúng tỷ lệ.
 *  2. TỔ CHỨC THẬT (PGlite riêng `mc-si`) — khai điều kiện cần settings:manage, khai lặp không ghi, có nhật ký; bot bán hàng: đơn «AI tự
 *     bán» bị huỷ là BÁC, tiền = VERIFIED_CASH của đơn giao thành công; đề xuất buồng lái lấy phản ứng MỚI NHẤT, «nhắc lại sau» không
 *     vào mẫu; sổ dùng AI chỉ đếm dòng của CHÍNH tổ chức (cách ly).
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { AGENT_ZONES } from "@/lib/constants/department-ai";
import { MC_GRADUATION_KEY, MC_MEASURES, MC_ZONES, accuracyOf, graduationVerdict, parseGraduation } from "@/lib/constants/mission-control";
import { setGraduationCore } from "@/lib/mission-control/settings";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { computeMissionControlForTest } from "@/lib/queries/mission-control";

const ORG = "mc-si";
const OTHER = "mc-zz-other";

async function cleanupOrg() {
  const pdb = await getPlatformDb();
  await pdb.delete(schema.platformAiUsage).where(inArray(schema.platformAiUsage.orgCode, [ORG, OTHER]));
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, ORG) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

function testPure() {
  assert.deepEqual(Object.keys(MC_MEASURES).sort(), [...AGENT_ZONES].sort(), "khoá đo = khoá sổ department-ai — không có danh sách agent thứ hai");
  assert.deepEqual(MC_ZONES, AGENT_ZONES);
  for (const z of AGENT_ZONES) {
    const m = MC_MEASURES[z];
    if (!m.usageFeatures.length) assert.ok((m.usageNone ?? "").length > 20, `${z}: không dùng AI thì phải nói vì sao (khác «chưa đo»)`);
    if (m.review.kind === "NONE") assert.ok(m.review.missing.length > 20, `${z}: chưa đo duyệt / bác phải nói thiếu gì cụ thể`);
    if (m.outcome.kind === "NONE") assert.ok(m.outcome.missing.length > 10, `${z}: chưa đo tiền phải nói thiếu gì`);
  }
  // KHÔNG có bộ mặc định: chưa khai ⇒ rỗng; giá trị hỏng ⇒ bỏ, không đoán.
  assert.deepEqual(parseGraduation(undefined), {});
  assert.deepEqual(parseGraduation({}), {});
  assert.deepEqual(parseGraduation({ SALES: { minAccuracyPct: 0, minSamples: 10, windowDays: 30 }, MARKETING: "90%", NOPE: { minAccuracyPct: 90, minSamples: 1, windowDays: 1 } }), {}, "tỷ lệ 0 / chuỗi / khoá lạ đều bị bỏ");
  assert.deepEqual(parseGraduation({ SALES: { minAccuracyPct: 90, minSamples: 30, windowDays: 30 } }), { SALES: { minAccuracyPct: 90, minSamples: 30, windowDays: 30 } });

  assert.equal(accuracyOf({ correct: 0, rejected: 0, sample: 0 }), null, "mẫu 0 ⇒ chưa biết, không phải 0%");
  const rule = { minAccuracyPct: 80, minSamples: 10, windowDays: 30 };
  assert.equal(graduationVerdict(undefined, { correct: 100, rejected: 0, sample: 100 }).kind, "NO_RULE", "chưa khai ⇒ KHÔNG kết luận dù số đẹp");
  assert.equal(graduationVerdict(rule, null).kind, "NOT_MEASURABLE");
  assert.equal(graduationVerdict(rule, { correct: 9, rejected: 0, sample: 9 }).kind, "INSUFFICIENT_SAMPLE", "9/9 đúng nhưng thiếu mẫu ⇒ không kết luận");
  assert.equal(graduationVerdict(rule, { correct: 8, rejected: 2, sample: 10 }).kind, "PASS", "80% = đích ⇒ đủ");
  assert.equal(graduationVerdict(rule, { correct: 7, rejected: 3, sample: 10 }).kind, "FAIL");

  const goc = path.resolve(__dirname, "..");
  const page = readFileSync(path.join(goc, "app/(dashboard)/departments/mission-control/page.tsx"), "utf8");
  assert.ok(!/AGENTS\s*\[|name:\s*"/.test(page), "trang không tự khai agent — đọc hàng từ loadMissionControl");
  assert.ok(page.includes("chưa đo được"), "chỉ số chưa đo in «chưa đo được», không 0");
  const q = readFileSync(path.join(goc, "lib/queries/mission-control.ts"), "utf8");
  assert.ok(q.includes("memo(") && q.includes("90_000"), "đệm 60–120 giây theo lib/cache");
  assert.ok(!/autonomy\s*=|AGENTS\[[^\]]+\]\.autonomy\s*=/.test(q), "không đường nào đổi nấc tự chủ");
}

export async function testMissionControl() {
  testPure();
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "Shop thử Mission Control", plan: "standard", modules: ["customers", "products", "orders"], admin: { email: `admin@${ORG}.local`, name: "QT MC", password: "MissionCtl@12345" }, source: "TEST", actor: null });
  try {
    const now = new Date();
    const pdb = await getPlatformDb();
    await pdb.insert(schema.platformAiUsage).values([
      { orgCode: ORG, feature: "sales_chatbot", billingSource: "PLATFORM", requests: 2, status: "OK", costUsd: 0.25, inputTokens: 1000, outputTokens: 200, at: now },
      { orgCode: ORG, feature: "sales_chatbot", billingSource: "PLATFORM", requests: 1, status: "OK", costUsd: null, inputTokens: null, outputTokens: null, at: now },
      { orgCode: ORG, feature: "copilot", billingSource: "PLATFORM", requests: 1, status: "OK", costUsd: 0.5, inputTokens: 10, outputTokens: 10, at: new Date(now.getTime() - 20 * 86_400_000) },
      // Tổ chức KHÁC — không được lọt vào số của `mc-si`.
      { orgCode: OTHER, feature: "sales_chatbot", billingSource: "PLATFORM", requests: 9, status: "OK", costUsd: 9, inputTokens: 9, outputTokens: 9, at: now },
    ]);

    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const org = { code: ORG, name: "Shop thử Mission Control", isHome: false };
      const admin: SessionUser = { id: u.id, email: u.email, name: "QT MC", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: org };
      const manager: SessionUser = { ...admin, role: "MANAGER", permissions: ["approvals:decide", "dashboard:view"] };

      // ── Điều kiện tốt nghiệp: quyền · idempotent · nhật ký · xoá về «chưa khai» ──
      assert.ok(!(await setGraduationCore(manager, { zone: "MARKETING", rule: { minAccuracyPct: 50, minSamples: 3, windowDays: 30 } })).ok, "không có settings:manage ⇒ không khai được");
      assert.ok(!(await setGraduationCore(admin, { zone: "KHONG_CO", rule: null })).ok, "agent ngoài sổ ⇒ từ chối");
      const r1 = await setGraduationCore(admin, { zone: "MARKETING", rule: { minAccuracyPct: 50, minSamples: 3, windowDays: 30 } });
      assert.ok(r1.ok && r1.changed);
      const r2 = await setGraduationCore(admin, { zone: "MARKETING", rule: { minAccuracyPct: 50, minSamples: 3, windowDays: 30 } });
      assert.ok(r2.ok && !r2.changed, "khai lặp ⇒ không ghi");
      const audits = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "MISSION_CONTROL_GRADUATION"), eq(schema.auditLogs.entityId, MC_GRADUATION_KEY)));
      assert.equal(audits.length, 1);

      // ── Dữ liệu: đề xuất buồng lái (Marketing) + đơn bot (Kinh doanh) ──
      const at = (minAgo: number) => new Date(now.getTime() - minAgo * 60_000);
      await db.insert(schema.recommendationDecisions).values([
        { sourceKey: "ads:CUT:a", kind: "ADS_CUT", decision: "ACCEPTED", decidedByUserId: u.id, decidedAt: at(30), snapshot: {} },
        { sourceKey: "ads:CUT:a", kind: "ADS_CUT", decision: "DISMISSED", reason: "đổi ý sau khi xem lại", decidedByUserId: u.id, decidedAt: at(10), snapshot: {} },
        { sourceKey: "ads:CUT:b", kind: "ADS_CUT", decision: "ACCEPTED", decidedByUserId: u.id, decidedAt: at(20), snapshot: {} },
        { sourceKey: "ads:CUT:c", kind: "ADS_CUT", decision: "SNOOZED", snoozeUntil: new Date(now.getTime() + 86_400_000), decidedByUserId: u.id, decidedAt: at(5), snapshot: {} },
        // Quyết định của NGƯỜI (duyệt hai bước) — không phải đề xuất máy, không thuộc agent nào.
        { sourceKey: "approval:x", kind: "APPROVAL", decision: "ACCEPTED", decidedByUserId: u.id, decidedAt: at(5), snapshot: {} },
      ]);

      const [conv] = await db.insert(schema.salesChatConversations).values({ channel: "FANPAGE", pageId: "P1", threadId: "P1_123" }).returning({ id: schema.salesChatConversations.id });
      const order = (id: string, stage: string) => ({ id, stage: stage as never, insertedAt: at(60), totalPriceAfterDiscount: 400_000, moneyToCollect: 400_000, cod: 400_000, source: "Facebook" });
      await db.insert(schema.orders).values([order("mc-o1", "DELIVERED"), order("mc-o2", "CANCELLED"), order("mc-o3", "DELIVERED")]);
      await db.insert(schema.shipments).values([
        { orderId: "mc-o1", vtpOrderNumber: "MC-1", stage: "DELIVERED" as never, codAmount: 400_000, codCollected: 300_000 },
        // Giao xong mà CHƯA có chứng từ tiền.
        { orderId: "mc-o3", vtpOrderNumber: "MC-3", stage: "DELIVERED" as never, codAmount: 400_000 },
      ]);
      const ev = (type: string, actorKind: string, orderId: string, minAgo: number) => ({ conversationId: conv.id, type, actorKind, channel: "FANPAGE", occurredAt: at(minAgo), orderId, dedupeKey: `mc-${type}-${orderId}` });
      await db.insert(schema.salesConversationEvents).values([
        ev("order.drafted", "AI", "mc-o1", 50),
        ev("order.confirmed", "CUSTOMER", "mc-o1", 49),
        ev("order.drafted", "AI", "mc-o2", 40),
        ev("order.confirmed", "CUSTOMER", "mc-o2", 39),
        ev("order.drafted", "AI", "mc-o3", 30),
        ev("order.confirmed", "CUSTOMER", "mc-o3", 29),
      ]);

      const mc = await computeMissionControlForTest(now);
      assert.equal(mc.orgCode, ORG);
      assert.deepEqual(mc.zones.map((z) => z.zone), [...AGENT_ZONES], "một hàng cho mỗi khoá của sổ, đúng thứ tự sổ");
      const zone = (k: string) => mc.zones.find((z) => z.zone === k)!;

      // Sổ dùng AI: chỉ dòng của CHÍNH tổ chức; lượt chưa định giá đứng riêng, không cộng là 0.
      const sales = zone("SALES");
      assert.deepEqual(sales.usage?.[7], { turns: 2, requests: 3, inputTokens: 1000, outputTokens: 200, costUsd: 0.25, unknownCost: 1 }, "tổ chức khác (9 USD) không lọt vào");
      assert.equal(zone("MANAGEMENT").usage?.[7].turns, 0, "copilot 20 ngày trước: ngoài cửa sổ 7 ngày");
      assert.equal(zone("MANAGEMENT").usage?.[30].turns, 1);
      assert.equal(zone("MANAGEMENT").usage?.[7].costUsd, null, "không lượt nào ⇒ chi phí CHƯA BIẾT (—), không 0");
      assert.equal(zone("LOGISTICS").usage, null, "agent chạy bằng luật ⇒ KHÔNG ÁP DỤNG, không phải 0 lượt");

      // Bot bán hàng: 3 đơn AI tự bán đã ngã ngũ, 1 bị huỷ ⇒ 2/3 đúng; tiền = COD THỰC THU 300K (đơn còn lại chưa chứng từ).
      assert.deepEqual(sales.review?.[30], { correct: 2, rejected: 1, sample: 3 });
      assert.deepEqual(sales.outcome?.[30], { delivered: 2, verifiedCash: 300_000 }, "tiền là VERIFIED_CASH, không phải 800K giá trị đơn");

      // Đề xuất Marketing: phản ứng MỚI NHẤT — a bị bác (đổi ý), b chấp nhận, c nhắc lại sau (ngoài mẫu); APPROVAL không thuộc agent.
      const mk = zone("MARKETING");
      assert.deepEqual(mk.review?.[30], { correct: 1, rejected: 1, sample: 2 });
      assert.deepEqual(mk.verdict, { kind: "INSUFFICIENT_SAMPLE", sample: 2, need: 3 }, "đủ luật nhưng thiếu mẫu ⇒ KHÔNG kết luận");
      assert.equal(zone("FINANCE").review, null, "chưa có nguồn duyệt / bác ⇒ null (chưa đo được), không 0%");
      assert.equal(zone("FINANCE").verdict.kind, "NO_RULE");
      assert.equal(sales.verdict.kind, "NO_RULE", "chưa khai điều kiện ⇒ chỉ hiện số thực tế");

      await setGraduationCore(admin, { zone: "MARKETING", rule: { minAccuracyPct: 50, minSamples: 2, windowDays: 30 } });
      await setGraduationCore(admin, { zone: "FINANCE", rule: { minAccuracyPct: 90, minSamples: 1, windowDays: 7 } });
      const mc2 = await computeMissionControlForTest(now);
      const mk2 = mc2.zones.find((z) => z.zone === "MARKETING")!;
      assert.equal(mk2.verdict.kind, "PASS", "50% đúng = đích 50%, đủ 2 mẫu ⇒ đủ điều kiện");
      assert.equal(mk2.autonomy, "COPILOT", "đủ điều kiện KHÔNG đổi nấc tự chủ");
      assert.equal(mc2.zones.find((z) => z.zone === "FINANCE")!.verdict.kind, "NOT_MEASURABLE", "có luật mà không có nguồn đo ⇒ không kết luận");

      // Xoá ⇒ trở về «chưa khai», không về một con số mặc định.
      const del = await setGraduationCore(admin, { zone: "MARKETING", rule: null });
      assert.ok(del.ok && del.changed);
      const mc3 = await computeMissionControlForTest(now);
      assert.equal(mc3.zones.find((z) => z.zone === "MARKETING")!.verdict.kind, "NO_RULE");
    });

    // ── Cách ly: tổ chức nhà không thấy số của `mc-si` ──
    const home = await computeMissionControlForTest(now);
    assert.notEqual(home.orgCode, ORG);
    assert.deepEqual(home.zones.map((z) => z.zone), [...AGENT_ZONES], "tổ chức nhà dựng cùng bảng từ CSDL của chính nó");
    const homeDecisions = await (await getDb()).select().from(schema.recommendationDecisions).where(eq(schema.recommendationDecisions.sourceKey, "ads:CUT:a"));
    assert.equal(homeDecisions.length, 0, "đề xuất của tổ chức khác không có ở CSDL nhà");
  } finally {
    await cleanupOrg();
  }
  console.log("✓ Mission Control: một hàng cho mỗi khoá sổ department-ai · chưa đo ⇒ null kèm thiếu gì · không có điều kiện tốt nghiệp mặc định · kết luận chỉ khi có luật + đo được + đủ mẫu · không đổi nấc · bot bán hàng: huỷ = bác, tiền = VERIFIED_CASH · đề xuất lấy phản ứng mới nhất · sổ dùng AI chỉ của chính tổ chức");
}

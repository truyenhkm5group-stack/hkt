/**
 * PHÁT LẠI HỘI THOẠI CŨ (lib/sales-chatbot/replay*.ts · docs/productization/22_HISTORICAL_REPLAY.md).
 *
 *  1. THUẦN — đọc số tiền tiếng Việt (nhóm nghìn · k · tr · triệu, không đọc SĐT / số lượng), chọn điểm tất định (rải đều
 *     trong hội thoại, trần mỗi hội thoại, câu thật chỉ tính khi đứng trước tin khách kế tiếp), chấm điểm (giá có căn cứ
 *     = giá bảng ∪ số công cụ trả ∪ phí ship ∪ số shop đã nói), tổng hợp (mẫu < 5 ⇒ null, ma trận chuyển người).
 *  2. TỔ CHỨC THẬT `rp-shop` + provider giả (không gọi mạng — AGENTS §65): nguồn chỉ là hội thoại khách thật trong khoảng
 *     ngày (không THỬ, không hội thoại quá hạn); mỗi điểm chạy ở kênh THỬ rồi hội thoại tạm bị XOÁ; giá bịa bị cờ, giá bảng
 *     không; người trả lời thật được nhận ra qua tiền tố «[Shop đã nhắn]»; hội thoại nguồn không đổi một byte; 0 đơn;
 *     một lượt mỗi lúc; người chỉ xem không chạy được; tổ chức khác không đọc được lượt.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { eq, inArray, like, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { AiBlock, AiProvider, AiRequest, AiResponse } from "@/lib/ai/provider";
import type { SessionUser } from "@/lib/auth/session";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { setSalesChatProviderForTests } from "@/lib/sales-chatbot/engine";
import { listReplayRuns, loadReplayRun, runReplay, startReplay } from "@/lib/sales-chatbot/replay";
import { extractMoneyAmounts, judgePoint, pickReplayPoints, summarizeReplay, type SourceConversation } from "@/lib/sales-chatbot/replay-shared";
import { setSettingJson } from "@/lib/settings";
import { rowsOf } from "@/lib/sql-rows";

const ORG = "rp-shop";
const OTHER = "rp-khac";

function testPure() {
  assert.deepEqual(extractMoneyAmounts("Dạ chả mực 250.000đ/kg, ship 30k, combo 1,5tr ạ"), [30_000, 250_000, 1_500_000]);
  assert.deepEqual(extractMoneyAmounts("Tổng 1.250.000 ₫ (2 kg)"), [1_250_000]);
  assert.deepEqual(extractMoneyAmounts("SĐT em 0912345678, lấy 2 hộp 500g"), [], "SĐT / số lượng / gram không phải tiền");
  assert.deepEqual(extractMoneyAmounts("giá 2 triệu"), [2_000_000]);
  assert.deepEqual(extractMoneyAmounts("ok kakaka"), [], "chữ k trong từ không phải nghìn");

  const T = (d: number) => new Date(Date.UTC(2026, 9, d));
  const conv = (id: string, d: number, roles: ("u" | "a" | "s")[]): SourceConversation => ({
    id,
    channel: "FANPAGE",
    createdAt: T(d),
    messages: roles.map((r, i) => ({ seq: i + 1, role: r === "u" ? "user" : "assistant", text: r === "s" ? `[Shop đã nhắn] câu ${i + 1}` : `câu ${i + 1}` })),
  });
  const sources = [conv("c-old", 1, ["u", "a"]), conv("c-new", 3, ["u", "s", "u", "a", "u", "u", "a", "u"])];
  const pts = pickReplayPoints(sources, 10, 3);
  assert.deepEqual(
    pts.map((p) => `${p.conversationId}:${p.seq}`),
    ["c-new:1", "c-new:5", "c-new:8", "c-old:1"],
    "hội thoại mới trước · rải đều (đầu · giữa · cuối) · trần 3 điểm mỗi hội thoại",
  );
  assert.deepEqual(pickReplayPoints(sources, 10, 3), pts, "tất định");
  assert.equal(pts[0].historicalSpeaker, "SHOP");
  assert.equal(pts[0].historicalReply, "câu 2", "bỏ tiền tố «[Shop đã nhắn]» khỏi câu thật");
  assert.equal(pts[1].historicalSpeaker, "NONE", "khách nhắn tiếp (seq 6) TRƯỚC khi có câu trả lời ⇒ chỗ ấy không ai trả lời");
  assert.equal(pts[2].historicalSpeaker, "NONE", "tin cuối không có câu trả lời");
  assert.equal(pts[1].history.length, 4);
  assert.equal(pickReplayPoints(sources, 2, 3).length, 2, "trần tổng");

  const grounded = new Set([250_000, 30_000]);
  const good = judgePoint({ historicalSpeaker: "BOT" }, { ok: true, aiReply: "Dạ 250.000đ ạ, ship 30k", aiStatus: "OPEN", tools: [] }, grounded);
  assert.deepEqual(good.flags, []);
  const toolNumber = judgePoint({ historicalSpeaker: "BOT" }, { ok: true, aiReply: "Tổng 530.000đ", aiStatus: "OPEN", tools: [{ name: "calculate_cart", ok: true, summary: "Tổng 530.000 ₫" }] }, grounded);
  assert.deepEqual(toolNumber.flags, [], "số do công cụ trả trong lượt là có căn cứ");
  const bad = judgePoint({ historicalSpeaker: "SHOP" }, { ok: true, aiReply: "Giảm còn 199k cho chị", aiStatus: "HANDOFF", tools: [{ name: "x", ok: false, summary: "lỗi" }] }, grounded);
  assert.deepEqual(bad.flags, ["PRICE_UNGROUNDED", "TOOL_ERROR", "AI_HANDOFF", "HISTORY_HUMAN"]);
  assert.deepEqual(bad.ungrounded, [199_000]);
  const err = judgePoint({ historicalSpeaker: "NONE" }, { ok: false, aiReply: "", aiStatus: null, tools: [] }, grounded);
  assert.deepEqual(err.flags, ["ERROR"], "AI hỏng thì không chấm giá");

  const sum = summarizeReplay([
    { conversationId: "a", flags: ["AI_HANDOFF", "HISTORY_HUMAN"], aiReply: "x" },
    { conversationId: "a", flags: ["PRICE_UNGROUNDED"], aiReply: "199k" },
    { conversationId: "b", flags: ["ERROR"], aiReply: null },
  ]);
  assert.equal(sum.points, 3);
  assert.equal(sum.conversations, 2);
  assert.equal(sum.answered, 2);
  assert.equal(sum.errorRate, null, "mẫu < 5 ⇒ null, không in 33%");
  assert.deepEqual(sum.handoff, { bothHuman: 1, aiOnly: 0, historyOnly: 0, neither: 2 });
  assert.equal(sum.pointsWithAmounts, 1);
  const many = summarizeReplay(Array.from({ length: 5 }, (_, i) => ({ conversationId: `c${i}`, flags: i === 0 ? (["ERROR"] as const) : ([] as const), aiReply: "ok" })));
  assert.equal(many.errorRate, 0.2);
  console.log("  ✓ phát lại (thuần): số tiền tiếng Việt, chọn điểm tất định, căn cứ giá, ma trận chuyển người, mẫu < 5 ⇒ null");
}

function fakeProvider(onCall: () => void): AiProvider {
  return {
    name: "fake",
    model: "claude-sonnet-5",
    schemaDialect: "anthropic",
    async complete(req: AiRequest): Promise<AiResponse> {
      onCall();
      const last = [...req.messages].reverse().find((m) => m.role === "user");
      const text = (last?.content as AiBlock[] | string | undefined) ?? "";
      const said = typeof text === "string" ? text : text.map((b) => (b.type === "text" ? b.text : "")).join(" ");
      const reply = /ship/i.test(said) ? "Dạ phí ship ra Huế 45.000đ ạ" : /giá/i.test(said) ? "Dạ chả mực 250.000đ/kg ạ" : "Dạ em nghe ạ";
      return { content: [{ type: "text", text: reply }], stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
    },
  };
}

async function cleanup() {
  const pdb = await getPlatformDb();
  await pdb.delete(schema.platformAiUsage).where(inArray(schema.platformAiUsage.orgCode, [ORG, OTHER]));
  for (const code of [ORG, OTHER]) {
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
    if (org) {
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(schema.platformFlagOverrides).where(eq(schema.platformFlagOverrides.organizationId, org.id));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
    }
    rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  }
  await pdb.delete(schema.platformAuditLog).where(inArray(schema.platformAuditLog.targetOrgCode, [ORG, OTHER]));
  invalidateOrganizations();
  invalidateCapabilities();
}

async function userOf(org: string, role: "ADMIN" | "VIEWER", permissions: string[] = []): Promise<SessionUser> {
  const u = await withOrganization(org, async () => (await getDb()).query.users.findFirst({ where: eq(schema.users.email, `admin@${org}.local`) }));
  assert.ok(u);
  return { id: u.id, email: u.email, name: u.name, role, permissions, scope: "ALL", departmentCodes: [], positionId: null, organization: { code: org, name: org, isHome: false } };
}

async function messagesHash(): Promise<string> {
  const db = await getDb();
  const rows = rowsOf<Record<string, unknown>>(await db.execute(sql`select conversation_id, seq, role, content from sales_chat_messages where conversation_id in (select id from sales_chat_conversations where channel <> 'TEST') order by conversation_id, seq`));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export async function testSalesReplay() {
  testPure();
  await cleanup();
  for (const code of [ORG, OTHER]) {
    await provisionOrganization({ code, name: `Shop ${code}`, plan: "standard", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${code}.local`, name: `QT ${code}`, password: "PhatLai@12345" }, source: "TEST", actor: null });
  }
  let calls = 0;
  setSalesChatProviderForTests(() => fakeProvider(() => (calls += 1)));
  try {
    const admin = await userOf(ORG, "ADMIN");
    const viewer = await userOf(ORG, "VIEWER", ["ai_sales:view"]);
    const now = new Date();
    const runId = await withOrganization(ORG, async () => {
      const db = await getDb();
      await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, connectorKey: "anthropic-byok", enabled: true, shippingFee: 30_000 });
      await db.insert(schema.products).values({ id: "rp-p1", name: "Chả mực Hạ Long" });
      await db.insert(schema.productVariants).values({ id: "rp-v1", productId: "rp-p1", sku: "CM1", retailPrice: 250_000 });
      const c = schema.salesChatConversations;
      const [src] = await db.insert(c).values({ channel: "FANPAGE", visitorKey: "rp-thread-1", pageId: "rp-page", threadId: "rp-thread-1", turns: 3, createdAt: new Date(now.getTime() - 2 * 86_400_000) }).returning({ id: c.id });
      const msg = (seq: number, role: "user" | "assistant", text: string) => ({ conversationId: src.id, seq, role, content: [{ type: "text", text }] });
      await db.insert(schema.salesChatMessages).values([msg(1, "user", "cho em hỏi giá chả mực"), msg(2, "assistant", "[Shop đã nhắn] Dạ 250.000đ ạ"), msg(3, "user", "ship ra Huế bao nhiêu"), msg(4, "assistant", "Dạ ship 30.000đ ạ"), msg(5, "user", "ok em lấy")]);
      // Không phải nguồn: hội thoại THỬ, và hội thoại khách quá khoảng ngày.
      const [test] = await db.insert(c).values({ channel: "TEST", turns: 1 }).returning({ id: c.id });
      await db.insert(schema.salesChatMessages).values({ conversationId: test.id, seq: 1, role: "user", content: [{ type: "text", text: "khung thử hỏi giá" }] });
      const [old] = await db.insert(c).values({ channel: "WEB", visitorKey: "rp-old", turns: 1, createdAt: new Date(now.getTime() - 40 * 86_400_000) }).returning({ id: c.id });
      await db.insert(schema.salesChatMessages).values({ conversationId: old.id, seq: 1, role: "user", content: [{ type: "text", text: "tin cũ quá khoảng ngày" }] });

      assert.ok("error" in (await startReplay(viewer, { points: 5, days: 7 })), "người chỉ xem không chạy được (tốn AI của shop)");
      assert.ok("error" in (await startReplay(admin, { points: 7, days: 7 })), "số điểm ngoài danh sách");
      const before = await messagesHash();
      const started = await startReplay(admin, { points: 5, days: 7 }, now);
      assert.ok("ok" in started, JSON.stringify(started));
      assert.ok("error" in (await startReplay(admin, { points: 5, days: 7 }, now)), "một lượt mỗi lúc");
      const done = await runReplay(started.runId, { id: admin.id });
      assert.equal(done?.status, "DONE", JSON.stringify(done));
      assert.equal(await messagesHash(), before, "hội thoại nguồn không đổi một byte");
      const temp = await db.select({ n: sql<number>`count(*)::int` }).from(c).where(like(c.createdBy, "replay:%"));
      assert.equal(Number(temp[0].n), 0, "hội thoại tạm của lượt phát lại bị xoá");
      assert.equal((await db.select().from(schema.orders)).length, 0, "kênh THỬ không tạo đơn");
      return started.runId;
    });
    assert.equal(calls, 3, "một lượt AI cho mỗi điểm — 3 tin khách của hội thoại nguồn");

    const detail = await withOrganization(ORG, () => loadReplayRun(viewer, runId));
    assert.ok("ok" in detail);
    const bySeq = new Map(detail.points.map((p) => [p.sourceSeq, p]));
    assert.deepEqual([...bySeq.keys()].sort(), [1, 3, 5], "chỉ tin khách của hội thoại khách thật trong khoảng ngày");
    assert.equal(bySeq.get(1)!.historicalSpeaker, "SHOP");
    assert.equal(bySeq.get(1)!.historicalReply, "Dạ 250.000đ ạ");
    assert.equal(bySeq.get(1)!.aiReply, "Dạ chả mực 250.000đ/kg ạ");
    assert.ok(!bySeq.get(1)!.flags.includes("PRICE_UNGROUNDED"), "giá bảng là có căn cứ");
    assert.ok(bySeq.get(1)!.flags.includes("HISTORY_HUMAN"));
    assert.equal(bySeq.get(3)!.historicalSpeaker, "BOT");
    assert.ok(bySeq.get(3)!.flags.includes("PRICE_UNGROUNDED"), "45.000đ không phải phí ship đã khai (30.000đ)");
    assert.deepEqual(bySeq.get(3)!.ungroundedAmounts, [45_000]);
    assert.equal(bySeq.get(3)!.historyMessages, 2);
    assert.equal(bySeq.get(5)!.historicalSpeaker, "NONE");
    assert.equal(detail.run.summary?.points, 3);
    assert.equal(detail.run.summary?.priceUngroundedRate, null, "2 câu có tiền < 5 ⇒ chưa in tỷ lệ");
    assert.equal(detail.run.summary?.flagCounts.PRICE_UNGROUNDED, 1);

    // Tổ chức khác: không thấy lượt, không mở được bằng id.
    const other = await userOf(OTHER, "ADMIN");
    await withOrganization(OTHER, async () => {
      const list = await listReplayRuns(other);
      assert.ok("ok" in list && list.runs.length === 0);
      assert.ok("error" in (await loadReplayRun(other, runId)), "id lượt của tổ chức khác ⇒ không có");
    });
    console.log("  ✓ phát lại (tổ chức thật): nguồn đúng, chạy ở kênh THỬ rồi xoá, giá bịa bị cờ, 0 đơn, một lượt mỗi lúc, cô lập tổ chức");
  } finally {
    setSalesChatProviderForTests(null);
    await cleanup();
  }
}

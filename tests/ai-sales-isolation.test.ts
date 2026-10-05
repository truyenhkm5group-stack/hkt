/**
 * ═══════════ AI BÁN HÀNG — TẤN CÔNG CÔ LẬP TỔ CHỨC (yêu cầu P0 «Fashion không đọc / sửa được HSLC và ngược lại») ═══════════
 *
 * `tests/tenant-attack.test.ts` dựng trước khi có module `ai_sales` (0180+) nên chưa đòn nào nhắm vào hội thoại, câu trả
 * lời mẫu, ảnh, sổ dùng AI của chatbot bán hàng. Bài này lấp đúng mặt đó, trên hai tổ chức THẬT `asi-a` / `asi-b` (hai
 * CSDL PGlite riêng, tự cấp, tự dọn). B có: hội thoại FANPAGE đang chờ người (HANDOFF) + tin nhắn, hội thoại THỬ, câu
 * trả lời mẫu + ảnh. Người quản trị của A (có `ai_sales:manage`) gọi THẲNG lõi bằng id của B trong ngữ cảnh A:
 *  · đọc: xem hội thoại · gõ một lượt vào hội thoại (kênh thử / fanpage) · đọc ảnh câu mẫu · danh sách hội thoại / câu mẫu;
 *  · ghi: trả hội thoại về AI · bật / xoá câu mẫu · thêm / xoá ảnh của câu mẫu;
 *  · bề mặt ra đời sau (04/10 tối): mở lượt phát lại bằng id · danh sách lượt phát lại · gợi ý Copilot · màn «Hiệu quả»
 *    (sổ sự kiện) của chính kẻ tấn công không được mang chữ của nạn nhân; bốn bảng ấy vào ảnh chụp trước = sau.
 * Mọi lượt phải bị từ chối / rỗng, và:
 *  · ẢNH CHỤP mọi bảng `sales_chat_*` của B (số dòng + băm nội dung) TRƯỚC = SAU;
 *  · không lượt gọi nào ghi sổ dùng AI (`platform_ai_usage`) dưới mã của B, và không lượt nào tới provider AI;
 *  · kết quả trả về không mang dấu của nạn nhân (`markOf(B)` — mọi chữ của B đều có nó).
 * Đòn ngược (B đánh A) chạy cùng bộ để luật đối xứng, không phải may mắn của thứ tự gieo.
 *
 * Kiểm đột biến (04/10/2026), mỗi cái làm bài này ĐỎ: đệm CSDL tổ chức trả handle của tổ chức mở đầu tiên thay vì theo
 * mã (`db/index.ts::getOrgDb` — 6 đòn lọt: xem hội thoại, trả về AI, đọc ảnh, bật / xoá câu mẫu, danh sách lẫn) · và
 * `withOrganization` bỏ qua mã truyền vào (mọi tổ chức rơi về CSDL nhà — gieo đã hỏng ngay ở bước tìm quản trị).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { eq, inArray, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { chatTurn, conversationView, listConversations, openConversation, resumeConversationToAi } from "@/lib/sales-chatbot/engine";
import { addQuickReplyImages, deleteQuickReply, listQuickReplies, readQuickReplyImage, removeQuickReplyImage, saveQuickReply, setQuickReplyActive } from "@/lib/sales-chatbot/quick-replies";
import { recordConversationEvent } from "@/lib/sales-chatbot/events";
import { loadCopilotView } from "@/lib/sales-chatbot/operating-mode";
import { loadAiSalesPerformance } from "@/lib/sales-chatbot/performance";
import { loadOrderAttribution } from "@/lib/sales-chatbot/attribution";
import { listReplayRuns, loadReplayRun } from "@/lib/sales-chatbot/replay";
import { rowsOf } from "@/lib/sql-rows";

const A = "asi-a";
const B = "asi-b";
const ORGS = [A, B] as const;
/** Dấu riêng của từng tổ chức — mọi chữ gieo vào tổ chức X mang `markOf(X)`; thấy dấu của nạn nhân trong kết quả là rò rỉ. */
const markOf = (org: string) => `ASI-BIMAT-${org.toUpperCase()}-7731`;

/** Ảnh PNG 1×1 thật (chữ ký + IHDR + IDAT + IEND). */
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

const SALES_TABLES = ["sales_chat_conversations", "sales_chat_messages", "sales_chat_quick_replies", "sales_chat_quick_reply_images", "sales_conversation_events", "sales_replay_runs", "sales_replay_points", "sales_copilot_suggestions"] as const;

type Seeded = { admin: SessionUser; fanpageConv: string; testConv: string; quickReply: string; image: string; replayRun: string; suggestion: string };

async function adminOf(org: string): Promise<SessionUser> {
  const u = await withOrganization(org, async () => (await getDb()).query.users.findFirst({ where: eq(schema.users.email, `admin@${org}.local`) }));
  assert.ok(u, `quản trị của ${org}`);
  return { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: org, name: org, isHome: false } };
}

/** Giá trị đơn mẫu khác nhau theo tổ chức — để phép đọc quy kết lẫn số của tổ chức kia lộ ra ngay. */
const orderValueOf = (org: string) => 100_000 + (ORGS as readonly string[]).indexOf(org) * 11_000;

async function seed(org: string): Promise<Seeded> {
  const admin = await adminOf(org);
  const MARK = markOf(org);
  return withOrganization(org, async () => {
    const db = await getDb();
    const c = schema.salesChatConversations;
    const [fan] = await db
      .insert(c)
      .values({ channel: "FANPAGE", status: "HANDOFF", visitorKey: `${org}-thread`, handoffReason: `Khách sỉ ${MARK}`, pageId: `${org}-page`, threadId: `${org}-thread`, state: { note: MARK } })
      .returning({ id: c.id });
    await db.insert(schema.salesChatMessages).values({ conversationId: fan.id, seq: 1, role: "user", content: [{ type: "text", text: `Cho em giá sỉ ${MARK}` }] });
    const test = await openConversation("TEST", { createdBy: admin.email });
    const qr = await saveQuickReply(admin, { title: `Giá ship ${MARK}`, triggers: ["phí ship"], answer: `Phí ship {{ship}} ${MARK}`, active: false });
    assert.ok("ok" in qr, JSON.stringify(qr));
    const img = await addQuickReplyImages(admin, qr.id, [PNG]);
    assert.ok("ok" in img, JSON.stringify(img));
    const [imgRow] = await db.select({ id: schema.salesChatQuickReplyImages.id }).from(schema.salesChatQuickReplyImages).where(eq(schema.salesChatQuickReplyImages.quickReplyId, qr.id));
    // Bề mặt AI bán hàng ra đời SAU bài này lần đầu: sổ sự kiện (#522), phát lại + gợi ý Copilot (#538).
    await recordConversationEvent(fan.id, { type: "handoff.requested", actorKind: "AI", occurredAt: new Date(), reasonCode: "WHOLESALE", payload: { note: MARK }, key: `asi-ev-${org}` });
    const [run] = await db.insert(schema.salesReplayRuns).values({ targetPoints: 5, days: 7, status: "DONE", summary: { note: MARK }, createdByUserId: admin.id, createdByEmail: admin.email }).returning({ id: schema.salesReplayRuns.id });
    await db.insert(schema.salesReplayPoints).values({ runId: run.id, sourceConversationId: fan.id, sourceChannel: "FANPAGE", sourceSeq: 1, customerText: `Cho em giá sỉ ${MARK}`, historicalSpeaker: "SHOP", aiReply: `Dạ ${MARK}` });
    // Quy kết từng đơn (docs/revenue-attribution.md): mỗi tổ chức một đơn bot chốt với số tiền RIÊNG — kẻ tấn công đọc thấy số
    // của nạn nhân là rò.
    await db.insert(schema.orders).values({ id: `erp-asi-${org}`, stage: "CONFIRMED", status: 1, billFullName: `Khách ${MARK}`, totalPrice: orderValueOf(org), totalPriceAfterDiscount: orderValueOf(org), insertedAt: new Date(), origin: "AI_AGENT", salesConversationId: fan.id });
    await recordConversationEvent(fan.id, { type: "order.confirmed", actorKind: "CUSTOMER", occurredAt: new Date(), orderId: `erp-asi-${org}`, amountVnd: orderValueOf(org), key: `asi-confirm-${org}` });
    const [sg] = await db.insert(schema.salesCopilotSuggestions).values({ conversationId: fan.id, pageId: `${org}-page`, threadId: `${org}-thread`, customerText: `Cho em giá sỉ ${MARK}`, suggestion: `Dạ ${MARK}` }).returning({ id: schema.salesCopilotSuggestions.id });
    return { admin, fanpageConv: fan.id, testConv: test.id, quickReply: qr.id, image: imgRow.id, replayRun: run.id, suggestion: sg.id };
  });
}

/** Số dòng + băm nội dung từng bảng `sales_chat_*` của một tổ chức. */
async function snapshot(org: string): Promise<Record<string, string>> {
  return withOrganization(org, async () => {
    const db = await getDb();
    const out: Record<string, string> = {};
    for (const t of SALES_TABLES) {
      const rows = rowsOf<Record<string, unknown>>(await db.execute(sql.raw(`select * from ${t} order by id`)));
      out[t] = `${rows.length}:${createHash("sha256").update(JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? String(v) : v))).digest("hex")}`;
    }
    return out;
  });
}

async function aiRows(org: string): Promise<number> {
  const pdb = await getPlatformDb();
  const [r] = await pdb.select({ n: sql<number>`count(*)::int` }).from(schema.platformAiUsage).where(eq(schema.platformAiUsage.orgCode, org));
  return Number(r?.n ?? 0);
}

async function cleanup() {
  const pdb = await getPlatformDb();
  await pdb.delete(schema.platformAiUsage).where(inArray(schema.platformAiUsage.orgCode, [...ORGS]));
  for (const code of ORGS) {
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
    if (org) {
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(schema.platformFlagOverrides).where(eq(schema.platformFlagOverrides.organizationId, org.id));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
    }
    rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  }
  await pdb.delete(schema.platformAuditLog).where(inArray(schema.platformAuditLog.targetOrgCode, [...ORGS]));
  invalidateOrganizations();
  invalidateCapabilities();
}

/** Người của `attacker` dùng id của `victim` — trong ngữ cảnh CỦA attacker (đúng như một phiên thật của attacker). */
async function attack(attacker: string, admin: SessionUser, victimCode: string, victim: Seeded) {
  const results: unknown[] = [];
  const refused: string[] = [];
  await withOrganization(attacker, async () => {
    const view = await conversationView(victim.fanpageConv);
    results.push(view);
    if (view !== null) refused.push("xem hội thoại fanpage của tổ chức khác");
    for (const [id, channel] of [
      [victim.testConv, "TEST"],
      [victim.fanpageConv, "FANPAGE"],
    ] as const) {
      const r = await chatTurn(id, "cho em xin giá", { channel, visitorKey: channel === "FANPAGE" ? `${victim.admin.organization?.code}-thread` : null, actorId: admin.id });
      results.push(r);
      if (r.ok) refused.push(`gõ vào hội thoại ${channel} của tổ chức khác`);
    }
    const resumed = await resumeConversationToAi(victim.fanpageConv);
    if (resumed) refused.push("trả hội thoại của tổ chức khác về AI");
    const img = await readQuickReplyImage(victim.image);
    if (img) refused.push("đọc ảnh câu mẫu của tổ chức khác");
    for (const [what, r] of [
      ["bật câu mẫu", await setQuickReplyActive(admin, victim.quickReply, true)],
      ["xoá câu mẫu", await deleteQuickReply(admin, victim.quickReply)],
      ["thêm ảnh vào câu mẫu", await addQuickReplyImages(admin, victim.quickReply, [PNG])],
      ["xoá ảnh câu mẫu", await removeQuickReplyImage(admin, victim.image)],
      ["sửa câu mẫu", await saveQuickReply(admin, { id: victim.quickReply, title: "đè", triggers: ["đè"], answer: "đè", active: true })],
    ] as const) {
      results.push(r);
      if ("ok" in r) refused.push(`${what} của tổ chức khác`);
    }
    const replayRun = await loadReplayRun(admin, victim.replayRun);
    results.push(replayRun);
    if ("ok" in replayRun) refused.push("mở lượt phát lại của tổ chức khác");
    const runs = await listReplayRuns(admin, 200);
    results.push(runs);
    if ("ok" in runs && runs.runs.some((r) => r.id === victim.replayRun)) refused.push("danh sách lượt phát lại lẫn của tổ chức khác");
    const copilot = await loadCopilotView(admin);
    results.push(copilot);
    if ("ok" in copilot && copilot.rows.some((r) => r.id === victim.suggestion)) refused.push("gợi ý Copilot lẫn của tổ chức khác");
    const perf = await loadAiSalesPerformance(attacker, { withMoney: true });
    results.push(perf);
    const attr = await loadOrderAttribution({ days: 180 });
    results.push(attr);
    const seen = attr.table.AI_ONLY.valueVnd + attr.table.AI_ASSISTED.valueVnd + attr.table.HUMAN_ONLY.valueVnd;
    if (seen !== orderValueOf(attacker)) refused.push(`quy kết đơn lẫn số của tổ chức khác (${seen} ≠ ${orderValueOf(attacker)})`);
    const convs = await listConversations(200);
    const qrs = await listQuickReplies();
    results.push(convs, qrs);
    if (convs.some((c) => c.id === victim.fanpageConv || c.id === victim.testConv)) refused.push("danh sách hội thoại lẫn của tổ chức khác");
    if (qrs.some((q) => q.id === victim.quickReply)) refused.push("danh sách câu mẫu lẫn của tổ chức khác");
  });
  return { refused, leaked: JSON.stringify(results, (_k, v) => (typeof v === "bigint" ? String(v) : v)).includes(markOf(victimCode)) };
}

export async function testAiSalesIsolation() {
  await cleanup();
  for (const code of ORGS) {
    await provisionOrganization({ code, name: `Tổ chức ${code}`, plan: "standard", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${code}.local`, name: `QT ${code}`, password: "CoLap@123456" }, source: "TEST", actor: null });
  }
  try {
    const a = await seed(A);
    const b = await seed(B);
    for (const [attacker, admin, victimCode, victim] of [
      [A, a.admin, B, b],
      [B, b.admin, A, a],
    ] as const) {
      const before = await snapshot(victimCode);
      const aiBefore = await aiRows(victimCode);
      const r = await attack(attacker, admin, victimCode, victim);
      assert.deepEqual(r.refused, [], `${attacker} → ${victimCode}: phải bị từ chối mọi đòn`);
      assert.equal(r.leaked, false, `${attacker} → ${victimCode}: kết quả không được mang chữ của tổ chức khác`);
      assert.deepEqual(await snapshot(victimCode), before, `${attacker} → ${victimCode}: CSDL AI bán hàng của nạn nhân TRƯỚC = SAU`);
      assert.equal(await aiRows(victimCode), aiBefore, `${attacker} → ${victimCode}: không lượt nào ghi sổ AI dưới mã nạn nhân`);
    }
    // Đối chứng: cùng lời gọi trong ĐÚNG tổ chức thì chạy — bài kiểm không xanh vì mọi thứ đều hỏng.
    await withOrganization(B, async () => {
      assert.ok(await conversationView(b.fanpageConv), "B xem được hội thoại của chính mình");
      assert.ok(await readQuickReplyImage(b.image), "B đọc được ảnh của chính mình");
      assert.ok("ok" in (await setQuickReplyActive(b.admin, b.quickReply, true)), "B bật được câu mẫu của chính mình");
      assert.equal(await resumeConversationToAi(b.fanpageConv), true, "B trả được hội thoại của chính mình về AI");
    });
    console.log("  ✓ AI bán hàng cô lập tổ chức: 15 đòn × 2 chiều bị từ chối (gồm sổ sự kiện, phát lại, Copilot, màn Hiệu quả), CSDL nạn nhân trước = sau, 0 dòng sổ AI, 0 chữ rò rỉ");
  } finally {
    await cleanup();
  }
}

/**
 * ═══════════ «TRẢ TẤT CẢ CHO AI» (chủ shop 10/10/2026, mục D) ═══════════
 *
 *  · Quyền: người chỉ xem bị từ chối ở lõi LẪN server action (cùng cổng với nút trả một hội thoại).
 *  · Tenant: chạy ở tổ chức A không chạm hội thoại của tổ chức B.
 *  · RESUMABLE vs BLOCKED đúng từng lý do: khách huỷ · đơn cần xác minh · AI xin người · AI hỏng · kênh chặn — hội thoại bị chặn giữ
 *    nguyên chế độ và vẫn hiện lý do.
 *  · Áp dụng đi qua đường trả một hội thoại: sự kiện `ai.resumed` + nhật ký mang người bấm; chạy lần hai KHÔNG ghi thêm gì.
 *  · Đường thật (`conversationAiBlocks`): tổ chức chưa cấu hình bot ⇒ mọi hội thoại bị chặn vì cấu hình / AI — không trả bừa.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { AI_DOWN_HANDOFF_REASON, FANPAGE_STAFF_REASON } from "@/lib/sales-chatbot/ai-hold-shared";
import type { AiBlock } from "@/lib/sales-chatbot/ai-status-shared";
import { applyBulkReturnToAi, BULK_RETURN_REASON, countHumanHandled, previewBulkReturnToAi, type BulkDeps } from "@/lib/sales-chatbot/bulk-return-ai";
import { TAKEOVER_REASON } from "@/lib/sales-chatbot/conversation-control-shared";
import { fanpageVisitorKey } from "@/lib/sales-chatbot/fanpage";
import { listInbox } from "@/lib/sales-chatbot/inbox";

const ORG_A = "hop-thu-bulk-a";
const ORG_B = "hop-thu-bulk-b";
const MIN = 60_000;

async function cleanup() {
  const pdb = await getPlatformDb();
  for (const code of [ORG_A, ORG_B]) {
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
    if (org) {
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
    }
    rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  }
  invalidateOrganizations();
  invalidateCapabilities();
}

async function provision(code: string) {
  await provisionOrganization({ code, name: `Shop ${code}`, plan: "standard", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${code}.local`, name: "Chủ shop", password: "HopThu@123456" }, source: "TEST", actor: null });
  const enabled = await getEnabledModules(code);
  return withOrganization(code, async () => {
    const db = await getDb();
    const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${code}.local`) });
    assert.ok(u);
    const admin = { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code, name: code, isHome: false }, modules: [...enabled] } as unknown as SessionUser;
    const viewer = { ...admin, id: `${code}-viewer`, email: `viewer@${code}.local`, name: "Chỉ xem", role: "VIEWER", permissions: ["ai_sales:view"] } as unknown as SessionUser;
    return { admin, viewer };
  });
}

function testSource() {
  // UI gọi ĐÚNG hai action; action dùng CÙNG cổng quyền với nút trả một hội thoại; lõi ghi qua setConversationControlCore.
  const ui = readFileSync("app/(dashboard)/ai/sales-chatbot/inbox/bulk-return-ai.tsx", "utf8");
  assert.ok(ui.includes("previewBulkReturnToAiAction()") && ui.includes("applyBulkReturnToAiAction({ confirm: true })"), "nút xem trước rồi mới áp dụng");
  assert.ok(!/router\.refresh\(\)/.test(ui), "không gọi router.refresh (action đã revalidatePath — tránh dựng hai lần)");
  const action = readFileSync("lib/actions/inbox-bulk-ai.ts", "utf8");
  assert.ok(action.includes("canControlConversation(user)") && action.includes("revalidatePath(PATH)"), "action: quyền chung + làm mới trang");
  const core = readFileSync("lib/sales-chatbot/bulk-return-ai.ts", "utf8");
  assert.ok(core.includes('setConversationControlCore(user, cand.id, "AUTO", BULK_RETURN_REASON'), "lõi ghi qua ĐÚNG đường trả một hội thoại");
  assert.ok(!/db\s*\.\s*update\(/.test(core), "lõi không có đường ghi thứ hai vào hội thoại");
  const page = readFileSync("app/(dashboard)/ai/sales-chatbot/inbox/page.tsx", "utf8");
  assert.ok(page.includes("countHumanHandled(user)") && page.includes("<BulkReturnToAi count={bulkCount} />"), "trang hiện nút theo số máy chủ đếm (quyền + ≥ 1 hội thoại)");
}

export async function testInboxBulkAi() {
  testSource();
  await cleanup();
  try {
    const A = await provision(ORG_A);
    const B = await provision(ORG_B);
    const now = new Date();
    const at = (ms: number) => new Date(now.getTime() - ms);
    const ctl = (mode: "HUMAN" | "COPILOT", by: string) => ({ control: { mode, byUserId: by, byName: "Chủ shop", at: at(30 * MIN).toISOString(), reason: null } });
    const PAGE = "pg-bulk";
    const PAGE_OFF = "pg-bulk-off";
    const blockOff: AiBlock = { code: "PAGE_OFF", reason: "Page chưa bật cho bot", fixHref: null, fixLabel: null };
    const deps: BulkDeps = { now, aiBlocks: async (conv) => (conv.pageId === PAGE_OFF ? [blockOff] : []) };

    // Tổ chức B: một hội thoại tiếp quản — phải còn nguyên sau mọi lượt chạy ở A.
    await withOrganization(ORG_B, async () => {
      const db = await getDb();
      await db.insert(schema.salesChatConversations).values({ id: "b1", channel: "WEB", status: "HANDOFF", handoffReason: TAKEOVER_REASON, state: ctl("HUMAN", B.admin.id), visitorKey: "web-b1", lastCustomerAt: at(5 * MIN) });
    });

    await withOrganization(ORG_A, async () => {
      const db = await getDb();
      const c = schema.salesChatConversations;
      const base = (id: string, page = PAGE) => ({ id, channel: "FANPAGE", visitorKey: fanpageVisitorKey(page, `t-${id}`), pageId: page, threadId: `t-${id}`, lastCustomerAt: at(10 * MIN), updatedAt: at(MIN) });
      await db.insert(c).values([
        { ...base("a1"), status: "HANDOFF", handoffReason: TAKEOVER_REASON, state: ctl("HUMAN", A.admin.id) },
        { ...base("a2"), status: "HANDOFF", handoffReason: FANPAGE_STAFF_REASON, humanCooldownUntil: at(-20 * MIN), lastStaffAt: at(5 * MIN) },
        { ...base("a3"), status: "OPEN", state: ctl("COPILOT", A.admin.id) },
        { ...base("a4"), status: "HANDOFF", handoffReason: FANPAGE_STAFF_REASON, humanCooldownUntil: at(-20 * MIN) },
        { ...base("a5"), status: "HANDOFF", handoffReason: TAKEOVER_REASON, state: ctl("HUMAN", A.admin.id) },
        { ...base("a6"), status: "HANDOFF", handoffReason: "Khách đòi gặp người", humanCooldownUntil: at(-10 * MIN), lastStaffAt: at(2 * MIN) },
        { ...base("a7"), status: "HANDOFF", handoffReason: AI_DOWN_HANDOFF_REASON, humanCooldownUntil: at(-10 * MIN), lastStaffAt: at(2 * MIN) },
        { ...base("a8", PAGE_OFF), status: "HANDOFF", handoffReason: FANPAGE_STAFF_REASON, humanCooldownUntil: at(-20 * MIN) },
        { ...base("a9"), status: "OPEN" },
        { ...base("a10"), status: "HANDOFF", handoffReason: "Khách sỉ — cần báo giá riêng" },
      ]);
      const review = (code: "CUSTOMER_CANCELLED" | "ADDRESS_UNRESOLVED") => ({ review: { entries: [{ code, note: code, quote: null, at: at(MIN).toISOString(), by: "Bot" }] } });
      await db.insert(schema.orders).values([
        { id: "erp-bulk-a4", stage: "NEW", status: 0, salesConversationId: "a4", insertedAt: at(20 * MIN), raw: review("CUSTOMER_CANCELLED") },
        { id: "erp-bulk-a5", stage: "CONFIRMED", status: 1, salesConversationId: "a5", insertedAt: at(20 * MIN), raw: review("ADDRESS_UNRESOLVED") },
      ]);

      // ── Quyền ──
      assert.equal(await countHumanHandled(A.viewer, now), null, "chỉ xem ⇒ không hiện nút");
      assert.ok(!(await previewBulkReturnToAi(A.viewer, deps)).ok, "chỉ xem ⇒ không xem trước được");
      assert.ok(!(await applyBulkReturnToAi(A.viewer, deps)).ok, "chỉ xem ⇒ không áp dụng được");
      assert.equal(await countHumanHandled(A.admin, now), 8, "a1–a8 đang do người xử lý (a9 AI · a10 AI xin người, chưa ai cầm)");

      // ── Xem trước: RESUMABLE vs BLOCKED từng lý do ──
      const pv = await previewBulkReturnToAi(A.admin, deps);
      assert.ok(pv.ok, JSON.stringify(pv));
      const p = pv.preview;
      assert.deepEqual({ total: p.total, resumable: p.resumable, blocked: p.blocked }, { total: 8, resumable: 3, blocked: 5 });
      assert.deepEqual(p.byHandling, { MANUAL_TAKEOVER: 2, STAFF_COOLDOWN: 5, COPILOT: 1 });
      const groupIds = Object.fromEntries(p.groups.map((g) => [g.code, g.samples.map((s) => s.id)]));
      assert.deepEqual(groupIds, { CUSTOMER_CANCELLED: ["a4"], ORDER_NEEDS_VERIFICATION: ["a5"], AI_HANDOFF: ["a6"], AI_UNAVAILABLE: ["a7"], CHANNEL_UNAVAILABLE: ["a8"] }, JSON.stringify(p.groups));
      assert.equal(p.groups.find((g) => g.code === "AI_HANDOFF")?.samples[0].detail, "Khách đòi gặp người", "lý do AI chuyển người đi kèm");
      assert.deepEqual(p.resumableSample.map((s) => s.id).sort(), ["a1", "a2", "a3"]);
      const snapshot = async (ids: string[]) => (await db.select({ id: c.id, status: c.status, reason: c.handoffReason, state: c.state, until: c.humanCooldownUntil }).from(c).where(inArray(c.id, ids))).sort((x, y) => x.id.localeCompare(y.id));
      const blockedIds = ["a4", "a5", "a6", "a7", "a8", "a10"];
      const blockedBefore = await snapshot(blockedIds);
      const eventsOf = async () => db.select().from(schema.salesConversationEvents).where(eq(schema.salesConversationEvents.type, "ai.resumed"));
      const auditsOf = async () => db.select().from(schema.auditLogs).where(inArray(schema.auditLogs.action, ["SALES_CHAT_CONTROL_SET", "SALES_CHAT_RESUME_AI", "SALES_CHAT_AI_RESUME_NOW", "SALES_INBOX_BULK_RETURN_AI"]));
      assert.equal((await eventsOf()).length, 0, "xem trước không ghi sự kiện");
      assert.equal((await auditsOf()).length, 0, "xem trước không ghi nhật ký");

      // ── Áp dụng ──
      const ap = await applyBulkReturnToAi(A.admin, deps);
      assert.ok(ap.ok && ap.resumed === 3 && ap.unchanged === 0 && ap.failed.length === 0 && ap.preview.blocked === 5, JSON.stringify(ap));
      const back = await snapshot(["a1", "a2", "a3"]);
      for (const r of back) {
        assert.equal(r.status, "OPEN", `${r.id}: hội thoại mở lại cho AI`);
        assert.equal(r.reason, null, `${r.id}: hết lý do chuyển người`);
        assert.equal((r.state as Record<string, unknown>).control, undefined, `${r.id}: hết ghi đè chế độ`);
      }
      assert.deepEqual(await snapshot(blockedIds), blockedBefore, "hội thoại bị chặn (và a10 — AI xin người, không ai cầm) GIỮ NGUYÊN");
      const ev = await eventsOf();
      assert.deepEqual(ev.map((e) => e.conversationId).sort(), ["a1", "a2"], "ai.resumed cho tiếp quản (RETURNED) + nhường (RESUMED_NOW); AI gợi ý → AI không phải «AI quay lại»");
      assert.ok(ev.every((e) => e.actorKind === "HUMAN" && e.actorUserId === A.admin.id), "sự kiện mang khoá tài khoản người bấm (luật 34)");
      const aud = await auditsOf();
      const per = aud.filter((x) => x.action !== "SALES_INBOX_BULK_RETURN_AI");
      assert.deepEqual(per.map((x) => x.entityId).sort(), ["a1", "a2", "a3"], "mỗi hội thoại một nhật ký trước → sau");
      assert.ok(aud.every((x) => x.userId === A.admin.id), "nhật ký đứng tên người bấm");
      assert.ok(per.every((x) => JSON.stringify(x.detail).includes(BULK_RETURN_REASON)), "nhật ký từng hội thoại ghi lý do «trả tất cả»");
      const sum = aud.filter((x) => x.action === "SALES_INBOX_BULK_RETURN_AI");
      assert.equal(sum.length, 1, "một nhật ký tổng cho lượt bấm");
      assert.ok(JSON.stringify(sum[0].detail).includes('"resumed":3') && JSON.stringify(sum[0].detail).includes('"CUSTOMER_CANCELLED":1'), JSON.stringify(sum[0].detail));

      // ── Chạy lại: không ghi thêm gì; hội thoại bị chặn vẫn hiện lý do ──
      const again = await applyBulkReturnToAi(A.admin, deps);
      assert.ok(again.ok && again.resumed === 0 && again.failed.length === 0 && again.preview.resumable === 0 && again.preview.blocked === 5, JSON.stringify(again));
      assert.equal((await eventsOf()).length, ev.length, "chạy lại: 0 sự kiện mới");
      assert.equal((await auditsOf()).length, aud.length, "chạy lại: 0 nhật ký mới");
      assert.deepEqual(again.preview.groups.map((g) => g.code), ["CUSTOMER_CANCELLED", "ORDER_NEEDS_VERIFICATION", "AI_HANDOFF", "AI_UNAVAILABLE", "CHANNEL_UNAVAILABLE"], "lý do chặn vẫn in ra");
      const inbox = await listInbox(A.admin, { filter: "HUMAN", limit: 500 }, now);
      assert.ok(inbox.ok && inbox.counts.HUMAN === 5 && inbox.rows.every((r) => ["a4", "a5", "a6", "a7", "a8"].includes(r.id)), "thẻ «Người đang xử lý» còn đúng năm hội thoại bị chặn");

      // ── Thử lại an toàn: hội thoại đổi trạng thái giữa xem trước và ghi ⇒ KHÔNG bị trả lặng lẽ ──
      await db.insert(c).values({ ...base("a11"), status: "HANDOFF", handoffReason: FANPAGE_STAFF_REASON, humanCooldownUntil: at(-20 * MIN) });
      const racing: BulkDeps = {
        now,
        aiBlocks: async (conv) => {
          // Đúng lúc lõi đang hỏi cổng AI, AI của đường xử lý chuyển a11 sang «cần người».
          if (conv.id === "a11") await db.update(c).set({ handoffReason: "Khách khiếu nại — cần người" }).where(eq(c.id, "a11"));
          return conv.pageId === PAGE_OFF ? [blockOff] : [];
        },
      };
      const raced = await applyBulkReturnToAi(A.admin, racing);
      assert.ok(raced.ok && raced.resumed === 0 && raced.failed.length === 1 && raced.failed[0].id === "a11", JSON.stringify(raced));
      const [a11] = await db.select().from(c).where(and(eq(c.id, "a11"), eq(c.status, "HANDOFF")));
      assert.equal(a11?.handoffReason, "Khách khiếu nại — cần người", "a11 vẫn chờ người — không bị đè về AI");
    });

    // ── Tenant: tổ chức B nguyên vẹn; đường thật chặn khi bot chưa cấu hình ──
    await withOrganization(ORG_B, async () => {
      const db = await getDb();
      const [b1] = await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, "b1"));
      assert.ok(b1 && b1.status === "HANDOFF" && b1.handoffReason === TAKEOVER_REASON, "tổ chức B không bị chạm");
      assert.equal((await db.select().from(schema.salesConversationEvents)).length, 0, "tổ chức B: 0 sự kiện");
      const real = await previewBulkReturnToAi(B.admin);
      assert.ok(real.ok && real.preview.total === 1 && real.preview.resumable === 0 && real.preview.blocked === 1, JSON.stringify(real));
      assert.ok(real.preview.groups.every((g) => g.code === "CONFIG_BLOCKED" || g.code === "AI_UNAVAILABLE"), `bot chưa cấu hình ⇒ chặn vì cấu hình / AI: ${JSON.stringify(real.preview.groups.map((g) => g.code))}`);
      const realApply = await applyBulkReturnToAi(B.admin);
      assert.ok(realApply.ok && realApply.resumed === 0, "không trả bừa khi AI không chạy được");
    });
    console.log("  ✓ «Trả tất cả cho AI»: quyền (chỉ xem bị từ chối) · tenant (tổ chức B nguyên vẹn) · 3 trả được / 5 bị chặn đúng 5 lý do · sự kiện + nhật ký đứng tên người bấm · chạy lại 0 dòng mới · đổi trạng thái giữa chừng ⇒ không đè · đường thật chặn khi bot chưa cấu hình");
  } finally {
    await cleanup();
  }
}

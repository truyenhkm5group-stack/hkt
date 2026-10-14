/**
 * ═══════════ HANDOFF-OWNERSHIP: AI IM THÌ PHẢI CÓ CHỦ (P0 11/10/2026, yêu cầu 9) ═══════════
 *
 * Chủ shop: «Tin mới của khách: AI chuyển người nhưng KHÔNG AI NHẬN». Bài kiểm khẳng định trên một tổ chức THẬT (PGlite, tự cấp, tự dọn):
 *  · AI chuyển người ⇒ hội thoại VÀO hàng đợi phòng (`work.ownership`) với hạn đúng `work.sla` (ghi đè đổi được hạn);
 *  · phòng không ai xem được hộp thư ⇒ ĐẾM là «không chủ» (không giấu), tin vẫn tới mọi người xem hộp thư (không rơi im);
 *  · một tin mỗi ĐỢT chờ người — đợt thứ hai của CÙNG hội thoại vẫn báo (khoá vĩnh viễn cũ là gốc lỗi);
 *  · khách nhắn thêm 3 tin khi đang chờ ⇒ ĐÚNG MỘT thông báo, tới người của phòng; nhân viên trả lời rồi khách nhắn ⇒ một tin nữa;
 *  · «Trả cho AI» ⇒ xoá mốc, hết hạn; phân việc BẬT ⇒ người còn chỗ; không lấy khỏi tay người đang cầm (luật 25);
 *  · lượt quét đóng dấu đường chuyển người không báo (quá dài), dọn dấu cũ, leo thang một tin/phòng/ngày; câu đếm «không chủ» = 0;
 *  · bản SQL (`aiSilentSql`) ≡ bản thuần (`isAiSilent`) trên từng hội thoại; quét mã nguồn: không gõ số giờ / mã phòng mới.
 * Mốc theo đồng hồ THẬT (AGENTS mục 50).
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { and, eq, like, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { clearMemo } from "@/lib/cache";
import { CASE_SLA_HOURS, CASE_TEAM } from "@/lib/constants/action-queue";
import { TEAM_DEPARTMENT } from "@/lib/constants/departments";
import { DEFAULT_OWNERSHIP_MAP } from "@/lib/constants/work-ownership";
import { DEFAULT_SLA_MAP, WORK_SLA_KEY } from "@/lib/constants/work-sla";
import { WORK_STAFFING_KEY } from "@/lib/constants/workforce";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { assignMembership } from "@/lib/org/membership";
import { collectWorkItems } from "@/lib/queries/work-adapters";
import { notifySalesChatHandoff } from "@/lib/sales-chatbot/alerts";
import { holdGate } from "@/lib/sales-chatbot/conversation-control";
import { fanpageVisitorKey } from "@/lib/sales-chatbot/fanpage";
import { aiSilentSql, autoAssignHandoffs, countUnownedHandoffs, sweepHandoffOwnership } from "@/lib/sales-chatbot/handoff-routing";
import { handoffEpisodeKey, handoffFollowupKey, handoffOwnerOf, handoffQueueLine, handoffQueueView, isAiSilent } from "@/lib/sales-chatbot/handoff-routing-shared";
import { handBackToAiCore, listInbox } from "@/lib/sales-chatbot/inbox";
import { WEB_STAFF_REASON } from "@/lib/sales-chatbot/inbox-states";
import { FANPAGE_STAFF_REASON } from "@/lib/sales-chatbot/ai-hold-shared";
import { TAKEOVER_REASON } from "@/lib/sales-chatbot/conversation-control-shared";
import { setSettingJson } from "@/lib/settings";
import { assignByMachine } from "@/lib/work/assign";

const ORG = "chuyen-nguoi-co-chu";
const PG = "pg-handoff";
const MIN = 60_000;
const HOUR = 3_600_000;

async function cleanup() {
  const pdb = await getPlatformDb();
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
  const now = new Date();
  const base = { silent: true, assigneeUserId: null, assigneeActive: false, queuedAt: now, department: "SALES" as const, responders: 2 };
  assert.equal(handoffOwnerOf({ ...base, silent: false }), null, "AI đang trả lời ⇒ không áp dụng");
  assert.deepEqual(handoffOwnerOf({ ...base, assigneeUserId: "u1", assigneeActive: true }), { kind: "PERSON", userId: "u1" });
  assert.equal(handoffOwnerOf({ ...base, assigneeUserId: "u1", assigneeActive: false })?.kind, "DEPARTMENT", "người cầm đã khoá ⇒ về hàng đợi phòng");
  assert.deepEqual(handoffOwnerOf({ ...base, queuedAt: null }), { kind: "NONE", department: "SALES", reason: "NOT_QUEUED" });
  assert.deepEqual(handoffOwnerOf({ ...base, responders: 0 }), { kind: "NONE", department: "SALES", reason: "NO_RESPONDER" }, "phòng không người và cả tổ chức không ai xem hộp thư ⇒ KHÔNG CHỦ");
  // HOTFIX 12/10/2026: phòng chưa có người nhưng tổ chức CÓ người xem hộp thư ⇒ HÀNG ĐỢI CHUNG (248 hội thoại HSLC treo «KHÔNG CHỦ» chỉ vì phòng trống).
  assert.deepEqual(handoffOwnerOf({ ...base, responders: 0, viewers: 3 }), { kind: "SHARED", department: "SALES", viewers: 3 }, "phòng trống, tổ chức có người xem ⇒ hàng đợi chung");
  assert.match(handoffQueueView({ owner: { kind: "SHARED", department: "SALES", viewers: 3 }, queuedAt: now, assigneeName: null, lastStaffAt: null, waitingSince: null, dueAt: null }, now).ownerLabel, /^Hàng đợi chung \(phòng .+ chưa có người\)/);
  assert.ok(isAiSilent({ needsHuman: "AI_HANDOFF", humanHandling: null }, false) && isAiSilent({ needsHuman: "AI_DOWN", humanHandling: null }, false) && isAiSilent({ needsHuman: null, humanHandling: "MANUAL_TAKEOVER" }, false) && isAiSilent({ needsHuman: null, humanHandling: "STAFF_COOLDOWN" }, true));
  assert.ok(!isAiSilent({ needsHuman: null, humanHandling: "STAFF_COOLDOWN" }, false) && !isAiSilent({ needsHuman: "ORDER_REVIEW", humanHandling: null }, false) && !isAiSilent({ needsHuman: null, humanHandling: "COPILOT" }, false), "AI nhường tạm / đơn cần kiểm / AI gợi ý: AI vẫn còn đó");
  const q1 = new Date(now.getTime() - 30 * MIN);
  const q2 = new Date(now.getTime() - 5 * MIN);
  assert.notEqual(handoffEpisodeKey("c", q1), handoffEpisodeKey("c", q2), "hai đợt ⇒ hai khoá (khoá vĩnh viễn cũ là gốc lỗi)");
  assert.equal(handoffFollowupKey("c", q1, null), handoffFollowupKey("c", q1, new Date(q1.getTime() - MIN)), "câu nhân viên TRƯỚC đợt không mở chu kỳ mới");
  assert.notEqual(handoffFollowupKey("c", q1, null), handoffFollowupKey("c", q1, q2), "nhân viên trả lời trong đợt ⇒ chu kỳ mới");
  const v = handoffQueueView({ owner: { kind: "DEPARTMENT", department: "SALES", responders: 1 }, queuedAt: q1, assigneeName: null, lastStaffAt: null, waitingSince: null, dueAt: new Date(q1.getTime() + HOUR) }, now);
  assert.equal(v.waitingFrom, q1.toISOString(), "chưa ai trả lời từ lúc vào hàng đợi ⇒ chờ từ mốc vào hàng đợi");
  assert.match(handoffQueueLine(v, now.getTime()), /^Chờ 30 phút · Phụ trách: Phòng .+ \(chưa ai nhận\) · Hạn: /);
  const replied = handoffQueueView({ owner: { kind: "PERSON", userId: "u" }, queuedAt: q1, assigneeName: "Lan", lastStaffAt: q2, waitingSince: null, dueAt: null }, now);
  assert.equal(replied.waitingFrom, null);
  assert.equal(handoffQueueLine(replied, now.getTime()), "Đã trả lời · Phụ trách: Lan · Không đặt hạn");
}

function testSourceScan() {
  // Luật 22: hạn và phòng LẤY LẠI từ hằng số đang chạy — không gõ số giờ / mã phòng mới.
  assert.equal(DEFAULT_SLA_MAP.SALES_CHAT_HANDOFF?.hours, CASE_SLA_HOURS.CS_CASE, "hạn mặc định = hạn case CSKH đang chạy");
  assert.equal(DEFAULT_OWNERSHIP_MAP.SALES_CHAT_HANDOFF?.department, TEAM_DEPARTMENT[CASE_TEAM.CS_CASE], "phòng mặc định = phòng của nhóm việc CS");
  const ws = readFileSync("lib/constants/work-sources.ts", "utf8").replace(/\r\n/g, "\n");
  const block = ws.slice(ws.indexOf("  SALES_CHAT_HANDOFF: {"), ws.indexOf("  SHIPMENT_CARE: {"));
  assert.match(block, /slaHours: CASE_SLA_HOURS\.CS_CASE,/);
  assert.match(block, /department: TEAM_DEPARTMENT\[CASE_TEAM\.CS_CASE\],/);
  const sla = readFileSync("lib/constants/work-sla.ts", "utf8").replace(/\r\n/g, "\n");
  const rule = sla.slice(sla.indexOf('key: "SALES_CHAT_HANDOFF"'), sla.indexOf('key: "ORDER_DUPLICATE"'));
  assert.match(rule, /hours: WORK_SOURCE_SPEC\.SALES_CHAT_HANDOFF\.slaHours,/);
  for (const f of ["lib/sales-chatbot/handoff-routing.ts", "lib/sales-chatbot/handoff-routing-shared.ts"]) {
    const src = readFileSync(f, "utf8")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    assert.doesNotMatch(src, /"(MANAGEMENT|MARKETING|SALES|LOGISTICS|WAREHOUSE|PRODUCTION|FINANCE|HR)"/, `${f}: không gõ mã phòng — đọc work.ownership`);
    assert.doesNotMatch(src, /(hours|slaHours|Hours)\s*[:=]\s*\d/, `${f}: không gõ số giờ — đọc work.sla`);
    assert.doesNotMatch(src, /\b(?!7\b)\d+\s*\*\s*3_600_000/, `${f}: không tự cộng giờ hạn (chỉ múi giờ VN +7)`);
  }
}

export async function testHandoffOwnership() {
  testPure();
  testSourceScan();
  await cleanup();
  try {
    await provisionOrganization({ code: ORG, name: "Shop chuyển người có chủ", plan: "standard", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "Chủ shop", password: "ChuyenNguoi@123456" }, source: "TEST", actor: null });
    const enabled = await getEnabledModules(ORG);
    await withOrganization(ORG, async () => {
      clearMemo();
      const db = await getDb();
      const c = schema.salesChatConversations;
      const u0 = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u0);
      const sess = (id: string, email: string, name: string) => ({ id, email, name, role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: ORG, isHome: false }, modules: [...enabled] }) as unknown as SessionUser;
      const admin = sess(u0.id, u0.email, u0.name);
      const [nv] = await db.insert(schema.users).values({ email: `lan@${ORG}.local`, name: "Lan bán hàng", passwordHash: "x", role: "ADMIN", active: true }).returning({ id: schema.users.id, email: schema.users.email, name: schema.users.name });
      const lan = sess(nv.id, nv.email, nv.name);
      const [sales] = await db.select({ id: schema.departments.id }).from(schema.departments).where(eq(schema.departments.code, TEAM_DEPARTMENT[CASE_TEAM.CS_CASE]));
      assert.ok(sales, "phòng mặc định của hàng đợi phải được gieo");

      const T0 = Date.now();
      const at = (msAgo: number) => new Date(T0 - msAgo);
      let seq = 0;
      const conv = async (id: string, v: Partial<typeof c.$inferInsert> = {}) => {
        const thread = `th-${id}`;
        await db.insert(c).values({ id, channel: "FANPAGE", visitorKey: fanpageVisitorKey(PG, thread), pageId: PG, threadId: thread, status: "OPEN", lastCustomerAt: at(40 * MIN), lastBotAt: at(39 * MIN), ...v });
      };
      const customerSays = async (id: string, when: Date, text: string) => {
        seq += 1;
        await db.insert(schema.salesChatInbound).values({ pageId: PG, threadId: `th-${id}`, messageId: `m-${id}-${seq}`, kind: "INBOX", text, customerName: "Nguyễn Thanh Thủy", createdAt: when } as typeof schema.salesChatInbound.$inferInsert);
        await db.update(c).set({ lastCustomerAt: when }).where(eq(c.id, id));
      };
      const handOff = async (id: string, reason: string, now: Date) => {
        // Đúng thứ tự của engine: ghi HANDOFF rồi báo.
        await db.update(c).set({ status: "HANDOFF", handoffReason: reason, state: sql`${c.state} || ${JSON.stringify({ handoff: { reason, at: now.toISOString() } })}::jsonb` }).where(eq(c.id, id));
        await notifySalesChatHandoff(id, reason, { name: "Nguyễn Thanh Thủy", phone: "0912000111" }, now);
      };
      const notes = async (id: string) => (await db.select({ key: schema.notifications.dedupeKey }).from(schema.notifications).where(and(eq(schema.notifications.entityType, "SALES_CHAT"), eq(schema.notifications.entityId, id)))).map((r) => r.key);
      const userMsgs = async (prefix: string) => db.select({ userId: schema.userMessages.userId }).from(schema.userMessages).where(like(schema.userMessages.dedupeKey, `${prefix}%`));
      const rowOf = async (user: SessionUser, id: string) => {
        const r = await listInbox(user, { limit: 200 }, new Date());
        assert.ok(r.ok);
        const row = r.rows.find((x) => x.id === id);
        assert.ok(row, `hộp thư phải có ${id}`);
        return row;
      };
      const queuedOf = async (id: string) => (await db.select({ q: c.handoffQueuedAt }).from(c).where(eq(c.id, id)))[0]?.q ?? null;

      // ═══ 1. AI chuyển người khi phòng CHƯA có ai ⇒ vào hàng đợi, đếm «không chủ», tin vẫn tới mọi người xem hộp thư ═══
      await conv("A");
      await customerSays("A", at(20 * MIN), "Em lên đơn 2kg chả cá cho chị nhé");
      const nowA = at(19 * MIN);
      await handOff("A", "Khách cần nhân viên xác minh giá", nowA);
      const qA = await queuedOf("A");
      assert.equal(qA?.getTime(), nowA.getTime(), "chuyển người ⇒ có mốc vào hàng đợi");
      const c1 = await countUnownedHandoffs();
      // HOTFIX 12/10/2026: phòng chưa có ai nhưng chủ shop xem được hộp thư ⇒ HÀNG ĐỢI CHUNG (đếm riêng, không giấu), không còn «KHÔNG CHỦ».
      assert.deepEqual({ silent: c1.silent, unowned: c1.unowned, shared: c1.shared, r: c1.byReason.NO_RESPONDER }, { silent: 1, unowned: 0, shared: 1, r: 0 }, `phòng không người ⇒ HÀNG ĐỢI CHUNG: ${JSON.stringify(c1)}`);
      assert.ok(c1.viewers >= 1 && c1.responders === 0);
      assert.equal((await userMsgs(handoffEpisodeKey("A", qA!))).length, 2, "phòng trống ⇒ tin tới MỌI người xem hộp thư (không rơi im)");

      // ═══ 2. Có người trong phòng ⇒ chủ = hàng đợi phòng, hạn đúng work.sla; ghi đè work.sla đổi hạn ═══
      assert.ok("ok" in (await assignMembership({ departmentId: sales.id, userId: lan.id }, { id: admin.id, email: admin.email })));
      clearMemo();
      const c2 = await countUnownedHandoffs();
      assert.deepEqual({ unowned: c2.unowned, department: c2.department, responders: c2.responders }, { unowned: 0, department: 1, responders: 1 });
      let rA = await rowOf(admin, "A");
      assert.ok(rA.handoffQueue, "AI im ⇒ hàng có «chờ · phụ trách · hạn»");
      assert.equal(rA.handoffQueue.ownerKind, "DEPARTMENT");
      assert.equal(rA.handoffQueue.dueAt, new Date(qA!.getTime() + CASE_SLA_HOURS.CS_CASE! * HOUR).toISOString(), "hạn mặc định = work.sla (lấy lại từ case CSKH)");
      await setSettingJson(WORK_SLA_KEY, { SALES_CHAT_HANDOFF: 1 });
      clearMemo();
      rA = await rowOf(admin, "A");
      assert.equal(rA.handoffQueue?.dueAt, new Date(qA!.getTime() + HOUR).toISOString(), "chủ shop ghi đè work.sla ⇒ hạn đổi, không cần deploy");
      const work = await collectWorkItems({ sources: ["SALES_CHAT_HANDOFF"] });
      const wA = work.items.find((i) => i.sourceKey === "A");
      assert.ok(wA && wA.department === TEAM_DEPARTMENT[CASE_TEAM.CS_CASE] && wA.slaAt?.getTime() === qA!.getTime() + HOUR && wA.assignee === null, `/work chiếu hội thoại chờ người vào hàng đợi phòng: ${JSON.stringify(wA)}`);

      // ═══ 3. Báo lại cùng đợt ⇒ không nhân bản ═══
      const before3 = (await notes("A")).length;
      await notifySalesChatHandoff("A", "Khách cần nhân viên xác minh giá", null, new Date());
      assert.equal((await notes("A")).length, before3, "cùng đợt ⇒ không thêm tin");

      // ═══ 4. Khách nhắn thêm 3 tin khi đang chờ ⇒ MỘT thông báo, tới người của phòng; vẫn chưa đọc, vẫn trong hàng đợi ═══
      const holdRow = async () => (await db.select({ id: c.id, status: c.status, handoffReason: c.handoffReason, state: c.state, updatedAt: c.updatedAt, humanCooldownUntil: c.humanCooldownUntil }).from(c).where(eq(c.id, "A")))[0];
      for (const [i, txt] of ["Alo shop ơi", "Sao chưa ai trả lời", "Chị cần gấp"].entries()) {
        await customerSays("A", at((10 - i) * MIN), txt);
        assert.ok(await holdGate(await holdRow(), new Date()), "AI im ⇒ cổng vẫn bỏ qua tin (không gọi AI)");
      }
      const follow1 = handoffFollowupKey("A", qA!, null);
      assert.equal((await notes("A")).filter((k) => k?.startsWith("sales-chat:handoff-msg:")).length, 1, "3 tin khách ⇒ ĐÚNG MỘT thông báo");
      assert.deepEqual((await userMsgs(follow1)).map((m) => m.userId), [lan.id], "tin tới người của phòng phụ trách, không phải cả cửa hàng");
      const rLan = await rowOf(lan, "A");
      assert.ok(rLan.unread && rLan.unreadCount >= 3 && rLan.handoffQueue?.ownerKind === "DEPARTMENT", "tin mới ⇒ chưa đọc (luật V3) + vẫn trong hàng đợi");
      // Nhân viên trả lời từ ERP ⇒ chu kỳ mới: khách nhắn ⇒ một tin nữa.
      const staffAt = at(4 * MIN);
      await db.update(c).set({ lastStaffAt: staffAt }).where(eq(c.id, "A"));
      await customerSays("A", at(2 * MIN), "Vậy giá 2kg bao nhiêu?");
      await holdGate(await holdRow(), new Date());
      assert.equal((await userMsgs(handoffFollowupKey("A", qA!, staffAt))).length, 1, "chu kỳ mới ⇒ một tin nữa");

      // ═══ 5. «Trả cho AI» ⇒ xoá mốc, hết hạn; đợt thứ hai của CÙNG hội thoại vẫn báo ═══
      assert.ok((await handBackToAiCore(admin, "A")).ok);
      assert.equal(await queuedOf("A"), null, "trả AI ⇒ rời hàng đợi, xoá hạn");
      assert.equal((await rowOf(admin, "A")).handoffQueue, null);
      const now2 = new Date();
      await handOff("A", "Khách nhắn sau khi đã chốt đơn — nhân viên xử lý", now2);
      const qA2 = await queuedOf("A");
      assert.ok(qA2 && qA2.getTime() === now2.getTime(), "đợt mới ⇒ mốc mới (dấu cũ đã xoá)");
      assert.ok((await notes("A")).includes(handoffEpisodeKey("A", qA2)), "đợt thứ hai VẪN báo — khoá vĩnh viễn cũ nuốt mất tin này");
      assert.deepEqual((await userMsgs(handoffEpisodeKey("A", qA2))).map((m) => m.userId), [lan.id]);

      // ═══ 6. Phân việc tự động: TẮT ⇒ không giao; BẬT ⇒ người còn chỗ; không lấy khỏi tay người đang cầm ═══
      await conv("B");
      await handOff("B", "Khách đòi gặp người", new Date());
      assert.equal((await db.select({ a: c.assigneeUserId }).from(c).where(eq(c.id, "B")))[0].a, null, "mặc định TẮT ⇒ máy không giao ai (luật 25)");
      await conv("C", { assigneeUserId: admin.id, assignedAt: new Date() });
      await handOff("C", "Khách đòi gặp người", new Date());
      await setSettingJson(WORK_STAFFING_KEY, { autoAssign: { [TEAM_DEPARTMENT[CASE_TEAM.CS_CASE]]: true } });
      clearMemo();
      const placed = await autoAssignHandoffs(TEAM_DEPARTMENT[CASE_TEAM.CS_CASE], new Date());
      const assignee = async (id: string) => (await db.select({ a: c.assigneeUserId }).from(c).where(eq(c.id, id)))[0].a;
      assert.equal(await assignee("B"), lan.id, `phân việc BẬT ⇒ người của phòng còn chỗ: ${JSON.stringify([...placed])}`);
      assert.equal(await assignee("C"), admin.id, "không lấy khỏi tay người đang cầm");
      assert.ok("error" in (await assignByMachine("SALES_CHAT_HANDOFF:C", lan.id)), "cửa máy từ chối hội thoại đã có người");
      await conv("D");
      await handOff("D", "Khách đòi gặp người", new Date());
      assert.equal(await assignee("D"), lan.id, "đang bật ⇒ chuyển người là giao ngay, không đợi lượt quét");
      assert.equal((await rowOf(admin, "D")).handoffQueue?.ownerKind, "PERSON");
      await setSettingJson(WORK_STAFFING_KEY, {});
      clearMemo();

      // ═══ 7. Lượt quét: đường chuyển người không báo (quá dài) · dấu cũ · leo thang một tin/phòng/ngày ═══
      await conv("E", { status: "HANDOFF", handoffReason: "Hội thoại quá dài" });
      await conv("F", { handoffQueuedAt: at(3 * HOUR) }); // AI đang trả lời mà còn dấu cũ
      await conv("G", { status: "HANDOFF", handoffReason: "Khách đòi gặp người", handoffQueuedAt: at(30 * HOUR), lastCustomerAt: at(30 * HOUR) });
      const c7 = await countUnownedHandoffs();
      assert.equal(c7.byReason.NOT_QUEUED, 1, "đường chuyển người không báo ⇒ chưa vào hàng đợi, ĐẾM được");
      const sw = await sweepHandoffOwnership();
      assert.ok(sw.stamped === 1 && sw.cleared >= 1 && (await queuedOf("F")) === null && (await queuedOf("E")) !== null, `lượt quét đóng dấu + dọn dấu cũ: ${JSON.stringify(sw)}`);
      assert.equal(sw.staleDepartments, 1, "vỡ hạn > 24 giờ chưa ai cầm ⇒ một tin leo thang");
      assert.equal((await sweepHandoffOwnership()).staleDepartments, 0, "một tin mỗi phòng mỗi NGÀY");
      assert.equal(sw.unowned.unowned, 0, "sau lượt quét: không hội thoại AI im nào không chủ");

      // ═══ 8. Tiếp quản · chat web chờ trả lại cũng phải có chủ; SQL ≡ thuần trên từng hội thoại ═══
      await conv("H", { status: "HANDOFF", handoffReason: WEB_STAFF_REASON });
      await conv("I", { status: "HANDOFF", handoffReason: FANPAGE_STAFF_REASON, humanCooldownUntil: new Date(T0 + 20 * MIN) });
      await conv("J", { status: "HANDOFF", handoffReason: TAKEOVER_REASON, state: { control: { mode: "HUMAN", byUserId: admin.id, byName: "Chủ shop", at: at(MIN).toISOString(), reason: null } }, assigneeUserId: admin.id });
      await sweepHandoffOwnership();
      const list = await listInbox(admin, { limit: 200 }, new Date());
      assert.ok(list.ok);
      const silentIds = new Set((await db.select({ id: c.id }).from(c).where(aiSilentSql(new Date()))).map((r) => r.id));
      for (const r of list.rows) {
        const pure = isAiSilent({ needsHuman: r.needsHuman, humanHandling: r.humanHandling }, r.status === "HANDOFF" && r.handoffReason === WEB_STAFF_REASON);
        assert.equal(silentIds.has(r.id), pure, `${r.id}: SQL và hàm thuần phải cùng kết luận «AI im»`);
        assert.equal(r.handoffQueue !== null, pure, `${r.id}: hàng có dòng hàng đợi ⇔ AI im`);
      }
      assert.ok(silentIds.has("H") && !silentIds.has("I") && silentIds.has("J"), "chat web chờ trả lại + tiếp quản = AI im; AI nhường tạm = không");
      const fin = await countUnownedHandoffs();
      assert.equal(fin.unowned, 0, `câu đếm «chuyển người không chủ» = 0 sau luồng: ${JSON.stringify(fin)}`);
      console.log(`  ✓ chuyển người có chủ: phòng (work.ownership) + hạn (work.sla, ghi đè được) · phòng trống ⇒ hàng đợi chung (đếm riêng), tin không rơi im · một tin mỗi đợt, đợt hai vẫn báo · 3 tin khách ⇒ 1 thông báo · trả AI xoá hạn · phân việc bật ⇒ người còn chỗ, không giật việc · quét đóng dấu / dọn / leo thang 1 tin/phòng/ngày · SQL ≡ thuần · ${fin.silent} hội thoại AI im, 0 không chủ`);
    });
  } finally {
    await cleanup();
  }
}

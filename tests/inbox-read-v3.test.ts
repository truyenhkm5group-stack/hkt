/**
 * ═══════════ INBOX READ V3 — «CHƯA ĐỌC» CÓ BẰNG CHỨNG, THEO NGƯỜI, ĐỌC TỚI ĐÚNG TIN ĐÃ HIỆN (chủ shop 10/10/2026 tối, P0) ═══════════
 *
 * Chủ shop: danh sách «Chưa đọc» hiện nhiều dòng «AI: …» kèm huy hiệu; mở A rồi chuyển B thì A quay lại đầu danh sách vẫn chưa đọc.
 * Bài kiểm khoá bốn điều:
 *  1. NGHĨA (P0.1 · P0.6): chín ca của đặc tả — chỉ KHÁCH · KHÁCH→BOT · KHÁCH→STAFF · KHÁCH→PAGE ngoài ERP · chỉ BOT · chỉ STAFF · chỉ
 *     PAGE · nhiều tin KHÁCH · tin KHÁCH tới trong lúc nạp khung chat — cộng ca «huy hiệu giả của luật cũ» (cột mốc bị đẩy, không có tin
 *     khách nào). Bất biến FALSE-UNREAD = 0 trên toàn bộ dữ liệu mẫu, cho cả hai người, và đo bằng chính script ops `inbox-read-audit`.
 *  2. XEM TRƯỚC (P0.2): hội thoại chưa đọc luôn xem trước TIN KHÁCH chưa đọc mới nhất (+ dòng phụ «AI đã trả lời»), không bao giờ tin AI.
 *  3. ĐỌC (P0.3 · P0.5): nạp khung chat KHÔNG đánh dấu đọc; con trỏ = tin khách cuối cùng của payload (không phải giờ bấm), chỉ tiến,
 *     idempotent, theo NGƯỜI; tin khách tới sau con trỏ vẫn chưa đọc; mã tin không thuộc hội thoại / không phải tin khách bị từ chối.
 *  4. DANH SÁCH (P0.4 · P0.7): hàm thuần vá hàng + bộ đếm theo xác nhận đọc — bản danh sách cũ không đè lượt đọc đã xác nhận; rời A ở
 *     thẻ «Tin khách chưa đọc» ⇒ A rời NGAY; ở «Tất cả» A về nhóm đã đọc đúng chỗ; có tin khách mới hơn ⇒ A vẫn chưa đọc.
 * Quét mã nguồn: đường đánh dấu đọc không dùng `now` / `new Date()` làm mốc; hàng danh sách không lồng `<a>` trong `<a>`.
 * Mốc thời gian đi theo đồng hồ THẬT (AGENTS 50).
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { fanpageVisitorKey, PAGE_REPLY, STAFF_OUT_PREFIX } from "@/lib/sales-chatbot/fanpage";
import { listInbox, loadInboxThread } from "@/lib/sales-chatbot/inbox";
import { markInboxReadCore } from "@/lib/sales-chatbot/inbox-read";
import { inboxDisplayRows, mergeReadConfirmation, patchRowWithRead, patchUnreadCount, type InboxReadConfirmation } from "@/lib/sales-chatbot/inbox-read-shared";
import { INBOX_FILTER_LABEL, inboxParams, type InboxRow } from "@/lib/sales-chatbot/inbox-shared";
import { auditReadRows, collectReadAudit, parseReadAuditArgs, type ReadAuditRow } from "@/scripts/inbox-read-audit";

const ORG = "hop-thu-doc-v3";
const PAGE = "pg-doc-v3";
const MIN = 60_000;

// ─────────────────────────── 1. Hàm thuần: vá danh sách theo xác nhận đọc ───────────────────────────

const iso = (ms: number) => new Date(ms).toISOString();
function row(id: string, over: Partial<InboxRow> = {}): InboxRow {
  return {
    id,
    channel: "FANPAGE",
    pageId: PAGE,
    pageName: null,
    status: "OPEN",
    handoffReason: null,
    customerName: id,
    customerPhone: null,
    customerId: null,
    preview: "Xin giá",
    previewSide: "CUSTOMER",
    previewAt: iso(1_000),
    afterPreview: { side: "BOT", at: iso(2_000) },
    latestPreview: "Dạ giá 280k ạ",
    latestSide: "BOT",
    latestAt: iso(2_000),
    newestCustomerAt: iso(1_000),
    readCursorAt: iso(0),
    lastActivityAt: iso(2_000),
    waitingSince: null,
    unread: true,
    unreadCount: 1,
    avatarUrl: null,
    aiHold: "AI_ACTIVE",
    handling: "AI",
    needsHuman: null,
    humanHandling: null,
    closed: false,
    source: "PANCAKE",
    assigneeUserId: null,
    assigneeName: null,
    hasOrder: false,
    labels: [],
    level: null,
    ...over,
  };
}
const read = (conversationId: string, over: Partial<InboxReadConfirmation> = {}): InboxReadConfirmation => ({ conversationId, throughAt: iso(1_000), unreadBefore: 1, unreadAfter: 0, stamp: iso(5_000), ...over });

function testPure() {
  // Bản hàng CŨ hơn lượt đọc (con trỏ 0 < 1000) ⇒ đã đọc, xem trước về tin mới nhất (AI), bỏ dòng phụ.
  const a = row("a");
  const p = patchRowWithRead(a, read("a"));
  assert.ok(!p.unread && p.unreadCount === 0 && p.previewSide === "BOT" && p.preview === "Dạ giá 280k ạ" && p.afterPreview === null, "bản cũ + xác nhận ⇒ đã đọc");
  // Bản cũ nhưng có tin khách MỚI HƠN mốc đọc ⇒ vẫn chưa đọc (tin tới sau lúc đọc).
  assert.equal(patchRowWithRead(row("a", { newestCustomerAt: iso(1_500) }), read("a")).unread, true, "tin khách sau mốc đọc ⇒ vẫn chưa đọc");
  // Bản MỚI hơn lượt đọc (con trỏ ≥ mốc) ⇒ máy chủ thắng, kể cả khi nó nói chưa đọc.
  const fresh = row("a", { readCursorAt: iso(1_000), newestCustomerAt: iso(3_000) });
  assert.equal(patchRowWithRead(fresh, read("a")), fresh, "bản mới hơn lượt đọc ⇒ không vá");
  assert.equal(patchRowWithRead(a, undefined), a, "không xác nhận ⇒ không vá");

  // A → B ở thẻ «Tin khách chưa đọc»: bản máy chủ cũ còn A ở đầu; A đã xác nhận đọc, đang mở B ⇒ A rời danh sách NGAY.
  const server = [row("a", { lastActivityAt: iso(9_000) }), row("b", { lastActivityAt: iso(8_000) }), row("c", { lastActivityAt: iso(7_000) })];
  const reads = new Map([["a", read("a")]]);
  const prevShown = server;
  const unreadView = inboxDisplayRows(server, prevShown, { activeId: "b", filter: "UNREAD", reads });
  assert.deepEqual(unreadView.map((r) => r.id), ["b", "c"], "rời A ⇒ A khỏi thẻ chưa đọc ngay, không đợi làm mới");
  assert.equal(unreadView[0].unread, false, "hàng ĐANG MỞ hiện đã đọc ngay");
  // Đang mở A: A đứng yên tại chỗ và hiện đã đọc.
  const openA = inboxDisplayRows(server, prevShown, { activeId: "a", filter: "UNREAD", reads });
  assert.deepEqual(openA.map((r) => r.id), ["a", "b", "c"], "đang mở A ⇒ A đứng yên");
  assert.equal(openA[0].unread, false);
  // A có tin khách MỚI hơn lượt đọc ⇒ A còn / hiện lại ở thẻ chưa đọc.
  const again = inboxDisplayRows([row("a", { newestCustomerAt: iso(1_500), lastActivityAt: iso(9_000) }), ...server.slice(1)], prevShown, { activeId: "b", filter: "UNREAD", reads });
  assert.deepEqual(again.map((r) => r.id), ["a", "b", "c"], "tin khách mới ⇒ A hiện lại chưa đọc ở vị trí chuẩn");
  assert.equal(again[0].unread, true);
  // «Tất cả»: rời A ⇒ A về NHÓM ĐÃ ĐỌC đúng chỗ (tin mới nhất trước trong nhóm).
  const all = [row("a", { lastActivityAt: iso(9_000) }), row("b", { lastActivityAt: iso(8_000) }), row("x", { unread: false, unreadCount: 0, lastActivityAt: iso(9_500) }), row("y", { unread: false, unreadCount: 0, lastActivityAt: iso(6_000) })];
  const allView = inboxDisplayRows(all, all, { activeId: "b", filter: "ALL", reads });
  assert.deepEqual(allView.map((r) => r.id), ["x", "b", "a", "y"], "B đang mở đứng yên ở vị trí 2 · A (9.000) về nhóm đã đọc giữa x (9.500) và y (6.000)");
  assert.equal(allView.find((r) => r.id === "a")!.unread, false);

  // Bộ đếm: bản đếm CŨ hơn lượt đọc (dấu 4.000 < 5.000) ⇒ trừ 1; bản đếm đã thấy lượt đọc ⇒ giữ số máy chủ; không âm.
  assert.equal(patchUnreadCount(2401, iso(4_000), [read("a")]), 2400, "bản đếm cũ ⇒ trừ ngay");
  assert.equal(patchUnreadCount(2400, iso(5_000), [read("a")]), 2400, "bản đếm đã thấy lượt đọc ⇒ máy chủ thắng");
  assert.equal(patchUnreadCount(2401, null, [read("a"), read("b", { unreadBefore: 0 })]), 2400, "đọc lại hội thoại đã đọc không trừ thêm");
  assert.equal(patchUnreadCount(0, null, [read("a")]), 0, "không âm");
  assert.equal(patchUnreadCount(5, null, [read("a", { unreadAfter: 1 })]), 5, "còn tin khách sau lượt đọc ⇒ vẫn chưa đọc, không trừ");
  // Gộp: con trỏ chỉ TIẾN; «trước đó chưa đọc» không mất khi đọc lại lần hai (cùng dấu).
  const m = mergeReadConfirmation(read("a", { throughAt: iso(2_000) }), read("a", { throughAt: iso(1_000), unreadBefore: 0 }));
  assert.ok(m.throughAt === iso(2_000) && m.unreadBefore === 1, `gộp xác nhận: ${JSON.stringify(m)}`);

  // Script ops: tham số + tổng bất biến (thuần).
  assert.deepEqual(parseReadAuditArgs(["hslc", "--limit=40", "--conversation=51749559-97c2-46e6-8714-c15c1727123b"]), { code: "hslc", limit: 40, conversation: "51749559-97c2-46e6-8714-c15c1727123b" });
  assert.ok("error" in parseReadAuditArgs(["hslc", "--limit=0"]) && "error" in parseReadAuditArgs([]) && "error" in parseReadAuditArgs(["hslc", "--conversation=a;b"]));
  const base: ReadAuditRow = { channel: "FANPAGE", lastCustomerAt: new Date(1_000), lastBotAt: new Date(2_000), lastStaffAt: null, sharedCursor: new Date(0), readers: 0, readersUnread: 0, readersFalseUnread: 0, legacyUnread: true, legacyCount: 0, customerAfterShared: 0, newestCustomerAt: new Date(500), latestSide: "BOT", latestAt: new Date(2_000) };
  const tot = auditReadRows([base, { ...base, customerAfterShared: 1, newestCustomerAt: new Date(1_000) }]);
  assert.deepEqual(tot.legacy, { unread: 2, falseUnread: 1, aiPreviewUnread: 2 }, "luật cũ: chưa đọc không bằng chứng + xem trước tin AI");
  assert.deepEqual(tot.current, { unread: 1, falseUnread: 0, aiPreviewUnread: 0 }, "luật mới: chỉ hội thoại có tin khách, xem trước tin khách");
  console.log("  ✓ thuần: bản danh sách cũ không đè lượt đọc · A rời thẻ chưa đọc ngay · «Tất cả» về nhóm đã đọc đúng chỗ · tin khách mới ⇒ còn chưa đọc · bộ đếm trừ ngay theo dấu · audit đếm bất biến");
}

// ─────────────────────────── 2. CSDL: chín ca + hai người + con trỏ chỉ tiến ───────────────────────────

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

type Side = "C" | "BOT" | "STAFF" | "PAGE";
type Case = { id: string; note: string; msgs: { side: Side; ago: number }[]; expect: { unread: number; preview: "CUSTOMER" | "BOT" | "STAFF" | "PAGE"; after?: "BOT" | "STAFF" | "PAGE" }; conv?: Partial<typeof schema.salesChatConversations.$inferInsert> };

async function testDb() {
  await cleanup();
  try {
    await provisionOrganization({ code: ORG, name: "Shop hộp thư đọc V3", plan: "standard", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "Chủ shop", password: "HopThu@123456" }, source: "TEST", actor: null });
    const enabled = await getEnabledModules(ORG);
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const admin = { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: ORG, isHome: false }, modules: [...enabled] } as unknown as SessionUser;
      const [s1] = await db.insert(schema.users).values({ email: `lan@${ORG}.local`, name: "Lan CSKH", passwordHash: "x", role: "CS" }).returning({ id: schema.users.id });
      const lan = { ...admin, id: s1.id, email: `lan@${ORG}.local`, name: "Lan CSKH", role: "CS", permissions: ["ai_sales:view", "ai_sales:reply"] } as unknown as SessionUser;
      const outsider = { ...admin, id: "khong-quyen", role: "VIEWER", permissions: [] } as unknown as SessionUser;
      const T0 = Date.now();
      const at = (msAgo: number) => new Date(T0 - msAgo);
      const c = schema.salesChatConversations;
      const t = schema.salesChatInbound;

      // ═══ CHÍN CA CỦA ĐẶC TẢ (+ một ca luật cũ) — kỳ vọng viết tay cho người xem CHƯA có con trỏ riêng ═══
      const cases: Case[] = [
        { id: "r1", note: "chỉ KHÁCH", msgs: [{ side: "C", ago: 10 * MIN }], expect: { unread: 1, preview: "CUSTOMER" } },
        { id: "r2", note: "KHÁCH → BOT (AI trả lời, chưa ai mở)", msgs: [{ side: "C", ago: 20 * MIN }, { side: "BOT", ago: 19 * MIN }], expect: { unread: 1, preview: "CUSTOMER", after: "BOT" } },
        { id: "r3", note: "KHÁCH → STAFF (nhân viên trả lời từ ERP = đã thấy)", msgs: [{ side: "C", ago: 30 * MIN }, { side: "STAFF", ago: 29 * MIN }], expect: { unread: 0, preview: "STAFF" } },
        { id: "r4", note: "KHÁCH → PAGE ngoài ERP (người trong ERP chưa thấy)", msgs: [{ side: "C", ago: 40 * MIN }, { side: "PAGE", ago: 39 * MIN }], expect: { unread: 1, preview: "CUSTOMER", after: "PAGE" } },
        { id: "r5", note: "chỉ BOT", msgs: [{ side: "BOT", ago: 50 * MIN }], expect: { unread: 0, preview: "BOT" } },
        { id: "r6", note: "chỉ STAFF", msgs: [{ side: "STAFF", ago: 60 * MIN }], expect: { unread: 0, preview: "STAFF" } },
        { id: "r7", note: "chỉ PAGE", msgs: [{ side: "PAGE", ago: 70 * MIN }], expect: { unread: 0, preview: "PAGE" } },
        { id: "r8", note: "nhiều tin KHÁCH rồi AI", msgs: [{ side: "C", ago: 83 * MIN }, { side: "C", ago: 82 * MIN }, { side: "C", ago: 81 * MIN }, { side: "BOT", ago: 80 * MIN }], expect: { unread: 3, preview: "CUSTOMER", after: "BOT" } },
        { id: "r9", note: "KHÁCH (tin mới sẽ tới trong lúc nạp khung chat)", msgs: [{ side: "C", ago: 90 * MIN }], expect: { unread: 1, preview: "CUSTOMER" } },
        // Luật CŨ: cột mốc `last_customer_at` bị đẩy bằng giờ xử lý sau lần người mở, không có tin khách nào sau đó ⇒ huy hiệu giả.
        { id: "r10", note: "cột mốc bị đẩy, không tin khách sau lần mở (luật cũ in «AI: … ①»)", msgs: [{ side: "C", ago: 100 * MIN }, { side: "BOT", ago: 99 * MIN }], conv: { staffSeenAt: at(98 * MIN), lastCustomerAt: at(97 * MIN) }, expect: { unread: 0, preview: "BOT" } },
      ];
      const text: Record<Side, string> = { C: "Báo giá chả cá thu?", BOT: "Dạ giá 280k ạ", STAFF: "Dạ em gửi ảnh ạ", PAGE: "Dạ em kiểm hàng" };
      const ids: Record<string, string> = {};
      for (const k of cases) {
        const thread = `t-${k.id}`;
        const last = (s: Side) => k.msgs.filter((m) => m.side === s).reduce<Date | null>((x, m) => (!x || at(m.ago) > x ? at(m.ago) : x), null);
        const [cv] = await db
          .insert(c)
          .values({ channel: "FANPAGE", status: "OPEN", visitorKey: fanpageVisitorKey(PAGE, thread), pageId: PAGE, threadId: thread, lastCustomerAt: last("C"), lastBotAt: last("BOT"), lastStaffAt: last("STAFF"), createdAt: at(200 * MIN), ...k.conv })
          .returning({ id: c.id });
        ids[k.id] = cv.id;
        for (const [i, m] of k.msgs.entries()) {
          await db.insert(t).values({
            pageId: PAGE,
            threadId: thread,
            messageId: m.side === "STAFF" ? `${STAFF_OUT_PREFIX}${k.id}-${i}` : `${k.id}-${i}`,
            text: m.side === "C" && k.id === "r8" ? `${text.C} (${i + 1})` : text[m.side],
            note: m.side === "BOT" ? "BOT_SENT" : m.side === "STAFF" || m.side === "PAGE" ? PAGE_REPLY : null,
            customerName: "Khách",
            status: "DONE",
            createdAt: at(m.ago),
          });
        }
      }
      const listOf = async (who: SessionUser, filter: "ALL" | "UNREAD" = "ALL") => {
        const r = await listInbox(who, { filter, limit: 500 });
        assert.ok(r.ok, JSON.stringify(r));
        return r;
      };
      const rowOf = async (who: SessionUser, k: string) => (await listOf(who)).rows.find((r) => r.id === ids[k])!;

      // ── Nghĩa + xem trước cho người xem chưa có con trỏ riêng ──
      const all = await listOf(admin);
      for (const k of cases) {
        const r = all.rows.find((x) => x.id === ids[k.id])!;
        assert.equal(r.unreadCount, k.expect.unread, `${k.id} (${k.note}): số tin khách chưa đọc`);
        assert.equal(r.unread, k.expect.unread > 0, `${k.id}: chưa đọc ⇔ số ≥ 1`);
        assert.equal(r.previewSide, k.expect.preview, `${k.id} (${k.note}): phía của tin xem trước`);
        assert.equal(r.afterPreview?.side ?? null, k.expect.after ?? null, `${k.id}: dòng phụ «đã trả lời»`);
      }
      assert.equal(all.rows.find((x) => x.id === ids.r8)!.preview, `${text.C} (3)`, "nhiều tin khách ⇒ xem trước tin khách MỚI NHẤT");
      assert.ok(all.rows.every((r) => !r.unread || r.previewSide === "CUSTOMER"), "không bao giờ «chưa đọc» với xem trước tin AI / NV / page");
      const unread0 = await listOf(admin, "UNREAD");
      assert.deepEqual(new Set(unread0.rows.map((r) => r.id)), new Set(["r1", "r2", "r4", "r8", "r9"].map((k) => ids[k])), "thẻ «Tin khách chưa đọc» = đúng các ca có tin khách");
      assert.equal(unread0.counts.UNREAD, 5);

      // ── Nạp khung chat KHÔNG đánh dấu đọc; con trỏ = tin khách cuối cùng của payload; tin khách tới giữa chừng ⇒ vẫn chưa đọc ──
      const th9 = await loadInboxThread(lan, ids.r9);
      assert.ok(th9.ok && th9.thread.readThrough, "payload mang tin khách cuối cùng");
      const firstR9 = (await db.select({ id: t.id }).from(t).where(eq(t.messageId, "r9-0")))[0];
      assert.equal(th9.thread.readThrough.id, firstR9.id, "đọc tới ĐÚNG tin khách có trong payload");
      assert.equal((await rowOf(lan, "r9")).unread, true, "nạp khung chat chưa phải là đọc");
      // Tin khách MỚI tới sau khi payload đã dựng (đúng ca đua của P0.3).
      await db.insert(t).values({ pageId: PAGE, threadId: "t-r9", messageId: "r9-new", text: "Còn hàng không shop?", customerName: "Khách", status: "DONE" });
      const m9 = await markInboxReadCore(lan, ids.r9, th9.thread.readThrough.id);
      assert.ok(m9.ok && m9.read.unreadBefore === 2 && m9.read.unreadAfter === 1, `tin tới sau con trỏ ⇒ còn 1 chưa đọc: ${JSON.stringify(m9)}`);
      const r9 = await rowOf(lan, "r9");
      assert.ok(r9.unread && r9.unreadCount === 1 && r9.preview === "Còn hàng không shop?", "tin khách mới hơn con trỏ vẫn chưa đọc, xem trước đúng tin đó");

      // ── Con trỏ chỉ TIẾN, idempotent ──
      const th8 = await loadInboxThread(lan, ids.r8);
      assert.ok(th8.ok && th8.thread.readThrough);
      const a8 = await markInboxReadCore(lan, ids.r8, th8.thread.readThrough.id);
      assert.ok(a8.ok && a8.read.unreadBefore === 3 && a8.read.unreadAfter === 0, JSON.stringify(a8));
      const b8 = await markInboxReadCore(lan, ids.r8, th8.thread.readThrough.id);
      assert.ok(b8.ok && b8.read.stamp === a8.read.stamp && b8.read.throughAt === a8.read.throughAt && b8.read.unreadBefore === 0, "gọi lại cùng tin ⇒ không đổi gì (idempotent)");
      const older = (await db.select({ id: t.id }).from(t).where(eq(t.messageId, "r8-0")))[0];
      const c8 = await markInboxReadCore(lan, ids.r8, older.id);
      assert.ok(c8.ok && c8.read.throughAt === a8.read.throughAt && c8.read.stamp === a8.read.stamp && c8.read.unreadAfter === 0, "đánh dấu tới tin CŨ hơn ⇒ con trỏ không lùi");
      const [cur8] = await db.select().from(schema.salesChatReads).where(and(eq(schema.salesChatReads.conversationId, ids.r8), eq(schema.salesChatReads.userId, lan.id)));
      assert.ok(cur8 && cur8.readThroughMessageId === th8.thread.readThrough.id, "con trỏ giữ mã tin khách mới nhất đã đọc");

      // ── Từ chối: tin không phải của khách · tin hội thoại khác · không quyền ──
      const bot8 = (await db.select({ id: t.id }).from(t).where(eq(t.messageId, "r8-3")))[0];
      assert.equal((await markInboxReadCore(lan, ids.r8, bot8.id)).ok, false, "mã tin BOT không làm con trỏ đọc");
      assert.equal((await markInboxReadCore(lan, ids.r1, older.id)).ok, false, "mã tin của hội thoại khác bị từ chối");
      assert.equal((await markInboxReadCore(outsider, ids.r1, older.id)).ok, false, "không quyền xem ⇒ không đánh dấu");

      // ── Hai người, chưa đọc độc lập ──
      // admin đọc r2 trước (có con trỏ riêng), rồi khách nhắn thêm ⇒ cả hai chưa đọc; Lan đọc ⇒ Lan hết, admin VẪN còn.
      const th2a = await loadInboxThread(admin, ids.r2);
      assert.ok(th2a.ok && th2a.thread.readThrough && (await markInboxReadCore(admin, ids.r2, th2a.thread.readThrough.id)).ok);
      assert.equal((await rowOf(admin, "r2")).unread, false, "admin đọc r2");
      await db.insert(t).values({ pageId: PAGE, threadId: "t-r2", messageId: "r2-new", text: "Ship về Huế bao lâu?", customerName: "Khách", status: "DONE" });
      assert.ok((await rowOf(admin, "r2")).unread && (await rowOf(lan, "r2")).unread, "tin khách mới ⇒ cả hai chưa đọc");
      const th2l = await loadInboxThread(lan, ids.r2);
      assert.ok(th2l.ok && th2l.thread.readThrough && (await markInboxReadCore(lan, ids.r2, th2l.thread.readThrough.id)).ok);
      assert.equal((await rowOf(lan, "r2")).unread, false, "Lan đọc ⇒ Lan hết chưa đọc");
      const adminR2 = await rowOf(admin, "r2");
      assert.ok(adminR2.unread && adminR2.unreadCount === 1, "admin có con trỏ riêng ⇒ VẪN chưa đọc tin Lan đã đọc (chưa đọc là CÁ NHÂN)");
      // Tương thích ngược (quyết định đã ghi ở inbox-states.ts): người CHƯA có con trỏ riêng của hội thoại đọc mốc chung — Lan (trả lời
      // được) đẩy mốc chung tới đúng tin khách đã đọc, nên với r8 admin cũng thấy đã đọc như hôm nay.
      assert.equal((await rowOf(admin, "r8")).unread, false, "chưa có con trỏ riêng ⇒ lùi về mốc chung");
      // Bộ đếm theo người: admin còn r2 chưa đọc, Lan thì không.
      assert.ok((await listOf(admin, "UNREAD")).rows.some((r) => r.id === ids.r2) && !(await listOf(lan, "UNREAD")).rows.some((r) => r.id === ids.r2), "thẻ «Tin khách chưa đọc» theo người xem");

      // ═══ BẤT BIẾN FALSE-UNREAD = 0 trên toàn bộ dữ liệu mẫu, cho cả hai người ═══
      for (const who of [admin, lan]) {
        const l = await listOf(who);
        for (const r of l.rows) {
          assert.equal(r.unread, r.unreadCount > 0, `${r.id}: chưa đọc ⇔ số ≥ 1`);
          if (r.unread) assert.ok(r.newestCustomerAt && r.readCursorAt && r.newestCustomerAt > r.readCursorAt, `${r.id}: chưa đọc ⇒ có tin khách sau con trỏ của người xem`);
          if (r.unread) assert.equal(r.previewSide, "CUSTOMER", `${r.id}: chưa đọc ⇒ xem trước tin khách`);
        }
        const u = await listOf(who, "UNREAD");
        assert.equal(u.counts.UNREAD, u.rows.length, "số trên thẻ = số dòng");
        assert.ok(u.unreadStamp === null || typeof u.unreadStamp === "string");
      }
      // Script ops trên CHÍNH dữ liệu này: luật mới 0 vi phạm; luật cũ bắt được ca r10.
      const audit = await collectReadAudit(db, { limit: 500, conversation: null });
      const tot = auditReadRows(audit.rows);
      assert.ok(audit.hasReadsTable && tot.rows === cases.length, `audit đọc đủ ${cases.length} hội thoại`);
      assert.equal(tot.current.falseUnread, 0, "audit: FALSE-UNREAD luật mới = 0");
      assert.equal(tot.current.aiPreviewUnread, 0, "audit: không hội thoại chưa đọc nào xem trước tin AI / NV / page");
      assert.equal(tot.readers.falseUnread, 0, "audit: con trỏ riêng không vi phạm");
      assert.ok(tot.legacy.falseUnread >= 1, `audit: luật cũ có chưa đọc giả (r10): ${JSON.stringify(tot.legacy)}`);
      assert.ok(tot.legacy.aiPreviewUnread >= 1, "audit: luật cũ có «AI: … + huy hiệu»");
      const one = await collectReadAudit(db, { limit: 500, conversation: ids.r9 });
      assert.equal(one.rows.length, 1, "--conversation đọc đúng một hội thoại");
      console.log(`  ✓ CSDL: 9 ca đặc tả + ca luật cũ · nạp ≠ đọc · con trỏ = tin khách cuối của payload · tin tới giữa chừng còn chưa đọc · chỉ tiến · idempotent · hai người độc lập · FALSE-UNREAD 0 (luật cũ ${tot.legacy.falseUnread})`);
    });
  } finally {
    await cleanup();
  }
}

// ─────────────────────────── 3. Quét mã nguồn ───────────────────────────

function testSource() {
  const readCore = readFileSync("lib/sales-chatbot/inbox-read.ts", "utf8");
  const body = readCore.slice(readCore.indexOf("export async function markInboxReadCore"));
  assert.ok(body.length > 200, "đọc được thân markInboxReadCore");
  assert.doesNotMatch(body, /new Date\(\)|Date\.now\(\)|readThroughAt:\s*now\b|staffSeenAt:\s*now\b/, "đường đánh dấu đọc KHÔNG lấy giờ hiện tại làm mốc đọc");
  assert.match(body, /select i\.created_at from "sales_chat_inbound" i where i\.id = \$\{throughId\}/, "mốc đọc lấy từ CHÍNH dòng tin khách trong CSDL");
  assert.match(body, /setWhere: sql`\$\{r\.readThroughAt\} < excluded\.read_through_at`/, "con trỏ chỉ tiến");
  const inbox = readFileSync("lib/sales-chatbot/inbox.ts", "utf8");
  assert.doesNotMatch(inbox, /staffSeenAt:\s*now/, "nạp khung chat không còn ghi staff_seen_at = now");
  assert.doesNotMatch(inbox, /Math\.max\(1, Number\(r\.unreadN/, "không còn huy hiệu max(1, …) cho hội thoại không có tin khách");
  const pane = readFileSync("app/(dashboard)/ai/sales-chatbot/inbox/thread-pane.tsx", "utf8");
  assert.match(pane, /body: JSON\.stringify\(\{ c: shownId, through: throughId \}\)/, "khung chat gửi MÃ tin khách cuối của payload, không gửi giờ");
  assert.match(pane, /recordInboxRead\(r\.read\)/, "xác nhận của máy chủ vào bộ nhớ đọc");

  // Hàng danh sách: link hàng TỰ ĐÓNG (không bọc gì), ảnh đại diện là link ANH EM — không `<a>` trong `<a>`.
  const list = readFileSync("app/(dashboard)/ai/sales-chatbot/inbox/conversation-list.tsx", "utf8");
  const rowSrc = list.slice(list.indexOf("function Row("), list.indexOf("export function ConversationRows"));
  assert.ok(rowSrc.length > 500, "đọc được hàm Row");
  assert.equal((rowSrc.match(/<Link\b/g) ?? []).length, 1, "một Link hàng");
  assert.match(rowSrc, /<Link[\s\S]*?data-row-link\s*\/>/, "Link hàng tự đóng — không bọc phần tử nào");
  assert.doesNotMatch(rowSrc, /<\/Link>|<a\b/, "không thẻ a / Link nào mở trong hàng ngoài link anh em");
  assert.match(rowSrc, /<AvatarLinkWrap link=\{avatarLink\}/, "ảnh đại diện có đích riêng (avatarHrefOf)");
  assert.match(rowSrc, /avatarHrefOf\(r\.customerId\)/, "đích ảnh = avatarHrefOf — không dựng facebook.com/<PSID>");
  assert.match(list, /inboxDisplayRows\(rows, shown\.current, \{ activeId, filter: state\.filter, reads \}\)/, "danh sách vẽ qua hàm vá theo xác nhận đọc");

  // Nhãn mới, khoá lọc + tham số URL cũ giữ nguyên.
  assert.equal(INBOX_FILTER_LABEL.UNREAD, "Tin khách chưa đọc");
  assert.equal(inboxParams({ filter: "UNREAD", q: "", page: null, channel: null, handler: null, assignee: null, phone: null, level: null, period: null, from: null, to: null, label: null, limit: 100, selected: null }).toString(), "f=UNREAD", "tham số URL cũ ?f=UNREAD");

  // Script ops: chỉ đọc + khai đủ bốn chỗ.
  const sc = readFileSync("scripts/inbox-read-audit.ts", "utf8");
  assert.match(sc, /process\.env\.ERP_READ_ONLY = "1"/);
  assert.match(sc, /show default_transaction_read_only/);
  assert.match(sc, /getDbForInspection/);
  assert.doesNotMatch(sc, /\.(insert|update|delete)\(|\binsert into\b|\bupdate \w+ set\b/i, "script không câu ghi");
  assert.doesNotMatch(sc, /customerName|customer_name|phone/i, "script không đọc tên / SĐT");
  assert.doesNotMatch(sc, /console\.log\([^)]*\.text\b/, "script không in chữ tin");
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.match(ops, /- inbox-read-audit\s+#/, "ops-vps khai lựa chọn");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\binbox-read-audit\b/, "kết quả MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\binbox-read-audit\b/, "làn ĐỌC nặng");
  assert.match(ops, /inbox-read-audit\)\n[\s\S]*?scripts\/inbox-read-audit\.ts ;;/, "nhánh chạy");

  // Migration 0239 + lược đồ khớp.
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { tag: string }[] };
  assert.ok(journal.entries.some((e) => e.tag === "0239_sales_chat_reads"), "sổ migration có 0239");
  const mig = readFileSync("drizzle/0239_sales_chat_reads.sql", "utf8");
  assert.match(mig, /CREATE TABLE IF NOT EXISTS "sales_chat_reads"/);
  assert.doesNotMatch(mig, /\bINSERT\s+INTO\b|\bUPDATE\s+"?\w+"?\s+SET\b/i, "0239 không backfill");
  console.log("  ✓ mã nguồn: mốc đọc từ CSDL (không now) · chỉ tiến · không <a> trong <a> · nhãn «Tin khách chưa đọc», ?f=UNREAD giữ · ops khai đủ · 0239 không backfill");
}

export async function testInboxReadV3() {
  console.log("Hộp thư — chưa đọc có bằng chứng, theo người (inbox-read-v3):");
  testPure();
  testSource();
  await testDb();
}

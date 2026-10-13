/**
 * ═══════════ HỘP THƯ — «TIN KHÁCH CHƯA ĐỌC» = LƯỢT KHÁCH MỚI NHẤT CHƯA XỬ LÝ, LƯU SẴN (chủ shop 11/10/2026 · P0 inbox-unread-perf) ═══════════
 *
 * NGHĨA là của response-ownership (#803): `latestCustomerTurnUnhandledSql()` ≡ `latestTurnHandled` / `latestWebTurnHandled`. Định nghĩa tất
 * định theo dòng ⇒ trigger CSDL lưu KẾT QUẢ của chính nó vào `turn_unhandled` (0245); hộp thư đọc cột. Bài kiểm khoá:
 *  1. MA TRẬN chủ shop qua listInbox (hai người): CUSTOMER ⇒ CÓ · →AI · →STAFF · →PAGE hợp lệ · →NGƯỜI MỞ (con trỏ đọc / mốc mở cũ) ⇒
 *     KHÔNG · →AI→CUSTOMER mới · →STAFF→CUSTOMER mới ⇒ CÓ · chỉ BOT / STAFF / PAGE ⇒ KHÔNG; nhãn dán / ghi âm (MEDIA_ONLY) là lượt khách;
 *     chữ hệ thống, tin chào đầu phiên, tin nhân viên gửi HỎNG, câu bot đứng trước tin khách theo mốc nguồn không phải câu trả lời; chat
 *     web có lượt khách. Huy hiệu = tin khách chưa xử lý; dòng xem trước không bao giờ «AI: …» + huy hiệu.
 *  2. A → B: đọc A ⇒ A rời «Tin khách chưa đọc» ngay (vá lạc quan + bản máy chủ mới), bộ đếm −1, người khác cũng thấy; khách nhắn tin mới ⇒
 *     A về đầu, chưa đọc. Tin khách ghi sau lúc nạp khung chat vẫn chưa đọc sau lượt đọc.
 *  3. PARITY trên fixture hạt cố định ≥ 3.000 hội thoại: kết quả lưu sẵn ≡ định nghĩa #803 tính trực tiếp ≡ bản TS (`latestTurnStateOf`)
 *     từng hội thoại; listInbox (thứ tự 100 dòng «Tất cả» + «Chưa đọc», thẻ) = tham chiếu dựng từ hàm trần; huy hiệu ≥ 1 ⇔ chưa đọc.
 *  4. LƯU SẴN LUÔN ĐÚNG sau MỌI đường ghi (tin mọi phía · trạng thái tin nhân viên · mốc mở cũ · con trỏ đọc · tin mẫu chéo luồng · chat web ·
 *     hội thoại dựng sau tin · đổi luồng); dẫn xuất của migration tất định; thân hàm CSDL = câu SQL hàm TS của #803 từng ký tự.
 *  5. MÃ NGUỒN: không đường TypeScript nào ghi hai cột; hộp thư chỉ đọc bộ biểu thức của `loadInboxUnreadSql` (không luật thứ hai);
 *     migration đặt lock_timeout / statement_timeout bằng SET LOCAL trong giao dịch của drizzle; công tắc lùi đọc đúng một chỗ.
 * Mốc thời gian đi theo đồng hồ THẬT (AGENTS 50).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { forgetMemo } from "@/lib/cache";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { fanpageVisitorKey, PAGE_REPLY, STAFF_OUT_PREFIX } from "@/lib/sales-chatbot/fanpage";
import { listInbox, loadInboxThread } from "@/lib/sales-chatbot/inbox";
import { markInboxReadCore } from "@/lib/sales-chatbot/inbox-read";
import { inboxDisplayRows, patchUnreadCount } from "@/lib/sales-chatbot/inbox-read-shared";
import { INBOX_ACTIVITY_SQL } from "@/lib/sales-chatbot/inbox-states";
import { INBOX_UNREAD_COUNT_SQL, INBOX_UNREAD_SQL, INBOX_UNREAD_SWITCH_KEY, inboxUnreadMaterialized, inboxUnreadSqlFor } from "@/lib/sales-chatbot/inbox-unread";
import { normalizeSql, renderTurnUnhandledSql } from "@/lib/sales-chatbot/inbox-unread-render";
import { latestCustomerTurnUnhandledSql, latestTurnStateOf } from "@/lib/sales-chatbot/response-ownership-ledger";
import { auditReadRows, collectReadAudit, measureLastInboundDrift } from "@/scripts/inbox-read-audit";
import { buildInboxFixture } from "./inbox-unread-fixture";
import { PAGE_SYSTEM_TEXT, seedInboxFixture } from "./inbox-unread-seed";

const ORG = "hop-thu-unread-perf";
const PAGE = "pg-unread-perf";
const N = 3000;
const MIN = 60_000;
const MIG = "drizzle/0245_sales_chat_last_inbound.sql";

async function cleanup() {
  const pdb = await getPlatformDb();
  await pdb.delete(schema.settings).where(eq(schema.settings.key, INBOX_UNREAD_SWITCH_KEY));
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, ORG) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

/** Một bước của ma trận kênh nhắn tin. */
type Step = "C" | "C_MEDIA" | "C_SKEW" | "AI" | "STAFF" | "STAFF_FAILED" | "PAGE" | "PAGE_SYS" | "PAGE_AUTO" | "PAGE_META" | "GREETING" | "OPEN" | "OPEN_LEGACY";

async function testDb() {
  await cleanup();
  try {
    await provisionOrganization({ code: ORG, name: "Shop hộp thư nhanh", plan: "standard", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "Chủ shop", password: "HopThu@123456" }, source: "TEST", actor: null });
    const enabled = await getEnabledModules(ORG);
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const admin = { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: ORG, isHome: false }, modules: [...enabled] } as unknown as SessionUser;
      const [s1] = await db.insert(schema.users).values({ email: `lan@${ORG}.local`, name: "Lan CSKH", passwordHash: "x", role: "CS" }).returning({ id: schema.users.id });
      const lan = { ...admin, id: s1.id, email: `lan@${ORG}.local`, name: "Lan CSKH", role: "CS", permissions: ["ai_sales:view", "ai_sales:reply"] } as unknown as SessionUser;
      const c = schema.salesChatConversations;
      const t = schema.salesChatInbound;
      const m = schema.salesChatMessages;
      const scalar = async (q: ReturnType<typeof sql>) => Number(((await db.execute(q)) as unknown as { rows: { n: number }[] }).rows[0].n);
      const noDrift = async (why: string) => {
        const d = await measureLastInboundDrift(db);
        assert.ok(d.hasColumn && d.drift === 0 && d.readDrift === 0, `«chưa đọc» lưu sẵn lệch định nghĩa #803 sau: ${why} — ${JSON.stringify(d)}`);
      };
      type Listed = Extract<Awaited<ReturnType<typeof listInbox>>, { ok: true }>;
      const list = async (who: SessionUser, q: { filter: "ALL" | "UNREAD"; limit: number }, now?: Date): Promise<Listed> => {
        const r = await listInbox(who, q, now);
        if (!r.ok) throw new Error(`listInbox: ${r.error}`);
        return r;
      };
      const T0 = Date.now();

      // ═══ 1. MA TRẬN — dựng trước fixture lớn để mốc của chúng là mới nhất ═══
      // Ca chủ shop duyệt (PR #792): (a) CUSTOMER chưa xử lý ⇒ chưa đọc = e1 · (b) → AI trả lời hợp lệ ⇒ đã xử lý = e2 · (c) → nhân viên ERP /
      // page (người xác minh) trả lời ⇒ đã xử lý = e3 / e4 · (d) → người mở / đọc ⇒ đã xử lý = e5 (con trỏ đọc) / x7 (mốc mở cũ) · (e) → trả
      // lời hợp lệ → CUSTOMER MỚI ⇒ chưa đọc lại = e6 / e7. Tin tự động / chữ hệ thống của page KHÔNG xoá chưa đọc = x1 / x8 / x9 (+ tin
      // mẫu chéo luồng ở mục 4c). Mỗi ca so BỐN đường: cột lưu sẵn (trigger thật) · câu SQL hộp thư (listInbox) · hàm #803 tính trực tiếp ·
      // bản TS `latestTurnStateOf`.
      const matrix: { id: string; steps: Step[]; unread: boolean; badge: number; preview: "CUSTOMER" | "BOT" | "STAFF" | "PAGE" }[] = [
        { id: "e1", steps: ["C"], unread: true, badge: 1, preview: "CUSTOMER" },
        { id: "e2", steps: ["C", "AI"], unread: false, badge: 0, preview: "BOT" },
        { id: "e3", steps: ["C", "STAFF"], unread: false, badge: 0, preview: "STAFF" },
        { id: "e4", steps: ["C", "PAGE"], unread: false, badge: 0, preview: "PAGE" },
        { id: "e5", steps: ["C", "OPEN"], unread: false, badge: 0, preview: "CUSTOMER" },
        { id: "e6", steps: ["C", "AI", "C"], unread: true, badge: 1, preview: "CUSTOMER" },
        { id: "e7", steps: ["C", "STAFF", "C"], unread: true, badge: 1, preview: "CUSTOMER" },
        { id: "e8", steps: ["AI"], unread: false, badge: 0, preview: "BOT" },
        { id: "e9", steps: ["STAFF"], unread: false, badge: 0, preview: "STAFF" },
        { id: "e10", steps: ["PAGE"], unread: false, badge: 0, preview: "PAGE" },
        // Không phải câu trả lời: chữ hệ thống Facebook · tin chào ≤ 60 giây quanh tin khách mở phiên · tin nhân viên gửi HỎNG.
        { id: "x1", steps: ["C", "PAGE_SYS"], unread: true, badge: 1, preview: "CUSTOMER" },
        { id: "x2", steps: ["C", "GREETING"], unread: true, badge: 1, preview: "CUSTOMER" },
        { id: "x3", steps: ["C", "STAFF_FAILED"], unread: true, badge: 1, preview: "CUSTOMER" },
        // Đọc giữa lượt: hai tin khách → người mở → hai tin khách mới ⇒ chưa đọc, huy hiệu 2 (chỉ tin sau lượt đọc).
        { id: "x4", steps: ["C", "C", "OPEN", "C", "C"], unread: true, badge: 2, preview: "CUSTOMER" },
        // Mốc NGUỒN của tin khách muộn hơn mốc nhận 2 phút; câu bot tới SAU mốc nhận nhưng TRƯỚC mốc nguồn ⇒ theo thứ tự nguồn câu bot đứng trước.
        { id: "x5", steps: ["C_SKEW", "AI"], unread: true, badge: 1, preview: "CUSTOMER" },
        // Nhãn dán / ghi âm (MEDIA_ONLY) là lượt khách của hàng đợi người; mốc mở cũ (staff_seen_at) là «người đã mở».
        { id: "x6", steps: ["C_MEDIA"], unread: true, badge: 1, preview: "CUSTOMER" },
        { id: "x7", steps: ["C", "OPEN_LEGACY"], unread: false, badge: 0, preview: "CUSTOMER" },
        // Tin TỰ ĐỘNG của Pancake / chữ HỆ THỐNG Meta có nguồn gốc khai rõ (sender_kind, 0244) — không phải câu trả lời.
        { id: "x8", steps: ["C", "PAGE_AUTO"], unread: true, badge: 1, preview: "CUSTOMER" },
        { id: "x9", steps: ["C", "PAGE_META"], unread: true, badge: 1, preview: "CUSTOMER" },
      ];
      const mids: Record<string, string> = {};
      const convThread = new Map<string, string>();
      for (const [k, cs] of matrix.entries()) {
        const thread = `m-${cs.id}`;
        const [cv] = await db.insert(c).values({ channel: "FANPAGE", status: "OPEN", visitorKey: fanpageVisitorKey(PAGE, thread), pageId: PAGE, threadId: thread }).returning({ id: c.id });
        mids[cs.id] = cv.id;
        convThread.set(cv.id, thread);
        let at = T0 - 170 * MIN + k * 8 * MIN;
        for (const [i, step] of cs.steps.entries()) {
          if (step === "OPEN") {
            const th = await loadInboxThread(lan, cv.id);
            assert.ok(th.ok && th.thread.readThrough, `${cs.id}: payload mang tin khách cuối`);
            assert.ok((await markInboxReadCore(lan, cv.id, th.thread.readThrough.id)).ok, `${cs.id}: đánh dấu đọc`);
            continue;
          }
          if (step === "OPEN_LEGACY") {
            await db.update(c).set({ staffSeenAt: new Date(at + 30_000) }).where(eq(c.id, cv.id));
            continue;
          }
          at += step === "GREETING" ? 20_000 : step === "PAGE" || step === "PAGE_SYS" || step === "PAGE_AUTO" || step === "PAGE_META" ? 5 * MIN : 70_000;
          const staffId = `${thread}-${i}`;
          if (step === "STAFF_FAILED") await db.insert(schema.salesChatStaffMessages).values({ id: staffId, conversationId: cv.id, userId: lan.id, userName: "Lan CSKH", channel: "FANPAGE", text: "Dạ", status: "FAILED", requestKey: staffId });
          const customer = step === "C" || step === "C_SKEW" || step === "C_MEDIA";
          const note = step === "C_MEDIA" ? "MEDIA_ONLY" : customer ? null : step === "AI" ? "BOT_SENT" : PAGE_REPLY;
          const text = customer ? `Khách hỏi ${i}` : step === "PAGE_SYS" ? PAGE_SYSTEM_TEXT : step === "AI" ? "Dạ giá 280k ạ" : step === "GREETING" ? "Chào bạn, shop có thể giúp gì?" : step.startsWith("STAFF") ? "Dạ em gửi ảnh ạ" : step === "PAGE_AUTO" ? "Cảm ơn bạn đã nhắn tin, shop sẽ phản hồi sớm" : step === "PAGE_META" ? "Đã đánh dấu trạng thái đơn" : "Dạ em kiểm hàng";
          const senderKind = step === "PAGE_AUTO" ? "PANCAKE_AUTOMATION" : step === "PAGE_META" ? "META_SYSTEM" : undefined;
          const messageId = step === "STAFF" || step === "STAFF_FAILED" ? `${STAFF_OUT_PREFIX}${staffId}:0` : `${thread}-${i}`;
          await db.insert(t).values({ pageId: PAGE, threadId: thread, messageId, text, note, customerName: "Khách", status: "DONE", createdAt: new Date(at), ...(step === "C_SKEW" ? { sourceAt: new Date(at + 120_000) } : {}), ...(senderKind ? { senderKind } : {}) });
        }
      }
      // Chat web: khách → bot ⇒ đã xử lý; khách hỏi tiếp ⇒ chưa đọc.
      const [wv] = await db.insert(c).values({ channel: "WEB", status: "OPEN", visitorKey: "m-web" }).returning({ id: c.id });
      await db.insert(m).values({ conversationId: wv.id, seq: 1, role: "user", content: [{ type: "text", text: "Hỏi" }], createdAt: new Date(T0 - 9 * MIN) });
      await db.insert(m).values({ conversationId: wv.id, seq: 2, role: "assistant", content: [{ type: "text", text: "Đáp" }], createdAt: new Date(T0 - 8 * MIN) });
      for (const who of [admin, lan]) {
        const got = await list(who, { filter: "ALL", limit: 500 });
        for (const cs of matrix) {
          const r = got.rows.find((x) => x.id === mids[cs.id])!;
          assert.equal(r.unread, cs.unread, `ma trận ${cs.id} [${cs.steps.join("→")}] · ${who.name}: chưa đọc ${cs.unread ? "CÓ" : "KHÔNG"}`);
          assert.equal(r.unreadCount, cs.badge, `ma trận ${cs.id} · ${who.name}: huy hiệu = tin khách chưa xử lý`);
          assert.equal(r.previewSide, cs.preview, `P0-G ${cs.id} · ${who.name}: phía dòng xem trước`);
          const ts = await latestTurnStateOf(mids[cs.id]);
          assert.equal(ts !== null && !ts.handled, cs.unread, `ma trận ${cs.id}: bản TS của #803 cùng kết luận`);
          const [st] = await db.select({ cached: c.turnUnhandled, raw: latestCustomerTurnUnhandledSql() }).from(c).where(eq(c.id, mids[cs.id]));
          assert.equal(st.cached, cs.unread, `ma trận ${cs.id}: cột lưu sẵn (trigger CSDL thật) = ${cs.unread}`);
          assert.equal(Boolean(st.raw), cs.unread, `ma trận ${cs.id}: hàm #803 tính trực tiếp = ${cs.unread}`);
        }
        assert.equal(got.rows.find((x) => x.id === wv.id)!.unread, false, "chat web khách → bot ⇒ đã xử lý");
        assert.ok(got.rows.every((r) => !r.unread || r.previewSide === "CUSTOMER"), `${who.name}: không bao giờ «AI / NV / page: …» kèm huy hiệu`);
      }
      await db.insert(m).values({ conversationId: wv.id, seq: 3, role: "user", content: [{ type: "text", text: "Còn hàng?" }], createdAt: new Date(T0 - 7 * MIN) });
      const w2 = (await list(admin, { filter: "UNREAD", limit: 500 })).rows.find((x) => x.id === wv.id);
      assert.ok(w2 && w2.unread && w2.unreadCount === 1, "chat web: khách hỏi tiếp sau câu bot ⇒ chưa đọc, huy hiệu 1");
      await noDrift("ma trận");
      console.log("  ✓ ma trận chủ shop (a) CUSTOMER · (b) →AI · (c) →STAFF / →PAGE · (d) →MỞ / mốc mở cũ · (e) →AI→C / →STAFF→C · chỉ BOT/STAFF/PAGE + MEDIA_ONLY · chữ hệ thống · tin tự động Pancake / Meta (sender_kind) · tin chào · tin NV hỏng · đọc giữa lượt · lệch mốc nguồn · chat web — cột lưu sẵn (trigger) = SQL hộp thư = hàm #803 = TS, hai người");

      // ═══ 2. A → B + tin mới quay lại đầu + đua ═══
      const before = await list(admin, { filter: "UNREAD", limit: 100 });
      const A = mids.e1;
      const B = mids.x1;
      assert.ok(before.rows.some((r) => r.id === A) && before.rows.some((r) => r.id === B), "A và B cùng chưa đọc");
      const thA = await loadInboxThread(admin, A);
      assert.ok(thA.ok && thA.thread.readThrough);
      const readA = await markInboxReadCore(admin, A, thA.thread.readThrough.id);
      assert.ok(readA.ok && readA.read.unreadBefore === 1 && readA.read.unreadAfter === 0, `đọc A: ${JSON.stringify(readA)}`);
      const reads = new Map([[A, readA.read]]);
      const shown = inboxDisplayRows(before.rows, before.rows, { activeId: B, filter: "UNREAD", reads });
      assert.ok(!shown.some((r) => r.id === A), "A→B: A rời thẻ chưa đọc ngay trên bản cũ (vá lạc quan)");
      assert.equal(patchUnreadCount(before.counts.UNREAD, before.unreadStamp, reads.values()), before.counts.UNREAD - 1, "A→B: bộ đếm trừ 1 ngay");
      const after = await list(admin, { filter: "UNREAD", limit: 100 });
      assert.ok(!after.rows.some((r) => r.id === A) && after.counts.UNREAD === before.counts.UNREAD - 1, "bản máy chủ mới: A đã xử lý, bộ đếm −1");
      assert.ok(!(await list(lan, { filter: "UNREAD", limit: 100 })).rows.some((r) => r.id === A), "chủ shop đọc A ⇒ Lan cũng thấy đã xử lý");
      await db.insert(t).values({ pageId: PAGE, threadId: "m-e1", messageId: "m-e1-new", text: "Khách hỏi thêm", customerName: "Khách", status: "DONE" });
      await db.update(c).set({ lastCustomerAt: sql`now()` }).where(eq(c.id, A));
      const back = await list(admin, { filter: "ALL", limit: 100 });
      assert.equal(back.rows[0].id, A, "tin khách mới ⇒ A về đầu danh sách");
      assert.ok(back.rows[0].unread && back.rows[0].unreadCount === 1 && back.rows[0].preview === "Khách hỏi thêm", "A chưa đọc, xem trước đúng tin mới");
      await db.insert(t).values({ pageId: PAGE, threadId: "m-race", messageId: "m-race-1", text: "Báo giá?", status: "DONE", createdAt: new Date(T0 - 3 * MIN) });
      const [rv] = await db.insert(c).values({ channel: "FANPAGE", status: "OPEN", visitorKey: fanpageVisitorKey(PAGE, "m-race"), pageId: PAGE, threadId: "m-race" }).returning({ id: c.id });
      convThread.set(rv.id, "m-race");
      const thR = await loadInboxThread(lan, rv.id);
      assert.ok(thR.ok && thR.thread.readThrough);
      await db.insert(t).values({ pageId: PAGE, threadId: "m-race", messageId: "m-race-2", text: "Còn hàng không?", status: "DONE" });
      const mk = await markInboxReadCore(lan, rv.id, thR.thread.readThrough.id);
      assert.ok(mk.ok && mk.read.unreadAfter === 1, `tin khách ghi SAU lúc nạp ⇒ vẫn 1 chưa đọc: ${JSON.stringify(mk)}`);
      console.log("  ✓ A→B: A rời «Chưa đọc» ngay (vá lạc quan + bản máy chủ), bộ đếm −1, người khác cũng thấy · tin mới ⇒ A về đầu · đua: tin sau lúc nạp vẫn chưa đọc");

      // ═══ 3. PARITY trên fixture cỡ thật ═══
      const fx = buildInboxFixture({ seed: 11, conversations: N, t0: T0 - 4 * 3_600_000, cursorShare: [0.45, 0.1] });
      const ids = await seedInboxFixture(fx, PAGE, [admin.id, lan.id]);
      for (const [k, v] of ids) convThread.set(v, k);
      const msgs = await scalar(sql`select ((select count(*) from "sales_chat_inbound") + (select count(*) from "sales_chat_messages"))::int as n`);
      assert.ok(ids.size >= 3000 && msgs >= 25_000, `fixture cỡ thật: ${ids.size} hội thoại · ${msgs} tin`);
      await noDrift("gieo fixture");
      const now = new Date();
      const rows = await db
        .select({ id: c.id, cached: c.turnUnhandled, fast: INBOX_UNREAD_SQL, raw: latestCustomerTurnUnhandledSql(), n: INBOX_UNREAD_COUNT_SQL })
        .from(c)
        .where(ne(c.channel, "TEST"));
      assert.ok(rows.every((r) => r.cached !== null), "mọi hội thoại có kết quả lưu sẵn");
      const bad = rows.filter((r) => Boolean(r.fast) !== Boolean(r.raw));
      assert.deepEqual(bad.slice(0, 3), [], `lưu sẵn ≠ định nghĩa #803 tính trực tiếp ở ${bad.length} hội thoại`);
      assert.ok(rows.every((r) => Boolean(r.fast) === Number(r.n) > 0), "huy hiệu ≥ 1 ⇔ chưa đọc");
      const unreadN = rows.filter((r) => r.fast).length;
      assert.ok(unreadN > 200 && unreadN < rows.length - 300, `fixture có cả chưa đọc (${unreadN}) lẫn đã xử lý`);
      let tsBad = 0;
      for (const r of rows) {
        const st = await latestTurnStateOf(r.id, now);
        if (!st || st.handled === Boolean(r.fast)) tsBad += 1;
      }
      assert.equal(tsBad, 0, `lưu sẵn ≠ bản TS #803 ở ${tsBad} hội thoại`);
      const raw = latestCustomerTurnUnhandledSql();
      const [ref] = await db.select({ n: sql<number>`count(*) filter (where coalesce(${raw}, false))::int` }).from(c).where(ne(c.channel, "TEST"));
      for (const who of [admin, lan]) {
        for (const filter of ["ALL", "UNREAD"] as const) {
          const got = await list(who, { filter, limit: 100 }, now);
          assert.equal(got.counts.UNREAD, ref.n, `${who.name}/${filter}: thẻ «Tin khách chưa đọc» = hàm trần #803`);
          const want = await db
            .select({ id: c.id })
            .from(c)
            .where(and(ne(c.channel, "TEST"), ...(filter === "UNREAD" ? [sql`coalesce(${raw}, false)`] : [])))
            .orderBy(sql`coalesce(${raw}, false) desc`, desc(INBOX_ACTIVITY_SQL), desc(c.id))
            .limit(100);
          assert.deepEqual(
            got.rows.map((r) => r.id),
            want.map((r) => r.id),
            `${who.name}/${filter}: thứ tự 100 dòng đầu = hàm trần #803`,
          );
          assert.ok(got.rows.every((r) => r.unread === r.unreadCount > 0 && (!r.unread || r.previewSide === "CUSTOMER")), `${who.name}/${filter}: huy hiệu ⇔ cờ · xem trước tin khách khi chưa đọc`);
        }
      }
      console.log(`  ✓ parity: ${rows.length} hội thoại · ${msgs} tin — lưu sẵn ≡ hàm trần #803 ≡ bản TS từng hội thoại; listInbox thứ tự / thẻ = tham chiếu, hai người như nhau`);

      // ═══ 3b. CÔNG TẮC LÙI `inbox.unread.materialized` (settings NHÀ) — tắt ⇒ tính trực tiếp, cùng kết quả; bật lại ⇒ đọc cột ═══
      const dialect = new PgDialect();
      const textOf = (q: ReturnType<typeof sql>) => dialect.sqlToQuery(q).sql;
      const live = inboxUnreadSqlFor(false);
      for (const q of [live.unread, live.seenAt, live.pendingCount, live.count]) assert.doesNotMatch(textOf(q), /turn_unhandled|last_read_at/, "nhánh tính trực tiếp không nhắc tới cột 0245 (CSDL chưa có cột vẫn chạy)");
      assert.match(textOf(inboxUnreadSqlFor(true).unread), /turn_unhandled/, "nhánh lưu sẵn đọc cột");
      await forgetMemo("inbox-unread-switch");
      assert.equal(await inboxUnreadMaterialized(), true, "mặc định BẬT (chưa có dòng settings)");
      const pdb = await getPlatformDb();
      const sw = async (value: string) => {
        await pdb.insert(schema.settings).values({ key: INBOX_UNREAD_SWITCH_KEY, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } });
        await forgetMemo("inbox-unread-switch");
      };
      const pick = (r: Listed) => ({ counts: r.counts, rows: r.rows.map((x) => [x.id, x.unread, x.unreadCount, x.readCursorAt]) });
      const refAll = await list(admin, { filter: "ALL", limit: 100 }, now);
      const refUnread = await list(admin, { filter: "UNREAD", limit: 100 }, now);
      await sw(JSON.stringify({ enabled: false }));
      assert.equal(await inboxUnreadMaterialized(), false, "settings NHÀ {enabled:false} ⇒ tắt");
      assert.deepEqual(pick(await list(admin, { filter: "ALL", limit: 100 }, now)), pick(refAll), "TẮT: «Tất cả» (thẻ · thứ tự · cờ · huy hiệu · mốc mở) = bản đọc cột");
      assert.deepEqual(pick(await list(admin, { filter: "UNREAD", limit: 100 }, now)), pick(refUnread), "TẮT: «Chưa đọc» = bản đọc cột");
      const thSw = await loadInboxThread(lan, mids.x3);
      assert.ok(thSw.ok && thSw.thread.readThrough);
      const mkSw = await markInboxReadCore(lan, mids.x3, thSw.thread.readThrough.id);
      assert.ok(mkSw.ok && mkSw.read.unreadBefore === 1 && mkSw.read.unreadAfter === 0, `TẮT: xác nhận đọc đếm bằng hàm #803 trực tiếp: ${JSON.stringify(mkSw)}`);
      assert.equal((await list(admin, { filter: "UNREAD", limit: 100 }, now)).counts.UNREAD, refUnread.counts.UNREAD - 1, "TẮT: đọc ⇒ thẻ −1 (tính trực tiếp)");
      await sw(JSON.stringify({ enabled: "false" }));
      assert.equal(await inboxUnreadMaterialized(), true, "giá trị khác kiểu (chuỗi) không tắt được — không ép kiểu");
      await sw(JSON.stringify({ enabled: true }));
      assert.equal(await inboxUnreadMaterialized(), true, "bật lại");
      assert.equal((await list(admin, { filter: "UNREAD", limit: 100 }, now)).counts.UNREAD, refUnread.counts.UNREAD - 1, "BẬT lại: cột lưu sẵn đã theo kịp lượt đọc lúc tắt (trigger vẫn chạy)");
      await pdb.delete(schema.settings).where(eq(schema.settings.key, INBOX_UNREAD_SWITCH_KEY));
      await forgetMemo("inbox-unread-switch");
      console.log("  ✓ công tắc lùi inbox.unread.materialized: TẮT ⇒ tính trực tiếp bằng hàm #803 (không nhắc cột 0245) — thẻ / thứ tự / huy hiệu / mốc mở / xác nhận đọc y hệt; BẬT lại ⇒ cột đã theo kịp");

      // ═══ 4a. Audit ops ═══
      const col0 = await collectReadAudit(db, { limit: 3000, conversation: null, now });
      const audit = auditReadRows(col0.rows);
      assert.ok(col0.attentionMeasured && audit.attention.measured, "audit đo được luật vận hành");
      assert.equal(audit.attention.falseUnread, 0, "audit SAU: FALSE_UNREAD = 0");
      assert.equal(audit.attention.missed, 0, "audit SAU: không bỏ sót");
      assert.ok(audit.attention.v3FalseUnread > 100 && audit.attention.byReply > 0, `audit TRƯỚC: luật V3 báo chưa đọc dù đã xử lý (${JSON.stringify(audit.attention)})`);
      const d0 = await measureLastInboundDrift(db);
      assert.equal(d0.unreadCount, ref.n - 1, "UNREAD_COUNT_AFTER = số hội thoại chưa đọc (trừ x3 vừa đọc ở mục 3b)");
      assert.ok(d0.v3UnreadCount > (d0.unreadCount ?? 0), `UNREAD_COUNT_BEFORE (V3) ${d0.v3UnreadCount} > AFTER ${d0.unreadCount}`);
      console.log(`  ✓ audit ops: UNREAD_COUNT TRƯỚC ${d0.v3UnreadCount} → SAU ${d0.unreadCount} · FALSE_UNREAD TRƯỚC ${audit.attention.v3FalseUnread}/${audit.attention.v3Unread} → SAU 0/${audit.attention.unread}`);

      // ═══ 4b. Dẫn xuất của migration tất định ═══
      const mig = readFileSync(MIG, "utf8");
      const backfill = mig
        .split("--> statement-breakpoint")
        .map((x) => x.replace(/^\s*--.*$/gm, "").trim())
        .filter((x) => x.startsWith('UPDATE "sales_chat_conversations" c SET'));
      assert.equal(backfill.length, 1, "migration dẫn xuất bằng MỘT câu UPDATE (mốc đọc + kết quả #803)");
      await db.execute(sql`alter table "sales_chat_conversations" disable trigger "sales_chat_conversations_turn_upd"`);
      await db.execute(sql`update "sales_chat_conversations" set turn_unhandled = null, last_read_at = null`);
      await db.execute(sql`alter table "sales_chat_conversations" enable trigger "sales_chat_conversations_turn_upd"`);
      const broken = await measureLastInboundDrift(db);
      assert.ok(broken.drift > 500 && broken.readDrift > 500, `xoá cột ⇒ audit thấy lệch: ${JSON.stringify(broken)}`);
      for (const stmt of backfill) await db.execute(sql.raw(stmt));
      await noDrift("dẫn xuất của migration");
      for (const stmt of backfill) await db.execute(sql.raw(stmt));
      await noDrift("dẫn xuất chạy lần hai");

      // ═══ 4c. Lưu sẵn đúng sau MỌI đường ghi ═══
      const T = Date.now();
      const cached = async (id: string) => (await db.select({ v: c.turnUnhandled }).from(c).where(eq(c.id, id)))[0].v;
      const [cv] = await db.insert(c).values({ channel: "FANPAGE", status: "OPEN", visitorKey: fanpageVisitorKey(PAGE, "w-1"), pageId: PAGE, threadId: "w-1" }).returning({ id: c.id });
      assert.equal(await cached(cv.id), false, "hội thoại mới chưa có tin ⇒ không chưa đọc");
      await db.insert(t).values({ pageId: PAGE, threadId: "w-1", messageId: "w-1-c1", text: "Hỏi giá", status: "PENDING", createdAt: new Date(T - 20 * MIN) });
      assert.equal(await cached(cv.id), true, "tin khách ⇒ chưa đọc");
      await db.insert(t).values({ pageId: PAGE, threadId: "w-1", messageId: "w-1-b1", text: "Dạ", note: "BOT_SENT", status: "DONE", createdAt: new Date(T - 19 * MIN) });
      assert.equal(await cached(cv.id), true, "bot trả lời khi tin khách còn PENDING (bot chưa thấy) ⇒ vẫn chưa đọc");
      await db.update(t).set({ status: "DONE" }).where(eq(t.messageId, "w-1-c1"));
      assert.equal(await cached(cv.id), false, "tin khách hết PENDING ⇒ câu bot xử lý nó");
      await db.delete(t).where(eq(t.messageId, "w-1-b1"));
      assert.equal(await cached(cv.id), true, "xoá câu bot (gửi hỏng) ⇒ chưa đọc lại");
      // Tin nhân viên: SENDING ⇒ chưa tính; SENT ⇒ xử lý; FAILED ⇒ chưa đọc lại.
      await db.insert(schema.salesChatStaffMessages).values({ id: "w1-staff", conversationId: cv.id, userId: lan.id, userName: "Lan CSKH", channel: "FANPAGE", text: "Dạ", status: "SENDING", requestKey: "w1-staff" });
      await db.insert(t).values({ pageId: PAGE, threadId: "w-1", messageId: `${STAFF_OUT_PREFIX}w1-staff:0`, text: "Dạ ạ", note: PAGE_REPLY, status: "DONE", createdAt: new Date(T - 18 * MIN) });
      assert.equal(await cached(cv.id), true, "tin nhân viên đang gửi ⇒ chưa phải câu trả lời");
      await db.update(schema.salesChatStaffMessages).set({ status: "SENT" }).where(eq(schema.salesChatStaffMessages.id, "w1-staff"));
      assert.equal(await cached(cv.id), false, "tin nhân viên SENT ⇒ đã xử lý");
      await db.update(schema.salesChatStaffMessages).set({ status: "FAILED" }).where(eq(schema.salesChatStaffMessages.id, "w1-staff"));
      assert.equal(await cached(cv.id), true, "tin nhân viên FAILED ⇒ chưa đọc lại");
      // Mốc mở cũ / con trỏ đọc.
      await db.update(c).set({ staffSeenAt: new Date(T - 17 * MIN) }).where(eq(c.id, cv.id));
      assert.equal(await cached(cv.id), false, "staff_seen_at sau tin khách ⇒ người đã mở");
      await db.update(c).set({ staffSeenAt: null }).where(eq(c.id, cv.id));
      assert.equal(await cached(cv.id), true, "bỏ mốc mở ⇒ chưa đọc lại");
      const r = schema.salesChatReads;
      await db.insert(r).values({ conversationId: cv.id, userId: lan.id, readThroughAt: new Date(T - 20 * MIN) });
      assert.equal(await cached(cv.id), false, "con trỏ đọc tới tin khách ⇒ đã xử lý");
      await db.delete(r).where(and(eq(r.conversationId, cv.id), eq(r.userId, lan.id)));
      assert.equal(await cached(cv.id), true, "xoá con trỏ ⇒ chưa đọc lại");
      await noDrift("bot / nhân viên / mốc mở / con trỏ");
      // Tin mẫu CHÉO luồng: dòng page cũ (chưa sender_kind) chữ dài ở w-1 là câu trả lời KHÔNG RÕ ⇒ xử lý; một dòng cùng chữ ở luồng khác
      // trong 168 giờ TRƯỚC nó biến nó thành tin tự động ⇒ w-1 chưa đọc lại.
      const LONG = "Dạ shop xin chào, chị cần tư vấn mẫu nào ạ? Shop luôn sẵn sàng hỗ trợ chị nhé";
      await db.insert(t).values({ pageId: PAGE, threadId: "w-1", messageId: "w-1-p1", text: LONG, note: PAGE_REPLY, status: "DONE", createdAt: new Date(T - 5 * MIN) });
      assert.equal(await cached(cv.id), false, "page trả lời (chưa rõ người gửi, không phải tin chào) ⇒ đã xử lý");
      await db.insert(t).values({ pageId: PAGE, threadId: "w-other", messageId: "w-other-p1", text: `${LONG}  `, note: PAGE_REPLY, status: "DONE", createdAt: new Date(T - 3 * 86_400_000) });
      assert.equal(await cached(cv.id), true, "cùng chữ ở luồng khác 3 ngày trước ⇒ tin tự động ⇒ chưa đọc lại (trigger tính lại luồng bị ảnh hưởng)");
      await db.delete(t).where(eq(t.messageId, "w-other-p1"));
      assert.equal(await cached(cv.id), false, "xoá dòng mẫu ở luồng khác ⇒ đã xử lý lại");
      await noDrift("tin mẫu chéo luồng");
      // Hội thoại dựng SAU tin; đổi luồng; chat web.
      await db.insert(t).values({ pageId: PAGE, threadId: "w-3", messageId: "w-3-c1", text: "Chào shop", status: "DONE", createdAt: new Date(T - 4 * MIN) });
      const [cv3] = await db.insert(c).values({ channel: "FANPAGE", status: "OPEN", visitorKey: fanpageVisitorKey(PAGE, "w-3"), pageId: PAGE, threadId: "w-3" }).returning({ id: c.id });
      assert.equal(await cached(cv3.id), true, "hội thoại dựng sau tin ⇒ dẫn xuất từ sổ");
      await db.update(c).set({ threadId: "w-empty", visitorKey: fanpageVisitorKey(PAGE, "w-empty") }).where(eq(c.id, cv3.id));
      assert.equal(await cached(cv3.id), false, "đổi sang luồng rỗng ⇒ tính lại");
      const [wv2] = await db.insert(c).values({ channel: "WEB", status: "OPEN", visitorKey: "w-web2" }).returning({ id: c.id });
      await db.insert(m).values({ conversationId: wv2.id, seq: 1, role: "user", content: [{ type: "text", text: "Hỏi" }], createdAt: new Date(T - 3 * MIN) });
      assert.equal(await cached(wv2.id), true, "chat web: khách hỏi ⇒ chưa đọc");
      await db.insert(m).values({ conversationId: wv2.id, seq: 2, role: "assistant", content: [{ type: "tool_use", id: "x", name: "calc", input: {} }], createdAt: new Date(T - 2 * MIN) });
      assert.equal(await cached(wv2.id), true, "chat web: dòng assistant chỉ gọi công cụ chưa phải câu trả lời");
      await db.insert(m).values({ conversationId: wv2.id, seq: 3, role: "assistant", content: [{ type: "text", text: "Dạ" }], createdAt: new Date(T - MIN) });
      assert.equal(await cached(wv2.id), false, "chat web: câu trả lời có chữ ⇒ đã xử lý");
      await noDrift("mọi đường ghi");
      console.log("  ✓ lưu sẵn = định nghĩa #803 sau: tin khách / bot (PENDING · xoá) · tin nhân viên SENDING → SENT → FAILED · mốc mở cũ · con trỏ đọc · tin mẫu chéo luồng (thêm / xoá) · hội thoại dựng sau tin · đổi luồng · chat web; dẫn xuất migration tất định");
    });
  } finally {
    await cleanup();
  }
}

// ─────────────────────────── 5. Mã nguồn + thân hàm CSDL ───────────────────────────

/** Thân của một hàm `CREATE OR REPLACE FUNCTION "<tên>"(…) … AS $$ SELECT <thân>; $$` trong migration. */
function functionBody(mig: string, name: string): string {
  const start = mig.indexOf(`CREATE OR REPLACE FUNCTION "${name}"(`);
  assert.ok(start >= 0, `migration có hàm ${name}`);
  const open = mig.indexOf("$$", start) + 2;
  const close = mig.indexOf("$$", open);
  return normalizeSql(mig.slice(open, close)).replace(/^SELECT /, "").replace(/;$/, "");
}

function testSource() {
  const files = execFileSync("git", ["ls-files", "lib", "app", "scripts", "components", "db"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.(ts|tsx)$/.test(f));
  // Ba script ops CHỈ ĐỌC (Postgres ép `ERP_READ_ONLY`): audit sau triển khai + chạy thử trước 0245 (#809, chỉ nhắc tên cột trong chữ in)
  // + chẩn đoán migrate chậm (`org-migrate-probe`, chỉ hỏi information_schema xem cột 0245 đã có chưa)
  // + sổ tương thích lược đồ cũ (khai hai cột 0245 để mã TRÁNH chúng khi tổ chức đang DEGRADED_MIGRATION — không đọc, không ghi).
  const allowed = new Set(["db/schema.ts", "lib/sales-chatbot/inbox-unread.ts", "scripts/inbox-read-audit.ts", "scripts/inbox-unread-dryrun.ts", "scripts/org-migrate-probe.ts", "lib/constants/migration-serve-compat.ts", "scripts/inbox-perf-probe.ts"]);
  const touching = files.filter((f) => /turnUnhandled|turn_unhandled|lastReadAt|last_read_at/.test(readFileSync(f, "utf8")));
  assert.deepEqual(
    touching.filter((f) => !allowed.has(f)),
    [],
    "chỉ lược đồ + inbox-unread.ts + audit ops (chỉ đọc) nhắc tới hai cột (trigger CSDL là đường ghi duy nhất)",
  );
  const unread = readFileSync("lib/sales-chatbot/inbox-unread.ts", "utf8");
  assert.doesNotMatch(unread, /set\s+"?(turn_unhandled|last_read_at)|(turnUnhandled|lastReadAt)\s*:/i, "inbox-unread.ts chỉ đọc hai cột");
  assert.match(unread, /coalesce\(\$\{col\("turn_unhandled"\)\}, \$\{latestCustomerTurnUnhandledSql\(\)\}, false\)/, "chưa đọc = kết quả lưu sẵn, NULL ⇒ hàm của #803 (không luật thứ hai)");
  const inbox = readFileSync("lib/sales-chatbot/inbox.ts", "utf8");
  assert.doesNotMatch(inbox, /personalUnread|VIEWER_READ_ALIAS|HANDLED_AT|inboxUnreadSql\(/, "hộp thư không còn luật chưa đọc riêng");
  // P0 inbox-list-perf 13/10/2026: tính trực tiếp ⇒ tập «chưa đọc» dựng MỘT lần bằng đúng biểu thức đó (tests/inbox-list-perf.test.ts).
  assert.match(inbox, /const unreadSql = await loadInboxUnreadSql\(\);[\s\S]{0,2500}let unread: SQL<boolean> = unreadSql\.unread;/, "hộp thư lấy bộ biểu thức qua MỘT chỗ đọc công tắc");
  assert.equal((inbox.match(/loadInboxUnreadSql\(\)/g) ?? []).length, 1, "listInbox đọc công tắc đúng một lần");
  assert.equal((unread.match(/readInboxUnreadSwitch\(\)/g) ?? []).length, 1, "công tắc chỉ được đọc ở inboxUnreadMaterialized");
  const sw = readFileSync("lib/platform/inbox-unread-switch.ts", "utf8");
  assert.equal((sw.match(/eq\(schema\.settings\.key, INBOX_UNREAD_SWITCH_KEY\)/g) ?? []).length, 1, "khoá công tắc đọc đúng một chỗ (settings NHÀ)");
  const readers = execFileSync("git", ["ls-files", "lib", "app", "components"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.(ts|tsx)$/.test(f) && f !== "lib/platform/inbox-unread-switch.ts" && f !== "lib/sales-chatbot/inbox-unread.ts")
    .filter((f) => /readInboxUnreadSwitch|INBOX_UNREAD_SWITCH_KEY/.test(readFileSync(f, "utf8")));
  assert.deepEqual(readers, [], "không chỗ nào khác đọc công tắc");
  // Đối số thứ ba (P0 inbox-search-global 12/10/2026): khớp SĐT chính xác đứng đầu khi ô tìm là một SĐT đủ — khoá cờ vẫn gọi tên cột.
  assert.match(inbox, /orderBy\(\.\.\.inboxOrderBy\(q\.filter, sql<boolean>`"unread_flag"`, inboxSearchRankSql\(q\.q\)\)\)/, "khoá xếp gọi tên cột cờ");
  const body = inbox.slice(inbox.indexOf("export async function listInbox"), inbox.indexOf("export async function customerHistory"));
  assert.doesNotMatch(body, /selectDistinctOn/, "xem trước không còn DISTINCT ON đọc mọi dòng của luồng");
  assert.equal((body.match(/left join lateral/g) ?? []).length, 4, "xem trước: hai LATERAL LIMIT 1 cho mỗi loại kênh");
  assert.match(readFileSync("lib/sales-chatbot/inbox-read.ts", "utf8"), /const unreadCount = \(await loadInboxUnreadSql\(\)\)\.count;[\s\S]*n: unreadCount/, "xác nhận đọc trả số chưa đọc vận hành (cùng công tắc)");
  const mig = readFileSync(MIG, "utf8");
  // Thân hai hàm CSDL = ĐÚNG câu SQL hàm TS của #803 dựng ra — từng ký tự (sau khi gộp khoảng trắng).
  const want = renderTurnUnhandledSql();
  assert.equal(functionBody(mig, "sales_chat_turn_unhandled_thread"), normalizeSql(want.thread), "thân hàm CSDL kênh nhắn tin = latestCustomerTurnUnhandledFor của #803 (đổi #803 ⇒ migration mới)");
  assert.equal(functionBody(mig, "sales_chat_turn_unhandled_web"), normalizeSql(want.web), "thân hàm CSDL chat web = latestWebTurnUnhandledFor của #803");
  for (const name of ["sales_chat_inbound_turn", "sales_chat_staff_messages_turn", "sales_chat_messages_turn", "sales_chat_reads_turn", "sales_chat_conversations_turn_ins", "sales_chat_conversations_turn_upd"]) {
    assert.match(mig, new RegExp(`CREATE TRIGGER "${name}"`), `trigger ${name}`);
  }
  const backfillAt = mig.indexOf("-- Dẫn xuất TẤT ĐỊNH giá trị cũ");
  for (const name of ["sales_chat_inbound_turn", "sales_chat_staff_messages_turn", "sales_chat_messages_turn", "sales_chat_reads_turn"]) {
    assert.ok(mig.indexOf(`CREATE TRIGGER "${name}"`) < backfillAt, `trigger bảng nguồn ${name} TRƯỚC dẫn xuất (khoá ghi tới commit)`);
  }
  assert.ok(mig.indexOf('ALTER TABLE "sales_chat_conversations"') < backfillAt, "ALTER TABLE hội thoại (ACCESS EXCLUSIVE tới commit) TRƯỚC dẫn xuất");
  assert.ok(mig.indexOf('CREATE TRIGGER "sales_chat_conversations_turn_upd"') > backfillAt, "trigger hội thoại SAU dẫn xuất (không tính hai lần)");
  // An toàn production: SET LOCAL ở ĐẦU tệp (drizzle chạy mọi migration còn thiếu trong MỘT giao dịch), trả về mặc định ở CUỐI.
  const stmts = mig
    .split("--> statement-breakpoint")
    .map((x) => x.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
  assert.deepEqual(stmts.slice(0, 2), ["SET LOCAL lock_timeout = '10s';", "SET LOCAL statement_timeout = '600s';"], "lock_timeout / statement_timeout đặt trước ALTER TABLE");
  assert.deepEqual(stmts.slice(-2), ["SET LOCAL lock_timeout = DEFAULT;", "SET LOCAL statement_timeout = DEFAULT;"], "trả tham số về mặc định để migration sau không bị trần");
  const dialectSrc = readFileSync("node_modules/drizzle-orm/pg-core/dialect.js", "utf8");
  const migrateAt = dialectSrc.indexOf("async migrate(");
  assert.ok(migrateAt >= 0 && /session\.transaction\(/.test(dialectSrc.slice(migrateAt, migrateAt + 1500)), "drizzle migrator chạy migration trong giao dịch ⇒ SET LOCAL có hiệu lực");
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { tag: string }[] };
  assert.ok(journal.entries.some((e) => e.tag === "0245_sales_chat_last_inbound"), "sổ migration có 0245");
  assert.equal(PAGE_REPLY, "PAGE_REPLY");
  console.log("  ✓ mã nguồn: không đường TS nào ghi hai cột · hộp thư đọc kết quả lưu sẵn (NULL ⇒ hàm #803) · thân hàm CSDL = câu SQL của #803 từng ký tự · trigger 0245");
}

export async function testInboxUnreadPerf() {
  console.log("Hộp thư — tin khách chưa đọc = lượt khách mới nhất chưa xử lý (#803), lưu sẵn (inbox-unread-perf):");
  testSource();
  await testDb();
}

if (process.argv[1] && /inbox-unread-perf\.test\.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testInboxUnreadPerf)
    .then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
}

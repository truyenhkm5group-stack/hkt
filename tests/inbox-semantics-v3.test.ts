/**
 * ═══════════ INBOX-SEMANTICS-V3: BỐN KHÁI NIỆM TÁCH RIÊNG · MA TRẬN XÁC ĐỊNH (chủ shop 10/10/2026, mục B · C · G) ═══════════
 *
 * Chủ shop: «Bộ lọc có vấn đề và logic hiển thị danh sách cũng có vấn đề». Bài kiểm dựng MỘT ma trận hội thoại phủ mọi tổ hợp
 * (khách nhắn → AI trả lời chưa ai mở · người đã mở · khách nhắn nối sau AI · tiếp quản · AI nhường sau câu tay · AI gợi ý · AI hỏng ·
 * AI xin người · đơn cần kiểm · đã chốt · lịch sử nhập · tin phía page ngoài ERP · chat web · có / không SĐT · hai page · nhiều ngày)
 * rồi với TỪNG bộ lọc khẳng định: SỐ ĐẾM = số dòng · ĐÚNG tập hội thoại (không thừa, không thiếu, không trùng) · ĐÚNG thứ tự.
 *
 *  · Kỳ vọng của từng hội thoại viết TAY (đặc tả), rồi so với cả hàm thuần (`classifyInboxState`) lẫn điều kiện SQL (`listInbox`).
 *  · Mốc thời gian đi theo đồng hồ THẬT (AGENTS mục 50) — bộ lọc ngày tính kỳ vọng từ chính dữ liệu bằng `inboxPeriodRange`.
 *  · Đổi nhãn / đổi người phụ trách / đổi chế độ AI KHÔNG đổi thứ tự; AI trả lời KHÔNG xoá «chưa đọc»; MỞ hội thoại mới xoá.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { AI_DOWN_HANDOFF_REASON, FANPAGE_STAFF_REASON } from "@/lib/sales-chatbot/ai-hold-shared";
import { setConversationControlCore } from "@/lib/sales-chatbot/conversation-control";
import { TAKEOVER_REASON } from "@/lib/sales-chatbot/conversation-control-shared";
import { fanpageVisitorKey, PAGE_REPLY } from "@/lib/sales-chatbot/fanpage";
import { HISTORY_CREATED_BY } from "@/lib/sales-chatbot/history-shared";
import { assignConversationCore, claimConversationCore, inboxPeriodRange, listInbox, loadInboxThread } from "@/lib/sales-chatbot/inbox";
import { createLabelCore, setConversationLabelsCore } from "@/lib/sales-chatbot/inbox-labels";
import { INBOX_FILTERS, inboxRowStatus, type InboxFilter, type InboxPeriod, type InboxRow } from "@/lib/sales-chatbot/inbox-shared";
import { classifyInboxState, inboxHandlingFrom, ORDER_UNDER_REVIEW_SQL, PAGE_REPLY_AFTER_CUSTOMER_SQL, WEB_STAFF_REASON, type HumanHandling, type InboxReplying, type NeedsHumanCode } from "@/lib/sales-chatbot/inbox-states";
import { OPERATING_MODE_SETTING_KEY } from "@/lib/sales-chatbot/operating-mode-shared";

const ORG = "hop-thu-sem-v3";
const PA = "pg-sem-a";
const PB = "pg-sem-b";
const MIN = 60_000;
const DAY = 86_400_000;

type Expect = { unread: boolean; waiting: boolean; needs: NeedsHumanCode | null; human: HumanHandling | null; replying: InboxReplying; phone: boolean; page: string | null; unreadN: number };
type Spec = { id: string; note: string; v: Partial<typeof schema.salesChatConversations.$inferInsert>; inbound?: { at: number; note?: string; text?: string; imported?: boolean }[]; order?: { stage: "NEW" | "CANCELLED"; review: boolean }; e: Expect };

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

export async function testInboxSemanticsV3() {
  await cleanup();
  try {
    await provisionOrganization({ code: ORG, name: "Shop hộp thư nghĩa V3", plan: "standard", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "Chủ shop", password: "HopThu@123456" }, source: "TEST", actor: null });
    const enabled = await getEnabledModules(ORG);
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const admin = { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: ORG, isHome: false }, modules: [...enabled] } as unknown as SessionUser;
      const c = schema.salesChatConversations;
      const T0 = Date.now();
      const at = (msAgo: number) => new Date(T0 - msAgo);
      const ctl = (mode: "HUMAN" | "COPILOT") => ({ control: { mode, byUserId: admin.id, byName: "Chủ shop", at: at(90 * MIN).toISOString(), reason: null } });
      const E = (o: Partial<Expect> & Pick<Expect, "page">): Expect => ({ unread: false, waiting: false, needs: null, human: null, replying: "AI", phone: false, unreadN: 0, ...o });

      // ═══ MA TRẬN — mỗi hội thoại một tình huống; kỳ vọng viết tay ═══
      const specs: Spec[] = [
        { id: "s01", note: "khách «xin giá» → AI «Dạ giá 280k…», chưa ai mở", v: { pageId: PA, lastCustomerAt: at(10 * MIN), lastBotAt: at(9 * MIN) }, inbound: [{ at: 10 * MIN }, { at: 9 * MIN, note: "BOT_SENT" }], e: E({ page: PA, unread: true, unreadN: 1 }) },
        { id: "s02", note: "khách nhắn, người đã mở, chưa ai trả lời", v: { pageId: PA, lastCustomerAt: at(20 * MIN), staffSeenAt: at(19 * MIN) }, inbound: [{ at: 20 * MIN }], e: E({ page: PA, waiting: true }) },
        { id: "s03", note: "khách nhắn nối SAU câu AI, chưa ai mở, có SĐT", v: { pageId: PA, lastCustomerAt: at(5 * MIN), lastBotAt: at(32 * MIN), customerPhone: "0912000003" }, inbound: [{ at: 35 * MIN }, { at: 32 * MIN, note: "BOT_SENT" }, { at: 5 * MIN }], e: E({ page: PA, unread: true, waiting: true, phone: true, unreadN: 2 }) },
        { id: "s04", note: "nhân viên TIẾP QUẢN, đã trả lời", v: { pageId: PB, status: "HANDOFF", handoffReason: TAKEOVER_REASON, state: ctl("HUMAN"), lastCustomerAt: at(40 * MIN), staffSeenAt: at(39 * MIN), lastStaffAt: at(38 * MIN) }, e: E({ page: PB, human: "MANUAL_TAKEOVER", replying: "HUMAN" }) },
        { id: "s05", note: "AI NHƯỜNG sau câu tay (còn hạn)", v: { pageId: PB, status: "HANDOFF", handoffReason: FANPAGE_STAFF_REASON, humanCooldownUntil: at(-20 * MIN), lastCustomerAt: at(12 * MIN), lastStaffAt: at(10 * MIN) }, e: E({ page: PB, human: "STAFF_COOLDOWN", replying: "HUMAN" }) },
        { id: "s06", note: "AI nhường, khách nhắn tiếp SAU câu nhân viên", v: { pageId: PA, status: "HANDOFF", handoffReason: FANPAGE_STAFF_REASON, humanCooldownUntil: at(-25 * MIN), lastStaffAt: at(5 * MIN), lastCustomerAt: at(2 * MIN) }, inbound: [{ at: 6 * MIN }, { at: 2 * MIN }], e: E({ page: PA, unread: true, waiting: true, human: "STAFF_COOLDOWN", replying: "HUMAN", unreadN: 1 }) },
        { id: "s07", note: "AI nhường đã HẾT HẠN (chưa dọn) ⇒ AI", v: { pageId: PA, status: "HANDOFF", handoffReason: FANPAGE_STAFF_REASON, humanCooldownUntil: at(MIN), lastStaffAt: at(60 * MIN), lastCustomerAt: at(50 * MIN), staffSeenAt: at(45 * MIN) }, e: E({ page: PA, waiting: true }) },
        { id: "s08", note: "AI GỢI Ý (copilot), chưa ai mở", v: { pageId: PB, state: ctl("COPILOT"), lastCustomerAt: at(15 * MIN) }, inbound: [{ at: 15 * MIN }], e: E({ page: PB, unread: true, waiting: true, human: "COPILOT", replying: "HUMAN", unreadN: 1 }) },
        { id: "s09", note: "AI HỎNG (đang chờ thử lại) ⇒ cần người, không ai cầm", v: { pageId: PA, status: "HANDOFF", handoffReason: AI_DOWN_HANDOFF_REASON, updatedAt: at(5 * MIN), lastCustomerAt: at(6 * MIN) }, inbound: [{ at: 6 * MIN }], e: E({ page: PA, unread: true, waiting: true, needs: "AI_DOWN", replying: "NOBODY", unreadN: 1 }) },
        { id: "s10", note: "AI hỏng đã quá khoảng chờ ⇒ AI tự thử lại", v: { pageId: PB, status: "HANDOFF", handoffReason: AI_DOWN_HANDOFF_REASON, updatedAt: at(40 * MIN), lastCustomerAt: at(41 * MIN), staffSeenAt: at(40 * MIN) }, e: E({ page: PB, waiting: true }) },
        { id: "s11", note: "AI XIN NGƯỜI (khách đòi gặp người), có SĐT, chưa ai cầm", v: { pageId: PB, status: "HANDOFF", handoffReason: "Khách đòi gặp người", lastCustomerAt: at(25 * MIN), lastBotAt: at(24 * MIN), customerPhone: "0912000011" }, inbound: [{ at: 25 * MIN }], e: E({ page: PB, unread: true, needs: "AI_HANDOFF", replying: "NOBODY", phone: true, unreadN: 1 }) },
        { id: "s12", note: "AI xin người, nhân viên ĐÃ trả lời (nhường còn hạn) — vẫn cần người quyết, người đang cầm", v: { pageId: PA, status: "HANDOFF", handoffReason: "Khách nhắn sau khi đã chốt đơn — nhân viên xử lý", humanCooldownUntil: at(-10 * MIN), lastStaffAt: at(3 * MIN), lastCustomerAt: at(8 * MIN), staffSeenAt: at(3 * MIN), orderId: "erp-sem-12" }, e: E({ page: PA, needs: "AI_HANDOFF", human: "STAFF_COOLDOWN", replying: "HUMAN" }) },
        { id: "s13", note: "đơn của hội thoại mang cờ CẦN NGƯỜI KIỂM (khách báo huỷ), AI vẫn chạy", v: { pageId: PA, lastCustomerAt: at(60 * MIN), lastBotAt: at(59 * MIN), staffSeenAt: at(58 * MIN) }, order: { stage: "NEW", review: true }, e: E({ page: PA, needs: "ORDER_REVIEW" }) },
        { id: "s14", note: "cờ cần kiểm trên đơn ĐÃ HUỶ ⇒ không còn việc", v: { pageId: PB, lastCustomerAt: at(70 * MIN), staffSeenAt: at(69 * MIN) }, order: { stage: "CANCELLED", review: true }, e: E({ page: PB, waiting: true }) },
        { id: "s15", note: "đã chốt (đơn ERP + level) hai ngày trước, đã xem", v: { pageId: PA, orderId: "erp-sem-15", customerLevel: "ORDERED", lastCustomerAt: at(2 * DAY), lastBotAt: at(2 * DAY - MIN), staffSeenAt: at(2 * DAY - 2 * MIN), customerPhone: "0912000015" }, e: E({ page: PA, phone: true }) },
        { id: "s16", note: "chỉ có LỊCH SỬ nhập (ba ngày trước)", v: { pageId: PB, createdBy: HISTORY_CREATED_BY, historyUntil: at(3 * DAY), lastCustomerAt: at(3 * DAY), staffSeenAt: at(3 * DAY) }, inbound: [{ at: 3 * DAY, imported: true }], e: E({ page: PB }) },
        { id: "s17", note: "nhân viên trả lời trên PANCAKE (tin phía page) ⇒ AI nhường; người trong ERP chưa mở", v: { pageId: PB, status: "HANDOFF", handoffReason: FANPAGE_STAFF_REASON, humanCooldownUntil: at(-12 * MIN), lastCustomerAt: at(18 * MIN) }, inbound: [{ at: 18 * MIN }, { at: 17 * MIN, note: PAGE_REPLY }], e: E({ page: PB, unread: true, human: "STAFF_COOLDOWN", replying: "HUMAN", unreadN: 1 }) },
        { id: "s18", note: "chat WEB, nhân viên đang trả lời (chờ người trả lại)", v: { channel: "WEB", status: "HANDOFF", handoffReason: WEB_STAFF_REASON, lastCustomerAt: at(33 * MIN), lastStaffAt: at(32 * MIN) }, e: E({ page: null, human: "STAFF_COOLDOWN", replying: "HUMAN" }) },
        { id: "s19", note: "HANDOFF không lý do (AI / công cụ xin người)", v: { pageId: PA, status: "HANDOFF", handoffReason: null, lastCustomerAt: at(7 * MIN) }, inbound: [{ at: 7 * MIN }], e: E({ page: PA, unread: true, waiting: true, needs: "AI_HANDOFF", replying: "NOBODY", unreadN: 1 }) },
        { id: "s20", note: "hôm qua: khách nhắn, AI trả lời, chưa ai mở", v: { pageId: PB, lastCustomerAt: at(DAY + 30 * MIN), lastBotAt: at(DAY + 29 * MIN) }, inbound: [{ at: DAY + 30 * MIN }, { at: DAY + 29 * MIN, note: "BOT_SENT" }], e: E({ page: PB, unread: true, unreadN: 1 }) },
      ];

      for (const s of specs) {
        const channel = s.v.channel ?? "FANPAGE";
        const thread = channel === "FANPAGE" ? `t-${s.id}` : null;
        await db.insert(c).values({ id: s.id, channel, status: "OPEN", visitorKey: thread ? fanpageVisitorKey(String(s.v.pageId), thread) : `web-${s.id}`, threadId: thread, createdAt: at(5 * DAY), updatedAt: at(90 * MIN), ...s.v });
        for (const [i, m] of (s.inbound ?? []).entries()) {
          await db.insert(schema.salesChatInbound).values({ pageId: String(s.v.pageId), threadId: thread!, messageId: `${s.id}-${i}`, text: m.note === "BOT_SENT" ? "Dạ giá 280k ạ" : m.note === PAGE_REPLY ? "Dạ em kiểm hàng" : "Xin giá", note: m.note ?? null, customerName: `Khách ${s.id}`, status: "DONE", processedAt: at(m.at), createdAt: at(m.at), importedAt: m.imported ? at(m.at) : null });
        }
        if (s.order) {
          const review = s.order.review ? { entries: [{ code: "CUSTOMER_CANCELLED", note: "Khách báo huỷ", quote: "thôi em không lấy nữa", at: at(61 * MIN).toISOString(), by: "Bot" }] } : null;
          await db.insert(schema.orders).values({ id: `erp-sem-${s.id}`, stage: s.order.stage, status: s.order.stage === "CANCELLED" ? 6 : 0, salesConversationId: s.id, insertedAt: at(62 * MIN), raw: review ? { review } : {} });
        }
      }
      const byId = new Map(specs.map((s) => [s.id, s]));
      const now = new Date(T0);

      // ═══ 1. HÀM THUẦN = đặc tả, trên từng hội thoại (đọc lại đúng dòng đã ghi) ═══
      const dbRows = await db
        .select({ row: c, pageReply: PAGE_REPLY_AFTER_CUSTOMER_SQL, review: ORDER_UNDER_REVIEW_SQL })
        .from(c)
        .where(inArray(c.id, specs.map((s) => s.id)));
      assert.equal(dbRows.length, specs.length);
      for (const { row, pageReply, review } of dbRows) {
        const cls = classifyInboxState({ ...row, pageReplyAfterCustomer: Boolean(pageReply), orderUnderReview: Boolean(review) }, now, false);
        const e = byId.get(row.id)!.e;
        assert.deepEqual(
          { unread: cls.humanUnread, waiting: cls.waitingReply, needs: cls.needsHuman, human: cls.humanHandling, replying: cls.replying },
          { unread: e.unread, waiting: e.waiting, needs: e.needs, human: e.human, replying: e.replying },
          `hàm thuần ≠ đặc tả ở ${row.id} (${byId.get(row.id)!.note})`,
        );
      }

      // ═══ 2. MỖI bộ lọc: số đếm · tập dòng · không trùng · thứ tự ═══
      const activityOf = (s: Spec) => Math.max(...[s.v.lastCustomerAt, s.v.lastBotAt, s.v.lastStaffAt, s.v.historyUntil].map((d) => (d instanceof Date ? d.getTime() : 0)), s.v.createdBy === HISTORY_CREATED_BY ? 0 : T0 - 5 * DAY);
      const defaultOrder = (xs: Spec[]) => [...xs].sort((a, b) => Number(b.e.unread) - Number(a.e.unread) || activityOf(b) - activityOf(a) || (a.id < b.id ? 1 : -1)).map((s) => s.id);
      const waitOrder = (xs: Spec[]) => [...xs].sort((a, b) => (a.v.lastCustomerAt as Date).getTime() - (b.v.lastCustomerAt as Date).getTime() || (a.id < b.id ? -1 : 1)).map((s) => s.id);
      // Phân công trước khi đo: s02 · s11 về admin («Của tôi»), còn lại chưa ai nhận.
      await db.update(c).set({ assigneeUserId: admin.id }).where(inArray(c.id, ["s02", "s11"]));
      const mine = new Set(["s02", "s11"]);
      const closed = new Set(["s12", "s13", "s14", "s15"]);
      const pred: Record<InboxFilter, (s: Spec) => boolean> = {
        ALL: () => true,
        UNREAD: (s) => s.e.unread,
        UNANSWERED: (s) => s.e.waiting,
        NEEDS_HUMAN: (s) => s.e.needs !== null,
        AI: (s) => s.e.replying === "AI",
        HUMAN: (s) => s.e.replying === "HUMAN",
        MINE: (s) => mine.has(s.id),
        UNASSIGNED: (s) => !mine.has(s.id) && (s.e.needs !== null || s.e.waiting),
        ORDERED: (s) => closed.has(s.id),
        NOT_ORDERED: (s) => !closed.has(s.id),
      };
      const check = async (label: string, query: Record<string, unknown>, keep: (s: Spec) => boolean, filter: InboxFilter = "ALL") => {
        const r = await listInbox(admin, { ...query, filter, limit: 500 }, now);
        assert.ok(r.ok, JSON.stringify(r));
        const ids = r.rows.map((x) => x.id);
        const want = specs.filter((s) => keep(s) && pred[filter](s));
        assert.equal(new Set(ids).size, ids.length, `${label}: không trùng`);
        assert.deepEqual(ids, filter === "UNANSWERED" ? waitOrder(want) : defaultOrder(want), `${label}: đúng tập + đúng thứ tự`);
        assert.equal(r.total, ids.length, `${label}: số đếm = số dòng`);
        assert.equal(r.counts[filter], ids.length, `${label}: thẻ ${filter} đếm đúng`);
        return r;
      };
      const all = await check("Tất cả", {}, () => true);
      assert.ok(all.ok);
      for (const f of INBOX_FILTERS) {
        const r = await check(`thẻ ${f}`, {}, () => true, f);
        assert.ok(r.ok && r.counts[f] === all.counts[f], `thẻ ${f}: số trên thẻ (đếm ở «Tất cả») = số dòng khi bấm thẻ`);
      }
      // Huy hiệu từng hàng = đặc tả (một hàm phân loại).
      for (const row of all.rows) {
        const e = byId.get(row.id)!.e;
        assert.equal(row.unread, e.unread, `${row.id}: cờ chưa đọc`);
        assert.equal(row.unreadCount, e.unread ? Math.max(1, e.unreadN) : 0, `${row.id}: số chưa đọc`);
        assert.equal(row.waitingSince !== null, e.waiting, `${row.id}: chờ trả lời`);
        assert.equal(row.needsHuman, e.needs, `${row.id}: lý do cần người`);
        assert.equal(row.humanHandling, e.human, `${row.id}: người đang cầm`);
        assert.equal(row.handling, inboxHandlingFrom({ humanHandling: e.human, replying: e.replying }), `${row.id}: huy hiệu AI / người`);
        assert.equal(inboxRowStatus(row)?.kind === "NEEDS_HUMAN", e.needs !== null, `${row.id}: nhãn «Cần người» trên hàng ≡ thẻ «Cần người»`);
      }
      assert.ok(all.rows.filter((r) => r.status === "HANDOFF" && !r.needsHuman).length >= 5, "có ≥ 5 hội thoại HANDOFF KHÔNG phải «Cần người» (tiếp quản / nhường) — phép kiểm có nghĩa");
      assert.equal(all.counts.AI + all.counts.HUMAN + all.rows.filter((r) => r.handling === "WAITING").length, all.counts.ALL, "AI + Người + Chờ người phủ kín");

      // Lọc ngang: AI / người (xl) · SĐT · page · ngày.
      await check("xl=AI", { handler: "AI" }, (s) => s.e.replying === "AI");
      await check("xl=người", { handler: "HUMAN" }, (s) => s.e.replying === "HUMAN");
      await check("Có SĐT", { phone: "HAS" }, (s) => s.e.phone);
      await check("Chưa SĐT", { phone: "NONE" }, (s) => !s.e.phone);
      await check(`page ${PA}`, { page: PA }, (s) => s.e.page === PA);
      await check(`page ${PB}`, { page: PB }, (s) => s.e.page === PB);
      const inPeriod = (period: InboxPeriod, from: string | null = null, to: string | null = null) => {
        const range = inboxPeriodRange({ period, from, to }, now)!;
        return (s: Spec) => (!range.from || activityOf(s) >= range.from.getTime()) && (!range.to || activityOf(s) < range.to.getTime());
      };
      for (const p of ["TODAY", "YESTERDAY", "7D", "30D"] as const) await check(`tg=${p}`, { period: p }, inPeriod(p));
      const vnDay = (ms: number) => new Date(ms + 7 * 3_600_000).toISOString().slice(0, 10);
      const customFrom = vnDay(T0 - 3 * DAY);
      const customTo = vnDay(T0 - 2 * DAY);
      await check("tg=CUSTOM", { period: "CUSTOM", from: customFrom, to: customTo }, inPeriod("CUSTOM", customFrom, customTo));
      // Tổ hợp nâng cao.
      await check(`page ${PA} + Chưa đọc`, { page: PA }, (s) => s.e.page === PA, "UNREAD");
      await check(`page ${PB} + Cần người`, { page: PB }, (s) => s.e.page === PB, "NEEDS_HUMAN");
      await check("Có SĐT + Cần người", { phone: "HAS" }, (s) => s.e.phone, "NEEDS_HUMAN");
      await check("xl=người + Chờ trả lời", { handler: "HUMAN" }, (s) => s.e.replying === "HUMAN", "UNANSWERED");
      await check("7 ngày + Chờ trả lời", { period: "7D" }, inPeriod("7D"), "UNANSWERED");
      await check("chưa ai nhận + AI", { assignee: "none" }, (s) => !mine.has(s.id), "AI");
      await check(`page ${PA} + xl=AI + Chưa SĐT`, { page: PA, handler: "AI", phone: "NONE" }, (s) => s.e.page === PA && s.e.replying === "AI" && !s.e.phone);
      // Ba nhóm cần biết của chủ shop, nói bằng số.
      const cnt = (f: InboxFilter) => all.counts[f];
      console.log(`  ✓ ma trận ${specs.length} hội thoại · ${INBOX_FILTERS.length} thẻ + 18 lọc ngang / tổ hợp: Chưa đọc ${cnt("UNREAD")} · Chờ trả lời ${cnt("UNANSWERED")} · Cần người ${cnt("NEEDS_HUMAN")} · Người đang xử lý ${cnt("HUMAN")} · AI ${cnt("AI")}`);

      // ═══ 3. Nhãn · người phụ trách · chế độ AI KHÔNG đổi thứ tự ═══
      const orderNow = async () => {
        const r = await listInbox(admin, { limit: 500 }, now);
        assert.ok(r.ok);
        return r.rows.map((x) => x.id);
      };
      const before = await orderNow();
      const lb = await createLabelCore(admin, { name: "Khách sỉ", color: "blue" });
      assert.ok(lb.ok, JSON.stringify(lb));
      assert.ok((await setConversationLabelsCore(admin, "s20", [lb.label.id])).ok, "gắn nhãn hội thoại cuối danh sách");
      assert.ok((await claimConversationCore(admin, "s16")).ok, "nhận hội thoại");
      assert.ok((await assignConversationCore(admin, "s07", admin.id)).ok, "giao hội thoại");
      // Mở / sửa hồ sơ khách và cột siêu dữ liệu của hội thoại (đẩy `updated_at`) — không phải tin.
      const [cus] = await db.insert(schema.customers).values({ name: "Khách s15", phone: "0912000015" }).returning({ id: schema.customers.id });
      await db.update(c).set({ customerId: cus.id, customerLevel: "PHONE_ONLY", levelAt: new Date() }).where(eq(c.id, "s15"));
      await db.update(schema.customers).set({ name: "Đổi tên hồ sơ" }).where(eq(schema.customers.id, cus.id));
      assert.deepEqual(await orderNow(), before, "nhãn / người phụ trách / siêu dữ liệu KHÔNG đổi chỗ hội thoại");

      // ═══ 4. AI trả lời KHÔNG xoá chưa đọc; MỞ hội thoại mới xoá ═══
      const rowOf = async (id: string): Promise<InboxRow> => {
        const r = await listInbox(admin, { limit: 500 }, now);
        assert.ok(r.ok);
        return r.rows.find((x) => x.id === id)!;
      };
      await db.insert(schema.salesChatInbound).values({ pageId: PA, threadId: "t-s01", messageId: "s01-bot2", text: "Dạ chị cần size nào ạ?", note: "BOT_SENT", status: "DONE", processedAt: at(MIN), createdAt: at(MIN) });
      await db.update(c).set({ lastBotAt: at(MIN) }).where(eq(c.id, "s01"));
      const s01 = await rowOf("s01");
      assert.ok(s01.unread && s01.unreadCount === 1, `AI trả lời thêm ⇒ VẪN chưa đọc, bộ đếm giữ nguyên: ${JSON.stringify({ u: s01.unread, n: s01.unreadCount })}`);
      const opened = await loadInboxThread(admin, "s01", now);
      assert.ok(opened.ok);
      const s01b = await rowOf("s01");
      assert.ok(!s01b.unread && s01b.unreadCount === 0, "mở hội thoại ⇒ đã đọc, bộ đếm 0");
      const after = await orderNow();
      const unreadNow = await listInbox(admin, { filter: "UNREAD", limit: 500 }, now);
      assert.ok(unreadNow.ok && !unreadNow.rows.some((r) => r.id === "s01") && unreadNow.counts.UNREAD === all.counts.UNREAD - 1, "thẻ «Chưa đọc» bớt đúng một");
      assert.ok(after.indexOf("s01") >= unreadNow.counts.UNREAD, "đã đọc ⇒ máy chủ xếp nó vào nhóm đã đọc (trình duyệt giữ hàng ĐANG MỞ tại chỗ — keepActiveInPlace — tới khi chuyển hội thoại)");
      // Nhân viên trả lời từ ERP = đã thấy: tiếp quản rồi trả lời ⇒ s03 hết chưa đọc.
      await db.update(c).set({ lastStaffAt: new Date(T0 - 30_000) }).where(eq(c.id, "s03"));
      assert.equal((await rowOf("s03")).unread, false, "nhân viên đã trả lời sau tin khách ⇒ đã thấy");

      // ═══ 5. Đổi chế độ: tiếp quản rời «Cần người» và vào «Người đang xử lý»; trả AI rời cả hai ═══
      assert.ok((await setConversationControlCore(admin, "s11", "HUMAN")).ok);
      const s11 = await rowOf("s11");
      assert.ok(s11.needsHuman === null && s11.humanHandling === "MANUAL_TAKEOVER", `tiếp quản ca AI xin người ⇒ người đang cầm: ${JSON.stringify({ n: s11.needsHuman, h: s11.humanHandling })}`);
      assert.ok((await setConversationControlCore(admin, "s11", "AUTO")).ok);
      const s11b = await rowOf("s11");
      assert.ok(s11b.needsHuman === null && s11b.humanHandling === null && s11b.handling === "AI", "trả lại AI ⇒ AI");
      assert.deepEqual((await orderNow()).filter((id) => id !== "s01" && id !== "s03"), after.filter((id) => id !== "s01" && id !== "s03"), "đổi chế độ AI không đổi thứ tự");

      // ═══ 6. Tổ chức ở chế độ AI gợi ý ⇒ mọi hội thoại «Người đang xử lý», «Cần người» không đổi ═══
      const copilotMode = JSON.stringify({ mode: "COPILOT", aiSharePct: 50 });
      const needsBefore = await listInbox(admin, { filter: "NEEDS_HUMAN", limit: 500 }, now);
      await db.insert(schema.settings).values({ key: OPERATING_MODE_SETTING_KEY, value: copilotMode }).onConflictDoUpdate({ target: schema.settings.key, set: { value: copilotMode } });
      const org = await listInbox(admin, { limit: 500 }, now);
      assert.ok(org.ok && org.counts.AI === 0 && org.counts.HUMAN === org.counts.ALL, `tổ chức Copilot: ${JSON.stringify(org.ok && org.counts)}`);
      assert.ok(needsBefore.ok && org.counts.NEEDS_HUMAN === needsBefore.counts.NEEDS_HUMAN, "«Cần người» không phụ thuộc chế độ vận hành");
      await db.delete(schema.settings).where(eq(schema.settings.key, OPERATING_MODE_SETTING_KEY));
      console.log("  ✓ thứ tự: nhãn / người phụ trách / hồ sơ / chế độ AI không đổi chỗ · AI trả lời không xoá chưa đọc · mở / trả lời mới xoá · Copilot cả tổ chức ⇒ mọi hội thoại của người");
    });
  } finally {
    await cleanup();
  }
}

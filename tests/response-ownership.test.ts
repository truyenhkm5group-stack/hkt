/**
 * ═══════════ AI IM LẶNG / CHẶN TRẢ LỜI SAI (P0 response-ownership, chủ shop 11/10/2026) ═══════════
 *
 * Khoá hai ca thật cùng gốc «phân loại người gửi sai» — gọi ĐƯỜNG XỬ LÝ THẬT (webhook Pancake giả, AI giả đếm lượt), không regex mã:
 *  · «Uyen Tran»: tin chào quảng cáo của page CÙNG PHÚT với câu hỏi thật ⇒ trước đây câu hỏi bị chốt «Page / nhân viên đã trả lời».
 *    Nay: lượt khách vẫn MỞ, AI trả lời MỘT lần cho cả lượt (câu hỏi thật + câu mẫu quảng cáo).
 *  · «Lê Bạch Nguyên»: chữ hệ thống trả lời bình luận của Facebook bị coi là NGƯỜI ⇒ nhường 30 phút ⇒ «Lấy 1kg» bị chặn. Nay:
 *    META_SYSTEM — không nhường, «Lấy 1kg» được trả lời.
 * Cùng bộ: echo tin AI (cả bản có chữ hệ thống chèn trước) · tự động Pancake · người thật (uid) · tiếp quản tay · «Lấy 1kg» lúc nhường
 * (người thật cầm ⇒ báo người, AI im; nhường không xác minh ⇒ AI tiếp) · ý định mua lặp (một thông báo mỗi lượt) · webhook đồng thời ·
 * danh tính mơ hồ (UNKNOWN không nhường) · hết nhường ⇒ đánh giá lại tồn MỘT lần · khách hỏi lại giá ⇒ trả lời · câu đếm bảng điều khiển
 * + hàng đợi cứu đơn. Mốc thời gian đều tương đối với đồng hồ THẬT (luật 50).
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { AiProvider, AiRequest, AiResponse } from "@/lib/ai/provider";
import type { SessionUser } from "@/lib/auth/session";
import { saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { FANPAGE_STAFF_REASON } from "@/lib/sales-chatbot/ai-hold-shared";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { setConversationControlCore } from "@/lib/sales-chatbot/conversation-control";
import { setSalesChatProviderForTests, SHOP_SAID } from "@/lib/sales-chatbot/engine";
import { META_SYSTEM_REASON, PAGE_REPLIED_REASON, PAGE_REPLY, processFanpageThread, receiveFanpageEvent, resumeFanpageAfterPause, STAFF_OUT_PREFIX, UNKNOWN_SENDER_REASON, type FanpageEvent } from "@/lib/sales-chatbot/fanpage";
import { loadInboxThread } from "@/lib/sales-chatbot/inbox";
import {
  BOT_SENT_NOTE,
  buildCustomerTurns,
  buyIntentDuringPause,
  classifyOutbound,
  CUSTOMER_TEMPLATE_MIN_THREADS,
  mergeSourceView,
  openTurnOf,
  originPausesAi,
  answers,
  ownershipMetrics,
  PAGE_REPLY_NOTE,
  partitionPending,
  purchaseIntent,
  rescueCandidates,
  responseOwnerState,
  resumeDecision,
  senderOfRow,
  STAFF_OUT_ID_PREFIX,
  latestTurnHandled,
  latestWebTurnHandled,
  META_HUMAN_INBOX_APP_IDS,
  META_SYSTEM_TEXT_RE,
  META_SYSTEM_TEXT_SQL_RE,
  turnAnswered,
  templateKeyOf,
  turnTraceNote,
  vnClock,
  type LedgerMessage,
  type OutboundFacts,
} from "@/lib/sales-chatbot/response-ownership";
import { latestCustomerTurnUnhandledSql, latestTurnStateOf, loadRescueQueue, loadResponseOwnershipMetrics, WEB_STAFF_PREFIX } from "@/lib/sales-chatbot/response-ownership-ledger";

const ORG = "tra-loi-dung-luot";
const PAGE = "5544332211";
const PANCAKE_TOKEN = "pancake_page_token_ownership_0123456789abc";
const BOT_TEXT = "Dạ chả cá thu bên em là cá đánh bắt ở vùng biển Quảng Ninh, chả tươi chưa chiên ạ. Chị lấy mấy kg ạ?";
const MIN = 60_000;
const GREETING = "CHẢ CÁ THU NGUYÊN CHẤT 100% - Chả cá đánh bắt tại Quảng Ninh gửi đường bay vào sg ạ";
const META_NOTICE = "Bạn đang phản hồi bình luận của người dùng về bài viết trên Trang của mình. Xem bình luận.";
const TPL_PARITY = "Dạ em chào anh/chị! Chả cá thu nguyên chất, 1kg giá 280k, 2kg còn 540k, em miễn ship toàn quốc ạ";
const TPL_PARITY_LATER = "Dạ bên em giao hoả tốc nội thành trong 2 giờ, ngoại thành hôm sau ạ, chị cứ yên tâm nhé";
const rowsOfPg = (r: unknown): Record<string, unknown>[] => (Array.isArray(r) ? r : ((r as { rows?: Record<string, unknown>[] }).rows ?? []));

// ─────────────────────────── Phần thuần ───────────────────────────

const facts = (p: Partial<OutboundFacts>): OutboundFacts => ({ text: "Dạ", botEcho: false, erpStaff: false, pancakeStaffAccount: false, automatedFlag: false, metaAppId: null, templateText: false, ...p });
const cust = (id: string, at: number, extra: Partial<LedgerMessage> = {}): LedgerMessage => ({ id, sender: "CUSTOMER", arrivedAt: at, sourceAt: at, status: "DONE", ...extra });
const out = (id: string, sender: LedgerMessage["sender"], at: number, extra: Partial<LedgerMessage> = {}): LedgerMessage => ({ id, sender, arrivedAt: at, sourceAt: at, ...extra });

function testPure() {
  // 1. Nguồn gốc người gửi — sáu giá trị, chỉ người đã xác minh làm AI nhường.
  assert.equal(classifyOutbound(facts({ botEcho: true, pancakeStaffAccount: true })), "AI_AGENT", "tiếng vọng của bot thắng mọi dấu hiệu");
  assert.equal(classifyOutbound(facts({ erpStaff: true })), "VERIFIED_HUMAN");
  assert.equal(classifyOutbound(facts({ text: `${META_NOTICE} (https://fb.com/x)` })), "META_SYSTEM", "chữ hệ thống trả lời bình luận");
  assert.equal(classifyOutbound(facts({ text: `${META_NOTICE}`, pancakeStaffAccount: true })), "META_SYSTEM", "chữ hệ thống kể cả khi Pancake gắn uid");
  assert.equal(classifyOutbound(facts({ automatedFlag: true })), "PANCAKE_AUTOMATION");
  assert.equal(classifyOutbound(facts({ templateText: true })), "PANCAKE_AUTOMATION");
  assert.equal(classifyOutbound(facts({ pancakeStaffAccount: true })), "VERIFIED_HUMAN");
  assert.equal(classifyOutbound(facts({ pancakeStaffAccount: true, templateText: true })), "VERIFIED_HUMAN", "nhân viên dùng câu lưu sẵn vẫn là người");
  assert.equal(classifyOutbound(facts({ metaAppId: META_HUMAN_INBOX_APP_IDS[0], templateText: true })), "PANCAKE_AUTOMATION", "câu mẫu từ app hộp thư Meta: chưa đo được là người ⇒ không làm AI nhường");
  assert.equal(classifyOutbound(facts({ metaAppId: META_HUMAN_INBOX_APP_IDS[0] })), "VERIFIED_HUMAN");
  assert.equal(classifyOutbound(facts({ metaAppId: "999", templateText: true })), "PANCAKE_AUTOMATION", "ứng dụng lạ gửi câu mẫu vẫn là tự động");
  assert.equal(templateKeyOf("  Dạ em chào\n\nanh/chị   ạ "), "Dạ em chào anh/chị ạ", "khoá câu mẫu gộp khoảng trắng");
  assert.equal(classifyOutbound(facts({ metaAppId: "263902037430900" })), "VERIFIED_HUMAN", "Hộp thư Page / Business Suite");
  assert.equal(classifyOutbound(facts({ metaAppId: "999" })), "OTHER_APP");
  assert.equal(classifyOutbound(facts({ metaAppId: "777", ownAppIds: ["777"] })), "AI_AGENT");
  assert.equal(classifyOutbound(facts({})), "UNKNOWN", "không chứng cứ ⇒ KHÔNG RÕ, không phải người");
  assert.deepEqual((["AI_AGENT", "VERIFIED_HUMAN", "PANCAKE_AUTOMATION", "META_SYSTEM", "OTHER_APP", "UNKNOWN"] as const).filter(originPausesAi), ["VERIFIED_HUMAN"]);
  assert.equal(senderOfRow({ note: BOT_SENT_NOTE, messageId: "x" }), "AI_AGENT");
  assert.equal(senderOfRow({ note: PAGE_REPLY_NOTE, messageId: `${STAFF_OUT_ID_PREFIX}1:0` }), "VERIFIED_HUMAN");
  assert.equal(senderOfRow({ note: PAGE_REPLY_NOTE, messageId: "p1", senderKind: null, text: "Dạ ok" }), "UNKNOWN", "dòng cũ chưa có cột ⇒ KHÔNG RÕ");
  assert.equal(senderOfRow({ note: PAGE_REPLY_NOTE, messageId: "p1", senderKind: null, text: META_NOTICE }), "META_SYSTEM");
  assert.equal(senderOfRow({ note: null, messageId: "c1" }), "CUSTOMER");
  assert.equal(BOT_SENT_NOTE, "BOT_SENT");
  assert.equal(PAGE_REPLY_NOTE, PAGE_REPLY, "bản sao chữ ghi chú khớp fanpage.ts");
  assert.equal(STAFF_OUT_ID_PREFIX, STAFF_OUT_PREFIX);

  const T = Date.parse("2026-10-11T02:14:00Z");
  // 2. «Uyen Tran»: tin chào CÙNG PHÚT (trước VÀ sau câu hỏi), câu mẫu quảng cáo tới sau ⇒ MỘT lượt mở gồm cả hai câu khách.
  const uyen = [out("g1", "UNKNOWN", T + 1_000), cust("q", T + 3_000, { status: "PENDING" }), out("g2", "UNKNOWN", T + 4_000), cust("tpl", T + 9_000, { status: "PENDING", template: true })];
  const tu = buildCustomerTurns(uyen);
  assert.equal(tu.length, 1, JSON.stringify(tu));
  assert.ok(!tu[0].answered && tu[0].messageIds.join() === "q,tpl", "tin chào không trả lời câu hỏi thật");
  assert.deepEqual(partitionPending(["q", "tpl"], tu).open, ["q", "tpl"], "AI trả lời một lần cho cả lượt");
  assert.equal(buildCustomerTurns([...uyen].reverse())[0].id, tu[0].id, "mã lượt TẤT ĐỊNH, không phụ thuộc thứ tự tới");
  // Câu hỏi thật tới SAU khi AI trả lời câu mẫu: vẫn là lượt riêng, mở.
  const later = [...uyen.map((m) => ({ ...m, status: "DONE" })), out("b1", "AI_AGENT", T + 300_000), cust("q2", T + 310_000, { status: "PENDING" })];
  assert.deepEqual(openTurnOf(buildCustomerTurns(later))?.messageIds, ["q2"]);

  // 3. Page trả lời trước rồi khách hỏi tiếp ⇒ câu CŨ không chốt câu MỚI.
  const staffFirst = [cust("c1", T), out("s1", "VERIFIED_HUMAN", T + 20_000), cust("c2", T + 40_000, { status: "PENDING" })];
  const ts = buildCustomerTurns(staffFirst);
  assert.ok(ts[0].answered && ts[0].answeredBy?.origin === "VERIFIED_HUMAN" && !ts[1].answered, JSON.stringify(ts));
  assert.deepEqual(partitionPending(["c2"], ts).open, ["c2"]);
  // Ba tin khách liên tiếp ⇒ MỘT lượt.
  assert.equal(buildCustomerTurns([cust("a", T), cust("b", T + 1_000), cust("c", T + 2_000)]).length, 1);

  // 4. HỢP ĐỒNG ĐỔI 16/10/2026 (chủ shop, issue #856 «Cao Hải Ninh»): tin TỰ ĐỘNG của page KHÔNG BAO GIỜ đóng lượt khách — kể cả lượt
  // toàn câu mẫu quảng cáo («Báo giá chả cá thu?»). Ngoại lệ cũ «Dư Thị Liên» (05/10 — tránh báo giá đôi) đã bỏ: lời chào / creative
  // không phải câu giải đáp, giá máy chủ là nguồn có thẩm quyền. Mọi biến thể thứ tự đều phải để lượt MỞ cho AI.
  const hoi = (id: string, at: number, o: Partial<LedgerMessage> = {}) => cust(id, at, { template: true, text: "Báo giá chả cá thu?", ...o });
  const tuDong = (id: string, at: number, o: Partial<LedgerMessage> = {}) => out(id, "PANCAKE_AUTOMATION", at, { text: GREETING, ...o });
  const moChoAi = (ms: LedgerMessage[], vi: string) => {
    const ts = buildCustomerTurns(ms);
    assert.ok(!ts.at(-1)!.answered, `${vi}: lượt hỏi giá phải còn MỞ cho AI — ${JSON.stringify(ts)}`);
    assert.deepEqual(partitionPending(ms.filter((m) => m.sender === "CUSTOMER").map((m) => m.id), ts).answered, [], `${vi}: không tin khách nào bị chốt «page đã trả lời»`);
  };
  moChoAi([hoi("t", T), tuDong("a1", T + 1_000), tuDong("a2", T + 1_500)], "tự động tới SAU (khác giây)");
  moChoAi([hoi("t", T, { sourceSeq: 1 }), tuDong("a1", T, { sourceSeq: 2 })], "tự động CÙNG GIÂY, đứng sau theo thứ tự nguồn");
  moChoAi([tuDong("a1", T - 1_000), hoi("t", T)], "tự động gửi TRƯỚC");
  moChoAi([hoi("t", T, { arrivedAt: T + 90_000 }), tuDong("a1", T + 2_000, { arrivedAt: T + 3_000 })], "webhook tin khách tới SAU tin tự động (đảo thứ tự)");
  moChoAi([hoi("t", T, { sourceAt: null }), tuDong("a1", T + 120_000, { sourceAt: null })], "thiếu mốc nguồn, tự động tới sau ≥ 60 giây");
  moChoAi([hoi("t", T), tuDong("a1", T + 1_000), tuDong("a1", T + 1_000)], "webhook tự động TRÙNG");
  moChoAi([hoi("t", T), tuDong("a1", T + 1_000, { text: "Chả cá thu 1kg giá 199k (giá cũ) — inbox để được tư vấn" })], "tin mẫu có chữ giá (cũ / sai) — giá máy chủ có thẩm quyền");
  moChoAi([hoi("t", T), out("u", "UNKNOWN", T + 2_000)], "chưa rõ người gửi ngay đầu phiên ⇒ coi là tin chào");
  moChoAi([cust("q", T, { text: "1kg bao nhiêu vậy shop" }), tuDong("a1", T + 1_000)], "câu tự gõ + tự động");
  // Khách hỏi thêm sau tin tự động ⇒ vẫn MỘT lượt mở (không nuốt câu mới, không tách hai câu trả lời).
  const them = buildCustomerTurns([hoi("t", T), tuDong("a1", T + 1_000), cust("t2", T + 20_000, { text: "Ship HN mấy ngày?" })]);
  assert.ok(them.length === 1 && !them[0].answered && them[0].messageIds.join() === "t,t2", JSON.stringify(them));
  // Không nhầm tự động với NGƯỜI: nhân viên thật trả lời ⇒ đóng (AI không chen); bot ERP đã gửi ⇒ đóng (không lặp).
  assert.ok(buildCustomerTurns([hoi("t", T), tuDong("a1", T + 1_000), out("s", "VERIFIED_HUMAN", T + 30_000)])[0].answeredBy?.origin === "VERIFIED_HUMAN");
  assert.ok(buildCustomerTurns([hoi("t", T, { status: "DONE" }), tuDong("a1", T + 1_000), out("b", "AI_AGENT", T + 5_000)])[0].answeredBy?.origin === "AI_AGENT");
  assert.ok(buildCustomerTurns([hoi("t", T), tuDong("a1", T + 1_000), out("o", "OTHER_APP", T + 9_000)])[0].answeredBy?.origin === "OTHER_APP", "ứng dụng khác thật sự trả lời ⇒ không trả lời đôi (luật 4)");
  assert.equal(answers("PANCAKE_AUTOMATION"), false);
  assert.equal(answers("META_SYSTEM"), false);
  assert.deepEqual((["AI_AGENT", "VERIFIED_HUMAN", "OTHER_APP", "UNKNOWN"] as const).filter(answers), ["AI_AGENT", "VERIFIED_HUMAN", "OTHER_APP", "UNKNOWN"]);
  // Hộp thư và AI nói CÙNG một điều: lượt ấy cũng «chưa xử lý» ở hộp thư.
  assert.equal(latestTurnHandled([hoi("t", T), tuDong("a1", T + 1_000)]).handled, false);
  // Chữ hệ thống không bao giờ trả lời.
  assert.ok(!buildCustomerTurns([cust("t", T), out("m", "META_SYSTEM", T + 5 * MIN)])[0].answered);

  // 5. Câu bot chỉ trả lời tin bot ĐÃ THẤY: tin khách tới trong lúc bot soạn (PENDING) vẫn mở.
  const composing = [cust("x1", T), cust("x2", T + 2_000, { status: "PENDING" }), out("bot", "AI_AGENT", T + 5_000)];
  const tc = buildCustomerTurns(composing);
  assert.ok(tc[0].answered && tc[0].messageIds.join() === "x1" && !tc[1].answered && tc[1].messageIds.join() === "x2", JSON.stringify(tc));

  // 6. Webhook trễ / đảo thứ tự: theo MỐC NGUỒN. Tin khách TỚI sau nhưng TẠO trước câu nhân viên ⇒ đã trả lời; câu nhân viên tới sau
  // nhưng TẠO trước tin khách ⇒ chưa.
  assert.ok(buildCustomerTurns([out("s", "VERIFIED_HUMAN", T + 60_000, { arrivedAt: T + 61_000 }), cust("late", T, { arrivedAt: T + 120_000 })])[0].answered);
  assert.ok(!buildCustomerTurns([cust("c", T + 10_000, { arrivedAt: T + 10_000 }), out("s", "UNKNOWN", T + 5_000, { arrivedAt: T + 70_000 })]).at(-1)!.answered);
  // Giữa hội thoại (không phải tin chào): cùng mốc nguồn ⇒ thứ tự nguồn quyết; không có ⇒ KHÔNG chắc (lượt còn mở — một câu trùng
  // còn hơn không ai trả lời).
  const mid = [cust("o", T - 2 * MIN), out("ob", "AI_AGENT", T - MIN)];
  assert.ok(buildCustomerTurns([...mid, cust("c", T, { sourceSeq: 1 }), out("s", "UNKNOWN", T, { sourceSeq: 2 })]).at(-1)!.answered);
  assert.ok(!buildCustomerTurns([...mid, cust("c", T), out("s", "UNKNOWN", T)]).at(-1)!.answered);
  // Đầu phiên: cùng câu chưa rõ người gửi tới ngay sau tin khách ⇒ tin chào / tự động, KHÔNG trả lời.
  assert.ok(!buildCustomerTurns([cust("c", T, { sourceSeq: 1 }), out("s", "UNKNOWN", T + 2_000, { sourceSeq: 2 })])[0].answered);
  // Thiếu mốc nguồn: tin page tới sau < 60 giây ⇒ mơ hồ; ≥ 60 giây ⇒ chắc.
  assert.ok(!buildCustomerTurns([...mid, cust("c", T, { sourceAt: null }), out("u", "UNKNOWN", T + 30_000, { sourceAt: null })]).at(-1)!.answered);
  assert.ok(buildCustomerTurns([...mid, cust("c", T, { sourceAt: null }), out("u", "UNKNOWN", T + 90_000, { sourceAt: null })]).at(-1)!.answered, "UNKNOWN chắc chắn tới sau ⇒ không trả lời đôi");
  assert.ok(buildCustomerTurns([cust("c", T), out("o", "OTHER_APP", T + 5_000)])[0].answered, "hai hệ thống cùng nối page: ứng dụng khác đã trả lời ⇒ AI không trả lời đôi");
  // API theo yêu cầu.
  assert.equal(turnAnswered([cust("c", T)], [out("s", "VERIFIED_HUMAN", T + 1_000)]).answered, true);
  assert.equal(turnAnswered([cust("c", T)], [out("g", "PANCAKE_AUTOMATION", T + 1_000)]).answered, false);
  // Lời khai của Pancake ghép vào sổ: tin page webhook chưa tới vẫn được tính, mốc nguồn đè mốc tới.
  const merged = mergeSourceView([cust("c", T, { sourceAt: null, arrivedAt: T + 3_000 })], [{ id: "c", at: T, seq: 0, outbound: null, text: "" }, { id: "s", at: T + 1_000, seq: 1, outbound: "VERIFIED_HUMAN", text: "Dạ" }]);
  assert.ok(merged.length === 2 && merged[0].sourceAt === T && buildCustomerTurns(merged)[0].answered);

  // 7. Máy trạng thái + câu phụ trên dấu vết.
  const until = new Date(Date.now() + 20 * MIN);
  const open = openTurnOf(buildCustomerTurns([cust("c", T)]));
  const pause = responseOwnerState({ hold: { state: "HUMAN_COOLDOWN", cause: "STAFF_REPLY", until }, conversationStatus: "HANDOFF", handoffReason: FANPAGE_STAFF_REASON, openTurn: open });
  assert.ok(pause.state === "TEMPORARY_AI_PAUSE" && pause.resumeAt === until.toISOString() && pause.needsQueue);
  assert.equal(responseOwnerState({ hold: { state: "HUMAN_TAKEOVER", cause: "TAKEOVER", until: null }, conversationStatus: "HANDOFF", handoffReason: null, openTurn: null }).state, "HUMAN_ACTIVE");
  assert.equal(responseOwnerState({ hold: { state: "HUMAN_TAKEOVER", cause: "NEEDS_HUMAN", until: null }, conversationStatus: "HANDOFF", handoffReason: "Khách sỉ", openTurn: open }).state, "HANDOFF_PENDING");
  assert.equal(responseOwnerState({ hold: { state: "AI_ACTIVE", cause: null, until: null }, conversationStatus: "CLOSED", handoffReason: null, openTurn: null }).state, "RESOLVED");
  assert.equal(responseOwnerState({ hold: { state: "AI_ACTIVE", cause: null, until: null }, conversationStatus: "CLOSED", handoffReason: null, openTurn: open }).state, "AI_ACTIVE", "đã chốt mà khách hỏi tiếp ⇒ chưa xong");
  const note = turnTraceNote({ answered: false, isOpenTurn: true, code: "AI_SKIPPED_HUMAN_COOLDOWN", owner: pause, answeredBy: null });
  assert.ok(note?.includes(`AI tiếp lúc ${vnClock(until.toISOString())}`) && note.includes("Nhân viên vừa trả lời tay"), String(note));
  assert.match(turnTraceNote({ answered: false, isOpenTurn: true, code: "AI_SKIPPED_PAGE_ANSWERED", owner: pause, answeredBy: null }) ?? "", /^Ghi nhầm/);
  assert.equal(turnTraceNote({ answered: true, isOpenTurn: false, code: null, owner: pause, answeredBy: "AI_AGENT" }), null);

  // 8. Hết nhường ⇒ đánh giá lại tồn: lượt mới nhất, một lần, chỉ khi tin bị chốt vì nhường.
  const now = Date.now();
  const paused = [cust("p1", now - 10 * MIN, { status: "SKIPPED", note: FANPAGE_STAFF_REASON }), cust("p2", now - 9 * MIN, { status: "SKIPPED", note: FANPAGE_STAFF_REASON })];
  const isPause = (n: string | null) => n === FANPAGE_STAFF_REASON || n === PAGE_REPLIED_REASON;
  const rd = resumeDecision({ owner: "AI_ACTIVE", turns: buildCustomerTurns(paused), ledger: paused, nowMs: now, pauseNotes: isPause });
  assert.ok(rd.resume && rd.messageIds.join() === "p1,p2", JSON.stringify(rd));
  assert.deepEqual(resumeDecision({ owner: "TEMPORARY_AI_PAUSE", turns: buildCustomerTurns(paused), ledger: paused, nowMs: now, pauseNotes: isPause }), { resume: false, reason: "NOT_AI" });
  assert.deepEqual(resumeDecision({ owner: "AI_ACTIVE", turns: buildCustomerTurns(paused), ledger: paused, nowMs: now + 3 * 60 * MIN, pauseNotes: isPause }), { resume: false, reason: "STALE" });
  const inflight = [...paused, cust("p3", now - MIN, { status: "PENDING" })];
  assert.deepEqual(resumeDecision({ owner: "AI_ACTIVE", turns: buildCustomerTurns(inflight), ledger: inflight, nowMs: now, pauseNotes: isPause }), { resume: false, reason: "IN_FLIGHT" });
  const answeredLater = [...paused, out("s", "VERIFIED_HUMAN", now - 8 * MIN)];
  assert.deepEqual(resumeDecision({ owner: "AI_ACTIVE", turns: buildCustomerTurns(answeredLater), ledger: answeredLater, nowMs: now, pauseNotes: isPause }), { resume: false, reason: "NO_OPEN_TURN" }, "người đã trả lời trong lúc nhường ⇒ không gửi bù");
  // P0 HSLC 24/10/2026 (#D2A8DE9B → #A5CC67E2): người lên đơn TỪ / SAU tin đầu của lượt bị nhường ⇒ đã xử lý lượt ấy, KHÔNG mở lại;
  // đơn người lên TRƯỚC lượt (sáng nay, khách nhắn chuyện khác chiều nay) ⇒ vẫn mở lại.
  assert.deepEqual(resumeDecision({ owner: "AI_ACTIVE", turns: buildCustomerTurns(paused), ledger: paused, nowMs: now, pauseNotes: isPause, humanOrderAt: now - 5 * MIN }), { resume: false, reason: "HUMAN_ORDERED" }, "người lên đơn sau tin bị nhường ⇒ không chạy lại lượt");
  assert.deepEqual(resumeDecision({ owner: "AI_ACTIVE", turns: buildCustomerTurns(paused), ledger: paused, nowMs: now, pauseNotes: isPause, humanOrderAt: now - 10 * MIN }), { resume: false, reason: "HUMAN_ORDERED" }, "đúng mốc tin đầu vẫn là đã xử lý");
  assert.equal(resumeDecision({ owner: "AI_ACTIVE", turns: buildCustomerTurns(paused), ledger: paused, nowMs: now, pauseNotes: isPause, humanOrderAt: now - 60 * MIN }).resume, true, "đơn người TRƯỚC lượt ⇒ vẫn trả lời lượt mới");
  assert.equal(resumeDecision({ owner: "AI_ACTIVE", turns: buildCustomerTurns(paused), ledger: paused, nowMs: now, pauseNotes: isPause, humanOrderAt: null }).resume, true, "không có đơn người ⇒ như cũ");

  // 9. Ý định mua.
  for (const t of ["Lấy 1kg", "lấy 1 kg nha", "Chốt đơn cho chị", "2k nha", "mua 2 hộp", "0832106422", "1094/3 Lê Đức Thọ P13 GV", "số nhà 12 đường Láng"]) assert.ok(purchaseIntent(t).intent, t);
  for (const t of ["Cho mình xin giá nhen", "Chả tươi hay chiên?", "Báo giá chả cá thu?", "Ship Hà Nội mấy ngày"]) assert.ok(!purchaseIntent(t).intent, t);
  assert.equal(buyIntentDuringPause({ intent: true, owner: "TEMPORARY_AI_PAUSE", pauseVerified: true }), "NOTIFY_HOLDER");
  assert.equal(buyIntentDuringPause({ intent: true, owner: "TEMPORARY_AI_PAUSE", pauseVerified: false }), "AI_CONTINUES");
  assert.equal(buyIntentDuringPause({ intent: true, owner: "HUMAN_ACTIVE", pauseVerified: true }), "NOTIFY_HOLDER");
  assert.equal(buyIntentDuringPause({ intent: false, owner: "TEMPORARY_AI_PAUSE", pauseVerified: false }), "NONE");

  // 9b. «Tin khách chưa đọc» = lượt khách mới nhất CHƯA xử lý — ma trận chủ shop (11/10/2026, OWNER CORRECTION).
  const unread = (ms: LedgerMessage[], readThroughAt: number | null = null) => !latestTurnHandled(ms, { readThroughAt }).handled;
  const P0 = [cust("o0", T - 3 * 60 * MIN), out("ob0", "AI_AGENT", T - 3 * 60 * MIN + 5_000)];
  assert.equal(unread([...P0, cust("c", T)]), true, "CUSTOMER ⇒ YES");
  assert.equal(unread([...P0, cust("c", T), out("b", "AI_AGENT", T + 5_000)]), false, "CUSTOMER→AI_VALID ⇒ NO");
  assert.equal(unread([...P0, cust("c", T), out("s", "VERIFIED_HUMAN", T + 5_000)]), false, "CUSTOMER→STAFF_VALID ⇒ NO");
  assert.equal(unread([...P0, cust("c", T), out("p", "UNKNOWN", T + 2 * MIN)]), false, "CUSTOMER→PAGE_VALID ⇒ NO");
  assert.equal(unread([...P0, cust("c", T)], T + MIN), false, "CUSTOMER→HUMAN_OPEN ⇒ NO");
  assert.equal(unread([...P0, cust("c", T), out("b", "AI_AGENT", T + 5_000), cust("c2", T + MIN)]), true, "CUSTOMER→AI_VALID→CUSTOMER_NEW ⇒ YES");
  assert.equal(unread([...P0, cust("c", T), out("s", "VERIFIED_HUMAN", T + 5_000), cust("c2", T + MIN)]), true, "CUSTOMER→STAFF→CUSTOMER_NEW ⇒ YES");
  assert.equal(unread([out("b", "AI_AGENT", T)]), false, "chỉ BOT ⇒ NO");
  assert.equal(unread([out("s", "VERIFIED_HUMAN", T)]), false, "chỉ STAFF ⇒ NO");
  assert.equal(unread([out("p", "UNKNOWN", T)]), false, "chỉ PAGE ⇒ NO");
  assert.equal(unread([...P0, cust("c", T), out("a", "PANCAKE_AUTOMATION", T + 5_000), out("m", "META_SYSTEM", T + 6_000)]), true, "tin tự động / hệ thống không phải xử lý");
  assert.equal(unread([cust("t", T, { template: true }), out("a", "PANCAKE_AUTOMATION", T + 1_000)]), true, "hộp thư: kể cả câu mẫu được trả lời tự động — chưa NGƯỜI / AI nào đáp");
  assert.equal(unread([...P0, cust("c", T, { status: "PENDING" }), out("b", "AI_AGENT", T + 5_000)]), true, "câu bot chưa thấy tin (PENDING) ⇒ chưa xử lý");
  assert.equal(unread([...P0, cust("c", T)], T - MIN), true, "con trỏ đọc CŨ hơn tin khách ⇒ chưa xử lý");
  assert.equal(latestTurnHandled([...P0, cust("c", T)], { readThroughAt: T }).by, "HUMAN_READ");
  // (a) MEDIA_ONLY: lượt của người (hàng đợi thấy), nhưng KHÔNG phải việc của AI.
  assert.equal(unread([...P0, cust("c", T), out("b", "AI_AGENT", T + 5_000), cust("st", T + MIN, { mediaOnly: true })]), true, "nhãn dán sau câu bot ⇒ lượt mới, người phải thấy");
  const mediaTurn = buildCustomerTurns([...P0, cust("st", T, { mediaOnly: true, status: "DONE", note: "MEDIA_ONLY" })]).at(-1)!;
  assert.ok(!mediaTurn.answered && !mediaTurn.aiAnswerable, "lượt toàn nhãn dán: chưa xử lý, AI không trả lời");
  const pausedMedia = [cust("pm", Date.now() - 5 * MIN, { mediaOnly: true, status: "DONE", note: "MEDIA_ONLY" })];
  assert.deepEqual(resumeDecision({ owner: "AI_ACTIVE", turns: buildCustomerTurns(pausedMedia), ledger: pausedMedia, nowMs: Date.now(), pauseNotes: () => true }), { resume: false, reason: "MEDIA_ONLY" }, "hết nhường không gửi bù cho nhãn dán");
  const mixed = [cust("q", Date.now() - 6 * MIN, { status: "SKIPPED", note: FANPAGE_STAFF_REASON }), cust("st2", Date.now() - 5 * MIN, { mediaOnly: true, status: "DONE", note: "MEDIA_ONLY" })];
  const rm = resumeDecision({ owner: "AI_ACTIVE", turns: buildCustomerTurns(mixed), ledger: mixed, nowMs: Date.now(), pauseNotes: (n) => n === FANPAGE_STAFF_REASON });
  assert.ok(rm.resume && rm.messageIds.join() === "q", `chữ + nhãn dán ⇒ mở lại phần chữ: ${JSON.stringify(rm)}`);
  // (c) Chat web.
  const web = (xs: [number, "user" | "assistant", boolean, number][], read: number | null = null) => latestWebTurnHandled(xs.map(([seq, role, hasText, at]) => ({ seq, role, hasText, at })), { readThroughAt: read });
  assert.equal(web([[1, "user", true, T]]).handled, false);
  assert.equal(web([[1, "user", true, T], [2, "assistant", true, T + 1]]).handled, true);
  assert.equal(web([[1, "user", true, T], [2, "assistant", true, T + 1], [3, "user", true, T + 2]]).handled, false);
  assert.equal(web([[1, "user", true, T], [2, "assistant", true, T + 1], [3, "user", false, T + 2]]).handled, true, "dòng kết quả công cụ không phải khách");
  assert.equal(web([[1, "user", true, T]], T).by, "HUMAN_READ");
  assert.equal(web([[2, "assistant", true, T]]).hasCustomer, false);
  assert.equal(WEB_STAFF_PREFIX, SHOP_SAID, "bản sao chữ câu nhân viên chat web khớp engine.ts");

  // 10. Đếm + hàng đợi cứu đơn.
  const th = (id: string, ledger: LedgerMessage[], extra: Partial<Parameters<typeof rescueCandidates>[0][number]> = {}) => ({ conversationId: id, ledger, owner: "AI_ACTIVE" as const, ...extra });
  const threads = [
    th("false", [cust("f1", now - 3 * 60 * MIN, { status: "SKIPPED", note: PAGE_REPLIED_REASON, text: "Lấy 1kg" }), out("fg", "PANCAKE_AUTOMATION", now - 3 * 60 * MIN + 1_000)]),
    th("pause", [cust("h1", now - 20 * MIN, { status: "SKIPPED", note: FANPAGE_STAFF_REASON, text: "chốt đơn nha" })], { owner: "TEMPORARY_AI_PAUSE" }),
    th("ok", [cust("o1", now - 30 * MIN, { text: "giá?" }), out("ob", "AI_AGENT", now - 29 * MIN)]),
    th("optout", [cust("x1", now - 50 * MIN, { status: "SKIPPED", note: FANPAGE_STAFF_REASON, text: "Lấy 2kg" })], { optedOut: true }),
    th("busy", [cust("y1", now - MIN, { status: "PENDING", text: "Lấy 1kg" })]),
  ];
  const m = ownershipMetrics(threads, now, { falseAnsweredNote: PAGE_REPLIED_REASON });
  assert.ok(m.customerTurns === 5 && m.answeredTurns === 1 && m.unansweredTurns === 4 && m.inFlight === 1 && m.falseAnswered === 1 && m.humanBacklog === 1 && m.lostToSuppression === 1, JSON.stringify(m));
  assert.equal(m.suppressionByReason[FANPAGE_STAFF_REASON], 2);
  assert.equal(m.timeToValidResponse.medianMs, null, "mẫu < 10 ⇒ không in trung vị");
  const rq = rescueCandidates(threads, now);
  assert.deepEqual(rq.map((r) => r.conversationId), ["false", "pause"], "ý định mua bị chặn, chờ lâu nhất trước; bỏ khách từ chối và lượt đang soạn");
  assert.equal(CUSTOMER_TEMPLATE_MIN_THREADS, 2);
}

// ─────────────────────────── Đường xử lý thật ───────────────────────────

type Call = { url: string; init?: RequestInit };
function fakePancake(threadMessages: Map<string, Record<string, unknown>[]>): { fetch: typeof fetch; calls: Call[]; sends: (from: number, thread?: string) => Call[] } {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const m = /\/conversations\/([^/?]+)\/messages/.exec(url);
    const body = url.includes("/conversations?") ? { success: true, conversations: [{ id: "c1" }] } : init?.method === "POST" ? { success: true, id: `p-out-${calls.length}` } : { success: true, messages: m ? (threadMessages.get(decodeURIComponent(m[1])) ?? []) : [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, calls, sends: (from, thread) => calls.slice(from).filter((c) => c.init?.method === "POST" && c.url.includes("/messages") && (!thread || c.url.includes(`/conversations/${thread}/`))) };
}

let aiCalls = 0;
function fakeBot(): AiProvider {
  return {
    name: "fake",
    model: "claude-sonnet-5",
    schemaDialect: "anthropic",
    async complete(req: AiRequest): Promise<AiResponse> {
      aiCalls += 1;
      return { content: [{ type: "text", text: req.tools.length ? BOT_TEXT : "NONE" }], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
    },
  };
}

async function cleanupOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, code));
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

async function testFlow() {
  await provisionOrganization({ code: ORG, name: ORG, plan: "starter", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "TraLoiDung@12345" }, source: "TEST", actor: null });
  const enabled = [...(await getEnabledModules(ORG))];
  const threadMessages = new Map<string, Record<string, unknown>[]>();
  const pancake = fakePancake(threadMessages);
  setSalesChatProviderForTests(() => fakeBot());
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const base = { email: u.email, scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: ORG, isHome: false }, modules: enabled };
      const admin = { ...base, id: u.id, name: "QT", role: "ADMIN", permissions: ["settings:manage", "ai_sales:manage", "ai_sales:view", "ai_sales:reply"] } as unknown as SessionUser;
      assert.ok("ok" in (await saveConnection(admin, { connectorKey: "pancake-fanpage", settings: { pageId: PAGE }, secrets: { pageAccessToken: PANCAKE_TOKEN } })));
      assert.ok("ok" in (await testOrgConnection(admin, "pancake-fanpage", { tester: { fetch: pancake.fetch } })));
      assert.ok("ok" in (await setConnectionStatus(admin, "pancake-fanpage", "ACTIVE")));
      const cfg = JSON.stringify({ ...DEFAULT_SALES_CHATBOT_CONFIG, enabled: true });
      await db.insert(schema.settings).values({ key: SALES_CHATBOT_SETTING_KEY, value: cfg }).onConflictDoUpdate({ target: schema.settings.key, set: { value: cfg } });

      const t = schema.salesChatInbound;
      const c = schema.salesChatConversations;
      const at = (ms: number) => () => new Date(Date.now() + ms);
      const ev = (thread: string, mid: string, text: string, o: { page?: boolean; uid?: boolean; automated?: boolean } = {}): FanpageEvent => ({ pageId: PAGE, threadId: thread, messageId: mid, text, customerName: o.page ? "" : "Khách", fromPage: Boolean(o.page), humanStaff: Boolean(o.page && o.uid), automated: Boolean(o.automated), inbox: true, comment: null, imageUrls: [] });
      const rowOf = async (mid: string) => (await db.select().from(t).where(eq(t.messageId, mid)))[0];
      const convOf = async (thread: string) => (await db.select().from(c).where(and(eq(c.channel, "FANPAGE"), eq(c.threadId, thread))).limit(1))[0];
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const opened = async (thread: string) => {
        await receiveFanpageEvent(ev(thread, `${thread}.0`, "Chả cá thu bao nhiêu shop?"));
        const m0 = pancake.calls.length;
        const r = await processFanpageThread(PAGE, thread, { fetch: pancake.fetch, now: at(31_000) });
        assert.ok(r.replies >= 1 && pancake.sends(m0).length >= 1, `bot trả lời tin đầu: ${JSON.stringify(r)}`);
        return (await convOf(thread)).id;
      };

      // Câu mẫu quảng cáo đã thấy ở 2 hội thoại khác (câu khách gieo sẵn — không qua bot).
      for (const other of ["seed-a", "seed-b"]) await db.insert(t).values({ pageId: PAGE, threadId: other, messageId: `${other}.tpl`, text: "Báo giá chả cá thu?", status: "DONE", processedAt: new Date() });

      // ═══ A. «Uyen Tran»: tin chào CÙNG PHÚT với câu hỏi thật ⇒ AI trả lời MỘT lần cho cả lượt ═══
      const A = "t-uyen";
      await receiveFanpageEvent(ev(A, "a.g1", GREETING, { page: true }));
      await receiveFanpageEvent(ev(A, "a.g2", "Dạ em chào anh/chị ! Chả cá thu bên em: 1kg 279k · 2kg giảm còn 539k, em miễn ship", { page: true }));
      await sleep(5);
      await receiveFanpageEvent(ev(A, "a.q", "Chào shop, chả cá thu của shop cá đánh bắt vùng biển nào ah? Chả tươi hay chiên? Cho mình xin giá nhen"));
      await receiveFanpageEvent(ev(A, "a.tpl", "Báo giá chả cá thu?"));
      let mark = pancake.calls.length;
      let ai0 = aiCalls;
      const rA = await processFanpageThread(PAGE, A, { fetch: pancake.fetch, now: at(31_000) });
      assert.ok(rA.replies === 1 && pancake.sends(mark, A).length === 1, `một câu trả lời cho cả lượt: ${JSON.stringify(rA)}`);
      assert.ok(aiCalls > ai0, "AI được gọi");
      for (const mid of ["a.q", "a.tpl"]) {
        const r = await rowOf(mid);
        assert.ok(r.status === "DONE" && r.note !== PAGE_REPLIED_REASON, `${mid}: ${r.status} · ${r.note}`);
      }
      assert.equal((await rowOf("a.g1")).senderKind, "UNKNOWN", "tin chào chưa rõ người gửi — lưu đúng lời khai");
      // Hộp thư: không còn nhãn «Page / nhân viên đã trả lời» cho câu hỏi thật.
      const thA = await loadInboxThread(admin, (await convOf(A)).id);
      assert.ok(thA.ok);
      const qItem = thA.thread.items.find((i) => i.side === "CUSTOMER" && i.text.startsWith("Chào shop"));
      assert.ok(qItem?.trace && qItem.trace.code !== "AI_SKIPPED_PAGE_ANSWERED", JSON.stringify(qItem?.trace));

      // ═══ B. «Lê Bạch Nguyên»: chữ hệ thống trả lời bình luận KHÔNG phải người ⇒ không nhường, «Lấy 1kg» được trả lời ═══
      const B = "t-le-bach";
      const convB = await opened(B);
      const sys = await receiveFanpageEvent(ev(B, "b.sys", `${META_NOTICE}(https://www.facebook.com/123)`, { page: true }));
      assert.equal(sys.reason, META_SYSTEM_REASON);
      assert.ok((await convOf(B)).status !== "HANDOFF" && (await rowOf("b.sys")).senderKind === "META_SYSTEM");
      await receiveFanpageEvent(ev(B, "b.buy1", "Lấy 1kg"));
      mark = pancake.calls.length;
      const rB = await processFanpageThread(PAGE, B, { fetch: pancake.fetch, now: at(31_000) });
      assert.ok(rB.replies >= 1 && pancake.sends(mark, B).length >= 1, `«Lấy 1kg» được trả lời: ${JSON.stringify(rB)}`);
      // Tiếng vọng tin AI (nguyên văn) và bản có chữ hệ thống chèn trước ⇒ đều là tin của bot, không nhường.
      assert.equal((await receiveFanpageEvent(ev(B, "b.echo", BOT_TEXT, { page: true }))).reason, "Tin của chính bot");
      assert.equal((await receiveFanpageEvent(ev(B, "b.echo2", `${META_NOTICE} ${BOT_TEXT}`, { page: true }))).reason, "Tin của chính bot");
      assert.notEqual((await db.select().from(c).where(eq(c.id, convB)))[0].status, "HANDOFF");

      // ═══ C. Tự động Pancake giữa cuộc chat ⇒ không nhường, không trả lời câu hỏi; danh tính mơ hồ ⇒ UNKNOWN_SENDER, không nhường ═══
      const C = "t-tu-dong";
      await opened(C);
      assert.match((await receiveFanpageEvent(ev(C, "c.auto", "Cảm ơn anh/chị đã quan tâm sản phẩm của shop ạ", { page: true, automated: true }))).reason, /Tin mẫu tự động/);
      assert.equal((await receiveFanpageEvent(ev(C, "c.unk", "Dạ vâng", { page: true }))).reason, UNKNOWN_SENDER_REASON);
      assert.ok((await convOf(C)).status !== "HANDOFF" && (await rowOf("c.unk")).senderKind === "UNKNOWN", "mơ hồ ⇒ KHÔNG nhường mù");
      await receiveFanpageEvent(ev(C, "c.q", "Ship HCM mấy ngày em?"));
      mark = pancake.calls.length;
      assert.ok((await processFanpageThread(PAGE, C, { fetch: pancake.fetch, now: at(31_000) })).replies >= 1 && pancake.sends(mark, C).length >= 1, "lượt khách kế tiếp AI trả lời");

      // ═══ D. Người thật (uid) ⇒ nhường có vết; «Lấy 1kg» lúc nhường ⇒ báo người, AI im; ý định lặp ⇒ MỘT thông báo mỗi lượt ═══
      const D = "t-nguoi-that";
      const convD = await opened(D);
      const TD = new Date();
      assert.match((await receiveFanpageEvent(ev(D, "d.staff", "Dạ chị đợi em kiểm kho", { page: true, uid: true }), TD)).reason, /bot nhường/);
      const cd = await convOf(D);
      const pause = (cd.state as { pause?: Record<string, unknown> }).pause;
      assert.ok(cd.status === "HANDOFF" && pause?.origin === "VERIFIED_HUMAN" && pause.triggerMessageId === "d.staff" && pause.until === new Date(TD.getTime() + 30 * MIN).toISOString(), JSON.stringify(pause));
      await receiveFanpageEvent(ev(D, "d.ask", "Còn hàng không em?"));
      await receiveFanpageEvent(ev(D, "d.buy", "Lấy 1kg"));
      mark = pancake.calls.length;
      ai0 = aiCalls;
      const rD = await processFanpageThread(PAGE, D, { fetch: pancake.fetch, now: at(31_000) });
      assert.ok(rD.replies === 0 && aiCalls === ai0 && pancake.sends(mark, D).length === 0, `người thật cầm ⇒ AI im: ${JSON.stringify(rD)}`);
      const notes = await db.select().from(schema.notifications).where(like(schema.notifications.dedupeKey, `sales-chat:buy-intent:${convD}:%`));
      assert.equal(notes.length, 1, "báo người đang cầm NGAY");
      await receiveFanpageEvent(ev(D, "d.buy2", "Lấy 1kg nha shop"));
      await processFanpageThread(PAGE, D, { fetch: pancake.fetch, now: at(31_000) });
      assert.equal((await db.select().from(schema.notifications).where(like(schema.notifications.dedupeKey, `sales-chat:buy-intent:${convD}:%`))).length, 1, "ý định mua lặp trong CÙNG lượt ⇒ không báo lần hai");
      // Hộp thư: lượt chưa trả lời hiện lý do + «AI tiếp lúc HH:MM».
      const thD = await loadInboxThread(admin, convD);
      assert.ok(thD.ok);
      const dItem = thD.thread.items.find((i) => i.side === "CUSTOMER" && i.text === "Còn hàng không em?");
      assert.ok(dItem?.trace?.code === "AI_SKIPPED_HUMAN_COOLDOWN" && /AI tiếp lúc \d{2}:\d{2}/.test(dItem.trace.ownership ?? ""), JSON.stringify(dItem?.trace));

      // ═══ E. Nhường KHÔNG xác minh (dòng cũ, không dấu) + ý định mua ⇒ AI tiếp ═══
      const E = "t-nhuong-mu";
      const convE = await opened(E);
      await db.update(c).set({ status: "HANDOFF", handoffReason: FANPAGE_STAFF_REASON, humanCooldownUntil: new Date(Date.now() + 25 * MIN) }).where(eq(c.id, convE));
      await receiveFanpageEvent(ev(E, "e.buy", "Lấy 1kg"));
      mark = pancake.calls.length;
      const rE = await processFanpageThread(PAGE, E, { fetch: pancake.fetch, now: at(31_000) });
      assert.ok(rE.replies >= 1 && pancake.sends(mark, E).length >= 1, `nhường mù + khách muốn mua ⇒ AI tiếp: ${JSON.stringify(rE)}`);
      const evE = await db.select().from(schema.salesConversationEvents).where(eq(schema.salesConversationEvents.conversationId, convE));
      assert.ok(evE.some((x) => x.type === "ai.resumed" && x.reasonCode === "UNVERIFIED_PAUSE_BUY_INTENT"), "để lại vết vì sao AI tiếp");

      // ═══ F. Tiếp quản tay ⇒ AI im; trả lại AI ⇒ đánh giá lại tồn MỘT lần (một câu cho cả lượt) ═══
      const F = "t-tiep-quan";
      const convF = await opened(F);
      assert.ok((await setConversationControlCore(admin, convF, "HUMAN")).ok);
      await receiveFanpageEvent(ev(F, "f.1", "Shop ơi"));
      await receiveFanpageEvent(ev(F, "f.2", "Ship Đà Nẵng được không?"));
      mark = pancake.calls.length;
      assert.equal((await processFanpageThread(PAGE, F, { fetch: pancake.fetch, now: at(31_000) })).replies, 0, "tiếp quản ⇒ AI im");
      assert.equal(pancake.sends(mark, F).length, 0);
      assert.ok((await setConversationControlCore(admin, convF, "AUTO")).ok);
      mark = pancake.calls.length;
      const rs1 = await resumeFanpageAfterPause({ fetch: pancake.fetch });
      assert.ok(rs1.resumed >= 1 && pancake.sends(mark, F).length === 1, `trả lại AI ⇒ MỘT câu cho lượt tồn: ${JSON.stringify(rs1)}`);
      mark = pancake.calls.length;
      await resumeFanpageAfterPause({ fetch: pancake.fetch });
      assert.equal(pancake.sends(mark, F).length, 0, "chạy lại không gửi bù lần hai");

      // ═══ G. Hết nhường (người thật trả lời 31 phút trước, khách hỏi TRONG lúc nhường) ⇒ đánh giá lại, MỘT lần ═══
      const G = "t-het-nhuong";
      const TG = new Date(Date.now() - 31 * MIN);
      // Dựng lịch sử theo đúng mốc: khách hỏi (đã xử lý) 2 phút trước TG · người thật trả lời lúc TG · khách hỏi tiếp lúc TG + 5'.
      await receiveFanpageEvent(ev(G, "g.0", "Chả cá thu bao nhiêu shop?"));
      await db.update(t).set({ createdAt: new Date(TG.getTime() - 2 * MIN), status: "DONE", processedAt: new Date(TG.getTime() - 2 * MIN) }).where(eq(t.messageId, "g.0"));
      await receiveFanpageEvent(ev(G, "g.staff", "Dạ em gửi chị bảng giá", { page: true, uid: true }), TG);
      await db.update(t).set({ createdAt: TG }).where(eq(t.messageId, "g.staff"));
      await receiveFanpageEvent(ev(G, "g.q", "1kg có miễn ship không?"), new Date(TG.getTime() + 5 * MIN));
      await db.update(t).set({ createdAt: new Date(TG.getTime() + 5 * MIN) }).where(eq(t.messageId, "g.q"));
      await processFanpageThread(PAGE, G, { fetch: pancake.fetch, now: () => new Date(TG.getTime() + 6 * MIN) });
      assert.equal((await rowOf("g.q")).note, FANPAGE_STAFF_REASON, "tin khách lúc nhường bị chốt (đúng luật nhường)");
      mark = pancake.calls.length;
      const rsG = await resumeFanpageAfterPause({ fetch: pancake.fetch });
      assert.ok(rsG.resumed >= 1 && pancake.sends(mark, G).length === 1, `hết nhường ⇒ trả lời lượt tồn: ${JSON.stringify(rsG)}`);
      mark = pancake.calls.length;
      await resumeFanpageAfterPause({ fetch: pancake.fetch });
      assert.equal(pancake.sends(mark, G).length, 0, "một lần mỗi lượt");

      // ═══ H. Webhook đồng thời: cùng tin tới hai lần, hai lượt xử lý chồng nhau ⇒ MỘT câu trả lời ═══
      const H = "t-dong-thoi";
      await opened(H);
      await Promise.all([receiveFanpageEvent(ev(H, "h.q", "Còn chả mực không em?")), receiveFanpageEvent(ev(H, "h.q", "Còn chả mực không em?"))]);
      mark = pancake.calls.length;
      await Promise.all([processFanpageThread(PAGE, H, { fetch: pancake.fetch, now: at(31_000) }), processFanpageThread(PAGE, H, { fetch: pancake.fetch, now: at(31_000) })]);
      assert.equal(pancake.sends(mark, H).length, 1, "một quyết định, một câu trả lời");

      // ═══ I. Khách hỏi lại giá sau khi đã được báo ⇒ AI trả lời lại (giá do báo giá máy chủ — authoritative-quote) ═══
      const I = "t-hoi-lai";
      await opened(I);
      await receiveFanpageEvent(ev(I, "i.q", "Chả cá thu bao nhiêu shop?"));
      mark = pancake.calls.length;
      assert.ok((await processFanpageThread(PAGE, I, { fetch: pancake.fetch, now: at(31_000) })).replies >= 1 && pancake.sends(mark, I).length >= 1, "hỏi lại giá ⇒ trả lời");

      // ═══ J. Nhân viên trả lời trên Pancake TRƯỚC khi bot xử lý (Pancake có, webhook chưa tới) ⇒ không trả lời đôi ═══
      const J = "t-pancake-truoc";
      await opened(J);
      await receiveFanpageEvent(ev(J, "j.q", "Có giao chiều nay không?"));
      const now = Date.now();
      const iso = (ms: number) => new Date(ms).toISOString().replace("Z", "");
      threadMessages.set(J, [
        { id: "j.q", inserted_at: iso(now - 2_000), from: { id: "cust" }, message: "Có giao chiều nay không?" },
        { id: "j.staff", inserted_at: iso(now - 1_000), from: { id: PAGE, uid: "u-nv" }, message: "Dạ chiều nay em giao ạ" },
      ]);
      mark = pancake.calls.length;
      const rJ = await processFanpageThread(PAGE, J, { fetch: pancake.fetch, now: at(31_000) });
      assert.ok(rJ.replies === 0 && pancake.sends(mark, J).length === 0 && (await rowOf("j.q")).note === PAGE_REPLIED_REASON, `nhân viên đã trả lời ⇒ AI không chen: ${JSON.stringify(rJ)}`);

      // ═══ L. TIN MẪU TỰ ĐỘNG giữa cuộc chat (đo production 11/10: 211/307 lượt không ai trả lời 30′ do tin mẫu): cùng chữ ≥ 40 ký tự
      // ở các hội thoại khác — kể cả khác xuống dòng / khoảng trắng — ⇒ PANCAKE_AUTOMATION: không nhường, KHÔNG đóng câu hỏi trước nó. ═══
      const TPL = "Dạ em chào anh/chị ! Chả cá thu bên em hiện đang có giá: 1kg giá 280k · 2kg giảm còn 540k, em miễn ship";
      for (const [other, text] of [["tpl-x", TPL], ["tpl-y", TPL.replace(/ · /g, "\n· ")]] as const) await db.insert(t).values({ pageId: PAGE, threadId: other, messageId: `${other}.p`, text, status: "DONE", processedAt: new Date(), note: PAGE_REPLY });
      const L = "t-tin-mau";
      await opened(L);
      await receiveFanpageEvent(ev(L, "l.q", "Ship về Thủ Đức mất mấy ngày shop?"));
      assert.match((await receiveFanpageEvent(ev(L, "l.tpl", `  ${TPL.replace(/ · /g, "\n\n· ")}  `, { page: true }))).reason, /Tin mẫu tự động/);
      assert.ok((await rowOf("l.tpl")).senderKind === "PANCAKE_AUTOMATION" && (await convOf(L)).status !== "HANDOFF", "tin mẫu ⇒ tự động, không khoá AI");
      mark = pancake.calls.length;
      const rL = await processFanpageThread(PAGE, L, { fetch: pancake.fetch, now: at(31_000) });
      assert.ok(rL.replies >= 1 && pancake.sends(mark, L).length >= 1 && (await rowOf("l.q")).note !== PAGE_REPLIED_REASON, `câu hỏi trước tin mẫu vẫn được AI trả lời: ${JSON.stringify(rL)}`);

      // ═══ M. «Tin khách chưa đọc»: MỘT định nghĩa, HAI dạng — TS `latestTurnHandled` ≡ SQL `latestCustomerTurnUnhandledSql` trên cùng dữ liệu ═══
      {
        const cv = schema.salesChatConversations;
        const sm = schema.salesChatStaffMessages;
        const T0 = new Date(Date.now() - 3 * 60 * MIN).getTime();
        const at2 = (ms: number) => new Date(T0 + ms);
        type Row = { id: string; kind: "C" | "BOT" | "STAFF" | "PAGE"; at: number; src?: number | null; sender?: string | null; text?: string; status?: string; staff?: string };
        type WebRow = { seq: number; role: "user" | "assistant"; text?: string | null; at: number };
        const cases: { name: string; rows: Row[]; read?: number | null; seen?: number | null; web?: WebRow[]; expect: boolean }[] = [];
        const prior: Row[] = [{ id: "p0", kind: "C", at: -60 * MIN }, { id: "pb", kind: "BOT", at: -60 * MIN + 5_000 }];
        const add = (name: string, expect: boolean, rows: Row[], read: number | null = null, seen: number | null = null) => cases.push({ name, rows, read, seen, expect });
        const addWeb = (name: string, expect: boolean, web: WebRow[], seen: number | null = null) => cases.push({ name, rows: [], web, seen, expect });
        add("customer", true, [...prior, { id: "c", kind: "C", at: 0 }]);
        add("ai-valid", false, [...prior, { id: "c", kind: "C", at: 0 }, { id: "b", kind: "BOT", at: 5_000 }]);
        add("staff-valid", false, [...prior, { id: "c", kind: "C", at: 0 }, { id: "s", kind: "STAFF", at: 5_000, staff: "SENT" }]);
        add("page-valid", false, [...prior, { id: "c", kind: "C", at: 0 }, { id: "pg", kind: "PAGE", at: 2 * MIN, sender: "UNKNOWN" }]);
        add("human-open", false, [...prior, { id: "c", kind: "C", at: 0 }], MIN);
        add("ai-then-new", true, [...prior, { id: "c", kind: "C", at: 0 }, { id: "b", kind: "BOT", at: 5_000 }, { id: "c2", kind: "C", at: MIN }]);
        add("staff-then-new", true, [...prior, { id: "c", kind: "C", at: 0 }, { id: "s", kind: "STAFF", at: 5_000, staff: "SENT" }, { id: "c2", kind: "C", at: MIN }]);
        add("only-bot", false, [{ id: "b", kind: "BOT", at: 0 }]);
        add("only-staff", false, [{ id: "s", kind: "STAFF", at: 0, staff: "SENT" }]);
        add("only-page", false, [{ id: "pg", kind: "PAGE", at: 0, sender: "UNKNOWN" }]);
        add("staff-failed", true, [...prior, { id: "c", kind: "C", at: 0 }, { id: "s", kind: "STAFF", at: 5_000, staff: "FAILED" }]);
        add("staff-sending", true, [...prior, { id: "c", kind: "C", at: 0 }, { id: "s", kind: "STAFF", at: 5_000, staff: "SENDING" }]);
        add("bot-unseen", true, [...prior, { id: "c", kind: "C", at: 0, status: "PENDING" }, { id: "b", kind: "BOT", at: 5_000 }]);
        add("greeting", true, [{ id: "c", kind: "C", at: 0 }, { id: "g", kind: "PAGE", at: 10_000, sender: "UNKNOWN" }]);
        add("automation", true, [...prior, { id: "c", kind: "C", at: 0 }, { id: "a", kind: "PAGE", at: 5_000, sender: "PANCAKE_AUTOMATION" }]);
        add("legacy-meta-system", true, [...prior, { id: "c", kind: "C", at: 0 }, { id: "m", kind: "PAGE", at: 5 * MIN, sender: null, text: `${META_NOTICE} (link)` }]);
        add("legacy-template", true, [...prior, { id: "c", kind: "C", at: 0 }, { id: "lt", kind: "PAGE", at: 5 * MIN, sender: null, text: `${TPL_PARITY}\n` }]);
        add("legacy-text", false, [...prior, { id: "c", kind: "C", at: 0 }, { id: "lx", kind: "PAGE", at: 5 * MIN, sender: null, text: "Dạ em kiểm hàng rồi báo chị ngay ạ" }]);
        add("ambiguous-30s", true, [...prior, { id: "c", kind: "C", at: 0 }, { id: "u", kind: "PAGE", at: 30_000, sender: "UNKNOWN" }]);
        add("source-after", false, [...prior, { id: "c", kind: "C", at: 0, src: 0 }, { id: "u", kind: "PAGE", at: 3_000, src: 1_000, sender: "UNKNOWN" }]);
        add("read-old", true, [...prior, { id: "c", kind: "C", at: 0 }], -MIN);
        add("other-app", false, [...prior, { id: "c", kind: "C", at: 0, src: 0 }, { id: "oa", kind: "PAGE", at: 5_000, src: 2_000, sender: "OTHER_APP" }]);
        add("other-app-ambiguous", true, [...prior, { id: "c", kind: "C", at: 0 }, { id: "oa", kind: "PAGE", at: 5_000, sender: "OTHER_APP" }]);
        add("verified-source-before", true, [...prior, { id: "c", kind: "C", at: 0, src: 0 }, { id: "v", kind: "PAGE", at: 90_000, src: -1_000, sender: "VERIFIED_HUMAN" }]);
        add("meta-system", true, [...prior, { id: "c", kind: "C", at: 0 }, { id: "ms", kind: "PAGE", at: 5 * MIN, sender: "META_SYSTEM" }]);
        // (a) Nhãn dán / ghi âm (MEDIA_ONLY) LÀ lượt khách với hàng đợi người — «không bỏ sót khách».
        add("media-after-ai", true, [...prior, { id: "c", kind: "C", at: 0 }, { id: "b", kind: "BOT", at: 5_000 }, { id: "st", kind: "C", at: MIN, status: "DONE", text: "" }]);
        add("media-only", true, [{ id: "st", kind: "C", at: 0, status: "DONE", text: "" }]);
        add("media-then-staff", false, [...prior, { id: "st", kind: "C", at: 0, status: "DONE", text: "" }, { id: "s", kind: "STAFF", at: 5_000, staff: "SENT" }]);
        // (b) Mốc mở cấp cửa hàng cũ `staff_seen_at` là bằng chứng người mở.
        add("staff-seen-after", false, [...prior, { id: "c", kind: "C", at: 0 }], null, MIN);
        add("staff-seen-before", true, [...prior, { id: "c", kind: "C", at: 0 }], null, -MIN);
        // Tin mẫu dòng cũ: cửa sổ NEO theo mốc của chính dòng — câu giống hệt nhưng chỉ xuất hiện ở hội thoại khác SAU nó ⇒ chưa là mẫu.
        add("legacy-template-later-seed", false, [...prior, { id: "c", kind: "C", at: 0 }, { id: "lt2", kind: "PAGE", at: 5 * MIN, sender: null, text: TPL_PARITY_LATER }]);
        // (c) Chat web: dòng `user` có chữ là lượt khách; `assistant` có chữ sau nó / người mở là xử lý; dòng kết quả công cụ không phải khách.
        addWeb("web-customer", true, [{ seq: 1, role: "user", text: "Shop ơi", at: 0 }]);
        addWeb("web-replied", false, [{ seq: 1, role: "user", text: "Shop ơi", at: 0 }, { seq: 2, role: "assistant", text: "Dạ em đây", at: 5_000 }]);
        addWeb("web-replied-new", true, [{ seq: 1, role: "user", text: "Shop ơi", at: 0 }, { seq: 2, role: "assistant", text: "Dạ em đây", at: 5_000 }, { seq: 3, role: "user", text: "Giá sao em", at: MIN }]);
        addWeb("web-tool-row", false, [{ seq: 1, role: "user", text: "Shop ơi", at: 0 }, { seq: 2, role: "assistant", text: "Dạ em đây", at: 5_000 }, { seq: 3, role: "user", text: null, at: 6_000 }]);
        addWeb("web-staff-seen", false, [{ seq: 1, role: "user", text: "Shop ơi", at: 0 }], MIN);
        addWeb("web-staff-reply", false, [{ seq: 1, role: "user", text: "Shop ơi", at: 0 }, { seq: 2, role: "assistant", text: "[Shop đã nhắn] Dạ chị đợi em", at: 5_000 }]);
        // Tin mẫu cũ: cùng khoá ở một hội thoại KHÁC trong 7 ngày.
        await db.insert(t).values({ pageId: PAGE, threadId: "u-tpl-other", messageId: "u-tpl-other.p", text: TPL_PARITY, status: "DONE", processedAt: at2(-10 * MIN), createdAt: at2(-10 * MIN), note: PAGE_REPLY });
        await db.insert(t).values({ pageId: PAGE, threadId: "u-tpl-other", messageId: "u-tpl-other.later", text: TPL_PARITY_LATER, status: "DONE", processedAt: at2(20 * MIN), createdAt: at2(20 * MIN), note: PAGE_REPLY });
        const ids: string[] = [];
        for (const k of cases) {
          const thread = `u-${k.name}`;
          const [conv] = await db
            .insert(cv)
            .values(k.web ? { channel: "WEB", visitorKey: `vk-${thread}`, ...(k.seen != null ? { staffSeenAt: at2(k.seen) } : {}) } : { channel: "FANPAGE", pageId: PAGE, threadId: thread, visitorKey: `vk-${thread}`, ...(k.seen != null ? { staffSeenAt: at2(k.seen) } : {}) })
            .returning({ id: cv.id });
          ids.push(conv.id);
          for (const w of k.web ?? []) await db.insert(schema.salesChatMessages).values({ conversationId: conv.id, seq: w.seq, role: w.role, content: w.text === null ? [{ type: "tool_result", toolUseId: "x", content: "{}" }] : [{ type: "text", text: w.text ?? "" }], createdAt: at2(w.at) });
          for (const r of k.rows) {
            const mid = `${thread}.${r.id}`;
            const base = { pageId: PAGE, threadId: thread, createdAt: at2(r.at), sourceAt: r.src === undefined || r.src === null ? null : at2(r.src), processedAt: at2(r.at) };
            if (r.kind === "C") await db.insert(t).values({ ...base, messageId: mid, text: r.text ?? "Shop ơi", status: r.status ?? "DONE", note: r.text === "" ? "MEDIA_ONLY" : null });
            else if (r.kind === "BOT") await db.insert(t).values({ ...base, messageId: mid, text: "Dạ em đây ạ", status: "DONE", note: "BOT_SENT" });
            else if (r.kind === "STAFF") {
              const [st] = await db.insert(sm).values({ conversationId: conv.id, requestKey: `rk-${mid}`, userId: admin.id, channel: "FANPAGE", text: "Dạ em báo chị", status: r.staff ?? "SENT" }).returning({ id: sm.id });
              await db.insert(t).values({ ...base, messageId: `${STAFF_OUT_PREFIX}${st.id}:0`, text: "Dạ em báo chị", status: "DONE", note: PAGE_REPLY });
            } else await db.insert(t).values({ ...base, messageId: mid, text: r.text ?? "Dạ chị chờ em chút", status: "DONE", note: PAGE_REPLY, senderKind: r.sender ?? null });
          }
          if (k.read !== null && k.read !== undefined) await db.insert(schema.salesChatReads).values({ conversationId: conv.id, userId: admin.id, readThroughAt: at2(k.read) });
        }
        const nowP = new Date();
        const sqlRows = await db.select({ id: cv.id, unread: latestCustomerTurnUnhandledSql() }).from(cv).where(inArray(cv.id, ids));
        const sqlOf = new Map(sqlRows.map((r) => [r.id, Boolean(r.unread)]));
        for (const [i, k] of cases.entries()) {
          const ts = await latestTurnStateOf(ids[i], nowP);
          assert.ok(ts, k.name);
          assert.equal(!ts.handled, k.expect, `TS «${k.name}»: ${JSON.stringify(ts)}`);
          assert.equal(sqlOf.get(ids[i]), k.expect, `SQL «${k.name}» phải bằng TS`);
        }
        // Chữ hệ thống: bản SQL của mẫu khớp bản JS trên cùng các câu.
        for (const txt of [META_NOTICE, "You're replying to a comment on your Page", "Dư Thị Liên đã trả lời một quảng cáo.", "Đã thêm nhãn tự động: …", "Dạ em gửi chị bảng giá", "Chị cho em xin địa chỉ"]) {
          const [r] = rowsOfPg(await db.execute(sql`select (${txt} ~* ${META_SYSTEM_TEXT_SQL_RE}) as hit`));
          assert.equal(Boolean(r?.hit), META_SYSTEM_TEXT_RE.test(txt), `mẫu chữ hệ thống JS ≡ SQL: «${txt}»`);
        }
      }

      // ═══ K. Câu đếm bảng điều khiển + hàng đợi cứu đơn trên dữ liệu thật của tổ chức ═══
      const K = "t-cuu-don";
      await db.insert(t).values([
        { pageId: PAGE, threadId: K, messageId: "k.g", text: GREETING, status: "DONE", processedAt: new Date(Date.now() - 50 * MIN), note: PAGE_REPLY, senderKind: "PANCAKE_AUTOMATION", createdAt: new Date(Date.now() - 50 * MIN) },
        { pageId: PAGE, threadId: K, messageId: "k.buy", text: "Lấy 2kg", status: "SKIPPED", processedAt: new Date(Date.now() - 50 * MIN), note: PAGE_REPLIED_REASON, createdAt: new Date(Date.now() - 50 * MIN + 2_000) },
      ]);
      const metrics = await loadResponseOwnershipMetrics({ since: new Date(Date.now() - 3 * 60 * MIN), falseAnsweredNote: PAGE_REPLIED_REASON });
      assert.ok(metrics.falseAnswered >= 1 && metrics.unknownSender >= 1 && metrics.customerTurns > metrics.unansweredTurns, JSON.stringify(metrics));
      const queue = await loadRescueQueue({ since: new Date(Date.now() - 3 * 60 * MIN) });
      assert.ok(queue.some((q) => q.lastMessageId === "k.buy" && q.intentKind === "BUY_WORDS"), JSON.stringify(queue));
      const dq = queue.find((q) => q.lastMessageId === "d.buy2");
      assert.ok(dq && dq.owner === "TEMPORARY_AI_PAUSE", `lượt «Lấy 1kg» lúc người thật cầm nằm trong hàng đợi cứu đơn, mang đúng chủ: ${JSON.stringify(dq)}`);
    });
  } finally {
    setSalesChatProviderForTests(null);
  }
}

export async function testResponseOwnership() {
  testPure();
  const savedKey = process.env.PLATFORM_SECRETS_KEY;
  process.env.PLATFORM_SECRETS_KEY = "khoa-kiem-thu-tra-loi-dung-luot-0123456789abcdefghijklmnopqrstuvwxyz";
  try {
    await cleanupOrg(ORG);
    await testFlow();
  } finally {
    if (savedKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = savedKey;
    await cleanupOrg(ORG);
  }
  console.log("✓ Lượt khách & chủ trả lời: tin chào / tự động / chữ hệ thống không còn là «đã trả lời» (Uyen Tran) hay «người» (Lê Bạch Nguyên); thứ tự theo mốc nguồn; một lượt — một câu; chỉ người đã xác minh làm AI nhường, UNKNOWN không nhường mù; «Lấy 1kg» lúc nhường: người cầm ⇒ báo, nhường mù ⇒ AI tiếp; hết nhường / trả lại ⇒ đánh giá lại tồn một lần; webhook đồng thời một câu; câu đếm + hàng đợi cứu đơn");
}

if (process.argv[1] && /response-ownership.test.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testResponseOwnership)
    .then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
}

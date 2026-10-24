/**
 * ═══════════ OPS `stuck-conversation-audit` — HỘI THOẠI AI BÁN HÀNG KẸT Ở ĐÂU (HOTFIX P0 12/10/2026, ca «Khanh Nhung») ═══════════
 *
 * Đo TRƯỚC khi sửa. Bài kiểm khoá:
 *  1. THUẦN: cú pháp đối số (`<mã>` | `--all` · `--days` · `--conv` · `--order`), phân nhóm lý do (chờ người · lỗi kỹ thuật · tạm dừng
 *     có chủ đích) — riêng «AI hỏng mà đồng hồ `updated_at` bị đẩy» tách khỏi «AI hỏng đang chờ thử lại»; mốc im lặng ưu tiên dấu hàng
 *     đợi → `state.handoff.at` → `updated_at` (ước tính); câu «khách nói đã nhận hàng» bản TS = bản SQL.
 *  2. Bản sao chữ (script tự chứa vì ops lấy lib từ image) BẰNG hằng gốc.
 *  3. PGlite: số đếm khớp tay trên một tổ chức dựng sẵn — A (nhóm × ngưỡng phút), D (nhắn lại sau đơn), E (đơn chốt quá hạn chưa vận
 *     đơn · lời khách «đã nhận hàng» khi chưa có chứng từ giao · thiếu xã).
 *  4. MÃ NGUỒN: chỉ đọc (Postgres ép + hỏi lại), không câu ghi, không nhập lib của bản vá, tóm tắt không mang mã; ops-vps khai đủ bốn chỗ.
 * Mốc thời gian đi theo đồng hồ THẬT (AGENTS 50).
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { AI_DOWN_HANDOFF_REASON, FANPAGE_STAFF_REASON, HUMAN_COOLDOWN_MINUTES, ZALO_STAFF_REASON } from "@/lib/sales-chatbot/ai-hold-shared";
import { TAKEOVER_REASON } from "@/lib/sales-chatbot/conversation-control-shared";
import { WEB_STAFF_REASON } from "@/lib/sales-chatbot/inbox-states";
import { ORDER_WRITE_HANDOFF_PREFIX } from "@/lib/constants/ops-signals";
import { PRICE_UNVERIFIED_PREFIX } from "@/lib/sales-chatbot/quote-shared";
import { RESUME_MAX_TURN_AGE_MS } from "@/lib/sales-chatbot/response-ownership";
import { WATCHDOG_MAX_PER_SWEEP } from "@/lib/sales-chatbot/handoff-routing";
import { DEAD_AI_DOWN_NOTE } from "@/lib/sales-chatbot/inbound-retry";
import { SALES_QUALITY_CODES } from "@/lib/constants/sales-quality";
import {
  addSilent,
  AI_DOWN_RETRY_MINUTES,
  classifyStuck,
  collectOrders,
  collectOwnership,
  collectSilent,
  collectWorkQueueFacts,
  emptyCounts,
  handoffReplyClass,
  handoffReplySplit,
  replySplitSummary,
  type HandoffReplyFact,
  parseStuckArgs,
  QUALITY_BASE_FIELD,
  QUALITY_MIN_SAMPLE,
  qualityStateSummary,
  queueSetSummary,
  RECEIPT_CLAIM_RE,
  RECEIPT_CLAIM_SQL_RE,
  REASON_TEXT,
  DEAD_AI_DOWN_NOTE_TEXT,
  RESUME_WINDOW_MINUTES,
  WATCHDOG_CAP,
  silentSince,
  silentSummary,
  type SilentRow,
} from "@/scripts/stuck-conversation-audit";

const ORG = "ket-hoi-thoai-audit";
const PAGE = "pg-ket";
const MIN = 60_000;

function testPure() {
  assert.deepEqual(parseStuckArgs(["--all"]), { all: true, code: null, days: 7, conv: null, order: null });
  assert.deepEqual(parseStuckArgs(["hslc-hmt-shop", "--days=30"]), { all: false, code: "hslc-hmt-shop", days: 30, conv: null, order: null });
  assert.deepEqual(parseStuckArgs(["hslc", "--order=#6495CA72"]), { all: false, code: "hslc", days: 7, conv: null, order: "6495ca72" });
  for (const bad of [[], ["HSLC"], ["a", "b"], ["--all", "x"], ["x", "--days=31"], ["x", "--days=0"], ["x", "--conv=abc"], ["x", "--order=zz"], ["--all", "--order=6495ca72"], ["x", "--limit=3"]]) assert.ok("error" in parseStuckArgs(bad), JSON.stringify(bad));

  const now = new Date();
  const ago = (m: number) => new Date(now.getTime() - m * MIN);
  const base: SilentRow = { status: "HANDOFF", reason: null, mode: null, handoffAt: null, handoffReason: null, updatedAt: ago(5), cooldownUntil: null, queuedAt: null };
  assert.equal(classifyStuck({ ...base, mode: "HUMAN", reason: "bất kỳ" }, now), "TAKEOVER");
  assert.equal(classifyStuck({ ...base, reason: TAKEOVER_REASON }, now), "TAKEOVER");
  assert.equal(classifyStuck({ ...base, reason: FANPAGE_STAFF_REASON, cooldownUntil: new Date(now.getTime() + MIN) }, now), "STAFF_PAUSE_ACTIVE");
  assert.equal(classifyStuck({ ...base, reason: ZALO_STAFF_REASON, cooldownUntil: ago(1) }, now), "STAFF_PAUSE_EXPIRED");
  assert.equal(classifyStuck({ ...base, reason: WEB_STAFF_REASON }, now), "WEB_STAFF");
  // AI hỏng: hỏng thật 600 phút trước, nhưng `updated_at` vừa bị đẩy 5 phút trước ⇒ hộp thư còn coi là «đang chờ thử lại».
  assert.equal(classifyStuck({ ...base, reason: AI_DOWN_HANDOFF_REASON, handoffReason: AI_DOWN_HANDOFF_REASON, handoffAt: ago(600) }, now), "AI_DOWN_CLOCK_PUSHED");
  assert.equal(classifyStuck({ ...base, reason: AI_DOWN_HANDOFF_REASON, handoffReason: AI_DOWN_HANDOFF_REASON, handoffAt: ago(10) }, now), "AI_DOWN_ACTIVE");
  assert.equal(classifyStuck({ ...base, reason: AI_DOWN_HANDOFF_REASON, updatedAt: ago(45) }, now), "AI_DOWN_EXPIRED");
  assert.equal(classifyStuck({ ...base, reason: AI_DOWN_HANDOFF_REASON, queuedAt: ago(120) }, now), "AI_DOWN_CLOCK_PUSHED", "thiếu state.handoff ⇒ mốc vào hàng đợi");
  assert.equal(classifyStuck({ ...base, reason: "Khách nhắn sau khi đã chốt đơn — nhân viên xử lý (đổi địa chỉ / lịch giao / hỏi thêm)" }, now), "POST_ORDER");
  assert.equal(classifyStuck({ ...base, reason: "Khách báo đã chuyển khoản — cần nhân viên đối soát (bot không xác nhận tiền)" }, now), "PAYMENT_CLAIM");
  assert.equal(classifyStuck({ ...base, reason: "AI định khẳng định đã chốt đơn khi chưa có đơn ERP — đã chặn câu, nhân viên kiểm đơn" }, now), "CLAIM_GUARD");
  assert.equal(classifyStuck({ ...base, reason: `${PRICE_UNVERIFIED_PREFIX}: x` }, now), "PRICE");
  assert.equal(classifyStuck({ ...base, reason: `${ORDER_WRITE_HANDOFF_PREFIX} — đơn #ABCDEF12 chưa cập nhật được` }, now), "ORDER_WRITE");
  assert.equal(classifyStuck({ ...base, reason: "Cần người xử lý — Tồn kho bất thường: 1 mã" }, now), "TOOL_REQUIRE");
  assert.equal(classifyStuck({ ...base, reason: "Khách huỷ đơn #ABCDEF12 — đơn đã gửi" }, now), "CANCEL");
  assert.equal(classifyStuck({ ...base, reason: "Hội thoại quá dài" }, now), "LONG");
  assert.equal(classifyStuck({ ...base, reason: "Khiếu nại — hàng hỏng" }, now), "MODEL_HANDOFF");
  assert.equal(classifyStuck({ ...base, reason: null }, now), "NO_REASON");

  assert.deepEqual(silentSince({ ...base, queuedAt: ago(1500), handoffAt: ago(1600) }), { at: ago(1500), estimated: false }, "dấu hàng đợi trước");
  assert.deepEqual(silentSince({ ...base, handoffAt: ago(1600) }), { at: ago(1600), estimated: false });
  assert.deepEqual(silentSince(base), { at: base.updatedAt, estimated: true }, "chỉ còn updated_at ⇒ ƯỚC TÍNH");

  const c = emptyCounts();
  addSilent(c, { ...base, reason: "Khách nhắn sau khi đã chốt đơn — x", queuedAt: ago(1520) }, true, now);
  addSilent(c, { ...base, reason: AI_DOWN_HANDOFF_REASON, handoffReason: AI_DOWN_HANDOFF_REASON, handoffAt: ago(300) }, false, now);
  addSilent(c, { ...base, mode: "HUMAN" }, false, now);
  assert.equal(c.silent, 3);
  assert.deepEqual(c.byClass.POST_ORDER, { total: 1, over: [1, 1, 1] });
  assert.deepEqual(c.byClass.AI_DOWN_CLOCK_PUSHED, { total: 1, over: [1, 1, 0] });
  assert.equal(c.customerWaiting, 1);
  assert.equal(c.estimated, 1, "hội thoại tiếp quản không có dấu ⇒ ước tính");
  assert.deepEqual(c.longest, { minutes: 1520, cls: "POST_ORDER" });
  const lines = silentSummary("demo", c);
  assert.match(lines[0], /AI im 3 hội thoại: chờ người 1 · lỗi kỹ thuật 1 · tạm dừng có chủ đích 1 · khách đang chờ trả lời 1 · mốc ước tính 1 · lâu nhất 1520 phút \(POST_ORDER\)/);

  // A2 — tin khách cuối đã có ai trả lời chưa (chủ shop 21/10/2026: «chưa ai cầm» mà đã trả lời thì không phải lỗi).
  const H = 3_600_000;
  const f0: HandoffReplyFact = { lastCustomerAt: ago(30 * 60), lastBotAt: null, lastStaffAt: null, pageHumanAt: null, pageVerifiedAt: null, pageAiAt: null, handoffAt: ago(31 * 60) };
  assert.equal(handoffReplyClass(f0, now, 4 * H), "UNANSWERED_OVER_SLA", "khách nhắn sau lúc chuyển, 30 giờ không ai trả lời");
  assert.equal(handoffReplyClass(f0, now, 48 * H), "UNANSWERED_WITHIN_SLA");
  assert.equal(handoffReplyClass(f0, now, null), "UNANSWERED_NO_SLA", "không có hạn ⇒ không kết luận quá hạn");
  assert.equal(handoffReplyClass({ ...f0, pageHumanAt: ago(29 * 60) }, now, 4 * H), "ANSWERED_HUMAN", "nhân viên trả lời trên Pancake (dòng PAGE_REPLY) = đã trả lời");
  assert.equal(handoffReplyClass({ ...f0, lastStaffAt: ago(29 * 60) }, now, 4 * H), "ANSWERED_HUMAN", "trả lời từ hộp thư ERP");
  assert.equal(handoffReplyClass({ ...f0, pageHumanAt: ago(31 * 60) }, now, 4 * H), "UNANSWERED_OVER_SLA", "trả lời TRƯỚC tin khách cuối không tính");
  assert.equal(handoffReplyClass({ ...f0, pageHumanAt: f0.lastCustomerAt }, now, 4 * H), "UNANSWERED_OVER_SLA", "cùng mốc không phải sau");
  assert.equal(handoffReplyClass({ ...f0, pageAiAt: ago(29 * 60) }, now, 4 * H), "ANSWERED_BOT", "tiếng vọng của bot không phải người");
  assert.equal(handoffReplyClass({ ...f0, lastCustomerAt: null }, now, 4 * H), "NO_CUSTOMER_MESSAGE");
  // Tin GÂY RA lượt chuyển (khách nhắn rồi mới chuyển) chưa ai trả lời ⇒ vẫn là lỗi, dù khách không nhắn gì sau lúc chuyển.
  const trigger: HandoffReplyFact = { ...f0, lastCustomerAt: ago(31 * 60), handoffAt: ago(30 * 60) };
  const sp = handoffReplySplit(
    [f0, trigger, { ...f0, pageHumanAt: ago(29 * 60) }, { ...f0, pageHumanAt: ago(29 * 60), pageVerifiedAt: ago(29 * 60) }, { ...trigger, lastBotAt: ago(31 * 60 - 1) }, { ...f0, lastCustomerAt: ago(80 * 60), handoffAt: null }, { ...f0, lastCustomerAt: ago(60) }],
    now,
    4 * H,
  );
  assert.equal(sp.total, 7);
  assert.deepEqual([sp.byClass.ANSWERED_HUMAN, sp.answeredUnverified, sp.byClass.ANSWERED_BOT, sp.byClass.UNANSWERED_OVER_SLA, sp.byClass.UNANSWERED_WITHIN_SLA], [2, 1, 1, 3, 1]);
  assert.deepEqual([sp.overSla24h, sp.overSla72h], [3, 1]);
  assert.deepEqual([sp.quietTotal, sp.quietAfterHandoff.UNANSWERED_OVER_SLA, sp.quietAfterHandoff.ANSWERED_BOT, sp.handoffUnknown], [2, 1, 1, 1], "(c) cắt ngang: tin gây ra lượt chuyển chưa ai trả lời vẫn đếm vào (b)");
  const sl = replySplitSummary("demo", sp, 4 * H);
  assert.equal(sl.length, 3, "A2 tách ba dòng: (a) · (b) · (c)");
  assert.match(sl[0], /^demo A2 · 7 hội thoại chờ người — \(a\) ĐÃ có người\/page trả lời sau tin khách cuối 2 \(trong đó chỉ dòng page chưa rõ người gửi 1\) · bot đã trả lời tin khách cuối 1$/);
  assert.match(sl[1], /\(b\) HANDOFF_UNANSWERED \(không ai trả lời, quá SLA 4 giờ \(work\.sla\)\) 3 \(> 24 giờ 3 · > 72 giờ 1\)/);
  assert.match(sl[2], /\(c\) khách KHÔNG nhắn gì sau lúc chuyển 2\/6 \(mốc chuyển không rõ 1\)/);
  assert.match(replySplitSummary("demo", handoffReplySplit([f0], now, null), null)[1], /quá SLA KHÔNG đọc được \/ không đặt hạn\) 0 .* không có hạn 1/);
  assert.ok(replySplitSummary("demo", sp, 4 * H, "A2[/work]").every((l) => l.startsWith("demo A2[/work] · ")), "nhãn tập đứng đầu mỗi dòng");
  // Kênh [ops:tom-tat] cắt ở 300 ký tự (dòng gộp cũ mất đúng phần (b)): mọi dòng phải lọt, kể cả mã tổ chức dài và số năm chữ số.
  const big = JSON.parse(JSON.stringify(sp), (_k, v: unknown) => (typeof v === "number" ? 99_999 : v)) as typeof sp;
  for (const l of [...replySplitSummary("hslc-hmt-shop", big, 999 * H, "A2[/work]"), ...replySplitSummary("hslc-hmt-shop", big, null, "A2[/work]")]) assert.ok(l.length <= 300, `${l.length} ký tự > 300: ${l}`);

  // Hai tập chờ người: phần giao + hai phần lệch, HANDOFF_UNANSWERED của từng tập.
  assert.equal(
    queueSetSummary("demo", ["a", "b", "c", "c"], ["b", "c", "d", "e"], ["a", "b"], ["b", "d"]),
    "demo A2 · HAI TẬP chờ người: cũ (nhóm WAITING_HUMAN của script) 3 · /work = 2B (aiSilentSql) 4 · chung 2 · chỉ tập cũ 1 · chỉ /work 2 · HANDOFF_UNANSWERED cũ 2 · /work 2 (số 2B) · chung 1",
  );
  const many = Array.from({ length: 20_000 }, (_, i) => `x${i}`);
  assert.ok(queueSetSummary("hslc-hmt-shop", many, many, many, many).length <= 300, "dòng hai tập lọt kênh tóm tắt");

  for (const yes of ["Tôi nhận hàng rồi nhưng chưa thử chất lượng", "em đã nhận được hàng", "hàng về rồi shop ơi", "mình vừa nhận hàng"]) assert.ok(RECEIPT_CLAIM_RE.test(yes), yes);
  for (const no of ["khi nào nhận hàng", "không nhận hàng đâu", "nhận hàng ở đâu"]) assert.ok(!RECEIPT_CLAIM_RE.test(no), no);
  console.log("  ✓ đối số · nhóm lý do (AI hỏng: đồng hồ bị đẩy ≠ đang chờ thử lại) · mốc im lặng (ước tính khi chỉ có updated_at) · tóm tắt · câu «đã nhận hàng»");
}

function testCopies() {
  assert.equal(REASON_TEXT.AI_DOWN, AI_DOWN_HANDOFF_REASON);
  assert.equal(REASON_TEXT.FANPAGE_STAFF, FANPAGE_STAFF_REASON);
  assert.equal(REASON_TEXT.ZALO_STAFF, ZALO_STAFF_REASON);
  assert.equal(REASON_TEXT.WEB_STAFF, WEB_STAFF_REASON);
  assert.equal(REASON_TEXT.TAKEOVER, TAKEOVER_REASON);
  assert.equal(REASON_TEXT.ORDER_WRITE_PREFIX, ORDER_WRITE_HANDOFF_PREFIX);
  assert.ok(PRICE_UNVERIFIED_PREFIX.startsWith(REASON_TEXT.PRICE_PREFIX));
  assert.equal(AI_DOWN_RETRY_MINUTES, HUMAN_COOLDOWN_MINUTES);
  assert.equal(RESUME_WINDOW_MINUTES * 60_000, RESUME_MAX_TURN_AGE_MS);
  assert.equal(WATCHDOG_CAP, WATCHDOG_MAX_PER_SWEEP);
  assert.equal(DEAD_AI_DOWN_NOTE_TEXT, DEAD_AI_DOWN_NOTE);
  console.log("  ✓ bản sao chữ / số của script tự chứa BẰNG hằng gốc");
}

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

async function testDb() {
  await cleanup();
  try {
    await provisionOrganization({ code: ORG, name: "Shop đo hội thoại kẹt", plan: "standard", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "Chủ shop", password: "KetHoi@123456" }, source: "TEST", actor: null });
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const c = schema.salesChatConversations;
      const now = new Date();
      const ago = (m: number) => new Date(now.getTime() - m * MIN);
      // k1 chuyển người sau chốt đơn 1.520 phút, khách chờ · k2 AI hỏng 300 phút mà updated_at mới (đồng hồ bị đẩy) · k3 tiếp quản · k4 AI trả lời · k5 TEST.
      const [k1] = await db
        .insert(c)
        .values({ channel: "FANPAGE", status: "HANDOFF", handoffReason: "Khách nhắn sau khi đã chốt đơn — nhân viên xử lý (đổi địa chỉ / lịch giao / hỏi thêm)", visitorKey: `${PAGE}:k1`, pageId: PAGE, threadId: "k1", handoffQueuedAt: ago(1520), lastCustomerAt: ago(3), lastBotAt: ago(2000) })
        .returning({ id: c.id });
      await db.insert(c).values({ channel: "FANPAGE", status: "HANDOFF", handoffReason: AI_DOWN_HANDOFF_REASON, state: { handoff: { reason: AI_DOWN_HANDOFF_REASON, at: ago(300).toISOString() } }, visitorKey: `${PAGE}:k2`, pageId: PAGE, threadId: "k2" });
      await db.insert(c).values({ channel: "FANPAGE", status: "OPEN", state: { control: { mode: "HUMAN" } }, visitorKey: `${PAGE}:k3`, pageId: PAGE, threadId: "k3" });
      const [k4] = await db.insert(c).values({ channel: "FANPAGE", status: "OPEN", visitorKey: `${PAGE}:k4`, pageId: PAGE, threadId: "k4" }).returning({ id: c.id });
      await db.insert(c).values({ channel: "TEST", status: "HANDOFF", handoffReason: "Khách cần nhân viên", visitorKey: "ket-test" });

      // A2: nhân viên trả lời k1 thẳng trên page 2 phút trước (sau tin khách cuối 3 phút trước) · tin tự động của page không tính.
      await db.insert(schema.salesChatInbound).values({ pageId: PAGE, threadId: "k1", messageId: "k1-auto", text: "Cảm ơn bạn đã nhắn tin", status: "DONE", note: "PAGE_REPLY", senderKind: "PANCAKE_AUTOMATION", createdAt: ago(1) });

      let a = await collectSilent(db, now);
      assert.deepEqual(a.waitingHuman.map((f) => f.id), [k1.id], "A2 chỉ xét nhóm chờ người (tiếp quản / AI hỏng không vào)");
      assert.equal(handoffReplyClass(a.waitingHuman[0], now, 24 * 3_600_000), "UNANSWERED_WITHIN_SLA", "chỉ có tin tự động sau tin khách ⇒ CHƯA được trả lời");
      await db.insert(schema.salesChatInbound).values({ pageId: PAGE, threadId: "k1", messageId: "k1-staff", text: "Dạ em xem lại đơn cho chị", status: "DONE", note: "PAGE_REPLY", senderKind: "VERIFIED_HUMAN", createdAt: ago(2) });
      a = await collectSilent(db, now);
      assert.equal(handoffReplyClass(a.waitingHuman[0], now, 24 * 3_600_000), "ANSWERED_HUMAN", "nhân viên trả lời trên page ⇒ đã trả lời dù ERP không ai cầm");
      assert.deepEqual(a.waitingHuman[0].handoffAt, ago(1520), "mốc chuyển = dấu vào hàng đợi");
      assert.equal(a.counts.silent, 3, "TEST loại; AI đang trả lời không tính");
      assert.equal(a.counts.byClass.POST_ORDER.total, 1);
      assert.deepEqual(a.counts.byClass.POST_ORDER.over, [1, 1, 1], "1.520 phút > 1.440");
      assert.equal(a.counts.byClass.AI_DOWN_CLOCK_PUSHED.total, 1, "hỏng 300 phút trước mà updated_at vừa ghi ⇒ đồng hồ bị đẩy");
      assert.equal(a.counts.byClass.TAKEOVER.total, 1);
      assert.equal(a.counts.customerWaiting, 1);
      assert.deepEqual([a.counts.watchdogReopen, a.counts.watchdogAnswerNow, a.counts.watchdogToHuman], [1, 0, 0], "chạy thử watchdog: mở lại k2 (AI hỏng bị đẩy đồng hồ), không lượt khách nào trong cửa sổ");
      assert.match(silentSummary(ORG, a.counts).join("\n"), /CHẠY THỬ watchdog .*sẽ mở lại 1 .*AI trả lời ngay 0/);
      assert.ok(a.samples.POST_ORDER?.includes(k1.id), "mã hội thoại chỉ ở phần MÃ HOÁ");
      assert.ok(silentSummary(ORG, a.counts).every((l) => !l.includes(k1.id)), "tóm tắt không mang mã hội thoại");

      // A2[/work]: ĐÚNG tập của Quality Supervisor (2B) — gồm cả hội thoại nhân viên đang tiếp quản (k3), tập cũ thì không.
      const w = await collectWorkQueueFacts(db, now);
      assert.ok(w.ok, `A2[/work] đọc được bằng collectHandoffFacts: ${JSON.stringify(w)}`);
      if (w.ok) {
        const ids = w.facts.map((f) => f.id);
        assert.ok(ids.includes(k1.id), "chờ người sau chốt đơn ở cả hai tập");
        assert.ok(!ids.includes(k4.id), "AI đang trả lời không ở hàng đợi người");
        assert.ok(ids.some((x) => !a.waitingHuman.some((f) => f.id === x)), "tập /work rộng hơn tập cũ (tiếp quản)");
        assert.match(queueSetSummary(ORG, a.waitingHuman.map((f) => f.id), ids, [], []), /cũ \(nhóm WAITING_HUMAN của script\) 1 · .* chung 1 · chỉ tập cũ 0 · chỉ \/work [1-9]/);
        assert.deepEqual(w.facts.find((f) => f.id === k1.id)?.pageVerifiedAt, ago(2), "cùng mốc trả lời trên page như tập cũ");
      }

      const b = await collectOwnership({ code: ORG, isHome: false }, now);
      assert.ok(b.ok, `B/C đọc được bằng lib #800: ${JSON.stringify(b)}`);
      if (b.ok) {
        // Sau bản vá đồng hồ AI hỏng (HOTFIX 12/10/2026 — aiDownStartedAt): k2 hỏng 300 phút trước KHÔNG còn là «AI im» dù updated_at
        // mới bị đẩy — đúng là nhóm AI_DOWN_CLOCK_PUSHED mà phần A (SQL thô, luật cũ) đếm ra. Tập «AI im» của lib = A trừ nhóm đó.
        assert.equal(b.silent, a.counts.silent - a.counts.byClass.AI_DOWN_CLOCK_PUSHED.total, "tập «AI im» của lib = A trừ AI hỏng bị đẩy đồng hồ");
        assert.equal(b.person + b.department + b.shared + b.unowned, b.silent);
        assert.ok(b.unqueued >= 1, "k3 chưa vào hàng đợi");
        assert.ok(b.viewers >= 1, "chủ shop xem được hộp thư");
        assert.ok(b.slaMs === null || b.slaMs > 0, "độ dài hạn đọc từ work.sla");
      }

      // Đơn: o1 của k1 đã chốt 5 ngày, không vận đơn (ERP in «Chưa gửi») · o2 của k4 «Mới» thiếu xã · nhắn lại sau đơn chốt.
      const o = schema.orders;
      await db.insert(o).values({ id: "erp-6495ca72-0000-4000-8000-000000000001", status: 1, stage: "CONFIRMED", insertedAt: ago(5 * 1440), salesConversationId: k1.id, shipProvince: "Hà Nội", shipCommune: "Phường Láng" });
      await db.insert(o).values({ id: "erp-0000aaaa-0000-4000-8000-000000000002", status: 0, stage: "NEW", insertedAt: ago(60), salesConversationId: k4.id, shipProvince: "Hà Nội", shipCommune: "" });
      await db.insert(schema.salesConversationEvents).values({ conversationId: k1.id, type: "followup.sent", actorKind: "AI", channel: "FANPAGE", occurredAt: ago(1440), dedupeKey: `ket-fu-${k1.id}` });
      await db.insert(schema.salesChatInbound).values({ pageId: PAGE, threadId: "k1", messageId: "k1-c", text: "Tôi nhận hàng rồi nhưng chưa thử chất lượng", status: "SKIPPED", createdAt: ago(3) });
      // Cổng nhắc mới (P0 21/10/2026): một lượt bị chặn vì đơn đã chốt chưa kết cục.
      await db.insert(schema.salesConversationEvents).values({ conversationId: k1.id, type: "followup.decided", actorKind: "SYSTEM", channel: "FANPAGE", reasonCode: "PENDING_PRIOR_ORDER", occurredAt: ago(60), dedupeKey: `ket-fu-blk-${k1.id}` });
      const d = await collectOrders(db, 7, now);
      assert.equal(d.m.followupsSent, 1);
      assert.equal(d.m.followupsAfterOrder, 1, "nhắn lại SAU khi đơn đã chốt");
      assert.equal(d.m.followupsAfterPending, 1, "baseline: tin nhắc tới khách đang có đơn đã chốt CHƯA kết cục (o1 không vận đơn)");
      assert.deepEqual([d.m.followupsBlockedPending, d.m.followupsBlockedPendingStale], [1, 0], "cổng chặn theo mã");
      assert.equal(d.m.orders, 2);
      assert.equal(d.m.byOutcome.NOT_SHIPPED, 2, "ORDER_OUTCOME: không vận đơn ⇒ NOT_SHIPPED (hộp thư in «Chưa gửi»)");
      assert.equal(d.m.confirmedNoShipmentAged, 1, "đã chốt > 3 ngày mà ERP không có vận đơn");
      assert.equal(d.m.missingWard, 1);
      assert.equal(d.m.receiptClaims, 1);
      assert.equal(d.m.receiptClaimsNotDelivered, 1, "khách nói đã nhận — ERP chưa có chứng từ giao");
      const [x] = (await db.execute(sql`select 'Tôi nhận hàng rồi nhưng chưa thử chất lượng' ~* ${RECEIPT_CLAIM_SQL_RE} as a, 'khi nào nhận hàng' ~* ${RECEIPT_CLAIM_SQL_RE} as b`)).rows as { a: boolean; b: boolean }[];
      assert.deepEqual([x.a, x.b], [true, false], "bản SQL = bản TS");
    });
    console.log("  ✓ PGlite: A nhóm × ngưỡng phút (sau chốt 1.520 p · AI hỏng đồng hồ bị đẩy · tiếp quản; TEST loại) · A2[/work] = tập 2B (gồm tiếp quản) · D nhắn lại sau đơn · E chưa vận đơn > 3 ngày · thiếu xã · «đã nhận hàng» chưa có chứng từ giao");
  } finally {
    await cleanup();
  }
}

function testSource() {
  const sc = readFileSync("scripts/stuck-conversation-audit.ts", "utf8");
  assert.match(sc, /if \(CHAY_THANG\) process\.env\.ERP_READ_ONLY = "1";/);
  assert.match(sc, /show default_transaction_read_only/);
  assert.match(sc, /getDbForInspection/);
  const code = sc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\.(insert|update|delete)\(|\binsert into\b|\bupdate "?\w+"? set\b|\bdelete from\b/i, "script không câu ghi");
  assert.doesNotMatch(code, /from "@\/lib\/sales-chatbot\//, "phần đếm chính không nhập lib bot tĩnh — ops lấy lib từ image (lib #800 nạp động, thiếu ⇒ CHƯA ĐO ĐƯỢC)");
  assert.doesNotMatch(code, /tomTat\([^\n]*\$\{[^}]*\b(id|threadId|pageId|text)\b/, "tóm tắt không nhận mã / chữ tin");
  assert.match(code, /process\.stdout\.write\("", \(\) => process\.exit\(code\)\)/, "xả stdout trước khi thoát");
  assert.match(code, /select value from "settings" where key = \$\{SALES_QUALITY_STATE_KEY\} limit 1/, "2B đọc đúng khoá ảnh chụp (hằng số, không gõ lại chuỗi)");
  assert.match(code, /for \(const line of qualityStateSummary\(org\.code, q\?\.value\)\) tomTat\(line\);/, "2B ra kênh tóm tắt qua hàm thuần");
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.match(ops, /- stuck-conversation-audit\s+#/, "ops-vps khai lựa chọn");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\bstuck-conversation-audit\b/, "kết quả MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\bstuck-conversation-audit\b/, "làn ĐỌC nặng");
  assert.match(ops, /stuck-conversation-audit\)\n[\s\S]*?scripts\/stuck-conversation-audit\.ts ;;/, "nhánh chạy");
  console.log("  ✓ mã nguồn: chỉ đọc (Postgres ép + hỏi lại) · không câu ghi · không nhập tĩnh lib bot · tóm tắt không mã · xả stdout · ops khai đủ bốn chỗ");
}

/** 2B — ảnh chụp Quality Supervisor: chưa biết KHÔNG in 0, mẫu nhỏ không in tỷ lệ, mẫu số khớp `baseOf` của daily.ts. */
function testQualityState() {
  const nope = (raw: unknown) => qualityStateSummary("demo", raw);
  for (const raw of [undefined, null, "không phải json", JSON.stringify("chuỗi"), JSON.stringify([1, 2]), JSON.stringify({ day: "2026-10-21" }), JSON.stringify({ counts: {} })]) {
    const l = nope(raw);
    assert.equal(l.length, 1, String(raw));
    assert.match(l[0], /^demo 2B · CHƯA ĐO ĐƯỢC — /, `khoá vắng / hỏng ⇒ CHƯA ĐO ĐƯỢC, không in số: ${String(raw)}`);
    assert.doesNotMatch(l[0], /\b0\b/, "không in 0 thay cho chưa biết");
  }
  assert.match(nope(JSON.stringify({ day: "2026-10-22", at: "x", error: "chi tiết riêng", attempts: 2 }))[0], /lượt ngày 2026-10-22 LỖI \(lần thử 2\)/);
  assert.doesNotMatch(nope(JSON.stringify({ day: "2026-10-22", error: "Khách 0901234567 lỗi" }))[0], /0901234567/, "câu lỗi không ra kênh tóm tắt");

  const state = {
    day: "2026-10-21",
    at: "2026-10-22T00:05:12.000Z",
    conversations: 412,
    capped: false,
    counts: { HANDOFF_UNANSWERED: 98, QTY_REASKED: 3, UPSELL_ACCEPTED_BUT_REASKED: 0, UPSELL_ACCEPTED_NOT_ATTACHED: 1 },
    bases: { customerMessages: 900, botMessages: 1200, quantityAnswers: 40, deliverySecondAsks: 5, complaints: 12, offerAccepts: 4, handoffWaiting: 214 },
    slaHours: 4,
  };
  const out = qualityStateSummary("demo", JSON.stringify(state));
  const all = out.join("\n");
  assert.match(out[0], /^demo 2B · ngày 2026-10-21 \(chạy 2026-10-22T00:05Z\) · quét 412 hội thoại · hạn chờ người 4 giờ$/);
  assert.match(all, /HANDOFF_UNANSWERED 98\/214 = 45,8%/, "mẫu đủ ⇒ tỷ lệ");
  assert.match(all, /QTY_REASKED 3\/40 = 7,5%/);
  assert.match(all, /UPSELL_ACCEPTED_BUT_REASKED 0\/4 chưa đủ mẫu/, "0 THẬT vẫn in 0 — nhưng mẫu nhỏ không có tỷ lệ");
  assert.match(all, /UPSELL_ACCEPTED_NOT_ATTACHED 1\/4 chưa đủ mẫu/);
  assert.match(all, /SECONDARY_INTENT_UNANSWERED —/, "mã vắng trong ảnh chụp ⇒ «—», không phải 0");
  assert.match(all, /COMPLAINT_WHILE_SELLING —/);
  for (const c of SALES_QUALITY_CODES) assert.ok(all.includes(c), `mọi mã có mặt: ${c}`);
  assert.equal(qualityStateSummary("demo", state).join("\n"), all, "giá trị đã là object (driver giải JSON) ⇒ cùng kết quả");
  assert.match(qualityStateSummary("demo", { ...state, capped: true, slaHours: null })[0], /CHẠM TRẦN — số là trần dưới · hạn chờ người không đặt/);
  assert.match(qualityStateSummary("demo", { ...state, bases: undefined }).join(" "), /HANDOFF_UNANSWERED 98 \(mẫu số chưa có\)/);
  // Kênh [ops:tom-tat] cắt ở 300 BYTE (`cut -c` của GNU): mọi dòng lọt, kể cả mã tổ chức dài và số sáu chữ số — đo bằng byte, không bằng
  // `length` (bản đo ký tự đã để dòng 2B ngày 22/10 cụt ở «CART_TOTAL_C…»; chi tiết ở tests/stuck-audit-2b-lines.test.ts).
  const big = { ...state, conversations: 999_999, capped: true, counts: Object.fromEntries(SALES_QUALITY_CODES.map((c) => [c, 999_999])), bases: Object.fromEntries(Object.keys(state.bases).map((k) => [k, 999_999])) };
  for (const l of qualityStateSummary("hslc-hmt-shop", big)) assert.ok(Buffer.byteLength(l, "utf8") <= 300, `${Buffer.byteLength(l, "utf8")} byte > 300: ${l}`);
  assert.equal(QUALITY_MIN_SAMPLE, 30);

  // Mẫu số của script = ĐÚNG trường `baseOf` của daily.ts in cạnh mã đó (bản sao có lý do: ops lấy lib từ image).
  const daily = readFileSync("lib/sales-quality/daily.ts", "utf8");
  for (const c of SALES_QUALITY_CODES) {
    const line = daily.split("\n").find((x) => x.trimStart().startsWith(`${c}: \``));
    assert.ok(line, `daily.ts baseOf thiếu mã ${c}`);
    const field = QUALITY_BASE_FIELD[c];
    // Mẫu số không nằm trong `QualityBases` (ảnh chụp lúc chạy) ⇒ đúng biểu thức daily.ts in cạnh mã đó.
    const special: Record<string, string> = { handoffWaiting: "${ho.waiting}", addressFlagged: "${na.flagged}", commentCarries: "${cc.carries}" };
    const want = special[field] ?? `\${b.${field}}`;
    assert.ok(line.includes(want), `${c}: script lấy mẫu số «${field}» nhưng daily.ts in ${line.trim().slice(0, 120)}`);
  }
  console.log("  ✓ 2B: khoá vắng / hỏng / lượt lỗi ⇒ CHƯA ĐO ĐƯỢC (không 0, không câu lỗi) · mã vắng ⇒ — · mẫu < 30 ⇒ chưa đủ mẫu · dòng ≤ 300 ký tự · mẫu số khớp daily.ts");
}

export async function testStuckConversationAudit() {
  console.log("Ops stuck-conversation-audit (hội thoại AI kẹt · không chủ · SLA · nhắn lại sau đơn · đơn chưa đồng bộ — chỉ đọc):");
  testPure();
  testQualityState();
  testCopies();
  testSource();
  await testDb();
}

if (process.argv[1] && /stuck-conversation-audit\.test\.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testStuckConversationAudit)
    .then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
}

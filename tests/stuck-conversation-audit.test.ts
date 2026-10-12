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
import {
  addSilent,
  AI_DOWN_RETRY_MINUTES,
  classifyStuck,
  collectOrders,
  collectOwnership,
  collectSilent,
  emptyCounts,
  parseStuckArgs,
  RECEIPT_CLAIM_RE,
  RECEIPT_CLAIM_SQL_RE,
  REASON_TEXT,
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

      const a = await collectSilent(db, now);
      assert.equal(a.counts.silent, 3, "TEST loại; AI đang trả lời không tính");
      assert.equal(a.counts.byClass.POST_ORDER.total, 1);
      assert.deepEqual(a.counts.byClass.POST_ORDER.over, [1, 1, 1], "1.520 phút > 1.440");
      assert.equal(a.counts.byClass.AI_DOWN_CLOCK_PUSHED.total, 1, "hỏng 300 phút trước mà updated_at vừa ghi ⇒ đồng hồ bị đẩy");
      assert.equal(a.counts.byClass.TAKEOVER.total, 1);
      assert.equal(a.counts.customerWaiting, 1);
      assert.ok(a.samples.POST_ORDER?.includes(k1.id), "mã hội thoại chỉ ở phần MÃ HOÁ");
      assert.ok(silentSummary(ORG, a.counts).every((l) => !l.includes(k1.id)), "tóm tắt không mang mã hội thoại");

      const b = await collectOwnership({ code: ORG, isHome: false }, now);
      assert.ok(b.ok, `B/C đọc được bằng lib #800: ${JSON.stringify(b)}`);
      if (b.ok) {
        // Sau bản vá đồng hồ AI hỏng (HOTFIX 12/10/2026 — aiDownStartedAt): k2 hỏng 300 phút trước KHÔNG còn là «AI im» dù updated_at
        // mới bị đẩy — đúng là nhóm AI_DOWN_CLOCK_PUSHED mà phần A (SQL thô, luật cũ) đếm ra. Tập «AI im» của lib = A trừ nhóm đó.
        assert.equal(b.silent, a.counts.silent - a.counts.byClass.AI_DOWN_CLOCK_PUSHED.total, "tập «AI im» của lib = A trừ AI hỏng bị đẩy đồng hồ");
        assert.equal(b.person + b.department + b.shared + b.unowned, b.silent);
        assert.ok(b.unqueued >= 1, "k3 chưa vào hàng đợi");
        assert.ok(b.viewers >= 1, "chủ shop xem được hộp thư");
      }

      // Đơn: o1 của k1 đã chốt 5 ngày, không vận đơn (ERP in «Chưa gửi») · o2 của k4 «Mới» thiếu xã · nhắn lại sau đơn chốt.
      const o = schema.orders;
      await db.insert(o).values({ id: "erp-6495ca72-0000-4000-8000-000000000001", status: 1, stage: "CONFIRMED", insertedAt: ago(5 * 1440), salesConversationId: k1.id, shipProvince: "Hà Nội", shipCommune: "Phường Láng" });
      await db.insert(o).values({ id: "erp-0000aaaa-0000-4000-8000-000000000002", status: 0, stage: "NEW", insertedAt: ago(60), salesConversationId: k4.id, shipProvince: "Hà Nội", shipCommune: "" });
      await db.insert(schema.salesConversationEvents).values({ conversationId: k1.id, type: "followup.sent", actorKind: "AI", channel: "FANPAGE", occurredAt: ago(1440), dedupeKey: `ket-fu-${k1.id}` });
      await db.insert(schema.salesChatInbound).values({ pageId: PAGE, threadId: "k1", messageId: "k1-c", text: "Tôi nhận hàng rồi nhưng chưa thử chất lượng", status: "SKIPPED", createdAt: ago(3) });
      const d = await collectOrders(db, 7, now);
      assert.equal(d.m.followupsSent, 1);
      assert.equal(d.m.followupsAfterOrder, 1, "nhắn lại SAU khi đơn đã chốt");
      assert.equal(d.m.orders, 2);
      assert.equal(d.m.byOutcome.NOT_SHIPPED, 2, "ORDER_OUTCOME: không vận đơn ⇒ NOT_SHIPPED (hộp thư in «Chưa gửi»)");
      assert.equal(d.m.confirmedNoShipmentAged, 1, "đã chốt > 3 ngày mà ERP không có vận đơn");
      assert.equal(d.m.missingWard, 1);
      assert.equal(d.m.receiptClaims, 1);
      assert.equal(d.m.receiptClaimsNotDelivered, 1, "khách nói đã nhận — ERP chưa có chứng từ giao");
      const [x] = (await db.execute(sql`select 'Tôi nhận hàng rồi nhưng chưa thử chất lượng' ~* ${RECEIPT_CLAIM_SQL_RE} as a, 'khi nào nhận hàng' ~* ${RECEIPT_CLAIM_SQL_RE} as b`)).rows as { a: boolean; b: boolean }[];
      assert.deepEqual([x.a, x.b], [true, false], "bản SQL = bản TS");
    });
    console.log("  ✓ PGlite: A nhóm × ngưỡng phút (sau chốt 1.520 p · AI hỏng đồng hồ bị đẩy · tiếp quản; TEST loại) · D nhắn lại sau đơn · E chưa vận đơn > 3 ngày · thiếu xã · «đã nhận hàng» chưa có chứng từ giao");
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
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.match(ops, /- stuck-conversation-audit\s+#/, "ops-vps khai lựa chọn");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\bstuck-conversation-audit\b/, "kết quả MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\bstuck-conversation-audit\b/, "làn ĐỌC nặng");
  assert.match(ops, /stuck-conversation-audit\)\n[\s\S]*?scripts\/stuck-conversation-audit\.ts ;;/, "nhánh chạy");
  console.log("  ✓ mã nguồn: chỉ đọc (Postgres ép + hỏi lại) · không câu ghi · không nhập tĩnh lib bot · tóm tắt không mã · xả stdout · ops khai đủ bốn chỗ");
}

export async function testStuckConversationAudit() {
  console.log("Ops stuck-conversation-audit (hội thoại AI kẹt · không chủ · SLA · nhắn lại sau đơn · đơn chưa đồng bộ — chỉ đọc):");
  testPure();
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

/**
 * ═══════════ OPS `inbox-unread-dryrun` — CHẠY THỬ «CHƯA ĐỌC» LƯU SẴN CỦA #792 TRÊN DỮ LIỆU THẬT (11/10/2026) ═══════════
 *
 * Điều kiện chủ shop đặt khi duyệt #792: đo trên production TRƯỚC khi migration 0245 dẫn xuất cột cho mọi hội thoại. Bài kiểm khoá:
 *  1. THUẦN: cú pháp đối số (`<mã tổ chức>` | `--all`), ước lượng dẫn xuất so với trần 600 giây, dòng tóm tắt chỉ số đếm.
 *  2. PGlite: số đếm khớp tay trên bảy hội thoại dựng sẵn — V3 (con trỏ chung) báo chưa đọc mà hàm #803 nói đã xử lý chia đúng ba lý do
 *     (AI trả lời · người xác minh trả lời · người mở), và chiều ngược (V3 coi là đã đọc vì `last_staff_at` mà chưa có câu trả lời nào).
 *  3. MÃ NGUỒN: chỉ đọc (Postgres ép + hỏi lại), không câu ghi, không nhập lib của #792 (ops lấy lib từ image đang chạy), tóm tắt không mang
 *     mã hội thoại; ops-vps khai đủ bốn chỗ.
 * Mốc thời gian đi theo đồng hồ THẬT (AGENTS 50).
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { collectDryrun, dryrunSummary, estimateBackfill, missingPrereqs, parseDryrunArgs } from "@/scripts/inbox-unread-dryrun";

const ORG = "hop-thu-dryrun";
const PAGE = "pg-dryrun";
const MIN = 60_000;

function testPure() {
  assert.deepEqual(parseDryrunArgs(["--all"]), { all: true });
  assert.deepEqual(parseDryrunArgs(["hslc-hmt-shop"]), { all: false, code: "hslc-hmt-shop" });
  for (const bad of [[], ["HSLC"], ["--limit=3"], ["a", "b"], ["--all", "x"]]) assert.ok("error" in parseDryrunArgs(bad), JSON.stringify(bad));
  assert.equal(estimateBackfill(10_000).verdict, "AN_TOAN", "10 s đọc ⇒ ≤ 25 s ghi");
  assert.equal(estimateBackfill(200_000).verdict, "SAT_TRAN", "200 s đọc ⇒ 240–500 s: sát trần 600 s");
  assert.equal(estimateBackfill(300_000).verdict, "VUOT_TRAN");
  const lines = dryrunSummary("demo", { conversations: 10, turnUnread: 3, v3Unread: 6, trueToFalse: 4, byRead: 1, byReplyAi: 2, byReplyHumanPage: 1, falseToTrue: 1 }, { readMs: 1500, compareMs: 2500 }, { conversations: "1 MB", inbound: "9 MB" });
  assert.equal(lines.length, 4);
  assert.match(lines[1], /V3, con trỏ chung\) 6 → sau 0245 \(turn_unhandled = hàm #803\) 3 · true→false 4 · false→true 1/);
  assert.match(lines[2], /người mở 1 \(đo\) · trả lời 3 = AI 2 \+ NV\/page 1 \(ước tính/);
  assert.match(lines[3], /1\.50 s \/ 10 dòng .* ước 1\.80–3\.75 s \(trần 600 s: AN_TOAN\)/);
  console.log("  ✓ đối số <mã> | --all · ước lượng dẫn xuất so với trần 600 s · tóm tắt chỉ số đếm");
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
    await provisionOrganization({ code: ORG, name: "Shop chạy thử", plan: "standard", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "Chủ shop", password: "HopThu@123456" }, source: "TEST", actor: null });
    await withOrganization(ORG, async () => {
      const db = await getDb();
      assert.deepEqual(await missingPrereqs(db), [], "CSDL sau #803 có đủ 0239 + 0244");
      const c = schema.salesChatConversations;
      const t = schema.salesChatInbound;
      const T = Date.now() - 60 * MIN;
      // k1 khách chưa ai đáp · k2 → bot · k3 → người xác minh phía page · k4 → con trỏ đọc · k5 → mốc mở cũ · k6 chỉ có last_staff_at.
      const cases: { k: string; reply?: "BOT" | "HUMAN"; read?: boolean; seen?: boolean; staffAt?: boolean }[] = [{ k: "k1" }, { k: "k2", reply: "BOT" }, { k: "k3", reply: "HUMAN" }, { k: "k4", read: true }, { k: "k5", seen: true }, { k: "k6", staffAt: true }];
      for (const [i, cs] of cases.entries()) {
        const at = new Date(T + i * 5 * MIN);
        const [cv] = await db
          .insert(c)
          .values({ channel: "FANPAGE", status: "OPEN", visitorKey: `${PAGE}:${cs.k}`, pageId: PAGE, threadId: cs.k, lastCustomerAt: at, ...(cs.seen ? { staffSeenAt: new Date(at.getTime() + 30_000) } : {}), ...(cs.staffAt ? { lastStaffAt: new Date(at.getTime() + 30_000) } : {}) })
          .returning({ id: c.id });
        await db.insert(t).values({ pageId: PAGE, threadId: cs.k, messageId: `${cs.k}-c`, text: "Còn hàng không?", status: "DONE", createdAt: at });
        if (cs.reply === "BOT") await db.insert(t).values({ pageId: PAGE, threadId: cs.k, messageId: `${cs.k}-b`, text: "Dạ còn ạ", note: "BOT_SENT", status: "DONE", createdAt: new Date(at.getTime() + 70_000) });
        if (cs.reply === "HUMAN") await db.insert(t).values({ pageId: PAGE, threadId: cs.k, messageId: `${cs.k}-h`, text: "Dạ em kiểm kho", note: "PAGE_REPLY", senderKind: "VERIFIED_HUMAN", status: "DONE", createdAt: new Date(at.getTime() + 2 * MIN) });
        if (cs.read) await db.insert(schema.salesChatReads).values({ conversationId: cv.id, userId: "u-lan", readThroughAt: at });
      }
      const [wv] = await db.insert(c).values({ channel: "WEB", status: "OPEN", visitorKey: "dry-web", lastCustomerAt: new Date(T) }).returning({ id: c.id });
      await db.insert(schema.salesChatMessages).values({ conversationId: wv.id, seq: 1, role: "user", content: [{ type: "text", text: "Hỏi" }], createdAt: new Date(T) });
      await db.insert(c).values({ channel: "TEST", status: "OPEN", visitorKey: "dry-test", lastCustomerAt: new Date(T) });

      const r = await collectDryrun(db);
      assert.deepEqual(
        r.counts,
        { conversations: 7, turnUnread: 3, v3Unread: 5, trueToFalse: 3, byRead: 1, byReplyAi: 1, byReplyHumanPage: 1, falseToTrue: 1 },
        `số đếm khớp tay: ${JSON.stringify(r.counts)}`,
      );
      assert.ok(r.timing.readMs > 0 && r.timing.compareMs > 0, "có bấm giờ");
      assert.ok(r.size.conversations !== "—" && r.size.inbound !== "—", "có kích thước bảng");
      const lines = dryrunSummary(ORG, r.counts, r.timing, r.size);
      assert.ok(lines.every((l) => !l.includes(wv.id)), "tóm tắt không mang mã hội thoại");
    });
    console.log("  ✓ PGlite: V3 5 → #803 3 · true→false 3 (AI 1 · NV/page 1 · người mở 1) · false→true 1 (last_staff_at không phải câu trả lời) · TEST loại · có giờ + kích thước");
  } finally {
    await cleanup();
  }
}

function testSource() {
  const sc = readFileSync("scripts/inbox-unread-dryrun.ts", "utf8");
  assert.match(sc, /if \(CHAY_THANG\) process\.env\.ERP_READ_ONLY = "1";/);
  assert.match(sc, /show default_transaction_read_only/);
  assert.match(sc, /getDbForInspection/);
  const code = sc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\.(insert|update|delete)\(|\binsert into\b|\bupdate "?\w+"? set\b|\bdelete from\b/i, "script không câu ghi");
  // Chuỗi ghép từ hai mảnh để máy quét import của repo-integrity không đọc nhầm nó là một dòng import.
  assert.ok(!sc.includes(["@/lib/sales-chatbot", "inbox-unread"].join("/")), "không nhập lib của #792 (ops lấy lib từ image đang chạy)");
  assert.match(sc, /from "@\/lib\/sales-chatbot\/response-ownership-ledger"/, "dùng ĐÚNG hàm #803 đã có trên main");
  assert.doesNotMatch(code, /tomTat\([^\n]*\$\{[^}]*\b(id|threadId|pageId|text)\b/, "tóm tắt không nhận mã / chữ tin");
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.match(ops, /- inbox-unread-dryrun\s+#/, "ops-vps khai lựa chọn");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\binbox-unread-dryrun\b/, "kết quả MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\binbox-unread-dryrun\b/, "làn ĐỌC nặng");
  assert.match(ops, /inbox-unread-dryrun\)\n[\s\S]*?scripts\/inbox-unread-dryrun\.ts ;;/, "nhánh chạy");
  console.log("  ✓ mã nguồn: chỉ đọc (Postgres ép + hỏi lại) · không câu ghi · không nhập lib #792 · tóm tắt không mã · ops khai đủ bốn chỗ");
}

export async function testInboxUnreadDryrun() {
  console.log("Ops inbox-unread-dryrun (chạy thử «chưa đọc» lưu sẵn #792, chỉ đọc):");
  testPure();
  testSource();
  await testDb();
}

if (process.argv[1] && /inbox-unread-dryrun\.test\.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testInboxUnreadDryrun)
    .then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
}

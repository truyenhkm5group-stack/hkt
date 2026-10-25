/**
 * ═══ MỘT LUỒNG (page, thread) — MỘT HỘI THOẠI, MỘT BOT (P0 HSLC 24/10/2026 — gốc của cặp đơn #B1135EC0 / #E0663E84) ═══
 *
 * Khoá: lượt chép bình luận EXISTING_INBOX KHÔNG đè luồng hộp thư lên hội thoại bình luận, không WAITING / lịch nhắc · MOVED vẫn nhận luồng ·
 * chủ luồng = khoá khách khớp · dòng trùng cũ (bình luận bị đè) bị loại khỏi mọi đường đọc theo thread, dòng lẻ thì KHÔNG bao giờ bị loại ·
 * công thức SQL = fanpageVisitorKey · quét mã nguồn: không đường đọc hội thoại theo thread_id mới ngoài hàm chủ (miễn trừ kèm lý do).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { fanpageVisitorKey as fromFanpage, markWaitingForCustomer } from "@/lib/sales-chatbot/fanpage";
import { fanpageVisitorKey, ownsThread, ownsThreadSql, threadOwner } from "@/lib/sales-chatbot/thread-owner";
import { rowsOf } from "@/lib/sql-rows";

export function testThreadOwnerPure() {
  assert.equal(fromFanpage, fanpageVisitorKey, "fanpage.ts xuất lại ĐÚNG hàm của thread-owner (một công thức)");
  assert.equal(ownsThread({ visitorKey: fanpageVisitorKey("p", "p_1"), pageId: "p", threadId: "p_1" }), true);
  assert.equal(ownsThread({ visitorKey: fanpageVisitorKey("p", "post_c"), pageId: "p", threadId: "p_1" }), false, "hội thoại bình luận bị đè luồng hộp thư không phải chủ");
  assert.throws(() => ownsThreadSql("c; drop table x"), /bí danh/);
  console.log("  ✓ thuần: một công thức khoá · chủ = khoá khách khớp luồng · bí danh SQL soát");
}

/** Mọi đường đọc HỘI THOẠI theo thread_id trong lib/ phải đi qua hàm chủ / mệnh đề chủ — hoặc khai miễn trừ kèm lý do. */
const MIEN_TRU: Record<string, string> = {
  "lib/sales-chatbot/identity-link.ts": "Tìm ỨNG VIÊN cùng danh tính (cùng luồng là một bằng chứng) — không định tuyến tin, không gửi, không chọn hội thoại để bot trả lời.",
  "lib/sales-chatbot/order-sync.ts": "Mệnh đề «không có hội thoại bot nào trên luồng này» (not exists) — dòng trùng không đổi câu trả lời CÓ / KHÔNG.",
};
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const f = path.join(dir, n);
    return statSync(f).isDirectory() ? walk(f) : /\.tsx?$/.test(n) ? [f.split(path.sep).join("/")] : [];
  });
}
export function testThreadOwnerScan() {
  const seen = new Set<string>();
  const bad: string[] = [];
  for (const f of walk("lib")) {
    if (f === "lib/sales-chatbot/thread-owner.ts") continue;
    const src = readFileSync(f, "utf8").replace(/\r\n/g, "\n");
    const convVars = [...src.matchAll(/const (\w+) = schema\.salesChatConversations\b/g)].map((m) => m[1]);
    for (const [i, line] of src.split("\n").entries()) {
      const sqlJoin = /join sales_chat_conversations (\w+) on [^\n]*\b\1\.thread_id = /.test(line) || /\bsc\.thread_id = /.test(line);
      const drizzleEq = convVars.some((v) => new RegExp(`eq\\(${v}\\.threadId,`).test(line));
      if (!sqlJoin && !drizzleEq) continue;
      if (/ownsThreadSql\(/.test(line)) continue;
      if (MIEN_TRU[f]) {
        seen.add(f);
        continue;
      }
      bad.push(`${f}:${i + 1}`);
    }
  }
  assert.deepEqual(bad, [], "đọc hội thoại theo thread_id ngoài hàm chủ — dùng threadOwner / ownsThreadSql hoặc khai miễn trừ kèm lý do");
  for (const k of Object.keys(MIEN_TRU)) assert.ok(seen.has(k), `miễn trừ không còn khớp mã nào — xoá: ${k}`);
  for (const f of ["lib/sales-chatbot/followup.ts", "lib/sales-chatbot/inbound-retry.ts", "lib/sales-chatbot/health.ts", "lib/sales-chatbot/recovery.ts", "lib/sales-chatbot/response-ownership-ledger.ts"]) {
    assert.match(readFileSync(f, "utf8"), /ownsThreadSql\(/, `${f}: đường đọc theo luồng chỉ chọn chủ`);
  }
  assert.match(readFileSync("lib/sales-chatbot/fanpage.ts", "utf8"), /sql`\$\{c\.state\} \? 'pendingSend'`, ownsThreadSql\('"sales_chat_conversations"'\)/, "gửi bù chỉ chọn chủ luồng");
  console.log("  ✓ quét mã nguồn: không đường đọc hội thoại theo thread_id ngoài hàm chủ · gửi bù / thử lại / theo dõi / giám sát chỉ chọn chủ");
}

async function testDb() {
  const db = await getDb();
  const c = schema.salesChatConversations;
  // Công thức SQL của mệnh đề chủ = fanpageVisitorKey.
  const [k] = rowsOf<{ k: string }>(await db.execute(sql`select encode(sha256(convert_to('fanpage:' || ${"100200300"} || ':' || ${"100200300_29001"}, 'UTF8')), 'hex') as k`));
  assert.equal(k.k, fanpageVisitorKey("100200300", "100200300_29001"), "sha256 SQL = fanpageVisitorKey");

  const PAGE = `tow${Date.now()}`;
  const INBOX = `${PAGE}_29001`;
  const COMMENT = `post_${Date.now()}_77`;
  const ids: string[] = [];
  const mk = async (over: Partial<typeof c.$inferInsert>) => {
    const [r] = await db.insert(c).values({ channel: "FANPAGE", pageId: PAGE, status: "OPEN", ...over }).returning({ id: c.id });
    ids.push(r.id);
    return r.id;
  };
  try {
    // Dữ liệu CŨ: hội thoại bình luận đã bị đè luồng hộp thư + hội thoại hộp thư thật (chủ).
    const legacy = await mk({ visitorKey: fanpageVisitorKey(PAGE, COMMENT), threadId: INBOX });
    const owner = await mk({ visitorKey: fanpageVisitorKey(PAGE, INBOX), threadId: INBOX });
    // Dòng lẻ khoá KHÁC dạng (dữ liệu rất cũ) — không ai giành ⇒ không được loại.
    const lone = await mk({ visitorKey: `khac-${Date.now()}`, threadId: `${PAGE}_29002` });
    assert.equal((await threadOwner(PAGE, INBOX))?.id, owner, "chủ luồng = khoá khách khớp");
    assert.equal((await threadOwner(PAGE, `${PAGE}_29002`))?.id, lone, "dòng lẻ khoá khác dạng vẫn là chủ");
    const kept = await db.select({ id: c.id }).from(c).where(and(inArray(c.id, ids), ownsThreadSql('"sales_chat_conversations"')));
    assert.deepEqual(kept.map((r) => r.id).sort(), [owner, lone].sort(), "chỉ dòng trùng bị giành bị loại");

    // Nguồn: EXISTING_INBOX — hội thoại bình luận KHÔNG nhận luồng hộp thư, không WAITING.
    const comment = await mk({ visitorKey: fanpageVisitorKey(PAGE, `${COMMENT}_2`), threadId: `${COMMENT}_2` });
    const at = new Date();
    await markWaitingForCustomer(comment, at, INBOX);
    const [cm] = await db.select({ threadId: c.threadId, status: c.status, nextFollowupAt: c.nextFollowupAt, lastBotAt: c.lastBotAt }).from(c).where(eq(c.id, comment));
    assert.deepEqual([cm.threadId, cm.status, cm.nextFollowupAt], [`${COMMENT}_2`, "OPEN", null], `bình luận giữ luồng của nó, không chờ / nhắc: ${JSON.stringify(cm)}`);
    assert.ok(cm.lastBotAt && Math.abs(cm.lastBotAt.getTime() - at.getTime()) < 1000, "mốc bot vẫn ghi");
    // MOVED — hội thoại SỞ HỮU luồng mới (khoá đã chuyển) ⇒ nhận luồng + WAITING như cũ.
    const moved = await mk({ visitorKey: fanpageVisitorKey(PAGE, `${PAGE}_29003`), threadId: `${COMMENT}_3` });
    await markWaitingForCustomer(moved, at, `${PAGE}_29003`);
    const [mv] = await db.select({ threadId: c.threadId, status: c.status }).from(c).where(eq(c.id, moved));
    assert.deepEqual([mv.threadId, mv.status], [`${PAGE}_29003`, "WAITING"], "MOVED vẫn nhận luồng hộp thư");
    void legacy;
  } finally {
    await db.delete(c).where(inArray(c.id, ids));
  }
  console.log("  ✓ CSDL: sha256 SQL = khoá TS · chủ luồng đúng, dòng lẻ không bị loại · EXISTING_INBOX không đè luồng / không WAITING · MOVED như cũ");
}

export async function testThreadOwner(): Promise<void> {
  testThreadOwnerPure();
  testThreadOwnerScan();
  await testDb();
  console.log("✓ Một luồng một hội thoại (thread-owner): nguồn đè luồng đã chặn · mọi đường đọc theo luồng chọn chủ · gốc cặp #B1135EC0 / #E0663E84");
}

/**
 * Ops `upsell-offer-audit` (P0 #868 — chủ shop 16/10/2026: giữ upsell / cross-sell nhưng không chặn / làm chậm đơn, không mời lặp, không
 * mời sau khi khách từ chối, không hỏi lại «1kg hay 2kg»):
 *  1. đối số được soát; lời mời của MỘT hội thoại đọc từ chữ đã gửi bằng ĐÚNG bộ phân loại câu của máy chủ — mời lặp, mời sau từ chối,
 *     mời gói lớn / hỏi lại quy cách sau khi đã chọn, có mời rồi huỷ; câu mẫu UPSELL gửi qua công cụ cũng là lời mời;
 *  2. CSDL thật (hội thoại dựng theo ca HSLC, tự dọn): tổng đúng, lời mời máy chủ đã bỏ đếm theo lý do;
 *  3. chỉ đọc, xả stdout trước khi thoát, khai đủ bốn chỗ ở ops-vps + platform-isolation-static, tóm tắt không lọt chữ tin / SĐT.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { addConversation, auditOffers, emptyTotals, offersOfConversation, parseAuditArgs } from "../scripts/upsell-offer-audit";

const PHONE = "0900008681";
const txt = (text: string) => [{ type: "text", text }];
const delivered = (text: string) => [{ type: "tool_result", toolUseId: "u1", content: JSON.stringify({ sent: true, __deliver: text }), isError: false }];

// Ca gốc HSLC (16/10/2026): khách chọn 2kg, bot hỏi lại «1kg hay 2kg», mời menu, khách «không em», bot mời lần nữa.
const HSLC = [
  { role: "user", content: txt("Cho chị 2kg chả cá thu") },
  { role: "assistant", content: txt("Dạ em chào chị! Chị lấy 1kg hay 2kg ạ? Lấy 2kg được giảm còn 540.000đ, tiết kiệm hơn ạ.") },
  { role: "user", content: txt("không em") },
  { role: "assistant", content: [{ type: "tool_use", id: "u1", name: "send_quick_reply", input: { code: "Q1" } }] },
  { role: "user", content: delivered("Dạ bên em còn chả mực giã tay ăn kèm rất hợp ạ — mình xem menu chọn thêm nhé.") },
  { role: "assistant", content: txt("[Shop đã nhắn] Mình dùng thêm nước mắm không ạ?") },
  { role: "user", content: txt(`${PHONE}, 9 Hai Bà Trưng, Hoàn Kiếm, Hà Nội`) },
];

function testPure() {
  assert.deepEqual(parseAuditArgs(["hslc-hmt-shop"]), { code: "hslc-hmt-shop", days: 7 });
  assert.deepEqual(parseAuditArgs(["hslc", "--days=30"]), { code: "hslc", days: 30 });
  assert.deepEqual(parseAuditArgs(["hslc", "--since=2026-10-16T08:10Z"]), { code: "hslc", days: 7, since: new Date("2026-10-16T08:10:00Z") });
  for (const bad of [[], ["HSLC;rm"], ["hslc", "--days=91"], ["hslc", "--since=hôm qua"], ["hslc", "--since=2026-10-16"]]) assert.ok("error" in parseAuditArgs(bad), `đối số sai bị từ chối: ${bad.join(" ")}`);

  const c = offersOfConversation(HSLC, { cancelRequest: { orderIds: [], at: "", turn: 1, quote: null, reason: "x" } });
  // Lời mời 1 = tin bot đầu (mời 2kg SAU khi khách đã chọn 2kg + hỏi lại quy cách); lời mời 2 = câu mẫu menu SAU khi khách «không em».
  // Tin «[Shop đã nhắn]» là của page / nhân viên — không đếm.
  assert.deepEqual(c, { offers: 2, afterDecline: 1, upsellAfterSize: 1, reaskAfterSize: 1, endedCancelled: true });
  const clean = offersOfConversation([{ role: "user", content: txt("Cho chị 1kg chả cá thu") }, { role: "assistant", content: txt("Dạ mình dùng thêm chả mực giã tay ăn kèm không ạ? Cho em xin SĐT nhé.") }, { role: "user", content: txt("ok lấy thêm 1kg chả mực") }], {});
  assert.deepEqual(clean, { offers: 1, afterDecline: 0, upsellAfterSize: 0, reaskAfterSize: 0, endedCancelled: false });
  const t = addConversation(addConversation(emptyTotals(), c, [{ reason: "CONTACT_INFO" }, { reason: "DECLINED" }]), clean, []);
  assert.deepEqual([t.conversations, t.withOffer, t.offers, t.repeated, t.afterDecline, t.cancelledAfterOffer, t.drops.CONTACT_INFO, t.drops.DECLINED], [2, 2, 3, 1, 1, 1, 1, 1]);
}

function testSource() {
  const src = readFileSync("scripts/upsell-offer-audit.ts", "utf8");
  assert.match(src, /process\.env\.ERP_READ_ONLY = "1"/);
  assert.match(src, /show default_transaction_read_only/);
  assert.match(src, /getDbForInspection\(/);
  assert.match(src, /withOrganization\(/);
  assert.match(src, /process\.stdout\.write\("", \(\) => process\.exit/, "xả stdout trước khi thoát");
  assert.doesNotMatch(src, /\.(insert|update|delete)\(|\binsert into\b|\bupdate \w+ set\b/i, "script không câu ghi");
  assert.ok(!/\(\?<[=!]/.test(src), "không nhìn-ngược");
  assert.match(src, /loadAiSalesPerformance\(/, "phễu + upsell dùng lại performance.ts, không tự tính");
  for (const line of src.split("\n").filter((l) => /tomTat\(`/.test(l))) assert.doesNotMatch(line, /\$\{(?:t|text|conv\.id|r\.content|msgs)\}/, `dòng tóm tắt không in dữ liệu người: ${line.trim().slice(0, 120)}`);
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8").replace(/\r\n/g, "\n");
  assert.match(ops, /- upsell-offer-audit\s+#/, "ops-vps khai lựa chọn");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\bupsell-offer-audit\b/, "kết quả MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\bupsell-offer-audit\b/, "làn ĐỌC nặng");
  assert.match(ops, /\n\s+upsell-offer-audit\)\n[\s\S]*?ma_hoa_ket_qua chay_voi_arg[^\n]*scripts\/upsell-offer-audit\.ts ;;/, "nhánh chạy đúng script, trong ma_hoa_ket_qua");
  assert.ok(readFileSync("tests/platform-isolation-static.test.ts", "utf8").includes('"scripts/upsell-offer-audit.ts":'), "khai getDbForInspection ở platform-isolation-static");
}

async function testDb() {
  const db = await getDb();
  const a = randomUUID();
  const b = randomUUID();
  const now = Date.now();
  const rows = (conv: string, parts: readonly { role: string; content: unknown }[]) => parts.map((p, i) => ({ conversationId: conv, seq: i + 1, role: p.role as "user" | "assistant", content: p.content as Record<string, unknown>[], createdAt: new Date(now - (parts.length - i) * 60_000) }));
  try {
    await db.insert(schema.salesChatConversations).values([
      { id: a, channel: "WEB", status: "OPEN", state: { cancelRequest: { orderIds: [], at: new Date(now).toISOString(), turn: 7, quote: null, reason: "x" }, offerDrops: [{ turn: 7, cls: "CROSS_SELL", reason: "CONTACT_INFO", via: "TEXT" }] } },
      { id: b, channel: "TEST", status: "OPEN", state: {} },
    ]);
    await db.insert(schema.salesChatMessages).values([...rows(a, HSLC), ...rows(b, HSLC)]);
    const t = await auditOffers(db, new Date(now - 3_600_000));
    // Hội thoại khung thử (b) bị loại; CSDL thử dùng chung với bài kiểm khác nên có thể có hội thoại khác trong kỳ ⇒ so ≥.
    assert.ok(t.conversations >= 1 && t.offers >= 2 && t.afterDecline >= 1 && t.reaskAfterSize >= 1 && t.cancelledAfterOffer >= 1 && t.drops.CONTACT_INFO >= 1, JSON.stringify(t));
    const only = await auditOffers(db, new Date(now + 3_600_000));
    assert.equal(only.conversations, 0, "ngoài kỳ ⇒ không đếm");
  } finally {
    await db.delete(schema.salesChatMessages).where(inArray(schema.salesChatMessages.conversationId, [a, b]));
    await db.delete(schema.salesChatConversations).where(inArray(schema.salesChatConversations.id, [a, b]));
  }
}

export async function testUpsellOfferAudit() {
  testPure();
  testSource();
  await testDb();
  console.log("  ✓ ops upsell-offer-audit: phễu + upsell từ sổ sự kiện (performance.ts), lời mời đọc từ chữ đã gửi bằng bộ phân loại của máy chủ (mời lặp · sau từ chối · sau khi đã chọn quy cách · có mời rồi huỷ), lời mời máy chủ đã bỏ theo lý do; chỉ đọc, khai đủ bốn chỗ");
}

if (process.argv[1] && /upsell-offer-audit\.test\.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testUpsellOfferAudit)
    .then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
}

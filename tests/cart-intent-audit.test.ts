/**
 * ═══════════ ops `cart-intent-audit` — bot tự HẠ số lượng khách đã nói / đơn đủ ORDER_READY vẫn bị hỏi · mời (P0 HSLC 12/10/2026) ═══════════
 *
 *  · Thuần: đối số; một hội thoại dựng ĐÚNG ca production («Cho chị 2kg chả cá thu / ĐT … / F4/22A …» → «Ngon chị mới lấy nha em» →
 *    bot «Mình lấy 1kg ăn thử trước nhé» → đơn nháp sửa xuống 1kg) ⇒ CART_INTENT_DRIFT (chữ + dòng hàng); «ok» / câu sửa tường minh ⇒
 *    không đếm; đủ ORDER_READY rồi bot vẫn mời «lấy thêm gì không» ở lượt sau ⇒ ORDER_READY_LOOP; sự việc trước cửa sổ không đếm.
 *  · CSDL thật (PGlite): hai hội thoại ⇒ dòng tóm tắt đếm đúng, KHÔNG lọt SĐT / địa chỉ / chữ tin / mã hội thoại; mã ở phần MÃ HOÁ.
 *  · Mã nguồn: không câu ghi, ép chỉ đọc, TỰ CHỨA (không import tệp lib mới — ops lấy script từ main, lib từ image đang chạy), ops khai
 *    đủ bốn chỗ, platform-isolation-static khai getDbForInspection.
 *  Mốc dữ liệu dựng TƯƠNG ĐỐI theo đồng hồ thật, cùng đồng hồ với cửa sổ đo (luật 50).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { auditConversation, classifyCartMessage, genericSalesAsk, parseCartAuditArgs, rateText, runCartIntentAudit, type AuditMsg } from "../scripts/cart-intent-audit";

const PHONE = "0368571285";
const ADDR = "F4/22A ấp 4, xã Bà Điểm, Hóc Môn, TP Hồ Chí Minh";
const OPEN = `Cho chị 2kg chả cá thu\nĐT ${PHONE}\n${ADDR}`;
const txt = (t: string) => [{ type: "text", text: t }];
const result = (o: Record<string, unknown>, isError = false) => [{ type: "tool_result", toolUseId: "tu", content: JSON.stringify(o), isError }];
const draft = (name: string, quantity: number, extra: Record<string, unknown> = {}) => result({ order_code: "#AB12CD34", status: "Nháp — chưa chốt, chưa giữ hàng", lines: [{ name, quantity }], ...extra });

/** Dựng chuỗi tin cách nhau một phút, kết thúc «bây giờ» trừ `endAgoMin`. */
function convo(parts: [string, unknown][], endAgoMin = 1): AuditMsg[] {
  const now = Date.now();
  return parts.map(([role, content], i) => ({ seq: i + 1, role, content, at: new Date(now - (endAgoMin + parts.length - i) * 60_000) }));
}

function testArgs() {
  const at = new Date();
  assert.deepEqual(parseCartAuditArgs(["hslc"], at), { code: "hslc", days: 7, since: null });
  assert.deepEqual(parseCartAuditArgs(["hslc", "--days=30"], at), { code: "hslc", days: 30, since: null });
  assert.ok("error" in parseCartAuditArgs(["hslc", "--days=31"], at));
  assert.ok("error" in parseCartAuditArgs([], at));
  assert.ok("error" in parseCartAuditArgs(["hslc", "--fix"], at), "cờ lạ");
  const since = new Date(at.getTime() - 3_600_000);
  assert.equal((parseCartAuditArgs(["hslc", `--since=${since.toISOString()}`], at) as { since: Date }).since.getTime(), since.getTime());
  assert.ok("error" in parseCartAuditArgs(["hslc", `--since=${new Date(at.getTime() + 60_000).toISOString()}`], at), "mốc ở tương lai");
  assert.ok("error" in parseCartAuditArgs(["hslc", `--since=${new Date(at.getTime() - 40 * 86_400_000).toISOString()}`], at), "mốc cũ hơn 30 ngày");
  assert.ok("error" in parseCartAuditArgs(["hslc", "--since=hom-qua"], at));
  assert.equal(rateText(0, 0), "CHƯA ĐO ĐƯỢC (mẫu 0)");
  assert.equal(rateText(3, 40), "3/40 (7,5%)");
  assert.equal(rateText(1, 2), "1/2 (50,0%) · mẫu nhỏ");
}

const PRODUCTION: [string, unknown][] = [
  ["user", txt(OPEN)],
  ["assistant", [{ type: "tool_use", id: "tu", name: "create_draft_order", input: {} }]],
  ["user", draft("Chả cá thu (2kg)", 1)],
  ["assistant", txt("Tóm tắt: 2kg chả cá thu 540.000 ₫. Mình lấy thêm gì không, không thì em giao luôn ạ?")],
  ["user", txt("Ngon chị mới lấy nha em")],
  ["assistant", txt("Mình lấy 1kg ăn thử trước nhé, ngon thì lần sau lấy thêm ạ")],
  ["user", txt("ừ")],
  ["assistant", [{ type: "tool_use", id: "tu", name: "update_draft_order", input: {} }]],
  ["user", draft("Chả cá thu (1kg)", 1)],
];

function testPure() {
  // Bộ luật trong script là bản sao của lib/sales-chatbot/cart-commitment.ts — vài ca chốt của bảng ca bên đó.
  assert.equal(classifyCartMessage("Ngon chị mới lấy nha em").kind, "AMBIGUOUS");
  assert.equal(classifyCartMessage("không lấy thêm đâu").kind, "AMBIGUOUS");
  assert.equal(classifyCartMessage("đổi 1kg thôi").kind, "SET");
  assert.equal(classifyCartMessage(OPEN).kind, "ORDER");

  const start = new Date(Date.now() - 86_400_000);
  const prod = auditConversation(convo(PRODUCTION), start);
  assert.equal(prod.explicit, true);
  assert.ok(prod.readyAt, "một tin đủ món + số lượng + SĐT + địa chỉ ⇒ ORDER_READY");
  assert.deepEqual(prod.drift.map((d) => d.kind), ["TEXT_TRIAL", "DRAFT_REDUCED"], "ca production: câu «1kg ăn thử» + đơn nháp xuống 1kg");

  // «ok» rồi chốt đúng 2kg ⇒ không lỗi nào.
  const ok = auditConversation(convo([["user", txt(OPEN)], ["user", draft("Chả cá thu (2kg)", 1)], ["assistant", txt("Tóm tắt: 2kg chả cá thu 540.000 ₫. Mình lấy thêm gì không, không thì em giao luôn ạ?")], ["user", txt("ok")], ["user", result({ confirmed: true, order_code: "#AB12CD34", lines: [{ name: "Chả cá thu (2kg)", quantity: 1 }] })], ["assistant", txt("Dạ em lên đơn cho mình rồi ạ.")]]), start);
  assert.deepEqual([ok.drift.length, ok.loop.length], [0, 0]);

  // Câu sửa tường minh ⇒ đơn 1kg KHÔNG phải trôi ý định.
  const fixed = auditConversation(convo([["user", txt(OPEN)], ["user", draft("Chả cá thu (2kg)", 1)], ["user", txt("đổi 1kg thôi")], ["user", draft("Chả cá thu (1kg)", 1)], ["assistant", txt("Dạ em sửa còn 1kg chả cá thu ạ.")]]), start);
  assert.equal(fixed.drift.length, 0);
  // Khách có ý bớt mà không rõ số («bớt đi em») ⇒ bản sửa không chặn lượt đó ⇒ đơn 1kg sau đó KHÔNG đếm là trôi ý định.
  assert.equal(auditConversation(convo([["user", txt(OPEN)], ["user", draft("Chả cá thu (2kg)", 1)], ["user", txt("bớt đi em")], ["user", draft("Chả cá thu (1kg)", 1)]]), start).drift.length, 0);
  // P0-1 của review: câu nhiều lượng không làm script ném.
  assert.doesNotThrow(() => auditConversation(convo([["user", txt(OPEN)], ["user", txt("thêm 1kg, thêm 1kg nữa")], ["user", txt("cho chị 2kg, à không 1kg")]]), start));
  // 2kg = 2 × gói 1kg ⇒ không hạ.
  assert.equal(auditConversation(convo([["user", txt(OPEN)], ["user", draft("Chả cá thu (1kg)", 2)]]), start).drift.length, 0);

  // Đủ ORDER_READY: lượt trả lời NGAY được mời một lần; khách đáp rồi bot VẪN mời / hỏi ⇒ ORDER_READY_LOOP.
  const loop = auditConversation(convo([["user", txt(OPEN)], ["assistant", txt("Dạ mình lấy thêm gì không ạ?")], ["user", txt("thế thôi em")], ["assistant", txt("Dạ chị có muốn lấy thêm chả mực không ạ?")], ["user", txt("không")], ["assistant", txt("Chị lấy mấy kg ạ?")]]), start);
  assert.deepEqual(loop.loop.map((l) => l.kind), ["UPSELL", "REASK"]);
  // Đơn đã chốt ⇒ câu hỏi sau đó không tính vòng lặp.
  const after = auditConversation(convo([["user", txt(OPEN)], ["user", result({ auto_confirmed: true, order_code: "#AB12CD34", lines: [{ name: "Chả cá thu (2kg)", quantity: 1 }] })], ["user", txt("ok em")], ["assistant", txt("Dạ mình lấy thêm gì không ạ?")]]), start);
  assert.equal(after.loop.length, 0);
  // Chưa đủ (thiếu địa chỉ) ⇒ không ORDER_READY.
  assert.equal(auditConversation(convo([["user", txt(`Cho chị 2kg chả cá thu, ĐT ${PHONE}`)]]), start).readyAt, null);

  // Cửa sổ: sự việc TRƯỚC mốc không đếm (tin trước mốc vẫn dựng giỏ).
  const old = convo(PRODUCTION, 120);
  assert.equal(auditConversation(old, new Date(Date.now() - 60 * 60_000)).drift.length, 0);
  assert.equal(auditConversation(old, new Date(Date.now() - 24 * 60 * 60_000)).drift.length, 2);

  assert.equal(genericSalesAsk("Dạ 2kg chả cá thu 540.000 ₫ ạ.", undefined, ""), null, "câu báo giá không hỏi gì");
  assert.equal(genericSalesAsk("Dạ cho em xin SĐT ạ?", undefined, ""), "REASK");
}

function testSource() {
  const src = readFileSync("scripts/cart-intent-audit.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/\.(insert|update|delete)\(/.test(code) && !/\b(insert into|update \w+ set|delete from)\b/i.test(code), "script không có câu ghi nào");
  assert.match(src, /process\.env\.ERP_READ_ONLY = "1"/);
  assert.match(src, /show default_transaction_read_only/);
  assert.match(src, /getDbForInspection/);
  assert.ok(!/\bgetDb\(|withOrganization/.test(code), "không gọi lib đọc getDb() — chỉ handle chỉ đọc của tổ chức đã chọn");
  // TỰ CHỨA: mọi tệp script import phải CÓ trên main hôm nay (image đang chạy) — không kéo tệp lib mới của nhánh sửa.
  for (const m of code.matchAll(/from "@\/([^"]+)"/g)) assert.ok(existsSync(`${m[1]}.ts`) || existsSync(`${m[1]}/index.ts`), `import @/${m[1]} phải có sẵn`);
  assert.ok(!code.includes("cart-commitment"), "không import lib/sales-chatbot/cart-commitment (chưa có trên image)");
  assert.ok(!/\(\?<[=!]/.test(code), "không nhìn-ngược");
  assert.match(src, /process\.stdout\.write\("", \(\) => done\(\)\)/, "xả stdout trước khi thoát");
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8").replace(/\r\n/g, "\n");
  assert.match(ops, /- cart-intent-audit\s+#/, "ops-vps khai lựa chọn");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\bcart-intent-audit\b/, "kết quả MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\bcart-intent-audit\b/, "làn ĐỌC nặng");
  assert.match(ops, /\n\s+cart-intent-audit\)\n[\s\S]*?ma_hoa_ket_qua chay_voi_arg[^\n]*scripts\/cart-intent-audit\.ts ;;/, "nhánh chạy đúng script, trong ma_hoa_ket_qua");
  assert.ok(readFileSync("tests/platform-isolation-static.test.ts", "utf8").includes('"scripts/cart-intent-audit.ts":'), "khai getDbForInspection ở platform-isolation-static");
}

async function capture(fn: () => Promise<unknown>): Promise<string[]> {
  const printed: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return printed;
}

async function testDb() {
  const db = await getDb();
  const bad = randomUUID();
  const good = randomUUID();
  const now = Date.now();
  const rows = (conv: string, parts: [string, unknown][]) => parts.map(([role, content], i) => ({ conversationId: conv, seq: i + 1, role: role as "user" | "assistant", content: content as Record<string, unknown>[], createdAt: new Date(now - (parts.length - i) * 60_000) }));
  try {
    await db.insert(schema.salesChatConversations).values([
      { id: bad, channel: "WEB", status: "OPEN" },
      { id: good, channel: "WEB", status: "OPEN" },
    ]);
    await db.insert(schema.salesChatMessages).values([
      ...rows(bad, PRODUCTION),
      ...rows(good, [["user", txt(OPEN)], ["user", draft("Chả cá thu (2kg)", 1)], ["assistant", txt("Tóm tắt: 2kg chả cá thu 540.000 ₫. Mình lấy thêm gì không, không thì em giao luôn ạ?")], ["user", txt("không lấy thêm đâu")], ["assistant", txt("Dạ mình có muốn lấy thêm chả mực không ạ?")]]),
    ]);
    let res: Awaited<ReturnType<typeof runCartIntentAudit>> | null = null;
    const printed = await capture(async () => {
      res = await runCartIntentAudit(db, { windowStart: new Date(now - 86_400_000), now: new Date(), label: "kiểm thử", convIds: [bad, good] });
    });
    assert.ok(res);
    const r = res as Awaited<ReturnType<typeof runCartIntentAudit>>;
    assert.deepEqual([r.conversations, r.explicit, r.ready], [2, 2, 2]);
    assert.deepEqual(r.driftConvs, [bad]);
    assert.deepEqual(r.driftByKind, { TEXT_DOWNSELL: 0, TEXT_TRIAL: 1, DRAFT_REDUCED: 1 });
    assert.deepEqual(r.loopConvs, [good], "khách «không lấy thêm đâu» rồi bot VẪN mời ⇒ vòng lặp");
    const sum = printed.filter((l) => l.startsWith("[ops:tom-tat]"));
    const all = sum.join("\n");
    assert.match(all, /CART_INTENT_DRIFT \(ESTIMATED[^)]*\): 1\/2 \(50,0%\) · mẫu nhỏ hội thoại có số lượng tường minh · sự việc TEXT_TRIAL 1 · DRAFT_REDUCED 1/, all);
    assert.match(all, /ORDER_READY_LOOP \(ESTIMATED[^)]*\): 1\/2 \(50,0%\) · mẫu nhỏ hội thoại đủ ORDER_READY .* lượt UPSELL 1/, all);
    assert.ok(!all.includes(bad) && !all.includes(good), "kênh tóm tắt không in mã hội thoại");
    assert.ok(printed.some((l) => !l.startsWith("[ops:tom-tat]") && l.includes(bad)), "mã hội thoại theo lỗi nằm ở phần MÃ HOÁ");
    for (const p of printed) assert.ok(!p.includes(PHONE) && !p.includes("Bà Điểm") && !p.includes("Ngon chị") && !p.includes("ăn thử trước"), `không lọt SĐT / địa chỉ / chữ tin: ${p}`);
  } finally {
    await db.delete(schema.salesChatMessages).where(inArray(schema.salesChatMessages.conversationId, [bad, good]));
    await db.delete(schema.salesChatConversations).where(inArray(schema.salesChatConversations.id, [bad, good]));
  }
}

export async function testCartIntentAudit() {
  testArgs();
  testPure();
  testSource();
  await testDb();
  console.log("  ✓ ops cart-intent-audit: ca production (2kg → «Ngon chị mới lấy nha em» → «1kg ăn thử» + đơn xuống 1kg) ⇒ CART_INTENT_DRIFT; «ok» / câu sửa tường minh / 2 × 1kg không đếm; đủ ORDER_READY mà vẫn mời / hỏi lại ⇒ ORDER_READY_LOOP; cửa sổ --since; tóm tắt không lọt PII; chỉ đọc, tự chứa, khai đủ bốn chỗ");
}

if (process.argv[1] && /cart-intent-audit\.test\.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testCartIntentAudit)
    .then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
}

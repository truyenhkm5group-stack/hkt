/**
 * Ops `conv-money-trace` (P0 HSLC 14/10/2026 — «Châu Dương»: bot báo TỔNG 640.000 ₫ cho 1kg 280.000 ₫; «Viet Nguyen Thi»: bot tự nói «nói
 * rõ hơn» sau câu upsell khi khách không nhắn gì):
 *  1. đối số được soát; số «TỔNG» đọc đúng («tổng tiền hàng» là tiền hàng, «a + b = c» lấy c); câu cố định của engine nhận theo hằng
 *     số đang chạy; câu mẫu có số tiền cố định (ngoài ô điền giá) bị nhận ra;
 *  2. CSDL thật (hội thoại dựng theo hai ca, tự dọn): tin bot có TỔNG ≠ báo giá giỏ ⇒ LỆCH; «nói rõ hơn» không có tin khách mới ⇒ đếm;
 *     tóm tắt không lọt chữ tin / SĐT / mã hội thoại; quét --scan đếm đúng hai mẫu;
 *  3. chỉ đọc, xả stdout trước khi thoát, khai đủ bốn chỗ ở ops-vps + platform-isolation-static.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { CLAIM_SAFE_TEXT } from "@/lib/sales-chatbot/claim-guard";
import { EMPTY_REPLY_TEXT } from "@/lib/sales-chatbot/engine";
import { COMMENT_ALREADY_NOTE, COMMENT_CARRY_LABEL, fixedAmountsInTemplate, reviewCodesText, fixedTextKind, moneyOfToolResult, parseTraceArgs, QUICK_REPLAY_VARIANTS, quickDecisionAt, quickReplyHead, scanAiPerformance, scanPatterns, totalClaimsIn, traceConversation, wrongProductTemplate } from "../scripts/conv-money-trace";

const PHONE = "0900003106";

function testPure() {
  assert.deepEqual(parseTraceArgs(["hslc-hmt-shop", "--conv=1B942A28-86BA-4146-BF0A-2A9705F05AD3", "--order=#91F3641C"]), { code: "hslc-hmt-shop", conv: "1b942a28-86ba-4146-bf0a-2a9705f05ad3", order: "91f3641c", scan: false, days: 3 });
  assert.deepEqual(parseTraceArgs(["hslc", "--scan", "--days=7"]), { code: "hslc", conv: null, order: null, scan: true, days: 7 });
  assert.deepEqual(parseTraceArgs(["hslc-hmt-shop", "--order=42F28794"]), { code: "hslc-hmt-shop", conv: null, order: "42f28794", scan: false, days: 3 }, "chỉ mã đơn ngắn (org-order-audit in 8 ký tự cuối) ⇒ tự tìm hội thoại của đơn");
  assert.ok("error" in parseTraceArgs(["hslc-hmt-shop"]), "không --conv / --order / --scan ⇒ từ chối");
  assert.deepEqual(parseTraceArgs(["hslc-hmt-shop", "--at=2026-10-18T10:06Z", "--window=20"]), { code: "hslc-hmt-shop", conv: null, order: null, scan: false, days: 3, at: new Date("2026-10-18T10:06Z"), windowMin: 20 }, "tìm theo MỐC GIỜ, không theo tên khách");
  assert.ok("error" in parseTraceArgs(["hslc-hmt-shop", "--at=17:06"]), "--at phải là mốc UTC đầy đủ");
  assert.ok("error" in parseTraceArgs(["hslc-hmt-shop", "--at=2026-10-18T10:06Z", "--window=999"]), "--window có trần");
  assert.equal(reviewCodesText({}), "đang mở không · người đã kiểm chưa");
  assert.equal(reviewCodesText({ review: { entries: [{ code: "ADDRESS_UNRESOLVED", note: "Hà Nội" }, { code: "LA" }] } }), "đang mở ADDRESS_UNRESOLVED+KHAC · người đã kiểm chưa", "mã lạ ⇒ KHAC, không in ghi chú");
  assert.equal(reviewCodesText({ review: null, reviewLog: [{ action: "CONFIRMED", byName: "Chị A", entries: [{ code: "ADDRESS_UNRESOLVED" }] }] }), "đang mở không · người đã kiểm CONFIRMED:ADDRESS_UNRESOLVED", "nhân viên bấm Xác nhận ⇒ cờ về null, lượt kiểm vào reviewLog; không in tên người bấm");
  assert.ok(readFileSync(path.join(__dirname, "..", "lib", "sales-chatbot", "engine.ts"), "utf8").includes(`\`${COMMENT_CARRY_LABEL}\${at.toISOString()}]\``), "nhãn đếm ở dòng C TRÙNG đúng nhãn carryCommentTurn gắn (đổi một bên thì dòng C đếm 0 mãi)");
  assert.ok(readFileSync(path.join(__dirname, "..", "lib", "sales-chatbot", "fanpage.ts"), "utf8").includes(`reason: "${COMMENT_ALREADY_NOTE} (Pancake tự động / nhân viên)`), "mẫu số ALREADY đếm đúng câu lý do fanpage.ts ghi vào dòng tin");
  assert.deepEqual(parseTraceArgs(["hslc", "--scan", "--since=2026-10-14T08:10Z"]), { code: "hslc", conv: null, order: null, scan: true, days: 3, since: new Date("2026-10-14T08:10:00Z") }, "--since đo đúng khoảng sau deploy");
  for (const bad of ["--since=hôm qua", "--since=2026-10-14", "--since=2026-10-14T08:10"]) assert.ok("error" in parseTraceArgs(["hslc", "--scan", bad]), `--since sai bị từ chối: ${bad}`);
  for (const bad of [[], ["hslc"], ["HSLC;rm", "--scan"], ["hslc", "--conv=abc"], ["hslc", "--scan", "--days=31"], ["hslc", "--conv=1b942a28-86ba-4146-bf0a-2a9705f05ad3", "--order=xyz"]]) assert.ok("error" in parseTraceArgs(bad), `đối số sai bị từ chối: ${bad.join(" ")}`);

  assert.deepEqual(totalClaimsIn("Dạ đơn của mình: 1kg chả cá thu 280.000đ. Tổng 640.000đ, miễn phí ship ạ"), [640_000]);
  assert.deepEqual(totalClaimsIn("Tiền hàng 280k + ship 30k = tổng 310k"), [310_000]);
  assert.deepEqual(totalClaimsIn("Tổng: 280k + 30k = 310.000 ₫"), [310_000], "«=» ⇒ lấy số sau dấu bằng cuối");
  assert.deepEqual(totalClaimsIn("Tổng tiền hàng 280.000đ, phí ship báo sau"), [], "tổng tiền hàng là tiền hàng");
  assert.deepEqual(totalClaimsIn("1kg 280k, 2kg 540k ạ"), [], "bảng giá không phải tổng");
  assert.deepEqual(totalClaimsIn("Thanh toán khi nhận hàng (COD) 280.000 ₫ nhé"), [280_000]);

  assert.equal(fixedTextKind(EMPTY_REPLY_TEXT), "EMPTY_REPLY");
  assert.equal(fixedTextKind(CLAIM_SAFE_TEXT.PRICE), "CLAIM_SAFE");
  assert.equal(fixedTextKind("Dạ, em giữ đơn 2kg chả cá thu như mình đã chọn nhé."), "CART_HOLD");
  assert.equal(fixedTextKind("[Shop đã nhắn] 1kg 280k"), "SHOP_SAID");
  assert.equal(fixedTextKind("Dạ tổng 280k ạ"), null);

  assert.deepEqual(fixedAmountsInTemplate("Combo 2kg chỉ 540k, 1kg {{gia:CHA-1KG}}"), [540_000], "số gõ cứng trong câu mẫu bị nhận ra, ô điền giá thì không");
  const mo = moneyOfToolResult(JSON.stringify({ lines: [{ variant_id: "v1", quantity: 1, unit_price: 280000, line_total: 280000 }], subtotal: 280000, shipping_fee: 0, cod_total: 280000, __summary: "Lên đơn nháp · 280.000 ₫", __deliver: null }));
  assert.ok(mo && mo.total === 280_000 && mo.lines[0].unitPrice === 280_000 && mo.summary.startsWith("Lên đơn"));
  assert.equal(moneyOfToolResult("không phải json"), null);
}

function testSource() {
  const src = readFileSync("scripts/conv-money-trace.ts", "utf8");
  assert.match(src, /process\.env\.ERP_READ_ONLY = "1"/);
  assert.match(src, /show default_transaction_read_only/);
  assert.match(src, /getDbForInspection\(/);
  assert.match(src, /withOrganization\(/);
  assert.match(src, /process\.stdout\.write\("", \(\) => process\.exit/, "xả stdout trước khi thoát");
  assert.doesNotMatch(src, /\.(insert|update|delete)\(|\binsert into\b|\bupdate \w+ set\b/i, "script không câu ghi");
  assert.ok(!/\(\?<[=!]/.test(src), "không nhìn-ngược");
  for (const line of src.split("\n").filter((l) => /tomTat\(`/.test(l))) assert.doesNotMatch(line, /\$\{(?:t|text|conv\.id|r\.text|x\.content|r\.messageId|r\.senderId)\b/, `dòng tóm tắt không in dữ liệu người: ${line.trim().slice(0, 120)}`);
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8").replace(/\r\n/g, "\n");
  assert.match(ops, /- conv-money-trace\s+#/, "ops-vps khai lựa chọn");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\bconv-money-trace\b/, "kết quả MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\bconv-money-trace\b/, "làn ĐỌC nặng");
  assert.match(ops, /\n\s+conv-money-trace\)\n[\s\S]*?ma_hoa_ket_qua chay_voi_arg[^\n]*scripts\/conv-money-trace\.ts ;;/, "nhánh chạy đúng script, trong ma_hoa_ket_qua");
  assert.ok(readFileSync("tests/platform-isolation-static.test.ts", "utf8").includes('"scripts/conv-money-trace.ts":'), "khai getDbForInspection ở platform-isolation-static");
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

const txt = (text: string) => [{ type: "text", text }];

async function testDb() {
  const db = await getDb();
  const money = randomUUID();
  const empty = randomUUID();
  const qty = randomUUID();
  const now = Date.now();
  const rows = (conv: string, parts: [string, unknown][]) => parts.map(([role, content], i) => ({ conversationId: conv, seq: i + 1, role: role as "user" | "assistant", content: content as Record<string, unknown>[], createdAt: new Date(now - (parts.length - i) * 60_000) }));
  const draftResult = JSON.stringify({ lines: [{ variant_id: "v-1kg", quantity: 1, unit_price: 280000, line_total: 280000 }], subtotal: 280000, shipping_fee: 0, cod_total: 280000, __summary: "Lên đơn nháp · 280.000 ₫" });
  try {
    await db.insert(schema.salesChatConversations).values([
      { id: money, channel: "WEB", status: "OPEN", state: { quote: { id: "q1", priceVersion: "p", verified: true, subtotal: 280000, total: 280000, amounts: [280000, 0], reasons: [], at: new Date(now).toISOString() }, upsellSent: true } },
      { id: empty, channel: "WEB", status: "WAITING", state: { upsellSent: true } },
      { id: qty, channel: "WEB", status: "OPEN", state: {} },
    ]);
    await db.insert(schema.salesChatMessages).values([
      ...rows(money, [
        ["user", txt(`Lấy chị 1kg nhé, sđt ${PHONE}, Bình Thạnh`)],
        ["assistant", [{ type: "tool_use", id: "t1", name: "create_draft_order", input: { items: [{ variant_id: "v-1kg", quantity: 1 }], recipient_name: "X", phone: PHONE } }]],
        ["user", [{ type: "tool_result", toolUseId: "t1", content: draftResult, isError: false }]],
        ["assistant", txt("Dạ em lên đơn 1kg chả cá thu 280.000đ. Tổng 640.000đ, miễn phí ship ạ")],
      ]),
      ...rows(empty, [
        ["user", txt(`1kg chả cá, ${PHONE}, Quận 12`)],
        ["assistant", [{ type: "tool_use", id: "u1", name: "send_quick_reply", input: { code: "Q1" } }]],
        ["user", [{ type: "tool_result", toolUseId: "u1", content: JSON.stringify({ sent: true, __summary: "Gửi câu mẫu «Các món bán chạy»", __deliver: "Shop còn có chả mực ạ" }), isError: false }]],
        ["assistant", txt(EMPTY_REPLY_TEXT)],
      ]),
      // F (P0 21/10/2026, ca «Lan Nguyen»): «2kg» sau «1kg hay 2kg?» ⇒ bot gửi LẠI câu báo giá + hỏi lại số lượng; «lấy 2» lần sau cũng vậy.
      ...rows(qty, [
        ["user", txt("Chả cá thu giá bao nhiêu shop?")],
        ["assistant", txt("Dạ chả cá thu 280.000 ₫/kg ạ. Mình muốn mua 1kg hay 2kg ạ?")],
        ["user", txt("2kg")],
        ["assistant", txt("Dạ chả cá thu 280.000 ₫/kg ạ. Mình muốn mua 1kg hay 2kg ạ?")],
        ["user", txt("lấy 2")],
        ["assistant", txt("Dạ em ghi nhận mình lấy 2kg Chả cá thu ạ. Mình cho em xin số điện thoại nhận hàng nhé.")],
        // G (ca «Xuân Đoàn»): số lượng + hỏi thời gian giao ⇒ bot đọc lại bảng giá, không đụng tới chuyện giao.
        ["user", txt("Cho chị 2kg. Mấy ngày nhận được hàng?")],
        ["assistant", txt("Dạ chả cá thu 280.000 ₫/kg, 2kg 540.000 ₫ ạ.")],
      ]),
    ]);
    const ctx = { names: new Map([["v-1kg", "Chả cá thu · 1kg"]]), reference: new Set([0, 280000, 540000, 640000]), handoffText: null, aiDownText: null, templates: [] };
    const p1 = await capture(() => traceConversation(db, money, null, ctx));
    const s1 = p1.filter((l) => l.startsWith("[ops:tom-tat]")).join("\n");
    assert.match(s1, /tin bot có số TỔNG lệch báo giá 1/, s1);
    assert.ok(p1.some((l) => /TỔNG 640\.000 ₫ ≠ báo giá 280\.000 ₫ — LỆCH/.test(l) && /640\.000 ₫\[R\]/.test(l)), "640k chỉ thuộc tập THAM CHIẾU, không thuộc báo giá giỏ");
    assert.ok(p1.some((l) => /Chả cá thu · 1kg × 1 @ 280\.000 ₫/.test(l)), "dòng nháp in theo tên danh mục");
    const p2 = await capture(() => traceConversation(db, empty, null, ctx));
    const s2 = p2.filter((l) => l.startsWith("[ops:tom-tat]")).join("\n");
    assert.match(s2, /câu «nói rõ hơn» không có tin khách mới 1/, s2);
    assert.match(s2, /CÂU MẪU qua send_quick_reply 1/, s2);
    assert.ok(p2.some((l) => /NGUỒN CỐ ĐỊNH:EMPTY_REPLY .*KHÔNG có tin khách mới/.test(l)));
    const p3 = await capture(() => scanPatterns(db, 1, new Date()));
    const s3 = p3.filter((l) => l.startsWith("[ops:tom-tat]")).join("\n");
    assert.match(s3, /KHÔNG có tin khách mới kể từ tin bot trước [1-9]\d* tin/, s3);
    assert.match(s3, /≠ tổng giỏ \/ nháp máy chủ ngay trước: [1-9]\d* tin/, s3);
    // F: ca gieo «2kg» ⇒ một tin lặp (câu báo giá gửi lại); lượt «lấy 2» được trả lời đúng ⇒ không tính; cả hai tin khách vào mẫu số.
    // CSDL thử dùng chung với các bài khác ⇒ số đếm là SÀN, không phải số tuyệt đối (AGENTS mục 65); ca gieo ở đây phải nằm trong mẫu F.
    assert.match(s3, /F CUSTOMER_SELECTED_QUANTITY_BUT_BOT_REASKED — trả lời số lượng ngắn mà bot hỏi lại \/ gửi lại câu đã gửi: [1-9]\d* tin \/ [1-9]\d* hội thoại · câu mẫu \d+ \(0 token\) · AI [1-9]\d* \(lời gọi model thừa\) · mẫu số (?:[2-9]|\d{2,})\d* tin/, s3);
    assert.ok(p3.some((l) => l.startsWith("  mẫu F (≤ 20):") && l.includes(qty)), "hội thoại «2kg» bị gửi lại câu báo giá nằm trong mẫu F (phần mã hoá)");
    assert.match(s3, /G UNANSWERED_SECONDARY_INTENT — tin khách có số lượng \+ hỏi thời gian giao mà tin bot ngay sau không đụng tới chuyện giao: [1-9]\d* tin \/ [1-9]\d* hội thoại · mẫu số [1-9]\d* tin hai ý/, s3);
    assert.ok(p3.some((l) => l.startsWith("  mẫu G (≤ 20):") && l.includes(qty)), "hội thoại «2kg + mấy ngày» nằm trong mẫu G");
    const hashQty = createHash("sha256").update(qty).digest("hex").slice(0, 8);
    assert.ok(p3.some((l) => l.startsWith("  mẫu G băm (≤ 20):") && l.includes(hashQty)), "mẫu G có mã hội thoại băm");
    // E (chủ shop 18/10): tốc độ + chi phí trả lời — chạy thật trên CSDL thử (sổ sự kiện + sổ AI nền tảng), chỉ số đếm.
    const p4 = await capture(() => scanAiPerformance(db, "khong-co-to-chuc", new Date(Date.now() - 86_400_000), new Date()));
    const s4 = p4.filter((l) => l.startsWith("[ops:tom-tat]")).join(" | ");
    assert.match(s4, /E lượt bot trả lời .* QUICK_REPLY \d+/, s4);
    assert.match(s4, /E lời gọi AI bot bán hàng: /, s4);
    for (const p of [...p1, ...p2, ...p3]) assert.ok(!p.includes(PHONE) && !p.includes("Bình Thạnh") && !p.includes("Quận 12") && !p.includes("chả mực ạ"), `không lọt SĐT / địa chỉ / chữ tin: ${p}`);
    for (const p of [s1, s2, s3]) assert.ok(!p.includes(money) && !p.includes(empty) && !p.includes(qty), "kênh tóm tắt không in mã hội thoại");
  } finally {
    await db.delete(schema.salesChatMessages).where(inArray(schema.salesChatMessages.conversationId, [money, empty, qty]));
    await db.delete(schema.salesChatConversations).where(inArray(schema.salesChatConversations.id, [money, empty, qty]));
  }
}

/** D (P0 18/10/2026): câu mẫu nem gửi cho «xin giá chả cá» ⇒ đếm; câu chả cá ⇒ không; khách chưa nói món ⇒ không đoán. */
function testWrongProduct() {
  const products = [
    { name: "Chả cá thu", skus: ["CHA-CA-THU"] },
    { name: "Nem hải sản tôm bề bề", skus: ["NEM-1"] },
  ];
  const t = (title: string, answer: string) => ({ title, answer, head: quickReplyHead(answer) });
  const nem = t("Nem", "Nem hải sản tôm bề bề bên em giá {{giá:NEM-1}}/hộp 10 cái ạ");
  const ca = t("Chả cá", "Dạ chả cá thu bên em hiện đang có giá {{giá:CHA-CA-THU}} ạ");
  const tpls = [nem, ca];
  const c = (text: string) => [{ who: "CUSTOMER" as const, text }];
  assert.equal(wrongProductTemplate("Nem hải sản tôm bề bề bên em giá 120.000 ₫/hộp 10 cái ạ", c("xin giá chả cá"), tpls, products)?.title, "Nem");
  assert.equal(wrongProductTemplate("Dạ chả cá thu bên em hiện đang có giá 280.000 ₫ ạ", c("xin giá chả cá"), tpls, products), null);
  assert.equal(wrongProductTemplate("Nem hải sản tôm bề bề bên em giá 120.000 ₫/hộp 10 cái ạ", c("báo giá"), tpls, products), null, "chưa rõ khách hỏi món gì ⇒ không đếm");
  assert.equal(wrongProductTemplate("Nem hải sản tôm bề bề bên em giá 120.000 ₫/hộp 10 cái ạ", c("nem bao nhiêu"), tpls, products), null);
  assert.equal(wrongProductTemplate("Dạ em gửi mình menu ạ", c("xin giá chả cá"), tpls, products), null, "tin không phải câu mẫu");
  const moiNem = [...c("chả cá thu giá sao em"), { who: "SHOP" as const, text: "Dạ chả cá thu 280k ạ. Chị lấy thêm nem hải sản không ạ?" }, ...c("giá sao em")];
  assert.equal(wrongProductTemplate("Nem hải sản tôm bề bề bên em giá 120.000 ₫/hộp 10 cái ạ", moiNem, tpls, products), null, "shop vừa mời nem ⇒ câu nem không phải sai món");

  // Phát lại tất định (mẫu số + --replay-quick): câu nem mang «xin giá chả cá» ⇒ trần sai món, sau luật không.
  const entries = [
    { id: "nem", title: "Nem", triggers: ["nem bao nhiêu", "xin giá chả cá", "báo giá"], answer: "Nem hải sản tôm bề bề bên em giá {{giá:NEM-1}}/hộp" },
    { id: "ca", title: "Chả cá", triggers: ["Cha ca"], answer: "Dạ chả cá thu bên em giá {{giá:CHA-CA-THU}} ạ" },
  ];
  const d1 = quickDecisionAt(c("xin giá chả cá"), entries, products);
  assert.deepEqual(d1, { eligible: true, raw: "MATCH «Nem»", after: "MATCH «Chả cá»", changed: true, wrongBefore: true, wrongAfter: false, defaultBefore: false, quickAfter: true, sizeYield: false });
  assert.deepEqual(quickDecisionAt(c("nem bao nhiêu"), entries, products), { eligible: true, raw: "MATCH «Nem»", after: "MATCH «Nem»", changed: false, wrongBefore: false, wrongAfter: false, defaultBefore: false, quickAfter: true, sizeYield: false });
  // «báo giá» không ai nói món ⇒ khớp trần MẶC ĐỊNH nem (không phải «sai món»), sau luật nhường AI.
  assert.deepEqual(quickDecisionAt(c("báo giá"), entries, products), { eligible: true, raw: "MATCH «Nem»", after: "NONE", changed: true, wrongBefore: false, wrongAfter: false, defaultBefore: true, quickAfter: false, sizeYield: false });
  assert.equal(quickDecisionAt(c("Chị 0961003107, 9 Hai Bà Trưng"), entries, products).eligible, false, "tin chốt đơn ⇒ câu mẫu không được xét (như lượt sống)");
  assert.equal(quickDecisionAt(c("thời tiết đẹp"), entries, products).eligible, false);
  // #868 trên câu mẫu (19/10/2026): câu mẫu thắng mà luật quy cách chặn ⇒ cột «sau luật» ghi NHƯỜNG AI, không tính là câu mẫu tự trả lời.
  const dy = quickDecisionAt(c("Cha ca"), entries, products, [], (e) => e.id === "ca");
  assert.deepEqual([dy.sizeYield, dy.quickAfter, dy.changed, dy.wrongAfter], [true, false, true, false], JSON.stringify(dy));
  assert.match(dy.after, /^MATCH «Chả cá» ⇒ NHƯỜNG AI/);
  assert.equal(quickDecisionAt(c("Cha ca"), entries, products, [], () => false).sizeYield, false);
  for (const v of QUICK_REPLAY_VARIANTS) assert.equal(quickDecisionAt(v.lines, entries, products).wrongAfter, false, `biến thể «${v.key}» không bao giờ sai món sau luật`);
  assert.deepEqual(parseTraceArgs(["hslc", "--replay-quick=419a66d8-3079-4cdd-bb7a-802c386493f9,d1a2fd9d-eeac-466a-bcc3-e50823cdd586"]), { code: "hslc", conv: null, order: null, scan: false, days: 3, replayQuick: ["419a66d8-3079-4cdd-bb7a-802c386493f9", "d1a2fd9d-eeac-466a-bcc3-e50823cdd586"] });
  assert.ok("error" in parseTraceArgs(["hslc", "--replay-quick=khong-phai-uuid"]));
  const w = parseTraceArgs(["hslc", "--scan", "--since=2026-10-17T13:12Z", "--until=2026-10-18T13:12Z"]);
  assert.ok(!("error" in w) && w.until?.toISOString() === "2026-10-18T13:12:00.000Z");
  assert.ok("error" in parseTraceArgs(["hslc", "--scan", "--until=2026-10-18T13:12Z"]), "--until cần --since");
  assert.ok("error" in parseTraceArgs(["hslc", "--scan", "--since=2026-10-18T13:12Z", "--until=2026-10-18T13:00Z"]), "--until phải sau --since");
}

export async function testConvMoneyTrace() {
  testPure();
  testWrongProduct();
  testSource();
  await testDb();
  console.log("  ✓ ops conv-money-trace: TỔNG trong tin bot ≠ báo giá giỏ ⇒ LỆCH (640k thuộc tập tham chiếu, không thuộc báo giá); «nói rõ hơn» không có tin khách mới ⇒ đếm; câu mẫu có số tiền cố định; tóm tắt không lọt PII; chỉ đọc, khai đủ bốn chỗ");
}

if (process.argv[1] && /conv-money-trace\.test\.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testConvMoneyTrace)
    .then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
}

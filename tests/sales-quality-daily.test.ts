/**
 * ═══════════ GIÁM SÁT CHẤT LƯỢNG AI BÁN HÀNG HẰNG NGÀY — 2B (chủ shop duyệt 21/10/2026) ═══════════
 *
 * Khoá:
 *  1. Mỗi mã có ca DƯƠNG và ca ÂM trên bộ dò thuần; chỉ tin trong kỳ được đếm (tin trước kỳ vẫn là ngữ cảnh).
 *  2. Bộ dò của lib và bản tự chứa của scripts/conv-money-trace.ts (F · G · «nói rõ hơn» · D) cho CÙNG con số trên CÙNG dữ liệu.
 *  3. Job: một việc / mã / ngày (không một việc cho mỗi hội thoại) · lượt thứ hai cùng ngày không ghi gì · trước 7 giờ không chạy ·
 *     lượt lỗi thử lại có trần · việc không mang chữ tin / SĐT / mã hội thoại thô · đi vào /work ở phòng của nhóm CS.
 *  4. 0 lời gọi AI; HANDOFF_UNANSWERED dùng ĐÚNG hàm của lib/constants/handoff-reply.ts.
 * Mọi mốc là THAM SỐ trong một kỳ riêng (năm 2031) — không cửa sổ nào đọc đồng hồ thật (AGENTS 50), và dữ liệu của bài khác trong CSDL
 * thử dùng chung không lọt vào kỳ.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { eq, inArray, like } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { CASE_TEAM, caseTypeOf } from "@/lib/constants/action-queue";
import { TEAM_DEPARTMENT } from "@/lib/constants/departments";
import { SALES_QUALITY_CODES, SALES_QUALITY_SPEC, SALES_QUALITY_STATE_KEY, salesQualityDedupeKey, salesQualityDue, salesQualityWindow, type SalesQualityCode } from "@/lib/constants/sales-quality";
import { CLAIM_SAFE_TEXT } from "@/lib/sales-chatbot/claim-guard";
import { EMPTY_REPLY_TEXT } from "@/lib/sales-chatbot/engine";
import { collectHandoffFacts, collectHandoffUnanswered, runSalesQualityDaily } from "@/lib/sales-quality/daily";
import { conversationHash, scanThreadQuality, templateHead, wrongTemplateOf, type QualityMsg } from "@/lib/sales-quality/detectors";
import { setSettingJson } from "@/lib/settings";
import { quickReplyHead, scanPatterns, wrongProductTemplate } from "../scripts/conv-money-trace";

const PHONE = "0900002121";
const txt = (text: string) => [{ type: "text", text }];
const T0 = Date.parse("2031-03-01T03:00:00Z"); // 10:00 giờ VN ngày 01/03/2031
const NOW = new Date("2031-03-02T01:30:00Z"); // 08:30 giờ VN hôm sau ⇒ kỳ = trọn ngày 01/03/2031 giờ VN
const WINDOW = salesQualityWindow(NOW);
const thread = (parts: [string, unknown][], start = T0): QualityMsg[] => parts.map(([role, content], i) => ({ seq: i + 1, role, at: new Date(start + i * 60_000), content }));
const codesOf = (msgs: QualityMsg[]) => scanThreadQuality(msgs, { from: WINDOW.from, to: WINDOW.to, templates: [], products: [] }).hits.map((h) => h.code);

const QTY: [string, unknown][] = [
  ["user", txt("Chả cá thu giá bao nhiêu shop?")],
  ["assistant", txt("Dạ chả cá thu 280.000 ₫/kg ạ. Mình muốn mua 1kg hay 2kg ạ?")],
  ["user", txt("2kg")],
  ["assistant", txt("Dạ chả cá thu 280.000 ₫/kg ạ. Mình muốn mua 1kg hay 2kg ạ?")],
  ["user", txt("lấy 2")],
  ["assistant", txt("Dạ em ghi nhận mình lấy 2kg Chả cá thu ạ. Mình cho em xin số điện thoại nhận hàng nhé.")],
  ["user", txt("Cho chị 2kg. Mấy ngày nhận được hàng?")],
  ["assistant", txt("Dạ chả cá thu 280.000 ₫/kg, 2kg 540.000 ₫ ạ.")],
];

function testPure() {
  // Kỳ: trọn ngày giờ VN trước ngày của `now`; giờ chạy.
  assert.equal(WINDOW.day, "2031-03-01");
  assert.equal(WINDOW.from.toISOString(), "2031-02-28T17:00:00.000Z");
  assert.equal(WINDOW.to.toISOString(), "2031-03-01T17:00:00.000Z");
  assert.equal(salesQualityDue(new Date("2031-03-01T23:59:00Z")), false, "06:59 giờ VN ⇒ chưa chạy");
  assert.equal(salesQualityDue(new Date("2031-03-02T00:00:00Z")), true, "07:00 giờ VN ⇒ chạy");
  for (const code of SALES_QUALITY_CODES) assert.ok(existsSync(SALES_QUALITY_SPEC[code].source), `${code}: tệp định nghĩa ${SALES_QUALITY_SPEC[code].source} có thật`);

  // F QTY_REASKED: «2kg» ⇒ bot gửi lại câu cũ (đếm); «lấy 2» ⇒ bot đi tiếp (không đếm). G: số lượng + mấy ngày ⇒ bot không đụng giao.
  const q = codesOf(thread(QTY));
  assert.deepEqual(q.filter((c) => c === "QTY_REASKED").length, 1, JSON.stringify(q));
  assert.deepEqual(q.filter((c) => c === "SECONDARY_INTENT_UNANSWERED").length, 1, JSON.stringify(q));
  assert.deepEqual(codesOf(thread([["user", txt("Cho chị 2kg. Mấy ngày nhận được hàng?")], ["assistant", txt("Dạ 2kg 540.000 ₫, bên em giao 2–3 ngày ạ.")]])), [], "bot trả lời cả chuyện giao ⇒ không đếm");

  // «Nói rõ hơn» + câu an toàn của hàng rào khẳng định.
  assert.deepEqual(codesOf(thread([["user", txt("ok")], ["assistant", txt(EMPTY_REPLY_TEXT)]])), ["CLARIFY_FALLBACK"]);
  assert.deepEqual(codesOf(thread([["user", txt("ck rồi nha")], ["assistant", txt(CLAIM_SAFE_TEXT.PAYMENT)]])), ["CLAIM_GUARD_BLOCK"]);
  assert.deepEqual(codesOf(thread([["user", txt("ok")], ["assistant", txt("Dạ em chào chị ạ.")]])), [], "câu thường ⇒ không đếm");

  // Phàn nàn mà bot mời mua thêm.
  const complaint: [string, unknown][] = [["user", txt("Hàng hôm trước bị hỏng hết rồi shop, chị muốn hoàn tiền")], ["assistant", txt("Dạ chị lấy thêm 1 hũ ruốc cá cho đủ bữa nhé ạ?")]];
  assert.deepEqual(codesOf(thread(complaint)), ["COMPLAINT_WHILE_SELLING"]);
  assert.deepEqual(codesOf(thread([complaint[0], ["assistant", txt("Dạ em xin lỗi chị, em chuyển nhân viên kiểm tra ngay ạ.")]])), [], "xin lỗi + chuyển người ⇒ không đếm");

  // Hỏi lại SĐT đã có (đúng hàng rào sống addressReaskVerdict).
  assert.deepEqual(codesOf(thread([["user", txt(`Sđt chị ${PHONE}`)], ["assistant", txt("Dạ mình cho em xin số điện thoại nhận hàng ạ?")]])), ["ADDRESS_REASK"]);
  assert.deepEqual(codesOf(thread([["user", txt("Chị lấy 1kg")], ["assistant", txt("Dạ mình cho em xin số điện thoại nhận hàng ạ?")]])), [], "chưa có SĐT ⇒ hỏi lần đầu là đúng");

  // Chỉ tin trong kỳ được đếm; tin trước kỳ vẫn là ngữ cảnh.
  // Bốn tin đầu (gồm lần hỏi lại «2kg») nằm TRƯỚC kỳ ⇒ không đếm; ca hai ý ở tin 7–8 nằm trong kỳ ⇒ đếm.
  assert.deepEqual(codesOf(thread(QTY, WINDOW.from.getTime() - 4 * 60_000)), ["SECONDARY_INTENT_UNANSWERED"]);
  assert.equal(scanThreadQuality(thread(QTY, WINDOW.to.getTime()), { ...WINDOW, templates: [], products: [] }).hits.length, 0, "tin từ cuối kỳ trở đi không thuộc kỳ");

  // D + đầu câu mẫu: bản lib = bản tự chứa của conv-money-trace trên cùng ca.
  const products = [{ name: "Chả cá thu", skus: ["CHA-CA-THU"] }, { name: "Nem hải sản tôm bề bề", skus: ["NEM-1"] }];
  const answers = ["Nem hải sản tôm bề bề bên em giá {{giá:NEM-1}}/hộp 10 cái ạ", "Dạ chả cá thu bên em hiện đang có giá {{giá:CHA-CA-THU}} ạ", "Dạ shop chào chị ạ"];
  for (const a of answers) assert.equal(templateHead(a), quickReplyHead(a), `đầu câu mẫu trùng bản script: ${a}`);
  const tpls = answers.map((answer, i) => ({ title: `T${i}`, answer, head: templateHead(answer) }));
  const c = (t: string) => [{ who: "CUSTOMER" as const, text: t }];
  for (const [sent, said] of [["Nem hải sản tôm bề bề bên em giá 120.000 ₫/hộp 10 cái ạ", "xin giá chả cá"], ["Dạ chả cá thu bên em hiện đang có giá 280.000 ₫ ạ", "xin giá chả cá"], ["Nem hải sản tôm bề bề bên em giá 120.000 ₫/hộp 10 cái ạ", "alo shop"]] as const)
    assert.equal(wrongTemplateOf(sent, c(said), tpls, products)?.title ?? null, wrongProductTemplate(sent, c(said), tpls, products)?.title ?? null, `D trùng bản script: «${said}»`);
  assert.equal(wrongTemplateOf(answers[0].replace("{{giá:NEM-1}}", "120.000 ₫"), c("xin giá chả cá"), tpls, products)?.title, "T0", "câu mẫu nem cho «xin giá chả cá» ⇒ sai món");

  // 0 lời gọi AI · HANDOFF_UNANSWERED dùng đúng hàm của handoff-reply.ts (không viết bản thứ hai).
  for (const f of ["lib/sales-quality/detectors.ts", "lib/sales-quality/daily.ts"]) {
    const src = readFileSync(f, "utf8");
    assert.doesNotMatch(src, /salesChatProvider|recordAiUsage|\.complete\(|getProvider/, `${f}: 0 lời gọi AI`);
  }
  const daily = readFileSync("lib/sales-quality/daily.ts", "utf8");
  assert.match(daily, /import \{ handoffReplyClass, type HandoffReplyFact \} from "@\/lib\/constants\/handoff-reply";/);
  assert.doesNotMatch(daily, /UNANSWERED_OVER_SLA"\s*:/, "không tự định nghĩa lớp trả lời");
  assert.match(readFileSync("lib/sync/jobs.ts", "utf8"), /"sales-health": \{[\s\S]*?runSalesQualityDaily\(\)[\s\S]*?\n {2}\},/, "chạy KÉ job sales-health (không lịch mới)");

  // Việc vào /work ở phòng của nhóm CS.
  assert.equal(caseTypeOf("SALES_QUALITY"), "SALES_QUALITY");
  assert.equal(TEAM_DEPARTMENT[CASE_TEAM.SALES_QUALITY], "SALES");
}

/** scanPatterns (bản tự chứa của script) và scanThreadQuality đếm CÙNG F · G · «nói rõ hơn» trên cùng dữ liệu của một kỳ riêng. */
async function testParityWithScript(db: Awaited<ReturnType<typeof getDb>>, convs: Map<string, [string, unknown][]>) {
  const printed: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
  try {
    await scanPatterns(db, 1, WINDOW.to, WINDOW.from);
  } finally {
    console.log = orig;
  }
  const line = (re: RegExp) => Number(printed.find((l) => re.test(l))?.match(re)?.[1] ?? NaN);
  const script = {
    QTY_REASKED: line(/F CUSTOMER_SELECTED_QUANTITY_BUT_BOT_REASKED[^:]*: (\d+) tin/),
    SECONDARY_INTENT_UNANSWERED: line(/G UNANSWERED_SECONDARY_INTENT[^:]*: (\d+) tin/),
    CLARIFY_FALLBACK: line(/A câu «nói rõ hơn» của engine: (\d+) tin/),
  };
  const lib = { QTY_REASKED: 0, SECONDARY_INTENT_UNANSWERED: 0, CLARIFY_FALLBACK: 0 } as Record<keyof typeof script, number>;
  for (const parts of convs.values()) for (const h of scanThreadQuality(thread(parts), { ...WINDOW, templates: [], products: [] }).hits) if (h.code in lib) lib[h.code as keyof typeof script] += 1;
  assert.deepEqual(lib, script, `lib và conv-money-trace phải đếm như nhau trên cùng kỳ: ${printed.filter((l) => l.startsWith("[ops:tom-tat]")).join(" | ").slice(0, 600)}`);
  assert.ok(script.QTY_REASKED >= 1 && script.SECONDARY_INTENT_UNANSWERED >= 1 && script.CLARIFY_FALLBACK >= 1, "kỳ riêng có đủ ba loại để so");
}

async function testDaily() {
  const db = await getDb();
  const qty = randomUUID();
  const fall = randomUUID();
  const fall2 = randomUUID();
  const waiting = randomUUID();
  const convs = new Map<string, [string, unknown][]>([
    [qty, QTY],
    [fall, [["user", txt(`Lấy chị 1kg, sđt ${PHONE}`)], ["assistant", txt(EMPTY_REPLY_TEXT)]]],
    [fall2, [["user", txt("alo")], ["assistant", txt(EMPTY_REPLY_TEXT)]]],
  ]);
  const ids = [qty, fall, fall2, waiting];
  const wipe = async () => {
    await db.delete(schema.salesChatMessages).where(inArray(schema.salesChatMessages.conversationId, ids));
    await db.delete(schema.salesChatConversations).where(inArray(schema.salesChatConversations.id, ids));
    await db.delete(schema.notifications).where(like(schema.notifications.dedupeKey, "sales-quality:%:2031-%"));
    await db.delete(schema.settings).where(eq(schema.settings.key, SALES_QUALITY_STATE_KEY));
  };
  await wipe();
  try {
    await db.insert(schema.salesChatConversations).values([
      ...[...convs.keys()].map((id) => ({ id, channel: "WEB" as const, status: "OPEN" as const, state: {}, updatedAt: new Date(T0 + 30 * 60_000) })),
      // Chờ người: khách nhắn cuối 27/02, không ai trả lời ⇒ quá mọi hạn mặc định lúc 02/03.
      { id: waiting, channel: "WEB" as const, status: "HANDOFF" as const, handoffReason: "Cần người xử lý — kiểm thử 2B", state: {}, lastCustomerAt: new Date("2031-02-27T03:00:00Z"), updatedAt: new Date("2031-02-27T03:00:00Z") },
    ]);
    await db.insert(schema.salesChatMessages).values([...convs.entries()].flatMap(([conv, parts]) => thread(parts).map((m) => ({ conversationId: conv, seq: m.seq, role: m.role as "user" | "assistant", content: m.content as Record<string, unknown>[], createdAt: m.at }))));

    await testParityWithScript(db, convs);

    const ho = await collectHandoffUnanswered(NOW);
    assert.ok(ho.slaMs !== null && ho.ids.includes(waiting), `hội thoại chờ người quá hạn, chưa ai trả lời ⇒ HANDOFF_UNANSWERED (hàm của handoff-reply.ts): ${JSON.stringify({ sla: ho.slaMs, n: ho.ids.length })}`);
    // Mẫu số in cạnh mã = ĐÚNG tập mà ops stuck-conversation-audit đọc ở A2[/work] (`collectHandoffFacts`) — một câu SQL, hai nơi đọc.
    const facts = await collectHandoffFacts(db, NOW);
    assert.equal(ho.waiting, facts.length, "mẫu số «đang chờ người» = số hội thoại của tập /work");
    assert.ok(ho.ids.every((x) => facts.some((f) => f.id === x)), "HANDOFF_UNANSWERED là tập con của tập /work");

    assert.deepEqual(await runSalesQualityDaily(new Date("2031-03-01T23:30:00Z")), { ran: false, reason: "chưa tới giờ chạy" }, "06:30 giờ VN ⇒ không chạy");
    const r = await runSalesQualityDaily(NOW);
    assert.ok(r.ran, JSON.stringify(r));
    assert.equal(r.day, "2031-03-01");
    assert.equal(r.state.counts.CLARIFY_FALLBACK, 2, "hai hội thoại cùng lỗi ⇒ đếm 2");
    const rows = await db.select().from(schema.notifications).where(like(schema.notifications.dedupeKey, "sales-quality:%:2031-03-01"));
    const byCode = new Map(rows.map((n) => [n.entityId as SalesQualityCode, n]));
    assert.equal(rows.length, r.created);
    for (const code of ["QTY_REASKED", "SECONDARY_INTENT_UNANSWERED", "CLARIFY_FALLBACK", "HANDOFF_UNANSWERED"] as const) {
      const n = byCode.get(code);
      assert.ok(n, `${code}: có việc`);
      assert.ok(n.kind === "SALES_QUALITY" && n.dedupeKey === salesQualityDedupeKey(code, "2031-03-01") && n.resolvedAt === null, JSON.stringify(n));
    }
    assert.equal(rows.filter((n) => n.entityId === "CLARIFY_FALLBACK").length, 1, "hai hội thoại cùng mã ⇒ MỘT việc, không hai");
    assert.match(byCode.get("HANDOFF_UNANSWERED")!.body, /tập = hàng đợi chờ người của \/work/, "việc nói rõ tập đang đếm");
    const clarify = byCode.get("CLARIFY_FALLBACK")!;
    assert.match(clarify.title, /2 tin \/ 2 hội thoại \(ngày 01\/03\)/, clarify.title);
    assert.ok(clarify.body.includes(conversationHash(fall)) && clarify.body.includes(conversationHash(fall2)), "mã hội thoại BĂM để ops đối chiếu");
    for (const n of rows) for (const bad of [...ids, PHONE, "Chả cá thu giá bao nhiêu", "Lấy chị 1kg"]) assert.ok(!n.title.includes(bad) && !n.body.includes(bad), `việc không mang chữ tin / SĐT / mã thô: ${bad}`);

    // Lượt 5 phút kế tiếp cùng ngày ⇒ không quét lại, không ghi.
    assert.deepEqual(await runSalesQualityDaily(new Date(NOW.getTime() + 5 * 60_000)), { ran: false, reason: "hôm nay đã chạy" });
    assert.equal((await db.select().from(schema.notifications).where(like(schema.notifications.dedupeKey, "sales-quality:%:2031-03-01"))).length, rows.length);

    // Lượt lỗi: thử lại có trần.
    await setSettingJson(SALES_QUALITY_STATE_KEY, { day: "2031-03-01", error: "giả", attempts: 3 });
    assert.deepEqual(await runSalesQualityDaily(NOW), { ran: false, reason: "hôm nay đã chạy" }, "đã lỗi 3 lần ⇒ thôi thử trong ngày");
    await setSettingJson(SALES_QUALITY_STATE_KEY, { day: "2031-03-01", error: "giả", attempts: 1 });
    const again = await runSalesQualityDaily(NOW);
    assert.ok(again.ran && again.created === 0, `lỗi 1 lần ⇒ chạy lại; việc đã có không nhân đôi: ${JSON.stringify(again).slice(0, 200)}`);
    console.log("✓ Giám sát chất lượng AI bán hàng hằng ngày (2B): 8 mã có ca dương / âm · bộ dò lib = conv-money-trace trên cùng kỳ · một việc / mã / ngày ở phòng nhóm CS · không chạy lại trong ngày, lỗi thử lại có trần · không chữ tin / SĐT / mã thô · 0 lời gọi AI");
  } finally {
    await wipe();
  }
}

export async function testSalesQualityDaily() {
  testPure();
  await testDaily();
}

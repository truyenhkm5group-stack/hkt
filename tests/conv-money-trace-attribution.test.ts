/**
 * ═══ conv-money-trace: tin model / tin THEO DÕI không bị gán cho câu mẫu (23/10/2026) ═══
 *
 * Ca thật: tin theo dõi 16:24Z 22/10 (HSLC) do MODEL viết, mở đầu «Dạ chả cá thu bên em làm từ 100%…» như nhiều câu mẫu ⇒ trace in
 * «NGUỒN CÂU MẪU #93(tắt) (khớp chữ)» và người đọc đi tìm lỗi «đường theo dõi gửi câu mẫu đã tắt» không tồn tại (lib/sales-chatbot/
 * followup.ts không đọc câu mẫu). Khoá: (1) chỉ câu mẫu ĐANG BẬT được so; (2) tin trùng mốc `followup.sent` ⇒ «THEO DÕI (model)», không
 * vào dòng D; (3) nhãn là «GIỐNG câu mẫu #n» — trùng chữ, không phải nguồn.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { FOLLOWUP_MESSAGE_MAX_LAG_MS, followupBotSeqs, quickReplyHead, scanPatterns, templateAttribution, traceConversation } from "@/scripts/conv-money-trace";

const ACTIVE_ANSWER = "Dạ chả cá ZQ kiểm thử bên em làm từ 100% cá biển tươi nguyên chất ạ";
const OFF_ANSWER = "Dạ ruốc ZQ kiểm thử bên em làm từ tôm tươi nguyên chất ạ";

function testPure() {
  const tpls = [
    { code: "#1", head: quickReplyHead(ACTIVE_ANSWER), active: true },
    { code: "#2", head: quickReplyHead(OFF_ANSWER), active: false },
    { code: "#3", head: "da ok", active: true },
  ];
  assert.equal(templateAttribution(`${ACTIVE_ANSWER} Mình lấy thử 1kg nhé!`, tpls), "GIỐNG câu mẫu #1");
  assert.equal(templateAttribution(`${OFF_ANSWER} Mình lấy 1 hộp nhé!`, tpls), null, "câu mẫu TẮT không bao giờ được gán");
  assert.equal(templateAttribution("Dạ ok ạ, em ghi nhận", tpls), null, "đầu câu < 12 ký tự không dùng");

  const t0 = new Date("2031-03-01T16:24:07Z");
  const at = (s: number) => new Date(t0.getTime() + s * 1000);
  const msgs = [
    { seq: 1, role: "user", at: at(-3600), hasText: true },
    { seq: 2, role: "assistant", at: at(-3590), hasText: true },
    { seq: 3, role: "assistant", at: at(9), hasText: true },
  ];
  assert.deepEqual([...followupBotSeqs(msgs, [t0])], [3], "tin bot đầu tiên sau mốc followup.sent (ghi SAU khi gửi, trễ 9 giây)");
  assert.deepEqual([...followupBotSeqs([...msgs.slice(0, 2), { seq: 3, role: "user", at: at(5), hasText: true }, { seq: 4, role: "assistant", at: at(9), hasText: true }], [t0])], [], "tin khách xen giữa ⇒ tin bot là lượt TRẢ LỜI, không phải theo dõi");
  assert.deepEqual([...followupBotSeqs([{ seq: 3, role: "assistant", at: at(5), hasText: false }, { seq: 4, role: "assistant", at: at(9), hasText: true }], [t0])], [4], "dòng không chữ (gọi công cụ) không chặn");
  assert.deepEqual([...followupBotSeqs([{ seq: 3, role: "assistant", at: new Date(t0.getTime() + FOLLOWUP_MESSAGE_MAX_LAG_MS + 1000), hasText: true }], [t0])], [], "trễ quá trần ⇒ không ghép");
  assert.deepEqual([...followupBotSeqs(msgs, [])], [], "không có followup.sent ⇒ không tin nào là theo dõi");
}

function testSource() {
  const src = readFileSync("scripts/conv-money-trace.ts", "utf8");
  assert.doesNotMatch(src, /\(khớp chữ\)/, "không còn nhãn «CÂU MẪU … (khớp chữ)»");
  assert.doesNotMatch(src, /code: `#\$\{i \+ 1\}\$\{r\.active \? "" : "\(tắt\)"\}`/, "mã câu mẫu không mang «(tắt)» vào phép gán nguồn");
  assert.match(src, /title: r\.title, active: r\.active \}/, "ngữ cảnh mang cờ bật / tắt");
  assert.match(src, /const tpls = rowsQr\.filter\(\(r\) => r\.active\)\.map/, "dòng D chỉ so câu mẫu đang bật");
  assert.match(src, /followups\.has\(x\.seq\) \? "THEO DÕI \(model\)" : "MODEL"/, "tin theo dõi mang nhãn riêng");
  assert.match(src, /if \(fuKeys\.has\(`\$\{r\.conv\}:\$\{r\.seq\}`\)\) D\.followupSkipped \+= 1;\n\s+else checkD\(r\.conv, t, lines\);/, "tin theo dõi không vào dòng D");
}

const txt = (text: string) => [{ type: "text", text }];

async function testDb() {
  const db = await getDb();
  const fu = randomUUID();
  const ctl = randomUUID();
  const off = randomUUID();
  const now = Date.now();
  const at = (minAgo: number) => new Date(now - minAgo * 60_000);
  const qrIds = [randomUUID(), randomUUID()];
  const sum = (lines: string[], re: RegExp) => Number(lines.join("\n").match(re)?.[1] ?? NaN);
  const scan = async () => {
    const p = await capture(() => scanPatterns(db, 1, new Date()));
    return { sends: sum(p, /tin bot là câu mẫu (\d+)/), skipped: sum(p, /tin THEO DÕI \(model\) không đem so (\d+) tin/), lines: p };
  };
  try {
    await db.insert(schema.salesChatQuickReplies).values([
      { id: qrIds[0], title: "Chả cá ZQ", triggers: ["cha ca zq"], answer: ACTIVE_ANSWER, active: true },
      { id: qrIds[1], title: "Ruốc ZQ", triggers: ["ruoc zq"], answer: OFF_ANSWER, active: false },
    ]);
    const before = await scan();
    assert.ok(Number.isFinite(before.sends) && Number.isFinite(before.skipped), before.lines.filter((l) => l.startsWith("[ops:tom-tat] D")).join("\n"));
    await db.insert(schema.salesChatConversations).values([fu, ctl, off].map((id) => ({ id, channel: "WEB", status: "WAITING", state: {} })));
    await db.insert(schema.salesChatMessages).values([
      // Theo dõi: khách hỏi giá, bot trả lời, im lặng; followup.sent rồi tin model mở đầu GIỐNG câu mẫu đang bật.
      { conversationId: fu, seq: 1, role: "user", content: txt("chả cá zq giá sao"), createdAt: at(300) },
      { conversationId: fu, seq: 2, role: "assistant", content: txt("Dạ 280.000 ₫/kg ạ."), createdAt: at(299) },
      { conversationId: fu, seq: 3, role: "assistant", content: txt(`${ACTIVE_ANSWER} Mình lấy thử 1kg nhé!`), createdAt: new Date(at(10).getTime() + 9_000) },
      // Đối chứng: cùng chữ nhưng là lượt TRẢ LỜI một tin khách ⇒ vẫn đếm «giống câu mẫu».
      { conversationId: ctl, seq: 1, role: "user", content: txt("chả cá zq có ngon không"), createdAt: at(20) },
      { conversationId: ctl, seq: 2, role: "assistant", content: txt(`${ACTIVE_ANSWER} Mình lấy thử 1kg nhé!`), createdAt: at(19) },
      // Câu mẫu TẮT: tin model trùng đầu chữ với nó ⇒ không phải câu mẫu.
      { conversationId: off, seq: 1, role: "user", content: txt("ruốc zq thế nào"), createdAt: at(20) },
      { conversationId: off, seq: 2, role: "assistant", content: txt(`${OFF_ANSWER} Mình lấy 1 hộp nhé!`), createdAt: at(19) },
    ]);
    await db.insert(schema.salesConversationEvents).values({ conversationId: fu, type: "followup.sent", actorKind: "AI", channel: "WEB", occurredAt: at(10), payload: { attempt: 1 }, dedupeKey: `test-followup:${fu}` });

    const after = await scan();
    assert.equal(after.sends - before.sends, 1, `chỉ tin ĐỐI CHỨNG được đếm «tin bot là câu mẫu» (theo dõi và câu tắt thì không): ${after.sends} − ${before.sends}`);
    assert.equal(after.skipped - before.skipped, 1, "đúng một tin theo dõi bị loại khỏi phép so câu mẫu");
    const nguon = after.lines.find((l) => l.startsWith("[ops:tom-tat] D nguồn:"));
    assert.ok(nguon && Buffer.byteLength(nguon.slice("[ops:tom-tat] ".length), "utf8") <= 300, `dòng «D nguồn» vừa trần 300 BYTE của kênh tóm tắt: ${nguon}`);

    const ctx = {
      names: new Map<string, string>(),
      reference: new Set<number>(),
      handoffText: null,
      aiDownText: null,
      templates: [
        { code: "#1", head: quickReplyHead(ACTIVE_ANSWER), fixed: [], title: "Chả cá ZQ", active: true },
        { code: "#2", head: quickReplyHead(OFF_ANSWER), fixed: [], title: "Ruốc ZQ", active: false },
      ],
    };
    const pf = await capture(() => traceConversation(db, fu, null, ctx));
    assert.ok(pf.some((l) => /bot #3 .* NGUỒN THEO DÕI \(model\) /.test(l)), pf.filter((l) => l.includes("bot #")).join("\n"));
    assert.ok(!pf.some((l) => /GIỐNG câu mẫu|CÂU MẪU #/.test(l)), "tin theo dõi không bao giờ gán cho câu mẫu");
    const pc = await capture(() => traceConversation(db, ctl, null, ctx));
    assert.ok(pc.some((l) => /bot #2 .* NGUỒN GIỐNG câu mẫu #1 /.test(l)), "tin model trả lời khách, trùng đầu chữ câu mẫu đang bật ⇒ «GIỐNG câu mẫu #1»");
    const po = await capture(() => traceConversation(db, off, null, ctx));
    assert.ok(po.some((l) => /bot #2 .* NGUỒN MODEL /.test(l)), "trùng câu mẫu TẮT ⇒ vẫn là MODEL");
    assert.ok(!po.some((l) => /\(tắt\)|GIỐNG câu mẫu #2/.test(l)), "câu mẫu tắt không bao giờ được gán");
  } finally {
    await db.delete(schema.salesChatConversations).where(inArray(schema.salesChatConversations.id, [fu, ctl, off]));
    await db.delete(schema.salesChatQuickReplies).where(inArray(schema.salesChatQuickReplies.id, qrIds));
  }
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

export async function testConvMoneyTraceAttribution() {
  testPure();
  testSource();
  await testDb();
  console.log("  ✓ conv-money-trace gán nguồn: chỉ câu mẫu ĐANG BẬT · tin theo dõi ⇒ «THEO DÕI (model)», không vào dòng D · trùng chữ ⇒ «GIỐNG câu mẫu #n»");
}

if (process.argv[1] && /conv-money-trace-attribution\.test\.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testConvMoneyTraceAttribution)
    .then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
}

/**
 * ═══ SRC-2 · BỘ SINH TỪ KHOÁ TIẾNG TRUNG (docs/tech/ai-sourcing.md §3.2) ═══
 *
 * Khoá: (1) ca vàng — câu khách 35–60 nói thật ra ĐÚNG bộ truy vấn, cùng câu ⇒ cùng kết quả; (2) từ điển chưa hiểu thì HIỆN ra
 * (`unmatched`), không nuốt im, không đoán; (3) từ điển tự nhất quán — mọi mục có câu ví dụ mà bộ sinh nhận ra được, không cách nói
 * nào thuộc hai mục; (4) AI chỉ gọi khi từ điển không đủ, đếm theo sổ AI so trần `sourcing.limits`, hết trần / không đếm được / lỗi
 * vẫn trả nguyên phần từ điển và không ném; mọi lời gọi thật ghi đúng MỘT dòng sổ (lỗi ⇒ token / chi phí `null`).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AiProvider, AiRequest, AiResponse } from "@/lib/ai/provider";
import { SOURCING_FILLER_WORDS, SOURCING_GLOSSARY, type GlossaryEntry } from "@/lib/constants/sourcing-glossary";
import { expandWithAi, parseAiReply, type SourcingAiDeps, type SourcingAiRecord } from "@/lib/sourcing/ai-expand";
import { SOURCING_QUERY_MAX, buildChineseQueries, foldVi, normalizeVi } from "@/lib/sourcing/query";

const zhOf = (s: string) => buildChineseQueries(s).queries.map((q) => `${q.kind}:${q.zh}`);

function testGoldenCases() {
  // Ba cách nói thật của khách 35–60 (Tech Lead 23/10/2026).
  assert.deepEqual(zhOf("đầm suông che bụng cho mẹ"), ["FULL:妈妈装 宽松 遮肚显瘦 连衣裙", "SYNONYM:中老年女装 宽松 遮肚 连衣裙", "BROADER:妈妈装 宽松 连衣裙", "BROADER:妈妈装 连衣裙", "BROADER:连衣裙"]);
  assert.deepEqual(zhOf("áo sơ mi nam trung niên size lớn"), ["FULL:中年男士 大码 衬衫", "SYNONYM:爸爸装 大码 衬衫", "BROADER:中年男士 衬衫", "BROADER:衬衫"], "«nam trung niên» là MỘT ý (ghép dài nhất), không phải «nam» + «trung niên»");
  assert.deepEqual(zhOf("quần lụa mát mùa hè"), ["FULL:夏季 真丝 凉爽 裤子", "SYNONYM:夏装 仿真丝 透气 裤子", "BROADER:夏季 真丝 裤子", "BROADER:真丝 裤子", "BROADER:裤子"]);
  for (const s of ["đầm suông che bụng cho mẹ", "áo sơ mi nam trung niên size lớn", "quần lụa mát mùa hè"]) {
    const r = buildChineseQueries(s);
    assert.deepEqual([r.unmatched, r.ignored, r.hasProduct, r.needsAi], [[], [], true, false], `${s}: từ điển hiểu hết ⇒ không cần AI`);
    assert.deepEqual(buildChineseQueries(s), r, `${s}: tất định`);
    assert.ok(r.queries.length >= 3 && r.queries.length <= SOURCING_QUERY_MAX, `${s}: 3–5 truy vấn`);
  }
  // Dấu câu, chữ hoa, khoảng trắng thừa không đổi kết quả.
  assert.deepEqual(zhOf("  Đầm SUÔNG, che bụng — cho Mẹ!! "), zhOf("đầm suông che bụng cho mẹ"));
  // Gõ không dấu ⇒ đoán theo bản bỏ dấu, và nói ra là đoán.
  const khongDau = buildChineseQueries("dam suong che bung cho me");
  assert.deepEqual(khongDau.queries, buildChineseQueries("đầm suông che bụng cho mẹ").queries);
  assert.ok(khongDau.terms.every((t) => t.viaFold), "mục đoán từ chữ không dấu mang viaFold");
  assert.ok(buildChineseQueries("đầm suông").terms.every((t) => !t.viaFold));
  // «quần ống rộng» thắng «quần» + «rộng».
  assert.deepEqual(buildChineseQueries("quần ống rộng lụa lạnh").terms.map((t) => t.key), ["wide-pants", "ice-silk"]);
}

function testUnmatchedVisible() {
  const r = buildChineseQueries("đầm thổ cẩm màu xanh rêu cho mẹ");
  assert.deepEqual(r.unmatched, ["thổ cẩm", "xanh rêu"], "cụm chưa hiểu HIỆN ra, âm tiết liền nhau gộp thành một cụm");
  assert.deepEqual(r.ignored, ["màu"], "từ nối bỏ qua và nói ra — không lẫn vào chưa hiểu");
  assert.equal(r.needsAi, true);
  assert.ok(r.queries.every((q) => !q.zh.includes("thổ")), "phần chưa hiểu KHÔNG bị nhét thô vào truy vấn tiếng Trung");
  assert.deepEqual(r.queries.map((q) => q.zh), ["妈妈装 连衣裙", "中老年女装 连衣裙", "连衣裙"]);
  // Có dấu khác ⇒ KHÔNG đoán: «mè» không bao giờ thành «mẹ».
  assert.deepEqual(buildChineseQueries("đầm mè").unmatched, ["mè"]);
  // Không nhận ra loại hàng ⇒ cần AI; một ý đơn lẻ không phải loại hàng thì không phải truy vấn.
  const chiNguoi = buildChineseQueries("cho mẹ");
  assert.deepEqual([chiNguoi.hasProduct, chiNguoi.needsAi, chiNguoi.queries], [false, true, []]);
  assert.deepEqual(buildChineseQueries("").queries, []);
  // Hai mục cùng một bản bỏ dấu ⇒ không đoán (thay vì để mục khai sau thắng).
  const trung: GlossaryEntry[] = [
    { key: "a", label: "Mẹ", vi: ["mẹ"], zh: ["妈妈"], role: "AUDIENCE", example: "mẹ" },
    { key: "b", label: "Mè", vi: ["mè"], zh: ["芝麻"], role: "MATERIAL", example: "mè" },
  ];
  assert.deepEqual(buildChineseQueries("me", trung).unmatched, ["me"]);
  assert.deepEqual(buildChineseQueries("mẹ", trung).terms.map((t) => t.key), ["a"]);
}

function testGlossaryConsistent() {
  const keys = SOURCING_GLOSSARY.map((e) => e.key);
  assert.equal(new Set(keys).size, keys.length, "khoá mục không trùng");
  const owner = new Map<string, string>();
  for (const e of SOURCING_GLOSSARY) {
    assert.ok(e.vi.length && e.zh.length && e.label && e.example, `${e.key}: đủ trường`);
    for (const z of e.zh) assert.ok(/[㐀-鿿]/.test(z), `${e.key}: từ khoá Trung «${z}» phải có chữ Hán`);
    for (const v of e.vi) {
      assert.equal(normalizeVi(v), v, `${e.key}: cách nói «${v}» phải ở dạng chuẩn (chữ thường, không dấu câu)`);
      assert.ok(!owner.has(v), `«${v}» thuộc cả ${owner.get(v)} lẫn ${e.key}`);
      owner.set(v, e.key);
      assert.ok(!SOURCING_FILLER_WORDS.includes(v), `«${v}» vừa là từ nối vừa là mục ${e.key}`);
    }
    const r = buildChineseQueries(e.example);
    assert.ok(r.terms.some((t) => t.key === e.key && !t.viaFold), `${e.key}: câu ví dụ «${e.example}» phải được nhận ra là mục này`);
    assert.deepEqual(r.unmatched, [], `${e.key}: câu ví dụ «${e.example}» không được còn cụm chưa hiểu`);
  }
  assert.equal(foldVi("Đầm"), "Dam");
}

// ── AI ──
type Calls = { used: number; resolve: number; quota: number; complete: number; records: SourcingAiRecord[] };

function fakeProvider(reply: () => string, calls: Calls, model = "claude-haiku-4-5"): AiProvider {
  return {
    name: "fake",
    model,
    schemaDialect: "anthropic",
    async complete(req: AiRequest): Promise<AiResponse> {
      calls.complete++;
      assert.ok(req.messages[0]?.content.some((b) => b.type === "text" && b.text.includes("thổ cẩm")), "prompt nói rõ cụm chưa dịch");
      return { content: [{ type: "text", text: reply() }], stopReason: "end_turn", usage: { inputTokens: 120, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 }, model, latencyMs: 5 };
    },
  };
}

function deps(over: Partial<SourcingAiDeps> & { reply?: () => string; used?: number | null } = {}): { d: SourcingAiDeps; calls: Calls } {
  const calls: Calls = { used: 0, resolve: 0, quota: 0, complete: 0, records: [] };
  const d: SourcingAiDeps = {
    limit: 200,
    usedToday: async () => {
      calls.used++;
      return over.used === undefined ? 3 : over.used;
    },
    resolveAi: async () => {
      calls.resolve++;
      return { ok: true, provider: fakeProvider(over.reply ?? (() => "{}"), calls), source: "HOME" };
    },
    checkQuota: async () => {
      calls.quota++;
      return { ok: true };
    },
    record: async (r) => {
      calls.records.push(r);
    },
    ...over,
  };
  return { d, calls };
}

async function testAiExpansion() {
  const du = buildChineseQueries("đầm suông che bụng cho mẹ");
  const thieu = buildChineseQueries("đầm thổ cẩm cho mẹ");
  const goodReply = () =>
    JSON.stringify({
      terms: [
        { vi: "thổ cẩm", zh: "民族风织锦" },
        { vi: "bịa thêm", zh: "编造" },
      ],
      queries: [
        { zh: "妈妈装 民族风 连衣裙", vi: "Đầm thổ cẩm cho mẹ" },
        { zh: "妈妈装 连衣裙", vi: "trùng từ điển" },
        { zh: "dam tho cam", vi: "không có chữ Hán" },
      ],
    });

  {
    const { d, calls } = deps({ usedToday: async () => assert.fail("đủ từ điển ⇒ không đếm, không gọi") });
    const r = await expandWithAi(du, true, d);
    assert.equal(r.status, "NOT_NEEDED");
    assert.deepEqual([calls.complete, calls.records.length], [0, 0]);
  }
  {
    const { d, calls } = deps();
    assert.equal((await expandWithAi(thieu, false, d)).status, "NOT_REQUESTED", "người dùng tắt AI ⇒ không gọi");
    assert.deepEqual([calls.used, calls.complete, calls.records.length], [0, 0, 0]);
  }
  {
    const { d, calls } = deps({ limit: 0 });
    assert.equal((await expandWithAi(thieu, true, d)).status, "DISABLED", "trần 0 = tắt AI");
    assert.equal(calls.complete, 0);
  }
  {
    const { d, calls } = deps({ used: null });
    const r = await expandWithAi(thieu, true, d);
    assert.equal(r.status, "UNCOUNTABLE", "không đếm được ⇒ KHÔNG gọi (chưa biết ≠ còn lượt)");
    assert.deepEqual([calls.resolve, calls.complete], [0, 0]);
  }
  {
    const { d, calls } = deps({ usedToday: async () => Promise.reject(new Error("sổ hỏng")) });
    assert.equal((await expandWithAi(thieu, true, d)).status, "UNCOUNTABLE", "đọc sổ ném ⇒ không gọi, không ném");
    assert.equal(calls.complete, 0);
  }
  {
    const { d, calls } = deps({ used: 200 });
    const r = await expandWithAi(thieu, true, d);
    assert.deepEqual([r.status, r.usedToday, r.limit, r.queries], ["QUOTA", 200, 200, []], "tới trần ⇒ dừng");
    assert.ok(r.note?.includes("200/200"), "nói ra đã dùng bao nhiêu / trần");
    assert.deepEqual([calls.resolve, calls.complete, calls.records.length], [0, 0, 0]);
    assert.ok(thieu.queries.length > 0, "hết trần vẫn còn nguyên phần từ điển");
  }
  {
    const { d, calls } = deps({ resolveAi: async () => ({ ok: false, reason: "AI đang bị tắt bởi người vận hành" }) });
    const r = await expandWithAi(thieu, true, d);
    assert.equal(r.status, "NO_AI");
    assert.equal(calls.records.length, 0);
  }
  {
    const { d, calls } = deps({ checkQuota: async () => ({ ok: false, error: "Hết hạn mức gói" }) });
    const r = await expandWithAi(thieu, true, d);
    assert.deepEqual([r.status, r.note], ["QUOTA", "Hết hạn mức gói"]);
    assert.equal(calls.complete, 0);
  }
  {
    const { d, calls } = deps({ reply: goodReply });
    const r = await expandWithAi(thieu, true, d);
    assert.equal(r.status, "OK");
    assert.deepEqual(r.terms, [{ vi: "thổ cẩm", zh: "民族风织锦" }], "chỉ nhận «dịch» cho ĐÚNG cụm chưa hiểu — cụm AI tự thêm bị bỏ");
    assert.deepEqual(r.queries.map((q) => q.zh), ["妈妈装 民族风 连衣裙"], "bỏ truy vấn trùng từ điển và truy vấn không có chữ Hán");
    assert.deepEqual([r.usedToday, r.note], [4, null]);
    assert.equal(calls.records.length, 1, "một lời gọi = một dòng sổ");
    assert.deepEqual([calls.records[0].status, calls.records[0].inputTokens, calls.records[0].outputTokens, calls.records[0].model], ["OK", 120, 40, "claude-haiku-4-5"]);
  }
  {
    const { d, calls } = deps({ reply: () => "Xin lỗi, tôi không chắc." });
    const r = await expandWithAi(thieu, true, d);
    assert.deepEqual([r.status, r.queries], ["UNREADABLE", []]);
    assert.equal(calls.records.length, 1, "AI đã chạy (tốn tiền) dù trả lời không đọc được ⇒ vẫn một dòng OK");
    assert.equal(calls.records[0].status, "OK");
  }
  {
    const { d, calls } = deps({
      resolveAi: async () => ({
        ok: true,
        source: "BYOK",
        provider: {
          name: "fake",
          model: "m-x",
          schemaDialect: "anthropic",
          complete: async () => Promise.reject(new Error("503 quá tải")),
        },
      }),
    });
    const r = await expandWithAi(thieu, true, d);
    assert.equal(r.status, "ERROR", "lỗi gọi AI ⇒ không ném");
    assert.ok(r.note?.includes("503"));
    assert.deepEqual(calls.records, [{ source: "BYOK", provider: "fake", model: "m-x", inputTokens: null, outputTokens: null, usage: null, status: "ERROR" }], "lỗi ⇒ một dòng ERROR, token / chi phí CHƯA BIẾT (null)");
  }
  {
    const { d } = deps({ reply: goodReply, record: async () => Promise.reject(new Error("sổ hỏng")) });
    assert.equal((await expandWithAi(thieu, true, d)).status, "OK", "ghi sổ hỏng không làm hỏng lượt tìm");
  }
  // Đọc câu trả lời: JSON lẫn chữ thừa vẫn đọc được; hình dạng sai ⇒ null.
  assert.equal(parseAiReply('Đây: {"queries":[{"zh":"真丝 连衣裙","vi":"x"}]} hết', thieu)?.queries.length, 1);
  assert.equal(parseAiReply('{"queries":"không phải mảng"}', thieu), null);
  assert.equal(parseAiReply("{hỏng", thieu), null);
  assert.equal(parseAiReply(JSON.stringify({ queries: Array.from({ length: 6 }, (_, i) => ({ zh: `连衣裙${i}`, vi: "x" })) }), thieu)?.queries.length, 3, "tối đa 3 truy vấn AI");
}

function testSourceFences() {
  const wiring = readFileSync("lib/sourcing/ai-deps.ts", "utf8");
  assert.ok(wiring.includes('feature: "sourcing"') && wiring.includes('workload: "sourcing"'), "dòng sổ mang feature + workload 'sourcing'");
  assert.ok(wiring.includes('aiUsageByRef(org.code, ["sourcing"]'), "trần đếm bằng CHÍNH sổ AI theo feature 'sourcing'");
  assert.ok(wiring.includes("parseSourcingLimits") && wiring.includes("SOURCING_LIMITS_KEY"), "trần đọc từ sourcing.limits");
  assert.ok(/costUsd: r\.usage && r\.model \? estimateCostUsd\(r\.model, r\.usage\) : null/.test(wiring), "không có token / model ⇒ chi phí null, không 0");
  const act = readFileSync("lib/actions/sourcing-query.ts", "utf8");
  assert.ok(act.startsWith('"use server";') && act.includes('can(user, "sourcing:search")'), "server action đòi quyền tìm");
  for (const f of ["lib/sourcing/query.ts", "lib/constants/sourcing-glossary.ts", "lib/sourcing/ai-expand.ts"]) {
    const s = readFileSync(f, "utf8");
    assert.ok(!/@\/db\b|\bfetch\(|getAiProvider\(|getBuilderAi\(/.test(s), `${f}: thuần — không CSDL, không mạng, không tự mở AI`);
  }
  assert.ok(!readFileSync("app/(dashboard)/sourcing/page.tsx", "utf8").includes("@/lib/sourcing/ai"), "trang không tự gọi AI — chỉ qua server action");
}

export async function testSourcingQuery() {
  testGoldenCases();
  testUnmatchedVisible();
  testGlossaryConsistent();
  await testAiExpansion();
  testSourceFences();
  console.log(`  ✓ SRC-2 bộ sinh từ khoá tiếng Trung: ${SOURCING_GLOSSARY.length} mục từ điển tự nhất quán · ca vàng khách 35–60 tất định · chữ không dấu đoán có nhãn · từ chưa hiểu hiện ra · AI chỉ khi thiếu, đếm theo sổ so trần, hết trần / lỗi vẫn trả phần từ điển · mọi lời gọi một dòng sổ`);
}

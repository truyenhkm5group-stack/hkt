/**
 * THỨ TỰ KHỐI LỜI NHẮC CHO ĐỆM TIỀN TỐ (AI Sales GĐ3 · lib/sales-chatbot/prompt-layout.ts).
 *
 *  1. Công tắc: chỉ OBJECT `{layout: "CACHE_FIRST"}` bật; chuỗi trần / mảng / giá trị lạ / thiếu ⇒ LEGACY (luật cờ settings là object).
 *  2. LEGACY = đúng chuỗi `filter(Boolean).join("\n")` cũ, không điểm cắt; `systemPrompt` = ghép LEGACY của `systemPromptParts`.
 *  3. CACHE_FIRST: xếp ỔN ĐỊNH theo tầng (tĩnh → ngày → giờ → hội thoại → lượt), cùng TẬP DÒNG; điểm cắt = đúng độ dài phần tĩnh.
 *  4. Khối KHÁCH CŨ / dòng THỜI GIAN / kiến thức / đặt lịch mang đúng tầng; phần tĩnh của hai khách khác nhau GIỐNG HỆT nhau.
 *  5. Anthropic: không điểm cắt ⇒ một khối đệm như cũ; có điểm cắt ⇒ khối tĩnh mang dấu đệm, khối sau không, ghép lại đúng chuỗi.
 *
 * Bài «hoán vị» trên bộ hội thoại vàng nằm ở tests/sales-agent-golden/golden.test.ts (`permutationCheck`). Không gọi mạng, không ghim ngày.
 */
import assert from "node:assert/strict";
import { anthropicSystemBlocks } from "@/lib/ai/provider";
import { DEFAULT_SALES_CHATBOT_CONFIG } from "@/lib/sales-chatbot/config";
import { bookingPrompt, systemPrompt, systemPromptParts } from "@/lib/sales-chatbot/engine";
import { assembleSystemPrompt, parsePromptLayout, PROMPT_TIERS, type PromptPart } from "@/lib/sales-chatbot/prompt-layout";

const lines = (s: string) => [...s.split("\n")].sort();

function testSwitch() {
  assert.equal(parsePromptLayout({ layout: "CACHE_FIRST" }), "CACHE_FIRST");
  for (const raw of [null, undefined, "CACHE_FIRST", ["CACHE_FIRST"], { layout: "cache_first" }, { layout: "LEGACY" }, {}, 1, true]) assert.equal(parsePromptLayout(raw), "LEGACY", `${JSON.stringify(raw)} ⇒ LEGACY`);
}

function testAssemble() {
  const parts: PromptPart[] = [
    { text: "A tĩnh", tier: "STATIC" },
    { text: "B khách", tier: "CONVERSATION" },
    { text: "", tier: "STATIC" },
    { text: "C ngày", tier: "DAY" },
    { text: "D giờ", tier: "HOUR" },
    { text: "E tĩnh\nhai dòng", tier: "STATIC" },
    { text: "F lượt", tier: "TURN" },
    { text: "G tĩnh", tier: "STATIC" },
  ];
  const legacy = assembleSystemPrompt(parts, "LEGACY");
  assert.deepEqual(legacy, { system: parts.map((p) => p.text).filter(Boolean).join("\n") }, "LEGACY = chuỗi cũ, không điểm cắt");
  const cf = assembleSystemPrompt(parts, "CACHE_FIRST");
  assert.equal(cf.system, "A tĩnh\nE tĩnh\nhai dòng\nG tĩnh\nC ngày\nD giờ\nB khách\nF lượt", "xếp ổn định theo tầng, cùng tầng giữ thứ tự cũ");
  assert.deepEqual(lines(cf.system), lines(legacy.system), "cùng tập dòng");
  assert.equal(cf.cacheBreak, "A tĩnh\nE tĩnh\nhai dòng\nG tĩnh".length);
  assert.equal(cf.system[cf.cacheBreak!], "\n", "điểm cắt rơi đúng chỗ nối");
  assert.deepEqual(assembleSystemPrompt([{ text: "chỉ tĩnh", tier: "STATIC" }], "CACHE_FIRST"), { system: "chỉ tĩnh" }, "không có phần sau ⇒ không cắt");
  assert.deepEqual(assembleSystemPrompt([{ text: "chỉ lượt", tier: "TURN" }], "CACHE_FIRST"), { system: "chỉ lượt" }, "không có phần tĩnh ⇒ không cắt");
  assert.deepEqual([...PROMPT_TIERS], ["STATIC", "DAY", "HOUR", "CONVERSATION", "TURN"], "thứ tự tầng là hợp đồng — đổi là đổi tiền tố đệm");
}

function testEngineParts() {
  const now = new Date();
  const cfg = { ...DEFAULT_SALES_CHATBOT_CONFIG, extraInstructions: "Giao trong ngày nội thành." };
  const booking = bookingPrompt({ ...cfg, booking: { ...cfg.booking, enabled: true } }, now);
  const args = (returning: string) => [cfg, "Shop", "Bán chả cá", "FANPAGE", "Sổ tay: chào ngắn.", [{ code: "Q1", title: "Bảng giá", upsell: false }], returning, booking, now] as const;
  const a = systemPromptParts(...args("KHÁCH CŨ: chị A, 0901…"));
  assert.equal(systemPrompt(...args("KHÁCH CŨ: chị A, 0901…")), a.map((p) => p.text).filter(Boolean).join("\n"), "systemPrompt = LEGACY của systemPromptParts");
  const tierOf = (needle: string) => a.find((p) => p.text.includes(needle))?.tier;
  assert.equal(tierOf("KHÁCH CŨ: chị A"), "CONVERSATION");
  assert.equal(tierOf("ĐẶT LỊCH HẸN"), "DAY");
  assert.equal(tierOf("THỜI GIAN: bây giờ là"), "HOUR");
  assert.equal(tierOf("Lời chào mở đầu mẫu"), "STATIC");
  assert.equal(tierOf("CÂU MẪU của shop"), "STATIC");
  assert.equal(tierOf("SỔ TAY BÁN HÀNG"), "STATIC");
  // Hai khách khác nhau ⇒ phần TĨNH (điểm cắt) giống hệt nhau — đó là thứ đệm được; bản cũ vỡ ngay sau luật.
  const b = systemPromptParts(...args("KHÁCH CŨ: anh B, 0912…"));
  const x = assembleSystemPrompt(a, "CACHE_FIRST");
  const y = assembleSystemPrompt(b, "CACHE_FIRST");
  assert.ok(x.cacheBreak && y.cacheBreak && x.system.slice(0, x.cacheBreak) === y.system.slice(0, y.cacheBreak), "phần tĩnh không đổi theo khách");
  // (Luật tĩnh vốn NHẮC tới «khối KHÁCH CŨ» — kiểm nội dung của khối, không kiểm cái tên.)
  assert.ok(!x.system.slice(0, x.cacheBreak).includes("KHÁCH CŨ: chị A") && !x.system.slice(0, x.cacheBreak).includes("THỜI GIAN: bây giờ là"), "phần tĩnh không mang khối khách / giờ");
  const lx = assembleSystemPrompt(a, "LEGACY").system;
  const ly = assembleSystemPrompt(b, "LEGACY").system;
  let common = 0;
  while (common < lx.length && lx[common] === ly[common]) common++;
  assert.ok(common < x.cacheBreak!, `bản cũ: tiền tố chung của hai khách (${common} ký tự) NGẮN hơn phần tĩnh của bản mới (${x.cacheBreak})`);
  assert.deepEqual(lines(x.system), lines(lx), "cùng tập dòng với bản cũ");
}

function testAnthropicBlocks() {
  const s = "tĩnh 1\ntĩnh 2\nkhách\nlượt";
  assert.deepEqual(anthropicSystemBlocks(s), [{ type: "text", text: s, cache_control: { type: "ephemeral" } }], "không điểm cắt ⇒ một khối như cũ");
  for (const bad of [0, -1, s.length, s.length + 5, 3.5]) assert.equal(anthropicSystemBlocks(s, bad).length, 1, `điểm cắt ${bad} ngoài khoảng ⇒ một khối`);
  const cut = "tĩnh 1\ntĩnh 2".length;
  const two = anthropicSystemBlocks(s, cut);
  assert.deepEqual(two, [{ type: "text", text: "tĩnh 1\ntĩnh 2", cache_control: { type: "ephemeral" } }, { type: "text", text: "khách\nlượt" }], "khối tĩnh mang dấu đệm, khối sau không");
  assert.equal(`${two[0].text}\n${two[1].text}`, s, "ghép lại đúng chuỗi");
}

export function testSalesPromptLayout(): void {
  testSwitch();
  testAssemble();
  testEngineParts();
  testAnthropicBlocks();
  console.log("  ✓ thứ tự lời nhắc (GĐ3): công tắc chỉ nhận object · LEGACY từng ký tự · CACHE_FIRST cùng tập dòng, phần tĩnh không đổi theo khách · khối đệm Anthropic tách đúng chỗ");
}

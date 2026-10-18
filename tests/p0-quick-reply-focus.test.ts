/**
 * P0 18/10/2026 — AI SALES TƯ VẤN SAI MÓN KHÁCH HỎI (HSLC, ca «ThanhPhương», đã che tên):
 *
 *  · Khách nhắn «xin giá chả cá». 0,3 giây sau bot gửi câu mẫu NEM HẢI SẢN (120.000 ₫ + 3 ảnh nem). Không có lời gọi AI nào: câu mẫu
 *    «Nem hải sản tôm bề bề giá bao nhiêu» mang nhầm các cách hỏi «xin giá chả cá», «Xin giá chả cá nhé shop», «Báo giá chả cá thu?»,
 *    «báo giá» — khớp chữ liền cả cụm (8 điểm) thắng câu mẫu chả cá thu (cách hỏi «Xin giá chả cá thu?» thiếu chữ «thu» nên 0 điểm).
 *  · Gốc ở LÕI: bước khớp chữ chỉ so cụm từ, không biết câu mẫu nói về MÓN nào. Nay (`quick-reply-focus.ts`): món khách đang hỏi (tin
 *    khách mới nhất có gọi tên món trong lượt mua → câu shop / page vừa nói) khoá câu mẫu được trả lời — ở khớp chữ, AI chọn mã, và công
 *    cụ `send_quick_reply`. Câu mẫu không gắn món (ship, cảm ơn, menu chung) không bị ảnh hưởng.
 *
 * Các ca chủ shop yêu cầu: hỏi chả cá → chả cá · hỏi nem → nem · hỏi cả hai → không trả lời nửa câu · từ chối nem → không mời nem lại
 * · tin tự động của page nói chả cá → «báo giá» không thành nem · model gửi câu mẫu nem khi khách hỏi chả cá → máy chủ chặn.
 */
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { createProductCore } from "@/lib/records/product-create";
import { SHOP_SAID } from "@/lib/sales-chatbot/engine";
import { matchQuickReplyByKeyword, QUICK_REPLY_SETTING_KEY, type QuickReplyEntry } from "@/lib/sales-chatbot/quick-replies-shared";
import { productFocusOf, quickReplyCovers, quickReplyFocusGuard, triggerProductConflicts, type FocusProduct } from "@/lib/sales-chatbot/quick-reply-focus";
import { setSettingJson } from "@/lib/settings";
import { runGoldenCases, say, tool, type GoldenCase, type GoldenHookCtx } from "./sales-agent-golden/harness";

// Danh mục giống HSLC (tên thật của shop — không phải dữ liệu khách).
const PRODUCTS: FocusProduct[] = [
  { name: "Chả cá thu", skus: ["CHA-CA-THU", "CHA-CA-THU-05KG", "CHA-CA-THU-2KG"] },
  { name: "Chả mực giã tay", skus: ["CHA-MUC-GIA-TAY"] },
  { name: "Nem hải sản tôm bề bề", skus: ["NEM-HAI-SAN-TOM-BE-BE"] },
  { name: "Nước mắm cốt cá cơm truyền thống", skus: ["NUOC-MAM-COT-CA-COM"] },
  { name: "Ruốc bông (chà bông) cá thu nguyên chất", skus: ["RUOC-BONG-CA-THU-100"] },
  { name: "Ruốc bông (chà bông) tôm biển nguyên chất", skus: ["RUOC-BONG-TOM-100"] },
];
const E = (id: string, title: string, triggers: string[], answer: string): QuickReplyEntry => ({ id, title, triggers, answer });
const A01 = E("a01", "A01 Báo giá chả cá thu", ["báo giá chả cá thu", "giá chả cá thu", "Cha ca", "Xin giá chả cá thu?"], "Dạ chả cá thu bên em 1kg giá {{giá:CHA-CA-THU}} ạ.");
const A03 = E("a03", "A03 Xin giá (chưa nói món nào)", ["xin giá", "cho giá", "hỏi giá"], "Dạ chả cá thu bên em 1kg giá {{giá:CHA-CA-THU}} ạ.");
// Đúng các cách hỏi đang gắn trên câu nem ở production 18/10/2026.
const A07 = E("a07", "A07 Nem hải sản tôm bề bề giá bao nhiêu", ["nem bao nhiêu", "nem hải sản bn", "giá nem", "xin giá chả cá", "Xin giá chả cá nhé shop", "Xin giá 1 kg", "Báo giá chả cá thu?", "báo giá"], "Nem hải sản giá {{giá:NEM-HAI-SAN-TOM-BE-BE}}/1 hộp 10 cái ạ.");
const B10 = E("b10", "B10 Nem 1 hộp mấy cái", ["nem mấy cái", "1 hộp mấy cái"], "1 hộp nem có 10 cái. Mình lấy mấy hộp ạ?");
const UPSELL = E("up", "[UPSELL] Các món bán chạy", ["còn món gì", "menu", "Shop có chả Mực ko ?"], "Dạ bên em còn có các món ngon bán chạy khác, mình lấy thêm món nào báo em giao luôn ạ?");
const THANKS = E("ty", "Cảm ơn khách hàng", ["cảm ơn shop"], "Dạ em cảm ơn anh/chị nhiều ạ!");
const ALL = [A01, A03, A07, B10, UPSELL, THANKS];

/** Đúng phép lọc của `quickReplyByKeyword` (quick-replies.ts): câu mẫu thay cả lượt trả lời phải nói đủ món khách đang hỏi. */
function keyword(texts: string[], shop: string | null = null) {
  const g = quickReplyFocusGuard(texts, shop, PRODUCTS);
  const m = matchQuickReplyByKeyword(texts[texts.length - 1], ALL.filter((e) => g.answers(e)));
  return m.kind === "MATCH" ? m.entry.id : m.kind === "AMBIGUOUS" ? `AMBIGUOUS:${m.entries.map((e) => e.id).sort().join(",")}` : "NONE";
}

function testThuan() {
  // Lỗi gốc còn tái hiện được ở bộ khớp chữ trần — bài kiểm phải đỏ nếu ai đó gỡ bộ lọc.
  const raw = matchQuickReplyByKeyword("xin giá chả cá", ALL);
  assert.equal(raw.kind === "MATCH" ? raw.entry.id : raw.kind, "a07", "bộ khớp chữ trần chọn câu nem cho «xin giá chả cá» (đúng lỗi production)");

  // Món của câu mẫu.
  assert.deepEqual(quickReplyCovers(A01, PRODUCTS), ["Chả cá thu"]);
  assert.deepEqual(quickReplyCovers(A07, PRODUCTS), ["Nem hải sản tôm bề bề"]);
  assert.deepEqual(quickReplyCovers(B10, PRODUCTS), ["Nem hải sản tôm bề bề"], "tiêu đề gọi tên nem ⇒ câu mẫu nói về nem dù không có chỗ trống giá");
  assert.deepEqual(quickReplyCovers(UPSELL, PRODUCTS), [], "câu menu chung không gắn món");
  assert.deepEqual(quickReplyCovers(THANKS, PRODUCTS), []);

  // 1. Hỏi chả cá → chả cá.
  assert.deepEqual(productFocusOf(["xin giá chả cá"], null, PRODUCTS), { focus: ["Chả cá thu"], declined: [], source: "CUSTOMER" });
  assert.equal(keyword(["xin giá chả cá"]), "AMBIGUOUS:a01,a03", "«xin giá chả cá» ⇒ chỉ còn câu mẫu chả cá (hai câu ngang điểm ⇒ AI đọc hiểu chọn giữa HAI câu chả cá)");
  assert.equal(keyword(["Xin giá chả cá nhé shop"]), "AMBIGUOUS:a01,a03");
  assert.equal(keyword(["chả mực giá sao"]), "NONE", "hỏi chả mực ⇒ không câu mẫu chả cá / nem nào trả lời");
  // 2. Hỏi nem → nem.
  assert.equal(keyword(["nem bao nhiêu"]), "a07");
  assert.equal(keyword(["nem 1 hộp mấy cái"]), "b10");
  assert.equal(keyword(["ruốc tôm 1 hộp mấy cái"]), "NONE", "câu «1 hộp mấy cái» của NEM không trả lời câu hỏi về ruốc");
  // 3. Hỏi cả hai → không câu mẫu một món nào thay cả lượt; công cụ của model gửi được cả hai.
  const both = quickReplyFocusGuard(["giá chả cá với nem sao shop"], null, PRODUCTS);
  assert.deepEqual([...both.focus.focus].sort(), ["Chả cá thu", "Nem hải sản tôm bề bề"]);
  assert.equal(keyword(["giá chả cá với nem sao shop"]), "NONE", "một câu báo giá một món không trả lời câu hỏi hai món");
  assert.ok(both.fits(A01) && both.fits(A07), "model gửi câu chả cá rồi câu nem trong một lượt được");
  // 4. Từ chối nem → câu nem không quay lại, kể cả với «báo giá» (cách hỏi đang gắn nhầm trên câu nem).
  const tc = productFocusOf(["không lấy nem đâu em", "báo giá"], null, PRODUCTS);
  assert.deepEqual(tc.declined, ["Nem hải sản tôm bề bề"]);
  assert.equal(keyword(["không lấy nem đâu em", "báo giá"]), "NONE");
  assert.equal(keyword(["chả cá thu", "không lấy nem đâu em", "báo giá"]), "NONE", "món chính vẫn là chả cá: câu nem «báo giá» bị loại");
  assert.equal(productFocusOf(["không lấy nem đâu", "cho chị 1 hộp nem nhé"], null, PRODUCTS).declined.length, 0, "khách đổi ý gọi tên lại ⇒ không còn là từ chối");
  // 5. Tin tự động của page nói chả cá → «báo giá» không thành nem.
  const page = `${SHOP_SAID} Chả cá thu Hạ Long nhà làm, nhắn shop để được báo giá ạ`;
  assert.deepEqual(productFocusOf(["báo giá"], page, PRODUCTS).focus, ["Chả cá thu"]);
  assert.equal(productFocusOf(["báo giá"], page, PRODUCTS).source, "SHOP");
  assert.equal(keyword(["báo giá"], page), "NONE");
  assert.equal(keyword(["báo giá"]), "a07", "không biết khách hỏi món gì ⇒ như cũ (bộ lọc không đoán)");
  // Khách gọi tên món ⇒ thắng câu page.
  assert.deepEqual(productFocusOf(["nem bao nhiêu"], page, PRODUCTS).focus, ["Nem hải sản tôm bề bề"]);
  // Câu mẫu không gắn món luôn trả lời được.
  assert.equal(keyword(["chả cá ngon", "cảm ơn shop"]), "ty");
  assert.equal(keyword(["chả cá thu", "còn món gì"]), "up");
  // «chà bông» không gọi tên chả cá / chả mực.
  assert.deepEqual(productFocusOf(["chà bông bao nhiêu"], null, PRODUCTS).focus, []);

  // KIỂM TĨNH: cách hỏi gắn nhầm món trên câu nem — đúng ba cách hỏi gọi tên chả cá.
  assert.deepEqual(triggerProductConflicts(A07, PRODUCTS).map((x) => x.trigger), ["xin giá chả cá", "Xin giá chả cá nhé shop", "Báo giá chả cá thu?"]);
  assert.deepEqual(triggerProductConflicts(A01, PRODUCTS), []);
  assert.deepEqual(triggerProductConflicts(UPSELL, PRODUCTS), [], "câu menu chung mang «có chả mực không» là hợp lệ");
}

// ═══ chatTurn THẬT + PGlite: đường khớp chữ, AI chọn mã và công cụ send_quick_reply ═══

const CHA_CA = "Dạ chả cá thu bên em 1kg giá {{giá:CCT-1KG}} ạ.";
const NEM = "Nem hải sản giá {{giá:NEM-HOP}}/1 hộp 10 cái ạ.";

async function seed(ctx: Omit<GoldenHookCtx, "conversationId">): Promise<void> {
  const ids = ctx.ids as Map<string, string>;
  if (ids.has("CCT-1KG")) return;
  const admin = await ctx.admin();
  const db = await getDb();
  for (const p of [
    { name: "Chả cá thu", code: "CCT", sku: "CCT-1KG", size: "1kg", price: 280_000 },
    { name: "Nem hải sản tôm bề bề", code: "NEM", sku: "NEM-HOP", size: "Hộp 10 cái", price: 120_000 },
  ]) {
    const r = await createProductCore(admin, { name: p.name, code: p.code, unit: "gói", retailPrice: p.price, cost: null, variants: [{ sku: p.sku, size: p.size, color: "", retailPrice: p.price, cost: null, selling: true }] });
    assert.ok(r.ok, JSON.stringify(r));
    for (const v of await db.select({ id: schema.productVariants.id, sku: schema.productVariants.sku }).from(schema.productVariants).where(eq(schema.productVariants.productId, r.id))) ids.set(v.sku, v.id);
  }
  const qr = schema.salesChatQuickReplies;
  await db.insert(qr).values([
    { title: "A01 Báo giá chả cá thu", triggers: ["giá chả cá thu", "Cha ca", "Xin giá chả cá thu?"], answer: CHA_CA, active: true },
    { title: "A07 Nem hải sản tôm bề bề giá bao nhiêu", triggers: ["nem bao nhiêu", "giá nem", "xin giá chả cá", "Báo giá chả cá thu?", "báo giá"], answer: NEM, active: true },
  ]);
}

async function onlyActive(titles: string[]): Promise<void> {
  const db = await getDb();
  const qr = schema.salesChatQuickReplies;
  await db.update(qr).set({ active: false });
  for (const t of titles) await db.update(qr).set({ active: true }).where(sql`${qr.title} like ${`${t}%`}`);
  await setSettingJson(QUICK_REPLY_SETTING_KEY, { enabled: true, aiMatch: false, upsellReplyId: null, autoLearn: false, autoActivate: false });
}

const CASES: GoldenCase[] = [
  { key: "qrf-hoi-cha-ca", title: "«xin giá chả cá» ⇒ câu mẫu chả cá thu, không phải câu nem đang mang nhầm cách hỏi đó", shop: "food", channel: "WEB", turns: [{ say: "xin giá chả cá", ai: [] }] },
  { key: "qrf-hoi-nem", title: "«nem bao nhiêu» ⇒ câu mẫu nem", shop: "food", channel: "WEB", turns: [{ say: "nem bao nhiêu", ai: [] }] },
  {
    key: "qrf-page-cha-ca",
    title: "Tin tự động của page giới thiệu chả cá, khách «báo giá» ⇒ không gửi câu nem; AI trả lời chả cá",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        say: "báo giá",
        before: async (ctx) => {
          const db = await getDb();
          const m = schema.salesChatMessages;
          const [mx] = await db.select({ n: sql<number>`coalesce(max(${m.seq}), 0)::int` }).from(m).where(eq(m.conversationId, ctx.conversationId));
          await db.insert(m).values({ conversationId: ctx.conversationId, seq: Number(mx?.n ?? 0) + 1, role: "assistant", content: [{ type: "text", text: `${SHOP_SAID} Chả cá thu Hạ Long nhà làm, nhắn shop để được báo giá ạ` }] });
        },
        ai: [() => [say("Dạ chả cá thu 1kg bên em giá 280.000đ ạ.")]],
      },
    ],
  },
  {
    key: "qrf-cong-cu-sai-mon",
    title: "Khách hỏi chả cá, model gọi send_quick_reply câu nem ⇒ máy chủ từ chối «sai món», khách nhận câu chả cá",
    shop: "food",
    channel: "WEB",
    turns: [{ say: "chả cá thu ship mấy ngày tới nơi", ai: [() => [tool("send_quick_reply", { code: "Q1" })], () => [say("Dạ chả cá thu 1kg 280.000đ, giao 1–2 ngày ạ.")]] }],
  },
];

async function testChatTurn() {
  const seen = new Set<string>();
  await runGoldenCases(CASES, {
    orgSuffix: "-qrf",
    beforeCase: async (c, ctx) => {
      await seed(ctx);
      await onlyActive(c.key === "qrf-cong-cu-sai-mon" ? ["A07"] : ["A01", "A07"]);
    },
    afterCase: async (c, _ctx, t) => {
      seen.add(c.key);
      const shown = t.turns.flatMap((x) => x.shown).join("\n");
      const results = JSON.stringify(t.turns.map((x) => x.rounds.map((r) => r.results)));
      assert.doesNotMatch(shown, /HẾT KỊCH BẢN/, `[${c.key}] ${shown}`);
      if (c.key === "qrf-hoi-cha-ca") {
        assert.equal(t.turns[0].rounds.length, 0, "câu mẫu trả lời, không lời gọi AI");
        assert.match(shown, /chả cá thu bên em 1kg giá 280\.000/, shown);
        assert.doesNotMatch(shown, /Nem|120\.000/, `không bao giờ báo giá nem cho câu hỏi chả cá: ${shown}`);
      }
      if (c.key === "qrf-hoi-nem") {
        assert.equal(t.turns[0].rounds.length, 0);
        assert.match(shown, /Nem hải sản giá 120\.000/, shown);
      }
      if (c.key === "qrf-page-cha-ca") {
        assert.equal(t.turns[0].rounds.length, 1, "câu nem bị loại ⇒ AI trả lời");
        assert.doesNotMatch(shown, /Nem|120\.000/, shown);
        assert.match(shown, /chả cá thu/i);
      }
      if (c.key === "qrf-cong-cu-sai-mon") {
        assert.match(results, /sai món khách hỏi/, results);
        assert.doesNotMatch(shown, /Nem|120\.000/, shown);
      }
    },
  });
  assert.equal(seen.size, CASES.length, "mọi ca đều chạy");
}

export async function testP0QuickReplyFocus(): Promise<void> {
  testThuan();
  await testChatTurn();
  console.log("✓ P0 câu mẫu đúng món khách hỏi (18/10/2026): khớp chữ · AI chọn mã · send_quick_reply · page tự động · từ chối · kiểm tĩnh");
}

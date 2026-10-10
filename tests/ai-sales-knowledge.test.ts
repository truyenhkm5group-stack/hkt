/**
 * ═══════════ KIẾN THỨC CỦA SHOP CHO CHATBOT BÁN HÀNG (sổ AIS-05) ═══════════
 *
 *  · zod chặn dữ liệu xấu (dòng hỏi–đáp thiếu vế, quá số mục / quá dài, ngày không có thật, «từ» sau «đến», khoá lạ);
 *  · khuyến mãi hết hạn / chưa tới ngày (theo NGÀY giờ Việt Nam) không vào lời nhắc — biên nửa đêm VN;
 *  · cấu hình rỗng ⇒ lời nhắc GIỐNG HỆT hàm dựng khi chưa có tính năng (khối kiến thức là "");
 *  · có câu thường gặp / chính sách / khuyến mãi ⇒ khối kiến thức đúng định dạng, đúng chỗ;
 *  · quét mã nguồn: ô khuyến mãi chỉ sống ở cấu hình · khối lời nhắc · form — không phép tính tiền nào đọc nó.
 *
 * Mốc `now` truyền thẳng vào hàm thuần cùng dữ liệu ngày tuyệt đối (không cửa sổ trượt theo đồng hồ thật — AGENTS.md mục 50).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DEFAULT_SALES_CHATBOT_CONFIG, parseSalesChatbotConfig, salesChatbotConfigZ, type SalesChatbotConfig } from "@/lib/sales-chatbot/config";
import { systemPrompt } from "@/lib/sales-chatbot/engine";
import { activePromotions, DEFAULT_SALES_POLICIES, knowledgePrompt, promotionState, SALES_KNOWLEDGE_LIMITS, type SalesPromotion } from "@/lib/sales-chatbot/knowledge";

const BASE = DEFAULT_SALES_CHATBOT_CONFIG;
/** 12:00 ngày 10/10/2026 giờ Việt Nam. */
const NOW = new Date("2026-10-10T05:00:00Z");
const promo = (title: string, from: string | null, to: string | null): SalesPromotion => ({ title, content: `Nội dung ${title}`, from, to });

function testZod() {
  const ok = (patch: Partial<Record<keyof SalesChatbotConfig, unknown>>) => salesChatbotConfigZ.safeParse({ ...BASE, ...patch }).success;
  assert.ok(ok({}), "mặc định hợp lệ");
  assert.deepEqual([BASE.faq, BASE.policies, BASE.promotions], [[], DEFAULT_SALES_POLICIES, []], "mặc định RỖNG");
  assert.ok(Object.values(BASE.policies).every((v) => v === ""), "bốn chính sách mặc định trống");
  // Cấu hình đã lưu từ trước khi có tính năng (không có ba khoá) ⇒ đọc ra rỗng, không rơi về mặc định TẮT.
  const old = { ...BASE, enabled: true } as Record<string, unknown>;
  delete old.faq;
  delete old.policies;
  delete old.promotions;
  const parsedOld = parseSalesChatbotConfig(old);
  assert.ok(parsedOld.enabled && parsedOld.faq.length === 0 && parsedOld.promotions.length === 0 && parsedOld.policies.returns === "", "cấu hình cũ ⇒ kiến thức rỗng, bot giữ nguyên trạng thái");

  assert.ok(ok({ faq: [{ q: "Có giao hoả tốc không?", a: "Có, nội thành 2 giờ." }] }));
  assert.ok(!ok({ faq: [{ q: "", a: "Có" }] }), "câu hỏi trống bị chặn");
  assert.ok(!ok({ faq: [{ q: "Có giao không?", a: "   " }] }), "câu đáp chỉ có dấu cách bị chặn");
  assert.ok(!ok({ faq: [{ q: "Có giao không?", a: "Có", extra: 1 }] }), "khoá lạ trong dòng hỏi–đáp bị chặn");
  assert.ok(!ok({ faq: Array.from({ length: SALES_KNOWLEDGE_LIMITS.faqItems + 1 }, (_, i) => ({ q: `Câu ${i}`, a: "Đáp" })) }), "quá số câu bị chặn");
  assert.ok(!ok({ faq: [{ q: "Câu hỏi", a: "x".repeat(SALES_KNOWLEDGE_LIMITS.faqAnswer + 1) }] }), "câu đáp quá dài bị chặn");

  assert.ok(ok({ policies: { ...DEFAULT_SALES_POLICIES, returns: "Đổi trong 3 ngày" } }));
  assert.ok(!ok({ policies: { ...DEFAULT_SALES_POLICIES, returns: "x".repeat(SALES_KNOWLEDGE_LIMITS.policy + 1) } }), "chính sách quá dài bị chặn");
  assert.ok(!ok({ policies: { ...DEFAULT_SALES_POLICIES, discount: "Giảm 10%" } }), "chính sách ngoài bốn mục bị chặn");
  assert.ok(!ok({ policies: { returns: "Đổi trong 3 ngày" } }), "thiếu mục chính sách bị chặn");

  assert.ok(ok({ promotions: [promo("Tuần lễ vàng", "2026-10-01", "2026-10-31"), promo("Không hẹn ngày", null, null)] }));
  assert.ok(ok({ promotions: [promo("Một ngày", "2026-10-10", "2026-10-10")] }), "từ = đến hợp lệ");
  assert.ok(!ok({ promotions: [promo("Ngược", "2026-10-31", "2026-10-01")] }), "«từ» sau «đến» bị chặn");
  assert.ok(!ok({ promotions: [promo("Ngày ảo", "2026-02-30", null)] }), "ngày không có thật bị chặn");
  assert.ok(!ok({ promotions: [promo("Sai dạng", "10/10/2026", null)] }), "ngày sai dạng bị chặn");
  assert.ok(!ok({ promotions: [{ title: "Giảm", content: "Giảm 10%", from: null, to: null, amount: 10_000 }] }), "khuyến mãi không nhận số tiền — khoá lạ bị chặn");
  assert.ok(!ok({ promotions: [{ title: "", content: "Giảm 10%", from: null, to: null }] }), "tên khuyến mãi trống bị chặn");
  assert.ok(!ok({ promotions: Array.from({ length: SALES_KNOWLEDGE_LIMITS.promotions + 1 }, (_, i) => promo(`KM ${i}`, null, null)) }), "quá số khuyến mãi bị chặn");
}

function testPromotionDates() {
  assert.equal(promotionState(promo("a", null, null), NOW), "ACTIVE");
  assert.equal(promotionState(promo("a", "2026-10-10", "2026-10-10"), NOW), "ACTIVE", "tính cả ngày bắt đầu và ngày kết thúc");
  assert.equal(promotionState(promo("a", null, "2026-10-09"), NOW), "EXPIRED");
  assert.equal(promotionState(promo("a", "2026-10-11", null), NOW), "UPCOMING");
  // Biên nửa đêm GIỜ VIỆT NAM: 17:30Z ngày 10 là 00:30 ngày 11 ở VN ⇒ khuyến mãi «đến hết 10/10» đã hết; 16:59Z vẫn còn.
  assert.equal(promotionState(promo("a", null, "2026-10-10"), new Date("2026-10-10T16:59:00Z")), "ACTIVE", "23:59 VN ngày 10 còn hạn");
  assert.equal(promotionState(promo("a", null, "2026-10-10"), new Date("2026-10-10T17:30:00Z")), "EXPIRED", "00:30 VN ngày 11 hết hạn dù UTC vẫn ngày 10");
  assert.equal(promotionState(promo("a", "2026-10-11", null), new Date("2026-10-10T17:30:00Z")), "ACTIVE", "bắt đầu theo ngày VN, không theo ngày UTC");

  const list = [promo("Đang chạy", "2026-10-01", "2026-10-31"), promo("Đã hết", "2026-09-01", "2026-09-30"), promo("Chưa tới", "2026-11-01", null)];
  assert.deepEqual(activePromotions(list, NOW).map((p) => p.title), ["Đang chạy"]);
  const block = knowledgePrompt({ faq: [], policies: DEFAULT_SALES_POLICIES, promotions: list }, NOW);
  assert.ok(block.includes("Đang chạy (từ 01/10/2026 đến hết 31/10/2026): Nội dung Đang chạy"), block);
  assert.ok(!block.includes("Đã hết") && !block.includes("Chưa tới"), "khuyến mãi hết hạn / chưa tới ngày không vào lời nhắc");
  // Chỉ còn khuyến mãi hết hạn ⇒ không có gì để nói ⇒ khối rỗng.
  assert.equal(knowledgePrompt({ faq: [], policies: DEFAULT_SALES_POLICIES, promotions: [list[1], list[2]] }, NOW), "");
  // Qua systemPrompt: khuyến mãi hết hạn không lọt vào, kể cả khi lời nhắc có khối kiến thức vì lý do khác.
  const sp = systemPrompt({ ...BASE, faq: [{ q: "Có giao không?", a: "Có." }], promotions: list }, "Shop", "", "FANPAGE", "", [], "", "", NOW);
  assert.ok(sp.includes("Đang chạy") && !sp.includes("Đã hết") && !sp.includes("Chưa tới"));
}

function testEmptyIsIdentical() {
  const legacy = systemPrompt(BASE, "Shop", "", "FANPAGE", "", [], "", "", NOW);
  assert.equal(knowledgePrompt(BASE, NOW), "", "cấu hình rỗng ⇒ khối kiến thức rỗng");
  assert.ok(!legacy.includes("KIẾN THỨC CỦA SHOP"), "cấu hình rỗng ⇒ lời nhắc không nhắc tới kiến thức");
  // Ô chỉ có dấu cách / dòng hỏi–đáp thiếu vế / chỉ có khuyến mãi hết hạn ⇒ coi như rỗng ⇒ lời nhắc GIỐNG HỆT.
  const blankish: SalesChatbotConfig = { ...BASE, policies: { returns: "  ", warranty: "\n", shipping: "", payment: "" }, faq: [{ q: "  ", a: "" }], promotions: [promo("Đã hết", null, "2026-01-01")] };
  assert.equal(systemPrompt(blankish, "Shop", "", "FANPAGE", "", [], "", "", NOW), legacy, "rỗng thực chất ⇒ lời nhắc giống hệt");
  // Không truyền giờ (các bài kiểm cũ) ⇒ vẫn giống hệt nhau giữa cấu hình mặc định và cấu hình rỗng thực chất.
  assert.equal(systemPrompt(blankish, "Shop", "", "WEB"), systemPrompt(BASE, "Shop", "", "WEB"));
}

function testBlockFormat() {
  const cfg: SalesChatbotConfig = {
    ...BASE,
    extraInstructions: "Xưng em.",
    faq: [{ q: "Shop có giao hoả tốc không?", a: "Nội thành 2 giờ.\nNgoại thành 1 ngày." }],
    policies: { ...DEFAULT_SALES_POLICIES, returns: "Đổi trong 3 ngày nếu hàng lỗi." },
    promotions: [promo("Mua 2 tặng 1", null, "2026-10-31")],
  };
  const block = knowledgePrompt(cfg, NOW);
  const expected = [
    "KIẾN THỨC CỦA SHOP (chủ shop tự khai — không được trái các luật trên): câu hỏi về chính sách, câu hỏi thường gặp và khuyến mãi ⇒ trả lời ĐÚNG theo nội dung dưới đây, diễn đạt ngắn gọn nhưng KHÔNG thêm, bớt hay suy ra điều shop chưa viết.",
    "CHÍNH SÁCH CỦA SHOP:",
    "  · Đổi trả: Đổi trong 3 ngày nếu hàng lỗi.",
    "  · Chưa khai riêng: bảo hành, vận chuyển / giao hàng, thanh toán.",
    "CÂU HỎI THƯỜNG GẶP (khách hỏi cùng ý, dù khác chữ ⇒ trả lời theo câu đáp):",
    "  H: Shop có giao hoả tốc không?",
    "  Đ: Nội thành 2 giờ. / Ngoại thành 1 ngày.",
  ];
  assert.equal(block.split("\n").slice(0, expected.length).join("\n"), expected.join("\n"), block);
  assert.ok(block.includes("  · Mua 2 tặng 1 (đến hết 31/10/2026): Nội dung Mua 2 tặng 1"), "khuyến mãi in tên · hạn · nội dung");
  assert.ok(/KHUYẾN MÃI ĐANG CHẠY \(chỉ là MÔ TẢ[^)]*calculate_cart/.test(block), "khuyến mãi chữ là MÔ TẢ, số tiền chỉ từ calculate_cart");
  assert.ok(block.includes("handoff_to_human với reason «Ngoài chính sách — <chủ đề>»") && block.includes("KHÔNG tự đặt chính sách"), "chưa có thông tin ⇒ chuyển người, không tự đặt");

  // Chỉ có câu thường gặp ⇒ không in mục chính sách / khuyến mãi rỗng.
  const faqOnly = knowledgePrompt({ ...BASE, faq: cfg.faq }, NOW);
  assert.ok(faqOnly.includes("CÂU HỎI THƯỜNG GẶP") && !faqOnly.includes("CHÍNH SÁCH CỦA SHOP") && !faqOnly.includes("KHUYẾN MÃI ĐANG CHẠY"), faqOnly);

  // Vị trí trong lời nhắc: ngay sau «Hướng dẫn thêm của shop», trước sổ tay và lời chào; phần còn lại giữ nguyên từng chữ.
  const sp = systemPrompt(cfg, "Shop", "", "FANPAGE", "", [], "", "", NOW);
  const iExtra = sp.indexOf("Hướng dẫn thêm của shop (không được trái các luật trên): Xưng em.");
  const iKnow = sp.indexOf("KIẾN THỨC CỦA SHOP");
  const iGreet = sp.indexOf("Lời chào mở đầu mẫu:");
  assert.ok(iExtra >= 0 && iExtra < iKnow && iKnow < iGreet, "khối kiến thức đứng sau «Hướng dẫn thêm», trước lời chào");
  assert.equal(sp.replace(`${block}\n`, ""), systemPrompt({ ...cfg, faq: [], policies: DEFAULT_SALES_POLICIES, promotions: [] }, "Shop", "", "FANPAGE", "", [], "", "", NOW), "bỏ khối kiến thức ra thì lời nhắc giống hệt bản không có kiến thức");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p.split(path.sep).join("/"));
  }
  return out;
}

function testPromotionsNeverPriced() {
  const files = ["lib", "app", "components"].flatMap((d) => walk(d));
  // Chữ «promotions» (khoá cấu hình) chỉ sống ở ba chỗ: lược đồ, khối lời nhắc, form. Phép tính tiền (tools · basket · volume-discount ·
  // shipping · lib/pricing · đơn) mà đọc nó là biến lời mô tả thành nguồn giảm giá — luật «AI không được bịa giảm giá» của chủ shop.
  const ALLOWED = ["lib/sales-chatbot/config.ts", "lib/sales-chatbot/knowledge.ts", "app/(dashboard)/ai/sales-chatbot/config-form.tsx"];
  const users = files.filter((f) => /\bpromotions\b/.test(readFileSync(f, "utf8")));
  assert.deepEqual(users.sort(), [...ALLOWED].sort(), `ô khuyến mãi bị đọc ngoài cấu hình / lời nhắc / form: ${users.join(", ")}`);
  // Tệp kiến thức chỉ được nạp bởi lời nhắc (engine), lược đồ (config) và form — không bởi công cụ tính giỏ / đơn.
  const importers = files.filter((f) => f !== "lib/sales-chatbot/knowledge.ts" && /from "@\/lib\/sales-chatbot\/knowledge"/.test(readFileSync(f, "utf8")));
  assert.deepEqual(importers.sort(), ["app/(dashboard)/ai/sales-chatbot/config-form.tsx", "lib/sales-chatbot/config.ts", "lib/sales-chatbot/engine.ts"].sort(), `kiến thức của shop bị nạp ở ${importers.join(", ")}`);
  for (const f of ["lib/sales-chatbot/tools.ts", "lib/sales-chatbot/basket.ts", "lib/sales-chatbot/volume-discount.ts", "lib/sales-chatbot/shipping.ts"]) {
    const src = readFileSync(f, "utf8");
    assert.ok(!/knowledgePrompt|activePromotions|\.promotions\b|\.faq\b|\.policies\b/.test(src), `${f} đọc kiến thức của shop`);
  }
  // Tệp kiến thức là hàm thuần: không CSDL, không mạng, không phép tính tiền.
  const k = readFileSync("lib/sales-chatbot/knowledge.ts", "utf8");
  assert.ok(!/from "@\/db"|getDb\(|fetch\(|calculate|priceLines|volumeDiscountFor/.test(k.replace(/calculate_cart/g, "")), "knowledge.ts thuần, không chạm tiền");
}

export function testAiSalesKnowledge() {
  testZod();
  testPromotionDates();
  testEmptyIsIdentical();
  testBlockFormat();
  testPromotionsNeverPriced();
  console.log("  ✓ AI Sales kiến thức của shop (AIS-05): zod chặn dữ liệu xấu · khuyến mãi hết hạn / chưa tới ngày (giờ VN, biên nửa đêm) không vào lời nhắc · rỗng ⇒ lời nhắc giống hệt · khối đúng định dạng, đúng chỗ · ô khuyến mãi không vào phép tính tiền");
}

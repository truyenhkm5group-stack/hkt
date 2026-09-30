/**
 * ═══════════ BOT RIÊNG THEO QUẢNG CÁO: ERP DỰNG ĐÚNG, BOT NHẬN ĐÚNG ═══════════
 *
 * ERP dựng danh sách (`buildAdBots`, hàm thuần) → `PUT /api/erp/ad-bots` → bot kiểm lại (`normalizeAdBotPayload`).
 * Hai đầu viết bằng hai ngôn ngữ, nên bài kiểm chạy gói ERP dựng QUA CHÍNH bộ kiểm của bot: lệch hình dạng
 * là đỏ ở đây, không phải im lặng mất bot riêng trên production.
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/chatbot-ad-bots.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AD_TEST_IMAGE_LIMITS, adTestReadiness, buildAdBots, DEFAULT_AD_BOT_CONFIG, pageIdOfPost, productCodeOf, saveAdBotSchema, testImageGate, testImageSpendToday, testProductMissing, type AdBotSourceRow, type AdTestProduct, type ReadinessInput } from "@/lib/constants/chatbot-ad-bots";

const row = (x: Partial<AdBotSourceRow> & { adId: string }): AdBotSourceRow => ({
  source: "CREATIVE_TEST",
  status: "LIVE",
  campaignName: "QUAN_TA_30/09_Q004",
  adName: "ad",
  adCopy: "Đầm báo đỏ 499K — INBOX NGAY",
  productId: "p1",
  productCode: "Q004",
  productName: "Đầm Q004",
  publishedAt: new Date("2026-09-30T00:00:00Z"),
  ...x,
});

type BotModule = {
  normalizeAdBotPayload: (p: unknown) => { bots: Record<string, { productCode: string; instructions: string; productName: string }>; skipped: number };
};

export async function testChatbotAdBots() {
  assert.equal(productCodeOf("Q004", 12), "Q004");
  assert.equal(productCodeOf("  ", 12), "12", "thiếu custom_id thì lấy display_id — đúng như bot đọc danh mục POS");
  assert.equal(productCodeOf(null, null), null);

  const rows = [
    row({ adId: "120000000000000001" }),
    row({ adId: "120000000000000002", productId: null, productCode: null, productName: null, campaignName: "QUAN_TA_30/09_TEST_HảiAn" }),
    row({ adId: "120000000000000003" }),
    // cùng ad_id ở bảng scale, đăng MUỘN hơn ⇒ dòng scale thắng
    row({ adId: "120000000000000003", source: "CREATIVE_SCALE", campaignName: "SCALE", publishedAt: new Date("2026-10-01T00:00:00Z") }),
    row({ adId: "khong-phai-so" }),
  ];
  const base = buildAdBots(rows, DEFAULT_AD_BOT_CONFIG);
  assert.equal(base.lines.length, 3, "ad_id không phải chữ số bị bỏ, ad_id trùng gộp một dòng");
  assert.equal(base.lines.find((l) => l.adId === "120000000000000003")?.source, "CREATIVE_SCALE");
  assert.equal(base.lines.find((l) => l.adId === "120000000000000002")?.state, "NO_PRODUCT", "không gắn mã, chưa có hướng dẫn ⇒ KHÔNG có bot riêng, không đoán mẫu theo tên camp");
  assert.deepEqual(base.push.map((p) => p.adId).sort(), ["120000000000000001", "120000000000000003"]);

  const withOverrides = buildAdBots(rows, {
    enabled: true,
    overrides: {
      "120000000000000001": { enabled: false, updatedByUserId: "u1", updatedByName: "A", updatedAt: "2026-09-30T00:00:00Z" },
      "120000000000000002": { productCode: "q007", instructions: "Xưng em gọi chị", updatedByUserId: "u1", updatedByName: "A", updatedAt: "2026-09-30T00:00:00Z" },
      "120000000000000003": { productCode: "Q009", updatedByUserId: "u1", updatedByName: "A", updatedAt: "2026-09-30T00:00:00Z" },
    },
  });
  const st = Object.fromEntries(withOverrides.lines.map((l) => [l.adId, l.state]));
  assert.equal(st["120000000000000001"], "OFF_BY_USER");
  assert.equal(st["120000000000000002"], "ACTIVE", "người gắn mã cho quảng cáo chưa gắn ⇒ có bot riêng");
  const p2 = withOverrides.push.find((p) => p.adId === "120000000000000002");
  assert.equal(p2?.productCode, "Q007");
  const p3 = withOverrides.push.find((p) => p.adId === "120000000000000003");
  assert.equal(p3?.productCode, "Q009");
  assert.equal(p3?.productName, "", "người đổi mã ⇒ không gửi kèm tên của mẫu CŨ");

  const off = buildAdBots(rows, { ...DEFAULT_AD_BOT_CONFIG, enabled: false });
  assert.equal(off.push.length, 0, "công tắc chung tắt ⇒ bot nhận danh sách rỗng");
  assert.ok(off.lines.every((l) => l.state === "GLOBAL_OFF"));

  assert.equal(saveAdBotSchema.safeParse({ adId: "12ab", enabled: true, productCode: "", instructions: "" }).success, false);
  assert.equal(saveAdBotSchema.safeParse({ adId: "120000000000000001", enabled: true, productCode: "Q0 04", instructions: "" }).success, false);
  assert.equal(saveAdBotSchema.safeParse({ adId: "120000000000000001", enabled: true, productCode: "Q004", instructions: "ok" }).success, true);

  // Hợp đồng hai đầu: gói ERP dựng phải qua được bộ kiểm của bot, không mất dòng nào.
  const bot = (await import(pathToFileURL(path.resolve("chatbot/src/adpersona.js")).href)) as BotModule;
  const got = bot.normalizeAdBotPayload({ bots: withOverrides.push });
  assert.equal(got.skipped, 0, "bot không được bỏ dòng nào ERP gửi");
  assert.equal(Object.keys(got.bots).length, withOverrides.push.length);
  assert.equal(got.bots["120000000000000002"].instructions, "Xưng em gọi chị");

  // Cửa bot nhận gói: có đường PUT/GET, nằm SAU phép kiểm ADMIN_TOKEN (erp-entry + admin đều kiểm trước khi gọi).
  const routes = readFileSync("chatbot/src/erp-import.js", "utf8");
  assert.ok(routes.includes('url.pathname === "/api/erp/ad-bots"'), "bot phải có cửa /api/erp/ad-bots");
  // ── Mẫu test mới (nút Chat test) ──
  const sha = "a".repeat(64);
  const test: AdTestProduct = { name: "Đầm da báo", code: "test-db01", price: 459000, shipFee: 25000, comboPrice: null, fabric: "Thun lạnh", sizes: "", offer: "", colors: [{ color: "Đỏ", imageId: "img1", sha, source: "AI", createdAt: "2026-10-01T00:00:00Z" }] };
  assert.deepEqual(testProductMissing(test), []);
  assert.deepEqual(testProductMissing({ ...test, price: null, fabric: " ", colors: [] }), ["giá 1 chiếc", "chất vải", "ít nhất một màu có ảnh"], "giá CHƯA NHẬP là thiếu, không phải 0đ");
  const meta = { updatedByUserId: "u1", updatedByName: "A", updatedAt: "2026-10-01T00:00:00Z" };
  const draft = buildAdBots([row({ adId: "120000000000000009", productId: null, productCode: null, productName: null })], { enabled: true, overrides: { "120000000000000009": { ...meta, enabled: false, test } } });
  assert.equal(draft.lines[0].state, "TEST_DRAFT");
  assert.equal(draft.push[0].enabled, false, "chưa bật ⇒ bot giữ để chat thử, KHÔNG dùng cho khách thật");
  assert.equal(draft.push[0].test?.code, "TEST-DB01");
  const live = buildAdBots([row({ adId: "120000000000000009" })], { enabled: true, overrides: { "120000000000000009": { ...meta, enabled: true, test } } });
  assert.equal(live.lines[0].state, "ACTIVE");
  assert.equal(live.push[0].productCode, "TEST-DB01", "mẫu test thay mã gắn trên quảng cáo");
  const half = buildAdBots([row({ adId: "120000000000000009", productId: null, productCode: null, productName: null })], { enabled: true, overrides: { "120000000000000009": { ...meta, enabled: true, test: { ...test, price: null } } } });
  assert.equal(half.push.length, 0, "mẫu test thiếu giá ⇒ không gửi gì sang bot");
  const botTest = bot.normalizeAdBotPayload({ bots: draft.push }) as unknown as { bots: Record<string, { test: { price: number; colors: unknown[] } | null }> };
  assert.equal(botTest.bots["120000000000000009"].test?.price, 459000, "gói mẫu test qua được bộ kiểm của bot");

  assert.equal(pageIdOfPost("104512345678901_998877"), "104512345678901");
  assert.equal(pageIdOfPost(""), null);

  const now = new Date("2026-10-01T10:00:00Z");
  const spend = [{ adId: "x", at: "2026-10-01T02:00:00Z", usd: 1.5, estimated: false }, { adId: "x", at: "2026-09-30T17:30:00Z", usd: 0.2, estimated: true }, { adId: "x", at: "2026-09-30T16:30:00Z", usd: 9, estimated: false }];
  assert.equal(Math.round(testImageSpendToday(spend, now) * 100) / 100, 1.7, "ngày theo giờ VN: 17:30Z 30/09 = 00:30 01/10 (tính), 16:30Z 30/09 = 23:30 hôm trước (không tính); lượt ƯỚC TÍNH vẫn vào trần");
  assert.equal(testImageGate({ colors: 0, spentTodayUsd: 1.7, estimateUsd: 0.4 }).ok, false, "vượt trần ngày ⇒ chặn TRƯỚC khi gọi AI");
  assert.equal(testImageGate({ colors: AD_TEST_IMAGE_LIMITS.maxColorsPerAd, spentTodayUsd: 0, estimateUsd: 0.1 }).ok, false);
  assert.equal(testImageGate({ colors: 1, spentTodayUsd: 0.5, estimateUsd: 0.2 }).ok, true);

  const rdy: ReadinessInput = { pageId: "104512345678901", pageName: "Linen", pancakePageIds: ["104512345678901"], pancakeError: null, botState: "RUNNING", botError: null, botPage: { enabled: true, dryRun: false, pauseTagId: "99", minCustomerMessages: 1 }, testMissing: [], imagesMissingOnBot: 0, live: false, seenCount: 0 };
  const rst = (i: ReadinessInput) => Object.fromEntries(adTestReadiness(i).checks.map((c) => [c.key, c.status]));
  assert.equal(adTestReadiness(rdy).canGoLive, true);
  assert.equal(rst({ ...rdy, pancakePageIds: [] }).PANCAKE, "MISSING", "page không có trong Pancake");
  assert.equal(rst({ ...rdy, pancakePageIds: null }).PANCAKE, "UNKNOWN", "ERP không đọc được Pancake ⇒ CHƯA BIẾT, không phải chưa kết nối");
  assert.equal(adTestReadiness({ ...rdy, pancakePageIds: null }).canGoLive, true, "CHƯA BIẾT không chặn bật");
  const noToken = adTestReadiness({ ...rdy, botPage: null });
  assert.equal(noToken.checks.find((c) => c.key === "TOKEN")?.status, "MISSING");
  assert.ok(noToken.checks.find((c) => c.key === "TOKEN")?.fix.includes("Thêm page"), "dòng thiếu nói CÁCH bổ sung");
  assert.equal(noToken.canGoLive, false);
  assert.equal(rst({ ...rdy, botPage: { ...rdy.botPage!, dryRun: true } }).SEND, "WARN", "chỉ log là cảnh báo, chat thử vẫn chạy");
  assert.equal(adTestReadiness({ ...rdy, botPage: { ...rdy.botPage!, dryRun: true } }).canChat, true);
  assert.equal(rst({ ...rdy, botPage: { ...rdy.botPage!, minCustomerMessages: 2 } }).FIRST, "WARN", "tin tự động đầu của Pancake không theo camp");
  assert.equal(adTestReadiness({ ...rdy, testMissing: ["chất vải"] }).canChat, false);
  assert.equal(adTestReadiness({ ...rdy, botState: "UNREACHABLE", botError: "x" }).canChat, false);

  console.log("✓ Chat test mẫu mới: thiếu giá / chất vải / ảnh ⇒ không gửi, chưa bật ⇒ bot chỉ chat thử, trần ảnh theo ngày VN chặn trước khi gọi AI, bảng kiểm page tách THIẾU / CHƯA BIẾT / CẢNH BÁO kèm cách bổ sung");
  console.log("✓ Bot riêng theo quảng cáo: gộp ad_id, không đoán mẫu cho QC chưa gắn mã, ghi đè bật/tắt/mã, công tắc chung, gói ERP qua được bộ kiểm của bot");
}

if (process.argv[1] && process.argv[1].endsWith("chatbot-ad-bots.test.ts")) void testChatbotAdBots();

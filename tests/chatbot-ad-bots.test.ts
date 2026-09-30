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
import { buildAdBots, DEFAULT_AD_BOT_CONFIG, productCodeOf, saveAdBotSchema, type AdBotSourceRow } from "@/lib/constants/chatbot-ad-bots";

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
  console.log("✓ Bot riêng theo quảng cáo: gộp ad_id, không đoán mẫu cho QC chưa gắn mã, ghi đè bật/tắt/mã, công tắc chung, gói ERP qua được bộ kiểm của bot");
}

if (process.argv[1] && process.argv[1].endsWith("chatbot-ad-bots.test.ts")) void testChatbotAdBots();

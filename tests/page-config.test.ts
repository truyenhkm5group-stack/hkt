/**
 * ═══════════ CẤU HÌNH AI THEO PAGE — THUẦN (lib/sales-chatbot/page-config-shared.ts) ═══════════
 *
 * Khoá: page thừa hưởng cấu hình tổ chức, chỉ đè các trường trong danh sách trắng; trường ngoài danh sách (khoá AI, công cụ,
 * giá sỉ…) bị TỪ CHỐI cả phần đè; phần đè làm cấu hình hỏng ⇒ dùng nguyên cấu hình tổ chức; Instagram thừa hưởng page cha;
 * không phần đè ⇒ đúng cấu hình cũ. Phần chạy trên tổ chức thật ở tests/messenger-multipage.test.ts.
 */
import assert from "node:assert/strict";
import { DEFAULT_SALES_CHATBOT_CONFIG } from "@/lib/sales-chatbot/config";
import { configForPage, parsePageOverrides } from "@/lib/sales-chatbot/page-config-shared";

export function testPageConfig() {
  const base = { ...DEFAULT_SALES_CHATBOT_CONFIG, enabled: true, botName: "Bot chung", wholesalePricing: false };
  const ov = parsePageOverrides({
    p1: { botName: "Bot Hải Sản", extraInstructions: "Chỉ bán hải sản khô", handoffMessage: "Chị đợi em gọi lại nhé" },
    p2: { connectorKey: "openai-byok" },
    p3: { wholesalePricing: true },
    p4: { botName: "x" },
    "bad id!": { botName: "Bot lạ" },
  });
  assert.deepEqual(Object.keys(ov), ["p1"], "trường ngoài danh sách trắng / sai luật / mã page lạ ⇒ bỏ cả phần đè");
  const c1 = configForPage(base, ov, "p1");
  assert.ok(c1.botName === "Bot Hải Sản" && c1.extraInstructions === "Chỉ bán hải sản khô" && c1.handoff.message === "Chị đợi em gọi lại nhé" && c1.handoff.onComplaint === base.handoff.onComplaint, JSON.stringify(c1.handoff));
  assert.ok(c1.connectorKey === base.connectorKey && c1.wholesalePricing === base.wholesalePricing && JSON.stringify(c1.allowedTools) === JSON.stringify(base.allowedTools), "khoá AI / giá sỉ / công cụ ở lại cấp tổ chức");
  assert.equal(configForPage(base, ov, "p9"), base, "không phần đè ⇒ đúng cấu hình tổ chức");
  assert.equal(configForPage(base, ov, null), base);
  assert.equal(configForPage(base, ov, "ig-1", "p1").botName, "Bot Hải Sản", "Instagram thừa hưởng page cha");
  assert.equal(configForPage(base, { p1: { businessHours: { enabled: true, start: "99:99" } } }, "p1"), base, "phần đè làm cấu hình hỏng ⇒ dùng nguyên cấu hình tổ chức");
  console.log("✓ Cấu hình AI theo page · thuần: chỉ đè danh sách trắng (tên bot · giọng · lời chào · giờ · chỉ dẫn · ship · câu chuyển người) · khoá AI / công cụ / giá sỉ ở lại tổ chức · phần đè hỏng ⇒ cấu hình chung · Instagram theo page cha · không đè ⇒ y như cũ");
}

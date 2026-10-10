/**
 * ═══════════ AI SALES SETTINGS V2: MỘT Ô TRẠNG THÁI · MỘT NÚT CHÍNH · KHÁCH KHÔNG THẤY ĐỘNG CƠ AI (bảng VISIBLE_PRODUCT_FINISH_BOARD, bề mặt 3) ═══════════
 *
 *  · Thuần: bảng chân lý của `settingsStatus` — đủ sáu trạng thái, đúng thứ tự việc phải làm, và mọi nhánh THIẾU DỮ KIỆN ra
 *    «Chưa rõ», không bao giờ «Đang chạy» (luật 42 / 52). Nút chính trỏ tới đường người xem mở được — vỏ chặn trang ⇒ không nút.
 *  · Mã nguồn: trang dựng ô trạng thái trước mọi khung; nhánh KHÁCH (gồm khách vỏ Chốt Đơn) không nhận / không in khoá AI,
 *    model, model dự phòng, tên hãng AI, giá vốn USD — khối «Nâng cao» chỉ dựng khi có `engine` (chỉ workspace nhà).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CHATBOT_ENGINE_FIELDS, customerChatbotConfig } from "@/lib/saas/visibility";
import { DEFAULT_SALES_CHATBOT_CONFIG } from "@/lib/sales-chatbot/config";
import { channelLinkOf, SETTINGS_HREF, SETTINGS_STATE_LABEL, settingsStatus, type SettingsStatusInput } from "@/lib/sales-chatbot/settings-status";
import { visibleTexts } from "./saas-hide-internal.test";

const DIR = "app/(dashboard)/ai/sales-chatbot";
const read = (f: string) => readFileSync(f, "utf8");

/** Shop khách đủ mọi thứ: AI dùng được, có sản phẩm có giá, fanpage đang bật, bot bật, chế độ tự động. */
const OK: SettingsStatusInput = {
  audience: "CUSTOMER",
  botEnabled: true,
  aiReady: true,
  quotaExhausted: false,
  mode: "AUTOPILOT",
  channels: { fanpage: "ACTIVE", zalo: "OFF", messengerPages: 0, webChat: false },
  hasPricedProducts: true,
};
const SUPPORT = "https://zalo.me/0000000000";

function testTruthTable() {
  const cases: { name: string; input: Partial<SettingsStatusInput>; state: string; reason: string; href: string | null }[] = [
    { name: "đủ mọi thứ", input: {}, state: "RUNNING", reason: "RUNNING", href: SETTINGS_HREF.inbox },
    { name: "chỉ có trang chat web", input: { channels: { fanpage: "OFF", zalo: "OFF", messengerPages: 0, webChat: true } }, state: "RUNNING", reason: "RUNNING", href: SETTINGS_HREF.inbox },
    { name: "thử nghiệm AI và người vẫn là đang chạy", input: { mode: "EXPERIMENT" }, state: "RUNNING", reason: "RUNNING", href: SETTINGS_HREF.inbox },
    { name: "hết lượt gói đứng trên mọi thứ", input: { quotaExhausted: true, aiReady: false, botEnabled: false, hasPricedProducts: false }, state: "OUT_OF_QUOTA", reason: "QUOTA_EXHAUSTED", href: SETTINGS_HREF.plan },
    { name: "khách: AI chưa dùng được là việc của hỗ trợ", input: { aiReady: false }, state: "PREPARING", reason: "AI_PREPARING", href: SUPPORT },
    { name: "nhà: AI chưa dùng được là cần cấu hình", input: { audience: "INTERNAL", aiReady: false }, state: "NEEDS_SETUP", reason: "AI_NOT_READY", href: SETTINGS_HREF.connections },
    { name: "chưa có sản phẩm có giá", input: { hasPricedProducts: false, botEnabled: false }, state: "NEEDS_SETUP", reason: "NO_PRICED_PRODUCTS", href: SETTINGS_HREF.products },
    { name: "chưa nối kênh nào", input: { channels: { fanpage: "OFF", zalo: "OFF", messengerPages: 0, webChat: false }, botEnabled: false }, state: "NEEDS_SETUP", reason: "NO_CHANNEL", href: SETTINGS_HREF.channels },
    { name: "kênh duy nhất hỏng", input: { channels: { fanpage: "BROKEN", zalo: "OFF", messengerPages: 0, webChat: false } }, state: "NEEDS_SETUP", reason: "CHANNEL_BROKEN", href: SETTINGS_HREF.channels },
    { name: "một kênh hỏng, một kênh chạy ⇒ vẫn chạy", input: { channels: { fanpage: "BROKEN", zalo: "ACTIVE", messengerPages: 0, webChat: false } }, state: "RUNNING", reason: "RUNNING", href: SETTINGS_HREF.inbox },
    { name: "Facebook nối thẳng là một kênh", input: { channels: { fanpage: "OFF", zalo: "OFF", messengerPages: 2, webChat: false } }, state: "RUNNING", reason: "RUNNING", href: SETTINGS_HREF.inbox },
    { name: "bot tắt", input: { botEnabled: false }, state: "PAUSED", reason: "BOT_OFF", href: SETTINGS_HREF.botConfig },
    { name: "chế độ quan sát", input: { mode: "OBSERVE" }, state: "PAUSED", reason: "MODE_OBSERVE", href: SETTINGS_HREF.operatingMode },
    { name: "chế độ gợi ý", input: { mode: "COPILOT" }, state: "PAUSED", reason: "MODE_COPILOT", href: SETTINGS_HREF.operatingMode },
    { name: "chế độ quan sát không gác trang chat web", input: { mode: "OBSERVE", channels: { fanpage: "OFF", zalo: "OFF", messengerPages: 0, webChat: true } }, state: "RUNNING", reason: "RUNNING", href: SETTINGS_HREF.inbox },
    // ── CHƯA RÕ: không biết thì không kết luận «Đang chạy» ──
    { name: "không đọc được kênh (người xem không có quyền cấu hình)", input: { channels: null, hasPricedProducts: null }, state: "UNKNOWN", reason: "FACTS_MISSING", href: SETTINGS_HREF.inbox },
    { name: "không đọc được sản phẩm", input: { hasPricedProducts: null }, state: "UNKNOWN", reason: "FACTS_MISSING", href: SETTINGS_HREF.inbox },
    { name: "không kênh nào chạy và còn kênh chưa đọc", input: { channels: { fanpage: "OFF", zalo: null, messengerPages: 0, webChat: false } }, state: "UNKNOWN", reason: "FACTS_MISSING", href: SETTINGS_HREF.inbox },
    { name: "một kênh chạy thì kênh chưa đọc không làm mất kết luận", input: { channels: { fanpage: "ACTIVE", zalo: null, messengerPages: null, webChat: null } }, state: "RUNNING", reason: "RUNNING", href: SETTINGS_HREF.inbox },
    // Dữ kiện ĐÃ BIẾT vẫn thắng dữ kiện chưa biết: bot tắt là tắt, dù không đọc được kênh.
    { name: "bot tắt mà không đọc được kênh", input: { botEnabled: false, channels: null, hasPricedProducts: null }, state: "PAUSED", reason: "BOT_OFF", href: SETTINGS_HREF.botConfig },
  ];
  for (const c of cases) {
    const r = settingsStatus({ ...OK, ...c.input }, { supportHref: SUPPORT });
    assert.deepEqual([r.state, r.reason, r.action?.href ?? null], [c.state, c.reason, c.href], `«${c.name}»: ${JSON.stringify(r)}`);
    assert.ok(r.title.trim() && r.detail.trim() && SETTINGS_STATE_LABEL[r.state], `«${c.name}»: có tiêu đề, câu giải thích và nhãn`);
    if (r.action) assert.ok(r.action.label.trim(), `«${c.name}»: nút có chữ`);
  }
  // Mọi trạng thái đều có mặt trong bảng — thêm trạng thái mới mà quên bài kiểm là đỏ.
  assert.deepEqual([...new Set(cases.map((c) => c.state))].sort(), Object.keys(SETTINGS_STATE_LABEL).sort(), "bảng chân lý phủ đủ sáu trạng thái");

  // Không có dữ kiện nào ⇒ KHÔNG BAO GIỜ «Đang chạy», ở mọi tổ hợp còn lại của dữ kiện đã biết.
  for (const audience of ["CUSTOMER", "INTERNAL"] as const) {
    for (const mode of [null, "AUTOPILOT", "EXPERIMENT"] as const) {
      const r = settingsStatus({ ...OK, audience, mode, channels: null, hasPricedProducts: null });
      assert.notEqual(r.state, "RUNNING", `${audience}/${mode}: thiếu dữ kiện mà kết luận đang chạy`);
    }
  }

  // Nút chính: đường vỏ chặn ⇒ không nút (không nút chết); neo trong trang (#…) luôn được.
  const blocked = settingsStatus({ ...OK, hasPricedProducts: false }, { allows: (h) => h !== SETTINGS_HREF.products });
  assert.equal(blocked.action, null, "vỏ chặn /products ⇒ không dựng nút");
  assert.equal(settingsStatus({ ...OK, botEnabled: false }, { allows: () => false }).action?.href, SETTINGS_HREF.botConfig, "neo trong trang không phụ thuộc quyền mở trang khác");
  assert.equal(settingsStatus({ ...OK, aiReady: false }).action, null, "khách chờ hỗ trợ mà không có địa chỉ hỗ trợ ⇒ không nút");
  // Câu lý do kỹ thuật của AI chỉ dùng cho nhà — khách không bao giờ thấy nó.
  const leak = "429 RESOURCE_EXHAUSTED gemini-x";
  assert.ok(!settingsStatus({ ...OK, aiReady: false, aiReason: leak }).detail.includes(leak), "khách: không in lý do kỹ thuật");
  assert.ok(settingsStatus({ ...OK, audience: "INTERNAL", aiReady: false, aiReason: leak }).detail.includes(leak), "nhà: được xem lý do");

  assert.deepEqual((["NOT_CONFIGURED", "DRAFT", "ACTIVE", "FAILED"] as const).map(channelLinkOf), ["OFF", "OFF", "ACTIVE", "BROKEN"]);
}

/** Từ cấm trong chữ khách thấy ở ô trạng thái / form: tên hãng AI, model, khoá, giá vốn USD, thuật ngữ kỹ thuật. */
const CUSTOMER_FORBIDDEN = /\b(Anthropic|OpenAI|Gemini|Claude|GPT|model|USD|token|prompt|provider|API|ERP|webhook|connector)\b|khoá AI|nhà cung cấp AI|dự phòng/i;

function testSourceContract() {
  // 1. Ô trạng thái + hàm thuần: không một chữ kỹ thuật / tên hãng nào (chúng hiện cho mọi người xem, kể cả khách vỏ).
  for (const f of ["lib/sales-chatbot/settings-status.ts", `${DIR}/settings-status-card.tsx`]) {
    const hits = visibleTexts(read(f)).filter((t) => CUSTOMER_FORBIDDEN.test(t));
    assert.deepEqual(hits, [], `${f}: chữ kỹ thuật / tên hãng AI trong ô trạng thái`);
  }
  // Hàm thuần: không đọc CSDL, không gọi mạng.
  const pure = read("lib/sales-chatbot/settings-status.ts");
  assert.ok(!/from "@\/db"|getDb\(|fetch\(|"server-only"/.test(pure), "settings-status.ts là hàm thuần");

  // 2. Trang: ô trạng thái đứng TRƯỚC lưới khung; MỘT nút chính.
  const page = read(`${DIR}/page.tsx`);
  const iCard = page.indexOf("<SettingsStatusCard status={status}>");
  const iGrid = page.indexOf('<div className="grid grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[minmax(0,1fr)_440px]">');
  assert.ok(iGrid > 0, "lưới khung dùng cột minmax(0,1fr): không có thì mã nhúng ô chat đẩy trang tràn ngang ở 390 px (đo production 10/10: 622 px)");
  assert.ok(iCard > 0 && iCard < iGrid, "ô trạng thái đứng đầu, trước mọi khung");
  assert.ok(/settingsStatus\(\s*\{/.test(page), "trang dựng trạng thái bằng hàm chung, không tự suy");
  assert.equal((read(`${DIR}/settings-status-card.tsx`).match(/data-testid="ai-settings-primary"/g) ?? []).length, 2, "ô trạng thái có ĐÚNG một nút chính (một nhánh liên kết ngoài, một nhánh trong app — loại trừ nhau)");
  assert.ok(page.includes("allows: (href) => shellAllows(user, href)"), "nút chính đi qua cổng của vỏ");
  // Dữ kiện chưa đọc là null, không phải false: kênh chỉ có khi người xem cấu hình được bot.
  assert.ok(page.includes("channels: manage ? {") && page.includes('hasPricedProducts: pricedCheck ? pricedCheck.status === "PASS" : null'), "dữ kiện chưa đọc truyền null");

  // 3. Nhánh KHÁCH không nhận động cơ AI: `engine=` chỉ ở nhánh INTERNAL; chi phí AI chỉ ở nhánh INTERNAL.
  const internalCall = page.match(/ai\.audience === "INTERNAL" \? \(\s*<ChatbotConfigForm([^>]*)\/>\s*\) : \(\s*<ChatbotConfigForm([^>]*)\/>/);
  assert.ok(internalCall, "trang dựng form theo hai nhánh nhà / khách");
  assert.ok(internalCall[1].includes("engine={ai.engine}"), "nhánh nhà nhận engine");
  assert.ok(!/engine=|aiState=|costReport/.test(internalCall[2]), "nhánh khách KHÔNG nhận engine / chi phí");
  assert.ok(page.includes('const costReport = ai.audience === "INTERNAL" ? ai.costReport : null;') && page.includes("{costReport ? <ChatCostPanel report={costReport} /> : null}"), "chi phí AI (USD → ₫) chỉ nhà");
  assert.deepEqual(CHATBOT_ENGINE_FIELDS.filter((k) => k in customerChatbotConfig(DEFAULT_SALES_CHATBOT_CONFIG)), [], "cấu hình gửi cho khách không mang khoá động cơ AI nào");

  // 4. Form: khoá AI / model / dự phòng nằm TRONG khối «Nâng cao» chỉ dựng khi có `engine`; ngoài khối đó không chữ nào lộ.
  const form = read(`${DIR}/config-form.tsx`);
  const adv = form.match(/\{engine && engineCfg \? \(\s*<details[\s\S]*?<\/details>\s*\) : null\}/);
  assert.ok(adv, "khối nâng cao chỉ dựng dưới `engine && engineCfg`");
  assert.equal((form.match(/<AiEngineFields/g) ?? []).length, 1, "ô động cơ AI chỉ có một chỗ");
  assert.ok(adv[0].includes("<AiEngineFields"), "ô động cơ AI nằm trong khối nâng cao");
  const outside = form.replace(adv[0], "");
  const hits = visibleTexts(outside).filter((t) => CUSTOMER_FORBIDDEN.test(t) && !t.includes("field tuỳ biến") && !t.includes("Field không tick") && !t.includes("từ {shell"));
  assert.deepEqual(hits, [], "form ngoài khối nâng cao: không chữ kỹ thuật / tên hãng (chữ «field» / «ERP» chỉ ở nhánh không phải vỏ)");
  assert.ok(!/CUSTOMER_AI_STATE_LABEL|aiState/.test(form), "trạng thái AI của khách không lặp trong form — nằm ở ô đầu trang");
  // Cài đặt nhóm theo câu hỏi của chủ shop.
  for (const g of ["Bot nói thế nào", "Khi nào bot trả lời", "Bán hàng", "Bot được biết và được làm gì"]) assert.ok(form.includes(`title="${g}"`), `nhóm «${g}»`);
  assert.ok(form.includes('id="bot-config"'), "form mang neo #bot-config — các nút «Bật bot» ở nơi khác dẫn tới đây");
  assert.equal((form.match(/data-testid="chatbot-toggle"/g) ?? []).length, 1, "một nút bật / tắt bot, không trùng");
}

export function testAiSalesSettingsV2() {
  testTruthTable();
  testSourceContract();
  console.log("  ✓ AI Sales settings V2: ô trạng thái đầu trang (6 trạng thái, thiếu dữ kiện ⇒ «Chưa rõ», không bao giờ «Đang chạy») · một nút chính qua cổng vỏ · cài đặt nhóm theo câu hỏi chủ shop · khách không nhận / không thấy khoá AI · model · tên hãng · chi phí USD");
}

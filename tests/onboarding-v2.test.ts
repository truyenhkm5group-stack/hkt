/**
 * DANH SÁCH «GIÁ TRỊ ĐẦU TIÊN» CỦA VỎ CHỐT ĐƠN (chủ shop 10/10/2026) — lib/onboarding/go-live-shared.ts · go-live.ts.
 *
 *  · Từng bước đi đủ ba nhánh DONE · NEEDS_ACTION · ERROR từ SỰ THẬT (hàm thuần), và từ dữ liệu THẬT trên PGlite (tổ chức mới,
 *    Pancake GIẢ — luật 65): thiếu chứng cứ thì không bao giờ DONE.
 *  · Nút chính «Tiếp tục thiết lập» dẫn tới bước CHƯA xong đầu tiên mà người xem làm được.
 *  · Xong cả chín bước ⇒ thu lại thành thẻ «Đã sẵn sàng bán».
 *  · Không thuật ngữ kỹ thuật ở mọi câu khách đọc (cùng bộ từ cấm của tests/shell-copy-r3 + màn Kênh kết nối).
 *  · ERP / tổ chức nhà: không đổi (khoá ở mức mã nguồn).
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { invalidateAiControl } from "@/lib/ai-usage/control";
import type { SessionUser } from "@/lib/auth/session";
import { FirstValueChecklist } from "@/components/onboarding/first-value-checklist";
import { CUSTOMER_FORBIDDEN_TERMS } from "@/lib/channels/overview-shared";
import { loadFirstValue, quickConnectFanpage, quickEnableBot, type FirstValueView } from "@/lib/onboarding/go-live";
import { FIRST_VALUE_HREF, FIRST_VALUE_STEPS, firstValueSteps, firstValueSummary, type FirstValueFacts, type FirstValueStep, type FirstValueStepKey } from "@/lib/onboarding/go-live-shared";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { CUSTOMER_AI_STATE_HINT } from "@/lib/saas/visibility";
import { loadSalesChatbotConfig } from "@/lib/sales-chatbot/engine";
import { saveSalesChatbotConfig } from "@/lib/sales-chatbot/settings";
import { SALES_AGENT_INBOX_HREF, SALES_AGENT_OVERVIEW_HREF, salesAgentHomeFor } from "@/lib/constants/saas-nav";
import { firstValueSetupOpen, shellLandingFor } from "@/lib/saas/shell-setup";

const goc = path.resolve(__dirname, "..");
const src = (f: string) => readFileSync(path.join(goc, f), "utf8");

/** Từ cấm trên màn khách: bộ của tests/shell-copy-r3 (vỏ Chốt Đơn) + bộ của màn Kênh kết nối. */
const FORBIDDEN: readonly RegExp[] = [/\bwebhooks?\b/i, /\btokens?\b/i, /\bERP\b/, /\bAPI\b/, /\bTEST\b/, /\bfields?\b/i, /\bconnectors?\b/i, /\bmodules?\b/i, /\bViettel\b/i, /\bORDER_OUTCOME\b/, ...CUSTOMER_FORBIDDEN_TERMS];
const violations = (text: string) => FORBIDDEN.filter((re) => re.test(text.replace(/«[^»]*»/g, "«»"))).map((re) => re.source);

// ─────────────────────────────── HÀM THUẦN ───────────────────────────────

const NONE: FirstValueFacts = {
  channels: { pancake: false, messenger: false, zalo: false, webChat: false },
  channelProblem: null,
  directConnect: false,
  pages: { ready: 0, problem: null, aiOff: 0 },
  products: 0,
  canImportProducts: true,
  pricedVariants: 0,
  stockKnownVariants: 0,
  sellableVariants: 0,
  sellWithoutStockCheck: false,
  policySet: false,
  aiReady: false,
  aiProblem: CUSTOMER_AI_STATE_HINT.NEEDS_SETUP,
  aiFix: "CONFIG",
  configSaved: false,
  botName: "Trợ lý",
  testMessages: 0,
  testReplies: 0,
  testOrders: 0,
  realOrders: 0,
  botEnabled: false,
  published: false,
  canConnect: true,
  canBot: true,
  canPublish: true,
  firstAt: { testMessage: null, testReply: null, testOrder: null },
};
const ALL: FirstValueFacts = {
  ...NONE,
  channels: { pancake: true, messenger: false, zalo: false, webChat: false },
  pages: { ready: 1, problem: null, aiOff: 0 },
  products: 3,
  pricedVariants: 4,
  stockKnownVariants: 4,
  sellableVariants: 2,
  policySet: true,
  aiReady: true,
  aiProblem: null,
  configSaved: true,
  testMessages: 2,
  testReplies: 2,
  testOrders: 1,
  botEnabled: true,
  published: true,
  firstAt: { testMessage: "2026-10-10T01:00:00.000Z", testReply: "2026-10-10T01:00:05.000Z", testOrder: "2026-10-10T01:02:00.000Z" },
};

const of = (f: FirstValueFacts, key: FirstValueStepKey): FirstValueStep => {
  const s = firstValueSteps(f).find((x) => x.key === key);
  assert.ok(s, key);
  return s;
};
const expect = (f: FirstValueFacts, key: FirstValueStepKey, status: FirstValueStep["status"], detail?: RegExp, href?: string | null) => {
  const s = of(f, key);
  assert.equal(s.status, status, `${key}: ${JSON.stringify(s)}`);
  if (detail) assert.match(s.detail, detail, `${key}: ${s.detail}`);
  if (href !== undefined) assert.equal(s.href, href, `${key} href`);
  assert.equal(s.cta, status === "DONE" ? "Xem lại" : status === "ERROR" ? "Sửa ngay" : s.cta);
  return s;
};

function testPureSteps(): FirstValueStep[] {
  const seen: FirstValueStep[] = [];
  const run = (f: FirstValueFacts) => {
    const steps = firstValueSteps(f);
    assert.deepEqual(steps.map((s) => s.key), [...FIRST_VALUE_STEPS], "chín bước, đúng thứ tự");
    seen.push(...steps);
    return steps;
  };

  // Chưa làm gì: mọi bước là việc phải làm; AI chưa dùng được là LỖI kèm lý do thật.
  const none = run(NONE);
  assert.deepEqual(
    none.map((s) => s.status),
    ["NEEDS_ACTION", "NEEDS_ACTION", "NEEDS_ACTION", "NEEDS_ACTION", "ERROR", "NEEDS_ACTION", "NEEDS_ACTION", "NEEDS_ACTION", "NEEDS_ACTION"],
  );
  assert.ok(none.every((s) => s.status !== "DONE"), "không có chứng cứ ⇒ không bước nào xong");
  // Đủ chứng cứ: chín bước xong.
  assert.ok(run(ALL).every((s) => s.status === "DONE"), JSON.stringify(firstValueSteps(ALL).filter((s) => s.status !== "DONE")));

  // 1. Kênh — Pancake là lối chính khi nối thẳng Facebook còn đóng; mở ⇒ màn Kênh kết nối; hỏng ⇒ LỖI kèm lý do; Zalo / chat web cũng tính.
  expect(NONE, "CHANNEL", "NEEDS_ACTION", /Fanpage qua Pancake.*sắp mở/, FIRST_VALUE_HREF.connections);
  expect({ ...NONE, directConnect: true }, "CHANNEL", "NEEDS_ACTION", /Kết nối Facebook/, FIRST_VALUE_HREF.channels);
  run({ ...NONE, directConnect: true });
  const problem = "Lần kiểm tra gần nhất của kết nối qua Pancake không đạt. Mở Cài đặt → Kết nối, dòng «Fanpage qua Pancake», bấm «Kiểm tra».";
  expect({ ...NONE, channelProblem: problem }, "CHANNEL", "ERROR", /không đạt/, FIRST_VALUE_HREF.connections);
  run({ ...NONE, channelProblem: problem });
  expect({ ...NONE, channels: { ...NONE.channels, zalo: true } }, "CHANNEL", "DONE", /Zalo OA/);
  expect({ ...NONE, channels: { ...NONE.channels, webChat: true } }, "CHANNEL", "DONE", /ô chat trên website/);
  expect({ ...NONE, canConnect: false }, "CHANNEL", "NEEDS_ACTION", /chủ cửa hàng/, null);
  run({ ...NONE, canConnect: false, canBot: false, canPublish: false });

  // 2. Page.
  const pancake = { ...NONE, channels: { ...NONE.channels, pancake: true } };
  expect(NONE, "PAGE", "NEEDS_ACTION", /Làm sau/);
  expect({ ...pancake, pages: { ready: 2, problem: null, aiOff: 0 } }, "PAGE", "DONE", /2 Page/);
  expect({ ...pancake, pages: { ready: 0, problem: "Facebook đã ngắt kết nối Page. Bấm «Kết nối lại».", aiOff: 0 } }, "PAGE", "ERROR", /ngắt kết nối/, FIRST_VALUE_HREF.channels);
  run({ ...pancake, pages: { ready: 0, problem: "Facebook đã ngắt kết nối Page. Bấm «Kết nối lại».", aiOff: 0 } });
  expect({ ...pancake, pages: { ready: 0, problem: null, aiOff: 1 } }, "PAGE", "NEEDS_ACTION", /tắt AI/);
  expect(pancake, "PAGE", "NEEDS_ACTION", /Chưa kiểm được/);
  run(pancake);
  expect({ ...NONE, channels: { ...NONE.channels, webChat: true } }, "PAGE", "DONE", /không cần chọn Page/);

  // 3. Sản phẩm.
  expect(NONE, "PRODUCTS", "NEEDS_ACTION", /Excel/, FIRST_VALUE_HREF.productImport);
  expect({ ...NONE, canImportProducts: false }, "PRODUCTS", "NEEDS_ACTION", undefined, FIRST_VALUE_HREF.products);
  expect({ ...NONE, products: null }, "PRODUCTS", "NEEDS_ACTION", /Chưa kiểm được/);
  run({ ...NONE, products: null });
  expect({ ...NONE, products: 5 }, "PRODUCTS", "DONE", /5 sản phẩm/);

  // 4. Giá + tồn + chính sách — nói ra ĐÚNG thứ còn thiếu, dẫn tới màn của thứ thiếu đầu tiên; hết sạch hàng là LỖI.
  const hasProducts = { ...NONE, products: 2 };
  expect(NONE, "PRICE_STOCK_POLICY", "NEEDS_ACTION", /Làm sau/);
  expect(hasProducts, "PRICE_STOCK_POLICY", "NEEDS_ACTION", /giá bán, số tồn.*phí ship/, FIRST_VALUE_HREF.products);
  run(hasProducts);
  expect({ ...hasProducts, pricedVariants: 2 }, "PRICE_STOCK_POLICY", "NEEDS_ACTION", /^Còn thiếu: số tồn/, FIRST_VALUE_HREF.stock);
  expect({ ...hasProducts, pricedVariants: 2, sellableVariants: 1, stockKnownVariants: 1 }, "PRICE_STOCK_POLICY", "NEEDS_ACTION", /^Còn thiếu: phí ship/, FIRST_VALUE_HREF.botConfig);
  expect({ ...hasProducts, pricedVariants: 2, sellWithoutStockCheck: true, policySet: true }, "PRICE_STOCK_POLICY", "DONE", /không kiểm tồn/);
  expect({ ...hasProducts, pricedVariants: 2, stockKnownVariants: 2, sellableVariants: 0, policySet: true }, "PRICE_STOCK_POLICY", "ERROR", /hết hàng/, FIRST_VALUE_HREF.stock);
  run({ ...hasProducts, pricedVariants: 2, stockKnownVariants: 2, sellableVariants: 0 });
  expect({ ...hasProducts, pricedVariants: 2, stockKnownVariants: 2, sellableVariants: 2, policySet: true }, "PRICE_STOCK_POLICY", "DONE", /2 mẫu mã còn hàng/);

  // 5. AI — chưa dùng được ⇒ LỖI kèm câu khách; hết lượt ⇒ dẫn tới Gói dịch vụ; dùng được mà chưa lưu cấu hình ⇒ việc phải làm.
  expect(NONE, "AI_CONFIG", "ERROR", /Bộ phận hỗ trợ/, FIRST_VALUE_HREF.botConfig);
  expect({ ...NONE, aiProblem: CUSTOMER_AI_STATE_HINT.OUT_OF_QUOTA, aiFix: "PLAN" }, "AI_CONFIG", "ERROR", /hết lượt/, FIRST_VALUE_HREF.plan);
  run({ ...NONE, aiProblem: CUSTOMER_AI_STATE_HINT.OUT_OF_QUOTA, aiFix: "PLAN" });
  expect({ ...NONE, aiReady: true, aiProblem: null }, "AI_CONFIG", "NEEDS_ACTION", /Lưu/);
  run({ ...NONE, aiReady: true, aiProblem: null });
  expect({ ...NONE, aiReady: true, aiProblem: null, configSaved: true }, "AI_CONFIG", "DONE", /Trợ lý/);

  // 6–8. Khung thử — tin thử mà AI chưa dùng được ⇒ «AI trả lời thử» là LỖI kèm lý do; mốc đầu tiên đi kèm.
  expect(NONE, "TEST_MESSAGE", "NEEDS_ACTION", /Khung thử/, FIRST_VALUE_HREF.testFrame);
  const sent = { ...NONE, testMessages: 1, firstAt: { ...NONE.firstAt, testMessage: "2026-10-10T01:00:00.000Z" } };
  assert.equal(expect(sent, "TEST_MESSAGE", "DONE").at, "2026-10-10T01:00:00.000Z", "mốc tin thử đầu tiên");
  expect(NONE, "TEST_REPLY", "NEEDS_ACTION", /Làm sau/);
  expect(sent, "TEST_REPLY", "ERROR", /AI chưa trả lời được: Bộ phận hỗ trợ/);
  run(sent);
  expect({ ...sent, aiReady: true, aiProblem: null }, "TEST_REPLY", "NEEDS_ACTION", /chưa trả lời/);
  run({ ...sent, aiReady: true, aiProblem: null });
  expect({ ...sent, testReplies: 1 }, "TEST_REPLY", "DONE");
  expect(NONE, "TEST_ORDER", "NEEDS_ACTION", /đơn nháp/);
  expect({ ...NONE, testOrders: 1 }, "TEST_ORDER", "DONE", /đơn thử/);
  expect({ ...NONE, realOrders: 3 }, "TEST_ORDER", "DONE", /3 đơn/);
  expect({ ...NONE, canBot: false }, "TEST_ORDER", "NEEDS_ACTION", /chủ cửa hàng/, null);

  // 9. Chạy thật — bot bật + có kênh + đã xuất bản (nếu có bước xuất bản).
  expect(NONE, "GO_LIVE", "NEEDS_ACTION", /Lưu và bật bot/, FIRST_VALUE_HREF.botConfig);
  expect({ ...NONE, botEnabled: true }, "GO_LIVE", "NEEDS_ACTION", /chưa có kênh/, FIRST_VALUE_HREF.connections);
  run({ ...NONE, botEnabled: true });
  expect({ ...ALL, published: false }, "GO_LIVE", "NEEDS_ACTION", /bản nháp/, FIRST_VALUE_HREF.publish);
  run({ ...ALL, published: false });
  expect({ ...ALL, published: null }, "GO_LIVE", "DONE", /khách thật/);
  expect({ ...ALL, published: false, canPublish: false }, "GO_LIVE", "NEEDS_ACTION", /chủ cửa hàng/, null);

  // NÚT CHÍNH: bước chưa xong đầu tiên; bỏ qua bước người xem không làm được; xong hết ⇒ thu gọn, không nút.
  assert.equal(firstValueSummary(firstValueSteps(NONE)).next?.key, "CHANNEL");
  assert.equal(firstValueSummary(firstValueSteps({ ...NONE, canConnect: false })).next?.key, "PRODUCTS", "không nối kênh được ⇒ bước làm được đầu tiên");
  const mid = firstValueSummary(firstValueSteps({ ...ALL, testOrders: 0, botEnabled: false }));
  assert.deepEqual([mid.done, mid.total, mid.allDone, mid.next?.key, mid.next?.href], [7, 9, false, "TEST_ORDER", FIRST_VALUE_HREF.testFrame]);
  const done = firstValueSummary(firstValueSteps(ALL));
  assert.deepEqual([done.done, done.total, done.allDone, done.next], [9, 9, true, null]);
  // Bước còn lại chỉ chủ cửa hàng làm được ⇒ không có đích cho nút chính, và câu của bước nói ai làm.
  const ownerOnly = { ...NONE, canConnect: false, canBot: false, canPublish: false, canImportProducts: false, products: 1, pricedVariants: 1, sellWithoutStockCheck: true };
  assert.equal(firstValueSummary(firstValueSteps(ownerOnly)).next, null);
  expect(ownerOnly, "PRICE_STOCK_POLICY", "NEEDS_ACTION", /phí ship.*chủ cửa hàng/, null);
  run(ownerOnly);
  return seen;
}

// ─────────────────────────────── CHỮ KHÁCH ĐỌC ───────────────────────────────

function testCopy(steps: readonly FirstValueStep[]) {
  const texts = [...new Set(steps.flatMap((s) => [s.label, s.detail, s.cta]))];
  assert.ok(texts.length > 40, `quá ít câu được quét (${texts.length})`);
  const bad = texts.map((t) => [t, violations(t)] as const).filter(([, v]) => v.length);
  assert.deepEqual(bad, [], "câu khách đọc không được mang thuật ngữ kỹ thuật");
  // Thành phần vẽ: mọi chuỗi / chữ JSX trong tệp.
  const file = "components/onboarding/first-value-checklist.tsx";
  const sf = ts.createSourceFile(file, src(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const walk = (n: ts.Node) => {
    if (ts.isJsxText(n) && n.text.trim()) found.push(n.text.trim());
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !ts.isImportDeclaration(n.parent)) found.push(n.text);
    if (ts.isTemplateExpression(n)) found.push(n.head.text, ...n.templateSpans.map((s) => s.literal.text));
    ts.forEachChild(n, walk);
  };
  walk(sf);
  assert.ok(found.some((t) => t.includes("Tiếp tục thiết lập")) && found.some((t) => t.includes("Đã sẵn sàng bán")), "bộ quét đọc được chữ của thành phần");
  assert.deepEqual(found.filter((t) => violations(t).length), [], `${file}: không thuật ngữ kỹ thuật`);
  // Đối chứng: bộ lọc THẤY từ cấm.
  assert.ok(violations("Dán URL webhook").length && violations("page access token").length && !violations("Tên mục «Webhook» trong Pancake").length);
}

// ─────────────────────────────── THÀNH PHẦN VẼ ───────────────────────────────

function viewOf(f: FirstValueFacts): FirstValueView {
  const steps = firstValueSteps(f);
  return { show: true, steps, ...firstValueSummary(steps) };
}

function testRender() {
  // `tsx` dựng JSX theo runtime CỔ ĐIỂN (`jsx: preserve` cho Next) ⇒ cần `React` toàn cục ngoài Next — chỉ trong tiến trình kiểm thử.
  (globalThis as { React?: typeof React }).React ??= React;
  const open = renderToStaticMarkup(createElement(FirstValueChecklist, { view: viewOf(NONE) }));
  assert.match(open, /data-first-value="checklist"/);
  assert.match(open, /0\/9/);
  const cta = open.match(/<a [^>]*data-first-value-cta="CHANNEL"[^>]*>/)?.[0] ?? "";
  assert.ok(cta.includes(`href="${FIRST_VALUE_HREF.connections}"`), `nút chính dẫn tới bước chưa xong đầu tiên: ${cta}`);
  assert.equal((open.match(/data-first-value-cta=/g) ?? []).length, 1, "đúng MỘT nút chính");
  assert.equal((open.match(/data-step="/g) ?? []).length, 9, "chín dòng");
  assert.match(open, /data-step="AI_CONFIG" data-status="ERROR"/);
  assert.match(open, /Cần sửa/, "dòng lỗi có nhãn nhìn thấy được");
  assert.ok(open.indexOf("data-first-value-cta") < open.indexOf('data-step="CHANNEL"'), "nút chính đứng TRÊN danh sách (thấy được trên điện thoại mà không cần cuộn)");

  const ready = renderToStaticMarkup(createElement(FirstValueChecklist, { view: viewOf(ALL) }));
  assert.match(ready, /data-first-value="ready"/);
  assert.match(ready, /Đã sẵn sàng bán/);
  assert.doesNotMatch(ready, /data-first-value-cta/, "xong hết ⇒ không còn nút «Tiếp tục thiết lập»");
  assert.match(ready, /<details/, "danh sách thu vào, vẫn mở lại được");

  const nobody = renderToStaticMarkup(createElement(FirstValueChecklist, { view: viewOf({ ...NONE, canConnect: false, canBot: false, canPublish: false, canImportProducts: false, products: null }) }));
  assert.match(nobody, /data-first-value-cta="PRODUCTS"/, "người không có quyền vẫn có việc làm được (mở sản phẩm)");
  assert.equal(renderToStaticMarkup(createElement(FirstValueChecklist, { view: { show: false, steps: [], done: 0, total: 0, allDone: false, next: null } })), "", "không hiện ⇒ không vẽ gì");
}

// ─────────────────────────────── ĐẶT Ở ĐÂU · ERP KHÔNG ĐỔI ───────────────────────────────

function testPlacement() {
  const overview = src("app/(dashboard)/ai/overview/page.tsx");
  assert.match(overview, /isSalesAgentUser\(user\)\s*\?\s*loadFirstValue\(user, now\)/, "Tổng quan: chỉ vỏ Chốt Đơn dựng danh sách");
  assert.match(overview, /<FirstValueChecklist view=\{firstValue\} \/>/);
  assert.match(overview, /r\.measuredSince === null && !setupOpen/, "lời nhắc rải rác cũ nhường cho danh sách");
  const setup = src("app/(dashboard)/setup/page.tsx");
  assert.match(setup, /shell \? loadFirstValue\(user\)/, "Thiết lập: vỏ dùng đúng danh sách chín bước");
  assert.match(setup, /title="Việc cần làm"/, "Thiết lập: tổ chức ERP giữ danh sách cũ");
  // Trang chủ `/`: nhà giữ nguyên từng khối, tổ chức ERP khách giữ «Bắt đầu» cũ; người vỏ không bao giờ tới `/` (cổng vỏ chuyển về hộp thư).
  const home = src("app/(dashboard)/page.tsx");
  assert.match(home, /if \(user\.organization && !user\.organization\.isHome\) return <GettingStartedHome user=\{user\} \/>;/);
  assert.ok(!home.includes("FirstValueChecklist"), "trang chủ ERP không đổi");
  // Neo của từng màn có thật.
  assert.ok(src("app/(dashboard)/ai/sales-chatbot/page.tsx").includes('id="khung-thu"'), "neo Khung thử");
  assert.ok(src("app/(dashboard)/ai/sales-chatbot/config-form.tsx").includes('id="bot-config"'), "neo Cấu hình bot");
}

// ─────────────────────────────── TRANG NHÀ SAU ĐĂNG NHẬP (chủ shop 10/10/2026) ───────────────────────────────

function testLandingPure() {
  const owner = { role: "ADMIN", permissions: [] as string[] };
  // Chưa xong ⇒ «Tổng quan» (nơi đứng danh sách); xong ⇒ hộp thư như #638; không truyền gì ⇒ y như cũ.
  assert.equal(salesAgentHomeFor(owner, { setupOpen: true }), SALES_AGENT_OVERVIEW_HREF);
  assert.equal(salesAgentHomeFor(owner, { setupOpen: false }), SALES_AGENT_INBOX_HREF);
  assert.equal(salesAgentHomeFor(owner), SALES_AGENT_INBOX_HREF);
  // Người không thấy «Tổng quan» không bao giờ bị đưa tới đó (trang ấy sẽ đá họ về — vòng chuyển hướng).
  const kho = { role: "VIEWER", permissions: ["products:view"] };
  assert.equal(salesAgentHomeFor(kho, { setupOpen: true }), salesAgentHomeFor(kho));
  assert.deepEqual([firstValueSetupOpen(null), firstValueSetupOpen({ show: false, allDone: false }), firstValueSetupOpen({ show: true, allDone: true }), firstValueSetupOpen({ show: true, allDone: false })], [false, false, false, true]);
  // Chỉ HAI cửa vào hỏi trạng thái thiết lập: sau đăng nhập (shellHomeOfSession) và mở `/` (requireUser, đích không kèm «ngoài gói»).
  assert.match(src("lib/saas/shell-landing.ts"), /isSalesAgentUser\(ket\.user\) \? shellLandingFor\(ket\.user\)/);
  assert.match(src("lib/saas/shell-landing.ts"), /ket\.shellUser \? shellLandingFor\(ket\.shellUser\)/);
  assert.match(src("lib/auth/session.ts"), /ket\.shellUser && ket\.home && !ket\.home\.includes\("\?"\) \? await shellLandingFor\(ket\.shellUser\)/);
  assert.equal((src("lib/auth/session.ts").match(/shellLandingFor\(/g) ?? []).length, 1, "session.ts hỏi đúng một chỗ (cửa `/`), không ở mỗi lượt điều hướng");
  assert.ok(!["@/lib/onboarding", "@/lib/saas/shell-setup", "@/lib/auth/session"].some((m) => src("lib/constants/saas-nav.ts").includes(`from "${m}`)), "saas-nav.ts vẫn thuần (không nạp mã máy chủ)");
}

// ─────────────────────────────── DỮ LIỆU THẬT (PGlite) ───────────────────────────────

const ORG = "fv-shop";
const PAGE = "5566778899";
const TOKEN = "pancake_page_token_fv_0123456789";
const ENV_KEYS = ["PLATFORM_SECRETS_KEY", "PLATFORM_AI_ENABLED", "PLATFORM_AI_API_KEY", "PLATFORM_AI_PROVIDER", "PLATFORM_AI_MODEL"] as const;

function fakePancake(ok: boolean): typeof fetch {
  return (async () => new Response(JSON.stringify(ok ? { success: true, conversations: [] } : { success: false, message: "Hết hạn" }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
}

async function cleanup() {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, ORG) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, ORG));
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  invalidateOrganizations();
  invalidateCapabilities();
  invalidateAiControl();
}

const statuses = (v: FirstValueView) => Object.fromEntries(v.steps.map((s) => [s.key, s.status])) as Record<FirstValueStepKey, FirstValueStep["status"]>;
const stepOf = (v: FirstValueView, k: FirstValueStepKey) => v.steps.find((s) => s.key === k)!;

async function testRealData() {
  await cleanup();
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.PLATFORM_SECRETS_KEY = "khoa-kiem-thu-gia-tri-dau-tien-0123456789abcdefghijklmnopqrstuvwxyz";
  for (const k of ENV_KEYS.slice(1)) delete process.env[k];
  try {
    await provisionOrganization({ code: ORG, name: "Giá trị đầu tiên", plan: "starter", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "GiaTri@12345" }, source: "TEST", actor: null });
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const modules = [...(await getEnabledModules(ORG))];
      const admin: SessionUser = { id: u.id, email: u.email, name: "QT", role: "ADMIN", permissions: ["settings:manage", "ai_sales:manage"], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: "Giá trị đầu tiên", isHome: false }, modules };
      const staff: SessionUser = { ...admin, id: "fv-staff", role: "VIEWER", permissions: ["ai_sales:view"] };

      // Tổ chức mới: không bước nào xong; AI chưa dùng được là LỖI kèm câu khách; nút chính ⇒ nối Fanpage qua Pancake.
      const v0 = await loadFirstValue(admin);
      assert.ok(v0.show && v0.total === 9 && v0.done === 0 && !v0.allDone, JSON.stringify(statuses(v0)));
      assert.deepEqual(statuses(v0), { CHANNEL: "NEEDS_ACTION", PAGE: "NEEDS_ACTION", PRODUCTS: "NEEDS_ACTION", PRICE_STOCK_POLICY: "NEEDS_ACTION", AI_CONFIG: "ERROR", TEST_MESSAGE: "NEEDS_ACTION", TEST_REPLY: "NEEDS_ACTION", TEST_ORDER: "NEEDS_ACTION", GO_LIVE: "NEEDS_ACTION" });
      assert.equal(stepOf(v0, "AI_CONFIG").detail, CUSTOMER_AI_STATE_HINT.NEEDS_SETUP);
      assert.deepEqual([v0.next?.key, v0.next?.href], ["CHANNEL", FIRST_VALUE_HREF.connections], "nối thẳng Facebook còn đóng ⇒ lối Pancake");
      assert.equal((await loadFirstValue(staff)).show, false, "nhân viên chỉ xem không thấy danh sách thiết lập");
      // Trang nhà: chủ shop cửa hàng mới ⇒ «Tổng quan»; nhân viên không thấy danh sách ⇒ hộp thư.
      assert.equal(await shellLandingFor(admin, { cacheMs: 0 }), SALES_AGENT_OVERVIEW_HREF, "chưa thiết lập xong ⇒ «Tổng quan»");
      assert.equal(await shellLandingFor(staff, { cacheMs: 0 }), SALES_AGENT_INBOX_HREF, "nhân viên ⇒ hộp thư như cũ");

      // Kiểm tra kết nối HỎNG ⇒ «Kết nối Facebook» là LỖI, lý do là câu khách của màn Kênh kết nối.
      await quickConnectFanpage(admin, { pageId: PAGE, pageAccessToken: TOKEN }, { tester: { fetch: fakePancake(false) } });
      const v1 = await loadFirstValue(admin);
      assert.equal(stepOf(v1, "CHANNEL").status, "ERROR", JSON.stringify(stepOf(v1, "CHANNEL")));
      assert.match(stepOf(v1, "CHANNEL").detail, /không đạt/);
      assert.deepEqual(violations(stepOf(v1, "CHANNEL").detail), []);

      // Kiểm tra ĐẠT ⇒ kênh + Page xong.
      assert.ok("ok" in (await quickConnectFanpage(admin, { pageId: PAGE, pageAccessToken: TOKEN }, { tester: { fetch: fakePancake(true) } })));
      const v2 = await loadFirstValue(admin);
      assert.deepEqual([stepOf(v2, "CHANNEL").status, stepOf(v2, "PAGE").status], ["DONE", "DONE"], JSON.stringify(v2.steps.slice(0, 2)));
      assert.match(stepOf(v2, "CHANNEL").detail, /Fanpage qua Pancake/);
      assert.equal(v2.next?.key, "PRODUCTS");

      // Sản phẩm có giá nhưng chưa phiếu nhập, chưa phí ship ⇒ nói đúng hai thứ còn thiếu.
      const [p] = await db.insert(schema.products).values({ id: "fv-p1", name: "Tôm hùm", raw: { origin: "ERP_MANUAL" } }).returning({ id: schema.products.id });
      await db.insert(schema.productVariants).values({ id: "fv-v1", productId: p.id, sku: "TH-1KG", retailPrice: 650_000 });
      const v3 = await loadFirstValue(admin);
      assert.equal(stepOf(v3, "PRODUCTS").status, "DONE");
      assert.equal(stepOf(v3, "PRICE_STOCK_POLICY").status, "NEEDS_ACTION");
      assert.match(stepOf(v3, "PRICE_STOCK_POLICY").detail, /^Còn thiếu: số tồn \(lập phiếu nhập hàng\), phí ship/);
      assert.equal(stepOf(v3, "PRICE_STOCK_POLICY").href, FIRST_VALUE_HREF.stock);

      // Có phiếu nhập mà xuất tay hết ⇒ tồn BIẾT được và bằng 0 ⇒ LỖI «hết hàng» (công thức sổ kho, không đếm phiếu).
      const receipt = async (kind: "RECEIPT" | "ISSUE", qty: number) => {
        const [r] = await db.insert(schema.stockReceipts).values({ kind, receivedAt: new Date(), reference: `fv-${kind}-${qty}`, totalQuantity: qty, totalCost: 0, createdBy: "test" }).returning({ id: schema.stockReceipts.id });
        await db.insert(schema.stockReceiptItems).values({ receiptId: r.id, variantId: "fv-v1", quantity: qty, unitCost: 0 });
      };
      await receipt("RECEIPT", 2);
      await receipt("ISSUE", -2);
      const v4 = await loadFirstValue(admin);
      assert.equal(stepOf(v4, "PRICE_STOCK_POLICY").status, "ERROR", JSON.stringify(stepOf(v4, "PRICE_STOCK_POLICY")));
      assert.match(stepOf(v4, "PRICE_STOCK_POLICY").detail, /hết hàng/);
      await receipt("RECEIPT", 5);
      // Phí ship khai qua ĐÚNG đường lưu cấu hình ⇒ chính sách xong và cấu hình đã lưu.
      const saveCfg = await saveSalesChatbotConfig(admin, { ...(await loadSalesChatbotConfig()), shippingFee: 30_000 });
      assert.ok(saveCfg.ok, JSON.stringify(saveCfg));
      const v5 = await loadFirstValue(admin);
      assert.equal(stepOf(v5, "PRICE_STOCK_POLICY").status, "DONE", JSON.stringify(stepOf(v5, "PRICE_STOCK_POLICY")));
      assert.match(stepOf(v5, "PRICE_STOCK_POLICY").detail, /1 mẫu mã còn hàng/);
      assert.equal(stepOf(v5, "AI_CONFIG").status, "ERROR", "cấu hình đã lưu nhưng AI chưa dùng được ⇒ vẫn LỖI");

      // Khung thử: khách nhắn thử khi AI chưa dùng được ⇒ «AI trả lời thử» là LỖI kèm lý do.
      const [conv] = await db.insert(schema.salesChatConversations).values({ channel: "TEST" }).returning({ id: schema.salesChatConversations.id });
      const t0 = new Date(Date.now() - 60_000);
      const event = (type: string, actorKind: string, at: Date, key: string) => db.insert(schema.salesConversationEvents).values({ conversationId: conv.id, cycle: 0, type, actorKind, channel: "TEST", occurredAt: at, dedupeKey: key });
      await event("message.received", "CUSTOMER", t0, "fv:msg:1");
      const v6 = await loadFirstValue(admin);
      assert.equal(stepOf(v6, "TEST_MESSAGE").status, "DONE");
      assert.equal(stepOf(v6, "TEST_MESSAGE").at, t0.toISOString(), "mốc tin thử đầu tiên đọc từ sổ sự kiện");
      assert.equal(stepOf(v6, "TEST_REPLY").status, "ERROR");

      // AI dùng được (nền tảng bật) ⇒ AI xong; tin trả lời của AI + đơn nháp thử ⇒ hai bước thử xong. Tin trả lời của NGƯỜI không tính.
      process.env.PLATFORM_AI_ENABLED = "1";
      process.env.PLATFORM_AI_API_KEY = "khoa-ai-nen-tang-gia-fv";
      process.env.PLATFORM_AI_PROVIDER = "gemini";
      await event("ai.replied", "SYSTEM", new Date(t0.getTime() + 1_000), "fv:reply:sys");
      const v7 = await loadFirstValue(admin);
      assert.deepEqual([stepOf(v7, "AI_CONFIG").status, stepOf(v7, "TEST_REPLY").status], ["DONE", "NEEDS_ACTION"], JSON.stringify(v7.steps.slice(4, 7)));
      await event("ai.replied", "AI", new Date(t0.getTime() + 5_000), "fv:reply:1");
      await event("order.drafted", "AI", new Date(t0.getTime() + 30_000), "fv:draft:1");
      const v8 = await loadFirstValue(admin);
      assert.deepEqual([stepOf(v8, "TEST_REPLY").status, stepOf(v8, "TEST_ORDER").status], ["DONE", "DONE"]);
      assert.equal(v8.next?.key, "GO_LIVE");

      // Bật bot qua đúng lõi; còn bản nháp ⇒ việc «Xuất bản»; xuất bản ⇒ đủ chín bước ⇒ thu gọn.
      // Cửa hàng tự đăng ký bắt đầu ở BẢN NHÁP (tổ chức cấp tay ở đây không có bước xuất bản ⇒ đặt nháp để đi đủ nhánh).
      const pdb = await getPlatformDb();
      await pdb.update(schema.platformOrganizations).set({ publishState: "DRAFT" }).where(eq(schema.platformOrganizations.code, ORG));
      invalidateOrganizations();
      assert.ok("ok" in (await quickEnableBot(admin)));
      const v9 = await loadFirstValue(admin);
      assert.deepEqual([stepOf(v9, "GO_LIVE").status, stepOf(v9, "GO_LIVE").href], ["NEEDS_ACTION", FIRST_VALUE_HREF.publish], JSON.stringify(stepOf(v9, "GO_LIVE")));
      assert.equal(v9.next?.key, "GO_LIVE");
      await pdb.update(schema.platformOrganizations).set({ publishState: "PUBLISHED", publishedAt: new Date() }).where(eq(schema.platformOrganizations.code, ORG));
      invalidateOrganizations();
      const v10 = await loadFirstValue(admin);
      assert.ok(v10.allDone && v10.done === 9 && v10.next === null, JSON.stringify(v10.steps.filter((s) => s.status !== "DONE")));
      assert.equal(await shellLandingFor(admin, { cacheMs: 0 }), SALES_AGENT_INBOX_HREF, "đủ chín bước ⇒ hộp thư như #638");
      const html = renderToStaticMarkup(createElement(FirstValueChecklist, { view: v10 }));
      assert.match(html, /Đã sẵn sàng bán/);
    });
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await cleanup();
  }
}

export async function testOnboardingV2() {
  const seen = testPureSteps();
  testCopy(seen);
  testRender();
  testPlacement();
  testLandingPure();
  await testRealData();
  console.log(
    "✓ Thiết lập giá trị đầu tiên (vỏ Chốt Đơn): chín bước MỘT danh sách — mỗi bước đủ ba nhánh xong / cần làm / cần sửa từ dữ liệu thật (kiểm tra kết nối hỏng · hết hàng theo sổ kho · AI chưa dùng được), không bước nào xong khi thiếu chứng cứ; nút «Tiếp tục thiết lập» tới bước chưa xong đầu tiên người xem làm được; đủ chín ⇒ thẻ «Đã sẵn sàng bán»; sau đăng nhập / mở «/»: chưa xong ⇒ «Tổng quan», xong ⇒ hộp thư; không thuật ngữ kỹ thuật; trang chủ ERP không đổi",
  );
}

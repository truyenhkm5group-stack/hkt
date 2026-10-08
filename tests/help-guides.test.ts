/**
 * ═══════════ HƯỚNG DẪN SỬ DỤNG KHÔNG ĐƯỢC NÓI SAI VỀ MÀN HÌNH (lib/constants/help-guides.ts) ═══════════
 *
 * Một bài hướng dẫn chỉ tới nút không còn tồn tại tệ hơn không có bài: khách làm theo, không thấy, gọi hỗ trợ. Khoá ở
 * mức mã nguồn:
 *  1. Mọi đường dẫn (của bài và từng bước) trỏ tới một `app/(dashboard)/…/page.tsx` CÓ THẬT.
 *  2. Quyền khai ở bài TRÙNG quyền mà chính trang chính đòi (`requirePermission("…")` / `requireResource(…, "…")`, hoặc một hằng
 *     quyền import vào trang); trang chỉ `requireUser()` thì bài không được khai quyền.
 *  3. Mọi tên nút / tên ô đặt trong «…» xuất hiện NGUYÊN VĂN trong mã đã vào kho (app/ + components/ + nhãn ở
 *     lib/constants/ + nhãn bảng «AI đã sẵn sàng…»), trừ chính sổ hướng dẫn.
 *  4. Lọc hiển thị: thiếu quyền / module tắt / bài của tổ chức khách ở tổ chức nhà ⇒ ẩn.
 *  4b. VỎ CHỐT ĐƠN (docs/saas/HELP_CENTER.md §4–§6) — câu người trong vỏ THẤY (bài `CHOTDON` + `ALL` qua `helpStepText(…, true)`,
 *     câu hỏi thường gặp `CHOTDON` + `ALL`): không thuật ngữ cấm của §6; không đường menu vỏ không có («Hệ thống → …», «Cài đặt →
 *     X» với X không phải một mục của trang Cài đặt vỏ); link của từng bước mở được với ĐÚNG quyền bài đòi; mỗi mục menu vỏ có
 *     bài trỏ ĐÚNG href của nó; tiêu đề chủ đề AI = tên mục menu; nhãn bảng «AI đã sẵn sàng…» khẳng định thẳng, và bài / câu hỏi
 *     gọi đúng nhãn đó; bảng ấy khách thấy không mang «ERP» / tên ứng dụng nhắn tin / thuật ngữ cấm.
 *  5. Có lối vào: menu tài khoản trỏ `/help`, và `/help` thuộc lõi (mọi tổ chức).
 *  6. Hạn giữ dữ liệu: không bài nào hứa «không dữ liệu nào bị xoá»; bài gói đọc đúng cam kết của Điều khoản.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { PERMISSION_GROUPS } from "@/lib/auth/permissions";
import { SERVICE_COMMITMENTS } from "@/lib/constants/company";
import { HELP_FAQ, HELP_GUIDES, HELP_TOPIC_LABEL, HELP_TOPIC_ORDER, helpAudienceMatches, helpGuideVisible, helpStepText, helpTopicLabel } from "@/lib/constants/help-guides";
import { moduleOfPath } from "@/lib/constants/platform-modules";
import { SALES_AGENT_NAV, salesAgentPathAllowed } from "@/lib/constants/saas-nav";
import { CUSTOMER_AI_SOFT_LIMIT_NOTICE, CUSTOMER_AI_STATE_HINT, CUSTOMER_AI_STATE_LABEL, customerReadinessChecks, type CustomerAiState } from "@/lib/saas/visibility";
import { assessReadiness, READINESS_STATUS_LABEL, readinessVerdict, type ReadinessInput } from "@/lib/sales-chatbot/readiness-shared";

function pageFileOf(href: string): string {
  const path = href.split(/[?#]/)[0];
  return path === "/" ? "app/(dashboard)/page.tsx" : `app/(dashboard)${path}/page.tsx`;
}

/**
 * Khoá quyền trang đòi ở cổng đầu: chuỗi viết thẳng, hoặc một HẰNG import vào trang (`requirePermission(CONNECTIONS_PERMISSION)`)
 * — đọc đúng giá trị khai ở tệp nguồn của hằng, không chép con số thứ hai vào bài kiểm.
 */
function pagePermissions(href: string): string[] {
  const src = readFileSync(pageFileOf(href), "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/(?:requirePermission\(|requireResource\("[A-Z_]+",\s*)(?:"([^"]+)"|([A-Z][A-Z0-9_]*))\)/g)) {
    if (m[1]) {
      out.push(m[1]);
      continue;
    }
    // `@\/` (không phải `@/` liền) để bộ quét import của repo-integrity không đọc mẫu này thành một lệnh import.
    const imp = new RegExp(`import \\{[^}]*\\b${m[2]}\\b[^}]*\\} from "@\\/([^"]+)"`).exec(src);
    assert.ok(imp, `${href}: không tìm thấy nơi import ${m[2]}`);
    const decl = new RegExp(`export const ${m[2]} = "([^"]+)"`).exec(readFileSync(`${imp[1]}.ts`, "utf8"));
    assert.ok(decl, `${href}: ${m[2]} không phải một chuỗi khai thẳng ở ${imp[1]}.ts`);
    out.push(decl[1]);
  }
  return out;
}

export function testHelpGuides() {
  const keys = HELP_GUIDES.map((g) => g.key);
  assert.equal(new Set(keys).size, keys.length, "khoá bài không trùng");
  for (const g of HELP_GUIDES) assert.ok(HELP_TOPIC_ORDER.includes(g.topic) && HELP_TOPIC_LABEL[g.topic], `${g.key}: chủ đề lạ`);
  const known = new Set<string>(PERMISSION_GROUPS.flatMap((gr) => gr.items.map((i) => i.key)));

  // 1 + 2: đường dẫn có thật, quyền khớp trang.
  for (const g of HELP_GUIDES) {
    for (const href of [g.href, ...g.steps.flatMap((s) => (s.href ? [s.href] : []))]) {
      assert.ok(existsSync(pageFileOf(href)), `${g.key}: không có trang ${href} (${pageFileOf(href)})`);
    }
    const required = pagePermissions(g.href);
    if (g.permission) {
      assert.ok(known.has(g.permission), `${g.key}: khoá quyền lạ ${g.permission}`);
      assert.ok(required.includes(g.permission), `${g.key}: trang ${g.href} đòi ${JSON.stringify(required)}, bài khai ${g.permission}`);
    } else {
      assert.deepEqual(required, [], `${g.key}: trang ${g.href} đòi quyền ${JSON.stringify(required)} mà bài không khai — bài sẽ hiện cho người không vào được`);
    }
    for (const p of g.alsoRequires ?? []) assert.ok(known.has(p), `${g.key}: khoá quyền lạ ${p}`);
  }

  // 3: tên nút trong «…» có thật trong mã giao diện đã vào kho. Nhãn của bảng «AI đã sẵn sàng…» sống ở
  // lib/sales-chatbot/readiness-shared.ts (nguồn nhãn của trang AI Sales) — đưa vào đích danh, không mở cả lib/sales-chatbot.
  const ui = execFileSync("git", ["ls-files", "app", "components", "lib/constants", "lib/sales-chatbot/readiness-shared.ts"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.tsx?$/.test(f) && f !== "lib/constants/help-guides.ts")
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  const texts = [...HELP_GUIDES.flatMap((g) => [g.summary, ...g.steps.flatMap((s) => [s.text, ...(s.shellText ? [s.shellText] : [])])]), ...HELP_FAQ.flatMap((f) => [f.q, f.a])];
  for (const t of texts) {
    for (const m of t.matchAll(/«([^»]+)»/g)) assert.ok(ui.includes(m[1]), `nút «${m[1]}» không có trong app/, components/ hay lib/constants/ — bài hướng dẫn đã cũ`);
  }

  // 4: lọc hiển thị.
  const all = () => true;
  const tenant = { modules: undefined, isHome: false };
  const price = HELP_GUIDES.find((g) => g.key === "price-lists")!;
  const appt = HELP_GUIDES.find((g) => g.key === "appointments")!;
  const profile = HELP_GUIDES.find((g) => g.key === "my-account")!;
  assert.equal(helpGuideVisible(price, tenant, all), true);
  assert.equal(helpGuideVisible(price, { modules: undefined, isHome: true }, all), false, "bài của tổ chức khách ẩn ở nhà");
  assert.equal(helpGuideVisible(price, tenant, () => false), false, "thiếu quyền ⇒ ẩn");
  assert.equal(helpGuideVisible(appt, { modules: ["core", "customers", "products", "orders"], isHome: false }, all), false, "module tắt ⇒ ẩn");
  assert.equal(helpGuideVisible(appt, { modules: ["core", "customers", "appointments"], isHome: false }, all), true);
  assert.equal(helpGuideVisible(profile, { modules: ["core"], isHome: false }, () => false), true, "bài không khai quyền, trang lõi ⇒ ai cũng thấy");

  // 4b: VỎ CHỐT ĐƠN — bài `CHOTDON` / `ALL` không dẫn vào trang vỏ chặn; bài `ERP` (mặc định) ẩn trong vỏ; câu hỏi thường gặp
  // lọc cùng luật.
  const shellViewer = { modules: undefined, isHome: false, shell: true };
  for (const g of HELP_GUIDES) {
    const hrefs = [g.href, ...g.steps.flatMap((s) => (s.href ? [s.href] : []))];
    if (g.audience === "CHOTDON" || g.audience === "ALL") assert.ok(hrefs.every(salesAgentPathAllowed), `${g.key}: bài cho vỏ dẫn vào trang vỏ chặn: ${hrefs.filter((h) => !salesAgentPathAllowed(h)).join(", ")}`);
    const visibleInShell = helpGuideVisible(g, shellViewer, all);
    if ((g.audience ?? "ERP") === "ERP") assert.equal(visibleInShell, false, `${g.key}: bài ERP phải ẩn trong vỏ`);
    else assert.equal(visibleInShell, true, `${g.key}: bài cho vỏ phải hiện trong vỏ`);
    if (g.audience === "CHOTDON") assert.equal(helpGuideVisible(g, tenant, all), false, `${g.key}: bài vỏ không hiện ngoài vỏ`);
    // Câu riêng cho vỏ chỉ có nghĩa ở bài hiện CẢ HAI phía; bài CHOTDON viết thẳng bằng chữ của vỏ.
    for (const s of g.steps) if (s.shellText) assert.equal(g.audience, "ALL", `${g.key}: chỉ bài ALL mới cần câu riêng cho vỏ`);
  }
  const shellGuides = HELP_GUIDES.filter((g) => helpGuideVisible(g, shellViewer, all));
  const shellFaq = HELP_FAQ.filter((f) => helpAudienceMatches(f.audience, true));
  assert.ok(shellFaq.length > 0 && HELP_FAQ.some((f) => helpAudienceMatches(f.audience, false)), "câu hỏi thường gặp có ở cả hai phía");
  /** MỌI câu người trong vỏ đọc được trên /help: bài (tiêu đề · tóm tắt · bước theo vỏ) + câu hỏi thường gặp — kể cả bài `ALL`. */
  const shellTexts: [string, string][] = [
    ...shellGuides.flatMap((g) => [g.title, g.summary, ...g.steps.map((s) => helpStepText(s, true))].map((t): [string, string] => [g.key, t])),
    ...shellFaq.flatMap((f) => [f.q, f.a].map((t): [string, string] => [`câu hỏi «${f.q}»`, t])),
  ];
  // HELP_CENTER §6 — cột trái của bảng thuật ngữ là danh sách cấm (cộng «API»): người ít rành công nghệ không đọc được chúng.
  const FORBIDDEN = /\bERP\b|module|webhook|token|workspace|connector|Page ID|App Secret|BYOK|\bUSD\b|\bField\b|\bTEST\b|Hỏng|\bAPI\b/i;
  for (const [who, t] of shellTexts) assert.ok(!FORBIDDEN.test(t), `${who}: câu trong vỏ dùng thuật ngữ cấm «${t.match(FORBIDDEN)?.[0]}» (HELP_CENTER §6): ${t}`);
  // Đường menu phải là đường CÓ trong vỏ: vỏ không có nhóm «Hệ thống»; «Cài đặt → X» thì X là một mục của trang Cài đặt vỏ.
  const settingsEntries = [...readFileSync(pageFileOf("/settings/shop"), "utf8").matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(settingsEntries.includes("Xuất dữ liệu") && settingsEntries.includes("Tài khoản của tôi"), `đọc hụt mục của trang Cài đặt vỏ: ${settingsEntries.join(", ")}`);
  for (const [who, t] of shellTexts) {
    assert.ok(!/Hệ thống\s*→/.test(t), `${who}: vỏ không có menu «Hệ thống» — ${t}`);
    for (const m of t.matchAll(/Cài đặt\s*→\s*«?([^»,.;]+)/g)) {
      assert.ok(settingsEntries.some((l) => m[1].trim().startsWith(l)), `${who}: trang Cài đặt của vỏ không có mục «${m[1].trim()}» (có: ${settingsEntries.join(" · ")}) — ${t}`);
    }
  }
  // Link của từng bước mở được với ĐÚNG quyền bài đòi — người thấy bài không bị trang đích đá ra.
  for (const g of shellGuides) {
    const held = new Set<string>([...(g.permission ? [g.permission] : []), ...(g.alsoRequires ?? [])]);
    for (const s of g.steps) {
      if (!s.href) continue;
      const need = pagePermissions(s.href);
      assert.ok(need.every((p) => held.has(p)), `${g.key}: bước dẫn tới ${s.href} đòi ${JSON.stringify(need)}, bài chỉ đòi ${JSON.stringify([...held])}`);
    }
  }
  // Mỗi mục menu của vỏ có bài trỏ ĐÚNG trang của nó (không tính trang con: bài Hội thoại không được «phủ» hộ mục AI Sales).
  for (const item of SALES_AGENT_NAV.filter((i) => i.key !== "settings" && i.key !== "overview")) {
    assert.ok(shellGuides.some((g) => g.href === item.href || g.steps.some((s) => s.href === item.href)), `mục vỏ «${item.label}» (${item.href}) chưa có bài hướng dẫn nào trỏ đúng trang của nó`);
  }
  // Bài nối Facebook: «Cài đặt → Kết nối» không có trong vỏ ⇒ dẫn THẲNG tới trang (vỏ mở được), và chỉ cho người nối được kênh.
  const fb = HELP_GUIDES.find((g) => g.key === "chotdon-connect-facebook")!;
  assert.ok(fb.steps.some((s) => s.href === "/settings/connections") && salesAgentPathAllowed("/settings/connections"), "bài nối Facebook dẫn thẳng tới trang Kết nối");
  assert.ok(fb.alsoRequires?.includes("settings:manage") && helpGuideVisible(fb, shellViewer, (p) => p !== "settings:manage") === false, "thiếu quyền nối kênh ⇒ bài nối kênh ẩn");
  // Bài ALL: ngoài vỏ giữ đường menu ERP, trong vỏ đổi sang đường của vỏ.
  const exportStep = HELP_GUIDES.find((g) => g.key === "data-export")!.steps[0];
  assert.equal(helpStepText(exportStep, false), "Mở Hệ thống → Xuất dữ liệu.", "ngoài vỏ: đường menu ERP như cũ");
  assert.equal(helpStepText(exportStep, true), "Mở Cài đặt → «Xuất dữ liệu».", "trong vỏ: đường menu của vỏ");
  assert.ok(helpStepText(profile.steps[0], true).startsWith("Mở Cài đặt →") && !/góc trên/.test(helpStepText(profile.steps[0], true)), "trong vỏ không tả vị trí ảnh đại diện (thanh bên máy tính ≠ thanh trên điện thoại)");
  // Tiêu đề chủ đề AI trong vỏ = ĐÚNG tên mục menu; ngoài vỏ giữ nhãn cũ; /help đọc qua hai hàm theo vỏ.
  const aiNav = SALES_AGENT_NAV.find((i) => i.key === "ai")!;
  assert.equal(aiNav.label, "AI Sales");
  assert.equal(helpTopicLabel("AI", true), aiNav.label, "chủ đề AI trong vỏ mang tên mục menu");
  assert.equal(helpTopicLabel("AI", false), HELP_TOPIC_LABEL.AI, "ngoài vỏ: nhãn cũ");
  for (const t of HELP_TOPIC_ORDER) if (t !== "AI") assert.equal(helpTopicLabel(t, true), HELP_TOPIC_LABEL[t]);
  const helpSrc = readFileSync("app/(dashboard)/help/page.tsx", "utf8");
  assert.ok(helpSrc.includes("helpTopicLabel(topic, shell)") && helpSrc.includes("helpStepText(s, shell)") && !helpSrc.includes("HELP_TOPIC_LABEL["), "/help đọc tiêu đề chủ đề và câu từng bước qua hàm theo vỏ");
  assert.ok(helpSrc.includes("COMPANY.zaloHref"), "/help có tầng liên hệ (Zalo) đọc từ lib/constants/company.ts");

  // Nhãn bảng «AI đã sẵn sàng…» — khẳng định thẳng (không dựa vào một chú thích có cùng chữ), và bài / câu hỏi gọi đúng nhãn.
  assert.equal(READINESS_STATUS_LABEL.FAIL, "Cần làm", "việc chưa làm gọi là «Cần làm», không «Hỏng» (HELP_CENTER §6)");
  assert.equal(READINESS_STATUS_LABEL.PENDING, "Đang chuẩn bị", "việc đội hỗ trợ đang làm không giao cho khách");
  assert.equal(READINESS_STATUS_LABEL.WARN, "Nên làm");
  assert.equal(READINESS_STATUS_LABEL.PASS, "Xong");
  const aiGuideStep = HELP_GUIDES.find((g) => g.key === "chotdon-ai-sales")!.steps[0].text;
  const aiFaq = HELP_FAQ.find((f) => f.q === "AI không trả lời khách?")!.a;
  for (const t of [aiGuideStep, aiFaq]) assert.ok(t.includes(`«${READINESS_STATUS_LABEL.FAIL}»`) && t.includes(`«${READINESS_STATUS_LABEL.PENDING}»`), `bài / câu hỏi gọi đúng hai nhãn của bảng: ${t}`);
  // Bảng ấy KHÁCH thấy (mọi tổ hợp dữ liệu × bốn trạng thái AI): không «ERP», không tên ứng dụng nhắn tin, không thuật ngữ cấm,
  // không đường menu vỏ không có («Hệ thống → …»); AI chưa sẵn sàng = «Đang chuẩn bị» (khách không tự cấu hình AI), hết lượt =
  // «Cần làm» + lối sang trang gói.
  const base: ReadinessInput = { botEnabled: false, aiReady: false, aiReason: null, pricedVariants: 0, sellWithoutStockCheck: false, stockReceipts: 0, notifyGroupOnHandoff: false, realConversations30d: 0, testDrafts30d: 0, replayRuns30d: 0, confirmedPriceErrors7d: 2 };
  const full: ReadinessInput = { ...base, botEnabled: true, aiReady: true, pricedVariants: 3, stockReceipts: 1, notifyGroupOnHandoff: true, realConversations30d: 4, testDrafts30d: 1, replayRuns30d: 1, confirmedPriceErrors7d: 0 };
  for (const input of [base, full, { ...base, sellWithoutStockCheck: true }]) {
    for (const state of ["ACTIVE", "NEEDS_SETUP", "PAUSED", "OUT_OF_QUOTA"] as const satisfies readonly CustomerAiState[]) {
      const checks = customerReadinessChecks(assessReadiness(input).checks, state);
      for (const c of checks) assert.ok(!/\bERP\b|Lark|Telegram|webhook|token|\bAPI\b|\bUSD\b|BYOK|Hệ thống\s*→/i.test(`${c.label} ${c.detail}`), `bảng khách thấy (${state}): ${c.key} — ${c.label} · ${c.detail}`);
      const ai = checks.find((c) => c.key === "AI_READY")!;
      if (state === "NEEDS_SETUP") {
        assert.ok(ai.status === "PENDING" && ai.href === null, `AI chưa sẵn sàng ⇒ «Đang chuẩn bị», không lối khách tự làm: ${JSON.stringify(ai)}`);
        assert.equal(readinessVerdict(checks), "NOT_READY", "đang chuẩn bị AI ⇒ vẫn CHƯA sẵn sàng (bot chưa trả lời được)");
      }
      if (state === "OUT_OF_QUOTA") assert.ok(ai.status === "FAIL" && ai.href === "/settings/plan", `hết lượt ⇒ «Cần làm» + trang gói: ${JSON.stringify(ai)}`);
      if (state === "ACTIVE" || state === "PAUSED") assert.equal(ai.status, "PASS");
    }
  }
  assert.ok(!/Cần làm|Cần cấu hình/.test(CUSTOMER_AI_STATE_LABEL.NEEDS_SETUP), "nhãn trạng thái AI của khách không giao việc cấu hình cho khách");
  // Câu AI của khách dẫn tới trang gói bằng TÊN MỤC THẬT của vỏ («Gói dịch vụ», trang vỏ mở được) — không «Hệ thống → …».
  const planNav = SALES_AGENT_NAV.find((i) => i.key === "plan")!;
  assert.ok(salesAgentPathAllowed(planNav.href) && planNav.label === "Gói dịch vụ", "mục Gói của vỏ");
  for (const t of [...Object.values(CUSTOMER_AI_STATE_HINT), CUSTOMER_AI_SOFT_LIMIT_NOTICE.title, CUSTOMER_AI_SOFT_LIMIT_NOTICE.body]) assert.ok(!/Hệ thống\s*→/.test(t), `câu AI của khách gọi đường menu vỏ không có: ${t}`);
  for (const t of [CUSTOMER_AI_STATE_HINT.OUT_OF_QUOTA, CUSTOMER_AI_SOFT_LIMIT_NOTICE.body]) assert.ok(t.includes(planNav.label), `câu hết / sắp hết lượt dẫn tới «${planNav.label}»: ${t}`);
  const aiSalesSrc = readFileSync("app/(dashboard)/ai/sales-chatbot/page.tsx", "utf8");
  assert.ok(aiSalesSrc.includes("readinessVerdict(customerChecks)"), "kết luận đầu bảng của khách tính trên ĐÚNG các dòng khách thấy");

  // 5: lối vào + thuộc lõi.
  assert.equal(moduleOfPath("/help"), "core", "/help thuộc lõi — mọi tổ chức mở được");
  assert.ok(readFileSync("components/nav-user.tsx", "utf8").includes('href="/help"'), "menu tài khoản có lối vào /help");
  assert.ok(/requireUser\(\)/.test(helpSrc), "/help chỉ cần đăng nhập");

  // 6: hạn giữ dữ liệu theo Điều khoản (SERVICE_COMMITMENTS) — «không dữ liệu nào bị xoá» là lời hứa Điều khoản không có.
  const everyText = [...HELP_GUIDES.flatMap((g) => [g.title, g.summary, ...g.steps.flatMap((s) => [s.text, s.shellText ?? ""])]), ...HELP_FAQ.flatMap((f) => [f.q, f.a])];
  assert.ok(!everyText.some((t) => /không dữ liệu nào bị xoá/i.test(t)), "không bài nào hứa «không dữ liệu nào bị xoá»");
  for (const key of ["chotdon-plan", "plan-billing"]) {
    const t = HELP_GUIDES.find((g) => g.key === key)!.steps.map((s) => s.text).join(" ");
    assert.ok(t.includes(`ít nhất ${SERVICE_COMMITMENTS.retainAfterExpiryDays} ngày`) && t.includes(`trước ${SERVICE_COMMITMENTS.deletionNoticeDays} ngày`), `${key}: hạn giữ dữ liệu đọc từ cam kết của Điều khoản — ${t}`);
  }

  console.log(
    `  ✓ hướng dẫn sử dụng: ${HELP_GUIDES.length} bài trỏ tới trang có thật, quyền khớp trang, mọi tên nút «…» có trong mã; lọc theo quyền / module / tổ chức khách; trong vỏ: ${shellTexts.length} câu không thuật ngữ cấm, không đường menu vỏ không có, link bước mở được với quyền của bài; nhãn «Cần làm» / «Đang chuẩn bị» khẳng định thẳng; hạn giữ dữ liệu theo Điều khoản; lối vào từ menu tài khoản`,
  );
}
